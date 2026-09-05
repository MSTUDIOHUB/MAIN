import type {
  RuntimeV2Event,
  RuntimeV2RunIdentity,
  TurnAggregateV1,
} from "../../lib/runtime-v2";
import type { AgentMessage } from "../../lib/agentMessages";
import type { PlanLedger } from "./planLedger";
import type { RuntimeV2PlanTerminalFailure } from "./planRequirement";

export const PLAN_REQUIRED_COLLABORATION_PROVIDER_TIMEOUT_CODE =
  "runtime_v2_plan_required_collaboration_provider_timeout";
export const PLAN_REQUIRED_COLLABORATION_PROVIDER_MAX_ATTEMPTS = 2;
const REQUIRED_COLLABORATION_RETRY_GUIDANCE =
  "The required planning-child request timed out before admission. Retry the same exact spawn_subagent contract once; do not switch to synthesis or weaken the collaboration requirement.";

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

function isRequiredSpawnRequest(
  event: RuntimeV2Event,
  run: RuntimeV2RunIdentity,
): event is Extract<RuntimeV2Event, { type: "command.scheduled" }> {
  return event.type === "command.scheduled" &&
    sameRun(event.run, run) &&
    event.command.kind === "request_model" &&
    event.command.payload.requiredSpawn === true;
}

/** Count only paired, durable failures of the exact required-spawn request
 * surface. A restart cannot renew the single retry, and unrelated discovery
 * or synthesis failures cannot consume it. */
export function requiredPlanCollaborationProviderTimeoutCount(input: {
  readonly aggregate: TurnAggregateV1 | null;
  readonly run: RuntimeV2RunIdentity;
}): number {
  const events = input.aggregate?.events || [];
  const requiredSpawnKeys = new Set(events
    .filter((event) => isRequiredSpawnRequest(event, input.run))
    .map((event) => event.command.idempotencyKey));
  return events.filter((event) =>
    event.type === "command.completed" &&
    sameRun(event.run, input.run) &&
    event.status === "failed" &&
    event.failureReasonCode ===
      PLAN_REQUIRED_COLLABORATION_PROVIDER_TIMEOUT_CODE &&
    requiredSpawnKeys.has(event.idempotencyKey)
  ).length;
}

function latestRequiredCollaborationTimeoutRequest(input: {
  readonly aggregate: TurnAggregateV1 | null;
  readonly run: RuntimeV2RunIdentity;
}): Extract<RuntimeV2Event, { type: "command.scheduled" }> | undefined {
  const events = input.aggregate?.events || [];
  const failedKeys = new Set(events.flatMap((event) =>
    event.type === "command.completed" && sameRun(event.run, input.run) &&
      event.status === "failed" &&
      event.failureReasonCode === PLAN_REQUIRED_COLLABORATION_PROVIDER_TIMEOUT_CODE
      ? [event.idempotencyKey]
      : []
  ));
  return [...events].reverse().find((event) =>
    isRequiredSpawnRequest(event, input.run) &&
    failedKeys.has(event.command.idempotencyKey)
  ) as Extract<RuntimeV2Event, { type: "command.scheduled" }> | undefined;
}

export function restoreRequiredPlanCollaborationProviderTimeoutGuidance(input: {
  readonly aggregate: TurnAggregateV1 | null;
  readonly run: RuntimeV2RunIdentity;
  readonly messages: AgentMessage[];
}): void {
  if (requiredPlanCollaborationProviderTimeoutCount(input) !== 1) return;
  input.messages.push({ role: "system", content: REQUIRED_COLLABORATION_RETRY_GUIDANCE });
}

export function requiredPlanCollaborationProviderTimeoutFailure(input: {
  readonly aggregate: TurnAggregateV1 | null;
  readonly run: RuntimeV2RunIdentity;
  readonly collaborationRequired: boolean;
  readonly collaborationRequirementMet: boolean;
}): RuntimeV2PlanTerminalFailure | null {
  if (!input.collaborationRequired || input.collaborationRequirementMet) {
    return null;
  }
  if (requiredPlanCollaborationProviderTimeoutCount(input) <
    PLAN_REQUIRED_COLLABORATION_PROVIDER_MAX_ATTEMPTS) return null;
  return {
    resultKind: "blocked",
    reason: "用户明确要求使用规划子智能体，但模型通道连续两次在安全调度前超时；本轮已有限结束，未把未满足的协作要求当作成功。",
    detailCode: PLAN_REQUIRED_COLLABORATION_PROVIDER_TIMEOUT_CODE,
  };
}

/** Close or retry the exact required-spawn surface from durable receipts.
 * This is the only provider-failure path allowed to retain discovery after a
 * timeout, so the runner cannot claim a transport/stage switch that did not
 * occur on the wire. */
export async function handleRequiredPlanCollaborationProviderTimeout(input: {
  readonly error: unknown;
  readonly aggregate: TurnAggregateV1 | null;
  readonly run: RuntimeV2RunIdentity;
  readonly turnId: string;
  readonly collaboration: Readonly<Record<string, unknown>>;
  readonly ledger: PlanLedger;
  readonly messages: AgentMessage[];
  readonly logStoreEvent: (event: string, data?: Record<string, unknown>) => void;
}): Promise<{
  readonly terminalFailure: RuntimeV2PlanTerminalFailure | null;
} | null> {
  const collaborationRequired =
    input.collaboration.collaborationRequired === true;
  const collaborationRequirementMet =
    input.collaboration.collaborationRequirementMet === true;
  if (
    !(input.error instanceof Error) ||
    input.error.message !== "RUNTIME_V2_PLAN_PROVIDER_REQUEST_TIMEOUT" ||
    !collaborationRequired || collaborationRequirementMet
  ) return null;
  const attempt = requiredPlanCollaborationProviderTimeoutCount(input);
  if (attempt < 1) return null;
  const terminalFailure = requiredPlanCollaborationProviderTimeoutFailure({
    aggregate: input.aggregate,
    run: input.run,
    collaborationRequired,
    collaborationRequirementMet,
  });
  const request = latestRequiredCollaborationTimeoutRequest(input);
  input.logStoreEvent("runtime_v2_plan_required_collaboration_provider_timeout", {
    turnId: input.turnId, runId: input.run.runId, attempt,
    maxAttempts: PLAN_REQUIRED_COLLABORATION_PROVIDER_MAX_ATTEMPTS,
    stage: String(request?.command.payload.stage || "discovery"),
    transport: String(request?.command.payload.transport || "unknown"),
    terminal: !!terminalFailure,
    action: terminalFailure ? "block" : "retry_same_surface",
  });
  if (!terminalFailure) {
    input.messages.push({ role: "system", content: REQUIRED_COLLABORATION_RETRY_GUIDANCE });
  }
  return { terminalFailure };
}
