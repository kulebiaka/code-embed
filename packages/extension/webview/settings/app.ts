import type { IndexStatus, ModelListItem, ProviderTestResult, SearchMode } from "@code-embed/protocol/rpc";
import { SEARCH_MODES } from "@code-embed/protocol/rpc";
import type { ClientState } from "../../src/engine/types";
import type { HostToSettings, ProviderRow, SettingKey, SettingsState, SettingsToHost } from "../../src/settings-page/messages";
import { button, el, icon, iconButton } from "../dom";
import { MODE_INFO } from "../logic";
import { engineSummary, formFromConfig, NUMBER_FIELDS, parseIntSetting, type ProviderForm, TEXT_FIELDS, validateProvider } from "./logic";

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

export function createSettingsApp(root: HTMLElement, host: HostApi): SettingsApp {
  let state: SettingsState | undefined;
  let engine: ClientState | undefined;
  let status: IndexStatus | undefined;
  let editing: { previousName?: string } | undefined;
  let keyEditing: string | undefined;
  const tests = new Map<string, { pending: boolean; result?: ProviderTestResult; error?: string }>();
  const fields: FieldHandle[] = [];

  const post = (msg: SettingsToHost) => host.postMessage(msg);
  const value = (key: SettingKey): unknown => state?.settings[key]?.value;
  const update = (key: SettingKey, v: unknown) => post({ type: "update", key, value: v });

  root.textContent = "";
  const page = el("div", "page");
  root.append(page);

  const header = el("header", "page-header");
  const titleBox = el("div", "page-title");
  titleBox.append(el("h1", undefined, "Code Embed"), el("div", "muted", "Semantic and keyword code search settings"));
  const scopeBox = el("div", "scope");
  const scopeSeg = el("div", "segmented");
  scopeSeg.setAttribute("role", "radiogroup");
  scopeSeg.setAttribute("aria-label", "Settings scope");
  const scopeUser = el("button", undefined, "User");
  const scopeWs = el("button", undefined, "Workspace");
  for (const [b, scope] of [
    [scopeUser, "user"],
    [scopeWs, "workspace"],
  ] as const) {
    b.type = "button";
    b.setAttribute("role", "radio");
    b.addEventListener("click", () => post({ type: "setScope", scope }));
    scopeSeg.append(b);
  }
  const scopeHint = el("div", "scope-hint muted");
  const openJson = el("button", "link", "Open settings.json");
  openJson.type = "button";
  openJson.addEventListener("click", () => post({ type: "action", action: "openJson" }));
  scopeBox.append(scopeSeg, scopeHint, openJson);
  header.append(titleBox, scopeBox);
  page.append(header);

  const layout = el("div", "layout");
  const nav = el("nav", "toc");
  const main = el("main");
  layout.append(nav, main);
  page.append(layout);

  function section(id: string, title: string, description?: string): HTMLElement {
    const s = el("section", "section");
    s.id = id;
    s.append(el("h2", undefined, title));
    if (description) s.append(el("p", "section-desc muted", description));
    main.append(s);
    const link = el("button", "toc-link", title);
    link.type = "button";
    link.dataset.target = id;
    link.addEventListener("click", () => s.scrollIntoView({ behavior: "smooth", block: "start" }));
    nav.append(link);
    return s;
  }

  function updateToc(): void {
    const sections = [...main.querySelectorAll<HTMLElement>(".section")];
    const atBottom = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2;
    const current = atBottom ? sections.at(-1) : (sections.filter((sec) => sec.getBoundingClientRect().top <= 80).at(-1) ?? sections[0]);
    for (const link of nav.querySelectorAll<HTMLElement>(".toc-link")) {
      const on = link.dataset.target === current?.id;
      link.classList.toggle("current", on);
      if (on) link.setAttribute("aria-current", "true");
      else link.removeAttribute("aria-current");
    }
  }
  window.addEventListener("scroll", updateToc, { passive: true });

  // ---- Status
  const statusSec = section("status", "Status");
  const statusCard = el("div", "card status-card");
  statusSec.append(statusCard);

  function renderStatus(): void {
    statusCard.textContent = "";
    const sum = engineSummary(engine, status);
    const head = el("div", "status-head");
    const label = el("div", `status-label tone-${sum.tone}`);
    label.append(icon(sum.tone === "ok" ? "pass-filled" : sum.tone === "busy" ? "loading" : sum.tone === "warn" ? "warning" : "error", sum.tone === "busy" ? "spin" : ""));
    label.append(el("span", undefined, sum.label));
    const actions = el("div", "actions");
    const ready = engine === "ready";
    const reindex = button("Update index", { icon: "refresh", secondary: true });
    reindex.title = "Index only new and changed files";
    reindex.disabled = !ready;
    reindex.addEventListener("click", () => post({ type: "action", action: "reindex" }));
    const rebuild = button("Rebuild from scratch", { icon: "database", secondary: true });
    rebuild.title = "Delete the index and re-embed every file";
    rebuild.disabled = !ready;
    rebuild.addEventListener("click", () => post({ type: "action", action: "rebuild" }));
    const paused = status?.phase === "paused";
    const pause = button(paused ? "Resume indexing" : "Pause indexing", { icon: paused ? "debug-start" : "debug-pause", secondary: true });
    pause.disabled = !ready;
    pause.addEventListener("click", () => post({ type: "action", action: paused ? "resume" : "pause" }));
    actions.append(reindex, rebuild, pause);
    if (engine === "failed" || engine === "stopped") {
      const log = button("Show log", { icon: "output" });
      log.addEventListener("click", () => post({ type: "action", action: "showLog" }));
      actions.append(log);
    }
    head.append(label, actions);
    statusCard.append(head);
    if (sum.percent !== undefined) {
      const meter = el("div", "meter");
      const fill = el("div");
      fill.style.width = `${sum.percent}%`;
      meter.append(fill);
      statusCard.append(meter);
    }
    if (!status) return;
    const grid = el("dl", "stats");
    const stat = (k: string, v: string, wide = false) => {
      const d = el("div", wide ? "wide" : undefined);
      const dd = el("dd", undefined, v);
      dd.title = v;
      d.append(el("dt", undefined, k), dd);
      grid.append(d);
    };
    stat("Files", n(status.files));
    stat("Chunks", n(status.chunks));
    stat("Embedded", status.lexicalOnly ? "—" : n(status.embedded));
    stat("Embeddings", status.remote ? `${status.provider} → ${status.host ?? "remote"}` : `${status.provider === "local" ? (status.model ?? "local") : status.provider}, on this machine`, true);
    stat("Index", status.indexDir, true);
    statusCard.append(grid);
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
  const embSec = section("embeddings", "Embedding provider", "Where code is turned into vectors. The built-in model keeps everything on this machine.");
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
  const presets = el("div", "presets");
  presets.append(el("span", "muted", "Presets:"));
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
  mainGrid.append(
    formField("name", "e.g. ollama"),
    formField("base_url", "http://localhost:11434/v1"),
    formField("model", "e.g. nomic-embed-text"),
    keyWrap,
  );
  const advanced = el("details", "advanced");
  advanced.append(el("summary", undefined, "Advanced"));
  const advGrid = el("div", "form-grid");
  for (const f of NUMBER_FIELDS) advGrid.append(formField(f, "default"));
  advGrid.append(
    formField("query_prefix", "", "Prepended to search queries"),
    formField("doc_prefix", "", "Prepended to indexed code"),
    formField("api_key_env", "e.g. OPENAI_API_KEY", "Read the key from this variable instead"),
  );
  advanced.append(advGrid);
  const formActions = el("div", "form-actions");
  const saveBtn = button("Save", { icon: "check" });
  saveBtn.type = "submit";
  const cancelBtn = button("Cancel", { secondary: true });
  cancelBtn.addEventListener("click", () => closeForm());
  formActions.append(saveBtn, cancelBtn);
  formCard.append(formTitle, presets, mainGrid, advanced, formActions);
  for (const p of PRESETS) {
    const b = el("button", "chip", p.label);
    b.type = "button";
    b.addEventListener("click", () => {
      if (!inputs.name.value) inputs.name.value = p.name;
      inputs.base_url.value = p.base_url;
      inputs.model.value = p.model;
      (p.model ? keyInput : inputs.model).focus();
    });
    presets.append(b);
  }

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
    presets.hidden = row !== undefined;
    advanced.open = TEXT_FIELDS.some((k) => f[k]) || NUMBER_FIELDS.some((k) => f[k]);
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

  formCard.addEventListener("submit", (e) => {
    e.preventDefault();
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
      if (!(mainGrid.contains(inputs[first]))) advanced.open = true;
      inputs[first].focus();
      return;
    }
    post({ type: "saveProvider", previousName: editing.previousName, name: res.name, config: res.config, apiKey: keyInput.value || undefined });
    closeForm();
  });

  function keyStatus(row: ProviderRow): HTMLElement | undefined {
    if (!row.remote) return undefined;
    if (row.hasKey) return tag("API key stored", { icon: "key", tone: "ok" });
    if (row.config?.api_key_env) return tag(`Key from $${row.config.api_key_env}`, { icon: "key" });
    return tag("No API key", { icon: "key", tone: "warn" });
  }

  function renderProviders(): void {
    if (!state) return;
    providerList.textContent = "";
    const active = String(value("embedding.provider") ?? "local");
    for (const row of state.providers) {
      const isActive = row.name === active;
      const card = el("div", `card provider${isActive ? " active" : ""}`);
      const radio = el("button", "radio");
      radio.type = "button";
      radio.setAttribute("role", "radio");
      radio.setAttribute("aria-checked", String(isActive));
      radio.setAttribute("aria-label", `Use ${row.name}`);
      radio.title = isActive ? "Active provider" : `Use ${row.name}`;
      const choose = () => {
        if (!isActive) post({ type: "useProvider", name: row.name });
      };
      radio.addEventListener("click", choose);
      card.addEventListener("click", (e) => {
        if (!(e.target as HTMLElement).closest("button, input, .key-editor")) choose();
      });
      const body = el("div", "provider-body");
      const title = el("div", "provider-title");
      title.append(el("span", "provider-name", row.name === "local" ? "Built-in model" : row.name));
      title.append(row.remote ? tag(row.host ?? "remote", { icon: "cloud" }) : tag("on this machine", { icon: "vm" }));
      if (row.source === "user") title.append(tag("providers.toml", { icon: "file" }));
      const ks = keyStatus(row);
      if (ks) title.append(ks);
      body.append(title);
      const meta = row.name === "local" ? `${String(value("model.id") ?? "")} · nothing leaves this machine` : [row.model, row.baseUrl].filter(Boolean).join(" · ");
      body.append(el("div", "provider-meta muted", meta));
      const test = tests.get(row.name);
      if (test) {
        const t = el("div", `test-result${test.error ? " fail" : test.pending ? "" : " pass"}`);
        if (test.pending) t.append(icon("loading", "spin"), el("span", undefined, "Testing…"));
        else if (test.error) t.append(icon("error"), el("span", undefined, test.error));
        else if (test.result) t.append(icon("pass"), el("span", undefined, `Works: ${test.result.dims} dimensions, ${test.result.latencyMs} ms`));
        body.append(t);
      }
      if (keyEditing === row.name) body.append(keyEditor(row));
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
      card.append(radio, body, actions);
      providerList.append(card);
    }
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

  // ---- Field helpers
  function field(key: SettingKey, label: string, description: string, control: HTMLElement, set: (v: unknown) => void): FieldHandle {
    const f = el("div", "field");
    f.dataset.key = key;
    const head = el("div", "field-head");
    head.append(el("span", "field-label", label));
    const reset = iconButton("discard", "Reset to default", "reset");
    reset.addEventListener("click", () => update(key, undefined));
    head.append(reset);
    f.append(head, el("div", "field-desc muted", description), control, el("div", "field-note"));
    const h = { root: f, key, set };
    fields.push(h);
    return h;
  }

  function numberField(key: SettingKey, label: string, description: string, min: number, suffix?: string): HTMLElement {
    const wrap = el("div", "control-row");
    const input = el("input", "num");
    input.type = "number";
    input.min = String(min);
    input.step = "1";
    wrap.append(input);
    if (suffix) wrap.append(el("span", "muted", suffix));
    const err = el("span", "form-error");
    wrap.append(err);
    const commit = () => {
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
      input.value = String(v ?? "");
      input.classList.remove("invalid");
      err.textContent = "";
    }).root;
  }

  // ---- Local model
  const modelSec = section("model", "Local model", "Used when the provider is the built-in model. Models are downloaded once and shared between projects.");
  const modelNote = el("div", "note");
  modelNote.append(icon("info"), el("span"));
  const modelList = el("div", "list");
  modelList.setAttribute("role", "radiogroup");
  modelList.setAttribute("aria-label", "Local model");
  const modelFallback = el("input");
  modelFallback.spellcheck = false;
  modelFallback.addEventListener("change", () => update("model.id", modelFallback.value.trim() || undefined));
  const modelFallbackWrap = el("div", "field");
  modelFallbackWrap.append(el("div", "field-label", "Model id"), el("div", "field-desc muted", "The model catalog is available once the engine is running."), modelFallback);
  const archive = el("div", "control-row");
  const archiveInput = el("input", "wide");
  archiveInput.placeholder = "Not set: models are downloaded";
  archiveInput.spellcheck = false;
  archiveInput.addEventListener("change", () => update("model.offlineArchive", archiveInput.value.trim() || undefined));
  const browse = button("Browse…", { icon: "folder-opened", secondary: true });
  browse.addEventListener("click", () => post({ type: "browseArchive" }));
  archive.append(archiveInput, browse);
  modelSec.append(modelNote, modelList, modelFallbackWrap);
  modelSec.append(
    field("model.offlineArchive", "Offline archive", "Install the model from a local archive instead of downloading it. Useful on machines without internet access.", archive, (v) => {
      if (document.activeElement !== archiveInput) archiveInput.value = String(v ?? "");
    }).root,
  );

  function renderModels(): void {
    if (!state) return;
    const active = String(value("embedding.provider") ?? "local");
    const note = modelNote.querySelector("span")!;
    modelNote.hidden = active === "local";
    note.textContent = `Not in use: the active provider is ${active}.`;
    modelSec.classList.toggle("inactive", active !== "local");
    const current = String(value("model.id") ?? "");
    modelList.textContent = "";
    modelList.hidden = state.models === null;
    modelFallbackWrap.hidden = state.models !== null;
    if (document.activeElement !== modelFallback) modelFallback.value = current;
    for (const m of state.models ?? []) modelList.append(modelCard(m, m.id === current));
  }

  function modelCard(m: ModelListItem, isActive: boolean): HTMLElement {
    const card = el("div", `card model${isActive ? " active" : ""}`);
    const radio = el("button", "radio");
    radio.type = "button";
    radio.setAttribute("role", "radio");
    radio.setAttribute("aria-checked", String(isActive));
    radio.setAttribute("aria-label", `Use ${m.id}`);
    const choose = () => {
      if (!isActive) update("model.id", m.id);
    };
    radio.addEventListener("click", choose);
    card.addEventListener("click", (e) => {
      if (e.target !== radio) choose();
    });
    if (!isActive) card.title = m.installed ? `Use ${m.id}` : `Use ${m.id} (downloads ${formatMb(m.sizeMb)})`;
    const body = el("div", "provider-body");
    const title = el("div", "provider-title");
    title.append(el("span", "provider-name", m.id));
    if (m.isDefault) title.append(tag("default", { icon: "star-full" }));
    title.append(m.installed ? tag("installed", { icon: "pass", tone: "ok" }) : tag(`downloads ${formatMb(m.sizeMb)}`, { icon: "cloud-download" }));
    body.append(title, el("div", "provider-meta muted", `${m.dims} dimensions · ${formatMb(m.sizeMb)} · ${m.license}`));
    card.append(radio, body);
    return card;
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
    numberField("index.maxFileKb", "Maximum file size", "Larger files are skipped.", 1, "KB"),
    numberField("index.threads", "Threads", "Threads for the built-in model. 0 picks a value automatically.", 0),
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
    b.append(icon(MODE_INFO[m].icon), m[0]!.toUpperCase() + m.slice(1));
    b.title = MODE_INFO[m].label;
    b.addEventListener("click", () => update("search.defaultMode", m));
    modeBtns.set(m, b);
    modeSeg.append(b);
  }
  const modeDesc = el("div", "muted option-desc");
  const modeWrap = el("div");
  modeWrap.append(modeSeg, modeDesc);
  searchSec.append(
    field("search.defaultMode", "Default mode", "The mode the search panel starts in. You can switch it next to the search box.", modeWrap, (v) => {
      const mode = (v ?? "hybrid") as SearchMode;
      for (const [k, b] of modeBtns) b.setAttribute("aria-checked", String(k === mode));
      modeDesc.textContent = MODE_INFO[mode]?.label ?? "";
    }).root,
    numberField("search.top", "Results", "How many results to show.", 1),
  );

  // ---- Integrations
  const intSec = section("integrations", "Integrations");
  const integration = (ic: string, title: string, desc: string, label: string, action: "installCli" | "copyMcpConfig" | "showLog") => {
    const row = el("div", "card integration");
    const text = el("div", "integration-text");
    const t = el("div", "integration-title");
    t.append(icon(ic), el("span", undefined, title));
    text.append(t, el("div", "muted", desc));
    const b = button(label, { secondary: true });
    b.addEventListener("click", () => post({ type: "action", action }));
    row.append(text, b);
    intSec.append(row);
  };
  integration("terminal", "Command line", "Install the code-embed CLI to search from the terminal and scripts.", "Install CLI", "installCli");
  integration("plug", "MCP for agents", "Copy a config for Claude Code, Cursor and other MCP clients.", "Copy MCP config", "copyMcpConfig");
  integration("output", "Log", "Engine output and indexing errors.", "Show log", "showLog");

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
    scopeUser.setAttribute("aria-checked", String(!ws));
    scopeWs.setAttribute("aria-checked", String(ws));
    scopeWs.disabled = !state.hasWorkspace;
    scopeWs.title = state.hasWorkspace ? "Save to this workspace (.vscode/settings.json)" : "Open a folder to use workspace settings";
    scopeHint.textContent = ws ? "Changes are saved for this workspace" : "Changes are saved for all workspaces";
    for (const f of fields) {
      const info = state.settings[f.key];
      f.set(info.value);
      const here = ws ? info.workspace : info.user;
      f.root.classList.toggle("modified", here !== undefined);
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
    renderProviders();
    renderModels();
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
