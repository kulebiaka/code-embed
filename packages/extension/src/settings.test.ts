import { afterEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { readEngineSettings, workspaceRoot } from "./settings";

function mockConfig(sections: Record<string, Record<string, unknown>>) {
  vi.spyOn(vscode.workspace, "getConfiguration").mockImplementation(((section: string) => ({
    get: (key: string) => sections[section]?.[key],
  })) as never);
}

afterEach(() => {
  vi.restoreAllMocks();
  (vscode.workspace as { workspaceFolders: unknown }).workspaceFolders = undefined;
});

describe("readEngineSettings", () => {
  it("maps codeEmbed.* and editor settings", () => {
    const providers = { p: { kind: "openai", base_url: "http://x/v1", model: "m" } };
    mockConfig({
      codeEmbed: {
        "index.location": "cache",
        "index.maxFileKb": 256,
        "index.threads": 2,
        "index.pauseOnBattery": true,
        "search.defaultMode": "lexical",
        "search.top": 7,
        "model.id": "m1",
        "model.offlineArchive": "/a.tar",
        providers,
        "embedding.provider": "p",
      },
      files: { exclude: { "**/.git": true, "**/keep": false } },
      search: { exclude: { "**/dist": true, "**/.git": true } },
      http: { proxy: "http://proxy:3128" },
    });
    expect(readEngineSettings()).toEqual({
      index: {
        location: "cache",
        maxFileKb: 256,
        threads: 2,
        pauseOnBattery: true,
        exclude: ["**/.git", "**/dist"],
      },
      search: { defaultMode: "lexical", top: 7 },
      model: { id: "m1", offlineArchive: "/a.tar" },
      embedding: { provider: "p" },
      providers,
      proxy: "http://proxy:3128",
    });
  });

  it("omits empty values", () => {
    mockConfig({ codeEmbed: { "model.offlineArchive": "", providers: {} }, http: { proxy: "" } });
    const s = readEngineSettings();
    expect(s.model?.offlineArchive).toBeUndefined();
    expect(s.providers).toBeUndefined();
    expect(s.proxy).toBeUndefined();
    expect(s.index?.exclude).toEqual([]);
  });
});

describe("workspaceRoot", () => {
  it("returns first folder fsPath", () => {
    (vscode.workspace as { workspaceFolders: unknown }).workspaceFolders = [{ uri: vscode.Uri.file("/w/a") }];
    expect(workspaceRoot()).toBe("/w/a");
  });
  it("is undefined without folders", () => {
    expect(workspaceRoot()).toBeUndefined();
  });
});
