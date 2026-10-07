import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openEmbCache } from "../cache/embcache";
import type { EmbCache } from "../cache/types";
import { FakeEmbedder } from "../embed/fake";
import { tokenizeForFts } from "../lex/tokenize";
import { quantizeInt8 } from "../store/quantize";
import { openIndexStore } from "../store/sqlite";
import type { IndexStore } from "../store/types";
import { findSimilar } from "./similar";
import type { SearchContext } from "./types";

const DIMS = 64;
let dir: string;
let store: IndexStore;
let cache: EmbCache;
let embedder: FakeEmbedder;
let embedCalls: string[][];

interface Doc {
  path: string;
  lang: string;
  start: number;
  text: string;
}

const DOCS: Doc[] = [
  { path: "src/refund.ts", lang: "typescript", start: 1, text: "function processPaymentRefund(order) {\n  return gateway.refund(order.amount);\n}" },
  { path: "src/refund.ts", lang: "typescript", start: 4, text: "function cancelPaymentRefund(order) {\n  return gateway.cancel(order.amount);\n}" },
  { path: "src/refund2.ts", lang: "typescript", start: 1, text: "function processPaymentRefundCopy(order) {\n  return gateway.refund(order.amount);\n}" },
  { path: "src/parse.py", lang: "python", start: 1, text: "def parse_config(path):\n    return load(path)\n" },
];

async function build(vectors = true, cacheVectors = true) {
  const byPath = new Map<string, Doc[]>();
  for (const d of DOCS) byPath.set(d.path, [...(byPath.get(d.path) ?? []), d]);
  let n = 0;
  for (const [path, docs] of byPath) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    const lines: string[] = [];
    for (const d of docs) d.text.split("\n").forEach((l, i) => (lines[d.start - 1 + i] = l));
    writeFileSync(join(dir, path), lines.map((l) => l ?? "").join("\n"));
    store.upsertFile(
      { path, lang: docs[0]!.lang, size: 1, mtime: 1, contentHash: `c${n}` },
      docs.map((d) => ({
        startLine: d.start,
        endLine: d.start + d.text.split("\n").length - 1,
        startByte: 0,
        endByte: d.text.length,
        kind: "function",
        symbol: null,
        parentSymbol: null,
        chunkHash: `h${n++}`,
        text: d.text,
        fts: { text: tokenizeForFts(d.text), symbol: "", path: tokenizeForFts(path) },
      })),
    );
  }
  if (!vectors) return;
  store.setVectorDims(DIMS);
  const vecs = await embedder.embedDocuments(DOCS.map((d) => d.text));
  const chunks = store.getChunks(DOCS.map((_, i) => i + 1));
  store.setEmbeddings(chunks.map((c, i) => ({ chunkId: c.id, vector: quantizeInt8(vecs[i]!) })));
  if (cacheVectors) cache.put(embedder.info.modelId, chunks.map((c, i) => ({ chunkHash: c.chunkHash, vector: vecs[i]! })));
  embedCalls.length = 0;
}

function ctx(over: Partial<SearchContext> = {}) {
  return {
    store,
    embCache: cache,
    embedder,
    modelId: embedder.info.modelId,
    vectorsReady: () => ({ ratio: 1, ready: true }),
    root: dir,
    ...over,
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ce-similar-"));
  store = openIndexStore(join(dir, "index.db"));
  cache = openEmbCache(join(dir, "emb.db"));
  embedder = new FakeEmbedder({ dims: DIMS });
  embedCalls = [];
  const orig = embedder.embedDocuments.bind(embedder);
  embedder.embedDocuments = (texts, signal) => {
    embedCalls.push(texts);
    return orig(texts, signal);
  };
});
afterEach(() => {
  store.close();
  cache.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("findSimilar", () => {
  it("reuses stored vector when range matches a chunk and excludes overlapping chunks", async () => {
    await build();
    const r = await findSimilar(ctx(), { path: "src/refund.ts", range: { startLine: 1, endLine: 3 } });
    expect(embedCalls).toEqual([]);
    expect(r.partial).toBe(false);
    expect(r.results[0]!.path).toBe("src/refund2.ts");
    expect(r.results[0]!.score).toBe(1);
    expect(r.results.every((x) => x.sources.join() === "semantic")).toBe(true);
    expect(r.results.some((x) => x.path === "src/refund.ts" && x.range.startLine === 1)).toBe(false);
    expect(r.results.some((x) => x.path === "src/refund.ts" && x.range.startLine === 4)).toBe(true);
  });

  it("falls back to int8 vector without emb cache", async () => {
    await build(true, false);
    const r = await findSimilar(ctx({ embCache: null }), { path: "src/refund.ts", range: { startLine: 1, endLine: 3 } });
    expect(embedCalls).toEqual([]);
    expect(r.results[0]!.path).toBe("src/refund2.ts");
  });

  it("embeds a fragment as a document with header when range matches no chunk", async () => {
    await build();
    const r = await findSimilar(ctx(), { path: "src/refund.ts", range: { startLine: 2, endLine: 2 } });
    expect(embedCalls).toHaveLength(1);
    expect(embedCalls[0]![0]).toContain("path: src/refund.ts");
    expect(embedCalls[0]![0]).toContain("gateway.refund");
    expect(r.results.some((x) => x.path === "src/refund.ts" && x.range.startLine === 1)).toBe(false);
  });

  it("embeds code as a document", async () => {
    await build();
    const r = await findSimilar(ctx(), { code: "def parse_config(path): return load(path)", lang: "python" });
    expect(embedCalls).toHaveLength(1);
    expect(embedCalls[0]![0]).toContain("lang: python");
    expect(r.results[0]!.path).toBe("src/parse.py");
  });

  it("normalizes lang aliases", async () => {
    await build();
    const r = await findSimilar(ctx(), { code: "def parse_config(path): return load(path)", lang: "py" });
    expect(embedCalls[0]![0]).toContain("lang: python");
    expect(r.results.map((x) => x.path)).toEqual(["src/parse.py"]);
    const code = "function processPaymentRefund(order) { return gateway.refund(order.amount); }";
    for (const alias of ["ts", "TS"]) {
      const ts = await findSimilar(ctx(), { code, lang: alias });
      expect(ts.results.length).toBeGreaterThan(0);
      expect(ts.results.every((x) => x.lang === "typescript")).toBe(true);
    }
    const lex = await findSimilar(ctx({ embedder: undefined }), { code, lang: "ts" });
    expect(lex.results.length).toBeGreaterThan(0);
    expect(lex.results.every((x) => x.lang === "typescript")).toBe(true);
  });

  it("applies top, filters and threshold", async () => {
    await build();
    const code = "function processPaymentRefund(order) { return gateway.refund(order.amount); }";
    expect((await findSimilar(ctx(), { code, top: 1 })).results).toHaveLength(1);
    expect((await findSimilar(ctx(), { code })).results.length).toBe(4);
    const py = await findSimilar(ctx(), { code, lang: "python" });
    expect(py.results.map((x) => x.path)).toEqual(["src/parse.py"]);
    const ex = await findSimilar(ctx(), { code, exclude: ["src/refund*.ts"] });
    expect(ex.results.map((x) => x.path)).toEqual(["src/parse.py"]);
    const th = await findSimilar(ctx(), { code, threshold: 0.99 } as Parameters<typeof findSimilar>[1]);
    expect(th.results.every((x) => x.score >= 0.99)).toBe(true);
    expect(th.results.length).toBeLessThan(4);
  });

  it("falls back to lexical search with partial when vectors are not ready", async () => {
    await build(false);
    const r = await findSimilar(ctx({ vectorsReady: () => ({ ratio: 0, ready: false }) }), {
      path: "src/refund.ts",
      range: { startLine: 1, endLine: 3 },
    });
    expect(r.partial).toBe(true);
    expect(r.partialReason).toBeTruthy();
    expect(r.results[0]!.path).toBe("src/refund2.ts");
    expect(r.results[0]!.sources).toEqual(["lexical"]);
    expect(r.results.some((x) => x.path === "src/refund.ts" && x.range.startLine === 1)).toBe(false);
  });
});
