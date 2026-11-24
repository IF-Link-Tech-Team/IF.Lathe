import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { parsePipelineConfig, type PipelineConfig } from "./ci.ts";
import { commitStatus, createDeployment, deploymentStatus, repoFullName, upsertCheckRun, uploadSarif, type CheckAnnotation, type CheckRunBody, type GithubCredentials } from "./github.ts";
import { failureNote } from "./audit.ts";
import { hooks } from "./hooks.ts";
import type { DB } from "./util.ts";

/**
 * CI results on GitHub: every run that knows its commit is reported as a
 * commit status through the workspace's GitHub App, so PRs show them and
 * branch protection can require them, as with GitHub Actions.
 *
 * The status name is what branch protection matches. A pipeline translated
 * from a workflow is named `<repo>/<job>` and reports as `<job>`, the name
 * GitHub Actions gave the same check; `status` in the config overrides it.
 */

export function statusContext(pipelineName: string, config: PipelineConfig): string {
  if (config.status) return config.status;
  const slash = pipelineName.indexOf("/");
  return slash >= 0 ? pipelineName.slice(slash + 1) : "ci";
}

/** The App and installation, or null when there is none or its sealed key cannot be opened. */
function readApp(db: DB, workspaceId: string) {
  try {
    return hooks.githubApp(db, workspaceId);
  } catch {
    return null;
  }
}

const STATE: Record<string, { state: "pending" | "success" | "failure" | "error"; description: string }> = {
  queued: { state: "pending", description: "排队中" },
  running: { state: "pending", description: "运行中" },
  succeeded: { state: "success", description: "通过" },
  failed: { state: "failure", description: "失败" },
  cancelled: { state: "error", description: "已取消" },
};

const CONCLUSION: Record<string, CheckRunBody["conclusion"]> = { succeeded: "success", failed: "failure", cancelled: "cancelled", skipped: "skipped" };

// An installation without the Checks permission answers 403; statuses are
// used instead, and Checks is tried again after a while (an owner may grant it).
let checksForbiddenUntil = 0;

/**
 * Reports the run's current state on GitHub: a check run when the App may
 * write checks (log tail, step table and annotations on GitHub itself),
 * otherwise a commit status. A deploy pipeline's trusted runs are also GitHub
 * deployments. Best-effort: false when there is no App, the repo is not on
 * GitHub, or GitHub refuses.
 */
/**
 * `annotate: false` leaves the log annotations out: GitHub adds the
 * annotations of every update to the check run's, so a later update of a
 * completed run (the AI failure note) would repeat them.
 */
export async function reportRunStatus(db: DB, runId: string, fetchImpl: typeof fetch = fetch, options: { annotate?: boolean } = {}): Promise<boolean> {
  const run = db
    .prepare(
      `SELECT r.id, r.status, r.commit_sha, r.error, r.trigger, r.ref, r.created_at, r.finished_at, r.check_run_id, r.github_deployment_id,
              p.name, p.repo, p.config_json, pr.workspace_id
         FROM ci_runs r JOIN ci_pipelines p ON p.id = r.pipeline_id JOIN projects pr ON pr.id = r.project_id
        WHERE r.id = ?`,
    )
    .get(runId) as any;
  if (!run?.commit_sha) return false;
  const repo = repoFullName(run.repo || "");
  const mapped = STATE[run.status];
  if (!repo || !mapped) return false;
  const github = readApp(db, run.workspace_id);
  if (!github) return false;
  const config = parsePipelineConfig(JSON.parse(run.config_json)).config;
  const base = (process.env.IFLINK_CI_PUBLIC_URL ?? "").replace(/\/$/, "");
  const detailsUrl = base ? `${base}/#/pipeline?run=${run.id}` : undefined;
  const context = statusContext(run.name, config);
  if (config.environment && run.trigger !== "pull_request") await reportDeployment(db, run, config.environment, github, repo, fetchImpl);

  if (Date.now() >= checksForbiddenUntil) {
    const checked = await reportCheckRun(db, run, { github, repo, context, detailsUrl, annotate: options.annotate !== false }, fetchImpl);
    if (checked !== "forbidden") return checked;
    checksForbiddenUntil = Date.now() + 10 * 60_000;
  }
  const description = `${hooks.name} ${mapped.description}${run.status === "failed" && run.error ? `：${run.error}` : ""}`;
  return commitStatus(github.app, github.installationId, repo, run.commit_sha, mapped.state, description, fetchImpl, {
    context,
    targetUrl: detailsUrl,
  });
}

/** For tests: forget that the installation refused checks. */
export function resetChecksFallback(): void {
  checksForbiddenUntil = 0;
}

async function reportCheckRun(
  db: DB,
  run: any,
  target: { github: { app: GithubCredentials; installationId: string }; repo: string; context: string; detailsUrl?: string; annotate: boolean },
  fetchImpl: typeof fetch,
): Promise<boolean | "forbidden"> {
  const { github, repo } = target;
  // The watcher (its own process) and the API both report a run; the first
  // to claim the empty id creates the check run, the rest update it.
  let checkRunId = String(run.check_run_id ?? "");
  if (!checkRunId) {
    const claimed = db.prepare("UPDATE ci_runs SET check_run_id = 'creating' WHERE id = ? AND check_run_id = ''").run(run.id);
    if (Number(claimed.changes) === 0) return true;
  } else if (checkRunId === "creating") {
    return true;
  }
  const body = checkRunBody(db, run, target.context, target.detailsUrl, !checkRunId, target.annotate);
  const result = await upsertCheckRun(github.app, github.installationId, repo, checkRunId === "creating" ? "" : checkRunId, body, fetchImpl);
  if (!result.ok) {
    if (!checkRunId) db.prepare("UPDATE ci_runs SET check_run_id = '' WHERE id = ? AND check_run_id = 'creating'").run(run.id);
    return result.forbidden ? "forbidden" : false;
  }
  if (!checkRunId) {
    db.prepare("UPDATE ci_runs SET check_run_id = ? WHERE id = ?").run(result.id, run.id);
    // The run may have moved on while the check run was being created.
    const now = db.prepare("SELECT status FROM ci_runs WHERE id = ?").get(run.id) as { status: string } | undefined;
    if (now && now.status !== run.status) return reportRunStatus(db, run.id, fetchImpl);
  }
  return true;
}

function checkRunBody(db: DB, run: any, name: string, detailsUrl: string | undefined, create: boolean, annotate: boolean): CheckRunBody {
  const job = db.prepare("SELECT status, steps_json, error, log, started_at FROM ci_jobs WHERE run_id = ? ORDER BY created_at DESC LIMIT 1").get(run.id) as any;
  const common: CheckRunBody = {
    status: "queued",
    ...(create ? { name, head_sha: run.commit_sha, external_id: run.id } : {}),
    ...(detailsUrl ? { details_url: detailsUrl } : {}),
  };
  if (run.status === "queued") return { ...common, status: "queued", output: { title: "排队中", summary: runHeader(run) } };
  if (run.status === "running") {
    return { ...common, status: "in_progress", started_at: job?.started_at ?? run.created_at, output: { title: "运行中", summary: runHeader(run) } };
  }
  const steps: { name: string; status: string; ms?: number }[] = (() => {
    try {
      return JSON.parse(job?.steps_json || "[]");
    } catch {
      return [];
    }
  })();
  const failed = steps.find((step) => step.status === "failed");
  const conclusion = CONCLUSION[run.status] ?? "neutral";
  const title = conclusion === "success" ? "通过" : failed ? `失败：${failed.name}` : run.status === "cancelled" ? "已取消" : "失败";
  const log = stripAnsi(String(job?.log ?? ""));
  return {
    ...common,
    status: "completed",
    conclusion,
    completed_at: run.finished_at ?? new Date().toISOString(),
    output: {
      title,
      summary: [runHeader(run), stepTable(steps), run.error ? `**错误**：${run.error}` : "", conclusion === "failure" ? failureNote(db, run.id) ?? "" : ""]
        .filter(Boolean)
        .join("\n\n")
        .slice(0, 60_000),
      text: log ? "```\n" + tailChars(log, 60_000) + "\n```" : undefined,
      annotations: conclusion === "success" || !annotate ? [] : logAnnotations(log),
    },
  };
}

function runHeader(run: any): string {
  const where = run.trigger === "pull_request" ? `PR ${String(run.ref).replace(/^refs\/pull\/(\d+)\/.*$/, "#$1")}` : run.ref || "默认分支";
  return `${hooks.name} · ${run.trigger} · ${where} · \`${String(run.commit_sha).slice(0, 7)}\` · 运行 \`${run.id}\``;
}

function stepTable(steps: { name: string; status: string; ms?: number }[]): string {
  if (steps.length === 0) return "";
  const icon: Record<string, string> = { done: "✅", failed: "❌", allowed_failure: "⚠️" };
  const rows = steps.map((step) => `| ${icon[step.status] ?? "·"} | ${String(step.name).replace(/\|/g, "\\|")} | ${step.ms ? `${Math.round(step.ms / 100) / 10}s` : ""} |`);
  return ["| | 步骤 | 用时 |", "|---|---|---|", ...rows].join("\n");
}

export function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, "").replace(/\r(?!\n)/g, "\n");
}

function tailChars(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(-max);
  return `…\n${cut.slice(cut.indexOf("\n") + 1)}`;
}

/**
 * Errors and warnings a build log names with a file and line (tsc, eslint,
 * Go, Kotlin/Gradle, gcc-style), as check annotations on the repository's
 * paths. Work-directory prefixes are cut; anything that stays absolute or
 * climbs out of the tree is dropped. At most 50, as GitHub accepts per call.
 */
export function logAnnotations(log: string): CheckAnnotation[] {
  const out: CheckAnnotation[] = [];
  const seen = new Set<string>();
  const add = (rawPath: string, line: number, level: "failure" | "warning", message: string) => {
    const path = repoPath(rawPath);
    if (!path || !Number.isFinite(line) || line < 1) return;
    message = message.trim();
    const key = `${path}:${line}:${message}`;
    if (seen.has(key) || out.length >= 50) return;
    seen.add(key);
    out.push({ path, start_line: line, end_line: line, annotation_level: level, message: message.slice(0, 1000) });
  };
  let eslintFile = "";
  for (const raw of log.split("\n")) {
    const line = raw.replace(/\r$/, "");
    let m: RegExpExecArray | null;
    if ((m = /^(\S+\.(?:[cm]?[jt]sx?|vue|svelte))\((\d+),\d+\): (error|warning) (.+)$/.exec(line))) add(m[1], Number(m[2]), m[3] === "error" ? "failure" : "warning", m[4]);
    else if ((m = /^([ew]): file:\/\/(\S+?):(\d+):\d+ (.+)$/.exec(line))) add(m[2], Number(m[3]), m[1] === "e" ? "failure" : "warning", m[4]);
    else if ((m = /^(\S+\.(?:go|c|cc|cpp|h|hpp|rs|py|swift|kt|java)):(\d+):(?:\d+:)? (?:(error|warning): )?(.+)$/.exec(line))) add(m[1], Number(m[2]), m[3] === "warning" ? "warning" : "failure", m[4]);
    else if ((m = /^(\/\S+\.(?:[cm]?[jt]sx?|vue|svelte))$/.exec(line.trim()))) eslintFile = m[1];
    else if (eslintFile && (m = /^\s+(\d+):\d+\s+(error|warning)\s+(.+?)\s{2,}\S+$/.exec(line))) add(eslintFile, Number(m[1]), m[2] === "error" ? "failure" : "warning", m[3]);
    else if (!line.trim()) eslintFile = "";
  }
  return out;
}

function repoPath(raw: string): string | null {
  let path = raw.replace(/\\/g, "/");
  path = path.replace(/^.*?\/(?:home\/ci|Users\/admin|ci)\/work\//, "");
  path = path.replace(/^.*?\/job_[a-z0-9]+\/(?:src\/)?/, "");
  path = path.replace(/^[A-Za-z]:\/ci\/work\//, "").replace(/^\.\//, "");
  if (path.startsWith("/") || path.split("/").includes("..") || /^[A-Za-z]:/.test(path)) return null;
  return path || null;
}

async function reportDeployment(
  db: DB,
  run: any,
  environment: { name: string; url?: string },
  github: { app: GithubCredentials; installationId: string },
  repo: string,
  fetchImpl: typeof fetch,
): Promise<void> {
  let deploymentId = String(run.github_deployment_id ?? "");
  if (!deploymentId) {
    const claimed = db.prepare("UPDATE ci_runs SET github_deployment_id = 'creating' WHERE id = ? AND github_deployment_id = ''").run(run.id);
    if (Number(claimed.changes) === 0) return;
    const created = await createDeployment(github.app, github.installationId, repo, { commit: run.commit_sha, environment: environment.name, description: `${hooks.name} ${run.name}` }, fetchImpl);
    if (!created.ok) {
      // Without the Deployments permission: leave a marker so it is not retried every report.
      db.prepare("UPDATE ci_runs SET github_deployment_id = ? WHERE id = ?").run(/HTTP 403/.test(created.error) ? "none" : "", run.id);
      return;
    }
    deploymentId = created.id;
    db.prepare("UPDATE ci_runs SET github_deployment_id = ? WHERE id = ?").run(deploymentId, run.id);
  }
  if (deploymentId === "creating" || deploymentId === "none") return;
  const state = ({ queued: "queued", running: "in_progress", succeeded: "success", failed: "failure", cancelled: "error" } as const)[run.status as "queued"];
  if (!state) return;
  await deploymentStatus(github.app, github.installationId, repo, deploymentId, {
    state,
    description: run.status === "failed" && run.error ? String(run.error) : `${hooks.name} ${run.status}`,
    environmentUrl: run.status === "succeeded" ? environment.url : undefined,
  }, fetchImpl);
}

/** The regular files of a .tar.gz, by path (ustar, GNU long names, pax paths). */
export function tgzFiles(data: Buffer): { path: string; content: Buffer }[] {
  const tar = gunzipSync(data);
  const files: { path: string; content: Buffer }[] = [];
  const text = (from: number, len: number) => tar.subarray(from, from + len).toString("utf8").replace(/\0.*$/s, "");
  let offset = 0;
  let nextPath: string | null = null;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break;
    const size = parseInt(text(offset + 124, 12).trim() || "0", 8);
    const type = String.fromCharCode(header[156] || 48);
    const body = tar.subarray(offset + 512, offset + 512 + size);
    const prefix = text(offset + 345, 155);
    const name = nextPath ?? (prefix ? `${prefix}/${text(offset, 100)}` : text(offset, 100));
    nextPath = null;
    if (type === "L") nextPath = body.toString("utf8").replace(/\0.*$/s, "");
    else if (type === "x") nextPath = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(body.toString("utf8"))?.[1] ?? null;
    else if (type === "0" || type === "\0") files.push({ path: name, content: Buffer.from(body) });
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}

/**
 * For a succeeded run of a `code_scanning` pipeline, uploads every `.sarif`
 * file in its artifacts to the repo's code scanning (CodeQL run here instead
 * of on GitHub), at the run's commit and ref. Returns what happened per file.
 */
export async function uploadRunSarif(db: DB, runId: string, fetchImpl: typeof fetch = fetch): Promise<string[]> {
  const run = db
    .prepare(
      `SELECT r.id, r.status, r.commit_sha, r.ref, p.repo, p.config_json, pr.workspace_id
         FROM ci_runs r JOIN ci_pipelines p ON p.id = r.pipeline_id JOIN projects pr ON pr.id = r.project_id
        WHERE r.id = ?`,
    )
    .get(runId) as any;
  if (!run || run.status !== "succeeded" || !run.commit_sha) return [];
  const config = parsePipelineConfig(JSON.parse(run.config_json)).config;
  const repo = repoFullName(run.repo || "");
  if (!config.code_scanning || !repo) return [];
  const github = readApp(db, run.workspace_id);
  if (!github) return ["没有 GitHub App 安装（或读不了它的凭据），SARIF 未上传"];
  // A PR run is reported at the PR's head commit, so its analysis goes to the
  // head ref, as GitHub's own CodeQL uploads do.
  const ref = String(run.ref || "").startsWith("refs/")
    ? String(run.ref).replace(/^refs\/pull\/(\d+)\/merge$/, "refs/pull/$1/head")
    : `refs/heads/${run.ref || config.branch || "main"}`;
  const results: string[] = [];
  const artifacts = db.prepare("SELECT path FROM ci_artifacts WHERE run_id = ? AND kind = 'file'").all(runId) as { path: string }[];
  for (const artifact of artifacts) {
    let files: { path: string; content: Buffer }[];
    try {
      files = tgzFiles(readFileSync(artifact.path)).filter((f) => f.path.endsWith(".sarif"));
    } catch (err) {
      results.push(`读不了制品 ${artifact.path}：${err instanceof Error ? err.message : err}`);
      continue;
    }
    for (const file of files) {
      const uploaded = await uploadSarif(github.app, github.installationId, repo, { commit: run.commit_sha, ref, sarif: file.content }, fetchImpl);
      results.push(uploaded.ok ? `SARIF ${file.path} 已上传（${uploaded.id}）` : `SARIF ${file.path} 上传失败：${uploaded.error}`);
    }
  }
  if (results.length === 0) results.push("制品里没有 .sarif 文件");
  return results;
}
