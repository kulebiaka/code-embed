import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");
const errors = [];
const fail = (m) => errors.push(m);

const DOCS = ["README.md", "docs/cli.md", "docs/configuration.md", "docs/agents.md", "docs/architecture.md"];

const REQUIRED_HEADINGS = [
  "# code-embed",
  "## Возможности",
  "## Установка",
  "### VS Code / Cursor / Windsurf",
  "### CLI",
  "## Быстрый старт",
  "## CLI",
  "## Конфигурация",
  "### .code-embed.toml",
  "### Провайдеры эмбеддингов",
  "### Приватность",
  "## Интеграция с агентами",
  "### VS Code (LM Tools)",
  "### MCP",
  "### Фрагмент для CLAUDE.md / AGENTS.md",
  "## Модели",
  "## Как это работает",
  "## Лицензии",
];

const readme = read("README.md");
const readmeLines = readme.split("\n");
for (const h of REQUIRED_HEADINGS) {
  if (!readmeLines.includes(h)) fail(`README.md: missing heading "${h}"`);
}

const texts = {};
for (const f of DOCS) {
  if (!existsSync(join(root, f))) {
    fail(`${f}: file is missing`);
    continue;
  }
  texts[f] = read(f);
  if (/\bTBD\b/.test(texts[f])) fail(`${f}: contains TBD placeholder`);
}

for (const [f, text] of Object.entries(texts)) {
  const stripped = text.replace(/```[\s\S]*?```/g, "");
  for (const m of stripped.matchAll(/\]\(([^)\s]+)\)/g)) {
    const target = m[1];
    if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("#")) continue;
    const path = target.split("#")[0];
    if (path && !existsSync(resolve(root, dirname(f), path))) fail(`${f}: broken relative link "${target}"`);
  }
}

let help = "";
try {
  help = execFileSync(process.execPath, [join(root, "packages/engine/dist/cli.js"), "--help"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
} catch (e) {
  fail(`cannot run code-embed --help (build the engine first): ${e.message}`);
}

const commands = new Set();
for (const line of (help.split(/\n\s*\n/)[0] ?? "").split("\n")) {
  const m = line.match(/^\s*code-embed\s+(.*)$/);
  if (!m) continue;
  for (const part of m[1].split("|")) {
    const w = part.trim().match(/^([a-z][a-z-]*)\b/);
    if (w) commands.add(w[1]);
  }
}
if (help && commands.size === 0) fail("no subcommands found in --help output");

const cli = texts["docs/cli.md"] ?? "";
for (const c of commands) {
  if (!new RegExp(`(^|[^a-z-])${c}([^a-z-]|$)`).test(cli)) fail(`docs/cli.md: subcommand "${c}" is not mentioned`);
}
for (const flag of new Set(help.match(/--[a-z][a-z-]*/g) ?? [])) {
  if (!cli.includes(flag)) fail(`docs/cli.md: option "${flag}" is not mentioned`);
}

const licenseIdx = readmeLines.indexOf("## Лицензии");
const licenseLines = licenseIdx >= 0 ? readmeLines.slice(licenseIdx) : [];
const models = JSON.parse(read("packages/engine/src/embed/models.json")).models;
for (const m of models) {
  const has = (lines) => lines.some((l) => l.startsWith("|") && l.includes(`\`${m.id}\``) && l.includes(m.license));
  if (!has(readmeLines)) fail(`README.md: no table row with model "${m.id}" and license "${m.license}"`);
  if (!has(licenseLines)) fail(`README.md: section "Лицензии" lacks model "${m.id}" with license "${m.license}"`);
}
const licenseText = licenseLines.join("\n");
if (!/\bMIT\b/.test(licenseText)) fail('README.md: "Лицензии" must state the MIT license');
if (!/телеметри/i.test(licenseText)) fail('README.md: "Лицензии" must state there is no telemetry');

const manifest = JSON.parse(read("packages/extension/package.json"));
const settings = Object.keys(manifest.contributes?.configuration?.properties ?? {}).filter((k) => k.startsWith("codeEmbed."));
const cfgDoc = texts["docs/configuration.md"] ?? "";
for (const s of settings) {
  if (!cfgDoc.includes(`\`${s}\``)) fail(`docs/configuration.md: setting "${s}" is not documented`);
}

if (errors.length > 0) {
  process.stderr.write(`check-docs: ${errors.length} problem(s)\n${errors.map((e) => `  - ${e}`).join("\n")}\n`);
  process.exit(1);
}
process.stdout.write(`check-docs: ok (${commands.size} subcommands, ${models.length} models, ${settings.length} settings)\n`);
