import { PassThrough } from "node:stream";
import { EngineRpcError, ErrorCodes, type EngineApi } from "@code-embed/protocol";
import { describe, expect, it, vi } from "vitest";
import { ConsentRequiredError } from "../errors";
import { consentNeeded, withConsent } from "./consent";
import type { CliIO } from "./types";

function makeIO(isTTY: boolean, answer?: string) {
  const stdin = new PassThrough();
  const stderr = new PassThrough();
  const chunks: string[] = [];
  stderr.on("data", (c) => chunks.push(String(c)));
  if (answer !== undefined) stdin.end(answer + "\n");
  const io = { stdin, stderr, stdout: new PassThrough(), isTTY, stdoutIsTTY: isTTY, env: {}, cwd: "/" } as CliIO;
  return { io, err: () => chunks.join("") };
}

const grant = vi.fn(async () => {});
const api = { grantConsent: grant } as unknown as EngineApi;

describe("consent", () => {
  it("recognises local and rpc errors", () => {
    expect(consentNeeded(new ConsentRequiredError("h.example", "p"))).toEqual({ host: "h.example", provider: "p" });
    const rpc = new EngineRpcError(ErrorCodes.ConsentRequired, "x", { host: "r.example", provider: "q" });
    expect(consentNeeded(rpc)).toEqual({ host: "r.example", provider: "q" });
    expect(consentNeeded(new Error("x"))).toBeNull();
  });

  it("asks in a TTY, grants and retries", async () => {
    grant.mockClear();
    const { io, err } = makeIO(true, "y");
    let calls = 0;
    const out = await withConsent(io, api, async () => {
      if (calls++ === 0) throw new ConsentRequiredError("h.example", "p");
      return "ok";
    });
    expect(out).toBe("ok");
    expect(grant).toHaveBeenCalledWith({ host: "h.example" });
    expect(err()).toContain("Код будет отправлен на h.example. Разрешить? [y/N]");
  });

  it("declined answer returns null without granting", async () => {
    grant.mockClear();
    const { io } = makeIO(true, "n");
    const out = await withConsent(io, api, async () => {
      throw new ConsentRequiredError("h.example", "p");
    });
    expect(out).toBeNull();
    expect(grant).not.toHaveBeenCalled();
  });

  it("without a TTY prints the --allow-remote hint", async () => {
    const { io, err } = makeIO(false);
    const out = await withConsent(io, api, async () => {
      throw new ConsentRequiredError("h.example", "p");
    });
    expect(out).toBeNull();
    expect(err()).toContain("--allow-remote");
  });

  it("rethrows unrelated errors", async () => {
    const { io } = makeIO(true);
    await expect(
      withConsent(io, api, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
  });
});
