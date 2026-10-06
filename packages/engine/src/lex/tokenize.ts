import { splitIdentifier } from "./split";

export const TOKEN_RE = /[\p{L}\p{M}\p{N}_$]+/gu;

export function tokenizeForFts(text: string): string {
  const out: string[] = [];
  for (const m of text.matchAll(TOKEN_RE)) {
    const token = m[0];
    out.push(token);
    const parts = splitIdentifier(token);
    if (parts.length > 1) out.push(...parts);
  }
  return out.join(" ");
}

export function queryTerms(query: string): string[] {
  const terms = new Set<string>();
  for (const m of query.matchAll(TOKEN_RE)) {
    const token = m[0];
    if (/^[_$]+$/.test(token)) continue;
    terms.add(token.toLowerCase());
    for (const part of splitIdentifier(token)) terms.add(part);
  }
  return [...terms];
}
