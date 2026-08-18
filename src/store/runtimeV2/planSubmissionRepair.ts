import type { AgentMessage } from "../../lib/agentMessages";
import {
  WORK_PLAN_V1_SCHEMA_VERSION,
  type RuntimeV2Event,
  type RuntimeV2NormalizedProviderResult,
  type RuntimeV2RunIdentity,
  type TurnAggregateV1,
} from "../../lib/runtime-v2";
import { settlePlanTool } from "./planEvidencePort";
import { PlanLedger } from "./planLedger";
import {
  PLAN_SYNTHESIS_RECOVERY_REQUEST_TIMEOUT_MS,
  SUBMIT_WORK_PLAN_TOOL_NAME,
} from "./planModelProtocol";

export const PLAN_SUBMISSION_VALIDATION_REJECTION_CODE =
  "runtime_v2_plan_submission_validation_rejected";

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

function firstTypedSubmissionRejection(
  aggregate: TurnAggregateV1,
  run: RuntimeV2RunIdentity,
): Extract<RuntimeV2Event, { type: "tool.completed" }> | undefined {
  return aggregate.events.find((event): event is Extract<
    RuntimeV2Event,
    { type: "tool.completed" }
  > =>
    event.type === "tool.completed" &&
    sameRun(event.run, run) &&
    event.status === "failed" &&
    event.failureKind === "protocol_invalid" &&
    event.failureReasonCode ===
      PLAN_SUBMISSION_VALIDATION_REJECTION_CODE &&
    !!submissionCommand(aggregate, event.idempotencyKey)
  );
}

export function createRuntimeV2PlanSubmissionLifecycle(input: {
  readonly ledger: PlanLedger;
  readonly run: RuntimeV2RunIdentity;
  readonly messages: AgentMessage[];
  readonly lifecycleMs: number;
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

/** Resolve both clocks exclusively from durable events. A process restart may
 * neither reset the Plan lifecycle nor renew its one repair grace. */
export function resolveRuntimeV2PlanSubmissionLifecycle(input: {
  readonly aggregate: TurnAggregateV1;
  readonly run: RuntimeV2RunIdentity;
  readonly fallbackStartedAt: number;
  readonly lifecycleMs: number;
}): {
  readonly originalDeadlineAt: number;
  readonly effectiveDeadlineAt: number;
  readonly submissionRepairPending: boolean;
} {
  const runStarted = input.aggregate.events.find((event) =>
    event.type === "run.started" && sameRun(event.run, input.run)
  );
  const originalDeadlineAt =
    (runStarted?.at ?? input.fallbackStartedAt) + input.lifecycleMs;
  const rejection = firstTypedSubmissionRejection(
    input.aggregate,
    input.run,
  );
  const submissionRepairPending = !!rejection &&
    !input.aggregate.events.some((event) =>
      event.type === "work_plan.sealed" && sameRun(event.run, input.run)
    );
  return {
    originalDeadlineAt,
    effectiveDeadlineAt: rejection
      ? Math.max(
          originalDeadlineAt,
          rejection.at + PLAN_SYNTHESIS_RECOVERY_REQUEST_TIMEOUT_MS,
        )
      : originalDeadlineAt,
    submissionRepairPending,
  };
}

/** Persist a compiler/criteria/adoption rejection as the sole authority for a
 * bounded post-deadline repair. Malformed transport input never calls this. */
export async function recordRuntimeV2PlanSubmissionRejection(input: {
  readonly ledger: PlanLedger;
  readonly run: RuntimeV2RunIdentity;
  readonly call: PlanToolCall;
  readonly messages: AgentMessage[];
  readonly detail: string;
}): Promise<void> {
  const feedback = `WORK_PLAN_REJECTED: ${input.detail}`.slice(0, 4_000);
  await settlePlanTool({
    ledger: input.ledger,
    run: input.run,
    call: input.call,
    status: "failed",
    failureKind: "protocol_invalid",
    failureReasonCode: PLAN_SUBMISSION_VALIDATION_REJECTION_CODE,
    presentation: {
      toolName: SUBMIT_WORK_PLAN_TOOL_NAME,
      target: WORK_PLAN_V1_SCHEMA_VERSION,
      message: feedback,
    },
  });
  input.messages.push({
    role: "tool",
    tool_call_id: input.call.id,
    content: feedback,
  });
}

/** Rebuild only the causal rejected submission pair needed by a cold repair.
 * The typed completion selects the pair; no provider prose is parsed. */
export function restoreRuntimeV2PlanSubmissionRepairHistory(input: {
  readonly aggregate: TurnAggregateV1;
  readonly run: RuntimeV2RunIdentity;
  readonly messages: AgentMessage[];
}): void {
  const rejection = firstTypedSubmissionRejection(input.aggregate, input.run);
  if (!rejection) return;
  const scheduled = submissionCommand(
    input.aggregate,
    rejection.idempotencyKey,
  );
  if (scheduled?.type !== "command.scheduled") return;
  const toolCallId = String(scheduled.command.payload.toolCallId || "").trim();
  if (!toolCallId) return;
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
    content: rejection.presentation?.message ||
      "WORK_PLAN_REJECTED: correct the typed WorkPlan and submit it again.",
  });
}
