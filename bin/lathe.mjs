#!/usr/bin/env node
/**
 * IF.Lathe command line. Everything but `serve` works on the database
 * directly, on the host the server runs on.
 *
 *   lathe serve                         control plane + watcher + scheduler
 *   lathe pipelines apply <file|dir>    register pipeline files (see src/apply.ts)
 *   lathe pipelines list
 *   lathe run <pipeline> [--ref R] [--commit SHA]
 *   lathe runs [--limit N]              latest runs
 *   lathe logs <run-id>                 a run's steps and log
 *   lathe runner add <name> [--labels linux,x64,vm]   prints the runner's token line
 *   lathe runner labels                 set the registration of the runner whose
 *                                       IFLINK_CI_TOKEN is in the environment to
 *                                       its IFLINK_CI_LABELS (scheduling uses these)
 *   lathe secret set <KEY> < value      vault value for pipelines' `secrets`
 *   lathe secret list
 *   lathe github-app set --app-id N --installation N --key app.pem
 *   lathe watch                         one watcher pass
 *
 * Environment: LATHE_DB (default ./data/lathe.db), LATHE_SECRET_KEY (vault
 * key, 16+ characters), LATHE_LISTEN (default 127.0.0.2:4311),
 * LATHE_ADMIN_TOKEN (read API), LATHE_DATA (artifacts, default next to the
 * database), plus the runner's and audit's settings in README.md.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { docAudits, pipelinesFromDoc } from "../src/apply.ts";
import { listPipelines, registerRunner, runDetail, startRun, upsertPipeline } from "../src/ci.ts";
import { setRepoAudit } from "../src/audit.ts";
import { repoFullName } from "../src/github.ts";
import { createLatheServer, startLoops } from "../src/server.ts";
import { ensureProject, listSecrets, openLathe, setGithubApp, setSecret } from "../src/standalone.ts";
import { watchOnce } from "../src/watch.ts";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const positional = args.filter((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1].startsWith("--")));
const [command, sub, third] = positional;
const dbPath = resolve(process.env.LATHE_DB ?? join(process.cwd(), "data", "lathe.db"));
const die = (message) => {
  console.error(message);
  process.exit(2);
};

const db = openLathe(dbPath);
const project = ensureProject(db, flag("--project", "default"));

async function stdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
}

function docsAt(path) {
  const full = resolve(path);
  if (statSync(full).isDirectory()) return readdirSync(full).filter((f) => f.endsWith(".json")).sort().map((f) => join(full, f));
  return [full];
}

switch (command) {
  case "serve": {
    const [host, port] = (process.env.LATHE_LISTEN ?? "127.0.0.2:4311").split(":");
    const server = createLatheServer(db, { dataDir: resolve(process.env.LATHE_DATA ?? join(dirname(dbPath), "artifacts")), adminToken: process.env.LATHE_ADMIN_TOKEN });
    server.listen(Number(port), host, () => console.log(`lathe on ${host}:${port}, database ${dbPath}`));
    const stop = startLoops(db, { dbPath, watchSeconds: Number(process.env.LATHE_WATCH_SECONDS ?? 120) });
    const quit = () => {
      stop();
      server.close(() => process.exit(0));
    };
    process.on("SIGTERM", quit);
    process.on("SIGINT", quit);
    break;
  }
  case "pipelines": {
    if (sub === "list") {
      for (const p of listPipelines(db, project.id)) console.log(`${p.name}\t${p.repo}\t${p.runs} run(s)`);
      break;
    }
    if (sub !== "apply" || !third) die("用法：lathe pipelines apply <file|dir>");
    // A repository may have several files (checks, deploys): review is on
    // when one of them turns it on and none turns it off.
    const audits = new Map();
    for (const file of docsAt(third)) {
      const doc = JSON.parse(readFileSync(file, "utf8"));
      for (const entry of pipelinesFromDoc(doc)) {
        const result = upsertPipeline(db, project.id, entry);
        console.log(`${result.updated ? "updated" : "created"} ${entry.name}`);
      }
      const repo = repoFullName(pipelinesFromDoc(doc)[0]?.repo ?? "");
      if (!repo) continue;
      const vote = doc.audit === false ? false : docAudits(doc) ? true : null;
      if (vote !== null) audits.set(repo, audits.get(repo) === false ? false : vote);
      else if (!audits.has(repo)) audits.set(repo, null);
    }
    for (const [repo, on] of audits) setRepoAudit(db, repo, project.id, on === true);
    break;
  }
  case "run": {
    if (!sub) die("用法：lathe run <pipeline> [--ref R] [--commit SHA]");
    const pipeline = db.prepare("SELECT id FROM ci_pipelines WHERE name = ?").get(sub);
    if (!pipeline) die(`没有流水线 ${sub}`);
    console.log(startRun(db, pipeline.id, { trigger: "manual", ref: flag("--ref", ""), commit: flag("--commit", ""), createdBy: "cli" }).run_id);
    break;
  }
  case "runs": {
    const rows = db.prepare(
      `SELECT r.id, p.name, r.trigger, r.status, substr(r.commit_sha, 1, 7) AS commit_sha, r.created_at FROM ci_runs r
         JOIN ci_pipelines p ON p.id = r.pipeline_id ORDER BY r.created_at DESC LIMIT ?`,
    ).all(Number(flag("--limit", "20")));
    for (const r of rows) console.log(`${r.id}\t${r.status}\t${r.name}\t${r.trigger}\t${r.commit_sha}\t${r.created_at}`);
    break;
  }
  case "logs": {
    if (!sub) die("用法：lathe logs <run-id>");
    const run = db.prepare("SELECT project_id FROM ci_runs WHERE id = ?").get(sub);
    if (!run) die(`没有运行 ${sub}`);
    const detail = runDetail(db, run.project_id, sub);
    console.log(`${detail.status}${detail.error ? `: ${detail.error}` : ""}`);
    for (const step of detail.job?.steps ?? []) console.log(`  ${step.status}\t${step.name}\t${step.ms ?? ""}ms`);
    process.stdout.write(detail.job?.log ?? "");
    break;
  }
  case "runner": {
    if (sub === "labels") {
      const token = process.env.IFLINK_CI_TOKEN;
      if (!token) die("环境里没有 IFLINK_CI_TOKEN");
      const hash = createHash("sha256").update(token).digest("hex");
      const changed = db.prepare("UPDATE ci_runners SET labels = ? WHERE token_hash = ?").run(process.env.IFLINK_CI_LABELS ?? "", hash).changes;
      if (!changed) die("没有这个 token 的 runner");
      console.log(`labels ${process.env.IFLINK_CI_LABELS ?? ""}`);
      break;
    }
    if (sub !== "add" || !third) die("用法：lathe runner add <name> [--labels linux,x64,vm] | lathe runner labels");
    const runner = registerRunner(db, { name: third, labels: String(flag("--labels", "")).split(",").filter(Boolean) });
    console.log(`IFLINK_CI_TOKEN=${runner.token}`);
    break;
  }
  case "secret": {
    if (sub === "list") {
      for (const row of listSecrets(db, project.id)) console.log(`${row.key}\t${row.updated_at}`);
      break;
    }
    if (sub !== "set" || !third) die("用法：lathe secret set <KEY> < value");
    const value = await stdin();
    if (!value) die("标准输入里没有值");
    setSecret(db, project.id, third, value);
    console.log(`stored ${third}`);
    break;
  }
  case "github-app": {
    const appId = flag("--app-id");
    const installation = flag("--installation");
    const key = flag("--key");
    if (sub !== "set" || !appId || !installation || !key) die("用法：lathe github-app set --app-id N --installation N --key app.pem");
    setGithubApp(db, project.workspace_id, { appId, installationId: installation, privateKey: readFileSync(key, "utf8") });
    console.log(`GitHub App ${appId} (installation ${installation}) stored`);
    break;
  }
  case "watch": {
    await watchOnce(db, { dryRun: args.includes("--dry-run"), cacheDir: join(dirname(dbPath), "watch-cache") });
    break;
  }
  default:
    die("用法：lathe serve | pipelines apply|list | run | runs | logs | runner add|labels | secret set|list | github-app set | watch");
}
if (command !== "serve") db.close();
