import path from "path";
import { execSync } from "child_process";
import fs from "fs";
//#region src/install-packages.mts
const pkgs = process.env.PH_PACKAGES?.split(",") || [];
if (pkgs.length === 0 || pkgs.length === 1 && pkgs[0] === "") process.exit(0);
try {
	const packageJsonPath = path.join(process.cwd(), "package.json");
	const packageJsonContent = fs.readFileSync(packageJsonPath, "utf-8");
	const packageJson = JSON.parse(packageJsonContent);
	const installedDependencies = {
		...packageJson.dependencies || {},
		...packageJson.devDependencies || {}
	};
	for (const pkg of pkgs) {
		if (pkg === "") continue;
		if (installedDependencies[pkg]) {
			console.log(`> Package ${pkg} is already installed, skipping`);
			continue;
		}
		console.log(`> Installing ${pkg}`);
		execSync(`pnpm add ${pkg}@latest`, { stdio: "inherit" });
	}
} catch (error) {
	console.error("Error in package installation:", error);
	process.exit(1);
}
//#endregion
export {};

//# sourceMappingURL=install-packages.mjs.map