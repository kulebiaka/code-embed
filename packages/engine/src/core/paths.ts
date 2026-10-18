import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import envPaths from "env-paths";
import { blake3Hex } from "../util/hash";

export function cacheDir(): string {
  return process.env.CODE_EMBED_CACHE_DIR || envPaths("code-embed", { suffix: "" }).cache;
}

export function configDir(): string {
  return process.env.CODE_EMBED_CONFIG_DIR || envPaths("code-embed", { suffix: "" }).config;
}

export function modelsDir(): string {
  return join(cacheDir(), "models");
}

export function embCachePath(): string {
  return join(cacheDir(), "emb.db");
}

const upperDrive = (p: string) => (process.platform === "win32" ? p.replace(/^[a-z]:/, (d) => d.toUpperCase()) : p);

export function canonicalRoot(root: string): string {
  const input = upperDrive(root);
  try {
    return upperDrive(realpathSync.native(input));
  } catch {
    return upperDrive(resolve(input));
  }
}

export function rootHash(root: string): string {
  return blake3Hex(canonicalRoot(root)).slice(0, 16);
}

function localSocket(name: string): string {
  if (process.platform === "win32") return `\\\\.\\pipe\\code-embed-${name}`;
  const tmp = process.env.TMPDIR || tmpdir();
  const base = process.platform === "linux" ? process.env.XDG_RUNTIME_DIR || tmp : tmp;
  return join(base, "code-embed", `${name}.sock`);
}

export function socketPath(root: string): string {
  return localSocket(rootHash(root));
}

export function embedHostSocketPath(key: string): string {
  return localSocket(`embed-${key}`);
}
