import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createTsModuleLoader } from "./tsModuleLoader.mjs";

async function runBreakoutContinuation(t, { drift = false, driftDuringRun = false, foreign = false, cancel = false } = {}) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "main-continued-plan-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const sessionKey = `${workspace}:1`;
  const scriptPaths = ["Bootstrap", "Paddle", "Ball", "Brick", "GameManager", "ScoreManager"]
    .map(name => `Assets/Scripts/Breakout/${name}.cs`);
  const pending = ["Assets/Scenes/Breakout.unity", "Assets/Tests/PlayMode/BreakoutTests.cs"];
  const files = [...scriptPaths, ...pending];
  const initialBytes = target => `Fixture for ${target}\n`;
  const writes = [];
  const probes = [];
  const requests = [];
  const validations = [];
  const logs = [];
  let state;
  let id = 0;
  const abort = new AbortController();
  const load = createTsModuleLoader({
    "../../lib/ipc": {
      getFileMetadata: async target => {
        if (!fs.existsSync(path.join(workspace, target))) throw new Error("FILE_METADATA_NOT_FOUND: fixture");
        return { path: target, sizeBytes: fs.statSync(path.join(workspace, target)).size };
      },
      readFileWindow: async (target, cwd) => {
        assert.equal(cwd, workspace);
        probes.push(target);
        if (cancel) abort.abort("test cancellation during exact fact lookup");
        const bytes = fs.readFileSync(path.join(workspace, target), "utf8");
        return { contentVersion: `sha256-${hash(bytes)}` };
      },
      readPlanDocument: async reference => ({ ...reference, markdown: fs.readFileSync(planFile, "utf8") }),
      runUnityEditorOperation: async (command, args) => {
        assert.equal(command, "unity_compile_project");
        assert.equal(args.workspace, workspace);
        // This filesystem fixture has no ProjectVersion.txt or running Editor.
        return { status: "not_unity_project", kind: args.checkKind };
      },
      shellPermissionPreflight: async command => ({ command, decision: "allow", segmentDecisions: [] }),
    },
    "../../lib/providerLaneSettings": {
      deriveStreamSettings: () => ({ provider: "OMLX", apiProtocol: "openai", toolProtocol: "native", model: "fixture", contextLimit: 32768 }),
      deriveBudgetedStreamSettings: () => ({ provider: "OMLX", apiProtocol: "openai", toolProtocol: "native", model: "fixture", contextLimit: 32768 }),
      deriveProviderAdapterCapabilities: () => ({ nativeToolRoundTrip: true, reasoningToggle: false }),
    },
    "../../lib/modelLaneCoordinator": {
      acquireModelLane: async () => ({ markFirstToken() {}, reportFailure() {}, release() {}, setPressureHandler() {} }),
    },
    "../../lib/streaming": {
      isStreamOutputLimited: () => false,
      streamChatCompletion: async (messages, settings, callbacks, signal, tools) => {
        requests.push({ messages: structuredClone(messages), tools, phase: state.runtimeV2Checkpoints.next.aggregate.phase });
        const args = pending.find(target => !fs.existsSync(path.join(workspace, target)));
        if (requests.length > 4) {
          abort.abort("end of controlled mutation replay");
          return { content: "Remaining writes inspected.", toolCalls: [], finishReason: "stop", usage: {} };
        }
        if (!args) {
          if (validations.length) {
            const content = "The approved fixture and its checks are complete.";
            return { content, semanticContent: content, toolCalls: [], finishReason: "stop", usage: {} };
          }
          return { content: "", finishReason: "tool_calls", usage: {}, toolCalls: [{
            id: "next-validator", name: "run_command",
            arguments: JSON.stringify({ command: "node --test", cwd: ".", description: "Run the reviewed fixture checks" }),
          }] };
        }
        return { content: "", finishReason: "tool_calls", usage: {},
          toolCalls: [{ id: `next-write-${requests.length}`, name: "write_file",
            arguments: JSON.stringify({ path: args, content: initialBytes(args) }) }] };
      },
    },
    "../../lib/toolExecutor": {
      executeTool: async (name, args, cwd) => {
        assert.equal(cwd, workspace);
        if (name === "run_command") {
          assert.equal(args.command, "node --test");
          validations.push(args.command);
          return { exitCode: 0, stdout: "pass", stderr: "", timedOut: false };
        }
        assert.equal(name, "write_file", "the continuation should skip workspace-wide collection");
        const target = path.join(workspace, args.path);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, args.content, { flag: "wx" });
        writes.push(args.path);
        if (driftDuringRun && writes.length === 1) {
          fs.appendFileSync(path.join(workspace, scriptPaths[2]), "Concurrent file change\n");
        }
        return JSON.stringify({
          success: true,
          changedPaths: [args.path],
          mutationVersions: [{ path: args.path, version: `sha256-${hash(args.content)}` }],
          message: "File written.",
        });
      },
    },
    "./executionMutationPreflight": {
      prepareRuntimeV2Mutation: async ({ args }) => ({ allowed: true, writeFileTarget: { path: args.path, exists: false } }),
    },
  });
  const kernel = load("src/lib/runtime-v2/index.ts");
  const { sha256Hex: hash } = load("src/lib/sha256.ts");
  const review = load("src/store/runtimeV2/workPlanAdapter.ts");
  const turn = { workspaceKey: workspace, sessionKey, sessionEpoch: "fixture-epoch", clientSubmissionId: "original", turnId: "old" };
  const run = { sessionKey, sessionEpoch: turn.sessionEpoch, turnId: turn.turnId, runId: "old-run", parentRunId: null, attemptId: "old-run" };
  const plan = kernel.sealWorkPlanV1({ createdAt: 1, evidence: [], draft: {
    schemaVersion: kernel.WORK_PLAN_V1_SCHEMA_VERSION, objective: "Build and verify the Unity Breakout fixture.",
    summary: "Use Bootstrap and keyboard control.", findings: [], risks: [], assumptions: [], blockingQuestions: [],
    steps: files.map((target, index) => ({ title: `Create ${target}`, targets: [target], operation: "create",
      basis: [], change: "Create the reviewed fixture.", expectedOutcome: "The fixture exists.",
      dependsOn: index >= 6 ? [0, 1, 2, 3, 4, 5, ...(index === 7 ? [6] : [])] : [] })),
    validations: [{ kind: "finite_command", stepIndexes: files.map((_, index) => index), command: "node --test",
      cwd: ".", expectedOutcome: "PlayMode checks pass.", required: true }],
  } });
  const relativePlan = ".MAIN/plans/plan-breakout-fixture/rev-1.md";
  const planFile = path.join(workspace, relativePlan);
  fs.mkdirSync(path.dirname(planFile), { recursive: true });
  fs.writeFileSync(planFile, plan.markdown);
  const commit = review.createRuntimeV2PlanReviewCommit({
    plan, turn, run, requestId: "review-old", createdAt: 1,
    documentRef: { owner: { workspace, sessionKey, sessionEpoch: turn.sessionEpoch, turnId: turn.turnId },
      documentId: "plan-breakout-fixture", revision: 1, path: relativePlan, title: "Breakout", kind: "plan", contentHash: hash(plan.markdown) },
  });
  let checkpoint = null;
  const append = fields => {
    const result = kernel.appendRuntimeV2Checkpoint({
      owner: turn, checkpoint, expectedRevision: checkpoint?.revision || 0,
      event: { schemaVersion: kernel.RUNTIME_V2_EVENT_SCHEMA_VERSION, sequence: checkpoint?.aggregate.nextSequence || 0,
        at: ++id, eventId: `fixture-event-${id}`, ...fields },
    });
    assert.equal(result.disposition, "committed", `failed to append ${fields.type}`);
    checkpoint = result.checkpoint;
  };
  append({ type: "turn.admitted", turn, strategy: "plan", objective: plan.draft.objective, constraints: [], acceptanceCriteria: [] });
  append({ type: "run.started", run, phase: "planning" });
  const save = { idempotencyKey: "save-reviewed-artifact", kind: "execute_tool", run, phase: "planning",
    payload: { toolName: "save_plan_document", runtimeOwnedPlanArtifact: true } };
  append({ type: "command.scheduled", run, command: save });
  append({ type: "tool.completed", run, idempotencyKey: save.idempotencyKey, status: "succeeded", evidence: [],
    modelContent: JSON.stringify({ planDocument: commit.artifact.documentRef, markdown: plan.markdown }) });
  append({ type: "work_plan.sealed", run, workPlan: review.toRuntimeV2WorkPlanReference(plan), sealedPlan: plan, reviewCommit: commit });
  append({ type: "work_plan.approved", run, workPlan: review.toRuntimeV2WorkPlanReference(plan, "approved") });
  append({ type: "phase.changed", run, phase: "acting", reason: "Fixture reached execution" });
  for (const target of scriptPaths) {
    const actual = path.join(workspace, target);
    fs.mkdirSync(path.dirname(actual), { recursive: true });
    fs.writeFileSync(actual, initialBytes(target));
    const command = { idempotencyKey: `original:${target}`, kind: "execute_tool", run, phase: "acting",
      payload: { toolName: "write_file", arguments: { path: target, content: initialBytes(target) } } };
    append({ type: "command.scheduled", run, command });
    append({ type: "tool.completed", run, idempotencyKey: command.idempotencyKey, status: "succeeded",
      mutationRequests: [{ target, operation: "create" }], evidence: [{ id: command.idempotencyKey, kind: "mutation", target, version: null }] });
  }
  if (drift) fs.appendFileSync(path.join(workspace, scriptPaths[2]), "Simulated Unity API update\n");
  const finalProjection = kernel.buildRuntimeV2FinalProjection(checkpoint.aggregate, "old-final", "canceled", "user_cancelled");
  const outcome = { resultKind: "canceled", reason: "user_cancelled", completedAt: id + 2, finalProjectionId: finalProjection.id };
  append({ type: "run.aborted", run, reason: outcome.reason });
  append({ type: "run.completed", run, outcome, finalProjection });
  append({ type: "projection.published", run, audience: "final", projectionId: finalProjection.id, projection: finalProjection });
  append({ type: "turn.completed", turn, runId: run.runId, outcome });
  const continuation = load("src/store/runtimeV2/approvedPlanContinuation.ts");
  const oldCheckpoint = checkpoint;
  state = {
    config: { language: "en", activeProfile: "local", local: { provider: "OMLX", model: "fixture", toolProtocol: "native" }, sessionRecordingEnabled: false },
    currentWorkspace: workspace, currentSessionId: 1, currentTurnId: "next",
    sessionsByWorkspace: { [workspace]: [{ id: 1, planLifecycleEpoch: turn.sessionEpoch, recordingDisabled: true, messages: [] }] },
    conversationTurns: [
      { id: "old", clientSubmissionId: turn.clientSubmissionId, userPrompt: plan.draft.objective, title: "Breakout", status: "done", blockIds: [] },
      { id: "next", userPrompt: "Continue the approved plan", title: "Continue", status: "executing", blockIds: [] },
    ],
    taskFlow: [], agentMessages: [], runtimeEvents: [], runtimeV2Checkpoints: { old: checkpoint },
    harnessRunMarker: { sessionKey, turnId: "next", runId: "next-run", status: "running" },
    currentTurnExecutionConsent: { turnId: "next", granted: false }, autoApproveTools: false,
    skills: [], _nextTaskId: () => ++id,
  };
  const source = continuation.getContinuableApprovedWorkPlan(state, "old");
  assert.equal(source.coverage.completedStepIndexes.length, 6);
  state.conversationTurns[1].approvedPlanContinuation = foreign ?
    { ...source.reference, turn: { ...source.reference.turn, sessionEpoch: "different-epoch" } } : source.reference;
  const result = await load("src/store/runtimeV2/executeRunner.ts").runSubmitRuntimeV2Execute({
    get: () => state,
    set: patch => { state = { ...state, ...(typeof patch === "function" ? patch(state) : patch) }; },
    context: {
      turnId: "next", uiDisplayTurnId: "next", runScopeKey: workspace, runSessionKey: sessionKey,
      runSessionId: 1, runSessionEpoch: turn.sessionEpoch, runWorkspace: workspace, harnessRunId: "next-run",
      abortCtrl: abort, phaseLanguage: "en", effectiveRunIntent: "execute", runtimeRunIntent: "execute",
      turnInputContextSignals: { imageParts: 0, mentionedFilePaths: [], attachedFilePaths: [], subagentPreference: "unspecified" },
      runtimeContextBudget: { contextLimit: 32768, inputBudget: 28672, outputBudget: 4096, readWindowChars: 18000 },
    },
    getSessionRevisionToken: () => state,
    sanitizeTaskBlocksForPersist: blocks => blocks,
    buildSessionRuntimeSnapshot: current => ({ runtimeV2Checkpoints: current.runtimeV2Checkpoints }),
    persistSessionRecord: async () => { throw new Error("Recording is disabled in this isolated fixture."); },
    publishOwnerScopedRuntimeProjection: ({ projectedState }) => {
      state = projectedState;
      return { published: true, disposition: "published" };
    },
    logStoreEvent: (name, detail) => logs.push({ name, ...detail }),
  });
  assert.equal(state.runtimeV2Checkpoints.old, oldCheckpoint, "the original terminal ledger is untouched");
  return { state, result, requests, probes, writes, validations, pending, scriptPaths, logs, continuation, workspace };
}

test("production continuation seeds 6/8, skips discovery, and preserves previous writes", async t => {
  const replay = await runBreakoutContinuation(t);
  assert.deepEqual(replay.writes, replay.pending);
  assert.deepEqual(replay.validations, ["node --test"], JSON.stringify(replay.logs.filter(entry =>
    /rejected|error|failed|blocked|terminal|permission|phase_transition/.test(entry.name))));
  assert.ok(replay.requests.length >= 2);
  const aggregate = replay.state.runtimeV2Checkpoints.next.aggregate;
  assert.equal(aggregate.terminalOutcome?.resultKind, "success", JSON.stringify({
    outcome: replay.result.outcome, validation: aggregate.events.filter(event => event.type === "validation.completed"),
    logs: replay.logs.filter(entry => /error|failed|terminal|phase_transition/.test(entry.name)),
  }));
  assert.deepEqual(aggregate.planContinuation.completedStepIndexes, [0, 1, 2, 3, 4, 5]);
  assert.equal(aggregate.events.filter(event => event.type === "work_plan.approved").length, 1);
  assert.ok(!aggregate.events.some(event => event.type === "command.scheduled" && event.command.kind === "collect_observation"));
  assert.deepEqual(aggregate.evidence.filter(event => event.kind === "mutation").map(event => event.target), replay.pending);
  assert.equal(aggregate.events.filter(event => event.type === "projection.published" && event.audience === "final").length, 1);
});

test("production continuation stops on Ball.cs drift without a model request or write", async t => {
  const replay = await runBreakoutContinuation(t, { drift: true });
  assert.equal(replay.result.outcome.resultKind, "blocked");
  assert.deepEqual(replay.continuation.getApprovedWorkPlanContinuationIssues(replay.state, "old"), [replay.scriptPaths[2]]);
  assert.deepEqual(replay.requests, []);
  assert.deepEqual(replay.writes, []);
  assert.match(fs.readFileSync(path.join(replay.workspace, replay.scriptPaths[2]), "utf8"), /Simulated Unity API update/);
});

test("production continuation rejects a replaced session epoch before probing the workspace", async t => {
  const replay = await runBreakoutContinuation(t, { foreign: true });
  assert.equal(replay.result.outcome.resultKind, "blocked");
  assert.deepEqual(replay.requests, []);
  assert.deepEqual(replay.probes, []);
  assert.deepEqual(replay.writes, []);
});

test("a concurrent edit after the first remaining write blocks the second write and validation", async t => {
  const replay = await runBreakoutContinuation(t, { driftDuringRun: true });
  assert.equal(replay.result.outcome.resultKind, "blocked");
  assert.deepEqual(replay.writes, replay.pending.slice(0, 1));
  assert.deepEqual(replay.validations, []);
  assert.deepEqual(replay.continuation.getApprovedWorkPlanContinuationIssues(replay.state, "next"), [replay.scriptPaths[2]]);
  const aggregate = replay.state.runtimeV2Checkpoints.next.aggregate;
  assert.equal(aggregate.events.filter(event => event.type === "projection.published" && event.audience === "final").length, 1);
});

test("canceling a production continuation during version checks never grants approval", async t => {
  const replay = await runBreakoutContinuation(t, { cancel: true });
  assert.equal(replay.result.outcome.status, "aborted");
  assert.equal(replay.state.runtimeV2Checkpoints.next.aggregate.terminalOutcome.resultKind, "canceled");
  assert.ok(!replay.state.runtimeV2Checkpoints.next.aggregate.events.some(event => event.type === "work_plan.approved"));
  assert.deepEqual(replay.requests, []);
  assert.deepEqual(replay.writes, []);
});
