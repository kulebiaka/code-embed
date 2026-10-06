import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, posix, sep } from "node:path";
import ignore, { type Ignore } from "ignore";
import { detectLang } from "./lang";
import type { ScanOptions, ScannedFile } from "./types";

const ALWAYS_EXCLUDED = new Set([".code-embed", ".git"]);
const LOCKFILES = new Set([
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lockb",
  "bun.lock",
  "Cargo.lock",
  "poetry.lock",
  "Pipfile.lock",
  "uv.lock",
  "composer.lock",
  "Gemfile.lock",
  "go.sum",
  "packages.lock.json",
  "gradle.lockfile",
]);

export function isLockfileName(path: string): boolean {
  return LOCKFILES.has(path.slice(path.lastIndexOf("/") + 1));
}

function isGeneratedName(name: string): boolean {
  return /\.min\.[^.]+$/i.test(name) || name.endsWith(".map");
}

function globalGitignorePath(): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("git", ["config", "--get", "core.excludesFile"], { timeout: 5000 }, (err, stdout) => {
      let p = err ? "" : stdout.trim();
      if (p.startsWith("~")) p = join(homedir(), p.slice(1));
      if (!p) p = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "git", "ignore");
      resolve(existsSync(p) ? p : null);
    });
  });
}

function readIgnoreFile(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

export async function createIgnoreMatcher(
  root: string,
  exclude: string[],
): Promise<(relPath: string, isDir: boolean) => boolean> {
  const rootIg = ignore();
  const globalPath = await globalGitignorePath();
  const globalText = globalPath ? readIgnoreFile(globalPath) : null;
  if (globalText) rootIg.add(globalText);
  if (exclude.length > 0) rootIg.add(exclude);

  const dirCache = new Map<string, Ignore | null>();
  const dirIgnore = (dir: string): Ignore | null => {
    let ig = dirCache.get(dir);
    if (ig !== undefined) return ig;
    ig = null;
    const base = join(root, dir);
    for (const name of [".gitignore", ".ignore"]) {
      const text = readIgnoreFile(join(base, name));
      if (text) (ig ??= ignore()).add(text);
    }
    dirCache.set(dir, ig);
    return ig;
  };

  const decideOne = (relPath: string, isDir: boolean): boolean => {
    const segs = relPath.split("/");
    let ignored = false;
    for (let depth = -1; depth < segs.length; depth++) {
      const ig = depth === -1 ? rootIg : dirIgnore(segs.slice(0, depth).join("/"));
      if (!ig) continue;
      const rest = segs.slice(Math.max(depth, 0)).join("/") + (isDir ? "/" : "");
      const r = ig.test(rest);
      if (r.ignored) ignored = true;
      else if (r.unignored) ignored = false;
    }
    return ignored;
  };

  return (relPath, isDir) => {
    const rel = relPath.split(sep).join("/").replace(/^\/+|\/+$/g, "");
    if (rel === "") return false;
    const segs = rel.split("/");
    if (segs.some((s) => ALWAYS_EXCLUDED.has(s))) return true;
    for (let i = 1; i < segs.length; i++) {
      if (decideOne(segs.slice(0, i).join("/"), true)) return true;
    }
    return decideOne(rel, isDir);
  };
}

export async function* scanFiles(root: string, opts: ScanOptions): AsyncIterable<ScannedFile> {
  const isIgnored = await createIgnoreMatcher(root, opts.exclude);
  const realRoot = await realpath(root);
  const maxBytes = opts.maxFileKb * 1024;
  const visited = new Set<string>();

  const inside = (real: string): boolean => real === realRoot || real.startsWith(realRoot + sep);

  async function* walk(absDir: string, relDir: string): AsyncGenerator<ScannedFile> {
    const real = await realpath(absDir);
    if (visited.has(real)) return;
    visited.add(real);
    let entries;
    try {
      entries = await readdir(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (opts.signal?.aborted) return;
      const rel = relDir ? posix.join(relDir, entry.name) : entry.name;
      const abs = join(absDir, entry.name);
      let isDir = entry.isDirectory();
      let isFile = entry.isFile();
      if (entry.isSymbolicLink()) {
        try {
          if (!inside(await realpath(abs))) continue;
          const st = await stat(abs);
          isDir = st.isDirectory();
          isFile = st.isFile();
        } catch {
          continue;
        }
      }
      if (!isDir && !isFile) continue;
      if (isIgnored(rel, isDir)) continue;
      if (isDir) {
        yield* walk(abs, rel);
        continue;
      }
      if (isGeneratedName(entry.name) || isLockfileName(rel)) continue;
      let st;
      try {
        st = await stat(abs);
      } catch {
        continue;
      }
      if (st.size > maxBytes) continue;
      yield { path: rel, absPath: abs, size: st.size, mtimeMs: st.mtimeMs, lang: detectLang(rel) };
    }
  }

  yield* walk(root, "");
}
