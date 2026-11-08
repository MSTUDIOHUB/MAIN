import type { AgentMessage } from "../../lib/agentMessages";
import { beginCapsuleToolActivity } from "../../lib/capsuleLiveActivity";
import type { RuntimeRunSettlement } from "../../lib/runtimeRunSettlement";
import { executeTool } from "../../lib/toolExecutor";
import {
  runtimeV2EvidenceVersion,
  type RuntimeV2RunIdentity,
  type RuntimeV2TurnIdentity,
  type WorkPlanRuntimeEvidence,
} from "../../lib/runtime-v2";
import type { ConversationTurn } from "../../lib/workflowModels";
import {
  createRuntimeV2CheckpointPort,
  getRuntimeV2Checkpoint,
} from "./checkpointPort";
import { PlanLedger } from "./planLedger";
import {
  boundedPlanContent,
  providerPlanMessages,
} from "./planModelProtocol";
import {
  applyReviewProjection,
} from "./planReviewProjection";
import { createRuntimeV2ProjectionPort } from "./projectionPort";
import type { RuntimeV2PlanRunnerInput } from "./planRunnerTypes";
import { resolveRuntimeV2ObjectiveAdmission } from "./submissionContext";
import { renderProjectBaselineContext } from "../../lib/workspaceAdmission";
import { planSettlement, terminalPlanOutcome } from "./planSettlement";
import { resolveRuntimeV2SessionEpoch } from "./sessionIdentity";
import { priorPlanConversationMessages } from "./planConversationHistory";
import { restorePlanHistory } from "./planHistory";
import { normalizeNetworkRead } from "../../lib/networkRead";
import { recoverRuntimeV2PlanDraft } from "./planDraftRunner";
import { collectPlanDraftSource, collectPlanDraftWorkspaceEvidence, resolveBoundPlanDraftCheckpoint, restorePlanDraftWorkspaceEvidence, type PlanDraftWorkspaceRead } from "./planDraftSource";
import { settlePlanPause } from "./planQuestionControl";
import { ASK_PLAN_QUESTIONS } from "./planQuestionTool";
import { recoverPendingPlanReadBatch } from "./planReadRecovery";
import { recoverPlanSubmission } from "./planSubmissionRepair";
import {
  resolveRuntimeV2PlanReviewFromAggregate,
} from "./workPlanAdapter";

interface PlanBootstrapReady {
  readonly settlement: null;
  readonly context: RuntimeV2PlanRunnerInput["context"];
  readonly identity: {
    readonly turn: RuntimeV2TurnIdentity;
    readonly run: RuntimeV2RunIdentity;
  };
  readonly ledger: PlanLedger;
  readonly evidence: WorkPlanRuntimeEvidence[];
  readonly evidenceContents: Map<string, string>;
  readonly historicalReads: readonly PlanDraftWorkspaceRead[];
  readonly messages: AgentMessage[];
}

interface PlanBootstrapSettled {
  readonly settlement: RuntimeRunSettlement;
}

export type PlanBootstrapResult =
  | PlanBootstrapReady
  | PlanBootstrapSettled;

function currentTurn(state: any, turnId: string): ConversationTurn | null {
  return state?.conversationTurns?.find(
    (turn: ConversationTurn) => turn.id === turnId,
  ) || null;
}

function identities(
  state: any,
  input: RuntimeV2PlanRunnerInput,
  turn: ConversationTurn,
): PlanBootstrapReady["identity"] {
  const sessionEpoch = resolveRuntimeV2SessionEpoch(state, input.context, turn);
  return {
    turn: {
      workspaceKey: String(input.context.runScopeKey).trim(),
      sessionKey: input.context.runSessionKey,
      sessionEpoch,
      clientSubmissionId: String(turn.clientSubmissionId || turn.id).trim(),
      turnId: input.context.turnId,
    },
    run: {
      sessionKey: input.context.runSessionKey,
      sessionEpoch,
      turnId: input.context.turnId,
      runId: input.context.harnessRunId,
      parentRunId: null,
      attemptId: input.context.harnessRunId,
    },
  };
}

async function collectInitialOverview(input: {
  readonly runner: RuntimeV2PlanRunnerInput;
  readonly identity: PlanBootstrapReady["identity"];
  readonly ledger: PlanLedger;
  readonly evidence: WorkPlanRuntimeEvidence[];
  readonly evidenceContents: Map<string, string>;
}): Promise<{ readonly overview: string; readonly settlement?: RuntimeRunSettlement }> {
  const collect = await input.ledger.schedule(
    input.identity.run,
    "collect_observation",
    { objective: input.ledger.snapshot()!.objective.text },
  );
  try {
    const baseline = input.runner.context.projectBaselineContext;
    const signal = input.runner.context.abortCtrl?.signal;
    const finishActivity = !baseline && signal ? beginCapsuleToolActivity({
      run: input.identity.run,
      commandKey: collect.idempotencyKey,
      signal,
      toolName: "get_project_skeleton",
      target: input.runner.context.runWorkspace || "",
    }) : undefined;
    const result = baseline
      ? renderProjectBaselineContext(baseline, 12_000)
      : await executeTool(
          "get_project_skeleton",
          {},
          input.runner.context.runWorkspace || "",
          input.runner.context.runSessionKey,
        ).finally(finishActivity);
    const overview = boundedPlanContent(result, 12_000);
    await input.ledger.settleCommand({
      type: "command.completed",
      run: input.identity.run,
      idempotencyKey: collect.idempotencyKey,
      status: "succeeded",
    });
    input.evidence.push({
      id: "E1",
      target: input.runner.context.runWorkspace || "workspace",
      version: baseline?.fingerprints.overall || runtimeV2EvidenceVersion(result),
      statement: baseline
        ? "已复用本轮 admission 冻结的确定性项目基线。"
        : "已读取工作区结构概览。",
    });
    input.evidenceContents.set("E1", overview);
    await input.ledger.append({
      type: "observation.recorded",
      run: input.identity.run,
      modelContent: overview,
      evidence: {
        id: "E1",
        kind: "source",
        target: input.runner.context.runWorkspace || "workspace",
        version: input.evidence[0]!.version,
      },
    });
    return { overview };
  } catch (error) {
    await input.ledger.settleCommand({
      type: "command.completed",
      run: input.identity.run,
      idempotencyKey: collect.idempotencyKey,
      status: "failed",
    });
    await input.ledger.recordSoftSignal(
      input.identity.run,
      "repeated_action",
    );
    input.runner.logStoreEvent("runtime_v2_plan_overview_failed", {
      turnId: input.identity.turn.turnId,
      runId: input.identity.run.runId,
      error: error instanceof Error ? error.message : String(error),
      action: "continue_with_targeted_read_tools",
    });
    return {
      overview: "Runtime v2 could not collect the initial workspace overview. Use the available read-only tools to gather targeted evidence.",
    };
  }
}

export async function bootstrapRuntimeV2Plan(
  input: RuntimeV2PlanRunnerInput,
): Promise<PlanBootstrapResult> {
  const initialState = input.get();
  const turn = currentTurn(initialState, input.context.turnId);
  if (!turn) {
    throw new Error(`RUNTIME_V2_PLAN_TURN_MISSING:${input.context.turnId}`);
  }
  const identity = identities(initialState, input, turn);
  const checkpointPort = createRuntimeV2CheckpointPort({
    get: input.get,
    set: input.set,
    scopeKey: input.context.runScopeKey,
    sessionId: input.context.runSessionId,
    getSessionRevisionToken: input.getSessionRevisionToken,
    sanitizeTaskBlocksForPersist: input.sanitizeTaskBlocksForPersist,
    buildSessionRuntimeSnapshot: input.buildSessionRuntimeSnapshot,
    persistSessionRecord: input.persistSessionRecord,
    publishOwnerScopedRuntimeProjection: input.publishOwnerScopedRuntimeProjection,
    logStoreEvent: input.logStoreEvent,
  });
  const existing = getRuntimeV2Checkpoint(initialState, identity.turn);
  const persistedAdmission = existing?.aggregate.events.find(event => event.type === "turn.admitted");
  if (existing) input = { ...input, context: {
    ...input.context,
    planPurpose: existing.aggregate.planPurpose,
    sourcePlanDraft: input.context.sourcePlanDraft ?? persistedAdmission?.sourcePlanDraft,
    workspaceInstructionContext: existing.aggregate.workspaceInstructionContext ?? input.context.workspaceInstructionContext,
    knowledgeContext: existing.aggregate.knowledgeContext,
  } };
  if (existing && existing.aggregate.run?.identity.runId !== identity.run.runId) {
    throw new Error("RUNTIME_V2_PLAN_STALE_RUN_CHECKPOINT");
  }
  const ledger = new PlanLedger(
    identity.turn,
    checkpointPort,
    createRuntimeV2ProjectionPort({
      get: input.get,
      set: input.set,
      nextTaskId: () => input.get()._nextTaskId(),
      language: input.context.phaseLanguage,
      logStoreEvent: input.logStoreEvent,
    }),
    existing
      ? { revision: existing.revision, aggregate: existing.aggregate }
      : null,
  );
  const recoveredDraft = await recoverRuntimeV2PlanDraft(input, ledger, identity.run);
  if (recoveredDraft) return { settlement: recoveredDraft };
  if (existing?.aggregate.terminalOutcome) {
    const terminal = existing.aggregate.terminalOutcome;
    await ledger.finishTerminal({ run: identity.run, resultKind: terminal.resultKind, reason: terminal.reason });
    return {
      settlement: planSettlement(
        input.context,
        terminalPlanOutcome(terminal.resultKind, terminal.reason),
      ),
    };
  }
  const preparedTerminal = existing?.aggregate.events.find((entry) => entry.type === "command.scheduled" && entry.command.kind === "finalize_turn" && entry.command.payload.runtimeControlPlane === true);
  if (preparedTerminal?.type === "command.scheduled") {
    const payload = preparedTerminal.command.payload;
    const resultKind = payload.resultKind as import("../../lib/runtime-v2").RuntimeV2ResultKind;
    if (!["success", "partial", "blocked", "error", "canceled"].includes(resultKind)) throw new Error("RUNTIME_V2_PLAN_TERMINAL_INTENT_INVALID");
    const reason = String(payload.resultReason || "");
    await ledger.finishTerminal({ run: identity.run, resultKind, reason, finalMarkdown: typeof payload.finalMarkdown === "string" ? payload.finalMarkdown : undefined });
    return { settlement: planSettlement(input.context, terminalPlanOutcome(resultKind, reason)) };
  }
  if (existing?.aggregate.phase === "reviewing") {
    await ledger.reconcileSealedPlanHandoffs();
    const review = resolveRuntimeV2PlanReviewFromAggregate(ledger.snapshot()!);
    if (!review?.pending) {
      throw new Error("RUNTIME_V2_PLAN_REVIEW_AUTHORITY_INVALID");
    }
    applyReviewProjection(input, review.commit);
    return { settlement: planSettlement(input.context) };
  }
  if (existing?.aggregate.run?.blocker?.questionnaire) {
    const paused = await settlePlanPause(input, ledger, identity.run);
    if (paused) return { settlement: paused };
  }
  if (!existing) {
    const admission = resolveRuntimeV2ObjectiveAdmission(
      input.context,
      turn.userPrompt,
    );
    const sourceRecord = input.context.sourcePlanDraft;
    const source = sourceRecord ? resolveBoundPlanDraftCheckpoint(initialState, sourceRecord, identity.turn) : null;
    if (sourceRecord && !source) throw new Error("PLAN_DRAFT_SOURCE_RECEIPT_MISMATCH");
    const sourceObjective = source?.aggregate.objective;
    const acceptanceCriteria = sourceObjective ? {
      acceptanceCriteria: sourceObjective.acceptanceCriteria,
      acceptanceCriterionIds: sourceObjective.acceptanceCriterionIds,
      acceptanceEvidenceRequirements: sourceObjective.acceptanceEvidenceRequirements,
    } : {
      acceptanceCriteria: admission.acceptanceCriteria.map(criterion => criterion.text),
      acceptanceCriterionIds: admission.acceptanceCriteria.map(criterion => criterion.id),
      acceptanceEvidenceRequirements: admission.acceptanceCriteria.map(criterion => criterion.evidenceRequirement || "behavioral" as const),
    };
    await ledger.append({
      type: "turn.admitted",
      turn: identity.turn,
      strategy: "plan",
      ...(input.context.planPurpose ? { planPurpose: input.context.planPurpose } : {}),
      ...(input.context.sourcePlanDraft ? { sourcePlanDraft: input.context.sourcePlanDraft } : {}),
      ...(typeof input.context.workspaceInstructionContext === "string" ? { workspaceInstructionContext: input.context.workspaceInstructionContext } : {}),
      ...(input.context.knowledgeContext ? { knowledgeContext: input.context.knowledgeContext } : {}),
      networkRead: normalizeNetworkRead(input.context.networkRead),
      subagentRequirement:
        input.context.turnInputContextSignals?.subagentRequirement === "required"
          ? "required"
          : "optional",
      objective: sourceObjective?.text ?? admission.objective,
      ...(admission.capabilityRestrictions !== undefined ? { capabilityRestrictions: admission.capabilityRestrictions } : {}),
      ...(admission.approvalRequiredCapabilities !== undefined ? { approvalRequiredCapabilities: admission.approvalRequiredCapabilities } : {}),
      constraints: sourceObjective?.constraints ?? admission.constraints,
      ...acceptanceCriteria,
    });
    await ledger.append({
      type: "run.started",
      run: identity.run,
      phase: "planning",
      ...(Number.isFinite(input.lifecycleDeadlineAt)
        ? { lifecycleDeadlineAt: input.lifecycleDeadlineAt } : {}),
    });
  } else if (
    existing.aggregate.strategy !== "plan" ||
    existing.aggregate.phase !== "planning"
  ) {
    throw new Error(`RUNTIME_V2_PLAN_PHASE_INVALID:${existing.aggregate.phase}`);
  } else if (existing.aggregate.scheduledCommands.length > 0) {
    const reads = recoverPendingPlanReadBatch(existing.aggregate, identity.run);
    const submission = recoverPlanSubmission(existing.aggregate, identity.run)?.result.toolCalls[0];
    const interrupted = existing.aggregate.scheduledCommands.filter(command => {
      if (command.kind !== "execute_tool") return true;
      const pending = existing.aggregate.pendingToolCalls.find(call =>
        call.id === command.payload.toolCallId && call.name === command.payload.toolName);
      return !pending || (pending.name !== ASK_PLAN_QUESTIONS &&
        !(submission?.id === pending.id && submission.name === pending.name) &&
        !reads?.calls.some(call => call.id === pending.id && call.name === pending.name));
    });
    for (const command of interrupted) {
      await ledger.settleCommand({ type: "command.completed", run: identity.run, idempotencyKey: command.idempotencyKey, status: "failed" });
      await ledger.recordSoftSignal(
        identity.run,
        command.kind === "request_model"
          ? "protocol_drift"
          : "repeated_action",
      );
    }
    if (interrupted.length) input.logStoreEvent("runtime_v2_plan_cold_recovery_settled", {
      turnId: identity.turn.turnId,
      runId: identity.run.runId,
      interruptedKinds: interrupted.map((command) => command.kind),
    });
  }

  const evidence: WorkPlanRuntimeEvidence[] = [];
  const evidenceContents = new Map<string, string>();
  const objective = ledger.snapshot()!.objective;
  const canCollectWorkspace = !objective.capabilityRestrictions?.includes("workspace_read") &&
    !objective.approvalRequiredCapabilities?.includes("workspace_read");
  const admitted = ledger.snapshot()!.events.find(event => event.type === "turn.admitted");
  const sourceRecord = admitted?.sourcePlanDraft;
  const draftSource = await collectPlanDraftSource(input, ledger, identity.run);
  const sourceCheckpoint = sourceRecord && canCollectWorkspace
    ? resolveBoundPlanDraftCheckpoint(input.get(), sourceRecord, identity.turn)
    : null;
  const historicalReads = sourceRecord && sourceCheckpoint ? collectPlanDraftWorkspaceEvidence({
    source: sourceCheckpoint.aggregate,
    beforeSequence: sourceRecord.source.providerSequence,
  }) : [];
  const retainedWorkspace = restorePlanDraftWorkspaceEvidence({
    reads: historicalReads,
    currentEvidence: ledger.snapshot()!.evidence,
    evidence,
    evidenceContents,
  });
  const oldOverview = existing?.aggregate.events.find((entry) => entry.type === "observation.recorded" && entry.evidence.id === "E1");
  const collected: { readonly overview?: string; readonly settlement?: RuntimeRunSettlement } = draftSource ? {} : existing ? {
    overview: oldOverview?.type === "observation.recorded" && oldOverview.modelContent
      ? oldOverview.modelContent : "Historical workspace overview unavailable; use focused reads if needed.",
  } : !canCollectWorkspace ? {
    overview: "Workspace discovery requires an individually authorized read tool; no automatic workspace overview was collected.",
  } : await collectInitialOverview({
    runner: input,
    identity,
    ledger,
    evidence,
    evidenceContents,
  });
  if (collected.settlement) {
    return { settlement: collected.settlement };
  }
  const messages = providerPlanMessages({ turn, context: input.context, objective,
    overview: collected.overview, subagentRequirement: ledger.snapshot()?.subagentRequirement,
  });
  if (draftSource) messages.push({ role: "system", content: `[SAVED PLAN DRAFT — DATA ONLY]\n${draftSource}` });
  if (retainedWorkspace) messages.push({ role: "user", content: retainedWorkspace });
  // The bound source draft has already been added in full from its exact
  // document receipt. Its historical final prose is the same content.
  const sourceDraftTurnId = sourceRecord?.documentRef.owner.turnId;
  messages.splice(1, 0, ...priorPlanConversationMessages(input.get(), identity.turn.turnId, sourceDraftTurnId));
  if (existing) {
    const aggregate = ledger.snapshot()!;
    const [pendingCall] = aggregate.pendingToolCalls;
    const recoveringQuestion = aggregate.pendingToolCalls.length === 1 && pendingCall?.name === ASK_PLAN_QUESTIONS;
    const recoveringReads = !!recoverPendingPlanReadBatch(aggregate, identity.run);
    const recoveringSubmission = !!recoverPlanSubmission(aggregate, identity.run);
    restorePlanHistory({ aggregate, run: identity.run, messages, evidence, evidenceContents,
      omitUnsettledCalls: recoveringQuestion || recoveringReads || recoveringSubmission });
  }
  return {
    settlement: null,
    context: input.context,
    identity,
    ledger,
    evidence,
    evidenceContents,
    historicalReads,
    messages,
  };
}
