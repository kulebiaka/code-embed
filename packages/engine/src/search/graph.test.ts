import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openIndexStore } from "../store/sqlite";
import type { ChunkInput, IndexStore, RefInput, RefRecord } from "../store/types";
import { calleesOf, callersOf, confidenceOf, findReferences, resolveModule, sortResolved, type Resolved } from "./graph";

let dir: string;
let store: IndexStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ce-graph-"));
  store = openIndexStore(join(dir, "index.db"));
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const ref = (name: string, kind: RefInput["kind"], line: number, module: string | null = null): RefInput => ({ name, kind, line, module });

function chunk(over: Partial<ChunkInput> & { text: string }): ChunkInput {
  const lines = over.text.split("\n").length;
  const startLine = over.startLine ?? 1;
  return {
    startLine,
    endLine: startLine + lines - 1,
    startByte: 0,
    endByte: over.text.length,
    kind: "function",
    symbol: null,
    parentSymbol: null,
    chunkHash: `h-${Math.random()}`,
    fts: { text: over.text, symbol: over.symbol ?? "", path: "" },
    ...over,
  };
}

function add(path: string, lang: string, chunks: ChunkInput[]): number[] {
  return store.upsertFile({ path, lang, size: 1, mtime: 1, contentHash: path }, chunks).chunkIds;
}

const rr = (name: string, kind: RefRecord["kind"], module: string | null): RefRecord => ({ chunkId: 1, name, kind, line: 1, module });

describe("resolveModule", () => {
  const files = new Set([
    "src/a/x.ts",
    "src/a/y.tsx",
    "src/a/z.js",
    "src/a/dir/index.ts",
    "src/w.ts",
    "pkg/mod.py",
    "pkg/sub/__init__.py",
    "pkg/rel.py",
    "pkg/__init__.py",
    "top.py",
  ]);
  const ex = (p: string) => files.has(p);

  it("TS/JS relative specifiers", () => {
    expect(resolveModule("src/a/main.ts", "./x", "typescript", ex)).toEqual(["src/a/x.ts"]);
    expect(resolveModule("src/a/main.ts", "./y", "tsx", ex)).toEqual(["src/a/y.tsx"]);
    expect(resolveModule("src/a/main.ts", "./z", "javascript", ex)).toEqual(["src/a/z.js"]);
    expect(resolveModule("src/a/main.ts", "./dir", "typescript", ex)).toEqual(["src/a/dir/index.ts"]);
    expect(resolveModule("src/a/main.ts", "../w", "typescript", ex)).toEqual(["src/w.ts"]);
    expect(resolveModule("src/a/main.ts", "./x.ts", "typescript", ex)).toEqual(["src/a/x.ts"]);
    expect(resolveModule("src/a/main.ts", "./nope", "typescript", ex)).toEqual([]);
  });

  it("TS/JS bare packages and paths aliases do not resolve (R-70)", () => {
    expect(resolveModule("src/a/main.ts", "pkg", "typescript", ex)).toEqual([]);
    expect(resolveModule("src/a/main.ts", "@/w", "typescript", ex)).toEqual([]);
    expect(resolveModule("src/a/main.ts", "src/w", "typescript", ex)).toEqual([]);
  });

  it("Python relative imports", () => {
    expect(resolveModule("pkg/main.py", ".rel", "python", ex)).toEqual(["pkg/rel.py"]);
    expect(resolveModule("pkg/main.py", ".sub", "python", ex)).toEqual(["pkg/sub/__init__.py"]);
    expect(resolveModule("pkg/sub/main.py", "..rel", "python", ex)).toEqual(["pkg/rel.py"]);
    expect(resolveModule("pkg/main.py", ".", "python", ex)).toEqual(["pkg/__init__.py"]);
    expect(resolveModule("pkg/main.py", "..top", "python", ex)).toEqual(["top.py"]);
  });

  it("Python absolute imports resolve from the repo root only (R-69)", () => {
    expect(resolveModule("app/main.py", "pkg.mod", "python", ex)).toEqual(["pkg/mod.py"]);
    expect(resolveModule("app/main.py", "pkg.sub", "python", ex)).toEqual(["pkg/sub/__init__.py"]);
    expect(resolveModule("app/main.py", "mod", "python", ex)).toEqual([]);
    expect(resolveModule("pkg/main.py", "rel", "python", ex)).toEqual([]);
  });

  it("unknown language resolves nothing", () => {
    expect(resolveModule("a.rs", "./x", null, ex)).toEqual([]);
  });
});

describe("confidenceOf", () => {
  const ex = (p: string) => p === "src/x.ts" || p === "pkg/mod.py";

  it("same file is high", () => {
    expect(confidenceOf("src/x.ts", "src/x.ts", "f", [], "typescript", ex)).toBe("high");
  });

  it("import from a module resolving to the definition file is high", () => {
    expect(confidenceOf("src/m.ts", "src/x.ts", "f", [rr("f", "import", "./x")], "typescript", ex)).toBe("high");
    expect(confidenceOf("app/m.py", "pkg/mod.py", "f", [rr("f", "import", "pkg.mod")], "python", ex)).toBe("high");
  });

  it("low otherwise", () => {
    expect(confidenceOf("src/m.ts", "src/x.ts", "f", [], "typescript", ex)).toBe("low");
    expect(confidenceOf("src/m.ts", "src/x.ts", "f", [rr("g", "import", "./x")], "typescript", ex)).toBe("low");
    expect(confidenceOf("src/m.ts", "src/x.ts", "f", [rr("f", "import", "./other")], "typescript", ex)).toBe("low");
    expect(confidenceOf("src/m.ts", "src/x.ts", "f", [rr("f", "import", "pkg")], "typescript", ex)).toBe("low");
    expect(confidenceOf("src/m.ts", "src/x.ts", "f", [rr("f", "call", "./x")], "typescript", ex)).toBe("low");
    expect(confidenceOf("m.py", "pkg/mod.py", "f", [rr("f", "import", "mod")], "python", ex)).toBe("low");
  });
});

describe("sortResolved", () => {
  it("high first, then low, by path then line", () => {
    const mk = (path: string, line: number, confidence: "high" | "low") =>
      ({ ref: { line }, chunk: { path }, confidence }) as unknown as Resolved;
    const sorted = sortResolved([mk("b.ts", 1, "low"), mk("z.ts", 1, "high"), mk("a.ts", 9, "low"), mk("a.ts", 2, "low"), mk("c.ts", 1, "high")]);
    expect(sorted.map((r) => `${r.chunk.path}:${r.ref.line}:${r.confidence}`)).toEqual([
      "c.ts:1:high",
      "z.ts:1:high",
      "a.ts:2:low",
      "a.ts:9:low",
      "b.ts:1:low",
    ]);
  });
});

function seedTs() {
  add("src/x.ts", "typescript", [chunk({ symbol: "target", text: "function target() {\n  return target2();\n}", refs: [ref("target2", "call", 2)] })]);
  add("src/same.ts", "typescript", [
    chunk({ symbol: "target", text: "function target() {}" }),
    chunk({ startLine: 3, startByte: 30, endByte: 70, symbol: "local", text: "function local() {\n  target();\n}", refs: [ref("target", "call", 4)] }),
  ]);
  add("src/imp.ts", "typescript", [
    chunk({
      symbol: "viaImport",
      text: "import { target } from './x';\ntarget();",
      refs: [ref("target", "import", 1, "./x"), ref("target", "call", 2)],
    }),
  ]);
  add("src/pkg.ts", "typescript", [
    chunk({
      symbol: "viaPkg",
      text: "import { target } from 'some-pkg';\ntarget();",
      refs: [ref("target", "import", 1, "some-pkg"), ref("target", "call", 2)],
    }),
  ]);
}

describe("callersOf / findReferences", () => {
  it("keeps low refs and orders high before low (R-26, R-30)", () => {
    seedTs();
    const r = callersOf(store, "target", { limit: 100, definitionPath: "src/x.ts" });
    expect(r.map((x) => `${x.chunk.path}:${x.ref.kind}:${x.confidence}`)).toEqual([
      "src/imp.ts:import:high",
      "src/imp.ts:call:high",
      "src/pkg.ts:import:low",
      "src/pkg.ts:call:low",
      "src/same.ts:call:low",
    ]);
  });

  it("same-file reference is high; best confidence over several definitions", () => {
    seedTs();
    const r = callersOf(store, "target", { limit: 100 });
    const same = r.find((x) => x.chunk.path === "src/same.ts")!;
    expect(same.confidence).toBe("high");
    expect(same.definition.path).toBe("src/same.ts");
    expect(r.filter((x) => x.chunk.path === "src/pkg.ts").every((x) => x.confidence === "low")).toBe(true);
  });

  it("limit cuts after the sort", () => {
    seedTs();
    const r = callersOf(store, "target", { limit: 2, definitionPath: "src/x.ts" });
    expect(r.map((x) => x.confidence)).toEqual(["high", "high"]);
  });

  it("findReferences returns definitions first, then usages with confidence", () => {
    seedTs();
    const res = findReferences(store, { symbol: "target", path: "src/x.ts" });
    expect(res.truncated).toBe(false);
    expect(res.items.map((i) => `${i.role}:${i.path}:${i.confidence}`)).toEqual([
      "definition:src/x.ts:high",
      "usage:src/imp.ts:high",
      "usage:src/imp.ts:high",
      "usage:src/pkg.ts:low",
      "usage:src/pkg.ts:low",
      "usage:src/same.ts:low",
    ]);
    const call = res.items.find((i) => i.role === "usage" && i.path === "src/imp.ts" && i.kind === "call")!;
    expect(call.text).toBe("target();");
    expect(call.line).toBe(2);
    expect(call.symbol).toBe("viaImport");
    expect(res.items[0]!.text).toBe("function target() {");
  });

  it("without path, all definitions are listed and unknown symbols are empty", () => {
    seedTs();
    expect(findReferences(store, { symbol: "target" }).items.filter((i) => i.role === "definition")).toHaveLength(2);
    expect(findReferences(store, { symbol: "nothing" }).items).toEqual([]);
  });

  it("Python: pkg.mod from the repo root and relative imports are high, others low", () => {
    add("pkg/mod.py", "python", [chunk({ symbol: "helper", kind: "function", text: "def helper():\n    pass" })]);
    add("app/main.py", "python", [
      chunk({ symbol: "run", text: "from pkg.mod import helper\nhelper()", refs: [ref("helper", "import", 1, "pkg.mod"), ref("helper", "call", 2)] }),
    ]);
    add("pkg/near.py", "python", [chunk({ symbol: "n", text: "from .mod import helper\nhelper()", refs: [ref("helper", "import", 1, ".mod"), ref("helper", "call", 2)] })]);
    add("other/far.py", "python", [chunk({ symbol: "f", text: "from mod import helper\nhelper()", refs: [ref("helper", "import", 1, "mod"), ref("helper", "call", 2)] })]);
    const r = callersOf(store, "helper", { limit: 100 });
    const byPath = (p: string) => r.filter((x) => x.chunk.path === p).map((x) => x.confidence);
    expect(byPath("app/main.py")).toEqual(["high", "high"]);
    expect(byPath("pkg/near.py")).toEqual(["high", "high"]);
    expect(byPath("other/far.py")).toEqual(["low", "low"]);
  });

  it("ref outside its chunk range or in an elided skeleton falls back to the name", () => {
    add("src/d.ts", "typescript", [chunk({ symbol: "target", text: "function target() {}" })]);
    add("src/c.ts", "typescript", [
      chunk({ symbol: "A", kind: "class", text: "class A {\n  // ...\n}", startLine: 1, endLine: 30, refs: [ref("target", "type", 20)] }),
      chunk({ symbol: "m", startLine: 40, startByte: 500, endByte: 560, text: "m() {\n  x;\n}", refs: [ref("target", "call", 5)] }),
    ]);
    const res = findReferences(store, { symbol: "target" });
    const usages = res.items.filter((i) => i.role === "usage");
    expect(usages).toHaveLength(2);
    expect(usages.map((u) => u.text).sort()).toEqual(["target", "target"]);
  });
});

describe("calleesOf", () => {
  it("resolves call refs of a chunk, skipping non-call refs", () => {
    add("src/lib.ts", "typescript", [chunk({ symbol: "dep", text: "function dep() {}" }), chunk({ symbol: "T", startLine: 5, startByte: 40, endByte: 80, text: "type T = {}", kind: "type" })]);
    add("src/m.ts", "typescript", [
      chunk({
        symbol: "main",
        text: "import { dep } from './lib';\ndep();\nother();\nlet t: T;",
        refs: [ref("dep", "import", 1, "./lib"), ref("dep", "call", 2), ref("other", "call", 3), ref("T", "type", 4)],
      }),
    ]);
    add("src/o.ts", "typescript", [chunk({ symbol: "other", text: "function other() {}" })]);
    const id = store.chunksForFile("src/m.ts")[0]!.id;
    const r = calleesOf(store, id);
    expect(r.map((x) => `${x.ref.name}:${x.definition.path}:${x.confidence}`)).toEqual(["dep:src/lib.ts:high", "other:src/o.ts:low"]);
  });
});
