import { createHash, randomBytes } from "node:crypto";
import { createWriteStream, mkdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
// Schedule syntax is the agents' (`every:<minutes>` / 5-field cron, UTC) so
// operators learn one format for both.
import { parseSchedule } from "./cron.ts";
import { AUDIT_SCHEMA } from "./audit.ts";
import { STATE_SCHEMA } from "./health.ts";
import { RERUN_SCHEMA } from "./rerun.ts";
import { hooks } from "./hooks.ts";
import { assert, fail, id, nowIso, type DB } from "./util.ts";

function notifyCiFinished(db: DB, runId: string, status: string) {
  try {
    const row = db.prepare("SELECT id, project_id FROM ci_runs WHERE id = ?").get(runId) as any;
    if (row) hooks.onRunFinished(db, { id: row.id, project_id: row.project_id }, status);
  } catch (err) {
    // Notifications are best-effort; a failure must never break the run report.
    console.error("[ci] notification failed", (err as Error).message);
  }
}

/**
 * Self-hosted CI/CD for the whole IF ecosystem.
 *
 * The control plane lives here and knows nothing about what a pipeline does:
 * it stores pipeline definitions (the repo's `iflink.ci.json`, or an
 * auto-detected default), queues runs, hands jobs to runners over HTTP with a
 * lease, and keeps logs, step results and artifacts. Runners are separate
 * processes on any host that can reach this API (Linux, macOS, Windows) and
 * do the actual checkout and shell work.
 *
 * Model:
 *   pipeline  a named, versioned step list for one repo        (config)
 *   run       one trigger of a pipeline (manual, push, api)    (history)
 *   job       the unit a runner claims; one per run            (queue)
 *   runner    a registered worker with labels and a heartbeat  (capacity)
 *
 * A job's lease expires unless the runner keeps heartbeating, so a dead
 * runner's job returns to the queue instead of blocking the pipeline forever.
 */

/* ------------------------------------------------------------------ */
/* Schema                                                              */
/* ------------------------------------------------------------------ */

/**
 * Columns added since a table was first created, for databases made by an
 * older version; migrateCi adds whichever are missing.
 */
export const CI_COLUMN_MIGRATIONS: [table: string, column: string, ddl: string][] = [
  ["ci_runs", "build_id", "TEXT"],
  ["ci_runs", "inputs_json", "TEXT NOT NULL DEFAULT '{}'"],
  ["ci_runs", "check_run_id", "TEXT NOT NULL DEFAULT ''"],
  ["ci_runs", "github_deployment_id", "TEXT NOT NULL DEFAULT ''"],
  ["ci_artifacts", "kind", "TEXT NOT NULL DEFAULT 'file'"],
];

/** Creates the CI tables and adds columns newer versions expect. */
export function migrateCi(db: DB): void {
  db.exec(CI_SCHEMA);
  db.exec(AUDIT_SCHEMA);
  db.exec(STATE_SCHEMA);
  db.exec(RERUN_SCHEMA);
  for (const [table, column, ddl] of CI_COLUMN_MIGRATIONS) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (cols.length > 0 && !cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  }
}

export const CI_SCHEMA = `
CREATE TABLE IF NOT EXISTS ci_pipelines (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  name TEXT NOT NULL,
  repo TEXT NOT NULL DEFAULT '',
  config_json TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'config',
  schedule TEXT NOT NULL DEFAULT '',
  last_scheduled_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (project_id, name)
);

CREATE TABLE IF NOT EXISTS ci_runs (
  id TEXT PRIMARY KEY,
  pipeline_id TEXT NOT NULL REFERENCES ci_pipelines(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  trigger TEXT NOT NULL,
  ref TEXT NOT NULL DEFAULT '',
  commit_sha TEXT NOT NULL DEFAULT '',
  build_id TEXT,
  status TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  finished_at TEXT,
  error TEXT NOT NULL DEFAULT '',
  inputs_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS ci_jobs (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES ci_runs(id),
  status TEXT NOT NULL,
  runner_id TEXT,
  lease_expires_at TEXT,
  attempt INTEGER NOT NULL DEFAULT 0,
  started_at TEXT,
  finished_at TEXT,
  error TEXT NOT NULL DEFAULT '',
  log TEXT NOT NULL DEFAULT '',
  steps_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ci_runners (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  token_hash TEXT NOT NULL,
  labels TEXT NOT NULL DEFAULT '',
  hostname TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'online',
  last_seen_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ci_artifacts (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES ci_runs(id),
  job_id TEXT NOT NULL REFERENCES ci_jobs(id),
  name TEXT NOT NULL,
  path TEXT NOT NULL,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  digest TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'file',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ci_jobs_status ON ci_jobs(status, created_at);
CREATE INDEX IF NOT EXISTS idx_ci_runs_proj ON ci_runs(project_id, created_at);
`;

/* ------------------------------------------------------------------ */
/* Pipeline config                                                     */
/* ------------------------------------------------------------------ */

export interface PipelineStep {
  name: string;
  run: string;
  /** Seconds; a step over this is killed. */
  timeout?: number;
  /** Continue only when this step succeeds (default true). */
  allow_failure?: boolean;
  /**
   * `sh` (default): `/bin/sh -c`; a multi-line step runs every line and
   * reports the last one's exit code. `bash`: `bash -e`, so the first failing
   * line fails the step, as a GitHub Actions `run:` does.
   */
  shell?: "sh" | "bash";
}

export interface VmConfig {
  /** vCPUs; the runner's default when unset. */
  cpus?: number;
  /** Memory in MiB; the runner's default when unset. */
  memory_mb?: number;
  /** Guest OS; Linux unless set. macOS needs a runner on Apple hardware. */
  os?: "linux" | "macos" | "windows";
}

export interface DockerImageConfig {
  /** Dockerfile path, relative to the workspace. */
  dockerfile: string;
  /** Image tag; the runner builds `-t <tag>`. */
  tag?: string;
  /** Registry ref to tag and push after the build. */
  push?: string;
}

export interface DeployConfig {
  /** Environment slug or kind (`production`, `staging`, …). */
  environment: string;
  /** Directory the run releases, relative to the workspace. */
  artifact?: string;
}

export interface PipelineConfig {
  /** Repo to build; defaults to the pipeline's own repo. */
  repo?: string;
  /** Branch to clone; the run's ref wins when it names a branch. */
  branch?: string;
  /** Commands run before steps (e.g. install with a private registry). */
  before?: string[];
  steps: PipelineStep[];
  /** Globs of files to keep, relative to the workspace. */
  artifacts?: string[];
  /** Env for every step; values are plain (no secret interpolation yet). */
  env?: Record<string, string>;
  /** Which runner labels are required. */
  needs?: string[];
  /** Build a docker image once the steps succeed. */
  image?: DockerImageConfig;
  /** Release to an environment when the run succeeds. */
  deploy?: DeployConfig;
  /** `every:<minutes>` or a 5-field UTC cron. */
  schedule?: string;
  /**
   * Run the job in its own throwaway VM (root, Docker, nothing shared with the
   * host but the checked-out source). Only runners labelled `vm` claim it.
   */
  vm?: VmConfig;
  /** Clone options; by default a depth-1 clone without submodules. */
  checkout?: CheckoutConfig;
  /**
   * Events that start it: `push` (its branch moved) and `pull_request` (an
   * open PR's head moved). Unset means `["push"]`; `[]` means only manual,
   * `after` or scheduled runs.
   */
  on?: PipelineEvent[];
  /**
   * Pipelines (by name, same project) that must all have succeeded at a
   * commit, outside a PR, before this one starts there. Replaces a workflow's
   * `needs:` across jobs and `workflow_run` deploys.
   */
  after?: string[];
  /** Never two jobs of this pipeline at once (a deploy's concurrency group). */
  serial?: boolean;
  /** Env names a manual run may set, e.g. a release SHA. */
  inputs?: string[];
  /** Commit status name on GitHub; by default the part of the name after `/`. */
  status?: string;
  /**
   * Upload the `.sarif` files in the run's artifacts to GitHub code scanning
   * when it succeeds (CodeQL run on this CI instead of GitHub's).
   */
  code_scanning?: boolean;
  /** A deploy: each trusted run is also a GitHub deployment to this environment. */
  environment?: { name: string; url?: string };
  /**
   * Env name → vault key in the project's vault. Resolved when a runner
   * claims a trusted run (see trustedRun) and never stored with the run.
   */
  secrets?: Record<string, string>;
}

export type PipelineEvent = "push" | "pull_request";

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
// IF.Lock's key rule.
const VAULT_KEY = /^[A-Z][A-Z0-9_]{1,63}$/;

export interface CheckoutConfig {
  /** Commits of history to fetch; 0 is the full history. */
  depth?: number;
  /** Also clone submodules (recursively). */
  submodules?: boolean;
  /**
   * `owner/name` repositories the job's own steps clone (private
   * dependencies). A trusted run gets a GitHub App token that can only read
   * these, valid an hour, and git inside the job uses it for their
   * `https://github.com/…`, `git@github.com:…` and `git@gh-<name>:…` URLs.
   */
  repos?: string[];
}

const DEFAULT_STEPS: PipelineStep[] = [
  { name: "install", run: "if [ -f package-lock.json ]; then npm ci --no-audit --no-fund; elif [ -f pnpm-lock.yaml ]; then npx --yes pnpm install --frozen-lockfile; elif [ -f package.json ]; then npm install --no-audit --no-fund; fi" },
  { name: "test", run: "if node -e \"process.exit(require('./package.json').scripts?.test ? 0 : 1)\" 2>/dev/null; then npm test; fi" },
  { name: "build", run: "if node -e \"process.exit(require('./package.json').scripts?.build ? 0 : 1)\" 2>/dev/null; then npm run build; fi" },
];

/**
 * Reads `iflink.ci.json` from a repo checkout and normalises it. Everything is
 * optional: a repo with a package.json and no config still gets install/test/
 * build steps, which is what most IF repositories need.
 */
export function parsePipelineConfig(raw: unknown): { config: PipelineConfig; source: "config" | "auto" } {
  if (!raw) return { config: { steps: DEFAULT_STEPS }, source: "auto" };
  const value = raw as any;
  const steps = Array.isArray(value.steps) ? value.steps : [];
  const parsed: PipelineStep[] = steps
    .filter((s: any) => s && typeof s.run === "string" && s.run.trim())
    .map((s: any, index: number) => ({
      name: String(s.name ?? `step-${index + 1}`),
      run: String(s.run),
      timeout: s.timeout === undefined ? undefined : Math.max(1, Number(s.timeout)),
      allow_failure: Boolean(s.allow_failure),
      ...(s.shell === "bash" ? { shell: "bash" as const } : {}),
    }));
  return {
    config: {
      repo: typeof value.repo === "string" ? value.repo : undefined,
      branch: typeof value.branch === "string" ? value.branch : undefined,
      before: Array.isArray(value.before) ? value.before.map(String) : undefined,
      steps: parsed.length > 0 ? parsed : DEFAULT_STEPS,
      artifacts: Array.isArray(value.artifacts) ? value.artifacts.map(String) : [],
      env: value.env && typeof value.env === "object" ? value.env : {},
      needs: Array.isArray(value.needs) ? value.needs.map(String) : [],
      image: parseImageConfig(value.image),
      deploy: parseDeployConfig(value.deploy),
      // An unreadable schedule is dropped, not fatal: the config is also
      // reparsed from stored rows, where a bad value must not break a run.
      schedule: typeof value.schedule === "string" && parseSchedule(value.schedule) ? value.schedule.trim() : undefined,
      vm: parseVmConfig(value.vm),
      checkout: parseCheckoutConfig(value.checkout),
      on: Array.isArray(value.on) ? [...new Set(value.on.filter((e: unknown) => e === "push" || e === "pull_request"))] as PipelineEvent[] : undefined,
      after: Array.isArray(value.after) ? value.after.map(String).filter((n: string) => n.trim()) : undefined,
      serial: value.serial === true ? true : undefined,
      inputs: Array.isArray(value.inputs) ? value.inputs.map(String).filter((n: string) => ENV_NAME.test(n)) : undefined,
      status: typeof value.status === "string" && value.status.trim() ? value.status.trim().slice(0, 100) : undefined,
      code_scanning: value.code_scanning === true ? true : undefined,
      environment:
        value.environment && typeof value.environment.name === "string" && /^[\w .-]{1,64}$/.test(value.environment.name)
          ? {
              name: value.environment.name,
              url: typeof value.environment.url === "string" && /^https:\/\//.test(value.environment.url) ? value.environment.url : undefined,
            }
          : undefined,
      secrets: parseSecretsMap(value.secrets),
    },
    source: parsed.length > 0 ? "config" : "auto",
  };
}

function parseSecretsMap(raw: any): Record<string, string> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const out: Record<string, string> = {};
  for (const [name, key] of Object.entries(raw)) {
    if (ENV_NAME.test(name) && typeof key === "string" && VAULT_KEY.test(key)) out[name] = key;
  }
  return Object.keys(out).length ? out : undefined;
}

/** The events that start a pipeline: `push` unless it says otherwise. */
export function pipelineEvents(config: PipelineConfig): PipelineEvent[] {
  if (config.after?.length) return [];
  return config.on ?? ["push"];
}

/**
 * Whether a run may receive the pipeline's secrets: never a PR run (its code
 * is whatever the PR says), and otherwise only a run of the pipeline's own
 * branch — the same line GitHub draws with environment branch policies.
 */
export function trustedRun(config: PipelineConfig, run: { trigger: string; ref: string }): boolean {
  if (run.trigger === "pull_request") return false;
  const branch = config.branch ?? "main";
  return !run.ref || run.ref === branch || run.ref === `refs/heads/${branch}`;
}

/**
 * Replaces each secret value, and each line of a multi-line value, with
 * `***`. Shorter fragments are left alone: they would match ordinary text.
 */
export function redactSecrets(text: string, values: string[]): string {
  const fragments = new Set<string>();
  for (const value of values) {
    if (value.length >= 6) fragments.add(value);
    for (const line of value.split(/\r?\n/)) if (line.trim().length >= 8) fragments.add(line.trim());
  }
  let out = text;
  // Longest first, so a whole value is replaced before its own lines are.
  for (const fragment of [...fragments].sort((a, b) => b.length - a.length)) out = out.split(fragment).join("***");
  return out;
}

function parseCheckoutConfig(raw: any): CheckoutConfig | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const out: CheckoutConfig = {};
  const depth = Number(raw.depth);
  if (raw.depth !== undefined && Number.isInteger(depth) && depth >= 0) out.depth = depth;
  if (raw.submodules === true) out.submodules = true;
  if (Array.isArray(raw.repos)) {
    const repos = [...new Set(raw.repos.map(String).filter((r: string) => /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(r)))].slice(0, 100) as string[];
    if (repos.length) out.repos = repos;
  }
  return Object.keys(out).length ? out : undefined;
}

function parseVmConfig(raw: any): VmConfig | undefined {
  if (raw === true) return {};
  if (!raw || typeof raw !== "object") return undefined;
  const bounded = (value: unknown, min: number, max: number) => {
    const n = Number(value);
    return value === undefined || !Number.isFinite(n) ? undefined : Math.min(max, Math.max(min, Math.round(n)));
  };
  const out: VmConfig = {};
  const cpus = bounded(raw.cpus, 1, 16);
  const memory = bounded(raw.memory_mb, 1024, 16384);
  if (cpus !== undefined) out.cpus = cpus;
  if (memory !== undefined) out.memory_mb = memory;
  if (raw.os === "macos" || raw.os === "windows") out.os = raw.os;
  return out;
}

function parseImageConfig(raw: any): DockerImageConfig | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const dockerfile = typeof raw.dockerfile === "string" ? raw.dockerfile.trim() : "";
  if (!dockerfile) return undefined;
  const tag = typeof raw.tag === "string" ? raw.tag.trim() : "";
  const push = typeof raw.push === "string" ? raw.push.trim() : "";
  // Dockerfile paths are relative to the workspace; an absolute path or one
  // climbing out of it would let a repo read files it was never given.
  if (dockerfile.startsWith("/") || dockerfile.split("/").includes("..")) return undefined;
  return { dockerfile, tag: tag || undefined, push: push || undefined };
}

function parseDeployConfig(raw: any): DeployConfig | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const environment = typeof raw.environment === "string" ? raw.environment.trim() : "";
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(environment)) return undefined;
  const artifact = typeof raw.artifact === "string" ? raw.artifact.trim() : "";
  return { environment, artifact: artifact || undefined };
}

/** True when `raw` is a schedule this pipeline scheduler can fire. */
export function validSchedule(raw: unknown): boolean {
  return typeof raw === "string" && (!raw.trim() || Boolean(parseSchedule(raw)));
}

/* ------------------------------------------------------------------ */
/* Pipelines                                                           */
/* ------------------------------------------------------------------ */

export function listPipelines(db: DB, projectId: string) {
  // config_json rides along so the console editor can round-trip a saved
  // pipeline instead of starting from an empty document.
  return db
    .prepare("SELECT id, name, repo, source, config_json, schedule, last_scheduled_at, updated_at, (SELECT COUNT(*) FROM ci_runs r WHERE r.pipeline_id = ci_pipelines.id) AS runs FROM ci_pipelines WHERE project_id = ? ORDER BY name")
    .all(projectId);
}

export function upsertPipeline(db: DB, projectId: string, input: { name?: string; repo?: string; config: unknown }) {
  const { config, source } = parsePipelineConfig(input.config);
  const name = (input.name ?? "default").trim() || "default";
  const repo = (input.repo ?? config.repo ?? "").trim();
  const existing = db.prepare("SELECT id, schedule FROM ci_pipelines WHERE project_id = ? AND name = ?").get(projectId, name) as any;
  const ts = nowIso();
  // The schedule lives in its own column so the minute tick reads it without
  // parsing every config; a config that names none keeps the stored one.
  const schedule = config.schedule ?? existing?.schedule ?? "";
  if (existing) {
    db.prepare("UPDATE ci_pipelines SET repo = ?, config_json = ?, source = ?, schedule = ?, updated_at = ? WHERE id = ?").run(repo, JSON.stringify(config), source, schedule, ts, existing.id);
    return { id: existing.id, name, repo, source, schedule, updated: true };
  }
  const pid = id("pipe");
  db.prepare("INSERT INTO ci_pipelines (id, project_id, name, repo, config_json, source, schedule, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    pid, projectId, name, repo, JSON.stringify(config), source, schedule, ts, ts,
  );
  return { id: pid, name, repo, source, schedule, updated: false };
}

export function pipelineConfig(db: DB, pipelineId: string): { pipeline: any; config: PipelineConfig } {
  const row = db.prepare("SELECT * FROM ci_pipelines WHERE id = ?").get(pipelineId) as any;
  if (!row) fail(404, "pipeline_not_found", "流水线不存在");
  return { pipeline: row, config: JSON.parse(row.config_json) };
}

/* ------------------------------------------------------------------ */
/* Runs and jobs                                                       */
/* ------------------------------------------------------------------ */

export function startRun(
  db: DB,
  pipelineId: string,
  input: { trigger?: string; ref?: string; commit?: string; createdBy?: string; inputs?: Record<string, unknown> } = {},
) {
  const { pipeline, config } = pipelineConfig(db, pipelineId);
  // Only the names the pipeline declares; anything else would become env.
  const declared = new Set(config.inputs ?? []);
  const inputs: Record<string, string> = {};
  for (const [name, value] of Object.entries(input.inputs ?? {})) {
    assert(declared.has(name), 400, "unknown_input", `流水线没有声明输入 ${name}`);
    assert(typeof value === "string" && value.length <= 4096, 400, "invalid_input", `输入 ${name} 需为不超过 4096 字符的字符串`);
    inputs[name] = value;
  }
  const runId = id("run");
  const jobId = id("job");
  const ts = nowIso();
  db.prepare("INSERT INTO ci_runs (id, pipeline_id, project_id, trigger, ref, commit_sha, status, created_by, created_at, inputs_json) VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)").run(
    runId, pipelineId, pipeline.project_id, input.trigger ?? "manual", input.ref ?? "", input.commit ?? "", input.createdBy ?? "", ts, JSON.stringify(inputs),
  );
  db.prepare("INSERT INTO ci_jobs (id, run_id, status, steps_json, created_at) VALUES (?, ?, 'queued', '[]', ?)").run(jobId, runId, ts);
  return { run_id: runId, job_id: jobId, status: "queued" };
}

export function listRuns(db: DB, projectId: string, limit = 50) {
  return db
    .prepare(
      `SELECT r.id, r.trigger, r.ref, r.commit_sha, r.status, r.created_by, r.created_at, r.finished_at, r.error,
              p.name AS pipeline, (SELECT runner_id FROM ci_jobs j WHERE j.run_id = r.id) AS runner_id
         FROM ci_runs r JOIN ci_pipelines p ON p.id = r.pipeline_id
        WHERE r.project_id = ? ORDER BY r.created_at DESC LIMIT ?`,
    )
    .all(projectId, limit);
}

export function runDetail(db: DB, projectId: string, runId: string) {
  const run = db.prepare("SELECT * FROM ci_runs WHERE id = ? AND project_id = ?").get(runId, projectId) as any;
  if (!run) fail(404, "run_not_found", "运行不存在");
  const job = db.prepare("SELECT id, status, runner_id, attempt, started_at, finished_at, error, steps_json, log FROM ci_jobs WHERE run_id = ?").get(runId) as any;
  const artifacts = db.prepare("SELECT id, name, size_bytes, digest, created_at FROM ci_artifacts WHERE run_id = ?").all(runId);
  // The GitHub check run and deployment ids are bookkeeping, not part of the run.
  const { inputs_json, check_run_id, github_deployment_id, ...rest } = run;
  return { ...rest, inputs: JSON.parse(inputs_json || "{}"), job: job ? { ...job, steps: JSON.parse(job.steps_json), steps_json: undefined } : null, artifacts };
}

/** The file behind an uploaded artifact of a run, for download. */
export function artifactFile(db: DB, projectId: string, runId: string, artifactId: string) {
  const row = db
    .prepare(
      `SELECT a.name, a.path, a.kind FROM ci_artifacts a JOIN ci_runs r ON r.id = a.run_id
        WHERE a.id = ? AND a.run_id = ? AND r.project_id = ?`,
    )
    .get(artifactId, runId, projectId) as { name: string; path: string; kind: string } | undefined;
  if (!row || row.kind !== "file") fail(404, "artifact_not_found", "制品不存在");
  return { path: row.path, filename: `${row.name}.tgz` };
}

export function cancelRun(db: DB, projectId: string, runId: string) {
  const run = db.prepare("SELECT status FROM ci_runs WHERE id = ? AND project_id = ?").get(runId, projectId) as any;
  if (!run) fail(404, "run_not_found", "运行不存在");
  assert(run.status === "queued" || run.status === "running", 409, "run_finished", "该运行已经结束");
  db.prepare("UPDATE ci_runs SET status = 'cancelled', finished_at = ? WHERE id = ?").run(nowIso(), runId);
  db.prepare("UPDATE ci_jobs SET status = 'cancelled', finished_at = ? WHERE run_id = ? AND status IN ('queued','running')").run(nowIso(), runId);
  return { ok: true };
}

/* ------------------------------------------------------------------ */
/* Runners                                                             */
/* ------------------------------------------------------------------ */

function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

/** Registers a runner and returns its token exactly once. */
export function registerRunner(db: DB, input: { name: string; labels?: string[]; hostname?: string }) {
  const name = input.name.trim();
  assert(/^[a-z0-9][a-z0-9-]{1,62}$/.test(name), 400, "invalid_runner_name", "Runner 名称应为小写字母、数字和连字符");
  assert(!db.prepare("SELECT 1 FROM ci_runners WHERE name = ?").get(name), 409, "runner_exists", "同名 Runner 已存在");
  const token = `cir_${randomBytes(24).toString("base64url")}`;
  const rid = id("rnr");
  db.prepare("INSERT INTO ci_runners (id, name, token_hash, labels, hostname, status, created_at) VALUES (?, ?, ?, ?, ?, 'offline', ?)").run(
    rid, name, hashToken(token), (input.labels ?? []).join(","), input.hostname ?? "", nowIso(),
  );
  return { id: rid, name, token };
}

export function listRunners(db: DB) {
  const rows = db.prepare("SELECT id, name, labels, hostname, status, last_seen_at, created_at FROM ci_runners ORDER BY name").all() as any[];
  const now = Date.now();
  return rows.map((row) => ({
    ...row,
    // A runner that has not polled for 90 seconds is offline, whatever it last said.
    status: row.last_seen_at && now - new Date(row.last_seen_at).getTime() < 90_000 ? "online" : "offline",
  }));
}

export function runnerByToken(db: DB, token: string | undefined) {
  if (!token) return null;
  return (db.prepare("SELECT * FROM ci_runners WHERE token_hash = ?").get(hashToken(token)) as any) ?? null;
}

export function revokeRunner(db: DB, runnerId: string) {
  db.prepare("UPDATE ci_runners SET status = 'revoked', token_hash = ? WHERE id = ?").run(hashToken(`revoked:${runnerId}:${Date.now()}`), runnerId);
  return { ok: true };
}

/* ------------------------------------------------------------------ */
/* Runner protocol                                                     */
/* ------------------------------------------------------------------ */

export const LEASE_SECONDS = 120;

export interface RunnerRow {
  id: string;
  name: string;
  labels: string;
  hostname: string;
}

/**
 * Claims the oldest queued job for this runner, or returns null. Expired
 * leases are returned to the queue first, so a runner crash costs at most one
 * lease period rather than a stuck pipeline.
 */
export function claimJob(db: DB, runner: { id: string; labels: string }, waitMs = 0): { job: any; config: PipelineConfig; pipeline: any } | null {
  const found = takeJob(db, runner);
  if (found || waitMs <= 0) return found;
  return null;
}

/** The runner label that keeps every job without `vm` off a runner. */
export const VM_ONLY = "vm-only";

/** The runner label a VM job needs: Linux VMs `vm`, others `vm-<os>`. */
export function vmLabel(vm: VmConfig): string {
  return !vm.os || vm.os === "linux" ? "vm" : `vm-${vm.os}`;
}

function takeJob(db: DB, runner: { id: string; labels: string }) {
  requeueExpired(db);
  const labels = new Set((runner.labels ?? "").split(",").map((s) => s.trim()).filter(Boolean));
  const jobs = db.prepare("SELECT id, run_id FROM ci_jobs WHERE status = 'queued' ORDER BY created_at LIMIT 50").all() as any[];
  for (const job of jobs) {
    const run = db.prepare("SELECT pipeline_id, project_id, trigger, commit_sha, ref, inputs_json FROM ci_runs WHERE id = ?").get(job.run_id) as any;
    if (!run) continue;
    const { pipeline, config } = pipelineConfig(db, run.pipeline_id);
    // A VM job needs a runner that can boot that kind of VM.
    const needs = [...(config.needs ?? []), ...(config.vm ? [vmLabel(config.vm)] : [])];
    if (needs.length > 0 && !needs.every((n) => labels.has(n))) continue;
    // A `vm-only` runner (one on a workstation) never runs a job on its host.
    if (!config.vm && labels.has(VM_ONLY)) continue;
    if (config.serial && db.prepare("SELECT 1 FROM ci_jobs j JOIN ci_runs r ON r.id = j.run_id WHERE r.pipeline_id = ? AND j.status = 'running'").get(run.pipeline_id)) continue;
    const lease = new Date(Date.now() + LEASE_SECONDS * 1000).toISOString();
    const changed = db
      .prepare("UPDATE ci_jobs SET status = 'running', runner_id = ?, lease_expires_at = ?, attempt = attempt + 1, started_at = ? WHERE id = ? AND status = 'queued'")
      .run(runner.id, lease, nowIso(), job.id);
    if (Number(changed.changes) === 0) continue;
    db.prepare("UPDATE ci_runs SET status = 'running' WHERE id = ?").run(job.run_id);
    const secrets = jobSecrets(db, run, config);
    if (secrets.values) secretCache.set(job.id, Object.values(secrets.values));
    return {
      job: {
        id: job.id,
        run_id: job.run_id,
        commit: run.commit_sha ?? "",
        ref: run.ref ?? "",
        trigger: run.trigger,
        lease_seconds: LEASE_SECONDS,
        inputs: JSON.parse(run.inputs_json || "{}"),
        // Values travel only in this response, to the runner that holds the job.
        secrets: secrets.values ?? {},
        missing_secrets: secrets.missing,
        secrets_withheld: secrets.withheld,
      },
      pipeline,
      config: { ...config, repo: config.repo || pipeline.repo },
    };
  }
  return null;
}

// Values handed to the runner for a running job, kept to redact its log
// writes; refilled from the vault after a restart, dropped at finish.
const secretCache = new Map<string, string[]>();

function jobSecrets(db: DB, run: { project_id: string; trigger: string; ref: string }, config: PipelineConfig) {
  const wanted = Object.entries(config.secrets ?? {});
  if (wanted.length === 0) return { values: null as Record<string, string> | null, missing: [] as string[], withheld: false };
  if (!trustedRun(config, run)) return { values: null, missing: [], withheld: true };
  const values: Record<string, string> = {};
  const missing: string[] = [];
  for (const [name, key] of wanted) {
    const value = hooks.resolveSecret(db, run.project_id, key);
    if (value === null) missing.push(key);
    else values[name] = value;
  }
  return { values, missing, withheld: false };
}

function secretsOfJob(db: DB, jobId: string): string[] {
  const cached = secretCache.get(jobId);
  if (cached) return cached;
  const run = db.prepare("SELECT r.pipeline_id, r.project_id, r.trigger, r.ref FROM ci_jobs j JOIN ci_runs r ON r.id = j.run_id WHERE j.id = ?").get(jobId) as any;
  if (!run) return [];
  const { values } = jobSecrets(db, run, pipelineConfig(db, run.pipeline_id).config);
  const list = Object.values(values ?? {});
  secretCache.set(jobId, list);
  return list;
}

/** Returns jobs whose lease expired to the queue (max two attempts). */
export function requeueExpired(db: DB) {
  const now = nowIso();
  const expired = db.prepare("SELECT id, run_id, attempt FROM ci_jobs WHERE status = 'running' AND lease_expires_at < ?").all(now) as any[];
  for (const job of expired) {
    if (Number(job.attempt) >= 2) {
      db.prepare("UPDATE ci_jobs SET status = 'failed', error = ?, finished_at = ? WHERE id = ?").run("Runner 心跳超时，任务丢失", now, job.id);
      db.prepare("UPDATE ci_runs SET status = 'failed', error = ?, finished_at = ? WHERE id = ?").run("Runner 心跳超时，任务丢失", now, job.run_id);
    } else {
      db.prepare("UPDATE ci_jobs SET status = 'queued', runner_id = NULL, lease_expires_at = NULL WHERE id = ?").run(job.id);
      db.prepare("UPDATE ci_runs SET status = 'queued' WHERE id = ?").run(job.run_id);
    }
  }
  return expired.length;
}

export function heartbeat(db: DB, runnerId: string, jobId?: string) {
  db.prepare("UPDATE ci_runners SET last_seen_at = ?, status = 'online' WHERE id = ?").run(nowIso(), runnerId);
  if (!jobId) return { ok: true };
  const job = db.prepare("SELECT status, runner_id FROM ci_jobs WHERE id = ?").get(jobId) as any;
  if (!job || job.status !== "running" || job.runner_id !== runnerId) return { ok: false, cancelled: true };
  db.prepare("UPDATE ci_jobs SET lease_expires_at = ? WHERE id = ?").run(new Date(Date.now() + LEASE_SECONDS * 1000).toISOString(), jobId);
  return { ok: true };
}

/**
 * Appends a chunk to the job log. The runner sends deltas; the stored log is
 * capped so a noisy build cannot fill the database.
 */
export function appendLog(db: DB, runnerId: string, jobId: string, chunk: string) {
  const job = db.prepare("SELECT runner_id, status, log FROM ci_jobs WHERE id = ?").get(jobId) as any;
  if (!job || job.runner_id !== runnerId || job.status !== "running") return { ok: false };
  // The runner redacts too; this catches what it could not see whole.
  const merged = `${job.log}${redactSecrets(chunk, secretsOfJob(db, jobId))}`;
  const capped = merged.length > 1_000_000 ? merged.slice(-1_000_000) : merged;
  db.prepare("UPDATE ci_jobs SET log = ? WHERE id = ?").run(capped, jobId);
  return { ok: true, truncated: capped.length < merged.length };
}

/** Largest artifact a runner may upload; image archives are hundreds of MB. */
export const ARTIFACT_MAX_BYTES = Number(process.env.IFLINK_CI_ARTIFACT_MAX_MB ?? 1024) * 1024 * 1024;

/**
 * Stores an artifact the runner uploads as raw bytes, streamed to disk (an
 * image archive does not fit a request buffer). The server owns the file
 * (under `data/ci/artifacts/<run>/`), so runners on different hosts do not
 * need a shared disk. A partial or oversized upload leaves nothing behind.
 */
export async function storeArtifact(
  db: DB,
  runnerId: string,
  jobId: string,
  input: { name: string; data: Buffer | AsyncIterable<Uint8Array>; dataDir: string; maxBytes?: number },
) {
  const job = db.prepare("SELECT runner_id, run_id FROM ci_jobs WHERE id = ?").get(jobId) as any;
  if (!job || job.runner_id !== runnerId) fail(403, "not_your_job", "该任务不属于这个 Runner");
  const max = input.maxBytes ?? ARTIFACT_MAX_BYTES;
  const safeName = input.name.replace(/[^\w.-]+/g, "_").slice(0, 120) || "artifact";
  const dir = join(input.dataDir, "ci", "artifacts", job.run_id);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${jobId}-${safeName}`);
  const partial = `${file}.part`;
  const hash = createHash("sha256");
  let size = 0;
  const out = createWriteStream(partial, { mode: 0o600 });
  try {
    for await (const chunk of Buffer.isBuffer(input.data) ? [input.data] : input.data) {
      size += chunk.length;
      assert(size <= max, 413, "artifact_too_large", `制品超过上限 ${Math.round(max / 1024 / 1024)}MB`);
      hash.update(chunk);
      if (!out.write(chunk)) await new Promise((resolve) => out.once("drain", resolve));
    }
    assert(size > 0, 400, "empty_artifact", "没有收到制品内容");
    await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())));
  } catch (err) {
    out.destroy();
    rmSync(partial, { force: true });
    throw err;
  }
  renameSync(partial, file);
  const digest = `sha256:${hash.digest("hex")}`;
  const aid = id("cia");
  db.prepare("INSERT INTO ci_artifacts (id, run_id, job_id, name, path, size_bytes, digest, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
    aid, job.run_id, jobId, input.name, file, size, digest, nowIso(),
  );
  return { id: aid, size, digest };
}

/**
 * Records an artifact the runner has already stored on the shared disk, or one
 * that never sits on disk at all (a docker image: its `path` is the image
 * reference and `size` is 0).
 */
export function recordArtifact(
  db: DB,
  runnerId: string,
  jobId: string,
  input: { name: string; path: string; size: number; digest: string; kind?: string },
) {
  const job = db.prepare("SELECT runner_id, run_id FROM ci_jobs WHERE id = ?").get(jobId) as any;
  if (!job || job.runner_id !== runnerId) fail(403, "not_your_job", "该任务不属于这个 Runner");
  const aid = id("cia");
  db.prepare("INSERT INTO ci_artifacts (id, run_id, job_id, name, path, size_bytes, digest, kind, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    aid, job.run_id, jobId, input.name, input.path, Math.max(0, Number(input.size) || 0), input.digest, input.kind || "file", nowIso(),
  );
  return { id: aid };
}

/* ------------------------------------------------------------------ */
/* Deploy on success                                                   */
/* ------------------------------------------------------------------ */

export interface DeployRequest {
  projectId: string;
  environmentId: string;
  buildId: string;
  artifactId: string;
  /** The `deployments` row finishJob already created with status `promoting`. */
  deploymentId: string;
}

export type DeployHook = (db: DB, request: DeployRequest) => Promise<{ ok: boolean; error?: string }>;

export interface FinishOptions {
  /** Overrides the host's release (see LatheHooks.deployOnSuccess); tests inject their own. */
  onDeploy?: DeployHook;
  /** Wait for the deployment before resolving; the runner route does not need to. */
  awaitDeploy?: boolean;
}

export async function finishJob(
  db: DB,
  runnerId: string,
  jobId: string,
  input: { status: "succeeded" | "failed" | "cancelled"; steps?: unknown[]; error?: string },
  options: FinishOptions = {},
) {
  const job = db.prepare("SELECT runner_id, run_id, status FROM ci_jobs WHERE id = ?").get(jobId) as any;
  if (!job) fail(404, "job_not_found", "任务不存在");
  assert(job.runner_id === runnerId, 403, "not_your_job", "该任务不属于这个 Runner");
  const ts = nowIso();
  const status = job.status === "cancelled" ? "cancelled" : input.status;
  const values = secretsOfJob(db, jobId);
  const error = redactSecrets(input.error ?? "", values);
  const stepsJson = redactSecrets(JSON.stringify(input.steps ?? []), values);
  secretCache.delete(jobId);
  db.prepare("UPDATE ci_jobs SET status = ?, steps_json = ?, error = ?, finished_at = ? WHERE id = ?").run(
    status, stepsJson, error, ts, jobId,
  );
  db.prepare("UPDATE ci_runs SET status = ?, error = ?, finished_at = ? WHERE id = ?").run(status, error, ts, job.run_id);
  const startedAfter = status === "succeeded" ? startAfterPipelines(db, job.run_id) : [];
  // A successful run with a `deploy` block releases to its environment. A
  // failed release never changes the run's own verdict: the run stays
  // succeeded and carries the reason in its error text. Deployment runs on
  // its own so the runner's finish call stays a fast, synchronous write.
  if (status === "succeeded") {
    let run: any = null;
    let config: PipelineConfig | null = null;
    try {
      run = db.prepare("SELECT id, project_id, pipeline_id, build_id FROM ci_runs WHERE id = ?").get(job.run_id);
      config = run ? (pipelineConfig(db, run.pipeline_id).config as PipelineConfig) : null;
    } catch (err) {
      run = null;
      console.error("[ci] deploy lookup failed", (err as Error).message);
    }
    if (run && config?.deploy && hooks.deployOnSuccess) {
      const task = hooks.deployOnSuccess(db, run, config, options.onDeploy)
        .then((deployed) => {
          if (!deployed.ok) db.prepare("UPDATE ci_runs SET error = ? WHERE id = ?").run(`部署失败：${deployed.error ?? "未知错误"}`, job.run_id);
        })
        .catch((err) => {
          db.prepare("UPDATE ci_runs SET error = ? WHERE id = ?").run(`部署失败：${(err as Error).message}`, job.run_id);
        });
      if (options.awaitDeploy) await task;
      else void task;
    }
  }
  // A finished CI run reaches its project audience once, from the single place
  // that owns the terminal transition.
  notifyCiFinished(db, job.run_id, status);
  return { ok: true, run_id: job.run_id, status, started_after: startedAfter };
}

/**
 * GitHub's rule: a push or PR whose head commit message carries one of these
 * runs no workflows, so it runs no pipelines here either.
 */
export function skipsCi(message: string): boolean {
  return /\[(skip ci|ci skip|no ci|skip actions|actions skip)\]/i.test(message);
}

/**
 * Records that a head was seen and deliberately not run, so the watcher does
 * not ask again and the console shows why nothing ran.
 */
export function recordSkippedRun(db: DB, pipelineId: string, input: { trigger: string; ref: string; commit: string; reason: string; createdBy?: string }) {
  const { pipeline } = pipelineConfig(db, pipelineId);
  const runId = id("run");
  const ts = nowIso();
  db.prepare("INSERT INTO ci_runs (id, pipeline_id, project_id, trigger, ref, commit_sha, status, created_by, created_at, finished_at, error) VALUES (?, ?, ?, ?, ?, ?, 'skipped', ?, ?, ?, ?)").run(
    runId, pipelineId, pipeline.project_id, input.trigger, input.ref, input.commit, input.createdBy ?? "", ts, ts, input.reason,
  );
  return { run_id: runId, status: "skipped" };
}

/**
 * Starts, at the same commit, each pipeline whose `after` names the one this
 * run belongs to, once every pipeline it names has succeeded there. PR runs
 * never count, nor do runs off the waiting pipeline's own branch, and a
 * commit starts each waiting pipeline at most once.
 */
export function startAfterPipelines(db: DB, runId: string) {
  const run = db.prepare("SELECT r.project_id, r.trigger, r.ref, r.commit_sha, p.name FROM ci_runs r JOIN ci_pipelines p ON p.id = r.pipeline_id WHERE r.id = ?").get(runId) as any;
  if (!run || !run.commit_sha || run.trigger === "pull_request") return [];
  const started: { pipeline: string; run_id: string }[] = [];
  const candidates = db.prepare("SELECT id, name, config_json FROM ci_pipelines WHERE project_id = ? AND repo != ''").all(run.project_id) as any[];
  const greenAt = db.prepare(
    `SELECT 1 FROM ci_runs r JOIN ci_pipelines p ON p.id = r.pipeline_id
      WHERE p.project_id = ? AND p.name = ? AND r.commit_sha = ? AND r.status = 'succeeded' AND r.trigger != 'pull_request' LIMIT 1`,
  );
  for (const candidate of candidates) {
    const config = parsePipelineConfig(JSON.parse(candidate.config_json)).config;
    const after = config.after ?? [];
    if (!after.includes(run.name) || !trustedRun(config, run)) continue;
    if (!after.every((name) => greenAt.get(run.project_id, name, run.commit_sha))) continue;
    if (db.prepare("SELECT 1 FROM ci_runs WHERE pipeline_id = ? AND commit_sha = ? AND trigger = 'after'").get(candidate.id, run.commit_sha)) continue;
    const startedRun = startRun(db, candidate.id, { trigger: "after", ref: run.ref, commit: run.commit_sha, createdBy: `after:${run.name}` });
    started.push({ pipeline: candidate.name, run_id: startedRun.run_id });
  }
  return started;
}

/* ------------------------------------------------------------------ */
/* Scheduled pipelines                                                 */
/* ------------------------------------------------------------------ */

/**
 * The same due test agents use: an interval fires once its window elapsed, a
 * cron fires on the UTC minute it names and no more than once a minute.
 */
function scheduleDue(row: { schedule: string; last_scheduled_at: string | null }, now: Date): boolean {
  const schedule = parseSchedule(String(row.schedule ?? ""));
  if (!schedule) return false;
  const last = row.last_scheduled_at ? new Date(row.last_scheduled_at) : null;
  if (schedule.kind === "interval") {
    return !last || now.getTime() - last.getTime() >= schedule.minutes * 60_000;
  }
  const [minute, hour, day, month, weekday] = schedule.fields;
  const matches = (field: number, value: number) => field === -1 || field === value;
  if (!matches(minute, now.getUTCMinutes()) || !matches(hour, now.getUTCHours())) return false;
  if (!matches(day, now.getUTCDate()) || !matches(month, now.getUTCMonth() + 1)) return false;
  if (!matches(weekday, now.getUTCDay())) return false;
  return !last || now.getTime() - last.getTime() >= 60_000;
}

/** Pipelines whose schedule is due at `now`, in creation order. */
export function duePipelines(db: DB, now = new Date()) {
  // A CI-only database (tests, a stripped install) may have no workspaces
  // table; the archive gate then has nothing to consult.
  const hasWorkspaces = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'workspaces'").get());
  const archiveGate = hasWorkspaces
    ? "AND NOT EXISTS (SELECT 1 FROM workspaces w WHERE w.id = pr.workspace_id AND w.archived_at IS NOT NULL)"
    : "";
  const rows = db
    .prepare(
      `SELECT p.* FROM ci_pipelines p JOIN projects pr ON pr.id = p.project_id
        WHERE p.schedule != '' AND pr.archived_at IS NULL ${archiveGate}
          AND NOT EXISTS (SELECT 1 FROM ci_runs r WHERE r.pipeline_id = p.id AND r.status IN ('queued','running'))
        ORDER BY p.created_at`,
    )
    .all() as any[];
  return rows.filter((row) => scheduleDue(row, now));
}

/**
 * Starts a run for every due pipeline. Returns the started run ids. Call it
 * from a one-minute tick, next to the agent scheduler; it is one query on an
 * idle database. `ref` overrides the branch each run checks out.
 */
export function tickPipelineSchedules(db: DB, now = new Date(), opts: { ref?: string } = {}) {
  const started: string[] = [];
  for (const pipeline of duePipelines(db, now)) {
    try {
      // Stamped before starting so a failing insert cannot fire every minute.
      db.prepare("UPDATE ci_pipelines SET last_scheduled_at = ? WHERE id = ?").run(now.toISOString(), pipeline.id);
      started.push(startRun(db, pipeline.id, { trigger: "schedule", ref: opts.ref ?? "", createdBy: "schedule" }).run_id);
    } catch (err) {
      console.error("[ci] scheduled run failed", (err as Error).message);
    }
  }
  return started;
}

/* ------------------------------------------------------------------ */
/* Ecosystem-wide views                                                */
/* ------------------------------------------------------------------ */

/** Every run across every project — the operations board. */
export function ecosystemRuns(db: DB, limit = 50) {
  return db
    .prepare(
      `SELECT r.id, r.trigger, r.ref, r.commit_sha, r.status, r.created_at, r.finished_at,
              p.name AS pipeline, pr.name AS project, pr.id AS project_id, r.error
         FROM ci_runs r
         JOIN ci_pipelines p ON p.id = r.pipeline_id
         JOIN projects pr ON pr.id = r.project_id
        ORDER BY r.created_at DESC LIMIT ?`,
    )
    .all(limit);
}
