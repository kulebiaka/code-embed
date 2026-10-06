import type { SearchParams, SearchResponse } from "@code-embed/protocol";
import type { SearchContext } from "./types";

export function search(_ctx: SearchContext, _params: SearchParams, _signal?: AbortSignal): Promise<SearchResponse> {
  throw new Error("not implemented: search/hybrid.search");
}
