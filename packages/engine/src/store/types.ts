export interface FileRecord {
  id: number;
  path: string;
  lang: string | null;
  size: number;
  mtime: number;
  contentHash: string;
  indexedAt: number;
}

export type FileInput = Omit<FileRecord, "id" | "indexedAt">;

export interface ChunkInput {
  startLine: number;
  endLine: number;
  startByte: number;
  endByte: number;
  kind: string;
  symbol: string | null;
  parentSymbol: string | null;
  chunkHash: string;
  text: string;
  // Already pre-tokenized with lex/tokenizeForFts.
  fts: { text: string; symbol: string; path: string };
}

export interface ChunkRecord extends Omit<ChunkInput, "fts"> {
  id: number;
  fileId: number;
  path: string;
  lang: string | null;
  embedded: boolean;
}

// Higher is better; column weights are already applied.
export interface FtsHit {
  chunkId: number;
  score: number;
}

// Lower is better.
export interface VecHit {
  chunkId: number;
  distance: number;
}

export interface StoreFilter {
  lang?: string;
  pathPrefix?: string;
}

export interface IndexStore {
  readonly readonly: boolean;
  readonly dims: number | null;
  transaction<T>(fn: () => T): T;
  getFile(path: string): FileRecord | undefined;
  listFiles(): FileRecord[];
  upsertFile(file: FileInput, chunks: ChunkInput[]): { fileId: number; chunkIds: number[] };
  deleteFile(path: string): void;
  getChunks(ids: number[]): ChunkRecord[];
  chunksForFile(path: string): ChunkRecord[];
  pendingChunks(limit: number, paths?: string[]): ChunkRecord[];
  setVectorDims(dims: number): void;
  setEmbeddings(items: { chunkId: number; vector: Int8Array }[]): void;
  searchFts(match: string, limit: number, filter?: StoreFilter): FtsHit[];
  searchVec(query: Int8Array, k: number, filter?: StoreFilter): VecHit[];
  getVectors(chunkIds: number[]): Map<number, Int8Array>;
  counts(): { files: number; chunks: number; embedded: number };
  getMeta(key: string): string | undefined;
  setMeta(key: string, value: string): void;
  checkpoint(): void;
  close(): void;
}
