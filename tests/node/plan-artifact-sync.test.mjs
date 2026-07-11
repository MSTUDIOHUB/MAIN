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

const {
  commitResolvedPlanArtifactUpdate,
  resolvePlanArtifactAfterToolSuccess,
  syncPlanArtifactAfterToolSuccess,
} = loadTs(
  path.join(workspaceRoot, "src/lib/planArtifactSync.ts"),
);

test("resolving a plan artifact does not publish it before the caller accepts quality", async () => {
  const update = await resolvePlanArtifactAfterToolSuccess(
    "write_file",
    { path: ".MAIN/plans/plan.md", content: "# Unsupported draft" },
    { readFile: async () => "unexpected" },
  );

  assert.deepEqual(update, {
    path: ".MAIN/plans/plan.md",
    kind: "plan",
    content: "# Unsupported draft",
  });

  const published = [];
  commitResolvedPlanArtifactUpdate(update, {
    onPlanArtifactUpdated: (...args) => published.push(args),
    onPlanTasksUpdated: () => {},
  });
  assert.deepEqual(published, [[
    ".MAIN/plans/plan.md",
    "# Unsupported draft",
    "plan",
  ]]);
});

test("orchestrator commits resolved plan bytes only after the quality gate accepts them", () => {
  const source = fs.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator.ts"), "utf8");
  const resolveIndex = source.indexOf("const resolvedPlanArtifactUpdate = await resolvePlanArtifactAfterToolSuccess(");
  const acceptanceIndex = source.indexOf("let planArtifactAccepted = true;", resolveIndex);
  const rejectionIndex = source.indexOf("planArtifactAccepted = false;", acceptanceIndex);
  const guardedCommitIndex = source.indexOf(
    "if (resolvedPlanArtifactUpdate && planArtifactAccepted)",
    rejectionIndex,
  );
  const commitIndex = source.indexOf("commitResolvedPlanArtifactUpdate(", guardedCommitIndex);

  assert.ok(resolveIndex >= 0, "expected exact plan bytes to be resolved");
  assert.ok(acceptanceIndex > resolveIndex, "expected a separate artifact acceptance state");
  assert.ok(rejectionIndex > acceptanceIndex, "expected failed validation to reject publication");
  assert.ok(guardedCommitIndex > rejectionIndex, "expected commit to run after validation");
  assert.ok(commitIndex > guardedCommitIndex, "expected the guarded commit helper");
  assert.match(source.slice(rejectionIndex, guardedCommitIndex), /storePublished:\s*false/);
  assert.match(
    source,
    /export function isSuccessfulPlanArtifactWriteResult[\s\S]{0,220}!result\.internalFeedback/,
    "a quality-rejected disk write must not become a successful Plan artifact result",
  );
});

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

test("Plan artifact sync collapses safe relative aliases but rejects external absolute identities", async () => {
  const relative = await resolvePlanArtifactAfterToolSuccess(
    "write_file",
    { path: "./.MAIN\\plans\\plan.md", content: "# Relative alias" },
    { readFile: async () => "unexpected" },
  );
  const externalAbsolute = await resolvePlanArtifactAfterToolSuccess(
    "write_file",
    { path: "/tmp/project/.MAIN/plans/plan.md", content: "# Absolute alias" },
    { readFile: async () => "unexpected" },
  );

  assert.equal(relative?.path, ".MAIN/plans/plan.md");
  assert.equal(externalAbsolute, null);
});
