import { availableParallelism } from "node:os";
import type { EngineSettings, ProviderConfig } from "@code-embed/protocol";
import { loadProviders } from "./user";
import { DEFAULTS, type EffectiveSettings, type ProjectConfig, type UserConfig } from "./types";

export interface SettingsSources {
  cli?: Partial<EffectiveSettings>;
  project: ProjectConfig;
  editor?: EngineSettings;
  user: UserConfig;
}

function pick<T>(...vals: (T | undefined)[]): T | undefined {
  return vals.find((v) => v !== undefined);
}

export function resolveSettings(src: SettingsSources): EffectiveSettings {
  const { cli = {}, project, editor = {}, user } = src;
  const settings: EffectiveSettings = {
    indexLocation:
      pick(cli.indexLocation, project.index?.location, editor.index?.location, user.index?.location) ?? "auto",
    maxFileKb:
      pick(cli.maxFileKb, project.index?.max_file_kb, editor.index?.maxFileKb, user.index?.max_file_kb) ??
      DEFAULTS.maxFileKb,
    threads:
      pick(cli.threads, editor.index?.threads, user.index?.threads) ??
      Math.max(1, Math.floor(availableParallelism() / 2)),
    pauseOnBattery:
      pick(cli.pauseOnBattery, editor.index?.pauseOnBattery, user.index?.pause_on_battery) ?? false,
    exclude: pick(cli.exclude, project.exclude, editor.index?.exclude, user.exclude) ?? [],
    searchMode:
      pick(cli.searchMode, project.search?.default_mode, editor.search?.defaultMode, user.search?.default_mode) ??
      "hybrid",
    searchTop:
      pick(cli.searchTop, project.search?.top, editor.search?.top, user.search?.top) ?? DEFAULTS.searchTop,
    provider:
      pick(cli.provider, project.embedding?.provider, editor.embedding?.provider, user.embedding?.provider) ??
      DEFAULTS.provider,
    model: pick(cli.model, project.embedding?.model, editor.model?.id, user.embedding?.model) ?? DEFAULTS.model,
    providers: { ...loadProviders(), ...cli.providers, ...editor.providers } as Record<string, ProviderConfig>,
    allowRemote: pick(cli.allowRemote, editor.allowRemote) ?? false,
  };
  const offlineArchive = pick(cli.offlineArchive, editor.model?.offlineArchive);
  if (offlineArchive !== undefined) settings.offlineArchive = offlineArchive;
  const proxy = pick(cli.proxy, editor.proxy);
  if (proxy !== undefined) settings.proxy = proxy;
  return settings;
}
