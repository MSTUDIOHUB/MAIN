import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createTsModuleLoader } from "./tsModuleLoader.mjs";

test("approved 23-target empty-dir manual plan completes with 1 Unity probe, 0 extra conclude LLM calls, and ledger-truthful final projection", async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "main-mframework-remediation-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));

  const { sha256Hex } = createTsModuleLoader()("src/lib/sha256.ts");
  const targets = Array.from({ length: 23 }, (_, idx) =>
    `Assets/MFramework/Module${String(idx + 1).padStart(2, "0")}/File${idx + 1}.cs`,
  );

  let unityProbeCount = 0;
  let modelCallCount = 0;
  let concludeModelCalls = 0;
  const sessionKey = `${workspace}:1`;
  let state;
  let eventId = 0;
  const turn = {
    workspaceKey: workspace,
    sessionKey,
    sessionEpoch: "epoch-mframework",
    clientSubmissionId: "sub-mframework",
    turnId: "turn-mframework",
  };
  const run = {
    sessionKey,
    sessionEpoch: turn.sessionEpoch,
    turnId: turn.turnId,
    runId: "run-mframework",
    parentRunId: null,
    attemptId: "attempt-mframework",
  };

  let checkpoint = null;
  const logEvents = [];

  const load = createTsModuleLoader({
    "../../lib/ipc": {
      getFileMetadata: async (target) => {
        const full = path.join(workspace, target);
        if (!fs.existsSync(full)) throw new Error(`FILE_METADATA_NOT_FOUND: ${target}`);
        return { path: target, sizeBytes: fs.statSync(full).size };
      },
      readFileWindow: async (target) => {
        const bytes = fs.readFileSync(path.join(workspace, target), "utf8");
        return { contentVersion: `sha256-${sha256Hex(bytes)}` };
      },
      readPlanDocument: async (ref) => ({ ...ref, markdown: fs.readFileSync(path.join(workspace, ref.path), "utf8") }),
      runUnityEditorOperation: async (command, args) => {
        if (command === "unity_compile_project") {
          unityProbeCount += 1;
          return { status: "not_unity_project", kind: args.checkKind || "csharp", message: "No ProjectSettings/ProjectVersion.txt" };
        }
        return { status: "unavailable" };
      },
      shellPermissionPreflight: async (command) => ({ command, decision: "allow", segmentDecisions: [] }),
    },
    "../../lib/providerLaneSettings": {
      deriveStreamSettings: () => ({ provider: "OMLX", apiProtocol: "openai", toolProtocol: "native", model: "qwen3-coder", contextLimit: 32768 }),
      deriveBudgetedStreamSettings: () => ({ provider: "OMLX", apiProtocol: "openai", toolProtocol: "native", model: "qwen3-coder", contextLimit: 32768 }),
      deriveProviderAdapterCapabilities: () => ({ nativeToolRoundTrip: true, reasoningToggle: false }),
    },
    "../../lib/modelLaneCoordinator": {
      acquireModelLane: async () => ({ markFirstToken() {}, reportFailure() {}, release() {}, setPressureHandler() {} }),
    },
    "../../lib/streaming": {
      isStreamOutputLimited: () => false,
      streamChatCompletion: async (messages) => {
        modelCallCount += 1;
        const sys = messages.filter((m) => m.role === "system").map((m) => String(m.content || "")).join("\n");
        if (sys.includes("输出自适应复杂度的结构化最终 Markdown") || sys.includes("Tools are closed")) {
          concludeModelCalls += 1;
        }
        const pendingTarget = targets.find((target) => !fs.existsSync(path.join(workspace, target)));
        if (pendingTarget) {
          return {
            content: "",
            finishReason: "tool_calls",
            usage: {},
            toolCalls: [{
              id: `write-${modelCallCount}`,
              name: "write_file",
              arguments: JSON.stringify({ path: pendingTarget, content: `namespace MFramework { public class M${modelCallCount} {} }\n` }),
            }],
          };
        }
        return {
          content: "Should not even need a conclude call.",
          semanticContent: "Should not even need a conclude call.",
          toolCalls: [],
          finishReason: "stop",
          usage: {},
        };
      },
    },
    "../../lib/toolExecutor": {
      executeTool: async (name, args) => {
        assert.equal(name, "write_file");
        const full = path.join(workspace, args.path);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, args.content, { flag: "wx" });
        return JSON.stringify({
          success: true,
          changedPaths: [args.path],
          mutationVersions: [{ path: args.path, version: `sha256-${sha256Hex(args.content)}` }],
        });
      },
    },
    "./executionMutationPreflight": {
      prepareRuntimeV2Mutation: async ({ args }) => ({
        allowed: true,
        writeFileTarget: { path: args.path, exists: fs.existsSync(path.join(workspace, args.path)) },
      }),
    },
  });

  const kernel = load("src/lib/runtime-v2/index.ts");
  const review = load("src/store/runtimeV2/workPlanAdapter.ts");
  const { runSubmitRuntimeV2Execute } = load("src/store/runtimeV2/executeRunner.ts");

  const plan = kernel.sealWorkPlanV1({
    createdAt: 1,
    evidence: [],
    draft: {
      schemaVersion: kernel.WORK_PLAN_V1_SCHEMA_VERSION,
      objective: "Generate 23 MFramework modules in empty directory with manual acceptance.",
      summary: "Deliver all 23 C# modules cleanly.",
      findings: [],
      risks: [],
      assumptions: [],
      blockingQuestions: [],
      sameTurnDefectCorrection: "authorized",
      steps: targets.map((target) => ({
        title: `Create ${target}`,
        operation: "create",
        targets: [target],
        basis: [],
        change: `Implement ${target}`,
        expectedOutcome: `Created ${target}`,
        dependsOn: [],
      })),
      validations: [{
        stepIndexes: targets.map((_, index) => index),
        kind: "advisory",
        command: "manual_verification",
        expectedOutcome: "Copy to Unity 2022 LTS project and verify compilation and PlayMode.",
        required: false,
      }],
    },
  });

  const planPath = ".MAIN/plans/plan-mframework/rev-1.md";
  fs.mkdirSync(path.dirname(path.join(workspace, planPath)), { recursive: true });
  fs.writeFileSync(path.join(workspace, planPath), plan.markdown);

  const commit = review.createRuntimeV2PlanReviewCommit({
    plan,
    turn,
    run,
    requestId: "review-mframework",
    createdAt: 1,
    documentRef: {
      owner: { workspace, sessionKey, sessionEpoch: turn.sessionEpoch, turnId: turn.turnId },
      documentId: "plan-mframework",
      revision: 1,
      path: planPath,
      title: "MFramework",
      kind: "plan",
      contentHash: sha256Hex(plan.markdown),
    },
  });

  const append = (fields) => {
    const res = kernel.appendRuntimeV2Checkpoint({
      owner: turn,
      checkpoint,
      expectedRevision: checkpoint?.revision || 0,
      event: {
        schemaVersion: kernel.RUNTIME_V2_EVENT_SCHEMA_VERSION,
        sequence: checkpoint?.aggregate.nextSequence || 0,
        at: ++eventId,
        eventId: `mframework-ev-${eventId}`,
        ...fields,
      },
    });
    assert.equal(res.disposition, "committed", `failed to append ${fields.type}: ${res.reason}`);
    checkpoint = res.checkpoint;
  };

  append({ type: "turn.admitted", turn, strategy: "plan", objective: plan.draft.objective, constraints: [], acceptanceCriteria: ["Deliver 23 files"] });
  append({ type: "run.started", run, phase: "planning" });
  const saveCmd = {
    idempotencyKey: "save-mframework-artifact",
    kind: "execute_tool",
    run,
    phase: "planning",
    payload: { toolName: "save_plan_document", runtimeOwnedPlanArtifact: true },
  };
  append({ type: "command.scheduled", run, command: saveCmd });
  append({
    type: "tool.completed",
    run,
    idempotencyKey: saveCmd.idempotencyKey,
    status: "succeeded",
    evidence: [],
    modelContent: JSON.stringify({ planDocument: commit.artifact.documentRef, markdown: plan.markdown }),
  });
  append({ type: "work_plan.sealed", run, workPlan: review.toRuntimeV2WorkPlanReference(plan), sealedPlan: plan, reviewCommit: commit });
  append({ type: "work_plan.approved", run, workPlan: review.toRuntimeV2WorkPlanReference(plan, "approved") });
  append({ type: "phase.changed", run, phase: "observing", reason: "Approved plan ready" });

  let id = 0;
  state = {
    config: { language: "zh", activeProfile: "local", local: { provider: "OMLX", model: "qwen3-coder", toolProtocol: "native" }, sessionRecordingEnabled: false },
    currentWorkspace: workspace,
    currentSessionId: 1,
    currentTurnId: turn.turnId,
    currentTurnExecutionConsent: { turnId: turn.turnId, granted: true },
    autoApproveTools: false,
    skills: [],
    sessionsByWorkspace: { [workspace]: [{ id: 1, planLifecycleEpoch: turn.sessionEpoch, recordingDisabled: true, messages: [] }] },
    conversationTurns: [{ id: turn.turnId, clientSubmissionId: turn.clientSubmissionId, userPrompt: plan.draft.objective, title: "MFramework", status: "executing", blockIds: [] }],
    taskFlow: [],
    agentMessages: [],
    runtimeEvents: [],
    runtimeV2Checkpoints: { [turn.turnId]: checkpoint },
    harnessRunMarker: { sessionKey, turnId: turn.turnId, runId: run.runId, status: "running" },
    _nextTaskId: () => ++id,
  };

  const result = await runSubmitRuntimeV2Execute({
    get: () => state,
    set: (patch) => { state = { ...state, ...(typeof patch === "function" ? patch(state) : patch) }; },
    context: {
      turnId: turn.turnId,
      uiDisplayTurnId: turn.turnId,
      runScopeKey: workspace,
      runSessionKey: sessionKey,
      runSessionId: 1,
      runSessionEpoch: turn.sessionEpoch,
      runWorkspace: workspace,
      harnessRunId: run.runId,
      abortCtrl: new AbortController(),
      phaseLanguage: "zh",
      effectiveRunIntent: "execute",
      runtimeRunIntent: "execute",
      turnInputContextSignals: { imageParts: 0, mentionedFilePaths: [], attachedFilePaths: [], subagentPreference: "allowed" },
      runtimeContextBudget: { contextLimit: 32768, inputBudget: 28672, outputBudget: 4096, readWindowChars: 18000 },
    },
    getSessionRevisionToken: () => state,
    sanitizeTaskBlocksForPersist: (blocks) => blocks,
    buildSessionRuntimeSnapshot: (current) => ({ runtimeV2Checkpoints: current.runtimeV2Checkpoints }),
    persistSessionRecord: async () => { throw new Error("Recording disabled in isolated fixture."); },
    publishOwnerScopedRuntimeProjection: ({ projectedState }) => {
      state = projectedState;
      return { published: true, disposition: "published" };
    },
    logStoreEvent: (name, payload = {}) => { logEvents.push({ type: name, payload }); },
  });

  const finalAgg = state.runtimeV2Checkpoints[turn.turnId].aggregate;
  assert.equal(result.outcome.resultKind, "success", JSON.stringify(finalAgg.terminalOutcome));

  const finals = finalAgg.events.filter((e) => e.type === "projection.published" && e.audience === "final");
  assert.equal(finals.length, 1, "exactly one final projection is published");
  assert.equal(unityProbeCount, 1, "Unity compiler probe short-circuits after first not_unity_project receipt");
  assert.equal(concludeModelCalls, 0, "standard approved plan finalizes with 0 extra conclude LLM requests");
  assert.equal(finalAgg.terminalOutcome.resultKind, "success");

  const finalMarkdown = finals[0].projection.markdown;
  assert.match(finalMarkdown, /文件交付完成，人工验收待办/);
  assert.match(finalMarkdown, /实际交付文件（23 个）/);
  for (const target of targets) {
    assert.ok(fs.existsSync(path.join(workspace, target)), `${target} created on disk`);
    assert.ok(finalMarkdown.includes(target), `${target} listed in final projection`);
  }
  assert.match(finalMarkdown, /最新修改后的自动验证 0 次通过/);
  assert.match(finalMarkdown, /当前目录不适用 Unity 编译检查/);
  assert.match(finalMarkdown, /Copy to Unity 2022 LTS project/);

  const terminalLog = logEvents.find((item) => item.type === "runtime_v2_execute_terminal");
  assert.ok(terminalLog);
  assert.equal(terminalLog.payload.zeroModelConclude, true);
  assert.equal(terminalLog.payload.concludeModelCalls, 0);

  // Free-form finalMarkdown cannot overwrite or hide runtime ledger acceptance facts
  const overridden = kernel.buildRuntimeV2FinalProjection(
    finalAgg,
    "final-with-prose",
    "success",
    finalAgg.terminalOutcome.reason,
    "已完成自动化测试全部通过。",
    "zh",
  );
  assert.match(overridden.markdown, /已完成自动化测试全部通过。/);
  assert.match(overridden.markdown, /#### 验收与交付事实/);
  assert.match(overridden.markdown, /最新修改后的自动验证 0 次通过/);
  assert.match(overridden.markdown, /当前目录不适用 Unity 编译检查/);
});
