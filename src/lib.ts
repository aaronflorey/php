export type SourceFile = {
  name: string;
  full_path: string;
};

export type IndexEntry = {
  name: string;
  last_modified?: string;
  is_dir?: boolean;
};

export type MatchedBinary = {
  sourceName: string;
  sourcePath: string;
  arch: string;
  extension: "tar.gz" | "zip";
  releaseName: string;
};

export function buildReleaseBody(version: string): string {
  const major = version.split(".")[0] ?? version;
  return [
    `# PHP v${version}`,
    "",
    `Changelog: [What's changed in v${version}?](https://www.php.net/ChangeLog-${major}.php#${version})`,
    "",
    "Sources:",
    "  * https://dl.static-php.dev/static-php-cli/bulk/",
    "  * https://dl.static-php.dev/static-php-cli/windows/spc-max/"
  ].join("\n");
}

export function parseBinaryName(name: string, version: string, compiled?: RegExp): Omit<MatchedBinary, "sourcePath"> | null {
  const pattern = compiled ?? buildBinaryPattern(version);
  const match = name.match(pattern);
  if (!match) {
    return null;
  }

  const arch = match[1];
  const extension = match[2] as "tar.gz" | "zip";
  return {
    sourceName: name,
    arch,
    extension,
    releaseName: `php-${version}-${arch}.${extension}`
  };
}

export function buildBinaryPattern(version: string): RegExp {
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^php-${escaped}-cli-(.+)\\.(tar\\.gz|zip)$`);
}

export function selectBinaries(files: SourceFile[], version: string): MatchedBinary[] {
  const pattern = buildBinaryPattern(version);
  const out: MatchedBinary[] = [];
  const seenPath = new Set<string>();

  for (const file of files) {
    if (!file.full_path || seenPath.has(file.full_path)) {
      continue;
    }
    seenPath.add(file.full_path);

    const parsed = parseBinaryName(file.name, version, pattern);
    if (!parsed) {
      continue;
    }

    out.push({
      ...parsed,
      sourcePath: file.full_path
    });
  }

  return out;
}

export function selectRecentVersions(entries: IndexEntry[], sinceDays: number, nowMs = Date.now()): string[] {
  const cutoffMs = nowMs - sinceDays * 24 * 60 * 60 * 1000;
  const out = new Set<string>();

  for (const entry of entries) {
    if (entry.is_dir !== false) {
      continue;
    }

    const version = extractVersionFromTarballName(entry.name);
    if (!version || !entry.last_modified) {
      continue;
    }

    const modifiedMs = parseTimestampToUtcMs(entry.last_modified);
    if (modifiedMs === null) {
      continue;
    }

    if (modifiedMs > cutoffMs) {
      out.add(version);
    }
  }

  return [...out].sort();
}

export function extractVersionFromTarballName(name: string): string | null {
  const match = name.match(/^php-([0-9]+\.[0-9]+\.[0-9]+)-cli-.+\.tar\.gz$/);
  return match?.[1] ?? null;
}

export function isFullSemver(version: string): boolean {
  return /^[0-9]+\.[0-9]+\.[0-9]+$/.test(version);
}

export function resolveVersion(partial: string, available: string[]): string | null {
  const prefix = partial.endsWith(".") ? partial : `${partial}.`;
  const matches = available.filter((v) => v === partial || v.startsWith(prefix));
  if (matches.length === 0) {
    return null;
  }
  return matches.sort(compareSemver).at(-1) ?? null;
}

function compareSemver(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function parseTimestampToUtcMs(value: string): number | null {
  const normalized = value.replace(" ", "T");
  const date = new Date(`${normalized}Z`);
  const time = date.getTime();
  return Number.isNaN(time) ? null : time;
}
