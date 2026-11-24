/**
 * Lathe on its own: one SQLite file, its own vault and GitHub App storage,
 * and the hooks wired to them. IF.Platform does not use this file; it brings
 * its own vault, App storage and projects (see configureLathe).
 */
import { createCipheriv, createDecipheriv, createHash, createPrivateKey, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { migrateCi } from "./ci.ts";
import { configureLathe } from "./hooks.ts";
import { assert, id, nowIso, type DB } from "./util.ts";

const STANDALONE_SCHEMA = `
CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  archived_at TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  archived_at TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS lathe_secrets (
  project_id TEXT NOT NULL,
  key TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_id, key)
);
CREATE TABLE IF NOT EXISTS lathe_github (
  workspace_id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL,
  private_key TEXT NOT NULL,
  installation_id TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

/* Vault ---------------------------------------------------------------------- */

// AES-256-GCM, `iv:data:tag` in hex, the key the SHA-256 of LATHE_SECRET_KEY:
// the same format IF.Kernel uses, so values move between the two.
function vaultKey(): Buffer {
  const material = process.env.LATHE_SECRET_KEY;
  assert(material && material.length >= 16, 500, "no_secret_key", "LATHE_SECRET_KEY 未设置（至少 16 个字符）");
  return createHash("sha256").update(material).digest();
}

export function seal(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", vaultKey(), iv);
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return [iv.toString("hex"), data.toString("hex"), cipher.getAuthTag().toString("hex")].join(":");
}

export function unseal(payload: string): string {
  const [iv, data, tag] = payload.split(":");
  const decipher = createDecipheriv("aes-256-gcm", vaultKey(), Buffer.from(iv, "hex"));
  decipher.setAuthTag(Buffer.from(tag, "hex"));
  return Buffer.concat([decipher.update(Buffer.from(data, "hex")), decipher.final()]).toString("utf8");
}

const KEY_NAME = /^[A-Z][A-Z0-9_]{1,63}$/;

export function setSecret(db: DB, projectId: string, key: string, value: string): void {
  assert(KEY_NAME.test(key), 400, "invalid_secret_key", "密钥名只能是大写字母、数字和下划线");
  db.prepare(
    `INSERT INTO lathe_secrets (project_id, key, ciphertext, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(project_id, key) DO UPDATE SET ciphertext = excluded.ciphertext, updated_at = excluded.updated_at`,
  ).run(projectId, key, seal(value), nowIso());
}

export function resolveSecret(db: DB, projectId: string, key: string): string | null {
  const row = db.prepare("SELECT ciphertext FROM lathe_secrets WHERE project_id = ? AND key = ?").get(projectId, key) as { ciphertext: string } | undefined;
  return row ? unseal(row.ciphertext) : null;
}

export function listSecrets(db: DB, projectId: string): { key: string; updated_at: string }[] {
  return db.prepare("SELECT key, updated_at FROM lathe_secrets WHERE project_id = ? ORDER BY key").all(projectId) as any[];
}

/* GitHub App ----------------------------------------------------------------- */

export function setGithubApp(db: DB, workspaceId: string, input: { appId: string; privateKey: string; installationId: string }): void {
  assert(/^\d+$/.test(input.appId), 400, "invalid_app_id", "App ID 应为数字");
  assert(/^\d+$/.test(input.installationId), 400, "invalid_installation", "安装 ID 应为数字");
  createPrivateKey(input.privateKey); // throws on anything that is not a key
  db.prepare(
    `INSERT INTO lathe_github (workspace_id, app_id, private_key, installation_id, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(workspace_id) DO UPDATE SET app_id = excluded.app_id, private_key = excluded.private_key,
         installation_id = excluded.installation_id, updated_at = excluded.updated_at`,
  ).run(workspaceId, input.appId, seal(input.privateKey), input.installationId, nowIso());
}

function githubApp(db: DB, workspaceId: string) {
  const row = db.prepare("SELECT app_id, private_key, installation_id FROM lathe_github WHERE workspace_id = ?").get(workspaceId) as any;
  return row ? { app: { app_id: row.app_id, private_key: unseal(row.private_key) }, installationId: row.installation_id } : null;
}

/* Database ------------------------------------------------------------------- */

/** The default project every pipeline belongs to unless another is named. */
export function ensureProject(db: DB, slug = "default"): { id: string; workspace_id: string } {
  const existing = db.prepare("SELECT id, workspace_id FROM projects WHERE slug = ?").get(slug) as any;
  if (existing) return existing;
  let workspace = db.prepare("SELECT id FROM workspaces WHERE slug = 'default'").get() as any;
  if (!workspace) {
    workspace = { id: id("wsp") };
    db.prepare("INSERT INTO workspaces (id, slug, name, created_at) VALUES (?, 'default', 'default', ?)").run(workspace.id, nowIso());
  }
  const project = { id: id("prj"), workspace_id: workspace.id };
  db.prepare("INSERT INTO projects (id, workspace_id, slug, name, created_at) VALUES (?, ?, ?, ?, ?)").run(project.id, project.workspace_id, slug, slug, nowIso());
  return project;
}

/** Opens (or creates) a standalone Lathe database and wires the hooks to it. */
export function openLathe(path: string): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
  db.exec(STANDALONE_SCHEMA);
  migrateCi(db);
  configureLathe({
    resolveSecret,
    githubApp: (handle, workspaceId) => githubApp(handle, workspaceId),
  });
  return db;
}
