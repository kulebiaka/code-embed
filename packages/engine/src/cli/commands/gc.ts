import { parseArgs } from "node:util";
import { openEmbCache } from "../../cache/embcache";
import { embCachePath } from "../../core/paths";
import { EXIT, type CommandRun } from "../types";

export const run: CommandRun = async (argv, io) => {
  try {
    const { values } = parseArgs({ args: argv, options: { days: { type: "string" } }, strict: true });
    const days = values.days === undefined ? 30 : Number(values.days);
    if (values.days !== undefined && (values.days.trim() === "" || !Number.isInteger(days) || days < 0)) {
      throw new Error(`--days expects an integer >= 0, got "${values.days}"`);
    }
    const cache = openEmbCache(embCachePath());
    try {
      io.stdout.write(`${cache.gc({ olderThanDays: days })}\n`);
    } finally {
      cache.close();
    }
    return EXIT.OK;
  } catch (err) {
    io.stderr.write(`code-embed: ${err instanceof Error ? err.message : String(err)}\n`);
    return EXIT.ERROR;
  }
};
