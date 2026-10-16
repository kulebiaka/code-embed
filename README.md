<p align="center">
  <img src="packages/extension/media/logo.png" width="112" alt="code-embed logo">
</p>

<h1 align="center">code-embed</h1>

<p align="center">
  <b>Local hybrid code search — by meaning and by keywords.</b><br>
  One index per project, shared by VS Code, the CLI and your AI agents. Your code never leaves the machine.
</p>

<p align="center">
  <a href="https://github.com/kulebiaka/code-embed/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/kulebiaka/code-embed/ci.yml?branch=main&label=CI" alt="CI"></a>
  <a href="https://github.com/kulebiaka/code-embed/releases"><img src="https://img.shields.io/github/v/release/kulebiaka/code-embed?sort=semver" alt="Release"></a>
  <a href="https://www.npmjs.com/package/code-embed"><img src="https://img.shields.io/npm/v/code-embed?label=npm" alt="npm"></a>
  <a href="https://marketplace.visualstudio.com/items?itemName=code-embed.code-embed-vscode"><img src="https://img.shields.io/visual-studio-marketplace/v/code-embed.code-embed-vscode?label=VS%20Marketplace" alt="VS Marketplace"></a>
  <a href="https://open-vsx.org/extension/code-embed/code-embed-vscode"><img src="https://img.shields.io/open-vsx/v/code-embed/code-embed-vscode?label=Open%20VSX" alt="Open VSX"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/kulebiaka/code-embed" alt="License: MIT"></a>
</p>

<p align="center">
  <a href="#install">Install</a> ·
  <a href="#quick-start">Quick start</a> ·
  <a href="#agent-integration">Agents &amp; MCP</a> ·
  <a href="#configuration">Configuration</a> ·
  <a href="docs/cli.md">CLI reference</a> ·
  <a href="docs/architecture.md">Architecture</a>
</p>

---

```console
$ code-embed -l -n 3 -g 'src/**' "process refund"
src/payment/refund.ts:64:9:   async processPaymentRefund(request: RefundRequest): Promise<RefundResult> {
src/payment/refund.ts:12:18: export interface RefundRequest {
src/payment/refund.ts:25:7: const REFUND_WINDOW_DAYS = 90;

$ code-embed "where is the token validated"         # hybrid: meaning + keywords
$ code-embed similar src/payment/refund.ts:64-90    # code that looks like this
```

grep finds what you can spell. code-embed finds what you mean: *"retry with exponential backoff"*, *"where is the token validated"*, even queries in Russian. It combines BM25 keyword search with vector search over embeddings, so exact identifiers still rank where they should.

## Features

- **Hybrid search.** BM25 (SQLite FTS5) + kNN (sqlite-vec), merged with Reciprocal Rank Fusion. Modes: `hybrid`, `semantic`, `lexical`.
- **Natural-language queries** in English, Russian and other languages.
- **Find similar code** for a line range or a snippet from stdin — duplicates, near-copies, other places that need the same fix.
- **Syntax-aware chunking** with tree-sitter for TypeScript/JavaScript, Python, Go, Rust, Java, C#, C, C++, PHP, Ruby and Kotlin; Markdown by section; sliding windows for everything else.
- **Instant start.** Indexing runs in two phases: lexical (search works right away), then vector in the background.
- **Bring your own embeddings.** Built-in local ONNX models, or any OpenAI-compatible API (Ollama, LM Studio, hosted providers).
- **Built for agents.** VS Code LM Tools `#semsearch` and `#similar`, and an MCP server for Cursor, Windsurf and Claude Code.
- **Private by default.** No telemetry. Nothing is sent anywhere unless you configure an external provider and confirm it.

## Install

### VS Code / Cursor / Windsurf

Install **Code Embed** from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=code-embed.code-embed-vscode) or [Open VSX](https://open-vsx.org/extension/code-embed/code-embed-vscode) (Cursor, Windsurf and other forks use Open VSX). VSIX packages are built per platform and include the engine. The default model (`qwen3-embedding-0.6b`, about 600 MB) is downloaded separately; `Code Embed: Install CLI` installs the CLI.

Commands (Command Palette, category "Code Embed"): Focus (`Ctrl+Alt+F` / `Cmd+Alt+F`), Quick Search, Find Similar Code, Reindex Workspace, Install CLI, Copy MCP Config, Select Embedding Provider, Select Model, Test Provider, Show Log, Open Settings. Open Settings (the gear in the search panel title) opens the settings page: index status, provider selection and testing, API keys, the model catalog, indexing and search options.

<details>
<summary>Search panel keyboard shortcuts</summary>

| Key | Action |
| --- | --- |
| `Alt+↑` / `Alt+↓` | switch mode (hybrid, semantic, lexical) |
| `↑` / `↓` | move through results |
| `Enter` | open the result |
| `Ctrl+Enter` / `Cmd+Enter` | open to the side |
| `←` / `→` | collapse to the file / expand |
| `Esc` | back to the query field |

Each result also has buttons to open it to the side, copy `path:line` and find similar code.

</details>

### CLI

```bash
npm i -g code-embed      # install globally
npx code-embed "query"   # or run without installing
```

Requires Node.js 22.13+ (`node:sqlite`). Offline model install: `code-embed model install --from FILE`.

## Quick start

```bash
cd my-project
code-embed model install            # once: download the default model
code-embed index                    # build the index (search also keeps it up to date)
code-embed "retry with exponential backoff"
code-embed -l -g 'src/**' -g '!**/*.test.ts' "parseConfig"
code-embed similar src/api/client.ts:40-72
code-embed --json -n 5 "where is the token validated"
```

## CLI

Full reference: [docs/cli.md](docs/cli.md). In short:

| Command | Purpose |
| --- | --- |
| `code-embed [OPTIONS] <QUERY>` | search |
| `code-embed similar <PATH>:<START>-<END>` / `similar -` | find similar code |
| `code-embed index [--watch] [--full]` | build or update the index |
| `code-embed status` / `stop` / `gc` / `clean` | status, stop the daemon, garbage-collect, delete the index |
| `code-embed daemon [--detach]` | daemon: engine + socket + file watcher |
| `code-embed mcp [--root DIR]` | MCP server (stdio) |
| `code-embed model install\|list` | manage models |
| `code-embed provider list\|add\|test` | embedding providers |
| `code-embed export` / `import` | move an index between machines |

Exit codes: `0` success, `1` no results, `2` error.

## Configuration

Details and the full table of VS Code settings: [docs/configuration.md](docs/configuration.md). Precedence: CLI flags, then the project's `.code-embed.toml`, then editor settings, then the user `config.toml`, then defaults.

### .code-embed.toml

A local file in the project root that is not committed: when the tool creates it, it adds `.code-embed.toml` to `.gitignore` (if it is not there yet).

```toml
exclude = ["vendor/**", "**/*.generated.ts"]

[embedding]
provider = "local"
model = "qwen3-embedding-0.6b"

[index]
location = "project"
max_file_kb = 512

[search]
default_mode = "hybrid"
top = 20
```

URLs and keys are not allowed in this file.

### Embedding providers

The `local` provider uses a built-in model. Others are defined in `providers.toml` (in the user config directory) or in the `codeEmbed.providers` setting:

```toml
[ollama]
kind = "openai"
base_url = "http://localhost:11434/v1"
model = "nomic-embed-text"

[remote]
kind = "openai"
base_url = "https://api.example.com/v1"
model = "text-embedding-3-small"
api_key_env = "EXAMPLE_API_KEY"
```

Select one with `embedding.provider = "remote"` in `.code-embed.toml`, `--provider remote`, or `Code Embed: Select Embedding Provider`. Test it: `code-embed provider test remote`.

### Privacy

- No telemetry. Network access is limited to downloading models and calling the provider you chose.
- A provider on loopback (`localhost`, `127.0.0.1`, `::1`) or a unix socket is treated as local, with no warnings.
- Any other address is external: before code is sent for the first time, you have to confirm it per project ("code will be sent to `<host>`"). Consent is stored in `consents.toml`, shared by the CLI and the extension. In the CLI: an interactive prompt or `--allow-remote`.
- API keys are never stored in config files, only the name of an environment variable (`api_key_env`). The VS Code settings page keeps keys in secret storage.

## Agent integration

Details: [docs/agents.md](docs/agents.md). Every interface exposes the same two tools with a shared contract: `search` and `find_similar`.

### VS Code (LM Tools)

Agent tools in VS Code: `#semsearch` (search) and `#similar` (similar code). Available while the extension is active.

### MCP

`code-embed mcp` starts a stdio MCP server; the project root is the current directory or `--root`. `Code Embed: Copy MCP Config` copies JSON for Cursor/Windsurf `mcp.json` to the clipboard:

```json
{
  "mcpServers": {
    "code-embed": { "command": "npx", "args": ["-y", "code-embed@0.1.0", "mcp", "--root", "/path/to/project"] }
  }
}
```

For Claude Code:

```bash
claude mcp add code-embed -- npx -y code-embed mcp --root /path/to/project
```

### Snippet for CLAUDE.md / AGENTS.md

```markdown
## Code search

- For questions about meaning ("where is X handled", "how does Y work"), finding the
  implementation of a concept when exact identifiers are unknown, and queries in other
  languages, run `code-embed --json "<query>"` (or the MCP tool `search`). Narrow with `-g` /
  `include` and `--lang`.
- Before a refactoring or a bug fix, look for similar places:
  `code-embed --json similar <path>:<start>-<end>` (or `find_similar`).
- For an exact identifier, string literal, error message, file name or a list of all usages
  of a symbol, use grep/ripgrep, not code-embed.
- code-embed results are ranked chunks; read the referenced lines of the file before editing.
```

## Models

The built-in model catalog: `packages/engine/src/embed/models.json`. The default model is `qwen3-embedding-0.6b`. Choose one with `codeEmbed.model.id`, `embedding.model` or `--model`. List models and their install status: `code-embed model list`.

| Model | Dimensions | Size | License |
| --- | --- | --- | --- |
| `qwen3-embedding-0.6b` | 1024 | 596 MB | Apache-2.0 |
| `embeddinggemma-300m` | 768 | 316 MB | gemma |
| `coderankembed-137m` | 768 | 133 MB | MIT |
| `multilingual-e5-small` | 384 | 129 MB | MIT |
| `bge-m3` | 1024 | 558 MB | MIT |
| `potion-code-16m` | 256 | 62 MB | MIT |

Quality evaluation on query datasets (Recall@10, MRR): [eval/README.md](eval/README.md).

## How it works

```
         VS Code panel · LM Tools · CLI · MCP
                           │
                           │ JSON-RPC
                           ▼
  project ──► ┌─────────────────────────┐ ──► index.db
   files      │         engine          │     FTS5 (BM25) + sqlite-vec (kNN)
              │  scan → chunk → index   │
              │  lexical, then vectors  │ ──► emb.db
              └────────────┬────────────┘     global embedding cache
                           │
                           ▼
      local ONNX model  or  OpenAI-compatible API
```

Details: [docs/architecture.md](docs/architecture.md). The scanner walks the project respecting `.gitignore` and skips binary, minified, oversized and generated files; files are split into chunks; the lexical phase fills FTS5, and the vector phase computes embeddings (with the global `emb.db` cache) and writes them to sqlite-vec. Search merges BM25 and kNN with RRF.

## Development

```bash
pnpm install
pnpm build          # engine, extension
pnpm test           # vitest
pnpm typecheck
pnpm check:docs     # docs stay in sync with --help, settings and the model catalog
```

The monorepo contains `packages/engine` (engine and CLI), `packages/extension` (VS Code extension), `packages/protocol` (shared JSON-RPC and tool types) and `eval/` (quality evaluation). See [CONTRIBUTING.md](CONTRIBUTING.md) for the release process and [CHANGELOG.md](CHANGELOG.md) for version history.

## Licenses

code-embed is released under the MIT license (see [LICENSE](LICENSE)). It collects no telemetry.

Catalog models are downloaded separately and keep their own licenses:

| Model | License |
| --- | --- |
| `qwen3-embedding-0.6b` | Apache-2.0 |
| `embeddinggemma-300m` | gemma (Gemma Terms of Use) |
| `coderankembed-137m` | MIT |
| `multilingual-e5-small` | MIT |
| `bge-m3` | MIT |
| `potion-code-16m` | MIT |

tree-sitter grammars (WASM, package `tree-sitter-wasms`, runtime `web-tree-sitter`):

| Grammar | License |
| --- | --- |
| `web-tree-sitter` (runtime) | MIT |
| tree-sitter-typescript / tsx / javascript | MIT |
| tree-sitter-python | MIT |
| tree-sitter-go | MIT |
| tree-sitter-rust | MIT |
| tree-sitter-java | MIT |
| tree-sitter-c-sharp | MIT |
| tree-sitter-c / tree-sitter-cpp | MIT |
| tree-sitter-php | MIT |
| tree-sitter-ruby | MIT |
| tree-sitter-kotlin | MIT |

The `tree-sitter-wasms` package itself is released under the Unlicense.
