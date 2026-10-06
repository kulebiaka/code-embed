import { afterEach, describe, expect, it, vi } from "vitest";

const getPassword = vi.fn<() => string | null>();
vi.mock("@napi-rs/keyring", () => ({
  Entry: class {
    constructor(
      public service: string,
      public name: string,
    ) {}
    getPassword() {
      return getPassword();
    }
  },
}));

import { resolveApiKey } from "./keys";

const cfg = { kind: "openai", base_url: "https://x", model: "m", api_key_env: "T019_KEY" } as const;

afterEach(() => {
  delete process.env.T019_KEY;
  getPassword.mockReset();
});

describe("resolveApiKey", () => {
  it("prefers client keys, then env, then keyring", async () => {
    process.env.T019_KEY = "env";
    getPassword.mockReturnValue("ring");
    expect(await resolveApiKey("p", cfg, { p: "client" })).toBe("client");
    expect(await resolveApiKey("p", cfg)).toBe("env");
    delete process.env.T019_KEY;
    expect(await resolveApiKey("p", cfg)).toBe("ring");
  });

  it("returns undefined when keyring throws or is empty", async () => {
    getPassword.mockImplementation(() => {
      throw new Error("no keychain");
    });
    expect(await resolveApiKey("p", cfg)).toBeUndefined();
    getPassword.mockReturnValue(null);
    expect(await resolveApiKey("p", cfg)).toBeUndefined();
  });
});
