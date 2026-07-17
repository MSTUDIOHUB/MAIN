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

const completionGuardsModule = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/lib/orchestrator/loop/completionGuards.ts"),
);

const {
  buildExecutionCheckpointPresentation,
  resolveNonActionableStopOutcome,
  runApprovedPlanCompletionGuard,
  runExecutionEvidenceCompletionGuard,
} = completionGuardsModule;

test("terminal execution checkpoint preserves mutations, readiness, and the concrete browser blocker", () => {
  const ledger = [
    {
      id: "edit-toolbar",
      kind: "file",
      value: "src/toolbar.js",
      target: "src/toolbar.js",
      sourceTool: "write_file",
      createdAt: 1,
    },
    {
      id: "edit-main-1",
      kind: "file",
      value: "src/main.js",
      target: "src/main.js",
      sourceTool: "replace_in_file",
      createdAt: 2,
    },
    {
      id: "edit-main-2",
      kind: "file",
      value: "src/main.js",
      target: "src/main.js",
      sourceTool: "replace_in_file",
      createdAt: 3,
    },
    {
      id: "launch",
      kind: "cmd",
      value: "npm run dev",
      target: "npm run dev",
      sourceTool: "execute_command",
      observationStatus: "pending",
      foregroundGeneration: 2,
      createdAt: 4,
    },
    {
      id: "ready",
      kind: "dev_server_url",
      value: "http://localhost:1420/",
      target: "pty-1",
      sourceTool: "get_pty_status",
      observationStatus: "ready",
      foregroundGeneration: 2,
      createdAt: 5,
    },
    {
      id: "browser-failure",
      kind: "tool",
      value: "http://localhost:1420/",
      target: "http://localhost:1420/",
      sourceTool: "browser_evaluate",
      observationStatus: "failed",
      references: ["src/main.js"],
      browserInteraction: {
        actions: [{ kind: "click", target: "#new-btn", succeeded: true }],
        assertions: [],
        pageErrors: ["ReferenceError: handleFileOpen is not defined at src/main.js:92:42"],
        consoleErrors: [],
      },
      createdAt: 6,
    },
  ];

  const checkpoint = buildExecutionCheckpointPresentation({
    ledger,
    language: "zh",
    fallbackMessage: "恢复阶段没有新证据。",
  });

  assert.match(checkpoint.message, /3 次文件修改/);
  assert.match(checkpoint.message, /2 个文件/);
  assert.match(checkpoint.message, /http:\/\/localhost:1420\//);
  assert.match(checkpoint.message, /handleFileOpen is not defined/);
  assert.match(checkpoint.nextStep, /src\/main\.js/);
  assert.doesNotMatch(checkpoint.message, /已完成任务|执行已完成/);
  assert.equal(checkpoint.target, "src/main.js");
  assert.equal(checkpoint.tool, "browser_evaluate");
});

function loadAgentLoopRunnerWithFake(FakeAgentOrchestrator, logEvents) {
  const sourcePath = path.join(workspaceRoot, "src/lib/orchestrator/loop/AgentLoopRunner.ts");
  const source = fsSync.readFileSync(sourcePath, "utf8");
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
    fileName: sourcePath,
  }).outputText;
  const module = { exports: {} };
  const localRequire = createRequire(sourcePath);
  const runtimeRequire = (specifier) => {
    if (specifier === "../../orchestrator") {
      return {
        logAgentEvent: (event, data) => logEvents.push({ event, data }),
      };
    }
    if (specifier === "./AgentOrchestrator") {
      return { AgentOrchestrator: FakeAgentOrchestrator };
    }
    if (specifier === "./completionGuards") {
      return completionGuardsModule;
    }
    return localRequire(specifier);
  };
  const factory = new Function("exports", "module", "require", transpiled);
  factory(module.exports, module, runtimeRequire);
  return module.exports;
}

function createCallbacks(overrides = {}) {
  const events = {
    stops: [],
    statuses: [],
  };
  const callbacks = {
    getPreferredLanguage: () => "zh",
    getWorkflowMode: () => "chat",
    getIsPlanApproved: () => false,
    getPlanTasks: () => [],
    getPlanExecutionEvidenceLedger: () => [],
    onNonActionableStop: (message, reason, progress) => {
      events.stops.push({ message, reason, progress });
    },
    onStatusChange: (status) => {
      events.statuses.push(status);
    },
    ...overrides,
  };
  return { callbacks, events };
}

test("completion guard maps non-actionable stops to structured loop outcomes", () => {
  assert.deepEqual(resolveNonActionableStopOutcome("no_output"), {
    status: "stopped_no_output",
    reason: "no_output",
  });
  assert.deepEqual(resolveNonActionableStopOutcome("incomplete_plan"), {
    status: "paused",
    reason: "incomplete_plan",
  });
  assert.deepEqual(
    resolveNonActionableStopOutcome("incomplete_plan", {
      recoveryReason: "approved_plan_completion_guard_no_evidence",
    }),
    {
      status: "stopped_no_action",
      reason: "approved_plan_completion_guard_no_evidence",
    },
  );
  assert.deepEqual(
    resolveNonActionableStopOutcome("incomplete_plan", {
      recoveryReason: "preapproval_plan_quality_recovery_stream_timeout",
    }),
    {
      status: "paused",
      reason: "preapproval_plan_quality_recovery_stream_timeout",
    },
  );
});

test("execution evidence completion guard pauses completed execute turns without evidence", () => {
  const { callbacks, events } = createCallbacks();
  const result = runExecutionEvidenceCompletionGuard({
    outcome: { status: "completed", reason: "agent_loop_completed" },
    callbacks,
    finalTurnContract: {
      conversationIntent: "execute",
      runtimeIntent: "execute",
      approvalState: "approved",
      mutationExpected: true,
      completionEvidenceRequired: "execution_evidence",
    },
    approvedPlanAlreadyAudited: false,
    sawExecutionEvidence: false,
  });

  assert.deepEqual(result, {
    status: "stopped_no_action",
    reason: "execution_evidence_required",
  });
  assert.equal(events.stops.length, 1);
  assert.equal(events.stops[0].reason, "no_action");
  assert.equal(events.statuses.at(-1), "idle");
});

test("execution evidence completion guard allows a mutation only after fresh validation", () => {
  const ledger = [
    {
      id: "mutation",
      kind: "file",
      value: "src/App.tsx",
      target: "src/App.tsx",
      sourceTool: "apply_patch",
      createdAt: 1,
    },
    {
      id: "validation",
      kind: "cmd",
      value: "npm test",
      target: "npm test",
      sourceTool: "run_command",
      createdAt: 2,
    },
  ];
  const { callbacks, events } = createCallbacks({
    getPlanExecutionEvidenceLedger: () => ledger,
  });
  const result = runExecutionEvidenceCompletionGuard({
    outcome: { status: "completed", reason: "agent_loop_completed" },
    callbacks,
    finalTurnContract: {
      conversationIntent: "execute",
      runtimeIntent: "execute",
      approvalState: "approved",
      mutationExpected: true,
      validationExpected: true,
      completionEvidenceRequired: "execution_evidence",
    },
    approvedPlanAlreadyAudited: false,
    sawExecutionEvidence: true,
  });

  assert.equal(result, null);
  assert.equal(events.stops.length, 0);
});

test("an active recovery phase blocks final completion even when prior evidence is otherwise sufficient", () => {
  const { callbacks, events } = createCallbacks({
    getPlanExecutionEvidenceLedger: () => [
      {
        id: "mutation",
        kind: "file",
        value: "src/App.tsx",
        sourceTool: "apply_patch",
        createdAt: 1,
      },
      {
        id: "validation",
        kind: "cmd",
        value: "npm test",
        sourceTool: "run_command",
        createdAt: 2,
      },
    ],
  });
  const result = runExecutionEvidenceCompletionGuard({
    outcome: { status: "completed", reason: "agent_loop_completed" },
    callbacks,
    finalTurnContract: {
      conversationIntent: "execute",
      runtimeIntent: "execute",
      approvalState: "approved",
      mutationExpected: true,
      validationExpected: true,
      completionEvidenceRequired: "execution_evidence",
    },
    approvedPlanAlreadyAudited: false,
    sawExecutionEvidence: true,
    executeRecoveryState: {
      mode: "validation_only",
      reason: "recovery_mutation_observed",
      expectedTarget: "src/App.tsx",
      attempts: 1,
      phaseNoProgressCount: 1,
      iterationCount: 1,
      readLease: null,
      sourceObservationKey: null,
      decisionCheckpoint: null,
    },
  });
  assert.equal(result.reason, "execution_evidence_gap:recovery_phase_pending");
  assert.match(events.stops[0].message, /恢复事务仍处于 validation 阶段/);
});

test("execution evidence completion guard rejects mutation without later validation", () => {
  const { callbacks, events } = createCallbacks({
    getPlanExecutionEvidenceLedger: () => [{
      id: "mutation",
      kind: "file",
      value: "src/App.tsx",
      target: "src/App.tsx",
      sourceTool: "apply_patch",
      createdAt: 2,
    }],
  });
  const result = runExecutionEvidenceCompletionGuard({
    outcome: { status: "completed", reason: "agent_loop_completed" },
    callbacks,
    finalTurnContract: {
      conversationIntent: "execute",
      runtimeIntent: "execute",
      approvalState: "approved",
      mutationExpected: true,
      validationExpected: true,
      completionEvidenceRequired: "execution_evidence",
    },
    approvedPlanAlreadyAudited: false,
    sawExecutionEvidence: true,
  });

  assert.deepEqual(result, {
    status: "stopped_no_action",
    reason: "execution_evidence_gap:validation_after_mutation_required",
  });
  assert.match(events.stops[0].message, /最新修改之后没有可信/);
  assert.equal(events.stops[0].progress.recoveryReason, "execution_evidence_gap:validation_after_mutation_required");
});

test("validation before a newer mutation cannot close the execution evidence gate", () => {
  const { callbacks } = createCallbacks({
    getPlanExecutionEvidenceLedger: () => [
      {
        id: "old-validation",
        kind: "cmd",
        value: "npm test",
        sourceTool: "run_command",
        createdAt: 1,
      },
      {
        id: "new-mutation",
        kind: "file",
        value: "src/App.tsx",
        sourceTool: "apply_patch",
        createdAt: 2,
      },
    ],
  });
  const result = runExecutionEvidenceCompletionGuard({
    outcome: { status: "completed", reason: "agent_loop_completed" },
    callbacks,
    finalTurnContract: {
      conversationIntent: "execute",
      runtimeIntent: "execute",
      approvalState: "approved",
      mutationExpected: true,
      validationExpected: true,
      completionEvidenceRequired: "execution_evidence",
    },
    approvedPlanAlreadyAudited: false,
    sawExecutionEvidence: true,
  });
  assert.equal(result.reason, "execution_evidence_gap:validation_after_mutation_required");
});

test("a later actual browser failure remains unresolved until the same browser target succeeds", () => {
  const contract = {
    conversationIntent: "execute",
    runtimeIntent: "execute",
    approvalState: "approved",
    mutationExpected: true,
    validationExpected: true,
    completionEvidenceRequired: "execution_evidence",
  };
  const failedLedger = [
    {
      id: "mutation",
      kind: "file",
      value: "src/App.tsx",
      sourceTool: "apply_patch",
      createdAt: 1,
    },
    {
      id: "finite-validation",
      kind: "cmd",
      value: "npm test",
      sourceTool: "run_command",
      createdAt: 2,
    },
    {
      id: "browser-failure",
      kind: "tool",
      value: "http://localhost:1420/",
      target: "http://localhost:1420/",
      sourceTool: "browser_evaluate",
      observationStatus: "failed",
      createdAt: 3,
    },
  ];
  const failedHarness = createCallbacks({
    getPlanExecutionEvidenceLedger: () => failedLedger,
  });
  const blocked = runExecutionEvidenceCompletionGuard({
    outcome: { status: "completed", reason: "agent_loop_completed" },
    callbacks: failedHarness.callbacks,
    finalTurnContract: contract,
    approvedPlanAlreadyAudited: false,
    sawExecutionEvidence: true,
  });
  assert.equal(blocked.reason, "execution_evidence_gap:unreconciled_failure");

  const recoveredHarness = createCallbacks({
    getPlanExecutionEvidenceLedger: () => [...failedLedger, {
      id: "browser-success",
      kind: "browser_dom",
      value: "http://localhost:1420/",
      target: "http://localhost:1420/",
      sourceTool: "browser_evaluate",
      createdAt: 4,
    }],
  });
  const recovered = runExecutionEvidenceCompletionGuard({
    outcome: { status: "completed", reason: "agent_loop_completed" },
    callbacks: recoveredHarness.callbacks,
    finalTurnContract: contract,
    approvedPlanAlreadyAudited: false,
    sawExecutionEvidence: true,
  });
  assert.equal(recovered, null);
});

test("ledger append order, not equal millisecond timestamps, determines post-mutation validation", () => {
  const contract = {
    conversationIntent: "execute",
    runtimeIntent: "execute",
    approvalState: "approved",
    mutationExpected: true,
    validationExpected: true,
    completionEvidenceRequired: "execution_evidence",
  };
  const blockedHarness = createCallbacks({
    getPlanExecutionEvidenceLedger: () => [
      {
        id: "validation-first",
        kind: "cmd",
        value: "npm test",
        sourceTool: "run_command",
        createdAt: 10,
      },
      {
        id: "mutation-second",
        kind: "file",
        value: "src/App.tsx",
        sourceTool: "apply_patch",
        createdAt: 10,
      },
    ],
  });
  const blocked = runExecutionEvidenceCompletionGuard({
    outcome: { status: "completed", reason: "agent_loop_completed" },
    callbacks: blockedHarness.callbacks,
    finalTurnContract: contract,
    approvedPlanAlreadyAudited: false,
    sawExecutionEvidence: true,
  });
  assert.equal(blocked.reason, "execution_evidence_gap:validation_after_mutation_required");

  const closedHarness = createCallbacks({
    getPlanExecutionEvidenceLedger: () => [
      {
        id: "mutation-first",
        kind: "file",
        value: "src/App.tsx",
        sourceTool: "apply_patch",
        createdAt: 10,
      },
      {
        id: "validation-second",
        kind: "cmd",
        value: "npm test",
        sourceTool: "run_command",
        createdAt: 10,
      },
    ],
  });
  const closed = runExecutionEvidenceCompletionGuard({
    outcome: { status: "completed", reason: "agent_loop_completed" },
    callbacks: closedHarness.callbacks,
    finalTurnContract: contract,
    approvedPlanAlreadyAudited: false,
    sawExecutionEvidence: true,
  });
  assert.equal(closed, null);
});

test("long-running execution requires PTY readiness and only interaction work requires a browser", () => {
  const baseLedger = [
    {
      id: "mutation",
      kind: "file",
      value: "src/App.tsx",
      sourceTool: "apply_patch",
      changedIdentifiers: ["formatDocument"],
      createdAt: 1,
    },
    {
      id: "launch",
      kind: "cmd",
      value: "npm run dev",
      sourceTool: "execute_command",
      observationStatus: "pending",
      foregroundGeneration: 3,
      createdAt: 2,
    },
  ];
  const contract = {
    conversationIntent: "execute",
    runtimeIntent: "execute",
    approvalState: "approved",
    mutationExpected: true,
    validationExpected: true,
    completionEvidenceRequired: "execution_evidence",
  };
  const pendingHarness = createCallbacks({
    getPlanExecutionEvidenceLedger: () => baseLedger,
  });
  const pending = runExecutionEvidenceCompletionGuard({
    outcome: { status: "completed", reason: "agent_loop_completed" },
    callbacks: pendingHarness.callbacks,
    finalTurnContract: contract,
    approvedPlanAlreadyAudited: false,
    sawExecutionEvidence: true,
  });
  assert.equal(pending.reason, "execution_evidence_gap:pty_observation_required");

  const readyLedger = [...baseLedger, {
    id: "ready",
    kind: "dev_server_url",
    value: "http://localhost:1420/",
    sourceTool: "read_pty_since",
    observationStatus: "ready",
    foregroundGeneration: 3,
    createdAt: 3,
  }];
  const readyHarness = createCallbacks({
    getPlanExecutionEvidenceLedger: () => readyLedger,
  });
  const ready = runExecutionEvidenceCompletionGuard({
    outcome: { status: "completed", reason: "agent_loop_completed" },
    callbacks: readyHarness.callbacks,
    finalTurnContract: contract,
    approvedPlanAlreadyAudited: false,
    sawExecutionEvidence: true,
  });
  assert.equal(ready, null);

  const interactionReadyLedger = readyLedger.map((entry) => entry.id === "mutation"
    ? {
        ...entry,
        interactionMutation: true,
        interactionBehaviorTargets: ["#new-btn"],
      }
    : entry);
  const interactionReadyHarness = createCallbacks({
    getPlanExecutionEvidenceLedger: () => interactionReadyLedger,
  });
  const interactionReady = runExecutionEvidenceCompletionGuard({
    outcome: { status: "completed", reason: "agent_loop_completed" },
    callbacks: interactionReadyHarness.callbacks,
    finalTurnContract: contract,
    approvedPlanAlreadyAudited: false,
    sawExecutionEvidence: true,
  });
  assert.equal(interactionReady.reason, "execution_evidence_gap:browser_validation_required");

  const browserHarness = createCallbacks({
    getPlanExecutionEvidenceLedger: () => [...interactionReadyLedger, {
      id: "browser",
      kind: "browser_dom",
      value: "http://localhost:1420/",
      target: "http://localhost:1420/",
      sourceTool: "browser_evaluate",
      createdAt: 4,
      browserInteraction: {
        actions: [{
          id: "click-new",
          kind: "click",
          target: "#new-btn",
          succeeded: true,
          stateChanged: true,
          changedFields: ["bodyText"],
          effectChangedFields: ["bodyText"],
          effectStateChanged: true,
        }],
        assertions: [{
          kind: "text",
          target: "Untitled",
          passed: true,
          beforePassed: false,
          changedAfterAction: true,
          causallyLinked: true,
          afterActionId: "click-new",
        }],
        pageErrors: [],
        consoleErrors: [],
      },
    }],
  });
  const closed = runExecutionEvidenceCompletionGuard({
    outcome: { status: "completed", reason: "agent_loop_completed" },
    callbacks: browserHarness.callbacks,
    finalTurnContract: contract,
    approvedPlanAlreadyAudited: false,
    sawExecutionEvidence: true,
  });
  assert.equal(closed, null);
});

test("validation-only long-running execution completes after current PTY readiness", () => {
  const launch = {
    id: "validation-only-launch",
    kind: "cmd",
    value: "npm run dev",
    sourceTool: "execute_command",
    observationStatus: "pending",
    foregroundGeneration: 7,
    createdAt: 1,
  };
  const contract = {
    conversationIntent: "execute",
    runtimeIntent: "execute",
    approvalState: "approved",
    mutationExpected: false,
    validationExpected: true,
    completionEvidenceRequired: "execution_evidence",
  };
  const guard = (ledger) => runExecutionEvidenceCompletionGuard({
    outcome: { status: "completed", reason: "agent_loop_completed" },
    callbacks: createCallbacks({
      getPlanExecutionEvidenceLedger: () => ledger,
    }).callbacks,
    finalTurnContract: contract,
    approvedPlanAlreadyAudited: false,
    sawExecutionEvidence: true,
  });

  assert.equal(
    guard([launch])?.reason,
    "execution_evidence_gap:pty_observation_required",
  );
  const ready = {
    id: "validation-only-ready",
    kind: "dev_server_url",
    value: "http://localhost:1420/",
    sourceTool: "read_pty_since",
    observationStatus: "ready",
    foregroundGeneration: 7,
    createdAt: 2,
  };
  assert.equal(
    guard([launch, ready]),
    null,
  );
});

test("a healthy existing server reconciles a port conflict but still requires browser validation", () => {
  const contract = {
    conversationIntent: "execute",
    runtimeIntent: "execute",
    approvalState: "approved",
    mutationExpected: true,
    validationExpected: true,
    completionEvidenceRequired: "execution_evidence",
  };
  const reconciledLedger = [
    {
      id: "mutation",
      kind: "file",
      value: "src/App.tsx",
      sourceTool: "apply_patch",
      interactionMutation: true,
      interactionBehaviorTargets: ["#new-btn"],
      createdAt: 1,
    },
    {
      id: "port-conflict",
      kind: "cmd",
      value: "npm run dev",
      sourceTool: "execute_command",
      observationStatus: "failed",
      portConflict: true,
      devServerPort: 1420,
      createdAt: 2,
    },
    {
      id: "healthy-existing-server",
      kind: "cmd",
      value: "curl -fsS http://localhost:1420/",
      sourceTool: "run_command",
      devServerPort: 1420,
      createdAt: 3,
    },
  ];
  const reconciledHarness = createCallbacks({
    getPlanExecutionEvidenceLedger: () => reconciledLedger,
  });
  const reconciled = runExecutionEvidenceCompletionGuard({
    outcome: { status: "completed", reason: "agent_loop_completed" },
    callbacks: reconciledHarness.callbacks,
    finalTurnContract: contract,
    approvedPlanAlreadyAudited: false,
    sawExecutionEvidence: true,
  });
  assert.equal(reconciled.reason, "execution_evidence_gap:browser_validation_required");

  const browserHarness = createCallbacks({
    getPlanExecutionEvidenceLedger: () => [...reconciledLedger, {
      id: "browser",
      kind: "browser_dom",
      value: "http://localhost:1420/",
      target: "http://localhost:1420/",
      sourceTool: "browser_evaluate",
      createdAt: 4,
      browserInteraction: {
        actions: [{
          id: "click-new",
          kind: "click",
          target: "#new-btn",
          succeeded: true,
          stateChanged: true,
          changedFields: ["bodyText"],
          effectChangedFields: ["bodyText"],
          effectStateChanged: true,
        }],
        assertions: [{
          kind: "text",
          target: "Untitled",
          passed: true,
          beforePassed: false,
          changedAfterAction: true,
          causallyLinked: true,
          afterActionId: "click-new",
        }],
        pageErrors: [],
        consoleErrors: [],
      },
    }],
  });
  const closed = runExecutionEvidenceCompletionGuard({
    outcome: { status: "completed", reason: "agent_loop_completed" },
    callbacks: browserHarness.callbacks,
    finalTurnContract: contract,
    approvedPlanAlreadyAudited: false,
    sawExecutionEvidence: true,
  });
  assert.equal(closed, null);
});

test("approved plan provenance keeps its completion guard in default execute workflow", () => {
  const { callbacks, events } = createCallbacks({
    getWorkflowMode: () => "edit",
    getIsPlanApproved: () => true,
  });
  const result = runApprovedPlanCompletionGuard({
    outcome: { status: "completed", reason: "agent_loop_completed" },
    callbacks,
    sawExecutionEvidence: false,
  });

  assert.deepEqual(result, {
    status: "stopped_no_action",
    reason: "approved_plan_completion_guard",
  });
  assert.equal(events.stops.length, 1);
  assert.equal(events.stops[0].reason, "incomplete_plan");
  assert.equal(events.stops[0].progress.recoveryReason, "approved_plan_completion_guard_no_evidence");
  assert.equal(events.statuses.at(-1), "idle");
});

test("approved plan completion keeps user review advisory without disabling automatic validation", () => {
  const mutation = {
    id: "mutation",
    kind: "file",
    value: "src/App.tsx",
    target: "src/App.tsx",
    sourceTool: "apply_patch",
    createdAt: 1,
  };
  const ledger = [mutation];
  const { callbacks, events } = createCallbacks({
    getWorkflowMode: () => "plan",
    getIsPlanApproved: () => true,
    getPlanStage: () => "completed",
    getPlanTasks: () => [{
      id: "task-with-review",
      text: "Update the page and let the user review the target interaction",
      status: "pending",
      evidence: [
        { kind: "file", value: "src/App.tsx" },
        { kind: "manual_user_validation", value: "user reviews the target interaction" },
      ],
    }],
    getPlanExecutionEvidenceLedger: () => ledger,
  });
  const result = runApprovedPlanCompletionGuard({
    outcome: { status: "completed", reason: "agent_loop_completed" },
    callbacks,
    sawExecutionEvidence: true,
  });

  assert.deepEqual(result, {
    status: "stopped_no_action",
    reason: "approved_plan_completion_guard",
  });
  assert.equal(events.stops.length, 1);
  assert.equal(
    events.stops[0].progress.recoveryReason,
    "approved_plan_completion_guard_no_evidence",
  );

  const automaticValidation = {
    id: "automatic-validation",
    kind: "cmd",
    value: "npm test",
    target: "npm test",
    sourceTool: "run_command",
    createdAt: 2,
  };
  const validated = createCallbacks({
    getWorkflowMode: () => "plan",
    getIsPlanApproved: () => true,
    getPlanStage: () => "completed",
    getPlanTasks: callbacks.getPlanTasks,
    getPlanExecutionEvidenceLedger: () => [mutation, automaticValidation],
  });
  const validatedResult = runApprovedPlanCompletionGuard({
    outcome: { status: "completed", reason: "agent_loop_completed" },
    callbacks: validated.callbacks,
    sawExecutionEvidence: true,
  });

  assert.equal(validatedResult, null);
  assert.equal(validated.events.stops.length, 0);
});

test("approved plan completion is deferred until the current loop consumes the execution transition", () => {
  const { callbacks, events } = createCallbacks({
    getWorkflowMode: () => "plan",
    getIsPlanApproved: () => true,
    getIsApprovedPlanExecutionTransitionPending: () => true,
  });
  const result = runApprovedPlanCompletionGuard({
    outcome: { status: "completed", reason: "agent_loop_completed" },
    callbacks,
    sawExecutionEvidence: false,
  });

  assert.deepEqual(result, {
    status: "paused",
    reason: "approved_plan_same_turn_execution_pending",
  });
  assert.equal(events.stops.length, 0);
  assert.equal(events.statuses.length, 0);
});

test("approved plan recovery without a pending approval transition still runs the evidence guard", () => {
  const { callbacks, events } = createCallbacks({
    getWorkflowMode: () => "plan",
    getIsPlanApproved: () => true,
    getIsApprovedPlanExecutionTransitionPending: () => false,
  });
  const result = runApprovedPlanCompletionGuard({
    outcome: { status: "completed", reason: "agent_loop_completed" },
    callbacks,
    sawExecutionEvidence: false,
  });

  assert.deepEqual(result, {
    status: "stopped_no_action",
    reason: "approved_plan_completion_guard",
  });
  assert.equal(events.stops.length, 1);
});

test("agent loop runner preserves awaiting-choice pauses as a structured outcome", async () => {
  const logs = [];
  const finals = [];
  class AwaitingChoiceOrchestrator {
    async execute(callbacks) {
      callbacks.onAssistantFinalText(
        "Choose a path",
        [{ id: "continue", label: "Continue", value: "continue" }],
        { awaitingInput: true },
      );
    }

    getLatestTurnContract() {
      return {
        conversationIntent: "respond",
        runtimeIntent: "respond",
        approvalState: "not_required",
        mutationExpected: false,
        completionEvidenceRequired: "none",
      };
    }

    hasExecuteOperationEvidence() {
      return false;
    }
  }
  const { executeAgentLoop } = loadAgentLoopRunnerWithFake(
    AwaitingChoiceOrchestrator,
    logs,
  );
  const outcome = await executeAgentLoop({
    getWorkflowMode: () => "chat",
    getIsPlanApproved: () => false,
    onAssistantFinalText: (...args) => finals.push(args),
    onNonActionableStop: () => {},
    onError: () => {},
  }, new AbortController());

  assert.deepEqual(outcome, {
    status: "paused",
    reason: "awaiting_user_choice",
  });
  assert.equal(finals.length, 1);
  assert.deepEqual(logs, [{
    event: "agent_loop_awaiting_user_choice",
    data: { replyOptions: 1 },
  }]);
});

test("subagent runner strips reply options and preserves the evidence summary", async () => {
  const finals = [];
  const terminalCommits = [];
  class SubagentChoiceOrchestrator {
    async execute(callbacks) {
      callbacks.onAssistantFinalText(
        "Useful evidence summary",
        [{ id: "approve", label: "Approve", value: "approve" }],
        { awaitingInput: true },
      );
    }

    getLatestTurnContract() {
      return {
        conversationIntent: "respond",
        runtimeIntent: "analyze",
        approvalState: "not_required",
        mutationExpected: false,
        completionEvidenceRequired: "none",
      };
    }

    hasExecuteOperationEvidence() {
      return false;
    }

    hasPendingTurnCompletion() {
      return true;
    }

    commitPendingTurnCompletion() {
      terminalCommits.push("commit");
      return true;
    }

    discardPendingTurnCompletion() {
      terminalCommits.push("discard");
      return true;
    }

  }
  const { executeAgentLoop } = loadAgentLoopRunnerWithFake(SubagentChoiceOrchestrator, []);
  const outcome = await executeAgentLoop({
    getSubagentDepth: () => 1,
    getWorkflowMode: () => "chat",
    getIsPlanApproved: () => false,
    onAssistantFinalText: (...args) => finals.push(args),
    onNonActionableStop: () => {},
    onError: () => {},
  }, new AbortController());

  assert.deepEqual(outcome, { status: "completed", reason: "agent_loop_completed" });
  assert.equal(finals[0][0], "Useful evidence summary");
  assert.deepEqual(finals[0][1], []);
  assert.equal(finals[0][2].awaitingInput, false);
  assert.deepEqual(terminalCommits, ["commit"]);
});

test("agent loop runner never defaults an uncommitted return to completed", async () => {
  class MissingTerminalOrchestrator {
    async execute() {}

    getLatestTurnContract() {
      return {
        conversationIntent: "respond",
        runtimeIntent: "respond",
        approvalState: "not_required",
        mutationExpected: false,
        completionEvidenceRequired: "none",
      };
    }

    hasExecuteOperationEvidence() {
      return false;
    }
  }
  const logs = [];
  const stops = [];
  const statuses = [];
  const { executeAgentLoop } = loadAgentLoopRunnerWithFake(MissingTerminalOrchestrator, logs);
  const outcome = await executeAgentLoop({
    getPreferredLanguage: () => "en",
    getWorkflowMode: () => "chat",
    getIsPlanApproved: () => false,
    onAssistantFinalText: () => {},
    onNonActionableStop: (message, reason, progress) => stops.push({ message, reason, progress }),
    onStatusChange: (status) => statuses.push(status),
    onError: () => {},
  }, new AbortController());

  assert.deepEqual(outcome, {
    status: "stopped_no_action",
    reason: "agent_loop_no_terminal_outcome",
  });
  assert.equal(stops[0].progress.recoveryReason, "agent_loop_no_terminal_outcome");
  assert.deepEqual(statuses, ["idle"]);
  assert.equal(logs.some((entry) => entry.event === "agent_loop_missing_terminal_outcome"), true);
});

test("completion guards discard staged completion instead of publishing a false success", async () => {
  const terminalCommits = [];
  class GuardedCompletionOrchestrator {
    async execute() {}

    hasPendingTurnCompletion() {
      return true;
    }

    commitPendingTurnCompletion() {
      terminalCommits.push("commit");
      return true;
    }

    discardPendingTurnCompletion() {
      terminalCommits.push("discard");
      return true;
    }

    pauseActiveRun(reason) {
      terminalCommits.push(`pause:${reason}`);
      return true;
    }

    getLatestTurnContract() {
      return {
        conversationIntent: "execute",
        runtimeIntent: "execute",
        approvalState: "approved",
        mutationExpected: true,
        completionEvidenceRequired: "execution_evidence",
      };
    }

    hasExecuteOperationEvidence() {
      return false;
    }
  }
  const { executeAgentLoop } = loadAgentLoopRunnerWithFake(GuardedCompletionOrchestrator, []);
  const { callbacks } = createCallbacks({
    getWorkflowMode: () => "edit",
  });
  const outcome = await executeAgentLoop({
    ...callbacks,
    onAssistantFinalText: () => {},
    onError: () => {},
  }, new AbortController());

  assert.equal(outcome.status, "stopped_no_action");
  assert.deepEqual(terminalCommits, [
    "discard",
    "pause:execution_evidence_required",
  ]);
});

test("agent loop runner preserves a bounded error reason for Goal Runtime diagnostics", async () => {
  class FailingOrchestrator {
    async execute(callbacks) {
      callbacks.onError("STREAM_NO_VISIBLE_PROGRESS_TIMEOUT: model stream stalled");
    }

    getLatestTurnContract() {
      return {
        conversationIntent: "execute",
        runtimeIntent: "goal",
        approvalState: "approved",
        mutationExpected: true,
        completionEvidenceRequired: "execution_evidence",
      };
    }

    hasExecuteOperationEvidence() {
      return false;
    }
  }
  const { executeAgentLoop } = loadAgentLoopRunnerWithFake(FailingOrchestrator, []);
  const errors = [];
  const outcome = await executeAgentLoop({
    getWorkflowMode: () => "edit",
    getIsPlanApproved: () => false,
    onAssistantFinalText: () => {},
    onNonActionableStop: () => {},
    onError: (error) => errors.push(error),
  }, new AbortController());

  assert.deepEqual(outcome, {
    status: "error",
    reason: "agent_loop_error: STREAM_NO_VISIBLE_PROGRESS_TIMEOUT: model stream stalled",
  });
  assert.deepEqual(errors, ["STREAM_NO_VISIBLE_PROGRESS_TIMEOUT: model stream stalled"]);
});

test("a run.paused boundary cannot fall through as agent_loop_completed", async () => {
  class ReviewPausedOrchestrator {
    async execute() {}

    getLatestRunPauseReason() {
      return "plan_review_required";
    }

    getLatestTurnContract() {
      return {
        conversationIntent: "plan",
        runtimeIntent: "plan",
        approvalState: "required",
        mutationExpected: false,
        completionEvidenceRequired: "none",
      };
    }

    hasExecuteOperationEvidence() {
      return false;
    }
  }
  const { executeAgentLoop } = loadAgentLoopRunnerWithFake(ReviewPausedOrchestrator, []);
  const outcome = await executeAgentLoop({
    getWorkflowMode: () => "plan",
    getIsPlanApproved: () => false,
    onAssistantFinalText: () => {},
    onNonActionableStop: () => {},
    onError: () => {},
  }, new AbortController());

  assert.deepEqual(outcome, {
    status: "paused",
    reason: "plan_review_required",
  });
});

test("a start-hook block is a resumable pause, never an implicit completion", async () => {
  class StartHookBlockedOrchestrator {
    async execute() {}

    getLatestRunPauseReason() {
      return "start_hook_blocked";
    }

    getLatestTurnContract() {
      return {
        conversationIntent: "execute",
        runtimeIntent: "execute",
        approvalState: "approved",
        mutationExpected: true,
        completionEvidenceRequired: "execution_evidence",
      };
    }

    hasExecuteOperationEvidence() {
      return false;
    }
  }
  const { executeAgentLoop } = loadAgentLoopRunnerWithFake(StartHookBlockedOrchestrator, []);
  const outcome = await executeAgentLoop({
    getWorkflowMode: () => "edit",
    getIsPlanApproved: () => false,
    onAssistantFinalText: () => {},
    onNonActionableStop: () => {},
    onError: () => {},
  }, new AbortController());

  assert.deepEqual(outcome, {
    status: "paused",
    reason: "start_hook_blocked",
  });
});

test("agent loop runner returns aborted before completion guards read final state", async () => {
  class AbortingOrchestrator {
    async execute(_callbacks, abortController) {
      abortController.abort();
    }

    getLatestTurnContract() {
      throw new Error("completion guards must not run after abort");
    }

    hasExecuteOperationEvidence() {
      throw new Error("completion guards must not run after abort");
    }
  }
  const { executeAgentLoop } = loadAgentLoopRunnerWithFake(
    AbortingOrchestrator,
    [],
  );
  const outcome = await executeAgentLoop({
    onAssistantFinalText: () => {},
    onNonActionableStop: () => {},
    onError: () => {},
  }, new AbortController());

  assert.deepEqual(outcome, {
    status: "aborted",
    reason: "agent_loop_aborted",
  });
});
