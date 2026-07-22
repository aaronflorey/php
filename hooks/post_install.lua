function PLUGIN:PostInstall(ctx)
	local file = require("file")
	local sdk = ctx.sdkInfo and ctx.sdkInfo.php or nil
	local install_path = sdk and sdk.path or ctx.rootPath
	local binary_name = RUNTIME.osType:lower() == "windows" and "php.exe" or "php"
	local binary_path = file.join_path(install_path, binary_name)

	if not file.exists(binary_path) then
		error("The PHP release archive did not contain " .. binary_name .. " at its root")
	end

	if RUNTIME.osType:lower() ~= "windows" then
		local cmd = require("cmd")
		cmd.exec("chmod +x php", { cwd = install_path })
	end
end
