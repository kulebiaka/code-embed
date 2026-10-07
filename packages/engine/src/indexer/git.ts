import { execFile } from "node:child_process";

export function recentlyChangedPaths(root: string, days = 14): Promise<string[]> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["log", `--since=${days}.days`, "--name-only", "--relative", "--pretty=format:"],
      { cwd: root, maxBuffer: 64 * 1024 * 1024, timeout: 15_000 },
      (err, stdout) => {
        if (err) return resolve([]);
        const seen = new Set<string>();
        for (const line of stdout.split("\n")) if (line) seen.add(line);
        resolve([...seen]);
      },
    );
  });
}
