import type { EngineApi, EngineSettings } from "@code-embed/protocol";
import type { EffectiveSettings } from "../config/types";

export interface LocalEngineOptions {
  root: string;
  clientName: string;
  settings?: EngineSettings;
  cli?: Partial<EffectiveSettings>;
  readonly?: boolean;
  watch?: boolean;
  vectorPhase?: boolean;
  apiKeys?: Record<string, string>;
}

export interface LocalEngine extends EngineApi {
  readonly root: string;
  quickUpdate(budgetMs: number): Promise<{ complete: boolean }>;
  ensureLexical(): Promise<void>;
  indexAll(opts: { full?: boolean; signal?: AbortSignal }): Promise<void>;
  exportVectors(outFile: string): Promise<{ count: number }>;
  importVectors(file: string): Promise<{ count: number }>;
  close(): Promise<void>;
}
