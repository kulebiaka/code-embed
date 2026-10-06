export const PROTOCOL_VERSION = 1;

export const ErrorCodes = {
  ProtocolMismatch: -32001,
  NoIndex: -32002,
  ConsentRequired: -32003,
  ProviderUnavailable: -32004,
  ReadOnly: -32005,
  RequestCancelled: -32800,
} as const;
export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

export type SearchMode = "hybrid" | "semantic" | "lexical";
export const SEARCH_MODES: readonly SearchMode[] = ["hybrid", "semantic", "lexical"];
export type ResultSource = "lexical" | "semantic";

// Lines are 1-based and inclusive.
export interface Range {
  startLine: number;
  endLine: number;
  startByte: number;
  endByte: number;
}
export interface LineRange {
  startLine: number;
  endLine: number;
}
// line is a 0-based line index within the snippet; start/end are UTF-16 offsets.
export interface HighlightSpan {
  line: number;
  start: number;
  end: number;
}
export interface Snippet {
  text: string;
  startLine: number;
  highlights: HighlightSpan[];
}

export interface SearchResult {
  path: string;
  lang: string | null;
  range: Range;
  symbol: string | null;
  kind: string;
  score: number;
  sources: ResultSource[];
  snippet: Snippet;
}

export interface SearchFilters {
  include?: string[];
  exclude?: string[];
  lang?: string;
  pathPrefix?: string;
}
export interface SearchParams extends SearchFilters {
  query: string;
  mode?: SearchMode;
  top?: number;
  threshold?: number;
}
export interface SearchResponse {
  results: SearchResult[];
  partial: boolean;
  partialReason?: string;
  tookMs: number;
  total?: number;
}

export type FindSimilarParams =
  | ({ path: string; range: LineRange; top?: number } & SearchFilters)
  | ({ code: string; lang?: string; top?: number } & SearchFilters);

export type IndexPhase = "idle" | "scanning" | "lexical" | "vector" | "model-download" | "paused" | "error";

export interface IndexStatus {
  root: string;
  indexDir: string;
  files: number;
  chunks: number;
  embedded: number;
  phase: IndexPhase;
  model: string | null;
  provider: string;
  remote: boolean;
  host?: string;
  lexicalOnly: boolean;
  consentRequired?: { host: string; provider: string };
  readOnly: boolean;
  daemon: boolean;
  lastError?: string;
}

export interface ProviderConfig {
  kind: "openai";
  base_url: string;
  model: string;
  query_prefix?: string;
  doc_prefix?: string;
  max_input_tokens?: number;
  batch_size?: number;
  concurrency?: number;
  dimensions?: number;
  api_key_env?: string;
  rpm?: number;
  tpm?: number;
}

export interface EngineSettings {
  index?: {
    location?: "auto" | "project" | "cache";
    maxFileKb?: number;
    threads?: number;
    pauseOnBattery?: boolean;
    exclude?: string[];
  };
  search?: { defaultMode?: SearchMode; top?: number };
  model?: { id?: string; offlineArchive?: string };
  embedding?: { provider?: string };
  providers?: Record<string, ProviderConfig>;
  proxy?: string;
  allowRemote?: boolean;
}

export interface InitializeParams {
  root: string;
  clientName: string;
  protocolVersion: number;
  settings?: EngineSettings;
  apiKeys?: Record<string, string>;
}
export interface InitializeResult {
  serverVersion: string;
  protocolVersion: number;
  capabilities: { search: true; findSimilar: true; watcher: boolean; readOnly: boolean };
  index: IndexStatus;
}
export interface RebuildParams {
  full?: boolean;
}
export interface ProviderTestParams {
  name: string;
}
export interface ProviderTestResult {
  dims: number;
  latencyMs: number;
}
export interface ProviderListItem {
  name: string;
  kind: string;
  model: string;
  baseUrl?: string;
  remote: boolean;
  host?: string;
  source: "builtin" | "user" | "editor";
}
export interface ModelListItem {
  id: string;
  dims: number;
  license: string;
  sizeMb: number;
  installed: boolean;
  isDefault: boolean;
}
export interface ConsentGrantParams {
  host: string;
}

// Absolute paths.
export interface FilesChangedParams {
  created: string[];
  changed: string[];
  deleted: string[];
}
export interface FilesOpenedParams {
  paths: string[];
}
export interface IndexProgress {
  phase: IndexPhase;
  done: number;
  total: number;
  embedded: number;
}
export interface IndexErrorParams {
  path?: string;
  message: string;
}
export interface LogParams {
  level: "debug" | "info" | "warn" | "error";
  message: string;
}

export const Methods = {
  initialize: "initialize",
  search: "search",
  findSimilar: "findSimilar",
  indexStatus: "index.status",
  indexRebuild: "index.rebuild",
  indexPause: "index.pause",
  indexResume: "index.resume",
  settingsUpdate: "settings.update",
  shutdown: "shutdown",
  providerTest: "provider.test",
  providerList: "provider.list",
  modelList: "model.list",
  consentGrant: "consent.grant",
} as const;
export type MethodName = (typeof Methods)[keyof typeof Methods];

export const Notifications = {
  filesChanged: "files.changed",
  filesOpened: "files.opened",
  indexProgress: "index.progress",
  indexError: "index.error",
  log: "log",
} as const;
export type NotificationName = (typeof Notifications)[keyof typeof Notifications];

export interface Disposable {
  dispose(): void;
}

export interface EngineApi {
  initialize(p: InitializeParams): Promise<InitializeResult>;
  search(p: SearchParams, signal?: AbortSignal): Promise<SearchResponse>;
  findSimilar(p: FindSimilarParams, signal?: AbortSignal): Promise<SearchResponse>;
  status(): Promise<IndexStatus>;
  rebuild(p?: RebuildParams): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  updateSettings(p: EngineSettings): Promise<void>;
  testProvider(p: ProviderTestParams): Promise<ProviderTestResult>;
  listProviders(): Promise<ProviderListItem[]>;
  listModels(): Promise<ModelListItem[]>;
  grantConsent(p: ConsentGrantParams): Promise<void>;
  shutdown(): Promise<void>;
  filesChanged(p: FilesChangedParams): void;
  filesOpened(p: FilesOpenedParams): void;
  onProgress(cb: (p: IndexProgress) => void): Disposable;
  onIndexError(cb: (p: IndexErrorParams) => void): Disposable;
  onLog(cb: (p: LogParams) => void): Disposable;
}

export class EngineRpcError extends Error {
  constructor(
    public readonly code: number,
    message: string,
    public readonly data?: unknown,
  ) {
    super(message);
    this.name = "EngineRpcError";
  }
}
