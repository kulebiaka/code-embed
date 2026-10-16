# Configuration

## Precedence

From highest to lowest: CLI flags, the project's `.code-embed.toml`, editor settings (VS Code `codeEmbed.*`), the user `config.toml`, defaults. Exception: `threads` and `pause_on_battery` cannot be set in the project file.

User files (`config.toml`, `providers.toml`, `consents.toml`) live in the config directory (override with `CODE_EMBED_CONFIG_DIR`). The global cache (`emb.db`, models) lives in the cache directory (`CODE_EMBED_CACHE_DIR`).

## .code-embed.toml

A file in the project root. It is local and not committed: when the tool creates it, it adds a `.code-embed.toml` line to the project's `.gitignore` if it is not there yet.

| Key | Values | Default |
| --- | --- | --- |
| `exclude` | array of path globs | `[]` |
| `embedding.provider` | `local` or a provider name | `local` |
| `embedding.model` | catalog model id | `qwen3-embedding-0.6b` |
| `index.location` | `project` or `cache` | automatic |
| `index.max_file_kb` | number | 512 |
| `search.default_mode` | `hybrid`, `semantic`, `lexical` | `hybrid` |
| `search.top` | number | 20 |

The keys `base_url`, `api_key` and `api_key_env` are not allowed in the project file: addresses are set only in `providers.toml`, and keys are never stored in files.

## providers.toml

```toml
[ollama]
kind = "openai"
base_url = "http://localhost:11434/v1"
model = "nomic-embed-text"
dimensions = 768
batch_size = 32

[remote]
kind = "openai"
base_url = "https://api.example.com/v1"
model = "text-embedding-3-small"
query_prefix = ""
doc_prefix = ""
max_input_tokens = 8191
concurrency = 4
api_key_env = "EXAMPLE_API_KEY"
rpm = 3000
tpm = 1000000
```

Fields: `kind` (only `openai` for now), `base_url`, `model` (required), `query_prefix`, `doc_prefix`, `max_input_tokens`, `batch_size`, `concurrency`, `dimensions`, `api_key_env`, `rpm`, `tpm`. The API key is not written to the file: put the name of an environment variable in `api_key_env`.

The VS Code setting `codeEmbed.providers` accepts the same format (without keys); on a name clash it overrides `providers.toml`.

Model identifier in the index: `<provider>/<model>@<dims>`.

## Local and external providers

- Loopback (`localhost`, `127.0.0.1`, `::1`) and unix sockets: a local provider, no warnings.
- Any other address: external. Before code is sent for the first time, explicit per-project consent is required ("code will be sent to `<host>`"). Consent is stored in `consents.toml`, shared by the CLI and the extension. In the CLI: an interactive prompt or `--allow-remote`.

## VS Code settings

Every setting in the table below is available on the `Code Embed: Open Settings` page (the gear in the search panel title). The same page adds providers without editing JSON, tests the connection and sets API keys. Keys are kept in VS Code secret storage and never land in `settings.json`. Changes are written to user or workspace settings; the scope is chosen at the top of the page. Exception: `codeEmbed.index.threads` is machine-wide and is always written to user settings.

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `codeEmbed.index.location` | `auto` / `project` / `cache` | `auto` | where to store the index; `auto` falls back to the cache on risky file systems (network drives, cloud sync) |
| `codeEmbed.index.maxFileKb` | number | 512 | larger files are not indexed |
| `codeEmbed.index.threads` | integer | 0 | total local-model threads per machine, across all windows and projects (0 = automatic: half of the cores, at most 4); user settings only |
| `codeEmbed.index.pauseOnBattery` | boolean | false | pause the vector phase on battery |
| `codeEmbed.index.exclude` | glob array | `[]` | extra excludes on top of `.gitignore`, `files.exclude` and `search.exclude` |
| `codeEmbed.search.defaultMode` | `hybrid` / `semantic` / `lexical` | `hybrid` | default search mode |
| `codeEmbed.search.top` | integer | 20 | number of results |
| `codeEmbed.model.id` | string | `qwen3-embedding-0.6b` | local model from the catalog |
| `codeEmbed.model.offlineArchive` | string | empty | path to an offline model archive |
| `codeEmbed.providers` | object | `{}` | providers: name → configuration (no keys) |
| `codeEmbed.embedding.provider` | string | `local` | `local` or a provider name |
