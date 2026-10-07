import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const LIMIT = 40 * 1024 * 1024;
const target = process.argv[2];
if (!target) {
  console.error("usage: check-vsix-size.mjs <file.vsix | directory>");
  process.exit(2);
}

const files = statSync(target).isDirectory()
  ? readdirSync(target).filter((f) => f.endsWith(".vsix")).map((f) => join(target, f))
  : [target];
if (files.length === 0) {
  console.error(`no .vsix files in ${target}`);
  process.exit(1);
}

let failed = false;
for (const f of files) {
  const size = statSync(f).size;
  const mb = (size / 1024 / 1024).toFixed(1);
  if (size > LIMIT) {
    console.error(`FAIL ${f}: ${mb} MB > 40 MB`);
    failed = true;
  } else {
    console.log(`ok   ${f}: ${mb} MB`);
  }
}
process.exit(failed ? 1 : 0);
