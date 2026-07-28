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
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    fileName: normalized,
  }).outputText;
  const module = { exports: {} };
  cache.set(normalized, module.exports);
  const runtimeRequire = (specifier) => {
    if (specifier.startsWith(".")) {
      const base = path.resolve(path.dirname(normalized), specifier);
      for (const candidate of [base, `${base}.ts`, path.join(base, "index.ts")]) {
        if (fs.existsSync(candidate) && candidate.endsWith(".ts")) return loadTs(candidate);
      }
    }
    return localRequire(specifier);
  };
  new Function("exports", "module", "require", output)(module.exports, module, runtimeRequire);
  cache.set(normalized, module.exports);
  return module.exports;
}

const runtime = loadTs(path.join(workspaceRoot, "src/lib/runtime-v2/index.ts"));
const sourceEvidenceVersion = loadTs(
  path.join(workspaceRoot, "src/store/runtimeV2/sourceEvidenceVersion.ts"),
);
const checkpointAdapter = loadTs(
  path.join(workspaceRoot, "src/store/runtimeV2/checkpointPort.ts"),
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
  const validationBoundary =
    type === "validation.completed" && state && fields.authority
      ? runtime.deriveRuntimeV2ValidationBoundary(
          state,
          fields.authority.targetPaths,
        )
      : {};
  return {
    schemaVersion: runtime.RUNTIME_V2_EVENT_SCHEMA_VERSION,
    sequence: state ? state.nextSequence : 0,
    eventId: `event-${++eventCounter}`,
    at: state ? state.updatedAt + 1 : 1,
    type,
    ...validationBoundary,
    ...fields,
  };
}

function executeAggregate(initialPhase = "observing") {
  let state = runtime.transition(null, event(null, "turn.admitted", {
    turn: baseTurn,
    strategy: "execute",
    objective: "Repair the fixture",
    constraints: [],
    acceptanceCriteria: ["The fixture passes"],
  }));
  return runtime.transition(state, event(state, "run.started", {
    run: baseRun,
    phase: initialPhase,
  }));
}

function withExecutionContract(state, input = {}) {
  const source = input.source || state.evidence.find((item) =>
    item.kind === "source" && item.version
  );
  assert.ok(source, "execution contract fixture requires versioned source");
  const target = input.target || source.target;
  const criterionId =
    state.objective.acceptanceCriterionIds?.[0] || "criterion-1";
  const contract = runtime.compileRuntimeV2ExecutionContract({
    objective: state.objective,
    evidence: state.evidence,
    draft: {
      criteria: [{
        id: criterionId,
        evidence_requirement:
          input.evidenceRequirement || "behavioral",
      }],
      changes: [{
        operation: input.operation || "modify",
        target,
        basis_evidence_ids: [source.id],
      }],
      validations: [{
        id: input.validationId || "validation-1",
        criterion_ids: [criterionId],
        target_paths: [target],
        kind: "finite_command",
        command: input.command || "npm test",
        cwd: ".",
        expected_outcome: "The declared criterion passes.",
      }],
    },
    committedAt: state.updatedAt + 1,
    contractId: "execution-contract-fixture",
  });
  return { ...state, executionContract: contract };
}

function executionValidationAuthority(state, validationId = "validation-1") {
  const validation = state.executionContract.validations.find(
    (candidate) => candidate.id === validationId,
  );
  return runtime.runtimeV2ExecutionValidationAuthority({
    contract: state.executionContract,
    validation,
  });
}

test("Plan and Execute hash exact read_file bytes instead of formatted read windows", async () => {
  const exact = "line 1\nline 2\n";
  const formattedWindow = "1: line 1\n[truncated]";
  const exactVersion = runtime.runtimeV2EvidenceVersion(exact);
  const versionedWindow = [
    "READ_FILE_RESULT",
    "path: src/main.js",
    `contentVersion: ${exactVersion}`,
    "truncated: true",
    "totalLines: 2",
    "totalChars: 14",
    "returnedLines: 1-1",
    "returnedChars: 6",
    "---CONTENT START---",
    "line 1",
    "---CONTENT END---",
  ].join("\n");
  const embeddedVersion = await sourceEvidenceVersion
    .resolveRuntimeV2SourceEvidenceVersion({
      toolName: "read_file",
      args: { path: "src/main.js", start_line: 1, max_lines: 1 },
      output: versionedWindow,
      readExactFile: async () => {
        throw new Error("a window carrying exact contentVersion must not reread");
      },
    });
  assert.equal(embeddedVersion, exactVersion);
  let exactReads = 0;
  const version = await sourceEvidenceVersion.resolveRuntimeV2SourceEvidenceVersion({
    toolName: "read_file",
    args: { path: "src/main.js", start_line: 1, max_lines: 1 },
    output: formattedWindow,
    readExactFile: async () => {
      exactReads += 1;
      return exact;
    },
  });
  assert.equal(version, exactVersion);
  assert.notEqual(version, runtime.runtimeV2EvidenceVersion(formattedWindow));
  assert.equal(exactReads, 1);

  const rawVersion = await sourceEvidenceVersion.resolveRuntimeV2SourceEvidenceVersion({
    toolName: "read_file",
    args: { path: "src/main.js", __raw: true },
    output: exact,
    readExactFile: async () => {
      throw new Error("an already exact read must not be repeated");
    },
  });
  assert.equal(rawVersion, version);
});

function commandFor(state, kind, idempotencyKey, payload = {}) {
  return {
    idempotencyKey,
    kind,
    run: baseRun,
    phase: state.phase,
    payload: {
      actionFingerprint: `${state.phase}:${kind}:${idempotencyKey}`,
      attempt: 1,
      ...payload,
    },
  };
}

function recordProviderResponse(state, idempotencyKey, toolCalls = []) {
  const command = commandFor(state, "request_model", idempotencyKey, { mode: "observe" });
  state = runtime.transition(state, event(state, "command.scheduled", {
    run: baseRun,
    command,
  }));
  return runtime.transition(state, event(state, "provider.responded", {
    run: baseRun,
    idempotencyKey,
    result: { toolCalls, diagnostics: [] },
  }));
}

function recordSuccessfulSourceAction(state, ordinal) {
  const providerKey = `acting-provider-${ordinal}`;
  const providerCommand = commandFor(
    state,
    "request_model",
    providerKey,
    { mode: "execute", toolExpectation: "required" },
  );
  state = runtime.transition(state, event(state, "command.scheduled", {
    run: baseRun,
    command: providerCommand,
  }));
  state = runtime.transition(state, event(state, "provider.responded", {
    run: baseRun,
    idempotencyKey: providerKey,
    result: {
      toolCalls: [{
        id: `read-${ordinal}`,
        name: "read_file",
        arguments: { path: "src/main.js" },
      }],
      diagnostics: [],
    },
  }));
  const [read] = runtime.decideNextCommands(state);
  assert.equal(read.kind, "execute_tool");
  state = runtime.transition(state, event(state, "command.scheduled", {
    run: baseRun,
    command: read,
  }));
  return runtime.transition(state, event(state, "tool.completed", {
    run: baseRun,
    idempotencyKey: read.idempotencyKey,
    status: "succeeded",
    evidence: [{
      id: `source-${ordinal}`,
      kind: "source",
      target: "src/main.js",
      version: "source-v1",
    }],
  }));
}

test("workspace read-only strategy is structurally distinct from Chat", () => {
  let state = runtime.transition(null, event(null, "turn.admitted", {
    turn: baseTurn,
    strategy: "analyze",
    objective: "Explain the workspace implementation",
    constraints: [],
    acceptanceCriteria: [],
  }));
  state = runtime.transition(state, event(state, "run.started", {
    run: baseRun,
    phase: "observing",
  }));

  const [next] = runtime.decideNextCommands(state);
  assert.equal(next.kind, "request_model");
  assert.equal(next.payload.mode, "analyze");
  assert.notEqual(next.payload.mode, "chat");
  assert.equal(next.payload.collaborationAllowed, false);
});

test("Acting narrows the next provider request to mutation after its bounded source-gap pass", () => {
  let state = executeAggregate("acting");
  state = recordSuccessfulSourceAction(state, 1);
  state = recordSuccessfulSourceAction(state, 2);

  const [next] = runtime.decideNextCommands(state);
  assert.equal(next.kind, "request_model");
  assert.equal(next.payload.mode, "execute");
  assert.equal(next.payload.executePolicy, "mutation_required");
  assert.equal(next.payload.toolExpectation, "required");
  assert.equal(state.terminalOutcome, null);
  assert.equal(state.recovery.exhausted, null);
});

test("Acting turns a rejected unchanged read into a required mutation progression", () => {
  let state = executeAggregate("acting");
  state = recordSuccessfulSourceAction(state, 1);
  state = recordSuccessfulSourceAction(state, 2);
  state = runtime.transition(state, event(state, "soft_signal.observed", {
    run: baseRun,
    signal: "repeat",
  }));

  const [next] = runtime.decideNextCommands(state);
  assert.equal(next.payload.executePolicy, "mutation_required");
  assert.equal(next.payload.mutationProgressionRequired, true);
});

test("fresh evidence for an uncovered contract target requires mutation without waiting for a read loop", () => {
  let state = executeAggregate("acting");
  state = runtime.transition(state, event(state, "observation.recorded", {
    run: baseRun,
    evidence: {
      id: "contract-main-source",
      kind: "source",
      target: "src/main.js",
      version: "main-v1",
    },
  }));
  state = withExecutionContract(state);
  state = recordSuccessfulSourceAction(state, 1);

  const [next] = runtime.decideNextCommands(state);
  assert.equal(next.payload.executePolicy, "mutation_required");
  assert.equal(next.payload.mutationProgressionRequired, true);
});

test("remaining contract targets require an exact source lease instead of another broad survey", () => {
  let state = executeAggregate("acting");
  state = runtime.transition(state, event(state, "observation.recorded", {
    run: baseRun,
    evidence: {
      id: "contract-main-source",
      kind: "source",
      target: "src/main.js",
      version: "main-v1",
    },
  }));
  state = withExecutionContract(state);

  const [next] = runtime.decideNextCommands(state);
  assert.equal(
    next.payload.requiredMutationSourceTarget,
    "src/main.js",
  );
  assert.equal(next.payload.mutationProgressionRequired, false);
});

test("failed editor actions request evidence refresh without disabling the editor class", () => {
  let state = executeAggregate("acting");
  state = runtime.transition(state, event(state, "observation.recorded", {
    run: baseRun,
    evidence: {
      id: "contract-main-source",
      kind: "source",
      target: "src/main.js",
      version: "main-v1",
    },
  }));
  state = withExecutionContract(state);
  state = recordSuccessfulSourceAction(state, 1);

  for (const toolName of ["replace_in_file", "apply_patch"]) {
    const failed = commandFor(
      state,
      "execute_tool",
      `failed-${toolName}`,
      {
        toolCallId: `call-${toolName}`,
        toolName,
        arguments: { path: "src/main.js" },
      },
    );
    state = runtime.transition(state, event(state, "command.scheduled", {
      run: baseRun,
      command: failed,
    }));
    state = runtime.transition(state, event(state, "tool.completed", {
      run: baseRun,
      idempotencyKey: failed.idempotencyKey,
      status: "failed",
      failureKind: "source_mismatch",
      evidence: [],
      presentation: {
        toolName,
        target: "src/main.js",
      },
    }));
  }

  const [next] = runtime.decideNextCommands(state);
  assert.equal(next.payload.executePolicy, "source_refresh_required");
  assert.equal(next.payload.mutationProgressionRequired, false);
  assert.equal(next.payload.requiredMutationSourceTarget, null);

  state = recordSuccessfulSourceAction(state, 2);
  const [afterRefresh] = runtime.decideNextCommands(state);
  assert.equal(
    afterRefresh.payload.executePolicy,
    "mutation_required",
  );
  assert.equal(
    afterRefresh.payload.requiredMutationSourceTarget,
    null,
  );
});

test("a parent source read after child failure remains an observation during validation", () => {
  let state = executeAggregate("validating");
  const job = {
    id: "child-validation-review",
    run: {
      ...baseRun,
      runId: "child-run-validation-review",
      parentRunId: baseRun.runId,
      attemptId: "child-attempt-validation-review",
    },
    parentRunId: baseRun.runId,
    scopeKey: "validation-review",
    name: "Validation reviewer",
    objective: "Review the saved-file behavior.",
    allowedPaths: ["src"],
    status: "queued",
    requestedAt: state.updatedAt + 1,
    firstTokenAt: null,
    closedAt: null,
    summary: null,
  };
  state = runtime.transition(state, event(state, "subagents.scheduled", {
    run: baseRun,
    jobs: [job],
  }));
  state = runtime.transition(state, event(state, "subagent.telemetry", {
    run: baseRun,
    telemetry: {
      jobId: job.id,
      phase: "request_opened",
      at: state.updatedAt + 1,
    },
  }));
  state = runtime.transition(state, event(state, "subagent.telemetry", {
    run: baseRun,
    telemetry: {
      jobId: job.id,
      phase: "closed",
      at: state.updatedAt + 1,
    },
  }));
  state = runtime.transition(state, event(state, "subagent.completed", {
    run: baseRun,
    jobId: job.id,
    status: "failed",
    summary: "No structured report was committed.",
    evidence: [],
  }));

  const [takeover] = runtime.decideNextCommands(state, {
    subagentPreference: "preferred",
  });
  assert.equal(takeover.kind, "request_model");
  assert.equal(takeover.payload.mode, "validate");
  assert.equal(
    takeover.payload.validationParentTakeoverReadRequired,
    true,
  );
  state = runtime.transition(state, event(state, "command.scheduled", {
    run: baseRun,
    command: takeover,
  }));
  state = runtime.transition(state, event(state, "provider.responded", {
    run: baseRun,
    idempotencyKey: takeover.idempotencyKey,
    result: {
      toolCalls: [{
        id: "validate-read-main",
        name: "read_file",
        arguments: { path: "src/main.js" },
      }],
      diagnostics: [],
    },
  }));

  const [read] = runtime.decideNextCommands(state, {
    subagentPreference: "preferred",
  });
  assert.equal(read.kind, "execute_tool");
  assert.equal(read.payload.toolName, "read_file");
  state = runtime.transition(state, event(state, "command.scheduled", {
    run: baseRun,
    command: read,
  }));
  state = runtime.transition(state, event(state, "tool.completed", {
    run: baseRun,
    idempotencyKey: read.idempotencyKey,
    status: "succeeded",
    evidence: [{
      id: "validation-parent-source",
      kind: "source",
      target: "src/main.js",
      version: "main-v1",
    }],
  }));

  const [validate] = runtime.decideNextCommands(state, {
    subagentPreference: "preferred",
  });
  assert.equal(validate.kind, "request_model");
  assert.equal(
    validate.payload.validationParentTakeoverReadRequired,
    false,
  );
});

test("supporting reads do not automatically widen an active execution contract", () => {
  let state = executeAggregate("acting");
  state = runtime.transition(state, event(state, "observation.recorded", {
    run: baseRun,
    evidence: {
      id: "editor-contract-source",
      kind: "source",
      target: "src/components/editor.js",
      version: "editor-v1",
    },
  }));
  const contract = withExecutionContract(state, {
    target: "src/components/editor.js",
  }).executionContract;
  state = runtime.transition(state, event(
    state,
    "execution_contract.committed",
    { run: baseRun, contract },
  ));
  const read = commandFor(state, "execute_tool", "read-outside-contract", {
    toolCallId: "read-main-call",
    toolName: "read_file",
    arguments: { path: "src/main.js" },
  });
  state = runtime.transition(state, event(state, "command.scheduled", {
    run: baseRun,
    command: read,
  }));
  state = runtime.transition(state, event(state, "tool.completed", {
    run: baseRun,
    idempotencyKey: read.idempotencyKey,
    status: "succeeded",
    evidence: [{
      id: "main-contract-source",
      kind: "source",
      target: "src/main.js",
      version: "main-v1",
    }],
  }));

  const [next] = runtime.decideNextCommands(state);
  assert.equal(next.payload.executionContractRevisionRequired, undefined);
  assert.deepEqual(next.payload.activeExecutionContractDraft.changes, [{
    operation: "modify",
    target: "src/components/editor.js",
    basis_evidence_ids: ["editor-contract-source"],
  }]);
  assert.equal(next.payload.toolExpectation, "required");
});

test("a new corrective Acting phase keeps a bounded source gap despite global iteration pressure", () => {
  let state = executeAggregate("acting");
  state = runtime.transition(state, event(state, "soft_signal.observed", {
    run: baseRun,
    signal: "iteration_limit",
  }));

  const [next] = runtime.decideNextCommands(state);
  assert.equal(next.kind, "request_model");
  assert.equal(next.payload.mode, "execute");
  assert.equal(next.payload.executePolicy, "source_gap_allowed");
});

test("failed validation requires one fresh source window before corrective mutation", () => {
  let state = executeAggregate("validating");
  const validation = commandFor(
    state,
    "execute_validation",
    "failed-validation-refresh",
    {
      toolCallId: "validation-refresh-call",
      toolName: "run_command",
      arguments: { command: "npm run build" },
    },
  );
  state = runtime.transition(state, event(state, "command.scheduled", {
    run: baseRun,
    command: validation,
  }));
  state = runtime.transition(state, event(state, "validation.completed", {
    run: baseRun,
    idempotencyKey: validation.idempotencyKey,
    passed: false,
    evidence: [],
  }));
  state = runtime.transition(state, event(state, "phase.changed", {
    run: baseRun,
    phase: "acting",
    reason: "validation failed",
  }));

  let [next] = runtime.decideNextCommands(state);
  assert.equal(next.kind, "request_model");
  assert.equal(next.payload.executePolicy, "source_refresh_required");

  state = recordSuccessfulSourceAction(state, 1);
  [next] = runtime.decideNextCommands(state);
  assert.equal(next.kind, "request_model");
  assert.equal(next.payload.executePolicy, "mutation_required");
});

test("stale mutation context receives one exact refresh before retrying", () => {
  let state = executeAggregate("acting");
  const mutation = commandFor(
    state,
    "execute_tool",
    "stale-mutation",
    {
      toolCallId: "stale-mutation-call",
      toolName: "replace_in_file",
      arguments: {
        path: "src/main.js",
        search_text: "stale source",
        replace_text: "fixed source",
      },
    },
  );
  state = runtime.transition(state, event(state, "command.scheduled", {
    run: baseRun,
    command: mutation,
  }));
  state = runtime.transition(state, event(state, "tool.completed", {
    run: baseRun,
    idempotencyKey: mutation.idempotencyKey,
    status: "failed",
    failureKind: "source_mismatch",
    evidence: [],
  }));

  let [next] = runtime.decideNextCommands(state);
  assert.equal(next.kind, "request_model");
  assert.equal(next.payload.executePolicy, "source_refresh_required");

  state = recordSuccessfulSourceAction(state, 1);
  [next] = runtime.decideNextCommands(state);
  assert.equal(next.kind, "request_model");
  assert.equal(next.payload.executePolicy, "mutation_required");
});

test("a rejected mutation reacquires one exact source window before another edit", () => {
  let state = executeAggregate("acting");
  const mutation = commandFor(
    state,
    "execute_tool",
    "oversized-mutation",
    {
      toolCallId: "oversized-mutation-call",
      toolName: "replace_in_file",
      arguments: {
        path: "src/main.js",
        search_text: "too much source",
        replace_text: "too much replacement",
      },
    },
  );
  state = runtime.transition(state, event(state, "command.scheduled", {
    run: baseRun,
    command: mutation,
  }));
  state = runtime.transition(state, event(state, "tool.completed", {
    run: baseRun,
    idempotencyKey: mutation.idempotencyKey,
    status: "failed",
    failureKind: "mutation_rejected",
    evidence: [],
  }));

  let [next] = runtime.decideNextCommands(state);
  assert.equal(next.kind, "request_model");
  assert.equal(next.payload.executePolicy, "source_refresh_required");

  state = recordSuccessfulSourceAction(state, 1);
  [next] = runtime.decideNextCommands(state);
  assert.equal(next.kind, "request_model");
  assert.equal(next.payload.executePolicy, "mutation_required");
});

test("an invalid mutation target reopens a bounded source-only orientation window", () => {
  let state = executeAggregate("acting");
  state = runtime.transition(state, event(state, "soft_signal.observed", {
    run: baseRun,
    signal: "repeat",
  }));
  const mutation = commandFor(
    state,
    "execute_tool",
    "invalid-target-mutation",
    {
      toolCallId: "invalid-target-call",
      toolName: "replace_in_file",
      arguments: {
        path: "src/invented.ts",
        search_text: "old",
        replace_text: "new",
      },
    },
  );
  state = runtime.transition(state, event(state, "command.scheduled", {
    run: baseRun,
    command: mutation,
  }));
  state = runtime.transition(state, event(state, "tool.completed", {
    run: baseRun,
    idempotencyKey: mutation.idempotencyKey,
    status: "failed",
    failureKind: "target_invalid",
    evidence: [],
  }));

  let [next] = runtime.decideNextCommands(state);
  assert.equal(next.kind, "request_model");
  assert.equal(
    next.payload.executePolicy,
    "source_reorientation_required",
    "old repeat pressure must not force another blind mutation",
  );

  state = recordSuccessfulSourceAction(state, 1);
  [next] = runtime.decideNextCommands(state);
  assert.equal(next.payload.executePolicy, "source_reorientation_required");

  state = recordSuccessfulSourceAction(state, 2);
  [next] = runtime.decideNextCommands(state);
  assert.equal(next.payload.executePolicy, "mutation_required");
});

test("recovery converges across novel failure spellings and corrective epochs", () => {
  let budget = runtime.emptyRuntimeV2RecoveryBudget();
  for (let index = 0; index < runtime.RUNTIME_V2_RECOVERY_EPOCH_LIMITS.action; index += 1) {
    const fingerprint = `action:novel-${index}`;
    assert.equal(
      runtime.canRecordRuntimeV2Recovery(
        budget,
        "action",
        fingerprint,
      ),
      true,
    );
    budget = runtime.recordRuntimeV2Recovery({
      budget,
      scope: "action",
      fingerprint,
      at: index + 1,
    });
  }
  assert.equal(
    runtime.canRecordRuntimeV2Recovery(
      budget,
      "action",
      "action:another-new-spelling",
    ),
    false,
  );

  let epochBudget = runtime.emptyRuntimeV2RecoveryBudget();
  for (
    let index = 0;
    index < runtime.RUNTIME_V2_MAX_CORRECTIVE_EPOCHS;
    index += 1
  ) {
    assert.equal(runtime.canOpenRuntimeV2RecoveryEpoch(epochBudget), true);
    epochBudget = runtime.openRuntimeV2RecoveryEpoch(epochBudget);
  }
  assert.equal(runtime.canOpenRuntimeV2RecoveryEpoch(epochBudget), false);
});

test("Capsule keeps provider-visible commentary beside its exact structured action", () => {
  let state = executeAggregate("observing");
  const request = commandFor(state, "request_model", "model-commentary", {
    mode: "observe",
  });
  state = runtime.transition(state, event(state, "command.scheduled", {
    run: baseRun,
    command: request,
  }));
  state = runtime.transition(state, event(state, "provider.responded", {
    run: baseRun,
    idempotencyKey: request.idempotencyKey,
    result: {
      visibleText: "我已经收窄到编辑器的文件生命周期，先核对事件入口。",
      toolCalls: [{
        id: "read-editor",
        name: "read_file",
        arguments: {
          path: "src/features/editor/EditorInteractionCoordinator.ts",
        },
      }],
      diagnostics: [],
    },
  }));
  const [read] = runtime.decideNextCommands(state);
  assert.equal(read.kind, "execute_tool");
  state = runtime.transition(state, event(state, "command.scheduled", {
    run: baseRun,
    command: read,
  }));

  const capsule = runtime.buildRuntimeV2CapsuleProjection(state, "capsule-1");
  assert.match(capsule.markdown, /我已经收窄到编辑器的文件生命周期/);
  assert.match(capsule.markdown, /EditorInteractionCoordinator\.ts/);
  assert.doesNotMatch(capsule.markdown, /\.\.\./);
});

test("Capsule keeps a complete concise sentence and renders workspace paths relatively", () => {
  let state = executeAggregate("observing");
  const request = commandFor(state, "request_model", "model-long-commentary", {
    mode: "observe",
  });
  state = runtime.transition(state, event(state, "command.scheduled", {
    run: baseRun,
    command: request,
  }));
  state = runtime.transition(state, event(state, "provider.responded", {
    run: baseRun,
    idempotencyKey: request.idempotencyKey,
    result: {
      visibleText: `已定位到编辑器状态同步入口。${"仍在展开内部推演".repeat(80)}`,
      toolCalls: [{
        id: "read-absolute-editor",
        name: "read_file",
        arguments: { path: "/fixture/src/components/editor.js" },
      }],
      diagnostics: [],
    },
  }));
  const [read] = runtime.decideNextCommands(state);
  state = runtime.transition(state, event(state, "command.scheduled", {
    run: baseRun,
    command: read,
  }));

  const capsule = runtime.buildRuntimeV2CapsuleProjection(state, "capsule-relative");
  assert.match(capsule.markdown, /^已定位到编辑器状态同步入口。/);
  assert.match(capsule.markdown, /`src\/components\/editor\.js`/);
  assert.doesNotMatch(capsule.markdown, /\/fixture\//);
  assert.doesNotMatch(capsule.markdown, /仍在展开内部推演/);
});

test("Capsule never exposes a text tool envelope as commentary", () => {
  let state = executeAggregate("observing");
  const request = commandFor(state, "request_model", "model-envelope", {
    mode: "observe",
  });
  state = runtime.transition(state, event(state, "command.scheduled", {
    run: baseRun,
    command: request,
  }));
  const envelope = '<runtime-v2-tools>{"toolCalls":[{"id":"read-main","name":"read_file","arguments":{"path":"src/main.js"}}]}</runtime-v2-tools>';
  state = runtime.transition(state, event(state, "provider.responded", {
    run: baseRun,
    idempotencyKey: request.idempotencyKey,
    result: {
      visibleText: envelope,
      toolCalls: [{
        id: "read-main",
        name: "read_file",
        arguments: { path: "src/main.js" },
      }],
      diagnostics: [],
    },
  }));
  const [read] = runtime.decideNextCommands(state);
  state = runtime.transition(state, event(state, "command.scheduled", {
    run: baseRun,
    command: read,
  }));

  const capsule = runtime.buildRuntimeV2CapsuleProjection(state, "capsule-2");
  assert.match(capsule.markdown, /正在读取/);
  assert.doesNotMatch(capsule.markdown, /runtime-v2-tools|toolCalls/);
});

test("Capsule clears provider commentary after its structured action settles", () => {
  let state = executeAggregate("observing");
  const request = commandFor(state, "request_model", "model-stale-commentary", {
    mode: "observe",
  });
  state = runtime.transition(state, event(state, "command.scheduled", {
    run: baseRun,
    command: request,
  }));
  state = runtime.transition(state, event(state, "provider.responded", {
    run: baseRun,
    idempotencyKey: request.idempotencyKey,
    result: {
      visibleText: "这条说明只属于接下来的读取动作。",
      toolCalls: [{
        id: "read-once",
        name: "read_file",
        arguments: { path: "src/main.js" },
      }],
      diagnostics: [],
    },
  }));
  const [read] = runtime.decideNextCommands(state);
  state = runtime.transition(state, event(state, "command.scheduled", {
    run: baseRun,
    command: read,
  }));
  state = runtime.transition(state, event(state, "tool.completed", {
    run: baseRun,
    idempotencyKey: read.idempotencyKey,
    status: "succeeded",
    evidence: [{
      id: "read-source",
      kind: "source",
      target: "src/main.js",
      version: "source-v1",
    }],
  }));

  const capsule = runtime.buildRuntimeV2CapsuleProjection(
    state,
    "capsule-settled",
  );
  assert.doesNotMatch(capsule.markdown, /只属于接下来的读取动作/);
  assert.match(capsule.markdown, /正在收集证据/);
});

test("Chat milestones reject runtime-authored phase and child prose and keep actual provider commentary", () => {
  let state = executeAggregate("observing");
  const observation = event(state, "observation.recorded", {
    run: baseRun,
    evidence: {
      id: "source-1",
      kind: "source",
      target: "src/main.js",
      version: "source-v1",
    },
  });
  state = runtime.transition(state, observation);
  assert.equal(
    runtime.buildRuntimeV2MilestoneProjection(
      state,
      observation,
      "observation-milestone",
    ),
    null,
  );
  const phaseChange = event(state, "phase.changed", {
    run: baseRun,
    phase: "acting",
    reason: "synthetic runtime phase copy",
  });
  assert.equal(
    runtime.buildRuntimeV2MilestoneProjection(
      state,
      phaseChange,
      "phase-milestone",
    ),
    null,
  );

  const childRun = (runId) => ({
    ...baseRun,
    runId,
    parentRunId: baseRun.runId,
    attemptId: runId,
  });
  const jobs = [
    {
      id: "child-frontend",
      run: childRun("child-run-frontend"),
      parentRunId: baseRun.runId,
      scopeKey: "frontend",
      objective: "Inspect frontend evidence",
      allowedPaths: ["src"],
      status: "queued",
      requestedAt: state.updatedAt + 1,
      firstTokenAt: null,
      closedAt: null,
      summary: null,
    },
    {
      id: "child-backend",
      run: childRun("child-run-backend"),
      parentRunId: baseRun.runId,
      scopeKey: "backend",
      objective: "Inspect backend evidence",
      allowedPaths: ["src-tauri"],
      status: "queued",
      requestedAt: state.updatedAt + 1,
      firstTokenAt: null,
      closedAt: null,
      summary: null,
    },
  ];
  const scheduled = event(state, "subagents.scheduled", {
    run: baseRun,
    jobs,
  });
  state = runtime.transition(state, scheduled);
  assert.equal(
    runtime.buildRuntimeV2MilestoneProjection(
      state,
      scheduled,
      "scheduled-milestone",
    ),
    null,
  );
  state = runtime.transition(state, event(state, "subagent.telemetry", {
    run: baseRun,
    telemetry: {
      jobId: jobs[0].id,
      phase: "request_opened",
      at: state.updatedAt + 1,
    },
  }));
  state = runtime.transition(state, event(state, "subagent.telemetry", {
    run: baseRun,
    telemetry: {
      jobId: jobs[0].id,
      phase: "closed",
      at: state.updatedAt + 1,
    },
  }));
  const firstChild = event(state, "subagent.completed", {
    run: baseRun,
    jobId: jobs[0].id,
    status: "completed",
    summary: "Frontend evidence collected.",
    evidence: [{
      id: "child-evidence-1",
      kind: "subagent",
      target: "src/main.js",
      version: null,
    }],
    report: {
      schemaVersion: runtime.RUNTIME_V2_SUBAGENT_REPORT_SCHEMA_VERSION,
      summary: "Frontend evidence collected.",
      findings: [{
        statement: "The frontend handler owns the observed transition.",
        evidenceIds: ["child-evidence-1"],
      }],
      unresolved: [],
    },
  });
  state = runtime.transition(state, firstChild);
  assert.equal(
    runtime.buildRuntimeV2MilestoneProjection(
      state,
      firstChild,
      "first-child-milestone",
    ),
    null,
  );

  state = runtime.transition(state, event(state, "subagent.telemetry", {
    run: baseRun,
    telemetry: {
      jobId: jobs[1].id,
      phase: "request_opened",
      at: state.updatedAt + 1,
    },
  }));
  state = runtime.transition(state, event(state, "subagent.telemetry", {
    run: baseRun,
    telemetry: {
      jobId: jobs[1].id,
      phase: "closed",
      at: state.updatedAt + 1,
    },
  }));
  const secondChild = event(state, "subagent.completed", {
    run: baseRun,
    jobId: jobs[1].id,
    status: "failed",
    summary: "Backend request ended without a report.",
    evidence: [],
  });
  state = runtime.transition(state, secondChild);
  const joined = runtime.buildRuntimeV2MilestoneProjection(
    state,
    secondChild,
    "joined-child-milestone",
  );
  assert.equal(joined, null);

  const providerCommentary = event(state, "provider.responded", {
    run: baseRun,
    idempotencyKey: "provider-commentary",
    result: {
      visibleText: "我先核对保存事件的真实消费路径。",
      toolCalls: [{
        id: "read-save-handler",
        name: "read_file",
        arguments: { path: "src/save-handler.ts" },
      }],
      diagnostics: [],
    },
  });
  const realMilestone = runtime.buildRuntimeV2MilestoneProjection(
    state,
    providerCommentary,
    "provider-commentary-milestone",
  );
  assert.equal(realMilestone.markdown, "我先核对保存事件的真实消费路径。");
  assert.doesNotMatch(realMilestone.markdown, /当前阶段|已保留|并行只读调查/);
});

test("a child that only reads but never submits an evidence-linked report cannot complete", () => {
  let state = executeAggregate("observing");
  const scheduled = runtime.scheduleReadOnlySubagents({
    parentRun: baseRun,
    candidates: [{
      scopeKey: "read-until-budget",
      taskKind: "explore",
      objective: "Read the save path until evidence is clear.",
      allowedPaths: ["src"],
    }],
    requestedAt: state.updatedAt + 1,
    nextId: () => "child-read-until-budget",
  });
  state = runtime.transition(state, event(state, "subagents.scheduled", {
    run: baseRun,
    jobs: scheduled.jobs,
  }));
  state = runtime.transition(state, event(state, "subagent.telemetry", {
    run: baseRun,
    telemetry: {
      jobId: scheduled.jobs[0].id,
      phase: "request_opened",
      at: state.updatedAt + 1,
    },
  }));
  state = runtime.transition(state, event(state, "subagent.telemetry", {
    run: baseRun,
    telemetry: {
      jobId: scheduled.jobs[0].id,
      phase: "closed",
      at: state.updatedAt + 1,
    },
  }));
  const readEvidence = [{
    id: "child-read-E1",
    kind: "subagent",
    target: "src/main.js",
    version: "source-v1",
  }];
  const invalidCompletion = runtime.tryTransition(
    state,
    event(state, "subagent.completed", {
      run: baseRun,
      jobId: scheduled.jobs[0].id,
      status: "completed",
      summary: "Reached the read-only investigation round limit.",
      evidence: readEvidence,
    }),
  );
  assert.equal(invalidCompletion.disposition, "rejected");
  assert.equal(invalidCompletion.reason, "subagent_invalid");

  const failed = runtime.tryTransition(
    state,
    event(state, "subagent.completed", {
      run: baseRun,
      jobId: scheduled.jobs[0].id,
      status: "failed",
      summary: "No structured evidence-linked report was submitted.",
      evidence: readEvidence,
    }),
  );
  assert.equal(failed.disposition, "applied");
  assert.equal(failed.state.subagents[0].status, "failed");
  assert.equal(failed.state.subagents[0].report, null);
});

test("Runtime v2 reducer records one ordered ledger and forbids success before finalizing", () => {
  let state = runtime.transition(null, event(null, "turn.admitted", {
    turn: baseTurn,
    strategy: "execute",
    objective: "Fix the fixture",
    constraints: [],
    acceptanceCriteria: ["The test passes"],
  }));
  state = runtime.transition(state, event(state, "run.started", { run: baseRun, phase: "preparing" }));
  const premature = runtime.tryTransition(state, event(state, "run.completed", {
    run: baseRun,
    outcome: { resultKind: "success", reason: "not validated", completedAt: 3, finalProjectionId: "final-a" },
  }));
  assert.equal(premature.disposition, "rejected");
  assert.equal(premature.reason, "success_requires_finalizing");

  state = runtime.transition(state, event(state, "phase.changed", {
    run: baseRun,
    phase: "finalizing",
    reason: "all required checks passed",
  }));
  state = runtime.transition(state, event(state, "run.completed", {
    run: baseRun,
    outcome: { resultKind: "success", reason: "validated", completedAt: 4, finalProjectionId: "final-a" },
  }));
  state = runtime.transition(state, event(state, "projection.published", {
    run: baseRun,
    audience: "final",
    projectionId: "final-a",
    projection: {
      id: "final-a",
      audience: "final",
      markdown: "### 已完成",
      kind: "final",
      dedupeKey: "final",
    },
  }));
  state = runtime.transition(state, event(state, "turn.completed", {
    turn: baseTurn,
    runId: baseRun.runId,
    outcome: { resultKind: "success", reason: "validated", completedAt: 4, finalProjectionId: "final-a" },
  }));
  assert.equal(state.phase, "completed");
  assert.equal(state.events.filter((item) => item.type === "turn.completed").length, 1);
});

test("provider transport is capability-based, bounded and does not infer calls from prose", () => {
  const profile = {
    schemaVersion: "provider-lane.v1",
    nativeTools: true,
    requiredToolChoice: true,
    streaming: true,
    textToolEnvelope: true,
    reasoning: true,
    imageInput: false,
    toolResultRole: "tool",
  };
  let epoch = runtime.createProviderActionEpoch("read-main");
  const variants = [];
  while (true) {
    const attempt = runtime.selectNextProviderTransportAttempt(profile, epoch);
    if (!attempt) break;
    variants.push(attempt.variant);
    epoch = runtime.recordProviderTransportAttempt(epoch, attempt);
  }
  assert.deepEqual(variants, ["native_required", "text_envelope"]);
  assert.equal(runtime.providerActionEpochExhausted(profile, epoch), true);
  assert.deepEqual(runtime.parseExplicitTextToolEnvelope("让我读取 src/main.js"), []);
  assert.deepEqual(runtime.parseExplicitTextToolEnvelope(
    '<runtime-v2-tools>{"toolCalls":[{"id":"a","name":"read_file","arguments":{"path":"src/main.js"}}]}</runtime-v2-tools>',
  ), [{ id: "a", name: "read_file", arguments: { path: "src/main.js" } }]);
  assert.deepEqual(runtime.parseExplicitTextToolEnvelope(
    '我先提交精确操作。\n<runtime-v2-tools>{"toolCalls":[{"id":"b","name":"read_file","arguments":{"path":"src/main.js","start_line":20}}]}</runtime-v2-tools>\n随后等待真实结果。',
  ), [{
    id: "b",
    name: "read_file",
    arguments: { path: "src/main.js", start_line: 20 },
  }]);
  assert.deepEqual(runtime.parseExplicitTextToolEnvelope(
    '{"toolCalls":[{"id":"json","name":"apply_patch","arguments":{"patch":"*** Begin Patch"}}]}',
  ), [{
    id: "json",
    name: "apply_patch",
    arguments: { patch: "*** Begin Patch" },
  }]);
  assert.deepEqual(runtime.parseExplicitTextToolEnvelope(
    '```json\n{"name":"read_file","arguments":{"path":"src/main.js"}}\n```',
  ), [{
    id: "tool-1",
    name: "read_file",
    arguments: { path: "src/main.js" },
  }]);
  const rawMultilineReplacement = [
    '<runtime-v2-tools>{"toolCalls":[{"id":"repair","name":"replace_in_file","arguments":{',
    '"path":"src/main.js","search_text":"const before = true;',
    'const stale = true;","replace_text":"const before = true;',
    'const stale = false;",}}]}</runtime-v2-tools>',
  ].join("\n");
  assert.deepEqual(runtime.parseExplicitTextToolEnvelope(
    rawMultilineReplacement,
  ), [{
    id: "repair",
    name: "replace_in_file",
    arguments: {
      path: "src/main.js",
      search_text: "const before = true;\nconst stale = true;",
      replace_text: "const before = true;\nconst stale = false;",
    },
  }]);
  const normalizedEnvelope = runtime.normalizeProviderResponseV1({
    visibleText: "",
    content: rawMultilineReplacement,
  });
  assert.deepEqual(
    normalizedEnvelope.diagnostics.map((diagnostic) => diagnostic.code),
    ["explicit_tool_envelope_json_normalized"],
  );
  const invalidEnvelope = runtime.normalizeProviderResponseV1({
    visibleText: "",
    content:
      '<runtime-v2-tools>{"toolCalls":[{"name":"read_file","arguments":}]}</runtime-v2-tools>',
  });
  assert.deepEqual(invalidEnvelope.toolCalls, []);
  assert.deepEqual(
    invalidEnvelope.diagnostics.map((diagnostic) => diagnostic.code),
    ["explicit_tool_envelope_invalid_json"],
  );
  assert.deepEqual(runtime.parseExplicitTextToolEnvelope(
    '说明如下：\n{"toolCalls":[{"name":"read_file","arguments":{"path":"src/main.js"}}]}',
  ), []);
  assert.deepEqual(runtime.parseExplicitTextToolEnvelope(
    '<runtime-v2-tools>{"toolCalls":[]}</runtime-v2-tools>\n' +
      '<runtime-v2-tools>{"toolCalls":[{"id":"c","name":"read_file","arguments":{"path":"src/main.js"}}]}</runtime-v2-tools>',
  ), []);
  const longReasoningPrefix = "分析".repeat(20_000);
  assert.deepEqual(runtime.normalizeProviderResponseV1({
    visibleText: "",
    content:
      `${longReasoningPrefix}<runtime-v2-tools>` +
      '{"toolCalls":[{"id":"d","name":"apply_patch","arguments":{"patch":"*** Begin Patch"}}]}' +
      "</runtime-v2-tools>",
  }).toolCalls, [{
    id: "d",
    name: "apply_patch",
    arguments: { patch: "*** Begin Patch" },
  }]);
  assert.equal(runtime.allocateProviderAttemptTimeoutMs(90_000, true), 60_000);
  assert.equal(runtime.allocateProviderAttemptTimeoutMs(90_000, false), 90_000);
  assert.equal(runtime.allocateProviderAttemptTimeoutMs(30_000, true), 15_000);
});

test("WorkPlanV1 seals one source for Markdown and requires review for lossy V5 imports", () => {
  const draft = {
    schemaVersion: runtime.WORK_PLAN_V1_SCHEMA_VERSION,
    objective: "修复打开文件问题",
    summary: "统一文件打开路径并验证。",
    findings: [{ statement: "打开事件没有被前端消费。", basis: ["E1"] }],
    steps: [{
      title: "统一打开入口",
      operation: "modify",
      targets: ["src/main.js"],
      basis: ["E1"],
      change: "让前端消费统一事件。",
      expectedOutcome: "文件内容和标签同步更新。",
      dependsOn: [],
    }],
    validations: [{
      stepIndexes: [0],
      kind: "finite_command",
      command: "npm run build",
      expectedOutcome: "构建通过。",
      required: true,
    }],
    risks: [],
    assumptions: [],
    blockingQuestions: [],
  };
  const plan = runtime.sealWorkPlanV1({
    draft,
    evidence: [{ id: "E1", target: "src/main.js", version: "v1", statement: "listener missing" }],
    createdAt: 10,
  });
  assert.match(plan.markdown, /统一打开入口/);
  assert.match(plan.markdown, /npm run build/);
  assert.match(plan.projectionHash, /^work-plan-projection-sha256-/);
  assert.match(
    runtime.validateWorkPlanDraftV1({
      ...draft,
      summary: "x".repeat(15_000),
    })[0]?.message || "",
    /14,000-character/,
  );
  assert.ok(runtime.validateWorkPlanDraftV1({
    ...draft,
    summary: "<tool_call><function=submit_runtime_v2_work_plan>",
  }).some((issue) =>
    issue.path === "summary" && /tool-protocol markup/.test(issue.message)
  ));
  assert.ok(runtime.validateWorkPlanDraftV1({
    ...draft,
    validations: [{
      stepIndexes: [0],
      kind: "finite_command",
      command: "npm run dev",
      expectedOutcome: "服务启动。",
      required: true,
    }],
  }).some((issue) =>
    issue.path === "validations[0].command" && /bounded fail-fast/.test(issue.message)
  ));
  assert.ok(runtime.validateWorkPlanDraftV1({
    ...draft,
    validations: [{
      stepIndexes: [0],
      kind: "assertion",
      expectedOutcome: "代码看起来正确。",
      required: true,
    }],
  }).some((issue) =>
    issue.path === "validations[0].required" && /cannot own required acceptance/.test(issue.message)
  ));
  assert.ok(runtime.validateWorkPlanDraftV1({
    ...draft,
    blockingQuestions: ["需要再读取源文件吗？"],
  }).some((issue) =>
    issue.path === "blockingQuestions" && /cannot be approved/.test(issue.message)
  ));

  const migration = runtime.migratePlanCandidateV5ToWorkPlanV1({
    schemaVersion: 5,
    state: "sealed",
    contractId: "legacy",
    authoringContractId: "legacy-author",
    bundleHash: "bundle",
    objective: "legacy",
    goals: [],
    diagnosisRequired: false,
    evidence: [],
    evidenceReceipt: {},
    summary: [],
    diagnoses: [],
    findings: [],
    changes: [],
    decisions: [],
    interfaces: [],
    tests: [],
    validations: [],
    assumptions: [],
    blockingChoices: [],
    projection: { format: "markdown", content: "# legacy", contentHash: "legacy" },
  });
  assert.equal(migration.disposition, "requires_review");
});

test("RuntimeV2Controller persists scheduled effects, publishes complete Capsule text, and concludes exactly once", async () => {
  let now = 100;
  let id = 0;
  let revision = 0;
  const published = [];
  const ports = {
    checkpoint: {
      async load() { return null; },
      async append({ event }) {
        revision += 1;
        return { disposition: "committed", checkpoint: { revision, event } };
      },
    },
    provider: {
      async request() {
        return { toolCalls: [{ id: "read-1", name: "read_file", arguments: { path: "src/main.js" } }], diagnostics: [] };
      },
    },
    tool: {
      async execute({ command }) {
        if (command.kind === "collect_observation") {
          return { type: "observation.recorded", run: command.run, evidence: { id: "E1", kind: "source", target: "src/main.js", version: "v1" } };
        }
        return { type: "tool.completed", run: command.run, idempotencyKey: command.idempotencyKey, status: "succeeded", evidence: [{ id: "E2", kind: "tool", target: "src/main.js", version: "v2" }] };
      },
    },
    scheduler: { async execute({ command }) { return { type: "command.completed", run: command.run, idempotencyKey: command.idempotencyKey, status: "succeeded" }; } },
    projection: { async publish({ projection }) { published.push(projection); } },
    clockId: {
      now: () => ++now,
      nextId: (scope) => `${scope}-${++id}`,
      nextIdempotencyKey: ({ run, kind }) => `${run.runId}:${kind}:${++id}`,
    },
  };
  const controller = new runtime.RuntimeV2Controller(ports);
  await controller.admit({ turn: baseTurn, run: baseRun, strategy: "execute", objective: "Fix it" });
  assert.equal(await controller.driveOnce(), true);
  await controller.changePhase("observing", "initial evidence collected");
  assert.equal(await controller.driveOnce(), true);
  assert.equal(await controller.driveOnce(), true);
  await controller.changePhase("finalizing", "validation complete");
  assert.equal(await controller.driveOnce({ resultKind: "success", resultReason: "validated" }), true);
  const snapshot = controller.snapshot();
  assert.equal(snapshot.aggregate.phase, "completed");
  assert.equal(snapshot.aggregate.events.filter((item) => item.type === "turn.completed").length, 1);
  assert.ok(published.some((item) => item.audience === "capsule_live" && /src\/main\.js/.test(item.markdown)));
  assert.equal(published.filter((item) => item.audience === "final").length, 1);
});

test("successful structural actions do not consume failed-action recovery", async () => {
  let now = 100;
  let id = 0;
  let revision = 0;
  const published = [];
  const ports = {
    checkpoint: {
      async load() { return null; },
      async append({ event }) {
        revision += 1;
        return { disposition: "committed", checkpoint: { revision, event } };
      },
    },
    provider: {
      async request() { return { toolCalls: [], diagnostics: [], visibleText: "" }; },
    },
    tool: {
      async execute({ command }) {
        return { type: "observation.recorded", run: command.run, evidence: { id: "E1", kind: "source", target: "src/main.js", version: "v1" } };
      },
    },
    scheduler: { async execute({ command }) { return { type: "command.completed", run: command.run, idempotencyKey: command.idempotencyKey, status: "succeeded" }; } },
    projection: { async publish({ projection }) { published.push(projection); } },
    clockId: {
      now: () => ++now,
      nextId: (scope) => `${scope}-${++id}`,
      nextIdempotencyKey: ({ run, kind }) => `${run.runId}:${kind}:${++id}`,
    },
  };
  const controller = new runtime.RuntimeV2Controller(ports);
  await controller.admit({ turn: baseTurn, run: baseRun, strategy: "execute", objective: "Fix it" });
  await controller.changePhase("observing", "evidence is available");
  await controller.recordObservation({ id: "E1", kind: "source", target: "src/main.js", version: "v1" });
  await controller.driveOnce();
  await controller.driveOnce();
  await controller.driveOnce();
  await controller.driveOnce();
  const aggregate = controller.snapshot().aggregate;
  assert.equal(aggregate.phase, "observing");
  assert.equal(aggregate.terminalOutcome, null);
  assert.equal(aggregate.recovery.exhausted, null);
  assert.equal(aggregate.events.filter((event) => event.type === "turn.completed").length, 0);
  assert.equal(published.filter((item) => item.audience === "final").length, 0);
});

test("an exact source refresh opens a bounded recovery epoch after a rejected edit", async () => {
  let now = 450;
  let id = 0;
  let revision = 0;
  let mutationCalls = 0;
  const policies = [];
  const controller = new runtime.RuntimeV2Controller({
    checkpoint: {
      async load() { return null; },
      async append({ event: appended }) {
        revision += 1;
        return {
          disposition: "committed",
          checkpoint: { revision, event: appended },
        };
      },
    },
    provider: {
      async request({ command }) {
        policies.push(command.payload.executePolicy);
        if (command.payload.executePolicy === "source_refresh_required") {
          return {
            toolCalls: [{
              id: "refresh-source",
              name: "read_file",
              arguments: { path: "src/main.js" },
            }],
            diagnostics: [],
          };
        }
        return {
          toolCalls: [{
            id: `mutation-${++mutationCalls}`,
            name: "apply_patch",
            arguments: { patch: "*** Begin Patch\n*** End Patch" },
          }],
          diagnostics: [],
        };
      },
    },
    tool: {
      async execute({ command }) {
        if (command.payload.toolName === "read_file") {
          return {
            type: "tool.completed",
            run: command.run,
            idempotencyKey: command.idempotencyKey,
            status: "succeeded",
            evidence: [{
              id: "refreshed-source",
              kind: "source",
              target: "src/main.js",
              version: "source-v2",
            }],
          };
        }
        return mutationCalls === 1
          ? {
              type: "tool.completed",
              run: command.run,
              idempotencyKey: command.idempotencyKey,
              status: "failed",
              failureKind: "mutation_rejected",
              evidence: [],
            }
          : {
              type: "tool.completed",
              run: command.run,
              idempotencyKey: command.idempotencyKey,
              status: "succeeded",
              evidence: [{
                id: "mutation-success",
                kind: "mutation",
                target: "src/main.js",
                version: "source-v3",
              }],
            };
      },
    },
    scheduler: {
      async execute() {
        throw new Error("scheduler is not expected");
      },
    },
    projection: { async publish() {} },
    clockId: {
      now: () => ++now,
      nextId: (scope) => `${scope}-${++id}`,
      nextIdempotencyKey: ({ run, kind }) => `${run.runId}:${kind}:${++id}`,
    },
  });
  await controller.admit({
    turn: baseTurn,
    run: baseRun,
    strategy: "execute",
    objective: "Repair the fixture",
    initialPhase: "acting",
  });
  await controller.recordSoftSignal("repeat");
  for (let step = 0; step < 6; step += 1) {
    assert.equal(await controller.driveOnce(), true);
  }

  const aggregate = controller.snapshot().aggregate;
  assert.deepEqual(policies, [
    "mutation_required",
    "source_refresh_required",
    "mutation_required",
  ]);
  assert.equal(aggregate.recovery.epoch, 1);
  assert.equal(aggregate.recovery.exhausted, null);
  assert.ok(aggregate.events.some((item) =>
    item.type === "recovery.epoch_opened" &&
    item.reason === "corrective_source_refreshed_after_rejected_mutation"
  ));
  assert.ok(aggregate.evidence.some((item) =>
    item.kind === "mutation" && item.id === "mutation-success"
  ));
});

test("an unchanged reread cannot reset exact side-effect retry protection", () => {
  const initial = executeAggregate("acting");
  const priorSource = event(initial, "tool.completed", {
    run: baseRun,
    idempotencyKey: "prior-source",
    status: "succeeded",
    evidence: [{
      id: "source-v1",
      kind: "source",
      target: "src/main.js",
      version: "v1",
    }],
  });
  const rejectedEdit = event(initial, "tool.completed", {
    run: baseRun,
    idempotencyKey: "rejected-edit",
    status: "failed",
    failureKind: "mutation_rejected",
    evidence: [],
  });
  const aggregate = {
    ...initial,
    events: [...initial.events, priorSource, rejectedEdit],
    recovery: {
      ...initial.recovery,
      receipts: [{
        scope: "action",
        fingerprint: "action:apply-patch-v1",
        count: 1,
        epoch: 0,
        lastAttemptAt: rejectedEdit.at,
      }],
    },
  };
  const sameVersion = event(aggregate, "tool.completed", {
    run: baseRun,
    idempotencyKey: "same-source-refresh",
    status: "succeeded",
    evidence: [{
      id: "source-v1-again",
      kind: "source",
      target: "src/main.js",
      version: "v1",
    }],
  });
  assert.equal(
    runtime.deriveRuntimeV2CorrectiveRecoveryEpoch({
      aggregate,
      event: sameVersion,
    }),
    null,
  );

  const newVersion = {
    ...sameVersion,
    evidence: [{
      id: "source-v2",
      kind: "source",
      target: "src/main.js",
      version: "v2",
    }],
  };
  assert.equal(
    runtime.deriveRuntimeV2CorrectiveRecoveryEpoch({
      aggregate,
      event: newVersion,
    })?.reason,
    "corrective_source_refreshed_after_rejected_mutation",
  );
});

test("a weak-model read loop is pulled into mutation, validation, and a truthful terminal", async () => {
  let now = 500;
  let id = 0;
  let revision = 0;
  let sourceEvidenceId = 0;
  const providerPolicies = [];
  const executedTools = [];
  const controller = new runtime.RuntimeV2Controller({
    checkpoint: {
      async load() { return null; },
      async append({ event: appended }) {
        revision += 1;
        return { disposition: "committed", checkpoint: { revision, event: appended } };
      },
    },
    provider: {
      async request({ command }) {
        const mode = command.payload.mode;
        if (mode === "execute") {
          providerPolicies.push(command.payload.executePolicy);
          if (sourceEvidenceId === 0) {
            return {
              toolCalls: [{
                id: "read-source",
                name: "read_file",
                arguments: { path: "src/main.js" },
              }],
              diagnostics: [],
            };
          }
          if (!command.payload.executionContractRevision) {
            return {
              toolCalls: [{
                id: "submit-contract",
                name: "submit_execution_contract",
                arguments: {
                  criteria: [{
                    id: "criterion-user-objective",
                    evidence_requirement: "behavioral",
                  }],
                  changes: [{
                    operation: "modify",
                    target: "src/main.js",
                    basis_evidence_ids: ["source-1"],
                  }],
                  validations: [{
                    id: "fixture-test",
                    criterion_ids: ["criterion-user-objective"],
                    target_paths: ["src/main.js"],
                    kind: "finite_command",
                    command: "npm test",
                    cwd: ".",
                    expected_outcome: "fixture tests pass",
                  }],
                },
              }],
              diagnostics: [],
            };
          }
          return {
            toolCalls: [{
              id: "apply-fix",
              name: "apply_patch",
              arguments: {
                path: "src/main.js",
                patch: "*** Begin Patch\\n*** End Patch",
              },
            }],
            diagnostics: [],
          };
        }
        if (mode === "validate") {
          return {
            toolCalls: [{
              id: "validate-fix",
              name: "run_command",
              arguments: { command: "npm test" },
            }],
            diagnostics: [],
          };
        }
        if (mode === "conclude") {
          return {
            visibleText: "修复已经落账，并通过有限验证。",
            toolCalls: [],
            diagnostics: [],
          };
        }
        throw new Error(`unexpected provider mode: ${mode}`);
      },
    },
    tool: {
      async execute({ command }) {
        const toolName = command.payload.toolName;
        executedTools.push(toolName);
        if (toolName === "read_file") {
          return {
            type: "tool.completed",
            run: command.run,
            idempotencyKey: command.idempotencyKey,
            status: "succeeded",
            evidence: [{
              id: `source-${++sourceEvidenceId}`,
              kind: "source",
              target: "src/main.js",
              version: "source-v1",
            }],
          };
        }
        if (toolName === "apply_patch") {
          return {
            type: "tool.completed",
            run: command.run,
            idempotencyKey: command.idempotencyKey,
            status: "succeeded",
            evidence: [{
              id: "mutation-1",
              kind: "mutation",
              target: "src/main.js",
              version: "source-v2",
            }],
          };
        }
        return {
          type: "validation.completed",
          run: command.run,
          idempotencyKey: command.idempotencyKey,
          evidence: [{
            id: "validation-1",
            kind: "validation",
            target: "npm test",
            version: null,
          }],
          passed: true,
          authority: command.payload.validationAuthority,
          ...runtime.deriveRuntimeV2ValidationBoundary(
            controller.snapshot().aggregate,
            command.payload.validationAuthority.targetPaths,
          ),
        };
      },
    },
    scheduler: {
      async execute() {
        throw new Error("scheduler is not expected");
      },
    },
    projection: { async publish() {} },
    clockId: {
      now: () => ++now,
      nextId: (scope) => `${scope}-${++id}`,
      nextIdempotencyKey: ({ run, kind }) => `${run.runId}:${kind}:${++id}`,
    },
  });

  await controller.admit({
    turn: baseTurn,
    run: baseRun,
    strategy: "execute",
    objective: "Repair the fixture",
    acceptanceCriteria: ["Repair the fixture"],
    acceptanceCriterionIds: ["criterion-user-objective"],
    initialPhase: "acting",
  });
  for (let step = 0; step < 6; step += 1) {
    assert.equal(await controller.driveOnce(), true);
  }
  let aggregate = controller.snapshot().aggregate;
  assert.equal(aggregate.terminalOutcome, null);
  assert.deepEqual(providerPolicies, [
    "source_gap_allowed",
    "source_gap_allowed",
    "mutation_required",
  ]);
  assert.deepEqual(executedTools, [
    "read_file",
    "apply_patch",
  ]);
  assert.ok(aggregate.events.some((item) =>
    item.type === "execution_contract.committed"
  ));
  assert.equal(aggregate.recovery.exhausted, null);

  const toValidation = runtime.decideRuntimeV2ExecutePhaseTransition(aggregate, {
    isMutationToolName: (name) => name === "apply_patch",
  });
  assert.equal(toValidation?.to, "validating");
  await controller.changePhase("validating", "mutation committed");
  assert.equal(await controller.driveOnce(), true);
  assert.equal(await controller.driveOnce(), true);
  assert.equal(await controller.driveOnce(), true);

  aggregate = controller.snapshot().aggregate;
  const terminal = runtime.decideRuntimeV2TerminalOutcome(aggregate, {
    canceled: false,
    mutationCount: 1,
    passedValidationCount: 1,
    failedValidationCount: 0,
    stalledValidationCount: 0,
    hasProviderConclusion: true,
  });
  assert.equal(terminal?.resultKind, "success");
  assert.equal(await controller.driveOnce(terminal), true);
  aggregate = controller.snapshot().aggregate;
  assert.equal(aggregate.terminalOutcome?.resultKind, "success");
  assert.equal(aggregate.events.filter((item) => item.type === "turn.completed").length, 1);
});

test("an unchanged source loop is rejected without terminating the parent Turn", async () => {
  let now = 1_700;
  let id = 0;
  let revision = 0;
  let providerCalls = 0;
  const executed = [];
  const providerPolicies = [];
  const controller = new runtime.RuntimeV2Controller({
    checkpoint: {
      async load() { return null; },
      async append({ event: appended }) {
        revision += 1;
        return {
          disposition: "committed",
          checkpoint: { revision, event: appended },
        };
      },
    },
    provider: {
      async request({ command }) {
        providerCalls += 1;
        providerPolicies.push({
          expectation: command.payload.toolExpectation,
          policy: command.payload.observationPolicy,
          target: command.payload.repeatedSourceTarget,
        });
        return {
          toolCalls: [{
            id: `same-read-${providerCalls}`,
            name: "read_file",
            arguments: {
              path: providerCalls % 2 === 0
                ? "/fixture/src/main.js"
                : "src/main.js",
              start_line: providerCalls * 10,
            },
          }],
          diagnostics: [],
        };
      },
    },
    tool: {
      async execute({ command }) {
        executed.push(command);
        if (command.payload.repeatedActionRejected === true) {
          return {
            type: "tool.completed",
            run: command.run,
            idempotencyKey: command.idempotencyKey,
            status: "failed",
            failureKind: "protocol_invalid",
            evidence: [],
          };
        }
        return {
          type: "tool.completed",
          run: command.run,
          idempotencyKey: command.idempotencyKey,
          status: "succeeded",
          evidence: [{
            id: `same-source-${executed.length}`,
            kind: "source",
            target: "src/main.js",
            version: "unchanged-v1",
          }],
        };
      },
    },
    scheduler: {
      async execute() {
        throw new Error("scheduler is not expected");
      },
    },
    projection: { async publish() {} },
    clockId: {
      now: () => ++now,
      nextId: (scope) => `${scope}-same-read-${++id}`,
      nextIdempotencyKey: ({ run, kind }) =>
        `${run.runId}:${kind}:same-read:${++id}`,
    },
  });
  await controller.admit({
    turn: baseTurn,
    run: baseRun,
    strategy: "execute",
    objective: "Repair the fixture",
    acceptanceCriteria: ["Repair the fixture"],
    acceptanceCriterionIds: ["criterion-user-objective"],
    initialPhase: "observing",
  });
  for (let step = 0; step < 6; step += 1) {
    assert.equal(await controller.driveOnce(), true);
  }
  const aggregate = controller.snapshot().aggregate;
  assert.equal(executed.length, 3);
  assert.equal(
    executed[2].payload.repeatedActionReason,
    "unchanged_source_repeat",
  );
  assert.deepEqual(providerPolicies[2], {
    expectation: "required",
    policy: "different_action_or_contract_required",
    target: "src/main.js",
  });
  const next = runtime.decideNextCommands(aggregate)[0];
  assert.equal(next.kind, "request_model");
  assert.equal(next.payload.toolExpectation, "required");
  assert.equal(
    next.payload.observationPolicy,
    "execution_contract_required",
  );
  assert.deepEqual(next.payload.executionEvidenceCatalog, [
    {
      id: "same-source-1",
      kind: "source",
      target: "src/main.js",
      version: "unchanged-v1",
    },
    {
      id: "same-source-2",
      kind: "source",
      target: "src/main.js",
      version: "unchanged-v1",
    },
  ]);
  assert.equal(aggregate.terminalOutcome, null);
  assert.equal(
    aggregate.events.filter((item) =>
      item.type === "soft_signal.observed" &&
      item.signal === "repeat"
    ).length,
    1,
  );
});

test("a rejected execution contract returns its exact compiler reason to the parent", async () => {
  let state = executeAggregate("observing");
  state = runtime.transition(state, event(state, "observation.recorded", {
    run: baseRun,
    evidence: {
      id: "contract-source",
      kind: "source",
      target: "src/main.js",
      version: "source-v1",
    },
  }));
  const request = runtime.decideNextCommands(state)[0];
  state = runtime.transition(state, event(state, "command.scheduled", {
    run: baseRun,
    command: request,
  }));
  state = runtime.transition(state, event(state, "provider.responded", {
    run: baseRun,
    idempotencyKey: request.idempotencyKey,
    result: {
      toolCalls: [{
        id: "invalid-contract",
        name: "submit_execution_contract",
        arguments: {
          criteria: [{
            id: "criterion-1",
            evidence_requirement: "behavioral",
          }],
          changes: [{
            operation: "modify",
            target: "src/main.js",
            basis_evidence_ids: ["contract-source"],
          }],
          validations: [{
            id: "inspect-only",
            criterion_ids: ["criterion-1"],
            target_paths: ["src/main.js"],
            kind: "finite_command",
            command: "grep -n save src/main.js",
            expected_outcome: "Inspect the source.",
          }],
        },
      }],
      diagnostics: [],
    },
  }));

  let revision = 0;
  const controller = new runtime.RuntimeV2Controller({
    checkpoint: {
      async load() { return null; },
      async append({ event: appended }) {
        revision += 1;
        return {
          disposition: "committed",
          checkpoint: { revision, event: appended },
        };
      },
    },
    provider: {
      async request() {
        throw new Error("provider should not run while committing");
      },
    },
    tool: {
      async execute() {
        throw new Error("tool should not run while committing");
      },
    },
    scheduler: {
      async execute() {
        throw new Error("scheduler should not run while committing");
      },
    },
    projection: { async publish() {} },
    clockId: {
      now: () => state.updatedAt + revision + 1,
      nextId: (scope) => `${scope}-contract-rejection-${revision + 1}`,
      nextIdempotencyKey: ({ run, kind }) =>
        `${run.runId}:${kind}:contract-rejection`,
    },
  }, { aggregate: state, revision: 0 });

  assert.equal(await controller.driveOnce(), true);
  const aggregate = controller.snapshot().aggregate;
  const rejection = aggregate.events.find((item) =>
    item.type === "execution_contract.rejected"
  );
  assert.match(
    rejection?.reason || "",
    /finite_validation_invalid:inspect-only/,
  );
  assert.equal(aggregate.executionContract, null);
  assert.equal(aggregate.terminalOutcome, null);
  assert.equal(
    aggregate.events.filter((item) =>
      item.type === "soft_signal.observed" &&
      item.signal === "protocol_drift"
    ).length,
    1,
  );
  assert.match(
    runtime.decideNextCommands(aggregate)[0].payload
      .executionContractRejection,
    /finite_validation_invalid:inspect-only/,
  );
});

test("a missing contract basis schedules one runtime-owned exact source acquisition", () => {
  let state = executeAggregate("observing");
  state = runtime.transition(state, event(state, "execution_contract.rejected", {
    run: baseRun,
    reason:
      "RUNTIME_V2_EXECUTION_CONTRACT_INVALID:versioned_basis_missing:src/main.js",
  }));

  let next = runtime.decideNextCommands(state)[0];
  assert.equal(next.kind, "request_model");
  assert.equal(
    next.payload.observationPolicy,
    "execution_contract_source_required",
  );
  assert.equal(
    next.payload.requiredExecutionContractSourceTarget,
    "src/main.js",
  );
  assert.equal(next.payload.toolExpectation, "required");

  state = runtime.transition(state, event(state, "observation.recorded", {
    run: baseRun,
    evidence: {
      id: "source-main-after-rejection",
      kind: "source",
      target: "/fixture/src/main.js",
      version: "source-v1",
    },
  }));
  next = runtime.decideNextCommands(state)[0];
  assert.equal(
    next.payload.requiredExecutionContractSourceTarget,
    null,
  );
});

test("bounded provider transport failures close as error rather than partial", async () => {
  let now = 200;
  let id = 0;
  let revision = 0;
  const ports = {
    checkpoint: {
      async load() { return null; },
      async append({ event }) {
        revision += 1;
        return { disposition: "committed", checkpoint: { revision, event } };
      },
    },
    provider: {
      async request() {
        throw new Error("deterministic transport failure");
      },
    },
    tool: {
      async execute({ command }) {
        return {
          type: "observation.recorded",
          run: command.run,
          evidence: { id: "E1", kind: "source", target: "src/main.js", version: "v1" },
        };
      },
    },
    scheduler: {
      async execute({ command }) {
        return {
          type: "command.completed",
          run: command.run,
          idempotencyKey: command.idempotencyKey,
          status: "succeeded",
        };
      },
    },
    projection: { async publish() {} },
    clockId: {
      now: () => ++now,
      nextId: (scope) => `${scope}-${++id}`,
      nextIdempotencyKey: ({ run, kind }) => `${run.runId}:${kind}:${++id}`,
    },
  };
  const controller = new runtime.RuntimeV2Controller(ports);
  await controller.admit({ turn: baseTurn, run: baseRun, strategy: "execute", objective: "Fix it" });
  await controller.changePhase("observing", "evidence is available");
  await controller.recordObservation({
    id: "E1",
    kind: "source",
    target: "src/main.js",
    version: "v1",
  });
  await controller.driveOnce();
  await controller.driveOnce();
  await controller.driveOnce();
  await controller.driveOnce();
  await controller.driveOnce();
  const aggregate = controller.snapshot().aggregate;
  assert.equal(aggregate.phase, "completed");
  assert.equal(aggregate.terminalOutcome.resultKind, "error");
  assert.equal(aggregate.terminalOutcome.reason, "provider_transport_exhausted");
  assert.equal(aggregate.recovery.exhausted?.scope, "transport");
  assert.equal(aggregate.events.filter((event) => event.type === "turn.completed").length, 1);
});

test("provider protocol drift is recoverable action failure, not transport outage", async () => {
  let state = executeAggregate("validating");
  const command = commandFor(state, "request_model", "protocol-drift", {
    mode: "validate",
    toolExpectation: "required",
  });
  state = runtime.transition(state, event(state, "command.scheduled", {
    run: baseRun,
    command,
  }));
  const error = new runtime.RuntimeV2ProviderProtocolError(
    "tool_surface_rejected",
    "read_file is unavailable while validating",
  );
  assert.equal(runtime.isRuntimeV2ProviderProtocolError(error), true);
  assert.equal(runtime.runtimeV2RecoveryScopeForCommandFailure(command, error), "diagnostic");
  assert.equal(
    runtime.runtimeV2RecoveryScopeForCommandFailure(
      command,
      new runtime.RuntimeV2ProviderProtocolError(
        "tool_arguments_rejected",
        "cat is not validation",
      ),
    ),
    "diagnostic",
  );
  assert.equal(
    runtime.runtimeV2RecoveryScopeForCommandFailure(command, new Error("HTTP 503")),
    "transport",
  );
});

test("a failed child join is an action signal and cannot fabricate provider transport exhaustion", () => {
  const state = executeAggregate("observing");
  const command = commandFor(
    state,
    "join_subagents",
    "join-invalid-child-reference",
    {
      requestedJobIds: ["ms47dtia", "ms47f5ii"],
      jobIds: [],
    },
  );
  const error = new Error(
    "wait_subagents did not match an active child task handle",
  );

  assert.equal(
    runtime.runtimeV2RecoveryScopeForCommandFailure(command, error),
    "action",
  );
  assert.deepEqual(
    runtime.decideRuntimeV2CommandFailureRecovery({
      aggregate: state,
      command,
      error,
    }),
    {
      kind: "record",
      scope: "action",
      fingerprint:
        `action:${runtime.runtimeV2ActionFingerprint(command)}`,
      publish: true,
    },
  );
});

test("v4 checkpoints replay events, reject a tampered aggregate, and CAS append once", () => {
  let state = runtime.transition(null, event(null, "turn.admitted", {
    turn: baseTurn,
    strategy: "execute",
    objective: "Fix the fixture",
    constraints: [],
    acceptanceCriteria: [],
  }));
  state = runtime.transition(state, event(state, "run.started", { run: baseRun, phase: "preparing" }));
  const checkpoint = runtime.createRuntimeV2Checkpoint({ revision: 2, aggregate: state, updatedAt: state.updatedAt });
  assert.equal(runtime.normalizeRuntimeV2Checkpoint(checkpoint), checkpoint);
  const persisted = JSON.parse(JSON.stringify(checkpoint));
  const normalizedPersisted = runtime.normalizeRuntimeV2Checkpoint(persisted);
  assert.ok(normalizedPersisted);
  assert.notEqual(normalizedPersisted, persisted);
  assert.equal(runtime.normalizeRuntimeV2Checkpoint(normalizedPersisted), normalizedPersisted);
  const tampered = { ...checkpoint, aggregate: { ...checkpoint.aggregate, phase: "completed" } };
  assert.equal(runtime.normalizeRuntimeV2Checkpoint(tampered), null);
  const nextEvent = event(state, "phase.changed", { run: baseRun, phase: "observing", reason: "begin review" });
  const appended = runtime.appendRuntimeV2Checkpoint({
    checkpoint,
    owner: baseTurn,
    expectedRevision: checkpoint.revision,
    event: nextEvent,
  });
  assert.equal(appended.disposition, "committed");
  assert.equal(appended.checkpoint.aggregate.phase, "observing");
  const replayed = runtime.appendRuntimeV2Checkpoint({
    checkpoint: appended.checkpoint,
    owner: baseTurn,
    expectedRevision: checkpoint.revision,
    event: nextEvent,
  });
  assert.equal(replayed.disposition, "idempotent");
});

test("checkpoint capacity outlives the former 512-event runtime failure boundary", () => {
  let state = executeAggregate("observing");
  while (state.events.length < 600) {
    state = runtime.transition(state, event(
      state,
      "soft_signal.observed",
      {
        run: baseRun,
        signal: "repeat",
      },
    ));
  }
  const checkpoint = runtime.createRuntimeV2Checkpoint({
    revision: state.events.length,
    aggregate: state,
    updatedAt: state.updatedAt,
  });
  assert.equal(checkpoint.events.length, 600);
  assert.ok(runtime.MAX_RUNTIME_V2_CHECKPOINT_EVENTS >= 2_048);
});

test("v3 checkpoint migration preserves terminal history and quarantines uncontracted work", async () => {
  const asLegacyV3 = (state, revision = state.events.length) => {
    const checkpoint = runtime.createRuntimeV2Checkpoint({
      revision,
      aggregate: state,
      updatedAt: state.updatedAt,
    });
    return {
      ...JSON.parse(JSON.stringify(checkpoint)),
      schemaVersion: runtime.RUNTIME_V2_LEGACY_CHECKPOINT_SCHEMA_VERSION,
    };
  };

  let unmodified = runtime.transition(null, event(null, "turn.admitted", {
    turn: baseTurn,
    strategy: "execute",
    objective: "Repair the original user-visible save behavior",
    constraints: [],
    acceptanceCriteria: [],
  }));
  unmodified = runtime.transition(unmodified, event(unmodified, "run.started", {
    run: baseRun,
    phase: "acting",
  }));
  const legacyMutation = commandFor(
    unmodified,
    "execute_tool",
    "legacy-scheduled-mutation",
    {
      toolCallId: "legacy-scheduled-call",
      toolName: "apply_patch",
      arguments: { path: "src/main.js", patch: "@@" },
    },
  );
  unmodified = runtime.transition(unmodified, event(unmodified, "command.scheduled", {
    run: baseRun,
    command: legacyMutation,
  }));
  const migratedUnmodified = runtime.normalizeRuntimeV2Checkpoint(
    asLegacyV3(unmodified),
  );
  assert.equal(migratedUnmodified.schemaVersion, "turn-runtime-checkpoint.v4");
  assert.equal(migratedUnmodified.migrationDisposition, "active_unmodified");
  assert.deepEqual(
    migratedUnmodified.aggregate.objective.acceptanceCriteria,
    ["Repair the original user-visible save behavior"],
  );
  assert.deepEqual(
    migratedUnmodified.aggregate.objective.acceptanceCriterionIds,
    ["criterion-user-objective"],
  );

  let revision = migratedUnmodified.revision;
  let now = migratedUnmodified.updatedAt;
  let executedEffects = 0;
  const controller = new runtime.RuntimeV2Controller({
    checkpoint: {
      async load() { return migratedUnmodified; },
      async append() {
        revision += 1;
        return {
          disposition: "committed",
          checkpoint: { revision },
        };
      },
    },
    provider: {
      async request() {
        throw new Error("migration must not call the provider");
      },
    },
    tool: {
      async execute() {
        executedEffects += 1;
        throw new Error("legacy scheduled mutation must not execute");
      },
    },
    scheduler: {
      async execute() {
        executedEffects += 1;
        throw new Error("legacy scheduled scheduler effect must not execute");
      },
    },
    projection: { async publish() {} },
    clockId: {
      now: () => ++now,
      nextId: (scope) => `${scope}-migration-${now}`,
      nextIdempotencyKey: ({ run, kind }) =>
        `${run.runId}:${kind}:migration`,
    },
  }, {
    aggregate: migratedUnmodified.aggregate,
    revision: migratedUnmodified.revision,
  });
  await controller.reobserveAfterLegacyMigration();
  assert.equal(executedEffects, 0);
  assert.equal(controller.snapshot().aggregate.phase, "observing");
  assert.equal(controller.snapshot().aggregate.scheduledCommands.length, 0);
  assert.equal(
    controller.snapshot().aggregate.completedCommands.at(-1).status,
    "failed",
  );

  let mutated = executeAggregate("acting");
  mutated = runtime.transition(mutated, event(mutated, "observation.recorded", {
    run: baseRun,
    evidence: {
      id: "legacy-uncontracted-mutation",
      kind: "mutation",
      target: "src/main.js",
      version: "source-v2",
    },
  }));
  const migratedMutation = runtime.normalizeRuntimeV2Checkpoint(
    asLegacyV3(mutated),
  );
  assert.equal(
    migratedMutation.migrationDisposition,
    "active_uncontracted_mutation",
  );
  assert.equal(migratedMutation.aggregate.executionContract, null);

  let terminal = executeAggregate("acting");
  terminal = runtime.transition(terminal, event(terminal, "phase.changed", {
    run: baseRun,
    phase: "finalizing",
    reason: "legacy truthful close",
  }));
  terminal = runtime.transition(terminal, event(terminal, "run.completed", {
    run: baseRun,
    outcome: {
      resultKind: "partial",
      reason: "Legacy terminal result remains read-only.",
      completedAt: terminal.updatedAt + 1,
      finalProjectionId: "legacy-final",
    },
  }));
  const legacyTerminal = asLegacyV3(terminal);
  const migratedTerminal = runtime.normalizeRuntimeV2Checkpoint(
    legacyTerminal,
  );
  assert.equal(migratedTerminal.migrationDisposition, "terminal_read_only");
  assert.equal(
    migratedTerminal.aggregate.terminalOutcome.resultKind,
    "partial",
  );
  assert.deepEqual(migratedTerminal.events, terminal.events);
});

test("checkpoint Store adapter rebases a transient projection revision conflict", async () => {
  let revisionToken = { revision: 1 };
  let state = {
    runtimeV2Checkpoints: {},
    unrelatedState: "before-conflict",
  };
  let publicationCount = 0;
  const logs = [];
  const port = checkpointAdapter.createRuntimeV2CheckpointPort({
    get: () => state,
    set: () => {},
    scopeKey: "/fixture",
    sessionId: null,
    getSessionRevisionToken: () => revisionToken,
    sanitizeTaskBlocksForPersist: (blocks) => blocks,
    normalizeSessionRuntimeSnapshot: () => ({}),
    persistSessionRecord: async () => null,
    publishOwnerScopedRuntimeProjection(input) {
      publicationCount += 1;
      assert.equal(input.expectedRevisionToken, revisionToken);
      if (publicationCount === 1) {
        state = { ...state, unrelatedState: "changed-concurrently" };
        revisionToken = { revision: 2 };
        return { published: false, disposition: "revision_conflict" };
      }
      state = input.projectedState;
      revisionToken = { revision: 3 };
      return { published: true, disposition: "published" };
    },
    logStoreEvent(name, data) {
      logs.push({ name, data });
    },
  });
  const admitted = event(null, "turn.admitted", {
    turn: baseTurn,
    strategy: "execute",
    objective: "Fix the fixture",
    constraints: [],
    acceptanceCriteria: [],
  });

  const result = await port.append({
    owner: baseTurn,
    expectedRevision: 0,
    event: admitted,
  });

  assert.equal(result.disposition, "committed");
  assert.equal(publicationCount, 2);
  assert.equal(state.unrelatedState, "changed-concurrently");
  assert.equal(state.runtimeV2Checkpoints[baseTurn.turnId].revision, 1);
  assert.equal(
    logs.filter((entry) =>
      entry.name === "runtime_v2_checkpoint_projection_conflict"
    ).length,
    1,
  );
});

test("checkpoint Store adapter preserves a concurrent UI tick during durable persistence", async () => {
  let revisionToken = { revision: 1 };
  let state = {
    config: { sessionRecordingEnabled: true },
    runtimeV2Checkpoints: {},
    elapsedTime: 4,
    sessionsByWorkspace: {
      "/fixture": [{
        id: 7,
        messages: [],
        storageRevision: 1,
      }],
    },
  };
  let publicationCount = 0;
  const port = checkpointAdapter.createRuntimeV2CheckpointPort({
    get: () => state,
    set: () => {},
    scopeKey: "/fixture",
    sessionId: 7,
    getSessionRevisionToken: () => revisionToken,
    sanitizeTaskBlocksForPersist: (blocks) => blocks,
    normalizeSessionRuntimeSnapshot: () => ({}),
    async persistSessionRecord(_scopeKey, session) {
      state = { ...state, elapsedTime: 5 };
      revisionToken = { revision: 2 };
      return { ...session, storageRevision: 2 };
    },
    publishOwnerScopedRuntimeProjection(input) {
      publicationCount += 1;
      assert.equal(input.expectedRevisionToken, revisionToken);
      state = input.projectedState;
      revisionToken = { revision: 3 };
      return { published: true, disposition: "published" };
    },
    logStoreEvent() {},
  });
  const admitted = event(null, "turn.admitted", {
    turn: baseTurn,
    strategy: "execute",
    objective: "Fix the fixture",
    constraints: [],
    acceptanceCriteria: [],
  });

  const result = await port.append({
    owner: baseTurn,
    expectedRevision: 0,
    event: admitted,
  });

  assert.equal(result.disposition, "committed");
  assert.equal(publicationCount, 1);
  assert.equal(state.elapsedTime, 5);
  assert.equal(state.runtimeV2Checkpoints[baseTurn.turnId].revision, 1);
});

test("read-only child scheduler caps active jobs, permits path overlap, and releases capacity", () => {
  let child = 0;
  const schedule = runtime.scheduleReadOnlySubagents({
    parentRun: baseRun,
    requestedAt: 10,
    nextId: () => `child-${++child}`,
    candidates: [
      { scopeKey: "editor", objective: "Inspect editor event handlers", allowedPaths: ["src/components/editor"] },
      { scopeKey: "review-editor", objective: "Review editor event handlers", allowedPaths: ["src/components/editor"] },
      { scopeKey: "nested-editor", objective: "Third active job", allowedPaths: ["src/components/editor/panels"] },
    ],
  });
  assert.equal(schedule.jobs.length, 2);
  assert.deepEqual(schedule.rejectedScopeKeys, ["nested-editor"]);
  let jobs = schedule.jobs.map((job) => runtime.applyRuntimeV2SubagentTelemetry(job, {
    jobId: job.id, phase: "request_opened", at: 11,
  }));
  jobs = jobs.map((job) => runtime.applyRuntimeV2SubagentTelemetry(job, {
    jobId: job.id, phase: "first_token", at: 12,
  }));
  jobs[0] = runtime.applyRuntimeV2SubagentTelemetry(jobs[0], { jobId: jobs[0].id, phase: "closed", at: 20 });
  jobs[1] = runtime.applyRuntimeV2SubagentTelemetry(jobs[1], { jobId: jobs[1].id, phase: "closed", at: 21 });
  const telemetry = runtime.deriveRuntimeV2SubagentConcurrency(jobs);
  assert.equal(telemetry.peakInFlight, 2);
  assert.equal(telemetry.hasRequestOverlap, true);
  const serial = runtime.scheduleReadOnlySubagents({
    parentRun: baseRun,
    requestedAt: 22,
    nextId: () => `child-${++child}`,
    existingJobs: jobs.map((job) => ({
      ...job,
      status: "completed",
      summary: "structured report committed",
    })),
    candidates: [{
      scopeKey: "post-review",
      objective: "Validate the combined evidence",
      allowedPaths: ["src/components/editor"],
    }],
  });
  assert.equal(serial.jobs.length, 1);
  assert.deepEqual(serial.rejectedScopeKeys, []);
});

test("read-only child scheduler preserves one model-selected identity without inventing a pair", () => {
  const schedule = runtime.scheduleReadOnlySubagents({
    parentRun: baseRun,
    requestedAt: 10,
    nextId: () => "child-kepler",
    candidates: [{
      sourceToolCallId: "spawn-kepler",
      scopeKey: "save-event-consumer-audit",
      name: "Kepler",
      role: "event-flow reviewer",
      objective: "Trace the save event consumer handoff.",
      successCriteria: "Return the first unsupported transition with exact paths.",
      expectedOutput: "A sourced handoff report.",
      allowedPaths: ["src/editor"],
    }],
  });

  assert.equal(schedule.jobs.length, 1);
  assert.equal(schedule.jobs[0].sourceToolCallId, "spawn-kepler");
  assert.equal(schedule.jobs[0].scopeKey, "save-event-consumer-audit");
  assert.equal(schedule.jobs[0].name, "Kepler");
  assert.equal(schedule.jobs[0].role, "event-flow reviewer");
  assert.equal(schedule.jobs[0].objective, "Trace the save event consumer handoff.");
  assert.deepEqual(schedule.rejectedScopeKeys, []);
});

test("read-only child scheduler rejects a renamed duplicate semantic task", () => {
  const existing = runtime.scheduleReadOnlySubagents({
    parentRun: baseRun,
    requestedAt: 10,
    nextId: () => "runtime-v2-child:first",
    candidates: [{
      scopeKey: "analyze_file_open_flow",
      taskKind: "explore",
      name: "File flow analyst",
      role: "event-flow reviewer",
      objective: "Trace the file-open and save handoff in src/main.js.",
      successCriteria: "Return the first unsupported transition with evidence.",
      allowedPaths: ["."],
    }],
  }).jobs;
  const duplicate = runtime.scheduleReadOnlySubagents({
    parentRun: baseRun,
    requestedAt: 20,
    nextId: () => "runtime-v2-child:duplicate",
    existingJobs: existing,
    candidates: [{
      scopeKey: "file-open-flow-analysis",
      taskKind: "explore",
      name: "File flow analyst",
      role: "event-flow reviewer",
      objective: " Trace   the file-open and save handoff in src/main.js. ",
      successCriteria: "Return the first unsupported transition with evidence.",
      allowedPaths: ["."],
    }],
  });

  assert.deepEqual(duplicate.jobs, []);
  assert.deepEqual(
    duplicate.rejectedScopeKeys,
    ["file-open-flow-analysis"],
  );
});

test("a model wait_subagents call becomes the exact durable join command", () => {
  let state = executeAggregate("observing");
  const job = {
    id: "child-kepler",
    run: {
      ...baseRun,
      runId: "child-run-kepler",
      parentRunId: baseRun.runId,
      attemptId: "child-attempt-kepler",
    },
    parentRunId: baseRun.runId,
    sourceToolCallId: "spawn-kepler",
    scopeKey: "save-event-consumer-audit",
    name: "Kepler",
    role: "event-flow reviewer",
    objective: "Trace the save event consumer handoff.",
    allowedPaths: ["src/editor"],
    status: "queued",
    requestedAt: state.updatedAt + 1,
    firstTokenAt: null,
    closedAt: null,
    summary: null,
  };
  state = runtime.transition(state, event(state, "subagents.scheduled", {
    run: baseRun,
    jobs: [job],
  }));
  state = runtime.transition(state, event(state, "subagent.telemetry", {
    run: baseRun,
    telemetry: {
      jobId: job.id,
      phase: "request_opened",
      at: state.updatedAt + 1,
    },
  }));
  state = recordProviderResponse(state, "wait-provider", [{
    id: "wait-kepler",
    name: "wait_subagents",
    arguments: { subagent_ids: "child-kepler" },
  }]);

  const [join] = runtime.decideNextCommands(state);
  assert.equal(join.kind, "join_subagents");
  assert.equal(join.payload.toolCallId, "wait-kepler");
  assert.deepEqual(join.payload.requestedJobIds, ["child-kepler"]);
  assert.deepEqual(join.payload.jobIds, ["child-kepler"]);
});

test("wait_subagents resolves model-facing task keys and legacy unique id segments", () => {
  const buildState = (reference) => {
    let state = executeAggregate("observing");
    const job = {
      id: "runtime-v2-child:ms47dtia:82",
      run: {
        ...baseRun,
        runId: "child-run-open-flow",
        parentRunId: baseRun.runId,
        attemptId: "child-attempt-open-flow",
      },
      parentRunId: baseRun.runId,
      sourceToolCallId: "spawn-open-flow",
      scopeKey: "analyze_file_open_flow",
      objective: "Trace the file-open handoff.",
      allowedPaths: ["."],
      status: "queued",
      requestedAt: state.updatedAt + 1,
      firstTokenAt: null,
      closedAt: null,
      summary: null,
    };
    state = runtime.transition(state, event(state, "subagents.scheduled", {
      run: baseRun,
      jobs: [job],
    }));
    state = runtime.transition(state, event(state, "subagent.telemetry", {
      run: baseRun,
      telemetry: {
        jobId: job.id,
        phase: "request_opened",
        at: state.updatedAt + 1,
      },
    }));
    state = recordProviderResponse(state, `wait-${reference}`, [{
      id: `wait-call-${reference}`,
      name: "wait_subagents",
      arguments: { subagent_ids: reference },
    }]);
    return runtime.decideNextCommands(state)[0];
  };

  for (const reference of [
    "analyze_file_open_flow",
    "ms47dtia",
  ]) {
    const join = buildState(reference);
    assert.equal(join.kind, "join_subagents");
    assert.deepEqual(
      join.payload.jobIds,
      ["runtime-v2-child:ms47dtia:82"],
    );
    assert.deepEqual(join.payload.unresolvedJobIds, []);
  }
});

test("wait_subagents resolves both short handles from the latest incident in one join", () => {
  let state = executeAggregate("observing");
  const jobs = [
    {
      id: "runtime-v2-child:ms47dtia:82",
      scopeKey: "analyze_file_open_flow",
      objective: "Trace the file-open handoff.",
    },
    {
      id: "runtime-v2-child:ms47f5ii:143",
      scopeKey: "file-open-flow-analysis",
      objective: "Review the adjacent save-flow handoff.",
    },
  ].map((job, index) => ({
    ...job,
    run: {
      ...baseRun,
      runId: `child-run-incident-${index}`,
      parentRunId: baseRun.runId,
      attemptId: `child-attempt-incident-${index}`,
    },
    parentRunId: baseRun.runId,
    sourceToolCallId: `spawn-incident-${index}`,
    allowedPaths: ["."],
    status: "queued",
    requestedAt: state.updatedAt + index + 1,
    firstTokenAt: null,
    closedAt: null,
    summary: null,
  }));
  state = runtime.transition(state, event(state, "subagents.scheduled", {
    run: baseRun,
    jobs,
  }));
  for (const job of jobs) {
    state = runtime.transition(state, event(state, "subagent.telemetry", {
      run: baseRun,
      telemetry: {
        jobId: job.id,
        phase: "request_opened",
        at: state.updatedAt + 1,
      },
    }));
  }
  state = recordProviderResponse(state, "wait-latest-incident", [{
    id: "wait-latest-incident-call",
    name: "wait_subagents",
    arguments: {
      subagent_ids: "ms47dtia,ms47f5ii",
    },
  }]);

  const [join] = runtime.decideNextCommands(state);
  assert.equal(join.kind, "join_subagents");
  assert.deepEqual(join.payload.requestedJobIds, [
    "ms47dtia",
    "ms47f5ii",
  ]);
  assert.deepEqual(join.payload.jobIds, jobs.map((job) => job.id));
  assert.deepEqual(join.payload.unresolvedJobIds, []);
});

test("active children do not auto-join after one parent response but are joined before terminal", () => {
  let state = executeAggregate("observing");
  const job = {
    id: "child-kepler",
    run: {
      ...baseRun,
      runId: "child-run-kepler",
      parentRunId: baseRun.runId,
      attemptId: "child-attempt-kepler",
    },
    parentRunId: baseRun.runId,
    sourceToolCallId: "spawn-kepler",
    scopeKey: "save-event-consumer-audit",
    name: "Kepler",
    role: "event-flow reviewer",
    objective: "Trace the save event consumer handoff.",
    allowedPaths: ["src/editor"],
    status: "queued",
    requestedAt: state.updatedAt + 1,
    firstTokenAt: null,
    closedAt: null,
    summary: null,
  };
  state = runtime.transition(state, event(state, "subagents.scheduled", {
    run: baseRun,
    jobs: [job],
  }));
  state = runtime.transition(state, event(state, "subagent.telemetry", {
    run: baseRun,
    telemetry: {
      jobId: job.id,
      phase: "request_opened",
      at: state.updatedAt + 1,
    },
  }));

  const [parentModel] = runtime.decideNextCommands(state, {
    subagentPreference: "preferred",
  });
  assert.equal(parentModel.kind, "request_model");
  state = runtime.transition(state, event(state, "command.scheduled", {
    run: baseRun,
    command: parentModel,
  }));
  state = runtime.transition(state, event(state, "provider.responded", {
    run: baseRun,
    idempotencyKey: parentModel.idempotencyKey,
    result: {
      visibleText: "我已完成与子任务不重叠的父级检查。",
      toolCalls: [],
      diagnostics: [],
    },
  }));

  const [continuedParent] = runtime.decideNextCommands(state, {
    subagentPreference: "preferred",
  });
  assert.equal(continuedParent.kind, "request_model");
  const [join] = runtime.decideNextCommands(state, {
    subagentPreference: "preferred",
    resultKind: "partial",
    resultReason: "test terminal boundary",
  });
  assert.equal(join.kind, "join_subagents");
  assert.deepEqual(join.payload.jobIds, ["child-kepler"]);
  assert.equal(join.payload.toolCallId, undefined);
});

test("a failed child makes direct parent takeover explicit without concluding the Turn", () => {
  let state = executeAggregate("observing");
  const job = {
    id: "child-kepler",
    run: {
      ...baseRun,
      runId: "child-run-kepler",
      parentRunId: baseRun.runId,
      attemptId: "child-attempt-kepler",
    },
    parentRunId: baseRun.runId,
    scopeKey: "save-event-consumer-audit",
    name: "Kepler",
    objective: "Trace the save event consumer handoff.",
    allowedPaths: ["src/editor"],
    status: "queued",
    requestedAt: state.updatedAt + 1,
    firstTokenAt: null,
    closedAt: null,
    summary: null,
  };
  state = runtime.transition(state, event(state, "subagents.scheduled", {
    run: baseRun,
    jobs: [job],
  }));
  state = runtime.transition(state, event(state, "subagent.telemetry", {
    run: baseRun,
    telemetry: {
      jobId: job.id,
      phase: "request_opened",
      at: state.updatedAt + 1,
    },
  }));
  state = runtime.transition(state, event(state, "subagent.telemetry", {
    run: baseRun,
    telemetry: {
      jobId: job.id,
      phase: "closed",
      at: state.updatedAt + 2,
    },
  }));
  state = runtime.transition(state, event(state, "subagent.completed", {
    run: baseRun,
    jobId: job.id,
    status: "failed",
    summary:
      "No structured report; retained evidence for parent takeover.",
    evidence: [{
      id: "child:child-kepler:E1",
      kind: "subagent",
      target: "src/editor/save.ts",
      version: "v1",
    }],
  }));

  const parent = runtime.decideNextCommands(state, {
    subagentPreference: "preferred",
  })[0];
  assert.equal(parent.kind, "request_model");
  assert.equal(
    parent.payload.collaborationAction,
    "parent_takeover_required",
  );
  assert.deepEqual(parent.payload.activeSubagents, []);
  assert.equal(parent.payload.remainingSubagentCapacity, 0);
  assert.equal(
    parent.payload.failedSubagents[0].id,
    "save-event-consumer-audit",
  );
  assert.equal(state.terminalOutcome, null);

  const shiftedPhase = {
    ...state,
    phase: "acting",
    events: [
      ...state.events,
      event(state, "phase.changed", {
        run: baseRun,
        phase: "acting",
        reason: "validation_requires_correction",
      }),
    ],
  };
  const afterPhaseChange = runtime.decideNextCommands(shiftedPhase, {
    subagentPreference: "preferred",
  })[0];
  assert.equal(
    afterPhaseChange.payload.collaborationAction,
    "parent_takeover_required",
    "changing phase must not erase the failed-child takeover obligation",
  );
  assert.equal(afterPhaseChange.payload.remainingSubagentCapacity, 0);

  const afterParentProgress = {
    ...shiftedPhase,
    events: [
      ...shiftedPhase.events,
      event(shiftedPhase, "tool.completed", {
        run: baseRun,
        idempotencyKey: "parent-takeover-read",
        status: "succeeded",
        evidence: [{
          id: "parent-E2",
          kind: "source",
          target: "src/editor/save.ts",
          version: "v2",
        }],
      }),
    ],
  };
  const reopened = runtime.decideNextCommands(afterParentProgress, {
    subagentPreference: "preferred",
  })[0];
  assert.equal(reopened.payload.collaborationAction, "optional");
  assert.equal(reopened.payload.remainingSubagentCapacity, 2);
});

test("a failed spawn action closes delegation for the phase and leaves parent takeover active", () => {
  let state = executeAggregate("observing");
  const spawn = commandFor(
    state,
    "schedule_subagents",
    "failed-spawn",
    {
      toolCallId: "failed-spawn-call",
      arguments: {},
    },
  );
  state = runtime.transition(state, event(state, "command.scheduled", {
    run: baseRun,
    command: spawn,
  }));
  state = runtime.transition(state, event(state, "command.completed", {
    run: baseRun,
    idempotencyKey: spawn.idempotencyKey,
    status: "failed",
  }));

  const parent = runtime.decideNextCommands(state, {
    subagentPreference: "preferred",
  })[0];
  assert.equal(parent.kind, "request_model");
  assert.equal(
    parent.payload.collaborationAction,
    "parent_takeover_required",
  );
  assert.equal(parent.payload.remainingSubagentCapacity, 0);
  assert.deepEqual(parent.payload.activeSubagents, []);
  assert.equal(state.terminalOutcome, null);
});

test("Execute phase policy advances completed observation into acting without requiring a pending mutation", () => {
  let state = executeAggregate("observing");
  state = runtime.transition(state, event(state, "observation.recorded", {
    run: baseRun,
    evidence: { id: "phase-E1", kind: "source", target: "src/main.js", version: "v1" },
  }));
  state = withExecutionContract(state);
  state = recordProviderResponse(state, "observe-complete");

  assert.deepEqual(runtime.decideRuntimeV2ExecutePhaseTransition(state, {
    isMutationToolName: (name) => name === "apply_patch",
  }), {
    from: "observing",
    to: "acting",
    reason: "observation_cycle_complete",
  });
});

test("initial observation completion is scoped to the current execution boundary", () => {
  let state = executeAggregate("preparing");
  const collect = commandFor(
    state,
    "collect_observation",
    "collect-current-overview",
    { objective: "Inspect the workspace" },
  );
  state = runtime.transition(state, event(state, "command.scheduled", {
    run: baseRun,
    command: collect,
  }));
  state = runtime.transition(state, event(state, "command.completed", {
    run: baseRun,
    idempotencyKey: collect.idempotencyKey,
    status: "succeeded",
  }));
  assert.equal(runtime.hasCompletedRuntimeV2InitialObservation(state), true);

  const approvalBoundary = {
    ...event(state, "work_plan.approved", { run: baseRun }),
    sequence: state.nextSequence,
  };
  const approvedState = {
    ...state,
    events: [...state.events, approvalBoundary],
    nextSequence: state.nextSequence + 1,
    updatedAt: approvalBoundary.at,
  };
  assert.equal(
    runtime.hasCompletedRuntimeV2InitialObservation(approvedState),
    false,
  );
});

test("Execute phase policy lets the parent advance independently while children remain active", () => {
  let state = executeAggregate("observing");
  state = runtime.transition(state, event(state, "observation.recorded", {
    run: baseRun,
    evidence: { id: "phase-E2", kind: "source", target: "src", version: "v1" },
  }));
  state = withExecutionContract(state);
  state = recordProviderResponse(state, "observe-with-children");
  const children = ["frontend", "backend"].map((scopeKey, index) => ({
    id: `phase-child-${index + 1}`,
    run: {
      ...baseRun,
      runId: `phase-child-run-${index + 1}`,
      parentRunId: baseRun.runId,
      attemptId: `phase-child-attempt-${index + 1}`,
    },
    parentRunId: baseRun.runId,
    scopeKey,
    objective: `Inspect ${scopeKey}`,
    allowedPaths: [index === 0 ? "src" : "src-tauri"],
    status: index === 0 ? "completed" : "running",
    requestedAt: 10,
    firstTokenAt: 11,
    closedAt: index === 0 ? 12 : null,
    summary: index === 0 ? "done" : null,
  }));
  const classifier = { isMutationToolName: (name) => name === "apply_patch" };

  assert.deepEqual(runtime.decideRuntimeV2ExecutePhaseTransition({
    ...state,
    subagents: children,
  }, classifier), {
    from: "observing",
    to: "acting",
    reason: "observation_cycle_complete",
  });
  assert.deepEqual(runtime.decideRuntimeV2ExecutePhaseTransition({
    ...state,
    subagents: children.map((job, index) => ({
      ...job,
      status: index === 0 ? "completed" : "failed",
      closedAt: 12 + index,
      summary: index === 0 ? "done" : "failed with evidence retained",
    })),
  }, classifier), {
    from: "observing",
    to: "acting",
    reason: "observation_cycle_complete",
  });
});

test("Execute phase policy may enter acting while a read-only child remains active", () => {
  let state = executeAggregate("observing");
  state = runtime.transition(state, event(state, "observation.recorded", {
    run: baseRun,
    evidence: {
      id: "active-child-source",
      kind: "source",
      target: "src/main.js",
      version: "v1",
    },
  }));
  state = withExecutionContract(state);
  state = recordProviderResponse(state, "observe-premature-mutation", [{
    id: "premature-mutation-call",
    name: "apply_patch",
    arguments: { patch: "*** Begin Patch\n*** End Patch" },
  }]);
  state = {
    ...state,
    subagents: [{
      id: "active-child",
      run: {
        ...baseRun,
        runId: "active-child-run",
        parentRunId: baseRun.runId,
        attemptId: "active-child-attempt",
      },
      parentRunId: baseRun.runId,
      scopeKey: "frontend",
      objective: "Inspect frontend",
      allowedPaths: ["src"],
      status: "running",
      requestedAt: 10,
      firstTokenAt: 11,
      closedAt: null,
      summary: null,
    }],
  };
  assert.deepEqual(runtime.decideRuntimeV2ExecutePhaseTransition(state, {
    isMutationToolName: (name) => name === "apply_patch",
  }), {
    from: "observing",
    to: "acting",
    reason: "pending_mutation_call",
  });
});

test("Execute phase policy moves a pending mutation into acting immediately", () => {
  let state = executeAggregate("observing");
  state = runtime.transition(state, event(state, "observation.recorded", {
    run: baseRun,
    evidence: {
      id: "pending-mutation-source",
      kind: "source",
      target: "src/main.js",
      version: "v1",
    },
  }));
  state = withExecutionContract(state);
  state = recordProviderResponse(state, "observe-mutation", [{
    id: "mutation-call",
    name: "apply_patch",
    arguments: { path: "src/main.js", patch: "@@" },
  }]);

  assert.deepEqual(runtime.decideRuntimeV2ExecutePhaseTransition(state, {
    isMutationToolName: (name) => name === "apply_patch",
  }), {
    from: "observing",
    to: "acting",
    reason: "pending_mutation_call",
  });
});

test("Execute phase policy advances a committed mutation into validation", () => {
  let state = executeAggregate("acting");
  state = runtime.transition(state, event(state, "observation.recorded", {
    run: baseRun,
    evidence: {
      id: "mutation-source",
      kind: "source",
      target: "src/main.js",
      version: "v1",
    },
  }));
  state = withExecutionContract(state);
  const mutation = commandFor(state, "execute_tool", "apply-mutation", {
    toolCallId: "mutation-call",
    toolName: "apply_patch",
    arguments: { path: "src/main.js", patch: "@@" },
  });
  state = runtime.transition(state, event(state, "command.scheduled", {
    run: baseRun,
    command: mutation,
  }));
  state = runtime.transition(state, event(state, "tool.completed", {
    run: baseRun,
    idempotencyKey: mutation.idempotencyKey,
    status: "succeeded",
    evidence: [{ id: "phase-E3", kind: "mutation", target: "src/main.js", version: "v2" }],
  }));

  assert.deepEqual(runtime.decideRuntimeV2ExecutePhaseTransition(state, {
    isMutationToolName: (name) => name === "apply_patch",
  }), {
    from: "acting",
    to: "validating",
    reason: "mutation_committed",
  });
});

test("an approved Plan without a sealed authority cannot advance on a mutation alone", () => {
  const classifier = { isMutationToolName: (name) => name === "apply_patch" };
  let state = {
    ...executeAggregate("acting"),
    strategy: "plan",
    workPlan: {
      id: "work-plan-approved",
      revision: 1,
      digest: "digest-approved",
      projectionHash: "projection-approved",
      status: "approved",
    },
  };
  const mutation = commandFor(state, "execute_tool", "approved-plan-mutation", {
    toolCallId: "approved-plan-call",
    toolName: "apply_patch",
    arguments: { patch: "*** Begin Patch\n*** End Patch" },
  });
  state = runtime.transition(state, event(state, "command.scheduled", {
    run: baseRun,
    command: mutation,
  }));
  state = runtime.transition(state, event(state, "tool.completed", {
    run: baseRun,
    idempotencyKey: mutation.idempotencyKey,
    status: "succeeded",
    evidence: [{ id: "approved-M1", kind: "mutation", target: "src/main.js", version: "v2" }],
  }));
  assert.equal(
    runtime.decideRuntimeV2ExecutePhaseTransition(state, classifier),
    null,
  );
});

function approvedTwoTargetPlanAggregate(initialPhase = "acting") {
  const sealed = runtime.sealWorkPlanV1({
    draft: {
      schemaVersion: runtime.WORK_PLAN_V1_SCHEMA_VERSION,
      objective: "Repair two related files",
      summary: "Apply the reviewed changes and run the reviewed build.",
      findings: [],
      steps: [
        {
          title: "Repair frontend",
          operation: "modify",
          targets: ["src/main.js"],
          basis: ["E-main"],
          change: "Unify the file lifecycle.",
          expectedOutcome: "Only the opened file is visible.",
          dependsOn: [],
        },
        {
          title: "Repair editor",
          operation: "modify",
          targets: ["src/components/editor.js"],
          basis: ["E-editor"],
          change: "Preserve the opened file path.",
          expectedOutcome: "Save does not open for an existing file.",
          dependsOn: [0],
        },
      ],
      validations: [{
        stepIndexes: [0, 1],
        kind: "finite_command",
        command: "npm run build",
        cwd: ".",
        expectedOutcome: "Build succeeds.",
        required: true,
      }],
      risks: [],
      assumptions: [],
      blockingQuestions: [],
    },
    evidence: [
      {
        id: "E-main",
        target: "src/main.js",
        version: "sha256-main-reviewed",
        statement: "Reviewed the current frontend source.",
      },
      {
        id: "E-editor",
        target: "src/components/editor.js",
        version: "sha256-editor-reviewed",
        statement: "Reviewed the current editor source.",
      },
    ],
    id: "WP-two-targets",
    revision: 1,
    createdAt: 20,
  });
  const state = executeAggregate(initialPhase);
  return {
    ...state,
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
  const mutation = commandFor(state, "execute_tool", key, {
    toolCallId: `${key}-call`,
    toolName: "apply_patch",
    arguments: {
      patch: `*** Begin Patch\n*** Update File: ${target}\n@@\n-old\n+new\n*** End Patch`,
    },
  });
  state = runtime.transition(state, event(state, "command.scheduled", {
    run: baseRun,
    command: mutation,
  }));
  return runtime.transition(state, event(state, "tool.completed", {
    run: baseRun,
    idempotencyKey: mutation.idempotencyKey,
    status: "succeeded",
    evidence: [{
      id: `${key}-evidence`,
      kind: "mutation",
      target,
      version: "changed",
    }],
  }));
}

function commitSourceRead(state, key, target, version) {
  const read = commandFor(state, "execute_tool", key, {
    toolCallId: `${key}-call`,
    toolName: "read_file",
    arguments: { path: target },
  });
  state = runtime.transition(state, event(state, "command.scheduled", {
    run: baseRun,
    command: read,
  }));
  return runtime.transition(state, event(state, "tool.completed", {
    run: baseRun,
    idempotencyKey: read.idempotencyKey,
    status: "succeeded",
    evidence: [{
      id: `${key}-evidence`,
      kind: "source",
      target,
      version,
    }],
  }));
}

test("approved Plan requires fresh reviewed source versions before its first mutation", () => {
  let state = approvedTwoTargetPlanAggregate("acting");
  assert.deepEqual(
    runtime.deriveRuntimeV2PlanSourceFreshness(state).missingTargets,
    ["src/main.js", "src/components/editor.js"],
  );

  state = commitSourceRead(
    state,
    "read-main-current",
    "src/main.js",
    "sha256-main-reviewed",
  );
  assert.deepEqual(
    runtime.deriveRuntimeV2PlanSourceFreshness(state).missingTargets,
    ["src/components/editor.js"],
  );

  state = commitSourceRead(
    state,
    "read-editor-stale",
    "src/components/editor.js",
    "sha256-editor-changed",
  );
  const stale = runtime.deriveRuntimeV2PlanSourceFreshness(state);
  assert.equal(stale.allFresh, false);
  assert.deepEqual(stale.staleTargets, ["src/components/editor.js"]);

  state = commitSourceRead(
    state,
    "read-editor-current",
    "src/components/editor.js",
    "sha256-editor-reviewed",
  );
  assert.equal(runtime.deriveRuntimeV2PlanSourceFreshness(state).allFresh, true);
});

test("approved Plan remains in acting until every reviewed mutation target is committed", () => {
  const classifier = { isMutationToolName: (name) => name === "apply_patch" };
  let state = approvedTwoTargetPlanAggregate("acting");
  state = commitMutation(state, "mutate-main", "src/main.js");
  assert.equal(
    runtime.decideRuntimeV2ExecutePhaseTransition(state, classifier),
    null,
  );
  assert.deepEqual(
    runtime.deriveRuntimeV2PlanExecutionCoverage(state).missingMutationTargets,
    ["src/components/editor.js"],
  );

  state = commitMutation(state, "mutate-editor", "src/components/editor.js");
  assert.deepEqual(runtime.decideRuntimeV2ExecutePhaseTransition(state, classifier), {
    from: "acting",
    to: "validating",
    reason: "mutation_committed",
  });
});

test("approved Plan scope rejects unreviewed files and non-matching validation commands", () => {
  const state = approvedTwoTargetPlanAggregate();
  assert.equal(runtime.resolveRuntimeV2PlanMutationScope({
    plan: state.sealedWorkPlan,
    requestedTargets: ["src/main.js"],
  }).allowed, true);
  assert.deepEqual(runtime.resolveRuntimeV2PlanMutationScope({
    plan: state.sealedWorkPlan,
    requestedTargets: ["src/main.js", "src/extra.js"],
  }).unexpectedTargets, ["src/extra.js"]);
  assert.equal(runtime.resolveRuntimeV2PlanValidationScope({
    plan: state.sealedWorkPlan,
    toolName: "run_command",
    args: { command: "npm run build", cwd: "." },
  }).allowed, true);
  assert.equal(runtime.resolveRuntimeV2PlanValidationScope({
    plan: state.sealedWorkPlan,
    toolName: "run_command",
    args: { command: "npm test", cwd: "." },
  }).allowed, false);
});

test("approved Plan acceptance requires the reviewed validation after the latest mutation", () => {
  let state = approvedTwoTargetPlanAggregate("acting");
  state = commitMutation(state, "mutate-main-coverage", "src/main.js");
  state = commitMutation(state, "mutate-editor-coverage", "src/components/editor.js");
  state = runtime.transition(state, event(state, "phase.changed", {
    run: baseRun,
    phase: "validating",
    reason: "all reviewed targets changed",
  }));
  const wrongValidation = commandFor(state, "execute_validation", "wrong-validation", {
    toolCallId: "wrong-validation-call",
    toolName: "run_command",
    arguments: { command: "npm test", cwd: "." },
  });
  state = runtime.transition(state, event(state, "command.scheduled", {
    run: baseRun,
    command: wrongValidation,
  }));
  state = runtime.transition(state, event(state, "validation.completed", {
    run: baseRun,
    idempotencyKey: wrongValidation.idempotencyKey,
    passed: true,
    evidence: [{ id: "wrong-V", kind: "validation", target: "npm test", version: null }],
  }));
  assert.equal(
    runtime.deriveRuntimeV2PlanExecutionCoverage(state).allRequiredValidationsPassed,
    false,
  );

  const reviewedValidation = commandFor(state, "execute_validation", "reviewed-validation", {
    toolCallId: "reviewed-validation-call",
    toolName: "run_command",
    arguments: { command: "npm run build", cwd: "." },
  });
  state = runtime.transition(state, event(state, "command.scheduled", {
    run: baseRun,
    command: reviewedValidation,
  }));
  state = runtime.transition(state, event(state, "validation.completed", {
    run: baseRun,
    idempotencyKey: reviewedValidation.idempotencyKey,
    passed: true,
    evidence: [{ id: "reviewed-V", kind: "validation", target: "npm run build", version: null }],
    authority: {
      kind: "work_plan",
      id: state.sealedWorkPlan.id,
      revision: state.sealedWorkPlan.revision,
      digest: state.sealedWorkPlan.digest,
      validationId: "work-plan-validation-1",
      criterionIds: ["work-plan-validation-1"],
      targetPaths: ["src/main.js", "src/components/editor.js"],
    },
  }));
  assert.equal(
    runtime.deriveRuntimeV2PlanExecutionCoverage(state).allRequiredValidationsPassed,
    true,
  );

  state = runtime.transition(state, event(state, "phase.changed", {
    run: baseRun,
    phase: "acting",
    reason: "a later correction is required",
  }));
  state = commitMutation(state, "later-correction", "src/main.js");
  assert.equal(
    runtime.deriveRuntimeV2PlanExecutionCoverage(state).allRequiredValidationsPassed,
    false,
  );
});

test("a rejected validation call returns to acting recovery instead of looping in validation", () => {
  let state = executeAggregate("validating");
  const validation = commandFor(state, "execute_validation", "validation-scope-rejected", {
    toolCallId: "validation-scope-call",
    toolName: "run_command",
    arguments: { command: "npm test" },
  });
  state = runtime.transition(state, event(state, "command.scheduled", {
    run: baseRun,
    command: validation,
  }));
  state = runtime.transition(state, event(state, "validation.completed", {
    run: baseRun,
    idempotencyKey: validation.idempotencyKey,
    passed: false,
    failureKind: "not_authorized",
    evidence: [],
  }));
  assert.deepEqual(runtime.decideRuntimeV2ExecutePhaseTransition(state, {
    isMutationToolName: (name) => name === "apply_patch",
  }), {
    from: "validating",
    to: "acting",
    reason: "validation_failed",
  });
});

test("validation retries retain the declared contract primitive and authorized browser target", () => {
  let state = executeAggregate("validating");
  state = runtime.transition(state, event(state, "observation.recorded", {
    run: baseRun,
    evidence: {
      id: "validation-contract-source",
      kind: "source",
      target: "src/main.js",
      version: "main-v1",
    },
  }));
  state = withExecutionContract(state);
  const validation = commandFor(
    state,
    "execute_validation",
    "validation-browser-retry",
    {
      toolCallId: "validation-browser-call",
      toolName: "browser_evaluate",
      arguments: {
        url: "file:///fixture/index.html",
        actions: "click: #open-file",
        checks: "text: opened.md",
      },
    },
  );
  state = runtime.transition(state, event(state, "command.scheduled", {
    run: baseRun,
    command: validation,
  }));
  state = runtime.transition(state, event(state, "validation.completed", {
    run: baseRun,
    idempotencyKey: validation.idempotencyKey,
    passed: false,
    failureKind: "assertion_failed",
    evidence: [{
      id: "validation-browser-failed",
      kind: "validation",
      target: "file:///fixture/index.html",
      version: "failed-v1",
    }],
  }));

  const [next] = runtime.decideNextCommands(state);
  assert.equal(
    next.payload.validationRetryTarget,
    "file:///fixture/index.html",
  );
  assert.equal(
    next.payload.activeExecutionContractDraft.validations[0].id,
    "validation-1",
  );
});

test("Execute phase policy returns failed validation to acting without replaying stale failures", () => {
  const classifier = { isMutationToolName: (name) => name === "apply_patch" };
  let state = executeAggregate("validating");
  const validation = commandFor(state, "execute_validation", "validate-build", {
    toolCallId: "validation-call",
    toolName: "run_command",
    arguments: { command: "npm run build" },
  });
  state = runtime.transition(state, event(state, "command.scheduled", {
    run: baseRun,
    command: validation,
  }));
  state = runtime.transition(state, event(state, "validation.completed", {
    run: baseRun,
    idempotencyKey: validation.idempotencyKey,
    passed: false,
    evidence: [{ id: "phase-E4", kind: "validation", target: "npm run build", version: "failed" }],
  }));

  assert.deepEqual(runtime.decideRuntimeV2ExecutePhaseTransition(state, classifier), {
    from: "validating",
    to: "acting",
    reason: "validation_failed",
  });

  state = runtime.transition(state, event(state, "phase.changed", {
    run: baseRun,
    phase: "acting",
    reason: "repair the failed validation",
  }));
  state = runtime.transition(state, event(state, "phase.changed", {
    run: baseRun,
    phase: "validating",
    reason: "validate the correction",
  }));
  assert.equal(runtime.decideRuntimeV2ExecutePhaseTransition(state, classifier), null);

  let passing = executeAggregate("validating");
  const passingValidation = commandFor(passing, "execute_validation", "validate-pass", {
    toolCallId: "validation-pass-call",
    toolName: "run_command",
    arguments: { command: "npm run build" },
  });
  passing = runtime.transition(passing, event(passing, "command.scheduled", {
    run: baseRun,
    command: passingValidation,
  }));
  passing = runtime.transition(passing, event(passing, "validation.completed", {
    run: baseRun,
    idempotencyKey: passingValidation.idempotencyKey,
    passed: true,
    evidence: [{ id: "phase-E5", kind: "validation", target: "npm run build", version: "passed" }],
  }));
  assert.equal(runtime.decideRuntimeV2ExecutePhaseTransition(passing, classifier), null);
});

test("Execute completion facts are reconstructed from durable mutation and validation receipts", () => {
  const classifier = { isMutationToolName: (name) => name === "apply_patch" };
  let state = executeAggregate("acting");
  const mutation = commandFor(state, "execute_tool", "mutation-durable", {
    toolCallId: "mutation-call",
    toolName: "apply_patch",
    arguments: { patch: "*** Begin Patch\n*** End Patch" },
  });
  state = runtime.transition(state, event(state, "command.scheduled", {
    run: baseRun,
    command: mutation,
  }));
  state = runtime.transition(state, event(state, "tool.completed", {
    run: baseRun,
    idempotencyKey: mutation.idempotencyKey,
    status: "succeeded",
    evidence: [{ id: "M1", kind: "mutation", target: "src/main.js", version: "v2" }],
  }));
  state = runtime.transition(state, event(state, "phase.changed", {
    run: baseRun,
    phase: "validating",
    reason: "mutation_committed",
  }));
  const validation = commandFor(state, "execute_validation", "validation-durable", {
    toolCallId: "validation-call",
    toolName: "run_command",
    arguments: { command: "npm test" },
  });
  state = runtime.transition(state, event(state, "command.scheduled", {
    run: baseRun,
    command: validation,
  }));
  state = runtime.transition(state, event(state, "validation.completed", {
    run: baseRun,
    idempotencyKey: validation.idempotencyKey,
    passed: true,
    evidence: [{ id: "V1", kind: "validation", target: "npm test", version: null }],
  }));

  assert.deepEqual(runtime.summarizeRuntimeV2ExecuteEvidence(state, classifier), {
    mutationCount: 1,
    passedValidationCount: 1,
    failedValidationCount: 0,
    stalledValidationCount: 0,
    failedOperationCount: 0,
  });
});

test("runtime-owned plan artifact writes are not counted as project mutations", () => {
  const classifier = { isMutationToolName: (name) => name === "write_file" };
  let state = executeAggregate("acting");
  const artifact = commandFor(state, "execute_tool", "runtime-plan-artifact", {
    toolName: "write_file",
    target: ".MAIN/plans/plan.md",
    runtimeOwnedPlanArtifact: true,
  });
  state = runtime.transition(state, event(state, "command.scheduled", {
    run: baseRun,
    command: artifact,
  }));
  state = runtime.transition(state, event(state, "tool.completed", {
    run: baseRun,
    idempotencyKey: artifact.idempotencyKey,
    status: "succeeded",
    evidence: [{
      id: "plan-artifact",
      kind: "tool",
      target: ".MAIN/plans/plan.md",
      version: "projection-v1",
    }],
  }));

  assert.deepEqual(runtime.summarizeRuntimeV2ExecuteEvidence(state, classifier), {
    mutationCount: 0,
    passedValidationCount: 0,
    failedValidationCount: 0,
    stalledValidationCount: 0,
    failedOperationCount: 0,
  });
});

test("completion gate rejects generic mutation and validation counts without contract coverage", () => {
  let state = runtime.transition(null, event(null, "turn.admitted", {
    turn: baseTurn,
    strategy: "execute",
    objective: "Repair the fixture",
    constraints: [],
    acceptanceCriteria: [],
  }));
  state = runtime.transition(state, event(state, "run.started", { run: baseRun, phase: "observing" }));

  assert.equal(runtime.decideRuntimeV2TerminalOutcome(state, {
    canceled: false,
    mutationCount: 0,
    passedValidationCount: 0,
    failedValidationCount: 0,
    stalledValidationCount: 0,
    hasProviderConclusion: true,
  }), null);

  assert.equal(runtime.decideRuntimeV2TerminalOutcome(state, {
    canceled: false,
    mutationCount: 1,
    passedValidationCount: 1,
    failedValidationCount: 0,
    stalledValidationCount: 0,
    hasProviderConclusion: true,
  }), null);
});

test("execution contract prevents a provider from downgrading behavioral acceptance to static build proof", () => {
  const objective = {
    text: "Opening a file must not trigger a save dialog.",
    constraints: [],
    acceptanceCriteria: [
      "Opening a local file leaves the document clean and shows no save dialog.",
    ],
    acceptanceCriterionIds: ["criterion-open-clean"],
  };
  const evidence = [{
    id: "source-main-v1",
    kind: "source",
    target: "src/main.js",
    version: "sha-v1",
  }];
  assert.throws(
    () => runtime.compileRuntimeV2ExecutionContract({
      objective,
      evidence,
      draft: {
        criteria: [{
          id: "criterion-open-clean",
          evidence_requirement: "static",
        }],
        changes: [{
          operation: "modify",
          target: "src/main.js",
          basis_evidence_ids: ["source-main-v1"],
        }],
        validations: [{
          id: "validation-build-only",
          criterion_ids: ["criterion-open-clean"],
          target_paths: ["src/main.js"],
          kind: "finite_command",
          command: "npm run build",
          cwd: ".",
          expected_outcome: "The build succeeds.",
        }],
      },
      committedAt: 2,
      contractId: "contract-build-only",
    }),
    /criterion_not_acceptance_covered:criterion-open-clean/,
  );
});

test("a sole runtime criterion needs no provider-owned identity echo", () => {
  const contract = runtime.compileRuntimeV2ExecutionContract({
    objective: {
      text: "Opening a file must not trigger a save dialog.",
      constraints: [],
      acceptanceCriteria: [
        "Opening a local file leaves the document clean and shows no save dialog.",
      ],
      acceptanceCriterionIds: ["criterion-open-clean"],
    },
    evidence: [{
      id: "source-main-v1",
      kind: "source",
      target: "src/main.js",
      version: "sha-v1",
    }],
    draft: {
      criteria: [],
      changes: [{
        operation: "modify",
        target: "src/main.js",
        basis_evidence_ids: ["source-main-v1"],
      }],
      validations: [{
        id: "validation-behavior",
        criterion_ids: [],
        target_paths: ["src/main.js"],
        kind: "finite_command",
        command: "npm test",
        cwd: ".",
        expected_outcome: "The behavioral test passes.",
      }],
    },
    committedAt: 2,
    contractId: "contract-sole-criterion",
  });
  assert.deepEqual(
    contract.criteria.map((criterion) => ({
      id: criterion.id,
      requirement: criterion.evidenceRequirement,
    })),
    [{
      id: "criterion-open-clean",
      requirement: "behavioral",
    }],
  );
  assert.deepEqual(
    contract.validations[0].criterionIds,
    ["criterion-open-clean"],
  );
});

test("multiple runtime criteria still reject provider aliases", () => {
  assert.throws(
    () => runtime.compileRuntimeV2ExecutionContract({
      objective: {
        text: "Repair both behaviors.",
        constraints: [],
        acceptanceCriteria: ["Behavior A passes.", "Behavior B passes."],
        acceptanceCriterionIds: ["criterion-a", "criterion-b"],
      },
      evidence: [{
        id: "source-main-v1",
        kind: "source",
        target: "src/main.js",
        version: "sha-v1",
      }],
      draft: {
        criteria: [{
          id: "provider-a",
          evidence_requirement: "behavioral",
        }, {
          id: "provider-b",
          evidence_requirement: "behavioral",
        }],
        changes: [{
          operation: "modify",
          target: "src/main.js",
          basis_evidence_ids: ["source-main-v1"],
        }],
        validations: [{
          id: "validation-behavior",
          criterion_ids: ["provider-a", "provider-b"],
          target_paths: ["src/main.js"],
          kind: "finite_command",
          command: "npm test",
          cwd: ".",
          expected_outcome: "Both behavioral tests pass.",
        }],
      },
      committedAt: 2,
      contractId: "contract-multiple-criteria",
    }),
    /criterion_requirement_missing:criterion-a/,
  );
});

test("execution contract binds mutation authority to the target's real source receipt", () => {
  const objective = {
    text: "Repair the file behavior.",
    constraints: [],
    acceptanceCriteria: ["The repaired behavior passes its test."],
    acceptanceCriterionIds: ["criterion-behavior"],
  };
  const contract = runtime.compileRuntimeV2ExecutionContract({
    objective,
    evidence: [{
      id: "source-other",
      kind: "source",
      target: "src/other.js",
      version: "other-v1",
    }, {
      id: "source-main",
      kind: "source",
      target: "/fixture/src/main.js",
      version: "main-v1",
    }],
    draft: {
      criteria: [{
        id: "criterion-behavior",
        evidence_requirement: "behavioral",
      }],
      changes: [{
        operation: "modify",
        target: "src/main.js",
        basis_evidence_ids: ["source-other", "provider-invented-id"],
      }],
      validations: [{
        id: "validation-behavior",
        criterion_ids: ["criterion-behavior"],
        target_paths: ["src/main.js"],
        kind: "finite_command",
        command: "npm test",
        cwd: ".",
        expected_outcome: "The behavioral test passes.",
      }],
    },
    committedAt: 2,
    contractId: "contract-runtime-basis",
  });
  assert.deepEqual(
    contract.changes[0].basisEvidenceIds,
    ["source-main"],
  );
});

test("execution contract persists an acceptance-capable interaction primitive", () => {
  const objective = {
    text: "Opening a file keeps the document clean.",
    constraints: [],
    acceptanceCriteria: ["No save dialog appears after opening a file."],
    acceptanceCriterionIds: ["criterion-open-clean"],
    acceptanceEvidenceRequirements: ["interaction"],
  };
  const contract = runtime.compileRuntimeV2ExecutionContract({
    objective,
    evidence: [{
      id: "source-open-v1",
      kind: "source",
      target: "src/main.js",
      version: "sha-v1",
    }],
    draft: {
      criteria: [{
        id: "criterion-open-clean",
        evidence_requirement: "interaction",
      }],
      changes: [{
        operation: "modify",
        target: "src/main.js",
        basis_evidence_ids: ["source-open-v1"],
      }],
      validations: [{
        id: "validation-open-clean",
        criterion_ids: ["criterion-open-clean"],
        target_paths: ["src/main.js"],
        kind: "browser",
        actions: [{
          id: "open-file",
          kind: "click",
          target: "#open-file",
        }],
        assertions: [{
          kind: "dialog",
          target: "save-dialog",
          after_action_id: "open-file",
          expected: "hidden",
        }],
        require_causal_assertion: true,
        expected_outcome: "Opening a file does not display a save dialog.",
      }],
    },
    committedAt: 2,
    contractId: "contract-open-clean",
  });
  assert.equal(
    contract.validations[0].primitive.kind,
    "browser_interaction",
  );
  assert.equal(
    contract.validations[0].primitive.requireCausalAssertion,
    true,
  );
  assert.equal(runtime.validateRuntimeV2ExecutionContract({
    contract,
    objective,
    evidence: [{
      id: "source-open-v1",
      kind: "source",
      target: "src/main.js",
      version: "sha-v1",
    }],
  }), true);
});

test("execution contract revisions are free before mutation and need fresh cited source evidence after it", () => {
  let state = executeAggregate("acting");
  state = runtime.transition(state, event(state, "observation.recorded", {
    run: baseRun,
    evidence: {
      id: "contract-source-v1",
      kind: "source",
      target: "src/main.js",
      version: "source-v1",
    },
  }));
  const criterionId =
    state.objective.acceptanceCriterionIds?.[0] || "criterion-1";
  const compile = (
    previous,
    evidenceId,
    committedAt,
    expectedOutcome = "The fixture behavior passes.",
  ) =>
    runtime.compileRuntimeV2ExecutionContract({
      objective: state.objective,
      evidence: state.evidence,
      previous,
      draft: {
        criteria: [{
          id: criterionId,
          evidence_requirement: "behavioral",
        }],
        changes: [{
          operation: "modify",
          target: "src/main.js",
          basis_evidence_ids: [evidenceId],
        }],
        validations: [{
          id: "validation-contract-revision",
          criterion_ids: [criterionId],
          target_paths: ["src/main.js"],
          kind: "finite_command",
          command: "npm test",
          cwd: ".",
          expected_outcome: expectedOutcome,
        }],
      },
      committedAt,
      contractId: "contract-revision",
    });
  const first = compile(null, "contract-source-v1", state.updatedAt + 1);
  state = runtime.transition(state, event(
    state,
    "execution_contract.committed",
    { run: baseRun, contract: first },
  ));
  assert.throws(
    () => compile(
      first,
      "contract-source-v1",
      state.updatedAt + 1,
    ),
    /contract_revision_no_change/,
  );
  const preMutationRevision = compile(
    first,
    "contract-source-v1",
    state.updatedAt + 1,
    "The revised fixture behavior passes.",
  );
  state = runtime.transition(state, event(
    state,
    "execution_contract.committed",
    { run: baseRun, contract: preMutationRevision },
  ));
  assert.equal(state.executionContract.revision, 2);

  const mutation = commandFor(state, "execute_tool", "contract-mutation", {
    toolCallId: "contract-mutation-call",
    toolName: "apply_patch",
    arguments: { path: "src/main.js", patch: "@@" },
  });
  state = runtime.transition(state, event(state, "command.scheduled", {
    run: baseRun,
    command: mutation,
  }));
  state = runtime.transition(state, event(state, "tool.completed", {
    run: baseRun,
    idempotencyKey: mutation.idempotencyKey,
    status: "succeeded",
    evidence: [{
      id: "contract-mutation-v2",
      kind: "mutation",
      target: "src/main.js",
      version: "source-v2",
    }],
  }));
  const staleRevision = compile(
    preMutationRevision,
    "contract-source-v1",
    state.updatedAt + 1,
  );
  assert.equal(runtime.tryTransition(state, event(
    state,
    "execution_contract.committed",
    { run: baseRun, contract: staleRevision },
  )).disposition, "rejected");

  state = runtime.transition(state, event(state, "observation.recorded", {
    run: baseRun,
    evidence: {
      id: "contract-source-v2",
      kind: "source",
      target: "src/main.js",
      version: "source-v2",
    },
  }));
  const freshRevision = compile(
    preMutationRevision,
    "contract-source-v2",
    state.updatedAt + 1,
  );
  state = runtime.transition(state, event(
    state,
    "execution_contract.committed",
    { run: baseRun, contract: freshRevision },
  ));
  assert.equal(state.executionContract.revision, 3);
});

test("completion gate accepts criterion-linked receipts after the final mutation", () => {
  let state = executeAggregate("acting");
  state = runtime.transition(state, event(state, "observation.recorded", {
    run: baseRun,
    evidence: {
      id: "completion-source",
      kind: "source",
      target: "src/main.js",
      version: "source-v1",
    },
  }));
  state = withExecutionContract(state);
  const mutation = commandFor(state, "execute_tool", "completion-mutation", {
    toolCallId: "completion-mutation-call",
    toolName: "apply_patch",
    arguments: { path: "src/main.js", patch: "@@" },
  });
  state = runtime.transition(state, event(state, "command.scheduled", {
    run: baseRun,
    command: mutation,
  }));
  state = runtime.transition(state, event(state, "tool.completed", {
    run: baseRun,
    idempotencyKey: mutation.idempotencyKey,
    status: "succeeded",
    evidence: [{
      id: "completion-M1",
      kind: "mutation",
      target: "src/main.js",
      version: "source-v2",
    }],
  }));
  state = runtime.transition(state, event(state, "phase.changed", {
    run: baseRun,
    phase: "validating",
    reason: "contract targets changed",
  }));
  const validation = commandFor(
    state,
    "execute_validation",
    "completion-validation",
    {
      toolCallId: "completion-validation-call",
      toolName: "run_command",
      arguments: { command: "npm test", cwd: "." },
      validationAuthority: executionValidationAuthority(state),
    },
  );
  state = runtime.transition(state, event(state, "command.scheduled", {
    run: baseRun,
    command: validation,
  }));
  state = runtime.transition(state, event(state, "validation.completed", {
    run: baseRun,
    idempotencyKey: validation.idempotencyKey,
    passed: true,
    authority: validation.payload.validationAuthority,
    evidence: [{
      id: "completion-V1",
      kind: "validation",
      target: "npm test",
      version: null,
    }],
  }));
  assert.equal(
    runtime.deriveRuntimeV2ExecutionContractCoverage(state).complete,
    true,
  );
  assert.equal(
    runtime.decideRuntimeV2TerminalOutcome(state, {
      canceled: false,
      mutationCount: 1,
      passedValidationCount: 1,
      failedValidationCount: 0,
      stalledValidationCount: 0,
      hasProviderConclusion: true,
    })?.resultKind,
    "success",
  );
});

test("child validation counts only for the exact final mutation boundary", () => {
  let state = executeAggregate("acting");
  state = runtime.transition(state, event(state, "observation.recorded", {
    run: baseRun,
    evidence: {
      id: "child-validation-source",
      kind: "source",
      target: "src/main.js",
      version: "source-v1",
    },
  }));
  state = withExecutionContract(state);
  state = commitMutation(
    state,
    "child-validation-first-mutation",
    "src/main.js",
  );
  const staleBoundary = runtime.deriveRuntimeV2ValidationBoundary(
    state,
    ["src/main.js"],
  );
  const staleStartedAt = state.updatedAt + 1;
  const staleJob = runtime.scheduleReadOnlySubagents({
    parentRun: baseRun,
    candidates: [{
      scopeKey: "stale-validator",
      taskKind: "validate",
      objective: "Run the contract validator.",
      allowedPaths: ["."],
    }],
    requestedAt: staleStartedAt,
    nextId: () => "child-stale-validator",
  }).jobs[0];
  state = runtime.transition(state, event(state, "subagents.scheduled", {
    run: baseRun,
    jobs: [staleJob],
  }));
  state = runtime.transition(state, event(state, "subagent.telemetry", {
    run: baseRun,
    telemetry: {
      jobId: staleJob.id,
      phase: "request_opened",
      at: staleStartedAt,
    },
  }));
  state = commitMutation(
    state,
    "child-validation-later-mutation",
    "src/main.js",
  );
  state = runtime.transition(state, event(state, "subagent.telemetry", {
    run: baseRun,
    telemetry: {
      jobId: staleJob.id,
      phase: "closed",
      at: state.updatedAt + 1,
    },
  }));
  const staleEvidence = {
    id: "child-stale-validation-E1",
    kind: "validation",
    target: "npm test",
    version: "exit-0",
  };
  state = runtime.transition(state, event(state, "subagent.completed", {
    run: baseRun,
    jobId: staleJob.id,
    status: "completed",
    summary: "The declared validator passed before the later mutation.",
    evidence: [staleEvidence],
    report: {
      schemaVersion: runtime.RUNTIME_V2_SUBAGENT_REPORT_SCHEMA_VERSION,
      summary: "The declared validator passed before the later mutation.",
      findings: [{
        statement: "The validator exited successfully.",
        evidenceIds: [staleEvidence.id],
      }],
      unresolved: [],
    },
    validationReceipts: [{
      schemaVersion:
        runtime.RUNTIME_V2_SUBAGENT_VALIDATION_RECEIPT_SCHEMA_VERSION,
      evidenceId: staleEvidence.id,
      passed: true,
      authority: executionValidationAuthority(state),
      ...staleBoundary,
      startedAt: staleStartedAt,
      completedAt: staleStartedAt + 1,
    }],
  }));
  assert.equal(
    runtime.deriveRuntimeV2ExecutionContractCoverage(state).complete,
    false,
  );

  const currentBoundary = runtime.deriveRuntimeV2ValidationBoundary(
    state,
    ["src/main.js"],
  );
  const currentStartedAt = state.updatedAt + 1;
  const currentJob = runtime.scheduleReadOnlySubagents({
    parentRun: baseRun,
    candidates: [{
      scopeKey: "current-validator",
      taskKind: "validate",
      objective: "Run the validator against the final mutation.",
      allowedPaths: ["."],
    }],
    requestedAt: currentStartedAt,
    nextId: () => "child-current-validator",
  }).jobs[0];
  state = runtime.transition(state, event(state, "subagents.scheduled", {
    run: baseRun,
    jobs: [currentJob],
  }));
  state = runtime.transition(state, event(state, "subagent.telemetry", {
    run: baseRun,
    telemetry: {
      jobId: currentJob.id,
      phase: "request_opened",
      at: currentStartedAt,
    },
  }));
  state = runtime.transition(state, event(state, "subagent.telemetry", {
    run: baseRun,
    telemetry: {
      jobId: currentJob.id,
      phase: "closed",
      at: currentStartedAt + 1,
    },
  }));
  const currentEvidence = {
    id: "child-current-validation-E1",
    kind: "validation",
    target: "npm test",
    version: "exit-0",
  };
  state = runtime.transition(state, event(state, "subagent.completed", {
    run: baseRun,
    jobId: currentJob.id,
    status: "completed",
    summary: "The declared validator passed against the final mutation.",
    evidence: [currentEvidence],
    report: {
      schemaVersion: runtime.RUNTIME_V2_SUBAGENT_REPORT_SCHEMA_VERSION,
      summary: "The declared validator passed against the final mutation.",
      findings: [{
        statement: "The final mutation passed the declared validator.",
        evidenceIds: [currentEvidence.id],
      }],
      unresolved: [],
    },
    validationReceipts: [{
      schemaVersion:
        runtime.RUNTIME_V2_SUBAGENT_VALIDATION_RECEIPT_SCHEMA_VERSION,
      evidenceId: currentEvidence.id,
      passed: true,
      authority: executionValidationAuthority(state),
      ...currentBoundary,
      startedAt: currentStartedAt,
      completedAt: currentStartedAt + 1,
    }],
  }));
  assert.equal(
    runtime.deriveRuntimeV2ExecutionContractCoverage(state).complete,
    true,
  );
});

test("execution contract cannot complete while a declared mutation target is untouched", () => {
  let state = executeAggregate("acting");
  state = runtime.transition(state, event(state, "observation.recorded", {
    run: baseRun,
    evidence: {
      id: "multi-target-source",
      kind: "source",
      target: "src/main.js",
      version: "source-v1",
    },
  }));
  const criterionId =
    state.objective.acceptanceCriterionIds?.[0] || "criterion-1";
  const contract = runtime.compileRuntimeV2ExecutionContract({
    objective: state.objective,
    evidence: state.evidence,
    draft: {
      criteria: [{
        id: criterionId,
        evidence_requirement: "behavioral",
      }],
      changes: [
        {
          operation: "modify",
          target: "src/main.js",
          basis_evidence_ids: ["multi-target-source"],
        },
        {
          operation: "create",
          target: "src/save-state.test.js",
          basis_evidence_ids: [],
        },
      ],
      validations: [{
        id: "validation-multi-target",
        criterion_ids: [criterionId],
        target_paths: ["src/main.js", "src/save-state.test.js"],
        kind: "finite_command",
        command: "npm test",
        cwd: ".",
        expected_outcome: "The save-state behavior is covered by tests.",
      }],
    },
    committedAt: state.updatedAt + 1,
    contractId: "contract-multi-target",
  });
  state = { ...state, executionContract: contract };
  const mutation = commandFor(state, "execute_tool", "one-target-mutation", {
    toolCallId: "one-target-mutation-call",
    toolName: "apply_patch",
    arguments: { path: "src/main.js", patch: "@@" },
  });
  state = runtime.transition(state, event(state, "command.scheduled", {
    run: baseRun,
    command: mutation,
  }));
  state = runtime.transition(state, event(state, "tool.completed", {
    run: baseRun,
    idempotencyKey: mutation.idempotencyKey,
    status: "succeeded",
    evidence: [{
      id: "one-target-M1",
      kind: "mutation",
      target: "src/main.js",
      version: "source-v2",
    }],
  }));
  const validation = commandFor(
    state,
    "execute_validation",
    "multi-target-validation",
    {
      toolCallId: "multi-target-validation-call",
      toolName: "run_command",
      arguments: { command: "npm test", cwd: "." },
      validationAuthority: runtime.runtimeV2ExecutionValidationAuthority({
        contract,
        validation: contract.validations[0],
      }),
    },
  );
  state = runtime.transition(state, event(state, "command.scheduled", {
    run: baseRun,
    command: validation,
  }));
  state = runtime.transition(state, event(state, "validation.completed", {
    run: baseRun,
    idempotencyKey: validation.idempotencyKey,
    passed: true,
    authority: validation.payload.validationAuthority,
    evidence: [{
      id: "multi-target-V1",
      kind: "validation",
      target: "npm test",
      version: "exit-0",
    }],
  }));
  const coverage = runtime.deriveRuntimeV2ExecutionContractCoverage(state);
  assert.deepEqual(
    coverage.missingMutationTargets,
    ["src/save-state.test.js"],
  );
  assert.equal(coverage.complete, false);
  assert.equal(runtime.decideRuntimeV2TerminalOutcome(state, {
    canceled: false,
    mutationCount: 1,
    passedValidationCount: 1,
    failedValidationCount: 0,
    stalledValidationCount: 0,
    hasProviderConclusion: true,
  }), null);
});

test("progressive and repeated validation failures remain non-terminal signals", () => {
  const classifier = { isMutationToolName: (name) => name === "apply_patch" };
  let state = executeAggregate("acting");
  const mutation = commandFor(state, "execute_tool", "bounded-mutation", {
    toolCallId: "bounded-mutation-call",
    toolName: "apply_patch",
    arguments: { patch: "*** Begin Patch\n*** End Patch" },
  });
  state = runtime.transition(state, event(state, "command.scheduled", {
    run: baseRun,
    command: mutation,
  }));
  state = runtime.transition(state, event(state, "tool.completed", {
    run: baseRun,
    idempotencyKey: mutation.idempotencyKey,
    status: "succeeded",
    evidence: [{ id: "bounded-M1", kind: "mutation", target: "src/main.js", version: null }],
  }));

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    state = runtime.transition(state, event(state, "phase.changed", {
      run: baseRun,
      phase: "validating",
      reason: `validate attempt ${attempt}`,
    }));
    const validation = commandFor(
      state,
      "execute_validation",
      `bounded-validation-${attempt}`,
      {
        toolCallId: `bounded-validation-call-${attempt}`,
        toolName: "run_command",
        arguments: { command: "npm run build" },
      },
    );
    state = runtime.transition(state, event(state, "command.scheduled", {
      run: baseRun,
      command: validation,
    }));
    state = runtime.transition(state, event(state, "validation.completed", {
      run: baseRun,
      idempotencyKey: validation.idempotencyKey,
      passed: false,
      failureKind: "assertion_failed",
      evidence: [{
        id: `bounded-V${attempt}`,
        kind: "validation",
        target: `diagnostic-${attempt}.log`,
        version: `diagnostic-v${attempt}`,
      }],
    }));
    const facts = runtime.summarizeRuntimeV2ExecuteEvidence(state, classifier);
    assert.equal(facts.failedValidationCount, attempt);
    const decision = runtime.decideRuntimeV2TerminalOutcome(state, {
      canceled: false,
      ...facts,
      hasProviderConclusion: false,
    });
    assert.equal(facts.stalledValidationCount, 1);
    assert.equal(decision, null);
    if (attempt < 3) state = runtime.transition(state, event(state, "phase.changed", {
      run: baseRun,
      phase: "acting",
      reason: "correct failed validation",
    }));
  }

  state = runtime.transition(state, event(state, "phase.changed", {
    run: baseRun,
    phase: "acting",
    reason: "begin stalled validation fixture",
  }));
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    state = runtime.transition(state, event(state, "phase.changed", {
      run: baseRun,
      phase: "validating",
      reason: `stalled validate attempt ${attempt}`,
    }));
    const validation = commandFor(
      state,
      "execute_validation",
      `stalled-validation-${attempt}`,
      {
        toolCallId: `stalled-validation-call-${attempt}`,
        toolName: "run_command",
        arguments: { command: "npm run build" },
      },
    );
    state = runtime.transition(state, event(state, "command.scheduled", {
      run: baseRun,
      command: validation,
    }));
    state = runtime.transition(state, event(state, "validation.completed", {
      run: baseRun,
      idempotencyKey: validation.idempotencyKey,
      passed: false,
      failureKind: "assertion_failed",
      evidence: [{
        id: `stalled-V${attempt}`,
        kind: "validation",
        target: "npm run build",
        version: "same-normalized-diagnostic",
      }],
    }));
    const facts = runtime.summarizeRuntimeV2ExecuteEvidence(state, classifier);
    const decision = runtime.decideRuntimeV2TerminalOutcome(state, {
      canceled: false,
      ...facts,
      hasProviderConclusion: false,
    });
    if (attempt < 3) {
      assert.equal(decision, null);
      state = runtime.transition(state, event(state, "phase.changed", {
        run: baseRun,
        phase: "acting",
        reason: "retry stalled validation",
      }));
    } else {
      assert.equal(facts.stalledValidationCount, 3);
      assert.equal(decision, null);
    }
  }
});

test("tool-call transport ids do not create unlimited recovery fingerprints", () => {
  const base = {
    kind: "execute_tool",
    phase: "acting",
    payload: {
      toolName: "apply_patch",
      arguments: { path: "src/main.js", patch: "@@" },
    },
  };
  assert.equal(
    runtime.runtimeV2ActionFingerprint({ ...base, payload: { ...base.payload, toolCallId: "provider-call-a" } }),
    runtime.runtimeV2ActionFingerprint({ ...base, payload: { ...base.payload, toolCallId: "provider-call-b" } }),
  );
});

test("long request fingerprints retain one identity across receipts and advance attempts", () => {
  let state = executeAggregate("observing");
  state = {
    ...state,
    objective: {
      ...state.objective,
      acceptanceCriteria: ["behavioral acceptance ".repeat(180)],
    },
  };
  const first = runtime.decideNextCommands(state, {
    subagentPreference: "preferred",
  })[0];
  assert.ok(first.payload.actionFingerprint.length > 512);
  assert.equal(
    runtime.runtimeV2ActionFingerprint(first),
    first.payload.actionFingerprint,
  );
  state = runtime.transition(state, event(state, "command.scheduled", {
    run: baseRun,
    command: first,
  }));
  state = runtime.transition(state, event(state, "provider.responded", {
    run: baseRun,
    idempotencyKey: first.idempotencyKey,
    result: {
      visibleText: "Continue the parent investigation.",
      toolCalls: [],
      diagnostics: [],
    },
  }));

  const second = runtime.decideNextCommands(state, {
    subagentPreference: "preferred",
  })[0];
  assert.equal(second.payload.actionFingerprint, first.payload.actionFingerprint);
  assert.equal(second.payload.attempt, 2);
  assert.notEqual(second.idempotencyKey, first.idempotencyKey);
});

test("a child converges after its first independent evidence and failed handoff preserves targets", () => {
  assert.equal(runtime.shouldRequestRuntimeV2SubagentReport({
    evidenceCount: 0,
    explicitlyRequested: true,
    remainingMs: 10_000,
  }), false);
  assert.equal(runtime.shouldRequestRuntimeV2SubagentReport({
    evidenceCount: 1,
    explicitlyRequested: false,
    remainingMs: 80_000,
  }), true);
  assert.equal(runtime.shouldRequestRuntimeV2SubagentReport({
    evidenceCount: 1,
    explicitlyRequested: false,
    remainingMs: 20_000,
  }), true);
  assert.equal(runtime.shouldRequestRuntimeV2SubagentReport({
    evidenceCount: 1,
    explicitlyRequested: false,
    remainingMs: 50_000,
  }), true);
  assert.equal(runtime.shouldRequestRuntimeV2SubagentReport({
    evidenceCount: 1,
    explicitlyRequested: false,
    remainingMs: 80_000,
    independentWorkComplete: true,
  }), true);
  const summary = runtime.runtimeV2SubagentFailureSummary({
    canceled: false,
    deadlineExceeded: true,
    evidence: [
      { target: "src/main.js" },
      { target: "src/components/editor.js" },
    ],
  });
  assert.match(summary, /2 条只读证据/);
  assert.match(summary, /src\/main\.js/);
  assert.match(summary, /父任务接管/);
});

test("controller schedules only the child task selected by a real provider tool call", async () => {
  let now = 200;
  let id = 0;
  let revision = 0;
  const ledger = [];
  const jobs = [{
    id: "child-save-events",
    run: { ...baseRun, runId: "child-run-save-events", parentRunId: baseRun.runId, attemptId: "child-attempt-save-events" },
    parentRunId: baseRun.runId,
    sourceToolCallId: "spawn-save-events",
    scopeKey: "save-event-consumer-audit",
    name: "Kepler",
    role: "event-flow reviewer",
    objective: "Trace where save events are consumed and identify the first dropped handoff.",
    successCriteria: "Return exact source paths and the first unsupported transition.",
    allowedPaths: ["src/editor"],
    status: "queued",
    requestedAt: now,
    firstTokenAt: null,
    closedAt: null,
    summary: null,
  }];
  let providerCalls = 0;
  const ports = {
    checkpoint: {
      async load() { return null; },
      async append({ event }) {
        ledger.push(event);
        revision += 1;
        return { disposition: "committed", checkpoint: { revision, event } };
      },
    },
    provider: {
      async request() {
        providerCalls += 1;
        return {
          visibleText: "我会先让 Kepler 独立核对保存事件的消费链。",
          toolCalls: [{
            id: "spawn-save-events",
            name: "spawn_subagent",
            arguments: {
              task_key: "save-event-consumer-audit",
              name: "Kepler",
              role: "event-flow reviewer",
              objective: "Trace where save events are consumed and identify the first dropped handoff.",
              success_criteria: "Return exact source paths and the first unsupported transition.",
              allowed_paths: "src/editor",
            },
          }],
          diagnostics: [],
        };
      },
    },
    tool: { async execute() { throw new Error("tool should not run before child scheduling"); } },
    scheduler: {
      async prepareSchedule({ command }) {
        assert.equal(command.payload.toolCallId, "spawn-save-events");
        assert.equal(command.payload.arguments.name, "Kepler");
        return { type: "subagents.scheduled", run: baseRun, jobs };
      },
      async execute({ command }) {
        assert.equal(command.kind, "schedule_subagents");
        assert.equal(ledger.filter((item) => item.type === "subagents.scheduled").length, 1);
        return jobs.map((job) => ({
          type: "subagent.telemetry",
          run: baseRun,
          telemetry: { jobId: job.id, phase: "request_opened", at: ++now },
        }));
      },
    },
    projection: { async publish() {} },
    clockId: {
      now: () => ++now,
      nextId: (scope) => `${scope}-${++id}`,
      nextIdempotencyKey: ({ run, kind }) => `${run.runId}:${kind}:${++id}`,
    },
  };
  const controller = new runtime.RuntimeV2Controller(ports);
  await controller.admit({ turn: baseTurn, run: baseRun, strategy: "execute", objective: "Repair the fixture" });
  await controller.changePhase("observing", "initial observation is complete");
  await controller.driveOnce({ subagentPreference: "preferred" });
  assert.equal(providerCalls, 1);
  assert.equal(controller.snapshot().aggregate.subagents.length, 0);
  assert.equal(controller.snapshot().aggregate.pendingToolCalls[0].name, "spawn_subagent");
  await controller.driveOnce({ subagentPreference: "preferred" });
  const aggregate = controller.snapshot().aggregate;
  assert.equal(aggregate.subagents.length, 1);
  assert.equal(aggregate.subagents[0].name, "Kepler");
  assert.equal(aggregate.subagents[0].objective, jobs[0].objective);
  assert.deepEqual(aggregate.subagents.map((job) => job.status), ["running"]);
  assert.equal(aggregate.pendingToolCalls.length, 0);
  assert.ok(
    ledger.findIndex((item) => item.type === "provider.responded") <
      ledger.findIndex((item) => item.type === "subagents.scheduled"),
  );
  assert.ok(ledger.findIndex((item) => item.type === "subagents.scheduled") < ledger.findIndex((item) => item.type === "subagent.telemetry"));
});

test("controller resumes an already committed child schedule without allocating duplicate jobs", async () => {
  let state = executeAggregate("observing");
  const schedule = commandFor(state, "schedule_subagents", "schedule-resume", {
    mode: "read_only",
    objective: "Repair the fixture",
  });
  const jobs = ["frontend", "backend"].map((scopeKey, index) => ({
    id: `resume-child-${index + 1}`,
    run: {
      ...baseRun,
      runId: `resume-child-run-${index + 1}`,
      parentRunId: baseRun.runId,
      attemptId: `resume-child-attempt-${index + 1}`,
    },
    parentRunId: baseRun.runId,
    scopeKey,
    objective: `inspect ${scopeKey}`,
    allowedPaths: [index === 0 ? "src" : "src-tauri"],
    status: "queued",
    requestedAt: state.updatedAt + 1,
    firstTokenAt: null,
    closedAt: null,
    summary: null,
  }));
  state = runtime.transition(state, event(state, "command.scheduled", {
    run: baseRun,
    command: schedule,
  }));
  state = runtime.transition(state, event(state, "subagents.scheduled", {
    run: baseRun,
    jobs,
  }));
  for (const job of jobs) {
    state = runtime.transition(state, event(state, "subagent.telemetry", {
      run: baseRun,
      telemetry: { jobId: job.id, phase: "request_opened", at: state.updatedAt + 1 },
    }));
  }

  let revision = state.events.length;
  let prepareCalls = 0;
  let executeCalls = 0;
  const controller = new runtime.RuntimeV2Controller({
    checkpoint: {
      async load() { return null; },
      async append({ event: appended }) {
        revision += 1;
        return { disposition: "committed", checkpoint: { revision, event: appended } };
      },
    },
    provider: { async request() { throw new Error("provider is not expected"); } },
    tool: { async execute() { throw new Error("tool is not expected"); } },
    scheduler: {
      async prepareSchedule() {
        prepareCalls += 1;
        throw new Error("resume must not allocate another child pair");
      },
      async execute({ command, scheduledSubagents }) {
        executeCalls += 1;
        assert.equal(command.kind, "schedule_subagents");
        assert.deepEqual(scheduledSubagents.map((job) => job.id), jobs.map((job) => job.id));
        assert.deepEqual(scheduledSubagents.map((job) => job.status), ["running", "running"]);
        return [];
      },
    },
    projection: { async publish() {} },
    clockId: {
      now: () => state.updatedAt + revision + 1,
      nextId: (scope) => `${scope}-resume-${revision}`,
      nextIdempotencyKey: ({ run, kind }) => `${run.runId}:${kind}:resume`,
    },
  }, { aggregate: state, revision });

  assert.equal(await controller.resumeScheduled(), true);
  const resumed = controller.snapshot().aggregate;
  assert.equal(prepareCalls, 0);
  assert.equal(executeCalls, 1);
  assert.equal(resumed.scheduledCommands.length, 0);
  assert.equal(resumed.completedCommands.at(-1).idempotencyKey, schedule.idempotencyKey);
  assert.equal(resumed.subagents.length, 2);
});

test("soft iteration pressure is durable but never terminal by itself", async () => {
  let now = 700;
  let revision = 0;
  const controller = new runtime.RuntimeV2Controller({
    checkpoint: {
      async load() { return null; },
      async append({ event: appended }) {
        revision += 1;
        return { disposition: "committed", checkpoint: { revision, event: appended } };
      },
    },
    provider: { async request() { throw new Error("provider is not expected"); } },
    tool: { async execute() { throw new Error("tool is not expected"); } },
    scheduler: { async execute() { throw new Error("scheduler is not expected"); } },
    projection: { async publish() {} },
    clockId: {
      now: () => ++now,
      nextId: (scope) => `${scope}-soft-${now}`,
      nextIdempotencyKey: ({ run, kind }) => `${run.runId}:${kind}:soft`,
    },
  });
  await controller.admit({
    turn: baseTurn,
    run: baseRun,
    strategy: "execute",
    objective: "Repair the fixture",
  });
  const before = controller.snapshot().aggregate;
  await controller.recordSoftSignal("iteration_limit");
  await controller.recordSoftSignal("iteration_limit");
  const after = controller.snapshot().aggregate;
  assert.equal(after.phase, before.phase);
  assert.equal(after.terminalOutcome, null);
  assert.equal(after.recovery.exhausted, null);
  assert.equal(
    after.events.filter((item) =>
      item.type === "soft_signal.observed" && item.signal === "iteration_limit"
    ).length,
    1,
  );
});

test("identical live projections are coalesced within one phase", async () => {
  let now = 750;
  let revision = 0;
  let published = 0;
  const controller = new runtime.RuntimeV2Controller({
    checkpoint: {
      async load() { return null; },
      async append({ event: appended }) {
        revision += 1;
        return {
          disposition: "committed",
          checkpoint: { revision, event: appended },
        };
      },
    },
    provider: {
      async request() {
        throw new Error("provider is not expected");
      },
    },
    tool: {
      async execute() {
        throw new Error("tool is not expected");
      },
    },
    scheduler: {
      async execute() {
        throw new Error("scheduler is not expected");
      },
    },
    projection: {
      async publish() {
        published += 1;
      },
    },
    clockId: {
      now: () => ++now,
      nextId: (scope) => `${scope}-projection-${now}`,
      nextIdempotencyKey: ({ run, kind }) =>
        `${run.runId}:${kind}:projection`,
    },
  });
  await controller.admit({
    turn: baseTurn,
    run: baseRun,
    strategy: "execute",
    objective: "Repair the fixture",
  });
  await controller.publishLiveStatus("正在收集证据。", "first");
  await controller.publishLiveStatus("正在收集证据。", "second");
  const aggregate = controller.snapshot().aggregate;
  assert.equal(published, 1);
  assert.equal(
    aggregate.events.filter((item) =>
      item.type === "projection.published" &&
      item.audience === "capsule_live"
    ).length,
    1,
  );
});

test("an infrastructure conclusion settles an in-flight command in the same checkpoint", async () => {
  let now = 820;
  let revision = 0;
  const controller = new runtime.RuntimeV2Controller({
    checkpoint: {
      async load() { return null; },
      async append({ event: appended }) {
        revision += 1;
        return {
          disposition: "committed",
          checkpoint: { revision, event: appended },
        };
      },
    },
    provider: {
      async request() {
        throw new Error("provider is not expected");
      },
    },
    tool: {
      async execute() {
        throw new Error("tool is not expected");
      },
    },
    scheduler: {
      async execute() {
        throw new Error("scheduler is not expected");
      },
    },
    projection: { async publish() {} },
    clockId: {
      now: () => ++now,
      nextId: (scope) => `${scope}-infrastructure-${now}`,
      nextIdempotencyKey: ({ run, kind }) =>
        `${run.runId}:${kind}:infrastructure`,
    },
  });
  await controller.admit({
    turn: baseTurn,
    run: baseRun,
    strategy: "execute",
    objective: "Repair the fixture",
    initialPhase: "observing",
  });
  const command = runtime.decideNextCommands(
    controller.snapshot().aggregate,
  )[0];
  await controller.schedule(command);
  await controller.finishTerminal(
    "error",
    "Runtime infrastructure failed.",
  );
  const aggregate = controller.snapshot().aggregate;
  assert.equal(aggregate.scheduledCommands.length, 0);
  assert.equal(aggregate.completedCommands.at(-1).status, "failed");
  assert.equal(aggregate.terminalOutcome.resultKind, "error");
  assert.equal(
    aggregate.events.filter((item) => item.type === "turn.completed").length,
    1,
  );
});

test("an aborted Turn settles the scheduled lifecycle as canceled without calling the provider", async () => {
  let now = 300;
  let id = 0;
  let revision = 0;
  let providerCalls = 0;
  const abort = new AbortController();
  const ports = {
    checkpoint: {
      async load() { return null; },
      async append({ event }) {
        revision += 1;
        return { disposition: "committed", checkpoint: { revision, event } };
      },
    },
    provider: { async request() { providerCalls += 1; return { toolCalls: [], diagnostics: [] }; } },
    tool: { async execute() { throw new Error("tool should not run after cancel"); } },
    scheduler: { async execute() { throw new Error("scheduler should not run after cancel"); } },
    projection: { async publish() {} },
    clockId: {
      now: () => ++now,
      nextId: (scope) => `${scope}-${++id}`,
      nextIdempotencyKey: ({ run, kind }) => `${run.runId}:${kind}:${++id}`,
    },
  };
  const controller = new runtime.RuntimeV2Controller(ports, undefined, { abortSignal: abort.signal });
  await controller.admit({ turn: baseTurn, run: baseRun, strategy: "execute", objective: "Repair the fixture" });
  abort.abort(new Error("user canceled"));
  assert.equal(await controller.driveOnce(), false);
  const aggregate = controller.snapshot().aggregate;
  assert.equal(providerCalls, 0);
  assert.equal(aggregate.terminalOutcome.resultKind, "canceled");
  assert.deepEqual(
    aggregate.events
      .filter((item) =>
        item.type === "run.aborted" ||
        item.type === "run.completed" ||
        item.type === "turn.completed"
      )
      .map((item) => item.type),
    ["run.aborted", "run.completed", "turn.completed"],
  );
  assert.equal(aggregate.events.filter((item) => item.type === "turn.completed").length, 1);
});

test("failed acceptance checks remain normal loop evidence across multiple corrective mutations", async () => {
  let now = 400;
  let id = 0;
  let revision = 0;
  let validationCalls = 0;
  let mutationCalls = 0;
  const ports = {
    checkpoint: {
      async load() { return null; },
      async append({ event }) {
        revision += 1;
        return { disposition: "committed", checkpoint: { revision, event } };
      },
    },
    provider: {
      async request({ command }) {
        if (command.payload.mode === "execute") {
          return {
            toolCalls: [{
              id: `mutation-call-${++mutationCalls}`,
              name: "apply_patch",
              arguments: { patch: "*** Begin Patch\\n*** End Patch" },
            }],
            diagnostics: [],
          };
        }
        return {
          toolCalls: [{
            id: `validation-call-${++validationCalls}`,
            name: "run_command",
            arguments: { command: "npm run build" },
          }],
          diagnostics: [],
        };
      },
    },
    tool: {
      async execute({ command }) {
        if (command.kind === "execute_tool") {
          return {
            type: "tool.completed",
            run: command.run,
            idempotencyKey: command.idempotencyKey,
            status: "succeeded",
            evidence: [{
              id: `mutation-${mutationCalls}`,
              kind: "mutation",
              target: "src/main.js",
              version: `version-${mutationCalls}`,
            }],
          };
        }
        return {
          type: "validation.completed",
          run: command.run,
          idempotencyKey: command.idempotencyKey,
          passed: false,
          evidence: [],
        };
      },
    },
    scheduler: { async execute() { throw new Error("scheduler is not expected"); } },
    projection: { async publish() {} },
    clockId: {
      now: () => ++now,
      nextId: (scope) => `${scope}-${++id}`,
      nextIdempotencyKey: ({ run, kind }) => `${run.runId}:${kind}:${++id}`,
    },
  };
  const controller = new runtime.RuntimeV2Controller(ports);
  await controller.admit({
    turn: baseTurn,
    run: baseRun,
    strategy: "execute",
    objective: "Repair the fixture",
    initialPhase: "validating",
  });
  for (let cycle = 0; cycle < 5; cycle += 1) {
    await controller.driveOnce();
    await controller.driveOnce();
    let aggregate = controller.snapshot().aggregate;
    assert.equal(
      aggregate.pendingToolCalls.length,
      0,
      `cycle=${cycle} phase=${aggregate.phase} scheduled=${aggregate.scheduledCommands.map((item) => item.kind).join(",")}`,
    );
    assert.equal(aggregate.completedCommands.at(-1).kind, "execute_validation");
    assert.equal(
      aggregate.completedCommands.at(-1).status,
      "succeeded",
      "the validator ran successfully even though acceptance did not pass",
    );
    assert.equal(aggregate.recovery.exhausted, null);
    assert.equal(
      aggregate.recovery.receipts.some((receipt) =>
        receipt.scope === "diagnostic"
      ),
      false,
    );

    await controller.changePhase("acting", "repair failed validation");
    await controller.driveOnce();
    await controller.driveOnce();
    aggregate = controller.snapshot().aggregate;
    assert.equal(
      aggregate.recovery.epoch,
      0,
      "ordinary acceptance repair is not a recovery epoch",
    );
    assert.equal(aggregate.recovery.exhausted, null);
    await controller.changePhase("validating", "validate corrective mutation");
  }
  const aggregate = controller.snapshot().aggregate;
  assert.equal(aggregate.recovery.actionRepeats, 0);
  assert.equal(aggregate.recovery.diagnosticRepairs, 0);
});

test("a protocol-invalid validation is an action recovery, not a failed acceptance check", async () => {
  let now = 900;
  let id = 0;
  let revision = 0;
  const controller = new runtime.RuntimeV2Controller({
    checkpoint: {
      async load() { return null; },
      async append({ event }) {
        revision += 1;
        return { disposition: "committed", checkpoint: { revision, event } };
      },
    },
    provider: {
      async request() {
        return {
          toolCalls: [{
            id: "inspection-call",
            name: "run_command",
            arguments: { command: "grep -n TODO src/main.js" },
          }],
          diagnostics: [],
        };
      },
    },
    tool: {
      async execute({ command }) {
        return {
          type: "validation.completed",
          run: command.run,
          idempotencyKey: command.idempotencyKey,
          passed: false,
          failureKind: "protocol_invalid",
          evidence: [],
        };
      },
    },
    scheduler: { async execute() { throw new Error("scheduler is not expected"); } },
    projection: { async publish() {} },
    clockId: {
      now: () => ++now,
      nextId: (scope) => `${scope}-${++id}`,
      nextIdempotencyKey: ({ run, kind }) => `${run.runId}:${kind}:${++id}`,
    },
  });
  await controller.admit({
    turn: baseTurn,
    run: baseRun,
    strategy: "execute",
    objective: "Repair the fixture",
    initialPhase: "validating",
  });
  await controller.driveOnce();
  await controller.driveOnce();
  const aggregate = controller.snapshot().aggregate;
  assert.equal(aggregate.phase, "validating");
  assert.equal(aggregate.recovery.diagnosticRepairs, 0);
  assert.equal(
    aggregate.recovery.receipts.some((receipt) => receipt.scope === "diagnostic"),
    false,
  );
  assert.equal(
    aggregate.recovery.receipts.some((receipt) => receipt.scope === "action"),
    true,
  );
  assert.equal(aggregate.recovery.exhausted, null);
});
