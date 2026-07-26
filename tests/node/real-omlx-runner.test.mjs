import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const source = fs.readFileSync(
  path.join(process.cwd(), "scripts/run-real-omlx-plan-e2e.mjs"),
  "utf8",
);
const specSource = fs.readFileSync(
  path.join(process.cwd(), "tests/e2e/real-omlx-plan-flow.spec.ts"),
  "utf8",
);
const e2eBridgeSource = fs.readFileSync(
  path.join(process.cwd(), "src/lib/e2e.ts"),
  "utf8",
);
const legacyProbeSource = fs.readFileSync(
  path.join(process.cwd(), "scripts/validate-omlx-plan-flow.mjs"),
  "utf8",
);

test("real OMLX validation selects only a fully loaded model", () => {
  assert.match(source, /\/models\/status/);
  assert.match(source, /model\?\.loaded === true && model\?\.is_loading !== true/);
  assert.match(source, /refusing to trigger an implicit large-model load/);
  assert.match(source, /single-model safety gate failed/);
  assert.match(source, /Number\(status\?\.loaded_count\) !== 1/);
  assert.match(source, /transitioningModelIds\.length > 0/);
  assert.match(source, /selectedModelIds\.length !== 1/);
  assert.match(source, /unloadedRequestedModels/);
  assert.match(source, /OMLX_MODELS: selectedModelIds\.join/);
  assert.match(source, /REAL_OMLX_TEST_GREP \|\| "plan\/approve\/execute"/);
  assert.match(source, /"--grep", testGrep/);
  assert.match(source, /for \(let attempt = 1; attempt <= 3; attempt \+= 1\)/);
  assert.match(source, /readSingleModelStatusWithRetry\(selectedModelIds\[0\], "preflight"\)/);
  assert.match(source, /readSingleModelStatusWithRetry\(selectedModelIds\[0\], "postflight"\)/);
  assert.match(source, /验收后单模型安全检查失败/);
});

test("legacy OMLX probe cannot address or implicitly load two models", () => {
  assert.doesNotMatch(legacyProbeSource, /gemma-4-26b-a4b-it-8bit,Qwen3\.6-35B-A3B-6bit/);
  assert.match(legacyProbeSource, /models\.length !== 1/);
  assert.match(legacyProbeSource, /\/models\/status/);
  assert.match(legacyProbeSource, /Number\(modelStatus\?\.loaded_count\) !== 1/);
  assert.match(legacyProbeSource, /loadedModelIds\[0\] !== models\[0\]/);
  assert.match(legacyProbeSource, /refusing an implicit load or overlapping model memory/);
});

test("real OMLX spec fails closed unless parent and subagents share one explicit model", () => {
  assert.match(specSource, /runRealOmlx && models\.length !== 1/);
  assert.doesNotMatch(specSource, /gemma-4-26b-a4b-it-8bit,Qwen3\.6-35B-A3B-6bit/);
  assert.match(specSource, /explicitSubagentModel !== models\[0\]/);
});

test("real OMLX validation requires caller-prepared workspaces and explicit acceptance scopes", () => {
  assert.match(source, /REAL_OMLX_WORKSPACE 必须是调用方预先复制好的非空工作区/);
  assert.match(source, /workspaceEntries\.length === 0/);
  assert.match(specSource, /E2E_REAL_OMLX_CUSTOM_WORKSPACE_EMPTY/);
  assert.match(specSource, /REAL_OMLX_PLAN_EVIDENCE_TARGETS/);
  assert.match(specSource, /REAL_OMLX_EXPECT_SUBAGENT_SCOPES/);
  assert.match(specSource, /candidateEvidenceTargets\.has\(target\)/);
  assert.doesNotMatch(specSource, /Fall back to the deterministic fixture structure below/);
});

test("real OMLX E2E identity and acceptance are model-neutral and debug-tail independent", () => {
  assert.doesNotMatch(e2eBridgeSource, /model\.includes\(["']Qwen["']\)/);
  assert.match(e2eBridgeSource, /stableRealOmlxSessionId\(`\$\{workspace\}\\0\$\{model\}`\)/);
  assert.match(e2eBridgeSource, /__REAL_OMLX_ACCEPTANCE_STATE__/);
  assert.match(specSource, /recordRealOmlxAcceptanceDebugEvent/);
  assert.match(specSource, /projectRealOmlxCollaborationScopes/);
});
