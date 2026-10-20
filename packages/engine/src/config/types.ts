import type { ProviderConfig, SearchMode } from "@code-embed/protocol";
import type { IndexLocation } from "../core/location";

export interface ProjectConfig {
  exclude?: string[];
  embedding?: { provider?: string; model?: string };
  index?: { location?: "project" | "cache"; max_file_kb?: number };
  search?: { default_mode?: SearchMode; top?: number };
}

export interface UserConfig extends ProjectConfig {
  index?: ProjectConfig["index"] & { threads?: number; pause_on_battery?: boolean };
}

export interface EffectiveSettings {
  indexLocation: IndexLocation;
  maxFileKb: number;
  threads: number;
  threadsExplicit: boolean;
  pauseOnBattery: boolean;
  exclude: string[];
  searchMode: SearchMode;
  searchTop: number;
  provider: string;
  model: string;
  offlineArchive?: string;
  providers: Record<string, ProviderConfig>;
  allowRemote: boolean;
  proxy?: string;
}

export const DEFAULTS = {
  maxFileKb: 512,
  searchTop: 20,
  similarTop: 10,
  model: "qwen3-embedding-0.6b",
  provider: "local",
} as const;
