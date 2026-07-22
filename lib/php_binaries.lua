local php_binaries = {}

php_binaries.manifest_url = "https://raw.githubusercontent.com/aaronflorey/php/master/versions.json"

local function parse_version(version)
	local major, minor, patch = version:match("^(%d+)%.(%d+)%.(%d+)$")
	if major == nil then
		return nil
	end

	return tonumber(major), tonumber(minor), tonumber(patch)
end

local function compare_versions(left, right)
	local left_major, left_minor, left_patch = parse_version(left)
	local right_major, right_minor, right_patch = parse_version(right)

	if left_major == nil or right_major == nil then
		return left < right and -1 or left == right and 0 or 1
	end

	if left_major ~= right_major then
		return left_major < right_major and -1 or 1
	end
	if left_minor ~= right_minor then
		return left_minor < right_minor and -1 or 1
	end
	if left_patch ~= right_patch then
		return left_patch < right_patch and -1 or 1
	end

	return 0
end

function php_binaries.fetch_manifest()
	local http = require("http")
	local json = require("json")
	local response, request_error = http.get({
		url = php_binaries.manifest_url,
		headers = {
			["Accept"] = "application/json",
			["User-Agent"] = "mise-php-aaronflorey",
		},
	})

	if request_error ~= nil then
		error("Could not fetch the PHP versions manifest: " .. request_error)
	end
	if response == nil or response.status_code ~= 200 then
		local status = response and response.status_code or "unknown"
		error("Could not fetch the PHP versions manifest (HTTP " .. status .. ")")
	end

	local decoded, manifest = pcall(json.decode, response.body)
	if not decoded then
		error("Could not decode the PHP versions manifest: " .. tostring(manifest))
	end
	if type(manifest) ~= "table" or type(manifest.latest) ~= "table" or type(manifest.versions) ~= "table" then
		error("The PHP versions manifest has an unexpected shape")
	end

	return manifest
end

function php_binaries.available_versions(manifest, platform)
	local available = {}

	for version, entry in pairs(manifest.versions) do
		if parse_version(version) ~= nil and entry.assets[platform] ~= nil then
			table.insert(available, { version = version })
		end
	end

	table.sort(available, function(left, right)
		return compare_versions(left.version, right.version) > 0
	end)

	return available
end

function php_binaries.resolve_version(manifest, requested)
	local normalized = tostring(requested or ""):gsub("^v", "")

	if normalized == "latest" or normalized == "stable" then
		return manifest.latest.stable
	end
	if manifest.latest[normalized] ~= nil then
		return manifest.latest[normalized]
	end
	if manifest.versions[normalized] ~= nil then
		return normalized
	end

	local prefix = normalized .. "."
	local latest_match = nil
	for version, _ in pairs(manifest.versions) do
		if
			version:sub(1, #prefix) == prefix
			and (latest_match == nil or compare_versions(version, latest_match) > 0)
		then
			latest_match = version
		end
	end

	return latest_match
end

function php_binaries.platform_key(os_type, arch_type)
	local normalized_os = tostring(os_type or ""):lower()
	local normalized_arch = tostring(arch_type or ""):lower()

	if normalized_os == "windows" or normalized_os == "win" then
		return "win"
	end

	local os_name = nil
	if normalized_os == "darwin" or normalized_os == "macos" then
		os_name = "macos"
	elseif normalized_os == "linux" then
		os_name = "linux"
	end

	local arch_name = nil
	if normalized_arch == "amd64" or normalized_arch == "x86_64" or normalized_arch == "x64" then
		arch_name = "x86_64"
	elseif normalized_arch == "arm64" or normalized_arch == "aarch64" then
		arch_name = "aarch64"
	end

	if os_name == nil or arch_name == nil then
		error("Unsupported PHP binary platform: os='" .. normalized_os .. "', arch='" .. normalized_arch .. "'")
	end

	return os_name .. "-" .. arch_name
end

function php_binaries.select_asset(manifest, requested, os_type, arch_type)
	local version = php_binaries.resolve_version(manifest, requested)
	if version == nil or manifest.versions[version] == nil then
		error("PHP version '" .. tostring(requested) .. "' is not available in versions.json")
	end

	local platform = php_binaries.platform_key(os_type, arch_type)
	local asset = manifest.versions[version].assets[platform]
	if asset == nil then
		error("PHP " .. version .. " is not available for " .. platform)
	end

	return version, platform, asset
end

function php_binaries.asset_sha256(asset)
	if type(asset.sha256) == "string" and asset.sha256 ~= "" then
		return asset.sha256
	end
	if type(asset.digest) == "string" then
		return asset.digest:match("^sha256:(.+)$")
	end

	return nil
end

return php_binaries
