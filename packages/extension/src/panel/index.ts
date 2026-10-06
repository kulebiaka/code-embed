import type * as vscode from "vscode";
import type { EngineClient } from "../engine/types";
import type { PanelController } from "./types";

export function registerPanel(_ctx: vscode.ExtensionContext, _client: EngineClient): PanelController {
  throw new Error("not implemented: panel.registerPanel");
}
