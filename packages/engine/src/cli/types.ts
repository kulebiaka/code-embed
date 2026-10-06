export interface CliIO {
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  stdin: NodeJS.ReadableStream;
  isTTY: boolean;
  stdoutIsTTY: boolean;
  env: NodeJS.ProcessEnv;
  cwd: string;
}

export type CommandRun = (argv: string[], io: CliIO) => Promise<number>;

export const EXIT = { OK: 0, NO_RESULTS: 1, ERROR: 2 } as const;

export function processIO(): CliIO {
  return {
    stdout: process.stdout,
    stderr: process.stderr,
    stdin: process.stdin,
    isTTY: Boolean(process.stdin.isTTY),
    stdoutIsTTY: Boolean(process.stdout.isTTY),
    env: process.env,
    cwd: process.cwd(),
  };
}
