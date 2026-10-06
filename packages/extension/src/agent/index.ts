import type * as vscode from "vscode";
import type { EngineClient } from "../engine/types";

export function registerAgentTools(_ctx: vscode.ExtensionContext, _client: EngineClient): void {
  throw new Error("not implemented: agent.registerAgentTools");
}

export function registerMcpProvider(_ctx: vscode.ExtensionContext): void {
  throw new Error("not implemented: agent.registerMcpProvider");
}
