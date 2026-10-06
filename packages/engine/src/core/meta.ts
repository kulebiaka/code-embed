export const SCHEMA_VERSION = 1;

export interface IndexMeta {
  schema_version: number;
  model_id: string | null;
  model_sha: string | null;
  chunker_version: string;
  dims: number | null;
}

export type MetaDiff = "ok" | "schema" | "chunker" | "model" | "missing";

export function readMeta(_dir: string): IndexMeta | null {
  throw new Error("not implemented: core/meta.readMeta");
}

export function writeMeta(_dir: string, _meta: IndexMeta): void {
  throw new Error("not implemented: core/meta.writeMeta");
}

export function compareMeta(_found: IndexMeta | null, _expected: IndexMeta): MetaDiff {
  throw new Error("not implemented: core/meta.compareMeta");
}
