import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGES = ["packages/engine", "packages/extension", "packages/protocol", "eval"];
const PINNED = ["README.md", "docs/agents.md"];
const read = (p) => readFileSync(join(root, p), "utf8");
const write = (p, s) => writeFileSync(join(root, p), s);

const arg = process.argv[2];
if (!arg) {
  process.stderr.write("usage: pnpm release:version <major|minor|patch|X.Y.Z>\n");
  process.exit(2);
}

const current = JSON.parse(read("packages/engine/package.json")).version;
const [maj, min, pat] = current.split(".").map(Number);
const next =
  { major: `${maj + 1}.0.0`, minor: `${maj}.${min + 1}.0`, patch: `${maj}.${min}.${pat + 1}` }[arg] ?? arg;
// VS Marketplace accepts only plain major.minor.patch versions
if (!/^\d+\.\d+\.\d+$/.test(next)) {
  process.stderr.write(`invalid version "${next}": expected X.Y.Z\n`);
  process.exit(2);
}
if (next === current) {
  process.stderr.write(`version is already ${current}\n`);
  process.exit(2);
}

const changelog = read("CHANGELOG.md");
const unreleased = changelog.match(/## \[Unreleased\]\n([\s\S]*?)(?=\n## \[|\n\[Unreleased\]:)/);
if (!unreleased || unreleased[1].trim() === "") {
  process.stderr.write("CHANGELOG.md: the [Unreleased] section is empty, describe the changes first\n");
  process.exit(2);
}

for (const dir of PACKAGES) {
  const p = `${dir}/package.json`;
  write(p, read(p).replace(/("version":\s*")[^"]+(")/, `$1${next}$2`));
}
for (const p of PINNED) write(p, read(p).replaceAll(`code-embed@${current}`, `code-embed@${next}`));

const date = new Date().toISOString().slice(0, 10);
const repo = "https://github.com/kulebiaka/code-embed";
write(
  "CHANGELOG.md",
  changelog
    .replace("## [Unreleased]\n", `## [Unreleased]\n\n## [${next}] - ${date}\n`)
    .replace(
      /\[Unreleased\]: .*\n/,
      `[Unreleased]: ${repo}/compare/v${next}...HEAD\n[${next}]: ${repo}/compare/v${current}...v${next}\n`,
    ),
);

process.stdout.write(
  `${current} -> ${next}\n\nNext:\n  git commit -am "chore(release): v${next}"\n  git tag v${next}\n  git push --follow-tags\n`,
);
