export interface EmbCache {
  // Stored as float16, returned as float32.
  get(modelId: string, hashes: string[]): Map<string, Float32Array>;
  put(modelId: string, entries: { chunkHash: string; vector: Float32Array }[]): void;
  count(modelId?: string): number;
  gc(opts: { olderThanDays: number }): number;
  close(): void;
}
