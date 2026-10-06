import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { log } from "../util/log";
import { EXIT, processIO, type CliIO } from "./types";

export function main(_argv: string[], _io: CliIO): Promise<number> {
  throw new Error("not implemented: cli/main.main");
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
