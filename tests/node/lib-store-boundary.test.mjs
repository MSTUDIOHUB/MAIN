import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

const workspaceRoot = process.cwd();
const libRoot = path.join(workspaceRoot, "src/lib");

async function collectSourceFiles(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return collectSourceFiles(entryPath);
    return /\.(?:ts|tsx)$/.test(entry.name) ? [entryPath] : [];
  }));
  return nested.flat();
}

test("src/lib keeps Zustand ownership behind the e2e bridge exception", async () => {
  const sourceFiles = await collectSourceFiles(libRoot);
  const storeImports = [];

  for (const sourcePath of sourceFiles) {
    const source = await fs.readFile(sourcePath, "utf8");
    if (!/(?:from\s+|import\s*\()["'][^"']*store\/useAppStore["']/.test(source)) continue;
    storeImports.push(path.relative(workspaceRoot, sourcePath));
  }

  assert.deepEqual(storeImports.sort(), ["src/lib/e2e.ts"]);
});
