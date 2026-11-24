import type { DatabaseSync } from "node:sqlite";
import type { DeployHook, PipelineConfig } from "./ci.ts";
import type { GithubCredentials } from "./github.ts";
import { LatheError } from "./util.ts";

/**
 * What Lathe needs from the program it runs in. A host (IF.Platform) calls
 * configureLathe once at startup; the standalone server keeps the defaults
 * or sets its own. Every hook is optional to override.
 */
export interface LatheHooks {
  /** The CI's name in commit statuses and check output ("Lathe"). */
  name: string;
  /** The error thrown for a status and code, so the host's HTTP layer maps it. */
  makeError(status: number, code: string, message: string): Error;
  /** A pipeline's vault value by key, or null when the project has none. */
  resolveSecret(db: DatabaseSync, projectId: string, key: string): string | null;
  /** Called once when a run reaches its final state. */
  onRunFinished(db: DatabaseSync, run: { id: string; project_id: string }, status: string): void;
  /** Releases a succeeded run that has a `deploy` block; none by default. */
  deployOnSuccess: ((db: DatabaseSync, run: any, config: PipelineConfig, onDeploy?: DeployHook) => Promise<{ ok: boolean; error?: string }>) | null;
  /** The workspace's GitHub App and installation, or null when it has none. */
  githubApp(db: DatabaseSync, workspaceId: string): { app: GithubCredentials; installationId: string } | null;
}

export const hooks: LatheHooks = {
  name: "Lathe",
  makeError: (status, code, message) => new LatheError(status, code, message),
  resolveSecret: () => null,
  onRunFinished: () => {},
  deployOnSuccess: null,
  githubApp: () => null,
};

export function configureLathe(overrides: Partial<LatheHooks>): void {
  Object.assign(hooks, overrides);
}
