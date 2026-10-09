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

export async function embedWithTimeout<T>(
  timeoutMs: number | undefined,
  signal: AbortSignal | undefined,
  run: (signal: AbortSignal | undefined) => Promise<T>,
): Promise<TimedEmbed<T>> {
  if (timeoutMs === undefined) return { timedOut: false, value: await run(signal) };
  signal?.throwIfAborted();
  const inner = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const pending = run(inner.signal);
  pending.catch(() => {});
  try {
    return await new Promise<TimedEmbed<T>>((resolve, reject) => {
      timer = setTimeout(() => {
        inner.abort(new Error("embedding timed out"));
        resolve({ timedOut: true });
      }, timeoutMs);
      if (signal) {
        onAbort = () => {
          inner.abort(signal.reason);
          reject(signal.reason);
        };
        signal.addEventListener("abort", onAbort, { once: true });
      }
      pending.then((value) => resolve({ timedOut: false, value }), reject);
    });
  } finally {
    clearTimeout(timer);
    if (signal && onAbort) signal.removeEventListener("abort", onAbort);
  }
}

