/**
 * Pull-based trigger: GitHub never has to reach the CI host. One pass:
 *
 *   push          `git ls-remote` each `push` pipeline's branch (with the same
 *                 read-only deploy keys the runner clones with) and start a run
 *                 when the head moved past the commit of its newest branch run.
 *   pull_request  with the workspace's GitHub App, list each repository's open
 *                 PRs and start the `pull_request` pipelines for every PR head
 *                 not run yet, building GitHub's test merge (refs/pull/N/merge,
 *                 or the head when there is none). Queued runs of an older head
 *                 of the same PR are cancelled; a first-time contributor's fork
 *                 waits for the `ci-approved` label.
 *
 * Every run it starts is reported to GitHub as pending right away, so a
 * required check shows up as soon as the PR moves. Run it every minute or two.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { parsePipelineConfig, pipelineEvents, recordSkippedRun, skipsCi, startRun } from "./ci.ts";
import { openPullRequests, prMayRun, repoFullName } from "./github.ts";
import { auditedRepo, auditPullRequest, type AuditTarget } from "./audit.ts";
import { hooks } from "./hooks.ts";
import { setState } from "./health.ts";
import { reportRunStatus } from "./status.ts";
import type { DB } from "./util.ts";

export interface WatchOptions {
  /** Print what would start, start nothing. */
  dryRun?: boolean;
  /** Where head commit messages are fetched (a small bare repo per repository). */
  cacheDir: string;
  log?: (line: string) => void;
  warn?: (line: string) => void;
}

export async function watchOnce(db: DB, options: WatchOptions): Promise<{ pipelines: number; started: string[] }> {
  const dryRun = options.dryRun === true;
  const log = options.log ?? ((line) => console.log(line));
  // Warnings are counted for the health report (ciHealth).
  const printWarn = options.warn ?? ((line) => console.error(line));
  let warnings = 0;
  let lastWarning = "";
  const warn = (line: string) => {
    warnings += 1;
    lastWarning = line;
    printWarn(line);
  };
  const CACHE = options.cacheDir;
  // Head commit messages, fetched once per repository and commit into a small
  // bare cache (depth 1, no checkout) with the same keys as ls-remote.
  const messages = new Map<string, string | null>();
  function headMessage(repo: string, sha: string): string | null {
    const key = `${repo}@${sha}`;
    if (messages.has(key)) return messages.get(key) ?? null;
    const dir = join(CACHE, `${createHash("sha256").update(repo).digest("hex").slice(0, 16)}.git`);
    const git = (...rest: string[]) => execFileSync("git", ["-C", dir, ...rest], { encoding: "utf8", timeout: 60_000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
    let message = null;
    try {
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
        git("init", "-q", "--bare");
      }
      git("fetch", "-q", "--depth", "1", repo, sha);
      message = git("log", "-1", "--format=%B", sha);
    } catch (err) {
      warn(`[ci-watch] ${repo}: cannot read ${sha.slice(0, 7)}: ${(err instanceof Error ? err.message : String(err)).split("\n")[0]}`);
    }
    messages.set(key, message);
    return message;
  }

  function lsRemote(repo: string, pattern: string): Map<string, string> | { error: string } {
    try {
      const out = execFileSync("git", ["ls-remote", repo, pattern], {
        encoding: "utf8",
        timeout: 30_000,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      }).trim();
      const refs = new Map<string, string>();
      for (const line of out.split("\n").filter(Boolean)) {
        const [sha, ref] = line.split(/\s+/);
        refs.set(ref, sha);
      }
      return refs;
    } catch (err) {
      return { error: (err instanceof Error ? err.message : String(err)).split("\n")[0] };
    }
  }

  const pipelines = db
    .prepare(
      `SELECT p.id, p.name, p.repo, p.config_json, pr.workspace_id FROM ci_pipelines p
        JOIN projects pr ON pr.id = p.project_id
       WHERE p.repo != '' AND pr.archived_at IS NULL`,
    )
    .all()
    .map((p: any) => ({ ...p, config: parsePipelineConfig(JSON.parse(p.config_json || "{}")).config }));

  const startedRuns: string[] = [];
  function start(pipeline: any, input: { trigger: string; ref: string; commit: string }, label: string) {
    const message = headMessage(pipeline.repo, input.commit);
    if (message === null) return;
    if (skipsCi(message)) {
      if (dryRun) log(`[ci-watch] would skip ${pipeline.name} ${label} ([skip ci])`);
      else recordSkippedRun(db, pipeline.id, { ...input, reason: "提交信息要求跳过 CI（[skip ci]）", createdBy: "ci-watch" });
      return;
    }
    if (dryRun) {
      log(`[ci-watch] would start ${pipeline.name} ${label}`);
      return;
    }
    const run = startRun(db, pipeline.id, { ...input, createdBy: "ci-watch" });
    log(`[ci-watch] started ${pipeline.name} ${label} → ${run.run_id}`);
    startedRuns.push(run.run_id);
  }

  /* push --------------------------------------------------------------------- */

  // Several pipelines share a repository: ask GitHub once per pass for each.
  const heads = new Map<string, Map<string, string> | { error: string }>();
  for (const pipeline of pipelines.filter((p) => pipelineEvents(p.config).includes("push"))) {
    const branch = pipeline.config.branch ?? "main";
    const key = `${pipeline.repo}#${branch}`;
    if (!heads.has(key)) heads.set(key, lsRemote(pipeline.repo, `refs/heads/${branch}`));
    const refs = heads.get(key)!;
    if ("error" in refs) {
      warn(`[ci-watch] ${pipeline.name}: ${refs.error}`);
      continue;
    }
    const head = (refs as Map<string, string>).get(`refs/heads/${branch}`);
    if (!head) continue;
    // A run without a commit (a manual run of "whatever main is") says nothing
    // about which head was built, and a PR run, or a manual run of some other
    // ref, built something else.
    const latest = db
      .prepare(
        "SELECT commit_sha FROM ci_runs WHERE pipeline_id = ? AND commit_sha != '' AND trigger != 'pull_request' AND ref IN ('', ?, ?) ORDER BY created_at DESC LIMIT 1",
      )
      .get(pipeline.id, branch, `refs/heads/${branch}`) as { commit_sha: string } | undefined;
    if (latest?.commit_sha === head) continue;
    start(pipeline, { trigger: "push", ref: branch, commit: head }, `@ ${head.slice(0, 7)} (${branch})`);
  }

  /* pull_request --------------------------------------------------------------- */

  const audits: AuditTarget[] = [];
  const byRepo = new Map<string, any[]>();
  for (const pipeline of pipelines.filter((p) => pipelineEvents(p.config).includes("pull_request"))) {
    const list = byRepo.get(pipeline.repo) ?? [];
    list.push(pipeline);
    byRepo.set(pipeline.repo, list);
  }
  for (const [repo, group] of byRepo) {
    const fullName = repoFullName(repo);
    let pulls;
    // One repository's failure (GitHub refusing, credentials unreadable) must
    // not stop the others, nor the status reports below.
    try {
      const github = hooks.githubApp(db, group[0].workspace_id);
      if (!fullName || !github) {
        warn(`[ci-watch] ${fullName ?? repo}: no GitHub App installation, PR checks skipped`);
        continue;
      }
      pulls = await openPullRequests(github.app, github.installationId, fullName);
    } catch (err) {
      warn(`[ci-watch] ${fullName ?? repo}: ${err instanceof Error ? err.message : err}`);
      continue;
    }
    if (pulls.length === 0) continue;
    const listed = lsRemote(repo, "refs/pull/*");
    if ("error" in listed) {
      warn(`[ci-watch] ${fullName}: ${listed.error}`);
      continue;
    }
    const prRefs = listed as Map<string, string>;
    const audited = auditedRepo(db, fullName);
    for (const pr of pulls) {
      if (!prMayRun(pr)) {
        log(`[ci-watch] ${fullName}#${pr.number}: first-time contributor's fork, waiting for the ci-approved label`);
        continue;
      }
      if (audited) audits.push({ repo: fullName, pr: pr.number, head: pr.head, workspaceId: group[0].workspace_id });
      // GitHub drops the test merge while a PR conflicts; build its head then.
      const ref = prRefs.has(`refs/pull/${pr.number}/merge`) ? `refs/pull/${pr.number}/merge` : `refs/pull/${pr.number}/head`;
      for (const pipeline of group) {
        const prefix = `refs/pull/${pr.number}/%`;
        const seen = db
          .prepare("SELECT 1 FROM ci_runs WHERE pipeline_id = ? AND trigger = 'pull_request' AND ref LIKE ? AND commit_sha = ?")
          .get(pipeline.id, prefix, pr.head);
        if (seen) continue;
        if (!dryRun) {
          const stale = db
            .prepare("SELECT r.id FROM ci_runs r WHERE r.pipeline_id = ? AND r.trigger = 'pull_request' AND r.ref LIKE ? AND r.status = 'queued'")
            .all(pipeline.id, prefix) as { id: string }[];
          for (const old of stale) {
            db.prepare("UPDATE ci_runs SET status = 'cancelled', finished_at = ?, error = ? WHERE id = ?").run(new Date().toISOString(), "PR 有了新提交", old.id);
            db.prepare("UPDATE ci_jobs SET status = 'cancelled', finished_at = ? WHERE run_id = ? AND status = 'queued'").run(new Date().toISOString(), old.id);
          }
        }
        start(pipeline, { trigger: "pull_request", ref, commit: pr.head }, `#${pr.number} @ ${pr.head.slice(0, 7)}`);
      }
    }
  }

  for (const runId of startedRuns) {
    try {
      await reportRunStatus(db, runId);
    } catch (err) {
      warn(`[ci-watch] status for ${runId}: ${err instanceof Error ? err.message : err}`);
    }
  }
  // LLM reviews last: a pass must not delay starting runs. A few per pass;
  // the rest wait for the next one (each head is reviewed once).
  let reviewed = 0;
  if (!dryRun) {
    for (const target of audits) {
      if (reviewed >= Number(process.env.LATHE_AUDITS_PER_PASS || 4)) break;
      try {
        const outcome = await auditPullRequest(db, target);
        if (outcome !== "already reviewed" && outcome !== "auditing off") {
          reviewed += 1;
          log(`[ci-watch] AI review ${target.repo}#${target.pr} @ ${target.head.slice(0, 7)}: ${outcome}`);
        }
      } catch (err) {
        warn(`[ci-watch] AI review ${target.repo}#${target.pr}: ${err instanceof Error ? err.message : err}`);
      }
    }
  }
  log(`[ci-watch] ${pipelines.length} pipeline(s), ${startedRuns.length} run(s) started`);
  if (!dryRun) {
    setState(db, "watch_last_pass", `${pipelines.length} pipeline(s), ${startedRuns.length} run(s) started, ${warnings} warning(s)`);
    if (lastWarning) setState(db, "watch_last_warning", lastWarning.slice(0, 500));
  }
  return { pipelines: pipelines.length, started: startedRuns };
}
