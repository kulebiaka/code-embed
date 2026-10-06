import { tmpdir } from "node:os";
import { join } from "node:path";
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

export function rootHash(root: string): string {
  return blake3Hex(root).slice(0, 16);
}

export function socketPath(root: string): string {
  const hash = rootHash(root);
  if (process.platform === "win32") return `\\\\.\\pipe\\code-embed-${hash}`;
  const tmp = process.env.TMPDIR || tmpdir();
  const base = process.platform === "linux" ? process.env.XDG_RUNTIME_DIR || tmp : tmp;
  return join(base, "code-embed", `${hash}.sock`);
}
