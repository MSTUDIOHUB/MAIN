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
      for (const candidate of [
        basePath,
        `${basePath}.ts`,
        `${basePath}.tsx`,
        path.join(basePath, "index.ts"),
      ]) {
        if (fs.existsSync(candidate) && /\.tsx?$/.test(candidate)) {
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

const collaboration = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/lib/collaborationWorkItems.ts"),
);
const subagents = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/lib/subagents.ts"),
);

function workItem(id, overrides = {}) {
  const normalized = collaboration.normalizeCollaborationWorkItemDraft({
    collaborationTaskId: id,
    draft: {
      taskKey: "title-display-chain",
      taskKind: "explore",
      objective: "Trace how the editor title renders unsaved document state.",
      delegationReason: "This causal chain can be investigated independently.",
      successCriteria: "Identify the state owner\nIdentify the render projection",
      expectedOutput: "Source-backed causal chain with exact symbols.",
      requiredPaths: "",
      allowedPaths: "src/main.js",
      accessMode: "read",
      ...overrides,
    },
  });
  assert.equal(normalized.ok, true);
  return normalized.workItem;
}

test("semantic fingerprints ignore leases while preserving task meaning", () => {
  const first = workItem("task-1", { allowedPaths: "src/main.js" });
  const second = workItem("task-2", { allowedPaths: "src/components/toolbar.js" });
  const distinct = workItem("task-3", {
    taskKey: "save-dialog-chain",
    objective: "Trace why opening a local markdown file triggers a save dialog.",
  });
  assert.equal(first.semanticFingerprint, second.semanticFingerprint);
  assert.notEqual(first.semanticFingerprint, distinct.semanticFingerprint);
});

test("a complete work item contract is required before scheduling", () => {
  const invalid = collaboration.normalizeCollaborationWorkItemDraft({
    collaborationTaskId: "task-invalid",
    draft: {
      objective: "Parent objective copied verbatim",
      allowedPaths: "src",
    },
  });
  assert.equal(invalid.ok, false);
  assert.deepEqual(
    new Set(invalid.missingFields),
    new Set([
      "task_key",
      "task_kind",
      "delegation_reason",
      "success_criteria",
      "expected_output",
      "required_paths",
      "access_mode",
    ]),
  );

  const missingRuntimeIdentity = collaboration.normalizeCollaborationWorkItemDraft({
    collaborationTaskId: "",
    draft: {
      taskKey: "runtime-id-check",
      taskKind: "explore",
      objective: "Inspect an independent runtime identity.",
      delegationReason: "The scheduler owns this identity.",
      successCriteria: "Return a task-owned observation.",
      expectedOutput: "One evidence record.",
      requiredPaths: "",
      allowedPaths: "src/main.js",
      accessMode: "read",
    },
  });
  assert.equal(missingRuntimeIdentity.ok, false);
  assert.deepEqual(missingRuntimeIdentity.missingFields, [
    "collaboration_task_id",
  ]);
});

test("duplicate semantics are rejected across paths while distinct tasks may share a directory", () => {
  subagents.resetSubagentRuntimeForTests();
  const first = workItem("task-1", { allowedPaths: "src/main.js" });
  subagents.registerCollaborationTask({
    threadId: "thread-1",
    sessionEpoch: "epoch-1",
    parentTurnId: "turn-1",
    workItem: first,
    subagentId: "agent-1",
    runId: "run-1",
  });
  subagents.updateCollaborationTaskState({
    threadId: "thread-1",
    sessionEpoch: "epoch-1",
    parentTurnId: "turn-1",
    collaborationTaskId: first.collaborationTaskId,
    state: "queued",
  });

  const duplicate = subagents.evaluateCollaborationTaskAdmission({
    threadId: "thread-1",
    sessionEpoch: "epoch-1",
    parentTurnId: "turn-1",
    workItem: workItem("task-2", {
      allowedPaths: "src/components/toolbar.js",
    }),
  });
  assert.equal(duplicate.action, "defer");
  assert.equal(duplicate.reason, "duplicate_semantic_task");

  const distinct = subagents.evaluateCollaborationTaskAdmission({
    threadId: "thread-1",
    sessionEpoch: "epoch-1",
    parentTurnId: "turn-1",
    workItem: workItem("task-3", {
      taskKey: "save-dialog-chain",
      objective: "Trace why opening a local markdown file triggers a save dialog.",
      allowedPaths: "src/main.js",
    }),
  });
  assert.deepEqual(distinct, { action: "admit" });
});

test("satisfied evidence returns a receipt and explicit independent review may repeat", () => {
  subagents.resetSubagentRuntimeForTests();
  const completed = workItem("task-completed");
  subagents.registerCollaborationTask({
    threadId: "thread-2",
    sessionEpoch: "epoch-2",
    parentTurnId: "turn-2",
    workItem: completed,
    subagentId: "agent-completed",
    runId: "run-completed",
  });
  subagents.updateCollaborationTaskState({
    threadId: "thread-2",
    sessionEpoch: "epoch-2",
    parentTurnId: "turn-2",
    collaborationTaskId: completed.collaborationTaskId,
    state: "completed",
  });
  const unverifiedCompletion = subagents.evaluateCollaborationTaskAdmission({
    threadId: "thread-2",
    sessionEpoch: "epoch-2",
    parentTurnId: "turn-2",
    workItem: workItem("task-repeat", { allowedPaths: "src/other.js" }),
  });
  assert.equal(unverifiedCompletion.action, "defer");
  assert.equal(unverifiedCompletion.reason, "duplicate_semantic_task");

  subagents.restoreCollaborationRuntimeLedgerForParent({
    threadId: "thread-2",
    sessionEpoch: "epoch-2",
    ledger: {
      schemaVersion: collaboration.COLLABORATION_LEDGER_SCHEMA_VERSION,
      parentTurnId: "turn-2",
      entries: [{
        workItem: completed,
        parentTurnId: "turn-2",
        subagentId: "agent-completed",
        runId: "run-completed",
        state: "closed",
        terminalState: "completed",
        evidenceReceiptIds: ["receipt-completed"],
        createdAt: 10,
        updatedAt: 20,
        closedAt: 20,
      }],
      updatedAt: 20,
    },
  });
  const receipt = subagents.evaluateCollaborationTaskAdmission({
    threadId: "thread-2",
    sessionEpoch: "epoch-2",
    parentTurnId: "turn-2",
    workItem: workItem("task-receipt", { allowedPaths: "src/receipt.js" }),
  });
  assert.equal(receipt.action, "defer");
  assert.equal(receipt.reason, "evidence_already_satisfied");
  assert.deepEqual(receipt.existing.evidenceReceiptIds, ["receipt-completed"]);

  const reviewOne = workItem("task-review-1", {
    taskKey: "independent-review-1",
    taskKind: "review",
    objective: "Independently review the title display causal chain.",
    independentReviewOf: completed.taskKey,
  });
  subagents.registerCollaborationTask({
    threadId: "thread-2",
    sessionEpoch: "epoch-2",
    parentTurnId: "turn-2",
    workItem: reviewOne,
    subagentId: "agent-review-1",
    runId: "run-review-1",
  });
  const reviewTwo = workItem("task-review-2", {
    taskKey: "independent-review-2",
    taskKind: "review",
    objective: "Independently review the title display causal chain.",
    independentReviewOf: completed.taskKey,
  });
  assert.deepEqual(subagents.evaluateCollaborationTaskAdmission({
    threadId: "thread-2",
    sessionEpoch: "epoch-2",
    parentTurnId: "turn-2",
    workItem: reviewTwo,
  }), { action: "admit" });

  const orphanReview = workItem("task-review-orphan", {
    taskKey: "independent-review-orphan",
    taskKind: "review",
    objective: "Independently review a task that does not exist.",
    independentReviewOf: "missing-task",
  });
  assert.deepEqual(subagents.evaluateCollaborationTaskAdmission({
    threadId: "thread-2",
    sessionEpoch: "epoch-2",
    parentTurnId: "turn-2",
    workItem: orphanReview,
  }), { action: "defer", reason: "dependency_unresolved" });
});

test("the collaboration ledger persists identities and closes without model context", () => {
  subagents.resetSubagentRuntimeForTests();
  const item = workItem("task-ledger");
  subagents.registerCollaborationTask({
    threadId: "thread-ledger",
    sessionEpoch: "epoch-ledger",
    parentTurnId: "turn-ledger",
    workItem: item,
    subagentId: "agent-ledger",
    runId: "run-ledger",
    now: 10,
  });
  subagents.updateCollaborationTaskState({
    threadId: "thread-ledger",
    sessionEpoch: "epoch-ledger",
    parentTurnId: "turn-ledger",
    collaborationTaskId: item.collaborationTaskId,
    state: "closed",
    now: 20,
  });
  const ledger = subagents.getCollaborationLedgerForParent({
    threadId: "thread-ledger",
    sessionEpoch: "epoch-ledger",
    parentTurnId: "turn-ledger",
    now: 20,
  });
  assert.equal(ledger.entries.length, 1);
  assert.equal(ledger.entries[0].state, "closed");
  assert.equal(ledger.entries[0].terminalState, "interrupted");
  assert.equal(ledger.entries[0].subagentId, "agent-ledger");
  assert.equal(ledger.entries[0].runId, "run-ledger");
  assert.equal("messages" in ledger.entries[0], false);
  assert.equal("context" in ledger.entries[0], false);
});

test("task, agent, and run identities are one-to-one and lifecycle state cannot regress", () => {
  subagents.resetSubagentRuntimeForTests();
  const first = workItem("task-identity-1");
  subagents.registerCollaborationTask({
    threadId: "thread-identity",
    sessionEpoch: "epoch-identity",
    parentTurnId: "turn-identity",
    workItem: first,
    subagentId: "agent-identity-1",
    runId: "run-identity-1",
  });
  assert.throws(() => subagents.registerCollaborationTask({
    threadId: "thread-identity",
    sessionEpoch: "epoch-identity",
    parentTurnId: "turn-identity",
    workItem: workItem("task-identity-2", {
      taskKey: "other-task",
      objective: "Inspect another independent task.",
    }),
    subagentId: "agent-identity-2",
    runId: "run-identity-1",
  }), /COLLABORATION_RUNTIME_IDENTITY_ALREADY_REGISTERED/);

  assert.equal(subagents.updateCollaborationTaskState({
    threadId: "thread-identity",
    sessionEpoch: "epoch-identity",
    parentTurnId: "turn-identity",
    collaborationTaskId: first.collaborationTaskId,
    state: "queued",
  }), true);
  assert.equal(subagents.updateCollaborationTaskState({
    threadId: "thread-identity",
    sessionEpoch: "epoch-identity",
    parentTurnId: "turn-identity",
    collaborationTaskId: first.collaborationTaskId,
    state: "running",
  }), true);
  assert.equal(subagents.updateCollaborationTaskState({
    threadId: "thread-identity",
    sessionEpoch: "epoch-identity",
    parentTurnId: "turn-identity",
    collaborationTaskId: first.collaborationTaskId,
    state: "completed",
  }), true);
  assert.equal(subagents.updateCollaborationTaskState({
    threadId: "thread-identity",
    sessionEpoch: "epoch-identity",
    parentTurnId: "turn-identity",
    collaborationTaskId: first.collaborationTaskId,
    state: "running",
  }), false);
  assert.equal(subagents.updateCollaborationTaskState({
    threadId: "thread-identity",
    sessionEpoch: "epoch-identity",
    parentTurnId: "turn-identity",
    collaborationTaskId: first.collaborationTaskId,
    state: "closed",
  }), true);
});

test("restored task receipts survive republish and never revive old agent identities", () => {
  subagents.resetSubagentRuntimeForTests();
  const item = workItem("task-restored");
  subagents.restoreCollaborationRuntimeLedgerForParent({
    threadId: "thread-restored",
    sessionEpoch: "epoch-restored",
    ledger: {
      schemaVersion: collaboration.COLLABORATION_LEDGER_SCHEMA_VERSION,
      parentTurnId: "turn-restored",
      entries: [{
        workItem: item,
        parentTurnId: "turn-restored",
        subagentId: "agent-restored",
        runId: "run-restored",
        state: "closed",
        terminalState: "completed",
        evidenceReceiptIds: ["receipt-restored"],
        createdAt: 10,
        updatedAt: 20,
        closedAt: 20,
      }],
      updatedAt: 20,
    },
  });

  const restored = subagents.getCollaborationLedgerForParent({
    threadId: "thread-restored",
    sessionEpoch: "epoch-restored",
    parentTurnId: "turn-restored",
    now: 30,
  });
  assert.deepEqual(restored.entries[0].evidenceReceiptIds, ["receipt-restored"]);
  const duplicate = subagents.evaluateCollaborationTaskAdmission({
    threadId: "thread-restored",
    sessionEpoch: "epoch-restored",
    parentTurnId: "turn-restored",
    workItem: workItem("task-restored-repeat", {
      allowedPaths: "src/other.js",
    }),
  });
  assert.equal(duplicate.action, "defer");
  assert.equal(duplicate.reason, "evidence_already_satisfied");
  assert.deepEqual(duplicate.existing.evidenceReceiptIds, ["receipt-restored"]);

  assert.throws(() => subagents.registerCoordinatedSubagentRun({
    threadId: "thread-restored",
    sessionEpoch: "epoch-restored",
    parentTurnId: "turn-restored",
    subagentId: "agent-restored",
    generation: "generation-restored",
    name: "Restored",
    scopeKey: item.taskKey,
    runId: "run-restored",
    parentRunId: "run-parent",
    completion: new Promise(() => {}),
  }), /SUBAGENT_ID_ALREADY_REGISTERED/);
});

test("restored active entries become interrupted closed records", () => {
  subagents.resetSubagentRuntimeForTests();
  const item = workItem("task-interrupted");
  subagents.restoreCollaborationRuntimeLedgerForParent({
    threadId: "thread-interrupted",
    sessionEpoch: "epoch-interrupted",
    ledger: {
      schemaVersion: collaboration.COLLABORATION_LEDGER_SCHEMA_VERSION,
      parentTurnId: "turn-interrupted",
      entries: [{
        workItem: item,
        parentTurnId: "turn-interrupted",
        subagentId: "agent-interrupted",
        runId: "run-interrupted",
        state: "running",
        evidenceReceiptIds: [],
        createdAt: 10,
        updatedAt: 20,
      }],
      updatedAt: 20,
    },
  });
  const restored = subagents.getCollaborationLedgerForParent({
    threadId: "thread-interrupted",
    sessionEpoch: "epoch-interrupted",
    parentTurnId: "turn-interrupted",
    now: 30,
  });
  assert.equal(restored.entries[0].state, "closed");
  assert.equal(restored.entries[0].terminalState, "interrupted");
  assert.ok(restored.entries[0].closedAt >= 20);
});

test("cold restore archives an unclosed terminal record without losing its outcome", () => {
  const item = workItem("task-cold-terminal");
  const restored = collaboration.normalizeCollaborationLedger({
    schemaVersion: collaboration.COLLABORATION_LEDGER_SCHEMA_VERSION,
    parentTurnId: "turn-cold-terminal",
    entries: [{
      workItem: item,
      parentTurnId: "turn-cold-terminal",
      subagentId: "agent-cold-terminal",
      runId: "run-cold-terminal",
      state: "completed",
      terminalState: "completed",
      evidenceReceiptIds: ["receipt-cold-terminal"],
      createdAt: 10,
      updatedAt: 20,
    }],
    updatedAt: 20,
  }, {
    parentTurnId: "turn-cold-terminal",
    coldRestore: true,
    now: 30,
  });
  assert.equal(restored.entries[0].state, "closed");
  assert.equal(restored.entries[0].terminalState, "completed");
  assert.equal(restored.entries[0].closedAt, 30);
});

test("late events cannot reactivate or contaminate a closed one-shot identity", () => {
  const baseSnapshot = {
    id: "agent-event-fence",
    collaborationTaskId: "task-event-first",
    parentTurnId: "turn-event-fence",
    threadId: "thread-event-fence",
    name: "Event Fence",
    role: "investigator",
    objective: "Inspect one immutable task.",
    runId: "run-event-first",
    parentRunId: "run-parent",
    status: "queued",
    profile: "local",
    provider: "provider",
    model: "model",
    createdAt: 10,
    updatedAt: 10,
  };
  const events = [{
    type: "subagent.created",
    threadId: "thread-event-fence",
    turnId: "turn-event-fence",
    timestampMs: 10,
    collaborationTaskId: "task-event-first",
    subagentId: "agent-event-fence",
    runId: "run-event-first",
    parentRunId: "run-parent",
    subagent: baseSnapshot,
  }, {
    type: "subagent.closed",
    threadId: "thread-event-fence",
    turnId: "turn-event-fence",
    timestampMs: 20,
    collaborationTaskId: "task-event-first",
    subagentId: "agent-event-fence",
    runId: "run-event-first",
    parentRunId: "run-parent",
    closedAt: 20,
    reason: "canceled",
  }, {
    type: "subagent.updated",
    threadId: "thread-event-fence",
    turnId: "turn-event-fence",
    timestampMs: 25,
    collaborationTaskId: "task-event-first",
    subagentId: "agent-event-fence",
    runId: "run-event-first",
    parentRunId: "run-parent",
    patch: { status: "running", updatedAt: 25 },
  }, {
    type: "subagent.created",
    threadId: "thread-event-fence",
    turnId: "turn-event-fence",
    timestampMs: 30,
    collaborationTaskId: "task-event-second",
    subagentId: "agent-event-fence",
    runId: "run-event-second",
    parentRunId: "run-parent",
    subagent: {
      ...baseSnapshot,
      collaborationTaskId: "task-event-second",
      runId: "run-event-second",
      createdAt: 30,
      updatedAt: 30,
    },
  }, {
    type: "subagent.updated",
    threadId: "thread-event-fence",
    turnId: "turn-event-fence",
    timestampMs: 40,
    collaborationTaskId: "task-event-second",
    subagentId: "agent-event-fence",
    runId: "run-event-second",
    parentRunId: "run-parent",
    patch: { status: "running", updatedAt: 40 },
  }];
  const projected = subagents.projectSubagentRuns(events);
  assert.equal(projected.length, 1);
  assert.equal(projected[0].collaborationTaskId, "task-event-first");
  assert.equal(projected[0].runId, "run-event-first");
  assert.equal(projected[0].status, "canceled");
});
