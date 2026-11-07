import type { SearchMode } from "./rpc";

export const TOOL_NAMES = {
  search: "search",
  findSimilar: "find_similar",
  outline: "outline",
  references: "references",
  context: "context",
} as const;
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

export interface OutlineToolInput {
  path: string;
}

export interface ReferencesToolInput {
  symbol: string;
  path?: string;
}

export type ContextToolInput =
  | { path: string; line: number; budget_tokens?: number }
  | { query: string; budget_tokens?: number };

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

export const outlineToolInputSchema: Record<string, unknown> = {
  type: "object",
  properties: {
    path: {
      type: "string",
      minLength: 1,
      description: "File path relative to the workspace root.",
    },
  },
  required: ["path"],
  additionalProperties: false,
};

export const referencesToolInputSchema: Record<string, unknown> = {
  type: "object",
  properties: {
    symbol: {
      type: "string",
      minLength: 1,
      description: "Symbol name to look up, e.g. \"processRefund\" or \"PaymentService\".",
    },
    path: {
      type: "string",
      minLength: 1,
      description: "File path relative to the workspace root; restricts definitions to this file.",
    },
  },
  required: ["symbol"],
  additionalProperties: false,
};

export const contextToolInputSchema: Record<string, unknown> = {
  type: "object",
  properties: {
    path: {
      type: "string",
      minLength: 1,
      description: "File path relative to the workspace root (use together with line).",
    },
    line: {
      type: "integer",
      minimum: 1,
      description: "Line inside the target code, 1-based.",
    },
    query: {
      type: "string",
      minLength: 1,
      description: "Natural-language description or symbol name of the target (use instead of path/line).",
    },
    budget_tokens: {
      type: "integer",
      minimum: 1,
      description: "Token budget for the whole answer (default 4000).",
    },
  },
  oneOf: [
    {
      required: ["path", "line"],
      not: { required: ["query"] },
    },
    {
      required: ["query"],
      not: { anyOf: [{ required: ["path"] }, { required: ["line"] }] },
    },
  ],
  additionalProperties: false,
};

export const SEARCH_TOOL_DESCRIPTION =
  "Hybrid (semantic + lexical) search over a local index of the current workspace's code. " +
  "Use it instead of grep/ripgrep when searching by meaning: questions like \"where is X handled\" or \"how does Y work\", " +
  "finding the implementation of a concept or behavior when you do not know the exact identifiers, " +
  "natural-language queries in any language (including Russian), or when grep returns nothing or too much noise. " +
  "Do NOT use it for an exact identifier, string literal, error message or file name: use grep/ripgrep or file search for exact matches. " +
  "Do NOT use it to list the callers or usages of a symbol: use references. " +
  "To see the surroundings of a found chunk (callees, callers, tests, related code), use context. " +
  "Returns ranked code chunks (path, line range, symbol, snippet); read the referenced lines for full context. " +
  "Narrow the search with include/exclude globs and lang when you know where to look.";

export const FIND_SIMILAR_TOOL_DESCRIPTION =
  "Find code in the current workspace that is semantically similar to a given fragment: duplicates, near-copies, " +
  "alternative implementations of the same logic, other places that follow the same pattern. " +
  "Pass either a location (path relative to the workspace root, start_line and end_line, 1-based inclusive) " +
  "or a code snippet (code, optional lang). " +
  "Use it before a refactoring or a bug fix to find other places that need the same change. " +
  "Do NOT use it to find callers or usages of a symbol: use references. " +
  "To see the surroundings of a fragment (callees, callers, tests), use context. " +
  "Returns ranked code chunks (path, line range, symbol, snippet).";

export const OUTLINE_TOOL_DESCRIPTION =
  "List the symbols of one file from the local index: classes, functions, methods and other declarations " +
  "with kind, signature, parent symbol and line range, ordered by position. " +
  "Use it to get the structure of a file without reading it whole, then read only the lines you need. " +
  "Takes a path relative to the workspace root. Returns an empty list if the file is not indexed.";

export const REFERENCES_TOOL_DESCRIPTION =
  "Find where a symbol is defined and where it is used (calls, type references, imports) across the current workspace. " +
  "Use it to answer \"who calls X\" or \"where is X used\" instead of grep. " +
  "The lookup is name-based, from the local index: it matches identifiers by name and does not resolve scopes or types, " +
  "so it is NOT a replacement for LSP (language server) find-references. " +
  "Every item has a confidence, high or low; treat low-confidence items as candidates and verify them in the code. " +
  "Optional path restricts definitions to one file. " +
  "Returns definitions first, then usages (path, line range, line, kind, confidence, source line).";

export const CONTEXT_TOOL_DESCRIPTION =
  "Collect the working context of a piece of code in one call: the target chunk plus its callees, callers, tests, " +
  "similar code and recent commits of the file, ordered by priority and cut to a token budget. " +
  "Pass either a location (path relative to the workspace root and line, 1-based) or a query (natural language or symbol name). " +
  "Use it before changing code to see what it depends on and what depends on it. " +
  "Optional budget_tokens sets the size limit of the answer; the default is 4000 tokens. " +
  "Levels that did not fit in the budget are reported as omitted.";
