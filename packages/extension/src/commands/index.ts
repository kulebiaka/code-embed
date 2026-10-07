import * as path from "node:path";
import * as vscode from "vscode";
import type { SearchResult } from "@code-embed/protocol";
import type { EngineClient, EngineSupervisor } from "../engine/types";
import type { PanelController } from "../panel/types";
import { SECTION, workspaceRoot } from "../settings";
import { installCommand, mcpConfigJson, nodeVersionOk, run, resultSelection, rootRelativePath, selectionLineRange } from "./util";

export interface CommandDeps {
  client: EngineClient;
  panel: PanelController;
  supervisor: EngineSupervisor;
  output: vscode.OutputChannel;
}

const NODE_URL = "https://nodejs.org/en/download";

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function extensionVersion(ctx: vscode.ExtensionContext): string {
  return (ctx.extension.packageJSON as { version: string }).version;
}

export function registerCommands(ctx: vscode.ExtensionContext, deps: CommandDeps): void {
  const { client, panel, supervisor, output } = deps;
  const reg = (id: string, fn: (...args: unknown[]) => unknown) =>
    ctx.subscriptions.push(
      vscode.commands.registerCommand(id, async (...args: unknown[]) => {
        try {
          await fn(...args);
        } catch (e) {
          output.appendLine(`${id}: ${errMsg(e)}`);
          void vscode.window.showErrorMessage(`Code Embed: ${errMsg(e)}`);
        }
      }),
    );

  reg("codeEmbed.focus", () => panel.focus());
  reg("codeEmbed.quickSearch", () => quickSearch(client));
  reg("codeEmbed.findSimilar", () => findSimilar(client, panel));
  reg("codeEmbed.reindex", async () => {
    const pick = await vscode.window.showQuickPick(
      [
        { label: "Reindex changed files", full: false },
        { label: "Full rebuild", description: "Drop and rebuild the whole index", full: true },
      ],
      { placeHolder: "Reindex workspace" },
    );
    if (pick) await client.rebuild({ full: pick.full });
  });
  reg("codeEmbed.installCli", () => installCli(ctx));
  reg("codeEmbed.copyMcpConfig", async () => {
    const root = workspaceRoot();
    if (!root) {
      void vscode.window.showWarningMessage("Code Embed: open a folder first.");
      return;
    }
    await vscode.env.clipboard.writeText(mcpConfigJson(extensionVersion(ctx), root));
    void vscode.window.showInformationMessage("Code Embed: MCP config copied. Paste it into mcp.json.");
  });
  reg("codeEmbed.selectProvider", () => selectProvider(ctx, client, supervisor));
  reg("codeEmbed.selectModel", () => selectModel(client));
  reg("codeEmbed.testProvider", () => testProvider(client));
  reg("codeEmbed.showLog", () => supervisor.showLog());

  const asked = new Set<string>();
  ctx.subscriptions.push(
    client.onStatus((s) => {
      const c = s.consentRequired;
      if (!c || asked.has(c.host)) return;
      asked.add(c.host);
      void askConsent(client, c.host, output);
    }),
  );
}

async function askConsent(client: EngineClient, host: string, output: vscode.OutputChannel): Promise<void> {
  const allow = "Разрешить";
  const choice = await vscode.window.showWarningMessage(
    `Код будет отправлен на ${host}`,
    { modal: true, detail: "Фрагменты кода проекта будут передаваться внешнему сервису для построения эмбеддингов." },
    allow,
  );
  if (choice !== allow) return;
  try {
    await client.grantConsent({ host });
  } catch (e) {
    output.appendLine(`grantConsent: ${errMsg(e)}`);
    void vscode.window.showErrorMessage(`Code Embed: ${errMsg(e)}`);
  }
}

interface ResultItem extends vscode.QuickPickItem {
  result: SearchResult;
}

function toItem(r: SearchResult): ResultItem {
  const first = r.snippet.text.split("\n").find((l) => l.trim()) ?? "";
  return {
    label: r.symbol ?? path.basename(r.path),
    description: `${r.path}:${r.range.startLine}`,
    detail: first.trim(),
    result: r,
  };
}

async function openResult(r: SearchResult): Promise<void> {
  const root = workspaceRoot();
  const file = path.isAbsolute(r.path) || !root ? r.path : path.join(root, r.path);
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
  const s = resultSelection(r.range, doc);
  const selection = new vscode.Range(s.startLine, s.startCharacter, s.endLine, s.endCharacter);
  await vscode.window.showTextDocument(doc, { selection, preview: true });
}

function quickSearch(client: EngineClient): void {
  const qp = vscode.window.createQuickPick<ResultItem>();
  qp.placeholder = "Search code by meaning or keywords";
  qp.matchOnDescription = true;
  qp.matchOnDetail = true;
  let ctrl: AbortController | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const search = async (query: string) => {
    ctrl?.abort();
    const c = new AbortController();
    ctrl = c;
    if (!query.trim()) {
      qp.items = [];
      return;
    }
    qp.busy = true;
    try {
      const resp = await client.search({ query }, c.signal);
      if (!c.signal.aborted) qp.items = resp.results.map(toItem);
    } catch (e) {
      if (!c.signal.aborted) void vscode.window.showErrorMessage(`Code Embed: ${errMsg(e)}`);
    } finally {
      if (ctrl === c) qp.busy = false;
    }
  };

  qp.onDidChangeValue((v) => {
    clearTimeout(timer);
    timer = setTimeout(() => void search(v), 150);
  });
  qp.onDidAccept(() => {
    const item = qp.selectedItems[0];
    qp.hide();
    if (item) void openResult(item.result);
  });
  qp.onDidHide(() => {
    clearTimeout(timer);
    ctrl?.abort();
    qp.dispose();
  });
  qp.show();
}

async function findSimilar(client: EngineClient, panel: PanelController): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    void vscode.window.showWarningMessage("Code Embed: open a file and select code first.");
    return;
  }
  const range = selectionLineRange(editor.selection);
  const root = workspaceRoot();
  const rel = root ? rootRelativePath(root, editor.document.uri.fsPath) : undefined;
  if (rel === undefined) {
    void vscode.window.showWarningMessage("Code Embed: the file is outside the project root.");
    return;
  }
  const resp = await client.findSimilar({ path: rel, range });
  await panel.showSimilar(`${rel}:${range.startLine}-${range.endLine}`, resp);
}

async function installCli(ctx: vscode.ExtensionContext): Promise<void> {
  const cmd = installCommand(extensionVersion(ctx));
  let ok = false;
  try {
    ok = nodeVersionOk(await run("node", ["--version"])) && Boolean((await run("npm", ["--version"])).trim());
  } catch {
    ok = false;
  }
  if (ok) {
    const term = vscode.window.createTerminal("Code Embed CLI");
    term.show();
    term.sendText(cmd);
    return;
  }
  const open = "Open Node.js download";
  const copy = "Copy command";
  const choice = await vscode.window.showErrorMessage(
    `Code Embed: Node.js 22.13+ and npm are required. Install Node (${NODE_URL}), then run: ${cmd}`,
    open,
    copy,
  );
  if (choice === open) await vscode.env.openExternal(vscode.Uri.parse(NODE_URL));
  else if (choice === copy) await vscode.env.clipboard.writeText(cmd);
}

async function selectProvider(
  ctx: vscode.ExtensionContext,
  client: EngineClient,
  supervisor: EngineSupervisor,
): Promise<void> {
  const providers = await client.listProviders();
  const items = [
    { label: "local", description: "Built-in model, nothing leaves the machine", remote: false },
    ...providers
      .filter((p) => p.name !== "local")
      .map((p) => ({
        label: p.name,
        description: `${p.model}${p.remote ? ` -> ${p.host ?? p.baseUrl ?? "remote"}` : " (local server)"}`,
        remote: p.remote,
      })),
  ];
  const pick = await vscode.window.showQuickPick(items, { placeHolder: "Select embedding provider" });
  if (!pick) return;
  if (pick.remote) {
    const key = await vscode.window.showInputBox({
      prompt: `API key for ${pick.label} (leave empty to keep the stored key or use api_key_env)`,
      password: true,
      ignoreFocusOut: true,
    });
    if (key === undefined) return;
    if (key) await ctx.secrets.store(`codeEmbed.apiKey.${pick.label}`, key);
  }
  await vscode.workspace
    .getConfiguration(SECTION)
    .update("embedding.provider", pick.label, vscode.ConfigurationTarget.Workspace);
  await supervisor.restart();
}

async function selectModel(client: EngineClient): Promise<void> {
  const models = await client.listModels();
  const pick = await vscode.window.showQuickPick(
    models.map((m) => ({
      label: m.id,
      description: `${m.dims} dims, ${m.sizeMb} MB, ${m.license}${m.isDefault ? ", default" : ""}`,
      detail: m.installed ? "installed" : "will be downloaded",
    })),
    { placeHolder: "Select local embedding model" },
  );
  if (!pick) return;
  await vscode.workspace
    .getConfiguration(SECTION)
    .update("model.id", pick.label, vscode.ConfigurationTarget.Workspace);
}

async function testProvider(client: EngineClient): Promise<void> {
  const name = vscode.workspace.getConfiguration(SECTION).get<string>("embedding.provider") ?? "local";
  try {
    const r = await client.testProvider({ name });
    void vscode.window.showInformationMessage(`Code Embed: ${name} OK, ${r.dims} dims, ${r.latencyMs} ms`);
  } catch (e) {
    void vscode.window.showErrorMessage(`Code Embed: ${name} failed: ${errMsg(e)}`);
  }
}
