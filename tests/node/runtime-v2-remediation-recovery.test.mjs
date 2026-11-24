import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "./tsModuleLoader.mjs";

const load = createTsModuleLoader();
const kernel = load("src/lib/runtime-v2/index.ts");
const review = load("src/store/runtimeV2/workPlanAdapter.ts");
const { selectRuntimeV2ProviderToolDefinitions } = load("src/store/runtimeV2/executionProviderTools.ts");
const { runtimeV2ToolDefinitions } = load("src/store/runtimeV2/executionToolDefinitions.ts");
const { buildCompactRuntimeV2ConcludeConversation } = load("src/store/runtimeV2/executionConcludeContext.ts");

const turn = {
  workspaceKey: "/fixture-recovery",
  sessionKey: "session-rec",
  sessionEpoch: "epoch-rec",
  clientSubmissionId: "sub-rec",
  turnId: "turn-rec",
};

const run = {
  sessionKey: turn.sessionKey,
  sessionEpoch: turn.sessionEpoch,
  turnId: turn.turnId,
  runId: "run-rec",
  parentRunId: null,
  attemptId: "attempt-rec",
};

function ev(state, type, fields = {}) {
  return kernel.transition(state, {
    schemaVersion: kernel.RUNTIME_V2_EVENT_SCHEMA_VERSION,
    sequence: state ? state.nextSequence : 0,
    eventId: `rec-ev-${(state?.nextSequence ?? 0) + 1}`,
    at: (state?.updatedAt ?? 0) + 1,
    type,
    ...fields,
  });
}

test("checkpoint restore preserves pending blocking review findings, conditional tool surface, and terminal finality without duplicate concludes", () => {
  const plan = kernel.sealWorkPlanV1({
    createdAt: 1,
    evidence: [],
    draft: {
      schemaVersion: kernel.WORK_PLAN_V1_SCHEMA_VERSION,
      objective: "Build and verify MFramework Pool",
      summary: "Pool implementation",
      findings: [],
      risks: [],
      assumptions: [],
      blockingQuestions: [],
      sameTurnDefectCorrection: "authorized",
      steps: [
        { title: "Create Pool", operation: "create", targets: ["Assets/Pool.cs"], basis: [], change: "Add Pool", expectedOutcome: "Pool created", dependsOn: [] },
      ],
      validations: [{ kind: "advisory", stepIndexes: [0], command: "manual_verification", expectedOutcome: "Manual Unity verification", required: false }],
    },
  });
  const commit = review.createRuntimeV2PlanReviewCommit({ plan, turn, run, requestId: "req-rec", createdAt: 1 });
  let state = ev(null, "turn.admitted", { turn, strategy: "plan", objective: plan.draft.objective, constraints: [], acceptanceCriteria: ["Pool works"] });
  state = ev(state, "run.started", { run, phase: "planning" });
  state = ev(state, "work_plan.sealed", { run, workPlan: review.toRuntimeV2WorkPlanReference(plan), sealedPlan: plan, reviewCommit: commit });
  state = ev(state, "work_plan.approved", { run, workPlan: review.toRuntimeV2WorkPlanReference(plan, "approved") });
  state = ev(state, "phase.changed", { run, phase: "acting", reason: "Executing" });
  state = ev(state, "command.scheduled", {
    run, command: { idempotencyKey: "mut-pool", kind: "execute_tool", run, phase: "acting", payload: { toolName: "write_file", arguments: { path: "Assets/Pool.cs", content: "// pool" } } },
  });
  state = ev(state, "tool.completed", {
    run, idempotencyKey: "mut-pool", status: "succeeded", effectKind: "workspace_change",
    mutationRequests: [{ target: "Assets/Pool.cs", operation: "create" }],
    evidence: [{ id: "m-pool", kind: "mutation", target: "Assets/Pool.cs", version: "sha256-" + "1".repeat(64) }],
  });

  const allDefs = runtimeV2ToolDefinitions();
  const cmdBeforeReview = { idempotencyKey: "c1", kind: "request_model", run, phase: "acting", payload: { mode: "execute", collaborationAllowed: true } };
  const toolsBefore = selectRuntimeV2ProviderToolDefinitions({
    ports: {
      context: { turnId: turn.turnId, runWorkspace: turn.workspaceKey, runSessionKey: turn.sessionKey },
      live: { childWriteScopes: new Map() },
      get: () => ({
        currentTurnId: turn.turnId,
        conversationTurns: [{ id: turn.turnId }],
        runtimeV2Checkpoints: { [turn.turnId]: kernel.createRuntimeV2Checkpoint({ aggregate: state, revision: state.nextSequence, updatedAt: state.updatedAt }) },
      }),
    },
    command: cmdBeforeReview,
    available: allDefs,
  });
  assert.equal(toolsBefore.some((t) => t.function.name === "resolve_review_finding"), false, "KV cache prefix stays unchanged when no review completed");

  // Schedule & complete review with [BLOCKING] finding, then checkpoint-roundtrip!
  state = ev(state, "subagents.scheduled", {
    run,
    maxActiveSubagents: 2,
    jobs: [{
      id: "rev-1",
      run: { ...run, runId: "c-rev-1", parentRunId: run.runId },
      parentRunId: run.runId,
      scopeKey: "pool-audit",
      taskKind: "review",
      accessMode: "read",
      objective: "Audit Pool.cs",
      allowedPaths: ["Assets/Pool.cs"],
      status: "queued",
      requestedAt: 5,
      firstTokenAt: null,
      closedAt: null,
      summary: null,
    }],
  });
  const poolMutationEv = { id: "m-pool", kind: "mutation", target: "Assets/Pool.cs", version: "sha256-" + "1".repeat(64) };
  const report = kernel.compileRuntimeV2SubagentTextReport({
    summary: "[BLOCKING] Assets/Pool.cs: Missing type base (m-pool).",
    evidence: [{ id: "rev-1-ev", kind: "subagent", target: "Assets/Pool.cs", version: "sha256-" + "1".repeat(64) }],
    inheritedEvidence: [poolMutationEv],
  });
  state = ev(state, "subagent.telemetry", { run, telemetry: { jobId: "rev-1", phase: "request_opened", at: 6 } });
  state = ev(state, "subagent.telemetry", { run, telemetry: { jobId: "rev-1", phase: "closed", at: 7 } });
  state = ev(state, "subagent.completed", {
    run, jobId: "rev-1", status: "completed", summary: report.summary,
    evidence: [{ id: "rev-1-ev", kind: "subagent", target: "Assets/Pool.cs", version: "sha256-" + "1".repeat(64) }],
    inheritedEvidence: [poolMutationEv],
    report,
  });
  state = ev(state, "subagent.handoff_delivered", { run, jobId: "rev-1", contextEntryId: "child:rev-1", evidenceIds: ["rev-1-ev"] });

  const cp1 = kernel.createRuntimeV2Checkpoint({ aggregate: state, revision: state.nextSequence, updatedAt: state.updatedAt });
  const raw1 = JSON.parse(JSON.stringify(kernel.serializeRuntimeV2CheckpointMap({ [turn.turnId]: cp1 })));
  const restored1 = kernel.normalizeRuntimeV2Checkpoint(raw1[turn.turnId], turn).aggregate;

  const restoredLedger = kernel.deriveRuntimeV2ReviewDispositionLedger(restored1);
  assert.equal(restoredLedger.pendingBlockingCount, 1);
  assert.equal(restoredLedger.pendingBlockingFindings[0].findingId, "rev-1:f1");

  const toolsAfter = selectRuntimeV2ProviderToolDefinitions({
    ports: {
      context: { turnId: turn.turnId, runWorkspace: turn.workspaceKey, runSessionKey: turn.sessionKey },
      live: { childWriteScopes: new Map() },
      get: () => ({ currentTurnId: turn.turnId, conversationTurns: [{ id: turn.turnId }], runtimeV2Checkpoints: { [turn.turnId]: raw1[turn.turnId] } }),
    },
    command: cmdBeforeReview,
    available: allDefs,
  });
  assert.equal(toolsAfter.some((t) => t.function.name === "resolve_review_finding"), true, "restored blocking review exposes resolve_review_finding");

  // Resolve finding + finalize cleanly + restore terminal checkpoint
  const resolveArgs = { finding_id: "rev-1:f1", disposition: "falsified", summary: "Base class confirmed.", verification_evidence_ids: ["m-pool"] };
  // Use current source evidence to falsify cleanly
  let settled = ev(restored1, "observation.recorded", { run, evidence: { id: "src-pool", kind: "source", target: "Assets/Pool.cs", version: "sha256-" + "1".repeat(64) } });
  const argsWithSrc = { ...resolveArgs, verification_evidence_ids: ["src-pool"] };
  settled = ev(settled, "command.scheduled", { run, command: { idempotencyKey: "res-1", kind: "execute_tool", run, phase: "acting", payload: { toolName: "resolve_review_finding", arguments: argsWithSrc } } });
  settled = ev(settled, "tool.completed", { run, idempotencyKey: "res-1", status: "succeeded", operationName: "resolve_review_finding", effectKind: "observation", evidence: [], modelContent: JSON.stringify(argsWithSrc) });

  assert.equal(kernel.canFinalizeApprovedWorkPlanWithoutModel(settled), true);
  settled = ev(settled, "phase.changed", { run, phase: "validating", reason: "Validate implementation" });
  settled = ev(settled, "phase.changed", { run, phase: "finalizing", reason: "Zero-LLM finalize" });
  const finalProj = kernel.buildRuntimeV2FinalProjection(settled, "final-rec", "success", "已批准 WorkPlan 完成", undefined, "zh");
  const outcome = { resultKind: "success", reason: "已批准 WorkPlan 完成", completedAt: settled.updatedAt + 1, finalProjectionId: finalProj.id };
  settled = ev(settled, "run.completed", { run, outcome, finalProjection: finalProj });
  settled = ev(settled, "projection.published", { run, audience: "final", projectionId: finalProj.id, projection: finalProj });
  settled = ev(settled, "turn.completed", { turn, runId: run.runId, outcome });

  const cp2 = kernel.createRuntimeV2Checkpoint({ aggregate: settled, revision: settled.nextSequence, updatedAt: settled.updatedAt });
  const raw2 = JSON.parse(JSON.stringify(kernel.serializeRuntimeV2CheckpointMap({ [turn.turnId]: cp2 })));
  const restoredFinal = kernel.normalizeRuntimeV2Checkpoint(raw2[turn.turnId], turn).aggregate;
  assert.equal(kernel.decideNextCommands(restoredFinal).length, 0, "restored terminal checkpoint schedules no extra commands or concludes");

  // Post-approval user guidance disables zero-LLM skip, compacts conclude history cleanly, and preserves both reply and ledger
  let guided = ev(restored1, "guidance.admitted", { run, text: "请解释为什么 Pool 设计成单继承" });
  const guideSrcArgs = { finding_id: "rev-1:f1", disposition: "falsified", summary: "ok", verification_evidence_ids: ["src-pool"] };
  guided = ev(guided, "observation.recorded", { run, evidence: { id: "src-pool", kind: "source", target: "Assets/Pool.cs", version: "sha256-" + "1".repeat(64) } });
  guided = ev(guided, "command.scheduled", { run, command: { idempotencyKey: "res-g", kind: "execute_tool", run, phase: "acting", payload: { toolName: "resolve_review_finding", arguments: guideSrcArgs } } });
  guided = ev(guided, "tool.completed", { run, idempotencyKey: "res-g", status: "succeeded", operationName: "resolve_review_finding", effectKind: "observation", evidence: [], modelContent: JSON.stringify(guideSrcArgs) });

  assert.equal(kernel.canFinalizeApprovedWorkPlanWithoutModel(guided), false, "post-approval guidance disables zero-LLM finalization skip");

  const hugeCode = "public class Pool {}\n".repeat(120);
  const origMessages = [
    { role: "system", content: "Approved plan anchor" },
    { role: "user", content: "Implement Pool" },
    { role: "assistant", content: "", tool_calls: [{ id: "tc1", type: "function", function: { name: "write_file", arguments: JSON.stringify({ path: "Assets/Pool.cs", content: hugeCode }) } }] },
    { role: "tool", tool_call_id: "tc1", content: "OK: written\n" + hugeCode },
    { role: "user", content: "请解释为什么 Pool 设计成单继承", runtimeGuidanceId: "g-1" },
  ];
  const compacted = buildCompactRuntimeV2ConcludeConversation({ messages: origMessages, aggregate: guided, language: "zh" });
  assert.equal(origMessages[3].content.length > 600, true, "original canonical messages remain unmutated");
  assert.match(compacted[3].content, /Compacted for conclude/);
  assert.ok(JSON.parse(compacted[2].tool_calls[0].function.arguments).compactedFromChars > 600);
  assert.equal(compacted[4].content, "请解释为什么 Pool 设计成单继承");
  assert.match(compacted.at(-1).content, /Runtime v2 terminal acceptance ledger snapshot/);

  const guidedFinal = kernel.buildRuntimeV2FinalProjection(guided, "final-guided", "success", "ok", "Pool 采用单继承是因为接口职责清晰。", "zh");
  assert.match(guidedFinal.markdown, /Pool 采用单继承是因为接口职责清晰/);
  assert.match(guidedFinal.markdown, /#### 验收与交付事实/);
  assert.match(guidedFinal.markdown, /Assets\/Pool\.cs/);
});
