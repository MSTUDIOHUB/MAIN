import type { AgentMessage } from "../../lib/agentMessages";
import type { PlanSubmissionDiagnostic } from "../../lib/planDrafts";
import {
  WORK_PLAN_V1_SCHEMA_VERSION,
  type RuntimeV2Event,
  type RuntimeV2NormalizedProviderResult,
  type RuntimeV2RunIdentity,
  type TurnAggregateV1,
} from "../../lib/runtime-v2";
import { settlePlanTool } from "./planEvidencePort";
import { PlanLedger } from "./planLedger";
import { appendPlanToolResult } from "./planHistory";
import {
  SUBMIT_WORK_PLAN_TOOL_NAME,
} from "./planModelProtocol";

export const PLAN_SUBMISSION_VALIDATION_REJECTION_CODE =
  "runtime_v2_plan_submission_validation_rejected";

const PLAN_SUBMISSION_FEEDBACK_PREFIX = "WORK_PLAN_REJECTED: ";
const PLAN_SUBMISSION_FEEDBACK_MAX_CHARS = 4_000;

type PlanToolCall =
  RuntimeV2NormalizedProviderResult["toolCalls"][number];

function sameRun(
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

function submissionCommand(
  aggregate: TurnAggregateV1,
  idempotencyKey: string,
): Extract<RuntimeV2Event, { type: "command.scheduled" }> | undefined {
  return aggregate.events.find((event): event is Extract<
    RuntimeV2Event,
    { type: "command.scheduled" }
  > =>
    event.type === "command.scheduled" &&
    event.command.idempotencyKey === idempotencyKey &&
    event.command.kind === "execute_tool" &&
    event.command.payload.runtimeControlPlane === true &&
    event.command.payload.toolName === SUBMIT_WORK_PLAN_TOOL_NAME
  );
}

function latestTypedSubmissionRejection(
  aggregate: TurnAggregateV1,
  run: RuntimeV2RunIdentity,
): Extract<RuntimeV2Event, { type: "tool.completed" }> | undefined {
  for (let index = aggregate.events.length - 1; index >= 0; index--) {
    const event = aggregate.events[index];
    if (event?.type === "tool.completed" && sameRun(event.run, run) &&
      event.status === "failed" && event.failureKind === "protocol_invalid" &&
      event.failureReasonCode === PLAN_SUBMISSION_VALIDATION_REJECTION_CODE &&
      submissionCommand(aggregate, event.idempotencyKey)) return event;
  }
  return undefined;
}

/** Reassess only the latest submitted candidate when its decision boundary
 * and tool outcome still permit recovery. */
export function recoverPlanSubmission(
  aggregate: TurnAggregateV1,
  run: RuntimeV2RunIdentity,
  allowRejectedDraft = false,
): { result: RuntimeV2NormalizedProviderResult; draftOnly: boolean } | null {
  const events = aggregate.events.filter(event => "run" in event && sameRun(event.run, run));
  const response = [...events].reverse().find(event => event.type === "provider.responded");
  if (response?.type !== "provider.responded" || response.result.toolCalls.length !== 1) return null;
  const [call] = response.result.toolCalls;
  if (call?.name !== SUBMIT_WORK_PLAN_TOOL_NAME || typeof call.arguments.planMarkdown !== "string" || !call.arguments.planMarkdown.trim()) return null;

  const later = events.filter(event => event.sequence > response.sequence);
  if (later.some(event => event.type === "run.decision_recorded" && event.choice !== "stop" && (event.answer || event.reply))) return null;
  const commands = new Set(later.flatMap(event => event.type === "command.scheduled" &&
    event.command.kind === "execute_tool" && event.command.payload.toolName === call.name && event.command.payload.toolCallId === call.id
    ? [event.command.idempotencyKey] : []));
  const rejection = later.find(event => (event.type === "tool.completed" || event.type === "command.completed") &&
    commands.has(event.idempotencyKey) && event.status !== "succeeded");
  if (rejection && !(allowRejectedDraft && rejection.type === "tool.completed" &&
    rejection.failureReasonCode === PLAN_SUBMISSION_VALIDATION_REJECTION_CODE)) return null;
  // Older Plans may have crashed after rejecting a candidate but before saving
  // its independent partial draft. The rejected call can only save that draft.
  return { result: response.result, draftOnly: !!rejection };
}

export function createRuntimeV2PlanSubmissionLifecycle(input: {
  readonly ledger: PlanLedger;
  readonly run: RuntimeV2RunIdentity;
  readonly messages: AgentMessage[];
  readonly lifecycleMs?: number;
}) {
  const fallbackStartedAt = Date.now();
  const current = () => resolveRuntimeV2PlanSubmissionLifecycle({
    aggregate: input.ledger.snapshot()!,
    run: input.run,
    fallbackStartedAt,
    lifecycleMs: input.lifecycleMs,
  });
  restoreRuntimeV2PlanSubmissionRepairHistory({
    aggregate: input.ledger.snapshot()!,
    run: input.run,
    messages: input.messages,
  });
  return { current };
}

/** Ordinary Plan has no total duration limit. Explicit caller deadlines are
 * durable and cannot be extended by rejection, progress or a restart. */
export function resolveRuntimeV2PlanSubmissionLifecycle(input: {
  readonly aggregate: TurnAggregateV1;
  readonly run: RuntimeV2RunIdentity;
  readonly fallbackStartedAt: number;
  readonly lifecycleMs?: number;
}): {
  readonly originalDeadlineAt: number;
  readonly effectiveDeadlineAt: number;
  readonly submissionRepairPending: boolean;
} {
  const runStarted = input.aggregate.events.find((event) =>
    event.type === "run.started" && sameRun(event.run, input.run)
  );
  const originalDeadlineAt = runStarted?.type === "run.started" && Number.isFinite(runStarted.lifecycleDeadlineAt)
    ? runStarted.lifecycleDeadlineAt!
    : Number.isFinite(input.lifecycleMs)
      ? (runStarted?.at ?? input.fallbackStartedAt) + input.lifecycleMs!
      : Number.POSITIVE_INFINITY;
  const rejection = latestTypedSubmissionRejection(
    input.aggregate,
    input.run,
  );
  const submissionRepairPending = !!rejection &&
    !input.aggregate.events.some((event) =>
      event.type === "work_plan.sealed" && sameRun(event.run, input.run)
    );
  return {
    originalDeadlineAt,
    effectiveDeadlineAt: originalDeadlineAt,
    submissionRepairPending,
  };
}

function formatPlanSubmissionRejection(diagnostics: readonly PlanSubmissionDiagnostic[]): string {
  const selected: PlanSubmissionDiagnostic[] = [];
  const format = () => {
    const omittedDiagnosticCount = diagnostics.length - selected.length;
    return PLAN_SUBMISSION_FEEDBACK_PREFIX + JSON.stringify({
      code: "PLAN_EXECUTION_READINESS_INCOMPLETE",
      diagnostics: selected,
      ...(omittedDiagnosticCount > 0 ? { omittedDiagnosticCount } : {}),
    });
  };
  for (const diagnostic of diagnostics) {
    const message = diagnostic.message.length > 360 ? `${diagnostic.message.slice(0, 359)}…` : diagnostic.message;
    selected.push({ ...diagnostic, message });
    if (format().length > PLAN_SUBMISSION_FEEDBACK_MAX_CHARS) selected.pop();
  }
  return format();
}

/** Compiler/criteria/adoption feedback is durable recovery authority.
 * Malformed transport input never calls this. */
export async function recordRuntimeV2PlanSubmissionRejection(input: {
  readonly ledger: PlanLedger;
  readonly run: RuntimeV2RunIdentity;
  readonly call: PlanToolCall;
  readonly messages: AgentMessage[];
  readonly diagnostics: readonly PlanSubmissionDiagnostic[];
}): Promise<void> {
  const feedback = formatPlanSubmissionRejection(input.diagnostics);
  await settlePlanTool({
    ledger: input.ledger,
    run: input.run,
    call: input.call,
    status: "failed",
    failureKind: "protocol_invalid",
    failureReasonCode: PLAN_SUBMISSION_VALIDATION_REJECTION_CODE,
    modelContent: feedback,
    presentation: {
      toolName: SUBMIT_WORK_PLAN_TOOL_NAME,
      target: WORK_PLAN_V1_SCHEMA_VERSION,
      message: feedback,
    },
  });
  appendPlanToolResult(input.messages, input.call.id, feedback);
}

/** Rebuild only the causal rejected submission pair needed by a cold repair.
 * The typed completion selects the pair; no provider prose is parsed. */
export function restoreRuntimeV2PlanSubmissionRepairHistory(input: {
  readonly aggregate: TurnAggregateV1;
  readonly run: RuntimeV2RunIdentity;
  readonly messages: AgentMessage[];
}): void {
  const rejection = latestTypedSubmissionRejection(input.aggregate, input.run);
  if (!rejection) return;
  const scheduled = submissionCommand(
    input.aggregate,
    rejection.idempotencyKey,
  );
  if (scheduled?.type !== "command.scheduled") return;
  const toolCallId = String(scheduled.command.payload.toolCallId || "").trim();
  if (!toolCallId) return;
  const feedback = rejection.modelContent || rejection.presentation?.message ||
    "WORK_PLAN_REJECTED: correct the typed WorkPlan and submit it again.";
  if (input.messages.some((message) => message.role === "tool" &&
    message.tool_call_id === toolCallId && message.content === feedback)) return;
  input.messages.push({
    role: "assistant",
    content: "",
    tool_calls: [{
      id: toolCallId,
      type: "function",
      function: {
        name: SUBMIT_WORK_PLAN_TOOL_NAME,
        arguments: JSON.stringify(scheduled.command.payload.arguments || {}),
      },
    }],
  }, {
    role: "tool",
    tool_call_id: toolCallId,
    content: feedback,
  });
}
