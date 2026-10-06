import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, statSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { x as untar } from "tar";
import { EnvHttpProxyAgent, fetch as undiciFetch, ProxyAgent, type Dispatcher } from "undici";
import { ModelIntegrityError } from "../errors";
import { getModel, loadManifest } from "./catalog";
import type { ModelEntry } from "./types";

export interface EnsureModelOptions {
  modelsDir: string;
  offlineArchive?: string;
  proxy?: string;
  onProgress?: (done: number, total: number) => void;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

export function selectDispatcher(
  proxy: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Dispatcher | undefined {
  if (proxy) return new ProxyAgent(proxy);
  if (env["HTTPS_PROXY"] || env["https_proxy"]) {
    return new EnvHttpProxyAgent({ httpsProxy: env["HTTPS_PROXY"] ?? env["https_proxy"] });
  }
  return undefined;
}

function modelDir(entry: ModelEntry, modelsDir: string): string {
  return join(modelsDir, entry.id);
}

function hashFile(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash("sha256");
    createReadStream(file)
      .on("data", (c) => h.update(c))
      .on("error", reject)
      .on("end", () => resolve(h.digest("hex")));
  });
}

export async function verifyModelDir(dir: string, entry: ModelEntry): Promise<boolean> {
  for (const f of entry.files) {
    const p = join(dir, f.path);
    try {
      if ((await stat(p)).size !== f.size) return false;
      if ((await hashFile(p)) !== f.sha256) return false;
    } catch {
      return false;
    }
  }
  return true;
}

export function isModelInstalled(entry: ModelEntry, modelsDir: string): boolean {
  const dir = modelDir(entry, modelsDir);
  return entry.files.every((f) => {
    const p = join(dir, f.path);
    return existsSync(p) && statSync(p).size === f.size;
  });
}

async function placeDir(staged: string, target: string): Promise<void> {
  await rm(target, { recursive: true, force: true });
  await rename(staged, target);
}

export async function installFromArchive(file: string, modelsDir: string): Promise<string[]> {
  await mkdir(modelsDir, { recursive: true });
  const staging = await mkdtemp(join(modelsDir, ".tmp-"));
  try {
    await untar({ file, cwd: staging });
    const ids = (await readdir(staging, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
    const known = new Set(loadManifest().models.map((m) => m.id));
    const installable = ids.filter((id) => known.has(id));
    if (installable.length === 0) throw new ModelIntegrityError(`archive ${file} contains no known model directory`);
    for (const id of installable) {
      if (!(await verifyModelDir(join(staging, id), getModel(id)))) {
        throw new ModelIntegrityError(`sha256 mismatch for model "${id}" in archive ${file}`);
      }
    }
    for (const id of installable) await placeDir(join(staging, id), join(modelsDir, id));
    return installable;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

interface Downloader {
  fetchImpl: typeof fetch;
  dispatcher: Dispatcher | undefined;
  signal?: AbortSignal;
}

async function download(
  dl: Downloader,
  url: string,
  dest: string,
  onChunk: (n: number) => void,
): Promise<string> {
  const init = { signal: dl.signal, dispatcher: dl.dispatcher } as RequestInit;
  const res = await dl.fetchImpl(url, init);
  if (!res.ok || !res.body) throw new Error(`GET ${url}: HTTP ${res.status}`);
  const hash = createHash("sha256");
  const tap = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      hash.update(chunk);
      onChunk(chunk.length);
      cb(null, chunk);
    },
  });
  await mkdir(dirname(dest), { recursive: true });
  await pipeline(Readable.fromWeb(res.body as never), tap, createWriteStream(dest), { signal: dl.signal });
  return hash.digest("hex");
}

async function downloadFromHf(entry: ModelEntry, dl: Downloader, staging: string, opts: EnsureModelOptions) {
  const total = entry.files.reduce((s, f) => s + f.size, 0);
  let done = 0;
  for (const f of entry.files) {
    const url = `https://huggingface.co/${entry.hfRepo}/resolve/${entry.revision}/${f.path}`;
    const sha = await download(dl, url, join(staging, f.path), (n) => {
      done += n;
      opts.onProgress?.(done, total);
    });
    if (sha !== f.sha256) {
      throw new ModelIntegrityError(`sha256 mismatch for ${entry.id}/${f.path}: expected ${f.sha256}, got ${sha}`);
    }
  }
}

export async function ensureModel(entry: ModelEntry, opts: EnsureModelOptions): Promise<string> {
  const target = modelDir(entry, opts.modelsDir);
  if (isModelInstalled(entry, opts.modelsDir)) return target;

  if (opts.offlineArchive) {
    const ids = await installFromArchive(opts.offlineArchive, opts.modelsDir);
    if (!ids.includes(entry.id)) throw new Error(`archive ${opts.offlineArchive} does not contain model "${entry.id}"`);
    return target;
  }

  await mkdir(opts.modelsDir, { recursive: true });
  const staging = await mkdtemp(join(opts.modelsDir, ".tmp-"));
  const dl: Downloader = {
    fetchImpl: opts.fetchImpl ?? (undiciFetch as unknown as typeof fetch),
    dispatcher: selectDispatcher(opts.proxy),
    signal: opts.signal,
  };
  try {
    try {
      await downloadFromHf(entry, dl, join(staging, "model"), opts);
      await placeDir(join(staging, "model"), target);
      return target;
    } catch (err) {
      if (err instanceof ModelIntegrityError || opts.signal?.aborted) throw err;
      const { githubRepo, tag } = loadManifest().mirror;
      const tarPath = join(staging, `${entry.id}.tar`);
      const url = `https://github.com/${githubRepo}/releases/download/${tag}/${entry.id}.tar`;
      try {
        await download(dl, url, tarPath, () => {});
      } catch (mirrorErr) {
        throw new Error(
          `failed to download model "${entry.id}": ${(err as Error).message}; mirror: ${(mirrorErr as Error).message}`,
        );
      }
      await installFromArchive(tarPath, opts.modelsDir);
      return target;
    }
  } finally {
    await rm(staging, { recursive: true, force: true });
    await dl.dispatcher?.close();
  }
}
