import { describe, expect, it } from "vitest";
import { chunkWithTreeSitter } from "./treesitter";
import type { Chunk, ChunkOptions } from "./types";

const opts = (maxTokens: number): ChunkOptions => ({
  maxTokens,
  overlapRatio: 0.15,
  countTokens: (s) => Math.ceil(s.length / 4),
});

interface Expected {
  kind: string;
  symbol: string | null;
  parentSymbol: string | null;
  startLine: number;
  endLine: number;
}

const e = (kind: string, symbol: string | null, parentSymbol: string | null, startLine: number, endLine: number): Expected => ({
  kind,
  symbol,
  parentSymbol,
  startLine,
  endLine,
});

const FRAGMENTS: { lang: string; code: string; expected: Expected[] }[] = [
  {
    lang: "typescript",
    code: `import { a } from "./a";\n\n// helper\nexport function helper(x: number): number {\n  return x + 1;\n}\n\nexport const arrow = (y: string) => y.trim();\n\nexport class PaymentService extends Base {\n  private count = 0;\n  // refund\n  processPaymentRefund(id: string): void {\n    this.count++;\n  }\n  async charge(amount: number): Promise<void> {\n    await send(amount);\n  }\n}\n\nexport interface Opts { a: number }\n`,
    expected: [
      e("module", null, null, 1, 1),
      e("function", "helper", null, 3, 6),
      e("function", "arrow", null, 8, 8),
      e("class", "PaymentService", null, 10, 19),
      e("method", "processPaymentRefund", "PaymentService", 12, 15),
      e("method", "charge", "PaymentService", 16, 18),
      e("class", "Opts", null, 21, 21),
    ],
  },
  {
    lang: "tsx",
    code: `import React from "react";\n\nexport function Button(p: P) {\n  return <b>{p.x}</b>;\n}\n\nexport class Panel extends React.Component {\n  render() {\n    return <div>{this.props.children}</div>;\n  }\n  componentDidMount() {\n    console.log("mounted panel");\n  }\n}\n`,
    expected: [
      e("module", null, null, 1, 1),
      e("function", "Button", null, 3, 5),
      e("class", "Panel", null, 7, 14),
      e("method", "render", "Panel", 8, 10),
      e("method", "componentDidMount", "Panel", 11, 13),
    ],
  },
  {
    lang: "javascript",
    code: `const fs = require("fs");\n\nfunction readAll(path) {\n  return fs.readFileSync(path);\n}\n\nclass Store {\n  constructor() {\n    this.items = [];\n  }\n  add(item) {\n    this.items.push(item);\n  }\n}\n`,
    expected: [
      e("module", null, null, 1, 1),
      e("function", "readAll", null, 3, 5),
      e("class", "Store", null, 7, 14),
      e("method", "constructor", "Store", 8, 10),
      e("method", "add", "Store", 11, 13),
    ],
  },
  {
    lang: "python",
    code: `import os\n\n@decorator\ndef parse_config(path):\n    return {}\n\nclass Loader(Base):\n    limit = 3\n\n    def load(self, name):\n        return name\n\n    @staticmethod\n    def save(data):\n        return data\n`,
    expected: [
      e("module", null, null, 1, 1),
      e("function", "parse_config", null, 3, 5),
      e("class", "Loader", null, 7, 15),
      e("method", "load", "Loader", 10, 11),
      e("method", "save", "Loader", 13, 15),
    ],
  },
  {
    lang: "go",
    code: `package main\n\nimport "fmt"\n\nfunc Add(a int, b int) int {\n\treturn a + b\n}\n\ntype Server struct {\n\tPort int\n}\n\nfunc (s *Server) Start() error {\n\tfmt.Println("x")\n\treturn nil\n}\n`,
    expected: [
      e("module", null, null, 1, 3),
      e("function", "Add", null, 5, 7),
      e("class", "Server", null, 9, 11),
      e("method", "Start", "Server", 13, 16),
    ],
  },
  {
    lang: "rust",
    code: `use std::fmt;\n\n/// doc\n#[derive(Debug)]\nstruct Point { x: i32 }\n\nfn add(a: i32) -> i32 {\n    a + 1\n}\n\nimpl Point {\n    fn norm(&self) -> i32 {\n        self.x\n    }\n    fn scale(&mut self, k: i32) {\n        self.x *= k;\n    }\n}\n`,
    expected: [
      e("module", null, null, 1, 1),
      e("class", "Point", null, 3, 5),
      e("function", "add", null, 7, 9),
      e("class", "Point", null, 11, 18),
      e("method", "norm", "Point", 12, 14),
      e("method", "scale", "Point", 15, 17),
    ],
  },
  {
    lang: "java",
    code: `package a.b;\nimport java.util.List;\n\npublic class Account {\n  private int balance;\n  public Account(int b) {\n    this.balance = b;\n  }\n  public void deposit(int amount) {\n    balance += amount;\n  }\n}\n`,
    expected: [
      e("module", null, null, 1, 2),
      e("class", "Account", null, 4, 12),
      e("method", "Account", "Account", 6, 8),
      e("method", "deposit", "Account", 9, 11),
    ],
  },
  {
    lang: "csharp",
    code: `using System;\nnamespace Shop {\n  public class Cart {\n    private int n;\n    public void Add(int x) {\n      n += x;\n    }\n    public int Total() {\n      return n;\n    }\n  }\n}\n`,
    expected: [
      e("module", null, null, 1, 2),
      e("class", "Cart", null, 3, 11),
      e("method", "Add", "Cart", 5, 7),
      e("method", "Total", "Cart", 8, 10),
      e("module", null, null, 12, 12),
    ],
  },
  {
    lang: "c",
    code: `#include <stdio.h>\n\nstruct point { int x; int y; };\n\ntypedef int myint;\n\nint add(int a, int b) {\n  return a + b;\n}\n\nstatic char *name(void) {\n  return "x";\n}\n`,
    expected: [
      e("module", null, null, 1, 1),
      e("class", "point", null, 3, 3),
      e("declaration", "myint", null, 5, 5),
      e("function", "add", null, 7, 9),
      e("function", "name", null, 11, 13),
    ],
  },
  {
    lang: "cpp",
    code: `#include <string>\nnamespace app {\nclass Widget {\n public:\n  int size;\n  void resize(int n) {\n    size = n;\n  }\n  int get() const { return size; }\n};\n}\nint Widget::other(int a) {\n  return a;\n}\ntemplate <typename T>\nT identity(T v) {\n  return v;\n}\n`,
    expected: [
      e("module", null, null, 1, 2),
      e("class", "Widget", null, 3, 10),
      e("method", "resize", "Widget", 6, 8),
      e("method", "get", "Widget", 9, 9),
      e("function", "other", "Widget", 12, 14),
      e("function", "identity", null, 15, 18),
    ],
  },
  {
    lang: "php",
    code: `<?php\nnamespace App;\nuse Foo\\Bar;\nfunction helper($x) {\n  return $x;\n}\nclass User {\n  private $name;\n  public function getName() {\n    return $this->name;\n  }\n  public function setName($n) {\n    $this->name = $n;\n  }\n}\n`,
    expected: [
      e("module", null, null, 1, 3),
      e("function", "helper", null, 4, 6),
      e("class", "User", null, 7, 15),
      e("method", "getName", "User", 9, 11),
      e("method", "setName", "User", 12, 14),
    ],
  },
  {
    lang: "ruby",
    code: `require 'json'\n\ndef helper(x)\n  x + 1\nend\n\nclass Account < Base\n  attr_reader :balance\n  def deposit(n)\n    @balance += n\n  end\n  def self.build\n    new\n  end\nend\n`,
    expected: [
      e("module", null, null, 1, 1),
      e("function", "helper", null, 3, 5),
      e("class", "Account", null, 7, 15),
      e("method", "deposit", "Account", 9, 11),
      e("method", "build", "Account", 12, 14),
    ],
  },
  {
    lang: "kotlin",
    code: `package a\nimport b.C\n\nfun helper(x: Int): Int {\n  return x\n}\n\nclass Account(val id: Int) {\n  val balance = 0\n  fun deposit(n: Int) {\n    println(n)\n  }\n  fun withdraw(n: Int) {\n    println(n)\n  }\n}\n`,
    expected: [
      e("module", null, null, 1, 2),
      e("function", "helper", null, 4, 6),
      e("class", "Account", null, 8, 16),
      e("method", "deposit", "Account", 10, 12),
      e("method", "withdraw", "Account", 13, 15),
    ],
  },
];

const bytesMatch = (code: string, c: Chunk) => Buffer.from(code).subarray(c.startByte, c.endByte).toString() === c.text;

describe("chunkWithTreeSitter per language", () => {
  for (const { lang, code, expected } of FRAGMENTS) {
    it(`${lang}: units, symbols, parents, lines and bytes`, async () => {
      const chunks = await chunkWithTreeSitter(lang, code, opts(20));
      for (const exp of expected) {
        const found = chunks.find(
          (c) => c.kind === exp.kind && c.symbol === exp.symbol && c.parentSymbol === exp.parentSymbol && c.startLine === exp.startLine,
        );
        expect(found, `${lang} ${exp.kind} ${exp.symbol}`).toBeDefined();
        expect(found!.endLine).toBe(exp.endLine);
        if (found!.kind !== "class") expect(bytesMatch(code, found!)).toBe(true);
      }
    });
  }
});

describe("chunkWithTreeSitter behavior", () => {
  const classCode = `export class Big {\n  private a = 1;\n  first(x: number): number {\n    return x * 2 + this.a;\n  }\n  second(y: string): string {\n    return y.repeat(3);\n  }\n}\n`;

  it("small class stays whole", async () => {
    const chunks = await chunkWithTreeSitter("typescript", classCode, opts(400));
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.text).toBe(classCode.trimEnd());
  });

  it("class over maxTokens becomes skeleton plus method chunks", async () => {
    const chunks = await chunkWithTreeSitter("typescript", classCode, opts(30));
    const skeleton = chunks.find((c) => c.kind === "class")!;
    expect(skeleton.text).toContain("private a = 1;");
    expect(skeleton.text).toContain("first(x: number): number");
    expect(skeleton.text).not.toContain("x * 2");
    expect(skeleton.signature).toBe("export class Big");
    expect(chunks.filter((c) => c.kind === "method").map((c) => c.symbol)).toEqual(["first", "second"]);
  });

  it("class over 150 lines becomes skeleton even when tokens fit", async () => {
    const body = Array.from({ length: 80 }, (_, i) => `  m${i}() {\n    return ${i};\n  }`).join("\n");
    const code = `class Long {\n${body}\n}\n`;
    const chunks = await chunkWithTreeSitter("typescript", code, opts(100000));
    expect(chunks.filter((c) => c.kind === "method")).toHaveLength(80);
    expect(chunks.find((c) => c.kind === "class")!.text).not.toContain("return 5;");
  });

  it("splits long functions into overlapping pieces within maxTokens", async () => {
    const lines = Array.from({ length: 200 }, (_, i) => `  total += compute(${i});`).join("\n");
    const code = `function big() {\n  let total = 0;\n${lines}\n  return total;\n}\n`;
    const o = opts(100);
    const chunks = await chunkWithTreeSitter("typescript", code, o);
    expect(chunks.length).toBeGreaterThan(5);
    for (const c of chunks) {
      expect(c.symbol).toBe("big");
      expect(o.countTokens(c.text)).toBeLessThanOrEqual(100);
      expect(bytesMatch(code, c)).toBe(true);
    }
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i]!.startLine).toBeLessThanOrEqual(chunks[i - 1]!.endLine);
      expect(chunks[i]!.startLine).toBeGreaterThan(chunks[i - 1]!.startLine);
    }
    expect(chunks.at(-1)!.endLine).toBe(code.trimEnd().split("\n").length);
  });

  it("keeps non-unit code as module chunks without losing it", async () => {
    const code = `import a from "a";\nconst x = 1;\nfunction f() {\n  return x;\n}\nconsole.log(f());\n`;
    const chunks = await chunkWithTreeSitter("typescript", code, opts(400));
    expect(chunks.map((c) => c.kind)).toEqual(["module", "function", "module"]);
    expect(chunks[0]!.text).toBe('import a from "a";\nconst x = 1;');
    expect(chunks[2]!.text).toBe("console.log(f());");
  });

  it("byte offsets are UTF-8 for non-ASCII content", async () => {
    const code = `const s = "приветик 🌍";\nfunction привет() {\n  return "мир";\n}\n`;
    const chunks = await chunkWithTreeSitter("typescript", code, opts(400));
    const fn = chunks.find((c) => c.kind === "function")!;
    expect(fn.startLine).toBe(2);
    expect(bytesMatch(code, fn)).toBe(true);
    expect(bytesMatch(code, chunks[0]!)).toBe(true);
  });

  it("returns no chunks for empty content", async () => {
    expect(await chunkWithTreeSitter("python", "\n\n", opts(400))).toEqual([]);
  });

  it("rejects unknown languages", async () => {
    await expect(chunkWithTreeSitter("cobol", "x", opts(400))).rejects.toThrow();
  });

  it("chunks a 10000-line TypeScript file in under a second", async () => {
    const parts: string[] = [];
    for (let i = 0; i < 1000; i++) {
      parts.push(`export function fn${i}(a: number, b: number): number {\n  const x = a + ${i};\n  if (x > b) {\n    return x;\n  }\n  return b - x;\n}\n\n// c${i}\nconst v${i} = ${i};`);
    }
    const code = parts.join("\n");
    expect(code.split("\n").length).toBeGreaterThanOrEqual(10000);
    await chunkWithTreeSitter("typescript", "function warm() {}", opts(400));
    const t0 = performance.now();
    const chunks = await chunkWithTreeSitter("typescript", code, opts(400));
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(chunks.filter((c) => c.kind === "function")).toHaveLength(1000);
  });
});
