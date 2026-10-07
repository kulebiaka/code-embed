import {
  EngineRpcError,
  ErrorCodes,
  PROTOCOL_VERSION,
  type ConsentGrantParams,
  type Disposable,
  type EngineSettings,
  type FilesChangedParams,
  type FilesOpenedParams,
  type FindSimilarParams,
  type IndexErrorParams,
  type IndexPhase,
  type IndexProgress,
  type IndexStatus,
  type InitializeParams,
  type InitializeResult,
  type LogParams,
  type ModelListItem,
  type ProviderListItem,
  type ProviderTestParams,
  type ProviderTestResult,
  type RebuildParams,
  type SearchParams,
  type SearchResponse,
} from "@code-embed/protocol";
import pkg from "../../package.json";
import { openEmbCache } from "../cache/embcache";
import { exportVectors, importVectors } from "../cache/exchange";
import type { EmbCache } from "../cache/types";
import { DEFAULT_CHUNK_OPTIONS } from "../chunk/types";
import { grantConsent } from "../config/consents";
import { loadProjectConfig } from "../config/project";
import { resolveSettings } from "../config/resolve";
import type { EffectiveSettings } from "../config/types";
import { loadUserConfig } from "../config/user";
import { type IndexMeta, writeMeta } from "../core/meta";
import { embCachePath, modelsDir } from "../core/paths";
import { DEFAULT_MODEL_ID, loadManifest } from "../embed/catalog";
import { isModelInstalled } from "../embed/delivery";
import { describeProvider, isLoopbackUrl, resolveEmbedder } from "../embed/registry";
import type { Embedder } from "../embed/types";
import { ConsentRequiredError, ProtocolMismatchError } from "../errors";
import { applyChanges, runLexical } from "../indexer/lexical";
import { type OpenedIndex, openIndex } from "../indexer/open";
import type { IndexerContext, PathChanges } from "../indexer/types";
import { type VectorPhase, createVectorPhase } from "../indexer/vector";
import { type Watcher, startWatcher } from "../indexer/watcher";
import { search } from "../search/hybrid";
import { findSimilar } from "../search/similar";
import type { SearchContext } from "../search/types";
import { initHashing } from "../util/hash";
import { log, setLogSink } from "../util/log";
import { throttleLatest } from "./throttle";
import type { LocalEngine, LocalEngineOptions } from "./types";

export const SERVER_VERSION: string = pkg.version;

const PROGRESS_INTERVAL_MS = 500;

function mergeSettings(a: EngineSettings, b: EngineSettings): EngineSettings {
  return {
    ...a,
    ...b,
    index: { ...a.index, ...b.index },
    search: { ...a.search, ...b.search },
    model: { ...a.model, ...b.model },
    embedding: { ...a.embedding, ...b.embedding },
    providers: { ...a.providers, ...b.providers },
  };
}

function embeddingKey(s: EffectiveSettings): string {
  return JSON.stringify([s.provider, s.model, s.providers, s.allowRemote, s.offlineArchive, s.proxy, s.threads]);
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export async function createLocalEngine(opts: LocalEngineOptions): Promise<LocalEngine> {
  await initHashing();
  const root = opts.root;
  let editor: EngineSettings = opts.settings ?? {};
  const resolve = () =>
    resolveSettings({ cli: opts.cli, project: loadProjectConfig(root), editor, user: loadUserConfig() });
  let settings = resolve();

  let embedder: Embedder | null = null;
  let embedderError: string | undefined;
  let consentRequired: { host: string; provider: string } | undefined;

  const setupEmbedder = async () => {
    embedder = null;
    embedderError = undefined;
    consentRequired = undefined;
    try {
      embedder = await resolveEmbedder({ root, settings, apiKeys: opts.apiKeys });
    } catch (e) {
      embedderError = msg(e);
      if (e instanceof ConsentRequiredError) consentRequired = { host: e.host, provider: e.provider };
      else log.warn(`embedding provider unavailable: ${embedderError}`);
    }
  };
  await setupEmbedder();

  const initial = (embedder as Embedder | null)?.info;
  const opened: OpenedIndex = await openIndex(root, settings, {
    readonly: opts.readonly,
    expectedModelId: initial && initial.dims > 0 ? initial.modelId : undefined,
    dims: initial && initial.dims > 0 ? initial.dims : undefined,
  });
  const { store, indexDir, readOnly } = opened;
  let meta: IndexMeta = opened.meta;
  const embCache: EmbCache = openEmbCache(embCachePath());

  const progressListeners = new Set<(p: IndexProgress) => void>();
  const errorListeners = new Set<(p: IndexErrorParams) => void>();
  const logListeners = new Set<(p: LogParams) => void>();
  const fanOut = <T>(set: Set<(p: T) => void>, p: T) => {
    for (const cb of [...set]) {
      try {
        cb(p);
      } catch {}
    }
  };

  let phase: IndexPhase = "idle";
  let lastError: string | undefined;
  let userPaused = false;
  let closed = false;

  const throttled = throttleLatest<IndexProgress>((p) => fanOut(progressListeners, p), PROGRESS_INTERVAL_MS);
  setLogSink((level, message) => fanOut(logListeners, { level, message }));

  const ctx: IndexerContext = {
    root,
    indexDir,
    store,
    settings,
    chunkOptions: DEFAULT_CHUNK_OPTIONS,
    onProgress: (p) => {
      phase = p.phase;
      throttled.push(p);
    },
    onError: (e) => {
      lastError = e.message;
      fanOut(errorListeners, e);
    },
  };

  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const r = chain.then(fn);
    chain = r.catch(() => {});
    return r;
  };

  const readOnlyError = () => new EngineRpcError(ErrorCodes.ReadOnly, "index is opened read-only");

  let needsLexical = opened.created;
  let vector: VectorPhase | null = null;
  let vectorStarted = false;
  let watcher: Watcher | null = null;
  let startup: Promise<void> = Promise.resolve();

  const setupVector = () => {
    vector = embedder && !readOnly ? createVectorPhase({ ctx, embCache, embedder }) : null;
    return vector;
  };

  const adoptEmbedder = () => {
    if (!embedder || readOnly) return;
    const { modelId, dims } = embedder.info;
    if (dims <= 0 || (meta.model_id === modelId && meta.dims === dims && store.dims === dims)) return;
    store.setVectorDims(dims);
    meta = { ...meta, model_id: modelId, dims };
    writeMeta(indexDir, meta);
  };

  const startVector = async () => {
    if (!vector || !embedder) return;
    if (vectorStarted) {
      vector.notifyChanged([]);
      return;
    }
    if (embedder.info.dims <= 0) {
      try {
        await embedder.init();
      } catch (e) {
        ctx.onError({ message: `embedding provider unavailable: ${msg(e)}` });
      }
    }
    adoptEmbedder();
    vectorStarted = true;
    vector.start();
  };

  const lexicalPass = async (full: boolean, signal?: AbortSignal, budgetMs?: number) => {
    const r = await serial(() => runLexical(ctx, { full, signal, budgetMs }));
    if (!r.timedOut && !signal?.aborted) needsLexical = false;
    if (!vector || vector.state === "idle") phase = "idle";
    return r;
  };

  const ensureLexical = async () => {
    if (readOnly || !needsLexical) return;
    await lexicalPass(false);
  };

  const applyBatch = async (changes: PathChanges, mass: boolean) => {
    if (closed) return;
    try {
      if (mass) {
        await lexicalPass(false);
        vector?.notifyChanged([]);
        return;
      }
      const { changedPaths } = await serial(() => applyChanges(ctx, changes));
      if (changedPaths.length > 0) vector?.notifyChanged(changedPaths);
    } catch (e) {
      ctx.onError({ message: `update failed: ${msg(e)}` });
    }
  };

  const vectorsReady = () => {
    const c = store.counts();
    const ratio = c.chunks === 0 ? 0 : c.embedded / c.chunks;
    return { ratio, ready: c.chunks > 0 && c.embedded >= c.chunks };
  };

  const searchContext = (): SearchContext => ({
    store,
    embCache,
    embedder,
    modelId: embedder?.info.modelId ?? meta.model_id,
    vectorsReady,
    embedderError,
  });

  setupVector();
  if (!readOnly && opts.watch) {
    watcher = await startWatcher({ root, indexDir, exclude: settings.exclude, onBatch: applyBatch });
  }
  if (!readOnly && opts.vectorPhase) {
    startup = (async () => {
      try {
        await lexicalPass(false);
        await startVector();
      } catch (e) {
        ctx.onError({ message: `indexing failed: ${msg(e)}` });
      }
    })();
  }

  const status = async (): Promise<IndexStatus> => {
    const c = store.counts();
    const provider = describeProvider(settings);
    const st: IndexStatus = {
      root,
      indexDir,
      files: c.files,
      chunks: c.chunks,
      embedded: c.embedded,
      phase: userPaused ? "paused" : phase,
      model: embedder?.info.modelId ?? meta.model_id,
      provider: provider.provider,
      remote: provider.remote,
      lexicalOnly: embedder === null,
      readOnly,
      daemon: false,
    };
    if (provider.host) st.host = provider.host;
    if (consentRequired) st.consentRequired = consentRequired;
    const err = lastError ?? embedderError;
    if (err) st.lastError = err;
    return st;
  };

  const reconfigureEmbedder = async () => {
    const wasStarted = vectorStarted;
    await vector?.stop();
    vector = null;
    vectorStarted = false;
    await embedder?.dispose();
    await setupEmbedder();
    adoptEmbedder();
    if (userPaused) setupVector()?.pause();
    else setupVector();
    if (wasStarted || opts.vectorPhase) await startVector();
  };

  const requireEmbedder = (): Embedder => {
    if (embedder) return embedder;
    throw new Error(embedderError ?? "embedding provider is not configured");
  };

  const waitIdle = (signal?: AbortSignal) =>
    new Promise<void>((done) => {
      if (!vector || signal?.aborted) return done();
      const phase = vector;
      const onAbort = () => {
        phase.pause();
        done();
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      void phase.whenIdle().then(() => {
        signal?.removeEventListener("abort", onAbort);
        done();
      });
    });

  const chunkHashes = (): string[] => {
    const hashes = new Set<string>();
    for (const f of store.listFiles()) for (const c of store.chunksForFile(f.path)) hashes.add(c.chunkHash);
    return [...hashes];
  };

  const close = async () => {
    if (closed) return;
    closed = true;
    throttled.dispose();
    await watcher?.close();
    await vector?.stop();
    await startup;
    await chain;
    await embedder?.dispose();
    setLogSink(null);
    embCache.close();
    store.close();
    opened.lock?.release();
  };

  const engine: LocalEngine = {
    root,
    async initialize(p: InitializeParams): Promise<InitializeResult> {
      if (p.protocolVersion !== PROTOCOL_VERSION) {
        throw new ProtocolMismatchError(
          `protocol version ${p.protocolVersion} is not supported (server speaks ${PROTOCOL_VERSION})`,
        );
      }
      return {
        serverVersion: SERVER_VERSION,
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { search: true, findSimilar: true, watcher: watcher !== null, readOnly },
        index: await status(),
      };
    },
    async search(p: SearchParams, signal?: AbortSignal): Promise<SearchResponse> {
      await ensureLexical();
      return search(
        searchContext(),
        { ...p, mode: p.mode ?? settings.searchMode, top: p.top ?? settings.searchTop },
        signal,
      );
    },
    async findSimilar(p: FindSimilarParams, signal?: AbortSignal): Promise<SearchResponse> {
      await ensureLexical();
      return findSimilar({ ...searchContext(), root }, p, signal);
    },
    status,
    async rebuild(p?: RebuildParams) {
      if (readOnly) throw readOnlyError();
      await lexicalPass(p?.full ?? false);
      await startVector();
    },
    async pause() {
      userPaused = true;
      vector?.pause();
    },
    async resume() {
      userPaused = false;
      vector?.resume();
    },
    async updateSettings(p: EngineSettings) {
      const before = embeddingKey(settings);
      editor = mergeSettings(editor, p);
      settings = resolve();
      ctx.settings = settings;
      if (embeddingKey(settings) !== before) await reconfigureEmbedder();
    },
    async testProvider(p: ProviderTestParams): Promise<ProviderTestResult> {
      const probe = await resolveEmbedder({
        root,
        settings: { ...settings, provider: p.name },
        apiKeys: opts.apiKeys,
      });
      try {
        const t0 = performance.now();
        await probe.init();
        const [v] = await probe.embedQueries(["code-embed provider test"]);
        return { dims: v?.length ?? probe.info.dims, latencyMs: Math.round(performance.now() - t0) };
      } finally {
        await probe.dispose();
      }
    },
    async listProviders(): Promise<ProviderListItem[]> {
      const items: ProviderListItem[] = [
        { name: "local", kind: "local", model: settings.model, remote: false, source: "builtin" },
      ];
      for (const [name, cfg] of Object.entries(settings.providers)) {
        const remote = !isLoopbackUrl(cfg.base_url);
        const item: ProviderListItem = {
          name,
          kind: cfg.kind,
          model: cfg.model,
          baseUrl: cfg.base_url,
          remote,
          source: editor.providers?.[name] ? "editor" : "user",
        };
        if (remote) item.host = new URL(cfg.base_url).hostname.toLowerCase();
        items.push(item);
      }
      return items;
    },
    async listModels(): Promise<ModelListItem[]> {
      return loadManifest().models.map((m) => ({
        id: m.id,
        dims: m.dims,
        license: m.license,
        sizeMb: m.sizeMb,
        installed: isModelInstalled(m, modelsDir()),
        isDefault: m.id === DEFAULT_MODEL_ID,
      }));
    },
    async grantConsent(p: ConsentGrantParams) {
      grantConsent(root, p.host);
      await reconfigureEmbedder();
      await startVector();
    },
    shutdown: close,
    filesChanged(p: FilesChangedParams) {
      if (readOnly || closed) return;
      if (watcher) watcher.notify(p);
      else void applyBatch(p, false);
    },
    filesOpened(p: FilesOpenedParams) {
      vector?.prioritize(p.paths);
    },
    onProgress(cb): Disposable {
      progressListeners.add(cb);
      return { dispose: () => void progressListeners.delete(cb) };
    },
    onIndexError(cb): Disposable {
      errorListeners.add(cb);
      return { dispose: () => void errorListeners.delete(cb) };
    },
    onLog(cb): Disposable {
      logListeners.add(cb);
      return { dispose: () => void logListeners.delete(cb) };
    },
    async quickUpdate(budgetMs: number) {
      if (readOnly) return { complete: true };
      if (needsLexical) {
        await ensureLexical();
        return { complete: true };
      }
      const r = await lexicalPass(false, undefined, budgetMs);
      return { complete: !r.timedOut };
    },
    ensureLexical,
    async indexAll({ full, signal }) {
      if (readOnly) throw readOnlyError();
      await lexicalPass(full ?? false, signal);
      if (signal?.aborted) return;
      requireEmbedder();
      await startVector();
      await waitIdle(signal);
      if (signal?.aborted) return;
      const c = store.counts();
      if (c.embedded < c.chunks) throw new Error(lastError ?? "vector indexing did not complete");
    },
    async exportVectors(outFile: string) {
      const e = requireEmbedder();
      await e.init();
      return exportVectors(embCache, e.info.modelId, e.info.dims, chunkHashes(), outFile);
    },
    async importVectors(file: string) {
      const e = requireEmbedder();
      await e.init();
      const r = await importVectors(embCache, file, { modelId: e.info.modelId, dims: e.info.dims });
      if (vectorStarted) vector?.notifyChanged([]);
      return r;
    },
    close,
  };
  return engine;
}
