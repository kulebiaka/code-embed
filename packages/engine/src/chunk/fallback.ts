import type { Chunk } from "./types";

export interface LineIndex {
  start: number;
  end: number;
  byteStart: number;
  byteEnd: number;
}

export function indexLines(content: string): LineIndex[] {
  const lines: LineIndex[] = [];
  let pos = 0;
  let bytes = 0;
  while (pos < content.length) {
    const nl = content.indexOf("\n", pos);
    const end = nl === -1 ? content.length : nl + 1;
    const len = Buffer.byteLength(content.slice(pos, end));
    lines.push({ start: pos, end, byteStart: bytes, byteEnd: bytes + len });
    bytes += len;
    pos = end;
  }
  return lines;
}

export function lineRangeChunk(
  content: string,
  lines: LineIndex[],
  from: number,
  to: number,
  kind: string,
  symbol: string | null,
  parentSymbol: string | null,
): Chunk {
  const first = lines[from]!;
  const last = lines[to]!;
  return {
    startLine: from + 1,
    endLine: to + 1,
    startByte: first.byteStart,
    endByte: last.byteEnd,
    kind,
    symbol,
    parentSymbol,
    signature: null,
    text: content.slice(first.start, last.end),
  };
}

export function chunkWindows(content: string, opts: { size: number; overlap: number } = { size: 50, overlap: 10 }): Chunk[] {
  const lines = indexLines(content);
  const step = Math.max(1, opts.size - opts.overlap);
  const out: Chunk[] = [];
  for (let s = 0; s < lines.length; s += step) {
    const e = Math.min(lines.length, s + opts.size) - 1;
    out.push(lineRangeChunk(content, lines, s, e, "window", null, null));
    if (e === lines.length - 1) break;
  }
  return out;
}
