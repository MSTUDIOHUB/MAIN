import type { AgentMessage, ContentPart } from "../lib/agentMessages";
import type { HarnessRunMarker } from "../lib/harnessCrashTelemetry";
import type { PlanStage } from "../lib/workflowModels";
import type { ResolvedRunIntent } from "../lib/runIntent";
import { resolveSubmitRunLineage } from "../lib/runIdentity";
import type { SubagentDelegationPreference } from "../lib/turnIntake";
import {
  digestVisualPayloadIdentities,
  visualPayloadIdentitiesFromContent,
} from "../lib/visualContext";
import {
  buildSubmitHarnessRunMarkerDraft
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

  currentImages: string[];
  runSessionKey: string;
  runWorkspace?: string | null;
  runSessionId?: number | null;
  turnId: string;
  effectiveRunIntent: ResolvedRunIntent;
  runtimeRunIntent: ResolvedRunIntent;


  /** Consumed by this lease only; callers cannot infer it from resolvedIntent. */

  subagentPreference?: SubagentDelegationPreference;
  /** Exact paused run that an action continuation resumes. */
  parentRunIdOverride?: string;
  /** Preallocated child owner for approval handoffs. */
  runIdOverride?: string;
  getRuntimeSnapshot: () => SubmitRunLeaseRuntimeSnapshot;
  appendAgentMessage: (message: AgentMessage) => void;
  createAbortController: () => TAbortController;
  setAbortController: (abortController: TAbortController) => void;

  getCurrentHarnessInstanceId: () => string;
  /** Exact global marker snapshot captured when bootstrap began. */
  expectedHarnessRunMarker: HarnessRunMarker | null;
  acquireHarnessRunMarker: (
    marker: HarnessRunMarker,
    expectedCurrent: HarnessRunMarker | null,
  ) => HarnessRunMarker | null;
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
  runtimeTurnId?: string;
}): AgentMessage {
  const runtimeTurnId = String(params.runtimeTurnId || "").trim();
  if (params.currentImages.length <= 0) {
    return {
      role: "user",
      content: params.userContent,
      ...(runtimeTurnId ? { runtimeTurnId } : {}),
    };
  }

  const parts: ContentPart[] = params.currentImages.map((dataUrl) => ({
    type: "image_url",
    image_url: { url: dataUrl },
  }));
  if (params.userContent.trim()) {
    parts.push({ type: "text", text: params.userContent });
  }
  const payloadIdentities = visualPayloadIdentitiesFromContent(parts);
  return {
    role: "user",
    content: parts,
    ...(runtimeTurnId ? { runtimeTurnId } : {}),
    ...(runtimeTurnId
      ? {
          runtimeVisualImageParts: payloadIdentities.length,
          runtimeVisualPayloadDigest: digestVisualPayloadIdentities(payloadIdentities),
        }
      : {}),
  };
}

export function startSubmitRunLease<TAbortController>(
  input: StartSubmitRunLeaseInput<TAbortController>,
): SubmitRunLease<TAbortController> {
  const runtimeBeforeMessage = input.getRuntimeSnapshot();
  const turnAgentMessagesStart = runtimeBeforeMessage.agentMessagesLength;
  const agentUserMessage = buildSubmitAgentUserMessage({
    userContent: input.userContent,
    currentImages: input.currentImages,
    runtimeTurnId: input.turnId,
  });

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
  const harnessRunMarkerDraft = {
    ...buildSubmitHarnessRunMarkerDraft({
      runId: lineage.runId,
      instanceId: input.getCurrentHarnessInstanceId(),
      runSessionKey: input.runSessionKey,
      runWorkspace: input.runWorkspace,
      runSessionId: input.runSessionId,
      turnId: input.turnId,
      effectiveRunIntent: input.effectiveRunIntent,
      runtimeRunIntent: input.runtimeRunIntent,
      planStage: runtimeBeforeMessage.planStage,
      isPlanApproved: runtimeBeforeMessage.isPlanApproved,
      messagesLen: runtimeBeforeMessage.agentMessagesLength + 1,
      startedAtMs,
    }),
    parentRunId,
    turnStartMessageIndex: lineage.turnStartMessageIndex,

  };
  const harnessRunMarker = input.acquireHarnessRunMarker(
    harnessRunMarkerDraft,
    input.expectedHarnessRunMarker,
  );
  if (!harnessRunMarker) {
    throw new Error(
      "HARNESS_RUN_LEASE_OWNER_LOST: a newer Harness owner acquired the global slot during bootstrap",
    );
  }
  input.setHarnessRunMarker(harnessRunMarker);

  if (runtimeBeforeMessage.harnessRunMarker?.runId !== runId) input.appendAgentMessage(agentUserMessage);

  const abortController = input.createAbortController();
  input.setAbortController(abortController);


  return {
    turnAgentMessagesStart,
    agentUserMessage,
    abortController,
    harnessRunMarker,
    runId: lineage.runId,
    parentRunId,
  };
}
