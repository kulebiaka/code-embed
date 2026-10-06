export interface LockHandle {
  pid: number;
  release(): void;
}

export function acquireLock(_dir: string): LockHandle | null {
  throw new Error("not implemented: core/lock.acquireLock");
}

export function readLockPid(_dir: string): number | null {
  throw new Error("not implemented: core/lock.readLockPid");
}

export function isProcessAlive(_pid: number): boolean {
  throw new Error("not implemented: core/lock.isProcessAlive");
}
