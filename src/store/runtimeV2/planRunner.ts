import {
  abortedAgentLoopOutcome,
  completedAgentLoopOutcome,
  pausedAgentLoopOutcome,
  type AgentLoopOutcome,
} from "../../lib/runOutcome";
import type { RuntimeRunSettlement } from "../../lib/runtimeRunSettlement";
import { executeTool } from "../../lib/toolExecutor";
import {
  WORK_PLAN_V1_SCHEMA_VERSION,
  runtimeV2EvidenceVersion,
  runtimeV2ActionFingerprint,
  sealWorkPlanV1,
  type RuntimeV2NormalizedProviderResult,
  type RuntimeV2ResultKind,
  type RuntimeV2RunIdentity,
  type RuntimeV2TurnIdentity,
  type SealedWorkPlanV1,
  type WorkPlanRuntimeEvidence,
} from "../../lib/runtime-v2";
import type { ConversationTurn } from "../../lib/workflowModels";
import { getRuntimeV2Checkpoint, createRuntimeV2CheckpointPort } from "./checkpointPort";
import { createRuntimeV2ProjectionPort } from "./projectionPort";
import {
  createRuntimeV2PlanReviewCommit,
  resolveRuntimeV2PlanReviewFromAggregate,
} from "./workPlanAdapter";
import type { RuntimeV2SubmissionContext } from "./submissionContext";
import { PlanLedger } from "./planLedger";
import {
  executeReadOnlyPlanTool,
  settlePlanTool,
} from "./planEvidencePort";
import { requestPlanModel } from "./planProviderPort";
import {
  applyReviewProjection,
  planReference,
  publishReviewMilestone,
  writeReviewArtifact,
} from "./planReviewProjection";
import {
  PLAN_AUDIT_ACTION_BUDGET,
  PLAN_AUDIT_DISCOVERY_DEADLINE_MS,
  PLAN_DISCOVERY_ACTION_BUDGET,
  PLAN_DISCOVERY_DEADLINE_MS,
  PLAN_MODEL_COMPACTION_INTERVAL,
  PLAN_MODEL_DEADLINE_MS,
  SUBMIT_WORK_PLAN_TOOL_NAME,
  boundedPlanContent,
  isPlanSubmissionStage,
  decodeStructuredPlanArguments,
  providerPlanMessages,
  workPlanDraftFromSubmission,
  type PlanModelStage,
} from "./planModelProtocol";

type StoreGet = () => any;
type StoreSet = (patchOrUpdater: any) => void;

export interface RuntimeV2PlanRunnerInput {
  readonly get: StoreGet;
  readonly set: StoreSet;
  readonly context: RuntimeV2SubmissionContext;
  readonly getSessionRevisionToken: () => unknown;
  readonly sanitizeTaskBlocksForPersist: (blocks: any[]) => any[];
  readonly normalizeSessionRuntimeSnapshot: (snapshot: any) => unknown;
  readonly publishOwnerScopedRuntimeProjection: (input: {
    projectedState: any;
    durableState?: any;
    scopeKey: string;
    sessionId: number | string | null | undefined;
    expectedRevisionToken: unknown;
  }) => { published: boolean; disposition: string };
  readonly persistSessionRecord: (scopeKey: string, session: unknown) => Promise<unknown>;
  readonly logStoreEvent: (event: string, data?: Record<string, unknown>) => void;
}

function currentTurn(state: any, turnId: string): ConversationTurn | null {
  return state?.conversationTurns?.find((turn: ConversationTurn) => turn.id === turnId) || null;
}

function sessionEpochFor(state: any, context: RuntimeV2SubmissionContext, turn: ConversationTurn): string {
  const lifecycle = state?.planLifecycle;
  if (lifecycle?.sessionKey === context.runSessionKey && String(lifecycle.sessionEpoch || "").trim()) {
    return String(lifecycle.sessionEpoch).trim();
  }
  return `runtime-v2:${String(turn.clientSubmissionId || turn.id).trim()}`;
}

function identities(
  state: any,
  context: RuntimeV2SubmissionContext,
  turn: ConversationTurn,
): { readonly turn: RuntimeV2TurnIdentity; readonly run: RuntimeV2RunIdentity } {
  const sessionEpoch = sessionEpochFor(state, context, turn);
  return {
    turn: {
      workspaceKey: String(context.runWorkspace || "global").trim() || "global",
      sessionKey: context.runSessionKey,
      sessionEpoch,
      clientSubmissionId: String(turn.clientSubmissionId || turn.id).trim(),
      turnId: context.turnId,
    },
    run: {
      sessionKey: context.runSessionKey,
      sessionEpoch,
      turnId: context.turnId,
      runId: context.harnessRunId,
      parentRunId: null,
      attemptId: context.harnessRunId,
    },
  };
}

function settlement(
  context: RuntimeV2SubmissionContext,
  outcome: AgentLoopOutcome = pausedAgentLoopOutcome(
    "runtime_v2_plan_review_required",
    "action_required",
  ),
): RuntimeRunSettlement {
  return {
    disposition: "projected",
    reason: outcome.reason,
    identity: {
      sessionKey: context.runSessionKey,
      turnId: context.turnId,
      runId: context.harnessRunId,
      parentRunId: null,
      outerRunId: context.harnessRunId,
    },
    outcome,
  };
}

function terminalAgentOutcome(
  resultKind: RuntimeV2ResultKind,
  reason: string,
): AgentLoopOutcome {
  return resultKind === "canceled"
    ? abortedAgentLoopOutcome(reason)
    : completedAgentLoopOutcome(reason, resultKind);
}

async function finishPlanTerminal(input: {
  readonly runner: RuntimeV2PlanRunnerInput;
  readonly ledger: PlanLedger;
  readonly run: RuntimeV2RunIdentity;
  readonly resultKind: RuntimeV2ResultKind;
  readonly reason: string;
  readonly detailCode: string;
}): Promise<RuntimeRunSettlement> {
  await input.ledger.finishTerminal({
    run: input.run,
    resultKind: input.resultKind,
    reason: input.reason,
  });
  input.runner.logStoreEvent("runtime_v2_plan_terminal", {
    turnId: input.run.turnId,
    runId: input.run.runId,
    resultKind: input.resultKind,
    reason: input.reason,
    detailCode: input.detailCode,
    evidenceCount: input.ledger.snapshot()?.evidence.length || 0,
  });
  return settlement(
    input.runner.context,
    terminalAgentOutcome(input.resultKind, input.reason),
  );
}

export async function runSubmitRuntimeV2Plan(
  input: RuntimeV2PlanRunnerInput,
): Promise<RuntimeRunSettlement> {
  const initialState = input.get();
  const turn = currentTurn(initialState, input.context.turnId);
  if (!turn) throw new Error(`RUNTIME_V2_PLAN_TURN_MISSING:${input.context.turnId}`);
  const identity = identities(initialState, input.context, turn);
  const checkpointPort = createRuntimeV2CheckpointPort({
    get: input.get,
    set: input.set,
    scopeKey: input.context.runScopeKey,
    sessionId: input.context.runSessionId,
    getSessionRevisionToken: input.getSessionRevisionToken,
    sanitizeTaskBlocksForPersist: input.sanitizeTaskBlocksForPersist,
    normalizeSessionRuntimeSnapshot: input.normalizeSessionRuntimeSnapshot,
    persistSessionRecord: input.persistSessionRecord,
    publishOwnerScopedRuntimeProjection: input.publishOwnerScopedRuntimeProjection,
    logStoreEvent: input.logStoreEvent,
  });
  const existing = getRuntimeV2Checkpoint(initialState, identity.turn);
  if (existing && existing.aggregate.run?.identity.runId !== identity.run.runId) {
    throw new Error("RUNTIME_V2_PLAN_STALE_RUN_CHECKPOINT");
  }
  const projectionPort = createRuntimeV2ProjectionPort({
    get: input.get,
    set: input.set,
    nextTaskId: () => input.get()._nextTaskId(),
    language: input.context.phaseLanguage,
    logStoreEvent: input.logStoreEvent,
  });
  const ledger = new PlanLedger(
    identity.turn,
    checkpointPort,
    projectionPort,
    existing ? { revision: existing.revision, aggregate: existing.aggregate } : null,
  );

  try {
    if (existing?.aggregate.terminalOutcome) {
      const terminal = existing.aggregate.terminalOutcome;
      return settlement(
        input.context,
        terminalAgentOutcome(terminal.resultKind, terminal.reason),
      );
    }
    if (existing?.aggregate.phase === "reviewing") {
      const recoveredReview = resolveRuntimeV2PlanReviewFromAggregate(
        existing.aggregate,
      );
      if (!recoveredReview?.pending) {
        throw new Error("RUNTIME_V2_PLAN_REVIEW_AUTHORITY_INVALID");
      }
      applyReviewProjection(input, recoveredReview.commit);
      return settlement(input.context);
    }
    if (!existing) {
      await ledger.append({
        type: "turn.admitted",
        turn: identity.turn,
        strategy: "plan",
        objective: turn.userPrompt,
        constraints: [],
        acceptanceCriteria: [],
      });
      await ledger.append({
        type: "run.started",
        run: identity.run,
        phase: "planning",
      });
    } else if (
      existing.aggregate.strategy !== "plan" ||
      existing.aggregate.phase !== "planning"
    ) {
      throw new Error(`RUNTIME_V2_PLAN_PHASE_INVALID:${existing.aggregate.phase}`);
    } else if (existing.aggregate.scheduledCommands.length > 0) {
      const interrupted = [...existing.aggregate.scheduledCommands];
      await ledger.settleScheduled(identity.run, "failed");
      for (const command of interrupted) {
        const canContinue = await ledger.recordRecovery({
          run: identity.run,
          scope: command.kind === "request_model" ? "transport" : "action",
          fingerprint: `cold-recovery:${runtimeV2ActionFingerprint(command)}`,
          reason: "Plan Run 冷恢复时同一未结动作已超过安全重试预算。",
        });
        if (!canContinue) {
          return finishPlanTerminal({
            runner: input,
            ledger,
            run: identity.run,
            resultKind: "partial",
            reason: "计划生成在恢复未结动作时达到安全重试上限；已保留现有证据并明确结束本轮。",
            detailCode: "runtime_v2_plan_cold_recovery_exhausted",
          });
        }
      }
      input.logStoreEvent("runtime_v2_plan_cold_recovery_settled", {
        turnId: identity.turn.turnId,
        runId: identity.run.runId,
        interruptedKinds: interrupted.map((command) => command.kind),
      });
    }

    const evidence: WorkPlanRuntimeEvidence[] = [];
    const evidenceContents = new Map<string, string>();
    let overview = "";
    const collect = await ledger.schedule(identity.run, "collect_observation", {
      objective: turn.userPrompt,
    });
    try {
      const overviewResult = await executeTool(
        "get_project_skeleton",
        {},
        input.context.runWorkspace || "",
        input.context.runSessionKey,
      );
      overview = boundedPlanContent(overviewResult, 12_000);
      await ledger.append({
        type: "command.completed",
        run: identity.run,
        idempotencyKey: collect.idempotencyKey,
        status: "succeeded",
      });
      evidence.push({
        id: "E1",
        target: input.context.runWorkspace || "workspace",
        version: runtimeV2EvidenceVersion(overviewResult),
        statement: "已读取工作区结构概览。",
      });
      evidenceContents.set("E1", overview);
      await ledger.append({
        type: "observation.recorded",
        run: identity.run,
        evidence: {
          id: "E1",
          kind: "source",
          target: input.context.runWorkspace || "workspace",
          version: evidence[0]!.version,
        },
      });
    } catch (error) {
      await ledger.append({
        type: "command.completed",
        run: identity.run,
        idempotencyKey: collect.idempotencyKey,
        status: "failed",
      });
      overview = "Runtime v2 could not collect the initial workspace overview. Use the available read-only tools to gather targeted evidence.";
      const canContinue = await ledger.recordRecovery({
        run: identity.run,
        scope: "action",
        fingerprint: runtimeV2ActionFingerprint(collect),
        reason: "初始工作区概览持续读取失败。",
      });
      input.logStoreEvent("runtime_v2_plan_overview_failed", {
        turnId: identity.turn.turnId,
        runId: identity.run.runId,
        error: error instanceof Error ? error.message : String(error),
        action: "continue_with_targeted_read_tools",
      });
      if (!canContinue) {
        return finishPlanTerminal({
          runner: input,
          ledger,
          run: identity.run,
          resultKind: "error",
          reason: "无法读取工作区概览，且相同恢复动作已达到安全上限；本轮未生成待审核计划。",
          detailCode: "runtime_v2_plan_overview_recovery_exhausted",
        });
      }
    }

    const messages = providerPlanMessages({ turn, context: input.context, overview });
    const startedAt = Date.now();
    let sealedPlan: SealedWorkPlanV1 | null = null;
    let terminalFailure: {
      readonly resultKind: Extract<RuntimeV2ResultKind, "partial" | "error">;
      readonly reason: string;
      readonly detailCode: string;
    } | null = null;
    let round = 0;
    let discoveryActionCount = 0;
    let auditActionCount = 0;
    let auditDeadlineAt = Number.POSITIVE_INFINITY;
    let stage: PlanModelStage = "discovery";
    let synthesisRecoveryCount = 0;
    let auditSynthesisRecoveryCount = 0;
    const deadlineAt = startedAt + PLAN_MODEL_DEADLINE_MS;
    const discoveryDeadlineAt = startedAt + PLAN_DISCOVERY_DEADLINE_MS;
    planRounds:
    while (!sealedPlan && !terminalFailure) {
      if (input.context.abortCtrl.signal.aborted) throw new Error("RUNTIME_V2_PLAN_ABORTED");
      if (Date.now() >= deadlineAt) {
        await ledger.recordSoftSignal(identity.run, "context_pressure");
        await ledger.recordRecovery({
          run: identity.run,
          scope: "context",
          fingerprint: "plan:lifecycle-deadline",
          reason: "Plan Run 已达到限定生命周期。",
        });
        terminalFailure = {
          resultKind: evidence.length > 0 ? "partial" : "error",
          reason: "计划生成已到达运行时限；已保留现有证据并明确结束本轮，没有留下悬空任务。",
          detailCode: "runtime_v2_plan_deadline_reached",
        };
        break;
      }
      if (
        stage === "discovery" &&
        (
          discoveryActionCount >= PLAN_DISCOVERY_ACTION_BUDGET ||
          Date.now() >= discoveryDeadlineAt
        )
      ) {
        stage = "synthesis";
        const boundary = discoveryActionCount >= PLAN_DISCOVERY_ACTION_BUDGET
          ? "action_budget"
          : "time_budget";
        messages.push({
          role: "system",
          content: [
            "The runtime has closed the read-only discovery window.",
            "Use the evidence already returned and call submit_runtime_v2_work_plan now.",
            "No additional read tool is available in this synthesis stage.",
          ].join(" "),
        });
        input.logStoreEvent("runtime_v2_plan_synthesis_boundary", {
          turnId: identity.turn.turnId,
          runId: identity.run.runId,
          boundary,
          discoveryActionCount,
          evidenceCount: evidence.length,
        });
      }
      if (
        stage === "audit_discovery" &&
        (
          auditActionCount >= PLAN_AUDIT_ACTION_BUDGET ||
          Date.now() >= auditDeadlineAt
        )
      ) {
        const boundary = auditActionCount >= PLAN_AUDIT_ACTION_BUDGET
          ? "action_budget"
          : "time_budget";
        stage = "audit_synthesis";
        input.logStoreEvent("runtime_v2_plan_audit_discovery_boundary", {
          turnId: identity.turn.turnId,
          runId: identity.run.runId,
          boundary,
          auditActionCount,
          evidenceCount: evidence.length,
        });
      }
      if (round > 0 && round % PLAN_MODEL_COMPACTION_INTERVAL === 0) {
        await ledger.recordSoftSignal(identity.run, "iteration_limit");
        if (messages.length > 21) {
          messages.splice(3, messages.length - 21);
        }
        messages.push({
          role: "system",
          content: "The planning context was compacted at a soft pressure boundary. Continue from retained evidence; this signal is not a terminal decision.",
        });
        input.logStoreEvent("runtime_v2_plan_soft_round_signal", {
          turnId: identity.turn.turnId,
          runId: identity.run.runId,
          round,
          terminal: false,
          action: "compact_and_continue",
        });
      }
      round += 1;
      let response: RuntimeV2NormalizedProviderResult;
      try {
        response = await requestPlanModel({
          get: input.get,
          context: input.context,
          ledger,
          run: identity.run,
          messages,
          deadlineAt,
          stage,
          evidence,
          evidenceContents,
          compactRecovery: stage === "synthesis"
            ? synthesisRecoveryCount > 0
            : stage === "audit_synthesis"
            ? auditSynthesisRecoveryCount > 0
            : false,
          logStoreEvent: input.logStoreEvent,
        });
      } catch (error) {
        if (input.context.abortCtrl.signal.aborted) throw error;
        const detail = error instanceof Error ? error.message : String(error);
        if (
          isPlanSubmissionStage(stage) &&
          detail === "RUNTIME_V2_PLAN_PROVIDER_REQUEST_TIMEOUT"
        ) {
          const timedOutStage = stage === "audit_synthesis"
            ? "audit_synthesis"
            : "synthesis";
          const recoveryCount = stage === "audit_synthesis"
            ? auditSynthesisRecoveryCount
            : synthesisRecoveryCount;
          const canAttemptRecovery = recoveryCount < 1 &&
            Date.now() + 5_000 < deadlineAt &&
            await ledger.recordRecovery({
              run: identity.run,
              scope: "transport",
              fingerprint: `plan:${timedOutStage}:closed-request-timeout`,
              reason: `计划 ${timedOutStage} 的限定串行恢复已耗尽。`,
            });
          if (canAttemptRecovery) {
            if (stage === "audit_synthesis") {
              auditSynthesisRecoveryCount += 1;
            } else {
              synthesisRecoveryCount += 1;
            }
            input.logStoreEvent(`runtime_v2_plan_${timedOutStage}_timeout`, {
              turnId: identity.turn.turnId,
              runId: identity.run.runId,
              round,
              evidenceCount: evidence.length,
              stage: timedOutStage,
              recoveryAttempt: 1,
              action: "retry_after_closed_request_compact_context",
            });
            continue;
          }
          input.logStoreEvent(`runtime_v2_plan_${timedOutStage}_timeout`, {
            turnId: identity.turn.turnId,
            runId: identity.run.runId,
            round,
            evidenceCount: evidence.length,
            stage: timedOutStage,
            recoveryAttempt: recoveryCount,
            action: "terminal_after_bounded_retry",
          });
          terminalFailure = {
            resultKind: evidence.length > 0 ? "partial" : "error",
            reason: stage === "audit_synthesis"
              ? "计划证据审计及其一次串行恢复均达到限定时长；运行时已停止请求，现有证据和草案已保留。"
              : "计划合成及其一次串行恢复均达到限定时长；运行时已停止请求，现有证据已保留。",
            detailCode: `runtime_v2_plan_${timedOutStage}_timeout`,
          };
          break;
        }
        const canContinue = await ledger.recordRecovery({
          run: identity.run,
          scope: "transport",
          fingerprint: "plan:provider-request",
          reason: "计划模型传输连续失败，已耗尽限定恢复预算。",
        });
        input.logStoreEvent("runtime_v2_plan_provider_failed", {
          turnId: identity.turn.turnId,
          runId: identity.run.runId,
          round,
          canContinue,
          error: detail,
        });
        if (canContinue) {
          messages.push({
            role: "system",
            content: "The previous provider request failed at the transport boundary. Continue from the retained evidence and use one structured action.",
          });
          continue;
        }
        terminalFailure = {
          resultKind: evidence.length > 0 ? "partial" : "error",
          reason: "计划模型连接连续失败并达到恢复上限；已保留现有证据并明确结束本轮。",
          detailCode: "runtime_v2_plan_provider_recovery_exhausted",
        };
        break;
      }
      if (response.toolCalls.length === 0) {
        await ledger.recordSoftSignal(identity.run, response.visibleText?.trim()
          ? "no_tool_call"
          : "empty_response");
        const canContinue = await ledger.recordRecovery({
          run: identity.run,
          scope: "transport",
          fingerprint: "plan:provider-no-structured-action",
          reason: "计划模型连续未返回结构化动作，已耗尽限定恢复预算。",
        });
        messages.push({
          role: "system",
          content: stage === "audit_discovery"
            ? "No structured audit action was received. Use exactly one focused read-only tool."
            : "No structured action was received. Use one focused read-only tool, or submit the complete WorkPlan now.",
        });
        if (!canContinue) {
          terminalFailure = {
            resultKind: evidence.length > 0 ? "partial" : "error",
            reason: "模型连续未提供可执行的结构化计划动作；已保留证据并明确结束本轮。",
            detailCode: "runtime_v2_plan_no_action_recovery_exhausted",
          };
          break;
        }
        continue;
      }
      if (stage === "discovery") {
        discoveryActionCount += response.toolCalls.filter(
          (call) => call.name !== SUBMIT_WORK_PLAN_TOOL_NAME,
        ).length;
      } else if (stage === "audit_discovery") {
        auditActionCount += response.toolCalls.length;
      }
      const submitCalls = response.toolCalls.filter((call) => call.name === SUBMIT_WORK_PLAN_TOOL_NAME);
      if (stage === "audit_discovery" && submitCalls.length > 0) {
        for (const call of submitCalls) {
          await settlePlanTool({
            ledger,
            run: identity.run,
            call,
            status: "blocked",
          });
          messages.push({
            role: "tool",
            tool_call_id: call.id,
            content: "WORK_PLAN_AUDIT_READ_REQUIRED: use one offered read-only tool before the final audit submission boundary.",
          });
        }
        input.logStoreEvent("runtime_v2_plan_audit_early_submission_blocked", {
          turnId: identity.turn.turnId,
          runId: identity.run.runId,
          round,
          auditActionCount,
          submitCallCount: submitCalls.length,
        });
        for (const call of response.toolCalls.filter(
          (entry) => entry.name !== SUBMIT_WORK_PLAN_TOOL_NAME,
        )) {
          const canContinue = await executeReadOnlyPlanTool({
            context: input.context,
            ledger,
            run: identity.run,
            call,
            messages,
            evidence,
            evidenceContents,
            logStoreEvent: input.logStoreEvent,
          });
          if (!canContinue) {
            terminalFailure = {
              resultKind: evidence.length > 0 ? "partial" : "error",
              reason: "计划审计中的同一只读动作连续失败；已保留证据并明确结束本轮。",
              detailCode: "runtime_v2_plan_audit_read_recovery_exhausted",
            };
            break planRounds;
          }
        }
        continue;
      }
      if (
        stage !== "audit_discovery" &&
        submitCalls.length === 1 &&
        response.toolCalls.length === 1
      ) {
        const call = submitCalls[0]!;
        const candidate = decodeStructuredPlanArguments(call.arguments);
        if (!candidate) {
          await settlePlanTool({ ledger, run: identity.run, call, status: "failed" });
          messages.push({
            role: "tool",
            tool_call_id: call.id,
            content: "WORK_PLAN_REJECTED: submit arguments must be one JSON object.",
          });
          input.logStoreEvent("runtime_v2_plan_submission_rejected", {
            turnId: identity.turn.turnId,
            runId: identity.run.runId,
            round,
            detail: "submit arguments must be one JSON object",
            submissionChars: String(call.arguments || "").length,
          });
          const canContinue = await ledger.recordRecovery({
            run: identity.run,
            scope: "diagnostic",
            fingerprint: "plan:invalid-work-plan-submission",
            reason: "模型连续提交无效 WorkPlan，已耗尽限定修正预算。",
          });
          if (!canContinue) {
            terminalFailure = {
              resultKind: evidence.length > 0 ? "partial" : "error",
              reason: "模型连续提交无法验证的计划结构；已保留证据并明确结束本轮。",
              detailCode: "runtime_v2_plan_invalid_submission_exhausted",
            };
            break;
          }
          continue;
        }
        try {
          const compiled = workPlanDraftFromSubmission(
            candidate,
            evidence,
            turn.userPrompt,
          );
          const draft = compiled.draft;
          if (compiled.normalized) {
            input.logStoreEvent("runtime_v2_plan_submission_normalized", {
              turnId: identity.turn.turnId,
              runId: identity.run.runId,
              round,
              evidenceCount: evidence.length,
              stepCount: draft.steps.length,
              validationCount: draft.validations.length,
              reasons: compiled.normalizationReasons,
            });
          }
          const reviewedPlan = sealWorkPlanV1({
            draft,
            evidence,
            createdAt: Date.now(),
          });
          if (stage === "discovery" || stage === "synthesis") {
            await settlePlanTool({
              ledger,
              run: identity.run,
              call,
              status: "succeeded",
            });
            messages.push({
              role: "tool",
              tool_call_id: call.id,
              content: [
                "WORK_PLAN_DRAFT_ACCEPTED_FOR_AUDIT.",
                "This draft is structurally valid but is not approval authority.",
                "Audit every reported symptom against the retained evidence and submit one corrected final plan.",
              ].join(" "),
            });
            stage = "audit_discovery";
            auditActionCount = 0;
            auditDeadlineAt = Math.min(
              deadlineAt,
              Date.now() + PLAN_AUDIT_DISCOVERY_DEADLINE_MS,
            );
            input.logStoreEvent("runtime_v2_plan_evidence_audit_started", {
              turnId: identity.turn.turnId,
              runId: identity.run.runId,
              round,
              evidenceCount: evidence.length,
              stepCount: draft.steps.length,
              validationCount: draft.validations.length,
              auditActionBudget: PLAN_AUDIT_ACTION_BUDGET,
            });
            continue;
          }
          sealedPlan = reviewedPlan;
          await settlePlanTool({
            ledger,
            run: identity.run,
            call,
            status: "succeeded",
            evidence: [{
              id: `work-plan:${sealedPlan.id}:${sealedPlan.revision}`,
              kind: "tool",
              target: WORK_PLAN_V1_SCHEMA_VERSION,
              version: sealedPlan.digest,
            }],
          });
          break;
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          await settlePlanTool({ ledger, run: identity.run, call, status: "failed" });
          messages.push({
            role: "tool",
            tool_call_id: call.id,
            content: `WORK_PLAN_REJECTED: ${detail}`.slice(0, 4_000),
          });
          input.logStoreEvent("runtime_v2_plan_submission_rejected", {
            turnId: identity.turn.turnId,
            runId: identity.run.runId,
            round,
            detail,
            evidenceIds: evidence.map((entry) => entry.id),
            submissionChars: JSON.stringify(candidate).length,
          });
          const canContinue = await ledger.recordRecovery({
            run: identity.run,
            scope: "diagnostic",
            fingerprint: "plan:invalid-work-plan-submission",
            reason: "模型连续提交无效 WorkPlan，已耗尽限定修正预算。",
          });
          if (!canContinue) {
            terminalFailure = {
              resultKind: evidence.length > 0 ? "partial" : "error",
              reason: "模型连续提交无法验证的计划结构；已保留证据并明确结束本轮。",
              detailCode: "runtime_v2_plan_invalid_submission_exhausted",
            };
            break;
          }
          continue;
        }
      }
      for (const call of response.toolCalls) {
        const canContinue = await executeReadOnlyPlanTool({
          context: input.context,
          ledger,
          run: identity.run,
          call,
          messages,
          evidence,
          evidenceContents,
          logStoreEvent: input.logStoreEvent,
        });
        if (!canContinue) {
          terminalFailure = {
            resultKind: evidence.length > 0 ? "partial" : "error",
            reason: "计划调查中的同一工具动作连续失败；已保留证据并明确结束本轮。",
            detailCode: "runtime_v2_plan_read_recovery_exhausted",
          };
          break planRounds;
        }
      }
    }
    if (!sealedPlan) {
      if (!terminalFailure) throw new Error("RUNTIME_V2_PLAN_TERMINAL_DECISION_MISSING");
      input.logStoreEvent("runtime_v2_plan_review_not_produced", {
        turnId: identity.turn.turnId,
        runId: identity.run.runId,
        evidenceCount: evidence.length,
        terminal: true,
        detailCode: terminalFailure.detailCode,
      });
      return finishPlanTerminal({
        runner: input,
        ledger,
        run: identity.run,
        ...terminalFailure,
      });
    }

    const requestId = [
      "runtime-v2-plan-review",
      identity.run.runId,
      sealedPlan.id,
      sealedPlan.revision,
      sealedPlan.projectionHash.slice(-16),
    ].join(":");
    const commit = createRuntimeV2PlanReviewCommit({
      plan: sealedPlan,
      turn: identity.turn,
      run: identity.run,
      requestId,
      createdAt: Date.now(),
    });
    await writeReviewArtifact({
      context: input.context,
      ledger,
      run: identity.run,
      plan: sealedPlan,
    });
    await ledger.append({
      type: "work_plan.sealed",
      run: identity.run,
      workPlan: planReference(sealedPlan),
      sealedPlan,
      reviewCommit: commit,
    });
    await publishReviewMilestone({
      ledger,
      commit,
    });
    // Expose the approval control only after every ReviewCommit projection is
    // durably appended, so a fast click cannot race the milestone checkpoint.
    applyReviewProjection(input, commit);
    input.logStoreEvent("runtime_v2_plan_review_committed", {
      turnId: identity.turn.turnId,
      runId: identity.run.runId,
      requestId: commit.review.requestId,
      workPlanId: commit.authority.id,
      revision: commit.authority.revision,
      digest: commit.authority.digest,
      projectionHash: commit.authority.projectionHash,
    });
    return settlement(input.context);
  } catch (error) {
    const aggregate = ledger.snapshot();
    if (!aggregate?.run || aggregate.phase === "acting") throw error;
    if (aggregate.terminalOutcome) {
      return settlement(
        input.context,
        terminalAgentOutcome(
          aggregate.terminalOutcome.resultKind,
          aggregate.terminalOutcome.reason,
        ),
      );
    }
    const recoveredReview = resolveRuntimeV2PlanReviewFromAggregate(aggregate);
    if (recoveredReview?.pending) {
      applyReviewProjection(input, recoveredReview.commit);
      return settlement(input.context);
    }
    if (input.context.abortCtrl.signal.aborted) {
      return finishPlanTerminal({
        runner: input,
        ledger,
        run: identity.run,
        resultKind: "canceled",
        reason: "用户已停止计划生成；已保留此前收集的证据并结束本轮。",
        detailCode: "runtime_v2_plan_aborted",
      });
    }
    const detail = error instanceof Error ? error.message : String(error);
    await ledger.recordRecovery({
      run: identity.run,
      scope: "action",
      fingerprint: `plan:unhandled:${detail.split(":")[0]?.slice(0, 160) || "unknown"}`,
      reason: "Plan Run 遇到无法继续恢复的运行时错误。",
    });
    input.logStoreEvent("runtime_v2_plan_unhandled_failure", {
      turnId: identity.turn.turnId,
      runId: identity.run.runId,
      error: detail,
    });
    return finishPlanTerminal({
      runner: input,
      ledger,
      run: identity.run,
      resultKind: aggregate.evidence.length > 0 ? "partial" : "error",
      reason: "计划生成遇到运行时错误；已保留现有证据并明确结束本轮，没有留下悬空任务。",
      detailCode: "runtime_v2_plan_unhandled_failure",
    });
  } finally {
    clearInterval(input.context.timerInterval as ReturnType<typeof setInterval>);
  }
}
