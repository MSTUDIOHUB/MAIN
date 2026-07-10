import { executeToolCallPhase } from "./toolCallExecutionPhase";
import { handleToolResultRecoveryPhase } from "./toolResultRecoveryPhase";
import type { ApprovedPlanRecoveryRuntimeState } from "./approvedPlanRecoveryRuntime";
import type { AgentLoopEvidenceRuntimeState } from "./evidenceRuntimeState";
import type { ExecuteRecoveryRuntimeState } from "./executeRecoveryRuntime";
import type { AgentLoopGuardRuntimeState } from "./loopGuardRuntimeState";
import type { AgentLoopNoToolRuntimeState } from "./noToolRuntimeState";
import type { PlanLoopRuntimeState } from "./planRuntimeState";
import type { AgentLoopRecoveryPromptRuntimeState } from "./recoveryPromptRuntimeState";
import type { UnityMcpRuntimeState } from "./unityMcpRuntime";

type ToolCallPhaseInput = Parameters<typeof executeToolCallPhase>[0];
type ToolResultRecoveryInput = Parameters<typeof handleToolResultRecoveryPhase>[0];

type ToolIterationPhaseInput = ToolCallPhaseInput &
  Omit<
    ToolResultRecoveryInput,
    | "effectiveToolCalls"
    | "results"
    | "toolArgsByCallId"
    | "toolFailureSignatures"
    | "hasPlanDecisionOutput"
    | "unityMcpFallbackPrompt"
    | "remainingTaskText"
    | "successfulReadOnlyExplorationResultCount"
    | "isUnapprovedPlanReadOnlyBatch"
  >;

export type ToolIterationPhaseResult = {
  status: "aborted" | "stopped" | "continue" | "completed";
  noToolRuntimeState: AgentLoopNoToolRuntimeState;
  planRuntimeState: PlanLoopRuntimeState;
  loopGuardRuntimeState: AgentLoopGuardRuntimeState;
  executeRecoveryState: ExecuteRecoveryRuntimeState;
  recoveryPromptState: AgentLoopRecoveryPromptRuntimeState;
  unityMcpRuntimeState: UnityMcpRuntimeState;
  evidenceRuntimeState: AgentLoopEvidenceRuntimeState;
  approvedPlanRecoveryState: ApprovedPlanRecoveryRuntimeState;
};

export async function handleToolIterationPhase(
  input: ToolIterationPhaseInput,
): Promise<ToolIterationPhaseResult> {
  const toolCallPhase = await executeToolCallPhase(input);
  if (toolCallPhase.status === "aborted") {
    return {
      status: "aborted",
      noToolRuntimeState: toolCallPhase.noToolRuntimeState,
      planRuntimeState: toolCallPhase.planRuntimeState,
      loopGuardRuntimeState: input.loopGuardRuntimeState,
      executeRecoveryState: input.executeRecoveryState,
      recoveryPromptState: toolCallPhase.recoveryPromptState,
      unityMcpRuntimeState: toolCallPhase.unityMcpRuntimeState,
      evidenceRuntimeState: toolCallPhase.evidenceRuntimeState,
      approvedPlanRecoveryState: toolCallPhase.approvedPlanRecoveryState,
    };
  }

  const toolResultRecoveryPhase = await handleToolResultRecoveryPhase({
    ...input,
    planRuntimeState: toolCallPhase.planRuntimeState,
    recoveryPromptState: toolCallPhase.recoveryPromptState,
    evidenceRuntimeState: toolCallPhase.evidenceRuntimeState,
    approvedPlanRecoveryState: toolCallPhase.approvedPlanRecoveryState,
    results: toolCallPhase.allResults,
    toolArgsByCallId: toolCallPhase.toolArgsByCallId,
    toolFailureSignatures: toolCallPhase.toolFailureSignatures,
    hasPlanDecisionOutput: toolCallPhase.hasPlanDecisionOutput,
    unityMcpFallbackPrompt: toolCallPhase.unityMcpFallbackPrompt,
    remainingTaskText: toolCallPhase.remainingTaskText,
    successfulReadOnlyExplorationResultCount:
      toolCallPhase.successfulReadOnlyExplorationResultCount,
    isUnapprovedPlanReadOnlyBatch:
      toolCallPhase.isUnapprovedPlanReadOnlyBatch,
  });

  return {
    status: toolResultRecoveryPhase.status,
    noToolRuntimeState: toolCallPhase.noToolRuntimeState,
    planRuntimeState: toolResultRecoveryPhase.planRuntimeState,
    loopGuardRuntimeState: toolResultRecoveryPhase.loopGuardRuntimeState,
    executeRecoveryState: toolResultRecoveryPhase.executeRecoveryState,
    recoveryPromptState: toolResultRecoveryPhase.recoveryPromptState,
    unityMcpRuntimeState: toolCallPhase.unityMcpRuntimeState,
    evidenceRuntimeState: toolCallPhase.evidenceRuntimeState,
    approvedPlanRecoveryState: toolResultRecoveryPhase.approvedPlanRecoveryState,
  };
}
