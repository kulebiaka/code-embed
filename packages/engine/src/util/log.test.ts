import { afterEach, describe, expect, it, vi } from "vitest";
import { log, setLogLevel, setLogSink, type LogLevel } from "./log";

describe("log", () => {
  afterEach(() => {
    setLogSink(null);
    setLogLevel("info");
    vi.restoreAllMocks();
  });

  it("writes to stderr only, with prefix", () => {
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    log.warn("disk is slow");
    expect(err).toHaveBeenCalledWith("[code-embed] warn: disk is slow\n");
    expect(out).not.toHaveBeenCalled();
  });

  it("filters by level and forwards to sink", () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const seen: [LogLevel, string][] = [];
    setLogSink((level, message) => seen.push([level, message]));
    log.debug("hidden");
    log.info("shown");
    setLogLevel("debug");
    log.debug("now shown");
    setLogLevel("error");
    log.warn("hidden again");
    log.error("boom");
    expect(seen).toEqual([
      ["info", "shown"],
      ["debug", "now shown"],
      ["error", "boom"],
    ]);
  });
});
