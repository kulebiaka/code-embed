# Agent integration

LM Tools, MCP and `code-embed --json` share one contract for five tools (`packages/protocol/src/tools.ts`).

## Tools

`search`:

| Field | Description |
| --- | --- |
| `query` | required; a query in any language, including Russian |
| `mode` | `hybrid` (default), `semantic`, `lexical` |
| `top` | 1-50 |
| `include`, `exclude` | arrays of path globs relative to the project root |
| `lang` | language id |

`find_similar`: either `{ path, start_line, end_line, top? }` (1-based, inclusive) or `{ code, lang?, top? }`. The two forms cannot be mixed.

`outline`: `{ path }`, the symbols of one file (line range, kind, name, signature).

`references`: `{ symbol, path? }`, definitions and usages of a symbol by name. It is name-based, not a replacement for LSP find-references: every item has a confidence (`high` or `low`), and `path` restricts definitions to one file.

`context`: either `{ path, line, budget_tokens? }` (1-based) or `{ query, budget_tokens? }`. The two forms cannot be mixed. The package is cut to `budget_tokens` (default 4000) and filled in priority order: the target chunk; definitions of the symbols it calls (signature and first 5 lines, `high` confidence only); callers; tests; similar code; lexical matches. The recent commits of the target file are added too, the last 5 as short hash, date and subject. Levels that did not fit are reported as omitted.

Result of `search` and `find_similar`: ranked chunks (path, line range, symbol, snippet). The tools do not replace grep: for an exact identifier, string or error message, use grep/ripgrep.

### Which tool when

- Meaning, unknown identifiers: `search`. Other places that need the same fix: `find_similar`.
- Structure of a file before reading it: `outline`.
- Who defines and who uses a symbol: `references`. For precise, type-aware answers use the language server.
- Before changing code, to see what it depends on and what depends on it: `context`.

## VS Code (LM Tools)

The extension registers `#semsearch` (`search`), `#similar` (`find_similar`), `#outline` (`outline`), `#refs` (`references`) and `#context` (`context`). You can reference them in chat (`#semsearch where is the payment refund processed`); the agent also calls them on its own based on the tool descriptions.

## MCP

```bash
code-embed mcp --root /path/to/project
```

A stdio MCP server with the `search`, `find_similar`, `outline`, `references` and `context` tools. Root: the current directory or `--root`. stdout carries the protocol; logs go to stderr.

### Copy MCP Config

The `Code Embed: Copy MCP Config` command copies JSON for Cursor and Windsurf `mcp.json` to the clipboard:

```json
{
  "mcpServers": {
    "code-embed": { "command": "npx", "args": ["-y", "code-embed@0.1.0", "mcp", "--root", "/path/to/project"] }
  }
}
```

The version and root are filled in automatically.

## CLI for agents

`code-embed --json "<query>"` prints results as JSON lines; exit code 1 means "nothing found". The other tools have commands too: `code-embed outline <path>`, `code-embed refs <symbol> [--path PATH]`, `code-embed context <path>:<line> | "<query>" [--budget N]`; each accepts `--json`. See [cli.md](cli.md). A ready-made rule for `CLAUDE.md` / `AGENTS.md` is in the "Snippet for CLAUDE.md / AGENTS.md" section of the [README](../README.md#snippet-for-claudemd--agentsmd).
