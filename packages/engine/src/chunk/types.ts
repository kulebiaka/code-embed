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

export type RefKind = "call" | "type" | "import";

export interface Ref {
  name: string; // identifier as written; for imports: the imported binding name
  kind: RefKind;
  line: number; // 1-based, same convention as Chunk.startLine
  byte: number; // start byte of the captured identifier in the file
  module?: string; // imports only: TS/JS specifier without quotes ("./x", "pkg"); Python dotted path with leading dots (".x", "pkg.mod")
}

export interface ChunkResult {
  chunks: Chunk[];
  refs: Ref[];
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
