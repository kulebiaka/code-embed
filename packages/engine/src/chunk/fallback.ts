import type { Chunk } from "./types";

export function chunkWindows(_content: string, _opts?: { size: number; overlap: number }): Chunk[] {
  throw new Error("not implemented: chunk/fallback.chunkWindows");
}
