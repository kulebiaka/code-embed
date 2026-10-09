import type { ResultSource, SearchParams, SearchResponse, SearchResult } from "@code-embed/protocol";
import { ProviderUnavailableError } from "../errors";
import { buildSnippet } from "../lex/highlight";
import { compileFilters, normalizeLang } from "./filters";
import { rrfFuse } from "./fuse";
import { lexicalCandidates } from "./lexical";
import { routeWeights } from "./route";
import { embedWithTimeout, type SearchContext } from "./types";
import { vectorCandidates } from "./vector";

const DEFAULT_TOP = 20;
const SNIPPET_LINES = 8;
const VECTOR_POOL = 200;

type Scored = { id: number; score: number }[];

export async function search(ctx: SearchContext, params: SearchParams, signal?: AbortSignal): Promise<SearchResponse> {
  const t0 = performance.now();
  signal?.throwIfAborted();
  const mode = params.mode ?? "hybrid";
  const top = params.top ?? DEFAULT_TOP;
  const query = params.query;
  const lang = normalizeLang(params.lang);
  const filter = compileFilters({ ...params, lang });
  const hasGlobs = Boolean(params.include?.length || params.exclude?.length);
  const storeFilter = { lang, pathPrefix: params.pathPrefix };
  const pool = Math.max(VECTOR_POOL, top * 3);

  let partial = false;
  let partialReason: string | undefined;
  let useVectors = mode !== "lexical";
  if (useVectors) {
    const dims = ctx.store.dims;
    if (!ctx.embedder) {
      useVectors = false;
      partialReason = ctx.embedderError ?? "embedding provider is not configured";
    } else if (dims === null || ctx.embedder.info.dims !== dims || ctx.vectorsReady().ratio === 0) {
      useVectors = false;
      partialReason = ctx.embedderError ?? "vectors are not built yet";
    }
    partial = !useVectors;
  }

  const runVector = async (): Promise<Scored | null> => {
    if (!useVectors || !ctx.embedder) return null;
    try {
      const embedder = ctx.embedder;
      const r = await embedWithTimeout(ctx.embedTimeoutMs, signal, (s) => embedder.embedQueries([query], s));
      if (r.timedOut) {
        partial = true;
        partialReason = `query embedding timed out after ${ctx.embedTimeoutMs} ms while indexing; lexical results only`;
        return null;
      }
      const [qv] = r.value;
      if (!qv) return null;
      signal?.throwIfAborted();
      return await vectorCandidates(ctx, qv, VECTOR_POOL, filter, signal);
    } catch (e) {
      if (e instanceof ProviderUnavailableError) {
        partial = true;
        partialReason = e.message;
        return null;
      }
      throw e;
    }
  };
  const runLexical = (): Scored =>
    lexicalCandidates(ctx.store, query, pool, storeFilter, hasGlobs ? filter : undefined, signal);

  const lexicalFirst = mode !== "semantic" || !useVectors;
  const [vec, lexFirst] = await Promise.all([runVector(), Promise.resolve().then(() => (lexicalFirst ? runLexical() : null))]);
  signal?.throwIfAborted();
  const lexical = lexFirst ?? (vec === null ? runLexical() : []);

  if (useVectors && !partial && !ctx.vectorsReady().ready) {
    partial = true;
    partialReason = "vectors are still being built";
  }

  const weights = routeWeights(query);
  const lists: { ids: number[]; weight: number; source: ResultSource }[] = [];
  if (lexical.length) lists.push({ ids: lexical.map((h) => h.id), weight: weights.lexical, source: "lexical" });
  if (vec?.length) lists.push({ ids: vec.map((h) => h.id), weight: weights.semantic, source: "semantic" });
  const fused = rrfFuse(lists, 60);
  const max = fused[0]?.score ?? 0;

  const threshold = params.threshold;
  const kept = fused
    .map((f) => ({ ...f, score: max > 0 ? f.score / max : 0 }))
    .filter((f) => threshold === undefined || f.score >= threshold);
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
      sources: f.sources,
      snippet: buildSnippet(c.text, c.startLine, query, { maxLines: SNIPPET_LINES }),
    });
  }

  const res: SearchResponse = { results, partial, tookMs: Math.round(performance.now() - t0), total: kept.length };
  if (partial && partialReason) res.partialReason = partialReason;
  return res;
}
