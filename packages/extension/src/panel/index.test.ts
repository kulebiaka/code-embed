import { beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import type { SearchResponse } from "@code-embed/protocol/rpc";
import type { EngineClient } from "../engine/types";
import type { HostToWebview } from "./messages";
import { buildHtml, PanelProvider } from "./index";

const resp: SearchResponse = { results: [], partial: false, tookMs: 1 };

function setup() {
  const posted: HostToWebview[] = [];
  let handler: (m: unknown) => unknown = () => undefined;
  const webview = {
    options: {},
    html: "",
    cspSource: "vscode-resource:",
    asWebviewUri: (u: vscode.Uri) => u,
    postMessage: vi.fn(async (m: HostToWebview) => {
      posted.push(m);
      return true;
    }),
    onDidReceiveMessage: (cb: (m: unknown) => unknown) => {
      handler = cb;
      return { dispose() {} };
    },
  };
  const view = { webview, onDidDispose: vi.fn() } as unknown as vscode.WebviewView;
  const signals: AbortSignal[] = [];
  const resolvers: ((r: SearchResponse) => void)[] = [];
  const client = {
    lastStatus: undefined,
    onStatus: vi.fn(),
    search: vi.fn((_p: unknown, signal?: AbortSignal) => {
      signals.push(signal!);
      return new Promise<SearchResponse>((res) => resolvers.push(res));
    }),
  } as unknown as EngineClient;
  const ctx = { extensionUri: vscode.Uri.file("/ext"), subscriptions: [] } as unknown as vscode.ExtensionContext;
  const provider = new PanelProvider(ctx, client);
  provider.resolveWebviewView(view);
  return { provider, webview, posted, signals, resolvers, client, send: (m: unknown) => handler(m) };
}

describe("panel host", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(vscode.workspace, "getConfiguration").mockReturnValue({
      get: (k: string, d: unknown) => (k === "search.defaultMode" ? "semantic" : d),
    } as never);
    vi.spyOn(vscode.commands, "executeCommand").mockResolvedValue(undefined as never);
  });

  it("builds html with nonce CSP and local resources only", () => {
    const html = buildHtml({ cspSource: "vscode-resource:", asWebviewUri: (u: vscode.Uri) => u } as never, vscode.Uri.file("/ext"), "abc");
    expect(html).toContain("script-src 'nonce-abc'");
    expect(html).toContain("default-src 'none'");
    expect(html).toContain('nonce="abc" src="file:///ext/dist/webview.js"');
    expect(html).not.toMatch(/https?:\/\//);
  });

  it("sends config on ready", async () => {
    const t = setup();
    await t.send({ type: "ready" });
    expect(t.posted[0]).toEqual({ type: "config", defaultMode: "semantic", top: 20 });
  });

  it("routes search to the client and posts results", async () => {
    const t = setup();
    await t.send({ type: "ready" });
    const p = t.send({ type: "search", requestId: 4, query: "q", mode: "lexical", include: ["a"], exclude: [], lang: "ts" });
    expect(t.client.search).toHaveBeenCalledWith({ query: "q", mode: "lexical", include: ["a"], exclude: [], lang: "ts", top: 20 }, expect.any(AbortSignal));
    t.resolvers[0]!(resp);
    await p;
    expect(t.posted.at(-1)).toEqual({ type: "results", requestId: 4, query: "q", response: resp });
  });

  it("aborts on cancel and suppresses the response", async () => {
    const t = setup();
    await t.send({ type: "ready" });
    const p = t.send({ type: "search", requestId: 1, query: "q", mode: "hybrid", include: [], exclude: [] });
    await t.send({ type: "cancel", requestId: 1 });
    expect(t.signals[0]!.aborted).toBe(true);
    t.resolvers[0]!(resp);
    await p;
    expect(t.posted.filter((m) => m.type === "results")).toHaveLength(0);
  });

  it("posts errors", async () => {
    const t = setup();
    await t.send({ type: "ready" });
    vi.mocked(t.client.search).mockRejectedValueOnce(new Error("boom"));
    await t.send({ type: "search", requestId: 2, query: "q", mode: "hybrid", include: [], exclude: [] });
    expect(t.posted.at(-1)).toEqual({ type: "error", requestId: 2, message: "boom" });
  });

  it("queues showSimilar until the webview is ready", async () => {
    const t = setup();
    await t.provider.showSimilar("Similar", resp);
    expect(t.posted).toHaveLength(0);
    await t.send({ type: "ready" });
    expect(t.posted.at(-1)).toEqual({ type: "results", requestId: 0, query: "", response: resp, title: "Similar" });
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith("codeEmbed.panel.focus");
  });

  it("focus and runQuery notify the webview", async () => {
    const t = setup();
    await t.send({ type: "ready" });
    await t.provider.focus();
    await t.provider.runQuery("abc");
    expect(t.posted.slice(-2)).toEqual([{ type: "focusInput" }, { type: "focusInput", query: "abc" }]);
  });

  it("opens a file with the selected range", async () => {
    const t = setup();
    const doc = {};
    vi.spyOn(vscode.workspace, "workspaceFolders", "get").mockReturnValue([{ uri: vscode.Uri.file("/root") }] as never);
    const openDoc = vi.spyOn(vscode.workspace, "openTextDocument").mockResolvedValue(doc as never);
    const show = vi.spyOn(vscode.window, "showTextDocument").mockResolvedValue(undefined as never);
    await t.send({ type: "open", path: "src/a.ts", range: { startLine: 3, endLine: 5, startByte: 0, endByte: 1 } });
    expect((openDoc.mock.calls[0]![0] as vscode.Uri).path).toBe("/root/src/a.ts");
    const opts = show.mock.calls[0]![1] as { selection: vscode.Range };
    expect([opts.selection.start.line, opts.selection.end.line]).toEqual([2, 5]);
  });
});
