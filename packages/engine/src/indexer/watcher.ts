import type { PathChanges } from "./types";

export interface WatcherOptions {
  root: string;
  indexDir: string;
  exclude: string[];
  debounceMs?: number;
  massThreshold?: number;
  onBatch: (changes: PathChanges, mass: boolean) => Promise<void>;
}

export interface Watcher {
  close(): Promise<void>;
  // Client events (files.changed), deduplicated with own events.
  notify(changes: PathChanges): void;
}

export function startWatcher(_opts: WatcherOptions): Promise<Watcher> {
  throw new Error("not implemented: indexer/watcher.startWatcher");
}
