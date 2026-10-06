import type { Chunk, ChunkOptions } from "./types";

export function chunkWithTreeSitter(_lang: string, _content: string, _opts: ChunkOptions): Promise<Chunk[]> {
  throw new Error("not implemented: chunk/treesitter.chunkWithTreeSitter");
}
