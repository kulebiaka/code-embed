import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { getModel } from "./catalog";
import { createLocalEmbedder, type LocalEmbedderOptions } from "./local";
import type { Embedder } from "./types";

export type WorkerRequest =
  | { id: number; op: "init"; model: string; opts: LocalEmbedderOptions }
  | { id: number; op: "embed"; kind: "query" | "document"; texts: string[] }
  | { id: number; op: "dispose" };

export type WorkerResponse =
  | { id: number; ok: true; result?: Float32Array[] }
  | { id: number; ok: false; error: { name: string; message: string; retryAfterMs?: number } };

type Create = (model: string, opts: LocalEmbedderOptions) => Embedder;

const defaultCreate: Create = (model, opts) => createLocalEmbedder(getModel(model), opts);

export function runEmbedWorker(create: Create = defaultCreate): Promise<void> {
  return new Promise((resolve) => {
    let embedder: Embedder | undefined;
    let chain: Promise<void> = Promise.resolve();

    const handle = async (req: WorkerRequest): Promise<Float32Array[] | undefined> => {
      if (req.op === "init") {
        embedder = create(req.model, req.opts);
        await embedder.init();
        return undefined;
      }
      if (req.op === "dispose") {
        await embedder?.dispose();
        embedder = undefined;
        return undefined;
      }
      if (!embedder) throw new Error("embedder not initialized");
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
        .then(() => embedder?.dispose())
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
