import { build } from "esbuild";
import { chmod, copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const distDir = join(pkgDir, "dist");
const outfile = join(distDir, "cli.js");
const require = createRequire(import.meta.url);

export const external = [
  "onnxruntime-node",
  "@huggingface/transformers",
  "@parcel/watcher",
  "@napi-rs/keyring",
  "sqlite-vec",
  "web-tree-sitter",
  "tree-sitter-wasms",
  "sharp",
];

await build({
  entryPoints: [join(pkgDir, "src/cli/main.ts")],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: true,
  external,
  banner: {
    js: [
      "#!/usr/bin/env node",
      'import { createRequire as __ceCreateRequire } from "node:module";',
      "const require = __ceCreateRequire(import.meta.url);",
    ].join("\n"),
  },
  logLevel: "info",
});

await chmod(outfile, 0o755);

const languages = await readFile(join(pkgDir, "src/chunk/languages.ts"), "utf8");
const wasmFiles = [...new Set([...languages.matchAll(/"(tree-sitter-[\w-]+\.wasm)"/g)].map((m) => m[1]))];
const grammarsSrc = join(dirname(require.resolve("tree-sitter-wasms/package.json")), "out");
const grammarsDst = join(distDir, "grammars");
await rm(grammarsDst, { recursive: true, force: true });
await mkdir(grammarsDst, { recursive: true });
for (const f of wasmFiles) await copyFile(join(grammarsSrc, f), join(grammarsDst, f));

const treeSitterDir = dirname(require.resolve("web-tree-sitter"));
await copyFile(join(treeSitterDir, "tree-sitter.wasm"), join(distDir, "tree-sitter.wasm"));

await writeFile(join(distDir, "externals.json"), JSON.stringify(external));
