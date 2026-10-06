import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runChecks } from "./checks";
import { exitCode } from "./report";

const report = await runChecks();
const json = JSON.stringify(report, null, 2);
console.log(json);

const dir = process.env.STAGE0_REPORT_DIR ?? fileURLToPath(new URL("./reports", import.meta.url));
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, `runtime-${report.platform}-${report.arch}.json`), json);

process.exit(exitCode([report]));
