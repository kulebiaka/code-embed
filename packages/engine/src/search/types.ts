import type { EmbCache } from "../cache/types";
import type { Embedder } from "../embed/types";
import type { IndexStore } from "../store/types";

export const INDEXING_EMBED_TIMEOUT_MS = 800;

export interface SearchContext {
  store: IndexStore;
  embCache: EmbCache | null;
  embedder: Embedder | null;
  modelId: string | null;
  vectorsReady: () => { ratio: number; ready: boolean };
  embedderError?: string;
  embedTimeoutMs?: number;
}

export type TimedEmbed<T> = { timedOut: false; value: T } | { timedOut: true };

// Lexical fallback, vector candidates and response assembly run after the embedding; they get this share of the budget.
const ASSEMBLY_SHARE = 1 / 8;

export function embedDeadline(startedAt: number, budgetMs: number | undefined): number | undefined {
  return budgetMs === undefined ? undefined : startedAt + budgetMs * (1 - ASSEMBLY_SHARE);
}

export async function embedBefore<T>(
  deadline: number | undefined,
  signal: AbortSignal | undefined,
  run: (signal: AbortSignal | undefined) => Promise<T>,
): Promise<TimedEmbed<T>> {
  if (deadline === undefined) return { timedOut: false, value: await run(signal) };
  signal?.throwIfAborted();
  const remaining = deadline - performance.now();
  if (remaining <= 0) return { timedOut: true };
  const inner = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const pending = run(inner.signal);
  pending.catch(() => {});
  const timeOut = () => {
    inner.abort(new Error("embedding timed out"));
    return { timedOut: true } as const;
  };
  try {
    return await new Promise<TimedEmbed<T>>((resolve, reject) => {
      timer = setTimeout(() => resolve(timeOut()), remaining);
      if (signal) {
        onAbort = () => {
          inner.abort(signal.reason);
          reject(signal.reason);
        };
        signal.addEventListener("abort", onAbort, { once: true });
      }
      pending.then((value) => resolve(performance.now() > deadline ? timeOut() : { timedOut: false, value }), reject);
    });
  } finally {
    clearTimeout(timer);
    if (signal && onAbort) signal.removeEventListener("abort", onAbort);
  }
}
