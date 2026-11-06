import { formatReferencesForAgent } from "@code-embed/protocol";
import { parseSearchArgs, UsageError } from "../args";
import type { CommandRun } from "../types";
import { relativeToRoot, reportError, runTool } from "./outline";

export const run: CommandRun = async (argv, io) => {
  try {
    const { flags, positionals } = parseSearchArgs(argv, "path");
    if (positionals.length !== 1) throw new UsageError("usage: refs <SYMBOL> [--path PATH]");
    const symbol = positionals[0]!;
    const path = flags.path === undefined ? undefined : relativeToRoot(io, flags, flags.path);
    return await runTool(
      io,
      flags,
      (api) => api.references(path === undefined ? { symbol } : { symbol, path }),
      (r) => formatReferencesForAgent(r),
    );
  } catch (err) {
    return reportError(io, err);
  }
};
