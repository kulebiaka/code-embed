import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { getModel } from "./catalog";
import { createLocalEmbedder, type LocalEmbedderOptions } from "./local";
import type { Embedder } from "./types";

export type WorkerRequest =
  | { id: number; op: "load"; model: string; opts: LocalEmbedderOptions }
  | { id: number; op: "embed"; model: string; kind: "query" | "document"; texts: string[] }
  | { id: number; op: "unload"; model: string }
  | { id: number; op: "dispose" };

export type WorkerResponse =
  | { id: number; ok: true; result?: Float32Array[] }
  | { id: number; ok: false; error: { name: string; message: string; retryAfterMs?: number } };

type Create = (model: string, opts: LocalEmbedderOptions) => Embedder;

const defaultCreate: Create = (model, opts) => createLocalEmbedder(getModel(model), opts);

export function runEmbedWorker(create: Create = defaultCreate): Promise<void> {
  return new Promise((resolve) => {
    const embedders = new Map<string, Embedder>();
    let chain: Promise<void> = Promise.resolve();

    const handle = async (req: WorkerRequest): Promise<Float32Array[] | undefined> => {
      if (req.op === "load") {
        if (embedders.has(req.model)) return undefined;
        const embedder = create(req.model, req.opts);
        await embedder.init();
        embedders.set(req.model, embedder);
        return undefined;
      }
      if (req.op === "unload") {
        const embedder = embedders.get(req.model);
        embedders.delete(req.model);
        await embedder?.dispose();
        return undefined;
      }
      if (req.op === "dispose") {
        const all = [...embedders.values()];
        embedders.clear();
        await Promise.all(all.map((e) => e.dispose()));
        return undefined;
      }
      const embedder = embedders.get(req.model);
      if (!embedder) throw new Error(`model ${req.model} is not loaded`);
      return req.kind === "query" ? embedder.embedQueries(req.texts) : embedder.embedDocuments(req.texts);
    };

    process.on("message", (req: WorkerRequest) => {
      chain = chain.then(async () => {
        let res: WorkerResponse;
        try {
          res = { id: req.id, ok: true, result: await handle(req) };
        } catch (err) {
          const e = err instanceof Error ? err : new Error(String(err));
          const retryAfterMs = (e as { retryAfterMs?: number }).retryAfterMs;
          res = { id: req.id, ok: false, error: { name: e.name, message: e.message, retryAfterMs } };
        }
        process.send?.(res);
      });
    });

    process.once("disconnect", () => {
      chain = chain
        .then(async () => {
          await Promise.all([...embedders.values()].map((e) => e.dispose()));
        })
        .catch(() => undefined)
        .then(resolve);
    });
  });
}

function isEntry(): boolean {
  const entry = process.argv[1];
  if (!entry || process.send === undefined || !import.meta.url.endsWith("/worker-child.ts")) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntry()) {
  void runEmbedWorker().then(() => process.exit(0));
}
