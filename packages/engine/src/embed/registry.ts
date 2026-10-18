import { hasConsent } from "../config/consents";
import type { EffectiveSettings } from "../config/types";
import { modelsDir } from "../core/paths";
import { ConsentRequiredError } from "../errors";
import { getModel } from "./catalog";
import { FakeEmbedder } from "./fake";
import { createHostEmbedder, sharedHostEnabled } from "./host-client";
import { resolveApiKey } from "./keys";
import { createLocalEmbedder } from "./local";
import { withQueryCache } from "./lru";
import { createOpenAIEmbedder } from "./openai";
import type { Embedder } from "./types";
import { createWorkerEmbedder } from "./worker";

export function isLoopbackUrl(url: string): boolean {
  if (/^(unix|http\+unix):/i.test(url)) return true;
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return host === "localhost" || host === "::1" || host === "[::1]" || /^127\.\d+\.\d+\.\d+$/.test(host);
}

export interface ResolveEmbedderOptions {
  root: string;
  settings: EffectiveSettings;
  apiKeys?: Record<string, string>;
}

export async function resolveEmbedder(opts: ResolveEmbedderOptions): Promise<Embedder> {
  const { root, settings, apiKeys } = opts;
  if (process.env.CODE_EMBED_FAKE_EMBEDDER === "1") {
    const dims = Number(process.env.CODE_EMBED_FAKE_DIMS) || 64;
    return withQueryCache(new FakeEmbedder({ dims }));
  }
  if (settings.provider === "local") {
    const entry = getModel(settings.model);
    const localOpts = {
      modelsDir: modelsDir(),
      threads: settings.threads,
      offlineArchive: settings.offlineArchive,
      proxy: settings.proxy,
    };
    if (entry.pooling === "static") return withQueryCache(createLocalEmbedder(entry, localOpts));
    return withQueryCache(
      sharedHostEnabled()
        ? createHostEmbedder(entry, localOpts, { project: root })
        : createWorkerEmbedder(entry, localOpts),
    );
  }
  const name = settings.provider;
  const cfg = settings.providers[name];
  if (!cfg) {
    const known = ["local", ...Object.keys(settings.providers)].join(", ");
    throw new Error(`unknown embedding provider "${name}" (available: ${known})`);
  }
  if (!isLoopbackUrl(cfg.base_url)) {
    const host = new URL(cfg.base_url).hostname.toLowerCase();
    if (!settings.allowRemote && !hasConsent(root, host)) throw new ConsentRequiredError(host, name);
  }
  const apiKey = await resolveApiKey(name, cfg, apiKeys);
  return withQueryCache(createOpenAIEmbedder({ name, config: cfg, apiKey }));
}

export function describeProvider(settings: EffectiveSettings): { provider: string; remote: boolean; host?: string } {
  const cfg = settings.provider === "local" ? undefined : settings.providers[settings.provider];
  if (!cfg || isLoopbackUrl(cfg.base_url)) return { provider: settings.provider, remote: false };
  return { provider: settings.provider, remote: true, host: new URL(cfg.base_url).hostname.toLowerCase() };
}
