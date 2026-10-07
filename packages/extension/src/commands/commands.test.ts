import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import * as vscode from "vscode";
import { workspaceRoot } from "../settings";
import { installCommand, mcpConfigJson, nodeVersionOk, resultSelection, rootRelativePath, selectionLineRange } from "./util";

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

describe("mcpConfigJson with project root", () => {
  afterEach(() => {
    (vscode.workspace as { workspaceFolders: unknown }).workspaceFolders = undefined;
  });
  it("embeds the project root, not the workspace folder", () => {
    const repo = mkdtempSync(join(tmpdir(), "ce-cfg-"));
    mkdirSync(join(repo, ".git"));
    mkdirSync(join(repo, "pkg"));
    (vscode.workspace as { workspaceFolders: unknown }).workspaceFolders = [{ uri: vscode.Uri.file(join(repo, "pkg")) }];
    const json = JSON.parse(mcpConfigJson("0.1.0", workspaceRoot()!));
    expect(json.mcpServers["code-embed"].args.slice(-2)).toEqual(["--root", repo]);
  });
});

describe("resultSelection", () => {
  const lines = ["aaa", "bb", "cccc", "d"];
  const doc = { lineCount: lines.length, lineAt: (n: number) => ({ text: lines[n]! }) };
  it("spans start of startLine to end of endLine inclusive", () => {
    expect(resultSelection({ startLine: 2, endLine: 3 }, doc)).toEqual({ startLine: 1, startCharacter: 0, endLine: 2, endCharacter: 4 });
  });
  it("handles a single line", () => {
    expect(resultSelection({ startLine: 1, endLine: 1 }, doc)).toEqual({ startLine: 0, startCharacter: 0, endLine: 0, endCharacter: 3 });
  });
  it("clamps endLine beyond lineCount", () => {
    expect(resultSelection({ startLine: 3, endLine: 99 }, doc)).toEqual({ startLine: 2, startCharacter: 0, endLine: 3, endCharacter: 1 });
  });
});

describe("rootRelativePath", () => {
  it.each([
    ["/r", "/r/src/a.ts", "src/a.ts"],
    ["/r", "/r/a.ts", "a.ts"],
    ["/r/pkg", "/r/other/a.ts", undefined],
    ["/r/pkg", "/r/pkg-x/a.ts", undefined],
    ["/r", "/r", undefined],
    ["/r", "/elsewhere/a.ts", undefined],
  ])("%s + %s", (root, p, want) => {
    expect(rootRelativePath(root, p)).toBe(want);
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
