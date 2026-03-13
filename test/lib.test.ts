import { describe, expect, it } from "bun:test";
import { buildReleaseBody, isFullSemver, parseBinaryName, resolveVersion, selectBinaries, selectRecentVersions } from "../src/lib";

describe("parseBinaryName", () => {
  it("parses tar.gz binaries", () => {
    expect(parseBinaryName("php-8.1.33-cli-linux-x86_64.tar.gz", "8.1.33")).toEqual({
      sourceName: "php-8.1.33-cli-linux-x86_64.tar.gz",
      arch: "linux-x86_64",
      extension: "tar.gz",
      releaseName: "php-8.1.33-linux-x86_64.tar.gz"
    });
  });

  it("parses zip binaries", () => {
    expect(parseBinaryName("php-8.1.33-cli-windows-x64.zip", "8.1.33")).toEqual({
      sourceName: "php-8.1.33-cli-windows-x64.zip",
      arch: "windows-x64",
      extension: "zip",
      releaseName: "php-8.1.33-windows-x64.zip"
    });
  });

  it("ignores unrelated names", () => {
    expect(parseBinaryName("php-8.2.0-fpm-linux-x86_64.tar.gz", "8.2.0")).toBeNull();
  });
});

describe("selectBinaries", () => {
  it("filters and maps matching files", () => {
    const items = selectBinaries(
      [
        { name: "php-8.3.10-cli-linux-aarch64.tar.gz", full_path: "static-php-cli/bulk/php-8.3.10-cli-linux-aarch64.tar.gz" },
        { name: "php-8.3.10-cli-windows-x64.zip", full_path: "static-php-cli/windows/spc-max/php-8.3.10-cli-windows-x64.zip" },
        { name: "php-8.3.10-fpm-linux-aarch64.tar.gz", full_path: "static-php-cli/bulk/php-8.3.10-fpm-linux-aarch64.tar.gz" }
      ],
      "8.3.10"
    );

    expect(items.map((item) => item.releaseName).sort()).toEqual([
      "php-8.3.10-linux-aarch64.tar.gz",
      "php-8.3.10-windows-x64.zip"
    ]);
  });
});

describe("buildReleaseBody", () => {
  it("contains changelog URL and sources", () => {
    const body = buildReleaseBody("8.4.1");
    expect(body).toContain("ChangeLog-8.php#8.4.1");
    expect(body).toContain("https://dl.static-php.dev/static-php-cli/bulk/");
    expect(body).toContain("https://dl.static-php.dev/static-php-cli/windows/spc-max/");
  });
});

describe("selectRecentVersions", () => {
  it("returns sorted unique versions modified within the window", () => {
    const now = Date.parse("2026-03-13T00:00:00Z");
    const entries = [
      {
        name: "php-8.3.21-cli-linux-x86_64.tar.gz",
        is_dir: false,
        last_modified: "2026-03-12 01:00:00"
      },
      {
        name: "php-8.3.21-cli-linux-aarch64.tar.gz",
        is_dir: false,
        last_modified: "2026-03-12 02:00:00"
      },
      {
        name: "php-8.2.29-cli-linux-x86_64.tar.gz",
        is_dir: false,
        last_modified: "2026-03-09 01:00:00"
      },
      {
        name: "php-8.4.0-fpm-linux-x86_64.tar.gz",
        is_dir: false,
        last_modified: "2026-03-12 01:00:00"
      }
    ];

    expect(selectRecentVersions(entries, 2, now)).toEqual(["8.3.21"]);
  });
});

describe("isFullSemver", () => {
  it("accepts X.Y.Z", () => {
    expect(isFullSemver("8.1.33")).toBe(true);
    expect(isFullSemver("10.0.0")).toBe(true);
  });

  it("rejects partial versions", () => {
    expect(isFullSemver("8")).toBe(false);
    expect(isFullSemver("8.4")).toBe(false);
    expect(isFullSemver("")).toBe(false);
  });
});

describe("resolveVersion", () => {
  const versions = ["8.1.30", "8.1.33", "8.2.28", "8.3.10", "8.3.9", "8.4.1"];

  it("resolves major-only prefix to latest", () => {
    expect(resolveVersion("8", versions)).toBe("8.4.1");
  });

  it("resolves major.minor prefix to latest patch", () => {
    expect(resolveVersion("8.1", versions)).toBe("8.1.33");
    expect(resolveVersion("8.3", versions)).toBe("8.3.10");
  });

  it("resolves exact full version", () => {
    expect(resolveVersion("8.2.28", versions)).toBe("8.2.28");
  });

  it("returns null when nothing matches", () => {
    expect(resolveVersion("9", versions)).toBeNull();
    expect(resolveVersion("8.5", versions)).toBeNull();
  });
});
