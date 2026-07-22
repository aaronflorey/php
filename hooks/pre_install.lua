local php_binaries = require("php_binaries")

function PLUGIN:PreInstall(ctx)
	local manifest = php_binaries.fetch_manifest()
	local version, platform, asset = php_binaries.select_asset(manifest, ctx.version, RUNTIME.osType, RUNTIME.archType)

	local install = {
		version = version,
		url = asset.url,
		note = "Installing PHP " .. version .. " for " .. platform,
	}
	local sha256 = php_binaries.asset_sha256(asset)
	if sha256 ~= nil then
		install.sha256 = sha256
	end

	return install
end
