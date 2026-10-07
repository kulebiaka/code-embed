import type { SearchResult } from "@code-embed/protocol";
import { describe, expect, it } from "vitest";
import { formatFilesOnly, formatJsonLines, formatText, renderResults, useColor } from "./output";
import type { CliIO } from "./types";

function result(over: Partial<SearchResult> = {}): SearchResult {
  return {
    path: "src/a.ts",
    lang: "typescript",
    range: { startLine: 10, endLine: 13, startByte: 0, endByte: 0 },
    symbol: "refund",
    kind: "function",
    score: 0.5,
    sources: ["lexical", "semantic"],
    snippet: {
      text: "function refund() {\n  return pay();\n}\n",
      startLine: 10,
      highlights: [{ line: 1, start: 9, end: 12 }],
    },
    ...over,
  };
}

describe("output", () => {
  it("formats ripgrep style line", () => {
    expect(formatText([result()], { context: 0, color: false })).toBe("src/a.ts:11:10:   return pay();\n");
  });

  it("falls back to the snippet start without highlights", () => {
    const r = result({ snippet: { text: "x\ny", startLine: 10, highlights: [] } });
    expect(formatText([r], { context: 0, color: false })).toBe("src/a.ts:10:1: x\n");
  });

  it("prints context lines and separators", () => {
    expect(formatText([result(), result({ path: "b.ts" })], { context: 1, color: false })).toBe(
      [
        "src/a.ts-10- function refund() {",
        "src/a.ts:11:10:   return pay();",
        "src/a.ts-12- }",
        "--",
        "b.ts-10- function refund() {",
        "b.ts:11:10:   return pay();",
        "b.ts-12- }",
        "",
      ].join("\n"),
    );
  });

  it("colors path, line and match", () => {
    const out = formatText([result()], { context: 0, color: true });
    expect(out).toBe("\x1b[35msrc/a.ts\x1b[0m:\x1b[32m11\x1b[0m:10:   return \x1b[1;31mpay\x1b[0m();\n");
  });

  it("files-only dedupes paths", () => {
    expect(formatFilesOnly([result(), result(), result({ path: "b.ts" })], false)).toBe("src/a.ts\nb.ts\n");
  });

  it("json lines have exactly the documented fields", () => {
    const lines = formatJsonLines([result()]).trimEnd().split("\n");
    expect(lines).toHaveLength(1);
    const obj = JSON.parse(lines[0]!);
    expect(Object.keys(obj)).toEqual([
      "path",
      "start_line",
      "end_line",
      "symbol",
      "kind",
      "score",
      "sources",
      "snippet",
    ]);
    expect(obj).toMatchObject({ start_line: 10, end_line: 13, sources: ["lexical", "semantic"] });
  });

  it("renderResults prefers json, then files-only", () => {
    const base = { context: 0, color: false };
    expect(renderResults([result()], { ...base, json: true, filesOnly: true })).toContain("start_line");
    expect(renderResults([result()], { ...base, json: false, filesOnly: true })).toBe("src/a.ts\n");
  });

  it("useColor honours mode, tty and NO_COLOR", () => {
    const io = (tty: boolean, env: NodeJS.ProcessEnv = {}) => ({ stdoutIsTTY: tty, env }) as unknown as CliIO;
    expect(useColor("always", io(false))).toBe(true);
    expect(useColor("never", io(true))).toBe(false);
    expect(useColor("auto", io(true))).toBe(true);
    expect(useColor("auto", io(false))).toBe(false);
    expect(useColor("auto", io(true, { NO_COLOR: "1" }))).toBe(false);
  });
});
