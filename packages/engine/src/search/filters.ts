import type { SearchFilters } from "@code-embed/protocol";

export function compileFilters(_f: SearchFilters): (path: string, lang: string | null) => boolean {
  throw new Error("not implemented: search/filters.compileFilters");
}
