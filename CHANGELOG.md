# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). The npm package `code-embed` and the VS Code extension share one version.

## [Unreleased]

## [0.2.0] - 2026-11-07

### Added

- Symbol graph for TypeScript, TSX, JavaScript and Python: call, type and import references extracted with tree-sitter during indexing and resolved by name with `high`/`low` confidence (not a replacement for an LSP).
- `outline`, `references` and `context` tools in the MCP server and as VS Code LM Tools `#outline`, `#refs` and `#context`.
- CLI commands `code-embed outline <PATH>`, `code-embed refs <SYMBOL> [--path PATH]` and `code-embed context <PATH>:<LINE> | "<query>" [--budget N]`, all with `--json`.
- `context` assembles the neighbourhood of a place in one answer within a token budget (4000 by default): the target chunk, definitions of the symbols it calls, up to 5 callers, tests that reference it, up to 3 similar chunks once vectors are ready and the last 5 commits of the file. Languages without the graph get the target, similar chunks and a lexical search by symbol name.

### Changed

- Index schema version 3: existing indexes are rebuilt on first open; vectors are reused from the embeddings cache, so nothing is embedded again.
- Background embedding goes through chunks with more incoming references first, after open and recently changed files.
- The `search` and `find_similar` tool descriptions now point agents to `references` for callers and to `context` for the surrounding code.
- VSIX packages are built for `win32-x64`, `darwin-arm64`, `linux-x64` and `linux-arm64`. `darwin-x64` and `win32-arm64` are dropped: `onnxruntime-node` and `sqlite-vec` ship no native binaries for them.

## [0.1.0] - 2026-10-22

First public release.

### Added

- Hybrid code search: BM25 (SQLite FTS5) and kNN (sqlite-vec) merged with RRF; `hybrid`, `semantic` and `lexical` modes.
- Find similar code by line range or by a snippet from stdin.
- Syntax-aware chunking with tree-sitter for TypeScript/JavaScript, Python, Go, Rust, Java, C#, C, C++, PHP, Ruby and Kotlin; Markdown by section.
- Two-phase indexing (lexical first, vectors in the background), a file watcher and a per-project daemon.
- Built-in local ONNX embedding models and OpenAI-compatible providers, with per-project consent before code is sent to an external host.
- CLI `code-embed` with `index`, `similar`, `status`, `daemon`, `stop`, `mcp`, `model`, `provider`, `gc`, `clean`, `export` and `import`.
- MCP server with the `search` and `find_similar` tools.
- VS Code extension: search panel with keyboard navigation and result actions, Quick Search, Find Similar Code, settings page, LM Tools `#semsearch` and `#similar`, MCP server definition provider.
- Shared inference host, on by default (`CODE_EMBED_SHARED_HOST=0` turns it off): one host per machine serves the local models for all windows, daemons, MCP servers and CLI runs, projects index interleaved instead of queueing, and `codeEmbed.index.threads` is one thread limit shared by all of them.
- Background-window throttling to keep load low with many VS Code windows open.
- Safe concurrent access to the embeddings database from several processes.
- Search and "Find Similar" answer within 800 ms during indexing, or return a result marked `partial`.

[Unreleased]: https://github.com/kulebiaka/code-embed/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/kulebiaka/code-embed/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/kulebiaka/code-embed/releases/tag/v0.1.0
