/**
 * The CI's own health, for an outside alerter: did the watcher finish a pass
 * lately, are the runners heartbeating, is anything stuck in the queue, is
 * there disk left, did the off-site backup run. Each check says how bad its
 * failure is; the report carries no secrets.
 */
import { statfsSync, statSync } from "node:fs";
import type { DB } from "./util.ts";

export const STATE_SCHEMA = `
CREATE TABLE IF NOT EXISTS lathe_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

export function setState(db: DB, key: string, value: string): void {
  db.prepare(
    `INSERT INTO lathe_state (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, value, new Date().toISOString());
}

function getState(db: DB, key: string): { value: string; updated_at: string } | null {
  try {
    return (db.prepare("SELECT value, updated_at FROM lathe_state WHERE key = ?").get(key) as any) ?? null;
  } catch {
    return null;
  }
}

export interface HealthCheck {
  name: string;
  ok: boolean;
  /** How bad it is when it fails. */
  severity: "critical" | "warning";
  detail: string;
}

export interface HealthOptions {
  /** A directory on the filesystem whose free space is checked (the data directory). */
  dataDir: string;
  /** Below this many free bytes the disk check fails (10 GiB). */
  minFreeBytes?: number;
  /** A watcher pass older than this fails (10 minutes; it runs every two). */
  watcherMaxAgeMinutes?: number;
  /** A runner unseen for longer is down (5 minutes; it heartbeats every 30 s). */
  runnerMaxSilenceMinutes?: number;
  /** A job queued longer than this fails (60 minutes). */
  queueMaxAgeMinutes?: number;
  /**
   * Runners that may be offline (a workstation that sleeps): reported, never
   * failing. Jobs waiting for them still fail the queue check.
   */
  optionalRunners?: string[];
  /** A file whose modification time marks the last good off-site backup. */
  offsiteMarker?: string;
  offsiteMaxAgeHours?: number;
  now?: Date;
}

const minutes = (ms: number) => Math.round(ms / 60_000);

export function ciHealth(db: DB, options: HealthOptions): { generated_at: string; ok: boolean; checks: HealthCheck[] } {
  const now = options.now ?? new Date();
  const checks: HealthCheck[] = [];

  const watch = getState(db, "watch_last_pass");
  const watchAge = watch ? now.getTime() - new Date(watch.updated_at).getTime() : Infinity;
  const watchMax = (options.watcherMaxAgeMinutes ?? 10) * 60_000;
  checks.push({
    name: "ci.watcher",
    ok: watchAge <= watchMax,
    severity: "critical",
    detail: watch ? `last pass ${minutes(watchAge)} min ago (${watch.value})` : "no watcher pass recorded",
  });
  // One pass with a warning is usually GitHub having a moment; three in a
  // row (six minutes) is worth a message.
  const streak = Number(getState(db, "watch_warning_streak")?.value ?? 0);
  checks.push({
    name: "ci.watcher.warnings",
    ok: streak < 3,
    severity: "warning",
    detail: streak ? `${streak} pass(es) in a row with warnings; last: ${getState(db, "watch_last_warning")?.value ?? ""}`.slice(0, 280) : "none",
  });

  const silence = (options.runnerMaxSilenceMinutes ?? 5) * 60_000;
  const optional = new Set(options.optionalRunners ?? []);
  const runners = db.prepare("SELECT name, labels, last_seen_at FROM ci_runners WHERE status != 'revoked' ORDER BY name").all() as any[];
  for (const runner of runners) {
    const age = runner.last_seen_at ? now.getTime() - new Date(runner.last_seen_at).getTime() : Infinity;
    const seen = Number.isFinite(age) ? `last heartbeat ${minutes(age)} min ago, labels ${runner.labels || "-"}` : "never seen";
    checks.push({
      name: `ci.runner.${runner.name}`,
      ok: age <= silence || optional.has(runner.name),
      severity: optional.has(runner.name) ? "warning" : "critical",
      detail: optional.has(runner.name) && age > silence ? `offline, optional: ${seen}` : seen,
    });
  }

  const oldest = db
    .prepare(
      `SELECT j.created_at, p.name FROM ci_jobs j JOIN ci_runs r ON r.id = j.run_id JOIN ci_pipelines p ON p.id = r.pipeline_id
        WHERE j.status = 'queued' ORDER BY j.created_at LIMIT 1`,
    )
    .get() as { created_at: string; name: string } | undefined;
  const queued = Number((db.prepare("SELECT count(*) AS n FROM ci_jobs WHERE status = 'queued'").get() as any).n);
  const queueAge = oldest ? now.getTime() - new Date(oldest.created_at).getTime() : 0;
  checks.push({
    name: "ci.queue",
    ok: queueAge <= (options.queueMaxAgeMinutes ?? 60) * 60_000,
    severity: "warning",
    detail: oldest ? `${queued} queued, oldest ${minutes(queueAge)} min (${oldest.name})` : "empty",
  });

  try {
    const fs = statfsSync(options.dataDir);
    const free = fs.bavail * fs.bsize;
    const min = options.minFreeBytes ?? 10 * 1024 ** 3;
    checks.push({
      name: "ci.disk",
      ok: free >= min,
      severity: "critical",
      detail: `${(free / 1024 ** 3).toFixed(1)} GiB free (${Math.round((free / (fs.blocks * fs.bsize)) * 100)}%), minimum ${(min / 1024 ** 3).toFixed(0)} GiB`,
    });
  } catch (err) {
    checks.push({ name: "ci.disk", ok: false, severity: "critical", detail: `statfs failed: ${err instanceof Error ? err.message : err}` });
  }

  if (options.offsiteMarker) {
    let age = Infinity;
    try {
      age = now.getTime() - statSync(options.offsiteMarker).mtimeMs;
    } catch {
      // never written
    }
    const max = (options.offsiteMaxAgeHours ?? 36) * 3_600_000;
    checks.push({
      name: "ci.offsite_backup",
      ok: age <= max,
      severity: "critical",
      detail: Number.isFinite(age) ? `last off-site backup ${Math.round(age / 3_600_000)} h ago` : "no off-site backup yet",
    });
  }

  return { generated_at: now.toISOString(), ok: checks.every((c) => c.ok), checks };
}
