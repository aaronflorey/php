# php-binaries

This repository mirrors official PHP 8.x CLI binaries from Static PHP into GitHub Releases.

It also exposes a composite GitHub Action that installs those mirrored binaries in other workflows.

It includes a mise plugin that replaces mise's default PHP backend with these prebuilt binaries.

It does not build PHP. It:

- reads official release versions from `php.net`
- limits each minor line to `latest patch - 10` through current
- checks which CLI binaries exist in `static-php.dev`
- ensures each matching GitHub release exists
- uploads any missing assets

## Sources

- Official PHP releases: `https://www.php.net/releases/?json`
- Official PHP branch releases: `https://www.php.net/releases/index.php?json&version=8.x`
- Official PHP changelog history: `https://www.php.net/ChangeLog-8.php`
- Static PHP binary indexes:
  - `https://dl.static-php.dev/static-php-cli/bulk/?format=json`
  - `https://dl.static-php.dev/static-php-cli/windows/spc-max/?format=json`

## Setup Action

Use the repository action directly from `@main`:

```yaml
steps:
  - uses: actions/checkout@v4

  - uses: aaronflorey/php@main
    with:
      php-version: 8.4
      composer: "true"

  - run: php -v
  - run: composer --version
```

Inputs:

- `php-version`: `latest` by default. Accepts `latest`, a minor alias like `8.4`, or an exact version like `8.4.20`.
- `composer`: `"false"` by default. Set to `"true"` to install Composer after PHP.

The action resolves versions from the checked-in `versions.json` manifest, then downloads the matching GitHub release asset for the current runner.

## mise plugin

Install this repository as the `php` plugin. `--force` replaces any PHP plugin that mise already installed from its registry:

```bash
mise plugins install --force php https://github.com/aaronflorey/php.git
```

The normal `php` tool name then uses this repository:

```bash
mise use php@latest
mise use php@8.4
mise use php@8.4.20
mise exec php@8.4 -- php -v
```

The plugin reads `versions.json`, resolves `latest` and minor aliases, selects the current platform's release asset, and adds the extracted archive root to `PATH`. It supports the Linux and macOS x86_64/aarch64 assets and the Windows assets present in the manifest. Unlike mise's default PHP plugins, it downloads a prebuilt CLI and does not compile PHP locally.

## Manifest

`versions.json` is generated from GitHub releases that actually contain installable binaries. It includes:

- a `latest.stable` alias for the newest installable release
- a `latest` alias per minor line like `8.4 -> 8.4.20`
- stable GitHub release download URLs per platform asset

Releases with no assets are excluded, so action lookups only resolve to installable versions.

## Automation

The repository uses two GitHub Actions workflows:

- runs twice a day
- also supports manual dispatch
- runs one Bun TypeScript CLI
- processes versions concurrently with a limit of `5`
- writes important warnings and outcomes to the GitHub Actions summary
- regenerates `versions.json` from installable GitHub releases and commits it when it changes
- smoke-tests the setup action on Linux, macOS, and Windows during `push` and `pull_request`

If `static-php.dev` does not have CLI binaries for an official PHP release, the run logs a warning and includes it in the job summary instead of creating an empty release.

## Local usage

Install dependencies:

```bash
bun install
```

Dry run:

```bash
bun run src/index.ts --dry-run
```

Run against a specific repository locally:

```bash
GH_TOKEN=... GITHUB_REPOSITORY=owner/repo bun run src/index.ts
```

Optional flags:

```text
--dry-run
--repo owner/repo
--temp-dir /tmp/php-binaries
--max-version-concurrency 5
--max-download-concurrency 5
```

Generate the install manifest locally:

```bash
bun run manifest --repo owner/repo
```

## Development

```bash
bun test
bun run test:plugin
bun run typecheck
```
