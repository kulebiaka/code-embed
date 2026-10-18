import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { grantConsent } from "../config/consents";
import { DEFAULTS, type EffectiveSettings } from "../config/types";
import { ConsentRequiredError } from "../errors";
import { FakeEmbedder } from "./fake";

vi.mock("./local", () => ({ createLocalEmbedder: vi.fn() }));
vi.mock("./worker", () => ({ createWorkerEmbedder: vi.fn() }));
vi.mock("./host-client", async (orig) => ({
  ...(await orig<typeof import("./host-client")>()),
  createHostEmbedder: vi.fn(),
}));
vi.mock("./openai", () => ({ createOpenAIEmbedder: vi.fn() }));
vi.mock("./keys", () => ({ resolveApiKey: vi.fn(async () => "k") }));

import { createHostEmbedder } from "./host-client";
import { resolveApiKey } from "./keys";
import { createLocalEmbedder } from "./local";
import { createOpenAIEmbedder } from "./openai";
import { createWorkerEmbedder } from "./worker";
import { describeProvider, isLoopbackUrl, resolveEmbedder } from "./registry";

function settings(over: Partial<EffectiveSettings> = {}): EffectiveSettings {
  return {
    indexLocation: "project",
    maxFileKb: 512,
    threads: 2,
    pauseOnBattery: false,
    exclude: [],
    searchMode: "hybrid",
    searchTop: 20,
    provider: "local",
    model: DEFAULTS.model,
    providers: {
      ext: { kind: "openai", base_url: "https://api.example.com/v1", model: "m" },
      loc: { kind: "openai", base_url: "http://127.0.0.1:8080/v1", model: "m" },
    },
    allowRemote: false,
    ...over,
  };
}

beforeEach(() => {
  process.env.CODE_EMBED_CONFIG_DIR = mkdtempSync(join(tmpdir(), "ce-reg-"));
  vi.mocked(createLocalEmbedder).mockReset();
  vi.mocked(createOpenAIEmbedder).mockReset();
  vi.mocked(createWorkerEmbedder).mockReset();
  vi.mocked(createHostEmbedder).mockReset();
});

afterEach(() => {
  delete process.env.CODE_EMBED_CONFIG_DIR;
  delete process.env.CODE_EMBED_FAKE_EMBEDDER;
  delete process.env.CODE_EMBED_FAKE_DIMS;
  delete process.env.CODE_EMBED_SHARED_HOST;
});

describe("isLoopbackUrl", () => {
  it.each([
    "http://localhost:1234/v1",
    "http://127.0.0.1/v1",
    "http://127.5.6.7:80",
    "http://[::1]:8080",
    "unix:/tmp/s.sock",
    "http+unix://%2Ftmp%2Fs.sock/v1",
  ])("%s is loopback", (u) => expect(isLoopbackUrl(u)).toBe(true));

  it.each(["https://api.openai.com/v1", "http://10.0.0.1", "http://localhost.evil.com", "nonsense"])(
    "%s is not loopback",
    (u) => expect(isLoopbackUrl(u)).toBe(false),
  );
});

describe("resolveEmbedder", () => {
  it.each([undefined, "0", ""])("runs transformer models in the inference worker when CODE_EMBED_SHARED_HOST is %j", async (v) => {
    if (v !== undefined) process.env.CODE_EMBED_SHARED_HOST = v;
    vi.mocked(createWorkerEmbedder).mockReturnValue(new FakeEmbedder());
    await resolveEmbedder({ root: "/p", settings: settings() });
    expect(vi.mocked(createWorkerEmbedder).mock.calls[0]![0].id).toBe(DEFAULTS.model);
    expect(createLocalEmbedder).not.toHaveBeenCalled();
    expect(createHostEmbedder).not.toHaveBeenCalled();
  });

  it("uses the shared inference host when CODE_EMBED_SHARED_HOST is 1", async () => {
    process.env.CODE_EMBED_SHARED_HOST = "1";
    vi.mocked(createHostEmbedder).mockReturnValue(new FakeEmbedder());
    await resolveEmbedder({ root: "/p", settings: settings() });
    expect(vi.mocked(createHostEmbedder).mock.calls[0]![0].id).toBe(DEFAULTS.model);
    expect(vi.mocked(createHostEmbedder).mock.calls[0]![2]).toEqual({ project: "/p" });
    expect(createWorkerEmbedder).not.toHaveBeenCalled();
  });

  it.each([undefined, "0", "1"])("keeps static models in process when CODE_EMBED_SHARED_HOST is %j", async (v) => {
    if (v !== undefined) process.env.CODE_EMBED_SHARED_HOST = v;
    vi.mocked(createLocalEmbedder).mockReturnValue(new FakeEmbedder());
    await resolveEmbedder({ root: "/p", settings: settings({ model: "potion-code-16m" }) });
    expect(vi.mocked(createLocalEmbedder).mock.calls[0]![0].id).toBe("potion-code-16m");
    expect(createWorkerEmbedder).not.toHaveBeenCalled();
    expect(createHostEmbedder).not.toHaveBeenCalled();
  });

  it("rejects external providers without consent", async () => {
    await expect(resolveEmbedder({ root: "/p", settings: settings({ provider: "ext" }) })).rejects.toMatchObject({
      name: "ConsentRequiredError",
      host: "api.example.com",
      provider: "ext",
    });
    expect(createOpenAIEmbedder).not.toHaveBeenCalled();
  });

  it("allows external providers with stored consent or allowRemote", async () => {
    vi.mocked(createOpenAIEmbedder).mockReturnValue(new FakeEmbedder());
    const root = mkdtempSync(join(tmpdir(), "ce-root-"));
    await expect(resolveEmbedder({ root, settings: settings({ provider: "ext" }) })).rejects.toBeInstanceOf(
      ConsentRequiredError,
    );
    await resolveEmbedder({ root, settings: settings({ provider: "ext", allowRemote: true }) });
    await expect(resolveEmbedder({ root, settings: settings({ provider: "ext" }) })).rejects.toBeInstanceOf(
      ConsentRequiredError,
    );
    grantConsent(root, "api.example.com");
    await resolveEmbedder({ root, settings: settings({ provider: "ext" }), apiKeys: { ext: "z" } });
    expect(resolveApiKey).toHaveBeenCalledWith("ext", expect.anything(), { ext: "z" });
    expect(vi.mocked(createOpenAIEmbedder).mock.calls.at(-1)![0]).toMatchObject({ name: "ext", apiKey: "k" });
  });

  it("uses loopback providers without consent", async () => {
    vi.mocked(createOpenAIEmbedder).mockReturnValue(new FakeEmbedder());
    await resolveEmbedder({ root: "/p", settings: settings({ provider: "loc" }) });
    expect(createOpenAIEmbedder).toHaveBeenCalled();
  });

  it("lists known providers for unknown names", async () => {
    await expect(resolveEmbedder({ root: "/p", settings: settings({ provider: "nope" }) })).rejects.toThrow(
      /nope.*local, ext, loc/,
    );
  });

  it("returns FakeEmbedder under CODE_EMBED_FAKE_EMBEDDER", async () => {
    process.env.CODE_EMBED_FAKE_EMBEDDER = "1";
    expect((await resolveEmbedder({ root: "/p", settings: settings() })).info.dims).toBe(64);
    process.env.CODE_EMBED_FAKE_DIMS = "16";
    const e = await resolveEmbedder({ root: "/p", settings: settings({ provider: "ext" }) });
    expect(e.info.dims).toBe(16);
    expect(e.info.modelId).toBe("fake/fake@16");
  });
});

describe("describeProvider", () => {
  it("reports where embeddings go", () => {
    expect(describeProvider(settings())).toEqual({ provider: "local", remote: false });
    expect(describeProvider(settings({ provider: "loc" }))).toEqual({ provider: "loc", remote: false });
    expect(describeProvider(settings({ provider: "ext" }))).toEqual({
      provider: "ext",
      remote: true,
      host: "api.example.com",
    });
  });
});
