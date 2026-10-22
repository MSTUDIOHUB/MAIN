import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";

// Use the same real-store loader as session-runtime-restore. Provider
// transport, background title generation, and the final workflow are replaced.
function createHarness(suffix) {
  const moduleCache = new Map();
  const requests = [];
  const workflows = [];
  const pending = [];
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
          },
        };
        if (base === path.resolve("src/store/submitTitleEffects")) return {
          ...load(`${base}.ts`), startSubmitSemanticMetadataEffect: async () => {},
        };
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
    store, requests, workflows, pending, sessionKey, sessionEpoch, queueModule, buildEmptySessionRuntimeSnapshot,
    getCancellation: () => getPendingSessionCancellation(sessionKey),
    async accept() {
      const accepted = await store.getState().acceptWorkspaceInstruction({
        text: "Inspect the current local service and report its live state.",
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
