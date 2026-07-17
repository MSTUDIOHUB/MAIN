import { useEffect, useMemo, useRef, useState } from "react";
import MarkdownRenderer from "./MarkdownRenderer";
import { IconCheck, IconSave } from "./Icons";
import { buildPlanTaskEvidenceAudit, extractPlanTasks, isPlanConversationTurn, isPlanTaskAwaitingBrowserValidation, isPlanTaskAwaitingExternalValidation, isPlanTaskTrustedComplete, type ConversationTurn, type PlanArtifact, type PlanExecutionEvidenceEntry, type PlanStage, type PlanTask } from "../lib/workflowModels";
import {
  resolvePlanPresentationBehavior,
  resolveTurnPresentationLifecycle,
  type TurnPresentationModel,
} from "../lib/turnPresentation";
import { getReviewablePlanArtifacts } from "../lib/planApprovalIdentity";

interface PlanPanelProps {
  presentation?: TurnPresentationModel;
  artifacts: PlanArtifact[];
  tasks: PlanTask[];
  evidenceLedger?: PlanExecutionEvidenceEntry[];
  stage: PlanStage;
  isAwaitingApproval: boolean;
  isAwaitingInput?: boolean;
  canApproveExecution: boolean;
  canContinuePlanning?: boolean;
  canResumeExecution?: boolean;
  hideIslandOwnedSections?: boolean;
  isTemporaryWorkspace?: boolean;
  isApproved: boolean;
  language?: "zh" | "en";
  turns: ConversationTurn[];
  fallbackPreview?: string;
  fallbackTitle?: string;
  fallbackUpdatedAt?: number;
  onDeletePlanFiles?: () => void;
  onDeleteBrowserValidationFiles?: () => void;
  onContinuePlanning?: () => void;
  onRequestAdjustment?: (text: string) => void;
  onResumeExecution?: () => void;
  onSaveDocument?: (document: { title: string; suggestedFileName: string; content: string; sourcePath?: string }) => Promise<boolean> | boolean;
  onApprove: () => void;
  onReject: () => void;
  onRejectAndDelete?: () => void;
}

const COPY = {
  zh: {
    workspaceTitle: "计划工作区",
    currentPlan: "本轮计划",
    previewTitle: "方案预览",
    draftPreview: "候选草稿",
    draftPreviewHint: "尚未形成通过校验的正式计划",
    pendingApproval: "待审批",
    awaitingChoice: "待选择",
    actionRequired: "待处理",
    paused: "已暂停",
    stopped: "未执行",
    failed: "失败",
    taskProgress: "任务进度",
    retained: "保留记录",
    completed: "完成",
    inProgress: "进行中",
    missingEvidence: "待验证",
    autoValidation: "自动验证",
    userValidation: "待用户验证",
    pending: "待办",
    rejectAndKeepPlan: "拒绝并保留",
    rejectAndDeletePlan: "拒绝并删除",
    deletePlanFiles: "删除计划文件",
    deleteBrowserValidationFiles: "清理验证截图",
    approvePlan: "确认方案并继续执行",
    adjustPlanPlaceholder: "说明需要如何调整，或提出其他要求",
    submitAdjustment: "提交意见",
    continuePlanning: "继续生成正式计划",
    resumeExecution: "继续执行剩余任务",
    saveDocument: "保存当前文档",
    savingDocument: "保存中...",
    savedDocument: "已保存",
    saveFailed: "保存失败",
    savePlanHint: "拒绝并保留会停止本轮但保留计划文件；拒绝并删除会同时清理 .MAIN/plans。",
    approvalRunningHint: "当前计划已经进入执行链路，右侧会持续显示最新文档与任务状态。",
    pausedExecutionHint: "检测到当前执行链路已中断，但任务进度已保留。可以从剩余任务继续恢复执行。",
    waitingPlanHint: "等待 Agent 生成可审批的计划正文，这里随后会显示预览、审批按钮和任务执行进度。",
    waitingChoiceHint: "Agent 已暂停，正在等待你在聊天区选择下一步。选定后会沿当前计划继续，不会偷偷往下执行。",
    emptyHint: "这里会显示计划文件预览、审批按钮和任务执行进度。",
    generatingFooter: "计划仍在补全中。先生成正式 plan.md 供确认，确认后再生成执行任务；数据分析类任务会优先形成分析方案，而不是直接改代码。",
    helperApproval: "计划已经准备完成。确认后会进入执行能力，写入与命令仍会逐项审查；如果当前是数据分析方案，也会继续保持分析/报表语义而不是默认切到代码实现。",
    helperChoice: "当前计划遇到了关键分叉，Agent 已暂停并等待你的选择。请先在聊天区点击一个选项，再继续生成正式方案或进入执行。",
    helperDraftPreview: "这是模型生成的候选草稿，尚未形成通过校验的正式计划，不能审批或执行。",
    helperIdle: "切换到 Plan 模式后，Agent 会先在 .MAIN/plans 中生成规划文件（可以是工程方案，也可以是分析方案），并在这里展示审批与执行进展。",
    helperExecuting: "执行阶段会尽量保持任务列表和计划文档同步更新。",
    helperCompleted: "计划执行完成。这里会保留摘要与任务状态，聊天区也可以继续查看完整过程。",
    helperActionRequired: "当前运行停在一个用户操作边界，但没有匹配到本计划的审批或选择请求。请返回所属回合处理该检查点。",
    helperNoAction: "本次计划运行已经结束，但没有进入执行。可以保留或清理计划文件后继续对话。",
    helperFailed: "计划运行失败。错误与检查点已保留，请先核对失败原因，再决定是否重新规划。",
    helperDefault: "计划文档和任务进度会优先显示在右侧，聊天区只保留结论与摘要。",
    temporaryWorkspaceHint: "当前在“聊天”里，文档已暂存到临时 .tmp 文件夹。请先保存到本地路径，再选择对应文件夹继续操作。",
    stage: {
      idle: "待生成",
      plan: "计划阶段",
      requirements: "需求阶段",
      design: "历史计划",
      tasks: "任务阶段",
      bugfix: "修复阶段",
      ready_to_execute: "等待执行",
      executing: "执行中",
      completed: "已完成",
    } as Record<PlanStage, string>,
  },
  en: {
    workspaceTitle: "Plan Workspace",
    currentPlan: "Current Plan",
    previewTitle: "Plan Preview",
    draftPreview: "Candidate Draft",
    draftPreviewHint: "A validated plan artifact has not been created yet",
    pendingApproval: "Awaiting Approval",
    awaitingChoice: "Awaiting Choice",
    actionRequired: "Action Required",
    paused: "Paused",
    stopped: "No Action",
    failed: "Failed",
    taskProgress: "Task Progress",
    retained: "Retained",
    completed: "Done",
    inProgress: "In Progress",
    missingEvidence: "Needs Evidence",
    autoValidation: "Auto Validation",
    userValidation: "User Validation",
    pending: "Pending",
    rejectAndKeepPlan: "Reject And Keep",
    rejectAndDeletePlan: "Reject And Delete",
    deletePlanFiles: "Delete Plan Files",
    deleteBrowserValidationFiles: "Clear Validation Shots",
    approvePlan: "Approve Plan And Continue",
    adjustPlanPlaceholder: "Describe changes or add another requirement",
    submitAdjustment: "Submit Feedback",
    continuePlanning: "Continue Planning",
    resumeExecution: "Resume Execution",
    saveDocument: "Save Current Doc",
    savingDocument: "Saving...",
    savedDocument: "Saved",
    saveFailed: "Save Failed",
    savePlanHint: "Reject and keep stops this turn while preserving plan files; reject and delete also clears .MAIN/plans.",
    approvalRunningHint: "The plan is now in the execution chain and the right panel will keep tracking document and task updates.",
    pausedExecutionHint: "Execution was interrupted, but the task progress is preserved. You can resume from the remaining tasks.",
    waitingPlanHint: "Waiting for the agent to generate a reviewable plan. The preview, approval actions, and task progress will appear here.",
    waitingChoiceHint: "The agent is paused and waiting for your choice in chat. After you choose, it will continue the current plan instead of silently moving on.",
    emptyHint: "Plan previews, approval actions, and execution progress will appear here.",
    generatingFooter: "The plan is still being completed. Finish the formal plan proposal first; tasks will be generated after approval. Data-analysis plans should stay analysis-first instead of jumping straight to code changes.",
    helperApproval: "The plan is ready. After approval, execution tools are enabled while writes and commands remain review-gated. Data-analysis plans should keep their analysis/reporting semantics instead of defaulting to code implementation.",
    helperChoice: "The current plan hit a real branch point, so the agent is paused and waiting for your choice. Pick an option in chat before continuing the plan or execution.",
    helperDraftPreview: "This is a model-authored candidate. It is not a validated plan and cannot be approved or executed.",
    helperIdle: "In Plan mode, the agent will first generate planning files in .MAIN/plans, whether they are engineering specs or analysis-plan documents, and then show review and execution progress here.",
    helperExecuting: "During execution, the task list and plan documents will stay in sync as much as possible.",
    helperCompleted: "Plan execution is complete. This panel keeps the summary and task state while the chat still shows the full process.",
    helperActionRequired: "The run is waiting at a user boundary, but no matching Plan review or choice request owns this panel. Handle the checkpoint in its original turn.",
    helperNoAction: "This planning run ended without entering execution. You can keep or clear the plan files before continuing.",
    helperFailed: "The planning run failed. Its error and checkpoint are preserved; review the cause before planning again.",
    helperDefault: "Plan documents and task progress are prioritized on the right, while chat keeps only the conclusion and summary.",
    temporaryWorkspaceHint: "These docs are currently stored in a temporary .tmp chat folder. Save them to a local path, then continue from that folder.",
    stage: {
      idle: "Idle",
      plan: "Plan",
      requirements: "Requirements",
      design: "Legacy Plan",
      tasks: "Tasks",
      bugfix: "Bugfix",
      ready_to_execute: "Ready To Execute",
      executing: "Executing",
      completed: "Completed",
    } as Record<PlanStage, string>,
  },
} as const;

function getStageTone(stage: PlanStage): string {
  switch (stage) {
    case "ready_to_execute":
      return "text-[#fbbf24] border-[rgba(251,191,36,0.25)] bg-[rgba(251,191,36,0.12)]";
    case "executing":
      return "text-[#60a5fa] border-[rgba(96,165,250,0.25)] bg-[rgba(96,165,250,0.12)]";
    case "completed":
      return "text-[#34d399] border-[rgba(52,211,153,0.25)] bg-[rgba(52,211,153,0.12)]";
    case "bugfix":
      return "text-[#fb7185] border-[rgba(251,113,133,0.25)] bg-[rgba(251,113,133,0.12)]";
    default:
      return "theme-plan-pill";
  }
}

export default function PlanPanel({
  presentation,
  artifacts,
  tasks,
  evidenceLedger = [],
  stage,
  isAwaitingApproval,
  isAwaitingInput = false,
  canApproveExecution,
  canContinuePlanning = false,
  canResumeExecution = false,
  hideIslandOwnedSections = false,
  isTemporaryWorkspace = false,
  isApproved,
  language = "zh",
  turns,
  fallbackPreview = "",
  fallbackTitle,
  fallbackUpdatedAt,
  onDeletePlanFiles,
  onDeleteBrowserValidationFiles,
  onContinuePlanning,
  onRequestAdjustment,
  onResumeExecution,
  onSaveDocument,
  onApprove,
  onReject,
  onRejectAndDelete,
}: PlanPanelProps) {
  const copy = COPY[language];
  const [activeArtifactPath, setActiveArtifactPath] = useState<string>(artifacts[artifacts.length - 1]?.path || "");
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [isApproving, setIsApproving] = useState(false);
  const [adjustmentText, setAdjustmentText] = useState("");
  const approvingRef = useRef(false);
  const previewMarkdown = fallbackPreview.trim();
  const hasReviewablePlanArtifact = useMemo(
    () => getReviewablePlanArtifacts(artifacts).length > 0,
    [artifacts],
  );
  const displayArtifacts = useMemo(
    () => (hasReviewablePlanArtifact || !previewMarkdown ? artifacts : []),
    [artifacts, hasReviewablePlanArtifact, previewMarkdown],
  );

  useEffect(() => {
    if (isApproved || stage === "executing" || stage === "completed") {
      approvingRef.current = false;
      setIsApproving(false);
    }
  }, [isApproved, stage]);

  const handleApprove = () => {
    if (approvingRef.current || isApproving || isApproved) return;
    approvingRef.current = true;
    setIsApproving(true);
    onApprove();
  };

  useEffect(() => {
    if (!displayArtifacts.length) {
      setActiveArtifactPath("");
      return;
    }
    if (!displayArtifacts.some((artifact) => artifact.path === activeArtifactPath)) {
      setActiveArtifactPath(displayArtifacts[displayArtifacts.length - 1].path);
    }
  }, [displayArtifacts, activeArtifactPath]);

  useEffect(() => {
    setSaveState("idle");
  }, [activeArtifactPath, fallbackPreview, fallbackTitle]);

  const activeArtifact = displayArtifacts.find((artifact) => artifact.path === activeArtifactPath) || displayArtifacts[displayArtifacts.length - 1];
  const isCandidateOnly = !hasReviewablePlanArtifact && previewMarkdown.length > 0;
  const displayTasks = useMemo(
    () => (tasks.length > 0 ? tasks : previewMarkdown ? extractPlanTasks(previewMarkdown) : []),
    [tasks, previewMarkdown],
  );
  const taskAudit = useMemo(
    () => buildPlanTaskEvidenceAudit({ tasks: displayTasks, evidenceLedger }),
    [displayTasks, evidenceLedger],
  );
  const auditedTasks = taskAudit.tasks;
  const doneCount = taskAudit.completedCount;
  const progressPct = taskAudit.totalCount > 0 ? Math.round((doneCount / taskAudit.totalCount) * 100) : 0;
  const activeTurn = [...turns].reverse().find((turn) => isPlanConversationTurn(turn)) || turns[turns.length - 1];
  const showTaskProgress = (isApproved || stage === "executing" || stage === "completed") && auditedTasks.length > 0;
  const legacyLifecycle = resolveTurnPresentationLifecycle(
    isAwaitingApproval
      ? "awaiting_approval"
      : isAwaitingInput
      ? "awaiting_input"
      : canContinuePlanning || canResumeExecution
      ? "paused"
      : stage === "completed"
      ? "done"
      : stage === "executing"
      ? "executing"
      : "planning",
  );
  const presentationBehavior = resolvePlanPresentationBehavior({
    lifecycle: presentation?.lifecycle || legacyLifecycle,
    actionKind: presentation?.actionKind || (
      !presentation && isAwaitingApproval
        ? "plan_review"
        : !presentation && isAwaitingInput
        ? "user_choice"
        : undefined
    ),
    canApproveExecution,
    canContinuePlanning,
    canResumeExecution,
  });
  const stageLabel = presentationBehavior.mode === "review"
    ? copy.pendingApproval
    : presentationBehavior.mode === "choice"
    ? copy.awaitingChoice
    : presentationBehavior.mode === "action_required"
    ? copy.actionRequired
    : isCandidateOnly
    ? copy.draftPreview
    : presentationBehavior.mode === "resumable"
    ? copy.paused
    : presentationBehavior.mode === "success"
    ? copy.stage.completed
    : presentationBehavior.mode === "no_action"
    ? copy.stopped
    : presentationBehavior.mode === "failed"
    ? copy.failed
    : copy.stage[stage];
  const stageTone = presentationBehavior.mode === "failed"
    ? getStageTone("bugfix")
    : presentationBehavior.mode === "success"
    ? getStageTone("completed")
    : presentationBehavior.mode === "review" ||
      presentationBehavior.mode === "choice" ||
      presentationBehavior.mode === "action_required" ||
      presentationBehavior.mode === "resumable"
    ? getStageTone("ready_to_execute")
    : presentationBehavior.mode === "no_action" || (stage === "idle" && previewMarkdown)
    ? getStageTone("design")
    : getStageTone(stage);

  const helperText = useMemo(() => {
    if (presentationBehavior.mode === "review") {
      return copy.helperApproval;
    }
    if (presentationBehavior.mode === "choice") {
      return copy.helperChoice;
    }
    if (presentationBehavior.mode === "action_required") return copy.helperActionRequired;
    if (isCandidateOnly) return copy.helperDraftPreview;
    if (presentationBehavior.mode === "resumable") return copy.pausedExecutionHint;
    if (presentationBehavior.mode === "success") return copy.helperCompleted;
    if (presentationBehavior.mode === "no_action") return copy.helperNoAction;
    if (presentationBehavior.mode === "failed") return copy.helperFailed;
    if (stage === "idle") {
      return copy.helperIdle;
    }
    if (stage === "executing") {
      return copy.helperExecuting;
    }
    if (stage === "completed") {
      return copy.helperCompleted;
    }
    return copy.helperDefault;
  }, [copy, isCandidateOnly, presentationBehavior.mode, stage]);

  const currentDocument = activeArtifact
    ? {
        title: activeArtifact.title,
        suggestedFileName: activeArtifact.path.split("/").pop() || `${activeArtifact.title}.md`,
        content: activeArtifact.content,
        sourcePath: activeArtifact.path,
      }
    : previewMarkdown
    ? {
        title: fallbackTitle || activeTurn?.title || copy.previewTitle,
        suggestedFileName: `${(fallbackTitle || activeTurn?.title || copy.previewTitle)
          .replace(/[\\/:*?"<>|]+/g, "-")
          .replace(/\s+/g, "-")
          .toLowerCase() || "plan-preview"}.md`,
        content: previewMarkdown,
      }
    : null;

  const handleSaveDocument = async () => {
    if (!currentDocument || !onSaveDocument) return;
    setSaveState("saving");
    try {
      const saved = await onSaveDocument(currentDocument);
      setSaveState(saved ? "saved" : "idle");
    } catch (error) {
      console.error("[PlanPanel] failed to save document:", error);
      setSaveState("error");
    }
  };

  const saveButtonLabel =
    saveState === "saving"
      ? copy.savingDocument
      : saveState === "saved"
      ? copy.savedDocument
      : saveState === "error"
      ? copy.saveFailed
      : copy.saveDocument;

  const saveButtonTone =
    saveState === "saved"
      ? "border-[rgba(52,211,153,0.28)] bg-[rgba(52,211,153,0.12)] text-[#86efac]"
      : saveState === "error"
      ? "border-[rgba(251,113,133,0.28)] bg-[rgba(251,113,133,0.12)] text-[#fda4af]"
      : "border-[#3f3f46] bg-[#09090b] text-[#d4d4d8] hover:bg-[#18181b] hover:text-[#f5f5f5]";

  return (
    <div
      data-testid="plan-review-panel"
      data-turn-id={presentation?.turnId}
      data-run-id={presentation?.runId}
      data-request-id={presentation?.requestId}
      data-turn-lifecycle={presentation?.lifecycle}
      data-action-kind={presentation?.actionKind}
      data-plan-presentation={presentationBehavior.mode}
      data-plan-document-kind={hasReviewablePlanArtifact ? "artifact" : isCandidateOnly ? "candidate" : "empty"}
      className="plan-review-panel flex h-full flex-col bg-[#050505]"
    >
      <div className="border-b border-[#27272a] px-4 py-3 bg-[#09090b]">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-[12px] font-semibold tracking-[0.18em] uppercase text-[#71717a]">{copy.workspaceTitle}</div>
            <div className="mt-1 text-[15px] font-semibold text-[#f5f5f5] break-words">
              {activeTurn?.title || copy.currentPlan}
            </div>
            <div className="mt-1 text-[12px] leading-relaxed text-[#a1a1aa]">{helperText}</div>
            {isTemporaryWorkspace && (
              <div className="mt-3 rounded-xl border border-[rgba(251,191,36,0.22)] bg-[rgba(251,191,36,0.08)] px-3 py-2 text-[11px] leading-relaxed text-[#fcd34d]">
                {copy.temporaryWorkspaceHint}
              </div>
            )}
          </div>
          <span data-testid="plan-stage-badge" className={`shrink-0 rounded-full border px-2.5 py-1 text-[10px] font-semibold ${stageTone}`}>
            {stageLabel}
          </span>
        </div>

        {showTaskProgress && (
          <div data-testid="plan-task-progress" className="mt-4 rounded-xl border border-[#1f1f23] bg-[#0d0d11] p-3">
            <div className="flex items-center justify-between text-[11px] text-[#a1a1aa]">
              <span>{copy.taskProgress}</span>
              <span>{doneCount}/{taskAudit.totalCount}</span>
            </div>
            <div className="mt-2 h-2 overflow-hidden rounded-full bg-[#18181b]">
              <div
                className="theme-plan-progress h-full rounded-full transition-all duration-300"
                style={{ width: `${progressPct}%` }}
              />
            </div>
            <div className="mt-3 space-y-2">
              {auditedTasks.map((task) => (
                <div
                  key={task.id}
                  data-testid="plan-task-row"
                  className="flex items-start gap-2 rounded-lg border border-[#18181b] bg-[#09090b] px-3 py-2"
                >
                  <span
                    className={`mt-[2px] h-4 w-4 shrink-0 rounded-full border flex items-center justify-center ${
                      isPlanTaskTrustedComplete(task)
                        ? "border-[#34d399] bg-[#34d399] text-[#050507]"
                        : task.status === "in_progress"
                        ? "border-[#60a5fa] bg-[#60a5fa]"
                        : "border-[#3f3f46] bg-transparent"
                    }`}
                  >
                    {isPlanTaskTrustedComplete(task) && (
                      <svg className="h-2.5 w-2.5" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M2.5 6L5 8.5L9.5 3.5" />
                      </svg>
                    )}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="text-[12px] leading-relaxed text-[#e4e4e7]">{task.text}</div>
                    {(task.requirementRef || task.retained) && (
                      <div className="mt-1 flex flex-wrap items-center gap-2">
                        {task.requirementRef && (
                          <span className="text-[10px] tracking-wide text-[#71717a]">{task.requirementRef}</span>
                        )}
                        {task.retained && (
                          <span className="rounded-full border border-[rgba(251,191,36,0.24)] bg-[rgba(251,191,36,0.1)] px-2 py-0.5 text-[10px] text-[#fcd34d]">
                            {copy.retained}
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                  <div data-testid="plan-task-status" className="text-[10px] text-[#71717a] whitespace-nowrap">
                    {isPlanTaskTrustedComplete(task)
                      ? copy.completed
                      : isPlanTaskAwaitingExternalValidation(task)
                      ? copy.userValidation
                      : isPlanTaskAwaitingBrowserValidation(task)
                      ? copy.autoValidation
                      : task.claimedStatus === "completed" && task.evidenceStatus !== "satisfied"
                      ? copy.missingEvidence
                      : task.status === "in_progress" ? copy.inProgress : copy.pending}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

      </div>

      {displayArtifacts.length > 0 ? (
        <>
          <div className="flex flex-wrap gap-2 border-b border-[#18181b] bg-[#070709] px-4 py-2">
            {displayArtifacts.map((artifact) => {
              const active = artifact.path === activeArtifact?.path;
              return (
                <button
                  key={artifact.path}
                  onClick={() => setActiveArtifactPath(artifact.path)}
                  className={`rounded-full border px-3 py-1.5 text-[11px] transition-colors ${
                    active
                      ? "theme-plan-button"
                      : "border-[#27272a] bg-[#09090b] text-[#a1a1aa] hover:bg-[#18181b] hover:text-[#e4e4e7]"
                  }`}
                >
                  {artifact.title}
                </button>
              );
            })}
          </div>

          <div className="flex-1 overflow-y-auto px-5 py-4">
            {activeArtifact ? (
              <div className="rounded-2xl border border-[#18181b] bg-[#09090b] p-5">
                <div className="mb-4 flex items-center justify-between gap-3 border-b border-[#18181b] pb-3">
                  <div>
                    <div className="text-[14px] font-semibold text-[#f5f5f5]">{activeArtifact.title}</div>
                    <div className="mt-1 break-all font-mono text-[11px] text-[#71717a]">{activeArtifact.path}</div>
                  </div>
                  <div className="flex items-center gap-2">
                    {currentDocument && onSaveDocument && (
                      <button
                        data-testid="plan-save-button"
                        data-save-state={saveState}
                        onClick={handleSaveDocument}
                        disabled={saveState === "saving"}
                        title={saveButtonLabel}
                        aria-label={saveButtonLabel}
                        className={`rounded-lg border p-2 transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${saveButtonTone}`}
                      >
                        {saveState === "saved" ? <IconCheck className="h-4 w-4" /> : <IconSave className="h-4 w-4" />}
                      </button>
                    )}
                    <div className="text-[10px] text-[#71717a]">{new Date(activeArtifact.updatedAt).toLocaleTimeString()}</div>
                  </div>
                </div>
                <MarkdownRenderer content={activeArtifact.content} />
              </div>
            ) : null}
          </div>
        </>
      ) : previewMarkdown ? (
        <div className="flex-1 overflow-y-auto px-5 py-4">
          <div className="rounded-2xl border border-[#18181b] bg-[#09090b] p-5">
            <div className="mb-4 flex items-center justify-between gap-3 border-b border-[#18181b] pb-3">
              <div>
                <div className="text-[14px] font-semibold text-[#f5f5f5]">{fallbackTitle || activeTurn?.title || copy.previewTitle}</div>
                <div className="mt-1 text-[11px] text-[#71717a]">
                  {copy.draftPreviewHint}
                </div>
              </div>
              <div className="flex items-center gap-2">
                {currentDocument && onSaveDocument && (
                  <button
                    data-testid="plan-save-button"
                    data-save-state={saveState}
                    onClick={handleSaveDocument}
                    disabled={saveState === "saving"}
                    title={saveButtonLabel}
                    aria-label={saveButtonLabel}
                    className={`rounded-lg border p-2 transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${saveButtonTone}`}
                  >
                    {saveState === "saved" ? <IconCheck className="h-4 w-4" /> : <IconSave className="h-4 w-4" />}
                  </button>
                )}
                <div className="text-[10px] text-[#71717a]">
                  {fallbackUpdatedAt ? new Date(fallbackUpdatedAt).toLocaleTimeString() : language === "zh" ? "刚刚" : "Just now"}
                </div>
              </div>
            </div>
            <MarkdownRenderer content={previewMarkdown} />
          </div>
        </div>
      ) : (
        <div className="flex flex-1 items-center justify-center px-8 text-center text-[13px] leading-relaxed text-[#71717a]">
          {presentationBehavior.mode === "review"
            ? copy.waitingPlanHint
            : presentationBehavior.mode === "choice"
            ? copy.waitingChoiceHint
            : copy.emptyHint}
        </div>
      )}

      {(!hideIslandOwnedSections || presentationBehavior.showResumeExecution) && (
        presentationBehavior.mode === "review" ||
        presentationBehavior.mode === "choice" ||
        presentationBehavior.showContinuePlanning ||
        presentationBehavior.showResumeExecution ||
        isApproved ||
        ((artifacts.length > 0 || previewMarkdown) && !isApproved)
      ) && (
        <div className="plan-review-footer border-t border-[#18181b] bg-[#09090b] px-4 py-3">
          {presentationBehavior.showReviewActions ? (
            <div data-testid="plan-review-actions" className="space-y-3">
              {onRequestAdjustment && (
                <form
                  data-testid="plan-adjust-form"
                  className="flex min-w-0 items-center gap-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    const text = adjustmentText.trim();
                    if (!text) return;
                    onRequestAdjustment(text);
                    setAdjustmentText("");
                  }}
                >
                  <input
                    data-testid="plan-adjust-input"
                    value={adjustmentText}
                    onChange={(event) => setAdjustmentText(event.target.value)}
                    placeholder={copy.adjustPlanPlaceholder}
                    className="min-w-0 flex-1 rounded-lg border border-[#27272a] bg-[#050507] px-3 py-2 text-[12px] text-[#e4e4e7] outline-none transition-colors placeholder:text-[#71717a] focus:border-[var(--accent)]"
                  />
                  <button
                    data-testid="plan-adjust-submit"
                    type="submit"
                    disabled={!adjustmentText.trim()}
                    className="theme-plan-button shrink-0 rounded-lg border px-3 py-2 text-[12px] font-semibold disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {copy.submitAdjustment}
                  </button>
                </form>
              )}
              <div className="plan-review-action-row flex items-center justify-between gap-3">
                <div className="text-[11px] leading-relaxed text-[#71717a]">
                  {copy.savePlanHint}
                </div>
                <div className="plan-review-button-group flex flex-wrap items-center justify-end gap-3">
                  <button
                    data-testid="plan-reject-button"
                    onClick={onReject}
                    className="rounded-lg border border-[#3f3f46] bg-[#09090b] px-4 py-2 text-[12px] font-medium text-[#a1a1aa] transition-colors hover:bg-[#18181b] hover:text-[#f5f5f5]"
                  >
                    {copy.rejectAndKeepPlan}
                  </button>
                  {artifacts.length > 0 && onRejectAndDelete && (
                    <button
                      data-testid="plan-reject-delete-button"
                      onClick={onRejectAndDelete}
                      className="rounded-lg border border-[rgba(244,63,94,0.35)] bg-[#09090b] px-4 py-2 text-[12px] font-medium text-[#fb7185] transition-colors hover:bg-[rgba(244,63,94,0.12)] hover:text-[#fecdd3]"
                    >
                      {copy.rejectAndDeletePlan}
                    </button>
                  )}
                  <button
                    data-testid="plan-approve-button"
                    onClick={handleApprove}
                    disabled={isApproving || isApproved}
                    className={`theme-plan-primary rounded-lg px-4 py-2 text-[12px] font-semibold ${
                      (isApproving || isApproved) ? "opacity-50 cursor-not-allowed" : ""
                    }`}
                  >
                    {copy.approvePlan}
                  </button>
                </div>
              </div>
            </div>
          ) : presentationBehavior.showChoiceCheckpoint ? (
            <div className="flex items-center justify-between gap-3">
              <div className="text-[11px] leading-relaxed text-[#71717a]">
                {copy.waitingChoiceHint}
              </div>
              {artifacts.length > 0 && onDeletePlanFiles && (
                <button
                  onClick={onDeletePlanFiles}
                  className="shrink-0 rounded-lg border border-[#3f3f46] bg-[#09090b] px-4 py-2 text-[12px] font-medium text-[#a1a1aa] transition-colors hover:bg-[#18181b] hover:text-[#f5f5f5]"
                >
                  {copy.deletePlanFiles}
                </button>
              )}
            </div>
          ) : presentationBehavior.showContinuePlanning && onContinuePlanning ? (
            <div className="flex flex-wrap items-center justify-end gap-3">
              {artifacts.length > 0 && onDeletePlanFiles && (
                <button
                  onClick={onDeletePlanFiles}
                  className="rounded-lg border border-[#3f3f46] bg-[#09090b] px-4 py-2 text-[12px] font-medium text-[#a1a1aa] transition-colors hover:bg-[#18181b] hover:text-[#f5f5f5]"
                >
                  {copy.deletePlanFiles}
                </button>
              )}
              <button
                onClick={onReject}
                className="rounded-lg border border-[#3f3f46] bg-[#09090b] px-4 py-2 text-[12px] font-medium text-[#a1a1aa] transition-colors hover:bg-[#18181b] hover:text-[#f5f5f5]"
              >
                {copy.rejectAndKeepPlan}
              </button>
              {artifacts.length > 0 && onRejectAndDelete && (
                <button
                  onClick={onRejectAndDelete}
                  className="rounded-lg border border-[rgba(244,63,94,0.35)] bg-[#09090b] px-4 py-2 text-[12px] font-medium text-[#fb7185] transition-colors hover:bg-[rgba(244,63,94,0.12)] hover:text-[#fecdd3]"
                >
                  {copy.rejectAndDeletePlan}
                </button>
              )}
              <button
                onClick={onContinuePlanning}
                className="theme-plan-primary rounded-lg px-4 py-2 text-[12px] font-semibold"
              >
                {copy.continuePlanning}
              </button>
            </div>
          ) : presentationBehavior.showResumeExecution && onResumeExecution ? (
            <div className="flex items-center justify-between gap-3">
              <div className="text-[11px] leading-relaxed text-[#71717a]">
                {copy.pausedExecutionHint}
              </div>
              <button
                data-testid="plan-resume-button"
                onClick={onResumeExecution}
                className="theme-plan-primary shrink-0 rounded-lg px-4 py-2 text-[12px] font-semibold"
              >
                {copy.resumeExecution}
              </button>
            </div>
          ) : !isApproved ? (
            <div className="flex items-center justify-between gap-3">
              <div className="text-[11px] leading-relaxed text-[#71717a]">
                  {presentationBehavior.mode === "review" ? copy.savePlanHint : helperText}
              </div>
              {artifacts.length > 0 && onDeletePlanFiles && (
                <button
                  onClick={onDeletePlanFiles}
                  className="shrink-0 rounded-lg border border-[#3f3f46] bg-[#09090b] px-4 py-2 text-[12px] font-medium text-[#a1a1aa] transition-colors hover:bg-[#18181b] hover:text-[#f5f5f5]"
                >
                  {copy.deletePlanFiles}
                </button>
              )}
            </div>
          ) : (
            <div className="flex items-center justify-between gap-3">
              <div className="text-[11px] text-[#71717a]">
                {copy.approvalRunningHint}
              </div>
              {onDeleteBrowserValidationFiles && (
                <button
                  onClick={onDeleteBrowserValidationFiles}
                  className="shrink-0 rounded-lg border border-[#3f3f46] bg-[#09090b] px-4 py-2 text-[12px] font-medium text-[#a1a1aa] transition-colors hover:bg-[#18181b] hover:text-[#f5f5f5]"
                >
                  {copy.deleteBrowserValidationFiles}
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
