import { SEARCH_MODES } from "./rpc";
import type {
  ContextChunk,
  ContextParams,
  ContextResponse,
  FindSimilarParams,
  OutlineParams,
  OutlineResponse,
  ReferenceItem,
  ReferencesParams,
  ReferencesResponse,
  SearchParams,
  SearchResponse,
  SearchResult,
} from "./rpc";
import { MAX_TOOL_TOP } from "./tools";
import type { ContextToolInput, FindSimilarToolInput, OutlineToolInput, ReferencesToolInput, SearchToolInput } from "./tools";

export class ToolInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolInputError";
  }
}

function optString(v: unknown, name: string): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string" || v.trim() === "") throw new ToolInputError(`"${name}" must be a non-empty string`);
  return v;
}

function reqString(v: unknown, name: string): string {
  const s = optString(v, name);
  if (s === undefined) throw new ToolInputError(`"${name}" is required and must be a non-empty string`);
  return s;
}

function optTop(v: unknown): number | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > MAX_TOOL_TOP) {
    throw new ToolInputError(`"top" must be an integer from 1 to ${MAX_TOOL_TOP}`);
  }
  return v;
}

function optGlobs(v: unknown, name: string): string[] | undefined {
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v) || v.some((g) => typeof g !== "string" || g === "")) {
    throw new ToolInputError(`"${name}" must be an array of non-empty glob strings`);
  }
  return v as string[];
}

function line(v: unknown, name: string): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1) throw new ToolInputError(`"${name}" must be an integer >= 1`);
  return v;
}

function assign<T extends object>(target: T, values: Record<string, unknown>): T {
  for (const [k, v] of Object.entries(values)) if (v !== undefined) (target as Record<string, unknown>)[k] = v;
  return target;
}

export function toSearchParams(input: SearchToolInput): SearchParams {
  const i = (input ?? {}) as unknown as Record<string, unknown>;
  const mode = i.mode;
  if (mode !== undefined && mode !== null && !SEARCH_MODES.includes(mode as never)) {
    throw new ToolInputError(`"mode" must be one of: ${SEARCH_MODES.join(", ")}`);
  }
  return assign({ query: reqString(i.query, "query") } as SearchParams, {
    mode: mode ?? undefined,
    top: optTop(i.top),
    include: optGlobs(i.include, "include"),
    exclude: optGlobs(i.exclude, "exclude"),
    lang: optString(i.lang, "lang"),
  });
}

export function toFindSimilarParams(input: FindSimilarToolInput): FindSimilarParams {
  const i = (input ?? {}) as unknown as Record<string, unknown>;
  const has = (k: string) => i[k] !== undefined && i[k] !== null;
  const top = optTop(i.top);
  if (has("code")) {
    if (has("path") || has("start_line") || has("end_line")) {
      throw new ToolInputError('pass either "code" or "path" with "start_line" and "end_line", not both');
    }
    return assign({ code: reqString(i.code, "code") } as FindSimilarParams, { lang: optString(i.lang, "lang"), top });
  }
  if (!has("path")) {
    throw new ToolInputError('pass either "code" or "path" with "start_line" and "end_line"');
  }
  if (has("lang")) throw new ToolInputError('"lang" is only allowed together with "code"');
  const path = reqString(i.path, "path");
  const startLine = line(i.start_line, "start_line");
  const endLine = line(i.end_line, "end_line");
  if (endLine < startLine) throw new ToolInputError('"end_line" must be >= "start_line"');
  return assign({ path, range: { startLine, endLine } } as FindSimilarParams, { top });
}

export function toOutlineParams(input: OutlineToolInput): OutlineParams {
  const i = (input ?? {}) as unknown as Record<string, unknown>;
  return { path: reqString(i.path, "path") };
}

export function toReferencesParams(input: ReferencesToolInput): ReferencesParams {
  const i = (input ?? {}) as unknown as Record<string, unknown>;
  return assign({ symbol: reqString(i.symbol, "symbol") } as ReferencesParams, { path: optString(i.path, "path") });
}

export function toContextParams(input: ContextToolInput): ContextParams {
  const i = (input ?? {}) as unknown as Record<string, unknown>;
  const has = (k: string) => i[k] !== undefined && i[k] !== null;
  let budgetTokens: number | undefined;
  if (has("budget_tokens")) {
    const b = i.budget_tokens;
    if (typeof b !== "number" || !Number.isInteger(b) || b < 1) throw new ToolInputError('"budget_tokens" must be an integer >= 1');
    budgetTokens = b;
  }
  if (has("query")) {
    if (has("path") || has("line")) throw new ToolInputError('pass either "query" or "path" with "line", not both');
    return assign({ query: reqString(i.query, "query") } as ContextParams, { budgetTokens });
  }
  if (!has("path") && !has("line")) throw new ToolInputError('pass either "query" or "path" with "line"');
  const path = reqString(i.path, "path");
  if (!has("line")) throw new ToolInputError('"line" is required together with "path"');
  return assign({ path, line: line(i.line, "line") } as ContextParams, { budgetTokens });
}

export interface AgentFormatOptions {
  maxTokens?: number;
  maxSnippetLines?: number;
}

export const DEFAULT_AGENT_FORMAT_OPTIONS: Required<AgentFormatOptions> = { maxTokens: 4000, maxSnippetLines: 12 };

function formatResult(r: SearchResult, maxLines: number): string {
  const head = `${r.path}:${r.range.startLine}-${r.range.endLine}  ${r.symbol ?? "-"}  (${r.score.toFixed(2)})`;
  const lines = r.snippet.text.replace(/\r?\n$/, "").split(/\r?\n/);
  const shown = lines.slice(0, maxLines).map((l) => `    ${l}`);
  if (lines.length > maxLines) shown.push("    ...");
  return [head, ...shown].join("\n");
}

export function formatForAgent(resp: SearchResponse, opts?: AgentFormatOptions): string {
  const { maxTokens, maxSnippetLines } = { ...DEFAULT_AGENT_FORMAT_OPTIONS, ...opts };
  const maxChars = maxTokens * 4;
  const out: string[] = [];
  let used = 0;
  const push = (s: string) => {
    out.push(s);
    used += s.length + 1;
  };
  if (resp.partial) {
    push(`Warning: the index is incomplete${resp.partialReason ? ` (${resp.partialReason})` : ""}, results may be incomplete.`);
  }
  if (resp.results.length === 0) {
    push("Nothing found.");
    return out.join("\n");
  }
  let shown = 0;
  for (const r of resp.results) {
    const block = formatResult(r, maxSnippetLines);
    if (shown > 0 && used + block.length + 1 > maxChars) break;
    push(block);
    shown++;
  }
  const rest = resp.results.length - shown;
  if (rest > 0) out.push(`… ${rest} more results`);
  return out.join("\n");
}

export function formatOutlineForAgent(resp: OutlineResponse): string {
  if (resp.symbols.length === 0) return `${resp.path}\nNo symbols found (the file may not be indexed).`;
  const rows = resp.symbols.map((s) => {
    const name = s.parentSymbol && s.symbol ? `${s.parentSymbol}.${s.symbol}` : (s.symbol ?? "-");
    const sig = s.signature ? `  ${s.signature.split(/\r?\n/)[0]}` : "";
    return `  ${s.range.startLine}-${s.range.endLine}  ${s.kind}  ${name}${sig}`;
  });
  return [resp.path, ...rows].join("\n");
}

function formatReferenceItem(r: ReferenceItem): string {
  const text = r.text.replace(/\r?\n$/, "").split(/\r?\n/)[0]!.trim();
  const where = r.symbol ? `  in ${r.symbol}` : "";
  return `  ${r.path}:${r.line}  [${r.kind}, ${r.confidence}]${where}\n      ${text}`;
}

export function formatReferencesForAgent(resp: ReferencesResponse, opts?: AgentFormatOptions): string {
  const { maxTokens } = { ...DEFAULT_AGENT_FORMAT_OPTIONS, ...opts };
  const maxChars = maxTokens * 4;
  const defs = resp.items.filter((r) => r.role === "definition");
  const usages = resp.items.filter((r) => r.role === "usage");
  if (resp.items.length === 0) return `No definitions or usages found for ${resp.symbol}.`;
  const out: string[] = [];
  let used = 0;
  const push = (s: string) => {
    out.push(s);
    used += s.length + 1;
  };
  push(`Definitions of ${resp.symbol} (${defs.length}):`);
  if (defs.length === 0) push("  none found");
  for (const d of defs) push(formatReferenceItem(d));
  push(`Usages (${usages.length}${resp.truncated ? "+" : ""}):`);
  if (usages.length === 0) push("  none found");
  let shown = 0;
  for (const u of usages) {
    const block = formatReferenceItem(u);
    if (shown > 0 && used + block.length + 1 > maxChars) break;
    push(block);
    shown++;
  }
  const rest = usages.length - shown;
  if (rest > 0) out.push(`… ${rest} more usages`);
  if (resp.truncated) out.push("Usage list truncated at the store limit; narrow the search with path.");
  return out.join("\n");
}

const CONTEXT_LEVEL_TITLES: Record<ContextChunk["level"], string> = {
  target: "Target",
  callee: "Callees",
  caller: "Callers",
  test: "Tests",
  similar: "Similar",
  lexical: "Lexical",
};

function formatContextChunk(c: ContextChunk): string {
  const conf = c.confidence ? `  (${c.confidence})` : "";
  const head = `${c.path}:${c.range.startLine}-${c.range.endLine}  ${c.symbol ?? "-"}${conf}`;
  const body = c.text
    .replace(/\r?\n$/, "")
    .split(/\r?\n/)
    .map((l) => `    ${l}`);
  return [head, ...body].join("\n");
}

export function formatContextForAgent(resp: ContextResponse): string {
  const out: string[] = [];
  if (resp.partial) out.push(`Warning: context is partial${resp.partialReason ? ` (${resp.partialReason})` : ""}.`);
  if (resp.chunks.length === 0) out.push("Nothing found.");
  for (const level of Object.keys(CONTEXT_LEVEL_TITLES) as ContextChunk["level"][]) {
    const chunks = resp.chunks.filter((c) => c.level === level);
    if (chunks.length === 0) continue;
    out.push(`## ${CONTEXT_LEVEL_TITLES[level]}`);
    for (const c of chunks) out.push(formatContextChunk(c));
  }
  if (resp.commits.length > 0) {
    out.push("## Recent commits");
    for (const c of resp.commits) out.push(`  ${c}`);
  }
  if (resp.omitted.length > 0) out.push(`Omitted (budget): ${resp.omitted.join(", ")}`);
  out.push(`Tokens: ${resp.usedTokens}/${resp.budgetTokens}`);
  return out.join("\n");
}
