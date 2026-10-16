# Agent integration

LM Tools, MCP and `code-embed --json` share one contract for two tools (`packages/protocol/src/tools.ts`).

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

Result: ranked chunks (path, line range, symbol, snippet). The tools do not replace grep: for an exact identifier, string, error message or a list of a symbol's usages, use grep/ripgrep.

## VS Code (LM Tools)

The extension registers `#semsearch` (`search`) and `#similar` (`find_similar`). You can reference them in chat (`#semsearch where is the payment refund processed`); the agent also calls them on its own based on the tool descriptions.

## MCP

```bash
code-embed mcp --root /path/to/project
```

A stdio MCP server with the `search` and `find_similar` tools. Root: the current directory or `--root`. stdout carries the protocol; logs go to stderr.

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

`code-embed --json "<query>"` prints results as JSON lines; exit code 1 means "nothing found". A ready-made rule for `CLAUDE.md` / `AGENTS.md` is in the "Snippet for CLAUDE.md / AGENTS.md" section of the [README](../README.md#snippet-for-claudemd--agentsmd).
