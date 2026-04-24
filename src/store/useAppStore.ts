// store/useAppStore.ts
// Zustand global state for Local Agent IDE
// All state that was previously scattered as useState in the monolith lives here.
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { executeAgentLoop, type AgentMessage, type OrchestratorCallbacks, type ReviewDecision, type ContentPart } from "../lib/orchestrator";
import { analyzeTabularDocument, deleteChatTempPath, deletePlanFiles, readDocument, readFile } from "../lib/ipc";
import { invoke } from "@tauri-apps/api/core";
import { setWorkspaceRoot as setWorkspaceRootIpc } from "../lib/ipc";
import { formatWorkspaceTree } from "../lib/systemPrompt";
import { type MCPServer, type MCPTool } from "../lib/mcpClient";
import { sanitizePlanArtifactContent } from "../lib/sanitize";
import {
  loadResolvedInstructions,
  type InstructionSource,
  type ResolvedInstructionSet,
} from "../lib/instructions";
import {
  loadHooksConfig,
  type HookDefinition,
  type HookExecutionRecord,
} from "../lib/hooks";
import {
  type ConversationTurn,
  type ConversationTurnStatus,
  type NormalizedStreamState,
  type PlanArtifact,
  type PlanStage,
  type PlanTask,
  type ReplyOption,
  type RightPanelTab,
  detectDominantLanguage,
  extractPlanTasks,
  getPendingPlanTaskCommandFocus,
  getPlanArtifactTitle,
  summarizeAssistantText,
  summarizeUserPrompt,
} from "../lib/workflowModels";
import {
  buildAnthropicRequestBody,
  buildOpenAiResponsesInputCandidates,
  buildOpenAiResponsesRequestExtras,
  extractOpenAiResponsesInstructions,
  extractOpenAiResponseText,
  buildCloudHeaders,
  buildCloudMessagesApiUrl,
  extractAnthropicResponseText,
  normalizeCloudApiFormat,
  normalizeCloudProtocol,
  normalizeOpenAiReasoningEffort,
  type CloudApiProtocol,
  type OpenAiApiFormat,
  type OpenAiReasoningEffort,
} from "../lib/cloudProtocol";
import { buildToolDiffPreview, supportsToolDiffPreview } from "../lib/toolDiff";
import {
  buildGameStudioEnvelopeForTurn,
  ensureGameStudioWorkspaceInitialized,
  loadGameStudioConfig,
  removeGameStudioWorkspaceAssets,
  setGameStudioActiveAgent,
} from "../lib/gameStudioPack";
import {
  normalizeStudioAgentKey,
  parseGameStudioSlashCommand,
  resolveLegacyNexusModeKey,
  type StudioWorkflowCommandSlug,
  type NexusModeKey,
  type PendingSlashCommand,
  type StudioAgentKey,
} from "../lib/gameStudioCatalog";
import {
  createPendingDecisionCopy,
  mapResolvedRunIntentToWorkflowMode,
  resolveConversationTurnIntent,
  resolveRunIntentFromLegacyWorkflowMode,
  resolveTurnRunIntent,
  type ExecutionConsentPolicy,
  type PendingRunDecision,
  type ResolvedUserIntent,
  type ResolvedRunIntent,
} from "../lib/runIntent";
import { mapLegacyNexusModeToMainMode, mapMainModeToLegacyNexusMode, type MainModeKey } from "../lib/mainModes";
import { runIntentPreflight } from "../lib/intentPreflight";
import { runAfterNextPaint } from "../lib/uiScheduling";

// ── i18n ────────────────────────────────────────────────────────────

export const translations = {
  en: {
    workspace: "Workspace", conversations: "Conversations", new: "New",
    chatSpace: "Chat", globalChat: "Chat", noChats: "No chats yet",
    skills: "Skills", diff: "Diff Viewer", terminal: "Terminal", settings: "Settings",
    openProject: "Open Folder", noWorkspace: "No project selected", noConversations: "No conversations yet",
    localSetup: "Local AI Engine", cloudSetup: "Cloud API", general: "General", contextSetup: "Compression",
    instruction: "Instruction", reject: "Reject all", accept: "Accept all",
    askPlaceholder: "Ask me about your project... (Type @ to attach files)",
    askPlaceholderGlobal: "Talk through ideas, plans, or questions... (Type @ to attach files)",
    contextLimit: "Context Token Limit",
    contextLimitDesc: "Auto-compress history when exceeding this limit to prevent OOM.",
    vramEst: "Est. KV Cache (VRAM):",
    vramNote: "Note: This is overhead memory, base model weight VRAM not included.",
    themeColor: "Theme Accent Color",
    themeDesc: "Choose your preferred editor highlight color.",
    chatFontSize: "Chat Font Size",
    chatFontSizeDesc: "Adjust the text size in the chat area (10–20 px).",
    themeMode: "Appearance",
    themeModeDark: "Dark",
    themeModeLight: "Light",
    switchPersona: "Switch Persona",
    switchMainMode: "MAIN Mode",
    runMode: "Run Mode",
    main_mode: "MAIN Mode",
    game_studio: "Game Studio",
    nexus_general: "General Collaboration",
    nexus_create: "Creative Co-Creation",
    nexus_build: "Engineering Delivery",
    nexus_research: "Research & Analysis",
    nexus_game_studio: "Game Studio",
    mcpServers: "MCP Servers",
    instructionsHooks: "Instructions & Hooks",
    instructionsEnabled: "Enable workspace instructions",
    hooksEnabled: "Enable lifecycle hooks",
    refreshRules: "Refresh rules",
    instructionSources: "Resolved instruction sources",
    hookConfig: "Loaded hook definitions",
    hookRecords: "Recent hook records",
    dataManagement: "Data Management",
    clearHistory: "Clear History",
    clearHistoryDesc: "Delete all chat history and session data for the current workspace.",
    resetSettings: "Reset All Settings",
    resetSettingsDesc: "Restore all settings, skills, and configurations to their default values.",
    clearHistoryConfirm: "Are you sure? This will delete all conversation history for the current workspace.",
    resetSettingsConfirm: "Are you sure? This will reset ALL settings, skills, and sessions to their defaults.",
  },
  zh: {
    workspace: "工作区", conversations: "历史会话", new: "新建会话",
    chatSpace: "聊天", globalChat: "聊天", noChats: "暂无聊天",
    skills: "技能与提示词", diff: "变更比对", terminal: "集成终端", settings: "系统设置",
    openProject: "打开文件夹", noWorkspace: "尚未选择项目", noConversations: "暂无会话记录",
    localSetup: "本地引擎配置", cloudSetup: "云端接口配置", general: "通用设置", contextSetup: "背景压缩阈值",
    instruction: "用户指令", reject: "全部拒绝", accept: "全部接受",
    askPlaceholder: "询问关于你的项目... (输入 @ 引用本地文件)",
    askPlaceholderGlobal: "先和 MAIN 聊聊想法、方案或问题... (输入 @ 引用本地文件)",
    contextLimit: "上下文压缩阈值 (Token Limit)",
    contextLimitDesc: "对话历史超过此数值时，系统将在后台压缩早期对话以防止显存溢出 (OOM)。",
    vramEst: "预估上下文显存占用 (KV Cache):",
    vramNote: "注意：这仅仅是上下文占用的显存，不包含模型本身的权重显存。",
    themeColor: "全局主题配色 (Accent Color)",
    themeDesc: "选择你偏好的代码编辑器高亮色彩风格。",
    chatFontSize: "聊天区域文字大小",
    chatFontSizeDesc: "调整聊天区域的文字显示大小（10–20 px）。",
    themeMode: "外观模式",
    themeModeDark: "深色",
    themeModeLight: "浅色",
    switchPersona: "切换执行角色",
    switchMainMode: "MAIN 模式",
    runMode: "工作方式",
    main_mode: "MAIN 模式",
    game_studio: "游戏工作室",
    nexus_general: "通用协作",
    nexus_create: "创意共创",
    nexus_build: "工程实现",
    nexus_research: "研究分析",
    nexus_game_studio: "游戏工作室",
    mcpServers: "MCP 服务器",
    instructionsHooks: "指令与 Hooks",
    instructionsEnabled: "启用工作区指令",
    hooksEnabled: "启用生命周期 Hooks",
    refreshRules: "刷新规则",
    instructionSources: "已解析的指令来源",
    hookConfig: "已加载 Hook 定义",
    hookRecords: "最近的 Hook 记录",
    dataManagement: "数据管理",
    clearHistory: "清空聊天记录",
    clearHistoryDesc: "删除当前工作区的所有聊天记录和会话数据。",
    resetSettings: "重置所有设置",
    resetSettingsDesc: "将所有设置、技能和配置恢复为默认值。",
    clearHistoryConfirm: "确定要清空吗？此操作将删除当前工作区的所有对话记录。",
    resetSettingsConfirm: "确定要重置吗？此操作将恢复所有设置、技能和会话为默认值。",
  },
} as const;

export type Lang = keyof typeof translations;
export type TranslationKey = keyof typeof translations.en;

// ── Themes ───────────────────────────────────────────────────────────

export const THEMES = {
  blue:   { accent: '#007acc', hover: '#005f9e', light: '#3b82f6', subtle: 'rgba(0,122,204,0.15)',   subtleBorder: 'rgba(0,122,204,0.3)',   name: 'VS Code Blue' },
  purple: { accent: '#9333ea', hover: '#7e22ce', light: '#a855f7', subtle: 'rgba(147,51,234,0.15)',  subtleBorder: 'rgba(147,51,234,0.3)',  name: 'Amethyst' },
  green:  { accent: '#059669', hover: '#047857', light: '#10b981', subtle: 'rgba(5,150,105,0.15)',   subtleBorder: 'rgba(5,150,105,0.3)',   name: 'Matrix Green' },
  yellow: { accent: '#ca8a04', hover: '#a16207', light: '#eab308', subtle: 'rgba(202,138,4,0.15)',   subtleBorder: 'rgba(202,138,4,0.3)',   name: 'Sublime Gold' },
  rose:   { accent: '#e11d48', hover: '#be123c', light: '#fb7185', subtle: 'rgba(225,29,72,0.15)',   subtleBorder: 'rgba(225,29,72,0.3)',   name: 'Ruby Red' },
  hermesOrange: { accent: '#F37021', hover: '#D85F16', light: '#FB923C', subtle: 'rgba(243,112,33,0.15)', subtleBorder: 'rgba(243,112,33,0.32)', name: 'Hermes Orange' },
  tiffanyBlue: { accent: '#81D8D0', hover: '#5EC7BD', light: '#A8EEE8', subtle: 'rgba(129,216,208,0.16)', subtleBorder: 'rgba(129,216,208,0.34)', name: 'Tiffany Blue' },
} as const;

export type ThemeKey = keyof typeof THEMES;
export const GLOBAL_CHAT_KEY = "__MAIN_GLOBAL_CHAT__";

export function resolveSessionWorkspaceKey(workspace: string | null | undefined): string {
  const normalizedWorkspace = String(workspace || "").trim();
  return normalizedWorkspace || GLOBAL_CHAT_KEY;
}

export function resolveGlobalChatSessionKey(sessionId: number | null | undefined): string | null {
  return sessionId ? `${GLOBAL_CHAT_KEY}:${sessionId}` : null;
}

// ── Domain Types ─────────────────────────────────────────────────────

export type Role = "user" | "assistant" | "system";

export interface Message {
  id: string;
  role: Role;
  content: string;
  timestamp: number;
  streaming?: boolean;
}

export interface Skill {
  id: string;
  name: string;
  desc: string;
  content: string;
  active: boolean;
  isBuiltIn?: boolean;
  type?: "instruction" | "tool" | "package";       // default "instruction"
  toolParameters?: string;            // JSON string: OpenAI-style parameters schema (for tool-type only)
  packagePath?: string;               // Relative path to extracted folder (e.g. ".protocols/auto-optimize-1713...")
  entryPoint?: string;                // Entry file within the package (e.g. "SKILL.md" or "program.md")
}

// ── MCP Types (re-exported from mcpClient for convenience) ──────────
export type { MCPServer, MCPTool } from "../lib/mcpClient";

export interface SessionModelConfig {
  provider: string;
  endpoint: string;
  model: string;
  activeProfile: "local" | "cloud";
}

export interface SessionRuntimeSnapshot {
  taskFlow: TaskBlock[];
  agentMessages: AgentMessage[];
  conversationTurns: ConversationTurn[];
  currentTurnId: string | null;
  selectedMainModeKey: MainModeKey;
  selectedNexusModeKey: NexusModeKey;
  activeStudioAgentKey: StudioAgentKey;
  gameStudioInitialized: boolean;
  pendingSlashCommand: PendingSlashCommand | null;
  planArtifacts: PlanArtifact[];
  planTasks: PlanTask[];
  planExecutionEvidenceCount: number;
  planStage: PlanStage;
  isPlanApproved: boolean;
  showPlanPanel: boolean;
  showDiff: boolean;
  showTerminal: boolean;
  showFilePanel: boolean;
  rightPanelTab: RightPanelTab;
  selectedDiffTaskId: number | null;
}

export interface Session {
  id: number;
  title: string;
  date: string;
  active: boolean;
  messages?: TaskBlock[];
  modelConfig?: SessionModelConfig;
  activeSkills?: string[];
  runtimeSnapshot?: SessionRuntimeSnapshot;
}

export interface LocalConfig {
  provider: string;
  endpoint: string;
  model: string;
  contextLimit: number;
  apiKey: string;
}

export interface CloudConfig {
  protocol: CloudApiProtocol;
  apiFormat: OpenAiApiFormat;
  provider: string;
  endpoint: string;
  model: string;
  apiKey: string;
  customHeaders: string;
  temperature: number;
  topP: number;
  disableResponseStorage: boolean;
  reasoningEffort: OpenAiReasoningEffort;
}

export interface AppConfig {
  language: Lang;
  theme: ThemeKey;
  themeMode: "light" | "dark";
  workflowMode: "chat" | "edit" | "plan";  // Legacy mirror of the active turn intent.
  instructionsEnabled: boolean;
  hooksEnabled: boolean;
  activeProfile: "local" | "cloud";
  chatFontSize: number;  // px, default 13
  local: LocalConfig;
  cloud: CloudConfig;
  workspace: string;
}

export type AgentStatus = "idle" | "running" | "pending_review" | "error";

export interface JobItem {
  id: string;
  subject: string;
  status: "pending" | "in_progress" | "completed";
}

interface TaskBlockBase {
  id: number;
  turnId?: string;
}

export type TaskBlock =
  | (TaskBlockBase & { type: "user"; content: string; images?: string[] })
  | (TaskBlockBase & { type: "tool"; toolName: string; target: string; status: string; toolStatus: "pending" | "executed" | "rejected" | "running" | "failed"; message?: string; diff?: { old: string; new: string; path?: string } })
  | (TaskBlockBase & { type: "agent"; content: string; options?: ReplyOption[]; streaming?: boolean; hiddenProcess?: boolean })
  | (TaskBlockBase & { type: "thought"; content: string; isStreaming?: boolean; duration?: number })
  | (TaskBlockBase & { type: "jobList"; jobs: JobItem[] })
  | (TaskBlockBase & { type: "system"; content: string; icon?: string });

// ── Store State Interface ─────────────────────────────────────────────

interface AppState {
  // Config (merged from prototype config state)
  config: AppConfig;
  setConfig: (patch: Partial<AppConfig> | ((prev: AppConfig) => AppConfig)) => void;

  // Chat messages (SSE streaming)
  messages: Message[];
  isGenerating: boolean;
  abortController: AbortController | null;
  addMessage: (msg: Message) => void;
  updateMessage: (id: string, patch: Partial<Message>) => void;
  clearMessages: () => void;
  setGenerating: (value: boolean, ctrl?: AbortController | null) => void;
  stopGeneration: () => void;

  // Layout panels
  showDiff: boolean;
  showPlanPanel: boolean;
  showTerminal: boolean;
  rightPanelTab: RightPanelTab;
  rightPanelWidth: number;
  sidebarWidth: number;
  showWorkspaceTreePanel: boolean;
  workspaceTreePanelWidth: number;
  workspaceContentVersion: number;
  setShowDiff: (v: boolean) => void;
  setShowPlanPanel: (v: boolean) => void;
  setShowTerminal: (v: boolean) => void;
  showFilePanel: boolean;
  fileViewerPath: string;
  fileViewerContent: string;
  fileViewerError: string;
  fileViewerLoading: boolean;
  selectedDiffTaskId: number | null;
  openFileViewer: (path: string) => Promise<void>;
  clearFileViewer: () => void;
  setSelectedDiffTaskId: (id: number | null) => void;
  openDiffForTask: (taskId: number) => void;
  setRightPanelTab: (tab: RightPanelTab) => void;
  openRightPanelTab: (tab: RightPanelTab) => void;
  closeRightPanel: () => void;
  setRightPanelWidth: (w: number) => void;
  setSidebarWidth: (w: number) => void;
  setShowWorkspaceTreePanel: (v: boolean) => void;
  toggleWorkspaceTreePanel: () => void;
  setWorkspaceTreePanelWidth: (w: number) => void;
  bumpWorkspaceContentVersion: () => void;

  // Modals
  isSettingsOpen: boolean;
  settingsTab: string;
  isSkillsOpen: boolean;
  isAddingSkill: boolean;
  showFilePicker: boolean;
  showAgentPicker: boolean;
  setIsSettingsOpen: (v: boolean) => void;
  setSettingsTab: (tab: string) => void;
  setIsSkillsOpen: (v: boolean) => void;
  setIsAddingSkill: (v: boolean) => void;
  setShowFilePicker: (v: boolean) => void;
  setShowAgentPicker: (v: boolean) => void;

  // Composer / context
  input: string;
  preferredResponseLanguage: Lang;
  contextMentions: string[];
  attachedFiles: string[];
  selectedMainModeKey: MainModeKey;
  selectedNexusModeKey: NexusModeKey;
  activeStudioAgentKey: StudioAgentKey;
  gameStudioInitialized: boolean;
  pendingSlashCommand: PendingSlashCommand | null;
  pendingRunDecision: PendingRunDecision | null;
  executionConsentPolicy: ExecutionConsentPolicy;
  setInput: (v: string) => void;
  setPreferredResponseLanguage: (lang: Lang) => void;
  setContextMentions: (v: string[]) => void;
  addMention: (file: string) => void;
  removeMention: (file: string) => void;
  setAttachedFiles: (v: string[]) => void;
  setSelectedMainModeKey: (key: MainModeKey) => void;
  setSelectedNexusModeKey: (key: NexusModeKey) => void;
  setActiveStudioAgentKey: (key: StudioAgentKey, options?: { persistToWorkspace?: boolean }) => Promise<void>;
  setGameStudioInitialized: (value: boolean) => void;
  setPendingSlashCommand: (command: PendingSlashCommand | null) => void;
  dismissPendingRunDecision: () => void;
  resolvePendingRunDecision: (
    choice:
      | ResolvedUserIntent
      | "approve_once"
      | "approve_thread"
      | "cancel",
  ) => void;
  refreshGameStudioWorkspaceState: () => Promise<void>;
  initializeGameStudioWorkspace: () => Promise<void>;
  removeGameStudioWorkspace: () => Promise<void>;

  // MCP (Model Context Protocol) servers & discovered tools
  mcpServers: MCPServer[];
  mcpDiscoveredTools: MCPTool[];
  mcpToolServerMap: Record<string, string>;
  setMcpServers: (servers: MCPServer[]) => void;
  addMcpServer: (server: MCPServer) => void;
  removeMcpServer: (name: string) => void;
  setMcpDiscoveredTools: (tools: MCPTool[], toolServerMap: Record<string, string>) => void;

  // Skills CRUD
  skills: Skill[];
  setSkills: (v: Skill[]) => void;
  toggleSkill: (id: string) => void;
  deleteSkill: (id: string) => void;
  addSkill: (skill: Omit<Skill, "id" | "active" | "isBuiltIn">) => void;
  updateSkill: (id: string, patch: Partial<Omit<Skill, "id" | "isBuiltIn">>) => void;

  // Instructions & Hooks
  resolvedInstructionSet: ResolvedInstructionSet | null;
  instructionSources: InstructionSource[];
  loadedHookDefinitions: HookDefinition[];
  hookExecutionRecords: HookExecutionRecord[];
  instructionLastLoadedAt: number | null;
  hookLastLoadedAt: number | null;
  sessionHookCache: string[];
  refreshInstructionAndHookState: (associatedPaths?: string[]) => Promise<void>;
  setResolvedInstructionSet: (resolved: ResolvedInstructionSet | null) => void;
  setLoadedHookDefinitions: (hooks: HookDefinition[], loadedAt?: number | null) => void;
  appendHookExecutionRecords: (records: HookExecutionRecord[]) => void;
  markSessionHookInitialized: (sessionKey: string) => void;
  hasSessionHookInitialized: (sessionKey: string) => boolean;
  resetHookSessionCache: () => void;

  // Sessions — nested by workspace path
  sessionsByWorkspace: Record<string, Session[]>;
  currentWorkspace: string;
  selectedWorkspace: string;
  currentSessionId: number | null;
  setCurrentWorkspace: (path: string) => void;
  setSelectedWorkspace: (path: string) => void;
  addSession: (workspacePath: string, session: Session) => void;
  removeSession: (workspacePath: string, sessionId: number) => void;
  updateSession: (workspacePath: string, sessionId: number, patch: Partial<Session>) => void;
  setCurrentSessionId: (id: number | null) => void;

  // Task Flow (now driven by real agent loop)
  taskFlow: TaskBlock[];
  setTaskFlow: (updater: (prev: TaskBlock[]) => TaskBlock[]) => void;
  acceptDiff: (id: number) => void;
  rejectDiff: (id: number) => void;

  // Data management
  clearChatHistory: () => void;
  resetAllSettings: () => void;

  // Workflow mode
  isPlanApproved: boolean;
  planArtifacts: PlanArtifact[];
  planStage: PlanStage;
  planTasks: PlanTask[];
  planExecutionEvidenceCount: number;
  normalizedStreamState: NormalizedStreamState;
  setWorkflowMode: (mode: "chat" | "edit" | "plan") => void;
  setIsPlanApproved: (v: boolean) => void;
  setPlanStage: (stage: PlanStage) => void;
  upsertPlanArtifact: (artifact: PlanArtifact) => void;
  clearPlanArtifacts: () => void;
  deletePersistedPlanFiles: () => Promise<void>;
  setPlanTasks: (tasks: PlanTask[]) => void;
  setNormalizedStreamState: (state: NormalizedStreamState) => void;
  approvePlan: () => void;
  rejectPlan: () => void;
  showWorkflowMenu: boolean;
  setShowWorkflowMenu: (v: boolean) => void;

  // Elapsed time tracking
  elapsedTime: number;

  // ── Agent Orchestrator State ──────────────────────────────────────
  agentStatus: AgentStatus;
  agentMessages: AgentMessage[];
  pendingReviewResolve: ((decision: ReviewDecision) => void) | null;
  pendingReviewTaskId: number | null;
  pendingToolCall: { name: string; arguments: Record<string, unknown> } | null;
  autoApproveTools: boolean;
  currentTurnExecutionConsent: { turnId: string | null; granted: boolean };
  pendingRunDecisionResolver:
    | ((choice: "approve_once" | "approve_thread" | "cancel") => void)
    | null;
  setAutoApproveTools: (v: boolean) => void;
  setAgentStatus: (s: AgentStatus) => void;
  resolveReview: (action: "accept" | "reject") => void;
  allowToolAction: (taskId: number) => void;
  rejectToolAction: (taskId: number) => void;
  approvePendingReviewOnce: () => void;
  approvePendingReviewForSession: () => void;
  resetForWorkspace: () => void;

  // Job List management
  addJobList: (jobs: JobItem[]) => number;
  updateJobList: (blockId: number, updater: (jobs: JobItem[]) => JobItem[]) => void;
  setJobStatus: (blockId: number, jobId: string, status: JobItem["status"]) => void;

  // Main entry point — sends a user message and starts the agent loop
  sendMessage: (
    text: string,
    images?: string[],
    options?: {
      hidden?: boolean;
      reuseCurrentTurn?: boolean;
      preservePlanState?: boolean;
      resolvedIntent?: ResolvedUserIntent;
      skipIntentResolution?: boolean;
      intentSummary?: string;
      contextMentionsSnapshot?: string[];
      attachedFilesSnapshot?: string[];
    },
  ) => void;
  // Resume loop after human review
  _nextTaskId: () => number;

  // 回合分组视图
  currentTurnId: string | null;
  conversationTurns: ConversationTurn[];
  createConversationTurn: (turn: Pick<ConversationTurn, "id" | "userPrompt" | "title" | "mode" | "status">) => void;
  setCurrentTurnId: (turnId: string | null) => void;
  appendBlockToTurn: (turnId: string, blockId: number) => void;
  updateConversationTurn: (turnId: string, patch: Partial<ConversationTurn>) => void;
  setConversationTurnStatus: (turnId: string, status: ConversationTurnStatus) => void;
  setConversationTurnSummary: (turnId: string, summary: string) => void;
  toggleConversationTurnCollapsed: (turnId: string) => void;

  // ── Turn Management for Deduplication ────────────────────────────
  currentTurnState: {
    interceptorHandled: boolean;
    interceptorThought: string;
    lastReportedThought: string;
    lastReportedAssistantText: string;
    turnId: string;
  };
  startNewTurn: () => void;
  getCurrentRunIntent: () => ResolvedUserIntent;
}

// ── Mock Local Model Provider Map ─────────────────────────────────────

export const MOCK_LOCAL_MODELS: Record<string, string[]> = {
  "LM Studio": ["Qwen-2.5-32B-Instruct", "Gemma-2-27b-it", "Llama-3-8B-Instruct"],
  "Ollama":    ["qwen2.5:32b", "gemma2:27b", "llama3:8b", "phi3:mini"],
  "OMLX":      ["mlx-community/Qwen2.5-32B-Instruct", "mlx-community/Meta-Llama-3-8B-Instruct", "mlx-community/Phi-3-mini"],
};

// ── Default Values ────────────────────────────────────────────────────

const defaultConfig: AppConfig = {
  language: "zh",
  theme: "purple",
  themeMode: "dark",
  workflowMode: "chat",
  instructionsEnabled: true,
  hooksEnabled: true,
  activeProfile: "local",
  chatFontSize: 13,
  local: { provider: "OMLX", endpoint: "http://127.0.0.1:8080/v1", model: "", contextLimit: 16384, apiKey: "" },
  cloud: {
    protocol: "openai",
    apiFormat: "chat_completions",
    provider: "OpenAI",
    endpoint: "https://api.openai.com/v1",
    model: "",
    apiKey: "",
    customHeaders: "",
    temperature: 0.6,
    topP: 0.95,
    disableResponseStorage: true,
    reasoningEffort: "none",
  },
  workspace: "",
};

const defaultSkills: Skill[] = [];

const defaultSessionsByWorkspace: Record<string, Session[]> = {};

const defaultNormalizedStreamState: NormalizedStreamState = {
  visibleText: "",
  hiddenThought: "",
  replyOptions: [],
  toolCalls: [],
  finishReason: null,
};

const defaultHookDefinitions: HookDefinition[] = [];

function createDefaultCurrentTurnState() {
  return {
    interceptorHandled: false,
    interceptorThought: "",
    lastReportedThought: "",
    lastReportedAssistantText: "",
    turnId: "",
  };
}

function normalizePendingSlashCommand(
  command: unknown,
): PendingSlashCommand | null {
  if (!command || typeof command !== "object") return null;
  const candidate = command as Partial<PendingSlashCommand>;
  if (candidate.type === "auto") {
    return { type: "auto", canonicalCommand: "/auto" };
  }
  if (candidate.type === "agent" && typeof candidate.slug === "string") {
    const slug = normalizeStudioAgentKey(candidate.slug);
    if (slug === "studio_auto") return null;
    return {
      type: "agent",
      slug,
      canonicalCommand: `/agent ${slug}`,
    };
  }
  if (
    candidate.type === "workflow" &&
    typeof candidate.slug === "string" &&
    typeof candidate.canonicalCommand === "string"
  ) {
    return {
      type: "workflow",
      slug: candidate.slug as StudioWorkflowCommandSlug,
      args: typeof candidate.args === "string" ? candidate.args : "",
      canonicalCommand: candidate.canonicalCommand,
    };
  }
  return null;
}

function normalizeSessionRuntimeSnapshot(
  snapshot: Partial<SessionRuntimeSnapshot> | null | undefined,
): SessionRuntimeSnapshot | undefined {
  if (!snapshot) return undefined;
  const selectedMainModeKey = mapLegacyNexusModeToMainMode(
    (snapshot as Partial<SessionRuntimeSnapshot> & { selectedAgentKey?: string }).selectedMainModeKey ||
      (snapshot as Partial<SessionRuntimeSnapshot> & { selectedAgentKey?: string }).selectedNexusModeKey ||
      (snapshot as Partial<SessionRuntimeSnapshot> & { selectedAgentKey?: string }).selectedAgentKey,
  );
  return {
    taskFlow: sanitizeTaskBlocksForPersist(snapshot.taskFlow || []),
    agentMessages: sanitizeAgentMessagesForPersist(snapshot.agentMessages || []),
    conversationTurns: snapshot.conversationTurns || [],
    currentTurnId: snapshot.currentTurnId ?? null,
    selectedMainModeKey,
    selectedNexusModeKey: mapMainModeToLegacyNexusMode(selectedMainModeKey),
    activeStudioAgentKey: normalizeStudioAgentKey(snapshot.activeStudioAgentKey),
    gameStudioInitialized: snapshot.gameStudioInitialized === true,
    pendingSlashCommand: normalizePendingSlashCommand(snapshot.pendingSlashCommand),
    planArtifacts: snapshot.planArtifacts || [],
    planTasks: snapshot.planTasks || [],
    planExecutionEvidenceCount: snapshot.planExecutionEvidenceCount ?? 0,
    planStage: snapshot.planStage ?? "idle",
    isPlanApproved: snapshot.isPlanApproved ?? false,
    showPlanPanel: snapshot.showPlanPanel ?? false,
    showDiff: snapshot.showDiff ?? false,
    showTerminal: snapshot.showTerminal ?? false,
    showFilePanel: snapshot.showFilePanel ?? false,
    rightPanelTab: snapshot.rightPanelTab ?? "plan",
    selectedDiffTaskId: snapshot.selectedDiffTaskId ?? null,
  };
}

function normalizeSessionsByWorkspace(
  sessionsByWorkspace: Record<string, Session[]> | undefined,
): Record<string, Session[]> {
  if (!sessionsByWorkspace) return {};
  const normalizedEntries = new Map<string, Session[]>();

  Object.entries(sessionsByWorkspace).forEach(([workspace, sessions]) => {
    const scopeKey = resolveSessionWorkspaceKey(workspace);
    const normalizedSessions = (sessions || []).map((session) => ({
      ...session,
      messages: sanitizeTaskBlocksForPersist(session.messages || []),
      runtimeSnapshot: normalizeSessionRuntimeSnapshot(session.runtimeSnapshot),
    }));
    const existing = normalizedEntries.get(scopeKey) || [];
    normalizedEntries.set(scopeKey, [...existing, ...normalizedSessions]);
  });

  return Object.fromEntries(normalizedEntries.entries());
}

// ── Streaming Thinking Interceptor ────────────────────────────────────
// Detects thinking XML tags (<thinking>, <thought>, <analysis>, <reasoning>)
// as they stream in token-by-token, and routes content to a ThoughtBlock
// instead of the agent block. Prevents thinking content from briefly
// appearing as plain text in the chat during streaming.

const THINKING_TAG_NAMES = new Set(["thinking", "thought", "analysis", "reasoning"]);

class StreamingThinkingInterceptor {
  private buffer = "";          // raw token accumulation for tag detection
  private inThinking = false;   // currently inside a thinking tag?
  private pendingClose = "";    // partial closing tag being accumulated
  private thinkingContent = ""; // accumulated content inside the thinking tag

  /** Feed a new token; returns { agent, thinking } with the split content. */
  feed(token: string): { agent: string; thinking: string; thoughtStarted: boolean; thoughtEnded: boolean } {
    let agent = "";
    let thinking = "";
    let thoughtStarted = false;
    let thoughtEnded = false;

    for (const ch of token) {
      if (this.inThinking) {
        // ── Inside a thinking block ──
        // Accumulate into pendingClose buffer for closing tag detection.
        // Only flush when we're certain it can't form a closing tag.
        this.pendingClose += ch;

        // Try to match a complete closing tag
        const closeRe = new RegExp(`^<\\/(${[...THINKING_TAG_NAMES].join("|")})>\\s*$`, "i");
        const m = this.pendingClose.match(closeRe);
        if (m) {
          // Full closing tag found — end thinking mode
          this.inThinking = false;
          this.pendingClose = "";
          thoughtEnded = true;
          continue;
        }

        // If the buffer can't possibly form a closing tag anymore, flush as thinking content
        // A potential closing tag looks like: </word> with optional trailing whitespace
        const couldBeCloseTag = /^<\/[a-zA-Z]*>?\s*$/.test(this.pendingClose);
        if (!couldBeCloseTag || this.pendingClose.length > 30) {
          thinking += this.pendingClose;
          this.thinkingContent += this.pendingClose;
          this.pendingClose = "";
        }
        // Otherwise keep buffering — it might still become a closing tag
      } else {
        // ── Normal mode — detect opening tags ──
        this.buffer += ch;

        // Check if buffer forms a complete opening tag
        const openMatch = this.buffer.match(/^(<(?:thinking|thought|analysis|reasoning)(?:\s[^>]*)?>)([\s\S]*)/i);
        if (openMatch) {
          // Switch to thinking mode
          this.inThinking = true;
          this.buffer = "";
          this.thinkingContent = "";
          thoughtStarted = true;
          // Any content after the tag is thinking content
          if (openMatch[2]) {
            thinking += openMatch[2];
            this.thinkingContent += openMatch[2];
          }
          continue;
        }

        // If buffer can't possibly form a tag anymore, flush it as agent content
        // A potential tag starts with '<' and contains only alpha chars so far
        if (this.buffer.length > 0) {
          const couldBeTag = /^<[a-zA-Z]*$/.test(this.buffer) ||
                             /^<[a-zA-Z]+\s*$/.test(this.buffer) ||
                             /^<[a-zA-Z]+[^>]*$/.test(this.buffer);
          if (!couldBeTag || this.buffer.length > 30) {
            agent += this.buffer;
            this.buffer = "";
          }
          // Otherwise keep buffering — it might become a tag
        }
      }
    }

    return { agent, thinking, thoughtStarted, thoughtEnded };
  }

  /** Get the accumulated thinking content so far. */
  getThinkingContent(): string { return this.thinkingContent; }

  /** Flush any remaining buffer (call at stream end). */
  flush(): { agent: string; thinking: string; thoughtEnded: boolean } {
    let agent = "";
    let thinking = "";
    let thoughtEnded = false;

    if (this.inThinking) {
      // Unclosed thinking tag — treat remaining as thinking content and close
      if (this.pendingClose) {
        this.thinkingContent += this.pendingClose;
        this.pendingClose = "";
      }
      thinking = ""; // no new content, but signal that the thought ended
      thoughtEnded = true;
      this.inThinking = false;
    }

    // Flush any remaining agent buffer
    if (this.buffer) {
      agent = this.buffer;
      this.buffer = "";
    }

    return { agent, thinking, thoughtEnded };
  }

  /** Reset state for reuse. */
  reset() {
    this.buffer = "";
    this.inThinking = false;
    this.pendingClose = "";
    this.thinkingContent = "";
  }
}

// ── Task ID counter ───────────────────────────────────────────────────

let taskIdCounter = 100; // Start high to avoid collision with mock data

export function syncTaskIdCounterFromBlocks(blocks: TaskBlock[]): void {
  const maxId = blocks.reduce((highest, block) => Math.max(highest, Number(block.id) || 0), 0);
  taskIdCounter = Math.max(taskIdCounter, maxId, 100);
}

// ── Workspace Tree Cache ──────────────────────────────────────────────

let workspaceTreeCache: string = "";
let workspaceTreeCacheKey: string = "";
let workspaceTreeCacheVersion = -1;

function invalidateWorkspaceTreeCache(): void {
  workspaceTreeCache = "";
  workspaceTreeCacheKey = "";
  workspaceTreeCacheVersion = -1;
}

async function getWorkspaceTree(workspace: string): Promise<string> {
  if (!workspace) return "";
  const workspaceContentVersion = useAppStore.getState?.().workspaceContentVersion ?? 0;
  if (
    workspaceTreeCacheKey === workspace &&
    workspaceTreeCache &&
    workspaceTreeCacheVersion === workspaceContentVersion
  ) {
    return workspaceTreeCache;
  }

  try {
    const entries = await invoke<Array<{ name: string; is_dir: boolean }>>("list_directory", { path: workspace });
    workspaceTreeCache = formatWorkspaceTree(entries.map((entry) => ({ name: entry.name, isDirectory: entry.is_dir })));
    workspaceTreeCacheKey = workspace;
    workspaceTreeCacheVersion = workspaceContentVersion;
    return workspaceTreeCache;
  } catch {
    return "";
  }
}

const RUN_INTENT_LABELS: Record<ResolvedRunIntent, { zh: string; en: string }> = {
  discuss: { zh: "讨论", en: "Discuss" },
  plan: { zh: "计划", en: "Plan" },
  execute: { zh: "直接执行", en: "Execute" },
  summarize: { zh: "总结", en: "Summarize" },
  report: { zh: "报告", en: "Report" },
  studio_workflow: { zh: "Game Studio 工作流", en: "Game Studio Workflow" },
};

function normalizeIntentSummary(summary: string): string {
  return summary.replace(/\s+/g, " ").trim();
}

function buildRunIntentSummary(params: {
  input: string;
  intent: ResolvedRunIntent;
  language: "zh" | "en";
  preflightSummary?: string | null;
  reason?: string | null;
}): string {
  const fromPreflight = normalizeIntentSummary(params.preflightSummary || "");
  if (fromPreflight) return fromPreflight.length <= 72 ? fromPreflight : `${fromPreflight.slice(0, 72).trim()}...`;

  const label = RUN_INTENT_LABELS[params.intent]?.[params.language] || params.intent;
  const subject = summarizeUserPrompt(params.input, params.language === "zh" ? 34 : 42);
  if (subject && subject !== "新的任务") {
    return params.language === "zh" ? `${label}：${subject}` : `${label}: ${subject}`;
  }

  const reason = normalizeIntentSummary(params.reason || "");
  return reason || (params.language === "zh" ? `${label}：新的任务` : `${label}: New task`);
}

// ── Safe JSON Serialization ──────────────────────────────────────────
// Prevents Error 13 crashes when state contains non-serializable values
// (e.g., React elements, functions, circular references).

/** JSON.stringify wrapper that never throws — returns fallback on failure. */
export function safeJsonStringify(value: unknown, fallback = "{}"): string {
  try {
    return JSON.stringify(value, (_key, val) => {
      // Strip functions, Symbols, and React elements (have $$typeof)
      if (typeof val === "function" || typeof val === "symbol") return undefined;
      if (val !== null && typeof val === "object" && typeof (val as any).$$typeof === "symbol") return undefined;
      return val;
    });
  } catch {
    return fallback;
  }
}

export function sanitizeTaskBlocksForPersist(blocks: TaskBlock[]): TaskBlock[] {
  return blocks.map((b) => {
    switch (b.type) {
      case "user":
        // Strip large image data URLs from persisted state (only keep metadata)
        return { id: b.id, turnId: b.turnId, type: "user" as const, content: String(b.content) };
      case "agent":
        // Remove streaming flag (transient UI state) — keep content (string)
        return {
          id: b.id,
          turnId: b.turnId,
          type: "agent" as const,
          content: String(b.content),
          ...(b.options && b.options.length > 0
            ? {
                options: b.options.map((option) => ({
                  label: String(option.label),
                  value: String(option.value),
                })),
              }
            : {}),
        };
      case "thought":
        return { id: b.id, turnId: b.turnId, type: "thought" as const, content: String(b.content) };
      case "tool":
        return {
          id: b.id, turnId: b.turnId, type: "tool" as const,
          toolName: String(b.toolName), target: String(b.target),
          status: String(b.status),
          toolStatus: b.toolStatus,
          ...(b.message ? { message: String(b.message) } : {}),
          ...(b.diff ? { diff: { old: String(b.diff.old), new: String(b.diff.new), path: b.diff.path ? String(b.diff.path) : undefined } } : {}),
        };
      default:
        return b;
    }
  });
}

export function sanitizeAgentMessagesForPersist(messages: AgentMessage[]): AgentMessage[] {
  return messages.map((message) => {
    const content: string | ContentPart[] = Array.isArray(message.content)
      ? message.content.reduce<ContentPart[]>((parts, part) => {
          if (part.type === "text") {
            parts.push({ type: "text", text: String(part.text ?? "") });
          }
          // Avoid persisting large data URLs in local storage snapshots.
          return parts;
        }, [])
      : String(message.content ?? "");

    return {
      role: message.role,
      content,
      ...(message.tool_calls ? { tool_calls: message.tool_calls } : {}),
      ...(message.tool_call_id ? { tool_call_id: message.tool_call_id } : {}),
    };
  });
}

function normalizePlanTaskStatuses(tasks: PlanTask[], shouldHighlightNextTask = false): PlanTask[] {
  if (!tasks.length) return tasks;

  const canonicalTasks = tasks.map((task) =>
    task.status === "in_progress"
      ? { ...task, status: "pending" as const }
      : task
  );

  const hasInProgress = canonicalTasks.some((task) => task.status === "in_progress");
  if (!shouldHighlightNextTask || hasInProgress) {
    return canonicalTasks;
  }

  const firstPendingIndex = canonicalTasks.findIndex((task) => task.status === "pending");
  if (firstPendingIndex === -1) {
    return canonicalTasks;
  }

  return canonicalTasks.map((task, index) =>
    index === firstPendingIndex
      ? { ...task, status: "in_progress" as const }
      : task.status === "in_progress"
      ? { ...task, status: "pending" as const }
      : task
  );
}

function isPlanArtifactPath(path: string): boolean {
  return path.replace(/\\/g, "/").toLowerCase().includes(".main/plans/");
}

function derivePlanStageFromArtifacts(
  artifacts: PlanArtifact[],
  tasks: PlanTask[],
  isPlanApproved: boolean,
  currentStage: PlanStage,
): PlanStage {
  if (isPlanApproved) {
    return currentStage === "completed" ? "completed" : "executing";
  }

  const artifactKinds = new Set(artifacts.map((artifact) => artifact.kind));

  if (artifactKinds.has("tasks")) {
    return tasks.length > 0 ? "ready_to_execute" : "tasks";
  }
  if (artifactKinds.has("bugfix")) {
    return "bugfix";
  }
  if (artifactKinds.has("design")) {
    return "design";
  }
  if (artifactKinds.has("requirements")) {
    return "requirements";
  }

  return "idle";
}

function buildPlanCommandExecutionHint(
  tasks: PlanTask[],
  language: "zh" | "en",
): string {
  const focus = getPendingPlanTaskCommandFocus(tasks, 3);
  if (focus.length === 0) {
    return language === "zh"
      ? "如果某个任务需要 shell 命令，请在 tasks.md 的 checkbox 文本里写出精确命令并用反引号包裹；执行阶段看到这些命令时，一次性命令优先用 run_command 并检查 exitCode/stdout/stderr，长驻或交互式命令用 execute_command 后再用 read_pty_since/read_pty_tail/get_pty_status 检查输出。"
      : "If a task needs shell work, place the exact command inside the tasks.md checkbox text using backticks. During execution, prefer run_command for finite commands and inspect exitCode/stdout/stderr; use execute_command for long-running or interactive commands, then verify with read_pty_since/read_pty_tail/get_pty_status.";
  }

  const lines = focus
    .map(({ task, commands }) =>
      language === "zh"
        ? `任务：${task.text}\n命令：${commands.map((command) => `\`${command}\``).join("、")}`
        : `Task: ${task.text}\nCommands: ${commands.map((command) => `\`${command}\``).join(", ")}`,
    )
    .join("\n\n");

  return language === "zh"
    ? "以下未完成任务里已经包含明确的 shell 命令，恢复执行后请优先真实运行它们：一次性命令用 run_command；长驻或交互式命令用 execute_command 后再读取 PTY 日志。不要只复述：\n\n" + lines
    : "The remaining tasks already include concrete shell commands. After resuming, run them for real: use run_command for finite commands; use execute_command and then read PTY logs for long-running or interactive commands. Do not only describe them:\n\n" + lines;
}

const NON_EXECUTION_EVIDENCE_TOOLS = new Set([
  "list_directory",
  "glob_search",
  "grep_search",
  "read_file",
  "read_document",
  "analyze_tabular_document",
  "query_tabular_document",
  "index_workspace_documents",
  "read_pty_buffer",
  "read_pty_tail",
  "read_pty_since",
  "get_pty_status",
  "clear_pty_buffer",
]);

const STRUCTURED_ATTACHMENT_EXTENSIONS = new Set([
  ".pdf",
  ".docx",
  ".xlsx",
  ".xls",
  ".csv",
  ".tsv",
]);

const TABULAR_ATTACHMENT_EXTENSIONS = new Set([
  ".xlsx",
  ".xls",
  ".csv",
  ".tsv",
]);

function shouldUseDocumentReader(path: string): boolean {
  const lower = path.toLowerCase();
  for (const ext of STRUCTURED_ATTACHMENT_EXTENSIONS) {
    if (lower.endsWith(ext)) return true;
  }
  return false;
}

function shouldUseTabularAnalyzer(path: string): boolean {
  const lower = path.toLowerCase();
  for (const ext of TABULAR_ATTACHMENT_EXTENSIONS) {
    if (lower.endsWith(ext)) return true;
  }
  return false;
}

function isPlanExecutionEvidenceTool(toolName: string, target: string): boolean {
  if (NON_EXECUTION_EVIDENCE_TOOLS.has(toolName)) {
    return false;
  }

  if (target && isPlanArtifactPath(target)) {
    return false;
  }

  return true;
}

/** Helper to ensure Skill content uses standard <analysis> tags for cross-model consistency. */
function normalizeSkillContent(content: string): string {
  if (!content) return content;
  return content
    .replace(/<(thought|thinking|reasoning|analysis)>/gi, "<analysis>")
    .replace(/<\/(thought|thinking|reasoning|analysis)>/gi, "<\/analysis>");
}

// ── The Store ─────────────────────────────────────────────────────────

export const useAppStore = create<AppState>()(
  persist(
    (set, get) => ({
  // Config
  config: defaultConfig,
  setConfig: (patch) =>
    set((s) => ({
      config: typeof patch === "function" ? patch(s.config) : { ...s.config, ...patch },
    })),

  // Chat
  messages: [],
  isGenerating: false,
  abortController: null,
  addMessage: (msg) => set((s) => ({ messages: [...s.messages, msg] })),
  updateMessage: (id, patch) =>
    set((s) => ({ messages: s.messages.map((m) => (m.id === id ? { ...m, ...patch } : m)) })),
  clearMessages: () => set({ messages: [] }),
  setGenerating: (value, ctrl = null) => set({ isGenerating: value, abortController: ctrl }),
  stopGeneration: () => {
    const currentTurnId = get().currentTurnId;
    get().abortController?.abort();
    const currentStatus = get().agentStatus;
    // Preserve pending_review so the plan panel stays visible
    if (currentStatus === "pending_review") {
      set({ isGenerating: false, abortController: null });
      if (currentTurnId) {
        get().setConversationTurnStatus(currentTurnId, "awaiting_approval");
      }
    } else {
      set({ isGenerating: false, abortController: null, agentStatus: "idle" });
      if (currentTurnId) {
        get().setConversationTurnStatus(currentTurnId, "done");
      }
    }
  },

  // Layout
  showDiff: false,
  showPlanPanel: false,
  showTerminal: false,
  showFilePanel: false,
  fileViewerPath: "",
  fileViewerContent: "",
  fileViewerError: "",
  fileViewerLoading: false,
  selectedDiffTaskId: null,
  rightPanelTab: "plan",
  rightPanelWidth: 450,
  setShowDiff: (v) => set({
    showDiff: v,
    showPlanPanel: v ? false : get().showPlanPanel,
    showTerminal: v ? false : get().showTerminal,
    showFilePanel: v ? false : get().showFilePanel,
    rightPanelTab: v ? "diff" : get().rightPanelTab,
  }),
  setShowPlanPanel: (v) => set({
    showPlanPanel: v,
    showDiff: v ? false : get().showDiff,
    showTerminal: v ? false : get().showTerminal,
    showFilePanel: v ? false : get().showFilePanel,
    rightPanelTab: v ? "plan" : get().rightPanelTab,
  }),
  setShowTerminal: (v) => set({
    showTerminal: v,
    showPlanPanel: v ? false : get().showPlanPanel,
    showDiff: v ? false : get().showDiff,
    showFilePanel: v ? false : get().showFilePanel,
    rightPanelTab: v ? "terminal" : get().rightPanelTab,
  }),
  openFileViewer: async (path) => {
    set({
      showFilePanel: true,
      showPlanPanel: false,
      showDiff: false,
      showTerminal: false,
      rightPanelTab: "file",
      fileViewerPath: path,
      fileViewerContent: "",
      fileViewerError: "",
      fileViewerLoading: true,
    });
    try {
      const content = await readFile(path);
      set({ fileViewerContent: content, fileViewerError: "", fileViewerLoading: false });
    } catch (error) {
      set({
        fileViewerContent: "",
        fileViewerError: error instanceof Error ? error.message : String(error),
        fileViewerLoading: false,
      });
    }
  },
  clearFileViewer: () => set({
    showFilePanel: false,
    fileViewerPath: "",
    fileViewerContent: "",
    fileViewerError: "",
    fileViewerLoading: false,
  }),
  setSelectedDiffTaskId: (id) => set({ selectedDiffTaskId: id }),
  openDiffForTask: (taskId) => {
    const task = get().taskFlow.find((block) => block.type === "tool" && block.id === taskId && !!block.diff);
    if (!task || task.type !== "tool" || !task.diff) return;

    set({
      selectedDiffTaskId: taskId,
      showDiff: true,
      showPlanPanel: false,
      showTerminal: false,
      showFilePanel: false,
      rightPanelTab: "diff",
    });
  },
  setRightPanelTab: (tab) => set({
    rightPanelTab: tab,
    showPlanPanel: tab === "plan",
    showDiff: tab === "diff",
    showTerminal: tab === "terminal",
    showFilePanel: tab === "file",
  }),
  openRightPanelTab: (tab) => get().setRightPanelTab(tab),
  closeRightPanel: () => set({ showPlanPanel: false, showDiff: false, showTerminal: false, showFilePanel: false }),
  setRightPanelWidth: (w) => set({ rightPanelWidth: w }),
  sidebarWidth: 260,
  setSidebarWidth: (w) => set({ sidebarWidth: Math.max(180, Math.min(450, w)) }),
  showWorkspaceTreePanel: false,
  workspaceTreePanelWidth: 320,
  workspaceContentVersion: 0,
  setShowWorkspaceTreePanel: (v) => set({ showWorkspaceTreePanel: v }),
  toggleWorkspaceTreePanel: () => set((s) => ({ showWorkspaceTreePanel: !s.showWorkspaceTreePanel })),
  setWorkspaceTreePanelWidth: (w) => set({ workspaceTreePanelWidth: Math.max(220, Math.min(520, w)) }),
  bumpWorkspaceContentVersion: () =>
    set((s) => ({
      workspaceContentVersion: s.workspaceContentVersion + 1,
    })),

  // Modals
  isSettingsOpen: false,
  settingsTab: "local",
  isSkillsOpen: false,
  isAddingSkill: false,
  showFilePicker: false,
  showAgentPicker: false,
  setIsSettingsOpen: (v) => set({ isSettingsOpen: v }),
  setSettingsTab: (tab) => set({ settingsTab: tab }),
  setIsSkillsOpen: (v) => set({ isSkillsOpen: v }),
  setIsAddingSkill: (v) => set({ isAddingSkill: v }),
  setShowFilePicker: (v) => set({ showFilePicker: v }),
  setShowAgentPicker: (v) => set({ showAgentPicker: v }),

  // Composer
  input: "",
  preferredResponseLanguage: "zh",
  contextMentions: [],
  attachedFiles: [],
  selectedMainModeKey: "main_mode",
  selectedNexusModeKey: "nexus_general",
  activeStudioAgentKey: "studio_auto",
  gameStudioInitialized: false,
  pendingSlashCommand: null,
  pendingRunDecision: null,
  executionConsentPolicy: "ask_per_turn",
  setInput: (v) => set({ input: v }),
  setPreferredResponseLanguage: (lang) => set({ preferredResponseLanguage: lang }),
  setContextMentions: (v) => set({ contextMentions: v }),
  addMention: (file) =>
    set((s) =>
      s.contextMentions.includes(file) ? {} : { contextMentions: [...s.contextMentions, file], showFilePicker: false }
    ),
  removeMention: (file) =>
    set((s) => ({ contextMentions: s.contextMentions.filter((f) => f !== file) })),
  setAttachedFiles: (v) => set({ attachedFiles: v }),
  setSelectedMainModeKey: (key) => set({
    selectedMainModeKey: key,
    selectedNexusModeKey: mapMainModeToLegacyNexusMode(key),
  }),
  setSelectedNexusModeKey: (key) => {
    const resolved = resolveLegacyNexusModeKey(key);
    const selectedMainModeKey = mapLegacyNexusModeToMainMode(resolved);
    set({
      selectedMainModeKey,
      selectedNexusModeKey: mapMainModeToLegacyNexusMode(selectedMainModeKey),
    });
  },
  setActiveStudioAgentKey: async (key, options) => {
    const normalized = normalizeStudioAgentKey(key);
    set({ activeStudioAgentKey: normalized });
    if (options?.persistToWorkspace && get().gameStudioInitialized) {
      try {
        await setGameStudioActiveAgent(normalized);
      } catch {
        // Ignore workspace persistence failures here; in-memory state still updates.
      }
    }
  },
  setGameStudioInitialized: (value) => set({ gameStudioInitialized: value }),
  setPendingSlashCommand: (command) => set({ pendingSlashCommand: command }),
  dismissPendingRunDecision: () =>
    set({
      pendingRunDecision: null,
      pendingRunDecisionResolver: null,
    }),
  resolvePendingRunDecision: (choice) => {
    const state = get();
    const pending = state.pendingRunDecision;
    if (!pending) return;

    if (pending.kind === "execution_consent") {
      const resolver = state.pendingRunDecisionResolver;
      set({
        pendingRunDecision: null,
        pendingRunDecisionResolver: null,
      });

      if (choice === "approve_thread") {
        set({
          executionConsentPolicy: "auto_thread",
          autoApproveTools: true,
          currentTurnExecutionConsent: {
            turnId: pending.turnId ?? state.currentTurnId,
            granted: true,
          },
        });
      } else if (choice === "approve_once") {
        set({
          currentTurnExecutionConsent: {
            turnId: pending.turnId ?? state.currentTurnId,
            granted: true,
          },
        });
      } else if (choice === "cancel") {
        state.abortController?.abort();
        set({
          currentTurnExecutionConsent: {
            turnId: null,
            granted: false,
          },
          agentStatus: "idle",
          isGenerating: false,
        });
      }

      runAfterNextPaint(() => {
        resolver?.(
          choice === "approve_thread" || choice === "approve_once" || choice === "cancel"
            ? choice
            : "cancel",
        );
      });
      return;
    }

    if (choice === "cancel") {
      set({ pendingRunDecision: null });
      return;
    }

    const intentChoice = choice as ResolvedUserIntent;
    const originalImages = pending.originalImages;
    const language = detectDominantLanguage(pending.originalInput, state.config.language);
    set({ pendingRunDecision: null });
    runAfterNextPaint(() => {
      get().sendMessage(pending.originalInput, originalImages, {
        resolvedIntent: intentChoice,
        skipIntentResolution: true,
        intentSummary: buildRunIntentSummary({
          input: pending.originalInput,
          intent: intentChoice,
          language,
          reason: pending.reason,
        }),
      });
    });
  },
  refreshGameStudioWorkspaceState: async () => {
    if (!get().currentWorkspace.trim()) {
      set({ gameStudioInitialized: false, activeStudioAgentKey: "studio_auto" });
      return;
    }
    const config = await loadGameStudioConfig();
    if (!config) {
      set({ gameStudioInitialized: false, activeStudioAgentKey: "studio_auto" });
      return;
    }
    set({
      gameStudioInitialized: true,
      activeStudioAgentKey: normalizeStudioAgentKey(config.activeStudioAgent),
    });
  },
  initializeGameStudioWorkspace: async () => {
    const state = get();
    const config = await ensureGameStudioWorkspaceInitialized(state.activeStudioAgentKey);
    invalidateWorkspaceTreeCache();
    set({
      gameStudioInitialized: true,
      activeStudioAgentKey: normalizeStudioAgentKey(config.activeStudioAgent),
    });
    get().bumpWorkspaceContentVersion();
  },
  removeGameStudioWorkspace: async () => {
    await removeGameStudioWorkspaceAssets();
    invalidateWorkspaceTreeCache();
    set({
      gameStudioInitialized: false,
      activeStudioAgentKey: "studio_auto",
      pendingSlashCommand: null,
    });
    get().bumpWorkspaceContentVersion();
  },

  // ── Turn Management for Deduplication ────────────────────────────
  currentTurnId: null,
  conversationTurns: [],
  currentTurnState: createDefaultCurrentTurnState(),
  createConversationTurn: (turn) =>
    set((s) => ({
      conversationTurns: [
        ...s.conversationTurns,
        {
          ...turn,
          summary: "",
          blockIds: [],
          collapsed: false,
          createdAt: Date.now(),
        },
      ],
      currentTurnId: turn.id,
    })),
  setCurrentTurnId: (turnId) => set({ currentTurnId: turnId }),
  appendBlockToTurn: (turnId, blockId) =>
    set((s) => ({
      conversationTurns: s.conversationTurns.map((turn) =>
        turn.id === turnId && !turn.blockIds.includes(blockId)
          ? { ...turn, blockIds: [...turn.blockIds, blockId] }
          : turn
      ),
    })),
  updateConversationTurn: (turnId, patch) =>
    set((s) => ({
      conversationTurns: s.conversationTurns.map((turn) =>
        turn.id === turnId ? { ...turn, ...patch } : turn
      ),
    })),
  setConversationTurnStatus: (turnId, status) =>
    set((s) => ({
      conversationTurns: s.conversationTurns.map((turn) =>
        turn.id === turnId
          ? {
              ...turn,
              status,
              collapsed:
                status === "done"
                  ? true
                  : status === "awaiting_approval" || status === "awaiting_input" || status === "error"
                  ? false
                  : turn.collapsed,
            }
          : turn
      ),
    })),
  setConversationTurnSummary: (turnId, summary) =>
    set((s) => ({
      conversationTurns: s.conversationTurns.map((turn) =>
        turn.id === turnId ? { ...turn, summary } : turn
      ),
    })),
  toggleConversationTurnCollapsed: (turnId) =>
    set((s) => ({
      conversationTurns: s.conversationTurns.map((turn) =>
        turn.id === turnId ? { ...turn, collapsed: !turn.collapsed } : turn
      ),
    })),
  startNewTurn: () => {
    set(() => ({
      currentTurnState: {
        ...createDefaultCurrentTurnState(),
        turnId: Date.now().toString(),
      }
    }));
  },
  getCurrentRunIntent: () => {
    const state = get();
    const currentTurn = state.currentTurnId
      ? state.conversationTurns.find((turn) => turn.id === state.currentTurnId) || null
      : null;
    return currentTurn
      ? resolveConversationTurnIntent(currentTurn)
      : resolveRunIntentFromLegacyWorkflowMode(state.config.workflowMode);
  },

  // MCP servers & discovered tools
  mcpServers: [{ name: "unityMCP", type: "http", url: "http://localhost:8080/mcp" }],
  mcpDiscoveredTools: [],
  mcpToolServerMap: {},
  setMcpServers: (servers) => set({ mcpServers: servers }),
  addMcpServer: (server) => set((s) => ({ mcpServers: [...s.mcpServers, server] })),
  removeMcpServer: (name) => set((s) => ({ mcpServers: s.mcpServers.filter((sv) => sv.name !== name) })),
  setMcpDiscoveredTools: (tools, toolServerMap) => set({ mcpDiscoveredTools: tools, mcpToolServerMap: toolServerMap }),

  skills: defaultSkills,
  setSkills: (v) => set({ skills: v }),
  toggleSkill: (id) =>
    set((s) => ({ skills: s.skills.map((sk) => (sk.id === id ? { ...sk, active: !sk.active } : sk)) })),
  deleteSkill: (id) =>
    set((s) => {
      const skill = s.skills.find((sk) => sk.id === id);
      if (skill?.isBuiltIn) return s; // prevent deleting built-in skills
      // If this is a package skill, delete the extracted folder from disk
      if (skill?.type === "package" && skill.packagePath) {
        invoke("delete_protocol_package", { localPath: skill.packagePath }).catch(() => {});
      }
      return { skills: s.skills.filter((sk) => sk.id !== id) };
    }),
  addSkill: ({ name, desc, content, type, toolParameters, packagePath, entryPoint }) =>
    set((s) => ({
      skills: [...s.skills, { id: Date.now().toString(), name, desc, content: normalizeSkillContent(content), active: true, isBuiltIn: false, type: type || "instruction", toolParameters, packagePath, entryPoint }],
    })),
  updateSkill: (id, patch) =>
    set((s) => ({
      skills: s.skills.map((sk) => (sk.id === id ? { ...sk, ...patch, content: patch.content ? normalizeSkillContent(patch.content) : sk.content } : sk)),
    })),

  resolvedInstructionSet: null,
  instructionSources: [],
  loadedHookDefinitions: defaultHookDefinitions,
  hookExecutionRecords: [],
  instructionLastLoadedAt: null,
  hookLastLoadedAt: null,
  sessionHookCache: [],
  refreshInstructionAndHookState: async (associatedPaths = []) => {
    const state = get();
    if (!state.currentWorkspace.trim()) {
      set({
        resolvedInstructionSet: null,
        instructionSources: [],
        loadedHookDefinitions: defaultHookDefinitions,
        instructionLastLoadedAt: null,
        hookLastLoadedAt: null,
      });
      return;
    }

    const [resolved, hooksConfig] = await Promise.all([
      loadResolvedInstructions(state.currentWorkspace, state.skills, associatedPaths),
      loadHooksConfig(state.currentWorkspace),
    ]);

    set({
      resolvedInstructionSet: resolved,
      instructionSources: resolved.sources,
      instructionLastLoadedAt: resolved.loadedAt,
      loadedHookDefinitions: Object.values(hooksConfig.hooks).flat(),
      hookLastLoadedAt: hooksConfig.loadedAt,
    });
  },
  setResolvedInstructionSet: (resolved) =>
    set({
      resolvedInstructionSet: resolved,
      instructionSources: resolved?.sources ?? [],
      instructionLastLoadedAt: resolved?.loadedAt ?? null,
    }),
  setLoadedHookDefinitions: (hooks, loadedAt = Date.now()) =>
    set({
      loadedHookDefinitions: hooks,
      hookLastLoadedAt: loadedAt,
    }),
  appendHookExecutionRecords: (records) =>
    set((s) => ({
      hookExecutionRecords: [...records, ...s.hookExecutionRecords].slice(0, 30),
    })),
  markSessionHookInitialized: (sessionKey) =>
    set((s) => ({
      sessionHookCache: s.sessionHookCache.includes(sessionKey)
        ? s.sessionHookCache
        : [...s.sessionHookCache, sessionKey],
    })),
  hasSessionHookInitialized: (sessionKey) => get().sessionHookCache.includes(sessionKey),
  resetHookSessionCache: () => set({ sessionHookCache: [] }),

  // Sessions — nested by workspace
  sessionsByWorkspace: defaultSessionsByWorkspace,
  currentWorkspace: "",
  selectedWorkspace: "",
  currentSessionId: null,

  setCurrentWorkspace: (path: string) => {
    invalidateWorkspaceTreeCache();
    const normalizedPath = path.trim();
    if (!normalizedPath) {
      set((s) => ({
        currentWorkspace: "",
        config: { ...s.config, workspace: "" },
        sessionHookCache: [],
        showWorkspaceTreePanel: false,
      }));
      void get().refreshInstructionAndHookState();
      return;
    }
    set((s) => {
      const updated = { ...s.sessionsByWorkspace };
      if (!updated[normalizedPath]) {
        updated[normalizedPath] = [];
      }
      return {
        currentWorkspace: normalizedPath,
        selectedWorkspace: normalizedPath,
        sessionsByWorkspace: updated,
        config: { ...s.config, workspace: normalizedPath },
        sessionHookCache: [],
      };
    });
    // Register the workspace as a trusted root in the Rust backend
    setWorkspaceRootIpc(normalizedPath)
      .then(() => get().refreshInstructionAndHookState())
      .catch(() => {});
  },
  setSelectedWorkspace: (path: string) => {
    const normalizedPath = path.trim();
    set({ selectedWorkspace: normalizedPath });
  },

  addSession: (workspacePath: string, session: Session) => {
    set((s) => {
      const updated = { ...s.sessionsByWorkspace };
      if (!updated[workspacePath]) updated[workspacePath] = [];
      return {
        sessionsByWorkspace: {
          ...updated,
          [workspacePath]: [session, ...updated[workspacePath]],
        },
      };
    });
  },

  removeSession: (workspacePath: string, sessionId: number) => {
    set((s) => {
      const wsSessions = s.sessionsByWorkspace[workspacePath];
      if (!wsSessions) return {};
      const filtered = wsSessions.filter((sess) => sess.id !== sessionId);
      return {
        sessionsByWorkspace: {
          ...s.sessionsByWorkspace,
          [workspacePath]: filtered,
        },
        currentSessionId:
          s.currentSessionId === sessionId
            ? filtered[0]?.id ?? null
            : s.currentSessionId,
      };
    });
  },

  updateSession: (workspacePath: string, sessionId: number, patch: Partial<Session>) => {
    set((s) => {
      const wsSessions = s.sessionsByWorkspace[workspacePath];
      if (!wsSessions) return {};
      return {
        sessionsByWorkspace: {
          ...s.sessionsByWorkspace,
          [workspacePath]: wsSessions.map((sess) =>
            sess.id === sessionId ? { ...sess, ...patch } : sess
          ),
        },
      };
    });
  },

  setCurrentSessionId: (id: number | null) => set({ currentSessionId: id }),

  // Task Flow — now starts empty (no more mock data)
  taskFlow: [],
  setTaskFlow: (updater) => set((s) => ({ taskFlow: updater(s.taskFlow) })),

  // Elapsed time
  elapsedTime: 0,

  // Accept / Reject diff (for the RightPanel diff viewer)
  acceptDiff: (id) => {
    const state = get();
    set({ showDiff: false });
    if (state.pendingReviewResolve && state.pendingReviewTaskId === id) {
      get().allowToolAction(id);
    }
  },

  rejectDiff: (id) => {
    const state = get();
    set((s) => ({
      taskFlow: s.taskFlow.map((t) =>
        t.id === id ? { ...t, status: "error", toolStatus: "rejected", message: "Changes rejected by user." } : t
      ),
      showDiff: false,
    }));
    if (state.pendingReviewResolve && state.pendingReviewTaskId === id) {
      get().rejectToolAction(id);
    }
  },

  // ── Data Management ──────────────────────────────────────────────────

  clearChatHistory: () => {
    set((s) => {
      const ws = resolveSessionWorkspaceKey(s.currentWorkspace);
      const sessionsByWorkspace = { ...s.sessionsByWorkspace };
      if (ws) {
        delete sessionsByWorkspace[ws];
      }
      return {
        taskFlow: [],
        agentMessages: [],
        messages: [],
        selectedDiffTaskId: null,
        selectedMainModeKey: "main_mode",
        selectedNexusModeKey: "nexus_general",
        conversationTurns: [],
        currentTurnId: null,
        pendingRunDecision: null,
        pendingRunDecisionResolver: null,
        executionConsentPolicy: "ask_per_turn",
        currentTurnExecutionConsent: { turnId: null, granted: false },
        planArtifacts: [],
        planTasks: [],
        planExecutionEvidenceCount: 0,
        planStage: "idle",
        normalizedStreamState: defaultNormalizedStreamState,
        resolvedInstructionSet: null,
        instructionSources: [],
        loadedHookDefinitions: defaultHookDefinitions,
        hookExecutionRecords: [],
        instructionLastLoadedAt: null,
        hookLastLoadedAt: null,
        sessionHookCache: [],
        currentSessionId: null,
        sessionsByWorkspace,
      };
    });
  },

  resetAllSettings: () => {
    set({
      config: defaultConfig,
      skills: defaultSkills,
      mcpServers: [{ name: "unityMCP", type: "http", url: "http://localhost:8080/mcp" }],
      sessionsByWorkspace: {},
      selectedWorkspace: "",
      currentSessionId: null,
      selectedMainModeKey: "main_mode",
      selectedNexusModeKey: "nexus_general",
      taskFlow: [],
      agentMessages: [],
      messages: [],
      selectedDiffTaskId: null,
      conversationTurns: [],
      currentTurnId: null,
      pendingRunDecision: null,
      pendingRunDecisionResolver: null,
      executionConsentPolicy: "ask_per_turn",
      currentTurnExecutionConsent: { turnId: null, granted: false },
      resolvedInstructionSet: null,
      instructionSources: [],
      loadedHookDefinitions: defaultHookDefinitions,
      hookExecutionRecords: [],
      instructionLastLoadedAt: null,
      hookLastLoadedAt: null,
      sessionHookCache: [],
      planArtifacts: [],
      planTasks: [],
      planExecutionEvidenceCount: 0,
      planStage: "idle",
      normalizedStreamState: defaultNormalizedStreamState,
    });
  },

  // ── Workflow Mode ──────────────────────────────────────────────────

  isPlanApproved: false,
  planArtifacts: [],
  planStage: "idle",
  planTasks: [],
  planExecutionEvidenceCount: 0,
  normalizedStreamState: defaultNormalizedStreamState,
  setWorkflowMode: (mode) => set((s) => ({
    config: { ...s.config, workflowMode: mode },
    ...(mode === "chat" ? { showPlanPanel: false, showDiff: false } : {}),
  })),
  setIsPlanApproved: (v) => set({ isPlanApproved: v }),
  setPlanStage: (stage) => set({ planStage: stage }),
  upsertPlanArtifact: (artifact) =>
    set((s) => {
      const sanitizedContent = sanitizePlanArtifactContent(artifact.content);
      const nextArtifacts = [...s.planArtifacts];
      const existingIndex = nextArtifacts.findIndex((item) => item.path === artifact.path);
      if (existingIndex >= 0) {
        nextArtifacts[existingIndex] = { ...artifact, content: sanitizedContent };
      } else {
        nextArtifacts.push({ ...artifact, content: sanitizedContent });
      }

      const nextTasks = artifact.kind === "tasks" || artifact.kind === "bugfix"
        ? extractPlanTasks(sanitizedContent)
        : s.planTasks;
      const normalizedTasks = normalizePlanTaskStatuses(
        nextTasks.length > 0 ? nextTasks : s.planTasks,
        s.isPlanApproved && s.planExecutionEvidenceCount > 0,
      );
      const nextStage = derivePlanStageFromArtifacts(
        nextArtifacts,
        normalizedTasks,
        s.isPlanApproved,
        s.planStage,
      );

      return {
        planArtifacts: nextArtifacts.sort((a, b) => a.updatedAt - b.updatedAt),
        planStage: nextStage,
        planTasks: normalizedTasks,
        showPlanPanel: true,
        showDiff: false,
        showTerminal: false,
        rightPanelTab: "plan" as const,
      };
    }),
  clearPlanArtifacts: () =>
    set({
      planArtifacts: [],
      planStage: "idle",
      planTasks: [],
      planExecutionEvidenceCount: 0,
      normalizedStreamState: defaultNormalizedStreamState,
      showPlanPanel: false,
    }),
  deletePersistedPlanFiles: async () => {
    const state = get();
    const sessionKey = !state.currentWorkspace.trim()
      ? resolveGlobalChatSessionKey(state.currentSessionId)
      : null;
    try {
      if (sessionKey) {
        await deleteChatTempPath(sessionKey, ".MAIN/plans");
      } else {
        await deletePlanFiles();
      }
    } finally {
      invalidateWorkspaceTreeCache();
      get().clearPlanArtifacts();
      set({ isPlanApproved: false, planExecutionEvidenceCount: 0 });
      get().bumpWorkspaceContentVersion();
    }
  },
  setPlanTasks: (tasks) => set((s) => ({
    planTasks: normalizePlanTaskStatuses(tasks, s.isPlanApproved && s.planExecutionEvidenceCount > 0),
  })),
  setNormalizedStreamState: (state) => set({ normalizedStreamState: state }),
  approvePlan: () =>
    (() => {
      const state = get();

      if (state.agentStatus === "pending_review") {
        set({
          isPlanApproved: true,
          planExecutionEvidenceCount: 0,
          agentStatus: "running",
          isGenerating: true,
          planStage: "executing",
          showPlanPanel: true,
          showDiff: false,
          showTerminal: false,
          rightPanelTab: "plan",
        });
        if (state.currentTurnId) {
          get().setConversationTurnStatus(state.currentTurnId, "executing");
        }
        return;
      }

      set({
        isPlanApproved: true,
        planExecutionEvidenceCount: 0,
        planStage: "executing",
        showPlanPanel: true,
        showDiff: false,
        showTerminal: false,
        rightPanelTab: "plan",
      });

      runAfterNextPaint(() => {
        get().sendMessage(
          (() => {
            const hasTasksArtifact =
              state.planArtifacts.some((artifact) => artifact.kind === "tasks") ||
              state.planTasks.length > 0;

            if (state.config.language === "en") {
              return hasTasksArtifact
                ? "The plan is approved. Continue directly from the current tasks.md and execute the remaining items without repeating the plan.\n\n" + buildPlanCommandExecutionHint(state.planTasks, "en")
                : "The plan is approved. First generate `.MAIN/plans/tasks.md` from the approved requirements/design or bugfix, then execute the remaining work from that task list without repeating the plan. When a task needs shell work, include the exact command in backticks inside tasks.md; use run_command for finite commands, or execute_command plus PTY read/status tools for long-running or interactive commands.";
            }

            return hasTasksArtifact
              ? "计划已批准。请直接基于当前 tasks.md 继续执行剩余任务，不要重复计划内容。\n\n" + buildPlanCommandExecutionHint(state.planTasks, "zh")
              : "计划已批准。请先基于已批准的 requirements/design 或 bugfix 生成 `.MAIN/plans/tasks.md`，然后再按照任务清单继续执行，不要重复计划内容。对于需要 shell 的任务，请把精确命令写进 tasks.md 的 checkbox 并用反引号包裹；一次性命令用 run_command，长驻或交互式命令用 execute_command 后再读取 PTY 日志/状态。";
          })(),
          undefined,
          { hidden: true, reuseCurrentTurn: true, preservePlanState: true },
        );
      });
    })(),
  rejectPlan: () => {
    const state = get();
    state.abortController?.abort();
    const sessionKey = !state.currentWorkspace.trim()
      ? resolveGlobalChatSessionKey(state.currentSessionId)
      : null;
    if (sessionKey) {
      deleteChatTempPath(sessionKey, ".MAIN/plans").catch(() => {});
    } else {
      deletePlanFiles().catch(() => {});
    }
    set({
      isPlanApproved: false,
      planExecutionEvidenceCount: 0,
      agentStatus: "idle",
      isGenerating: false,
      abortController: null,
      planArtifacts: [],
      planTasks: [],
      planStage: "idle",
    });
    if (state.currentTurnId) {
      get().setConversationTurnStatus(state.currentTurnId, "done");
    }
  },
  showWorkflowMenu: false,
  setShowWorkflowMenu: (v) => set({ showWorkflowMenu: v }),

  // ── Agent Orchestrator ──────────────────────────────────────────────

  agentStatus: "idle",
  agentMessages: [],
  pendingReviewResolve: null,
  pendingReviewTaskId: null,
  pendingToolCall: null,
  autoApproveTools: false,
  currentTurnExecutionConsent: { turnId: null, granted: false },
  pendingRunDecisionResolver: null,
  setAutoApproveTools: (v) => set({ autoApproveTools: v }),
  setAgentStatus: (s) => set({ agentStatus: s }),
  resolveReview: (action) => {
    const state = get();
    if (state.pendingReviewResolve) {
      if (action === "accept") {
        get().allowToolAction(state.pendingReviewTaskId!);
      } else {
        get().rejectToolAction(state.pendingReviewTaskId!);
      }
    }
  },
  approvePendingReviewOnce: () => {
    const state = get();
    if (state.pendingReviewTaskId != null) {
      get().allowToolAction(state.pendingReviewTaskId);
    }
  },
  approvePendingReviewForSession: () => {
    const state = get();
    set({ autoApproveTools: true });
    if (state.pendingReviewTaskId != null) {
      get().allowToolAction(state.pendingReviewTaskId);
    }
  },

  /**
   * Called when user clicks "Allow & Run" on an Action Card.
   * Resolves the review gate and lets the orchestrator execute the tool once.
   */
  allowToolAction: (taskId: number) => {
    const state = get();
    if (!state.pendingReviewResolve || state.pendingReviewTaskId !== taskId) return;

    const resolve = state.pendingReviewResolve;

    set({ pendingReviewResolve: null, pendingReviewTaskId: null, pendingToolCall: null });
    set({ showDiff: false });
    runAfterNextPaint(() => {
      resolve({ action: "accept" });
    });
  },

  /**
   * Called when user clicks "Reject" on an Action Card.
   */
  rejectToolAction: (taskId: number) => {
    const state = get();
    if (!state.pendingReviewResolve || state.pendingReviewTaskId !== taskId) return;

    const resolve = state.pendingReviewResolve;

    // Clear pending state
    set({ pendingReviewResolve: null, pendingReviewTaskId: null, pendingToolCall: null });

    // Update the Action Card
    set((s) => ({
      taskFlow: s.taskFlow.map((t) =>
        t.id === taskId && t.type === "tool"
          ? { ...t, toolStatus: "rejected" as const, status: "error", message: "Rejected by user." }
          : t
      ),
      showDiff: false,
    }));

    // Resolve the orchestrator's pending review promise → loop auto-resumes
    runAfterNextPaint(() => {
      resolve({ action: "reject" });
    });
  },
  resetForWorkspace: () => {
    const state = get();
    state.abortController?.abort();
    set({
      taskFlow: [],
      messages: [],
      agentMessages: [],
      selectedDiffTaskId: null,
      input: "",
      contextMentions: [],
      attachedFiles: [],
      selectedMainModeKey: "main_mode",
      selectedNexusModeKey: "nexus_general",
      activeStudioAgentKey: "studio_auto",
      gameStudioInitialized: false,
      pendingSlashCommand: null,
      pendingRunDecision: null,
      pendingRunDecisionResolver: null,
      executionConsentPolicy: "ask_per_turn",
      agentStatus: "idle",
      isGenerating: false,
      abortController: null,
      showPlanPanel: false,
      showDiff: false,
      showTerminal: false,
      showFilePanel: false,
      rightPanelTab: "plan",
      pendingReviewResolve: null,
      pendingReviewTaskId: null,
      pendingToolCall: null,
      autoApproveTools: false,
      currentTurnExecutionConsent: { turnId: null, granted: false },
      planArtifacts: [],
      planTasks: [],
      planExecutionEvidenceCount: 0,
      planStage: "idle",
      normalizedStreamState: defaultNormalizedStreamState,
      resolvedInstructionSet: null,
      instructionSources: [],
      loadedHookDefinitions: defaultHookDefinitions,
      hookExecutionRecords: [],
      instructionLastLoadedAt: null,
      hookLastLoadedAt: null,
      sessionHookCache: [],
      fileViewerPath: "",
      fileViewerContent: "",
      fileViewerError: "",
      fileViewerLoading: false,
      conversationTurns: [],
      currentTurnId: null,
      currentSessionId: null,
      elapsedTime: 0,
    });
  },

  // ── Job List Actions ──────────────────────────────────────────────

  addJobList: (jobs: JobItem[]) => {
    const blockId = get()._nextTaskId();
    const block: TaskBlock = { id: blockId, type: "jobList", jobs };
    set((s) => ({ taskFlow: [...s.taskFlow, block] }));
    return blockId;
  },

  updateJobList: (blockId: number, updater: (jobs: JobItem[]) => JobItem[]) => {
    set((s) => ({
      taskFlow: s.taskFlow.map((t) =>
        t.id === blockId && t.type === "jobList"
          ? { ...t, jobs: updater((t as Extract<TaskBlock, { type: "jobList" }>).jobs) }
          : t
      ),
    }));
  },

  setJobStatus: (blockId: number, jobId: string, status: JobItem["status"]) => {
    get().updateJobList(blockId, (jobs) =>
      jobs.map((j) => (j.id === jobId ? { ...j, status } : j))
    );
  },

  _nextTaskId: () => ++taskIdCounter,

  /**
   * Main entry point: called when user clicks Send or presses Enter.
   *
   * Enhanced with features from the old App.tsx handleSendMessage:
   *   - Workspace tree context injection
   *   - File content reading for @-mentions and attached files
   *   - Persona system prompt
   *   - Auto-summarization on first reply
   *   - Elapsed timer tracking
   *
   * 1. Pushes user message to taskFlow
   * 2. Appends it to agentMessages (LLM conversation history)
   * 3. Launches the agent execution loop
   */
  sendMessage: (text: string, images?: string[], options?: {
    hidden?: boolean;
    reuseCurrentTurn?: boolean;
    preservePlanState?: boolean;
    resolvedIntent?: ResolvedRunIntent;
    skipIntentResolution?: boolean;
    intentSummary?: string;
    contextMentionsSnapshot?: string[];
    attachedFilesSnapshot?: string[];
  }) => {
    const state = get();
    console.log('[sendMessage] called, text:', text?.slice(0, 50), 'agentStatus:', state.agentStatus, 'workspace:', state.currentWorkspace, 'activeProfile:', state.config.activeProfile);
    const isHidden = options?.hidden === true;
    const mentionSnapshot = options?.contextMentionsSnapshot ?? state.contextMentions;
    const attachedFilesSnapshot = options?.attachedFilesSnapshot ?? state.attachedFiles;
    const hasSupplementalInput = mentionSnapshot.length > 0 || attachedFilesSnapshot.length > 0;
    const currentTurn = state.currentTurnId
      ? state.conversationTurns.find((turn) => turn.id === state.currentTurnId) || null
      : null;
    const currentTurnIntent = resolveConversationTurnIntent(currentTurn);
    const shouldAutoResumeChoiceTurn =
      !isHidden &&
      options?.reuseCurrentTurn !== true &&
      currentTurn?.status === "awaiting_input";
    const reuseCurrentTurn =
      (options?.reuseCurrentTurn === true || shouldAutoResumeChoiceTurn) &&
      !!state.currentTurnId;
    const preservePlanState =
      options?.preservePlanState === true ||
      (shouldAutoResumeChoiceTurn && currentTurnIntent === "plan");
    const preferredLanguage = isHidden
      ? state.preferredResponseLanguage
      : detectDominantLanguage(text, state.config.language);
    const currentMainModeKey = state.selectedMainModeKey;
    const parsedStudioCommand = currentMainModeKey === "game_studio"
      ? parseGameStudioSlashCommand(text)
      : null;
    const isLocalStudioCommand =
      parsedStudioCommand?.type === "agent" || parsedStudioCommand?.type === "auto";
    let effectiveRunIntent =
      options?.resolvedIntent ||
      (preservePlanState
        ? currentTurnIntent
        : resolveRunIntentFromLegacyWorkflowMode(state.config.workflowMode));
    let effectiveIntentSummary = normalizeIntentSummary(options?.intentSummary || "");

    if (!isHidden && !options?.skipIntentResolution && !options?.resolvedIntent) {
      const resolution = resolveTurnRunIntent(text, {
        language: preferredLanguage,
        mainModeKey: currentMainModeKey,
        parsedStudioCommand,
        hasPlanArtifacts: state.planArtifacts.length > 0 || state.planStage !== "idle",
        planStage: state.planStage,
        isPlanApproved: state.isPlanApproved,
      });
      effectiveIntentSummary = buildRunIntentSummary({
        input: text,
        intent: resolution.intent,
        language: preferredLanguage,
        reason: resolution.reason,
      });

      if (resolution.controlAction === "approve_plan") {
        set({
          input: "",
          contextMentions: [],
          attachedFiles: [],
          pendingRunDecision: null,
        });
        get().approvePlan();
        return true;
      }

      if (resolution.controlAction === "resume_plan_execution") {
        const hasTasksArtifact =
          state.planArtifacts.some((artifact) => artifact.kind === "tasks") ||
          state.planTasks.length > 0;
        set({
          input: "",
          contextMentions: [],
          attachedFiles: [],
          pendingRunDecision: null,
        });
        get().sendMessage(
          preferredLanguage === "en"
            ? hasTasksArtifact
              ? "Continue the remaining unfinished items in `.MAIN/plans/tasks.md` without repeating the plan. Start from the first unchecked task and update tasks.md as each item is completed."
              : "First regenerate `.MAIN/plans/tasks.md` from the approved requirements/design or bugfix, then continue the remaining execution without repeating the plan."
            : hasTasksArtifact
            ? "请继续执行 `.MAIN/plans/tasks.md` 中剩余未完成的任务，不要重复计划说明。先从第一个未完成 checkbox 对应的任务开始，完成后及时更新 tasks.md。"
            : "请先基于已批准的 requirements/design 或 bugfix 重新生成 `.MAIN/plans/tasks.md`，然后继续执行剩余任务，不要重复计划说明。",
          undefined,
          {
            hidden: true,
            reuseCurrentTurn: true,
            preservePlanState: true,
            resolvedIntent: "plan",
            skipIntentResolution: true,
          },
        );
        return true;
      }

      if (resolution.needsDecision) {
        const pendingCopy = createPendingDecisionCopy(resolution, preferredLanguage);
        set({
          pendingRunDecision: {
            kind: "intent_confirmation",
            source: "pre_submit",
            originalInput: text,
            originalImages: images || [],
            suggestedIntent: resolution.suggestedIntent || "plan",
            reason: pendingCopy.reason,
            title: pendingCopy.title,
            options: pendingCopy.options,
          },
        });
        return true;
      }

      if (
        currentMainModeKey === "main_mode" &&
        !resolution.bypassMainRouter &&
        resolution.confidence < 0.9
      ) {
        void (async () => {
          const preflight = await runIntentPreflight({
            input: text,
            language: preferredLanguage,
            mainModeKey: currentMainModeKey,
            config: get().config,
          });

          if (preflight?.needsUserChoice) {
            const fallbackCopy = createPendingDecisionCopy(
              {
                suggestedIntent: preflight.intent,
                decisionOptions: preflight.options?.map((option) => option.id),
                riskLevel: resolution.riskLevel,
                reason: resolution.reason,
              },
              preferredLanguage,
            );
            set({
              pendingRunDecision: {
                kind: "intent_confirmation",
                source: "preflight",
                originalInput: text,
                originalImages: images || [],
                suggestedIntent: preflight.intent,
                reason: resolution.reason,
                title: preflight.question || fallbackCopy.title,
                options: preflight.options?.length ? preflight.options : fallbackCopy.options,
              },
            });
            return;
          }

          const resolvedByPreflight =
            preflight?.intent === "studio_workflow" ? resolution.intent : preflight?.intent;
          const resolvedIntent = resolvedByPreflight || resolution.intent;

          get().sendMessage(text, images, {
            ...(options || {}),
            resolvedIntent,
            skipIntentResolution: true,
            intentSummary: buildRunIntentSummary({
              input: text,
              intent: resolvedIntent,
              language: preferredLanguage,
              preflightSummary: preflight?.summary,
              reason: preflight?.reason || resolution.reason,
            }),
          });
        })();
        return true;
      }

      effectiveRunIntent = resolution.intent;
    }

    if (!effectiveIntentSummary) {
      effectiveIntentSummary = buildRunIntentSummary({
        input: text,
        intent: effectiveRunIntent,
        language: preferredLanguage,
      });
    }

    const effectiveWorkflowMode = mapResolvedRunIntentToWorkflowMode(effectiveRunIntent);
    const initialTurnStatus: ConversationTurnStatus = effectiveRunIntent === "plan" ? "planning" : "executing";

    // Reset plan approval state at the start of each new request
    if (!preservePlanState && !isLocalStudioCommand) {
      set({
        isPlanApproved: false,
        planExecutionEvidenceCount: 0,
        normalizedStreamState: defaultNormalizedStreamState,
        planArtifacts: [],
        planTasks: [],
        planStage: "idle" as const,
        currentTurnExecutionConsent: { turnId: null, granted: false },
      });
    }

    if (!text.trim() && (!images || images.length === 0) && !hasSupplementalInput) {
      console.log('[sendMessage] blocked: empty text, no images, and no attached context');
      return false;
    }

    if (state.isGenerating) {
      console.log('[sendMessage] blocked: generation already in progress');
      return false;
    }

    if (state.agentStatus === "running" || state.agentStatus === "pending_review") {
      // ── Stuck-state recovery ──────────────────────────────────────
      // If agentStatus is stuck at "running" but there's no abortController,
      // the previous stream must have failed silently. Reset to idle so
      // the user isn't permanently blocked from sending messages.
      if ((state.agentStatus === "running" || state.agentStatus === "pending_review") && !state.abortController) {
        console.log('[sendMessage] stuck-state detected, resetting to idle');
        set({ agentStatus: "idle", isGenerating: false });
        if (state.currentTurnId) {
          get().setConversationTurnStatus(
            state.currentTurnId,
            state.agentStatus === "pending_review" ? "awaiting_approval" : "done",
          );
        }
        // Re-check after state reset
        if (!text.trim() && (!images || images.length === 0) && !hasSupplementalInput) return false;
      } else {
        console.log('[sendMessage] blocked: empty text or already running');
        return false;
      }
    }
    const sessionScopeKey = resolveSessionWorkspaceKey(state.currentWorkspace);
    let ensuredSessionId = state.currentSessionId;
    const workspaceSessions = state.sessionsByWorkspace[sessionScopeKey] || [];
    if (!ensuredSessionId && workspaceSessions.length === 0) {
      const autoSessionId = Date.now();
      const autoSessionTitle = state.currentWorkspace.trim()
        ? (state.config.language === "en" ? "New Conversation" : "新会话")
        : (state.config.language === "en" ? "New Chat" : "新聊天");
      const autoSession: Session = {
        id: autoSessionId,
        title: autoSessionTitle,
        date: new Date().toISOString(),
        active: true,
        messages: [],
      };

      set((s) => ({
        sessionsByWorkspace: {
          ...s.sessionsByWorkspace,
          [sessionScopeKey]: [autoSession, ...(s.sessionsByWorkspace[sessionScopeKey] || [])],
        },
        currentSessionId: autoSessionId,
      }));

      ensuredSessionId = autoSessionId;
    }

    const nextId = get()._nextTaskId;
    const turnId = reuseCurrentTurn ? state.currentTurnId! : `turn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const existingTurn = reuseCurrentTurn
      ? state.conversationTurns.find((turn) => turn.id === state.currentTurnId) || null
      : null;
    const turnTitle = existingTurn?.title || summarizeUserPrompt(text);
    const refreshedState = get();
    const activeSession = ensuredSessionId
      ? (refreshedState.sessionsByWorkspace[sessionScopeKey] || []).find((session) => session.id === ensuredSessionId)
      : null;
    const shouldSeedSessionTitle = !!activeSession && (
      !String(activeSession.title || "").trim() ||
      activeSession.title === "New Conversation" ||
      activeSession.title === "新会话" ||
      (activeSession.messages?.length ?? 0) === 0
    );
    const appendLocalStudioTurn = async (systemContent: string) => {
      const userBlock = isHidden
        ? null
        : ({
            id: nextId(),
            turnId,
            type: "user",
            content: text,
          } as TaskBlock);
      const systemBlock: TaskBlock = {
        id: nextId(),
        turnId,
        type: "system",
        content: systemContent,
      };

      set((s) => ({
        taskFlow: [...s.taskFlow, ...(userBlock ? [userBlock] : []), systemBlock],
        conversationTurns: reuseCurrentTurn
          ? s.conversationTurns.map((turn) =>
              turn.id === turnId
                ? {
                    ...turn,
                    status: "done",
                    intentSummary: turn.intentSummary || effectiveIntentSummary,
                    blockIds: [...turn.blockIds, ...(userBlock ? [userBlock.id] : []), systemBlock.id].filter(
                      (value, index, array) => array.indexOf(value) === index,
                    ),
                  }
                : turn,
            )
          : [
              ...s.conversationTurns,
              {
                id: turnId,
                userPrompt: text,
                title: turnTitle,
                intentSummary: effectiveIntentSummary,
                mode: effectiveWorkflowMode,
                intent: effectiveRunIntent,
                status: "done",
                summary: systemContent,
                blockIds: [...(userBlock ? [userBlock.id] : []), systemBlock.id],
                collapsed: false,
                createdAt: Date.now(),
              },
            ],
        currentTurnId: turnId,
        input: isHidden ? s.input : "",
        contextMentions: [],
        attachedFiles: [],
        pendingSlashCommand: null,
        pendingRunDecision: null,
        preferredResponseLanguage: preferredLanguage,
        isGenerating: false,
        agentStatus: "idle",
        elapsedTime: 0,
      }));

      if (!isHidden && shouldSeedSessionTitle && ensuredSessionId) {
        get().updateSession(sessionScopeKey, ensuredSessionId, {
          title: turnTitle,
          active: true,
          runtimeSnapshot: normalizeSessionRuntimeSnapshot({
            taskFlow: get().taskFlow,
            agentMessages: get().agentMessages,
            conversationTurns: get().conversationTurns,
            currentTurnId: get().currentTurnId,
            selectedMainModeKey: get().selectedMainModeKey,
            selectedNexusModeKey: get().selectedNexusModeKey,
            activeStudioAgentKey: get().activeStudioAgentKey,
            gameStudioInitialized: get().gameStudioInitialized,
            pendingSlashCommand: get().pendingSlashCommand,
            planArtifacts: get().planArtifacts,
            planTasks: get().planTasks,
            planExecutionEvidenceCount: get().planExecutionEvidenceCount,
            planStage: get().planStage,
            isPlanApproved: get().isPlanApproved,
            showPlanPanel: get().showPlanPanel,
            showDiff: get().showDiff,
            showTerminal: get().showTerminal,
            showFilePanel: get().showFilePanel,
            rightPanelTab: get().rightPanelTab,
            selectedDiffTaskId: get().selectedDiffTaskId,
          }),
        });
      }
    };

    if (parsedStudioCommand?.type === "agent") {
      void get().setActiveStudioAgentKey(parsedStudioCommand.slug, {
        persistToWorkspace: get().gameStudioInitialized,
      });
      void appendLocalStudioTurn(
        `Game Studio 当前专家已切换为 \`${parsedStudioCommand.slug}\`。后续普通消息会默认按该专家视角继续；发送 \`/auto\` 可恢复自动编排。`,
      );
      return true;
    }

    if (parsedStudioCommand?.type === "auto") {
      void get().setActiveStudioAgentKey("studio_auto", {
        persistToWorkspace: get().gameStudioInitialized,
      });
      void appendLocalStudioTurn("Game Studio 已恢复自动编排。后续消息将不再固定绑定某个专家。");
      return true;
    }

    // 1. Push user message to visible taskFlow
    const currentImages = images || [];
    const userBlock: TaskBlock | null = isHidden
      ? null
      : {
          id: nextId(),
          turnId,
          type: "user",
          content: text,
          ...(currentImages.length > 0 ? { images: currentImages } : {}),
        };
    set((s) => ({
      ...(userBlock
        ? {
            taskFlow: [...s.taskFlow, userBlock],
            conversationTurns: reuseCurrentTurn
              ? s.conversationTurns.map((turn) =>
                  turn.id === turnId
                ? {
                    ...turn,
                    status: initialTurnStatus,
                    intent: effectiveRunIntent,
                    intentSummary: turn.intentSummary || effectiveIntentSummary,
                    mode: effectiveWorkflowMode,
                    blockIds: turn.blockIds.includes(userBlock.id) ? turn.blockIds : [...turn.blockIds, userBlock.id],
                  }
                    : turn
                )
              : [
                  ...s.conversationTurns,
                  {
                    id: turnId,
                    userPrompt: text,
                    title: turnTitle,
                    intentSummary: effectiveIntentSummary,
                    mode: effectiveWorkflowMode,
                    intent: effectiveRunIntent,
                    status: initialTurnStatus,
                    summary: "",
                    blockIds: [userBlock.id],
                    collapsed: false,
                    createdAt: Date.now(),
                  },
                ],
          }
        : reuseCurrentTurn
        ? {
            conversationTurns: s.conversationTurns.map((turn) =>
              turn.id === turnId
                ? {
                    ...turn,
                    status: initialTurnStatus,
                    intent: effectiveRunIntent,
                    intentSummary: turn.intentSummary || effectiveIntentSummary,
                    mode: effectiveWorkflowMode,
                  }
                : turn
            ),
          }
        : {}),
      currentTurnId: turnId,
      input: isHidden ? s.input : "",
      preferredResponseLanguage: preferredLanguage,
      pendingSlashCommand: parsedStudioCommand?.type === "workflow" ? parsedStudioCommand : null,
      pendingRunDecision: null,
      isGenerating: true,
      config: { ...s.config, workflowMode: effectiveWorkflowMode },
      ...(preservePlanState ? {} : { isPlanApproved: false }),
      elapsedTime: 0,
    }));

    if (!isHidden && shouldSeedSessionTitle && ensuredSessionId) {
      get().updateSession(sessionScopeKey, ensuredSessionId, { title: turnTitle, active: true });
    }

    // 2. Start elapsed timer
    const startTime = Date.now();
    const timerInterval = setInterval(() => {
      const state = get();
      if (state.agentStatus === "idle" || state.agentStatus === "error") {
        clearInterval(timerInterval);
        return;
      }
      set({ elapsedTime: Math.round((Date.now() - startTime) / 1000) });
    }, 200);

    // 3. Build context from @-mentions and attached files
    // Read actual file contents for attached files (from old App.tsx)
    (async () => {
      let userContent = text;
      let activeStudioAgentKey = get().activeStudioAgentKey;
      let gameStudioInitialized = get().gameStudioInitialized;
      const mentions = mentionSnapshot;
      const files = attachedFilesSnapshot;
      const allFilePaths = [...new Set([...files, ...mentions])];

      if (allFilePaths.length > 0) {
        const parts: string[] = [];
        for (const fp of allFilePaths) {
          try {
            let c: string;
            if (shouldUseTabularAnalyzer(fp)) {
              const summary = await analyzeTabularDocument(fp);
              const preview = await readDocument(fp, 3000, 12, 0, 40);
              const compactSummary = {
                rowCount: summary.metadata.rowCount,
                columnCount: summary.metadata.columnCount,
                columns: Array.isArray(summary.metadata.columns)
                  ? (summary.metadata.columns as unknown[]).slice(0, 40)
                  : summary.metadata.columns,
                numericColumns: Array.isArray(summary.metadata.numericColumns)
                  ? (summary.metadata.numericColumns as unknown[]).slice(0, 20)
                  : summary.metadata.numericColumns,
                categoricalColumns: Array.isArray(summary.metadata.categoricalColumns)
                  ? (summary.metadata.categoricalColumns as unknown[]).slice(0, 20)
                  : summary.metadata.categoricalColumns,
                datetimeColumns: Array.isArray(summary.metadata.datetimeColumns)
                  ? (summary.metadata.datetimeColumns as unknown[]).slice(0, 20)
                  : summary.metadata.datetimeColumns,
                sampleHead: summary.sampleRows.head,
                sampleTail: summary.sampleRows.tail,
              };
              c = [
                "[attached_tabular_file]",
                `path: ${fp}`,
                `documentType: ${preview.documentType}`,
                `sourceName: ${summary.sourceName}`,
                `truncatedPreview: ${preview.truncated ? "true" : "false"}`,
                "note: The preview below is not guaranteed to be the full file. Use analyze_tabular_document, query_tabular_document, or read_document on this exact path for full-file reasoning.",
                "[summary]",
                JSON.stringify(compactSummary, null, 2),
                "[preview]",
                preview.content || JSON.stringify(preview.metadata),
              ].join("\n");
            } else if (shouldUseDocumentReader(fp)) {
              const doc = await readDocument(fp);
              const header = [
                "[attached_document]",
                `path: ${fp}`,
                `documentType: ${doc.documentType}`,
                `truncatedPreview: ${doc.truncated ? "true" : "false"}`,
              ];
              if (doc.title) header.push(`title: ${doc.title}`);
              header.push("note: If this preview is truncated, use read_document on the exact path above before concluding.");
              const body = doc.content || JSON.stringify(doc.metadata);
              c = `${header.join("\n")}\n${body}`;
            } else {
              const raw = await invoke<string>("read_file", { path: fp });
              c = `[attached_file]\npath: ${fp}\n${raw}`;
            }
            const n = fp.split("/").pop() || fp;
            parts.push("```" + n + "\n" + c + "\n```");
          } catch {
            const n = fp.split("/").pop() || fp;
            parts.push(`[无法读取文件：${n}]`);
          }
        }
        userContent = parts.join("\n\n") + "\n\n" + text;
      }

      const shouldUseGameStudioEnvelope =
        currentMainModeKey === "game_studio" &&
        (
          parsedStudioCommand?.type === "workflow" ||
          activeStudioAgentKey !== "studio_auto" ||
          gameStudioInitialized
        );

      if (
        currentMainModeKey === "game_studio" &&
        !gameStudioInitialized &&
        (parsedStudioCommand?.type === "workflow" || activeStudioAgentKey !== "studio_auto")
      ) {
        try {
          const studioConfig = await ensureGameStudioWorkspaceInitialized(activeStudioAgentKey);
          activeStudioAgentKey = normalizeStudioAgentKey(studioConfig.activeStudioAgent);
          gameStudioInitialized = true;
          invalidateWorkspaceTreeCache();
          set({
            gameStudioInitialized: true,
            activeStudioAgentKey,
          });
          get().bumpWorkspaceContentVersion();
        } catch (error) {
          clearInterval(timerInterval);
          const failureId = nextId();
          set((s) => ({
            taskFlow: [
              ...s.taskFlow,
              {
                id: failureId,
                turnId,
                type: "system",
                content: `Game Studio 初始化失败：${error instanceof Error ? error.message : String(error)}`,
              } as TaskBlock,
            ],
            conversationTurns: s.conversationTurns.map((turn) =>
              turn.id === turnId
                ? {
                    ...turn,
                    status: "error",
                    blockIds: turn.blockIds.includes(failureId) ? turn.blockIds : [...turn.blockIds, failureId],
                  }
                : turn,
            ),
            agentStatus: "error",
            isGenerating: false,
            abortController: null,
            pendingSlashCommand: null,
          }));
          return;
        }
      }

      if (shouldUseGameStudioEnvelope) {
        userContent = buildGameStudioEnvelopeForTurn({
          originalText: userContent,
          nexusMode: mapMainModeToLegacyNexusMode(currentMainModeKey),
          activeStudioAgent: activeStudioAgentKey,
          command: parsedStudioCommand?.type === "workflow" ? parsedStudioCommand : null,
        });
      }

      // Clear mentions and attached files after reading
      set({ contextMentions: [], attachedFiles: [] });

      // 4. Append to LLM conversation history
      // Build multimodal content if images are present
      let agentUserMsg: AgentMessage;
      if (currentImages.length > 0) {
        const parts: ContentPart[] = [];
        // Add images first, then text
        for (const dataUrl of currentImages) {
          parts.push({ type: "image_url", image_url: { url: dataUrl } });
        }
        if (userContent.trim()) {
          parts.push({ type: "text", text: userContent });
        }
        agentUserMsg = { role: "user", content: parts };
      } else {
        agentUserMsg = { role: "user", content: userContent };
      }
      set((s) => ({ agentMessages: [...s.agentMessages, agentUserMsg] }));

      // 5. Create AbortController and launch the loop
      const abortCtrl = new AbortController();
      set({ abortController: abortCtrl });

      // Track the current streaming assistant block
      let currentStreamingBlockId: number | null = null;
      // Track thought timing for duration display
      let thoughtStartTime: number | null = null;
      // Current streaming thought block id (for live updates)
      let currentThoughtBlockId: number | null = null;

      // Title generation guard — only generate once per conversation
      let titleGenerated = false;

      // Thinking tag interceptor — catches <thinking>/<thought>/<analysis>/<reasoning>
      // tags during streaming and routes content to a ThoughtBlock instead of the
      // agent block. Prevents thinking content from briefly appearing as plain text.
      const thinkingInterceptor = new StreamingThinkingInterceptor();

      // ── Turn-based thought deduplication state ──────────────────────────
      // Prevents triple repetition when reasoning is emitted via multiple paths.
      // We rely entirely on the Zustand store's `currentTurnState` which is reset via `startNewTurn()`.

      // 将新产生的可视块自动挂到当前回合，避免聊天区之后再靠扫描推断归属。
      const appendTurnBlock = (block: TaskBlock) => {
        const blockWithTurn: TaskBlock = { ...block, turnId: block.turnId ?? turnId };
        set((s) => ({
          taskFlow: [...s.taskFlow, blockWithTurn],
          conversationTurns: s.conversationTurns.map((turn) =>
            turn.id === turnId && !turn.blockIds.includes(blockWithTurn.id)
              ? { ...turn, blockIds: [...turn.blockIds, blockWithTurn.id] }
              : turn
          ),
        }));
      };

      // ── RAF-batched streaming update ──────────────────────────────────
      // Instead of calling set() for every character (which causes
      // thousands of React re-renders), we buffer incoming tokens and
      // flush them once per animation frame (~60 fps).
      let tokenBuffer = "";
      let rafHandle: number | null = null;

      const flushBuffer = () => {
        const chunk = tokenBuffer;
        tokenBuffer = "";
        rafHandle = null;

        if (!chunk) return;

        // Run through the thinking interceptor
        const { agent, thinking, thoughtStarted, thoughtEnded } = thinkingInterceptor.feed(chunk);

        // ── Handle thinking content ──
        if (thoughtStarted) {
          thoughtStartTime = Date.now();
          const thoughtId = nextId();
          currentThoughtBlockId = thoughtId;
          const thoughtBlock: TaskBlock = {
            id: thoughtId,
            turnId,
            type: "thought",
            content: thinking,
            isStreaming: true,
          };
          appendTurnBlock(thoughtBlock);
          set((s) => ({
            currentTurnState: {
              ...s.currentTurnState,
              interceptorHandled: true,
              interceptorThought: thinking
            }
          }));
        } else if (currentThoughtBlockId !== null && thinking) {
          // Append to existing thought block
          const tid = currentThoughtBlockId;
          set((s) => ({
            taskFlow: s.taskFlow.map((t) =>
              t.id === tid && t.type === "thought"
                ? { ...t, content: (t as Extract<TaskBlock, { type: "thought" }>).content + thinking }
                : t
            ),
            currentTurnState: {
              ...s.currentTurnState,
              interceptorThought: s.currentTurnState.interceptorThought + thinking
            }
          }));
        }

        if (thoughtEnded && currentThoughtBlockId !== null) {
          // Finalize the thought block
          const tid = currentThoughtBlockId;
          const duration = thoughtStartTime ? Math.round((Date.now() - thoughtStartTime) / 1000) : undefined;
          set((s) => ({
            taskFlow: s.taskFlow.map((t) =>
              t.id === tid && t.type === "thought"
                ? { ...t, isStreaming: false, duration }
                : t
            ),
          }));
          // Auto-collapse after a brief display
          setTimeout(() => {
            set((s) => ({
              taskFlow: s.taskFlow.map((t) =>
                t.id === tid && t.type === "thought"
                  ? { ...t, isStreaming: false }
                  : t
              ),
            }));
          }, 1200);
          currentThoughtBlockId = null;
          thoughtStartTime = null;
        }

        // ── Handle agent content ──
        let agentContent = agent;
        if (!agentContent) return;

        // Cross-type deduplication: If this is the start of the agent reply and it repeats thought content, strip it.
        const currentTurn = get().currentTurnState;
        if (currentTurn.interceptorThought && currentStreamingBlockId === null) {
          const normThought = currentTurn.interceptorThought.trim().toLowerCase().replace(/\s+/g, ' ');
          const normAgent = agentContent.trim().toLowerCase().replace(/\s+/g, ' ');
          
          if (normAgent.startsWith(normThought) || normThought.includes(normAgent)) {
             // If the reasoning is being echo'd in the agent text, we try to wait for real content
             // or strip the overlap if we already have the full block.
             const overlapLen = currentTurn.interceptorThought.trim().length;
             const possibleClean = agentContent.trim().slice(overlapLen).trim();
             if (!possibleClean) return; // Full duplication, skip this token chunk
             agentContent = possibleClean;
          }
        }

        if (currentStreamingBlockId === null) {
          const blockId = nextId();
          currentStreamingBlockId = blockId;
          const block: TaskBlock = { id: blockId, turnId, type: "agent", content: agentContent, streaming: true };
          appendTurnBlock(block);
        } else {
          const blockId = currentStreamingBlockId;
          set((s) => ({
            taskFlow: s.taskFlow.map((t) =>
              t.id === blockId && t.type === "agent"
                ? { ...t, content: (t as Extract<TaskBlock, { type: "agent" }>).content + agentContent }
                : t
            ),
          }));
        }
      };

      const scheduleFlush = () => {
        if (rafHandle === null) {
          rafHandle = requestAnimationFrame(flushBuffer);
        }
      };

      // Get workspace tree for system prompt
      const workspaceTree = await getWorkspaceTree(state.currentWorkspace);

      const callbacks: OrchestratorCallbacks = {
        getMessages: () => get().agentMessages,
        getConfig: () => get().config,
        getPreferredLanguage: () => get().preferredResponseLanguage || get().config.language,
        getSkills: () => get().skills,
        getMainModeKey: () => get().selectedMainModeKey,
        getActiveStudioAgentKey: () => get().activeStudioAgentKey,
        getGameStudioInitialized: () => get().gameStudioInitialized,
        getPendingSlashCommand: () => get().pendingSlashCommand,
        getWorkspaceTree: () => workspaceTree,
        getMcpServers: () => get().mcpServers,
        getMcpDiscoveredTools: () => get().mcpDiscoveredTools,
        getAssociatedPaths: () => get().resolvedInstructionSet?.associatedPaths ?? [],
        getSessionKey: () => `${resolveSessionWorkspaceKey(get().currentWorkspace)}:${get().currentSessionId}`,
        hasSessionHookInitialized: (key) => get().hasSessionHookInitialized(key),
        markSessionHookInitialized: (key) => get().markSessionHookInitialized(key),
        onInstructionsResolved: (resolved) => get().setResolvedInstructionSet(resolved),
        onHooksLoaded: (hooks, loadedAt) => get().setLoadedHookDefinitions(hooks, loadedAt),
        onHookStart: (_event, _hook) => { /* UI feedback placeholder */ },
        onHookResult: (record) => get().appendHookExecutionRecords([record]),
        onHookBlocked: (_event, _reason, _record) => { /* UI feedback placeholder */ },
        getCurrentRunIntent: () => get().getCurrentRunIntent(),
        getWorkflowMode: () => mapResolvedRunIntentToWorkflowMode(get().getCurrentRunIntent()),
        getIsPlanApproved: () => get().isPlanApproved,
        getPlanStage: () => get().planStage,
        getPlanTasks: () => get().planTasks,
        getStatus: () => get().agentStatus,
        startNewTurn: () => get().startNewTurn(),

        onStreamToken: (token, _msgId) => {
          // Handle escalation reset signal
          if (token.startsWith("__ESCALATION_RESET__:")) {
            // Reset the streaming block content for retry
            if (currentStreamingBlockId !== null) {
              const blockId = currentStreamingBlockId;
              set((s) => ({
                taskFlow: s.taskFlow.map((t) =>
                  t.id === blockId && t.type === "agent"
                    ? { ...t, content: "" }
                    : t
                ),
              }));
            }
            return;
          }

          if (thoughtStartTime === null) thoughtStartTime = Date.now();
          tokenBuffer += token;
          scheduleFlush();
        },

        onStreamDone: (_fullText, _msgId, truncated) => {
          // Flush any remaining buffered tokens
          if (rafHandle !== null) {
            cancelAnimationFrame(rafHandle);
            rafHandle = null;
          }
          if (tokenBuffer) {
            flushBuffer();
          }

          // Flush any remaining thinking interceptor state
          const { agent: remainingAgent, thoughtEnded } = thinkingInterceptor.flush();
          if (remainingAgent) {
            if (currentStreamingBlockId === null) {
              const blockId = nextId();
              currentStreamingBlockId = blockId;
              const block: TaskBlock = { id: blockId, turnId, type: "agent", content: remainingAgent, streaming: false };
              appendTurnBlock(block);
            } else {
              const blockId = currentStreamingBlockId;
              set((s) => ({
                taskFlow: s.taskFlow.map((t) =>
                  t.id === blockId && t.type === "agent"
                    ? { ...t, content: (t as Extract<TaskBlock, { type: "agent" }>).content + remainingAgent }
                    : t
                ),
              }));
            }
          }

          if (thoughtEnded && currentThoughtBlockId !== null) {
            const tid = currentThoughtBlockId;
            const duration = thoughtStartTime ? Math.round((Date.now() - thoughtStartTime) / 1000) : undefined;
            set((s) => ({
              taskFlow: s.taskFlow.map((t) =>
                t.id === tid && t.type === "thought"
                  ? { ...t, isStreaming: false, duration }
                  : t
              ),
            }));
            currentThoughtBlockId = null;
            thoughtStartTime = null;
          }

          if (currentStreamingBlockId !== null) {
            const blockId = currentStreamingBlockId;
            // Strip any residual thinking XML tags from the agent block
            set((s) => ({
              taskFlow: s.taskFlow.map((t) => {
                if (t.id === blockId && t.type === "agent") {
                  const content = (t as Extract<TaskBlock, { type: "agent" }>).content;
                  const cleaned = content
                    .replace(/<(?:analysis|thought|thinking|reasoning)(?:\s[^>]*)?>[\s\S]*?<\/(?:analysis|thought|thinking|reasoning)>/g, "")
                    .replace(/<\/?(?:analysis|thought|thinking|reasoning)(?:\s[^>]*)?>/g, "")
                    .trim();
                  return { ...t, content: cleaned, streaming: false };
                }
                return t;
              }),
            }));
            currentStreamingBlockId = null;
          }

          // Show truncation warning if the model hit max_tokens
          if (truncated) {
            const warnId = nextId();
            const warnBlock: TaskBlock = {
              id: warnId,
              turnId,
              type: "thought",
              content: "⚠️ 回复被截断 — 模型达到了最大 token 限制。回复可能不完整。",
              isStreaming: false,
              duration: 0,
            };
            appendTurnBlock(warnBlock);
          }

          // ── Auto-generate conversation title on first streaming turn ──
          if (!titleGenerated && text.trim()) {
            titleGenerated = true;
            // Use thought blocks as fallback when agent block is empty (e.g. all content was in <analysis> tags)
            const tf = get().taskFlow;
            const lastAgent = [...tf].reverse().find(t => t.type === "agent");
            const lastThought = [...tf].reverse().find(t => t.type === "thought");
            const assistantContent = (lastAgent?.content?.trim()) || (lastThought?.content?.trim?.()) || "";
            if (assistantContent || text.trim()) {
              triggerAutoSummarize(
                text,
                assistantContent,
                get().config,
                resolveSessionWorkspaceKey(get().currentWorkspace),
                get().currentSessionId,
                get().updateSession,
              );
            }
          }

          set((s) => ({
            normalizedStreamState: {
              ...s.normalizedStreamState,
              finishReason: truncated ? "length" : "stop",
            },
          }));
        },

        onThought: (thought) => {
          const duration = thoughtStartTime
            ? Math.round((Date.now() - thoughtStartTime) / 1000)
            : undefined;

          // ── Turn-based deduplication: clean matching ──────────────
          const normalizeForComp = (s: string) => s.trim().replace(/\s+/g, ' ');
          const incoming = normalizeForComp(thought);
          
          const currentTurn = get().currentTurnState;

          // ── Interceptor dedup: if StreamingThinkingInterceptor already
          // captured and rendered this exact content, skip it entirely.
          // This prevents the double-extraction bug where both the
          // streaming interceptor and the post-parse onThought create
          // identical thought blocks.
          if (currentTurn.interceptorHandled && currentTurn.interceptorThought) {
            const interceptorNorm = normalizeForComp(currentTurn.interceptorThought);
            if (interceptorNorm === incoming || interceptorNorm.includes(incoming) || incoming.includes(interceptorNorm)) {
              return;
            }
          }
          
          // If this exact text (or a subset) was already reported in this turn, ignore it.
          if (currentTurn.lastReportedThought.includes(incoming)) {
            return;
          }

          // Update turn state
          set((s) => ({
            normalizedStreamState: {
              ...s.normalizedStreamState,
              hiddenThought: `${s.normalizedStreamState.hiddenThought}\n\n${thought}`.trim(),
            },
            currentTurnState: {
              ...s.currentTurnState,
              lastReportedThought: s.currentTurnState.lastReportedThought + " " + thought
            }
          }));

          const currentFlow = get().taskFlow;
          const lastBlock = currentFlow[currentFlow.length - 1];

          if (lastBlock && lastBlock.type === "thought") {
            const existing = normalizeForComp((lastBlock as Extract<TaskBlock, { type: "thought" }>).content);
            
            // If the incoming thought is already present, update metadata and avoid duplication.
            if (existing.includes(incoming)) {
              if (duration !== undefined) {
                const tid = lastBlock.id;
                set((s) => ({
                  taskFlow: s.taskFlow.map((t) =>
                    t.id === tid && t.type === "thought"
                      ? { ...t, duration, isStreaming: false, content: incoming.length > existing.length ? thought : t.content }
                      : t
                  ),
                }));
              }
              return;
            }
            const tid = lastBlock.id;
            set((s) => ({
              taskFlow: s.taskFlow.map((t) =>
                t.id === tid && t.type === "thought"
                  ? { ...t, content: (t as Extract<TaskBlock, { type: "thought" }>).content + "\n" + thought, isStreaming: true, duration }
                  : t
              ),
            }));
            // Auto-collapse after a brief display period
            setTimeout(() => {
              set((s) => ({
                taskFlow: s.taskFlow.map((t) =>
                  t.id === tid && t.type === "thought"
                    ? { ...t, isStreaming: false }
                    : t
                ),
              }));
              thoughtStartTime = null;
            }, 1200);
          } else {
            // No adjacent thought block — create a new one
            const thoughtBlockId = nextId();
            const block: TaskBlock = {
              id: thoughtBlockId,
              turnId,
              type: "thought",
              content: thought,
              isStreaming: true,
              duration,
            };
            appendTurnBlock(block);

            // Auto-collapse after a brief display period
            setTimeout(() => {
              set((s) => ({
                taskFlow: s.taskFlow.map((t) =>
                  t.id === thoughtBlockId && t.type === "thought"
                    ? { ...t, isStreaming: false }
                    : t
                ),
              }));
              thoughtStartTime = null;
            }, 1200);
          }
        },

        onAssistantText: (text: string) => {
          if (!text.trim()) return;
          
          // Cross-type deduplication for non-streaming flushes
          const currentTurn = get().currentTurnState;
          let cleanText = text;
          if (currentTurn.lastReportedThought) {
            const normThought = currentTurn.lastReportedThought.trim().toLowerCase().replace(/\s+/g, ' ');
            const normText = text.trim().toLowerCase().replace(/\s+/g, ' ');
            if (normText.startsWith(normThought)) {
              cleanText = text.trim().slice(currentTurn.lastReportedThought.trim().length).trim();
              if (!cleanText) return;
            }
          }

          const latestBlock = get().taskFlow[get().taskFlow.length - 1];
          if (!latestBlock || latestBlock.type !== "agent" || latestBlock.turnId !== turnId) {
            appendTurnBlock({ id: nextId(), turnId, type: "agent", content: cleanText, streaming: true });
            set((s) => ({
              normalizedStreamState: {
                ...s.normalizedStreamState,
                visibleText: cleanText,
              },
            }));
            return;
          }

          set((s) => ({
            normalizedStreamState: {
              ...s.normalizedStreamState,
              visibleText: `${s.normalizedStreamState.visibleText}\n${cleanText}`.trim(),
            },
            taskFlow: s.taskFlow.map((t, idx) =>
              idx === s.taskFlow.length - 1 && t.type === "agent" && !t.content.trim().includes(cleanText)
                ? { ...t, content: t.content + cleanText, streaming: true }
                : t
            ),
          }));
        },

        onAssistantFinalText: (text, replyOptions = []) => {
          const fallbackText = replyOptions.length > 0
            ? get().config.language === "en"
              ? "Choose how you'd like to continue."
              : "请选择你希望我如何继续。"
            : "";
          const cleanText = text.trim() || fallbackText;
          const latestBlock = get().taskFlow[get().taskFlow.length - 1];

          if (!cleanText) {
            if (latestBlock && latestBlock.type === "agent" && latestBlock.turnId === turnId) {
              set((s) => ({
                taskFlow: s.taskFlow.map((t) =>
                  t.id === latestBlock.id && t.type === "agent"
                    ? { ...t, content: "", streaming: false }
                    : t
                ),
              }));
            }
            return;
          }

          if (!latestBlock || latestBlock.type !== "agent" || latestBlock.turnId !== turnId) {
            set((s) => ({
              normalizedStreamState: {
                ...s.normalizedStreamState,
                visibleText: cleanText,
                replyOptions,
              },
            }));
            appendTurnBlock({
              id: nextId(),
              turnId,
              type: "agent",
              content: cleanText,
              ...(replyOptions.length > 0 ? { options: replyOptions } : {}),
              streaming: false,
            });
            return;
          }

          set((s) => ({
            normalizedStreamState: {
              ...s.normalizedStreamState,
              visibleText: cleanText,
              replyOptions,
            },
            taskFlow: s.taskFlow.map((t) =>
              t.id === latestBlock.id && t.type === "agent"
                ? {
                    ...t,
                    content: cleanText,
                    ...(replyOptions.length > 0 ? { options: replyOptions } : { options: undefined }),
                    streaming: false,
                  }
                : t
            ),
          }));
        },

        onToolExecuting: (toolName, target, diffPreview) => {
          let runningTaskId: number | null = null;
          let shouldAttachDiff = false;

          set((s) => {
            const pendingIdx = [...s.taskFlow]
              .map((task, index) => ({ task, index }))
              .reverse()
              .find(({ task }) =>
                task.turnId === turnId &&
                task.type === "tool" &&
                task.toolName === toolName &&
                task.target === target &&
                task.toolStatus === "pending"
              )?.index;
            const lastInTurn = [...s.taskFlow].reverse().find((task) => task.turnId === turnId);
            const nextFlow = [...s.taskFlow];
            let appendedBlockId: number | null = null;
            if (pendingIdx != null && pendingIdx >= 0) {
              const pendingTask = nextFlow[pendingIdx];
              if (pendingTask?.type === "tool") {
                runningTaskId = pendingTask.id;
                shouldAttachDiff = !pendingTask.diff && !!diffPreview;
                nextFlow[pendingIdx] = {
                  ...pendingTask,
                  toolStatus: "running",
                  status: "running",
                  message: "Executing...",
                };
              }
            } else {
              appendedBlockId = nextId();
              runningTaskId = appendedBlockId;
              shouldAttachDiff = !!diffPreview && supportsToolDiffPreview(toolName);
              nextFlow.push({
                id: appendedBlockId,
                turnId,
                type: "tool",
                toolName,
                target,
                status: "running",
                toolStatus: "running",
                message: "Executing...",
              });
            }
            return {
              taskFlow: nextFlow.map((task) =>
                lastInTurn &&
                task.id === lastInTurn.id &&
                task.type === "agent" &&
                !task.streaming
                  ? { ...task, hiddenProcess: true }
                  : task
              ),
              conversationTurns: appendedBlockId == null
                ? s.conversationTurns
                : s.conversationTurns.map((turn) =>
                    turn.id === turnId && !turn.blockIds.includes(appendedBlockId!)
                      ? { ...turn, blockIds: [...turn.blockIds, appendedBlockId!] }
                      : turn
                  ),
              showDiff: false,
            };
          });

          if (runningTaskId != null && shouldAttachDiff && diffPreview) {
            set((s) => ({
              taskFlow: s.taskFlow.map((task) =>
                task.id === runningTaskId && task.type === "tool"
                  ? { ...task, diff: diffPreview }
                  : task
              ),
            }));
          }
        },

        onToolDone: (toolName, target, result) => {
          set((s) => {
            let idx = -1;
            for (let i = s.taskFlow.length - 1; i >= 0; i--) {
              const t = s.taskFlow[i];
              if (t.type === "tool" && t.toolName === toolName && t.target === target && t.toolStatus === "running") {
                idx = i;
                break;
              }
            }
            if (idx === -1) return {};
            const updated = [...s.taskFlow];
            updated[idx] = { ...updated[idx], toolStatus: "executed" as const, status: "done" as const, message: result.length > 500 ? result.slice(0, 500) + "..." : result } as TaskBlock;
            const shouldRecordPlanEvidence =
              effectiveRunIntent === "plan" &&
              s.isPlanApproved &&
              isPlanExecutionEvidenceTool(toolName, target);
            const nextPlanExecutionEvidenceCount = shouldRecordPlanEvidence
              ? s.planExecutionEvidenceCount + 1
              : s.planExecutionEvidenceCount;

            return {
              taskFlow: updated,
              ...(nextPlanExecutionEvidenceCount !== s.planExecutionEvidenceCount
                ? {
                    planExecutionEvidenceCount: nextPlanExecutionEvidenceCount,
                    planTasks: normalizePlanTaskStatuses(
                      s.planTasks,
                      nextPlanExecutionEvidenceCount > 0,
                    ),
                  }
                : {}),
            };
          });
          if (
            toolName === "write_file" ||
            toolName === "replace_in_file" ||
            toolName === "execute_command" ||
            toolName === "delete_workspace_path"
          ) {
            invalidateWorkspaceTreeCache();
            get().bumpWorkspaceContentVersion();
          }
        },

        onToolError: (toolName, target, error) => {
          set((s) => {
            let idx = -1;
            for (let i = s.taskFlow.length - 1; i >= 0; i--) {
              const t = s.taskFlow[i];
              if (t.type === "tool" && t.toolName === toolName && t.target === target && t.toolStatus === "running") {
                idx = i;
                break;
              }
            }
            if (idx === -1) return {};
            const updated = [...s.taskFlow];
            updated[idx] = { ...updated[idx], toolStatus: "failed" as const, status: "error" as const, message: error } as TaskBlock;
            return { taskFlow: updated };
          });
          if (toolName === "execute_command") {
            invalidateWorkspaceTreeCache();
            get().bumpWorkspaceContentVersion();
          }
        },

        onStatusChange: (status) => {
          set({
            agentStatus: status,
            // Timer only runs during active generation, NOT during plan review
            isGenerating: status === "running",
          });
          if (turnId) {
            const nextTurnStatus: ConversationTurnStatus =
              status === "error"
                ? "error"
                : status === "idle"
                ? get().normalizedStreamState.replyOptions.length > 0
                  ? "awaiting_input"
                  : "done"
                : status === "pending_review"
                ? "awaiting_approval"
                : effectiveRunIntent === "plan" &&
                  !get().isPlanApproved &&
                  (get().planArtifacts.length > 0 || get().planStage !== "idle")
                ? "planning"
                : "executing";
            get().setConversationTurnStatus(turnId, nextTurnStatus);
          }
          if (status === "idle" || status === "error") {
            set({ abortController: null });
            clearInterval(timerInterval);
          }
        },

        onError: (error) => {
          console.error('[sendMessage] onError callback:', error);
          const block: TaskBlock = {
            id: nextId(),
            turnId,
            type: "tool",
            toolName: "Error",
            target: "",
            status: "error",
            toolStatus: "failed",
            message: error,
          };
          appendTurnBlock(block);
        },

        onPlanArtifactUpdated: (path, content, kind) => {
          get().upsertPlanArtifact({
            kind,
            path,
            title: getPlanArtifactTitle(kind, get().config.language === "en" ? "en" : "zh"),
            content,
            updatedAt: Date.now(),
          });
          get().openRightPanelTab("plan");
        },

        onPlanStageChanged: (stage) => {
          const current = get();
          const nextStage =
            stage === "idle" || stage === "completed"
              ? stage
              : derivePlanStageFromArtifacts(
                  current.planArtifacts,
                  current.planTasks,
                  current.isPlanApproved,
                  stage === "executing" ? "executing" : current.planStage,
                );

          get().setPlanStage(nextStage);
          if (nextStage !== "idle") {
            get().openRightPanelTab("plan");
          }
        },

        onPlanTasksUpdated: (content) => {
          const sanitized = sanitizePlanArtifactContent(content);
          if (sanitized.trim()) {
            get().setPlanTasks(extractPlanTasks(sanitized));
          }
        },

        onTurnSummaryReady: (summary) => {
          if (!summary.trim()) return;
          get().setConversationTurnSummary(turnId, summarizeAssistantText(summary));
        },

        appendMessage: (msg) => {
          set((s) => ({ agentMessages: [...s.agentMessages, msg] }));
        },

        replaceMessages: (msgs) => {
          set({ agentMessages: msgs });
        },

        onContextCompress: (stats, reason) => {
          const saved = Math.max(0, Math.round(stats.tokenReduction)).toLocaleString();
          const before = Math.max(0, Math.round(stats.tokenCountBefore)).toLocaleString();
          const after = Math.max(0, Math.round(stats.tokenCountAfter)).toLocaleString();
          const countLabel = stats.droppedCount > 0
            ? `，折叠 ${stats.droppedCount} 条历史消息`
            : "";
          const label = reason === "reactive"
            ? `⚠️ 上下文溢出，已压缩背景${countLabel}，约 ${before} → ${after} tokens（释放 ${saved}）`
            : `📋 上下文已压缩背景${countLabel}，约 ${before} → ${after} tokens（释放 ${saved}，适配 KV Cache）`;
          const block: TaskBlock = {
            id: nextId(),
            turnId,
            type: "system",
            content: label,
          };
          appendTurnBlock(block);
        },

        /**
         * ALL tool calls go through this gate.
         * Creates a pending Action Card in taskFlow and stores the
         * resolver + tool call info. The loop pauses until the user
         * clicks Allow & Run or Reject on the Action Card.
         *
         * If autoApproveTools is true, auto-executes without creating
         * a pending card, resolving immediately as "accept".
         */
        requestReview: (toolCall) => {
          // ── Auto-approve path ──
          if (get().autoApproveTools) {
            return Promise.resolve({ action: "accept" });
          }

          const latestState = get();
          const latestIntent = latestState.getCurrentRunIntent();
          const alreadyApprovedForTurn =
            latestState.currentTurnExecutionConsent.granted &&
            latestState.currentTurnExecutionConsent.turnId === turnId;
          const planExecutionAlreadyApproved =
            latestIntent === "plan" && latestState.isPlanApproved;

          if (
            (latestIntent === "execute" || latestIntent === "studio_workflow") &&
            latestState.executionConsentPolicy === "ask_per_turn" &&
            !alreadyApprovedForTurn &&
            !planExecutionAlreadyApproved
          ) {
            return new Promise<ReviewDecision>((resolve) => {
              set({
                pendingRunDecision: {
                  kind: "execution_consent",
                  source: "tool_gate",
                  originalInput: text,
                  originalImages: currentImages,
                  suggestedIntent: "execute",
                  reason: latestState.config.language === "en"
                    ? "This turn is about to make real changes. Choose how MAIN should proceed."
                    : "当前回合即将产生真实改动，请先确认 MAIN 的执行方式。",
                  turnId,
                  toolName: toolCall.name,
                  target: getToolTarget(toolCall.name, toolCall.arguments),
                },
                pendingRunDecisionResolver: (choice) => {
                  if (choice === "cancel") {
                    resolve({ action: "reject" });
                    return;
                  }
                  resolve({ action: "accept" });
                },
              });
            }).then((decision: ReviewDecision) => {
              if (decision.action !== "accept") {
                return decision;
              }

              if (get().autoApproveTools) {
                return { action: "accept" } as ReviewDecision;
              }

              return new Promise<ReviewDecision>((resolve) => {
                const reviewTaskId = nextId();
                const toolName = toolCall.name;
                const toolArgs = toolCall.arguments;
                const target = getToolTarget(toolName, toolArgs);
                void (async () => {
                  const reviewState = get();
                  const diff = await buildToolDiffPreview(toolName, toolArgs, {
                    workspace: reviewState.currentWorkspace,
                    sessionKey: resolveGlobalChatSessionKey(reviewState.currentSessionId) ?? undefined,
                  });
                  const block: TaskBlock = {
                    id: reviewTaskId,
                    turnId,
                    type: "tool",
                    toolName,
                    target,
                    status: "pending_review",
                    toolStatus: "pending",
                    ...(diff ? { diff } : {}),
                  };

                  set((s) => ({
                    taskFlow: [...s.taskFlow, block],
                    conversationTurns: s.conversationTurns.map((turn) =>
                      turn.id === turnId && !turn.blockIds.includes(block.id)
                        ? { ...turn, blockIds: [...turn.blockIds, block.id] }
                        : turn
                    ),
                    selectedDiffTaskId: diff ? reviewTaskId : s.selectedDiffTaskId,
                    showDiff: !!diff,
                    showPlanPanel: false,
                    rightPanelTab: diff ? "diff" : s.rightPanelTab,
                    pendingReviewResolve: resolve,
                    pendingReviewTaskId: reviewTaskId,
                    pendingToolCall: { name: toolName, arguments: toolArgs },
                  }));
                })();
              });
            });
          }

          // ── Normal review path ──
          return new Promise((resolve) => {
            const reviewTaskId = nextId();
            const toolName = toolCall.name;
            const toolArgs = toolCall.arguments;
            const target = getToolTarget(toolName, toolArgs);
            void (async () => {
              const reviewState = get();
              const diff = await buildToolDiffPreview(toolName, toolArgs, {
                workspace: reviewState.currentWorkspace,
                sessionKey: resolveGlobalChatSessionKey(reviewState.currentSessionId) ?? undefined,
              });
              const block: TaskBlock = {
                id: reviewTaskId,
                turnId,
                type: "tool",
                toolName,
                target,
                status: "pending_review",
                toolStatus: "pending",
                ...(diff ? { diff } : {}),
              };

              set((s) => ({
                taskFlow: [...s.taskFlow, block],
                conversationTurns: s.conversationTurns.map((turn) =>
                  turn.id === turnId && !turn.blockIds.includes(block.id)
                    ? { ...turn, blockIds: [...turn.blockIds, block.id] }
                    : turn
                ),
                selectedDiffTaskId: diff ? reviewTaskId : s.selectedDiffTaskId,
                showDiff: !!diff,
                showPlanPanel: false,
                rightPanelTab: diff ? "diff" : s.rightPanelTab,
                pendingReviewResolve: resolve,
                pendingReviewTaskId: reviewTaskId,
                pendingToolCall: { name: toolName, arguments: toolArgs },
              }));
            })();
          });
        },
      };

      // Fire and forget — the loop manages its own lifecycle
      executeAgentLoop(callbacks, abortCtrl).then(() => {
        clearInterval(timerInterval);
        set({ pendingSlashCommand: null });

        // Save session messages (sanitized for serialization safety)
        const s = get();
        if (s.currentSessionId) {
          s.updateSession(resolveSessionWorkspaceKey(s.currentWorkspace), s.currentSessionId, { messages: sanitizeTaskBlocksForPersist(s.taskFlow) });
        }
      }).catch((err) => {
        clearInterval(timerInterval);
        set({ pendingSlashCommand: null });
        console.error("Agent loop crashed:", err);
        // Show crash as visible system block
        const crashId = nextId();
        set((s) => ({
          taskFlow: [...s.taskFlow, {
            id: crashId,
            turnId,
            type: "system" as const,
            content: `❌ Agent loop crashed: ${err instanceof Error ? err.message : String(err)}`,
          }],
          conversationTurns: s.conversationTurns.map((turn) =>
            turn.id === turnId
              ? {
                  ...turn,
                  status: "error",
                  blockIds: [...turn.blockIds, crashId],
                }
              : turn
          ),
          agentStatus: "error",
          isGenerating: false,
          abortController: null,
        }));
      });
    })();

    return true;
  },
    }),
    {
      name: "local-agent-ide",
      // Persist the active runtime snapshot so self-modifying the app or a
      // hot reload does not wipe the current conversation / plan state.
      partialize: (state) => ({
        config: state.config,
        skills: state.skills,
        sessionsByWorkspace: state.sessionsByWorkspace,
        currentWorkspace: state.currentWorkspace,
        selectedWorkspace: state.selectedWorkspace,
        currentSessionId: state.currentSessionId,
        selectedMainModeKey: state.selectedMainModeKey,
        selectedNexusModeKey: state.selectedNexusModeKey,
        activeStudioAgentKey: state.activeStudioAgentKey,
        gameStudioInitialized: state.gameStudioInitialized,
        taskFlow: sanitizeTaskBlocksForPersist(state.taskFlow),
        agentMessages: sanitizeAgentMessagesForPersist(state.agentMessages),
        conversationTurns: state.conversationTurns,
        currentTurnId: state.currentTurnId,
        pendingSlashCommand: state.pendingSlashCommand,
        planArtifacts: state.planArtifacts,
        planTasks: state.planTasks,
        planExecutionEvidenceCount: state.planExecutionEvidenceCount,
        planStage: state.planStage,
        isPlanApproved: state.isPlanApproved,
        showPlanPanel: state.showPlanPanel,
        showDiff: state.showDiff,
        showTerminal: state.showTerminal,
        showFilePanel: state.showFilePanel,
        rightPanelTab: state.rightPanelTab,
        selectedDiffTaskId: state.selectedDiffTaskId,
        preferredResponseLanguage: state.preferredResponseLanguage,
        mcpServers: state.mcpServers,
        sidebarWidth: state.sidebarWidth,
        showWorkspaceTreePanel: state.showWorkspaceTreePanel,
        workspaceTreePanelWidth: state.workspaceTreePanelWidth,
        rightPanelWidth: state.rightPanelWidth,
      }),
      onRehydrateStorage: () => (state, error) => {
        if (error || !state) return;

        const hydratedTaskFlow = sanitizeTaskBlocksForPersist(state.taskFlow || []);
        syncTaskIdCounterFromBlocks(hydratedTaskFlow);

        useAppStore.setState({
          taskFlow: hydratedTaskFlow,
          agentMessages: sanitizeAgentMessagesForPersist(state.agentMessages || []),
          selectedMainModeKey: mapLegacyNexusModeToMainMode(
            (state as Partial<AppState> & { selectedAgentKey?: string }).selectedMainModeKey ||
              (state as Partial<AppState> & { selectedAgentKey?: string }).selectedNexusModeKey ||
              (state as Partial<AppState> & { selectedAgentKey?: string }).selectedAgentKey,
          ),
          selectedNexusModeKey: mapMainModeToLegacyNexusMode(
            mapLegacyNexusModeToMainMode(
              (state as Partial<AppState> & { selectedAgentKey?: string }).selectedMainModeKey ||
                (state as Partial<AppState> & { selectedAgentKey?: string }).selectedNexusModeKey ||
                (state as Partial<AppState> & { selectedAgentKey?: string }).selectedAgentKey,
            ),
          ),
          activeStudioAgentKey: normalizeStudioAgentKey(state.activeStudioAgentKey),
          gameStudioInitialized: state.gameStudioInitialized === true,
          pendingSlashCommand: normalizePendingSlashCommand(state.pendingSlashCommand),
          currentTurnState: createDefaultCurrentTurnState(),
          agentStatus: "idle",
          isGenerating: false,
          abortController: null,
          pendingReviewResolve: null,
          pendingReviewTaskId: null,
          pendingToolCall: null,
          autoApproveTools: false,
          pendingRunDecision: null,
          pendingRunDecisionResolver: null,
          executionConsentPolicy: "ask_per_turn",
          currentTurnExecutionConsent: { turnId: null, granted: false },
          messages: [],
          elapsedTime: 0,
        });
      },
    // Merge persisted data back into the default state on hydration,
    // so newly-added fields get their defaults instead of being undefined.
    merge: (persisted, current) => {
      const persistedState = (persisted as Partial<AppState> & { selectedAgentKey?: string }) || {};
      const selectedMainModeKey = mapLegacyNexusModeToMainMode(
        persistedState.selectedMainModeKey ||
          persistedState.selectedNexusModeKey ||
          persistedState.selectedAgentKey,
      );
      return {
        ...current,
        ...persistedState,
        config: {
          ...current.config,
          ...(persistedState.config ?? {}),
          local: {
            ...current.config.local,
            ...(persistedState.config?.local ?? {}),
          },
          cloud: {
            ...current.config.cloud,
            ...(persistedState.config?.cloud ?? {}),
            protocol: normalizeCloudProtocol(persistedState.config?.cloud?.protocol),
            apiFormat: normalizeCloudApiFormat(persistedState.config?.cloud?.apiFormat),
            reasoningEffort: normalizeOpenAiReasoningEffort(persistedState.config?.cloud?.reasoningEffort),
            disableResponseStorage: persistedState.config?.cloud?.disableResponseStorage ?? current.config.cloud.disableResponseStorage,
          },
        },
        sessionsByWorkspace: normalizeSessionsByWorkspace(persistedState.sessionsByWorkspace),
        selectedWorkspace: persistedState.selectedWorkspace || persistedState.currentWorkspace || current.selectedWorkspace,
        selectedMainModeKey,
        selectedNexusModeKey: mapMainModeToLegacyNexusMode(selectedMainModeKey),
        activeStudioAgentKey: normalizeStudioAgentKey(persistedState.activeStudioAgentKey),
        gameStudioInitialized: persistedState.gameStudioInitialized === true,
        pendingSlashCommand: normalizePendingSlashCommand(persistedState.pendingSlashCommand),
      };
    },
  }
  )
);

async function triggerAutoSummarize(
  userText: string,
  assistantText: string,
  config: AppConfig,
  sessionScopeKey: string,
  currentSessionId: number | null,
  updateSession: (ws: string, id: number, patch: Partial<Session>) => void,
) {
  if (!sessionScopeKey || !currentSessionId) return;
  try {
    const isCloud = config.activeProfile === "cloud";
    const ac = isCloud ? config.cloud : config.local;
    const endpoint = isCloud ? (config.cloud.endpoint || "") : config.local.endpoint;
    const model = ac.model;
    const provider = isCloud ? config.cloud.provider : config.local.provider;
    const cloudProtocol = normalizeCloudProtocol(isCloud ? config.cloud.protocol : "openai");
    const cloudApiFormat = normalizeCloudApiFormat(isCloud ? config.cloud.apiFormat : "chat_completions");
    if (!model || !endpoint) return;
    const msgs: Array<{ role: "system" | "user"; content: string }> = [
      { role: "system", content: "Summarize the following request into a 2-4 word short title. Return ONLY plain text, absolutely NO markdown formatting, NO asterisks, NO hashes." },
      { role: "user", content: `User: ${userText.slice(0, 500)}\n\nAssistant: ${assistantText.slice(0, 500)}` },
    ];
    const isAnthropicCloud = isCloud && cloudProtocol === "anthropic";
    let url: string;
    let body: Record<string, unknown>;
    let headers: Record<string, string>;

    if (provider === "Ollama") {
      url = `${endpoint.replace("/v1", "")}/api/chat`;
      body = { model, messages: msgs, stream: false };
      headers = { "Content-Type": "application/json" };
    } else if (isAnthropicCloud) {
      url = buildCloudMessagesApiUrl(endpoint, "anthropic");
      body = buildAnthropicRequestBody({
        messages: msgs,
        model,
        maxTokens: 64,
        stream: false,
        temperature: config.cloud.temperature ?? 0.2,
        topP: config.cloud.topP ?? 0.95,
      });
      headers = buildCloudHeaders("anthropic", ac.apiKey, true, config.cloud.customHeaders);
    } else {
      url = buildCloudMessagesApiUrl(endpoint, "openai", cloudApiFormat);
      body = cloudApiFormat === "responses"
        ? {
            model,
            ...(extractOpenAiResponsesInstructions(msgs as Array<{ role: "system" | "user"; content: string }>) ? {
              instructions: extractOpenAiResponsesInstructions(msgs as Array<{ role: "system" | "user"; content: string }>),
            } : {}),
            input: buildOpenAiResponsesInputCandidates(msgs as Array<{ role: "system" | "user"; content: string }>)[0].input,
            ...buildOpenAiResponsesRequestExtras({
              disableResponseStorage: config.cloud.disableResponseStorage,
              reasoningEffort: config.cloud.reasoningEffort,
            }),
          }
        : { model, messages: msgs, stream: false, max_tokens: 64 };
      headers = buildCloudHeaders("openai", ac.apiKey, true, config.cloud.customHeaders);
    }

    // For cloud endpoints, route through Rust backend to bypass CORS
    let j: any;
    if (isCloud) {
      const result = await invoke<string>("proxy_request", {
        url,
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
      j = JSON.parse(result);
    } else {
      const r = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
      if (!r.ok) return;
      j = await r.json();
    }

    const s = provider === "Ollama"
      ? j.message?.content?.trim()
      : isAnthropicCloud
        ? extractAnthropicResponseText(j).trim()
        : extractOpenAiResponseText(j, cloudApiFormat).trim();
    if (s) updateSession(sessionScopeKey, currentSessionId, { title: s });
  } catch { /* ignore */ }
}

// ── Selector Helpers ──────────────────────────────────────────────────

/** Derive a human-readable target from tool arguments (for Action Card display). */
function getToolTarget(name: string, args: Record<string, unknown>): string {
  switch (name) {
    case "list_directory":  return (args.path as string) || "";
    case "read_file":       return (args.path as string) || "";
    case "read_document":   return (args.path as string) || "";
    case "analyze_tabular_document": return (args.path as string) || "";
    case "query_tabular_document": return (args.path as string) || "";
    case "index_workspace_documents": return (args.path as string) || ".";
    case "glob_search":     return (args.pattern as string) || "";
    case "grep_search":     return (args.query as string) || "";
    case "execute_command": return (args.command as string) || "";
    case "send_pty_input":  return (args.input as string) || "terminal input";
    case "run_command":     return (args.command as string) || "";
    case "read_pty_buffer": return "terminal";
    case "read_pty_tail":   return "terminal tail";
    case "read_pty_since":  return `terminal @ ${args.offset ?? 0}`;
    case "get_pty_status":  return "terminal status";
    case "clear_pty_buffer": return "terminal buffer";
    case "replace_in_file": return (args.path as string) || "";
    case "write_file":      return (args.path as string) || "";
    default:                return "";
  }
}

export const useT = () => {
  const lang = useAppStore((s) => s.config.language);
  return translations[lang] ?? translations.en;
};

export const useTheme = () => {
  const themeKey = useAppStore((s) => s.config.theme);
  return THEMES[themeKey] ?? THEMES.purple;
};
