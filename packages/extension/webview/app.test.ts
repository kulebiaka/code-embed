// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IndexStatus, SearchResponse, SearchResult } from "@code-embed/protocol/rpc";
import type { WebviewToHost } from "../src/panel/messages";
import { createApp, type App } from "./app";
import { bannerText, groupByFile, snippetWindow, splitGlobs } from "./logic";

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
    expect(bannerText(resp([]), status())).toBeUndefined();
    expect(bannerText(resp([]), status({ embedded: 37 }))).toBe("Indexing 37% · partial results");
    expect(bannerText(resp([], true), status({ embedded: 100 }))).toContain("keyword matches only");
    expect(bannerText(resp([], true), undefined)).toContain("keyword matches only");
    expect(bannerText(resp([]), status({ embedded: 0, lexicalOnly: true }))).toBeUndefined();
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

  it("shows banner from status and partial responses", () => {
    const banner = () => root.querySelector<HTMLElement>(".banner")!;
    expect(banner().hidden).toBe(true);
    app.handle({ type: "status", status: status({ embedded: 50 }) });
    expect(banner().hidden).toBe(false);
    expect(banner().textContent).toBe("Indexing 50% · partial results");
    app.handle({ type: "status", status: status() });
    expect(banner().hidden).toBe(true);
  });

  it("shows a titled similar-results view and cancels in-flight search", () => {
    type("foo");
    vi.advanceTimersByTime(250);
    const id = searches()[0]!.requestId;
    app.handle({ type: "results", requestId: 0, query: "", response: resp([result("s.ts", 1)]), title: "Similar to x" });
    expect(sent).toContainEqual({ type: "cancel", requestId: id });
    expect(root.querySelector<HTMLElement>(".title")!.textContent).toBe("Similar to x");
    expect(root.textContent).toContain("s.ts");
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
    expect(sent.at(-1)).toEqual({ type: "similar", path: "a.ts", range: { startLine: 3, endLine: 4 } });

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

  it("summarises hidden filters and clears them", () => {
    const include = root.querySelector<HTMLInputElement>(".include")!;
    const summaryEl = root.querySelector<HTMLElement>(".filter-summary")!;
    include.value = "src/**";
    include.dispatchEvent(new Event("input"));
    expect(summaryEl.hidden).toBe(false);
    expect(summaryEl.textContent).toBe("src/**");
    type("foo");
    summaryEl.querySelector<HTMLButtonElement>(".icon-btn")!.click();
    expect(include.value).toBe("");
    expect(summaryEl.hidden).toBe(true);
    expect(searches().at(-1)).toMatchObject({ include: [] });
  });

  it("closes the similar-results view and returns to the search", () => {
    app.handle({ type: "results", requestId: 0, query: "", response: resp([result("s.ts", 1)]), title: "Similar to x" });
    root.querySelector<HTMLButtonElement>(".title-bar .icon-btn")!.click();
    expect(root.querySelector<HTMLElement>(".title-bar")!.hidden).toBe(true);
    expect(root.querySelectorAll(".result")).toHaveLength(0);
  });
});
