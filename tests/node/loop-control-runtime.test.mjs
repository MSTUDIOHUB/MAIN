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
  createAgentLoopControlRuntime,
} = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/lib/orchestrator/loop/loopControlRuntime.ts"),
);

function createControl(overrides = {}) {
  const progress = [];
  const phases = [];
  let streamRuntimeState = {
    usedMaxStepsFinalTextPrompt: false,
    chatFinalSynthesisActive: false,
    chatFinalSynthesisReason: "",
    usedChatFinalSynthesisPrompt: false,
    currentMaxTokens: undefined,
    loggedLocalPlanNoVisibleTokenNoticeOnly: false,
  };
  let approvedPlanRecoveryState = {
    approvedPlanNoProgressRecoveryAttempts: 0,
    approvedPlanActionOnlyRecoveryActive: false,
    approvedPlanNoToolRecoveryFileReadActive: false,
    approvedPlanLongReasoningNoActionCount: 0,
  };
  const callbacks = {
    getIsPlanApproved: () => true,
    onPlanExecutionProgress: (update) => progress.push(update),
    getPreferredLanguage: () => "en",
    getPlanAutoResumeCount: () => 0,
    getPlanTasks: () => [{ id: "1", text: "Run tests", status: "pending" }],
    getPlanExecutionEvidenceLedger: () => [],
    getMessages: () => [{ role: "user", content: "Run the approved plan" }],
    shouldForceXmlForProviderCompatibility: () => false,
    onStatusChange: () => {},
    appendMessage: () => {},
    ...overrides.callbacks,
  };
  const control = createAgentLoopControlRuntime({
    callbacks,
    runtimeState: {
      config: {
        activeProfile: "local",
        local: { contextLimit: 4096 },
      },
      settings: {
        provider: "test-provider",
        model: "test-model",
      },
      effectiveToolProtocol: "native",
      turnIntent: "plan",
      workflowMode: "plan",
    },
    recentPlanToolActivity: [],
    getIteration: () => 2,
    getRuntimeIntent: () => "execute",
    getExecuteRecoveryMode: () => "normal",
    getStreamRuntimeState: () => streamRuntimeState,
    setStreamRuntimeState: (state) => {
      streamRuntimeState = state;
    },
    getApprovedPlanRecoveryState: () => approvedPlanRecoveryState,
    setApprovedPlanRecoveryState: (state) => {
      approvedPlanRecoveryState = state;
    },
    emitTaskOrchestratorPhase: (phase, extra) => phases.push({ phase, extra }),
    setPlanRuntimePhase: (phase, reason, status) =>
      phases.push({ phase, reason, status }),
    ...overrides.input,
  });
  return {
    control,
    progress,
    phases,
    getApprovedPlanRecoveryState: () => approvedPlanRecoveryState,
  };
}

test("loop control emits approved plan execution progress with iteration metadata", () => {
  const { control, progress } = createControl();

  control.emitPlanExecutionProgress("running");

  assert.equal(progress.length, 1);
  assert.equal(progress[0].phase, "running");
  assert.equal(progress[0].iteration, 2);
  assert.equal(progress[0].maxIterations, control.getEffectiveMaxIterations());
});

test("loop control grants the full execution budget after same-loop plan approval", () => {
  let approved = false;
  let iteration = 18;
  const progress = [];
  const { control } = createControl({
    callbacks: {
      getIsPlanApproved: () => approved,
      onPlanExecutionProgress: (update) => progress.push(update),
    },
    input: {
      getIteration: () => iteration,
      getRuntimeIntent: () => approved ? "execute" : "plan",
    },
  });

  assert.equal(control.getEffectiveMaxIterations(), 25);
  approved = true;
  assert.equal(control.getEffectiveMaxIterations(), 68);
  iteration = 19;
  control.emitPlanExecutionProgress("running");
  assert.equal(progress.at(-1).iteration, 1);
  assert.equal(progress.at(-1).maxIterations, 50);
  iteration = 40;
  assert.equal(control.getEffectiveMaxIterations(), 68);
});

test("loop control startLoop moves unapproved plan turns into explore phase", () => {
  const { control, progress, phases } = createControl({
    callbacks: {
      getIsPlanApproved: () => false,
      onPlanExecutionProgress: (update) => progress.push(update),
    },
  });

  control.startLoop({
    runtimeIntent: "plan",
    loopStartTools: [],
    mcpToolCount: 0,
    unityMcpFirstPhaseActive: false,
    unityMcpFallbackReason: null,
    allowRootSkeleton: true,
  });

  assert.equal(progress.length, 0);
  assert.deepEqual(phases.at(-1), {
    phase: "explore_structure",
    reason: "start with shallow project structure",
    status: undefined,
  });
});

test("loop control skips root exploration when task targeting already has a scoped target", () => {
  const { control, phases } = createControl({
    callbacks: {
      getIsPlanApproved: () => false,
    },
  });

  control.startLoop({
    runtimeIntent: "plan",
    loopStartTools: [],
    mcpToolCount: 0,
    unityMcpFirstPhaseActive: false,
    unityMcpFallbackReason: null,
    allowRootSkeleton: false,
  });

  assert.deepEqual(phases.at(-1), {
    phase: "grounding",
    reason: "start with targeted grounding",
    status: undefined,
  });
});

test("strategy switch returns and persists the folded approved-plan recovery state", () => {
  const { control, getApprovedPlanRecoveryState } = createControl();

  const nextState = control.continueApprovedPlanWithStrategySwitch({
    reason: "no_progress_cached_read_only_batch",
    remainingText: "Modify src/App.tsx",
  });

  assert.equal(nextState.approvedPlanNoProgressRecoveryAttempts, 1);
  assert.equal(nextState.approvedPlanActionOnlyRecoveryActive, true);
  assert.deepEqual(getApprovedPlanRecoveryState(), nextState);
});
