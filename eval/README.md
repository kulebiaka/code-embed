# eval

Search quality evaluation: queries run through the engine in-process, Recall@10 and MRR metrics, and a model benchmark.

## Dataset format

- `repos.json` — an array of `EvalRepo` (`name`, `url`, pinned `commit`, `languages`, `license`).
- `datasets/<repo>.jsonl` — one `EvalQuery` per line: `id`, `repo`, `query`, `lang` (`ru` | `en`), `expected` (a list of `{path, startLine, endLine}`, lines 1-based inclusive), optional `tags`.
- Clones live in `.repos/<name>` (gitignored) and are fetched with `pnpm --filter @code-embed/eval run fetch-repos`.
- Dataset validation: `pnpm --filter @code-embed/eval run validate-dataset`.

## Metrics

The top 10 results of a query are compared with `expected`.

- Hit: the same `path` and overlapping line ranges between the result and the expected chunk.
- Recall@10 of a query is the share of expected chunks found in the top 10 (0 or 1 with a single expected chunk); the total is the mean over queries.
- MRR is the mean of `1 / rank` of the first result that hits any expected chunk (0 if there is no hit in the top 10).
- Metrics are computed for all queries, for `ru`, for `en` and per repository. The Russian metric is informational and has no threshold.
- NR-10: hybrid Recall@10 must be no lower than the maximum of lexical and semantic. The report shows the verdict; the exit code is non-zero only with `--strict`.

## Running

```bash
pnpm --filter @code-embed/eval run fetch-repos
pnpm --filter @code-embed/eval run eval                      # default model, all modes
pnpm --filter @code-embed/eval run eval -- --fake --limit 10 # smoke run with FakeEmbedder, no models
```

`eval` flags: `--model <id>`, `--mode lexical|semantic|hybrid|all`, `--repos a,b`, `--limit N` (first N queries of each repository), `--fake`, `--strict`, `--out <dir>`, `--name <file name>`.

Each repository is indexed into a temporary cache directory (the index and embedding cache never land in the clones or the user cache; downloaded models are taken from the regular model cache). Reports go to `reports/*.json` and `reports/*.md`: metrics per mode and per repository, indexing time, chunks/s, peak RSS, search latency p50/p95, and the NR-10 verdict.

## CI

`.github/workflows/eval.yml` runs `eval --strict` with the default model on PRs that touch `packages/engine/src/chunk/**`, `lex/**`, `embed/**` or `eval/**`. Models are cached with `actions/cache`; the report is saved as the `eval-report` artifact.

## Model benchmark (manual step)

```bash
pnpm --filter @code-embed/eval run bench
```

Runs every catalog model on CPU, each in its own process (so peak RSS does not accumulate), and writes `reports/bench-<time>.md/json`: indexing time, chunks/s, peak RSS, search p50/p95, Recall@10 and MRR (overall and ru, hybrid mode). Flags: `--models a,b`, `--repos`, `--limit`, `--fake`.

A full run needs the models downloaded and runs on the reference machine (Apple M1 or Ryzen 7 5800U, 16 GB). The default model `qwen3-embedding-0.6b` is fixed and is not reconsidered by the benchmark.

### Reference machine results

Not filled in yet: paste the table from `reports/bench-*.md` after a manual run.
