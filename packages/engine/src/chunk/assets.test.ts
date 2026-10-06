import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { grammarPath, grammarPathFrom } from "./assets";

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "ce-assets-"));
  dirs.push(d);
  return d;
};

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("grammarPath", () => {
  it("resolves from node_modules when running from sources", () => {
    const p = grammarPath("typescript");
    expect(basename(p)).toBe("tree-sitter-typescript.wasm");
    expect(existsSync(p)).toBe(true);
  });

  it("maps csharp to the c_sharp grammar", () => {
    expect(basename(grammarPath("csharp"))).toBe("tree-sitter-c_sharp.wasm");
  });

  it("prefers <dist>/grammars when bundled", () => {
    const dist = tmp();
    mkdirSync(join(dist, "grammars"));
    writeFileSync(join(dist, "grammars", "tree-sitter-go.wasm"), "");
    expect(grammarPathFrom("go", dist)).toBe(join(dist, "grammars", "tree-sitter-go.wasm"));
  });

  it("picks up grammars placed in packages/engine/grammars", () => {
    const pkg = tmp();
    mkdirSync(join(pkg, "grammars"));
    mkdirSync(join(pkg, "src", "chunk"), { recursive: true });
    writeFileSync(join(pkg, "grammars", "tree-sitter-rust.wasm"), "");
    expect(grammarPathFrom("rust", join(pkg, "src", "chunk"))).toBe(join(pkg, "grammars", "tree-sitter-rust.wasm"));
  });

  it("throws for unknown languages", () => {
    expect(() => grammarPath("cobol")).toThrow(/no grammar/);
  });
});
