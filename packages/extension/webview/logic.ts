import type { IndexStatus, SearchMode, SearchResponse, SearchResult } from "@code-embed/protocol/rpc";

export const DEBOUNCE_MS = 250;
export const MAX_SNIPPET_LINES = 6;

export const MODE_INFO: Record<SearchMode, { icon: string; name: string; label: string; placeholder: string }> = {
  hybrid: { icon: "combine", name: "Hybrid", label: "Hybrid: meaning and keywords", placeholder: "Search by meaning or name" },
  semantic: { icon: "sparkle", name: "Semantic", label: "Semantic: meaning only", placeholder: "Describe what the code does" },
  lexical: { icon: "whole-word", name: "Lexical", label: "Lexical: keywords and identifiers", placeholder: "Search identifiers" },
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

export function meaningIncomplete(status: IndexStatus | undefined): boolean {
  return !!status && !status.lexicalOnly && status.chunks > 0 && status.embedded < status.chunks;
}

export interface Banner {
  kind: "indexing" | "paused" | "partial";
  title: string;
  detail?: string;
  percent?: number;
}

export function indexBanner(resp: SearchResponse | undefined, status: IndexStatus | undefined): Banner | undefined {
  if (status && meaningIncomplete(status)) {
    const keywords = status.phase === "scanning" || status.phase === "lexical" ? "Keyword matches are being updated." : "Keyword matches are complete.";
    const detail = `${keywords} Meaning matches cover ${status.embedded.toLocaleString("en-US")} of ${plural(status.chunks, "chunk")} so far.`;
    const paused = status.phase === "paused";
    const title = paused ? "Meaning index paused" : status.phase === "queued" ? "Meaning index waits for another project" : "Building meaning index";
    return { kind: paused ? "paused" : "indexing", title, detail, percent: embeddedPercent(status) };
  }
  if (resp?.partial) return { kind: "partial", title: "Semantic search is unavailable, showing keyword matches only.", detail: resp.partialReason };
  return undefined;
}

export function sourceLabel(sources: readonly string[]): string {
  const lex = sources.includes("lexical");
  const sem = sources.includes("semantic");
  return lex && sem ? "meaning + keywords" : lex ? "keywords" : "meaning";
}

export function indexState(status: IndexStatus): { label: string; tone: "ok" | "busy" | "warn" | "error" } {
  if (status.phase === "error" || status.lastError) return { label: "Indexing error", tone: "error" };
  if (status.phase === "paused") return { label: "Indexing paused", tone: "warn" };
  if (status.phase === "queued") return { label: "Indexing queued", tone: "busy" };
  if (status.phase === "model-download") return { label: "Downloading model", tone: "busy" };
  if (status.lexicalOnly) return { label: "Keyword search only", tone: "warn" };
  if (meaningIncomplete(status)) return { label: `Indexing ${embeddedPercent(status)}%`, tone: "busy" };
  if (status.phase !== "idle") return { label: "Indexing", tone: "busy" };
  return { label: "Index ready", tone: "ok" };
}

export function modelLabel(status: IndexStatus): string {
  const model = status.model ?? status.provider;
  return status.remote ? `${model} · ${status.host ?? "remote"}` : `${model} · on this machine`;
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

export function summaryText(resp: SearchResponse, files: number, noun = "result"): string {
  const n = resp.results.length;
  const count = resp.total !== undefined && resp.total > n ? `${n} of ${plural(resp.total, noun)}` : plural(n, noun);
  return `${count} in ${plural(files, "file")} · ${resp.tookMs} ms`;
}

export function indexSummary(status: IndexStatus): string {
  return `${plural(status.files, "file")} · ${plural(status.chunks, "chunk")}`;
}

export interface RecentQuery {
  query: string;
  mode: SearchMode;
}

export const MAX_RECENT = 5;

export function addRecent(list: readonly RecentQuery[], entry: RecentQuery): RecentQuery[] {
  return [entry, ...list.filter((r) => r.query !== entry.query)].slice(0, MAX_RECENT);
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
