# CLI

`code-embed` (npm package `code-embed`). Help: `code-embed --help`, version: `code-embed --version`. stdout carries results only; logs and hints go to stderr.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | success |
| 1 | search ran, no results |
| 2 | error (invalid arguments, consent declined, etc.) |

## Search

```
code-embed [OPTIONS] <QUERY>
```

| Option | Description |
| --- | --- |
| `-s`, `--semantic` | semantic search only |
| `-l`, `--lexical` | lexical search only |
| `-H`, `--hybrid` | hybrid search (default) |
| `-n`, `--top N` | number of results |
| `-g`, `--glob PATTERN` | path glob, repeatable; a leading `!` excludes |
| `--lang LANG` | restrict to a language |
| `--threshold X` | minimum score |
| `-C`, `--context N` | lines of context around a match |
| `--files-only` | print unique paths only |
| `--json` | JSON lines output (same contract as the `search` tool) |
| `--no-update` | do not update the index before searching |
| `--root DIR` | project root |
| `--color WHEN` | `auto`, `always`, `never` |
| `--provider NAME` | embedding provider |
| `--model ID` | embedding model |
| `--allow-remote` | allow sending code to an external provider |
| `-h`, `--help` | help |
| `-V`, `--version` | version |

## similar

```
code-embed similar <PATH>:<START>-<END> [OPTIONS]
code-embed similar - [--lang ts] [OPTIONS]
```

The first form finds code similar to a line range (1-based, inclusive); the second reads a fragment from stdin, with `--lang` setting its language. Accepts the common search options.

## outline

```
code-embed outline <PATH> [--json]
```

Prints the symbols of a file (line range, kind, name, signature), ordered by position. `PATH` is relative to the project root. `--json` prints the `symbols.outline` response as JSON. A file that is not indexed yields an empty list.

```console
$ code-embed outline src/payment/refund.ts
src/payment/refund.ts
  12-23  interface  RefundRequest  export interface RefundRequest {
  64-90  method  RefundService.processPaymentRefund  async processPaymentRefund(request: RefundRequest): Promise<RefundResult> {
```

## refs

```
code-embed refs <SYMBOL> [--path PATH] [--json]
```

Lists definitions and usages (calls, type references, imports) of a symbol by name. The search is name-based, not a replacement for a language server: each item carries a confidence, `high` or `low`. `--path PATH` restricts definitions to one file (relative to the project root) and is passed as the `path` parameter of the `references` tool. `--json` prints the `symbols.references` response as JSON.

```console
$ code-embed refs processPaymentRefund --path src/payment/refund.ts
Definitions of processPaymentRefund (1):
  src/payment/refund.ts:64  [method, high]  in RefundService
      async processPaymentRefund(request: RefundRequest): Promise<RefundResult> {
Usages (1):
  src/api/refunds.ts:31  [call, high]  in handleRefund
      return service.processPaymentRefund(req.body);
```

## context

```
code-embed context <PATH>:<LINE> | "<query>" [--budget N] [--json]
```

Assembles the working context of a piece of code in one call. The target is a location (`PATH:LINE`, 1-based) or a query (natural language or a symbol name). `--budget N` sets the token budget (integer >= 1, default 4000) and is passed as `budget_tokens` of the `context` tool; tokens are counted with the chunker's token counter. `--json` prints the `context` response as JSON.

The package is filled in priority order until the budget runs out: the target chunk; definitions of the symbols it calls (signature and first 5 lines, only calls with `high` confidence); callers; tests; similar code; lexical matches. Recent commits of the target file (the last 5, as short hash, date, subject) are added separately. Levels that did not fit are listed as omitted; the target is always included, even if it alone exceeds the budget.

```console
$ code-embed context src/payment/refund.ts:70 --budget 2000
## Target
src/payment/refund.ts:64-90  RefundService.processPaymentRefund
    async processPaymentRefund(request: RefundRequest): Promise<RefundResult> {
      ...
## Callees
src/payment/ledger.ts:10-24  recordRefund  (high)
    export function recordRefund(entry: LedgerEntry): void {
      ...
## Recent commits
  a1b2c3d 2026-10-28 fix(payment): honour the refund window
Omitted (budget): similar, lexical
Tokens: 1874/2000
```

## index

```
code-embed index [--watch] [--full]
```

Builds or updates the index (lexical phase, then vector phase). `--watch` keeps watching for changes, `--full` rebuilds from scratch. Progress goes to stderr.

## status

`code-embed status` shows the state of the project's index and engine.

## daemon

`code-embed daemon [--detach]` starts a long-lived engine with a socket and a file watcher for the project; `--detach` detaches the process from the terminal.

## stop

`code-embed stop` stops the project's daemon.

## mcp

`code-embed mcp [--root DIR]` starts a stdio MCP server with the `search`, `find_similar`, `outline`, `references` and `context` tools. See [agents.md](agents.md).

## model

```
code-embed model install [--from FILE]
code-embed model list
```

`model install` without `--from` downloads the selected (or default) model from the manifest and verifies sha256; with `--from` it installs from an offline archive. `model list` prints the catalog and installation status.

## provider

```
code-embed provider list
code-embed provider add [--kind openai --base-url URL --model NAME --api-key-env VAR]
code-embed provider test <name>
```

In a TTY, `add` asks questions interactively; without a TTY it reads `--kind`, `--base-url`, `--model`, `--api-key-env` (plus `--dimensions`, `--max-input-tokens`, `--query-prefix`, `--doc-prefix`). `list` shows which providers are external. `test` checks that a provider is reachable. Configuration: [configuration.md](configuration.md).

## gc

`code-embed gc` removes entries from the global embedding cache that no index needs anymore.

## clean

`code-embed clean [--yes] [--root DIR]` deletes the project's index. Without `--yes` it asks for confirmation in a TTY and refuses without one (exit code 2). If a daemon is running for the project, run `code-embed stop` first.

## export

`code-embed export [--out FILE]` saves the project's index to an archive for transfer.

## import

`code-embed import <FILE>` loads an index from an archive created by `export`.

## External providers and consent

The first time code is about to be sent to an external provider, the CLI asks for consent (interactively in a TTY). Without a TTY the command exits with code 2 and a hint; pass `--allow-remote` to allow it. Consent is stored in `consents.toml`.
