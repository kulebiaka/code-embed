import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isProcessAlive } from "../core/lock";
import { cacheDir } from "../core/paths";

// One vector phase with a local model per machine; the holder file names it, wait-* files name the queue.
export interface VectorSlot {
  // Non-blocking. A background caller lets active waiters go first.
  tryAcquire(active: boolean): boolean;
  // A background holder gives the slot up as soon as an active process waits for it.
  shouldYield(active: boolean): boolean;
  release(): void;
}

const HOLDER = "holder";
const WAIT = "wait-";
let nextId = 0;

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

export function createVectorSlot(dir: string = join(cacheDir(), "vector-slot")): VectorSlot {
  const id = `${process.pid}-${++nextId}`;
  const holderFile = join(dir, HOLDER);
  const waitFile = join(dir, WAIT + id);
  let held = false;

  const alive = (tag: string) => {
    const pid = Number.parseInt(tag, 10);
    return pid === process.pid || (pid > 0 && isProcessAlive(pid));
  };

  const activeWaiter = (): boolean => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return false;
    }
    for (const name of names) {
      if (!name.startsWith(WAIT) || name === WAIT + id) continue;
      if (!alive(name.slice(WAIT.length))) {
        rmSync(join(dir, name), { force: true });
        continue;
      }
      if (readText(join(dir, name)) === "1") return true;
    }
    return false;
  };

  const claim = (): boolean => {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        writeFileSync(holderFile, id, { flag: "wx" });
        return true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
        const holder = readText(holderFile);
        if (holder === null) continue;
        // empty: the holder is between creating and writing the file
        if (holder === "" || alive(holder)) return false;
        rmSync(holderFile, { force: true });
      }
    }
    return false;
  };

  return {
    tryAcquire(active) {
      if (held) return true;
      mkdirSync(dir, { recursive: true });
      writeFileSync(waitFile, active ? "1" : "0");
      if (!active && activeWaiter()) return false;
      if (!claim()) return false;
      held = true;
      rmSync(waitFile, { force: true });
      return true;
    },
    shouldYield(active) {
      return held && !active && activeWaiter();
    },
    release() {
      if (held && readText(holderFile) === id) rmSync(holderFile, { force: true });
      held = false;
      rmSync(waitFile, { force: true });
    },
  };
}
