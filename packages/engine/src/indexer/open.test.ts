import { spawn } from "node:child_process";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { openEmbCache } from "../cache/embcache";
import { FakeEmbedder } from "../embed/fake";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHUNKER_VERSION } from "../chunk/types";
import { readMeta, writeMeta } from "../core/meta";
import { IndexCorruptError, NoIndexError } from "../errors";
import { setLogSink } from "../util/log";
import { initHashing } from "../util/hash";
import type { EffectiveSettings } from "../config/types";
import { DEFAULT_CHUNK_OPTIONS } from "../chunk/types";
import { runLexical } from "./lexical";
import { openIndex } from "./open";
import { createVectorPhase } from "./vector";

const testSettings: EffectiveSettings = {
  indexLocation: "project",
  maxFileKb: 512,
  threads: 1,
  threadsExplicit: false,
  pauseOnBattery: false,
  exclude: [],
  searchMode: "hybrid",
  searchTop: 20,
  provider: "local",
  model: "m",
  providers: {},
  allowRemote: false,
};

let root: string;
let dir: string;

beforeAll(async () => {
  await initHashing();
});

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "ce-open-")));
  dir = join(root, ".code-embed");
  writeFileSync(join(root, "a.ts"), "export const a = 1;\n");
});

afterEach(() => {
  setLogSink(null);
  rmSync(root, { recursive: true, force: true });
});

describe("openIndex", () => {
  it("creates the dir, gitignore, meta and warns about Dockerfile", async () => {
    writeFileSync(join(root, "Dockerfile"), "FROM x");
    const logs: string[] = [];
    setLogSink((_l, m) => logs.push(m));
    const o = await openIndex(root, testSettings, { dims: 4, expectedModelId: "m" });
    expect(o.created).toBe(true);
    expect(o.readOnly).toBe(false);
    expect(readFileSync(join(dir, ".gitignore"), "utf8").trim()).toBe("*");
    expect(readMeta(dir)).toMatchObject({ model_id: "m", dims: 4, chunker_version: CHUNKER_VERSION });
    expect(logs.some((m) => m.includes(".dockerignore"))).toBe(true);
    o.store.close();
    o.lock?.release();
  });

  it("requireExisting without index throws NoIndexError and creates nothing", async () => {
    await expect(openIndex(root, testSettings, { requireExisting: true })).rejects.toBeInstanceOf(NoIndexError);
    expect(existsSync(dir)).toBe(false);
  });

  it("reopens without rebuild; second writer is read-only", async () => {
    const a = await openIndex(root, testSettings, { expectedModelId: "m", dims: 4 });
    const child = spawn(process.execPath, ["-e", "setTimeout(()=>{},30000)"]);
    a.store.close();
    a.lock?.release();
    writeFileSync(join(dir, "lock"), String(child.pid));
    const b = await openIndex(root, testSettings, { expectedModelId: "m", dims: 4 });
    child.kill();
    expect(b.readOnly).toBe(true);
    expect(b.lock).toBeNull();
    expect(b.created).toBe(false);
    expect(b.rebuildReason).toBeUndefined();
    b.store.close();
    const c = await openIndex(root, testSettings, { readonly: true });
    expect(c.readOnly).toBe(true);
    c.store.close();
  });

  it("chunker_version mismatch rebuilds fully and keeps content", async () => {
    const a = await openIndex(root, testSettings, { expectedModelId: "m", dims: 4 });
    a.store.close();
    a.lock?.release();
    writeMeta(dir, { ...readMeta(dir)!, chunker_version: "old" });
    const b = await openIndex(root, testSettings, { expectedModelId: "m", dims: 4 });
    expect(b.rebuildReason).toMatch(/chunker/);
    expect(b.store.counts().files).toBe(1);
    expect(existsSync(join(dir, "index.db.new"))).toBe(false);
    expect(readMeta(dir)?.chunker_version).toBe(CHUNKER_VERSION);
    b.store.close();
    b.lock?.release();
  });

  it("schema version rebuild reuses cached vectors without re-embedding (NR-04)", async () => {
    const emb = new FakeEmbedder({ dims: 8 });
    const a = await openIndex(root, testSettings, { expectedModelId: emb.info.modelId, dims: 8 });
    const cache = openEmbCache(join(dir, "emb.db"));
    const ctx = {
      root,
      indexDir: dir,
      store: a.store,
      settings: testSettings,
      chunkOptions: DEFAULT_CHUNK_OPTIONS,
      onProgress: () => {},
      onError: () => {},
    };
    await runLexical(ctx);
    const first = createVectorPhase({ ctx, embCache: cache, embedder: emb });
    first.start();
    await first.whenIdle();
    await first.stop();
    expect(a.store.counts().embedded).toBeGreaterThan(0);
    a.store.close();
    a.lock?.release();
    writeMeta(dir, { ...readMeta(dir)!, schema_version: 2 });

    const b = await openIndex(root, testSettings, { expectedModelId: emb.info.modelId, dims: 8 });
    expect(b.rebuildReason).toMatch(/schema/);
    expect(b.store.counts().embedded).toBe(0);
    const spy = vi.spyOn(emb, "embedDocuments");
    const second = createVectorPhase({ ctx: { ...ctx, store: b.store }, embCache: cache, embedder: emb });
    second.start();
    await second.whenIdle();
    await second.stop();
    expect(spy).not.toHaveBeenCalled();
    const counts = b.store.counts();
    expect(counts.embedded).toBe(counts.chunks);
    b.store.close();
    b.lock?.release();
    cache.close();
  });

  it("model change keeps lexical and resets vectors", async () => {
    const a = await openIndex(root, testSettings, { expectedModelId: "m", dims: 4 });
    await runLexical({
      root,
      indexDir: dir,
      store: a.store,
      settings: testSettings,
      chunkOptions: DEFAULT_CHUNK_OPTIONS,
      onProgress: () => {},
      onError: () => {},
    });
    const id = a.store.chunksForFile("a.ts")[0]!.id;
    a.store.setEmbeddings([{ chunkId: id, vector: new Int8Array([1, 2, 3, 4]) }]);
    expect(a.store.counts().embedded).toBe(1);
    a.store.close();
    a.lock?.release();
    const b = await openIndex(root, testSettings, { expectedModelId: "other", dims: 8 });
    expect(b.rebuildReason).toBeUndefined();
    expect(b.store.counts()).toMatchObject({ files: 1, embedded: 0 });
    expect(b.store.dims).toBe(8);
    expect(readMeta(dir)).toMatchObject({ model_id: "other", dims: 8 });
    b.store.close();
    b.lock?.release();
  });

  it("missing or broken meta.json triggers rebuild", async () => {
    const a = await openIndex(root, testSettings, {});
    a.store.close();
    a.lock?.release();
    writeFileSync(join(dir, "meta.json"), "{broken");
    const b = await openIndex(root, testSettings, {});
    expect(b.rebuildReason).toMatch(/meta/);
    expect(b.store.counts().files).toBe(1);
    b.store.close();
    b.lock?.release();
  });

  it("corrupt database triggers rebuild; readonly throws IndexCorruptError", async () => {
    const a = await openIndex(root, testSettings, {});
    a.store.close();
    a.lock?.release();
    writeFileSync(join(dir, "index.db"), Buffer.alloc(8192, 7));
    rmSync(join(dir, "index.db-wal"), { force: true });
    await expect(openIndex(root, testSettings, { readonly: true })).rejects.toBeInstanceOf(IndexCorruptError);
    const b = await openIndex(root, testSettings, {});
    expect(b.rebuildReason).toMatch(/corrupt/);
    expect(b.store.counts().files).toBe(1);
    b.store.close();
    b.lock?.release();
  });
});
