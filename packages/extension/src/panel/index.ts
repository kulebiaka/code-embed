import { randomBytes } from "node:crypto";
import { isAbsolute } from "node:path";
import * as vscode from "vscode";
import type { SearchMode, SearchResponse } from "@code-embed/protocol/rpc";
import type { EngineClient } from "../engine/types";
import type { HostToWebview, WebviewToHost } from "./messages";
import type { PanelController } from "./types";

const VIEW_ID = "codeEmbed.panel";

export function buildHtml(webview: Pick<vscode.Webview, "cspSource" | "asWebviewUri">, extensionUri: vscode.Uri, nonce: string): string {
  const script = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "dist", "webview.js"));
  const css = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "dist", "webview.css"));
  const csp = `default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}'; font-src ${webview.cspSource}; img-src ${webview.cspSource};`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${css}">
</head>
<body>
<div id="app"></div>
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
}

export class PanelProvider implements vscode.WebviewViewProvider, PanelController {
  private view: vscode.WebviewView | undefined;
  private ready = false;
  private pending: HostToWebview[] = [];
  private readonly inflight = new Map<number, AbortController>();

  constructor(
    private readonly ctx: vscode.ExtensionContext,
    private readonly client: EngineClient,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    this.ready = false;
    const dist = vscode.Uri.joinPath(this.ctx.extensionUri, "dist");
    view.webview.options = { enableScripts: true, localResourceRoots: [dist] };
    view.webview.html = buildHtml(view.webview, this.ctx.extensionUri, randomBytes(16).toString("hex"));
    const sub = view.webview.onDidReceiveMessage((m: WebviewToHost) => this.onMessage(m));
    view.onDidDispose(() => {
      sub.dispose();
      this.abortAll();
      if (this.view === view) this.view = undefined;
      this.ready = false;
    });
  }

  attachStatus(): vscode.Disposable {
    return this.client.onStatus((status) => this.post({ type: "status", status }, false));
  }

  async focus(): Promise<void> {
    await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
    this.post({ type: "focusInput" });
  }

  async runQuery(query: string): Promise<void> {
    await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
    this.post({ type: "focusInput", query });
  }

  async showSimilar(title: string, resp: SearchResponse): Promise<void> {
    await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
    this.post({ type: "results", requestId: 0, query: "", response: resp, title });
  }

  async onMessage(msg: WebviewToHost): Promise<void> {
    switch (msg.type) {
      case "ready":
        this.ready = true;
        this.sendInitial();
        return;
      case "cancel":
        this.inflight.get(msg.requestId)?.abort();
        return;
      case "search":
        await this.search(msg);
        return;
      case "open":
        await this.open(msg.path, msg.range);
        return;
    }
  }

  private sendInitial(): void {
    const cfg = vscode.workspace.getConfiguration("codeEmbed");
    const defaultMode = cfg.get<SearchMode>("search.defaultMode", "hybrid");
    const top = cfg.get<number>("search.top", 20);
    this.raw({ type: "config", defaultMode, top });
    const status = this.client.lastStatus;
    if (status) this.raw({ type: "status", status });
    const queued = this.pending;
    this.pending = [];
    for (const m of queued) this.raw(m);
  }

  private async search(msg: Extract<WebviewToHost, { type: "search" }>): Promise<void> {
    const ctl = new AbortController();
    this.inflight.set(msg.requestId, ctl);
    const top = vscode.workspace.getConfiguration("codeEmbed").get<number>("search.top", 20);
    try {
      const response = await this.client.search(
        { query: msg.query, mode: msg.mode, include: msg.include, exclude: msg.exclude, lang: msg.lang, top },
        ctl.signal,
      );
      if (!ctl.signal.aborted) this.post({ type: "results", requestId: msg.requestId, query: msg.query, response });
    } catch (err) {
      if (!ctl.signal.aborted) {
        this.post({ type: "error", requestId: msg.requestId, message: err instanceof Error ? err.message : String(err) });
      }
    } finally {
      this.inflight.delete(msg.requestId);
    }
  }

  private async open(path: string, range: { startLine: number; endLine: number }): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    const uri = isAbsolute(path) || !folder ? vscode.Uri.file(path) : vscode.Uri.joinPath(folder.uri, path);
    const doc = await vscode.workspace.openTextDocument(uri);
    const sel = new vscode.Range(range.startLine - 1, 0, range.endLine, 0);
    await vscode.window.showTextDocument(doc, { selection: sel, preview: true });
  }

  private abortAll(): void {
    for (const c of this.inflight.values()) c.abort();
    this.inflight.clear();
  }

  private post(msg: HostToWebview, queue = true): void {
    if (this.view && this.ready) this.raw(msg);
    else if (queue) this.pending.push(msg);
  }

  private raw(msg: HostToWebview): void {
    void this.view?.webview.postMessage(msg);
  }
}

export function registerPanel(ctx: vscode.ExtensionContext, client: EngineClient): PanelController {
  const provider = new PanelProvider(ctx, client);
  ctx.subscriptions.push(
    vscode.window.registerWebviewViewProvider(VIEW_ID, provider, { webviewOptions: { retainContextWhenHidden: true } }),
    provider.attachStatus(),
  );
  return provider;
}
