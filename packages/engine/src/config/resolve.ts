import type { EngineSettings } from "@code-embed/protocol";
import type { EffectiveSettings, ProjectConfig, UserConfig } from "./types";

export interface SettingsSources {
  cli?: Partial<EffectiveSettings>;
  project: ProjectConfig;
  editor?: EngineSettings;
  user: UserConfig;
}

export function resolveSettings(_src: SettingsSources): EffectiveSettings {
  throw new Error("not implemented: config/resolve.resolveSettings");
}
