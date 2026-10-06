import { mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderConfig } from "@code-embed/protocol";

vi.mock("../core/paths", () => ({ configDir: () => process.env.CODE_EMBED_CONFIG_DIR as string }));

import { grantConsent, hasConsent } from "./consents";
import { loadProjectConfig, writeProjectConfig } from "./project";
import { resolveSettings } from "./resolve";
import { loadProviders, loadUserConfig, saveProvider } from "./user";

let root: string;
let cfgDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ce-root-"));
  cfgDir = mkdtempSync(join(tmpdir(), "ce-cfg-"));
  process.env.CODE_EMBED_CONFIG_DIR = cfgDir;
});

afterEach(() => {
  vi.restoreAllMocks();
});

const provider: ProviderConfig = { kind: "openai", base_url: "http://127.0.0.1:1/v1", model: "m", rpm: 10 };

describe("project config", () => {
  it("returns {} when file is missing", () => {
    expect(loadProjectConfig(root)).toEqual({});
  });

  it("reads all supported keys", () => {
    writeFileSync(
      join(root, ".code-embed.toml"),
      `exclude = ["a/**"]
[embedding]
provider = "x"
model = "m"
[index]
location = "cache"
max_file_kb = 100
[search]
default_mode = "lexical"
top = 5
`,
    );
    expect(loadProjectConfig(root)).toEqual({
      exclude: ["a/**"],
      embedding: { provider: "x", model: "m" },
      index: { location: "cache", max_file_kb: 100 },
      search: { default_mode: "lexical", top: 5 },
    });
  });

  it("reports key name and path on wrong type", () => {
    writeFileSync(join(root, ".code-embed.toml"), `[search]\ntop = "many"\n`);
    expect(() => loadProjectConfig(root)).toThrow(/search\.top.*\.code-embed\.toml|\.code-embed\.toml.*search\.top/);
  });

  it("warns on unknown key to stderr", () => {
    const spy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    writeFileSync(join(root, ".code-embed.toml"), `bogus = 1\n`);
    expect(loadProjectConfig(root)).toEqual({});
    expect(spy.mock.calls.join("")).toContain("bogus");
  });

  it("rejects base_url and keys in project file (R-42)", () => {
    writeFileSync(join(root, ".code-embed.toml"), `[embedding]\nprovider = "x"\nbase_url = "http://h"\n`);
    expect(() => loadProjectConfig(root)).toThrow(/embedding\.base_url/);
    writeFileSync(join(root, ".code-embed.toml"), `[embedding]\napi_key = "k"\n`);
    expect(() => loadProjectConfig(root)).toThrow(/embedding\.api_key/);
  });

  it("writes, merges and gitignores once", () => {
    writeProjectConfig(root, { embedding: { provider: "x" } });
    writeProjectConfig(root, { embedding: { model: "m" }, search: { top: 3 } });
    expect(loadProjectConfig(root)).toEqual({ embedding: { provider: "x", model: "m" }, search: { top: 3 } });
    expect(readFileSync(join(root, ".gitignore"), "utf8")).toBe(".code-embed.toml\n");
  });

  it("appends to an existing .gitignore without trailing newline", () => {
    writeFileSync(join(root, ".gitignore"), "node_modules");
    writeProjectConfig(root, { exclude: ["x"] });
    writeProjectConfig(root, { exclude: ["y"] });
    expect(readFileSync(join(root, ".gitignore"), "utf8")).toBe("node_modules\n.code-embed.toml\n");
  });
});

describe("user config and providers", () => {
  it("loads config.toml with user-only keys", () => {
    writeFileSync(join(cfgDir, "config.toml"), `[index]\nthreads = 3\npause_on_battery = true\n`);
    expect(loadUserConfig().index).toEqual({ threads: 3, pause_on_battery: true });
  });

  it("round-trips providers and rejects api_key", () => {
    expect(loadProviders()).toEqual({});
    saveProvider("a", provider);
    saveProvider("b", { ...provider, api_key_env: "KEY", dimensions: 8 });
    expect(Object.keys(loadProviders())).toEqual(["a", "b"]);
    expect(loadProviders().a).toEqual(provider);
    expect(() => saveProvider("c", { ...provider, api_key: "s" } as ProviderConfig)).toThrow(/api_key/);
    writeFileSync(join(cfgDir, "providers.toml"), `[d]\nkind = "openai"\nbase_url = "u"\nmodel = "m"\napi_key = "s"\n`);
    expect(() => loadProviders()).toThrow(/api_key/);
  });

  it("creates the config directory on save", () => {
    process.env.CODE_EMBED_CONFIG_DIR = join(cfgDir, "nested");
    saveProvider("a", provider);
    expect(loadProviders().a).toEqual(provider);
  });
});

describe("consents", () => {
  it("is idempotent and per root and host", () => {
    const other = mkdtempSync(join(tmpdir(), "ce-root2-"));
    expect(hasConsent(root, "api.example.com")).toBe(false);
    grantConsent(root, "api.example.com");
    grantConsent(root, "api.example.com");
    expect(hasConsent(root, "api.example.com")).toBe(true);
    expect(hasConsent(root, "other.example.com")).toBe(false);
    expect(hasConsent(other, "api.example.com")).toBe(false);
    const text = readFileSync(join(cfgDir, "consents.toml"), "utf8");
    expect(text.match(/host/g)).toHaveLength(1);
  });

  it("resolves symlinked roots to the same entry", () => {
    const link = join(mkdtempSync(join(tmpdir(), "ce-link-")), "l");
    symlinkSync(root, link);
    grantConsent(link, "h");
    expect(hasConsent(root, "h")).toBe(true);
  });
});

describe("resolveSettings", () => {
  it("applies defaults", () => {
    const s = resolveSettings({ project: {}, user: {} });
    expect(s).toMatchObject({
      indexLocation: "auto",
      maxFileKb: 512,
      searchTop: 20,
      searchMode: "hybrid",
      provider: "local",
      model: "qwen3-embedding-0.6b",
      threads: Math.max(1, Math.floor(availableParallelism() / 2)),
      pauseOnBattery: false,
      exclude: [],
      allowRemote: false,
      providers: {},
    });
  });

  const cases: [string, Parameters<typeof resolveSettings>[0], Record<string, unknown>][] = [
    [
      "cli beats project",
      { cli: { searchTop: 1 }, project: { search: { top: 2 } }, user: { search: { top: 4 } } },
      { searchTop: 1 },
    ],
    [
      "project beats editor and user",
      { project: { search: { top: 2 } }, editor: { search: { top: 3 } }, user: { search: { top: 4 } } },
      { searchTop: 2 },
    ],
    [
      "editor beats user",
      { project: {}, editor: { search: { top: 3 }, index: { threads: 7 } }, user: { search: { top: 4 }, index: { threads: 2 } } },
      { searchTop: 3, threads: 7 },
    ],
    ["user beats defaults", { project: {}, user: { index: { max_file_kb: 9, pause_on_battery: true } } }, { maxFileKb: 9, pauseOnBattery: true }],
    [
      "provider and model",
      { project: { embedding: { provider: "p" } }, editor: { embedding: { provider: "e" }, model: { id: "mm" } }, user: {} },
      { provider: "p", model: "mm" },
    ],
    [
      "location",
      { project: {}, editor: { index: { location: "project" } }, user: { index: { location: "cache" } } },
      { indexLocation: "project" },
    ],
    ["cli provider", { cli: { provider: "c" }, project: { embedding: { provider: "p" } }, user: {} }, { provider: "c" }],
    ["editor passthrough", { project: {}, editor: { proxy: "http://p", allowRemote: true, model: { offlineArchive: "/a" } }, user: {} }, { proxy: "http://p", allowRemote: true, offlineArchive: "/a" }],
  ];
  it.each(cases)("%s", (_n, src, expected) => {
    expect(resolveSettings(src)).toMatchObject(expected);
  });

  it("unions providers with editor winning by name", () => {
    saveProvider("a", provider);
    saveProvider("b", provider);
    const s = resolveSettings({
      project: {},
      user: {},
      editor: { providers: { b: { ...provider, model: "edited" }, c: provider } },
    });
    expect(Object.keys(s.providers).sort()).toEqual(["a", "b", "c"]);
    expect(s.providers.b?.model).toBe("edited");
  });
});
