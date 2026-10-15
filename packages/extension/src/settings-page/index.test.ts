import { beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import type { ProviderConfig } from "@code-embed/protocol/rpc";
import type { EngineClient, EngineSupervisor } from "../engine/types";
import { providerRows, SettingsPage } from "./index";
import type { HostToSettings, SettingsState } from "./messages";

const d = { dispose() {} };
const ollama: ProviderConfig = { kind: "openai", base_url: "http://localhost:11434/v1", model: "nomic-embed-text" };
const voyage: ProviderConfig = { kind: "openai", base_url: "https://api.voyageai.com/v1", model: "voyage-code-3" };

type Store = Record<string, unknown>;

function setup(opts: { user?: Store; workspace?: Store } = {}) {
  const scopes = { user: { ...opts.user } as Store, workspace: { ...opts.workspace } as Store };
  const defaults: Store = { "embedding.provider": "local", "search.top": 20, providers: {} };
  const get = (k: string) =>
    k === "providers"
      ? { ...(scopes.user.providers as object), ...(scopes.workspace.providers as object) }
      : (scopes.workspace[k] ?? scopes.user[k] ?? defaults[k]);
  const update = vi.fn(async (k: string, v: unknown, target: vscode.ConfigurationTarget) => {
    const s = target === vscode.ConfigurationTarget.Workspace ? scopes.workspace : scopes.user;
    if (v === undefined) delete s[k];
    else s[k] = v;
  });
  vi.spyOn(vscode.workspace, "getConfiguration").mockReturnValue({
    get,
    inspect: (k: string) => ({ key: k, defaultValue: defaults[k], globalValue: scopes.user[k], workspaceValue: scopes.workspace[k] }),
    update,
  } as never);
  vi.spyOn(vscode.workspace, "onDidChangeConfiguration").mockReturnValue(d as never);
  vi.spyOn(vscode.workspace, "workspaceFolders", "get").mockReturnValue([{ uri: vscode.Uri.file("/w") }] as never);

  const keys = new Map<string, string>();
  const secrets = {
    get: async (k: string) => keys.get(k),
    store: async (k: string, v: string) => void keys.set(k, v),
    delete: async (k: string) => void keys.delete(k),
    onDidChange: () => d,
  };
  const client = {
    state: "ready",
    lastStatus: undefined,
    onStatus: () => d,
    onDidChangeState: () => d,
    listModels: vi.fn(async () => [{ id: "m1", dims: 8, license: "MIT", sizeMb: 1, installed: true, isDefault: true }]),
    listProviders: vi.fn(async () => [
      { name: "local", kind: "local", model: "m1", remote: false, source: "builtin" },
      { name: "openai", kind: "openai", model: "te3", baseUrl: "https://api.openai.com/v1", remote: true, host: "api.openai.com", source: "user" },
    ]),
    testProvider: vi.fn(),
  } as unknown as EngineClient;
  const supervisor = { restart: vi.fn(async () => undefined) } as unknown as EngineSupervisor;
  const posted: HostToSettings[] = [];
  const panel = {
    webview: {
      html: "",
      cspSource: "vscode-resource:",
      asWebviewUri: (u: vscode.Uri) => u,
      postMessage: async (m: HostToSettings) => posted.push(m),
      onDidReceiveMessage: () => d,
    },
    onDidDispose: () => d,
    reveal: vi.fn(),
    dispose: vi.fn(),
  };
  const ctx = { extensionUri: vscode.Uri.file("/ext"), secrets } as unknown as vscode.ExtensionContext;
  const page = new SettingsPage(ctx, client, supervisor, panel as never);
  const lastState = () => (posted.filter((m) => m.type === "state").at(-1) as { state: SettingsState }).state;
  return { page, scopes, update, keys, client, supervisor, posted, panel, lastState };
}

describe("providerRows", () => {
  it("lists the built-in model first, then engine providers, then editable settings providers", () => {
    const rows = providerRows(
      [
        { name: "local", kind: "local", model: "m", remote: false, source: "builtin" },
        { name: "openai", kind: "openai", model: "te3", remote: true, host: "api.openai.com", source: "user" },
        { name: "ollama", kind: "openai", model: "old", remote: false, source: "user" },
        { name: "stale", kind: "openai", model: "x", remote: true, source: "editor" },
      ],
      { ollama, voyage },
      new Set(["voyage"]),
    );
    expect(rows.map((r) => [r.name, r.source, r.remote, r.hasKey, r.config !== undefined])).toEqual([
      ["local", "builtin", false, false, false],
      ["openai", "user", true, false, false],
      ["ollama", "editor", false, false, true],
      ["voyage", "editor", true, true, true],
    ]);
    expect(rows[3]!.host).toBe("api.voyageai.com");
  });
});

describe("settings page host", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("renders the page and sends engine state, settings, providers and models on ready", async () => {
    const t = setup({ user: { "search.top": 50 }, workspace: { providers: { voyage } } });
    t.keys.set("codeEmbed.apiKey.voyage", "k");
    expect(t.panel.webview.html).toContain("dist/settings.js");
    await t.page.onMessage({ type: "ready" });
    expect(t.posted[0]).toMatchObject({ type: "engine", engine: "ready" });
    const s = t.lastState();
    expect(s.scope).toBe("workspace");
    expect(s.settings["search.top"]).toEqual({ value: 50, defaultValue: 20, user: 50, workspace: undefined });
    expect(s.providers.map((p) => [p.name, p.hasKey])).toEqual([
      ["local", false],
      ["openai", false],
      ["voyage", true],
    ]);
    expect(s.models?.map((m) => m.id)).toEqual(["m1"]);
  });

  it("writes updates to the selected scope", async () => {
    const t = setup();
    await t.page.onMessage({ type: "update", key: "search.top", value: 5 });
    await t.page.onMessage({ type: "setScope", scope: "user" });
    await t.page.onMessage({ type: "update", key: "index.threads", value: 2 });
    await t.page.onMessage({ type: "update", key: "search.top", value: null });
    expect(t.update.mock.calls).toEqual([
      ["search.top", 5, vscode.ConfigurationTarget.Workspace],
      ["index.threads", 2, vscode.ConfigurationTarget.Global],
      ["search.top", undefined, vscode.ConfigurationTarget.Global],
    ]);
  });

  it("switches the provider after confirmation and restarts the engine", async () => {
    const t = setup();
    const warn = vi.spyOn(vscode.window, "showWarningMessage").mockResolvedValueOnce(undefined as never);
    await t.page.onMessage({ type: "useProvider", name: "openai" });
    expect(t.scopes.workspace["embedding.provider"]).toBeUndefined();
    warn.mockResolvedValueOnce("Switch" as never);
    await t.page.onMessage({ type: "useProvider", name: "openai" });
    expect(warn.mock.calls[0]![0]).toBe("Switch embeddings to openai?");
    expect(t.scopes.workspace["embedding.provider"]).toBe("openai");
    expect(t.supervisor.restart).toHaveBeenCalledOnce();
  });

  it("asks before switching the local model and resends state on cancel", async () => {
    const t = setup({ user: { "model.id": "m1" } });
    await t.page.onMessage({ type: "ready" });
    const warn = vi.spyOn(vscode.window, "showWarningMessage").mockResolvedValueOnce(undefined as never);
    const before = t.posted.length;
    await t.page.onMessage({ type: "update", key: "model.id", value: "m2" });
    expect(t.update).not.toHaveBeenCalled();
    expect(t.posted.length).toBeGreaterThan(before);
    warn.mockResolvedValueOnce("Switch" as never);
    await t.page.onMessage({ type: "update", key: "model.id", value: "m2" });
    expect(t.scopes.workspace["model.id"]).toBe("m2");
  });

  it("saves a new provider with its key in secret storage, not in settings", async () => {
    const t = setup({ workspace: { providers: { ollama } } });
    await t.page.onMessage({ type: "saveProvider", name: "voyage", config: voyage, apiKey: "secret" });
    expect(t.scopes.workspace.providers).toEqual({ ollama, voyage });
    expect(JSON.stringify(t.scopes)).not.toContain("secret");
    expect(t.keys.get("codeEmbed.apiKey.voyage")).toBe("secret");
    expect(t.supervisor.restart).toHaveBeenCalledOnce();
  });

  it("renames a provider: moves its key and keeps it active", async () => {
    const t = setup({ user: { providers: { voyage } }, workspace: { "embedding.provider": "voyage" } });
    t.keys.set("codeEmbed.apiKey.voyage", "k");
    await t.page.onMessage({ type: "saveProvider", previousName: "voyage", name: "vo", config: voyage });
    expect(t.scopes.user.providers).toBeUndefined();
    expect(t.scopes.workspace.providers).toEqual({ vo: voyage });
    expect(t.scopes.workspace["embedding.provider"]).toBe("vo");
    expect([...t.keys]).toEqual([["codeEmbed.apiKey.vo", "k"]]);
  });

  it("deletes a provider from every scope and falls back to the default provider", async () => {
    const t = setup({ user: { providers: { voyage, ollama } }, workspace: { providers: { voyage }, "embedding.provider": "voyage" } });
    t.keys.set("codeEmbed.apiKey.voyage", "k");
    await t.page.onMessage({ type: "deleteProvider", name: "voyage" });
    expect(t.scopes.user.providers).toEqual({ ollama });
    expect(t.scopes.workspace.providers).toBeUndefined();
    expect(t.scopes.workspace["embedding.provider"]).toBeUndefined();
    expect(t.keys.size).toBe(0);
  });

  it("reports provider test results and errors", async () => {
    const t = setup();
    vi.mocked(t.client.testProvider).mockResolvedValueOnce({ dims: 768, latencyMs: 12 }).mockRejectedValueOnce(new Error("401"));
    await t.page.onMessage({ type: "testProvider", name: "a" });
    await t.page.onMessage({ type: "testProvider", name: "b" });
    expect(t.posted.slice(-2)).toEqual([
      { type: "testResult", name: "a", result: { dims: 768, latencyMs: 12 } },
      { type: "testResult", name: "b", error: "401" },
    ]);
  });
});
