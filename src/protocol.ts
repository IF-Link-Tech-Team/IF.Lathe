/**
 * What every host does around the runner protocol's state changes, so the
 * standalone server and an embedding host (IF.Platform) behave the same:
 * GitHub hears each change, a failed check gets its AI reading, CodeQL
 * results are uploaded.
 */
import { explainFailure } from "./audit.ts";
import { claimJob, finishJob } from "./ci.ts";
import { reportRunStatus, uploadRunSarif } from "./status.ts";
import type { DB } from "./util.ts";

const quietly = (task: Promise<unknown>) => void task.catch(() => {});

/** Claims the next job this runner may take and reports its run as in progress. */
export function claimAndReport(db: DB, runner: { id: string; labels: string }) {
  const claimed = claimJob(db, runner);
  if (claimed) quietly(reportRunStatus(db, claimed.job.run_id));
  return claimed ?? { job: null };
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
