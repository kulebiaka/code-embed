import { parseArgs } from "node:util";
import type { EngineApi, IndexProgress } from "@code-embed/protocol";
import { withConsent } from "../consent";
import { openForCli } from "../open";
import { EXIT, type CliIO, type CommandRun } from "../types";

const POLL_MS = 300;

function progressWriter(io: CliIO) {
  let lastPhase = "";
  return {
    write(p: IndexProgress) {
      const line = `${p.phase}: ${p.done}/${p.total}, vectors ${p.embedded}`;
      if (io.isTTY) io.stderr.write(`\r\x1b[K${line}`);
      else if (p.phase !== lastPhase) io.stderr.write(`${line}\n`);
      lastPhase = p.phase;
    },
    end() {
      if (io.isTTY && lastPhase) io.stderr.write("\n");
    },
  };
}

async function waitForDaemon(api: EngineApi): Promise<string | null> {
  for (;;) {
    const s = await api.status();
    if (s.phase === "error") return s.lastError ?? "indexing failed";
    if (s.phase === "idle" || s.phase === "paused") {
      return s.chunks > 0 && s.embedded < s.chunks && s.lastError ? s.lastError : null;
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

export const run: CommandRun = async (argv, io) => {
  try {
    const { values } = parseArgs({
      args: argv,
      options: {
        watch: { type: "boolean" },
        full: { type: "boolean" },
        root: { type: "string" },
        provider: { type: "string" },
        model: { type: "string" },
        "allow-remote": { type: "boolean" },
      },
      strict: true,
    });
    const { opened } = await openForCli(
      io,
      { root: values.root, provider: values.provider, model: values.model, allowRemote: values["allow-remote"] },
      { watch: values.watch, vectorPhase: false },
    );
    const progress = progressWriter(io);
    const sub = opened.api.onProgress((p) => progress.write(p));
    const abort = new AbortController();
    const onSigint = () => abort.abort();
    process.once("SIGINT", onSigint);
    try {
      const full = values.full ?? false;
      let failure: string | null = null;
      if (opened.local) {
        const local = opened.local;
        const res = await withConsent(io, opened.api, () => local.indexAll({ full, signal: abort.signal }));
        if (res === null) return EXIT.ERROR;
      } else {
        const res = await withConsent(io, opened.api, () => opened.api.rebuild({ full }));
        if (res === null) return EXIT.ERROR;
        failure = await waitForDaemon(opened.api);
      }
      progress.end();
      if (failure) {
        io.stderr.write(`code-embed: ${failure}\n`);
        return EXIT.ERROR;
      }
      const s = await opened.api.status();
      io.stderr.write(`indexed ${s.files} files, ${s.chunks} chunks, vectors ${s.embedded}/${s.chunks}\n`);
      if (values.watch && !abort.signal.aborted) {
        io.stderr.write(
          opened.viaDaemon ? "daemon is watching for changes\n" : "watching for changes, press Ctrl+C to stop\n",
        );
        if (!opened.viaDaemon) await new Promise<void>((r) => abort.signal.addEventListener("abort", () => r()));
      }
      return EXIT.OK;
    } finally {
      process.removeListener("SIGINT", onSigint);
      sub.dispose();
      await opened.close();
    }
  } catch (err) {
    io.stderr.write(`code-embed: ${err instanceof Error ? err.message : String(err)}\n`);
    return EXIT.ERROR;
  }
};
