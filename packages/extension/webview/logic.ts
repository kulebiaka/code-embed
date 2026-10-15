import type { IndexStatus, SearchMode, SearchResponse, SearchResult } from "@code-embed/protocol/rpc";

export const DEBOUNCE_MS = 250;
export const MAX_SNIPPET_LINES = 6;

export const MODE_INFO: Record<SearchMode, { icon: string; label: string; placeholder: string }> = {
  hybrid: { icon: "combine", label: "Hybrid: meaning and keywords", placeholder: "Search by meaning or name" },
  semantic: { icon: "sparkle", label: "Semantic: meaning only", placeholder: "Describe what the code does" },
  lexical: { icon: "whole-word", label: "Lexical: keywords and identifiers", placeholder: "Search identifiers" },
};

const KIND_ICONS: Record<string, string> = {
  function: "symbol-function",
  method: "symbol-method",
  class: "symbol-class",
  type: "symbol-interface",
  module: "symbol-namespace",
  section: "symbol-text",
};

export function kindIcon(kind: string): string {
  return KIND_ICONS[kind] ?? "symbol-snippet";
}

export const EXAMPLE_QUERIES = ["where are http requests retried", "parse the config file", "handleError"];

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

export function splitPath(path: string): { name: string; dir: string } {
  const i = path.lastIndexOf("/");
  return i < 0 ? { name: path, dir: "" } : { name: path.slice(i + 1), dir: path.slice(0, i) };
}

export function splitGlobs(s: string): string[] {
  return s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

export function embeddedPercent(status: IndexStatus | undefined): number {
  return status && status.chunks > 0 ? Math.min(100, Math.floor((status.embedded / status.chunks) * 100)) : 0;
}

export function bannerText(resp: SearchResponse | undefined, status: IndexStatus | undefined): string | undefined {
  const incomplete = !!status && !status.lexicalOnly && status.chunks > 0 && status.embedded < status.chunks;
  if (incomplete) return `Indexing ${embeddedPercent(status)}% · partial results`;
  if (resp?.partial) return "Semantic search is unavailable, showing keyword matches only.";
  return undefined;
}

// Picks the lines to show so that the first match is visible, with a little context above it.
export function snippetWindow(total: number, firstMatchLine: number | undefined, max = MAX_SNIPPET_LINES): { from: number; to: number } {
  if (total <= max || firstMatchLine === undefined) return { from: 0, to: Math.min(total, max) };
  const from = Math.max(0, Math.min(firstMatchLine - 1, total - max));
  return { from, to: from + max };
}

function plural(n: number, word: string): string {
  return `${n.toLocaleString("en-US")} ${word}${n === 1 ? "" : "s"}`;
}

export function summaryText(resp: SearchResponse, files: number): string {
  const n = resp.results.length;
  const count = resp.total !== undefined && resp.total > n ? `${n} of ${plural(resp.total, "result")}` : plural(n, "result");
  return `${count} in ${plural(files, "file")} · ${resp.tookMs} ms`;
}

export function indexSummary(status: IndexStatus): string {
  const where = status.remote ? (status.host ?? status.provider) : (status.model ?? status.provider);
  return `${plural(status.files, "file")} · ${plural(status.chunks, "chunk")} · ${where}`;
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
