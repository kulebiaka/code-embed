import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { openForCli } from "../open";
import { EXIT, type CommandRun } from "../types";

export const run: CommandRun = async (argv, io) => {
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      options: {
        root: { type: "string" },
        provider: { type: "string" },
        model: { type: "string" },
      },
      allowPositionals: true,
      strict: true,
    });
    if (positionals.length !== 1) throw new Error("usage: code-embed import <FILE>");
    const { opened } = await openForCli(io, values, { preferDaemon: false });
    try {
      const { count } = await opened.local!.importVectors(resolve(io.cwd, positionals[0]!));
      io.stdout.write(`imported ${count} vectors\n`);
      return EXIT.OK;
    } finally {
      await opened.close();
    }
  } catch (err) {
    io.stderr.write(`code-embed: ${err instanceof Error ? err.message : String(err)}\n`);
    return EXIT.ERROR;
  }
};
