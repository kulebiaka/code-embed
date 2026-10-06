import * as vscode from "vscode";
import { registerAgentTools, registerMcpProvider } from "./agent";
import { registerCommands } from "./commands";
import { createEngineSupervisor } from "./engine/supervisor";
import type { EngineSupervisor } from "./engine/types";
import { registerPanel } from "./panel";
import { registerStatusBar } from "./statusbar";

let supervisor: EngineSupervisor | undefined;

export function activate(ctx: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel("Code Embed");
  ctx.subscriptions.push(output);
  const sup = createEngineSupervisor(ctx, output);
  supervisor = sup;
  const client = sup.client;
  const panel = registerPanel(ctx, client);
  registerStatusBar(ctx, client);
  registerCommands(ctx, { client, panel, supervisor: sup, output });
  registerAgentTools(ctx, client);
  registerMcpProvider(ctx);
  sup.start().catch((err: unknown) => {
    output.appendLine(`Engine failed to start: ${err instanceof Error ? err.message : String(err)}`);
  });
}

export function deactivate(): void {
  supervisor?.dispose();
  supervisor = undefined;
}
