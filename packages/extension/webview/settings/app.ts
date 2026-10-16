import type { IndexStatus, ModelListItem, ProviderTestResult, SearchMode } from "@code-embed/protocol/rpc";
import { SEARCH_MODES } from "@code-embed/protocol/rpc";
import type { ClientState } from "../../src/engine/types";
import type { HostToSettings, ProviderRow, SettingKey, SettingsAction, SettingsState, SettingsToHost } from "../../src/settings-page/messages";
import { button, el, icon, iconButton } from "../dom";
import { MODE_INFO } from "../logic";
import {
  engineSummary,
  formFromConfig,
  indexCounts,
  matchesFilter,
  NUMBER_FIELDS,
  parseIntSetting,
  type ProviderForm,
  remoteHost,
  TEXT_FIELDS,
  validateProvider,
} from "./logic";

export interface HostApi {
  postMessage(msg: SettingsToHost): void;
}

export interface SettingsApp {
  handle(msg: HostToSettings): void;
}

interface FieldHandle {
  root: HTMLElement;
  key: SettingKey;
  set(value: unknown): void;
}

const LOCATIONS: { value: string; label: string; description: string }[] = [
  { value: "auto", label: "Auto", description: "Inside the project (.code-embed/), or in the user cache when the project is on a network drive or a synced folder." },
  { value: "project", label: "Project", description: "Always inside the project (.code-embed/)." },
  { value: "cache", label: "User cache", description: "Always in the user cache directory." },
];

const PRESETS: { label: string; name: string; base_url: string; model: string }[] = [
  { label: "Ollama", name: "ollama", base_url: "http://localhost:11434/v1", model: "nomic-embed-text" },
  { label: "LM Studio", name: "lmstudio", base_url: "http://localhost:1234/v1", model: "" },
  { label: "OpenAI", name: "openai", base_url: "https://api.openai.com/v1", model: "text-embedding-3-small" },
];

const FIELD_LABELS: Record<keyof ProviderForm, string> = {
  name: "Name",
  base_url: "Base URL",
  model: "Model",
  dimensions: "Dimensions",
  max_input_tokens: "Max input tokens",
  batch_size: "Batch size",
  concurrency: "Concurrency",
  rpm: "Requests per minute",
  tpm: "Tokens per minute",
  query_prefix: "Query prefix",
  doc_prefix: "Document prefix",
  api_key_env: "API key environment variable",
};

function formatMb(mb: number): string {
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb} MB`;
}

function n(v: number): string {
  return v.toLocaleString("en-US");
}

function tag(text: string, opts: { icon?: string; tone?: "ok" | "warn" } = {}): HTMLElement {
  const t = el("span", `tag${opts.tone ? ` ${opts.tone}` : ""}`);
  if (opts.icon) t.append(icon(opts.icon));
  t.append(text);
  return t;
}

function radio(checked: boolean, label: string): HTMLButtonElement {
  const r = el("button", "radio");
  r.type = "button";
  r.setAttribute("role", "radio");
  r.setAttribute("aria-checked", String(checked));
  r.setAttribute("aria-label", label);
  return r;
}

export function createSettingsApp(root: HTMLElement, host: HostApi): SettingsApp {
  let state: SettingsState | undefined;
  let engine: ClientState | undefined;
  let status: IndexStatus | undefined;
  let editing: { previousName?: string } | undefined;
  let keyEditing: string | undefined;
  const tests = new Map<string, { pending: boolean; result?: ProviderTestResult; error?: string }>();
  const fields: FieldHandle[] = [];

  const post = (msg: SettingsToHost) => host.postMessage(msg);
  const action = (a: SettingsAction) => post({ type: "action", action: a });
  const value = (key: SettingKey): unknown => state?.settings[key]?.value;
  const update = (key: SettingKey, v: unknown) => post({ type: "update", key, value: v });

  root.textContent = "";
  const page = el("div", "page");
  root.append(page);

  // ---- Header
  const header = el("header", "page-header");
  const titleRow = el("div", "page-title");
  titleRow.append(el("h1", undefined, "Code Embed"), el("span", "muted", "Semantic and keyword code search settings"));
  const searchBox = el("label", "settings-search");
  const searchInput = el("input");
  searchInput.type = "search";
  searchInput.placeholder = "Search Code Embed settings";
  searchInput.setAttribute("aria-label", "Search settings");
  searchInput.spellcheck = false;
  searchBox.append(icon("search"), searchInput);

  const scopeBar = el("div", "scope-bar");
  const tabs = el("div", "scope-tabs");
  tabs.setAttribute("role", "tablist");
  tabs.setAttribute("aria-label", "Settings scope");
  const scopeUser = el("button", "scope-tab", "User");
  const scopeWs = el("button", "scope-tab", "Workspace");
  for (const [b, scope] of [
    [scopeUser, "user"],
    [scopeWs, "workspace"],
  ] as const) {
    b.type = "button";
    b.setAttribute("role", "tab");
    b.addEventListener("click", () => post({ type: "setScope", scope }));
    tabs.append(b);
  }
  const scopeHint = el("span", "scope-hint muted");
  const openJson = el("button", "link icon-link");
  openJson.type = "button";
  openJson.append(icon("go-to-file"), "Open settings.json");
  openJson.addEventListener("click", () => action("openJson"));
  scopeBar.append(tabs, scopeHint, openJson);
  header.append(titleRow, searchBox, scopeBar);
  page.append(header);

  const layout = el("div", "layout");
  const nav = el("nav", "toc");
  const main = el("main");
  const noMatch = el("div", "no-match muted", "No settings found.");
  noMatch.hidden = true;
  main.append(noMatch);
  layout.append(nav, main);
  page.append(layout);

  const tocLinks = new Map<string, { link: HTMLElement; count: HTMLElement }>();
  function section(id: string, title: string, description?: string): HTMLElement {
    const s = el("section", "section");
    s.id = id;
    s.append(el("h2", undefined, title));
    if (description) s.append(el("p", "section-desc muted", description));
    main.append(s);
    const link = el("button", "toc-link");
    link.type = "button";
    link.dataset.target = id;
    const count = el("span", "badge");
    count.hidden = true;
    link.append(el("span", undefined, title), count);
    link.addEventListener("click", () => s.scrollIntoView({ behavior: "smooth", block: "start" }));
    nav.append(link);
    tocLinks.set(id, { link, count });
    return s;
  }

  function updateToc(): void {
    const sections = [...main.querySelectorAll<HTMLElement>(".section:not([hidden])")];
    const atBottom = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2;
    const current = atBottom ? sections.at(-1) : (sections.filter((sec) => sec.getBoundingClientRect().top <= 80).at(-1) ?? sections[0]);
    for (const { link } of tocLinks.values()) {
      const on = link.dataset.target === current?.id;
      link.classList.toggle("current", on);
      if (on) link.setAttribute("aria-current", "true");
      else link.removeAttribute("aria-current");
    }
  }
  window.addEventListener("scroll", updateToc, { passive: true });

  function applyFilter(): void {
    const q = searchInput.value.trim();
    let any = false;
    for (const s of main.querySelectorAll<HTMLElement>(".section")) {
      const title = s.querySelector("h2")!.textContent ?? "";
      const units = [...s.querySelectorAll<HTMLElement>("[data-search]")];
      const titleHit = q !== "" && matchesFilter(title, q);
      let hits = 0;
      for (const u of units) {
        const show = q === "" || titleHit || matchesFilter(u.textContent ?? "", q);
        u.classList.toggle("filtered", !show);
        if (show) hits++;
      }
      s.hidden = q !== "" && hits === 0;
      tocLinks.get(s.id)!.link.hidden = s.hidden;
      if (!s.hidden) any = true;
    }
    noMatch.hidden = any;
    updateToc();
  }
  searchInput.addEventListener("input", applyFilter);
  searchInput.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && searchInput.value) {
      searchInput.value = "";
      applyFilter();
    }
  });

  // ---- Status
  const statusSec = section("status", "Status");
  const statusCard = el("div", "card status-card");
  statusCard.dataset.search = "";
  statusSec.append(statusCard);

  const menu = el("div", "menu");
  menu.hidden = true;
  menu.setAttribute("role", "menu");
  const menuItem = (label: string, a: SettingsAction) => {
    const b = el("button", "menu-item", label);
    b.type = "button";
    b.setAttribute("role", "menuitem");
    b.addEventListener("click", () => {
      menu.hidden = true;
      action(a);
    });
    menu.append(b);
  };
  menuItem("Rebuild from scratch…", "rebuild");
  menuItem("Show log", "showLog");
  document.addEventListener("click", (e) => {
    if (!menu.hidden && !(e.target as HTMLElement).closest(".more-btn, .menu")) menu.hidden = true;
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") menu.hidden = true;
  });

  function modelInfo(): string {
    if (!status) return "";
    if (status.remote) return `${status.model ?? status.provider} · ${status.host ?? "remote"}`;
    const model = status.model ?? status.provider;
    const dims = state?.models?.find((m) => m.id === status!.model)?.dims;
    return [model, dims ? `${n(dims)} dimensions` : undefined, "on this machine"].filter(Boolean).join(" · ");
  }

  function renderStatus(): void {
    statusCard.textContent = "";
    const sum = engineSummary(engine, status);
    const ready = engine === "ready";
    const line = el("div", "status-line");
    const label = el("div", `status-label tone-${sum.tone}`);
    label.append(icon(sum.tone === "ok" ? "pass-filled" : sum.tone === "busy" ? "loading" : sum.tone === "warn" ? "warning" : "error", sum.tone === "busy" ? "spin" : ""));
    label.append(el("span", undefined, sum.label));
    const counts = el("span", "status-counts muted", status ? indexCounts(status) : "");
    const actions = el("div", "actions");
    const reindex = button("Update index", { icon: "refresh", secondary: true });
    reindex.title = "Index only new and changed files";
    reindex.disabled = !ready;
    reindex.addEventListener("click", () => action("reindex"));
    const paused = status?.phase === "paused";
    const pause = button(paused ? "Resume" : "Pause", { icon: paused ? "debug-start" : "debug-pause", secondary: true });
    pause.title = paused ? "Resume indexing" : "Pause indexing";
    pause.disabled = !ready;
    pause.addEventListener("click", () => action(paused ? "resume" : "pause"));
    const more = iconButton("ellipsis", "More actions", "more-btn");
    more.setAttribute("aria-haspopup", "menu");
    more.addEventListener("click", () => {
      menu.hidden = !menu.hidden;
      for (const b of menu.querySelectorAll<HTMLButtonElement>(".menu-item")) b.disabled = b.textContent!.startsWith("Rebuild") && !ready;
    });
    const moreWrap = el("div", "more-wrap");
    moreWrap.append(more, menu);
    actions.append(reindex, pause, moreWrap);
    if (engine === "failed" || engine === "stopped") {
      const log = button("Show log", { icon: "output" });
      log.addEventListener("click", () => action("showLog"));
      actions.prepend(log);
    }
    line.append(label, counts, actions);
    statusCard.append(line);
    if (sum.percent !== undefined && sum.tone === "busy") {
      const meter = el("div", "meter");
      const fill = el("div");
      fill.style.width = `${sum.percent}%`;
      meter.append(fill);
      statusCard.append(meter);
    }
    if (!status) return;
    const details = el("dl", "status-details");
    details.append(el("dt", undefined, "Model"), el("dd", undefined, modelInfo()));
    const where = el("dd", "index-path");
    const path = el("span", "path", status.indexDir);
    path.title = status.indexDir;
    const copy = iconButton("copy", "Copy path");
    copy.addEventListener("click", () => action("copyIndexPath"));
    const reveal = iconButton("folder-opened", "Open folder");
    reveal.addEventListener("click", () => action("revealIndex"));
    where.append(path, copy, reveal);
    details.append(el("dt", undefined, "Index"), where);
    statusCard.append(details);
    const flags: HTMLElement[] = [];
    if (status.readOnly) flags.push(tag("Read-only", { icon: "lock" }));
    if (status.daemon) flags.push(tag("Shared daemon", { icon: "server-process" }));
    if (flags.length) {
      const f = el("div", "flags");
      f.append(...flags);
      statusCard.append(f);
    }
    if (status.lastError) {
      const err = el("div", "status-error");
      err.append(icon("error"), el("span", undefined, status.lastError));
      statusCard.append(err);
    }
  }

  // ---- Embeddings
  const embSec = section("embeddings", "Embeddings", "Where code is turned into vectors. The built-in model keeps everything on this machine.");
  const providerList = el("div", "list");
  providerList.setAttribute("role", "radiogroup");
  providerList.setAttribute("aria-label", "Embedding provider");
  const addBtn = button("Add provider", { icon: "add", secondary: true });
  addBtn.addEventListener("click", () => openForm(undefined));
  const formCard = el("form", "card provider-form");
  formCard.hidden = true;
  formCard.noValidate = true;
  embSec.append(providerList, formCard, addBtn);

  const formTitle = el("h3");
  const presetSeg = el("div", "segmented presets");
  presetSeg.setAttribute("role", "radiogroup");
  presetSeg.setAttribute("aria-label", "Provider preset");
  const inputs = {} as Record<keyof ProviderForm, HTMLInputElement>;
  const errorsEl = {} as Record<keyof ProviderForm, HTMLElement>;
  function formField(key: keyof ProviderForm, placeholder = "", hint?: string): HTMLElement {
    const wrap = el("label", "form-field");
    wrap.append(el("span", "form-label", FIELD_LABELS[key]));
    const input = el("input");
    input.name = key;
    input.placeholder = placeholder;
    input.spellcheck = false;
    if ((NUMBER_FIELDS as readonly string[]).includes(key)) input.inputMode = "numeric";
    inputs[key] = input;
    wrap.append(input);
    if (hint) wrap.append(el("span", "form-hint muted", hint));
    const err = el("span", "form-error");
    errorsEl[key] = err;
    wrap.append(err);
    return wrap;
  }
  const keyInput = el("input");
  keyInput.type = "password";
  keyInput.autocomplete = "off";
  const keyWrap = el("label", "form-field");
  const keyHint = el("span", "form-hint muted");
  keyWrap.append(el("span", "form-label", "API key"), keyInput, keyHint);
  const mainGrid = el("div", "form-grid");
  mainGrid.append(formField("name", "e.g. ollama"), formField("base_url", "http://localhost:11434/v1"), formField("model", "e.g. nomic-embed-text"), keyWrap);
  const hostWarning = el("div", "note warn");
  hostWarning.hidden = true;
  const advToggle = el("button", "link icon-link advanced-toggle");
  advToggle.type = "button";
  advToggle.setAttribute("aria-expanded", "false");
  const advGrid = el("div", "form-grid advanced");
  for (const f of NUMBER_FIELDS) advGrid.append(formField(f, "default"));
  advGrid.append(
    formField("query_prefix", "", "Prepended to search queries"),
    formField("doc_prefix", "", "Prepended to indexed code"),
    formField("api_key_env", "e.g. OPENAI_API_KEY", "Read the key from this variable instead"),
  );
  function setAdvanced(open: boolean): void {
    advGrid.hidden = !open;
    advToggle.setAttribute("aria-expanded", String(open));
    advToggle.textContent = "";
    advToggle.append(icon(open ? "chevron-down" : "chevron-right"), "Advanced");
  }
  advToggle.addEventListener("click", () => setAdvanced(advGrid.hidden));
  const formActions = el("div", "form-actions");
  const saveUseBtn = button("Save and use", { icon: "check" });
  saveUseBtn.addEventListener("click", () => submit(true));
  const saveBtn = button("Save", { secondary: true });
  saveBtn.addEventListener("click", () => submit(false));
  const cancelBtn = button("Cancel", { secondary: true });
  cancelBtn.addEventListener("click", () => closeForm());
  formActions.append(saveUseBtn, saveBtn, cancelBtn);
  formCard.append(formTitle, presetSeg, mainGrid, hostWarning, advToggle, advGrid, formActions);

  const presetButtons: HTMLButtonElement[] = [];
  for (const p of [...PRESETS, undefined]) {
    const b = el("button", undefined, p?.label ?? "Custom");
    b.type = "button";
    b.setAttribute("role", "radio");
    b.addEventListener("click", () => {
      const presetNames = PRESETS.map((x) => x.name);
      if (!inputs.name.value || presetNames.includes(inputs.name.value)) inputs.name.value = p?.name ?? "";
      inputs.base_url.value = p?.base_url ?? "";
      inputs.model.value = p?.model ?? "";
      syncPreset();
      (p ? (p.model ? keyInput : inputs.model) : inputs.name).focus();
    });
    presetButtons.push(b);
    presetSeg.append(b);
  }

  function syncPreset(): void {
    const url = inputs.base_url.value.trim();
    const match = PRESETS.findIndex((p) => p.base_url === url);
    presetButtons.forEach((b, i) => b.setAttribute("aria-checked", String(i === (match < 0 ? PRESETS.length : match))));
    const remote = remoteHost(url);
    hostWarning.hidden = remote === undefined;
    hostWarning.textContent = "";
    if (remote) hostWarning.append(icon("warning"), el("span", undefined, `${remote} is outside this machine. Indexing will send your code there after you confirm once for this project.`));
  }
  inputs.base_url.addEventListener("input", syncPreset);

  function openForm(row: ProviderRow | undefined): void {
    editing = { previousName: row?.name };
    const f = formFromConfig(row?.name ?? "", row?.config);
    for (const k of Object.keys(inputs) as (keyof ProviderForm)[]) {
      inputs[k].value = f[k];
      inputs[k].classList.remove("invalid");
      errorsEl[k].textContent = "";
    }
    keyInput.value = "";
    keyHint.textContent = row?.hasKey ? "A key is stored. Leave empty to keep it." : "Stored in VS Code secret storage, never in settings.json.";
    formTitle.textContent = row ? `Edit ${row.name}` : "Add provider";
    presetSeg.hidden = row !== undefined;
    const active = String(value("embedding.provider") ?? "local");
    saveUseBtn.hidden = row !== undefined && row.name === active;
    saveBtn.classList.toggle("secondary", !saveUseBtn.hidden);
    setAdvanced(TEXT_FIELDS.some((k) => f[k]) || NUMBER_FIELDS.some((k) => f[k]));
    syncPreset();
    formCard.hidden = false;
    addBtn.hidden = true;
    inputs.name.focus();
    formCard.scrollIntoView({ block: "nearest" });
  }

  function closeForm(): void {
    editing = undefined;
    formCard.hidden = true;
    addBtn.hidden = false;
  }

  function submit(use: boolean): void {
    if (!editing || !state) return;
    const form = Object.fromEntries((Object.keys(inputs) as (keyof ProviderForm)[]).map((k) => [k, inputs[k].value])) as ProviderForm;
    const taken = state.providers.map((p) => p.name).filter((p) => p !== editing!.previousName);
    const res = validateProvider(form, taken);
    for (const k of Object.keys(inputs) as (keyof ProviderForm)[]) {
      const err = res.ok ? undefined : res.errors[k];
      inputs[k].classList.toggle("invalid", err !== undefined);
      errorsEl[k].textContent = err ?? "";
    }
    if (!res.ok) {
      const first = (Object.keys(res.errors) as (keyof ProviderForm)[])[0]!;
      if (!mainGrid.contains(inputs[first])) setAdvanced(true);
      inputs[first].focus();
      return;
    }
    post({
      type: "saveProvider",
      previousName: editing.previousName,
      name: res.name,
      config: res.config,
      apiKey: keyInput.value || undefined,
      ...(use ? { use } : {}),
    });
    closeForm();
  }

  formCard.addEventListener("submit", (e) => {
    e.preventDefault();
    submit(!saveUseBtn.hidden);
  });

  function keyStatus(row: ProviderRow): HTMLElement | undefined {
    if (!row.remote) return undefined;
    if (row.hasKey) return tag("API key stored", { icon: "key", tone: "ok" });
    if (row.config?.api_key_env) return tag(`Key from $${row.config.api_key_env}`, { icon: "key" });
    return tag("No API key", { icon: "key", tone: "warn" });
  }

  function consentLine(row: ProviderRow): HTMLElement | undefined {
    if (!row.remote || !status || status.provider !== row.name) return undefined;
    const line = el("div", "consent");
    if (status.consentRequired) {
      line.classList.add("warn");
      const allow = el("button", "link", "Allow");
      allow.type = "button";
      allow.addEventListener("click", () => action("grantConsent"));
      line.append(icon("warning"), el("span", undefined, `Needs your permission to send code from this project to ${status.consentRequired.host}`), allow);
    } else {
      line.append(icon("lock"), el("span", undefined, "Allowed to receive code from this project"));
    }
    return line;
  }

  function renderProviders(): void {
    if (!state) return;
    providerList.textContent = "";
    const active = String(value("embedding.provider") ?? "local");
    for (const row of state.providers) {
      const isActive = row.name === active;
      const local = row.name === "local";
      const card = el("div", `card provider${isActive ? " active" : ""}`);
      card.dataset.search = "";
      const r = radio(isActive, `Use ${local ? "the built-in model" : row.name}`);
      r.title = isActive ? "Active provider" : `Use ${row.name}`;
      const choose = () => {
        if (!isActive) post({ type: "useProvider", name: row.name });
      };
      r.addEventListener("click", choose);
      card.addEventListener("click", (e) => {
        if (!(e.target as HTMLElement).closest("button, input, .key-editor, .models")) choose();
      });
      const body = el("div", "provider-body");
      const title = el("div", "provider-title");
      title.append(el("span", "provider-name", local ? "Built-in model" : row.name));
      title.append(row.remote ? tag(row.host ?? "remote", { icon: "cloud" }) : tag("on this machine", { icon: "vm" }));
      if (row.source === "user") title.append(tag("providers.toml", { icon: "file" }));
      const ks = keyStatus(row);
      if (ks) title.append(ks);
      body.append(title);
      const meta = local ? "Nothing leaves this machine" : [row.model, row.baseUrl].filter(Boolean).join(" · ");
      body.append(el("div", "provider-meta muted", meta));
      const consent = consentLine(row);
      if (consent) body.append(consent);
      const test = tests.get(row.name);
      if (test) {
        const t = el("div", `test-result${test.error ? " fail" : test.pending ? "" : " pass"}`);
        if (test.pending) t.append(icon("loading", "spin"), el("span", undefined, "Testing…"));
        else if (test.error) t.append(icon("error"), el("span", undefined, test.error));
        else if (test.result) t.append(icon("pass"), el("span", undefined, `Works: ${test.result.dims} dimensions, ${test.result.latencyMs} ms`));
        body.append(t);
      }
      if (keyEditing === row.name) body.append(keyEditor(row));
      if (local && isActive) body.append(modelsBlock());
      const actions = el("div", "provider-actions");
      const testBtn = iconButton("beaker", engine === "ready" ? "Test connection" : "Test connection (the engine is not running)");
      testBtn.disabled = engine !== "ready" || test?.pending === true;
      testBtn.addEventListener("click", () => {
        tests.set(row.name, { pending: true });
        renderProviders();
        post({ type: "testProvider", name: row.name });
      });
      actions.append(testBtn);
      if (row.remote) {
        const k = iconButton("key", row.hasKey ? "Replace or remove API key" : "Set API key");
        k.addEventListener("click", () => {
          keyEditing = keyEditing === row.name ? undefined : row.name;
          renderProviders();
          providerList.querySelector<HTMLInputElement>(".key-editor input")?.focus();
        });
        actions.append(k);
      }
      if (row.config) {
        const edit = iconButton("edit", "Edit");
        edit.addEventListener("click", () => openForm(row));
        const del = iconButton("trash", "Delete");
        del.addEventListener("click", () => {
          if (del.dataset.confirm) {
            post({ type: "deleteProvider", name: row.name });
            return;
          }
          del.dataset.confirm = "1";
          del.classList.add("danger");
          del.title = "Click again to delete";
          del.setAttribute("aria-label", "Click again to delete");
          setTimeout(() => {
            delete del.dataset.confirm;
            del.classList.remove("danger");
            del.title = "Delete";
            del.setAttribute("aria-label", "Delete");
          }, 3000);
        });
        actions.append(edit, del);
      }
      card.append(r, body, actions);
      providerList.append(card);
    }
    applyFilter();
  }

  function keyEditor(row: ProviderRow): HTMLElement {
    const box = el("div", "key-editor");
    const input = el("input");
    input.type = "password";
    input.placeholder = `API key for ${row.name}`;
    input.autocomplete = "off";
    const save = button("Save key", { icon: "check" });
    save.addEventListener("click", () => {
      if (!input.value) return;
      keyEditing = undefined;
      post({ type: "setApiKey", name: row.name, key: input.value });
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") save.click();
      if (e.key === "Escape") {
        keyEditing = undefined;
        renderProviders();
      }
    });
    box.append(input, save);
    if (row.hasKey) {
      const remove = button("Remove key", { icon: "trash", secondary: true });
      remove.addEventListener("click", () => {
        keyEditing = undefined;
        post({ type: "setApiKey", name: row.name, key: null });
      });
      box.append(remove);
    }
    return box;
  }

  // ---- Local models, shown inside the built-in provider card
  const modelFallback = el("input", "wide");
  modelFallback.spellcheck = false;
  modelFallback.setAttribute("aria-label", "Model id");
  modelFallback.addEventListener("change", () => update("model.id", modelFallback.value.trim() || undefined));

  function modelsBlock(): HTMLElement {
    const box = el("div", "models");
    const current = String(value("model.id") ?? "");
    if (state!.models === null) {
      box.append(el("div", "muted model-fallback-desc", "The model catalog is available once the engine is running."));
      if (document.activeElement !== modelFallback) modelFallback.value = current;
      box.append(modelFallback);
    } else {
      const table = el("div", "model-table");
      table.setAttribute("role", "radiogroup");
      table.setAttribute("aria-label", "Local model");
      const head = el("div", "model-row model-head");
      head.append(el("span"), el("span", undefined, "Model"), el("span", undefined, "Dims"), el("span", undefined, "Size"), el("span", undefined, "License"), el("span"));
      table.append(head);
      for (const m of state!.models) table.append(modelRow(m, m.id === current));
      box.append(table);
    }
    const note = el("div", "note");
    const chunks = status && status.chunks > 0 ? `${n(status.chunks)} chunks` : "all code";
    note.append(icon("info"), el("span", undefined, `Switching the model re-embeds ${chunks}. Keyword search keeps working meanwhile.`));
    box.append(note);
    const archive = String(value("model.offlineArchive") ?? "");
    const archiveRow = el("div", "archive-row");
    if (archive) {
      const path = el("span", "path", archive);
      path.title = archive;
      const change = el("button", "link", "Change…");
      change.type = "button";
      change.addEventListener("click", () => post({ type: "browseArchive" }));
      const clear = iconButton("close", "Stop using the offline archive");
      clear.addEventListener("click", () => update("model.offlineArchive", undefined));
      archiveRow.append(el("span", "muted", "Offline archive:"), path, change, clear);
    } else {
      const browse = el("button", "link", "Install from offline archive…");
      browse.type = "button";
      browse.title = "Install the model from a local archive instead of downloading it. Useful on machines without internet access.";
      browse.addEventListener("click", () => post({ type: "browseArchive" }));
      archiveRow.append(browse);
    }
    box.append(archiveRow);
    return box;
  }

  function modelRow(m: ModelListItem, isActive: boolean): HTMLElement {
    const row = el("div", `model-row model${isActive ? " active" : ""}`);
    const r = radio(isActive, `Use ${m.id}`);
    const choose = () => {
      if (!isActive) update("model.id", m.id);
    };
    r.addEventListener("click", choose);
    row.addEventListener("click", (e) => {
      if (e.target !== r) choose();
    });
    if (!isActive) row.title = m.installed ? `Use ${m.id}` : `Use ${m.id} (downloads ${formatMb(m.sizeMb)})`;
    const name = el("span", "model-name", m.id);
    if (m.isDefault) {
      const star = icon("star-full", "model-default");
      star.title = "Default model";
      name.append(star);
    }
    const act = el("span", "model-action");
    if (!m.installed) act.append(icon("cloud-download"), "Download");
    row.append(r, name, el("span", undefined, String(m.dims)), el("span", undefined, formatMb(m.sizeMb)), el("span", "model-license", m.license), act);
    return row;
  }

  // ---- Field helpers
  function field(key: SettingKey, label: string, description: string, control: HTMLElement, set: (v: unknown) => void): FieldHandle {
    const f = el("div", "field");
    f.dataset.key = key;
    f.dataset.search = "";
    const head = el("div", "field-head");
    head.append(el("span", "field-label", label), el("span", "modified-label"));
    const reset = iconButton("discard", "Reset to default", "reset");
    reset.addEventListener("click", () => update(key, undefined));
    head.append(reset);
    f.append(head, el("div", "field-desc muted", description), control, el("div", "field-note"));
    const h = { root: f, key, set };
    fields.push(h);
    return h;
  }

  function numberField(key: SettingKey, label: string, description: string, min: number, opts: { suffix?: string; auto?: boolean } = {}): HTMLElement {
    const wrap = el("div", "control-row");
    const input = el("input", "num");
    input.type = "number";
    input.min = String(min);
    input.step = "1";
    if (opts.auto) input.placeholder = "Auto";
    wrap.append(input);
    if (opts.suffix) wrap.append(el("span", "muted", opts.suffix));
    const err = el("span", "form-error");
    wrap.append(err);
    const commit = () => {
      if (opts.auto && input.value.trim() === "") {
        input.classList.remove("invalid");
        err.textContent = "";
        if (value(key) !== 0) update(key, undefined);
        return;
      }
      const v = parseIntSetting(input.value, min);
      input.classList.toggle("invalid", v === undefined);
      err.textContent = v === undefined ? `Whole number, at least ${min}` : "";
      if (v !== undefined && v !== value(key)) update(key, v);
    };
    input.addEventListener("change", commit);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") commit();
    });
    return field(key, label, description, wrap, (v) => {
      if (document.activeElement === input) return;
      input.value = opts.auto && (v === 0 || v === undefined) ? "" : String(v ?? "");
      input.classList.remove("invalid");
      err.textContent = "";
    }).root;
  }

  // ---- Index
  const indexSec = section("index", "Indexing", "Changes apply without restarting. The index is updated in the background as files change.");
  const locSelect = el("select");
  for (const l of LOCATIONS) {
    const o = el("option", undefined, l.label);
    o.value = l.value;
    locSelect.append(o);
  }
  const locDesc = el("div", "muted option-desc");
  const locWrap = el("div");
  locWrap.append(locSelect, locDesc);
  const syncLocDesc = () => {
    locDesc.textContent = LOCATIONS.find((l) => l.value === locSelect.value)?.description ?? "";
  };
  locSelect.addEventListener("change", () => {
    syncLocDesc();
    update("index.location", locSelect.value);
  });
  indexSec.append(
    field("index.location", "Index location", "Where the index files are stored.", locWrap, (v) => {
      locSelect.value = String(v ?? "auto");
      syncLocDesc();
    }).root,
  );

  let patterns: string[] = [];
  let patternEdit: number | undefined;
  const patternList = el("div", "pattern-list");
  const addPattern = button("Add Pattern", { cls: "add-pattern" });
  addPattern.addEventListener("click", () => {
    patternEdit = patterns.length;
    renderPatterns();
  });
  const patternWrap = el("div");
  patternWrap.append(patternList, addPattern);
  function commitPatterns(next: string[]): void {
    patternEdit = undefined;
    update("index.exclude", next.length > 0 ? next : undefined);
  }
  function renderPatterns(): void {
    patternList.textContent = "";
    const rows = patternEdit === patterns.length ? [...patterns, ""] : patterns;
    rows.forEach((p, i) => {
      const row = el("div", "pattern-row");
      if (patternEdit === i) {
        const input = el("input", "pattern-input");
        input.value = p;
        input.placeholder = "e.g. vendor/**";
        input.spellcheck = false;
        const ok = button("OK");
        const cancel = button("Cancel", { secondary: true });
        const save = () => {
          const v = input.value.trim();
          const next = [...patterns];
          if (v) next[i] = v;
          else next.splice(i, 1);
          commitPatterns([...new Set(next)]);
        };
        ok.addEventListener("click", save);
        cancel.addEventListener("click", () => {
          patternEdit = undefined;
          renderPatterns();
        });
        input.addEventListener("keydown", (e) => {
          if (e.key === "Enter") save();
          if (e.key === "Escape") cancel.click();
        });
        row.classList.add("editing");
        row.append(input, ok, cancel);
        patternList.append(row);
        queueMicrotask(() => input.focus());
        return;
      }
      const edit = iconButton("edit", `Edit ${p}`);
      edit.addEventListener("click", () => {
        patternEdit = i;
        renderPatterns();
      });
      const remove = iconButton("close", `Remove ${p}`);
      remove.addEventListener("click", () => commitPatterns(patterns.filter((_, j) => j !== i)));
      row.append(el("span", "pattern-text", p), edit, remove);
      patternList.append(row);
    });
    patternList.hidden = rows.length === 0;
    addPattern.hidden = patternEdit === patterns.length;
  }
  indexSec.append(
    field("index.exclude", "Excluded files", "Glob patterns that are skipped in addition to .gitignore.", patternWrap, (v) => {
      patterns = Array.isArray(v) ? v.map(String) : [];
      patternEdit = undefined;
      renderPatterns();
    }).root,
    numberField("index.maxFileKb", "Maximum file size", "Larger files are skipped.", 1, { suffix: "KB" }),
    numberField("index.threads", "Threads", "Total threads for the built-in model across all windows and projects on this machine. Leave empty for automatic: half of the cores, at most 4.", 1, { auto: true }),
  );
  const batteryBox = el("label", "check-row");
  const battery = el("input");
  battery.type = "checkbox";
  battery.addEventListener("change", () => update("index.pauseOnBattery", battery.checked));
  batteryBox.append(battery, el("span", undefined, "Pause computing embeddings while the computer runs on battery"));
  indexSec.append(
    field("index.pauseOnBattery", "Battery", "Keyword search keeps working while paused.", batteryBox, (v) => {
      battery.checked = v === true;
    }).root,
  );

  // ---- Search
  const searchSec = section("search", "Search");
  const modeSeg = el("div", "segmented modes-seg");
  modeSeg.setAttribute("role", "radiogroup");
  modeSeg.setAttribute("aria-label", "Default search mode");
  const modeBtns = new Map<SearchMode, HTMLButtonElement>();
  for (const m of SEARCH_MODES) {
    const b = el("button");
    b.type = "button";
    b.setAttribute("role", "radio");
    b.append(icon(MODE_INFO[m].icon), MODE_INFO[m].name);
    b.title = MODE_INFO[m].label;
    b.addEventListener("click", () => update("search.defaultMode", m));
    modeBtns.set(m, b);
    modeSeg.append(b);
  }
  const modeDesc = el("div", "muted option-desc");
  const modeWrap = el("div");
  modeWrap.append(modeSeg, modeDesc);
  searchSec.append(
    field("search.defaultMode", "Default mode", "The mode the search panel starts in. You can switch it under the search box.", modeWrap, (v) => {
      const mode = (v ?? "hybrid") as SearchMode;
      for (const [k, b] of modeBtns) b.setAttribute("aria-checked", String(k === mode));
      modeDesc.textContent = MODE_INFO[mode]?.label ?? "";
    }).root,
    numberField("search.top", "Results", "How many results to show.", 1),
  );

  // ---- Integrations
  const intSec = section("integrations", "Integrations");
  const intCard = el("div", "card integrations");
  intSec.append(intCard);
  const integration = (ic: string, title: string, desc: string, end: HTMLElement) => {
    const row = el("div", "integration");
    row.dataset.search = "";
    const text = el("div", "integration-text");
    text.append(el("div", "integration-title", title), el("div", "integration-desc muted", desc));
    row.append(icon(ic, "integration-icon"), text, end);
    intCard.append(row);
  };
  const intButton = (label: string, a: SettingsAction) => {
    const b = button(label, { secondary: true });
    b.addEventListener("click", () => action(a));
    return b;
  };
  integration("terminal", "Command line", "Install the code-embed CLI to search from the terminal and scripts.", intButton("Install CLI", "installCli"));
  integration("plug", "MCP for agents", "Copy a config for Claude Code, Cursor and other MCP clients.", intButton("Copy MCP config", "copyMcpConfig"));
  integration("zap", "Agent tools in VS Code", "#semsearch and #similar are available to chat agents.", tag("active", { icon: "pass", tone: "ok" }));
  integration("output", "Log", "Engine output and indexing errors.", intButton("Show log", "showLog"));

  const toast = el("div", "toast");
  toast.hidden = true;
  toast.setAttribute("role", "alert");
  page.append(toast);
  let toastTimer: ReturnType<typeof setTimeout> | undefined;
  function showError(message: string): void {
    toast.textContent = "";
    toast.append(icon("error"), el("span", undefined, message));
    toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toast.hidden = true), 6000);
  }

  function renderState(): void {
    if (!state) return;
    const ws = state.scope === "workspace";
    scopeUser.setAttribute("aria-selected", String(!ws));
    scopeWs.setAttribute("aria-selected", String(ws));
    scopeWs.disabled = !state.hasWorkspace;
    scopeWs.title = state.hasWorkspace ? "Save to this workspace (.vscode/settings.json)" : "Open a folder to use workspace settings";
    scopeHint.textContent = ws ? "Saved to .vscode/settings.json" : "Saved to user settings";
    const counts = new Map<string, number>();
    for (const f of fields) {
      const info = state.settings[f.key];
      f.set(info.value);
      const here = ws ? info.workspace : info.user;
      const modified = here !== undefined;
      f.root.classList.toggle("modified", modified);
      f.root.querySelector(".modified-label")!.textContent = modified ? `Modified in ${ws ? "Workspace" : "User"}` : "";
      if (modified) {
        const id = f.root.closest(".section")!.id;
        counts.set(id, (counts.get(id) ?? 0) + 1);
      }
      const note = f.root.querySelector<HTMLElement>(".field-note")!;
      note.textContent = "";
      note.classList.remove("info");
      if (!ws && info.workspace !== undefined) {
        note.append(icon("warning"), el("span", undefined, "Overridden by this workspace's setting"));
      } else if (ws && here === undefined && info.user !== undefined) {
        note.classList.add("info");
        note.append(icon("info"), el("span", undefined, "Inherited from user settings"));
      }
    }
    for (const [id, { count }] of tocLinks) {
      const c = counts.get(id) ?? 0;
      count.hidden = c === 0;
      count.textContent = String(c);
      count.title = `${c} modified in ${ws ? "Workspace" : "User"}`;
    }
    renderProviders();
  }

  renderStatus();
  updateToc();

  return {
    handle(msg) {
      switch (msg.type) {
        case "state":
          state = msg.state;
          page.classList.add("loaded");
          renderState();
          renderStatus();
          break;
        case "engine":
          engine = msg.engine;
          status = msg.status;
          renderStatus();
          renderProviders();
          break;
        case "testResult":
          tests.set(msg.name, { pending: false, result: msg.result, error: msg.error });
          renderProviders();
          break;
        case "error":
          showError(msg.message);
          break;
      }
    },
  };
}
