# Plan: one shared model process per machine

## Goal

One copy of the local model in memory regardless of how many VS Code windows, daemons, MCP servers and CLIs are running. Today every engine has its own `__embed-worker` process, so with N open projects there are up to N copies of the model (qwen3-embedding-0.6b takes up to 2.5 GB each).

## What already exists

- The `vector-slot/` queue in the cache directory: only one project indexes with the local model at a time, and the active window goes first ([slot.ts](../../packages/engine/src/indexer/slot.ts)).
- The model is unloaded after 5 minutes of inactivity ([worker.ts](../../packages/engine/src/embed/worker.ts)).
- A prioritized request queue inside the process: search queries, then interactive documents, then background batches.

These measures prevent concurrent indexing but not duplicate models: a search query in window B while window A is indexing loads a second copy in B.

## Solution

A separate `code-embed __embed-host` process, one per (model, threads) pair per machine. Engines connect to it over a socket and do not hold the model themselves.

```
window A ─ engine ─┐
window B ─ engine ─┼── unix socket / named pipe ── embed-host (model, shared queue)
CLI/MCP  ─ engine ─┘
```

### Discovery and startup

- Socket address: `<tmp>/code-embed/embed-<hash(modelId, threads)>.sock`, on Windows `\\.\pipe\code-embed-embed-<hash>`; mode 0600, like the daemon.
- The engine tries to connect; if there is no socket, it starts the host detached (like `daemon --detach`) and waits up to 15 s for the socket. A race between two starts is settled by an `embed-host-<hash>.lock` file in the cache directory: the loser simply connects.
- If the host does not come up, the engine falls back to today's `createWorkerEmbedder` (its own process). Behavior without a host stays the same.

### Protocol

JSON-RPC (vscode-jsonrpc, like the daemon). Vectors are sent as base64 of a `Float32Array`: `serialization: "advanced"` exists only for IPC, not for sockets.

| Method | Params | Response |
| --- | --- | --- |
| `hello` | `{ protocolVersion, modelId, threads, clientId, project }` | `{ dims, maxTokens }` |
| `embed` | `{ kind: "query" \| "document", texts, prio: "query" \| "interactive" \| "batch" }` | `{ vectors: string[] }` |
| `activity` | `{ active }` | — (notification) |

Cancellation via `$/cancelRequest` removes the task from the host's queue.

### Queue and fairness

- Three priorities, as today: `query` > `interactive` > `batch`.
- Within `batch`, round-robin across clients, with active clients (`activity`) first. One project no longer holds the model until it finishes indexing; batches interleave. After that `vector-slot/` is no longer needed for the local provider and is removed.
- At most one request in inference at a time (as today); sub-batches and token limits stay the same ([local.ts](../../packages/engine/src/embed/local.ts)).

### Lifecycle

- The model is loaded on the first `embed` and unloaded after 5 minutes of inactivity (the logic moves from `worker.ts` into the host).
- The host exits when it has had no clients for more than 10 minutes.
- Inference crash: the host restarts its child process under today's rules (3 crashes in a row, 10-minute pause). Host crash: clients get `ProviderUnavailableError`, and the first one to reconnect starts a new host.
- Changing `index.threads` or the model: a different hash, so a different host; the old one exits on inactivity.

### Code changes

1. `packages/engine/src/embed/host.ts`: the host server and round-robin queue, reusing the child process via `createWorkerEmbedder`.
2. `packages/engine/src/embed/host-client.ts`: an `Embedder` over the socket, host startup and discovery, fallback to `createWorkerEmbedder`.
3. `registry.ts`: return the host client for `local` with a non-static model.
4. `cli/main.ts`: a hidden `__embed-host` command.
5. `service.ts`: pass `setActive` to the host client; remove `vector-slot` for the local provider after switching to the host.
6. Docs: `docs/architecture.md`, "Inference process" section.

### Tests

- Unit: the host queue (priorities, round-robin, active first), cancellation, vector encoding.
- Integration with the worker fixture: two clients get correct vectors; a single inference process (`FIXTURE_SPAWN_LOG`); host crash and reconnect; a race between two starts; fallback without a host.
- `eval/stage0/real-model.ts`: a mode with three engines on one machine; peak RSS of the process tree no higher than the NR-08 budget of one model plus 3 × engine RSS.

### Risks

- Socket vs IPC latency: about 1 ms added per search query, unnoticeable next to inference.
- The host outlives VS Code windows: it needs a reliable idle shutdown and a shutdown on extension update (version in `hello`; on mismatch the client starts its own host under a different hash).
- Different engine versions in the CLI (npm) and the VSIX: the socket hash includes the host protocol version.

### Order of work

1. Host and client behind a `CODE_EMBED_SHARED_HOST=1` flag, with tests.
2. Measure RSS and latency in `real-model` with 1 and 3 projects.
3. Enable by default, remove `vector-slot` for the local provider.
