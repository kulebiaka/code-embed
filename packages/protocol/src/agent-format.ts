import { SEARCH_MODES } from "./rpc";
import type { FindSimilarParams, SearchParams, SearchResponse, SearchResult } from "./rpc";
import { MAX_TOOL_TOP } from "./tools";
import type { FindSimilarToolInput, SearchToolInput } from "./tools";

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
    push(`Предупреждение: индекс неполный${resp.partialReason ? ` (${resp.partialReason})` : ""}, результаты могут быть неполными.`);
  }
  if (resp.results.length === 0) {
    push("Ничего не найдено.");
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
  if (rest > 0) out.push(`… ещё ${rest} результатов`);
  return out.join("\n");
}
