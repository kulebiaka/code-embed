import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_CHUNK_OPTIONS } from "../chunk/types";
import { FakeEmbedder } from "../embed/fake";
import { tokenizeForFts } from "../lex/tokenize";
import { quantizeInt8 } from "../store/quantize";
import { openIndexStore } from "../store/sqlite";
import type { ChunkInput, IndexStore, RefInput } from "../store/types";
import { buildContext, type ContextEnv } from "./context";

const DIMS = 64;
let dir: string;
let store: IndexStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ce-context-"));
  store = openIndexStore(join(dir, "index.db"));
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const call = (name: string, line: number): RefInput => ({ name, kind: "call", line, module: null });

let seq = 0;
function chunk(over: Partial<ChunkInput> & { text: string }): ChunkInput {
  const startLine = over.startLine ?? 1;
  const symbol = over.symbol ?? null;
  return {
    startLine,
    endLine: startLine + over.text.split("\n").length - 1,
    startByte: 0,
    endByte: over.text.length,
    kind: "function",
    symbol,
    parentSymbol: null,
    chunkHash: `h${seq++}`,
    fts: { text: tokenizeForFts(over.text), symbol: symbol ? tokenizeForFts(symbol) : "", path: "" },
    ...over,
  };
}

function add(path: string, lang: string, chunks: ChunkInput[]): number[] {
  return store.upsertFile({ path, lang, size: 1, mtime: 1, contentHash: path }, chunks).chunkIds;
}

function env(over: Partial<ContextEnv> = {}): ContextEnv {
  return {
    store,
    embCache: null,
    embedder: null,
    modelId: null,
    vectorsReady: () => ({ ratio: 0, ready: false }),
    root: dir,
    ...over,
  };
}

const tokens = (s: string) => DEFAULT_CHUNK_OPTIONS.countTokens(s);

function seedGraph(callerCount = 7) {
  add("src/target.ts", "typescript", [chunk({ symbol: "refund", text: "function refund(o) {\n  return o.amount;\n}" })]);
  for (let i = 0; i < callerCount; i++) {
    add(`src/c${i}.ts`, "typescript", [
      chunk({ symbol: `caller${i}`, text: `function caller${i}() {\n  return refund(${i});\n}`, refs: [call("refund", 2)] }),
    ]);
  }
}

describe("buildContext target", () => {
  it("picks the narrowest chunk containing the line, the first among equals", () => {
    add("src/big.ts", "typescript", [
      chunk({ symbol: "Big", kind: "class", text: "class Big {\n  a() {}\n  b() {}\n}", startByte: 0, endByte: 100 }),
      chunk({ symbol: "a", parentSymbol: "Big", text: "  a() {}", startLine: 2, startByte: 12, endByte: 20 }),
      chunk({ symbol: "a2", parentSymbol: "Big", text: "  a() {}", startLine: 2, startByte: 40, endByte: 48 }),
      chunk({ symbol: "b", parentSymbol: "Big", text: "  b() {}", startLine: 3, startByte: 50, endByte: 58 }),
    ]);
    return Promise.all([
      buildContext(env(), { path: "src/big.ts", line: 2 }),
      buildContext(env(), { path: "src/big.ts", line: 1 }),
      buildContext(env(), { path: "src/big.ts", line: 3 }),
    ]).then(([method, cls, other]) => {
      expect(method.chunks[0]!.symbol).toBe("a");
      expect(cls.chunks[0]!.symbol).toBe("Big");
      expect(other.chunks[0]!.symbol).toBe("b");
    });
  });

  it("uses the first search result for a query", async () => {
    add("src/a.ts", "typescript", [chunk({ symbol: "zebraStripe", text: "function zebraStripe() {}" })]);
    add("src/b.ts", "typescript", [chunk({ symbol: "other", text: "function other() {}" })]);
    const r = await buildContext(env(), { query: "zebraStripe" });
    expect(r.chunks[0]).toMatchObject({ level: "target", path: "src/a.ts", symbol: "zebraStripe" });
  });

  it("returns an empty partial package without a target", async () => {
    const r = await buildContext(env(), { path: "nope.ts", line: 1 });
    expect(r.chunks).toEqual([]);
    expect(r.partial).toBe(true);
    expect(r.partialReason).toBeTruthy();
  });
});

describe("buildContext budget", () => {
  it("defaults to 4000 and adds up to 5 call callers after the target", async () => {
    seedGraph();
    const r = await buildContext(env(), { path: "src/target.ts", line: 1 });
    expect(r.budgetTokens).toBe(4000);
    expect(r.chunks.map((c) => c.level)).toEqual(["target", "caller", "caller", "caller", "caller", "caller"]);
    expect(r.chunks.slice(1).every((c) => c.confidence === "low")).toBe(true);
    expect(r.usedTokens).toBe(r.chunks.reduce((n, c) => n + c.tokens, 0));
  });

  it("keeps only chunks that fit the budget and lists the cut level", async () => {
    seedGraph();
    const t = tokens("function refund(o) {\n  return o.amount;\n}");
    const c = tokens("function caller0() {\n  return refund(0);\n}");
    const r = await buildContext(env(), { path: "src/target.ts", line: 1, budgetTokens: t + 2 * c });
    expect(r.chunks.filter((x) => x.level === "caller")).toHaveLength(2);
    expect(r.usedTokens).toBeLessThanOrEqual(t + 2 * c);
    expect(r.omitted).toContain("caller");
  });

  it("returns only the target when it alone exceeds the budget", async () => {
    seedGraph();
    const r = await buildContext(env({ vectorsReady: () => ({ ratio: 1, ready: true }) }), {
      path: "src/target.ts",
      line: 1,
      budgetTokens: 1,
    });
    expect(r.chunks).toHaveLength(1);
    expect(r.chunks[0]!.level).toBe("target");
    expect(r.usedTokens).toBe(r.chunks[0]!.tokens);
    expect(r.usedTokens).toBeGreaterThan(1);
    expect(r.omitted).toEqual(expect.arrayContaining(["caller", "similar"]));
  });

  it("returns method chunks as callers inside a large class", async () => {
    add("src/t.ts", "typescript", [chunk({ symbol: "refund", text: "function refund() {}" })]);
    add("src/svc.ts", "typescript", [
      chunk({ symbol: "Svc", kind: "class", text: "class Svc {\n  run() {\n    refund();\n  }\n}", startByte: 0, endByte: 100 }),
      chunk({ symbol: "run", parentSymbol: "Svc", text: "  run() {\n    refund();\n  }", startLine: 2, startByte: 12, endByte: 40, refs: [call("refund", 3)] }),
    ]);
    const r = await buildContext(env(), { path: "src/t.ts", line: 1 });
    expect(r.chunks.map((c) => c.symbol)).toEqual(["refund", "run"]);
  });

  it("ignores non-call usages", async () => {
    add("src/t.ts", "typescript", [chunk({ symbol: "refund", text: "function refund() {}" })]);
    add("src/u.ts", "typescript", [
      chunk({ symbol: "typed", text: "let x: refund;", refs: [{ name: "refund", kind: "type", line: 1, module: null }] }),
    ]);
    const r = await buildContext(env(), { path: "src/t.ts", line: 1 });
    expect(r.chunks).toHaveLength(1);
  });
});

describe("buildContext similar", () => {
  async function seedVectors() {
    const embedder = new FakeEmbedder({ dims: DIMS });
    const ids: number[] = [];
    const texts: string[] = [];
    for (let i = 0; i < 6; i++) {
      const text = `function processPaymentRefund${i}(order) {\n  return gateway.refund(order.amount);\n}`;
      texts.push(text);
      ids.push(...add(`src/s${i}.ts`, "typescript", [chunk({ symbol: `processPaymentRefund${i}`, text })]));
    }
    store.setVectorDims(DIMS);
    const vecs = await embedder.embedDocuments(texts);
    store.setEmbeddings(ids.map((chunkId, i) => ({ chunkId, vector: quantizeInt8(vecs[i]!) })));
    return embedder;
  }

  it("adds up to 3 similar chunks when vectors are ready", async () => {
    const embedder = await seedVectors();
    const r = await buildContext(
      env({ embedder, modelId: embedder.info.modelId, vectorsReady: () => ({ ratio: 1, ready: true }) }),
      { path: "src/s0.ts", line: 1 },
    );
    const similar = r.chunks.filter((c) => c.level === "similar");
    expect(similar).toHaveLength(3);
    expect(r.chunks[0]!.path).toBe("src/s0.ts");
    expect(similar.every((c) => c.path !== "src/s0.ts")).toBe(true);
    expect(r.partial).toBe(false);
  });

  it("builds without similar and without error when vectors are not ready", async () => {
    await seedVectors();
    const r = await buildContext(env(), { path: "src/s0.ts", line: 1 });
    expect(r.chunks.map((c) => c.level)).toEqual(["target"]);
    expect(r.partial).toBe(true);
    expect(r.partialReason).toMatch(/vectors/);
  });
});

describe("buildContext language without graph", () => {
  it("returns target and up to 10 lexical results by symbol name", async () => {
    add("lib/main.rb", "ruby", [chunk({ symbol: "settle_invoice", text: "def settle_invoice\n  1\nend" })]);
    for (let i = 0; i < 14; i++) {
      add(`lib/u${i}.rb`, "ruby", [chunk({ symbol: `use${i}`, text: `def use${i}\n  settle_invoice\nend` })]);
    }
    const r = await buildContext(env(), { path: "lib/main.rb", line: 1 });
    expect(r.chunks[0]!.level).toBe("target");
    const lexical = r.chunks.filter((c) => c.level === "lexical");
    expect(lexical).toHaveLength(10);
    expect(r.chunks.every((c) => c.level === "target" || c.level === "lexical")).toBe(true);
    expect(new Set(r.chunks.map((c) => c.path)).size).toBe(r.chunks.length);
  });
});
