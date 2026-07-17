// @ts-nocheck
import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { IconAt, IconFile, IconClose, IconArrowUp, IconPlus, IconCode, IconChevronUp as IconChevronUpIcon, IconImageIcon, IconRefresh, IconSearch, IconSettings, IconStop, IconZap, IconTrash, IconGlobe, IconShield, IconSubagent } from "./Icons";
import ImageStudioSetupModal from "./ImageStudioSetupModal";
import MainModeSwitcher from "./composer/MainModeSwitcher";
import GameStudioOnboardingPanel from "./gameStudio/GameStudioOnboardingPanel";
import GameStudioSlashMenu from "./gameStudio/GameStudioSlashMenu";
import { getAllWorkspaceFiles, fuzzyFilterFiles } from "../utils/fsUtils";
import { compressImage, getImageFilesFromClipboard, processImageFile } from "../utils/imageUtils";
import { estimateTokens } from "../lib/contextTrim";
import { ingestAttachmentBytes } from "../lib/ipc";
import { useAppStore } from "../store/useAppStore";
import type { AgentMessage, ContentPart } from "../lib/orchestrator";
import { createWorkspaceFileIndexController } from "../lib/workspaceFileIndex";
import { getGameStudioSlashCatalog } from "../lib/gameStudio/pack";
import { humanizeSlug } from "../lib/gameStudio/catalog";
import { getIntentPolicy, getMainIntentShortcuts, getRunIntentCategoryLabel, getRunIntentLabel, parseMainDebugShortcut, parseMainIntentShortcutForMode, resolveComposerIntentSuggestion } from "../lib/runIntent";
import { isImageModelName } from "../lib/imageStudio";
import {
  getGameStudioOnboardingCopy,
  resolveGameStudioOnboardingAction,
  shouldShowGameStudioOnboarding,
} from "../lib/gameStudio/onboarding";
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
  if (/[\s\n]/.test(query)) return { anchor: slashIndex, query: "" };
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
  showAgentPicker,
  setShowAgentPicker,
  selectedMainModeKey,
  mainModes,
  activeStudioAgentKey,
  setActiveStudioAgentKey,
  gameStudioInitialized,
  initializeGameStudioWorkspace,
  removeGameStudioWorkspace,
  currentWorkspace,
  t,
  activeDiffTask,
  handleAcceptInline,
  handleRejectInline,
  setShowDiff,
  onSendMessage,
  isStreaming = false,
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
  const [showWebSearchPanel, setShowWebSearchPanel] = useState(false);
  const [allFiles, setAllFiles] = useState<string[]>([]);
  const [isFilesLoading, setIsFilesLoading] = useState(false);
  const [dismissedStudioOnboardingByWorkspace, setDismissedStudioOnboardingByWorkspace] = useState<Record<string, boolean>>({});
  const [usedStudioOnboardingByWorkspace, setUsedStudioOnboardingByWorkspace] = useState<Record<string, boolean>>({});
  const [forceVisibleStudioOnboardingByWorkspace, setForceVisibleStudioOnboardingByWorkspace] = useState<Record<string, boolean>>({});
  const [isSubmitPending, setIsSubmitPending] = useState(false);
  const [dismissedSuggestedIntentKey, setDismissedSuggestedIntentKey] = useState<string | null>(null);

  // Tracks the position of the @ that triggered the current mention session
  const mentionAnchorRef = useRef(-1);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const mentionDropRef = useRef<HTMLDivElement>(null);
  const slashMenuRef = useRef<HTMLDivElement>(null);
  const mainFocusPickerRef = useRef<HTMLDivElement>(null);
  const webSearchPanelRef = useRef<HTMLDivElement>(null);
  const composerShellRef = useRef<HTMLDivElement>(null);
  const slashAnchorRef = useRef(-1);
  const previousMainModeRef = useRef(selectedMainModeKey);
  const previousWorkspaceRef = useRef(currentWorkspace);
  const submitUnlockTimerRef = useRef<number | null>(null);
  const submitPendingRef = useRef(false);
  const isComposingRef = useRef(false);
  const compositionEndedAtRef = useRef(0);
  const mentionLoadRequestIdRef = useRef(0);

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
  const queuedUserMessage = useAppStore((s) => s.queuedUserMessage);
  const activeGuidance = useAppStore((s) => s.activeGuidance);
  const captureVisibleGoalSubmissionEnvelope = useAppStore(
    (s) => s.captureVisibleGoalSubmissionEnvelope,
  );
  const queueUserMessage = useAppStore((s) => s.queueUserMessage);
  const clearQueuedUserMessage = useAppStore((s) => s.clearQueuedUserMessage);
  const setActiveGuidance = useAppStore((s) => s.setActiveGuidance);
  const clearActiveGuidance = useAppStore((s) => s.clearActiveGuidance);
  const currentTurnId = useAppStore((s) => s.currentTurnId);
  const workspaceContentVersion = useAppStore((s) => s.workspaceContentVersion);
  const isPlanApproved = useAppStore((s) => s.isPlanApproved);
  const planTasks = useAppStore((s) => s.planTasks);
  const planStage = useAppStore((s) => s.planStage);
  const conversationTurns = useAppStore((s) => s.conversationTurns);
  const lockedComposerIntent = useAppStore((s) => s.lockedComposerIntent);
  const setLockedComposerIntent = useAppStore((s) => s.setLockedComposerIntent);
  const imageStudio = useAppStore((s) => s.imageStudio);
  const setImageStudioConfig = useAppStore((s) => s.setImageStudioConfig);
  const setImageStudioSetupGuideOpen = useAppStore((s) => s.setImageStudioSetupGuideOpen);
  const checkImageStudioEngine = useAppStore((s) => s.checkImageStudioEngine);
  const switchMainModeWithIsolation = useAppStore((s) => s.switchMainModeWithIsolation);
  const webSearchEnabled = useAppStore((s) => s.webSearchEnabled);
  const webSearchProvider = useAppStore((s) => s.webSearchProvider);
  const setWebSearchEnabled = useAppStore((s) => s.setWebSearchEnabled);
  const setWebSearchProvider = useAppStore((s) => s.setWebSearchProvider);
  const [draftInput, setDraftInput] = useState(storeInput);
  const [debouncedInput, setDebouncedInput] = useState(storeInput);
  const [showImageStudioAdvanced, setShowImageStudioAdvanced] = useState(false);
  const slashCatalog = useMemo(
    () => getGameStudioSlashCatalog(language === "en" ? "en" : "zh"),
    [language],
  );
  const mainIntentShortcuts = useMemo(
    () => getMainIntentShortcuts(language === "en" ? "en" : "zh", { mainModeKey: "main_mode" })
      .filter((item) => currentWorkspace || item.intent !== "goal"),
    [currentWorkspace, language],
  );
  const gameStudioPlanShortcuts = useMemo(
    () => getMainIntentShortcuts(language === "en" ? "en" : "zh", { mainModeKey: "game_studio" }),
    [language],
  );
  const isGameStudioMode = selectedMainModeKey === "game_studio";
  const isMainMode = selectedMainModeKey === "main_mode";
  const isImageStudioMode = selectedMainModeKey === "image_studio";
  const isLightTheme = themeMode === "light";
  const isComposerSubmitting = isSubmitPending;
  const resolvedComposerFontSize = Math.min(20, Math.max(10, Number(chatFontSize ?? useAppStore.getState().config.chatFontSize) || 13));
  const showExecutionProgress =
    planTasks.length > 0 &&
    (planStage === "ready_to_execute" || planStage === "executing" || planStage === "completed" || isPlanApproved);
  const slashCommandLabel = language === "en" ? "Studio Commands" : "Studio 命令";
  const slashSearchLabel = slashQuery
    ? (language === "en" ? `Command: ${slashQuery}` : `命令：${slashQuery}`)
    : (language === "en" ? "Type / to search plan shortcuts, commands, and agents" : "输入 / 搜索计划入口、工作流命令和专业 Agent");
  const slashEmptyLabel = language === "en" ? "No matching shortcuts, commands, or agents" : "没有匹配的计划入口、命令或 Agent";
  const slashHint = language === "en" ? "Select to insert canonical command" : "选择后会插入标准命令";
  const mainIntentSearchLabel = slashQuery
    ? (language === "en" ? `Shortcut: ${slashQuery}` : `快捷入口：${slashQuery}`)
    : (language === "en" ? "Type / for planning and output styles" : "输入 / 选择计划入口和输出方式");
  const mainIntentEmptyLabel = language === "en" ? "No matching shortcuts" : "没有匹配的快捷入口";
  const mainIntentHint = language === "en"
    ? "Use natural language for direct execution; shortcuts are optional."
    : "直接用自然语言下达执行任务；快捷入口是可选的。";
  const studioPlanHeading = language === "en" ? "Plan Shortcuts" : "计划入口";
  const studioWorkflowHeading = language === "en" ? "Workflow Commands" : "工作流命令";
  const studioAgentHeading = language === "en" ? "Specialist Agents" : "专业 Agent";
  const planKindLabel = language === "en" ? "plan" : "计划";
  const workflowKindLabel = language === "en" ? "workflow" : "工作流";
  const agentKindLabel = language === "en" ? "agent" : "专家";
  const studioAutoLabel = language === "en" ? "Auto Routing" : "自动专家路由";
  const mainModeDescriptions = {
    main_mode: language === "en"
      ? "Ask naturally for summaries, analysis, reports, extraction, plans, or execution in one place."
      : "直接用自然语言提出总结、分析、报告、提炼、计划或执行需求。",
    game_studio: language === "en"
      ? "Run MAIN GAME STUDIO workflows and specialists, with /plan available for large changes."
      : "运行 MAIN GAME STUDIO 工作流与专业 Agent，并支持用 /plan 进入计划流。",
    image_studio: language === "en"
      ? "Generate images in a dedicated studio with local-first image runtime and an optional HiDream Web fallback."
      : "在独立图像工作室里进行本地优先的图片生成，并可按需切到 HiDream Web fallback。",
  };
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
  const queuedStatusLabel = language === "en" ? "Queued" : "已排队";
  const guidanceStatusLabel = language === "en" ? "Guidance" : "已引导";
  const guidanceButtonLabel = language === "en" ? "Guide" : "引导";
  const guidanceButtonTitle = language === "en"
    ? "Move this queued message into the current run at the next model iteration."
    : "把这条已排队指令注入当前运行的下一次模型迭代，不中断本轮执行。";
  const queueButtonTitle = language === "en"
    ? "Queue this message and send it automatically after the current run stops."
    : "将当前输入排队，当前模型停止后自动发送。";
  const autoReviewTitle = language === "en"
    ? "Auto Review: approve non-destructive tool requests in this session, including file changes, commands, local file reads, MCP actions, and browser validation."
    : "自动审查：本会话内自动批准非破坏性工具请求，包括文件修改、终端命令、本地文件读取、MCP 动作和浏览器验证。";
  const autoReviewLockedTitle = language === "en"
    ? "Auto Review is active for this run and can be changed after the run stops."
    : "自动审查已在本轮执行中启用，执行停止后才能关闭。";
  const subagentPreferenceTitle = language === "en"
    ? preferSubagents
      ? "Subagent collaboration is preferred for this session. MAIN will delegate one or more useful independent read-only scopes when appropriate."
      : "Prefer subagent collaboration for this session when useful independent read-only work exists."
    : preferSubagents
      ? "本会话已偏好子智能体协作；存在有价值的独立只读范围时，MAIN 会优先委派一个或多个子智能体。"
      : "为本会话开启子智能体协作偏好；存在有价值的独立只读范围时优先委派。";
  const subagentPreferenceLockedTitle = language === "en"
    ? "Subagent preference is captured for the current run and can be changed after it stops."
    : "本轮已捕获子智能体偏好，执行停止后才能更改。";
  const hasDraftPayload =
    draftInput.trim().length > 0 ||
    contextMentions.length > 0 ||
    attachedFiles.length > 0 ||
    pendingImages.length > 0;
  const streamingPrimaryQueuesMessage = isStreaming && hasDraftPayload;
  const queuedMessagePreview = queuedUserMessage?.text?.trim() || (queuedUserMessage ? (language === "en" ? "Attachment message" : "含附件消息") : "");
  const activeGuidancePreview = activeGuidance?.text?.trim() || "";
  const queuedIsGoalContinuation = Boolean(
    queuedUserMessage?.goalContinuationAuthorization,
  );
  const queuedCanGuide = Boolean(
    queuedUserMessage?.text?.trim() && !queuedIsGoalContinuation,
  );
  const autoReviewToggleDisabled = Boolean(autoApproveTools && isStreaming);
  const autoReviewButtonTitle = autoReviewToggleDisabled ? autoReviewLockedTitle : autoReviewTitle;
  const subagentPreferenceToggleDisabled = Boolean(isStreaming);
  const subagentPreferenceButtonTitle = subagentPreferenceToggleDisabled
    ? subagentPreferenceLockedTitle
    : subagentPreferenceTitle;
  const webSearchProviderOptions = useMemo(
    () => [
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
    webSearchProviderOptions.find((item) => item.id === webSearchProvider)?.label || "DuckDuckGo";
  const webSearchButtonTitle = webSearchEnabled
    ? `${language === "en" ? "Web search enabled" : "网络搜索已开启"}: ${activeWebSearchProviderLabel}`
    : "开启后允许模型在网络上搜索答案";
  const nonPackFiles = useMemo(
    () => allFiles.filter((path) => !path.startsWith(".MAIN/") && !path.startsWith(".protocols/")),
    [allFiles],
  );
  const currentWorkspaceOnboardingKey = currentWorkspace || "__no_workspace__";
  const composerIntentSuggestion = useMemo(() => {
    return resolveComposerIntentSuggestion({
      input: draftInput,
      language: language === "en" ? "en" : "zh",
      mainModeKey: selectedMainModeKey,
      lockedComposerIntent,
      dismissedSuggestedIntentKey,
      hasPlanArtifacts: planTasks.length > 0 || planStage !== "idle",
      planStage,
      isPlanApproved,
    });
  }, [dismissedSuggestedIntentKey, draftInput, isPlanApproved, language, lockedComposerIntent, planStage, planTasks.length, selectedMainModeKey]);
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
  const showStudioOnboarding = shouldShowGameStudioOnboarding({
    isGameStudioMode,
    hasWorkspace: Boolean(currentWorkspace),
    gameStudioInitialized,
    nonPackFileCount: nonPackFiles.length,
    input: draftInput,
    hasConversationHistory: conversationTurns.length > 0,
    showSlashMenu,
    dismissed: Boolean(dismissedStudioOnboardingByWorkspace[currentWorkspaceOnboardingKey]),
    used: Boolean(usedStudioOnboardingByWorkspace[currentWorkspaceOnboardingKey]),
    forceVisible: Boolean(forceVisibleStudioOnboardingByWorkspace[currentWorkspaceOnboardingKey]),
  });
  const imageStudioAspectOptions = ["1:1", "4:3", "3:4", "16:9", "9:16", "3:2", "2:3", "21:9", "9:21", "9:7", "7:9"] as const;
  const isWebFallbackImageEngine = imageStudio.config.provider === "web_fallback";
  const isLocalImageEngine = imageStudio.config.provider === "local_image_service";
  const imageStudioSupportsReferenceImages = imageStudio.status.capabilities?.imageToImage === true;
  const imageStudioLocalFamilyLabel = imageStudio.config.local.serviceFamily === "ollama"
    ? "Ollama"
    : imageStudio.config.local.serviceFamily === "omlx"
    ? "OMLX"
    : (language === "en" ? "OpenAI-compatible" : "OpenAI 兼容");
  const imageStudioProviderLabel = isWebFallbackImageEngine
    ? (language === "en" ? "HiDream Web" : "HiDream 网页")
    : (language === "en" ? "Local Image Service" : "本地图片服务");
  const imageStudioProviderDetail = isWebFallbackImageEngine
    ? (language === "en" ? "Hosted fallback inside Image Studio" : "图像工作室内置托管 fallback")
    : `${imageStudioLocalFamilyLabel} · ${imageStudio.status.activeModel || imageStudio.config.local.model || imageStudio.config.local.endpoint}`;

  const activeModel = imageStudio.status.activeModel || imageStudio.config.local.model || "";
  const isLocalActiveModelTextLLM = isLocalImageEngine && activeModel !== "" && !isImageModelName(activeModel);
  const isLocalActiveModelFlux = activeModel.toLowerCase().includes("flux");

  const [cooldownSec, setCooldownSec] = useState(0);

  useEffect(() => {
    if (!isImageStudioMode || !isWebFallbackImageEngine || !imageStudio.cooldownUntil) {
      setCooldownSec(0);
      return;
    }
    const interval = setInterval(() => {
      const remaining = Math.max(0, Math.ceil((imageStudio.cooldownUntil - Date.now()) / 1000));
      setCooldownSec(remaining);
      if (remaining === 0) {
        clearInterval(interval);
      }
    }, 200);
    return () => clearInterval(interval);
  }, [isImageStudioMode, isWebFallbackImageEngine, imageStudio.cooldownUntil]);
  const imageStudioStatusLabel = imageStudio.status.state === "ready"
    ? (language === "en" ? "Ready" : "已就绪")
    : imageStudio.status.state === "error"
    ? (language === "en" ? "Error" : "错误")
    : (language === "en" ? "Setup" : "设置");
  const imageStudioStatusDotClass = imageStudio.status.state === "ready"
    ? "bg-emerald-400 shadow-[0_0_5px_#34d399]"
    : imageStudio.status.state === "error"
    ? "bg-red-400 shadow-[0_0_5px_#f87171]"
    : "bg-zinc-500";
  const imageStudioPanelStyle = isLightTheme
    ? {
        borderColor: "var(--accent-subtle-border)",
        backgroundColor: "#ffffff",
      }
    : {
        borderColor: "var(--accent-subtle-border)",
        backgroundColor: themeMode === "black" ? "#000000" : "#09090b",
      };
  const imageStudioFieldStyle = isLightTheme
    ? {
        borderColor: "#d4d4d8",
        backgroundColor: "#f8fafc",
        color: "#111827",
      }
    : {
        borderColor: "#27272a",
        backgroundColor: "#050507",
        color: "#e4e4e7",
      };
  const imageStudioMutedStyle = {
    color: isLightTheme ? "#52525b" : "#a1a1aa",
  };
  const handleCheckImageStudioEngine = useCallback(() => {
    void checkImageStudioEngine();
  }, [checkImageStudioEngine]);

  // Debounce input for token estimation (300ms)
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedInput(draftInput), 300);
    return () => clearTimeout(timer);
  }, [draftInput]);

  useEffect(() => {
    if (isStreaming) return;
    setDraftInput(storeInput || "");
  }, [isStreaming, storeInput]);

  useEffect(() => {
    if (isStreaming && isSubmitPending) {
      submitPendingRef.current = false;
      setIsSubmitPending(false);
    }
  }, [isStreaming, isSubmitPending]);

  useEffect(() => {
    if (!isSubmitPending || isStreaming) return;

    if (submitUnlockTimerRef.current !== null) {
      window.clearTimeout(submitUnlockTimerRef.current);
    }

    submitUnlockTimerRef.current = window.setTimeout(() => {
      submitUnlockTimerRef.current = null;
      submitPendingRef.current = false;
      setIsSubmitPending(false);
    }, 1200);

    return () => {
      if (submitUnlockTimerRef.current !== null) {
        window.clearTimeout(submitUnlockTimerRef.current);
        submitUnlockTimerRef.current = null;
      }
    };
  }, [isStreaming, isSubmitPending]);

  useEffect(() => {
    return () => {
      if (submitUnlockTimerRef.current !== null) {
        window.clearTimeout(submitUnlockTimerRef.current);
      }
      submitPendingRef.current = false;
    };
  }, []);

  const showReferenceImagesUnavailableNotice = useCallback(() => {
    setAttachmentNotice(
      language === "en"
        ? "This image provider currently supports prompt-only generation. Reference images are hidden until image-to-image is available."
        : "当前图片 provider 只支持 prompt 生图，参考图入口会在支持 image-to-image 后再显示。",
    );
  }, [language]);

  useEffect(() => {
    const previousMode = previousMainModeRef.current;
    const previousWorkspace = previousWorkspaceRef.current;
    const enteredGameStudio = isGameStudioMode && previousMode !== "game_studio";
    const enteredImageStudio = isImageStudioMode && previousMode !== "image_studio";
    const changedWorkspaceInGameStudio = isGameStudioMode && Boolean(currentWorkspace) && previousWorkspace !== currentWorkspace;

    if ((enteredGameStudio || changedWorkspaceInGameStudio) && currentWorkspace) {
      setForceVisibleStudioOnboardingByWorkspace((prev) => ({
        ...prev,
        [currentWorkspaceOnboardingKey]: true,
      }));
      setDismissedStudioOnboardingByWorkspace((prev) => ({
        ...prev,
        [currentWorkspaceOnboardingKey]: false,
      }));
    }

    if (enteredImageStudio && imageStudio.status.state !== "ready") {
      setImageStudioSetupGuideOpen(true);
    }

    previousMainModeRef.current = selectedMainModeKey;
    previousWorkspaceRef.current = currentWorkspace;
  }, [currentWorkspace, currentWorkspaceOnboardingKey, imageStudio.status.state, isGameStudioMode, isImageStudioMode, selectedMainModeKey, setImageStudioSetupGuideOpen]);

  useEffect(() => {
    if (!currentWorkspace && lockedComposerIntent === "goal") {
      setLockedComposerIntent(null);
    }
  }, [currentWorkspace, lockedComposerIntent, setLockedComposerIntent]);

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
    if (isMainMode) {
      return mainIntentShortcuts.filter((item) => {
        if (!normalizedQuery) return true;
        const categoryLabel = getRunIntentCategoryLabel(item.intent, language === "en" ? "en" : "zh");
        const haystacks = [item.label, item.command, item.description, categoryLabel, ...(item.aliases || [])]
          .join(" ")
          .toLowerCase();
        return haystacks.includes(normalizedQuery);
      });
    }
    if (!isGameStudioMode) return [];
    const planShortcuts = gameStudioPlanShortcuts
      .map((item) => ({
        ...item,
        id: `main_intent:${item.intent}`,
        kind: "main_intent" as const,
        group: studioPlanHeading,
      }))
      .filter((item) => {
        if (!normalizedQuery) return true;
        const categoryLabel = getRunIntentCategoryLabel(item.intent, language === "en" ? "en" : "zh");
        const haystacks = [item.label, item.command, item.description, categoryLabel, ...(item.aliases || [])]
          .join(" ")
          .toLowerCase();
        return haystacks.includes(normalizedQuery);
      });
    const ranked = slashCatalog.filter((item) => {
      if (!normalizedQuery) return true;
      const haystacks = [
        item.label,
        item.canonicalCommand,
        item.group,
        item.description,
        ...(item.aliases || []),
      ]
        .join(" ")
        .toLowerCase();
      return haystacks.includes(normalizedQuery);
    });
    return [...planShortcuts, ...ranked];
  }, [gameStudioPlanShortcuts, isGameStudioMode, isMainMode, language, mainIntentShortcuts, slashCatalog, slashQuery, studioPlanHeading]);

  const mainIntentSlashGroups = useMemo(() => {
    if (!isMainMode || filteredSlashItems.length === 0) return [];
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
  }, [filteredSlashItems, isMainMode, language]);

  const visibleMainIntentSlashItems = useMemo(() => {
    if (!isMainMode) return [];
    return mainIntentSlashGroups.flatMap(([, items]) => items);
  }, [isMainMode, mainIntentSlashGroups]);

  const visibleSlashItems = isMainMode ? visibleMainIntentSlashItems : filteredSlashItems;

  const groupedSlashItems = useMemo(() => {
    const groups = [];
    if (isMainMode) {
      if (mainIntentSlashGroups.length > 0) {
        groups.push({
          kind: "main_intent",
          heading: language === "en" ? "MAIN Shortcuts" : "MAIN 快捷入口",
          groups: mainIntentSlashGroups,
        });
      }
      return groups;
    }
    const planGroups = new Map();
    const workflowGroups = new Map();
    const agentGroups = new Map();
    for (const item of filteredSlashItems) {
      const target = item.kind === "main_intent"
        ? planGroups
        : item.kind === "workflow"
        ? workflowGroups
        : agentGroups;
      if (!target.has(item.group)) target.set(item.group, []);
      target.get(item.group).push(item);
    }
    if (planGroups.size > 0) {
      groups.push({
        kind: "main_intent",
        heading: studioPlanHeading,
        groups: Array.from(planGroups.entries()),
      });
    }
    if (workflowGroups.size > 0) {
      groups.push({
        kind: "workflow",
        heading: studioWorkflowHeading,
        groups: Array.from(workflowGroups.entries()),
      });
    }
    if (agentGroups.size > 0) {
      groups.push({
        kind: "agent",
        heading: studioAgentHeading,
        groups: Array.from(agentGroups.entries()),
      });
    }
    return groups;
  }, [filteredSlashItems, isMainMode, language, mainIntentSlashGroups, studioAgentHeading, studioPlanHeading, studioWorkflowHeading]);

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
      if (showAgentPicker && mainFocusPickerRef.current && !mainFocusPickerRef.current.contains(target)) {
        setShowAgentPicker(false);
      }
      if (showWebSearchPanel && webSearchPanelRef.current && !webSearchPanelRef.current.contains(target)) {
        setShowWebSearchPanel(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [closeMentionMenu, closeSlashMenu, setShowAgentPicker, showAgentPicker, showWebSearchPanel]);

  useEffect(() => {
    if (isGameStudioMode || isMainMode) return;
    closeSlashMenu();
  }, [closeSlashMenu, isGameStudioMode, isMainMode]);

  useEffect(() => {
    if (!isImageStudioMode) return;
    closeMentionMenu();
    closeSlashMenu();
    setShowWebSearchPanel(false);
    setContextMentions([]);
    setAttachedFiles([]);
    setLockedComposerIntent(null);
  }, [closeMentionMenu, closeSlashMenu, isImageStudioMode, setAttachedFiles, setContextMentions, setLockedComposerIntent]);

  // ── Image paste handler ──
  const handlePaste = useCallback(async (e: React.ClipboardEvent) => {
    const imageFiles = getImageFilesFromClipboard(e.nativeEvent);
    if (imageFiles.length === 0) return;
    if (isImageStudioMode && !imageStudioSupportsReferenceImages) {
      e.preventDefault();
      showReferenceImagesUnavailableNotice();
      return;
    }

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
  }, [imageStudioSupportsReferenceImages, isImageStudioMode, showReferenceImagesUnavailableNotice]);

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
    if (isImageStudioMode && !imageStudioSupportsReferenceImages) {
      showReferenceImagesUnavailableNotice();
      return;
    }
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
    imageStudioSupportsReferenceImages,
    isImageStudioMode,
    onAttachFile,
    showReferenceImagesUnavailableNotice,
  ]);

  // ── File drag-and-drop handlers ──
  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (e.dataTransfer.types.includes("Files")) {
      if (isImageStudioMode && !imageStudioSupportsReferenceImages) return;
      e.preventDefault();
      e.stopPropagation();
      setIsDragOver(true);
    }
  }, [imageStudioSupportsReferenceImages, isImageStudioMode]);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
  }, []);

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    if (isImageStudioMode && !imageStudioSupportsReferenceImages) {
      e.preventDefault();
      e.stopPropagation();
      setIsDragOver(false);
      showReferenceImagesUnavailableNotice();
      return;
    }
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
    imageStudioSupportsReferenceImages,
    isImageStudioMode,
    showReferenceImagesUnavailableNotice,
  ]);

  // ── Insert @ from the @ button click ──
  const handleAtButtonClick = () => {
    if (isImageStudioMode) return;
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

  const handleStudioCommandButtonClick = () => {
    if (!isGameStudioMode) return;
    markStudioOnboardingUsed();
    setShowSlashMenu(true);
    const textarea = textareaRef.current;
    const cursorPos = textarea?.selectionStart ?? draftInput.length;
    const slashSession = getSlashSession(draftInput, cursorPos);
    slashAnchorRef.current = slashSession?.anchor ?? -1;
    setSlashQuery(slashSession?.query ?? "");
    textareaRef.current?.focus();
  };

  const reopenStudioOnboarding = useCallback((options?: { resetUsed?: boolean }) => {
    setForceVisibleStudioOnboardingByWorkspace((prev) => ({
      ...prev,
      [currentWorkspaceOnboardingKey]: true,
    }));
    setDismissedStudioOnboardingByWorkspace((prev) => ({
      ...prev,
      [currentWorkspaceOnboardingKey]: false,
    }));
    if (options?.resetUsed) {
      setUsedStudioOnboardingByWorkspace((prev) => ({
        ...prev,
        [currentWorkspaceOnboardingKey]: false,
      }));
    }
  }, [currentWorkspaceOnboardingKey]);

  const markStudioOnboardingDismissed = useCallback(() => {
    setForceVisibleStudioOnboardingByWorkspace((prev) => ({
      ...prev,
      [currentWorkspaceOnboardingKey]: false,
    }));
    setDismissedStudioOnboardingByWorkspace((prev) => ({
      ...prev,
      [currentWorkspaceOnboardingKey]: true,
    }));
  }, [currentWorkspaceOnboardingKey]);

  const markStudioOnboardingUsed = useCallback(() => {
    setForceVisibleStudioOnboardingByWorkspace((prev) => ({
      ...prev,
      [currentWorkspaceOnboardingKey]: false,
    }));
    setUsedStudioOnboardingByWorkspace((prev) => ({
      ...prev,
      [currentWorkspaceOnboardingKey]: true,
    }));
  }, [currentWorkspaceOnboardingKey]);

  const applyComposerDraft = useCallback((value: string) => {
    setDraftInput(value);
    setStoreInput(value, { preserveLockedComposerIntent: true });
    setShowSlashMenu(false);
    setHighlightedSlashIndex(0);
    requestAnimationFrame(() => {
      if (textareaRef.current) {
        const position = value.length;
        textareaRef.current.selectionStart = textareaRef.current.selectionEnd = position;
        textareaRef.current.focus();
      }
    });
  }, [setStoreInput]);

  const handleSelectSlashItem = (item) => {
    const value = item.kind === "workflow" ? `${item.canonicalCommand} ` : item.canonicalCommand;
    markStudioOnboardingUsed();
    applyComposerDraft(value);
  };

  const handleSelectMainIntentShortcut = (item) => {
    const parsed = parseMainIntentShortcutForMode(draftInput, selectedMainModeKey);
    const slashAnchor = slashAnchorRef.current;
    const nextInput = slashAnchor >= 0
      ? removeSlashSessionToken(draftInput, slashAnchor)
      : parsed
      ? parsed.rest.trimStart()
      : draftInput.replace(/^\s*\/[^\s]*\s*/, "");
    closeSlashMenu();
    if (item.intent === "image_studio") {
      const finalInput = `${item.command} ${nextInput}`;
      setDraftInput(finalInput);
      setStoreInput(finalInput, { preserveLockedComposerIntent: true });
    } else {
      setDraftInput(nextInput);
      setStoreInput(nextInput, { preserveLockedComposerIntent: true });
      setLockedComposerIntent(item.intent);
    }
    requestAnimationFrame(() => textareaRef.current?.focus());
  };

  const handleClearStudioAgent = async () => {
    await setActiveStudioAgentKey("studio_auto", { persistToWorkspace: gameStudioInitialized });
  };

  const handleStudioOnboardingAction = async (action) => {
    const resolved = resolveGameStudioOnboardingAction(action);

    if (resolved.kind === "initialize") {
      try {
        await initializeGameStudioWorkspace();
        markStudioOnboardingUsed();
        workspaceFileIndexController.clearWorkspace(currentWorkspace || "");
        await ensureWorkspaceFilesLoaded({ forceRefresh: true });
        setDraftInput("");
        setStoreInput("");
      } catch (error) {
        console.error("Failed to initialize Game Studio workspace:", error);
      }
      return;
    }

    markStudioOnboardingUsed();
    applyComposerDraft(resolved.value);
  };

  const handleRemoveGameStudioWorkspace = async () => {
    const onboardingCopy = getGameStudioOnboardingCopy(language === "en" ? "en" : "zh");
    const confirmed = await safeConfirmAsync(
      onboardingCopy.removeConfirmation,
      { source: "Composer", action: "remove_game_studio_workspace" },
    );

    if (!confirmed) return;

    try {
      await removeGameStudioWorkspace();
      workspaceFileIndexController.clearWorkspace(currentWorkspace || "");
      setDraftInput("");
      setStoreInput("");
      setShowSlashMenu(false);
      await ensureWorkspaceFilesLoaded({ forceRefresh: true });
      reopenStudioOnboarding({ resetUsed: true });
    } catch (error) {
      console.error("Failed to remove Game Studio workspace assets:", error);
    }
  };

  const handleToggleAutoReview = useCallback(async () => {
    if (!onToggleAutoApprove) return;
    if (autoApproveTools && isStreaming) return;
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
  }, [autoApproveTools, isStreaming, language, onToggleAutoApprove]);

  const handleToggleSubagentPreference = useCallback(() => {
    if (!onTogglePreferSubagents || isStreaming) return;
    onTogglePreferSubagents(!preferSubagents);
  }, [isStreaming, onTogglePreferSubagents, preferSubagents]);

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

  const handleSubmitComposerMessage = useCallback(() => {
    const textToSend = draftInput;
    const hasPayload =
      textToSend.trim().length > 0 ||
      contextMentions.length > 0 ||
      attachedFiles.length > 0 ||
      pendingImages.length > 0;

    if (!hasPayload || submitPendingRef.current) {
      return;
    }

    const explicitIntent = parseMainIntentShortcutForMode(textToSend, selectedMainModeKey)?.intent;
    if (!currentWorkspace && (lockedComposerIntent === "goal" || explicitIntent === "goal")) {
      window.alert(
        language === "en"
          ? "Goal mode needs a workspace so its runtime state can be saved and deleted safely. Open a workspace first."
          : "Goal 模式需要工作区来安全保存和删除运行状态，请先打开一个工作区。",
      );
      return;
    }

    if (isStreaming) {
      const visibleGoalSubmissionEnvelope =
        captureVisibleGoalSubmissionEnvelope(textToSend);
      queueUserMessage(textToSend, pendingImages, {
        contextMentions,
        attachedFiles: attachedFiles.map((file) => normalizeAttachedFile(file)),
        ...(visibleGoalSubmissionEnvelope ? { visibleGoalSubmissionEnvelope } : {}),
      });
      closeSlashMenu();
      setDraftInput("");
      if (lockedComposerIntent === "goal") {
        setLockedComposerIntent(null);
      }
      setStoreInput("");
      setContextMentions([]);
      setAttachedFiles([]);
      setPendingImages([]);
      return;
    }

    submitPendingRef.current = true;
    setIsSubmitPending(true);
    if (isGameStudioMode) {
      markStudioOnboardingUsed();
    }
    closeSlashMenu();
    const didSend = onSendMessage(textToSend, pendingImages);
    if (didSend === false) {
      submitPendingRef.current = false;
      setIsSubmitPending(false);
      return;
    }
    setDraftInput("");
    if (lockedComposerIntent === "goal") {
      setLockedComposerIntent(null);
      setStoreInput("");
    } else {
      setStoreInput("", { preserveLockedComposerIntent: true });
    }
    setPendingImages([]);
  }, [attachedFiles, captureVisibleGoalSubmissionEnvelope, closeSlashMenu, contextMentions, currentWorkspace, draftInput, isGameStudioMode, isStreaming, language, lockedComposerIntent, markStudioOnboardingUsed, onSendMessage, pendingImages, queueUserMessage, selectedMainModeKey, setAttachedFiles, setContextMentions, setLockedComposerIntent, setStoreInput]);

  const handleGuideQueuedMessage = useCallback(() => {
    const guidance = queuedUserMessage?.text?.trim() || "";
    if (!guidance) return;

    // A queued Goal continuation is a pending run-lease handoff, not ordinary
    // guidance for whichever run happens to be streaming. Never downgrade it
    // into `activeGuidance`, which would inject it into a foreign run.
    if (queuedUserMessage?.goalContinuationAuthorization) {
      clearQueuedUserMessage({
        expectedId: queuedUserMessage.id,
        disposition: "discarded",
        reason: "goal_continuation_cannot_guide_foreign_run",
      });
      closeSlashMenu();
      setStoreInput("");
      return;
    }

    const appState = useAppStore.getState();
    if (appState.agentStatus === "pending_review") {
      appState.abortController?.abort();
      useAppStore.setState({
        agentStatus: "idle",
        isGenerating: false,
        abortController: null,
        isPlanApproved: false,
        planApprovalChoice: null,
        planExecutionEvidenceLedger: [],
        planExecutionEvidenceCount: 0,
        planAutoResumeCount: 0,
        planExecutionProgressSnapshot: null,
      });
    }

    if (isStreaming) {
      setActiveGuidance(guidance, currentTurnId);
      clearQueuedUserMessage({
        expectedId: queuedUserMessage.id,
        disposition: "consumed",
        reason: "moved_to_active_guidance",
      });
      closeSlashMenu();
      setStoreInput("");
    } else {
      closeSlashMenu();
      onSendMessage(guidance, queuedUserMessage.images || [], {
        queuedUserMessageId: queuedUserMessage.id,
      });
    }
  }, [clearQueuedUserMessage, closeSlashMenu, currentTurnId, isStreaming, queuedUserMessage, setActiveGuidance, setStoreInput, onSendMessage]);

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
    const textBeforeCursor = value.slice(0, cursorPos);
    const slashSession = getSlashSession(value, cursorPos);

    if (isMainMode && parseMainDebugShortcut(value)) {
      slashAnchorRef.current = -1;
      closeSlashMenu();
    } else if (!isImageStudioMode && (isGameStudioMode || isMainMode) && slashSession) {
      slashAnchorRef.current = slashSession.anchor;
      setSlashQuery(slashSession.query);
      setShowSlashMenu(true);
    } else if (showSlashMenu) {
      closeSlashMenu();
    }

    // Find the last @ before cursor
    const lastAtIndex = isImageStudioMode ? -1 : textBeforeCursor.lastIndexOf("@");
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
    if (
      !isImageStudioMode &&
      (isMainMode || isGameStudioMode) &&
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
          if (isMainMode || slashItem?.kind === "main_intent") {
            handleSelectMainIntentShortcut(slashItem);
          } else {
            handleSelectSlashItem(slashItem);
          }
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
    if (e.key === "Enter" && !e.shiftKey && !e.altKey && !showMentionMenu && !showSlashMenu) {
      e.preventDefault();
      handleSubmitComposerMessage();
    }
  };

  // ── Helper: extract display name from path ──
  const displayName = (path: any) => normalizeAttachedFile(path).displayName || String(path).split("/").pop() || String(path);
  const composerPlaceholder = activeDiffTask
    ? "..."
    : isImageStudioMode
    ? (language === "en" ? "Describe the image you want to generate..." : "描述你想生成的图片...")
    : isGameStudioMode
    ? (language === "en" ? "Ask the studio, or type / for plan, workflows, and specialists..." : "询问工作室中枢，或输入 / 打开计划入口、工作流和专家面板...")
    : language === "en"
    ? "Describe what you need, or type / for planning and output styles..."
    : "输入需求，或输入 / 选择计划入口、分析、总结、报告...";

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
        {false && showExecutionProgress && (
          <ExecutionProgressCard
            tasks={planTasks}
            stage={planStage === "completed" ? "completed" : planStage === "ready_to_execute" ? "ready" : "executing"}
          />
        )}

        {/* Action Diff Card */}
        {false && activeDiffTask && (
          <div className="bg-[#09090b] border border-[#27272a] border-b-0 rounded-t-xl p-3.5 flex flex-col gap-3 z-10 relative">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-[12px] font-semibold text-[#a1a1aa] uppercase tracking-wider pl-1"><IconChevronUpIcon className="w-4 h-4" /> Edited 1 File</div>
              <div className="flex items-center gap-3">
                <button onClick={() => handleRejectInline(activeDiffTask.id)} className="text-[#f48771] text-[12px] font-semibold hover:text-red-400 transition-colors px-2 py-1">{t.reject}</button>
                <button onClick={() => handleAcceptInline(activeDiffTask.id)} className="theme-bg theme-bg-hover text-[12px] font-bold px-4 py-1.5 rounded-md shadow-sm transition-colors">{t.accept}</button>
              </div>
            </div>
            <div className="flex items-center gap-2 pl-1 mb-1">
              <div className="bg-[#000000] border border-[#27272a] rounded-full w-6 h-6 flex items-center justify-center text-[#a1a1aa]"><IconAt className="w-3.5 h-3.5" /></div>
              <button onClick={() => setShowDiff(true)} className="bg-[#000000] border border-[#27272a] text-[#e4e4e7] text-[12px] px-3 py-1 rounded-full flex items-center gap-1.5 hover:bg-[#18181b] transition-colors font-mono"><IconCode className="w-3.5 h-3.5" /> {activeDiffTask.target}</button>
            </div>
            {/* Auto-approve toggle */}
            {onToggleAutoApprove && (
              <div className="pt-2 border-t border-[#27272a] flex items-center gap-2 pl-1">
                <label className="flex items-center gap-2 cursor-pointer select-none group">
                  <input
                    type="checkbox"
                    checked={!!autoApproveTools}
                    onChange={(e) => onToggleAutoApprove(e.target.checked)}
                    className="w-3.5 h-3.5 rounded border-[#3f3f46] bg-[#000000] accent-[var(--accent)] cursor-pointer"
                  />
                  <span className="text-[11px] text-[#71717a] group-hover:text-[#a1a1aa] transition-colors">
                    本次会话内自动允许后续所有命令 (Auto-approve all)
                  </span>
                </label>
              </div>
            )}
          </div>
        )}

        {showStudioOnboarding && (
          <GameStudioOnboardingPanel
            language={language}
            isLightTheme={isLightTheme}
            initialized={gameStudioInitialized}
            onDismiss={markStudioOnboardingDismissed}
            onAction={handleStudioOnboardingAction}
            onRemove={handleRemoveGameStudioWorkspace}
          />
        )}

        {suggestedComposerIntent && suggestedComposerIntentLabel && !isImageStudioMode && !activeDiffTask && !isStreaming && (
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

        <div className={`bg-[#09090b] border border-[#27272a] transition-all flex flex-col relative z-20 ${activeDiffTask ? 'rounded-b-xl border-t-0' : 'rounded-xl'} ${isStreaming ? 'border-[#3f3f46]' : 'focus-within:border-[#3f3f46]'}`} style={isImageStudioMode ? imageStudioPanelStyle : undefined}>

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

          {isImageStudioMode && (
            <div data-testid="image-studio-controls" className="border-b px-3 py-3" style={{ borderColor: isLightTheme ? "#e4e4e7" : "#27272a" }}>
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-2">
                  <div className="flex h-8 w-8 items-center justify-center rounded-lg border border-[var(--accent-subtle-border)] bg-[var(--accent-subtle)] text-[var(--accent-light)]">
                    <IconImageIcon className="h-3.5 w-3.5" />
                  </div>
                  <div className="min-w-0">
                    <div className="text-[12px] font-semibold" style={{ color: isLightTheme ? "#18181b" : "#f4f4f5" }}>
                      {language === "en" ? "Image Studio" : "图像工作室"}
                    </div>
                    <div className="truncate text-[10px]" style={imageStudioMutedStyle}>
                      {imageStudioProviderLabel} · {imageStudioProviderDetail}
                    </div>
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={handleCheckImageStudioEngine}
                    className="inline-flex h-7 items-center gap-1.5 rounded-md border px-2.5 text-[10px] transition-colors hover:bg-[#18181b]"
                    style={{ borderColor: isLightTheme ? "#d4d4d8" : "#27272a", color: isLightTheme ? "#374151" : "#d4d4d8" }}
                    title={language === "en" ? "Check image provider" : "检测图片 provider"}
                  >
                    <span className={`h-1.5 w-1.5 rounded-full ${imageStudioStatusDotClass}`} />
                    {imageStudioStatusLabel}
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowImageStudioAdvanced((value) => !value)}
                    className="inline-flex h-7 items-center gap-1.5 rounded-md border px-2.5 text-[10px] transition-colors hover:bg-[#18181b]"
                    style={{ borderColor: isLightTheme ? "#d4d4d8" : "#27272a", color: isLightTheme ? "#374151" : "#d4d4d8" }}
                  >
                    <IconZap className="h-3.5 w-3.5" />
                    {language === "en" ? (showImageStudioAdvanced ? "Hide Advanced" : "Advanced") : (showImageStudioAdvanced ? "收起高级项" : "高级项")}
                  </button>
                  <button
                    type="button"
                    onClick={() => setImageStudioSetupGuideOpen(true)}
                    className="inline-flex h-7 items-center gap-1.5 rounded-md border border-[var(--accent-subtle-border)] px-2.5 text-[10px] font-semibold text-[var(--accent-light)] transition-colors hover:bg-[var(--accent-subtle)]"
                    title={language === "en" ? "Image Studio setup" : "图像工作室设置"}
                  >
                    <IconSettings className="h-3.5 w-3.5" />
                    {language === "en" ? "Setup" : "设置"}
                  </button>
                </div>
              </div>

              {isLocalActiveModelTextLLM && (
                <div className="mb-3 rounded-lg border border-[rgba(250,204,21,0.24)] bg-[rgba(250,204,21,0.08)] px-3 py-2 text-[11px] leading-relaxed text-[#facc15]">
                  {language === "en"
                    ? "⚠️ The current local model may be a text model instead of an image generation model. Please ensure your service supports image generation."
                    : "⚠️ 当前本地模型可能是文本模型而非生图模型，请确保您的服务支持生图计算。"}
                </div>
              )}

              <div className="grid gap-3 md:grid-cols-[minmax(220px,1.25fr)_minmax(170px,0.75fr)]">
                <div>
                  <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.14em]" style={imageStudioMutedStyle}>
                    {language === "en" ? "Aspect" : "比例"}
                  </div>
                  <div className="grid grid-cols-4 gap-1 sm:grid-cols-6">
                    {imageStudioAspectOptions.map((ratio) => (
                      <button
                        key={ratio}
                        type="button"
                        onClick={() => setImageStudioConfig({ aspectRatio: ratio })}
                        className="h-7 rounded-md border text-[10px] font-semibold transition-colors"
                        style={{
                          borderColor: imageStudio.config.aspectRatio === ratio ? "var(--accent)" : (isLightTheme ? "#d4d4d8" : "#27272a"),
                          backgroundColor: imageStudio.config.aspectRatio === ratio ? "var(--accent-subtle)" : (isLightTheme ? "#f8fafc" : "#050507"),
                          color: imageStudio.config.aspectRatio === ratio ? (isLightTheme ? "var(--accent-hover)" : "var(--accent-light)") : (isLightTheme ? "#374151" : "#a1a1aa"),
                        }}
                      >
                        {ratio}
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.14em]" style={imageStudioMutedStyle}>Seed</div>
                  <div className="grid grid-cols-[auto_1fr] gap-1">
                    <button
                      type="button"
                      onClick={() => setImageStudioConfig({ seedMode: imageStudio.config.seedMode === "fixed" ? "random" : "fixed" })}
                      className="h-8 rounded-md border px-2 text-[10px] font-semibold transition-colors"
                      style={{
                        borderColor: imageStudio.config.seedMode === "fixed" ? "var(--accent)" : (isLightTheme ? "#d4d4d8" : "#27272a"),
                        backgroundColor: imageStudio.config.seedMode === "fixed" ? "var(--accent-subtle)" : (isLightTheme ? "#f8fafc" : "#050507"),
                        color: imageStudio.config.seedMode === "fixed" ? (isLightTheme ? "var(--accent-hover)" : "var(--accent-light)") : (isLightTheme ? "#374151" : "#a1a1aa"),
                      }}
                    >
                      {imageStudio.config.seedMode === "fixed" ? (language === "en" ? "Fixed" : "固定") : (language === "en" ? "Random" : "随机")}
                    </button>
                    <input
                      type="number"
                      min="0"
                      max="2147483647"
                      value={imageStudio.config.seed}
                      disabled={imageStudio.config.seedMode !== "fixed"}
                      onChange={(event) => setImageStudioConfig({ seed: Number(event.target.value) })}
                      className="h-8 min-w-0 rounded-md border px-2 text-[11px] outline-none disabled:opacity-45"
                      style={imageStudioFieldStyle}
                    />
                  </div>
                </div>
              </div>

              <div className="mt-3 flex flex-wrap gap-2 text-[10px]" style={imageStudioMutedStyle}>
                <span className="rounded-md border px-2 py-1" style={{ borderColor: isLightTheme ? "#d4d4d8" : "#27272a" }}>
                  {isWebFallbackImageEngine ? "HiDream Web" : (language === "en" ? "Local Service" : "本地服务")}
                </span>
                <span className="rounded-md border px-2 py-1" style={{ borderColor: isLightTheme ? "#d4d4d8" : "#27272a" }}>
                  {imageStudio.status.activeModel || imageStudio.config.local.model || (language === "en" ? "Prompt-first" : "Prompt 优先")}
                </span>
                <span className="rounded-md border px-2 py-1" style={{ borderColor: isLightTheme ? "#d4d4d8" : "#27272a" }}>
                  {imageStudioSupportsReferenceImages
                    ? (language === "en" ? "Ref images on" : "参考图已开启")
                    : (language === "en" ? "Prompt only" : "仅文本生图")}
                </span>
              </div>

              {showImageStudioAdvanced && (
                <div className="mt-3 grid gap-3 rounded-xl border p-3 md:grid-cols-2" style={{ borderColor: isLightTheme ? "#d4d4d8" : "#27272a", backgroundColor: isLightTheme ? "#f8fafc" : "#050507" }}>
                  {isWebFallbackImageEngine ? (
                    <button
                      type="button"
                      onClick={() => setImageStudioConfig({
                        web: {
                          ...imageStudio.config.web,
                          promptRefine: !imageStudio.config.web.promptRefine,
                        },
                      })}
                      className="rounded-lg border px-3 py-3 text-left transition-colors"
                      style={{
                        borderColor: imageStudio.config.web.promptRefine ? "var(--accent)" : (isLightTheme ? "#d4d4d8" : "#27272a"),
                        backgroundColor: imageStudio.config.web.promptRefine ? "var(--accent-subtle)" : "transparent",
                      }}
                    >
                      <div className="text-[11px] font-semibold" style={{ color: isLightTheme ? "#18181b" : "#f4f4f5" }}>HiDream Web</div>
                      <div className="mt-1 text-[10px]" style={imageStudioMutedStyle}>
                        {language === "en"
                          ? `Prompt refine ${imageStudio.config.web.promptRefine ? "enabled" : "disabled"}`
                          : `提示词润色${imageStudio.config.web.promptRefine ? "已开启" : "已关闭"}`}
                      </div>
                    </button>
                  ) : (
                    <>
                      <label className="min-w-0">
                        <span className="mb-1 block text-[10px] font-semibold uppercase tracking-[0.14em]" style={imageStudioMutedStyle}>
                          {language === "en" ? "Steps" : "步数"} · {imageStudio.config.steps}
                        </span>
                        <input
                          type="range"
                          min="1"
                          max="80"
                          step="1"
                          value={imageStudio.config.steps}
                          onChange={(event) => setImageStudioConfig({ steps: Number(event.target.value) })}
                          className="w-full accent-[var(--accent)]"
                        />
                      </label>
                      {!isLocalActiveModelFlux && (
                        <label className="min-w-0">
                          <span className="mb-1 block text-[10px] font-semibold uppercase tracking-[0.14em]" style={imageStudioMutedStyle}>
                            CFG · {imageStudio.config.guidanceScale}
                          </span>
                          <input
                            type="range"
                            min="0"
                            max="20"
                            step="0.5"
                            value={imageStudio.config.guidanceScale}
                            onChange={(event) => setImageStudioConfig({ guidanceScale: Number(event.target.value) })}
                            className="w-full accent-[var(--accent)]"
                          />
                        </label>
                      )}
                    </>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Attached files tags */}
          {!isImageStudioMode && attachedFiles.length > 0 && (
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
          {!isImageStudioMode && contextMentions.length > 0 && (
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

          <div className="relative">
            <textarea
              ref={handleTextareaRef}
              data-testid="composer-textarea"
              className="max-h-[36vh] min-h-[3.5rem] w-full bg-transparent border-none outline-none resize-none overflow-hidden text-[#e4e4e7] p-4 text-[13px] leading-relaxed placeholder:text-[#a1a1aa]"
              style={{ fontSize: `${resolvedComposerFontSize}px` }}
              rows={activeDiffTask ? 1 : 2}
              placeholder={composerPlaceholder}
              value={draftInput}
              onChange={handleInputChange}
              onKeyDown={handleKeyDown}
              onCompositionStart={() => {
                isComposingRef.current = true;
              }}
              onCompositionEnd={() => {
                isComposingRef.current = false;
                compositionEndedAtRef.current = Date.now();
              }}
              onPaste={handlePaste}
            />

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

            {showSlashMenu && isMainMode && (
              <div
                ref={slashMenuRef}
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
                  {filteredSlashItems.length === 0 ? (
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
                          const index = visibleMainIntentSlashItems.findIndex((candidate) => candidate.intent === item.intent);
                          const isActive = index === highlightedSlashIndex;
                          return (
                            <button
                              key={item.intent}
                              data-testid={`main-shortcut-item-${item.intent}`}
                              onClick={() => handleSelectMainIntentShortcut(item)}
                              className="w-full rounded-md px-3 py-2 text-left transition-colors"
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
                                  {item.command}
                                </div>
                                <div className={`mt-0.5 text-[11px] leading-snug ${isLightTheme ? "text-[#52525b]" : "text-[#a1a1aa]"}`}>
                                  {item.description}
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

            {showSlashMenu && isGameStudioMode && (
              <GameStudioSlashMenu
                menuRef={slashMenuRef}
                searchLabel={slashSearchLabel}
                commandLabel={slashCommandLabel}
                emptyLabel={slashEmptyLabel}
                hint={slashHint}
                navigationHint={mentionHintUpDown}
                selectHint={mentionHintEnter}
                closeHint={mentionHintEsc}
                planKindLabel={planKindLabel}
                workflowKindLabel={workflowKindLabel}
                agentKindLabel={agentKindLabel}
                highlightedIndex={highlightedSlashIndex}
                sections={groupedSlashItems}
                onSelect={(item) => (
                  item.kind === "main_intent"
                    ? handleSelectMainIntentShortcut(item)
                    : handleSelectSlashItem(item)
                )}
              />
            )}
          </div>

          {!isImageStudioMode && (queuedUserMessage || activeGuidance) && (
            <div className="border-t border-[#27272a] bg-[#070709] px-3 py-2">
              {queuedUserMessage && (
                <div
                  data-testid="composer-queued-message"
                  className="flex min-h-9 items-center gap-2 rounded-md border border-[rgba(96,165,250,0.24)] bg-[rgba(37,99,235,0.08)] px-3 py-2 text-[11px] text-[#dbeafe] shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]"
                >
                  <div className="min-w-0 flex-1">
                    <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[#93c5fd]">{queuedStatusLabel}</div>
                    <div className="mt-0.5 truncate text-[12px] leading-snug text-[#e0f2fe]">{queuedMessagePreview}</div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <button
                      type="button"
                      data-testid="composer-guidance-button"
                      onClick={handleGuideQueuedMessage}
                      disabled={!queuedCanGuide}
                      className="inline-flex h-7 items-center gap-1.5 rounded-md border border-[rgba(52,211,153,0.30)] bg-[rgba(16,185,129,0.10)] px-2.5 text-[11px] font-semibold text-[#bbf7d0] transition-colors hover:bg-[rgba(16,185,129,0.18)] disabled:cursor-not-allowed disabled:opacity-45"
                      title={queuedIsGoalContinuation
                        ? (language === "en"
                            ? "Goal continuation is reserved for its own run and cannot guide the current run."
                            : "Goal 续跑指令只能启动所属运行，不能注入当前运行。")
                        : guidanceButtonTitle}
                    >
                      <IconZap className="h-3.5 w-3.5" />
                      {guidanceButtonLabel}
                    </button>
                    <button
                      type="button"
                      data-testid="composer-queued-delete-button"
                      onClick={() => clearQueuedUserMessage({
                        expectedId: queuedUserMessage.id,
                        disposition: "discarded",
                        reason: "user_deleted_queue_entry",
                      })}
                      className="flex h-7 w-7 items-center justify-center rounded-md border border-[#34343b] bg-[#050507] text-[#a1a1aa] transition-colors hover:border-[#52525b] hover:text-white"
                      title={language === "en" ? "Delete queued message" : "删除这条排队指令"}
                    >
                      <IconTrash className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              )}
              {activeGuidance && (
                <div
                  data-testid="composer-active-guidance"
                  className={`${queuedUserMessage ? "mt-2" : ""} flex min-h-9 items-center gap-2 rounded-md border border-[rgba(52,211,153,0.24)] bg-[rgba(16,185,129,0.08)] px-3 py-2 text-[11px] text-[#bbf7d0] shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]`}
                >
                  <div className="min-w-0 flex-1">
                    <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[#86efac]">{guidanceStatusLabel}</div>
                    <div className="mt-0.5 truncate text-[12px] leading-snug text-[#dcfce7]">{activeGuidancePreview}</div>
                  </div>
                  <button
                    type="button"
                    onClick={clearActiveGuidance}
                    className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-[#34343b] bg-[#050507] text-[#a1a1aa] transition-colors hover:border-[#52525b] hover:text-white"
                    title={language === "en" ? "Undo guidance" : "撤销引导"}
                  >
                    <IconTrash className="h-3.5 w-3.5" />
                  </button>
                </div>
              )}
            </div>
          )}

          <div className="flex items-center justify-between gap-3 px-3 py-2.5 bg-[#09090b] rounded-b-xl border-t border-[#27272a]">
            <div className="relative flex min-w-0 flex-wrap items-center gap-2">

              {/* Context Usage Indicator */}
              <div className="flex items-center gap-1.5 text-[#71717a] font-mono text-[11px] font-semibold select-none">
                {isImageStudioMode ? (
                  <div className="flex items-center gap-1.5 ml-0.5" title={language === "en" ? "Image Studio bypasses LLM context and tool execution" : "图像工作室不占用 LLM 上下文，也不进入工具执行"}>
                    <IconZap className="h-3.5 w-3.5 text-[var(--accent-light)]" />
                    <span>{isWebFallbackImageEngine ? "HiDream Web" : `${imageStudio.config.steps} steps`}</span>
                  </div>
                ) : activeProfile === "cloud" ? (
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

              {/* MAIN mode switcher */}
              <MainModeSwitcher
                pickerRef={mainFocusPickerRef}
                isOpen={showAgentPicker}
                selectedModeKey={selectedMainModeKey}
                modeKeys={mainModes}
                modeLabels={t}
                modeDescriptions={mainModeDescriptions}
                switchLabel={t.switchMainMode}
                themeMode={themeMode}
                onOpenChange={setShowAgentPicker}
                onSelect={switchMainModeWithIsolation}
              />

              <div className="composer-toolbar-divider h-4 w-px mx-1"></div>

              {isGameStudioMode && (
                <>
                  <button
                    onClick={handleStudioCommandButtonClick}
                    data-testid="game-studio-command-button"
                    className="bg-[#000000] border border-[rgba(34,197,94,0.28)] text-[#e4e4e7] text-[11px] font-bold px-2.5 py-1.5 rounded-md flex shrink-0 items-center justify-center gap-1.5 hover:bg-[#18181b] transition-colors"
                    title={language === "en" ? "Open Game Studio command hub" : "打开 Game Studio 命令中枢"}
                  >
                    <IconCode className="w-3.5 h-3.5 text-[#86efac]" />
                    <span>/</span>
                  </button>
                  {activeStudioAgentKey !== "studio_auto" ? (
                    <button
                      onClick={handleClearStudioAgent}
                      className="bg-[#000000] border border-[rgba(34,197,94,0.22)] text-[#d1fae5] text-[11px] px-2.5 py-1.5 rounded-full flex items-center gap-1.5 hover:bg-[#18181b] transition-colors"
                      title={language === "en" ? "Clear specialist and return to auto orchestration" : "清除当前专家，回到自动编排"}
                    >
                      <span className="max-w-[130px] truncate">{humanizeSlug(activeStudioAgentKey)}</span>
                      <span className="text-[#86efac]">×</span>
                    </button>
                  ) : (
                    <div className="bg-[#000000] border border-[#27272a] text-[#71717a] text-[11px] px-2.5 py-1.5 rounded-full">
                      {studioAutoLabel}
                    </div>
                  )}
                  <div className="composer-toolbar-divider h-4 w-px mx-1"></div>
                </>
              )}

              {/* @ Mention button — inserts @ and opens the same menu */}
              {!isImageStudioMode && (
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
                        <button
                          type="button"
                          onClick={() => {
                            setWebSearchEnabled(false);
                            setShowWebSearchPanel(false);
                          }}
                          className={`w-full border-t px-3 py-2 text-left text-[12px] transition-colors ${
                            isLightTheme
                              ? "border-[#e4e4e7] text-[#71717a] hover:bg-[#f4f4f5]"
                              : "border-[#27272a] text-[#a1a1aa] hover:bg-[#27272a]"
                          }`}
                        >
                          {language === "en" ? "Turn off web search" : "关闭网络搜索"}
                        </button>
                      </div>
                    )}
                  </div>
                </>
              )}
              {!isImageStudioMode && onTogglePreferSubagents && (
                <button
                  type="button"
                  data-testid="composer-subagent-preference-toggle"
                  onClick={handleToggleSubagentPreference}
                  disabled={subagentPreferenceToggleDisabled}
                  className={`panel-tab-icon-button flex h-7 w-7 shrink-0 items-center justify-center rounded-[7px] p-0 transition-all duration-150 disabled:cursor-not-allowed disabled:opacity-70 ${preferSubagents ? "is-active" : ""}`}
                  title={subagentPreferenceButtonTitle}
                  aria-label={language === "en" ? "Prefer subagent collaboration" : "偏好子智能体协作"}
                  aria-pressed={!!preferSubagents}
                >
                  <IconSubagent className="h-4 w-4" />
                </button>
              )}
              {!isImageStudioMode && onToggleAutoApprove && (
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
              {isImageStudioMode && imageStudioSupportsReferenceImages && (
                <button
                  onClick={handleAttachButtonClick}
                  className="panel-tab-icon-button flex h-7 w-7 shrink-0 items-center justify-center rounded-[7px] p-0 transition-all duration-150"
                  title={language === "en" ? "Add reference image" : "添加参考图"}
                >
                  <IconImageIcon className="w-3.5 h-3.5" />
                </button>
              )}
            </div>

            <div className="flex items-center gap-2">
              {lockedComposerIntentLabel && !isImageStudioMode && !activeDiffTask && !isStreaming && (
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
                isStreaming ? (
                  <button
                    data-testid={streamingPrimaryQueuesMessage ? "composer-send-button" : "composer-stop-button"}
                    disabled={streamingPrimaryQueuesMessage ? (isSubmitPending || cooldownSec > 0) : false}
                    onClick={streamingPrimaryQueuesMessage ? handleSubmitComposerMessage : onStopGeneration}
                    className={`flex h-8 w-8 items-center justify-center rounded-md border shadow-sm transition-colors disabled:opacity-50 ${
                      streamingPrimaryQueuesMessage
                        ? "border-[#27272a] bg-[#09090b] text-[#d4d4d8] hover:bg-white hover:text-black"
                        : "border-[#7f1d1d] bg-[#09090b] text-[#f48771] hover:bg-[#7f1d1d] hover:text-white"
                    }`}
                    title={streamingPrimaryQueuesMessage ? queueButtonTitle : (language === "en" ? "Stop current run" : "停止当前执行")}
                  >
                    {streamingPrimaryQueuesMessage ? <IconArrowUp className="w-4 h-4" /> : <IconStop className="w-4 h-4" />}
                  </button>
                ) : (
                  <button
                    data-testid="composer-send-button"
                    disabled={isComposerSubmitting || cooldownSec > 0 || (!draftInput.trim() && contextMentions.length === 0 && attachedFiles.length === 0 && pendingImages.length === 0)}
                    onClick={handleSubmitComposerMessage}
                    className="bg-[#09090b] border border-[#27272a] text-[#a1a1aa] hover:bg-white hover:text-black w-8 h-8 flex items-center justify-center rounded-md transition-colors disabled:opacity-50 shadow-sm"
                  >
                    {cooldownSec > 0 ? (
                      <span className="text-[10px] font-semibold text-amber-500 tabular-nums">{cooldownSec}s</span>
                    ) : (
                      <IconArrowUp className="w-4 h-4" />
                    )}
                  </button>
                )
              )}
            </div>
          </div>
        </div>
        </div>
      </div>
      <ImageStudioSetupModal />
    </>
  );
}
