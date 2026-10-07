import { rm } from "node:fs/promises";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { socketPath } from "../../core/paths";
import { probeSocket } from "../../server/client";
import { indexDirFor } from "../../server/index-dir";
import { initHashing } from "../../util/hash";
import { resolveRoot } from "../open";
import { EXIT, type CliIO, type CommandRun } from "../types";

async function confirm(io: CliIO, question: string): Promise<boolean> {
  io.stderr.write(`${question} [y/N] `);
  const rl = createInterface({ input: io.stdin, terminal: false });
  try {
    const answer = await new Promise<string>((resolve) => {
      rl.once("line", resolve);
      rl.once("close", () => resolve(""));
    });
    return /^(y|yes)$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

export const run: CommandRun = async (argv, io) => {
  try {
    const { values } = parseArgs({
      args: argv,
      options: { yes: { type: "boolean", short: "y" }, root: { type: "string" } },
      strict: true,
    });
    const root = resolveRoot(io, values);
    await initHashing();
    const socket = await probeSocket(socketPath(root), 200);
    if (socket) {
      socket.destroy();
      io.stderr.write("code-embed: a daemon is running for this project; run `code-embed stop` first\n");
      return EXIT.ERROR;
    }
    const dir = indexDirFor(root);
    if (!values.yes) {
      if (!io.isTTY) {
        io.stderr.write("code-embed: refusing to delete the index without confirmation; pass --yes\n");
        return EXIT.ERROR;
      }
      if (!(await confirm(io, `Delete index ${dir}?`))) {
        io.stderr.write("code-embed: aborted\n");
        return EXIT.ERROR;
      }
    }
    await rm(dir, { recursive: true, force: true });
    io.stdout.write(`removed ${dir}\n`);
    return EXIT.OK;
  } catch (err) {
    io.stderr.write(`code-embed: ${err instanceof Error ? err.message : String(err)}\n`);
    return EXIT.ERROR;
  }
};
