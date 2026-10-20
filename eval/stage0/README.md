# Stage 0: runtime check

Checks that the engine's native and WASM dependencies load in the current runtime.

```bash
pnpm stage0                                                  # system Node
pnpm --filter @code-embed/eval exec tsx stage0/check-electron.ts   # VS Code's Electron (min from engines.vscode and stable)
```

On Linux without a display: `xvfb-run -a pnpm --filter @code-embed/eval exec tsx stage0/check-electron.ts`.
CI: `.github/workflows/native-smoke.yml` (workflow_dispatch, `v*` tags, package.json/lock changes).

Reports are JSON files in `eval/stage0/reports/` (or `STAGE0_REPORT_DIR`): `runtime-<platform>-<arch>.json`,
`electron-<version>-<platform>-<arch>.json`. The exit code is non-zero if a required check fails.

## Reading the report

- `ok` — all required checks passed; `failedRequired` — names of failed required checks; `warnings` — failed optional ones.
- `checks[].status`: `pass` / `fail` (required) / `warn` (optional); `detail` and `error` explain the result.
- Required: `node:sqlite`, `sqlite-vec:load` (`DatabaseSync({allowExtension:true})` + `loadExtension`),
  `fts5:unicode61`, `vec0:int8-knn`, `onnxruntime-node`, `@parcel/watcher`, `web-tree-sitter`, `hash-wasm`.
- Optional: `@napi-rs/keyring` (headless Linux has no secret service; this is a warning, not a failure).
- In the Electron report, the `electron` and `node` fields show the Electron version and its bundled Node.

## Decision rule (R-128, Q-28)

If `node:sqlite` or `allowExtension`/`loadExtension` does not work in at least one runtime
(system Node >= 22.13 or the Electron of the target VS Code version) on any target, storage
switches to `better-sqlite3` >= 13 behind the same storage interface (R-05), and the minimum Node version
drops to 20. Otherwise the minimum Node version from the table below is fixed.

## Results per target (filled in by a human)

| Target | Node (version) | node:sqlite + vec + FTS5 | Electron min VS Code (Electron / Node) | Electron stable (Electron / Node) | onnx / watcher / tree-sitter / hash-wasm | keyring |
| --- | --- | --- | --- | --- | --- | --- |
| win32-x64 | | | | | | |
| win32-arm64 | | | | | | |
| darwin-x64 | | | | | | |
| darwin-arm64 | | | | | | |
| linux-x64 | | | | | | |
| linux-arm64 | | | | | | |

Q-28 decision (minimum Node version, SQLite runtime): _fill in after the run_.

## Real-model smoke under VS Code's Electron (R-123, NR-08)

An opt-in regression run: the packaged engine from the VSIX is launched with the VS Code executable (macOS: `Code Helper (Plugin)`) and `ELECTRON_RUN_AS_NODE=1`, as in the extension, and indexes a fixture with a real model. The fast tests use a fake embedder and do not cover this.

```bash
pnpm build
pnpm --filter @code-embed/eval exec tsx stage0/real-model.ts \
  [--model <id[,id…]>]        # default qwen3-embedding-0.6b
  [--vscode <ver[,ver…]>]     # default stable; "min" = the minimum from engines.vscode
  [--engine <path/to/cli.js>] # default: build a VSIX for the host and unpack it
  [--repo <dir>]              # default: the stress fixture (stress-fixture.ts)
  [--minutes <n>]             # observation window, default 5
  [--projects <n>]            # engines on one machine, default 1 (integer >= 1)
  [--min-embedded <n>]        # default 300
  [--compare]                 # 1 and n projects, each with own workers and with the shared host (below)
  [--queries <n>]             # semantic queries per engine after indexing is paused, default 40
  [--threads <n>]             # index.threads for every engine (model threads); default: the engine's own (half the cores, at most 4)
```

Environment: `REAL_MODEL_REPORT_DIR` (default `eval/reports/real-model`), `CODE_EMBED_MODELS_DIR` (shared model directory; defaults to the engine cache), `VSCODE_TEST_CACHE` (VS Code cache, default `$TMPDIR/code-embed-vscode-test`). Each run uses temporary `CODE_EMBED_CACHE_DIR` (with a `models` link to the shared directory and an empty `emb.db`) and `CODE_EMBED_CONFIG_DIR`. If the installed VS Code does not start (for example, a broken signature), it is downloaded again. Exit code 0 means every check of every model × version combination is green.

`--projects <n>` starts n engines (`cli serve`), one per project (`<tmp>/project-<i>`, each a copy of the fixture with its own `git init`). All of them share the run's `CODE_EMBED_CACHE_DIR` and `CODE_EMBED_CONFIG_DIR`, which stands for "one machine": the shared inference host key includes the models directory, so with the host on the engines connect to a single host. Every engine gets its own probes, log file and checks; the observation ends when all engines are indexed or the window is over. The host is on by default. `CODE_EMBED_SHARED_HOST=0` in the run's environment (passed to the engines) turns it off: the old layout applies (an inference process per engine, `vector-slot/`) and the host checks are skipped.

Shared host accounting: the first engine starts the host (`cli.js __embed-host`) detached, so while that engine is alive the host is its child, and afterwards it is reparented to init. The host is found by the pid in `<cacheDir>/embed-host-*.lock` (it must be alive) on every RSS sample. Its tree (host + its inference process) is measured separately from the engine trees, and the host subtree is subtracted from the engine tree it hangs under, so nothing is counted twice. Without a host the accounting is the old one: the engine tree.

Observation lasts until `embedded === chunks` or the end of the window (model load time is not counted). Probes: process tree RSS (`ps`, every 250 ms; skipped on Windows), `status` (1 s), lexical search (2 s), hybrid (5 s, once vectors exist), `findSimilar` (10 s), NR-07 (once, ≥ 20 s after the first vectors).

After the window every engine gets `index.pause`, the eval waits until every engine that is not fully indexed reports the `paused` progress phase (the vector loop does so only after the batch in flight is embedded and flushed; at most 300 s), and then each engine in turn sends `--queries` semantic searches with unique texts (3 warm-up queries are not counted). Only answers with semantic hits count (the query was embedded; while the index is incomplete such answers are still `partial` with "vectors are still being built"); an engine without vectors skips the embedding and has `n = 0`. This is `latency.queryPaused`: the query embedding path without a batch in the way, which is where the host's extra socket hop shows. RSS sampling continues through it, so without the host every engine that has vectors loads its own copy of the model here, as a search in a background window does today.

### Comparison mode (`--compare`)

Runs four combinations one after another with the same VS Code and model: 1 project and n projects (n = `--projects`, or 3 when it is 1), each first with own workers (`CODE_EMBED_SHARED_HOST=0` passed to the engines) and then with the shared host (`CODE_EMBED_SHARED_HOST=1`); the variable in the eval's own environment is ignored. Each combination is a regular run with its own temporary cache directory and report (`…-own.json`, `…-host.json`, with `-p<n>` for several projects). Only the shared-host runs gate the exit code: with own workers and several projects `vector-slot/` lets one project index at a time, so their `progress` check fails by design and they serve as the baseline.

```bash
pnpm build
pnpm --filter @code-embed/eval exec tsx stage0/real-model.ts --compare   # 1 and 3 projects, ~25 min
```

The result is `real-model-<model>-<vscode>-<platform>-<arch>-compare.json`: `rows[]` (per combination: `projects`, `sharedHost`, `ok`, `rssMb { peakTotal, peakHost, maxEngine, limit }`, `embedded` per engine, pooled `query` and `hybridDuringIndexing` latency) and `hostMinusOwn[]` (per project count: the difference in query p50/p95 and in peak total RSS). The same table is printed at the end.

| Check | Threshold |
| --- | --- |
| `no-crash` | no engine exit before `shutdown`; no `inference process exited`, `SIGTRAP`, `SIGABRT`, `SIGSEGV` in errors; the host pid did not change during the run (`host restarted: <old> → <new>`) |
| `progress` | `embedded ≥ min(--min-embedded, chunks)` |
| `rss` | limit L: 2560 MB for `qwen3-embedding-0.6b`, 1024 MB for `bge-m3`, 1024 MB for the rest (models ≤ 300M; a temporary user-approved deviation from NR-08's 700 MB). One project: peak host tree + peak engine tree (without the host) ≤ L; with no host this is the old peak tree total. Several projects (n): peak host tree + Σ peak engine tree (without the host) ≤ L + n × max peak RSS of an engine process (without children) in the same run |
| `rss-host` | peak host tree (host + inference process) ≤ L; `skip` when no host was observed |
| `status-p95`, `lexical-p95` | ≤ 200 ms |
| `nr07` | ≤ 1000 ms from a file write to the identifier showing up in lexical search |
| `hybrid-during-indexing`, `find-similar-during-indexing` | p95 and max ≤ 1300 ms; a response slower than 800 ms must be `partial: true` with `timed out` |
| `shutdown` | every engine exits ≤ 10 s, no children left except the shared host |
| `shutdown-host` | after the engines exit the eval sends the host `SIGTERM`; the host and every pid of its last observed tree are gone ≤ 10 s; `skip` without a host. Anything still alive is then `SIGKILL`ed |
| `stress-indexed` | `stress/*` files are found by lexical search (stress fixture only) |
| `host-used` | only when the host is enabled: a live host was found by its lock in the run's cache directory (otherwise the engines fell back to their own workers or joined someone else's host) |
| `inference-processes` | only when the host is enabled: the `ps` samples (every 250 ms, as for RSS) show at most one `__embed-worker` under the host in any sample and none under an engine process; `skip` when nothing was sampled |
| `leftover-processes` | after all shutdowns no `__embed-host` / `__embed-worker` process started from this run's `cli.js` is alive (found by command line in `ps`; any found are `SIGKILL`ed). The same sweep runs on `SIGINT`/`SIGTERM` of the eval |

With `--projects` greater than 1 the per-engine checks are named `p<i>:<check>` (`p1:status-p95`, …); `rss`, `rss-host`, `shutdown-host`, `host-used`, `inference-processes` and `leftover-processes`, the host-restart failure (`no-crash`) are machine-wide and unprefixed. The status, lexical, hybrid, `findSimilar` and NR-07 thresholds are the same as for one project.

Thresholds are constants in `real-model-report.ts`; do not relax them when the result is red — that is a product defect.

### Reading the report

The file `real-model-<model>-<vscode>-<platform>-<arch>.json` with `….engine.log` (engine stderr) next to it. With `--projects n` (n > 1) the name gets the suffix `-p<n>` and there is one `….engine-<i>.log` per engine.

- `rssMb`: `peakTotal` (the largest sum of the host tree and all engine trees within one sample, i.e. what the machine actually held; the `rss` check uses the sum of the separate peaks, which is never lower), `peakTree` (host peak + engine tree peak), `peakEngine` (main process), `peakInference` (inference children of the engine itself; zero when the host runs the model), `enginePeakPhase` (the phase at which the main process peaked), `peakHost` (host tree peak).
- `host`: `{ pid, peakTreeMb, shutdown }`, or `null` when no host was observed.
- With `--projects n` (n > 1): `projects`, `host`, `engines[]` (per engine: `fixture`, `embedded`, `chunks`, `rssMb { peakTree, peakEngine, … }`, `latency`, `nr07Ms`, `engineLog`, …) and `rssMb { peakTotal, peakHost, sumEngineTrees, maxEngine, limit }`.
- `fixture`: files, chunks, `index.db` size; `embedded`, `chunksPerSec`.
- `latency`: percentiles for `status` and lexical search; `queryPaused` for the semantic queries after the pause; for hybrid and `findSimilar` during indexing also `semanticShare` (share of answers with semantics) and `timedOutShare` (share of answers that timed out).
- `checks[]`: a verdict per check (`pass` / `fail` / `skip`) with details; `ok` means zero failures.
- `timeline`: indexing progress; `errors`: every `index.error` and `status.lastError`.

Example, three projects on one machine (one shared host, the default):

```bash
pnpm --filter @code-embed/eval exec tsx stage0/real-model.ts --projects 3
```

CI: the `real-model` job in `native-smoke.yml` (macos-14, ubuntu-22.04, windows-2022).
