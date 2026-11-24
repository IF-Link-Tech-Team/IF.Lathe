import { createPrivateKey, sign } from "node:crypto";
import { gzipSync } from "node:zlib";
import { fail } from "./util.ts";

/**
 * The GitHub REST surface Lathe uses, as a GitHub App: App JWTs, installation
 * tokens, commit statuses and check runs, code scanning uploads and the open
 * pull requests the watcher builds. Nothing here logs or returns a token.
 */

/** What authenticating as the App takes. */
export interface GithubCredentials {
  app_id: string;
  private_key: string;
}

export const GITHUB_API = "https://api.github.com";
const API = GITHUB_API;

function base64url(value: Buffer | string): string {
  return Buffer.from(value).toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

/** RS256 JWT for the App, valid for 9 minutes (GitHub's maximum is 10). */
export function appJwt(app: { app_id: string; private_key: string }, nowSeconds = Math.floor(Date.now() / 1000)): string {
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(JSON.stringify({ iat: nowSeconds - 60, exp: nowSeconds + 540, iss: app.app_id }));
  const signature = sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), createPrivateKey(app.private_key));
  return `${header}.${payload}.${base64url(signature)}`;
}

const tokenCache = new Map<string, { token: string; expires: number }>();

/** Installation token, cached until shortly before it expires. */
export async function installationToken(app: GithubCredentials, installationId: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  const key = `${app.app_id}:${installationId}`;
  const cached = tokenCache.get(key);
  if (cached && cached.expires > Date.now() + 60_000) return cached.token;
  const res = await fetchImpl(`${API}/app/installations/${installationId}/access_tokens`, {
    method: "POST",
    headers: { authorization: `Bearer ${appJwt(app)}`, accept: "application/vnd.github+json", "user-agent": "iflink" },
  });
  if (!res.ok) fail(502, "github_token_failed", `无法获取安装令牌（HTTP ${res.status}）`);
  const body = (await res.json()) as any;
  const expires = new Date(body.expires_at ?? Date.now() + 3_600_000).getTime();
  tokenCache.set(key, { token: body.token, expires });
  return body.token;
}

/**
 * A fresh installation token limited to some repositories of the
 * installation's account and to reading their contents, for a job that
 * clones them. Not cached: each job gets its own, valid for an hour.
 */
export async function scopedReadToken(app: GithubCredentials, installationId: string, repositories: string[], fetchImpl: typeof fetch = fetch): Promise<string> {
  const res = await fetchImpl(`${API}/app/installations/${installationId}/access_tokens`, {
    method: "POST",
    headers: { authorization: `Bearer ${appJwt(app)}`, accept: "application/vnd.github+json", "user-agent": "iflink", "content-type": "application/json" },
    body: JSON.stringify({ repositories, permissions: { contents: "read" } }),
  });
  if (!res.ok) fail(502, "github_token_failed", `无法获取克隆令牌（HTTP ${res.status}）`);
  return ((await res.json()) as any).token;
}

/** GET a GitHub API path with a token; GitHub's 404 stays a 404. */
export async function gh(path: string, token: string, fetchImpl: typeof fetch = fetch): Promise<any> {
  const res = await fetchImpl(`${API}${path}`, {
    headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "iflink" },
  });
  if (!res.ok) fail(res.status === 404 ? 404 : 502, "github_error", `GitHub 返回 HTTP ${res.status}`);
  return res.json();
}

/**
 * Post a commit status. `context` is the name branch protection matches
 * (default `iflink/build`, the build engine's); CI reports each pipeline
 * under its job's name.
 */
export async function commitStatus(
  app: GithubCredentials,
  installationId: string,
  repo: string,
  commit: string,
  state: "pending" | "success" | "failure" | "error",
  description: string,
  fetchImpl: typeof fetch = fetch,
  options: { context?: string; targetUrl?: string } = {},
): Promise<boolean> {
  try {
    const token = await installationToken(app, installationId, fetchImpl);
    const res = await fetchImpl(`${API}/repos/${repo}/statuses/${commit}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "iflink", "content-type": "application/json" },
      body: JSON.stringify({
        state,
        description: description.slice(0, 140),
        context: options.context ?? "iflink/build",
        ...(options.targetUrl ? { target_url: options.targetUrl } : {}),
      }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Uploads one SARIF file (gzip + base64, as the API wants) to the repo's code
 * scanning. Returns GitHub's upload id, or an error message.
 */
export async function uploadSarif(
  app: GithubCredentials,
  installationId: string,
  repo: string,
  input: { commit: string; ref: string; sarif: Buffer },
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  try {
    const token = await installationToken(app, installationId, fetchImpl);
    const res = await fetchImpl(`${API}/repos/${repo}/code-scanning/sarifs`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "iflink", "content-type": "application/json" },
      body: JSON.stringify({ commit_sha: input.commit, ref: input.ref, sarif: gzipSync(input.sarif).toString("base64") }),
    });
    const body = (await res.json().catch(() => ({}))) as { id?: string; message?: string };
    return res.ok ? { ok: true, id: String(body.id ?? "") } : { ok: false, error: `HTTP ${res.status} ${body.message ?? ""}`.trim() };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** The App's installations (App JWT), to record which accounts it is on. */
export async function appInstallations(app: GithubCredentials, fetchImpl: typeof fetch = fetch): Promise<{ id: string; account: string }[]> {
  const list = await gh("/app/installations?per_page=100", appJwt(app), fetchImpl);
  return (list as any[]).map((i) => ({ id: String(i.id), account: String(i.account?.login ?? "") }));
}

/** Open pull requests of a repo: number and head commit. */
export interface OpenPullRequest {
  number: number;
  head: string;
  /** The head branch lives in another repository (a fork). */
  fork: boolean;
  /** GitHub's author_association: OWNER, MEMBER, COLLABORATOR, CONTRIBUTOR, FIRST_TIME_CONTRIBUTOR, FIRST_TIMER, NONE. */
  association: string;
  labels: string[];
}

export async function openPullRequests(app: GithubCredentials, installationId: string, repo: string, fetchImpl: typeof fetch = fetch): Promise<OpenPullRequest[]> {
  const token = await installationToken(app, installationId, fetchImpl);
  const pulls: OpenPullRequest[] = [];
  for (let page = 1; page <= 5; page += 1) {
    const batch = (await gh(`/repos/${repo}/pulls?state=open&per_page=100&page=${page}`, token, fetchImpl)) as any[];
    for (const pr of batch) {
      pulls.push({
        number: Number(pr.number),
        head: String(pr.head?.sha ?? ""),
        fork: (pr.head?.repo?.full_name ?? "") !== (pr.base?.repo?.full_name ?? repo),
        association: String(pr.author_association ?? "NONE"),
        labels: Array.isArray(pr.labels) ? pr.labels.map((l: any) => String(l?.name ?? "")) : [],
      });
    }
    if (batch.length < 100) break;
  }
  return pulls;
}

/**
 * Whether a PR's code may run without a maintainer's say-so. As GitHub
 * Actions' "first-time contributors" policy: same-repository PRs and forks by
 * anyone who has contributed before run; a fork by a first-time contributor
 * waits until a maintainer labels it `ci-approved`.
 */
export function prMayRun(pr: Pick<OpenPullRequest, "fork" | "association" | "labels">): boolean {
  if (!pr.fork) return true;
  if (["OWNER", "MEMBER", "COLLABORATOR", "CONTRIBUTOR"].includes(pr.association)) return true;
  return pr.labels.includes("ci-approved");
}

/** `owner/name` of a clone URL (`git@host-alias:owner/name.git`, `https://github.com/owner/name.git`). */
export function repoFullName(url: string): string | null {
  const match = /[:/]([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(url.trim());
  return match ? match[1] : null;
}

/** A write to the API as the installation: the HTTP status and parsed body. */
async function ghSend(
  app: GithubCredentials,
  installationId: string,
  method: "POST" | "PATCH",
  path: string,
  body: unknown,
  fetchImpl: typeof fetch,
): Promise<{ status: number; body: any }> {
  const token = await installationToken(app, installationId, fetchImpl);
  const res = await fetchImpl(`${API}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "iflink", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

export interface CheckRunOutput {
  title: string;
  summary: string;
  text?: string;
  annotations?: CheckAnnotation[];
}

export interface CheckAnnotation {
  path: string;
  start_line: number;
  end_line: number;
  annotation_level: "notice" | "warning" | "failure";
  message: string;
  title?: string;
}

export interface CheckRunBody {
  name?: string;
  head_sha?: string;
  status: "queued" | "in_progress" | "completed";
  conclusion?: "success" | "failure" | "neutral" | "cancelled" | "skipped" | "timed_out" | "action_required";
  started_at?: string;
  completed_at?: string;
  external_id?: string;
  details_url?: string;
  output?: CheckRunOutput;
}

/**
 * Creates (no id) or updates a check run. `forbidden` means the installation
 * has not been granted Checks, and the caller should fall back to a status.
 */
export async function upsertCheckRun(
  app: GithubCredentials,
  installationId: string,
  repo: string,
  checkRunId: string,
  body: CheckRunBody,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: true; id: string } | { ok: false; forbidden: boolean; error: string }> {
  try {
    const res = checkRunId
      ? await ghSend(app, installationId, "PATCH", `/repos/${repo}/check-runs/${checkRunId}`, body, fetchImpl)
      : await ghSend(app, installationId, "POST", `/repos/${repo}/check-runs`, body, fetchImpl);
    if (res.status >= 200 && res.status < 300) return { ok: true, id: String(res.body?.id ?? checkRunId) };
    return { ok: false, forbidden: res.status === 403, error: `HTTP ${res.status} ${res.body?.message ?? ""}`.trim() };
  } catch (err) {
    return { ok: false, forbidden: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Creates a GitHub deployment of a commit to an environment; returns its id. */
export async function createDeployment(
  app: GithubCredentials,
  installationId: string,
  repo: string,
  input: { commit: string; environment: string; description: string },
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  try {
    const res = await ghSend(app, installationId, "POST", `/repos/${repo}/deployments`, {
      ref: input.commit,
      environment: input.environment,
      description: input.description.slice(0, 140),
      auto_merge: false,
      // The checks already ran on this CI; GitHub must not wait for others.
      required_contexts: [],
      production_environment: /prod/i.test(input.environment),
    }, fetchImpl);
    return res.status === 201 ? { ok: true, id: String(res.body.id) } : { ok: false, error: `HTTP ${res.status} ${res.body?.message ?? ""}`.trim() };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function deploymentStatus(
  app: GithubCredentials,
  installationId: string,
  repo: string,
  deploymentId: string,
  input: { state: "queued" | "in_progress" | "success" | "failure" | "error"; description: string; environmentUrl?: string; logUrl?: string },
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  try {
    const res = await ghSend(app, installationId, "POST", `/repos/${repo}/deployments/${deploymentId}/statuses`, {
      state: input.state,
      description: input.description.slice(0, 140),
      ...(input.environmentUrl ? { environment_url: input.environmentUrl } : {}),
      ...(input.logUrl ? { log_url: input.logUrl } : {}),
      auto_inactive: true,
    }, fetchImpl);
    return res.status === 201;
  } catch {
    return false;
  }
}

export interface PullRequestDetail {
  number: number;
  title: string;
  body: string;
  author: string;
  base: string;
  head: string;
  additions: number;
  deletions: number;
}

export interface PullRequestFile {
  path: string;
  status: string;
  additions: number;
  deletions: number;
  /** The unified diff of the file; absent for binary or very large files. */
  patch?: string;
}

export async function pullRequest(app: GithubCredentials, installationId: string, repo: string, number: number, fetchImpl: typeof fetch = fetch): Promise<PullRequestDetail> {
  const token = await installationToken(app, installationId, fetchImpl);
  const pr = await gh(`/repos/${repo}/pulls/${number}`, token, fetchImpl);
  return {
    number,
    title: String(pr.title ?? ""),
    body: String(pr.body ?? ""),
    author: String(pr.user?.login ?? ""),
    base: String(pr.base?.ref ?? ""),
    head: String(pr.head?.sha ?? ""),
    additions: Number(pr.additions ?? 0),
    deletions: Number(pr.deletions ?? 0),
  };
}

/** The files a PR changes, with their patches (GitHub lists at most 3000). */
export async function pullRequestFiles(app: GithubCredentials, installationId: string, repo: string, number: number, fetchImpl: typeof fetch = fetch): Promise<PullRequestFile[]> {
  const token = await installationToken(app, installationId, fetchImpl);
  const files: PullRequestFile[] = [];
  for (let page = 1; page <= 3; page += 1) {
    const batch = (await gh(`/repos/${repo}/pulls/${number}/files?per_page=100&page=${page}`, token, fetchImpl)) as any[];
    for (const f of batch) {
      files.push({ path: String(f.filename), status: String(f.status), additions: Number(f.additions ?? 0), deletions: Number(f.deletions ?? 0), patch: typeof f.patch === "string" ? f.patch : undefined });
    }
    if (batch.length < 100) break;
  }
  return files;
}
