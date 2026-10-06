// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IndexStatus, SearchResponse, SearchResult } from "@code-embed/protocol/rpc";
import type { WebviewToHost } from "../src/panel/messages";
import { createApp, type App } from "./app";
import { bannerText, groupByFile, moveSelection, splitGlobs } from "./logic";

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
    expect(bannerText(resp([]), status({ embedded: 37 }))).toBe("Идёт индексация, 37% векторов — результаты неполные");
    expect(bannerText(resp([], true), status({ embedded: 100 }))).toContain("100%");
    expect(bannerText(resp([], true), undefined)).toContain("0%");
    expect(bannerText(resp([]), status({ embedded: 0, lexicalOnly: true }))).toBeUndefined();
  });

  it("splits globs and moves selection within bounds", () => {
    expect(splitGlobs(" src/**, *.ts ,,")).toEqual(["src/**", "*.ts"]);
    expect(moveSelection(-1, 1, 3)).toBe(0);
    expect(moveSelection(-1, -1, 3)).toBe(2);
    expect(moveSelection(2, 1, 3)).toBe(2);
    expect(moveSelection(0, -1, 3)).toBe(0);
    expect(moveSelection(0, 1, 0)).toBe(-1);
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
    expect(banner().textContent).toBe("Идёт индексация, 50% векторов — результаты неполные");
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
});
