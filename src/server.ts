/**
 * The standalone control plane: the runner protocol the runners speak
 * (claim, heartbeat, log, artifacts, finish), a small read API for people
 * (behind LATHE_ADMIN_TOKEN), and the watcher and scheduler loops. Results
 * reach people through GitHub; this server never needs to be public.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { appendLog, heartbeat, recordArtifact, runDetail, runnerByToken, storeArtifact, tickPipelineSchedules } from "./ci.ts";
import { claimAndReport, finishAndReport } from "./protocol.ts";
import { LatheError, type DB } from "./util.ts";
import { watchOnce } from "./watch.ts";

export interface ServerOptions {
  /** Where uploaded artifacts are stored. */
  dataDir: string;
  /** Bearer token for the read API; without it the read API is off. */
  adminToken?: string;
}

async function readJson(req: IncomingMessage, limit = 2 * 1024 * 1024): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new LatheError(413, "body_too_large", "请求体过大");
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new LatheError(400, "invalid_json", "请求体不是合法 JSON");
  }
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

const bearer = (req: IncomingMessage) => /^Bearer (.+)$/.exec(String(req.headers.authorization ?? ""))?.[1];

export function createLatheServer(db: DB, options: ServerOptions): Server {
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://lathe");
    try {
      if (req.method === "GET" && url.pathname === "/healthz") return send(res, 200, { ok: true });
      if (url.pathname.startsWith("/api/v1/ci/")) {
        const runner = runnerByToken(db, bearer(req));
        if (!runner || runner.status === "revoked") return send(res, 401, { error: "invalid_runner_token", message: "Runner token 无效" });
        if (req.method !== "POST") return send(res, 405, { error: "method_not_allowed", message: "只接受 POST" });
        const route = url.pathname.slice("/api/v1/ci/".length);
        if (route === "artifact/upload") {
          return send(res, 200, await storeArtifact(db, runner.id, String(url.searchParams.get("job_id") ?? ""), {
            name: url.searchParams.get("name") ?? "artifact.tgz",
            data: req,
            dataDir: options.dataDir,
          }));
        }
        const body = await readJson(req);
        switch (route) {
          case "claim":
            return send(res, 200, await claimAndReport(db, runner));
          case "heartbeat":
            return send(res, 200, heartbeat(db, runner.id, body.job_id ? String(body.job_id) : undefined));
          case "log":
            return send(res, 200, appendLog(db, runner.id, String(body.job_id ?? ""), String(body.chunk ?? "")));
          case "artifact":
            return send(res, 200, recordArtifact(db, runner.id, String(body.job_id ?? ""), {
              name: String(body.name ?? "artifact"), path: String(body.path ?? ""), size: Number(body.size ?? 0), digest: String(body.digest ?? ""), kind: body.kind ? String(body.kind) : undefined,
            }));
          case "finish":
            return send(res, 200, await finishAndReport(db, runner.id, String(body.job_id ?? ""), body));
        }
        return send(res, 404, { error: "not_found", message: "未知接口" });
      }
      if (url.pathname.startsWith("/api/v1/runs")) {
        if (!options.adminToken || bearer(req) !== options.adminToken) return send(res, 401, { error: "unauthenticated", message: "需要管理 token" });
        const id = url.pathname.split("/")[4];
        if (!id) {
          const limit = Math.min(200, Number(url.searchParams.get("limit") ?? 50) || 50);
          return send(res, 200, {
            runs: db.prepare(
              `SELECT r.id, p.name AS pipeline, r.trigger, r.ref, r.commit_sha, r.status, r.error, r.created_at, r.finished_at
                 FROM ci_runs r JOIN ci_pipelines p ON p.id = r.pipeline_id ORDER BY r.created_at DESC LIMIT ?`,
            ).all(limit),
          });
        }
        const run = db.prepare("SELECT project_id FROM ci_runs WHERE id = ?").get(id) as { project_id: string } | undefined;
        if (!run) return send(res, 404, { error: "run_not_found", message: "运行不存在" });
        return send(res, 200, runDetail(db, run.project_id, id));
      }
      return send(res, 404, { error: "not_found", message: "未知接口" });
    } catch (err) {
      const e = err as { status?: number; code?: string; message?: string };
      if (typeof e.status === "number" && e.status >= 400 && e.status < 600 && e.code) return send(res, e.status, { error: e.code, message: e.message });
      console.error("[lathe]", err);
      return send(res, 500, { error: "internal", message: "内部错误" });
    }
  });
}

/** The watcher every `watchSeconds` and the scheduler every minute, until stopped. */
export function startLoops(db: DB, options: { dbPath: string; watchSeconds?: number }): () => void {
  let stopped = false;
  let watching = false;
  const watch = async () => {
    if (watching || stopped) return;
    watching = true;
    try {
      await watchOnce(db, { cacheDir: join(dirname(options.dbPath), "watch-cache") });
    } catch (err) {
      console.error("[lathe] watch", err instanceof Error ? err.message : err);
    } finally {
      watching = false;
    }
  };
  const tick = () => {
    try {
      tickPipelineSchedules(db);
    } catch (err) {
      console.error("[lathe] schedule", err instanceof Error ? err.message : err);
    }
  };
  const timers = [setInterval(watch, (options.watchSeconds ?? 120) * 1000), setInterval(tick, 60_000)];
  void watch();
  return () => {
    stopped = true;
    for (const timer of timers) clearInterval(timer);
  };
}
