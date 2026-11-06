import type { OutlineParams, OutlineResponse, OutlineSymbol } from "@code-embed/protocol";
import type { IndexStore } from "../store/types";

export function outline(store: IndexStore, p: OutlineParams): OutlineResponse {
  const started = performance.now();
  const chunks = store.chunksForFile(p.path);
  const symbols: OutlineSymbol[] = [];
  const merged = new Map<string, OutlineSymbol>();
  for (const c of chunks) {
    const key = c.symbol === null ? null : JSON.stringify([c.symbol, c.parentSymbol]);
    const existing = key === null ? undefined : merged.get(key);
    if (existing) {
      existing.range.startLine = Math.min(existing.range.startLine, c.startLine);
      existing.range.endLine = Math.max(existing.range.endLine, c.endLine);
      continue;
    }
    const entry: OutlineSymbol = {
      symbol: c.symbol,
      parentSymbol: c.parentSymbol,
      kind: c.kind,
      signature: c.signature,
      range: { startLine: c.startLine, endLine: c.endLine },
    };
    if (key !== null) merged.set(key, entry);
    symbols.push(entry);
  }
  symbols.sort((a, b) => a.range.startLine - b.range.startLine);
  return { path: p.path, lang: chunks[0]?.lang ?? null, symbols, tookMs: Math.round(performance.now() - started) };
}
