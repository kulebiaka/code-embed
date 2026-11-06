import { describe, expect, it } from "vitest";
import {
  CONTEXT_TOOL_DESCRIPTION,
  FIND_SIMILAR_TOOL_DESCRIPTION,
  MAX_TOOL_TOP,
  OUTLINE_TOOL_DESCRIPTION,
  REFERENCES_TOOL_DESCRIPTION,
  SEARCH_TOOL_DESCRIPTION,
  TOOL_NAMES,
  contextToolInputSchema,
  findSimilarToolInputSchema,
  outlineToolInputSchema,
  referencesToolInputSchema,
  searchToolInputSchema,
} from "./tools";

type Schema = Record<string, unknown>;

// Minimal validator for the JSON Schema subset used by the tool schemas.
function validate(schema: Schema, value: unknown): boolean {
  if (schema.type === "object") {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  }
  if (schema.type === "string" && typeof value !== "string") return false;
  if (schema.type === "integer" && !Number.isInteger(value)) return false;
  if (schema.type === "array" && !Array.isArray(value)) return false;
  if (typeof schema.minLength === "number" && typeof value === "string" && value.length < schema.minLength) return false;
  if (typeof schema.minimum === "number" && typeof value === "number" && value < schema.minimum) return false;
  if (typeof schema.maximum === "number" && typeof value === "number" && value > schema.maximum) return false;
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) return false;
  if (schema.items && Array.isArray(value) && !value.every((v) => validate(schema.items as Schema, v))) return false;
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    const props = (schema.properties ?? {}) as Record<string, Schema>;
    if (Array.isArray(schema.required) && !schema.required.every((k: string) => k in obj)) return false;
    for (const [k, v] of Object.entries(obj)) {
      const p = props[k];
      if (p) {
        if (!validate(p, v)) return false;
      } else if (schema.additionalProperties === false) {
        return false;
      }
    }
  }
  if (Array.isArray(schema.oneOf) && schema.oneOf.filter((s: Schema) => validate(s, value)).length !== 1) return false;
  if (Array.isArray(schema.anyOf) && !schema.anyOf.some((s: Schema) => validate(s, value))) return false;
  if (schema.not && validate(schema.not as Schema, value)) return false;
  return true;
}

describe("tool contracts", () => {
  it("fixes tool names and top limit", () => {
    expect(TOOL_NAMES).toEqual({
      search: "search",
      findSimilar: "find_similar",
      outline: "outline",
      references: "references",
      context: "context",
    });
    expect(MAX_TOOL_TOP).toBe(50);
  });

  it("search schema accepts valid inputs", () => {
    expect(validate(searchToolInputSchema, { query: "where is refund processed" })).toBe(true);
    expect(
      validate(searchToolInputSchema, {
        query: "обработка возврата платежа",
        mode: "semantic",
        top: 50,
        include: ["src/**"],
        exclude: ["**/*.test.ts"],
        lang: "typescript",
      }),
    ).toBe(true);
  });

  it("search schema rejects invalid inputs", () => {
    expect(validate(searchToolInputSchema, {})).toBe(false);
    expect(validate(searchToolInputSchema, { query: "" })).toBe(false);
    expect(validate(searchToolInputSchema, { query: "x", top: 51 })).toBe(false);
    expect(validate(searchToolInputSchema, { query: "x", top: 0 })).toBe(false);
    expect(validate(searchToolInputSchema, { query: "x", top: 2.5 })).toBe(false);
    expect(validate(searchToolInputSchema, { query: "x", mode: "fuzzy" })).toBe(false);
    expect(validate(searchToolInputSchema, { query: "x", include: "src/**" })).toBe(false);
    expect(validate(searchToolInputSchema, { query: "x", extra: 1 })).toBe(false);
  });

  it("find_similar schema accepts both forms", () => {
    expect(validate(findSimilarToolInputSchema, { path: "src/a.ts", start_line: 1, end_line: 10 })).toBe(true);
    expect(validate(findSimilarToolInputSchema, { path: "src/a.ts", start_line: 1, end_line: 10, top: 5 })).toBe(true);
    expect(validate(findSimilarToolInputSchema, { code: "def f(): pass" })).toBe(true);
    expect(validate(findSimilarToolInputSchema, { code: "def f(): pass", lang: "python", top: 50 })).toBe(true);
  });

  it("find_similar schema rejects mixed or incomplete forms", () => {
    expect(validate(findSimilarToolInputSchema, {})).toBe(false);
    expect(validate(findSimilarToolInputSchema, { path: "src/a.ts" })).toBe(false);
    expect(validate(findSimilarToolInputSchema, { path: "src/a.ts", start_line: 1 })).toBe(false);
    expect(validate(findSimilarToolInputSchema, { path: "a", start_line: 1, end_line: 2, code: "x" })).toBe(false);
    expect(validate(findSimilarToolInputSchema, { path: "a", start_line: 1, end_line: 2, lang: "go" })).toBe(false);
    expect(validate(findSimilarToolInputSchema, { code: "x", start_line: 1 })).toBe(false);
    expect(validate(findSimilarToolInputSchema, { code: "x", top: 51 })).toBe(false);
    expect(validate(findSimilarToolInputSchema, { path: "a", start_line: 0, end_line: 2 })).toBe(false);
  });

  it("schemas are plain JSON data", () => {
    expect(JSON.parse(JSON.stringify(searchToolInputSchema))).toEqual(searchToolInputSchema);
    expect(JSON.parse(JSON.stringify(findSimilarToolInputSchema))).toEqual(findSimilarToolInputSchema);
  });

  it("descriptions say when to use instead of grep and when not", () => {
    expect(SEARCH_TOOL_DESCRIPTION).toMatch(/instead of grep/);
    expect(SEARCH_TOOL_DESCRIPTION).toMatch(/Do NOT use/);
    expect(SEARCH_TOOL_DESCRIPTION).toMatch(/Russian/);
    expect(FIND_SIMILAR_TOOL_DESCRIPTION).toMatch(/Do NOT use/);
  });

  it("search and find_similar route callers to references and surroundings to context", () => {
    for (const d of [SEARCH_TOOL_DESCRIPTION, FIND_SIMILAR_TOOL_DESCRIPTION]) {
      expect(d).toMatch(/references/);
      expect(d).toMatch(/context/);
      expect(d).not.toMatch(/language server/);
    }
    expect(FIND_SIMILAR_TOOL_DESCRIPTION).not.toMatch(/grep/);
    expect(SEARCH_TOOL_DESCRIPTION).not.toMatch(/list every usage/);
  });

  it("outline schema requires a path", () => {
    expect(validate(outlineToolInputSchema, { path: "src/a.ts" })).toBe(true);
    expect(validate(outlineToolInputSchema, {})).toBe(false);
    expect(validate(outlineToolInputSchema, { path: "" })).toBe(false);
    expect(validate(outlineToolInputSchema, { path: "a", x: 1 })).toBe(false);
  });

  it("references schema requires a symbol and takes an optional path", () => {
    expect(validate(referencesToolInputSchema, { symbol: "foo" })).toBe(true);
    expect(validate(referencesToolInputSchema, { symbol: "foo", path: "src/a.ts" })).toBe(true);
    expect(validate(referencesToolInputSchema, {})).toBe(false);
    expect(validate(referencesToolInputSchema, { symbol: "" })).toBe(false);
    expect(validate(referencesToolInputSchema, { symbol: "foo", extra: 1 })).toBe(false);
  });

  it("context schema accepts either location or query", () => {
    expect(validate(contextToolInputSchema, { path: "src/a.ts", line: 10 })).toBe(true);
    expect(validate(contextToolInputSchema, { query: "refund flow", budget_tokens: 2000 })).toBe(true);
    expect(validate(contextToolInputSchema, { path: "a", line: 1, budget_tokens: 1 })).toBe(true);
  });

  it("context schema rejects mixed, incomplete or invalid forms", () => {
    expect(validate(contextToolInputSchema, {})).toBe(false);
    expect(validate(contextToolInputSchema, { path: "a" })).toBe(false);
    expect(validate(contextToolInputSchema, { line: 3 })).toBe(false);
    expect(validate(contextToolInputSchema, { path: "a", line: 1, query: "x" })).toBe(false);
    expect(validate(contextToolInputSchema, { query: "x", line: 1 })).toBe(false);
    expect(validate(contextToolInputSchema, { query: "x", budget_tokens: 0 })).toBe(false);
    expect(validate(contextToolInputSchema, { query: "x", budget_tokens: 1.5 })).toBe(false);
    expect(validate(contextToolInputSchema, { path: "a", line: 0 })).toBe(false);
  });

  it("new schemas are plain JSON data", () => {
    for (const s of [outlineToolInputSchema, referencesToolInputSchema, contextToolInputSchema]) {
      expect(JSON.parse(JSON.stringify(s))).toEqual(s);
    }
  });

  it("references description says name-based and not an LSP replacement", () => {
    expect(REFERENCES_TOOL_DESCRIPTION).toMatch(/name-based/);
    expect(REFERENCES_TOOL_DESCRIPTION).toMatch(/NOT a replacement for LSP/);
    expect(REFERENCES_TOOL_DESCRIPTION).toMatch(/confidence/);
  });

  it("context description names the default budget of 4000", () => {
    expect(CONTEXT_TOOL_DESCRIPTION).toMatch(/default is 4000/);
  });

  it("outline description is present", () => {
    expect(OUTLINE_TOOL_DESCRIPTION).toMatch(/symbols/);
  });
});
