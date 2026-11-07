import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
const typeRef = (name: string, line: number): RefInput => ({ name, kind: "type", line, module: null });

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

describe("buildContext callees", () => {
  const imp = (name: string, module: string): RefInput => ({ name, kind: "import", line: 1, module });

  it("lists only high-confidence callees as signature plus the first 5 lines", async () => {
    add("src/util.ts", "typescript", [
      chunk({
        symbol: "helper",
        signature: "function helper(a: number): number",
        text: "function helper(a: number): number {\n  1;\n  2;\n  3;\n  4;\n  5;\n  6;\n}",
      }),
    ]);
    add("src/other.ts", "typescript", [chunk({ symbol: "stranger", text: "function stranger() {}" })]);
    add("src/main.ts", "typescript", [
      chunk({
        symbol: "main",
        text: "function main() {\n  helper(1);\n  stranger();\n}",
        refs: [imp("helper", "./util"), call("helper", 2), call("stranger", 3)],
      }),
    ]);
    const r = await buildContext(env(), { path: "src/main.ts", line: 1 });
    const callees = r.chunks.filter((c) => c.level === "callee");
    expect(callees).toHaveLength(1);
    expect(callees[0]).toMatchObject({ symbol: "helper", confidence: "high" });
    expect(callees[0]!.text).toBe("function helper(a: number): number\nfunction helper(a: number): number {\n  1;\n  2;\n  3;\n  4;");
  });

  it("uses only the lines when the definition has no signature", async () => {
    add("src/main.ts", "typescript", [
      chunk({ symbol: "main", text: "function main() {\n  helper();\n}", refs: [call("helper", 2)] }),
      chunk({ symbol: "helper", startLine: 10, startByte: 100, endByte: 140, text: "function helper() {\n  a;\n  b;\n  c;\n  d;\n  e;\n}" }),
    ]);
    const r = await buildContext(env(), { path: "src/main.ts", line: 1 });
    const callee = r.chunks.find((c) => c.level === "callee");
    expect(callee!.text).toBe("function helper() {\n  a;\n  b;\n  c;\n  d;");
  });

  it("a method target sees calls from its body, a skeleton target only class-level refs", async () => {
    add("src/h.ts", "typescript", [
      chunk({ symbol: "inBody", text: "function inBody() {}" }),
      chunk({ symbol: "atClass", startLine: 5, startByte: 200, endByte: 230, text: "function atClass() {}" }),
    ]);
    add("src/svc.ts", "typescript", [
      chunk({
        symbol: "Svc",
        kind: "class",
        text: "class Svc {\n  run() {\n    inBody();\n  }\n}",
        startByte: 0,
        endByte: 100,
        refs: [imp("inBody", "./h"), imp("atClass", "./h"), call("atClass", 1)],
      }),
      chunk({
        symbol: "run",
        parentSymbol: "Svc",
        text: "  run() {\n    inBody();\n  }",
        startLine: 2,
        startByte: 12,
        endByte: 40,
        refs: [imp("inBody", "./h"), call("inBody", 3)],
      }),
    ]);
    const method = await buildContext(env(), { path: "src/svc.ts", line: 3 });
    const skeleton = await buildContext(env(), { path: "src/svc.ts", line: 1 });
    expect(method.chunks.filter((c) => c.level === "callee").map((c) => c.symbol)).toEqual(["inBody"]);
    expect(skeleton.chunks.filter((c) => c.level === "callee").map((c) => c.symbol)).toEqual(["atClass"]);
  });
});

describe("buildContext tests level", () => {
  it("takes up to 5 chunks from test-pattern files that reference the symbol", async () => {
    add("src/t.ts", "typescript", [chunk({ symbol: "refund", text: "function refund() {}" })]);
    const paths = [
      "src/a.test.ts",
      "src/b_test.go",
      "pkg/test_c.py",
      "tests/d.ts",
      "tests/sub/e.ts",
      "src/f.test.ts",
      "src/g.test.ts",
      "src/plain.ts",
      "src/contest.ts",
    ];
    for (const [i, path] of paths.entries()) {
      add(path, path.endsWith(".py") ? "python" : "typescript", [
        chunk({ symbol: `t${i}`, text: `it("x", () => refund(${i}))`, refs: [typeRef("refund", 1)] }),
      ]);
    }
    const r = await buildContext(env(), { path: "src/t.ts", line: 1, budgetTokens: 100000 });
    const testPaths = r.chunks.filter((c) => c.level === "test").map((c) => c.path);
    expect(testPaths).toEqual(["pkg/test_c.py", "src/a.test.ts", "src/b_test.go", "src/f.test.ts", "src/g.test.ts"]);
  });

  it("matches every pattern", async () => {
    add("src/t.ts", "typescript", [chunk({ symbol: "refund", text: "function refund() {}" })]);
    const paths = ["src/a.test.ts", "src/b_test.go", "pkg/test_c.py", "tests/d.ts", "src/plain.ts", "src/contest.ts"];
    for (const [i, path] of paths.entries()) {
      add(path, "typescript", [chunk({ symbol: `t${i}`, text: `refund(${i})`, refs: [typeRef("refund", 1)] })]);
    }
    const r = await buildContext(env(), { path: "src/t.ts", line: 1 });
    const testPaths = r.chunks.filter((c) => c.level === "test").map((c) => c.path);
    expect(testPaths).toEqual(["pkg/test_c.py", "src/a.test.ts", "src/b_test.go", "tests/d.ts"]);
  });
});

describe("buildContext commits", () => {
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: dir, stdio: "pipe" });

  function commitTimes(n: number) {
    git("init", "-q");
    mkdirSync(join(dir, "src"));
    for (let i = 0; i < n; i++) {
      writeFileSync(join(dir, "src/target.ts"), `v${i}`);
      git("add", "src/target.ts");
      git("commit", "-q", "-m", `change ${i}`);
    }
  }

  it("lists up to 5 recent commits of the target file", async () => {
    add("src/target.ts", "typescript", [chunk({ symbol: "refund", text: "function refund() {}" })]);
    commitTimes(7);
    const r = await buildContext(env(), { path: "src/target.ts", line: 1 });
    expect(r.commits).toHaveLength(5);
    expect(r.commits[0]).toMatch(/^[0-9a-f]{7,} \d{4}-\d{2}-\d{2} change 6$/);
    expect(r.usedTokens).toBe(r.chunks.reduce((n, c) => n + c.tokens, 0) + r.commits.reduce((n, c) => n + tokens(c), 0));
  });

  it("drops commits when the target alone exceeds the budget", async () => {
    add("src/target.ts", "typescript", [chunk({ symbol: "refund", text: "function refund() {}" })]);
    commitTimes(1);
    const r = await buildContext(env(), { path: "src/target.ts", line: 1, budgetTokens: 1 });
    expect(r.commits).toEqual([]);
  });

  it("returns no commits without error when git cannot run", async () => {
    add("src/target.ts", "typescript", [chunk({ symbol: "refund", text: "function refund() {}" })]);
    const r = await buildContext(env({ root: join(dir, "missing") }), { path: "src/target.ts", line: 1 });
    expect(r.commits).toEqual([]);
    expect(r.chunks[0]!.level).toBe("target");
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

describe("buildContext level limits and caller confidence", () => {
  it("rates a caller against the definition in the target's file", async () => {
    add("src/a.ts", "typescript", [chunk({ symbol: "dup", text: "function dup() {\n  return 1;\n}" })]);
    add("src/b.ts", "typescript", [chunk({ symbol: "dup", text: "function dup() {\n  return 2;\n}" })]);
    add("src/user.ts", "typescript", [
      chunk({
        symbol: "use",
        text: 'import { dup } from "./b";\nfunction use() {\n  return dup();\n}',
        refs: [{ name: "dup", kind: "import", line: 1, module: "./b" }, call("dup", 3)],
      }),
    ]);
    const res = await buildContext(env(), { path: "src/a.ts", line: 1 });
    const caller = res.chunks.find((c) => c.level === "caller");
    expect(caller?.symbol).toBe("use");
    expect(caller?.confidence).toBe("low");
    const other = await buildContext(env(), { path: "src/b.ts", line: 1 });
    expect(other.chunks.find((c) => c.level === "caller")?.confidence).toBe("high");
  });

  it("test level takes further test chunks when callers filled with test chunks", async () => {
    add("src/target.ts", "typescript", [chunk({ symbol: "refund", text: "function refund(o) {\n  return o.amount;\n}" })]);
    for (const p of ["a0", "a1", "a2", "a3", "a4", "z0", "z1"]) {
      add(`tests/${p}.test.ts`, "typescript", [
        chunk({ symbol: `t_${p}`, text: `function t_${p}() {\n  return refund(1);\n}`, refs: [call("refund", 2)] }),
      ]);
    }
    const res = await buildContext(env(), { path: "src/target.ts", line: 1 });
    expect(res.chunks.filter((c) => c.level === "caller").map((c) => c.symbol)).toEqual(["t_a0", "t_a1", "t_a2", "t_a3", "t_a4"]);
    expect(res.chunks.filter((c) => c.level === "test").map((c) => c.symbol)).toEqual(["t_z0", "t_z1"]);
  });
});
