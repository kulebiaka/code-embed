# Architecture

## Monorepo

- `packages/protocol`: JSON-RPC and tool types (`search`, `find_similar`).
- `packages/engine`: engine and CLI, npm package `code-embed`.
- `packages/extension`: VS Code extension (VSIX with the engine bundled).
- `eval/`: quality evaluation, see [eval/README.md](../eval/README.md).

## Engine

A `code-embed` Node process running as `serve` (JSON-RPC for the extension), `daemon` (engine + socket + watcher), `mcp` (stdio MCP) or as CLI commands. Clients talk to the engine over JSON-RPC. Logs go to stderr only.

## Index

Project root: the directory the index is built for. Index: `.code-embed/` in the root (`index.db`, `meta.json`, `lock`) or in the user cache (`index.location`). `index.db` is SQLite with FTS5 (lexical) and sqlite-vec (vectors). The global embedding cache `emb.db` in the cache directory is reused across projects; `code-embed gc` cleans out unused entries.

## Indexing

1. The scanner walks the project (`.gitignore`, `.ignore`, `exclude`), skipping binary, minified, oversized and generated files as well as lock files.
2. The chunker splits files into chunks: functions, methods, classes, declarations (tree-sitter via WASM), Markdown sections, and windows for everything else.
3. The lexical phase fills FTS5; search already works after it.
4. The vector phase computes chunk embeddings (local model or provider) and writes them to sqlite-vec. Model identifier: `<provider>/<model>@<dims>`.

## Search

Hybrid search: BM25 and kNN run separately and are merged with RRF (k = 60). The `semantic` and `lexical` modes use one of the two. By default the index is updated before each search (`--no-update` turns that off).

## Embeddings

The `local` provider runs an ONNX model from the catalog (`models.json`: revision and sha256 of every file). Other providers are OpenAI-compatible APIs; external ones require consent (`consents.toml`).

### Inference process

By default the local (non-static) model runs in a machine-wide inference host, `cli.js __embed-host`, shared by every window, daemon, MCP server and CLI (see [Shared inference host](#shared-inference-host)); `vector-slot/` is not used then. With `CODE_EMBED_SHARED_HOST=0` the model runs in a child process of the engine instead, `cli.js __embed-worker`, with lowered priority (`PRIORITY_BELOW_NORMAL`), so the engine's JSON-RPC is never blocked by inference, and local indexing goes through the `vector-slot/` queue (one project per machine). If the host cannot be used, the engine falls back to its own worker and the slot. Static models run inside the engine process, and remote providers do not take part. Either way requests are prioritized: search and "Find Similar" requests overtake documents from interactive files, which in turn overtake background indexing.

- Memory is bounded three ways: inference is split into sub-batches by token budget (at most 16 texts, 1024 tokens per batch), input is truncated to 1024 tokens, and the ONNX Runtime session has the CPU arena disabled (`enableCpuMemArena: false`). Only pooled outputs are read from the model.
- Memory budget (NR-08 with an approved deviation): for `qwen3-embedding-0.6b` the ceiling is 2560 MB for the engine process plus the inference process combined (through the host: the host with its inference process plus the engine processes, checked as described in [Real-model smoke test](#real-model-smoke-test)); for models up to 300M parameters 1024 MB (a temporary user-approved deviation from NR-08's 700 MB, with small-model memory optimization deferred); for `bge-m3` 1024 MB.
- While the vector phase is running, `search` (hybrid and semantic modes) and "Find Similar" have an 800 ms response budget counted from the start of the request (`INDEXING_EMBED_TIMEOUT_MS`). The query or fragment embedding must arrive within the first 7/8 of it (700 ms, minus whatever reading the range already took); the rest is kept for the lexical fallback, vector candidates and building the response. Otherwise the response is built from lexical results with `partial: true`, and `partialReason` contains `timed out`. Outside indexing there is no timeout.
- With `CODE_EMBED_SHARED_HOST=0`, and on the host fallback path, local indexing goes through a queue in the cache directory (`vector-slot/`: a `holder` file with the owner's pid and `wait-*` files for waiters): only one project per machine indexes with the local model at a time. While a project waits, its phase is `queued` and the model is not loaded for indexing, but lexical search and existing vectors keep working. Query embeddings are computed outside the queue. The project in the active window goes ahead of background ones: a background holder yields the slot between batches and unloads the model. The number of model threads (`index.threads`) is machine-wide, by default half of the cores, at most 4. Remote providers do not take part in the queue.
- Each model is unloaded after 5 minutes without requests; the inference process exits once no model is loaded and starts again on the next request. If everything is indexed, the model is never loaded.
- Background window: the extension sends the engine `client.activity` (`active: false`) when the VS Code window has been out of focus for more than 30 seconds. A background engine keeps embedding chunks it has already found but does not look for changes: watcher events are queued and the startup scan is postponed. Everything queued is applied when the window regains focus or a search comes in. A daemon counts as background only if all connected clients are.
- A crash of the inference process becomes `ProviderUnavailableError("local inference process exited …")`: an `index.error` is emitted, `status.lastError` contains `embedding provider unavailable: …`, and search answers from lexical results with `partial: true`. The vector phase waits and restarts the process; after 3 crashes in a row it pauses for 10 minutes.

#### Shared inference host

The host is on by default; `CODE_EMBED_SHARED_HOST=0` turns it off, and any other value leaves it on. When enabled, engines connect to a machine-wide `cli.js __embed-host` process instead of starting their own `__embed-worker`, so a single copy of the model serves every window, daemon, MCP server and CLI, and projects are interleaved by the host itself (active ones first, see below) instead of queueing in `vector-slot/` ([plan](plans/shared-inference-host.md)).

- Key: `blake3(JSON.stringify([HOST_PROTOCOL_VERSION, engine package version, modelsDir])).slice(0, 16)`. There is one host per machine, engine version and models directory. Test-only `worker`, `idleUnloadMs` and `idleExitMs` are not part of the key. `proxy` and `offlineArchive` are not part of it either: a model keeps the options of the first client that greeted with it for the life of the host.
- Socket: `<tmp>/code-embed/embed-<key>.sock` (mode 0600 in a 0700 directory), on Windows `\\.\pipe\code-embed-embed-<key>`. The engine starts the host detached if the socket is missing and waits up to 15 s. Concurrent starts are settled by `embed-host-<key>.lock` in the cache directory, and the host logs to `logs/embed-host-<key>.log`.
- Protocol (version 2): JSON-RPC with `hello` (protocol version, model, `threads` and `threadsExplicit`, `proxy`, `offlineArchive`, client id, project, active; the host answers with dimensions and max input tokens), `embed` (vectors as base64 of `Float32Array`) and the `activity` notification. `hello` is refused for another protocol version, an unknown model, or a static model (those run in the engine process). Cancellation goes through `$/cancelRequest`.
- Inference child: one `__embed-worker` per host serves every model the engines ask for. Models are loaded on demand and unloaded one by one after 5 minutes without jobs; the child exits when no model is loaded. All models share one queue with one request in flight.
- Threads: the child runs with the minimum of the explicit `threads` values among the greeted clients, where a value is explicit when it comes from the CLI, the editor or the user `config.toml` and is not 0. Without any explicit value it runs with the default (`defaultThreads()`), and clients that did not set threads do not lower the limit. Each change is logged as `effective threads <N> (from <clientId>)` or `(from default)`, and the child is restarted with the new count: the request in flight finishes, and queued jobs run in the new child. A client disconnecting recomputes the value.
- Queue: queries and documents that fit one sub-batch (`interactive`) go straight to the inference child, which keeps the query → interactive → batch order. Batch requests go through the host one at a time: active engines first, then round-robin across engines, so projects interleave instead of waiting for each other. Engines without a window (CLI, MCP, a daemon without window clients) count as active.
- Lifecycle: the model is loaded at the first `embed` and unloaded after 5 minutes idle; 3 crashes in a row pause it for 10 minutes (`ProviderUnavailableError` with `retryAfterMs`). The host exits after 10 minutes without clients. If the host dies, in-flight requests fail with `ProviderUnavailableError` and the next request starts a new host.
- Updates: the engine version is part of the key, so a new extension or CLI version gets a new host; there is no explicit shutdown, the old host exits after 10 minutes without clients.
- Fallback: if the host does not come up in time, refuses `hello` or reports other dimensions, the embedder uses its own `__embed-worker` and the `vector-slot/` queue for the rest of its life. The warning gives the reason and says that the private process is not under the machine-wide thread limit.

### Real-model smoke test

Fast tests use `CODE_EMBED_FAKE_EMBEDDER=1`, so the real model under VS Code's Electron is checked by a separate opt-in run (`eval/stage0/real-model.ts`). It builds a VSIX for the host, launches the packaged `dist/engine/cli.js serve` with the VS Code executable (on macOS, `Code Helper (Plugin)`) and `ELECTRON_RUN_AS_NODE=1`, just like the extension does, indexes a fixture with the real model and checks for crashes, the peak RSS of the process tree (the shared host is found by its lock and counted separately from the engine), `status` and search responsiveness, NR-07 latency and a clean exit without leftover children:

```bash
pnpm build
pnpm --filter @code-embed/eval exec tsx stage0/real-model.ts --model qwen3-embedding-0.6b --vscode min,stable --minutes 5
CODE_EMBED_SHARED_HOST=1 pnpm --filter @code-embed/eval exec tsx stage0/real-model.ts --projects 3
```

`--projects <n>` starts n engines on one machine; by default they all use a single host. The checks include `rss` (peak host tree + Σ peak engine tree without the host ≤ L + n × the largest peak of an engine process, L being the model's limit), `rss-host` (host tree alone ≤ L) and `shutdown-host` (after the engines exit the host gets `SIGTERM` and must be gone within 10 s). The host checks are skipped when no host was observed, which is always the case with `CODE_EMBED_SHARED_HOST=0`.

Measurement of 2026-10-18 (`qwen3-embedding-0.6b`, VS Code 1.142.0, darwin-arm64, 5-minute window, integration branch with the host enabled):

| Mode | Result | Peak RSS | Indexed in 5 min | p95 status / lexical / hybrid / findSimilar |
| --- | --- | --- | --- | --- |
| 1 project, shared host | PASS | host (tree) 1808 MB + engine 237 MB = 2046 MB (limit 2560) | 1334 / 1611 | 3 / 13 / 15 / 816 ms |
| 3 projects, shared host | FAIL (1 of 31 checks) | host 1456 MB + engines 288 + 289 + 288 MB = 2320 MB (limit 2560 + 3 × 205 = 3175) | 438 / 1612 each (projects alternate) | status 3-8, lexical 13, hybrid 16 / 582 / 608, findSimilar 812-815 ms |
| 3 projects, own workers (default) | FAIL (by design of the old path) | 2005 MB total | 1120 / 0 / 0 (`vector-slot/` lets one project index at a time) | - |

| 3 projects, shared host, request-wide deadline | FAIL (3 of 34 checks, twice) | host 1059-1272 MB + engines 186-239 MB each = 1732-1839 MB (limit ≈ 3150-3280) | 240 / 1618 each | status 10-30, lexical 17-38, hybrid 31-705, findSimilar 723-728 ms (max 734) |
| 3 projects, shared host, control without the deadline fix (same session) | FAIL (6 checks) | host 1553 MB, total 1937 MB | 240 / 339 / 240 | findSimilar max 1515 / 1379 / 1269 ms; p2 inference process `SIGKILL` |

The failed check in the first 3-project host run was `p1:find-similar-during-indexing`: one response took 815 ms without `timed out` in `partialReason`, because the 800 ms timeout covered only the embedding step and the lexical fallback and building the response added about 15 ms after an embedding that finished just under 800 ms. The budget now counts from the start of the request (see [Inference process](#inference-process)); with it every search check passes. The later runs (evening of 2026-10-18) failed only `progress` (240 < 300 embedded per project): on that machine, under heavy swap, the first batch landed after 165-190 s instead of 131 s, with and without the deadline fix, so the second batch fell outside the 5-minute window. The host was opt-in when these runs were made; it is on by default now.

Flags, thresholds and the report format are described in [eval/stage0/README.md](../eval/stage0/README.md). In CI this is the `real-model` job in `.github/workflows/native-smoke.yml` (manual run with `real_model=true`, and `v*` tags).
