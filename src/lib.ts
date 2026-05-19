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

export type ReleaseAsset = {
  name: string;
  browserDownloadUrl: string;
};

export type GithubRelease = {
  tagName: string;
  assets: ReleaseAsset[];
};

export type InstallAsset = {
  fileName: string;
  url: string;
  extension: "tar.gz" | "zip";
};

export type VersionManifestEntry = {
  version: string;
  assets: Partial<Record<string, InstallAsset>>;
};

export type VersionsManifest = {
  generatedAt: string;
  repository: string;
  latest: Record<string, string>;
  versions: Record<string, VersionManifestEntry>;
};

const SOURCE_BINARY_PATTERN = /^php-(8\.\d+\.\d+)-cli-(.+)\.(tar\.gz|zip)$/;
const RELEASE_BINARY_PATTERN = /^php-(8\.\d+\.\d+)-(.+)\.(tar\.gz|zip)$/;
const CHANGELOG_VERSION_PATTERN = /Version\s+(8\.\d+\.\d+)/g;
const SOURCE_TARBALL_PATTERN = /^php-(8\.\d+\.\d+)\.tar\.(?:gz|bz2|xz)$/;
const RELEASE_TAG_PATTERN = /^v(8\.\d+\.\d+)$/;

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

export function parseReleaseTag(tagName: string): string | null {
  return tagName.match(RELEASE_TAG_PATTERN)?.[1] ?? null;
}

export function parseReleaseBinaryName(name: string): { version: string; arch: string; extension: "tar.gz" | "zip" } | null {
  const match = name.match(RELEASE_BINARY_PATTERN);
  if (!match) {
    return null;
  }

  return {
    version: match[1],
    arch: match[2],
    extension: match[3] as "tar.gz" | "zip"
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

export function buildVersionsManifest(repository: string, releases: GithubRelease[], generatedAt: string): VersionsManifest {
  const versions = new Map<string, VersionManifestEntry>();

  for (const release of releases) {
    const version = parseReleaseTag(release.tagName);
    if (!version) {
      continue;
    }

    const assets: Partial<Record<string, InstallAsset>> = {};
    for (const asset of release.assets) {
      const parsed = parseReleaseBinaryName(asset.name);
      if (!parsed || parsed.version !== version) {
        continue;
      }

      assets[parsed.arch] = {
        fileName: asset.name,
        url: asset.browserDownloadUrl,
        extension: parsed.extension
      };
    }

    if (Object.keys(assets).length === 0) {
      continue;
    }

    versions.set(version, {
      version,
      assets: sortRecordByKey(assets)
    });
  }

  const sortedVersions = [...versions.keys()].sort(compareVersions);
  const latest: Record<string, string> = {};

  if (sortedVersions.length > 0) {
    latest.stable = sortedVersions[sortedVersions.length - 1];
  }

  for (const version of sortedVersions) {
    const parsed = parseVersion(version);
    latest[`${parsed.major}.${parsed.minor}`] = version;
  }

  return {
    generatedAt,
    repository,
    latest: sortLatestAliases(latest),
    versions: Object.fromEntries(sortedVersions.map((version) => [version, versions.get(version)!]))
  };
}

export function resolveManifestVersion(manifest: VersionsManifest, requestedVersion: string): VersionManifestEntry {
  const normalized = requestedVersion.trim();
  const resolvedVersion = normalized === "latest"
    ? manifest.latest.stable
    : manifest.latest[normalized] ?? normalized;

  if (!resolvedVersion) {
    throw new Error("Manifest does not define a stable PHP version.");
  }

  const match = manifest.versions[resolvedVersion];
  if (!match) {
    throw new Error(`PHP version '${requestedVersion}' is not available in versions.json.`);
  }

  return match;
}

function sortRecordByKey<T>(input: Partial<Record<string, T>>): Partial<Record<string, T>> {
  return Object.fromEntries(Object.entries(input).sort((a, b) => a[0].localeCompare(b[0])));
}

function sortLatestAliases(latest: Record<string, string>): Record<string, string> {
  const stable = latest.stable;
  const aliases = Object.entries(latest)
    .filter(([key]) => key !== "stable")
    .sort((a, b) => {
      const left = a[0].split(".").map(Number);
      const right = b[0].split(".").map(Number);
      if (left[0] !== right[0]) return left[0] - right[0];
      return left[1] - right[1];
    });

  return {
    ...(stable ? { stable } : {}),
    ...Object.fromEntries(aliases)
  };
}
