const assert = require("node:assert");
const vscode = require("vscode");

const ID = "code-embed.code-embed-vscode";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const COMMANDS = [
  "codeEmbed.focus",
  "codeEmbed.quickSearch",
  "codeEmbed.findSimilar",
  "codeEmbed.reindex",
  "codeEmbed.installCli",
  "codeEmbed.copyMcpConfig",
  "codeEmbed.selectProvider",
  "codeEmbed.selectModel",
  "codeEmbed.testProvider",
  "codeEmbed.showLog",
];

function extension() {
  const ext = vscode.extensions.getExtension(ID);
  assert.ok(ext, `extension ${ID} not found`);
  return ext;
}

describe("Code Embed in VS Code", function () {
  before(async () => {
    await extension().activate();
  });

  it("activates", () => {
    assert.strictEqual(extension().isActive, true);
  });

  it("is a workspace extension with the required activation events", () => {
    const pkg = extension().packageJSON;
    assert.deepStrictEqual(pkg.extensionKind, ["workspace"]);
    for (const e of ["onStartupFinished", "onView:codeEmbed.panel", "onCommand:codeEmbed.focus"]) {
      assert.ok(pkg.activationEvents.includes(e), e);
    }
  });

  it("registers all commands", async () => {
    const all = new Set(await vscode.commands.getCommands(true));
    for (const c of COMMANDS) assert.ok(all.has(c), `${c} is not registered`);
  });

  it("resolves the codeEmbed.panel view", async () => {
    await vscode.commands.executeCommand("codeEmbed.panel.focus");
    await vscode.commands.executeCommand("codeEmbed.focus");
  });

  it("registers language model tools from the manifest", () => {
    const names = vscode.lm.tools.map((t) => t.name);
    assert.ok(names.includes("code-embed_search"), names.join(","));
    assert.ok(names.includes("code-embed_find_similar"), names.join(","));
    const tools = extension().packageJSON.contributes.languageModelTools;
    assert.deepStrictEqual(tools.map((t) => t.toolReferenceName).sort(), ["semsearch", "similar"]);
    assert.ok(tools.every((t) => t.canBeReferencedInPrompt === true));
  });

  it("finds fixture code via vscode.lm.invokeTool after indexing", async function () {
    const deadline = Date.now() + 100000;
    let out = "";
    while (Date.now() < deadline) {
      const result = await vscode.lm.invokeTool(
        "code-embed_search",
        { input: { query: "refund payment", mode: "lexical" }, toolInvocationToken: undefined },
        new vscode.CancellationTokenSource().token,
      );
      out = result.content
        .filter((p) => p instanceof vscode.LanguageModelTextPart)
        .map((p) => p.value)
        .join("");
      if (out.includes("refund.ts")) break;
      // Electron of 1.101 on macOS rejects sharp's native binary (different Team ID); newer builds load it.
      if (process.platform === "darwin" && vscode.version.startsWith("1.101.") && out.includes("engine is failed")) {
        this.skip();
      }
      await sleep(1500);
    }
    assert.ok(out.includes("src/payment/refund.ts"), out);
  });

  it("copies valid MCP config to the clipboard", async () => {
    await vscode.env.clipboard.writeText("");
    await vscode.commands.executeCommand("codeEmbed.copyMcpConfig");
    const config = JSON.parse(await vscode.env.clipboard.readText());
    assert.ok(config.mcpServers && Object.keys(config.mcpServers).length > 0, JSON.stringify(config));
    const server = Object.values(config.mcpServers)[0];
    assert.strictEqual(typeof server.command, "string");
    assert.ok(Array.isArray(server.args));
  });

  it("declares the MCP server definition provider", () => {
    const providers = extension().packageJSON.contributes.mcpServerDefinitionProviders;
    assert.ok(providers.some((p) => p.id === "codeEmbed.mcp"));
  });
});
