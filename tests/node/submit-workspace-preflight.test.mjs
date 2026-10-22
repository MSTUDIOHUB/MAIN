import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";

function createHarness(candidate) {
  const intent = candidate?.intent;
  const capabilities = intent === "execute" ? ["workspace_read", "command"] : intent === "analyze" ? ["workspace_read"] : [];
  const semanticResponse = candidate && {
    confidence: candidate.confidence, needsUserChoice: candidate.needsUserChoice === true,
    title: candidate.title, question: candidate.question ?? (candidate.needsUserChoice ? "Please clarify the requested work." : undefined),
    semantic: { objective: "Handle the requested task", workType: intent === "execute" ? "operate" : intent === "analyze" ? "investigate" : intent === "plan" ? "plan" : "answer",
      answerFormat: "answer", requiredCapabilities: capabilities, forbiddenCapabilities: [] },
  };
  const cache = new Map();
  const requests = [];
  function load(file) {
    const resolved = path.resolve(file);
    if (cache.has(resolved)) return cache.get(resolved);
    const module = { exports: {} };
    cache.set(resolved, module.exports);
    const localRequire = createRequire(resolved);
    function requireModule(name) {
      if (name === "./streaming") return {
        resolveJsonObjectOutputOptions: () => ({ responseFormat: { type: "json_object" } }),
        streamChatCompletion: async (...args) => {
          requests.push(args);
          return { content: JSON.stringify(semanticResponse), finishReason: "stop", toolCalls: [] };
        },
      };
      if (name.startsWith(".")) {
        const base = path.resolve(path.dirname(resolved), name);
        for (const source of [`${base}.ts`, path.join(base, "index.ts")]) {
          if (fs.existsSync(source)) return load(source);
        }
      }
      return localRequire(name);
    }
    new Function("exports", "module", "require", ts.transpileModule(fs.readFileSync(resolved, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }, fileName: resolved,
    }).outputText)(module.exports, module, requireModule);
    return module.exports;
  }

  const { resolveAndApplySubmitIntentRouting } = load("src/store/submitIntentRouting.ts");
  const { executeSubmitBlockingPreflight, startSubmitBlockingPreflightEffect } = load("src/store/submitPreflightExecutor.ts");
  const { beginSessionCancellation } = load("src/store/sessionCancellationBarrier.ts");
  const { runIntentPreflight } = load("src/lib/intentPreflight.ts");
  const effects = [];
  const pending = [];
  const resumes = [];
  const input = {
    text: "", preferredLanguage: "en", options: {}, currentMainModeKey: "main_mode", hasWorkspace: true,
    isHidden: false, autoApproveTools: false, fallbackRunIntent: "respond", mainDebugShortcut: null,
    mainIntentShortcut: null, lockedComposerIntent: null, goalCreationAuthorization: null,
    goalContinuationAuthorization: null, currentTurn: null, currentTurnIntent: "respond",
    hasPlanArtifacts: false, shouldContinuePlanIntent: false, shouldContinuePreviousTurnIntent: false,
    previousTurnContinuationTarget: null, previousTurnContinuationIntent: null, shouldReuseExistingTurnIntent: false,
    shouldExecuteOnceFromReplyOption: false, shouldRouteContinuationToPlanResume: false,
    planExecutionResumeContinuationTarget: null, planStage: "idle", isPlanApproved: false,
    currentTurnId: null, dismissedPendingDecisionInputKey: null,
    currentConfig: { activeProfile: "local", local: { endpoint: "http://fixture.invalid/v1", model: "fixture" } },
    sendOriginSessionKey: "/tmp/project:7", setState() {}, applyPreRunSessionPatch() {}, approvePlan() {},
    startPlanExecutionResume() {}, startBlockingPreflight: (effect) => effects.push(effect), logStoreEvent() {},
  };
  return {
    requests, effects, pending, resumes,
    route(text, overrides = {}) {
      return resolveAndApplySubmitIntentRouting({ ...input, text, ...overrides });
    },
    async complete(latest = {}) {
      assert.equal(effects.length, 1, "exactly one bounded preflight must be scheduled");
      return executeSubmitBlockingPreflight({
        effect: effects[0], runIntentPreflight,
        getLatestSnapshot: () => ({ input: effects[0].originalText, selectedMainModeKey: "main_mode", lockedComposerIntent: null, isOriginSessionActive: true, isOriginOwnerCurrent: true, ...latest }),
        applyPendingRunDecision: (decision) => pending.push(decision),
        resumeSubmission: (text, images, options) => resumes.push({ text, images, options }),
        logStoreEvent() {},
      });
    },
    async completeWithState(state, afterStart = () => {}) {
      let current = { input: effects[0].originalText, selectedMainModeKey: "main_mode", ...state };
      return startSubmitBlockingPreflightEffect({
        effect: effects[0],
        runIntentPreflight: async (request) => {
          const result = await runIntentPreflight(request);
          afterStart(current);
          return result;
        },
        getState: () => current,
        setState: (updater) => { current = { ...current, ...updater(current) }; },
        isSessionRuntimeActive: () => current.originActive !== false,
        applyPreRunSessionPatch: (patch) => pending.push(patch.pendingRunDecision),
        resumeSubmission: (text, images, options) => resumes.push({ text, images, options }),
        logStoreEvent() {},
      });
    },
    beginSessionCancellation,
  };
}

const operation = {
  intent: "execute", confidence: 0.97, requiresApproval: true, riskLevel: "medium",
  commandDirective: { kind: "shell", source: "preflight", requiresApproval: true, requiresWorkspace: true },
};

for (const text of [
  "请使用 $unity-cli 检查当前 Unity 项目和本机运行环境。缺少 Unity CLI 时按官方说明安装；需要连接编辑器时检查 Unity 版本，并为当前项目安装所需的 Pipeline 包。最后报告 CLI 版本、目标项目路径和 Editor 连接状态。",
  "Inspect the current Docker container state using the CLI.",
  "Use $example-cli to inspect this project and local environment; install missing dependencies and report the connection state.",
]) {
  test(`workspace output-style hints receive semantic action calibration: ${text}`, async () => {
    const harness = createHarness(operation);
    const claim = { instructionId: "instruction-1", ownerGeneration: "generation-1" };
    assert.equal(harness.route(text, { options: { workspaceInstructionClaim: claim } }).handled, true);
    const action = await harness.complete();
    assert.equal(action.kind, "resume");
    assert.equal(harness.resumes.length, 1);
    const resumed = harness.resumes[0];
    assert.equal(resumed.options.resolvedIntent, "execute");
    assert.equal(resumed.options.commandDirective.kind, "shell");
    assert.equal(resumed.options.executionConsentGranted, undefined, "semantic routing cannot approve tools");
    assert.equal(resumed.options.workspaceInstructionClaim, claim, "resume must keep the existing owner fence");
    assert.equal(harness.route(text, { options: resumed.options }).effectiveRunIntent, "execute");
    assert.equal(harness.requests.length, 1);
    assert.equal(harness.requests[0][5], 512);
    assert.deepEqual(harness.requests[0][4], [], "preflight exposes no tools");
    assert.equal(harness.requests[0][0].length, 2, "preflight sends only its router instructions and current input");
  });
}

for (const text of ["请修改 src/Settings.cs 并把属性改成只读。", "Make the field read-only.", "Please modify src/Settings.cs to make the field read-only."]) {
  test(`property wording is interpreted by semantics: ${text}`, async () => {
    const harness = createHarness(operation);
    assert.equal(harness.route(text).handled, true);
    await harness.complete();
    assert.equal(harness.resumes[0].options.resolvedIntent, "execute");
    assert.equal(harness.requests.length, 1);
  });
}

test("semantic calibration can retain read-only analysis despite operational command metadata", async () => {
  const harness = createHarness({ ...operation, intent: "analyze" });
  assert.equal(harness.route("Inspect the current container architecture and explain the tradeoffs.").handled, true);
  const action = await harness.complete();
  assert.equal(action.kind, "resume");
  assert.equal(harness.resumes[0].options.resolvedIntent, "analyze");
  assert.equal(harness.resumes[0].options.commandDirective.requiresApproval, false);
});

test("semantic calibration returns explanation requests to respond without granting operation authority", async () => {
  const harness = createHarness({ intent: "respond", confidence: 0.98 });
  assert.equal(harness.route("Report how this command would inspect the service without requesting any current machine results.").handled, true);
  await harness.complete();
  assert.equal(harness.resumes[0].options.resolvedIntent, "respond");
  assert.equal(harness.resumes[0].options.commandDirective.requiresApproval, false);
});

test("missing or ambiguous semantic results cannot resume a lexical fallback", async () => {
  for (const [candidate, kind] of [[{ ...operation, needsUserChoice: true }, "blocked"], [null, "error"]]) {
    const harness = createHarness(candidate);
    assert.equal(harness.route("Inspect the current service.").handled, true);
    const action = await harness.complete();
    assert.equal(action.kind, "conclude_without_execution");
    assert.equal(action.resultKind, kind);
    assert.equal(harness.resumes.length, 0);
    assert.equal(harness.pending.length, 0);
  }
});

test("valid low confidence semantics retain their capability decision", async () => {
  const harness = createHarness({ ...operation, confidence: 0.6 });
  harness.route("Hello, inspect the service as requested.");
  await harness.complete();
  assert.equal(harness.resumes[0].options.resolvedIntent, "execute");
});

for (const text of ["Hello!", "Explain how docker ps works.", "请解释这个命令的含义。", "npm test"]) {
  test(`natural input has no lexical bypass: ${text}`, () => {
    const harness = createHarness(operation);
    assert.equal(harness.route(text).handled, true);
    assert.equal(harness.effects.length, 1);
  });
}

for (const text of [
  "Inspect README.md. Do not modify files or run commands.",
  "检查当前环境，不要执行命令或修改文件。",
  "Read-only audit of the current environment.", "请只读检查当前环境。",
]) {
  test(`natural read-only restrictions remain semantic input and retain the calibrated read-only intent: ${text}`, async () => {
    const harness = createHarness({ ...operation, intent: "analyze" });
    assert.equal(harness.route(text).handled, true);
    await harness.complete();
    assert.equal(harness.requests.length, 1);
    assert.ok(harness.requests[0][0][1].content.includes(text));
    assert.equal(harness.resumes[0].options.resolvedIntent, "analyze");
    assert.equal(harness.resumes[0].options.commandDirective.requiresApproval, false);
    assert.equal(harness.resumes[0].options.executionConsentGranted, undefined);
  });
}

test("explicit modes bound the semantic request; other products keep their router", () => {
  for (const overrides of [
    { lockedComposerIntent: "analyze" },
    { text: "/analyze inspect the local service", mainIntentShortcut: { intent: "analyze", command: "/analyze", rest: "inspect the local service" } },
  ]) {
    const harness = createHarness(operation);
    assert.equal(harness.route("Inspect the current local service.", overrides).handled, true);
    assert.equal(harness.effects[0].request.explicitIntent, "analyze");
  }
  const harness = createHarness(operation);
  assert.equal(harness.route("Inspect the current local service.", { currentMainModeKey: "image_studio" }).handled, false);
  assert.equal(harness.effects.length, 0);
});

test("late workspace preflight cannot resume a changed draft or inactive origin", async () => {
  for (const latest of [{ input: "A different task" }, { isOriginSessionActive: false }, { selectedMainModeKey: "image_studio" }]) {
    const harness = createHarness(operation);
    assert.equal(harness.route("Inspect the local service.").handled, true);
    const action = await harness.complete(latest);
    assert.ok(action.kind === "stale_discard" || action.kind === "skip_inactive_session");
    assert.equal(harness.resumes.length, 0);
    assert.equal(harness.pending.length, 0);
  }
});

function ownerFixture() {
  const claim = { claimId: "claim-1", receiptId: "receipt-1", clientSubmissionId: "submission-1", sessionKey: "/tmp/project:7", sessionEpoch: "epoch-1", turnId: "turn-1", admittedUserBlockId: 10 };
  const queue = {
    schemaVersion: 1, version: 0, updatedAt: 0, sessionKey: claim.sessionKey, sessionEpoch: claim.sessionEpoch,
    entries: [{ status: "dispatching", claim: { claimId: claim.claimId, sessionKey: claim.sessionKey, sessionEpoch: claim.sessionEpoch, claimedAt: 0 }, receipt: { receiptId: claim.receiptId, turnId: claim.turnId, userBlockId: claim.admittedUserBlockId, sessionKey: claim.sessionKey }, instruction: { clientSubmissionId: claim.clientSubmissionId } }],
  };
  claim.instructionEnvelopeIdentity = JSON.stringify({ instruction: queue.entries[0].instruction, receipt: queue.entries[0].receipt });
  return { claim, state: { workspaceTurnQueue: queue }, options: { adoptExistingTurn: true, workspaceInstructionClaim: claim, turnIdOverride: claim.turnId, admittedUserBlockId: claim.admittedUserBlockId } };
}

for (const result of [operation, { intent: "plan", confidence: 0.6, needsUserChoice: true, options: [{ id: "plan", label: "Plan first", value: "Plan first" }] }]) {
  test(`workspace ${result.needsUserChoice ? "choice" : "execution"} preflight cannot outlive its durable dispatch owner`, async () => {
    for (const replacement of ["inactive", "missing", "epoch", "claim", "canceled"]) {
      const harness = createHarness(result);
      const fixture = ownerFixture();
      assert.equal(harness.route("Inspect the local service.", { options: fixture.options }).handled, true);
      const action = await harness.completeWithState(fixture.state, (state) => {
        assert.ok(state.abortController, "the original owner must have started real preflight inference");
        if (replacement === "inactive") state.originActive = false;
        if (replacement === "missing") state.workspaceTurnQueue = null;
        if (replacement === "epoch") state.workspaceTurnQueue = { ...state.workspaceTurnQueue, sessionEpoch: "epoch-replacement" };
        if (replacement === "claim") state.workspaceTurnQueue = { ...state.workspaceTurnQueue, entries: [{ ...state.workspaceTurnQueue.entries[0], claim: { ...state.workspaceTurnQueue.entries[0].claim, claimId: "claim-replacement" } }] };
        if (replacement === "canceled") {
          state.runtimeEvents = [
          { type: "run.aborted", threadId: fixture.claim.sessionKey, turnId: fixture.claim.turnId, runId: "run-1" },
          { type: "run.completed", threadId: fixture.claim.sessionKey, turnId: fixture.claim.turnId, runId: "run-1", resultKind: "canceled" },
          { type: "turn.completed", threadId: fixture.claim.sessionKey, turnId: fixture.claim.turnId, resultKind: "canceled" },
        ];
          state.taskFlow = [{ type: "agent", turnId: fixture.claim.turnId, visibility: "assistant_final" }];
        }
      });
      assert.equal(action.kind, "skip_inactive_session", replacement);
      assert.equal(harness.pending.length, 0, replacement);
      assert.equal(harness.resumes.length, 0, replacement);
    }
  });
}

test("a pending cancellation fences workspace preflight before its terminal projection settles", async () => {
  const harness = createHarness({ intent: "plan", confidence: 0.6, needsUserChoice: true });
  const fixture = ownerFixture();
  assert.equal(harness.route("Inspect the local service.", { options: fixture.options }).handled, true);
  const action = await harness.completeWithState(fixture.state, (state) => {
    assert.ok(state.abortController);
    harness.beginSessionCancellation(fixture.claim.sessionKey, fixture.claim.turnId, () => new Promise(() => {}));
  });
  assert.equal(action.kind, "skip_inactive_session");
  assert.equal(harness.pending.length, 0);
  assert.equal(harness.resumes.length, 0);
});

test("a global slash submission compares the unchanged raw composer identity while interpreting its body", async () => {
  const original = "/analyze Inspect README.md";
  for (const [latest, expected] of [[original, "resume"], ["/plan A different request", "stale_discard"]]) {
    const harness = createHarness({ ...operation, intent: "analyze" });
    assert.equal(harness.route("Inspect README.md", {
      submittedText: original, hasWorkspace: false,
      mainIntentShortcut: { intent: "analyze", command: "/analyze", rest: "Inspect README.md" },
      lockedComposerIntent: "analyze",
    }).handled, true);
    const action = await harness.complete({ input: latest, lockedComposerIntent: "analyze" });
    assert.equal(action.kind, expected);
    assert.equal(harness.effects[0].request.input, "Inspect README.md");
    assert.equal(harness.effects[0].originalComposerInput, original);
  }
});
