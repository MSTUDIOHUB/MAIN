import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";

const workspaceRoot = process.cwd();
const cache = new Map();

function loadTs(sourcePath) {
  const normalizedPath = path.resolve(sourcePath);
  if (cache.has(normalizedPath)) return cache.get(normalizedPath);
  const source = fs.readFileSync(normalizedPath, "utf8");
  const transpiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    fileName: normalizedPath,
  }).outputText;
  const module = { exports: {} };
  cache.set(normalizedPath, module.exports);
  const localRequire = createRequire(normalizedPath);
  const runtimeRequire = (specifier) => {
    if (specifier.startsWith(".")) {
      const basePath = path.resolve(path.dirname(normalizedPath), specifier);
      for (const candidate of [basePath, `${basePath}.ts`, path.join(basePath, "index.ts")]) {
        if (fs.existsSync(candidate) && candidate.endsWith(".ts")) return loadTs(candidate);
      }
    }
    return localRequire(specifier);
  };
  new Function("exports", "module", "require", transpiled)(module.exports, module, runtimeRequire);
  cache.set(normalizedPath, module.exports);
  return module.exports;
}

const { syncPlanArtifactAfterToolSuccess } = loadTs(
  path.join(workspaceRoot, "src/lib/planArtifactSync.ts"),
);

test("write_file sync uses the accepted content without a redundant disk read", async () => {
  let reads = 0;
  const updates = [];

  await syncPlanArtifactAfterToolSuccess(
    "write_file",
    { path: ".MAIN/plans/plan.md", content: "# Exact plan" },
    {
      onPlanArtifactUpdated: (...args) => updates.push(args),
      onPlanTasksUpdated: () => {},
    },
    {
      readFile: async () => {
        reads += 1;
        return "unexpected";
      },
    },
  );

  assert.equal(reads, 0);
  assert.deepEqual(updates, [[".MAIN/plans/plan.md", "# Exact plan", "plan"]]);
});

test("replace_in_file sync reads the resulting artifact once", async () => {
  let reads = 0;
  const updates = [];

  await syncPlanArtifactAfterToolSuccess(
    "replace_in_file",
    { path: ".MAIN/plans/plan.md", search_text: "old", replace_text: "new" },
    {
      onPlanArtifactUpdated: (...args) => updates.push(args),
      onPlanTasksUpdated: () => {},
    },
    {
      readFile: async () => {
        reads += 1;
        return "# Updated plan";
      },
    },
  );

  assert.equal(reads, 1);
  assert.deepEqual(updates, [[".MAIN/plans/plan.md", "# Updated plan", "plan"]]);
});
