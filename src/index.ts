import { execFile } from "node:child_process";
import { createWriteStream, promises as fs } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { promisify } from "node:util";
import {
  buildReleaseBody,
  calculateRetryDelayMs,
  extractVersionFromTarballName,
  isFullSemver,
  isRetryableDownloadStatus,
  resolveVersion,
  selectBinaries,
  selectRecentVersions,
  type IndexEntry,
  type MatchedBinary,
  type SourceFile
} from "./lib";

const execFileAsync = promisify(execFile);

type ReleaseOptions = {
  command: "release";
  version: string;
  owner: string;
  repo: string;
  outDir: string;
  tagPrefix: string;
  maxConcurrentDownloads: number;
  dryRun: boolean;
};

type DiscoverOptions = {
  command: "discover";
  sinceDays: number;
};

type CliOptions = ReleaseOptions | DiscoverOptions;

const BULK_SOURCE_URL = "https://dl.static-php.dev/static-php-cli/bulk/?format=json";
const RELEASE_SOURCE_URLS = [
  BULK_SOURCE_URL,
  "https://dl.static-php.dev/static-php-cli/windows/spc-max/?format=json"
];

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  if (options.command === "discover") {
    const versions = await discoverRecentVersions(options.sinceDays);
    process.stdout.write(JSON.stringify(versions));
    return;
  }

  const version = isFullSemver(options.version)
    ? options.version
    : await resolvePartialVersion(options.version);
  console.log(`Resolved version: ${version}`);

  const binaries = await fetchMatchingBinaries(version);
  if (binaries.length === 0) {
    throw new Error(`No matching binaries found for PHP ${version}.`);
  }

  const downloaded = await downloadBinaries(
    binaries,
    options.outDir,
    options.dryRun,
    options.maxConcurrentDownloads
  );

  if (options.dryRun) {
    console.log("Dry-run mode: skipping GitHub release upsert.");
    return;
  }

  const tagName = `${options.tagPrefix}${version}`;
  const releaseName = `PHP v${version}`;
  const body = buildReleaseBody(version);
  const ghRepo = `${options.owner}/${options.repo}`;

  await ghUpsertRelease(ghRepo, tagName, releaseName, body, downloaded);
}

function parseArgs(args: string[]): CliOptions {
  if (args.length === 0) {
    throw new Error("Usage: <command> [flags]. Commands: release, discover.");
  }

  const command = args[0] ?? "";
  const { map, flags } = parseFlags(args.slice(1));

  if (command === "discover") {
    const sinceDays = parsePositiveNumber(map.get("--since-days") ?? "2", "--since-days");
    return {
      command,
      sinceDays
    };
  }

  if (command === "release") {
    const version = mustGet(map, "--version");
    const owner = map.get("--owner") ?? process.env.GITHUB_REPOSITORY_OWNER ?? "";
    const repo = map.get("--repo") ?? process.env.GITHUB_REPOSITORY?.split("/")[1] ?? "";
    if (!owner) {
      throw new Error("--owner is required (or set GITHUB_REPOSITORY_OWNER).");
    }
    if (!repo) {
      throw new Error("--repo is required (or set GITHUB_REPOSITORY=owner/repo).");
    }

    return {
      command,
      version,
      owner,
      repo,
      outDir: map.get("--out-dir") ?? "downloads",
      tagPrefix: map.get("--tag-prefix") ?? "v",
      maxConcurrentDownloads: parsePositiveNumber(
        map.get("--max-concurrent-downloads") ?? "3",
        "--max-concurrent-downloads"
      ),
      dryRun: flags.has("--dry-run")
    };
  }

  throw new Error(`Unsupported command: ${command}. Commands: release, discover.`);
}

function parseFlags(args: string[]): { map: Map<string, string>; flags: Set<string> } {
  const map = new Map<string, string>();
  const flags = new Set<string>();

  for (let i = 0; i < args.length; i += 1) {
    const part = args[i];
    if (!part.startsWith("--")) {
      throw new Error(`Invalid argument '${part}'. Expected flag starting with '--'.`);
    }

    if (part === "--dry-run") {
      flags.add(part);
      continue;
    }

    const value = args[i + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for '${part}'.`);
    }

    map.set(part, value);
    i += 1;
  }

  return { map, flags };
}

function mustGet(map: Map<string, string>, key: string): string {
  const value = map.get(key);
  if (!value) {
    throw new Error(`${key} is required.`);
  }
  return value;
}

function parsePositiveNumber(raw: string, flagName: string): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${flagName} must be a positive number.`);
  }
  return value;
}

async function resolvePartialVersion(partial: string): Promise<string> {
  console.log(`Resolving partial version '${partial}' from ${BULK_SOURCE_URL}`);
  const json = await fetchJsonIndex(BULK_SOURCE_URL);

  const versions = new Set<string>();
  for (const item of json) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const name = getString(record, "name");
    const version = name ? extractVersionFromTarballName(name) : null;
    if (version) versions.add(version);
  }

  const resolved = resolveVersion(partial, [...versions]);
  if (!resolved) {
    throw new Error(`No PHP version found matching '${partial}'.`);
  }

  console.log(`Resolved '${partial}' to '${resolved}'`);
  return resolved;
}

async function fetchJsonIndex(url: string): Promise<unknown[]> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
  }

  const json = await response.json();
  if (!Array.isArray(json)) {
    throw new Error(`Unexpected index format from ${url}.`);
  }

  return json;
}

function getString(item: Record<string, unknown>, key: string): string {
  const value = item[key];
  return typeof value === "string" ? value : "";
}

async function discoverRecentVersions(sinceDays: number): Promise<string[]> {
  const json = await fetchJsonIndex(BULK_SOURCE_URL);

  const entries: IndexEntry[] = [];
  for (const item of json) {
    if (!item || typeof item !== "object") {
      continue;
    }

    const record = item as Record<string, unknown>;
    const name = getString(record, "name");
    if (!name) {
      continue;
    }

    entries.push({
      name,
      last_modified: getString(record, "last_modified") || undefined,
      is_dir: typeof record.is_dir === "boolean" ? record.is_dir : undefined
    });
  }

  return selectRecentVersions(entries, sinceDays);
}

async function fetchMatchingBinaries(version: string): Promise<MatchedBinary[]> {
  const results = await Promise.all(
    RELEASE_SOURCE_URLS.map(async (url) => {
      console.log(`Fetching index: ${url}`);
      const json = await fetchJsonIndex(url);
      const files: SourceFile[] = [];

      for (const item of json) {
        if (!item || typeof item !== "object") {
          continue;
        }
        const record = item as Record<string, unknown>;
        const name = getString(record, "name");
        const fullPath = getString(record, "full_path");
        if (!name || !fullPath) {
          continue;
        }
        files.push({ name, full_path: fullPath });
      }

      return files;
    })
  );

  const files = results.flat();
  const matches = selectBinaries(files, version);
  const deduped = new Map<string, MatchedBinary>();

  for (const match of matches) {
    if (deduped.has(match.releaseName)) {
      console.log(`Skipping duplicate target filename '${match.releaseName}' from '${match.sourcePath}'.`);
      continue;
    }
    deduped.set(match.releaseName, match);
  }

  return [...deduped.values()];
}

async function downloadBinaries(
  binaries: MatchedBinary[],
  outDir: string,
  dryRun: boolean,
  maxConcurrentDownloads: number
): Promise<string[]> {
  await fs.mkdir(outDir, { recursive: true });
  const maxAttempts = 4;

  async function downloadOne(binary: MatchedBinary): Promise<string> {
    const sourceUrl = `https://dl.static-php.dev/${binary.sourcePath.replace(/^\/+/, "")}`;
    const targetPath = path.join(outDir, binary.releaseName);

    if (dryRun) {
      console.log(`[dry-run] Would download ${sourceUrl} -> ${targetPath}`);
      return targetPath;
    }

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const attemptPrefix = maxAttempts > 1 ? ` (attempt ${attempt}/${maxAttempts})` : "";
      console.log(`Downloading ${sourceUrl}${attemptPrefix}`);

      try {
        const response = await fetch(sourceUrl);
        if (!response.ok || !response.body) {
          const reason = `Failed to download ${sourceUrl}: ${response.status} ${response.statusText}`;
          if (attempt < maxAttempts && isRetryableDownloadStatus(response.status)) {
            const delayMs = calculateRetryDelayMs(attempt);
            console.log(`Transient download failure, retrying in ${delayMs}ms: ${reason}`);
            await sleep(delayMs);
            continue;
          }
          throw new Error(reason);
        }

        const nodeStream = Readable.fromWeb(response.body as unknown as NodeReadableStream<Uint8Array>);
        await pipeline(nodeStream, createWriteStream(targetPath));

        const stat = await fs.stat(targetPath);
        const MIN_SIZE = 5 * 1024 * 1024;
        if (stat.size < MIN_SIZE) {
          throw new Error(`Downloaded file ${binary.releaseName} is only ${(stat.size / 1024 / 1024).toFixed(1)}MB — expected at least 5MB.`);
        }

        console.log(`Saved ${targetPath} (${(stat.size / 1024 / 1024).toFixed(1)}MB)`);
        return targetPath;
      } catch (error) {
        await fs.rm(targetPath, { force: true });

        if (attempt < maxAttempts && isRetryableError(error)) {
          const delayMs = calculateRetryDelayMs(attempt);
          const message = error instanceof Error ? error.message : String(error);
          console.log(`Transient download error, retrying in ${delayMs}ms: ${message}`);
          await sleep(delayMs);
          continue;
        }

        throw error;
      }
    }

    throw new Error(`Unreachable retry state for ${sourceUrl}.`);
  }

  const workerCount = Math.max(1, Math.min(maxConcurrentDownloads, binaries.length));
  const downloaded = new Array<string>(binaries.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (true) {
      const currentIndex = nextIndex;
      nextIndex += 1;

      if (currentIndex >= binaries.length) {
        return;
      }

      downloaded[currentIndex] = await downloadOne(binaries[currentIndex]);
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return downloaded;
}

function isRetryableError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const maybeError = error as { name?: unknown; code?: unknown };
  if (typeof maybeError.name === "string" && maybeError.name === "AbortError") {
    return true;
  }

  return typeof maybeError.code === "string";
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function gh(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("gh", args);
  return stdout.trim();
}

async function ghReleaseExists(repo: string, tag: string): Promise<boolean> {
  try {
    await gh(["release", "view", tag, "--repo", repo]);
    return true;
  } catch {
    return false;
  }
}

async function ghUpsertRelease(repo: string, tag: string, title: string, body: string, files: string[]): Promise<void> {
  const exists = await ghReleaseExists(repo, tag);

  if (exists) {
    console.log(`Updating existing release ${tag}`);
    await gh(["release", "edit", tag, "--repo", repo, "--title", title, "--notes", body]);
  } else {
    console.log(`Creating release ${tag}`);
    await gh(["release", "create", tag, "--repo", repo, "--title", title, "--notes", body]);
  }

  console.log(`Uploading ${files.length} assets to ${tag}`);
  await gh(["release", "upload", tag, "--repo", repo, "--clobber", ...files]);

  const url = await gh(["release", "view", tag, "--repo", repo, "--json", "url", "-q", ".url"]);
  console.log(`Release updated: ${url}`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`ERROR: ${message}`);
  process.exit(1);
});
