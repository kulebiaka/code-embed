import type * as vscode from "vscode";
import type { EngineClient, EngineSupervisor } from "../engine/types";
import type { PanelController } from "../panel/types";

export interface CommandDeps {
  client: EngineClient;
  panel: PanelController;
  supervisor: EngineSupervisor;
  output: vscode.OutputChannel;
}

export function registerCommands(_ctx: vscode.ExtensionContext, _deps: CommandDeps): void {
  throw new Error("not implemented: commands.registerCommands");
}
