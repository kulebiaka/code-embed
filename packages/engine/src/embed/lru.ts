import type { Embedder } from "./types";

export function withQueryCache(e: Embedder, capacity = 1000): Embedder {
  const cache = new Map<string, Float32Array>();

  const touch = (key: string, v: Float32Array) => {
    cache.delete(key);
    cache.set(key, v);
    if (cache.size > capacity) cache.delete(cache.keys().next().value as string);
  };

  return {
    get info() {
      return e.info;
    },
    get shared() {
      return e.shared;
    },
    init: (signal) => e.init(signal),
    async embedQueries(texts, signal) {
      const out: (Float32Array | undefined)[] = texts.map((t) => {
        const hit = cache.get(t);
        if (hit) touch(t, hit);
        return hit;
      });
      const missing = [...new Set(texts.filter((_, i) => !out[i]))];
      if (missing.length > 0) {
        const vecs = await e.embedQueries(missing, signal);
        const byText = new Map<string, Float32Array>();
        missing.forEach((t, i) => {
          byText.set(t, vecs[i]!);
          touch(t, vecs[i]!);
        });
        texts.forEach((t, i) => {
          out[i] ??= byText.get(t);
        });
      }
      return out as Float32Array[];
    },
    embedDocuments: (texts, signal) => e.embedDocuments(texts, signal),
    countTokens: (text) => e.countTokens(text),
    unload: e.unload && (() => e.unload!()),
    setActive: e.setActive && ((active) => e.setActive!(active)),
    dispose: () => e.dispose(),
  };
}
