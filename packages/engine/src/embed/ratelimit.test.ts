import { describe, expect, it } from "vitest";
import { RateLimiter } from "./ratelimit";

function fakeClock() {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
    at: () => t,
  };
}

describe("RateLimiter", () => {
  it("does not wait without limits", async () => {
    const c = fakeClock();
    const rl = new RateLimiter({ now: c.now, sleep: c.sleep });
    for (let i = 0; i < 100; i++) await rl.acquire(1000);
    expect(c.at()).toBe(0);
  });

  it("spaces requests by rpm after the burst", async () => {
    const c = fakeClock();
    const rl = new RateLimiter({ rpm: 60, now: c.now, sleep: c.sleep });
    for (let i = 0; i < 60; i++) await rl.acquire(1);
    expect(c.at()).toBe(0);
    await rl.acquire(1);
    expect(c.at()).toBe(1000);
  });

  it("waits for tpm budget", async () => {
    const c = fakeClock();
    const rl = new RateLimiter({ tpm: 600, now: c.now, sleep: c.sleep });
    await rl.acquire(600);
    await rl.acquire(300);
    expect(c.at()).toBe(30_000);
  });

  it("caps oversized requests to bucket capacity", async () => {
    const c = fakeClock();
    const rl = new RateLimiter({ tpm: 100, now: c.now, sleep: c.sleep });
    await rl.acquire(10_000);
    expect(c.at()).toBe(0);
  });

  it("rejects when aborted", async () => {
    const rl = new RateLimiter({ rpm: 1 });
    await rl.acquire(1);
    const ac = new AbortController();
    const p = rl.acquire(1, ac.signal);
    ac.abort(new Error("stop"));
    await expect(p).rejects.toThrow("stop");
  });
});
