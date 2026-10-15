import {
  FIND_SIMILAR_TOOL_DESCRIPTION,
  SEARCH_TOOL_DESCRIPTION,
  findSimilarToolInputSchema,
  searchToolInputSchema,
} from "@code-embed/protocol";
import { describe, expect, it } from "vitest";
import manifest from "../package.json";

describe("extension manifest", () => {
  it("targets workspace host and stable LM/MCP APIs", () => {
    expect(manifest.extensionKind).toEqual(["workspace"]);
    expect(manifest.engines.vscode).toBe("^1.103.0");
    expect(manifest.main).toBe("./dist/extension.js");
    expect(manifest.activationEvents).toEqual(
      expect.arrayContaining(["onStartupFinished", "onView:codeEmbed.panel", "onCommand:codeEmbed.focus"]),
    );
  });

  it("contributes all commands", () => {
    const titles = Object.fromEntries(manifest.contributes.commands.map((c) => [c.command, `${c.category}: ${c.title}`]));
    expect(titles).toEqual({
      "codeEmbed.focus": "Code Embed: Focus",
      "codeEmbed.quickSearch": "Code Embed: Quick Search",
      "codeEmbed.findSimilar": "Code Embed: Find Similar Code",
      "codeEmbed.reindex": "Code Embed: Reindex Workspace",
      "codeEmbed.installCli": "Code Embed: Install CLI",
      "codeEmbed.copyMcpConfig": "Code Embed: Copy MCP Config",
      "codeEmbed.selectProvider": "Code Embed: Select Embedding Provider",
      "codeEmbed.selectModel": "Code Embed: Select Model",
      "codeEmbed.testProvider": "Code Embed: Test Provider",
      "codeEmbed.showLog": "Code Embed: Show Log",
      "codeEmbed.openSettings": "Code Embed: Open Settings",
      "codeEmbed.clearResults": "Code Embed: Clear Results",
    });
    expect(manifest.contributes.keybindings).toEqual([{ command: "codeEmbed.focus", key: "ctrl+alt+f", mac: "cmd+alt+f" }]);
    expect(manifest.contributes.menus["editor/context"]).toEqual([
      expect.objectContaining({ command: "codeEmbed.findSimilar", when: "editorHasSelection" }),
    ]);
    expect(manifest.contributes.menus["view/title"].map((m) => [m.command, m.when])).toEqual([
      ["codeEmbed.reindex", "view == codeEmbed.panel"],
      ["codeEmbed.clearResults", "view == codeEmbed.panel"],
      ["codeEmbed.openSettings", "view == codeEmbed.panel"],
    ]);
  });

  it("contributes all settings grouped into categories", () => {
    const categories = manifest.contributes.configuration;
    expect(categories.map((c) => c.title)).toEqual(["Embeddings", "Local Model", "Index", "Search"]);
    expect(categories.flatMap((c) => Object.keys(c.properties)).sort()).toEqual(
      [
        "codeEmbed.index.location",
        "codeEmbed.index.maxFileKb",
        "codeEmbed.index.threads",
        "codeEmbed.index.pauseOnBattery",
        "codeEmbed.search.defaultMode",
        "codeEmbed.search.top",
        "codeEmbed.model.id",
        "codeEmbed.model.offlineArchive",
        "codeEmbed.providers",
        "codeEmbed.embedding.provider",
      ].sort(),
    );
  });

  it("declares LM tools verbatim from the protocol package", () => {
    const [search, similar] = manifest.contributes.languageModelTools;
    expect(search).toMatchObject({ name: "code-embed_search", toolReferenceName: "semsearch", canBeReferencedInPrompt: true });
    expect(similar).toMatchObject({ name: "code-embed_find_similar", toolReferenceName: "similar", canBeReferencedInPrompt: true });
    expect(search!.modelDescription).toBe(SEARCH_TOOL_DESCRIPTION);
    expect(similar!.modelDescription).toBe(FIND_SIMILAR_TOOL_DESCRIPTION);
    expect(search!.inputSchema).toEqual(searchToolInputSchema);
    expect(similar!.inputSchema).toEqual(findSimilarToolInputSchema);
  });

  it("declares the MCP server definition provider", () => {
    expect(manifest.contributes.mcpServerDefinitionProviders).toEqual([{ id: "codeEmbed.mcp", label: "Code Embed" }]);
  });
});
