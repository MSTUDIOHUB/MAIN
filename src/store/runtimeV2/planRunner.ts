import type { RuntimeRunSettlement } from "../../lib/runtimeRunSettlement";
import { WORK_PLAN_V1_SCHEMA_VERSION, isRuntimeV2ProviderTransportsUnavailableError, sealWorkPlanV1, type SealedWorkPlanV1 } from "../../lib/runtime-v2";
import { createRuntimeV2PlanReviewCommit, resolveRuntimeV2PlanReviewFromAggregate } from "./workPlanAdapter";
import { bootstrapRuntimeV2Plan } from "./planBootstrap";
import { executeReadOnlyPlanTool, settlePlanTool } from "./planEvidencePort";
import { requestPlanModel } from "./planProviderPort";
import { handleRuntimeV2PlanProviderAdmissionRejection } from "./planProviderAdmission";
import { requiredPlanCollaborationFailure, type RuntimeV2PlanTerminalFailure } from "./planRequirement";
import { handleRequiredPlanCollaborationProviderTimeout, requiredPlanCollaborationProviderTimeoutFailure, restoreRequiredPlanCollaborationProviderTimeoutGuidance } from "./planCollaborationAcquisition";
import { createRuntimeV2PlanCollaboration } from "./planCollaboration";
import { applyReviewProjection, planReference, publishReviewMilestone, writeReviewArtifact } from "./planReviewProjection";
import { PLAN_MODEL_COMPACTION_INTERVAL, PLAN_MODEL_DEADLINE_MS, SUBMIT_WORK_PLAN_TOOL_NAME, isPlanSubmissionStage, decodeStructuredPlanArguments, workPlanDraftFromSubmission, type PlanModelStage, type PlanProviderTransport } from "./planModelProtocol";
import { decodeExactStructuredPlanResponse } from "./workPlanSubmission";
import { runtimeV2ParallelReadCount } from "./executionText";
import { finishPlanTerminal, planSettlement as settlement, terminalPlanOutcome as terminalAgentOutcome } from "./planSettlement";
import type { RuntimeV2PlanRunnerInput } from "./planRunnerTypes";
import { assertAdmittedPlanCriteriaMapped, assertCompletedPlanChildrenAdopted } from "./planSubmissionPolicy";
import { createRuntimeV2PlanSubmissionLifecycle, recordRuntimeV2PlanSubmissionRejection } from "./planSubmissionRepair";
import { resolveRuntimeV2ObjectiveAdmission } from "./submissionContext";
export type { RuntimeV2PlanRunnerInput } from "./planRunnerTypes";
export async function runSubmitRuntimeV2Plan(
  input: RuntimeV2PlanRunnerInput,
): Promise<RuntimeRunSettlement> {
  const bootstrap = await bootstrapRuntimeV2Plan(input);
  if (bootstrap.settlement) return bootstrap.settlement;
  const { turn, identity, ledger, evidence, evidenceContents, messages } =
    bootstrap;
  const planLifecycle = createRuntimeV2PlanSubmissionLifecycle({
    ledger, run: identity.run, messages, lifecycleMs: PLAN_MODEL_DEADLINE_MS,
  });
  const initialLifecycle = planLifecycle.current();
  const originalDeadlineAt = initialLifecycle.originalDeadlineAt;
  const planCollaboration = createRuntimeV2PlanCollaboration({
    runner: input,
    ledger,
    run: identity.run,
    messages,
    evidence,
    evidenceContents,
    deadlineAt: originalDeadlineAt,
    logStoreEvent: input.logStoreEvent,
  });
  const admission = resolveRuntimeV2ObjectiveAdmission(input.context, turn.userPrompt);
  const admittedCriterionIds = admission.acceptanceCriteria.map((criterion) => criterion.id);
  try {
    let sealedPlan: SealedWorkPlanV1 | null = null;
    const initialCollaboration = planCollaboration.current().payload;
    if (initialCollaboration.collaborationRequired === true &&
      initialCollaboration.collaborationRequirementMet !== true) {
      restoreRequiredPlanCollaborationProviderTimeoutGuidance({
        aggregate: ledger.snapshot(), run: identity.run, messages,
      });
    }
    let terminalFailure: RuntimeV2PlanTerminalFailure | null =
      requiredPlanCollaborationProviderTimeoutFailure({
        aggregate: ledger.snapshot(), run: identity.run,
        collaborationRequired: initialCollaboration.collaborationRequired === true,
        collaborationRequirementMet: initialCollaboration.collaborationRequirementMet === true,
      });
    let round = 0;
    let stage: PlanModelStage = initialLifecycle.submissionRepairPending ? "synthesis" : "discovery";
    let synthesisTransport: PlanProviderTransport = "native_tool";
    let synthesisRecoveryCount = 0;
    let submissionRepairPending = initialLifecycle.submissionRepairPending;
    while (!sealedPlan && !terminalFailure) {
      if (input.context.abortCtrl.signal.aborted) throw new Error("RUNTIME_V2_PLAN_ABORTED");
      const lifecycle = planLifecycle.current();
      if (lifecycle.submissionRepairPending) {
        stage = "synthesis";
        submissionRepairPending = true;
      }
      const deadlineAt = lifecycle.effectiveDeadlineAt;
      if (Date.now() >= deadlineAt) {
        await ledger.recordSoftSignal(identity.run, "context_pressure");
        terminalFailure = {
          resultKind: evidence.length > 0 ? "partial" : "error",
          reason: "计划生成已到达运行时限；已保留现有证据并明确结束本轮，没有留下悬空任务。",
          detailCode: "runtime_v2_plan_deadline_reached",
        };
        break;
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
      let response: Awaited<ReturnType<typeof requestPlanModel>>;
      let effectiveTransport: PlanProviderTransport = "native_tool";
      let compactRecovery = false;
      let repeatedArgumentRejections = false;
      try {
        const collaboration = planCollaboration.current().payload;
        repeatedArgumentRejections = (ledger.snapshot()?.events || []).filter((entry) =>
          entry.type === "provider.responded" &&
          entry.result.diagnostics?.some((diagnostic) =>
            diagnostic.code === "tool_arguments_rejected"
          )
        ).length >= 2;
        compactRecovery = stage === "synthesis" &&
          ((!submissionRepairPending && synthesisRecoveryCount > 0) || repeatedArgumentRejections);
        effectiveTransport = compactRecovery
          ? "structured_response"
          : (stage === "synthesis" ? synthesisTransport : "native_tool");
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
          collaboration,
          submissionRepairPending,
          compactRecovery,
          transport: effectiveTransport,
          logStoreEvent: input.logStoreEvent,
        });
      } catch (error) {
        if (input.context.abortCtrl.signal.aborted) throw error;
        const detail = error instanceof Error ? error.message : String(error);
        const requirementFailure = requiredPlanCollaborationFailure({ error });
        if (requirementFailure) {
          terminalFailure = requirementFailure;
          break;
        }
        const acquisitionTimeout = await handleRequiredPlanCollaborationProviderTimeout({
          error, aggregate: ledger.snapshot(), run: identity.run,
          turnId: identity.turn.turnId,
          collaboration: planCollaboration.current().payload,
          ledger, messages, logStoreEvent: input.logStoreEvent,
        });
        if (acquisitionTimeout) {
          terminalFailure = acquisitionTimeout.terminalFailure;
          if (terminalFailure) break;
          stage = "discovery";
          synthesisTransport = "native_tool";
          continue;
        }
        if (isRuntimeV2ProviderTransportsUnavailableError(error)) {
          terminalFailure = {
            resultKind: evidence.length > 0 ? "partial" : "error",
            reason: "模型适配器确认当前没有可用的计划传输通道；已保留现有证据并明确结束本轮。",
            detailCode: "runtime_v2_plan_provider_transports_unavailable",
          };
          input.logStoreEvent("runtime_v2_plan_provider_unavailable", {
            turnId: identity.turn.turnId,
            runId: identity.run.runId,
            round,
            evidenceCount: evidence.length,
            stage,
            transport: isPlanSubmissionStage(stage)
              ? synthesisTransport
              : "native_tool",
            terminal: true,
            error: detail,
          });
          break;
        }
        await ledger.recordSoftSignal(identity.run, "protocol_drift");
        if (!isPlanSubmissionStage(stage)) {
          stage = "synthesis";
          synthesisRecoveryCount += 1;
          synthesisTransport = "structured_response";
          messages.push({
            role: "system",
            content: "The discovery request failed without proving the provider unavailable. Continue from retained evidence through the schema-constrained synthesis contract.",
          });
          input.logStoreEvent("runtime_v2_plan_provider_failed", {
            turnId: identity.turn.turnId,
            runId: identity.run.runId,
            round,
            canContinue: true,
            terminal: false,
            action: "switch_to_synthesis",
            from: "native_tool",
            to: synthesisTransport,
            error: detail,
          });
          continue;
        }
        const previousTransport: PlanProviderTransport = synthesisTransport;
        synthesisRecoveryCount += 1;
        synthesisTransport = previousTransport === "structured_response"
          ? "native_tool"
          : "structured_response";
        const timedOut =
          detail === "RUNTIME_V2_PLAN_PROVIDER_REQUEST_TIMEOUT";
        input.logStoreEvent(
          timedOut
            ? "runtime_v2_plan_synthesis_timeout"
            : "runtime_v2_plan_provider_transport_fallback",
          {
            turnId: identity.turn.turnId,
            runId: identity.run.runId,
            round,
            evidenceCount: evidence.length,
            stage: "synthesis",
            recoveryAttempt: synthesisRecoveryCount,
            from: previousTransport,
            to: synthesisTransport,
            terminal: false,
            action: "continue_with_alternate_transport",
            ...(timedOut
              ? {}
              : { reason: "provider_request_failure", error: detail }),
          },
        );
        continue;
      }
      if (await handleRuntimeV2PlanProviderAdmissionRejection({
        ledger, run: identity.run, response,
        collaboration: planCollaboration.current().payload,
        round, stage, logStoreEvent: input.logStoreEvent,
      })) {
        if (repeatedArgumentRejections) {
          terminalFailure = {
            resultKind: "error",
            reason: "WorkPlan 结构化恢复失败；未能生成有效的计划。",
            detailCode: "runtime_v2_plan_submission_transport_recovery_exhausted",
          };
          break;
        }
        continue;
      }
      if (response.toolCalls.length === 0) {
        if (planCollaboration.activeChildCount() > 0) {
          await planCollaboration.joinActive(
            "plan_parent_closed_action_while_children_active",
          );
          messages.push({
            role: "system",
            content: "The active planning child is now joined. Continue discovery from the delivered evidence, cite any adopted child evidence ID, or submit the complete WorkPlan.",
          });
          stage = "discovery";
          submissionRepairPending = false;
          continue;
        }
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
              evidenceCount: evidence.length,
            },
          );
          continue;
        }
        if (stage === "synthesis") {
          if (effectiveTransport === "structured_response") {
            const candidate = decodeExactStructuredPlanResponse(response.visibleText);
            if (candidate) {
              try {
                const compiled = workPlanDraftFromSubmission(
                  candidate,
                  evidence,
                  turn.userPrompt,
                  admittedCriterionIds,
                );
                const draft = compiled.draft;
                assertAdmittedPlanCriteriaMapped({
                  draft,
                  criterionIds: admittedCriterionIds,
                });
                assertCompletedPlanChildrenAdopted({
                  aggregate: ledger.snapshot(),
                  draft,
                  collaborationRequired: (ledger.snapshot()?.subagentRequirement ?? input.context.turnInputContextSignals?.subagentRequirement) === "required",
                });
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
                break;
              } catch (error) {
                const detail = error instanceof Error ? error.message : String(error);
                if (repeatedArgumentRejections) {
                  terminalFailure = {
                    resultKind: "error",
                    reason: `WorkPlan 结构化校验失败: ${detail}`,
                    detailCode: "runtime_v2_plan_submission_transport_recovery_exhausted",
                  };
                  break;
                }
              }
            }
            if (repeatedArgumentRejections) {
              terminalFailure = {
                resultKind: "error",
                reason: "WorkPlan 结构化恢复失败；未能生成有效的计划。",
                detailCode: "runtime_v2_plan_submission_transport_recovery_exhausted",
              };
              break;
            }
          }
          await ledger.recordSoftSignal(identity.run, "protocol_drift");
          const previousTransport: PlanProviderTransport = synthesisTransport;
          synthesisRecoveryCount += 1;
          synthesisTransport = previousTransport === "structured_response"
            ? "native_tool"
            : "structured_response";
          input.logStoreEvent("runtime_v2_plan_provider_transport_fallback", {
            turnId: identity.turn.turnId,
            runId: identity.run.runId,
            round,
            from: previousTransport,
            to: synthesisTransport,
            reason: "no_structured_action",
            terminal: false,
            action: "continue_with_alternate_transport",
          });
          continue;
        }
        messages.push({
          role: "system",
          content: "No structured action was received. Use one focused read-only tool, or submit the complete WorkPlan now.",
        });
        continue;
      }
      const submitCalls = response.toolCalls.filter((call) => call.name === SUBMIT_WORK_PLAN_TOOL_NAME);
      if (
        submitCalls.length === 1 &&
        response.toolCalls.length === 1
      ) {
        const call = submitCalls[0]!;
        if (planCollaboration.activeChildCount() > 0) {
          const joined = await planCollaboration.joinActive(
            "plan_submission_requires_joined_children",
          );
          await settlePlanTool({
            ledger,
            run: identity.run,
            call,
            status: "blocked",
          });
          messages.push({
            role: "tool",
            tool_call_id: call.id,
            content: joined
              ? `WORK_PLAN_REJECTED: active planning children were joined first. Review the delivered child evidence and cite any adopted exact ID in changes[].basis: ${evidence.filter((entry) => entry.id.startsWith("child:")).map((entry) => entry.id).join(", ") || "none"}. Then submit the complete plan again.`
              : "WORK_PLAN_REJECTED: active planning children could not be joined safely. Continue parent discovery without relying on unfinished child work.",
          });
          stage = joined ? "synthesis" : "discovery";
          submissionRepairPending = joined;
          continue;
        }
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
          if (repeatedArgumentRejections) {
            terminalFailure = {
              resultKind: "error",
              reason: "WorkPlan 结构化校验失败: submit arguments must be one JSON object.",
              detailCode: "runtime_v2_plan_submission_transport_recovery_exhausted",
            };
            break;
          }
          stage = "synthesis";
          submissionRepairPending = true;
          continue;
        }
        try {
          const compiled = workPlanDraftFromSubmission(
            candidate,
            evidence,
            turn.userPrompt,
            admittedCriterionIds,
          );
          const draft = compiled.draft;
          assertAdmittedPlanCriteriaMapped({
            draft,
            criterionIds: admittedCriterionIds,
          });
          assertCompletedPlanChildrenAdopted({
            aggregate: ledger.snapshot(),
            draft,
            collaborationRequired: (ledger.snapshot()?.subagentRequirement ?? input.context.turnInputContextSignals?.subagentRequirement) === "required",
          });
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
          await recordRuntimeV2PlanSubmissionRejection({
            ledger, run: identity.run, call, messages, detail,
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
          if (repeatedArgumentRejections) {
            terminalFailure = {
              resultKind: "error",
              reason: `WorkPlan 结构化校验失败: ${detail}`,
              detailCode: "runtime_v2_plan_submission_transport_recovery_exhausted",
            };
            break;
          }
          stage = "synthesis";
          submissionRepairPending = true;
          continue;
        }
      }
      const parallelReadCount = runtimeV2ParallelReadCount(
        response.toolCalls,
      );
      for (const call of response.toolCalls) {
        if (
          call.name === "spawn_subagent" ||
          call.name === "wait_subagents"
        ) {
          await planCollaboration.executeProviderCall(
            call,
            planCollaboration.current().decision,
          );
          continue;
        }
        await executeReadOnlyPlanTool({
          context: input.context,
          ledger,
          run: identity.run,
          call,
          messages,
          evidence,
          evidenceContents,
          parallelReadCount,
          logStoreEvent: input.logStoreEvent,
        });
      }
    }
    if (!sealedPlan) {
      if (!await planCollaboration.abortAndDrain("plan_terminal_boundary")) {
        throw new Error("RUNTIME_V2_PLAN_ACTIVE_CHILD_TERMINAL_FENCE");
      }
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
    if (planCollaboration.activeChildCount() > 0) {
      throw new Error("RUNTIME_V2_PLAN_ACTIVE_CHILD_REVIEW_FENCE");
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
    if (
      !aggregate.terminalOutcome &&
      !await planCollaboration.abortAndDrain(
        input.context.abortCtrl.signal.aborted
          ? "plan_parent_aborted"
          : "plan_parent_failure",
      )
    ) {
      throw error;
    }
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
    planCollaboration.abortChildren("runtime_v2_plan_runner_closed");
    clearInterval(input.context.timerInterval as ReturnType<typeof setInterval>);
  }
}
