import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { build } from "esbuild";
import { exitCode, lastJsonLine, minVersionFromRange, type RuntimeReport } from "./report";

const run = promisify(execFile);
const here = fileURLToPath(new URL(".", import.meta.url));
const extensionPkg = fileURLToPath(new URL("../../packages/extension/package.json", import.meta.url));
const enginePkg = fileURLToPath(new URL("../../packages/engine/package.json", import.meta.url));
const reportDir = process.env.STAGE0_REPORT_DIR ?? join(here, "reports");

const { downloadAndUnzipVSCode } = createRequire(extensionPkg)("@vscode/test-electron") as {
  downloadAndUnzipVSCode(version: string): Promise<string>;
};

const minVersion = minVersionFromRange(
  (JSON.parse(readFileSync(extensionPkg, "utf8")) as { engines: { vscode: string } }).engines.vscode,
);

mkdirSync(reportDir, { recursive: true });
const bundle = join(reportDir, "stage0-bundle.mjs");
await build({
  stdin: {
    contents: [
      'import { runChecks } from "./checks";',
      "const report = await runChecks();",
      "console.log(JSON.stringify(report));",
      "process.exit(report.ok ? 0 : 1);",
    ].join("\n"),
    resolveDir: here,
    sourcefile: "electron-entry.ts",
    loader: "ts",
  },
  outfile: bundle,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  external: ["node:*"],
  logLevel: "warning",
});

const reports: RuntimeReport[] = [];
for (const version of [minVersion, "stable"]) {
  const exe = await downloadAndUnzipVSCode(version);
  const res = await run(exe, [bundle], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", STAGE0_ENGINE_PKG: enginePkg },
    timeout: 120_000,
  }).catch((e: { stdout?: string; stderr?: string; message: string }) => {
    if (e.stdout) return { stdout: e.stdout };
    throw new Error(`VS Code ${version} failed to run: ${e.message}\n${e.stderr ?? ""}`);
  });
  const report = lastJsonLine(res.stdout) as RuntimeReport;
  const sqlite = report.checks.find((c) => c.name === "vec0:int8-knn");
  console.log(
    `VS Code ${version}: electron=${report.electron} node=${report.node} ok=${report.ok} node:sqlite+vec=${sqlite?.status}`,
  );
  writeFileSync(
    join(reportDir, `electron-${version}-${report.platform}-${report.arch}.json`),
    JSON.stringify({ vscode: version, ...report }, null, 2),
  );
  reports.push(report);
}

process.exit(exitCode(reports));
