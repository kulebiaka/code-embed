import hljs from "highlight.js/lib/common";
import type { IndexStatus, SearchMode, SearchResponse, SearchResult } from "@code-embed/protocol/rpc";
import { SEARCH_MODES } from "@code-embed/protocol/rpc";
import type { ClientState } from "../src/engine/types";
import type { HostToWebview, SimilarSource, WebviewToHost } from "../src/panel/messages";
import { button, el, icon, iconButton } from "./dom";
import {
  addRecent,
  createDebouncer,
  DEBOUNCE_MS,
  embeddedPercent,
  EXAMPLE_QUERIES,
  groupByFile,
  indexBanner,
  indexState,
  indexSummary,
  kindIcon,
  meaningIncomplete,
  MODE_INFO,
  modelLabel,
  type RecentQuery,
  snippetWindow,
  sourceLabel,
  splitGlobs,
  splitPath,
  summaryText,
} from "./logic";

export interface HostApi {
  postMessage(msg: WebviewToHost): void;
  getState?(): unknown;
  setState?(state: unknown): void;
}

export interface App {
  handle(msg: HostToWebview): void;
}

const WEAK_SIMILARITY = 0.75;

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

function codeBlock(lines: { no: number; text: string; spans: { start: number; end: number }[] }[], lang: string | null, hidden: number): HTMLElement {
  const pre = el("div", "snippet");
  for (const l of lines) {
    const row = el("div", "line");
    row.append(el("span", "line-no", String(l.no)), renderLine(l.text, lang, l.spans));
    pre.append(row);
  }
  if (hidden > 0) pre.append(el("div", "more-lines", `+${hidden} more line${hidden === 1 ? "" : "s"}`));
  return pre;
}

function renderSnippet(r: SearchResult): HTMLElement {
  const all = r.snippet.text.split("\n");
  const firstMatch = r.snippet.highlights.reduce<number | undefined>((m, h) => (m === undefined || h.line < m ? h.line : m), undefined);
  const { from, to } = snippetWindow(all.length, firstMatch);
  const lines = [];
  for (let i = from; i < to; i++) lines.push({ no: r.snippet.startLine + i, text: all[i]!, spans: r.snippet.highlights.filter((h) => h.line === i) });
  return codeBlock(lines, r.lang, r.range.endLine - r.range.startLine + 1 - (to - from));
}

function sourceTag(r: SearchResult): HTMLElement {
  const lex = r.sources.includes("lexical");
  const sem = r.sources.includes("semantic");
  const kind = lex && sem ? "both" : lex ? "lexical" : "semantic";
  const tag = el("span", `tag source source-${kind}`, sourceLabel(r.sources));
  tag.title = lex && sem ? "Matched by meaning and keywords" : lex ? "Matched by keywords" : "Matched by meaning";
  return tag;
}

function scoreBar(score: number, top: number): HTMLElement {
  const bar = el("span", "score");
  const fill = el("span");
  const pct = top > 0 ? Math.round((score / top) * 100) : 0;
  fill.style.width = `${pct}%`;
  bar.title = `Relevance ${pct}% of the best match`;
  bar.append(fill);
  return bar;
}

function keyHints(): HTMLElement {
  const mac = /Mac|iPhone|iPad/.test(navigator.platform);
  const row = el("div", "keys");
  const hints: [string, string][] = [
    ["↑↓", "results"],
    ["⏎", "open"],
    [mac ? "⌘⏎" : "Ctrl+⏎", "to the side"],
    [mac ? "⌥↑↓" : "Alt+↑↓", "mode"],
  ];
  for (const [k, label] of hints) {
    const hint = el("span", "key-hint");
    hint.append(el("kbd", undefined, k), label);
    row.append(hint);
  }
  return row;
}

function loadRecent(host: HostApi): RecentQuery[] {
  const s = host.getState?.() as { recent?: RecentQuery[] } | undefined;
  return Array.isArray(s?.recent) ? s.recent.filter((r) => typeof r.query === "string" && SEARCH_MODES.includes(r.mode)) : [];
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
  let similar: SimilarSource | undefined;
  let recent = loadRecent(host);
  let items: { result: SearchResult; node: HTMLElement; group: HTMLElement }[] = [];
  let selected = -1;

  root.textContent = "";
  const input = el("input", "query");
  input.type = "text";
  input.setAttribute("aria-label", "Search query");
  input.spellcheck = false;
  const box = el("div", "search-box");
  box.append(input);

  const filterToggle = iconButton("ellipsis", "Toggle filters", "filter-toggle");
  filterToggle.setAttribute("aria-expanded", "false");

  const modes = el("div", "modes");
  modes.setAttribute("role", "group");
  modes.setAttribute("aria-label", "Search mode");
  const modeButtons = new Map<SearchMode, HTMLButtonElement>();
  const semanticPct = el("span", "mode-pct");
  for (const m of SEARCH_MODES) {
    const b = el("button", "mode");
    b.type = "button";
    b.dataset.mode = m;
    b.title = `${MODE_INFO[m].label} (Alt+Up/Down to switch)`;
    b.append(icon(MODE_INFO[m].icon), el("span", undefined, MODE_INFO[m].name));
    if (m === "semantic") b.append(semanticPct);
    b.addEventListener("click", () => {
      setMode(m);
      debounce.flush();
    });
    modeButtons.set(m, b);
    modes.append(b);
  }

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
  const chips = el("div", "filter-chips");
  chips.hidden = true;
  const filterBar = el("div", "filter-bar");
  filterBar.append(chips, filterToggle);

  const busy = el("div", "busy");
  busy.append(el("div"));

  const banner = el("div", "banner");
  banner.hidden = true;
  const bannerIcon = el("span");
  const bannerTitle = el("span", "banner-title");
  const bannerPct = el("span", "banner-pct");
  const bannerPause = iconButton("debug-pause", "Pause indexing", "banner-pause");
  const bannerHead = el("div", "banner-head");
  bannerHead.append(bannerIcon, bannerTitle, bannerPct, bannerPause);
  const bannerMeter = el("div", "meter");
  const bannerFill = el("div");
  bannerMeter.append(bannerFill);
  const bannerDetail = el("div", "banner-detail");
  banner.append(bannerHead, bannerMeter, bannerDetail);

  const similarCard = el("div", "similar-card");
  similarCard.hidden = true;

  const summaryBar = el("div", "summary-bar");
  summaryBar.hidden = true;
  const summary = el("span", "summary");
  const codeToggle = iconButton("symbol-snippet", "Hide code", "toggle-code");
  codeToggle.setAttribute("aria-pressed", "false");
  const viewToggle = iconButton("list-flat", "View as list", "toggle-view");
  viewToggle.setAttribute("aria-pressed", "false");
  const collapseAll = iconButton("collapse-all", "Collapse all", "collapse-all");
  summaryBar.append(summary, codeToggle, viewToggle, collapseAll);

  const message = el("div", "message");
  message.hidden = true;
  const empty = el("div", "empty");
  const list = el("div", "results");
  list.setAttribute("role", "listbox");
  const more = button("Show more results", { icon: "chevron-down", secondary: true, cls: "show-more" });
  more.hidden = true;

  const header = el("div", "header");
  header.append(box, modes, filterBar, filters, busy);
  root.append(header, banner, similarCard, summaryBar, message, empty, list, more);

  function setMode(m: SearchMode): void {
    mode = m;
    for (const [k, b] of modeButtons) b.setAttribute("aria-pressed", String(k === m));
    input.placeholder = MODE_INFO[m].placeholder;
  }
  setMode(mode);

  function remember(query: string): void {
    if (!query) return;
    recent = addRecent(recent, { query, mode });
    host.setState?.({ recent });
  }

  function filtersActive(): boolean {
    return [include, exclude, lang].some((f) => f.value.trim() !== "");
  }

  function removeGlob(f: HTMLInputElement, glob: string): void {
    f.value = splitGlobs(f.value)
      .filter((g) => g !== glob)
      .join(", ");
  }

  function renderChips(): void {
    chips.textContent = "";
    const parts = [
      ...splitGlobs(include.value).map((g) => ({ label: g, remove: () => removeGlob(include, g) })),
      ...splitGlobs(exclude.value).map((g) => ({ label: `not ${g}`, remove: () => removeGlob(exclude, g) })),
      ...(lang.value.trim() ? [{ label: lang.value.trim(), remove: () => (lang.value = "") }] : []),
    ];
    chips.hidden = !filters.hidden || parts.length === 0;
    for (const p of parts) {
      const chip = el("span", "chip");
      const remove = iconButton("close", `Remove filter ${p.label}`, "chip-remove");
      remove.addEventListener("click", () => {
        p.remove();
        updateFilterToggle();
        debounce.flush();
      });
      chip.append(el("span", "chip-label", p.label), remove);
      chips.append(chip);
    }
    const add = el("button", "add-filter");
    add.type = "button";
    add.append(icon("add"), "Filter");
    add.addEventListener("click", () => filterToggle.click());
    chips.append(add);
  }

  function updateFilterToggle(): void {
    filterToggle.classList.toggle("active", filtersActive());
    filterToggle.setAttribute("aria-pressed", String(!filters.hidden));
    renderChips();
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
    const b = indexBanner(lastResponse, status);
    semanticPct.textContent = meaningIncomplete(status) ? `${embeddedPercent(status)}%` : "";
    banner.hidden = b === undefined;
    if (!b) return;
    banner.className = `banner banner-${b.kind}`;
    bannerTitle.textContent = b.title;
    bannerDetail.textContent = b.detail ?? "";
    bannerDetail.hidden = !b.detail;
    const progress = b.percent !== undefined;
    bannerIcon.className = `codicon codicon-${b.kind === "indexing" ? "sync spin" : b.kind === "paused" ? "debug-pause" : "warning"}`;
    bannerPct.textContent = progress ? `${b.percent}%` : "";
    bannerMeter.hidden = !progress;
    bannerFill.style.width = `${b.percent ?? 0}%`;
    bannerPause.hidden = !progress;
    const paused = b.kind === "paused";
    const label = paused ? "Resume indexing" : "Pause indexing";
    bannerPause.title = label;
    bannerPause.setAttribute("aria-label", label);
    bannerPause.firstElementChild!.className = `codicon codicon-${paused ? "debug-start" : "debug-pause"}`;
  }

  function section(title: string): HTMLElement {
    return el("div", "empty-section", title);
  }

  function renderRecent(): HTMLElement | undefined {
    if (recent.length === 0) return undefined;
    const box = el("div", "recent-list");
    for (const r of recent) {
      const row = el("button", "recent");
      row.type = "button";
      row.title = `${r.query} (${MODE_INFO[r.mode].name})`;
      const q = el("span", `recent-query${r.mode === "lexical" ? " mono" : ""}`, r.query);
      const m = icon(MODE_INFO[r.mode].icon, "recent-mode");
      const remove = iconButton("close", "Remove from recent", "recent-remove");
      remove.tabIndex = -1;
      remove.addEventListener("click", (e) => {
        e.stopPropagation();
        recent = recent.filter((x) => x.query !== r.query);
        host.setState?.({ recent });
        updateEmpty();
      });
      row.append(icon("history"), q, m, remove);
      row.addEventListener("click", () => {
        setMode(r.mode);
        input.value = r.query;
        remember(r.query);
        debounce.flush();
        input.focus();
      });
      box.append(row);
    }
    return box;
  }

  function updateEmpty(): void {
    const show = !input.value.trim() && similar === undefined && lastResponse === undefined;
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
    const recentList = renderRecent();
    if (recentList) empty.append(section("Recent"), recentList);
    const examples = el("div", "examples");
    for (const q of EXAMPLE_QUERIES) {
      const b = el("button", "chip example", q);
      b.type = "button";
      b.addEventListener("click", () => {
        input.value = q;
        remember(q);
        debounce.flush();
        input.focus();
      });
      examples.append(b);
    }
    empty.append(section("Try"), examples);
    if (status) {
      const st = indexState(status);
      const foot = el("div", "index-info");
      const line = el("div", "index-line");
      line.append(icon("circle-filled", `index-dot tone-${st.tone}`), el("span", "index-state", st.label), el("span", "index-count", indexSummary(status)), el("span", "spacer"));
      const settings = el("button", "link", "Settings");
      settings.type = "button";
      settings.addEventListener("click", () => host.postMessage({ type: "command", command: "openSettings" }));
      line.append(settings);
      foot.append(line, el("div", "index-model", modelLabel(status)));
      empty.append(foot);
    }
    empty.append(keyHints());
  }

  function flat(): boolean {
    return list.classList.contains("flat");
  }

  function navNodes(): HTMLElement[] {
    return [...list.querySelectorAll<HTMLElement>(flat() ? ".result" : ".file, .group:not(.collapsed) .result")];
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
    updateCollapseAll();
  }

  function updateCollapseAll(): void {
    const expand = list.querySelector(".group:not(.collapsed)") === null && list.querySelector(".group") !== null;
    const label = expand ? "Expand all" : "Collapse all";
    collapseAll.title = label;
    collapseAll.setAttribute("aria-label", label);
    collapseAll.firstElementChild!.className = `codicon codicon-${expand ? "expand-all" : "collapse-all"}`;
    collapseAll.hidden = flat();
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
    if (similar === undefined) remember(input.value.trim());
    host.postMessage({ type: "open", path: r.path, range: r.range, ...(side ? { side } : {}) });
  }

  function resetResults(): void {
    list.textContent = "";
    items = [];
    selected = -1;
    lastResponse = undefined;
    renderedKey = "";
    summaryBar.hidden = true;
    more.hidden = true;
  }

  function closeSimilar(): void {
    similar = undefined;
    similarCard.hidden = true;
  }

  function requestSimilar(path: string, range: { startLine: number; endLine: number }, symbol: string | null, hideSameFile = true): void {
    setBusy(true);
    host.postMessage({ type: "similar", path, range, symbol, hideSameFile });
  }

  function renderSimilar(src: SimilarSource): void {
    similarCard.textContent = "";
    const head = el("div", "similar-head");
    const { name } = splitPath(src.path);
    const where = el("span", "similar-where", `${src.path} · ${src.range.startLine}–${src.range.endLine}`);
    where.title = src.path;
    const close = iconButton("close", "Back to search", "similar-close");
    close.addEventListener("click", () => {
      closeSimilar();
      resetResults();
      showMessage(undefined);
      if (input.value.trim()) debounce.flush();
      else updateEmpty();
      input.focus();
    });
    head.append(icon("references"), el("span", "muted", "Similar to"), el("span", "similar-symbol", src.symbol ?? name), where, close);
    similarCard.append(head);
    if (src.lines.length > 0) {
      const lines = src.lines.map((text, i) => ({ no: src.range.startLine + i, text, spans: [] }));
      similarCard.append(codeBlock(lines, src.lang, src.range.endLine - src.range.startLine + 1 - src.lines.length));
    }
    const hide = el("label", "check-row similar-hide");
    const box = el("input");
    box.type = "checkbox";
    box.checked = src.hideSameFile;
    box.addEventListener("change", () => requestSimilar(src.path, src.range, src.symbol, box.checked));
    hide.append(box, el("span", undefined, `Hide matches from ${name}`));
    similarCard.append(hide);
    similarCard.hidden = false;
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
    action("references", "Find similar code", () => requestSimilar(r.path, { startLine: r.range.startLine, endLine: r.range.endLine }, r.symbol));
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
    const top = resp.results.reduce((m, r) => Math.max(m, r.score), 0);
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
        const fileLabel = el("span", "result-file", name);
        fileLabel.title = g.path;
        head.append(kind, el("span", "symbol", r.symbol ?? r.kind), fileLabel, resultActions(r));
        if (similar) {
          const pct = el("span", `similarity${r.score < WEAK_SIMILARITY ? " weak" : ""}`, `${Math.round(r.score * 100)}%`);
          pct.title = "Similarity relative to the closest match";
          head.append(pct);
        } else {
          head.append(sourceTag(r), scoreBar(r.score, top));
        }
        head.append(el("span", "lines", `${r.range.startLine}–${r.range.endLine}`));
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
    updateCollapseAll();
    summaryBar.hidden = resp.results.length === 0;
    summary.textContent = summaryText(resp, groups.length, similar ? "similar chunk" : "result");
    more.hidden = key === "" || resp.total === undefined || resp.total <= resp.results.length;
    if (resp.results.length > 0) showMessage(undefined);
    else if (similar) showMessage("No similar code found");
    else if (filtersActive()) showMessage("No results", "Filters are active. Remove them to search the whole workspace.");
    else if (mode === "lexical") showMessage("No results", "Try Hybrid or Semantic mode to search by meaning.");
    else showMessage("No results");
  }

  function search(): void {
    const query = input.value.trim();
    cancelPending();
    requestId++;
    closeSimilar();
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
  filterToggle.addEventListener("click", () => {
    filters.hidden = !filters.hidden;
    filterToggle.setAttribute("aria-expanded", String(!filters.hidden));
    updateFilterToggle();
    if (!filters.hidden) include.focus();
  });
  bannerPause.addEventListener("click", () => host.postMessage({ type: "command", command: status?.phase === "paused" ? "resume" : "pause" }));
  codeToggle.addEventListener("click", () => {
    const hide = list.classList.toggle("no-code");
    const label = hide ? "Show code" : "Hide code";
    codeToggle.title = label;
    codeToggle.setAttribute("aria-label", label);
    codeToggle.setAttribute("aria-pressed", String(hide));
  });
  viewToggle.addEventListener("click", () => {
    const on = list.classList.toggle("flat");
    const label = on ? "View as tree" : "View as list";
    viewToggle.title = label;
    viewToggle.setAttribute("aria-label", label);
    viewToggle.setAttribute("aria-pressed", String(on));
    viewToggle.firstElementChild!.className = `codicon codicon-${on ? "list-tree" : "list-flat"}`;
    updateCollapseAll();
  });
  collapseAll.addEventListener("click", () => {
    const collapse = list.querySelector(".group:not(.collapsed)") !== null;
    for (const g of list.querySelectorAll<HTMLElement>(".group")) setCollapsed(g, collapse);
    if (collapse && selected >= 0) select(-1, false);
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
    } else if (e.key === "ArrowLeft" && (isResult || isFile) && !flat()) {
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
        remember(input.value.trim());
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
          closeSimilar();
          resetResults();
          showMessage(undefined);
          updateBanner();
          updateEmpty();
          input.focus();
          break;
        case "results":
          if (msg.similar === undefined && msg.requestId !== requestId) return;
          if (msg.similar !== undefined) {
            debounce.cancel();
            cancelPending();
            requestId++;
            similar = msg.similar;
            renderSimilar(msg.similar);
          } else {
            pendingId = undefined;
            setBusy(false);
            closeSimilar();
          }
          empty.hidden = true;
          lastResponse = msg.response;
          render(msg.response, msg.similar === undefined ? queryKey : "");
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
