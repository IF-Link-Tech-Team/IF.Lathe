import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { docAudits, pipelinesFromDoc } from "../src/apply.ts";
// @ts-expect-error plain JavaScript module without types
import { gitCredentialEnv } from "../runner/vm.mjs";
import { claimJob, registerRunner, runDetail, startRun, upsertPipeline } from "../src/ci.ts";
import { parseSchedule } from "../src/cron.ts";
import { hooks } from "../src/hooks.ts";
import { claimAndReport } from "../src/protocol.ts";
import { ciHealth, setState } from "../src/health.ts";
import { handleReruns, parseRerun } from "../src/rerun.ts";
import { createLatheServer } from "../src/server.ts";
import { ensureProject, listSecrets, openLathe, resolveSecret, seal, setGithubApp, setSecret, unseal } from "../src/standalone.ts";

/**
 * Lathe on its own: its database, vault and GitHub App storage, the runner
 * protocol server, the real runner (ci runner.mjs) running a pipeline from a
 * local git repository with a vault secret, and the command line.
 */

const root = mkdtempSync(join(tmpdir(), "lathe-standalone-"));
const dbPath = join(root, "data", "lathe.db");
const lathe = join(import.meta.dirname, "..");
let db: DatabaseSync;
let server: Server;
let base = "";
let runnerProc: ChildProcess | null = null;
let origin = "";
const SECRET = "s3cr3t-standalone-value";

before(async () => {
  process.env.LATHE_SECRET_KEY = "test-secret-key-for-lathe";
  origin = join(root, "repo");
  mkdirSync(origin);
  writeFileSync(join(origin, "hello.txt"), "hello from the repo\n");
  const git = (...a: string[]) =>
    execFileSync("git", a, { cwd: origin, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  git("init", "-q", "-b", "main");
  git("add", ".");
  git("commit", "-q", "-m", "one");
  db = openLathe(dbPath);
  server = createLatheServer(db, { dataDir: join(root, "artifacts"), adminToken: "admin-token" });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(async () => {
  runnerProc?.kill();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.close();
  rmSync(root, { recursive: true, force: true });
});

test("vault: sealed at rest in the kernel's iv:data:tag format, read back by key", () => {
  const project = ensureProject(db);
  const sealed = seal("x");
  assert.match(sealed, /^[0-9a-f]{24}:[0-9a-f]+:[0-9a-f]{32}$/);
  assert.equal(unseal(sealed), "x");
  setSecret(db, project.id, "APP__TOKEN", SECRET);
  assert.equal(resolveSecret(db, project.id, "APP__TOKEN"), SECRET);
  assert.deepEqual(listSecrets(db, project.id).map((s) => s.key), ["APP__TOKEN"]);
  assert.ok(!JSON.stringify(db.prepare("SELECT * FROM lathe_secrets").all()).includes(SECRET));
  assert.throws(() => setSecret(db, project.id, "lower", "v"), /大写字母/);
});

test("GitHub App: stored sealed, handed to the engine through the githubApp hook", () => {
  const project = ensureProject(db);
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  setGithubApp(db, project.workspace_id, { appId: "42", installationId: "7", privateKey: pem });
  assert.ok(!JSON.stringify(db.prepare("SELECT * FROM lathe_github").all()).includes("PRIVATE KEY"));
  assert.deepEqual(hooks.githubApp(db, project.workspace_id), { app: { app_id: "42", private_key: pem }, installationId: "7" });
  assert.throws(() => setGithubApp(db, project.workspace_id, { appId: "x", installationId: "7", privateKey: pem }), /App ID/);
});

test("pipeline files: clone URL, dormant files run only by hand, review follows PR checks", () => {
  const doc = { repo: "owner/name", branch: "main", dormant: true, pipelines: [{ name: "name/deploy", on: ["push"], after: ["name/check"], steps: [{ run: "x" }] }] };
  const [entry] = pipelinesFromDoc(doc);
  assert.equal(entry.repo, "https://github.com/owner/name.git");
  assert.deepEqual(entry.config.on, []);
  assert.equal(entry.config.after, undefined);
  assert.equal(docAudits({ repo: "o/r", pipelines: [{ on: ["push", "pull_request"] }] }), true);
  assert.equal(docAudits({ repo: "o/r", audit: false, pipelines: [{ on: ["pull_request"] }] }), false);
  assert.deepEqual(parseSchedule("17 3 * * 1"), { kind: "cron", fields: [17, 3, -1, -1, 1] });
});

test("a runner runs a pipeline end to end with a vault secret, redacted in its log", async () => {
  const project = ensureProject(db);
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: origin, encoding: "utf8" }).trim();
  const pipeline = upsertPipeline(db, project.id, {
    name: "repo/check",
    repo: origin,
    config: { branch: "main", secrets: { TOKEN: "APP__TOKEN" }, steps: [{ name: "read", run: 'cat hello.txt && echo "token=$TOKEN"' }] },
  });
  const runner = registerRunner(db, { name: "local", labels: [] });
  runnerProc = spawn(process.execPath, [join(lathe, "runner", "runner.mjs")], {
    env: { PATH: process.env.PATH, HOME: root, IFLINK_CI_URL: base, IFLINK_CI_TOKEN: runner.token, IFLINK_CI_WORK: join(root, "work"), IFLINK_CI_POLL_MS: "200" },
    stdio: "ignore",
  });
  const run = startRun(db, pipeline.id, { trigger: "manual", ref: "main", commit: head });
  let detail: any;
  for (let i = 0; i < 150; i++) {
    detail = runDetail(db, project.id, run.run_id);
    if (detail.status === "succeeded" || detail.status === "failed") break;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  assert.equal(detail.status, "succeeded", JSON.stringify(detail.job));
  assert.match(detail.job.log, /hello from the repo/);
  assert.match(detail.job.log, /token=\*\*\*/);
  assert.ok(!detail.job.log.includes(SECRET));

  const anonymous = await fetch(`${base}/api/v1/runs`);
  assert.equal(anonymous.status, 401);
  const listed = (await fetch(`${base}/api/v1/runs`, { headers: { authorization: "Bearer admin-token" } }).then((r) => r.json())) as any;
  assert.equal(listed.runs[0].id, run.run_id);
  const fake = await fetch(`${base}/api/v1/ci/claim`, { method: "POST", headers: { authorization: "Bearer nope" } });
  assert.equal(fake.status, 401);
});

test("command line: runner tokens, secrets from stdin, runs and logs", () => {
  const cli = (args: string[], input?: string) =>
    spawnSync(process.execPath, [join(lathe, "bin", "lathe.mjs"), ...args], { encoding: "utf8", input, env: { ...process.env, LATHE_DB: dbPath } });
  const added = cli(["runner", "add", "cli-runner", "--labels", "linux,vm"]);
  assert.equal(added.status, 0, added.stderr);
  assert.match(added.stdout, /^IFLINK_CI_TOKEN=cir_/);
  const token = added.stdout.trim().split("=")[1];
  const relabeled = spawnSync(process.execPath, [join(lathe, "bin", "lathe.mjs"), "runner", "labels"], {
    encoding: "utf8", env: { ...process.env, LATHE_DB: dbPath, IFLINK_CI_TOKEN: token, IFLINK_CI_LABELS: "linux,vm,vm-windows" },
  });
  assert.equal(relabeled.status, 0, relabeled.stderr);
  assert.equal((db.prepare("SELECT labels FROM ci_runners WHERE name = 'cli-runner'").get() as any).labels, "linux,vm,vm-windows");
  const stored = cli(["secret", "set", "APP__OTHER"], "value-from-stdin\n");
  assert.equal(stored.status, 0, stored.stderr);
  assert.match(cli(["secret", "list"]).stdout, /APP__OTHER/);
  const runs = cli(["runs"]);
  assert.match(runs.stdout, /succeeded\trepo\/check\tmanual/);
  const id = runs.stdout.split("\t")[0];
  assert.match(cli(["logs", id]).stdout, /hello from the repo/);
});

test("a vm-only runner gets VM jobs and never a job for its host", async () => {
  // The end-to-end runner (no labels) would take the host job itself.
  if (runnerProc) {
    const proc = runnerProc;
    runnerProc = null;
    await new Promise((resolve) => {
      proc.once("exit", resolve);
      proc.kill();
    });
  }
  const project = ensureProject(db);
  const host = upsertPipeline(db, project.id, { name: "repo/host", repo: origin, config: { steps: [{ run: "true" }] } });
  const mac = upsertPipeline(db, project.id, { name: "repo/mac", repo: origin, config: { vm: { os: "macos" }, steps: [{ run: "true" }] } });
  const hostRun = startRun(db, host.id, { trigger: "manual" });
  const macRun = startRun(db, mac.id, { trigger: "manual" });
  const runner = { id: registerRunner(db, { name: "mac", labels: ["vm-macos", "vm-only"] }).id, labels: "vm-macos,vm-only" };
  const claimed = claimJob(db, runner);
  assert.equal(claimed?.job.run_id, macRun.run_id);
  assert.equal(claimJob(db, runner), null);
  assert.equal(runDetail(db, project.id, hostRun.run_id).status, "queued");
  db.prepare("UPDATE ci_jobs SET status = 'cancelled' WHERE run_id = ?").run(hostRun.run_id);
});

test("checkout.repos: a trusted run gets a token that reads only those repositories; a PR run gets none", async () => {
  const project = ensureProject(db);
  const pipeline = upsertPipeline(db, project.id, {
    name: "repo/deps",
    repo: origin,
    config: { branch: "main", checkout: { repos: ["acme/dep-one", "acme/dep-two", "not a repo"] }, steps: [{ run: "true" }] },
  });
  const requests: any[] = [];
  const fakeGithub = (async (url: string, init: any = {}) => {
    requests.push({ url, body: init.body ? JSON.parse(init.body) : null });
    return Response.json({ token: "ghs_scoped_token", expires_at: new Date(Date.now() + 3_600_000).toISOString() }, { status: 201 });
  }) as typeof fetch;
  const runner = { id: registerRunner(db, { name: "deps", labels: [] }).id, labels: "" };

  startRun(db, pipeline.id, { trigger: "manual", ref: "main" });
  const trusted: any = await claimAndReport(db, runner, fakeGithub);
  assert.equal(trusted.job.git_token, "ghs_scoped_token");
  assert.deepEqual(trusted.job.git_repos, ["acme/dep-one", "acme/dep-two"]);
  const tokenRequest = requests.find((r) => r.url.endsWith("/installations/7/access_tokens"));
  assert.deepEqual(tokenRequest.body, { repositories: ["dep-one", "dep-two"], permissions: { contents: "read" } });

  startRun(db, pipeline.id, { trigger: "pull_request", ref: "refs/pull/3/merge" });
  const untrusted: any = await claimAndReport(db, runner, fakeGithub);
  assert.equal(untrusted.job.git_token, undefined);
  assert.match(untrusted.job.git_token_error, /不可信/);
  db.prepare("UPDATE ci_jobs SET status = 'cancelled' WHERE status = 'running'").run();

  const env = gitCredentialEnv("ghs_scoped_token", ["acme/dep-one"]);
  assert.equal(env.GIT_CONFIG_COUNT, "4");
  const rules = Array.from({ length: 4 }, (_, i) => [env[`GIT_CONFIG_KEY_${i}`], env[`GIT_CONFIG_VALUE_${i}`]]);
  assert.ok(rules.every(([key]) => key === "url.https://x-access-token:ghs_scoped_token@github.com/acme/dep-one.insteadOf"));
  assert.deepEqual(rules.map(([, v]) => v), ["https://github.com/acme/dep-one", "git@github.com:acme/dep-one", "ssh://git@github.com/acme/dep-one", "git@gh-dep-one:acme/dep-one"]);
  assert.deepEqual(gitCredentialEnv("", ["acme/dep-one"]), {});
});

test("health: a stale watcher, a silent runner and an old queued job fail; a sleeping workstation only warns", () => {
  const project = ensureProject(db);
  const now = new Date("2030-01-01T12:00:00Z");
  db.prepare("UPDATE ci_runners SET status = 'revoked'").run();
  db.prepare("UPDATE ci_jobs SET status = 'cancelled' WHERE status IN ('queued', 'running')").run();
  registerRunner(db, { name: "build", labels: ["vm"] });
  registerRunner(db, { name: "laptop", labels: ["vm-macos"] });
  db.prepare("UPDATE ci_runners SET last_seen_at = ? WHERE name = 'build'").run("2030-01-01T11:59:40Z");
  db.prepare("UPDATE ci_runners SET last_seen_at = ? WHERE name = 'laptop'").run("2030-01-01T09:00:00Z");
  setState(db, "watch_last_pass", "3 pipeline(s), 0 run(s) started, 0 warning(s)");
  db.prepare("UPDATE lathe_state SET updated_at = ? WHERE key = 'watch_last_pass'").run("2030-01-01T11:58:00Z");
  const quiet = upsertPipeline(db, project.id, { name: "repo/health", repo: origin, config: { steps: [{ run: "true" }] } });

  const healthy = ciHealth(db, { dataDir: root, optionalRunners: ["laptop"], minFreeBytes: 1, now });
  const by = (r: any, name: string) => r.checks.find((c: any) => c.name === name);
  assert.equal(by(healthy, "ci.watcher").ok, true);
  assert.equal(by(healthy, "ci.runner.build").ok, true);
  assert.deepEqual([by(healthy, "ci.runner.laptop").ok, by(healthy, "ci.runner.laptop").severity], [true, "warning"]);
  assert.match(by(healthy, "ci.runner.laptop").detail, /offline, optional/);
  assert.equal(by(healthy, "ci.queue").ok, true);
  assert.equal(by(healthy, "ci.disk").ok, true);

  db.prepare("UPDATE lathe_state SET updated_at = ? WHERE key = 'watch_last_pass'").run("2030-01-01T11:30:00Z");
  setState(db, "watch_warning_streak", "3");
  startRun(db, quiet.id, { trigger: "manual" });
  db.prepare("UPDATE ci_jobs SET created_at = ? WHERE status = 'queued'").run("2030-01-01T10:00:00Z");
  const broken = ciHealth(db, { dataDir: root, minFreeBytes: Number.MAX_SAFE_INTEGER, offsiteMarker: join(root, "missing"), now });
  assert.equal(broken.ok, false);
  assert.deepEqual(
    broken.checks.filter((c: any) => !c.ok).map((c: any) => `${c.name}:${c.severity}`).sort(),
    ["ci.disk:critical", "ci.offsite_backup:critical", "ci.queue:warning", "ci.runner.laptop:critical", "ci.watcher.warnings:warning", "ci.watcher:critical"],
  );
  db.prepare("UPDATE ci_jobs SET status = 'cancelled' WHERE status = 'queued'").run();
});

test("/rerun: maintainers and the PR author rerun checks once per comment; everyone else gets a neutral note", async () => {
  assert.equal(parseRerun("/rerun"), null);
  assert.deepEqual(parseRerun("  /rerun check, ios\nthanks"), ["check", "ios"]);
  assert.equal(parseRerun("/RERUN all"), null);
  assert.equal(parseRerun("please /rerun"), undefined);
  assert.equal(parseRerun("/rerunning"), undefined);

  const project = ensureProject(db);
  const app = hooks.githubApp(db, project.workspace_id)!;
  const head = "a".repeat(40);
  const pulls = [
    { number: 5, head, fork: false, association: "CONTRIBUTOR", labels: [], author: "alice" },
    { number: 6, head: "b".repeat(40), fork: true, association: "FIRST_TIME_CONTRIBUTOR", labels: [], author: "newbie" },
  ];
  let comments: any[] = [];
  const checkRuns: any[] = [];
  const fakeGithub = (async (url: string, init: any = {}) => {
    if (url.endsWith("/access_tokens")) return Response.json({ token: "ghs_rerun", expires_at: new Date(Date.now() + 3_600_000).toISOString() }, { status: 201 });
    if (url.includes("/issues/comments")) return Response.json(comments);
    if (url.includes("/check-runs")) {
      checkRuns.push(JSON.parse(init.body));
      return Response.json({ id: 1 }, { status: 201 });
    }
    return Response.json({ message: "unexpected " + url }, { status: 404 });
  }) as typeof fetch;
  const started: { pr: number; names: string[] | null; by: string }[] = [];
  const target = {
    github: app,
    repo: "acme/app",
    pulls,
    checks: ["check", "ios"],
    fetchImpl: fakeGithub,
    start: (pr: any, names: string[] | null, by: string) => {
      started.push({ pr: pr.number, names, by });
      return names ?? ["check", "ios"];
    },
  };
  const comment = (id: number, login: string, association: string, issue: number, body: string, type = "User") => ({
    id, body, author_association: association, user: { login, type }, issue_url: `https://api.github.com/repos/acme/app/issues/${issue}`,
    html_url: `https://github.com/acme/app/pull/${issue}#issuecomment-${id}`, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  });

  // The first pass only sets the starting point.
  comments = [comment(1, "owner", "OWNER", 5, "/rerun")];
  assert.deepEqual(await handleReruns(db, target), []);
  assert.equal(started.length, 0);

  comments = [
    comment(1, "owner", "OWNER", 5, "/rerun"),
    comment(2, "alice", "CONTRIBUTOR", 5, "/rerun ios"),
    comment(3, "mallory", "NONE", 5, "/rerun"),
    comment(4, "owner", "MEMBER", 5, "/rerun nope"),
    comment(5, "owner", "OWNER", 99, "/rerun"),
    comment(6, "dependabot[bot]", "NONE", 5, "/rerun", "Bot"),
    comment(7, "owner", "OWNER", 6, "/rerun"),
    comment(8, "owner", "OWNER", 5, "LGTM"),
  ];
  const outcomes = await handleReruns(db, target);
  assert.deepEqual(started, [{ pr: 5, names: null, by: "owner" }, { pr: 5, names: ["ios"], by: "alice" }]);
  assert.deepEqual(outcomes.map((o) => o.comment), ["1", "2", "3", "4", "7"]);
  assert.match(outcomes[2].outcome, /mallory 不是仓库成员/);
  assert.match(outcomes[3].outcome, /没有这些检查：nope/);
  assert.match(outcomes[4].outcome, /ci-approved/);
  assert.deepEqual(checkRuns.map((c) => [c.name, c.conclusion, c.head_sha.slice(0, 1)]), [["rerun", "neutral", "a"], ["rerun", "neutral", "a"], ["rerun", "neutral", "b"]]);

  // The same comments again: nothing is done twice.
  assert.deepEqual(await handleReruns(db, target), []);
  assert.equal(started.length, 2);
});
