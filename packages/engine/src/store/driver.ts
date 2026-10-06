import { DatabaseSync } from "node:sqlite";
import { getLoadablePath } from "sqlite-vec";

export type Row = Record<string, any>;
export type SqlParam = string | number | bigint | null | Uint8Array;

export interface Stmt {
  get(...params: SqlParam[]): Row | undefined;
  all(...params: SqlParam[]): Row[];
  run(...params: SqlParam[]): { lastInsertRowid: number | bigint };
}

export interface Db {
  exec(sql: string): void;
  prepare(sql: string): Stmt;
  close(): void;
}

export function openDatabase(path: string, readonly: boolean): Db {
  const db = new DatabaseSync(path, { allowExtension: true, readOnly: readonly });
  try {
    db.loadExtension(getLoadablePath());
  } catch (e) {
    db.close();
    throw e;
  }
  return db as unknown as Db;
}

export function isCorruptionError(e: unknown): boolean {
  const err = e as { errcode?: number; message?: string };
  if (err.errcode === 11 || err.errcode === 26) return true;
  return /malformed|not a database|corrupt/i.test(err.message ?? "");
}
