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
import { createVectorPhase as createPhase } from "./vector";
import type { VectorPhaseDeps } from "./vector";

vi.mock("./power", () => ({ isOnBattery: vi.fn(async () => false) }));

let dir: string;
let store: IndexStore;
let cache: EmbCache;
let progress: { phase: string; embedded: number }[];
let ctx: IndexerContext;
let phases: ReturnType<typeof createPhase>[];

function createVectorPhase(deps: VectorPhaseDeps) {
  const phase = createPhase(deps);
  phases.push(phase);
  return phase;
}

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
  phases = [];
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
afterEach(async () => {
  vi.mocked(power.isOnBattery).mockResolvedValue(false);
  await Promise.all(phases.map((p) => p.stop()));
  store.close();
  cache.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("vector phase", () => {
  it("passes the stored signature into the embedding header", async () => {
    store.upsertFile(
      { path: "a.ts", lang: "ts", size: 1, mtime: 1, contentHash: "c" },
      [
        { ...chunk("first piece", 0), signature: "function bigFn(a: number)" },
        { ...chunk("second piece", 1), signature: "function bigFn(a: number)" },
      ],
    );
    const emb = new FakeEmbedder({ dims: 8 });
    const spy = vi.spyOn(emb, "embedDocuments");
    const phase = createVectorPhase({ ctx, embCache: cache, embedder: emb });
    phase.start();
    await phase.whenIdle();
    const texts = spy.mock.calls.flatMap((c) => c[0]);
    const second = texts.find((t) => t.includes("second piece"))!;
    expect(second).toContain("signature: function bigFn(a: number)");
    await phase.stop();
  });

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
    const snapshots: { state: string; embedded: number }[] = [];
    ctx.onError = (e) => {
      errors.push(e.message);
      snapshots.push({ state: phase.state, embedded: store.counts().embedded });
    };
    const phase = createVectorPhase({ ctx, embCache: cache, embedder: emb, batchSize: 2 });
    phase.start();
    await phase.whenIdle();
    expect(snapshots).toEqual([{ state: "waiting-provider", embedded: 2 }]);
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
    await vi.waitFor(() => expect(progress.some((p) => p.phase === "paused")).toBe(true));
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
    await vi.waitFor(() => expect(phase.state).toBe("paused"));
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

  it("re-kicks the loop after a run that finished without awaiting", async () => {
    addFile("a.ts", ["one"]);
    const phase = createVectorPhase({ ctx, embCache: cache, embedder: new FakeEmbedder({ dims: 8 }) });
    phase.start();
    await phase.whenIdle();
    phase.notifyChanged([join(dir, "b.ts")]);
    await phase.whenIdle();
    addFile("b.ts", ["two"]);
    phase.notifyChanged([join(dir, "b.ts")]);
    await phase.whenIdle();
    expect(store.counts().embedded).toBe(2);
    await phase.stop();
  });

  it("stop is idempotent, safe before start, and final", async () => {
    addFile("a.ts", ["one"]);
    const phase = createVectorPhase({ ctx, embCache: cache, embedder: new FakeEmbedder({ dims: 8 }) });
    await phase.stop();
    await phase.stop();
    phase.start();
    phase.notifyChanged([join(dir, "a.ts")]);
    phase.prioritize([join(dir, "a.ts")]);
    phase.resume();
    await phase.whenIdle();
    expect(phase.state).toBe("idle");
    expect(store.counts().embedded).toBe(0);
  });

  it("stop while waiting for isOnBattery does not touch the store afterwards", async () => {
    addFile("a.ts", ["one"]);
    ctx.settings = { pauseOnBattery: true } as EffectiveSettings;
    let release!: (v: boolean) => void;
    vi.mocked(power.isOnBattery).mockReturnValue(new Promise<boolean>((r) => (release = r)));
    const onProgress = vi.fn();
    ctx.onProgress = onProgress;
    const counts = vi.spyOn(store, "counts");
    const phase = createVectorPhase({ ctx, embCache: cache, embedder: new FakeEmbedder({ dims: 8 }) });
    phase.start();
    await vi.waitFor(() => expect(power.isOnBattery).toHaveBeenCalled());
    const started = Date.now();
    const stopping = phase.stop();
    release(true);
    await stopping;
    expect(Date.now() - started).toBeLessThan(5000);
    counts.mockClear();
    onProgress.mockClear();
    await new Promise((r) => setImmediate(r));
    expect(counts).not.toHaveBeenCalled();
    expect(onProgress).not.toHaveBeenCalled();
    expect(phase.state).toBe("idle");
  });

  it("stop during waiting-provider returns without waiting for backoff and keeps progress", async () => {
    addFile("a.ts", ["one", "two", "three", "four"]);
    const emb = new FakeEmbedder({ dims: 8 });
    const real = emb.embedDocuments.bind(emb);
    let calls = 0;
    vi.spyOn(emb, "embedDocuments").mockImplementation(async (t, s) => {
      if (++calls === 2) throw new ProviderUnavailableError("down", 60_000);
      return real(t, s);
    });
    const errors: string[] = [];
    ctx.onError = (e) => errors.push(e.message);
    const phase = createVectorPhase({ ctx, embCache: cache, embedder: emb, batchSize: 2 });
    phase.start();
    await vi.waitFor(() => expect(errors).toHaveLength(1));
    expect(phase.state).toBe("waiting-provider");
    const started = Date.now();
    await phase.stop();
    expect(Date.now() - started).toBeLessThan(5000);
    expect(store.counts().embedded).toBe(2);
  });
});
