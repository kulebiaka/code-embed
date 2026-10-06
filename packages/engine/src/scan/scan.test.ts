import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { detectLang } from "./lang";
import { hashContent, readCandidate } from "./read";
import { createIgnoreMatcher, scanFiles } from "./scan";
import type { ScannedFile } from "./types";

const here = dirname(fileURLToPath(import.meta.url));
const sampleRepo = resolve(here, "../../test/fixtures/sample-repo");

let tmp: string;
const savedEnv = { ...process.env };

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "scan-test-"));
  writeFileSync(join(tmp, "gitconfig"), `[core]\n\texcludesFile = ${join(tmp, "global-ignore")}\n`);
  writeFileSync(join(tmp, "global-ignore"), "*.globalignored\n");
  process.env.GIT_CONFIG_GLOBAL = join(tmp, "gitconfig");
  process.env.GIT_CONFIG_SYSTEM = "/dev/null";
});

afterAll(() => {
  process.env = savedEnv;
  rmSync(tmp, { recursive: true, force: true });
});

async function collect(root: string, exclude: string[] = [], maxFileKb = 512): Promise<ScannedFile[]> {
  const out: ScannedFile[] = [];
  for await (const f of scanFiles(root, { exclude, maxFileKb })) out.push(f);
  return out;
}

function write(root: string, rel: string, content: string | Buffer = "x\n"): void {
  const p = join(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
}

function fresh(name: string): string {
  const d = join(tmp, name);
  mkdirSync(d, { recursive: true });
  return d;
}

describe("scanFiles", () => {
  it("lists the sample-repo fixture", async () => {
    const files = await collect(sampleRepo);
    expect(files.map((f) => f.path).sort()).toEqual(
      [
        ".gitignore",
        "cmd/server/main.go",
        "docs/guide.md",
        "lib/http_client.rs",
        "scripts/deploy.sh",
        "src/App.tsx",
        "src/payment/refund.ts",
        "src/utils/parse_config.py",
      ].sort(),
    );
    const app = files.find((f) => f.path === "src/App.tsx");
    expect(app?.lang).toBe("tsx");
    expect(app?.absPath).toBe(join(sampleRepo, "src/App.tsx"));
  });

  it("honors nested .gitignore, .ignore, global gitignore and exclude", async () => {
    const root = fresh("ignores");
    write(root, ".gitignore", "*.log\n");
    write(root, ".ignore", "private/\n");
    write(root, "a.ts");
    write(root, "a.log");
    write(root, "private/p.ts");
    write(root, "sub/.gitignore", "local.ts\n!keep.log\n");
    write(root, "sub/local.ts");
    write(root, "sub/keep.log");
    write(root, "sub/other.ts");
    write(root, "x.globalignored");
    write(root, "custom/c.ts");
    write(root, "vscode.ts");
    const files = await collect(root, ["custom/", "vscode.ts"]);
    expect(files.map((f) => f.path).sort()).toEqual([".gitignore", ".ignore", "a.ts", "sub/.gitignore", "sub/keep.log", "sub/other.ts"]);
  });

  it("always excludes .code-embed and .git", async () => {
    const root = fresh("always");
    write(root, ".code-embed/index.db");
    write(root, ".git/config");
    write(root, "pkg/.git/HEAD");
    write(root, "ok.ts");
    expect((await collect(root)).map((f) => f.path)).toEqual(["ok.ts"]);
  });

  it("skips generated names, size and every lockfile", async () => {
    const root = fresh("skips");
    const locks = [
      "package-lock.json",
      "yarn.lock",
      "pnpm-lock.yaml",
      "bun.lockb",
      "bun.lock",
      "Cargo.lock",
      "poetry.lock",
      "Pipfile.lock",
      "uv.lock",
      "composer.lock",
      "Gemfile.lock",
      "go.sum",
      "packages.lock.json",
      "gradle.lockfile",
    ];
    for (const l of locks) write(root, l);
    for (const l of locks) write(root, `nested/${l}`);
    write(root, "app.min.js");
    write(root, "bundle.js.map");
    write(root, "big.ts", "a".repeat(2 * 1024));
    write(root, "small.ts");
    expect((await collect(root, [], 1)).map((f) => f.path)).toEqual(["small.ts"]);
  });

  it("does not follow symlinks outside the root and survives cycles", async () => {
    const outside = fresh("outside");
    write(outside, "leak.ts");
    const root = fresh("links");
    write(root, "real/r.ts");
    symlinkSync(outside, join(root, "escape"));
    symlinkSync(root, join(root, "real/loop"));
    symlinkSync(join(outside, "leak.ts"), join(root, "leakfile.ts"));
    expect((await collect(root)).map((f) => f.path)).toEqual(["real/r.ts"]);
  });
});

describe("createIgnoreMatcher", () => {
  it("agrees with scanFiles", async () => {
    const root = fresh("matcher");
    write(root, ".gitignore", "build/\n*.tmp\n");
    write(root, "src/.gitignore", "gen.ts\n");
    write(root, "src/gen.ts");
    write(root, "src/a.ts");
    write(root, "build/out.js");
    write(root, "z.tmp");
    write(root, "x.globalignored");
    write(root, "ex/e.ts");
    const exclude = ["ex/"];
    const isIgnored = await createIgnoreMatcher(root, exclude);
    const scanned = new Set((await collect(root, exclude)).map((f) => f.path));
    const all = [".gitignore", "src/.gitignore", "src/gen.ts", "src/a.ts", "build/out.js", "z.tmp", "x.globalignored", "ex/e.ts"];
    for (const p of all) expect(!isIgnored(p, false), p).toBe(scanned.has(p));
    expect(isIgnored("build", true)).toBe(true);
    expect(isIgnored(".code-embed/db", false)).toBe(true);
    expect(isIgnored(".git", true)).toBe(true);
  });
});

describe("readCandidate", () => {
  async function candidate(name: string, content: string | Buffer): Promise<ReturnType<typeof readCandidate>> {
    const root = fresh("read");
    write(root, name, content);
    return readCandidate({ path: name, absPath: join(root, name), size: content.length, mtimeMs: 0, lang: null });
  }

  it("returns content and hash", async () => {
    const r = await candidate("ok.ts", "const a = 1;\n");
    expect(r).toEqual({ content: "const a = 1;\n", hash: await hashContent("const a = 1;\n") });
  });

  it("skips binary on NUL in first 8KB", async () => {
    expect(await candidate("b.bin", Buffer.from([1, 2, 0, 3]))).toEqual({ skip: "binary" });
  });

  it("ignores NUL after 8KB", async () => {
    const buf = Buffer.concat([Buffer.from("a\n".repeat(5000)), Buffer.from([0])]);
    expect("content" in (await candidate("late.txt", buf))).toBe(true);
  });

  it("skips minified content", async () => {
    expect(await candidate("m.js", "x".repeat(301))).toEqual({ skip: "minified" });
    expect("content" in (await candidate("n.js", "x".repeat(300)))).toBe(true);
  });

  it("skips lockfiles", async () => {
    expect(await candidate("go.sum", "a\n")).toEqual({ skip: "lockfile" });
  });
});

describe("hashContent", () => {
  it("matches blake3 test vector for empty input", async () => {
    expect(await hashContent("")).toMatch(/^af1349b9f5f9a1a6a0404dea36dcc9499bcb25c9adc112b7cc9a93cae41f3262$/);
    expect(await hashContent(new Uint8Array())).toBe(await hashContent(""));
  });
});

describe("detectLang", () => {
  it.each([
    ["a.ts", "typescript"],
    ["a.tsx", "tsx"],
    ["a.js", "javascript"],
    ["a.py", "python"],
    ["a.go", "go"],
    ["a.rs", "rust"],
    ["A.java", "java"],
    ["a.cs", "csharp"],
    ["a.c", "c"],
    ["a.cpp", "cpp"],
    ["a.php", "php"],
    ["a.rb", "ruby"],
    ["a.kt", "kotlin"],
    ["README.md", "markdown"],
    ["Makefile", null],
    ["x/y.unknownext", null],
  ])("%s -> %s", (p, lang) => {
    expect(detectLang(p)).toBe(lang);
  });
});
