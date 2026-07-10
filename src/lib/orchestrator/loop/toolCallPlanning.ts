import {
  describeApprovedPlanRecoveryToolSurface,
  describeApprovedPlanSourceEditFirstToolSurface,
  shouldAllowApprovedPlanRecoveryFileRead,
} from "../../approvedPlanRecoveryTools";
import {
  describeExecuteRecoveryToolSurface,
  isExecuteRecoveryToolName,
  shouldAllowExecuteRecoveryFileRead,
  type ExecuteRecoveryMode,
} from "../../executeRecoveryTools";
import {
  PLAN_EXPLORATION_READ_ONLY_TOOLS,
  approvedPlanNeedsSourceEditBeforeValidation,
  filterPlanRuntimeToolDefinitionsForPhase,
  hasPlanUserContextObservation,
  isApprovedPlanRecoveryTool,
  isApprovedPlanSourceEditFirstTool,
  logAgentEvent,
} from "../../orchestrator";
import { summarizeRepeatedPlanTargetsFromToolActivity, type PlanToolActivitySummary } from "../../planExecutionRecovery";
import { assessPlanEvidenceReadiness } from "../../planReadOnlyConvergence";
import { isPlanDraftWriteToolName, shouldClosePlanToolSurfaceAfterReadOnlyConvergence } from "../../planRuntime";
import { isMutationRuntimeIntent, type ResolvedUserIntent } from "../../runIntent";
import type { ToolDefinition } from "../../toolSchemas";
import type { TurnInputContextSignals } from "../../turnIntake";
import type { PlanRuntimePhase } from "../../workflowModels";
import type { AgentMessage, OrchestratorCallbacks } from "../types";

export interface IterationToolSurfaceDecision {
  isExecuteRecoveryEligible: boolean;
  allowExecuteRecoveryFileRead: boolean;
  effectiveExecuteRecoveryFileRead: boolean;
  approvedPlanSourceEditFirstActive: boolean;
  allowApprovedPlanRecoveryFileRead: boolean;
  iterationAllTools: ToolDefinition[];
  availableToolNames: Set<string>;
}

export function resolveIterationToolSurface(input: {
  callbacks: OrchestratorCallbacks;
  iteration: number;
  workflowMode: "chat" | "edit" | "plan";
  runtimeIntent: ResolvedUserIntent;
  rawIterationAllTools: ToolDefinition[];
  executeRecoveryMode: ExecuteRecoveryMode;
  executeRecoveryReason: string;
  executeRecoveryAttempts: number;
  recoveryIterationCount: number;
  maxRecoveryIterations: number;
  approvedPlanActionOnlyRecoveryActive: boolean;
  approvedPlanNoToolRecoveryFileReadActive: boolean;
  approvedPlanNoProgressRecoveryAttempts: number;
  approvedPlanLongReasoningNoActionCount: number;
  recentToolActivity: PlanToolActivitySummary[];
  recentPlanToolActivity: PlanToolActivitySummary[];
  planRuntimePhase: PlanRuntimePhase;
  planDraftingRecoveryReadCount: number;
  usedPlanReadOnlyConvergencePrompt: boolean;
  turnInputContextSignals: TurnInputContextSignals;
  lastAssistantTextForCheckpoint: string;
}): IterationToolSurfaceDecision {
  const {
    callbacks,
    iteration,
    workflowMode,
    runtimeIntent,
    rawIterationAllTools,
    executeRecoveryMode,
    executeRecoveryReason,
    executeRecoveryAttempts,
    recoveryIterationCount,
    maxRecoveryIterations,
    approvedPlanActionOnlyRecoveryActive,
    approvedPlanNoToolRecoveryFileReadActive,
    approvedPlanNoProgressRecoveryAttempts,
    approvedPlanLongReasoningNoActionCount,
    recentToolActivity,
    recentPlanToolActivity,
    planRuntimePhase,
    planDraftingRecoveryReadCount,
    usedPlanReadOnlyConvergencePrompt,
    turnInputContextSignals,
    lastAssistantTextForCheckpoint,
  } = input;

  const isExecuteRecoveryEligible =
    (workflowMode === "edit" || (workflowMode === "plan" && callbacks.getIsPlanApproved())) &&
    isMutationRuntimeIntent(runtimeIntent) &&
    executeRecoveryMode !== "normal";
  const allowExecuteRecoveryFileRead = shouldAllowExecuteRecoveryFileRead(recentToolActivity);
  const effectiveExecuteRecoveryFileRead =
    executeRecoveryMode === "patch_recovery_read" || allowExecuteRecoveryFileRead;
  const recoveryIterationAllTools = isExecuteRecoveryEligible
    ? rawIterationAllTools.filter((tool) => isExecuteRecoveryToolName(
        tool.function.name,
        PLAN_EXPLORATION_READ_ONLY_TOOLS,
        {
          mode: executeRecoveryMode,
          allowFileRead: allowExecuteRecoveryFileRead,
        },
      ))
    : rawIterationAllTools;
  if (isExecuteRecoveryEligible && recoveryIterationAllTools.length !== rawIterationAllTools.length) {
    logAgentEvent("execute_recovery_tool_scope_applied", {
      iteration,
      executeRecoveryMode,
      executeRecoveryReason,
      executeRecoveryAttempts,
      allowFileRead: effectiveExecuteRecoveryFileRead,
      adaptiveFileReadAllowed: allowExecuteRecoveryFileRead,
      recoveryToolSurface: describeExecuteRecoveryToolSurface(executeRecoveryMode, effectiveExecuteRecoveryFileRead),
      rawTools: rawIterationAllTools.map((tool) => tool.function.name).slice(0, 24),
      scopedTools: recoveryIterationAllTools.map((tool) => tool.function.name),
      removedToolCount: Math.max(0, rawIterationAllTools.length - recoveryIterationAllTools.length),
    });
  }

  const approvedPlanSourceEditFirstActive =
    workflowMode === "plan" &&
    callbacks.getIsPlanApproved() &&
    approvedPlanNeedsSourceEditBeforeValidation(
      callbacks.getPlanTasks(),
      callbacks.getPlanExecutionEvidenceLedger(),
    );
  const approvedPlanInitialSourceReadAllowed =
    approvedPlanSourceEditFirstActive &&
    runtimeIntent === "execute" &&
    recentPlanToolActivity.length === 0 &&
    callbacks.getPlanExecutionEvidenceLedger().length === 0;
  const approvedPlanPatchRecoveryFileReadAllowed =
    approvedPlanNoToolRecoveryFileReadActive ||
    shouldAllowApprovedPlanRecoveryFileRead(recentPlanToolActivity);
  // Source-edit execution may span several files. Keep the narrowly scoped
  // read_file tool available until a no-progress strategy switch explicitly
  // moves the loop to action-only recovery; cached-read guards still prevent
  // repeated exploration.
  const approvedPlanSourceEditFileReadAllowed =
    approvedPlanSourceEditFirstActive &&
    runtimeIntent === "execute" &&
    !approvedPlanActionOnlyRecoveryActive;
  const allowApprovedPlanRecoveryFileRead =
    approvedPlanSourceEditFileReadAllowed || approvedPlanPatchRecoveryFileReadAllowed;

  if (executeRecoveryMode !== "normal" || approvedPlanActionOnlyRecoveryActive || approvedPlanNoToolRecoveryFileReadActive) {
    logAgentEvent("recovery_loop_summary", {
      iteration,
      workflowMode,
      runtimeIntent,
      executeRecoveryMode,
      executeRecoveryReason,
      executeRecoveryAttempts,
      recoveryIterationCount,
      maxRecoveryIterations,
      approvedPlanActionOnlyRecoveryActive,
      approvedPlanNoToolRecoveryFileReadActive,
      approvedPlanNoProgressRecoveryAttempts,
      approvedPlanLongReasoningNoActionCount,
      allowApprovedPlanRecoveryFileRead,
      recentPlanToolActivity: recentPlanToolActivity.length,
      repeatedTargets: summarizeRepeatedPlanTargetsFromToolActivity(recentPlanToolActivity),
    });
  }

  const approvedPlanActionRecoveryActive =
    approvedPlanActionOnlyRecoveryActive &&
    workflowMode === "plan" &&
    callbacks.getIsPlanApproved();
  const baseIterationAllTools =
    approvedPlanActionRecoveryActive
      ? recoveryIterationAllTools.filter((tool) => isApprovedPlanRecoveryTool(tool, {
          allowFileRead: approvedPlanPatchRecoveryFileReadAllowed,
        }))
      : approvedPlanSourceEditFirstActive
      ? recoveryIterationAllTools.filter((tool) => isApprovedPlanSourceEditFirstTool(tool, {
          allowFileRead: allowApprovedPlanRecoveryFileRead,
        }))
      : recoveryIterationAllTools;
  if (approvedPlanSourceEditFirstActive && baseIterationAllTools.length !== recoveryIterationAllTools.length) {
    logAgentEvent("approved_plan_source_edit_first_tool_scope_applied", {
      iteration,
      allowFileRead: allowApprovedPlanRecoveryFileRead,
      initialSourceReadAllowed: approvedPlanInitialSourceReadAllowed,
      sourceEditFileReadAllowed: approvedPlanSourceEditFileReadAllowed,
      recoveryToolSurface: describeApprovedPlanSourceEditFirstToolSurface(allowApprovedPlanRecoveryFileRead),
      rawTools: recoveryIterationAllTools.map((tool) => tool.function.name).slice(0, 24),
      scopedTools: baseIterationAllTools.map((tool) => tool.function.name),
      removedToolCount: Math.max(0, recoveryIterationAllTools.length - baseIterationAllTools.length),
      taskCount: callbacks.getPlanTasks().length,
      evidenceCount: callbacks.getPlanExecutionEvidenceLedger().length,
    });
  }

  const allowDraftingRecoveryRead =
    workflowMode === "plan" &&
    !callbacks.getIsPlanApproved() &&
    planRuntimePhase === "drafting" &&
    planDraftingRecoveryReadCount < 1;
  const phaseScopedIterationAllTools = filterPlanRuntimeToolDefinitionsForPhase({
    tools: baseIterationAllTools,
    workflowMode,
    isPlanApproved: callbacks.getIsPlanApproved(),
    planRuntimePhase,
    allowDraftingRecoveryRead,
  });
  const shouldClosePlanToolSurface = shouldClosePlanToolSurfaceAfterReadOnlyConvergence({
    workflowMode,
    isPlanApproved: callbacks.getIsPlanApproved(),
    convergencePromptAlreadyUsed: usedPlanReadOnlyConvergencePrompt,
    planRuntimePhase,
    evidenceReadiness: assessPlanEvidenceReadiness({
      userContext: turnInputContextSignals,
      recentToolActivity: recentPlanToolActivity,
      hasObservedUserContext: hasPlanUserContextObservation(
        callbacks.getMessages() as AgentMessage[],
        lastAssistantTextForCheckpoint,
      ),
    }).status,
  });
  const iterationAllTools = shouldClosePlanToolSurface
    ? baseIterationAllTools.filter((tool) => isPlanDraftWriteToolName(tool.function.name))
    : phaseScopedIterationAllTools;

  const shouldLogToolSurfaceDecision =
    rawIterationAllTools.length !== iterationAllTools.length ||
    executeRecoveryMode !== "normal" ||
    approvedPlanActionOnlyRecoveryActive ||
    approvedPlanNoToolRecoveryFileReadActive ||
    (workflowMode === "plan" && callbacks.getIsPlanApproved());
  if (shouldLogToolSurfaceDecision) {
    const rawToolNames = rawIterationAllTools.map((tool) => tool.function.name);
    const scopedToolNames = iterationAllTools.map((tool) => tool.function.name);
    const scopedToolNameSet = new Set(scopedToolNames);
    logAgentEvent("tool_surface_decision", {
      iteration,
      workflowMode,
      runtimeIntent,
      planStage: callbacks.getPlanStage(),
      isPlanApproved: callbacks.getIsPlanApproved(),
      executeRecoveryMode,
      executeRecoveryReason,
      approvedPlanSourceEditFirstActive,
      approvedPlanActionOnlyRecoveryActive,
      approvedPlanNoToolRecoveryFileReadActive,
      // Report the effective surface, not an upstream eligibility hint. Those
      // can legitimately be true while a later phase filter removes read_file.
      allowFileRead: scopedToolNameSet.has("read_file"),
      readFileExposed: scopedToolNameSet.has("read_file"),
      approvedPlanPatchRecoveryFileReadAllowed,
      approvedPlanSourceEditFileReadAllowed,
      recoveryToolSurface: approvedPlanActionRecoveryActive || approvedPlanNoToolRecoveryFileReadActive
        ? describeApprovedPlanRecoveryToolSurface(approvedPlanPatchRecoveryFileReadAllowed)
        : approvedPlanSourceEditFirstActive
        ? describeApprovedPlanSourceEditFirstToolSurface(allowApprovedPlanRecoveryFileRead)
        : describeExecuteRecoveryToolSurface(executeRecoveryMode, effectiveExecuteRecoveryFileRead),
      rawToolCount: rawToolNames.length,
      scopedToolCount: scopedToolNames.length,
      removedToolCount: Math.max(0, rawToolNames.length - scopedToolNames.length),
      removedTools: rawToolNames.filter((name) => !scopedToolNameSet.has(name)).slice(0, 24),
      scopedTools: scopedToolNames.slice(0, 24),
    });
  }

  if (workflowMode === "plan" && !callbacks.getIsPlanApproved() && iterationAllTools.length !== baseIterationAllTools.length) {
    logAgentEvent("plan_runtime_tool_scope_applied", {
      iteration,
      planRuntimePhase,
      rawTools: rawIterationAllTools.map((tool) => tool.function.name).slice(0, 24),
      scopedTools: iterationAllTools.map((tool) => tool.function.name),
      removedToolCount: Math.max(0, baseIterationAllTools.length - iterationAllTools.length),
      postConvergence: shouldClosePlanToolSurface,
    });
  }

  return {
    isExecuteRecoveryEligible,
    allowExecuteRecoveryFileRead,
    effectiveExecuteRecoveryFileRead,
    approvedPlanSourceEditFirstActive,
    allowApprovedPlanRecoveryFileRead,
    iterationAllTools,
    availableToolNames: new Set(iterationAllTools.map((tool) => tool.function.name)),
  };
}
