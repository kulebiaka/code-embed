import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { FindSimilarParams, SearchResponse, SearchResult } from "@code-embed/protocol";
import { buildEmbeddingText } from "../chunk/header";
import { ProviderUnavailableError } from "../errors";
import { buildSnippet } from "../lex/highlight";
import { queryTerms } from "../lex/tokenize";
import { dequantizeInt8 } from "../store/quantize";
import type { ChunkRecord } from "../store/types";
import { compileFilters } from "./filters";
import { lexicalCandidates } from "./lexical";
import type { SearchContext } from "./types";
import { vectorCandidates } from "./vector";

const DEFAULT_TOP = 10;
const SNIPPET_LINES = 8;
const POOL = 200;
const REUSE_RATIO = 0.9;
const MAX_TERMS = 24;

function overlapLines(a: { startLine: number; endLine: number }, b: { startLine: number; endLine: number }): number {
  return Math.max(0, Math.min(a.endLine, b.endLine) - Math.max(a.startLine, b.startLine) + 1);
}

async function readRange(root: string, path: string, startLine: number, endLine: number): Promise<string | null> {
  try {
    const lines = (await readFile(join(root, path), "utf8")).split(/\r?\n/);
    return lines.slice(startLine - 1, endLine).join("\n");
  } catch {
    return null;
  }
}

export async function findSimilar(
  ctx: SearchContext & { root: string },
  params: FindSimilarParams,
  signal?: AbortSignal,
): Promise<SearchResponse> {
  const t0 = performance.now();
  signal?.throwIfAborted();
  const top = params.top ?? DEFAULT_TOP;
  const filter = compileFilters(params);
  const storeFilter = { lang: params.lang, pathPrefix: params.pathPrefix };

  let text: string;
  let lang: string | null;
  let path = "";
  let overlapping: ChunkRecord[] = [];
  let reuse: ChunkRecord | undefined;
  if ("code" in params) {
    text = params.code;
    lang = params.lang ?? null;
  } else {
    path = params.path;
    const range = params.range;
    const chunks = ctx.store.chunksForFile(path);
    overlapping = chunks.filter((c) => overlapLines(c, range) > 0);
    const rangeLen = range.endLine - range.startLine + 1;
    reuse = overlapping.find(
      (c) => overlapLines(c, range) / Math.max(rangeLen, c.endLine - c.startLine + 1) >= REUSE_RATIO,
    );
    lang = ctx.store.getFile(path)?.lang ?? chunks[0]?.lang ?? null;
    const fromDisk = reuse ? null : await readRange(ctx.root, path, range.startLine, range.endLine);
    text = fromDisk ?? (reuse ?? overlapping[0])?.text ?? "";
  }
  const excluded = new Set(overlapping.map((c) => c.id));

  let partialReason: string | undefined;
  let useVectors = true;
  const dims = ctx.store.dims;
  if (!ctx.embedder) {
    useVectors = false;
    partialReason = ctx.embedderError ?? "embedding provider is not configured";
  } else if (dims === null || ctx.embedder.info.dims !== dims || ctx.vectorsReady().ratio === 0) {
    useVectors = false;
    partialReason = ctx.embedderError ?? "vectors are not built yet";
  }
  let partial = !useVectors;

  let scored: { id: number; score: number }[] = [];
  if (useVectors && ctx.embedder) {
    try {
      let vec: Float32Array | undefined;
      if (reuse?.embedded) {
        const exact =
          ctx.embCache && ctx.modelId
            ? ctx.embCache.get(ctx.modelId, [reuse.chunkHash]).get(reuse.chunkHash)
            : undefined;
        const i8 = exact ? undefined : ctx.store.getVectors([reuse.id]).get(reuse.id);
        const stored = exact ?? (i8 ? dequantizeInt8(i8) : undefined);
        if (stored && stored.length === dims) vec = stored;
      }
      if (!vec) {
        const doc = buildEmbeddingText(
          { startLine: 0, endLine: 0, startByte: 0, endByte: 0, kind: "fragment", symbol: null, parentSymbol: null, signature: null, text },
          { path, lang },
        );
        [vec] = await ctx.embedder.embedDocuments([doc], signal);
      }
      if (vec) {
        signal?.throwIfAborted();
        scored = await vectorCandidates(ctx, vec, POOL + excluded.size, filter, signal);
      }
    } catch (e) {
      if (!(e instanceof ProviderUnavailableError)) throw e;
      partial = true;
      partialReason = e.message;
      useVectors = false;
    }
  }
  if (!useVectors) {
    const terms = [...new Set(queryTerms(text))].slice(0, MAX_TERMS);
    const hasGlobs = Boolean(params.include?.length || params.exclude?.length);
    scored = lexicalCandidates(ctx.store, terms.join(" "), POOL + excluded.size, storeFilter, hasGlobs ? filter : undefined, signal);
  } else if (!ctx.vectorsReady().ready) {
    partial = true;
    partialReason = "vectors are still being built";
  }

  const candidates = scored.filter((h) => !excluded.has(h.id));
  const max = candidates[0]?.score ?? 0;
  const threshold = (params as { threshold?: number }).threshold;
  const kept = candidates
    .map((h) => ({ id: h.id, score: max > 0 ? Math.max(0, h.score / max) : 0 }))
    .filter((h) => threshold === undefined || h.score >= threshold);
  const page = kept.slice(0, top);

  const chunks = new Map(ctx.store.getChunks(page.map((f) => f.id)).map((c) => [c.id, c]));
  const results: SearchResult[] = [];
  for (const f of page) {
    const c = chunks.get(f.id);
    if (!c) continue;
    results.push({
      path: c.path,
      lang: c.lang,
      range: { startLine: c.startLine, endLine: c.endLine, startByte: c.startByte, endByte: c.endByte },
      symbol: c.symbol,
      kind: c.kind,
      score: f.score,
      sources: useVectors ? ["semantic"] : ["lexical"],
      snippet: buildSnippet(c.text, c.startLine, null, { maxLines: SNIPPET_LINES }),
    });
  }

  const res: SearchResponse = { results, partial, tookMs: Math.round(performance.now() - t0), total: kept.length };
  if (partial && partialReason) res.partialReason = partialReason;
  return res;
}
