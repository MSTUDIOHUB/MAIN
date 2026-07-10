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
  createPlanReviewRuntimeHandlers,
} = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/lib/orchestrator/loop/planReviewRuntime.ts"),
);

function basePlanRuntimeState(overrides = {}) {
  return {
    planRuntimePhase: "explore_structure",
    planQualityRejectCount: 0,
    planLastQualityGateReason: "",
    planLastMissingSections: [],
    planEvidenceRecoveryPasses: 0,
    planReasoningOnlyRecoveryPasses: 0,
    planAutoScaffoldPromptIssued: false,
    planDraftingRecoveryReadCount: 0,
    planClosureEvidenceRecoveryIssued: false,
    planReadOnlyConvergenceBatches: 0,
    planReadOnlyConvergenceTools: 0,
    sawPlanModeToolActivity: false,
    usedPlanRecoveryPrompt: false,
    usedPlanClosureGuard: false,
    usedPlanClosurePrompt: false,
    usedPlanReadOnlyConvergencePrompt: false,
    planPostConvergenceToolRedirectCount: 0,
    ...overrides,
  };
}

function createHandlers(overrides = {}) {
  const events = [];
  const abortController = overrides.abortController ?? new AbortController();
  let planRuntimeState = basePlanRuntimeState(overrides.planRuntimeState);
  let approvedPlanRecoveryState = {
    approvedPlanNoProgressRecoveryAttempts: 0,
    approvedPlanActionOnlyRecoveryActive: false,
    approvedPlanNoToolRecoveryFileReadActive: false,
    approvedPlanLongReasoningNoActionCount: 0,
  };
  const callbacks = {
    getIsPlanApproved: () => false,
    onStatusChange: (status) => events.push({ type: "status", status }),
    ...overrides.callbacks,
  };
  const handlers = createPlanReviewRuntimeHandlers({
    callbacks,
    abortController,
    workflowMode: overrides.workflowMode ?? "plan",
    latestUserPromptText: "Create a plan",
    recentPlanToolActivity: [],
    attemptedPlanWriteTargets: [],
    getIteration: () => 3,
    getPlanRuntimeState: () => planRuntimeState,
    setPlanRuntimeState: (state) => {
      planRuntimeState = state;
    },
    getApprovedPlanRecoveryState: () => approvedPlanRecoveryState,
    setApprovedPlanRecoveryState: (state) => {
      approvedPlanRecoveryState = state;
    },
    setPlanRuntimePhase: (phase, reason, status) =>
      events.push({ type: "phase", phase, reason, status }),
    ...overrides.handlerInput,
  });
  return {
    abortController,
    events,
    handlers,
    getPlanRuntimeState: () => planRuntimeState,
    getApprovedPlanRecoveryState: () => approvedPlanRecoveryState,
  };
}

test("plan review wait returns immediately outside plan mode", async () => {
  const { events, handlers } = createHandlers({ workflowMode: "chat" });

  assert.equal(await handlers.waitForPlanApprovalIfNeeded(), true);
  assert.deepEqual(events, []);
});

test("plan review wait enters pending review and resolves false when aborted", async () => {
  const { abortController, events, handlers } = createHandlers();

  const wait = handlers.waitForPlanApprovalIfNeeded();
  assert.deepEqual(events, [{ type: "status", status: "pending_review" }]);
  abortController.abort();

  assert.equal(await wait, false);
});
