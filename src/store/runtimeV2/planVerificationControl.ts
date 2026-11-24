import type { AgentMessage } from "../../lib/agentMessages";
import { buildPlanDecisionJournal } from "../../lib/planDecisionJournal";
import { hashPlanDraftCandidate, type PlanSubmissionDiagnostic } from "../../lib/planDrafts";
import type {
  RuntimeV2Event,
  RuntimeV2NormalizedToolCall,
  RuntimeV2RunIdentity,
  SealedWorkPlanV1,
  TurnAggregateV1,
  WorkPlanRuntimeEvidence,
} from "../../lib/runtime-v2";
import type { RuntimeV2LiveExecutionState } from "./executionTypes";
import { deriveReadOnlyRecoveryWindow } from "../../lib/runtime-v2/readOnlyProgress";
import type { RuntimeRunSettlement } from "../../lib/runtimeRunSettlement";
import { upsertRuntimeV2ContextAnchor } from "./executionProviderHistory";
import { saveRuntimeV2PlanDraft } from "./planDraftRunner";
import type { PlanLedger } from "./planLedger";
import { SUBMIT_WORK_PLAN_TOOL_NAME } from "./planModelProtocol";
import {
  latestPlanVerificationPolicyDecision,
  pausePlanVerificationConfirmation,
} from "./planQuestionControl";
import type { RuntimeV2PlanRunnerInput } from "./planRunnerTypes";
import {
  assessPlanSubmission,
  isValidationReadinessOnlyDiagnostics,
} from "./planSubmissionAssessment";
import { PLAN_SUBMISSION_VALIDATION_REJECTION_CODE, recordRuntimeV2PlanSubmissionRejection } from "./planSubmissionRepair";
import { planValidationRecovery } from "./planValidationRecovery";

type PlanVerificationPolicyDecision = ReturnType<
  typeof latestPlanVerificationPolicyDecision
>;

/** Compares two Run identities across every scoped owner field. */
export function samePlanRun(
  left: RuntimeV2RunIdentity,
  right: RuntimeV2RunIdentity,
): boolean {
  return left.sessionKey === right.sessionKey &&
    left.sessionEpoch === right.sessionEpoch &&
    left.turnId === right.turnId &&
    left.runId === right.runId &&
    left.parentRunId === right.parentRunId &&
    left.attemptId === right.attemptId;
}

/** Parses serialized `WORK_PLAN_REJECTED` diagnostics from a tool receipt. */
export function parseRejectionDiagnostics(
  feedback: string | undefined,
): PlanSubmissionDiagnostic[] {
  if (!feedback || !feedback.startsWith("WORK_PLAN_REJECTED: ")) return [];
  try {
    const parsed = JSON.parse(feedback.slice("WORK_PLAN_REJECTED: ".length));
    return Array.isArray(parsed?.diagnostics)
      ? parsed.diagnostics as PlanSubmissionDiagnostic[]
      : [];
  } catch {
    return [];
  }
}

/** Finds the latest rejected WorkPlan submission candidate with a non-empty Markdown body. */
export function latestRejectedPlanCandidate(
  aggregate: TurnAggregateV1,
  run: RuntimeV2RunIdentity,
  beforeOrAtSequence = Infinity,
): {
  readonly call: RuntimeV2NormalizedToolCall;
  readonly candidate: Record<string, unknown>;
  readonly diagnostics: readonly PlanSubmissionDiagnostic[];
  readonly providerAt: number;
  readonly rejectionSequence: number;
} | null {
  const scheduled = new Map<
    string,
    Extract<RuntimeV2Event, { type: "command.scheduled" }>
  >();
  let latest: {
    readonly call: RuntimeV2NormalizedToolCall;
    readonly candidate: Record<string, unknown>;
    readonly diagnostics: readonly PlanSubmissionDiagnostic[];
    readonly providerAt: number;
    readonly rejectionSequence: number;
  } | null = null;
  for (const event of aggregate.events) {
    if (event.sequence > beforeOrAtSequence) break;
    if (!("run" in event) || !samePlanRun(event.run, run)) continue;
    if (event.type === "command.scheduled" &&
      event.command.kind === "execute_tool" &&
      event.command.payload.toolName === SUBMIT_WORK_PLAN_TOOL_NAME &&
      samePlanRun(event.command.run, run)) {
      scheduled.set(event.command.idempotencyKey, event);
      continue;
    }
    if (event.type === "tool.completed" &&
      event.status === "failed" &&
      event.failureKind === "protocol_invalid" &&
      event.failureReasonCode === PLAN_SUBMISSION_VALIDATION_REJECTION_CODE) {
      const commandEvent = scheduled.get(event.idempotencyKey);
      if (!commandEvent) continue;
      const toolCallId = String(commandEvent.command.payload.toolCallId || "").trim();
      const rawArgs = commandEvent.command.payload.arguments;
      if (!toolCallId || !rawArgs || typeof rawArgs !== "object" || Array.isArray(rawArgs)) {
        continue;
      }
      const candidate = rawArgs as Record<string, unknown>;
      if (typeof candidate.planMarkdown !== "string" || !candidate.planMarkdown.trim()) {
        continue;
      }
      const providerEvent = [...aggregate.events].reverse().find(
        (candidateEvent): candidateEvent is Extract<RuntimeV2Event, { type: "provider.responded" }> =>
          candidateEvent.type === "provider.responded" &&
          candidateEvent.sequence < commandEvent.sequence &&
          samePlanRun(candidateEvent.run, run) &&
          candidateEvent.result.toolCalls.some(
            item => item.id === toolCallId && item.name === SUBMIT_WORK_PLAN_TOOL_NAME,
          ),
      );
      const matchingCall = providerEvent?.result.toolCalls.find(
        item => item.id === toolCallId && item.name === SUBMIT_WORK_PLAN_TOOL_NAME,
      );
      if (!providerEvent || !matchingCall) continue;
      const diagnostics = parseRejectionDiagnostics(
        event.modelContent || event.presentation?.message,
      );
      if (!diagnostics.length) continue;
      latest = {
        call: matchingCall,
        candidate,
        diagnostics,
        providerAt: providerEvent.at,
        rejectionSequence: event.sequence,
      };
    }
  }
  return latest;
}

/** Handles immediate resume-time actions after `plan_verification_confirmation`. */
export async function resolvePlanVerificationPolicyResume(input: {
  runner: RuntimeV2PlanRunnerInput;
  ledger: PlanLedger;
  run: RuntimeV2RunIdentity;
  aggregate: TurnAggregateV1;
  evidence: readonly WorkPlanRuntimeEvidence[];
  objectiveText: string;
  criterionIds: readonly string[];
  revisionOf?: { readonly id: string; readonly revision: number };
  liveMessages: RuntimeV2LiveExecutionState;
  executablePlanSelected: boolean;
}): Promise<
  | { kind: "none"; verificationPolicy: PlanVerificationPolicyDecision }
  | { kind: "settled"; settlement: RuntimeRunSettlement }
  | { kind: "sealed"; sealedPlan: SealedWorkPlanV1 }
> {
  const verificationPolicy = input.executablePlanSelected
    ? latestPlanVerificationPolicyDecision(input.aggregate, input.run)
    : null;
  if (!verificationPolicy) {
    return { kind: "none", verificationPolicy: null };
  }
  const hasPostDecisionActivity = input.aggregate.events.some(event =>
    event.sequence > verificationPolicy.decisionSequence &&
    "run" in event &&
    samePlanRun(event.run, input.run) &&
    (event.type === "provider.responded" ||
      (event.type === "command.scheduled" &&
        (event.command.kind === "request_model" ||
          event.command.payload.toolName === "save_plan_document"))),
  );
  if (hasPostDecisionActivity) {
    return { kind: "none", verificationPolicy };
  }
  const priorRejected = latestRejectedPlanCandidate(
    input.aggregate,
    input.run,
    verificationPolicy.pauseSequence,
  );
  const decisionJournal = buildPlanDecisionJournal(input.aggregate);
  if (verificationPolicy.policy === "save_draft" && priorRejected) {
    return {
      kind: "settled",
      settlement: await saveRuntimeV2PlanDraft({
        runner: input.runner,
        ledger: input.ledger,
        run: input.run,
        call: priorRejected.call,
        candidate: priorRejected.candidate,
        diagnostics: priorRejected.diagnostics,
        decisionJournal,
      }),
    };
  }
  if (verificationPolicy.policy === "manual_advisory" && priorRejected) {
    const reassessment = assessPlanSubmission({
      candidate: priorRejected.candidate,
      evidence: [...input.evidence],
      objective: input.objectiveText,
      criterionIds: [...input.criterionIds],
      aggregate: input.aggregate,
      decisionJournal,
      requireBehavioralValidation: false,
      allowManualAdvisoryValidation: true,
      revisionOf: input.revisionOf,
      createdAt: priorRejected.providerAt,
      collaborationRequired: (input.aggregate.subagentRequirement ??
        input.runner.context.turnInputContextSignals?.subagentRequirement) === "required",
    });
    if (reassessment.kind === "reviewable") {
      return { kind: "sealed", sealedPlan: reassessment.sealedPlan };
    }
    upsertRuntimeV2ContextAnchor(input.liveMessages, {
      key: `verification-policy-${verificationPolicy.decisionSequence}`,
      content: "The user explicitly approved proceeding with manual / external verification checks. You may submit the WorkPlan with advisory/assertion checks describing what the user should verify externally, while fixing any remaining non-validation diagnostics.",
    });
  }
  if (verificationPolicy.policy === "add_automated_test") {
    upsertRuntimeV2ContextAnchor(input.liveMessages, {
      key: `verification-policy-${verificationPolicy.decisionSequence}`,
      content: "The user explicitly requested runnable automated tests. Add the required test framework setup and test files to changes[], and bind at least one recognized runnable pass/fail finite test command in validations[] before submitting the WorkPlan.",
    });
  }
  return { kind: "none", verificationPolicy };
}

/** Saves the latest rejected plan candidate as a reviewable Plan Draft before failing on exhausted validation repair. */
export async function maybeRecoverExhaustedPlanValidationDraft(input: {
  runner: RuntimeV2PlanRunnerInput;
  ledger: PlanLedger;
  run: RuntimeV2RunIdentity;
  aggregate: TurnAggregateV1;
  evidenceCount: number;
  validationKind?: string;
}): Promise<RuntimeRunSettlement | null> {
  if (input.validationKind !== "exhausted") return null;
  const fallback = latestRejectedPlanCandidate(input.aggregate, input.run);
  if (!fallback || !fallback.diagnostics.length) return null;
  input.runner.logStoreEvent("runtime_v2_plan_validation_exhausted_draft_fallback", {
    turnId: input.run.turnId,
    runId: input.run.runId,
    evidenceCount: input.evidenceCount,
    rejectionSequence: fallback.rejectionSequence,
  });
  return await saveRuntimeV2PlanDraft({
    runner: input.runner,
    ledger: input.ledger,
    run: input.run,
    call: fallback.call,
    candidate: fallback.candidate,
    diagnostics: fallback.diagnostics,
    decisionJournal: buildPlanDecisionJournal(input.aggregate),
  });
}

/** Detects whether workspace inspection showed an empty repository with no project source files read. */
export function isObservedEmptyWorkspace(aggregate: TurnAggregateV1): boolean {
  const toolNames = new Map<string, string>();
  let sawEmptyListing = false;
  let readProjectFile = false;
  let foundGlobFiles = false;
  for (const event of aggregate.events) {
    if (event.type === "command.scheduled" && event.command.kind === "execute_tool") {
      toolNames.set(event.command.idempotencyKey, String(event.command.payload.toolName || ""));
      continue;
    }
    if (event.type !== "tool.completed" || event.status !== "succeeded") continue;
    const toolName = toolNames.get(event.idempotencyKey);
    const content = String(event.modelContent || "");
    if (toolName === "list_directory" && /\[\]\s*$/.test(content)) {
      sawEmptyListing = true;
    } else if (
      toolName === "get_project_skeleton" &&
      /(?:项目当前为空|workspace is empty|empty directory)/i.test(content)
    ) {
      sawEmptyListing = true;
    } else if (toolName === "read_file" || toolName === "read_file_window") {
      readProjectFile = true;
    } else if (toolName === "glob_search" && !/\[\]\s*$/.test(content) && !/未找到|no matches/i.test(content)) {
      foundGlobFiles = true;
    }
  }
  return sawEmptyListing && !readProjectFile && !foundGlobFiles;
}

/** Pauses executable plan synthesis for user verification policy choice when validation cannot converge. */
export async function maybePauseForPlanVerificationConfirmation(input: {
  runner: RuntimeV2PlanRunnerInput;
  ledger: PlanLedger;
  run: RuntimeV2RunIdentity;
  diagnostics: readonly PlanSubmissionDiagnostic[];
  candidateValidations?: readonly unknown[];
  verificationPolicy: PlanVerificationPolicyDecision;
}): Promise<RuntimeRunSettlement | null> {
  const allowManualAdvisoryValidation =
    input.verificationPolicy?.policy === "manual_advisory";
  if (
    allowManualAdvisoryValidation ||
    input.verificationPolicy?.policy === "add_automated_test" ||
    !isValidationReadinessOnlyDiagnostics(input.diagnostics)
  ) {
    return null;
  }
  const afterSequence = input.verificationPolicy?.decisionSequence ?? -1;
  const postSnapshot = input.ledger.snapshot()!;
  const validationOnlyRejectionsSinceDecision = postSnapshot.events.filter(event =>
    event.type === "tool.completed" &&
    event.sequence > afterSequence &&
    samePlanRun(event.run, input.run) &&
    event.status === "failed" &&
    event.failureKind === "protocol_invalid" &&
    event.failureReasonCode === PLAN_SUBMISSION_VALIDATION_REJECTION_CODE &&
    isValidationReadinessOnlyDiagnostics(
      parseRejectionDiagnostics(event.modelContent || event.presentation?.message),
    ),
  ).length;
  const nextRecoveryWindow = deriveReadOnlyRecoveryWindow(postSnapshot, {
    finalTextIsProgress: false,
  });
  const nextValidationRecovery = planValidationRecovery(
    postSnapshot,
    input.run,
    nextRecoveryWindow?.startedSequence,
  );
  const hasCommandSyntaxIssue = input.diagnostics.some(item => Boolean(item.commandRejectionReason));
  const threshold = isObservedEmptyWorkspace(postSnapshot) ? 1 : hasCommandSyntaxIssue ? 3 : 2;
  if (
    validationOnlyRejectionsSinceDecision < threshold ||
    nextValidationRecovery?.kind === "repair" ||
    nextValidationRecovery?.kind === "exhausted"
  ) {
    return null;
  }
  return await pausePlanVerificationConfirmation({
    runner: input.runner,
    ledger: input.ledger,
    run: input.run,
    diagnostics: input.diagnostics,
    candidateValidations: input.candidateValidations,
  });
}

/** Records a rejected WorkPlan candidate and pauses for user confirmation or saves a draft when appropriate. */
export async function handleWorkPlanDraftRejection(input: {
  runner: RuntimeV2PlanRunnerInput;
  ledger: PlanLedger;
  run: RuntimeV2RunIdentity;
  call: RuntimeV2NormalizedToolCall;
  candidate: Record<string, unknown>;
  diagnostics: readonly PlanSubmissionDiagnostic[];
  normalizationReasons: readonly string[];
  decisionJournal: ReturnType<typeof buildPlanDecisionJournal>;
  verificationPolicy: PlanVerificationPolicyDecision;
  messages: AgentMessage[];
  round: number;
  priorReceipt: boolean;
  executablePlanSelected: boolean;
}): Promise<RuntimeRunSettlement | null> {
  if (!input.priorReceipt) {
    await recordRuntimeV2PlanSubmissionRejection({
      ledger: input.ledger,
      run: input.run,
      call: input.call,
      messages: input.messages,
      diagnostics: [...input.diagnostics],
    });
  }
  input.runner.logStoreEvent("runtime_v2_plan_submission_rejected", {
    turnId: input.run.turnId,
    runId: input.run.runId,
    round: input.round,
    diagnostics: input.diagnostics,
    normalizationReasons: input.normalizationReasons,
    submissionChars: JSON.stringify(input.candidate).length,
    candidateHash: hashPlanDraftCandidate(input.call.arguments),
    disposition: input.executablePlanSelected ? "continue_validation_readiness" : "save_reviewable_draft",
  });
  if (input.executablePlanSelected) {
    return await maybePauseForPlanVerificationConfirmation({
      runner: input.runner,
      ledger: input.ledger,
      run: input.run,
      diagnostics: input.diagnostics,
      candidateValidations: Array.isArray(input.candidate.validations) ? input.candidate.validations : [],
      verificationPolicy: input.verificationPolicy,
    });
  }
  return await saveRuntimeV2PlanDraft({
    runner: input.runner,
    ledger: input.ledger,
    run: input.run,
    call: input.call,
    candidate: input.candidate,
    diagnostics: [...input.diagnostics],
    decisionJournal: input.decisionJournal,
  });
}
