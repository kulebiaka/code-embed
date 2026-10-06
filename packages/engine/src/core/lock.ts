import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LOCK_FILE } from "./index-dir";

export interface LockHandle {
  pid: number;
  release(): void;
}

export function readLockPid(dir: string): number | null {
  try {
    const pid = Number.parseInt(readFileSync(join(dir, LOCK_FILE), "utf8").trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function acquireLock(dir: string): LockHandle | null {
  const file = join(dir, LOCK_FILE);
  const pid = process.pid;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(file, String(pid), { flag: "wx" });
      return {
        pid,
        release() {
          if (readLockPid(dir) === pid) rmSync(file, { force: true });
        },
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const holder = readLockPid(dir);
      if (holder !== null && holder !== pid && isProcessAlive(holder)) return null;
      rmSync(file, { force: true });
    }
  }
  return null;
}
