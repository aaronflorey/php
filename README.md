# php-binaries

This repository mirrors official PHP 8.x CLI binaries from Static PHP into GitHub Releases.

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

## Automation

The repository uses one GitHub Actions workflow:

- runs twice a day
- also supports manual dispatch
- runs one Bun TypeScript CLI
- processes versions concurrently with a limit of `5`
- writes important warnings and outcomes to the GitHub Actions summary

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

## Development

```bash
bun test
bun run typecheck
```
