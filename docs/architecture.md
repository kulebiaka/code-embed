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

The local model does not run in the engine's main process but in a child process `cli.js __embed-worker` with lowered priority (`PRIORITY_BELOW_NORMAL`). The main process only holds the request queue, so its JSON-RPC is never blocked by inference. The queue is prioritized: search and "Find Similar" requests overtake documents from interactive files, which in turn overtake background indexing.

- Memory is bounded three ways: inference is split into sub-batches by token budget (at most 16 texts, 1024 tokens per batch), input is truncated to 1024 tokens, and the ONNX Runtime session has the CPU arena disabled (`enableCpuMemArena: false`). Only pooled outputs are read from the model.
- Memory budget (NR-08 with an approved deviation): for `qwen3-embedding-0.6b` the ceiling is 2560 MB for the engine process plus the inference process combined; for models up to 300M parameters 1024 MB (a temporary user-approved deviation from NR-08's 700 MB, with small-model memory optimization deferred); for `bge-m3` 1024 MB.
- While the vector phase is running, `search` (hybrid and semantic modes) and "Find Similar" wait at most 800 ms for the query or fragment embedding (`INDEXING_EMBED_TIMEOUT_MS`). On timeout the response is built from lexical results with `partial: true`, and `partialReason` contains `timed out`. Outside indexing there is no timeout.
- Only one project per machine indexes with the local model at a time. The queue lives in the cache directory (`vector-slot/`): a `holder` file with the owner's pid and `wait-*` files for waiters. While a project waits, its phase is `queued` and the model is not loaded for indexing, but lexical search and existing vectors keep working. Query embeddings are computed outside the queue. The project in the active window goes ahead of background ones: a background holder yields the slot between batches and unloads the model. The number of model threads (`index.threads`) is machine-wide, by default half of the cores, at most 4. Remote providers do not take part in the queue.
- The inference process exits after 5 minutes without requests and starts again on the next one. If everything is indexed, the model is never loaded.
- Background window: the extension sends the engine `client.activity` (`active: false`) when the VS Code window has been out of focus for more than 30 seconds. A background engine keeps embedding chunks it has already found but does not look for changes: watcher events are queued and the startup scan is postponed. Everything queued is applied when the window regains focus or a search comes in. A daemon counts as background only if all connected clients are.
- A crash of the inference process becomes `ProviderUnavailableError("local inference process exited …")`: an `index.error` is emitted, `status.lastError` contains `embedding provider unavailable: …`, and search answers from lexical results with `partial: true`. The vector phase waits and restarts the process; after 3 crashes in a row it pauses for 10 minutes.

#### Shared inference host (experimental, `CODE_EMBED_SHARED_HOST=1`)

With the flag set, engines do not start their own `__embed-worker`. Instead they connect to a machine-wide `cli.js __embed-host` process, one per model, thread count, models directory and engine version, so a single copy of the model serves every window, daemon, MCP server and CLI ([plan](plans/shared-inference-host.md)).

- Socket: `<tmp>/code-embed/embed-<key>.sock` (mode 0600), on Windows `\\.\pipe\code-embed-embed-<key>`. The engine starts the host detached if the socket is missing and waits up to 15 s. Concurrent starts are settled by `embed-host-<key>.lock` in the cache directory, and the host logs to `logs/embed-host-<key>.log`. If the host does not come up, the engine falls back to its own `__embed-worker` and the `vector-slot/` queue as before.
- Protocol: JSON-RPC with `hello`, `embed` (vectors as base64 of `Float32Array`) and the `activity` notification. Cancellation goes through `$/cancelRequest`.
- Queue: queries and single-request documents go straight to the inference child, which keeps the query → interactive → batch order. Batch requests go through the host one at a time: active engines first, then round-robin across engines, so projects interleave instead of waiting for each other. `vector-slot/` is skipped while the host is in use.
- Lifecycle: the host keeps today's worker rules (model loaded on demand, unloaded after 5 minutes idle, 3 crashes in a row pause it for 10 minutes) and exits after 10 minutes without clients. If the host dies, in-flight requests fail with `ProviderUnavailableError` and the next request starts a new host.

### Real-model smoke test

Fast tests use `CODE_EMBED_FAKE_EMBEDDER=1`, so the real model under VS Code's Electron is checked by a separate opt-in run (`eval/stage0/real-model.ts`). It builds a VSIX for the host, launches the packaged `dist/engine/cli.js serve` with the VS Code executable (on macOS, `Code Helper (Plugin)`) and `ELECTRON_RUN_AS_NODE=1`, just like the extension does, indexes a fixture with the real model and checks for crashes, the peak RSS of the process tree, `status` and search responsiveness, NR-07 latency and a clean exit without leftover children:

```bash
pnpm build
pnpm --filter @code-embed/eval exec tsx stage0/real-model.ts --model qwen3-embedding-0.6b --vscode min,stable --minutes 5
```

Flags, thresholds and the report format are described in [eval/stage0/README.md](../eval/stage0/README.md). In CI this is the `real-model` job in `.github/workflows/native-smoke.yml` (manual run with `real_model=true`, and `v*` tags).
