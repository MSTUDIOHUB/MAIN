import type { AgentMessage, ContentPart } from "../lib/orchestrator";
import type { HarnessRunMarker } from "../lib/harnessCrashTelemetry";
import type { PlanStage } from "../lib/workflowModels";
import type { ResolvedRunIntent } from "../lib/runIntent";
import { buildSubmitHarnessRunMarkerDraft } from "../lib/submit/turnSubmission";

export interface SubmitRunLeaseRuntimeSnapshot {
  agentMessagesLength: number;
  planStage: PlanStage;
  isPlanApproved: boolean;
}

export interface StartSubmitRunLeaseInput<TAbortController> {
  userContent: string;
  currentImages: string[];
  runSessionKey: string;
  runWorkspace?: string | null;
  runSessionId?: number | null;
  turnId: string;
  effectiveRunIntent: ResolvedRunIntent;
  runtimeRunIntent: ResolvedRunIntent;
  getRuntimeSnapshot: () => SubmitRunLeaseRuntimeSnapshot;
  appendAgentMessage: (message: AgentMessage) => void;
  createAbortController: () => TAbortController;
  setAbortController: (abortController: TAbortController) => void;
  startGoal: (objective: string, options: { sessionKey: string }) => void;
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

  if (input.effectiveRunIntent === "goal") {
    input.startGoal(input.userContent, { sessionKey: input.runSessionKey });
  }

  const runtimeAfterMessage = input.getRuntimeSnapshot();
  const startedAtMs = (input.nowMs || Date.now)();
  const harnessRunMarker = input.persistHarnessRunMarker(buildSubmitHarnessRunMarkerDraft({
    runId: createSubmitHarnessRunId(startedAtMs),
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
  }));
  input.setHarnessRunMarker(harnessRunMarker);

  return {
    turnAgentMessagesStart,
    agentUserMessage,
    abortController,
    harnessRunMarker,
  };
}
