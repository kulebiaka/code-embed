import { mkdirSync, mkdtempSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PathChanges } from "./types";
import { createAggregator, startWatcher } from "./watcher";

let dir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "ce-watch-")));
});
afterEach(() => {
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

describe("aggregator", () => {
  const make = (onBatch: (c: PathChanges, m: boolean) => Promise<void>, massThreshold = 200) =>
    createAggregator({
      debounceMs: 500,
      massThreshold,
      isIgnored: (p) => p.includes("/ignored/"),
      onBatch,
    });

  it("aggregates events in one batch and reports deletions", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const a = join(dir, "a.ts");
    const b = join(dir, "b.ts");
    const gone = join(dir, "gone.ts");
    writeFileSync(a, "1");
    writeFileSync(b, "1");
    const batches: [PathChanges, boolean][] = [];
    const agg = make(async (c, m) => void batches.push([c, m]));
    agg.add("created", a);
    agg.add("changed", a);
    agg.add("changed", b);
    agg.add("deleted", gone);
    await vi.advanceTimersByTimeAsync(499);
    expect(batches).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(2);
    await agg.flush();
    expect(batches).toEqual([[{ created: [a], changed: [b], deleted: [gone] }, false]]);
  });

  it("ignores ignored paths", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const batches: PathChanges[] = [];
    const agg = make(async (c) => void batches.push(c));
    agg.add("changed", join(dir, "ignored", "x.ts"));
    await vi.advanceTimersByTimeAsync(1000);
    await agg.flush();
    expect(batches).toHaveLength(0);
  });

  it("flags mass changes above threshold", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const flags: boolean[] = [];
    const agg = make(async (_c, m) => void flags.push(m), 3);
    for (let i = 0; i < 4; i++) {
      const p = join(dir, `f${i}.ts`);
      writeFileSync(p, "x");
      agg.add("changed", p);
    }
    await vi.advanceTimersByTimeAsync(600);
    await agg.flush();
    const p = join(dir, "f0.ts");
    writeFileSync(p, "xyz");
    agg.add("changed", p);
    await vi.advanceTimersByTimeAsync(600);
    await agg.flush();
    expect(flags).toEqual([true, false]);
  });

  it("dedups repeated paths and unchanged files", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const p = join(dir, "a.ts");
    writeFileSync(p, "one");
    const batches: PathChanges[] = [];
    const agg = make(async (c) => void batches.push(c));
    agg.add("changed", p);
    agg.add("changed", p);
    await vi.advanceTimersByTimeAsync(600);
    await agg.flush();
    expect(batches).toHaveLength(1);
    expect(batches[0]?.changed).toEqual([p]);
    agg.add("changed", p);
    await vi.advanceTimersByTimeAsync(600);
    await agg.flush();
    expect(batches).toHaveLength(1);
    writeFileSync(p, "three!");
    agg.add("changed", p);
    await vi.advanceTimersByTimeAsync(600);
    await agg.flush();
    expect(batches).toHaveLength(2);
  });
});

describe("startWatcher", () => {
  it("reports create, update, delete; skips .code-embed", async () => {
    const indexDir = join(dir, ".code-embed");
    mkdirSync(indexDir);
    const batches: PathChanges[] = [];
    const w = await startWatcher({
      root: dir,
      indexDir,
      exclude: [],
      debounceMs: 100,
      onBatch: async (c) => void batches.push(c),
    });
    try {
      const f = join(dir, "x.ts");
      writeFileSync(join(indexDir, "index.db"), "z");
      writeFileSync(f, "a");
      await vi.waitFor(() => expect(batches.flatMap((b) => [...b.created, ...b.changed])).toContain(f), {
        timeout: 5000,
      });
      unlinkSync(f);
      await vi.waitFor(() => expect(batches.flatMap((b) => b.deleted)).toContain(f), { timeout: 5000 });
      const all = batches.flatMap((b) => [...b.created, ...b.changed, ...b.deleted]);
      expect(all.every((p) => !p.includes(".code-embed"))).toBe(true);

      const g = join(dir, "client.ts");
      writeFileSync(g, "c");
      w.notify({ created: [], changed: [g], deleted: [] });
      await vi.waitFor(() => expect(batches.flatMap((b) => [...b.created, ...b.changed])).toContain(g), {
        timeout: 5000,
      });
      await new Promise((r) => setTimeout(r, 400));
      const hits = batches.flatMap((b) => [...b.created, ...b.changed]).filter((p) => p === g);
      expect(hits).toHaveLength(1);
    } finally {
      await w.close();
    }
  });
});
