import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { c as tarCreate } from "tar";
import { EnvHttpProxyAgent, ProxyAgent } from "undici";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ModelIntegrityError } from "../errors";
import type { ModelEntry, ModelManifest } from "./types";

const state = vi.hoisted(() => ({ manifest: null as ModelManifest | null }));

vi.mock("./catalog", () => ({
  loadManifest: () => state.manifest,
  getModel: (id: string) => {
    const m = state.manifest?.models.find((x) => x.id === id);
    if (!m) throw new Error(`unknown model ${id}`);
    return m;
  },
}));

import { ensureModel, installFromArchive, isModelInstalled, selectDispatcher, verifyModelDir } from "./delivery";

const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

const CONTENT: Record<string, string> = {
  "onnx/model.onnx": "model-bytes".repeat(100),
  "tokenizer.json": '{"tok":1}',
};

function makeEntry(): ModelEntry {
  return {
    id: "test-model",
    hfRepo: "acme/test-model",
    revision: "rev123",
    files: Object.entries(CONTENT).map(([path, body]) => ({ path, sha256: sha(body), size: Buffer.byteLength(body) })),
    dims: 4,
    pooling: "mean",
    maxTokens: 128,
    license: "MIT",
    sizeMb: 1,
    dtype: "q8",
  };
}

let tmp: string;
let server: Server;
let base: string;
let routes: Map<string, Buffer | number>;
let hits: string[];

function localFetch(): typeof fetch {
  return ((url: string | URL, init?: RequestInit) => {
    const u = new URL(String(url));
    hits.push(`${u.host}${u.pathname}`);
    return fetch(`${base}/${u.host}${u.pathname}`, { signal: init?.signal });
  }) as typeof fetch;
}

function serveModel(entry: ModelEntry, overrides: Record<string, string> = {}): void {
  for (const f of entry.files) {
    const body = overrides[f.path] ?? CONTENT[f.path]!;
    routes.set(`/huggingface.co/${entry.hfRepo}/resolve/${entry.revision}/${f.path}`, Buffer.from(body));
  }
}

async function makeArchive(entry: ModelEntry, overrides: Record<string, string> = {}): Promise<string> {
  const src = join(tmp, "arc-src");
  for (const f of entry.files) {
    const p = join(src, entry.id, f.path);
    await mkdir(join(p, ".."), { recursive: true });
    await writeFile(p, overrides[f.path] ?? CONTENT[f.path]!);
  }
  const file = join(tmp, `${entry.id}.tar`);
  await tarCreate({ file, cwd: src }, [entry.id]);
  return file;
}

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "ce-delivery-"));
  hits = [];
  routes = new Map();
  state.manifest = { version: 1, mirror: { githubRepo: "org/repo", tag: "models-v1" }, models: [makeEntry()] };
  server = createServer((req, res) => {
    const r = routes.get(req.url ?? "");
    if (r === undefined) {
      res.statusCode = 404;
      res.end();
    } else if (typeof r === "number") {
      res.statusCode = r;
      res.end();
    } else {
      res.end(r);
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise((r) => server.close(r));
  await rm(tmp, { recursive: true, force: true });
});

describe("ensureModel", () => {
  it("downloads from Hugging Face into <modelsDir>/<id> and reports progress", async () => {
    const entry = makeEntry();
    serveModel(entry);
    const modelsDir = join(tmp, "models");
    const progress: number[] = [];
    const dir = await ensureModel(entry, {
      modelsDir,
      fetchImpl: localFetch(),
      onProgress: (done, total) => progress.push(done / total),
    });
    expect(dir).toBe(join(modelsDir, "test-model"));
    expect(await readFile(join(dir, "tokenizer.json"), "utf8")).toBe(CONTENT["tokenizer.json"]);
    expect(await verifyModelDir(dir, entry)).toBe(true);
    expect(isModelInstalled(entry, modelsDir)).toBe(true);
    expect(progress.at(-1)).toBe(1);
    expect(await readdir(modelsDir)).toEqual(["test-model"]);
    expect(hits[0]).toBe("huggingface.co/acme/test-model/resolve/rev123/onnx/model.onnx");
  });

  it("skips the network when already installed", async () => {
    const entry = makeEntry();
    serveModel(entry);
    const opts = { modelsDir: join(tmp, "models"), fetchImpl: localFetch() };
    await ensureModel(entry, opts);
    hits.length = 0;
    await ensureModel(entry, opts);
    expect(hits).toEqual([]);
  });

  it("raises ModelIntegrityError on sha mismatch and leaves no files", async () => {
    const entry = makeEntry();
    serveModel(entry, { "tokenizer.json": "tampered" });
    const modelsDir = join(tmp, "models");
    await expect(ensureModel(entry, { modelsDir, fetchImpl: localFetch() })).rejects.toBeInstanceOf(
      ModelIntegrityError,
    );
    expect(await readdir(modelsDir)).toEqual([]);
    expect(hits.some((h) => h.startsWith("github.com"))).toBe(false);
  });

  it("falls back to the GitHub Releases mirror when Hugging Face fails", async () => {
    const entry = makeEntry();
    routes.set(`/huggingface.co/${entry.hfRepo}/resolve/${entry.revision}/onnx/model.onnx`, 503);
    routes.set("/github.com/org/repo/releases/download/models-v1/test-model.tar", await readFile(await makeArchive(entry)));
    const modelsDir = join(tmp, "models");
    const dir = await ensureModel(entry, { modelsDir, fetchImpl: localFetch() });
    expect(await verifyModelDir(dir, entry)).toBe(true);
    expect(await readdir(modelsDir)).toEqual(["test-model"]);
  });

  it("rejects a tampered mirror archive", async () => {
    const entry = makeEntry();
    routes.set(
      "/github.com/org/repo/releases/download/models-v1/test-model.tar",
      await readFile(await makeArchive(entry, { "tokenizer.json": "evil" })),
    );
    const modelsDir = join(tmp, "models");
    await expect(ensureModel(entry, { modelsDir, fetchImpl: localFetch() })).rejects.toBeInstanceOf(
      ModelIntegrityError,
    );
    expect(await readdir(modelsDir)).toEqual([]);
  });

  it("reports both errors when HF and the mirror fail", async () => {
    await expect(ensureModel(makeEntry(), { modelsDir: join(tmp, "models"), fetchImpl: localFetch() })).rejects.toThrow(
      /mirror/,
    );
  });

  it("uses offlineArchive before touching the network", async () => {
    const entry = makeEntry();
    const archive = await makeArchive(entry);
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const dir = await ensureModel(entry, { modelsDir: join(tmp, "models"), offlineArchive: archive, fetchImpl });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(await verifyModelDir(dir, entry)).toBe(true);
  });
});

describe("installFromArchive", () => {
  it("extracts <id>/... and returns installed ids", async () => {
    const entry = makeEntry();
    const modelsDir = join(tmp, "models");
    expect(await installFromArchive(await makeArchive(entry), modelsDir)).toEqual(["test-model"]);
    expect(existsSync(join(modelsDir, "test-model", "onnx", "model.onnx"))).toBe(true);
  });

  it("rejects mismatched sha and installs nothing", async () => {
    const entry = makeEntry();
    const modelsDir = join(tmp, "models");
    const archive = await makeArchive(entry, { "onnx/model.onnx": "bad" });
    await expect(installFromArchive(archive, modelsDir)).rejects.toBeInstanceOf(ModelIntegrityError);
    expect(await readdir(modelsDir)).toEqual([]);
  });
});

describe("verifyModelDir", () => {
  it("returns false for missing or modified files", async () => {
    const entry = makeEntry();
    const dir = join(tmp, "m");
    expect(await verifyModelDir(dir, entry)).toBe(false);
    await mkdir(join(dir, "onnx"), { recursive: true });
    await writeFile(join(dir, "onnx/model.onnx"), CONTENT["onnx/model.onnx"]!);
    await writeFile(join(dir, "tokenizer.json"), "x".repeat(9));
    expect(await verifyModelDir(dir, entry)).toBe(false);
  });
});

describe("selectDispatcher", () => {
  it("returns undefined without a proxy", () => {
    expect(selectDispatcher(undefined, {})).toBeUndefined();
  });

  it("uses ProxyAgent for an explicit proxy", () => {
    expect(selectDispatcher("http://127.0.0.1:3128", {})).toBeInstanceOf(ProxyAgent);
  });

  it("uses EnvHttpProxyAgent when HTTPS_PROXY is set", () => {
    expect(selectDispatcher(undefined, { HTTPS_PROXY: "http://127.0.0.1:3128" })).toBeInstanceOf(EnvHttpProxyAgent);
  });
});
