import { readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LOCK_FILE } from "./index-dir";

export interface LockHandle {
  pid: number;
  release(): void;
}

export function readLockPid(dir: string, name = LOCK_FILE): number | null {
  try {
    const pid = Number.parseInt(readFileSync(join(dir, name), "utf8").trim(), 10);
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

const FRESH_MS = 2000;

// an empty file: the holder is between creating it and writing its pid
function isBeingWritten(file: string): boolean {
  try {
    const st = statSync(file);
    return st.size === 0 && Date.now() - st.mtimeMs < FRESH_MS;
  } catch {
    return false;
  }
}

export function acquireLock(dir: string, name = LOCK_FILE): LockHandle | null {
  const file = join(dir, name);
  const pid = process.pid;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(file, String(pid), { flag: "wx" });
      return {
        pid,
        release() {
          if (readLockPid(dir, name) === pid) rmSync(file, { force: true });
        },
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const holder = readLockPid(dir, name);
      if (holder === null && isBeingWritten(file)) return null;
      if (holder !== null && holder !== pid && isProcessAlive(holder)) return null;
      rmSync(file, { force: true });
    }
  }
  return null;
}
