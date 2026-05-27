import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

// Ensure the working directory is strictly the project root
process.chdir(rootDir);

console.log(`Building frontend project strictly in: ${rootDir}`);

const env = { ...process.env };
const localBin = path.join(rootDir, "node_modules", ".bin");
if (process.platform === "win32") {
  env.Path = `${localBin};${env.Path || ""}`;
} else {
  env.PATH = `${localBin}:${env.PATH || ""}`;
}

console.log("> tsc");
const tscBin = path.join(rootDir, "node_modules", "typescript", "bin", "tsc");
const tscResult = spawnSync(process.execPath, [tscBin], {
  cwd: rootDir,
  env,
  stdio: "inherit",
});

if (tscResult.status !== 0) {
  console.error(`TypeScript compilation failed with exit code ${tscResult.status}.`);
  process.exit(tscResult.status ?? 1);
}

console.log("> vite build");
const viteBin = path.join(rootDir, "node_modules", "vite", "bin", "vite.js");
const viteResult = spawnSync(process.execPath, [viteBin, "build"], {
  cwd: rootDir,
  env,
  stdio: "inherit",
});

if (viteResult.status !== 0) {
  console.error(`Vite build failed with exit code ${viteResult.status}.`);
  process.exit(viteResult.status ?? 1);
}

console.log("Frontend build completed successfully!");
