import type { InitializeParams } from "@code-embed/protocol";
import type { LocalEngine } from "../engine/types";

export function serveStdio(_opts: { createEngine: (init: InitializeParams) => Promise<LocalEngine> }): Promise<void> {
  throw new Error("not implemented: server/serve.serveStdio");
}
