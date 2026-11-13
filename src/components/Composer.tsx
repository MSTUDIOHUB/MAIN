// @ts-nocheck
import { isQueuedWorkspaceGuidanceEligible } from "../store/workspaceGuidance";
import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { IconAt, IconFile, IconClose, IconArrowUp, IconPlus, IconCode, IconChevronUp as IconChevronUpIcon, IconImageIcon, IconRefresh, IconSearch, IconSettings, IconStop, IconZap, IconGlobe, IconShield, IconSubagent } from "./Icons";
import MainOnboardingPanel from "./MainOnboardingPanel";
import ProjectInitReviewModal from "./ProjectInitReviewModal";
import KnowledgePicker from "./KnowledgePicker";
import { getKnowledgePickerSession, applyKnowledgePickerSelection } from "../lib/knowledgePicker";
import { knowledgeReferenceIdentity, type KnowledgeReference } from "../lib/knowledgeReferences";
import { resolveSessionWorkspaceKey } from "../lib/sessionTypes";
import ToggleSwitch from "./ToggleSwitch";
import type { ProjectInitReviewPhase } from "./ProjectInitReviewModal";
import { getAllWorkspaceFiles, fuzzyFilterFiles } from "../utils/fsUtils";
import { compressImage, getImageFilesFromClipboard, processImageFile } from "../utils/imageUtils";
import { estimateTokens } from "../lib/contextTrim";
import { ingestAttachmentBytes } from "../lib/ipc";
import { useAppStore } from "../store/useAppStore";
import type { AgentMessage, ContentPart } from "../lib/agentMessages";
import { createWorkspaceFileIndexController } from "../lib/workspaceFileIndex";
import { getIntentPolicy, getMainIntentShortcuts, getRunIntentCategoryLabel, getRunIntentLabel, parseMainDebugShortcut, parseMainIntentShortcutForMode, resolveComposerIntentSuggestion } from "../lib/runIntent";
import { isPlanTaskTrustedComplete } from "../lib/workflowModels";
import {
  classifyAttachment,
  createAttachedFileDescriptor,
  attachmentIdentity,
  getNativeFilePath,
  mergeAttachedFiles,
  normalizeAttachedFile,
} from "../lib/attachments";
import { safeConfirmAsync } from "../lib/safeConfirm";
import type { CanonicalRunIdentity } from "../lib/turnRuntimeContract";
import type { TurnIngressMode } from "../lib/turnIngress";
import {
  commitProjectInitPreview,
  parseProjectInitCommand,
  buildProjectRulesPreview,
  updateProjectRulesPreview,
} from "../lib/projectInit";
import type { ProjectInitPreview } from "../lib/projectInit";
import { projectInitIpcIo } from "../lib/projectInitIpc";
import {
  applySkillPickerSelection,
  filterSkillPickerCandidates,
  getSkillPickerSession,
  loadSkillPickerCandidates,
  type SkillPickerCandidate,
} from "../lib/skillPicker";

// ── ContextRing SVG Component ──────────────────────────────────────────

function ContextRing({ percentage, themeMode }: { percentage: number; themeMode: "light" | "dark" | "black" }) {
  const r = 6;
  const circumference = 2 * Math.PI * r;
  const offset = circumference * (1 - Math.min(percentage, 100) / 100);
  const isLightTheme = themeMode === "light";
  const isBlackTheme = themeMode === "black";
  const track = isLightTheme ? "#d4d4d8" : isBlackTheme ? "#202026" : "#27272a";

  let stroke = isLightTheme ? "#2563eb" : isBlackTheme ? "#c4c4cc" : "#a1a1aa";
  if (percentage > 90) stroke = isLightTheme ? "#dc2626" : "#ef4444";
  else if (percentage >= 75) stroke = isLightTheme ? "#b45309" : "#eab308";

  return (
    <svg viewBox="0 0 16 16" className="w-3.5 h-3.5">
      <circle cx="8" cy="8" r={r} stroke={track} strokeWidth="2" fill="none" />
      <circle
        cx="8" cy="8" r={r}
        stroke={stroke}
        strokeWidth="2"
        fill="none"
        strokeDasharray={circumference}
        strokeDashoffset={offset}
        strokeLinecap="round"
        transform="rotate(-90 8 8)"
        className="transition-all duration-300"
      />
    </svg>
  );
}

// ── Token Estimation Helpers ────────────────────────────────────────────

function estimateAgentMessagesTokens(messages: AgentMessage[]): number {
  let total = 0;
  const len = messages.length;
  for (let i = 0; i < len; i++) {
    const msg = messages[i];
    const isRecent = i >= len - 4; // Keep recent 4 messages verbatim
    if (typeof msg.content === "string") {
      // Tool outputs and long messages in older transcript are micro-compacted by context management
      if (!isRecent && (msg.role === "tool" || msg.content.includes("FILE_UNCHANGED_STUB") || msg.content.length > 2000)) {
        total += Math.min(estimateTokens(msg.content), 200);
      } else {
        total += estimateTokens(msg.content);
      }
    } else if (Array.isArray(msg.content)) {
      for (const part of msg.content as ContentPart[]) {
        if (part.type === "text") {
          if (!isRecent && part.text.length > 2000) {
            total += Math.min(estimateTokens(part.text), 200);
          } else {
            total += estimateTokens(part.text);
          }
        } else if (part.type === "image_url") {
          total += 1000;
        }
      }
    }
    if (msg.tool_calls) total += estimateTokens(JSON.stringify(msg.tool_calls));
    total += 10; // role + formatting overhead
  }
  return total;
}

function getSlashSession(value: string, cursorPos: number): { anchor: number; query: string } | null {
  const beforeCursor = value.slice(0, cursorPos);
  const slashIndex = beforeCursor.lastIndexOf("/");
  if (slashIndex < 0) return null;

  const charBefore = slashIndex > 0 ? beforeCursor[slashIndex - 1] : " ";
  if (!/[\s\n]/.test(charBefore)) return null;

  const query = beforeCursor.slice(slashIndex + 1);
  if (/[\s\n]/.test(query)) return null;
  return { anchor: slashIndex, query };
}

function removeSlashSessionToken(value: string, anchor: number): string {
  if (anchor < 0 || anchor >= value.length || value[anchor] !== "/") return value;
  const afterSlash = value.slice(anchor + 1);
  const whitespaceIndex = afterSlash.search(/\s/);
  const tokenEnd = whitespaceIndex < 0 ? value.length : anchor + 1 + whitespaceIndex;
  const trailingWhitespaceLength = value.slice(tokenEnd).match(/^\s*/)?.[0]?.length ?? 0;
  return value.slice(0, anchor) + value.slice(tokenEnd + trailingWhitespaceLength);
}

const workspaceFileIndexController = createWorkspaceFileIndexController(
  (workspacePath: string) => getAllWorkspaceFiles(workspacePath),
  { maxEntries: 8 },
);

function ExecutionProgressCard({
  tasks,
  stage,
}: {
  tasks: Array<{ id: string; text: string; status: "pending" | "in_progress" | "completed" }>;
  stage: "ready" | "executing" | "completed";
}) {
  const completedCount = tasks.filter(isPlanTaskTrustedComplete).length;

  return (
    <div className="mb-3 overflow-hidden rounded-[28px] border border-[#3a3a3d] bg-[#262625] shadow-[0_14px_40px_rgba(0,0,0,0.28)]">
      <div className="flex items-center justify-between border-b border-[#3a3a3d] px-5 py-4">
        <div className="text-[16px] font-semibold text-[#f4f4f5]">
          共 {tasks.length} 个任务，已经完成 {completedCount} 个
        </div>
        <div className="text-[11px] text-[#a1a1aa]">
          {stage === "completed" ? "已完成" : stage === "ready" ? "待执行" : "执行中"}
        </div>
      </div>

      <div className="px-5 py-4">
        <div className="space-y-3">
          {tasks.map((task, index) => {
            const tone =
              isPlanTaskTrustedComplete(task)
                ? "text-[#f5f5f5]"
                : task.status === "in_progress"
                ? "text-[#facc15]"
                : "text-[#e4e4e7]";

            const marker =
              isPlanTaskTrustedComplete(task)
                ? "◉"
                : task.status === "in_progress"
                ? "◎"
                : "○";

            return (
              <div key={task.id} className="flex items-start gap-3">
                <div className={`mt-[2px] text-[18px] leading-none ${tone}`}>{marker}</div>
                <div className={`min-w-0 text-[16px] leading-relaxed ${tone}`}>
                  {index + 1}. {task.text}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export default function Composer({
  contextMentions,
  setContextMentions,
  attachedFiles,
  setAttachedFiles,
  onAttachFile,
  currentWorkspace,
  t,
  activeDiffTask,
  handleAcceptInline,
  handleRejectInline,
  setShowDiff,
  onSendMessage,
  isStreaming = false,
  isRunActive,
  turnIngressMode,
  guidanceTarget,
  runtimeV2Guidance = false,
  guidancePending = false,
  restoreDraftRef,
  onStopGeneration,
  autoApproveTools,
  onToggleAutoApprove,
  preferSubagents,
  onTogglePreferSubagents,
  onHeightChange,
  activeSessionKey,
  chatFontSize,
}) {
  // ── Mention (file search) state ──
  const [showMentionMenu, setShowMentionMenu] = useState(false);
  const [mentionQuery, setMentionQuery] = useState("");
  const [mentionResults, setMentionResults] = useState<string[]>([]);
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const [showSlashMenu, setShowSlashMenu] = useState(false);
  const [slashQuery, setSlashQuery] = useState("");
  const [highlightedSlashIndex, setHighlightedSlashIndex] = useState(0);
  const [showSkillMenu, setShowSkillMenu] = useState(false);
  const [knowledgeSession, setKnowledgeSession] = useState(null);
  const [knowledgeReferences, setKnowledgeReferences] = useState<readonly KnowledgeReference[]>([]);
  const knowledgePickerRef = useRef(null);
  const knowledgeSessionEpoch = useAppStore(state => state.sessionsByWorkspace[resolveSessionWorkspaceKey(currentWorkspace)]
    ?.find(session => session.id === state.currentSessionId)?.planLifecycleEpoch ||
    (state.planLifecycle?.sessionKey === activeSessionKey ? state.planLifecycle.sessionEpoch : "draft"));
  const knowledgeOwnerKey = `${currentWorkspace || "global"}:${activeSessionKey || "draft"}:${knowledgeSessionEpoch}`;
  const knowledgeOwnerRef = useRef(knowledgeOwnerKey);
  knowledgeOwnerRef.current = knowledgeOwnerKey;
  useEffect(() => {
    setKnowledgeSession(null); setKnowledgeReferences([]);
    projectInitRequestIdRef.current++;
    setProjectInitReview(null);
  }, [knowledgeOwnerKey]);
  const [skillSession, setSkillSession] = useState<{ anchor: number; query: string } | null>(null);
  const [skillCandidates, setSkillCandidates] = useState<SkillPickerCandidate[]>([]);
  const [highlightedSkillIndex, setHighlightedSkillIndex] = useState(0);
  const [isSkillsLoading, setIsSkillsLoading] = useState(false);
  const [skillPickerError, setSkillPickerError] = useState(false);
  const [showMainOnboarding, setShowMainOnboarding] = useState(false);
  const [projectInitReview, setProjectInitReview] = useState<{
    phase: ProjectInitReviewPhase;
    preview: ProjectInitPreview | null;
    errorMessage: string | null;
    commandText: string;
    workspace: string;
    documentRef?: import("../lib/planDocuments").PlanDocumentRef;
  } | null>(null);
  const [showWebSearchPanel, setShowWebSearchPanel] = useState(false);
  const [allFiles, setAllFiles] = useState<string[]>([]);
  const [isFilesLoading, setIsFilesLoading] = useState(false);
  const [isSubmitPending, setIsSubmitPending] = useState(false);
  const [dismissedSuggestedIntentKey, setDismissedSuggestedIntentKey] = useState<string | null>(null);

  // Tracks the position of the @ that triggered the current mention session
  const mentionAnchorRef = useRef(-1);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const mentionDropRef = useRef<HTMLDivElement>(null);
  const slashMenuRef = useRef<HTMLDivElement>(null);
  const skillMenuRef = useRef<HTMLDivElement>(null);
  const skillMenuOpenRef = useRef(false);
  const skillLoadRequestIdRef = useRef(0);
  const skillLoadOwnerRef = useRef(null);
  const webSearchPanelRef = useRef<HTMLDivElement>(null);
  const composerShellRef = useRef<HTMLDivElement>(null);
  const helpButtonRef = useRef<HTMLButtonElement>(null);
  const slashAnchorRef = useRef(-1);
  const submitPendingRef = useRef(false);
  const isComposingRef = useRef(false);
  const compositionEndedAtRef = useRef(0);
  const mentionLoadRequestIdRef = useRef(0);
  const projectInitRequestIdRef = useRef(0);
  const projectInitCommitPendingRef = useRef(false);

  // ── Image paste/drop state (local to avoid large base64 in global store) ──
  const [pendingImages, setPendingImages] = useState<string[]>([]);
  const [isDragOver, setIsDragOver] = useState(false);
  const [attachmentNotice, setAttachmentNotice] = useState<string | null>(null);

  // ── Context usage estimation ──
  const agentMessages = useAppStore((s) => s.agentMessages);
  const activeProfile = useAppStore((s) => s.config.activeProfile);
  const themeMode = useAppStore((s) => s.config.themeMode);
  const contextLimit = useAppStore((s) => s.config.local.contextLimit);
  const language = useAppStore((s) => s.config.language);
  const storeInput = useAppStore((s) => s.input);
  const setStoreInput = useAppStore((s) => s.setInput);
  const workspaceContentVersion = useAppStore((s) => s.workspaceContentVersion);
  const bumpWorkspaceContentVersion = useAppStore((s) => s.bumpWorkspaceContentVersion);
  const refreshInstructionAndHookState = useAppStore((s) => s.refreshInstructionAndHookState);
  const skills = useAppStore((s) => s.skills);
  const externalSkillSelections = useAppStore((s) => s.externalSkillSelections);
  const externalSkillSources = useAppStore((s) => s.externalSkillSources);
  const isPlanApproved = useAppStore((s) => s.isPlanApproved);
  const planTasks = useAppStore((s) => s.planTasks);
  const planStage = useAppStore((s) => s.planStage);
  const queuedUserMessage = useAppStore((s) => s.queuedUserMessage);
  const activeGuidance = useAppStore((s) => s.activeGuidance);
  const rulesDraftReview = useAppStore((s) => s.rulesDraftReview);
  const workspaceTurnQueue = useAppStore((s) => s.workspaceTurnQueue);
  const clearActiveGuidance = useAppStore((s) => s.clearActiveGuidance);
  const lockedComposerIntent = useAppStore((s) => s.lockedComposerIntent);
  const setLockedComposerIntent = useAppStore((s) => s.setLockedComposerIntent);
  const webSearchEnabled = useAppStore((s) => s.webSearchEnabled);
  const webSearchProvider = useAppStore((s) => s.webSearchProvider);
  const setWebSearchEnabled = useAppStore((s) => s.setWebSearchEnabled);
  const setWebSearchProvider = useAppStore((s) => s.setWebSearchProvider);
  const [draftInput, setDraftInput] = useState(storeInput);
  const [debouncedInput, setDebouncedInput] = useState(storeInput);
  const mainIntentShortcuts = useMemo(
    () => getMainIntentShortcuts(language === "en" ? "en" : "zh", { mainModeKey: "main_mode" }),
    [language],
  );
  const isLightTheme = themeMode === "light";
  const composerCanStop = typeof isRunActive === "boolean" ? isRunActive : isStreaming;
  const resolvedTurnIngressMode: TurnIngressMode = turnIngressMode || (
    composerCanStop ? "guidance_or_queue" : "submit"
  );
  // An open owner includes a paused review owner. Only composerCanStop means
  // that a live process can be canceled from this surface.
  const composerRunActive = resolvedTurnIngressMode !== "submit";
  const composerGuidanceAvailable = resolvedTurnIngressMode === "guidance_or_queue" &&
    !!(guidanceTarget as CanonicalRunIdentity | null | undefined);
  const isComposerSubmitting = isSubmitPending;
  const resolvedComposerFontSize = Math.min(20, Math.max(10, Number(chatFontSize ?? useAppStore.getState().config.chatFontSize) || 13));
  const mainIntentSearchLabel = slashQuery
    ? (language === "en" ? `Shortcut: ${slashQuery}` : `快捷入口：${slashQuery}`)
    : (language === "en" ? "Use /plan or /rules; select reference material with #" : "使用 /计划、/规则；输入 # 选择参考资料");
  const mainIntentEmptyLabel = language === "en" ? "No matching commands" : "没有匹配的命令";
  const mainIntentHint = language === "en"
    ? "Use natural language for direct execution; shortcuts are optional."
    : "直接用自然语言下达执行任务；快捷入口是可选的。";
  const mentionSearchLabel = mentionQuery
    ? (language === "en" ? `Search: ${mentionQuery}` : `搜索：${mentionQuery}`)
    : (language === "en" ? "Type to search files..." : "输入关键词搜索文件...");
  const filesLoadingLabel = language === "en" ? "Loading..." : "加载中...";
  const fileCountLabel = language === "en" ? `${allFiles.length} files` : `${allFiles.length} 文件`;
  const noWorkspaceLabel = language === "en" ? "Select a workspace first" : "请先选择工作区";
  const noMatchLabel = mentionQuery
    ? (language === "en" ? "No matching files" : "无匹配文件")
    : (language === "en" ? "Start typing to search..." : "开始输入以搜索...");
  const mentionHintUpDown = language === "en" ? "↑↓ Navigate" : "↑↓ 导航";
  const mentionHintEnter = language === "en" ? "↵ Select" : "↵ 选择";
  const mentionHintEsc = language === "en" ? "Esc Close" : "Esc 关闭";
  const concurrentSubmitButtonTitle = language === "en"
    ? "Queue as a durable next turn. It will start in FIFO order after the current run. Enter queues by default."
    : "排队为持久化的新回合；当前执行结束后按 FIFO 顺序开始。回车默认排队。";
  const autoReviewTitle = language === "en"
    ? "Auto Review: approve non-destructive tool requests in this session, including file changes, commands, local file reads, MCP actions, and browser validation."
    : "自动审查：本会话内自动批准非破坏性工具请求，包括文件修改、终端命令、本地文件读取、MCP 动作和浏览器验证。";
  const autoReviewLockedTitle = language === "en"
    ? "Auto Review is active for this run and can be changed after the run stops."
    : "自动审查已在本轮执行中启用，执行停止后才能关闭。";
  const subagentPreferenceTitle = language === "en"
    ? preferSubagents
      ? "Proactive collaboration is on. MAIN launches subagents for independent work when the model lane allows it. The parent keeps progressing, and simple or linear work stays direct."
      : "Allow adaptive collaboration for the next turn, including scoped investigation and planned non-overlapping implementation when useful."
    : preferSubagents
      ? "已开启主动协作：有独立工作且模型通道允许时，MAIN 会启动子智能体，父线程继续推进。简单或线性任务直接执行。"
      : "允许下一轮自适应协作，包括范围明确的调查及方案明确、互不重叠的实现任务。";
  const subagentPreferenceLockedTitle = language === "en"
    ? "Subagent collaboration is captured for the current run and can be changed after it stops."
    : "本轮已捕获子智能体协作设置，执行停止后才能更改。";
  const hasDraftPayload =
    draftInput.trim().length > 0 ||
    knowledgeReferences.length > 0 ||
    contextMentions.length > 0 ||
    attachedFiles.length > 0 ||
    pendingImages.length > 0;
  const workspaceQueueEntries = workspaceTurnQueue?.sessionKey === activeSessionKey
    ? workspaceTurnQueue?.entries || []
    : [];
  // The idle head passes through durable admission before it starts. Only
  // entries waiting behind another turn belong in the visible queue.
  const queuedWorkspaceEntries = workspaceQueueEntries.filter((entry, index) =>
    (entry.status === "persisting" || entry.status === "queued") &&
    (index > 0 || composerRunActive)
  );
  const workspaceComposer = Boolean(String(currentWorkspace || "").trim());
  const visibleLegacyQueuedMessage = workspaceComposer ? null : queuedUserMessage;
  const queuedTurnCount = queuedWorkspaceEntries.length + (visibleLegacyQueuedMessage ? 1 : 0);
  const queuedGuidanceAvailable = composerGuidanceAvailable && runtimeV2Guidance && !guidancePending && !activeGuidance;
  const queuedRows = queuedWorkspaceEntries.map(entry => ({
    id: entry.receipt.receiptId,
    text: entry.instruction.payload.text,
    guide: isQueuedWorkspaceGuidanceEligible(entry),
  }));
  if (visibleLegacyQueuedMessage) queuedRows.push({ id: visibleLegacyQueuedMessage.id, text: visibleLegacyQueuedMessage.text, guide: false });
  const activeGuidancePreview = String(activeGuidance?.text || "").trim();
  const hasGuidanceUnsupportedPayload =
    contextMentions.length > 0 || attachedFiles.length > 0 || pendingImages.length > 0;
  const draftHasExplicitTurnIntent = Boolean(
    parseProjectInitCommand(draftInput) ||
    lockedComposerIntent ||
    parseMainDebugShortcut(draftInput) ||
    parseMainIntentShortcutForMode(draftInput, "main_mode"),
  );
  const guidanceEligible = Boolean(
    composerGuidanceAvailable &&
    draftInput.trim() &&
    !hasGuidanceUnsupportedPayload &&
    knowledgeReferences.length === 0 &&
    !draftHasExplicitTurnIntent &&
    !activeGuidance &&
    !guidancePending,
  );
  const guidanceButtonTitle = language === "en"
    ? activeGuidance
      ? "Guidance is already waiting for the next model iteration. Undo it or wait until it is consumed."
      : hasGuidanceUnsupportedPayload
        ? "Guidance is text-only. Queue this input to preserve files, attachments, and images."
        : draftHasExplicitTurnIntent
          ? "Plan and other explicit intents must be queued as their own Turn."
          : "Guide the current run at its next model iteration without creating a new Turn."
    : activeGuidance
      ? "已有一条引导等待下一次模型迭代；请先撤销或等待它被消费。"
      : hasGuidanceUnsupportedPayload
        ? "引导仅支持文本；请排队以保留文件、附件和图片。"
        : draftHasExplicitTurnIntent
          ? "计划等显式意图必须排队为独立回合。"
          : "在下一次模型迭代引导当前执行，不创建新回合。";
  const autoReviewToggleDisabled = Boolean(autoApproveTools && composerRunActive);
  const autoReviewButtonTitle = autoReviewToggleDisabled ? autoReviewLockedTitle : autoReviewTitle;
  const subagentPreferenceToggleDisabled = Boolean(composerRunActive);
  const subagentPreferenceButtonTitle = subagentPreferenceToggleDisabled
    ? subagentPreferenceLockedTitle
    : subagentPreferenceTitle;
  const webSearchProviderOptions = useMemo(
    () => [
      {
        id: "yahoo",
        label: "Yahoo",
        detail: language === "en" ? "Free web results" : "免费网页结果",
      },
      {
        id: "quark",
        label: language === "en" ? "Quark" : "夸克",
        detail: language === "en" ? "Free web compatibility source" : "免费网页兼容源",
      },
      {
        id: "duckduckgo",
        label: "DuckDuckGo",
        detail: language === "en" ? "Free web results" : "免费网页结果",
      },
      {
        id: "bing",
        label: "Bing",
        detail: language === "en" ? "Free web compatibility source" : "免费网页兼容源",
      },
      {
        id: "baidu",
        label: "Baidu",
        detail: language === "en" ? "Chinese web compatibility source" : "中文网页兼容源",
      },
    ],
    [language],
  );
  const activeWebSearchProviderLabel =
    webSearchProviderOptions.find((item) => item.id === webSearchProvider)?.label || "Yahoo";
  const webSearchButtonTitle = webSearchEnabled
    ? `${language === "en" ? "Web search enabled" : "网络搜索已开启"}: ${activeWebSearchProviderLabel}`
    : "开启后允许模型在网络上搜索答案";
  const composerIntentSuggestion = useMemo(() => {
    return resolveComposerIntentSuggestion({
      input: draftInput,
      language: language === "en" ? "en" : "zh",
      mainModeKey: "main_mode",
      lockedComposerIntent,
      dismissedSuggestedIntentKey,
      hasPlanArtifacts: planTasks.length > 0 || planStage !== "idle",
      planStage,
      isPlanApproved,
    });
  }, [dismissedSuggestedIntentKey, draftInput, isPlanApproved, language, lockedComposerIntent, planStage, planTasks.length, "main_mode"]);
  const suggestedComposerIntent = composerIntentSuggestion?.intent ?? null;
  const explicitComposerIntent = composerIntentSuggestion?.explicitIntent ?? null;
  const composerIntentSuggestionKind = composerIntentSuggestion?.kind ?? null;
  const suggestedComposerIntentLabel = suggestedComposerIntent
    ? getRunIntentLabel(suggestedComposerIntent, language === "en" ? "en" : "zh")
    : null;
  const explicitComposerIntentLabel = explicitComposerIntent
    ? getRunIntentLabel(explicitComposerIntent, language === "en" ? "en" : "zh")
    : null;
  const suggestedComposerIntentIsOutputStyle = suggestedComposerIntent
    ? getIntentPolicy(suggestedComposerIntent).uiCategory === "output_style"
    : false;
  const lockedComposerIntentLabel = lockedComposerIntent
    ? getRunIntentLabel(lockedComposerIntent, language === "en" ? "en" : "zh")
    : null;
  const lockedComposerIntentCategoryLabel = lockedComposerIntent
    ? getRunIntentCategoryLabel(lockedComposerIntent, language === "en" ? "en" : "zh")
    : null;
  // Debounce input for token estimation (300ms)
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedInput(draftInput), 300);
    return () => clearTimeout(timer);
  }, [draftInput]);

  useEffect(() => {
    if (composerRunActive) return;
    setDraftInput(storeInput || "");
  }, [composerRunActive, storeInput]);

  useEffect(() => {
    if (!restoreDraftRef) return;
    restoreDraftRef.current = (text: string) => {
      if (draftInput !== text && !draftInput.endsWith(`\n\n${text}`)) {
        const next = [draftInput, text].filter(Boolean).join("\n\n");
        setDraftInput(next);
        setStoreInput(next, { preserveLockedComposerIntent: true });
      }
      textareaRef.current?.focus();
    };
    return () => { restoreDraftRef.current = null; };
  }, [draftInput, restoreDraftRef, setStoreInput]);

  useEffect(() => {
    return () => {
      submitPendingRef.current = false;
    };
  }, []);
  useEffect(() => {
  }, [currentWorkspace, lockedComposerIntent, setLockedComposerIntent]);
  useEffect(() => {
    if (!projectInitReview?.workspace) return;
    if (projectInitReview.workspace === currentWorkspace) return;
    projectInitRequestIdRef.current += 1;
    setProjectInitReview(null);
  }, [currentWorkspace, projectInitReview?.workspace]);

  const currentTokens = useMemo(() => {
    const historyTokens = estimateAgentMessagesTokens(agentMessages);
    const inputTokens = estimateTokens(debouncedInput);
    const imageTokens = pendingImages.length * 1000;
    return historyTokens + inputTokens + imageTokens;
  }, [agentMessages, debouncedInput, pendingImages]);

  const rawUsagePercent = contextLimit > 0 ? (currentTokens / contextLimit) * 100 : 0;
  const usagePercent = Math.min(100, Math.round(rawUsagePercent * 10) / 10);
  const cloudTokenLabel = language === "en" ? `~${currentTokens} tok` : `~${currentTokens} tokens`;
  const cloudTokenTitle = language === "en"
    ? "Cloud mode does not use the local context compression limit"
    : "云端模式不使用本地上下文压缩阈值";

  const ensureWorkspaceFilesLoaded = useCallback(async (options?: { forceRefresh?: boolean }) => {
    if (!currentWorkspace) {
      setAllFiles([]);
      setIsFilesLoading(false);
      return [];
    }

    const cached = !options?.forceRefresh
      ? workspaceFileIndexController.getCachedFiles(currentWorkspace, workspaceContentVersion)
      : null;
    if (cached) {
      setAllFiles(cached);
      setIsFilesLoading(false);
      return cached;
    }

    const requestId = mentionLoadRequestIdRef.current + 1;
    mentionLoadRequestIdRef.current = requestId;
    setIsFilesLoading(true);
    const files = await workspaceFileIndexController.ensureLoaded({
      workspacePath: currentWorkspace,
      contentVersion: workspaceContentVersion,
      forceRefresh: options?.forceRefresh === true,
    });
    if (mentionLoadRequestIdRef.current !== requestId) {
      return files;
    }
    setAllFiles(files);
    setIsFilesLoading(false);
    return files;
  }, [currentWorkspace, workspaceContentVersion]);

  useEffect(() => {
    setAllFiles([]);
    setMentionResults([]);
    setHighlightedIndex(0);
    setIsFilesLoading(false);
    mentionLoadRequestIdRef.current += 1;
  }, [currentWorkspace, workspaceContentVersion]);

  useEffect(() => {
    if (!showMentionMenu) return;
    void ensureWorkspaceFilesLoaded();
  }, [ensureWorkspaceFilesLoaded, showMentionMenu]);

  // ── Fuzzy filter whenever query or allFiles change ──
  useEffect(() => {
    if (!showMentionMenu) return;
    const filtered = fuzzyFilterFiles(allFiles, mentionQuery, 20);
    setMentionResults(filtered);
    setHighlightedIndex(0);
  }, [mentionQuery, allFiles, showMentionMenu]);

  const filteredSlashItems = useMemo(() => {
    const normalizedQuery = slashQuery.trim().toLowerCase();

    return mainIntentShortcuts.filter((item) => {
      if (!normalizedQuery) return true;
      const categoryLabel = getRunIntentCategoryLabel(item.intent, language === "en" ? "en" : "zh");
      const haystacks = [item.label, item.command, item.description, categoryLabel, ...(item.aliases || [])]
        .join(" ")
        .toLowerCase();
      return haystacks.includes(normalizedQuery);
    });
  }, [language, mainIntentShortcuts, slashQuery]);

  const projectInitSlashItems = useMemo(() => {

    const item = {
      kind: "workspace_command" as const,
      key: "workspace:rules",
      command: language === "en" ? "/rules" : "/规则",
      label: language === "en" ? "Write project rules" : "编写项目规则",
      description: !currentWorkspace
        ? (language === "en" ? "Open a project to write AGENTS.md rules." : "请先打开项目，再编写 AGENTS.md 规则。")
        : composerRunActive
          ? (language === "en" ? "Available after the current run stops." : "当前执行结束后可用。")
          : (language === "en" ? "Investigate, choose constraints, then review and save AGENTS.md." : "调查项目、确认约束，审阅并保存 AGENTS.md。"),
      aliases: ["rules", "agents", "规则", "约束"],
      disabled: !currentWorkspace || composerRunActive,
    };
    const query = slashQuery.trim().toLowerCase();
    if (!query) return [item];
    const haystack = [item.command, item.label, item.description, ...item.aliases]
      .join(" ")
      .toLowerCase();
    return haystack.includes(query) ? [item] : [];
  }, [composerRunActive, currentWorkspace, language, slashQuery]);

  const mainIntentSlashGroups = useMemo(() => {
    if (filteredSlashItems.length === 0) return [];
    const workflowItems = filteredSlashItems.filter((item) => getIntentPolicy(item.intent).uiCategory === "workflow_mode");
    const outputItems = filteredSlashItems.filter((item) => getIntentPolicy(item.intent).uiCategory === "output_style");
    const otherItems = filteredSlashItems.filter((item) => {
      const category = getIntentPolicy(item.intent).uiCategory;
      return category !== "workflow_mode" && category !== "output_style";
    });
    return [
      workflowItems.length > 0 ? [language === "en" ? "Workflow Modes" : "流程模式", workflowItems] : null,
      outputItems.length > 0 ? [language === "en" ? "Output Styles" : "输出方式", outputItems] : null,
      otherItems.length > 0 ? [language === "en" ? "Other" : "其他", otherItems] : null,
    ].filter(Boolean);
  }, [filteredSlashItems, language]);

  const visibleMainIntentSlashItems = useMemo(() => {

    return mainIntentSlashGroups.flatMap(([, items]) => items.map((item) => ({
      kind: "main_intent" as const,
      key: `intent:${item.intent}`,
      item,
      disabled: false,
    })));
  }, [mainIntentSlashGroups]);

  const visibleSlashItems = useMemo(() => [
    ...visibleMainIntentSlashItems,
    ...projectInitSlashItems.map((item) => ({ ...item })),
  ].filter((item) => !item.disabled), [projectInitSlashItems, visibleMainIntentSlashItems]);

  const groupedSlashItems = useMemo(() => {
    const groups = [];
    if (mainIntentSlashGroups.length > 0) {
      groups.push({
        kind: "main_intent",
        heading: language === "en" ? "MAIN Shortcuts" : "MAIN 快捷入口",
        groups: mainIntentSlashGroups.map(([groupName, items]) => [
          groupName,
          items.map((item) => ({
            kind: "main_intent" as const,
            key: `intent:${item.intent}`,
            item,
            disabled: false,
          })),
        ]),
      });
    }
    if (projectInitSlashItems.length > 0) {
      const commandGroup = [
        language === "en" ? "Workspace Commands" : "工作区命令",
        projectInitSlashItems,
      ];
      if (groups.length > 0) {
        groups[0].groups.push(commandGroup);
      } else {
        groups.push({
          kind: "workspace_command",
          heading: language === "en" ? "Workspace Commands" : "工作区命令",
          groups: [commandGroup],
        });
      }
    }
    return groups;
  }, [language, mainIntentSlashGroups, projectInitSlashItems]);

  const closeMentionMenu = useCallback(() => {
    setShowMentionMenu(false);
    setMentionQuery("");
    mentionAnchorRef.current = -1;
  }, []);

  const closeSlashMenu = useCallback(() => {
    setShowSlashMenu(false);
    setHighlightedSlashIndex(0);
    slashAnchorRef.current = -1;
  }, []);

  const closeSkillMenu = useCallback(() => {
    skillMenuOpenRef.current = false;
    skillLoadRequestIdRef.current += 1;
    skillLoadOwnerRef.current = null;
    setShowSkillMenu(false);
    setSkillSession(null);
    setSkillCandidates([]);
    setIsSkillsLoading(false);
    setSkillPickerError(false);
    setHighlightedSkillIndex(0);
  }, []);

  const isCurrentSkillOwner = useCallback((owner) => {
    const state = useAppStore.getState();
    return owner && String(state.currentWorkspace || "").trim() === owner.workspace &&
      state.currentSessionId === owner.sessionId && state.skills === owner.skills &&
      state.externalSkillSelections === owner.externalSkillSelections && state.externalSkillSources === owner.externalSkillSources;
  }, []);
  useEffect(() => {
    if (!showSkillMenu || !skillMenuOpenRef.current) return;
    const requestId = ++skillLoadRequestIdRef.current;
    const owner = {
      workspace: String(currentWorkspace || "").trim(),
      sessionId: useAppStore.getState().currentSessionId,
      skills, externalSkillSelections, externalSkillSources,
    };
    skillLoadOwnerRef.current = owner;
    setSkillCandidates([]);
    setIsSkillsLoading(true);
    setSkillPickerError(false);
    const current = () => skillMenuOpenRef.current && skillLoadRequestIdRef.current === requestId && isCurrentSkillOwner(owner);
    void loadSkillPickerCandidates(owner).then((candidates) => {
      if (!current()) return;
      setSkillCandidates(candidates);
      setIsSkillsLoading(false);
    }).catch((error) => {
      if (!current()) return;
      console.error("Skill picker catalog could not load:", error);
      setSkillPickerError(true);
      setIsSkillsLoading(false);
    });
    return () => { if (skillLoadRequestIdRef.current === requestId) skillLoadRequestIdRef.current += 1; };
  }, [showSkillMenu, currentWorkspace, skills, externalSkillSelections, externalSkillSources, isCurrentSkillOwner]);

  const visibleSkillItems = useMemo(() => filterSkillPickerCandidates(skillCandidates, skillSession?.query || ""), [skillCandidates, skillSession?.query]);
  useEffect(() => { setHighlightedSkillIndex(0); }, [skillSession?.query, skillCandidates]);
  useEffect(() => {
    if (showSkillMenu) skillMenuRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [showSkillMenu, highlightedSkillIndex]);

  // ── Close mention dropdown / slash menu on outside click ──
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      const target = e.target as Node;
      if (mentionDropRef.current && !mentionDropRef.current.contains(target)) {
        closeMentionMenu();
      }
      const clickedSlashMenu = !!slashMenuRef.current?.contains(target);
      const clickedComposerShell = !!composerShellRef.current?.contains(target);
      if (slashMenuRef.current && !clickedSlashMenu) {
        closeSlashMenu();
        if (clickedComposerShell) {
          slashAnchorRef.current = -1;
        }
      }
      if (skillMenuRef.current && !skillMenuRef.current.contains(target) && target !== textareaRef.current) closeSkillMenu();
      if (showWebSearchPanel && webSearchPanelRef.current && !webSearchPanelRef.current.contains(target)) {
        setShowWebSearchPanel(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [closeMentionMenu, closeSlashMenu, closeSkillMenu, showWebSearchPanel]);

  useEffect(() => {
    setShowMainOnboarding(false);
  }, [activeSessionKey, currentWorkspace]);
  // ── Image paste handler ──
  const handlePaste = useCallback(async (e: React.ClipboardEvent) => {
    const imageFiles = getImageFilesFromClipboard(e.nativeEvent);
    if (imageFiles.length === 0) return;


    // Prevent default paste (image data, not text)
    e.preventDefault();
    for (const file of imageFiles) {
      try {
        const dataUrl = await processImageFile(file);
        setPendingImages(prev => [...prev, dataUrl]);
      } catch (err) {
        console.error("Failed to process pasted image:", err);
      }
    }
  }, [  ]);

  const buildAttachmentNotice = useCallback((skipped: Array<{ name: string; reason: string }> = []) => {
    if (!skipped.length) return null;
    const reasonLabel = (reason: string) => {
      if (language === "en") {
        if (reason === "directory") return "folders are not supported";
        if (reason === "missing_path") return "the app could not read the local path";
        if (reason === "read_error") return "the file could not be read";
        return "unsupported format";
      }
      if (reason === "directory") return "不支持文件夹";
      if (reason === "missing_path") return "无法获取本地路径";
      if (reason === "read_error") return "文件读取失败";
      return "格式不支持";
    };
    const names = skipped.slice(0, 3).map((item) => `${item.name} (${reasonLabel(item.reason)})`).join(", ");
    const suffix = skipped.length > 3
      ? language === "en" ? ` and ${skipped.length - 3} more` : ` 等 ${skipped.length} 个`
      : "";
    return language === "en"
      ? `Skipped ${skipped.length} item${skipped.length === 1 ? "" : "s"}: ${names}${suffix}`
      : `已跳过 ${skipped.length} 个项目：${names}${suffix}`;
  }, [language]);

  const addAttachmentDescriptors = useCallback((files: any[]) => {
    if (!files.length) return;
    setAttachedFiles(mergeAttachedFiles(attachedFiles, files));
  }, [attachedFiles, setAttachedFiles]);

  const handleAttachButtonClick = useCallback(async () => {

    if (!onAttachFile) return;
    const result = await onAttachFile();
    if (!result) return;

    addAttachmentDescriptors(result.attachments || []);
    if (result.imageDataUrls?.length) {
      for (const dataUrl of result.imageDataUrls) {
        try {
          const compressed = await compressImage(dataUrl);
          setPendingImages((prev) => [...prev, compressed]);
        } catch {
          setPendingImages((prev) => [...prev, dataUrl]);
        }
      }
    }

    setAttachmentNotice(buildAttachmentNotice(result.skipped || []));
  }, [
    addAttachmentDescriptors,
    buildAttachmentNotice,


    onAttachFile,

  ]);

  // ── File drag-and-drop handlers ──
  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (e.dataTransfer.types.includes("Files")) {

      e.preventDefault();
      e.stopPropagation();
      setIsDragOver(true);
    }
  }, [ ]);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
  }, []);

  const handleDrop = useCallback(async (e: React.DragEvent) => {

    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);

    const skipped: Array<{ name: string; reason: string }> = [];
    const directoryNames = new Set<string>();
    if (e.dataTransfer.items) {
      for (const item of Array.from(e.dataTransfer.items)) {
        const entry = typeof item.webkitGetAsEntry === "function" ? item.webkitGetAsEntry() : null;
        if (entry?.isDirectory) {
          directoryNames.add(entry.name);
          skipped.push({ name: entry.name || "folder", reason: "directory" });
        }
      }
    }

    const droppedAttachments = [];
    for (const file of Array.from(e.dataTransfer.files || [])) {
      if (directoryNames.has(file.name)) continue;
      const kind = classifyAttachment(file.name);
      if (kind === "unsupported") {
        skipped.push({ name: file.name || "attachment", reason: "unsupported" });
        continue;
      }
      if (kind === "image") {
        try {
          const dataUrl = await processImageFile(file);
          setPendingImages(prev => [...prev, dataUrl]);
        } catch (err) {
          console.error("Failed to process dropped image:", err);
          skipped.push({ name: file.name || "image", reason: "read_error" });
        }
        continue;
      }

      const nativePath = getNativeFilePath(file);
      if (!nativePath) {
        if (!activeSessionKey) {
          skipped.push({ name: file.name || "attachment", reason: "missing_path" });
          continue;
        }
        try {
          const bytes = Array.from(new Uint8Array(await file.arrayBuffer()));
          const ingested = await ingestAttachmentBytes(activeSessionKey, file.name || "attachment", bytes);
          droppedAttachments.push({
            id: `${ingested.workspace}:${ingested.path}`,
            path: ingested.path,
            sourcePath: ingested.originalPath || file.name,
            displayName: ingested.displayName || file.name,
            kind,
            workspace: ingested.workspace,
            readable: true,
          });
        } catch (err) {
          console.error("Failed to ingest dropped attachment:", err);
          skipped.push({ name: file.name || "attachment", reason: "read_error" });
        }
        continue;
      }
      const descriptor = createAttachedFileDescriptor(nativePath);
      if (descriptor) {
        droppedAttachments.push(descriptor);
      } else {
        skipped.push({ name: file.name || "attachment", reason: "unsupported" });
      }
    }

    addAttachmentDescriptors(droppedAttachments);
    setAttachmentNotice(buildAttachmentNotice(skipped));
  }, [
    activeSessionKey,
    addAttachmentDescriptors,
    buildAttachmentNotice,



  ]);

  // ── Insert @ from the @ button click ──
  const handleAtButtonClick = () => {

    closeSkillMenu();
    const ta = textareaRef.current;
    if (!ta) return;
    ta.focus();

    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const before = draftInput.slice(0, start);
    const after = draftInput.slice(end);

    // Only insert @ if preceded by whitespace or at start (avoid email-like)
    const charBefore = start > 0 ? before[start - 1] : " ";
    const needSpace = charBefore !== " " && charBefore !== "\n";

    const insert = needSpace ? " @" : "@";
    const newValue = before + insert + after;
    setDraftInput(newValue);
    setStoreInput(newValue, { preserveLockedComposerIntent: true });

    // Schedule cursor position and trigger mention menu
    const anchorPos = start + insert.length - 1; // position of the @
    mentionAnchorRef.current = anchorPos;
    setMentionQuery("");
    setShowMentionMenu(true);
    void ensureWorkspaceFilesLoaded();

    requestAnimationFrame(() => {
      ta.selectionStart = ta.selectionEnd = anchorPos + 1;
    });
  };

  const handleOpenMainGuideSlashCommands = useCallback(() => {
    setShowMainOnboarding(false);
    closeMentionMenu();
    closeSkillMenu();
    setShowSlashMenu(true);
    setSlashQuery("");
    setHighlightedSlashIndex(0);
    setShowWebSearchPanel(false);
    slashAnchorRef.current = -1;
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, [closeMentionMenu, closeSkillMenu, ]);

  const dismissMainOnboarding = useCallback(() => {
    setShowMainOnboarding(false);
    requestAnimationFrame(() => helpButtonRef.current?.focus());
  }, []);

  const toggleMainOnboarding = useCallback(() => {
    if (showMainOnboarding) {
      dismissMainOnboarding();
      return;
    }
    closeMentionMenu();
    closeSlashMenu();
    setShowWebSearchPanel(false);
    setShowMainOnboarding(true);
  }, [closeMentionMenu, closeSlashMenu, dismissMainOnboarding,  showMainOnboarding]);

  const closeProjectInitReview = useCallback(() => {
    projectInitRequestIdRef.current += 1;
    setProjectInitReview(null);
    const draft = useAppStore.getState().rulesDraftReview;
    if (draft?.documentRef.owner.sessionKey === activeSessionKey && draft.documentRef.documentId === projectInitReview?.documentRef?.documentId) {
      useAppStore.setState({ rulesDraftReview: null });
      useAppStore.getState().saveCurrentRuntimeToSession();
    }
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, [activeSessionKey, projectInitReview?.documentRef?.documentId]);

  useEffect(() => {
    if (!rulesDraftReview || composerRunActive || rulesDraftReview.documentRef.owner.sessionKey !== activeSessionKey || rulesDraftReview.documentRef.owner.sessionEpoch !== knowledgeSessionEpoch || !currentWorkspace) return;
    try {
      setProjectInitReview({ phase: "review", preview: buildProjectRulesPreview(rulesDraftReview.inspection, rulesDraftReview.markdown, language === "en" ? "en" : "zh"),
        errorMessage: null, commandText: language === "en" ? "/rules" : "/规则", workspace: currentWorkspace, documentRef: rulesDraftReview.documentRef });
    } catch (error) {
      setProjectInitReview({ phase: "error", preview: null, errorMessage: error instanceof Error ? error.message : String(error), commandText: "/规则", workspace: currentWorkspace });
    }
  }, [rulesDraftReview?.documentRef.documentId, rulesDraftReview?.documentRef.revision, composerRunActive, activeSessionKey, knowledgeSessionEpoch, currentWorkspace, language]);

  const handleRegenerateProjectInit = useCallback(async () => {
    if (composerRunActive || !currentWorkspace) return;
    const accepted = await onSendMessage(language === "en" ? "/rules" : "/规则", undefined, {
      workspaceComposerIntentSnapshot: { mainModeKey: "main_mode", lockedComposerIntent: "plan", subagentPreference: preferSubagents ? "preferred" : "unspecified" },
      workspaceSubmissionPayloadSnapshot: { contextMentions: [], attachedFiles: [], knowledgeReferences: [] },
    });
    if (accepted) closeProjectInitReview();
  }, [composerRunActive, currentWorkspace, onSendMessage, language, preferSubagents, closeProjectInitReview]);

  const handleConfirmProjectInit = useCallback(async () => {
    const review = projectInitReview;
    if (!review?.preview || review.phase !== "review") return;
    if (projectInitCommitPendingRef.current) return;
    if (useAppStore.getState().currentWorkspace !== review.workspace || composerRunActive) {
      setProjectInitReview({
        ...review,
        phase: "error",
        errorMessage: "PROJECT_INIT_WORKSPACE_STALE",
      });
      return;
    }
    projectInitCommitPendingRef.current = true;
    const requestId = projectInitRequestIdRef.current + 1;
    projectInitRequestIdRef.current = requestId;
    setProjectInitReview({ ...review, phase: "committing", errorMessage: null });
    try {
      const result = await commitProjectInitPreview({
        preview: review.preview,
        currentWorkspaceIdentity: review.preview.workspaceIdentity,
        io: projectInitIpcIo,
      });
      if (projectInitRequestIdRef.current !== requestId) return;
      if (result.status === "stale") {
        const code = result.reason === "workspace_identity"
          ? "PROJECT_INIT_WORKSPACE_STALE"
          : result.reason === "target_path"
            ? "PROJECT_INIT_TARGET_STALE"
            : "PROJECT_INIT_CONTENT_STALE";
        setProjectInitReview({ ...review, phase: "error", errorMessage: code });
        return;
      }
      if (result.status === "committed") {
        bumpWorkspaceContentVersion();
      }
      try {
        if (useAppStore.getState().currentWorkspace === review.workspace) {
          await refreshInstructionAndHookState([], {
            workspace: review.workspace,
            projectToUi: true,
          });
        }
      } catch (refreshError) {
        console.error("Project init committed but instruction refresh failed:", refreshError);
        setAttachmentNotice(
          language === "en"
            ? "AGENTS.md was written, but the guide could not refresh. The next turn will reload it."
            : "AGENTS.md 已写入，但界面刷新失败；下一回合会重新加载。",
        );
      }
      if (projectInitRequestIdRef.current !== requestId) return;
      setProjectInitReview({ ...review, phase: "success", errorMessage: null });
      if (useAppStore.getState().rulesDraftReview?.documentRef.documentId === review.documentRef?.documentId) useAppStore.setState({ rulesDraftReview: null });
      useAppStore.getState().saveCurrentRuntimeToSession();
    } catch (error) {
      if (projectInitRequestIdRef.current !== requestId) return;
      setProjectInitReview({
        ...review,
        phase: "error",
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    } finally {
      projectInitCommitPendingRef.current = false;
    }
  }, [bumpWorkspaceContentVersion, composerRunActive, language, projectInitReview, refreshInstructionAndHookState]);

  const handleSelectMainIntentShortcut = (item) => {
    const parsed = parseMainIntentShortcutForMode(draftInput, "main_mode");
    const slashAnchor = slashAnchorRef.current;
    const nextInput = slashAnchor >= 0
      ? removeSlashSessionToken(draftInput, slashAnchor)
      : parsed
      ? parsed.rest.trimStart()
      : draftInput.replace(/^\s*\/[^\s]*\s*/, "");
    closeSlashMenu();
    setLockedComposerIntent(item.intent);
    setDraftInput(nextInput);
    setStoreInput(nextInput, { preserveLockedComposerIntent: true });
    requestAnimationFrame(() => textareaRef.current?.focus());
  };

  const handleSelectSlashItem = (entry) => {
    if (!entry || entry.disabled) return;
    if (entry.kind === "workspace_command") {
      const before = draftInput;
      const slashAnchor = slashAnchorRef.current;
      const after = slashAnchor >= 0
        ? removeSlashSessionToken(before, slashAnchor)
        : parseProjectInitCommand(before)
          ? ""
          : before;
      const next = `${entry.command}${after.trim() ? ` ${after.trim()}` : " "}`;
      setDraftInput(next);
      setStoreInput(next, { preserveLockedComposerIntent: true });
      setLockedComposerIntent(null);
      closeSlashMenu();
      requestAnimationFrame(() => textareaRef.current?.focus());
      return;
    }
    handleSelectMainIntentShortcut(entry.item);
  };

  const handleToggleAutoReview = useCallback(async () => {
    if (!onToggleAutoApprove) return;
    if (autoApproveTools && composerRunActive) return;
    const nextValue = !autoApproveTools;
    if (nextValue) {
      const confirmed = await safeConfirmAsync(
        language === "en"
          ? "Turn on Auto Review for this session? MAIN will automatically approve non-destructive file changes, terminal commands, local file reads, MCP actions, and browser validation while the session is active."
          : "要为本会话开启自动审查吗？开启后 MAIN 会自动批准非破坏性文件修改、终端命令、本地文件读取、MCP 动作和浏览器验证。",
        { source: "Composer", action: "toggle_auto_review" },
      );
      if (!confirmed) return;
    }
    onToggleAutoApprove(nextValue);
  }, [autoApproveTools, composerRunActive, language, onToggleAutoApprove]);

  const handleToggleSubagentPreference = useCallback(() => {
    if (!onTogglePreferSubagents || composerRunActive) return;
    onTogglePreferSubagents(!preferSubagents);
  }, [composerRunActive, onTogglePreferSubagents, preferSubagents]);

  const handleToggleWebSearch = useCallback(() => {
    const nextValue = !webSearchEnabled;
    setWebSearchEnabled(nextValue);
    setShowWebSearchPanel(true);
  }, [setWebSearchEnabled, webSearchEnabled]);

  const handleSelectWebSearchProvider = useCallback((provider) => {
    setWebSearchProvider(provider);
    setWebSearchEnabled(true);
    setShowWebSearchPanel(false);
  }, [setWebSearchEnabled, setWebSearchProvider]);

  const handleSubmitComposerMessage = useCallback(async () => {
    const textToSend = draftInput;
    const imagesToSend = [...pendingImages];
    const contextMentionsToSend = [...contextMentions];
    const attachedFilesToSend = attachedFiles.map((file) => normalizeAttachedFile(file));
    const knowledgeToSend = knowledgeReferences.map(reference => ({ ...reference }));
    const knowledgeOwnerToSend = knowledgeOwnerKey;
    const lockedIntentToConsume = lockedComposerIntent;
    if (parseProjectInitCommand(textToSend) && !currentWorkspace) { setAttachmentNotice(language === "en" ? "Open a project to write AGENTS.md rules." : "请先打开项目，再编写 AGENTS.md 规则。"); return; }
    const hasPayload =
      textToSend.trim().length > 0 ||
      knowledgeToSend.length > 0 ||
      contextMentions.length > 0 ||
      attachedFiles.length > 0 ||
      imagesToSend.length > 0;

    if (!hasPayload || submitPendingRef.current) {
      return;
    }
    submitPendingRef.current = true;
    setIsSubmitPending(true);
    closeSlashMenu();
    closeSkillMenu();
    setKnowledgeSession(null);
    try {
      const accepted = await Promise.resolve(onSendMessage(textToSend, imagesToSend, {
        workspaceComposerIntentSnapshot: {
          mainModeKey: "main_mode",
          lockedComposerIntent: lockedIntentToConsume,
          subagentPreference: preferSubagents ? "preferred" : "unspecified",
        },
        workspaceSubmissionPayloadSnapshot: {
          contextMentions: contextMentionsToSend,
          attachedFiles: attachedFilesToSend,
          knowledgeReferences: knowledgeToSend,
        },
      }));
      if (accepted !== true) {
        return;
      }

      setDraftInput((currentDraft) => currentDraft === textToSend ? "" : currentDraft);
      setKnowledgeReferences(current => knowledgeOwnerRef.current === knowledgeOwnerToSend &&
        JSON.stringify(current) === JSON.stringify(knowledgeToSend) ? [] : current);

      const latestState = useAppStore.getState();
      // A locked intent is a one-shot capability owned by this exact accepted
      // submission. Clear it with a value CAS even if a busy Run kept or
      // changed the Store input while durable admission was pending.
      if (
        lockedIntentToConsume &&
        latestState.lockedComposerIntent === lockedIntentToConsume
      ) {
        setLockedComposerIntent(null);
      }
      setPendingImages((currentImages) => (
        currentImages.length === imagesToSend.length &&
        currentImages.every((image, index) => image === imagesToSend[index])
          ? []
          : currentImages
      ));
      if (
        latestState.contextMentions.length === contextMentionsToSend.length &&
        latestState.contextMentions.every(
          (mention, index) => mention === contextMentionsToSend[index],
        )
      ) {
        setContextMentions([]);
      }
      const latestAttachedFiles = latestState.attachedFiles.map((file) => normalizeAttachedFile(file));
      if (
        latestAttachedFiles.length === attachedFilesToSend.length &&
        latestAttachedFiles.every((file, index) => (
          JSON.stringify(file) === JSON.stringify(attachedFilesToSend[index])
        ))
      ) {
        setAttachedFiles([]);
      }
    } catch (error) {
      console.error("Failed to admit composer submission:", error);
    } finally {
      submitPendingRef.current = false;
      setIsSubmitPending(false);
    }
  }, [attachedFiles, closeSlashMenu, closeSkillMenu, contextMentions, currentWorkspace, draftInput, knowledgeReferences, knowledgeOwnerKey, language, lockedComposerIntent, onSendMessage, pendingImages, preferSubagents, setLockedComposerIntent, setStoreInput]);

  const handleGuideCurrentRun = useCallback(async () => {
    const guidanceText = draftInput.trim();
    if (!guidanceEligible || !guidanceText) return;

    const latest = useAppStore.getState();
    if (!guidanceTarget) return;
    const accepted = runtimeV2Guidance
      ? await latest.guideWorkspaceRun({ text: guidanceText, target: guidanceTarget })
      : latest.setActiveGuidance(guidanceText, guidanceTarget);
    if (!accepted) return;
    closeMentionMenu();
    closeSlashMenu();
    setDraftInput((currentDraft) => currentDraft === draftInput ? "" : currentDraft);
    if (useAppStore.getState().input === draftInput) {
      setStoreInput("", { preserveLockedComposerIntent: true });
    }
  }, [closeMentionMenu, closeSlashMenu, draftInput, guidanceEligible, guidanceTarget, runtimeV2Guidance, setStoreInput]);

  // ── Handle textarea change (detect @ typing) ──
  const resizeTextarea = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const minHeight = textarea.dataset.minComposerHeight
      ? Number(textarea.dataset.minComposerHeight)
      : textarea.getBoundingClientRect().height;
    textarea.style.height = "auto";
    const maxHeight = Math.round(window.innerHeight * 0.36);
    const nextHeight = Math.min(Math.max(textarea.scrollHeight, minHeight), maxHeight);
    textarea.style.height = `${nextHeight}px`;
    textarea.style.overflowY = textarea.scrollHeight > maxHeight ? "auto" : "hidden";
  }, []);

  const handleTextareaRef = useCallback((node: HTMLTextAreaElement | null) => {
    textareaRef.current = node;
    if (!node) return;
    requestAnimationFrame(() => {
      node.dataset.minComposerHeight = String(node.getBoundingClientRect().height);
      resizeTextarea();
    });
  }, [resizeTextarea]);

  useEffect(() => {
    resizeTextarea();
  }, [activeDiffTask, draftInput, resizeTextarea]);

  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    const nativeEvent = e.nativeEvent as InputEvent & { isComposing?: boolean };
    const inputType = typeof nativeEvent.inputType === "string" ? nativeEvent.inputType.toLowerCase() : "";
    const justFinishedComposition = Date.now() - compositionEndedAtRef.current < 140;
    const isImeCompositionInput =
      isComposingRef.current ||
      nativeEvent.isComposing === true ||
      inputType.includes("composition") ||
      justFinishedComposition;
    setDraftInput(value);
    if (lockedComposerIntent && value.trim().length === 0 && !isImeCompositionInput) {
      setLockedComposerIntent(null);
    }

    const cursorPos = e.target.selectionStart ?? value.length;
    const nextKnowledgeSession = getKnowledgePickerSession(value, cursorPos);
    setKnowledgeSession(nextKnowledgeSession);
    if (nextKnowledgeSession) { closeMentionMenu(); closeSlashMenu(); closeSkillMenu(); return; }
    const textBeforeCursor = value.slice(0, cursorPos);
    const nextSkillSession = getSkillPickerSession(value, cursorPos);
    if (nextSkillSession) {
      if (!skillMenuOpenRef.current) {
        setSkillCandidates([]);
        setIsSkillsLoading(true);
        setSkillPickerError(false);
      }
      skillMenuOpenRef.current = true;
      setSkillSession(nextSkillSession);
      setShowSkillMenu(true);
      closeMentionMenu();
      closeSlashMenu();
      return;
    }
    if (showSkillMenu) closeSkillMenu();
    const slashSession = getSlashSession(value, cursorPos);

    if (parseMainDebugShortcut(value)) {
      slashAnchorRef.current = -1;
      closeSlashMenu();
    } else if (slashSession) {
      slashAnchorRef.current = slashSession.anchor;
      setSlashQuery(slashSession.query);
      setShowSlashMenu(true);
    } else if (showSlashMenu) {
      closeSlashMenu();
    }

    // Find the last @ before cursor
    const lastAtIndex = textBeforeCursor.lastIndexOf("@");
    if (lastAtIndex !== -1) {
      const charBefore = lastAtIndex > 0 ? textBeforeCursor[lastAtIndex - 1] : " ";
      const textAfterAt = textBeforeCursor.slice(lastAtIndex + 1);

      // Trigger if @ is at start or preceded by whitespace/newline,
      // and the text after @ contains no spaces (still typing the query)
      if (/[\s\n]/.test(charBefore) && !textAfterAt.includes(" ")) {
        mentionAnchorRef.current = lastAtIndex;
        setMentionQuery(textAfterAt);
        const shouldLoadWorkspaceFiles = !showMentionMenu;
        setShowMentionMenu(true);
        if (shouldLoadWorkspaceFiles) {
          void ensureWorkspaceFilesLoaded();
        }
        if (showSlashMenu) closeSlashMenu();
        return;
      }
    }

    // No active @ mention — close if open
    if (showMentionMenu) closeMentionMenu();
  };

  const handleSelectSkill = (candidate: SkillPickerCandidate) => {
    const textarea = textareaRef.current;
    if (!textarea || false || isComposingRef.current || Date.now() - compositionEndedAtRef.current < 140 ||
      isSkillsLoading || skillPickerError || !skillMenuOpenRef.current ||
      !isCurrentSkillOwner(skillLoadOwnerRef.current) || textarea.selectionStart !== textarea.selectionEnd ||
      !visibleSkillItems.some((item) => item.id === candidate.id && item.insertText === candidate.insertText)) return;
    const cursor = textarea.selectionStart;
    const currentSession = getSkillPickerSession(textarea.value, cursor);
    if (!currentSession || !skillSession || currentSession.anchor !== skillSession.anchor || currentSession.query !== skillSession.query) {
      closeSkillMenu();
      return;
    }
    const selection = applySkillPickerSelection(textarea.value, cursor, currentSession, candidate);
    if (!selection) return;
    setDraftInput(selection.value);
    setStoreInput(selection.value, { preserveLockedComposerIntent: true });
    closeSkillMenu();
    textarea.focus();
    requestAnimationFrame(() => {
      if (textareaRef.current === textarea && textarea.value === selection.value) textarea.selectionStart = textarea.selectionEnd = selection.cursor;
    });
  };

  // ── Select a file from the mention menu ──
  const handleSelectMention = (relPath: string) => {
    const absolutePath = currentWorkspace
      ? `${currentWorkspace}/${relPath}`
      : relPath;

    if (!contextMentions.includes(absolutePath)) {
      setContextMentions([...contextMentions, absolutePath]);
    }

    // Remove the "@query" text from the input
    const anchor = mentionAnchorRef.current;
    if (anchor >= 0) {
      const cursorPos = textareaRef.current?.selectionStart ?? draftInput.length;
      const before = draftInput.slice(0, anchor);
      const after = draftInput.slice(cursorPos);
      const nextValue = before + after;
      setDraftInput(nextValue);
      setStoreInput(nextValue, { preserveLockedComposerIntent: true });

      // Move cursor to end of insertion point
      requestAnimationFrame(() => {
        if (textareaRef.current) {
          const newPos = anchor;
          textareaRef.current.selectionStart = textareaRef.current.selectionEnd = newPos;
        }
      });
    }

    closeMentionMenu();
    textareaRef.current?.focus();
  };

  const handleRemoveMention = (filePath: string) => {
    setContextMentions(contextMentions.filter((f: string) => f !== filePath));
  };

  const handleRemoveAttachedFile = (filePath: any) => {
    const targetKey = attachmentIdentity(filePath);
    setAttachedFiles(attachedFiles.filter((f: any) => attachmentIdentity(f) !== targetKey));
  };

  // ── Keyboard navigation inside textarea + mention menu ──
  const handleKeyDown = (e: React.KeyboardEvent) => {
    const nativeEvent = e.nativeEvent as KeyboardEvent & { isComposing?: boolean };
    const justFinishedComposition = Date.now() - compositionEndedAtRef.current < 140;
    const isImeKeyInput = isComposingRef.current || nativeEvent.isComposing || e.keyCode === 229 || justFinishedComposition;
    if (!isImeKeyInput && knowledgePickerRef.current?.handleKeyDown(e)) return;
    if (
      !activeDiffTask &&
      e.key === "Tab" &&
      e.shiftKey &&
      !e.altKey &&
      !e.ctrlKey &&
      !e.metaKey &&
      !isImeKeyInput
    ) {
      e.preventDefault();
      e.stopPropagation();
      closeMentionMenu();
      closeSlashMenu();
      closeSkillMenu();
      setDismissedSuggestedIntentKey(null);
      setLockedComposerIntent(lockedComposerIntent === "plan" ? null : "plan");
      requestAnimationFrame(() => textareaRef.current?.focus());
      return;
    }
    if (
      e.key === "Enter" &&
      isImeKeyInput
    ) {
      return;
    }

    if (showSkillMenu && !isImeKeyInput) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        setHighlightedSkillIndex((index) => e.key === "ArrowDown"
          ? Math.min(index + 1, Math.max(0, visibleSkillItems.length - 1)) : Math.max(index - 1, 0));
        return;
      }
      if ((e.key === "Enter" && !e.altKey && !e.shiftKey) || (e.key === "Tab" && !e.shiftKey)) {
        e.preventDefault();
        if (!isSkillsLoading && !skillPickerError && visibleSkillItems[highlightedSkillIndex]) handleSelectSkill(visibleSkillItems[highlightedSkillIndex]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        closeSkillMenu();
        return;
      }
    }

    if (showMentionMenu) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setHighlightedIndex(prev => Math.min(prev + 1, mentionResults.length - 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setHighlightedIndex(prev => Math.max(prev - 1, 0));
        return;
      }
      if ((e.key === "Enter" && !e.altKey && !e.shiftKey) || e.key === "Tab") {
        e.preventDefault();
        if (mentionResults.length > 0 && highlightedIndex < mentionResults.length) {
          handleSelectMention(mentionResults[highlightedIndex]);
        }
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        closeMentionMenu();
        return;
      }
    }

    if (showSlashMenu) {
      if (
        e.key === "Enter" &&
        !e.altKey &&
        !e.shiftKey &&
        parseProjectInitCommand(draftInput)
      ) {
        e.preventDefault();
        void handleSubmitComposerMessage();
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setHighlightedSlashIndex((prev) => Math.min(prev + 1, Math.max(0, visibleSlashItems.length - 1)));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setHighlightedSlashIndex((prev) => Math.max(prev - 1, 0));
        return;
      }
      if ((e.key === "Enter" && !e.altKey && !e.shiftKey) || e.key === "Tab") {
        e.preventDefault();
        if (visibleSlashItems.length > 0 && highlightedSlashIndex < visibleSlashItems.length) {
          const slashItem = visibleSlashItems[highlightedSlashIndex];
          handleSelectSlashItem(slashItem);
        } else if (e.key === "Enter" && !e.altKey && draftInput.trim().startsWith("/")) {
          handleSubmitComposerMessage();
        }
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        closeSlashMenu();
        return;
      }
    }

    if (e.key === "Enter" && e.altKey) {
      return;
    }

    // Normal send on Enter (no mention menu open)
    if (e.key === "Enter" && !e.shiftKey && !e.altKey && !showMentionMenu && !showSlashMenu && !showSkillMenu) {
      e.preventDefault();
      handleSubmitComposerMessage();
    }
  };

  // ── Helper: extract display name from path ──
  const displayName = (path: any) => normalizeAttachedFile(path).displayName || String(path).split("/").pop() || String(path);
  const composerPlaceholder = activeDiffTask
    ? "..."
    : language === "en"
          ? "Describe what you need; / for plans or rules, # for references..."
          : "输入需求，/ 选择计划或规则，# 选择资料...";

  // region: Composer 高度同步
  useEffect(() => {
    if (!onHeightChange) return undefined;
    const node = composerShellRef.current;
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
    <>
      {projectInitReview && (
        <ProjectInitReviewModal
          language={language === "en" ? "en" : "zh"}
          themeMode={themeMode}
          phase={projectInitReview.phase}
          preview={projectInitReview.preview}
          errorMessage={projectInitReview.errorMessage}
          onConfirm={handleConfirmProjectInit}
          onCancel={closeProjectInitReview}
          onRegenerate={handleRegenerateProjectInit}
          onEditDraft={content => setProjectInitReview(review => {
            if (!review?.preview || review.phase !== "review") return review;
            try { return { ...review, preview: updateProjectRulesPreview(review.preview, content), errorMessage: null }; }
            catch (error) { return { ...review, errorMessage: error instanceof Error ? error.message : String(error) }; }
          })}
        />
      )}
      <div
        className="absolute left-6 right-6 z-20 pointer-events-none flex justify-center"
        style={{ bottom: "calc(env(safe-area-inset-bottom, 0px) + 1.5rem)" }}
      >
        <div
          ref={composerShellRef}
          className={`w-full max-w-3xl flex flex-col relative pointer-events-auto transition-all ${isDragOver ? 'ring-2 ring-[var(--accent)] ring-offset-2 ring-offset-[#000000]' : ''}`}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >


        {/* Action Diff Card */}


        {showMainOnboarding && (
          <MainOnboardingPanel
            language={language === "en" ? "en" : "zh"}
            themeMode={themeMode}
            onDismiss={dismissMainOnboarding}
            onOpenSlashCommands={handleOpenMainGuideSlashCommands}
          />
        )}

        {suggestedComposerIntent && suggestedComposerIntentLabel && !activeDiffTask && !composerRunActive && (
          <div className="relative z-30 mb-2 flex justify-center px-3">
            <div className="flex max-w-full items-center justify-between gap-3 rounded-full border border-[#27272a] bg-[#050507] px-3 py-2 text-[11px] text-[#d4d4d8]">
              <span className="truncate">
                {composerIntentSuggestionKind === "explicit_conflict" && explicitComposerIntentLabel
                  ? (
                    <>
                      {language === "en" ? "Explicit " : "已选择 "}
                      <span className="font-semibold" style={{ color: "var(--accent-light)" }}>{explicitComposerIntentLabel}</span>
                      {language === "en" ? "; switch to " : "；内容也像 "}
                      <span className="font-semibold" style={{ color: "var(--accent-light)" }}>{suggestedComposerIntentLabel}</span>
                      {language === "en" ? " instead?" : "，要改用它吗？"}
                    </>
                  )
                  : (
                    <>
                      {language === "en" ? "Use" : "使用"} <span className="font-semibold" style={{ color: "var(--accent-light)" }}>{suggestedComposerIntentLabel}</span>
                      {" "}
                      {suggestedComposerIntentIsOutputStyle
                        ? (language === "en" ? "output style for this turn?" : "输出方式处理本轮请求？")
                        : (language === "en" ? "intent for this turn?" : "按这个意图处理本轮请求？")}
                    </>
                  )}
              </span>
              <div className="flex shrink-0 items-center gap-2">
                <button
                  type="button"
                  onClick={() => setLockedComposerIntent(suggestedComposerIntent)}
                  className="rounded-full border px-2.5 py-1 text-[10px] font-semibold transition-colors hover:bg-[#18181b]"
                  style={{ borderColor: "var(--accent-subtle-border)", color: "var(--accent-light)" }}
                >
                  {composerIntentSuggestionKind === "explicit_conflict"
                    ? language === "en" ? "Switch" : "改用"
                    : language === "en" ? "Confirm" : "确认"}
                </button>
                <button
                  type="button"
                  onClick={() => setDismissedSuggestedIntentKey(composerIntentSuggestion?.inputKey || draftInput.trim())}
                  className="rounded-full border border-[#27272a] px-2.5 py-1 text-[10px] text-[#a1a1aa] transition-colors hover:bg-[#18181b]"
                >
                  {language === "en" ? "Ignore" : "忽略"}
                </button>
              </div>
            </div>
          </div>
        )}

        <div className={`bg-[#09090b] border border-[#27272a] transition-all flex flex-col relative z-20 ${activeDiffTask ? 'rounded-b-xl border-t-0' : 'rounded-xl'} ${composerRunActive ? 'border-[#3f3f46]' : 'focus-within:border-[#3f3f46]'}`} style={undefined}>

          {attachmentNotice && (
            <div className="flex items-center justify-between gap-3 px-4 pt-3 text-[11px] text-[#fbbf24]">
              <span className="min-w-0 truncate">{attachmentNotice}</span>
              <button
                type="button"
                onClick={() => setAttachmentNotice(null)}
                className="shrink-0 text-[#a1a1aa] hover:text-white"
                title={language === "en" ? "Dismiss" : "关闭"}
              >
                <IconClose className="w-3 h-3" />
              </button>
            </div>
          )}



          {/* Attached files tags */}
          {attachedFiles.length > 0 && (
            <div className="flex flex-wrap gap-2 px-4 pt-3">
              {attachedFiles.map((filePath: any) => (
                <div key={attachmentIdentity(filePath)} className="flex items-center gap-1.5 bg-[#000000] border border-[var(--accent-subtle-border,#27272a)] text-[var(--accent-light,#a855f7)] text-[11px] font-mono px-2 py-1 rounded-md">
                  <IconFile className="w-3.5 h-3.5" /> {displayName(filePath)}
                  <button onClick={() => handleRemoveAttachedFile(filePath)} className="text-[#a1a1aa] hover:text-white ml-1"><IconClose className="w-3 h-3" /></button>
                </div>
              ))}
            </div>
          )}

          {/* Context mentions (@-mentions) tags */}
          {contextMentions.length > 0 && (
            <div className={`flex flex-wrap gap-2 px-4 ${attachedFiles.length > 0 ? 'pt-2' : 'pt-3'}`}>
              {contextMentions.map((mention: string) => (
                <div key={mention} className="flex items-center gap-1.5 bg-[#000000] border border-[#27272a] text-[#e4e4e7] text-[11px] font-mono px-2 py-1 rounded-md">
                  <IconAt className="w-3.5 h-3.5" style={{ color: 'var(--accent)' }} /> {displayName(mention)}
                  <button onClick={() => handleRemoveMention(mention)} className="text-[#a1a1aa] hover:text-white ml-1"><IconClose className="w-3 h-3" /></button>
                </div>
              ))}
            </div>
          )}

          {/* Pending images preview */}
          {pendingImages.length > 0 && (
            <div className={`flex flex-wrap gap-2 px-4 ${attachedFiles.length > 0 || contextMentions.length > 0 ? 'pt-2' : 'pt-3'}`}>
              {pendingImages.map((dataUrl: string, index: number) => (
                <div key={index} className="relative group">
                  <img
                    src={dataUrl}
                    alt={`pasted-${index}`}
                    className="h-16 w-auto rounded-md border border-[#27272a] object-cover"
                  />
                  <button
                    onClick={() => setPendingImages(prev => prev.filter((_, i) => i !== index))}
                    className="absolute -top-1.5 -right-1.5 w-5 h-5 bg-[#27272a] hover:bg-[#3f3f46] rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                  >
                    <IconClose className="w-3 h-3 text-[#e4e4e7]" />
                  </button>
                </div>
              ))}
            </div>
          )}

          {knowledgeReferences.length > 0 && <div className="flex flex-wrap gap-2 px-4 pt-2" data-testid="knowledge-selection-chips">
            {knowledgeReferences.map(reference => <span key={knowledgeReferenceIdentity(reference)} className="inline-flex max-w-full items-center gap-2 rounded-md border px-2 py-1 text-xs" style={{ color: "var(--surface-text)", borderColor: "var(--surface-border)", background: "var(--surface-2)" }}>
              <span className="truncate"># {reference.label || (reference.kind === "base" ? reference.kbId : reference.sourceId)}</span>
              <button type="button" aria-label={language === "en" ? "Remove knowledge source" : "移除知识资料"} onClick={() => setKnowledgeReferences(current => current.filter(item => knowledgeReferenceIdentity(item) !== knowledgeReferenceIdentity(reference)))}><IconClose className="h-3 w-3" /></button>
            </span>)}
          </div>}
          <div className="relative">
            <textarea
              ref={handleTextareaRef}
              data-testid="composer-textarea"
              role={showSkillMenu || showSlashMenu ? "combobox" : undefined}
              aria-haspopup={showSkillMenu || showSlashMenu ? "listbox" : undefined}
              aria-controls={showSkillMenu ? "main-skill-picker-menu" : showSlashMenu ? "main-slash-command-menu" : undefined}
              aria-expanded={showSkillMenu || showSlashMenu}
              aria-activedescendant={
                showSkillMenu && !isSkillsLoading && visibleSkillItems[highlightedSkillIndex]
                  ? `main-skill-picker-option-${highlightedSkillIndex}`
                  : showSlashMenu && visibleSlashItems[highlightedSlashIndex]
                  ? `main-shortcut-option-${visibleSlashItems[highlightedSlashIndex].kind === "workspace_command" ? "rules" : visibleSlashItems[highlightedSlashIndex].item.intent}`
                  : undefined
              }
              aria-autocomplete={showSkillMenu || showSlashMenu ? "list" : undefined}
              className="max-h-[36vh] min-h-[3.5rem] w-full bg-transparent border-none outline-none resize-none overflow-hidden text-[#e4e4e7] p-4 text-[13px] leading-relaxed placeholder:text-[#a1a1aa]"
              style={{ fontSize: `${resolvedComposerFontSize}px` }}
              rows={activeDiffTask ? 1 : 2}
              placeholder={composerPlaceholder}
              value={draftInput}
              onChange={handleInputChange}
              onKeyDown={handleKeyDown}
              onSelect={(event) => {
                if (knowledgeSession) {
                  const textarea = event.currentTarget;
                  const current = getKnowledgePickerSession(textarea.value, textarea.selectionStart);
                  if (!current || textarea.selectionStart !== textarea.selectionEnd || current.anchor !== knowledgeSession.anchor) setKnowledgeSession(null);
                  else setKnowledgeSession(current);
                }
                if (!showSkillMenu) return;
                const textarea = event.currentTarget;
                const session = getSkillPickerSession(textarea.value, textarea.selectionStart);
                if (!session || textarea.selectionStart !== textarea.selectionEnd || session.anchor !== skillSession?.anchor) closeSkillMenu();
                else setSkillSession(session);
              }}
              onCompositionStart={() => {
                isComposingRef.current = true;
              }}
              onCompositionEnd={() => {
                isComposingRef.current = false;
                compositionEndedAtRef.current = Date.now();
              }}
              onPaste={handlePaste}
            />

            <KnowledgePicker ref={knowledgePickerRef} session={knowledgeSession} ownerKey={knowledgeOwnerKey} selected={knowledgeReferences} language={language === "en" ? "en" : "zh"}
              onClose={() => setKnowledgeSession(null)} onComplete={(references, session) => {
                const textarea = textareaRef.current;
                if (!textarea || isComposingRef.current || Date.now() - compositionEndedAtRef.current < 140 || textarea.selectionStart !== textarea.selectionEnd) return;
                const applied = applyKnowledgePickerSelection(textarea.value, textarea.selectionStart, session);
                if (!applied) { setKnowledgeSession(null); return; }
                setKnowledgeReferences(references);
                setDraftInput(applied.value);
                setStoreInput(applied.value, { preserveLockedComposerIntent: true });
                setKnowledgeSession(null);
                textarea.focus();
                requestAnimationFrame(() => { if (textareaRef.current === textarea && textarea.value === applied.value) textarea.selectionStart = textarea.selectionEnd = applied.cursor; });
              }} />

            {showSkillMenu && (
              <div
                id="main-skill-picker-menu"
                ref={skillMenuRef}
                role="listbox"
                aria-label={language === "en" ? "MAIN Skills" : "MAIN 技能"}
                data-testid="skill-picker-menu"
                className="absolute left-4 bottom-full mb-1 w-[min(34rem,calc(100%-2rem))] max-w-[34rem] rounded-lg border overflow-hidden z-50 flex flex-col shadow-lg"
                style={{ background: "var(--surface-1)", borderColor: "var(--surface-border)", color: "var(--surface-text)" }}
              >
                <div className="flex items-center gap-2 border-b px-3 py-2 text-[11px]" style={{ borderColor: "var(--surface-border)", color: "var(--surface-text-muted)" }}>
                  <span className="font-mono font-bold theme-text">$</span>
                  <span>{skillSession?.query
                    ? (language === "en" ? `Search Skills: ${skillSession.query}` : `搜索技能：${skillSession.query}`)
                    : (language === "en" ? "Choose a Skill" : "选择技能")}</span>
                </div>
                <div className="max-h-72 overflow-y-auto p-1.5">
                  {isSkillsLoading ? <p role="status" className="px-3 py-4 text-[11px]" style={{ color: "var(--surface-text-muted)" }}>{language === "en" ? "Loading available Skills…" : "正在加载可用技能…"}</p>
                    : skillPickerError ? <p role="status" className="px-3 py-4 text-[11px]" style={{ color: "var(--surface-text-muted)" }}>{language === "en" ? "Could not load Skills. Close this menu and retry." : "无法加载技能，请关闭菜单后重试。"}</p>
                    : visibleSkillItems.length === 0 ? <p role="status" className="px-3 py-4 text-[11px]" style={{ color: "var(--surface-text-muted)" }}>{skillSession?.query
                      ? (language === "en" ? "No matching Skills." : "没有匹配的技能。")
                      : (language === "en" ? "No available Skills. Add Skills in Skills & Prompts first." : "尚无可用技能，请先在“技能与提示词”中添加。")}</p>
                    : visibleSkillItems.map((candidate, index) => (
                      <button
                        key={candidate.id}
                        id={`main-skill-picker-option-${index}`}
                        role="option"
                        aria-selected={index === highlightedSkillIndex}
                        data-skill-id={candidate.id}
                        title={candidate.entryPath || candidate.insertText}
                        onMouseDown={(event) => event.preventDefault()}
                        onMouseEnter={() => setHighlightedSkillIndex(index)}
                        onClick={() => handleSelectSkill(candidate)}
                        className="w-full rounded-md px-3 py-2 text-left transition-colors"
                        style={{ background: index === highlightedSkillIndex ? "var(--accent-subtle)" : "transparent" }}
                      >
                        <span className="flex flex-wrap items-center gap-2">
                          <span className="text-[12px] font-semibold" style={{ color: "var(--surface-text-strong)" }}>{candidate.name}</span>
                          <span className="text-[10px]" style={{ color: "var(--surface-text-subtle)" }}>{language === "en"
                            ? ({ "自定义规则": "Custom Skill", "技能包": "Skill Package", "项目技能": "Project Skill", "本机技能": "Local Skill" }[candidate.sourceLabel] || candidate.sourceLabel)
                            : candidate.sourceLabel}{candidate.packageName ? ` · ${candidate.packageName}` : ""}</span>
                          {candidate.manualOnly && <span className="text-[10px]" style={{ color: "var(--surface-text-muted)" }}>{language === "en" ? "Manual only" : "仅手动"}</span>}
                        </span>
                        <span className="mt-0.5 block text-[11px] leading-snug" style={{ color: "var(--surface-text-muted)" }}>{candidate.description}</span>
                      </button>
                    ))}
                </div>
                <div className="flex flex-wrap items-center gap-3 border-t px-3 py-1.5 text-[10px]" style={{ borderColor: "var(--surface-border)", color: "var(--surface-text-subtle)" }}>
                  <span>{mentionHintUpDown}</span><span>{language === "en" ? "Enter / Tab Select" : "Enter / Tab 选择"}</span><span>{mentionHintEsc}</span>
                </div>
              </div>
            )}

            {/* ── @ Mention dropdown ── */}
            {showMentionMenu && (
              <div
                ref={mentionDropRef}
                className="absolute left-4 bottom-full mb-1 w-80 bg-[#09090b] border border-[#27272a] rounded-lg overflow-hidden z-50 flex flex-col"
              >
                {/* Search header */}
                <div className="p-2 border-b border-[#27272a] flex items-center gap-2 text-[#e4e4e7] bg-[#000000]">
                  <IconSearch className="w-3 h-3 text-[#a1a1aa]" />
                  <span className="text-[11px] text-[#a1a1aa] truncate">
                    {mentionSearchLabel}
                  </span>
                  {isFilesLoading && (
                    <span className="text-[10px] text-[#71717a] ml-auto">{filesLoadingLabel}</span>
                  )}
                  {!isFilesLoading && (
                    <span className="text-[10px] text-[#52525b] ml-auto">{fileCountLabel}</span>
                  )}
                </div>

                {/* File list */}
                <div className="max-h-52 overflow-y-auto">
                  {!currentWorkspace ? (
                    <div className="px-3 py-3 text-[11px] text-[#a1a1aa] text-center">{noWorkspaceLabel}</div>
                  ) : mentionResults.length === 0 ? (
                    <div className="px-3 py-3 text-[11px] text-[#a1a1aa] text-center">
                      {noMatchLabel}
                    </div>
                  ) : (
                    mentionResults.map((relPath: string, idx: number) => (
                      <button
                        key={relPath}
                        onClick={() => handleSelectMention(relPath)}
                        className={`w-full flex items-center gap-2 px-3 py-2 text-xs transition-colors ${
                          idx === highlightedIndex
                            ? "bg-[#18181b] text-white"
                            : "text-[#e4e4e7] hover:bg-[#18181b]"
                        }`}
                      >
                        <IconFile className="w-3.5 h-3.5 shrink-0" style={{ color: 'var(--accent)' }} />
                        <span className="font-mono truncate">{relPath}</span>
                      </button>
                    ))
                  )}
                </div>

                {/* Keyboard hint */}
                <div className="px-3 py-1.5 border-t border-[#27272a] flex items-center gap-3 text-[10px] text-[#52525b]">
                  <span>{mentionHintUpDown}</span>
                  <span>{mentionHintEnter}</span>
                  <span>{mentionHintEsc}</span>
                </div>
              </div>
            )}

            {showSlashMenu && (
              <div
                id="main-slash-command-menu"
                ref={slashMenuRef}
                role="listbox"
                aria-label={language === "en" ? "MAIN slash commands" : "MAIN 斜杠命令"}
                className={`absolute left-4 bottom-full mb-1 w-[min(34rem,calc(100%-2rem))] max-w-[34rem] rounded-lg border overflow-hidden z-50 flex flex-col ${
                  isLightTheme
                    ? "border-[#d4d4d8] bg-white text-[#111827]"
                    : "border-[#27272a] bg-[#09090b] text-[#e4e4e7]"
                }`}
              >
                <div className={`flex items-center gap-2 border-b p-2 ${
                  isLightTheme ? "border-[#d4d4d8] bg-[#f8fafc]" : "border-[#27272a] bg-[#000000]"
                }`}>
                  <IconCode className="w-3.5 h-3.5" style={{ color: isLightTheme ? "var(--accent-hover)" : "var(--accent-light)" }} />
                  <span className={`truncate text-[11px] ${isLightTheme ? "text-[#52525b]" : "text-[#a1a1aa]"}`}>{mainIntentSearchLabel}</span>
                  <span
                    className="ml-auto shrink-0 text-[10px] font-semibold"
                    style={{ color: isLightTheme ? "var(--accent-hover)" : "var(--accent-light)" }}
                  >
                    {language === "en" ? "MAIN Shortcut" : "MAIN 快捷入口"}
                  </span>
                </div>

                <div className="overflow-visible px-2 py-2">
                  {filteredSlashItems.length === 0 && projectInitSlashItems.length === 0 ? (
                    <div className={`px-3 py-4 text-center text-[11px] ${isLightTheme ? "text-[#71717a]" : "text-[#a1a1aa]"}`}>{mainIntentEmptyLabel}</div>
                  ) : (
                    (groupedSlashItems[0]?.groups || []).map(([groupName, items]) => (
                      <div key={groupName} className="py-1">
                        <div
                          className="px-3 pb-1 pt-1 text-[10px] font-semibold uppercase tracking-[0.16em]"
                          style={{ color: isLightTheme ? "var(--accent-hover)" : "var(--accent-light)" }}
                        >
                          {groupName}
                        </div>
                        {items.map((item) => {
                          const displayItem = item.kind === "main_intent" ? item.item : item;
                          const index = visibleSlashItems.findIndex((candidate) => candidate.key === item.key);
                          const isActive = index === highlightedSlashIndex;
                          const optionId = item.kind === "workspace_command" ? "rules" : displayItem.intent;
                          return (
                            <button
                              key={item.key}
                              id={`main-shortcut-option-${optionId}`}
                              role="option"
                              aria-selected={isActive}
                              aria-disabled={item.disabled || undefined}
                              disabled={item.disabled}
                              data-testid={`main-shortcut-item-${optionId}`}
                              onClick={() => handleSelectSlashItem(item)}
                              className={`w-full rounded-md px-3 py-2 text-left transition-colors ${item.disabled ? "cursor-not-allowed opacity-55" : ""}`}
                              style={{
                                backgroundColor: isActive
                                  ? "var(--accent-subtle)"
                                  : "transparent",
                              }}
                              onMouseEnter={(event) => {
                                if (!isActive) event.currentTarget.style.backgroundColor = "var(--accent-subtle)";
                              }}
                              onMouseLeave={(event) => {
                                if (!isActive) event.currentTarget.style.backgroundColor = "transparent";
                              }}
                            >
                              <div className="min-w-0">
                                <div
                                  className="truncate text-[12px] font-semibold"
                                  style={{ color: isLightTheme ? "var(--accent-hover)" : "var(--accent-light)" }}
                                >
                                  {displayItem.command}
                                </div>
                                <div className={`mt-0.5 text-[11px] leading-snug ${isLightTheme ? "text-[#52525b]" : "text-[#a1a1aa]"}`}>
                                  {displayItem.description}
                                </div>
                              </div>
                            </button>
                          );
                        })}
                      </div>
                    ))
                  )}
                </div>

                <div className={`flex items-center gap-3 border-t px-3 py-1.5 text-[10px] ${
                  isLightTheme ? "border-[#d4d4d8] text-[#71717a]" : "border-[#27272a] text-[#52525b]"
                }`}>
                  <span>{mentionHintUpDown}</span>
                  <span>{mentionHintEnter}</span>
                  <span>{mentionHintEsc}</span>
                  <span className="ml-auto" style={{ color: isLightTheme ? "var(--accent-hover)" : "var(--accent-light)" }}>{mainIntentHint}</span>
                </div>
              </div>
            )}

          </div>

          {(queuedTurnCount > 0 || activeGuidance) && (
            <div className={`border-t px-3 py-2 ${isLightTheme ? "border-[#e4e4e7] bg-[#fafafa]" : "border-[#27272a] bg-[#070709]"}`}>
              {queuedTurnCount > 0 && (
                <div
                  data-testid="composer-queued-message"
                  className={`flex min-h-9 items-center gap-2 rounded-md border px-3 py-2 text-[11px] ${
                    isLightTheme
                      ? "border-blue-200 bg-blue-50 text-blue-950"
                      : "border-[rgba(96,165,250,0.24)] bg-[rgba(37,99,235,0.08)] text-[#dbeafe]"
                  }`}
                >
                  <div className="min-w-0 flex-1">
                    <div className={`text-[10px] font-semibold uppercase tracking-[0.14em] ${isLightTheme ? "text-blue-700" : "text-[#93c5fd]"}`}>
                      {language === "en" ? `Queued · ${queuedTurnCount} turn${queuedTurnCount === 1 ? "" : "s"}` : `已排队 · ${queuedTurnCount} 个回合`}
                    </div>
                    <div className="max-h-28 overflow-y-auto">
                      {queuedRows.map(row => (
                        <div key={row.id} className="mt-0.5 flex items-center gap-2">
                          <div className="min-w-0 flex-1 truncate text-[12px] leading-snug">
                            {row.text.trim() || (language === "en" ? "Turn with attachments or images" : "包含附件或图片的回合")}
                          </div>
                          {queuedGuidanceAvailable && row.guide && (
                            <button
                              type="button"
                              data-testid="composer-guide-queued-message"
                              onClick={async () => {
                                if (guidanceTarget && !await useAppStore.getState().guideWorkspaceRun({
                                  receiptId: row.id, target: guidanceTarget,
                                })) {
                                  setAttachmentNotice(language === "en" ? "Guidance could not be confirmed. Check the current turn and queue." : "引导未能确认，请查看当前回合和队列。");
                                }
                              }}
                              className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-emerald-600/40 px-2 transition-colors hover:bg-emerald-600/10"
                            >
                              <IconZap className="h-3.5 w-3.5" />
                              {language === "en" ? "Guide current turn" : "引导当前回合"}
                            </button>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              )}
              {activeGuidance && (
                <div
                  data-testid="composer-active-guidance"
                  className={`${queuedTurnCount > 0 ? "mt-2" : ""} flex min-h-9 items-center gap-2 rounded-md border px-3 py-2 text-[11px] ${
                    isLightTheme
                      ? "border-emerald-200 bg-emerald-50 text-emerald-950"
                      : "border-[rgba(52,211,153,0.24)] bg-[rgba(16,185,129,0.08)] text-[#bbf7d0]"
                  }`}
                >
                  <div className="min-w-0 flex-1">
                    <div className={`text-[10px] font-semibold uppercase tracking-[0.14em] ${isLightTheme ? "text-emerald-700" : "text-[#86efac]"}`}>
                      {language === "en" ? "Guiding current run" : "正在引导当前执行"}
                    </div>
                    <div className="mt-0.5 truncate text-[12px] leading-snug">{activeGuidancePreview}</div>
                  </div>
                  <button
                    type="button"
                    data-testid="composer-guidance-undo-button"
                    onClick={clearActiveGuidance}
                    className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md border transition-colors ${
                      isLightTheme
                        ? "border-emerald-200 bg-white text-emerald-700 hover:bg-emerald-100"
                        : "border-[#34343b] bg-[#050507] text-[#a1a1aa] hover:border-[#52525b] hover:text-white"
                    }`}
                    title={language === "en" ? "Undo guidance before it is consumed" : "在引导被消费前撤销"}
                  >
                    <IconClose className="h-3.5 w-3.5" />
                  </button>
                </div>
              )}
            </div>
          )}

          <div className="flex items-center justify-between gap-3 px-3 py-2.5 bg-[#09090b] rounded-b-xl border-t border-[#27272a]">
            <div className="relative flex min-w-0 flex-wrap items-center gap-2">

              {/* Context Usage Indicator */}
              <div className="flex items-center gap-1.5 text-[#71717a] font-mono text-[11px] font-semibold select-none">
                {activeProfile === "cloud" ? (
                                                    <div className="flex items-center gap-1.5 ml-0.5" title={cloudTokenTitle}>
                                                      <span className="inline-block h-1.5 w-1.5 rounded-full bg-[#60a5fa]" />
                                                      <span>{cloudTokenLabel}</span>
                                                    </div>
                                                  ) : (
                                                    <div className="flex items-center gap-1.5 ml-0.5" title={`${currentTokens} / ${contextLimit} Tokens`}>
                                                      <ContextRing percentage={usagePercent} themeMode={themeMode} />
                                                      <span>{usagePercent.toFixed(1)}%</span>
                                                    </div>
                                                  )}
              </div>

              <div className="composer-toolbar-divider h-4 w-px mx-1"></div>

              {(
                                              <button
                                                ref={helpButtonRef}
                                                type="button"
                                                data-testid="composer-help-button"
                                                onClick={toggleMainOnboarding}
                                                className={`panel-tab-icon-button flex h-7 w-7 shrink-0 items-center justify-center rounded-[7px] p-0 text-[14px] font-semibold transition-all duration-150 ${showMainOnboarding ? "is-active" : ""}`}
                                                title={language === "en" ? "Open the MAIN quick guide" : "打开 MAIN 使用指南"}
                                                aria-label={language === "en" ? "Open the MAIN quick guide" : "打开 MAIN 使用指南"}
                                                aria-controls="main-onboarding-panel"
                                                aria-expanded={showMainOnboarding}
                                              >
                                                ?
                                              </button>
                                            )}

              {/* @ Mention button — inserts @ and opens the same menu */}
              {(
                                              <>
                                                <button
                                                  onClick={handleAtButtonClick}
                                                  className={`panel-tab-icon-button flex h-7 w-7 shrink-0 items-center justify-center rounded-[7px] p-0 transition-all duration-150 ${showMentionMenu ? "is-active" : ""}`}
                                                  title={language === "en" ? "Reference file" : "引用文件"}
                                                >
                                                  <IconAt className="w-3.5 h-3.5" />
                                                </button>

                                                <button
                                                  onClick={handleAttachButtonClick}
                                                  className="panel-tab-icon-button flex h-7 w-7 shrink-0 items-center justify-center rounded-[7px] p-0 transition-all duration-150"
                                                  title={language === "en" ? "Attach file" : "附加文件"}
                                                >
                                                  <IconPlus className="w-4 h-4" />
                                                </button>

                                                <div className="relative" ref={webSearchPanelRef}>
                                                  <button
                                                    type="button"
                                                    data-testid="composer-web-search-toggle"
                                                    onClick={handleToggleWebSearch}
                                                    className={`panel-tab-icon-button flex h-7 w-7 shrink-0 items-center justify-center rounded-[7px] p-0 transition-all duration-150 ${webSearchEnabled ? "is-active" : ""}`}
                                                    title={webSearchButtonTitle}
                                                    aria-pressed={webSearchEnabled}
                                                  >
                                                    <IconGlobe className="w-4 h-4" />
                                                  </button>
                                                  {showWebSearchPanel && (
                                                    <div
                                                      className={`absolute bottom-[calc(100%+10px)] left-0 z-50 w-[300px] overflow-hidden rounded-xl border shadow-2xl ${
                                                        isLightTheme
                                                          ? "border-[#d4d4d8] bg-white text-[#18181b] shadow-[0_20px_60px_rgba(15,23,42,0.18)]"
                                                          : "border-[#27272a] bg-[#18181b] text-[#f4f4f5] shadow-[0_20px_60px_rgba(0,0,0,0.45)]"
                                                      }`}
                                                    >
                                                      <div className={`border-b px-3 py-2 text-[11px] font-semibold ${isLightTheme ? "border-[#e4e4e7] text-[#52525b]" : "border-[#27272a] text-[#a1a1aa]"}`}>
                                                        {language === "en" ? "Web Search" : "网络搜索"}
                                                      </div>
                                                      <div className="p-1.5">
                                                        {webSearchProviderOptions.map((option) => {
                                                          const selected = webSearchProvider === option.id;
                                                          return (
                                                            <button
                                                              key={option.id}
                                                              type="button"
                                                              onClick={() => handleSelectWebSearchProvider(option.id)}
                                                              className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left transition-colors ${
                                                                selected
                                                                  ? isLightTheme
                                                                    ? "bg-[var(--accent-subtle)] text-[var(--accent-hover)]"
                                                                    : "bg-[rgba(255,255,255,0.08)] text-white"
                                                                  : isLightTheme
                                                                  ? "text-[#374151] hover:bg-[#f4f4f5]"
                                                                  : "text-[#d4d4d8] hover:bg-[#27272a]"
                                                              }`}
                                                            >
                                                              <IconGlobe className={`h-4 w-4 ${selected ? "" : "opacity-70"}`} />
                                                              <span className="min-w-0 flex-1">
                                                                <span className="block truncate text-[13px] font-semibold">{option.label}</span>
                                                                <span className={`block truncate text-[11px] ${selected ? "opacity-75" : isLightTheme ? "text-[#71717a]" : "text-[#71717a]"}`}>
                                                                  {option.detail}
                                                                </span>
                                                              </span>
                                                              <span className={`text-[11px] ${selected ? "opacity-90" : "opacity-50"}`}>
                                                                {language === "en" ? "Free" : "免费"}
                                                              </span>
                                                            </button>
                                                          );
                                                        })}
                                                      </div>
                                                      <label
                                                        className={`flex w-full items-center justify-between gap-3 border-t px-3 py-2 text-left text-[12px] ${
                                                          isLightTheme
                                                            ? "border-[#e4e4e7] text-[#71717a]"
                                                            : "border-[#27272a] text-[#a1a1aa]"
                                                        }`}
                                                      >
                                                        <span>{language === "en" ? "Web Search" : "网络搜索"}</span>
                                                        <ToggleSwitch
                                                          checked={webSearchEnabled}
                                                          onCheckedChange={(enabled) => {
                                                            setWebSearchEnabled(enabled);
                                                            if (!enabled) setShowWebSearchPanel(false);
                                                          }}
                                                          aria-label={language === "en" ? "Web Search" : "网络搜索"}
                                                        />
                                                      </label>
                                                    </div>
                                                  )}
                                                </div>
                                              </>
                                            )}
              {onTogglePreferSubagents && (
                <button
                  type="button"
                  data-testid="composer-subagent-preference-toggle"
                  onClick={handleToggleSubagentPreference}
                  disabled={subagentPreferenceToggleDisabled}
                  className={`panel-tab-icon-button flex h-7 shrink-0 items-center justify-center gap-1.5 rounded-[7px] transition-all duration-150 disabled:cursor-not-allowed disabled:opacity-70 ${preferSubagents ? "is-active w-auto px-2" : "w-7 p-0"}`}
                  title={subagentPreferenceButtonTitle}
                  aria-label={language === "en" ? "Enable subagent collaboration" : "开启子智能体协作"}
                  aria-pressed={!!preferSubagents}
                >
                  <IconSubagent className="h-4 w-4 shrink-0" />
                  {preferSubagents && (
                    <span
                      data-testid="composer-subagent-preference-status"
                      className="text-[9px] font-semibold leading-none"
                    >
                      {language === "en" ? "Collaboration on" : "协作已开启"}
                    </span>
                  )}
                </button>
              )}
              {onToggleAutoApprove && (
                <button
                  type="button"
                  data-testid="composer-auto-review-toggle"
                  onClick={handleToggleAutoReview}
                  disabled={autoReviewToggleDisabled}
                  className={`panel-tab-icon-button flex h-7 w-7 shrink-0 items-center justify-center rounded-[7px] p-0 transition-all duration-150 disabled:cursor-not-allowed disabled:opacity-70 ${autoApproveTools ? "is-active" : ""}`}
                  title={autoReviewButtonTitle}
                  aria-pressed={autoApproveTools}
                >
                  <IconShield className="h-4 w-4" />
                </button>
              )}

            </div>

            <div className="flex items-center gap-2">
              {lockedComposerIntentLabel && !activeDiffTask && !composerRunActive && (
                <button
                  type="button"
                  onClick={() => setLockedComposerIntent(null)}
                  className="rounded-full border px-2.5 py-1 text-[10px] font-semibold tracking-[0.04em] transition-colors hover:bg-[#18181b]"
                  style={{ borderColor: "var(--accent-subtle-border)", backgroundColor: "var(--accent-subtle)", color: isLightTheme ? "var(--accent-hover)" : "var(--accent-light)" }}
                  title={language === "en" ? "Click to remove intent" : "点击取消意图胶囊"}
                >
                  {lockedComposerIntentLabel}
                  {lockedComposerIntentCategoryLabel ? <span className="ml-1 opacity-70">· {lockedComposerIntentCategoryLabel}</span> : null}
                  <span className="ml-1">×</span>
                </button>
              )}

              {/* Send / Stop button */}
              {!activeDiffTask && (
                composerRunActive ? (
                  (
                                                          <>
                                                            {hasDraftPayload && (
                                                              <>
                                                                {composerGuidanceAvailable && (
                                                                  <button
                                                                    type="button"
                                                                    data-testid="composer-guidance-button"
                                                                    disabled={!guidanceEligible}
                                                                    onClick={handleGuideCurrentRun}
                                                                    className={`inline-flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-[11px] font-semibold shadow-sm transition-colors disabled:cursor-not-allowed disabled:opacity-45 ${
                                                                      isLightTheme
                                                                        ? "border-emerald-200 bg-emerald-50 text-emerald-800 hover:bg-emerald-100"
                                                                        : "border-[rgba(52,211,153,0.30)] bg-[rgba(16,185,129,0.10)] text-[#bbf7d0] hover:bg-[rgba(16,185,129,0.18)]"
                                                                    }`}
                                                                    title={guidanceButtonTitle}
                                                                  >
                                                                    <IconZap className="h-3.5 w-3.5" />
                                                                    {language === "en" ? "Guide" : "引导"}
                                                                  </button>
                                                                )}
                                                                <button
                                                                  type="button"
                                                                  data-testid="composer-queue-button"
                                                                  disabled={isSubmitPending}
                                                                  onClick={handleSubmitComposerMessage}
                                                                  className={`inline-flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-[11px] font-semibold shadow-sm transition-colors disabled:opacity-50 ${
                                                                    isLightTheme
                                                                      ? "border-blue-200 bg-blue-50 text-blue-800 hover:bg-blue-100"
                                                                      : "border-[rgba(96,165,250,0.30)] bg-[rgba(37,99,235,0.10)] text-[#bfdbfe] hover:bg-[rgba(37,99,235,0.18)]"
                                                                  }`}
                                                                  title={concurrentSubmitButtonTitle}
                                                                >
                                                                  <IconArrowUp className="h-3.5 w-3.5" />
                                                                  {language === "en" ? "Queue" : "排队"}
                                                                </button>
                                                              </>
                                                            )}
                                                            {composerCanStop && (
                                                              <button
                                                                type="button"
                                                                data-testid="composer-stop-button"
                                                                onClick={onStopGeneration}
                                                                className="flex h-8 w-8 items-center justify-center rounded-md border border-[#7f1d1d] bg-[#09090b] text-[#f48771] shadow-sm transition-colors hover:bg-[#7f1d1d] hover:text-white"
                                                                title={language === "en" ? "Stop current run" : "停止当前执行"}
                                                              >
                                                                <IconStop className="h-4 w-4" />
                                                              </button>
                                                            )}
                                                          </>
                                                        )
                ) : (
                  <button
                    data-testid="composer-send-button"
                    disabled={isComposerSubmitting || (!draftInput.trim() && contextMentions.length === 0 && attachedFiles.length === 0 && pendingImages.length === 0)}
                    onClick={handleSubmitComposerMessage}
                    className="bg-[#09090b] border border-[#27272a] text-[#a1a1aa] hover:bg-white hover:text-black w-8 h-8 flex items-center justify-center rounded-md transition-colors disabled:opacity-50 shadow-sm"
                  >
                    <IconArrowUp className="w-4 h-4" />
                  </button>
                )
              )}
            </div>
          </div>
        </div>
        </div>
      </div>

    </>
  );
}
