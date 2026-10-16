# Contributing

Thanks for your interest in code-embed! Bug reports, ideas and pull requests are welcome.

## Development setup

Requirements: Node.js 22.13+ and pnpm 10 (`corepack enable` picks the version from `package.json`).

```bash
pnpm install
pnpm build        # engine (packages/engine/dist) and extension (packages/extension/dist)
pnpm test         # unit and e2e tests (vitest), uses a fake embedder, no model download
pnpm typecheck
pnpm check:docs   # needs a built engine
```

Run the CLI from source: `pnpm --filter code-embed dev "query"`. Try the extension after `pnpm build`: `code --extensionDevelopmentPath="$PWD/packages/extension" <some project>`. Extension e2e tests in a real VS Code: `pnpm --filter code-embed-vscode test:e2e`.

Layout:

| Path | What |
| --- | --- |
| `packages/engine` | engine and CLI, published to npm as `code-embed` |
| `packages/extension` | VS Code extension, published as per-platform VSIX packages |
| `packages/protocol` | JSON-RPC and tool types shared by the engine and the extension (bundled, not published) |
| `eval` | search quality evaluation and runtime smoke checks |
| `docs` | user documentation |

## Pull requests

- Keep changes focused; one topic per PR.
- Add or update tests for behavior changes. `pnpm test` and `pnpm typecheck` must pass.
- Update the docs when you change CLI flags, settings or the model catalog: `pnpm check:docs` checks that `docs/cli.md`, `docs/configuration.md` and the README match the code.
- Add a line under `## [Unreleased]` in [CHANGELOG.md](CHANGELOG.md) for user-visible changes.
- Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/) (`feat(engine): …`, `fix(extension): …`, `docs: …`).

## Versioning and releases

code-embed follows [Semantic Versioning](https://semver.org/). The npm package and the VS Code extension always share one version; while the version is `0.x`, minor releases may contain breaking changes.

To cut a release from `main`:

```bash
pnpm release:version minor        # or patch / major / 1.2.3
git commit -am "chore(release): v0.2.0"
git tag v0.2.0
git push --follow-tags
```

`release:version` bumps every package, updates the pinned version in the docs and moves the `[Unreleased]` section of the changelog under the new version. Pushing a `v*` tag runs `.github/workflows/release.yml`: runtime checks and VSIX builds on all six platforms, then npm, VS Code Marketplace, Open VSX and a GitHub Release with notes taken from the changelog.

Repository secrets the release needs: `NPM_TOKEN`, `VSCE_PAT` (Azure DevOps token for the `code-embed` Marketplace publisher) and `OVSX_PAT` (Open VSX token for the `code-embed` namespace). Model mirror: run the `models-mirror` workflow once with the tag from `mirror.tag` in `packages/engine/src/embed/models.json`.

Before a release, go through the manual checklist in [docs/release-smoke.md](docs/release-smoke.md).
