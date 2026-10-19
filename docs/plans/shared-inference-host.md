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

### Measurements

Step 2, 2026-10-18: `real-model.ts --compare --threads 2 --min-embedded 100` under `nice -n 15` (see [eval/stage0/README.md](../../eval/stage0/README.md)), `qwen3-embedding-0.6b`, VS Code 1.142.0 (Electron 43.7.7, Node 24.21.0), darwin-arm64, stress fixture (1620 chunks per project), 5-minute window. Query latency is 40 semantic queries per engine after indexing is paused.

| Mode | Result | Peak total RSS | Host tree | Embedded in 5 min | Query p50 / p95 |
| --- | --- | --- | --- | --- | --- |
| 1 project, own worker | PASS | 1245 MB | - | 691 | 72.1 / 75.9 ms |
| 1 project, shared host | FAIL (1 check) | 1433 MB | 1315 MB | 691 | 72.1 / 76.0 ms |
| 3 projects, own workers | baseline | 1977 MB | - | 691 / 0 / 0 | 70.7 / 75.3 ms (p1 only) |
| 3 projects, shared host | PASS | 2144 MB | 1529 MB | 242 / 242 / 242 | 70.9 / 75.1 ms |

- Memory assertion for 3 projects holds: host 1529 MB + engine trees 287 + 205 + 260 MB = 2281 MB (sum of separate peaks; the largest simultaneous total was 2144 MB) ≤ 2560 + 3 × 206 = 3178 MB.
- The host adds no measurable query latency: host minus own is 0.0 / +0.1 ms (p50 / p95) with one project and +0.2 / −0.2 ms with three, below run-to-run noise, so the expected ~1 ms per query is an upper bound.
- The host process costs about 190 MB on its own (1433 vs 1245 MB with one project). In this run the own-worker baseline held only one model copy because `vector-slot/` kept projects 2 and 3 queued and fresh projects without vectors never embed a query, so the case the host exists for (a search in a second window that already has vectors loads a second 1.1–1.4 GB copy) is not reproduced here; there the saving is roughly one model copy per extra window minus the ~190 MB host.
- With the host the three projects index in parallel (242 each, 726 in total) instead of one after another (691 / 0 / 0), at the same total throughput.
- The single failed check is `find-similar-during-indexing` in the 1-project host run: one response took 840 ms without `timed out`. This is the known gap that kept the host opt-in (the 800 ms timeout covers only the embedding step, not the whole request; see "Real-model smoke test" in [architecture.md](../architecture.md#real-model-smoke-test)), and it has to be fixed before step 3.
- With `--threads 1` the vector phase stores progress about every 135 s (one batch of 242 chunks), so with three projects round-robin through the host none of them stored a vector inside the 5-minute window. Nothing hangs, but at low thread counts per-project progress shows up late.

### Order of work

1. Host and client behind a `CODE_EMBED_SHARED_HOST=1` flag, with tests.
2. Measure RSS and latency in `real-model` with 1 and 3 projects.
3. Enable by default, remove `vector-slot` for the local provider.

## Step 3: one inference process per machine

The measurements show the host costs ~190 MB and no query latency, but they do not show the saving: fresh projects without vectors never embed a query, so the own-worker baseline held one model copy. Step 3 first measures the case the host exists for, then makes the host the only place a local model runs and turns `codeEmbed.index.threads` into a real machine-wide limit.

### Why the thread limit is not machine-wide today

`codeEmbed.index.threads` (`scope: application`, `threads` in `config.toml`, `--threads`) is described as the total for the machine, but it is the `intraOpNumThreads` of each inference process ([local.ts](../../packages/engine/src/embed/local.ts)):

- Own workers: `vector-slot/` lets one project index at a time, but searches, "Find Similar" and interactive documents in every other window run in that window's own worker with N threads, so with k windows up to k × N threads.
- Shared host: the key is `hash(protocol, version, model, modelsDir, threads, proxy, offlineArchive)`, so two models or two thread values give two hosts, each with N threads. The CLI, MCP server and daemon read `config.toml`, not the VS Code setting, so a different value there starts a second host and a second model copy.
- Fallback: an engine that cannot reach the host runs its own worker outside any limit.

### Gates

1. The search deadline covers the whole request, not only the embedding step (the `find-similar-during-indexing` failure above). Without it the real-model run is red with the host.
2. Warm measurement (below) shows the saving: with 3 indexed projects searched in all windows, peak total RSS with the host ≤ own workers − 1 GB.

### Changes

1. **Eval: warm scenario** (`real-model.ts --warm`). Index every project to completion in one run (or reuse the index from a previous run via a kept cache directory), restart the engines, then send searches in all windows within the 5-minute unload window. Report peak total RSS and the number of live inference processes for own workers and for the host. New check `inference-processes`: with the host exactly one per model during the probe.
2. **One host per machine, not per model and thread count.** Key: `hash(HOST_PROTOCOL_VERSION, engine version, modelsDir, proxy, offlineArchive)`. `hello` keeps `modelId` and `threads`; the host starts one inference child per model on first use and unloads it after 5 minutes idle, as today. The batch queue becomes global: at most one request in inference across all models, so CPU stays bounded when two windows use different models (memory is still one copy per model in use).
3. **Threads belong to the host.** Every `hello` carries the client's resolved `threads` and whether it was set explicitly or is the automatic default. The host uses the last explicit value it received, otherwise the automatic default; a change restarts the inference children after the request in flight (the next request reloads the model, ~1 s). A new `config` notification sends the value when `codeEmbed.index.threads` changes, so all windows switch without a restart. With all inference in the host and one request at a time, the machine runs at most N intra-op threads + 1 inter-op thread for local models.
4. **Same value for the editor and the CLI.** The extension writes `codeEmbed.index.threads` into the user `config.toml` (`[index] threads`) when it changes, so the CLI, MCP server and daemon resolve the same number. The settings page says so next to the field.
5. **Fallback keeps the limit.** An engine on the fallback path (host did not start, protocol mismatch) takes `vector-slot/` for every local request, queries included, not only for indexing; `status` reports `inference: "private"` and the status bar tooltip shows why. Without a host, k windows then share N threads by queueing instead of each using N.
6. **On by default.** `CODE_EMBED_SHARED_HOST=0` disables the host (the opposite of today's opt-in), `vector-slot/` stays only for the fallback path. Static models (in-process) and remote providers are unchanged.
7. **Lifecycle.** The host exits after 10 minutes without clients, as today. On extension deactivation the engine sends `bye` so the host can exit once its client count is zero and no model is loaded, instead of waiting the full 10 minutes. A version change already gives a new key, so the old host just drains.
8. **Docs.** `docs/architecture.md` "Inference process" and "Shared inference host" (host on by default, one per machine, thread rule), `docs/configuration.md` (`codeEmbed.index.threads` is a hard cap through the host, written to `config.toml`), `CHANGELOG.md`.

### Tests

- Unit: key without model and threads; one queue across two models (never two inferences at once); last explicit `threads` wins, an automatic value never overrides an explicit one; a threads change restarts the child after the request in flight; `config` notification.
- Integration with the worker fixture: two engines with different models share one host and one `FIXTURE_SPAWN_LOG` entry per model; two engines with different `threads` share one host; fallback engine queues queries through `vector-slot/`.
- Extension: changing `codeEmbed.index.threads` updates `config.toml` and sends `config` to the engine.
- Real-model: `--compare --warm` with 1 and 3 projects passes, including `inference-processes`, and the RSS saving gate above.

### Order

1. Search deadline fix (gate 1) and the warm eval scenario (change 1), independent of each other.
2. Run the warm measurement; stop here if the saving is under 1 GB.
3. Changes 2 and 3 (host key, global queue, host-owned threads) with their tests.
4. Changes 4 and 5 (`config.toml` sync, fallback through `vector-slot/`).
5. Change 6 and 7 (default on, `bye`), docs, `real-model --compare --warm` on darwin-arm64 and in the CI `real-model` job.
