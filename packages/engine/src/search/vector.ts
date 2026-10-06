import { dequantizeInt8, quantizeInt8 } from "../store/quantize";
import type { SearchContext } from "./types";

const RERANK_POOL = 200;

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    nb += b[i]! * b[i]!;
  }
  return nb === 0 ? 0 : dot / Math.sqrt(nb);
}

export async function vectorCandidates(
  ctx: SearchContext,
  queryVec: Float32Array,
  k: number,
  filter: (path: string, lang: string | null) => boolean,
  signal?: AbortSignal,
): Promise<{ id: number; score: number }[]> {
  const q = quantizeInt8(queryVec);
  const want = Math.min(k, RERANK_POOL);
  let limit = want;
  let chunks: { id: number; chunkHash: string }[] = [];
  for (;;) {
    signal?.throwIfAborted();
    const hits = ctx.store.searchVec(q, limit);
    const meta = new Map(ctx.store.getChunks(hits.map((h) => h.chunkId)).map((c) => [c.id, c]));
    chunks = [];
    for (const h of hits) {
      const c = meta.get(h.chunkId);
      if (c && filter(c.path, c.lang)) chunks.push(c);
    }
    if (chunks.length >= want || hits.length < limit) break;
    limit *= 4;
  }
  chunks = chunks.slice(0, want);
  if (chunks.length === 0) return [];

  const exact =
    ctx.embCache && ctx.modelId
      ? ctx.embCache.get(
          ctx.modelId,
          chunks.map((c) => c.chunkHash),
        )
      : new Map<string, Float32Array>();
  const missing = chunks.filter((c) => !exact.has(c.chunkHash)).map((c) => c.id);
  const quant = missing.length ? ctx.store.getVectors(missing) : new Map<number, Int8Array>();

  const out: { id: number; score: number }[] = [];
  for (const c of chunks) {
    let v = exact.get(c.chunkHash);
    if (!v) {
      const qv = quant.get(c.id);
      if (!qv) continue;
      v = dequantizeInt8(qv);
    }
    if (v.length !== queryVec.length) continue;
    out.push({ id: c.id, score: cosine(queryVec, v) });
  }
  return out.sort((a, b) => b.score - a.score || a.id - b.id);
}
