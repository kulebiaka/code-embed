import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openEmbCache } from "../cache/embcache";
import type { EmbCache } from "../cache/types";
import { FakeEmbedder } from "../embed/fake";
import { quantizeInt8 } from "../store/quantize";
import { openIndexStore } from "../store/sqlite";
import type { IndexStore } from "../store/types";
import type { SearchContext } from "./types";
import { vectorCandidates } from "./vector";

let dir: string;
let store: IndexStore;
let cache: EmbCache;
const embedder = new FakeEmbedder({ dims: 64 });
const texts = ["parse config file", "refund payment order", "http server main", "parse config values"];
let ctx: SearchContext;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "ce-vec-"));
  store = openIndexStore(join(dir, "index.db"));
  cache = openEmbCache(join(dir, "emb.db"));
  store.setVectorDims(64);
  const vecs = await embedder.embedDocuments(texts);
  const ids: number[] = [];
  texts.forEach((text, i) => {
    const path = `${i < 2 ? "a" : "b"}/f${i}.ts`;
    const { chunkIds } = store.upsertFile(
      { path, lang: "typescript", size: 1, mtime: 1, contentHash: `c${i}` },
      [{ startLine: 1, endLine: 1, startByte: 0, endByte: 5, kind: "function", symbol: null, parentSymbol: null, chunkHash: `h${i}`, text, fts: { text, symbol: "", path } }],
    );
    ids.push(chunkIds[0]!);
  });
  store.setEmbeddings(ids.map((chunkId, i) => ({ chunkId, vector: quantizeInt8(vecs[i]!) })));
  cache.put(embedder.info.modelId, texts.map((_, i) => ({ chunkHash: `h${i}`, vector: vecs[i]! })));
  ctx = { store, embCache: cache, embedder, modelId: embedder.info.modelId, vectorsReady: () => ({ ratio: 1, ready: true }) };
});
afterEach(() => {
  store.close();
  cache.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("vectorCandidates", () => {
  it("returns cosine-ranked candidates", async () => {
    const [q] = await embedder.embedQueries(["parse config"]);
    const out = await vectorCandidates(ctx, q!, 200, () => true);
    expect(out).toHaveLength(4);
    const top = store.getChunks([out[0]!.id])[0]!;
    expect(top.text).toMatch(/^parse config/);
    expect(out[0]!.score).toBeGreaterThan(out[3]!.score);
    for (let i = 1; i < out.length; i++) expect(out[i - 1]!.score).toBeGreaterThanOrEqual(out[i]!.score);
  });
  it("applies filter and falls back to int8 when cache misses", async () => {
    const [q] = await embedder.embedQueries(["parse config"]);
    const out = await vectorCandidates({ ...ctx, embCache: null }, q!, 1, (p) => p.startsWith("b/"));
    expect(out).toHaveLength(1);
    expect(store.getChunks([out[0]!.id])[0]!.path.startsWith("b/")).toBe(true);
  });
  it("throws on aborted signal", async () => {
    const ac = new AbortController();
    ac.abort(new Error("stop"));
    const [q] = await embedder.embedQueries(["x"]);
    await expect(vectorCandidates(ctx, q!, 5, () => true, ac.signal)).rejects.toThrow("stop");
  });
});
