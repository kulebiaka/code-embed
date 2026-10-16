// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IndexStatus, SearchResponse, SearchResult } from "@code-embed/protocol/rpc";
import type { SimilarSource, WebviewToHost } from "../src/panel/messages";
import { createApp, type App } from "./app";
import { addRecent, groupByFile, indexBanner, snippetWindow, sourceLabel, splitGlobs } from "./logic";

function result(path: string, startLine: number, over: Partial<SearchResult> = {}): SearchResult {
  return {
    path,
    lang: "typescript",
    range: { startLine, endLine: startLine + 1, startByte: 0, endByte: 10 },
    symbol: `fn${startLine}`,
    kind: "function",
    score: 1,
    sources: ["lexical", "semantic"],
    snippet: { text: "const foo = 1;\nreturn foo;", startLine, highlights: [{ line: 0, start: 6, end: 9 }] },
    ...over,
  };
}

const source: SimilarSource = {
  path: "src/api/client.ts",
  range: { startLine: 40, endLine: 72 },
  symbol: "retryRequest",
  lang: "typescript",
  lines: ["export async function retryRequest(req: Request, max = 3) {", "  for (let i = 0; i <= max; i++) {"],
  hideSameFile: true,
};

function resp(results: SearchResult[], partial = false): SearchResponse {
  return { results, partial, tookMs: 1 };
}

function status(over: Partial<IndexStatus> = {}): IndexStatus {
  return {
    root: "/r",
    indexDir: "/r/.code-embed",
    files: 1,
    chunks: 100,
    embedded: 100,
    phase: "idle",
    model: "m",
    provider: "local",
    remote: false,
    lexicalOnly: false,
    readOnly: false,
    daemon: false,
    ...over,
  };
}

describe("logic", () => {
  it("groups results by file in first-seen order", () => {
    const g = groupByFile([result("a.ts", 1), result("b.ts", 1), result("a.ts", 9)]);
    expect(g.map((x) => [x.path, x.results.length])).toEqual([
      ["a.ts", 2],
      ["b.ts", 1],
    ]);
  });

  it("computes the banner", () => {
    expect(indexBanner(resp([]), status())).toBeUndefined();
    expect(indexBanner(resp([]), status({ embedded: 37, phase: "vector" }))).toEqual({
      kind: "indexing",
      title: "Building meaning index",
      detail: "Keyword matches are complete. Meaning matches cover 37 of 100 chunks so far.",
      percent: 37,
    });
    expect(indexBanner(resp([]), status({ embedded: 37, phase: "paused" }))).toMatchObject({ kind: "paused", title: "Meaning index paused" });
    expect(indexBanner(resp([]), status({ embedded: 37, phase: "queued" }))).toMatchObject({ kind: "indexing", title: "Meaning index waits for another project" });
    expect(indexBanner(resp([], true), status({ embedded: 100 }))?.title).toContain("keyword matches only");
    expect(indexBanner(resp([], true), undefined)?.kind).toBe("partial");
    expect(indexBanner(resp([]), status({ embedded: 0, lexicalOnly: true }))).toBeUndefined();
  });

  it("labels match sources and keeps recent queries unique and short", () => {
    expect(sourceLabel(["lexical", "semantic"])).toBe("meaning + keywords");
    expect(sourceLabel(["semantic"])).toBe("meaning");
    expect(sourceLabel(["lexical"])).toBe("keywords");
    let list = addRecent([], { query: "a", mode: "hybrid" });
    list = addRecent(list, { query: "b", mode: "lexical" });
    list = addRecent(list, { query: "a", mode: "semantic" });
    expect(list).toEqual([
      { query: "a", mode: "semantic" },
      { query: "b", mode: "lexical" },
    ]);
    for (let i = 0; i < 10; i++) list = addRecent(list, { query: `q${i}`, mode: "hybrid" });
    expect(list).toHaveLength(5);
  });

  it("splits globs", () => {
    expect(splitGlobs(" src/**, *.ts ,,")).toEqual(["src/**", "*.ts"]);
  });

  it("keeps the first match inside the snippet window", () => {
    expect(snippetWindow(4, 3, 6)).toEqual({ from: 0, to: 4 });
    expect(snippetWindow(20, undefined, 6)).toEqual({ from: 0, to: 6 });
    expect(snippetWindow(20, 2, 6)).toEqual({ from: 1, to: 7 });
    expect(snippetWindow(20, 12, 6)).toEqual({ from: 11, to: 17 });
    expect(snippetWindow(20, 19, 6)).toEqual({ from: 14, to: 20 });
  });
});

describe("app", () => {
  let sent: WebviewToHost[];
  let app: App;
  let root: HTMLElement;
  const input = () => root.querySelector<HTMLInputElement>("input.query")!;
  const type = (v: string) => {
    input().value = v;
    input().dispatchEvent(new Event("input"));
  };
  const searches = () => sent.filter((m): m is Extract<WebviewToHost, { type: "search" }> => m.type === "search");

  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = '<div id="app"></div>';
    root = document.getElementById("app")!;
    sent = [];
    app = createApp(root, { postMessage: (m) => sent.push(m) });
  });
  afterEach(() => vi.useRealTimers());

  it("debounces typing by 250ms and searches immediately on Enter", () => {
    type("fo");
    vi.advanceTimersByTime(200);
    type("foo");
    vi.advanceTimersByTime(200);
    expect(searches()).toHaveLength(0);
    vi.advanceTimersByTime(60);
    expect(searches()).toHaveLength(1);
    expect(searches()[0]?.query).toBe("foo");

    type("foobar");
    input().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(searches()).toHaveLength(2);
    vi.advanceTimersByTime(500);
    expect(searches()).toHaveLength(2);
  });

  it("uses default mode from config, filters and cancels the previous request", () => {
    app.handle({ type: "config", defaultMode: "lexical", top: 20 });
    root.querySelector<HTMLInputElement>(".include")!.value = "src/**, lib/**";
    root.querySelector<HTMLInputElement>(".lang")!.value = "ts";
    type("a");
    vi.advanceTimersByTime(250);
    type("ab");
    vi.advanceTimersByTime(250);
    const [first, second] = searches();
    expect(first).toMatchObject({ mode: "lexical", include: ["src/**", "lib/**"], exclude: [], lang: "ts" });
    expect(sent).toContainEqual({ type: "cancel", requestId: first!.requestId });
    expect(second!.requestId).toBeGreaterThan(first!.requestId);
  });

  it("drops stale responses", () => {
    type("a");
    vi.advanceTimersByTime(250);
    type("ab");
    vi.advanceTimersByTime(250);
    const [first, second] = searches();
    app.handle({ type: "results", requestId: first!.requestId, query: "a", response: resp([result("old.ts", 1)]) });
    expect(root.textContent).not.toContain("old.ts");
    app.handle({ type: "results", requestId: second!.requestId, query: "ab", response: resp([result("new.ts", 1)]) });
    expect(root.textContent).toContain("new.ts");
  });

  it("renders groups, symbol, lines, source icon and match marks", () => {
    type("foo");
    vi.advanceTimersByTime(250);
    const id = searches()[0]!.requestId;
    app.handle({ type: "results", requestId: id, query: "foo", response: resp([result("a.ts", 3), result("a.ts", 10, { sources: ["semantic"] })]) });
    expect(root.querySelectorAll(".file")).toHaveLength(1);
    expect(root.querySelectorAll(".result")).toHaveLength(2);
    expect(root.querySelector(".symbol")?.textContent).toBe("fn3");
    expect(root.querySelector(".lines")?.textContent).toBe("3–4");
    expect(root.querySelector("mark.match")?.textContent).toBe("foo");
    expect(root.querySelector(".hljs-keyword")?.textContent).toBe("const");
    expect(root.querySelectorAll(".source-both")).toHaveLength(1);
    expect(root.querySelectorAll(".source-semantic")).toHaveLength(1);
  });

  it("navigates with arrows and opens with Enter or click", () => {
    type("foo");
    vi.advanceTimersByTime(250);
    app.handle({ type: "results", requestId: searches()[0]!.requestId, query: "foo", response: resp([result("a.ts", 3), result("b.ts", 7)]) });
    const key = (target: Element, k: string) => target.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));
    key(input(), "ArrowDown");
    key(document.activeElement ?? input(), "ArrowDown");
    const nodes = root.querySelectorAll(".result");
    expect(nodes[1]!.classList.contains("selected")).toBe(true);
    key(nodes[1]!, "Enter");
    expect(sent.at(-1)).toMatchObject({ type: "open", path: "b.ts", range: { startLine: 7 } });
    (nodes[0] as HTMLElement).click();
    expect(sent.at(-1)).toMatchObject({ type: "open", path: "a.ts" });
  });

  it("shows indexing progress with a pause button and the percentage on Semantic", () => {
    const banner = () => root.querySelector<HTMLElement>(".banner")!;
    const semantic = () => root.querySelector<HTMLElement>('.mode[data-mode="semantic"]')!;
    expect(banner().hidden).toBe(true);
    app.handle({ type: "status", status: status({ embedded: 50, phase: "vector" }) });
    expect(banner().hidden).toBe(false);
    expect(banner().querySelector(".banner-title")!.textContent).toBe("Building meaning index");
    expect(banner().querySelector(".banner-pct")!.textContent).toBe("50%");
    expect(semantic().textContent).toBe("Semantic50%");
    banner().querySelector<HTMLButtonElement>(".banner-pause")!.click();
    expect(sent.at(-1)).toEqual({ type: "command", command: "pause" });
    app.handle({ type: "status", status: status({ embedded: 50, phase: "paused" }) });
    banner().querySelector<HTMLButtonElement>(".banner-pause")!.click();
    expect(sent.at(-1)).toEqual({ type: "command", command: "resume" });
    app.handle({ type: "status", status: status() });
    expect(banner().hidden).toBe(true);
    expect(semantic().textContent).toBe("Semantic");
  });

  it("shows the similar-code source card and cancels in-flight search", () => {
    type("foo");
    vi.advanceTimersByTime(250);
    const id = searches()[0]!.requestId;
    app.handle({ type: "results", requestId: 0, query: "", response: resp([result("s.ts", 1, { score: 1 }), result("t.ts", 5, { score: 0.5 })]), similar: source });
    expect(sent).toContainEqual({ type: "cancel", requestId: id });
    const card = root.querySelector<HTMLElement>(".similar-card")!;
    expect(card.hidden).toBe(false);
    expect(card.querySelector(".similar-symbol")!.textContent).toBe("retryRequest");
    expect(card.querySelector(".similar-where")!.textContent).toBe("src/api/client.ts · 40–72");
    expect(card.querySelector(".more-lines")!.textContent).toBe("+31 more lines");
    expect([...root.querySelectorAll(".similarity")].map((e) => [e.textContent, e.classList.contains("weak")])).toEqual([
      ["100%", false],
      ["50%", true],
    ]);
    expect(root.querySelector(".source")).toBeNull();
    expect(root.querySelector(".summary")!.textContent).toBe("2 similar chunks in 2 files · 1 ms");
    const hide = card.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    expect(hide.checked).toBe(true);
    hide.checked = false;
    hide.dispatchEvent(new Event("change"));
    expect(sent.at(-1)).toEqual({ type: "similar", path: "src/api/client.ts", range: { startLine: 40, endLine: 72 }, symbol: "retryRequest", hideSameFile: false });
  });

  it("runs a query pushed by the host immediately", () => {
    app.handle({ type: "focusInput", query: "hello" });
    expect(searches()[0]?.query).toBe("hello");
  });

  it("switches mode with the toggle buttons and searches right away", () => {
    type("foo");
    const lexical = root.querySelector<HTMLButtonElement>('.mode[data-mode="lexical"]')!;
    lexical.click();
    expect(lexical.getAttribute("aria-pressed")).toBe("true");
    expect(root.querySelector('.mode[data-mode="hybrid"]')!.getAttribute("aria-pressed")).toBe("false");
    expect(searches().at(-1)).toMatchObject({ query: "foo", mode: "lexical" });
  });

  it("hides filters behind a toggle that shows when filters are active", () => {
    const filters = root.querySelector<HTMLElement>(".filters")!;
    const toggle = root.querySelector<HTMLButtonElement>(".filter-toggle")!;
    expect(filters.hidden).toBe(true);
    toggle.click();
    expect(filters.hidden).toBe(false);
    const include = root.querySelector<HTMLInputElement>(".include")!;
    include.value = "src/**";
    include.dispatchEvent(new Event("input"));
    toggle.click();
    expect(filters.hidden).toBe(true);
    expect(toggle.classList.contains("active")).toBe(true);
  });

  it("shows a busy bar, a summary and a hint when nothing is found", () => {
    type("foo");
    vi.advanceTimersByTime(250);
    expect(root.querySelector(".busy")!.classList.contains("active")).toBe(true);
    app.handle({ type: "results", requestId: searches()[0]!.requestId, query: "foo", response: resp([result("src/a.ts", 1), result("b.ts", 2)]) });
    expect(root.querySelector(".busy")!.classList.contains("active")).toBe(false);
    expect(root.querySelector(".summary")!.textContent).toBe("2 results in 2 files · 1 ms");
    expect(root.querySelector(".file-name")!.textContent).toBe("a.ts");
    expect(root.querySelector(".file-dir")!.textContent).toBe("src");
    root.querySelector<HTMLButtonElement>('.mode[data-mode="lexical"]')!.click();
    app.handle({ type: "results", requestId: searches().at(-1)!.requestId, query: "foo", response: resp([]) });
    expect(root.querySelector(".message")!.textContent).toContain("Try Hybrid or Semantic mode");
  });

  it("collapses a file group and skips it during keyboard navigation", () => {
    type("foo");
    vi.advanceTimersByTime(250);
    app.handle({ type: "results", requestId: searches()[0]!.requestId, query: "foo", response: resp([result("a.ts", 1), result("a.ts", 5), result("b.ts", 7)]) });
    root.querySelector<HTMLElement>(".file")!.click();
    expect(root.querySelector(".group")!.classList.contains("collapsed")).toBe(true);
    input().dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(root.querySelector(".result.selected .symbol")!.textContent).toBe("fn7");
  });

  it("shows welcome, engine and empty-index states before the first query", () => {
    const empty = () => root.querySelector<HTMLElement>(".empty")!;
    app.handle({ type: "engine", state: "ready" });
    app.handle({ type: "status", status: status() });
    expect(empty().querySelectorAll(".example")).toHaveLength(3);
    empty().querySelector<HTMLButtonElement>(".example")!.click();
    expect(searches().at(-1)?.query).toBe("where are http requests retried");
    expect(empty().hidden).toBe(true);

    app.handle({ type: "clear" });
    expect(input().value).toBe("");
    expect(empty().hidden).toBe(false);
    app.handle({ type: "status", status: status({ chunks: 0, embedded: 0 }) });
    empty().querySelector<HTMLButtonElement>(".btn")!.click();
    expect(sent.at(-1)).toEqual({ type: "command", command: "index" });
    app.handle({ type: "engine", state: "failed" });
    empty().querySelector<HTMLButtonElement>(".btn")!.click();
    expect(sent.at(-1)).toEqual({ type: "command", command: "showLog" });
  });

  it("shows the match of a long chunk and how many lines are hidden", () => {
    type("foo");
    vi.advanceTimersByTime(250);
    const text = Array.from({ length: 20 }, (_, i) => `line${i}`).join("\n");
    const r = result("a.ts", 100, { range: { startLine: 100, endLine: 119, startByte: 0, endByte: 1 }, snippet: { text, startLine: 100, highlights: [{ line: 12, start: 0, end: 4 }] } });
    app.handle({ type: "results", requestId: searches()[0]!.requestId, query: "foo", response: resp([r]) });
    expect(root.querySelector("mark.match")?.textContent).toBe("line");
    expect(root.querySelector(".line-no")?.textContent).toBe("111");
    expect(root.querySelector(".more-lines")?.textContent).toBe("+14 more lines");
  });

  it("loads more results with a larger page, keeping collapsed groups", () => {
    app.handle({ type: "config", defaultMode: "hybrid", top: 2 });
    type("foo");
    vi.advanceTimersByTime(250);
    expect(searches()[0]).toMatchObject({ top: 2 });
    const more = root.querySelector<HTMLButtonElement>(".show-more")!;
    app.handle({ type: "results", requestId: searches()[0]!.requestId, query: "foo", response: { ...resp([result("a.ts", 1), result("b.ts", 2)]), total: 5 } });
    expect(more.hidden).toBe(false);
    root.querySelector<HTMLElement>(".file")!.click();
    more.click();
    expect(searches().at(-1)).toMatchObject({ query: "foo", top: 4 });
    app.handle({ type: "results", requestId: searches().at(-1)!.requestId, query: "foo", response: { ...resp([result("a.ts", 1), result("b.ts", 2), result("c.ts", 3), result("d.ts", 4)]), total: 4 } });
    expect(more.hidden).toBe(true);
    expect(root.querySelector(".group")!.classList.contains("collapsed")).toBe(true);
    type("bar");
    vi.advanceTimersByTime(250);
    expect(searches().at(-1)).toMatchObject({ query: "bar", top: 2 });
  });

  it("offers per-result actions and keyboard shortcuts", () => {
    type("foo");
    vi.advanceTimersByTime(250);
    app.handle({ type: "results", requestId: searches()[0]!.requestId, query: "foo", response: resp([result("a.ts", 3), result("b.ts", 7)]) });
    const key = (target: Element, k: string, init: KeyboardEventInit = {}) => target.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, ...init }));
    const actions = root.querySelectorAll<HTMLButtonElement>(".result-actions .icon-btn");
    actions[0]!.click();
    expect(sent.at(-1)).toMatchObject({ type: "open", path: "a.ts", side: true });
    actions[1]!.click();
    expect(sent.at(-1)).toEqual({ type: "copy", text: "a.ts:3" });
    actions[2]!.click();
    expect(sent.at(-1)).toEqual({ type: "similar", path: "a.ts", range: { startLine: 3, endLine: 4 }, symbol: "fn3", hideSameFile: true });

    const nodes = root.querySelectorAll<HTMLElement>(".result");
    key(input(), "ArrowDown");
    key(nodes[0]!, "Enter", { ctrlKey: true });
    expect(sent.at(-1)).toMatchObject({ type: "open", path: "a.ts", side: true });
    key(nodes[0]!, "ArrowLeft");
    const file = root.querySelector<HTMLElement>(".file")!;
    expect(document.activeElement).toBe(file);
    key(file, "ArrowLeft");
    expect(root.querySelector(".group")!.classList.contains("collapsed")).toBe(true);
    key(file, "ArrowRight");
    expect(root.querySelector(".group")!.classList.contains("collapsed")).toBe(false);
    key(file, "ArrowDown");
    expect(nodes[0]!.classList.contains("selected")).toBe(true);
    key(nodes[0]!, "Escape");
    expect(document.activeElement).toBe(input());

    key(input(), "ArrowUp", { altKey: true });
    expect(searches().at(-1)).toMatchObject({ mode: "lexical" });
    expect(input().placeholder).toBe("Search identifiers");
    key(input(), "ArrowDown", { altKey: true });
    expect(searches().at(-1)).toMatchObject({ mode: "hybrid" });
    expect(root.querySelector(".result.selected")).toBeNull();
  });

  it("shows active filters as removable chips", () => {
    const include = root.querySelector<HTMLInputElement>(".include")!;
    const exclude = root.querySelector<HTMLInputElement>(".exclude")!;
    const chips = root.querySelector<HTMLElement>(".filter-chips")!;
    expect(chips.hidden).toBe(true);
    include.value = "src/**, lib/**";
    include.dispatchEvent(new Event("input"));
    exclude.value = "**/*.test.ts";
    exclude.dispatchEvent(new Event("input"));
    expect(chips.hidden).toBe(false);
    expect([...chips.querySelectorAll(".chip-label")].map((c) => c.textContent)).toEqual(["src/**", "lib/**", "not **/*.test.ts"]);
    type("foo");
    chips.querySelector<HTMLButtonElement>(".chip-remove")!.click();
    expect(include.value).toBe("lib/**");
    expect(searches().at(-1)).toMatchObject({ include: ["lib/**"], exclude: ["**/*.test.ts"] });
    chips.querySelector<HTMLButtonElement>(".add-filter")!.click();
    expect(root.querySelector<HTMLElement>(".filters")!.hidden).toBe(false);
    expect(chips.hidden).toBe(true);
  });

  it("closes the similar-results view and returns to the search", () => {
    app.handle({ type: "results", requestId: 0, query: "", response: resp([result("s.ts", 1)]), similar: source });
    root.querySelector<HTMLButtonElement>(".similar-close")!.click();
    expect(root.querySelector<HTMLElement>(".similar-card")!.hidden).toBe(true);
    expect(root.querySelectorAll(".result")).toHaveLength(0);
  });

  it("hides code, flattens the list and collapses all groups", () => {
    type("foo");
    vi.advanceTimersByTime(250);
    app.handle({ type: "results", requestId: searches()[0]!.requestId, query: "foo", response: resp([result("a.ts", 1, { score: 1 }), result("b.ts", 2, { score: 0.25 })]) });
    const list = root.querySelector<HTMLElement>(".results")!;
    expect([...root.querySelectorAll<HTMLElement>(".score > span")].map((s) => s.style.width)).toEqual(["100%", "25%"]);
    expect(root.querySelector(".source")!.textContent).toBe("meaning + keywords");
    root.querySelector<HTMLButtonElement>(".toggle-code")!.click();
    expect(list.classList.contains("no-code")).toBe(true);
    const collapse = root.querySelector<HTMLButtonElement>(".collapse-all")!;
    collapse.click();
    expect(root.querySelectorAll(".group.collapsed")).toHaveLength(2);
    expect(collapse.title).toBe("Expand all");
    collapse.click();
    expect(root.querySelectorAll(".group.collapsed")).toHaveLength(0);
    root.querySelector<HTMLElement>(".file")!.click();
    root.querySelector<HTMLButtonElement>(".toggle-view")!.click();
    expect(list.classList.contains("flat")).toBe(true);
    expect(collapse.hidden).toBe(true);
    input().dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(root.querySelector(".result.selected .symbol")!.textContent).toBe("fn1");
  });

  it("remembers queries with their mode and runs them again", () => {
    const state: { recent?: unknown } = {};
    document.body.innerHTML = '<div id="app"></div>';
    root = document.getElementById("app")!;
    app = createApp(root, { postMessage: (m) => sent.push(m), getState: () => state, setState: (s) => Object.assign(state, s) });
    app.handle({ type: "engine", state: "ready" });
    app.handle({ type: "status", status: status() });
    root.querySelector<HTMLButtonElement>('.mode[data-mode="lexical"]')!.click();
    type("parseConfig");
    input().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(state.recent).toEqual([{ query: "parseConfig", mode: "lexical" }]);
    app.handle({ type: "clear" });
    root.querySelector<HTMLButtonElement>('.mode[data-mode="hybrid"]')!.click();
    const row = root.querySelector<HTMLButtonElement>(".recent")!;
    expect(row.querySelector(".recent-query")!.textContent).toBe("parseConfig");
    row.click();
    expect(searches().at(-1)).toMatchObject({ query: "parseConfig", mode: "lexical" });
    app.handle({ type: "clear" });
    root.querySelector<HTMLButtonElement>(".recent-remove")!.click();
    expect(state.recent).toEqual([]);
    expect(root.querySelector(".recent")).toBeNull();
    expect(root.querySelector(".index-state")!.textContent).toBe("Index ready");
    expect(root.querySelector(".index-model")!.textContent).toBe("m · on this machine");
    expect(root.querySelectorAll(".keys kbd")).toHaveLength(4);
  });
});
