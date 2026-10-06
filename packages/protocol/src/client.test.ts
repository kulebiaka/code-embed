import { PassThrough } from "node:stream";
import {
  StreamMessageReader,
  StreamMessageWriter,
  createMessageConnection,
  type MessageConnection,
} from "vscode-jsonrpc/node";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEngineProxy, registerEngineHandlers } from "./client";
import {
  EngineRpcError,
  ErrorCodes,
  PROTOCOL_VERSION,
  type EngineApi,
  type IndexProgress,
  type InitializeParams,
  type LogParams,
} from "./rpc";

const conns: MessageConnection[] = [];

function pair(api: EngineApi) {
  const a = new PassThrough();
  const b = new PassThrough();
  const client = createMessageConnection(new StreamMessageReader(a), new StreamMessageWriter(b));
  const server = createMessageConnection(new StreamMessageReader(b), new StreamMessageWriter(a));
  registerEngineHandlers(server, api);
  server.listen();
  client.listen();
  conns.push(client, server);
  return { proxy: createEngineProxy(client), client, server };
}

function fakeApi(over: Partial<EngineApi> = {}): EngineApi {
  const progress = new Set<(p: IndexProgress) => void>();
  const logs = new Set<(p: LogParams) => void>();
  const status = { root: "/r", phase: "idle" } as never;
  const api: EngineApi = {
    initialize: vi.fn(async (p: InitializeParams) => ({ serverVersion: "x", protocolVersion: p.protocolVersion }) as never),
    search: vi.fn(async () => ({ results: [], partial: false, tookMs: 1 })),
    findSimilar: vi.fn(async () => ({ results: [], partial: false, tookMs: 1 })),
    status: vi.fn(async () => status),
    rebuild: vi.fn(async () => {}),
    pause: vi.fn(async () => {}),
    resume: vi.fn(async () => {}),
    updateSettings: vi.fn(async () => {}),
    testProvider: vi.fn(async () => ({ dims: 3, latencyMs: 1 })),
    listProviders: vi.fn(async () => []),
    listModels: vi.fn(async () => []),
    grantConsent: vi.fn(async () => {}),
    shutdown: vi.fn(async () => {}),
    filesChanged: vi.fn(),
    filesOpened: vi.fn(),
    onProgress: (cb) => {
      progress.add(cb);
      return { dispose: () => void progress.delete(cb) };
    },
    onIndexError: () => ({ dispose() {} }),
    onLog: (cb) => {
      logs.add(cb);
      return { dispose: () => void logs.delete(cb) };
    },
    ...over,
  };
  (api as unknown as { emitProgress: (p: IndexProgress) => void }).emitProgress = (p) => progress.forEach((l) => l(p));
  (api as unknown as { emitLog: (p: LogParams) => void }).emitLog = (p) => logs.forEach((l) => l(p));
  return api;
}

afterEach(() => {
  for (const c of conns.splice(0)) c.dispose();
});

describe("engine proxy over Content-Length streams", () => {
  it("covers all methods", async () => {
    const api = fakeApi();
    const { proxy } = pair(api);
    const init = { root: "/r", clientName: "t", protocolVersion: PROTOCOL_VERSION };
    expect((await proxy.initialize(init)).protocolVersion).toBe(PROTOCOL_VERSION);
    await proxy.search({ query: "q" });
    await proxy.findSimilar({ code: "x" });
    await proxy.status();
    await proxy.rebuild();
    await proxy.rebuild({ full: true });
    await proxy.pause();
    await proxy.resume();
    await proxy.updateSettings({ allowRemote: true });
    expect(await proxy.testProvider({ name: "p" })).toEqual({ dims: 3, latencyMs: 1 });
    expect(await proxy.listProviders()).toEqual([]);
    expect(await proxy.listModels()).toEqual([]);
    await proxy.grantConsent({ host: "h" });
    await proxy.shutdown();
    expect(api.search).toHaveBeenCalledWith({ query: "q" }, expect.any(AbortSignal));
    expect(api.rebuild).toHaveBeenNthCalledWith(1, {});
    expect(api.rebuild).toHaveBeenNthCalledWith(2, { full: true });
    expect(api.grantConsent).toHaveBeenCalledWith({ host: "h" });
  });

  it("delivers notifications both ways", async () => {
    const api = fakeApi();
    const { proxy } = pair(api);
    const got: IndexProgress[] = [];
    const logs: LogParams[] = [];
    proxy.onProgress((p) => got.push(p));
    proxy.onLog((p) => logs.push(p));
    proxy.filesChanged({ created: ["/a"], changed: [], deleted: [] });
    proxy.filesOpened({ paths: ["/a"] });
    (api as unknown as { emitProgress: (p: IndexProgress) => void }).emitProgress({
      phase: "vector",
      done: 1,
      total: 2,
      embedded: 1,
    });
    (api as unknown as { emitLog: (p: LogParams) => void }).emitLog({ level: "info", message: "m" });
    await vi.waitFor(() => {
      expect(got).toHaveLength(1);
      expect(logs).toHaveLength(1);
      expect(api.filesChanged).toHaveBeenCalledWith({ created: ["/a"], changed: [], deleted: [] });
      expect(api.filesOpened).toHaveBeenCalledWith({ paths: ["/a"] });
    });
  });

  it("propagates AbortSignal as $/cancelRequest", async () => {
    let serverSignal: AbortSignal | undefined;
    const api = fakeApi({
      search: (_p, signal) =>
        new Promise((_, reject) => {
          serverSignal = signal;
          signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    });
    const { proxy } = pair(api);
    const ac = new AbortController();
    const pending = proxy.search({ query: "q" }, ac.signal);
    await vi.waitFor(() => expect(serverSignal).toBeDefined());
    ac.abort();
    await expect(pending).rejects.toMatchObject({ code: ErrorCodes.RequestCancelled });
    expect(serverSignal?.aborted).toBe(true);
  });

  it("rejects an already aborted signal without a round trip", async () => {
    const api = fakeApi();
    const { proxy } = pair(api);
    const ac = new AbortController();
    ac.abort();
    await expect(proxy.search({ query: "q" }, ac.signal)).rejects.toMatchObject({
      code: ErrorCodes.RequestCancelled,
    });
    expect(api.search).not.toHaveBeenCalled();
  });

  it("rejects initialize with another protocolVersion", async () => {
    const api = fakeApi();
    const { proxy } = pair(api);
    const err = await proxy
      .initialize({ root: "/r", clientName: "t", protocolVersion: PROTOCOL_VERSION + 1 })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EngineRpcError);
    expect((err as EngineRpcError).code).toBe(ErrorCodes.ProtocolMismatch);
    expect((err as EngineRpcError).message).toContain("обновите расширение/CLI");
    expect(api.initialize).not.toHaveBeenCalled();
  });

  it.each([
    ["NoIndexError", ErrorCodes.NoIndex, undefined],
    ["ConsentRequiredError", ErrorCodes.ConsentRequired, { host: "h.example", provider: "p" }],
    ["ProviderUnavailableError", ErrorCodes.ProviderUnavailable, undefined],
    ["ReadOnlyError", ErrorCodes.ReadOnly, undefined],
  ])("maps %s to %i", async (name, code, data) => {
    const api = fakeApi({
      search: async () => {
        const e = Object.assign(new Error("boom"), { name }, data);
        throw e;
      },
    });
    const { proxy } = pair(api);
    const err = (await proxy.search({ query: "q" }).catch((e: unknown) => e)) as EngineRpcError;
    expect(err).toBeInstanceOf(EngineRpcError);
    expect(err.code).toBe(code);
    if (data) expect(err.data).toEqual(data);
  });
});
