import { memo, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { IconColumns, IconFileText, IconLock, IconUnlock } from "./Icons";
import type { TurnProgressItem } from "../lib/turnProgress";
import { buildPlanTaskEvidenceAudit, type PlanExecutionEvidenceEntry, type PlanStage, type PlanTask, type ReplyOption } from "../lib/workflowModels";
import type { PendingRunDecision, ResolvedUserIntent } from "../lib/runIntent";
import MarkdownRenderer from "./MarkdownRenderer";

// region: TopIsland 属性定义
interface TopIslandProps {
  title: string;
  status: string;
  statusToneClass: string;
  language: "zh" | "en";
  themeMode: "light" | "dark";
  isVisible?: boolean;
  planTasks: PlanTask[];
  planExecutionEvidenceLedger?: PlanExecutionEvidenceEntry[];
  planStage: PlanStage;
  executionSteps?: TurnProgressItem[];
  progressMode?: "plan" | "execution";
  isAwaitingChoice?: boolean;
  replyOptions?: ReplyOption[];
  pendingRunDecision?: PendingRunDecision | null;
  activeDiffTask?: any;
  canApprovePlan: boolean;
  autoApproveTools?: boolean;
  onSelectReplyOption?: (option: ReplyOption) => void;
  onCancelTurn?: () => void;
  onResolvePendingRunDecision?: (choice: ResolvedUserIntent | "approve_once" | "approve_thread" | "cancel") => void;
  onDismissPendingRunDecision?: () => void;
  onApprovePlan: () => void;
  onRejectPlan: () => void;
  onRejectDiff?: (id: number) => void;
  onApproveDiffOnce?: () => void;
  onApproveDiffSession?: () => void;
  onOpenPlan: () => void;
  onOpenDiff: () => void;
  onHeightChange?: (height: number) => void;
}
// endregion

function getStageLabel(stage: PlanStage, language: "zh" | "en"): string {
  const zh: Record<PlanStage, string> = {
    idle: "待生成",
    requirements: "需求",
    design: "设计",
    tasks: "任务",
    bugfix: "修复",
    ready_to_execute: "待执行",
    executing: "执行中",
    completed: "已完成",
  };
  const en: Record<PlanStage, string> = {
    idle: "Idle",
    requirements: "Requirements",
    design: "Design",
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
  isVisible = true,
  planTasks,
  planExecutionEvidenceLedger = [],
  planStage,
  executionSteps = [],
  progressMode,
  isAwaitingChoice = false,
  replyOptions = [],
  pendingRunDecision = null,
  activeDiffTask,
  canApprovePlan,
  autoApproveTools,
  onSelectReplyOption,
  onCancelTurn,
  onResolvePendingRunDecision,
  onDismissPendingRunDecision,
  onApprovePlan,
  onRejectPlan,
  onRejectDiff,
  onApproveDiffOnce,
  onApproveDiffSession,
  onOpenPlan,
  onOpenDiff,
  onHeightChange,
}: TopIslandProps) {
  const [hovered, setHovered] = useState(false);
  const [pinnedOpen, setPinnedOpen] = useState(false);
  const [customReplyText, setCustomReplyText] = useState("");
  const shellRef = useRef<HTMLDivElement | null>(null);

  // region: TopIsland 展开时机
  const hasReplyOptions = replyOptions.length > 0;
  const hasPendingRunDecision = !!pendingRunDecision;
  const hasActiveDiffPreview = !!activeDiffTask?.diff;
  const hasExpandableContent =
    hasReplyOptions ||
    isAwaitingChoice ||
    hasPendingRunDecision ||
    !!activeDiffTask ||
    canApprovePlan ||
    planTasks.length > 0 ||
    executionSteps.length > 0;
  const forceExpanded = hasReplyOptions || isAwaitingChoice || hasPendingRunDecision || !!activeDiffTask || canApprovePlan;
  const actionable = forceExpanded || hasPendingRunDecision || !!activeDiffTask || canApprovePlan;
  const isPlanApprovalOnly =
    canApprovePlan &&
    !hasReplyOptions &&
    !isAwaitingChoice &&
    !hasPendingRunDecision &&
    !activeDiffTask;
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
        complete: task.evidenceStatus === "satisfied" && task.status === "completed",
      }));
    }

    return executionSteps.map((step) => ({
      id: step.id,
      text: step.text,
      status: step.status,
      complete: step.status === "completed",
    }));
  }, [activeProgressMode, auditedPlanTasks, executionSteps]);
  const hasTasks = progressItems.length > 0;
  const shouldExpandWidth = forceExpanded || (hasExpandableContent && (hovered || pinnedOpen));
  const isExpanded = forceExpanded || (hasExpandableContent && (hovered || pinnedOpen));
  // endregion
  const completedCount = progressItems.filter((item) => item.complete).length;
  const progress = progressItems.length > 0 ? Math.round((completedCount / progressItems.length) * 100) : 0;
  const currentPhaseKey = useMemo(() => {
    if (activeProgressMode !== "plan") return null;
    const firstIncomplete = auditedPlanTasks.find((task) => !(task.evidenceStatus === "satisfied" && task.status === "completed")) || auditedPlanTasks[auditedPlanTasks.length - 1];
    if (!firstIncomplete) return null;
    const matched = firstIncomplete.text.match(/(?:Task|T)\s*([0-9]+)(?:[.\-][0-9]+)?/i);
    return matched?.[1] || null;
  }, [activeProgressMode, auditedPlanTasks]);
  const visibleTasks = useMemo(() => {
    if (activeProgressMode !== "plan" || !currentPhaseKey) return progressItems;
    const grouped = progressItems.filter((task) => {
      const matched = task.text.match(/(?:Task|T)\s*([0-9]+)(?:[.\-][0-9]+)?/i);
      return (matched?.[1] || null) === currentPhaseKey;
    });
    return grouped.length > 0 ? grouped : progressItems;
  }, [activeProgressMode, currentPhaseKey, progressItems]);

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
    approvePlan: language === "zh" ? "开始执行" : "Start Execution",
    waitingPlan: language === "zh" ? "计划待确认" : "Plan Waiting",
    waitingChoice: language === "zh" ? "等待选择" : "Awaiting Choice",
    pendingDecision: language === "zh" ? "待决定" : "Decision Needed",
    chooseToContinue: language === "zh" ? "选择下一步" : "Choose the next step",
    diffRequest: language === "zh" ? "待确认变更" : "Pending Change",
    chooseApproval: language === "zh" ? "请选择审批方式" : "Choose an approval option",
    choiceHint: language === "zh"
      ? "模型已经识别出关键分叉并暂停。请先在聊天区点击一个选项，再继续当前回合。"
      : "The model found a real branch point and paused. Pick an option in chat before this turn continues.",
    choicePrompt: language === "zh"
      ? "直接在这里点选即可继续当前回合。"
      : "Choose an option here to continue the current turn.",
    customChoicePlaceholder: language === "zh" ? "输入你的想法作为选项" : "Type your own choice",
    customChoiceSubmit: language === "zh" ? "确认" : "Confirm",
    executionConsentTitle: language === "zh" ? "允许开始执行本轮改动？" : "Allow this turn to start making changes?",
    executionConsentHint: language === "zh"
      ? "这是本轮第一次真实写入/执行动作。确认后 MAIN 才会继续推进。"
      : "This is the first real write/execute action in the turn. MAIN will continue only after you confirm.",
    approveExecuteOnce: language === "zh" ? "仅本轮执行" : "Allow This Turn",
    approveThread: language === "zh" ? "本对话自动执行" : "Auto-Run In Thread",
    dismiss: language === "zh" ? "取消" : "Cancel",
    cancelTurn: language === "zh" ? "结束本轮" : "End This Turn",
    taskSummary: activeProgressMode === "execution"
      ? language === "zh"
        ? `共 ${progressItems.length} 个步骤，已完成 ${completedCount} 个`
        : `${completedCount}/${progressItems.length} steps completed`
      : language === "zh"
      ? `共 ${progressItems.length} 个任务，已完成 ${completedCount} 个`
      : `${completedCount}/${progressItems.length} tasks completed`,
    executionStage: language === "zh" ? "执行步骤" : "Execution",
    phaseLabel: currentPhaseKey
      ? language === "zh"
        ? `阶段 ${currentPhaseKey}`
        : `Phase ${currentPhaseKey}`
      : "",
  }), [activeProgressMode, completedCount, currentPhaseKey, language, progressItems.length]);

  const shellClass = themeMode === "light"
    ? "bg-[rgba(255,255,255,0.72)] border-[rgba(15,23,42,0.1)] shadow-[0_18px_50px_rgba(15,23,42,0.12)]"
    : "bg-[rgba(10,10,16,0.68)] border-[rgba(255,255,255,0.08)] shadow-[0_20px_60px_rgba(0,0,0,0.28)]";
  const actionableOutline = actionable
    ? "ring-1 ring-[var(--accent)] ring-offset-1 ring-offset-transparent"
    : "";
  const primaryText = themeMode === "light" ? "text-[#111827]" : "text-[#f5f5f5]";
  const secondaryText = themeMode === "light" ? "text-[#4b5563]" : "text-[#71717a]";
  const surface = themeMode === "light" ? "bg-[rgba(255,255,255,0.36)] border-[rgba(15,23,42,0.08)]" : "bg-[rgba(255,255,255,0.04)] border-[#1f1f23]";
  const normalizedCustomReply = customReplyText.replace(/\s+/g, " ").trim();

  const submitCustomReply = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!normalizedCustomReply) return;
    onSelectReplyOption?.({
      label: normalizedCustomReply,
      value: normalizedCustomReply,
    });
    setCustomReplyText("");
  };

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
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        className={`w-full overflow-hidden rounded-[28px] border backdrop-blur-2xl backdrop-saturate-150 transition-all duration-300 ease-out [&_button]:pointer-events-auto ${isVisible && !isPlanApprovalOnly ? "pointer-events-auto" : "pointer-events-none"} ${shouldExpandWidth ? "max-w-4xl" : "max-w-[580px]"} ${shellClass} ${actionableOutline}`}
      >
        <div className="flex items-center justify-between gap-3 px-4 py-3">
          <div className="min-w-0 flex items-center gap-2">
            <span className="shrink-0 text-[10px] uppercase tracking-[0.18em] text-[#71717a]">{copy.viewing}</span>
            <span className={`truncate text-[13px] font-semibold ${primaryText}`}>{title}</span>
            <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] ${statusToneClass}`}>{status}</span>
            {hasTasks && (
              <span data-testid={activeProgressMode === "execution" ? "top-island-execution-badge" : "top-island-plan-badge"} className="shrink-0 rounded-full border border-[rgba(124,58,237,0.2)] bg-[rgba(124,58,237,0.1)] px-2 py-0.5 text-[10px] text-[#c4b5fd]">
                {activeProgressMode === "execution" ? copy.steps : copy.tasks} {completedCount}/{progressItems.length}
              </span>
            )}
            {canApprovePlan && (
              <span className="shrink-0 rounded-full border border-[rgba(251,191,36,0.25)] bg-[rgba(251,191,36,0.12)] px-2 py-0.5 text-[10px] text-[#fbbf24]">
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
            {activeDiffTask && hasActiveDiffPreview && (
              <span className="shrink-0 rounded-full border border-[rgba(96,165,250,0.25)] bg-[rgba(96,165,250,0.12)] px-2 py-0.5 text-[10px] text-[#93c5fd]">
                {copy.diffRequest}
              </span>
            )}
            {!isExpanded && actionable && (
              <span className="shrink-0 h-2 w-2 rounded-full bg-[var(--accent,#7c3aed)] animate-pulse" />
            )}
          </div>
          <button
            onClick={() => setPinnedOpen((value) => !value)}
            className="shrink-0 rounded-full border border-[#27272a] bg-[#09090b] p-1 text-[#a1a1aa] transition-colors hover:bg-[#18181b] hover:text-[#f5f5f5]"
            title={pinnedOpen ? (language === "zh" ? "解除锁定" : "Unlock") : (language === "zh" ? "锁定展开" : "Pin Open")}
          >
            {pinnedOpen ? <IconUnlock className="h-4 w-4" /> : <IconLock className="h-4 w-4" />}
          </button>
        </div>

        <div
          className={`grid transition-all duration-250 ease-out ${
            isExpanded ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"
          }`}
        >
          <div className="overflow-hidden">
            <div className="border-t border-[rgba(255,255,255,0.06)] px-4 pb-4 pt-3">
            {pendingRunDecision && (
              <div>
                <div data-testid="top-island-pending-run-decision" className={`rounded-2xl border p-3 ${surface}`}>
                  <div className={`text-[12px] font-medium ${primaryText}`}>
                    {pendingRunDecision.kind === "execution_consent"
                      ? copy.executionConsentTitle
                      : pendingRunDecision.title || copy.chooseToContinue}
                  </div>
                  <div className={`mt-1 break-words text-[12px] leading-6 ${secondaryText}`}>
                    {pendingRunDecision.reason}
                  </div>
                  {pendingRunDecision.kind === "execution_consent" && (
                    <div className={`mt-1 break-words text-[11px] leading-6 ${secondaryText}`}>
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
                        className="rounded-lg border border-[#3f3f46] bg-[#09090b] px-4 py-2 text-[12px] font-medium text-[#a1a1aa] transition-colors hover:bg-[#18181b] hover:text-[#f5f5f5]"
                      >
                        {copy.dismiss}
                      </button>
                      <button
                        onClick={() => onResolvePendingRunDecision?.("approve_thread")}
                        className={`rounded-lg border px-4 py-2 text-[12px] font-medium transition-colors ${
                          autoApproveTools
                            ? "border-[rgba(124,58,237,0.35)] bg-[rgba(124,58,237,0.14)] text-[#ddd6fe]"
                            : "border-[#3f3f46] bg-[#09090b] text-[#a1a1aa] hover:bg-[#18181b] hover:text-[#f5f5f5]"
                        }`}
                      >
                        {copy.approveThread}
                      </button>
                      <button
                        data-testid="top-island-approve-once"
                        onClick={() => onResolvePendingRunDecision?.("approve_once")}
                        className="rounded-lg px-4 py-2 text-[12px] font-semibold text-white"
                        style={{ background: "linear-gradient(135deg, var(--accent, #7c3aed), #2563eb)" }}
                      >
                        {copy.approveExecuteOnce}
                      </button>
                    </>
                  ) : (
                    <>
                      {(pendingRunDecision.options || []).map((option, index) => (
                        <button
                          key={`${option.id}-${index}`}
                          data-testid={`top-island-intent-option-${option.id}`}
                          onClick={() => onResolvePendingRunDecision?.(option.id)}
                          className={`rounded-lg px-4 py-2 text-[12px] font-medium transition-colors ${
                            index === 0
                              ? "text-white"
                              : "border border-[#3f3f46] bg-[#09090b] text-[#a1a1aa] hover:bg-[#18181b] hover:text-[#f5f5f5]"
                          }`}
                          style={
                            index === 0
                              ? { background: "linear-gradient(135deg, var(--accent, #7c3aed), #2563eb)" }
                              : undefined
                          }
                        >
                          {option.label}
                        </button>
                      ))}
                      <button
                        onClick={() => onResolvePendingRunDecision?.("cancel")}
                        className="rounded-lg border border-[#3f3f46] bg-[#09090b] px-4 py-2 text-[12px] font-medium text-[#a1a1aa] transition-colors hover:bg-[#18181b] hover:text-[#f5f5f5]"
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
              <div data-testid={activeProgressMode === "execution" ? "top-island-execution-progress" : "top-island-plan-progress"} className={`${pendingRunDecision ? "mt-3 " : ""}rounded-2xl border p-3 ${surface}`}>
                <div className="flex items-center justify-between gap-3">
                  <div className={`text-[12px] font-medium ${primaryText}`}>{copy.taskSummary}</div>
                  <div className="flex items-center gap-2">
                    {copy.phaseLabel && <span className={`text-[11px] ${secondaryText}`}>{copy.phaseLabel}</span>}
                    <span className={`text-[11px] ${secondaryText}`}>
                      {activeProgressMode === "execution" ? copy.executionStage : getStageLabel(planStage, language)}
                    </span>
                    {activeProgressMode === "plan" && (
                      <button
                        onClick={onOpenPlan}
                        className="rounded-full border border-[rgba(124,58,237,0.25)] bg-[rgba(124,58,237,0.14)] px-3 py-1 text-[11px] text-[#ddd6fe] transition-colors hover:bg-[rgba(124,58,237,0.22)]"
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
                    className="h-full rounded-full transition-all duration-300"
                    style={{ width: `${progress}%`, background: "linear-gradient(90deg, var(--accent, #7c3aed), #3b82f6)" }}
                  />
                </div>
                <div className="mt-3 max-h-[220px] space-y-2 overflow-y-auto pr-1">
                  {visibleTasks.map((task, index) => (
                    <div key={task.id} className="flex items-start gap-3 rounded-xl bg-[rgba(0,0,0,0.18)] px-3 py-2">
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
                          </div>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {isAwaitingChoice && (
              <div data-testid="top-island-awaiting-choice" className={`mt-3 rounded-2xl border p-3 ${surface}`}>
                <div className={`text-[12px] font-medium ${primaryText}`}>{copy.chooseToContinue}</div>
                <div className={`mt-1 text-[12px] leading-6 ${secondaryText}`}>
                  {hasReplyOptions ? copy.choicePrompt : copy.choiceHint}
                </div>
                {hasReplyOptions && (
                  <div className="mt-3 flex flex-col gap-2">
                    {replyOptions.map((option, index) => (
                      <button
                        key={`${option.value}-${index}`}
                        data-testid={`top-island-reply-option-${index}`}
                        onClick={() => onSelectReplyOption?.(option)}
                        className="w-full rounded-xl border border-[rgba(124,58,237,0.24)] bg-[rgba(124,58,237,0.08)] px-3 py-2.5 text-left text-[12px] leading-6 text-[#f5f3ff] transition-colors hover:bg-[rgba(124,58,237,0.16)]"
                      >
                        {option.label}
                      </button>
                    ))}
                    <form onSubmit={submitCustomReply} className="flex min-w-0 items-center gap-2">
                      <input
                        data-testid="top-island-custom-reply-input"
                        value={customReplyText}
                        onChange={(event) => setCustomReplyText(event.target.value)}
                        placeholder={copy.customChoicePlaceholder}
                        className={`min-w-0 flex-1 rounded-xl border px-3 py-2.5 text-[12px] leading-6 outline-none transition-colors ${
                          themeMode === "light"
                            ? "border-[rgba(15,23,42,0.12)] bg-[rgba(255,255,255,0.62)] text-[#111827] placeholder:text-[#6b7280] focus:border-[rgba(124,58,237,0.45)]"
                            : "border-[#3f3f46] bg-[#09090b] text-[#f5f5f5] placeholder:text-[#71717a] focus:border-[rgba(124,58,237,0.5)]"
                        }`}
                      />
                      <button
                        type="submit"
                        data-testid="top-island-custom-reply-submit"
                        disabled={!normalizedCustomReply || !onSelectReplyOption}
                        className={`shrink-0 rounded-xl px-3 py-2.5 text-[12px] font-semibold transition-opacity ${
                          normalizedCustomReply && onSelectReplyOption ? "text-white opacity-100" : "cursor-not-allowed text-white opacity-40"
                        }`}
                        style={{ background: "linear-gradient(135deg, var(--accent, #7c3aed), #2563eb)" }}
                      >
                        {copy.customChoiceSubmit}
                      </button>
                    </form>
                    <button
                      onClick={onCancelTurn}
                      className="w-full rounded-xl border border-[#3f3f46] bg-[#09090b] px-3 py-2.5 text-left text-[12px] leading-6 text-[#a1a1aa] transition-colors hover:bg-[#18181b] hover:text-[#f5f5f5]"
                    >
                      {copy.cancelTurn}
                    </button>
                  </div>
                )}
              </div>
            )}

            {(activeDiffTask || canApprovePlan) && (
              <div className={`mt-3 grid gap-3 ${activeDiffTask && canApprovePlan ? "md:grid-cols-2" : ""}`}>
                {activeDiffTask && (
                  <div>
                    <div className={`rounded-2xl border p-3 ${surface}`}>
                      <div className={`text-[12px] font-medium ${primaryText}`}>{copy.pendingReview}</div>
                      <div className={`mt-1 break-words text-[12px] leading-6 ${secondaryText}`}>{activeDiffTask.target}</div>
                      <div className={`mt-1 text-[11px] ${secondaryText}`}>{copy.chooseApproval}</div>
                    </div>
                    <div className="mt-3 flex flex-wrap items-center justify-end gap-2 px-1">
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
                        onClick={() => onRejectDiff?.(activeDiffTask.id)}
                        className="rounded-lg border border-[#3f3f46] bg-[#09090b] px-4 py-2 text-[12px] font-medium text-[#a1a1aa] transition-colors hover:bg-[#18181b] hover:text-[#f5f5f5]"
                      >
                        {copy.reject}
                      </button>
                      <button
                        onClick={() => onApproveDiffSession?.()}
                        className={`rounded-lg border px-4 py-2 text-[12px] font-medium transition-colors ${
                          autoApproveTools
                            ? "border-[rgba(124,58,237,0.35)] bg-[rgba(124,58,237,0.14)] text-[#ddd6fe]"
                            : "border-[#3f3f46] bg-[#09090b] text-[#a1a1aa] hover:bg-[#18181b] hover:text-[#f5f5f5]"
                        }`}
                      >
                        {copy.approveDiffSession}
                      </button>
                      <button
                        onClick={() => onApproveDiffOnce?.()}
                        className="rounded-lg px-4 py-2 text-[12px] font-semibold text-white"
                        style={{ background: "linear-gradient(135deg, var(--accent, #7c3aed), #2563eb)" }}
                      >
                        {copy.approveDiffOnce}
                      </button>
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
                    <div className="mt-3 flex items-center justify-end gap-2 px-1">
                      <button
                        onClick={onRejectPlan}
                        className="rounded-lg border border-[#3f3f46] bg-[#09090b] px-4 py-2 text-[12px] font-medium text-[#a1a1aa] transition-colors hover:bg-[#18181b] hover:text-[#f5f5f5]"
                      >
                        {copy.reject}
                      </button>
                      <button
                        data-testid="top-island-plan-approve"
                        onClick={onApprovePlan}
                        className="rounded-lg px-4 py-2 text-[12px] font-semibold text-white"
                        style={{ background: "linear-gradient(135deg, var(--accent, #7c3aed), #2563eb)" }}
                      >
                        {copy.approvePlan}
                      </button>
                    </div>
                  </div>
                )}
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
