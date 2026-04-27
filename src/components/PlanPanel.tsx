import { useEffect, useMemo, useState } from "react";
import MarkdownRenderer from "./MarkdownRenderer";
import { IconCheck, IconSave } from "./Icons";
import { extractPlanTasks, isPlanConversationTurn, type ChangeEntry, type ConversationTurn, type PlanArtifact, type PlanStage, type PlanTask } from "../lib/workflowModels";

interface PlanPanelProps {
  artifacts: PlanArtifact[];
  tasks: PlanTask[];
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
  changeEntries?: ChangeEntry[];
  onDeletePlanFiles?: () => void;
  onContinuePlanning?: () => void;
  onResumeExecution?: () => void;
  onOpenChangeDiff?: (taskId: number) => void;
  onSaveDocument?: (document: { title: string; suggestedFileName: string; content: string; sourcePath?: string }) => Promise<boolean> | boolean;
  onApprove: () => void;
  onReject: () => void;
}

const COPY = {
  zh: {
    workspaceTitle: "计划工作区",
    currentPlan: "本轮计划",
    previewTitle: "方案预览",
    previewHint: "当前回合说明预览",
    pendingApproval: "待审批",
    awaitingChoice: "待选择",
    previewReady: "已生成预览",
    taskProgress: "任务进度",
    turnChanges: "本轮改动",
    changedFiles: "个文件",
    retained: "保留记录",
    completed: "完成",
    inProgress: "进行中",
    pending: "待办",
    cancelPlan: "取消计划",
    deletePlanFiles: "删除计划文件",
    approvePlan: "确认方案并继续执行",
    continuePlanning: "继续生成正式计划",
    resumeExecution: "继续执行剩余任务",
    saveDocument: "保存当前文档",
    savingDocument: "保存中...",
    savedDocument: "已保存",
    saveFailed: "保存失败",
    savePlanHint: "如果你现在只想保留方案，不想继续执行，可以先保存当前文档，再取消计划。",
    approvalRunningHint: "当前计划已经进入执行链路，右侧会持续显示最新文档与任务状态。",
    pausedExecutionHint: "检测到当前执行链路已中断，但任务进度已保留。可以从剩余任务继续恢复执行。",
    waitingPlanHint: "等待 Agent 生成可审批的计划正文，这里随后会显示预览、审批按钮和任务执行进度。",
    waitingChoiceHint: "Agent 已暂停，正在等待你在聊天区选择下一步。选定后会沿当前计划继续，不会偷偷往下执行。",
    emptyHint: "这里会显示计划文件预览、审批按钮和任务执行进度。",
    generatingFooter: "计划仍在补全中。先生成需求文档与正式方案预览，确认后再生成执行任务；数据分析类任务会优先形成分析方案，而不是直接改代码。",
    helperApproval: "计划已经准备完成。确认后会先生成执行任务清单，再按任务逐步执行；如果当前是数据分析方案，也会继续保持分析/报表语义而不是默认切到代码实现。",
    helperChoice: "当前计划遇到了关键分叉，Agent 已暂停并等待你的选择。请先在聊天区点击一个选项，再继续生成正式方案或进入执行。",
    helperIdlePreview: "正式的计划文件还没写入时，会先在这里展示当前回合的说明预览，避免右侧面板空白。",
    helperIdle: "切换到 Plan 模式后，Agent 会先在 .MAIN/plans 中生成规划文件（可以是工程方案，也可以是分析方案），并在这里展示审批与执行进展。",
    helperExecuting: "执行阶段会尽量保持任务列表和计划文档同步更新。",
    helperCompleted: "计划执行完成。这里会保留摘要与任务状态，聊天区也可以继续查看完整过程。",
    helperDefault: "计划文档和任务进度会优先显示在右侧，聊天区只保留结论与摘要。",
    temporaryWorkspaceHint: "当前在“聊天”里，文档已暂存到临时 .tmp 文件夹。请先保存到本地路径，再选择对应文件夹继续操作。",
    stage: {
      idle: "待生成",
      requirements: "需求阶段",
      design: "设计阶段",
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
    previewHint: "Current turn preview",
    pendingApproval: "Awaiting Approval",
    awaitingChoice: "Awaiting Choice",
    previewReady: "Preview Ready",
    taskProgress: "Task Progress",
    turnChanges: "Turn Changes",
    changedFiles: "files",
    retained: "Retained",
    completed: "Done",
    inProgress: "In Progress",
    pending: "Pending",
    cancelPlan: "Cancel Plan",
    deletePlanFiles: "Delete Plan Files",
    approvePlan: "Approve Plan And Continue",
    continuePlanning: "Continue Planning",
    resumeExecution: "Resume Execution",
    saveDocument: "Save Current Doc",
    savingDocument: "Saving...",
    savedDocument: "Saved",
    saveFailed: "Save Failed",
    savePlanHint: "If you only want to keep the plan for now, save the current document first and then cancel the plan.",
    approvalRunningHint: "The plan is now in the execution chain and the right panel will keep tracking document and task updates.",
    pausedExecutionHint: "Execution was interrupted, but the task progress is preserved. You can resume from the remaining tasks.",
    waitingPlanHint: "Waiting for the agent to generate a reviewable plan. The preview, approval actions, and task progress will appear here.",
    waitingChoiceHint: "The agent is paused and waiting for your choice in chat. After you choose, it will continue the current plan instead of silently moving on.",
    emptyHint: "Plan previews, approval actions, and execution progress will appear here.",
    generatingFooter: "The plan is still being completed. Finish the requirements and formal proposal first; tasks will be generated after approval. Data-analysis plans should stay analysis-first instead of jumping straight to code changes.",
    helperApproval: "The plan is ready. After approval, the agent will generate the execution tasks first and then continue. Data-analysis plans should keep their analysis/reporting semantics instead of defaulting to code implementation.",
    helperChoice: "The current plan hit a real branch point, so the agent is paused and waiting for your choice. Pick an option in chat before continuing the plan or execution.",
    helperIdlePreview: "Before a formal plan file is written, the current-turn preview is shown here so the panel never feels blank.",
    helperIdle: "In Plan mode, the agent will first generate planning files in .MAIN/plans, whether they are engineering specs or analysis-plan documents, and then show review and execution progress here.",
    helperExecuting: "During execution, the task list and plan documents will stay in sync as much as possible.",
    helperCompleted: "Plan execution is complete. This panel keeps the summary and task state while the chat still shows the full process.",
    helperDefault: "Plan documents and task progress are prioritized on the right, while chat keeps only the conclusion and summary.",
    temporaryWorkspaceHint: "These docs are currently stored in a temporary .tmp chat folder. Save them to a local path, then continue from that folder.",
    stage: {
      idle: "Idle",
      requirements: "Requirements",
      design: "Design",
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
      return "text-[#c4b5fd] border-[rgba(196,181,253,0.25)] bg-[rgba(196,181,253,0.12)]";
  }
}

export default function PlanPanel({
  artifacts,
  tasks,
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
  changeEntries = [],
  onDeletePlanFiles,
  onContinuePlanning,
  onResumeExecution,
  onOpenChangeDiff,
  onSaveDocument,
  onApprove,
  onReject,
}: PlanPanelProps) {
  const copy = COPY[language];
  const [activeArtifactPath, setActiveArtifactPath] = useState<string>(artifacts[artifacts.length - 1]?.path || "");
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");

  useEffect(() => {
    if (!artifacts.length) {
      setActiveArtifactPath("");
      return;
    }
    if (!artifacts.some((artifact) => artifact.path === activeArtifactPath)) {
      setActiveArtifactPath(artifacts[artifacts.length - 1].path);
    }
  }, [artifacts, activeArtifactPath]);

  useEffect(() => {
    setSaveState("idle");
  }, [activeArtifactPath, fallbackPreview, fallbackTitle]);

  const activeArtifact = artifacts.find((artifact) => artifact.path === activeArtifactPath) || artifacts[artifacts.length - 1];
  const previewMarkdown = fallbackPreview.trim();
  const displayTasks = useMemo(
    () => (tasks.length > 0 ? tasks : previewMarkdown ? extractPlanTasks(previewMarkdown) : []),
    [tasks, previewMarkdown],
  );
  const doneCount = displayTasks.filter((task) => task.status === "completed").length;
  const progressPct = displayTasks.length > 0 ? Math.round((doneCount / displayTasks.length) * 100) : 0;
  const compactChangeEntries = changeEntries.slice(0, 6);
  const activeTurn = [...turns].reverse().find((turn) => isPlanConversationTurn(turn)) || turns[turns.length - 1];
  const showTaskProgress = !hideIslandOwnedSections && (isApproved || stage === "executing" || stage === "completed") && displayTasks.length > 0;
  const stageLabel = isAwaitingApproval
    ? copy.pendingApproval
    : isAwaitingInput
    ? copy.awaitingChoice
    : stage === "idle" && previewMarkdown
    ? copy.previewReady
    : copy.stage[stage];
  const stageTone = isAwaitingApproval
    ? getStageTone("ready_to_execute")
    : isAwaitingInput
    ? getStageTone("ready_to_execute")
    : stage === "idle" && previewMarkdown
    ? getStageTone("design")
    : getStageTone(stage);

  const helperText = useMemo(() => {
    if (isAwaitingApproval) {
      return copy.helperApproval;
    }
    if (isAwaitingInput) {
      return copy.helperChoice;
    }
    if (stage === "idle" && previewMarkdown) {
      return copy.helperIdlePreview;
    }
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
  }, [copy, isAwaitingApproval, isAwaitingInput, previewMarkdown, stage]);

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
    <div className="flex h-full flex-col bg-[#050505]">
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
              <span>{doneCount}/{displayTasks.length}</span>
            </div>
            <div className="mt-2 h-2 overflow-hidden rounded-full bg-[#18181b]">
              <div
                className="h-full rounded-full transition-all duration-300"
                style={{ width: `${progressPct}%`, background: "linear-gradient(90deg, #7c3aed, #3b82f6)" }}
              />
            </div>
            <div className="mt-3 space-y-2">
              {displayTasks.map((task) => (
                <div key={task.id} className="flex items-start gap-2 rounded-lg border border-[#18181b] bg-[#09090b] px-3 py-2">
                  <span
                    className={`mt-[2px] h-4 w-4 shrink-0 rounded-full border flex items-center justify-center ${
                      task.status === "completed"
                        ? "border-[#34d399] bg-[#34d399] text-[#050507]"
                        : task.status === "in_progress"
                        ? "border-[#60a5fa] bg-[#60a5fa]"
                        : "border-[#3f3f46] bg-transparent"
                    }`}
                  >
                    {task.status === "completed" && (
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
                    {task.status === "completed" ? copy.completed : task.status === "in_progress" ? copy.inProgress : copy.pending}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {compactChangeEntries.length > 0 && (
          <div data-testid="plan-change-summary" className="mt-4 rounded-xl border border-[#1f2937] bg-[#060b14] p-3">
            <div className="flex items-center justify-between gap-3 text-[11px] text-[#93c5fd]">
              <span>{copy.turnChanges}</span>
              <span>{changeEntries.length} {copy.changedFiles}</span>
            </div>
            <div className="mt-3 space-y-2">
              {compactChangeEntries.map((entry) => {
                const content = (
                  <>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[12px] font-medium text-[#dbeafe]">{entry.displayTarget}</span>
                      <span className="block truncate text-[10px] text-[#64748b]">{entry.target}</span>
                    </span>
                    {entry.editCount > 1 && (
                      <span className="shrink-0 rounded-full border border-[#334155] bg-[#0f172a] px-2 py-0.5 text-[10px] text-[#cbd5e1]">
                        {language === "zh" ? `${entry.editCount} 次` : `${entry.editCount}x`}
                      </span>
                    )}
                    <span className="shrink-0 text-[10px] font-medium text-[#10b981]">+{entry.added}</span>
                    <span className="shrink-0 text-[10px] font-medium text-[#f87171]">-{entry.removed}</span>
                  </>
                );

                return onOpenChangeDiff ? (
                  <button
                    key={`${entry.target}-${entry.taskId}`}
                    type="button"
                    onClick={() => onOpenChangeDiff(entry.taskId)}
                    className="flex w-full min-w-0 items-center gap-2 rounded-lg border border-[#1e293b] bg-[#05070d] px-3 py-2 text-left transition-colors hover:border-[#2563eb]/35 hover:bg-[#09111f]"
                  >
                    {content}
                  </button>
                ) : (
                  <div key={`${entry.target}-${entry.taskId}`} className="flex w-full min-w-0 items-center gap-2 rounded-lg border border-[#1e293b] bg-[#05070d] px-3 py-2">
                    {content}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {artifacts.length > 0 ? (
        <>
          <div className="flex flex-wrap gap-2 border-b border-[#18181b] bg-[#070709] px-4 py-2">
            {artifacts.map((artifact) => {
              const active = artifact.path === activeArtifact?.path;
              return (
                <button
                  key={artifact.path}
                  onClick={() => setActiveArtifactPath(artifact.path)}
                  className={`rounded-full border px-3 py-1.5 text-[11px] transition-colors ${
                    active
                      ? "border-[rgba(124,58,237,0.35)] bg-[rgba(124,58,237,0.14)] text-[#e9d5ff]"
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
              <div className="rounded-2xl border border-[#18181b] bg-[#09090b] p-5 shadow-[0_20px_40px_rgba(0,0,0,0.2)]">
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
          <div className="rounded-2xl border border-[#18181b] bg-[#09090b] p-5 shadow-[0_20px_40px_rgba(0,0,0,0.2)]">
            <div className="mb-4 flex items-center justify-between gap-3 border-b border-[#18181b] pb-3">
              <div>
                <div className="text-[14px] font-semibold text-[#f5f5f5]">{fallbackTitle || activeTurn?.title || copy.previewTitle}</div>
                <div className="mt-1 text-[11px] text-[#71717a]">{copy.previewHint}</div>
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
          {isAwaitingApproval
            ? copy.waitingPlanHint
            : isAwaitingInput
            ? copy.waitingChoiceHint
            : copy.emptyHint}
        </div>
      )}

      {(!hideIslandOwnedSections || canResumeExecution) && (isAwaitingApproval || isAwaitingInput || canApproveExecution || canContinuePlanning || canResumeExecution || isApproved || ((artifacts.length > 0 || previewMarkdown) && !isApproved && !canApproveExecution)) && (
        <div className="border-t border-[#18181b] bg-[#09090b] px-4 py-3">
          {canApproveExecution ? (
            <div className="flex items-center justify-between gap-3">
              <div className="text-[11px] leading-relaxed text-[#71717a]">
                {copy.savePlanHint}
              </div>
              <div className="flex items-center gap-3">
                {artifacts.length > 0 && onDeletePlanFiles && (
                  <button
                    onClick={onDeletePlanFiles}
                    className="rounded-lg border border-[#3f3f46] bg-[#09090b] px-4 py-2 text-[12px] font-medium text-[#a1a1aa] transition-colors hover:bg-[#18181b] hover:text-[#f5f5f5]"
                  >
                    {copy.deletePlanFiles}
                  </button>
                )}
                <button
                  data-testid="plan-reject-button"
                  onClick={onReject}
                  className="rounded-lg border border-[#3f3f46] bg-[#09090b] px-4 py-2 text-[12px] font-medium text-[#a1a1aa] transition-colors hover:bg-[#18181b] hover:text-[#f5f5f5]"
                >
                  {copy.cancelPlan}
                </button>
                <button
                  data-testid="plan-approve-button"
                  onClick={onApprove}
                  className="rounded-lg px-4 py-2 text-[12px] font-semibold text-white shadow-[0_0_24px_rgba(124,58,237,0.28)]"
                  style={{ background: "linear-gradient(135deg, #7c3aed, #2563eb)" }}
                >
                  {copy.approvePlan}
                </button>
              </div>
            </div>
          ) : isAwaitingInput ? (
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
          ) : canContinuePlanning && onContinuePlanning ? (
            <div className="flex items-center justify-end gap-3">
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
                {copy.cancelPlan}
              </button>
              <button
                onClick={onContinuePlanning}
                className="rounded-lg px-4 py-2 text-[12px] font-semibold text-white shadow-[0_0_24px_rgba(124,58,237,0.28)]"
                style={{ background: "linear-gradient(135deg, #7c3aed, #2563eb)" }}
              >
                {copy.continuePlanning}
              </button>
            </div>
          ) : canResumeExecution && onResumeExecution ? (
            <div className="flex items-center justify-between gap-3">
              <div className="text-[11px] leading-relaxed text-[#71717a]">
                {copy.pausedExecutionHint}
              </div>
              <button
                data-testid="plan-resume-button"
                onClick={onResumeExecution}
                className="shrink-0 rounded-lg px-4 py-2 text-[12px] font-semibold text-white shadow-[0_0_24px_rgba(124,58,237,0.28)]"
                style={{ background: "linear-gradient(135deg, #7c3aed, #2563eb)" }}
              >
                {copy.resumeExecution}
              </button>
            </div>
          ) : !isApproved ? (
            <div className="flex items-center justify-between gap-3">
              <div className="text-[11px] leading-relaxed text-[#71717a]">
                {canApproveExecution ? copy.savePlanHint : copy.generatingFooter}
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
            <div className="text-[11px] text-[#71717a]">
              {copy.approvalRunningHint}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
