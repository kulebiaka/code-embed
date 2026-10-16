export interface EmbedderInfo {
  provider: string;
  model: string;
  dims: number;
  modelId: string;
  remote: boolean;
  host?: string;
  maxInputTokens: number;
  batchSize: number;
}

export interface Embedder {
  // dims is valid only after init().
  readonly info: EmbedderInfo;
  init(signal?: AbortSignal): Promise<void>;
  // Returned vectors are L2-normalized.
  embedQueries(texts: string[], signal?: AbortSignal): Promise<Float32Array[]>;
  embedDocuments(texts: string[], signal?: AbortSignal): Promise<Float32Array[]>;
  countTokens(text: string): number;
  // Frees the model's memory; the next request loads it again.
  unload?(): Promise<void>;
  dispose(): Promise<void>;
}

export interface ModelFile {
  path: string;
  sha256: string;
  size: number;
}

export interface ModelEntry {
  id: string;
  hfRepo: string;
  revision: string;
  files: ModelFile[];
  dims: number;
  mrlDims?: number[];
  pooling: "mean" | "cls" | "last_token" | "static";
  queryPrefix?: string;
  docPrefix?: string;
  queryInstruction?: string;
  maxTokens: number;
  license: string;
  sizeMb: number;
  dtype: "q8" | "fp32" | "fp16";
}

export interface ModelManifest {
  version: number;
  mirror: { githubRepo: string; tag: string };
  models: ModelEntry[];
}
