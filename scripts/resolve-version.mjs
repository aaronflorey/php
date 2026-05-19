import { readFileSync, appendFileSync } from "node:fs";
import path from "node:path";

const manifestPath = path.join(process.env.GITHUB_ACTION_PATH ?? process.cwd(), "versions.json");
const requestedVersion = (process.env.INPUT_PHP_VERSION ?? "latest").trim() || "latest";
const runnerOs = process.env.RUNNER_OS ?? "";
const runnerArch = process.env.RUNNER_ARCH ?? "";
const outputPath = process.env.GITHUB_OUTPUT;

const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const platformKey = getPlatformKey(runnerOs, runnerArch);
const resolvedVersion = requestedVersion === "latest"
  ? manifest.latest?.stable
  : manifest.latest?.[requestedVersion] ?? requestedVersion;

if (!resolvedVersion || !manifest.versions?.[resolvedVersion]) {
  throw new Error(`PHP version '${requestedVersion}' is not available in ${manifestPath}.`);
}

const asset = manifest.versions[resolvedVersion].assets?.[platformKey];
if (!asset) {
  throw new Error(`PHP ${resolvedVersion} is not available for ${platformKey}.`);
}

writeOutput("php-version", resolvedVersion);
writeOutput("platform-key", platformKey);
writeOutput("download-url", asset.url);
writeOutput("archive-extension", asset.extension);
writeOutput("file-name", asset.fileName);
writeOutput("binary-name", runnerOs === "Windows" ? "php.exe" : "php");

function getPlatformKey(os, arch) {
  const normalizedOs = os === "macOS"
    ? "macos"
    : os === "Linux"
      ? "linux"
      : os === "Windows"
        ? "win"
        : "";

  const normalizedArch = arch === "X64"
    ? "x86_64"
    : arch === "ARM64"
      ? "aarch64"
      : "";

  if (!normalizedOs || !normalizedArch) {
    throw new Error(`Unsupported runner platform: os='${os}', arch='${arch}'.`);
  }

  return normalizedOs === "win" ? normalizedOs : `${normalizedOs}-${normalizedArch}`;
}

function writeOutput(name, value) {
  if (!outputPath) {
    throw new Error("GITHUB_OUTPUT is not set.");
  }

  appendFileSync(outputPath, `${name}=${value}\n`);
}
