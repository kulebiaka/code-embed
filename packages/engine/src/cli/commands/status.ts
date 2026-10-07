import { parseArgs } from "node:util";
import type { IndexStatus } from "@code-embed/protocol";
import { NoIndexError } from "../../errors";
import { indexDirFor } from "../../server/index-dir";
import { openForCli, resolveRoot } from "../open";
import { EXIT, type CommandRun } from "../types";

function render(s: IndexStatus): string {
  const pct = s.chunks === 0 ? 0 : Math.round((s.embedded / s.chunks) * 100);
  const sends = s.remote
    ? `external host ${s.host ?? "unknown"}`
    : s.provider === "local"
      ? "local (nothing leaves this machine)"
      : "local network (loopback)";
  const lines = [
    `root:       ${s.root}`,
    `index:      ${s.indexDir}`,
    `model:      ${s.model ?? "-"}`,
    `provider:   ${s.provider}`,
    `embeddings: ${sends}`,
    `files:      ${s.files}`,
    `chunks:     ${s.chunks}`,
    `vectors:    ${s.embedded}/${s.chunks} (${pct}%)`,
    `phase:      ${s.phase}${s.lexicalOnly ? " (lexical only)" : ""}`,
    `daemon:     ${s.daemon ? "running" : "not running"}`,
  ];
  if (s.readOnly) lines.push("mode:       read-only");
  if (s.consentRequired) lines.push(`consent:    required for ${s.consentRequired.host}`);
  if (s.lastError) lines.push(`last error: ${s.lastError}`);
  return lines.join("\n") + "\n";
}

export const run: CommandRun = async (argv, io) => {
  try {
    const { values } = parseArgs({
      args: argv,
      options: {
        json: { type: "boolean" },
        root: { type: "string" },
        provider: { type: "string" },
        model: { type: "string" },
      },
      strict: true,
    });
    let status: IndexStatus;
    try {
      const { opened } = await openForCli(io, values, { readonly: true });
      try {
        status = await opened.api.status();
        status.daemon = opened.viaDaemon;
      } finally {
        await opened.close();
      }
    } catch (err) {
      if (!(err instanceof NoIndexError)) throw err;
      const root = resolveRoot(io, values);
      status = {
        root,
        indexDir: indexDirFor(root),
        files: 0,
        chunks: 0,
        embedded: 0,
        phase: "idle",
        model: null,
        provider: values.provider ?? "local",
        remote: false,
        lexicalOnly: false,
        readOnly: false,
        daemon: false,
        lastError: "no index found; run `code-embed index`",
      };
    }
    io.stdout.write(values.json ? JSON.stringify(status) + "\n" : render(status));
    return EXIT.OK;
  } catch (err) {
    io.stderr.write(`code-embed: ${err instanceof Error ? err.message : String(err)}\n`);
    return EXIT.ERROR;
  }
};
