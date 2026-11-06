import { posix } from "node:path";
import type { Confidence, ReferenceItem, ReferencesParams, ReferencesResponse } from "@code-embed/protocol";
import type { ChunkRecord, IndexStore, RefRecord, StoreFilter } from "../store/types";

export interface Resolved {
  ref: RefRecord;
  chunk: ChunkRecord;
  definition: ChunkRecord;
  confidence: Confidence;
}

const REF_LIMIT = 1000;
const TS_EXTS = [".ts", ".tsx", ".js"];
const TS_LANGS = new Set(["typescript", "tsx", "javascript"]);

function norm(p: string): string {
  const n = posix.normalize(p);
  return n.startsWith("../") || n === ".." ? "" : n;
}

export function resolveModule(fromPath: string, module: string, lang: string | null, exists: (path: string) => boolean): string[] {
  let candidates: string[] = [];
  if (lang && TS_LANGS.has(lang)) {
    if (module.startsWith("./") || module.startsWith("../")) {
      const base = posix.join(posix.dirname(fromPath), module);
      candidates = [base, ...TS_EXTS.map((e) => base + e), ...TS_EXTS.map((e) => `${base}/index${e}`)];
    }
  } else if (lang === "python") {
    const rest = module.replace(/^\.+/, "");
    const dots = module.length - rest.length;
    let base = rest.split(".").filter(Boolean).join("/");
    if (dots > 0) {
      let dir = posix.dirname(fromPath);
      for (let i = 1; i < dots; i++) dir = posix.dirname(dir);
      base = posix.join(dir, base);
      if (!rest) candidates = [posix.join(base, "__init__.py")];
    }
    if (base && candidates.length === 0) candidates = [`${base}.py`, `${base}/__init__.py`];
  }
  return candidates.map(norm).filter((c) => c !== "" && exists(c));
}

export function confidenceOf(
  refPath: string,
  defPath: string,
  symbol: string,
  imports: RefRecord[],
  lang: string | null,
  exists: (path: string) => boolean,
): Confidence {
  if (refPath === defPath) return "high";
  for (const imp of imports) {
    if (imp.kind !== "import" || imp.name !== symbol || !imp.module) continue;
    if (resolveModule(refPath, imp.module, lang, exists).includes(defPath)) return "high";
  }
  return "low";
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export function sortResolved(items: Resolved[]): Resolved[] {
  return [...items].sort(
    (a, b) =>
      (a.confidence === b.confidence ? 0 : a.confidence === "high" ? -1 : 1) ||
      cmp(a.chunk.path, b.chunk.path) ||
      a.ref.line - b.ref.line,
  );
}

function makeExists(store: IndexStore): (path: string) => boolean {
  const cache = new Map<string, boolean>();
  return (path) => {
    let v = cache.get(path);
    if (v === undefined) {
      v = store.getFile(path) !== undefined;
      cache.set(path, v);
    }
    return v;
  };
}

function resolveUsages(
  store: IndexStore,
  symbol: string,
  defs: ChunkRecord[],
  limit: number,
  filter?: StoreFilter,
): { items: Resolved[]; truncated: boolean } {
  if (defs.length === 0) return { items: [], truncated: false };
  const exists = makeExists(store);
  const importsCache = new Map<number, RefRecord[]>();
  const hits = store.findRefs(symbol, REF_LIMIT, filter);
  const items: Resolved[] = [];
  for (const { ref, chunk } of hits) {
    let imports = importsCache.get(chunk.fileId);
    if (!imports) {
      imports = store.importsOfFile(chunk.fileId);
      importsCache.set(chunk.fileId, imports);
    }
    let best: Resolved | undefined;
    for (const definition of defs) {
      const confidence = confidenceOf(chunk.path, definition.path, symbol, imports, chunk.lang, exists);
      if (!best || (confidence === "high" && best.confidence === "low")) best = { ref, chunk, definition, confidence };
    }
    items.push(best!);
  }
  const sorted = sortResolved(items);
  return { items: sorted.slice(0, limit), truncated: hits.length >= REF_LIMIT || sorted.length > limit };
}

export function callersOf(
  store: IndexStore,
  symbol: string,
  opts: { limit: number; definitionPath?: string; filter?: StoreFilter },
): Resolved[] {
  const defs = store.findDefinitions(symbol, opts.filter).filter((d) => !opts.definitionPath || d.path === opts.definitionPath);
  return resolveUsages(store, symbol, defs, opts.limit, opts.filter).items;
}

export function calleesOf(store: IndexStore, chunkId: number): Resolved[] {
  const chunk = store.getChunks([chunkId])[0];
  if (!chunk) return [];
  const exists = makeExists(store);
  const imports = store.importsOfFile(chunk.fileId);
  const out: Resolved[] = [];
  for (const ref of store.refsOfChunk(chunkId)) {
    if (ref.kind !== "call") continue;
    for (const definition of store.findDefinitions(ref.name)) {
      out.push({ ref, chunk, definition, confidence: confidenceOf(chunk.path, definition.path, ref.name, imports, chunk.lang, exists) });
    }
  }
  return sortResolved(out);
}

function usageText(chunk: ChunkRecord, ref: RefRecord): string {
  if (ref.line >= chunk.startLine && ref.line <= chunk.endLine) {
    const lines = chunk.text.split("\n");
    if (lines.length === chunk.endLine - chunk.startLine + 1) return lines[ref.line - chunk.startLine]!.trim();
  }
  return ref.name;
}

export function findReferences(store: IndexStore, p: ReferencesParams): ReferencesResponse {
  const t0 = performance.now();
  const defs = store.findDefinitions(p.symbol).filter((d) => !p.path || d.path === p.path);
  const items: ReferenceItem[] = defs.map((d) => ({
    role: "definition",
    path: d.path,
    lang: d.lang,
    range: { startLine: d.startLine, endLine: d.endLine },
    line: d.startLine,
    symbol: d.symbol,
    kind: d.kind,
    confidence: "high",
    text: d.signature ?? d.text.split("\n")[0]!,
  }));
  const usages = resolveUsages(store, p.symbol, defs, Number.MAX_SAFE_INTEGER);
  for (const { ref, chunk, confidence } of usages.items) {
    items.push({
      role: "usage",
      path: chunk.path,
      lang: chunk.lang,
      range: { startLine: chunk.startLine, endLine: chunk.endLine },
      line: ref.line,
      symbol: chunk.symbol,
      kind: ref.kind,
      confidence,
      text: usageText(chunk, ref),
    });
  }
  return { symbol: p.symbol, items, truncated: usages.truncated, tookMs: Math.round(performance.now() - t0) };
}
