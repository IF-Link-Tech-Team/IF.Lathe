/**
 * IF.Lathe — self-hosted CI for GitHub repositories.
 *
 * The engine (pipelines, runs, jobs, runners), GitHub reporting and the
 * pull-based watcher. A host embeds it by calling configureLathe once and
 * wiring the runner protocol routes; see README.md.
 */
export * from "./ci.ts";
export * from "./status.ts";
export { auditPullRequest, auditedRepo, explainFailure, failureNote, setRepoAudit, tokensToday } from "./audit.ts";
export { claimAndReport, finishAndReport, finishBody } from "./protocol.ts";
export { configureLathe, hooks, type LatheHooks } from "./hooks.ts";
export { parseSchedule } from "./cron.ts";
export { LatheError, type DB } from "./util.ts";
export { ciHealth, setState, type HealthCheck, type HealthOptions } from "./health.ts";
