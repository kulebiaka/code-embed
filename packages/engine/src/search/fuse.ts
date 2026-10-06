import type { ResultSource } from "@code-embed/protocol";

export function rrfFuse(
  _lists: { ids: number[]; weight: number; source: ResultSource }[],
  _k?: number,
): { id: number; score: number; sources: ResultSource[] }[] {
  throw new Error("not implemented: search/fuse.rrfFuse");
}
