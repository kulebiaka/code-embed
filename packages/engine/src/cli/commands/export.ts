import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { openForCli } from "../open";
import { EXIT, type CommandRun } from "../types";

export const run: CommandRun = async (argv, io) => {
  try {
    const { values } = parseArgs({
      args: argv,
      options: {
        out: { type: "string", short: "o" },
        root: { type: "string" },
        provider: { type: "string" },
        model: { type: "string" },
      },
      strict: true,
    });
    const { opened } = await openForCli(io, values, { preferDaemon: false, readonly: true });
    try {
      const file = resolve(io.cwd, values.out ?? "code-embed-vectors.gz");
      const { count } = await opened.local!.exportVectors(file);
      io.stdout.write(`exported ${count} vectors to ${file}\n`);
      return EXIT.OK;
    } finally {
      await opened.close();
    }
  } catch (err) {
    io.stderr.write(`code-embed: ${err instanceof Error ? err.message : String(err)}\n`);
    return EXIT.ERROR;
  }
};
