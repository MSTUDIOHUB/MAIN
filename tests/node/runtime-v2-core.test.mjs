import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";

const workspaceRoot = process.cwd();
const cache = new Map();

function loadTs(sourcePath) {
  const normalized = path.resolve(sourcePath);
  if (cache.has(normalized)) return cache.get(normalized);
  const source = fs.readFileSync(normalized, "utf8");
  const localRequire = createRequire(normalized);
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
    fileName: normalized,
  }).outputText;
  const module = { exports: {} };
  cache.set(normalized, module.exports);
  const runtimeRequire = (specifier) => {
    if (specifier.startsWith(".")) {
      const base = path.resolve(path.dirname(normalized), specifier);
      for (const candidate of [
        base,
        `${base}.ts`,
        path.join(base, "index.ts"),
      ]) {
        if (fs.existsSync(candidate) && candidate.endsWith(".ts")) {
          return loadTs(candidate);
        }
      }
    }
    return localRequire(specifier);
  };
  new Function("exports", "module", "require", output)(
    module.exports,
    module,
    runtimeRequire,
  );
  cache.set(normalized, module.exports);
  return module.exports;
}

const runtime = loadTs(
  path.join(workspaceRoot, "src/lib/runtime-v2/index.ts"),
);

const baseTurn = {
  workspaceKey: "/fixture",
  sessionKey: "session-a",
  sessionEpoch: "epoch-a",
  clientSubmissionId: "submission-a",
  turnId: "turn-a",
};

const baseRun = {
  sessionKey: "session-a",
  sessionEpoch: "epoch-a",
  turnId: "turn-a",
  runId: "run-a",
  parentRunId: null,
  attemptId: "attempt-a",
};

let eventCounter = 0;
function event(state, type, fields = {}) {
  return {
    schemaVersion: runtime.RUNTIME_V2_EVENT_SCHEMA_VERSION,
    sequence: state ? state.nextSequence : 0,
    eventId: `minimal-event-${++eventCounter}`,
    at: state ? state.updatedAt + 1 : 1,
    type,
    ...fields,
  };
}

function executeAggregate(phase = "observing") {
  let state = runtime.transition(null, event(null, "turn.admitted", {
    turn: baseTurn,
    strategy: "execute",
    objective: "Repair the fixture behavior",
    constraints: [],
    acceptanceCriteria: ["The repaired behavior works"],
    acceptanceCriterionIds: ["criterion-user-objective"],
    acceptanceEvidenceRequirements: ["behavioral"],
  }));
  state = runtime.transition(state, event(state, "run.started", {
    run: baseRun,
    phase,
  }));
  return state;
}

function commandFor(state, kind, key, payload = {}) {
  return {
    idempotencyKey: key,
    kind,
    run: baseRun,
    phase: state.phase,
    payload: {
      actionFingerprint: `${kind}:${key}`,
      attempt: 1,
      ...payload,
    },
  };
}

function schedule(state, command) {
  return runtime.transition(state, event(state, "command.scheduled", {
    run: baseRun,
    command,
  }));
}

function providerResult(state, result) {
  const command = runtime.decideNextCommands(state)[0];
  assert.equal(command.kind, "request_model");
  state = schedule(state, command);
  return runtime.transition(state, event(state, "provider.responded", {
    run: baseRun,
    idempotencyKey: command.idempotencyKey,
    result: {
      visibleText: result.visibleText || "",
      toolCalls: result.toolCalls || [],
      diagnostics: [],
    },
  }));
}

function executePendingTool(state, completion) {
  const command = runtime.decideNextCommands(state)[0];
  assert.ok(
    command.kind === "execute_tool" ||
      command.kind === "execute_validation",
  );
  state = schedule(state, command);
  return runtime.transition(state, event(state, completion.type, {
    run: baseRun,
    idempotencyKey: command.idempotencyKey,
    ...completion,
  }));
}

test("minimal Execute loops through inspect, edit, behavioral validation, and conclusion", () => {
  let state = executeAggregate();
  let next = runtime.decideNextCommands(state, {
    subagentPreference: "preferred",
  })[0];
  assert.equal(next.kind, "request_model");
  assert.equal(next.payload.mode, "execute");
  assert.equal(next.payload.toolExpectation, "required");

  state = providerResult(state, {
    toolCalls: [{
      id: "read-main",
      name: "read_file",
      arguments: { path: "src/main.js" },
    }],
  });
  state = executePendingTool(state, {
    type: "tool.completed",
    status: "succeeded",
    evidence: [{
      id: "source-main-v1",
      kind: "source",
      target: "src/main.js",
      version: "sha-main-v1",
    }],
  });

  state = providerResult(state, {
    toolCalls: [{
      id: "patch-main",
      name: "apply_patch",
      arguments: {
        patch:
          "*** Begin Patch\n*** Update File: src/main.js\n@@\n-old\n+new\n*** End Patch",
      },
    }],
  });
  assert.deepEqual(runtime.decideRuntimeV2ExecutePhaseTransition(state, {
    isMutationToolName: (name) => name === "apply_patch",
  }), {
    from: "observing",
    to: "acting",
    reason: "pending_mutation_call",
  });
  state = runtime.transition(state, event(state, "phase.changed", {
    run: baseRun,
    phase: "acting",
    reason: "pending mutation",
  }));
  state = executePendingTool(state, {
    type: "tool.completed",
    status: "succeeded",
    evidence: [{
      id: "mutation-main-v2",
      kind: "mutation",
      target: "src/main.js",
      version: "sha-main-v2",
    }],
    presentation: {
      toolName: "apply_patch",
      target: "src/main.js",
    },
  });
  assert.deepEqual(runtime.decideRuntimeV2ExecutePhaseTransition(state, {
    isMutationToolName: (name) => name === "apply_patch",
  }), {
    from: "acting",
    to: "validating",
    reason: "mutation_committed",
  });
  state = runtime.transition(state, event(state, "phase.changed", {
    run: baseRun,
    phase: "validating",
    reason: "mutation committed",
  }));
  next = runtime.decideNextCommands(state)[0];
  assert.equal(next.kind, "request_model");
  assert.equal(next.payload.mode, "validate");

  state = providerResult(state, {
    toolCalls: [{
      id: "test-main",
      name: "run_command",
      arguments: { command: "npm test", cwd: "." },
    }],
  });
  state = executePendingTool(state, {
    type: "validation.completed",
    passed: true,
    evidence: [{
      id: "validation-main-v2",
      kind: "validation",
      target: "npm test",
      version: "test-pass-v1",
    }],
    presentation: {
      toolName: "run_command",
      target: "npm test",
    },
  });
  assert.equal(runtime.runtimeV2DirectExecuteReadyForConclusion(state), true);

  next = runtime.decideNextCommands(state)[0];
  assert.equal(next.kind, "request_model");
  assert.equal(next.payload.mode, "conclude");
  state = schedule(state, next);
  state = runtime.transition(state, event(state, "provider.responded", {
    run: baseRun,
    idempotencyKey: next.idempotencyKey,
    result: {
      visibleText: "Updated src/main.js and verified the repaired behavior.",
      toolCalls: [],
      diagnostics: [],
    },
  }));
  const evidence = runtime.summarizeRuntimeV2ExecuteEvidence(state, {
    isMutationToolName: (name) => name === "apply_patch",
  });
  assert.deepEqual(runtime.decideRuntimeV2TerminalOutcome(state, {
    canceled: false,
    mutationCount: evidence.mutationCount,
    passedValidationCount: evidence.passedValidationCount,
    hasAcceptanceValidation:
      runtime.runtimeV2DirectExecuteReadyForConclusion(state),
    failedValidationCount: evidence.failedValidationCount,
    stalledValidationCount: evidence.stalledValidationCount,
    hasProviderConclusion: true,
  }), {
    resultKind: "success",
    resultReason:
      "最新工作区效果已由后续有限验证确认，并已生成基于实际证据的完成报告。",
  });
});

test("a third identical same-version read is rejected without ending the Turn", () => {
  let state = executeAggregate();
  for (const id of ["read-main-1", "read-main-2"]) {
    state = providerResult(state, {
      toolCalls: [{
        id,
        name: "read_file",
        arguments: {
          path: "src/main.js",
          start_line: 180,
          end_line: 250,
        },
      }],
    });
    state = executePendingTool(state, {
      type: "tool.completed",
      status: "succeeded",
      evidence: [{
        id: `${id}-evidence`,
        kind: "source",
        target: "src/main.js",
        version: "sha-main-v1",
      }],
    });
  }

  state = providerResult(state, {
    toolCalls: [{
      id: "read-main-3",
      name: "read_file",
      arguments: {
        path: "src/main.js",
        start_line: 180,
        end_line: 250,
      },
    }],
  });
  const next = runtime.decideNextCommands(state)[0];

  assert.equal(next.kind, "execute_tool");
  assert.equal(next.payload.repeatedActionRejected, true);
  assert.equal(
    next.payload.repeatedActionReason,
    "unchanged_source_repeat",
  );
  assert.equal(state.terminalOutcome, null);
});

test("a third identical successful search is rejected without hiding other reads", () => {
  let state = executeAggregate();
  for (const id of ["grep-save-1", "grep-save-2"]) {
    state = providerResult(state, {
      toolCalls: [{
        id,
        name: "grep_search",
        arguments: {
          path: "src",
          query: "handleSaveFile",
        },
      }],
    });
    state = executePendingTool(state, {
      type: "tool.completed",
      status: "succeeded",
      evidence: [{
        id: `${id}-evidence`,
        kind: "source",
        target: "src",
        version: "sha-search-v1",
      }],
    });
  }

  state = providerResult(state, {
    toolCalls: [{
      id: "grep-save-3",
      name: "grep_search",
      arguments: {
        path: "src",
        query: "handleSaveFile",
      },
    }],
  });
  const next = runtime.decideNextCommands(state)[0];

  assert.equal(next.kind, "execute_tool");
  assert.equal(next.payload.repeatedActionRejected, true);
  assert.equal(
    next.payload.repeatedActionReason,
    "unchanged_observation_repeat",
  );
  assert.equal(state.terminalOutcome, null);
});

test("a third identical no-progress validator is rejected without ending the Turn", () => {
  let state = executeAggregate();
  for (const id of ["build-1", "build-2"]) {
    state = providerResult(state, {
      toolCalls: [{
        id,
        name: "run_command",
        arguments: {
          command: "npm run build",
        },
      }],
    });
    state = executePendingTool(state, {
      type: "validation.completed",
      passed: false,
      failureKind: "assertion_failed",
      evidence: [{
        id: `${id}-evidence`,
        kind: "validation",
        target: "npm run build",
        version: "build-does-not-cover-behavior",
      }],
    });
  }

  state = providerResult(state, {
    toolCalls: [{
      id: "build-3",
      name: "run_command",
      arguments: {
        command: "npm run build",
      },
    }],
  });
  const next = runtime.decideNextCommands(state)[0];

  assert.equal(next.kind, "execute_validation");
  assert.equal(next.payload.repeatedActionRejected, true);
  assert.equal(
    next.payload.repeatedActionReason,
    "repeated_validation",
  );
  assert.equal(state.terminalOutcome, null);
});

test("a committed mutation reopens an exact validator at the new source boundary", () => {
  let state = executeAggregate();
  for (const id of ["build-before-edit-1", "build-before-edit-2"]) {
    state = providerResult(state, {
      toolCalls: [{
        id,
        name: "run_command",
        arguments: { command: "npm run build" },
      }],
    });
    state = executePendingTool(state, {
      type: "validation.completed",
      passed: false,
      failureKind: "assertion_failed",
      evidence: [],
    });
  }

  state = providerResult(state, {
    toolCalls: [{
      id: "repair-after-build",
      name: "apply_patch",
      arguments: { patch: "fixture" },
    }],
  });
  state = executePendingTool(state, {
    type: "tool.completed",
    status: "succeeded",
    evidence: [{
      id: "repair-after-build-evidence",
      kind: "mutation",
      target: "src/main.js",
      version: "sha-main-v2",
    }],
  });
  state = providerResult(state, {
    toolCalls: [{
      id: "build-after-edit",
      name: "run_command",
      arguments: { command: "npm run build" },
    }],
  });

  const next = runtime.decideNextCommands(state)[0];
  assert.equal(next.kind, "execute_validation");
  assert.notEqual(next.payload.repeatedActionRejected, true);
});

function aggregateWithValidation(command, passed = true) {
  let state = executeAggregate("acting");
  const mutation = commandFor(state, "execute_tool", "mutation", {
    toolCallId: "mutation-call",
    toolName: "apply_patch",
    arguments: { patch: "fixture" },
  });
  state = schedule(state, mutation);
  state = runtime.transition(state, event(state, "tool.completed", {
    run: baseRun,
    idempotencyKey: mutation.idempotencyKey,
    status: "succeeded",
    evidence: [{
      id: "mutation-evidence",
      kind: "mutation",
      target: "src/main.js",
      version: "v2",
    }],
  }));
  state = runtime.transition(state, event(state, "phase.changed", {
    run: baseRun,
    phase: "validating",
    reason: "mutation committed",
  }));
  const validation = commandFor(
    state,
    "execute_validation",
    "validation",
    {
      toolCallId: "validation-call",
      toolName: "run_command",
      arguments: { command, cwd: "." },
    },
  );
  state = schedule(state, validation);
  return runtime.transition(state, event(state, "validation.completed", {
    run: baseRun,
    idempotencyKey: validation.idempotencyKey,
    passed,
    evidence: [{
      id: "validation-evidence",
      kind: "validation",
      target: command,
      version: passed ? "passed" : "failed",
    }],
    presentation: { toolName: "run_command", target: command },
    ...(!passed ? { failureKind: "assertion_failed" } : {}),
  }));
}

test("a static build cannot prove a behavioral Execute objective", () => {
  const state = aggregateWithValidation("npm run build");
  assert.equal(runtime.runtimeV2DirectExecuteReadyForConclusion(state), false);
  assert.equal(runtime.decideRuntimeV2TerminalOutcome(state, {
    canceled: false,
    mutationCount: 1,
    passedValidationCount: 1,
    hasAcceptanceValidation: false,
    failedValidationCount: 0,
    stalledValidationCount: 0,
    hasProviderConclusion: true,
  }), null);
});

test("failed acceptance remains loop evidence and returns validation to acting", () => {
  const state = aggregateWithValidation("npm test", false);
  assert.equal(runtime.runtimeV2DirectExecuteReadyForConclusion(state), false);
  assert.deepEqual(runtime.decideRuntimeV2ExecutePhaseTransition(state, {
    isMutationToolName: (name) => name === "apply_patch",
  }), {
    from: "validating",
    to: "acting",
    reason: "validation_failed",
  });
});

function approvedTwoTargetPlanAggregate() {
  const sealed = runtime.sealWorkPlanV1({
    draft: {
      schemaVersion: runtime.WORK_PLAN_V1_SCHEMA_VERSION,
      objective: "Repair two related files",
      summary: "Apply both reviewed changes.",
      findings: [],
      steps: [{
        title: "Repair main",
        operation: "modify",
        targets: ["src/main.js"],
        basis: ["E-main"],
        change: "Repair main.",
        expectedOutcome: "Main is repaired.",
        dependsOn: [],
      }, {
        title: "Repair editor",
        operation: "modify",
        targets: ["src/editor.js"],
        basis: ["E-editor"],
        change: "Repair editor.",
        expectedOutcome: "Editor is repaired.",
        dependsOn: [0],
      }],
      validations: [{
        stepIndexes: [0, 1],
        kind: "finite_command",
        command: "npm test",
        cwd: ".",
        expectedOutcome: "Tests pass.",
        required: true,
      }],
      risks: [],
      assumptions: [],
      blockingQuestions: [],
    },
    evidence: [{
      id: "E-main",
      target: "src/main.js",
      version: "main-reviewed",
      statement: "Reviewed main.",
    }, {
      id: "E-editor",
      target: "src/editor.js",
      version: "editor-reviewed",
      statement: "Reviewed editor.",
    }],
    id: "WP-two-targets",
    revision: 1,
    createdAt: 20,
  });
  return {
    ...executeAggregate("acting"),
    strategy: "plan",
    workPlan: {
      id: sealed.id,
      revision: sealed.revision,
      digest: sealed.digest,
      projectionHash: sealed.projectionHash,
      status: "approved",
    },
    sealedWorkPlan: sealed,
  };
}

function commitMutation(state, key, target) {
  const command = commandFor(state, "execute_tool", key, {
    toolCallId: `${key}-call`,
    toolName: "apply_patch",
    arguments: { patch: target },
  });
  state = schedule(state, command);
  return runtime.transition(state, event(state, "tool.completed", {
    run: baseRun,
    idempotencyKey: command.idempotencyKey,
    status: "succeeded",
    evidence: [{
      id: `${key}-evidence`,
      kind: "mutation",
      target,
      version: "changed",
    }],
  }));
}

test("approved WorkPlan keeps sealed multi-target and validation authority", () => {
  const classifier = {
    isMutationToolName: (name) => name === "apply_patch",
  };
  let state = approvedTwoTargetPlanAggregate();
  state = commitMutation(state, "main-mutation", "src/main.js");
  assert.equal(
    runtime.decideRuntimeV2ExecutePhaseTransition(state, classifier),
    null,
  );
  state = commitMutation(state, "editor-mutation", "src/editor.js");
  assert.deepEqual(
    runtime.decideRuntimeV2ExecutePhaseTransition(state, classifier),
    {
      from: "acting",
      to: "validating",
      reason: "mutation_committed",
    },
  );
  assert.equal(runtime.resolveRuntimeV2PlanValidationScope({
    plan: state.sealedWorkPlan,
    toolName: "run_command",
    args: { command: "npm test", cwd: "." },
  }).allowed, true);
  assert.equal(runtime.resolveRuntimeV2PlanValidationScope({
    plan: state.sealedWorkPlan,
    toolName: "run_command",
    args: { command: "npm run build", cwd: "." },
  }).allowed, false);
});

test("preferred collaboration is optional and a failed child triggers parent takeover", () => {
  let state = executeAggregate();
  let next = runtime.decideNextCommands(state, {
    subagentPreference: "preferred",
  })[0];
  assert.equal(next.kind, "request_model");

  const failedJob = {
    id: "child-failed",
    run: { ...baseRun, runId: "child-run", parentRunId: baseRun.runId },
    parentRunId: baseRun.runId,
    scopeKey: "review-main",
    objective: "Review main.",
    allowedPaths: ["src/main.js"],
    status: "failed",
    requestedAt: 2,
    firstTokenAt: 3,
    closedAt: 4,
    summary: "Child transport failed.",
    report: null,
  };
  state = {
    ...state,
    subagents: [failedJob],
    events: [...state.events, {
      ...event(state, "subagent.completed", {
        run: baseRun,
        jobId: failedJob.id,
        status: "failed",
        summary: failedJob.summary,
        evidence: [],
      }),
    }],
  };
  next = runtime.decideNextCommands(state, {
    subagentPreference: "preferred",
  })[0];
  assert.equal(next.kind, "request_model");
  assert.equal(next.payload.collaborationAction, "parent_takeover_required");
  assert.equal(next.payload.remainingSubagentCapacity, 0);
});

test("a child with evidence but no report degrades to parent takeover instead of failing", () => {
  let state = executeAggregate();
  const child = {
    id: "child-degraded",
    run: { ...baseRun, runId: "child-degraded-run", parentRunId: baseRun.runId },
    parentRunId: baseRun.runId,
    scopeKey: "review-main",
    taskKind: "review",
    objective: "Review main.",
    allowedPaths: ["src/main.js"],
    status: "queued",
    requestedAt: state.updatedAt + 1,
    firstTokenAt: null,
    closedAt: null,
    summary: null,
    report: null,
  };
  state = runtime.transition(state, event(state, "subagents.scheduled", {
    run: baseRun,
    jobs: [child],
  }));
  state = runtime.transition(state, event(state, "subagent.telemetry", {
    run: baseRun,
    telemetry: {
      jobId: child.id,
      phase: "request_opened",
      at: state.updatedAt + 1,
    },
  }));
  state = runtime.transition(state, event(state, "subagent.telemetry", {
    run: baseRun,
    telemetry: {
      jobId: child.id,
      phase: "closed",
      at: state.updatedAt + 1,
    },
  }));
  state = runtime.transition(state, event(state, "subagent.completed", {
    run: baseRun,
    jobId: child.id,
    status: "degraded",
    summary: "Evidence was preserved; the parent must finish the review.",
    evidence: [{
      id: "child-degraded-evidence",
      kind: "subagent",
      target: "src/main.js",
      version: "sha-main",
    }],
  }));

  assert.equal(state.subagents[0].status, "degraded");
  const next = runtime.decideNextCommands(state, {
    subagentPreference: "preferred",
  })[0];
  assert.equal(next.kind, "request_model");
  assert.equal(next.payload.collaborationAction, "parent_takeover_required");
  assert.equal(next.payload.failedSubagents[0].id, "review-main");
});

test("only provider transport exhaustion can terminate recovery", () => {
  const state = executeAggregate();
  const command = commandFor(state, "execute_tool", "read-failed", {
    toolName: "read_file",
    arguments: { path: "src/main.js" },
  });
  const action = runtime.decideRuntimeV2CommandFailureRecovery({
    aggregate: state,
    command,
    error: new Error("read failed"),
  });
  assert.notEqual(action.kind, "exhaust");

  const provider = commandFor(state, "request_model", "provider-failed", {
    mode: "execute",
  });
  let recovery = state.recovery;
  const fingerprint =
    `transport:${runtime.runtimeV2ActionFingerprint(provider)}`;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    recovery = runtime.recordRuntimeV2Recovery({
      budget: recovery,
      scope: "transport",
      fingerprint,
      at: state.updatedAt + attempt,
    });
  }
  const exhausted = runtime.decideRuntimeV2CommandFailureRecovery({
    aggregate: { ...state, recovery },
    command: provider,
    error: new Error("provider unavailable"),
  });
  assert.equal(exhausted.kind, "exhaust");
  assert.equal(exhausted.scope, "transport");
});

test("action fingerprints stay fixed-size regardless of tool payload size", () => {
  const small = runtime.runtimeV2ActionFingerprint(commandFor(
    executeAggregate(),
    "execute_tool",
    "small-fingerprint",
    {
      toolName: "replace_in_file",
      arguments: {
        path: "src/main.js",
        search_text: "old",
        replace_text: "new",
      },
    },
  ));
  const large = runtime.runtimeV2ActionFingerprint(commandFor(
    executeAggregate(),
    "execute_tool",
    "large-fingerprint",
    {
      toolName: "replace_in_file",
      arguments: {
        path: "src/main.js",
        search_text: "old".repeat(100_000),
        replace_text: "new".repeat(100_000),
      },
    },
  ));

  assert.match(small, /^runtime-v2-action-sha256-[0-9a-f]{64}$/);
  assert.match(large, /^runtime-v2-action-sha256-[0-9a-f]{64}$/);
  assert.equal(small.length, large.length);
  assert.notEqual(small, large);
});

test("persisted Runtime v2 checkpoints contain one canonical event ledger", () => {
  const aggregate = executeAggregate();
  const checkpoint = runtime.createRuntimeV2Checkpoint({
    revision: 2,
    aggregate,
    updatedAt: aggregate.updatedAt,
  });
  const persisted = runtime.serializeRuntimeV2CheckpointMap({
    [baseTurn.turnId]: checkpoint,
  });
  const encoded = JSON.stringify(persisted);
  const envelope = persisted[baseTurn.turnId];

  assert.equal(envelope.schemaVersion, "turn-runtime-checkpoint.v5");
  assert.equal(Object.hasOwn(envelope, "aggregate"), false);
  assert.equal(Object.hasOwn(envelope, "scheduledCommands"), false);
  assert.equal(envelope.events.length, aggregate.events.length);
  assert.ok(encoded.length < JSON.stringify({
    [baseTurn.turnId]: checkpoint,
  }).length);

  const restored = runtime.normalizeRuntimeV2CheckpointMap(persisted, baseTurn);
  assert.deepEqual(
    restored[baseTurn.turnId].aggregate.events,
    aggregate.events,
  );
});

test("one thousand bounded events persist and replay below the checkpoint size budget", () => {
  let aggregate = executeAggregate();
  for (let index = 0; index < 998; index += 1) {
    const projection = {
      id: `stress-projection-${index}`,
      audience: "timeline",
      markdown: `Bounded progress ${index}`,
      kind: "timeline",
      dedupeKey: `stress-${index}`,
    };
    aggregate = runtime.transition(
      aggregate,
      event(aggregate, "projection.published", {
        run: baseRun,
        audience: projection.audience,
        projectionId: projection.id,
        projection,
      }),
    );
  }
  const persisted = runtime.serializeRuntimeV2CheckpointMap({
    [baseTurn.turnId]: runtime.createRuntimeV2Checkpoint({
      revision: aggregate.events.length,
      aggregate,
      updatedAt: aggregate.updatedAt,
    }),
  });
  const encoded = JSON.stringify(persisted);
  const restored = runtime.normalizeRuntimeV2CheckpointMap(
    JSON.parse(encoded),
    baseTurn,
  );

  assert.equal(persisted[baseTurn.turnId].events.length, 1_000);
  assert.ok(encoded.length < 2_000_000, `encoded checkpoint was ${encoded.length} chars`);
  assert.equal(restored[baseTurn.turnId].aggregate.events.length, 1_000);
});
