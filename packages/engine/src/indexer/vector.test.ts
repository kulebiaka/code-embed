import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openEmbCache } from "../cache/embcache";
import type { EmbCache } from "../cache/types";
import { FakeEmbedder } from "../embed/fake";
import { ProviderUnavailableError } from "../errors";
import { openIndexStore } from "../store/sqlite";
import type { ChunkInput, IndexStore } from "../store/types";
import { DEFAULT_CHUNK_OPTIONS } from "../chunk/types";
import type { EffectiveSettings } from "../config/types";
import * as power from "./power";
import type { IndexerContext } from "./types";
import { createVectorPhase } from "./vector";

vi.mock("./power", () => ({ isOnBattery: vi.fn(async () => false) }));

let dir: string;
let store: IndexStore;
let cache: EmbCache;
let progress: { phase: string; embedded: number }[];
let ctx: IndexerContext;

function chunk(text: string, n = 0): ChunkInput {
  return {
    startLine: n * 10 + 1,
    endLine: n * 10 + 9,
    startByte: n * 100,
    endByte: n * 100 + 99,
    kind: "function",
    symbol: null,
    parentSymbol: null,
    chunkHash: `h-${text}`,
    text,
    fts: { text, symbol: "", path: "" },
  };
}

function addFile(path: string, texts: string[]) {
  store.upsertFile({ path, lang: "ts", size: 1, mtime: 1, contentHash: `c-${path}` }, texts.map((t, i) => chunk(t, i)));
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ce-vec-"));
  store = openIndexStore(join(dir, "index.db"));
  cache = openEmbCache(join(dir, "emb.db"));
  progress = [];
  ctx = {
    root: dir,
    indexDir: dir,
    store,
    settings: { pauseOnBattery: false } as EffectiveSettings,
    chunkOptions: DEFAULT_CHUNK_OPTIONS,
    onProgress: (p) => progress.push(p),
    onError: () => {},
  };
});
afterEach(() => {
  vi.mocked(power.isOnBattery).mockResolvedValue(false);
  store.close();
  cache.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("vector phase", () => {
  it("embeds everything, sets dims, dedups by chunk_hash", async () => {
    addFile("a.ts", ["one", "two", "one"]);
    addFile("b.ts", ["one", "three"]);
    const emb = new FakeEmbedder({ dims: 16 });
    const spy = vi.spyOn(emb, "embedDocuments");
    const phase = createVectorPhase({ ctx, embCache: cache, embedder: emb });
    phase.start();
    await phase.whenIdle();
    expect(store.dims).toBe(16);
    expect(store.counts()).toMatchObject({ chunks: 5, embedded: 5 });
    const texts = spy.mock.calls.flatMap((c) => c[0]);
    expect(texts).toHaveLength(3);
    expect(cache.count(emb.info.modelId)).toBe(3);
    expect(progress.at(-1)?.phase).toBe("idle");
    await phase.stop();
  });

  it("uses emb cache without inference after dims change", async () => {
    addFile("a.ts", ["one", "two"]);
    const emb = new FakeEmbedder({ dims: 8 });
    let phase = createVectorPhase({ ctx, embCache: cache, embedder: emb });
    phase.start();
    await phase.whenIdle();
    await phase.stop();
    store.setVectorDims(8);
    expect(store.counts().embedded).toBe(0);
    const spy = vi.spyOn(emb, "embedDocuments");
    phase = createVectorPhase({ ctx, embCache: cache, embedder: emb });
    phase.start();
    await phase.whenIdle();
    expect(spy).not.toHaveBeenCalled();
    expect(store.counts().embedded).toBe(2);
    await phase.stop();
  });

  it("resizes index to embedder dims", async () => {
    store.setVectorDims(4);
    addFile("a.ts", ["one"]);
    const phase = createVectorPhase({ ctx, embCache: cache, embedder: new FakeEmbedder({ dims: 12 }) });
    phase.start();
    await phase.whenIdle();
    expect(store.dims).toBe(12);
    expect(store.counts().embedded).toBe(1);
    await phase.stop();
  });

  it("batches by batchSize and commits every commitEvery batches", async () => {
    addFile("a.ts", Array.from({ length: 10 }, (_, i) => `t${i}`));
    const setEmb = vi.spyOn(store, "setEmbeddings");
    const emb = new FakeEmbedder({ dims: 8 });
    const spy = vi.spyOn(emb, "embedDocuments");
    const phase = createVectorPhase({ ctx, embCache: cache, embedder: emb, batchSize: 2, commitEvery: 2 });
    phase.start();
    await phase.whenIdle();
    expect(spy.mock.calls.map((c) => c[0].length)).toEqual([2, 2, 2, 2, 2]);
    expect(setEmb.mock.calls.map((c) => c[0].length)).toEqual([4, 4, 2]);
    expect(store.getVectors([1])).toBeTruthy();
    await phase.stop();
  });

  it("orders opened files first, then shallow paths", async () => {
    addFile("x/y/deep.ts", ["deep"]);
    addFile("top.ts", ["top"]);
    addFile("x/mid.ts", ["mid"]);
    const emb = new FakeEmbedder({ dims: 8 });
    const spy = vi.spyOn(emb, "embedDocuments");
    const phase = createVectorPhase({ ctx, embCache: cache, embedder: emb, batchSize: 1 });
    phase.prioritize([join(dir, "x/y/deep.ts")]);
    phase.start();
    await phase.whenIdle();
    const order = spy.mock.calls.map((c) => c[0][0]!.match(/path: (.*)/)![1]);
    expect(order).toEqual(["x/y/deep.ts", "top.ts", "x/mid.ts"]);
    await phase.stop();
  });

  it("waits for the provider and keeps progress", async () => {
    addFile("a.ts", ["one", "two", "three", "four"]);
    const emb = new FakeEmbedder({ dims: 8 });
    const real = emb.embedDocuments.bind(emb);
    let calls = 0;
    vi.spyOn(emb, "embedDocuments").mockImplementation(async (t, s) => {
      calls++;
      if (calls === 2) throw new ProviderUnavailableError("down", 20);
      return real(t, s);
    });
    const errors: string[] = [];
    ctx.onError = (e) => errors.push(e.message);
    const states: string[] = [];
    const phase = createVectorPhase({ ctx, embCache: cache, embedder: emb, batchSize: 2 });
    phase.start();
    states.push(phase.state);
    while (errors.length === 0) await new Promise((r) => setTimeout(r, 2));
    expect(phase.state).toBe("waiting-provider");
    expect(store.counts().embedded).toBe(2);
    await phase.whenIdle();
    expect(store.counts().embedded).toBe(4);
    expect(errors).toHaveLength(1);
    await phase.stop();
  });

  it("pauses and resumes", async () => {
    addFile("a.ts", ["one", "two"]);
    const emb = new FakeEmbedder({ dims: 8 });
    const spy = vi.spyOn(emb, "embedDocuments");
    const phase = createVectorPhase({ ctx, embCache: cache, embedder: emb });
    phase.pause();
    phase.start();
    await new Promise((r) => setTimeout(r, 30));
    expect(phase.state).toBe("paused");
    expect(spy).not.toHaveBeenCalled();
    phase.resume();
    await phase.whenIdle();
    expect(store.counts().embedded).toBe(2);
    expect(phase.state).toBe("idle");
    await phase.stop();
  });

  it("waits on battery when pauseOnBattery is set", async () => {
    addFile("a.ts", ["one"]);
    ctx.settings = { pauseOnBattery: true } as EffectiveSettings;
    vi.mocked(power.isOnBattery).mockResolvedValue(true);
    const phase = createVectorPhase({ ctx, embCache: cache, embedder: new FakeEmbedder({ dims: 8 }) });
    phase.start();
    await new Promise((r) => setTimeout(r, 30));
    expect(phase.state).toBe("paused");
    expect(store.counts().embedded).toBe(0);
    await phase.stop();
  });

  it("notifyChanged queues new chunks after idle", async () => {
    addFile("a.ts", ["one"]);
    const phase = createVectorPhase({ ctx, embCache: cache, embedder: new FakeEmbedder({ dims: 8 }) });
    phase.start();
    await phase.whenIdle();
    addFile("b.ts", ["two"]);
    phase.notifyChanged([join(dir, "b.ts")]);
    await phase.whenIdle();
    expect(store.counts().embedded).toBe(2);
    await phase.stop();
  });
});
