import type * as vscode from "vscode";

export const ENGINE_ENTRY = "dist/engine/cli.js";

export function engineEntry(_ctx: vscode.ExtensionContext): string {
  throw new Error("not implemented: engine/paths.engineEntry");
}

export function engineLaunch(
  _ctx: vscode.ExtensionContext,
  _args: string[],
): { command: string; args: string[]; env: Record<string, string> } {
  throw new Error("not implemented: engine/paths.engineLaunch");
}
