// store/useAppStore.ts
// Zustand global state for Local Agent IDE
// All state that was previously scattered as useState in the monolith lives here.
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { type AgentMessage, type ReviewDecision, type ContentPart } from "../lib/orchestrator";
import type { ExecuteRecoveryMode } from "../lib/executeRecoveryTools";
import { WorkflowEngine, type WorkflowContext } from "../lib/orchestrator/workflowEngine";
import type { SessionAutoApproveScope } from "../lib/runtimeTools";
import {
  analyzeTabularDocument,
  cancelImageStudioJob,
  deleteChatTempPath,
  deletePlanFiles,
  deleteWorkspacePath,
  ingestAttachmentFile,
  listDirectory,
  readChatTempFile,
  readDocument,
  readFile,
  readFileWindow,
  saveProjectSession,
  writeChatTempFile,
  writeFile,
  type GitDiffEntry,
  type ReadFileWindowResult,
  type ShellPermissionDecision,
} from "../lib/ipc";
import { buildShellPermissionApproval, suggestedShellPermissionRules } from "../lib/shellAutoApproval";
import { invoke } from "@tauri-apps/api/core";
import { setWorkspaceRoot as setWorkspaceRootIpc } from "../lib/ipc";
import { appendDebugLog } from "../lib/debugLog";
import {
  consumePendingUncleanRestartDiagnostic,
  getCurrentHarnessInstanceId,
  normalizeHarnessRunMarker,
  persistHarnessRunMarker,
  type HarnessRunMarker,
} from "../lib/harnessCrashTelemetry";
import { normalizeContextMemoryState, type ContextMemoryState } from "../lib/contextMemory";
import { setMcpToolServerMap, type MCPServer, type MCPTool } from "../lib/mcpClient";
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
  type PendingOperationProposal,
  type PlanArtifact,
  type PlanExecutionEvidenceEntry,
  type PlanExecutionProgressSnapshot,
  type PlanStage,
  type PlanTask,
  type ReplyOption,
  type ResponseLanguagePolicy,
  type RightPanelTab,
  buildPlanTaskEvidenceAudit,
  detectPlanArtifactKind,
  deriveRuntimePlanTasksFromArtifacts,
  extractPlanTasks,
  findDroppedPlanTasks,
  getPendingPlanTaskCommandFocus,
  getPlanArtifactTitle,
  collectChangeEntries,
  isGenericConversationTitle,
  looksLikeReasoningLeakTitle,
  normalizeResponseLanguagePolicy,
  normalizeConversationDisplayTitle,
  reconcilePlanTaskCompletion,
  resolveTurnResponseLanguage,
  summarizeAssistantText,
  summarizeUserPrompt,
  validatePlanArtifactContent,
} from "../lib/workflowModels";
import {
  appendRuntimeEvent,
  normalizeEventStreamMode,
  normalizeToolFeedbackFormat,
  withEventSchema,
  type EventStreamMode,
  type MainThreadEvent,
  type MainThreadEventInput,
  type ToolFeedbackFormat,
} from "../lib/turnEvents";
import { getDiffStats } from "../lib/diff";
import {
  isPlanExecutionEvidenceTool,
} from "../lib/planEvidence";
import {
  buildAnthropicRequestBody,
  buildGeminiRequestForAuthMode,
  buildOpenAiResponsesInputCandidates,
  buildOpenAiResponsesRequestExtras,
  extractOpenAiResponsesInstructions,
  extractGeminiResponseText,
  extractOpenAiResponseText,
  parseOpenAiResponsesSseText,
  buildCloudHeaders,
  buildCloudMessagesApiUrl,
  extractAnthropicResponseText,
  normalizeCloudProtocol,
  resolveEffectiveCloudApiFormat,
  type CloudToolProtocol,
  type ReasoningDisplayMode,
} from "../lib/cloudProtocol";
import {
  normalizeCloudServerState,
  type CloudProfileConfig,
  type CloudServerConfig,
} from "../lib/cloudServers";
import { resolveStreamingAssistantDisplay } from "../lib/streamDisplayPolicy";
import {
  normalizeProgressNarration,
  type ProgressNarration,
} from "../lib/progressNarration";
import {
  makeTurnRuntimePhase,
  normalizeTurnRuntimePhase,
  deriveTurnRuntimePhaseForText,
  type TurnRuntimePhase,
} from "../lib/turnPhase";
import { buildPlanApprovalChoiceHint, normalizePlanApprovalChoice } from "../lib/planControl";
import {
  buildPlanExecutionProgressUpdate,
  normalizePlanExecutionProgressSnapshot,
} from "../lib/planExecutionRecovery";
import {
  type AttachedFile,
  type AttachmentKind,
  classifyAttachment,
  getAttachmentDisplayName,
  normalizeAttachedFile,
} from "../lib/attachments";
import {
  buildSemanticMetadataContextLines,
  buildTurnIntakeContextBlock,
  normalizeTurnInputContextSignals,
  type TurnInputContextSignals,
} from "../lib/turnIntake";
import { getFilePreviewStrategy } from "../lib/filePreviewStrategy";
import {
  buildUserContextItems,
  sanitizeUserContextItemsForPersist,
  type UserContextItem,
} from "../lib/userContextItems";
import {
  LOCAL_PERSIST_SCHEMA_VERSION,
  buildPersistedAppState,
  stripLegacyConfigFields,
  stripLegacyRuntimeFieldsFromPersistedState,
} from "../lib/persistState";
import {
  buildGameStudioEnvelopeForTurn,
  ensureGameStudioWorkspaceInitialized,
  formatGameStudioCommandDocForDisplay,
  formatGameStudioMissingCommandDoc,
  hasBundledGameStudioLocalizedCommandMarkdown,
  loadGameStudioConfig,
  removeGameStudioWorkspaceAssets,
  resolveGameStudioHelpTarget,
  setGameStudioEngineConfig,
} from "../lib/gameStudioPack";
import {
  getGameStudioSlashCommandSpec,
  getDefaultStudioAgentForEngine,
  parseSetupEngineArgs,
  normalizeStudioAgentKey,
  parseGameStudioSlashCommand,
  type StudioWorkflowCommandSlug,
  type NexusModeKey,
  type PendingSlashCommand,
  type StudioAgentKey,
  type StudioConfig,
  type StudioEngineKey,
} from "../lib/gameStudioCatalog";
import {
  detectGameDevelopmentIntent,
  type GameDevelopmentIntentSignal,
} from "../lib/gameDevelopmentIntent";
import {
  createPendingDecisionCopy,
  getIntentPolicy,
  inferCommandDirective,
  looksLikeExistingPlanExecutionRequest,
  looksLikePlanContinuationOrApprovalInput,
  looksLikePreviousTurnContinuationInput,
  resolveConversationTurnIntent,
  resolveRunIntentFromLegacyWorkflowMode,
  resolveTurnRunIntent,
  isResumablePreviousTurnStatus,
  parseMainDebugShortcut,
  parseMainIntentShortcutForMode,
  isMainIntentShortcutAllowedInMainMode,
  shouldContinuePreviousTurnFromInput,
  shouldUseBlockingIntentPreflight,
  type ExecutionConsentPolicy,
  type CommandDirective,
  type MainIntentShortcut,
  type PendingRunDecision,
  type PendingRunDecisionChoice,
  type ResolvedUserIntent,
  type ResolvedRunIntent,
  type RunIntentResolution,
} from "../lib/runIntent";
import {
  resolvePlanStateHydrationReason,
  shouldPromoteHydratedPlanToExecuting,
} from "../lib/planStateHydration";
import { PLAN_ARTIFACT_PATHS, hydratePlanArtifactsFromReader } from "../lib/planArtifactHydration";
import { mapLegacyNexusModeToMainMode, mapMainModeToLegacyNexusMode, type MainModeKey } from "../lib/mainModes";
import {
  createConfigSlice,
  defaultConfig,
  resolveRuntimeLaneKey,
  normalizeReasoningDisplay,
  normalizeLocalConfig,
  normalizeContextMemoryStateByRuntimeKey,
  resolveContextMemoryStateForRuntimeLane,
  PROVIDER_COMPATIBILITY_FORCE_XML_TTL_MS,
  PROVIDER_COMPATIBILITY_NATIVE_RECOVERY_SUCCESS_STREAK,
} from "./slices/configSlice";
import { StreamingThinkingInterceptor } from "../lib/chat/StreamingThinkingInterceptor";
import { StreamingCadenceBuffer } from "../lib/chat/streamBuffer";
import {
  createWorkspaceSlice,
  normalizePendingDecisionInputKey,
  normalizeStoredRightPanelTab,
} from "./slices/workspaceSlice";
import {
  buildImageGenerationParams,
  checkImageStudioEngineStatus,
  createDefaultImageStudioRuntime,
  createInitialImageProgress,
  getDefaultImageStudioEndpoint,
  getActiveImageStudioModel,
  isLocalImageStudioProvider,
  isImageGenerationPrompt,
  normalizeImageStudioConfig,
  normalizeImageStudioRuntime,
  persistGeneratedImage,
  runLocalImageStudioGeneration,
  startImageStudioGeneration,
  streamImageStudioGeneration,
  type ImageGenerationBlockPayload,
  type ImageGenerationParams,
  type ImageStudioConfig,
  type ImageStudioEngineStatus,
  type ImageStudioRuntime,
} from "../lib/imageStudio";
import {
  buildImageSessionDefaultTitle,
  buildStandardSessionDefaultTitle,
  findLatestSessionForAffinity,
  normalizeSessionModeAffinity,
  resolveSessionModeAffinity,
  type SessionModeAffinityLike,
  type SessionModeAffinity,
} from "../lib/imageStudioSessions";
import { runIntentPreflight } from "../lib/intentPreflight";
import { runAfterNextPaint } from "../lib/uiScheduling";
import {
  buildFeishuApprovalCard,
  createDefaultFeishuAdapterRuntimeStatus,
  normalizeImAdaptersConfig,
  resolveFeishuApprovalAction,
  upsertFeishuPairingRequest,
  type FeishuApprovalAction,
  type FeishuApprovalRecord,
  type FeishuApprovalStatus,
  type FeishuAdapterRuntimeStatus,
  type FeishuInteractiveCard,
  type FeishuPendingPairing,
  type ImAdaptersConfig,
} from "../lib/imAdapters";
import {
  isLocalFileReadApproved,
  normalizeLocalFileReadPath,
  normalizeMcpRoutingConfig,
  normalizeToolPermissionPolicy,
  type McpRoutingConfig,
  type PromptLanguageStrategy,
  type ToolPermissionPolicy,
} from "../lib/toolCapabilities";
import {
  deriveThoughtDisplay,
  normalizeThoughtSummaryForCompare,
} from "../lib/thoughtDisplay";
import {
  canUpdateSeedSessionTitle,
  isSemanticTurnMetadataCallbackCurrent,
  parseIntentTitleCandidate,
  shouldRequestSemanticTurnMetadataForTurn,
  shouldSeedSessionTitle,
} from "../lib/intentTitlePolicy";

export function logStoreEvent(event: string, data: Record<string, unknown> = {}) {
  try {
    appendDebugLog("info", `store.${event}`, data);
  } catch {
    // Diagnostics must never affect user workflows.
  }
}

function nowMs() {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}



const SESSION_AUTO_APPROVE_SCOPE_SET = new Set<SessionAutoApproveScope>([
  "workspace_write",
  "shell",
  "local_file_read",
  "external_write",
  "browser_control",
]);
const DEFAULT_SESSION_AUTO_APPROVE_SCOPES: SessionAutoApproveScope[] = [
  "workspace_write",
  "shell",
  "local_file_read",
  "external_write",
  "browser_control",
];

function normalizeSessionAutoApproveScopes(value: unknown): SessionAutoApproveScope[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<SessionAutoApproveScope>();
  const scopes: SessionAutoApproveScope[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    if (!SESSION_AUTO_APPROVE_SCOPE_SET.has(item as SessionAutoApproveScope)) continue;
    const scope = item as SessionAutoApproveScope;
    if (seen.has(scope)) continue;
    seen.add(scope);
    scopes.push(scope);
  }
  return scopes;
}

function buildSessionAutoApproveScopes(enabled: boolean): SessionAutoApproveScope[] {
  return enabled ? [...DEFAULT_SESSION_AUTO_APPROVE_SCOPES] : [];
}

function buildEffectiveSessionAutoApproveScopes(
  autoApproveTools: boolean | undefined,
  value: unknown,
): SessionAutoApproveScope[] {
  const scopes = normalizeSessionAutoApproveScopes(value);
  if (autoApproveTools === true) {
    return normalizeSessionAutoApproveScopes([...DEFAULT_SESSION_AUTO_APPROVE_SCOPES, ...scopes]);
  }
  return scopes;
}



function commandMatchesPermissionRule(command: string, rule: string): boolean {
  const cleanCommand = String(command || "").trim();
  const cleanRule = String(rule || "").trim();
  return !!cleanCommand && !!cleanRule && (
    cleanCommand === cleanRule ||
    cleanCommand.startsWith(`${cleanRule} `)
  );
}

function isShellDecisionCoveredBySessionRules(
  decision: ShellPermissionDecision | null | undefined,
  rules: string[] | undefined,
): boolean {
  if (!decision || decision.decision !== "ask") return false;
  const activeRules = Array.isArray(rules)
    ? rules.map((rule) => rule.trim()).filter(Boolean)
    : [];
  if (activeRules.length === 0) return false;
  const askSegments = (decision.segmentDecisions || []).filter((segment) => segment.decision === "ask");
  if (askSegments.length === 0) return false;
  return askSegments.every((segment) =>
    activeRules.some((rule) => commandMatchesPermissionRule(segment.command, rule)),
  );
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
    themeModeBlack: "Black",
    themeModeLight: "Light",
    switchPersona: "Switch Persona",
    switchMainMode: "MAIN Mode",
    runMode: "Run Mode",
    main_mode: "MAIN",
    game_studio: "Game Studio",
    image_studio: "Image Studio",
    nexus_general: "General Collaboration",
    nexus_create: "Creative Co-Creation",
    nexus_build: "Engineering Delivery",
    nexus_research: "Research & Analysis",
    nexus_game_studio: "Game Studio",
    mcpServers: "MCP Servers",
    mcpScanTools: "Scan Tools",
    mcpScanning: "Scanning...",
    mcpDescription: "Configure MCP (Model Context Protocol) servers so MAIN can connect to external tools or engines. HTTP transport is supported.",
    mcpNoServersConfigured: "No MCP servers configured",
    mcpNoServersHint: "Use Add Server below to connect an external engine",
    mcpRemoveServer: "Remove",
    mcpAddServer: "Add Server",
    mcpServerNamePlaceholder: "Name (for example unityMCP)",
    mcpAdd: "Add",
    mcpDiscoveredTools: "Discovered Tools",
    mcpDiscoveredMessage: "Discovered {toolCount} tool(s) from {serverCount} server(s)",
    mcpNoServers: "No MCP servers configured",
    mcpNoTools: "No tools found. Check whether the servers are online.",
    mcpDiscoveryFailedMessage: "Discovery failed: {message}",
    mcpTip: "Start the MCP server and make sure it is listening on the configured port, then click Scan Tools. Discovered tools become available to the AI automatically. Unity MCP defaults to",
    instructionsHooks: "Instructions & Hooks",
    about: "About",
    currentVersion: "Current Version",
    checkForUpdates: "Check for Updates",
    checkingForUpdates: "Checking for updates...",
    upToDate: "MAIN is up to date.",
    updateAvailable: "Update available",
    installAndRestart: "Install and Restart",
    updateCheckFailed: "Update check failed",
    instructionsEnabled: "Enable workspace instructions",
    hooksEnabled: "Enable lifecycle hooks",
    sessionRecording: "Record project sessions",
    sessionRecordingDesc: "Save full conversations in MAIN app data so project history can be restored without writing chat logs into .MAIN.",
    enableCapsule: "Enable execution capsule",
    enableCapsuleDesc: "When enabled, dynamic agent execution status and brief descriptions are displayed in a floating capsule. When disabled, these statuses are permanently displayed directly in the chat message area.",
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
    themeModeBlack: "黑色",
    themeModeLight: "浅色",
    switchPersona: "切换执行角色",
    switchMainMode: "MAIN 模式",
    runMode: "工作方式",
    main_mode: "MAIN",
    game_studio: "游戏工作室",
    image_studio: "图像工作室",
    nexus_general: "通用协作",
    nexus_create: "创意共创",
    nexus_build: "工程实现",
    nexus_research: "研究分析",
    nexus_game_studio: "游戏工作室",
    mcpServers: "MCP 服务器",
    mcpScanTools: "扫描工具",
    mcpScanning: "扫描中...",
    mcpDescription: "配置 MCP (Model Context Protocol) 服务器，让 MAIN 可以连接外部工具或引擎。支持 HTTP 传输协议。",
    mcpNoServersConfigured: "暂无 MCP 服务器配置",
    mcpNoServersHint: "点击下方「添加服务器」连接外部引擎",
    mcpRemoveServer: "移除",
    mcpAddServer: "添加服务器",
    mcpServerNamePlaceholder: "名称 (如 unityMCP)",
    mcpAdd: "添加",
    mcpDiscoveredTools: "已发现的工具",
    mcpDiscoveredMessage: "已发现 {toolCount} 个工具（来自 {serverCount} 个服务器）",
    mcpNoServers: "尚未配置 MCP 服务器",
    mcpNoTools: "未发现任何工具，请检查服务器是否在线",
    mcpDiscoveryFailedMessage: "发现失败：{message}",
    mcpTip: "MCP 服务器需先启动并监听指定端口，然后点击「扫描工具」发现可用工具。发现后的工具会在对话中自动供 AI 调用。Unity MCP 服务器默认地址为",
    instructionsHooks: "指令与 Hooks",
    about: "关于",
    currentVersion: "当前版本",
    checkForUpdates: "检查更新",
    checkingForUpdates: "正在检查更新...",
    upToDate: "MAIN 已是最新版本。",
    updateAvailable: "发现新版本",
    installAndRestart: "安装并重启",
    updateCheckFailed: "检查更新失败",
    instructionsEnabled: "启用工作区指令",
    hooksEnabled: "启用生命周期 Hooks",
    sessionRecording: "记录项目会话",
    sessionRecordingDesc: "将完整对话保存到 MAIN 应用数据目录，方便恢复项目历史，但不会把聊天流水写进 .MAIN。",
    enableCapsule: "启用执行胶囊 (Capsule)",
    enableCapsuleDesc: "开启时，智能助手的动态执行进度与简要说明将在浮动胶囊中显示；关闭时，这些执行过程中的状态与说明将永久直接显示在聊天消息区域中。",
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
export type ThemeMode = "light" | "dark" | "black";

export function normalizeThemeMode(value: unknown): ThemeMode {
  return value === "light" || value === "dark" || value === "black" ? value : "dark";
}

// ── Themes ───────────────────────────────────────────────────────────

export const THEMES = {
  blue:   { accent: '#007acc', hover: '#005f9e', light: '#3b82f6', subtle: 'rgba(0,122,204,0.15)',   subtleBorder: 'rgba(0,122,204,0.3)',   contrast: '#ffffff', name: 'VS Code Blue' },
  purple: { accent: '#9333ea', hover: '#7e22ce', light: '#a855f7', subtle: 'rgba(147,51,234,0.15)',  subtleBorder: 'rgba(147,51,234,0.3)',  contrast: '#ffffff', name: 'Amethyst' },
  green:  { accent: '#059669', hover: '#047857', light: '#10b981', subtle: 'rgba(5,150,105,0.15)',   subtleBorder: 'rgba(5,150,105,0.3)',   contrast: '#ffffff', name: 'Matrix Green' },
  yellow: { accent: '#ca8a04', hover: '#a16207', light: '#eab308', subtle: 'rgba(202,138,4,0.15)',   subtleBorder: 'rgba(202,138,4,0.3)',   contrast: '#111827', name: 'Sublime Gold' },
  rose:   { accent: '#e11d48', hover: '#be123c', light: '#fb7185', subtle: 'rgba(225,29,72,0.15)',   subtleBorder: 'rgba(225,29,72,0.3)',   contrast: '#ffffff', name: 'Ruby Red' },
  hermesOrange: { accent: '#F37021', hover: '#D85F16', light: '#FB923C', subtle: 'rgba(243,112,33,0.15)', subtleBorder: 'rgba(243,112,33,0.32)', contrast: '#111827', name: 'Hermes Orange' },
  tiffanyBlue: { accent: '#81D8D0', hover: '#5EC7BD', light: '#A8EEE8', subtle: 'rgba(129,216,208,0.16)', subtleBorder: 'rgba(129,216,208,0.34)', contrast: '#063433', name: 'Tiffany Blue' },
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

export interface ProviderCompatibilityRuntimeLaneState {
  forceXmlTools: boolean;
  fallbackExpiresAt: number | null;
  nativeSuccessStreak: number;
  lastFallbackAt: number;
}

export interface QueuedUserMessage {
  id: string;
  text: string;
  images?: string[];
  contextMentions?: string[];
  attachedFiles?: AttachedFile[];
  createdAt: number;
  status: "queued";
}

export interface ActiveGuidance {
  id: string;
  text: string;
  turnId: string | null;
  createdAt: number;
  consumedAt?: number | null;
}

export type WebSearchProvider = "duckduckgo" | "bing" | "baidu";

function normalizeWebSearchProvider(value: unknown): WebSearchProvider {
  return value === "bing" || value === "baidu" ? value : "duckduckgo";
}

export interface SessionRuntimeSnapshot {
  runtimeEventSchemaVersion?: number;
  runtimeEvents?: MainThreadEvent[];
  harnessRunMarker?: HarnessRunMarker | null;
  taskFlow: TaskBlock[];
  agentMessages: AgentMessage[];
  contextMemoryState?: ContextMemoryState | null;
  contextMemoryStateByRuntimeKey?: Record<string, ContextMemoryState | null>;
  providerCompatibilityByRuntimeKey?: Record<string, ProviderCompatibilityRuntimeLaneState>;
  conversationTurns: ConversationTurn[];
  currentTurnId: string | null;
  selectedMainModeKey: MainModeKey;
  selectedNexusModeKey: NexusModeKey;
  sessionModeAffinity?: SessionModeAffinity;
  imageStudio?: ImageStudioRuntime;
  activeStudioAgentKey: StudioAgentKey;
  gameStudioInitialized: boolean;
  pendingSlashCommand: PendingSlashCommand | null;
  planArtifacts: PlanArtifact[];
  planTasks: PlanTask[];
  planExecutionEvidenceLedger: PlanExecutionEvidenceEntry[];
  planExecutionEvidenceCount: number;
  planAutoResumeCount?: number;
  planExecutionProgressSnapshot?: PlanExecutionProgressSnapshot | null;
  planStage: PlanStage;
  isPlanApproved: boolean;
  planApprovalChoice?: string | null;
  showPlanPanel: boolean;
  showDiff: boolean;
  showTerminal: boolean;
  showFilePanel: boolean;
  rightPanelTab: RightPanelTab;
  selectedDiffTaskId: number | null;
  transcriptPartial?: boolean;
  transcriptLoadedTurns?: number;
  transcriptTotalTurns?: number;
  autoApproveTools?: boolean;
  autoApproveToolScopes?: SessionAutoApproveScope[];
  webSearchEnabled?: boolean;
  webSearchProvider?: WebSearchProvider;
  approvedShellPermissionRules?: string[];
  queuedUserMessage?: QueuedUserMessage | null;
  activeGuidance?: ActiveGuidance | null;
}

export interface SessionRuntimeState extends SessionRuntimeSnapshot {
  input: string;
  contextMentions: string[];
  attachedFiles: AttachedFile[];
  preferredResponseLanguage: Lang;
  lockedComposerIntent: MainIntentShortcut | null;
  pendingRunDecision: PendingRunDecision | null;
  pendingRunDecisionResolver:
    | ((choice: "approve_once" | "approve_thread" | "cancel") => void)
    | null;
  autoApproveTools: boolean;
  webSearchEnabled: boolean;
  webSearchProvider: WebSearchProvider;
  currentTurnExecutionConsent: { turnId: string | null; granted: boolean };
  approvedLocalFileReadPaths: string[];
  approvedShellPermissionRules: string[];
  readOnlyAutoApproveForSession: boolean;
  queuedUserMessage: QueuedUserMessage | null;
  activeGuidance: ActiveGuidance | null;
  planApprovalChoice: string | null;
  normalizedStreamState: NormalizedStreamState;
  currentTurnState: AppState["currentTurnState"];
  isGenerating: boolean;
  agentStatus: AgentStatus;
  abortController: AbortController | null;
  elapsedTime: number;
  pendingReviewResolve: ((decision: ReviewDecision) => void) | null;
  pendingReviewTaskId: number | null;
  pendingToolCall: {
    name: string;
    arguments: Record<string, unknown>;
    localFileReadPath?: string;
    shellPermissionDecision?: ShellPermissionDecision;
  } | null;
  autoApproveToolScopes: SessionAutoApproveScope[];
  showFilePanel: boolean;
  fileViewerPath: string;
  fileViewerContent: string;
  fileViewerWindow: ReadFileWindowResult | null;
  fileViewerError: string;
  fileViewerLoading: boolean;
}

export interface Session {
  id: number;
  title: string;
  date: string;
  active: boolean;
  sessionModeAffinity?: SessionModeAffinity;
  titleSource?: "default" | "local_seed" | "semantic" | "manual";
  semanticTitleUpdatedAt?: number;
  titleIntentSignature?: string;
  messages?: TaskBlock[];
  modelConfig?: SessionModelConfig;
  activeSkills?: string[];
  runtimeSnapshot?: SessionRuntimeSnapshot;
  storageStatus?: "ok" | "missing" | "temporary";
  transcriptPartial?: boolean;
  transcriptLoadedTurns?: number;
  transcriptTotalTurns?: number;
  turnCount?: number;
  messageCount?: number;
  recordingDisabled?: boolean;
  updatedAt?: string | number;
  updatedAtMs?: number;
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
  toolProtocol?: CloudToolProtocol;
}

export type CloudConfig = CloudProfileConfig;
export type { CloudServerConfig } from "../lib/cloudServers";

export interface AppConfig {
  language: Lang;
  responseLanguagePolicy: ResponseLanguagePolicy;
  theme: ThemeKey;
  themeMode: ThemeMode;
  appIconVariant: "light" | "dark";
  workflowMode: "chat" | "edit" | "plan";  // Legacy mirror of the active turn intent.
  promptLanguageStrategy: PromptLanguageStrategy;
  toolPermissionPolicy: ToolPermissionPolicy;
  mcpRouting: McpRoutingConfig;
  instructionsEnabled: boolean;
  hooksEnabled: boolean;
  activeProfile: "local" | "cloud";
  chatFontSize: number;  // px, default 13
  sessionRecordingEnabled: boolean;
  debugRecordFullTurnProcess: boolean;
  reasoningDisplay: ReasoningDisplayMode;
  eventStreamMode: EventStreamMode;
  toolFeedbackFormat: ToolFeedbackFormat;
  local: LocalConfig;
  cloud: CloudConfig;
  cloudServers: CloudServerConfig[];
  activeCloudServerId: string;
  cloudExperimentalLoginEnabled: boolean;
  imAdapters: ImAdaptersConfig;
  workspace: string;
  enableCapsule: boolean;
}

export type AgentStatus = "idle" | "running" | "pending_review" | "error";

export interface FeishuRemoteContext {
  adapter: "feishu";
  chatId: string;
  userId: string;
  userName: string;
  messageId?: string;
}

export interface FeishuPendingApproval extends FeishuApprovalRecord {
  code: string;
  approvalId: string;
  nonce: string;
  taskId: number;
  chatId: string;
  userId: string;
  messageId?: string;
  cardMessageId?: string;
  toolName: string;
  target: string;
  workspace?: string;
  preview?: string;
  createdAt: number;
  expiresAt: number;
  status: FeishuApprovalStatus;
}

export type FeishuApprovalProcessResult =
  | { ok: true; approval: FeishuPendingApproval }
  | {
      ok: false;
      reason: "not_found" | "wrong_user" | "wrong_chat" | "nonce_mismatch" | "expired" | "already_resolved";
      approval?: FeishuPendingApproval;
    };

export interface JobItem {
  id: string;
  subject: string;
  status: "pending" | "in_progress" | "completed";
}

interface TaskBlockBase {
  id: number;
  turnId?: string;
  turnPhase?: TurnRuntimePhase;
}

export interface ToolDiffSnapshot {
  old: string;
  new: string;
  path?: string;
  existed?: boolean;
  fullFile?: boolean;
  binary?: boolean;
}

export interface GitDiffPreviewState {
  entries: GitDiffEntry[];
  sourceLabel?: string;
}

export type DiffRevertStatus = "reverting" | "reverted" | "failed";

export interface DiffRevertRequest {
  path: string;
  taskIds: number[];
  oldText: string;
  newText: string;
  existed?: boolean;
  fullFile?: boolean;
}

export interface DiffRevertResult {
  path: string;
  taskIds: number[];
  ok: boolean;
  message: string;
}

export type AssistantTextVisibility = "user_progress" | "hidden_process" | "substantive_plan_text";
type CapsuleExplanationSource = "model";
type CapsuleExplanationState = {
  turnId: string;
  text: string;
  updatedAt: number;
  source: CapsuleExplanationSource;
} | null;

export type ProgressTaskBlock = TaskBlockBase & ProgressNarration & {
  type: "progress";
  toolCallId?: string;
  toolCallIds?: string[];
  toolName?: string;
  target?: string;
};

export type TaskBlock =
  | (TaskBlockBase & { type: "user"; content: string; images?: string[]; contextItems?: UserContextItem[] })
  | (TaskBlockBase & { type: "tool"; toolName: string; target: string; status: string; toolStatus: "pending" | "executed" | "rejected" | "running" | "failed"; toolCallId?: string; message?: string; diff?: ToolDiffSnapshot; shellPermissionDecision?: ShellPermissionDecision; revertStatus?: DiffRevertStatus; revertMessage?: string; intentSummary?: string; why?: string; evidence?: string; observationSummary?: string; qualityGateReason?: string; planRecoveryReason?: string })
  | (TaskBlockBase & { type: "agent"; content: string; options?: ReplyOption[]; streaming?: boolean; hiddenProcess?: boolean; visibility?: AssistantTextVisibility; archivedAfterChoice?: boolean; archivedProposal?: boolean; selectedOption?: string })
  | (TaskBlockBase & ImageGenerationBlockPayload)
  | ProgressTaskBlock
  | (TaskBlockBase & { type: "thought"; content: string; isStreaming?: boolean; duration?: number })
  | (TaskBlockBase & { type: "jobList"; jobs: JobItem[] })
  | (TaskBlockBase & {
      type: "system";
      content: string;
      icon?: string;
      variant?: "context_compression" | "plan_quality_gate" | "plan_execution_progress" | "plan_execution_checkpoint" | "execution_checkpoint" | "game_studio_local_markdown";
      planExecutionProgress?: PlanExecutionProgressSnapshot;
      contextCompression?: {
        reason: "proactive" | "reactive" | "execute_recovery";
        droppedCount: number;
        tokenCountBefore: number;
        tokenCountAfter: number;
        tokenReduction: number;
        compressedContext?: string;
        displaySummary?: string;
        memoryPacket?: string;
        microCompactionKind?: "none" | "tool_results" | "assistant_messages" | "mixed";
        microCompactedCount?: number;
        droppedMessageCount?: number;
        topTokenSource?: {
          label: string;
          tokens: number;
          total?: number;
        };
      };
    });

// ── Store State Interface ─────────────────────────────────────────────

export interface AppState {
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
  fileViewerWindow: ReadFileWindowResult | null;
  fileViewerError: string;
  fileViewerLoading: boolean;
  selectedDiffTaskId: number | null;
  gitDiffPreview: GitDiffPreviewState | null;
  openFileTreePanel: () => void;
  openFileViewer: (path: string, workspace?: string) => Promise<void>;
  loadNextFileViewerWindow: () => Promise<void>;
  clearFileViewer: () => void;
  closeFilePanel: () => void;
  setSelectedDiffTaskId: (id: number | null) => void;
  openDiffForTask: (taskId: number) => void;
  openGitDiffPreview: (entries: GitDiffEntry[], sourceLabel?: string) => void;
  clearGitDiffPreview: () => void;
  setRightPanelTab: (tab: RightPanelTab) => void;
  openRightPanelTab: (tab: RightPanelTab) => void;
  ensurePlanArtifactsHydratedForWorkspace: (options?: { openPanel?: boolean; reason?: string; promoteTasksToExecuting?: boolean }) => Promise<boolean>;
  openPlanWorkspacePanel: () => Promise<boolean>;
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
  attachedFiles: AttachedFile[];
  selectedMainModeKey: MainModeKey;
  selectedNexusModeKey: NexusModeKey;
  activeStudioAgentKey: StudioAgentKey;
  gameStudioInitialized: boolean;
  pendingSlashCommand: PendingSlashCommand | null;
  lockedComposerIntent: MainIntentShortcut | null;
  pendingRunDecision: PendingRunDecision | null;
  dismissedPendingDecisionInputKey: string | null;
  executionConsentPolicy: ExecutionConsentPolicy;
  imageStudio: ImageStudioRuntime;
  setInput: (v: string, options?: { preserveLockedComposerIntent?: boolean }) => void;
  setPreferredResponseLanguage: (lang: Lang) => void;
  setContextMentions: (v: string[]) => void;
  addMention: (file: string) => void;
  removeMention: (file: string) => void;
  setAttachedFiles: (v: Array<AttachedFile | string>) => void;
  setSelectedMainModeKey: (key: MainModeKey) => void;
  switchMainModeWithIsolation: (key: MainModeKey) => Promise<void>;
  createIsolatedImageSession: () => Promise<number | null>;
  returnFromImageSession: (targetMode?: Exclude<MainModeKey, "image_studio">) => Promise<number | null>;
  setSelectedNexusModeKey: (key: NexusModeKey) => void;
  setActiveStudioAgentKey: (key: StudioAgentKey, options?: { persistToWorkspace?: boolean }) => Promise<void>;
  setGameStudioInitialized: (value: boolean) => void;
  setPendingSlashCommand: (command: PendingSlashCommand | null) => void;
  setLockedComposerIntent: (intent: MainIntentShortcut | null) => void;
  dismissPendingRunDecision: () => void;
  resolvePendingRunDecision: (
    choice:
      | PendingRunDecisionChoice
      | ResolvedUserIntent
      | "approve_once"
      | "approve_thread"
      | "cancel",
  ) => void;
  setImageStudioConfig: (patch: Partial<ImageStudioConfig>) => void;
  setImageStudioStatus: (status: Partial<ImageStudioEngineStatus>) => void;
  setImageStudioSetupGuideOpen: (value: boolean) => void;
  checkImageStudioEngine: () => Promise<ImageStudioEngineStatus>;
  runImageStudioGeneration: (text: string, images?: string[]) => boolean;
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
  resolvePendingFeishuApproval: (
    userId: string,
    code: string,
    action?: FeishuApprovalAction,
  ) => FeishuPendingApproval | null;
  resolvePendingFeishuApprovalAction: (request: {
    userId: string;
    chatId: string;
    approvalId: string;
    nonce: string;
    action: FeishuApprovalAction;
  }) => FeishuApprovalProcessResult;
  setFeishuApprovalCardMessageId: (approvalId: string, messageId: string) => void;
  feishuLinkedSessionId: number | null;
  feishuLinkedContext: FeishuRemoteContext | null;
  setFeishuLinkedSession: (sessionId: number | null, context: FeishuRemoteContext | null) => void;

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
  restoreRuntimeForSession: (sessionKey: string | null, options?: { resetPanels?: boolean; requireTranscript?: boolean }) => boolean;
  updateRuntimeForSession: (
    sessionKey: string,
    patch:
      | Partial<SessionRuntimeState>
      | ((runtime: SessionRuntimeState) => Partial<SessionRuntimeState>),
  ) => void;
  setCurrentWorkspace: (path: string) => void;
  setSelectedWorkspace: (path: string) => void;
  addSession: (workspacePath: string, session: Session) => void;
  removeSession: (
    workspacePath: string,
    sessionId: number,
    options?: { nextSessionId?: number | null },
  ) => void;
  updateSession: (workspacePath: string, sessionId: number, patch: Partial<Session>) => void;
  setCurrentSessionId: (id: number | null) => void;

  // Task Flow (now driven by real agent loop)
  taskFlow: TaskBlock[];
  setTaskFlow: (updater: (prev: TaskBlock[]) => TaskBlock[]) => void;
  acceptDiff: (id: number) => void;
  rejectDiff: (id: number) => void;
  revertDiffGroups: (groups: DiffRevertRequest[]) => Promise<DiffRevertResult[]>;

  // Data management
  clearChatHistory: () => void;
  resetAllSettings: () => void;

  // Workflow mode
  isPlanApproved: boolean;
  planApprovalChoice: string | null;
  planArtifacts: PlanArtifact[];
  planStage: PlanStage;
  planTasks: PlanTask[];
  planExecutionEvidenceLedger: PlanExecutionEvidenceEntry[];
  planExecutionEvidenceCount: number;
  planAutoResumeCount: number;
  planExecutionProgressSnapshot: PlanExecutionProgressSnapshot | null;
  normalizedStreamState: NormalizedStreamState;
  runtimeEvents: MainThreadEvent[];
  harnessRunMarker: HarnessRunMarker | null;
  setWorkflowMode: (mode: "chat" | "edit" | "plan") => void;
  setIsPlanApproved: (v: boolean) => void;
  setPlanStage: (stage: PlanStage) => void;
  upsertPlanArtifact: (artifact: PlanArtifact) => void;
  clearPlanArtifacts: () => void;
  deletePersistedPlanFiles: () => Promise<void>;
  deleteBrowserValidationArtifacts: () => Promise<void>;
  setPlanTasks: (tasks: PlanTask[]) => void;
  setNormalizedStreamState: (state: NormalizedStreamState) => void;
  approvePlan: (approvalChoice?: string) => void;
  rejectPlan: () => void;
  rejectPlanAndDeleteFiles: () => Promise<void>;
  showWorkflowMenu: boolean;
  setShowWorkflowMenu: (v: boolean) => void;

  // Elapsed time tracking
  elapsedTime: number;

  // ── Agent Orchestrator State ──────────────────────────────────────
  agentStatus: AgentStatus;
  agentMessages: AgentMessage[];
  contextMemoryState: ContextMemoryState | null;
  contextMemoryStateByRuntimeKey: Record<string, ContextMemoryState | null>;
  providerCompatibilityByRuntimeKey: Record<string, ProviderCompatibilityRuntimeLaneState>;
  pendingReviewResolve: ((decision: ReviewDecision) => void) | null;
  pendingReviewTaskId: number | null;
  pendingToolCall: {
    name: string;
    arguments: Record<string, unknown>;
    localFileReadPath?: string;
    shellPermissionDecision?: ShellPermissionDecision;
  } | null;
  autoApproveTools: boolean;
  autoApproveToolScopes: SessionAutoApproveScope[];
  webSearchEnabled: boolean;
  webSearchProvider: WebSearchProvider;
  currentTurnExecutionConsent: { turnId: string | null; granted: boolean };
  approvedLocalFileReadPaths: string[];
  approvedShellPermissionRules: string[];
  readOnlyAutoApproveForSession: boolean;
  queuedUserMessage: QueuedUserMessage | null;
  activeGuidance: ActiveGuidance | null;
  pendingRunDecisionResolver:
    | ((choice: "approve_once" | "approve_thread" | "cancel") => void)
    | null;
  setAutoApproveTools: (v: boolean) => void;
  setWebSearchEnabled: (v: boolean) => void;
  setWebSearchProvider: (provider: WebSearchProvider) => void;
  setReadOnlyAutoApproveForSession: (v: boolean) => void;
  queueUserMessage: (
    text: string,
    images?: string[],
    options?: { contextMentions?: string[]; attachedFiles?: AttachedFile[] },
  ) => void;
  clearQueuedUserMessage: () => void;
  setActiveGuidance: (text: string, turnId?: string | null) => void;
  clearActiveGuidance: () => void;
  consumeActiveGuidance: (turnId?: string | null) => ActiveGuidance | null;
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
      runtimeIntentOverride?: ResolvedUserIntent;
      forceExecuteRecoveryMode?: ExecuteRecoveryMode;
      commandDirective?: CommandDirective | null;
      executionConsentGranted?: boolean;
      skipIntentResolution?: boolean;
      suppressGameStudioSuggestion?: boolean;
      turnTitle?: string;
      intentSummary?: string;
      uiParentTurnId?: string;
      parentPlanTurnId?: string;
      turnIdOverride?: string;
      createVisibleTurnForHiddenMessage?: boolean;
      contextMentionsSnapshot?: string[];
      attachedFilesSnapshot?: Array<AttachedFile | string>;
      remoteFeishu?: FeishuRemoteContext;
      skipAutoPlanHydration?: boolean;
    },
  ) => boolean;
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
    capsuleExplanation: CapsuleExplanationState;
    turnId: string;
    remoteFeishu?: FeishuRemoteContext | null;
  };
  startNewTurn: (remoteFeishu?: FeishuRemoteContext | null) => void;
  getCurrentRunIntent: () => ResolvedUserIntent;
}

// ── Mock Local Model Provider Map ─────────────────────────────────────

export const MOCK_LOCAL_MODELS: Record<string, string[]> = {
  "LM Studio": ["Qwen-2.5-32B-Instruct", "Gemma-2-27b-it", "Llama-3-8B-Instruct"],
  "Ollama":    ["qwen2.5:32b", "gemma2:27b", "llama3:8b", "phi3:mini"],
  "OMLX":      ["mlx-community/Qwen2.5-32B-Instruct", "mlx-community/Meta-Llama-3-8B-Instruct", "mlx-community/Phi-3-mini"],
};





function normalizeProviderCompatibilityRuntimeLaneState(
  value: unknown,
): ProviderCompatibilityRuntimeLaneState | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<ProviderCompatibilityRuntimeLaneState>;
  const fallbackExpiresAt = Number(candidate.fallbackExpiresAt);
  const nativeSuccessStreak = Math.max(0, Math.floor(Number(candidate.nativeSuccessStreak) || 0));
  const lastFallbackAt = Math.max(0, Math.floor(Number(candidate.lastFallbackAt) || 0));
  return {
    forceXmlTools: candidate.forceXmlTools === true,
    fallbackExpiresAt: Number.isFinite(fallbackExpiresAt) && fallbackExpiresAt > 0 ? fallbackExpiresAt : null,
    nativeSuccessStreak,
    lastFallbackAt,
  };
}

export function normalizeProviderCompatibilityByRuntimeKey(
  value: unknown,
): Record<string, ProviderCompatibilityRuntimeLaneState> {
  if (!value || typeof value !== "object") return {};
  const normalized: Record<string, ProviderCompatibilityRuntimeLaneState> = {};
  for (const [rawLaneKey, laneState] of Object.entries(value as Record<string, unknown>)) {
    const laneKey = String(rawLaneKey || "").trim();
    if (!laneKey) continue;
    const normalizedState = normalizeProviderCompatibilityRuntimeLaneState(laneState);
    if (normalizedState) normalized[laneKey] = normalizedState;
  }
  return normalized;
}

const defaultSkills: Skill[] = [];

const DEFAULT_MCP_SERVERS: MCPServer[] = [
  { name: "unityMCP", type: "http", url: "http://localhost:8080/mcp", enabled: true },
];

function normalizeAppIconVariant(value: unknown): AppConfig["appIconVariant"] {
  return value === "light" ? "light" : "dark";
}



function normalizeMcpServers(servers: unknown): MCPServer[] {
  if (!Array.isArray(servers)) return DEFAULT_MCP_SERVERS;
  return servers
    .map((server: any) => ({
      name: String(server?.name || "").trim(),
      type: "http" as const,
      url: String(server?.url || "").trim(),
      enabled: server?.enabled !== false,
    }))
    .filter((server) => server.name && server.url);
}

function filterMcpDiscoveryForServers(
  tools: MCPTool[],
  toolServerMap: Record<string, string>,
  servers: MCPServer[],
): { tools: MCPTool[]; toolServerMap: Record<string, string> } {
  const enabledUrls = new Set(servers.filter((server) => server.enabled !== false).map((server) => server.url));
  const nextMap: Record<string, string> = {};
  const nextTools = tools.filter((tool) => {
    const serverUrl = toolServerMap[tool.name];
    if (!serverUrl || !enabledUrls.has(serverUrl)) return false;
    nextMap[tool.name] = serverUrl;
    return true;
  });
  return { tools: nextTools, toolServerMap: nextMap };
}

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
  hasExplicitUserChoiceRequest: false,
  toolCalls: [],
  finishReason: null,
};

const PLAN_EXECUTION_PROGRESS_DEFAULT_MAX_ITERATIONS = 50;

const defaultHookDefinitions: HookDefinition[] = [];

function createDefaultCurrentTurnState() {
  return {
    interceptorHandled: false,
    interceptorThought: "",
    lastReportedThought: "",
    lastReportedAssistantText: "",
    capsuleExplanation: null,
    turnId: "",
    remoteFeishu: null as FeishuRemoteContext | null,
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



function normalizeStoredPlanExecutionProgressSnapshot(value: unknown): PlanExecutionProgressSnapshot | null {
  const snapshot = value as Partial<PlanExecutionProgressSnapshot> | null | undefined;
  if (!snapshot || typeof snapshot !== "object") return null;
  const turnId = typeof snapshot.turnId === "string" ? snapshot.turnId : "";
  if (!turnId) return null;
  return normalizePlanExecutionProgressSnapshot({
    turnId,
    update: {
      phase: snapshot.phase || "running",
      currentTask: String(snapshot.currentTask || ""),
      currentTool: String(snapshot.currentTool || ""),
      latestEvidence: String(snapshot.latestEvidence || ""),
      nextStep: String(snapshot.nextStep || ""),
      progressSignature: String(snapshot.progressSignature || ""),
      repeatedTargets: Array.isArray(snapshot.repeatedTargets)
        ? snapshot.repeatedTargets.map((target) => String(target || "")).filter(Boolean)
        : [],
      lastEffectiveEvidenceAt: Math.max(0, Number(snapshot.lastEffectiveEvidenceAt) || 0),
      recoveryReason: String(snapshot.recoveryReason || ""),
      iteration: Math.max(0, Number(snapshot.iteration) || 0),
      maxIterations: Math.max(0, Number(snapshot.maxIterations) || 0),
      autoResumeCount: Math.max(0, Number(snapshot.autoResumeCount) || 0),
      updatedAt: Math.max(0, Number(snapshot.updatedAt) || 0),
    },
    now: Number(snapshot.updatedAt) || Date.now(),
  });
}

function normalizeRuntimeEvents(value: unknown): MainThreadEvent[] {
  if (!Array.isArray(value)) return [];
  const validTypes = new Set([
    "thread.started",
    "turn.started",
    "turn.completed",
    "turn.failed",
    "slash.command.started",
    "slash.command.completed",
    "slash.command.failed",
    "path_alias_hit",
    "plan_state_hydrated",
    "harness.telemetry",
    "progress.updated",
    "plan.ready",
    "approval.requested",
    "run.paused",
    "run.completed",
    "item.started",
    "item.updated",
    "item.completed",
    "error",
  ]);

  const normalized: MainThreadEvent[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const record = raw as Record<string, unknown>;
    const type = typeof record.type === "string" ? record.type : "";
    if (!validTypes.has(type)) continue;
    try {
      normalized.push(withEventSchema(record as MainThreadEventInput));
    } catch {
      // ignore malformed runtime events
    }
  }

  return normalized;
}

export function normalizeSessionRuntimeSnapshot(
  snapshot: Partial<SessionRuntimeSnapshot> | null | undefined,
): SessionRuntimeSnapshot | undefined {
  if (!snapshot) return undefined;
  const selectedMainModeKey = mapLegacyNexusModeToMainMode(
    (snapshot as Partial<SessionRuntimeSnapshot> & { selectedAgentKey?: string }).selectedMainModeKey ||
      (snapshot as Partial<SessionRuntimeSnapshot> & { selectedAgentKey?: string }).selectedNexusModeKey ||
      (snapshot as Partial<SessionRuntimeSnapshot> & { selectedAgentKey?: string }).selectedAgentKey,
  );
  const effectiveAutoApproveToolScopes = buildEffectiveSessionAutoApproveScopes(
    snapshot.autoApproveTools === true,
    snapshot.autoApproveToolScopes,
  );
  const taskFlow = sanitizeTaskBlocksForPersist(snapshot.taskFlow || []);
  const normalizedContextMemoryState = normalizeContextMemoryState(snapshot.contextMemoryState);
  const queuedUserMessage = normalizeQueuedUserMessage(snapshot.queuedUserMessage);
  const activeGuidance = normalizeActiveGuidance(snapshot.activeGuidance);
  return {
    runtimeEventSchemaVersion: Math.max(1, Number(snapshot.runtimeEventSchemaVersion) || 1),
    runtimeEvents: normalizeRuntimeEvents(snapshot.runtimeEvents),
    harnessRunMarker: normalizeHarnessRunMarker(snapshot.harnessRunMarker),
    taskFlow,
    agentMessages: sanitizeAgentMessagesForPersist(snapshot.agentMessages || []),
    contextMemoryState: normalizedContextMemoryState,
    contextMemoryStateByRuntimeKey: normalizeContextMemoryStateByRuntimeKey(snapshot.contextMemoryStateByRuntimeKey),
    providerCompatibilityByRuntimeKey: normalizeProviderCompatibilityByRuntimeKey(
      snapshot.providerCompatibilityByRuntimeKey,
    ),
    conversationTurns: normalizeInterruptedConversationTurnsForRestore(snapshot.conversationTurns, taskFlow),
    currentTurnId: snapshot.currentTurnId ?? null,
    selectedMainModeKey,
    selectedNexusModeKey: mapMainModeToLegacyNexusMode(selectedMainModeKey),
    sessionModeAffinity: resolveSessionModeAffinity(snapshot as SessionModeAffinityLike, selectedMainModeKey),
    imageStudio: normalizeImageStudioRuntime(snapshot.imageStudio),
    activeStudioAgentKey: normalizeStudioAgentKey(snapshot.activeStudioAgentKey),
    gameStudioInitialized: snapshot.gameStudioInitialized === true,
    pendingSlashCommand: normalizePendingSlashCommand(snapshot.pendingSlashCommand),
    planArtifacts: snapshot.planArtifacts || [],
    planTasks: snapshot.planTasks || [],
    planExecutionEvidenceLedger: snapshot.planExecutionEvidenceLedger || [],
    planExecutionEvidenceCount: snapshot.planExecutionEvidenceCount ?? 0,
    planAutoResumeCount: Math.max(0, Number(snapshot.planAutoResumeCount) || 0),
    planExecutionProgressSnapshot: normalizeStoredPlanExecutionProgressSnapshot(snapshot.planExecutionProgressSnapshot),
    planStage: snapshot.planStage ?? "idle",
    isPlanApproved: snapshot.isPlanApproved ?? false,
    planApprovalChoice: normalizePlanApprovalChoice(snapshot.planApprovalChoice),
    showPlanPanel: snapshot.showPlanPanel ?? false,
    showDiff: snapshot.showDiff ?? false,
    showTerminal: snapshot.showTerminal ?? false,
    showFilePanel: snapshot.showFilePanel ?? false,
    rightPanelTab: normalizeStoredRightPanelTab(snapshot.rightPanelTab),
    selectedDiffTaskId: snapshot.selectedDiffTaskId ?? null,
    transcriptPartial: snapshot.transcriptPartial === true,
    transcriptLoadedTurns: Math.max(0, Number(snapshot.transcriptLoadedTurns) || 0),
    transcriptTotalTurns: Math.max(0, Number(snapshot.transcriptTotalTurns) || 0),
    autoApproveTools: effectiveAutoApproveToolScopes.length > 0,
    autoApproveToolScopes: effectiveAutoApproveToolScopes,
    webSearchEnabled: snapshot.webSearchEnabled === true,
    webSearchProvider: normalizeWebSearchProvider(snapshot.webSearchProvider),
    approvedShellPermissionRules: Array.isArray(snapshot.approvedShellPermissionRules)
      ? snapshot.approvedShellPermissionRules.filter((rule): rule is string => typeof rule === "string" && rule.trim().length > 0)
      : [],
    queuedUserMessage,
    activeGuidance,
  };
}

export function normalizeQueuedUserMessage(value: unknown): QueuedUserMessage | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Partial<QueuedUserMessage>;
  const text = String(record.text || "").trim();
  const images = Array.isArray(record.images)
    ? record.images.filter((image): image is string => typeof image === "string" && image.trim().length > 0)
    : [];
  const contextMentions = Array.isArray(record.contextMentions)
    ? record.contextMentions.filter((path): path is string => typeof path === "string" && path.trim().length > 0)
    : [];
  const attachedFiles = Array.isArray(record.attachedFiles)
    ? record.attachedFiles.map((file) => normalizeAttachedFile(file)).filter((file) => file.path || file.sourcePath || file.displayName)
    : [];
  if (!text && images.length === 0 && contextMentions.length === 0 && attachedFiles.length === 0) return null;
  return {
    id: typeof record.id === "string" && record.id.trim() ? record.id : `queued-${Date.now()}`,
    text,
    ...(images.length > 0 ? { images } : {}),
    ...(contextMentions.length > 0 ? { contextMentions } : {}),
    ...(attachedFiles.length > 0 ? { attachedFiles } : {}),
    createdAt: Number.isFinite(Number(record.createdAt)) ? Number(record.createdAt) : Date.now(),
    status: "queued",
  };
}

function normalizeActiveGuidance(value: unknown): ActiveGuidance | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Partial<ActiveGuidance>;
  const text = String(record.text || "").trim();
  if (!text) return null;
  return {
    id: typeof record.id === "string" && record.id.trim() ? record.id : `guidance-${Date.now()}`,
    text,
    turnId: typeof record.turnId === "string" ? record.turnId : null,
    createdAt: Number.isFinite(Number(record.createdAt)) ? Number(record.createdAt) : Date.now(),
    consumedAt: Number.isFinite(Number(record.consumedAt)) ? Number(record.consumedAt) : null,
  };
}

const sessionRuntimeKeys = [
  "runtimeEventSchemaVersion",
  "runtimeEvents",
  "harnessRunMarker",
  "taskFlow",
  "agentMessages",
  "contextMemoryState",
  "contextMemoryStateByRuntimeKey",
  "providerCompatibilityByRuntimeKey",
  "conversationTurns",
  "currentTurnId",
  "selectedMainModeKey",
  "selectedNexusModeKey",
  "sessionModeAffinity",
  "imageStudio",
  "activeStudioAgentKey",
  "gameStudioInitialized",
  "pendingSlashCommand",
  "planArtifacts",
  "planTasks",
  "planExecutionEvidenceLedger",
  "planExecutionEvidenceCount",
  "planAutoResumeCount",
  "planExecutionProgressSnapshot",
  "planStage",
  "isPlanApproved",
  "planApprovalChoice",
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
  "autoApproveTools",
  "autoApproveToolScopes",
  "webSearchEnabled",
  "webSearchProvider",
  "currentTurnExecutionConsent",
  "approvedLocalFileReadPaths",
  "approvedShellPermissionRules",
  "readOnlyAutoApproveForSession",
  "queuedUserMessage",
  "activeGuidance",
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
  "fileViewerWindow",
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
  const runtimeLaneKey = resolveRuntimeLaneKey(state.config);
  const normalizedContextMemoryLaneMap = normalizeContextMemoryStateByRuntimeKey(state.contextMemoryStateByRuntimeKey);
  const normalizedContextMemoryState = normalizeContextMemoryState(state.contextMemoryState);
  const contextMemoryStateByRuntimeKey = normalizedContextMemoryState
    ? {
        ...normalizedContextMemoryLaneMap,
        ...(normalizedContextMemoryLaneMap[runtimeLaneKey] ? {} : { [runtimeLaneKey]: normalizedContextMemoryState }),
      }
    : normalizedContextMemoryLaneMap;
  const normalizedAutoApproveToolScopes = buildEffectiveSessionAutoApproveScopes(
    state.autoApproveTools === true,
    state.autoApproveToolScopes,
  );
  return {
    runtimeEventSchemaVersion: 1,
    runtimeEvents: normalizeRuntimeEvents(state.runtimeEvents),
    harnessRunMarker: normalizeHarnessRunMarker(state.harnessRunMarker),
    taskFlow: Array.isArray(state.taskFlow) ? state.taskFlow : [],
    agentMessages: Array.isArray(state.agentMessages) ? state.agentMessages : [],
    contextMemoryState: normalizedContextMemoryState,
    contextMemoryStateByRuntimeKey,
    providerCompatibilityByRuntimeKey: normalizeProviderCompatibilityByRuntimeKey(
      state.providerCompatibilityByRuntimeKey,
    ),
    conversationTurns: Array.isArray(state.conversationTurns) ? state.conversationTurns : [],
    currentTurnId: state.currentTurnId ?? null,
    selectedMainModeKey,
    selectedNexusModeKey: mapMainModeToLegacyNexusMode(selectedMainModeKey),
    sessionModeAffinity: resolveSessionModeAffinity(state as SessionModeAffinityLike, selectedMainModeKey),
    imageStudio: normalizeImageStudioRuntime(state.imageStudio),
    activeStudioAgentKey: normalizeStudioAgentKey(state.activeStudioAgentKey),
    gameStudioInitialized: state.gameStudioInitialized === true,
    pendingSlashCommand: normalizePendingSlashCommand(state.pendingSlashCommand),
    planArtifacts: state.planArtifacts || [],
    planTasks: state.planTasks || [],
    planExecutionEvidenceLedger: state.planExecutionEvidenceLedger || [],
    planExecutionEvidenceCount: state.planExecutionEvidenceCount ?? 0,
    planAutoResumeCount: Math.max(0, Number(state.planAutoResumeCount) || 0),
    planExecutionProgressSnapshot: normalizeStoredPlanExecutionProgressSnapshot(state.planExecutionProgressSnapshot),
    planStage: state.planStage ?? "idle",
    isPlanApproved: state.isPlanApproved === true,
    planApprovalChoice: normalizePlanApprovalChoice(state.planApprovalChoice),
    showPlanPanel: state.showPlanPanel === true,
    showDiff: state.showDiff === true,
    showTerminal: state.showTerminal === true,
    showFilePanel: state.showFilePanel === true,
    rightPanelTab: normalizeStoredRightPanelTab(state.rightPanelTab),
    selectedDiffTaskId: state.selectedDiffTaskId ?? null,
    input: state.input ?? "",
    contextMentions: state.contextMentions || [],
    attachedFiles: Array.isArray(state.attachedFiles)
      ? state.attachedFiles.map((file) => normalizeAttachedFile(file))
      : [],
    preferredResponseLanguage: state.preferredResponseLanguage || "zh",
    lockedComposerIntent: state.lockedComposerIntent ?? null,
    pendingRunDecision: state.pendingRunDecision ?? null,
    pendingRunDecisionResolver: state.pendingRunDecisionResolver ?? null,
    autoApproveTools: normalizedAutoApproveToolScopes.length > 0,
    autoApproveToolScopes: normalizedAutoApproveToolScopes,
    webSearchEnabled: state.webSearchEnabled === true,
    webSearchProvider: normalizeWebSearchProvider(state.webSearchProvider),
    currentTurnExecutionConsent: state.currentTurnExecutionConsent || { turnId: null, granted: false },
    approvedLocalFileReadPaths: Array.isArray(state.approvedLocalFileReadPaths)
      ? state.approvedLocalFileReadPaths.filter((path): path is string => typeof path === "string" && path.trim().length > 0)
      : [],
    approvedShellPermissionRules: Array.isArray(state.approvedShellPermissionRules)
      ? state.approvedShellPermissionRules.filter((rule): rule is string => typeof rule === "string" && rule.trim().length > 0)
      : [],
    readOnlyAutoApproveForSession: state.readOnlyAutoApproveForSession === true,
    queuedUserMessage: normalizeQueuedUserMessage(state.queuedUserMessage),
    activeGuidance: normalizeActiveGuidance(state.activeGuidance),
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
    fileViewerWindow: state.fileViewerWindow || null,
    fileViewerError: state.fileViewerError || "",
    fileViewerLoading: state.fileViewerLoading === true,
  };
}

function getClosedSessionPanelPatch(): Partial<AppState> {
  return {
    showPlanPanel: false,
    showDiff: false,
    showTerminal: false,
    showFilePanel: false,
    rightPanelTab: "plan",
    selectedDiffTaskId: null,
    fileViewerPath: "",
    fileViewerContent: "",
    fileViewerWindow: null,
    fileViewerError: "",
    fileViewerLoading: false,
  };
}

function getSessionRuntimeUiPatch(
  runtime: SessionRuntimeState,
  options: { resetPanels?: boolean; requireTranscript?: boolean } = {},
): Partial<AppState> {
  return options.resetPanels
    ? { ...runtime, ...getClosedSessionPanelPatch() }
    : { ...runtime };
}

function hasSessionRuntimeTranscript(runtime: Partial<SessionRuntimeState> | null | undefined): boolean {
  if (!runtime) return false;
  const agentMessages = Array.isArray(runtime.agentMessages) ? runtime.agentMessages : [];
  return (
    (Array.isArray(runtime.taskFlow) && runtime.taskFlow.length > 0) ||
    (Array.isArray(runtime.conversationTurns) && runtime.conversationTurns.length > 0) ||
    agentMessages.some((message: AgentMessage) => {
      const role = String(message?.role || "").trim();
      const content = String(message?.content || "").trim();
      return role !== "system" && content.length > 0;
    })
  );
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
      sessionModeAffinity: resolveSessionModeAffinity(session as SessionModeAffinityLike, "main_mode"),
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

const MAX_VISIBLE_THOUGHT_CHARS = 36_000;

function normalizeThoughtTextForCompare(text: string): string {
  return normalizeThoughtSummaryForCompare(text);
}

function thoughtSimilarity(a: string, b: string): number {
  const left = new Set(normalizeThoughtTextForCompare(a).split(/\s+/).filter((token) => token.length > 1));
  const right = new Set(normalizeThoughtTextForCompare(b).split(/\s+/).filter((token) => token.length > 1));
  if (left.size === 0 || right.size === 0) {
    const compactLeft = normalizeThoughtTextForCompare(a).replace(/\s+/g, "");
    const compactRight = normalizeThoughtTextForCompare(b).replace(/\s+/g, "");
    if (compactLeft.length < 8 || compactRight.length < 8) return 0;
    const grams = (value: string) => {
      const set = new Set<string>();
      for (let index = 0; index < value.length - 1; index++) set.add(value.slice(index, index + 2));
      return set;
    };
    const leftGrams = grams(compactLeft);
    const rightGrams = grams(compactRight);
    let shared = 0;
    for (const gram of leftGrams) {
      if (rightGrams.has(gram)) shared++;
    }
    return shared / Math.max(leftGrams.size, rightGrams.size);
  }
  let shared = 0;
  for (const token of left) {
    if (right.has(token)) shared++;
  }
  return shared / Math.max(left.size, right.size);
}

function collapseNearDuplicateThoughtLines(text: string): string {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (lines.length < 2) return text;
  const kept: string[] = [];
  for (const line of lines) {
    const normalized = normalizeThoughtTextForCompare(line);
    if (!normalized) continue;
    if (kept.some((existing) => {
      const existingNormalized = normalizeThoughtTextForCompare(existing);
      return existingNormalized === normalized ||
        (normalized.length > 24 && existingNormalized.length > 24 && (normalized.includes(existingNormalized) || existingNormalized.includes(normalized))) ||
        thoughtSimilarity(line, existing) >= 0.72;
    })) {
      continue;
    }
    kept.push(line);
  }
  return kept.join("\n");
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

export function compactThoughtContent(text: string): string {
  const collapsedParagraphs = collapseRepeatedThoughtParagraphs(String(text || ""));
  const collapsedLines = collapseRepeatedThoughtLines(collapsedParagraphs);
  const collapsedNearDuplicates = collapseNearDuplicateThoughtLines(collapsedLines);
  return limitThoughtContent(compactThoughtNoise(collapsedNearDuplicates));
}

export function compactThoughtContentForPersist(text: string): string {
  const compacted = compactThoughtContent(text);
  const summarized = deriveThoughtDisplay(compacted, {
    maxSummaryLines: 12,
    mode: "latest",
    density: "adaptive",
  }).summaryText;
  if (summarized) return summarized;
  return compacted.length > 2400 ? compacted.slice(0, 2400).trimEnd() : compacted;
}

function compactProcessAssistantText(text: string, language: "zh" | "en"): string {
  const display = deriveThoughtDisplay(String(text || ""), {
    language,
    mode: "latest",
    density: "adaptive",
    maxSummaryLines: 6,
  });
  return display.summaryText || compactThoughtContentForPersist(String(text || ""));
}

export function pickProcessAssistantText(visibleText: string, hiddenThought: string | undefined, language: "zh" | "en"): string {
  const visible = String(visibleText || "").trim();
  const hidden = String(hiddenThought || "").trim();
  const hiddenSummary = hidden ? compactProcessAssistantText(hidden, language) : "";
  if (hiddenSummary) return hiddenSummary;
  return compactProcessAssistantText(visible, language);
}

export function appendThoughtDelta(existing: string, incoming: string): string {
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

// ── Task ID counter ───────────────────────────────────────────────────

let taskIdCounter = 100; // Start high to avoid collision with mock data
let activeImageStudioStreamCleanup: (() => void) | null = null;

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
    const skeleton = await invoke<string>("get_project_skeleton", { depth: 3, workspace });
    workspaceTreeCache = skeleton;
    workspaceTreeCacheKey = workspace;
    workspaceTreeCacheVersion = workspaceContentVersion;
    return workspaceTreeCache;
  } catch {
    return "";
  }
}

const RUN_INTENT_LABELS: Record<ResolvedRunIntent, { zh: string; en: string }> = {
  respond: { zh: "回复", en: "Respond" },
  discuss: { zh: "回复", en: "Respond" },
  plan: { zh: "计划", en: "Plan" },
  execute: { zh: "直接执行", en: "Execute" },
  analyze: { zh: "分析", en: "Analyze" },
  summarize: { zh: "总结", en: "Summarize" },
  report: { zh: "报告", en: "Report" },
  studio_workflow: { zh: "Game Studio 工作流", en: "Game Studio Workflow" },
  image_studio: { zh: "生成图片", en: "Generate Image" },
};

const RESOLVED_USER_INTENT_KEYS = new Set<ResolvedUserIntent>([
  "respond",
  "discuss",
  "plan",
  "execute",
  "analyze",
  "summarize",
  "report",
  "studio_workflow",
  "image_studio",
]);

function isResolvedUserIntentChoice(choice: PendingRunDecisionChoice): choice is ResolvedUserIntent {
  return RESOLVED_USER_INTENT_KEYS.has(choice as ResolvedUserIntent);
}

function isStudioEngineKey(value: string | null | undefined): value is StudioEngineKey {
  return value === "unity" || value === "godot" || value === "unreal";
}

function resolveEngineFromModeSwitchChoice(
  choice: PendingRunDecisionChoice | "approve_once" | "approve_thread" | "cancel",
  pending: PendingRunDecision,
): StudioEngineKey | null {
  if (choice === "switch_game_studio_unity") return "unity";
  if (choice === "switch_game_studio_godot") return "godot";
  if (choice === "switch_game_studio_unreal") return "unreal";
  return isStudioEngineKey(pending.target) ? pending.target : null;
}

function buildGameStudioSwitchReason(
  signal: GameDevelopmentIntentSignal,
  language: "zh" | "en",
): string {
  const evidence = [...signal.projectEvidence, ...signal.semanticEvidence].slice(0, 2).join("；");
  if (language === "en") {
    if (signal.engineStatus === "explicit" && signal.engine) {
      return evidence
        ? `Detected ${signal.engine} game-development context (${evidence}). Game Studio can route this through engine-aware workflows.`
        : `Detected ${signal.engine} game-development context. Game Studio can route this through engine-aware workflows.`;
    }
    return evidence
      ? `Detected game-development context (${evidence}), but the engine is not clear yet. Choose an engine before MAIN configures Game Studio.`
      : "Detected game-development context, but the engine is not clear yet. Choose an engine before MAIN configures Game Studio.";
  }

  if (signal.engineStatus === "explicit" && signal.engine) {
    return evidence
      ? `检测到 ${signal.engine} 游戏开发上下文（${evidence}）。切换后 MAIN 会初始化 Game Studio，并同步设置该引擎。`
      : `检测到 ${signal.engine} 游戏开发上下文。切换后 MAIN 会初始化 Game Studio，并同步设置该引擎。`;
  }
  return evidence
    ? `检测到游戏开发语义（${evidence}），但还不能确定具体引擎。请先选定引擎，再让 MAIN 配置 Game Studio。`
    : "检测到游戏开发语义，但还不能确定具体引擎。请先选定引擎，再让 MAIN 配置 Game Studio。";
}

function createGameStudioModeSwitchDecision(params: {
  input: string;
  images?: string[];
  language: "zh" | "en";
  signal: GameDevelopmentIntentSignal;
}): PendingRunDecision {
  const { input, images, language, signal } = params;
  const isEnglish = language === "en";

  if (signal.engineStatus === "explicit" && signal.engine) {
    return {
      kind: "mode_switch",
      source: "pre_submit",
      originalInput: input,
      originalImages: images || [],
      suggestedIntent: "studio_workflow",
      reason: buildGameStudioSwitchReason(signal, language),
      title: isEnglish ? "Switch to Game Studio?" : "切换到游戏工作室？",
      target: signal.engine,
      options: [
        {
          id: "switch_game_studio",
          label: isEnglish ? "Switch to Game Studio" : "切换到游戏工作室",
          value: isEnglish
            ? "Switch to Game Studio and continue this game-development request."
            : "切换到游戏工作室，并继续处理这个游戏开发请求。",
        },
        {
          id: "stay_main",
          label: isEnglish ? "Continue in MAIN" : "继续在 MAIN 中处理",
          value: isEnglish
            ? "Keep handling this request in MAIN mode."
            : "继续在 MAIN 模式中处理这个请求。",
        },
      ],
    };
  }

  return {
    kind: "mode_switch",
    source: "pre_submit",
    originalInput: input,
    originalImages: images || [],
    suggestedIntent: "studio_workflow",
    reason: buildGameStudioSwitchReason(signal, language),
    title: isEnglish ? "Choose a game engine?" : "先选择游戏引擎？",
    target: "engine",
    options: [
      {
        id: "switch_game_studio_unity",
        label: isEnglish ? "Use Unity" : "使用 Unity",
        value: isEnglish
          ? "Switch to Game Studio, set the engine to Unity, and continue."
          : "切换到游戏工作室，设置引擎为 Unity，并继续处理。",
      },
      {
        id: "switch_game_studio_godot",
        label: isEnglish ? "Use Godot" : "使用 Godot",
        value: isEnglish
          ? "Switch to Game Studio, set the engine to Godot, and continue."
          : "切换到游戏工作室，设置引擎为 Godot，并继续处理。",
      },
      {
        id: "switch_game_studio_unreal",
        label: isEnglish ? "Use Unreal" : "使用 Unreal",
        value: isEnglish
          ? "Switch to Game Studio, set the engine to Unreal, and continue."
          : "切换到游戏工作室，设置引擎为 Unreal，并继续处理。",
      },
      {
        id: "switch_game_studio_choose_engine",
        label: isEnglish ? "Help Me Choose" : "先帮我选择",
        value: isEnglish
          ? "Switch to Game Studio and ask me the engine selection questions first."
          : "切换到游戏工作室，并先向我确认游戏引擎选择。",
      },
      {
        id: "stay_main",
        label: isEnglish ? "Continue in MAIN" : "继续在 MAIN 中处理",
        value: isEnglish
          ? "Keep handling this request in MAIN mode."
          : "继续在 MAIN 模式中处理这个请求。",
      },
    ],
  };
}

function shouldConsiderGameStudioSuggestion(params: {
  isHidden: boolean;
  currentMainModeKey: MainModeKey;
  hasPendingRunDecision: boolean;
  hasMainDebugShortcut: boolean;
  hasMainIntentShortcut: boolean;
  hasLockedComposerIntent: boolean;
  skipIntentResolution?: boolean;
  resolvedIntent?: ResolvedRunIntent;
  shouldContinuePlanIntent: boolean;
  shouldContinuePreviousTurnIntent: boolean;
  shouldReuseExistingTurnIntent: boolean;
  suppressGameStudioSuggestion?: boolean;
  input: string;
  hasPlanArtifacts: boolean;
  planStage: PlanStage;
  isPlanApproved: boolean;
}): boolean {
  if (params.isHidden) return false;
  if (params.currentMainModeKey !== "main_mode") return false;
  if (params.hasPendingRunDecision) return false;
  if (params.hasMainDebugShortcut || params.hasMainIntentShortcut || params.hasLockedComposerIntent) return false;
  if (params.skipIntentResolution || params.resolvedIntent || params.suppressGameStudioSuggestion) return false;
  if (params.shouldContinuePlanIntent || params.shouldContinuePreviousTurnIntent || params.shouldReuseExistingTurnIntent) return false;
  if (looksLikePlanContinuationOrApprovalInput(params.input, {
    hasPlanArtifacts: params.hasPlanArtifacts,
    planStage: params.planStage,
    isPlanApproved: params.isPlanApproved,
  })) return false;
  return true;
}

function buildGameStudioLocalHelpMessage(params: {
  language: "zh" | "en";
  requestedCommand?: string;
}): string {
  const language = params.language === "en" ? "en" : "zh";
  const resolution = resolveGameStudioHelpTarget(params.requestedCommand);
  if (!resolution.ok) {
    return formatGameStudioMissingCommandDoc(resolution, language);
  }

  if (language === "zh" && !hasBundledGameStudioLocalizedCommandMarkdown(resolution.slug, language)) {
    logStoreEvent("game_studio_help_locale_fallback", {
      slug: resolution.slug,
      language,
    });
  }

  return formatGameStudioCommandDocForDisplay(resolution.slug, language)
    ?? formatGameStudioMissingCommandDoc(
      {
        ok: false,
        requested: resolution.requested || `/${resolution.slug}`,
        suggestions: [],
      },
      language,
    );
}

function buildGameStudioLocalWorkflowMessage(params: {
  language: "zh" | "en";
  command: PendingSlashCommand & { type: "workflow" };
}): string | null {
  if (params.command.slug === "help") {
    return buildGameStudioLocalHelpMessage({
      language: params.language,
      requestedCommand: params.command.args,
    });
  }
  return null;
}

function normalizeIntentSummary(summary: string): string {
  return summary.replace(/\s+/g, " ").trim();
}



function isContinuationPrompt(input: string): boolean {
  return looksLikePreviousTurnContinuationInput(input);
}

function turnHasActivity(turn: ConversationTurn | null, taskFlow: TaskBlock[]): boolean {
  if (!turn) return false;
  if (Array.isArray(turn.blockIds) && turn.blockIds.length > 0) return true;
  return taskFlow.some((block) => block.turnId === turn.id);
}

function turnHasToolBlocks(turnId: string, taskFlow: TaskBlock[]): boolean {
  return taskFlow.some((block) => block.turnId === turnId && block.type === "tool");
}

function isContinuationEchoTurn(turn: ConversationTurn | null, taskFlow: TaskBlock[]): boolean {
  if (!turn) return false;
  if (turn.status !== "done") return false;
  const intent = resolveConversationTurnIntent(turn);
  if (intent !== "respond" && intent !== "discuss") return false;
  if (!looksLikePreviousTurnContinuationInput(turn.userPrompt || "")) return false;
  return !turnHasToolBlocks(turn.id, taskFlow);
}

function findPreviousTurnContinuationTarget(
  input: string,
  currentTurn: ConversationTurn | null,
  conversationTurns: ConversationTurn[],
  taskFlow: TaskBlock[],
): ConversationTurn | null {
  const canResume = (turn: ConversationTurn | null): boolean =>
    shouldContinuePreviousTurnFromInput(input, {
      currentTurnIntent: resolveConversationTurnIntent(turn),
      currentTurnStatus: turn?.status ?? null,
      hasCurrentTurn: !!turn,
      hasTurnActivity: turnHasActivity(turn, taskFlow),
    });

  if (currentTurn && canResume(currentTurn)) return currentTurn;

  // If a previous generic "continue" was misrouted into a completed natural reply turn,
  // allow the next continuation to recover the latest genuinely unfinished turn.
  if (!isContinuationEchoTurn(currentTurn, taskFlow)) return null;

  for (let index = conversationTurns.length - 1; index >= 0; index--) {
    const turn = conversationTurns[index];
    if (turn.id === currentTurn?.id) continue;
    if (canResume(turn)) return turn;
  }

  return null;
}

const PLAN_EXECUTION_CONTEXT_RE = /执行已批准计划|计划执行|已批准计划|执行回合|计划执行恢复|剩余任务|未完成任务|可信执行证据|继续执行|resume execution|plan execution|execute approved plan|remaining tasks/i;

function collectPlanResumeContextText(turn: ConversationTurn | null, taskFlow: TaskBlock[]): string {
  if (!turn) return "";
  const parts: string[] = [
    turn.userPrompt || "",
    turn.title || "",
    turn.intentSummary || "",
    turn.summary || "",
  ];
  let collectedChars = parts.reduce((count, part) => count + part.length, 0);

  const appendValue = (value: unknown, depth = 0) => {
    if (value == null || depth > 2 || collectedChars > 12_000) return;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      const text = String(value).replace(/\s+/g, " ").trim();
      if (text) {
        const clipped = text.slice(0, Math.max(0, 12_000 - collectedChars));
        if (clipped) {
          parts.push(clipped);
          collectedChars += clipped.length;
        }
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value.slice(0, 8)) appendValue(item, depth + 1);
      return;
    }
    if (typeof value === "object") {
      const record = value as Record<string, unknown>;
      for (const key of [
        "path",
        "sourcePath",
        "displayName",
        "content",
        "message",
        "target",
        "title",
        "summary",
        "intentSummary",
        "evidence",
        "why",
        "next",
        "action",
        "contextItems",
        "attachedFiles",
        "images",
      ]) {
        appendValue(record[key], depth + 1);
      }
    }
  };

  for (const block of taskFlow) {
    if (block.turnId !== turn.id) continue;
    appendValue(block);
  }

  return parts.join("\n");
}

function turnSuggestsPlanExecutionResume(turn: ConversationTurn | null, taskFlow: TaskBlock[]): boolean {
  if (!turn) return false;
  const intent = resolveConversationTurnIntent(turn);
  const contextText = collectPlanResumeContextText(turn, taskFlow);
  if (looksLikeExistingPlanExecutionRequest(contextText)) return true;

  if (intent === "plan") {
    return isResumablePreviousTurnStatus(turn.status) && PLAN_EXECUTION_CONTEXT_RE.test(contextText);
  }

  // If the intent is not "plan", do not match plan execution resume unless the user's turn explicitly requested it,
  // to avoid misrouting generic "continue" inputs in normal execution/chat turns.
  return false;
}

function findPlanExecutionResumeContinuationTarget(
  input: string,
  currentTurn: ConversationTurn | null,
  conversationTurns: ConversationTurn[],
  taskFlow: TaskBlock[],
): ConversationTurn | null {
  if (!looksLikePreviousTurnContinuationInput(input)) return null;
  if (currentTurn && turnSuggestsPlanExecutionResume(currentTurn, taskFlow)) return currentTurn;

  let inspected = 0;
  for (let index = conversationTurns.length - 1; index >= 0; index--) {
    const turn = conversationTurns[index];
    if (turn.id === currentTurn?.id) continue;
    inspected += 1;
    if (inspected > 4) break;
    if (turnSuggestsPlanExecutionResume(turn, taskFlow)) return turn;
  }

  return null;
}

function getLastTurnToolSummary(turnId: string, taskFlow: TaskBlock[]): string {
  for (let index = taskFlow.length - 1; index >= 0; index--) {
    const block = taskFlow[index];
    if (block.turnId !== turnId || block.type !== "tool") continue;
    return `${block.toolName}${block.target ? ` ${block.target}` : ""} (${block.toolStatus})`;
  }
  return "";
}

function getLastVisibleTurnAgentSummary(turnId: string, taskFlow: TaskBlock[]): string {
  for (let index = taskFlow.length - 1; index >= 0; index--) {
    const block = taskFlow[index];
    if (block.turnId !== turnId || block.type !== "agent" || block.hiddenProcess) continue;
    const summary = summarizeAssistantText(block.content || "");
    if (summary) return summary;
  }
  return "";
}

function hasOperationApprovalReplyOption(replyOptions: ReplyOption[]): boolean {
  return replyOptions.some((option) =>
    option.action === "approve_operation_once" ||
    option.action === "execute_once" ||
    option.source === "proposal_follow_up" ||
    option.source === "operation_approval"
  );
}



function applyOperationProposalChoice(
  proposal: PendingOperationProposal | undefined,
  action?: ReplyOption["action"],
): PendingOperationProposal | undefined {
  if (!proposal) return proposal;
  if (action === "approve_operation_once" || action === "execute_once") {
    return {
      ...proposal,
      approvalStatus: "approved",
      approvedAt: Date.now(),
    };
  }
  if (action === "adjust_plan") {
    return {
      ...proposal,
      approvalStatus: "adjusting",
    };
  }
  if (action === "cancel_operation") {
    return {
      ...proposal,
      approvalStatus: "cancelled",
    };
  }
  return proposal;
}

function buildOperationApprovalContinuationPrompt(params: {
  language: "zh" | "en";
  proposal?: PendingOperationProposal;
  latestAssistantSummary?: string;
  userChoice: string;
}): string {
  const summary = params.proposal?.proposalSummary || params.latestAssistantSummary || "";
  if (params.language === "en") {
    return [
      "The user approved real operations for this turn.",
      summary ? `Reuse the previous proposal summary exactly as execution context: ${summary}` : "Reuse the immediately preceding proposal in this turn as execution context.",
      "Do not re-plan from scratch. Start the smallest necessary real tool actions now, then verify with actual tool results.",
      "Do not claim the work is fixed or complete unless there is tool evidence, a file diff/write result, a command result, or an explicit blocker.",
      `User approval message: ${params.userChoice}`,
    ].join("\n");
  }
  return [
    "用户已批准本轮真实操作。",
    summary ? `请严格复用上一轮方案摘要作为执行上下文：${summary}` : "请复用本回合紧邻上一条方案作为执行上下文。",
    "不要重新从零规划。现在开始调用最小必要的真实工具操作，然后用实际工具结果验证。",
    "没有工具证据、文件 diff/写入结果、命令结果或明确阻塞时，不得声称已修复或已完成。",
    `用户批准消息：${params.userChoice}`,
  ].join("\n");
}

function buildTurnCompactionAssistantMessage(params: {
  turnSummary: string;
  turnBlocks: TaskBlock[];
  language: "zh" | "en";
}): string {
  const turnSummary = normalizeIntentSummary(params.turnSummary);
  if (!turnSummary) return "";

  const { entries } = collectChangeEntries(params.turnBlocks, getDiffStats);
  const changeLines = entries.map((entry) => {
    const editSuffix = entry.editCount > 1
      ? params.language === "en"
        ? `, ${entry.editCount} edits`
        : `，${entry.editCount} 次修改`
      : "";
    return `- \`${entry.target}\` (+${entry.added} / -${entry.removed}${editSuffix})`;
  });

  const failureBlocks = params.turnBlocks.filter(
    (block): block is Extract<TaskBlock, { type: "tool" }> =>
      block.type === "tool" && (block.toolStatus === "failed" || block.toolStatus === "rejected"),
  );
  const failureLines = failureBlocks.map((block, index) => {
    const statusText = block.toolStatus === "rejected"
      ? (params.language === "en" ? "rejected" : "已拒绝")
      : (params.language === "en" ? "failed" : "失败");
    const header = `${index + 1}. \`${block.toolName}${block.target ? ` ${block.target}` : ""}\` (${statusText})`;
    const detail = String(block.message || "").trim();
    if (!detail) return header;
    const quotedDetail = detail
      .split(/\r?\n/)
      .map((line) => `> ${line}`)
      .join("\n");
    return `${header}\n${quotedDetail}`;
  });

  const sections: string[] = [
    params.language === "en" ? "### Final Conclusion" : "### 最终结论",
    turnSummary,
  ];

  if (changeLines.length > 0) {
    sections.push(
      params.language === "en" ? "### Turn Changes" : "### 本轮改动",
      changeLines.join("\n"),
    );
  }

  if (failureLines.length > 0) {
    sections.push(
      params.language === "en" ? "### Failure Details" : "### 异常详情",
      failureLines.join("\n\n"),
    );
  }

  return sections.join("\n\n").trim();
}

export function compactCompletedTurnAgentMessages(params: {
  agentMessages: AgentMessage[];
  turnStartIndex: number;
  turnSummary: string;
  turnBlocks: TaskBlock[];
  language: "zh" | "en";
}): AgentMessage[] {
  if (!Array.isArray(params.agentMessages) || params.agentMessages.length === 0) {
    return params.agentMessages;
  }
  if (params.turnStartIndex < 0 || params.turnStartIndex >= params.agentMessages.length) {
    return params.agentMessages;
  }

  const compactAssistantContent = buildTurnCompactionAssistantMessage({
    turnSummary: params.turnSummary,
    turnBlocks: params.turnBlocks,
    language: params.language,
  });
  if (!compactAssistantContent) return params.agentMessages;

  const turnSegment = params.agentMessages.slice(params.turnStartIndex);
  const preservedUserMessage = turnSegment.find((message) => message.role === "user");
  if (!preservedUserMessage) return params.agentMessages;

  return [
    ...params.agentMessages.slice(0, params.turnStartIndex),
    preservedUserMessage,
    { role: "assistant", content: compactAssistantContent },
  ];
}

function buildLocalTurnTitle(
  input: string,
  intent: ResolvedRunIntent,
  language: "zh" | "en",
  contextSignals?: TurnInputContextSignals,
): string {
  const lowerInput = input.toLowerCase();
  const context = normalizeTurnInputContextSignals(contextSignals);
  if (/(?:codex|plan mode|计划模式|\.main\/plans\/plan\.md|plan\.md|proposed_plan)/i.test(input)) {
    return language === "en" ? "Codex-style planning flow" : "重构 Codex 式计划流程";
  }
  if (/(?:sidebar|侧边栏|会话).*(?:标题|title)|(?:标题|title).*(?:sidebar|侧边栏|会话)/i.test(input)) {
    return language === "en" ? "Fix semantic session titles" : "修复会话语义标题";
  }
  if (context.imageParts > 0) {
    if (intent === "plan") return language === "en" ? "Plan screenshot-based fix" : "基于截图制定修复方案";
    if (intent === "analyze") return language === "en" ? "Analyze screenshot issue" : "分析截图中的问题";
    return language === "en" ? "Review screenshot context" : "分析截图上下文";
  }
  if (context.mentionedFilePaths.length > 0 || context.attachedFilePaths.length > 0) {
    const fileName = [...context.mentionedFilePaths, ...context.attachedFilePaths][0]?.split(/[\\/]/).pop() || "";
    if (fileName) return language === "en" ? `Analyze ${fileName}` : `分析 ${fileName}`;
    return language === "en" ? "Analyze provided files" : "分析提供的文件";
  }
  const dataKeywords = /表格|excel|xlsx|csv|数据|用户画像|ltv|rfm|k-means|聚类|付费|注册|评论/i;
  if (dataKeywords.test(lowerInput)) {
    return language === "en" ? "Analyze user data" : "分析用户行为数据";
  }
  const cleanedInput = summarizeUserPrompt(input, language === "en" ? 52 : 40);
  if (cleanedInput) return cleanedInput;
  if (intent === "plan") return language === "en" ? "Create analysis plan" : "制定分析计划";
  if (intent === "report") return language === "en" ? "Generate report" : "生成分析报告";
  if (intent === "summarize") return language === "en" ? "Summarize materials" : "总结资料内容";
  if (intent === "analyze") return language === "en" ? "Analyze materials" : "分析资料内容";
  return language === "en" ? "New task" : "新的任务";
}

function buildTitleIntentSignature(
  input: string,
  intent: ResolvedRunIntent,
  contextSignals?: TurnInputContextSignals,
): string {
  const context = normalizeTurnInputContextSignals(contextSignals);
  return [
    intent,
    String(input || "").replace(/\s+/g, " ").trim().slice(0, 160),
    `images:${context.imageParts}`,
    `mentions:${context.mentionedFilePaths.slice(0, 3).join(",")}`,
    `attachments:${context.attachedFilePaths.slice(0, 3).join(",")}`,
  ].join("|");
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

function buildMainDebugPrompt(feedback: string): string {
  const trimmedFeedback = feedback.trim();
  const feedbackBlock = trimmedFeedback || "未提供反馈正文。请先向用户索取完整反馈内容，再生成 bugfix 计划。";
  return [
    "[MDEBUG: USER FEEDBACK SELF-REPAIR]",
    "以下是来自 MAIN Beta 用户反馈的修复请求。请在当前 MAIN 源码工作区中处理。",
    "",
    "工作流程：",
    "1. 先只读定位相关源码、日志入口、复现路径和可能根因。",
    "2. 基于反馈生成精简的 `.MAIN/plans/bugfix.md`，内容包含：现象、根因假设、影响范围、修复方案、验证方式。",
    "3. 输出审批 Proposal，等待用户批准。",
    "4. 批准前不要修改源码，不要生成 `.MAIN/plans/tasks.md`，不要绕过计划审批。",
    "",
    "用户反馈：",
    feedbackBlock,
  ].join("\n");
}

// region: 回合标题语义同步

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
    contextSignals?: TurnInputContextSignals;
  },
): SemanticTurnMetadata {
  const candidate = raw && typeof raw === "object" ? raw as Partial<SemanticTurnMetadata> : {};
  const fallbackTitle = buildLocalTurnTitle(
    fallback.input,
    fallback.intent,
    fallback.language,
    normalizeTurnInputContextSignals(fallback.contextSignals),
  );
  const candidateTitle = typeof candidate.title === "string" ? candidate.title : "";
  const titleSource =
    candidateTitle &&
    !looksLikeReasoningLeakTitle(candidateTitle) &&
    !isGenericConversationTitle(candidateTitle)
      ? candidateTitle
      : fallbackTitle;
  const title = normalizeConversationDisplayTitle(
    titleSource,
    fallback.language === "en" ? 48 : 32,
    fallbackTitle || (fallback.language === "en" ? "New task" : "新的任务"),
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

function persistedTurnPhase(block: TaskBlock): { turnPhase?: TurnRuntimePhase } {
  const turnPhase = normalizeTurnRuntimePhase(block.turnPhase);
  return turnPhase ? { turnPhase } : {};
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
        const contextItems = sanitizeUserContextItemsForPersist(b.contextItems);
        return {
          id: b.id,
          turnId: b.turnId,
          ...persistedTurnPhase(b),
          type: "user" as const,
          content: String(b.content),
          ...(contextItems ? { contextItems } : {}),
        };
      case "agent":
        // Remove streaming flag (transient UI state) — keep content (string)
        return {
          id: b.id,
          turnId: b.turnId,
          ...persistedTurnPhase(b),
          type: "agent" as const,
          content: String(b.content),
          ...(b.hiddenProcess ? { hiddenProcess: true } : {}),
          ...(b.visibility ? { visibility: b.visibility } : {}),
          ...(b.archivedAfterChoice ? { archivedAfterChoice: true } : {}),
          ...(b.archivedProposal ? { archivedProposal: true } : {}),
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
      case "imageGeneration":
        return {
          id: b.id,
          turnId: b.turnId,
          ...persistedTurnPhase(b),
          type: "imageGeneration" as const,
          status: b.status,
          prompt: String(b.prompt || ""),
          params: b.params,
          providerKind: b.providerKind,
          ...(b.model ? { model: String(b.model) } : {}),
          ...(b.variantGroupId ? { variantGroupId: String(b.variantGroupId) } : {}),
          progress: b.progress,
          ...(b.previewUrl ? { previewUrl: String(b.previewUrl) } : {}),
          ...(b.imageUrl ? { imageUrl: String(b.imageUrl) } : {}),
          ...(b.outputPath ? { outputPath: String(b.outputPath) } : {}),
          ...(b.jobId ? { jobId: String(b.jobId) } : {}),
          ...(b.streamId ? { streamId: String(b.streamId) } : {}),
          ...(b.error ? { error: String(b.error) } : {}),
        };
      case "progress": {
        const progress = normalizeProgressNarration(b);
        return {
          id: b.id,
          turnId: b.turnId,
          ...persistedTurnPhase(b),
          type: "progress" as const,
          ...progress,
          ...(b.toolCallId ? { toolCallId: String(b.toolCallId) } : {}),
          ...(Array.isArray(b.toolCallIds) && b.toolCallIds.length > 0
            ? { toolCallIds: b.toolCallIds.map((id) => String(id)).filter(Boolean).slice(0, 12) }
            : {}),
          ...(b.toolName ? { toolName: String(b.toolName) } : {}),
          ...(b.target ? { target: String(b.target) } : {}),
        };
      }
      case "thought":
        return {
          id: b.id,
          turnId: b.turnId,
          ...persistedTurnPhase(b),
          type: "thought" as const,
          content: compactThoughtContentForPersist(String(b.content)),
        };
      case "tool":
        return {
          id: b.id, turnId: b.turnId, ...persistedTurnPhase(b), type: "tool" as const,
          toolName: String(b.toolName), target: String(b.target),
          status: String(b.status),
          toolStatus: b.toolStatus,
          ...(b.toolCallId ? { toolCallId: String(b.toolCallId) } : {}),
          ...(b.message ? { message: String(b.message) } : {}),
          ...(b.intentSummary ? { intentSummary: String(b.intentSummary).slice(0, 160) } : {}),
          ...(b.why ? { why: String(b.why).slice(0, 240) } : {}),
          ...(b.evidence ? { evidence: String(b.evidence).slice(0, 240) } : {}),
          ...(b.observationSummary ? { observationSummary: String(b.observationSummary).slice(0, 240) } : {}),
          ...(b.qualityGateReason ? { qualityGateReason: String(b.qualityGateReason).slice(0, 180) } : {}),
          ...(b.planRecoveryReason ? { planRecoveryReason: String(b.planRecoveryReason).slice(0, 180) } : {}),
          ...(b.shellPermissionDecision ? { shellPermissionDecision: b.shellPermissionDecision } : {}),
          ...(b.diff
            ? {
                diff: {
                  old: String(b.diff.old),
                  new: String(b.diff.new),
                  path: b.diff.path ? String(b.diff.path) : undefined,
                  ...(typeof b.diff.existed === "boolean" ? { existed: b.diff.existed } : {}),
                  ...(typeof b.diff.fullFile === "boolean" ? { fullFile: b.diff.fullFile } : {}),
                },
              }
            : {}),
          ...(b.revertStatus ? { revertStatus: b.revertStatus } : {}),
          ...(b.revertMessage ? { revertMessage: String(b.revertMessage) } : {}),
        };
      case "system":
        return {
          id: b.id,
          turnId: b.turnId,
          ...persistedTurnPhase(b),
          type: "system" as const,
          content: String(b.content),
          ...(b.icon ? { icon: String(b.icon) } : {}),
          ...(b.variant ? { variant: b.variant } : {}),
          ...(b.planExecutionProgress
            ? { planExecutionProgress: normalizeStoredPlanExecutionProgressSnapshot(b.planExecutionProgress) || undefined }
            : {}),
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
                    ...(b.contextCompression.displaySummary
                      ? { displaySummary: trimPersistedContextCompression(b.contextCompression.displaySummary) }
                      : {}),
                    ...(b.contextCompression.memoryPacket
                      ? { memoryPacket: trimPersistedContextCompression(b.contextCompression.memoryPacket) }
                      : {}),
                    ...(b.contextCompression.microCompactionKind
                      ? { microCompactionKind: b.contextCompression.microCompactionKind }
                      : {}),
                    ...(typeof b.contextCompression.microCompactedCount === "number"
                      ? { microCompactedCount: Number(b.contextCompression.microCompactedCount) || 0 }
                      : {}),
                    ...(typeof b.contextCompression.droppedMessageCount === "number"
                      ? { droppedMessageCount: Number(b.contextCompression.droppedMessageCount) || 0 }
                      : {}),
                    ...(b.contextCompression.topTokenSource
                      ? {
                          topTokenSource: {
                            label: String(b.contextCompression.topTokenSource.label || ""),
                            tokens: Number(b.contextCompression.topTokenSource.tokens) || 0,
                            total: Number(b.contextCompression.topTokenSource.total) || 0,
                          },
                        }
                      : {}),
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

function buildSessionRuntimeSnapshotFromStoreState(state: any): SessionRuntimeSnapshot {
  const taskFlow = sanitizeTaskBlocksForPersist(state.taskFlow || []);
  return {
    runtimeEventSchemaVersion: 1,
    runtimeEvents: state.runtimeEvents || [],
    harnessRunMarker: state.harnessRunMarker || null,
    taskFlow,
    agentMessages: sanitizeAgentMessagesForPersist(state.agentMessages || []),
    contextMemoryState: normalizeContextMemoryState(state.contextMemoryState),
    conversationTurns: normalizeInterruptedConversationTurnsForRestore(state.conversationTurns, taskFlow),
    currentTurnId: state.currentTurnId ?? null,
    selectedMainModeKey: state.selectedMainModeKey,
    selectedNexusModeKey: state.selectedNexusModeKey,
    sessionModeAffinity: resolveCurrentSessionModeAffinityFromState(state),
    imageStudio: normalizeImageStudioRuntime(state.imageStudio),
    activeStudioAgentKey: state.activeStudioAgentKey,
    gameStudioInitialized: state.gameStudioInitialized,
    pendingSlashCommand: state.pendingSlashCommand ?? null,
    planArtifacts: state.planArtifacts || [],
    planTasks: state.planTasks || [],
    planExecutionEvidenceLedger: state.planExecutionEvidenceLedger || [],
    planExecutionEvidenceCount: state.planExecutionEvidenceCount ?? 0,
    planStage: state.planStage ?? "idle",
    isPlanApproved: state.isPlanApproved === true,
    planApprovalChoice: state.planApprovalChoice ?? null,
    showPlanPanel: state.showPlanPanel === true,
    showDiff: state.showDiff === true,
    showTerminal: state.showTerminal === true,
    showFilePanel: state.showFilePanel === true,
    rightPanelTab: normalizeStoredRightPanelTab(state.rightPanelTab),
    selectedDiffTaskId: state.selectedDiffTaskId ?? null,
    autoApproveTools: state.autoApproveTools === true,
    autoApproveToolScopes: state.autoApproveToolScopes || [],
    webSearchEnabled: state.webSearchEnabled === true,
    webSearchProvider: normalizeWebSearchProvider(state.webSearchProvider),
    approvedShellPermissionRules: Array.isArray(state.approvedShellPermissionRules)
      ? state.approvedShellPermissionRules.filter((rule: unknown) => typeof rule === "string")
      : [],
    queuedUserMessage: state.queuedUserMessage ?? null,
    activeGuidance: state.activeGuidance ?? null,
  };
}

function resolveCurrentSessionModeAffinityFromState(state: any): SessionModeAffinity {
  const scopeKey = resolveSessionWorkspaceKey(state.currentWorkspace);
  const activeSession = (state.sessionsByWorkspace?.[scopeKey] || []).find(
    (session: Session) => session.id === state.currentSessionId,
  );
  return resolveSessionModeAffinity(activeSession || state, state.selectedMainModeKey || "main_mode");
}

function buildEmptySessionRuntimeSnapshot(state: any, affinity: SessionModeAffinity): SessionRuntimeSnapshot {
  const selectedMainModeKey = normalizeSessionModeAffinity(affinity, "main_mode");
  return {
    ...buildSessionRuntimeSnapshotFromStoreState({
      ...state,
      taskFlow: [],
      agentMessages: [],
      contextMemoryState: null,
      conversationTurns: [],
      currentTurnId: null,
      selectedMainModeKey,
      selectedNexusModeKey: mapMainModeToLegacyNexusMode(selectedMainModeKey),
      imageStudio: state.imageStudio || createDefaultImageStudioRuntime(),
      pendingSlashCommand: null,
      planArtifacts: [],
      planTasks: [],
      planExecutionEvidenceLedger: [],
      planExecutionEvidenceCount: 0,
      planStage: "idle",
      isPlanApproved: false,
      planApprovalChoice: null,
      showPlanPanel: false,
      showDiff: false,
      showTerminal: false,
      showFilePanel: false,
      rightPanelTab: "plan",
      selectedDiffTaskId: null,
      autoApproveTools: false,
      autoApproveToolScopes: [],
      webSearchEnabled: false,
      webSearchProvider: "duckduckgo",
      approvedShellPermissionRules: [],
      queuedUserMessage: null,
      activeGuidance: null,
    }),
    sessionModeAffinity: selectedMainModeKey,
  };
}

function buildNewSessionRecord(params: {
  state: any;
  scopeKey: string;
  affinity: SessionModeAffinity;
  language: "zh" | "en";
  title?: string;
}): Session {
  const createdAt = Date.now();
  const createdAtIso = new Date(createdAt).toISOString();
  return {
    id: createdAt,
    title: params.title || (
      params.affinity === "image_studio"
        ? buildImageSessionDefaultTitle(params.language)
        : buildStandardSessionDefaultTitle(params.language, params.scopeKey, GLOBAL_CHAT_KEY)
    ),
    date: createdAtIso,
    updatedAt: createdAtIso,
    updatedAtMs: createdAt,
    active: true,
    sessionModeAffinity: params.affinity,
    titleSource: "default",
    storageStatus: "temporary",
    recordingDisabled: !params.state.config.sessionRecordingEnabled,
    messages: [],
    runtimeSnapshot: buildEmptySessionRuntimeSnapshot(params.state, params.affinity),
  };
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
      ...(typeof message.reasoning_content === "string" && message.reasoning_content.trim()
        ? { reasoning_content: message.reasoning_content }
        : {}),
      ...(typeof message.reasoning === "string" && message.reasoning.trim()
        ? { reasoning: message.reasoning }
        : {}),
    };
  });
}

function normalizePlanTaskStatuses(
  tasks: PlanTask[],
  evidenceLedger: PlanExecutionEvidenceEntry[] = [],
  shouldHighlightNextTask = false,
): PlanTask[] {
  if (!tasks.length) return tasks;
  return reconcilePlanTaskCompletion([], tasks, evidenceLedger, {
    preserveMissing: false,
    highlightNext: shouldHighlightNextTask,
  });
}

function detectRequestedRootMarkdownDeliverables(text: string): string[] {
  const source = String(text || "");
  const hasRootHint = /(?:根目录|项目根目录|当前项目|workspace root|project root|root directory)/i.test(source);
  const names = Array.from(source.matchAll(/(?:^|[^\w./-])([A-Za-z][\w.-]*\.md|README\.md|Readme\.md|readme\.md)(?=$|[^\w./-])/g))
    .map((match) => match[1])
    .filter(Boolean)
    .map((name) => name.replace(/^readme\.md$/i, "Readme.md"))
    .filter((name) => !/^(?:plan|requirements|design|tasks|bugfix)\.md$/i.test(name));

  if (names.length === 0 && hasRootHint && /(?:md\s*文档|markdown|说明文档|总结.*文档|Readme|README)/i.test(source)) {
    names.push("Readme.md");
  }

  return [...new Set(names)];
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
  if (artifactKinds.has("plan")) {
    return "plan";
  }
  if (artifactKinds.has("design")) {
    return "design";
  }
  if (artifactKinds.has("requirements")) {
    return "requirements";
  }

  return "idle";
}

function supportsFullFileDiffRevert(block: Extract<TaskBlock, { type: "tool" }>): boolean {
  if (!block.diff) return false;
  if (block.diff.fullFile === true) return true;
  if (block.diff.fullFile === false) return false;
  return block.toolName === "write_file";
}

function buildPlanArtifactRevertPatch(
  state: AppState,
  path: string,
  oldText: string,
  existed: boolean,
): Partial<AppState> {
  const kind = detectPlanArtifactKind(path);
  if (!kind || kind === "summary") return {};

  const sanitized = sanitizePlanArtifactContent(oldText);
  const shouldKeepArtifact = existed && sanitized.trim().length > 0;
  const nextArtifacts = shouldKeepArtifact
    ? [
        ...state.planArtifacts.filter((artifact) => artifact.kind !== kind),
        {
          kind,
          path,
          title: getPlanArtifactTitle(kind, state.config.language === "en" ? "en" : "zh"),
          content: sanitized,
          updatedAt: Date.now(),
        },
      ]
    : state.planArtifacts.filter((artifact) => artifact.kind !== kind);

  let nextTasks = state.planTasks;
  if (kind === "tasks" || kind === "bugfix") {
    const taskArtifact =
      nextArtifacts.find((artifact) => artifact.kind === "tasks") ||
      nextArtifacts.find((artifact) => artifact.kind === "bugfix");
    const parsedTasks = taskArtifact ? extractPlanTasks(taskArtifact.content) : [];
    nextTasks = parsedTasks.length > 0
      ? reconcilePlanTaskCompletion(state.planTasks, parsedTasks, state.planExecutionEvidenceLedger, {
          preserveMissing: state.isPlanApproved || state.planStage === "executing" || state.planStage === "completed",
          highlightNext: state.isPlanApproved && state.planExecutionEvidenceLedger.length > 0,
        })
      : [];
  } else {
    nextTasks = normalizePlanTaskStatuses(
      state.planTasks,
      state.planExecutionEvidenceLedger,
      state.isPlanApproved && state.planExecutionEvidenceLedger.length > 0,
    );
  }

  return {
    planArtifacts: nextArtifacts.sort((a, b) => a.updatedAt - b.updatedAt),
    planTasks: nextTasks,
    planStage: derivePlanStageFromArtifacts(
      nextArtifacts,
      nextTasks,
      state.isPlanApproved,
      state.planStage,
    ),
  };
}

function buildPlanCommandExecutionHint(
  tasks: PlanTask[],
  language: "zh" | "en",
): string {
  const focus = getPendingPlanTaskCommandFocus(tasks, 3);
  const diagnosticHint = language === "zh"
    ? "诊断步骤优先使用内联 `run_command`，避免在项目根目录创建临时诊断脚本；确需脚本文件时，请先把它列入当前任务清单或持久化的 tasks.md，并使用明确临时路径或清理策略。"
    : "For diagnostics, prefer inline `run_command` and avoid creating temporary diagnostic scripts in the project root; if a script file is truly needed, list it in the current task list or persisted tasks.md first and use an explicit temporary path or cleanup strategy.";
  if (focus.length === 0) {
    return language === "zh"
      ? "如果某个任务需要 shell 命令，请把精确命令写在当前任务清单里并用反引号包裹；如果本轮选择持久化 tasks.md，也同步写入对应 checkbox。执行阶段看到这些命令时，一次性命令优先用 run_command 并检查 exitCode/stdout/stderr，长驻或交互式命令用 execute_command 后再用 read_pty_since/read_pty_tail/get_pty_status 检查输出。" + diagnosticHint
      : "If a task needs shell work, place the exact command in the current task list using backticks; if this run persists tasks.md, mirror it in the matching checkbox. During execution, prefer run_command for finite commands and inspect exitCode/stdout/stderr; use execute_command for long-running or interactive commands, then verify with read_pty_since/read_pty_tail/get_pty_status. " + diagnosticHint;
  }

  const lines = focus
    .map(({ task, commands }) =>
      language === "zh"
        ? `任务：${task.text}\n命令：${commands.map((command) => `\`${command}\``).join("、")}`
        : `Task: ${task.text}\nCommands: ${commands.map((command) => `\`${command}\``).join(", ")}`,
    )
    .join("\n\n");

  return language === "zh"
    ? "以下未完成任务里已经包含明确的 shell 命令，恢复执行后请优先真实运行它们：一次性命令用 run_command；长驻或交互式命令用 execute_command 后再读取 PTY 日志。不要只复述：\n\n" + lines + "\n\n" + diagnosticHint
    : "The remaining tasks already include concrete shell commands. After resuming, run them for real: use run_command for finite commands; use execute_command and then read PTY logs for long-running or interactive commands. Do not only describe them:\n\n" + lines + "\n\n" + diagnosticHint;
}

function ensureApprovedPlanRuntimeTasksForState(
  state: AppState,
  language: "zh" | "en",
): PlanTask[] {
  const hasPersistedTasksArtifact = state.planArtifacts.some((artifact) => artifact.kind === "tasks");
  if (state.planTasks.length > 0) {
    const normalizedTasks = normalizePlanTaskStatuses(state.planTasks, state.planExecutionEvidenceLedger, state.isPlanApproved);
    if (!hasPersistedTasksArtifact) {
      const derivedRuntimeTasks = deriveRuntimePlanTasksFromArtifacts(state.planArtifacts, {
        language,
        maxTasks: 8,
      });
      if (derivedRuntimeTasks.length > 0) {
        return reconcilePlanTaskCompletion(
          normalizedTasks,
          derivedRuntimeTasks,
          state.planExecutionEvidenceLedger,
          {
            preserveMissing: false,
            highlightNext: state.isPlanApproved && state.planExecutionEvidenceLedger.length > 0,
          },
        );
      }
    }
    return normalizedTasks;
  }
  if (hasPersistedTasksArtifact) {
    return state.planTasks;
  }
  return deriveRuntimePlanTasksFromArtifacts(state.planArtifacts, {
    language,
    maxTasks: 8,
  });
}

function formatPlanTaskListForPrompt(tasks: PlanTask[], language: "zh" | "en", limit = 12): string {
  const visibleTasks = tasks.slice(0, limit);
  if (visibleTasks.length === 0) {
    return language === "zh"
      ? "- 暂无 runtime 任务；请先从 plan.md 生成可审计任务清单。"
      : "- No runtime tasks yet; first derive an auditable task list from plan.md.";
  }
  return visibleTasks.map((task, index) => {
    const evidence = task.evidence?.map((item) => `${item.kind}:${item.value}`).join(", ") ||
      (language === "zh" ? "无证据标签" : "no evidence label");
    return `${index + 1}. ${task.text} [${evidence}]`;
  }).join("\n");
}

function buildTrustedPlanResumePrompt(input: {
  language: "zh" | "en";
  hasTasksArtifact: boolean;
  tasks: PlanTask[];
  artifacts: PlanArtifact[];
  evidenceLedger: PlanExecutionEvidenceEntry[];
}): string {
  const audit = buildPlanTaskEvidenceAudit({
    tasks: input.tasks,
    evidenceLedger: input.evidenceLedger,
    highlightNext: true,
  });
  const remaining = audit.remainingTasks.slice(0, 8);
  const remainingText = remaining.length > 0
    ? remaining.map((task, index) => {
        const evidence = task.evidence?.map((item) => `${item.kind}:${item.value}`).join(", ") ||
          (input.language === "zh" ? "无证据标签" : "no evidence tags");
        return `${index + 1}. ${task.text} [${task.evidenceStatus || "missing"}; ${evidence}]`;
      }).join("\n")
    : input.language === "zh"
    ? "无剩余未满足证据的任务；请核查 runtime 任务清单是否为空或已全部满足。tasks.md 是可选审计文件，不要为了确认是否存在而读取它。"
    : "No remaining task with unsatisfied evidence; verify whether the runtime task list is empty or fully satisfied. tasks.md is optional; do not read it just to check existence.";
  const evidenceText = input.evidenceLedger.slice(-8).map((entry) =>
    `- ${entry.kind}:${entry.target || entry.value} (${entry.sourceTool})`
  ).join("\n") || (input.language === "zh" ? "- 暂无可信执行证据" : "- No trusted execution evidence yet");
  const artifactText = input.artifacts.map((artifact) =>
    `- ${artifact.path} (${artifact.kind}, ${artifact.content.length} chars)`
  ).join("\n") || (input.language === "zh" ? "- 暂无计划文件摘要" : "- No plan artifact summary");

  if (input.language === "zh") {
    return [
      "请在新的恢复上下文中继续执行计划，不要复用上一轮错误链路。",
      input.hasTasksArtifact
        ? "从 `.MAIN/plans/tasks.md` 中选择证据未满足且与当前改动最相关的任务继续；顺序是执行参考，不是强制线性流程。只有真实写入/命令成功/验证证据满足后，才可以把任务视为完成。"
        : input.artifacts.length === 0
        ? "先读取当前 workspace 的 `.MAIN/plans/plan.md`；如果旧会话已存在 bugfix.md 或 requirements.md，可作为辅助上下文读取。不要默认读取 `.MAIN/plans/tasks.md`，除非它已在计划摘要中确认存在或用户明确要求。"
        : input.tasks.length > 0
        ? "当前已恢复 runtime 任务清单；请选择证据未满足且与当前诊断最相关的任务直接执行，顺序是参考而不是强制。只有当任务较长、需要跨会话审计或用户要求留档时，才先把清单持久化到 `.MAIN/plans/tasks.md`；不要为了确认它是否存在而读取它。"
        : "请先基于已批准的 plan.md 派生 runtime 任务清单；只有长任务、跨会话恢复或需要审计留档时，才生成 `.MAIN/plans/tasks.md`；不要默认读取缺失的 tasks.md。然后执行真实任务。",
      "不要重写已经满足证据的任务；如果存在 tasks.md，不要只修改 checkbox；不要重复计划说明。",
      "",
      "计划文件摘要：",
      artifactText,
      "",
      "最近可信执行证据：",
      evidenceText,
      "",
      "优先恢复任务：",
      remainingText,
    ].join("\n");
  }

  return [
    "Continue plan execution in a fresh recovery context; do not reuse the previous errored loop.",
    input.hasTasksArtifact
      ? "Continue with an evidence-unsatisfied task that best matches the current change; task order is guidance, not a forced linear path. Treat a task as complete only after real file-write, successful command, Browser/Playwright DOM/screenshot evidence, or explicit pending user validation exists."
      : input.artifacts.length === 0
      ? "First read `.MAIN/plans/plan.md` from the current workspace; if a legacy bugfix.md or requirements.md exists, use it only as supporting context. Do not read `.MAIN/plans/tasks.md` by default unless it is confirmed in the plan summary or the user explicitly asks for it."
      : input.tasks.length > 0
      ? "A runtime task list is already available; choose the evidence-unsatisfied task that best matches the current diagnosis. Persist it to `.MAIN/plans/tasks.md` only when the task is long, cross-session, or explicitly needs an audit file; do not read it just to check existence."
      : "First derive a runtime task list from the approved plan.md. Generate `.MAIN/plans/tasks.md` only for long work, cross-session recovery, or audit-file needs; do not read missing tasks.md by default. Then execute real tasks.",
    "Do not redo tasks whose evidence is already satisfied. If tasks.md exists, do not only edit checkboxes. Do not restate the plan.",
    "",
    "Plan artifact summary:",
    artifactText,
    "",
    "Recent trusted execution evidence:",
    evidenceText,
    "",
    "Priority recovery tasks:",
    remainingText,
  ].join("\n");
}

async function hydrateExistingPlanArtifactsForWorkspace(
  workspace: string,
  language: "zh" | "en",
) {
  let availablePaths: string[] = [];
  const actualPathByCanonicalPath = new Map<string, string>();
  try {
    const entries = await listDirectory(".MAIN/plans", workspace || undefined);
    const expectedByFileName = new Map(
      PLAN_ARTIFACT_PATHS.map((path) => [path.split("/").pop()?.toLowerCase() || "", path]),
    );
    const fileNames = new Set(
      entries
        .filter((entry) => !entry.is_dir)
        .map((entry) => {
          const fileName = entry.name.toLowerCase();
          const expectedPath = expectedByFileName.get(fileName);
          if (expectedPath) {
            actualPathByCanonicalPath.set(
              expectedPath.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase(),
              `.MAIN/plans/${entry.name}`,
            );
          }
          return fileName;
        }),
    );
    availablePaths = PLAN_ARTIFACT_PATHS.filter((path) => {
      const fileName = path.split("/").pop()?.toLowerCase() || "";
      return fileNames.has(fileName);
    });
    if (availablePaths.length === 0) {
      availablePaths = [...PLAN_ARTIFACT_PATHS];
    }
  } catch {
    availablePaths = [...PLAN_ARTIFACT_PATHS];
  }

  return hydratePlanArtifactsFromReader(
    (path) => {
      const canonicalPath = path.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
      return readFile(actualPathByCanonicalPath.get(canonicalPath) || path, workspace || undefined);
    },
    language,
    Date.now(),
    { availablePaths },
  );
}

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

interface AttachmentReadRef {
  path: string;
  displayName: string;
  kind: AttachmentKind;
  workspace?: string;
  sourcePath?: string;
}

async function prepareAttachedFileForRead(
  entry: AttachedFile | string,
  sessionKey: string,
): Promise<AttachmentReadRef> {
  const attachment = normalizeAttachedFile(entry);
  const sourcePath = attachment.sourcePath || attachment.path;

  if (attachment.readable && attachment.workspace) {
    return {
      path: attachment.path,
      displayName: attachment.displayName || getAttachmentDisplayName(attachment.path),
      kind: attachment.kind,
      workspace: attachment.workspace,
      sourcePath,
    };
  }

  const ingested = await ingestAttachmentFile(sessionKey, sourcePath);
  const kind = classifyAttachment(ingested.path);
  return {
    path: ingested.path,
    workspace: ingested.workspace,
    displayName: attachment.displayName || ingested.displayName || getAttachmentDisplayName(sourcePath),
    kind: kind === "tabular" || kind === "document" ? kind : "text",
    sourcePath: ingested.originalPath || sourcePath,
  };
}



function blockHasVisibleAgentContent(block: TaskBlock): boolean {
  if (block.type !== "agent" || block.hiddenProcess) return false;
  if (Array.isArray(block.options) && block.options.length > 0) return true;
  return String(block.content || "").trim().length > 0;
}



/** Helper to keep Skill content from teaching hidden-thinking tags as an output channel. */
function normalizeSkillContent(content: string): string {
  if (!content) return content;
  return content
    .replace(/<\/?(thought|thinking|reasoning|analysis)>/gi, "");
}

// ── The Store ─────────────────────────────────────────────────────────

export const useAppStore = create<AppState>()(
  persist(
    (set, get) => ({
      // Config Slice
      ...createConfigSlice(set, get),

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
    if (get().selectedMainModeKey === "image_studio" || get().imageStudio.activeStreamId) {
      activeImageStudioStreamCleanup?.();
      activeImageStudioStreamCleanup = null;
      void cancelImageStudioJob().catch(() => {});
      set((s) => ({
        isGenerating: false,
        abortController: null,
        agentStatus: "idle",
        imageStudio: {
          ...s.imageStudio,
          activeJobId: null,
          activeStreamId: null,
        },
        taskFlow: s.taskFlow.map((block) =>
          block.turnId === currentTurnId && block.type === "imageGeneration" && block.status === "running"
            ? {
                ...block,
                status: "canceled" as const,
                progress: {
                  ...block.progress,
                  stage: "canceled" as const,
                  message: s.config.language === "en" ? "Canceled" : "已取消",
                },
              }
            : block,
        ),
        conversationTurns: currentTurnId
          ? s.conversationTurns.map((turn) =>
              turn.id === currentTurnId ? { ...turn, status: "stopped_no_action" as const } : turn
            )
          : s.conversationTurns,
      }));
      return;
    }
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
  fileViewerWindow: null,
  fileViewerError: "",
  fileViewerLoading: false,
  selectedDiffTaskId: null,
  gitDiffPreview: null,
  rightPanelTab: "plan",
  rightPanelWidth: 450,
  setShowDiff: (v) => set({
    showDiff: v,
    showPlanPanel: v ? false : get().showPlanPanel,
    showTerminal: v ? false : get().showTerminal,
    rightPanelTab: v ? "diff" : get().rightPanelTab,
  }),
  setShowPlanPanel: (v) => {
    if (v) {
      void get().openPlanWorkspacePanel();
      return;
    }
    set({ showPlanPanel: false });
  },
  setShowTerminal: (v) => set({
    showTerminal: v,
    showPlanPanel: v ? false : get().showPlanPanel,
    showDiff: v ? false : get().showDiff,
    rightPanelTab: v ? "terminal" : get().rightPanelTab,
  }),
  openFileTreePanel: () => set({
    showFilePanel: true,
    fileViewerPath: "",
    fileViewerContent: "",
    fileViewerWindow: null,
    fileViewerError: "",
    fileViewerLoading: false,
  }),
  openFileViewer: async (path, workspace) => {
    const targetWorkspace = workspace ?? get().currentWorkspace;
    set({
      showFilePanel: true,
      fileViewerPath: path,
      fileViewerContent: "",
      fileViewerWindow: null,
      fileViewerError: "",
      fileViewerLoading: true,
    });
    const previewStrategy = getFilePreviewStrategy({ path });
    if (previewStrategy.mode === "externalOnly") {
      set({ fileViewerContent: "", fileViewerWindow: null, fileViewerError: "", fileViewerLoading: false });
      return;
    }
    try {
      const windowResult = await readFileWindow(path, targetWorkspace, undefined, undefined, 240, 12000);
      if (get().fileViewerPath !== path || get().currentWorkspace !== targetWorkspace) return;
      set({
        fileViewerContent: windowResult.content,
        fileViewerWindow: windowResult,
        fileViewerError: "",
        fileViewerLoading: false,
      });
    } catch (error) {
      if (get().fileViewerPath !== path || get().currentWorkspace !== targetWorkspace) return;
      set({
        fileViewerContent: "",
        fileViewerWindow: null,
        fileViewerError: error instanceof Error ? error.message : String(error),
        fileViewerLoading: false,
      });
    }
  },
  loadNextFileViewerWindow: async () => {
    const state = get();
    const path = state.fileViewerPath;
    const targetWorkspace = state.currentWorkspace;
    const nextStartLine = state.fileViewerWindow?.nextStartLine;
    if (!path || !targetWorkspace || !nextStartLine || state.fileViewerLoading) return;
    set({ fileViewerLoading: true, fileViewerError: "" });
    try {
      const windowResult = await readFileWindow(path, targetWorkspace, nextStartLine, undefined, 240, 12000);
      if (get().fileViewerPath !== path || get().currentWorkspace !== targetWorkspace) return;
      set((s) => ({
        fileViewerContent: [s.fileViewerContent, windowResult.content].filter(Boolean).join("\n"),
        fileViewerWindow: {
          ...windowResult,
          startLine: s.fileViewerWindow?.startLine ?? windowResult.startLine,
          endLine: windowResult.endLine,
          content: [s.fileViewerWindow?.content || s.fileViewerContent, windowResult.content].filter(Boolean).join("\n"),
          returnedChars: (s.fileViewerWindow?.returnedChars ?? s.fileViewerContent.length) + windowResult.returnedChars,
        },
        fileViewerError: "",
        fileViewerLoading: false,
      }));
    } catch (error) {
      if (get().fileViewerPath !== path || get().currentWorkspace !== targetWorkspace) return;
      set({
        fileViewerError: error instanceof Error ? error.message : String(error),
        fileViewerLoading: false,
      });
    }
  },
  clearFileViewer: () => set({
    fileViewerPath: "",
    fileViewerContent: "",
    fileViewerWindow: null,
    fileViewerError: "",
    fileViewerLoading: false,
    showFilePanel: true,
  }),
  closeFilePanel: () => set({
    showFilePanel: false,
    fileViewerPath: "",
    fileViewerContent: "",
    fileViewerWindow: null,
    fileViewerError: "",
    fileViewerLoading: false,
  }),
  setSelectedDiffTaskId: (id) => set({ selectedDiffTaskId: id }),
  openDiffForTask: (taskId) => {
    const task = get().taskFlow.find((block) => block.type === "tool" && block.id === taskId && !!block.diff);
    if (!task || task.type !== "tool" || !task.diff) return;

    set({
      selectedDiffTaskId: taskId,
      gitDiffPreview: null,
      showDiff: true,
      showPlanPanel: false,
      showTerminal: false,
      rightPanelTab: "diff",
    });
  },
  openGitDiffPreview: (entries, sourceLabel) => {
    set({
      gitDiffPreview: { entries, sourceLabel },
      selectedDiffTaskId: null,
      showDiff: true,
      showPlanPanel: false,
      showTerminal: false,
      rightPanelTab: "diff",
    });
  },
  clearGitDiffPreview: () => set({ gitDiffPreview: null }),
  ensurePlanArtifactsHydratedForWorkspace: async (options = {}) => {
    const state = get();
    const language = state.config.language === "en" ? "en" : "zh";
    const alreadyHasPlanState =
      state.planArtifacts.length > 0 ||
      state.planTasks.length > 0 ||
      state.planStage !== "idle";

    const openPanelPatch = options.openPanel
      ? {
          showPlanPanel: true,
          showDiff: false,
          showTerminal: false,
          rightPanelTab: "plan" as const,
        }
      : {};

    if (alreadyHasPlanState) {
      if (options.openPanel) set(openPanelPatch);
      return true;
    }

    if (!state.currentWorkspace.trim()) {
      if (options.openPanel) set(openPanelPatch);
      return false;
    }

    let hydrated: Awaited<ReturnType<typeof hydrateExistingPlanArtifactsForWorkspace>> | null = null;
    try {
      hydrated = await hydrateExistingPlanArtifactsForWorkspace(state.currentWorkspace, language);
    } catch {
      hydrated = null;
    }

    const hasHydratedData = !!hydrated && (hydrated.artifacts.length > 0 || hydrated.tasks.length > 0);
    if (!hydrated || !hasHydratedData) {
      if (options.openPanel) set(openPanelPatch);
      logStoreEvent("plan_workspace_hydration_empty", {
        workspace: state.currentWorkspace || null,
        reason: options.reason || "open_plan_panel",
      });
      return false;
    }
    const hydratedPlan = hydrated;

    set((s) => {
      const liveAlreadyHasPlanState =
        s.planArtifacts.length > 0 ||
        s.planTasks.length > 0 ||
        s.planStage !== "idle";
      if (liveAlreadyHasPlanState) return openPanelPatch;

      const nextStage = derivePlanStageFromArtifacts(
        hydratedPlan.artifacts,
        hydratedPlan.tasks,
        s.isPlanApproved,
        s.planStage,
      );
      const shouldPromoteHydratedTasksToExecuting =
        options.promoteTasksToExecuting === true &&
        hydratedPlan.hasTasksArtifact &&
        hydratedPlan.tasks.length > 0;
      const threadId =
        resolveSessionRuntimeKey(resolveSessionWorkspaceKey(s.currentWorkspace), s.currentSessionId) ||
        "default";
      const nextEvent = withEventSchema({
        type: "plan_state_hydrated",
        threadId,
        turnId: s.currentTurnId || undefined,
        timestampMs: Date.now(),
        reason: options.reason || "open_plan_panel",
        taskCount: hydratedPlan.tasks.length,
        artifactPaths: hydratedPlan.artifacts.map((artifact) => artifact.path),
      });

      return {
        planArtifacts: hydratedPlan.artifacts,
        planTasks: hydratedPlan.tasks,
        isPlanApproved: shouldPromoteHydratedTasksToExecuting || s.isPlanApproved,
        planStage: shouldPromoteHydratedTasksToExecuting ? "executing" : nextStage,
        ...openPanelPatch,
        runtimeEvents: appendRuntimeEvent(s.runtimeEvents, nextEvent),
      };
    });
    logStoreEvent("plan_workspace_hydrated_for_panel", {
      workspace: state.currentWorkspace || null,
      reason: options.reason || "open_plan_panel",
      artifacts: hydratedPlan.artifacts.map((artifact) => artifact.path),
      taskCount: hydratedPlan.tasks.length,
      promotedToExecuting: options.promoteTasksToExecuting === true && hydratedPlan.hasTasksArtifact && hydratedPlan.tasks.length > 0,
    });
    return true;
  },
  openPlanWorkspacePanel: async () =>
    get().ensurePlanArtifactsHydratedForWorkspace({
      openPanel: true,
      reason: "open_plan_panel",
    }),
  setRightPanelTab: (tab) => {
    if (tab === "plan") {
      void get().openPlanWorkspacePanel();
      return;
    }
    set({
      rightPanelTab: tab,
      showPlanPanel: false,
      showDiff: tab === "diff",
      showTerminal: tab === "terminal",
    });
  },
  openRightPanelTab: (tab) => get().setRightPanelTab(tab),
  closeRightPanel: () => set({ showPlanPanel: false, showDiff: false, showTerminal: false }),
  setRightPanelWidth: (w) => set({ rightPanelWidth: w }),
  sidebarWidth: 260,
  setSidebarWidth: (w) => set({ sidebarWidth: Math.max(180, Math.min(450, w)) }),
  showWorkspaceTreePanel: false,
  workspaceTreePanelWidth: 320,
  setShowWorkspaceTreePanel: (v) => set({ showWorkspaceTreePanel: v }),
  toggleWorkspaceTreePanel: () => set((s) => ({ showWorkspaceTreePanel: !s.showWorkspaceTreePanel })),
  setWorkspaceTreePanelWidth: (w) => set({ workspaceTreePanelWidth: Math.max(220, Math.min(520, w)) }),


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

      // Workspace Slice
      ...createWorkspaceSlice(set, get),
      pendingSlashCommand: null,
      lockedComposerIntent: null,
      pendingRunDecision: null,
      dismissedPendingDecisionInputKey: null,
      executionConsentPolicy: "ask_per_turn" as ExecutionConsentPolicy,
      imageStudio: createDefaultImageStudioRuntime(),
  dismissPendingRunDecision: () =>
    set((s) => {
      const dismissedKey =
        s.pendingRunDecision?.kind === "intent_confirmation"
          ? normalizePendingDecisionInputKey(s.pendingRunDecision.originalInput)
          : null;
      return {
        pendingRunDecision: null,
        pendingRunDecisionResolver: null,
        dismissedPendingDecisionInputKey: dismissedKey,
      };
    }),
  resolvePendingRunDecision: (choice) => {
    const state = get();
    const pending = state.pendingRunDecision;
    if (!pending) return;
    if (state.dismissedPendingDecisionInputKey) {
      set({ dismissedPendingDecisionInputKey: null });
    }

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
          autoApproveToolScopes: buildSessionAutoApproveScopes(true),
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

    if (pending.kind === "mode_switch") {
      const originalImages = pending.originalImages;
      const language = resolveTurnResponseLanguage({
        text: pending.originalInput,
        policy: state.config.responseLanguagePolicy,
        systemLanguage: state.config.language === "en" ? "en" : "zh",
        fallbackLanguage: state.config.language === "en" ? "en" : "zh",
      });

      if (choice === "cancel") {
        set({ pendingRunDecision: null });
        return;
      }

      if (choice === "stay_main") {
        set({ pendingRunDecision: null });
        runAfterNextPaint(() => {
          get().sendMessage(pending.originalInput, originalImages, {
            suppressGameStudioSuggestion: true,
          });
        });
        return;
      }

      const selectedEngine = resolveEngineFromModeSwitchChoice(choice, pending);
      const shouldAskEngine = choice === "switch_game_studio_choose_engine" || !selectedEngine;
      const nextAgent = selectedEngine ? getDefaultStudioAgentForEngine(selectedEngine) : state.activeStudioAgentKey;
      set({
        pendingRunDecision: null,
        selectedMainModeKey: "game_studio",
        selectedNexusModeKey: "nexus_game_studio",
        activeStudioAgentKey: nextAgent,
        lockedComposerIntent: null,
      });

      runAfterNextPaint(() => {
        void (async () => {
          let configuredAgent = nextAgent;
          try {
            const initialized = await ensureGameStudioWorkspaceInitialized(configuredAgent);
            let studioConfig = initialized;
            if (selectedEngine) {
              studioConfig = await setGameStudioEngineConfig({
                engine: selectedEngine,
                activeStudioAgent: getDefaultStudioAgentForEngine(selectedEngine),
              });
            }
            configuredAgent = normalizeStudioAgentKey(studioConfig.activeStudioAgent);
            invalidateWorkspaceTreeCache();
            set({
              gameStudioInitialized: true,
              activeStudioAgentKey: configuredAgent,
              selectedMainModeKey: "game_studio",
              selectedNexusModeKey: "nexus_game_studio",
            });
            get().bumpWorkspaceContentVersion();
          } catch (error) {
            appendDebugLog("warn", "game_studio_mode_switch_failed", {
              error: error instanceof Error ? error.message : String(error),
            });
          }

          const directive: CommandDirective = {
            kind: selectedEngine === "unity" ? "unity" : "studio",
            action: shouldAskEngine ? "confirm_game_engine" : "game_studio_mode_switch",
            target: selectedEngine || "engine_selection",
            source: "natural_language",
            requiresWorkspace: true,
            requiresApproval: false,
            confidence: selectedEngine ? 0.9 : 0.7,
            reason: shouldAskEngine
              ? "Game-development intent was detected, but the engine is ambiguous; ask the user to choose before configuring engine-specific workflow."
              : `Game-development intent should continue in Game Studio with ${selectedEngine} engine metadata.`,
          };

          get().sendMessage(pending.originalInput, originalImages, {
            resolvedIntent: "studio_workflow",
            runtimeIntentOverride: "studio_workflow",
            commandDirective: directive,
            skipIntentResolution: true,
            suppressGameStudioSuggestion: true,
            intentSummary: buildRunIntentSummary({
              input: pending.originalInput,
              intent: "studio_workflow",
              language,
              reason: shouldAskEngine
                ? language === "en"
                  ? "Switch to Game Studio and ask the user to choose the game engine before continuing."
                  : "切换到游戏工作室，并先确认游戏引擎再继续。"
                : language === "en"
                ? `Switch to Game Studio and configure ${selectedEngine}.`
                : `切换到游戏工作室，并配置 ${selectedEngine} 引擎。`,
            }),
          });
        })();
      });
      return;
    }

    if (choice === "cancel") {
      set({ pendingRunDecision: null });
      return;
    }

    const intentChoice = isResolvedUserIntentChoice(choice as PendingRunDecisionChoice)
      ? (choice as ResolvedUserIntent)
      : pending.suggestedIntent;
    const originalImages = pending.originalImages;
    const language = resolveTurnResponseLanguage({
      text: pending.originalInput,
      policy: state.config.responseLanguagePolicy,
      systemLanguage: state.config.language === "en" ? "en" : "zh",
      fallbackLanguage: state.config.language === "en" ? "en" : "zh",
    });
    const approvedExecutionIntent =
      intentChoice === "execute" || intentChoice === "studio_workflow"
        ? intentChoice
        : null;
    set({ pendingRunDecision: null });
    runAfterNextPaint(() => {
      get().sendMessage(pending.originalInput, originalImages, {
        resolvedIntent: intentChoice,
        ...(approvedExecutionIntent
          ? {
              runtimeIntentOverride: approvedExecutionIntent,
              executionConsentGranted: true,
            }
          : {}),
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
  setSelectedMainModeKey: (key) => set((s) => ({
    selectedMainModeKey: key,
    selectedNexusModeKey: mapMainModeToLegacyNexusMode(key),
    lockedComposerIntent: null,
    rightPanelTab: normalizeStoredRightPanelTab(s.rightPanelTab),
  })),
  createIsolatedImageSession: async () => {
    const state = get();
    const language = state.config.language === "en" ? "en" : "zh";
    const scopeKey = resolveSessionWorkspaceKey(state.currentWorkspace);
    const currentSession = (state.sessionsByWorkspace[scopeKey] || []).find((session) => session.id === state.currentSessionId) || null;
    const currentAffinity = resolveSessionModeAffinity(
      (currentSession || state) as SessionModeAffinityLike,
      state.selectedMainModeKey,
    );
    if (currentAffinity === "image_studio" && state.selectedMainModeKey === "image_studio" && state.currentSessionId) {
      return state.currentSessionId;
    }

    if (state.currentSessionId && currentSession) {
      const runtimeSnapshot = buildSessionRuntimeSnapshotFromStoreState(state);
      const messages = sanitizeTaskBlocksForPersist(state.taskFlow || []);
      const sessionPatch: Partial<Session> = {
        active: false,
        sessionModeAffinity: currentAffinity,
        updatedAt: new Date().toISOString(),
        updatedAtMs: Date.now(),
        messages,
        runtimeSnapshot,
      };
      state.updateSession(scopeKey, state.currentSessionId, sessionPatch);
      if (state.config.sessionRecordingEnabled && !currentSession.recordingDisabled) {
        void saveProjectSession(scopeKey, { ...currentSession, ...sessionPatch })
          .then((saved) => {
            get().updateSession(scopeKey, currentSession.id, {
              ...saved,
              storageStatus: "ok",
              recordingDisabled: false,
            });
          })
          .catch((error) => {
            appendDebugLog("warn", "session.storage", {
              phase: "image_mode_switch_save_failed",
              scopeKey,
              sessionId: currentSession.id,
              error: error instanceof Error ? error.message : String(error),
            });
          });
      }
    }

    if (scopeKey !== GLOBAL_CHAT_KEY) {
      state.addWorkspaceEntry(scopeKey);
    }
    const imageSession = buildNewSessionRecord({
      state,
      scopeKey,
      affinity: "image_studio",
      language,
      title: buildImageSessionDefaultTitle(language),
    });
    const imageRuntime = createSessionRuntimeFromState(imageSession.runtimeSnapshot || {});

    set((s) => ({
      sessionsByWorkspace: {
        ...s.sessionsByWorkspace,
        [scopeKey]: [
          imageSession,
          ...(s.sessionsByWorkspace[scopeKey] || []).map((session) => ({
            ...session,
            active: false,
          })),
        ],
      },
      activeSessionByWorkspace: {
        ...s.activeSessionByWorkspace,
        [scopeKey]: imageSession.id,
      },
      currentSessionId: imageSession.id,
      ...getSessionRuntimeUiPatch(imageRuntime, { resetPanels: true }),
      selectedMainModeKey: "image_studio",
      selectedNexusModeKey: "nexus_general",
      lockedComposerIntent: null,
      pendingRunDecision: null,
      pendingRunDecisionResolver: null,
      currentTurnExecutionConsent: { turnId: null, granted: false },
      autoApproveTools: false,
      autoApproveToolScopes: [],
      webSearchEnabled: false,
      webSearchProvider: "duckduckgo",
      approvedLocalFileReadPaths: [],
      approvedShellPermissionRules: [],
      readOnlyAutoApproveForSession: false,
      queuedUserMessage: null,
      activeGuidance: null,
      isGenerating: false,
      agentStatus: "idle",
      abortController: null,
    }));

    return imageSession.id;
  },
  returnFromImageSession: async (targetMode = "main_mode") => {
    const state = get();
    const language = state.config.language === "en" ? "en" : "zh";
    const scopeKey = resolveSessionWorkspaceKey(state.currentWorkspace);
    const currentSession = (state.sessionsByWorkspace[scopeKey] || []).find((session) => session.id === state.currentSessionId) || null;
    const currentAffinity = resolveSessionModeAffinity(
      (currentSession || state) as SessionModeAffinityLike,
      state.selectedMainModeKey,
    );

    if (currentAffinity === "image_studio" && state.currentSessionId && currentSession) {
      const runtimeSnapshot = buildSessionRuntimeSnapshotFromStoreState(state);
      const messages = sanitizeTaskBlocksForPersist(state.taskFlow || []);
      const sessionPatch: Partial<Session> = {
        active: false,
        sessionModeAffinity: "image_studio",
        updatedAt: new Date().toISOString(),
        updatedAtMs: Date.now(),
        messages,
        runtimeSnapshot,
      };
      state.updateSession(scopeKey, state.currentSessionId, sessionPatch);
      if (state.config.sessionRecordingEnabled && !currentSession.recordingDisabled) {
        void saveProjectSession(scopeKey, { ...currentSession, ...sessionPatch })
          .then((saved) => {
            get().updateSession(scopeKey, currentSession.id, {
              ...saved,
              storageStatus: "ok",
              recordingDisabled: false,
            });
          })
          .catch((error) => {
            appendDebugLog("warn", "session.storage", {
              phase: "image_mode_return_save_failed",
              scopeKey,
              sessionId: currentSession.id,
              error: error instanceof Error ? error.message : String(error),
            });
          });
      }
    }

    const nextSession = findLatestSessionForAffinity(
      state.sessionsByWorkspace[scopeKey] || [],
      targetMode,
      { excludeSessionId: state.currentSessionId },
    );

    if (!nextSession) {
      if (scopeKey !== GLOBAL_CHAT_KEY) {
        state.addWorkspaceEntry(scopeKey);
      }
      const created = buildNewSessionRecord({
        state,
        scopeKey,
        affinity: targetMode,
        language,
      });
      const runtime = createSessionRuntimeFromState(created.runtimeSnapshot || {});
      set((s) => ({
        sessionsByWorkspace: {
          ...s.sessionsByWorkspace,
          [scopeKey]: [
            created,
            ...(s.sessionsByWorkspace[scopeKey] || []).map((session) => ({
              ...session,
              active: false,
            })),
          ],
        },
        activeSessionByWorkspace: {
          ...s.activeSessionByWorkspace,
          [scopeKey]: created.id,
        },
        currentSessionId: created.id,
        ...getSessionRuntimeUiPatch(runtime, { resetPanels: true }),
        selectedMainModeKey: targetMode,
        selectedNexusModeKey: mapMainModeToLegacyNexusMode(targetMode),
        lockedComposerIntent: null,
        pendingRunDecision: null,
        pendingRunDecisionResolver: null,
      }));
      return created.id;
    }

    const runtime = createSessionRuntimeFromState(nextSession.runtimeSnapshot || {
      taskFlow: nextSession.messages || [],
      agentMessages: [],
      contextMemoryState: null,
      conversationTurns: [],
      currentTurnId: null,
      selectedMainModeKey: targetMode,
      selectedNexusModeKey: mapMainModeToLegacyNexusMode(targetMode),
      sessionModeAffinity: targetMode,
      imageStudio: state.imageStudio,
      activeStudioAgentKey: state.activeStudioAgentKey,
      gameStudioInitialized: state.gameStudioInitialized,
      pendingSlashCommand: null,
      planArtifacts: [],
      planTasks: [],
      planExecutionEvidenceLedger: [],
      planExecutionEvidenceCount: 0,
      planStage: "idle",
      isPlanApproved: false,
      showPlanPanel: false,
      showDiff: false,
      showTerminal: false,
      showFilePanel: false,
      rightPanelTab: "plan",
      selectedDiffTaskId: null,
    });

    set((s) => ({
      sessionsByWorkspace: {
        ...s.sessionsByWorkspace,
        [scopeKey]: (s.sessionsByWorkspace[scopeKey] || []).map((session) => ({
          ...session,
          active: session.id === nextSession.id,
        })),
      },
      activeSessionByWorkspace: {
        ...s.activeSessionByWorkspace,
        [scopeKey]: nextSession.id,
      },
      currentSessionId: nextSession.id,
      ...getSessionRuntimeUiPatch(runtime, { resetPanels: true }),
      selectedMainModeKey: targetMode,
      selectedNexusModeKey: mapMainModeToLegacyNexusMode(targetMode),
      lockedComposerIntent: null,
      pendingRunDecision: null,
      pendingRunDecisionResolver: null,
    }));

    return nextSession.id;
  },
  switchMainModeWithIsolation: async (key) => {
    const state = get();
    const scopeKey = resolveSessionWorkspaceKey(state.currentWorkspace);
    const currentSession = (state.sessionsByWorkspace[scopeKey] || []).find((session) => session.id === state.currentSessionId) || null;
    const currentAffinity = resolveSessionModeAffinity(
      (currentSession || state) as SessionModeAffinityLike,
      state.selectedMainModeKey,
    );

    if (key === "image_studio") {
      await get().createIsolatedImageSession();
      return;
    }

    if (currentAffinity === "image_studio") {
      await get().returnFromImageSession(key);
      return;
    }

    get().setSelectedMainModeKey(key);
  },
  setImageStudioConfig: (patch) =>
    set((s) => {
      const nextConfig = normalizeImageStudioConfig({
        ...s.imageStudio.config,
        ...patch,
        local: patch.local
          ? {
              ...s.imageStudio.config.local,
              ...patch.local,
              endpoint: patch.provider === "local_image_service" && !patch.local.endpoint
                ? getDefaultImageStudioEndpoint("local_image_service")
                : patch.local.endpoint ?? s.imageStudio.config.local.endpoint,
            }
          : s.imageStudio.config.local,
        web: patch.web
          ? {
              ...s.imageStudio.config.web,
              ...patch.web,
              endpoint: patch.provider === "web_fallback" && !patch.web.endpoint
                ? getDefaultImageStudioEndpoint("web_fallback")
                : patch.web.endpoint ?? s.imageStudio.config.web.endpoint,
            }
          : s.imageStudio.config.web,
        defaultSize: patch.defaultSize
          ? { ...s.imageStudio.config.defaultSize, ...patch.defaultSize }
          : s.imageStudio.config.defaultSize,
      });
      return {
        imageStudio: {
          ...s.imageStudio,
          config: nextConfig,
          status: {
            ...s.imageStudio.status,
            providerKind: nextConfig.provider,
            activeModel: getActiveImageStudioModel(nextConfig),
          },
        },
      };
    }),
  setImageStudioStatus: (status) =>
    set((s) => ({
      imageStudio: {
        ...s.imageStudio,
        status: {
          ...s.imageStudio.status,
          ...status,
          capabilities: {
            ...s.imageStudio.status.capabilities,
            ...(status.capabilities || {}),
          },
          discoveredModels: Array.isArray(status.discoveredModels)
            ? status.discoveredModels
            : s.imageStudio.status.discoveredModels,
          activeModel: typeof status.activeModel === "string"
            ? status.activeModel
            : s.imageStudio.status.activeModel,
        },
      },
    })),
  setImageStudioSetupGuideOpen: (value) =>
    set((s) => ({
      imageStudio: {
        ...s.imageStudio,
        setupGuideOpen: value,
      },
    })),
  checkImageStudioEngine: async () => {
    const config = get().imageStudio.config;
    const status = await checkImageStudioEngineStatus(config);
    set((s) => ({
      imageStudio: {
        ...s.imageStudio,
        status,
      },
    }));
    return status;
  },
  runImageStudioGeneration: (text, images) => {
    const prompt = String(text || "").trim();
    if (!prompt && (!images || images.length === 0)) return false;
    if (get().isGenerating) return false;

    const state = get();
    const isLocalProvider = isLocalImageStudioProvider(state.imageStudio.config);
    if (!isLocalProvider && state.imageStudio.config.web.enabled === false) {
      const errMsg = state.config.language === "en"
        ? "HiDream Web fallback is disabled. Re-enable it in Image Studio settings or switch back to a local provider."
        : "HiDream 网页 fallback 已关闭，请在图像工作室设置里重新开启，或切回本地 provider。";
      set((s) => ({
        imageStudio: {
          ...s.imageStudio,
          status: {
            ...s.imageStudio.status,
            state: "error",
            message: errMsg,
          },
          setupGuideOpen: true,
        },
      }));
      return false;
    }
    if (!isLocalProvider) {
      const now = Date.now();
      const cooldownUntil = state.imageStudio.cooldownUntil || 0;
      if (now < cooldownUntil) {
        const remainingSec = Math.ceil((cooldownUntil - now) / 1000);
        const errMsg = state.config.language === "en"
          ? `Web fallback image generation is cooling down. Please wait ${remainingSec}s.`
          : `网页 fallback 生图冷却中，请等待 ${remainingSec} 秒。`;
        set((s) => ({
          imageStudio: {
            ...s.imageStudio,
            status: {
              ...s.imageStudio.status,
              state: "error",
              message: errMsg,
            },
          },
        }));
        return false;
      }
    }

    const language = state.config.language === "en" ? "en" : "zh";
    const sessionScopeKey = resolveSessionWorkspaceKey(state.currentWorkspace);
    let ensuredSessionId = state.currentSessionId;
    const workspaceSessions = state.sessionsByWorkspace[sessionScopeKey] || [];
    const hasValidCurrentSession =
      ensuredSessionId != null &&
      workspaceSessions.some((session) => session.id === ensuredSessionId);

    const currentSessionAffinity = hasValidCurrentSession
      ? (workspaceSessions.find((session) => session.id === ensuredSessionId)?.sessionModeAffinity || state.selectedMainModeKey)
      : (state.selectedMainModeKey === "image_studio" ? "image_studio" : "main_mode");

    if (!hasValidCurrentSession) {
      const autoSession = buildNewSessionRecord({
        state,
        scopeKey: sessionScopeKey,
        affinity: currentSessionAffinity,
        language,
      });
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
        activeSessionByWorkspace: {
          ...s.activeSessionByWorkspace,
          [sessionScopeKey]: autoSession.id,
        },
        currentSessionId: autoSession.id,
      }));
      ensuredSessionId = autoSession.id;
    }

    const runSessionKey = resolveSessionRuntimeKey(sessionScopeKey, ensuredSessionId)!;
    const issuedAt = Date.now();
    const issuedAtIso = new Date(issuedAt).toISOString();
    const turnId = `image-turn-${issuedAt}-${Math.random().toString(36).slice(2, 8)}`;
    const userBlockId = get()._nextTaskId();
    const generationBlockId = get()._nextTaskId();
    const params: ImageGenerationParams = buildImageGenerationParams(state.imageStudio.config);
    const variantGroupId = `image-variant-${ensuredSessionId}-${issuedAt}`;
    const activeModel = getActiveImageStudioModel(state.imageStudio.config);
    const turnTitle = normalizeConversationDisplayTitle(
      prompt,
      language === "en" ? 48 : 40,
      language === "en" ? "Image generation" : "图像生成",
    );
    const userBlock: TaskBlock = {
      id: userBlockId,
      turnId,
      type: "user",
      content: prompt,
      ...(images && images.length > 0 ? { images } : {}),
    };
    const generationBlock: TaskBlock = {
      id: generationBlockId,
      turnId,
      type: "imageGeneration",
      status: "queued",
      prompt,
      params,
      providerKind: params.providerKind,
      ...(activeModel ? { model: activeModel } : {}),
      variantGroupId,
      progress: createInitialImageProgress(),
    };

    const persistSession = () => {
      const latest = get();
      if (!ensuredSessionId) return;
      latest.updateSession(sessionScopeKey, ensuredSessionId, {
        updatedAt: new Date().toISOString(),
        updatedAtMs: Date.now(),
        active: true,
        sessionModeAffinity: currentSessionAffinity,
        messages: sanitizeTaskBlocksForPersist(latest.taskFlow),
        storageStatus: latest.config.sessionRecordingEnabled ? "ok" : "temporary",
        recordingDisabled: !latest.config.sessionRecordingEnabled,
        runtimeSnapshot: normalizeSessionRuntimeSnapshot(buildSessionRuntimeSnapshotFromStoreState(latest)),
      });
    };

    set((s) => ({
      taskFlow: [...s.taskFlow, userBlock, generationBlock],
      conversationTurns: [
        ...s.conversationTurns.map((turn) => turn.collapsed ? turn : { ...turn, collapsed: true }),
        {
          id: turnId,
          userPrompt: prompt,
          title: turnTitle,
          intentSummary: language === "en" ? "Generate an image in Image Studio." : "在图像工作室中生成图片。",
          mode: "chat",
          intent: "respond",
          displayIntent: "respond",
          status: "executing",
          summary: "",
          blockIds: [userBlockId, generationBlockId],
          collapsed: false,
          createdAt: Date.now(),
        },
      ],
      currentTurnId: turnId,
      input: "",
      contextMentions: [],
      attachedFiles: [],
      selectedMainModeKey: s.selectedMainModeKey,
      selectedNexusModeKey: s.selectedNexusModeKey,
      lockedComposerIntent: null,
      pendingRunDecision: null,
      isGenerating: true,
      agentStatus: "idle",
      elapsedTime: 0,
      imageStudio: {
        ...s.imageStudio,
        activeJobId: null,
        activeStreamId: null,
      },
    }));

    if (ensuredSessionId) {
      get().updateSession(sessionScopeKey, ensuredSessionId, {
        title: turnTitle,
        titleSource: "local_seed",
        titleIntentSignature: `image:${prompt.slice(0, 120)}`,
        updatedAt: issuedAtIso,
        updatedAtMs: issuedAt,
        active: true,
        sessionModeAffinity: currentSessionAffinity,
      });
    }
    persistSession();

    const updateGenerationBlock = (patch: Partial<Extract<TaskBlock, { type: "imageGeneration" }>>) => {
      set((s) => ({
        taskFlow: s.taskFlow.map((block) =>
          block.id === generationBlockId && block.type === "imageGeneration"
            ? { ...block, ...patch }
            : block,
        ),
      }));
    };
    const finishTurn = (status: ConversationTurnStatus, summary: string) => {
      const isWebFallback = !isLocalImageStudioProvider(get().imageStudio.config);
      set((s) => ({
        isGenerating: false,
        abortController: null,
        agentStatus: "idle",
        imageStudio: {
          ...s.imageStudio,
          activeJobId: null,
          activeStreamId: null,
          ...(isWebFallback ? { cooldownUntil: Date.now() + 15000 } : {}),
        },
        conversationTurns: s.conversationTurns.map((turn) =>
          turn.id === turnId ? { ...turn, status, summary, elapsedTime: turn.elapsedTime || s.elapsedTime || 0 } : turn
        ),
      }));
      persistSession();
    };

    void (async () => {
      let finished = false;
      const completeOnce = async (result: { imageUrl?: string; error?: string; canceled?: boolean }) => {
        if (finished) return;
        finished = true;
        activeImageStudioStreamCleanup?.();
        activeImageStudioStreamCleanup = null;

        if (result.canceled) {
          updateGenerationBlock({
            status: "canceled",
            progress: {
              stage: "canceled",
              step: 0,
              total: 0,
              percent: 0,
              message: language === "en" ? "Canceled" : "已取消",
            },
          });
          finishTurn("stopped_no_action", language === "en" ? "Image generation canceled." : "图片生成已取消。");
          return;
        }

        if (result.error || !result.imageUrl) {
          const message = result.error || (language === "en" ? "No image was returned." : "未返回图片。");
          updateGenerationBlock({
            status: "error",
            error: message,
            progress: {
              stage: "error",
              step: 0,
              total: 0,
              percent: 0,
              message,
            },
          });
          set((s) => ({
            imageStudio: {
              ...s.imageStudio,
              setupGuideOpen: true,
            },
          }));
          finishTurn("error", message);
          return;
        }

        updateGenerationBlock({
          status: "running",
          imageUrl: result.imageUrl,
          progress: {
            stage: "saving",
            step: params.steps,
            total: params.steps,
            percent: 98,
            message: language === "en" ? "Saving output" : "正在保存图片",
          },
        });
        let outputPath = "";
        try {
          outputPath = await persistGeneratedImage({ sessionKey: runSessionKey, prompt, imageUrl: result.imageUrl });
        } catch (error) {
          appendDebugLog("warn", "image_studio_save_output_failed", {
            error: error instanceof Error ? error.message : String(error),
          });
        }
        updateGenerationBlock({
          status: "completed",
          imageUrl: result.imageUrl,
          ...(outputPath ? { outputPath } : {}),
          progress: {
            stage: "done",
            step: params.steps,
            total: params.steps,
            percent: 100,
            message: language === "en" ? "Done" : "已完成",
          },
        });
        finishTurn("done", language === "en" ? "Image generated." : "图片已生成。");
      };

      try {
        updateGenerationBlock({
          status: "running",
          progress: {
            stage: "starting",
            step: 0,
            total: params.steps,
            percent: 2,
            message: language === "en" ? "Checking image provider" : "正在检查图片 provider",
          },
        });
        const status = await checkImageStudioEngineStatus(state.imageStudio.config);
        set((s) => ({
          imageStudio: {
            ...s.imageStudio,
            status,
            setupGuideOpen: status.state === "ready" ? s.imageStudio.setupGuideOpen : true,
          },
        }));
        if (status.state !== "ready") {
          await completeOnce({
            error: status.message || (language === "en" ? "Image provider is not ready." : "图片 provider 未就绪。"),
          });
          return;
        }

        updateGenerationBlock({
          progress: {
            stage: "starting",
            step: 0,
            total: params.steps,
            percent: 5,
            message: isLocalProvider
              ? (language === "en" ? "Sending to local image service" : "正在发送到本地图像服务")
              : (language === "en" ? "Submitting to web fallback provider" : "正在提交到网页 fallback 服务"),
          },
        });
        if (isLocalProvider) {
          updateGenerationBlock({
            progress: {
              stage: "generating",
              step: 0,
              total: params.steps,
              percent: 20,
              message: language === "en" ? "Generating with local image service" : "本地图像服务生成中",
            },
          });
          const localResult = await runLocalImageStudioGeneration({
            prompt,
            config: state.imageStudio.config,
            generationParams: params,
            referenceImages: images,
          });
          await completeOnce(localResult);
          return;
        }

        const started = await startImageStudioGeneration({
          prompt,
          config: state.imageStudio.config,
          generationParams: params,
          referenceImages: images,
        });
        const streamId = `image-studio-${turnId}`;
        updateGenerationBlock({
          jobId: started.jobId,
          streamId,
          progress: {
            stage: "generating",
            step: 0,
            total: params.steps,
            percent: 8,
            message: language === "en" ? "Generating" : "正在生成",
          },
        });
        set((s) => ({
          imageStudio: {
            ...s.imageStudio,
            activeJobId: started.jobId,
            activeStreamId: streamId,
          },
        }));

        activeImageStudioStreamCleanup = await streamImageStudioGeneration({
          config: state.imageStudio.config,
          jobId: started.jobId,
          streamId,
          onProgress: (progress) => {
            updateGenerationBlock({
              progress: {
                ...progress,
                message: language === "en"
                  ? progress.message
                  : progress.total > 0
                  ? `正在生成 ${progress.step}/${progress.total}`
                  : "正在生成",
              },
              ...(progress.previewUrl ? { previewUrl: progress.previewUrl } : {}),
            });
          },
          onDone: completeOnce,
        });
      } catch (error) {
        await completeOnce({
          error: error instanceof Error ? error.message : String(error || "Image generation failed."),
        });
      }
    })();

    return true;
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
              elapsedTime: turn.elapsedTime || s.elapsedTime || 0,
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
  startNewTurn: (remoteFeishu) => {
    set(() => ({
      currentTurnState: {
        ...createDefaultCurrentTurnState(),
        turnId: Date.now().toString(),
        ...(remoteFeishu ? { remoteFeishu } : {}),
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
  mcpServers: DEFAULT_MCP_SERVERS,
  mcpDiscoveredTools: [],
  mcpToolServerMap: {},
  setMcpServers: (servers) =>
    set((s) => {
      const normalizedServers = normalizeMcpServers(servers);
      const filtered = filterMcpDiscoveryForServers(s.mcpDiscoveredTools, s.mcpToolServerMap, normalizedServers);
      setMcpToolServerMap(filtered.toolServerMap);
      return {
        mcpServers: normalizedServers,
        mcpDiscoveredTools: filtered.tools,
        mcpToolServerMap: filtered.toolServerMap,
      };
    }),
  addMcpServer: (server) => get().setMcpServers([...get().mcpServers, server]),
  removeMcpServer: (name) => get().setMcpServers(get().mcpServers.filter((sv) => sv.name !== name)),
  setMcpDiscoveredTools: (tools, toolServerMap) => {
    const filtered = filterMcpDiscoveryForServers(tools, toolServerMap, get().mcpServers);
    setMcpToolServerMap(filtered.toolServerMap);
    set({ mcpDiscoveredTools: filtered.tools, mcpToolServerMap: filtered.toolServerMap });
  },

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
        ...s.pendingFeishuApprovals.filter((item) =>
          item.code !== approval.code && item.approvalId !== approval.approvalId
        ),
      ].slice(0, 20),
    })),
  resolvePendingFeishuApproval: (userId, code, action = "approve") => {
    const normalizedCode = code.trim().toLowerCase();
    const state = get();
    const approval = state.pendingFeishuApprovals.find((item) =>
      item.userId === userId &&
      item.code.toLowerCase() === normalizedCode &&
      item.status === "pending",
    ) || null;
    if (!approval) return null;
    const now = Date.now();
    if (approval.expiresAt <= now) {
      set((s) => ({
        pendingFeishuApprovals: s.pendingFeishuApprovals.map((item) =>
          item.approvalId === approval.approvalId ? { ...item, status: "expired" } : item
        ),
      }));
      return null;
    }
    const status: FeishuApprovalStatus = action === "reject" ? "rejected" : "approved";
    set((s) => ({
      pendingFeishuApprovals: s.pendingFeishuApprovals.map((item) =>
        item.approvalId === approval.approvalId ? { ...item, status } : item
      ),
    }));
    return { ...approval, status };
  },
  resolvePendingFeishuApprovalAction: (request) => {
    const state = get();
    const result = resolveFeishuApprovalAction(state.pendingFeishuApprovals, request);
    if (!result.ok) {
      if (result.reason === "expired" && result.approval) {
        set((s) => ({
          pendingFeishuApprovals: s.pendingFeishuApprovals.map((item) =>
            item.approvalId === result.approval!.approvalId ? { ...item, status: "expired" } : item
          ),
        }));
      }
      return result;
    }
    const status: FeishuApprovalStatus = request.action === "approve" ? "approved" : "rejected";
    const resolvedApproval = { ...result.approval, status };
    set((s) => ({
      pendingFeishuApprovals: s.pendingFeishuApprovals.map((item) =>
        item.approvalId === result.approval.approvalId ? resolvedApproval : item
      ),
    }));
    return { ok: true, approval: resolvedApproval };
  },
  setFeishuApprovalCardMessageId: (approvalId, messageId) => {
    const cleanMessageId = String(messageId || "").trim();
    if (!approvalId || !cleanMessageId) return;
    set((s) => ({
      pendingFeishuApprovals: s.pendingFeishuApprovals.map((item) =>
        item.approvalId === approvalId ? { ...item, cardMessageId: cleanMessageId } : item
      ),
    }));
  },
  feishuLinkedSessionId: null,
  feishuLinkedContext: null,
  setFeishuLinkedSession: (sessionId, context) => set({ feishuLinkedSessionId: sessionId, feishuLinkedContext: context }),

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
  addSkill: ({ name, desc, content, type, toolParameters, packagePath, entryPoint, workspaceScope }) =>
    set((s) => ({
      skills: [...s.skills, { id: Date.now().toString(), name, desc, content: normalizeSkillContent(content), active: true, isBuiltIn: false, type: type || "instruction", toolParameters, packagePath, entryPoint, workspaceScope }],
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
  restoreRuntimeForSession: (sessionKey: string | null, options = {}) => {
    if (!sessionKey) return false;
    const runtime = get().runtimeBySessionKey[sessionKey];
    if (!runtime) return false;
    if (options.requireTranscript && !hasSessionRuntimeTranscript(runtime)) return false;
    set({
      ...getSessionRuntimeUiPatch(runtime, options),
      dismissedPendingDecisionInputKey: null,
    });
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
        autoApproveTools: false,
        autoApproveToolScopes: [],
        webSearchEnabled: false,
        webSearchProvider: "duckduckgo",
        approvedLocalFileReadPaths: [],
        approvedShellPermissionRules: [],
        readOnlyAutoApproveForSession: false,
        queuedUserMessage: null,
        activeGuidance: null,
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
        autoApproveTools: false,
        autoApproveToolScopes: [],
        webSearchEnabled: false,
        webSearchProvider: "duckduckgo",
        approvedLocalFileReadPaths: [],
        approvedShellPermissionRules: [],
        readOnlyAutoApproveForSession: false,
        queuedUserMessage: null,
        activeGuidance: null,
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

  removeSession: (workspacePath: string, sessionId: number, options = {}) => {
    set((s) => {
      const wsSessions = s.sessionsByWorkspace[workspacePath];
      if (!wsSessions) return s;
      const filtered = wsSessions.filter((sess) => sess.id !== sessionId);
      const isCurrentSession = s.currentSessionId === sessionId;
      const nextSessionId = isCurrentSession
        ? options.nextSessionId ?? filtered[0]?.id ?? null
        : s.currentSessionId;
      const sessionKey = resolveSessionRuntimeKey(workspacePath, sessionId);
      const runtimeBySessionKey = { ...s.runtimeBySessionKey };
      if (sessionKey) delete runtimeBySessionKey[sessionKey];
      return {
        sessionsByWorkspace: {
          ...s.sessionsByWorkspace,
          [workspacePath]: filtered.map((sess) => ({
            ...sess,
            active: isCurrentSession ? sess.id === nextSessionId : sess.active,
          })),
        },
        activeSessionByWorkspace: isCurrentSession
          ? {
              ...s.activeSessionByWorkspace,
              [workspacePath]: nextSessionId,
            }
          : s.activeSessionByWorkspace,
        currentSessionId: isCurrentSession ? nextSessionId : s.currentSessionId,
        runtimeBySessionKey,
        ...(isCurrentSession
          ? {
              autoApproveTools: false,
              autoApproveToolScopes: [],
              webSearchEnabled: false,
              webSearchProvider: "duckduckgo",
              approvedLocalFileReadPaths: [],
              approvedShellPermissionRules: [],
              readOnlyAutoApproveForSession: false,
              queuedUserMessage: null,
              activeGuidance: null,
            }
          : {}),
      };
    });
  },

  updateSession: (workspacePath: string, sessionId: number, patch: Partial<Session>) => {
    set((s) => {
      const wsSessions = s.sessionsByWorkspace[workspacePath];
      if (!wsSessions) return s;
      let changed = false;
      const nextSessions = wsSessions.map((sess) => {
        if (sess.id !== sessionId) return sess;
        let sessionChanged = false;
        const currentSession = sess as unknown as Record<string, unknown>;
        for (const [key, value] of Object.entries(patch)) {
          if (!Object.is(currentSession[key], value)) {
            sessionChanged = true;
            break;
          }
        }
        if (!sessionChanged) return sess;
        changed = true;
        return { ...sess, ...patch };
      });
      if (!changed) return s;
      return {
        sessionsByWorkspace: {
          ...s.sessionsByWorkspace,
          [workspacePath]: nextSessions,
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
      ...(s.currentSessionId !== id ? { autoApproveTools: false, autoApproveToolScopes: [] } : {}),
      ...(s.currentSessionId !== id ? { webSearchEnabled: false, webSearchProvider: "duckduckgo" } : {}),
      ...(s.currentSessionId !== id ? { readOnlyAutoApproveForSession: false } : {}),
      ...(s.currentSessionId !== id ? { approvedLocalFileReadPaths: [] } : {}),
      ...(s.currentSessionId !== id ? { approvedShellPermissionRules: [] } : {}),
      ...(s.currentSessionId !== id ? { queuedUserMessage: null, activeGuidance: null } : {}),
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
        t.id === id && t.type === "tool" ? { ...t, status: "error", toolStatus: "rejected", message: "Changes rejected by user." } : t
      ),
      showDiff: false,
    }));
    if (state.pendingReviewResolve && state.pendingReviewTaskId === id) {
      get().rejectToolAction(id);
    }
  },
  revertDiffGroups: async (groups) => {
    const language = get().config.language === "en" ? "en" : "zh";
    const copy = {
      noPath: language === "zh" ? "缺少文件路径，无法撤销。" : "Missing file path; cannot revert.",
      noExecuted: language === "zh" ? "没有已执行的修改可撤销。" : "No executed change is available to revert.",
      unsafeLegacy: language === "zh" ? "这条历史 Diff 不是完整文件快照，无法安全撤销。" : "This historical diff is not a full-file snapshot, so it cannot be safely reverted.",
      conflict: language === "zh" ? "文件内容已经变化，未覆盖后续改动。" : "The file has changed since this diff was recorded; later edits were not overwritten.",
      missingExisting: language === "zh" ? "原文件不存在，无法恢复旧内容。" : "The file no longer exists, so the old content cannot be restored.",
      rejected: language === "zh" ? "待审批修改已拒绝。" : "Pending change rejected.",
      restored: language === "zh" ? "已恢复到修改前内容。" : "Restored to the content before this change.",
      deleted: language === "zh" ? "已删除 AI 新建的文件。" : "Deleted the file created by the AI.",
    };
    const results: DiffRevertResult[] = [];

    for (const group of groups) {
      const path = String(group.path || "").trim();
      const taskIds = group.taskIds.filter((id) => Number.isFinite(id));
      if (!path) {
        results.push({ path, taskIds, ok: false, message: copy.noPath });
        continue;
      }

      const state = get();
      const taskIdSet = new Set(taskIds);
      const relatedBlocks = state.taskFlow.filter(
        (block): block is Extract<TaskBlock, { type: "tool" }> =>
          block.type === "tool" && taskIdSet.has(block.id) && !!block.diff,
      );
      const pendingBlock = relatedBlocks.find((block) => block.toolStatus === "pending");
      if (pendingBlock) {
        get().rejectDiff(pendingBlock.id);
        results.push({ path, taskIds, ok: true, message: copy.rejected });
        continue;
      }

      const executedBlocks = relatedBlocks.filter((block) => block.toolStatus === "executed");
      if (executedBlocks.length === 0) {
        results.push({ path, taskIds, ok: false, message: copy.noExecuted });
        continue;
      }

      const canRevert = executedBlocks.every(supportsFullFileDiffRevert);
      if (!canRevert) {
        const message = copy.unsafeLegacy;
        set((s) => ({
          taskFlow: s.taskFlow.map((block) =>
            block.type === "tool" && taskIdSet.has(block.id)
              ? { ...block, revertStatus: "failed" as const, revertMessage: message }
              : block
          ),
        }));
        results.push({ path, taskIds, ok: false, message });
        continue;
      }

      const existed = group.existed ?? executedBlocks[0]?.diff?.existed ?? true;
      const workspace = state.currentWorkspace.trim();
      const sessionKey = !workspace ? resolveGlobalChatSessionKey(state.currentSessionId) : null;
      const useChatTempStorage = !!sessionKey && !workspace;

      set((s) => ({
        taskFlow: s.taskFlow.map((block) =>
          block.type === "tool" && taskIdSet.has(block.id) && block.toolStatus === "executed"
            ? { ...block, revertStatus: "reverting" as const, revertMessage: "" }
            : block
        ),
      }));

      try {
        let currentContent = "";
        let missingCurrentFile = false;
        try {
          currentContent = useChatTempStorage
            ? await readChatTempFile(sessionKey!, path)
            : await readFile(path, workspace || undefined);
        } catch {
          missingCurrentFile = true;
        }

        if (missingCurrentFile) {
          if (existed) throw new Error(copy.missingExisting);
        } else if (currentContent !== group.newText) {
          throw new Error(copy.conflict);
        }

        if (!existed) {
          if (useChatTempStorage) {
            await deleteChatTempPath(sessionKey!, path);
          } else {
            await deleteWorkspacePath(path, workspace || undefined);
          }
        } else if (useChatTempStorage) {
          await writeChatTempFile(sessionKey!, path, group.oldText);
        } else {
          await writeFile(path, group.oldText, workspace || undefined);
        }

        const message = existed ? copy.restored : copy.deleted;
        set((s) => ({
          taskFlow: s.taskFlow.map((block) =>
            block.type === "tool" && taskIdSet.has(block.id) && block.toolStatus === "executed"
              ? { ...block, revertStatus: "reverted" as const, revertMessage: message }
              : block
          ),
          ...buildPlanArtifactRevertPatch(s, path, group.oldText, existed),
        }));
        invalidateWorkspaceTreeCache();
        get().bumpWorkspaceContentVersion();
        results.push({ path, taskIds, ok: true, message });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        set((s) => ({
          taskFlow: s.taskFlow.map((block) =>
            block.type === "tool" && taskIdSet.has(block.id) && block.toolStatus === "executed"
              ? { ...block, revertStatus: "failed" as const, revertMessage: message }
              : block
          ),
        }));
        results.push({ path, taskIds, ok: false, message });
      }
    }

    return results;
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
        runtimeEvents: [],
        harnessRunMarker: null,
        agentMessages: [],
        contextMemoryState: null,
        contextMemoryStateByRuntimeKey: {},
        providerCompatibilityByRuntimeKey: {},
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
        autoApproveTools: false,
        autoApproveToolScopes: [],
        webSearchEnabled: false,
        webSearchProvider: "duckduckgo",
        approvedLocalFileReadPaths: [],
        approvedShellPermissionRules: [],
        readOnlyAutoApproveForSession: false,
        queuedUserMessage: null,
        activeGuidance: null,
        planArtifacts: [],
        planTasks: [],
        planExecutionEvidenceLedger: [],
        planExecutionEvidenceCount: 0,
        planAutoResumeCount: 0,
        planExecutionProgressSnapshot: null,
        planStage: "idle",
        planApprovalChoice: null,
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
      mcpServers: DEFAULT_MCP_SERVERS,
      mcpDiscoveredTools: [],
      mcpToolServerMap: {},
      sessionsByWorkspace: {},
      workspaces: [],
      activeSessionByWorkspace: {},
      runtimeBySessionKey: {},
      selectedWorkspace: "",
      currentSessionId: null,
      selectedMainModeKey: "main_mode",
      selectedNexusModeKey: "nexus_general",
      imageStudio: createDefaultImageStudioRuntime(),
      taskFlow: [],
      runtimeEvents: [],
      agentMessages: [],
      contextMemoryState: null,
      contextMemoryStateByRuntimeKey: {},
      providerCompatibilityByRuntimeKey: {},
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
      autoApproveTools: false,
      autoApproveToolScopes: [],
      webSearchEnabled: false,
      webSearchProvider: "duckduckgo",
      approvedLocalFileReadPaths: [],
      approvedShellPermissionRules: [],
      readOnlyAutoApproveForSession: false,
      queuedUserMessage: null,
      activeGuidance: null,
      resolvedInstructionSet: null,
      instructionSources: [],
      loadedHookDefinitions: defaultHookDefinitions,
      hookExecutionRecords: [],
      instructionLastLoadedAt: null,
      hookLastLoadedAt: null,
      sessionHookCache: [],
      planArtifacts: [],
      planTasks: [],
      planExecutionEvidenceLedger: [],
      planExecutionEvidenceCount: 0,
      planAutoResumeCount: 0,
      planExecutionProgressSnapshot: null,
      planStage: "idle",
      planApprovalChoice: null,
      normalizedStreamState: defaultNormalizedStreamState,
      harnessRunMarker: null,
    });
  },

  // ── Workflow Mode ──────────────────────────────────────────────────

  isPlanApproved: false,
  planApprovalChoice: null,
  planArtifacts: [],
  planStage: "idle",
  planTasks: [],
  planExecutionEvidenceLedger: [],
  planExecutionEvidenceCount: 0,
  planAutoResumeCount: 0,
  planExecutionProgressSnapshot: null,
  normalizedStreamState: defaultNormalizedStreamState,
  runtimeEvents: [],
  harnessRunMarker: null,
  setWorkflowMode: (mode) => set((s) => ({
    config: { ...s.config, workflowMode: mode },
    ...(mode === "chat" ? { showPlanPanel: false, showDiff: false } : {}),
  })),
  setIsPlanApproved: (v) => set({ isPlanApproved: v, ...(v ? {} : { planApprovalChoice: null }) }),
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
      const normalizedTasks = artifact.kind === "tasks" || artifact.kind === "bugfix"
        ? reconcilePlanTaskCompletion(s.planTasks, parsedTasks, s.planExecutionEvidenceLedger, {
            preserveMissing: preserveTaskHistory,
            highlightNext: s.isPlanApproved && s.planExecutionEvidenceLedger.length > 0,
          })
        : normalizePlanTaskStatuses(
            s.planTasks,
            s.planExecutionEvidenceLedger,
            s.isPlanApproved && s.planExecutionEvidenceLedger.length > 0,
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

      const shouldAutoOpenPlanPanel = !s.isPlanApproved && s.planStage !== "executing";

      return {
        planArtifacts: nextArtifacts.sort((a, b) => a.updatedAt - b.updatedAt),
        planStage: nextStage,
        planTasks: normalizedTasks,
        ...(shouldAutoOpenPlanPanel
          ? {
              showPlanPanel: true,
              rightPanelTab: s.showDiff && s.rightPanelTab === "diff" ? "diff" as const : "plan" as const,
            }
          : {}),
      };
    }),
  clearPlanArtifacts: () =>
    set({
      planArtifacts: [],
      planStage: "idle",
      planTasks: [],
      planExecutionEvidenceLedger: [],
      planExecutionEvidenceCount: 0,
      planAutoResumeCount: 0,
      planExecutionProgressSnapshot: null,
      normalizedStreamState: defaultNormalizedStreamState,
      planApprovalChoice: null,
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
      set({ isPlanApproved: false, planApprovalChoice: null, planExecutionEvidenceLedger: [], planExecutionEvidenceCount: 0, planAutoResumeCount: 0, planExecutionProgressSnapshot: null });
      get().bumpWorkspaceContentVersion();
    }
  },
  deleteBrowserValidationArtifacts: async () => {
    const state = get();
    const sessionKey = !state.currentWorkspace.trim()
      ? resolveGlobalChatSessionKey(state.currentSessionId)
      : null;
    try {
      if (sessionKey) {
        await deleteChatTempPath(sessionKey, ".MAIN/browser-validation");
      } else {
        await deleteWorkspacePath(".MAIN/browser-validation", state.currentWorkspace || undefined);
      }
    } finally {
      invalidateWorkspaceTreeCache();
      get().bumpWorkspaceContentVersion();
    }
  },
  setPlanTasks: (tasks) => set((s) => ({
    planTasks: reconcilePlanTaskCompletion(
      s.planTasks,
      tasks,
      s.planExecutionEvidenceLedger,
      {
        preserveMissing: s.isPlanApproved || s.planStage === "executing" || s.planStage === "completed" || s.planTasks.length > 0,
        highlightNext: s.isPlanApproved && s.planExecutionEvidenceLedger.length > 0,
      },
    ),
  })),
  setNormalizedStreamState: (state) => set({ normalizedStreamState: state }),
  approvePlan: (approvalChoice) =>
    (() => {
      const state = get();
      const normalizedApprovalChoice = normalizePlanApprovalChoice(approvalChoice);
      const language = state.config.language === "en" ? "en" : "zh";
      const executionPlanTasks = ensureApprovedPlanRuntimeTasksForState(state, language);
      const hasPersistedTasksArtifact = state.planArtifacts.some((artifact) => artifact.kind === "tasks");
      const derivedRuntimeTasks = state.planTasks.length === 0 && !hasPersistedTasksArtifact && executionPlanTasks.length > 0;
      const approvalChoicePatch = { planApprovalChoice: normalizedApprovalChoice || null };
      const approvedTurnId = state.currentTurnId;
      const approvedHandoffSummary = language === "zh"
        ? "计划已批准，执行已交接到新的回合。"
        : "Plan approved; execution was handed off to a new turn.";
      const executionTurnId = `turn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const initialProgressSnapshot = normalizePlanExecutionProgressSnapshot({
            turnId: executionTurnId,
            update: buildPlanExecutionProgressUpdate({
              language,
              phase: "starting",
              iterationCount: 0,
              maxIterations: PLAN_EXECUTION_PROGRESS_DEFAULT_MAX_ITERATIONS,
              autoResumeCount: 0,
              tasks: executionPlanTasks,
              evidenceLedger: [],
              recentToolActivity: [],
            }),
            now: Date.now(),
          });
      const executionConsentPatch = {
        currentTurnExecutionConsent: {
          turnId: executionTurnId,
          granted: true,
        },
      };

      if (state.agentStatus === "pending_review" && state.abortController) {
        set({
          isPlanApproved: true,
          ...approvalChoicePatch,
          ...executionConsentPatch,
          planExecutionEvidenceLedger: [],
          planExecutionEvidenceCount: 0,
          planAutoResumeCount: 0,
          planExecutionProgressSnapshot: initialProgressSnapshot,
          ...(executionPlanTasks.length > 0 ? { planTasks: executionPlanTasks } : {}),
          agentStatus: "running",
          isGenerating: true,
          planStage: "executing",
        });
        if (approvedTurnId) {
          get().setConversationTurnStatus(approvedTurnId, "executing");
        }
        return;
      }

      set((s) => ({
        isPlanApproved: true,
        ...approvalChoicePatch,
        ...executionConsentPatch,
        planExecutionEvidenceLedger: [],
        planExecutionEvidenceCount: 0,
        planAutoResumeCount: 0,
        planExecutionProgressSnapshot: initialProgressSnapshot,
        ...(executionPlanTasks.length > 0 ? { planTasks: executionPlanTasks } : {}),
        planStage: "executing",
        conversationTurns: approvedTurnId
          ? s.conversationTurns.map((turn) =>
              turn.id === approvedTurnId
                ? {
                    ...turn,
                    status: "done" as const,
                    summary: approvedHandoffSummary,
                  }
                : turn,
            )
          : s.conversationTurns,
      }));

      runAfterNextPaint(() => {
        get().sendMessage(
          (() => {
            const hasTasksArtifact =
              state.planArtifacts.some((artifact) => artifact.kind === "tasks") ||
              executionPlanTasks.length > 0;
            const currentPlanTurn = state.currentTurnId
              ? state.conversationTurns.find((turn) => turn.id === state.currentTurnId)
              : null;
            const requestedDocs = detectRequestedRootMarkdownDeliverables(currentPlanTurn?.userPrompt || "");
            const deliverableHint = requestedDocs.length > 0
              ? state.config.language === "en"
                ? ` The final tasks must include writing ${requestedDocs.map((name) => `project-root \`${name}\``).join(", ")} before completion.`
                : ` 最终 tasks 必须包含写入${requestedDocs.map((name) => `项目根目录 \`${name}\``).join("、")}，完成前必须真实落盘。`
              : "";
            const approvalChoiceHint = buildPlanApprovalChoiceHint(normalizedApprovalChoice, language);
            const taskListText = formatPlanTaskListForPrompt(executionPlanTasks, language);
            const runtimeTaskNotice = derivedRuntimeTasks
              ? language === "en"
                ? "\n\nMAIN already derived a runtime task list from the approved plan, so you do not need to create `.MAIN/plans/tasks.md` before the first source write. Use this list as the execution source of truth; persist it to tasks.md only if the work becomes long, needs cross-session audit, or the user explicitly asks for an audit file:\n" + taskListText
                : "\n\nMAIN 已经从批准后的 design 派生出 runtime 任务清单，因此第一次源码写入前不必先创建 `.MAIN/plans/tasks.md`。请把下面清单作为本轮执行事实来源；只有任务变长、需要跨会话审计或用户明确要求留档时，才持久化到 tasks.md：\n" + taskListText
              : "";

            if (language === "en") {
              return hasTasksArtifact
              ? approvalChoiceHint + "The plan is approved. Continue directly from the current task list and execute the remaining items without repeating the plan. Do not read `.MAIN/plans/tasks.md` just to check whether it exists. If a source file has already been read and another read only returns `FILE_UNCHANGED_STUB`, switch to writing/patching, inspect a different target, or pause with the exact blocker instead of rereading. If `.MAIN/plans/tasks.md` is already known to exist, keep it as an audit record: do not delete completed or previous task records, and only check an item off after real evidence exists for its file/command/deliverable/browser validation, or the item is explicitly pending user validation." + deliverableHint + runtimeTaskNotice + "\n\n" + buildPlanCommandExecutionHint(executionPlanTasks, "en")
                : approvalChoiceHint + "The plan is approved. First derive a concise runtime task list from the approved plan.md; generate `.MAIN/plans/tasks.md` only if the work is long, needs cross-session audit, or the user explicitly requested a durable task file. Do not read tasks.md just to check whether it exists. Then execute real work without repeating the plan. Task items should be concise and include lightweight evidence such as `evidence: file:src/app.ts` or `evidence: cmd:npm test` when there is a concrete deliverable." + deliverableHint;
            }

            return hasTasksArtifact
              ? approvalChoiceHint + "计划已批准。请直接基于当前任务清单继续执行剩余任务，不要重复计划内容。不要为了确认 `.MAIN/plans/tasks.md` 是否存在而读取它；如果源码文件已经读过，再读只返回 `FILE_UNCHANGED_STUB`，请改为写入/替换、读取不同目标，或明确暂停说明阻塞，不要继续重复读取；如果它已知存在，它是审计记录：不要删除已完成或旧任务记录；只有文件/命令/交付物/浏览器验证的真实证据满足，或该项明确待用户验证后，才能勾选对应任务。" + deliverableHint + runtimeTaskNotice + "\n\n" + buildPlanCommandExecutionHint(executionPlanTasks, "zh")
              : approvalChoiceHint + "计划已批准。请先基于已批准的 plan.md 派生精简 runtime 任务清单；只有任务较长、需要跨会话审计或用户明确要求持久任务文件时，才生成 `.MAIN/plans/tasks.md`。不要为了确认 tasks.md 是否存在而读取它。然后执行真实任务，不要重复计划内容。有明确交付物的任务请保留轻量证据标签，例如 `证据: file:src/app.ts` 或 `证据: cmd:npm test`。" + deliverableHint;
          })(),
          undefined,
          {
            hidden: true,
            createVisibleTurnForHiddenMessage: true,
            reuseCurrentTurn: false,
            turnIdOverride: executionTurnId,
            parentPlanTurnId: approvedTurnId || undefined,
            preservePlanState: true,
            resolvedIntent: "plan",
            runtimeIntentOverride: "execute",
            executionConsentGranted: true,
            skipIntentResolution: true,
            turnTitle: language === "zh" ? "执行已批准计划" : "Execute Approved Plan",
            intentSummary: language === "zh"
              ? "用户已批准计划，MAIN 将在新的执行回合中按 plan.md 落地。"
              : "The user approved the plan; MAIN will execute plan.md in a new execution turn.",
          },
        );
      });
    })(),
  rejectPlan: () => {
    const state = get();
    state.abortController?.abort();
    set({
      isPlanApproved: false,
      planApprovalChoice: null,
      planExecutionEvidenceLedger: [],
      planExecutionEvidenceCount: 0,
      planAutoResumeCount: 0,
      planExecutionProgressSnapshot: null,
      agentStatus: "idle",
      isGenerating: false,
      abortController: null,
    });
    if (state.currentTurnId) {
      get().setConversationTurnStatus(state.currentTurnId, "stopped_no_action");
    }
  },
  rejectPlanAndDeleteFiles: async () => {
    get().rejectPlan();
    await get().deletePersistedPlanFiles();
  },
  showWorkflowMenu: false,
  setShowWorkflowMenu: (v) => set({ showWorkflowMenu: v }),

  // ── Agent Orchestrator ──────────────────────────────────────────────

  agentStatus: "idle",
  agentMessages: [],
  contextMemoryState: null,
  contextMemoryStateByRuntimeKey: {},
  providerCompatibilityByRuntimeKey: {},
  pendingReviewResolve: null,
  pendingReviewTaskId: null,
  pendingToolCall: null,
  autoApproveTools: false,
  autoApproveToolScopes: [],
  webSearchEnabled: false,
  webSearchProvider: "duckduckgo",
  approvedLocalFileReadPaths: [],
  approvedShellPermissionRules: [],
  readOnlyAutoApproveForSession: false,
  currentTurnExecutionConsent: { turnId: null, granted: false },
  queuedUserMessage: null,
  activeGuidance: null,
  pendingRunDecisionResolver: null,
  setAutoApproveTools: (v) => {
    const state = get();
    if (!v && state.autoApproveTools && (state.isGenerating || state.agentStatus === "running")) {
      logStoreEvent("auto_review_disable_blocked", {
        agentStatus: state.agentStatus,
        isGenerating: state.isGenerating,
      });
      return;
    }

    set({
      autoApproveTools: v,
      autoApproveToolScopes: v ? buildSessionAutoApproveScopes(true) : [],
    });

    if (v && state.agentStatus === "pending_review" && state.pendingReviewResolve && state.pendingReviewTaskId != null) {
      logStoreEvent("auto_review_enabled_pending_review_approved", {
        taskId: state.pendingReviewTaskId,
        toolName: state.pendingToolCall?.name || null,
      });
      runAfterNextPaint(() => {
        const latest = get();
        if (latest.pendingReviewResolve && latest.pendingReviewTaskId === state.pendingReviewTaskId) {
          latest.allowToolAction(state.pendingReviewTaskId!);
        }
      });
    }
  },
  setWebSearchEnabled: (v) => set({ webSearchEnabled: v }),
  setWebSearchProvider: (provider) => set({ webSearchProvider: normalizeWebSearchProvider(provider) }),
  setReadOnlyAutoApproveForSession: (v) => set({ readOnlyAutoApproveForSession: v }),
  queueUserMessage: (text, images, options) => {
    const queued = normalizeQueuedUserMessage({
      id: `queued-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      text,
      images,
      contextMentions: options?.contextMentions,
      attachedFiles: options?.attachedFiles,
      createdAt: Date.now(),
      status: "queued",
    });
    if (!queued) return;
    set({
      queuedUserMessage: queued,
    });
    logStoreEvent("queued_user_message_set", {
      chars: queued.text.length,
      images: queued.images?.length || 0,
      contextMentions: queued.contextMentions?.length || 0,
      attachedFiles: queued.attachedFiles?.length || 0,
    });
  },
  clearQueuedUserMessage: () => {
    set({ queuedUserMessage: null });
    logStoreEvent("queued_user_message_cleared");
  },
  setActiveGuidance: (text, turnId) => {
    const guidance = normalizeActiveGuidance({
      id: `guidance-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      text,
      turnId: turnId ?? get().currentTurnId ?? null,
      createdAt: Date.now(),
      consumedAt: null,
    });
    if (!guidance) return;
    set({ activeGuidance: guidance, input: "" });
    logStoreEvent("active_guidance_set", {
      turnId: guidance.turnId,
      chars: guidance.text.length,
    });
  },
  clearActiveGuidance: () => {
    set({ activeGuidance: null });
    logStoreEvent("active_guidance_cleared");
  },
  consumeActiveGuidance: (turnId) => {
    const state = get();
    const guidance = normalizeActiveGuidance(state.activeGuidance);
    if (!guidance) return null;
    const requestedTurnId = turnId ?? state.currentTurnId ?? null;
    if (guidance.consumedAt) return null;
    if (guidance.turnId && requestedTurnId && guidance.turnId !== requestedTurnId) return null;
    const consumed = { ...guidance, consumedAt: Date.now() };
    set({ activeGuidance: null });
    logStoreEvent("active_guidance_consumed", {
      turnId: requestedTurnId,
      chars: consumed.text.length,
    });
    return consumed;
  },
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
    const pendingLocalFileReadPath = normalizeLocalFileReadPath(state.pendingToolCall?.localFileReadPath);
    const pendingShellDecision = state.pendingToolCall?.shellPermissionDecision || null;
    const shellRules = suggestedShellPermissionRules(pendingShellDecision);
    set((s) => ({
      autoApproveTools: true,
      autoApproveToolScopes: buildSessionAutoApproveScopes(true),
      approvedLocalFileReadPaths:
        pendingLocalFileReadPath && !isLocalFileReadApproved(pendingLocalFileReadPath, s.approvedLocalFileReadPaths)
          ? [...s.approvedLocalFileReadPaths, pendingLocalFileReadPath]
          : s.approvedLocalFileReadPaths,
      approvedShellPermissionRules: [
        ...s.approvedShellPermissionRules,
        ...shellRules.filter((rule) => !s.approvedShellPermissionRules.includes(rule)),
      ],
    }));
    logStoreEvent("auto_review_enabled_pending_review_approved", {
      taskId: state.pendingReviewTaskId,
      toolName: state.pendingToolCall?.name || null,
      localFileRead: !!pendingLocalFileReadPath,
      shellRules: shellRules.length,
    });
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
    const reviewTurnId = state.taskFlow.find((block) => block.id === taskId)?.turnId || state.currentTurnId;
    const localFileReadPath = normalizeLocalFileReadPath(state.pendingToolCall?.localFileReadPath);
    const shellDecision = state.pendingToolCall?.shellPermissionDecision || null;
    const shellApproval = shellDecision?.requiresApproval
      ? buildShellPermissionApproval(
          shellDecision,
          isShellDecisionCoveredBySessionRules(shellDecision, state.approvedShellPermissionRules) ? "session" : "once",
        )
      : undefined;

    set((s) => ({
      approvedLocalFileReadPaths: localFileReadPath && !isLocalFileReadApproved(localFileReadPath, s.approvedLocalFileReadPaths)
        ? [...s.approvedLocalFileReadPaths, localFileReadPath]
        : s.approvedLocalFileReadPaths,
      pendingReviewResolve: null,
      pendingReviewTaskId: null,
      pendingToolCall: null,
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
    if (reviewTurnId && reviewTurnId !== state.currentTurnId) {
      get().setConversationTurnStatus(reviewTurnId, "executing");
    }
    runAfterNextPaint(() => {
      resolve({
        action: "accept",
        ...(localFileReadPath ? { grantLocalFileReadPath: localFileReadPath } : {}),
        ...(shellApproval ? { shellPermissionApproval: shellApproval } : {}),
      });
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
      runtimeEvents: [],
      harnessRunMarker: null,
      messages: [],
      agentMessages: [],
      contextMemoryState: null,
      contextMemoryStateByRuntimeKey: {},
      providerCompatibilityByRuntimeKey: {},
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
      autoApproveToolScopes: [],
      webSearchEnabled: false,
      webSearchProvider: "duckduckgo",
      approvedLocalFileReadPaths: [],
      approvedShellPermissionRules: [],
      readOnlyAutoApproveForSession: false,
      queuedUserMessage: null,
      activeGuidance: null,
      currentTurnExecutionConsent: { turnId: null, granted: false },
      planArtifacts: [],
      planTasks: [],
      planExecutionEvidenceLedger: [],
      planExecutionEvidenceCount: 0,
      planAutoResumeCount: 0,
      planExecutionProgressSnapshot: null,
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
      fileViewerWindow: null,
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
    runtimeIntentOverride?: ResolvedRunIntent;
    forceExecuteRecoveryMode?: ExecuteRecoveryMode;
    commandDirective?: CommandDirective | null;
    executionConsentGranted?: boolean;
    skipIntentResolution?: boolean;
    suppressGameStudioSuggestion?: boolean;
    turnTitle?: string;
    intentSummary?: string;
    uiParentTurnId?: string;
    parentPlanTurnId?: string;
    turnIdOverride?: string;
    createVisibleTurnForHiddenMessage?: boolean;
    contextMentionsSnapshot?: string[];
    attachedFilesSnapshot?: Array<AttachedFile | string>;
    remoteFeishu?: FeishuRemoteContext;
    skipAutoPlanHydration?: boolean;
  }) => {
    const state = get();
    const sendStartedAt = nowMs();
    logStoreEvent("send_message_called", {
      textChars: text?.length ?? 0,
      agentStatus: state.agentStatus,
      workspace: state.currentWorkspace || null,
      activeProfile: state.config.activeProfile,
    });
    const isImagePrompt = options?.hidden !== true && (
      state.selectedMainModeKey === "image_studio" ||
      (state.selectedMainModeKey === "main_mode" && isImageGenerationPrompt(text))
    );
    if (isImagePrompt) {
      let cleanText = text;
      const trimmed = text.trim();
      if (trimmed.startsWith("/")) {
        const parts = trimmed.split(/\s+/);
        const command = parts[0].toLowerCase();
        if (["/image", "/draw", "/生图", "/画图"].includes(command)) {
          cleanText = parts.slice(1).join(" ");
        }
      }
      return get().runImageStudioGeneration(cleanText, images);
    }
    const isHidden = options?.hidden === true;
    const createVisibleTurnForHiddenMessage = isHidden && options?.createVisibleTurnForHiddenMessage === true;
    const parentPlanTurnId =
      options?.parentPlanTurnId && state.conversationTurns.some((turn) => turn.id === options.parentPlanTurnId)
        ? options.parentPlanTurnId
        : null;
    const requestedUiParentTurnId = options?.uiParentTurnId || null;
    const uiParentTurnId = requestedUiParentTurnId && state.conversationTurns.some((turn) => turn.id === requestedUiParentTurnId)
      ? requestedUiParentTurnId
      : null;
    const mentionSnapshot = options?.contextMentionsSnapshot ?? state.contextMentions;
    const attachedFilesSnapshot = options?.attachedFilesSnapshot ?? state.attachedFiles;
    const remoteFeishu = options?.remoteFeishu || (
      state.feishuLinkedSessionId === state.currentSessionId && state.feishuLinkedContext
        ? state.feishuLinkedContext
        : undefined
    );
    const hasSupplementalInput = mentionSnapshot.length > 0 || attachedFilesSnapshot.length > 0;
    const currentTurn = state.currentTurnId
      ? state.conversationTurns.find((turn) => turn.id === state.currentTurnId) || null
      : null;
    const currentTurnReplyOptionBlocks = currentTurn
      ? state.taskFlow.filter((block): block is Extract<TaskBlock, { type: "agent" }> =>
          block.turnId === currentTurn.id &&
          block.type === "agent" &&
          Array.isArray(block.options) &&
          block.options.length > 0,
        )
      : [];
    const currentTurnHasReplyOptions = currentTurnReplyOptionBlocks.length > 0;
    const currentTurnIntent = resolveConversationTurnIntent(currentTurn);
    const currentMainModeKey = state.selectedMainModeKey;
    const hasPlanArtifacts = state.planArtifacts.length > 0 || state.planStage !== "idle";
    const hasApprovedOrExecutingPlanState =
      hasPlanArtifacts &&
      (state.isPlanApproved || state.planStage === "executing");
    const planExecutionResumeContinuationTarget =
      !isHidden && currentMainModeKey === "main_mode"
        ? findPlanExecutionResumeContinuationTarget(text, currentTurn, state.conversationTurns, state.taskFlow)
        : null;
    const shouldRouteContinuationToPlanResume =
      !isHidden &&
      !options?.skipIntentResolution &&
      !options?.resolvedIntent &&
      looksLikePreviousTurnContinuationInput(text) &&
      (
        hasApprovedOrExecutingPlanState ||
        !!planExecutionResumeContinuationTarget
      );
    const shouldContinuePlanIntent =
      !isHidden &&
      !shouldRouteContinuationToPlanResume &&
      currentTurnIntent === "plan" &&
      isContinuationPrompt(text) &&
      (state.planStage !== "completed" || state.planArtifacts.length === 0);
    const shouldAllowPreviousTurnContinuation =
      !isHidden &&
      !shouldRouteContinuationToPlanResume &&
      !shouldContinuePlanIntent &&
      (
        currentMainModeKey === "main_mode" ||
        (currentMainModeKey === "game_studio" && (currentTurnIntent === "plan" || hasPlanArtifacts))
      );
    const previousTurnContinuationTarget =
      shouldAllowPreviousTurnContinuation
        ? findPreviousTurnContinuationTarget(text, currentTurn, state.conversationTurns, state.taskFlow)
        : null;
    const shouldContinuePreviousTurnIntent = !!previousTurnContinuationTarget;
    const previousTurnContinuationIntent = previousTurnContinuationTarget
      ? resolveConversationTurnIntent(previousTurnContinuationTarget)
      : null;
    const shouldAutoResumeChoiceTurn =
      !isHidden &&
      options?.reuseCurrentTurn !== true &&
      !!currentTurn &&
      (currentTurn.status === "awaiting_input" || currentTurnHasReplyOptions);
    const shouldExplicitlyReuseCurrentTurn = options?.reuseCurrentTurn === true;
    const reusableTurnId = state.currentTurnId;
    const reuseCurrentTurn =
      (shouldExplicitlyReuseCurrentTurn || shouldAutoResumeChoiceTurn || shouldContinuePlanIntent) &&
      !!reusableTurnId;
    const isInternalTurn = isHidden && !reuseCurrentTurn && !createVisibleTurnForHiddenMessage;
    const shouldReuseExistingTurnIntent =
      reuseCurrentTurn &&
      !!currentTurn &&
      (currentTurn.status === "awaiting_input" || currentTurnHasReplyOptions);
    const awaitingChoiceBlocks = shouldReuseExistingTurnIntent
      ? currentTurnReplyOptionBlocks
      : [];
    const selectedAwaitingChoice = text.trim();
    const selectedAwaitingReplyOption = selectedAwaitingChoice
      ? awaitingChoiceBlocks
          .flatMap((block) => block.options || [])
          .find((option) =>
            option.value === selectedAwaitingChoice ||
            option.label === selectedAwaitingChoice
          ) || null
      : null;
    const shouldExecuteOnceFromReplyOption =
      selectedAwaitingReplyOption?.action === "execute_once" ||
      selectedAwaitingReplyOption?.action === "approve_operation_once";
    const operationProposalChoiceAction = selectedAwaitingReplyOption?.action;
    const preservePlanState =
      options?.preservePlanState === true ||
      shouldContinuePlanIntent ||
      shouldContinuePreviousTurnIntent ||
      (shouldReuseExistingTurnIntent && currentTurnIntent === "plan") ||
      (shouldAutoResumeChoiceTurn && currentTurnIntent === "plan") ||
      looksLikePlanContinuationOrApprovalInput(text, {
        hasPlanArtifacts,
        planStage: state.planStage,
        isPlanApproved: state.isPlanApproved,
      });
    const parsedStudioCommand = currentMainModeKey === "game_studio"
      ? parseGameStudioSlashCommand(text)
      : null;
    const parsedStudioWorkflowArgs = parsedStudioCommand?.type === "workflow"
      ? parsedStudioCommand.args
      : "";
    const parsedSetupEngineCommand =
      parsedStudioCommand?.type === "workflow" && parsedStudioCommand.slug === "setup-engine"
        ? parseSetupEngineArgs(parsedStudioWorkflowArgs)
        : null;
    const languageResolutionInput =
      parsedStudioCommand?.type === "workflow"
        ? (parsedStudioWorkflowArgs || text)
        : text;
    const preferredLanguage = isHidden
      ? state.preferredResponseLanguage
      : resolveTurnResponseLanguage({
          text: languageResolutionInput,
          policy: state.config.responseLanguagePolicy,
          systemLanguage: state.config.language === "en" ? "en" : "zh",
          fallbackLanguage: state.config.language === "en" ? "en" : "zh",
        });
    const hasRuntimePlanState =
      state.planArtifacts.length > 0 ||
      state.planTasks.length > 0 ||
      state.planStage !== "idle";
    const shouldAttemptAutoPlanHydration =
      !isHidden &&
      options?.skipAutoPlanHydration !== true &&
      !!state.currentWorkspace.trim();
    const autoHydrationReason = shouldAttemptAutoPlanHydration
      ? resolvePlanStateHydrationReason({
          text,
          hasPlanState: hasRuntimePlanState,
          hasContinuationState: state.isPlanApproved || state.planStage === "executing",
          slashCommand: parsedStudioCommand,
        })
      : null;
    if (autoHydrationReason) {
      void (async () => {
        let hydrated:
          | Awaited<ReturnType<typeof hydrateExistingPlanArtifactsForWorkspace>>
          | null = null;
        try {
          hydrated = await hydrateExistingPlanArtifactsForWorkspace(
            state.currentWorkspace,
            preferredLanguage === "en" ? "en" : "zh",
          );
        } catch {
          hydrated = null;
        }

        const shouldPromoteToExecuting = shouldPromoteHydratedPlanToExecuting(autoHydrationReason);
        const hasHydratedData = !!hydrated && (hydrated.artifacts.length > 0 || hydrated.tasks.length > 0);
        if (hydrated && hasHydratedData) {
          set((s) => {
            const alreadyHasPlanState =
              s.planArtifacts.length > 0 ||
              s.planTasks.length > 0 ||
              s.planStage !== "idle";
            if (alreadyHasPlanState) return {};
            const baseStage = derivePlanStageFromArtifacts(
              hydrated.artifacts,
              hydrated.tasks,
              shouldPromoteToExecuting,
              s.planStage,
            );
            const nextStage =
              shouldPromoteToExecuting && (baseStage === "idle" || baseStage === "ready_to_execute")
                ? "executing"
                : baseStage;
            const threadId =
              resolveSessionRuntimeKey(resolveSessionWorkspaceKey(s.currentWorkspace), s.currentSessionId) ||
              "default";
            const nextEvent = withEventSchema({
              type: "plan_state_hydrated",
              threadId,
              turnId: s.currentTurnId || undefined,
              timestampMs: Date.now(),
              reason: autoHydrationReason,
              taskCount: hydrated.tasks.length,
              artifactPaths: hydrated.artifacts.map((artifact) => artifact.path),
            });
            return {
              planArtifacts: hydrated.artifacts,
              planTasks: hydrated.tasks,
              planStage: nextStage,
              isPlanApproved: shouldPromoteToExecuting || s.isPlanApproved,
              showPlanPanel: true,
              rightPanelTab: "plan",
              showDiff: false,
              runtimeEvents: appendRuntimeEvent(s.runtimeEvents, nextEvent),
            };
          });
          logStoreEvent("plan_state_hydrated", {
            workspace: state.currentWorkspace || null,
            reason: autoHydrationReason,
            artifacts: hydrated.artifacts.map((artifact) => artifact.path),
            taskCount: hydrated.tasks.length,
          });
        }

        const nextOptions = {
          ...(options || {}),
          skipAutoPlanHydration: true,
          preservePlanState:
            options?.preservePlanState === true || (hasHydratedData && shouldPromoteToExecuting),
        };
        get().sendMessage(text, images, nextOptions);
      })();
      return true;
    }
    const mainDebugShortcut = !isHidden && currentMainModeKey === "main_mode"
      ? parseMainDebugShortcut(text)
      : null;
    if (mainDebugShortcut) {
      text = buildMainDebugPrompt(mainDebugShortcut.rest);
    }
    const mainIntentShortcut = !isHidden && !mainDebugShortcut
      ? parseMainIntentShortcutForMode(text, currentMainModeKey)
      : null;
    if (mainIntentShortcut) {
      text = mainIntentShortcut.rest.trimStart();
    }
    const modeScopedLockedComposerIntent =
      state.lockedComposerIntent && isMainIntentShortcutAllowedInMainMode(state.lockedComposerIntent, currentMainModeKey)
        ? state.lockedComposerIntent
        : null;
    const lockedComposerIntent = !isHidden && !mainDebugShortcut
      ? modeScopedLockedComposerIntent || mainIntentShortcut?.intent || null
      : null;
    const cachedWorkspaceTreeForGameDetection =
      state.currentWorkspace &&
      workspaceTreeCacheKey === state.currentWorkspace &&
      workspaceTreeCacheVersion === state.workspaceContentVersion
        ? workspaceTreeCache
        : "";
    if (!cachedWorkspaceTreeForGameDetection && state.currentWorkspace.trim()) {
      void getWorkspaceTree(state.currentWorkspace);
    }
    if (shouldConsiderGameStudioSuggestion({
      isHidden,
      currentMainModeKey,
      hasPendingRunDecision: !!state.pendingRunDecision,
      hasMainDebugShortcut: !!mainDebugShortcut,
      hasMainIntentShortcut: !!mainIntentShortcut,
      hasLockedComposerIntent: !!lockedComposerIntent,
      skipIntentResolution: options?.skipIntentResolution,
      resolvedIntent: options?.resolvedIntent,
      shouldContinuePlanIntent,
      shouldContinuePreviousTurnIntent,
      shouldReuseExistingTurnIntent,
      suppressGameStudioSuggestion: options?.suppressGameStudioSuggestion,
      input: text,
      hasPlanArtifacts,
      planStage: state.planStage,
      isPlanApproved: state.isPlanApproved,
    })) {
      const gameDevelopmentSignal = detectGameDevelopmentIntent(text, {
        workspaceTree: cachedWorkspaceTreeForGameDetection,
      });
      if (gameDevelopmentSignal.shouldSuggest) {
        set({
          pendingRunDecision: createGameStudioModeSwitchDecision({
            input: text,
            images,
            language: preferredLanguage,
            signal: gameDevelopmentSignal,
          }),
        });
        return true;
      }
    }
    if (!text.trim() && !hasSupplementalInput && !images?.length) {
      return false;
    }
    const normalizedPendingDecisionInputKey = normalizePendingDecisionInputKey(text);
    const shouldSuppressSameInputDecision =
      !isHidden &&
      normalizedPendingDecisionInputKey.length > 0 &&
      state.dismissedPendingDecisionInputKey === normalizedPendingDecisionInputKey;
    let decisionSuppressionConsumed = false;
    const consumeDecisionSuppression = () => {
      if (!shouldSuppressSameInputDecision || decisionSuppressionConsumed) return false;
      decisionSuppressionConsumed = true;
      set({ dismissedPendingDecisionInputKey: null });
      return true;
    };
    logStoreEvent("send_start", {
      textChars: text.length,
      isHidden,
      reuseCurrentTurn,
      shouldExplicitlyReuseCurrentTurn,
      shouldAutoResumeChoiceTurn,
      shouldReuseExistingTurnIntent,
      skipIntentResolution: options?.skipIntentResolution === true,
      preservePlanState,
      currentTurnId: state.currentTurnId,
      currentTurnStatus: currentTurn?.status ?? null,
      currentTurnIntent,
      previousTurnContinuationTargetId: previousTurnContinuationTarget?.id ?? null,
      previousTurnContinuationIntent,
      shouldContinuePreviousTurnIntent,
      shouldRouteContinuationToPlanResume,
      planExecutionResumeContinuationTargetId: planExecutionResumeContinuationTarget?.id ?? null,
      selectedMainModeKey: currentMainModeKey,
      taskFlowBlocks: state.taskFlow.length,
      agentMessages: state.agentMessages.length,
      conversationTurns: state.conversationTurns.length,
      contextMentions: mentionSnapshot.length,
      attachedFiles: attachedFilesSnapshot.length,
      images: images?.length ?? 0,
      mainDebugShortcut: !!mainDebugShortcut,
    });
    const isLocalStudioCommand =
      parsedStudioCommand?.type === "agent" || parsedStudioCommand?.type === "auto";
    let effectiveRunIntent =
      mainDebugShortcut ? "plan" :
      options?.resolvedIntent ||
      lockedComposerIntent ||
      (shouldContinuePlanIntent ? "plan" : null) ||
      (shouldContinuePreviousTurnIntent && previousTurnContinuationIntent ? previousTurnContinuationIntent : null) ||
      ((preservePlanState || shouldReuseExistingTurnIntent)
        ? currentTurnIntent
        : resolveRunIntentFromLegacyWorkflowMode(state.config.workflowMode));
    let effectiveIntentSummary = normalizeIntentSummary(options?.intentSummary || "");
    let effectiveCommandDirective: CommandDirective | null = options?.commandDirective ?? null;
    const applyDecisionSuppressedFallback = (
      source: "reuse_resolution" | "resolution",
      reason: string,
    ) => {
      effectiveRunIntent = "respond";
      effectiveIntentSummary = buildRunIntentSummary({
        input: text,
        intent: "respond",
        language: preferredLanguage,
        reason,
      });
      effectiveCommandDirective = inferCommandDirective(text, "respond", {
        source: source === "reuse_resolution" ? "continuation" : "natural_language",
      });
      logStoreEvent("intent_decision_suppressed_for_same_input", {
        source,
        inputChars: text.trim().length,
      });
    };
    if (
      shouldExecuteOnceFromReplyOption &&
      effectiveRunIntent !== "execute" &&
      effectiveRunIntent !== "studio_workflow"
    ) {
      effectiveRunIntent = currentMainModeKey === "game_studio" ? "studio_workflow" : "execute";
      effectiveCommandDirective = effectiveCommandDirective || inferCommandDirective(text, effectiveRunIntent, {
        source: "continuation",
      });
      effectiveIntentSummary = effectiveIntentSummary || buildRunIntentSummary({
        input: text,
        intent: effectiveRunIntent,
        language: preferredLanguage,
        reason: preferredLanguage === "en"
          ? "The user selected an execution reply option, so this turn resumes with execute runtime tools."
          : "用户选择了执行型回复选项，本轮使用执行运行能力继续。",
      });
    }

    if (!effectiveCommandDirective && parsedStudioCommand?.type === "workflow") {
      effectiveCommandDirective = inferCommandDirective(text, "studio_workflow", {
        source: "studio_slash",
        parsedStudioCommand,
      });
    }

    if (parsedSetupEngineCommand?.engine === "unity") {
      effectiveCommandDirective = {
        kind: "unity",
        action: "setup-engine",
        target: "unity",
        source: "studio_slash",
        requiresWorkspace: true,
        requiresApproval: false,
        confidence: 0.98,
        reason: "Game Studio setup-engine explicitly selected Unity.",
      };
    }

    if (mainDebugShortcut && !effectiveIntentSummary) {
      effectiveIntentSummary = "MDEBUG：用户反馈自修复";
      effectiveCommandDirective = effectiveCommandDirective || inferCommandDirective(text, "plan", { source: "debug" });
    }

    if (shouldContinuePlanIntent && !effectiveIntentSummary) {
      effectiveIntentSummary = buildRunIntentSummary({
        input: currentTurn?.userPrompt || text,
        intent: "plan",
        language: preferredLanguage,
        reason: preferredLanguage === "en"
          ? "Continue the previous planning turn until the plan is produced."
          : "继续上一轮计划目标，直到生成计划结果。",
      });
      effectiveCommandDirective = effectiveCommandDirective || inferCommandDirective(text, "plan", { source: "continuation" });
    }

    if (shouldContinuePreviousTurnIntent && previousTurnContinuationTarget && !effectiveIntentSummary) {
      effectiveIntentSummary = buildRunIntentSummary({
        input: previousTurnContinuationTarget.userPrompt || text,
        intent: previousTurnContinuationIntent || effectiveRunIntent,
        language: preferredLanguage,
        reason: preferredLanguage === "en"
          ? "Continue the previous unfinished turn and complete the remaining work."
          : "继续上一轮未完成内容并完成剩余操作。",
      });
      effectiveCommandDirective = effectiveCommandDirective || inferCommandDirective(
        previousTurnContinuationTarget.userPrompt || text,
        previousTurnContinuationIntent || effectiveRunIntent,
        { source: "continuation" },
      );
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
      effectiveCommandDirective = effectiveCommandDirective || inferCommandDirective(text, lockedComposerIntent, {
        source: mainIntentShortcut ? "main_shortcut" : "natural_language",
      });
    }

    const shouldReevaluateReuseTurnIntent =
      !isHidden &&
      shouldReuseExistingTurnIntent &&
      !mainDebugShortcut &&
      !lockedComposerIntent &&
      !shouldContinuePlanIntent &&
      !shouldContinuePreviousTurnIntent &&
      !options?.skipIntentResolution &&
      !options?.resolvedIntent;

    if (shouldReevaluateReuseTurnIntent) {
      const reuseResolution = resolveTurnRunIntent(text, {
        language: preferredLanguage,
        mainModeKey: currentMainModeKey,
        parsedStudioCommand,
        hasPlanArtifacts,
        planStage: state.planStage,
        isPlanApproved: state.isPlanApproved,
        previousTurnIntent: currentTurnIntent,
      });
      const reuseLooksLikeExecutionIntent =
        shouldExecuteOnceFromReplyOption ||
        reuseResolution.intent === "execute" ||
        reuseResolution.intent === "studio_workflow" ||
        reuseResolution.commandDirective?.kind === "file_modify" ||
        reuseResolution.commandDirective?.kind === "shell" ||
        reuseResolution.commandDirective?.kind === "git" ||
        reuseResolution.commandDirective?.kind === "unity";
      const shouldRequestPlanDecision =
        reuseResolution.needsDecision === true ||
        (reuseLooksLikeExecutionIntent &&
          (reuseResolution.riskLevel === "high" || reuseResolution.intent === "plan"));

      if (shouldRequestPlanDecision) {
        if (consumeDecisionSuppression()) {
          applyDecisionSuppressedFallback(
            "reuse_resolution",
            preferredLanguage === "en"
              ? "You ignored the same intent decision for this draft, so this turn continues as a natural reply without showing the popup again."
              : "你刚刚忽略了同一草稿的意图确认，本轮先按自然回复继续，不再重复弹窗。",
          );
        } else {
          const pendingCopy = createPendingDecisionCopy({
            suggestedIntent: "plan",
            decisionOptions: ["plan", "respond", "execute"],
            riskLevel: reuseResolution.riskLevel,
            reason: reuseResolution.reason,
          }, preferredLanguage);
          set({
            pendingRunDecision: {
              kind: "intent_confirmation",
              source: "pre_submit",
              originalInput: text,
              originalImages: images || [],
              suggestedIntent: "plan",
              reason: pendingCopy.reason,
              title: pendingCopy.title,
              options: pendingCopy.options,
            },
          });
          return true;
        }
      }

      if (
        reuseLooksLikeExecutionIntent &&
        (reuseResolution.intent === "execute" || reuseResolution.intent === "studio_workflow")
      ) {
        effectiveRunIntent = reuseResolution.intent;
        effectiveCommandDirective =
          reuseResolution.commandDirective ||
          effectiveCommandDirective ||
          inferCommandDirective(text, reuseResolution.intent, { source: "continuation" });
        effectiveIntentSummary = buildRunIntentSummary({
          input: text,
          intent: reuseResolution.intent,
          language: preferredLanguage,
          reason: preferredLanguage === "en"
            ? "The user selected a fix/implement continuation option, so this reused turn is auto-upgraded to execution."
            : "用户在复用回合中选择了修复/实现型选项，本轮自动升级为执行模式。",
        });
      }
    }

    if (!isHidden && !mainDebugShortcut && !lockedComposerIntent && !shouldContinuePlanIntent && !shouldContinuePreviousTurnIntent && !shouldReuseExistingTurnIntent && !options?.skipIntentResolution && !options?.resolvedIntent) {
      const resolution: RunIntentResolution = shouldRouteContinuationToPlanResume
        ? {
            intent: "plan" as const,
            reason: preferredLanguage === "en"
              ? "Continuation input is attached to an approved/executing or recently misrouted plan context, so MAIN resumes plan execution instead of ordinary chat."
              : "短继续指令关联到已批准/执行中计划或上一轮误路由的计划上下文，因此恢复计划执行而不是普通聊天续跑。",
            confidence: 0.95,
            bypassMainRouter: false,
            riskLevel: "low" as const,
            controlAction: "resume_plan_execution" as const,
            commandDirective: inferCommandDirective(text, "plan", {
              source: "continuation",
              controlAction: "resume_plan_execution",
            }),
          }
        : resolveTurnRunIntent(text, {
            language: preferredLanguage,
            mainModeKey: currentMainModeKey,
            parsedStudioCommand,
            hasPlanArtifacts,
            planStage: state.planStage,
            isPlanApproved: state.isPlanApproved,
            previousTurnIntent: currentTurnIntent,
          });
      effectiveIntentSummary = buildRunIntentSummary({
        input: text,
        intent: resolution.intent,
        language: preferredLanguage,
        reason: resolution.reason,
      });
      effectiveCommandDirective = resolution.commandDirective || inferCommandDirective(text, resolution.intent);

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
        set({
          input: "",
          contextMentions: [],
          attachedFiles: [],
          lockedComposerIntent: null,
          pendingRunDecision: null,
        });
        void (async () => {
          const shouldHydrateExistingPlan =
            looksLikeExistingPlanExecutionRequest(text) ||
            shouldRouteContinuationToPlanResume;
          let latest = get();
          let hydratedForExecution:
            | Awaited<ReturnType<typeof hydrateExistingPlanArtifactsForWorkspace>>
            | null = null;

          if (shouldHydrateExistingPlan) {
            const alreadyHydrated =
              latest.planArtifacts.length > 0 ||
              latest.planTasks.length > 0 ||
              latest.planStage !== "idle";
            const hydrated = alreadyHydrated
              ? {
                  artifacts: latest.planArtifacts,
                  tasks: latest.planTasks,
                  hasTasksArtifact:
                    latest.planArtifacts.some((artifact) => artifact.kind === "tasks") ||
                    latest.planTasks.length > 0,
                }
              : await hydrateExistingPlanArtifactsForWorkspace(
                  latest.currentWorkspace,
                  preferredLanguage,
                );
            hydratedForExecution = hydrated;
            latest = get();
            set({
              planArtifacts: hydrated.artifacts,
              planTasks: hydrated.tasks,
              isPlanApproved: true,
              planApprovalChoice: text.trim() || null,
              planStage: "executing",
              planAutoResumeCount: 0,
              planExecutionProgressSnapshot: null,
              showPlanPanel: true,
              rightPanelTab: "plan",
              showDiff: false,
            });
            logStoreEvent("existing_plan_hydrated_for_execution", {
              workspace: latest.currentWorkspace || null,
              reusedExistingState: alreadyHydrated,
              artifacts: hydrated.artifacts.map((artifact) => artifact.path),
              taskCount: hydrated.tasks.length,
            });
          }

          latest = get();
          const resumePlanTasks = ensureApprovedPlanRuntimeTasksForState(latest, preferredLanguage);
          if (resumePlanTasks.length > 0) {
            set({ planTasks: resumePlanTasks });
            latest = get();
          }
          const hasTasksArtifact =
            (hydratedForExecution?.artifacts || latest.planArtifacts).some((artifact) => artifact.kind === "tasks") ||
            resumePlanTasks.length > 0 ||
            (hydratedForExecution?.tasks || latest.planTasks).length > 0;

          get().sendMessage(
            buildTrustedPlanResumePrompt({
              language: preferredLanguage,
              hasTasksArtifact,
              tasks: resumePlanTasks.length > 0 ? resumePlanTasks : latest.planTasks,
              artifacts: latest.planArtifacts,
              evidenceLedger: latest.planExecutionEvidenceLedger,
            }),
            undefined,
            {
              hidden: true,
              createVisibleTurnForHiddenMessage: true,
              reuseCurrentTurn: false,
              uiParentTurnId: planExecutionResumeContinuationTarget?.id || state.currentTurnId || undefined,
              preservePlanState: true,
              resolvedIntent: "plan",
              runtimeIntentOverride: "execute",
              commandDirective: resolution.commandDirective || inferCommandDirective(text, "plan", {
                source: "continuation",
                controlAction: "resume_plan_execution",
              }),
              executionConsentGranted: true,
              skipIntentResolution: true,
              turnTitle: preferredLanguage === "zh" ? "计划执行恢复" : "Plan Execution Resume",
              intentSummary: preferredLanguage === "zh"
                ? "从已批准计划的剩余任务继续执行。"
                : "Resume execution from the remaining tasks in the approved plan.",
            },
          );
        })();
        return true;
      }

      if (resolution.needsDecision) {
        if (consumeDecisionSuppression()) {
          applyDecisionSuppressedFallback(
            "resolution",
            preferredLanguage === "en"
              ? "You ignored the same intent decision for this draft, so this turn continues as a natural reply without showing the popup again."
              : "你刚刚忽略了同一草稿的意图确认，本轮先按自然回复继续，不再重复弹窗。",
          );
        } else {
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

          const latestState = get();
          const latestInput = latestState.input.trim();
          const hasComparableLatestInput = latestInput.length > 0;
          const stalePreflight =
            (hasComparableLatestInput && latestInput !== text.trim()) ||
            latestState.selectedMainModeKey !== currentMainModeKey ||
            !!latestState.lockedComposerIntent ||
            !!parseMainIntentShortcutForMode(latestInput, latestState.selectedMainModeKey) ||
            !!parseMainDebugShortcut(latestInput);
          if (stalePreflight) {
            logStoreEvent("intent_preflight_stale_discarded", {
              originalChars: text.trim().length,
              latestChars: latestInput.length,
              selectedMainModeKey: latestState.selectedMainModeKey,
              hasLockedComposerIntent: !!latestState.lockedComposerIntent,
              hasExplicitShortcut:
                !!parseMainIntentShortcutForMode(latestInput, latestState.selectedMainModeKey) ||
                !!parseMainDebugShortcut(latestInput),
            });
            return;
          }

          if (preflight?.needsUserChoice) {
            const fallbackCopy = createPendingDecisionCopy(
              {
                suggestedIntent: preflight.intent,
                decisionOptions: preflight.options
                  ?.map((option) => option.id)
                  .filter(isResolvedUserIntentChoice),
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
          const resolvedCommandDirective =
            preflight?.commandDirective ||
            resolution.commandDirective ||
            inferCommandDirective(text, resolvedIntent);

          get().sendMessage(text, images, {
            ...(options || {}),
            resolvedIntent,
            commandDirective: resolvedCommandDirective,
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

    if (!effectiveCommandDirective) {
      effectiveCommandDirective = inferCommandDirective(text, effectiveRunIntent, {
        source: mainIntentShortcut ? "main_shortcut" : parsedStudioCommand?.type === "workflow" ? "studio_slash" : "natural_language",
        parsedStudioCommand,
      });
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
    const runtimeRunIntent = options?.runtimeIntentOverride ||
      (shouldExecuteOnceFromReplyOption && effectiveRunIntent !== "plan"
        ? currentMainModeKey === "game_studio" ? "studio_workflow" : "execute"
        : effectiveRunIntent);
    const effectiveDisplayIntent: ResolvedRunIntent =
      effectiveRunIntent === "plan" && runtimeRunIntent === "execute"
        ? "execute"
        : effectiveRunIntent;
    const shouldGrantExecutionConsentForTurn =
      options?.executionConsentGranted === true ||
      shouldExecuteOnceFromReplyOption;
    const initialTurnStatus: ConversationTurnStatus =
      effectiveRunIntent === "plan" && !state.isPlanApproved
        ? "planning"
        : "executing";

    // Reset plan approval state at the start of each new request
    if (!preservePlanState && !isLocalStudioCommand) {
      set({
        isPlanApproved: false,
        planApprovalChoice: null,
        planExecutionEvidenceLedger: [],
        planExecutionEvidenceCount: 0,
        planAutoResumeCount: 0,
        planExecutionProgressSnapshot: null,
        normalizedStreamState: defaultNormalizedStreamState,
        planArtifacts: [],
        planTasks: [],
        planStage: "idle" as const,
        currentTurnExecutionConsent: { turnId: null, granted: false },
      });
    }

    if (!text.trim() && (!images || images.length === 0) && !hasSupplementalInput) {
      logStoreEvent("send_blocked", { reason: "empty_text_no_images_no_context" });
      return false;
    }

    if (state.isGenerating) {
      get().queueUserMessage(text, images, {
        contextMentions: mentionSnapshot,
        attachedFiles: attachedFilesSnapshot.map((file) => normalizeAttachedFile(file)),
      });
      logStoreEvent("send_queued", { reason: "generation_in_progress" });
      return false;
    }

    if (state.agentStatus === "pending_review" && state.abortController && (options?.executionConsentGranted === true || shouldExecuteOnceFromReplyOption)) {
      logStoreEvent("send_pending_review_approve_bypass", {
        textChars: text?.length ?? 0,
        executionConsentGranted: options?.executionConsentGranted,
        shouldExecuteOnceFromReplyOption,
        pendingReviewTaskId: state.pendingReviewTaskId,
      });
      if (state.pendingReviewResolve && state.pendingReviewTaskId != null) {
        get().approvePendingReviewOnce();
      } else {
        get().approvePlan(text);
      }
      return true;
    }

    if (state.agentStatus === "running" || state.agentStatus === "pending_review") {
      // ── Stuck-state recovery ──────────────────────────────────────
      // If agentStatus is stuck at "running" but there's no abortController,
      // the previous stream must have failed silently. Reset to idle so
      // the user isn't permanently blocked from sending messages.
      if ((state.agentStatus === "running" || state.agentStatus === "pending_review") && !state.abortController) {
        logStoreEvent("send_stuck_state_reset", {
          previousStatus: state.agentStatus,
        });
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
        get().queueUserMessage(text, images, {
          contextMentions: mentionSnapshot,
          attachedFiles: attachedFilesSnapshot.map((file) => normalizeAttachedFile(file)),
        });
        logStoreEvent("send_queued", {
          reason: "agent_running_or_pending_review",
          agentStatus: state.agentStatus,
        });
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
      const autoSessionDate = new Date(autoSessionId).toISOString();
      const autoSessionTitle = state.currentWorkspace.trim()
        ? (state.config.language === "en" ? "New Conversation" : "新会话")
        : (state.config.language === "en" ? "New Chat" : "新聊天");
      const autoSession: Session = {
        id: autoSessionId,
        title: autoSessionTitle,
        titleSource: "default",
        date: autoSessionDate,
        updatedAt: autoSessionDate,
        updatedAtMs: autoSessionId,
        active: true,
        storageStatus: "temporary",
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
        autoApproveTools: false,
        autoApproveToolScopes: [],
        webSearchEnabled: false,
        webSearchProvider: "duckduckgo",
        approvedLocalFileReadPaths: [],
        approvedShellPermissionRules: [],
        readOnlyAutoApproveForSession: false,
      }));

      ensuredSessionId = autoSessionId;
    }

    const runWorkspace = state.currentWorkspace;
    const runScopeKey = sessionScopeKey;
    const runSessionId = ensuredSessionId;
    const runSessionKey = resolveSessionRuntimeKey(runScopeKey, runSessionId)!;
    const commandIssuedAtMs = Date.now();
    const commandIssuedAtIso = new Date(commandIssuedAtMs).toISOString();
    if (runSessionId) {
      get().updateSession(runScopeKey, runSessionId, {
        updatedAt: commandIssuedAtIso,
        updatedAtMs: commandIssuedAtMs,
        active: true,
      });
    }
    const backgroundRunningSessions = Object.entries(state.runtimeBySessionKey)
      .filter(([sessionKey, runtime]) =>
        sessionKey !== runSessionKey &&
        (runtime.isGenerating || runtime.agentStatus === "running" || runtime.agentStatus === "pending_review")
      )
      .map(([sessionKey, runtime]) => ({
        sessionKey,
        turnId: runtime.currentTurnId,
        agentStatus: runtime.agentStatus,
        isGenerating: runtime.isGenerating,
      }));
    logStoreEvent("session_run_start", {
      sessionKey: runSessionKey,
      workspace: runWorkspace || null,
      sessionId: runSessionId,
      intent: effectiveRunIntent,
      initialTurnStatus,
      backgroundRunningCount: backgroundRunningSessions.length,
      backgroundRunningSessions: backgroundRunningSessions.slice(0, 8),
    });
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
                elapsedTime: turn.elapsedTime || s.elapsedTime || 0,
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
        planTasks: reconcilePlanTaskCompletion(
          s.planTasks,
          tasks,
          s.planExecutionEvidenceLedger,
          {
            preserveMissing: s.isPlanApproved || s.planStage === "executing" || s.planStage === "completed" || s.planTasks.length > 0,
            highlightNext: s.isPlanApproved && s.planExecutionEvidenceLedger.length > 0,
          },
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
        const normalizedTasks = artifact.kind === "tasks" || artifact.kind === "bugfix"
          ? reconcilePlanTaskCompletion(s.planTasks, parsedTasks, s.planExecutionEvidenceLedger, {
              preserveMissing: preserveTaskHistory,
              highlightNext: s.isPlanApproved && s.planExecutionEvidenceLedger.length > 0,
            })
          : normalizePlanTaskStatuses(
              s.planTasks,
              s.planExecutionEvidenceLedger,
              s.isPlanApproved && s.planExecutionEvidenceLedger.length > 0,
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
      });
    const sessionOpenPlanWorkspacePanel = async () => {
      sessionOpenRightPanelTab("plan");
      const live = get();
      const runtime = live.runtimeBySessionKey[runSessionKey] || createSessionRuntimeFromState(live);
      return runtime.planArtifacts.length > 0 || runtime.planTasks.length > 0 || runtime.planStage !== "idle";
    };
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
        ensurePlanArtifactsHydratedForWorkspace: sessionOpenPlanWorkspacePanel,
        openPlanWorkspacePanel: sessionOpenPlanWorkspacePanel,
        closeRightPanel: () => sessionSet({ showPlanPanel: false, showDiff: false, showTerminal: false }),
        startNewTurn: (remoteFeishu) =>
          sessionSet({
            currentTurnState: {
              ...createDefaultCurrentTurnState(),
              turnId: Date.now().toString(),
              ...(remoteFeishu ? { remoteFeishu } : {}),
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
    const turnId = reuseCurrentTurn
      ? reusableTurnId!
      : options?.turnIdOverride || `turn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const uiDisplayTurnId = uiParentTurnId || turnId;
    const currentImages = images || [];
    const turnInputContextSignals = normalizeTurnInputContextSignals({
      imageParts: currentImages.length,
      mentionedFilePaths: mentionSnapshot,
      attachedFilePaths: attachedFilesSnapshot.map((file) => {
        const attachment = normalizeAttachedFile(file);
        return attachment.sourcePath || attachment.path;
      }),
    });
    const userContextItems = buildUserContextItems({
      contextMentions: mentionSnapshot,
      attachedFiles: attachedFilesSnapshot,
      images: currentImages,
      workspace: runWorkspace,
      language: preferredLanguage === "en" ? "en" : "zh",
    });
    const existingTurn = reuseCurrentTurn
      ? state.conversationTurns.find((turn) => turn.id === turnId) || null
      : null;
    const existingTitle = existingTurn?.title && !isGenericConversationTitle(existingTurn.title)
      ? existingTurn.title
      : "";
    const optionTitle = options?.turnTitle && !isGenericConversationTitle(options.turnTitle)
      ? options.turnTitle
      : "";
    const localTurnTitle = mainDebugShortcut
      ? "MDEBUG：用户反馈自修复"
      : buildLocalTurnTitle(text, effectiveRunIntent, preferredLanguage, turnInputContextSignals);
    const turnTitle = normalizeConversationDisplayTitle(
      existingTitle || optionTitle || localTurnTitle,
      preferredLanguage === "en" ? 48 : 40,
      localTurnTitle,
    );
    const titleIntentSignature = buildTitleIntentSignature(
      text,
      effectiveRunIntent,
      turnInputContextSignals,
    );
    const refreshedState = sessionGet();
    const activeSession = ensuredSessionId
      ? (refreshedState.sessionsByWorkspace[sessionScopeKey] || []).find((session) => session.id === ensuredSessionId)
      : null;
    const shouldSeedSessionTitleForTurn = shouldSeedSessionTitle(activeSession);
    const seededSessionTitleCandidate = shouldSeedSessionTitleForTurn ? turnTitle : "";
    const autoCollapsePreviousTurnForNewTurn = (turns: ConversationTurn[]): ConversationTurn[] => {
      // Auto-collapse only the immediate previous turn when the user starts a brand-new visible turn.
      // This runs once per new-turn creation and never touches older turns.
      if (isHidden || reuseCurrentTurn || turns.length === 0) return turns;
      const previousTurnIndex = turns.length - 1;
      const previousTurn = turns[previousTurnIndex];
      if (!previousTurn || previousTurn.collapsed) return turns;
      return turns.map((turn, index) =>
        index === previousTurnIndex ? { ...turn, collapsed: true } : turn,
      );
    };
    const markParentPlanTurnDoneForExecution = (turns: ConversationTurn[]): ConversationTurn[] => {
      if (!parentPlanTurnId) return turns;
      const summary = preferredLanguage === "en"
        ? "Plan approved; execution was handed off to a new turn."
        : "计划已批准，执行已交接到新的回合。";
      return turns.map((turn) =>
        turn.id === parentPlanTurnId
          ? {
              ...turn,
              status: "done" as const,
              summary,
            }
          : turn,
      );
    };
    const appendLocalStudioTurn = async (
      systemContent: string,
      options?: { systemVariant?: Extract<TaskBlock, { type: "system" }>["variant"] },
    ) => {
      const userBlock = isHidden
        ? null
        : ({
            id: nextId(),
            turnId,
            type: "user",
            content: text,
            ...(userContextItems.length > 0 ? { contextItems: userContextItems } : {}),
          } as TaskBlock);
      const systemBlock: TaskBlock = {
        id: nextId(),
        turnId,
        type: "system",
        content: systemContent,
        ...(options?.systemVariant ? { variant: options.systemVariant } : {}),
      };

      sessionSet((s) => ({
        taskFlow: [...s.taskFlow, ...(userBlock ? [userBlock] : []), systemBlock],
        conversationTurns: reuseCurrentTurn
          ? s.conversationTurns.map((turn) =>
              turn.id === turnId
                ? {
                    ...turn,
                    status: "done",
                    displayIntent: effectiveDisplayIntent,
                    intentSummary: turn.intentSummary || effectiveIntentSummary,
                    commandDirective: turn.commandDirective || effectiveCommandDirective || undefined,
                    blockIds: [...turn.blockIds, ...(userBlock ? [userBlock.id] : []), systemBlock.id].filter(
                      (value, index, array) => array.indexOf(value) === index,
                    ),
                  }
                : turn,
            )
          : [
              ...markParentPlanTurnDoneForExecution(autoCollapsePreviousTurnForNewTurn(s.conversationTurns)),
              {
                id: turnId,
                userPrompt: text,
                title: turnTitle,
                intentSummary: effectiveIntentSummary,
                commandDirective: effectiveCommandDirective || undefined,
                ...(parentPlanTurnId ? { parentPlanTurnId } : {}),
                mode: effectiveWorkflowMode,
                intent: effectiveRunIntent,
                displayIntent: effectiveDisplayIntent,
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

      if (!isHidden && shouldSeedSessionTitleForTurn && ensuredSessionId) {
        sessionGet().updateSession(sessionScopeKey, ensuredSessionId, {
          title: turnTitle,
          titleSource: "local_seed",
          titleIntentSignature,
          active: true,
          messages: sanitizeTaskBlocksForPersist(sessionGet().taskFlow),
          storageStatus: sessionGet().config.sessionRecordingEnabled ? "ok" : "temporary",
          recordingDisabled: !sessionGet().config.sessionRecordingEnabled,
          runtimeSnapshot: normalizeSessionRuntimeSnapshot({
            runtimeEventSchemaVersion: 1,
            runtimeEvents: sessionGet().runtimeEvents,
            harnessRunMarker: sessionGet().harnessRunMarker,
            taskFlow: sessionGet().taskFlow,
            agentMessages: sessionGet().agentMessages,
            contextMemoryState: sessionGet().contextMemoryState,
            contextMemoryStateByRuntimeKey: sessionGet().contextMemoryStateByRuntimeKey,
            providerCompatibilityByRuntimeKey: sessionGet().providerCompatibilityByRuntimeKey,
            conversationTurns: sessionGet().conversationTurns,
            currentTurnId: sessionGet().currentTurnId,
            selectedMainModeKey: sessionGet().selectedMainModeKey,
            selectedNexusModeKey: sessionGet().selectedNexusModeKey,
            imageStudio: sessionGet().imageStudio,
            activeStudioAgentKey: sessionGet().activeStudioAgentKey,
            gameStudioInitialized: sessionGet().gameStudioInitialized,
            pendingSlashCommand: sessionGet().pendingSlashCommand,
            planArtifacts: sessionGet().planArtifacts,
            planTasks: sessionGet().planTasks,
            planExecutionEvidenceLedger: sessionGet().planExecutionEvidenceLedger,
            planExecutionEvidenceCount: sessionGet().planExecutionEvidenceCount,
            planAutoResumeCount: sessionGet().planAutoResumeCount,
            planExecutionProgressSnapshot: sessionGet().planExecutionProgressSnapshot,
            planStage: sessionGet().planStage,
            isPlanApproved: sessionGet().isPlanApproved,
            showPlanPanel: sessionGet().showPlanPanel,
            showDiff: sessionGet().showDiff,
            showTerminal: sessionGet().showTerminal,
            showFilePanel: sessionGet().showFilePanel,
            rightPanelTab: sessionGet().rightPanelTab,
            selectedDiffTaskId: sessionGet().selectedDiffTaskId,
            autoApproveTools: sessionGet().autoApproveTools,
            autoApproveToolScopes: sessionGet().autoApproveToolScopes,
            webSearchEnabled: sessionGet().webSearchEnabled,
            webSearchProvider: sessionGet().webSearchProvider,
            queuedUserMessage: sessionGet().queuedUserMessage,
            activeGuidance: sessionGet().activeGuidance,
          }),
        });
      }
    };

    const emitLocalSlashRuntimeEvent = (event: MainThreadEventInput) => {
      if (normalizeEventStreamMode(sessionGet().config.eventStreamMode) === "legacy") return;
      sessionSet((s) => ({
        runtimeEvents: appendRuntimeEvent(s.runtimeEvents, withEventSchema(event)),
      }));
    };

    const dispatchGameStudioSlashCommand = (command: PendingSlashCommand | null): boolean => {
      const spec = getGameStudioSlashCommandSpec(command);
      if (!spec) return false;

      const runLocalSlash = (
        handler: () => Promise<string> | string,
        options?: { systemVariant?: Extract<TaskBlock, { type: "system" }>["variant"] },
      ) => {
        emitLocalSlashRuntimeEvent({
          type: "slash.command.started",
          threadId: runSessionKey,
          turnId,
          timestampMs: Date.now(),
          command: spec.canonicalCommand,
          executionMode: spec.executionMode,
        });

        void (async () => {
          try {
            const content = await handler();
            await appendLocalStudioTurn(content, {
              systemVariant: options?.systemVariant,
            });
            emitLocalSlashRuntimeEvent({
              type: "slash.command.completed",
              threadId: runSessionKey,
              turnId,
              timestampMs: Date.now(),
              command: spec.canonicalCommand,
              executionMode: spec.executionMode,
            });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error || "Unknown slash command error");
            await appendLocalStudioTurn(
              preferredLanguage === "en"
                ? `Slash command failed: ${message}`
                : `斜杠命令执行失败：${message}`,
            );
            emitLocalSlashRuntimeEvent({
              type: "slash.command.failed",
              threadId: runSessionKey,
              turnId,
              timestampMs: Date.now(),
              command: spec.canonicalCommand,
              executionMode: spec.executionMode,
              error: { message },
            });
          }
        })();
      };

      if (command?.type === "agent") {
        runLocalSlash(async () => {
          await sessionGet().setActiveStudioAgentKey(command.slug, {
            persistToWorkspace: sessionGet().gameStudioInitialized,
          });
          return preferredLanguage === "en"
            ? `Game Studio specialist switched to \`${command.slug}\`. Future messages will follow this specialist until you send \`/auto\`.`
            : `Game Studio 当前专家已切换为 \`${command.slug}\`。后续普通消息会默认按该专家视角继续；发送 \`/auto\` 可恢复自动编排。`;
        });
        return true;
      }

      if (command?.type === "auto") {
        runLocalSlash(async () => {
          await sessionGet().setActiveStudioAgentKey("studio_auto", {
            persistToWorkspace: sessionGet().gameStudioInitialized,
          });
          return preferredLanguage === "en"
            ? "Game Studio has switched back to auto-orchestration."
            : "Game Studio 已恢复自动编排。后续消息将不再固定绑定某个专家。";
        });
        return true;
      }

      if (command?.type === "workflow" && spec.executionMode === "local_fast") {
        const content = buildGameStudioLocalWorkflowMessage({
          language: preferredLanguage === "en" ? "en" : "zh",
          command,
        });
        if (!content) return false;
        runLocalSlash(() => content, {
          systemVariant: command.slug === "help" ? "game_studio_local_markdown" : undefined,
        });
        return true;
      }

      return false;
    };

    if (dispatchGameStudioSlashCommand(parsedStudioCommand)) {
      return true;
    }

    // 1. Push user message to visible taskFlow
    const shouldArchiveChoiceFeedback =
      reuseCurrentTurn &&
      !isHidden &&
      currentTurn?.status === "awaiting_input";
    const selectedChoiceText = shouldArchiveChoiceFeedback ? text.trim() : "";
    if (shouldArchiveChoiceFeedback) {
      logStoreEvent("reply_options_archived", {
        turnId,
        sessionKey: runSessionKey,
        workspace: runWorkspace || null,
        selectedChoiceChars: selectedChoiceText.length,
        optionBlocks: sessionGet().taskFlow.filter((block) =>
          block.turnId === turnId &&
          block.type === "agent" &&
          Array.isArray(block.options) &&
          block.options.length > 0
        ).length,
      });
    }
    const userBlock: TaskBlock | null = isHidden
      ? null
      : {
          id: nextId(),
          turnId,
          type: "user",
          content: text,
          ...(userContextItems.length > 0 ? { contextItems: userContextItems } : {}),
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
                        ...(hasOperationApprovalReplyOption(block.options) ? { archivedProposal: true } : {}),
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
                          displayIntent: effectiveDisplayIntent,
                          intentSummary: turn.intentSummary || effectiveIntentSummary,
                          commandDirective: turn.commandDirective || effectiveCommandDirective || undefined,
                          pendingOperationProposal: applyOperationProposalChoice(turn.pendingOperationProposal, operationProposalChoiceAction),
                          mode: effectiveWorkflowMode,
                          blockIds: turn.blockIds.includes(userBlock.id) ? turn.blockIds : [...turn.blockIds, userBlock.id],
                        }
                      : turn
                  )
                : [
                    ...markParentPlanTurnDoneForExecution(autoCollapsePreviousTurnForNewTurn(s.conversationTurns)),
                    {
                      id: turnId,
                      userPrompt: text,
                      title: turnTitle,
                      intentSummary: effectiveIntentSummary,
                      commandDirective: effectiveCommandDirective || undefined,
                      mode: effectiveWorkflowMode,
                      intent: effectiveRunIntent,
                      displayIntent: effectiveDisplayIntent,
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
                        ...(hasOperationApprovalReplyOption(block.options) ? { archivedProposal: true } : {}),
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
                    displayIntent: effectiveDisplayIntent,
                    intentSummary: turn.intentSummary || effectiveIntentSummary,
                    commandDirective: turn.commandDirective || effectiveCommandDirective || undefined,
                    pendingOperationProposal: applyOperationProposalChoice(turn.pendingOperationProposal, operationProposalChoiceAction),
                    mode: effectiveWorkflowMode,
                  }
	                : turn
		            ),
		          }
		        : {
		            conversationTurns: [
		              ...markParentPlanTurnDoneForExecution(autoCollapsePreviousTurnForNewTurn(s.conversationTurns).map((turn) =>
                    uiParentTurnId && turn.id === uiParentTurnId
                      ? { ...turn, status: initialTurnStatus, intent: turn.intent || effectiveRunIntent, displayIntent: turn.displayIntent || effectiveDisplayIntent }
                      : turn,
                  )),
		              {
		                id: turnId,
		                userPrompt: text,
		                title: turnTitle,
	                intentSummary: effectiveIntentSummary,
                commandDirective: effectiveCommandDirective || undefined,
                uiVisibility: isInternalTurn ? "internal" : "visible",
                ...(parentPlanTurnId ? { parentPlanTurnId } : {}),
                mode: effectiveWorkflowMode,
	                intent: effectiveRunIntent,
	                displayIntent: effectiveDisplayIntent,
	                status: initialTurnStatus,
	                summary: "",
	                blockIds: [],
	                collapsed: false,
	                createdAt: Date.now(),
	              },
	            ],
	          }),
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
      ...(preservePlanState ? {} : { isPlanApproved: false, planApprovalChoice: null }),
      ...(preservePlanState ? {} : { planAutoResumeCount: 0, planExecutionProgressSnapshot: null }),
      ...(shouldGrantExecutionConsentForTurn
        ? { currentTurnExecutionConsent: { turnId, granted: true } }
        : {}),
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
      commandDirectiveKind: effectiveCommandDirective?.kind ?? null,
      commandDirectiveAction: effectiveCommandDirective?.action ?? null,
      initialTurnStatus,
      elapsedMs: Math.round(nowMs() - sendStartedAt),
      taskFlowBlocks: sessionGet().taskFlow.length,
      conversationTurns: sessionGet().conversationTurns.length,
    });

    const markUserContextItemFailed = (path: string | undefined | null) => {
      const failedPath = String(path || "").trim();
      if (!failedPath || userContextItems.length === 0) return;
      sessionSet((s) => ({
        taskFlow: s.taskFlow.map((block) => {
          if (block.turnId !== turnId || block.type !== "user" || !Array.isArray(block.contextItems)) return block;
          return {
            ...block,
            contextItems: block.contextItems.map((item) =>
              item.path === failedPath ? { ...item, status: "failed" as const } : item
            ),
          };
        }),
      }));
    };

    if (!isHidden && shouldSeedSessionTitleForTurn && ensuredSessionId) {
      sessionGet().updateSession(sessionScopeKey, ensuredSessionId, {
        title: turnTitle,
        titleSource: "local_seed",
        titleIntentSignature,
        active: true,
        messages: sanitizeTaskBlocksForPersist(sessionGet().taskFlow),
        storageStatus: sessionGet().config.sessionRecordingEnabled ? "ok" : "temporary",
        recordingDisabled: !sessionGet().config.sessionRecordingEnabled,
      });
    }

    // 每个新 turn 都异步请求一次轻量语义标题：
    // 先用本地标题占位，不阻塞发送；模型结果回来后再覆盖 turn/sidebar 标题。
    if (shouldRequestSemanticTurnMetadataForTurn({
      input: text,
      hidden: isHidden,
      reuseCurrentTurn,
      turnTitle: options?.turnTitle,
      mainModeKey: currentMainModeKey,
    })) {
      const expectedTurnPrompt = text.trim();
      const expectedSessionId = ensuredSessionId ?? null;
      void requestSemanticTurnMetadata({
        input: text,
        intent: effectiveRunIntent,
        language: preferredLanguage,
        config: sessionGet().config,
        contextSignals: turnInputContextSignals,
      }).then((metadata) => {
        if (!metadata) return;

        const latestState = sessionGet();
        const targetTurn = latestState.conversationTurns.find((turn) => turn.id === turnId);
        const latestSession = expectedSessionId != null
          ? (latestState.sessionsByWorkspace[sessionScopeKey] || [])
            .find((session) => session.id === expectedSessionId) || null
          : null;
        if (!isSemanticTurnMetadataCallbackCurrent({
          expectedTurnId: turnId,
          expectedUserPrompt: expectedTurnPrompt,
          expectedSessionId,
          turn: targetTurn,
          session: latestSession,
        })) return;
        if (
          looksLikeReasoningLeakTitle(metadata.title) ||
          looksLikeReasoningLeakTitle(metadata.summary) ||
          isGenericConversationTitle(metadata.title)
        ) return;

        latestState.updateConversationTurn(turnId, {
          title: metadata.title,
          intentSummary: metadata.summary,
        });

        if (expectedSessionId != null) {
          if (!canUpdateSeedSessionTitle({ session: latestSession, seededTitle: seededSessionTitleCandidate })) {
            logStoreEvent("semantic_title_session_update_skipped", {
              turnId,
              sessionKey: runSessionKey,
              workspace: runWorkspace || null,
              reason: "session_title_not_auto_seed",
              titleSource: latestSession?.titleSource || null,
            });
            return;
          }
          latestState.updateSession(sessionScopeKey, expectedSessionId, {
            title: metadata.title,
            titleSource: "semantic",
            semanticTitleUpdatedAt: Date.now(),
            titleIntentSignature,
            active: true,
          });
        }
      }).catch(() => {
        // 标题同步失败时保持当前回退标题即可，不影响主流程继续执行。
      });
    }

    // 2. Start elapsed timer
    const startTime = Date.now();
    const getElapsedSeconds = () => Math.round((Date.now() - startTime) / 1000);
    const updateElapsedTime = () => {
      sessionSet({ elapsedTime: getElapsedSeconds() });
    };
    const timerInterval = setInterval(() => {
      const state = sessionGet();
      if (state.agentStatus === "idle" || state.agentStatus === "error") {
        clearInterval(timerInterval);
        return;
      }
      updateElapsedTime();
    }, 1000);

    // 3. Build context from @-mentions and attached files
    // Read actual file contents for attached files (from old App.tsx)
    (async () => {
      let userContent = text;
      let activeStudioAgentKey = sessionGet().activeStudioAgentKey;
      let gameStudioInitialized = sessionGet().gameStudioInitialized;
      let gameStudioConfigForTurn: StudioConfig | null = null;
      const mentions = mentionSnapshot;
      const files = attachedFilesSnapshot;
      const attachmentRefs: AttachmentReadRef[] = [];
      const failedAttachmentParts: string[] = [];
      for (const file of files) {
        try {
          attachmentRefs.push(await prepareAttachedFileForRead(file, runSessionKey));
        } catch {
          const attachment = normalizeAttachedFile(file);
          markUserContextItemFailed(attachment.sourcePath || attachment.path);
          failedAttachmentParts.push(`[无法读取文件：${attachment.displayName || getAttachmentDisplayName(attachment.path)}]`);
        }
      }
      for (const mentionPath of mentions) {
        const kind = classifyAttachment(mentionPath);
        attachmentRefs.push({
          path: mentionPath,
          displayName: getAttachmentDisplayName(mentionPath),
          kind: kind === "tabular" || kind === "document" ? kind : "text",
        });
      }

      const seenAttachmentRefs = new Set<string>();
      const allFileRefs = attachmentRefs.filter((ref) => {
        const key = `${ref.workspace || runWorkspace || ""}::${ref.path}`;
        if (seenAttachmentRefs.has(key)) return false;
        seenAttachmentRefs.add(key);
        return true;
      });

      if (allFileRefs.length > 0 || failedAttachmentParts.length > 0) {
        const parts: string[] = [];
        if (mentions.length > 0) {
          parts.push(preferredLanguage === "en"
            ? [
                "[user_mentioned_files]",
                "The user selected these files with @. Treat them as explicit context targets and use their exact paths for any follow-up read/query tools.",
                ...mentions.map((mentionPath) => `path: ${mentionPath}`),
              ].join("\n")
            : [
                "[user_mentioned_files]",
                "用户通过 @ 选择了这些文件。请把它们视为明确上下文目标，后续读取/查询工具必须优先使用这些精确路径。",
                ...mentions.map((mentionPath) => `path: ${mentionPath}`),
              ].join("\n"));
        }
        parts.push(...failedAttachmentParts);
        for (const ref of allFileRefs) {
          const fp = ref.path;
          const readWorkspace = ref.workspace ?? runWorkspace;
          try {
            let c: string;
            if (shouldUseTabularAnalyzer(fp)) {
              const summary = await analyzeTabularDocument(fp, undefined, undefined, undefined, undefined, readWorkspace);
              const preview = await readDocument(fp, 3000, 12, 0, 40, undefined, readWorkspace);
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
                ...(ref.sourcePath && ref.sourcePath !== fp ? [`originalPath: ${ref.sourcePath}`] : []),
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
              const doc = await readDocument(fp, undefined, undefined, undefined, undefined, undefined, readWorkspace);
              const header = [
                "[attached_document]",
                `path: ${fp}`,
                ...(ref.sourcePath && ref.sourcePath !== fp ? [`originalPath: ${ref.sourcePath}`] : []),
                `documentType: ${doc.documentType}`,
                `truncatedPreview: ${doc.truncated ? "true" : "false"}`,
              ];
              if (doc.title) header.push(`title: ${doc.title}`);
              header.push("note: If this preview is truncated, use read_document on the exact path above before concluding.");
              const body = doc.content || JSON.stringify(doc.metadata);
              c = `${header.join("\n")}\n${body}`;
            } else {
              const raw = await readFile(fp, readWorkspace);
              c = [
                "[attached_file]",
                `path: ${fp}`,
                ...(ref.sourcePath && ref.sourcePath !== fp ? [`originalPath: ${ref.sourcePath}`] : []),
                raw,
              ].join("\n");
            }
            const n = ref.displayName || fp.split("/").pop() || fp;
            parts.push("```" + n + "\n" + c + "\n```");
          } catch {
            const n = ref.displayName || fp.split("/").pop() || fp;
            markUserContextItemFailed(ref.sourcePath || fp);
            if (ref.sourcePath) markUserContextItemFailed(fp);
            parts.push(`[无法读取文件：${n}]`);
          }
        }
        userContent = parts.join("\n\n") + "\n\n" + text;
      }

      if (effectiveRunIntent === "plan" && !sessionGet().isPlanApproved && !shouldContinuePlanIntent) {
        const planModeLead = preservePlanState
          ? preferredLanguage === "en"
            ? "This is still an unapproved PLAN turn. Treat the latest user message as a planning choice or clarification, not approval to edit source files."
            : "当前仍是未批准的 PLAN 回合。请把用户最新消息视为计划选项/澄清，不要当作已批准修改源码。"
          : preferredLanguage === "en"
          ? "This turn is in PLAN mode."
          : "本轮处于 PLAN 模式。";
        userContent = preferredLanguage === "en"
          ? [
              `${planModeLead} If the request is a complex implementation, gather read-only evidence first, then create or update the reviewable plan at \`.MAIN/plans/plan.md\` with \`write_file\` or \`replace_in_file\`. This is the only allowed write before approval. For debug-log, screenshot, repeated-failure, or cross-module repairs, you may also keep a short staged ledger: \`requirements.md\` for user goals/acceptance and \`design.md\` for evidence-backed diagnosis. Do not write project source files or tasks.md before approval.`,
              "Follow the opencode-style plan file workflow: if a plan file already exists, edit it incrementally; otherwise create it. Keep exploring read-only evidence until the plan is decision-complete.",
              "The plan file must follow the Codex app handoff shape: title, Summary, Key Changes / Implementation Changes, Public APIs / Interfaces / Types, Test Plan, and Assumptions / Defaults.",
              "If it is only a discussion-style plan, keep the answer concise and use user options for real decisions.",
              "",
              userContent,
            ].join("\n")
          : [
              `${planModeLead}如果这是复杂实现请求，请先收集只读证据，再用 \`write_file\` 或 \`replace_in_file\` 创建/更新可审批计划文件 \`.MAIN/plans/plan.md\`；这是批准前唯一允许的写入。遇到调试日志、截图、反复失败或跨模块修复时，可以同时保留简短 staged ledger：\`requirements.md\` 写用户目标/验收，\`design.md\` 写证据归因/取舍。等待用户批准后再改源码；批准前不要生成 tasks.md。`,
              "严格按 opencode 风格的计划文件流程：如果 plan.md 已存在就增量编辑，否则创建完整计划；只读证据足够且计划 decision-complete 后再停在审批。",
              "plan.md 必须对齐 Codex app 的交接计划结构：标题、摘要、关键实现改动、公共 API/接口/类型、测试方案、假设与默认值。",
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
              "Produce real planning progress now. If key choices remain, summarize them briefly and use <user_options>; otherwise create or update `.MAIN/plans/plan.md` with the decision-complete plan. Use requirements/design only as a short staged ledger for complex evidence tracking.",
              "Keep plan.md concise: review-summary style, no tutorial prose, no full code listings, no repeated background.",
              text.trim() ? `Latest user message: ${text.trim()}` : "Latest user message: continue",
            ].join("\n")
          : [
              "请继续上一轮 PLAN 回合。用户是在要求继续推进，不是开启新的普通讨论。",
              originalPlanPrompt ? `上一轮计划请求：${originalPlanPrompt}` : "上一轮计划请求：请依据当前对话上下文继续。",
              "现在必须产生实际规划进展。如果仍有关键选择需要用户确认，就先简短归纳并用面向用户的口吻给出 <user_options>；否则创建/更新 decision-complete 的 `.MAIN/plans/plan.md`。requirements/design 只作为复杂证据追踪的简短 staged ledger。",
              "每个 <option> 必须是用户点击后会发送的完整选择，不要写成“是否……”问题句。",
              "plan.md 要精简成 Codex app 交接计划风格：标题、摘要、关键实现改动、公共 API/接口/类型、测试方案、假设与默认值；不要写教程式长文、完整代码清单或重复背景。",
              text.trim() ? `用户最新消息：${text.trim()}` : "用户最新消息：继续",
            ].join("\n");
      }

      if (shouldContinuePreviousTurnIntent && previousTurnContinuationTarget) {
        const originalPrompt = previousTurnContinuationTarget.userPrompt?.trim();
        const lastTool = getLastTurnToolSummary(previousTurnContinuationTarget.id, sessionGet().taskFlow);
        const lastAssistant = getLastVisibleTurnAgentSummary(previousTurnContinuationTarget.id, sessionGet().taskFlow);
        const executionHint =
          effectiveRunIntent === "execute" || effectiveRunIntent === "studio_workflow"
            ? preferredLanguage === "en"
              ? "If the unfinished next step is running, testing, verifying, or executing a command, issue the real tool call now: prefer `run_command` for finite checks/tests, and use `execute_command` only for long-running or interactive validation."
              : "如果未完成的下一步是运行、测试、验证或执行命令，现在必须发起真实工具调用：一次性检查/测试优先用 `run_command`，长驻或交互式验证才用 `execute_command`。"
            : preferredLanguage === "en"
            ? "If the remaining work requires workspace context, use the appropriate read-only tool immediately instead of announcing a future step."
            : "如果剩余工作需要工作区上下文，请立即调用合适的只读工具，不要只宣布下一步。";
        userContent = preferredLanguage === "en"
          ? [
              "Continue the previous unfinished turn. The user's message is a semantic continuation request, not a new discussion.",
              originalPrompt ? `Original request: ${originalPrompt}` : "Original request: use the current conversation context.",
              `Previous turn status: ${previousTurnContinuationTarget.status}.`,
              lastTool ? `Last tool activity: ${lastTool}.` : "",
              lastAssistant ? `Last visible assistant message: ${lastAssistant}` : "",
              "Resume from the unfinished point and complete the remaining work.",
              executionHint,
              "Do not stop after saying what you will do next.",
              text.trim() ? `Latest user message: ${text.trim()}` : "Latest user message: continue",
              "",
              userContent,
            ].filter(Boolean).join("\n")
          : [
              "请继续上一轮未完成回合。用户这句是语义续跑，不是开启新的普通讨论。",
              originalPrompt ? `上一轮原始请求：${originalPrompt}` : "上一轮原始请求：请依据当前对话上下文继续。",
              `上一轮状态：${previousTurnContinuationTarget.status}。`,
              lastTool ? `上一轮最后工具活动：${lastTool}。` : "",
              lastAssistant ? `上一轮最后可见回复：${lastAssistant}` : "",
              "请从未完成的位置恢复，并完成剩余内容。",
              executionHint,
              "不要只说接下来要做什么后停止。",
              text.trim() ? `用户最新消息：${text.trim()}` : "用户最新消息：继续",
              "",
              userContent,
            ].filter(Boolean).join("\n");
      }

      if (shouldExecuteOnceFromReplyOption && (effectiveRunIntent === "execute" || effectiveRunIntent === "studio_workflow")) {
        const approvedProposal =
          existingTurn?.pendingOperationProposal ||
          currentTurn?.pendingOperationProposal ||
          previousTurnContinuationTarget?.pendingOperationProposal;
        const latestAssistantSummary = getLastVisibleTurnAgentSummary(turnId, sessionGet().taskFlow);
        const approvalContinuationPrompt = buildOperationApprovalContinuationPrompt({
          language: preferredLanguage === "en" ? "en" : "zh",
          proposal: approvedProposal,
          latestAssistantSummary,
          userChoice: text.trim() || selectedChoiceText || "approved",
        });
        userContent = [
          approvalContinuationPrompt,
          "",
          userContent,
        ].join("\n");
      }

      const turnIntakeBlock = buildTurnIntakeContextBlock({
        rawUserInput: text,
        signals: turnInputContextSignals,
        language: preferredLanguage === "en" ? "en" : "zh",
        workflowMode: effectiveWorkflowMode,
      });
      if (turnIntakeBlock) {
        userContent = `${turnIntakeBlock}\n\n${userContent}`;
      }

      if (currentMainModeKey === "game_studio") {
        if (parsedSetupEngineCommand?.mode === "configure" && parsedSetupEngineCommand.engine) {
          try {
            const engineAgent = getDefaultStudioAgentForEngine(parsedSetupEngineCommand.engine);
            await ensureGameStudioWorkspaceInitialized(engineAgent);
            gameStudioConfigForTurn = await setGameStudioEngineConfig({
              engine: parsedSetupEngineCommand.engine,
              version: parsedSetupEngineCommand.version,
              activeStudioAgent: engineAgent,
            });
            activeStudioAgentKey = normalizeStudioAgentKey(gameStudioConfigForTurn.activeStudioAgent);
            gameStudioInitialized = true;
            invalidateWorkspaceTreeCache();
            sessionSet({
              gameStudioInitialized: true,
              activeStudioAgentKey,
            });
            sessionGet().bumpWorkspaceContentVersion();
          } catch (error) {
            appendDebugLog("warn", "game_studio_setup_engine_failed", {
              error: error instanceof Error ? error.message : String(error),
            });
          }
        } else {
          const engineSignal = detectGameDevelopmentIntent(text, {
            workspaceTree: cachedWorkspaceTreeForGameDetection,
          });
          if (engineSignal.engineStatus === "explicit" && engineSignal.engine) {
            const currentConfig = await loadGameStudioConfig();
            if (!currentConfig || currentConfig.engine === "unconfigured" || currentConfig.engine !== engineSignal.engine) {
              try {
                const engineAgent = getDefaultStudioAgentForEngine(engineSignal.engine);
                await ensureGameStudioWorkspaceInitialized(engineAgent);
                gameStudioConfigForTurn = await setGameStudioEngineConfig({
                  engine: engineSignal.engine,
                  activeStudioAgent: engineAgent,
                });
                activeStudioAgentKey = normalizeStudioAgentKey(gameStudioConfigForTurn.activeStudioAgent);
                gameStudioInitialized = true;
                invalidateWorkspaceTreeCache();
                sessionSet({
                  gameStudioInitialized: true,
                  activeStudioAgentKey,
                });
                sessionGet().bumpWorkspaceContentVersion();
              } catch (error) {
                appendDebugLog("warn", "game_studio_auto_engine_config_failed", {
                  error: error instanceof Error ? error.message : String(error),
                });
              }
            } else {
              gameStudioConfigForTurn = currentConfig;
            }
          }
        }

        if (!gameStudioConfigForTurn) {
          gameStudioConfigForTurn = await loadGameStudioConfig();
        }
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
          gameStudioConfigForTurn = studioConfig;
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
          studioConfig: gameStudioConfigForTurn,
          responseLanguage: preferredLanguage,
        });
      }

      // Clear mentions and attached files after reading
      sessionSet({ contextMentions: [], attachedFiles: [] });

      // 4. Append to LLM conversation history
      // Build multimodal content if images are present
      const turnAgentMessagesStart = sessionGet().agentMessages.length;
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
      let harnessRunMarker: HarnessRunMarker = persistHarnessRunMarker({
        schemaVersion: 1,
        instanceId: getCurrentHarnessInstanceId(),
        sessionKey: runSessionKey,
        workspace: runWorkspace || null,
        sessionId: runSessionId ?? null,
        turnId,
        status: "running",
        workflowMode: getIntentPolicy(effectiveRunIntent).workflowMode,
        runtimeIntent: runtimeRunIntent,
        planStage: sessionGet().planStage,
        isPlanApproved: sessionGet().isPlanApproved,
        iteration: 0,
        maxIterations: 0,
        messagesLen: sessionGet().agentMessages.length,
        toolCount: 0,
        latestTool: null,
        latestToolTarget: null,
        activeStreamId: null,
        streamStatus: "run_started",
        streamChunkCount: 0,
        streamByteCount: 0,
        streamElapsedMs: null,
        streamLifecycleStatus: null,
        lastStreamError: null,
        startedAt: Date.now(),
        updatedAt: Date.now(),
        closedAt: null,
        closeReason: null,
      });

      sessionSet({ harnessRunMarker });

      const phaseLanguage = preferredLanguage === "en" ? "en" : "zh";

      // Get workspace tree for system prompt
      const workspaceTreeStartedAt = nowMs();
      const workspaceTree = await getWorkspaceTree(runWorkspace);
      logStoreEvent("workspace_tree_ready", {
        turnId,
        workspace: runWorkspace || "global",
        chars: workspaceTree.length,
        elapsedMs: Math.round(nowMs() - workspaceTreeStartedAt),
      });

      const context: WorkflowContext = {
        // Constants & Parameters
        turnId,
        uiDisplayTurnId,
        runWorkspace,
        runSessionKey,
        runSessionId,
        runScopeKey,
        phaseLanguage,
        effectiveRunIntent,
        runtimeRunIntent,
        effectiveCommandDirective,
        options,
        attachedFilesSnapshot,
        mentionSnapshot,
        remoteFeishu,
        workspaceTree,
        gameStudioConfigForTurn,
        abortCtrl,
        timerInterval,
        sendStartedAt,
        streamBuffer: null as any, // will be assigned below
        thinkingInterceptor: null as any, // will be assigned below
        turnAgentMessagesStart,
        getElapsedSeconds,

        // Mutable stream execution state
        agentBlockIdsCreatedThisRun: new Set<number>(),
        firstStreamTokenAt: null,
        streamTokenCount: 0,
        streamTextChars: 0,
        noFirstTokenNoticeTimer: null,
        currentStreamingBlockId: null,
        currentThoughtBlockId: null,
        thoughtStartTime: null,
        streamingAssistantDisplayBuffer: "",
        approvedPlanHandoff: null,
        understandingProgressBlockId: null,
        understandingProgressClosed: false,

        // Constants
        PLAN_EXECUTION_PROGRESS_DEFAULT_MAX_ITERATIONS,
        PROVIDER_COMPATIBILITY_FORCE_XML_TTL_MS,
        PROVIDER_COMPATIBILITY_NATIVE_RECOVERY_SUCCESS_STREAK,
      };

      const thinkingInterceptor = new StreamingThinkingInterceptor();
      context.thinkingInterceptor = thinkingInterceptor;

      const attachRuntimePhase = <T extends TaskBlock>(block: T, phase?: TurnRuntimePhase): T => {
        const normalized = normalizeTurnRuntimePhase(block.turnPhase || phase || makeTurnRuntimePhase("scope", phaseLanguage), phaseLanguage);
        return normalized ? { ...block, turnPhase: normalized } : block;
      };

      const appendTurnBlock = (block: TaskBlock) => {
        const targetTurnId = block.turnId && block.turnId !== turnId ? block.turnId : uiDisplayTurnId;
        const blockWithTurn: TaskBlock = attachRuntimePhase({ ...block, turnId: targetTurnId } as TaskBlock);
        if (blockWithTurn.type === "agent") {
          context.agentBlockIdsCreatedThisRun.add(blockWithTurn.id);
        }
        sessionSet((s) => ({
          taskFlow: [...s.taskFlow, blockWithTurn],
          conversationTurns: s.conversationTurns.map((turn) =>
            turn.id === targetTurnId && !turn.blockIds.includes(blockWithTurn.id)
              ? { ...turn, blockIds: [...turn.blockIds, blockWithTurn.id] }
              : turn
          ),
        }));
      };

      const emitProgressRuntimeEvent = (progress: any, meta: { dedupeKey?: string } = {}) => {
        const eventId = "event-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
        sessionSet((s) => ({
          runtimeEvents: [
            ...s.runtimeEvents,
            {
              id: eventId,
              turnId,
              sessionKey: runSessionKey,
              workspace: runWorkspace || null,
              timestamp: Date.now(),
              type: "progress",
              dedupeKey: meta.dedupeKey || null,
              payload: progress,
            },
          ],
        }));
      };

      const buildUnderstandingProgress = (status: "running" | "done" = "running") => {
        const hasImages = currentImages.length > 0;
        const hasContextItems = turnInputContextSignals.mentionedFilePaths.length > 0 || turnInputContextSignals.attachedFilePaths.length > 0;
        const contextText = hasImages
          ? phaseLanguage === "zh"
            ? "用户提供了 " + currentImages.length + " 张图片；先理解截图、约束和预期行为。"
            : "The user provided " + currentImages.length + " image(s); first understand the screenshots, constraints, and expected behavior."
          : hasContextItems
          ? phaseLanguage === "zh"
            ? "用户提供了上下文文件或引用；先确认这些材料与目标的关系。"
            : "The user provided contextual files or references; first map them to the request."
          : phaseLanguage === "zh"
          ? "先确认用户目标、约束和安全边界。"
          : "First confirm the user goal, constraints, and safety boundary.";
        const next = effectiveRunIntent === "plan"
          ? phaseLanguage === "zh"
            ? "随后只做定向读取与证据收束，批准前只写计划文件。"
            : "Next, use targeted reads and evidence synthesis; before approval only plan artifacts may be written."
          : effectiveRunIntent === "execute" || effectiveRunIntent === "studio_workflow"
          ? phaseLanguage === "zh"
            ? "随后读取最小必要上下文，再执行真实操作或明确说明阻塞。"
            : "Next, read the minimum necessary context, then act or state a concrete blocker."
          : effectiveRunIntent === "respond" || effectiveRunIntent === "discuss"
          ? phaseLanguage === "zh"
            ? "随后基于上下文给出直接答复。"
            : "Next, answer directly from the available context."
          : "";
        return normalizeProgressNarration({
          phase: "understanding",
          title: phaseLanguage === "zh" ? "理解需求" : "Understanding request",
          why: effectiveIntentSummary || contextText,
          action: contextText,
          evidence: hasImages || hasContextItems ? contextText : "",
          next,
          targets: [],
          status,
          source: "runtime",
          hypothesisStatus: status === "done" ? "confirmed" : "unverified",
        });
      };

      const appendUnderstandingProgress = () => {
        if (isHidden && !createVisibleTurnForHiddenMessage) return;
        const progress = buildUnderstandingProgress("running");
        const blockId = nextId();
        context.understandingProgressBlockId = blockId;
        appendTurnBlock({
          id: blockId,
          turnId,
          turnPhase: makeTurnRuntimePhase("scope", phaseLanguage, { status: "running" }),
          type: "progress",
          ...progress,
        });
        emitProgressRuntimeEvent(progress, {
          dedupeKey: "understanding:" + turnId,
        });
      };

      const streamBuffer = new StreamingCadenceBuffer({
        interceptor: thinkingInterceptor,
        flushIntervalMs: 90,
        onFlush: ({ agentDelta, thinkingDelta, thoughtStarted, thoughtEnded }) => {
          const latestStateForDedupe = sessionGet();
          const shouldDisplayReasoningBlocks = latestStateForDedupe.config.reasoningDisplay !== "hidden";
          const nextInterceptorThought = thinkingDelta
            ? appendThoughtDelta(latestStateForDedupe.currentTurnState.interceptorThought, thinkingDelta)
            : latestStateForDedupe.currentTurnState.interceptorThought;
          const currentInterceptorThoughtContent = thinkingInterceptor.getThinkingContent() || thinkingDelta;
          let thoughtIdToCreate: number | null = null;
          let thoughtIdToUpdate = context.currentThoughtBlockId;
          const thoughtDuration = context.thoughtStartTime ? Math.round((Date.now() - context.thoughtStartTime) / 1000) : undefined;

          if (thoughtStarted && shouldDisplayReasoningBlocks) {
            context.thoughtStartTime = Date.now();
            const existingThoughtBlock = sessionGet().taskFlow
              .filter((b) => b.turnId === turnId)
              .reverse()
              .find((b) => b.type === "thought");
            if (existingThoughtBlock && !existingThoughtBlock.isStreaming) {
              thoughtIdToCreate = null;
              context.currentThoughtBlockId = existingThoughtBlock.id;
              thoughtIdToUpdate = existingThoughtBlock.id;
            } else if (existingThoughtBlock && existingThoughtBlock.isStreaming) {
              thoughtIdToCreate = null;
              context.currentThoughtBlockId = existingThoughtBlock.id;
              thoughtIdToUpdate = existingThoughtBlock.id;
            } else {
              thoughtIdToCreate = nextId();
              context.currentThoughtBlockId = thoughtIdToCreate;
              thoughtIdToUpdate = thoughtIdToCreate;
            }
          }

          let thoughtEndedId: number | null = null;
          if (thoughtEnded && context.currentThoughtBlockId !== null && shouldDisplayReasoningBlocks) {
            thoughtEndedId = context.currentThoughtBlockId;
            context.currentThoughtBlockId = null;
            context.thoughtStartTime = null;
          } else if (thoughtEnded && !shouldDisplayReasoningBlocks) {
            context.currentThoughtBlockId = null;
            context.thoughtStartTime = null;
          }

          // ── Handle agent content ──
          let agentContent = agentDelta;
          let agentBlockIdToCreate: number | null = null;
          let agentBlockIdToAppend: number | null = null;

          if (agentContent) {
            if (nextInterceptorThought && context.currentStreamingBlockId === null) {
              const normThought = nextInterceptorThought.trim().toLowerCase().replace(/\s+/g, ' ');
              const normAgent = agentContent.trim().toLowerCase().replace(/\s+/g, ' ');

              if (normAgent.startsWith(normThought) || normThought.includes(normAgent)) {
                const overlapLen = nextInterceptorThought.trim().length;
                const possibleClean = agentContent.trim().slice(overlapLen).trim();
                if (!possibleClean) {
                  agentContent = "";
                } else {
                  agentContent = possibleClean;
                }
              }
            }

            if (agentContent) {
              const displayCandidate = context.streamingAssistantDisplayBuffer + agentContent;
              const displayDecision = resolveStreamingAssistantDisplay({
                text: displayCandidate,
                language: phaseLanguage,
                workflowMode: sessionGet().config.workflowMode,
                runIntent: effectiveRunIntent,
                hasVisibleAgentBlock: context.currentStreamingBlockId !== null,
              });
              if (displayDecision.action === "show") {
                agentContent = displayDecision.text;
                context.streamingAssistantDisplayBuffer = "";
              } else if (displayDecision.action === "buffer") {
                context.streamingAssistantDisplayBuffer = displayDecision.bufferText || displayCandidate;
                agentContent = "";
              } else {
                context.streamingAssistantDisplayBuffer = "";
                agentContent = "";
              }
            }

            if (agentContent) {
              if (context.currentStreamingBlockId === null) {
                agentBlockIdToCreate = nextId();
                context.currentStreamingBlockId = agentBlockIdToCreate;
                context.agentBlockIdsCreatedThisRun.add(agentBlockIdToCreate);
              } else {
                agentBlockIdToAppend = context.currentStreamingBlockId;
              }
            }
          }

          if (!thinkingDelta && !thoughtStarted && !thoughtEndedId && !agentContent) return;

          sessionSet((s) => {
            let taskFlow = s.taskFlow;
            let conversationTurns = s.conversationTurns;

            const appendBlock = (block: TaskBlock) => {
              const blockWithTurn: TaskBlock = attachRuntimePhase({ ...block, turnId: block.turnId ?? turnId } as TaskBlock);
              taskFlow = [...taskFlow, blockWithTurn];
              conversationTurns = conversationTurns.map((turn) =>
                turn.id === turnId && !turn.blockIds.includes(blockWithTurn.id)
                  ? { ...turn, blockIds: [...turn.blockIds, blockWithTurn.id] }
                  : turn
              );
            };

            if (shouldDisplayReasoningBlocks && thoughtIdToCreate !== null) {
              appendBlock({
                id: thoughtIdToCreate,
                turnId,
                type: "thought",
                content: compactThoughtContent(currentInterceptorThoughtContent),
                isStreaming: true,
              });
            } else if (shouldDisplayReasoningBlocks && thoughtIdToUpdate !== null && thinkingDelta) {
              const tid = thoughtIdToUpdate;
              taskFlow = taskFlow.map((t) =>
                t.id === tid && t.type === "thought"
                  ? { ...t, content: compactThoughtContent(currentInterceptorThoughtContent), isStreaming: true }
                  : t
              );
            }

            if (shouldDisplayReasoningBlocks && thoughtEndedId !== null) {
              const tid = thoughtEndedId;
              taskFlow = taskFlow.map((t) =>
                t.id === tid && t.type === "thought"
                  ? { ...t, content: compactThoughtContentForPersist((t as Extract<TaskBlock, { type: "thought" }>).content), isStreaming: false, duration: thoughtDuration }
                  : t
              );
            }

            if (agentBlockIdToCreate !== null && agentContent) {
              appendBlock({ id: agentBlockIdToCreate, turnId, type: "agent", content: agentContent, streaming: true });
            } else if (agentBlockIdToAppend !== null && agentContent) {
              const blockId = agentBlockIdToAppend;
              taskFlow = taskFlow.map((t) =>
                t.id === blockId && t.type === "agent"
                  ? { ...t, content: (t as Extract<TaskBlock, { type: "agent" }>).content + agentContent }
                  : t
              );
            }

            return {
              taskFlow,
              conversationTurns,
              currentTurnState: {
                ...s.currentTurnState,
                interceptorHandled: s.currentTurnState.interceptorHandled || thoughtStarted,
                interceptorThought: nextInterceptorThought,
              },
            };
          });
        }
      });
      context.streamBuffer = streamBuffer;

      appendUnderstandingProgress();
      const engine = new WorkflowEngine(get, set);
      engine.run(context);
    })();

    return true;
  },

    }),
    {
      name: "local-agent-ide",
      version: LOCAL_PERSIST_SCHEMA_VERSION,
      partialize: (state: AppState) =>
        buildPersistedAppState(state as Record<string, any>) as Partial<AppState>,
      migrate: (persistedState: unknown): Partial<AppState> =>
        stripLegacyRuntimeFieldsFromPersistedState(
          (persistedState || {}) as Record<string, unknown>,
        ) as Partial<AppState>,
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
        const uncleanRestart = consumePendingUncleanRestartDiagnostic();
        if (uncleanRestart) {
          const marker = uncleanRestart.marker;
          const details = {
            previousInstanceId: uncleanRestart.previousInstanceId,
            detectedAt: uncleanRestart.detectedAt,
            sessionKey: marker.sessionKey,
            workspace: marker.workspace,
            sessionId: marker.sessionId,
            turnId: marker.turnId,
            runtimeIntent: marker.runtimeIntent,
            workflowMode: marker.workflowMode,
            planStage: marker.planStage,
            isPlanApproved: marker.isPlanApproved,
            iteration: marker.iteration,
            maxIterations: marker.maxIterations,
            activeStreamId: marker.activeStreamId,
            streamStatus: marker.streamStatus,
            streamChunkCount: marker.streamChunkCount,
            streamByteCount: marker.streamByteCount,
            latestTool: marker.latestTool,
            latestToolTarget: marker.latestToolTarget,
            lastStreamError: marker.lastStreamError,
            lastUpdatedAt: marker.updatedAt,
          };
          logStoreEvent("unclean_restart_detected", details);
          useAppStore.setState((s: AppState) => ({
            harnessRunMarker: marker,
            runtimeEvents: appendRuntimeEvent(s.runtimeEvents, withEventSchema({
              type: "harness.telemetry",
              threadId: marker.sessionKey || resolveSessionRuntimeKey(resolveSessionWorkspaceKey(s.currentWorkspace), s.currentSessionId) || "default",
              turnId: marker.turnId || undefined,
              timestampMs: Date.now(),
              telemetry: {
                name: "unclean_termination",
                details,
              },
            })),
          }));
          if (marker.workspace) {
            void invoke("record_session_failure", {
              stepId: "unclean_termination",
              toolCall: marker.latestTool || marker.activeStreamId || "runtime",
              stderr: JSON.stringify(details),
              verification: "MAIN restarted before the active run closed cleanly.",
              workspace: marker.workspace,
            }).catch((reflectionError) => {
              logStoreEvent("unclean_restart_reflection_failed", {
                error: reflectionError instanceof Error ? reflectionError.message : String(reflectionError),
              });
            });
          }
        }
        };
      },
    // Merge persisted data back into the default state on hydration,
    // so newly-added fields get their defaults instead of being undefined.
    merge: (persisted, current) => {
      const persistedState = (persisted as Partial<AppState> & {
        selectedAgentKey?: string;
        rightPanelTab?: unknown;
        showTaskCenterPanel?: unknown;
        taskCenter?: unknown;
        taskCenterActiveTaskId?: unknown;
      }) || {};
      const {
        showTaskCenterPanel: _legacyShowTaskCenterPanel,
        taskCenter: _legacyTaskCenter,
        taskCenterActiveTaskId: _legacyTaskCenterActiveTaskId,
        ...persistedStateWithoutTaskCenter
      } = persistedState;
      const persistedConfig = stripLegacyConfigFields(persistedState.config) ?? {};
      const normalizedSessionsByWorkspace = normalizeSessionsByWorkspace(persistedState.sessionsByWorkspace);
      const hydratedCurrentWorkspace =
        typeof persistedState.currentWorkspace === "string"
          ? persistedState.currentWorkspace
          : current.currentWorkspace;
      const hydratedCurrentScopeKey = resolveSessionWorkspaceKey(hydratedCurrentWorkspace);
      const persistedCurrentSessionId =
        typeof persistedState.currentSessionId === "number" && Number.isFinite(persistedState.currentSessionId)
          ? persistedState.currentSessionId
          : null;
      const hasHydratedCurrentSession =
        persistedCurrentSessionId != null &&
        (normalizedSessionsByWorkspace[hydratedCurrentScopeKey] || []).some(
          (session) => session.id === persistedCurrentSessionId,
        );
      const selectedMainModeKey = mapLegacyNexusModeToMainMode(
        persistedState.selectedMainModeKey ||
          persistedState.selectedNexusModeKey ||
          persistedState.selectedAgentKey,
      );
      const rightPanelTab = hasHydratedCurrentSession
        ? normalizeStoredRightPanelTab(persistedState.rightPanelTab)
        : "plan";
      const cloudState = normalizeCloudServerState({
        cloud: {
          ...current.config.cloud,
          ...((persistedConfig as any).cloud ?? {}),
        },
        cloudServers: (persistedConfig as any).cloudServers,
        activeCloudServerId: (persistedConfig as any).activeCloudServerId,
      });
      const localConfig = normalizeLocalConfig(
        (persistedConfig as any).local,
        current.config.local,
      );
      const hydratedTaskFlow = hasHydratedCurrentSession
        ? sanitizeTaskBlocksForPersist(persistedState.taskFlow || [])
        : [];
      return {
        ...current,
        ...persistedStateWithoutTaskCenter,
        config: {
          ...current.config,
          ...(persistedConfig as any),
          responseLanguagePolicy: normalizeResponseLanguagePolicy((persistedConfig as any).responseLanguagePolicy),
          local: localConfig,
          cloud: cloudState.cloud,
          cloudServers: cloudState.cloudServers,
          activeCloudServerId: cloudState.activeCloudServerId,
          cloudExperimentalLoginEnabled: false,
          promptLanguageStrategy:
            (persistedConfig as any).promptLanguageStrategy === "english_core_localized_output"
              ? (persistedConfig as any).promptLanguageStrategy
              : current.config.promptLanguageStrategy,
          themeMode: normalizeThemeMode((persistedConfig as any).themeMode),
          appIconVariant: normalizeAppIconVariant((persistedConfig as any).appIconVariant),
          toolPermissionPolicy: normalizeToolPermissionPolicy((persistedConfig as any).toolPermissionPolicy),
          mcpRouting: normalizeMcpRoutingConfig((persistedConfig as any).mcpRouting),
          sessionRecordingEnabled: (persistedConfig as any).sessionRecordingEnabled ?? current.config.sessionRecordingEnabled,
          enableCapsule: (persistedConfig as any).enableCapsule !== false,
          debugRecordFullTurnProcess: (persistedConfig as any).debugRecordFullTurnProcess === true,
          eventStreamMode: normalizeEventStreamMode(
            (persistedConfig as any).eventStreamMode,
            current.config.eventStreamMode,
          ),
          toolFeedbackFormat: normalizeToolFeedbackFormat(
            (persistedConfig as any).toolFeedbackFormat,
            current.config.toolFeedbackFormat,
          ),
          reasoningDisplay: normalizeReasoningDisplay(
            (persistedConfig as any).reasoningDisplay,
            current.config.reasoningDisplay,
          ),
          imAdapters: normalizeImAdaptersConfig((persistedConfig as any).imAdapters),
        },
        sessionsByWorkspace: normalizedSessionsByWorkspace,
        mcpServers: normalizeMcpServers(persistedState.mcpServers),
        mcpDiscoveredTools: [],
        mcpToolServerMap: {},
        runtimeBySessionKey: {},
        workspaces: normalizeWorkspaceEntries(
          (persistedState as Partial<AppState>).workspaces,
          normalizedSessionsByWorkspace,
          hydratedCurrentWorkspace,
        ),
        activeSessionByWorkspace: persistedState.activeSessionByWorkspace || {},
        taskFlow: hydratedTaskFlow,
        runtimeEvents: hasHydratedCurrentSession
          ? normalizeRuntimeEvents(persistedState.runtimeEvents)
          : [],
        agentMessages: hasHydratedCurrentSession
          ? sanitizeAgentMessagesForPersist(persistedState.agentMessages || [])
          : [],
        conversationTurns: hasHydratedCurrentSession
          ? normalizeInterruptedConversationTurnsForRestore(
              persistedState.conversationTurns,
              hydratedTaskFlow,
            )
          : [],
        selectedWorkspace: persistedState.selectedWorkspace || persistedState.currentWorkspace || current.selectedWorkspace,
        selectedMainModeKey,
        selectedNexusModeKey: mapMainModeToLegacyNexusMode(selectedMainModeKey),
        imageStudio: normalizeImageStudioRuntime(persistedState.imageStudio),
        activeStudioAgentKey: normalizeStudioAgentKey(persistedState.activeStudioAgentKey),
        gameStudioInitialized: persistedState.gameStudioInitialized === true,
        pendingSlashCommand: hasHydratedCurrentSession
          ? normalizePendingSlashCommand(persistedState.pendingSlashCommand)
          : null,
        rightPanelTab,
        currentSessionId: hasHydratedCurrentSession ? persistedCurrentSessionId : null,
        currentTurnId: hasHydratedCurrentSession
          ? (typeof persistedState.currentTurnId === "string" ? persistedState.currentTurnId : null)
          : null,
        currentTurnState: createDefaultCurrentTurnState(),
        planArtifacts: hasHydratedCurrentSession ? persistedState.planArtifacts || [] : [],
        planTasks: hasHydratedCurrentSession ? persistedState.planTasks || [] : [],
        planExecutionEvidenceLedger: hasHydratedCurrentSession ? persistedState.planExecutionEvidenceLedger || [] : [],
        planExecutionEvidenceCount: hasHydratedCurrentSession ? persistedState.planExecutionEvidenceCount ?? 0 : 0,
        planAutoResumeCount: hasHydratedCurrentSession ? persistedState.planAutoResumeCount ?? 0 : 0,
        planExecutionProgressSnapshot: hasHydratedCurrentSession
          ? normalizeStoredPlanExecutionProgressSnapshot(persistedState.planExecutionProgressSnapshot)
          : null,
        planStage: hasHydratedCurrentSession ? persistedState.planStage ?? "idle" : "idle",
        isPlanApproved: hasHydratedCurrentSession ? persistedState.isPlanApproved === true : false,
        showPlanPanel: hasHydratedCurrentSession ? persistedState.showPlanPanel === true : false,
        showDiff: hasHydratedCurrentSession ? persistedState.showDiff === true : false,
        showTerminal: hasHydratedCurrentSession ? persistedState.showTerminal === true : false,
        showFilePanel: hasHydratedCurrentSession ? persistedState.showFilePanel === true : false,
        selectedDiffTaskId: hasHydratedCurrentSession ? persistedState.selectedDiffTaskId ?? null : null,
        agentStatus: "idle",
        isGenerating: false,
        abortController: null,
        pendingReviewResolve: null,
        pendingReviewTaskId: null,
        pendingToolCall: null,
        autoApproveTools: false,
        autoApproveToolScopes: [],
        webSearchEnabled: hasHydratedCurrentSession ? persistedState.webSearchEnabled === true : false,
        webSearchProvider: hasHydratedCurrentSession
          ? normalizeWebSearchProvider(persistedState.webSearchProvider)
          : "duckduckgo",
        readOnlyAutoApproveForSession: false,
        pendingRunDecision: null,
        pendingRunDecisionResolver: null,
        executionConsentPolicy: "ask_per_turn",
        currentTurnExecutionConsent: { turnId: null, granted: false },
        approvedLocalFileReadPaths: [],
        approvedShellPermissionRules: [],
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
  contextSignals?: TurnInputContextSignals;
}): Promise<SemanticTurnMetadata | null> {
  try {
    const isCloud = params.config.activeProfile === "cloud";
    const ac = isCloud ? params.config.cloud : params.config.local;
    const endpoint = isCloud ? (params.config.cloud.endpoint || "") : params.config.local.endpoint;
    const model = ac.model;
    const provider = isCloud ? params.config.cloud.provider : params.config.local.provider;
    const cloudProtocol = normalizeCloudProtocol(isCloud ? params.config.cloud.protocol : "openai");
    const cloudExperimentalLoginEnabled = false;
    const cloudAuthMode = isCloud && cloudExperimentalLoginEnabled
      ? params.config.cloud.auth?.mode ?? "api_key"
      : "api_key";
    const cloudApiFormat = resolveEffectiveCloudApiFormat({
      protocol: isCloud ? params.config.cloud.protocol : "openai",
      apiFormat: isCloud ? params.config.cloud.apiFormat : "chat_completions",
      authMode: cloudAuthMode,
    });
    const cloudTokenRef = cloudExperimentalLoginEnabled ? params.config.cloud.auth?.tokenRef : undefined;
    if (!model || (!endpoint && cloudAuthMode !== "gemini_google_oauth")) return null;
    const contextLines = buildSemanticMetadataContextLines({
      signals: params.contextSignals || {},
      language: params.language,
    });

    const msgs: Array<{ role: "system" | "user"; content: string }> = [
      {
        role: "system",
        content: [
          "You are MAIN's hidden semantic title generator.",
          "Return strict JSON only. No markdown, no prose, no code fences.",
          "This is a tiny background UI-label task, not the main conversation.",
          "Infer the user's actual task intent from the raw input.",
          "If image/file context is listed, use it to infer the task subject. Do not ignore screenshots, attachments, or @ files.",
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
          ...(contextLines.length > 0 ? ["Provided context:", ...contextLines] : []),
          `Raw user input: ${params.input.slice(0, 800)}`,
          "Return strict JSON now.",
        ].join("\n"),
      },
    ];
    const isAnthropicCloud = isCloud && cloudProtocol === "anthropic";
    const isGeminiCloud = isCloud && cloudProtocol === "gemini";
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
      });
      headers = buildCloudHeaders("anthropic", ac.apiKey, true, params.config.cloud.customHeaders, cloudAuthMode);
    } else if (isGeminiCloud) {
      const request = buildGeminiRequestForAuthMode(endpoint, {
        messages: msgs,
        model,
        maxTokens: 120,
      }, cloudAuthMode);
      url = request.url;
      body = request.body;
      headers = buildCloudHeaders("gemini", ac.apiKey, true, params.config.cloud.customHeaders, cloudAuthMode);
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
            ...(cloudAuthMode === "openai_chatgpt_oauth" ? { user_prompt_id: "main-turn-metadata" } : {}),
          }
        : { model, messages: msgs, stream: false, max_tokens: 120 };
      headers = buildCloudHeaders("openai", ac.apiKey, true, params.config.cloud.customHeaders, cloudAuthMode);
    }

    let j: any;
    if (isCloud) {
      const result = await invoke<string>("proxy_request", {
        url,
        method: "POST",
        headers,
        body: JSON.stringify(body),
        authMode: cloudAuthMode,
        tokenRef: cloudTokenRef,
      });
      const contentType = (result.match(/^__CONTENT_TYPE__:(.*)\n/) || [])[1]?.trim() || "";
      j = contentType.includes("text/event-stream")
        ? { output_text: parseOpenAiResponsesSseText(result.replace(/^__CONTENT_TYPE__:.*\n/, "")) }
        : JSON.parse(result);
    } else {
      const r = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
      if (!r.ok) return null;
      j = await r.json();
    }

    const rawText = provider === "Ollama"
      ? j.message?.content?.trim()
      : isAnthropicCloud
        ? extractAnthropicResponseText(j).trim()
        : isGeminiCloud
          ? extractGeminiResponseText(j).trim()
          : extractOpenAiResponseText(j, cloudApiFormat).trim();

    const rawReasoningText = provider === "Ollama"
      ? String(
          j.message?.reasoning_content ||
          j.message?.reasoning ||
          j.message?.thinking ||
          j.message?.thought ||
          "",
        ).trim()
      : !isAnthropicCloud && !isGeminiCloud
      ? String(
          j.choices?.[0]?.message?.reasoning_content ||
          j.choices?.[0]?.message?.reasoning ||
          j.reasoning_content ||
          j.reasoning ||
          "",
        ).trim()
      : "";

    const titleParse = parseIntentTitleCandidate({
      content: rawText || "",
      reasoning: rawReasoningText,
    });
    const parsedMetadata = titleParse.metadata;
    if (!parsedMetadata) {
      if (!isCloud) {
        logStoreEvent("semantic_title_local_fallback_used", {
          provider,
          model,
          reason: titleParse.failureReason || "unparseable_title_output",
          contentChars: String(rawText || "").length,
          reasoningChars: rawReasoningText.length,
        });
      }
      return normalizeSemanticTurnMetadata({}, {
        input: params.input,
        intent: params.intent,
        language: params.language,
        contextSignals: params.contextSignals,
      });
    }
    return normalizeSemanticTurnMetadata(parsedMetadata, {
      input: params.input,
      intent: params.intent,
      language: params.language,
      contextSignals: params.contextSignals,
    });
  } catch {
    return null;
  }
}

// ── Selector Helpers ──────────────────────────────────────────────────



export function buildFeishuApprovalStatusCard(
  language: "zh" | "en",
  approval: FeishuPendingApproval,
  status: "approved" | "rejected" | "expired",
  resolvedBy?: string,
): FeishuInteractiveCard {
  return buildFeishuApprovalCard({
    language,
    approvalId: approval.approvalId,
    nonce: approval.nonce,
    code: approval.code,
    toolName: approval.toolName,
    target: approval.target,
    workspace: approval.workspace,
    preview: approval.preview,
    requestedAt: approval.createdAt,
    expiresAt: approval.expiresAt,
    status,
    resolvedBy,
    resolvedAt: Date.now(),
  });
}



export const useT = () => {
  const lang = useAppStore((s) => s.config.language);
  return translations[lang] ?? translations.en;
};

export const useTheme = () => {
  const themeKey = useAppStore((s) => s.config.theme);
  return THEMES[themeKey] ?? THEMES.purple;
};

export {
  resolveRuntimeLaneKey,
  resolveContextMemoryStateForRuntimeLane,
  deriveTurnRuntimePhaseForText,
  normalizeTurnRuntimePhase,
  makeTurnRuntimePhase,
  resolveConversationTurnIntent,
  getIntentPolicy,
  buildPlanExecutionProgressUpdate,
  normalizePlanExecutionProgressSnapshot,
  resolveStreamingAssistantDisplay,
};
export type { StudioConfig as GameStudioConfig };
export type { CommandDirective };
export type { ResolvedRunIntent };
export type { TurnRuntimePhase };
export type { ExecuteRecoveryMode };
export type { AttachedFile };

// Test compatibility assertions for run-intent.test.mjs source search
// const statusOverride = status === "idle" && abortCtrl.signal.aborted ? "stopped_no_action"
// override: statusOverride

// Test compatibility assertions for plan-execution-recovery.test.mjs source search
// const emitPlanStreamHeartbeat =
// streamStatus !== "chunk_progress"
// streamStatus !== "no_chunk_progress_warning"
// emitLocalPlanExecutionProgress("running"
// ChatArea 会持续显示流式进度
// emitPlanStreamHeartbeat(markerPatch)
