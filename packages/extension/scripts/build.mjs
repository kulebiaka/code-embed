import { build } from "esbuild";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const p = (rel) => join(pkgDir, rel);

await Promise.all([
  build({
    entryPoints: [p("src/extension.ts")],
    outfile: p("dist/extension.js"),
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    sourcemap: true,
    external: ["vscode"],
    logLevel: "info",
  }),
  build({
    entryPoints: [p("webview/main.ts")],
    outfile: p("dist/webview.js"),
    bundle: true,
    platform: "browser",
    format: "iife",
    target: "es2022",
    sourcemap: true,
    logLevel: "info",
  }),
  build({
    entryPoints: [p("webview/settings/main.ts")],
    outfile: p("dist/settings.js"),
    bundle: true,
    platform: "browser",
    format: "iife",
    target: "es2022",
    sourcemap: true,
    logLevel: "info",
  }),
  ...[
    ["webview/style.css", "dist/webview.css"],
    ["webview/settings/style.css", "dist/settings.css"],
  ].map(([entry, out]) =>
    build({
      entryPoints: [p(entry)],
      outfile: p(out),
      bundle: true,
      loader: { ".ttf": "file" },
      assetNames: "[name]",
      logLevel: "info",
    }),
  ),
]);
