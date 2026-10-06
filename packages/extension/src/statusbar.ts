import type * as vscode from "vscode";
import type { EngineClient } from "./engine/types";

export function registerStatusBar(_ctx: vscode.ExtensionContext, _client: EngineClient): void {
  throw new Error("not implemented: statusbar.registerStatusBar");
}
