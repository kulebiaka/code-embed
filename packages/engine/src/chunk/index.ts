import type { Chunk, ChunkOptions } from "./types";

export function initChunker(): Promise<void> {
  throw new Error("not implemented: chunk/index.initChunker");
}

export function chunkFile(_path: string, _lang: string | null, _content: string, _opts?: ChunkOptions): Promise<Chunk[]> {
  throw new Error("not implemented: chunk/index.chunkFile");
}

export function hasGrammar(_lang: string | null): boolean {
  throw new Error("not implemented: chunk/index.hasGrammar");
}
