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
      "index.exclude": S(["vendor/**"], [], undefined, ["vendor/**"]),
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
    expect(engineSummary("ready", { ...status, phase: "queued", chunks: 10, embedded: 4 }).label).toBe("Waiting for another project, 40% embedded");
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
    expect(q(".status-counts").textContent).toBe("10 files · 100 chunks, 40 embedded");
    expect(q(".status-details").textContent).toContain("m1 · 1,024 dimensions · on this machine");
    expect(q(".index-path .path").textContent).toBe("/r/.code-embed");
    expect(q(".status-card .meter")).not.toBeNull();
    q<HTMLButtonElement>(".status-card .btn").click();
    expect(sent.at(-1)).toEqual({ type: "action", action: "reindex" });
    q<HTMLButtonElement>('.index-path [aria-label="Copy path"]').click();
    expect(sent.at(-1)).toEqual({ type: "action", action: "copyIndexPath" });
    const menu = q(".menu");
    expect(menu.hidden).toBe(true);
    q<HTMLButtonElement>(".more-btn").click();
    expect(menu.hidden).toBe(false);
    menu.querySelector<HTMLButtonElement>(".menu-item")!.click();
    expect(sent.at(-1)).toEqual({ type: "action", action: "rebuild" });
    expect(menu.hidden).toBe(true);
    app.handle({ type: "engine", engine: "ready", status: { ...status, phase: "idle", embedded: 100 } });
    expect(q(".status-counts").textContent).toBe("10 files · 100 chunks, all embedded");
    expect(root.querySelector(".status-card .meter")).toBeNull();
  });

  it("marks modified and overridden settings for the current scope", () => {
    expect(field("index.maxFileKb").classList.contains("modified")).toBe(true);
    expect(field("index.maxFileKb").querySelector(".modified-label")!.textContent).toBe("Modified in Workspace");
    expect(field("index.threads").classList.contains("modified")).toBe(false);
    expect(q('.toc-link[data-target="index"] .badge').textContent).toBe("2");
    expect(q('.toc-link[data-target="search"] .badge').hidden).toBe(true);
    expect(q(".scope-tab[aria-selected=\"true\"]").textContent).toBe("Workspace");
    expect(q(".scope-hint").textContent).toBe("Saved to .vscode/settings.json");
    expect(field("index.threads").textContent).toContain("Inherited from user settings");
    app.handle({ type: "state", state: state({ scope: "user" }) });
    expect(field("index.threads").classList.contains("modified")).toBe(true);
    expect(field("index.threads").querySelector(".modified-label")!.textContent).toBe("Modified in User");
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
    const providers = root.querySelectorAll<HTMLButtonElement>(".provider > .radio");
    expect(providers[0]!.getAttribute("aria-checked")).toBe("true");
    providers[2]!.click();
    expect(sent.at(-1)).toEqual({ type: "useProvider", name: "ollama" });
    sent.length = 0;
    root.querySelectorAll<HTMLElement>(".provider-meta")[1]!.click();
    expect(sent.at(-1)).toEqual({ type: "useProvider", name: "openai" });
    root.querySelectorAll<HTMLElement>(".provider")[1]!.querySelector<HTMLButtonElement>('[aria-label^="Test"]')!.click();
    expect(sent.at(-1)).toEqual({ type: "testProvider", name: "openai" });
    sent.length = 0;
    const models = root.querySelectorAll<HTMLElement>(".model");
    expect(models[0]!.classList.contains("active")).toBe(true);
    expect(models[0]!.querySelector(".model-action")!.textContent).toBe("");
    expect(models[1]!.querySelector(".model-action")!.textContent).toBe("Download");
    models[1]!.click();
    expect(sent).toEqual([{ type: "update", key: "model.id", value: "m2" }]);
    expect(q(".models .note").textContent).toBe("Switching the model re-embeds 100 chunks. Keyword search keeps working meanwhile.");
  });

  it("shows the model table only inside the active built-in provider", () => {
    app.handle({ type: "state", state: state({ settings: { ...state().settings, "embedding.provider": S("ollama", "local", undefined, "ollama") } }) });
    expect(root.querySelector(".models")).toBeNull();
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
    form.querySelector<HTMLInputElement>('input[name="base_url"]')!.dispatchEvent(new Event("input"));
    expect(form.querySelector('[aria-checked="true"]')!.textContent).toBe("Custom");
    expect(form.querySelector<HTMLElement>(".note.warn")!.textContent).toContain("api.voyageai.com is outside this machine");
    form.dispatchEvent(new Event("submit", { cancelable: true }));
    expect(sent.at(-1)).toEqual({
      type: "saveProvider",
      previousName: undefined,
      name: "voyage",
      config: { kind: "openai", base_url: "https://api.voyageai.com/v1", model: "voyage-code-3" },
      apiKey: "sk",
      use: true,
    });
    expect(form.hidden).toBe(true);
  });

  it("fills the form from a preset and saves without switching", () => {
    q<HTMLButtonElement>("#embeddings > .btn").click();
    const form = q<HTMLFormElement>(".provider-form");
    const ollama = [...form.querySelectorAll<HTMLButtonElement>(".presets button")].find((b) => b.textContent === "Ollama")!;
    ollama.click();
    expect(ollama.getAttribute("aria-checked")).toBe("true");
    expect(form.querySelector<HTMLElement>(".note.warn")!.hidden).toBe(true);
    form.querySelector<HTMLInputElement>('input[name="name"]')!.value = "ollama2";
    [...form.querySelectorAll<HTMLButtonElement>(".form-actions .btn")].find((b) => b.textContent === "Save")!.click();
    expect(sent.at(-1)).toMatchObject({ type: "saveProvider", name: "ollama2", config: { base_url: "http://localhost:11434/v1", model: "nomic-embed-text" } });
    expect(sent.at(-1)).not.toHaveProperty("use");
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
    expect(q<HTMLInputElement>(".models input").value).toBe("m1");
  });

  it("treats empty threads as automatic", () => {
    const input = field("index.threads").querySelector<HTMLInputElement>("input")!;
    expect(input.placeholder).toBe("Auto");
    expect(input.value).toBe("4");
    input.value = "";
    input.dispatchEvent(new Event("change"));
    expect(sent.at(-1)).toEqual({ type: "update", key: "index.threads", value: undefined });
    app.handle({ type: "state", state: state({ settings: { ...state().settings, "index.threads": S(0, 0) } }) });
    expect(input.value).toBe("");
  });

  it("edits excluded file patterns", () => {
    const f = field("index.exclude");
    expect([...f.querySelectorAll(".pattern-text")].map((e) => e.textContent)).toEqual(["vendor/**"]);
    f.querySelector<HTMLButtonElement>(".add-pattern")!.click();
    const input = f.querySelector<HTMLInputElement>(".pattern-input")!;
    input.value = "**/*.generated.ts";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    expect(sent.at(-1)).toEqual({ type: "update", key: "index.exclude", value: ["vendor/**", "**/*.generated.ts"] });
    f.querySelector<HTMLButtonElement>('[aria-label="Remove vendor/**"]')!.click();
    expect(sent.at(-1)).toEqual({ type: "update", key: "index.exclude", value: undefined });
  });

  it("filters settings by the search box", () => {
    const search = q<HTMLInputElement>(".settings-search input");
    search.value = "battery";
    search.dispatchEvent(new Event("input"));
    expect(field("index.pauseOnBattery").classList.contains("filtered")).toBe(false);
    expect(field("index.threads").classList.contains("filtered")).toBe(true);
    expect(q("#search").hidden).toBe(true);
    expect(q('.toc-link[data-target="search"]').hidden).toBe(true);
    search.value = "nothing matches this";
    search.dispatchEvent(new Event("input"));
    expect(q(".no-match").hidden).toBe(false);
    search.value = "";
    search.dispatchEvent(new Event("input"));
    expect(root.querySelectorAll(".filtered")).toHaveLength(0);
  });

  it("shows consent for the active remote provider", () => {
    app.handle({ type: "state", state: state({ settings: { ...state().settings, "embedding.provider": S("openai", "local", "openai") } }) });
    app.handle({ type: "engine", engine: "ready", status: { ...status, provider: "openai", remote: true, host: "api.openai.com", consentRequired: { host: "api.openai.com", provider: "openai" } } });
    const consent = q(".provider.active .consent");
    expect(consent.textContent).toContain("Needs your permission");
    consent.querySelector<HTMLButtonElement>(".link")!.click();
    expect(sent.at(-1)).toEqual({ type: "action", action: "grantConsent" });
    app.handle({ type: "engine", engine: "ready", status: { ...status, provider: "openai", remote: true, host: "api.openai.com" } });
    expect(q(".provider.active .consent").textContent).toBe("Allowed to receive code from this project");
  });
});
