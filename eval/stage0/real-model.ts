import { execFile, spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  createWriteStream,
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";
import { PROTOCOL_VERSION, createEngineProxy, type EngineApi, type IndexStatus } from "@code-embed/protocol";
import { modelsDir } from "../../packages/engine/src/core/paths";
import {
  THRESHOLDS,
  allPassed,
  evaluate,
  latencyStats,
  parsePs,
  searchShares,
  treeRss,
  type CheckVerdict,
  type Latency,
  type Phase,
} from "./real-model-report";
import { minVersionFromRange } from "./report";
import { STRESS_MARKERS, copyRepoFixture, createStressFixture } from "./stress-fixture";

const run = promisify(execFile);
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const extensionPkg = join(repoRoot, "packages/extension/package.json");
const protocolPkg = join(repoRoot, "packages/protocol/package.json");

const { values: args } = parseArgs({
  options: {
    model: { type: "string", default: "qwen3-embedding-0.6b" },
    vscode: { type: "string", default: "stable" },
    engine: { type: "string" },
    repo: { type: "string" },
    minutes: { type: "string", default: "5" },
    "min-embedded": { type: "string", default: String(THRESHOLDS.defaultMinEmbedded) },
  },
});

const models = args.model!.split(",").map((s) => s.trim()).filter(Boolean);
const minutes = Number(args.minutes);
const minEmbedded = Number(args["min-embedded"]);
const reportDir = resolve(process.env.REAL_MODEL_REPORT_DIR ?? join(repoRoot, "eval/reports/real-model"));
const sharedModels = process.env.CODE_EMBED_MODELS_DIR ? resolve(process.env.CODE_EMBED_MODELS_DIR) : modelsDir();
const vscodeCache = process.env.VSCODE_TEST_CACHE ?? join(tmpdir(), "code-embed-vscode-test");
const platform = `${process.platform}-${process.arch}`;

const { downloadAndUnzipVSCode } = createRequire(extensionPkg)("@vscode/test-electron") as {
  downloadAndUnzipVSCode(opts: { version: string; cachePath: string }): Promise<string>;
};
const jsonrpc = createRequire(protocolPkg)("vscode-jsonrpc/node") as {
  StreamMessageReader: new (s: NodeJS.ReadableStream) => unknown;
  StreamMessageWriter: new (s: NodeJS.WritableStream) => unknown;
  createMessageConnection(r: unknown, w: unknown): Parameters<typeof createEngineProxy>[0] & {
    listen(): void;
    dispose(): void;
    onError(cb: () => void): void;
    onClose(cb: () => void): void;
  };
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const now = () => performance.now();

function buildEngine(): { cli: string; tmp: string } {
  const tmp = mkdtempSync(join(tmpdir(), "real-model-vsix-"));
  const res = spawnSync(
    process.execPath,
    [join(repoRoot, "packages/extension/scripts/package.mjs"), "--target", platform, "--out", tmp],
    { stdio: "inherit" },
  );
  if (res.status !== 0) throw new Error(`package.mjs failed (exit ${res.status}); run pnpm build first`);
  const vsix = readdirSync(tmp).find((f) => f.endsWith(".vsix"));
  if (!vsix) throw new Error("no .vsix produced");
  const dest = join(tmp, "unpacked");
  mkdirSync(dest);
  const unzip =
    process.platform === "win32"
      ? spawnSync("tar", ["-xf", join(tmp, vsix), "-C", dest], { stdio: "inherit" })
      : spawnSync("unzip", ["-q", join(tmp, vsix), "-d", dest], { stdio: "inherit" });
  if (unzip.status !== 0) throw new Error("failed to unpack the vsix");
  const cli = join(dest, "extension/dist/engine/cli.js");
  if (!existsSync(cli)) throw new Error(`${cli} is missing in the vsix`);
  return { cli, tmp };
}

function extensionHostExe(exe: string): string {
  if (process.platform !== "darwin") return exe;
  const app = exe.slice(0, exe.indexOf(".app/") + 4);
  const helper = join(app, "Contents/Frameworks/Code Helper (Plugin).app/Contents/MacOS/Code Helper (Plugin)");
  if (!existsSync(helper)) throw new Error(`Code Helper (Plugin) not found at ${helper}`);
  return helper;
}

function firstTsFile(dir: string, rel = ""): string | null {
  for (const name of readdirSync(join(dir, rel)).sort()) {
    if (name === "stress" || name === "node_modules" || name === ".git" || name === ".code-embed") continue;
    const sub = rel ? `${rel}/${name}` : name;
    if (statSync(join(dir, sub)).isDirectory()) {
      const found = firstTsFile(dir, sub);
      if (found) return found;
    } else if (/\.tsx?$/.test(name) && !name.endsWith(".d.ts")) return sub;
  }
  return null;
}

function toPhase(p: string | undefined): Phase {
  return p === "scanning" || p === "lexical" || p === "vector" || p === "idle" ? p : "other";
}

async function psSnapshot() {
  const { stdout } = await run("ps", ["-A", "-o", "pid=,ppid=,rss="], { maxBuffer: 32 * 1024 * 1024 });
  return parsePs(stdout);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

interface ComboResult {
  model: string;
  vscode: string;
  ok: boolean;
  summary: string;
}

async function runCombo(model: string, versionArg: string, cli: string): Promise<ComboResult> {
  const version = versionArg === "min" ? minVersionFromRange(
    (JSON.parse(readFileSync(extensionPkg, "utf8")) as { engines: { vscode: string } }).engines.vscode,
  ) : versionArg;
  const label = `${model} @ VS Code ${version}`;
  console.log(`\n=== ${label} ===`);

  const probe = async (exe: string) =>
    (
      await run(exe, ["-e", "console.log(process.versions.electron + ' / node ' + process.versions.node)"], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      })
    ).stdout.trim();
  let exe = extensionHostExe(await downloadAndUnzipVSCode({ version, cachePath: vscodeCache }));
  let electron: string;
  try {
    electron = await probe(exe);
  } catch {
    const install = /^(.*[\\/]vscode-[^\\/]+)[\\/]/.exec(exe)?.[1];
    if (!install || !install.startsWith(vscodeCache)) throw new Error(`cannot run ${exe}`);
    console.warn(`VS Code install is unusable (broken code signature?), re-downloading: ${install}`);
    rmSync(install, { recursive: true, force: true });
    exe = extensionHostExe(await downloadAndUnzipVSCode({ version, cachePath: vscodeCache }));
    electron = await probe(exe);
  }

  const tmp = mkdtempSync(join(tmpdir(), "real-model-"));
  const root = join(tmp, "project");
  const cacheDir = join(tmp, "cache");
  const configDir = join(tmp, "config");
  for (const d of [root, cacheDir, configDir, sharedModels]) mkdirSync(d, { recursive: true });
  symlinkSync(sharedModels, join(cacheDir, "models"), "junction");

  let fixtureKind = "stress";
  let stressFiles: string[] = [];
  if (args.repo) {
    fixtureKind = resolve(args.repo);
    copyRepoFixture(resolve(args.repo), root);
  } else {
    stressFiles = createStressFixture(root).stressFiles;
  }
  const git = (...a: string[]) => spawnSync("git", ["-C", root, ...a], { stdio: "ignore" });
  git("init", "-q");
  git("-c", "user.email=a@b.c", "-c", "user.name=smoke", "add", "-A");
  git("-c", "user.email=a@b.c", "-c", "user.name=smoke", "commit", "-qm", "fixture");

  mkdirSync(reportDir, { recursive: true });
  const stem = `real-model-${model}-${version}-${process.platform}-${process.arch}`;
  const logPath = join(reportDir, `${stem}.engine.log`);
  const logStream = createWriteStream(logPath);

  const child: ChildProcess = spawn(exe, [cli, "serve"], {
    cwd: root,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", CODE_EMBED_CACHE_DIR: cacheDir, CODE_EMBED_CONFIG_DIR: configDir },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stderr!.pipe(logStream);
  const enginePid = child.pid!;

  let shuttingDown = false;
  let exitInfo: { code: number | null; signal: string | null } | null = null;
  let exitedAt: number | null = null;
  let onExit!: () => void;
  const exitedEarly = new Promise<never>((_, reject) => {
    onExit = () => reject(new Error("engine exited before the request completed"));
  });
  exitedEarly.catch(() => {});
  child.on("exit", (code, signal) => {
    exitedAt = now();
    if (!shuttingDown) onExit();
    if (!shuttingDown) exitInfo = { code, signal };
  });
  child.on("error", (e) => {
    if (!shuttingDown) exitInfo = { code: null, signal: `spawn error: ${e.message}` };
  });

  const conn = jsonrpc.createMessageConnection(
    new jsonrpc.StreamMessageReader(child.stdout!),
    new jsonrpc.StreamMessageWriter(child.stdin!),
  );
  conn.onError(() => {});
  conn.onClose(() => {});
  conn.listen();
  const api: EngineApi = createEngineProxy(conn);

  const errors: string[] = [];
  const progressPhases: string[] = [];
  api.onIndexError((e) => errors.push(e.message));
  api.onProgress((p) => {
    if (progressPhases[progressPhases.length - 1] !== p.phase) progressPhases.push(p.phase);
  });

  let latest = null as IndexStatus | null;
  const noteStatus = (s: IndexStatus) => {
    latest = s;
    if (s.lastError && !errors.includes(s.lastError)) errors.push(s.lastError);
  };

  const statusMs: number[] = [];
  const lexical: Latency[] = [];
  const hybrid: Latency[] = [];
  const similar: Latency[] = [];
  const rss = { supported: process.platform !== "win32", peakTotalKb: 0, peakRootKb: 0, peakChildKb: 0, rootPeakPhase: null as Phase | null };
  let lastPids: number[] = [enginePid];
  const timeline: { t: number; embedded: number; chunks: number; phase: string; rssMb: number }[] = [];

  const t0 = now();
  let windowStart = t0;
  let initMs = 0;
  let wallEnd = t0;
  let nr07Ms: number | null = null;
  let stressIndexed: CheckVerdict | null = null;
  let hardError: string | null = null;
  let finalStatus: IndexStatus | null = null;

  try {
    const init = await Promise.race([
      api.initialize({
        root,
        clientName: "real-model-smoke",
        protocolVersion: PROTOCOL_VERSION,
        settings: { model: { id: model } },
      }),
      exitedEarly,
    ]);
    initMs = now() - t0;
    noteStatus(init.index);

    let firstEmbeddedAt: number | null = null;
    let nr07Started = false;
    let sampling = true;
    const inflight = new Set<string>();
    const guarded = (key: string, fn: () => Promise<void>) => {
      if (inflight.has(key)) return;
      inflight.add(key);
      void fn().catch((e) => errors.push(`${key} probe failed: ${e instanceof Error ? e.message : e}`)).finally(() => inflight.delete(key));
    };
    const timed = async <T extends { partial?: boolean; partialReason?: string }>(
      list: Latency[],
      call: () => Promise<T>,
    ) => {
      const indexing = latest !== null && latest.embedded < latest.chunks;
      const s = now();
      const res = await call();
      list.push({ ms: now() - s, indexing, partial: res.partial, partialReason: res.partialReason });
    };

    const rssLoop = async () => {
      if (!rss.supported) return;
      while (sampling) {
        try {
          const tree = treeRss(await psSnapshot(), enginePid);
          lastPids = tree.pids;
          if (tree.totalKb > rss.peakTotalKb) rss.peakTotalKb = tree.totalKb;
          if (tree.rootKb > rss.peakRootKb) {
            rss.peakRootKb = tree.rootKb;
            rss.rootPeakPhase = toPhase(latest?.phase);
          }
          if (tree.childrenKb > rss.peakChildKb) rss.peakChildKb = tree.childrenKb;
        } catch {
          // ps may fail transiently
        }
        await sleep(250);
      }
    };
    const rssDone = rssLoop();

    const nr07File = firstTsFile(root);
    const runNr07 = async () => {
      if (!nr07File) return;
      const ident = `nr07Marker${Date.now().toString(36)}`;
      appendFileSync(join(root, nr07File), `\nexport function ${ident}(): number {\n  return 7;\n}\n`);
      const s = now();
      while (now() - s < 5000) {
        const res = await api.search({ query: ident, mode: "lexical", top: 5 });
        if (res.results.length > 0) {
          nr07Ms = now() - s;
          return;
        }
        await sleep(50);
      }
    };

    const counts = { status: 0, lexical: 0, hybrid: 0, similar: 0 };
    for (let tick = 0; ; tick++) {
      await sleep(250);
      if (exitInfo) break;
      const st = latest;
      if (st?.phase === "model-download") windowStart = now();
      if (now() - windowStart > minutes * 60_000) break;
      const sec = tick / 4;

      if (tick % 4 === 0) {
        guarded("status", async () => {
          const s = now();
          const res = await api.status();
          statusMs.push(now() - s);
          noteStatus(res);
          counts.status++;
        });
      }
      if (tick % 8 === 0) guarded("lexical", () => timed(lexical, () => api.search({ query: "function", mode: "lexical", top: 10 })));
      if (tick % 20 === 0 && st && st.embedded > 0) {
        guarded("hybrid", () => timed(hybrid, () => api.search({ query: "where are embeddings computed for chunks", top: 10 })));
      }
      if (tick % 40 === 20) {
        guarded("similar", () =>
          timed(similar, () =>
            api.findSimilar({ code: "function add(a: number, b: number): number {\n  return a + b;\n}", lang: "ts", top: 10 }),
          ),
        );
      }
      if (st && st.embedded > 0 && firstEmbeddedAt === null) firstEmbeddedAt = now();
      if (
        !nr07Started &&
        firstEmbeddedAt !== null &&
        now() - firstEmbeddedAt >= 20_000 &&
        st &&
        st.embedded < st.chunks
      ) {
        nr07Started = true;
        guarded("nr07", runNr07);
      }
      if (tick % 4 === 0 && st) {
        timeline.push({ t: Math.round(sec), embedded: st.embedded, chunks: st.chunks, phase: st.phase, rssMb: Math.round(rss.peakTotalKb / 1024) });
      }
      if (st && st.phase === "idle" && st.chunks > 0 && st.embedded >= st.chunks && statusMs.length > 1) {
        await sleep(1100);
        const again = latest as IndexStatus;
        if (again.phase === "idle" && again.embedded >= again.chunks) break;
      }
    }

    wallEnd = now();
    if (!exitInfo) {
      const waitStart = now();
      while (inflight.size > 0 && now() - waitStart < 10_000) await sleep(100);
      if (!nr07Started) {
        nr07Started = true;
        await runNr07().catch((e) => errors.push(`nr07 probe failed: ${e instanceof Error ? e.message : e}`));
      }
      finalStatus = await api.status().catch(() => latest);
      if (finalStatus) noteStatus(finalStatus);

      if (stressFiles.length > 0) {
        const missing: string[] = [];
        for (const marker of STRESS_MARKERS) {
          const res = await api.search({ query: marker, mode: "lexical", top: 10 });
          if (!res.results.some((r) => r.path.startsWith("stress/"))) missing.push(marker);
        }
        stressIndexed = {
          name: "stress-indexed",
          status: missing.length === 0 ? "pass" : "fail",
          detail: missing.length === 0 ? `${stressFiles.length} stress files found by lexical search` : `not indexed: ${missing.join(", ")}`,
        };
      }
    }
    sampling = false;
    await rssDone;
  } catch (e) {
    hardError = e instanceof Error ? e.message : String(e);
    errors.push(`harness: ${hardError}`);
  }

  const snapshot = rss.supported ? await psSnapshot().catch(() => []) : [];
  const kids = rss.supported ? treeRss(snapshot, enginePid).pids.filter((p) => p !== enginePid) : lastPids.filter((p) => p !== enginePid);
  shuttingDown = true;
  const shutdownStart = now();
  let exitMs: number | null = null;
  if (exitedAt === null) {
    await Promise.race([api.shutdown().catch(() => {}), sleep(5000)]);
    while (exitedAt === null && now() - shutdownStart < THRESHOLDS.shutdownMs) await sleep(50);
  }
  if (exitedAt !== null) exitMs = (exitedAt as number) - shutdownStart;
  else child.kill("SIGKILL");
  await sleep(1500);
  const leftoverPids = kids.filter(alive);
  for (const pid of leftoverPids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
  conn.dispose();
  logStream.end();

  const status = (finalStatus ?? latest) as IndexStatus | null;
  const checks = evaluate({
    model,
    minEmbedded,
    chunks: status?.chunks ?? 0,
    embedded: status?.embedded ?? 0,
    exitedBeforeShutdown: exitInfo,
    errors,
    rss,
    status: statusMs,
    lexical,
    hybrid,
    similar,
    nr07Ms,
    shutdown: { exitMs, leftover: leftoverPids.length },
  });
  if (stressIndexed) checks.push(stressIndexed);
  if (hardError) checks.push({ name: "harness", status: "fail", detail: hardError });

  let indexDbBytes: number | null = null;
  try {
    if (status) indexDbBytes = statSync(join(status.indexDir, "index.db")).size;
  } catch {
    indexDbBytes = null;
  }
  const seconds = Math.max(1, (wallEnd - t0) / 1000);
  const ok = allPassed(checks);
  const report = {
    model,
    vscode: version,
    electron,
    platform,
    engine: cli,
    executable: exe,
    fixture: { kind: fixtureKind, files: status?.files ?? 0, chunks: status?.chunks ?? 0, stressFiles, indexDbBytes },
    embedded: status?.embedded ?? 0,
    phase: status?.phase ?? null,
    initializeMs: Math.round(initMs),
    observedSeconds: Math.round(seconds),
    chunksPerSec: Number(((status?.embedded ?? 0) / seconds).toFixed(2)),
    rssMb: {
      supported: rss.supported,
      peakTree: Math.round(rss.peakTotalKb / 1024),
      peakEngine: Math.round(rss.peakRootKb / 1024),
      peakInference: Math.round(rss.peakChildKb / 1024),
      enginePeakPhase: rss.rootPeakPhase,
    },
    latency: {
      status: latencyStats(statusMs),
      lexical: latencyStats(lexical.map((s) => s.ms)),
      hybridDuringIndexing: { ...latencyStats(hybrid.filter((s) => s.indexing).map((s) => s.ms)), ...searchShares(hybrid.filter((s) => s.indexing)) },
      findSimilarDuringIndexing: { ...latencyStats(similar.filter((s) => s.indexing).map((s) => s.ms)), ...searchShares(similar.filter((s) => s.indexing)) },
    },
    nr07Ms,
    phases: progressPhases,
    errors,
    exitedBeforeShutdown: exitInfo,
    shutdown: { exitMs, leftover: leftoverPids.length },
    samples: { hybrid, similar, lexical: lexical.length },
    timeline,
    checks,
    ok,
    engineLog: logPath,
  };
  writeFileSync(join(reportDir, `${stem}.json`), JSON.stringify(report, null, 2));

  const r = report.rssMb;
  const summary = `${label}: ${ok ? "PASS" : "FAIL"} chunks=${report.fixture.chunks} embedded=${report.embedded} ${report.chunksPerSec}/s rss tree=${r.peakTree}MB engine=${r.peakEngine}MB inference=${r.peakInference}MB status p95=${Math.round(report.latency.status.p95)}ms lexical p95=${Math.round(report.latency.lexical.p95)}ms hybrid p95=${Math.round(report.latency.hybridDuringIndexing.p95)}ms nr07=${nr07Ms === null ? "n/a" : Math.round(nr07Ms) + "ms"}`;
  console.log(summary);
  for (const c of checks) console.log(`  [${c.status}] ${c.name}: ${c.detail}`);
  if (!rss.supported) console.warn("  warning: RSS sampling skipped on this platform");

  rmSync(tmp, { recursive: true, force: true });
  return { model, vscode: version, ok, summary };
}

let engineTmp: string | null = null;
let failed = false;
try {
  let cli = args.engine ? resolve(args.engine) : null;
  if (!cli) {
    const built = buildEngine();
    cli = built.cli;
    engineTmp = built.tmp;
  }
  for (const model of models) {
    for (const v of args.vscode!.split(",").map((s) => s.trim()).filter(Boolean)) {
      try {
        const res = await runCombo(model, v, cli);
        if (!res.ok) failed = true;
      } catch (e) {
        failed = true;
        console.error(`${model} @ ${v}: ${e instanceof Error ? e.stack ?? e.message : e}`);
      }
    }
  }
} finally {
  if (engineTmp) rmSync(engineTmp, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
