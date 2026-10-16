import * as vscode from "vscode";
import type { IndexStatus } from "@code-embed/protocol";
import type { ClientState, EngineClient } from "./engine/types";

export interface StatusBarView {
  text: string;
  tooltip: string;
  error: boolean;
}

export function statusBarView(state: ClientState, s: IndexStatus | undefined): StatusBarView {
  const dest = s ? (s.remote ? (s.host ?? "remote") : "local") : "local";
  const wrap = (label: string, tooltip: string, error = false): StatusBarView => ({
    text: `$(search) ${label} · ${dest}`,
    tooltip,
    error,
  });
  if (state === "failed") return wrap("error", "Engine failed to start. Click to open the panel.", true);
  if (state === "starting" || state === "restarting") return wrap("starting", "Engine is starting");
  if (state === "stopped" || !s) return wrap("stopped", "Engine is not running");

  const details = [
    `Files: ${s.files}, chunks: ${s.chunks}, embedded: ${s.embedded}`,
    `Phase: ${s.phase}`,
    `Embeddings: ${s.remote ? `sent to ${s.host ?? "remote host"} (${s.provider})` : `local (${s.model ?? s.provider})`}`,
    ...(s.lastError ? [`Last error: ${s.lastError}`] : []),
  ].join("\n");

  if (s.phase === "error" || s.lastError) return wrap("error", details, true);
  if (s.lexicalOnly) return wrap("lexical only", details);
  if (s.phase === "paused") return wrap("paused", details);
  if (s.phase === "queued") return wrap("queued", `${details}\nWaiting for another project to finish with the local model.`);
  if (s.phase === "idle") return wrap("idle", details);
  if (s.phase === "model-download") return wrap("downloading model", details);
  const pct = s.chunks > 0 ? Math.min(100, Math.floor((s.embedded / s.chunks) * 100)) : 0;
  return wrap(`indexing ${pct}%`, details);
}

export function registerStatusBar(ctx: vscode.ExtensionContext, client: EngineClient): void {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  item.command = "codeEmbed.focus";
  const render = () => {
    const v = statusBarView(client.state, client.lastStatus);
    item.text = v.text;
    item.tooltip = v.tooltip;
    item.backgroundColor = v.error ? new vscode.ThemeColor("statusBarItem.errorBackground") : undefined;
  };
  render();
  item.show();
  ctx.subscriptions.push(item, client.onStatus(render), client.onDidChangeState(render));
}
