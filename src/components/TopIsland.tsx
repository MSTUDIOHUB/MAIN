import { memo, useMemo, useState } from "react";
import { IconColumns, IconFileText, IconLock, IconUnlock } from "./Icons";
import type { PlanStage, PlanTask, ReplyOption } from "../lib/workflowModels";
import type { PendingRunDecision, ResolvedUserIntent } from "../lib/runIntent";
import MarkdownRenderer from "./MarkdownRenderer";

interface TopIslandProps {
  title: string;
  status: string;
  statusToneClass: string;
  language: "zh" | "en";
  themeMode: "light" | "dark";
  planTasks: PlanTask[];
  planStage: PlanStage;
  isAwaitingChoice?: boolean;
  replyOptions?: ReplyOption[];
  pendingRunDecision?: PendingRunDecision | null;
  activeDiffTask?: any;
  canApprovePlan: boolean;
  autoApproveTools?: boolean;
  onSelectReplyOption?: (value: string) => void;
  onResolvePendingRunDecision?: (choice: ResolvedUserIntent | "approve_once" | "approve_thread" | "cancel") => void;
  onDismissPendingRunDecision?: () => void;
  onApprovePlan: () => void;
  onRejectPlan: () => void;
  onRejectDiff?: (id: number) => void;
  onApproveDiffOnce?: () => void;
  onApproveDiffSession?: () => void;
  onOpenPlan: () => void;
  onOpenDiff: () => void;
}

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
  planTasks,
  planStage,
  isAwaitingChoice = false,
  replyOptions = [],
  pendingRunDecision = null,
  activeDiffTask,
  canApprovePlan,
  autoApproveTools,
  onSelectReplyOption,
  onResolvePendingRunDecision,
  onDismissPendingRunDecision,
  onApprovePlan,
  onRejectPlan,
  onRejectDiff,
  onApproveDiffOnce,
  onApproveDiffSession,
  onOpenPlan,
  onOpenDiff,
}: TopIslandProps) {
  const [hovered, setHovered] = useState(false);
  const [pinnedOpen, setPinnedOpen] = useState(false);

  const hasReplyOptions = replyOptions.length > 0;
  const hasPendingRunDecision = !!pendingRunDecision;
  const forceExpanded = hasReplyOptions || isAwaitingChoice || hasPendingRunDecision || !!activeDiffTask || canApprovePlan;
  const actionable = forceExpanded || hasPendingRunDecision || !!activeDiffTask || canApprovePlan;
  const hasTasks = planTasks.length > 0;
  const shouldExpandWidth = hovered || pinnedOpen || forceExpanded;
  const isExpanded = pinnedOpen || hovered || forceExpanded;
  const completedCount = planTasks.filter((task) => task.status === "completed").length;
  const progress = planTasks.length > 0 ? Math.round((completedCount / planTasks.length) * 100) : 0;
  const currentPhaseKey = useMemo(() => {
    const firstIncomplete = planTasks.find((task) => task.status !== "completed") || planTasks[planTasks.length - 1];
    if (!firstIncomplete) return null;
    const matched = firstIncomplete.text.match(/(?:Task|T)\s*([0-9]+)(?:[.\-][0-9]+)?/i);
    return matched?.[1] || null;
  }, [planTasks]);
  const visibleTasks = useMemo(() => {
    if (!currentPhaseKey) return planTasks;
    const grouped = planTasks.filter((task) => {
      const matched = task.text.match(/(?:Task|T)\s*([0-9]+)(?:[.\-][0-9]+)?/i);
      return (matched?.[1] || null) === currentPhaseKey;
    });
    return grouped.length > 0 ? grouped : planTasks;
  }, [currentPhaseKey, planTasks]);

  const copy = useMemo(() => ({
    viewing: language === "zh" ? "当前查看" : "Viewing",
    tasks: language === "zh" ? "任务" : "Tasks",
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
    executionConsentTitle: language === "zh" ? "允许开始执行本轮改动？" : "Allow this turn to start making changes?",
    executionConsentHint: language === "zh"
      ? "这是本轮第一次真实写入/执行动作。确认后 MAIN 才会继续推进。"
      : "This is the first real write/execute action in the turn. MAIN will continue only after you confirm.",
    approveExecuteOnce: language === "zh" ? "仅本轮执行" : "Allow This Turn",
    approveThread: language === "zh" ? "本对话自动执行" : "Auto-Run In Thread",
    dismiss: language === "zh" ? "取消" : "Cancel",
    taskSummary: language === "zh"
      ? `共 ${planTasks.length} 个任务，已完成 ${completedCount} 个`
      : `${completedCount}/${planTasks.length} tasks completed`,
    phaseLabel: currentPhaseKey
      ? language === "zh"
        ? `阶段 ${currentPhaseKey}`
        : `Phase ${currentPhaseKey}`
      : "",
  }), [completedCount, currentPhaseKey, language, planTasks.length]);

  const shellClass = themeMode === "light"
    ? "bg-[rgba(255,255,255,0.86)] border-[rgba(15,23,42,0.08)] shadow-[0_18px_50px_rgba(15,23,42,0.12)]"
    : "bg-[rgba(8,8,12,0.82)] border-[rgba(124,58,237,0.18)] shadow-[0_20px_60px_rgba(0,0,0,0.35)]";
  const actionableOutline = actionable
    ? "ring-1 ring-[var(--accent)] ring-offset-1 ring-offset-transparent"
    : "";
  const primaryText = themeMode === "light" ? "text-[#111827]" : "text-[#f5f5f5]";
  const secondaryText = themeMode === "light" ? "text-[#4b5563]" : "text-[#71717a]";
  const surface = themeMode === "light" ? "bg-[rgba(15,23,42,0.03)] border-[#e5e7eb]" : "bg-[rgba(255,255,255,0.03)] border-[#1f1f23]";

  return (
    <div className="pointer-events-none absolute left-0 right-0 top-[58px] z-30 flex justify-center px-4">
      <div
        data-testid="top-island-shell"
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        className={`pointer-events-auto w-full overflow-hidden rounded-[28px] border backdrop-blur-xl transition-all duration-300 ${shouldExpandWidth ? "max-w-4xl" : "max-w-[580px]"} ${shellClass} ${actionableOutline}`}
      >
        <div className="flex items-center justify-between gap-3 px-4 py-3">
          <div className="min-w-0 flex items-center gap-2">
            <span className="shrink-0 text-[10px] uppercase tracking-[0.18em] text-[#71717a]">{copy.viewing}</span>
            <span className={`truncate text-[13px] font-semibold ${primaryText}`}>{title}</span>
            <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] ${statusToneClass}`}>{status}</span>
            {hasTasks && (
              <span className="shrink-0 rounded-full border border-[rgba(124,58,237,0.2)] bg-[rgba(124,58,237,0.1)] px-2 py-0.5 text-[10px] text-[#c4b5fd]">
                {copy.tasks} {completedCount}/{planTasks.length}
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
            {activeDiffTask && (
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

        {isExpanded && (
          <div className="border-t border-[rgba(255,255,255,0.06)] px-4 pb-4 pt-3">
            {pendingRunDecision && (
              <div data-testid="top-island-pending-run-decision" className={`rounded-2xl border p-3 ${surface}`}>
                <div className={`text-[12px] font-medium ${primaryText}`}>
                  {pendingRunDecision.kind === "execution_consent"
                    ? copy.executionConsentTitle
                    : pendingRunDecision.title || copy.chooseToContinue}
                </div>
                <div className={`mt-1 text-[12px] leading-6 ${secondaryText}`}>
                  {pendingRunDecision.reason}
                </div>
                {pendingRunDecision.kind === "execution_consent" && (
                  <div className={`mt-1 text-[11px] leading-6 ${secondaryText}`}>
                    {copy.executionConsentHint}
                    {pendingRunDecision.target ? ` ${pendingRunDecision.target}` : ""}
                  </div>
                )}
                <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
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
              <div className={`${pendingRunDecision ? "mt-3 " : ""}rounded-2xl border p-3 ${surface}`}>
                <div className="flex items-center justify-between gap-3">
                  <div className={`text-[12px] font-medium ${primaryText}`}>{copy.taskSummary}</div>
                  <div className="flex items-center gap-2">
                    {copy.phaseLabel && <span className={`text-[11px] ${secondaryText}`}>{copy.phaseLabel}</span>}
                    <span className={`text-[11px] ${secondaryText}`}>{getStageLabel(planStage, language)}</span>
                    <button
                      onClick={onOpenPlan}
                      className="rounded-full border border-[rgba(124,58,237,0.25)] bg-[rgba(124,58,237,0.14)] px-3 py-1 text-[11px] text-[#ddd6fe] transition-colors hover:bg-[rgba(124,58,237,0.22)]"
                    >
                      <span className="inline-flex items-center gap-1.5">
                        <IconFileText className="h-3.5 w-3.5" />
                        {copy.openPlan}
                      </span>
                    </button>
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
                          task.status === "completed"
                            ? "border-[#34d399] bg-[#34d399] text-[#050507]"
                            : task.status === "in_progress"
                            ? "border-[#60a5fa] bg-[#60a5fa]"
                            : "border-[#3f3f46] bg-transparent"
                        }`}
                      >
                        {task.status === "completed" && (
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
                        onClick={() => onSelectReplyOption?.(option.value)}
                        className="w-full rounded-xl border border-[rgba(124,58,237,0.24)] bg-[rgba(124,58,237,0.08)] px-3 py-2.5 text-left text-[12px] leading-6 text-[#f5f3ff] transition-colors hover:bg-[rgba(124,58,237,0.16)]"
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}

            {(activeDiffTask || canApprovePlan) && (
              <div className={`mt-3 grid gap-3 ${activeDiffTask && canApprovePlan ? "md:grid-cols-2" : ""}`}>
                {activeDiffTask && (
                  <div className={`rounded-2xl border p-3 ${surface}`}>
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <div className={`text-[12px] font-medium ${primaryText}`}>{copy.pendingReview}</div>
                        <div className={`mt-1 text-[12px] ${secondaryText}`}>{activeDiffTask.target}</div>
                        <div className={`mt-1 text-[11px] ${secondaryText}`}>{copy.chooseApproval}</div>
                      </div>
                      <button
                        onClick={onOpenDiff}
                        className="rounded-full border border-[rgba(96,165,250,0.25)] bg-[rgba(96,165,250,0.12)] px-3 py-1 text-[11px] text-[#bfdbfe] transition-colors hover:bg-[rgba(96,165,250,0.2)]"
                      >
                        <span className="inline-flex items-center gap-1.5">
                          <IconColumns className="h-3.5 w-3.5" />
                          {copy.openDiff}
                        </span>
                      </button>
                    </div>
                    <div className="mt-3 flex items-center justify-end gap-2">
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
                  <div className={`rounded-2xl border p-3 ${surface}`}>
                    <div className={`text-[12px] font-medium ${primaryText}`}>{copy.waitingPlan}</div>
                    <div className={`mt-1 text-[12px] leading-6 ${secondaryText}`}>
                      {language === "zh"
                        ? "当前计划已经准备就绪。确认后会先生成执行任务列表，再进入执行阶段。"
                        : "The current plan is ready. Approving it will generate the execution task list first and then start execution."}
                    </div>
                    <div className="mt-3 flex items-center justify-end gap-2">
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
        )}
      </div>
    </div>
  );
});

export default TopIsland;
