import test from "node:test";
import assert from "node:assert/strict";
import fsSync from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

import ts from "typescript";

const workspaceRoot = process.cwd();
const moduleCache = new Map();

function loadTranspiledModuleSync(sourcePath) {
  const normalizedPath = path.resolve(sourcePath);
  if (moduleCache.has(normalizedPath)) return moduleCache.get(normalizedPath);
  const source = fsSync.readFileSync(normalizedPath, "utf8");
  const transpiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    fileName: normalizedPath,
  }).outputText;
  const module = { exports: {} };
  moduleCache.set(normalizedPath, module.exports);
  const localRequire = createRequire(normalizedPath);
  const runtimeRequire = (specifier) => {
    if (specifier.startsWith(".")) {
      const basePath = path.resolve(path.dirname(normalizedPath), specifier);
      for (const candidate of [
        basePath,
        `${basePath}.ts`,
        `${basePath}.tsx`,
        path.join(basePath, "index.ts"),
      ]) {
        if (fsSync.existsSync(candidate) && /\.tsx?$/.test(candidate)) {
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

const {
  buildWorkspaceTurnQueueEntryIdentity,
  createWorkspaceTurnQueueState,
  normalizeWorkspaceInstruction,
  reconcileWorkspaceTurnQueueOnRestore,
  reduceWorkspaceTurnQueue,
} = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/store/workspaceTurnQueue.ts"),
);
const {
  buildWorkspaceInstructionConversationTurn,
  reconcileWorkspaceInstructionProjection,
} = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/store/workspaceInstructionProjection.ts"),
);
const {
  shouldDeferWorkspaceInstructionDispatchForActiveOwner,
} = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/store/workspaceInstructionApproval.ts"),
);

const sessionKey = "/repo::session-7";
const sessionEpoch = "session-epoch-7";

function instruction(id, at, overrides = {}) {
  return {
    schemaVersion: 1,
    kind: "workspace_instruction",
    clientSubmissionId: id,
    sessionKey,
    sessionEpoch,
    source: "composer",
    submittedAt: at,
    payload: {
      text: `instruction ${id}`,
      dispatchHints: {
        resolvedIntent: "execute",
        nested: { enabled: true, attempts: [1, 2] },
      },
    },
    ...overrides,
  };
}

function receipt(id, at, overrides = {}) {
  return {
    schemaVersion: 1,
    kind: "workspace_turn_receipt",
    receiptId: `receipt-${id}`,
    clientSubmissionId: id,
    sessionKey,
    sessionEpoch,
    turnId: `turn-${id}`,
    userBlockId: 1_000 + at,
    acceptedAt: at,
    ...overrides,
  };
}

function apply(state, command) {
  const result = reduceWorkspaceTurnQueue(state, command);
  assert.equal(result.disposition, "applied", result.reason);
  return result.state;
}

function append(state, id, at) {
  return apply(state, {
    type: "append",
    expectedVersion: state.version,
    at,
    instruction: instruction(id, at),
    receipt: receipt(id, at),
  });
}

function commit(state, id, at) {
  return apply(state, {
    type: "commit",
    expectedVersion: state.version,
    at,
    clientSubmissionId: id,
    receiptId: `receipt-${id}`,
    sessionKey,
    sessionEpoch,
  });
}

function claim(state, claimId, at) {
  return apply(state, {
    type: "claim",
    expectedVersion: state.version,
    at,
    claimId,
    sessionKey,
    sessionEpoch,
  });
}

function ownerForEntry(entry, overrides = {}) {
  return {
    sessionKey: entry.receipt.sessionKey,
    sessionEpoch: entry.receipt.sessionEpoch,
    turnId: entry.receipt.turnId,
    receiptId: entry.receipt.receiptId,
    clientSubmissionId: entry.instruction.clientSubmissionId,
    instructionEnvelopeIdentity: buildWorkspaceTurnQueueEntryIdentity(entry),
    ...overrides,
  };
}

test("strict FIFO dispatch removes only the terminal head before advancing", () => {
  let state = createWorkspaceTurnQueueState({ sessionKey, sessionEpoch });
  state = append(state, "a", 10);
  state = commit(state, "a", 11);
  state = append(state, "b", 12);
  state = commit(state, "b", 13);
  state = claim(state, "claim-a", 14);

  assert.equal(state.entries[0].receipt.turnId, "turn-a");
  assert.equal(state.entries[0].status, "dispatching");
  assert.equal(state.entries[1].status, "queued");

  const cannotSkipClaimedHead = reduceWorkspaceTurnQueue(state, {
    type: "claim",
    expectedVersion: state.version,
    at: 15,
    claimId: "claim-b",
    sessionKey,
    sessionEpoch,
  });
  assert.equal(cannotSkipClaimedHead.disposition, "rejected");
  assert.equal(cannotSkipClaimedHead.reason, "head_dispatching");

  state = apply(state, {
    type: "remove",
    expectedVersion: state.version,
    at: 16,
    claimId: "claim-a",
    sessionKey,
    sessionEpoch,
    terminalOwner: ownerForEntry(state.entries[0]),
  });
  state = claim(state, "claim-b", 17);
  assert.equal(state.entries.length, 1);
  assert.equal(state.entries[0].receipt.turnId, "turn-b");
  assert.equal(state.entries[0].claim.claimId, "claim-b");
});

test("pending review keeps durable A/B queued, then dispatches each exactly once in FIFO order", () => {
  let state = createWorkspaceTurnQueueState({ sessionKey, sessionEpoch });
  state = append(state, "a", 100);
  state = commit(state, "a", 101);
  state = append(state, "b", 102);
  state = commit(state, "b", 103);
  const dispatchOrder = [];
  let legacyLatestWinsSlot = null;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const deferred = shouldDeferWorkspaceInstructionDispatchForActiveOwner({
      isGenerating: attempt === 0,
      agentStatus: "pending_review",
      hasPendingActionRequest: true,
      hasExactPendingReviewActionDecision: false,
      cancellationFenceFailed: false,
    });
    if (!deferred) {
      legacyLatestWinsSlot = state.entries[0].instruction.payload.text;
    }
  }

  assert.equal(legacyLatestWinsSlot, null);
  assert.deepEqual(state.entries.map((entry) => [
    entry.instruction.clientSubmissionId,
    entry.status,
  ]), [["a", "queued"], ["b", "queued"]]);

  for (const expectedId of ["a", "b"]) {
    assert.equal(shouldDeferWorkspaceInstructionDispatchForActiveOwner({
      isGenerating: false,
      agentStatus: "idle",
      hasPendingActionRequest: false,
      hasExactPendingReviewActionDecision: false,
      cancellationFenceFailed: false,
    }), false);
    state = claim(state, `claim-${expectedId}`, state.updatedAt + 1);
    const head = state.entries[0];
    dispatchOrder.push(head.instruction.clientSubmissionId);
    state = apply(state, {
      type: "ack",
      expectedVersion: state.version,
      at: state.updatedAt + 1,
      claimId: `claim-${expectedId}`,
      sessionKey,
      sessionEpoch,
      turnOwner: ownerForEntry(head),
    });
  }

  assert.deepEqual(dispatchOrder, ["a", "b"]);
  assert.equal(new Set(dispatchOrder).size, 2);
  assert.equal(state.entries.length, 0);
});

test("a Run admission acknowledges its exact head without waiting for Turn terminality", () => {
  let state = createWorkspaceTurnQueueState({ sessionKey, sessionEpoch });
  state = append(state, "accepted-run", 18);
  state = commit(state, "accepted-run", 19);
  state = claim(state, "claim-accepted-run", 20);

  const wrongTurn = reduceWorkspaceTurnQueue(state, {
    type: "ack",
    expectedVersion: state.version,
    at: 21,
    claimId: "claim-accepted-run",
    sessionKey,
    sessionEpoch,
    turnOwner: ownerForEntry(state.entries[0], { turnId: "other-turn" }),
  });
  assert.equal(wrongTurn.disposition, "rejected");
  assert.equal(wrongTurn.reason, "terminal_owner_mismatch");

  state = apply(state, {
    type: "ack",
    expectedVersion: state.version,
    at: 22,
    claimId: "claim-accepted-run",
    sessionKey,
    sessionEpoch,
    turnOwner: ownerForEntry(state.entries[0]),
  });
  assert.equal(state.entries.length, 0);
});

test("a later persisted entry cannot bypass a persisting FIFO head", () => {
  let state = createWorkspaceTurnQueueState({ sessionKey, sessionEpoch });
  state = append(state, "a", 20);
  state = append(state, "b", 21);
  state = commit(state, "b", 22);

  assert.deepEqual(state.entries.map((entry) => entry.status), ["persisting", "queued"]);
  const blocked = reduceWorkspaceTurnQueue(state, {
    type: "claim",
    expectedVersion: state.version,
    at: 23,
    claimId: "cannot-skip-a",
    sessionKey,
    sessionEpoch,
  });
  assert.equal(blocked.disposition, "rejected");
  assert.equal(blocked.reason, "head_persisting");
  assert.strictEqual(blocked.state, state);

  state = commit(state, "a", 24);
  state = claim(state, "claim-a", 25);
  assert.equal(state.entries[0].instruction.clientSubmissionId, "a");
});

test("append is idempotent by exact clientSubmissionId and rejects identity reuse", () => {
  const initial = createWorkspaceTurnQueueState({ sessionKey, sessionEpoch });
  const firstCommand = {
    type: "append",
    expectedVersion: initial.version,
    at: 30,
    instruction: instruction("same", 30),
    receipt: receipt("same", 30),
  };
  const first = reduceWorkspaceTurnQueue(initial, firstCommand);
  assert.equal(first.disposition, "applied");

  const retry = reduceWorkspaceTurnQueue(first.state, firstCommand);
  assert.equal(retry.disposition, "idempotent");
  assert.strictEqual(retry.state, first.state);
  assert.equal(retry.state.entries.length, 1);

  const conflict = reduceWorkspaceTurnQueue(first.state, {
    ...firstCommand,
    expectedVersion: first.state.version,
    at: 31,
    receipt: receipt("same", 30, { turnId: "turn-reused-id" }),
  });
  assert.equal(conflict.disposition, "rejected");
  assert.equal(conflict.reason, "client_submission_conflict");
  assert.strictEqual(conflict.state, first.state);
});

test("a context-only workspace submission is still a valid durable Turn", () => {
  const state = createWorkspaceTurnQueueState({ sessionKey, sessionEpoch });
  const contextOnly = instruction("context-only", 35, {
    payload: {
      text: "",
      contextMentions: ["src/runtime.ts"],
    },
  });
  const result = reduceWorkspaceTurnQueue(state, {
    type: "append",
    expectedVersion: state.version,
    at: 35,
    instruction: contextOnly,
    receipt: receipt("context-only", 35),
  });

  assert.equal(result.disposition, "applied");
  assert.deepEqual(result.entry.instruction.payload.contextMentions, ["src/runtime.ts"]);
});

test("every mutating transition requires exact version, Session epoch, claim, and terminal owner", () => {
  let state = createWorkspaceTurnQueueState({ sessionKey, sessionEpoch });
  state = append(state, "exact", 40);

  const staleCommit = reduceWorkspaceTurnQueue(state, {
    type: "commit",
    expectedVersion: state.version - 1,
    at: 41,
    clientSubmissionId: "exact",
    receiptId: "receipt-exact",
    sessionKey,
    sessionEpoch,
  });
  assert.equal(staleCommit.reason, "version_conflict");

  state = commit(state, "exact", 42);
  const wrongEpoch = reduceWorkspaceTurnQueue(state, {
    type: "claim",
    expectedVersion: state.version,
    at: 43,
    claimId: "claim-exact",
    sessionKey,
    sessionEpoch: "stale-session-epoch",
  });
  assert.equal(wrongEpoch.reason, "queue_owner_mismatch");

  state = claim(state, "claim-exact", 44);
  for (const command of [
    {
      type: "release", expectedVersion: state.version, at: 45,
      claimId: "other-claim", sessionKey, sessionEpoch,
    },
    {
      type: "remove", expectedVersion: state.version, at: 45,
      claimId: "claim-exact", sessionKey, sessionEpoch,
      terminalOwner: ownerForEntry(state.entries[0], { turnId: "other-turn" }),
    },
  ]) {
    const rejected = reduceWorkspaceTurnQueue(state, command);
    assert.equal(rejected.disposition, "rejected");
    assert.equal(
      rejected.reason,
      command.type === "release" ? "claim_id_mismatch" : "terminal_owner_mismatch",
    );
    assert.strictEqual(rejected.state, state);
  }

  state = apply(state, {
    type: "release",
    expectedVersion: state.version,
    at: 46,
    claimId: "claim-exact",
    sessionKey,
    sessionEpoch,
  });
  assert.equal(state.entries[0].status, "queued");
  assert.equal(state.entries[0].claim, null);
});

test("rollback removes only an exact entry that has not committed persistence", () => {
  let state = createWorkspaceTurnQueueState({ sessionKey, sessionEpoch });
  state = append(state, "persist-failed", 50);
  state = append(state, "persisted", 51);
  state = commit(state, "persisted", 52);

  const cannotRollbackCommitted = reduceWorkspaceTurnQueue(state, {
    type: "rollback",
    expectedVersion: state.version,
    at: 53,
    clientSubmissionId: "persisted",
    receiptId: "receipt-persisted",
    sessionKey,
    sessionEpoch,
  });
  assert.equal(cannotRollbackCommitted.reason, "entry_state_conflict");

  state = apply(state, {
    type: "rollback",
    expectedVersion: state.version,
    at: 54,
    clientSubmissionId: "persist-failed",
    receiptId: "receipt-persist-failed",
    sessionKey,
    sessionEpoch,
  });
  assert.deepEqual(
    state.entries.map((entry) => entry.instruction.clientSubmissionId),
    ["persisted"],
  );
});

test("restore normalizes persisting and dispatching entries to unclaimed queued work", () => {
  let state = createWorkspaceTurnQueueState({ sessionKey, sessionEpoch });
  state = append(state, "dispatching", 60);
  state = commit(state, "dispatching", 61);
  state = append(state, "persisting", 62);
  state = claim(state, "crashed-claim", 63);

  assert.deepEqual(state.entries.map((entry) => entry.status), ["dispatching", "persisting"]);
  const restored = reconcileWorkspaceTurnQueueOnRestore({
    snapshot: JSON.parse(JSON.stringify(state)),
    sessionKey,
    sessionEpoch,
    at: 70,
  });
  assert.deepEqual(restored.entries.map((entry) => entry.status), ["queued", "queued"]);
  assert.deepEqual(restored.entries.map((entry) => entry.claim), [null, null]);
  assert.deepEqual(
    restored.entries.map((entry) => entry.instruction.clientSubmissionId),
    ["dispatching", "persisting"],
  );
  assert.equal(restored.entries[1].persistedAt, 70);
  assert.equal(restored.version, state.version + 1);
});

test("restore removes exact terminal Turn owners without accepting cross-epoch lookalikes", () => {
  let state = createWorkspaceTurnQueueState({ sessionKey, sessionEpoch });
  state = append(state, "done", 80);
  state = commit(state, "done", 81);
  state = append(state, "still-pending", 82);
  state = claim(state, "claim-done", 83);

  const crossEpochOnly = reconcileWorkspaceTurnQueueOnRestore({
    snapshot: JSON.parse(JSON.stringify(state)),
    sessionKey,
    sessionEpoch,
    terminalOwners: [ownerForEntry(state.entries[0], { sessionEpoch: "old-epoch" })],
    at: 90,
  });
  assert.equal(crossEpochOnly.entries.length, 2);

  const exactTerminal = reconcileWorkspaceTurnQueueOnRestore({
    snapshot: JSON.parse(JSON.stringify(state)),
    sessionKey,
    sessionEpoch,
    terminalOwners: [ownerForEntry(state.entries[0])],
    at: 90,
  });
  assert.deepEqual(
    exactTerminal.entries.map((entry) => entry.instruction.clientSubmissionId),
    ["still-pending"],
  );
  assert.equal(exactTerminal.entries[0].status, "queued");
});

test("restore owner identity cannot remove a different receipt that reuses the same turnId", () => {
  let state = createWorkspaceTurnQueueState({ sessionKey, sessionEpoch });
  state = append(state, "first-owner", 91);
  state = commit(state, "first-owner", 92);
  state = apply(state, {
    type: "append",
    expectedVersion: state.version,
    at: 93,
    instruction: instruction("replacement-owner", 93),
    receipt: receipt("replacement-owner", 93, {
      turnId: state.entries[0].receipt.turnId,
      userBlockId: 1_093,
    }),
  });
  state = commit(state, "replacement-owner", 94);

  const firstOwner = ownerForEntry(state.entries[0]);
  const restored = reconcileWorkspaceTurnQueueOnRestore({
    snapshot: JSON.parse(JSON.stringify(state)),
    sessionKey,
    sessionEpoch,
    terminalOwners: [firstOwner],
    at: 95,
  });

  assert.deepEqual(
    restored.entries.map((entry) => entry.instruction.clientSubmissionId),
    ["replacement-owner"],
  );
  assert.equal(restored.entries[0].receipt.turnId, firstOwner.turnId);
  assert.notEqual(
    buildWorkspaceTurnQueueEntryIdentity(restored.entries[0]),
    firstOwner.instructionEnvelopeIdentity,
  );
});

test("queue contracts are deeply immutable and survive a JSON persistence round trip", () => {
  const normalized = normalizeWorkspaceInstruction(instruction("json", 100));
  assert.ok(normalized);
  assert.equal(Object.isFrozen(normalized), true);
  assert.equal(Object.isFrozen(normalized.payload), true);
  assert.equal(Object.isFrozen(normalized.payload.dispatchHints), true);
  assert.equal(Object.isFrozen(normalized.payload.dispatchHints.nested), true);
  assert.equal(Object.isFrozen(normalized.payload.dispatchHints.nested.attempts), true);

  let state = createWorkspaceTurnQueueState({ sessionKey, sessionEpoch });
  state = append(state, "json", 100);
  state = commit(state, "json", 101);
  assert.equal(Object.isFrozen(state), true);
  assert.equal(Object.isFrozen(state.entries), true);
  assert.equal(Object.isFrozen(state.entries[0]), true);

  const roundTripped = reconcileWorkspaceTurnQueueOnRestore({
    snapshot: JSON.parse(JSON.stringify(state)),
    sessionKey,
    sessionEpoch,
    at: 102,
  });
  assert.deepEqual(roundTripped, state);
  assert.equal(roundTripped.version, state.version);
});

test("a snapshot owned by another Session generation cannot replay into the fresh queue", () => {
  let state = createWorkspaceTurnQueueState({ sessionKey, sessionEpoch });
  state = append(state, "stale", 110);
  const restored = reconcileWorkspaceTurnQueueOnRestore({
    snapshot: JSON.parse(JSON.stringify(state)),
    sessionKey,
    sessionEpoch: "fresh-epoch",
    at: 120,
  });
  assert.equal(restored.sessionEpoch, "fresh-epoch");
  assert.equal(restored.entries.length, 0);
  assert.equal(restored.version, 0);
});

test("receipt userBlockId is required and survives durable queue normalization", () => {
  const initial = createWorkspaceTurnQueueState({ sessionKey, sessionEpoch });
  const { userBlockId: _omitted, ...receiptWithoutUserBlock } = receipt("missing-block", 130);
  const rejected = reduceWorkspaceTurnQueue(initial, {
    type: "append",
    expectedVersion: initial.version,
    at: 130,
    instruction: instruction("missing-block", 130),
    receipt: receiptWithoutUserBlock,
  });
  assert.equal(rejected.disposition, "rejected");
  assert.equal(rejected.reason, "invalid_receipt");

  let state = append(initial, "exact-block", 131);
  state = commit(state, "exact-block", 132);
  const restored = reconcileWorkspaceTurnQueueOnRestore({
    snapshot: JSON.parse(JSON.stringify(state)),
    sessionKey,
    sessionEpoch,
    at: 133,
  });
  assert.equal(restored.entries[0].receipt.userBlockId, 1_131);
});

test("a paged-out FIFO head rebuilds its exact Turn and user block before dispatch", () => {
  let queue = createWorkspaceTurnQueueState({ sessionKey, sessionEpoch });
  queue = append(queue, "paged-head", 140);
  queue = commit(queue, "paged-head", 141);
  const newerTurns = Array.from({ length: 30 }, (_, index) => ({
    id: `turn-newer-${index}`,
    userPrompt: `newer ${index}`,
    title: `Newer ${index}`,
    mode: "chat",
    intent: "respond",
    displayIntent: "respond",
    status: "done",
    summary: "done",
    blockIds: [2_000 + index],
    collapsed: false,
    createdAt: 200 + index,
  }));
  const newerBlocks = newerTurns.map((turn, index) => ({
    id: 2_000 + index,
    turnId: turn.id,
    type: "user",
    content: turn.userPrompt,
  }));

  const projection = reconcileWorkspaceInstructionProjection({
    entry: queue.entries[0],
    taskFlow: newerBlocks,
    conversationTurns: newerTurns,
    userContextItems: [{ kind: "context_file", label: "runtime.ts", path: "src/runtime.ts" }],
    language: "en",
  });

  assert.equal(projection.disposition, "ready");
  assert.equal(projection.changed, true);
  assert.equal(projection.turn.id, "turn-paged-head");
  assert.equal(projection.userBlock.id, 1_140);
  assert.equal(projection.userBlock.turnId, "turn-paged-head");
  assert.equal(projection.conversationTurns[0].id, "turn-paged-head");
  assert.equal(projection.taskFlow[0].id, 1_140);
  assert.deepEqual(projection.turn.blockIds, [1_140]);
  assert.equal(projection.turn.intent, "execute");
  assert.equal(projection.turn.displayIntent, "execute");
  assert.equal(projection.turn.mode, "edit");
});

test("initial and restored Turn projections preserve validated intent metadata candidates", () => {
  const admittedInstruction = instruction("plan-projection", 145, {
    payload: {
      text: "Plan the runtime repair",
      dispatchHints: {
        resolvedIntent: "plan",
        runtimeIntentOverride: "plan",
        skipIntentResolution: true,
        turnTitle: "Runtime repair plan",
        intentSummary: "Plan: inspect the runtime boundary",
      },
    },
  });
  const admittedReceipt = receipt("plan-projection", 145);
  const initialTurn = buildWorkspaceInstructionConversationTurn({
    instruction: admittedInstruction,
    receipt: admittedReceipt,
    language: "en",
  });

  assert.equal(initialTurn.intent, "plan");
  assert.equal(initialTurn.displayIntent, "plan");
  assert.equal(initialTurn.mode, "plan");
  assert.equal(initialTurn.title, "Runtime repair plan");
  assert.equal(initialTurn.intentSummary, "Plan: inspect the runtime boundary");

  const restored = reconcileWorkspaceInstructionProjection({
    entry: {
      instruction: admittedInstruction,
      receipt: admittedReceipt,
      status: "queued",
      claim: null,
      enqueuedAt: 145,
      persistedAt: 146,
      updatedAt: 146,
    },
    taskFlow: [],
    conversationTurns: [],
    language: "en",
  });
  assert.equal(restored.disposition, "ready");
  assert.equal(restored.turn.intent, "plan");
  assert.equal(restored.turn.title, initialTurn.title);
  assert.equal(restored.turn.intentSummary, initialTurn.intentSummary);
});

test("Turn projection rejects unknown intent strings without granting a runtime mode", () => {
  const unknownInstruction = instruction("unknown-intent", 147, {
    payload: {
      text: "Do not trust arbitrary metadata",
      dispatchHints: {
        resolvedIntent: "root_shell",
        runtimeIntentOverride: "root_shell",
        turnTitle: "Untrusted intent",
      },
    },
  });
  const turn = buildWorkspaceInstructionConversationTurn({
    instruction: unknownInstruction,
    receipt: receipt("unknown-intent", 147),
    language: "en",
  });

  assert.equal(turn.intent, "respond");
  assert.equal(turn.displayIntent, "respond");
  assert.equal(turn.mode, "edit");
  assert.equal(turn.runtimeEngineVersion, "v2");
});

test("ordinary repair instructions project as Execute before authoritative dispatch", () => {
  const repairInstruction = instruction("execute-projection", 148, {
    payload: {
      text: "找到根本原因，修复底层操作顺序，并运行真实验证确认完成。",
      dispatchHints: {
        subagentPreference: "unspecified",
      },
    },
  });
  const turn = buildWorkspaceInstructionConversationTurn({
    instruction: repairInstruction,
    receipt: receipt("execute-projection", 148),
    language: "zh",
  });

  assert.equal(turn.intent, "execute");
  assert.equal(turn.displayIntent, "execute");
  assert.equal(turn.mode, "edit");
  assert.notEqual(turn.title.trim(), "");
  assert.equal(turn.status, "planning");
});

test("projection recovery is idempotent and fails closed on exact ID collisions", () => {
  let queue = createWorkspaceTurnQueueState({ sessionKey, sessionEpoch });
  queue = append(queue, "projection", 150);
  queue = commit(queue, "projection", 151);
  const first = reconcileWorkspaceInstructionProjection({
    entry: queue.entries[0],
    taskFlow: [],
    conversationTurns: [],
    language: "zh",
  });
  assert.equal(first.disposition, "ready");

  const retry = reconcileWorkspaceInstructionProjection({
    entry: queue.entries[0],
    taskFlow: first.taskFlow,
    conversationTurns: first.conversationTurns,
    language: "zh",
  });
  assert.equal(retry.disposition, "ready");
  assert.equal(retry.changed, false);
  assert.equal(retry.taskFlow.length, 1);
  assert.equal(retry.conversationTurns.length, 1);

  const contextProjection = reconcileWorkspaceInstructionProjection({
    entry: queue.entries[0],
    taskFlow: [],
    conversationTurns: [],
    userContextItems: [{
      id: "mention:src/a.ts",
      kind: "mention",
      label: "src/a.ts",
      path: "src/a.ts",
      status: "ready",
    }],
    language: "zh",
  });
  assert.equal(contextProjection.disposition, "ready");
  const imageEntry = {
    ...queue.entries[0],
    instruction: {
      ...queue.entries[0].instruction,
      payload: {
        ...queue.entries[0].instruction.payload,
        images: ["data:image/png;base64,aW1hZ2U="],
      },
    },
  };
  const localizedImageProjection = reconcileWorkspaceInstructionProjection({
    entry: imageEntry,
    taskFlow: [],
    conversationTurns: [],
    userContextItems: [{
      id: "image:0",
      kind: "image",
      label: "截图 1",
      status: "ready",
      thumbnailDataUrl: "data:image/png;base64,dGh1bWI=",
    }],
    language: "zh",
  });
  assert.equal(localizedImageProjection.disposition, "ready");
  const relocalizedImageProjection = reconcileWorkspaceInstructionProjection({
    entry: imageEntry,
    taskFlow: localizedImageProjection.taskFlow,
    conversationTurns: localizedImageProjection.conversationTurns,
    userContextItems: [{
      id: "image:0",
      kind: "image",
      label: "Image 1",
      status: "ready",
    }],
    language: "en",
  });
  assert.equal(
    relocalizedImageProjection.disposition,
    "ready",
    "localized labels and thumbnails are presentation metadata, not block ownership",
  );
  assert.equal(relocalizedImageProjection.userBlock, localizedImageProjection.userBlock);
  const contextPathCollision = reconcileWorkspaceInstructionProjection({
    entry: queue.entries[0],
    taskFlow: contextProjection.taskFlow,
    conversationTurns: contextProjection.conversationTurns,
    userContextItems: [{
      id: "mention:src/a.ts",
      kind: "mention",
      label: "src/a.ts",
      path: "src/different.ts",
      status: "ready",
    }],
    language: "zh",
  });
  assert.deepEqual(contextPathCollision, {
    disposition: "conflict",
    reason: "user_block_id_collision",
  });
  const contextCollision = reconcileWorkspaceInstructionProjection({
    entry: queue.entries[0],
    taskFlow: contextProjection.taskFlow,
    conversationTurns: contextProjection.conversationTurns,
    userContextItems: [{
      id: "mention:src/b.ts",
      kind: "mention",
      label: "src/b.ts",
      path: "src/b.ts",
      status: "ready",
    }],
    language: "zh",
  });
  assert.deepEqual(contextCollision, {
    disposition: "conflict",
    reason: "user_block_id_collision",
  });

  const blockCollision = reconcileWorkspaceInstructionProjection({
    entry: queue.entries[0],
    taskFlow: [{
      id: queue.entries[0].receipt.userBlockId,
      turnId: "unrelated-turn",
      type: "user",
      content: "unrelated",
    }],
    conversationTurns: [],
    language: "zh",
  });
  assert.deepEqual(blockCollision, {
    disposition: "conflict",
    reason: "user_block_id_collision",
  });

  const turnCollision = reconcileWorkspaceInstructionProjection({
    entry: queue.entries[0],
    taskFlow: [],
    conversationTurns: [{
      ...first.turn,
      clientSubmissionId: "other-submission",
    }],
    language: "zh",
  });
  assert.deepEqual(turnCollision, {
    disposition: "conflict",
    reason: "turn_id_collision",
  });

  for (const driftedTurn of [
    { ...first.turn, workspaceInstructionSource: "guide" },
    { ...first.turn, createdAt: first.turn.createdAt + 1 },
  ]) {
    const drift = reconcileWorkspaceInstructionProjection({
      entry: queue.entries[0],
      taskFlow: first.taskFlow,
      conversationTurns: [driftedTurn],
      language: "zh",
    });
    assert.deepEqual(drift, {
      disposition: "conflict",
      reason: "turn_id_collision",
    });
  }

  const duplicatedTurn = reconcileWorkspaceInstructionProjection({
    entry: queue.entries[0],
    taskFlow: first.taskFlow,
    conversationTurns: [first.turn, { ...first.turn }],
    language: "zh",
  });
  assert.deepEqual(duplicatedTurn, {
    disposition: "conflict",
    reason: "turn_id_collision",
  });
});
