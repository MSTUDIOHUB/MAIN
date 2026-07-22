import { executeToolCallPhase } from "./toolCallExecutionPhase";
import { handleToolResultRecoveryPhase } from "./toolResultRecoveryPhase";
import type { AgentLoopEvidenceRuntimeState } from "./evidenceRuntimeState";
import type { ExecuteRecoveryRuntimeState } from "./executeRecoveryRuntime";
import type { AgentLoopGuardRuntimeState } from "./loopGuardRuntimeState";
import type { AgentLoopNoToolRuntimeState } from "./noToolRuntimeState";
import type { PlanLoopRuntimeState } from "./planRuntimeState";
import type { AgentLoopRecoveryPromptRuntimeState } from "./recoveryPromptRuntimeState";
import type { UnityMcpRuntimeState } from "./unityMcpRuntime";
import type { PlanTask } from "../../workflowModels";
import type { ToolExecutionResult } from "../types";

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
  > & {
    onSubagentSpawnCreated?: () => void;
  };

export type ToolIterationPhaseResult = {
  status: "aborted" | "stopped" | "continue" | "completed" | "plan_completed" | "goal_completed";
  subagentSpawnCreated: boolean;
  noToolRuntimeState: AgentLoopNoToolRuntimeState;
  planRuntimeState: PlanLoopRuntimeState;
  loopGuardRuntimeState: AgentLoopGuardRuntimeState;
  executeRecoveryState: ExecuteRecoveryRuntimeState;
  recoveryPromptState: AgentLoopRecoveryPromptRuntimeState;
  unityMcpRuntimeState: UnityMcpRuntimeState;
  evidenceRuntimeState: AgentLoopEvidenceRuntimeState;
  completionAudit?: {
    completedCount: number;
    totalCount: number;
    pendingUserValidationTasks?: PlanTask[];
  };
};

export function didCreateSubagentFromToolResults(
  results: ToolExecutionResult[],
): boolean {
  return results.some((result) => {
    if (result.name !== "spawn_subagent" || result.isError) return false;
    const runtimeOutcome = result.subagentSpawnOutcome;
    if (runtimeOutcome) {
      return runtimeOutcome.subagentId !== null &&
        (runtimeOutcome.status === "queued" || runtimeOutcome.status === "running");
    }
    try {
      const outcome = JSON.parse(String(result.content || "")) as {
        subagentId?: unknown;
        status?: unknown;
      };
      return typeof outcome.subagentId === "string" &&
        outcome.subagentId.trim().length > 0 &&
        (outcome.status === "queued" || outcome.status === "running");
    } catch {
      return false;
    }
  });
}

export async function handleToolIterationPhase(
  input: ToolIterationPhaseInput,
): Promise<ToolIterationPhaseResult> {
  const toolCallPhase = await executeToolCallPhase(input);
  const subagentSpawnCreated = didCreateSubagentFromToolResults(
    toolCallPhase.allResults,
  );
  if (subagentSpawnCreated) {
    input.onSubagentSpawnCreated?.();
  }
  if (toolCallPhase.status === "aborted") {
    return {
      status: "aborted",
      subagentSpawnCreated,
      noToolRuntimeState: toolCallPhase.noToolRuntimeState,
      planRuntimeState: toolCallPhase.planRuntimeState,
      loopGuardRuntimeState: toolCallPhase.loopGuardRuntimeState,
      executeRecoveryState: toolCallPhase.executeRecoveryState,
      recoveryPromptState: toolCallPhase.recoveryPromptState,
      unityMcpRuntimeState: toolCallPhase.unityMcpRuntimeState,
      evidenceRuntimeState: toolCallPhase.evidenceRuntimeState,
    };
  }

  const toolResultRecoveryPhase = await handleToolResultRecoveryPhase({
    ...input,
    planRuntimeState: toolCallPhase.planRuntimeState,
    loopGuardRuntimeState: toolCallPhase.loopGuardRuntimeState,
    executeRecoveryState: toolCallPhase.executeRecoveryState,
    recoveryPromptState: toolCallPhase.recoveryPromptState,
    evidenceRuntimeState: toolCallPhase.evidenceRuntimeState,
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
    subagentSpawnCreated,
    noToolRuntimeState: toolCallPhase.noToolRuntimeState,
    planRuntimeState: toolResultRecoveryPhase.planRuntimeState,
    loopGuardRuntimeState: toolResultRecoveryPhase.loopGuardRuntimeState,
    executeRecoveryState: toolResultRecoveryPhase.executeRecoveryState,
    recoveryPromptState: toolResultRecoveryPhase.recoveryPromptState,
    unityMcpRuntimeState: toolCallPhase.unityMcpRuntimeState,
    evidenceRuntimeState: toolCallPhase.evidenceRuntimeState,
    ...(toolResultRecoveryPhase.completionAudit
      ? { completionAudit: toolResultRecoveryPhase.completionAudit }
      : {}),
  };
}
