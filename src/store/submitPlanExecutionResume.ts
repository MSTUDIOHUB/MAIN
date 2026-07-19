import { looksLikeExistingPlanExecutionRequest, type CommandDirective } from "../lib/runIntent";
import { getHarnessActionRunId, type HarnessRunMarker } from "../lib/harnessCrashTelemetry";
import { getReviewablePlanArtifacts } from "../lib/planApprovalIdentity";
import { resolveRestoredPlanExecutionTaskIdentity } from "../lib/planExecutionRecovery";
import type { PlanArtifact, PlanExecutionEvidenceEntry, PlanExecutionProgressSnapshot, PlanStage, PlanTask } from "../lib/workflowModels";
import { buildPlanTaskEvidenceAudit } from "../lib/workflowModels";
import { evaluateApprovedPlanExecutionReadiness } from "./submitApprovedPlanExecution";

type SubmitPlanExecutionResumeSet = (patchOrUpdater: any) => void;

export interface SubmitPlanExecutionResumeState {
  currentWorkspace: string;
  currentTurnId: string | null;
  planArtifacts: PlanArtifact[];
  planTasks: PlanTask[];
  planStage: PlanStage;
  planExecutionEvidenceLedger: PlanExecutionEvidenceEntry[];
  planExecutionProgressSnapshot?: PlanExecutionProgressSnapshot | null;
  harnessRunMarker?: HarnessRunMarker | null;
  isPlanApproved: boolean;
  conversationTurns: Array<{ id: string; userPrompt?: string }>;
}

export interface SubmitPlanExecutionResumeOptions {
  hidden: true;
  createVisibleTurnForHiddenMessage: boolean;
  reuseCurrentTurn: boolean;
  turnIdOverride?: string;
  preservePlanState: true;
  resolvedIntent: "execute";
  commandDirective: CommandDirective | null | undefined;
  executionConsentGranted: true;
  skipIntentResolution: true;
  turnTitle: string;
  intentSummary: string;
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
  ensureApprovedPlanRuntimeTasksForState: (state: TState, language: "zh" | "en") => PlanTask[];
  resumeSubmission: (
    text: string,
    images: string[] | undefined,
    options: SubmitPlanExecutionResumeOptions,
  ) => void;
  logStoreEvent: (event: string, data?: Record<string, unknown>) => void;
  onResumeBlocked?: (message: string, detail: {
    reason: string;
    qualityReason?: string | null;
  }) => void;
}

export function buildTrustedPlanResumePrompt(input: {
  language: "zh" | "en";
  hasTasksArtifact: boolean;
  tasks: PlanTask[];
  artifacts: PlanArtifact[];
  evidenceLedger: PlanExecutionEvidenceEntry[];
}): string {
  const audit = buildPlanTaskEvidenceAudit({
    tasks: input.tasks,
    evidenceLedger: input.evidenceLedger,
    highlightNext: true,
  });
  const remaining = audit.remainingTasks.slice(0, 8);
  const remainingText = remaining.length > 0
    ? remaining.map((task, index) => {
        const evidence = task.evidence?.map((item) => `${item.kind}:${item.value}`).join(", ") ||
          (input.language === "zh" ? "无证据标签" : "no evidence tags");
        return `${index + 1}. ${task.text} [${task.evidenceStatus || "missing"}; ${evidence}]`;
      }).join("\n")
    : input.language === "zh"
    ? "无剩余未满足证据的任务；请核查 runtime 任务清单是否为空或已全部满足。tasks.md 是可选审计文件，不要为了确认是否存在而读取它。"
    : "No remaining task with unsatisfied evidence; verify whether the runtime task list is empty or fully satisfied. tasks.md is optional; do not read it just to check existence.";
  const evidenceText = input.evidenceLedger.slice(-8).map((entry) =>
    `- ${entry.kind}:${entry.target || entry.value} (${entry.sourceTool})`
  ).join("\n") || (input.language === "zh" ? "- 暂无可信执行证据" : "- No trusted execution evidence yet");
  const artifactText = input.artifacts.map((artifact) =>
    `- ${artifact.path} (${artifact.kind}, ${artifact.content.length} chars)`
  ).join("\n") || (input.language === "zh" ? "- 暂无计划文件摘要" : "- No plan artifact summary");

  if (input.language === "zh") {
    return [
      "请在新的恢复上下文中继续执行计划，不要复用上一轮错误链路。",
      input.hasTasksArtifact
        ? "按 `.MAIN/plans/tasks.md` 的顺序继续证据未满足的任务；每项完成最小必要读取、写入和声明验证后再进入下一项。只有已确认依赖要求时才调整顺序，并在工具结果中记录原因。只有真实写入/命令成功/验证证据满足后，才可以把任务视为完成。"
        : input.artifacts.length === 0
        ? "先读取当前 workspace 的 `.MAIN/plans/plan.md`；如果旧会话已存在 bugfix.md 或 requirements.md，可作为辅助上下文读取。不要默认读取 `.MAIN/plans/tasks.md`，除非它已在计划摘要中确认存在或用户明确要求。"
        : input.tasks.length > 0
        ? "当前已恢复 runtime 任务清单；请按顺序直接执行第一个证据未满足的任务，完成最小必要读取、写入和声明验证后再进入下一项。只有已确认依赖要求时才调整顺序，并在工具结果中记录原因。只有当任务较长、需要跨会话审计或用户要求留档时，才先把清单持久化到 `.MAIN/plans/tasks.md`；不要为了确认它是否存在而读取它。"
        : "请先基于已批准的 plan.md 派生 runtime 任务清单；只有长任务、跨会话恢复或需要审计留档时，才生成 `.MAIN/plans/tasks.md`；不要默认读取缺失的 tasks.md。然后执行真实任务。",
      "不要重写已经满足证据的任务；如果存在 tasks.md，不要只修改 checkbox；不要重复计划说明。",
      "",
      "计划文件摘要：",
      artifactText,
      "",
      "最近可信执行证据：",
      evidenceText,
      "",
      "优先恢复任务：",
      remainingText,
    ].join("\n");
  }

  return [
    "Continue plan execution in a fresh recovery context; do not reuse the previous errored loop.",
    input.hasTasksArtifact
      ? "Continue with the first evidence-unsatisfied task in checklist order. Complete its minimum necessary read, mutation, and declared validation before advancing; reorder only for a proven dependency and record the reason in the tool result. Treat a task as complete only after real file-write, successful command, Browser/Playwright DOM/screenshot evidence, or explicit pending user validation exists."
      : input.artifacts.length === 0
      ? "First read `.MAIN/plans/plan.md` from the current workspace; if a legacy bugfix.md or requirements.md exists, use it only as supporting context. Do not read `.MAIN/plans/tasks.md` by default unless it is confirmed in the plan summary or the user explicitly asks for it."
      : input.tasks.length > 0
      ? "A runtime task list is already available; execute the first evidence-unsatisfied task in order, then advance only after its minimum necessary read, mutation, and declared validation. Reorder only for a proven dependency and record the reason in the tool result. Persist it to `.MAIN/plans/tasks.md` only when the task is long, cross-session, or explicitly needs an audit file; do not read it just to check existence."
      : "First derive a runtime task list from the approved plan.md. Generate `.MAIN/plans/tasks.md` only for long work, cross-session recovery, or audit-file needs; do not read missing tasks.md by default. Then execute real tasks.",
    "Do not redo tasks whose evidence is already satisfied. If tasks.md exists, do not only edit checkboxes. Do not restate the plan.",
    "",
    "Plan artifact summary:",
    artifactText,
    "",
    "Recent trusted execution evidence:",
    evidenceText,
    "",
    "Priority recovery tasks:",
    remainingText,
  ].join("\n");
}

export async function runSubmitPlanExecutionResumeEffect<TState extends SubmitPlanExecutionResumeState>(
  input: RunSubmitPlanExecutionResumeEffectInput<TState>,
): Promise<void> {
  input.applyPreRunSessionPatch({
    input: "",
    contextMentions: [],
    attachedFiles: [],
    lockedComposerIntent: null,
    pendingRunDecision: null,
  });

  const shouldHydrateExistingPlan =
    looksLikeExistingPlanExecutionRequest(input.text) ||
    input.shouldRouteContinuationToPlanResume;
  let latest = input.getState();
  let hydratedForExecution:
    | { artifacts: PlanArtifact[]; tasks: PlanTask[]; hasTasksArtifact: boolean }
    | null = null;

  if (shouldHydrateExistingPlan) {
    const alreadyHydrated = getReviewablePlanArtifacts(latest.planArtifacts).length > 0;
    const hydrated = alreadyHydrated
      ? {
          artifacts: latest.planArtifacts,
          tasks: latest.planTasks,
          hasTasksArtifact:
            latest.planArtifacts.some((artifact) => artifact.kind === "tasks") ||
            latest.planTasks.length > 0,
        }
      : await input.hydrateExistingPlanArtifactsForWorkspace(
          latest.currentWorkspace,
          input.preferredLanguage,
        );
    hydratedForExecution = hydrated;
    latest = input.getState();
    input.setState({
      planArtifacts: hydrated.artifacts,
      planTasks: hydrated.tasks,
      showPlanPanel: true,
      rightPanelTab: "plan",
      showDiff: false,
    });
    input.logStoreEvent("existing_plan_hydrated_for_execution", {
      workspace: latest.currentWorkspace || null,
      reusedExistingState: alreadyHydrated,
      artifacts: hydrated.artifacts.map((artifact) => artifact.path),
      taskCount: hydrated.tasks.length,
    });
  }

  latest = input.getState();
  const resumePlanTasks = input.ensureApprovedPlanRuntimeTasksForState(
    latest,
    input.preferredLanguage,
  );
  if (resumePlanTasks.length > 0) {
    input.setState({ planTasks: resumePlanTasks });
    latest = input.getState();
  }
  const executionReadiness = evaluateApprovedPlanExecutionReadiness({
    planArtifacts: latest.planArtifacts,
    executionPlanTasks: resumePlanTasks.length > 0 ? resumePlanTasks : latest.planTasks,
  });
  const continuationTurnId = input.uiParentTurnId || latest.currentTurnId || undefined;
  const restoredTaskIdentity = resolveRestoredPlanExecutionTaskIdentity({
    snapshot: latest.planExecutionProgressSnapshot,
    tasks: resumePlanTasks.length > 0 ? resumePlanTasks : latest.planTasks,
  });
  const progressOwnerMismatch = Boolean(
    latest.planExecutionProgressSnapshot &&
    continuationTurnId &&
    latest.planExecutionProgressSnapshot.turnId !== continuationTurnId
  );
  const progressRunId = String(latest.planExecutionProgressSnapshot?.runId || "").trim();
  const markerRunId = getHarnessActionRunId(latest.harnessRunMarker);
  const progressParentRunId = latest.planExecutionProgressSnapshot?.parentRunId || null;
  const markerParentRunId = latest.harnessRunMarker?.activeParentRunId ||
    latest.harnessRunMarker?.parentRunId ||
    null;
  const progressRunOwnerMismatch = Boolean(
    progressRunId &&
    (
      !markerRunId ||
      markerRunId !== progressRunId ||
      markerParentRunId !== progressParentRunId ||
      latest.harnessRunMarker?.turnId !== latest.planExecutionProgressSnapshot?.turnId
    )
  );
  if (
    !executionReadiness.ok ||
    restoredTaskIdentity.ambiguous ||
    progressOwnerMismatch ||
    progressRunOwnerMismatch
  ) {
    const reason = !executionReadiness.ok
      ? executionReadiness.reason || "plan_execution_materialization_failed"
      : progressOwnerMismatch
      ? "plan_resume_progress_owner_mismatch"
      : progressRunOwnerMismatch
      ? "plan_resume_progress_run_owner_mismatch"
      : "ambiguous_plan_resume_task_identity";
    const qualityReason = executionReadiness.qualityReason || null;
    const message = input.preferredLanguage === "zh"
      ? `现有计划未通过重新校验，已保留为审计记录并撤销执行批准（${qualityReason || reason}）。请修订或重新生成计划后再执行。`
      : `The existing plan failed revalidation, so MAIN kept it as an audit record and revoked execution approval (${qualityReason || reason}). Revise or regenerate the plan before executing it.`;
    input.setState({
      isPlanApproved: false,
      planApprovalChoice: null,
      planStage: "plan",
      planTasks: [],
      planExecutionEvidenceLedger: [],
      planExecutionEvidenceCount: 0,
      planAutoResumeCount: 0,
      planExecutionProgressSnapshot: null,
      showPlanPanel: true,
      rightPanelTab: "plan",
      showDiff: false,
    });
    input.logStoreEvent("existing_plan_resume_revalidation_blocked", {
      workspace: latest.currentWorkspace || null,
      reason,
      qualityReason,
      ambiguousTaskIdentity: restoredTaskIdentity.ambiguous,
      progressOwnerMismatch,
      progressRunOwnerMismatch,
    });
    input.onResumeBlocked?.(message, { reason, qualityReason });
    return;
  }

  input.setState({
    isPlanApproved: true,
    planApprovalChoice: input.text.trim() || null,
    planStage: "executing",
    planTasks: resumePlanTasks.length > 0 ? resumePlanTasks : latest.planTasks,
    planAutoResumeCount: 0,
    planExecutionProgressSnapshot: latest.planExecutionProgressSnapshot
      ? {
          ...latest.planExecutionProgressSnapshot,
          ...(restoredTaskIdentity.currentTaskId
            ? { currentTaskId: restoredTaskIdentity.currentTaskId }
            : {}),
        }
      : null,
  });
  latest = input.getState();
  const hasTasksArtifact =
    (hydratedForExecution?.artifacts || latest.planArtifacts).some((artifact) => artifact.kind === "tasks") ||
    resumePlanTasks.length > 0 ||
    (hydratedForExecution?.tasks || latest.planTasks).length > 0;

  input.resumeSubmission(
    buildTrustedPlanResumePrompt({
      language: input.preferredLanguage,
      hasTasksArtifact,
      tasks: resumePlanTasks.length > 0 ? resumePlanTasks : latest.planTasks,
      artifacts: latest.planArtifacts,
      evidenceLedger: latest.planExecutionEvidenceLedger,
    }),
    undefined,
    {
      hidden: true,
      createVisibleTurnForHiddenMessage: !continuationTurnId,
      reuseCurrentTurn: !!continuationTurnId,
      turnIdOverride: continuationTurnId,
      preservePlanState: true,
      resolvedIntent: "execute",
      commandDirective: input.commandDirective,
      executionConsentGranted: true,
      skipIntentResolution: true,
      turnTitle: input.preferredLanguage === "zh" ? "计划执行恢复" : "Plan Execution Resume",
      intentSummary: input.preferredLanguage === "zh"
        ? "从已批准计划的剩余任务继续执行。"
        : "Resume execution from the remaining tasks in the approved plan.",
    },
  );
}
