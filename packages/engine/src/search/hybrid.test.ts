import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openEmbCache } from "../cache/embcache";
import type { EmbCache } from "../cache/types";
import { ProviderUnavailableError } from "../errors";
import { FakeEmbedder } from "../embed/fake";
import type { Embedder } from "../embed/types";
import { tokenizeForFts } from "../lex/tokenize";
import { quantizeInt8 } from "../store/quantize";
import { openIndexStore } from "../store/sqlite";
import type { IndexStore } from "../store/types";
import { search } from "./hybrid";
import type { SearchContext } from "./types";

const DIMS = 64;
let dir: string;
let store: IndexStore;
let cache: EmbCache;
let embedder: FakeEmbedder;

interface Doc {
  path: string;
  lang: string;
  symbol: string;
  text: string;
}

const DOCS: Doc[] = [
  { path: "src/payment/refund.ts", lang: "typescript", symbol: "processPaymentRefund", text: "function processPaymentRefund(order) {\n  return gateway.refund(order.amount);\n}" },
  { path: "src/payment/charge.ts", lang: "typescript", symbol: "chargeCard", text: "function chargeCard(card) {\n  // mentions processPaymentRefund in a comment\n  return gateway.charge(card);\n}" },
  { path: "src/utils/parse_config.py", lang: "python", symbol: "parse_config", text: "def parse_config(path):\n    return load(path)" },
  { path: "docs/guide.md", lang: "markdown", symbol: "", text: "возврат платежа выполняется через сервис оплаты" },
  { path: "cmd/server/main.go", lang: "go", symbol: "main", text: "func main() {\n  serve http requests\n}" },
];

async function build(embed: { vectors: boolean; cacheVectors?: boolean } = { vectors: true, cacheVectors: true }) {
  DOCS.forEach((d, i) => {
    store.upsertFile(
      { path: d.path, lang: d.lang, size: 1, mtime: 1, contentHash: `c${i}` },
      [
        {
          startLine: 1,
          endLine: 3,
          startByte: 0,
          endByte: d.text.length,
          kind: "function",
          symbol: d.symbol || null,
          parentSymbol: null,
          chunkHash: `h${i}`,
          text: d.text,
          fts: { text: tokenizeForFts(d.text), symbol: tokenizeForFts(d.symbol), path: tokenizeForFts(d.path) },
        },
      ],
    );
  });
  if (!embed.vectors) return;
  store.setVectorDims(DIMS);
  const vecs = await embedder.embedDocuments(DOCS.map((d) => d.text));
  const chunks = store.getChunks(DOCS.map((_, i) => i + 1));
  store.setEmbeddings(chunks.map((c, i) => ({ chunkId: c.id, vector: quantizeInt8(vecs[i]!) })));
  if (embed.cacheVectors) cache.put(embedder.info.modelId, chunks.map((c, i) => ({ chunkHash: c.chunkHash, vector: vecs[i]! })));
}

function ctx(over: Partial<SearchContext> = {}): SearchContext {
  return {
    store,
    embCache: cache,
    embedder,
    modelId: embedder.info.modelId,
    vectorsReady: () => ({ ratio: 1, ready: true }),
    ...over,
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ce-hybrid-"));
  store = openIndexStore(join(dir, "index.db"));
  cache = openEmbCache(join(dir, "emb.db"));
  embedder = new FakeEmbedder({ dims: DIMS });
});
afterEach(() => {
  vi.useRealTimers();
  store.close();
  cache.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("search", () => {
  describe("embedding timeout while indexing", () => {
    const slow = () => new FakeEmbedder({ dims: DIMS, latencyMs: 2000 });

    it.each(["hybrid", "semantic"] as const)("%s answers lexically with partial when the embedder is slower than the timeout", async (mode) => {
      await build();
      const t = performance.now();
      const r = await search(ctx({ embedder: slow(), embedTimeoutMs: 50 }), { query: "refund payment order", mode });
      expect(performance.now() - t).toBeLessThan(500);
      expect(r.partial).toBe(true);
      expect(r.partialReason).toBe("query embedding timed out within the 50 ms response budget while indexing; lexical results only");
      expect(r.results.length).toBeGreaterThan(0);
      expect(r.results.every((x) => x.sources.join() === "lexical")).toBe(true);
    });

    it("aborts the embedder signal, ignores a late vector and leaves no timers", async () => {
      await build();
      const real = new FakeEmbedder({ dims: DIMS });
      let seen: AbortSignal | undefined;
      let release!: () => void;
      const gate = new Promise<void>((res) => (release = res));
      const stubborn: Embedder = {
        info: real.info,
        init: () => real.init(),
        embedDocuments: (t, s) => real.embedDocuments(t, s),
        embedQueries: async (t) => {
          await gate;
          return real.embedQueries(t);
        },
        dispose: () => real.dispose(),
      } as Embedder;
      const spied = { ...stubborn, embedQueries: (t: string[], s?: AbortSignal) => ((seen = s), stubborn.embedQueries(t, s)) } as Embedder;
      const lateStore = vi.spyOn(store, "getVectors");
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const pending = search(ctx({ embedder: spied, embedTimeoutMs: 30 }), { query: "refund payment", mode: "hybrid" });
      await vi.advanceTimersByTimeAsync(30);
      const r = await pending;
      expect(r.partial).toBe(true);
      expect(seen?.aborted).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
      vi.useRealTimers();
      const calls = lateStore.mock.calls.length;
      release();
      await new Promise((res) => setTimeout(res, 20));
      expect(lateStore.mock.calls.length).toBe(calls);
      expect(r.results.every((x) => x.sources.join() === "lexical")).toBe(true);
    });

    describe("budget counts from request start", () => {
      const BUDGET = 400;
      const spin = (ms: number) => {
        const end = performance.now() + ms;
        while (performance.now() < end);
      };
      const slowAssembly = () => {
        const orig = store.getChunks.bind(store);
        vi.spyOn(store, "getChunks").mockImplementation((ids) => (spin(20), orig(ids)));
      };

      it.each(["hybrid", "semantic"] as const)("%s: an embedding near the budget never yields a late full response", async (mode) => {
        await build();
        slowAssembly();
        for (const latencyMs of [250, 340, 360, 390, 420]) {
          const t = performance.now();
          const r = await search(ctx({ embedder: new FakeEmbedder({ dims: DIMS, latencyMs }), embedTimeoutMs: BUDGET }), {
            query: "refund payment order",
            mode,
          });
          const ms = performance.now() - t;
          if (ms > BUDGET) expect(r.partialReason, `${latencyMs} ms embedding answered in ${ms} ms`).toMatch(/timed out/);
          if (latencyMs >= BUDGET) expect(r.partialReason).toMatch(/timed out/);
          if (latencyMs <= 250) expect(r.results[0]!.sources).toContain("semantic");
        }
      });

      it("an embedding that finishes just under the budget falls back to lexical", async () => {
        await build();
        slowAssembly();
        const t = performance.now();
        const r = await search(ctx({ embedder: new FakeEmbedder({ dims: DIMS, latencyMs: BUDGET - 10 }), embedTimeoutMs: BUDGET }), {
          query: "refund payment order",
        });
        expect(performance.now() - t).toBeLessThan(BUDGET);
        expect(r.partial).toBe(true);
        expect(r.partialReason).toMatch(/timed out/);
        expect(r.results.every((x) => x.sources.join() === "lexical")).toBe(true);
      });
    });

    it("without a timeout waits for a slow embedder and uses semantics", async () => {
      await build();
      const r = await search(ctx({ embedder: new FakeEmbedder({ dims: DIMS, latencyMs: 150 }) }), { query: "refund payment order" });
      expect(r.partial).toBe(false);
      expect(r.results[0]!.sources).toContain("semantic");
    });

    it("external abort rejects instead of returning partial", async () => {
      await build();
      const ac = new AbortController();
      const p = search(ctx({ embedder: slow(), embedTimeoutMs: 1000 }), { query: "refund" }, ac.signal);
      setTimeout(() => ac.abort(new Error("cancelled")), 20);
      await expect(p).rejects.toThrow("cancelled");
    });
  });

  it("hybrid finds results from both sources with normalized scores and snippets", async () => {
    await build();
    const r = await search(ctx(), { query: "refund payment order" });
    expect(r.partial).toBe(false);
    expect(r.results[0]!.path).toBe("src/payment/refund.ts");
    expect(r.results[0]!.score).toBe(1);
    expect(r.results[0]!.sources).toEqual(expect.arrayContaining(["lexical", "semantic"]));
    expect(r.results[0]!.range).toEqual({ startLine: 1, endLine: 3, startByte: 0, endByte: DOCS[0]!.text.length });
    expect(r.results[0]!.snippet.highlights.length).toBeGreaterThan(0);
    for (const x of r.results) expect(x.score).toBeGreaterThan(0), expect(x.score).toBeLessThanOrEqual(1);
  });

  it("ranks symbol match above text mention", async () => {
    await build({ vectors: false });
    const r = await search(ctx({ embedder: null }), { query: "processPaymentRefund", mode: "lexical" });
    expect(r.results.map((x) => x.path).slice(0, 2)).toEqual(["src/payment/refund.ts", "src/payment/charge.ts"]);
    expect(r.partial).toBe(false);
  });

  it("semantic mode returns only semantic sources", async () => {
    await build();
    const r = await search(ctx(), { query: "parse config path", mode: "semantic" });
    expect(r.results[0]!.path).toBe("src/utils/parse_config.py");
    expect(r.results.every((x) => x.sources.length === 1 && x.sources[0] === "semantic")).toBe(true);
  });

  it("works without emb cache using int8 vectors", async () => {
    await build({ vectors: true, cacheVectors: false });
    const r = await search(ctx({ embCache: null }), { query: "parse config path", mode: "semantic" });
    expect(r.results[0]!.path).toBe("src/utils/parse_config.py");
  });

  it("cyrillic query finds russian doc", async () => {
    await build();
    const r = await search(ctx(), { query: "возврат платежа" });
    expect(r.results[0]!.path).toBe("docs/guide.md");
  });

  it("falls back to lexical with partial when there is no embedder, dims or vectors", async () => {
    await build({ vectors: false });
    for (const c of [ctx({ embedder: null }), ctx(), ctx({ vectorsReady: () => ({ ratio: 0, ready: false }) })]) {
      const r = await search(c, { query: "parse_config" });
      expect(r.partial).toBe(true);
      expect(r.partialReason).toBeTruthy();
      expect(r.results[0]!.path).toBe("src/utils/parse_config.py");
      expect(r.results[0]!.sources).toEqual(["lexical"]);
    }
    const sem = await search(ctx({ embedder: null }), { query: "parse_config", mode: "semantic" });
    expect(sem.partial).toBe(true);
    expect(sem.results.length).toBeGreaterThan(0);
  });

  it("ProviderUnavailableError gives lexical results with reason", async () => {
    await build();
    const failing = new FakeEmbedder({ dims: DIMS, failWith: new ProviderUnavailableError("provider down") });
    for (const mode of ["hybrid", "semantic"] as const) {
      const r = await search(ctx({ embedder: failing }), { query: "parse_config", mode });
      expect(r.partial).toBe(true);
      expect(r.partialReason).toBe("provider down");
      expect(r.results[0]!.path).toBe("src/utils/parse_config.py");
    }
  });

  it("partial when vector coverage is incomplete but still uses vectors", async () => {
    await build();
    const r = await search(ctx({ vectorsReady: () => ({ ratio: 0.5, ready: false }) }), { query: "parse config path" });
    expect(r.partial).toBe(true);
    expect(r.results[0]!.sources).toContain("semantic");
  });

  it("applies filters, top and threshold", async () => {
    await build();
    const base = { query: "function gateway refund charge" };
    expect((await search(ctx(), { ...base, lang: "typescript" })).results.every((x) => x.lang === "typescript")).toBe(true);
    for (const mode of ["hybrid", "semantic", "lexical"] as const) {
      const ref = await search(ctx(), { ...base, mode, lang: "typescript" });
      expect(ref.results.length).toBeGreaterThan(0);
      for (const alias of ["ts", "TS", "TypeScript"]) {
        const r = await search(ctx(), { ...base, mode, lang: alias });
        expect(r.results.map((x) => x.path)).toEqual(ref.results.map((x) => x.path));
      }
    }
    expect((await search(ctx(), { ...base, pathPrefix: "src/payment/" })).results.every((x) => x.path.startsWith("src/payment/"))).toBe(true);
    const inc = await search(ctx(), { ...base, include: ["**/*.ts"], exclude: ["**/charge.ts"] });
    expect(inc.results.length).toBeGreaterThan(0);
    expect(inc.results.every((x) => x.path.endsWith(".ts") && !x.path.endsWith("charge.ts"))).toBe(true);
    expect((await search(ctx(), { ...base, top: 1 })).results).toHaveLength(1);
    const th = await search(ctx(), { ...base, threshold: 0.99 });
    expect(th.results.length).toBeGreaterThan(0);
    expect(th.results.every((x) => x.score >= 0.99)).toBe(true);
  });

  it("aborts via signal", async () => {
    await build();
    const ac = new AbortController();
    ac.abort(new Error("cancelled"));
    await expect(search(ctx(), { query: "refund" }, ac.signal)).rejects.toThrow("cancelled");
  });

  it("perf smoke: 20k chunks, dims 64, hybrid under 200ms", async () => {
    const N = 20000;
    store.setVectorDims(DIMS);
    const words = ["alpha", "beta", "gamma", "delta", "refund", "payment", "config", "parse", "server", "client", "cache", "index"];
    const rows: { chunkId: number; vector: Int8Array }[] = [];
    store.transaction(() => {
      for (let i = 0; i < N; i++) {
        const text = `${words[i % 12]} ${words[(i * 7) % 12]} item${i} ${words[(i * 5 + 3) % 12]}`;
        const { chunkIds } = store.upsertFile(
          { path: `f/${i}.ts`, lang: "typescript", size: 1, mtime: 1, contentHash: `p${i}` },
          [{ startLine: 1, endLine: 1, startByte: 0, endByte: text.length, kind: "function", symbol: null, parentSymbol: null, chunkHash: `ph${i}`, text, fts: { text, symbol: "", path: `f ${i} ts` } }],
        );
        const v = new Float32Array(DIMS);
        let s = 0;
        for (let d = 0; d < DIMS; d++) {
          v[d] = Math.sin(i * 12.9898 + d * 78.233);
          s += v[d]! * v[d]!;
        }
        for (let d = 0; d < DIMS; d++) v[d] = v[d]! / Math.sqrt(s);
        rows.push({ chunkId: chunkIds[0]!, vector: quantizeInt8(v) });
      }
      store.setEmbeddings(rows);
    });
    const c = ctx({ embCache: null });
    await search(c, { query: "refund payment" });
    const times: number[] = [];
    for (let i = 0; i < 5; i++) {
      const t = performance.now();
      const r = await search(c, { query: "refund payment" });
      times.push(performance.now() - t);
      expect(r.results.length).toBe(20);
    }
    times.sort((a, b) => a - b);
    expect(times[2]!).toBeLessThan(200);
  }, 120_000);
});
