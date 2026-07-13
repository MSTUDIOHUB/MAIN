import { memo, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { IconColumns, IconInfo } from "./Icons";
import type { TurnProgressItem } from "../lib/turnProgress";
import { buildPlanTaskEvidenceAudit, isPlanTaskAwaitingBrowserValidation, isPlanTaskAwaitingExternalValidation, type PlanExecutionEvidenceEntry, type PlanStage, type PlanTask, type ReplyOption } from "../lib/workflowModels";
import type { PendingRunDecision, PendingRunDecisionChoice } from "../lib/runIntent";
import {
  isOperationProposalApprovalOption,
  resolveCustomReplyOptionAction,
  simplifyOperationProposalReplyOptions,
} from "../lib/replyOptions";
import type { TurnPresentationModel } from "../lib/turnPresentation";
import type { ToolPermissionResolutionIdentity } from "../lib/actionRequest";

// region: ExecutionCapsule 属性定义
interface ExecutionCapsuleProps {
  title: string;
  presentation?: TurnPresentationModel;
  turnId?: string;
  runId?: string;
  requestId?: string;
  permissionIdentity?: ToolPermissionResolutionIdentity;
  status: string;
  statusToneClass: string;
  language: "zh" | "en";
  themeMode: "light" | "dark" | "black";
  chatFontSize?: number;
  isRunActive?: boolean;
  planTasks: PlanTask[];
  planExecutionEvidenceLedger?: PlanExecutionEvidenceEntry[];
  planStage: PlanStage;
  executionSteps?: TurnProgressItem[];
  progressMode?: "plan" | "execution";
  isAwaitingChoice?: boolean;
  replyOptions?: ReplyOption[];
  allowCustomReply?: boolean;
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
  onRejectDiff?: (identity: ToolPermissionResolutionIdentity) => void;
  onApproveDiffOnce?: (identity: ToolPermissionResolutionIdentity) => void;
  onApproveDiffSession?: (identity: ToolPermissionResolutionIdentity) => void;
  onOpenDiff: () => void;
}
// endregion

function isApprovalActionOption(option: ReplyOption): boolean {
  return (
    option.action === "continue_readonly_once" ||
    option.action === "allow_readonly_session"
  );
}

function getDisplayReplyOptionLabel(option: ReplyOption, language: "zh" | "en"): string {
  if (option.action === "approve_operation_once") {
    return option.label || option.value || (language === "zh" ? "批准执行本轮方案" : "Approve And Run This Plan");
  }
  if (option.action === "execute_once") {
    return option.label || option.value || (language === "zh" ? "直接执行本轮" : "Run This Choice");
  }
  if (option.action === "adjust_plan") {
    return option.label || option.value || (language === "zh" ? "继续调整方案" : "Keep Adjusting The Plan");
  }
  if (option.action === "cancel_operation") {
    return option.label || option.value || (language === "zh" ? "取消本轮操作" : "Cancel This Operation");
  }
  if (option.action === "continue_readonly_once") {
    return option.label || option.value || (language === "zh" ? "继续当前只读读取" : "Continue This Read");
  }
  if (option.action === "allow_readonly_session") {
    return option.label || option.value || (language === "zh" ? "当前会话只读步骤全部批准" : "Allow Read-Only Steps In Session");
  }
  return option.label || option.value || "";
}

function renderFormattedLabel(text: string): ReactNode {
  if (!text) return "";
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  return parts.map((part, index) => {
    if (part.startsWith("**") && part.endsWith("**")) {
      return (
        <strong key={index} className="font-bold text-white">
          {part.slice(2, -2)}
        </strong>
      );
    }
    if (part.startsWith("`") && part.endsWith("`")) {
      return (
        <code
          key={index}
          className="rounded border border-[rgba(255,255,255,0.15)] bg-[rgba(255,255,255,0.06)] px-1.5 py-0.5 font-mono text-[0.9em] text-[#fbbf24]"
        >
          {part.slice(1, -1)}
        </code>
      );
    }
    return part;
  });
}

const ExecutionCapsule = memo(function ExecutionCapsule({
  title,
  presentation,
  turnId,
  runId,
  requestId,
  permissionIdentity,
  status,
  statusToneClass,
  language,
  themeMode,
  chatFontSize = 13,
  isRunActive = false,
  planTasks,
  planExecutionEvidenceLedger = [],
  planStage,
  executionSteps = [],
  progressMode,
  isAwaitingChoice = false,
  replyOptions = [],
  allowCustomReply = false,
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
  onRejectDiff,
  onApproveDiffOnce,
  onApproveDiffSession,
  onOpenDiff,
}: ExecutionCapsuleProps) {
  const [customReplyText, setCustomReplyText] = useState("");
  const [planAdjustmentText, setPlanAdjustmentText] = useState("");
  const [isApproving, setIsApproving] = useState(false);
  const [choiceOptionsCollapsed, setChoiceOptionsCollapsed] = useState(false);
  const approvingRef = useRef(false);
  const resolvedTitle = presentation?.title || title;
  const resolvedStatus = presentation?.statusLabel || status;
  const resolvedSessionKey = permissionIdentity?.sessionKey;
  const resolvedTurnId = permissionIdentity?.turnId || turnId || presentation?.turnId;
  const resolvedRunId = permissionIdentity?.runId || runId || presentation?.runId;
  const resolvedRequestId = permissionIdentity?.requestId || requestId || presentation?.requestId;

  useEffect(() => {
    if (planStage === "executing" || isRunActive) {
      approvingRef.current = false;
      setIsApproving(false);
    }
  }, [planStage, isRunActive]);

  const handleApprovePlan = () => {
    if (approvingRef.current || isApproving || isRunActive || planStage === "executing") return;
    approvingRef.current = true;
    setIsApproving(true);
    onApprovePlan();
  };

  const [activeTabIdx, setActiveTabIdx] = useState(0);
  const [tabSelections, setTabSelections] = useState<Record<string, string[]>>({});
  const [tabWriteIns, setTabWriteIns] = useState<Record<string, string>>({});
  const simplifiedReplyOptions = useMemo(
    () => simplifyOperationProposalReplyOptions(replyOptions),
    [replyOptions],
  );
  const hasOperationProposalApproval = useMemo(
    () => replyOptions.some((option) => isOperationProposalApprovalOption(option)),
    [replyOptions],
  );

  const tabGroups = useMemo(() => {
    const hasTabPrefix = simplifiedReplyOptions.some(opt => /^\[([^\]]+)\]/.test(opt.label));
    if (!hasTabPrefix) return null;

    const groupsMap: Record<string, { category: string; cleanCategory: string; isMulti: boolean; options: ReplyOption[] }> = {};
    
    simplifiedReplyOptions.forEach(opt => {
      const match = opt.label.match(/^\[([^\]]+)\]\s*(.*)$/);
      if (match) {
        const fullCategory = match[1].trim();
        const cleanLabel = match[2].trim();
        const isMulti = /\((?:多选|multi|checkbox|multiple)\)/i.test(fullCategory);
        const cleanCategory = fullCategory.replace(/\((?:多选|multi|checkbox|multiple)\)/gi, "").trim();
        
        if (!groupsMap[cleanCategory]) {
          groupsMap[cleanCategory] = {
            category: fullCategory,
            cleanCategory,
            isMulti,
            options: [],
          };
        }
        groupsMap[cleanCategory].options.push({
          ...opt,
          label: cleanLabel,
        });
      } else {
        const cleanCategory = language === "zh" ? "其他" : "Other";
        if (!groupsMap[cleanCategory]) {
          groupsMap[cleanCategory] = {
            category: cleanCategory,
            cleanCategory,
            isMulti: false,
            options: [],
          };
        }
        groupsMap[cleanCategory].options.push(opt);
      }
    });
    
    return Object.values(groupsMap);
  }, [simplifiedReplyOptions, language]);

  useEffect(() => {
    setActiveTabIdx(0);
    setTabSelections({});
    setTabWriteIns({});
  }, [replyOptions]);

  const replyOptionsSignature = useMemo(
    () => simplifiedReplyOptions.map((option) => `${option.action || ""}:${option.value || option.label}`).join("|"),
    [simplifiedReplyOptions],
  );

  useEffect(() => {
    setChoiceOptionsCollapsed(false);
  }, [canApprovePlan, isAwaitingChoice, replyOptionsSignature]);

  const handleTabbedSubmit = () => {
    if (!tabGroups) return;
    const responses: string[] = [];
    
    tabGroups.forEach(group => {
      const selectedValues = tabSelections[group.cleanCategory] || [];
      const writeInText = tabWriteIns[group.cleanCategory]?.trim();
      const parts: string[] = [];
      if (selectedValues.length > 0) {
        parts.push(selectedValues.join(", "));
      }
      if (writeInText) {
        parts.push(`Other: ${writeInText}`);
      }
      if (parts.length > 0) {
        responses.push(`[${group.cleanCategory}] ${parts.join(" | ")}`);
      }
    });

    if (responses.length === 0) return;

    const summaryLabel = responses.map(r => r.replace(/^\[([^\]]+)\]\s*/, "$1: ")).join(" | ");
    const finalValue = language === "zh"
      ? `已确认以下规格选择：\n${responses.map(r => `- ${r}`).join("\n")}`
      : `Confirmed the following selections:\n${responses.map(r => `- ${r}`).join("\n")}`;

    onSelectReplyOption?.({
      label: summaryLabel,
      value: finalValue,
      source: "custom_reply",
    });
  };

  const realChoiceOptions = useMemo(
    () => simplifiedReplyOptions.filter((option) => !isApprovalActionOption(option)),
    [simplifiedReplyOptions],
  );
  const approvalActionOptions = useMemo(
    () => simplifiedReplyOptions.filter((option) => isApprovalActionOption(option)),
    [simplifiedReplyOptions],
  );
  const hasRealChoiceOptions = realChoiceOptions.length > 0;
  const hasApprovalActionOptions = approvalActionOptions.length > 0;

  // region: ExecutionCapsule 展开时机
  const hasReplyOptions = hasRealChoiceOptions || hasApprovalActionOptions;
  const hasPendingRunDecision = !!pendingRunDecision;
  const reviewTaskCandidate = pendingToolReview || activeDiffTask;
  const activeReviewTask = permissionIdentity &&
    reviewTaskCandidate?.id === permissionIdentity.taskId &&
    reviewTaskCandidate?.turnId === permissionIdentity.turnId
    ? reviewTaskCandidate
    : null;
  const hasPendingToolReview = !!activeReviewTask;
  const hasActiveDiffPreview = !!activeReviewTask?.diff;
  const hasChoicePromptContent = hasReplyOptions || isAwaitingChoice || hasPendingRunDecision;
  const hasExpandableContent =
    hasReplyOptions ||
    isAwaitingChoice ||
    hasPendingRunDecision ||
    hasPendingToolReview ||
    canApprovePlan ||
    planTasks.length > 0 ||
    executionSteps.length > 0;
  const actionable = hasChoicePromptContent || hasPendingToolReview || canApprovePlan;
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
  const isExpanded = hasExpandableContent;
  // endregion
  const completedCount = progressItems.filter((item) => item.complete).length;

  const copy = useMemo(() => ({
    tasks: language === "zh" ? "任务" : "Tasks",
    steps: language === "zh" ? "步骤" : "Steps",
    pendingReview: language === "zh" ? "待审批" : "Pending Review",
    openPlan: language === "zh" ? "查看计划" : "Open Plan",
    openDiff: language === "zh" ? "查看变更" : "Open Diff",
    accept: language === "zh" ? "接受" : "Accept",
    approveDiffOnce: language === "zh" ? "批准此工具请求" : "Approve This Request",
    approveDiffSession: language === "zh" ? "开启自动审查并批准" : "Turn On Auto Review",
    reject: language === "zh" ? "拒绝" : "Reject",
    approvePlan: language === "zh" ? "开始执行" : "Start Execution",
    waitingPlan: language === "zh" ? "计划待确认" : "Plan Waiting",
    adjustPlan: language === "zh" ? "调整计划" : "Adjust Plan",
    adjustPlanPlaceholder: language === "zh" ? "说明需要如何调整，或提出其他要求" : "Describe changes or another request",
    adjustPlanSubmit: language === "zh" ? "提交意见" : "Submit Feedback",
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
      ? hasOperationProposalApproval
        ? "批准即可执行；如需调整，请在下方说明具体修改点。"
        : "直接在这里点选即可继续当前回合。"
      : hasOperationProposalApproval
        ? "Approve to run, or describe the specific changes you want below."
        : "Choose an option here to continue the current turn.",
    choicesSectionTitle: language === "zh" ? "选择下一步" : "Choose the next step",
    approvalActionsTitle: language === "zh" ? "只读授权动作" : "Read-only Permission Actions",
    approvalActionsHint: language === "zh"
      ? "这些只会允许读取、搜索和分析，不会直接执行写入修改。"
      : "These only allow reading, searching, and analysis; they do not start write changes.",
    customChoicePlaceholder: language === "zh"
      ? hasOperationProposalApproval ? "说明需要如何调整，或提出其他要求" : "输入你的想法作为选项"
      : hasOperationProposalApproval ? "Describe changes or another request" : "Type your own choice",
    customChoiceSubmit: language === "zh"
      ? hasOperationProposalApproval ? "提交意见" : "确认"
      : hasOperationProposalApproval ? "Submit Feedback" : "Confirm",
    executionConsentTitle: language === "zh" ? "允许开始执行本轮改动？" : "Allow this turn to start making changes?",
    executionConsentHint: language === "zh"
      ? "这是本轮第一次真实写入/命令动作。确认后 MAIN 会继续；开启自动审查会在本会话自动批准非破坏性文件修改、命令、本地读取、MCP 动作和浏览器验证。"
      : "This is the first real write/command action in this turn. MAIN continues after confirmation; Auto Review approves non-destructive file changes, commands, local reads, MCP actions, and browser validation in this session.",
    approveExecuteOnce: language === "zh" ? "直接执行本轮" : "Run This Turn",
    approveThread: language === "zh" ? "开启自动审查并执行" : "Auto Review And Run",
    dismiss: language === "zh" ? "取消/继续调整" : "Cancel / Adjust",
    cancelTurn: language === "zh" ? "结束本轮" : "End Turn",
    cancelTurnInfo: language === "zh"
      ? "停止当前回合，不会执行上述方案。"
      : "Stop the current turn without executing the proposal.",
    endPlanTurnInfo: language === "zh"
      ? "停止当前回合并保留计划文件，不会开始执行。"
      : "Stop the current turn and keep the plan file without starting execution.",
    intentOptionInfo: language === "zh"
      ? "选择后 MAIN 会按这个意图重新处理当前输入。"
      : "Selecting this tells MAIN which intent to use for the current input.",
    replyOptionInfo: language === "zh"
      ? "选择后会把该选项作为用户回复发回当前回合。"
      : "Selecting this sends the option back as your reply for this turn.",
    approveOperationInfo: language === "zh"
      ? "选择此项将批准执行本轮模型提出的全部修改与优化方案。"
      : "Selecting this approves the execution of all proposed code modifications and optimization plans.",
    readonlyOnceInfo: language === "zh"
      ? "只批准这一次只读读取、搜索或分析请求。"
      : "Approves only this read/search/analysis request.",
    readonlySessionInfo: language === "zh"
      ? "本会话后续只读读取、搜索和分析会自动继续。"
      : "Allows later read/search/analysis steps in this session.",
    executeOnceInfo: language === "zh"
      ? "批准当前回合继续执行；后续审批仍按设置处理。"
      : "Allows this turn to continue; later reviews follow your settings.",
    autoReviewInfo: language === "zh"
      ? "开启后本会话会自动批准非破坏性文件修改、终端命令、本地文件读取、MCP 动作和浏览器验证。"
      : "When enabled, MAIN auto-approves non-destructive file changes, shell commands, local file reads, MCP actions, and browser validation in this session.",
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
  }), [activeProgressMode, completedCount, hasOperationProposalApproval, language, progressItems.length]);

  const isBlackTheme = themeMode === "black";
  const activeRunOutline = isRunActive
    ? "rounded-2xl border border-[var(--accent)]"
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
  const showChoicePromptContent = true;
  const showPendingRunDecision = !!pendingRunDecision && showChoicePromptContent;
  const showAwaitingChoice = (isAwaitingChoice || canApprovePlan) && showChoicePromptContent;
  const choiceTextFontSize = Math.max(12, chatFontSize);
  const choiceTextLineHeight = Math.max(20, Math.round(choiceTextFontSize * 1.7));
  const choiceSectionFontSize = Math.max(11, choiceTextFontSize - 1);
  const choiceSectionLineHeight = Math.max(16, Math.round(choiceSectionFontSize * 1.55));
  const customChoiceNumber = hasRealChoiceOptions ? realChoiceOptions.length + 1 : 1;
  const choiceTextStyle = { fontSize: `${choiceTextFontSize}px`, lineHeight: `${choiceTextLineHeight}px` };
  const choiceSectionStyle = { fontSize: `${choiceSectionFontSize}px`, lineHeight: `${choiceSectionLineHeight}px` };
  const choiceOptionButtonClass = "execution-capsule-choice-option w-full min-w-0 rounded-xl border px-3 py-2.5 text-left transition-all duration-150";
  const choiceNumberClass = "execution-capsule-choice-number w-7 shrink-0 text-right font-semibold transition-colors duration-150";
  const approvalOptionButtonClass = "execution-capsule-approval-option w-full rounded-xl border px-3 py-2.5 text-left transition-all duration-150";
  const neutralActionButtonClass = themeMode === "light"
    ? "rounded-xl border border-[rgba(15,23,42,0.14)] bg-[rgba(255,255,255,0.72)] text-[#334155] transition-all duration-150 hover:border-[var(--accent)] hover:bg-[var(--accent-subtle)] hover:text-[#111827]"
    : isBlackTheme
    ? "rounded-xl border border-[#202026] bg-[#030304] text-[#c4c4cc] transition-all duration-150 hover:border-[var(--accent)] hover:bg-[color-mix(in_srgb,var(--accent)_14%,transparent)] hover:text-[#f5f5f5]"
    : "rounded-xl border border-[#3f3f46] bg-[#09090b] text-[#a1a1aa] transition-all duration-150 hover:border-[var(--accent)] hover:bg-[color-mix(in_srgb,var(--accent)_14%,transparent)] hover:text-[#f5f5f5]";

  const submitCustomReply = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!normalizedCustomReply) return;
    const resolvedAction = resolveCustomReplyOptionAction(normalizedCustomReply, replyOptions);
    onSelectReplyOption?.({
      label: normalizedCustomReply,
      value: normalizedCustomReply,
      source: "custom_reply",
      ...(resolvedAction ? { action: resolvedAction } : {}),
    });
    setCustomReplyText("");
  };

  const submitPlanAdjustment = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!normalizedPlanAdjustment || !onRequestPlanAdjustment) return;
    onRequestPlanAdjustment(normalizedPlanAdjustment);
    setPlanAdjustmentText("");
  };

  return (
    <div
      data-testid="execution-capsule-shell"
      data-run-active={isRunActive ? "true" : "false"}
      data-session-key={resolvedSessionKey || undefined}
      data-turn-id={resolvedTurnId || undefined}
      data-run-id={resolvedRunId || undefined}
      data-request-id={resolvedRequestId || undefined}
      data-task-id={permissionIdentity?.taskId ?? undefined}
      data-presentation-kind={presentation?.kind || undefined}
      data-turn-lifecycle={presentation?.lifecycle || undefined}
      className={`execution-capsule-controls w-full min-w-0 [&_button]:pointer-events-auto [&_input]:pointer-events-auto [&_textarea]:pointer-events-auto [&_select]:pointer-events-auto ${activeRunOutline}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0 flex flex-wrap items-center gap-2">
            <span data-testid="execution-capsule-title" className="min-w-0 max-w-full truncate text-[12px] font-semibold text-[var(--surface-text-strong)]" title={resolvedTitle}>
              {resolvedTitle}
            </span>
            <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] ${statusToneClass}`}>{resolvedStatus}</span>
            {hasTasks && (
              <span data-testid={activeProgressMode === "execution" ? "execution-capsule-execution-badge" : "execution-capsule-plan-badge"} className="theme-plan-pill shrink-0 rounded-full border px-2 py-0.5 text-[10px]">
                {activeProgressMode === "execution" ? copy.steps : copy.tasks} {completedCount}/{progressItems.length}
              </span>
            )}
            {canApprovePlan && (
              <span className="theme-plan-pill shrink-0 rounded-full border px-2 py-0.5 text-[10px]">
                {copy.waitingPlan}
              </span>
            )}
            {isAwaitingChoice && !canApprovePlan && (
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
      </div>

      {isExpanded && (
        <div className="mt-3 border-t border-[rgba(255,255,255,0.08)] pt-3">
            {showPendingRunDecision && (
              <div>
                <div data-testid="execution-capsule-pending-run-decision" className={`rounded-2xl border p-3 ${surface}`}>
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
                        title={copy.autoReviewInfo}
                      >
                        <span className="inline-flex items-center gap-1.5">
                          {copy.approveThread}
                          <IconInfo className="h-3.5 w-3.5 opacity-75" />
                        </span>
                      </button>
                      <button
                        data-testid="execution-capsule-approve-once"
                        onClick={() => onResolvePendingRunDecision?.("approve_once")}
                        className="theme-plan-primary rounded-lg px-4 py-2 text-[12px] font-semibold"
                        title={copy.executeOnceInfo}
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
                            <span data-testid={`execution-capsule-intent-option-badge-${index}`} className={choiceNumberClass} style={choiceTextStyle}>{index + 1}.</span>
                            <button
                              data-testid={`execution-capsule-intent-option-${option.id}`}
                              onClick={() => onResolvePendingRunDecision?.(option.id)}
                              className={choiceOptionButtonClass}
                              style={choiceTextStyle}
                              title={copy.intentOptionInfo}
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



            {showAwaitingChoice && choiceOptionsCollapsed && (
              <button
                type="button"
                data-testid="execution-capsule-show-options"
                onClick={() => setChoiceOptionsCollapsed(false)}
                className={`mt-3 w-full px-3 py-2.5 text-center text-[12px] font-semibold ${neutralActionButtonClass}`}
                style={choiceTextStyle}
              >
                {copy.showOptions}
              </button>
            )}

            {showAwaitingChoice && !choiceOptionsCollapsed && (
              <div data-testid="execution-capsule-awaiting-choice" className={`mt-3 rounded-2xl border p-3 ${surface}`}>
                <div className="flex min-w-0 items-start justify-between gap-3">
                  <div className={`min-w-0 font-medium ${primaryText}`} style={choiceTextStyle}>{copy.chooseToContinue}</div>
                  <button
                    type="button"
                    data-testid="execution-capsule-collapse-options"
                    onClick={() => setChoiceOptionsCollapsed(true)}
                    className={`shrink-0 px-2.5 py-1.5 text-[11px] font-semibold ${neutralActionButtonClass}`}
                    style={choiceSectionStyle}
                  >
                    {copy.collapseOptions}
                  </button>
                </div>
                <div className={`mt-1 ${secondaryText}`} style={choiceTextStyle}>
                  {canApprovePlan
                    ? language === "zh"
                      ? "计划已经准备就绪。开始执行，或在下方说明需要调整的内容。"
                      : "The plan is ready. Start execution, or describe the changes you want below."
                    : hasRealChoiceOptions
                    ? copy.choicePrompt
                    : hasApprovalActionOptions
                    ? copy.approvalActionsHint
                    : copy.choiceHint}
                </div>
                {canApprovePlan && (
                  <div className="mt-2 flex flex-col gap-2">
                    <div className="space-y-2">
                      <div className="group flex min-w-0 items-center gap-2">
                        <span className={choiceNumberClass} style={choiceTextStyle}>1.</span>
                        <button
                          data-testid="execution-capsule-plan-approve"
                          onClick={handleApprovePlan}
                          disabled={isApproving || isRunActive || planStage === "executing"}
                          className={`${choiceOptionButtonClass} theme-plan-primary text-center font-semibold ${
                            (isApproving || isRunActive || planStage === "executing") ? "cursor-not-allowed opacity-50" : ""
                          }`}
                          style={choiceTextStyle}
                        >
                          {copy.approvePlan}
                        </button>
                      </div>
                    </div>

                    <form
                      onSubmit={submitPlanAdjustment}
                      data-testid="execution-capsule-plan-adjust-form"
                      className="group flex min-w-0 items-center gap-2"
                    >
                      <span className={choiceNumberClass} style={choiceTextStyle}>2.</span>
                      <div className="flex min-w-0 flex-1 items-center gap-2">
                        <input
                          data-testid="execution-capsule-plan-adjust-input"
                          value={planAdjustmentText}
                          onChange={(event) => setPlanAdjustmentText(event.target.value)}
                          placeholder={copy.adjustPlanPlaceholder}
                          className="execution-capsule-choice-input min-w-0 flex-1 rounded-xl border px-3 py-2.5 outline-none transition-all"
                          style={choiceTextStyle}
                          aria-label={copy.adjustPlan}
                        />
                        <button
                          type="submit"
                          data-testid="execution-capsule-plan-adjust-submit"
                          disabled={!normalizedPlanAdjustment || !onRequestPlanAdjustment}
                          className={`theme-plan-primary shrink-0 rounded-xl px-3 py-2.5 text-[12px] font-semibold transition-opacity ${
                            normalizedPlanAdjustment && onRequestPlanAdjustment ? "opacity-100" : "cursor-not-allowed opacity-40"
                          }`}
                        >
                          {copy.adjustPlanSubmit}
                        </button>
                      </div>
                    </form>

                    <button
                      data-testid="execution-capsule-plan-end-turn"
                      onClick={onRejectPlan}
                      title={copy.endPlanTurnInfo}
                      className="w-full rounded-xl border border-[rgba(239,68,68,0.4)] bg-[rgba(239,68,68,0.08)] px-3 py-2.5 text-center text-[#ef4444] transition-all duration-150 hover:border-[#ef4444] hover:bg-[rgba(239,68,68,0.16)] hover:text-[#f87171]"
                      style={choiceTextStyle}
                    >
                      {copy.cancelTurn}
                    </button>
                  </div>
                )}
                {!canApprovePlan && hasReplyOptions && (
                  <div className="mt-3 flex flex-col gap-3">
                    {hasRealChoiceOptions && (
                      tabGroups ? (
                        <div className="space-y-3">
                          {/* Category Tab Bar */}
                          <div className="flex gap-1.5 border-b border-[rgba(255,255,255,0.06)] pb-2 overflow-x-auto select-none pointer-events-auto">
                            {tabGroups.map((group, idx) => (
                              <button
                                key={group.cleanCategory}
                                type="button"
                                onClick={() => setActiveTabIdx(idx)}
                                className={`px-3 py-1 text-[11px] font-semibold rounded-lg border transition-colors whitespace-nowrap ${
                                  activeTabIdx === idx
                                    ? "border-[var(--accent)] bg-[var(--accent-subtle)] text-[var(--accent-light)]"
                                    : "border-[#27272a] bg-[#09090b] text-[#a1a1aa] hover:bg-[#18181b] hover:text-[#f5f5f5]"
                                }`}
                              >
                                {group.cleanCategory}
                                {(tabSelections[group.cleanCategory]?.length > 0 || tabWriteIns[group.cleanCategory]?.trim()) && (
                                  <span className="ml-1 text-[9px] bg-[var(--accent)] text-[var(--accent-contrast)] px-1 rounded-full">✓</span>
                                )}
                              </button>
                            ))}
                          </div>

                          {/* Selected Category Content */}
                          {tabGroups[activeTabIdx] && (() => {
                            const activeGroup = tabGroups[activeTabIdx];
                            return (
                              <div className="mt-3 space-y-2 pointer-events-auto">
                                <div className="space-y-2">
                                  {activeGroup.options.map((option, optionIdx) => {
                                    const isSelected = (tabSelections[activeGroup.cleanCategory] || []).includes(option.value);
                                    return (
                                      <button
                                        key={`${option.value}-${optionIdx}`}
                                        type="button"
                                        onClick={() => {
                                          setTabSelections(prev => {
                                            const current = prev[activeGroup.cleanCategory] || [];
                                            let next: string[];
                                            if (activeGroup.isMulti) {
                                              next = current.includes(option.value)
                                                ? current.filter(v => v !== option.value)
                                                : [...current, option.value];
                                            } else {
                                              next = [option.value];
                                            }
                                            return { ...prev, [activeGroup.cleanCategory]: next };
                                          });
                                        }}
                                        className={`w-full text-left rounded-xl border px-3.5 py-3 flex items-center gap-3 transition-all duration-150 ${
                                          isSelected
                                            ? "border-[var(--accent)] bg-[var(--accent-subtle)] shadow-[0_2px_8px_rgba(var(--accent-rgb),0.1)]"
                                            : "border-[#202026] bg-[#09090b] text-[#c4c4cc] hover:border-[#2d2d35] hover:bg-[#131316]"
                                        }`}
                                      >
                                        <span
                                          className={`h-4.5 w-4.5 shrink-0 border flex items-center justify-center transition-colors ${
                                            activeGroup.isMulti ? "rounded" : "rounded-full"
                                          } ${
                                            isSelected
                                              ? "border-[var(--accent)] bg-[var(--accent)] text-[var(--accent-contrast)]"
                                              : "border-[#3f3f46] bg-transparent text-transparent"
                                          }`}
                                        >
                                          {isSelected && (
                                            <svg className="h-3 w-3" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                              <path d="M2.5 6L5 8.5L9.5 3.5" />
                                            </svg>
                                          )}
                                        </span>
                                        <span className="text-[12px] font-medium leading-relaxed select-none">
                                          {renderFormattedLabel(option.label)}
                                        </span>
                                      </button>
                                    );
                                  })}
                                </div>

                                {/* Custom Text Write-in per tab */}
                                <div className="flex items-center gap-2 mt-2 pt-2 border-t border-[rgba(255,255,255,0.04)]">
                                  <span className="text-[11px] font-medium text-[#71717a] shrink-0 w-10 text-right select-none">Other:</span>
                                  <input
                                    type="text"
                                    value={tabWriteIns[activeGroup.cleanCategory] || ""}
                                    onChange={(e) => {
                                      const val = e.target.value;
                                      setTabWriteIns(prev => ({ ...prev, [activeGroup.cleanCategory]: val }));
                                    }}
                                    placeholder={copy.customChoicePlaceholder}
                                    className="min-w-0 flex-1 rounded-xl border border-[#202026] bg-[#09090b] px-3 py-2 text-[12px] text-[#f5f5f5] placeholder-[#71717a] outline-none transition-all focus:border-[var(--accent)]"
                                  />
                                </div>

                                {/* Composite Submission buttons at bottom */}
                                <div className="mt-4 pt-3 border-t border-[rgba(255,255,255,0.06)] flex items-center justify-between gap-3">
                                  <button
                                    onClick={onCancelTurn}
                                    type="button"
                                    title={copy.cancelTurnInfo}
                                    className="px-4 py-2 rounded-xl border border-[rgba(239,68,68,0.4)] bg-[rgba(239,68,68,0.08)] text-[#ef4444] transition-all duration-150 hover:border-[#ef4444] hover:bg-[rgba(239,68,68,0.16)] hover:text-[#f87171] text-[12px] font-semibold"
                                  >
                                    {copy.cancelTurn}
                                  </button>
                                  <button
                                    onClick={handleTabbedSubmit}
                                    type="button"
                                    className="theme-plan-primary px-5 py-2 rounded-xl text-[12px] font-semibold flex items-center gap-1.5"
                                  >
                                    <span>{language === "zh" ? "提交选择" : "Submit Answers"}</span>
                                  </button>
                                </div>
                              </div>
                            );
                          })()}
                        </div>
                      ) : (
                        <div>
                          {!hasOperationProposalApproval && (
                            <div className={`font-medium uppercase tracking-[0.14em] ${secondaryText}`} style={choiceSectionStyle}>
                              {copy.choicesSectionTitle}
                            </div>
                          )}
                          <div className={`${hasOperationProposalApproval ? "" : "mt-2"} space-y-2`}>
                            {realChoiceOptions.map((option, index) => (
                              <div
                                key={`${option.value}-${index}`}
                                className="group flex min-w-0 items-center gap-2"
                              >
                                <span data-testid={`execution-capsule-reply-option-badge-${index}`} className={choiceNumberClass} style={choiceTextStyle}>{index + 1}.</span>
                                <button
                                  data-testid={`execution-capsule-reply-option-${index}`}
                                  onClick={() => onSelectReplyOption?.(option)}
                                  className={choiceOptionButtonClass}
                                  style={choiceTextStyle}
                                  title={option.action === "approve_operation_once" ? copy.approveOperationInfo : copy.replyOptionInfo}
                                >
                                  <div className="flex items-center justify-between gap-2">
                                    <span className="min-w-0 break-words">{renderFormattedLabel(getDisplayReplyOptionLabel(option, language))}</span>
                                    {option.action === "approve_operation_once" && (
                                      <IconInfo className="h-4 w-4 shrink-0 opacity-75" />
                                    )}
                                  </div>
                                </button>
                              </div>
                            ))}
                          </div>
                        </div>
                      )
                    )}

                    {hasApprovalActionOptions && (
                      <div data-testid="execution-capsule-approval-actions" className={`rounded-xl border p-3 ${surface}`}>
                        <div className={`font-medium uppercase tracking-[0.14em] ${secondaryText}`} style={choiceSectionStyle}>
                          {copy.approvalActionsTitle}
                        </div>
                        <div className={`mt-1 ${secondaryText}`} style={choiceSectionStyle}>{copy.approvalActionsHint}</div>
                        <div className="mt-2 space-y-2">
                          {approvalActionOptions.map((option, index) => (
                            <button
                              key={`${option.value}-${index}`}
                              data-testid={`execution-capsule-approval-option-${index}`}
                              onClick={() => onSelectReplyOption?.(option)}
                              className={approvalOptionButtonClass}
                              style={choiceTextStyle}
                              title={option.action === "allow_readonly_session" ? copy.readonlySessionInfo : copy.readonlyOnceInfo}
                            >
                              <span className="inline-flex min-w-0 items-center gap-2">
                                <span className="min-w-0 break-words">{renderFormattedLabel(getDisplayReplyOptionLabel(option, language))}</span>
                                <IconInfo className="h-4 w-4 opacity-75" />
                              </span>
                            </button>
                          ))}
                        </div>
                      </div>
                    )}

                    {!tabGroups && allowCustomReply && (
                      <form onSubmit={submitCustomReply} data-testid="execution-capsule-custom-reply-row" className="group flex min-w-0 items-center gap-2">
                        <span data-testid="execution-capsule-custom-reply-badge" className={choiceNumberClass} style={choiceTextStyle}>{customChoiceNumber}.</span>
                        <div className="min-w-0 flex-1">
                          <div className="flex min-w-0 items-center gap-2">
                            <input
                              data-testid="execution-capsule-custom-reply-input"
                              value={customReplyText}
                              onChange={(event) => setCustomReplyText(event.target.value)}
                              placeholder={copy.customChoicePlaceholder}
                              className="execution-capsule-choice-input min-w-0 flex-1 rounded-xl border px-3 py-2.5 outline-none transition-all"
                              style={choiceTextStyle}
                            />
                            <button
                              type="submit"
                              data-testid="execution-capsule-custom-reply-submit"
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
                    )}
                    {!tabGroups && (
                      <button
                        onClick={onCancelTurn}
                        title={copy.cancelTurnInfo}
                        className="w-full px-3 py-2.5 text-center rounded-xl border border-[rgba(239,68,68,0.4)] bg-[rgba(239,68,68,0.08)] text-[#ef4444] transition-all duration-150 hover:border-[#ef4444] hover:bg-[rgba(239,68,68,0.16)] hover:text-[#f87171]"
                        style={choiceTextStyle}
                      >
                        {copy.cancelTurn}
                      </button>
                    )}
                  </div>
                )}
              </div>
            )}

            {activeReviewTask && (
              <div className="mt-3 grid gap-3">
                {activeReviewTask && (
                  <div data-testid="execution-capsule-tool-review" className={`rounded-2xl border p-3 ${surface}`}>
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
                        onClick={() => permissionIdentity && onRejectDiff?.(permissionIdentity)}
                        className="rounded-lg border border-[#3f3f46] bg-[#09090b] px-4 py-2 text-[12px] font-medium text-[#a1a1aa] transition-colors hover:bg-[#18181b] hover:text-[#f5f5f5]"
                      >
                        {copy.reject}
                      </button>
                      <button
                        data-testid="execution-capsule-tool-approve-session"
                        onClick={() => permissionIdentity && onApproveDiffSession?.(permissionIdentity)}
                        className={`rounded-lg border px-4 py-2 text-[12px] font-medium transition-colors ${
                          autoApproveTools
                            ? "theme-plan-button"
                            : "border-[#3f3f46] bg-[#09090b] text-[#a1a1aa] hover:bg-[#18181b] hover:text-[#f5f5f5]"
                        }`}
                        title={copy.autoReviewInfo}
                      >
                        <span className="inline-flex items-center gap-1.5">
                          {copy.approveDiffSession}
                          <IconInfo className="h-3.5 w-3.5 opacity-75" />
                        </span>
                      </button>
                      <button
                        data-testid="execution-capsule-tool-approve-once"
                        onClick={() => permissionIdentity && onApproveDiffOnce?.(permissionIdentity)}
                        className="theme-plan-primary rounded-lg px-4 py-2 text-[12px] font-semibold"
                        title={copy.executeOnceInfo}
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

              </div>
            )}
        </div>
      )}
    </div>
  );
});

export default ExecutionCapsule;
