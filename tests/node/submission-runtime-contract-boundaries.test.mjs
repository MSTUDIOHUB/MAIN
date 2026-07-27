import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const workspaceRoot = process.cwd();
const sharedContractPath = path.join(
  workspaceRoot,
  "src/lib/submissionRuntimeContracts.ts",
);
const legacyEnginePath = path.join(
  workspaceRoot,
  "src/lib/orchestrator/workflowEngine.ts",
);

function read(relativePath) {
  return fs.readFileSync(path.join(workspaceRoot, relativePath), "utf8");
}

test("submission runtime contracts are independent of Store and the legacy engine", () => {
  const source = fs.readFileSync(sharedContractPath, "utf8");

  assert.match(source, /export interface SubmissionRuntimeContext\b/);
  assert.match(source, /export interface SubmissionRuntimeStorePorts\b/);
  assert.doesNotMatch(
    source,
    /from\s+["'][^"']*(?:\/store\/|orchestrator\/workflowEngine)[^"']*["']/,
  );
});

test("the legacy workflow engine has been removed", () => {
  assert.equal(fs.existsSync(legacyEnginePath), false);
});

test("submission type consumers bypass the legacy workflow engine", () => {
  for (const relativePath of [
    "src/store/submitAsyncWorkflowRun.ts",
    "src/store/submitRuntimeContext.ts",
    "src/store/submitRuntimeRunner.ts",
    "src/store/submitStreamingUi.ts",
  ]) {
    const source = read(relativePath);
    assert.match(
      source,
      /from\s+["']\.\.\/lib\/submissionRuntimeContracts["']/,
      `${relativePath} must consume the neutral submission contract`,
    );
    assert.doesNotMatch(
      source,
      /import\s+type\s*\{[\s\S]*?\}\s*from\s+["'][^"']*orchestrator\/workflowEngine["']/,
      `${relativePath} must not load submission types from a legacy engine`,
    );
  }
});

test("remaining submission entry points do not acquire a legacy engine type dependency", () => {
  for (const relativePath of [
    "src/store/submitSendGateEffects.ts",
    "src/store/useAppStore.ts",
  ]) {
    assert.doesNotMatch(
      read(relativePath),
      /from\s+["'][^"']*orchestrator\/workflowEngine["']/,
      `${relativePath} must stay independent of the legacy workflow engine`,
    );
  }
});
