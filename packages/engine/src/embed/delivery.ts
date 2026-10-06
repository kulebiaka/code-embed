import type { ModelEntry } from "./types";

export interface EnsureModelOptions {
  modelsDir: string;
  offlineArchive?: string;
  proxy?: string;
  onProgress?: (done: number, total: number) => void;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

export function ensureModel(_entry: ModelEntry, _opts: EnsureModelOptions): Promise<string> {
  throw new Error("not implemented: embed/delivery.ensureModel");
}

export function installFromArchive(_file: string, _modelsDir: string): Promise<string[]> {
  throw new Error("not implemented: embed/delivery.installFromArchive");
}

export function verifyModelDir(_dir: string, _entry: ModelEntry): Promise<boolean> {
  throw new Error("not implemented: embed/delivery.verifyModelDir");
}

export function isModelInstalled(_entry: ModelEntry, _modelsDir: string): boolean {
  throw new Error("not implemented: embed/delivery.isModelInstalled");
}
