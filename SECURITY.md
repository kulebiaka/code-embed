# Security policy

## Supported versions

Security fixes go into the latest released version of the `code-embed` npm package and the VS Code extension.

## Reporting a vulnerability

Please do not open a public issue. Report it privately through [GitHub Security Advisories](https://github.com/kulebiaka/code-embed/security/advisories/new) with the version, platform, steps to reproduce and the impact you see.

You will get a reply within 7 days. Once a fix is released, the advisory is published with credit to the reporter unless you ask otherwise.

## Scope

code-embed runs locally: it indexes files on disk, keeps the index under the project and the user cache directory, and sends code to an external host only for an embedding provider the user configured and consented to per project. Issues that are especially relevant:

- code sent to an external provider without consent, or files ignored by `.gitignore` / `.code-embed.toml` ending up in the index;
- the per-project daemon, the shared inference host or the MCP server being reachable by other users of the machine;
- model downloads that skip checksum verification.
