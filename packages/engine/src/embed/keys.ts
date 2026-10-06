import type { ProviderConfig } from "@code-embed/protocol";

export function resolveApiKey(
  _name: string,
  _cfg: ProviderConfig,
  _apiKeys?: Record<string, string>,
): Promise<string | undefined> {
  throw new Error("not implemented: embed/keys.resolveApiKey");
}
