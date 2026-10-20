# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). The npm package `code-embed` and the VS Code extension share one version.

## [Unreleased]

### Added

- Shared inference host, on by default (`CODE_EMBED_SHARED_HOST=0` turns it off): one host per machine serves the local models for all windows, daemons, MCP servers and CLI runs, projects index interleaved instead of queueing, and `codeEmbed.index.threads` is one thread limit shared by all of them.

### Fixed

- Search and "Find Similar" during indexing: the 800 ms budget now counts from the start of the request, not only the embedding step, so a response is either on time or marked `partial` with `timed out`.
- Concurrent access to `emb.db` from several processes: `busy_timeout`, a retry of the WAL initialization when the database is busy, `BEGIN IMMEDIATE` on writes, and a non-blocking `last_used` update on reads.

## [0.1.0] - 2026-10-16

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
- One local-model indexing slot per machine, a shared thread budget and background-window throttling to keep load low with many VS Code windows open.

[Unreleased]: https://github.com/kulebiaka/code-embed/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/kulebiaka/code-embed/releases/tag/v0.1.0
