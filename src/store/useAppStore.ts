// store/useAppStore.ts
// Zustand global state for Local Agent IDE
// All state that was previously scattered as useState in the monolith lives here.
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { executeAgentLoop, type AgentMessage, type OrchestratorCallbacks, type ReviewDecision, type ContentPart } from "../lib/orchestrator";
import { analyzeTabularDocument, deleteChatTempPath, deletePlanFiles, readDocument, readFile } from "../lib/ipc";
import { invoke } from "@tauri-apps/api/core";
import { setWorkspaceRoot as setWorkspaceRootIpc } from "../lib/ipc";
import { appendDebugLog } from "../lib/debugLog";
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
  findDroppedPlanTasks,
  getPendingPlanTaskCommandFocus,
  getPlanArtifactTitle,
  isGenericConversationTitle,
  looksLikeReasoningLeakTitle,
  mergePlanTasks,
  normalizeConversationDisplayTitle,
  summarizeAssistantText,
  summarizeUserPrompt,
  validatePlanArtifactContent,
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
} from "../lib/cloudProtocol";
import {
  createDefaultCloudConfig,
  normalizeCloudServerState,
  type CloudProfileConfig,
  type CloudServerConfig,
} from "../lib/cloudServers";
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
  getIntentPolicy,
  resolveConversationTurnIntent,
  resolveRunIntentFromLegacyWorkflowMode,
  resolveTurnRunIntent,
  parseMainIntentShortcut,
  shouldUseBlockingIntentPreflight,
  type ExecutionConsentPolicy,
  type MainIntentShortcut,
  type PendingRunDecision,
  type ResolvedUserIntent,
  type ResolvedRunIntent,
} from "../lib/runIntent";
import { mapLegacyNexusModeToMainMode, mapMainModeToLegacyNexusMode, type MainModeKey } from "../lib/mainModes";
import { runIntentPreflight } from "../lib/intentPreflight";
import { runAfterNextPaint } from "../lib/uiScheduling";
import {
  createDefaultFeishuAdapterRuntimeStatus,
  createDefaultImAdaptersConfig,
  normalizeImAdaptersConfig,
  upsertFeishuPairingRequest,
  type FeishuAdapterRuntimeStatus,
  type FeishuPendingPairing,
  type ImAdaptersConfig,
} from "../lib/imAdapters";

function logStoreEvent(event: string, data: Record<string, unknown> = {}) {
  try {
    appendDebugLog("info", `store.${event}`, data);
  } catch {
    // Diagnostics must never affect user workflows.
  }
}

function nowMs() {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

// ── i18n ────────────────────────────────────────────────────────────

export const translations = {
  en: {
    workspace: "Workspace", conversations: "Conversations", new: "New",
    chatSpace: "Chat", globalChat: "Chat", noChats: "No chats yet",
    skills: "Skills", diff: "Diff Viewer", terminal: "Terminal", settings: "Settings",
    openProject: "Open Folder", noWorkspace: "No project selected", noConversations: "No conversations yet",
    localSetup: "Local AI Engine", cloudSetup: "Cloud API", general: "General", contextSetup: "Background Compression",
    instruction: "Instruction", reject: "Reject all", accept: "Accept all",
    askPlaceholder: "Ask me about your project... (Type @ to attach files)",
    askPlaceholderGlobal: "Talk through ideas, plans, or questions... (Type @ to attach files)",
    contextLimit: "Background Compression Threshold",
    contextLimitDesc: "Lower values compress earlier and use less VRAM. Higher values keep more context but use more VRAM.",
    vramEst: "Est. KV Cache (VRAM):",
    vramNote: "Note: This is context overhead only; base model weight VRAM is not included.",
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
    sessionRecording: "Record project sessions",
    sessionRecordingDesc: "Save full conversations in MAIN app data so project history can be restored without writing chat logs into .MAIN.",
    refreshRules: "Refresh rules",
    instructionSources: "Resolved instruction sources",
    hookConfig: "Loaded hook definitions",
    hookRecords: "Recent hook records",
    dataManagement: "Data Management",
    debugLog: "Debug Log",
    clearHistory: "Clear History",
    clearHistoryDesc: "Delete all chat history and session data for the current workspace.",
    resetSettings: "Reset All Settings",
    resetSettingsDesc: "Restore all settings, skills, and configurations to their default values.",
    clearHistoryConfirm: "Are you sure? This will delete all conversation history for the current workspace.",
    resetSettingsConfirm: "Are you sure? This will reset ALL settings, skills, and sessions to their defaults.",
    imAdapters: "IM Adapters",
    feishuAdapter: "Feishu Remote Control",
    feishuAdapterDesc: "Use a Feishu bot long connection to send tasks to MAIN from private chat.",
    feishuEnable: "Enable Feishu Adapter",
    feishuAppId: "App ID",
    feishuAppSecret: "App Secret",
    feishuDomain: "Open Platform Domain",
    feishuPairingCode: "Pairing Code",
    feishuPairingCodeDesc: "Send this code to the bot in a private chat with /pair.",
    feishuPairedUsers: "Paired Users",
    feishuPendingPairings: "Pairing Requests",
    feishuNoPairedUsers: "No paired Feishu users yet.",
    feishuNoPendingPairings: "No pending pairing requests.",
    feishuApprovePairing: "Approve",
    feishuRejectPairing: "Reject",
    feishuRemovePairing: "Remove",
    feishuRegenerateCode: "Regenerate Code",
    feishuTestConnection: "Test Connection",
    feishuTestingConnection: "Testing...",
    feishuStart: "Start",
    feishuStop: "Stop",
    feishuStatus: "Status",
    feishuNodeRuntime: "Node.js Runtime",
    feishuNodeRuntimeChecking: "Checking Node.js runtime...",
    feishuNodeRuntimeDesc: "The Feishu adapter sidecar needs Node.js. MAIN also searches common install paths when launched from Finder.",
    feishuSetupNodeRuntime: "Quick Configure Node.js",
    feishuRefreshNodeRuntime: "Refresh",
    feishuRoutingCurrentWorkspace: "Messages are routed to the current workspace, one session per paired user.",
    feishuOpenGuide: "How to Use",
    feishuGuideTitle: "Feishu Remote Control Guide",
    feishuGuideFeishuSteps: "Feishu Setup",
    feishuGuideMainSteps: "MAIN Setup",
    feishuGuideCommands: "Remote Commands",
    feishuGuideClose: "Close",
  },
  zh: {
    workspace: "工作区", conversations: "历史会话", new: "新建会话",
    chatSpace: "聊天", globalChat: "聊天", noChats: "暂无聊天",
    skills: "技能与提示词", diff: "变更比对", terminal: "集成终端", settings: "系统设置",
    openProject: "打开文件夹", noWorkspace: "尚未选择项目", noConversations: "暂无会话记录",
    localSetup: "本地引擎配置", cloudSetup: "云端接口配置", general: "通用设置", contextSetup: "背景压缩",
    instruction: "用户指令", reject: "全部拒绝", accept: "全部接受",
    askPlaceholder: "询问关于你的项目... (输入 @ 引用本地文件)",
    askPlaceholderGlobal: "先和 MAIN 聊聊想法、方案或问题... (输入 @ 引用本地文件)",
    contextLimit: "背景压缩阈值",
    contextLimitDesc: "数值越低越早压缩，占用显存更少；数值越高保留上下文更多，但显存占用更高。",
    vramEst: "预估上下文显存占用 (KV Cache):",
    vramNote: "注意：这里只估算上下文额外占用，不包含模型本身的权重显存。",
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
    sessionRecording: "记录项目会话",
    sessionRecordingDesc: "将完整对话保存到 MAIN 应用数据目录，方便恢复项目历史，但不会把聊天流水写进 .MAIN。",
    refreshRules: "刷新规则",
    instructionSources: "已解析的指令来源",
    hookConfig: "已加载 Hook 定义",
    hookRecords: "最近的 Hook 记录",
    dataManagement: "数据管理",
    debugLog: "调试日志",
    clearHistory: "清空聊天记录",
    clearHistoryDesc: "删除当前工作区的所有聊天记录和会话数据。",
    resetSettings: "重置所有设置",
    resetSettingsDesc: "将所有设置、技能和配置恢复为默认值。",
    clearHistoryConfirm: "确定要清空吗？此操作将删除当前工作区的所有对话记录。",
    resetSettingsConfirm: "确定要重置吗？此操作将恢复所有设置、技能和会话为默认值。",
    imAdapters: "即时通讯适配器",
    feishuAdapter: "飞书远程控制",
    feishuAdapterDesc: "通过飞书机器人长连接，在私聊里远程向 MAIN 发送任务。",
    feishuEnable: "启用飞书适配器",
    feishuAppId: "App ID",
    feishuAppSecret: "App Secret",
    feishuDomain: "开放平台域名",
    feishuPairingCode: "配对码",
    feishuPairingCodeDesc: "在飞书私聊机器人发送 /pair 加配对码完成绑定。",
    feishuPairedUsers: "已配对用户",
    feishuPendingPairings: "配对请求",
    feishuNoPairedUsers: "还没有已配对的飞书用户。",
    feishuNoPendingPairings: "暂无待处理配对请求。",
    feishuApprovePairing: "通过",
    feishuRejectPairing: "拒绝",
    feishuRemovePairing: "移除",
    feishuRegenerateCode: "重新生成配对码",
    feishuTestConnection: "测试连接",
    feishuTestingConnection: "测试中...",
    feishuStart: "启动",
    feishuStop: "停止",
    feishuStatus: "状态",
    feishuNodeRuntime: "Node.js 运行环境",
    feishuNodeRuntimeChecking: "正在检查 Node.js 运行环境...",
    feishuNodeRuntimeDesc: "飞书适配器 sidecar 需要 Node.js。打包版从访达启动时，MAIN 也会自动搜索常见安装路径。",
    feishuSetupNodeRuntime: "快速配置 Node.js",
    feishuRefreshNodeRuntime: "刷新",
    feishuRoutingCurrentWorkspace: "消息会进入当前工作区，并按飞书用户分别维护独立会话。",
    feishuOpenGuide: "使用说明",
    feishuGuideTitle: "飞书远程控制使用说明",
    feishuGuideFeishuSteps: "飞书中要做什么",
    feishuGuideMainSteps: "MAIN 中要做什么",
    feishuGuideCommands: "远程命令",
    feishuGuideClose: "关闭",
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

export function resolveSessionRuntimeKey(
  workspaceOrScope: string | null | undefined,
  sessionId: number | null | undefined,
): string | null {
  if (!sessionId) return null;
  return `${resolveSessionWorkspaceKey(workspaceOrScope)}:${sessionId}`;
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
  workspaceScope?: string | null;     // Absolute workspace root that owns this package skill
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

export interface SessionRuntimeState extends SessionRuntimeSnapshot {
  input: string;
  contextMentions: string[];
  attachedFiles: string[];
  preferredResponseLanguage: Lang;
  lockedComposerIntent: MainIntentShortcut | null;
  pendingRunDecision: PendingRunDecision | null;
  pendingRunDecisionResolver:
    | ((choice: "approve_once" | "approve_thread" | "cancel") => void)
    | null;
  currentTurnExecutionConsent: { turnId: string | null; granted: boolean };
  readOnlyAutoApproveForSession: boolean;
  normalizedStreamState: NormalizedStreamState;
  currentTurnState: AppState["currentTurnState"];
  isGenerating: boolean;
  agentStatus: AgentStatus;
  abortController: AbortController | null;
  elapsedTime: number;
  pendingReviewResolve: ((decision: ReviewDecision) => void) | null;
  pendingReviewTaskId: number | null;
  pendingToolCall: { name: string; arguments: Record<string, unknown> } | null;
  showFilePanel: boolean;
  fileViewerPath: string;
  fileViewerContent: string;
  fileViewerError: string;
  fileViewerLoading: boolean;
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
  storageStatus?: "ok" | "missing" | "temporary";
  recordingDisabled?: boolean;
  workspaceRoot?: string;
  projectId?: string;
}

export interface WorkspaceEntry {
  path: string;
  name: string;
  addedAt: number;
  lastActiveAt: number;
}

export interface LocalConfig {
  provider: string;
  endpoint: string;
  model: string;
  contextLimit: number;
  apiKey: string;
}

export type CloudConfig = CloudProfileConfig;
export type { CloudServerConfig } from "../lib/cloudServers";

export interface AppConfig {
  language: Lang;
  theme: ThemeKey;
  themeMode: "light" | "dark";
  workflowMode: "chat" | "edit" | "plan";  // Legacy mirror of the active turn intent.
  instructionsEnabled: boolean;
  hooksEnabled: boolean;
  activeProfile: "local" | "cloud";
  chatFontSize: number;  // px, default 13
  sessionRecordingEnabled: boolean;
  local: LocalConfig;
  cloud: CloudConfig;
  cloudServers: CloudServerConfig[];
  activeCloudServerId: string;
  imAdapters: ImAdaptersConfig;
  workspace: string;
}

export type AgentStatus = "idle" | "running" | "pending_review" | "error";

export interface FeishuRemoteContext {
  adapter: "feishu";
  chatId: string;
  userId: string;
  userName: string;
  messageId?: string;
}

export interface FeishuPendingApproval {
  code: string;
  taskId: number;
  chatId: string;
  userId: string;
  messageId?: string;
  toolName: string;
  target: string;
  createdAt: number;
}

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
  | (TaskBlockBase & { type: "agent"; content: string; options?: ReplyOption[]; streaming?: boolean; hiddenProcess?: boolean; archivedAfterChoice?: boolean; selectedOption?: string })
  | (TaskBlockBase & { type: "thought"; content: string; isStreaming?: boolean; duration?: number })
  | (TaskBlockBase & { type: "jobList"; jobs: JobItem[] })
  | (TaskBlockBase & {
      type: "system";
      content: string;
      icon?: string;
      variant?: "context_compression" | "plan_quality_gate";
      contextCompression?: {
        reason: "proactive" | "reactive";
        droppedCount: number;
        tokenCountBefore: number;
        tokenCountAfter: number;
        tokenReduction: number;
        compressedContext?: string;
      };
    });

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
  lockedComposerIntent: MainIntentShortcut | null;
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
  setLockedComposerIntent: (intent: MainIntentShortcut | null) => void;
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

  // IM Adapters
  feishuAdapterStatus: FeishuAdapterRuntimeStatus;
  feishuPairingRequests: FeishuPendingPairing[];
  pendingFeishuApprovals: FeishuPendingApproval[];
  setFeishuAdapterStatus: (status: Partial<FeishuAdapterRuntimeStatus>) => void;
  upsertFeishuPairingRequest: (request: FeishuPendingPairing) => void;
  removeFeishuPairingRequest: (openId: string) => void;
  clearFeishuPairingRequests: () => void;
  addPendingFeishuApproval: (approval: FeishuPendingApproval) => void;
  resolvePendingFeishuApproval: (userId: string, code: string) => FeishuPendingApproval | null;

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
  workspaces: WorkspaceEntry[];
  activeSessionByWorkspace: Record<string, number | null>;
  runtimeBySessionKey: Record<string, SessionRuntimeState>;
  currentWorkspace: string;
  selectedWorkspace: string;
  currentSessionId: number | null;
  addWorkspaceEntry: (path: string) => void;
  removeWorkspaceEntry: (path: string) => void;
  getCurrentSessionKey: () => string | null;
  saveCurrentRuntimeToSession: () => void;
  restoreRuntimeForSession: (sessionKey: string | null) => boolean;
  updateRuntimeForSession: (
    sessionKey: string,
    patch:
      | Partial<SessionRuntimeState>
      | ((runtime: SessionRuntimeState) => Partial<SessionRuntimeState>),
  ) => void;
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
  readOnlyAutoApproveForSession: boolean;
  currentTurnExecutionConsent: { turnId: string | null; granted: boolean };
  pendingRunDecisionResolver:
    | ((choice: "approve_once" | "approve_thread" | "cancel") => void)
    | null;
  setAutoApproveTools: (v: boolean) => void;
  setReadOnlyAutoApproveForSession: (v: boolean) => void;
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
      turnTitle?: string;
      intentSummary?: string;
      contextMentionsSnapshot?: string[];
      attachedFilesSnapshot?: string[];
      remoteFeishu?: FeishuRemoteContext;
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

const defaultCloudState = normalizeCloudServerState({ cloud: createDefaultCloudConfig() });

const defaultConfig: AppConfig = {
  language: "zh",
  theme: "purple",
  themeMode: "dark",
  workflowMode: "chat",
  instructionsEnabled: true,
  hooksEnabled: true,
  activeProfile: "local",
  chatFontSize: 13,
  sessionRecordingEnabled: true,
  local: { provider: "OMLX", endpoint: "http://127.0.0.1:8080/v1", model: "", contextLimit: 16384, apiKey: "" },
  cloud: defaultCloudState.cloud,
  cloudServers: defaultCloudState.cloudServers,
  activeCloudServerId: defaultCloudState.activeCloudServerId,
  imAdapters: createDefaultImAdaptersConfig(),
  workspace: "",
};

const defaultSkills: Skill[] = [];

const defaultSessionsByWorkspace: Record<string, Session[]> = {};

function getWorkspaceDisplayName(path: string): string {
  const normalized = String(path || "").replace(/\\/g, "/").replace(/\/+$/, "");
  return normalized.split("/").filter(Boolean).pop() || normalized || "Workspace";
}

function normalizeWorkspaceEntries(
  entries: WorkspaceEntry[] | undefined,
  sessionsByWorkspace: Record<string, Session[]> = {},
  currentWorkspace = "",
): WorkspaceEntry[] {
  const now = Date.now();
  const byPath = new Map<string, WorkspaceEntry>();
  const shouldInferFromSessions = entries === undefined;
  for (const entry of entries || []) {
    const path = String(entry?.path || "").trim();
    if (!path || path === GLOBAL_CHAT_KEY) continue;
    byPath.set(path, {
      path,
      name: String(entry.name || "").trim() || getWorkspaceDisplayName(path),
      addedAt: Number(entry.addedAt) || now,
      lastActiveAt: Number(entry.lastActiveAt) || Number(entry.addedAt) || now,
    });
  }
  if (shouldInferFromSessions) {
    Object.keys(sessionsByWorkspace || {}).forEach((path) => {
      if (!path || path === GLOBAL_CHAT_KEY || byPath.has(path)) return;
      byPath.set(path, {
        path,
        name: getWorkspaceDisplayName(path),
        addedAt: now,
        lastActiveAt: now,
      });
    });
  }
  const active = String(currentWorkspace || "").trim();
  if (shouldInferFromSessions && active && active !== GLOBAL_CHAT_KEY && !byPath.has(active)) {
    byPath.set(active, {
      path: active,
      name: getWorkspaceDisplayName(active),
      addedAt: now,
      lastActiveAt: now,
    });
  }
  return Array.from(byPath.values());
}

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

function deriveInterruptedRestoreStatus(turn: ConversationTurn, taskFlow: TaskBlock[]): ConversationTurnStatus {
  const turnBlocks = taskFlow.filter((block) => block.turnId === turn.id);
  const hasVisibleAgent = turnBlocks.some(blockHasVisibleAgentContent);
  const hasAnyTool = turnBlocks.some((block) => block.type === "tool");
  const hasExecutionEvidence = turnBlocks.some((block) =>
    block.type === "tool" &&
    block.toolStatus === "executed" &&
    isPlanExecutionEvidenceTool(block.toolName, block.target)
  );

  if (hasExecutionEvidence) return "completed_with_changes";
  if (hasVisibleAgent || hasAnyTool) return "stopped_no_action";
  return "stopped_no_output";
}

export function normalizeInterruptedConversationTurnsForRestore(
  turns: ConversationTurn[] | undefined,
  taskFlow: TaskBlock[],
): ConversationTurn[] {
  return (turns || []).map((turn) => {
    if (turn.status !== "executing" && turn.status !== "planning") return turn;
    return {
      ...turn,
      status: deriveInterruptedRestoreStatus(turn, taskFlow),
    };
  });
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
  const taskFlow = sanitizeTaskBlocksForPersist(snapshot.taskFlow || []);
  return {
    taskFlow,
    agentMessages: sanitizeAgentMessagesForPersist(snapshot.agentMessages || []),
    conversationTurns: normalizeInterruptedConversationTurnsForRestore(snapshot.conversationTurns, taskFlow),
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

const sessionRuntimeKeys = [
  "taskFlow",
  "agentMessages",
  "conversationTurns",
  "currentTurnId",
  "selectedMainModeKey",
  "selectedNexusModeKey",
  "activeStudioAgentKey",
  "gameStudioInitialized",
  "pendingSlashCommand",
  "planArtifacts",
  "planTasks",
  "planExecutionEvidenceCount",
  "planStage",
  "isPlanApproved",
  "showPlanPanel",
  "showDiff",
  "showTerminal",
  "showFilePanel",
  "rightPanelTab",
  "selectedDiffTaskId",
  "input",
  "contextMentions",
  "attachedFiles",
  "preferredResponseLanguage",
  "lockedComposerIntent",
  "pendingRunDecision",
  "pendingRunDecisionResolver",
  "currentTurnExecutionConsent",
  "readOnlyAutoApproveForSession",
  "normalizedStreamState",
  "currentTurnState",
  "isGenerating",
  "agentStatus",
  "abortController",
  "elapsedTime",
  "pendingReviewResolve",
  "pendingReviewTaskId",
  "pendingToolCall",
  "fileViewerPath",
  "fileViewerContent",
  "fileViewerError",
  "fileViewerLoading",
] as const;

function pickSessionRuntimePatch(source: Partial<SessionRuntimeState> | Record<string, unknown>) {
  const patch: Partial<SessionRuntimeState> = {};
  for (const key of sessionRuntimeKeys) {
    if (Object.prototype.hasOwnProperty.call(source, key)) {
      (patch as Record<string, unknown>)[key] = (source as Record<string, unknown>)[key];
    }
  }
  return patch;
}

function omitSessionRuntimePatch(source: Record<string, unknown>) {
  const patch: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (!(sessionRuntimeKeys as readonly string[]).includes(key)) {
      patch[key] = value;
    }
  }
  return patch;
}

function createSessionRuntimeFromState(state: Partial<AppState>): SessionRuntimeState {
  const selectedMainModeKey = mapLegacyNexusModeToMainMode(
    state.selectedMainModeKey || state.selectedNexusModeKey,
  );
  return {
    taskFlow: Array.isArray(state.taskFlow) ? state.taskFlow : [],
    agentMessages: Array.isArray(state.agentMessages) ? state.agentMessages : [],
    conversationTurns: Array.isArray(state.conversationTurns) ? state.conversationTurns : [],
    currentTurnId: state.currentTurnId ?? null,
    selectedMainModeKey,
    selectedNexusModeKey: mapMainModeToLegacyNexusMode(selectedMainModeKey),
    activeStudioAgentKey: normalizeStudioAgentKey(state.activeStudioAgentKey),
    gameStudioInitialized: state.gameStudioInitialized === true,
    pendingSlashCommand: normalizePendingSlashCommand(state.pendingSlashCommand),
    planArtifacts: state.planArtifacts || [],
    planTasks: state.planTasks || [],
    planExecutionEvidenceCount: state.planExecutionEvidenceCount ?? 0,
    planStage: state.planStage ?? "idle",
    isPlanApproved: state.isPlanApproved === true,
    showPlanPanel: state.showPlanPanel === true,
    showDiff: state.showDiff === true,
    showTerminal: state.showTerminal === true,
    showFilePanel: state.showFilePanel === true,
    rightPanelTab: state.rightPanelTab ?? "plan",
    selectedDiffTaskId: state.selectedDiffTaskId ?? null,
    input: state.input ?? "",
    contextMentions: state.contextMentions || [],
    attachedFiles: state.attachedFiles || [],
    preferredResponseLanguage: state.preferredResponseLanguage || "zh",
    lockedComposerIntent: state.lockedComposerIntent ?? null,
    pendingRunDecision: state.pendingRunDecision ?? null,
    pendingRunDecisionResolver: state.pendingRunDecisionResolver ?? null,
    currentTurnExecutionConsent: state.currentTurnExecutionConsent || { turnId: null, granted: false },
    readOnlyAutoApproveForSession: state.readOnlyAutoApproveForSession === true,
    normalizedStreamState: state.normalizedStreamState || defaultNormalizedStreamState,
    currentTurnState: state.currentTurnState || createDefaultCurrentTurnState(),
    isGenerating: state.isGenerating === true,
    agentStatus: state.agentStatus || "idle",
    abortController: state.abortController || null,
    elapsedTime: state.elapsedTime ?? 0,
    pendingReviewResolve: state.pendingReviewResolve || null,
    pendingReviewTaskId: state.pendingReviewTaskId ?? null,
    pendingToolCall: state.pendingToolCall ?? null,
    fileViewerPath: state.fileViewerPath || "",
    fileViewerContent: state.fileViewerContent || "",
    fileViewerError: state.fileViewerError || "",
    fileViewerLoading: state.fileViewerLoading === true,
  };
}

function getSessionRuntimeUiPatch(runtime: SessionRuntimeState): Partial<AppState> {
  return { ...runtime };
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

function stripSessionDetailsForLocalPersist(session: Session): Session | null {
  if (session.recordingDisabled) return null;
  const { messages: _messages, runtimeSnapshot: _runtimeSnapshot, ...meta } = session;
  return {
    ...meta,
    storageStatus: session.storageStatus === "temporary" ? "temporary" : session.storageStatus,
  };
}

function stripSessionsByWorkspaceForLocalPersist(
  sessionsByWorkspace: Record<string, Session[]> | undefined,
): Record<string, Session[]> {
  if (!sessionsByWorkspace) return {};
  return Object.fromEntries(
    Object.entries(sessionsByWorkspace)
      .map(([workspace, sessions]) => [
        workspace,
        (sessions || [])
          .map(stripSessionDetailsForLocalPersist)
          .filter((session): session is Session => Boolean(session)),
      ])
      .filter(([, sessions]) => sessions.length > 0),
  );
}

// ── Streaming Thinking Interceptor ────────────────────────────────────
// Detects thinking XML tags (<thinking>, <thought>, <analysis>, <reasoning>)
// as they stream in token-by-token, and routes content to a ThoughtBlock
// instead of the agent block. Prevents thinking content from briefly
// appearing as plain text in the chat during streaming.

const THINKING_TAG_NAMES = new Set(["thinking", "thought", "analysis", "reasoning"]);
const MAX_VISIBLE_THOUGHT_CHARS = 36_000;

function normalizeThoughtTextForCompare(text: string): string {
  return String(text || "")
    .trim()
    .toLowerCase()
    .replace(/[，。！？；：,.!?;:、"'“”‘’`*_~\-\s]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function sameThoughtParagraphSequence(paragraphs: string[], a: number, b: number, length: number): boolean {
  for (let offset = 0; offset < length; offset++) {
    if (normalizeThoughtTextForCompare(paragraphs[a + offset] || "") !== normalizeThoughtTextForCompare(paragraphs[b + offset] || "")) {
      return false;
    }
  }
  return true;
}

function collapseRepeatedThoughtParagraphs(text: string): string {
  const paragraphs = String(text || "")
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter(Boolean);

  if (paragraphs.length < 4) return text;

  const collapsed: string[] = [];
  let index = 0;
  const maxWindow = 8;

  while (index < paragraphs.length) {
    let matched = false;
    const remaining = paragraphs.length - index;
    const largestWindow = Math.min(maxWindow, Math.floor(remaining / 2));

    for (let windowSize = largestWindow; windowSize >= 1; windowSize--) {
      let repeats = 1;
      while (
        index + (repeats + 1) * windowSize <= paragraphs.length &&
        sameThoughtParagraphSequence(paragraphs, index, index + repeats * windowSize, windowSize)
      ) {
        repeats++;
      }

      if (repeats >= 2) {
        collapsed.push(...paragraphs.slice(index, index + windowSize));
        index += repeats * windowSize;
        matched = true;
        break;
      }
    }

    if (!matched) {
      collapsed.push(paragraphs[index]);
      index++;
    }
  }

  return collapsed.join("\n\n");
}

function collapseRepeatedThoughtLines(text: string): string {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map((part) => part.trim())
    .filter(Boolean);

  if (lines.length < 6) return text;

  const collapsed: string[] = [];
  let index = 0;
  const maxWindow = 12;

  while (index < lines.length) {
    let matched = false;
    const remaining = lines.length - index;
    const largestWindow = Math.min(maxWindow, Math.floor(remaining / 2));

    for (let windowSize = largestWindow; windowSize >= 1; windowSize--) {
      let repeats = 1;
      while (
        index + (repeats + 1) * windowSize <= lines.length &&
        sameThoughtParagraphSequence(lines, index, index + repeats * windowSize, windowSize)
      ) {
        repeats++;
      }

      if (repeats >= 2) {
        collapsed.push(...lines.slice(index, index + windowSize));
        index += repeats * windowSize;
        matched = true;
        break;
      }
    }

    if (!matched) {
      collapsed.push(lines[index]);
      index++;
    }
  }

  return collapsed.join("\n");
}

function compactThoughtNoise(text: string): string {
  return String(text || "")
    .replace(/(?:[，,。.\-_]\s*){32,}/g, " ... ")
    .replace(/([，,。.!！？?;；:：])(?:\s*\1){6,}/g, "$1...")
    .replace(/(?:\*\s*){16,}/g, "**")
    .replace(/[^\S\r\n]{3,}/g, " ");
}

function findSuffixPrefixOverlap(existing: string, incoming: string): number {
  const max = Math.min(existing.length, incoming.length, 4000);
  for (let length = max; length > 20; length--) {
    if (existing.endsWith(incoming.slice(0, length))) return length;
  }
  return 0;
}

function limitThoughtContent(text: string): string {
  const content = String(text || "");
  if (content.length <= MAX_VISIBLE_THOUGHT_CHARS) return content;
  const head = content.slice(0, Math.floor(MAX_VISIBLE_THOUGHT_CHARS * 0.72)).trimEnd();
  const tail = content.slice(-Math.floor(MAX_VISIBLE_THOUGHT_CHARS * 0.18)).trimStart();
  const hidden = content.length - head.length - tail.length;
  return `${head}\n\n[后台思考内容过长，已折叠中间 ${hidden.toLocaleString()} 个字符，避免界面卡死。]\n\n${tail}`;
}

function compactThoughtContent(text: string): string {
  const collapsedParagraphs = collapseRepeatedThoughtParagraphs(String(text || ""));
  const collapsedLines = collapseRepeatedThoughtLines(collapsedParagraphs);
  return limitThoughtContent(compactThoughtNoise(collapsedLines));
}

function appendThoughtDelta(existing: string, incoming: string): string {
  const current = String(existing || "");
  const delta = String(incoming || "");
  if (!delta) return compactThoughtContent(current);
  if (!current) return compactThoughtContent(delta);

  const normalizedCurrent = normalizeThoughtTextForCompare(current);
  const normalizedDelta = normalizeThoughtTextForCompare(delta);
  if (normalizedDelta && normalizedCurrent.includes(normalizedDelta)) {
    return compactThoughtContent(current);
  }

  if (normalizedCurrent && normalizedDelta.startsWith(normalizedCurrent)) {
    return compactThoughtContent(delta);
  }

  if (delta.startsWith(current)) {
    return compactThoughtContent(delta);
  }

  const overlap = findSuffixPrefixOverlap(current, delta);
  return compactThoughtContent(current + (overlap > 0 ? delta.slice(overlap) : delta));
}

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
    const entries = await invoke<Array<{ name: string; is_dir: boolean }>>("list_directory", { path: workspace, workspace });
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
  analyze: { zh: "分析", en: "Analyze" },
  summarize: { zh: "总结", en: "Summarize" },
  report: { zh: "报告", en: "Report" },
  studio_workflow: { zh: "Game Studio 工作流", en: "Game Studio Workflow" },
};

function normalizeIntentSummary(summary: string): string {
  return summary.replace(/\s+/g, " ").trim();
}

function normalizeAgentContentForDedupe(content: string): string {
  return String(content || "")
    .replace(/<(?:analysis|thought|thinking|reasoning)(?:\s[^>]*)?>[\s\S]*?<\/(?:analysis|thought|thinking|reasoning)>/gi, " ")
    .replace(/<\/?(?:analysis|thought|thinking|reasoning)(?:\s[^>]*)?>/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isContinuationPrompt(input: string): boolean {
  return /^(?:继续|继续生成|继续输出|接着来|接着写|继续吧|go on|continue|keep going|proceed)[。.!！\s]*$/i.test(
    normalizeIntentSummary(input),
  );
}

function buildLocalTurnTitle(input: string, intent: ResolvedRunIntent, language: "zh" | "en"): string {
  const cleanedInput = summarizeUserPrompt(input, language === "en" ? 52 : 40);
  if (cleanedInput) return cleanedInput;

  const lowerInput = input.toLowerCase();
  const dataKeywords = /表格|excel|xlsx|csv|数据|用户画像|ltv|rfm|k-means|聚类|付费|注册|评论/i;
  if (dataKeywords.test(lowerInput)) {
    return language === "en" ? "Analyze user data" : "分析用户行为数据";
  }
  if (intent === "plan") return language === "en" ? "Create analysis plan" : "制定分析计划";
  if (intent === "report") return language === "en" ? "Generate report" : "生成分析报告";
  if (intent === "summarize") return language === "en" ? "Summarize materials" : "总结资料内容";
  if (intent === "analyze") return language === "en" ? "Analyze materials" : "分析资料内容";
  return language === "en" ? "New task" : "新的任务";
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

// region: 回合标题语义同步

const NOISY_TURN_INPUT_RE =
  /(?:\n|(?:\d{2,4}[-/]\d{1,2}[-/]\d{1,2}|\d{1,2}[-/]\d{1,2})\s+\d{1,2}:\d{2}(?::\d{2})?|^[A-Za-z][\w.-]{0,31}\s*[@:：-]\s*(?=\d{1,2}:\d{2}))/m;

function shouldRequestSemanticTurnMetadata(input: string, shouldSeedSessionTitle: boolean): boolean {
  const normalized = String(input || "").trim();
  if (!normalized) return false;
  if (shouldSeedSessionTitle) return true;
  return normalized.length > 72 || NOISY_TURN_INPUT_RE.test(normalized);
}

function stripJsonFence(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return fenced?.[1]?.trim() || trimmed;
}

function extractJsonObject(text: string): string | null {
  const cleaned = stripJsonFence(text);
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return cleaned.slice(start, end + 1);
  }
  return null;
}

function extractLooseSemanticTurnMetadata(text: string): Partial<SemanticTurnMetadata> | null {
  const normalized = String(text || "")
    .replace(/<think>[\s\S]*?<\/think>/gi, " ")
    .replace(/<(?:analysis|thought|thinking|reasoning)(?:\s[^>]*)?>[\s\S]*?<\/(?:analysis|thought|thinking|reasoning)>/gi, " ")
    .replace(/```[\s\S]*?```/g, " ")
    .trim();
  if (!normalized) return null;

  const titleMatch = normalized.match(/(?:^|[\n,，])\s*(?:title|标题)\s*[:：]\s*["“”']?([^\n,"“”'}]+)["“”']?/i);
  const summaryMatch = normalized.match(/(?:^|[\n,，])\s*(?:summary|摘要|总结)\s*[:：]\s*["“”']?([^\n"“”'}]+)["“”']?/i);
  const title = titleMatch?.[1]?.trim();
  const summary = summaryMatch?.[1]?.trim();
  if (title || summary) return { title, summary };

  const firstLine = normalized
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  return firstLine ? { title: firstLine } : null;
}

interface SemanticTurnMetadata {
  title: string;
  summary: string;
}

function normalizeSemanticTurnMetadata(
  raw: unknown,
  fallback: {
    input: string;
    intent: ResolvedRunIntent;
    language: "zh" | "en";
  },
): SemanticTurnMetadata {
  const candidate = raw && typeof raw === "object" ? raw as Partial<SemanticTurnMetadata> : {};
  const title = normalizeConversationDisplayTitle(
    typeof candidate.title === "string" ? candidate.title : fallback.input,
    fallback.language === "en" ? 48 : 32,
    fallback.language === "en" ? "New task" : "新的任务",
  );
  const summary = normalizeIntentSummary(typeof candidate.summary === "string" ? candidate.summary : "");
  return {
    title,
    summary: summary
      ? (summary.length <= 72 ? summary : `${summary.slice(0, 72).trim()}...`)
      : buildRunIntentSummary(fallback),
  };
}

// endregion

// ── Safe JSON Serialization ──────────────────────────────────────────
// Prevents Error 13 crashes when state contains non-serializable values
// (e.g., React elements, functions, circular references).

const MAX_PERSISTED_CONTEXT_COMPRESSION_CHARS = 2400;

function trimPersistedContextCompression(value: unknown): string | undefined {
  const text = String(value ?? "").trim();
  if (!text) return undefined;
  return text.length <= MAX_PERSISTED_CONTEXT_COMPRESSION_CHARS
    ? text
    : `${text.slice(0, MAX_PERSISTED_CONTEXT_COMPRESSION_CHARS).trim()}…`;
}

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
          ...(b.archivedAfterChoice ? { archivedAfterChoice: true } : {}),
          ...(b.selectedOption ? { selectedOption: String(b.selectedOption) } : {}),
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
        return { id: b.id, turnId: b.turnId, type: "thought" as const, content: compactThoughtContent(String(b.content)) };
      case "tool":
        return {
          id: b.id, turnId: b.turnId, type: "tool" as const,
          toolName: String(b.toolName), target: String(b.target),
          status: String(b.status),
          toolStatus: b.toolStatus,
          ...(b.message ? { message: String(b.message) } : {}),
          ...(b.diff ? { diff: { old: String(b.diff.old), new: String(b.diff.new), path: b.diff.path ? String(b.diff.path) : undefined } } : {}),
        };
      case "system":
        return {
          id: b.id,
          turnId: b.turnId,
          type: "system" as const,
          content: String(b.content),
          ...(b.icon ? { icon: String(b.icon) } : {}),
          ...(b.variant ? { variant: b.variant } : {}),
          ...(b.contextCompression
            ? (() => {
                const compressedContext = trimPersistedContextCompression(b.contextCompression?.compressedContext);
                return {
                  contextCompression: {
                    reason: b.contextCompression.reason,
                    droppedCount: Number(b.contextCompression.droppedCount) || 0,
                    tokenCountBefore: Number(b.contextCompression.tokenCountBefore) || 0,
                    tokenCountAfter: Number(b.contextCompression.tokenCountAfter) || 0,
                    tokenReduction: Number(b.contextCompression.tokenReduction) || 0,
                    ...(compressedContext ? { compressedContext } : {}),
                  },
                };
              })()
            : {}),
        };
      default:
        return b;
    }
  });
}

export function finalizeStreamingTaskBlocks(
  blocks: TaskBlock[],
  turnId: string,
  thoughtDuration?: number,
): TaskBlock[] {
  return blocks.map((block) => {
    if (block.turnId !== turnId) return block;

    if (block.type === "agent" && block.streaming) {
      const cleaned = block.content
        .replace(/<(?:analysis|thought|thinking|reasoning)(?:\s[^>]*)?>[\s\S]*?<\/(?:analysis|thought|thinking|reasoning)>/g, "")
        .replace(/<\/?(?:analysis|thought|thinking|reasoning)(?:\s[^>]*)?>/g, "")
        .trim();
      return { ...block, content: cleaned, streaming: false };
    }

    if (block.type === "thought" && block.isStreaming) {
      return {
        ...block,
        content: compactThoughtContent(block.content),
        isStreaming: false,
        ...(block.duration == null && thoughtDuration !== undefined ? { duration: thoughtDuration } : {}),
      };
    }

    return block;
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

function detectRequestedRootMarkdownDeliverables(text: string): string[] {
  const source = String(text || "");
  const hasRootHint = /(?:根目录|项目根目录|当前项目|workspace root|project root|root directory)/i.test(source);
  const names = Array.from(source.matchAll(/(?:^|[^\w./-])([A-Za-z][\w.-]*\.md|README\.md|Readme\.md|readme\.md)(?=$|[^\w./-])/g))
    .map((match) => match[1])
    .filter(Boolean)
    .map((name) => name.replace(/^readme\.md$/i, "Readme.md"))
    .filter((name) => !/^(?:requirements|design|tasks|bugfix)\.md$/i.test(name));

  if (names.length === 0 && hasRootHint && /(?:md\s*文档|markdown|说明文档|总结.*文档|Readme|README)/i.test(source)) {
    names.push("Readme.md");
  }

  return [...new Set(names)];
}

function hasRootMarkdownDeliverableEvidence(blocks: TaskBlock[], requestedDocs: string[]): boolean {
  if (requestedDocs.length === 0) return true;

  return requestedDocs.every((docName) => {
    const lowerName = docName.toLowerCase();
    return blocks.some((block) => {
      if (block.type !== "tool" || block.toolStatus !== "executed") return false;
      if (block.toolName !== "write_file" && block.toolName !== "replace_in_file") return false;
      const normalizedTarget = String(block.target || "").replace(/\\/g, "/").toLowerCase();
      if (!normalizedTarget || normalizedTarget.includes(".main/plans/")) return false;
      return normalizedTarget === lowerName || normalizedTarget.endsWith(`/${lowerName}`);
    });
  });
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

const FILE_VIEWER_BINARY_EXTENSIONS = new Set([
  ".exe", ".dll", ".so", ".dylib", ".bin", ".dat",
  ".zip", ".tar", ".gz", ".rar", ".7z", ".bz2", ".xz", ".zst",
  ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
  ".mp3", ".mp4", ".avi", ".mov", ".mkv", ".wav", ".flac", ".ogg", ".webm",
  ".woff", ".woff2", ".ttf", ".otf", ".eot",
  ".class", ".jar", ".war", ".pyc", ".o", ".a",
]);

function shouldUseDocumentReader(path: string): boolean {
  const lower = path.toLowerCase();
  for (const ext of STRUCTURED_ATTACHMENT_EXTENSIONS) {
    if (lower.endsWith(ext)) return true;
  }
  return false;
}

function isBinaryFileViewerPath(path: string): boolean {
  const fileName = path.split(/[\\/]/).pop()?.toLowerCase() || path.toLowerCase();
  if (fileName === "dockerfile" || fileName === "makefile") return false;
  const dotIdx = fileName.lastIndexOf(".");
  if (dotIdx === -1) return false;
  return FILE_VIEWER_BINARY_EXTENSIONS.has(fileName.slice(dotIdx));
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

function hasReviewablePlanState(artifacts: PlanArtifact[], stage: PlanStage): boolean {
  if (stage === "ready_to_execute" || stage === "design" || stage === "bugfix") return true;
  return artifacts.some((artifact) => artifact.kind === "design" || artifact.kind === "bugfix");
}

function blockHasVisibleAgentContent(block: TaskBlock): boolean {
  if (block.type !== "agent" || block.hiddenProcess) return false;
  if (Array.isArray(block.options) && block.options.length > 0) return true;
  return String(block.content || "").trim().length > 0;
}

function deriveIdleConversationTurnStatus(input: {
  turnId: string;
  effectiveRunIntent: ResolvedRunIntent;
  isPlanApproved: boolean;
  planArtifacts: PlanArtifact[];
  planStage: PlanStage;
  planTasks: PlanTask[];
  planExecutionEvidenceCount: number;
  replyOptionCount: number;
  taskFlow: TaskBlock[];
  override?: ConversationTurnStatus | null;
}): ConversationTurnStatus {
  if (input.replyOptionCount > 0) return "awaiting_input";
  if (input.override) return input.override;

  const turnBlocks = input.taskFlow.filter((block) => block.turnId === input.turnId);
  const userPrompt = String(turnBlocks.find((block) => block.type === "user")?.content || "");
  const requestedDocs = detectRequestedRootMarkdownDeliverables(userPrompt);
  const hasVisibleAgent = turnBlocks.some(blockHasVisibleAgentContent);
  const hasAnyTool = turnBlocks.some((block) => block.type === "tool");
  const hasTasksArtifact =
    input.planTasks.length > 0 ||
    input.planArtifacts.some((artifact) => artifact.kind === "tasks");
  const allTasksComplete =
    input.planTasks.length > 0 &&
    input.planTasks.every((task) => task.status === "completed");
  const hasExecutionEvidence =
    input.planExecutionEvidenceCount > 0 ||
    turnBlocks.some((block) =>
      block.type === "tool" &&
      block.toolStatus === "executed" &&
      isPlanExecutionEvidenceTool(block.toolName, block.target),
    );
  const hasRequestedDeliverables = hasRootMarkdownDeliverableEvidence(turnBlocks, requestedDocs);

  if (input.effectiveRunIntent === "plan" && !input.isPlanApproved) {
    if (hasReviewablePlanState(input.planArtifacts, input.planStage)) {
      return "awaiting_approval";
    }
    return hasVisibleAgent || hasAnyTool ? "stopped_no_action" : "stopped_no_output";
  }

  if (input.effectiveRunIntent === "plan" && input.isPlanApproved) {
    if (hasExecutionEvidence && hasTasksArtifact && allTasksComplete && hasRequestedDeliverables) {
      return "completed_with_changes";
    }
    return hasVisibleAgent || hasAnyTool || hasTasksArtifact ? "stopped_no_action" : "stopped_no_output";
  }

  if (input.effectiveRunIntent === "execute" || input.effectiveRunIntent === "studio_workflow") {
    if (hasExecutionEvidence) return "completed_with_changes";
    return hasVisibleAgent || hasAnyTool ? "stopped_no_action" : "stopped_no_output";
  }

  if (hasExecutionEvidence) return "completed_with_changes";
  return "done";
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
    invoke("cancel_proxy_request").catch(() => {});
    invoke("cancel_chat_stream").catch(() => {});
    const currentStatus = get().agentStatus;
    const clearCurrentTurnOptions = () => {
      if (!currentTurnId) return;
      set((s) => ({
        taskFlow: s.taskFlow.map((block) =>
          block.turnId === currentTurnId && block.type === "agent" && block.options?.length
            ? { ...block, options: undefined }
            : block,
        ),
      }));
    };
    // Preserve pending_review so the plan panel stays visible
    if (currentStatus === "pending_review") {
      set({ isGenerating: false, abortController: null });
      if (currentTurnId) {
        get().setConversationTurnStatus(currentTurnId, "awaiting_approval");
      }
    } else {
      clearCurrentTurnOptions();
      set({
        isGenerating: false,
        abortController: null,
        agentStatus: "idle",
        pendingRunDecision: null,
        pendingRunDecisionResolver: null,
      });
      if (currentTurnId) {
        get().setConversationTurnStatus(currentTurnId, "stopped_no_action");
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
    if (isBinaryFileViewerPath(path)) {
      set({ fileViewerContent: "", fileViewerError: "", fileViewerLoading: false });
      return;
    }
    try {
      const content = await readFile(path, get().currentWorkspace);
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
  lockedComposerIntent: null,
  pendingRunDecision: null,
  executionConsentPolicy: "ask_per_turn",
  setInput: (v) => set({
    input: v,
    ...(v.trim().length === 0 ? { lockedComposerIntent: null } : {}),
  }),
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
    lockedComposerIntent: null,
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
  setLockedComposerIntent: (intent) => set({ lockedComposerIntent: intent }),
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
                status === "awaiting_approval" || status === "awaiting_input" || status === "error"
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

  // IM adapters
  feishuAdapterStatus: createDefaultFeishuAdapterRuntimeStatus(),
  feishuPairingRequests: [],
  pendingFeishuApprovals: [],
  setFeishuAdapterStatus: (status) =>
    set((s) => ({
      feishuAdapterStatus: {
        ...s.feishuAdapterStatus,
        ...status,
        updatedAt: status.updatedAt ?? Date.now(),
      },
    })),
  upsertFeishuPairingRequest: (request) =>
    set((s) => ({
      feishuPairingRequests: upsertFeishuPairingRequest(s.feishuPairingRequests, request),
    })),
  removeFeishuPairingRequest: (openId) =>
    set((s) => ({
      feishuPairingRequests: s.feishuPairingRequests.filter((request) => request.openId !== openId),
    })),
  clearFeishuPairingRequests: () => set({ feishuPairingRequests: [] }),
  addPendingFeishuApproval: (approval) =>
    set((s) => ({
      pendingFeishuApprovals: [
        approval,
        ...s.pendingFeishuApprovals.filter((item) => item.code !== approval.code),
      ].slice(0, 20),
    })),
  resolvePendingFeishuApproval: (userId, code) => {
    const normalizedCode = code.trim().toLowerCase();
    const state = get();
    const approval = state.pendingFeishuApprovals.find((item) =>
      item.userId === userId && item.code.toLowerCase() === normalizedCode,
    ) || null;
    if (!approval) return null;
    set((s) => ({
      pendingFeishuApprovals: s.pendingFeishuApprovals.filter((item) => item.code !== approval.code),
    }));
    return approval;
  },

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
  workspaces: [],
  activeSessionByWorkspace: {},
  runtimeBySessionKey: {},
  currentWorkspace: "",
  selectedWorkspace: "",
  currentSessionId: null,

  addWorkspaceEntry: (path: string) => {
    const normalizedPath = path.trim();
    if (!normalizedPath || normalizedPath === GLOBAL_CHAT_KEY) return;
    set((s) => {
      const now = Date.now();
      const existing = s.workspaces.find((entry) => entry.path === normalizedPath);
      const nextEntry: WorkspaceEntry = {
        path: normalizedPath,
        name: existing?.name || getWorkspaceDisplayName(normalizedPath),
        addedAt: existing?.addedAt || now,
        lastActiveAt: now,
      };
      return {
        workspaces: existing
          ? s.workspaces.map((entry) => entry.path === normalizedPath ? nextEntry : entry)
          : [...s.workspaces, nextEntry],
        sessionsByWorkspace: {
          ...s.sessionsByWorkspace,
          [normalizedPath]: s.sessionsByWorkspace[normalizedPath] || [],
        },
      };
    });
  },
  removeWorkspaceEntry: (path: string) => {
    const normalizedPath = path.trim();
    if (!normalizedPath) return;
    set((s) => ({
      workspaces: s.workspaces.filter((entry) => entry.path !== normalizedPath),
      activeSessionByWorkspace: Object.fromEntries(
        Object.entries(s.activeSessionByWorkspace).filter(([key]) => key !== normalizedPath),
      ),
    }));
  },
  getCurrentSessionKey: () => {
    const state = get();
    return resolveSessionRuntimeKey(resolveSessionWorkspaceKey(state.currentWorkspace), state.currentSessionId);
  },
  saveCurrentRuntimeToSession: () => {
    const state = get();
    const sessionKey = resolveSessionRuntimeKey(resolveSessionWorkspaceKey(state.currentWorkspace), state.currentSessionId);
    if (!sessionKey) return;
    set((s) => ({
      runtimeBySessionKey: {
        ...s.runtimeBySessionKey,
        [sessionKey]: createSessionRuntimeFromState(s),
      },
    }));
  },
  restoreRuntimeForSession: (sessionKey: string | null) => {
    if (!sessionKey) return false;
    const runtime = get().runtimeBySessionKey[sessionKey];
    if (!runtime) return false;
    set(getSessionRuntimeUiPatch(runtime));
    return true;
  },
  updateRuntimeForSession: (sessionKey, patchOrUpdater) => {
    if (!sessionKey) return;
    set((s) => {
      const existing = s.runtimeBySessionKey[sessionKey] || createSessionRuntimeFromState(s);
      const patch =
        typeof patchOrUpdater === "function"
          ? patchOrUpdater(existing)
          : patchOrUpdater;
      return {
        runtimeBySessionKey: {
          ...s.runtimeBySessionKey,
          [sessionKey]: {
            ...existing,
            ...pickSessionRuntimePatch(patch),
          },
        },
      };
    });
  },
  setCurrentWorkspace: (path: string) => {
    invalidateWorkspaceTreeCache();
    const normalizedPath = path.trim();
    if (!normalizedPath) {
      set((s) => ({
        currentWorkspace: "",
        config: { ...s.config, workspace: "" },
        sessionHookCache: [],
        readOnlyAutoApproveForSession: false,
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
      const activeSessionByWorkspace = { ...s.activeSessionByWorkspace };
      if (s.currentWorkspace) {
        activeSessionByWorkspace[resolveSessionWorkspaceKey(s.currentWorkspace)] = s.currentSessionId;
      }
      const now = Date.now();
      const nextWorkspaceEntry: WorkspaceEntry = {
        path: normalizedPath,
        name: getWorkspaceDisplayName(normalizedPath),
        addedAt: s.workspaces.find((entry) => entry.path === normalizedPath)?.addedAt || now,
        lastActiveAt: now,
      };
      return {
        currentWorkspace: normalizedPath,
        selectedWorkspace: normalizedPath,
        sessionsByWorkspace: updated,
        workspaces: s.workspaces.some((entry) => entry.path === normalizedPath)
          ? s.workspaces.map((entry) => entry.path === normalizedPath ? nextWorkspaceEntry : entry)
          : [...s.workspaces, nextWorkspaceEntry],
        activeSessionByWorkspace,
        config: { ...s.config, workspace: normalizedPath },
        sessionHookCache: [],
        readOnlyAutoApproveForSession: false,
      };
    });
    // Register the workspace as a trusted root in the Rust backend before tools run.
    void setWorkspaceRootIpc(normalizedPath)
      .then((canonicalPath) => {
        const stablePath = canonicalPath || normalizedPath;
        set((s) => ({
          currentWorkspace: stablePath,
          selectedWorkspace: stablePath,
          sessionsByWorkspace: {
            ...s.sessionsByWorkspace,
            [stablePath]: s.sessionsByWorkspace[stablePath] || s.sessionsByWorkspace[normalizedPath] || [],
          },
          activeSessionByWorkspace: {
            ...s.activeSessionByWorkspace,
            [stablePath]: s.activeSessionByWorkspace[stablePath] ?? s.activeSessionByWorkspace[normalizedPath] ?? s.currentSessionId,
          },
          workspaces: (() => {
            const existing = s.workspaces.find((entry) => entry.path === stablePath || entry.path === normalizedPath);
            const nextEntry = {
              path: stablePath,
              name: getWorkspaceDisplayName(stablePath),
              addedAt: existing?.addedAt || Date.now(),
              lastActiveAt: Date.now(),
            };
            if (!existing) return [...s.workspaces, nextEntry];
            return s.workspaces.map((entry) =>
              entry.path === stablePath || entry.path === normalizedPath ? nextEntry : entry
            );
          })(),
          config: { ...s.config, workspace: stablePath },
        }));
        invalidateWorkspaceTreeCache();
        return get().refreshInstructionAndHookState();
      })
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
      const sessionKey = resolveSessionRuntimeKey(workspacePath, sessionId);
      const runtimeBySessionKey = { ...s.runtimeBySessionKey };
      if (sessionKey) delete runtimeBySessionKey[sessionKey];
      return {
        sessionsByWorkspace: {
          ...s.sessionsByWorkspace,
          [workspacePath]: filtered,
        },
        runtimeBySessionKey,
        currentSessionId:
          s.currentSessionId === sessionId
            ? filtered[0]?.id ?? null
            : s.currentSessionId,
        ...(s.currentSessionId === sessionId ? { readOnlyAutoApproveForSession: false } : {}),
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

  setCurrentSessionId: (id: number | null) =>
    set((s) => ({
      currentSessionId: id,
      activeSessionByWorkspace: {
        ...s.activeSessionByWorkspace,
        [resolveSessionWorkspaceKey(s.currentWorkspace)]: id,
      },
      ...(s.currentSessionId !== id ? { readOnlyAutoApproveForSession: false } : {}),
    })),

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
      const runtimeBySessionKey = { ...s.runtimeBySessionKey };
      if (ws) {
        delete sessionsByWorkspace[ws];
        Object.keys(runtimeBySessionKey).forEach((key) => {
          if (key.startsWith(`${ws}:`)) delete runtimeBySessionKey[key];
        });
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
        readOnlyAutoApproveForSession: false,
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
        runtimeBySessionKey,
      };
    });
  },

  resetAllSettings: () => {
    set({
      config: defaultConfig,
      skills: defaultSkills,
      mcpServers: [{ name: "unityMCP", type: "http", url: "http://localhost:8080/mcp" }],
      sessionsByWorkspace: {},
      workspaces: [],
      activeSessionByWorkspace: {},
      runtimeBySessionKey: {},
      selectedWorkspace: "",
      currentSessionId: null,
      selectedMainModeKey: "main_mode",
      selectedNexusModeKey: "nexus_general",
      taskFlow: [],
      agentMessages: [],
      messages: [],
      feishuAdapterStatus: createDefaultFeishuAdapterRuntimeStatus(),
      feishuPairingRequests: [],
      pendingFeishuApprovals: [],
      selectedDiffTaskId: null,
      conversationTurns: [],
      currentTurnId: null,
      pendingRunDecision: null,
      pendingRunDecisionResolver: null,
      executionConsentPolicy: "ask_per_turn",
      currentTurnExecutionConsent: { turnId: null, granted: false },
      readOnlyAutoApproveForSession: false,
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
      const validation = validatePlanArtifactContent(sanitizedContent, artifact.kind);
      if (!validation.ok) {
        logStoreEvent("plan_artifact_rejected_by_quality_gate", {
          path: artifact.path,
          kind: artifact.kind,
          reason: validation.reason,
          contentChars: sanitizedContent.length,
        });
        return {};
      }

      const nextArtifacts = [...s.planArtifacts];
      const existingIndex = nextArtifacts.findIndex((item) => item.path === artifact.path);
      if (existingIndex >= 0) {
        nextArtifacts[existingIndex] = { ...artifact, content: sanitizedContent };
      } else {
        nextArtifacts.push({ ...artifact, content: sanitizedContent });
      }

      const parsedTasks = artifact.kind === "tasks" || artifact.kind === "bugfix"
        ? extractPlanTasks(sanitizedContent)
        : s.planTasks;
      const preserveTaskHistory =
        s.isPlanApproved ||
        s.planStage === "executing" ||
        s.planStage === "completed" ||
        s.planTasks.length > 0;
      const droppedTasks = artifact.kind === "tasks" || artifact.kind === "bugfix"
        ? findDroppedPlanTasks(s.planTasks, parsedTasks)
        : [];
      if (droppedTasks.length > 0) {
        logStoreEvent("plan_tasks_preserved_missing_history", {
          path: artifact.path,
          droppedTasks: droppedTasks.map((task) => task.text).slice(0, 8),
          droppedCount: droppedTasks.length,
        });
      }
      const nextTasks = artifact.kind === "tasks" || artifact.kind === "bugfix"
        ? mergePlanTasks(s.planTasks, parsedTasks, preserveTaskHistory)
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
      logStoreEvent("plan_artifact_stage_transition", {
        path: artifact.path,
        kind: artifact.kind,
        previousStage: s.planStage,
        nextStage,
        artifacts: nextArtifacts.length,
        tasks: normalizedTasks.length,
        approved: s.isPlanApproved,
      });

      return {
        planArtifacts: nextArtifacts.sort((a, b) => a.updatedAt - b.updatedAt),
        planStage: nextStage,
        planTasks: normalizedTasks,
        showPlanPanel: true,
        rightPanelTab: s.showDiff && s.rightPanelTab === "diff" ? "diff" as const : "plan" as const,
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
    planTasks: normalizePlanTaskStatuses(
      mergePlanTasks(
        s.planTasks,
        tasks,
        s.isPlanApproved || s.planStage === "executing" || s.planStage === "completed" || s.planTasks.length > 0,
      ),
      s.isPlanApproved && s.planExecutionEvidenceCount > 0,
    ),
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
            const currentPlanTurn = state.currentTurnId
              ? state.conversationTurns.find((turn) => turn.id === state.currentTurnId)
              : null;
            const requestedDocs = detectRequestedRootMarkdownDeliverables(currentPlanTurn?.userPrompt || "");
            const deliverableHint = requestedDocs.length > 0
              ? state.config.language === "en"
                ? ` The final tasks must include writing ${requestedDocs.map((name) => `project-root \`${name}\``).join(", ")} before completion.`
                : ` 最终 tasks 必须包含写入${requestedDocs.map((name) => `项目根目录 \`${name}\``).join("、")}，完成前必须真实落盘。`
              : "";

            if (state.config.language === "en") {
              return hasTasksArtifact
              ? "The plan is approved. Continue directly from the current tasks.md and execute the remaining items without repeating the plan. Do not delete completed or previous task records; only check items off or append new tasks." + deliverableHint + "\n\n" + buildPlanCommandExecutionHint(state.planTasks, "en")
                : "The plan is approved. First generate `.MAIN/plans/tasks.md` from the approved requirements/design or bugfix, then execute the remaining work from that task list without repeating the plan. Keep tasks.md concise: 8-20 checkboxes, one sentence each. When a task needs shell work, include the exact command in backticks inside tasks.md; use run_command for finite commands, or execute_command plus PTY read/status tools for long-running or interactive commands. During execution tasks.md is an audit record; never delete completed or previous tasks." + deliverableHint;
            }

            return hasTasksArtifact
              ? "计划已批准。请直接基于当前 tasks.md 继续执行剩余任务，不要重复计划内容。不要删除已完成或旧任务记录，只能勾选或追加任务。" + deliverableHint + "\n\n" + buildPlanCommandExecutionHint(state.planTasks, "zh")
              : "计划已批准。请先基于已批准的 requirements/design 或 bugfix 生成 `.MAIN/plans/tasks.md`，然后再按照任务清单继续执行，不要重复计划内容。tasks.md 必须精简为 8-20 个 checkbox，每项一句话。对于需要 shell 的任务，请把精确命令写进 tasks.md 的 checkbox 并用反引号包裹；一次性命令用 run_command，长驻或交互式命令用 execute_command 后再读取 PTY 日志/状态。执行中 tasks.md 是审计记录，不能删除已完成或旧任务。" + deliverableHint;
          })(),
          undefined,
          { hidden: true, reuseCurrentTurn: true, preservePlanState: true },
        );
      });
    })(),
  rejectPlan: () => {
    const state = get();
    state.abortController?.abort();
    set({
      isPlanApproved: false,
      planExecutionEvidenceCount: 0,
      agentStatus: "idle",
      isGenerating: false,
      abortController: null,
      showPlanPanel: state.planArtifacts.length > 0 || state.planStage !== "idle" ? true : state.showPlanPanel,
      rightPanelTab: state.planArtifacts.length > 0 || state.planStage !== "idle" ? "plan" : state.rightPanelTab,
    });
    if (state.currentTurnId) {
      get().setConversationTurnStatus(state.currentTurnId, "stopped_no_action");
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
  readOnlyAutoApproveForSession: false,
  currentTurnExecutionConsent: { turnId: null, granted: false },
  pendingRunDecisionResolver: null,
  setAutoApproveTools: (v) => set({ autoApproveTools: v }),
  setReadOnlyAutoApproveForSession: (v) => set({ readOnlyAutoApproveForSession: v }),
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

    set((s) => ({
      pendingReviewResolve: null,
      pendingReviewTaskId: null,
      pendingToolCall: null,
      selectedDiffTaskId: s.selectedDiffTaskId === taskId ? null : s.selectedDiffTaskId,
      showDiff: false,
      agentStatus: "running",
      isGenerating: true,
      taskFlow: s.taskFlow.map((task) =>
        task.id === taskId && task.type === "tool"
          ? {
              ...task,
              status: "running",
              toolStatus: "running",
              message: "Executing...",
            }
          : task
      ),
    }));
    if (state.currentTurnId) {
      get().setConversationTurnStatus(state.currentTurnId, "executing");
    }
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
      pendingFeishuApprovals: [],
      autoApproveTools: false,
      readOnlyAutoApproveForSession: false,
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
    turnTitle?: string;
    intentSummary?: string;
    contextMentionsSnapshot?: string[];
    attachedFilesSnapshot?: string[];
    remoteFeishu?: FeishuRemoteContext;
  }) => {
    const state = get();
    const sendStartedAt = nowMs();
    console.log('[sendMessage] called, text:', text?.slice(0, 50), 'agentStatus:', state.agentStatus, 'workspace:', state.currentWorkspace, 'activeProfile:', state.config.activeProfile);
    const isHidden = options?.hidden === true;
    const mentionSnapshot = options?.contextMentionsSnapshot ?? state.contextMentions;
    const attachedFilesSnapshot = options?.attachedFilesSnapshot ?? state.attachedFiles;
    const remoteFeishu = options?.remoteFeishu;
    const hasSupplementalInput = mentionSnapshot.length > 0 || attachedFilesSnapshot.length > 0;
    const currentTurn = state.currentTurnId
      ? state.conversationTurns.find((turn) => turn.id === state.currentTurnId) || null
      : null;
    const currentTurnIntent = resolveConversationTurnIntent(currentTurn);
    const currentMainModeKey = state.selectedMainModeKey;
    const shouldContinuePlanIntent =
      !isHidden &&
      currentMainModeKey === "main_mode" &&
      currentTurnIntent === "plan" &&
      isContinuationPrompt(text) &&
      (state.planStage !== "completed" || state.planArtifacts.length === 0);
    const shouldAutoResumeChoiceTurn =
      !isHidden &&
      options?.reuseCurrentTurn !== true &&
      currentTurn?.status === "awaiting_input";
    const reuseCurrentTurn =
      (options?.reuseCurrentTurn === true || shouldAutoResumeChoiceTurn) &&
      !!state.currentTurnId;
    const shouldReuseExistingTurnIntent =
      reuseCurrentTurn &&
      currentTurn?.status === "awaiting_input";
    const preservePlanState =
      options?.preservePlanState === true ||
      shouldContinuePlanIntent ||
      (shouldReuseExistingTurnIntent && currentTurnIntent === "plan") ||
      (shouldAutoResumeChoiceTurn && currentTurnIntent === "plan");
    const parsedStudioCommand = currentMainModeKey === "game_studio"
      ? parseGameStudioSlashCommand(text)
      : null;
    const preferredLanguage = isHidden
      ? state.preferredResponseLanguage
      : parsedStudioCommand
      ? state.config.language
      : detectDominantLanguage(text, state.config.language);
    const mainIntentShortcut = !isHidden && currentMainModeKey === "main_mode"
      ? parseMainIntentShortcut(text)
      : null;
    if (mainIntentShortcut) {
      text = mainIntentShortcut.rest.trimStart();
    }
    const lockedComposerIntent = !isHidden && currentMainModeKey === "main_mode"
      ? state.lockedComposerIntent || mainIntentShortcut?.intent || null
      : null;
    if (!text.trim() && !hasSupplementalInput && !images?.length) {
      return false;
    }
    logStoreEvent("send_start", {
      textChars: text.length,
      isHidden,
      reuseCurrentTurn,
      shouldAutoResumeChoiceTurn,
      shouldReuseExistingTurnIntent,
      skipIntentResolution: options?.skipIntentResolution === true,
      preservePlanState,
      currentTurnId: state.currentTurnId,
      currentTurnStatus: currentTurn?.status ?? null,
      currentTurnIntent,
      selectedMainModeKey: currentMainModeKey,
      taskFlowBlocks: state.taskFlow.length,
      agentMessages: state.agentMessages.length,
      conversationTurns: state.conversationTurns.length,
      contextMentions: mentionSnapshot.length,
      attachedFiles: attachedFilesSnapshot.length,
      images: images?.length ?? 0,
    });
    const isLocalStudioCommand =
      parsedStudioCommand?.type === "agent" || parsedStudioCommand?.type === "auto";
    let effectiveRunIntent =
      options?.resolvedIntent ||
      lockedComposerIntent ||
      (shouldContinuePlanIntent ? "plan" : null) ||
      ((preservePlanState || shouldReuseExistingTurnIntent)
        ? currentTurnIntent
        : resolveRunIntentFromLegacyWorkflowMode(state.config.workflowMode));
    let effectiveIntentSummary = normalizeIntentSummary(options?.intentSummary || "");

    if (shouldContinuePlanIntent && !effectiveIntentSummary) {
      effectiveIntentSummary = buildRunIntentSummary({
        input: currentTurn?.userPrompt || text,
        intent: "plan",
        language: preferredLanguage,
        reason: preferredLanguage === "en"
          ? "Continue the previous planning turn until the plan is produced."
          : "继续上一轮计划目标，直到生成计划结果。",
      });
    }

    if (lockedComposerIntent && !effectiveIntentSummary) {
      effectiveIntentSummary = buildRunIntentSummary({
        input: text,
        intent: lockedComposerIntent,
        language: preferredLanguage,
        reason: preferredLanguage === "en"
          ? "The user confirmed this composer intent before sending."
          : "用户已在发送前确认本轮胶囊意图。",
      });
    }

    if (!isHidden && !lockedComposerIntent && !shouldContinuePlanIntent && !shouldReuseExistingTurnIntent && !options?.skipIntentResolution && !options?.resolvedIntent) {
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
          lockedComposerIntent: null,
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
          lockedComposerIntent: null,
          pendingRunDecision: null,
        });
        get().sendMessage(
          preferredLanguage === "en"
            ? hasTasksArtifact
              ? "Continue the remaining unfinished items in `.MAIN/plans/tasks.md` without repeating the plan. Start from the first unchecked task and update tasks.md as each item is completed. Do not delete completed or previous task records."
              : "First regenerate `.MAIN/plans/tasks.md` from the approved requirements/design or bugfix, then continue the remaining execution without repeating the plan."
            : hasTasksArtifact
            ? "请继续执行 `.MAIN/plans/tasks.md` 中剩余未完成的任务，不要重复计划说明。先从第一个未完成 checkbox 对应的任务开始，完成后及时更新 tasks.md。不要删除已完成或旧任务记录。"
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

      // 普通消息不应该因为额外的意图 preflight 而阻塞发送热路径。
      // 只有低置信度且真的可能改变流程的请求，才允许在这里等待 preflight。
      if (shouldUseBlockingIntentPreflight(resolution, currentMainModeKey)) {
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
            turnTitle: preflight?.title,
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

    const effectiveIntentPolicy = getIntentPolicy(effectiveRunIntent);
    const effectiveWorkflowMode = effectiveIntentPolicy.workflowMode;
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
            state.agentStatus === "pending_review" ? "awaiting_approval" : "stopped_no_action",
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
    const hasValidCurrentSession =
      ensuredSessionId != null &&
      workspaceSessions.some((session) => session.id === ensuredSessionId);
    if (!hasValidCurrentSession) {
      const autoSessionId = Date.now();
      const autoSessionTitle = state.currentWorkspace.trim()
        ? (state.config.language === "en" ? "New Conversation" : "新会话")
        : (state.config.language === "en" ? "New Chat" : "新聊天");
      const storageStatus: "ok" | "temporary" = state.config.sessionRecordingEnabled ? "ok" : "temporary";
      const autoSession: Session = {
        id: autoSessionId,
        title: autoSessionTitle,
        date: new Date().toISOString(),
        active: true,
        storageStatus,
        recordingDisabled: !state.config.sessionRecordingEnabled,
        messages: [],
      };

      set((s) => ({
        sessionsByWorkspace: {
          ...s.sessionsByWorkspace,
          [sessionScopeKey]: [
            autoSession,
            ...(s.sessionsByWorkspace[sessionScopeKey] || []).map((session) => ({
              ...session,
              active: false,
            })),
          ],
        },
        currentSessionId: autoSessionId,
        readOnlyAutoApproveForSession: false,
      }));

      ensuredSessionId = autoSessionId;
    }

    const runWorkspace = state.currentWorkspace;
    const runScopeKey = sessionScopeKey;
    const runSessionId = ensuredSessionId;
    const runSessionKey = resolveSessionRuntimeKey(runScopeKey, runSessionId)!;
    set((s) => ({
      runtimeBySessionKey: {
        ...s.runtimeBySessionKey,
        [runSessionKey]: createSessionRuntimeFromState(s),
      },
    }));
    const isRunSessionActive = (candidate = get()) =>
      resolveSessionRuntimeKey(resolveSessionWorkspaceKey(candidate.currentWorkspace), candidate.currentSessionId) === runSessionKey;
    const sessionSet = (
      patchOrUpdater:
        | Record<string, unknown>
        | Partial<AppState>
        | ((state: AppState) => Record<string, unknown> | Partial<AppState>),
    ) => {
      set((s) => {
        const active = isRunSessionActive(s);
        const existing = s.runtimeBySessionKey[runSessionKey] || createSessionRuntimeFromState(s);
        const baseState = active ? s : ({ ...s, ...existing } as AppState);
        const patch =
          typeof patchOrUpdater === "function"
            ? patchOrUpdater(baseState)
            : patchOrUpdater;
        if (!patch || typeof patch !== "object") return {};
        const runtimePatch = pickSessionRuntimePatch(patch);
        const globalPatch = active
          ? patch
          : omitSessionRuntimePatch(patch as Record<string, unknown>);
        return {
          ...globalPatch,
          runtimeBySessionKey: {
            ...s.runtimeBySessionKey,
            [runSessionKey]: {
              ...existing,
              ...runtimePatch,
            },
          },
        };
      });
    };
    const sessionSetConversationTurnStatus = (targetTurnId: string, status: ConversationTurnStatus) =>
      sessionSet((s) => ({
        conversationTurns: s.conversationTurns.map((turn) =>
          turn.id === targetTurnId
            ? {
                ...turn,
                status,
                collapsed:
                  status === "awaiting_approval" || status === "awaiting_input" || status === "error"
                    ? false
                    : turn.collapsed,
              }
            : turn,
        ),
      }));
    const sessionUpdateConversationTurn = (targetTurnId: string, patch: Partial<ConversationTurn>) =>
      sessionSet((s) => ({
        conversationTurns: s.conversationTurns.map((turn) =>
          turn.id === targetTurnId ? { ...turn, ...patch } : turn
        ),
      }));
    const sessionSetConversationTurnSummary = (targetTurnId: string, summary: string) =>
      sessionUpdateConversationTurn(targetTurnId, { summary });
    const sessionSetPlanTasks = (tasks: PlanTask[]) =>
      sessionSet((s) => ({
        planTasks: normalizePlanTaskStatuses(
          mergePlanTasks(
            s.planTasks,
            tasks,
            s.isPlanApproved || s.planStage === "executing" || s.planStage === "completed" || s.planTasks.length > 0,
          ),
          s.isPlanApproved && s.planExecutionEvidenceCount > 0,
        ),
      }));
    const sessionUpsertPlanArtifact = (artifact: PlanArtifact) =>
      sessionSet((s) => {
        const sanitizedContent = sanitizePlanArtifactContent(artifact.content);
        const validation = validatePlanArtifactContent(sanitizedContent, artifact.kind);
        if (!validation.ok) {
          logStoreEvent("plan_artifact_rejected_by_quality_gate", {
            path: artifact.path,
            kind: artifact.kind,
            reason: validation.reason,
            contentChars: sanitizedContent.length,
          });
          return {};
        }

        const nextArtifacts = [...s.planArtifacts];
        const existingIndex = nextArtifacts.findIndex((item) => item.path === artifact.path);
        if (existingIndex >= 0) {
          nextArtifacts[existingIndex] = { ...artifact, content: sanitizedContent };
        } else {
          nextArtifacts.push({ ...artifact, content: sanitizedContent });
        }

        const parsedTasks = artifact.kind === "tasks" || artifact.kind === "bugfix"
          ? extractPlanTasks(sanitizedContent)
          : s.planTasks;
        const preserveTaskHistory =
          s.isPlanApproved ||
          s.planStage === "executing" ||
          s.planStage === "completed" ||
          s.planTasks.length > 0;
        const nextTasks = artifact.kind === "tasks" || artifact.kind === "bugfix"
          ? mergePlanTasks(s.planTasks, parsedTasks, preserveTaskHistory)
          : s.planTasks;
        const normalizedTasks = normalizePlanTaskStatuses(
          nextTasks.length > 0 ? nextTasks : s.planTasks,
          s.isPlanApproved && s.planExecutionEvidenceCount > 0,
        );
        return {
          planArtifacts: nextArtifacts.sort((a, b) => a.updatedAt - b.updatedAt),
          planStage: derivePlanStageFromArtifacts(
            nextArtifacts,
            normalizedTasks,
            s.isPlanApproved,
            s.planStage,
          ),
          planTasks: normalizedTasks,
          showPlanPanel: true,
          rightPanelTab: s.showDiff && s.rightPanelTab === "diff" ? "diff" : "plan",
        };
      });
    const sessionOpenRightPanelTab = (tab: RightPanelTab) =>
      sessionSet({
        rightPanelTab: tab,
        showPlanPanel: tab === "plan",
        showDiff: tab === "diff",
        showTerminal: tab === "terminal",
        showFilePanel: tab === "file",
      });
    const sessionGet = (): AppState => {
      const live = get();
      const runtime = live.runtimeBySessionKey[runSessionKey] || createSessionRuntimeFromState(live);
      const scoped = (isRunSessionActive(live) ? live : { ...live, ...runtime }) as AppState;
      return {
        ...scoped,
        setConversationTurnStatus: sessionSetConversationTurnStatus,
        updateConversationTurn: sessionUpdateConversationTurn,
        setConversationTurnSummary: sessionSetConversationTurnSummary,
        setPlanStage: (stage: PlanStage) => sessionSet({ planStage: stage }),
        setPlanTasks: sessionSetPlanTasks,
        upsertPlanArtifact: sessionUpsertPlanArtifact,
        setNormalizedStreamState: (streamState: NormalizedStreamState) => sessionSet({ normalizedStreamState: streamState }),
        openRightPanelTab: sessionOpenRightPanelTab,
        setRightPanelTab: sessionOpenRightPanelTab,
        closeRightPanel: () => sessionSet({ showPlanPanel: false, showDiff: false, showTerminal: false, showFilePanel: false }),
        startNewTurn: () =>
          sessionSet({
            currentTurnState: {
              ...createDefaultCurrentTurnState(),
              turnId: Date.now().toString(),
            },
          }),
        getCurrentRunIntent: () => {
          const current = scoped.currentTurnId
            ? scoped.conversationTurns.find((turn) => turn.id === scoped.currentTurnId) || null
            : null;
          return current
            ? resolveConversationTurnIntent(current)
            : resolveRunIntentFromLegacyWorkflowMode(scoped.config.workflowMode);
        },
      };
    };

    const nextId = sessionGet()._nextTaskId;
    const turnId = reuseCurrentTurn ? state.currentTurnId! : `turn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const existingTurn = reuseCurrentTurn
      ? state.conversationTurns.find((turn) => turn.id === state.currentTurnId) || null
      : null;
    const existingTitle = existingTurn?.title && !isGenericConversationTitle(existingTurn.title)
      ? existingTurn.title
      : "";
    const optionTitle = options?.turnTitle && !isGenericConversationTitle(options.turnTitle)
      ? options.turnTitle
      : "";
    const localTurnTitle = buildLocalTurnTitle(text, effectiveRunIntent, preferredLanguage);
    const turnTitle = normalizeConversationDisplayTitle(
      existingTitle || optionTitle || localTurnTitle,
      preferredLanguage === "en" ? 48 : 40,
      localTurnTitle,
    );
    const refreshedState = sessionGet();
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

      sessionSet((s) => ({
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
        lockedComposerIntent: null,
        pendingRunDecision: null,
        preferredResponseLanguage: preferredLanguage,
        isGenerating: false,
        agentStatus: "idle",
        elapsedTime: 0,
      }));

      if (!isHidden && shouldSeedSessionTitle && ensuredSessionId) {
        sessionGet().updateSession(sessionScopeKey, ensuredSessionId, {
          title: turnTitle,
          active: true,
          runtimeSnapshot: normalizeSessionRuntimeSnapshot({
            taskFlow: sessionGet().taskFlow,
            agentMessages: sessionGet().agentMessages,
            conversationTurns: sessionGet().conversationTurns,
            currentTurnId: sessionGet().currentTurnId,
            selectedMainModeKey: sessionGet().selectedMainModeKey,
            selectedNexusModeKey: sessionGet().selectedNexusModeKey,
            activeStudioAgentKey: sessionGet().activeStudioAgentKey,
            gameStudioInitialized: sessionGet().gameStudioInitialized,
            pendingSlashCommand: sessionGet().pendingSlashCommand,
            planArtifacts: sessionGet().planArtifacts,
            planTasks: sessionGet().planTasks,
            planExecutionEvidenceCount: sessionGet().planExecutionEvidenceCount,
            planStage: sessionGet().planStage,
            isPlanApproved: sessionGet().isPlanApproved,
            showPlanPanel: sessionGet().showPlanPanel,
            showDiff: sessionGet().showDiff,
            showTerminal: sessionGet().showTerminal,
            showFilePanel: sessionGet().showFilePanel,
            rightPanelTab: sessionGet().rightPanelTab,
            selectedDiffTaskId: sessionGet().selectedDiffTaskId,
          }),
        });
      }
    };

    if (parsedStudioCommand?.type === "agent") {
      void sessionGet().setActiveStudioAgentKey(parsedStudioCommand.slug, {
        persistToWorkspace: sessionGet().gameStudioInitialized,
      });
      void appendLocalStudioTurn(
        `Game Studio 当前专家已切换为 \`${parsedStudioCommand.slug}\`。后续普通消息会默认按该专家视角继续；发送 \`/auto\` 可恢复自动编排。`,
      );
      return true;
    }

    if (parsedStudioCommand?.type === "auto") {
      void sessionGet().setActiveStudioAgentKey("studio_auto", {
        persistToWorkspace: sessionGet().gameStudioInitialized,
      });
      void appendLocalStudioTurn("Game Studio 已恢复自动编排。后续消息将不再固定绑定某个专家。");
      return true;
    }

    // 1. Push user message to visible taskFlow
    const currentImages = images || [];
    const shouldArchiveChoiceFeedback =
      reuseCurrentTurn &&
      !isHidden &&
      currentTurn?.status === "awaiting_input";
    const selectedChoiceText = shouldArchiveChoiceFeedback ? text.trim() : "";
    const userBlock: TaskBlock | null = isHidden
      ? null
      : {
          id: nextId(),
          turnId,
          type: "user",
          content: text,
          ...(currentImages.length > 0 ? { images: currentImages } : {}),
        };
    sessionSet((s) => ({
      ...(userBlock
        ? (() => {
            const archivedTaskFlow = shouldArchiveChoiceFeedback
              ? s.taskFlow.map((block) =>
                  block.turnId === turnId &&
                  block.type === "agent" &&
                  Array.isArray(block.options) &&
                  block.options.length > 0
                    ? {
                        ...block,
                        options: undefined,
                        archivedAfterChoice: true,
                        ...(selectedChoiceText ? { selectedOption: selectedChoiceText } : {}),
                      }
                    : block,
                )
              : s.taskFlow;

            return {
              taskFlow: [...archivedTaskFlow, userBlock],
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
            };
        })()
        : reuseCurrentTurn
        ? {
            taskFlow: shouldArchiveChoiceFeedback
              ? s.taskFlow.map((block) =>
                  block.turnId === turnId &&
                  block.type === "agent" &&
                  Array.isArray(block.options) &&
                  block.options.length > 0
                    ? {
                        ...block,
                        options: undefined,
                        archivedAfterChoice: true,
                        ...(selectedChoiceText ? { selectedOption: selectedChoiceText } : {}),
                      }
                    : block,
                )
              : s.taskFlow,
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
      ...(shouldArchiveChoiceFeedback
        ? {
            normalizedStreamState: {
              ...s.normalizedStreamState,
              replyOptions: [],
              finishReason: null,
            },
          }
        : {}),
      pendingSlashCommand: parsedStudioCommand?.type === "workflow" ? parsedStudioCommand : null,
      lockedComposerIntent: null,
      pendingRunDecision: null,
      isGenerating: true,
      config: { ...s.config, workflowMode: effectiveWorkflowMode },
      ...(preservePlanState ? {} : { isPlanApproved: false }),
      elapsedTime: 0,
    }));

    logStoreEvent("visible_turn_appended", {
      turnId,
      sessionKey: runSessionKey,
      workspace: runWorkspace || null,
      reuseCurrentTurn,
      shouldArchiveChoiceFeedback,
      selectedChoiceChars: selectedChoiceText.length,
      userBlockId: userBlock?.id ?? null,
      effectiveRunIntent,
      effectiveWorkflowMode,
      initialTurnStatus,
      elapsedMs: Math.round(nowMs() - sendStartedAt),
      taskFlowBlocks: sessionGet().taskFlow.length,
      conversationTurns: sessionGet().conversationTurns.length,
    });

    if (!isHidden && shouldSeedSessionTitle && ensuredSessionId) {
      sessionGet().updateSession(sessionScopeKey, ensuredSessionId, { title: turnTitle, active: true });
    }

    // 对首轮会话或噪音较重的输入，额外让模型生成一份稳定的人话标题，
    // 再同步回当前 turn 与 sidebar，避免用户名/时间戳/推理文本直接泄漏到 UI。
    const shouldRequestSmartLocalTitle = sessionGet().config.activeProfile === "local";
    if (
      !isHidden &&
      !reuseCurrentTurn &&
      !options?.turnTitle &&
      (shouldRequestSmartLocalTitle || shouldRequestSemanticTurnMetadata(text, shouldSeedSessionTitle))
    ) {
      void requestSemanticTurnMetadata({
        input: text,
        intent: effectiveRunIntent,
        language: preferredLanguage,
        config: sessionGet().config,
      }).then((metadata) => {
        if (!metadata) return;

        const latestState = sessionGet();
        const targetTurn = latestState.conversationTurns.find((turn) => turn.id === turnId);
        if (!targetTurn) return;
        if (
          looksLikeReasoningLeakTitle(metadata.title) ||
          looksLikeReasoningLeakTitle(metadata.summary) ||
          isGenericConversationTitle(metadata.title)
        ) return;

        latestState.updateConversationTurn(turnId, {
          title: metadata.title,
          intentSummary: metadata.summary,
        });

        if (shouldSeedSessionTitle && ensuredSessionId) {
          latestState.updateSession(sessionScopeKey, ensuredSessionId, {
            title: metadata.title,
            active: true,
          });
        }
      }).catch(() => {
        // 标题同步失败时保持当前回退标题即可，不影响主流程继续执行。
      });
    }

    // 2. Start elapsed timer
    const startTime = Date.now();
    const timerInterval = setInterval(() => {
      const state = sessionGet();
      if (state.agentStatus === "idle" || state.agentStatus === "error") {
        clearInterval(timerInterval);
        return;
      }
      sessionSet({ elapsedTime: Math.round((Date.now() - startTime) / 1000) });
    }, 200);

    // 3. Build context from @-mentions and attached files
    // Read actual file contents for attached files (from old App.tsx)
    (async () => {
      let userContent = text;
      let activeStudioAgentKey = sessionGet().activeStudioAgentKey;
      let gameStudioInitialized = sessionGet().gameStudioInitialized;
      const mentions = mentionSnapshot;
      const files = attachedFilesSnapshot;
      const allFilePaths = [...new Set([...files, ...mentions])];

      if (allFilePaths.length > 0) {
        const parts: string[] = [];
        for (const fp of allFilePaths) {
          try {
            let c: string;
            if (shouldUseTabularAnalyzer(fp)) {
              const summary = await analyzeTabularDocument(fp, undefined, undefined, undefined, undefined, runWorkspace);
              const preview = await readDocument(fp, 3000, 12, 0, 40, undefined, runWorkspace);
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
              const doc = await readDocument(fp, undefined, undefined, undefined, undefined, undefined, runWorkspace);
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
              const raw = await readFile(fp, runWorkspace);
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

      if (effectiveRunIntent === "plan" && !preservePlanState) {
        userContent = preferredLanguage === "en"
          ? [
              "This turn is in PLAN mode. If the request is a complex implementation, create concise reviewable plan drafts in `.MAIN/plans/requirements.md` and `.MAIN/plans/design.md` before asking for approval; do not write project source files or tasks.md before approval.",
              "If it is only a discussion-style plan, keep the answer concise and use user options for real decisions.",
              "",
              userContent,
            ].join("\n")
          : [
              "本轮处于 PLAN 模式。如果这是复杂实现请求，请先把可审批的精简计划草稿写入 `.MAIN/plans/requirements.md` 和 `.MAIN/plans/design.md`，等待用户批准后再改源码；批准前不要生成 tasks.md。",
              "如果只是讨论式方案，请保持简洁，并在真实分叉点用可点击选项让用户选择。",
              "",
              userContent,
            ].join("\n");
      }

      if (shouldContinuePlanIntent) {
        const originalPlanPrompt = currentTurn?.userPrompt?.trim();
        userContent = preferredLanguage === "en"
          ? [
              "Continue the previous PLAN turn. The user is asking to keep going, not to start a new discussion.",
              originalPlanPrompt ? `Original plan request: ${originalPlanPrompt}` : "Original plan request: use the current conversation context.",
              "Produce real planning progress now. If key choices remain, summarize them briefly and use <user_options>; otherwise provide the concise plan/proposal.",
              "Keep any plan Markdown concise: review-summary style, no tutorial prose, no full code listings, no repeated background.",
              text.trim() ? `Latest user message: ${text.trim()}` : "Latest user message: continue",
            ].join("\n")
          : [
              "请继续上一轮 PLAN 回合。用户是在要求继续推进，不是开启新的普通讨论。",
              originalPlanPrompt ? `上一轮计划请求：${originalPlanPrompt}` : "上一轮计划请求：请依据当前对话上下文继续。",
              "现在必须产生实际规划进展。如果仍有关键选择需要用户确认，就先简短归纳并用面向用户的口吻给出 <user_options>；否则给出精简方案/Proposal。",
              "每个 <option> 必须是用户点击后会发送的完整选择，不要写成“是否……”问题句。",
              "所有计划 Markdown 都要精简成审阅摘要风格，不要写教程式长文、完整代码清单或重复背景。",
              text.trim() ? `用户最新消息：${text.trim()}` : "用户最新消息：继续",
            ].join("\n");
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
          sessionSet({
            gameStudioInitialized: true,
            activeStudioAgentKey,
          });
          sessionGet().bumpWorkspaceContentVersion();
        } catch (error) {
          clearInterval(timerInterval);
          const failureId = nextId();
          sessionSet((s) => ({
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
          responseLanguage: preferredLanguage,
        });
      }

      // Clear mentions and attached files after reading
      sessionSet({ contextMentions: [], attachedFiles: [] });

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
      sessionSet((s) => ({ agentMessages: [...s.agentMessages, agentUserMsg] }));

      // 5. Create AbortController and launch the loop
      const abortCtrl = new AbortController();
      sessionSet({ abortController: abortCtrl });

      // Track the current streaming assistant block
      let currentStreamingBlockId: number | null = null;
      const agentBlockIdsCreatedThisRun = new Set<number>();
      // Track thought timing for duration display
      let thoughtStartTime: number | null = null;
      // Current streaming thought block id (for live updates)
      let currentThoughtBlockId: number | null = null;
      let terminalTurnStatusOverride: ConversationTurnStatus | null = null;

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
        if (blockWithTurn.type === "agent") {
          agentBlockIdsCreatedThisRun.add(blockWithTurn.id);
        }
        sessionSet((s) => ({
          taskFlow: [...s.taskFlow, blockWithTurn],
          conversationTurns: s.conversationTurns.map((turn) =>
            turn.id === turnId && !turn.blockIds.includes(blockWithTurn.id)
              ? { ...turn, blockIds: [...turn.blockIds, blockWithTurn.id] }
              : turn
          ),
        }));
      };

      // ── RAF-batched streaming update ──────────────────────────────────
      // Instead of calling sessionSet() for every character (which causes
      // thousands of React re-renders), we buffer incoming tokens and
      // flush them once per animation frame (~60 fps).
      let tokenBuffer = "";
      let rafHandle: number | null = null;
      let firstStreamTokenAt: number | null = null;
      let streamTokenCount = 0;
      let streamTextChars = 0;
      let noFirstTokenNoticeTimer: ReturnType<typeof setTimeout> | null = null;

      const clearNoFirstTokenNoticeTimer = () => {
        if (noFirstTokenNoticeTimer !== null) {
          clearTimeout(noFirstTokenNoticeTimer);
          noFirstTokenNoticeTimer = null;
        }
      };

      noFirstTokenNoticeTimer = setTimeout(() => {
        noFirstTokenNoticeTimer = null;
        if (firstStreamTokenAt !== null) return;
        const latest = sessionGet();
        if (latest.agentStatus !== "running" || latest.currentTurnId !== turnId) return;
        appendTurnBlock({
          id: nextId(),
          turnId,
          type: "system",
          content: latest.config.language === "en"
            ? "The model has not returned visible streaming content for a while. You can stop this run and continue the current plan stage."
            : "模型已经较长时间没有返回可见流式内容。你可以停止本轮，然后继续当前计划阶段。",
        });
        logStoreEvent("stream_no_visible_token_notice", {
          turnId,
          elapsedMs: Math.round(nowMs() - sendStartedAt),
          agentMessages: latest.agentMessages.length,
          planStage: latest.planStage,
        });
      }, 120_000);

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
            content: compactThoughtContent(thinking),
            isStreaming: true,
          };
          appendTurnBlock(thoughtBlock);
          sessionSet((s) => ({
            currentTurnState: {
              ...s.currentTurnState,
              interceptorHandled: true,
              interceptorThought: appendThoughtDelta(s.currentTurnState.interceptorThought, thinking),
            }
          }));
        } else if (currentThoughtBlockId !== null && thinking) {
          // Append to existing thought block
          const tid = currentThoughtBlockId;
          sessionSet((s) => ({
            taskFlow: s.taskFlow.map((t) =>
              t.id === tid && t.type === "thought"
                ? { ...t, content: appendThoughtDelta((t as Extract<TaskBlock, { type: "thought" }>).content, thinking) }
                : t
            ),
            currentTurnState: {
              ...s.currentTurnState,
              interceptorThought: appendThoughtDelta(s.currentTurnState.interceptorThought, thinking),
            }
          }));
        }

        if (thoughtEnded && currentThoughtBlockId !== null) {
          // Finalize the thought block
          const tid = currentThoughtBlockId;
          const duration = thoughtStartTime ? Math.round((Date.now() - thoughtStartTime) / 1000) : undefined;
          sessionSet((s) => ({
            taskFlow: s.taskFlow.map((t) =>
              t.id === tid && t.type === "thought"
                ? { ...t, isStreaming: false, duration }
                : t
            ),
          }));
          // Auto-collapse after a brief display
          setTimeout(() => {
            sessionSet((s) => ({
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
        const currentTurn = sessionGet().currentTurnState;
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
          sessionSet((s) => ({
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

      // region: 流式块收尾
      const finalizeStreamingUi = () => {
        if (rafHandle !== null) {
          cancelAnimationFrame(rafHandle);
          rafHandle = null;
        }
        clearNoFirstTokenNoticeTimer();
        if (tokenBuffer) {
          flushBuffer();
        }

        const { agent: remainingAgent } = thinkingInterceptor.flush();
        if (remainingAgent) {
          if (currentStreamingBlockId === null) {
            const blockId = nextId();
            currentStreamingBlockId = blockId;
            appendTurnBlock({ id: blockId, turnId, type: "agent", content: remainingAgent, streaming: true });
          } else {
            const blockId = currentStreamingBlockId;
            sessionSet((s) => ({
              taskFlow: s.taskFlow.map((t) =>
                t.id === blockId && t.type === "agent"
                  ? { ...t, content: (t as Extract<TaskBlock, { type: "agent" }>).content + remainingAgent }
                  : t
              ),
            }));
          }
        }

        const duration = thoughtStartTime ? Math.round((Date.now() - thoughtStartTime) / 1000) : undefined;
        sessionSet((s) => ({
          taskFlow: finalizeStreamingTaskBlocks(s.taskFlow, turnId, duration),
        }));

        currentStreamingBlockId = null;
        currentThoughtBlockId = null;
        thoughtStartTime = null;
      };
      // endregion

      const removeLatestAgentBlockForTurn = () => {
        sessionSet((s) => {
          const latestAgent = [...s.taskFlow]
            .reverse()
            .find((block): block is Extract<TaskBlock, { type: "agent" }> =>
              block.turnId === turnId &&
              block.type === "agent" &&
              agentBlockIdsCreatedThisRun.has(block.id)
            );
          if (!latestAgent) {
            return {
              normalizedStreamState: {
                ...s.normalizedStreamState,
                visibleText: "",
                replyOptions: [],
              },
            };
          }

          agentBlockIdsCreatedThisRun.delete(latestAgent.id);

          return {
            normalizedStreamState: {
              ...s.normalizedStreamState,
              visibleText: "",
              replyOptions: [],
            },
            taskFlow: s.taskFlow.filter((block) => block.id !== latestAgent.id),
            conversationTurns: s.conversationTurns.map((turn) =>
              turn.id === turnId
                ? { ...turn, blockIds: turn.blockIds.filter((blockId) => blockId !== latestAgent.id) }
                : turn
            ),
          };
        });
      };

      // Get workspace tree for system prompt
      const workspaceTreeStartedAt = nowMs();
      const workspaceTree = await getWorkspaceTree(runWorkspace);
      logStoreEvent("workspace_tree_ready", {
        turnId,
        workspace: runWorkspace || "global",
        chars: workspaceTree.length,
        elapsedMs: Math.round(nowMs() - workspaceTreeStartedAt),
      });

      const callbacks: OrchestratorCallbacks = {
        getMessages: () => sessionGet().agentMessages,
        getConfig: () => ({ ...sessionGet().config, workspace: runWorkspace }),
        getPreferredLanguage: () => sessionGet().preferredResponseLanguage || sessionGet().config.language,
        getSkills: () => sessionGet().skills,
        getMainModeKey: () => sessionGet().selectedMainModeKey,
        getActiveStudioAgentKey: () => sessionGet().activeStudioAgentKey,
        getGameStudioInitialized: () => sessionGet().gameStudioInitialized,
        getPendingSlashCommand: () => sessionGet().pendingSlashCommand,
        getWorkspaceTree: () => workspaceTree,
        getMcpServers: () => sessionGet().mcpServers,
        getMcpDiscoveredTools: () => sessionGet().mcpDiscoveredTools,
        getAssociatedPaths: () => sessionGet().resolvedInstructionSet?.associatedPaths ?? [],
        getSessionKey: () => runSessionKey,
        hasSessionHookInitialized: (key) => sessionGet().hasSessionHookInitialized(key),
        markSessionHookInitialized: (key) => sessionGet().markSessionHookInitialized(key),
        onInstructionsResolved: (resolved) => sessionGet().setResolvedInstructionSet(resolved),
        onHooksLoaded: (hooks, loadedAt) => sessionGet().setLoadedHookDefinitions(hooks, loadedAt),
        onHookStart: (_event, _hook) => { /* UI feedback placeholder */ },
        onHookResult: (record) => sessionGet().appendHookExecutionRecords([record]),
        onHookBlocked: (_event, _reason, _record) => { /* UI feedback placeholder */ },
        getCurrentRunIntent: () => sessionGet().getCurrentRunIntent(),
        getWorkflowMode: () => getIntentPolicy(sessionGet().getCurrentRunIntent()).workflowMode,
        getIsPlanApproved: () => sessionGet().isPlanApproved,
        getReadOnlyAutoApproveForSession: () => sessionGet().readOnlyAutoApproveForSession,
        getPlanStage: () => sessionGet().planStage,
        getPlanTasks: () => sessionGet().planTasks,
        getStatus: () => sessionGet().agentStatus,
        startNewTurn: () => sessionGet().startNewTurn(),

        onStreamToken: (token, _msgId) => {
          // Handle escalation reset signal
          if (token.startsWith("__ESCALATION_RESET__:")) {
            logStoreEvent("stream_reset", {
              turnId,
              currentStreamingBlockId,
              tokenBufferChars: tokenBuffer.length,
              agentBlocksCreatedThisRun: agentBlockIdsCreatedThisRun.size,
              taskFlowBlocks: sessionGet().taskFlow.length,
            });
            tokenBuffer = "";
            firstStreamTokenAt = null;
            streamTokenCount = 0;
            streamTextChars = 0;
            // Reset the streaming block content for retry
            if (currentStreamingBlockId !== null) {
              const blockId = currentStreamingBlockId;
              sessionSet((s) => ({
                taskFlow: s.taskFlow.map((t) =>
                  t.id === blockId && t.type === "agent"
                    ? { ...t, content: "" }
                    : t
                  ),
              }));
            } else {
              removeLatestAgentBlockForTurn();
            }
            return;
          }

          if (thoughtStartTime === null) thoughtStartTime = Date.now();
          if (firstStreamTokenAt === null) {
            firstStreamTokenAt = nowMs();
            clearNoFirstTokenNoticeTimer();
            logStoreEvent("stream_first_token", {
              turnId,
              sessionKey: runSessionKey,
              workspace: runWorkspace || null,
              elapsedMs: Math.round(firstStreamTokenAt - sendStartedAt),
              tokenChars: token.length,
            });
          }
          streamTokenCount++;
          streamTextChars += token.length;
          tokenBuffer += token;
          scheduleFlush();
        },

        onStreamDone: (_fullText, _msgId, truncated) => {
          finalizeStreamingUi();
          logStoreEvent("stream_done", {
            turnId,
            sessionKey: runSessionKey,
            workspace: runWorkspace || null,
            fullTextChars: _fullText.length,
            truncated,
            firstTokenElapsedMs: firstStreamTokenAt == null ? null : Math.round(firstStreamTokenAt - sendStartedAt),
            streamTokenCount,
            streamTextChars,
            taskFlowBlocks: sessionGet().taskFlow.length,
            agentBlocksCreatedThisRun: agentBlockIdsCreatedThisRun.size,
          });

          // Show truncation warning if the model hit max_tokens
          if (truncated) {
            const warnId = nextId();
            const warnBlock: TaskBlock = {
              id: warnId,
              turnId,
              type: "system",
              content: "⚠️ 回复被截断 — 模型达到了最大 token 限制。回复可能不完整。",
            };
            appendTurnBlock(warnBlock);
          }

          sessionSet((s) => ({
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
          
          const currentTurn = sessionGet().currentTurnState;

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
          sessionSet((s) => ({
            normalizedStreamState: {
              ...s.normalizedStreamState,
              hiddenThought: appendThoughtDelta(
                s.normalizedStreamState.hiddenThought,
                s.normalizedStreamState.hiddenThought ? `\n\n${thought}` : thought,
              ),
            },
            currentTurnState: {
              ...s.currentTurnState,
              lastReportedThought: appendThoughtDelta(s.currentTurnState.lastReportedThought, thought),
            }
          }));

          const currentFlow = sessionGet().taskFlow;
          const lastBlock = currentFlow[currentFlow.length - 1];

          if (lastBlock && lastBlock.type === "thought") {
            const existing = normalizeForComp((lastBlock as Extract<TaskBlock, { type: "thought" }>).content);
            
            // If the incoming thought is already present, update metadata and avoid duplication.
            if (existing.includes(incoming)) {
              if (duration !== undefined) {
                const tid = lastBlock.id;
                sessionSet((s) => ({
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
            sessionSet((s) => ({
              taskFlow: s.taskFlow.map((t) =>
                t.id === tid && t.type === "thought"
                  ? { ...t, content: appendThoughtDelta((t as Extract<TaskBlock, { type: "thought" }>).content, `\n\n${thought}`), isStreaming: true, duration }
                  : t
              ),
            }));
            // Auto-collapse after a brief display period
            setTimeout(() => {
              sessionSet((s) => ({
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
              content: compactThoughtContent(thought),
              isStreaming: true,
              duration,
            };
            appendTurnBlock(block);

            // Auto-collapse after a brief display period
            setTimeout(() => {
              sessionSet((s) => ({
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

        onAssistantFinalText: (text, replyOptions = []) => {
          const fallbackText = replyOptions.length > 0
            ? sessionGet().config.language === "en"
              ? "Choose how you'd like to continue."
              : "请选择你希望我如何继续。"
            : "";
          const cleanText = text.trim() || fallbackText;
          const currentFlow = sessionGet().taskFlow;
          const latestBlock = [...currentFlow].reverse().find((block) =>
            block.turnId === turnId &&
            block.type === "agent" &&
            agentBlockIdsCreatedThisRun.has(block.id)
          );
          const cleanTextKey = normalizeAgentContentForDedupe(cleanText);
          logStoreEvent("assistant_final_text", {
            turnId,
            sessionKey: runSessionKey,
            workspace: runWorkspace || null,
            textChars: text.length,
            cleanTextChars: cleanText.length,
            replyOptions: replyOptions.length,
            latestBlockId: latestBlock?.id ?? null,
            agentBlocksCreatedThisRun: agentBlockIdsCreatedThisRun.size,
            taskFlowBlocks: currentFlow.length,
          });

          if (!cleanText) {
            if (latestBlock && latestBlock.type === "agent" && latestBlock.turnId === turnId) {
              sessionSet((s) => ({
                taskFlow: s.taskFlow.map((t) =>
                  t.id === latestBlock.id && t.type === "agent"
                    ? { ...t, content: "", streaming: false }
                    : t
                ),
              }));
            }
            return;
          }

          if (latestBlock && replyOptions.length === 0 && cleanTextKey) {
            const duplicatedEarlierBlock = [...currentFlow]
              .reverse()
              .find((block): block is Extract<TaskBlock, { type: "agent" }> =>
                block.turnId === turnId &&
                block.type === "agent" &&
                block.id !== latestBlock.id &&
                normalizeAgentContentForDedupe(block.content) === cleanTextKey
              );

            if (duplicatedEarlierBlock) {
              sessionSet((s) => ({
                normalizedStreamState: {
                  ...s.normalizedStreamState,
                  visibleText: String(duplicatedEarlierBlock.content || ""),
                  replyOptions,
                },
                taskFlow: s.taskFlow.filter((block) => block.id !== latestBlock.id),
                conversationTurns: s.conversationTurns.map((turn) =>
                  turn.id === turnId
                    ? { ...turn, blockIds: turn.blockIds.filter((blockId) => blockId !== latestBlock.id) }
                    : turn
                ),
              }));
              agentBlockIdsCreatedThisRun.delete(latestBlock.id);
              return;
            }
          }

          if (!latestBlock || latestBlock.type !== "agent" || latestBlock.turnId !== turnId) {
            sessionSet((s) => ({
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

          sessionSet((s) => ({
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

          sessionSet((s) => {
            const pendingIdx = [...s.taskFlow]
              .map((task, index) => ({ task, index }))
              .reverse()
              .find(({ task }) =>
                task.turnId === turnId &&
                task.type === "tool" &&
                task.toolName === toolName &&
                task.target === target &&
                (task.toolStatus === "pending" || task.toolStatus === "running")
              )?.index;
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
              taskFlow: nextFlow,
              conversationTurns: appendedBlockId == null
                ? s.conversationTurns
                : s.conversationTurns.map((turn) =>
                    turn.id === turnId && !turn.blockIds.includes(appendedBlockId!)
                      ? { ...turn, blockIds: [...turn.blockIds, appendedBlockId!] }
                      : turn
                  ),
              showDiff: s.showDiff && s.rightPanelTab === "diff",
            };
          });

          if (runningTaskId != null && shouldAttachDiff && diffPreview) {
            sessionSet((s) => ({
              taskFlow: s.taskFlow.map((task) =>
                task.id === runningTaskId && task.type === "tool"
                  ? { ...task, diff: diffPreview }
                  : task
              ),
            }));
          }
        },

        onToolDone: (toolName, target, result) => {
          sessionSet((s) => {
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
            sessionGet().bumpWorkspaceContentVersion();
          }
        },

        onToolError: (toolName, target, error) => {
          sessionSet((s) => {
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
            sessionGet().bumpWorkspaceContentVersion();
          }
        },

        onStatusChange: (status) => {
          logStoreEvent("status_change", {
            turnId,
            sessionKey: runSessionKey,
            workspace: runWorkspace || null,
            status,
            replyOptions: sessionGet().normalizedStreamState.replyOptions.length,
            taskFlowBlocks: sessionGet().taskFlow.length,
            agentMessages: sessionGet().agentMessages.length,
            elapsedMs: Math.round(nowMs() - sendStartedAt),
          });
          const finalizeStaleRunningTools = (finalStatus: "executed" | "failed", message: string) => {
            sessionSet((s) => ({
              taskFlow: s.taskFlow.map((task) =>
                task.turnId === turnId && task.type === "tool" && task.toolStatus === "running"
                  ? {
                      ...task,
                      toolStatus: finalStatus,
                      status: finalStatus === "executed" ? "done" : "error",
                      message: task.message && task.message !== "Executing..." ? task.message : message,
                    }
                  : task
              ),
            }));
          };

          sessionSet({
            agentStatus: status,
            // Timer only runs during active generation, NOT during plan review
            isGenerating: status === "running",
          });
          if (status === "pending_review") {
            const state = sessionGet();
            const hasPlanContext =
              effectiveRunIntent === "plan" ||
              state.planArtifacts.length > 0 ||
              state.planStage !== "idle";
            if (hasPlanContext) {
              logStoreEvent("plan_panel_open_for_review", {
                turnId,
                effectiveRunIntent,
                planArtifacts: state.planArtifacts.length,
                planStage: state.planStage,
              });
              state.openRightPanelTab("plan");
            }
          }
          if (turnId) {
            const nextTurnStatus: ConversationTurnStatus =
              status === "error"
                ? "error"
                : status === "idle"
                ? deriveIdleConversationTurnStatus({
                    turnId,
                    effectiveRunIntent,
                    isPlanApproved: sessionGet().isPlanApproved,
                    planArtifacts: sessionGet().planArtifacts,
                    planStage: sessionGet().planStage,
                    planTasks: sessionGet().planTasks,
                    planExecutionEvidenceCount: sessionGet().planExecutionEvidenceCount,
                    replyOptionCount: sessionGet().normalizedStreamState.replyOptions.length,
                    taskFlow: sessionGet().taskFlow,
                    override: terminalTurnStatusOverride,
                  })
                : status === "pending_review"
                ? "awaiting_approval"
                : effectiveRunIntent === "plan" &&
                  !sessionGet().isPlanApproved &&
                  (sessionGet().planArtifacts.length > 0 || sessionGet().planStage !== "idle")
                ? "planning"
                : "executing";
            sessionGet().setConversationTurnStatus(turnId, nextTurnStatus);
          }
          if (status === "idle" || status === "error") {
            clearNoFirstTokenNoticeTimer();
            finalizeStreamingUi();
            finalizeStaleRunningTools(
              "failed",
              status === "idle" ? "请求已停止或未返回工具结果" : "请求已停止",
            );
            if (remoteFeishu) {
              const language = sessionGet().config.language === "en" ? "en" : "zh";
              const fallback = status === "error"
                ? (language === "en" ? "MAIN stopped with an error." : "MAIN 执行时遇到错误。")
                : (language === "en" ? "MAIN finished this remote task." : "MAIN 已完成这次远程任务。");
              const reply = extractFeishuTurnReply(sessionGet().taskFlow, turnId, fallback);
              void invoke("send_feishu_message", {
                chatId: remoteFeishu.chatId,
                userId: remoteFeishu.userId,
                openId: remoteFeishu.userId,
                messageId: remoteFeishu.messageId,
                text: reply,
              }).catch((error) => {
                logStoreEvent("feishu_final_reply_failed", {
                  error: error instanceof Error ? error.message : String(error),
                  turnId,
                });
              });
            }
            sessionSet({ abortController: null });
            clearInterval(timerInterval);
          }
        },

        onError: (error) => {
          console.error('[sendMessage] onError callback:', error);
          logStoreEvent("agent_error", {
            turnId,
            error: typeof error === "string" ? error : String(error),
            taskFlowBlocks: sessionGet().taskFlow.length,
            agentMessages: sessionGet().agentMessages.length,
          });
          finalizeStreamingUi();
          const errorMessage = typeof error === "string" ? error : String(error);
          const isResponseBodyDecodeError = /error decoding response body/i.test(errorMessage);
          const friendlyError = isResponseBodyDecodeError
            ? "模型服务在传输回复时中断或返回了无法解析的数据。原始错误：" + errorMessage
            : errorMessage;
          const currentTurn = sessionGet().conversationTurns.find((turn) => turn.id === turnId);
          if (!currentTurn?.summary?.trim()) {
            sessionGet().setConversationTurnSummary(
              turnId,
              isResponseBodyDecodeError
                ? "模型服务传输中断，已保留本轮已完成的操作记录。"
                : summarizeAssistantText(errorMessage),
            );
          }
          const block: TaskBlock = {
            id: nextId(),
            turnId,
            type: "tool",
            toolName: "Error",
            target: "",
            status: "error",
            toolStatus: "failed",
            message: friendlyError,
          };
          appendTurnBlock(block);
        },

        onNonActionableStop: (message, reason) => {
          terminalTurnStatusOverride = reason === "no_output"
            ? "stopped_no_output"
            : "stopped_no_action";
          logStoreEvent("non_actionable_stop", {
            turnId,
            reason,
            message,
            taskFlowBlocks: sessionGet().taskFlow.length,
            agentMessages: sessionGet().agentMessages.length,
          });
          const block: TaskBlock = {
            id: nextId(),
            turnId,
            type: "system",
            content: message,
          };
          appendTurnBlock(block);
          sessionGet().setConversationTurnSummary(turnId, summarizeAssistantText(message));
        },

        onPlanArtifactUpdated: (path, content, kind) => {
          logStoreEvent("plan_artifact_updated", {
            turnId,
            path,
            kind,
            contentChars: content.length,
          });
          const sanitized = sanitizePlanArtifactContent(content);
          const validation = validatePlanArtifactContent(sanitized, kind);
          if (!validation.ok) {
            logStoreEvent("plan_artifact_quality_blocked", {
              turnId,
              path,
              kind,
              reason: validation.reason,
            });
            appendTurnBlock({
              id: nextId(),
              turnId,
              type: "system",
              content: sessionGet().config.language === "en"
                ? `Plan artifact rejected: ${path} does not look like a reviewable ${kind} document (${validation.reason || "quality gate"}). MAIN will ask the model to regenerate a real plan or request your decision.`
                : `计划文件已被拦截：${path} 不像可审批的${getPlanArtifactTitle(kind, "zh")}（${validation.reason || "质量门禁"}）。MAIN 会要求模型重新生成真实方案，或先向你确认关键分叉。`,
              variant: "plan_quality_gate",
            });
            return;
          }
          sessionGet().upsertPlanArtifact({
            kind,
            path,
            title: getPlanArtifactTitle(kind, sessionGet().config.language === "en" ? "en" : "zh"),
            content: sanitized,
            updatedAt: Date.now(),
          });
          const latest = sessionGet();
          if (!(latest.showDiff && latest.rightPanelTab === "diff")) {
            latest.openRightPanelTab("plan");
          }
        },

        onPlanStageChanged: (stage) => {
          const current = sessionGet();
          const turnBlocks = current.taskFlow.filter((block) => block.turnId === turnId);
          const currentTurn = current.conversationTurns.find((turn) => turn.id === turnId);
          const requestedDocs = detectRequestedRootMarkdownDeliverables(currentTurn?.userPrompt || "");
          const canMarkPlanCompleted =
            stage === "completed" &&
            current.isPlanApproved &&
            current.planExecutionEvidenceCount > 0 &&
            current.planTasks.length > 0 &&
            current.planTasks.every((task) => task.status === "completed") &&
            hasRootMarkdownDeliverableEvidence(turnBlocks, requestedDocs);
          const nextStage =
            stage === "idle"
              ? stage
              : stage === "completed"
              ? canMarkPlanCompleted ? "completed" : "executing"
              : derivePlanStageFromArtifacts(
                  current.planArtifacts,
                  current.planTasks,
                  current.isPlanApproved,
                  stage === "executing" ? "executing" : current.planStage,
                );

          sessionGet().setPlanStage(nextStage);
          if (nextStage !== "idle") {
            const latest = sessionGet();
            if (!(latest.showDiff && latest.rightPanelTab === "diff")) {
              latest.openRightPanelTab("plan");
            }
          }
        },

        onPlanTasksUpdated: (content) => {
          const sanitized = sanitizePlanArtifactContent(content);
          if (sanitized.trim()) {
            sessionGet().setPlanTasks(extractPlanTasks(sanitized));
          }
        },

        onTurnSummaryReady: (summary) => {
          if (!summary.trim()) return;
          const summarized = summarizeAssistantText(summary);
          if (looksLikeReasoningLeakTitle(summarized)) return;
          sessionGet().setConversationTurnSummary(turnId, summarized);
        },

        appendMessage: (msg) => {
          logStoreEvent("append_agent_message", {
            turnId,
            sessionKey: runSessionKey,
            workspace: runWorkspace || null,
            role: msg.role,
            contentChars: typeof msg.content === "string" ? msg.content.length : JSON.stringify(msg.content).length,
            hasToolCalls: !!msg.tool_calls?.length,
            beforeMessages: sessionGet().agentMessages.length,
          });
          sessionSet((s) => ({ agentMessages: [...s.agentMessages, msg] }));
        },

        replaceMessages: (msgs) => {
          logStoreEvent("replace_agent_messages", {
            turnId,
            sessionKey: runSessionKey,
            workspace: runWorkspace || null,
            nextMessages: msgs.length,
          });
          sessionSet({ agentMessages: msgs });
        },

        onContextCompress: (stats, reason) => {
          const saved = Math.max(0, Math.round(stats.tokenReduction));
          const before = Math.max(0, Math.round(stats.tokenCountBefore));
          const after = Math.max(0, Math.round(stats.tokenCountAfter));
          const label = reason === "reactive"
            ? `上下文溢出，已压缩背景，约 ${before.toLocaleString()} → ${after.toLocaleString()} tokens（释放 ${saved.toLocaleString()}）`
            : `上下文已压缩背景，约 ${before.toLocaleString()} → ${after.toLocaleString()} tokens（释放 ${saved.toLocaleString()}，适配 KV Cache）`;
          const block: TaskBlock = {
            id: nextId(),
            turnId,
            type: "system",
            content: label,
            variant: "context_compression",
            contextCompression: {
              reason,
              droppedCount: Math.max(0, Math.round(stats.droppedCount)),
              tokenCountBefore: before,
              tokenCountAfter: after,
              tokenReduction: saved,
              compressedContext: trimPersistedContextCompression(stats.compressedContext),
            },
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
          if (sessionGet().autoApproveTools) {
            return Promise.resolve({ action: "accept" });
          }

          const latestState = sessionGet();
          const isRemoteFeishuTurn = !!remoteFeishu;
          const latestIntent = latestState.getCurrentRunIntent();
          const alreadyApprovedForTurn =
            latestState.currentTurnExecutionConsent.granted &&
            latestState.currentTurnExecutionConsent.turnId === turnId;
          const planExecutionAlreadyApproved =
            latestIntent === "plan" && latestState.isPlanApproved;

          if (
            !isRemoteFeishuTurn &&
            (latestIntent === "execute" || latestIntent === "studio_workflow") &&
            latestState.executionConsentPolicy === "ask_per_turn" &&
            !alreadyApprovedForTurn &&
            !planExecutionAlreadyApproved
          ) {
            return new Promise<ReviewDecision>((resolve) => {
              sessionSet({
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

              if (sessionGet().autoApproveTools) {
                return { action: "accept" } as ReviewDecision;
              }

              return new Promise<ReviewDecision>((resolve) => {
                const reviewTaskId = nextId();
                const toolName = toolCall.name;
                const toolArgs = toolCall.arguments;
                const target = getToolTarget(toolName, toolArgs);
                void (async () => {
                  const diff = await buildToolDiffPreview(toolName, toolArgs, {
                    workspace: runWorkspace,
                    sessionKey: runSessionKey,
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

                  sessionSet((s) => ({
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
              const diff = await buildToolDiffPreview(toolName, toolArgs, {
                workspace: runWorkspace,
                sessionKey: runSessionKey,
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

              sessionSet((s) => ({
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
              if (remoteFeishu) {
                const code = createFeishuApprovalCode();
                sessionGet().addPendingFeishuApproval({
                  code,
                  taskId: reviewTaskId,
                  chatId: remoteFeishu.chatId,
                  userId: remoteFeishu.userId,
                  messageId: remoteFeishu.messageId,
                  toolName,
                  target,
                  createdAt: Date.now(),
                });
                void invoke("send_feishu_message", {
                  chatId: remoteFeishu.chatId,
                  userId: remoteFeishu.userId,
                  openId: remoteFeishu.userId,
                  messageId: remoteFeishu.messageId,
                  text: buildFeishuApprovalMessage(
                    sessionGet().config.language === "en" ? "en" : "zh",
                    code,
                    toolName,
                    target,
                  ),
                }).catch((error) => {
                  logStoreEvent("feishu_approval_send_failed", {
                    error: error instanceof Error ? error.message : String(error),
                    toolName,
                    target,
                  });
                });
              }
            })();
          });
        },
      };

      // Fire and forget — the loop manages its own lifecycle
      executeAgentLoop(callbacks, abortCtrl).then(() => {
        clearInterval(timerInterval);
        sessionSet({ pendingSlashCommand: null });

        // Save session messages (sanitized for serialization safety)
        const s = sessionGet();
        if (runSessionId) {
          const messages = sanitizeTaskBlocksForPersist(s.taskFlow);
          s.updateSession(runScopeKey, runSessionId, {
            messages,
            runtimeSnapshot: normalizeSessionRuntimeSnapshot({
              taskFlow: messages,
              agentMessages: sanitizeAgentMessagesForPersist(s.agentMessages),
              conversationTurns: s.conversationTurns,
              currentTurnId: s.currentTurnId,
              selectedMainModeKey: s.selectedMainModeKey,
              selectedNexusModeKey: s.selectedNexusModeKey,
              activeStudioAgentKey: s.activeStudioAgentKey,
              gameStudioInitialized: s.gameStudioInitialized,
              pendingSlashCommand: s.pendingSlashCommand,
              planArtifacts: s.planArtifacts,
              planTasks: s.planTasks,
              planExecutionEvidenceCount: s.planExecutionEvidenceCount,
              planStage: s.planStage,
              isPlanApproved: s.isPlanApproved,
              showPlanPanel: s.showPlanPanel,
              showDiff: s.showDiff,
              showTerminal: s.showTerminal,
              showFilePanel: s.showFilePanel,
              rightPanelTab: s.rightPanelTab,
              selectedDiffTaskId: s.selectedDiffTaskId,
            }),
          });
        }
      }).catch((err) => {
        clearInterval(timerInterval);
        sessionSet({ pendingSlashCommand: null });
        console.error("Agent loop crashed:", err);
        if (remoteFeishu) {
          const language = sessionGet().config.language === "en" ? "en" : "zh";
          void invoke("send_feishu_message", {
            chatId: remoteFeishu.chatId,
            userId: remoteFeishu.userId,
            openId: remoteFeishu.userId,
            messageId: remoteFeishu.messageId,
            text: language === "en"
              ? `MAIN crashed while handling the remote task: ${err instanceof Error ? err.message : String(err)}`
              : `MAIN 处理远程任务时崩溃：${err instanceof Error ? err.message : String(err)}`,
          }).catch(() => {});
        }
        // Show crash as visible system block
        const crashId = nextId();
        sessionSet((s) => ({
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
        sessionsByWorkspace: stripSessionsByWorkspaceForLocalPersist(state.sessionsByWorkspace),
        workspaces: state.workspaces,
        activeSessionByWorkspace: state.activeSessionByWorkspace,
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
      onRehydrateStorage: () => {
        const startedAt = nowMs();
        logStoreEvent("rehydrate_start", {});
        return (state, error) => {
        if (error || !state) {
          logStoreEvent("rehydrate_done", {
            ok: false,
            elapsedMs: Math.round(nowMs() - startedAt),
            error: error instanceof Error ? error.message : error ? String(error) : "missing_state",
          });
          return;
        }

        const hydratedTaskFlow = sanitizeTaskBlocksForPersist(state.taskFlow || []);
        syncTaskIdCounterFromBlocks(hydratedTaskFlow);
        logStoreEvent("rehydrate_done", {
          ok: true,
          elapsedMs: Math.round(nowMs() - startedAt),
          taskFlowBlocks: hydratedTaskFlow.length,
          agentMessages: (state.agentMessages || []).length,
          conversationTurns: (state.conversationTurns || []).length,
          sessions: Object.values(state.sessionsByWorkspace || {}).reduce((count, sessions) => count + (Array.isArray(sessions) ? sessions.length : 0), 0),
          currentWorkspace: state.currentWorkspace || "global",
          currentSessionId: state.currentSessionId ?? null,
        });
        };
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
      const cloudState = normalizeCloudServerState({
        cloud: {
          ...current.config.cloud,
          ...(persistedState.config?.cloud ?? {}),
        },
        cloudServers: persistedState.config?.cloudServers,
        activeCloudServerId: persistedState.config?.activeCloudServerId,
      });
      const hydratedTaskFlow = sanitizeTaskBlocksForPersist(persistedState.taskFlow || []);
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
          cloud: cloudState.cloud,
          cloudServers: cloudState.cloudServers,
          activeCloudServerId: cloudState.activeCloudServerId,
          sessionRecordingEnabled: persistedState.config?.sessionRecordingEnabled ?? current.config.sessionRecordingEnabled,
          imAdapters: normalizeImAdaptersConfig(persistedState.config?.imAdapters),
        },
        sessionsByWorkspace: normalizeSessionsByWorkspace(persistedState.sessionsByWorkspace),
        runtimeBySessionKey: {},
        workspaces: normalizeWorkspaceEntries(
          (persistedState as Partial<AppState>).workspaces,
          normalizeSessionsByWorkspace(persistedState.sessionsByWorkspace),
          persistedState.currentWorkspace || current.currentWorkspace,
        ),
        activeSessionByWorkspace: persistedState.activeSessionByWorkspace || {},
        taskFlow: hydratedTaskFlow,
        agentMessages: sanitizeAgentMessagesForPersist(persistedState.agentMessages || []),
        conversationTurns: normalizeInterruptedConversationTurnsForRestore(
          persistedState.conversationTurns,
          hydratedTaskFlow,
        ),
        selectedWorkspace: persistedState.selectedWorkspace || persistedState.currentWorkspace || current.selectedWorkspace,
        selectedMainModeKey,
        selectedNexusModeKey: mapMainModeToLegacyNexusMode(selectedMainModeKey),
        activeStudioAgentKey: normalizeStudioAgentKey(persistedState.activeStudioAgentKey),
        gameStudioInitialized: persistedState.gameStudioInitialized === true,
        pendingSlashCommand: normalizePendingSlashCommand(persistedState.pendingSlashCommand),
        currentTurnState: createDefaultCurrentTurnState(),
        agentStatus: "idle",
        isGenerating: false,
        abortController: null,
        pendingReviewResolve: null,
        pendingReviewTaskId: null,
        pendingToolCall: null,
        autoApproveTools: false,
        readOnlyAutoApproveForSession: false,
        pendingRunDecision: null,
        pendingRunDecisionResolver: null,
        executionConsentPolicy: "ask_per_turn",
        currentTurnExecutionConsent: { turnId: null, granted: false },
        messages: [],
        elapsedTime: 0,
      };
    },
  }
  )
);

async function requestSemanticTurnMetadata(params: {
  input: string;
  intent: ResolvedRunIntent;
  language: "zh" | "en";
  config: AppConfig;
}): Promise<SemanticTurnMetadata | null> {
  try {
    const isCloud = params.config.activeProfile === "cloud";
    const ac = isCloud ? params.config.cloud : params.config.local;
    const endpoint = isCloud ? (params.config.cloud.endpoint || "") : params.config.local.endpoint;
    const model = ac.model;
    const provider = isCloud ? params.config.cloud.provider : params.config.local.provider;
    const cloudProtocol = normalizeCloudProtocol(isCloud ? params.config.cloud.protocol : "openai");
    const cloudApiFormat = normalizeCloudApiFormat(isCloud ? params.config.cloud.apiFormat : "chat_completions");
    if (!model || !endpoint) return null;

    const msgs: Array<{ role: "system" | "user"; content: string }> = [
      {
        role: "system",
        content: [
          "You are MAIN's hidden semantic title generator.",
          "Return strict JSON only. No markdown, no prose, no code fences.",
          "This is a tiny background UI-label task, not the main conversation.",
          "Infer the user's actual task intent from the raw input.",
          "Ignore usernames, timestamps, transcript prefixes, copied meta text, and reasoning-style wording.",
          "Generate:",
          "- title: short clean UI title for sidebar / TopIsland, plain text only, no quotes, no markdown, no intent prefix.",
          "- summary: one concise user-facing summary of the real intent, plain text only.",
          "Keep the output in the user's language.",
          "JSON shape:",
          "{\"title\":\"修正标题同步逻辑\",\"summary\":\"调整 sidebar 与 TopIsland 的标题与摘要生成逻辑\"}",
        ].join("\n"),
      },
      {
        role: "user",
        content: [
          `Resolved intent: ${params.intent}`,
          `Preferred language: ${params.language}`,
          `Raw user input: ${params.input.slice(0, 800)}`,
          "Return strict JSON now.",
        ].join("\n"),
      },
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
        maxTokens: 120,
        stream: false,
        temperature: 0.1,
        topP: 0.8,
      });
      headers = buildCloudHeaders("anthropic", ac.apiKey, true, params.config.cloud.customHeaders);
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
              disableResponseStorage: params.config.cloud.disableResponseStorage,
              reasoningEffort: "none",
            }),
          }
        : { model, messages: msgs, stream: false, max_tokens: 120, temperature: 0.1, top_p: 0.8 };
      headers = buildCloudHeaders("openai", ac.apiKey, true, params.config.cloud.customHeaders);
    }

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
      if (!r.ok) return null;
      j = await r.json();
    }

    const rawText = provider === "Ollama"
      ? j.message?.content?.trim()
      : isAnthropicCloud
        ? extractAnthropicResponseText(j).trim()
        : extractOpenAiResponseText(j, cloudApiFormat).trim();

    const jsonText = extractJsonObject(rawText || "");
    const parsedMetadata = jsonText
      ? JSON.parse(jsonText)
      : extractLooseSemanticTurnMetadata(rawText || "");
    if (!parsedMetadata) return null;
    return normalizeSemanticTurnMetadata(parsedMetadata, {
      input: params.input,
      intent: params.intent,
      language: params.language,
    });
  } catch {
    return null;
  }
}

// ── Selector Helpers ──────────────────────────────────────────────────

function createFeishuApprovalCode(): string {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

function buildFeishuApprovalMessage(
  language: "zh" | "en",
  code: string,
  toolName: string,
  target: string,
): string {
  if (language === "en") {
    return [
      "MAIN is waiting for remote approval.",
      `Tool: ${toolName}`,
      target ? `Target: ${target}` : "",
      `Reply /approve ${code} to allow, or /reject ${code} to reject.`,
    ].filter(Boolean).join("\n");
  }
  return [
    "MAIN 正在等待飞书远程审批。",
    `工具：${toolName}`,
    target ? `目标：${target}` : "",
    `回复 /approve ${code} 允许执行，或 /reject ${code} 拒绝。`,
  ].filter(Boolean).join("\n");
}

function extractFeishuTurnReply(blocks: TaskBlock[], turnId: string, fallback: string): string {
  const turnBlocks = blocks.filter((block) => block.turnId === turnId);
  const latestAgent = [...turnBlocks]
    .reverse()
    .find((block): block is Extract<TaskBlock, { type: "agent" }> => block.type === "agent" && !!block.content?.trim());
  if (latestAgent?.content?.trim()) return summarizeAssistantText(latestAgent.content).slice(0, 1800);

  const latestSystem = [...turnBlocks]
    .reverse()
    .find((block): block is Extract<TaskBlock, { type: "system" }> => block.type === "system" && !!block.content?.trim());
  if (latestSystem?.content?.trim()) return summarizeAssistantText(latestSystem.content).slice(0, 1800);

  const latestToolError = [...turnBlocks]
    .reverse()
    .find((block): block is Extract<TaskBlock, { type: "tool" }> => block.type === "tool" && block.toolStatus === "failed" && !!block.message?.trim());
  if (latestToolError?.message?.trim()) return latestToolError.message.slice(0, 1800);

  return fallback;
}

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
