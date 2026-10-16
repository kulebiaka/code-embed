import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createVectorSlot } from "./slot";

let dir: string;

beforeEach(() => {
  dir = join(mkdtempSync(join(tmpdir(), "ce-slot-")), "vector-slot");
});
afterEach(() => {
  rmSync(join(dir, ".."), { recursive: true, force: true });
});

describe("vector slot", () => {
  it("has a single holder until it is released", () => {
    const a = createVectorSlot(dir);
    const b = createVectorSlot(dir);
    expect(a.tryAcquire(true)).toBe(true);
    expect(a.tryAcquire(true)).toBe(true);
    expect(b.tryAcquire(true)).toBe(false);
    a.release();
    expect(b.tryAcquire(true)).toBe(true);
  });

  it("lets an active waiter go before a background one", () => {
    const holder = createVectorSlot(dir);
    const background = createVectorSlot(dir);
    const active = createVectorSlot(dir);
    holder.tryAcquire(true);
    expect(background.tryAcquire(false)).toBe(false);
    expect(active.tryAcquire(true)).toBe(false);
    holder.release();
    expect(background.tryAcquire(false)).toBe(false);
    expect(active.tryAcquire(true)).toBe(true);
    active.release();
    expect(background.tryAcquire(false)).toBe(true);
  });

  it("asks a background holder to yield to an active waiter", () => {
    const holder = createVectorSlot(dir);
    const waiter = createVectorSlot(dir);
    holder.tryAcquire(false);
    waiter.tryAcquire(false);
    expect(holder.shouldYield(false)).toBe(false);
    waiter.tryAcquire(true);
    expect(holder.shouldYield(false)).toBe(true);
    expect(holder.shouldYield(true)).toBe(false);
    waiter.release();
    expect(holder.shouldYield(false)).toBe(false);
  });

  it("takes over the slot and ignores waiters of dead processes", () => {
    const dead = spawnSync(process.execPath, ["-e", ""]).pid;
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "holder"), `${dead}-1`);
    writeFileSync(join(dir, `wait-${dead}-2`), "1");
    const slot = createVectorSlot(dir);
    expect(slot.tryAcquire(false)).toBe(true);
  });
});
