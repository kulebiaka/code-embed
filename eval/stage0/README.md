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
  [--min-embedded <n>]        # default 300
```

Environment: `REAL_MODEL_REPORT_DIR` (default `eval/reports/real-model`), `CODE_EMBED_MODELS_DIR` (shared model directory; defaults to the engine cache), `VSCODE_TEST_CACHE` (VS Code cache, default `$TMPDIR/code-embed-vscode-test`). Each run uses temporary `CODE_EMBED_CACHE_DIR` (with a `models` link to the shared directory and an empty `emb.db`) and `CODE_EMBED_CONFIG_DIR`. If the installed VS Code does not start (for example, a broken signature), it is downloaded again. Exit code 0 means every check of every model × version combination is green.

Observation lasts until `embedded === chunks` or the end of the window (model load time is not counted). Probes: process tree RSS (`ps`, every 250 ms; skipped on Windows), `status` (1 s), lexical search (2 s), hybrid (5 s, once vectors exist), `findSimilar` (10 s), NR-07 (once, ≥ 20 s after the first vectors).

| Check | Threshold |
| --- | --- |
| `no-crash` | no engine exit before `shutdown`; no `inference process exited`, `SIGTRAP`, `SIGABRT`, `SIGSEGV` in errors |
| `progress` | `embedded ≥ min(--min-embedded, chunks)` |
| `rss` | peak tree total: 2560 MB for `qwen3-embedding-0.6b`, 1024 MB for `bge-m3`, 1024 MB for the rest (models ≤ 300M; a temporary user-approved deviation from NR-08's 700 MB) |
| `status-p95`, `lexical-p95` | ≤ 200 ms |
| `nr07` | ≤ 1000 ms from a file write to the identifier showing up in lexical search |
| `hybrid-during-indexing`, `find-similar-during-indexing` | p95 and max ≤ 1300 ms; a response slower than 800 ms must be `partial: true` with `timed out` |
| `shutdown` | exit ≤ 10 s, no children left |
| `stress-indexed` | `stress/*` files are found by lexical search (stress fixture only) |

Thresholds are constants in `real-model-report.ts`; do not relax them when the result is red — that is a product defect.

### Reading the report

The file `real-model-<model>-<vscode>-<platform>-<arch>.json` with `….engine.log` (engine stderr) next to it.

- `rssMb`: `peakTree` (total), `peakEngine` (main process), `peakInference` (`__embed-worker`), `enginePeakPhase` (the phase at which the main process peaked).
- `fixture`: files, chunks, `index.db` size; `embedded`, `chunksPerSec`.
- `latency`: percentiles for `status` and lexical search; for hybrid and `findSimilar` during indexing also `semanticShare` (share of answers with semantics) and `timedOutShare` (share of answers that timed out).
- `checks[]`: a verdict per check (`pass` / `fail` / `skip`) with details; `ok` means zero failures.
- `timeline`: indexing progress; `errors`: every `index.error` and `status.lastError`.

CI: the `real-model` job in `native-smoke.yml` (macos-14, ubuntu-22.04, windows-2022).
