import { queryTerms } from "./tokenize";

export function buildFtsMatch(query: string): string | null {
  const terms = queryTerms(query);
  if (terms.length === 0) return null;
  return terms.map((t) => `"${t.replace(/"/g, '""')}"`).join(" OR ");
}
