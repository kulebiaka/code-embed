import type { Disposable, EngineApi, IndexStatus } from "@code-embed/protocol";

export type ClientState = "starting" | "ready" | "restarting" | "failed" | "stopped";

export interface EngineClient extends EngineApi {
  readonly state: ClientState;
  readonly lastStatus: IndexStatus | undefined;
  onDidChangeState(cb: (s: ClientState) => void): Disposable;
  // Fired after initialize, on index.progress and periodically.
  onStatus(cb: (s: IndexStatus) => void): Disposable;
}

export interface EngineSupervisor extends Disposable {
  readonly client: EngineClient;
  start(): Promise<void>;
  restart(): Promise<void>;
  showLog(): void;
}
