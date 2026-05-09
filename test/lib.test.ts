import { describe, expect, it } from "bun:test";
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
  parseSourceBinaryName,
  parseVersion,
  selectVersionsForMinor,
  type SourceFile
} from "../src/lib";

describe("parseVersion", () => {
  it("parses numeric semver versions", () => {
    expect(parseVersion("8.4.21")).toEqual({ major: 8, minor: 4, patch: 21 });
  });

  it("rejects invalid versions", () => {
    expect(() => parseVersion("8.4")).toThrow("Invalid PHP version");
  });
});

describe("compareVersions", () => {
  it("sorts versions numerically", () => {
    expect(["8.4.9", "8.4.21", "8.4.10"].sort(compareVersions)).toEqual(["8.4.9", "8.4.10", "8.4.21"]);
  });
});

describe("extractVersionsFromChangelog", () => {
  it("extracts unique PHP 8 versions from changelog headings", () => {
    const changelog = `
      <h3>Version 8.4.21</h3>
      <h3>Version 8.4.20</h3>
      <h3>Version 8.5.6</h3>
      <h3>Version 8.4.21</h3>
    `;

    expect(extractVersionsFromChangelog(changelog)).toEqual(["8.4.20", "8.4.21", "8.5.6"]);
  });
});

describe("selectVersionsForMinor", () => {
  it("returns only official versions within latest-10 patch window", () => {
    const official = [
      "8.4.9",
      "8.4.10",
      "8.4.11",
      "8.4.12",
      "8.4.13",
      "8.4.14",
      "8.4.15",
      "8.4.16",
      "8.4.17",
      "8.4.18",
      "8.4.19",
      "8.4.20",
      "8.4.21"
    ];

    expect(selectVersionsForMinor("8.4.21", official, 10)).toEqual([
      "8.4.11",
      "8.4.12",
      "8.4.13",
      "8.4.14",
      "8.4.15",
      "8.4.16",
      "8.4.17",
      "8.4.18",
      "8.4.19",
      "8.4.20",
      "8.4.21"
    ]);
  });

  it("does not invent missing official patch releases", () => {
    const official = ["8.3.20", "8.3.22", "8.3.24", "8.3.30", "8.3.31"];
    expect(selectVersionsForMinor("8.3.31", official, 10)).toEqual(["8.3.22", "8.3.24", "8.3.30", "8.3.31"]);
  });
});

describe("parseSourceBinaryName", () => {
  it("normalizes SPC filenames into release asset names", () => {
    expect(parseSourceBinaryName("php-8.4.20-cli-linux-x86_64.tar.gz", "/bulk/php-8.4.20-cli-linux-x86_64.tar.gz")).toEqual({
      version: "8.4.20",
      sourceName: "php-8.4.20-cli-linux-x86_64.tar.gz",
      sourcePath: "/bulk/php-8.4.20-cli-linux-x86_64.tar.gz",
      arch: "linux-x86_64",
      extension: "tar.gz",
      assetName: "php-8.4.20-linux-x86_64.tar.gz"
    });
  });

  it("ignores non-cli assets", () => {
    expect(parseSourceBinaryName("php-8.4.20-fpm-linux-x86_64.tar.gz", "/bulk/php-8.4.20-fpm-linux-x86_64.tar.gz")).toBeNull();
  });
});

describe("indexBinariesByVersion", () => {
  it("groups CLI binaries by version and dedupes asset names", () => {
    const files: SourceFile[] = [
      { name: "php-8.4.20-cli-linux-x86_64.tar.gz", full_path: "/bulk/php-8.4.20-cli-linux-x86_64.tar.gz" },
      { name: "php-8.4.20-cli-win.zip", full_path: "/windows/php-8.4.20-cli-win.zip" },
      { name: "php-8.4.20-cli-win.zip", full_path: "/windows/php-8.4.20-cli-win.zip" }
    ];

    const grouped = indexBinariesByVersion(files);
    expect(grouped.get("8.4.20")?.map((binary) => binary.assetName)).toEqual([
      "php-8.4.20-linux-x86_64.tar.gz",
      "php-8.4.20-win.zip"
    ]);
  });
});

describe("diffMissingAssets", () => {
  it("returns only assets missing from the release", () => {
    const expected = indexBinariesByVersion([
      { name: "php-8.4.20-cli-linux-x86_64.tar.gz", full_path: "/bulk/php-8.4.20-cli-linux-x86_64.tar.gz" },
      { name: "php-8.4.20-cli-win.zip", full_path: "/windows/php-8.4.20-cli-win.zip" }
    ]).get("8.4.20") ?? [];

    const missing = diffMissingAssets(expected, ["php-8.4.20-win.zip"]);
    expect(missing.map((asset) => asset.assetName)).toEqual(["php-8.4.20-linux-x86_64.tar.gz"]);
  });
});

describe("buildVersionPlan", () => {
  it("produces release metadata from expected assets", () => {
    const assets = indexBinariesByVersion([
      { name: "php-8.0.30-cli-win.zip", full_path: "/windows/php-8.0.30-cli-win.zip" }
    ]).get("8.0.30") ?? [];

    expect(buildVersionPlan("8.0.30", assets)).toEqual({
      version: "8.0.30",
      tag: "v8.0.30",
      releaseTitle: "PHP v8.0.30",
      expectedAssets: [
        {
          version: "8.0.30",
          sourceName: "php-8.0.30-cli-win.zip",
          sourcePath: "/windows/php-8.0.30-cli-win.zip",
          arch: "win",
          extension: "zip",
          assetName: "php-8.0.30-win.zip"
        }
      ]
    });
  });
});

describe("buildReleaseBody", () => {
  it("includes changelog and source references", () => {
    const body = buildReleaseBody("8.4.21");
    expect(body).toContain("ChangeLog-8.php#8.4.21");
    expect(body).toContain("static-php-cli/bulk");
    expect(body).toContain("static-php-cli/windows/spc-max");
  });
});

describe("extractVersionFromSourceTarball", () => {
  it("extracts PHP versions from official source filenames", () => {
    expect(extractVersionFromSourceTarball("php-8.4.21.tar.gz")).toBe("8.4.21");
    expect(extractVersionFromSourceTarball("php-8.4.21.zip")).toBeNull();
  });
});

describe("isRetryableDownloadStatus", () => {
  it("recognizes transient HTTP failures", () => {
    expect(isRetryableDownloadStatus(408)).toBe(true);
    expect(isRetryableDownloadStatus(429)).toBe(true);
    expect(isRetryableDownloadStatus(503)).toBe(true);
    expect(isRetryableDownloadStatus(404)).toBe(false);
  });
});

describe("calculateRetryDelayMs", () => {
  it("uses capped exponential backoff", () => {
    expect(calculateRetryDelayMs(1)).toBe(1000);
    expect(calculateRetryDelayMs(2)).toBe(2000);
    expect(calculateRetryDelayMs(3)).toBe(4000);
    expect(calculateRetryDelayMs(5)).toBe(10000);
  });
});
