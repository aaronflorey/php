local php_binaries = dofile("lib/php_binaries.lua")

local manifest = {
	latest = {
		stable = "8.5.5",
		["8.4"] = "8.4.20",
		["8.5"] = "8.5.5",
	},
	versions = {
		["8.4.18"] = {
			assets = {
				["linux-x86_64"] = { url = "https://example.test/php-8.4.18-linux-x86_64.tar.gz" },
			},
		},
		["8.4.20"] = {
			assets = {
				["linux-x86_64"] = { url = "https://example.test/php-8.4.20-linux-x86_64.tar.gz" },
				["macos-aarch64"] = { url = "https://example.test/php-8.4.20-macos-aarch64.tar.gz" },
				win = { url = "https://example.test/php-8.4.20-win.zip" },
			},
		},
		["8.5.5"] = {
			assets = {
				["linux-x86_64"] = { url = "https://example.test/php-8.5.5-linux-x86_64.tar.gz" },
			},
		},
	},
}

local available = php_binaries.available_versions(manifest, "linux-x86_64")
assert(#available == 3)
assert(available[1].version == "8.5.5")
assert(available[2].version == "8.4.20")
assert(available[3].version == "8.4.18")

local macos_available = php_binaries.available_versions(manifest, "macos-aarch64")
assert(#macos_available == 1)
assert(macos_available[1].version == "8.4.20")

assert(php_binaries.resolve_version(manifest, "latest") == "8.5.5")
assert(php_binaries.resolve_version(manifest, "stable") == "8.5.5")
assert(php_binaries.resolve_version(manifest, "8") == "8.5.5")
assert(php_binaries.resolve_version(manifest, "8.4") == "8.4.20")
assert(php_binaries.resolve_version(manifest, "v8.4.18") == "8.4.18")
assert(php_binaries.resolve_version(manifest, "7.4") == nil)

assert(php_binaries.platform_key("Darwin", "arm64") == "macos-aarch64")
assert(php_binaries.platform_key("macos", "amd64") == "macos-x86_64")
assert(php_binaries.platform_key("Linux", "x64") == "linux-x86_64")
assert(php_binaries.platform_key("linux", "aarch64") == "linux-aarch64")
assert(php_binaries.platform_key("Windows", "amd64") == "win")

local version, platform, asset = php_binaries.select_asset(manifest, "8.4", "Darwin", "arm64")
assert(version == "8.4.20")
assert(platform == "macos-aarch64")
assert(asset.url == "https://example.test/php-8.4.20-macos-aarch64.tar.gz")

assert(php_binaries.asset_sha256({ sha256 = "abc123" }) == "abc123")
assert(php_binaries.asset_sha256({ digest = "sha256:def456" }) == "def456")
assert(php_binaries.asset_sha256({}) == nil)

local unsupported = pcall(php_binaries.platform_key, "freebsd", "amd64")
assert(unsupported == false)

print("mise PHP plugin tests passed")
