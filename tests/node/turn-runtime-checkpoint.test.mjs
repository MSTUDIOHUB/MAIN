import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

import ts from "typescript";

const workspaceRoot = process.cwd();
const moduleCache = new Map();

function loadTranspiledModuleSync(sourcePath) {
  const normalizedPath = path.resolve(sourcePath);
  if (moduleCache.has(normalizedPath)) return moduleCache.get(normalizedPath);
  const source = fs.readFileSync(normalizedPath, "utf8");
  const localRequire = createRequire(normalizedPath);
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
    fileName: normalizedPath,
  }).outputText;
  const module = { exports: {} };
  moduleCache.set(normalizedPath, module.exports);
  const runtimeRequire = (specifier) => {
    if (specifier.startsWith(".")) {
      const basePath = path.resolve(path.dirname(normalizedPath), specifier);
      for (const candidate of [basePath, `${basePath}.ts`, path.join(basePath, "index.ts")]) {
        if (fs.existsSync(candidate) && candidate.endsWith(".ts")) {
          return loadTranspiledModuleSync(candidate);
        }
      }
    }
    return localRequire(specifier);
  };
  new Function("exports", "module", "require", transpiled)(
    module.exports,
    module,
    runtimeRequire,
  );
  moduleCache.set(normalizedPath, module.exports);
  return module.exports;
}

const canonicalRuntime = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/lib/turnRuntimeContract.ts"),
);
const checkpointRuntime = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/lib/turnRuntimeCheckpoint.ts"),
);
const preferredScopes = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/lib/preferredDelegationScopes.ts"),
);
const closureReceipts = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/lib/subagentClosureReceipts.ts"),
);

const turn = Object.freeze({
  workspaceKey: "/workspace/project",
  sessionKey: "/workspace/project:7",
  sessionEpoch: "epoch-7",
  clientSubmissionId: "submission-7",
  turnId: "turn-7",
});
const run = Object.freeze({
  sessionKey: turn.sessionKey,
  sessionEpoch: turn.sessionEpoch,
  turnId: turn.turnId,
  runId: "run-7",
  parentRunId: null,
  attemptId: "attempt-7",
});

function apply(state, type, fields, at = state.lastEventAt + 1) {
  const result = canonicalRuntime.reduceCanonicalTurnRuntime(state, {
    schemaVersion: canonicalRuntime.TURN_RUNTIME_CONTRACT_SCHEMA_VERSION,
    type,
    sequence: state.nextSequence,
    at,
    ...fields,
  });
  assert.equal(result.disposition, "applied", result.reason);
  return result.state;
}

function runningCanonical(strategy = "plan") {
  const admitted = canonicalRuntime.createCanonicalTurnRuntime({
    turn,
    strategy,
    admittedAt: 100,
  });
  return apply(admitted, "run.started", {
    run,
    phase: strategy === "plan" ? "planning" : "preparing",
  }, 101);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

test("checkpoint schema and owner fences reject stale or tampered durable state", () => {
  const checkpoint = checkpointRuntime.createTurnRuntimeCheckpoint({
    canonical: runningCanonical(),
    updatedAt: 102,
  });
  const exactOwner = {
    workspaceKey: turn.workspaceKey,
    sessionKey: turn.sessionKey,
    sessionEpoch: turn.sessionEpoch,
    turnId: turn.turnId,
  };

  assert.ok(checkpointRuntime.normalizeTurnRuntimeCheckpoint(checkpoint, {
    expectedOwner: exactOwner,
  }));
  assert.equal(checkpointRuntime.normalizeTurnRuntimeCheckpoint({
    ...checkpoint,
    schemaVersion: "turn-runtime-checkpoint.v2",
  }), null);
  const circular = { ...checkpoint };
  circular.self = circular;
  assert.equal(
    checkpointRuntime.normalizeTurnRuntimeCheckpoint(circular),
    null,
    "cyclic data is not a JSON-safe durable checkpoint",
  );
  assert.equal(checkpointRuntime.normalizeTurnRuntimeCheckpoint({
    ...checkpoint,
    unknownOversizedPayload: "x".repeat(1_048_577),
  }), null);
  assert.equal(checkpointRuntime.normalizeTurnRuntimeCheckpoint(checkpoint, {
    expectedOwner: { ...exactOwner, sessionEpoch: "epoch-stale" },
  }), null);

  const tampered = clone(checkpoint);
  tampered.canonical.run.phase = "executing";
  assert.equal(
    checkpointRuntime.normalizeTurnRuntimeCheckpoint(tampered),
    null,
    "a projected state that disagrees with its event ledger must fail closed",
  );

  assert.deepEqual(checkpointRuntime.normalizeTurnRuntimeCheckpointMap({
    [turn.turnId]: checkpoint,
  }, {
    expectedSessionKey: turn.sessionKey,
    expectedSessionEpoch: "epoch-stale",
    expectedWorkspaceKey: turn.workspaceKey,
    coldRestore: true,
    now: 200,
  }), {});
});

test("checkpoint retains typed admitted payload and monotonic visual observation without image bytes", () => {
  const checkpoint = checkpointRuntime.createTurnRuntimeCheckpoint({
    canonical: runningCanonical(),
    admittedUserContext: {
      imageParts: 1,
      mentionedFilePaths: ["src/ChatArea.tsx"],
      attachedFilePaths: ["notes/incident.md"],
      subagentPreference: "preferred",
      diagnosisRequirement: "required",
    },
    updatedAt: 102,
  });
  assert.deepEqual(checkpoint.input.admittedUserContext, {
    imageParts: 1,
    mentionedFilePaths: ["src/ChatArea.tsx"],
    attachedFilePaths: ["notes/incident.md"],
    subagentPreference: "preferred",
    diagnosisRequirement: "required",
  });
  assert.equal(checkpoint.input.visualContext.status, "queued");
  assert.doesNotMatch(JSON.stringify(checkpoint), /data:image|base64,/i);

  const delivered = checkpointRuntime.updateTurnRuntimeVisualContextCheckpoint({
    checkpoint,
    visualContext: {
      status: "delivered",
      expectedImageParts: 1,
      deliveredImageParts: 1,
      omittedImageParts: 0,
      recognition: "pending",
    },
    updatedAt: 103,
  });
  assert.ok(delivered);
  const observed = checkpointRuntime.updateTurnRuntimeVisualContextCheckpoint({
    checkpoint: delivered,
    visualContext: {
      status: "delivered",
      expectedImageParts: 1,
      deliveredImageParts: 1,
      omittedImageParts: 0,
      recognition: "observed",
      observationSummary: "截图显示修正版计划没有进入审核态。",
      observationId: "visual-owner-bound-1",
    },
    updatedAt: 104,
  });
  assert.ok(observed);
  const laterTrimmedRequest = checkpointRuntime.updateTurnRuntimeVisualContextCheckpoint({
    checkpoint: observed,
    visualContext: {
      status: "not_delivered",
      expectedImageParts: 1,
      deliveredImageParts: 0,
      omittedImageParts: 1,
      recognition: "unverified",
    },
    updatedAt: 105,
  });
  assert.ok(laterTrimmedRequest);
  assert.equal(laterTrimmedRequest.input.visualContext.status, "delivered");
  assert.equal(laterTrimmedRequest.input.visualContext.recognition, "observed");
  assert.equal(
    laterTrimmedRequest.input.visualContext.observationId,
    "visual-owner-bound-1",
  );
  const conflictingObservation = checkpointRuntime.updateTurnRuntimeVisualContextCheckpoint({
    checkpoint: laterTrimmedRequest,
    visualContext: {
      status: "delivered",
      expectedImageParts: 1,
      deliveredImageParts: 1,
      omittedImageParts: 0,
      recognition: "observed",
      observationSummary: "A later retry claimed different pixels.",
      observationId: "visual-conflicting-retry",
    },
    updatedAt: 106,
  });
  assert.ok(conflictingObservation);
  assert.equal(conflictingObservation.input.visualContext.observationId, "visual-owner-bound-1");
  assert.equal(
    conflictingObservation.input.visualContext.observationSummary,
    "截图显示修正版计划没有进入审核态。",
    "a later response cannot rewrite the first durable visual observation",
  );
  assert.deepEqual(
    laterTrimmedRequest.input.admittedUserContext,
    checkpoint.input.admittedUserContext,
    "a visual update cannot rewrite first-admission payload facts",
  );
});

test("cold restart pauses a running Run without manufacturing execution authority", () => {
  const checkpoint = checkpointRuntime.createTurnRuntimeCheckpoint({
    canonical: runningCanonical("execute"),
    updatedAt: 102,
  });
  const restored = checkpointRuntime.normalizeTurnRuntimeCheckpoint(checkpoint, {
    expectedOwner: {
      workspaceKey: turn.workspaceKey,
      sessionKey: turn.sessionKey,
      sessionEpoch: turn.sessionEpoch,
      turnId: turn.turnId,
    },
    coldRestore: true,
    now: 200,
  });

  assert.ok(restored);
  assert.equal(restored.revision, checkpoint.revision + 1);
  assert.equal(restored.canonical.run.status, "paused");
  assert.equal(restored.canonical.run.pause.kind, "recoverable");
  assert.equal(restored.canonical.run.pause.reason, "application_restarted");
  assert.equal(restored.canonical.turn.status, "open");
  assert.deepEqual(restored.canonical.events.map((event) => event.type), [
    "turn.admitted",
    "run.started",
    "run.paused",
  ]);
});

test("terminal projection reconciles an exact recovery child without losing the parent ledger", () => {
  const parent = runningCanonical("chat");
  const childRun = {
    ...run,
    runId: "run-conclusion-7",
    parentRunId: run.runId,
    attemptId: "run-conclusion-7",
  };
  const projected = checkpointRuntime.projectCanonicalRunTransactionFromState({
    state: parent,
    run: childRun,
    outcome: {
      status: "completed",
      resultKind: "error",
      reason: "transport_failed",
    },
    at: 200,
    closesTurn: true,
  });

  assert.equal(projected.disposition, "projected", projected.reason);
  assert.equal(projected.state.turn.status, "completed");
  assert.equal(projected.state.run.identity.runId, childRun.runId);
  assert.equal(projected.state.run.status, "completed");
  assert.equal(projected.state.priorRuns.length, 1);
  assert.equal(projected.state.priorRuns[0].identity.runId, run.runId);
  assert.equal(projected.state.priorRuns[0].status, "paused");
  assert.deepEqual(projected.state.events.map((event) => event.type), [
    "turn.admitted",
    "run.started",
    "run.paused",
    "run.started",
    "run.completed",
    "turn.completed",
  ]);
});

test("emergency checkpoint transaction preserves a pending Plan review after terminal failure", () => {
  const checkpoint = checkpointRuntime.createTurnRuntimeCheckpoint({
    canonical: runningCanonical("plan"),
    updatedAt: 102,
  });
  const projected = checkpointRuntime.projectTurnRuntimeCheckpointTransaction({
    checkpoint,
    owner: turn,
    run,
    strategy: "plan",
    outcome: {
      status: "completed",
      resultKind: "error",
      reason: "terminal_publication_failed",
    },
    at: 200,
    closesTurn: true,
    planArtifact: {
      path: ".MAIN/plans/plan.md",
      digest: "plan-sha256-review",
      revision: 1,
    },
  });

  assert.equal(projected.disposition, "projected", projected.reason);
  assert.equal(projected.compatibility.agentStatus, "pending_review");
  assert.equal(projected.compatibility.conversationTurnStatus, "awaiting_approval");
  assert.equal(projected.compatibility.isTerminal, false);
  assert.equal(projected.checkpoint.canonical.turn.status, "open");
  assert.equal(projected.checkpoint.canonical.run.status, "paused");
  assert.equal(projected.checkpoint.canonical.run.pause.subject, "plan");
  assert.deepEqual(projected.checkpoint.canonical.events.map((event) => event.type), [
    "turn.admitted",
    "run.started",
    "plan.artifact_accepted",
  ]);
});

test("emergency checkpoint transaction closes a running Chat as canonical error", () => {
  const checkpoint = checkpointRuntime.createTurnRuntimeCheckpoint({
    canonical: runningCanonical("chat"),
    updatedAt: 102,
  });
  const projected = checkpointRuntime.projectTurnRuntimeCheckpointTransaction({
    checkpoint,
    owner: turn,
    run,
    strategy: "chat",
    outcome: {
      status: "completed",
      resultKind: "error",
      reason: "terminal_publication_failed",
    },
    at: 200,
    closesTurn: true,
  });

  assert.equal(projected.disposition, "projected", projected.reason);
  assert.equal(projected.compatibility.agentStatus, "error");
  assert.equal(projected.compatibility.conversationTurnStatus, "error");
  assert.equal(projected.compatibility.resultKind, "error");
  assert.equal(projected.compatibility.isTerminal, true);
  assert.equal(projected.checkpoint.canonical.turn.status, "completed");
  assert.deepEqual(projected.checkpoint.canonical.events.map((event) => event.type), [
    "turn.admitted",
    "run.started",
    "run.completed",
    "turn.completed",
  ]);
});

test("cold restart retains creation budget and only preserves consumed scopes with typed evidence", () => {
  const requiredScopes = [
    { scopeKey: "ui", allowedPaths: ["src/ui"] },
    { scopeKey: "runtime", allowedPaths: ["src/runtime"] },
  ];
  let contract = preferredScopes.createPreferredDelegationScopeContract({
    requiredScopes,
    maxCreatedPerTurn: 2,
  });
  for (const [subagentId, scope] of [
    ["child-ui", requiredScopes[0]],
    ["child-runtime", requiredScopes[1]],
  ]) {
    contract = preferredScopes.recordPreferredDelegationScopeSpawn({
      contract,
      outcome: {
        subagentId,
        name: subagentId,
        status: "queued",
        scopeKey: scope.scopeKey,
        allowedPaths: scope.allowedPaths,
      },
    });
  }
  contract = preferredScopes.applyPreferredDelegationScopeJoinOutcomes({
    contract,
    outcomes: [{
      subagentId: "child-ui",
      scopeKey: "ui",
      status: "completed",
      closureState: "satisfied",
      adoptedEvidenceCount: 1,
      adoptedEvidenceTargets: ["src/ui/App.tsx"],
      consumed: true,
    }],
  });
  assert.deepEqual(contract.registrations.map((entry) => entry.state), [
    "consumed",
    "spawned",
  ]);

  const adoptedActivity = {
    name: "read_file",
    target: "src/ui/App.tsx",
    status: "succeeded",
    delegatedObservation: {
      owner: { agentKind: "subagent", subagentId: "child-ui" },
      sourceToolCallId: "call-ui-read",
      sourceObservationKey: "obs-ui-read",
      planningEvidenceState: "reusable",
      joinState: "consumed",
      closureState: "satisfied",
      parentContextState: "reference_only",
      requiresParentReread: true,
    },
  };
  const issued = closureReceipts.issueSubagentClosureReceipts({
    owner: {
      workspaceKey: turn.workspaceKey,
      sessionKey: turn.sessionKey,
      sessionEpoch: turn.sessionEpoch,
      parentTurnId: turn.turnId,
      parentRunId: run.runId,
    },
    contract,
    activities: [adoptedActivity],
    issuedAt: 120,
  });
  assert.deepEqual(issued.missingConsumedScopeKeys, []);

  let checkpoint = checkpointRuntime.createTurnRuntimeCheckpoint({
    canonical: runningCanonical(),
    preferredDelegationScopeContract: contract,
    updatedAt: 110,
  });
  checkpoint = checkpointRuntime.updateTurnRuntimePlanningCheckpoint({
    checkpoint,
    preferredDelegationScopeContract: contract,
    closureReceiptRefs: issued.receiptRefs,
    updatedAt: 120,
  });
  assert.ok(checkpoint);
  assert.equal(checkpoint.planning.closureReceiptRefs.length, 1);

  const restored = checkpointRuntime.normalizeTurnRuntimeCheckpoint(checkpoint, {
    closureReceiptLedger: issued.ledger,
    coldRestore: true,
    now: 200,
  });
  assert.ok(restored);
  assert.deepEqual(
    restored.planning.preferredDelegationScopeContract.registrations.map((entry) => entry.state),
    ["consumed", "incomplete"],
  );
  const progress = preferredScopes.getPreferredDelegationScopeProgress(
    restored.planning.preferredDelegationScopeContract,
  );
  assert.equal(progress.createdCount, 2);
  assert.equal(progress.creationCapacityRemaining, 0);
  assert.equal(progress.exhausted, true);

  const withoutReceipt = clone(checkpoint);
  withoutReceipt.planning.closureReceiptRefs = [];
  const restoredWithoutEvidence = checkpointRuntime.normalizeTurnRuntimeCheckpoint(
    withoutReceipt,
    { closureReceiptLedger: issued.ledger, coldRestore: true, now: 200 },
  );
  assert.ok(restoredWithoutEvidence);
  assert.deepEqual(
    restoredWithoutEvidence.planning.preferredDelegationScopeContract.registrations
      .map((entry) => entry.state),
    ["incomplete", "incomplete"],
  );
  assert.equal(
    preferredScopes.getPreferredDelegationScopeProgress(
      restoredWithoutEvidence.planning.preferredDelegationScopeContract,
    ).creationCapacityRemaining,
    0,
  );

  const tamperedLedger = clone(issued.ledger);
  tamperedLedger.receipts[0].acceptedEvidence[0].activity.target = "src/runtime/escape.ts";
  const restoredWithTamperedReceipt = checkpointRuntime.normalizeTurnRuntimeCheckpoint(
    checkpoint,
    { closureReceiptLedger: tamperedLedger, coldRestore: true, now: 200 },
  );
  assert.ok(restoredWithTamperedReceipt);
  assert.deepEqual(
    restoredWithTamperedReceipt.planning.preferredDelegationScopeContract.registrations
      .map((entry) => entry.state),
    ["incomplete", "incomplete"],
    "tampered receipt evidence is discarded without erasing the canonical Turn checkpoint",
  );
  assert.deepEqual(restoredWithTamperedReceipt.planning.closureReceiptRefs, []);
});

test("checkpoint upsert evicts the oldest Turn before crossing the durable map bound", () => {
  let checkpoints = {};
  for (let index = 0; index <= checkpointRuntime.MAX_DURABLE_TURN_RUNTIME_CHECKPOINTS; index += 1) {
    const turnIdentity = {
      ...turn,
      clientSubmissionId: `submission-bounded-${index}`,
      turnId: `turn-bounded-${index}`,
    };
    const runIdentity = {
      ...run,
      turnId: turnIdentity.turnId,
      runId: `run-bounded-${index}`,
      attemptId: `attempt-bounded-${index}`,
    };
    let canonical = canonicalRuntime.createCanonicalTurnRuntime({
      turn: turnIdentity,
      strategy: "chat",
      admittedAt: 1_000 + index * 2,
    });
    canonical = apply(canonical, "run.started", {
      run: runIdentity,
      phase: "preparing",
    }, 1_001 + index * 2);
    checkpoints = checkpointRuntime.upsertTurnRuntimeCheckpoint(
      checkpoints,
      checkpointRuntime.createTurnRuntimeCheckpoint({
        canonical,
        updatedAt: 1_001 + index * 2,
      }),
    );
  }

  assert.equal(
    Object.keys(checkpoints).length,
    checkpointRuntime.MAX_DURABLE_TURN_RUNTIME_CHECKPOINTS,
  );
  assert.equal(checkpoints["turn-bounded-0"], undefined);
  assert.ok(checkpoints[`turn-bounded-${checkpointRuntime.MAX_DURABLE_TURN_RUNTIME_CHECKPOINTS}`]);
});
