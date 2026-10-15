// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import type { IndexStatus } from "@code-embed/protocol/rpc";
import type { SettingsState, SettingsToHost } from "../../src/settings-page/messages";
import { createSettingsApp, type SettingsApp } from "./app";
import { engineSummary, formFromConfig, validateProvider } from "./logic";

const S = (value: unknown, defaultValue: unknown, user?: unknown, workspace?: unknown) => ({ value, defaultValue, user, workspace });

function state(over: Partial<SettingsState> = {}): SettingsState {
  return {
    scope: "workspace",
    hasWorkspace: true,
    settings: {
      "embedding.provider": S("local", "local"),
      "model.id": S("m1", "m1"),
      "model.offlineArchive": S("", ""),
      "index.location": S("auto", "auto"),
      "index.maxFileKb": S(1024, 512, undefined, 1024),
      "index.threads": S(4, 0, 4),
      "index.pauseOnBattery": S(false, false),
      "search.defaultMode": S("hybrid", "hybrid"),
      "search.top": S(20, 20),
    },
    providers: [
      { name: "local", model: "", remote: false, source: "builtin", hasKey: false },
      { name: "openai", model: "te3", remote: true, host: "api.openai.com", source: "user", hasKey: false },
      {
        name: "ollama",
        model: "nomic",
        baseUrl: "http://localhost:11434/v1",
        remote: false,
        source: "editor",
        hasKey: false,
        config: { kind: "openai", base_url: "http://localhost:11434/v1", model: "nomic" },
      },
    ],
    models: [
      { id: "m1", dims: 1024, license: "MIT", sizeMb: 600, installed: true, isDefault: true },
      { id: "m2", dims: 768, license: "MIT", sizeMb: 2048, installed: false, isDefault: false },
    ],
    ...over,
  };
}

const status: IndexStatus = {
  root: "/r",
  indexDir: "/r/.code-embed",
  files: 10,
  chunks: 100,
  embedded: 40,
  phase: "vector",
  model: "m1",
  provider: "local",
  remote: false,
  lexicalOnly: false,
  readOnly: false,
  daemon: false,
};

describe("settings logic", () => {
  const form = (over: Partial<ReturnType<typeof formFromConfig>> = {}) => ({ ...formFromConfig("", undefined), ...over });

  it("validates the provider form", () => {
    const bad = validateProvider(form({ name: "local", base_url: "ftp://x", batch_size: "0" }), []);
    expect(bad).toEqual({ ok: false, errors: { name: "This name is already used", base_url: expect.any(String), model: "Required", batch_size: "Positive integer" } });
    expect(validateProvider(form({ name: "a", base_url: "http://h/v1", model: "m" }), ["a"]).ok).toBe(false);
    expect(validateProvider(form({ name: " a ", base_url: "http://h/v1", model: "m", dimensions: "256", doc_prefix: "doc: " }), [])).toEqual({
      ok: true,
      name: "a",
      config: { kind: "openai", base_url: "http://h/v1", model: "m", dimensions: 256, doc_prefix: "doc: " },
    });
  });

  it("summarizes engine and index state", () => {
    expect(engineSummary("failed", undefined).tone).toBe("error");
    expect(engineSummary("starting", undefined).tone).toBe("busy");
    expect(engineSummary("ready", status)).toEqual({ label: "Indexing, 40% embedded", tone: "busy", percent: 40 });
    expect(engineSummary("ready", { ...status, phase: "idle", embedded: 100 })).toEqual({ label: "Index up to date", tone: "ok", percent: 100 });
    expect(engineSummary("ready", { ...status, phase: "paused" }).label).toBe("Indexing paused");
  });
});

describe("settings app", () => {
  let sent: SettingsToHost[];
  let app: SettingsApp;
  let root: HTMLElement;
  const q = <T extends Element = HTMLElement>(sel: string) => root.querySelector<T>(sel)!;
  const field = (key: string) => q(`.field[data-key="${key}"]`);

  beforeEach(() => {
    document.body.innerHTML = '<div id="app"></div>';
    root = document.getElementById("app")!;
    sent = [];
    app = createSettingsApp(root, { postMessage: (m) => sent.push(m) });
    app.handle({ type: "engine", engine: "ready", status });
    app.handle({ type: "state", state: state() });
  });

  it("shows status with progress and index stats", () => {
    expect(q(".status-label").textContent).toBe("Indexing, 40% embedded");
    expect(q(".stats").textContent).toContain("/r/.code-embed");
    q<HTMLButtonElement>(".status-card .btn").click();
    expect(sent.at(-1)).toEqual({ type: "action", action: "reindex" });
  });

  it("marks modified and overridden settings for the current scope", () => {
    expect(field("index.maxFileKb").classList.contains("modified")).toBe(true);
    expect(field("index.threads").classList.contains("modified")).toBe(false);
    expect(field("index.threads").textContent).toContain("Inherited from user settings");
    app.handle({ type: "state", state: state({ scope: "user" }) });
    expect(field("index.threads").classList.contains("modified")).toBe(true);
    expect(field("index.maxFileKb").textContent).toContain("Overridden by this workspace's setting");
    field("index.maxFileKb").querySelector<HTMLButtonElement>(".reset")!.click();
    expect(sent.at(-1)).toEqual({ type: "update", key: "index.maxFileKb", value: undefined });
  });

  it("commits valid numbers and rejects invalid ones", () => {
    const input = field("search.top").querySelector<HTMLInputElement>("input")!;
    input.value = "0";
    input.dispatchEvent(new Event("change"));
    expect(input.classList.contains("invalid")).toBe(true);
    expect(sent.some((m) => m.type === "update")).toBe(false);
    input.value = "35";
    input.dispatchEvent(new Event("change"));
    expect(sent.at(-1)).toEqual({ type: "update", key: "search.top", value: 35 });
  });

  it("selects providers and models", () => {
    const providers = root.querySelectorAll<HTMLButtonElement>(".provider .radio");
    expect(providers[0]!.getAttribute("aria-checked")).toBe("true");
    providers[2]!.click();
    expect(sent.at(-1)).toEqual({ type: "useProvider", name: "ollama" });
    sent.length = 0;
    root.querySelectorAll<HTMLElement>(".provider-meta")[1]!.click();
    expect(sent.at(-1)).toEqual({ type: "useProvider", name: "openai" });
    root.querySelectorAll<HTMLElement>(".provider")[1]!.querySelector<HTMLButtonElement>('[aria-label^="Test"]')!.click();
    expect(sent.at(-1)).toEqual({ type: "testProvider", name: "openai" });
    root.querySelectorAll<HTMLElement>(".model")[1]!.click();
    expect(sent.at(-1)).toEqual({ type: "update", key: "model.id", value: "m2" });
  });

  it("only offers edit and delete for providers from editor settings, and asks before deleting", () => {
    const cards = root.querySelectorAll(".provider");
    expect(cards[1]!.querySelector('[aria-label="Edit"]')).toBeNull();
    expect(cards[1]!.textContent).toContain("No API key");
    const del = cards[2]!.querySelector<HTMLButtonElement>('[aria-label="Delete"]')!;
    del.click();
    expect(sent.some((m) => m.type === "deleteProvider")).toBe(false);
    del.click();
    expect(sent.at(-1)).toEqual({ type: "deleteProvider", name: "ollama" });
  });

  it("adds a provider through the form", () => {
    q<HTMLButtonElement>("#embeddings > .btn").click();
    const form = q<HTMLFormElement>(".provider-form");
    expect(form.hidden).toBe(false);
    form.dispatchEvent(new Event("submit", { cancelable: true }));
    expect(form.querySelectorAll(".invalid")).toHaveLength(3);
    const set = (name: string, v: string) => (form.querySelector<HTMLInputElement>(`input[name="${name}"]`)!.value = v);
    set("name", "voyage");
    set("base_url", "https://api.voyageai.com/v1");
    set("model", "voyage-code-3");
    form.querySelector<HTMLInputElement>('input[type="password"]')!.value = "sk";
    form.dispatchEvent(new Event("submit", { cancelable: true }));
    expect(sent.at(-1)).toEqual({
      type: "saveProvider",
      previousName: undefined,
      name: "voyage",
      config: { kind: "openai", base_url: "https://api.voyageai.com/v1", model: "voyage-code-3" },
      apiKey: "sk",
    });
    expect(form.hidden).toBe(true);
  });

  it("tests a provider and shows the result", () => {
    root.querySelectorAll(".provider")[2]!.querySelector<HTMLButtonElement>('[aria-label="Test connection"]')!.click();
    expect(sent.at(-1)).toEqual({ type: "testProvider", name: "ollama" });
    expect(root.querySelector(".test-result")!.textContent).toBe("Testing…");
    app.handle({ type: "testResult", name: "ollama", result: { dims: 768, latencyMs: 9 } });
    expect(root.querySelector(".test-result")!.textContent).toBe("Works: 768 dimensions, 9 ms");
  });

  it("falls back to a text field when the model catalog is unavailable", () => {
    app.handle({ type: "state", state: state({ models: null }) });
    expect(root.querySelectorAll(".model")).toHaveLength(0);
    const input = q("#model").querySelector<HTMLInputElement>(".field:not([data-key]) input")!;
    expect(input.value).toBe("m1");
  });
});
