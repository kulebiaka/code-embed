import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { INDEX_DIR_NAME } from "./location";

export const INDEX_DB = "index.db";
export const META_FILE = "meta.json";
export const LOCK_FILE = "lock";

export function ensureIndexDir(dir: string): { created: boolean } {
  const created = !existsSync(dir);
  mkdirSync(dir, { recursive: true });
  const gitignore = join(dir, ".gitignore");
  if (!existsSync(gitignore)) writeFileSync(gitignore, "*\n");
  return { created };
}

export function dockerignoreWarning(root: string): string | null {
  if (!existsSync(join(root, "Dockerfile"))) return null;
  let content = "";
  try {
    content = readFileSync(join(root, ".dockerignore"), "utf8");
  } catch {}
  if (content.includes(INDEX_DIR_NAME)) return null;
  return `Dockerfile found but .dockerignore does not exclude ${INDEX_DIR_NAME}; add "${INDEX_DIR_NAME}" to .dockerignore to keep the index out of images`;
}
