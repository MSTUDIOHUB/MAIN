import { buildPlanDecisionJournal } from "../../lib/planDecisionJournal";
import type { RuntimeRunSettlement } from "../../lib/runtimeRunSettlement";
import { WORK_PLAN_V1_SCHEMA_VERSION, isRuntimeV2ProviderTransportsUnavailableError, type RuntimeV2NormalizedProviderResult, type SealedWorkPlanV1 } from "../../lib/runtime-v2";
import { bootstrapRuntimeV2Plan } from "./planBootstrap";
import { executeReadOnlyPlanTool, settlePlanTool } from "./planEvidencePort";
import { requestPlanModel } from "./planProviderPort";
import { handleRuntimeV2PlanProviderAdmissionRejection } from "./planProviderAdmission";
import { requiredPlanCollaborationFailure, type RuntimeV2PlanTerminalFailure } from "./planRequirement";
import { handleRequiredPlanCollaborationProviderTimeout, requiredPlanCollaborationProviderTimeoutFailure, restoreRequiredPlanCollaborationProviderTimeoutGuidance } from "./planCollaborationAcquisition";
import { createRuntimeV2PlanCollaboration } from "./planCollaboration";
import { completeRuntimeV2Plan, recoverRuntimeV2PlanFailure, settleRuntimeV2PlanCompletion } from "./planCompletion";
import { SUBMIT_WORK_PLAN_TOOL_NAME, isPlanSubmissionStage, decodeStructuredPlanArguments, type PlanModelStage, type PlanProviderTransport } from "./planModelProtocol";
import { runtimeV2ParallelReadCount } from "./executionText";
import type { RuntimeV2PlanRunnerInput } from "./planRunnerTypes";
import { assessPlanSubmission } from "./planSubmissionAssessment";
import { saveRuntimeV2PlanDraft } from "./planDraftRunner";
import { createRuntimeV2PlanSubmissionLifecycle, recordRuntimeV2PlanSubmissionRejection, recoverPlanSubmission } from "./planSubmissionRepair";
import { deriveReadOnlyRecoveryWindow } from "../../lib/runtime-v2/readOnlyProgress";
import { isRuntimeV2LifecycleDeadlineError, runtimeV2ProviderRecoveryStallExpired } from "../../lib/runtime-v2/lifecycle";
import { upsertRuntimeV2ContextAnchor } from "./executionProviderHistory";
import { runRuntimeV2PlanInterview } from "./planInterview";
import { handlePlanQuestionTool, recoverPlanQuestion } from "./planQuestionControl";
import { ASK_PLAN_QUESTIONS, hasExecutablePlanChoice } from "./planQuestionTool";
import { hashPlanDraftCandidate } from "../../lib/planDrafts";
import { recoverPendingPlanReadBatch, replayPendingPlanReadBatch } from "./planReadRecovery";
import { isPlanStreamRepetition, planRepetitionRecovery, restorePlanSynthesisTransport } from "./planRepetitionRecovery";
import { planValidationRecovery } from "./planValidationRecovery";
export type { RuntimeV2PlanRunnerInput } from "./planRunnerTypes";

function truncatedBeforePlanAction(result: RuntimeV2NormalizedProviderResult): boolean {
  return !result.toolCalls.length && !result.visibleText?.trim() && result.diagnostics.some(item => item.code === "output_truncated");
}

export async function runSubmitRuntimeV2Plan(
  input: RuntimeV2PlanRunnerInput,
): Promise<RuntimeRunSettlement> {
  const interview = await runRuntimeV2PlanInterview(input);
  if (interview) return interview;
  const bootstrap = await bootstrapRuntimeV2Plan(input);
  if (bootstrap.settlement) return bootstrap.settlement;
  input = { ...input, context: bootstrap.context };
  const { identity, ledger, evidence, evidenceContents, messages } =
    bootstrap;
  const planLifecycle = createRuntimeV2PlanSubmissionLifecycle({
    ledger, run: identity.run, messages,
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
  const objective = ledger.snapshot()!.objective;
  const executablePlanSelected = hasExecutablePlanChoice(ledger.snapshot()!);
  const admittedCriterionIds = objective.acceptanceCriteria.map((_, index) =>
    objective.acceptanceCriterionIds?.[index] || `criterion-${index + 1}`,
  );
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
    const priorEvents = ledger.snapshot()?.events || [];
    const lastResponse = [...priorEvents].reverse().find(entry => entry.type === "provider.responded" && entry.run.runId === identity.run.runId);
    let recoveredQuestion = recoverPlanQuestion(ledger.snapshot()!, identity.run);
    let recoveredReads = recoverPendingPlanReadBatch(ledger.snapshot()!, identity.run);
    let recoveredSubmission = recoverPlanSubmission(ledger.snapshot()!, identity.run, !executablePlanSelected);
    const priorRequest = [...priorEvents].reverse().find((entry) => entry.type === "command.scheduled" && entry.command.kind === "request_model" && entry.run.runId === identity.run.runId);
    const priorPayload = priorRequest?.type === "command.scheduled" ? priorRequest.command.payload : {};
    const restoreBoundedOutput = priorPayload.compactRecovery !== true && lastResponse?.type === "provider.responded" && truncatedBeforePlanAction(lastResponse.result);
    let stage: PlanModelStage = initialLifecycle.submissionRepairPending || priorPayload.stage === "synthesis" || restoreBoundedOutput ? "synthesis" : "discovery";
    let compactRecoveryStarted = priorPayload.compactRecovery === true || restoreBoundedOutput;
    let synthesisRecoveryCount = compactRecoveryStarted ? 1 : 0;
    let { transport: synthesisTransport, explicitFallback } =
      restorePlanSynthesisTransport(priorEvents, priorRequest, compactRecoveryStarted, restoreBoundedOutput);
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
          resultKind: "error",
          reason: "计划生成已到达调用方明确指定的截止时间；尚未生成可供审核的计划。",
          detailCode: "runtime_v2_plan_deadline_reached",
        };
        break;
      }
      if (recoveredReads) {
        await replayPendingPlanReadBatch(recoveredReads, {
          context: input.context, ledger, run: identity.run, messages, evidence, evidenceContents,
          ...(executablePlanSelected ? { reuseRetainedRead: { historicalReads: bootstrap.historicalReads } } : {}),
          logStoreEvent: input.logStoreEvent,
        });
        recoveredReads = null;
        continue;
      }
      const recovery = deriveReadOnlyRecoveryWindow(ledger.snapshot()!, {
        finalTextIsProgress: false,
      });
      const repetition = planRepetitionRecovery(ledger.snapshot()!, identity.run, recovery?.startedSequence);
      const validation = executablePlanSelected ? planValidationRecovery(ledger.snapshot()!, identity.run, recovery?.startedSequence) : null;
      const validationRepair = validation?.kind === "repair" ? validation : undefined;
      const recoveryExpired = recovery && runtimeV2ProviderRecoveryStallExpired({
        startedAt: recovery.startedAt, reason: recovery.pressure.reason,
        latestOccurrence: recovery.pressure.occurrence,
      }, Date.now());
      if ((recoveryExpired || repetition?.kind === "exhausted") && planCollaboration.activeChildCount() > 0) {
        await planCollaboration.joinActive("plan_recovery_waits_for_active_children");
        continue;
      }
      if (repetition?.kind === "exhausted" || validation?.kind === "exhausted") {
        terminalFailure = {
          resultKind: "error",
          reason: validation?.kind === "exhausted" ? "模型反复提交同一未通过验收的候选，定向修复仍未得到可审阅的计划。" : "模型重复输出后，备用请求方式仍未能提交计划或推进调查。本轮已结束，尚未生成可供审核的计划。",
          detailCode: validation?.kind === "exhausted" ? "runtime_v2_plan_validation_repair_exhausted" : "runtime_v2_plan_repetition_recovery_exhausted",
        };
        break;
      }
      if (recovery) upsertRuntimeV2ContextAnchor(planCollaboration.live, {
        key: "plan-recovery",
        content: `The last request did not add new evidence or a valid WorkPlan (${recovery.pressure.reason}). Name one concrete missing path, range or fact before another read; otherwise submit the plan from retained evidence. Cached or unchanged results are not progress.`,
      });
      else {
        const index = messages.findIndex((message) => message.role === "system" && String(message.content).startsWith("[runtime-v2 context: plan-recovery]"));
        if (index >= 0) messages.splice(index, 1);
      }
      round += 1;
      let response: Awaited<ReturnType<typeof requestPlanModel>>;
      let effectiveTransport: PlanProviderTransport = "native_tool";
      let compactRecovery = false;
      let repeatedArgumentRejections = false;
      const questionReceiptAlreadySettled = recoveredQuestion?.settled;
      const draftOnlyRecovery = recoveredSubmission?.draftOnly;
      try {
        const collaboration = planCollaboration.current().payload;
        repeatedArgumentRejections = (ledger.snapshot()?.events || []).filter((entry) =>
          recovery && entry.at >= recovery.startedAt && entry.type === "provider.responded" &&
          entry.result.diagnostics?.some((diagnostic) =>
            diagnostic.code === "tool_arguments_rejected"
          )
        ).length >= 2;
        compactRecovery = stage === "synthesis" &&
          (compactRecoveryStarted || (!submissionRepairPending && synthesisRecoveryCount > 0) || repeatedArgumentRejections);
        if (compactRecovery && !compactRecoveryStarted) {
          synthesisTransport = "structured_response";
          compactRecoveryStarted = true;
        }
        if (repetition?.kind === "alternate" || validationRepair) {
          stage = "synthesis";
          compactRecovery = compactRecoveryStarted = true;
          explicitFallback = true;
          const collaborationPending = collaboration.collaborationRequired === true && collaboration.collaborationRequirementMet !== true;
          const repeatFrom = repetition?.kind === "alternate" ? repetition.from : "native_tool";
          synthesisTransport = collaborationPending ? "native_tool" : repetition?.kind === "alternate" && !validationRepair ? repetition.to : "structured_response";
          input.logStoreEvent(validationRepair ? "runtime_v2_plan_validation_repair" : collaborationPending ? "runtime_v2_plan_provider_failed" : "runtime_v2_plan_provider_transport_fallback", {
            turnId: identity.turn.turnId, runId: identity.run.runId, round,
            evidenceCount: evidence.length, stage,
            ...(collaborationPending ? { transport: repeatFrom } : { from: repeatFrom, to: synthesisTransport }),
            reason: validationRepair ? "repeated_rejected_candidate" : "visible_repetition", terminal: false,
            action: collaborationPending ? "retry_required_collaboration_with_bounded_output" : "continue_with_alternate_transport",
          });
        }
        effectiveTransport = stage === "synthesis" ? synthesisTransport : "native_tool";
        const recoveredResponse = recoveredQuestion?.result ?? recoveredSubmission?.result;
        response = recoveredResponse ? { ...recoveredResponse,
          advertisedToolNames: recoveredResponse.toolCalls.map(call => call.name), transport: effectiveTransport,
        } : await requestPlanModel({
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
          explicitFallback,
          repetitionFallback: !validationRepair && repetition?.kind === "alternate",
          validationRepair,
          logStoreEvent: input.logStoreEvent,
        });
        recoveredQuestion = null;
        recoveredSubmission = null;
      } catch (error) {
        if (input.context.abortCtrl.signal.aborted) throw error;
        if (isRuntimeV2LifecycleDeadlineError(error)) continue;
        const attempted = [...(ledger.snapshot()?.events || [])].reverse().find((entry) => entry.type === "command.scheduled" && entry.command.kind === "request_model" && entry.run.runId === identity.run.runId);
        if (attempted?.type === "command.scheduled") effectiveTransport = attempted.command.payload.transport as PlanProviderTransport;
        const detail = error instanceof Error ? error.message : String(error);
        if (detail === "READ_ONLY_CONTEXT_BUDGET_EXCEEDED") throw error;
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
          explicitFallback = false;
          continue;
        }
        if (isRuntimeV2ProviderTransportsUnavailableError(error)) {
          terminalFailure = {
            resultKind: "error",
            reason: "模型适配器确认当前没有可用的计划传输通道；已保留现有证据并明确结束本轮。",
            detailCode: "runtime_v2_plan_provider_transports_unavailable",
          };
          input.logStoreEvent("runtime_v2_plan_provider_unavailable", {
            turnId: identity.turn.turnId,
            runId: identity.run.runId,
            round,
            evidenceCount: evidence.length,
            stage,
            transport: effectiveTransport,
            terminal: true,
            error: detail,
          });
          break;
        }
        await ledger.recordSoftSignal(identity.run, "protocol_drift");
        if (isPlanStreamRepetition(error) || repetition?.kind === "alternate" || validationRepair) continue;
        if (!isPlanSubmissionStage(stage)) {
          stage = "synthesis";
          synthesisRecoveryCount += 1;
          synthesisTransport = "structured_response";
          explicitFallback = true;
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
            from: effectiveTransport,
            to: synthesisTransport,
            error: detail,
          });
          continue;
        }
        const previousTransport: PlanProviderTransport = effectiveTransport;
        synthesisRecoveryCount += 1;
        synthesisTransport = previousTransport === "structured_response"
          ? "native_tool"
          : "structured_response";
        explicitFallback = true;
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
      if (input.context.abortCtrl.signal.aborted) throw new Error("RUNTIME_V2_PLAN_ABORTED");
      if (repetition?.kind === "alternate" && response.toolCalls.length) synthesisTransport = "native_tool";
      explicitFallback = false;
      if (await handleRuntimeV2PlanProviderAdmissionRejection({
        ledger, run: identity.run, response,
        collaboration: planCollaboration.current().payload,
        round, stage, logStoreEvent: input.logStoreEvent,
      })) {
        if (compactRecovery) synthesisTransport = response.transport === "structured_response" ? "native_tool" : "structured_response";
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
        if (repetition?.kind === "alternate" || validationRepair) continue;
        if (!compactRecoveryStarted && truncatedBeforePlanAction(response)) {
          // Use the existing bounded request after the first observed cutoff,
          // keeping authorized reads and submission on the normal tool lane.
          stage = "synthesis";
          compactRecoveryStarted = true;
          synthesisTransport = "native_tool";
          continue;
        }
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
          await ledger.recordSoftSignal(identity.run, "protocol_drift");
          const previousTransport: PlanProviderTransport = response.transport;
          synthesisRecoveryCount += 1;
          synthesisTransport = previousTransport === "structured_response"
            ? "native_tool"
            : "structured_response";
          explicitFallback = true;
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
      if (response.toolCalls.length === 1 && response.toolCalls[0]!.name === ASK_PLAN_QUESTIONS) {
        const pause = await handlePlanQuestionTool({ runner: input, ledger, run: identity.run, call: response.toolCalls[0]!, messages,
          receiptAlreadySettled: questionReceiptAlreadySettled,
          joinChildren: async () => !planCollaboration.activeChildCount() || planCollaboration.joinActive("plan_question_requires_joined_children"),
        });
        if (pause) return pause;
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
        if (!candidate || typeof candidate.planMarkdown !== "string" || !candidate.planMarkdown.trim()) {
          await settlePlanTool({ ledger, run: identity.run, call, status: "failed" });
          messages.push({
            role: "tool",
            tool_call_id: call.id,
            content: "WORK_PLAN_REJECTED: submit one JSON object with a non-empty planMarkdown body.",
          });
          input.logStoreEvent("runtime_v2_plan_submission_rejected", {
            turnId: identity.turn.turnId,
            runId: identity.run.runId,
            round,
            detail: "submit one JSON object with a non-empty planMarkdown body",
            submissionChars: String(call.arguments || "").length,
          });
          await ledger.recordSoftSignal(
            identity.run,
            "protocol_drift",
          );
          stage = "synthesis";
          submissionRepairPending = true;
          continue;
        }
        {
          const decisionJournal = buildPlanDecisionJournal(ledger.snapshot());
          const providerEvent = [...ledger.snapshot()!.events].reverse().find(event => event.type === "provider.responded" &&
            event.result.toolCalls.some(item => item.id === call.id && item.name === call.name));
          const priorReceipt = providerEvent && ledger.snapshot()!.events.some(event => event.type === "tool.completed" && event.sequence > providerEvent.sequence &&
            ledger.snapshot()!.events.some(command => command.type === "command.scheduled" && command.sequence > providerEvent.sequence &&
              command.command.idempotencyKey === event.idempotencyKey && command.command.payload.toolCallId === call.id && command.command.payload.toolName === call.name));
          const assessment = assessPlanSubmission({ candidate, evidence, objective: objective.text, criterionIds: admittedCriterionIds,
            aggregate: ledger.snapshot(), decisionJournal, requireBehavioralValidation: executablePlanSelected, ...(providerEvent ? { createdAt: providerEvent.at } : {}),
            collaborationRequired: (ledger.snapshot()?.subagentRequirement ?? input.context.turnInputContextSignals?.subagentRequirement) === "required" });
          if (draftOnlyRecovery && assessment.kind === "reviewable") continue;
          if (assessment.normalizationReasons.length) {
            input.logStoreEvent("runtime_v2_plan_submission_normalized", {
              turnId: identity.turn.turnId,
              runId: identity.run.runId,
              round,
              evidenceCount: evidence.length,
              reasons: assessment.normalizationReasons,
            });
          }
          if (assessment.kind === "draft") {
            if (!priorReceipt) await recordRuntimeV2PlanSubmissionRejection({ ledger, run: identity.run, call, messages,
              diagnostics: assessment.diagnostics });
            input.logStoreEvent("runtime_v2_plan_submission_rejected", { turnId: identity.turn.turnId, runId: identity.run.runId, round,
              diagnostics: assessment.diagnostics, normalizationReasons: assessment.normalizationReasons, submissionChars: JSON.stringify(candidate).length,
              candidateHash: hashPlanDraftCandidate(call.arguments),
              disposition: executablePlanSelected ? "continue_validation_readiness" : "save_reviewable_draft" });
            if (executablePlanSelected) continue;
            return await saveRuntimeV2PlanDraft({ runner: input, ledger, run: identity.run, call, candidate,
              diagnostics: assessment.diagnostics, decisionJournal });
          }
          sealedPlan = assessment.sealedPlan;
          if (!priorReceipt) await settlePlanTool({
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
        }
      }
      const parallelReadCount = runtimeV2ParallelReadCount(
        response.toolCalls,
      );
      for (const call of response.toolCalls) {
        if (input.context.abortCtrl.signal.aborted) throw new Error("RUNTIME_V2_PLAN_ABORTED");
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
          ...(executablePlanSelected ? { reuseRetainedRead: { historicalReads: bootstrap.historicalReads } } : {}),
          logStoreEvent: input.logStoreEvent,
        });
      }
    }
    return settleRuntimeV2PlanCompletion(await completeRuntimeV2Plan({
      runner: input,
      ledger,
      turn: identity.turn,
      run: identity.run,
      evidence,
      sealedPlan,
      terminalFailure,
      collaboration: planCollaboration,
    }));
  } catch (error) {
    return settleRuntimeV2PlanCompletion(await recoverRuntimeV2PlanFailure({
      error,
      runner: input,
      ledger,
      run: identity.run,
      collaboration: planCollaboration,
    }));
  } finally {
    planCollaboration.abortChildren("runtime_v2_plan_runner_closed");
    clearInterval(input.context.timerInterval as ReturnType<typeof setInterval>);
  }
}
