export const INDEX_DB = "index.db";
export const META_FILE = "meta.json";
export const LOCK_FILE = "lock";

export function ensureIndexDir(_dir: string): { created: boolean } {
  throw new Error("not implemented: core/index-dir.ensureIndexDir");
}

export function dockerignoreWarning(_root: string): string | null {
  throw new Error("not implemented: core/index-dir.dockerignoreWarning");
}
