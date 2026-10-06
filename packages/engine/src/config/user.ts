import type { ProviderConfig } from "@code-embed/protocol";
import type { UserConfig } from "./types";

export function loadUserConfig(): UserConfig {
  throw new Error("not implemented: config/user.loadUserConfig");
}

export function loadProviders(): Record<string, ProviderConfig> {
  throw new Error("not implemented: config/user.loadProviders");
}

export function saveProvider(_name: string, _cfg: ProviderConfig): void {
  throw new Error("not implemented: config/user.saveProvider");
}
