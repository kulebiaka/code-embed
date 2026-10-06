import { describe, expect, it } from "vitest";
import { aggregate, exitCode, lastJsonLine, minVersionFromRange, runCheck, type CheckResult } from "./report";

const info = { node: "22.14.0", platform: "linux", arch: "x64" };
const res = (name: string, required: boolean, status: CheckResult["status"]): CheckResult => ({
  name,
  required,
  status,
  ms: 1,
});

describe("aggregate", () => {
  it("is ok when only optional checks warn", () => {
    const r = aggregate(info, [res("a", true, "pass"), res("keyring", false, "warn")]);
    expect(r.ok).toBe(true);
    expect(r.warnings).toEqual(["keyring"]);
    expect(exitCode([r])).toBe(0);
  });

  it("fails when a required check fails", () => {
    const r = aggregate(info, [res("a", true, "fail"), res("b", true, "pass")]);
    expect(r.ok).toBe(false);
    expect(r.failedRequired).toEqual(["a"]);
    expect(exitCode([r])).toBe(1);
  });

  it("exit code is non-zero if any report failed", () => {
    const ok = aggregate(info, [res("a", true, "pass")]);
    const bad = aggregate(info, [res("a", true, "fail")]);
    expect(exitCode([ok, bad])).toBe(1);
  });
});

describe("runCheck", () => {
  it("maps throw to fail for required and warn for optional", async () => {
    const boom = () => {
      throw new Error("boom");
    };
    expect((await runCheck("x", true, boom)).status).toBe("fail");
    const opt = await runCheck("x", false, boom);
    expect(opt.status).toBe("warn");
    expect(opt.error).toBe("boom");
  });

  it("captures detail of async checks", async () => {
    const r = await runCheck("x", true, async () => ({ v: 1 }));
    expect(r.status).toBe("pass");
    expect(r.detail).toEqual({ v: 1 });
  });
});

describe("helpers", () => {
  it("extracts the minimum version from a semver range", () => {
    expect(minVersionFromRange("^1.101.0")).toBe("1.101.0");
    expect(() => minVersionFromRange("latest")).toThrow();
  });

  it("parses the last JSON line, ignoring noise", () => {
    expect(lastJsonLine('warn\n{"a":1}\n{"b":2}\n')).toEqual({ b: 2 });
    expect(() => lastJsonLine("nothing")).toThrow();
  });
});
