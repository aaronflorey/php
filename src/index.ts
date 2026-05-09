import { appendFile, mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import pLimit from "p-limit";
import {
  buildReleaseBody,
  buildVersionPlan,
  calculateRetryDelayMs,
  compareVersions,
  diffMissingAssets,
  extractVersionFromSourceTarball,
  extractVersionsFromChangelog,
  indexBinariesByVersion,
  isRetryableDownloadStatus,
  parseVersion,
  selectVersionsForMinor,
  type MatchedBinary,
  type SourceFile,
  type VersionSyncPlan
} from "./lib";

const PHP_RELEASES_URL = "https://www.php.net/releases/?json";
const PHP_RELEASE_BRANCH_URL = "https://www.php.net/releases/index.php?json&version=";
const PHP_CHANGELOG_URL = "https://www.php.net/ChangeLog-8.php";
const STATIC_PHP_INDEXES = [
  "https://dl.static-php.dev/static-php-cli/bulk/?format=json",
  "https://dl.static-php.dev/static-php-cli/windows/spc-max/?format=json"
];
const STATIC_PHP_BASE_URL = "https://dl.static-php.dev";
const MINIMUM_MINOR = 0;
const MAX_PREVIOUS_PATCHES = 10;
const DEFAULT_VERSION_CONCURRENCY = 5;
const DEFAULT_DOWNLOAD_CONCURRENCY = 5;
const MIN_BINARY_BYTES = 5 * 1024 * 1024;

type CliOptions = {
  dryRun: boolean;
  repo: string;
  tempDir: string;
  maxVersionConcurrency: number;
  maxDownloadConcurrency: number;
};

type OfficialBranchRelease = {
  version: string;
};

type ReleaseView = {
  url: string;
  assets: Array<{ name: string }>;
};

type VersionResult = {
  version: string;
  status: "already-complete" | "updated" | "would-update" | "skipped-no-binaries" | "failed";
  releaseUrl?: string;
  warning?: string;
  uploadedAssets: string[];
  existingAssets: number;
  expectedAssets: number;
  error?: string;
};

class SummaryBuilder {
  private readonly lines: string[] = [];

  heading(text: string): void {
    this.lines.push(`## ${text}`);
    this.lines.push("");
  }

  line(text: string): void {
    this.lines.push(text);
  }

  blank(): void {
    this.lines.push("");
  }

  async write(): Promise<void> {
    const summaryPath = process.env.GITHUB_STEP_SUMMARY;
    if (!summaryPath) {
      return;
    }

    await Bun.write(summaryPath, `${this.lines.join("\n")}\n`);
  }

  toString(): string {
    return `${this.lines.join("\n")}\n`;
  }
}

async function main(): Promise<void> {
  const options = parseCliArgs();
  const summary = new SummaryBuilder();
  const downloadLimit = pLimit(options.maxDownloadConcurrency);

  log("info", `Starting sync for ${options.repo}${options.dryRun ? " (dry-run)" : ""}`);
  summary.heading("PHP Release Sync");
  summary.line(`- Repository: \`${options.repo}\``);
  summary.line(`- Dry run: \`${String(options.dryRun)}\``);
  summary.line(`- Version concurrency: \`${options.maxVersionConcurrency}\``);
  summary.line(`- Download concurrency: \`${options.maxDownloadConcurrency}\``);
  summary.blank();

  const [latestPhp8, changelogText, staticPhpFiles] = await Promise.all([
    fetchLatestPhp8Release(),
    fetchText(PHP_CHANGELOG_URL),
    fetchStaticPhpFiles()
  ]);

  const maxMinor = parseVersion(latestPhp8).minor;
  log("info", `Official latest PHP 8 release is ${latestPhp8}; scanning 8.0 through 8.${maxMinor}`);

  const officialVersions = extractVersionsFromChangelog(changelogText);
  const latestByMinor = await fetchLatestVersionsByMinor(maxMinor);
  const binariesByVersion = indexBinariesByVersion(staticPhpFiles);
  const plans = buildPlans(latestByMinor, officialVersions, binariesByVersion);

  summary.heading("Inputs");
  summary.line(`- Official latest PHP 8 release: \`${latestPhp8}\``);
  summary.line(`- Official minors scanned: \`8.0\` through \`8.${maxMinor}\``);
  summary.line(`- Official versions in target windows: \`${plans.length}\``);
  summary.line(`- SPC versions with CLI binaries indexed: \`${binariesByVersion.size}\``);
  summary.line(`- Global download limit: \`${options.maxDownloadConcurrency}\``);
  summary.blank();

  const limit = pLimit(options.maxVersionConcurrency);
  const results = await Promise.all(plans.map((plan) => limit(() => syncVersion(plan, options, downloadLimit))));

  const failures = results.filter((result) => result.status === "failed");
  const warnings = results.filter((result) => result.warning);
  const updated = results.filter((result) => result.status === "updated");
  const wouldUpdate = results.filter((result) => result.status === "would-update");
  const complete = results.filter((result) => result.status === "already-complete");
  const skipped = results.filter((result) => result.status === "skipped-no-binaries");

  summary.heading("Results");
  summary.line(`- Updated releases: \`${updated.length}\``);
  summary.line(`- Dry-run pending updates: \`${wouldUpdate.length}\``);
  summary.line(`- Already complete releases: \`${complete.length}\``);
  summary.line(`- Skipped for missing SPC binaries: \`${skipped.length}\``);
  summary.line(`- Failures: \`${failures.length}\``);
  summary.blank();

  summary.heading("Per Version");
  for (const result of results.sort((a, b) => compareVersions(a.version, b.version))) {
    const releaseSuffix = result.releaseUrl ? ` ([release](${result.releaseUrl}))` : "";
    summary.line(`- \`${result.version}\`: ${result.status}, expected ${result.expectedAssets}, existing ${result.existingAssets}, uploaded ${result.uploadedAssets.length}${releaseSuffix}`);
    if (result.warning) {
      summary.line(`  Warning: ${result.warning}`);
    }
    if (result.error) {
      summary.line(`  Error: ${result.error}`);
    }
  }
  summary.blank();

  if (warnings.length > 0) {
    summary.heading("Warnings");
    for (const result of warnings) {
      summary.line(`- \`${result.version}\`: ${result.warning}`);
    }
    summary.blank();
  }

  printTerminalSummary(summary, options.dryRun ? "DRY RUN SUMMARY" : "RUN SUMMARY");

  await summary.write();

  if (failures.length > 0) {
    throw new Error(`Sync failed for ${failures.length} version(s).`);
  }
}

function parseCliArgs(): CliOptions {
  const values = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      "dry-run": { type: "boolean", default: false },
      repo: { type: "string" },
      "temp-dir": { type: "string", default: path.join(os.tmpdir(), "php-binaries") },
      "max-version-concurrency": { type: "string", default: String(DEFAULT_VERSION_CONCURRENCY) },
      "max-download-concurrency": { type: "string", default: String(DEFAULT_DOWNLOAD_CONCURRENCY) }
    },
    allowPositionals: false,
    strict: true
  });

  const repo = values.values.repo ?? process.env.GITHUB_REPOSITORY ?? "";
  if (!repo) {
    throw new Error("--repo is required when GITHUB_REPOSITORY is not set.");
  }

  return {
    dryRun: values.values["dry-run"],
    repo,
    tempDir: values.values["temp-dir"],
    maxVersionConcurrency: parsePositiveNumber(values.values["max-version-concurrency"], "--max-version-concurrency"),
    maxDownloadConcurrency: parsePositiveNumber(values.values["max-download-concurrency"], "--max-download-concurrency")
  };
}

function parsePositiveNumber(raw: string, flag: string): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${flag} must be a positive number.`);
  }
  return value;
}

async function fetchLatestPhp8Release(): Promise<string> {
  const json = await fetchJson(PHP_RELEASES_URL);
  if (!json || typeof json !== "object") {
    throw new Error(`Unexpected JSON payload from ${PHP_RELEASES_URL}`);
  }

  const maybePhp8 = (json as Record<string, unknown>)["8"];
  if (!maybePhp8 || typeof maybePhp8 !== "object") {
    throw new Error("Official PHP 8 release payload is missing from php.net releases JSON.");
  }

  const version = getObjectString(maybePhp8 as Record<string, unknown>, "version");
  if (!version) {
    throw new Error("Official PHP 8 release payload did not include a version.");
  }

  return version;
}

async function fetchLatestVersionsByMinor(maxMinor: number): Promise<Map<number, string>> {
  const releases = await Promise.all(
    Array.from({ length: maxMinor - MINIMUM_MINOR + 1 }, (_, index) => fetchOfficialBranchRelease(8, MINIMUM_MINOR + index))
  );

  const versions = new Map<number, string>();
  for (const release of releases) {
    const parsed = parseVersion(release.version);
    versions.set(parsed.minor, release.version);
  }
  return versions;
}

async function fetchOfficialBranchRelease(major: number, minor: number): Promise<OfficialBranchRelease> {
  const versionPrefix = `${major}.${minor}`;
  const json = await fetchJson(`${PHP_RELEASE_BRANCH_URL}${versionPrefix}`);
  if (!json || typeof json !== "object") {
    throw new Error(`Unexpected JSON payload for PHP ${versionPrefix}.`);
  }

  const version = getObjectString(json as Record<string, unknown>, "version");
  if (!version) {
    const source = Array.isArray((json as Record<string, unknown>).source)
      ? (json as Record<string, unknown>).source as unknown[]
      : [];
    for (const entry of source) {
      if (!entry || typeof entry !== "object") continue;
      const filename = getObjectString(entry as Record<string, unknown>, "filename");
      const extracted = extractVersionFromSourceTarball(filename);
      if (extracted) {
        return { version: extracted };
      }
    }
    throw new Error(`Official release JSON for PHP ${versionPrefix} did not include a version.`);
  }

  return { version };
}

function buildPlans(
  latestByMinor: Map<number, string>,
  officialVersions: string[],
  binariesByVersion: Map<string, MatchedBinary[]>
): VersionSyncPlan[] {
  const versions = [...latestByMinor.entries()]
    .sort((a, b) => a[0] - b[0])
    .flatMap(([, latestVersion]) => selectVersionsForMinor(latestVersion, officialVersions, MAX_PREVIOUS_PATCHES));

  return versions.map((version) => buildVersionPlan(version, binariesByVersion.get(version) ?? []));
}

async function fetchStaticPhpFiles(): Promise<SourceFile[]> {
  const payloads = await Promise.all(STATIC_PHP_INDEXES.map((url) => fetchJson(url)));
  const files: SourceFile[] = [];

  for (const payload of payloads) {
    if (!Array.isArray(payload)) {
      throw new Error("Unexpected static-php.dev index payload.");
    }

    for (const item of payload) {
      if (!item || typeof item !== "object") {
        continue;
      }

      const name = getObjectString(item as Record<string, unknown>, "name");
      const fullPath = getObjectString(item as Record<string, unknown>, "full_path");
      if (!name || !fullPath) {
        continue;
      }

      files.push({ name, full_path: fullPath });
    }
  }

  return files;
}

async function syncVersion(
  plan: VersionSyncPlan,
  options: CliOptions,
  downloadLimit: ReturnType<typeof pLimit>
): Promise<VersionResult> {
  log("info", `Checking ${plan.version}`);

  if (plan.expectedAssets.length === 0) {
    const warning = `Official release ${plan.version} has no matching SPC CLI binaries yet.`;
    log("warn", warning);
    return {
      version: plan.version,
      status: "skipped-no-binaries",
      warning,
      uploadedAssets: [],
      existingAssets: 0,
      expectedAssets: 0
    };
  }

  try {
    const release = await ensureRelease(options.repo, plan, options.dryRun);
    const missingAssets = diffMissingAssets(plan.expectedAssets, release.assets.map((asset) => asset.name));

    if (missingAssets.length === 0) {
      log("info", `${plan.version} already has all ${plan.expectedAssets.length} expected assets`);
      return {
        version: plan.version,
        status: "already-complete",
        releaseUrl: release.url,
        uploadedAssets: [],
        existingAssets: release.assets.length,
        expectedAssets: plan.expectedAssets.length
      };
    }

    log("info", `${plan.version} is missing ${missingAssets.length} asset(s)`);

    if (options.dryRun) {
      for (const asset of missingAssets) {
        log("info", `[dry-run] Would upload ${asset.assetName} to ${plan.tag}`);
      }

      return {
        version: plan.version,
        status: "would-update",
        releaseUrl: release.url,
        uploadedAssets: missingAssets.map((asset) => asset.assetName),
        existingAssets: release.assets.length,
        expectedAssets: plan.expectedAssets.length
      };
    }

    await mkdir(options.tempDir, { recursive: true });
    const tempDir = await mkdtemp(path.join(options.tempDir, `${plan.version}-`));
    try {
      const downloads = await downloadMissingAssets(missingAssets, tempDir, downloadLimit);
      await ghReleaseUpload(options.repo, plan.tag, downloads);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }

    const updatedRelease = await ghReleaseView(options.repo, plan.tag);
    return {
      version: plan.version,
      status: "updated",
      releaseUrl: updatedRelease.url,
      uploadedAssets: missingAssets.map((asset) => asset.assetName),
      existingAssets: updatedRelease.assets.length,
      expectedAssets: plan.expectedAssets.length
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log("error", `${plan.version} failed: ${message}`);
    return {
      version: plan.version,
      status: "failed",
      uploadedAssets: [],
      existingAssets: 0,
      expectedAssets: plan.expectedAssets.length,
      error: message
    };
  }
}

async function ensureRelease(repo: string, plan: VersionSyncPlan, dryRun: boolean): Promise<ReleaseView> {
  const body = buildReleaseBody(plan.version);

  try {
    if (dryRun) {
      const existing = await ghReleaseViewIfExists(repo, plan.tag);
      if (existing) {
        return existing;
      }

      return {
        url: `https://github.com/${repo}/releases/tag/${plan.tag}`,
        assets: []
      };
    }

    const existing = await ghReleaseViewIfExists(repo, plan.tag);
    if (existing) {
      await gh(["release", "edit", plan.tag, "--repo", repo, "--title", plan.releaseTitle, "--notes", body]);
      return await ghReleaseView(repo, plan.tag);
    }

    await gh(["release", "create", plan.tag, "--repo", repo, "--title", plan.releaseTitle, "--notes", body]);
    return await ghReleaseView(repo, plan.tag);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to ensure release ${plan.tag}: ${message}`);
  }
}

async function ghReleaseViewIfExists(repo: string, tag: string): Promise<ReleaseView | null> {
  try {
    return await ghReleaseView(repo, tag);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/release not found|http 404|not found/i.test(message)) {
      return null;
    }
    throw error;
  }
}

async function ghReleaseView(repo: string, tag: string): Promise<ReleaseView> {
  const raw = await gh(["release", "view", tag, "--repo", repo, "--json", "assets,url"]);
  const parsed = JSON.parse(raw) as { assets?: Array<{ name?: string }>; url?: string };
  return {
    url: parsed.url ?? `https://github.com/${repo}/releases/tag/${tag}`,
    assets: Array.isArray(parsed.assets)
      ? parsed.assets.filter((asset): asset is { name: string } => typeof asset?.name === "string")
      : []
  };
}

async function ghReleaseUpload(repo: string, tag: string, files: string[]): Promise<void> {
  if (files.length === 0) {
    return;
  }

  log("info", `Uploading ${files.length} asset(s) to ${tag}`);
  await gh(["release", "upload", tag, "--repo", repo, ...files]);
}

async function downloadMissingAssets(
  binaries: MatchedBinary[],
  tempDir: string,
  downloadLimit: ReturnType<typeof pLimit>
): Promise<string[]> {
  await mkdir(tempDir, { recursive: true });
  return await Promise.all(binaries.map((binary) => downloadLimit(() => downloadBinary(binary, tempDir))));
}

async function downloadBinary(binary: MatchedBinary, tempDir: string): Promise<string> {
  const targetPath = path.join(tempDir, binary.assetName);
  const sourceUrl = `${STATIC_PHP_BASE_URL}/${binary.sourcePath.replace(/^\/+/, "")}`;

  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      log("info", `Downloading ${binary.assetName} from ${sourceUrl} (attempt ${attempt}/4)`);
      const response = await fetch(sourceUrl);

      if (!response.ok) {
        const message = `HTTP ${response.status} ${response.statusText}`;
        if (attempt < 4 && isRetryableDownloadStatus(response.status)) {
          const delayMs = calculateRetryDelayMs(attempt);
          log("warn", `${binary.assetName} download failed with ${message}; retrying in ${delayMs}ms`);
          await Bun.sleep(delayMs);
          continue;
        }
        throw new Error(message);
      }

      await Bun.write(targetPath, response);
      const fileStat = await stat(targetPath);
      if (fileStat.size < MIN_BINARY_BYTES) {
        throw new Error(`Downloaded file is only ${(fileStat.size / 1024 / 1024).toFixed(1)}MB`);
      }

      return targetPath;
    } catch (error) {
      await rm(targetPath, { force: true }).catch(() => undefined);
      if (attempt < 4 && isRetryableError(error)) {
        const delayMs = calculateRetryDelayMs(attempt);
        const message = error instanceof Error ? error.message : String(error);
        log("warn", `${binary.assetName} transient error: ${message}; retrying in ${delayMs}ms`);
        await Bun.sleep(delayMs);
        continue;
      }

      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to download ${binary.assetName}: ${message}`);
    }
  }

  throw new Error(`Unreachable retry state for ${binary.assetName}`);
}

function isRetryableError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const maybeError = error as { name?: unknown; code?: unknown; message?: unknown };
  if (typeof maybeError.name === "string" && maybeError.name === "AbortError") {
    return true;
  }

  if (typeof maybeError.code === "string") {
    return true;
  }

  return typeof maybeError.message === "string" && /timed?out|reset|socket|network/i.test(maybeError.message);
}

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: {
      "user-agent": "php-binaries-sync"
    }
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
  }

  return await response.json();
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: {
      "user-agent": "php-binaries-sync"
    }
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
  }

  return await response.text();
}

function getObjectString(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  return typeof value === "string" ? value : "";
}

async function gh(args: string[]): Promise<string> {
  const command = Bun.spawn(["gh", ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: process.env
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(command.stdout).text(),
    new Response(command.stderr).text(),
    command.exited
  ]);

  if (exitCode !== 0) {
    throw new Error(stderr.trim() || stdout.trim() || `gh exited with code ${exitCode}`);
  }

  return stdout.trim();
}

function log(level: "info" | "warn" | "error", message: string): void {
  const prefix = `[${level.toUpperCase()}]`;
  if (level === "error") {
    console.error(`${prefix} ${message}`);
    return;
  }

  console.log(`${prefix} ${message}`);
}

function printTerminalSummary(summary: SummaryBuilder, title: string): void {
  const border = "=".repeat(72);
  console.log(border);
  console.log(title);
  console.log(border);
  console.log(summary.toString().trimEnd());
  console.log(border);
}

main().catch(async (error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[ERROR] ${message}`);

  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) {
    await appendFile(summaryPath, `\n## Fatal Error\n\n- ${message}\n`);
  }

  process.exit(1);
});
