import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { Language, Parser } from "web-tree-sitter";
import { beforeAll, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const wasmDir = join(dirname(require.resolve("tree-sitter-wasms/package.json")), "out");

describe("tree-sitter grammars smoke", () => {
  beforeAll(async () => {
    await Parser.init();
  });

  it("parses TypeScript", async () => {
    const lang = await Language.load(join(wasmDir, "tree-sitter-typescript.wasm"));
    const parser = new Parser();
    parser.setLanguage(lang);
    const tree = parser.parse("export class PaymentService {\n  processPaymentRefund(id: string): void {}\n}\n");
    expect(tree?.rootNode.type).toBe("program");
    expect(tree?.rootNode.hasError).toBe(false);
    expect(tree?.rootNode.descendantsOfType("method_definition")).toHaveLength(1);
  });

  it("parses Python", async () => {
    const lang = await Language.load(join(wasmDir, "tree-sitter-python.wasm"));
    const parser = new Parser();
    parser.setLanguage(lang);
    const tree = parser.parse("def parse_config(path):\n    return {}\n");
    expect(tree?.rootNode.type).toBe("module");
    expect(tree?.rootNode.descendantsOfType("function_definition")).toHaveLength(1);
  });
});
