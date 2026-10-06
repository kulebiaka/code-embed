import { stat } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { subscribe } from "@parcel/watcher";
import { createIgnoreMatcher } from "../scan/scan";
import { log } from "../util/log";
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

type Kind = "created" | "changed" | "deleted";

export interface Aggregator {
  add(kind: Kind, path: string): void;
  flush(): Promise<void>;
  dispose(): void;
}

export function createAggregator(opts: {
  debounceMs: number;
  massThreshold: number;
  isIgnored: (absPath: string) => boolean;
  onBatch: (changes: PathChanges, mass: boolean) => Promise<void>;
}): Aggregator {
  const pending = new Map<string, Kind>();
  const emitted = new Map<string, string>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let chain: Promise<void> = Promise.resolve();

  const signature = async (path: string): Promise<string | null> => {
    try {
      const st = await stat(path);
      return st.isFile() ? `${st.mtimeMs}:${st.size}` : null;
    } catch {
      return null;
    }
  };

  const run = async (entries: [string, Kind][]): Promise<void> => {
    const changes: PathChanges = { created: [], changed: [], deleted: [] };
    for (const [path, kind] of entries) {
      const sig = await signature(path);
      if (sig === null) {
        if (kind === "deleted" || emitted.has(path)) {
          emitted.delete(path);
          changes.deleted.push(path);
        }
        continue;
      }
      if (emitted.get(path) === sig) continue;
      emitted.set(path, sig);
      (kind === "created" ? changes.created : changes.changed).push(path);
    }
    const total = changes.created.length + changes.changed.length + changes.deleted.length;
    if (total === 0) return;
    try {
      await opts.onBatch(changes, total > opts.massThreshold);
    } catch (e) {
      log.error(`watcher batch failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const flush = (): Promise<void> => {
    if (timer) clearTimeout(timer);
    timer = null;
    const entries = [...pending];
    pending.clear();
    if (entries.length === 0) return chain;
    chain = chain.then(() => run(entries));
    return chain;
  };

  return {
    add(kind, path) {
      if (opts.isIgnored(path)) return;
      const prev = pending.get(path);
      let next = kind;
      if (prev === "created" && kind === "changed") next = "created";
      else if (prev === "deleted" && kind === "created") next = "changed";
      pending.set(path, next);
      if (!timer) timer = setTimeout(() => void flush(), opts.debounceMs);
    },
    flush,
    dispose() {
      if (timer) clearTimeout(timer);
      timer = null;
      pending.clear();
    },
  };
}

export async function startWatcher(opts: WatcherOptions): Promise<Watcher> {
  const root = resolve(opts.root);
  const indexDir = resolve(opts.indexDir);
  const matcher = await createIgnoreMatcher(root, opts.exclude);
  const isIgnored = (abs: string): boolean => {
    if (abs === indexDir || abs.startsWith(indexDir + sep)) return true;
    const rel = relative(root, abs);
    if (rel === "" || rel.startsWith("..")) return true;
    return matcher(rel, false);
  };

  const agg = createAggregator({
    debounceMs: opts.debounceMs ?? 500,
    massThreshold: opts.massThreshold ?? 200,
    isIgnored,
    onBatch: opts.onBatch,
  });

  const sub = await subscribe(
    root,
    (err, events) => {
      if (err) {
        log.warn(`watcher error: ${err.message}`);
        return;
      }
      for (const ev of events) {
        agg.add(ev.type === "create" ? "created" : ev.type === "delete" ? "deleted" : "changed", ev.path);
      }
    },
    { ignore: [indexDir, "**/.code-embed", "**/.code-embed/**"] },
  );

  return {
    async close() {
      await sub.unsubscribe();
      agg.dispose();
    },
    notify(changes) {
      for (const p of changes.created) agg.add("created", p);
      for (const p of changes.changed) agg.add("changed", p);
      for (const p of changes.deleted) agg.add("deleted", p);
    },
  };
}
