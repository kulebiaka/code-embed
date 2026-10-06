import type { Chunk } from "./types";

export function buildEmbeddingText(_chunk: Chunk, _ctx: { path: string; lang: string | null }): string {
  throw new Error("not implemented: chunk/header.buildEmbeddingText");
}
