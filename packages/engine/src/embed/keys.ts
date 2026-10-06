import type { ProviderConfig } from "@code-embed/protocol";

export async function resolveApiKey(
  name: string,
  cfg: ProviderConfig,
  apiKeys?: Record<string, string>,
): Promise<string | undefined> {
  const fromClient = apiKeys?.[name];
  if (fromClient) return fromClient;
  if (cfg.api_key_env) {
    const fromEnv = process.env[cfg.api_key_env];
    if (fromEnv) return fromEnv;
  }
  try {
    const { Entry } = await import("@napi-rs/keyring");
    return new Entry("code-embed", name).getPassword() ?? undefined;
  } catch {
    return undefined;
  }
}
