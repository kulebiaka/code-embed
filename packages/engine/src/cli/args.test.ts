import { describe, expect, it } from "vitest";
import { parseSearchArgs, splitGlobs, UsageError } from "./args";

describe("parseSearchArgs", () => {
  it.each([
    [["-s", "q"], { mode: "semantic" }],
    [["--semantic", "q"], { mode: "semantic" }],
    [["-l", "q"], { mode: "lexical" }],
    [["--lexical", "q"], { mode: "lexical" }],
    [["-H", "q"], { mode: "hybrid" }],
    [["--hybrid", "q"], { mode: "hybrid" }],
    [["-n", "5", "q"], { top: 5 }],
    [["--top", "7", "q"], { top: 7 }],
    [["-g", "src/**", "-g", "!**/*.test.ts", "q"], { globs: ["src/**", "!**/*.test.ts"] }],
    [["--glob", "a", "q"], { globs: ["a"] }],
    [["--lang", "ts", "q"], { lang: "ts" }],
    [["--threshold", "0.25", "q"], { threshold: 0.25 }],
    [["-C", "2", "q"], { context: 2 }],
    [["--context", "3", "q"], { context: 3 }],
    [["--files-only", "q"], { filesOnly: true }],
    [["--json", "q"], { json: true }],
    [["--no-update", "q"], { noUpdate: true }],
    [["--root", "/x", "q"], { root: "/x" }],
    [["--color", "always", "q"], { color: "always" }],
    [["--provider", "p", "q"], { provider: "p" }],
    [["--model", "m", "q"], { model: "m" }],
    [["--allow-remote", "q"], { allowRemote: true }],
    [["--version"], { version: true }],
    [["--help"], { help: true }],
  ])("%j", (argv, expected) => {
    const { flags } = parseSearchArgs(argv);
    expect(flags).toMatchObject(expected);
  });

  it("defaults", () => {
    const { flags, positionals } = parseSearchArgs(["hello", "world"]);
    expect(positionals).toEqual(["hello", "world"]);
    expect(flags).toMatchObject({ globs: [], context: 0, color: "auto", json: false, allowRemote: false });
    expect(flags.mode).toBeUndefined();
  });

  it.each([
    [["--bogus", "q"]],
    [["-n", "x", "q"]],
    [["-n", "0", "q"]],
    [["-C", "-1", "q"]],
    [["--color", "rainbow", "q"]],
    [["--threshold", "abc", "q"]],
    [["-s", "-l", "q"]],
  ])("rejects %j", (argv) => {
    expect(() => parseSearchArgs(argv)).toThrow(UsageError);
  });

  it("splitGlobs separates exclusions", () => {
    expect(splitGlobs(["a", "!b", "c"])).toEqual({ include: ["a", "c"], exclude: ["b"] });
    expect(splitGlobs([])).toEqual({});
  });
});
