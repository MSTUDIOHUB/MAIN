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
  const pendingRejections = [];
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
            assert.equal(args[0].length, 2);
            assert.deepEqual(args[0].map((message) => message.role), ["system", "user"]);
            assert.equal(typeof JSON.parse(args[0][1].content).currentRequest, "string");
            assert.deepEqual(args[4], []);
            assert.equal(args[5], 512);
            requests.push(args);
            return new Promise((resolve, reject) => {
              pending.push(resolve);
              pendingRejections.push(reject);
            });
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
  const { acceptWorkspaceComposerInstruction } = load("src/store/workspaceComposerIntentAdmission.ts");
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
    makeGlobal() {
      const { GLOBAL_CHAT_KEY, resolveGlobalChatSessionKey } = load("src/lib/sessionTypes.ts");
      const state = store.getState();
      const session = state.sessionsByWorkspace[workspace][0];
      store.setState({ currentWorkspace: null, selectedWorkspace: null, currentSessionId: sessionId,
        activeSessionByWorkspace: { [GLOBAL_CHAT_KEY]: sessionId },
        sessionsByWorkspace: { [GLOBAL_CHAT_KEY]: [{ ...session, active: true }] },
        config: { ...state.config, workspace: "" }, runtimeBySessionKey: {}, workspaceTurnQueue: null,
        workspaceInstructionLedger: [], currentTurnId: null,
        currentTurnExecutionConsent: { turnId: null, granted: false }, autoApproveTools: false,
      });
      return resolveGlobalChatSessionKey(sessionId);
    },
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
    async acceptComposer(text, explicitIntent) {
      store.setState({ lockedComposerIntent: explicitIntent });
      const intentSnapshot = Object.freeze({ mainModeKey: "main_mode", lockedComposerIntent: explicitIntent,
        subagentPreference: "unspecified" });
      const accepted = await acceptWorkspaceComposerInstruction({
        text, language: "en", intentSnapshot,
        payloadSnapshot: { contextMentions: [], attachedFiles: [] },
        acceptWorkspaceInstruction: (input) => store.getState().acceptWorkspaceInstruction({ ...input,
          clientSubmissionId: `composer-submission-${suffix}` }),
      });
      assert.equal(accepted.accepted, true, accepted.reason);
      // Composer clears its one-shot UI lock after durable acceptance. Only
      // the captured dispatch boundary can constrain the delayed result now.
      store.setState({ lockedComposerIntent: null });
      await waitFor(() => requests.length === 1);
      assert.equal(requests.length, 1);
      return accepted.receipt;
    },
    resolve(index = 0, result = { intent: "execute", confidence: 0.98, title: "Inspect service", requiresApproval: true,
      commandDirective: { kind: "shell", source: "preflight", requiresApproval: true } }) {
      pending[index]({ content: JSON.stringify(semanticFixture(result)), toolCalls: [], finishReason: "stop" });
    },
    resolveRaw(index, response) { pending[index](response); },
    reject(index = 0, error = new Error("Fixture preflight transport failed")) { pendingRejections[index](error); },
    cleanup() {
      store.getState().abortController?.abort();
      for (const workflow of workflows) workflow.elapsedTimer.dispose();
      store.setState({ ...initial, dispatchNextWorkspaceInstruction: () => false }, true);
    },
  };
}

// Existing test cases may name a convenient intent, but the mocked provider
// sends the actual semantic wire contract. Invalid-wire cases use resolveRaw.
function semanticFixture(result) {
  if (!result || result.semantic) return result;
  const intent = result.intent;
  const workType = intent === "execute" ? "operate" : intent === "plan" ? "plan"
    : ["analyze", "report"].includes(intent) ? "investigate" : "answer";
  const answerFormat = intent === "analyze" ? "analysis" : intent === "summarize" ? "summary"
    : intent === "report" ? "report" : intent === "plan" ? "plan" : "answer";
  return {
    semantic: {
      objective: result.title || "Handle the current user request",
      workType,
      answerFormat,
      requiredCapabilities: intent === "execute" ? ["command"]
        : ["analyze", "report", "plan"].includes(intent) ? ["workspace_read"] : [],
      forbiddenCapabilities: [],
    },
    confidence: result.confidence ?? 0.98,
    needsUserChoice: result.needsUserChoice === true,
    ...(result.title ? { title: result.title } : {}),
    ...(result.question ? { question: result.question } : {}),
  };
}

function semanticResult(workType, requiredCapabilities, answerFormat = "answer", forbiddenCapabilities = []) {
  return {
    semantic: { objective: "Handle exactly the current user request", workType, answerFormat,
      requiredCapabilities, forbiddenCapabilities },
    confidence: 0.98,
    needsUserChoice: false,
    title: "Current request",
  };
}

async function waitFor(predicate, attempts = 50) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

// The provider is a controlled classification fixture. These tests prove the
// production admission/handoff boundary, not a model's semantic accuracy.
test("high-confidence natural execution still waits for exactly one semantic preflight", async () => {
  const harness = createHarness("high-confidence-semantic");
  try {
    const receipt = await harness.accept("Please modify src/app.ts to fix the broken save button and run its tests.");
    assert.equal(harness.workflows.length, 0, "lexical confidence cannot start a workflow before semantic classification");
    assert.equal(harness.requests[0][0].length, 2);
    assert.deepEqual(harness.requests[0][4], []);
    assert.equal(harness.requests[0][5], 512);
    harness.resolve();
    await waitFor(() => harness.workflows.length === 1);
    assert.equal(harness.workflows.length, 1);
    assert.equal(harness.workflows[0].turnId, receipt.turnId);
    assert.equal(harness.workflows[0].effectiveRunIntent, "execute");
    assert.equal(harness.workflows[0].options.executionConsentGranted, undefined);
    assert.equal(harness.requests.length, 1);
  } finally { harness.cleanup(); }
});

test("a missing semantic result concludes the exact admitted Turn without lexical fallback", async () => {
  const harness = createHarness("missing-semantic-result");
  try {
    const receipt = await harness.accept();
    harness.resolve(0, null);
    await waitFor(() => harness.workflows.length > 0 || harness.store.getState().runtimeEvents.some((event) =>
      event.type === "turn.completed" && event.turnId === receipt.turnId));
    const state = harness.store.getState();
    assert.equal(harness.workflows.length, 0, "invalid semantic output must not reuse the lexical route");
    const terminals = state.runtimeEvents.filter((event) => event.type === "turn.completed" && event.turnId === receipt.turnId);
    assert.equal(terminals.length, 1);
    assert.equal(terminals[0].resultKind, "error");
    assert.equal(state.workspaceTurnQueue.entries.length, 0);
    assert.equal(state.activeActionRequest, null);
    assert.equal(state.isGenerating, false);
    assert.equal(harness.requests.length, 1);
  } finally { harness.cleanup(); }
});

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
  { ...semanticResult("operate", ["command"], "report", ["workspace_write"]), confidence: 0.6 },
  { intent: "execute", confidence: 0.98, needsUserChoice: true, question: "Run it?" },
]) {
  test(`semantic workspace preflight preserves its result without a lexical substitute (${candidate.needsUserChoice ? "choice" : "confidence"})`, async () => {
    const harness = createHarness(candidate.needsUserChoice ? "choice" : "uncertain");
    try {
      const receipt = await harness.accept();
      harness.resolve(0, candidate);
      await waitFor(() => harness.workflows.length > 0 || harness.store.getState().runtimeEvents.some((event) =>
        event.type === "turn.completed" && event.turnId === receipt.turnId));
      if (candidate.needsUserChoice) {
        assert.equal(harness.workflows.length, 0, "clarification concludes without opening any workflow tools");
        const terminals = harness.store.getState().runtimeEvents.filter((event) => event.type === "turn.completed" && event.turnId === receipt.turnId);
        assert.equal(terminals.length, 1);
        assert.equal(terminals[0].resultKind, "blocked");
        assert.ok(harness.store.getState().taskFlow.some((block) => block.turnId === receipt.turnId &&
          block.type === "agent" && block.visibility === "assistant_final" && /Run it\?/.test(block.content)));
        assert.equal(harness.store.getState().workspaceTurnQueue.entries.length, 0);
      } else {
        assert.equal(harness.workflows.length, 1);
        assert.equal(harness.workflows[0].turnId, receipt.turnId);
        assert.equal(harness.workflows[0].effectiveRunIntent, "execute", "valid semantic intent survives a confidence of 0.6");
        assert.deepEqual(harness.workflows[0].options.semanticIntent, semanticFixture(candidate).semantic);
        assert.equal(harness.workflows[0].options.executionConsentGranted, undefined);
      }
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
      assert.equal(JSON.parse(request[0][1].content).currentRequest, text, "preflight receives the full current request, including historical context and current restrictions");
      assert.match(request[0][0].content, /forbiddenCapabilities/);
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

for (const fixture of [
  { suffix: "mixed-language", text: "请 implement src/Feature.cs, run its tests，然后用中文分析结果。",
    result: semanticResult("implement", ["workspace_read", "workspace_write", "command"], "analysis"), intent: "execute" },
  { suffix: "quoted-delete", text: "Explain the quoted example 'delete_workspace_path(Assets/Old.cs)'. Do not execute it or modify files.",
    result: semanticResult("answer", [], "answer", ["workspace_write", "command", "external_interaction"]), intent: "respond" },
  { suffix: "historical-readonly", text: "历史上下文：上轮只读 baseline 证明工具可用。这轮请实现控制器并运行测试，最后报告真实结果。",
    result: semanticResult("implement", ["workspace_read", "workspace_write", "command"], "report"), intent: "execute" },
  { suffix: "separate-files", text: "把运行时 Collector 和 Editor 构建器分成两份文件分别生成，然后检查编译。",
    result: semanticResult("implement", ["workspace_read", "workspace_write", "command"]), intent: "execute" },
  { suffix: "analyze-then-repair", text: "First analyze the defect, then fix src/app.ts and run the relevant test. Explain the change afterwards.",
    result: semanticResult("implement", ["workspace_read", "workspace_write", "command"], "analysis"), intent: "execute" },
  { suffix: "analysis-only", text: "先分析修复方案，不要修改文件或执行命令；给我一个计划。",
    result: semanticResult("plan", ["workspace_read"], "plan", ["workspace_write", "command"]), intent: "plan" },
  { suffix: "live-report", text: "Inspect the live Editor with the CLI and give me a report. Do not modify project files.",
    result: semanticResult("operate", ["command", "external_interaction"], "report", ["workspace_write"]), intent: "execute" },
]) {
  test(`every natural request reaches one tool-free semantic admission: ${fixture.suffix}`, async () => {
    const harness = createHarness(`semantic-${fixture.suffix}`);
    try {
      const receipt = await harness.accept(fixture.text);
      assert.equal(harness.workflows.length, 0);
      assert.equal(harness.requests[0][0].length, 2);
      assert.equal(JSON.parse(harness.requests[0][0][1].content).currentRequest, fixture.text);
      assert.deepEqual(harness.requests[0][4], []);
      assert.equal(harness.requests[0][5], 512);
      harness.resolve(0, fixture.result);
      await waitFor(() => harness.workflows.length === 1);
      assert.equal(harness.workflows.length, 1);
      const workflow = harness.workflows[0];
      assert.equal(workflow.turnId, receipt.turnId);
      assert.equal(workflow.effectiveRunIntent, fixture.intent);
      assert.deepEqual(workflow.options.semanticIntent, fixture.result.semantic);
      assert.equal(workflow.options.executionConsentGranted, undefined, "semantic routing never grants tool execution permission");
      assert.equal(workflow.options.workspaceInstructionClaim.turnId, receipt.turnId);
      assert.equal(harness.requests.length, 1);
      assert.equal(harness.store.getState().conversationTurns.filter((turn) => turn.id === receipt.turnId).length, 1);
    } finally { harness.cleanup(); }
  });
}

const validWireFixture = semanticResult("implement", ["workspace_read", "workspace_write", "command"]);
for (const fixture of [
  { suffix: "empty", response: { content: "", toolCalls: [], finishReason: "stop" } },
  { suffix: "malformed", response: { content: '{"semantic":', toolCalls: [], finishReason: "stop" } },
  { suffix: "legacy-intent", response: { content: '{"intent":"execute","confidence":0.99}', toolCalls: [], finishReason: "stop" } },
  { suffix: "missing-capabilities", response: { content: JSON.stringify({ semantic: { objective: "Implement the request", workType: "implement", answerFormat: "answer" }, confidence: 0.99 }), toolCalls: [], finishReason: "stop" } },
  { suffix: "unknown-capability", response: { content: JSON.stringify({ ...validWireFixture, semantic: { ...validWireFixture.semantic, requiredCapabilities: ["unrestricted_shell"] } }), toolCalls: [], finishReason: "stop" } },
  { suffix: "provider-length", response: { content: JSON.stringify(validWireFixture), toolCalls: [], finishReason: "length" } },
  { suffix: "transport-error", transportError: true },
]) {
  test(`invalid semantic calibration error-closes its exact Turn without workflow or lexical fallback: ${fixture.suffix}`, async () => {
    const harness = createHarness(`semantic-invalid-${fixture.suffix}`);
    try {
      const receipt = await harness.accept("Please repair src/app.ts and run tests.");
      if (fixture.transportError) harness.reject();
      else harness.resolveRaw(0, fixture.response);
      await waitFor(() => harness.store.getState().runtimeEvents.some((event) => event.type === "turn.completed" && event.turnId === receipt.turnId));
      const state = harness.store.getState();
      assert.equal(harness.workflows.length, 0);
      const terminals = state.runtimeEvents.filter((event) => event.type === "turn.completed" && event.turnId === receipt.turnId);
      assert.equal(terminals.length, 1);
      assert.equal(terminals[0].resultKind, "error");
      assert.ok(state.taskFlow.some((block) => block.turnId === receipt.turnId && block.type === "agent" &&
        block.visibility === "assistant_final" && block.content.length > 0));
      assert.equal(state.workspaceTurnQueue.entries.length, 0);
      assert.equal(state.activeActionRequest, null);
      assert.equal(state.pendingRunDecision, null);
      assert.equal(state.isGenerating, false);
      assert.equal(harness.requests.length, 1, "calibration failure is not another model request");
    } finally { harness.cleanup(); }
  });
}

test("a semantic answer result prevents execution of a quoted deletion even under the Execute composer ceiling", async () => {
  const harness = createHarness("explicit-execute-ceiling");
  try {
    harness.store.setState({ lockedComposerIntent: "execute" });
    const receipt = await harness.accept("Only explain the quoted delete_workspace_path example; do not execute it.");
    const result = semanticResult("answer", [], "answer", ["workspace_write", "command", "external_interaction"]);
    harness.resolve(0, result);
    await waitFor(() => harness.workflows.length === 1);
    assert.equal(harness.workflows.length, 1);
    assert.equal(harness.workflows[0].turnId, receipt.turnId);
    assert.equal(harness.workflows[0].effectiveRunIntent, "respond");
    assert.deepEqual(harness.workflows[0].options.semanticIntent, result.semantic);
    assert.equal(harness.requests.length, 1);
  } finally { harness.cleanup(); }
});

test("an Analyze composer ceiling cannot be raised by a semantic operation result", async () => {
  const harness = createHarness("explicit-readonly-ceiling");
  try {
    harness.store.setState({ lockedComposerIntent: "analyze" });
    const receipt = await harness.accept("Review the current files and explain the proposed repair.");
    harness.resolve(0, semanticResult("operate", ["workspace_write", "command", "external_interaction"]));
    await waitFor(() => harness.workflows.length > 0 || harness.store.getState().runtimeEvents.some((event) =>
      event.type === "turn.completed" && event.turnId === receipt.turnId));
    if (harness.workflows.length) {
      assert.equal(harness.workflows.length, 1);
      assert.equal(harness.workflows[0].effectiveRunIntent, "analyze");
      assert.equal(harness.workflows[0].effectiveCommandDirective.requiresApproval, false);
    } else {
      assert.equal(harness.store.getState().runtimeEvents.find((event) => event.type === "turn.completed" &&
        event.turnId === receipt.turnId)?.resultKind, "blocked");
    }
    assert.equal(harness.requests.length, 1);
  } finally { harness.cleanup(); }
});

test("a natural continuation is semantically classified before it can inherit a previous Execute route", async () => {
  const harness = createHarness("semantic-continuation");
  try {
    harness.store.setState({ conversationTurns: [{ id: "previous-execution", createdAt: 1, userPrompt: "Repair the service", intent: "execute",
      status: "done", blockIds: [], runtimeOutcome: { status: "completed", resultKind: "blocked", reason: "operator stopped", updatedAt: 1 } }] });
    const receipt = await harness.accept("继续解释你准备怎么修复；这次不要执行操作。 Continue with an explanation only.");
    assert.equal(harness.workflows.length, 0, "an old Execute turn is not current semantic authority");
    const result = semanticResult("answer", [], "analysis", ["workspace_write", "command", "external_interaction"]);
    harness.resolve(0, result);
    await waitFor(() => harness.workflows.length === 1);
    assert.equal(harness.workflows.length, 1);
    assert.equal(harness.workflows[0].turnId, receipt.turnId);
    assert.equal(harness.workflows[0].effectiveRunIntent, "respond");
    assert.deepEqual(harness.workflows[0].options.semanticIntent, result.semantic);
    assert.equal(harness.workflows[0].options.executionConsentGranted, undefined);
    assert.equal(harness.requests.length, 1);
  } finally { harness.cleanup(); }
});

for (const completion of ["valid", "invalid", "transport-error"]) {
test(`a late semantic ${completion} cannot adopt a replacement controller with the same Turn id`, async () => {
  const harness = createHarness(`semantic-same-turn-replacement-${completion}`);
  try {
    const receipt = await harness.accept();
    const state = harness.store.getState();
    const replacement = new AbortController();
    const sameClaimId = state.workspaceTurnQueue.entries[0].claim.claimId;
    harness.store.setState({ abortController: replacement, currentTurnId: receipt.turnId });
    if (completion === "transport-error") harness.reject();
    else harness.resolve(0, completion === "invalid" ? null : undefined);
    for (let flush = 0; flush < 8; flush += 1) await new Promise((resolve) => setTimeout(resolve, 0));
    const after = harness.store.getState();
    assert.equal(harness.workflows.length, 0);
    assert.equal(after.abortController, replacement);
    assert.equal(after.workspaceTurnQueue.entries[0].claim.claimId, sameClaimId, "matching Turn and claim ids do not make a different controller the old inference owner");
    assert.equal(after.runtimeEvents.some((event) => event.type === "turn.completed" && event.turnId === receipt.turnId), false);
    assert.equal(harness.requests.length, 1);
  } finally { harness.cleanup(); }
});
}

test("captured Analyze Composer ingress survives clearing its UI lock before semantic completion", async () => {
  const harness = createHarness("captured-analyze-composer");
  try {
    const receipt = await harness.acceptComposer("Explain the proposed repair after inspecting the source.", "analyze");
    assert.equal(harness.store.getState().lockedComposerIntent, null);
    assert.equal(harness.workflows.length, 0);
    harness.resolve(0, semanticResult("operate", ["command", "workspace_write"]));
    await waitFor(() => harness.workflows.length > 0 || harness.store.getState().runtimeEvents.some((event) =>
      event.type === "turn.completed" && event.turnId === receipt.turnId));
    if (harness.workflows.length) {
      assert.equal(harness.workflows.length, 1);
      assert.equal(harness.workflows[0].turnId, receipt.turnId);
      assert.equal(harness.workflows[0].effectiveRunIntent, "analyze", "captured Analyze authority cannot become Execute after the lock clears");
      assert.equal(harness.workflows[0].effectiveCommandDirective.requiresApproval, false);
      assert.equal(harness.workflows[0].options.executionConsentGranted, undefined);
    } else {
      assert.equal(harness.store.getState().runtimeEvents.find((event) => event.type === "turn.completed" &&
        event.turnId === receipt.turnId)?.resultKind, "blocked");
    }
    assert.equal(harness.requests.length, 1);
  } finally { harness.cleanup(); }
});

test("captured Execute Composer ingress still parses a quoted deletion as answer-only body semantics", async () => {
  const harness = createHarness("captured-execute-composer");
  try {
    const receipt = await harness.acceptComposer("Explain this quoted example: 'delete_workspace_path(Assets/Old.cs)'. Do not run it.", "execute");
    assert.equal(harness.store.getState().lockedComposerIntent, null);
    const result = semanticResult("answer", [], "answer", ["command", "workspace_write", "external_interaction"]);
    harness.resolve(0, result);
    await waitFor(() => harness.workflows.length === 1);
    assert.equal(harness.workflows.length, 1);
    assert.equal(harness.workflows[0].turnId, receipt.turnId);
    assert.equal(harness.workflows[0].effectiveRunIntent, "respond");
    assert.deepEqual(harness.workflows[0].options.semanticIntent, result.semantic);
    assert.equal(harness.requests.length, 1);
  } finally { harness.cleanup(); }
});

test("a global mode-choice recovery reclassifies the original restricted body without granting execution consent", async () => {
  const harness = createHarness("global-mode-choice-semantic");
  try {
    const globalSessionKey = harness.makeGlobal();
    assert.ok(globalSessionKey);
    const originalInput = "Only inspect and explain the requested behavior; no writes or commands.";
    harness.store.setState({ pendingRunDecision: {
      id: "global-intent-choice", kind: "intent_confirmation", source: "preflight", originalInput,
      suggestedIntent: "execute", reason: "Choose a mode for the current request", options: [], createdAt: Date.now(),
    } });
    harness.store.getState().resolvePendingRunDecision("execute");
    await waitFor(() => harness.requests.length === 1);
    assert.equal(harness.requests.length, 1, "a mode-choice result must parse the original body rather than skip calibration");
    assert.equal(harness.workflows.length, 0);
    assert.equal(JSON.parse(harness.requests[0][0][1].content).currentRequest, originalInput);
    assert.equal(harness.store.getState().currentTurnExecutionConsent?.granted, false);
    const result = semanticResult("answer", [], "analysis", ["workspace_write", "command", "external_interaction"]);
    harness.resolve(0, result);
    await waitFor(() => harness.workflows.length === 1);
    assert.equal(harness.workflows.length, 1);
    assert.equal(harness.workflows[0].effectiveRunIntent, "respond");
    assert.deepEqual(harness.workflows[0].options.semanticIntent, result.semantic);
    assert.equal(harness.workflows[0].options.executionConsentGranted, undefined);
    assert.notEqual(harness.store.getState().currentTurnExecutionConsent?.granted, true);
    assert.equal(harness.requests.length, 1);
    assert.equal(harness.store.getState().pendingRunDecision, null);
    assert.equal(harness.store.getState().currentWorkspace, null);
  } finally { harness.cleanup(); }
});
