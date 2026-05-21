import { memo, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { IconChevronDown, IconChevronUp, IconColumns, IconFileText, IconLock, IconUnlock } from "./Icons";
import type { TurnProgressItem } from "../lib/turnProgress";
import { buildPlanTaskEvidenceAudit, isPlanTaskAwaitingBrowserValidation, isPlanTaskAwaitingExternalValidation, type PlanExecutionEvidenceEntry, type PlanStage, type PlanTask, type ReplyOption } from "../lib/workflowModels";
import type { PendingRunDecision, PendingRunDecisionChoice } from "../lib/runIntent";
import { inferReplyOptionActionFromText } from "../lib/replyOptions";
import MarkdownRenderer from "./MarkdownRenderer";

// region: TopIsland 属性定义
interface TopIslandProps {
  title: string;
  status: string;
  statusToneClass: string;
  language: "zh" | "en";
  themeMode: "light" | "dark" | "black";
  chatFontSize?: number;
  isVisible?: boolean;
  isRunActive?: boolean;
  planTasks: PlanTask[];
  planExecutionEvidenceLedger?: PlanExecutionEvidenceEntry[];
  planStage: PlanStage;
  executionSteps?: TurnProgressItem[];
  progressMode?: "plan" | "execution";
  isAwaitingChoice?: boolean;
  replyOptions?: ReplyOption[];
  pendingRunDecision?: PendingRunDecision | null;
  activeDiffTask?: any;
  pendingToolReview?: any;
  canApprovePlan: boolean;
  autoApproveTools?: boolean;
  onSelectReplyOption?: (option: ReplyOption) => void;
  onCancelTurn?: () => void;
  onResolvePendingRunDecision?: (choice: PendingRunDecisionChoice | "approve_once" | "approve_thread" | "cancel") => void;
  onDismissPendingRunDecision?: () => void;
  onRequestPlanAdjustment?: (text: string) => void;
  onApprovePlan: () => void;
  onRejectPlan: () => void;
  onRejectAndDeletePlan?: () => void;
  onRejectDiff?: (id: number) => void;
  onApproveDiffOnce?: () => void;
  onApproveDiffSession?: () => void;
  onOpenPlan: () => void;
  onOpenDiff: () => void;
  onHeightChange?: (height: number) => void;
}
// endregion

function isApprovalActionOption(option: ReplyOption): boolean {
  return (
    option.action === "continue_readonly_once" ||
    option.action === "allow_readonly_session"
  );
}

function getStageLabel(stage: PlanStage, language: "zh" | "en"): string {
  const zh: Record<PlanStage, string> = {
    idle: "待生成",
    plan: "计划",
    requirements: "需求",
    design: "历史计划",
    tasks: "任务",
    bugfix: "修复",
    ready_to_execute: "待执行",
    executing: "执行中",
    completed: "已完成",
  };
  const en: Record<PlanStage, string> = {
    idle: "Idle",
    plan: "Plan",
    requirements: "Requirements",
    design: "Legacy Plan",
    tasks: "Tasks",
    bugfix: "Bugfix",
    ready_to_execute: "Ready",
    executing: "Executing",
    completed: "Completed",
  };
  return (language === "zh" ? zh : en)[stage];
}

const TopIsland = memo(function TopIsland({
  title,
  status,
  statusToneClass,
  language,
  themeMode,
  chatFontSize = 13,
  isVisible = true,
  isRunActive = false,
  planTasks,
  planExecutionEvidenceLedger = [],
  planStage,
  executionSteps = [],
  progressMode,
  isAwaitingChoice = false,
  replyOptions = [],
  pendingRunDecision = null,
  activeDiffTask,
  pendingToolReview,
  canApprovePlan,
  autoApproveTools,
  onSelectReplyOption,
  onCancelTurn,
  onResolvePendingRunDecision,
  onDismissPendingRunDecision,
  onRequestPlanAdjustment,
  onApprovePlan,
  onRejectPlan,
  onRejectAndDeletePlan,
  onRejectDiff,
  onApproveDiffOnce,
  onApproveDiffSession,
  onOpenPlan,
  onOpenDiff,
  onHeightChange,
}: TopIslandProps) {
  const [hovered, setHovered] = useState(false);
  const [pinnedOpen, setPinnedOpen] = useState(false);
  const [manualChoiceCollapsedKey, setManualChoiceCollapsedKey] = useState<string | null>(null);
  const [customReplyText, setCustomReplyText] = useState("");
  const [planAdjustmentText, setPlanAdjustmentText] = useState("");
  const shellRef = useRef<HTMLDivElement | null>(null);

  const realChoiceOptions = useMemo(
    () => replyOptions.filter((option) => !isApprovalActionOption(option)),
    [replyOptions],
  );
  const approvalActionOptions = useMemo(
    () => replyOptions.filter((option) => isApprovalActionOption(option)),
    [replyOptions],
  );
  const hasRealChoiceOptions = realChoiceOptions.length > 0;
  const hasApprovalActionOptions = approvalActionOptions.length > 0;

  // region: TopIsland 展开时机
  const hasReplyOptions = hasRealChoiceOptions || hasApprovalActionOptions;
  const hasPendingRunDecision = !!pendingRunDecision;
  const activeReviewTask = pendingToolReview || activeDiffTask;
  const hasPendingToolReview = !!activeReviewTask;
  const hasActiveDiffPreview = !!activeReviewTask?.diff;
  const hasChoicePromptContent = hasReplyOptions || isAwaitingChoice || hasPendingRunDecision;
  const choicePromptKey = useMemo(() => {
    if (!hasChoicePromptContent) return "";
    return [
      isAwaitingChoice ? "awaiting" : "ready",
      pendingRunDecision ? `${pendingRunDecision.kind}:${pendingRunDecision.title || ""}:${pendingRunDecision.reason || ""}` : "",
      replyOptions.map((option) => `${option.label}:${option.value}:${option.action || "none"}`).join("|"),
    ].join("::");
  }, [hasChoicePromptContent, isAwaitingChoice, pendingRunDecision, replyOptions]);
  const isChoicePromptManuallyCollapsed = !!choicePromptKey && manualChoiceCollapsedKey === choicePromptKey;
  const hasExpandableContent =
    hasReplyOptions ||
    isAwaitingChoice ||
    hasPendingRunDecision ||
    hasPendingToolReview ||
    canApprovePlan ||
    planTasks.length > 0 ||
    executionSteps.length > 0;
  const hasNonChoiceExpandableContent = hasPendingToolReview || canApprovePlan || planTasks.length > 0 || executionSteps.length > 0;
  const choicePromptForcesExpanded = hasChoicePromptContent && !isChoicePromptManuallyCollapsed;
  const forceExpanded = choicePromptForcesExpanded || hasPendingToolReview || canApprovePlan;
  const hoverExpandableContent = isChoicePromptManuallyCollapsed ? hasNonChoiceExpandableContent : hasExpandableContent;
  const actionable = hasChoicePromptContent || hasPendingToolReview || canApprovePlan;
  const isPlanApprovalOnly =
    canApprovePlan &&
    !hasReplyOptions &&
    !isAwaitingChoice &&
    !hasPendingRunDecision &&
    !hasPendingToolReview;
  const activeProgressMode = planTasks.length > 0 ? "plan" : progressMode === "execution" ? "execution" : executionSteps.length > 0 ? "execution" : "plan";
  const planTaskAudit = useMemo(
    () => buildPlanTaskEvidenceAudit({ tasks: planTasks, evidenceLedger: planExecutionEvidenceLedger }),
    [planExecutionEvidenceLedger, planTasks],
  );
  const auditedPlanTasks = planTaskAudit.tasks;
  const progressItems = useMemo(() => {
    if (activeProgressMode === "plan") {
      return auditedPlanTasks.map((task) => ({
        id: task.id,
        text: task.text,
        status: task.status,
        validationStatus: isPlanTaskAwaitingExternalValidation(task)
          ? "user"
          : isPlanTaskAwaitingBrowserValidation(task)
          ? "browser"
          : "none",
        complete: task.evidenceStatus === "satisfied" && task.status === "completed",
      }));
    }

    return executionSteps.map((step) => ({
      id: step.id,
      text: step.text,
      status: step.status,
      validationStatus: "none",
      complete: step.status === "completed",
    }));
  }, [activeProgressMode, auditedPlanTasks, executionSteps]);
  const hasTasks = progressItems.length > 0;
  const shouldCompactTasksForReview = hasPendingToolReview && hasTasks;
  const shouldExpandWidth = forceExpanded || (hoverExpandableContent && (hovered || pinnedOpen));
  const isExpanded = forceExpanded || (hoverExpandableContent && (hovered || pinnedOpen));
  // endregion
  const completedCount = progressItems.filter((item) => item.complete).length;
  const progress = progressItems.length > 0 ? Math.round((completedCount / progressItems.length) * 100) : 0;
  const currentPlanTaskId = useMemo(() => {
    if (activeProgressMode !== "plan") return null;
    const firstIncomplete = auditedPlanTasks.find((task) => !(task.evidenceStatus === "satisfied" && task.status === "completed")) || auditedPlanTasks[auditedPlanTasks.length - 1];
    return firstIncomplete?.id || null;
  }, [activeProgressMode, auditedPlanTasks]);
  const visibleTasks = shouldCompactTasksForReview ? [] : progressItems;

  const copy = useMemo(() => ({
    viewing: language === "zh" ? "当前查看" : "Viewing",
    tasks: language === "zh" ? "任务" : "Tasks",
    steps: language === "zh" ? "步骤" : "Steps",
    pendingReview: language === "zh" ? "待审批" : "Pending Review",
    openPlan: language === "zh" ? "查看计划" : "Open Plan",
    openDiff: language === "zh" ? "查看变更" : "Open Diff",
    accept: language === "zh" ? "接受" : "Accept",
    approveDiffOnce: language === "zh" ? "单次批准" : "Approve Once",
    approveDiffSession: language === "zh" ? "当前会话全部允许" : "Allow All In Session",
    reject: language === "zh" ? "拒绝" : "Reject",
    rejectAndKeepPlan: language === "zh" ? "拒绝并保留" : "Reject And Keep",
    rejectAndDeletePlan: language === "zh" ? "拒绝并删除" : "Reject And Delete",
    approvePlan: language === "zh" ? "开始执行" : "Start Execution",
    waitingPlan: language === "zh" ? "计划待确认" : "Plan Waiting",
    adjustPlan: language === "zh" ? "调整计划" : "Adjust Plan",
    adjustPlanPlaceholder: language === "zh" ? "输入希望调整的点" : "Describe what to change",
    adjustPlanSubmit: language === "zh" ? "提交调整" : "Submit Adjustment",
    waitingChoice: language === "zh" ? "等待选择" : "Awaiting Choice",
    pendingDecision: language === "zh" ? "待决定" : "Decision Needed",
    chooseToContinue: language === "zh" ? "选择下一步" : "Choose the next step",
    showOptions: language === "zh" ? "展开选项" : "Show Options",
    collapseOptions: language === "zh" ? "收起选项" : "Collapse Options",
    diffRequest: language === "zh" ? "待确认变更" : "Pending Change",
    chooseApproval: language === "zh" ? "请选择审批方式" : "Choose an approval option",
    choiceHint: language === "zh"
      ? "模型已经识别出关键分叉并暂停。请先在聊天区点击一个选项，再继续当前回合。"
      : "The model found a real branch point and paused. Pick an option in chat before this turn continues.",
    choicePrompt: language === "zh"
      ? "直接在这里点选即可继续当前回合。"
      : "Choose an option here to continue the current turn.",
    choicesSectionTitle: language === "zh" ? "选择下一步" : "Choose the next step",
    approvalActionsTitle: language === "zh" ? "只读授权动作" : "Read-only Permission Actions",
    approvalActionsHint: language === "zh"
      ? "这些只会允许读取、搜索和分析，不会直接执行写入修改。"
      : "These only allow reading, searching, and analysis; they do not start write changes.",
    customChoicePlaceholder: language === "zh" ? "输入你的想法作为选项" : "Type your own choice",
    customChoiceSubmit: language === "zh" ? "确认" : "Confirm",
    executionConsentTitle: language === "zh" ? "允许开始执行本轮改动？" : "Allow this turn to start making changes?",
    executionConsentHint: language === "zh"
      ? "这是本轮第一次真实写入/命令动作。确认后 MAIN 会继续；高风险操作仍逐项审查。"
      : "This is the first real write/command action in this turn. MAIN continues after confirmation; high-risk actions still require per-step review.",
    approveExecuteOnce: language === "zh" ? "仅本轮执行" : "Allow This Turn",
    approveThread: language === "zh" ? "本会话自动允许写入与命令" : "Auto-Allow Writes & Commands",
    dismiss: language === "zh" ? "取消" : "Cancel",
    cancelTurn: language === "zh" ? "结束本轮" : "End This Turn",
    autoValidation: language === "zh" ? "自动验证" : "Auto validation",
    userValidation: language === "zh" ? "待用户验证" : "User validation",
    taskSummary: activeProgressMode === "execution"
      ? language === "zh"
        ? `共 ${progressItems.length} 个步骤，已完成 ${completedCount} 个`
        : `${completedCount}/${progressItems.length} steps completed`
      : language === "zh"
      ? `共 ${progressItems.length} 个任务，已完成 ${completedCount} 个`
      : `${completedCount}/${progressItems.length} tasks completed`,
    executionStage: language === "zh" ? "执行步骤" : "Execution",
  }), [activeProgressMode, completedCount, language, progressItems.length]);

  const isBlackTheme = themeMode === "black";
  const shellClass = themeMode === "light"
    ? "bg-[rgba(255,255,255,0.72)] border-[rgba(15,23,42,0.1)] shadow-[0_18px_50px_rgba(15,23,42,0.12)]"
    : isBlackTheme
    ? "bg-[rgba(3,3,4,0.72)] border-[rgba(255,255,255,0.07)] shadow-[0_22px_70px_rgba(0,0,0,0.42)]"
    : "bg-[rgba(10,10,16,0.68)] border-[rgba(255,255,255,0.08)] shadow-[0_20px_60px_rgba(0,0,0,0.28)]";
  const activeRunOutline = isRunActive
    ? "ring-1 ring-[var(--accent)] ring-offset-1 ring-offset-transparent"
    : "";
  const primaryText = themeMode === "light" ? "text-[#111827]" : "text-[#f5f5f5]";
  const secondaryText = themeMode === "light" ? "text-[#4b5563]" : "text-[#71717a]";
  const surface = themeMode === "light"
    ? "bg-[rgba(255,255,255,0.36)] border-[rgba(15,23,42,0.08)]"
    : isBlackTheme
    ? "bg-[rgba(255,255,255,0.025)] border-[#17171c]"
    : "bg-[rgba(255,255,255,0.04)] border-[#1f1f23]";
  const normalizedCustomReply = customReplyText.replace(/\s+/g, " ").trim();
  const normalizedPlanAdjustment = planAdjustmentText.replace(/\s+/g, " ").trim();
  const showChoicePromptContent = !isChoicePromptManuallyCollapsed;
  const showPendingRunDecision = !!pendingRunDecision && showChoicePromptContent;
  const showAwaitingChoice = isAwaitingChoice && showChoicePromptContent;
  const choiceTextFontSize = Math.max(12, chatFontSize);
  const choiceTextLineHeight = Math.max(20, Math.round(choiceTextFontSize * 1.7));
  const choiceSectionFontSize = Math.max(11, choiceTextFontSize - 1);
  const choiceSectionLineHeight = Math.max(16, Math.round(choiceSectionFontSize * 1.55));
  const customChoiceNumber = hasRealChoiceOptions ? realChoiceOptions.length + 1 : 1;
  const choiceTextStyle = { fontSize: `${choiceTextFontSize}px`, lineHeight: `${choiceTextLineHeight}px` };
  const choiceSectionStyle = { fontSize: `${choiceSectionFontSize}px`, lineHeight: `${choiceSectionLineHeight}px` };
  const choiceOptionButtonClass = "top-island-choice-option w-full min-w-0 rounded-xl border px-3 py-2.5 text-left transition-all duration-150";
  const choiceNumberClass = "top-island-choice-number w-7 shrink-0 text-right font-semibold transition-colors duration-150";
  const approvalOptionButtonClass = "top-island-approval-option w-full rounded-xl border px-3 py-2.5 text-left transition-all duration-150";
  const neutralActionButtonClass = themeMode === "light"
    ? "rounded-xl border border-[rgba(15,23,42,0.14)] bg-[rgba(255,255,255,0.72)] text-[#334155] transition-all duration-150 hover:border-[var(--accent)] hover:bg-[var(--accent-subtle)] hover:text-[#111827]"
    : isBlackTheme
    ? "rounded-xl border border-[#202026] bg-[#030304] text-[#c4c4cc] transition-all duration-150 hover:border-[var(--accent)] hover:bg-[color-mix(in_srgb,var(--accent)_14%,transparent)] hover:text-[#f5f5f5]"
    : "rounded-xl border border-[#3f3f46] bg-[#09090b] text-[#a1a1aa] transition-all duration-150 hover:border-[var(--accent)] hover:bg-[color-mix(in_srgb,var(--accent)_14%,transparent)] hover:text-[#f5f5f5]";

  const submitCustomReply = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!normalizedCustomReply) return;
    const inferredAction = inferReplyOptionActionFromText(normalizedCustomReply);
    onSelectReplyOption?.({
      label: normalizedCustomReply,
      value: normalizedCustomReply,
      ...(inferredAction ? { action: inferredAction } : {}),
    });
    setCustomReplyText("");
  };

  const submitPlanAdjustment = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!normalizedPlanAdjustment || !onRequestPlanAdjustment) return;
    onRequestPlanAdjustment(normalizedPlanAdjustment);
    setPlanAdjustmentText("");
  };

  useEffect(() => {
    if (!choicePromptKey || (manualChoiceCollapsedKey && manualChoiceCollapsedKey !== choicePromptKey)) {
      setManualChoiceCollapsedKey(null);
    }
  }, [choicePromptKey, manualChoiceCollapsedKey]);

  // region: TopIsland 高度同步
  useEffect(() => {
    if (!onHeightChange) return undefined;
    const node = shellRef.current;
    if (!node) return undefined;

    const reportHeight = () => {
      onHeightChange(node.offsetHeight);
    };

    reportHeight();
    const observer = new ResizeObserver(reportHeight);
    observer.observe(node);
    return () => {
      observer.disconnect();
    };
  }, [onHeightChange]);
  // endregion

  return (
    <div
      className={`pointer-events-none absolute left-0 right-0 top-[58px] z-30 flex justify-center px-4 transition-all duration-250 ease-out ${
        isVisible ? "translate-y-0 opacity-100" : "-translate-y-2 opacity-0"
      }`}
    >
      <div
        ref={shellRef}
        data-testid="top-island-shell"
        data-run-active={isRunActive ? "true" : "false"}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        className={`w-full overflow-hidden rounded-[28px] border backdrop-blur-2xl backdrop-saturate-150 transition-all duration-300 ease-out [&_button]:pointer-events-auto [&_input]:pointer-events-auto [&_textarea]:pointer-events-auto [&_select]:pointer-events-auto ${isVisible && !isPlanApprovalOnly ? "pointer-events-auto" : "pointer-events-none"} ${shouldExpandWidth ? "max-w-4xl" : "max-w-[580px]"} ${shellClass} ${activeRunOutline}`}
      >
        <div className="flex items-center justify-between gap-3 px-4 py-3">
          <div className="min-w-0 flex items-center gap-2">
            <span className="shrink-0 text-[10px] uppercase tracking-[0.18em] text-[#71717a]">{copy.viewing}</span>
            <span className={`truncate text-[13px] font-semibold ${primaryText}`}>{title}</span>
            <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] ${statusToneClass}`}>{status}</span>
            {hasTasks && (
              <span data-testid={activeProgressMode === "execution" ? "top-island-execution-badge" : "top-island-plan-badge"} className="theme-plan-pill shrink-0 rounded-full border px-2 py-0.5 text-[10px]">
                {activeProgressMode === "execution" ? copy.steps : copy.tasks} {completedCount}/{progressItems.length}
              </span>
            )}
            {canApprovePlan && (
              <span className="theme-plan-pill shrink-0 rounded-full border px-2 py-0.5 text-[10px]">
                {copy.waitingPlan}
              </span>
            )}
            {isAwaitingChoice && (
              <span className="shrink-0 rounded-full border border-[rgba(251,191,36,0.25)] bg-[rgba(251,191,36,0.12)] px-2 py-0.5 text-[10px] text-[#fbbf24]">
                {copy.waitingChoice}
              </span>
            )}
            {hasPendingRunDecision && (
              <span className="shrink-0 rounded-full border border-[rgba(251,191,36,0.25)] bg-[rgba(251,191,36,0.12)] px-2 py-0.5 text-[10px] text-[#fbbf24]">
                {copy.pendingDecision}
              </span>
            )}
            {activeReviewTask && hasActiveDiffPreview && (
              <span className="shrink-0 rounded-full border border-[rgba(96,165,250,0.25)] bg-[rgba(96,165,250,0.12)] px-2 py-0.5 text-[10px] text-[#93c5fd]">
                {copy.diffRequest}
              </span>
            )}
            {!isExpanded && actionable && (
              <span className="shrink-0 h-2 w-2 rounded-full bg-[var(--accent)] animate-pulse" />
            )}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {isChoicePromptManuallyCollapsed && (
              <button
                data-testid="top-island-show-options"
                onClick={() => {
                  setManualChoiceCollapsedKey(null);
                  setPinnedOpen(true);
                }}
                className="rounded-full border border-[var(--accent-subtle-border)] bg-[var(--accent-subtle)] px-3 py-1 text-[11px] text-[var(--accent-light)] transition-colors hover:border-[var(--accent)] hover:bg-[var(--accent)] hover:text-[var(--accent-contrast)]"
                title={copy.showOptions}
              >
                <span className="inline-flex items-center gap-1.5">
                  <IconChevronDown className="h-3.5 w-3.5" />
                  {copy.showOptions}
                </span>
              </button>
            )}
            <button
              onClick={() => {
                if (isChoicePromptManuallyCollapsed) {
                  setManualChoiceCollapsedKey(null);
                  setPinnedOpen(true);
                  return;
                }
                setPinnedOpen((value) => !value);
              }}
              className="rounded-full border border-[#27272a] bg-[#09090b] p-1 text-[#a1a1aa] transition-colors hover:bg-[#18181b] hover:text-[#f5f5f5]"
              title={pinnedOpen ? (language === "zh" ? "解除锁定" : "Unlock") : (language === "zh" ? "锁定展开" : "Pin Open")}
            >
              {pinnedOpen ? <IconUnlock className="h-4 w-4" /> : <IconLock className="h-4 w-4" />}
            </button>
          </div>
        </div>

        <div
          className={`grid transition-all duration-250 ease-out ${
            isExpanded ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"
          }`}
        >
          <div className="overflow-hidden">
            <div className="border-t border-[rgba(255,255,255,0.06)] px-4 pb-4 pt-3">
            {showPendingRunDecision && (
              <div>
                <div data-testid="top-island-pending-run-decision" className={`rounded-2xl border p-3 ${surface}`}>
                  <div className={`font-medium ${primaryText}`} style={choiceTextStyle}>
                    {pendingRunDecision.kind === "execution_consent"
                      ? copy.executionConsentTitle
                      : pendingRunDecision.title || copy.chooseToContinue}
                  </div>
                  <div className={`mt-1 break-words ${secondaryText}`} style={choiceTextStyle}>
                    {pendingRunDecision.reason}
                  </div>
                  {pendingRunDecision.kind === "execution_consent" && (
                    <div className={`mt-1 break-words ${secondaryText}`} style={choiceSectionStyle}>
                      {copy.executionConsentHint}
                      {pendingRunDecision.target ? ` ${pendingRunDecision.target}` : ""}
                    </div>
                  )}
                </div>
                <div className="mt-3 flex flex-wrap items-center justify-end gap-2 px-1">
                  {pendingRunDecision.kind === "execution_consent" ? (
                    <>
                      <button
                        onClick={() => onResolvePendingRunDecision?.("cancel")}
                        className={`${neutralActionButtonClass} px-4 py-2 text-[12px] font-medium`}
                      >
                        {copy.dismiss}
                      </button>
                      <button
                        onClick={() => onResolvePendingRunDecision?.("approve_thread")}
                        className={`rounded-lg border px-4 py-2 text-[12px] font-medium transition-colors ${
                          autoApproveTools
                            ? "theme-plan-button"
                            : "border-[#3f3f46] bg-[#09090b] text-[#a1a1aa] hover:bg-[#18181b] hover:text-[#f5f5f5]"
                        }`}
                      >
                        {copy.approveThread}
                      </button>
                      <button
                        data-testid="top-island-approve-once"
                        onClick={() => onResolvePendingRunDecision?.("approve_once")}
                        className="theme-plan-primary rounded-lg px-4 py-2 text-[12px] font-semibold"
                      >
                        {copy.approveExecuteOnce}
                      </button>
                    </>
                  ) : (
                    <>
                      <div className="w-full space-y-2">
                        {(pendingRunDecision.options || []).map((option, index) => (
                          <div
                            key={`${option.id}-${index}`}
                            className="group flex min-w-0 items-center gap-2"
                          >
                            <span data-testid={`top-island-intent-option-badge-${index}`} className={choiceNumberClass} style={choiceTextStyle}>{index + 1}.</span>
                            <button
                              data-testid={`top-island-intent-option-${option.id}`}
                              onClick={() => onResolvePendingRunDecision?.(option.id)}
                              className={choiceOptionButtonClass}
                              style={choiceTextStyle}
                            >
                              <span className="min-w-0 break-words">{option.label}</span>
                            </button>
                          </div>
                        ))}
                      </div>
                      <button
                        onClick={() => onResolvePendingRunDecision?.("cancel")}
                        className={`${neutralActionButtonClass} px-4 py-2 text-[12px] font-medium`}
                      >
                        {copy.dismiss}
                      </button>
                    </>
                  )}
                </div>
                {pendingRunDecision.kind === "intent_confirmation" && onDismissPendingRunDecision && (
                  <div className="mt-2 flex justify-end">
                    <button
                      onClick={onDismissPendingRunDecision}
                      className={`text-[11px] ${secondaryText} transition-colors hover:text-[#f5f5f5]`}
                    >
                      {copy.dismiss}
                    </button>
                  </div>
                )}
              </div>
            )}

            {hasTasks && (
              <div data-testid={activeProgressMode === "execution" ? "top-island-execution-progress" : "top-island-plan-progress"} className={`${showPendingRunDecision ? "mt-3 " : ""}rounded-2xl border p-3 ${surface}`}>
                <div className="flex items-center justify-between gap-3">
                  <div className={`text-[12px] font-medium ${primaryText}`}>{copy.taskSummary}</div>
                  <div className="flex items-center gap-2">
                    <span className={`text-[11px] ${secondaryText}`}>
                      {activeProgressMode === "execution" ? copy.executionStage : getStageLabel(planStage, language)}
                    </span>
                    {activeProgressMode === "plan" && (
                      <button
                        onClick={onOpenPlan}
                        className="theme-plan-button rounded-full border px-3 py-1 text-[11px] transition-colors"
                      >
                        <span className="inline-flex items-center gap-1.5">
                          <IconFileText className="h-3.5 w-3.5" />
                          {copy.openPlan}
                        </span>
                      </button>
                    )}
                  </div>
                </div>
                <div className="mt-3 h-2 overflow-hidden rounded-full bg-[#18181b]">
                  <div
                    className="theme-plan-progress h-full rounded-full transition-all duration-300"
                    style={{ width: `${progress}%` }}
                  />
                </div>
                {shouldCompactTasksForReview && (
                  <div className={`mt-2 text-[11px] ${secondaryText}`}>
                    {language === "zh"
                      ? "已有待审批工具，任务明细已收起。"
                      : "Task details are collapsed while a tool review is pending."}
                  </div>
                )}
                {!shouldCompactTasksForReview && (
                <div className="mt-3 max-h-[220px] space-y-2 overflow-y-auto pr-1">
                  {visibleTasks.map((task, index) => {
                    const isCurrentPlanTask = activeProgressMode === "plan" && task.id === currentPlanTaskId && !task.complete;
                    return (
                      <div
                        key={task.id}
                        data-testid={isCurrentPlanTask ? "top-island-current-plan-task" : undefined}
                        className={`flex items-start gap-3 rounded-xl px-3 py-2 ${
                          isCurrentPlanTask
                            ? "theme-plan-surface border"
                            : "bg-[rgba(0,0,0,0.18)]"
                        }`}
                      >
                        <span
                          className={`mt-1 h-3.5 w-3.5 shrink-0 rounded-full border flex items-center justify-center ${
                            task.complete
                              ? "border-[#34d399] bg-[#34d399] text-[#050507]"
                            : task.status === "in_progress"
                            ? "border-[#60a5fa] bg-[#60a5fa]"
                            : task.status === "failed"
                            ? "border-[#f87171] bg-[#f87171]"
                            : "border-[#3f3f46] bg-transparent"
                          }`}
                        >
                          {task.complete && (
                            <svg className="h-2 w-2" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M2.5 6L5 8.5L9.5 3.5" />
                            </svg>
                          )}
                        </span>
                        <div className={`min-w-0 text-[12px] leading-6 ${primaryText}`}>
                          <div className="flex items-start gap-2">
                            <span className="mt-[2px] shrink-0 text-[12px] font-medium">{index + 1}.</span>
                            <div className="min-w-0 flex-1 [&_.markdown-body]:text-[12px] [&_.markdown-body]:leading-6 [&_.markdown-body_p]:mb-0 [&_.markdown-body_p]:text-inherit [&_.markdown-body_strong]:text-inherit [&_.markdown-body_code]:align-baseline">
                              <MarkdownRenderer content={task.text} baseFontSize={12} />
                              {activeProgressMode === "plan" && task.validationStatus !== "none" && !task.complete && (
                                <div className={`mt-1 text-[10px] leading-4 ${
                                  task.validationStatus === "user" ? "text-[#fbbf24]" : "text-[#93c5fd]"
                                }`}>
                                  {task.validationStatus === "user" ? copy.userValidation : copy.autoValidation}
                                </div>
                              )}
                            </div>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
                )}
              </div>
            )}

            {showAwaitingChoice && (
              <div data-testid="top-island-awaiting-choice" className={`mt-3 rounded-2xl border p-3 ${surface}`}>
                <div className={`font-medium ${primaryText}`} style={choiceTextStyle}>{copy.chooseToContinue}</div>
                <div className={`mt-1 ${secondaryText}`} style={choiceTextStyle}>
                  {hasRealChoiceOptions ? copy.choicePrompt : hasApprovalActionOptions ? copy.approvalActionsHint : copy.choiceHint}
                </div>
                {hasReplyOptions && (
                  <div className="mt-3 flex flex-col gap-3">
                    {hasRealChoiceOptions && (
                      <div>
                        <div className={`font-medium uppercase tracking-[0.14em] ${secondaryText}`} style={choiceSectionStyle}>
                          {copy.choicesSectionTitle}
                        </div>
                        <div className="mt-2 space-y-2">
                          {realChoiceOptions.map((option, index) => (
                            <div
                              key={`${option.value}-${index}`}
                              className="group flex min-w-0 items-center gap-2"
                            >
                              <span data-testid={`top-island-reply-option-badge-${index}`} className={choiceNumberClass} style={choiceTextStyle}>{index + 1}.</span>
                              <button
                                data-testid={`top-island-reply-option-${index}`}
                                onClick={() => onSelectReplyOption?.(option)}
                                className={choiceOptionButtonClass}
                                style={choiceTextStyle}
                              >
                                <span className="min-w-0 break-words">{option.label}</span>
                              </button>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {hasApprovalActionOptions && (
                      <div data-testid="top-island-approval-actions" className={`rounded-xl border p-3 ${surface}`}>
                        <div className={`font-medium uppercase tracking-[0.14em] ${secondaryText}`} style={choiceSectionStyle}>
                          {copy.approvalActionsTitle}
                        </div>
                        <div className={`mt-1 ${secondaryText}`} style={choiceSectionStyle}>{copy.approvalActionsHint}</div>
                        <div className="mt-2 space-y-2">
                          {approvalActionOptions.map((option, index) => (
                            <button
                              key={`${option.value}-${index}`}
                              data-testid={`top-island-approval-option-${index}`}
                              onClick={() => onSelectReplyOption?.(option)}
                              className={approvalOptionButtonClass}
                              style={choiceTextStyle}
                            >
                              {option.label}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}

                    <form onSubmit={submitCustomReply} data-testid="top-island-custom-reply-row" className="group flex min-w-0 items-center gap-2">
                      <span data-testid="top-island-custom-reply-badge" className={choiceNumberClass} style={choiceTextStyle}>{customChoiceNumber}.</span>
                      <div className="min-w-0 flex-1">
                        <div className="flex min-w-0 items-center gap-2">
                          <input
                            data-testid="top-island-custom-reply-input"
                            value={customReplyText}
                            onChange={(event) => setCustomReplyText(event.target.value)}
                            placeholder={copy.customChoicePlaceholder}
                            className="top-island-choice-input min-w-0 flex-1 rounded-xl border px-3 py-2.5 outline-none transition-all"
                            style={choiceTextStyle}
                          />
                          <button
                            type="submit"
                            data-testid="top-island-custom-reply-submit"
                            disabled={!normalizedCustomReply || !onSelectReplyOption}
                            className={`theme-plan-primary shrink-0 rounded-xl px-3 py-2.5 text-[12px] font-semibold transition-opacity ${
                              normalizedCustomReply && onSelectReplyOption ? "opacity-100" : "cursor-not-allowed opacity-40"
                            }`}
                          >
                            {copy.customChoiceSubmit}
                          </button>
                        </div>
                      </div>
                    </form>
                    <button
                      onClick={onCancelTurn}
                      className={`${neutralActionButtonClass} w-full px-3 py-2.5 text-left`}
                      style={choiceTextStyle}
                    >
                      {copy.cancelTurn}
                    </button>
                  </div>
                )}
              </div>
            )}

            {(activeReviewTask || canApprovePlan) && (
              <div className={`mt-3 grid gap-3 ${activeReviewTask && canApprovePlan ? "md:grid-cols-2" : ""}`}>
                {activeReviewTask && (
                  <div data-testid="top-island-tool-review" className={`rounded-2xl border p-3 ${surface}`}>
                    <div className="flex min-w-0 items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className={`text-[12px] font-medium ${primaryText}`}>{copy.pendingReview}</div>
                        <div className={`mt-1 text-[11px] ${secondaryText}`}>{copy.chooseApproval}</div>
                      </div>
                    </div>
                    <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
                      {hasActiveDiffPreview && (
                        <button
                          onClick={onOpenDiff}
                          className="rounded-lg border border-[rgba(96,165,250,0.25)] bg-[rgba(96,165,250,0.12)] px-4 py-2 text-[12px] font-medium text-[#bfdbfe] transition-colors hover:bg-[rgba(96,165,250,0.2)]"
                        >
                          <span className="inline-flex items-center gap-1.5">
                            <IconColumns className="h-3.5 w-3.5" />
                            {copy.openDiff}
                          </span>
                        </button>
                      )}
                      <button
                        onClick={() => onRejectDiff?.(activeReviewTask.id)}
                        className="rounded-lg border border-[#3f3f46] bg-[#09090b] px-4 py-2 text-[12px] font-medium text-[#a1a1aa] transition-colors hover:bg-[#18181b] hover:text-[#f5f5f5]"
                      >
                        {copy.reject}
                      </button>
                      <button
                        data-testid="top-island-tool-approve-session"
                        onClick={() => onApproveDiffSession?.()}
                        className={`rounded-lg border px-4 py-2 text-[12px] font-medium transition-colors ${
                          autoApproveTools
                            ? "theme-plan-button"
                            : "border-[#3f3f46] bg-[#09090b] text-[#a1a1aa] hover:bg-[#18181b] hover:text-[#f5f5f5]"
                        }`}
                      >
                        {copy.approveDiffSession}
                      </button>
                      <button
                        data-testid="top-island-tool-approve-once"
                        onClick={() => onApproveDiffOnce?.()}
                        className="theme-plan-primary rounded-lg px-4 py-2 text-[12px] font-semibold"
                      >
                        {copy.approveDiffOnce}
                      </button>
                    </div>
                    <div
                      className={`mt-3 max-h-[4.8rem] overflow-hidden rounded-xl border border-[rgba(255,255,255,0.06)] bg-[rgba(0,0,0,0.22)] px-3 py-2 font-mono text-[11px] leading-6 ${secondaryText}`}
                      style={{
                        overflowWrap: "anywhere",
                        display: "-webkit-box",
                        WebkitLineClamp: 3,
                        WebkitBoxOrient: "vertical",
                      }}
                    >
                      {activeReviewTask.target}
                    </div>
                  </div>
                )}

                {canApprovePlan && (
                  <div>
                    <div className={`rounded-2xl border p-3 ${surface}`}>
                      <div className={`text-[12px] font-medium ${primaryText}`}>{copy.waitingPlan}</div>
                      <div className={`mt-1 text-[12px] leading-6 ${secondaryText}`}>
                      {language === "zh"
                        ? "当前计划已经准备就绪。确认后会进入执行能力，写入与命令仍会逐项审查。"
                        : "The current plan is ready. Approving it enables execution tools while keeping write and command steps review-gated."}
                      </div>
                    </div>
                    <div className="mt-3 flex flex-col gap-2 px-1 sm:flex-row sm:items-center sm:justify-end">
                      <form
                        onSubmit={submitPlanAdjustment}
                        data-testid="top-island-plan-adjust-form"
                        className="flex w-full min-w-0 flex-1 items-center gap-2 sm:mr-auto"
                      >
                        <div className="min-w-0 flex-1">
                          <input
                            data-testid="top-island-plan-adjust-input"
                            value={planAdjustmentText}
                            onChange={(event) => setPlanAdjustmentText(event.target.value)}
                            placeholder={copy.adjustPlanPlaceholder}
                            className="top-island-choice-input min-w-0 w-full rounded-xl border px-3 py-2 outline-none transition-all"
                            style={choiceTextStyle}
                            aria-label={copy.adjustPlan}
                          />
                        </div>
                        <button
                          type="submit"
                          data-testid="top-island-plan-adjust-submit"
                          disabled={!normalizedPlanAdjustment || !onRequestPlanAdjustment}
                          className={`shrink-0 rounded-lg border px-3 py-2 text-[12px] font-medium transition-colors ${
                            normalizedPlanAdjustment && onRequestPlanAdjustment
                              ? "theme-plan-button"
                              : "cursor-not-allowed border-[#3f3f46] bg-[#09090b] text-[#71717a]"
                          }`}
                        >
                          {copy.adjustPlanSubmit}
                        </button>
                      </form>
                      <button
                        data-testid="top-island-plan-reject-keep"
                        onClick={onRejectPlan}
                        className="rounded-lg border border-[#3f3f46] bg-[#09090b] px-4 py-2 text-[12px] font-medium text-[#a1a1aa] transition-colors hover:bg-[#18181b] hover:text-[#f5f5f5]"
                      >
                        {copy.rejectAndKeepPlan}
                      </button>
                      {onRejectAndDeletePlan && (
                        <button
                          data-testid="top-island-plan-reject-delete"
                          onClick={onRejectAndDeletePlan}
                          className="rounded-lg border border-[rgba(244,63,94,0.35)] bg-[#09090b] px-4 py-2 text-[12px] font-medium text-[#fb7185] transition-colors hover:bg-[rgba(244,63,94,0.12)] hover:text-[#fecdd3]"
                        >
                          {copy.rejectAndDeletePlan}
                        </button>
                      )}
                      <button
                        data-testid="top-island-plan-approve"
                        onClick={onApprovePlan}
                        className="theme-plan-primary rounded-lg px-4 py-2 text-[12px] font-semibold"
                      >
                        {copy.approvePlan}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}

            {hasChoicePromptContent && showChoicePromptContent && (
              <div className="mt-3 flex justify-center">
                <button
                  data-testid="top-island-collapse-options"
                  onClick={() => {
                    if (choicePromptKey) setManualChoiceCollapsedKey(choicePromptKey);
                    setPinnedOpen(false);
                    setHovered(false);
                  }}
                  className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[11px] transition-colors ${
                    themeMode === "light"
                      ? "border-[rgba(15,23,42,0.12)] bg-[rgba(255,255,255,0.55)] text-[#4b5563] hover:bg-white hover:text-[#111827]"
                      : "border-[#27272a] bg-[#09090b] text-[#a1a1aa] hover:bg-[#18181b] hover:text-[#f5f5f5]"
                  }`}
                >
                  <IconChevronUp className="h-3.5 w-3.5" />
                  {copy.collapseOptions}
                </button>
              </div>
            )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
});

export default TopIsland;
