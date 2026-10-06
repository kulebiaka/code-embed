import type { SearchContext } from "./types";

export function vectorCandidates(
  _ctx: SearchContext,
  _queryVec: Float32Array,
  _k: number,
  _filter: (path: string, lang: string | null) => boolean,
  _signal?: AbortSignal,
): Promise<{ id: number; score: number }[]> {
  throw new Error("not implemented: search/vector.vectorCandidates");
}
