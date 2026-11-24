/**
 * What every host does around the runner protocol's state changes, so the
 * standalone server and an embedding host (IF.Platform) behave the same:
 * GitHub hears each change, a failed check gets its AI reading, CodeQL
 * results are uploaded.
 */
import { explainFailure } from "./audit.ts";
import { claimJob, finishJob, trustedRun } from "./ci.ts";
import { scopedReadToken } from "./github.ts";
import { hooks } from "./hooks.ts";
import { reportRunStatus, uploadRunSarif } from "./status.ts";
import type { DB } from "./util.ts";

const quietly = (task: Promise<unknown>) => void task.catch(() => {});

/**
 * The read-only token for a job's `checkout.repos`: only for trusted runs
 * (like secrets), only for repositories of the App installation's account.
 */
async function cloneToken(db: DB, claimed: NonNullable<ReturnType<typeof claimJob>>, fetchImpl: typeof fetch) {
  const repos = claimed.config.checkout?.repos ?? [];
  if (repos.length === 0) return {};
  const run = db.prepare("SELECT r.trigger, r.ref, p.workspace_id FROM ci_runs r JOIN projects p ON p.id = r.project_id WHERE r.id = ?").get(claimed.job.run_id) as any;
  if (!run || !trustedRun(claimed.config, run)) return { git_token_error: "这次运行不可信（PR 或非默认分支），不提供克隆令牌" };
  let github;
  try {
    github = hooks.githubApp(db, run.workspace_id);
  } catch {
    github = null;
  }
  if (!github) return { git_token_error: "没有 GitHub App，无法签发克隆令牌" };
  const owners = new Set(repos.map((r) => r.split("/")[0]));
  if (owners.size !== 1) return { git_token_error: "checkout.repos 只能是同一个账号下的仓库" };
  try {
    const token = await scopedReadToken(github.app, github.installationId, repos.map((r) => r.split("/")[1]), fetchImpl);
    return { git_token: token, git_repos: repos };
  } catch (err) {
    return { git_token_error: err instanceof Error ? err.message : String(err) };
  }
}

/** Claims the next job this runner may take and reports its run as in progress. */
export async function claimAndReport(db: DB, runner: { id: string; labels: string }, fetchImpl: typeof fetch = fetch) {
  const claimed = claimJob(db, runner);
  if (!claimed) return { job: null };
  quietly(reportRunStatus(db, claimed.job.run_id));
  Object.assign(claimed.job, await cloneToken(db, claimed, fetchImpl));
  return claimed;
}

export function finishBody(body: any) {
  return {
    status: body?.status === "succeeded" ? ("succeeded" as const) : body?.status === "cancelled" ? ("cancelled" as const) : ("failed" as const),
    steps: Array.isArray(body?.steps) ? body.steps : [],
    error: body?.error ? String(body.error) : undefined,
  };
}

/** Records a job's verdict, then tells GitHub and runs the follow-ups. */
export async function finishAndReport(db: DB, runnerId: string, jobId: string, body: any) {
  const result = await finishJob(db, runnerId, jobId, finishBody(body));
  // GitHub hears the verdict, and the queued state of any run it started.
  quietly(reportRunStatus(db, result.run_id));
  for (const started of result.started_after) quietly(reportRunStatus(db, started.run_id));
  // A failed check in an audited repo gets an AI reading of its log.
  if (result.status === "failed") quietly(explainFailure(db, result.run_id));
  // CodeQL results go to code scanning; the outcome is added to the job's log.
  quietly(
    uploadRunSarif(db, result.run_id).then((lines) => {
      if (lines.length) db.prepare("UPDATE ci_jobs SET log = log || ? WHERE id = ?").run(`\n${lines.join("\n")}\n`, jobId);
    }),
  );
  return result;
}
