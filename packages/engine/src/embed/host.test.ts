import { beforeAll, describe, expect, it } from "vitest";
import { initHashing } from "../util/hash";
import { createBatchQueue, decodeVector, encodeVector, hostKey, type HostClient } from "./host";

const client = (active = true): HostClient => ({ active, served: 0 });

function deferred() {
  let resolve!: () => void;
  const p = new Promise<void>((r) => (resolve = r));
  return { p, resolve };
}

describe("createBatchQueue", () => {
  it("runs one task at a time", async () => {
    const q = createBatchQueue();
    const a = client();
    const gate = deferred();
    let running = 0;
    let peak = 0;
    const task = async () => {
      running++;
      peak = Math.max(peak, running);
      await gate.p;
      running--;
    };
    const all = Promise.all([q.run(a, task), q.run(a, task), q.run(client(), task)]);
    gate.resolve();
    await all;
    expect(peak).toBe(1);
  });

  it("interleaves clients round-robin", async () => {
    const q = createBatchQueue();
    const a = client();
    const b = client();
    const order: string[] = [];
    const gate = deferred();
    const task = (name: string, wait?: Promise<void>) => async () => {
      if (wait) await wait;
      order.push(name);
    };
    const all = Promise.all([
      q.run(a, task("a1", gate.p)),
      q.run(a, task("a2")),
      q.run(a, task("a3")),
      q.run(b, task("b1")),
      q.run(b, task("b2")),
    ]);
    gate.resolve();
    await all;
    expect(order).toEqual(["a1", "b1", "a2", "b2", "a3"]);
  });

  it("serves active clients before background ones", async () => {
    const q = createBatchQueue();
    const bg = client(false);
    const fg = client(true);
    const order: string[] = [];
    const gate = deferred();
    const task = (name: string, wait?: Promise<void>) => async () => {
      if (wait) await wait;
      order.push(name);
    };
    const all = Promise.all([
      q.run(bg, task("bg1", gate.p)),
      q.run(bg, task("bg2")),
      q.run(fg, task("fg1")),
      q.run(fg, task("fg2")),
    ]);
    gate.resolve();
    await all;
    expect(order).toEqual(["bg1", "fg1", "fg2", "bg2"]);
  });

  it("drops a queued task on abort and keeps going", async () => {
    const q = createBatchQueue();
    const a = client();
    const gate = deferred();
    const ac = new AbortController();
    const ran: string[] = [];
    const first = q.run(a, async () => {
      await gate.p;
      ran.push("first");
    });
    const dropped = q.run(a, async () => void ran.push("dropped"), ac.signal);
    const last = q.run(a, async () => void ran.push("last"));
    ac.abort(new Error("stop"));
    await expect(dropped).rejects.toThrow("stop");
    gate.resolve();
    await Promise.all([first, last]);
    expect(ran).toEqual(["first", "last"]);
  });

  it("propagates task errors without stalling the queue", async () => {
    const q = createBatchQueue();
    const a = client();
    await expect(q.run(a, async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    await expect(q.run(a, async () => 42)).resolves.toBe(42);
  });
});

describe("vector encoding", () => {
  it("round-trips vectors, including views into larger buffers", () => {
    const v = new Float32Array([0.5, -1.25, 3e-8, 1]);
    expect(Array.from(decodeVector(encodeVector(v)))).toEqual(Array.from(v));
    const big = new Float32Array([9, 9, 0.25, -0.75, 9]);
    const view = big.subarray(2, 4);
    expect(Array.from(decodeVector(encodeVector(view)))).toEqual([0.25, -0.75]);
  });
});

describe("hostKey", () => {
  beforeAll(() => initHashing());

  it("differs by model and threads", () => {
    const base = { model: "m", opts: { modelsDir: "/m", threads: 2 } };
    const key = hostKey(base);
    expect(hostKey({ ...base })).toBe(key);
    expect(hostKey({ ...base, opts: { ...base.opts, threads: 4 } })).not.toBe(key);
    expect(hostKey({ ...base, model: "other" })).not.toBe(key);
  });
});
