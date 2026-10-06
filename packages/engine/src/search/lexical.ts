import { buildFtsMatch } from "../lex/query";
import type { IndexStore, StoreFilter } from "../store/types";

export function lexicalCandidates(
  store: IndexStore,
  query: string,
  want: number,
  storeFilter: StoreFilter,
  filter?: (path: string, lang: string | null) => boolean,
  signal?: AbortSignal,
): { id: number; score: number }[] {
  const match = buildFtsMatch(query);
  if (!match) return [];
  let limit = want;
  for (;;) {
    signal?.throwIfAborted();
    const hits = store.searchFts(match, limit, storeFilter);
    let out = hits.map((h) => ({ id: h.chunkId, score: h.score }));
    if (filter && out.length) {
      const meta = new Map(store.getChunks(out.map((h) => h.id)).map((c) => [c.id, c]));
      out = out.filter((h) => {
        const c = meta.get(h.id);
        return c !== undefined && filter(c.path, c.lang);
      });
    }
    if (out.length >= want || hits.length < limit) return out.slice(0, want);
    limit *= 4;
  }
}
