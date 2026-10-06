import type { IndexStatus, SearchResponse, SearchResult } from "@code-embed/protocol/rpc";

export const DEBOUNCE_MS = 250;
export const MAX_SNIPPET_LINES = 8;

export interface FileGroup {
  path: string;
  results: SearchResult[];
}

export function groupByFile(results: SearchResult[]): FileGroup[] {
  const groups = new Map<string, FileGroup>();
  for (const r of results) {
    let g = groups.get(r.path);
    if (!g) {
      g = { path: r.path, results: [] };
      groups.set(r.path, g);
    }
    g.results.push(r);
  }
  return [...groups.values()];
}

export function splitGlobs(s: string): string[] {
  return s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

export function bannerText(resp: SearchResponse | undefined, status: IndexStatus | undefined): string | undefined {
  const incomplete = !!status && !status.lexicalOnly && status.chunks > 0 && status.embedded < status.chunks;
  if (!resp?.partial && !incomplete) return undefined;
  const pct = status && status.chunks > 0 ? Math.min(100, Math.floor((status.embedded / status.chunks) * 100)) : 0;
  return `Идёт индексация, ${pct}% векторов — результаты неполные`;
}

export function moveSelection(current: number, delta: 1 | -1, count: number): number {
  if (count === 0) return -1;
  if (current < 0) return delta === 1 ? 0 : count - 1;
  return Math.min(count - 1, Math.max(0, current + delta));
}

export function createDebouncer(ms: number, fn: () => void): { schedule(): void; flush(): void; cancel(): void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cancel = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  return {
    schedule() {
      cancel();
      timer = setTimeout(() => {
        timer = undefined;
        fn();
      }, ms);
    },
    flush() {
      cancel();
      fn();
    },
    cancel,
  };
}
