import { randomBytes } from "node:crypto";
import { isAbsolute, join } from "node:path";
import * as vscode from "vscode";
import type { LineRange, SearchMode, SearchResponse } from "@code-embed/protocol/rpc";
import { resultSelection } from "../commands/util";
import { workspaceRoot } from "../settings";
import type { EngineClient } from "../engine/types";
import type { HostToWebview, PanelCommand, WebviewToHost } from "./messages";
import type { PanelController } from "./types";

const VIEW_ID = "codeEmbed.panel";

export function buildHtml(
  webview: Pick<vscode.Webview, "cspSource" | "asWebviewUri">,
  extensionUri: vscode.Uri,
  nonce: string,
  entry = "webview",
): string {
  const script = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "dist", `${entry}.js`));
  const css = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "dist", `${entry}.css`));
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
    return vscode.Disposable.from(
      this.client.onStatus((status) => this.post({ type: "status", status }, false)),
      this.client.onDidChangeState((state) => this.post({ type: "engine", state }, false)),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("codeEmbed.search")) this.post(this.configMessage(), false);
      }),
    );
  }

  clear(): void {
    this.post({ type: "clear" }, false);
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
        await this.open(msg.path, msg.range, msg.side);
        return;
      case "copy":
        await vscode.env.clipboard.writeText(msg.text);
        vscode.window.setStatusBarMessage(`Copied ${msg.text}`, 2000);
        return;
      case "similar":
        await this.similar(msg.path, msg.range);
        return;
      case "command":
        await this.command(msg.command);
        return;
    }
  }

  private async command(command: PanelCommand): Promise<void> {
    try {
      if (command === "index") await this.client.rebuild({ full: false });
      else await vscode.commands.executeCommand(command === "openSettings" ? "codeEmbed.openSettings" : "codeEmbed.showLog");
    } catch (err) {
      this.post({ type: "error", message: err instanceof Error ? err.message : String(err) });
    }
  }

  private configMessage(): HostToWebview {
    const cfg = vscode.workspace.getConfiguration("codeEmbed");
    return { type: "config", defaultMode: cfg.get<SearchMode>("search.defaultMode", "hybrid"), top: cfg.get<number>("search.top", 20) };
  }

  private sendInitial(): void {
    this.raw(this.configMessage());
    this.raw({ type: "engine", state: this.client.state });
    const status = this.client.lastStatus;
    if (status) this.raw({ type: "status", status });
    const queued = this.pending;
    this.pending = [];
    for (const m of queued) this.raw(m);
  }

  private async search(msg: Extract<WebviewToHost, { type: "search" }>): Promise<void> {
    const ctl = new AbortController();
    this.inflight.set(msg.requestId, ctl);
    const top = msg.top ?? vscode.workspace.getConfiguration("codeEmbed").get<number>("search.top", 20);
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

  private async similar(path: string, range: LineRange): Promise<void> {
    try {
      const resp = await this.client.findSimilar({ path, range });
      await this.showSimilar(`Similar to ${path}:${range.startLine}-${range.endLine}`, resp);
    } catch (err) {
      this.post({ type: "error", message: err instanceof Error ? err.message : String(err) });
    }
  }

  private async open(path: string, range: LineRange, side = false): Promise<void> {
    const root = workspaceRoot();
    const uri = isAbsolute(path) || !root ? vscode.Uri.file(path) : vscode.Uri.file(join(root, path));
    const doc = await vscode.workspace.openTextDocument(uri);
    const s = resultSelection(range, doc);
    const selection = new vscode.Range(s.startLine, s.startCharacter, s.endLine, s.endCharacter);
    await vscode.window.showTextDocument(doc, { selection, preview: true, ...(side ? { viewColumn: vscode.ViewColumn.Beside } : {}) });
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
