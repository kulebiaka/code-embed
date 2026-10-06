import hljs from "highlight.js/lib/common";
import type { IndexStatus, SearchMode, SearchResponse, SearchResult } from "@code-embed/protocol/rpc";
import { SEARCH_MODES } from "@code-embed/protocol/rpc";
import type { HostToWebview, WebviewToHost } from "../src/panel/messages";
import { bannerText, createDebouncer, DEBOUNCE_MS, groupByFile, MAX_SNIPPET_LINES, moveSelection, splitGlobs } from "./logic";

export interface HostApi {
  postMessage(msg: WebviewToHost): void;
}

export interface App {
  handle(msg: HostToWebview): void;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
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
  const lines = r.snippet.text.split("\n").slice(0, MAX_SNIPPET_LINES);
  lines.forEach((text, i) => {
    const row = el("div", "line");
    row.append(el("span", "line-no", String(r.snippet.startLine + i)));
    const spans = r.snippet.highlights.filter((h) => h.line === i);
    row.append(renderLine(text, r.lang, spans));
    pre.append(row);
  });
  return pre;
}

function sourceBadge(r: SearchResult): HTMLElement {
  const lex = r.sources.includes("lexical");
  const sem = r.sources.includes("semantic");
  const label = lex && sem ? "lexical + semantic" : lex ? "lexical" : "semantic";
  const badge = el("span", `source source-${lex && sem ? "both" : lex ? "lexical" : "semantic"}`, lex && sem ? "◆⌕" : lex ? "⌕" : "◆");
  badge.title = label;
  badge.setAttribute("aria-label", label);
  return badge;
}

export function createApp(root: HTMLElement, host: HostApi): App {
  let mode: SearchMode = "hybrid";
  let requestId = 0;
  let pendingId: number | undefined;
  let status: IndexStatus | undefined;
  let lastResponse: SearchResponse | undefined;
  let title: string | undefined;
  let items: { result: SearchResult; node: HTMLElement }[] = [];
  let selected = -1;

  root.textContent = "";
  const input = el("input", "query");
  input.type = "text";
  input.placeholder = "Search code…";
  input.setAttribute("aria-label", "Search query");
  const modeSelect = el("select", "mode");
  modeSelect.setAttribute("aria-label", "Search mode");
  for (const m of SEARCH_MODES) {
    const o = el("option", undefined, m);
    o.value = m;
    modeSelect.append(o);
  }
  const include = el("input", "filter include");
  include.placeholder = "files to include (glob, comma-separated)";
  const exclude = el("input", "filter exclude");
  exclude.placeholder = "files to exclude";
  const lang = el("input", "filter lang");
  lang.placeholder = "language";
  const banner = el("div", "banner");
  banner.hidden = true;
  const heading = el("div", "title");
  heading.hidden = true;
  const message = el("div", "message");
  message.hidden = true;
  const list = el("div", "results");
  const top = el("div", "controls");
  top.append(input, modeSelect);
  const filters = el("div", "filters");
  filters.append(include, exclude, lang);
  root.append(top, filters, banner, heading, message, list);

  function cancelPending(): void {
    if (pendingId !== undefined) host.postMessage({ type: "cancel", requestId: pendingId });
    pendingId = undefined;
  }

  function showMessage(text: string | undefined): void {
    message.hidden = text === undefined;
    message.textContent = text ?? "";
  }

  function updateBanner(): void {
    const text = bannerText(lastResponse, status);
    banner.hidden = text === undefined;
    banner.textContent = text ?? "";
  }

  function select(i: number, focus = true): void {
    items[selected]?.node.classList.remove("selected");
    selected = i;
    const it = items[i];
    if (!it) return;
    it.node.classList.add("selected");
    if (focus) it.node.focus();
  }

  function open(r: SearchResult): void {
    host.postMessage({ type: "open", path: r.path, range: r.range });
  }

  function render(resp: SearchResponse): void {
    list.textContent = "";
    items = [];
    selected = -1;
    for (const g of groupByFile(resp.results)) {
      const group = el("div", "group");
      group.append(el("div", "file", g.path));
      for (const r of g.results) {
        const node = el("div", "result");
        node.tabIndex = 0;
        node.setAttribute("role", "option");
        const head = el("div", "result-head");
        head.append(sourceBadge(r));
        if (r.symbol) head.append(el("span", "symbol", r.symbol));
        head.append(el("span", "lines", `${r.range.startLine}–${r.range.endLine}`));
        node.append(head, renderSnippet(r));
        const idx = items.length;
        node.addEventListener("click", () => {
          select(idx, false);
          open(r);
        });
        items.push({ result: r, node });
        group.append(node);
      }
      list.append(group);
    }
    if (resp.results.length === 0) showMessage("Ничего не найдено");
    else showMessage(undefined);
  }

  function search(): void {
    const query = input.value.trim();
    cancelPending();
    requestId++;
    title = undefined;
    heading.hidden = true;
    if (!query) {
      list.textContent = "";
      items = [];
      selected = -1;
      lastResponse = undefined;
      showMessage(undefined);
      updateBanner();
      return;
    }
    pendingId = requestId;
    host.postMessage({
      type: "search",
      requestId,
      query,
      mode,
      include: splitGlobs(include.value),
      exclude: splitGlobs(exclude.value),
      lang: lang.value.trim() || undefined,
    });
  }

  const debounce = createDebouncer(DEBOUNCE_MS, search);

  input.addEventListener("input", () => debounce.schedule());
  for (const f of [include, exclude, lang]) {
    f.addEventListener("keydown", (e) => {
      if (e.key === "Enter") debounce.flush();
    });
    f.addEventListener("input", () => debounce.schedule());
  }
  modeSelect.addEventListener("change", () => {
    mode = modeSelect.value as SearchMode;
    debounce.flush();
  });

  root.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (items.length === 0) return;
      e.preventDefault();
      if (e.key === "ArrowUp" && selected === 0) {
        items[0]?.node.classList.remove("selected");
        selected = -1;
        input.focus();
        return;
      }
      select(moveSelection(selected, e.key === "ArrowDown" ? 1 : -1, items.length));
    } else if (e.key === "Enter") {
      const target = e.target as HTMLElement;
      if (target === input) {
        debounce.flush();
      } else if (target.classList.contains("result") && items[selected]) {
        e.preventDefault();
        open(items[selected]!.result);
      }
    }
  });

  return {
    handle(msg) {
      switch (msg.type) {
        case "config":
          mode = msg.defaultMode;
          modeSelect.value = mode;
          break;
        case "status":
          status = msg.status;
          updateBanner();
          break;
        case "focusInput":
          if (msg.query !== undefined) {
            input.value = msg.query;
            debounce.flush();
          }
          input.focus();
          input.select();
          break;
        case "results":
          if (msg.title === undefined && msg.requestId !== requestId) return;
          if (msg.title !== undefined) {
            debounce.cancel();
            cancelPending();
            requestId++;
            title = msg.title;
            heading.textContent = title;
            heading.hidden = false;
          } else {
            pendingId = undefined;
            heading.hidden = true;
          }
          lastResponse = msg.response;
          render(msg.response);
          updateBanner();
          break;
        case "error":
          if (msg.requestId !== undefined && msg.requestId !== requestId) return;
          pendingId = undefined;
          showMessage(msg.message);
          break;
      }
    },
  };
}
