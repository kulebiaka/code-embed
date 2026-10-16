import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// npm resolves relative links against packages/engine, so point them at the repo root on GitHub
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repo = "https://github.com/kulebiaka/code-embed";
const readme = readFileSync(join(root, "README.md"), "utf8").replace(
  /(\]\(|src="|href=")(?!https?:|#)([^)"]+)/g,
  (_, prefix, path) => `${prefix}${repo}/${/\.(png|jpe?g|gif|svg)$/.test(path) ? "raw" : "blob"}/main/${path}`,
);
writeFileSync(process.argv[2] ?? join(root, "packages/engine/README.md"), readme);
