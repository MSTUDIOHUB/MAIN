import test from "node:test";
import assert from "node:assert/strict";
import fsSync from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

import ts from "typescript";

const require = createRequire(import.meta.url);
const workspaceRoot = process.cwd();
const transpiledModuleCache = new Map();

function loadTranspiledModuleSync(sourcePath) {
  const normalizedPath = path.resolve(sourcePath);
  if (transpiledModuleCache.has(normalizedPath)) {
    return transpiledModuleCache.get(normalizedPath);
  }

  const source = fsSync.readFileSync(normalizedPath, "utf8");
  const localRequire = createRequire(normalizedPath);
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
    fileName: normalizedPath,
  }).outputText;

  const module = { exports: {} };
  transpiledModuleCache.set(normalizedPath, module.exports);

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
  handleReasoningDominatedNoToolRecovery,
} = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/lib/orchestrator/loop/reasoningNoToolRecovery.ts"),
);

function makeCallbacks({
  language = "en",
  approved = false,
  planStage = "drafting",
  planTasks = [],
  evidenceLedger = [],
} = {}) {
  const events = [];
  return {
    events,
    callbacks: {
      getPreferredLanguage: () => language,
      getIsPlanApproved: () => approved,
      getPlanStage: () => planStage,
      getPlanTasks: () => planTasks,
      getPlanExecutionEvidenceLedger: () => evidenceLedger,
      getMessages: () => [{ role: "user", content: "Need a concrete fix." }],
      onStreamToken: (token, id) => events.push({ type: "token", token, id }),
      onStatusChange: (status) => events.push({ type: "status", status }),
      appendMessage: (message) => events.push({ type: "append", message }),
      onNonActionableStop: (message, reason, details) =>
        events.push({ type: "stop", message, reason, details }),
    },
  };
}

function reasoningStream() {
  return {
    content: "",
    reasoningContent: "hidden reasoning ".repeat(120),
    reasoningField: "reasoning_content",
    toolCalls: [],
    finishReason: "length",
  };
}

function baseInput(overrides = {}) {
  const generated = makeCallbacks(overrides.callbackOptions);
  const callbacks = overrides.callbacks ?? generated.callbacks;
  return {
    callbacks,
    workflowMode: "edit",
    turnIntent: "execute",
    runtimeIntent: "execute",
    iteration: 3,
    streamResult: reasoningStream(),
    normalizedToolCallCount: 0,
    normalizedReplyOptionCount: 0,
    assistantMsgId: "assistant-1",
    turnInputContextSignals: {
      imageParts: 0,
      mentionedFilePaths: [],
      attachedFilePaths: [],
    },
    recentPlanToolActivity: [],
    lastAssistantTextForCheckpoint: null,
    planEvidenceRecoveryPasses: 0,
    planReasoningOnlyRecoveryPasses: 0,
    consecutiveReasoningDominatedCount: 0,
    setPlanRuntimePhase: () => {},
    activateExecuteRecovery: () => {},
    ...overrides,
    callbacks,
  };
}

test("reasoning dominated execute turn activates mutation-first recovery", () => {
  const { callbacks, events } = makeCallbacks();
  const activations = [];
  const result = handleReasoningDominatedNoToolRecovery(baseInput({
    callbacks,
    activateExecuteRecovery: (mode, reason, details) => {
      activations.push({ mode, reason, details });
    },
  }));

  assert.equal(result.status, "continue");
  assert.equal(result.consecutiveReasoningDominatedCount, 1);
  assert.equal(activations[0].mode, "mutation_first");
  assert.equal(activations[0].reason, "reasoning_dominated_recovery");
  assert.equal(events.some((event) => event.type === "token" && event.token === "__ESCALATION_RESET__:"), true);
  assert.equal(events.some((event) => event.type === "status" && event.status === "running"), true);
  assert.equal(events.some((event) => event.type === "append" && /one concrete action/.test(event.message.content)), true);
});

test("second reasoning dominated turn pauses without another recovery prompt", () => {
  const { callbacks, events } = makeCallbacks();
  const result = handleReasoningDominatedNoToolRecovery(baseInput({
    callbacks,
    consecutiveReasoningDominatedCount: 1,
  }));

  assert.equal(result.status, "stopped");
  assert.equal(result.consecutiveReasoningDominatedCount, 2);
  assert.equal(events.some((event) => event.type === "stop" && event.reason === "no_output"), true);
  assert.equal(events.some((event) => event.type === "status" && event.status === "idle"), true);
  assert.equal(events.some((event) => event.type === "append"), false);
});

test("approved execute reasoning recovery follows Plan evidence provenance", () => {
  const planTasks = [{
    id: "edit-app",
    text: "Modify src/App.tsx and run tests",
    status: "in_progress",
    executionKind: "mutation",
    evidence: [
      { kind: "file", value: "src/App.tsx" },
      { kind: "cmd", value: "npm test" },
    ],
  }];
  const pending = makeCallbacks({ approved: true, planStage: "executing", planTasks });
  const pendingActivations = [];
  handleReasoningDominatedNoToolRecovery(baseInput({
    callbacks: pending.callbacks,
    activateExecuteRecovery: (...args) => pendingActivations.push(args),
  }));
  assert.equal(pendingActivations[0]?.[0], "mutation_first");

  const sourceSatisfied = makeCallbacks({
    approved: true,
    planStage: "executing",
    planTasks,
    evidenceLedger: [{
      id: "file-proof",
      planTaskId: "edit-app",
      kind: "file",
      value: "src/App.tsx",
      target: "src/App.tsx",
      sourceTool: "apply_patch",
      createdAt: 1,
    }],
  });
  const satisfiedActivations = [];
  handleReasoningDominatedNoToolRecovery(baseInput({
    callbacks: sourceSatisfied.callbacks,
    activateExecuteRecovery: (...args) => satisfiedActivations.push(args),
  }));
  assert.equal(satisfiedActivations.length, 0);

  handleReasoningDominatedNoToolRecovery(baseInput({
    callbacks: sourceSatisfied.callbacks,
    consecutiveReasoningDominatedCount: 1,
  }));
  assert.equal(
    sourceSatisfied.events.some((event) =>
      event.type === "stop" && event.reason === "incomplete_plan"
    ),
    true,
  );
});

test("unapproved plan reasoning-only result asks for targeted evidence first", () => {
  const { callbacks, events } = makeCallbacks({ language: "zh", approved: false });
  const phases = [];
  const result = handleReasoningDominatedNoToolRecovery(baseInput({
    callbacks,
    workflowMode: "plan",
    turnIntent: "plan",
    runtimeIntent: "plan",
    setPlanRuntimePhase: (phase, reason, status) => phases.push({ phase, reason, status }),
  }));

  assert.equal(result.status, "continue");
  assert.equal(result.consecutiveReasoningDominatedCount, 0);
  assert.equal(result.planReasoningOnlyRecoveryPasses, 1);
  assert.deepEqual(phases[0], {
    phase: "needs_evidence",
    reason: "no_targeted_evidence_read",
    status: undefined,
  });
  assert.equal(events.some((event) => event.type === "status" && event.status === "running"), true);
  assert.equal(events.some((event) => event.type === "append" && /evidence|read/i.test(event.message.content)), true);
});
