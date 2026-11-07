import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { initChunker } from "./index";
import { REF_LANGS, refQuerySource } from "./tags";
import { chunkWithTreeSitter } from "./treesitter";
import type { ChunkOptions, Ref } from "./types";

const opts: ChunkOptions = { maxTokens: 400, overlapRatio: 0.15, countTokens: (s) => Math.ceil(s.length / 4) };
const fixture = (p: string) => readFileSync(join(__dirname, "../../test/fixtures/sample-repo", p), "utf8");
const refsOf = async (lang: string, code: string) => (await chunkWithTreeSitter(lang, code, opts)).refs;
const has = (refs: Ref[], kind: string, name: string, module?: string) =>
  refs.some((r) => r.kind === kind && r.name === name && (module === undefined || r.module === module));

beforeAll(async () => {
  await initChunker();
});

describe("refQuerySource", () => {
  it("covers four languages", () => {
    expect([...REF_LANGS].sort()).toEqual(["javascript", "python", "tsx", "typescript"]);
    for (const l of REF_LANGS) expect(refQuerySource(l)).toContain("@ref.call");
    expect(refQuerySource("go")).toBeNull();
  });
});

describe("ref extraction", () => {
  const TS = `import { a as b, c } from "./x";
import d from "pkg";
import * as ns from "../y";
interface I extends Base { m(): Foo }
class K extends P implements I {
  run(p: Payment): Promise<Result> { helper(p); this.svc.go(); return new Thing(); }
}
`;

  for (const lang of ["typescript", "tsx"]) {
    it(`${lang}: calls, types, imports`, async () => {
      const refs = await refsOf(lang, TS);
      for (const n of ["helper", "go", "Thing"]) expect(has(refs, "call", n), n).toBe(true);
      for (const n of ["Payment", "Result", "Promise", "Foo", "Base", "I"]) expect(has(refs, "type", n), n).toBe(true);
      expect(has(refs, "import", "a", "./x")).toBe(true);
      expect(has(refs, "import", "c", "./x")).toBe(true);
      expect(has(refs, "import", "d", "pkg")).toBe(true);
      expect(has(refs, "import", "ns", "../y")).toBe(true);
      expect(refs.find((r) => r.name === "helper")!.line).toBe(6);
      expect(has(refs, "type", "K")).toBe(false);
    });
  }

  it("javascript: calls and imports, no types", async () => {
    const refs = await refsOf("javascript", `import { f } from "./x";\nclass A { m() { f(); this.o.g(); } }\n`);
    expect(has(refs, "call", "f")).toBe(true);
    expect(has(refs, "call", "g")).toBe(true);
    expect(has(refs, "import", "f", "./x")).toBe(true);
    expect(refs.some((r) => r.kind === "type")).toBe(false);
  });

  it("python: calls and imports", async () => {
    const refs = await refsOf(
      "python",
      "import pkg.mod\nimport os as o\nfrom .x import y\nfrom pkg.mod import z as w\nfrom . import q\n\ndef f():\n    y()\n    o.getcwd()\n",
    );
    expect(has(refs, "call", "y")).toBe(true);
    expect(has(refs, "call", "getcwd")).toBe(true);
    expect(has(refs, "import", "pkg.mod", "pkg.mod")).toBe(true);
    expect(has(refs, "import", "os", "os")).toBe(true);
    expect(has(refs, "import", "y", ".x")).toBe(true);
    expect(has(refs, "import", "z", "pkg.mod")).toBe(true);
    expect(has(refs, "import", "q", ".")).toBe(true);
    expect(refs.find((r) => r.name === "getcwd")!.line).toBe(9);
  });

  it("sample-repo refund.ts", async () => {
    const refs = await refsOf("typescript", fixture("src/payment/refund.ts"));
    expect(has(refs, "call", "validateRefundRequest")).toBe(true);
    expect(has(refs, "call", "calculateRefundAmount")).toBe(true);
    expect(has(refs, "call", "refund")).toBe(true);
    expect(has(refs, "type", "RefundRequest")).toBe(true);
    expect(has(refs, "type", "PaymentGateway")).toBe(true);
  });

  it("sample-repo parse_config.py", async () => {
    const refs = await refsOf("python", fixture("src/utils/parse_config.py"));
    expect(has(refs, "call", "read_config_file")).toBe(true);
    expect(has(refs, "call", "validate_config")).toBe(true);
    expect(has(refs, "import", "json", "json")).toBe(true);
    expect(has(refs, "import", "dataclass", "dataclasses")).toBe(true);
  });

  it("byte of a ref lies inside its chunk on non-ASCII text", async () => {
    const code = `// привет, мир ✓\nexport function a() { return "é€"; }\n// ещё\nexport function b() { target(); }\n`;
    const { chunks, refs } = await chunkWithTreeSitter("typescript", code, opts);
    const ref = refs.find((r) => r.name === "target")!;
    expect(Buffer.from(code).subarray(ref.byte, ref.byte + 6).toString()).toBe("target");
    const owner = chunks.find((c) => c.startByte <= ref.byte && ref.byte < c.endByte);
    expect(owner?.symbol).toBe("b");
  });
});
