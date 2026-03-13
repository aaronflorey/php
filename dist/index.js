/******/ (() => { // webpackBootstrap
/******/ 	"use strict";
/******/ 	var __webpack_modules__ = ({

/***/ 407:
/***/ (function(__unused_webpack_module, exports, __nccwpck_require__) {


var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", ({ value: true }));
const node_child_process_1 = __nccwpck_require__(421);
const node_fs_1 = __nccwpck_require__(24);
const node_path_1 = __importDefault(__nccwpck_require__(760));
const node_stream_1 = __nccwpck_require__(75);
const promises_1 = __nccwpck_require__(466);
const node_util_1 = __nccwpck_require__(975);
const lib_1 = __nccwpck_require__(704);
const execFileAsync = (0, node_util_1.promisify)(node_child_process_1.execFile);
const BULK_SOURCE_URL = "https://dl.static-php.dev/static-php-cli/bulk/?format=json";
const RELEASE_SOURCE_URLS = [
    BULK_SOURCE_URL,
    "https://dl.static-php.dev/static-php-cli/windows/spc-max/?format=json"
];
async function main() {
    const options = parseArgs(process.argv.slice(2));
    if (options.command === "discover") {
        const versions = await discoverRecentVersions(options.sinceDays);
        process.stdout.write(JSON.stringify(versions));
        return;
    }
    const version = (0, lib_1.isFullSemver)(options.version)
        ? options.version
        : await resolvePartialVersion(options.version);
    console.log(`Resolved version: ${version}`);
    const binaries = await fetchMatchingBinaries(version);
    if (binaries.length === 0) {
        throw new Error(`No matching binaries found for PHP ${version}.`);
    }
    const downloaded = await downloadBinaries(binaries, options.outDir, options.dryRun, options.maxConcurrentDownloads);
    if (options.dryRun) {
        console.log("Dry-run mode: skipping GitHub release upsert.");
        return;
    }
    const tagName = `${options.tagPrefix}${version}`;
    const releaseName = `PHP v${version}`;
    const body = (0, lib_1.buildReleaseBody)(version);
    const ghRepo = `${options.owner}/${options.repo}`;
    await ghUpsertRelease(ghRepo, tagName, releaseName, body, downloaded);
}
function parseArgs(args) {
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
            maxConcurrentDownloads: parsePositiveNumber(map.get("--max-concurrent-downloads") ?? "3", "--max-concurrent-downloads"),
            dryRun: flags.has("--dry-run")
        };
    }
    throw new Error(`Unsupported command: ${command}. Commands: release, discover.`);
}
function parseFlags(args) {
    const map = new Map();
    const flags = new Set();
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
function mustGet(map, key) {
    const value = map.get(key);
    if (!value) {
        throw new Error(`${key} is required.`);
    }
    return value;
}
function parsePositiveNumber(raw, flagName) {
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) {
        throw new Error(`${flagName} must be a positive number.`);
    }
    return value;
}
async function resolvePartialVersion(partial) {
    console.log(`Resolving partial version '${partial}' from ${BULK_SOURCE_URL}`);
    const json = await fetchJsonIndex(BULK_SOURCE_URL);
    const versions = new Set();
    for (const item of json) {
        if (!item || typeof item !== "object")
            continue;
        const record = item;
        const name = getString(record, "name");
        const version = name ? (0, lib_1.extractVersionFromTarballName)(name) : null;
        if (version)
            versions.add(version);
    }
    const resolved = (0, lib_1.resolveVersion)(partial, [...versions]);
    if (!resolved) {
        throw new Error(`No PHP version found matching '${partial}'.`);
    }
    console.log(`Resolved '${partial}' to '${resolved}'`);
    return resolved;
}
async function fetchJsonIndex(url) {
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
function getString(item, key) {
    const value = item[key];
    return typeof value === "string" ? value : "";
}
async function discoverRecentVersions(sinceDays) {
    const json = await fetchJsonIndex(BULK_SOURCE_URL);
    const entries = [];
    for (const item of json) {
        if (!item || typeof item !== "object") {
            continue;
        }
        const record = item;
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
    return (0, lib_1.selectRecentVersions)(entries, sinceDays);
}
async function fetchMatchingBinaries(version) {
    const results = await Promise.all(RELEASE_SOURCE_URLS.map(async (url) => {
        console.log(`Fetching index: ${url}`);
        const json = await fetchJsonIndex(url);
        const files = [];
        for (const item of json) {
            if (!item || typeof item !== "object") {
                continue;
            }
            const record = item;
            const name = getString(record, "name");
            const fullPath = getString(record, "full_path");
            if (!name || !fullPath) {
                continue;
            }
            files.push({ name, full_path: fullPath });
        }
        return files;
    }));
    const files = results.flat();
    const matches = (0, lib_1.selectBinaries)(files, version);
    const deduped = new Map();
    for (const match of matches) {
        if (deduped.has(match.releaseName)) {
            console.log(`Skipping duplicate target filename '${match.releaseName}' from '${match.sourcePath}'.`);
            continue;
        }
        deduped.set(match.releaseName, match);
    }
    return [...deduped.values()];
}
async function downloadBinaries(binaries, outDir, dryRun, maxConcurrentDownloads) {
    await node_fs_1.promises.mkdir(outDir, { recursive: true });
    const maxAttempts = 4;
    async function downloadOne(binary) {
        const sourceUrl = `https://dl.static-php.dev/${binary.sourcePath.replace(/^\/+/, "")}`;
        const targetPath = node_path_1.default.join(outDir, binary.releaseName);
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
                    if (attempt < maxAttempts && (0, lib_1.isRetryableDownloadStatus)(response.status)) {
                        const delayMs = (0, lib_1.calculateRetryDelayMs)(attempt);
                        console.log(`Transient download failure, retrying in ${delayMs}ms: ${reason}`);
                        await sleep(delayMs);
                        continue;
                    }
                    throw new Error(reason);
                }
                const nodeStream = node_stream_1.Readable.fromWeb(response.body);
                await (0, promises_1.pipeline)(nodeStream, (0, node_fs_1.createWriteStream)(targetPath));
                const stat = await node_fs_1.promises.stat(targetPath);
                const MIN_SIZE = 5 * 1024 * 1024;
                if (stat.size < MIN_SIZE) {
                    throw new Error(`Downloaded file ${binary.releaseName} is only ${(stat.size / 1024 / 1024).toFixed(1)}MB — expected at least 5MB.`);
                }
                console.log(`Saved ${targetPath} (${(stat.size / 1024 / 1024).toFixed(1)}MB)`);
                return targetPath;
            }
            catch (error) {
                await node_fs_1.promises.rm(targetPath, { force: true });
                if (attempt < maxAttempts && isRetryableError(error)) {
                    const delayMs = (0, lib_1.calculateRetryDelayMs)(attempt);
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
    const downloaded = new Array(binaries.length);
    let nextIndex = 0;
    async function worker() {
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
function isRetryableError(error) {
    if (!error || typeof error !== "object") {
        return false;
    }
    const maybeError = error;
    if (typeof maybeError.name === "string" && maybeError.name === "AbortError") {
        return true;
    }
    return typeof maybeError.code === "string";
}
async function sleep(ms) {
    await new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}
async function gh(args) {
    const { stdout } = await execFileAsync("gh", args);
    return stdout.trim();
}
async function ghReleaseExists(repo, tag) {
    try {
        await gh(["release", "view", tag, "--repo", repo]);
        return true;
    }
    catch {
        return false;
    }
}
async function ghUpsertRelease(repo, tag, title, body, files) {
    const exists = await ghReleaseExists(repo, tag);
    if (exists) {
        console.log(`Updating existing release ${tag}`);
        await gh(["release", "edit", tag, "--repo", repo, "--title", title, "--notes", body]);
    }
    else {
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


/***/ }),

/***/ 704:
/***/ ((__unused_webpack_module, exports) => {


Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.isRetryableDownloadStatus = isRetryableDownloadStatus;
exports.calculateRetryDelayMs = calculateRetryDelayMs;
exports.buildReleaseBody = buildReleaseBody;
exports.parseBinaryName = parseBinaryName;
exports.buildBinaryPattern = buildBinaryPattern;
exports.selectBinaries = selectBinaries;
exports.selectRecentVersions = selectRecentVersions;
exports.extractVersionFromTarballName = extractVersionFromTarballName;
exports.isFullSemver = isFullSemver;
exports.resolveVersion = resolveVersion;
function isRetryableDownloadStatus(status) {
    return status === 408 || status === 425 || status === 429 || status >= 500;
}
function calculateRetryDelayMs(attempt, baseDelayMs = 1_000, maxDelayMs = 10_000) {
    const exponential = baseDelayMs * 2 ** Math.max(0, attempt - 1);
    return Math.min(maxDelayMs, exponential);
}
function buildReleaseBody(version) {
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
function parseBinaryName(name, version, compiled) {
    const pattern = compiled ?? buildBinaryPattern(version);
    const match = name.match(pattern);
    if (!match) {
        return null;
    }
    const arch = match[1];
    const extension = match[2];
    return {
        sourceName: name,
        arch,
        extension,
        releaseName: `php-${version}-${arch}.${extension}`
    };
}
function buildBinaryPattern(version) {
    const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`^php-${escaped}-cli-(.+)\\.(tar\\.gz|zip)$`);
}
function selectBinaries(files, version) {
    const pattern = buildBinaryPattern(version);
    const out = [];
    const seenPath = new Set();
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
function selectRecentVersions(entries, sinceDays, nowMs = Date.now()) {
    const cutoffMs = nowMs - sinceDays * 24 * 60 * 60 * 1000;
    const out = new Set();
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
function extractVersionFromTarballName(name) {
    const match = name.match(/^php-([0-9]+\.[0-9]+\.[0-9]+)-cli-.+\.tar\.gz$/);
    return match?.[1] ?? null;
}
function isFullSemver(version) {
    return /^[0-9]+\.[0-9]+\.[0-9]+$/.test(version);
}
function resolveVersion(partial, available) {
    const prefix = partial.endsWith(".") ? partial : `${partial}.`;
    const matches = available.filter((v) => v === partial || v.startsWith(prefix));
    if (matches.length === 0) {
        return null;
    }
    return matches.sort(compareSemver).at(-1) ?? null;
}
function compareSemver(a, b) {
    const pa = a.split(".").map(Number);
    const pb = b.split(".").map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
        if (diff !== 0)
            return diff;
    }
    return 0;
}
function parseTimestampToUtcMs(value) {
    const normalized = value.replace(" ", "T");
    const date = new Date(`${normalized}Z`);
    const time = date.getTime();
    return Number.isNaN(time) ? null : time;
}


/***/ }),

/***/ 421:
/***/ ((module) => {

module.exports = require("node:child_process");

/***/ }),

/***/ 24:
/***/ ((module) => {

module.exports = require("node:fs");

/***/ }),

/***/ 760:
/***/ ((module) => {

module.exports = require("node:path");

/***/ }),

/***/ 75:
/***/ ((module) => {

module.exports = require("node:stream");

/***/ }),

/***/ 466:
/***/ ((module) => {

module.exports = require("node:stream/promises");

/***/ }),

/***/ 975:
/***/ ((module) => {

module.exports = require("node:util");

/***/ })

/******/ 	});
/************************************************************************/
/******/ 	// The module cache
/******/ 	var __webpack_module_cache__ = {};
/******/ 	
/******/ 	// The require function
/******/ 	function __nccwpck_require__(moduleId) {
/******/ 		// Check if module is in cache
/******/ 		var cachedModule = __webpack_module_cache__[moduleId];
/******/ 		if (cachedModule !== undefined) {
/******/ 			return cachedModule.exports;
/******/ 		}
/******/ 		// Create a new module (and put it into the cache)
/******/ 		var module = __webpack_module_cache__[moduleId] = {
/******/ 			// no module.id needed
/******/ 			// no module.loaded needed
/******/ 			exports: {}
/******/ 		};
/******/ 	
/******/ 		// Execute the module function
/******/ 		var threw = true;
/******/ 		try {
/******/ 			__webpack_modules__[moduleId].call(module.exports, module, module.exports, __nccwpck_require__);
/******/ 			threw = false;
/******/ 		} finally {
/******/ 			if(threw) delete __webpack_module_cache__[moduleId];
/******/ 		}
/******/ 	
/******/ 		// Return the exports of the module
/******/ 		return module.exports;
/******/ 	}
/******/ 	
/************************************************************************/
/******/ 	/* webpack/runtime/compat */
/******/ 	
/******/ 	if (typeof __nccwpck_require__ !== 'undefined') __nccwpck_require__.ab = __dirname + "/";
/******/ 	
/************************************************************************/
/******/ 	
/******/ 	// startup
/******/ 	// Load entry module and return exports
/******/ 	// This entry module is referenced by other modules so it can't be inlined
/******/ 	var __webpack_exports__ = __nccwpck_require__(407);
/******/ 	module.exports = __webpack_exports__;
/******/ 	
/******/ })()
;