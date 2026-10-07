import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { META_FILE } from "./index-dir";

export const SCHEMA_VERSION = 2;

export interface IndexMeta {
  schema_version: number;
  model_id: string | null;
  model_sha: string | null;
  chunker_version: string;
  dims: number | null;
}

export type MetaDiff = "ok" | "schema" | "chunker" | "model" | "missing";

export function readMeta(dir: string): IndexMeta | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(dir, META_FILE), "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    return parsed as IndexMeta;
  } catch {
    return null;
  }
}

export function writeMeta(dir: string, meta: IndexMeta): void {
  const target = join(dir, META_FILE);
  const tmp = `${target}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(meta, null, 2)}\n`);
  renameSync(tmp, target);
}

export function compareMeta(found: IndexMeta | null, expected: IndexMeta): MetaDiff {
  if (!found) return "missing";
  if (found.schema_version !== expected.schema_version) return "schema";
  if (found.chunker_version !== expected.chunker_version) return "chunker";
  if (
    found.model_id !== expected.model_id ||
    found.model_sha !== expected.model_sha ||
    found.dims !== expected.dims
  )
    return "model";
  return "ok";
}
