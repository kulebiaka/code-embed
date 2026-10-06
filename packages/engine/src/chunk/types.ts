export const CHUNKER_VERSION = "1";

export interface Chunk {
  startLine: number;
  endLine: number;
  startByte: number;
  endByte: number;
  kind: string;
  symbol: string | null;
  parentSymbol: string | null;
  signature: string | null;
  text: string;
}

export interface ChunkOptions {
  maxTokens: number;
  overlapRatio: number;
  countTokens: (s: string) => number;
}

export const DEFAULT_CHUNK_OPTIONS: ChunkOptions = {
  maxTokens: 400,
  overlapRatio: 0.15,
  countTokens: (s) => Math.ceil(s.length / 4),
};
