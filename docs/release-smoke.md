# Release smoke checklist

Automated: the `compat-smoke` workflow runs the extension in VS Code 1.101.0 (the minimum from `engines.vscode`) and stable on Linux, macOS and Windows for every `v*` tag. Locally: `pnpm build && pnpm --filter code-embed-vscode test:e2e` (`E2E_VSCODE_VERSIONS=stable` narrows the run).

Manual: run the checklist below for each environment on every release, using the VSIX built for that environment's platform.

## Checklist

For each environment:

1. Install the VSIX, open a folder with source code (a small repo is enough), reload the window.
2. Panel: the Code Embed icon is in the activity bar, the panel opens (Cmd/Ctrl+Alt+F), the status shows indexing progress and then "ready".
3. Search: type a natural-language query in the panel, results appear, a click opens the file at the right line. `Code Embed: Quick Search` works from the palette.
4. Copy MCP Config: run `Code Embed: Copy MCP Config`, paste into the editor, the text is valid JSON with `mcpServers.code-embed`.
5. Agent (where the editor has an agent): the `code-embed` MCP server (or the `#semsearch` tool in VS Code) is available and returns results for a query.

Environment notes:

- Cursor, Windsurf: add the copied config to `mcp.json` (`~/.cursor/mcp.json`, `~/.codeium/windsurf/mcp_config.json`), check the server shows as running.
- Remote-SSH, WSL, Dev Containers: the extension runs in the workspace (remote) host; install it into the remote, the index is created on the remote file system, the VSIX target matches the remote OS and CPU (`linux-x64` / `linux-arm64`).

## Results

Fill in one row per release.

| Release | Environment | Version | Panel | Search | Copy MCP Config | Tester | Date | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| | Cursor | | | | | | | |
| | Windsurf | | | | | | | |
| | Remote-SSH | | | | | | | |
| | WSL | | | | | | | |
| | Dev Containers | | | | | | | |
