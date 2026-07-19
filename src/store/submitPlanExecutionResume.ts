import { looksLikeExistingPlanExecutionRequest, type CommandDirective } from "../lib/runIntent";
import { getReviewablePlanArtifacts } from "../lib/planApprovalIdentity";
import type { PlanArtifact, PlanExecutionProgressSnapshot, PlanStage, PlanTask } from "../lib/workflowModels";

type SubmitPlanExecutionResumeSet = (patchOrUpdater: any) => void;

export interface SubmitPlanExecutionResumeState {
  currentWorkspace: string;
  planArtifacts: PlanArtifact[];
  planTasks: PlanTask[];
  planStage: PlanStage;
  planExecutionProgressSnapshot?: PlanExecutionProgressSnapshot | null;
  isPlanApproved: boolean;
}

export type SubmitPlanExecutionResumeDiscoveryReason =
  | "plan_resume_requires_explicit_turn_approval"
  | "plan_resume_artifact_not_found"
  | "plan_resume_discovery_unavailable";

/**
 * The legacy resume route is discovery-only. The caller must admit a new
 * workspace Turn and obtain a fresh approval/execution lease before it can
 * create a Run or expose tools.
 */
export interface SubmitPlanExecutionResumeDiscoveryResult {
  kind: "discovery_only";
  reason: SubmitPlanExecutionResumeDiscoveryReason;
  message: string;
  artifactCount: number;
  taskCount: number;
  requiresTurnAdmission: true;
  requiresApproval: true;
}

export interface RunSubmitPlanExecutionResumeEffectInput<TState extends SubmitPlanExecutionResumeState> {
  text: string;
  images?: string[];
  preferredLanguage: "zh" | "en";
  shouldRouteContinuationToPlanResume: boolean;
  uiParentTurnId?: string;
  commandDirective: CommandDirective | null | undefined;
  getState: () => TState;
  setState: SubmitPlanExecutionResumeSet;
  applyPreRunSessionPatch: (patch: Record<string, unknown>) => void;
  hydrateExistingPlanArtifactsForWorkspace: (
    workspace: string,
    language: "zh" | "en",
  ) => Promise<{
    artifacts: PlanArtifact[];
    tasks: PlanTask[];
    hasTasksArtifact: boolean;
  }>;
  logStoreEvent: (event: string, data?: Record<string, unknown>) => void;
  onResumeBlocked?: (message: string, detail: {
    reason: SubmitPlanExecutionResumeDiscoveryReason;
    qualityReason?: string | null;
  }) => void;
}

function buildDiscoveryResult(input: {
  language: "zh" | "en";
  reason: SubmitPlanExecutionResumeDiscoveryReason;
  artifactCount: number;
  taskCount: number;
  errorMessage?: string;
}): SubmitPlanExecutionResumeDiscoveryResult {
  let message: string;
  if (input.reason === "plan_resume_requires_explicit_turn_approval") {
    message = input.language === "zh"
      ? "已恢复现有计划供审阅，但没有继承旧执行批准、旧回合或旧 Run。请在新的工作区回合中审阅并明确批准后再执行。"
      : "The existing plan was restored for review without inheriting the old execution approval, Turn, or Run. Review and explicitly approve it in a new workspace Turn before execution.";
  } else if (input.reason === "plan_resume_artifact_not_found") {
    message = input.language === "zh"
      ? "没有找到可审阅的现有计划，因此未恢复执行。请在新的工作区回合中生成或提供计划并完成审批。"
      : "No reviewable existing plan was found, so execution was not resumed. Generate or provide a plan in a new workspace Turn and complete approval first.";
  } else {
    const detail = input.errorMessage?.trim();
    message = input.language === "zh"
      ? `无法读取现有计划，执行保持暂停。请在新的工作区回合中重试恢复并完成审批${detail ? `（${detail}）` : ""}。`
      : `The existing plan could not be read, so execution remains paused. Retry discovery and complete approval in a new workspace Turn${detail ? ` (${detail})` : ""}.`;
  }
  return {
    kind: "discovery_only",
    reason: input.reason,
    message,
    artifactCount: input.artifactCount,
    taskCount: input.taskCount,
    requiresTurnAdmission: true,
    requiresApproval: true,
  };
}

/**
 * Discovers a persisted Plan for review. This transitional entry point must
 * never authorize execution, reuse an existing Turn, create a Run, or call a
 * provider/tool dispatch callback. Phase 4's Turn-first route consumes the
 * returned result and performs fresh admission and approval.
 */
export async function runSubmitPlanExecutionResumeEffect<TState extends SubmitPlanExecutionResumeState>(
  input: RunSubmitPlanExecutionResumeEffectInput<TState>,
): Promise<SubmitPlanExecutionResumeDiscoveryResult> {
  input.applyPreRunSessionPatch({
    input: "",
    contextMentions: [],
    attachedFiles: [],
    lockedComposerIntent: null,
    pendingRunDecision: null,
  });

  const shouldDiscoverExistingPlan =
    looksLikeExistingPlanExecutionRequest(input.text) ||
    input.shouldRouteContinuationToPlanResume;
  let latest = input.getState();
  let artifacts = latest.planArtifacts;
  let tasks = latest.planTasks;

  if (shouldDiscoverExistingPlan) {
    const alreadyDiscovered = getReviewablePlanArtifacts(artifacts).length > 0;
    if (!alreadyDiscovered) {
      try {
        const hydrated = await input.hydrateExistingPlanArtifactsForWorkspace(
          latest.currentWorkspace,
          input.preferredLanguage,
        );
        artifacts = hydrated.artifacts;
        tasks = hydrated.tasks;
      } catch (error) {
        const result = buildDiscoveryResult({
          language: input.preferredLanguage,
          reason: "plan_resume_discovery_unavailable",
          artifactCount: artifacts.length,
          taskCount: tasks.length,
          errorMessage: error instanceof Error ? error.message : String(error),
        });
        input.setState({
          isPlanApproved: false,
          planApprovalChoice: null,
          planStage: "plan",
          planAutoResumeCount: 0,
          showPlanPanel: true,
          rightPanelTab: "plan",
          showDiff: false,
        });
        input.logStoreEvent("existing_plan_discovery_unavailable", {
          workspace: latest.currentWorkspace || null,
          reason: result.reason,
          error: error instanceof Error ? error.message : String(error),
        });
        input.onResumeBlocked?.(result.message, { reason: result.reason });
        return result;
      }
    }

    input.setState({
      planArtifacts: artifacts,
      planTasks: tasks,
      showPlanPanel: true,
      rightPanelTab: "plan",
      showDiff: false,
    });
    input.logStoreEvent("existing_plan_discovered_for_review", {
      workspace: latest.currentWorkspace || null,
      reusedExistingState: alreadyDiscovered,
      artifacts: artifacts.map((artifact) => artifact.path),
      taskCount: tasks.length,
    });
  }

  latest = input.getState();
  artifacts = latest.planArtifacts;
  tasks = latest.planTasks;
  const hasReviewablePlan = getReviewablePlanArtifacts(artifacts).length > 0;
  const result = buildDiscoveryResult({
    language: input.preferredLanguage,
    reason: hasReviewablePlan
      ? "plan_resume_requires_explicit_turn_approval"
      : "plan_resume_artifact_not_found",
    artifactCount: artifacts.length,
    taskCount: tasks.length,
  });
  const pausedProgress = latest.planExecutionProgressSnapshot
    ? {
        ...latest.planExecutionProgressSnapshot,
        phase: "paused" as const,
        nextStep: result.message,
        updatedAt: Date.now(),
      }
    : null;

  input.setState({
    isPlanApproved: false,
    planApprovalChoice: null,
    planStage: "plan",
    planTasks: tasks,
    planAutoResumeCount: 0,
    planExecutionProgressSnapshot: pausedProgress,
    showPlanPanel: true,
    rightPanelTab: "plan",
    showDiff: false,
  });
  input.logStoreEvent("existing_plan_resume_requires_explicit_turn_approval", {
    workspace: latest.currentWorkspace || null,
    reason: result.reason,
    artifactCount: result.artifactCount,
    taskCount: result.taskCount,
    requiresTurnAdmission: result.requiresTurnAdmission,
    requiresApproval: result.requiresApproval,
  });
  input.onResumeBlocked?.(result.message, { reason: result.reason });
  return result;
}
