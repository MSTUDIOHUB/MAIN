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

test("native automatic transport omits the optional tool_choice field", () => {
  const attempt = runtime.selectNextProviderTransportAttempt({
    schemaVersion: "provider-lane.v1",
    nativeTools: true,
    requiredToolChoice: false,
    streaming: true,
    textToolEnvelope: true,
    reasoning: true,
    imageInput: false,
    toolResultRole: "tool",
  }, {
    actionKey: "execute",
    attempted: [],
  });

  assert.equal(attempt.variant, "native_auto");
  assert.equal(attempt.toolChoice, null);
});

test("provider normalization accepts explicit compatibility tool markers only", () => {
  const explicit = runtime.normalizeProviderResponseV1({
    content: [
      "<|tool_call>call:replace_in_file{",
      "target: 'src/main.js',",
      "old_content: 'const before = true;',",
      "new_content: 'const after = true;'",
      "}",
    ].join("\n"),
    toolCalls: [],
  });
  assert.equal(explicit.toolCalls.length, 1);
  assert.equal(explicit.toolCalls[0].name, "replace_in_file");
  assert.deepEqual(explicit.toolCalls[0].arguments, {
    target: "src/main.js",
    old_content: "const before = true;",
    new_content: "const after = true;",
  });

  const prose = runtime.normalizeProviderResponseV1({
    content:
      "I would call replace_in_file on src/main.js after reviewing it.",
    toolCalls: [],
  });
  assert.deepEqual(prose.toolCalls, []);
});

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

function executeAggregate(
  phase = "observing",
  acceptanceEvidenceRequirements = ["behavioral"],
) {
  let state = runtime.transition(null, event(null, "turn.admitted", {
    turn: baseTurn,
    strategy: "execute",
    objective: "Repair the fixture behavior",
    constraints: [],
    acceptanceCriteria: ["The repaired behavior works"],
    acceptanceCriterionIds: ["criterion-user-objective"],
    ...(acceptanceEvidenceRequirements
      ? { acceptanceEvidenceRequirements }
      : {}),
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
      diagnostics: result.diagnostics || [],
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
  const authority = command.payload.validationAuthority;
  const validationBoundary =
    completion.type === "validation.completed" && authority
      ? runtime.deriveRuntimeV2ValidationBoundary(
          state,
          authority.targetPaths,
        )
      : null;
  return runtime.transition(state, event(state, completion.type, {
    run: baseRun,
    idempotencyKey: command.idempotencyKey,
    ...(authority ? { authority } : {}),
    ...(validationBoundary || {}),
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
  assert.equal(
    next.payload.toolExpectation,
    undefined,
    "an unfinished Execute may choose the next safe action without a Runtime-forced tool",
  );

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
  assert.equal(next.payload.toolExpectation, undefined);

  state = providerResult(state, {
    toolCalls: [{
      id: "test-main",
      name: "run_command",
      arguments: {
        command: "npm test",
        cwd: ".",
      },
    }],
  });
  const linkedValidation = runtime.decideNextCommands(state)[0];
  assert.equal(
    linkedValidation.payload.validationAuthority?.kind,
    "direct_execute",
  );
  assert.deepEqual(
    linkedValidation.payload.validationAuthority?.criterionIds,
    ["criterion-user-objective"],
  );
  assert.deepEqual(
    linkedValidation.payload.validationAuthority?.targetPaths,
    ["src/main.js"],
  );
  assert.equal(
    Object.hasOwn(linkedValidation.payload.arguments, "criterion_ids"),
    false,
    "runtime-owned linkage must not be forwarded to the tool executor",
  );
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
  assert.equal(next.payload.toolExpectation, undefined);
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

test("run_command becomes validation only when its command is a finite validator", () => {
  let setupState = executeAggregate();
  setupState = providerResult(setupState, {
    toolCalls: [{
      id: "install-dependencies",
      name: "run_command",
      arguments: {
        command: "npm install 2>&1 | tail -5",
      },
    }],
  });
  assert.equal(
    runtime.decideNextCommands(setupState)[0].kind,
    "execute_tool",
    "environment setup is an ordinary effect, not acceptance evidence",
  );
  assert.equal(
    runtime.decideRuntimeV2ExecutePhaseTransition(setupState, {
      isMutationToolName: (name) => name === "apply_patch",
    }),
    null,
  );

  let validationState = executeAggregate();
  validationState = providerResult(validationState, {
    toolCalls: [{
      id: "run-tests",
      name: "run_command",
      arguments: { command: "npm test" },
    }],
  });
  assert.equal(
    runtime.decideNextCommands(validationState)[0].kind,
    "execute_validation",
  );
  assert.deepEqual(
    runtime.decideRuntimeV2ExecutePhaseTransition(validationState, {
      isMutationToolName: (name) => name === "apply_patch",
    }),
    {
      from: "observing",
      to: "validating",
      reason: "pending_validation_call",
    },
  );
  validationState = runtime.transition(
    validationState,
    event(validationState, "phase.changed", {
      run: baseRun,
      phase: "validating",
      reason: "finite validation requested",
    }),
  );
  assert.equal(validationState.phase, "validating");
});

test("repeated same-version reads remain executable and rely on soft strategy pressure", () => {
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
  assert.equal(state.terminalOutcome, null);
});

test("repeated successful searches remain executable and rely on soft strategy pressure", () => {
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
  assert.equal(state.terminalOutcome, null);
});

test("repeated validators remain executable until evidence or an explicit hard boundary resolves the Turn", () => {
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
});

function aggregateWithValidation(
  command,
  passed = true,
  acceptanceEvidenceRequirements = ["behavioral"],
) {
  let state = executeAggregate(
    "acting",
    acceptanceEvidenceRequirements,
  );
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
      validationAuthority:
        runtime.resolveRuntimeV2DirectExecuteValidationAuthority({
          aggregate: state,
          turnId: baseTurn.turnId,
          objective: state.objective,
          validationId: "validation-call",
        }),
    },
  );
  const validationAuthority = validation.payload.validationAuthority;
  assert.ok(validationAuthority);
  state = schedule(state, validation);
  const validationBoundary = runtime.deriveRuntimeV2ValidationBoundary(
    state,
    validationAuthority.targetPaths,
  );
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
    authority: validationAuthority,
    ...validationBoundary,
    ...(!passed ? { failureKind: "assertion_failed" } : {}),
  }));
}

test("a static build cannot prove a behavioral Execute objective", () => {
  const state = aggregateWithValidation("npm run build");
  assert.equal(runtime.runtimeV2DirectExecuteReadyForConclusion(state), false);
  assert.deepEqual(runtime.decideRuntimeV2TerminalOutcome(state, {
    canceled: false,
    mutationCount: 1,
    passedValidationCount: 1,
    hasAcceptanceValidation: false,
    failedValidationCount: 0,
    stalledValidationCount: 0,
    hasProviderConclusion: true,
  }), {
    resultKind: "partial",
    resultReason:
      "模型已结束本轮，但最新修改尚未获得与用户目标匹配的完整验收证据。",
  });
});

test("an unclassified direct Execute criterion accepts a finite static check", () => {
  const state = aggregateWithValidation("npm run build", true, null);
  assert.equal(runtime.runtimeV2DirectExecuteReadyForConclusion(state), true);
});

test("a final-boundary behavioral validation can satisfy the runtime-owned scope", () => {
  const state = aggregateWithValidation("npm test");
  assert.equal(runtime.runtimeV2DirectExecuteReadyForConclusion(state), true);
});

test("a provider cannot omit direct Execute criteria or mutation targets", () => {
  let state = runtime.transition(null, event(null, "turn.admitted", {
    turn: baseTurn,
    strategy: "execute",
    objective: "Repair both independently accepted behaviors",
    constraints: [],
    acceptanceCriteria: [
      "The main behavior works",
      "The toolbar behavior works",
    ],
    acceptanceCriterionIds: ["criterion-main", "criterion-toolbar"],
    acceptanceEvidenceRequirements: ["behavioral", "behavioral"],
  }));
  state = runtime.transition(state, event(state, "run.started", {
    run: baseRun,
    phase: "acting",
  }));
  const mutation = commandFor(state, "execute_tool", "two-target-mutation", {
    toolCallId: "two-target-mutation-call",
    toolName: "apply_patch",
    arguments: { patch: "fixture" },
  });
  state = schedule(state, mutation);
  state = runtime.transition(state, event(state, "tool.completed", {
    run: baseRun,
    idempotencyKey: mutation.idempotencyKey,
    status: "succeeded",
    evidence: [{
      id: "mutation-main",
      kind: "mutation",
      target: "src/main.js",
      version: "main-v2",
    }, {
      id: "mutation-toolbar",
      kind: "mutation",
      target: "src/toolbar.js",
      version: "toolbar-v2",
    }],
  }));
  state = runtime.transition(state, event(state, "phase.changed", {
    run: baseRun,
    phase: "validating",
    reason: "mutation committed",
  }));
  state = providerResult(state, {
    toolCalls: [{
      id: "provider-selected-validation",
      name: "run_command",
      arguments: {
        command: "npm test",
        cwd: ".",
        criterion_ids: "criterion-main",
        target_paths: "src/main.js",
      },
    }],
  });
  const validation = runtime.decideNextCommands(state)[0];
  const validationAuthority = validation.payload.validationAuthority;
  assert.equal(validation.kind, "execute_validation");
  assert.deepEqual(validationAuthority?.criterionIds, [
    "criterion-main",
    "criterion-toolbar",
  ]);
  assert.deepEqual(validationAuthority?.targetPaths, [
    "src/main.js",
    "src/toolbar.js",
  ]);
  assert.equal(
    Object.hasOwn(validation.payload.arguments, "criterion_ids"),
    false,
  );
  assert.equal(
    Object.hasOwn(validation.payload.arguments, "target_paths"),
    false,
  );
  state = executePendingTool(state, {
    type: "validation.completed",
    passed: true,
    evidence: [{
      id: "validation-all",
      kind: "validation",
      target: "npm test",
      version: "passed",
    }],
    presentation: { toolName: "run_command", target: "npm test" },
  });

  assert.equal(
    runtime.runtimeV2DirectExecuteReadyForConclusion(state),
    true,
  );
});

test("a tool-free Execute conclusion ends truthfully without a mutation", () => {
  const state = executeAggregate();
  assert.deepEqual(runtime.decideRuntimeV2TerminalOutcome(state, {
    canceled: false,
    mutationCount: 0,
    passedValidationCount: 0,
    hasAcceptanceValidation: false,
    failedValidationCount: 0,
    stalledValidationCount: 0,
    hasProviderConclusion: true,
  }), {
    resultKind: "error",
    resultReason:
      "模型已结束本轮，但没有形成可验收的实际修改。",
  });
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

test("a rejected corrective mutation returns to an earlier unvalidated mutation boundary", () => {
  const classifier = {
    isMutationToolName: (name) => name === "apply_patch",
  };
  let state = executeAggregate("acting");
  state = commitMutation(state, "initial-mutation", "src/main.js");
  state = runtime.transition(state, event(state, "phase.changed", {
    run: baseRun,
    phase: "validating",
    reason: "initial mutation awaits validation",
  }));

  state = providerResult(state, {
    toolCalls: [{
      id: "rejected-correction-call",
      name: "apply_patch",
      arguments: { patch: "src/toolbar.js" },
    }],
  });
  assert.deepEqual(
    runtime.decideRuntimeV2ExecutePhaseTransition(state, classifier),
    {
      from: "validating",
      to: "acting",
      reason: "pending_mutation_call",
    },
  );
  state = runtime.transition(state, event(state, "phase.changed", {
    run: baseRun,
    phase: "acting",
    reason: "corrective mutation requested",
  }));
  state = executePendingTool(state, {
    type: "tool.completed",
    status: "failed",
    evidence: [],
    failureKind: "mutation_rejected",
  });

  assert.deepEqual(
    runtime.decideRuntimeV2ExecutePhaseTransition(state, classifier),
    {
      from: "acting",
      to: "validating",
      reason: "mutation_committed",
    },
  );
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

test("a tool-free Execute report truthfully closes an incomplete approved WorkPlan", () => {
  let state = approvedTwoTargetPlanAggregate();
  state = commitMutation(state, "main-only-mutation", "src/main.js");
  state = providerResult(state, {
    visibleText:
      "Updated src/main.js, but the remaining target and required validation are incomplete.",
  });

  assert.equal(
    runtime.latestRuntimeV2ProviderConclusionText(state),
    "Updated src/main.js, but the remaining target and required validation are incomplete.",
  );
  assert.deepEqual(runtime.decideRuntimeV2TerminalOutcome(state, {
    canceled: false,
    mutationCount: 1,
    passedValidationCount: 0,
    hasAcceptanceValidation: false,
    failedValidationCount: 0,
    stalledValidationCount: 0,
    hasProviderConclusion: true,
  }), {
    resultKind: "partial",
    resultReason:
      "模型已结束本轮；已保留实际修改，但已批准 WorkPlan 尚未完整闭环。未覆盖修改目标：src/editor.js。 未通过必需验证：work-plan-validation-1。",
  });
});

test("a duplicate-action adapter diagnostic is not a provider conclusion", () => {
  let state = approvedTwoTargetPlanAggregate();
  state = providerResult(state, {
    visibleText: "This text belongs to a rejected duplicate.",
    diagnostics: [{
      code: "repeated_action_rejected",
      message: "already_completed:run_command:opaque",
      retryable: true,
    }],
  });

  assert.equal(runtime.latestRuntimeV2ProviderConclusionText(state), "");
});

test("preferred collaboration remains available after a failed child", () => {
  let state = executeAggregate();
  let next = runtime.decideNextCommands(state, {
    subagentPreference: "preferred",
    subagentCapacity: 2,
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
    subagentCapacity: 2,
  })[0];
  assert.equal(next.kind, "request_model");
  assert.equal(next.payload.collaborationAction, "optional");
  assert.equal(next.payload.remainingSubagentCapacity, 2);
  assert.equal(next.payload.failedSubagents[0].id, "review-main");
});

test("a child with evidence but no report degrades without disabling later delegation", () => {
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
    maxActiveSubagents: 2,
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
    subagentCapacity: 2,
  })[0];
  assert.equal(next.kind, "request_model");
  assert.equal(next.payload.collaborationAction, "optional");
  assert.equal(next.payload.remainingSubagentCapacity, 2);
  assert.equal(next.payload.failedSubagents[0].id, "review-main");

  state = runtime.transition(state, event(
    state,
    "subagent.handoff_delivered",
    {
      run: baseRun,
      jobId: child.id,
      contextEntryId: `child:${child.id}`,
      evidenceIds: ["child-degraded-evidence"],
    },
  ));
  const noReferenceCommand = commandFor(
    state,
    "request_model",
    "provider-without-child-reference",
    { mode: "execute" },
  );
  state = schedule(state, noReferenceCommand);
  const noReferenceResponse = event(state, "provider.responded", {
    run: baseRun,
    idempotencyKey: noReferenceCommand.idempotencyKey,
    result: {
      visibleText: "Continue from the parent source evidence.",
      toolCalls: [],
      diagnostics: [],
    },
  });
  state = runtime.transition(state, noReferenceResponse);
  const ungroundedApplication = runtime.tryTransition(
    state,
    event(state, "subagent.handoff_applied", {
      run: baseRun,
      jobId: child.id,
      evidenceIds: ["child-degraded-evidence"],
      sourceEventId: noReferenceResponse.eventId,
      source: "provider_result",
    }),
  );
  assert.equal(ungroundedApplication.disposition, "rejected");
  assert.equal(ungroundedApplication.reason, "subagent_handoff_invalid");

  const referencingCommand = commandFor(
    state,
    "request_model",
    "provider-with-child-reference",
    { mode: "execute" },
  );
  state = schedule(state, referencingCommand);
  const referencingResponse = event(state, "provider.responded", {
    run: baseRun,
    idempotencyKey: referencingCommand.idempotencyKey,
    result: {
      visibleText:
        "Use child-degraded-evidence as the source for this parent decision.",
      toolCalls: [],
      diagnostics: [],
    },
  });
  state = runtime.transition(state, referencingResponse);
  state = runtime.transition(state, event(
    state,
    "subagent.handoff_applied",
    {
      run: baseRun,
      jobId: child.id,
      evidenceIds: ["child-degraded-evidence"],
      sourceEventId: referencingResponse.eventId,
      source: "provider_result",
    },
  ));
  assert.equal(
    state.events.filter((candidate) =>
      candidate.type === "subagent.handoff_delivered"
    ).length,
    1,
  );
  assert.equal(
    state.events.filter((candidate) =>
      candidate.type === "subagent.handoff_applied"
    ).length,
    1,
  );
  const duplicateApplication = runtime.tryTransition(
    state,
    event(state, "subagent.handoff_applied", {
      run: baseRun,
      jobId: child.id,
      evidenceIds: ["child-degraded-evidence"],
      sourceEventId: referencingResponse.eventId,
      source: "provider_result",
    }),
  );
  assert.equal(duplicateApplication.disposition, "rejected");
  assert.equal(duplicateApplication.reason, "subagent_handoff_invalid");
});

test("the controller records adoption only from a later durable parent provider reference", async () => {
  let aggregate = executeAggregate();
  const child = {
    id: "child-controller-review",
    run: {
      ...baseRun,
      runId: "child-controller-run",
      parentRunId: baseRun.runId,
    },
    parentRunId: baseRun.runId,
    scopeKey: "controller-review",
    taskKind: "review",
    objective: "Review controller behavior.",
    allowedPaths: ["src/main.js"],
    status: "queued",
    requestedAt: aggregate.updatedAt + 1,
    firstTokenAt: null,
    closedAt: null,
    summary: null,
    report: null,
  };
  aggregate = runtime.transition(aggregate, event(
    aggregate,
    "subagents.scheduled",
    { run: baseRun, maxActiveSubagents: 2, jobs: [child] },
  ));
  aggregate = runtime.transition(aggregate, event(
    aggregate,
    "subagent.telemetry",
    {
      run: baseRun,
      telemetry: {
        jobId: child.id,
        phase: "request_opened",
        at: aggregate.updatedAt + 1,
      },
    },
  ));
  aggregate = runtime.transition(aggregate, event(
    aggregate,
    "subagent.telemetry",
    {
      run: baseRun,
      telemetry: {
        jobId: child.id,
        phase: "closed",
        at: aggregate.updatedAt + 1,
      },
    },
  ));
  aggregate = runtime.transition(aggregate, event(
    aggregate,
    "subagent.completed",
    {
      run: baseRun,
      jobId: child.id,
      status: "degraded",
      summary: "One child evidence item is ready for parent review.",
      evidence: [{
        id: "child-controller-evidence",
        kind: "subagent",
        target: "src/main.js",
        version: "sha-controller",
      }],
    },
  ));
  aggregate = runtime.transition(aggregate, event(
    aggregate,
    "subagent.handoff_delivered",
    {
      run: baseRun,
      jobId: child.id,
      contextEntryId: `child:${child.id}`,
      evidenceIds: ["child-controller-evidence"],
    },
  ));

  let checkpoint = runtime.createRuntimeV2Checkpoint({
    revision: 7,
    aggregate,
    updatedAt: aggregate.updatedAt,
  });
  let clock = aggregate.updatedAt;
  let id = 0;
  const controller = new runtime.RuntimeV2Controller({
    checkpoint: {
      async load() {
        return checkpoint;
      },
      async append(input) {
        const appended = runtime.appendRuntimeV2Checkpoint({
          checkpoint,
          owner: input.owner,
          expectedRevision: input.expectedRevision,
          event: input.event,
        });
        if (appended.checkpoint) checkpoint = appended.checkpoint;
        return appended;
      },
    },
    provider: {
      async request() {
        return {
          visibleText:
            "Use child-controller-evidence to choose the next parent read.",
          commentary: "",
          toolCalls: [{
            id: "read-after-child",
            name: "read_file",
            arguments: { path: "src/main.js" },
          }],
          usage: {},
          diagnostics: [],
        };
      },
    },
    tool: {
      async execute() {
        throw new Error("tool execution is outside this one-step test");
      },
    },
    scheduler: {
      async execute() {
        throw new Error("child scheduling is outside this one-step test");
      },
    },
    projection: {
      async publish() {},
    },
    clockId: {
      now: () => ++clock,
      nextId: (scope) => `${scope}-${++id}`,
      nextIdempotencyKey: ({ kind }) => `${kind}-${++id}`,
    },
  }, {
    aggregate,
    revision: checkpoint.revision,
  });

  assert.equal(await controller.driveOnce(), true);
  const applied = controller.snapshot().aggregate.events.filter((candidate) =>
    candidate.type === "subagent.handoff_applied"
  );
  assert.equal(applied.length, 1);
  assert.deepEqual(applied[0].evidenceIds, ["child-controller-evidence"]);
  assert.equal(applied[0].source, "provider_result");
});

test("the controller propagates a scheduling conflict before the command is durable", async () => {
  const aggregate = executeAggregate();
  const checkpoint = runtime.createRuntimeV2Checkpoint({
    revision: 9,
    aggregate,
    updatedAt: aggregate.updatedAt,
  });
  let clock = aggregate.updatedAt;
  let id = 0;
  let providerRequests = 0;
  let appendsAfterConflict = 0;
  const controller = new runtime.RuntimeV2Controller({
    checkpoint: {
      async load() {
        return checkpoint;
      },
      async append(input) {
        if (input.event.type === "command.scheduled") {
          return { disposition: "conflict", checkpoint: null };
        }
        appendsAfterConflict += 1;
        return runtime.appendRuntimeV2Checkpoint({
          checkpoint,
          owner: input.owner,
          expectedRevision: input.expectedRevision,
          event: input.event,
        });
      },
    },
    provider: {
      async request() {
        providerRequests += 1;
        throw new Error("provider must not run before durable scheduling");
      },
    },
    tool: {
      async execute() {
        throw new Error("tool must not run before durable scheduling");
      },
    },
    scheduler: {
      async execute() {
        throw new Error("scheduler must not run before durable scheduling");
      },
    },
    projection: {
      async publish() {},
    },
    clockId: {
      now: () => ++clock,
      nextId: (scope) => `${scope}-${++id}`,
      nextIdempotencyKey: ({ kind }) => `${kind}-${++id}`,
    },
  }, {
    aggregate,
    revision: checkpoint.revision,
  });

  await assert.rejects(
    () => controller.driveOnce(),
    /checkpoint ownership or revision conflict/,
  );
  assert.equal(providerRequests, 0);
  assert.equal(
    appendsAfterConflict,
    0,
    "an unscheduled command cannot manufacture recovery or projection events",
  );
  assert.equal(controller.snapshot().aggregate.events.length, aggregate.events.length);
});

test("transient command failures never create a recovery-count terminal", () => {
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
  const saturated = runtime.decideRuntimeV2CommandFailureRecovery({
    aggregate: { ...state, recovery },
    command: provider,
    error: new Error("RUNTIME_V2_EXECUTION_PROVIDER_REQUEST_TIMEOUT"),
  });
  assert.equal(saturated.kind, "continue");
  assert.equal(saturated.publish, true);
  assert.equal(
    runtime.decideNextCommands({ ...state, recovery })[0].kind,
    "request_model",
    "a retry counter cannot own terminal timing",
  );
});

test("an adapter-confirmed provider transport boundary is a hard stop without a retry counter", () => {
  const state = executeAggregate();
  const provider = commandFor(state, "request_model", "provider-unavailable", {
    mode: "execute",
  });
  const decision = runtime.decideRuntimeV2CommandFailureRecovery({
    aggregate: state,
    command: provider,
    error: new runtime.RuntimeV2ProviderTransportsUnavailableError(),
  });
  assert.deepEqual(decision, {
    kind: "hard_stop",
    scope: "transport",
    fingerprint:
      `transport:${runtime.runtimeV2ActionFingerprint(provider)}`,
    reason: "provider_transports_unavailable",
    publish: true,
  });
});

test("the shared lifecycle deadline is a boundary, not a transport recovery", async () => {
  const aggregate = executeAggregate();
  let checkpoint = runtime.createRuntimeV2Checkpoint({
    revision: aggregate.events.length,
    aggregate,
    updatedAt: aggregate.updatedAt,
  });
  let clock = aggregate.updatedAt;
  let id = 0;
  const controller = new runtime.RuntimeV2Controller({
    checkpoint: {
      async load() {
        return checkpoint;
      },
      async append(input) {
        const appended = runtime.appendRuntimeV2Checkpoint({
          checkpoint,
          owner: input.owner,
          expectedRevision: input.expectedRevision,
          event: input.event,
        });
        if (appended.checkpoint) checkpoint = appended.checkpoint;
        return appended;
      },
    },
    provider: {
      async request() {
        throw new runtime.RuntimeV2LifecycleDeadlineError();
      },
    },
    tool: {
      async execute() {
        throw new Error("tool execution is outside this deadline test");
      },
    },
    scheduler: {
      async execute() {
        throw new Error("child scheduling is outside this deadline test");
      },
    },
    projection: {
      async publish() {},
    },
    clockId: {
      now: () => ++clock,
      nextId: (scope) => `${scope}-${++id}`,
      nextIdempotencyKey: ({ kind }) => `${kind}-${++id}`,
    },
  }, {
    aggregate,
    revision: checkpoint.revision,
  });

  assert.equal(await controller.driveOnce(), true);
  const after = controller.snapshot().aggregate;
  const completion = after.events.findLast((candidate) =>
    candidate.type === "command.completed"
  );
  assert.equal(completion.status, "canceled");
  assert.equal(
    after.events.some((candidate) =>
      candidate.type === "recovery.recorded" ||
      candidate.type === "recovery.exhausted"
    ),
    false,
  );
  assert.equal(
    runtime.summarizeRuntimeV2ExecuteEvidence(after, {
      isMutationToolName: (name) => name === "apply_patch",
    }).failedProviderRequestCount,
    0,
  );
});

test("presentation counts repeated source receipts as one evidence fact without rewriting the ledger", () => {
  let state = executeAggregate();
  for (const [id, target, version] of [
    ["source-main-first", "src/main.js", "sha-main"],
    ["source-main-repeat", "src/main.js", "sha-main"],
    ["source-toolbar", "src/toolbar.js", "sha-toolbar"],
  ]) {
    state = runtime.transition(state, event(state, "observation.recorded", {
      run: baseRun,
      evidence: {
        id,
        kind: "source",
        target,
        version,
      },
    }));
  }

  assert.equal(state.evidence.length, 3);
  assert.equal(runtime.countDistinctRuntimeV2EvidenceFacts(state.evidence), 2);
  const finalProjection = runtime.buildRuntimeV2FinalProjection(
    state,
    "final-evidence-count",
    "error",
    "lifecycle deadline",
  );
  assert.match(finalProjection.markdown, /已保留 2 条证据/);
  assert.doesNotMatch(finalProjection.markdown, /已保留 3 条证据/);
  assert.equal(runtime.countDistinctRuntimeV2EvidenceFacts([
    {
      id: "grep-first",
      kind: "tool",
      target: "src",
      version: null,
    },
    {
      id: "grep-second",
      kind: "tool",
      target: "src",
      version: null,
    },
    {
      id: "source-unversioned-first",
      kind: "source",
      target: "workspace",
      version: null,
    },
    {
      id: "source-unversioned-second",
      kind: "source",
      target: "workspace",
      version: null,
    },
  ]), 4);
});

test("nullish provider rejections stay on the recoverable request path", () => {
  const state = executeAggregate();
  const provider = commandFor(state, "request_model", "provider-nullish", {
    mode: "execute",
  });
  for (const rejection of [null, undefined]) {
    const failure = runtime.runtimeV2ProviderAttemptFailure(rejection);
    assert.equal(
      runtime.isRuntimeV2ProviderTransportsUnavailableError(failure),
      false,
    );
    const decision = runtime.decideRuntimeV2CommandFailureRecovery({
      aggregate: state,
      command: provider,
      error: failure,
    });
    assert.equal(decision.kind, "record");
    assert.equal(decision.scope, "transport");
  }
});

test("failed provider requests stay durable on the shared request path", () => {
  let state = executeAggregate();
  const first = runtime.decideNextCommands(state)[0];
  assert.equal(first.kind, "request_model");
  state = schedule(state, first);
  state = runtime.transition(state, event(state, "command.completed", {
    run: baseRun,
    idempotencyKey: first.idempotencyKey,
    status: "failed",
  }));

  const second = runtime.decideNextCommands(state)[0];
  assert.equal(second.kind, "request_model");
  assert.equal(
    second.payload.actionFingerprint,
    first.payload.actionFingerprint,
    "a failed provider attempt does not change the semantic request identity",
  );

  state = schedule(state, second);
  state = runtime.transition(state, event(state, "command.completed", {
    run: baseRun,
    idempotencyKey: second.idempotencyKey,
    status: "failed",
  }));
  const third = runtime.decideNextCommands(state)[0];
  assert.equal(
    third.payload.actionFingerprint,
    first.payload.actionFingerprint,
  );
  assert.equal(
    runtime.summarizeRuntimeV2ExecuteEvidence(state, {
      isMutationToolName: (name) => name === "apply_patch",
    }).failedProviderRequestCount,
    2,
  );

  state = runtime.transition(state, event(state, "observation.recorded", {
    run: baseRun,
    evidence: {
      id: "source-after-pivot",
      kind: "source",
      target: "src/main.js",
      version: "sha-after-pivot",
    },
  }));
  const afterProgress = runtime.decideNextCommands(state)[0];
  assert.equal(afterProgress.kind, "request_model");
});

test("provider request identity and diagnostics survive the 256 receipt window", () => {
  let state = executeAggregate();
  let latest = null;
  for (let attempt = 1; attempt <= 257; attempt += 1) {
    const command = runtime.decideNextCommands(state)[0];
    assert.equal(command.kind, "request_model");
    assert.equal(command.payload.attempt, attempt);
    if (latest) assert.notEqual(command.idempotencyKey, latest.idempotencyKey);
    latest = command;
    state = schedule(state, command);
    state = runtime.transition(state, event(state, "command.completed", {
      run: baseRun,
      idempotencyKey: command.idempotencyKey,
      status: "failed",
    }));
  }

  assert.equal(state.completedCommands.length, 256);
  const next = runtime.decideNextCommands(state)[0];
  assert.equal(next.kind, "request_model");
  assert.equal(next.payload.attempt, 258);
  assert.notEqual(next.idempotencyKey, latest.idempotencyKey);
  assert.equal(
    runtime.summarizeRuntimeV2ExecuteEvidence(state, {
      isMutationToolName: (name) => name === "apply_patch",
    }).failedProviderRequestCount,
    257,
  );
});

test("new source reads preserve effect pressure until a mutation commits", () => {
  let state = executeAggregate();
  state = providerResult(state, {
    toolCalls: [{
      id: "read-main-for-effect",
      name: "read_file",
      arguments: { path: "src/main.js" },
    }],
  });
  state = executePendingTool(state, {
    type: "tool.completed",
    status: "succeeded",
    evidence: [{
      id: "source-main-for-effect",
      kind: "source",
      target: "src/main.js",
      version: "sha-main-for-effect",
    }],
  });

  const afterFirstSource = runtime.decideNextCommands(state)[0];
  assert.deepEqual(afterFirstSource.payload.effectPressure, {
    schemaVersion: "runtime-v2-effect-pressure.v1",
    reason: "source_only_frontier",
    mutationBoundarySequence: 0,
    sourceBoundarySequence: state.events.at(-1).sequence,
    latestSourceEvidenceId: "source-main-for-effect",
  });

  state = providerResult(state, {
    toolCalls: [{
      id: "read-toolbar-for-effect",
      name: "read_file",
      arguments: { path: "src/components/toolbar.js" },
    }],
  });
  state = executePendingTool(state, {
    type: "tool.completed",
    status: "succeeded",
    evidence: [{
      id: "source-toolbar-for-effect",
      kind: "source",
      target: "src/components/toolbar.js",
      version: "sha-toolbar-for-effect",
    }],
  });

  const afterSecondSource = runtime.decideNextCommands(state)[0];
  assert.equal(
    afterSecondSource.payload.effectPressure.reason,
    "source_only_frontier",
  );
  assert.equal(
    afterSecondSource.payload.effectPressure.latestSourceEvidenceId,
    "source-toolbar-for-effect",
  );
  assert.equal(
    runtime.runtimeV2ActionFingerprint({
      ...afterFirstSource,
      payload: {
        ...afterFirstSource.payload,
        effectPressure: afterSecondSource.payload.effectPressure,
      },
    }),
    afterFirstSource.payload.actionFingerprint,
    "effect pressure changes request guidance without changing action identity",
  );

  state = providerResult(state, {
    toolCalls: [{
      id: "patch-main-for-effect",
      name: "apply_patch",
      arguments: {
        patch:
          "*** Begin Patch\n*** Update File: src/main.js\n@@\n-old\n+new\n*** End Patch",
      },
    }],
  });
  state = executePendingTool(state, {
    type: "tool.completed",
    status: "succeeded",
    evidence: [{
      id: "mutation-main-for-effect",
      kind: "mutation",
      target: "src/main.js",
      version: "sha-main-after-effect",
    }],
  });

  assert.equal(runtime.deriveRuntimeV2EffectPressure(state), null);
});

test("a cached source receipt closes the tool pair without creating evidence or recovery state", () => {
  let state = executeAggregate();
  const failedRequest = runtime.decideNextCommands(state)[0];
  state = schedule(state, failedRequest);
  state = runtime.transition(state, event(state, "command.completed", {
    run: baseRun,
    idempotencyKey: failedRequest.idempotencyKey,
    status: "failed",
  }));

  state = providerResult(state, {
    toolCalls: [{
      id: "replay-main",
      name: "read_file",
      arguments: { path: "src/main.js" },
    }],
  });
  state = executePendingTool(state, {
    type: "tool.completed",
    status: "succeeded",
    receiptOrigin: "replayed",
    evidence: [],
  });

  const next = runtime.decideNextCommands(state)[0];
  assert.equal(next.kind, "request_model");
  assert.equal(state.evidence.length, 0);
});

test("1000 unchanged safe-read replays coalesce to one non-terminal soft signal per mutation boundary", () => {
  let state = executeAggregate();
  state = providerResult(state, {
    toolCalls: [{
      id: "replay-main-stress",
      name: "read_file",
      arguments: { path: "src/main.js" },
    }],
  });
  state = executePendingTool(state, {
    type: "tool.completed",
    status: "succeeded",
    receiptOrigin: "replayed",
    evidence: [],
  });

  let recordedRepeatCount = 0;
  for (let replay = 0; replay < 1_000; replay += 1) {
    const shouldRecord = runtime.shouldRecordRuntimeV2SoftSignal({
      aggregate: state,
      signal: "repeat",
    });
    if (!shouldRecord) continue;
    recordedRepeatCount += 1;
    state = runtime.transition(state, event(state, "soft_signal.observed", {
      run: baseRun,
      signal: "repeat",
    }));
  }

  assert.equal(recordedRepeatCount, 1);
  assert.equal(
    state.events.filter((candidate) =>
      candidate.type === "soft_signal.observed" &&
      candidate.signal === "repeat"
    ).length,
    1,
  );
  const next = runtime.decideNextCommands(state)[0];
  assert.equal(next.kind, "request_model");
  assert.equal(state.terminalOutcome, null);
  assert.equal(
    state.events.some((candidate) =>
      candidate.type === "run.completed" ||
      candidate.type === "turn.completed"
    ),
    false,
  );

  state = providerResult(state, {
    toolCalls: [{
      id: "mutation-after-replay-pressure",
      name: "apply_patch",
      arguments: {
        patch:
          "*** Begin Patch\n*** Update File: src/main.js\n@@\n-old\n+new\n*** End Patch",
      },
    }],
  });
  state = executePendingTool(state, {
    type: "tool.completed",
    status: "succeeded",
    evidence: [{
      id: "mutation-after-replay-pressure",
      kind: "mutation",
      target: "src/main.js",
      version: "sha-main-after-replay-pressure",
    }],
  });
  assert.equal(
    runtime.shouldRecordRuntimeV2SoftSignal({
      aggregate: state,
      signal: "repeat",
    }),
    true,
    "a committed mutation opens a new read/modify/verify boundary",
  );
  state = runtime.transition(state, event(state, "soft_signal.observed", {
    run: baseRun,
    signal: "repeat",
  }));
  assert.equal(
    runtime.shouldRecordRuntimeV2SoftSignal({
      aggregate: state,
      signal: "repeat",
    }),
    false,
  );
  assert.equal(state.terminalOutcome, null);
});

test("an unchanged source replay keeps one soft repeat signal until progress", () => {
  let state = executeAggregate();
  const recordRepeatIfNeeded = () => {
    assert.equal(
      runtime.shouldRecordRuntimeV2SoftSignal({
        aggregate: state,
        signal: "repeat",
      }),
      state.events.every((candidate) =>
        candidate.type !== "soft_signal.observed" ||
        candidate.signal !== "repeat"
      ),
    );
    if (
      runtime.shouldRecordRuntimeV2SoftSignal({
        aggregate: state,
        signal: "repeat",
      })
    ) {
      state = runtime.transition(state, event(state, "soft_signal.observed", {
        run: baseRun,
        signal: "repeat",
      }));
    }
  };
  const completeRead = (id) => {
    state = providerResult(state, {
      toolCalls: [{
        id,
        name: "read_file",
        arguments: {
          path: "src/main.js",
          start_line: 220,
          end_line: 350,
          max_lines: 100,
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
  };

  completeRead("read-initial");
  for (let replay = 1; replay <= 2; replay += 1) {
    completeRead(`read-repeat-${replay}`);
    recordRepeatIfNeeded();
    const next = runtime.decideNextCommands(state)[0];
    assert.equal(next.kind, "request_model");
    assert.equal(state.terminalOutcome, null);
  }
});

test("legacy replay pressure remains non-terminal without entering the provider request", () => {
  const state = executeAggregate();
  const legacyReplayEvents = Array.from({ length: 1_000 }, (_, index) => ({
    schemaVersion: runtime.RUNTIME_V2_EVENT_SCHEMA_VERSION,
    sequence: state.nextSequence + index,
    eventId: `legacy-repeat-${index}`,
    at: state.updatedAt + index + 1,
    type: "soft_signal.observed",
    run: baseRun,
    signal: "repeat",
  }));
  const legacyState = {
    ...state,
    events: [...state.events, ...legacyReplayEvents],
  };

  const next = runtime.decideNextCommands(legacyState)[0];
  assert.equal(next.kind, "request_model");
  assert.equal(legacyState.terminalOutcome, null);
});

test("a provider admission rejection stays non-executable and drives soft recovery", () => {
  let state = executeAggregate();
  state = providerResult(state, {
    toolCalls: [],
    diagnostics: [{
      code: "repeated_action_rejected",
      message: "already_rejected:read_file:opaque-action-id",
      retryable: true,
    }],
  });
  const firstRecoveryAt = state.updatedAt;

  let next = runtime.decideNextCommands(state)[0];
  assert.equal(next.kind, "request_model");
  assert.deepEqual(next.payload.recoveryPressure, {
    schemaVersion: "runtime-v2-provider-recovery.v1",
    reason: "repeated_action_rejected",
    occurrence: 1,
    stage: "reconsider",
  });
  assert.equal(state.pendingToolCalls.length, 0);
  assert.equal(state.terminalOutcome, null);

  state = providerResult(state, {
    toolCalls: [],
    diagnostics: [{
      code: "repeated_action_rejected",
      message: "already_rejected:read_file:opaque-action-id",
      retryable: true,
    }],
  });
  next = runtime.decideNextCommands(state)[0];
  assert.deepEqual(next.payload.recoveryPressure, {
    schemaVersion: "runtime-v2-provider-recovery.v1",
    reason: "repeated_action_rejected",
    occurrence: 2,
    stage: "reframe",
  });
  assert.equal(
    runtime.deriveRuntimeV2ProviderRecoveryWindow(state)?.startedAt,
    firstRecoveryAt,
    "the recovery-stall lease must resume from canonical ledger time after an app restart",
  );
  assert.equal(
    runtime.summarizeRuntimeV2ExecuteEvidence(state, {
      isMutationToolName: (name) => name === "apply_patch",
    }).failedProviderRequestCount,
    2,
    "adapter-level non-actionable decisions must be counted even when the HTTP streams succeeded",
  );

  let lease = runtime.advanceRuntimeV2ProviderRecoveryStallLease({
    current: null,
    pressure: next.payload.recoveryPressure,
    now: 1_000,
  });
  assert.equal(lease?.startedAt, 1_000);
  assert.equal(
    runtime.runtimeV2ProviderRecoveryStallExpired(
      lease,
      1_000 + runtime.RUNTIME_V2_PROVIDER_RECOVERY_STALL_MS - 1,
    ),
    false,
  );
  assert.equal(
    runtime.runtimeV2ProviderRecoveryStallExpired(
      lease,
      1_000 + runtime.RUNTIME_V2_PROVIDER_RECOVERY_STALL_MS,
    ),
    true,
  );
  lease = runtime.advanceRuntimeV2ProviderRecoveryStallLease({
    current: lease,
    pressure: null,
    now: 1_000 + runtime.RUNTIME_V2_PROVIDER_RECOVERY_STALL_MS,
  });
  assert.equal(
    lease,
    null,
    "a new actionable decision/evidence boundary clears the stall lease instead of imposing a total task duration",
  );
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

test("emergency terminal envelope is a strict localized whitelist and ignores recursive Store state", () => {
  const envelope = runtime.createRuntimeV2EmergencyTerminalEnvelope({
    owner: baseTurn,
    run: baseRun,
    resultKind: "partial",
    reasonCode: "checkpoint_persist_failed",
    language: "zh",
    at: 1_800_000_000_000,
    lastRevision: 2,
    hasMutation: true,
  });
  const contaminated = {
    ...envelope,
    events: [{ modelText: "must-not-persist" }],
    modelText: "must-not-persist",
  };
  contaminated.store = contaminated;

  const normalized =
    runtime.normalizeRuntimeV2EmergencyTerminalEnvelope(
      contaminated,
      baseTurn,
    );
  assert.ok(normalized);
  assert.deepEqual(Object.keys(normalized).sort(), [
    "at",
    "hasMutation",
    "lastRevision",
    "owner",
    "reason",
    "reasonCode",
    "resultKind",
    "run",
    "schemaVersion",
  ]);
  assert.equal(JSON.stringify(normalized).includes("must-not-persist"), false);
  assert.equal(
    runtime.normalizeRuntimeV2EmergencyTerminalEnvelope({
      ...envelope,
      reason: "{\"backend\":\"raw failure\"}",
    }, baseTurn),
    null,
    "raw backend errors must not become user-visible durable reasons",
  );
});

test("emergency terminal CAS rejects owner or revision drift and seals an exact active run", () => {
  const aggregate = executeAggregate();
  const checkpoint = runtime.createRuntimeV2Checkpoint({
    revision: aggregate.events.length,
    aggregate,
    updatedAt: aggregate.updatedAt,
  });
  const envelope = runtime.createRuntimeV2EmergencyTerminalEnvelope({
    owner: baseTurn,
    run: baseRun,
    resultKind: "error",
    reasonCode: "checkpoint_event_budget_exceeded",
    language: "en",
    at: 1_800_000_000_000,
    lastRevision: checkpoint.revision,
    hasMutation: false,
  });
  const exact = runtime.commitRuntimeV2EmergencyTerminalEnvelope({
    checkpoint,
    currentEnvelope: null,
    owner: baseTurn,
    run: baseRun,
    expectedRevision: checkpoint.revision,
    envelope,
  });
  assert.equal(exact.disposition, "committed");
  assert.equal(
    runtime.commitRuntimeV2EmergencyTerminalEnvelope({
      checkpoint,
      currentEnvelope: envelope,
      owner: baseTurn,
      run: baseRun,
      expectedRevision: checkpoint.revision,
      envelope,
    }).disposition,
    "idempotent",
  );
  assert.equal(
    runtime.commitRuntimeV2EmergencyTerminalEnvelope({
      checkpoint,
      currentEnvelope: null,
      owner: baseTurn,
      run: baseRun,
      expectedRevision: checkpoint.revision + 1,
      envelope,
    }).disposition,
    "conflict",
  );
  assert.equal(
    runtime.commitRuntimeV2EmergencyTerminalEnvelope({
      checkpoint,
      currentEnvelope: null,
      owner: { ...baseTurn, workspaceKey: "/other" },
      run: baseRun,
      expectedRevision: checkpoint.revision,
      envelope,
    }).disposition,
    "conflict",
  );
});

test("checkpoint pressure stays bounded at 2048 events and 8 MiB", () => {
  assert.equal(runtime.MAX_RUNTIME_V2_CHECKPOINT_EVENTS, 2_048);
  assert.equal(runtime.MAX_RUNTIME_V2_CHECKPOINT_CHARS, 8_388_608);
  const aggregate = executeAggregate();
  const overEventBudget = {
    ...aggregate,
    events: Array.from(
      { length: runtime.MAX_RUNTIME_V2_CHECKPOINT_EVENTS + 1 },
      (_, index) => ({
        ...aggregate.events[index % aggregate.events.length],
        eventId: `over-budget-${index}`,
        sequence: index,
      }),
    ),
  };
  assert.throws(
    () => runtime.createRuntimeV2Checkpoint({
      revision: overEventBudget.events.length,
      aggregate: overEventBudget,
      updatedAt: aggregate.updatedAt,
    }),
    (error) =>
      error?.reasonCode === "checkpoint_event_budget_exceeded",
  );

  const checkpoint = runtime.createRuntimeV2Checkpoint({
    revision: aggregate.events.length,
    aggregate,
    updatedAt: aggregate.updatedAt,
  });
  assert.throws(
    () => runtime.assertRuntimeV2CheckpointPersistable({
      ...checkpoint,
      events: [{
        giantUnknownPayload:
          "x".repeat(runtime.MAX_RUNTIME_V2_CHECKPOINT_CHARS + 1_024),
      }],
    }),
    (error) =>
      error?.reasonCode === "checkpoint_size_budget_exceeded",
  );
});

test("terminal v3 and v4 checkpoints remain read-only compatible", () => {
  let aggregate = executeAggregate("finalizing");
  const outcome = {
    resultKind: "error",
    reason: "legacy terminal",
    completedAt: aggregate.updatedAt + 1,
    finalProjectionId: "legacy-final",
  };
  aggregate = runtime.transition(
    aggregate,
    event(aggregate, "run.completed", {
      run: baseRun,
      outcome,
    }),
  );
  aggregate = runtime.transition(
    aggregate,
    event(aggregate, "projection.published", {
      run: baseRun,
      audience: "final",
      projectionId: outcome.finalProjectionId,
      projection: {
        id: outcome.finalProjectionId,
        audience: "final",
        markdown: "legacy terminal",
        kind: "final",
        dedupeKey: "legacy-final",
      },
    }),
  );
  aggregate = runtime.transition(
    aggregate,
    event(aggregate, "turn.completed", {
      turn: baseTurn,
      runId: baseRun.runId,
      outcome,
    }),
  );
  for (const schemaVersion of [
    "turn-runtime-checkpoint.v3",
    "turn-runtime-checkpoint.v4",
  ]) {
    const legacy = {
      schemaVersion,
      engineVersion: runtime.RUNTIME_V2_ENGINE_VERSION,
      revision: aggregate.events.length,
      owner: baseTurn,
      aggregate,
      events: aggregate.events,
      scheduledCommands: aggregate.scheduledCommands,
      aggregateDigest: runtime.runtimeV2AggregateDigest(aggregate),
      updatedAt: aggregate.updatedAt,
    };
    const restored = runtime.normalizeRuntimeV2Checkpoint(
      legacy,
      baseTurn,
    );
    assert.ok(restored, `${schemaVersion} should remain readable`);
    assert.equal(restored.migratedFrom, schemaVersion);
    assert.equal(restored.migrationDisposition, "terminal_read_only");
    assert.equal(restored.aggregate.terminalOutcome.resultKind, "error");
  }
});
