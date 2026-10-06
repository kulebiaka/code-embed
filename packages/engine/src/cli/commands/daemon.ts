import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { findProjectRoot } from "../../core/root";
import { socketPath } from "../../core/paths";
import { createLocalEngine } from "../../engine/service";
import { LockedError } from "../../errors";
import { runDaemon } from "../../server/daemon";
import { initHashing } from "../../util/hash";
import { log } from "../../util/log";
import { EXIT, type CommandRun } from "../types";

export const run: CommandRun = async (argv, io) => {
  const { values } = parseArgs({
    args: argv,
    options: {
      detach: { type: "boolean", default: false },
      root: { type: "string" },
      "print-socket": { type: "boolean", default: false },
    },
  });
  const root = values.root ? resolve(io.cwd, values.root) : findProjectRoot(io.cwd);

  if (values["print-socket"]) {
    await initHashing();
    io.stdout.write(`${socketPath(root)}\n`);
    return EXIT.OK;
  }

  try {
    await runDaemon({
      root,
      detach: values.detach,
      createEngine: (r) =>
        createLocalEngine({ root: r, clientName: "daemon", watch: true, vectorPhase: true }),
    });
    return EXIT.OK;
  } catch (err) {
    if (!(err instanceof LockedError)) log.error(err instanceof Error ? err.message : String(err));
    return EXIT.ERROR;
  }
};
