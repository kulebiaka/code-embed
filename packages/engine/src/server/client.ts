import type { EngineApi } from "@code-embed/protocol";
import type { LocalEngine, LocalEngineOptions } from "../engine/types";

export interface RemoteEngine extends EngineApi {
  close(): void;
}

export function connectDaemon(_root: string, _clientName: string, _timeoutMs?: number): Promise<RemoteEngine | null> {
  throw new Error("not implemented: server/client.connectDaemon");
}

export interface OpenedEngine {
  api: EngineApi;
  local: LocalEngine | null;
  viaDaemon: boolean;
  close(): Promise<void>;
}

export function openEngine(_opts: LocalEngineOptions & { preferDaemon?: boolean }): Promise<OpenedEngine> {
  throw new Error("not implemented: server/client.openEngine");
}
