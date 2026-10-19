import { execFile, spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  createWriteStream,
  type WriteStream,
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
import { isProcessAlive, readLockPid } from "../../packages/engine/src/core/lock";
import { modelsDir } from "../../packages/engine/src/core/paths";
import {
  THRESHOLDS,
  allPassed,
  evaluate,
  latencyStats,
  newPeaks,
  parsePs,
  recordSample,
  rssLimitMb,
  searchShares,
  splitRss,
  strayInference,
  type CheckVerdict,
  type EngineObs,
  type HostObs,
  type Latency,
  type Phase,
  type RssPeaks,
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
    projects: { type: "string", default: "1" },
    compare: { type: "boolean", default: false },
    queries: { type: "string", default: "40" },
    threads: { type: "string" },
    "min-embedded": { type: "string", default: String(THRESHOLDS.defaultMinEmbedded) },
  },
});

const models = args.model!.split(",").map((s) => s.trim()).filter(Boolean);
const minutes = Number(args.minutes);
const minEmbedded = Number(args["min-embedded"]);
const projectsArg = Number(args.projects);
if (!Number.isInteger(projectsArg) || projectsArg < 1) {
  console.error(`--projects must be an integer >= 1, got "${args.projects}"`);
  process.exit(2);
}
const queryCount = Number(args.queries);
const threads = args.threads === undefined ? undefined : Number(args.threads);
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

async function sweepStrays(cli: string): Promise<number[]> {
  if (process.platform === "win32") return [];
  const { stdout } = await run("ps", ["-A", "-o", "pid=,command="], { maxBuffer: 32 * 1024 * 1024 });
  const pids = strayInference(stdout, cli);
  for (const pid of pids) kill(pid, "SIGKILL");
  return pids;
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
  projects: number;
  sharedHost: boolean;
  ok: boolean;
  summary: string;
  rssMb: { peakTotal: number; peakHost: number; maxEngine: number; limit: number };
  query: ReturnType<typeof latencyStats>;
  hybridDuringIndexing: ReturnType<typeof latencyStats>;
  embedded: number[];
}

interface ComboOpts {
  projects: number;
  // null: inherit CODE_EMBED_SHARED_HOST from the environment
  sharedHost: boolean | null;
}

type Conn = ReturnType<typeof jsonrpc.createMessageConnection>;

interface Engine {
  index: number;
  root: string;
  fixtureKind: string;
  stressFiles: string[];
  logPath: string;
  logStream: WriteStream;
  child: ChildProcess;
  pid: number;
  conn: Conn;
  api: EngineApi;
  shuttingDown: boolean;
  exitInfo: { code: number | null; signal: string | null } | null;
  exitedAt: number | null;
  exitedEarly: Promise<never>;
  errors: string[];
  progressPhases: string[];
  latest: IndexStatus | null;
  finalStatus: IndexStatus | null;
  statusMs: number[];
  lexical: Latency[];
  hybrid: Latency[];
  similar: Latency[];
  query: number[];
  timeline: { t: number; embedded: number; chunks: number; phase: string; rssMb: number }[];
  t0: number;
  wallEnd: number;
  initMs: number;
  nr07Ms: number | null;
  stressIndexed: CheckVerdict | null;
  hardError: string | null;
  exitMs: number | null;
}

interface Machine {
  exe: string;
  cli: string;
  cacheDir: string;
  configDir: string;
  tmp: string;
  multi: boolean;
  sharedHost: boolean | null;
  stem: string;
  peaks: RssPeaks;
}

function findHostPid(cacheDir: string): number | null {
  let names: string[];
  try {
    names = readdirSync(cacheDir).filter((n) => /^embed-host-.*\.lock$/.test(n)).sort();
  } catch {
    return null;
  }
  for (const name of names) {
    const pid = readLockPid(cacheDir, name);
    if (pid !== null && isProcessAlive(pid)) return pid;
  }
  return null;
}

function startEngine(index: number, m: Machine): Engine {
  const root = join(m.tmp, m.multi ? `project-${index + 1}` : "project");
  mkdirSync(root, { recursive: true });
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

  const logPath = join(reportDir, m.multi ? `${m.stem}.engine-${index + 1}.log` : `${m.stem}.engine.log`);
  const logStream = createWriteStream(logPath);
  const env: NodeJS.ProcessEnv = { ...process.env, ELECTRON_RUN_AS_NODE: "1", CODE_EMBED_CACHE_DIR: m.cacheDir, CODE_EMBED_CONFIG_DIR: m.configDir };
  if (m.sharedHost === true) env.CODE_EMBED_SHARED_HOST = "1";
  if (m.sharedHost === false) delete env.CODE_EMBED_SHARED_HOST;
  const child = spawn(m.exe, [m.cli, "serve"], {
    cwd: root,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stderr!.pipe(logStream);

  const e = {
    index,
    root,
    fixtureKind,
    stressFiles,
    logPath,
    logStream,
    child,
    pid: child.pid!,
    shuttingDown: false,
    exitInfo: null,
    exitedAt: null,
    errors: [],
    progressPhases: [],
    latest: null,
    finalStatus: null,
    statusMs: [],
    lexical: [],
    hybrid: [],
    similar: [],
    query: [],
    timeline: [],
    t0: now(),
    wallEnd: 0,
    initMs: 0,
    nr07Ms: null,
    stressIndexed: null,
    hardError: null,
    exitMs: null,
  } as unknown as Engine;
  e.wallEnd = e.t0;

  let onExit!: () => void;
  e.exitedEarly = new Promise<never>((_, reject) => {
    onExit = () => reject(new Error("engine exited before the request completed"));
  });
  e.exitedEarly.catch(() => {});
  child.on("exit", (code, signal) => {
    e.exitedAt = now();
    if (!e.shuttingDown) onExit();
    if (!e.shuttingDown) e.exitInfo = { code, signal };
  });
  child.on("error", (err) => {
    if (!e.shuttingDown) e.exitInfo = { code: null, signal: `spawn error: ${err.message}` };
  });

  e.conn = jsonrpc.createMessageConnection(
    new jsonrpc.StreamMessageReader(child.stdout!),
    new jsonrpc.StreamMessageWriter(child.stdin!),
  );
  e.conn.onError(() => {});
  e.conn.onClose(() => {});
  e.conn.listen();
  e.api = createEngineProxy(e.conn);
  e.api.onIndexError((err) => e.errors.push(err.message));
  e.api.onProgress((p) => {
    if (e.progressPhases[e.progressPhases.length - 1] !== p.phase) e.progressPhases.push(p.phase);
  });
  return e;
}

async function observeEngine(e: Engine, model: string, m: Machine): Promise<void> {
  const { api, root, errors, statusMs, lexical, hybrid, similar } = e;
  const noteStatus = (s: IndexStatus) => {
    e.latest = s;
    if (s.lastError && !errors.includes(s.lastError)) errors.push(s.lastError);
  };
  e.t0 = now();
  let windowStart = e.t0;

  try {
    const init = await Promise.race([
      api.initialize({
        root,
        clientName: "real-model-smoke",
        protocolVersion: PROTOCOL_VERSION,
        settings: { model: { id: model }, ...(threads === undefined ? {} : { index: { threads } }) },
      }),
      e.exitedEarly,
    ]);
    e.initMs = now() - e.t0;
    noteStatus(init.index);

    let firstEmbeddedAt: number | null = null;
    let nr07Started = false;
    const inflight = new Set<string>();
    const guarded = (key: string, fn: () => Promise<void>) => {
      if (inflight.has(key)) return;
      inflight.add(key);
      void fn().catch((err) => errors.push(`${key} probe failed: ${err instanceof Error ? err.message : err}`)).finally(() => inflight.delete(key));
    };
    const timed = async <T extends { partial?: boolean; partialReason?: string }>(
      list: Latency[],
      call: () => Promise<T>,
    ) => {
      const indexing = e.latest !== null && e.latest.embedded < e.latest.chunks;
      const s = now();
      const res = await call();
      list.push({ ms: now() - s, indexing, partial: res.partial, partialReason: res.partialReason });
    };

    const nr07File = firstTsFile(root);
    const runNr07 = async () => {
      if (!nr07File) return;
      const ident = `nr07Marker${Date.now().toString(36)}`;
      appendFileSync(join(root, nr07File), `\nexport function ${ident}(): number {\n  return 7;\n}\n`);
      const s = now();
      while (now() - s < 5000) {
        const res = await api.search({ query: ident, mode: "lexical", top: 5 });
        if (res.results.length > 0) {
          e.nr07Ms = now() - s;
          return;
        }
        await sleep(50);
      }
    };

    for (let tick = 0; ; tick++) {
      await sleep(250);
      if (e.exitInfo) break;
      const st = e.latest;
      if (st?.phase === "model-download") windowStart = now();
      if (now() - windowStart > minutes * 60_000) break;
      const sec = tick / 4;

      if (tick % 4 === 0) {
        guarded("status", async () => {
          const s = now();
          const res = await api.status();
          statusMs.push(now() - s);
          noteStatus(res);
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
        const peak = m.peaks.engines[e.index]!;
        e.timeline.push({
          t: Math.round(sec),
          embedded: st.embedded,
          chunks: st.chunks,
          phase: st.phase,
          rssMb: Math.round((m.peaks.hostKb + peak.treeKb) / 1024),
        });
      }
      if (st && st.phase === "idle" && st.chunks > 0 && st.embedded >= st.chunks && statusMs.length > 1) {
        await sleep(1100);
        const again = e.latest as IndexStatus;
        if (again.phase === "idle" && again.embedded >= again.chunks) break;
      }
    }

    e.wallEnd = now();
    if (!e.exitInfo) {
      const waitStart = now();
      while (inflight.size > 0 && now() - waitStart < 10_000) await sleep(100);
      if (!nr07Started) {
        nr07Started = true;
        await runNr07().catch((err) => errors.push(`nr07 probe failed: ${err instanceof Error ? err.message : err}`));
      }
      e.finalStatus = await api.status().catch(() => e.latest);
      if (e.finalStatus) noteStatus(e.finalStatus);

      if (e.stressFiles.length > 0) {
        const missing: string[] = [];
        for (const marker of STRESS_MARKERS) {
          const res = await api.search({ query: marker, mode: "lexical", top: 10 });
          if (!res.results.some((r) => r.path.startsWith("stress/"))) missing.push(marker);
        }
        e.stressIndexed = {
          name: "stress-indexed",
          status: missing.length === 0 ? "pass" : "fail",
          detail: missing.length === 0 ? `${e.stressFiles.length} stress files found by lexical search` : `not indexed: ${missing.join(", ")}`,
        };
      }
    }
  } catch (err) {
    e.hardError = err instanceof Error ? err.message : String(err);
    errors.push(`harness: ${e.hardError}`);
    e.wallEnd = now();
  }
}

const QUERIES = [
  "where are embeddings computed for chunks",
  "parse command line arguments",
  "open the sqlite database",
  "retry a failed request with backoff",
  "watch files for changes",
];

// Pause indexing so query latency is not dominated by a running batch. The vector loop reports "paused" only after
// the batch in flight is embedded and flushed, which with few threads takes minutes; a fully indexed engine never does.
async function pauseAll(engines: Engine[]): Promise<void> {
  const live = engines.filter((e) => !e.exitInfo && !e.hardError);
  await Promise.all(live.map((e) => e.api.pause().catch(() => {})));
  const start = now();
  for (;;) {
    const sts = await Promise.all(live.map((e) => e.api.status().catch(() => null)));
    const waiting = live.filter((e, i) => {
      const st = sts[i];
      if (e.exitInfo || !st || st.embedded >= st.chunks) return false;
      return e.progressPhases[e.progressPhases.length - 1] !== "paused";
    });
    if (waiting.length === 0) return;
    if (now() - start > 300_000) {
      for (const e of waiting) e.errors.push("query probe: vector loop did not pause within 300 s");
      return;
    }
    await sleep(500);
  }
}

// Only answers with semantic hits count (the query was embedded); an unfinished index is still partial ("vectors are still being built"), an engine without vectors skips the embedding.
async function probeQueries(e: Engine): Promise<void> {
  if (e.exitInfo || e.hardError) return;
  try {
    for (let i = -3; i < queryCount; i++) {
      const s = now();
      const res = await e.api.search({ query: `${QUERIES[(i + 3) % QUERIES.length]} ${e.index}.${i}`, mode: "semantic", top: 10 });
      if (i >= 0 && res.results.some((r) => r.sources.includes("semantic"))) e.query.push(now() - s);
    }
  } catch (err) {
    e.errors.push(`query probe failed: ${err instanceof Error ? err.message : err}`);
  }
}

async function shutdownEngine(e: Engine): Promise<void> {
  e.shuttingDown = true;
  const start = now();
  if (e.exitedAt === null) {
    await Promise.race([e.api.shutdown().catch(() => {}), sleep(5000)]);
    while (e.exitedAt === null && now() - start < THRESHOLDS.shutdownMs) await sleep(50);
  }
  if (e.exitedAt !== null) e.exitMs = e.exitedAt - start;
  else e.child.kill("SIGKILL");
}

function kill(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch {
    // already gone
  }
}

async function runCombo(model: string, versionArg: string, cli: string, opts: ComboOpts): Promise<ComboResult> {
  const { projects, sharedHost } = opts;
  const version = versionArg === "min" ? minVersionFromRange(
    (JSON.parse(readFileSync(extensionPkg, "utf8")) as { engines: { vscode: string } }).engines.vscode,
  ) : versionArg;
  const hostWanted = sharedHost ?? process.env.CODE_EMBED_SHARED_HOST === "1";
  const hostLabel = sharedHost === null ? "" : sharedHost ? ", shared host" : ", own workers";
  const label = `${model} @ VS Code ${version}${projects > 1 ? ` x${projects} projects` : ""}${hostLabel}`;
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
  const cacheDir = join(tmp, "cache");
  const configDir = join(tmp, "config");
  for (const d of [cacheDir, configDir, sharedModels]) mkdirSync(d, { recursive: true });
  symlinkSync(sharedModels, join(cacheDir, "models"), "junction");

  mkdirSync(reportDir, { recursive: true });
  const multi = projects > 1;
  const hostSuffix = sharedHost === null ? "" : sharedHost ? "-host" : "-own";
  const stem = `real-model-${model}-${version}-${process.platform}-${process.arch}${multi ? `-p${projects}` : ""}${hostSuffix}`;
  const rssSupported = process.platform !== "win32";
  const m: Machine = { exe, cli, cacheDir, configDir, tmp, multi, sharedHost, stem, peaks: newPeaks(projects) };

  const engines = Array.from({ length: projects }, (_, i) => startEngine(i, m));
  const enginePids = engines.map((e) => e.pid);

  let sampling = rssSupported;
  const rssLoop = async () => {
    while (sampling) {
      try {
        const hostPid = findHostPid(cacheDir);
        const split = splitRss(await psSnapshot(), enginePids, hostPid);
        recordSample(m.peaks, split, hostPid, engines.map((e) => (e.latest ? toPhase(e.latest.phase) : null)));
      } catch {
        // ps may fail transiently
      }
      await sleep(250);
    }
  };
  const rssDone = rssLoop();

  await Promise.all(engines.map((e) => observeEngine(e, model, m)));
  await pauseAll(engines);
  for (const e of engines) await probeQueries(e);
  sampling = false;
  await rssDone;

  const hostPidNow = rssSupported ? findHostPid(cacheDir) : null;
  const snapshot = rssSupported ? await psSnapshot().catch(() => []) : [];
  const split = splitRss(snapshot, enginePids, hostPidNow);
  const kids = split.engines.map((t, i) => t.pids.filter((p) => p !== engines[i]!.pid));

  await Promise.all(engines.map(shutdownEngine));
  await sleep(1500);
  const leftoverPids = kids.map((list) => list.filter(alive));
  for (const pid of leftoverPids.flat()) kill(pid, "SIGKILL");

  const { peaks } = m;
  let hostShutdown: HostObs["shutdown"] = { exitMs: null, leftover: 0 };
  if (peaks.hostPid !== null) {
    const hostPids = [...new Set([peaks.hostPid, ...peaks.hostPids])];
    const start = now();
    if (alive(peaks.hostPid)) kill(peaks.hostPid, "SIGTERM");
    let left = hostPids.filter(alive);
    while (left.length > 0 && now() - start < THRESHOLDS.shutdownMs) {
      await sleep(100);
      left = hostPids.filter(alive);
    }
    hostShutdown = { exitMs: left.length === 0 ? now() - start : null, leftover: left.length };
    for (const pid of left) kill(pid, "SIGKILL");
  }
  const strays = await sweepStrays(cli).catch(() => []);
  for (const e of engines) {
    e.conn.dispose();
    e.logStream.end();
  }

  const statusOf = (e: Engine) => e.finalStatus ?? e.latest;
  const host: HostObs | null =
    peaks.hostPid !== null
      ? { firstPid: peaks.hostFirstPid!, pid: peaks.hostPid, peakTreeKb: peaks.hostKb, shutdown: hostShutdown }
      : null;
  const obs: EngineObs[] = engines.map((e, i) => ({
    chunks: statusOf(e)?.chunks ?? 0,
    embedded: statusOf(e)?.embedded ?? 0,
    exitedBeforeShutdown: e.exitInfo,
    errors: e.errors,
    rss: {
      peakTreeKb: peaks.engines[i]!.treeKb,
      peakEngineKb: peaks.engines[i]!.engineKb,
      peakChildKb: peaks.engines[i]!.childKb,
      peakPhase: peaks.engines[i]!.phase,
    },
    status: e.statusMs,
    lexical: e.lexical,
    hybrid: e.hybrid,
    similar: e.similar,
    nr07Ms: e.nr07Ms,
    shutdown: { exitMs: e.exitMs, leftover: leftoverPids[i]!.length },
  }));
  const checks = evaluate({ model, minEmbedded, rssSupported, engines: obs, host });
  engines.forEach((e, i) => {
    const prefix = multi ? `p${i + 1}:` : "";
    if (e.stressIndexed) checks.push({ ...e.stressIndexed, name: prefix + e.stressIndexed.name });
    if (e.hardError) checks.push({ name: `${prefix}harness`, status: "fail", detail: e.hardError });
  });
  if (hostWanted) {
    checks.push({
      name: "host-used",
      status: host ? "pass" : "fail",
      detail: host ? `shared host pid ${host.pid}` : "CODE_EMBED_SHARED_HOST=1 but no host lock in the run's cache directory",
    });
  }
  checks.push({
    name: "leftover-processes",
    status: strays.length === 0 ? "pass" : "fail",
    detail: strays.length === 0 ? "no __embed-host / __embed-worker of this run left" : `killed leftover pids ${strays.join(", ")}`,
  });
  const ok = allPassed(checks);

  const mbOf = (kb: number) => Math.round(kb / 1024);
  const engineReports = engines.map((e, i) => {
    const status = statusOf(e);
    let indexDbBytes: number | null = null;
    try {
      if (status) indexDbBytes = statSync(join(status.indexDir, "index.db")).size;
    } catch {
      indexDbBytes = null;
    }
    const seconds = Math.max(1, (e.wallEnd - e.t0) / 1000);
    return {
      fixture: { kind: e.fixtureKind, files: status?.files ?? 0, chunks: status?.chunks ?? 0, stressFiles: e.stressFiles, indexDbBytes },
      embedded: status?.embedded ?? 0,
      chunks: status?.chunks ?? 0,
      phase: status?.phase ?? null,
      initializeMs: Math.round(e.initMs),
      observedSeconds: Math.round(seconds),
      chunksPerSec: Number(((status?.embedded ?? 0) / seconds).toFixed(2)),
      rssMb: {
        peakTree: mbOf(peaks.engines[i]!.treeKb),
        peakEngine: mbOf(peaks.engines[i]!.engineKb),
        peakInference: mbOf(peaks.engines[i]!.childKb),
        enginePeakPhase: peaks.engines[i]!.phase,
      },
      latency: {
        status: latencyStats(e.statusMs),
        lexical: latencyStats(e.lexical.map((s) => s.ms)),
        hybridDuringIndexing: { ...latencyStats(e.hybrid.filter((s) => s.indexing).map((s) => s.ms)), ...searchShares(e.hybrid.filter((s) => s.indexing)) },
        findSimilarDuringIndexing: { ...latencyStats(e.similar.filter((s) => s.indexing).map((s) => s.ms)), ...searchShares(e.similar.filter((s) => s.indexing)) },
        queryPaused: latencyStats(e.query),
      },
      nr07Ms: e.nr07Ms,
      phases: e.progressPhases,
      errors: e.errors,
      exitedBeforeShutdown: e.exitInfo,
      shutdown: obs[i]!.shutdown,
      samples: { hybrid: e.hybrid, similar: e.similar, lexical: e.lexical.length },
      timeline: e.timeline,
      engineLog: e.logPath,
    };
  });
  const hostReport = host ? { pid: host.pid, peakTreeMb: mbOf(host.peakTreeKb), shutdown: host.shutdown } : null;
  const limit = rssLimitMb(model);
  const common = { model, vscode: version, electron, platform, engine: cli, executable: exe };
  let report: object;
  if (!multi) {
    const er = engineReports[0]!;
    report = {
      ...common,
      fixture: er.fixture,
      embedded: er.embedded,
      phase: er.phase,
      initializeMs: er.initializeMs,
      observedSeconds: er.observedSeconds,
      chunksPerSec: er.chunksPerSec,
      sharedHost: hostWanted,
      rssMb: {
        supported: rssSupported,
        peakTree: mbOf(peaks.hostKb + peaks.engines[0]!.treeKb),
        peakTotal: mbOf(peaks.totalKb),
        peakEngine: er.rssMb.peakEngine,
        peakInference: er.rssMb.peakInference,
        enginePeakPhase: er.rssMb.enginePeakPhase,
        peakHost: mbOf(peaks.hostKb),
      },
      host: hostReport,
      latency: er.latency,
      nr07Ms: er.nr07Ms,
      phases: er.phases,
      errors: er.errors,
      exitedBeforeShutdown: er.exitedBeforeShutdown,
      shutdown: er.shutdown,
      samples: er.samples,
      timeline: er.timeline,
      checks,
      ok,
      engineLog: er.engineLog,
    };
  } else {
    report = {
      ...common,
      projects,
      sharedHost: hostWanted,
      host: hostReport,
      engines: engineReports,
      rssMb: {
        supported: rssSupported,
        peakTotal: mbOf(peaks.totalKb),
        peakHost: mbOf(peaks.hostKb),
        sumEngineTrees: mbOf(peaks.engines.reduce((s, p) => s + p.treeKb, 0)),
        maxEngine: mbOf(Math.max(...peaks.engines.map((p) => p.engineKb))),
        limit,
      },
      checks,
      ok,
    };
  }
  writeFileSync(join(reportDir, `${stem}.json`), JSON.stringify(report, null, 2));

  const hostText = host ? `host=${mbOf(host.peakTreeKb)}MB` : "host=none";
  const engineText = engineReports
    .map((er, i) => {
      const tag = multi ? `p${i + 1} ` : "";
      return `${tag}chunks=${er.chunks} embedded=${er.embedded} ${er.chunksPerSec}/s engine=${er.rssMb.peakEngine}MB tree=${er.rssMb.peakTree}MB status p95=${Math.round(er.latency.status.p95)}ms lexical p95=${Math.round(er.latency.lexical.p95)}ms hybrid p95=${Math.round(er.latency.hybridDuringIndexing.p95)}ms query p50/p95=${Math.round(er.latency.queryPaused.p50)}/${Math.round(er.latency.queryPaused.p95)}ms nr07=${er.nr07Ms === null ? "n/a" : Math.round(er.nr07Ms) + "ms"}`;
    })
    .join("\n    ");
  const summary = `${label}: ${ok ? "PASS" : "FAIL"} rss total=${mbOf(peaks.totalKb)}MB ${hostText} limit=${limit}MB\n    ${engineText}`;
  console.log(summary);
  for (const c of checks) console.log(`  [${c.status}] ${c.name}: ${c.detail}`);
  if (!rssSupported) console.warn("  warning: RSS sampling skipped on this platform");

  rmSync(tmp, { recursive: true, force: true });
  return {
    model,
    vscode: version,
    projects,
    sharedHost: hostWanted,
    ok,
    summary,
    rssMb: { peakTotal: mbOf(peaks.totalKb), peakHost: mbOf(peaks.hostKb), maxEngine: mbOf(Math.max(...peaks.engines.map((p) => p.engineKb))), limit },
    query: latencyStats(engines.flatMap((e) => e.query)),
    hybridDuringIndexing: latencyStats(engines.flatMap((e) => e.hybrid.filter((x) => x.indexing).map((x) => x.ms))),
    embedded: engineReports.map((er) => er.embedded),
  };
}

function writeComparison(model: string, results: ComboResult[]): void {
  const round = (n: number) => (Number.isNaN(n) ? null : Number(n.toFixed(1)));
  const rows = results.map((r) => ({
    projects: r.projects,
    sharedHost: r.sharedHost,
    ok: r.ok,
    rssMb: r.rssMb,
    embedded: r.embedded,
    query: { n: r.query.n, p50: round(r.query.p50), p95: round(r.query.p95), max: round(r.query.max) },
    hybridDuringIndexing: { n: r.hybridDuringIndexing.n, p50: round(r.hybridDuringIndexing.p50), p95: round(r.hybridDuringIndexing.p95) },
  }));
  const deltas = [...new Set(results.map((r) => r.projects))].map((n) => {
    const own = results.find((r) => r.projects === n && !r.sharedHost);
    const host = results.find((r) => r.projects === n && r.sharedHost);
    return {
      projects: n,
      queryP50Ms: own && host ? round(host.query.p50 - own.query.p50) : null,
      queryP95Ms: own && host ? round(host.query.p95 - own.query.p95) : null,
      peakTotalMb: own && host ? host.rssMb.peakTotal - own.rssMb.peakTotal : null,
    };
  });
  const vscode = results[0]?.vscode ?? "unknown";
  const file = join(reportDir, `real-model-${model}-${vscode}-${process.platform}-${process.arch}-compare.json`);
  writeFileSync(file, JSON.stringify({ model, vscode, platform, queries: queryCount, rows, hostMinusOwn: deltas }, null, 2));
  console.log(`\n=== ${model} @ VS Code ${vscode}: shared host vs own workers ===`);
  for (const r of rows) {
    console.log(
      `  ${r.projects} project(s), ${r.sharedHost ? "shared host " : "own workers "}: ${r.ok ? "PASS" : "FAIL"} peak total ${r.rssMb.peakTotal} MB (host ${r.rssMb.peakHost} MB, max engine ${r.rssMb.maxEngine} MB), query p50/p95 ${r.query.p50}/${r.query.p95} ms (n=${r.query.n}), embedded ${r.embedded.join("/")}`,
    );
  }
  for (const d of deltas) console.log(`  ${d.projects} project(s), host - own: query p50 ${d.queryP50Ms} ms, p95 ${d.queryP95Ms} ms, peak total ${d.peakTotalMb} MB`);
  console.log(`  report: ${file}`);
}

// --compare: 1 and n projects (n = --projects, or 3), each with own workers and with the shared host.
// Own-worker runs are the baseline and do not gate the exit code: with several projects vector-slot/ lets only one index.
const plan: (ComboOpts & { gating: boolean })[] = args.compare
  ? [1, projectsArg > 1 ? projectsArg : 3].flatMap((projects) => [
      { projects, sharedHost: false, gating: false },
      { projects, sharedHost: true, gating: true },
    ])
  : [{ projects: projectsArg, sharedHost: null, gating: true }];

let engineTmp: string | null = null;
let cli = args.engine ? resolve(args.engine) : null;
let failed = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void (cli ? sweepStrays(cli).catch(() => []) : Promise.resolve([])).finally(() => process.exit(130));
  });
}
try {
  if (!cli) {
    const built = buildEngine();
    cli = built.cli;
    engineTmp = built.tmp;
  }
  for (const model of models) {
    for (const v of args.vscode!.split(",").map((s) => s.trim()).filter(Boolean)) {
      const results: ComboResult[] = [];
      for (const opts of plan) {
        try {
          const res = await runCombo(model, v, cli, opts);
          results.push(res);
          if (!res.ok && opts.gating) failed = true;
        } catch (e) {
          failed = true;
          console.error(`${model} @ ${v}: ${e instanceof Error ? e.stack ?? e.message : e}`);
        }
      }
      if (args.compare) writeComparison(model, results);
    }
  }
} finally {
  if (engineTmp) rmSync(engineTmp, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
