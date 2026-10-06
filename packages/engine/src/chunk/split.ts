import type { ChunkOptions } from "./types";

export interface TextRange {
  start: number;
  end: number;
}

export function splitText(text: string, opts: ChunkOptions): TextRange[] {
  const { maxTokens: max, countTokens } = opts;
  const starts: number[] = [0];
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) {
    if (i + 1 < text.length) starts.push(i + 1);
  }
  const n = starts.length;
  const lineEnd = (i: number): number => (i + 1 < n ? starts[i + 1]! : text.length);
  const st = (i: number): number => starts[i]!;
  const per: number[] = starts.map((s, i) => countTokens(text.slice(s, lineEnd(i))));
  const pr = (i: number): number => per[i]!;
  const overlap = Math.floor(max * opts.overlapRatio);
  const out: TextRange[] = [];

  let i = 0;
  while (i < n) {
    if (pr(i) > max) {
      out.push(...cutLine(text, st(i), lineEnd(i), opts));
      i++;
      continue;
    }
    let j = i;
    let sum = 0;
    while (j < n && (j === i || sum + pr(j) <= max)) {
      sum += pr(j);
      j++;
    }
    while (j > i + 1 && countTokens(text.slice(st(i), lineEnd(j - 1))) > max) j--;
    out.push({ start: st(i), end: lineEnd(j - 1) });
    if (j >= n) break;
    let k = j;
    if (pr(j) <= max) {
      let acc = 0;
      while (k > i + 1 && acc + pr(k - 1) <= overlap && acc + pr(k - 1) + pr(j) <= max) {
        acc += pr(k - 1);
        k--;
      }
    }
    i = k;
  }
  return out;
}

function cutLine(text: string, start: number, end: number, opts: ChunkOptions): TextRange[] {
  const out: TextRange[] = [];
  let pos = start;
  while (pos < end) {
    let lo = 1;
    let hi = end - pos;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (opts.countTokens(text.slice(pos, pos + mid)) <= opts.maxTokens) lo = mid;
      else hi = mid - 1;
    }
    let len = lo;
    const last = text.charCodeAt(pos + len - 1);
    if (len > 1 && pos + len < end && last >= 0xd800 && last <= 0xdbff) len--;
    out.push({ start: pos, end: pos + len });
    pos += len;
  }
  return out;
}
