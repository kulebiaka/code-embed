import { indexLines, lineRangeChunk, type LineIndex } from "./fallback";
import type { Chunk, ChunkOptions } from "./types";

const ATX = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const SETEXT = /^ {0,3}(=+|-+)[ \t]*$/;

interface Heading {
  line: number;
  level: number;
  text: string;
}

function frontMatterEnd(texts: string[]): number {
  if (texts[0]?.trimEnd() !== "---") return -1;
  for (let i = 1; i < texts.length; i++) {
    const t = texts[i]!.trimEnd();
    if (t === "---" || t === "...") return i;
  }
  return -1;
}

function findHeadings(texts: string[], from: number): Heading[] {
  const out: Heading[] = [];
  let fence: string | null = null;
  for (let i = from; i < texts.length; i++) {
    const t = texts[i]!.replace(/\r?\n$/, "");
    const f = FENCE.exec(t);
    if (fence) {
      if (f && f[1]![0] === fence[0] && f[1]!.length >= fence.length && t.trim() === f[1]) fence = null;
      continue;
    }
    if (f) {
      fence = f[1]!;
      continue;
    }
    const a = ATX.exec(t);
    if (a) {
      out.push({ line: i, level: a[1]!.length, text: (a[2] ?? "").replace(/[ \t]+#+$/, "").replace(/^#+$/, "").trim() });
      continue;
    }
    const s = i + 1 < texts.length ? SETEXT.exec(texts[i + 1]!.replace(/\r?\n$/, "")) : null;
    if (s && t.trim() !== "" && !/^\s*([-*+]|\d+[.)])\s/.test(t) && !/^ {4}/.test(t) && !/^\s*>/.test(t)) {
      out.push({ line: i, level: s[1]![0] === "=" ? 1 : 2, text: t.trim() });
      i++;
    }
  }
  return out;
}

function splitRange(
  content: string,
  lines: LineIndex[],
  from: number,
  to: number,
  symbol: string | null,
  parent: string | null,
  opts: ChunkOptions,
): Chunk[] {
  const tokens = (a: number, b: number) => opts.countTokens(content.slice(lines[a]!.start, lines[b]!.end));
  if (tokens(from, to) <= opts.maxTokens) return [lineRangeChunk(content, lines, from, to, "section", symbol, parent)];
  const out: Chunk[] = [];
  const overlapTokens = opts.maxTokens * opts.overlapRatio;
  let s = from;
  for (;;) {
    let e = s;
    while (e < to && tokens(s, e + 1) <= opts.maxTokens) e++;
    out.push(lineRangeChunk(content, lines, s, e, "section", symbol, parent));
    if (e >= to) break;
    let next = e + 1;
    while (next - 1 > s && tokens(next - 1, e) <= overlapTokens) next--;
    s = Math.max(next, s + 1);
  }
  return out;
}

export function chunkMarkdown(content: string, opts: ChunkOptions): Chunk[] {
  const lines = indexLines(content);
  if (lines.length === 0) return [];
  const texts = lines.map((l) => content.slice(l.start, l.end));
  const fmEnd = frontMatterEnd(texts);
  const headings = findHeadings(texts, fmEnd + 1);
  const isBlank = (i: number) => texts[i]!.trim() === "";

  const bounds: { from: number; to: number; symbol: string | null; parent: string | null }[] = [];
  const stack: Heading[] = [];
  const firstHeading = headings[0]?.line ?? lines.length;
  bounds.push({ from: 0, to: firstHeading - 1, symbol: null, parent: null });
  headings.forEach((h, idx) => {
    while (stack.length > 0 && stack[stack.length - 1]!.level >= h.level) stack.pop();
    const parent = stack[stack.length - 1]?.text || null;
    stack.push(h);
    bounds.push({ from: h.line, to: (headings[idx + 1]?.line ?? lines.length) - 1, symbol: h.text || null, parent });
  });

  const out: Chunk[] = [];
  for (const b of bounds) {
    let to = b.to;
    while (to >= b.from && isBlank(to)) to--;
    if (to < b.from) continue;
    out.push(...splitRange(content, lines, b.from, to, b.symbol, b.parent, opts));
  }
  return out;
}
