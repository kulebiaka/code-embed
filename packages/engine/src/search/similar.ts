import type { FindSimilarParams, SearchResponse } from "@code-embed/protocol";
import type { SearchContext } from "./types";

export function findSimilar(
  _ctx: SearchContext & { root: string },
  _params: FindSimilarParams,
  _signal?: AbortSignal,
): Promise<SearchResponse> {
  throw new Error("not implemented: search/similar.findSimilar");
}
