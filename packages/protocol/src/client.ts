import {
  CancellationTokenSource,
  ResponseError,
  type CancellationToken,
  type MessageConnection,
} from "vscode-jsonrpc";
import {
  EngineRpcError,
  ErrorCodes,
  Methods,
  Notifications,
  PROTOCOL_VERSION,
  type ActivityParams,
  type Disposable,
  type EngineApi,
  type FilesChangedParams,
  type FilesOpenedParams,
  type IndexErrorParams,
  type IndexProgress,
  type InitializeParams,
  type LogParams,
} from "./rpc";

const UPGRADE_MESSAGE = "protocol version mismatch: update the extension/CLI";

function toRpcError(err: unknown): unknown {
  if (err instanceof EngineRpcError) return err;
  if (err instanceof ResponseError) return new EngineRpcError(err.code, err.message, err.data);
  return err;
}

function fanOut<T>(conn: MessageConnection, method: string): (cb: (p: T) => void) => Disposable {
  const listeners = new Set<(p: T) => void>();
  let registered = false;
  return (cb) => {
    if (!registered) {
      registered = true;
      conn.onNotification(method, (p: T) => {
        for (const l of [...listeners]) l(p);
      });
    }
    listeners.add(cb);
    return { dispose: () => void listeners.delete(cb) };
  };
}

export function createEngineProxy(conn: MessageConnection): EngineApi {
  const request = async <R>(method: string, params?: unknown, signal?: AbortSignal): Promise<R> => {
    if (signal?.aborted) throw new EngineRpcError(ErrorCodes.RequestCancelled, "Request cancelled");
    const source = new CancellationTokenSource();
    const onAbort = () => source.cancel();
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const result =
        params === undefined
          ? await conn.sendRequest(method, source.token)
          : await conn.sendRequest(method, params, source.token);
      return result as R;
    } catch (err) {
      throw toRpcError(err);
    } finally {
      signal?.removeEventListener("abort", onAbort);
      source.dispose();
    }
  };

  const onProgress = fanOut<IndexProgress>(conn, Notifications.indexProgress);
  const onIndexError = fanOut<IndexErrorParams>(conn, Notifications.indexError);
  const onLog = fanOut<LogParams>(conn, Notifications.log);

  return {
    initialize: (p) => request(Methods.initialize, p),
    search: (p, signal) => request(Methods.search, p, signal),
    findSimilar: (p, signal) => request(Methods.findSimilar, p, signal),
    status: () => request(Methods.indexStatus),
    rebuild: (p) => request(Methods.indexRebuild, p ?? {}),
    pause: () => request(Methods.indexPause),
    resume: () => request(Methods.indexResume),
    updateSettings: (p) => request(Methods.settingsUpdate, p),
    testProvider: (p) => request(Methods.providerTest, p),
    listProviders: () => request(Methods.providerList),
    listModels: () => request(Methods.modelList),
    grantConsent: (p) => request(Methods.consentGrant, p),
    shutdown: () => request(Methods.shutdown),
    filesChanged: (p) => void conn.sendNotification(Notifications.filesChanged, p),
    filesOpened: (p) => void conn.sendNotification(Notifications.filesOpened, p),
    setActive: (p) => void conn.sendNotification(Notifications.clientActivity, p),
    onProgress,
    onIndexError,
    onLog,
  };
}

function toResponseError(err: unknown): ResponseError<unknown> {
  if (err instanceof ResponseError) return err;
  if (err instanceof EngineRpcError) return new ResponseError(err.code, err.message, err.data);
  const e = err instanceof Error ? err : new Error(String(err));
  switch (e.name) {
    case "NoIndexError":
      return new ResponseError(ErrorCodes.NoIndex, e.message);
    case "ConsentRequiredError": {
      const { host, provider } = e as Error & { host: string; provider: string };
      return new ResponseError(ErrorCodes.ConsentRequired, e.message, { host, provider });
    }
    case "ProviderUnavailableError":
      return new ResponseError(ErrorCodes.ProviderUnavailable, e.message);
    case "ReadOnlyError":
      return new ResponseError(ErrorCodes.ReadOnly, e.message);
    case "ProtocolMismatchError":
      return new ResponseError(ErrorCodes.ProtocolMismatch, e.message);
    default:
      return new ResponseError(-32603, e.message);
  }
}

type Handler = (params: unknown, signal: AbortSignal) => unknown;

export function registerEngineHandlers(conn: MessageConnection, api: EngineApi): Disposable {
  const handle = (method: string, fn: Handler) => {
    conn.onRequest(method, async (...args: unknown[]) => {
      const token = args[args.length - 1] as CancellationToken;
      const params = args.length > 1 ? args[0] : undefined;
      const ac = new AbortController();
      if (token.isCancellationRequested) ac.abort();
      const sub = token.onCancellationRequested(() => ac.abort());
      try {
        const result = await fn(params, ac.signal);
        if (ac.signal.aborted) throw new ResponseError(ErrorCodes.RequestCancelled, "Request cancelled");
        return result ?? null;
      } catch (err) {
        if (ac.signal.aborted) throw new ResponseError(ErrorCodes.RequestCancelled, "Request cancelled");
        throw toResponseError(err);
      } finally {
        sub.dispose();
      }
    });
  };

  handle(Methods.initialize, (p) => {
    const init = p as InitializeParams;
    if (init?.protocolVersion !== PROTOCOL_VERSION) {
      throw new ResponseError(ErrorCodes.ProtocolMismatch, UPGRADE_MESSAGE, {
        expected: PROTOCOL_VERSION,
        received: init?.protocolVersion ?? null,
      });
    }
    return api.initialize(init);
  });
  handle(Methods.search, (p, s) => api.search(p as never, s));
  handle(Methods.findSimilar, (p, s) => api.findSimilar(p as never, s));
  handle(Methods.indexStatus, () => api.status());
  handle(Methods.indexRebuild, (p) => api.rebuild(p as never));
  handle(Methods.indexPause, () => api.pause());
  handle(Methods.indexResume, () => api.resume());
  handle(Methods.settingsUpdate, (p) => api.updateSettings(p as never));
  handle(Methods.providerTest, (p) => api.testProvider(p as never));
  handle(Methods.providerList, () => api.listProviders());
  handle(Methods.modelList, () => api.listModels());
  handle(Methods.consentGrant, (p) => api.grantConsent(p as never));
  handle(Methods.shutdown, () => api.shutdown());

  conn.onNotification(Notifications.filesChanged, (p: FilesChangedParams) => api.filesChanged(p));
  conn.onNotification(Notifications.filesOpened, (p: FilesOpenedParams) => api.filesOpened(p));
  conn.onNotification(Notifications.clientActivity, (p: ActivityParams) => api.setActive(p));

  const subs = [
    api.onProgress((p) => void conn.sendNotification(Notifications.indexProgress, p)),
    api.onIndexError((p) => void conn.sendNotification(Notifications.indexError, p)),
    api.onLog((p) => void conn.sendNotification(Notifications.log, p)),
  ];
  return { dispose: () => subs.forEach((s) => s.dispose()) };
}
