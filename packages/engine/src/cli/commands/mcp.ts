import { resolve } from "node:path";
import { findProjectRoot } from "../../core/root";
import { runMcpServer } from "../../mcp/server";
import { EXIT, type CommandRun } from "../types";

export const run: CommandRun = async (argv, io) => {
  let root: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--root") {
      root = argv[++i];
      if (!root) {
        io.stderr.write("code-embed mcp: --root requires a directory\n");
        return EXIT.ERROR;
      }
    } else if (a.startsWith("--root=") && a.length > "--root=".length) {
      root = a.slice("--root=".length);
    } else {
      io.stderr.write(`code-embed mcp: unknown argument ${a}\n`);
      return EXIT.ERROR;
    }
  }
  await runMcpServer({
    root: root ? resolve(io.cwd, root) : findProjectRoot(io.cwd),
    input: io.stdin,
    output: io.stdout,
  });
  return EXIT.OK;
};
