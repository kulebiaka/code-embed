import type { IndexStatus, ModelListItem, ProviderConfig, ProviderTestResult } from "@code-embed/protocol/rpc";
import type { ClientState } from "../engine/types";

export const SETTING_KEYS = [
  "embedding.provider",
  "model.id",
  "model.offlineArchive",
  "index.location",
  "index.maxFileKb",
  "index.threads",
  "index.pauseOnBattery",
  "search.defaultMode",
  "search.top",
] as const;
export type SettingKey = (typeof SETTING_KEYS)[number];

export type Scope = "user" | "workspace";

export interface SettingInfo {
  value: unknown;
  defaultValue: unknown;
  user?: unknown;
  workspace?: unknown;
}

export interface ProviderRow {
  name: string;
  model: string;
  baseUrl?: string;
  remote: boolean;
  host?: string;
  source: "builtin" | "user" | "editor";
  // Present only for providers defined in VS Code settings, which the page can edit.
  config?: ProviderConfig;
  hasKey: boolean;
}

export interface SettingsState {
  scope: Scope;
  hasWorkspace: boolean;
  settings: Record<SettingKey, SettingInfo>;
  providers: ProviderRow[];
  models: ModelListItem[] | null;
}

export type SettingsAction = "reindex" | "rebuild" | "pause" | "resume" | "showLog" | "installCli" | "copyMcpConfig" | "openJson";

export type SettingsToHost =
  | { type: "ready" }
  | { type: "setScope"; scope: Scope }
  | { type: "update"; key: SettingKey; value: unknown }
  | { type: "saveProvider"; previousName?: string; name: string; config: ProviderConfig; apiKey?: string }
  | { type: "deleteProvider"; name: string }
  | { type: "useProvider"; name: string }
  | { type: "testProvider"; name: string }
  | { type: "setApiKey"; name: string; key: string | null }
  | { type: "browseArchive" }
  | { type: "action"; action: SettingsAction };

export type HostToSettings =
  | { type: "state"; state: SettingsState }
  | { type: "engine"; engine: ClientState; status?: IndexStatus }
  | { type: "testResult"; name: string; result?: ProviderTestResult; error?: string }
  | { type: "error"; message: string };
