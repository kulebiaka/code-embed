import type { SearchMode } from "./rpc";

export const TOOL_NAMES = { search: "search", findSimilar: "find_similar" } as const;
export const MAX_TOOL_TOP = 50;

export interface SearchToolInput {
  query: string;
  mode?: SearchMode;
  top?: number;
  include?: string[];
  exclude?: string[];
  lang?: string;
}

export type FindSimilarToolInput =
  | { path: string; start_line: number; end_line: number; top?: number }
  | { code: string; lang?: string; top?: number };

const topSchema = {
  type: "integer",
  minimum: 1,
  maximum: MAX_TOOL_TOP,
  description: `Maximum number of results to return (1-${MAX_TOOL_TOP}).`,
};

export const searchToolInputSchema: Record<string, unknown> = {
  type: "object",
  properties: {
    query: {
      type: "string",
      minLength: 1,
      description:
        "What to look for, in natural language or keywords, e.g. \"where is the payment refund processed\" or \"retry with exponential backoff\". Any language, including Russian.",
    },
    mode: {
      type: "string",
      enum: ["hybrid", "semantic", "lexical"],
      description:
        "hybrid (default) combines meaning and keywords; semantic matches by meaning only; lexical matches keywords and identifiers only.",
    },
    top: topSchema,
    include: {
      type: "array",
      items: { type: "string" },
      description: "Glob patterns relative to the workspace root; only matching files are searched, e.g. [\"src/**\"].",
    },
    exclude: {
      type: "array",
      items: { type: "string" },
      description: "Glob patterns relative to the workspace root to skip, e.g. [\"**/*.test.ts\"].",
    },
    lang: {
      type: "string",
      description: "Restrict results to one language id, e.g. typescript, python, go, rust, markdown.",
    },
  },
  required: ["query"],
  additionalProperties: false,
};

export const findSimilarToolInputSchema: Record<string, unknown> = {
  type: "object",
  properties: {
    path: {
      type: "string",
      minLength: 1,
      description: "File path relative to the workspace root (use together with start_line and end_line).",
    },
    start_line: {
      type: "integer",
      minimum: 1,
      description: "First line of the fragment, 1-based, inclusive.",
    },
    end_line: {
      type: "integer",
      minimum: 1,
      description: "Last line of the fragment, 1-based, inclusive.",
    },
    code: {
      type: "string",
      minLength: 1,
      description: "Code fragment to compare against (use instead of path/start_line/end_line).",
    },
    lang: {
      type: "string",
      description: "Language id of `code`, e.g. typescript, python. Only with `code`.",
    },
    top: topSchema,
  },
  oneOf: [
    {
      required: ["path", "start_line", "end_line"],
      not: { anyOf: [{ required: ["code"] }, { required: ["lang"] }] },
    },
    {
      required: ["code"],
      not: { anyOf: [{ required: ["path"] }, { required: ["start_line"] }, { required: ["end_line"] }] },
    },
  ],
  additionalProperties: false,
};

export const SEARCH_TOOL_DESCRIPTION =
  "Hybrid (semantic + lexical) search over a local index of the current workspace's code. " +
  "Use it instead of grep/ripgrep when searching by meaning: questions like \"where is X handled\" or \"how does Y work\", " +
  "finding the implementation of a concept or behavior when you do not know the exact identifiers, " +
  "natural-language queries in any language (including Russian), or when grep returns nothing or too much noise. " +
  "Do NOT use it for an exact identifier, string literal, error message or file name, or to list every usage of a symbol: " +
  "use grep/ripgrep or file search for exact matches. " +
  "Returns ranked code chunks (path, line range, symbol, snippet); read the referenced lines for full context. " +
  "Narrow the search with include/exclude globs and lang when you know where to look.";

export const FIND_SIMILAR_TOOL_DESCRIPTION =
  "Find code in the current workspace that is semantically similar to a given fragment: duplicates, near-copies, " +
  "alternative implementations of the same logic, other places that follow the same pattern. " +
  "Pass either a location (path relative to the workspace root, start_line and end_line, 1-based inclusive) " +
  "or a code snippet (code, optional lang). " +
  "Use it before a refactoring or a bug fix to find other places that need the same change. " +
  "Do NOT use it to find references, callers or usages of a symbol: use grep/ripgrep or the language server for that. " +
  "Returns ranked code chunks (path, line range, symbol, snippet).";
