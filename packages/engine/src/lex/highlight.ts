import type { HighlightSpan, Snippet } from "@code-embed/protocol";
import { splitWithOffsets } from "./split";
import { TOKEN_RE, queryTerms } from "./tokenize";

function lineHighlights(line: string, lineIndex: number, terms: Set<string>): HighlightSpan[] {
  const spans: HighlightSpan[] = [];
  for (const m of line.matchAll(TOKEN_RE)) {
    const token = m[0];
    const base = m.index;
    if (terms.has(token.toLowerCase())) {
      spans.push({ line: lineIndex, start: base, end: base + token.length });
      continue;
    }
    for (const p of splitWithOffsets(token)) {
      if (terms.has(p.text)) spans.push({ line: lineIndex, start: base + p.start, end: base + p.end });
    }
  }
  return spans;
}

export function buildSnippet(
  text: string,
  startLine: number,
  query: string | null,
  opts: { maxLines: number; contextLines?: number },
): Snippet {
  const lines = text.split("\n");
  const maxLines = Math.max(1, opts.maxLines);
  const terms = new Set(query ? queryTerms(query) : []);
  const perLine = terms.size ? lines.map((l, i) => lineHighlights(l, i, terms)) : [];

  let best = -1;
  let bestCount = 0;
  perLine.forEach((spans, i) => {
    if (spans.length > bestCount) {
      best = i;
      bestCount = spans.length;
    }
  });

  let from = 0;
  if (best >= 0) {
    const before = opts.contextLines ?? Math.floor((maxLines - 1) / 2);
    from = Math.min(Math.max(0, best - before), Math.max(0, lines.length - maxLines));
  }
  const to = Math.min(lines.length, from + maxLines);

  const highlights: HighlightSpan[] = [];
  for (let i = from; i < to; i++) {
    for (const s of perLine[i] ?? []) highlights.push({ ...s, line: i - from });
  }
  return { text: lines.slice(from, to).join("\n"), startLine: startLine + from, highlights };
}
