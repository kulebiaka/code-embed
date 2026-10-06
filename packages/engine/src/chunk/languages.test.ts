import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { grammarPath } from "./assets";
import { LANGUAGES } from "./languages";

describe("LANGUAGES", () => {
  it("covers the MVP grammars", () => {
    expect(Object.keys(LANGUAGES).sort()).toEqual(
      ["c", "cpp", "csharp", "go", "java", "javascript", "kotlin", "php", "python", "ruby", "rust", "tsx", "typescript"].sort(),
    );
  });

  it("has an available wasm and at least one function and class type per language", () => {
    for (const [lang, spec] of Object.entries(LANGUAGES)) {
      expect(existsSync(grammarPath(lang)), lang).toBe(true);
      const kinds = new Set(Object.values(spec.units));
      expect(kinds.has("function"), lang).toBe(true);
      expect(kinds.has("class"), lang).toBe(true);
    }
  });
});
