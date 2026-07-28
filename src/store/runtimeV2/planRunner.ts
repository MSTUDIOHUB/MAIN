import type { RuntimeRunSettlement } from "../../lib/runtimeRunSettlement";
import {
  WORK_PLAN_V1_SCHEMA_VERSION,
  sealWorkPlanV1,
  type RuntimeV2NormalizedProviderResult,
  type RuntimeV2ResultKind,
  type SealedWorkPlanV1,
} from "../../lib/runtime-v2";
import {
  createRuntimeV2PlanReviewCommit,
  resolveRuntimeV2PlanReviewFromAggregate,
} from "./workPlanAdapter";
import { bootstrapRuntimeV2Plan } from "./planBootstrap";
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
  PLAN_DISCOVERY_ACTION_BUDGET,
  PLAN_DISCOVERY_DEADLINE_MS,
  PLAN_MODEL_COMPACTION_INTERVAL,
  PLAN_MODEL_DEADLINE_MS,
  SUBMIT_WORK_PLAN_TOOL_NAME,
  isPlanSubmissionStage,
  decodeStructuredPlanArguments,
  workPlanDraftFromSubmission,
  type PlanModelStage,
  type PlanProviderTransport,
} from "./planModelProtocol";
import {
  finishPlanTerminal,
  planSettlement as settlement,
  terminalPlanOutcome as terminalAgentOutcome,
} from "./planSettlement";
import type { RuntimeV2PlanRunnerInput } from "./planRunnerTypes";

export type { RuntimeV2PlanRunnerInput } from "./planRunnerTypes";

export async function runSubmitRuntimeV2Plan(
  input: RuntimeV2PlanRunnerInput,
): Promise<RuntimeRunSettlement> {
  const bootstrap = await bootstrapRuntimeV2Plan(input);
  if (bootstrap.settlement) return bootstrap.settlement;
  const {
    turn,
    identity,
    ledger,
    evidence,
    evidenceContents,
    messages,
  } = bootstrap;

  try {
    const startedAt = Date.now();
    let sealedPlan: SealedWorkPlanV1 | null = null;
    let terminalFailure: {
      readonly resultKind: Extract<RuntimeV2ResultKind, "partial" | "error">;
      readonly reason: string;
      readonly detailCode: string;
    } | null = null;
    let round = 0;
    let discoveryActionCount = 0;
    let stage: PlanModelStage = "discovery";
    let synthesisTransport: PlanProviderTransport = "native_tool";
    let synthesisRecoveryCount = 0;
    const deadlineAt = startedAt + PLAN_MODEL_DEADLINE_MS;
    const discoveryDeadlineAt = startedAt + PLAN_DISCOVERY_DEADLINE_MS;
    while (!sealedPlan && !terminalFailure) {
      if (input.context.abortCtrl.signal.aborted) throw new Error("RUNTIME_V2_PLAN_ABORTED");
      if (Date.now() >= deadlineAt) {
        await ledger.recordSoftSignal(identity.run, "context_pressure");
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
          compactRecovery:
            stage === "synthesis" && synthesisRecoveryCount > 0,
          transport: stage === "synthesis"
            ? synthesisTransport
            : "native_tool",
          logStoreEvent: input.logStoreEvent,
        });
      } catch (error) {
        if (input.context.abortCtrl.signal.aborted) throw error;
        const detail = error instanceof Error ? error.message : String(error);
        if (
          isPlanSubmissionStage(stage) &&
          detail === "RUNTIME_V2_PLAN_PROVIDER_REQUEST_TIMEOUT"
        ) {
          await ledger.recordSoftSignal(identity.run, "protocol_drift");
          if (
            synthesisTransport === "native_tool" &&
            Date.now() + 5_000 < deadlineAt
          ) {
            synthesisRecoveryCount += 1;
            synthesisTransport = "structured_response";
            input.logStoreEvent("runtime_v2_plan_synthesis_timeout", {
              turnId: identity.turn.turnId,
              runId: identity.run.runId,
              round,
              evidenceCount: evidence.length,
              stage: "synthesis",
              recoveryAttempt: 1,
              from: "native_tool",
              to: "structured_response",
              action: "fallback_to_compatible_transport",
            });
            continue;
          }
          input.logStoreEvent("runtime_v2_plan_synthesis_timeout", {
            turnId: identity.turn.turnId,
            runId: identity.run.runId,
            round,
            evidenceCount: evidence.length,
            stage: "synthesis",
            recoveryAttempt: synthesisRecoveryCount,
            transport: synthesisTransport,
            action: "terminal_after_compatible_transports_unavailable",
          });
          terminalFailure = {
            resultKind: evidence.length > 0 ? "partial" : "error",
            reason: "计划合成的原生工具与结构化响应通道均不可用；运行时已停止请求，现有证据已保留。",
            detailCode: "runtime_v2_plan_synthesis_timeout",
          };
          break;
        }
        if (isPlanSubmissionStage(stage)) {
          await ledger.recordSoftSignal(identity.run, "protocol_drift");
          if (synthesisTransport === "native_tool") {
            synthesisRecoveryCount += 1;
            synthesisTransport = "structured_response";
            messages.push({
              role: "system",
              content: "The native submission transport failed. Submit the same evidence-bound plan through the schema-constrained response transport.",
            });
            input.logStoreEvent("runtime_v2_plan_provider_transport_fallback", {
              turnId: identity.turn.turnId,
              runId: identity.run.runId,
              round,
              from: "native_tool",
              to: "structured_response",
              reason: "transport_failure",
              error: detail,
            });
            continue;
          }
          terminalFailure = {
            resultKind: evidence.length > 0 ? "partial" : "error",
            reason: "计划合成的原生工具与结构化响应通道均不可用；已保留现有证据并明确结束本轮。",
            detailCode: "runtime_v2_plan_transport_variants_exhausted",
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
        if (stage === "discovery") {
          stage = "synthesis";
          messages.push({
            role: "system",
            content: [
              "Discovery narration is not a terminal result.",
              "Continue from retained evidence and submit the complete WorkPlan through the structured synthesis contract.",
            ].join(" "),
          });
          input.logStoreEvent(
            "runtime_v2_plan_synthesis_boundary",
            {
              turnId: identity.turn.turnId,
              runId: identity.run.runId,
              boundary: "provider_no_action",
              discoveryActionCount,
              evidenceCount: evidence.length,
            },
          );
          continue;
        }
        if (
          stage === "synthesis" &&
          synthesisTransport === "native_tool"
        ) {
          await ledger.recordSoftSignal(identity.run, "protocol_drift");
          synthesisRecoveryCount += 1;
          synthesisTransport = "structured_response";
          input.logStoreEvent("runtime_v2_plan_provider_transport_fallback", {
            turnId: identity.turn.turnId,
            runId: identity.run.runId,
            round,
            from: "native_tool",
            to: "structured_response",
            reason: "no_structured_action",
          });
          continue;
        }
        if (
          stage === "synthesis" &&
          synthesisTransport === "structured_response"
        ) {
          terminalFailure = {
            resultKind: evidence.length > 0 ? "partial" : "error",
            reason: "原生工具和结构化响应两种计划提交协议均未产生可验证动作；已保留证据并明确结束本轮。",
            detailCode: "runtime_v2_plan_transport_variants_exhausted",
          };
          break;
        }
        messages.push({
          role: "system",
          content: "No structured action was received. Use one focused read-only tool, or submit the complete WorkPlan now.",
        });
        continue;
      }
      if (stage === "discovery") {
        discoveryActionCount += response.toolCalls.filter(
          (call) => call.name !== SUBMIT_WORK_PLAN_TOOL_NAME,
        ).length;
      }
      const submitCalls = response.toolCalls.filter((call) => call.name === SUBMIT_WORK_PLAN_TOOL_NAME);
      if (
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
          await ledger.recordSoftSignal(
            identity.run,
            "protocol_drift",
          );
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
          await ledger.recordSoftSignal(
            identity.run,
            "protocol_drift",
          );
          continue;
        }
      }
      for (const call of response.toolCalls) {
        await executeReadOnlyPlanTool({
          context: input.context,
          ledger,
          run: identity.run,
          call,
          messages,
          evidence,
          evidenceContents,
          logStoreEvent: input.logStoreEvent,
        });
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
    await ledger.recordSoftSignal(identity.run, "protocol_drift");
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
