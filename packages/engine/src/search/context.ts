import type { ContextChunk, ContextLevel, ContextParams, ContextResponse, SearchResult } from "@code-embed/protocol";
import { REF_LANGS } from "../chunk/tags";
import { DEFAULT_CHUNK_OPTIONS } from "../chunk/types";
import type { ChunkRecord } from "../store/types";
import { callersOf } from "./graph";
import { search } from "./hybrid";
import { lexicalCandidates } from "./lexical";
import { findSimilar } from "./similar";
import type { SearchContext } from "./types";

export interface ContextEnv extends SearchContext {
  root: string;
}

const DEFAULT_BUDGET = 4000;
const MAX_CALLERS = 5;
const MAX_SIMILAR = 3;
const MAX_LEXICAL = 10;
const CALLER_POOL = 1000;

interface Candidate {
  id: number;
  chunk: ContextChunk;
}

function candidate(level: ContextLevel, c: ChunkRecord, confidence?: ContextChunk["confidence"]): Candidate {
  const chunk: ContextChunk = {
    level,
    path: c.path,
    lang: c.lang,
    range: { startLine: c.startLine, endLine: c.endLine },
    symbol: c.symbol,
    kind: c.kind,
    text: c.text,
    tokens: DEFAULT_CHUNK_OPTIONS.countTokens(c.text),
  };
  if (confidence) chunk.confidence = confidence;
  return { id: c.id, chunk };
}

function chunkOf(env: ContextEnv, r: SearchResult): ChunkRecord | undefined {
  return env.store.chunksForFile(r.path).find((c) => c.startLine === r.range.startLine && c.endLine === r.range.endLine);
}

function narrowest(chunks: ChunkRecord[], line: number): ChunkRecord | undefined {
  let best: ChunkRecord | undefined;
  for (const c of chunks) {
    if (line < c.startLine || line > c.endLine) continue;
    if (!best || c.endByte - c.startByte < best.endByte - best.startByte) best = c;
  }
  return best;
}

export async function buildContext(env: ContextEnv, p: ContextParams, signal?: AbortSignal): Promise<ContextResponse> {
  const t0 = performance.now();
  signal?.throwIfAborted();
  const budget = p.budgetTokens ?? DEFAULT_BUDGET;
  const { store } = env;

  let target: ChunkRecord | undefined;
  if ("query" in p) {
    const top = (await search(env, { query: p.query, top: 1 }, signal)).results[0];
    if (top) target = chunkOf(env, top);
  } else {
    target = narrowest(store.chunksForFile(p.path.replace(/\\/g, "/").replace(/^\.\//, "")), p.line);
  }

  if (!target) {
    return {
      chunks: [],
      commits: [],
      budgetTokens: budget,
      usedTokens: 0,
      omitted: [],
      partial: true,
      partialReason: "query" in p ? "no result for the query" : `no indexed chunk contains ${p.path}:${p.line}`,
      tookMs: Math.round(performance.now() - t0),
    };
  }

  const first = candidate("target", target);
  const chunks: ContextChunk[] = [first.chunk];
  const seen = new Set([target.id]);
  const omitted: ContextLevel[] = [];
  let used = first.chunk.tokens;
  let partial = false;
  let partialReason: string | undefined;

  const addLevel = (level: ContextLevel, items: Candidate[]) => {
    for (const item of items) {
      if (seen.has(item.id)) continue;
      if (used + item.chunk.tokens > budget) {
        omitted.push(level);
        return;
      }
      seen.add(item.id);
      chunks.push(item.chunk);
      used += item.chunk.tokens;
    }
  };

  const symbol = target.symbol;
  const hasGraph = target.lang !== null && REF_LANGS.has(target.lang);
  let lexical: Candidate[] = [];

  if (hasGraph) {
    if (symbol) {
      const callers: Candidate[] = [];
      const picked = new Set<number>();
      for (const r of callersOf(store, symbol, { limit: CALLER_POOL })) {
        if (callers.length >= MAX_CALLERS) break;
        if (r.ref.kind !== "call" || r.chunk.id === target.id || picked.has(r.chunk.id)) continue;
        picked.add(r.chunk.id);
        callers.push(candidate("caller", r.chunk, r.confidence));
      }
      addLevel("caller", callers);
    }
  } else if (symbol) {
    const ids = lexicalCandidates(store, symbol, MAX_LEXICAL + 1, {}, undefined, signal).map((h) => h.id);
    const byId = new Map(store.getChunks(ids).map((c) => [c.id, c]));
    lexical = ids
      .filter((id) => id !== target.id)
      .slice(0, MAX_LEXICAL)
      .flatMap((id) => {
        const c = byId.get(id);
        return c ? [candidate("lexical", c)] : [];
      });
  }

  if (env.vectorsReady().ready) {
    if (used >= budget) omitted.push("similar");
    else {
      const res = await findSimilar(
        env,
        { path: target.path, range: { startLine: target.startLine, endLine: target.endLine }, top: MAX_SIMILAR + chunks.length },
        signal,
      );
      const similar: Candidate[] = [];
      for (const r of res.results) {
        const c = chunkOf(env, r);
        if (c && !seen.has(c.id)) similar.push(candidate("similar", c));
        if (similar.length >= MAX_SIMILAR) break;
      }
      addLevel("similar", similar);
    }
  } else {
    partial = true;
    partialReason = "vectors are not ready; similar chunks are omitted";
  }

  addLevel("lexical", lexical);

  const response: ContextResponse = {
    chunks,
    commits: [],
    budgetTokens: budget,
    usedTokens: used,
    omitted,
    partial,
    tookMs: Math.round(performance.now() - t0),
  };
  if (partialReason) response.partialReason = partialReason;
  return response;
}
