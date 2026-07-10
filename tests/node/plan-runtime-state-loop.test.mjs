import test from "node:test";
import assert from "node:assert/strict";
import fsSync from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

import ts from "typescript";

const workspaceRoot = process.cwd();
const transpiledModuleCache = new Map();

function loadTranspiledModuleSync(sourcePath) {
  const normalizedPath = path.resolve(sourcePath);
  if (transpiledModuleCache.has(normalizedPath)) {
    return transpiledModuleCache.get(normalizedPath);
  }

  const source = fsSync.readFileSync(normalizedPath, "utf8");
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
    fileName: normalizedPath,
  }).outputText;

  const module = { exports: {} };
  transpiledModuleCache.set(normalizedPath, module.exports);
  const localRequire = createRequire(normalizedPath);
  const runtimeRequire = (specifier) => {
    if (specifier.startsWith(".")) {
      const basePath = path.resolve(path.dirname(normalizedPath), specifier);
      const candidates = [
        basePath,
        `${basePath}.ts`,
        `${basePath}.tsx`,
        path.join(basePath, "index.ts"),
      ];
      for (const candidate of candidates) {
        if (!fsSync.existsSync(candidate)) continue;
        if (candidate.endsWith(".ts") || candidate.endsWith(".tsx")) {
          return loadTranspiledModuleSync(candidate);
        }
      }
    }
    return localRequire(specifier);
  };

  const factory = new Function("exports", "module", "require", transpiled);
  factory(module.exports, module, runtimeRequire);
  transpiledModuleCache.set(normalizedPath, module.exports);
  return module.exports;
}

const {
  applyPlanNoToolRuntimeState,
  applyPlanPostConvergenceRuntimeState,
  applyPlanQualityRuntimeState,
  applyPlanReadOnlyConvergenceRuntimeState,
  applyPlanRuntimePhase,
  applyReasoningNoToolPlanRuntimeState,
  applyToolResultPlanRuntimeState,
  createPlanLoopRuntimeState,
  markPlanClosurePromptIssued,
  markPlanModeToolActivity,
  resetPlanRecoveryPromptRuntimeState,
} = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/lib/orchestrator/loop/planRuntimeState.ts"),
);

function createFixtureState() {
  return {
    planRuntimePhase: "grounding",
    planQualityRejectCount: 2,
    planLastQualityGateReason: "missing_scope",
    planLastMissingSections: ["risks"],
    planArtifactQualityRejected: false,
    planEvidenceRecoveryPasses: 1,
    planReasoningOnlyRecoveryPasses: 3,
    planAutoScaffoldPromptIssued: true,
    planDraftingRecoveryReadCount: 4,
    planClosureEvidenceRecoveryIssued: true,
    planReadOnlyConvergenceBatches: 5,
    planReadOnlyConvergenceTools: 6,
    sawPlanModeToolActivity: false,
    usedPlanRecoveryPrompt: true,
    usedPlanClosureGuard: false,
    usedPlanClosurePrompt: false,
    usedPlanReadOnlyConvergencePrompt: true,
    planPostConvergenceToolRedirectCount: 7,
  };
}

test("plan loop runtime state starts in the correct phase for each workflow", () => {
  assert.equal(createPlanLoopRuntimeState({
    workflowMode: "plan",
    isPlanApproved: false,
  }).planRuntimePhase, "explore_structure");
  assert.equal(createPlanLoopRuntimeState({
    workflowMode: "plan",
    isPlanApproved: false,
  }).planArtifactQualityRejected, false);

  assert.equal(createPlanLoopRuntimeState({
    workflowMode: "plan",
    isPlanApproved: true,
  }).planRuntimePhase, "grounding");

  assert.equal(createPlanLoopRuntimeState({
    workflowMode: "chat",
    isPlanApproved: false,
  }).planRuntimePhase, "grounding");
});

test("plan phase reducer keeps no-op transitions stable but logs reasoned repeats", () => {
  const state = createFixtureState();

  const noOp = applyPlanRuntimePhase(state, { phase: "grounding" });
  assert.equal(noOp.changed, false);
  assert.equal(noOp.state, state);

  const reasonedRepeat = applyPlanRuntimePhase(state, {
    phase: "grounding",
    reason: "evidence_rechecked",
  });
  assert.equal(reasonedRepeat.changed, true);
  assert.notEqual(reasonedRepeat.state, state);
  assert.equal(reasonedRepeat.state.planRuntimePhase, "grounding");

  const changed = applyPlanRuntimePhase(state, { phase: "drafting" });
  assert.equal(changed.changed, true);
  assert.equal(changed.state.planRuntimePhase, "drafting");
});

test("plan runtime reducers update only their owned fields", () => {
  const state = createFixtureState();

  assert.deepEqual(applyReasoningNoToolPlanRuntimeState(state, {
    planReasoningOnlyRecoveryPasses: 9,
  }), {
    ...state,
    planReasoningOnlyRecoveryPasses: 9,
  });

  assert.deepEqual(applyPlanPostConvergenceRuntimeState(state, {
    planPostConvergenceToolRedirectCount: 16,
    planDraftingRecoveryReadCount: 7,
    planReasoningOnlyRecoveryPasses: 8,
    planAutoScaffoldPromptIssued: false,
  }), {
    ...state,
    planPostConvergenceToolRedirectCount: 16,
    planDraftingRecoveryReadCount: 7,
    planReasoningOnlyRecoveryPasses: 8,
    planAutoScaffoldPromptIssued: false,
  });

  assert.deepEqual(applyPlanNoToolRuntimeState(state, {
    usedPlanRecoveryPrompt: false,
    planClosureEvidenceRecoveryIssued: false,
  }), {
    ...state,
    usedPlanRecoveryPrompt: false,
    planClosureEvidenceRecoveryIssued: false,
  });

  assert.deepEqual(applyToolResultPlanRuntimeState(state, {
    planDraftingRecoveryReadCount: 11,
  }), {
    ...state,
    planDraftingRecoveryReadCount: 11,
  });

  assert.deepEqual(applyPlanQualityRuntimeState(state, {
    planQualityRejectCount: 12,
    planLastQualityGateReason: "needs_evidence",
    planLastMissingSections: ["verification", "fallback"],
    planArtifactQualityRejected: true,
    planAutoScaffoldPromptIssued: false,
    planClosureEvidenceRecoveryIssued: false,
    planEvidenceRecoveryPasses: 13,
  }), {
    ...state,
    planQualityRejectCount: 12,
    planLastQualityGateReason: "needs_evidence",
    planLastMissingSections: ["verification", "fallback"],
    planArtifactQualityRejected: true,
    planAutoScaffoldPromptIssued: false,
    planClosureEvidenceRecoveryIssued: false,
    planEvidenceRecoveryPasses: 13,
  });

  assert.deepEqual(applyPlanReadOnlyConvergenceRuntimeState(state, {
    planReadOnlyConvergenceBatches: 14,
    planReadOnlyConvergenceTools: 15,
    usedPlanReadOnlyConvergencePrompt: false,
  }), {
    ...state,
    planReadOnlyConvergenceBatches: 14,
    planReadOnlyConvergenceTools: 15,
    usedPlanReadOnlyConvergencePrompt: false,
  });
});

test("plan runtime action helpers own activity, closure, and recovery prompt flags", () => {
  const state = createFixtureState();

  const withActivity = markPlanModeToolActivity(state);
  assert.equal(withActivity.sawPlanModeToolActivity, true);
  assert.equal(markPlanModeToolActivity(withActivity), withActivity);

  const withClosurePrompt = markPlanClosurePromptIssued(state);
  assert.equal(withClosurePrompt.usedPlanClosureGuard, true);
  assert.equal(withClosurePrompt.usedPlanClosurePrompt, true);
  assert.equal(markPlanClosurePromptIssued(withClosurePrompt), withClosurePrompt);

  const withRecoveryPromptReset = resetPlanRecoveryPromptRuntimeState(state);
  assert.equal(withRecoveryPromptReset.usedPlanRecoveryPrompt, false);
  assert.equal(resetPlanRecoveryPromptRuntimeState(withRecoveryPromptReset), withRecoveryPromptReset);
});
