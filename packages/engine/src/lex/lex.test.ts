import { describe, expect, it } from "vitest";
import { buildSnippet } from "./highlight";
import { buildFtsMatch } from "./query";
import { splitIdentifier } from "./split";
import { queryTerms, tokenizeForFts } from "./tokenize";

describe("splitIdentifier", () => {
  it("splits styles", () => {
    expect(splitIdentifier("processPaymentRefund")).toEqual(["process", "payment", "refund"]);
    expect(splitIdentifier("ParseConfig")).toEqual(["parse", "config"]);
    expect(splitIdentifier("parse_config")).toEqual(["parse", "config"]);
    expect(splitIdentifier("parse-config")).toEqual(["parse", "config"]);
    expect(splitIdentifier("HTTPServer2")).toEqual(["http", "server", "2"]);
    expect(splitIdentifier("$scope")).toEqual(["scope"]);
    expect(splitIdentifier("utf8Decode")).toEqual(["utf", "8", "decode"]);
  });
  it("keeps cyrillic whole", () => {
    expect(splitIdentifier("Привет")).toEqual(["привет"]);
  });
});

describe("tokenizeForFts", () => {
  it("keeps original and parts", () => {
    expect(tokenizeForFts("parseConfig(x)")).toBe("parseConfig parse config x");
  });
  it("is fast on 1 MB", () => {
    const text = "const parseConfigValue = getHTTPServer2(a_b, cLine);\n".repeat(20000).slice(0, 1_000_000);
    const t = performance.now();
    tokenizeForFts(text);
    expect(performance.now() - t).toBeLessThan(300);
  });
});

describe("queries", () => {
  it("applies the same split", () => {
    expect(queryTerms("parseConfig")).toEqual(["parseconfig", "parse", "config"]);
  });
  it("builds safe match", () => {
    expect(buildFtsMatch("parseConfig")).toBe('"parseconfig" OR "parse" OR "config"');
    expect(buildFtsMatch('foo" NEAR(bar) AND *')).toBe('"foo" OR "near" OR "bar" OR "and"');
    expect(buildFtsMatch("  ()  ")).toBeNull();
    expect(buildFtsMatch("")).toBeNull();
    expect(buildFtsMatch("поиск файлов")).toBe('"поиск" OR "файлов"');
  });
});

describe("buildSnippet", () => {
  it("highlights part inside identifier", () => {
    const s = buildSnippet("function parseConfig() {}", 10, "config", { maxLines: 3 });
    expect(s.startLine).toBe(10);
    expect(s.highlights).toEqual([{ line: 0, start: 14, end: 20 }]);
  });
  it("windows around best match", () => {
    const text = Array.from({ length: 20 }, (_, i) => (i === 12 ? "let config = 1" : `x${i}`)).join("\n");
    const s = buildSnippet(text, 1, "config", { maxLines: 5 });
    expect(s.text.split("\n")).toHaveLength(5);
    expect(s.startLine).toBe(11);
    expect(s.highlights).toEqual([{ line: 2, start: 4, end: 10 }]);
  });
  it("no query gives head without highlights", () => {
    const s = buildSnippet("a\nb\nc", 5, null, { maxLines: 2 });
    expect(s).toEqual({ text: "a\nb", startLine: 5, highlights: [] });
  });
});
