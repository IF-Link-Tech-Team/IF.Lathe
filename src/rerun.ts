/**
 * `/rerun` comments on pull requests. GitHub's own Re-run button sends a
 * webhook this CI does not receive (it polls), so the watcher reads the
 * repository's new PR comments each pass instead:
 *
 *   /rerun              every check of the PR, at its current head
 *   /rerun check ios    only these checks (their names on GitHub)
 *
 * Who may: the repository's owners, members and collaborators, and the PR's
 * own author when the PR may run anyway (prMayRun: a first-time
 * contributor's fork still needs the ci-approved label). Each comment is
 * acted on once. The new check runs say who asked; a request that starts
 * nothing gets a neutral "rerun" check run saying why, because the App may
 * not comment.
 */
import { gh, installationToken, prMayRun, upsertCheckRun, type GithubCredentials, type OpenPullRequest } from "./github.ts";
import { setState } from "./health.ts";
import { nowIso, type DB } from "./util.ts";

export const RERUN_SCHEMA = `
CREATE TABLE IF NOT EXISTS lathe_reruns (
  comment_id TEXT PRIMARY KEY,
  repo TEXT NOT NULL,
  pr INTEGER NOT NULL,
  author TEXT NOT NULL,
  outcome TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`;

/** The check names a comment asks for: null for all, undefined when it is no /rerun. */
export function parseRerun(body: string): string[] | null | undefined {
  const first = String(body ?? "").trim().split(/\r?\n/)[0].trim();
  const m = /^\/rerun(?:\s+(.*))?$/i.exec(first);
  if (!m) return undefined;
  const names = (m[1] ?? "").split(/[\s,]+/).filter(Boolean);
  return names.length === 0 || names.some((n) => n.toLowerCase() === "all") ? null : names;
}

export interface RerunTarget {
  github: { app: GithubCredentials; installationId: string };
  /** `owner/name`. */
  repo: string;
  /** The repository's open PRs. */
  pulls: OpenPullRequest[];
  /** The repository's PR checks: their GitHub names. */
  checks: string[];
  /**
   * Starts the named checks (all when null) of a PR at its head, returning
   * the names actually started (a check already queued or running at that
   * head is left alone).
   */
  start(pr: OpenPullRequest, names: string[] | null, requestedBy: string): string[];
  fetchImpl?: typeof fetch;
  log?: (line: string) => void;
}

const MAINTAINERS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

/** Acts on the repository's new /rerun comments; returns what was done, for logs and tests. */
export async function handleReruns(db: DB, target: RerunTarget): Promise<{ comment: string; outcome: string }[]> {
  const fetchImpl = target.fetchImpl ?? fetch;
  const cursorKey = `rerun_since:${target.repo}`;
  const cursor = (db.prepare("SELECT value FROM lathe_state WHERE key = ?").get(cursorKey) as { value: string } | undefined)?.value;
  const now = nowIso();
  // The first pass only marks where to start: old /rerun comments stay old.
  if (!cursor) {
    setState(db, cursorKey, now);
    return [];
  }
  // A comment can show up in the API a little after it was written: read
  // five minutes back and skip the ones already handled.
  const since = new Date(new Date(cursor).getTime() - 5 * 60_000).toISOString();
  const token = await installationToken(target.github.app, target.github.installationId, fetchImpl);
  const comments: any[] = [];
  for (let page = 1; page <= 3; page += 1) {
    const batch = (await gh(`/repos/${target.repo}/issues/comments?since=${encodeURIComponent(since)}&sort=created&direction=asc&per_page=100&page=${page}`, token, fetchImpl)) as any[];
    comments.push(...batch);
    if (batch.length < 100) break;
  }
  const done: { comment: string; outcome: string }[] = [];
  for (const comment of comments) {
    const names = parseRerun(comment.body);
    if (names === undefined) continue;
    const id = String(comment.id);
    if (db.prepare("SELECT 1 FROM lathe_reruns WHERE comment_id = ?").get(id)) continue;
    const number = Number(/\/issues\/(\d+)$/.exec(String(comment.issue_url ?? ""))?.[1]);
    const pr = target.pulls.find((p) => p.number === number);
    if (!pr) continue; // an issue, or a closed PR
    const author = String(comment.user?.login ?? "");
    if (comment.user?.type === "Bot") continue;

    let outcome: string;
    let started: string[] = [];
    const unknown = (names ?? []).filter((n) => !target.checks.includes(n));
    if (!prMayRun(pr)) {
      outcome = "这个 PR 来自首次贡献者的 fork，要先由维护者加上 ci-approved 标签";
    } else if (!MAINTAINERS.has(String(comment.author_association)) && author !== pr.author) {
      outcome = `@${author} 不是仓库成员，也不是这个 PR 的作者，不能重跑`;
    } else if (unknown.length) {
      outcome = `没有这些检查：${unknown.join(", ")}（可选：${target.checks.join(", ")}）`;
    } else {
      started = target.start(pr, names, author);
      outcome = started.length ? `已重跑：${started.join(", ")}` : "这些检查已经在排队或运行，没有再启动";
    }
    db.prepare("INSERT INTO lathe_reruns (comment_id, repo, pr, author, outcome, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(id, target.repo, pr.number, author, outcome, now);
    target.log?.(`[ci-watch] /rerun ${target.repo}#${pr.number} by @${author}: ${outcome}`);
    done.push({ comment: id, outcome });
    // Started checks speak for themselves; anything else gets a word back.
    if (started.length === 0) {
      await upsertCheckRun(target.github.app, target.github.installationId, target.repo, "", {
        name: "rerun",
        head_sha: pr.head,
        status: "completed",
        conclusion: "neutral",
        output: { title: "/rerun 没有执行", summary: `@${author} 的 [/rerun](${String(comment.html_url ?? "")})：${outcome}` },
      }, fetchImpl).catch(() => {});
    }
  }
  setState(db, cursorKey, now);
  return done;
}
