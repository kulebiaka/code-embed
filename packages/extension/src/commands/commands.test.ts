import { describe, expect, it } from "vitest";
import { installCommand, mcpConfigJson, nodeVersionOk, selectionLineRange } from "./util";

const pos = (line: number, character: number) => ({ line, character }) as never;

describe("nodeVersionOk", () => {
  it.each([
    ["v22.13.0\n", true],
    ["v22.12.9", false],
    ["v24.0.0", true],
    ["v20.19.0", false],
    ["garbage", false],
  ])("%s", (out, ok) => {
    expect(nodeVersionOk(out)).toBe(ok);
  });
});

describe("mcpConfigJson", () => {
  it("matches mcp.json shape", () => {
    expect(JSON.parse(mcpConfigJson("0.1.0", "/p"))).toEqual({
      mcpServers: { "code-embed": { command: "npx", args: ["-y", "code-embed@0.1.0", "mcp", "--root", "/p"] } },
    });
  });
});

describe("installCommand", () => {
  it("pins version", () => {
    expect(installCommand("0.1.0")).toBe("npm i -g code-embed@0.1.0");
  });
});

describe("selectionLineRange", () => {
  it("converts to 1-based inclusive", () => {
    expect(selectionLineRange({ start: pos(2, 4), end: pos(5, 3), isEmpty: false })).toEqual({ startLine: 3, endLine: 6 });
  });
  it("excludes line when selection ends at column 0", () => {
    expect(selectionLineRange({ start: pos(2, 0), end: pos(5, 0), isEmpty: false })).toEqual({ startLine: 3, endLine: 5 });
  });
  it("empty selection is the cursor line", () => {
    expect(selectionLineRange({ start: pos(7, 0), end: pos(7, 0), isEmpty: true })).toEqual({ startLine: 8, endLine: 8 });
  });
});
