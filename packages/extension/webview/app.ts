import hljs from "highlight.js/lib/common";
import type { IndexStatus, SearchMode, SearchResponse, SearchResult } from "@code-embed/protocol/rpc";
import { SEARCH_MODES } from "@code-embed/protocol/rpc";
import type { ClientState } from "../src/engine/types";
import type { HostToWebview, WebviewToHost } from "../src/panel/messages";
import { button, el, icon, iconButton } from "./dom";
import {
  bannerText,
  createDebouncer,
  DEBOUNCE_MS,
  embeddedPercent,
  EXAMPLE_QUERIES,
  groupByFile,
  indexSummary,
  kindIcon,
  MODE_INFO,
  snippetWindow,
  splitGlobs,
  splitPath,
  summaryText,
} from "./logic";

export interface HostApi {
  postMessage(msg: WebviewToHost): void;
}

export interface App {
  handle(msg: HostToWebview): void;
}

function wrapMatches(line: HTMLElement, spans: { start: number; end: number }[]): void {
  if (spans.length === 0) return;
  const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n as Text);
  let offset = 0;
  for (const node of nodes) {
    const text = node.data;
    const from = offset;
    const to = offset + text.length;
    offset = to;
    const hits = spans.filter((s) => s.start < to && s.end > from).sort((a, b) => a.start - b.start);
    if (hits.length === 0) continue;
    const frag = document.createDocumentFragment();
    let pos = 0;
    for (const h of hits) {
      const s = Math.max(h.start - from, pos);
      const e = h.end - from > text.length ? text.length : h.end - from;
      if (e <= s) continue;
      if (s > pos) frag.append(text.slice(pos, s));
      frag.append(el("mark", "match", text.slice(s, e)));
      pos = e;
    }
    if (pos < text.length) frag.append(text.slice(pos));
    node.replaceWith(frag);
  }
}

function renderLine(text: string, lang: string | null, spans: { start: number; end: number }[]): HTMLElement {
  const code = el("code", "line-code");
  if (lang && hljs.getLanguage(lang)) {
    code.innerHTML = hljs.highlight(text, { language: lang, ignoreIllegals: true }).value;
  } else {
    code.textContent = text;
  }
  wrapMatches(code, spans);
  return code;
}

function renderSnippet(r: SearchResult): HTMLElement {
  const pre = el("div", "snippet");
  const all = r.snippet.text.split("\n");
  const firstMatch = r.snippet.highlights.reduce<number | undefined>((m, h) => (m === undefined || h.line < m ? h.line : m), undefined);
  const { from, to } = snippetWindow(all.length, firstMatch);
  for (let i = from; i < to; i++) {
    const row = el("div", "line");
    row.append(el("span", "line-no", String(r.snippet.startLine + i)));
    const spans = r.snippet.highlights.filter((h) => h.line === i);
    row.append(renderLine(all[i]!, r.lang, spans));
    pre.append(row);
  }
  const hidden = r.range.endLine - r.range.startLine + 1 - (to - from);
  if (hidden > 0) pre.append(el("div", "more-lines", `+${hidden} more line${hidden === 1 ? "" : "s"}`));
  return pre;
}

function sourceBadge(r: SearchResult): HTMLElement {
  const lex = r.sources.includes("lexical");
  const sem = r.sources.includes("semantic");
  const kind = lex && sem ? "both" : lex ? "lexical" : "semantic";
  const label = lex && sem ? "Matched by meaning and keywords" : lex ? "Matched by keywords" : "Matched by meaning";
  const badge = el("span", `source source-${kind}`);
  if (sem) badge.append(icon(MODE_INFO.semantic.icon));
  if (lex) badge.append(icon(MODE_INFO.lexical.icon));
  badge.title = label;
  badge.setAttribute("aria-label", label);
  return badge;
}

export function createApp(root: HTMLElement, host: HostApi): App {
  let mode: SearchMode = "hybrid";
  let pageSize = 20;
  let limit = pageSize;
  let queryKey = "";
  let renderedKey = "";
  let requestId = 0;
  let pendingId: number | undefined;
  let status: IndexStatus | undefined;
  let engine: ClientState | undefined;
  let lastResponse: SearchResponse | undefined;
  let items: { result: SearchResult; node: HTMLElement; group: HTMLElement }[] = [];
  let selected = -1;

  root.textContent = "";
  const input = el("input", "query");
  input.type = "text";
  input.setAttribute("aria-label", "Search query");
  input.spellcheck = false;

  const modes = el("div", "modes");
  modes.setAttribute("role", "group");
  modes.setAttribute("aria-label", "Search mode");
  const modeButtons = new Map<SearchMode, HTMLButtonElement>();
  for (const m of SEARCH_MODES) {
    const b = iconButton(MODE_INFO[m].icon, `${MODE_INFO[m].label} (Alt+Up/Down to switch)`, "mode");
    b.dataset.mode = m;
    b.addEventListener("click", () => {
      setMode(m);
      debounce.flush();
    });
    modeButtons.set(m, b);
    modes.append(b);
  }
  const box = el("div", "search-box");
  box.append(input, modes);

  const filterToggle = iconButton("filter", "Toggle filters", "filter-toggle");
  filterToggle.setAttribute("aria-expanded", "false");
  const searchRow = el("div", "search-row");
  searchRow.append(box, filterToggle);

  const filterInput = (cls: string, label: string, placeholder: string) => {
    const wrap = el("label", "filter-field");
    wrap.append(el("span", "filter-label", label));
    const f = el("input", `filter ${cls}`);
    f.placeholder = placeholder;
    f.spellcheck = false;
    wrap.append(f);
    return { wrap, f };
  };
  const inc = filterInput("include", "files to include", "e.g. src/**, *.ts");
  const exc = filterInput("exclude", "files to exclude", "e.g. **/*.test.ts");
  const lng = filterInput("lang", "language", "e.g. typescript");
  const include = inc.f;
  const exclude = exc.f;
  const lang = lng.f;
  const filters = el("div", "filters");
  filters.hidden = true;
  filters.append(inc.wrap, exc.wrap, lng.wrap);

  const filterSummary = el("div", "filter-summary");
  filterSummary.hidden = true;
  const filterSummaryText = el("button", "filter-summary-text");
  filterSummaryText.type = "button";
  filterSummaryText.title = "Edit filters";
  const clearFilters = iconButton("close", "Clear filters");
  filterSummary.append(icon("filter"), filterSummaryText, clearFilters);

  const busy = el("div", "busy");
  busy.append(el("div"));
  const banner = el("div", "banner");
  banner.hidden = true;
  const bannerIcon = el("span");
  const bannerLabel = el("span", "banner-text");
  const bannerMeter = el("div", "banner-meter");
  const bannerFill = el("div");
  bannerMeter.append(bannerFill);
  banner.append(bannerIcon, bannerLabel, bannerMeter);

  const titleBar = el("div", "title-bar");
  titleBar.hidden = true;
  const heading = el("span", "title");
  const closeTitle = iconButton("close", "Back to search");
  titleBar.append(icon("references"), heading, closeTitle);

  const summary = el("div", "summary");
  summary.hidden = true;
  const message = el("div", "message");
  message.hidden = true;
  const empty = el("div", "empty");
  const list = el("div", "results");
  list.setAttribute("role", "listbox");
  const more = button("Show more results", { icon: "chevron-down", secondary: true, cls: "show-more" });
  more.hidden = true;

  const header = el("div", "header");
  header.append(searchRow, filterSummary, filters, busy);
  root.append(header, banner, titleBar, summary, message, empty, list, more);

  function setMode(m: SearchMode): void {
    mode = m;
    for (const [k, b] of modeButtons) b.setAttribute("aria-pressed", String(k === m));
    input.placeholder = MODE_INFO[m].placeholder;
  }
  setMode(mode);

  function filtersActive(): boolean {
    return [include, exclude, lang].some((f) => f.value.trim() !== "");
  }

  function updateFilterToggle(): void {
    filterToggle.classList.toggle("active", filtersActive());
    filterToggle.setAttribute("aria-pressed", String(!filters.hidden));
    const parts = [
      ...splitGlobs(include.value),
      ...splitGlobs(exclude.value).map((g) => `!${g}`),
      ...(lang.value.trim() ? [lang.value.trim()] : []),
    ];
    filterSummary.hidden = !filters.hidden || parts.length === 0;
    filterSummaryText.textContent = parts.join(", ");
  }

  function setBusy(on: boolean): void {
    busy.classList.toggle("active", on);
    list.classList.toggle("stale", on);
  }

  function cancelPending(): void {
    if (pendingId !== undefined) host.postMessage({ type: "cancel", requestId: pendingId });
    pendingId = undefined;
    setBusy(false);
  }

  function showMessage(text: string | undefined, hint?: string, isError = false): void {
    message.hidden = text === undefined;
    message.classList.toggle("error", isError);
    message.textContent = "";
    if (text === undefined) return;
    message.append(icon(isError ? "error" : "search-stop"), el("span", undefined, text));
    if (hint) message.append(el("div", "hint", hint));
  }

  function updateBanner(): void {
    const text = bannerText(lastResponse, status);
    banner.hidden = text === undefined;
    bannerLabel.textContent = text ?? "";
    const indexing = text !== undefined && !text.startsWith("Semantic");
    banner.title = lastResponse?.partialReason ?? (indexing ? "Semantic matches cover only the part of the code embedded so far" : "");
    bannerIcon.className = `codicon codicon-${indexing ? "sync spin" : "warning"}`;
    bannerMeter.hidden = !indexing;
    bannerFill.style.width = `${embeddedPercent(status)}%`;
  }

  function updateEmpty(): void {
    const show = !input.value.trim() && titleBar.hidden && lastResponse === undefined;
    empty.hidden = !show;
    if (!show) return;
    empty.textContent = "";
    if (engine === "starting" || engine === "restarting") {
      empty.append(el("div", "empty-title", "Starting the search engine…"));
      empty.firstElementChild!.prepend(icon("loading", "spin"));
      return;
    }
    if (engine === "failed" || engine === "stopped") {
      empty.append(el("div", "empty-title", "The search engine is not running."));
      const log = button("Show log", { icon: "output", secondary: true });
      log.addEventListener("click", () => host.postMessage({ type: "command", command: "showLog" }));
      empty.append(log);
      return;
    }
    if (status && status.chunks === 0 && status.phase === "idle") {
      empty.append(el("div", "empty-title", "This workspace is not indexed yet."));
      const idx = button("Index workspace", { icon: "database" });
      idx.addEventListener("click", () => host.postMessage({ type: "command", command: "index" }));
      empty.append(idx);
      return;
    }
    empty.append(el("div", "empty-title", "Describe what you are looking for, or type an identifier."));
    const examples = el("ul", "examples");
    for (const q of EXAMPLE_QUERIES) {
      const li = el("li");
      const b = el("button", "link example", q);
      b.type = "button";
      b.addEventListener("click", () => {
        input.value = q;
        debounce.flush();
        input.focus();
      });
      li.append(icon("search"), b);
      examples.append(li);
    }
    empty.append(examples);
    const legend = el("div", "legend");
    for (const m of SEARCH_MODES) {
      const row = el("div");
      row.append(icon(MODE_INFO[m].icon), el("span", undefined, MODE_INFO[m].label));
      legend.append(row);
    }
    empty.append(legend);
    if (status) {
      const foot = el("div", "index-info");
      foot.append(icon("database"), el("span", undefined, indexSummary(status)));
      const settings = el("button", "link", "Settings");
      settings.type = "button";
      settings.addEventListener("click", () => host.postMessage({ type: "command", command: "openSettings" }));
      foot.append(settings);
      empty.append(foot);
    }
  }

  function navNodes(): HTMLElement[] {
    return [...list.querySelectorAll<HTMLElement>(".file, .group:not(.collapsed) .result")];
  }

  // Steps to the next or previous result, skipping file rows; returns undefined past either end.
  function step(from: HTMLElement | null, delta: 1 | -1): HTMLElement | undefined {
    const nodes = navNodes();
    let i = from ? nodes.indexOf(from) : delta === 1 ? -1 : nodes.length;
    for (i += delta; i >= 0 && i < nodes.length; i += delta) {
      if (nodes[i]!.classList.contains("result")) return nodes[i];
    }
    return undefined;
  }

  function setCollapsed(group: HTMLElement, on: boolean): void {
    group.classList.toggle("collapsed", on);
    group.querySelector(".file")!.setAttribute("aria-expanded", String(!on));
  }

  function select(i: number, focus = true): void {
    items[selected]?.node.classList.remove("selected");
    items[selected]?.node.setAttribute("aria-selected", "false");
    selected = i;
    const it = items[i];
    if (!it) return;
    it.node.classList.add("selected");
    it.node.setAttribute("aria-selected", "true");
    if (focus) it.node.focus();
  }

  function open(r: SearchResult, side = false): void {
    host.postMessage({ type: "open", path: r.path, range: r.range, ...(side ? { side } : {}) });
  }

  function resetResults(): void {
    list.textContent = "";
    items = [];
    selected = -1;
    lastResponse = undefined;
    renderedKey = "";
    summary.hidden = true;
    more.hidden = true;
  }

  function resultActions(r: SearchResult): HTMLElement {
    const bar = el("div", "result-actions");
    const action = (ic: string, label: string, fn: () => void) => {
      const b = iconButton(ic, label);
      b.tabIndex = -1;
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        fn();
      });
      bar.append(b);
    };
    action("split-horizontal", "Open to the side (Ctrl+Enter)", () => open(r, true));
    action("copy", "Copy path and line", () => host.postMessage({ type: "copy", text: `${r.path}:${r.range.startLine}` }));
    action("references", "Find similar code", () => host.postMessage({ type: "similar", path: r.path, range: { startLine: r.range.startLine, endLine: r.range.endLine } }));
    return bar;
  }

  function render(resp: SearchResponse, key: string): void {
    const keep = key !== "" && key === renderedKey;
    const collapsed = new Set(keep ? [...list.querySelectorAll<HTMLElement>(".group.collapsed")].map((g) => g.dataset.path) : []);
    const prev = keep ? selected : -1;
    renderedKey = key;
    list.textContent = "";
    items = [];
    selected = -1;
    const groups = groupByFile(resp.results);
    for (const g of groups) {
      const group = el("div", "group");
      group.dataset.path = g.path;
      const file = el("div", "file");
      file.tabIndex = -1;
      file.setAttribute("aria-expanded", "true");
      const { name, dir } = splitPath(g.path);
      file.title = g.path;
      file.append(icon("chevron-down", "twistie"), el("span", "file-name", name), el("span", "file-dir", dir), el("span", "badge", String(g.results.length)));
      file.addEventListener("click", () => setCollapsed(group, !group.classList.contains("collapsed")));
      group.append(file);
      for (const r of g.results) {
        const node = el("div", "result");
        node.tabIndex = 0;
        node.setAttribute("role", "option");
        node.setAttribute("aria-selected", "false");
        const head = el("div", "result-head");
        const kind = icon(kindIcon(r.kind), "kind");
        kind.title = r.kind;
        head.append(kind, el("span", "symbol", r.symbol ?? r.kind), resultActions(r), sourceBadge(r), el("span", "lines", `${r.range.startLine}–${r.range.endLine}`));
        node.append(head, renderSnippet(r));
        const idx = items.length;
        node.dataset.idx = String(idx);
        node.addEventListener("click", (e) => {
          select(idx, false);
          open(r, e.ctrlKey || e.metaKey);
        });
        items.push({ result: r, node, group });
        group.append(node);
      }
      if (collapsed.has(g.path)) setCollapsed(group, true);
      list.append(group);
    }
    if (prev >= 0 && items[prev]) select(prev, false);
    summary.hidden = resp.results.length === 0;
    summary.textContent = summaryText(resp, groups.length);
    more.hidden = key === "" || resp.total === undefined || resp.total <= resp.results.length;
    if (resp.results.length > 0) showMessage(undefined);
    else if (filtersActive()) showMessage("No results", "Filters are active. Clear them to search the whole workspace.");
    else if (mode === "lexical") showMessage("No results", "Try Hybrid or Semantic mode to search by meaning.");
    else showMessage("No results");
  }

  function search(): void {
    const query = input.value.trim();
    cancelPending();
    requestId++;
    titleBar.hidden = true;
    if (!query) {
      resetResults();
      showMessage(undefined);
      updateBanner();
      updateEmpty();
      return;
    }
    const params = {
      query,
      mode,
      include: splitGlobs(include.value),
      exclude: splitGlobs(exclude.value),
      lang: lang.value.trim() || undefined,
    };
    const key = JSON.stringify(params);
    if (key !== queryKey) limit = pageSize;
    queryKey = key;
    empty.hidden = true;
    pendingId = requestId;
    setBusy(true);
    host.postMessage({ type: "search", requestId, ...params, top: limit });
  }

  const debounce = createDebouncer(DEBOUNCE_MS, search);

  input.addEventListener("input", () => debounce.schedule());
  for (const f of [include, exclude, lang]) {
    f.addEventListener("keydown", (e) => {
      if (e.key === "Enter") debounce.flush();
    });
    f.addEventListener("input", () => {
      updateFilterToggle();
      debounce.schedule();
    });
  }
  more.addEventListener("click", () => {
    limit += pageSize;
    debounce.flush();
  });
  filterSummaryText.addEventListener("click", () => filterToggle.click());
  clearFilters.addEventListener("click", () => {
    for (const f of [include, exclude, lang]) f.value = "";
    updateFilterToggle();
    debounce.flush();
    input.focus();
  });
  filterToggle.addEventListener("click", () => {
    filters.hidden = !filters.hidden;
    filterToggle.setAttribute("aria-expanded", String(!filters.hidden));
    updateFilterToggle();
    if (!filters.hidden) include.focus();
  });
  closeTitle.addEventListener("click", () => {
    titleBar.hidden = true;
    resetResults();
    showMessage(undefined);
    if (input.value.trim()) debounce.flush();
    else updateEmpty();
    input.focus();
  });

  function focusResult(node: HTMLElement | undefined): void {
    if (node) select(Number(node.dataset.idx));
  }

  root.addEventListener("keydown", (e) => {
    const target = e.target as HTMLElement;
    const isResult = target.classList.contains("result");
    const isFile = target.classList.contains("file");
    // VS Code also runs its own keybindings for keys pressed in a webview, and Alt+digit opens editor tabs on Windows and Linux.
    if (e.altKey && !e.ctrlKey && !e.metaKey && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      e.preventDefault();
      const i = SEARCH_MODES.indexOf(mode);
      setMode(SEARCH_MODES[(i + (e.key === "ArrowDown" ? 1 : SEARCH_MODES.length - 1)) % SEARCH_MODES.length]!);
      if (input.value.trim()) debounce.flush();
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (target !== input && !isResult && !isFile) return;
      const down = e.key === "ArrowDown";
      const next = step(target === input ? null : target, down ? 1 : -1);
      if (target === input && !down) return;
      e.preventDefault();
      if (next) focusResult(next);
      else if (!down) {
        select(-1);
        input.focus();
      }
    } else if (e.key === "ArrowLeft" && (isResult || isFile)) {
      e.preventDefault();
      const group = target.closest<HTMLElement>(".group")!;
      if (isFile) setCollapsed(group, true);
      else {
        select(-1, false);
        group.querySelector<HTMLElement>(".file")!.focus();
      }
    } else if (e.key === "ArrowRight" && isFile) {
      e.preventDefault();
      const group = target.closest<HTMLElement>(".group")!;
      if (group.classList.contains("collapsed")) setCollapsed(group, false);
      else focusResult(group.querySelector<HTMLElement>(".result") ?? undefined);
    } else if (e.key === "Enter" || (e.key === " " && isFile)) {
      if (target === input) {
        debounce.flush();
      } else if (isFile) {
        e.preventDefault();
        target.click();
      } else if (isResult && items[selected]) {
        e.preventDefault();
        open(items[selected]!.result, e.ctrlKey || e.metaKey);
      }
    } else if (e.key === "Escape") {
      if (target === input && input.value) {
        input.value = "";
        debounce.flush();
      } else if (isResult || isFile) {
        select(-1, false);
        input.focus();
      }
    }
  });

  updateFilterToggle();
  updateEmpty();

  return {
    handle(msg) {
      switch (msg.type) {
        case "config":
          setMode(msg.defaultMode);
          pageSize = msg.top;
          limit = Math.max(limit, pageSize);
          break;
        case "status":
          status = msg.status;
          updateBanner();
          updateEmpty();
          break;
        case "engine":
          engine = msg.state;
          updateEmpty();
          break;
        case "focusInput":
          if (msg.query !== undefined) {
            input.value = msg.query;
            debounce.flush();
          }
          input.focus();
          input.select();
          break;
        case "clear":
          debounce.cancel();
          cancelPending();
          requestId++;
          input.value = "";
          titleBar.hidden = true;
          resetResults();
          showMessage(undefined);
          updateBanner();
          updateEmpty();
          input.focus();
          break;
        case "results":
          if (msg.title === undefined && msg.requestId !== requestId) return;
          if (msg.title !== undefined) {
            debounce.cancel();
            cancelPending();
            requestId++;
            heading.textContent = msg.title;
            titleBar.hidden = false;
          } else {
            pendingId = undefined;
            setBusy(false);
            titleBar.hidden = true;
          }
          empty.hidden = true;
          lastResponse = msg.response;
          render(msg.response, msg.title === undefined ? queryKey : "");
          updateBanner();
          break;
        case "error":
          if (msg.requestId !== undefined && msg.requestId !== requestId) return;
          pendingId = undefined;
          setBusy(false);
          showMessage(msg.message, undefined, true);
          break;
      }
    },
  };
}
