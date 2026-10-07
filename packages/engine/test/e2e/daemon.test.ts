import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeSandbox, parseJsonLines, sleep, waitUntil, type Sandbox } from "./helpers";

let sb: Sandbox;
beforeEach(() => {
  sb = makeSandbox();
});
afterEach(() => sb.cleanup());

const daemonRunning = async () => /daemon:\s+running/.test((await sb.run(["status"])).stdout);

describe("daemon (R-75, R-76, NR-07)", () => {
  it("serves searches, picks up edits within 2s, tolerates a second instance, stops", async () => {
    expect((await sb.run(["index"])).code).toBe(0);

    const start = await sb.run(["daemon", "--detach"]);
    expect(start.code).toBe(0);
    expect(await waitUntil(daemonRunning, 10000)).toBe(true);

    const status = await sb.run(["status"]);
    expect(status.stdout).toMatch(/daemon:\s+running/);

    const before = await sb.run(["--json", "refund", "payment"]);
    expect(before.code).toBe(0);

    await sleep(500);
    const marker = "zorblaxquuxmarker";
    appendFileSync(
      join(sb.root, "src/payment/refund.ts"),
      `\nexport function ${marker}(): number {\n  return 42;\n}\n`,
    );
    const t0 = Date.now();
    let seen = false;
    while (Date.now() - t0 < 2000 && !seen) {
      const r = await sb.run(["--json", "--no-update", marker]);
      seen = r.code === 0 && parseJsonLines(r.stdout).some((x) => String(x.snippet).includes(marker));
    }
    expect(seen).toBe(true);

    const second = await sb.run(["daemon"]);
    expect(second.code).toBe(2);

    const [s1, s2] = await Promise.all([
      sb.run(["--json", "--no-update", "refund"]),
      sb.run(["--json", "--no-update", "payment"]),
    ]);
    expect(s1.code).toBe(0);
    expect(s2.code).toBe(0);
    expect(await daemonRunning()).toBe(true);

    const after = await sb.run(["--json", "--no-update", marker]);
    expect(after.code).toBe(0);
    const other = await sb.run(["--json", "--no-update", "refund", "payment"]);
    expect(other.code).toBe(0);
    expect(parseJsonLines(other.stdout).length).toBeGreaterThan(0);

    const stopped = await sb.run(["stop"]);
    expect(stopped.stderr).toContain("daemon stopped");
    expect(await waitUntil(async () => !(await daemonRunning()), 5000)).toBe(true);

    const final = await sb.run(["--json", "--no-update", "refund", "payment"]);
    expect(final.code).toBe(0);
  });

  it("index through a live daemon succeeds and keeps the index intact", async () => {
    expect((await sb.run(["index"])).code).toBe(0);
    expect((await sb.run(["daemon", "--detach"])).code).toBe(0);
    expect(await waitUntil(daemonRunning, 10000)).toBe(true);
    const before = JSON.parse((await sb.run(["status", "--json"])).stdout);

    const idx = await sb.run(["index"]);
    expect(idx.stderr).not.toMatch(/error/i);
    expect(idx.code).toBe(0);

    const after = JSON.parse((await sb.run(["status", "--json"])).stdout);
    expect(after.chunks).toBe(before.chunks);
    expect(after.embedded).toBe(after.chunks);
    expect(after.daemon).toBe(true);
  });
});
