import * as vscode from "vscode";
import {
  EngineRpcError,
  ToolInputError,
  formatForAgent,
  toFindSimilarParams,
  toSearchParams,
  type FindSimilarToolInput,
  type SearchResponse,
  type SearchToolInput,
} from "@code-embed/protocol";
import type { EngineClient } from "../engine/types";
import { engineLaunch } from "../engine/paths";

function abortSignal(token: vscode.CancellationToken): AbortSignal {
  const ac = new AbortController();
  if (token.isCancellationRequested) ac.abort();
  else token.onCancellationRequested(() => ac.abort());
  return ac.signal;
}

function text(value: string): vscode.LanguageModelToolResult {
  return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(value)]);
}

function errorText(e: unknown): string {
  if (e instanceof ToolInputError) return `Invalid input: ${e.message}`;
  if (e instanceof EngineRpcError) return `Code Embed error: ${e.message}`;
  return `Code Embed error: ${e instanceof Error ? e.message : String(e)}`;
}

function tool<I>(
  run: (input: I, signal: AbortSignal) => Promise<SearchResponse>,
  message: (input: I) => string,
): vscode.LanguageModelTool<I> {
  return {
    prepareInvocation(options) {
      return { invocationMessage: message(options.input) };
    },
    async invoke(options, token) {
      try {
        return text(formatForAgent(await run(options.input, abortSignal(token))));
      } catch (e) {
        if (token.isCancellationRequested) throw e;
        return text(errorText(e));
      }
    },
  };
}

export function registerAgentTools(ctx: vscode.ExtensionContext, client: EngineClient): void {
  ctx.subscriptions.push(
    vscode.lm.registerTool(
      "code-embed_search",
      tool<SearchToolInput>(
        (input, signal) => client.search(toSearchParams(input), signal),
        (input) => `Searching code: ${input?.query ?? ""}`,
      ),
    ),
    vscode.lm.registerTool(
      "code-embed_find_similar",
      tool<FindSimilarToolInput>(
        (input, signal) => client.findSimilar(toFindSimilarParams(input), signal),
        (input) => (input && "path" in input ? `Finding code similar to ${input.path}` : "Finding similar code"),
      ),
    ),
  );
}

export function registerMcpProvider(ctx: vscode.ExtensionContext): void {
  const changed = new vscode.EventEmitter<void>();
  ctx.subscriptions.push(
    changed,
    vscode.workspace.onDidChangeWorkspaceFolders(() => changed.fire()),
    vscode.lm.registerMcpServerDefinitionProvider("codeEmbed.mcp", {
      onDidChangeMcpServerDefinitions: changed.event,
      provideMcpServerDefinitions() {
        return (vscode.workspace.workspaceFolders ?? []).map((folder) => {
          const launch = engineLaunch(ctx, ["mcp", "--root", folder.uri.fsPath]);
          return new vscode.McpStdioServerDefinition(`Code Embed (${folder.name})`, launch.command, launch.args, launch.env);
        });
      },
    }),
  );
}
