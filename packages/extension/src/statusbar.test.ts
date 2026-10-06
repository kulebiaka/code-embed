import type { IndexStatus } from "@code-embed/protocol";
import { describe, expect, it } from "vitest";
import { statusBarView } from "./statusbar";

const base: IndexStatus = {
  root: "/r",
  indexDir: "/r/.code-embed",
  files: 10,
  chunks: 200,
  embedded: 84,
  phase: "vector",
  model: "m",
  provider: "local",
  remote: false,
  lexicalOnly: false,
  readOnly: false,
  daemon: false,
};

describe("statusBarView", () => {
  it("idle local", () => {
    expect(statusBarView("ready", { ...base, phase: "idle" }).text).toBe("$(search) idle · local");
  });
  it("indexing percent", () => {
    expect(statusBarView("ready", base).text).toBe("$(search) indexing 42% · local");
  });
  it("lexical only", () => {
    expect(statusBarView("ready", { ...base, phase: "idle", lexicalOnly: true }).text).toContain("lexical only");
  });
  it("error from status and from client state", () => {
    expect(statusBarView("ready", { ...base, lastError: "boom" })).toMatchObject({ error: true });
    expect(statusBarView("failed", undefined)).toMatchObject({ error: true });
  });
  it("shows remote host", () => {
    const v = statusBarView("ready", { ...base, phase: "idle", remote: true, host: "api.x.com", provider: "x" });
    expect(v.text).toBe("$(search) idle · api.x.com");
    expect(v.tooltip).toContain("sent to api.x.com");
  });
});
