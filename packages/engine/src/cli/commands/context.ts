import { formatContextForAgent, type ContextParams } from "@code-embed/protocol";
import { parseSearchArgs, UsageError } from "../args";
import type { CommandRun } from "../types";
import { relativeToRoot, reportError, runTool } from "./outline";

const LOCATION = /^(.+):(\d+)$/;

export const run: CommandRun = async (argv, io) => {
  try {
    const { flags, positionals } = parseSearchArgs(argv, "budget");
    if (positionals.length === 0) throw new UsageError('usage: context <PATH>:<LINE> | "<query>"');
    const budget = flags.budget === undefined ? {} : { budgetTokens: flags.budget };
    const m = positionals.length === 1 ? LOCATION.exec(positionals[0]!) : null;
    let params: ContextParams;
    if (m) {
      const line = Number(m[2]);
      if (line < 1) throw new UsageError(`invalid line ${line}`);
      params = { path: relativeToRoot(io, flags, m[1]!), line, ...budget };
    } else {
      params = { query: positionals.join(" "), ...budget };
    }
    return await runTool(io, flags, (api) => api.context(params), formatContextForAgent);
  } catch (err) {
    return reportError(io, err);
  }
};
