# php

This repository republishes prebuilt PHP binaries to GitHub Releases.

It does **not** compile PHP from source. Instead, it pulls official artifacts from [`crazywhalecc/static-php-cli`](https://github.com/crazywhalecc/static-php-cli), renames them consistently, and publishes them as release assets.

## Where binaries come from

- macOS/Linux: [`bulk`](https://dl.static-php.dev/static-php-cli/bulk/)
- Windows: [`spc-max`](https://dl.static-php.dev/static-php-cli/windows/spc-max/)

This combination gives broad platform coverage while keeping the release process simple.

## How releases are automated

The release logic lives in a Bun + TypeScript CLI and is bundled to `dist/index.js` with `@vercel/ncc`.
GitHub Actions runs the bundled file, so remember to rebuild `dist/` when CLI behavior changes.

## CLI usage

Discover recently updated versions (default window is 2 days):

```bash
node dist/index.js discover --since-days 2
```

Dry-run a release (safe local check):

```bash
node dist/index.js release \
  --version 8.4 \
  --owner aaronflorey \
  --repo php \
  --dry-run
```

Publish or update a release (requires token):

```bash
GITHUB_TOKEN=... node dist/index.js release \
  --version 8.4 \
  --owner aaronflorey \
  --repo php
```

If you see gateway/time-out issues while downloading assets, lower download concurrency:

```bash
node dist/index.js release ... --max-concurrent-downloads 1
```

## Development

```bash
bun install
bun run hooks:install
bun run test
bun run typecheck
bun run build
```

## Installing published binaries

The published artifacts work well with [ubi](https://github.com/houseabsolute/ubi).
If you use [mise](https://github.com/jdx/mise), one option is:

```bash
mise use github:aaronflorey/php@8.4
```
