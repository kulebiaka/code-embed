import type { ResultSource } from "@code-embed/protocol";

export function rrfFuse(
  lists: { ids: number[]; weight: number; source: ResultSource }[],
  k = 60,
): { id: number; score: number; sources: ResultSource[] }[] {
  const acc = new Map<number, { id: number; score: number; sources: ResultSource[] }>();
  for (const list of lists) {
    list.ids.forEach((id, i) => {
      let e = acc.get(id);
      if (!e) {
        e = { id, score: 0, sources: [] };
        acc.set(id, e);
      }
      e.score += list.weight / (k + i + 1);
      if (!e.sources.includes(list.source)) e.sources.push(list.source);
    });
  }
  return [...acc.values()].sort((a, b) => b.score - a.score || a.id - b.id);
}
