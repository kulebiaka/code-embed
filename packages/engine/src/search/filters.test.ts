import { describe, expect, it } from "vitest";
import { compileFilters } from "./filters";

describe("compileFilters", () => {
  it("accepts everything without filters", () => {
    expect(compileFilters({})("a/b.ts", null)).toBe(true);
  });
  it("include/exclude globs", () => {
    const f = compileFilters({ include: ["src/**/*.ts"], exclude: ["**/*.test.ts"] });
    expect(f("src/a/b.ts", "typescript")).toBe(true);
    expect(f("src/a/b.test.ts", "typescript")).toBe(false);
    expect(f("lib/b.ts", "typescript")).toBe(false);
  });
  it("lang and path prefix", () => {
    const f = compileFilters({ lang: "python", pathPrefix: "src/" });
    expect(f("src/a.py", "python")).toBe(true);
    expect(f("src/a.py", "go")).toBe(false);
    expect(f("lib/a.py", "python")).toBe(false);
  });
  it("matches dotfiles and bare basenames", () => {
    expect(compileFilters({ include: ["*.md"] })("docs/.hidden/x.md", null)).toBe(true);
  });
});
