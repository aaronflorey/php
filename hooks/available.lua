local php_binaries = require("php_binaries")

function PLUGIN:Available(_)
	local manifest = php_binaries.fetch_manifest()
	local platform = php_binaries.platform_key(RUNTIME.osType, RUNTIME.archType)
	return php_binaries.available_versions(manifest, platform)
end
