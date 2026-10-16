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

`code-embed mcp [--root DIR]` starts a stdio MCP server with the `search` and `find_similar` tools. See [agents.md](agents.md).

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
