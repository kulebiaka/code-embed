import type { LocalEngine } from "../engine/types";

export interface DaemonOptions {
  root: string;
  createEngine: (root: string) => Promise<LocalEngine>;
  detach?: boolean;
}

export function runDaemon(_opts: DaemonOptions): Promise<void> {
  throw new Error("not implemented: server/daemon.runDaemon");
}

export function stopDaemon(_root: string): Promise<boolean> {
  throw new Error("not implemented: server/daemon.stopDaemon");
}
