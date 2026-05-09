export type PhpVersion = {
  major: number;
  minor: number;
  patch: number;
};

export type SourceFile = {
  name: string;
  full_path: string;
};

export type MatchedBinary = {
  version: string;
  sourceName: string;
  sourcePath: string;
  arch: string;
  extension: "tar.gz" | "zip";
  assetName: string;
};

export type VersionSyncPlan = {
  version: string;
  tag: string;
  releaseTitle: string;
  expectedAssets: MatchedBinary[];
};

const SOURCE_BINARY_PATTERN = /^php-(8\.\d+\.\d+)-cli-(.+)\.(tar\.gz|zip)$/;
const CHANGELOG_VERSION_PATTERN = /Version\s+(8\.\d+\.\d+)/g;
const SOURCE_TARBALL_PATTERN = /^php-(8\.\d+\.\d+)\.tar\.(?:gz|bz2|xz)$/;

export function parseVersion(version: string): PhpVersion {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) {
    throw new Error(`Invalid PHP version '${version}'. Expected X.Y.Z.`);
  }

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3])
  };
}

export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a);
  const right = parseVersion(b);

  if (left.major !== right.major) return left.major - right.major;
  if (left.minor !== right.minor) return left.minor - right.minor;
  return left.patch - right.patch;
}

export function buildReleaseBody(version: string): string {
  return [
    `# PHP v${version}`,
    "",
    `Official release: [PHP ${version}](https://www.php.net/releases/index.php?json&version=${version.slice(0, version.lastIndexOf("."))})`,
    `Changelog: [What's changed in v${version}?](https://www.php.net/ChangeLog-8.php#${version})`,
    "",
    "Mirrored CLI binaries sourced from:",
    "- https://dl.static-php.dev/static-php-cli/bulk/",
    "- https://dl.static-php.dev/static-php-cli/windows/spc-max/"
  ].join("\n");
}

export function calculateRetryDelayMs(attempt: number, baseDelayMs = 1_000, maxDelayMs = 10_000): number {
  const exponential = baseDelayMs * 2 ** Math.max(0, attempt - 1);
  return Math.min(maxDelayMs, exponential);
}

export function isRetryableDownloadStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

export function extractVersionFromSourceTarball(filename: string): string | null {
  return filename.match(SOURCE_TARBALL_PATTERN)?.[1] ?? null;
}

export function extractVersionsFromChangelog(input: string): string[] {
  const versions = new Set<string>();
  for (const match of input.matchAll(CHANGELOG_VERSION_PATTERN)) {
    versions.add(match[1]);
  }
  return [...versions].sort(compareVersions);
}

export function selectVersionsForMinor(latestVersion: string, officialVersions: string[], maxPreviousPatches: number): string[] {
  const latest = parseVersion(latestVersion);
  const minPatch = Math.max(0, latest.patch - maxPreviousPatches);

  return officialVersions
    .filter((version) => {
      const parsed = parseVersion(version);
      return parsed.major === latest.major && parsed.minor === latest.minor && parsed.patch >= minPatch && parsed.patch <= latest.patch;
    })
    .sort(compareVersions);
}

export function parseSourceBinaryName(name: string, fullPath: string): MatchedBinary | null {
  const match = name.match(SOURCE_BINARY_PATTERN);
  if (!match) {
    return null;
  }

  const version = match[1];
  const arch = match[2];
  const extension = match[3] as "tar.gz" | "zip";

  return {
    version,
    sourceName: name,
    sourcePath: fullPath,
    arch,
    extension,
    assetName: `php-${version}-${arch}.${extension}`
  };
}

export function indexBinariesByVersion(files: SourceFile[]): Map<string, MatchedBinary[]> {
  const grouped = new Map<string, MatchedBinary[]>();

  for (const file of files) {
    const parsed = parseSourceBinaryName(file.name, file.full_path);
    if (!parsed) {
      continue;
    }

    const existing = grouped.get(parsed.version) ?? [];
    if (!existing.some((binary) => binary.assetName === parsed.assetName)) {
      existing.push(parsed);
    }
    grouped.set(parsed.version, existing);
  }

  for (const binaries of grouped.values()) {
    binaries.sort((a, b) => a.assetName.localeCompare(b.assetName));
  }

  return grouped;
}

export function diffMissingAssets(expected: MatchedBinary[], existingAssetNames: string[]): MatchedBinary[] {
  const existing = new Set(existingAssetNames);
  return expected.filter((binary) => !existing.has(binary.assetName));
}

export function buildVersionPlan(version: string, expectedAssets: MatchedBinary[]): VersionSyncPlan {
  return {
    version,
    tag: `v${version}`,
    releaseTitle: `PHP v${version}`,
    expectedAssets: [...expectedAssets].sort((a, b) => a.assetName.localeCompare(b.assetName))
  };
}
