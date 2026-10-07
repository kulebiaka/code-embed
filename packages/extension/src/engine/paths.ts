import * as path from "node:path";
import * as vscode from "vscode";

export const ENGINE_ENTRY = "dist/engine/cli.js";

export function engineEntry(ctx: vscode.ExtensionContext): string {
  return path.join(ctx.extensionPath, ENGINE_ENTRY);
}

export function engineLaunch(
  ctx: vscode.ExtensionContext,
  args: string[],
): { command: string; args: string[]; env: Record<string, string> } {
  const env: Record<string, string> = { ELECTRON_RUN_AS_NODE: "1" };
  const proxy = vscode.workspace.getConfiguration("http").get<string>("proxy") || process.env.HTTPS_PROXY;
  if (proxy) env.HTTPS_PROXY = proxy;
  return { command: process.execPath, args: [engineEntry(ctx), ...args], env };
}
