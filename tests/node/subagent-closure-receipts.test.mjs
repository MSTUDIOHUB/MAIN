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
const receipts = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/lib/subagentClosureReceipts.ts"),
);

const owner = {
  workspaceKey: "workspace-1",
  sessionKey: "session-1",
  sessionEpoch: "epoch-1",
  parentTurnId: "turn-1",
  parentRunId: "run-parent-1",
};

function workItem(id, taskKey, allowedPaths) {
  const result = collaboration.normalizeCollaborationWorkItemDraft({
    collaborationTaskId: id,
    draft: {
      taskKey,
      taskKind: "explore",
      objective: `Inspect ${taskKey} independently.`,
      delegationReason: "The parent can continue non-overlapping work.",
      successCriteria: "Return at least one exact source observation.",
      expectedOutput: "A concise source-backed finding.",
      requiredPaths: "",
      allowedPaths,
      accessMode: "read",
    },
  });
  assert.equal(result.ok, true);
  return result.workItem;
}

function entry({
  taskId,
  taskKey,
  subagentId,
  runId,
  allowedPaths,
  terminalState = "completed",
}) {
  return {
    workItem: workItem(taskId, taskKey, allowedPaths),
    parentTurnId: owner.parentTurnId,
    subagentId,
    runId,
    state: "closed",
    terminalState,
    evidenceReceiptIds: [],
    createdAt: 10,
    updatedAt: 20,
    closedAt: 20,
  };
}

function ledger(entries) {
  const normalized = collaboration.normalizeCollaborationLedger({
    schemaVersion: "collaboration-ledger.v1",
    parentTurnId: owner.parentTurnId,
    entries,
    updatedAt: 20,
  }, { parentTurnId: owner.parentTurnId });
  assert.ok(normalized);
  return normalized;
}

function activity({
  taskId,
  subagentId,
  runId,
  target,
  closureState = "satisfied",
  callId = `call-${taskId}`,
}) {
  return {
    name: "read_file",
    target,
    status: "succeeded",
    facts: [`fact:${taskId}`],
    delegatedObservation: {
      owner: {
        agentKind: "subagent",
        collaborationTaskId: taskId,
        subagentId,
        parentTurnId: owner.parentTurnId,
        runId,
      },
      sourceToolCallId: callId,
      sourceObservationKey: `observation-${taskId}`,
      sourceVersion: "v1",
      sourceContentHash: `hash-${taskId}`,
      sourceContentChars: 120,
      planningEvidenceState: "reusable",
      joinState: "consumed",
      closureState,
      parentContextState: "version_verified",
      requiresParentReread: false,
    },
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

test("issues task-owned receipts for completed and partial one-shot agents", () => {
  const completed = entry({
    taskId: "task-completed",
    taskKey: "title-chain",
    subagentId: "agent-completed",
    runId: "run-completed",
    allowedPaths: ["src/main.js"],
  });
  const partial = entry({
    taskId: "task-partial",
    taskKey: "save-chain",
    subagentId: "agent-partial",
    runId: "run-partial",
    allowedPaths: ["src/components"],
    terminalState: "partial",
  });
  const collaborationLedger = ledger([completed, partial]);
  const issued = receipts.issueSubagentClosureReceipts({
    owner,
    collaborationLedger,
    activities: [
      activity({
        taskId: "task-completed",
        subagentId: "agent-completed",
        runId: "run-completed",
        target: "src/main.js",
      }),
      activity({
        taskId: "task-partial",
        subagentId: "agent-partial",
        runId: "run-partial",
        target: "src/components/toolbar.js",
        closureState: "partial",
      }),
    ],
    issuedAt: 30,
  });

  assert.equal(issued.ledger.revision, 2);
  assert.deepEqual(issued.missingTaskIds, []);
  assert.equal(issued.receiptRefs.length, 2);
  assert.deepEqual(Object.keys(issued.receiptRefsByTask).sort(), [
    "task-completed",
    "task-partial",
  ]);
  const byTask = new Map(
    issued.ledger.receipts.map((receipt) => [receipt.collaborationTaskId, receipt]),
  );
  assert.equal(byTask.get("task-completed").closureState, "satisfied");
  assert.equal(byTask.get("task-partial").closureState, "partial");
  assert.equal(byTask.get("task-completed").runId, "run-completed");
  assert.deepEqual(
    receipts.normalizeSubagentClosureReceiptLedger(issued.ledger, {
      expectedOwner: owner,
    }),
    issued.ledger,
  );

  const resolved = receipts.resolveSubagentClosureReceiptReferences({
    ledger: issued.ledger,
    receiptRefs: issued.receiptRefs,
    expectedOwner: owner,
    collaborationLedger,
  });
  assert.deepEqual(resolved.rejectedReceiptRefs, []);
  assert.deepEqual(resolved.resolvedTaskIds.sort(), [
    "task-completed",
    "task-partial",
  ]);
  assert.equal(resolved.acceptedEvidence.length, 2);
});

test("receipt resolution is fenced by task, agent, run, parent owner, and lease", () => {
  const taskEntry = entry({
    taskId: "task-fenced",
    taskKey: "fenced-task",
    subagentId: "agent-fenced",
    runId: "run-fenced",
    allowedPaths: ["src/lib"],
  });
  const collaborationLedger = ledger([taskEntry]);
  const issued = receipts.issueSubagentClosureReceipts({
    owner,
    collaborationLedger,
    activities: [activity({
      taskId: "task-fenced",
      subagentId: "agent-fenced",
      runId: "run-fenced",
      target: "src/lib/subagents.ts",
    })],
    issuedAt: 30,
  });

  const wrongParent = receipts.resolveSubagentClosureReceiptReferences({
    ledger: issued.ledger,
    receiptRefs: issued.receiptRefs,
    expectedOwner: { ...owner, parentRunId: "run-parent-other" },
    collaborationLedger,
  });
  assert.deepEqual(wrongParent.resolvedReceiptRefs, []);
  assert.deepEqual(wrongParent.rejectedReceiptRefs, issued.receiptRefs);

  const runDrift = clone(collaborationLedger);
  runDrift.entries[0].runId = "run-reused";
  const wrongRun = receipts.resolveSubagentClosureReceiptReferences({
    ledger: issued.ledger,
    receiptRefs: issued.receiptRefs,
    expectedOwner: owner,
    collaborationLedger: runDrift,
  });
  assert.deepEqual(wrongRun.resolvedReceiptRefs, []);

  const pathDrift = clone(collaborationLedger);
  pathDrift.entries[0].workItem.allowedPaths = ["src/other"];
  const wrongPath = receipts.resolveSubagentClosureReceiptReferences({
    ledger: issued.ledger,
    receiptRefs: issued.receiptRefs,
    expectedOwner: owner,
    collaborationLedger: pathDrift,
  });
  assert.deepEqual(wrongPath.resolvedReceiptRefs, []);
});

test("tampering with task identity or evidence invalidates the sealed ledger", () => {
  const taskEntry = entry({
    taskId: "task-sealed",
    taskKey: "sealed-task",
    subagentId: "agent-sealed",
    runId: "run-sealed",
    allowedPaths: ["src/main.js"],
  });
  const issued = receipts.issueSubagentClosureReceipts({
    owner,
    collaborationLedger: ledger([taskEntry]),
    activities: [activity({
      taskId: "task-sealed",
      subagentId: "agent-sealed",
      runId: "run-sealed",
      target: "src/main.js",
    })],
    issuedAt: 30,
  });

  const identityTamper = clone(issued.ledger);
  identityTamper.receipts[0].collaborationTaskId = "task-forged";
  assert.equal(receipts.normalizeSubagentClosureReceiptLedger(identityTamper), null);

  const evidenceTamper = clone(issued.ledger);
  evidenceTamper.receipts[0].acceptedEvidence[0].activity.facts[0] = "forged fact";
  assert.equal(receipts.normalizeSubagentClosureReceiptLedger(evidenceTamper), null);
});

test("unowned, stale-run, and out-of-lease observations never receive a receipt", () => {
  const taskEntry = entry({
    taskId: "task-bounded",
    taskKey: "bounded-task",
    subagentId: "agent-bounded",
    runId: "run-bounded",
    allowedPaths: ["src/main.js"],
  });
  const collaborationLedger = ledger([taskEntry]);
  for (const observation of [
    activity({
      taskId: "task-other",
      subagentId: "agent-bounded",
      runId: "run-bounded",
      target: "src/main.js",
    }),
    activity({
      taskId: "task-bounded",
      subagentId: "agent-bounded",
      runId: "run-stale",
      target: "src/main.js",
    }),
    activity({
      taskId: "task-bounded",
      subagentId: "agent-bounded",
      runId: "run-bounded",
      target: "src/other.js",
    }),
  ]) {
    const issued = receipts.issueSubagentClosureReceipts({
      owner,
      collaborationLedger,
      activities: [observation],
      issuedAt: 30,
    });
    assert.deepEqual(issued.receiptRefs, []);
    assert.deepEqual(issued.missingTaskIds, ["task-bounded"]);
  }
});
