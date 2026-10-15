import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import type { ModelListItem, ProviderConfig, ProviderListItem } from "@code-embed/protocol/rpc";
import type { EngineClient, EngineSupervisor } from "../engine/types";
import { buildHtml } from "../panel";
import { SECTION } from "../settings";
import { SETTING_KEYS, type HostToSettings, type ProviderRow, type Scope, type SettingsAction, type SettingsState, type SettingsToHost } from "./messages";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const KEY_PREFIX = "codeEmbed.apiKey.";

type Providers = Record<string, ProviderConfig>;

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

export function providerRows(engine: ProviderListItem[], editor: Providers, withKey: ReadonlySet<string>): ProviderRow[] {
  const rows: ProviderRow[] = [{ name: "local", model: "", remote: false, source: "builtin", hasKey: false }];
  for (const p of engine) {
    if (p.name === "local" || p.source === "editor" || p.name in editor) continue;
    rows.push({ name: p.name, model: p.model, baseUrl: p.baseUrl, remote: p.remote, host: p.host, source: p.source, hasKey: withKey.has(p.name) });
  }
  for (const [name, config] of Object.entries(editor)) {
    const host = hostOf(config.base_url);
    rows.push({
      name,
      model: config.model,
      baseUrl: config.base_url,
      remote: host === undefined || !LOCAL_HOSTS.has(host),
      host,
      source: "editor",
      config,
      hasKey: withKey.has(name),
    });
  }
  return rows;
}

function hasWorkspace(): boolean {
  const folders = vscode.workspace.workspaceFolders as readonly vscode.WorkspaceFolder[] | undefined;
  return (folders?.length ?? 0) > 0;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

type PanelLike = Pick<vscode.WebviewPanel, "webview" | "onDidDispose" | "reveal" | "dispose"> & { iconPath?: vscode.WebviewPanel["iconPath"] };

export class SettingsPage {
  private static current: SettingsPage | undefined;

  static show(ctx: vscode.ExtensionContext, client: EngineClient, supervisor: EngineSupervisor): void {
    if (SettingsPage.current) {
      SettingsPage.current.panel.reveal();
      return;
    }
    const panel = vscode.window.createWebviewPanel("codeEmbed.settings", "Code Embed Settings", vscode.ViewColumn.Active, {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(ctx.extensionUri, "dist")],
    });
    SettingsPage.current = new SettingsPage(ctx, client, supervisor, panel);
  }

  private scope: Scope = hasWorkspace() ? "workspace" : "user";
  private models: ModelListItem[] | null = null;
  private engineProviders: ProviderListItem[] = [];
  private readonly subs: vscode.Disposable[] = [];

  constructor(
    private readonly ctx: vscode.ExtensionContext,
    private readonly client: EngineClient,
    private readonly supervisor: EngineSupervisor,
    private readonly panel: PanelLike,
  ) {
    panel.iconPath = vscode.Uri.joinPath(ctx.extensionUri, "media", "icon.svg");
    panel.webview.html = buildHtml(panel.webview, ctx.extensionUri, randomBytes(16).toString("hex"), "settings");
    this.subs.push(
      panel.webview.onDidReceiveMessage((m: SettingsToHost) => this.onMessage(m)),
      panel.onDidDispose(() => this.dispose()),
      client.onStatus(() => this.postEngine()),
      client.onDidChangeState((s) => {
        this.postEngine();
        if (s === "ready") void this.refreshEngineLists();
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration(SECTION)) void this.sendState();
      }),
      ctx.secrets.onDidChange((e) => {
        if (e.key.startsWith(KEY_PREFIX)) void this.sendState();
      }),
    );
  }

  async onMessage(msg: SettingsToHost): Promise<void> {
    try {
      await this.handle(msg);
    } catch (e) {
      this.post({ type: "error", message: errMsg(e) });
    }
  }

  private async handle(msg: SettingsToHost): Promise<void> {
    switch (msg.type) {
      case "ready":
        this.postEngine();
        await this.sendState();
        await this.refreshEngineLists();
        return;
      case "setScope":
        this.scope = msg.scope === "workspace" && hasWorkspace() ? "workspace" : "user";
        await this.sendState();
        return;
      case "update":
        if (msg.key === "model.id" && msg.value !== undefined && msg.value !== this.config().get("model.id") && !(await this.confirmSwitch(String(msg.value)))) {
          await this.sendState();
          return;
        }
        await this.config().update(msg.key, msg.value ?? undefined, this.target());
        return;
      case "useProvider":
        if (!(await this.confirmSwitch(msg.name === "local" ? "the built-in model" : msg.name))) return;
        await this.config().update("embedding.provider", msg.name, this.target());
        await this.supervisor.restart();
        return;
      case "saveProvider":
        await this.saveProvider(msg.name, msg.config, msg.previousName, msg.apiKey);
        return;
      case "deleteProvider":
        await this.deleteProvider(msg.name);
        return;
      case "setApiKey":
        if (msg.key) await this.ctx.secrets.store(KEY_PREFIX + msg.name, msg.key);
        else await this.ctx.secrets.delete(KEY_PREFIX + msg.name);
        await this.supervisor.restart();
        return;
      case "testProvider":
        try {
          this.post({ type: "testResult", name: msg.name, result: await this.client.testProvider({ name: msg.name }) });
        } catch (e) {
          this.post({ type: "testResult", name: msg.name, error: errMsg(e) });
        }
        return;
      case "browseArchive": {
        const picked = await vscode.window.showOpenDialog({ canSelectFiles: true, canSelectMany: false, openLabel: "Use archive" });
        if (picked?.[0]) await this.config().update("model.offlineArchive", picked[0].fsPath, this.target());
        return;
      }
      case "action":
        await this.action(msg.action);
        return;
    }
  }

  private async action(action: SettingsAction): Promise<void> {
    switch (action) {
      case "reindex":
        await this.client.rebuild({ full: false });
        return;
      case "rebuild": {
        const ok = "Rebuild";
        const choice = await vscode.window.showWarningMessage("Drop the index and rebuild it from scratch?", { modal: true }, ok);
        if (choice === ok) await this.client.rebuild({ full: true });
        return;
      }
      case "pause":
        await this.client.pause();
        return;
      case "resume":
        await this.client.resume();
        return;
      case "openJson":
        await vscode.commands.executeCommand(
          this.scope === "workspace" ? "workbench.action.openWorkspaceSettingsFile" : "workbench.action.openSettingsJson",
        );
        return;
      default:
        await vscode.commands.executeCommand(`codeEmbed.${action}`);
    }
  }

  // Vectors from different models are incompatible, so a switch re-embeds the whole index.
  private async confirmSwitch(target: string): Promise<boolean> {
    const model = this.models?.find((m) => m.id === target);
    const download = model && !model.installed ? ` The model is downloaded first (${model.sizeMb >= 1024 ? `${(model.sizeMb / 1024).toFixed(1)} GB` : `${model.sizeMb} MB`}).` : "";
    const ok = "Switch";
    const choice = await vscode.window.showWarningMessage(
      `Switch embeddings to ${target}?`,
      { modal: true, detail: `All code will be embedded again.${download} Keyword search keeps working meanwhile.` },
      ok,
    );
    return choice === ok;
  }

  private async saveProvider(name: string, config: ProviderConfig, previousName?: string, apiKey?: string): Promise<void> {
    const renamed = previousName !== undefined && previousName !== name;
    let keyChanged = Boolean(apiKey);
    if (renamed) {
      const wasActive = this.config().get<string>("embedding.provider") === previousName;
      await this.removeFromSettings(previousName);
      const oldKey = await this.ctx.secrets.get(KEY_PREFIX + previousName);
      if (oldKey) {
        if (!apiKey) await this.ctx.secrets.store(KEY_PREFIX + name, oldKey);
        await this.ctx.secrets.delete(KEY_PREFIX + previousName);
        keyChanged = true;
      }
      if (wasActive) await this.config().update("embedding.provider", name, this.target());
    }
    const inspect = this.config().inspect<Providers>("providers");
    const current = { ...((this.scope === "workspace" ? inspect?.workspaceValue : inspect?.globalValue) ?? {}) };
    current[name] = config;
    await this.config().update("providers", current, this.target());
    if (apiKey) await this.ctx.secrets.store(KEY_PREFIX + name, apiKey);
    if (keyChanged) await this.supervisor.restart();
  }

  private async deleteProvider(name: string): Promise<void> {
    await this.removeFromSettings(name);
    const inspect = this.config().inspect<string>("embedding.provider");
    if (inspect?.workspaceValue === name) await this.config().update("embedding.provider", undefined, vscode.ConfigurationTarget.Workspace);
    if (inspect?.globalValue === name) await this.config().update("embedding.provider", undefined, vscode.ConfigurationTarget.Global);
    if (await this.ctx.secrets.get(KEY_PREFIX + name)) {
      await this.ctx.secrets.delete(KEY_PREFIX + name);
      await this.supervisor.restart();
    }
  }

  private async removeFromSettings(name: string): Promise<void> {
    const inspect = this.config().inspect<Providers>("providers");
    const scopes: [Providers | undefined, vscode.ConfigurationTarget][] = [
      [inspect?.workspaceValue, vscode.ConfigurationTarget.Workspace],
      [inspect?.globalValue, vscode.ConfigurationTarget.Global],
    ];
    for (const [value, target] of scopes) {
      if (!value || !(name in value)) continue;
      const { [name]: _removed, ...rest } = value;
      await this.config().update("providers", Object.keys(rest).length > 0 ? rest : undefined, target);
    }
  }

  private async refreshEngineLists(): Promise<void> {
    if (this.client.state !== "ready") return;
    const [models, providers] = await Promise.allSettled([this.client.listModels(), this.client.listProviders()]);
    this.models = models.status === "fulfilled" ? models.value : null;
    this.engineProviders = providers.status === "fulfilled" ? providers.value : [];
    await this.sendState();
  }

  async sendState(): Promise<void> {
    const cfg = this.config();
    const settings = Object.fromEntries(
      SETTING_KEYS.map((key) => {
        const i = cfg.inspect(key);
        return [key, { value: cfg.get(key), defaultValue: i?.defaultValue, user: i?.globalValue, workspace: i?.workspaceValue }];
      }),
    ) as SettingsState["settings"];
    const editor = cfg.get<Providers>("providers") ?? {};
    const names = new Set([...Object.keys(editor), ...this.engineProviders.map((p) => p.name)]);
    const withKey = new Set<string>();
    for (const name of names) if (await this.ctx.secrets.get(KEY_PREFIX + name)) withKey.add(name);
    this.post({
      type: "state",
      state: {
        scope: this.scope,
        hasWorkspace: hasWorkspace(),
        settings,
        providers: providerRows(this.engineProviders, editor, withKey),
        models: this.models,
      },
    });
  }

  private postEngine(): void {
    this.post({ type: "engine", engine: this.client.state, status: this.client.lastStatus });
  }

  private config(): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration(SECTION);
  }

  private target(): vscode.ConfigurationTarget {
    return this.scope === "workspace" ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
  }

  private post(msg: HostToSettings): void {
    void this.panel.webview.postMessage(msg);
  }

  private dispose(): void {
    if (SettingsPage.current === this) SettingsPage.current = undefined;
    this.subs.forEach((d) => d.dispose());
  }
}
