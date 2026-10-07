import { runTests } from "@vscode/test-electron";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const extDir = join(here, "..", "..");
const engineDir = join(extDir, "..", "engine");
const fixture = join(engineDir, "test", "fixtures", "sample-repo");

const versions = (process.env.E2E_VSCODE_VERSIONS ?? "1.103.0,stable")
  .split(",")
  .map((v) => v.trim())
  .filter(Boolean);

for (const f of [join(extDir, "dist/extension.js"), join(engineDir, "dist/cli.js")]) {
  if (!existsSync(f)) throw new Error(`${f} is missing (run pnpm build)`);
}

const tmp = await mkdtemp(join(tmpdir(), "code-embed-e2e-"));

async function stageExtension() {
  const dir = join(tmp, "extension");
  await mkdir(join(dir, "dist"), { recursive: true });
  const pkg = JSON.parse(await readFile(join(extDir, "package.json"), "utf8"));
  delete pkg.scripts;
  delete pkg.dependencies;
  delete pkg.devDependencies;
  await writeFile(join(dir, "package.json"), JSON.stringify(pkg, null, 2));
  for (const f of ["extension.js", "webview.js", "webview.css"]) {
    if (existsSync(join(extDir, "dist", f))) await cp(join(extDir, "dist", f), join(dir, "dist", f));
  }
  await cp(join(extDir, "media"), join(dir, "media"), { recursive: true });
  await symlink(join(engineDir, "dist"), join(dir, "dist", "engine"), "junction");
  return dir;
}

let failed = false;
try {
  const extensionDevelopmentPath = await stageExtension();
  const extensionTestsPath = join(here, "suite", "index.js");

  for (const version of versions) {
    const workspace = join(tmp, `workspace-${version}`);
    await cp(fixture, workspace, { recursive: true });
    console.log(`\n=== VS Code ${version} ===`);
    try {
      await runTests({
        version,
        cachePath: process.env.VSCODE_TEST_CACHE ?? join(tmpdir(), "code-embed-vscode-test"),
        extensionDevelopmentPath,
        extensionTestsPath,
        launchArgs: [
          workspace,
          "--disable-workspace-trust",
          "--skip-welcome",
          "--skip-release-notes",
          "--disable-gpu",
          "--user-data-dir",
          join(tmp, `user-data-${version}`),
          "--extensions-dir",
          join(tmp, `extensions-${version}`),
        ],
        extensionTestsEnv: {
          CODE_EMBED_FAKE_EMBEDDER: "1",
          CODE_EMBED_CACHE_DIR: join(tmp, "cache"),
          CODE_EMBED_CONFIG_DIR: join(tmp, "config"),
        },
      });
    } catch (e) {
      console.error(`VS Code ${version}: ${e instanceof Error ? e.message : e}`);
      failed = true;
    }
  }
} finally {
  await rm(tmp, { recursive: true, force: true }).catch(() => {});
}
process.exit(failed ? 1 : 0);
