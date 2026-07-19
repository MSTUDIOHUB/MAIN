import type { PlanToolActivitySummary } from "../../planExecutionRecovery";
import type { OrchestratorCallbacks } from "../types";
import type { AssistantIterationPhaseResult } from "./assistantIterationPhase";
import {
  createAgentLoopEvidenceRuntimeState,
  markExecuteOperationEvidenceRuntimeState,
  type AgentLoopEvidenceRuntimeState,
} from "./evidenceRuntimeState";
import {
  createExecuteRecoveryRuntimeState,
  type ExecuteRecoveryRuntimeState,
} from "./executeRecoveryRuntime";
import type { IterationStreamPreparationResult } from "./iterationStreamPreparation";
import {
  createAgentLoopGuardRuntimeState,
  type AgentLoopGuardRuntimeState,
} from "./loopGuardRuntimeState";
import {
  createAgentLoopNoToolRuntimeState,
  type AgentLoopNoToolRuntimeState,
} from "./noToolRuntimeState";
import {
  createPlanLoopRuntimeState,
  type PlanLoopRuntimeState,
} from "./planRuntimeState";
import {
  createAgentLoopRecoveryPromptRuntimeState,
  type AgentLoopRecoveryPromptRuntimeState,
} from "./recoveryPromptRuntimeState";
import {
  createAgentLoopStreamRuntimeState,
  markChatFinalSynthesisPromptUsed,
  type AgentLoopStreamRuntimeState,
} from "./streamRuntimeState";
import {
  createAgentLoopToolExecutionRuntimeState,
  type AgentLoopToolExecutionRuntimeState,
} from "./toolExecutionRuntimeState";
import type { ToolIterationPhaseResult } from "./toolIterationPhase";
import type { UnityMcpRuntimeState } from "./unityMcpRuntime";

export interface AgentLoopMutableState {
  iteration: number;
  loopGuardRuntimeState: AgentLoopGuardRuntimeState;
  noToolRuntimeState: AgentLoopNoToolRuntimeState;
  streamRuntimeState: AgentLoopStreamRuntimeState;
  recoveryPromptState: AgentLoopRecoveryPromptRuntimeState;
  planRuntimeState: PlanLoopRuntimeState;
  attemptedPlanWriteTargets: string[];
  evidenceRuntimeState: AgentLoopEvidenceRuntimeState;
  recentPlanToolActivity: PlanToolActivitySummary[];
  recentToolActivity: PlanToolActivitySummary[];
  executeRecoveryState: ExecuteRecoveryRuntimeState;
  toolExecutionRuntimeState: AgentLoopToolExecutionRuntimeState;
  unityMcpRuntimeState: UnityMcpRuntimeState;
}

export function createAgentLoopMutableState(input: {
  callbacks: OrchestratorCallbacks;
  workflowMode: ReturnType<OrchestratorCallbacks["getWorkflowMode"]>;
  unityMcpRuntimeState: UnityMcpRuntimeState;
}): AgentLoopMutableState {
  return {
    iteration: 0,
    loopGuardRuntimeState: createAgentLoopGuardRuntimeState(),
    noToolRuntimeState: createAgentLoopNoToolRuntimeState(),
    streamRuntimeState: createAgentLoopStreamRuntimeState(),
    recoveryPromptState: createAgentLoopRecoveryPromptRuntimeState(),
    planRuntimeState: createPlanLoopRuntimeState({
      workflowMode: input.workflowMode,
      isPlanApproved: input.callbacks.getIsPlanApproved(),
    }),
    attemptedPlanWriteTargets: [],
    evidenceRuntimeState: createAgentLoopEvidenceRuntimeState(),
    recentPlanToolActivity: [],
    recentToolActivity: [],
    executeRecoveryState: createExecuteRecoveryRuntimeState({
      workflowMode: input.workflowMode,
      forcedMode: input.callbacks.getForcedExecuteRecoveryMode?.(),
      forcedState: input.callbacks.getForcedExecuteRecoveryState?.(),
    }),
    toolExecutionRuntimeState: createAgentLoopToolExecutionRuntimeState(
      input.callbacks.getSessionKey(),
    ),
    unityMcpRuntimeState: input.unityMcpRuntimeState,
  };
}

export function markExecuteOperationEvidenceMutableState(
  state: AgentLoopMutableState,
): void {
  state.evidenceRuntimeState = markExecuteOperationEvidenceRuntimeState(
    state.evidenceRuntimeState,
  );
}

export function markChatFinalSynthesisPromptUsedMutableState(
  state: AgentLoopMutableState,
): void {
  state.streamRuntimeState = markChatFinalSynthesisPromptUsed(
    state.streamRuntimeState,
  );
}

export function applyIterationStreamPreparationMutableState(
  state: AgentLoopMutableState,
  result: Pick<
    IterationStreamPreparationResult,
    "streamRuntimeState" | "executeRecoveryState"
  >,
): void {
  state.streamRuntimeState = result.streamRuntimeState;
  state.executeRecoveryState = result.executeRecoveryState;
}

export function applyAssistantIterationMutableState(
  state: AgentLoopMutableState,
  result: AssistantIterationPhaseResult,
): void {
  state.noToolRuntimeState = result.noToolRuntimeState;
  state.planRuntimeState = result.planRuntimeState;
  state.recoveryPromptState = result.recoveryPromptState;
  state.evidenceRuntimeState = result.evidenceRuntimeState;
  state.unityMcpRuntimeState = result.unityMcpRuntimeState;
}

export function applyToolIterationMutableState(
  state: AgentLoopMutableState,
  result: ToolIterationPhaseResult,
): void {
  state.noToolRuntimeState = result.noToolRuntimeState;
  state.planRuntimeState = result.planRuntimeState;
  state.loopGuardRuntimeState = result.loopGuardRuntimeState;
  state.executeRecoveryState = result.executeRecoveryState;
  state.recoveryPromptState = result.recoveryPromptState;
  state.unityMcpRuntimeState = result.unityMcpRuntimeState;
  state.evidenceRuntimeState = result.evidenceRuntimeState;
}
