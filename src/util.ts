import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { hooks } from "./hooks.ts";

/** The SQLite handle every Lathe function takes. */
export type DB = DatabaseSync;

/** An error with the HTTP status and machine-readable code it should answer with. */
export class LatheError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** Throws the host's error type (see configureLathe) for this status and code. */
export function fail(status: number, code: string, message: string): never {
  throw hooks.makeError(status, code, message);
}

export function assert(condition: unknown, status: number, code: string, message: string): asserts condition {
  if (!condition) fail(status, code, message);
}

export function id(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}
