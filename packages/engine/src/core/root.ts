import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { INDEX_DIR_NAME } from "./location";

function nearestAncestor(start: string, marker: string): string | null {
  let dir = start;
  for (;;) {
    if (existsSync(join(dir, marker))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function findProjectRoot(cwd: string): string {
  const start = resolve(cwd);
  return nearestAncestor(start, INDEX_DIR_NAME) ?? nearestAncestor(start, ".git") ?? start;
}
