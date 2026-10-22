import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";

// Use the same real-store loader as session-runtime-restore. Provider
// transport, background title generation, and the final workflow are replaced.
function createHarness(suffix, { deferBootstrap = false, deferCancellation = false } = {}) {
  const moduleCache = new Map();
  const requests = [];
  const workflows = [];
  const pending = [];
  const pendingBootstraps = [];
  const pendingCancellationWrites = [];
  function load(sourcePath) {
    const normalizedPath = path.resolve(sourcePath);
    if (moduleCache.has(normalizedPath)) return moduleCache.get(normalizedPath);
    const localRequire = createRequire(normalizedPath);
    const module = { exports: {} };
    moduleCache.set(normalizedPath, module.exports);
    const runtimeRequire = (specifier) => {
      if (specifier.startsWith("@tauri-apps/")) return {
        invoke: async () => "", isTauri: () => false, listen: async () => () => {},
        open: async () => null, relaunch: async () => {}, exit: async () => {}, check: async () => null,
      };
      if (specifier.startsWith(".")) {
        const base = path.resolve(path.dirname(normalizedPath), specifier);
        if (base === path.resolve("src/lib/streaming")) return {
          buildOpenAiCompatibleReasoningRequestExtras: () => ({}),
          streamChatCompletion: (...args) => {
            assert.match(args[0][0].content, /hidden intent preflight router/);
            requests.push(args);
            return new Promise((resolve) => pending.push(resolve));
          },
        };
        if (base === path.resolve("src/store/submitAsyncWorkflowRun")) return {
          startSubmitAsyncWorkflowRun: async (input) => {
            workflows.push(input);
            input.elapsedTimer.dispose();
            if (deferBootstrap) await new Promise((resolve) => pendingBootstraps.push(resolve));
          },
        };
        if (base === path.resolve("src/store/submitTitleEffects")) return {
          ...load(`${base}.ts`), startSubmitSemanticMetadataEffect: async () => {},
        };
        if (base === path.resolve("src/store/commitCanceledTurn") && deferCancellation) {
          const actual = load(`${base}.ts`);
          return { ...actual, commitCanceledTurn: (input) => actual.commitCanceledTurn({ ...input,
            persistProjection: async (...args) => {
              await new Promise((resolve) => pendingCancellationWrites.push(resolve));
              return input.persistProjection(...args);
            },
          }) };
        }
        for (const candidate of [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts"), path.join(base, "index.tsx")]) {
          if (fs.existsSync(candidate) && /\.tsx?$/.test(candidate)) return load(candidate);
        }
      }
      return localRequire(specifier);
    };
    new Function("exports", "module", "require", ts.transpileModule(fs.readFileSync(normalizedPath, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX },
      fileName: normalizedPath,
    }).outputText)(module.exports, module, runtimeRequire);
    moduleCache.set(normalizedPath, module.exports);
    return module.exports;
  }
  const { useAppStore: store, buildEmptySessionRuntimeSnapshot } = load("src/store/useAppStore.ts");
  const queueModule = load("src/store/workspaceTurnQueue.ts");
  const { getPendingSessionCancellation } = load("src/store/sessionCancellationBarrier.ts");
  const workspace = `/tmp/preflight-dispatch-${suffix}`;
  const sessionId = 83;
  const sessionKey = `${workspace}:${sessionId}`;
  const sessionEpoch = `epoch-${suffix}`;
  const initial = store.getState();
  store.setState({
    ...initial,
    currentWorkspace: workspace, selectedWorkspace: workspace, currentSessionId: sessionId,
    activeSessionByWorkspace: { [workspace]: sessionId },
    sessionsByWorkspace: { [workspace]: [{ id: sessionId, title: "Preflight fixture", date: "Today", active: true,
      planLifecycleEpoch: sessionEpoch, messages: [], recordingDisabled: true }] },
    config: { ...initial.config, language: "en", workspace, workflowMode: "edit", sessionRecordingEnabled: false,
      activeProfile: "local", local: { ...initial.config.local, endpoint: "http://fixture.invalid/v1", model: "fixture" } },
    input: "", selectedMainModeKey: "main_mode", lockedComposerIntent: null,
    taskFlow: [], conversationTurns: [], runtimeEvents: [], agentMessages: [], runtimeBySessionKey: {},
    workspaceTurnQueue: queueModule.createWorkspaceTurnQueueState({ sessionKey, sessionEpoch, updatedAt: Date.now() }),
    workspaceInstructionLedger: [], queuedUserMessage: null, pendingRunDecision: null,
    harnessRunMarker: null, activeActionRequest: null, currentTurnId: null,
    isGenerating: false, agentStatus: "idle", abortController: null,
    skills: [], contextMentions: [], attachedFiles: [],
    saveCurrentRuntimeToSession() {},
  }, true);
  return {
    store, requests, workflows, pending, pendingBootstraps, pendingCancellationWrites, sessionKey, sessionEpoch, queueModule, buildEmptySessionRuntimeSnapshot,
    getCancellation: () => getPendingSessionCancellation(sessionKey),
    async accept(text = "Inspect the current local service and report its live state.") {
      const accepted = await store.getState().acceptWorkspaceInstruction({
        text,
        clientSubmissionId: `submission-${suffix}`,
      });
      assert.equal(accepted.accepted, true, accepted.reason);
      await waitFor(() => requests.length === 1);
      assert.equal(requests.length, 1, "real sendMessage must reach exactly one preflight request");
      return accepted.receipt;
    },
    resolve(index = 0, result = { intent: "execute", confidence: 0.98, title: "Inspect service", requiresApproval: true,
      commandDirective: { kind: "shell", source: "preflight", requiresApproval: true } }) {
      pending[index]({ content: JSON.stringify(result), toolCalls: [], finishReason: "stop" });
    },
    cleanup() {
      store.getState().abortController?.abort();
      for (const workflow of workflows) workflow.elapsedTimer.dispose();
      store.setState({ ...initial, dispatchNextWorkspaceInstruction: () => false }, true);
    },
  };
}

async function waitFor(predicate, attempts = 50) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

test("a deferred workspace preflight keeps its exact durable claim until one same-Turn workflow adopts it", async () => {
  const harness = createHarness("handoff");
  try {
    const receipt = await harness.accept();
    const state = harness.store.getState();
    assert.equal(state.workspaceTurnQueue.entries.length, 1, "async routing must not success-close admitted work");
    assert.equal(state.workspaceTurnQueue.entries[0].status, "dispatching");
    assert.equal(state.workspaceTurnQueue.entries[0].claim.phase, "intent_preflight");
    assert.equal(state.runtimeEvents.some((event) => event.type === "turn.completed" && event.turnId === receipt.turnId), false);
    assert.equal(harness.workflows.length, 0);
    assert.equal(harness.store.getState().dispatchNextWorkspaceInstruction(harness.sessionKey), false, "reentrant dispatch must leave the live preflight owner alone");
    harness.resolve();
    await waitFor(() => harness.workflows.length > 0);
    assert.equal(harness.workflows.length, 1);
    assert.equal(harness.workflows[0].turnId, receipt.turnId);
    assert.equal(harness.workflows[0].effectiveRunIntent, "execute");
    assert.equal(harness.workflows[0].options.executionConsentGranted, undefined);
    assert.equal(harness.store.getState().conversationTurns.filter((turn) => turn.id === receipt.turnId).length, 1);
    assert.equal(harness.store.getState().taskFlow.filter((block) => block.type === "user" && block.turnId === receipt.turnId).length, 1);
    harness.resolve();
    harness.store.getState().dispatchNextWorkspaceInstruction(harness.sessionKey);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(harness.requests.length, 1);
    assert.equal(harness.workflows.length, 1, "late duplicate completion cannot launch another workflow");
  } finally { harness.cleanup(); }
});

test("a completed slow preflight hands its claim to deferred bootstrap without draining the same Turn again", async () => {
  const harness = createHarness("slow-bootstrap", { deferBootstrap: true });
  try {
    const receipt = await harness.accept();
    const current = harness.store.getState();
    const head = current.workspaceTurnQueue.entries[0];
    const claimId = head.claim.claimId;
    // Model routing can take longer than the stale synchronous-start grace.
    // The durable claim keeps its original admission time across phase CAS.
    harness.store.setState({ workspaceTurnQueue: { ...current.workspaceTurnQueue,
      entries: [{ ...head, claim: { ...head.claim, claimedAt: Date.now() - 10_000 } }],
    } });
    harness.resolve();
    await waitFor(() => harness.workflows.length === 1);
    // App's queue-version/status effect schedules another drain after the
    // preflight phase CAS even when the starter makes no explicit callback.
    harness.store.getState().dispatchNextWorkspaceInstruction(harness.sessionKey);
    for (let flush = 0; flush < 6; flush += 1) await new Promise((resolve) => setTimeout(resolve, 0));
    const starting = harness.store.getState();
    assert.equal(starting.runtimeEvents.some((event) => event.type === "turn.completed" && event.turnId === receipt.turnId), false,
      "a resumed async bootstrap is not a stale orphan and must not receive an error conclusion");
    assert.equal(starting.runtimeEvents.some((event) => event.type === "run.started" && event.turnId === receipt.turnId), false);
    assert.equal(starting.workspaceTurnQueue.entries.length, 0, "synchronous adoption acknowledges the exact dispatch claim before bootstrap awaits");
    assert.equal(harness.workflows[0].options.workspaceInstructionClaim.claimId, claimId);
    assert.equal(starting.currentTurnId, receipt.turnId);
    assert.equal(starting.isGenerating, true);
    assert.equal(starting.abortController, null, "bootstrap has not acquired a Run controller yet");
    assert.equal(current.abortController.signal.aborted, false, "handoff must not cancel its prior inference owner");
    // Once the actual executor starts, the unchanged dispatcher recognizes
    // its exact Run and acknowledges the original claim normally.
    harness.store.setState({ runtimeEvents: [...starting.runtimeEvents, {
      schemaVersion: 2, type: "run.started", threadId: harness.sessionKey,
      turnId: receipt.turnId, timestampMs: Date.now(), runId: "slow-bootstrap-run", parentRunId: null,
    }] });
    harness.store.getState().dispatchNextWorkspaceInstruction(harness.sessionKey);
    assert.equal(harness.store.getState().workspaceTurnQueue.entries.length, 0);
    harness.pendingBootstraps[0]();
    harness.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(harness.requests.length, 1);
    assert.equal(harness.workflows.length, 1, "the successful same-Turn handoff starts exactly once");
  } finally {
    for (const finish of harness.pendingBootstraps) finish();
    harness.cleanup();
  }
});

test("a rejected preflight resume releases only its exact claim while another runtime is busy", async () => {
  const harness = createHarness("rejected-resume");
  try {
    const receipt = await harness.accept();
    const send = harness.store.getState().sendMessage;
    harness.store.setState({ sendMessage: (text, images, options) => {
      if (!options?.skipIntentResolution) return send(text, images, options);
      harness.store.setState({ isGenerating: true, agentStatus: "running", currentTurnId: "another-live-turn", abortController: new AbortController() });
      return false;
    } });
    harness.resolve();
    await waitFor(() => harness.store.getState().workspaceTurnQueue.entries[0]?.status === "queued");
    const state = harness.store.getState();
    assert.equal(state.workspaceTurnQueue.entries[0].receipt.turnId, receipt.turnId);
    assert.equal(state.workspaceTurnQueue.entries[0].claim, null);
    assert.equal(state.currentTurnId, "another-live-turn");
    assert.equal(state.runtimeEvents.some((event) => event.type === "turn.completed" && event.turnId === receipt.turnId), false);
    assert.equal(harness.workflows.length, 0);
    assert.equal(harness.requests.length, 1);
  } finally { harness.cleanup(); }
});

test("a persistently rejected idle preflight resume closes its Turn without another calibration request", async () => {
  const harness = createHarness("idle-rejected-resume");
  try {
    const receipt = await harness.accept();
    const send = harness.store.getState().sendMessage;
    let rejected = 0;
    harness.store.setState({ sendMessage: (text, images, options) => {
      if (!options?.skipIntentResolution) return send(text, images, options);
      rejected += 1;
      return false;
    } });
    harness.resolve();
    await waitFor(() => harness.store.getState().runtimeEvents.some((event) => event.type === "turn.completed" && event.turnId === receipt.turnId));
    const state = harness.store.getState();
    const terminals = state.runtimeEvents.filter((event) => event.type === "turn.completed" && event.turnId === receipt.turnId);
    assert.equal(terminals.length, 1);
    assert.equal(terminals[0].resultKind, "error");
    assert.ok(state.taskFlow.some((block) => block.turnId === receipt.turnId && block.type === "agent" && block.visibility === "assistant_final" && block.content.length > 0));
    assert.equal(state.workspaceTurnQueue.entries.length, 0);
    assert.equal(harness.requests.length, 1, "idle rejection must not re-enter model preflight");
    assert.equal(rejected, 1);
    assert.equal(harness.workflows.length, 0);
  } finally { harness.cleanup(); }
});

test("a successful preflight resume cannot acknowledge a synchronously replaced dispatch owner", async () => {
  const harness = createHarness("replaced-on-resume", { deferBootstrap: true });
  try {
    await harness.accept();
    const send = harness.store.getState().sendMessage;
    let replacement;
    harness.store.setState({ sendMessage: (text, images, options) => {
      const accepted = send(text, images, options);
      if (options?.skipIntentResolution) {
        const state = harness.store.getState();
        const queue = state.workspaceTurnQueue;
        const released = harness.queueModule.reduceWorkspaceTurnQueue(queue, { type: "release", expectedVersion: queue.version,
          at: Date.now(), claimId: queue.entries[0].claim.claimId, sessionKey: queue.sessionKey, sessionEpoch: queue.sessionEpoch });
        const claimed = harness.queueModule.reduceWorkspaceTurnQueue(released.state, { type: "claim", expectedVersion: released.state.version,
          at: Date.now(), claimId: "replacement-dispatch-owner", sessionKey: queue.sessionKey, sessionEpoch: queue.sessionEpoch });
        assert.equal(claimed.disposition, "applied");
        replacement = claimed.state;
        harness.store.setState({ workspaceTurnQueue: replacement });
      }
      return accepted;
    } });
    harness.resolve();
    await waitFor(() => harness.workflows.length === 1);
    for (let flush = 0; flush < 6; flush += 1) await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(harness.store.getState().workspaceTurnQueue, replacement, "late acceptance cannot ack, release, or alter the replacement claim");
    assert.equal(harness.store.getState().workspaceTurnQueue.entries[0].claim.claimId, "replacement-dispatch-owner");
    assert.equal(harness.workflows.length, 1);
  } finally {
    for (const finish of harness.pendingBootstraps) finish();
    harness.cleanup();
  }
});

test("Stop during a successful preflight resume keeps cancellation ahead of acceptance acknowledgment", async () => {
  const harness = createHarness("cancel-on-resume", { deferBootstrap: true });
  try {
    const receipt = await harness.accept();
    const send = harness.store.getState().sendMessage;
    let cancellation;
    harness.store.setState({ sendMessage: (text, images, options) => {
      const accepted = send(text, images, options);
      if (options?.skipIntentResolution) {
        harness.store.getState().stopGeneration();
        cancellation = harness.getCancellation();
        assert.ok(cancellation, "Stop must fence the same-Turn bootstrap before resume acknowledgment");
      }
      return accepted;
    } });
    harness.resolve();
    await waitFor(() => !!cancellation);
    await cancellation.promise;
    for (let flush = 0; flush < 6; flush += 1) await new Promise((resolve) => setTimeout(resolve, 0));
    const state = harness.store.getState();
    const terminals = state.runtimeEvents.filter((event) => event.type === "turn.completed" && event.turnId === receipt.turnId);
    assert.equal(terminals.length, 1);
    assert.equal(terminals[0].resultKind, "canceled");
    assert.equal(state.workspaceTurnQueue.entries.length, 0);
    assert.equal(harness.requests.length, 1, "canceled handoff must not be requeued as a new preflight");
    assert.equal(harness.workflows.length, 1);
  } finally {
    for (const finish of harness.pendingBootstraps) finish();
    harness.cleanup();
  }
});

test("an aged resumed claim waits for delayed cancellation persistence before any terminal reconciliation", async () => {
  const harness = createHarness("cancel-persistence-on-resume", { deferBootstrap: true, deferCancellation: true });
  try {
    const receipt = await harness.accept();
    const before = harness.store.getState();
    const head = before.workspaceTurnQueue.entries[0];
    harness.store.setState({ workspaceTurnQueue: { ...before.workspaceTurnQueue,
      entries: [{ ...head, claim: { ...head.claim, claimedAt: Date.now() - 10_000 } }],
    } });
    const send = harness.store.getState().sendMessage;
    let cancellation;
    harness.store.setState({ sendMessage: (text, images, options) => {
      const accepted = send(text, images, options);
      if (options?.skipIntentResolution) {
        harness.store.getState().stopGeneration();
        cancellation = harness.getCancellation();
      }
      return accepted;
    } });
    harness.resolve();
    await waitFor(() => harness.pendingCancellationWrites.length === 1);
    assert.ok(cancellation);
    harness.store.getState().dispatchNextWorkspaceInstruction(harness.sessionKey);
    for (let flush = 0; flush < 6; flush += 1) await new Promise((resolve) => setTimeout(resolve, 0));
    const settling = harness.store.getState();
    assert.equal(settling.workspaceTurnQueue.entries[0]?.claim?.claimId, head.claim.claimId);
    assert.equal(settling.workspaceTurnQueue.entries[0]?.claim?.phase, "dispatch");
    assert.equal(settling.runtimeEvents.some((event) => event.type === "turn.completed" && event.turnId === receipt.turnId), false,
      "pending durable cancellation owns the terminal boundary; the dispatcher cannot publish an orphan error");
    harness.pendingCancellationWrites[0]();
    await cancellation.promise;
    await waitFor(() => harness.store.getState().workspaceTurnQueue.entries.length === 0);
    const terminals = harness.store.getState().runtimeEvents.filter((event) => event.type === "turn.completed" && event.turnId === receipt.turnId);
    assert.equal(terminals.length, 1);
    assert.equal(terminals[0].resultKind, "canceled");
    assert.equal(harness.requests.length, 1);
    assert.equal(harness.workflows.length, 1);
  } finally {
    for (const finish of harness.pendingCancellationWrites) finish();
    for (const finish of harness.pendingBootstraps) finish();
    harness.cleanup();
  }
});

test("Stop closes a workspace preflight Turn and rejects its late execution result", async () => {
  const harness = createHarness("canceled");
  try {
    const receipt = await harness.accept();
    assert.equal(harness.store.getState().currentTurnId, receipt.turnId, "Stop must address the real admitted inference owner");
    harness.store.getState().stopGeneration();
    const cancellation = harness.getCancellation();
    assert.ok(cancellation, "Stop must synchronously fence the preflight owner");
    harness.resolve();
    await cancellation.promise;
    for (let flush = 0; flush < 12; flush += 1) await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(harness.workflows.length, 0);
    assert.equal(harness.requests.length, 1, "cancellation must not replay the old preflight as queued work");
    const terminal = harness.store.getState().runtimeEvents.filter((event) => event.type === "turn.completed" && event.turnId === receipt.turnId);
    assert.equal(terminal.length, 1);
    assert.equal(terminal[0].resultKind, "canceled");
    assert.equal(harness.store.getState().pendingRunDecision, null);
    assert.equal(harness.store.getState().workspaceTurnQueue.entries.length, 0);
    assert.equal(harness.store.getState().isGenerating, false);
    assert.equal(harness.store.getState().agentStatus, "idle");
  } finally { harness.cleanup(); }
});

test("a restored workspace preflight creates a fresh claim and fences the old provider result", async () => {
  const harness = createHarness("restored");
  try {
    const receipt = await harness.accept();
    const state = harness.store.getState();
    const oldClaim = state.workspaceTurnQueue.entries[0]?.claim?.claimId;
    assert.ok(oldClaim, "the pending preflight must still own a durable claim");
    const restored = harness.queueModule.reconcileWorkspaceTurnQueueOnRestore({
      snapshot: state.workspaceTurnQueue, sessionKey: harness.sessionKey, sessionEpoch: harness.sessionEpoch, at: Date.now(),
    });
    harness.store.setState({ workspaceTurnQueue: restored, currentTurnId: null, isGenerating: false,
      agentStatus: "idle", abortController: null, runtimeBySessionKey: {} });
    harness.store.getState().dispatchNextWorkspaceInstruction(harness.sessionKey);
    await waitFor(() => harness.requests.length === 2);
    assert.equal(harness.requests.length, 2);
    assert.notEqual(harness.store.getState().workspaceTurnQueue.entries[0].claim.claimId, oldClaim);
    harness.resolve(0);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(harness.workflows.length, 0, "old provider result cannot consume a restored claim");
    harness.resolve(1);
    await waitFor(() => harness.workflows.length === 1);
    assert.equal(harness.workflows.length, 1);
    assert.equal(harness.workflows[0].turnId, receipt.turnId);
  } finally { harness.cleanup(); }
});

for (const candidate of [
  { intent: "execute", confidence: 0.65 },
  { intent: "execute", confidence: 0.98, needsUserChoice: true, question: "Run it?" },
]) {
  test(`uncertain workspace preflight keeps one safe workflow instead of a detached modal (${candidate.needsUserChoice ? "choice" : "confidence"})`, async () => {
    const harness = createHarness(candidate.needsUserChoice ? "choice" : "uncertain");
    try {
      const receipt = await harness.accept();
      harness.resolve(0, candidate);
      await waitFor(() => harness.workflows.length > 0);
      assert.equal(harness.workflows.length, 1);
      assert.equal(harness.workflows[0].turnId, receipt.turnId);
      assert.ok(["analyze", "report"].includes(harness.workflows[0].effectiveRunIntent));
      assert.equal(harness.workflows[0].effectiveCommandDirective.requiresApproval, false);
      assert.equal(harness.workflows[0].options.executionConsentGranted, undefined);
      assert.equal(harness.store.getState().pendingRunDecision, null);
      assert.equal(harness.requests.length, 1);
    } finally { harness.cleanup(); }
  });
}

test("an inactive workspace preflight releases only its origin claim and retries after that Session returns", async () => {
  const harness = createHarness("inactive");
  try {
    const receipt = await harness.accept();
    const active = harness.store.getState();
    const workspace = active.currentWorkspace;
    const otherKey = `${workspace}:84`;
    harness.store.setState({ sessionsByWorkspace: { [workspace]: [
      ...active.sessionsByWorkspace[workspace],
      { id: 84, title: "Other Session", date: "Today", active: false, messages: [], recordingDisabled: true, planLifecycleEpoch: "other-epoch" },
    ] }, runtimeBySessionKey: { ...active.runtimeBySessionKey, [otherKey]: {
      ...harness.buildEmptySessionRuntimeSnapshot(active, "main_mode", { sessionKey: otherKey, sessionEpoch: "other-epoch", createdAt: Date.now() }),
      isGenerating: false, agentStatus: "idle", abortController: null,
    } } });
    harness.store.getState().setCurrentSessionId(84);
    assert.equal(harness.store.getState().restoreRuntimeForSession(otherKey), true);
    harness.resolve(0);
    await waitFor(() => harness.store.getState().runtimeBySessionKey[harness.sessionKey]?.workspaceTurnQueue?.entries[0]?.status === "queued");
    const other = harness.store.getState();
    assert.equal(other.currentSessionId, 84);
    assert.equal(other.isGenerating, false);
    assert.equal(other.abortController, null);
    assert.equal(harness.workflows.length, 0);
    const origin = other.runtimeBySessionKey[harness.sessionKey];
    assert.equal(origin.workspaceTurnQueue.entries[0].status, "queued");
    assert.equal(origin.abortController, null);
    harness.store.getState().setCurrentSessionId(83);
    assert.equal(harness.store.getState().restoreRuntimeForSession(harness.sessionKey), true);
    harness.store.getState().dispatchNextWorkspaceInstruction(harness.sessionKey);
    await waitFor(() => harness.requests.length === 2);
    assert.equal(harness.requests.length, 2);
    harness.resolve(1);
    await waitFor(() => harness.workflows.length === 1);
    assert.equal(harness.workflows.length, 1);
    assert.equal(harness.workflows[0].turnId, receipt.turnId);
  } finally { harness.cleanup(); }
});

for (const [suffix, text, intent] of [
  ["scoped-reference", "请直接实现 src/Feature.cs。先检查编译错误。可把运行时控制器和编辑器构建器分成两份文件分别生成。历史上下文：只读 baseline 回执仅证明工具可用，本轮完成实现与验证。", "execute"],
  ["current-readonly", "Inspect README.md. Do not modify files or run commands.", "analyze"],
]) {
  test(`natural scoped constraints reach semantic calibration without becoming typed whole-Turn authority: ${suffix}`, async () => {
    const harness = createHarness(suffix);
    try {
      const receipt = await harness.accept(text);
      assert.equal(harness.workflows.length, 0, "the heuristic alone cannot freeze the tool authority before semantic calibration");
      const request = harness.requests[0];
      assert.equal(request[0].length, 2);
      assert.ok(request[0][1].content.includes(text), "preflight receives the full current request, including historical context and current restrictions");
      assert.match(request[0][0].content, /explicit user restrictions take priority/);
      assert.deepEqual(request[4], [], "semantic calibration has no tools");
      assert.equal(request[5], 512);
      harness.resolve(0, { intent, confidence: 0.98, requiresApproval: true,
        commandDirective: { kind: "shell", source: "preflight", requiresApproval: true } });
      await waitFor(() => harness.workflows.length === 1);
      assert.equal(harness.workflows.length, 1);
      const workflow = harness.workflows[0];
      assert.equal(workflow.turnId, receipt.turnId);
      assert.equal(workflow.effectiveRunIntent, intent);
      assert.equal(workflow.options.resolvedIntent, intent);
      assert.equal(workflow.options.executionConsentGranted, undefined, "intent routing is not a per-tool permission grant");
      assert.equal(workflow.options.workspaceInstructionClaim.turnId, receipt.turnId);
      const turn = harness.store.getState().conversationTurns.find((item) => item.id === receipt.turnId);
      assert.equal(turn.intent, intent);
      if (intent === "analyze") {
        assert.equal(turn.commandDirective.kind, "none");
        assert.equal(turn.commandDirective.requiresApproval, false, "operation metadata cannot elevate a semantic read-only result");
      }
      assert.equal(harness.requests.length, 1);
    } finally { harness.cleanup(); }
  });
}
