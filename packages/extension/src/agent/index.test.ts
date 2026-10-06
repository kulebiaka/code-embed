import { beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { EngineRpcError } from "@code-embed/protocol";
import type { EngineClient } from "../engine/types";

vi.mock("../engine/paths", () => ({
  engineLaunch: vi.fn((_ctx: unknown, args: string[]) => ({
    command: "/node",
    args: ["/ext/dist/engine/cli.js", ...args],
    env: { ELECTRON_RUN_AS_NODE: "1" },
  })),
}));

import { registerAgentTools, registerMcpProvider } from "./index";

type Tool = {
  invoke(o: { input: unknown }, t: unknown): Promise<{ content: { value: string }[] }>;
  prepareInvocation(o: { input: unknown }): { invocationMessage: string };
};

const ctx = () => ({ subscriptions: [] as { dispose(): void }[] }) as unknown as vscode.ExtensionContext;
const resp = {
  partial: false,
  tookMs: 1,
  results: [
    {
      path: "a.ts",
      lang: "typescript",
      range: { startLine: 1, endLine: 2, startByte: 0, endByte: 0 },
      symbol: "f",
      kind: "function",
      score: 0.9,
      sources: ["lexical"],
      snippet: { text: "code", startLine: 1, highlights: [] },
    },
  ],
};

describe("registerAgentTools", () => {
  const tools = new Map<string, Tool>();
  const client = { search: vi.fn(), findSimilar: vi.fn() };

  beforeEach(() => {
    tools.clear();
    client.search.mockReset().mockResolvedValue(resp);
    client.findSimilar.mockReset().mockResolvedValue(resp);
    vi.spyOn(vscode.lm, "registerTool").mockImplementation(((name: string, t: Tool) => {
      tools.set(name, t);
      return { dispose() {} };
    }) as never);
    registerAgentTools(ctx(), client as unknown as EngineClient);
  });

  it("registers both tools", () => {
    expect([...tools.keys()]).toEqual(["code-embed_search", "code-embed_find_similar"]);
  });

  it("search maps input, forwards abort, formats", async () => {
    const src = new vscode.CancellationTokenSource();
    const r = await tools.get("code-embed_search")!.invoke({ input: { query: "q", top: 3 } }, src.token);
    expect(client.search).toHaveBeenCalledWith({ query: "q", top: 3 }, expect.any(AbortSignal));
    const signal = client.search.mock.calls[0]![1] as AbortSignal;
    expect(signal.aborted).toBe(false);
    src.cancel();
    expect(signal.aborted).toBe(true);
    expect(r.content[0]!.value).toBe("a.ts:1-2  f  (0.90)\n    code");
  });

  it("find_similar maps the location form", async () => {
    const src = new vscode.CancellationTokenSource();
    await tools.get("code-embed_find_similar")!.invoke({ input: { path: "a.ts", start_line: 1, end_line: 4 } }, src.token);
    expect(client.findSimilar).toHaveBeenCalledWith({ path: "a.ts", range: { startLine: 1, endLine: 4 } }, expect.any(AbortSignal));
  });

  it("returns readable text for invalid input and engine errors", async () => {
    const src = new vscode.CancellationTokenSource();
    const bad = await tools.get("code-embed_search")!.invoke({ input: { query: "" } }, src.token);
    expect(bad.content[0]!.value).toMatch(/^Invalid input: /);
    expect(client.search).not.toHaveBeenCalled();
    client.search.mockRejectedValue(new EngineRpcError(-32002, "no index"));
    const err = await tools.get("code-embed_search")!.invoke({ input: { query: "q" } }, src.token);
    expect(err.content[0]!.value).toBe("Code Embed error: no index");
  });

  it("prepareInvocation returns a message", () => {
    expect(tools.get("code-embed_search")!.prepareInvocation({ input: { query: "retry" } }).invocationMessage).toContain("retry");
    expect(
      tools.get("code-embed_find_similar")!.prepareInvocation({ input: { path: "a.ts", start_line: 1, end_line: 2 } }).invocationMessage,
    ).toContain("a.ts");
  });
});

describe("registerMcpProvider", () => {
  it("provides one stdio definition per workspace folder", () => {
    type Def = { label: string; command: string; args: string[]; env: Record<string, unknown> };
    let provider: { provideMcpServerDefinitions(): Def[] } | undefined;
    const registerSpy = vi.spyOn(vscode.lm, "registerMcpServerDefinitionProvider").mockImplementation(((id: string, p: typeof provider) => {
      expect(id).toBe("codeEmbed.mcp");
      provider = p;
      return { dispose() {} };
    }) as never);
    const ws = vscode.workspace as unknown as Record<string, unknown>;
    ws.onDidChangeWorkspaceFolders = vi.fn(() => ({ dispose() {} }));
    ws.workspaceFolders = [
      { name: "one", uri: vscode.Uri.file("/w/one") },
      { name: "two", uri: vscode.Uri.file("/w/two") },
    ];
    registerMcpProvider(ctx());
    expect(registerSpy).toHaveBeenCalled();
    const defs = provider!.provideMcpServerDefinitions();
    expect(defs).toHaveLength(2);
    expect(defs[0]).toBeInstanceOf(vscode.McpStdioServerDefinition);
    expect(defs[0]!.args).toEqual(["/ext/dist/engine/cli.js", "mcp", "--root", "/w/one"]);
    expect(defs[0]!.env.ELECTRON_RUN_AS_NODE).toBe("1");
    expect(defs[1]!.args.slice(-1)).toEqual(["/w/two"]);
    ws.workspaceFolders = undefined;
  });
});
