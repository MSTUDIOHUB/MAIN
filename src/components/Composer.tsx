// @ts-nocheck
import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { IconAt, IconFile, IconClose, IconChevronUp, IconArrowUp, IconPlus, IconCode, IconChevronUp as IconChevronUpIcon, IconSearch, IconStop } from "./Icons";
import { getAllWorkspaceFiles, fuzzyFilterFiles } from "../utils/fsUtils";
import { getImageFilesFromClipboard, getImageFilesFromDrop, processImageFile } from "../utils/imageUtils";
import { estimateTokens } from "../lib/contextTrim";
import { useAppStore } from "../store/useAppStore";
import type { AgentMessage, ContentPart } from "../lib/orchestrator";
import { getGameStudioSlashCatalog } from "../lib/gameStudioPack";
import { humanizeSlug } from "../lib/gameStudioCatalog";
import { resolveTurnRunIntent } from "../lib/runIntent";
import {
  resolveGameStudioOnboardingAction,
  shouldShowGameStudioOnboarding,
} from "../lib/gameStudioOnboarding";

// ── ContextRing SVG Component ──────────────────────────────────────────

function ContextRing({ percentage }: { percentage: number }) {
  const r = 6;
  const circumference = 2 * Math.PI * r;
  const offset = circumference * (1 - Math.min(percentage, 100) / 100);

  let stroke = "#71717a";
  if (percentage > 90) stroke = "#ef4444";
  else if (percentage >= 75) stroke = "#eab308";

  return (
    <svg viewBox="0 0 16 16" className="w-3.5 h-3.5">
      <circle cx="8" cy="8" r={r} stroke="#27272a" strokeWidth="2" fill="none" />
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
  for (const msg of messages) {
    if (typeof msg.content === "string") {
      total += estimateTokens(msg.content);
    } else if (Array.isArray(msg.content)) {
      for (const part of msg.content as ContentPart[]) {
        if (part.type === "text") total += estimateTokens(part.text);
        else if (part.type === "image_url") total += 1000;
      }
    }
    if (msg.tool_calls) total += estimateTokens(JSON.stringify(msg.tool_calls));
    total += 10; // role + formatting overhead
  }
  return total;
}

function ExecutionProgressCard({
  tasks,
  stage,
}: {
  tasks: Array<{ id: string; text: string; status: "pending" | "in_progress" | "completed" }>;
  stage: "ready" | "executing" | "completed";
}) {
  const completedCount = tasks.filter((task) => task.status === "completed").length;

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
              task.status === "completed"
                ? "text-[#f5f5f5]"
                : task.status === "in_progress"
                ? "text-[#facc15]"
                : "text-[#e4e4e7]";

            const marker =
              task.status === "completed"
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
  input,
  setInput,
  contextMentions,
  setContextMentions,
  attachedFiles,
  setAttachedFiles,
  onAttachFile,
  showAgentPicker,
  setShowAgentPicker,
  selectedMainModeKey,
  setSelectedMainModeKey,
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
  onToggleAutoApprove
}) {
  // ── Mention (file search) state ──
  const [showMentionMenu, setShowMentionMenu] = useState(false);
  const [mentionQuery, setMentionQuery] = useState("");
  const [mentionResults, setMentionResults] = useState<string[]>([]);
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const [showSlashMenu, setShowSlashMenu] = useState(false);
  const [slashQuery, setSlashQuery] = useState("");
  const [highlightedSlashIndex, setHighlightedSlashIndex] = useState(0);
  const [hoveredMainFocusModeKey, setHoveredMainFocusModeKey] = useState<string | null>(null);
  const [allFiles, setAllFiles] = useState<string[]>([]);
  const [isFilesLoading, setIsFilesLoading] = useState(false);
  const [dismissedStudioOnboardingByWorkspace, setDismissedStudioOnboardingByWorkspace] = useState<Record<string, boolean>>({});
  const [usedStudioOnboardingByWorkspace, setUsedStudioOnboardingByWorkspace] = useState<Record<string, boolean>>({});
  const [forceVisibleStudioOnboardingByWorkspace, setForceVisibleStudioOnboardingByWorkspace] = useState<Record<string, boolean>>({});
  const [isSubmitPending, setIsSubmitPending] = useState(false);

  // Tracks the position of the @ that triggered the current mention session
  const mentionAnchorRef = useRef(-1);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const mentionDropRef = useRef<HTMLDivElement>(null);
  const slashMenuRef = useRef<HTMLDivElement>(null);
  const previousMainModeRef = useRef(selectedMainModeKey);
  const previousWorkspaceRef = useRef(currentWorkspace);
  const submitUnlockTimerRef = useRef<number | null>(null);
  const submitPendingRef = useRef(false);

  // ── Image paste/drop state (local to avoid large base64 in global store) ──
  const [pendingImages, setPendingImages] = useState<string[]>([]);
  const [isDragOver, setIsDragOver] = useState(false);

  // ── Context usage estimation ──
  const agentMessages = useAppStore((s) => s.agentMessages);
  const activeProfile = useAppStore((s) => s.config.activeProfile);
  const themeMode = useAppStore((s) => s.config.themeMode);
  const contextLimit = useAppStore((s) => s.config.local.contextLimit);
  const language = useAppStore((s) => s.config.language);
  const workspaceContentVersion = useAppStore((s) => s.workspaceContentVersion);
  const isPlanApproved = useAppStore((s) => s.isPlanApproved);
  const planTasks = useAppStore((s) => s.planTasks);
  const planStage = useAppStore((s) => s.planStage);
  const conversationTurns = useAppStore((s) => s.conversationTurns);
  const [debouncedInput, setDebouncedInput] = useState(input);
  const slashCatalog = useMemo(
    () => getGameStudioSlashCatalog(language === "en" ? "en" : "zh"),
    [language],
  );
  const isGameStudioMode = selectedMainModeKey === "game_studio";
  const isLightTheme = themeMode === "light";
  const isComposerSubmitting = isStreaming || isSubmitPending;
  const showExecutionProgress =
    planTasks.length > 0 &&
    (planStage === "ready_to_execute" || planStage === "executing" || planStage === "completed" || isPlanApproved);
  const slashCommandLabel = language === "en" ? "Studio Commands" : "Studio 命令";
  const slashSearchLabel = slashQuery
    ? (language === "en" ? `Command: ${slashQuery}` : `命令：${slashQuery}`)
    : (language === "en" ? "Type / to search commands and agents" : "输入 / 搜索工作流命令和专业 Agent");
  const slashEmptyLabel = language === "en" ? "No matching commands or agents" : "没有匹配的命令或 Agent";
  const slashHint = language === "en" ? "Select to insert canonical command" : "选择后会插入标准命令";
  const studioWorkflowHeading = language === "en" ? "Workflow Commands" : "工作流命令";
  const studioAgentHeading = language === "en" ? "Specialist Agents" : "专业 Agent";
  const workflowKindLabel = language === "en" ? "workflow" : "工作流";
  const agentKindLabel = language === "en" ? "agent" : "专家";
  const studioInitLabel = language === "en" ? "Initialize Game Studio" : "初始化 Game Studio";
  const studioStartLabel = language === "en" ? "Start /start" : "开始 /start 引导";
  const studioBrainstormLabel = language === "en" ? "Brainstorm Game" : "头脑风暴新游戏";
  const studioSetupEngineLabel = language === "en" ? "Set Up Engine" : "设置引擎";
  const studioAutoLabel = language === "en" ? "Auto Routing" : "自动专家路由";
  const mainModeDescriptions = {
    main_mode: language === "en"
      ? "Ask naturally for summaries, analysis, reports, extraction, plans, or execution in one place."
      : "直接用自然语言提出总结、分析、报告、提炼、计划或执行需求。",
    game_studio: language === "en"
      ? "Run MAIN GAME STUDIO workflows, slash commands, and specialist studio agents."
      : "运行 MAIN GAME STUDIO 工作流、slash 命令和专业工作室 Agent。",
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
  const nonPackFiles = useMemo(
    () => allFiles.filter((path) => !path.startsWith(".MAIN/") && !path.startsWith(".protocols/")),
    [allFiles],
  );
  const currentWorkspaceOnboardingKey = currentWorkspace || "__no_workspace__";
  const composerIntentBadge = useMemo(() => {
    const normalizedInput = input.trim();
    if (!normalizedInput) return null;

    if (isGameStudioMode && normalizedInput.startsWith("/")) {
      return language === "en" ? "Game Studio Command" : "Game Studio 指令";
    }

    const resolution = resolveTurnRunIntent(input, {
      language: language === "en" ? "en" : "zh",
      mainModeKey: selectedMainModeKey,
      parsedStudioCommand: null,
      hasPlanArtifacts: planTasks.length > 0 || planStage !== "idle",
      planStage,
      isPlanApproved,
    });

    if (resolution.needsDecision || resolution.confidence < 0.9) return null;

    if (resolution.intent === "plan") {
      return language === "en" ? "Planning" : "计划模式";
    }
    if (resolution.intent === "summarize") {
      return language === "en" ? "Summary" : "总结模式";
    }
    if (resolution.intent === "report") {
      return language === "en" ? "Report" : "报告模式";
    }

    return null;
  }, [input, isGameStudioMode, isPlanApproved, language, planStage, planTasks.length, selectedMainModeKey]);
  const showStudioOnboarding = shouldShowGameStudioOnboarding({
    isGameStudioMode,
    hasWorkspace: Boolean(currentWorkspace),
    gameStudioInitialized,
    nonPackFileCount: nonPackFiles.length,
    input,
    hasConversationHistory: conversationTurns.length > 0,
    showSlashMenu,
    dismissed: Boolean(dismissedStudioOnboardingByWorkspace[currentWorkspaceOnboardingKey]),
    used: Boolean(usedStudioOnboardingByWorkspace[currentWorkspaceOnboardingKey]),
    forceVisible: Boolean(forceVisibleStudioOnboardingByWorkspace[currentWorkspaceOnboardingKey]),
  });
  const studioOnboardingShellClass = "border shadow-[0_18px_50px_rgba(0,0,0,0.14)]";
  const studioOnboardingShellStyle = isLightTheme
    ? {
        borderColor: "var(--accent-subtle-border)",
        background: "radial-gradient(circle at top right, var(--accent-subtle), transparent 58%), linear-gradient(135deg, rgba(255,255,255,0.98), rgba(248,250,252,0.98))",
      }
    : {
        borderColor: "var(--accent-subtle-border)",
        background: "radial-gradient(circle at top right, var(--accent-subtle), transparent 54%), linear-gradient(135deg, rgba(10,14,12,0.96), rgba(16,18,30,0.96))",
      };
  const studioOnboardingDividerStyle = {
    borderColor: isLightTheme ? "rgba(15,23,42,0.08)" : "rgba(255,255,255,0.08)",
  };
  const studioOnboardingTitleStyle = {
    color: isLightTheme ? "var(--accent-hover)" : "var(--accent-light)",
  };
  const studioOnboardingBodyStyle = {
    color: isLightTheme ? "#52525b" : "#b1b1bb",
  };
  const studioOnboardingDismissClass = "border px-3 py-1 text-[11px] font-medium transition-colors hover:opacity-90";
  const studioOnboardingDismissStyle = isLightTheme
    ? {
        borderColor: "var(--accent-subtle-border)",
        backgroundColor: "rgba(255,255,255,0.88)",
        color: "var(--accent-hover)",
      }
    : {
        borderColor: "var(--accent-subtle-border)",
        backgroundColor: "rgba(255,255,255,0.04)",
        color: "var(--accent-light)",
      };
  const studioOnboardingInfoCardClass = "rounded-2xl border";
  const studioOnboardingInfoCardStyle = isLightTheme
    ? {
        borderColor: "rgba(15,23,42,0.08)",
        backgroundColor: "rgba(255,255,255,0.82)",
      }
    : {
        borderColor: "rgba(255,255,255,0.08)",
        backgroundColor: "rgba(11,13,16,0.82)",
      };
  const studioOnboardingActionCardClass = "rounded-2xl border transition-colors";
  const studioOnboardingActionCardStyle = isLightTheme
    ? {
        borderColor: "rgba(15,23,42,0.08)",
        backgroundColor: "rgba(255,255,255,0.82)",
      }
    : {
        borderColor: "rgba(255,255,255,0.08)",
        backgroundColor: "rgba(11,13,16,0.82)",
      };
  const studioOnboardingActionButtonPrimaryClass = "rounded-full border px-3.5 py-1.5 text-[11px] font-semibold transition-colors hover:opacity-90";
  const studioOnboardingActionButtonPrimaryStyle = {
    borderColor: "var(--accent)",
    backgroundColor: "var(--accent)",
    color: "#ffffff",
  };
  const studioOnboardingActionButtonDangerClass = "rounded-full border border-[rgba(244,114,182,0.24)] bg-[rgba(76,5,25,0.28)] px-3.5 py-1.5 text-[11px] font-semibold text-[#fda4af] transition-colors hover:bg-[rgba(127,29,29,0.34)]";
  const studioOnboardingInfoTitleStyle = {
    color: isLightTheme ? "#18181b" : "#f4f4f5",
  };
  const studioOnboardingActionTitleStyle = {
    color: isLightTheme ? "#18181b" : "#f4f4f5",
  };
  const studioOnboardingActionBodyStyle = {
    color: isLightTheme ? "#52525b" : "#b1b1bb",
  };
  const studioOnboardingStepLabelStyle = {
    color: isLightTheme ? "var(--accent-hover)" : "var(--accent-light)",
  };
  const mainFocusMenuPanelClass = isLightTheme
    ? "absolute bottom-full left-0 mb-2 w-72 overflow-hidden rounded-xl border bg-white shadow-[0_24px_64px_rgba(15,23,42,0.16)] z-[60]"
    : "absolute bottom-full left-0 mb-2 w-72 overflow-hidden rounded-xl border bg-[#09090b] shadow-2xl z-[60]";
  const mainFocusMenuHeaderClass = isLightTheme
    ? "border-b border-[#e4e4e7] text-[#52525b]"
    : "border-b border-[#27272a] text-[#a1a1aa]";
  const mainFocusItemBaseClass = "w-full text-left px-3 py-2.5 transition-colors";
  const mainFocusItemTitleClass = isLightTheme
    ? "text-[#18181b]"
    : "text-[#e4e4e7]";
  const mainFocusItemBodyClass = isLightTheme
    ? "text-[#52525b]"
    : "text-[#71717a]";
  const mainFocusItemTitleStyle = {
    color: isLightTheme ? "#18181b" : "#e4e4e7",
  };
  const mainFocusItemBodyStyle = {
    color: isLightTheme ? "#52525b" : "#71717a",
  };
  const mainFocusSelectedTitleClass = isLightTheme
    ? "text-[#18181b]"
    : "text-[#f4f4f5]";
  const mainFocusSelectedBodyClass = isLightTheme
    ? "text-[#52525b]"
    : "text-[#a1a1aa]";
  const mainFocusSelectedTextStyle = {
    color: isLightTheme ? "var(--accent-hover)" : "var(--accent-light)",
  };
  const mainFocusSelectedStyle = {
    backgroundColor: "var(--accent-subtle)",
    boxShadow: "inset 3px 0 0 var(--accent), inset 0 0 0 1px var(--accent-subtle-border)",
  };
  const mainFocusHoverStyle = {
    backgroundColor: "var(--accent-subtle)",
    boxShadow: "inset 0 0 0 1px var(--accent-subtle-border)",
  };
  const studioOnboardingCards = [
    {
      action: null,
      title: language === "en" ? "Workspace Assets" : "工作区写入说明",
      stepLabel: language === "en" ? "1. Prepare Workspace" : "1. 准备工作区",
      description: language === "en"
        ? "Initialization writes the bundled Studio pack into this workspace under `.MAIN/...` and `.protocols/game-studio/...`."
        : "初始化会把内置 Studio 协议包写入当前工作区的 `.MAIN/...` 与 `.protocols/game-studio/...` 隐藏目录。",
    },
    {
      action: "setup-engine",
      title: studioSetupEngineLabel,
      stepLabel: language === "en" ? "2. Continue Setup" : "2. 继续设置",
      description: language === "en"
        ? "Insert `/setup-engine` as a draft, then fill in engine, language, and runtime path before sending."
        : "先把 `/setup-engine` 写成草稿，再补充引擎、语言和运行时路径后手动发送。",
    },
    {
      action: "start",
      title: studioStartLabel,
      stepLabel: language === "en" ? "3. Start Workflow" : "3. 开始工作流",
      description: language === "en"
        ? "Insert `/start` as a draft so you can add project context before sending."
        : "先把 `/start` 写成草稿，再由你补充项目背景后手动发送。",
    },
    {
      action: "brainstorm",
      title: studioBrainstormLabel,
      stepLabel: language === "en" ? "3. Start Workflow" : "3. 开始工作流",
      description: language === "en"
        ? "Insert `/brainstorm` as a draft and describe the concept, pillars, and audience in the composer."
        : "先把 `/brainstorm` 写成草稿，再在输入框里补充概念、支柱体验和目标受众。",
    },
  ] as const;

  // Debounce input for token estimation (300ms)
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedInput(input), 300);
    return () => clearTimeout(timer);
  }, [input]);

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

  useEffect(() => {
    const previousMode = previousMainModeRef.current;
    const previousWorkspace = previousWorkspaceRef.current;
    const enteredGameStudio = isGameStudioMode && previousMode !== "game_studio";
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

    previousMainModeRef.current = selectedMainModeKey;
    previousWorkspaceRef.current = currentWorkspace;
  }, [currentWorkspace, currentWorkspaceOnboardingKey, isGameStudioMode, selectedMainModeKey]);

  const currentTokens = useMemo(() => {
    const historyTokens = estimateAgentMessagesTokens(agentMessages);
    const inputTokens = estimateTokens(debouncedInput);
    const imageTokens = pendingImages.length * 1000;
    return historyTokens + inputTokens + imageTokens;
  }, [agentMessages, debouncedInput, pendingImages]);

  const usagePercent = contextLimit > 0 ? (currentTokens / contextLimit) * 100 : 0;
  const cloudTokenLabel = language === "en" ? `~${currentTokens} tok` : `~${currentTokens} tokens`;
  const cloudTokenTitle = language === "en"
    ? "Cloud mode does not use the local context compression limit"
    : "云端模式不使用本地上下文压缩阈值";

  // ── Load workspace files on workspace change or workspace mutations ──
  useEffect(() => {
    if (!currentWorkspace) {
      setAllFiles([]);
      setIsFilesLoading(false);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      setIsFilesLoading(true);
      getAllWorkspaceFiles(currentWorkspace).then(files => {
        if (!cancelled) {
          setAllFiles(files);
          setIsFilesLoading(false);
        }
      }).catch(() => {
        if (!cancelled) {
          setAllFiles([]);
          setIsFilesLoading(false);
        }
      });
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [currentWorkspace, workspaceContentVersion]);

  // ── Fuzzy filter whenever query or allFiles change ──
  useEffect(() => {
    if (!showMentionMenu) return;
    const filtered = fuzzyFilterFiles(allFiles, mentionQuery, 20);
    setMentionResults(filtered);
    setHighlightedIndex(0);
  }, [mentionQuery, allFiles, showMentionMenu]);

  const filteredSlashItems = useMemo(() => {
    if (!isGameStudioMode) return [];
    const normalizedQuery = slashQuery.trim().toLowerCase();
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
    return ranked;
  }, [isGameStudioMode, slashCatalog, slashQuery]);

  const groupedSlashItems = useMemo(() => {
    const groups = [];
    const workflowGroups = new Map();
    const agentGroups = new Map();
    for (const item of filteredSlashItems) {
      const target = item.kind === "workflow" ? workflowGroups : agentGroups;
      if (!target.has(item.group)) target.set(item.group, []);
      target.get(item.group).push(item);
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
  }, [filteredSlashItems, studioAgentHeading, studioWorkflowHeading]);

  // ── Close mention dropdown / slash menu on outside click ──
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (mentionDropRef.current && !mentionDropRef.current.contains(e.target as Node)) {
        closeMentionMenu();
      }
      if (slashMenuRef.current && !slashMenuRef.current.contains(e.target as Node)) {
        setShowSlashMenu(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  const closeMentionMenu = useCallback(() => {
    setShowMentionMenu(false);
    setMentionQuery("");
    mentionAnchorRef.current = -1;
  }, []);

  const closeSlashMenu = useCallback(() => {
    setShowSlashMenu(false);
    setHighlightedSlashIndex(0);
  }, []);

  useEffect(() => {
    if (isGameStudioMode) return;
    closeSlashMenu();
  }, [closeSlashMenu, isGameStudioMode]);

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
  }, []);

  // ── Image drag-and-drop handlers ──
  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (e.dataTransfer.types.includes("Files")) {
      e.preventDefault();
      e.stopPropagation();
      setIsDragOver(true);
    }
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
  }, []);

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);

    const imageFiles = getImageFilesFromDrop(e.nativeEvent);
    for (const file of imageFiles) {
      try {
        const dataUrl = await processImageFile(file);
        setPendingImages(prev => [...prev, dataUrl]);
      } catch (err) {
        console.error("Failed to process dropped image:", err);
      }
    }
  }, []);

  // ── Insert @ from the @ button click ──
  const handleAtButtonClick = () => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.focus();

    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const before = input.slice(0, start);
    const after = input.slice(end);

    // Only insert @ if preceded by whitespace or at start (avoid email-like)
    const charBefore = start > 0 ? before[start - 1] : " ";
    const needSpace = charBefore !== " " && charBefore !== "\n";

    const insert = needSpace ? " @" : "@";
    const newValue = before + insert + after;
    setInput(newValue);

    // Schedule cursor position and trigger mention menu
    const anchorPos = start + insert.length - 1; // position of the @
    mentionAnchorRef.current = anchorPos;
    setMentionQuery("");
    setShowMentionMenu(true);

    requestAnimationFrame(() => {
      ta.selectionStart = ta.selectionEnd = anchorPos + 1;
    });
  };

  const handleStudioCommandButtonClick = () => {
    if (!isGameStudioMode) return;
    markStudioOnboardingUsed();
    setShowSlashMenu(true);
    const normalized = input.trim().startsWith("/") ? input.trim().slice(1) : "";
    setSlashQuery(normalized);
    textareaRef.current?.focus();
  };

  const refreshWorkspaceFiles = useCallback(async () => {
    if (!currentWorkspace) {
      setAllFiles([]);
      return;
    }

    setIsFilesLoading(true);
    try {
      const files = await getAllWorkspaceFiles(currentWorkspace);
      setAllFiles(files);
    } catch {
      setAllFiles([]);
    } finally {
      setIsFilesLoading(false);
    }
  }, [currentWorkspace]);

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
    setInput(value);
    setShowSlashMenu(false);
    setHighlightedSlashIndex(0);
    requestAnimationFrame(() => {
      if (textareaRef.current) {
        const position = value.length;
        textareaRef.current.selectionStart = textareaRef.current.selectionEnd = position;
        textareaRef.current.focus();
      }
    });
  }, [setInput]);

  const handleSelectSlashItem = (item) => {
    const value = item.kind === "workflow" ? `${item.canonicalCommand} ` : item.canonicalCommand;
    markStudioOnboardingUsed();
    applyComposerDraft(value);
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
        await refreshWorkspaceFiles();
        setInput("");
      } catch (error) {
        console.error("Failed to initialize Game Studio workspace:", error);
      }
      return;
    }

    markStudioOnboardingUsed();
    applyComposerDraft(resolved.value);
  };

  const handleRemoveGameStudioWorkspace = async () => {
    const confirmed = window.confirm(
      language === "en"
        ? "Remove MAIN GAME STUDIO from this workspace? This will delete the Game Studio hidden folders and merged hooks for the current project."
        : "要从当前工作区移除 MAIN GAME STUDIO 吗？这会删除该项目中的 Game Studio 隐藏文件夹和已合并的 hooks。",
    );

    if (!confirmed) return;

    try {
      await removeGameStudioWorkspace();
      setInput("");
      setShowSlashMenu(false);
      await refreshWorkspaceFiles();
      reopenStudioOnboarding({ resetUsed: true });
    } catch (error) {
      console.error("Failed to remove Game Studio workspace assets:", error);
    }
  };

  const handleSubmitComposerMessage = useCallback(() => {
    const hasPayload =
      input.trim().length > 0 ||
      contextMentions.length > 0 ||
      attachedFiles.length > 0 ||
      pendingImages.length > 0;

    if (!hasPayload || isComposerSubmitting || submitPendingRef.current) {
      return;
    }

    submitPendingRef.current = true;
    setIsSubmitPending(true);
    if (isGameStudioMode) {
      markStudioOnboardingUsed();
    }
    closeSlashMenu();
    const didSend = onSendMessage(pendingImages);
    if (didSend === false) {
      submitPendingRef.current = false;
      setIsSubmitPending(false);
      return;
    }
    setPendingImages([]);
  }, [attachedFiles.length, closeSlashMenu, contextMentions.length, input, isComposerSubmitting, isGameStudioMode, markStudioOnboardingUsed, onSendMessage, pendingImages]);

  // ── Handle textarea change (detect @ typing) ──
  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    setInput(value);

    const cursorPos = e.target.selectionStart ?? value.length;
    const textBeforeCursor = value.slice(0, cursorPos);
    const trimmedValue = value.trimStart();

    if (isGameStudioMode && trimmedValue.startsWith("/")) {
      setSlashQuery(trimmedValue.slice(1));
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
        setShowMentionMenu(true);
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
      const cursorPos = textareaRef.current?.selectionStart ?? input.length;
      const before = input.slice(0, anchor);
      const after = input.slice(cursorPos);
      setInput(before + after);

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

  const handleRemoveAttachedFile = (filePath: string) => {
    setAttachedFiles(attachedFiles.filter((f: string) => f !== filePath));
  };

  // ── Keyboard navigation inside textarea + mention menu ──
  const handleKeyDown = (e: React.KeyboardEvent) => {
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
      if ((e.key === "Enter" && !e.altKey) || e.key === "Tab") {
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
        setHighlightedSlashIndex((prev) => Math.min(prev + 1, filteredSlashItems.length - 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setHighlightedSlashIndex((prev) => Math.max(prev - 1, 0));
        return;
      }
      if ((e.key === "Enter" && !e.altKey) || e.key === "Tab") {
        e.preventDefault();
        if (filteredSlashItems.length > 0 && highlightedSlashIndex < filteredSlashItems.length) {
          handleSelectSlashItem(filteredSlashItems[highlightedSlashIndex]);
        } else if (e.key === "Enter" && !e.altKey && input.trim().startsWith("/")) {
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
    if (e.key === "Enter" && !e.shiftKey && !e.altKey && !isComposerSubmitting && !showMentionMenu && !showSlashMenu) {
      e.preventDefault();
      handleSubmitComposerMessage();
    }
  };

  // ── Helper: extract display name from path ──
  const displayName = (path: string) => path.split("/").pop() || path;
  const composerPlaceholder = activeDiffTask
    ? "..."
    : isGameStudioMode
    ? (language === "en" ? "Ask the studio, or type / for workflows and specialists..." : "询问工作室中枢，或输入 / 打开工作流和专家面板...")
    : language === "en"
    ? "Try: Summarize this folder, analyze these tables and write a report, extract the key conclusions, or plan first before execution..."
    : "例如：总结这个文件夹里的内容、分析这些表格并生成报告、提炼这批资料的关键结论，或先给我一个计划再执行...";

  return (
    <div className="absolute bottom-6 left-6 right-6 z-20 pointer-events-none flex justify-center">
      <div
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
          <div
            data-testid="game-studio-onboarding"
            className={`mb-3 overflow-hidden rounded-[24px] ${studioOnboardingShellClass}`}
            style={studioOnboardingShellStyle}
          >
            <div className="flex items-start justify-between gap-3 border-b px-5 py-4" style={studioOnboardingDividerStyle}>
              <div>
                <div className="text-[16px] font-semibold tracking-[0.08em]" style={studioOnboardingTitleStyle}>
                  MAIN GAME STUDIO
                </div>
                <div className="mt-1 text-[12px] leading-relaxed" style={studioOnboardingBodyStyle}>
                  {language === "en"
                    ? "Use the action buttons to initialize or remove Studio assets for this workspace. Then follow steps 2 and 3 to draft commands, or open the full Studio command hub with `/`."
                    : "用下方操作按钮来初始化或移除当前工作区的 Studio 资产，然后按步骤 2 和步骤 3 草拟命令；也可以随时输入 `/` 打开完整的 Studio 命令中枢。"}
                </div>
              </div>
              <button
                type="button"
                data-testid="game-studio-onboarding-dismiss"
                onClick={markStudioOnboardingDismissed}
                className={`shrink-0 rounded-full ${studioOnboardingDismissClass}`}
                style={studioOnboardingDismissStyle}
              >
                {language === "en" ? "Dismiss" : "关闭"}
              </button>
            </div>
            <div className="grid gap-2 p-4 md:grid-cols-2">
              {studioOnboardingCards.map((card) => {
                if (!card.action) {
                  return (
                    <div
                      key={card.title}
                      data-testid="game-studio-onboarding-workspace"
                      className={`${studioOnboardingInfoCardClass} px-4 py-3`}
                      style={studioOnboardingInfoCardStyle}
                    >
                      <div className="text-[11px] font-semibold uppercase tracking-[0.18em]" style={studioOnboardingStepLabelStyle}>
                        {card.stepLabel}
                      </div>
                      <div className="mt-1 text-[13px] font-semibold" style={studioOnboardingInfoTitleStyle}>
                        {card.title}
                      </div>
                      <div className="mt-1 text-[11px] leading-snug" style={studioOnboardingActionBodyStyle}>
                        {card.description}
                      </div>
                    </div>
                  );
                }

                return (
                  <button
                    key={card.action}
                    type="button"
                    data-testid={`game-studio-onboarding-${card.action}`}
                    onClick={() => handleStudioOnboardingAction(card.action)}
                    className={`${studioOnboardingActionCardClass} px-4 py-3 text-left transition-colors`}
                    style={studioOnboardingActionCardStyle}
                  >
                    <div className="text-[11px] font-semibold uppercase tracking-[0.18em]" style={studioOnboardingStepLabelStyle}>
                      {card.stepLabel}
                    </div>
                    <div className="mt-1 text-[13px] font-semibold" style={studioOnboardingActionTitleStyle}>
                      {card.title}
                    </div>
                    <div className="mt-1 text-[11px] leading-snug" style={studioOnboardingActionBodyStyle}>
                      {card.description}
                    </div>
                  </button>
                );
              })}
            </div>
            <div className="flex flex-wrap gap-2 px-4 pb-4">
              <button
                type="button"
                data-testid="game-studio-onboarding-init"
                onClick={() => handleStudioOnboardingAction("init")}
                className={studioOnboardingActionButtonPrimaryClass}
                style={studioOnboardingActionButtonPrimaryStyle}
              >
                {gameStudioInitialized
                  ? (language === "en" ? "Reinitialize Game Studio" : "重新初始化 Game Studio")
                  : studioInitLabel}
              </button>
              {gameStudioInitialized && (
                <button
                  type="button"
                  data-testid="game-studio-onboarding-remove"
                  onClick={handleRemoveGameStudioWorkspace}
                  className={studioOnboardingActionButtonDangerClass}
                >
                  {language === "en" ? "Remove MAIN GAME STUDIO" : "移除 MAIN GAME STUDIO"}
                </button>
              )}
            </div>
            <div className="flex flex-col gap-2 border-t px-4 pb-4 pt-3 md:flex-row md:items-center md:justify-between" style={studioOnboardingDividerStyle}>
              <div className="text-[11px] leading-relaxed md:max-w-[70%]" style={studioOnboardingBodyStyle}>
                {language === "en"
                  ? "Game Studio initialization is workspace-local. If you switch to another folder, that folder will need its own `.MAIN` and `.protocols/game-studio` assets before Studio workflows can run there."
                  : "Game Studio 的初始化是按工作区独立保存的。切换到另一个文件夹后，需要在那个工作区内单独写入 `.MAIN` 与 `.protocols/game-studio` 相关资产，Studio 工作流才能在那里运行。"}
              </div>
            </div>
          </div>
        )}

        <div className={`bg-[#09090b] border border-[#27272a] transition-all flex flex-col relative z-20 ${activeDiffTask ? 'rounded-b-xl border-t-0' : 'rounded-xl'} ${isStreaming ? 'border-[#3f3f46]' : 'focus-within:border-[#3f3f46]'}`}>

          {/* Attached files tags */}
          {attachedFiles.length > 0 && (
            <div className="flex flex-wrap gap-2 px-4 pt-3">
              {attachedFiles.map((filePath: string) => (
                <div key={filePath} className="flex items-center gap-1.5 bg-[#000000] border border-[var(--accent-subtle-border,#27272a)] text-[var(--accent-light,#a855f7)] text-[11px] font-mono px-2 py-1 rounded-md">
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

          <div className="relative">
            <textarea
              ref={textareaRef}
              data-testid="composer-textarea"
              className="w-full bg-transparent border-none outline-none resize-none text-[#e4e4e7] p-4 text-[13px] leading-relaxed placeholder:text-[#a1a1aa]"
              rows={activeDiffTask ? 1 : 2}
              placeholder={composerPlaceholder}
              value={input}
              onChange={handleInputChange}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
              disabled={isComposerSubmitting}
            />

            {/* ── @ Mention dropdown ── */}
            {showMentionMenu && (
              <div
                ref={mentionDropRef}
                className="absolute left-4 bottom-full mb-1 w-80 bg-[#09090b] border border-[#27272a] rounded-lg shadow-2xl overflow-hidden z-50 flex flex-col"
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

            {showSlashMenu && isGameStudioMode && (
              <div
                ref={slashMenuRef}
                className="absolute left-4 bottom-full mb-1 w-[min(36rem,calc(100%-2rem))] max-w-[36rem] bg-[#09090b] border border-[#27272a] rounded-lg shadow-2xl overflow-hidden z-50 flex flex-col"
              >
                <div className="p-2 border-b border-[#27272a] flex items-center gap-2 text-[#e4e4e7] bg-[#000000]">
                  <IconCode className="w-3.5 h-3.5 text-[#86efac]" />
                  <span className="text-[11px] text-[#a1a1aa] truncate">{slashSearchLabel}</span>
                  <span className="ml-auto text-[10px] text-[#52525b]">{slashCommandLabel}</span>
                </div>

                <div className="max-h-72 overflow-y-auto px-2 py-2">
                  {filteredSlashItems.length === 0 ? (
                    <div className="px-3 py-4 text-[11px] text-[#a1a1aa] text-center">{slashEmptyLabel}</div>
                  ) : (
                    (() => {
                      let globalIndex = -1;
                      return groupedSlashItems.map((section) => (
                        <div key={section.heading} className="mb-2 last:mb-0">
                          <div className="px-2 py-1 text-[10px] font-bold uppercase tracking-[0.18em] text-[#71717a]">
                            {section.heading}
                          </div>
                          {section.groups.map(([groupName, items]) => (
                            <div key={`${section.heading}-${groupName}`} className="mb-1 last:mb-0">
                              <div className="px-2 pt-1 pb-1 text-[10px] text-[#52525b]">{groupName}</div>
                              {items.map((item) => {
                                globalIndex += 1;
                                const isActive = globalIndex === highlightedSlashIndex;
                                return (
                                  <button
                                    key={item.id}
                                    onClick={() => handleSelectSlashItem(item)}
                                    className={`w-full rounded-md px-3 py-2 text-left transition-colors ${
                                      isActive ? "bg-[#18181b]" : "hover:bg-[#131316]"
                                    }`}
                                  >
                                    <div className="flex items-center justify-between gap-3">
                                      <div className="min-w-0">
                                        <div className="text-[12px] font-semibold text-[#f4f4f5] truncate">
                                          {item.kind === "workflow" ? item.canonicalCommand : item.label}
                                        </div>
                                        <div className="mt-0.5 text-[11px] leading-snug text-[#71717a]">
                                          {item.description}
                                        </div>
                                      </div>
                                      <div className="shrink-0 rounded-full border border-[#27272a] bg-[#050507] px-2 py-0.5 text-[10px] text-[#a1a1aa]">
                                        {item.kind === "workflow" ? workflowKindLabel : agentKindLabel}
                                      </div>
                                    </div>
                                  </button>
                                );
                              })}
                            </div>
                          ))}
                        </div>
                      ));
                    })()
                  )}
                </div>

                <div className="px-3 py-1.5 border-t border-[#27272a] flex items-center gap-3 text-[10px] text-[#52525b]">
                  <span>{mentionHintUpDown}</span>
                  <span>{mentionHintEnter}</span>
                  <span>{mentionHintEsc}</span>
                  <span className="ml-auto">{slashHint}</span>
                </div>
              </div>
            )}
          </div>

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
                    <ContextRing percentage={usagePercent} />
                    <span>{usagePercent.toFixed(1)}%</span>
                  </div>
                )}
              </div>

              <div className="w-[1px] h-4 bg-[#27272a] mx-1"></div>

              {/* MAIN mode switcher */}
              <div className="relative">
                <button
                  data-testid="main-focus-picker-button"
                  onClick={() => {
                    setShowAgentPicker(!showAgentPicker);
                    setHoveredMainFocusModeKey(null);
                  }}
                  className="bg-[#000000] border border-[#27272a] text-[#e4e4e7] text-[11px] font-bold px-3 py-1.5 rounded-md flex shrink-0 items-center gap-1.5 whitespace-nowrap hover:bg-[#18181b] transition-colors"
                >
                  <span className="max-w-[112px] truncate">{t[selectedMainModeKey]}</span>
                  <IconChevronUp className="w-3.5 h-3.5" />
                </button>

                {showAgentPicker && (
                  <div
                    className={mainFocusMenuPanelClass}
                    style={{ borderColor: "var(--accent-subtle-border)" }}
                    onMouseLeave={() => setHoveredMainFocusModeKey(null)}
                  >
                    <div className={`px-3 py-2 text-[10px] font-bold uppercase tracking-wider ${mainFocusMenuHeaderClass}`}>{t.switchMainMode}</div>
                    {mainModes.map((modeKey: string) => (
                      <button
                        key={modeKey}
                        data-testid={`main-focus-option-${modeKey}`}
                        onMouseMove={() => setHoveredMainFocusModeKey(modeKey)}
                        onClick={() => {
                          setSelectedMainModeKey(modeKey);
                          setShowAgentPicker(false);
                          setHoveredMainFocusModeKey(null);
                        }}
                        style={
                          selectedMainModeKey === modeKey
                            ? mainFocusSelectedStyle
                            : hoveredMainFocusModeKey === modeKey
                            ? mainFocusHoverStyle
                            : undefined
                        }
                        className={mainFocusItemBaseClass}
                      >
                        <div
                          className="text-[12px] font-semibold"
                          style={selectedMainModeKey === modeKey ? mainFocusSelectedTextStyle : mainFocusItemTitleStyle}
                        >
                          {t[modeKey]}
                        </div>
                        <div
                          className="mt-0.5 text-[11px] leading-snug"
                          style={selectedMainModeKey === modeKey ? mainFocusSelectedTextStyle : mainFocusItemBodyStyle}
                        >
                          {mainModeDescriptions[modeKey]}
                        </div>
                      </button>
                    ))}
                  </div>
                )}
              </div>

              <div className="w-[1px] h-4 bg-[#27272a] mx-1"></div>

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
                  <div className="w-[1px] h-4 bg-[#27272a] mx-1"></div>
                </>
              )}

              {/* @ Mention button — inserts @ and opens the same menu */}
              <button
                onClick={handleAtButtonClick}
                className="bg-[#000000] border border-[#27272a] text-[#e4e4e7] text-[11px] font-bold px-2 py-1.5 rounded-md flex shrink-0 items-center justify-center hover:bg-[#18181b] transition-colors"
                title={language === "en" ? "Reference file" : "引用文件"}
              >
                <IconAt className="w-4 h-4" />
              </button>

              {/* + Attach file button */}
              <button
                onClick={onAttachFile}
                className="text-[#a1a1aa] hover:text-[#e4e4e7] p-1.5 rounded hover:bg-[#18181b] transition-colors"
                title={language === "en" ? "Attach file" : "附加文件"}
              >
                <IconPlus className="w-4 h-4" />
              </button>
            </div>

            <div className="flex items-center gap-2">
              {composerIntentBadge && !activeDiffTask && !isStreaming && (
                <div className="rounded-full border px-2.5 py-1 text-[10px] font-semibold tracking-[0.04em]" style={{ borderColor: "var(--accent-subtle-border)", backgroundColor: "var(--accent-subtle)", color: isLightTheme ? "var(--accent-hover)" : "var(--accent-light)" }}>
                  {composerIntentBadge}
                </div>
              )}

              {/* Send / Stop button */}
              {!activeDiffTask && (
                isStreaming ? (
                  <button
                    onClick={onStopGeneration}
                    className="bg-[#09090b] border border-[#7f1d1d] text-[#f48771] hover:bg-[#7f1d1d] hover:text-white w-8 h-8 flex items-center justify-center rounded-md transition-colors shadow-sm"
                  >
                    <IconStop className="w-4 h-4" />
                  </button>
                ) : (
                  <button
                    data-testid="composer-send-button"
                    disabled={isComposerSubmitting || (!input.trim() && contextMentions.length === 0 && attachedFiles.length === 0 && pendingImages.length === 0)}
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
  );
}
