import type { AgentMessage, ContentPart } from "../lib/orchestrator";
import type { HarnessRunMarker } from "../lib/harnessCrashTelemetry";
import type { PlanStage } from "../lib/workflowModels";
import type { ResolvedRunIntent } from "../lib/runIntent";
import { resolveSubmitRunLineage } from "../lib/runIdentity";
import type { SubagentDelegationPreference } from "../lib/turnIntake";
import {
  buildSubmitHarnessRunMarkerDraft,
  isGoalCreationAuthorization,
  type GoalCreationAuthorization,
} from "../lib/submit/turnSubmission";

export interface SubmitRunLeaseRuntimeSnapshot {
  agentMessagesLength: number;
  planStage: PlanStage;
  isPlanApproved: boolean;
  harnessRunMarker?: HarnessRunMarker | null;
}

export interface StartSubmitRunLeaseInput<TAbortController> {
  userContent: string;
  /** Exact text visible in the chat area, before turn-intake/recovery wrapping. */
  canonicalUserText?: string;
  /** Bounded prior-turn context assembled before appending the current message. */
  goalSourceContext?: string;
  currentImages: string[];
  runSessionKey: string;
  runWorkspace?: string | null;
  runSessionId?: number | null;
  turnId: string;
  effectiveRunIntent: ResolvedRunIntent;
  runtimeRunIntent: ResolvedRunIntent;
  /** Continue the identity-validated active Goal instead of creating a new one. */
  continueExistingGoal?: boolean;
  /** Consumed by this lease only; callers cannot infer it from resolvedIntent. */
  goalCreationAuthorization?: GoalCreationAuthorization | null;
  subagentPreference?: SubagentDelegationPreference;
  /** Exact paused run that an action continuation resumes. */
  parentRunIdOverride?: string;
  /** Preallocated child owner for approval handoffs. */
  runIdOverride?: string;
  getRuntimeSnapshot: () => SubmitRunLeaseRuntimeSnapshot;
  appendAgentMessage: (message: AgentMessage) => void;
  createAbortController: () => TAbortController;
  setAbortController: (abortController: TAbortController) => void;
  startGoal: (objective: string, options: { sessionKey: string; sourceContext?: string; ownerTurnId: string; subagentPreference?: SubagentDelegationPreference }) => void;
  getCurrentHarnessInstanceId: () => string;
  persistHarnessRunMarker: (marker: HarnessRunMarker) => HarnessRunMarker;
  setHarnessRunMarker: (marker: HarnessRunMarker) => void;
  nowMs?: () => number;
}

export interface SubmitRunLease<TAbortController> {
  turnAgentMessagesStart: number;
  agentUserMessage: AgentMessage;
  abortController: TAbortController;
  harnessRunMarker: HarnessRunMarker;
  runId: string;
  parentRunId: string | null;
}

export function createSubmitHarnessRunId(startedAtMs: number): string {
  const randomUuid = globalThis.crypto?.randomUUID?.();
  return randomUuid
    ? `run-${randomUuid}`
    : `run-${startedAtMs}-${Math.random().toString(36).slice(2, 12)}`;
}

export function buildSubmitAgentUserMessage(params: {
  userContent: string;
  currentImages: string[];
}): AgentMessage {
  if (params.currentImages.length <= 0) {
    return { role: "user", content: params.userContent };
  }

  const parts: ContentPart[] = params.currentImages.map((dataUrl) => ({
    type: "image_url",
    image_url: { url: dataUrl },
  }));
  if (params.userContent.trim()) {
    parts.push({ type: "text", text: params.userContent });
  }
  return { role: "user", content: parts };
}

export function startSubmitRunLease<TAbortController>(
  input: StartSubmitRunLeaseInput<TAbortController>,
): SubmitRunLease<TAbortController> {
  const runtimeBeforeMessage = input.getRuntimeSnapshot();
  const turnAgentMessagesStart = runtimeBeforeMessage.agentMessagesLength;
  const agentUserMessage = buildSubmitAgentUserMessage({
    userContent: input.userContent,
    currentImages: input.currentImages,
  });
  input.appendAgentMessage(agentUserMessage);

  const abortController = input.createAbortController();
  input.setAbortController(abortController);

  const hasExplicitGoalCreationAuthorization = isGoalCreationAuthorization(
    input.goalCreationAuthorization,
  );
  if (
    input.effectiveRunIntent === "goal" &&
    input.runtimeRunIntent === "goal" &&
    input.continueExistingGoal !== true &&
    hasExplicitGoalCreationAuthorization
  ) {
    const canonicalObjective = String(input.canonicalUserText || "").trim() || input.userContent.trim();
    input.startGoal(
      canonicalObjective,
      {
        sessionKey: input.runSessionKey,
        sourceContext: input.goalSourceContext,
        ownerTurnId: input.turnId,
        ...(input.subagentPreference
          ? { subagentPreference: input.subagentPreference }
          : {}),
      },
    );
  }

  const runtimeAfterMessage = input.getRuntimeSnapshot();
  const startedAtMs = (input.nowMs || Date.now)();
  const runId = String(input.runIdOverride || "").trim() || createSubmitHarnessRunId(startedAtMs);
  const lineage = resolveSubmitRunLineage({
    previousMarker: runtimeBeforeMessage.harnessRunMarker,
    sessionKey: input.runSessionKey,
    turnId: input.turnId,
    runId,
    currentMessageStartIndex: turnAgentMessagesStart,
  });
  const parentRunId = String(input.parentRunIdOverride || "").trim() || lineage.parentRunId;
  const harnessRunMarker = input.persistHarnessRunMarker({
    ...buildSubmitHarnessRunMarkerDraft({
      runId: lineage.runId,
      instanceId: input.getCurrentHarnessInstanceId(),
      runSessionKey: input.runSessionKey,
      runWorkspace: input.runWorkspace,
      runSessionId: input.runSessionId,
      turnId: input.turnId,
      effectiveRunIntent: input.effectiveRunIntent,
      runtimeRunIntent: input.runtimeRunIntent,
      planStage: runtimeAfterMessage.planStage,
      isPlanApproved: runtimeAfterMessage.isPlanApproved,
      messagesLen: runtimeAfterMessage.agentMessagesLength,
      startedAtMs,
    }),
    parentRunId,
    turnStartMessageIndex: lineage.turnStartMessageIndex,
    lastGoalSliceRunId: null,
  });
  input.setHarnessRunMarker(harnessRunMarker);

  return {
    turnAgentMessagesStart,
    agentUserMessage,
    abortController,
    harnessRunMarker,
    runId: lineage.runId,
    parentRunId,
  };
}
