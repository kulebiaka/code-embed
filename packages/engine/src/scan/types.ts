export interface ScannedFile {
  path: string;
  absPath: string;
  size: number;
  mtimeMs: number;
  lang: string | null;
}

export interface ScanOptions {
  exclude: string[];
  maxFileKb: number;
  signal?: AbortSignal;
}

export type SkipReason = "binary" | "minified" | "too-large" | "lockfile" | "generated";
