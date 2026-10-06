import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { findProjectRoot } from "../../core/root";
import { stopDaemon } from "../../server/daemon";
import { EXIT, type CommandRun } from "../types";

export const run: CommandRun = async (argv, io) => {
  const { values } = parseArgs({ args: argv, options: { root: { type: "string" } } });
  const root = values.root ? resolve(io.cwd, values.root) : findProjectRoot(io.cwd);
  const stopped = await stopDaemon(root);
  io.stderr.write(stopped ? "daemon stopped\n" : "no daemon running\n");
  return EXIT.OK;
};
