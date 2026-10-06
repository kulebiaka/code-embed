import { build } from "esbuild";
import { chmod } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const outfile = join(pkgDir, "dist/cli.js");

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
