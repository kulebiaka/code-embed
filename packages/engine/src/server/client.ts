import { connect, type Socket } from "node:net";
import { createEngineProxy, PROTOCOL_VERSION, type EngineApi } from "@code-embed/protocol";
import { StreamMessageReader, StreamMessageWriter, createMessageConnection } from "vscode-jsonrpc/node";
import { isProcessAlive, readLockPid } from "../core/lock";
import { socketPath } from "../core/paths";
import { createLocalEngine } from "../engine/service";
import type { LocalEngine, LocalEngineOptions } from "../engine/types";
import { initHashing } from "../util/hash";
import { indexDirFor } from "./index-dir";

export interface RemoteEngine extends EngineApi {
  close(): void;
}

export function probeSocket(path: string, timeoutMs: number): Promise<Socket | null> {
  return new Promise((resolve) => {
    const socket = connect(path);
    const timer = setTimeout(() => fail(), timeoutMs);
    const fail = () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(null);
    };
    socket.once("error", fail);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.removeListener("error", fail);
      resolve(socket);
    });
  });
}

export async function connectDaemon(
  root: string,
  _clientName: string,
  timeoutMs = 200,
): Promise<RemoteEngine | null> {
  await initHashing();
  const socket = await probeSocket(socketPath(root), timeoutMs);
  if (!socket) return null;
  socket.on("error", () => {});
  const conn = createMessageConnection(new StreamMessageReader(socket), new StreamMessageWriter(socket));
  conn.listen();
  const proxy = createEngineProxy(conn);
  return {
    ...proxy,
    close() {
      conn.dispose();
      socket.destroy();
    },
  };
}

export async function openEngine(opts: LocalEngineOptions & { preferDaemon?: boolean }): Promise<OpenedEngine> {
  const { preferDaemon = true, ...engineOpts } = opts;

  if (preferDaemon) {
    const remote = await connectDaemon(opts.root, opts.clientName);
    if (remote) {
      try {
        await remote.initialize({
          root: opts.root,
          clientName: opts.clientName,
          protocolVersion: PROTOCOL_VERSION,
          settings: opts.settings,
          apiKeys: opts.apiKeys,
        });
      } catch (err) {
        remote.close();
        throw err;
      }
      return { api: remote, local: null, viaDaemon: true, close: async () => remote.close() };
    }
  }

  const holder = readLockPid(indexDirFor(opts.root));
  const lockedByOther = holder !== null && holder !== process.pid && isProcessAlive(holder);
  const local = await createLocalEngine({ ...engineOpts, readonly: engineOpts.readonly || lockedByOther });
  return { api: local, local, viaDaemon: false, close: () => local.close() };
}

export interface OpenedEngine {
  api: EngineApi;
  local: LocalEngine | null;
  viaDaemon: boolean;
  close(): Promise<void>;
}
