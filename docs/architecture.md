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

By default the local (non-static) model runs in a machine-wide inference host, `cli.js __embed-host`, shared by every window, daemon, MCP server and CLI (see [Shared inference host](#shared-inference-host)). The host runs the model in a child process with lowered priority (`PRIORITY_BELOW_NORMAL`), so an engine's JSON-RPC is never blocked by inference. Static models run inside the engine process, and remote providers do not take part. With `CODE_EMBED_SHARED_HOST=0`, or when the host cannot be used, each engine runs its own child process `cli.js __embed-worker` instead. Either way requests are prioritized: search and "Find Similar" requests overtake documents from interactive files, which in turn overtake background indexing.

- Memory is bounded three ways: inference is split into sub-batches by token budget (at most 16 texts, 1024 tokens per batch), input is truncated to 1024 tokens, and the ONNX Runtime session has the CPU arena disabled (`enableCpuMemArena: false`). Only pooled outputs are read from the model.
- Memory budget (NR-08 with an approved deviation): for `qwen3-embedding-0.6b` the ceiling is 2560 MB for the engine process plus the inference process combined (through the host: the host with its inference process plus the engine processes, checked as described in [Real-model smoke test](#real-model-smoke-test)); for models up to 300M parameters 1024 MB (a temporary user-approved deviation from NR-08's 700 MB, with small-model memory optimization deferred); for `bge-m3` 1024 MB.
- While the vector phase is running, `search` (hybrid and semantic modes) and "Find Similar" wait at most 800 ms for the query or fragment embedding (`INDEXING_EMBED_TIMEOUT_MS`). On timeout the response is built from lexical results with `partial: true`, and `partialReason` contains `timed out`. Outside indexing there is no timeout.
- Through the host, projects are interleaved by the host itself (active ones first, see below) and `vector-slot/` is not used. The queue in the cache directory (`vector-slot/`: a `holder` file with the owner's pid and `wait-*` files for waiters) applies only on the fallback path and with `CODE_EMBED_SHARED_HOST=0`: there only one project per machine indexes with the local model at a time. While a project waits, its phase is `queued` and the model is not loaded for indexing, but lexical search and existing vectors keep working. Query embeddings are computed outside the queue. The project in the active window goes ahead of background ones: a background holder yields the slot between batches and unloads the model. The number of model threads (`index.threads`) is machine-wide, by default half of the cores, at most 4. Remote providers do not take part in the queue.
- The inference process exits after 5 minutes without requests and starts again on the next one. If everything is indexed, the model is never loaded.
- Background window: the extension sends the engine `client.activity` (`active: false`) when the VS Code window has been out of focus for more than 30 seconds. A background engine keeps embedding chunks it has already found but does not look for changes: watcher events are queued and the startup scan is postponed. Everything queued is applied when the window regains focus or a search comes in. A daemon counts as background only if all connected clients are.
- A crash of the inference process becomes `ProviderUnavailableError("local inference process exited …")`: an `index.error` is emitted, `status.lastError` contains `embedding provider unavailable: …`, and search answers from lexical results with `partial: true`. The vector phase waits and restarts the process; after 3 crashes in a row it pauses for 10 minutes.

#### Shared inference host

Engines connect to a machine-wide `cli.js __embed-host` process instead of starting their own `__embed-worker`, so a single copy of the model serves every window, daemon, MCP server and CLI ([plan](plans/shared-inference-host.md)). `CODE_EMBED_SHARED_HOST=0` turns it off; any other value or no variable means it is on.

- Key: `blake3(JSON.stringify([HOST_PROTOCOL_VERSION, engine package version, cfg])).slice(0, 16)`, where `cfg = { model, opts: { modelsDir, threads, offlineArchive, proxy } }` (test-only `worker`, `idleUnloadMs` and `idleExitMs` are added by tests, never in normal use). Two engines that differ in `proxy`, `offlineArchive`, models directory or version get different hosts and two copies of the model.
- Socket: `<tmp>/code-embed/embed-<key>.sock` (mode 0600 in a 0700 directory), on Windows `\\.\pipe\code-embed-embed-<key>`. The engine starts the host detached if the socket is missing and waits up to 15 s. Concurrent starts are settled by `embed-host-<key>.lock` in the cache directory, and the host logs to `logs/embed-host-<key>.log`.
- Protocol: JSON-RPC with `hello` (protocol version, model, threads; the host answers with dimensions), `embed` (vectors as base64 of `Float32Array`) and the `activity` notification. Cancellation goes through `$/cancelRequest`.
- Queue: queries and documents that fit one sub-batch (`interactive`) go straight to the inference child, which keeps the query → interactive → batch order. Batch requests go through the host one at a time: active engines first, then round-robin across engines, so projects interleave instead of waiting for each other. Engines without a window (CLI, MCP, a daemon without window clients) count as active.
- Lifecycle: the model is loaded at the first `embed` and unloaded after 5 minutes idle; 3 crashes in a row pause it for 10 minutes (`ProviderUnavailableError` with `retryAfterMs`). The host exits after 10 minutes without clients. If the host dies, in-flight requests fail with `ProviderUnavailableError` and the next request starts a new host.
- Updates: the engine version is part of the key, so a new extension or CLI version gets a new host; there is no explicit shutdown, the old host exits after 10 minutes without clients.
- Fallback: if the host does not come up in time, refuses `hello` (protocol, model or threads mismatch) or reports other dimensions, the embedder uses its own `__embed-worker` and the `vector-slot/` queue for the rest of its life.

### Real-model smoke test

Fast tests use `CODE_EMBED_FAKE_EMBEDDER=1`, so the real model under VS Code's Electron is checked by a separate opt-in run (`eval/stage0/real-model.ts`). It builds a VSIX for the host, launches the packaged `dist/engine/cli.js serve` with the VS Code executable (on macOS, `Code Helper (Plugin)`) and `ELECTRON_RUN_AS_NODE=1`, just like the extension does, indexes a fixture with the real model and checks for crashes, the peak RSS of the process tree (the shared host is found by its lock and counted separately from the engine), `status` and search responsiveness, NR-07 latency and a clean exit without leftover children:

```bash
pnpm build
pnpm --filter @code-embed/eval exec tsx stage0/real-model.ts --model qwen3-embedding-0.6b --vscode min,stable --minutes 5
pnpm --filter @code-embed/eval exec tsx stage0/real-model.ts --projects 3
```

`--projects <n>` starts n engines on one machine against a single host. The checks include `rss` (peak host tree + Σ peak engine tree without the host ≤ L + n × the largest peak of an engine process, L being the model's limit), `rss-host` (host tree alone ≤ L) and `shutdown-host` (after the engines exit the host gets `SIGTERM` and must be gone within 10 s). The host checks are skipped when no host was observed.

Flags, thresholds and the report format are described in [eval/stage0/README.md](../eval/stage0/README.md). In CI this is the `real-model` job in `.github/workflows/native-smoke.yml` (manual run with `real_model=true`, and `v*` tags).
