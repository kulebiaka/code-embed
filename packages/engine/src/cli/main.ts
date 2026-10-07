import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SERVER_VERSION } from "../engine/service";
import { log } from "../util/log";
import { parseSearchArgs, USAGE } from "./args";
import { run as clean } from "./commands/clean";
import { run as daemon } from "./commands/daemon";
import { run as exportCmd } from "./commands/export";
import { run as gc } from "./commands/gc";
import { run as importCmd } from "./commands/import";
import { run as index } from "./commands/index-cmd";
import { run as mcp } from "./commands/mcp";
import { run as model } from "./commands/model";
import { run as provider } from "./commands/provider";
import { run as search } from "./commands/search";
import { run as serve } from "./commands/serve";
import { run as similar } from "./commands/similar";
import { run as status } from "./commands/status";
import { run as stop } from "./commands/stop";
import { EXIT, processIO, type CliIO, type CommandRun } from "./types";

const COMMANDS: Record<string, CommandRun> = {
  similar,
  index,
  status,
  daemon,
  stop,
  serve,
  mcp,
  model,
  gc,
  clean,
  provider,
  export: exportCmd,
  import: importCmd,
};

export async function main(argv: string[], io: CliIO): Promise<number> {
  const first = argv[0];
  if (first !== undefined && Object.hasOwn(COMMANDS, first)) {
    return COMMANDS[first]!(argv.slice(1), io);
  }
  if (first === undefined) {
    io.stderr.write(USAGE);
    return EXIT.ERROR;
  }
  try {
    const { flags } = parseSearchArgs(argv);
    if (flags.version) {
      io.stdout.write(`${SERVER_VERSION}\n`);
      return EXIT.OK;
    }
    if (flags.help) {
      io.stdout.write(USAGE);
      return EXIT.OK;
    }
  } catch {
    // reported by the search command with the same message
  }
  return search(argv, io);
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  Promise.resolve()
    .then(() => main(process.argv.slice(2), processIO()))
    .then(
      (code) => {
        process.exitCode = code;
      },
      (err: unknown) => {
        log.error(err instanceof Error ? err.message : String(err));
        process.exitCode = EXIT.ERROR;
      },
    );
}
