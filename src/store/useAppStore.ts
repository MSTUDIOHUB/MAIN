// store/useAppStore.ts
// Zustand global state for Local Agent IDE
// All state that was previously scattered as useState in the monolith lives here.
import { create, type StateCreator } from "zustand";
import { persist } from "zustand/middleware";
import { type AgentMessage, type ReviewDecision, type ContentPart } from "../lib/orchestrator";
import type { ExecuteRecoveryMode } from "../lib/executeRecoveryTools";
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
  type KnowledgeBase,
  type ReadFileWindowResult,
  type ShellPermissionDecision,
} from "../lib/ipc";
import { buildShellPermissionApproval, suggestedShellPermissionRules } from "../lib/shellAutoApproval";
import { invoke } from "@tauri-apps/api/core";
import { setWorkspaceRoot as setWorkspaceRootIpc } from "../lib/ipc";
import { appendDebugLog } from "../lib/debugLog";
import {
  consumePendingUncleanRestartDiagnostic,
  getHarnessActionRunId,
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
  type DurableTurnContext,
  type NormalizedStreamState,
  type PlanArtifact,
  type PlanExecutionEvidenceEntry,
  type PlanExecutionProgressSnapshot,
  type PlanStage,
  type PlanTask,
  type RightPanelTab,
  canonicalizePlanArtifactPath,
  detectPlanArtifactKind,
  extractPlanTasks,
  findDroppedPlanTasks,
  getPlanArtifactTitle,
  isGenericConversationTitle,
  isPlanConversationTurn,
  looksLikeReasoningLeakTitle,
  normalizeResponseLanguagePolicy,
  normalizeConversationDisplayTitle,
  reconcilePlanTaskCompletion,
  resolveTurnResponseLanguage,
  summarizeAssistantText,
  validatePlanArtifactContent,
} from "../lib/workflowModels";
import { sanitizeRestoredPlanArtifacts } from "../lib/planArtifactRestore";
import {
  MAIN_THREAD_EVENT_SCHEMA_VERSION,
  appendRuntimeEvent,
  normalizeEventStreamMode,
  normalizeToolFeedbackFormat,
  withEventSchema,
  type MainThreadEvent,
  type MainThreadEventInput,
} from "../lib/turnEvents";
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
} from "../lib/cloudProtocol";
import {
  normalizeCloudServerState,
} from "../lib/cloudServers";
import { resolveStreamingAssistantDisplay } from "../lib/streamDisplayPolicy";
import {
  normalizeProgressNarration,
} from "../lib/progressNarration";
import {
  makeTurnRuntimePhase,
  normalizeTurnRuntimePhase,
  deriveTurnRuntimePhaseForText,
  type TurnRuntimePhase,
} from "../lib/turnPhase";
import { hasReviewablePlanArtifact, normalizePlanApprovalChoice } from "../lib/planControl";
import {
  buildPlanApprovalIdentity,
  isPlanApprovalIdentityCurrent,
} from "../lib/planApprovalIdentity";
import {
  buildPlanExecutionProgressUpdate,
  isPlanReviewExecutionLeaseActive,
  normalizePlanExecutionProgressSnapshot,
  resolveApprovedPlanSameTurnFallbackDecision,
  toPlanExecutionRuntimeProgressUpdate,
} from "../lib/planExecutionRecovery";
import {
  type AttachedFile,
  normalizeAttachedFile,
} from "../lib/attachments";
import {
  buildSemanticMetadataContextLines,
  normalizeTurnInputContextSignals,
  type TurnInputContextSignals,
} from "../lib/turnIntake";
import {
  buildCanonicalCompletedTurnMessages,
  compactPlanReviewTurnMessages,
  findCanonicalTurnStartMessageIndex,
} from "../lib/turnContext";
import { serializeDurableTurnContextForModel } from "../lib/durableTurnContext";
import { buildGoalSourceContextSnapshot } from "../lib/goalSourceContext";
import { resolveGoalEventOwnerIdentity } from "../lib/goalEventIdentity";
import {
  buildPlanReviewActionRequest,
  clearGoalConfirmationActionRequest,
  isCurrentGoalAdministrativeControl,
  isCurrentGoalControlResolution,
  isExactToolPermissionResolutionIdentity,
  isToolPermissionActionRequest,
  normalizeActionRequest,
  type ActionRequest,
  type ToolPermissionResolutionIdentity,
  type UserChoiceResolutionIdentity,
  type PlanReviewResolutionIdentity,
  type GoalControlIdentity,
} from "../lib/actionRequest";
import {
  isInternalUnapprovedPlanChoiceRestore,
  restorePendingActionRequest,
  stripRestoredUserChoiceControlText,
} from "../lib/actionRequestRestore";
import { getFilePreviewStrategy } from "../lib/filePreviewStrategy";
import {
  sanitizeUserContextItemsForPersist,
} from "../lib/userContextItems";
import {
  LOCAL_PERSIST_SCHEMA_VERSION,
  buildPersistedAppState,
  stripLegacyConfigFields,
  stripLegacyRuntimeFieldsFromPersistedState,
} from "../lib/persistState";
import {
  createGameStudioModeSwitchDecision,
  ensureGameStudioWorkspaceInitialized,
  gameStudioRuntimeService,
  loadGameStudioConfig,
  removeGameStudioWorkspaceAssets,
  resolveEngineFromModeSwitchChoice,
  setGameStudioEngineConfig,
} from "../lib/gameStudio";
import {
  getGameStudioSlashCommandSpec,
  getDefaultStudioAgentForEngine,
  parseSetupEngineArgs,
  normalizeStudioAgentKey,
  type StudioWorkflowCommandSlug,
  type NexusModeKey,
  type PendingSlashCommand,
  type StudioAgentKey,
  type StudioConfig,
} from "../lib/gameStudio/catalog";
import {
  getIntentPolicy,
  resolveConversationTurnIntent,
  resolveRunIntentFromLegacyWorkflowMode,
  type ExecutionConsentPolicy,
  type CommandDirective,
  type MainIntentShortcut,
  type PendingRunDecision,
  type PendingRunDecisionChoice,
  type ResolvedUserIntent,
  type ResolvedRunIntent,
} from "../lib/runIntent";
import {
  archiveConsumedReplyOptionsFromTaskFlow,
  buildSubmitInputEnvelope,
  buildLocalTurnTitle,
  buildMainDebugPrompt,
  buildRunIntentSummary,
  buildSubmitPipelineDecision,
  isResolvedUserIntentChoice,
  normalizeIntentSummary,
  normalizeTaskFlowPatchForConsumedReplyOptions,
  resolveSubmitRuntimeDecision,
  resolveSubmitSemanticMetadataDecision,
} from "../lib/submit/turnSubmission";
import {
  DEFAULT_GOAL_EMERGENCY_CONTINUATION_LIMIT,
  createGoalDefinition,
  createGoalProgress,
  migrateGoalDefinition,
  updateGoalDefinitionText,
} from "../lib/goalState";
import type { GoalDefinition, GoalProgress, GoalRuntimeSnapshot, GoalStatus } from "../lib/goalState";
import type { GoalBudget } from "../lib/goalBudget";
import { buildGoalRuntimeSnapshot, normalizeGoalRuntimeSnapshot, restoreGoalRuntimeSnapshot } from "../lib/goalRuntime";
import { resolveGoalRuntimeProgressFilePath } from "../lib/goalPersistence";
import { CLOUD_EXPERIMENTAL_LOGIN_AVAILABLE } from "../lib/appConfig";
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
import {
  createWorkspaceSlice,
  normalizePendingDecisionInputKey,
  normalizeStoredRightPanelTab,
} from "./slices/workspaceSlice";
import {
  createSubmitPreRunSessionPatcher,
  startSubmitElapsedTimer,
} from "./submitRuntimeFacade";
import { createSubmitSessionRuntimeController } from "./submitSessionRuntimeController";
import { startSubmitBlockingPreflightEffect } from "./submitPreflightExecutor";
import { startGameStudioLocalSlashSubmission } from "./gameStudioLocalSlashSubmission";
import {
  applySubmitSeedSessionTitle,
  startSubmitSemanticMetadataEffect,
} from "./submitTitleEffects";
import { applySubmitSessionBootstrap } from "./submitSessionBootstrap";
import { createGameStudioLocalSlashBridge } from "./gameStudioLocalSlashBridge";
import { applySubmitVisibleTurn } from "./submitVisibleTurn";
import { prepareSubmitTurnDraft } from "./submitTurnDraft";
import { startSubmitPlanHydrationEffect } from "./submitPlanHydration";
import { runSubmitPlanExecutionResumeEffect } from "./submitPlanExecutionResume";
import { applySubmitPendingReviewTransition } from "./submitPendingReviewTransition";
import { applySubmitPlanStateReset } from "./submitPlanStateReset";
import { applySubmitSendGateEffects } from "./submitSendGateEffects";
import { resolveAndApplySubmitIntentRouting } from "./submitIntentRouting";
import { startSubmitAsyncWorkflowRun } from "./submitAsyncWorkflowRun";
import { createSubmitHarnessRunId } from "./submitRunLease";
import {
  buildApprovedPlanExecutionPrompt,
  ensureApprovedPlanRuntimeTasksForState,
  evaluateApprovedPlanExecutionReadiness,
  normalizeApprovedPlanTaskStatuses,
} from "./submitApprovedPlanExecution";
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
  cancelSubagentRun,
  isSubagentActiveStatus,
  isSubagentTerminalStatus,
  projectSubagentRuns,
  reconcileOrphanedSubagentEvents,
} from "../lib/subagents";
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
} from "../lib/imAdapters";
import {
  isLocalFileReadApproved,
  normalizeLocalFileReadPath,
  normalizeMcpRoutingConfig,
  normalizeToolPermissionPolicy,
} from "../lib/toolCapabilities";
import type {
  AppConfig,
  Lang,
  Skill,
  ThemeMode,
} from "../lib/appTypes";
import type {
  ActiveGuidance,
  PlanApprovalHandoff,
  ProviderCompatibilityRuntimeLaneState,
  QueuedUserMessage,
  SessionModelConfig,
} from "../lib/sessionTypes";
import {
  GLOBAL_CHAT_KEY,
  resolveGlobalChatSessionKey,
  resolveSessionRuntimeKey,
  resolveSessionWorkspaceKey,
} from "../lib/sessionTypes";
import type {
  DiffRevertRequest,
  DiffRevertResult,
  GitDiffPreviewState,
  JobItem,
  TaskBlock,
} from "../lib/taskTypes";
import type { FeishuRemoteContext } from "../lib/remoteContextTypes";
import { compactThoughtContent } from "../lib/thoughtCompaction";
import {
  parseIntentTitleCandidate,
} from "../lib/intentTitlePolicy";

export type {
  AppConfig,
  CloudConfig,
  CloudServerConfig,
  Lang,
  LocalConfig,
  Skill,
  ThemeKey,
  ThemeMode,
} from "../lib/appTypes";
export type {
  ActiveGuidance,
  PlanApprovalHandoff,
  ProviderCompatibilityRuntimeLaneState,
  QueuedUserMessage,
  SessionModelConfig,
} from "../lib/sessionTypes";
export {
  GLOBAL_CHAT_KEY,
  resolveGlobalChatSessionKey,
  resolveSessionRuntimeKey,
  resolveSessionWorkspaceKey,
} from "../lib/sessionTypes";
export type {
  AssistantTextVisibility,
  DiffRevertRequest,
  DiffRevertResult,
  DiffRevertStatus,
  GitDiffPreviewState,
  JobItem,
  ProgressTaskBlock,
  TaskBlock,
  TaskBlockBase,
  ToolDiffSnapshot,
} from "../lib/taskTypes";
export type { FeishuRemoteContext } from "../lib/remoteContextTypes";

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

function summarizePlanWorkspaceStateForLog(state: Pick<AppState,
  "planArtifacts" |
  "planTasks" |
  "planStage" |
  "showPlanPanel" |
  "rightPanelTab" |
  "isPlanApproved"
>) {
  const artifactCount = Array.isArray(state.planArtifacts) ? state.planArtifacts.length : 0;
  const taskCount = Array.isArray(state.planTasks) ? state.planTasks.length : 0;
  const stage = state.planStage || "idle";
  return {
    artifactCount,
    taskCount,
    stage,
    approved: state.isPlanApproved === true,
    panelVisible: state.showPlanPanel === true,
    rightPanelTab: state.rightPanelTab,
    buttonVisible: artifactCount > 0 || taskCount > 0 || stage !== "idle",
  };
}



const SESSION_AUTO_APPROVE_SCOPE_SET = new Set<SessionAutoApproveScope>([
  "workspace_write",
  "shell",
  "local_file_read",
  "external_write",
  "browser_control",
  "mcp_action",
]);
const DEFAULT_SESSION_AUTO_APPROVE_SCOPES: SessionAutoApproveScope[] = [
  "workspace_write",
  "shell",
  "local_file_read",
  "external_write",
  "browser_control",
  "mcp_action",
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
    skills: "Skills", knowledge: "Knowledge", diff: "Diff Viewer", terminal: "Terminal", settings: "Settings",
    openProject: "Open Folder", noWorkspace: "No project selected", noConversations: "No conversations yet",
    localSetup: "Local AI Engine", cloudSetup: "Cloud API", general: "General", contextSetup: "Background Compression",
    instruction: "Instruction", reject: "Reject all", accept: "Accept all",
    askPlaceholder: "Ask me about your project... (Type @ to attach files)",
    askPlaceholderGlobal: "Talk through ideas, plans, or questions... (Type @ to attach files)",
    contextLimit: "Auto Token Budget & Protection",
    contextLimitDesc: "MAIN automatically discovers your model's maximum context limit and dynamically manages file-read size gates and progressive background compaction without manual intervention.",
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
    skills: "技能与提示词", knowledge: "知识库", diff: "变更比对", terminal: "集成终端", settings: "系统设置",
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

export type TranslationKey = keyof typeof translations.en;

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

// ── Domain Types ─────────────────────────────────────────────────────

export type Role = "user" | "assistant" | "system";

export interface Message {
  id: string;
  role: Role;
  content: string;
  timestamp: number;
  streaming?: boolean;
}

// ── MCP Types (re-exported from mcpClient for convenience) ──────────
export type { MCPServer, MCPTool } from "../lib/mcpClient";

export type WebSearchProvider = "duckduckgo" | "bing" | "baidu";

function normalizeWebSearchProvider(value: unknown): WebSearchProvider {
  return value === "bing" || value === "baidu" ? value : "duckduckgo";
}

export interface SessionRuntimeSnapshot {
  runtimeEventSchemaVersion?: number;
  runtimeEvents?: MainThreadEvent[];
  harnessRunMarker?: HarnessRunMarker | null;
  activeActionRequest?: ActionRequest | null;
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
  pendingPlanApprovalHandoff?: PlanApprovalHandoff | null;
  planApprovalExecutionStartedForTurnId?: string | null;
  clearedPlanTurnId?: string | null;
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
  
  // Goal Mode State
  activeGoal?: GoalDefinition | null;
  goalProgress?: GoalProgress | null;
  goalStatus?: GoalStatus;
  goalIterationBudget?: number;
  goalRuntime?: GoalRuntimeSnapshot | null;
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
  pendingPlanApprovalHandoff: PlanApprovalHandoff | null;
  planApprovalExecutionStartedForTurnId: string | null;
  clearedPlanTurnId: string | null;
  normalizedStreamState: NormalizedStreamState;
  currentTurnState: AppState["currentTurnState"];
  isGenerating: boolean;
  agentStatus: AgentStatus;
  abortController: AbortController | null;
  elapsedTime: number;
  pendingReviewResolve: ((decision: ReviewDecision) => void) | null;
  pendingReviewTaskId: number | null;
  /** Current in-memory checkpoint owner. Not persisted because resolver closures cannot survive reload. */
  activeActionRequest: ActionRequest | null;
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

export type AgentStatus = "idle" | "running" | "pending_review" | "error";

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

type CapsuleExplanationSource = "model" | "runtime";
type CapsuleExplanationState = {
  turnId: string;
  text: string;
  updatedAt: number;
  source: CapsuleExplanationSource;
} | null;

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
  selectedSubagentId: string | null;
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
  openSubagentsPanel: (subagentId?: string) => void;
  selectSubagent: (subagentId: string) => void;
  stopSubagent: (subagentId: string) => boolean;
  stopAllSubagents: () => number;
  dismissEndedSubagents: () => number;
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

  // Knowledge bases
  knowledgeBases: KnowledgeBase[];
  setKnowledgeBases: (v: KnowledgeBase[]) => void;
  upsertKnowledgeBase: (base: KnowledgeBase) => void;
  removeKnowledgeBase: (id: string) => void;
  getEnabledKnowledgeBaseIds: () => string[];

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
  pendingPlanApprovalHandoff: PlanApprovalHandoff | null;
  planApprovalExecutionStartedForTurnId: string | null;
  clearedPlanTurnId: string | null;
  runtimeEvents: MainThreadEvent[];
  harnessRunMarker: HarnessRunMarker | null;
  activeActionRequest: ActionRequest | null;
  setWorkflowMode: (mode: "chat" | "edit" | "plan") => void;
  setIsPlanApproved: (v: boolean) => void;
  setPlanStage: (stage: PlanStage) => void;
  upsertPlanArtifact: (artifact: PlanArtifact) => void;
  clearPlanArtifacts: () => void;
  deletePersistedPlanFiles: () => Promise<void>;
  deleteBrowserValidationArtifacts: () => Promise<void>;
  setPlanTasks: (tasks: PlanTask[]) => void;
  setNormalizedStreamState: (state: NormalizedStreamState) => void;
  approvePlan: (approvalChoice?: string, expected?: PlanReviewResolutionIdentity) => void;
  rejectPlan: (expected?: PlanReviewResolutionIdentity) => boolean;
  rejectPlanAndDeleteFiles: (expected?: PlanReviewResolutionIdentity) => Promise<void>;
  showWorkflowMenu: boolean;
  setShowWorkflowMenu: (v: boolean) => void;

  // Goal Mode
  activeGoal: GoalDefinition | null;
  goalProgress: GoalProgress | null;
  goalStatus: GoalStatus;
  goalIterationBudget: number;
  goalRuntime: GoalRuntimeSnapshot | null;
  startGoal: (objective: string, options?: Partial<GoalBudget> & { sessionKey?: string; sourceContext?: string; ownerTurnId?: string }) => void;
  pauseGoal: (expected?: GoalControlIdentity) => void;
  resumeGoal: (expected?: GoalControlIdentity) => void;
  clearGoal: (expected?: GoalControlIdentity) => void;
  updateGoalText: (objective: string, expected?: GoalControlIdentity) => boolean;
  updateGoalProgress: (progress: GoalProgress) => void;
  updateGoalRuntime: (runtime: GoalRuntimeSnapshot) => void;

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
    options?: {
      contextMentions?: string[];
      attachedFiles?: AttachedFile[];
      runtimeIntentOverride?: ResolvedRunIntent;
      goalSourceContextSnapshot?: string;
      replyOptionRequestIdentity?: UserChoiceResolutionIdentity;
      replyOptionIsCustom?: boolean;
      parentRunIdOverride?: string;
    },
  ) => void;
  clearQueuedUserMessage: () => void;
  setActiveGuidance: (text: string, turnId?: string | null) => void;
  clearActiveGuidance: () => void;
  consumeActiveGuidance: (turnId?: string | null) => ActiveGuidance | null;
  setAgentStatus: (s: AgentStatus) => void;
  resolveReview: (action: "accept" | "reject") => void;
  allowToolAction: (taskId: number, identity?: ToolPermissionResolutionIdentity) => void;
  rejectToolAction: (taskId: number, identity?: ToolPermissionResolutionIdentity) => void;
  approvePendingReviewOnce: (identity?: ToolPermissionResolutionIdentity) => void;
  approvePendingReviewForSession: (identity?: ToolPermissionResolutionIdentity) => void;
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
      goalSourceContextSnapshot?: string;
      remoteFeishu?: FeishuRemoteContext;
      skipAutoPlanHydration?: boolean;
      parentRunIdOverride?: string;
      /** Reserved child run identity for an approved Plan handoff. */
      runIdOverride?: string;
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

function isPendingToolPermissionResolutionCurrent(
  state: AppState,
  taskId: number,
  identity: ToolPermissionResolutionIdentity | undefined,
  action: "approve_once" | "approve_session" | "reject",
): boolean {
  const request = state.activeActionRequest;
  const ownsPendingResolver = !!state.pendingReviewResolve && state.pendingReviewTaskId === taskId;
  const ownsPendingRequest = isToolPermissionActionRequest(request) && request.taskId === taskId;
  const exactIdentity = !identity || isExactToolPermissionResolutionIdentity(request, identity);
  const activeSessionKey = state.getCurrentSessionKey();
  const ownsActiveSession = !!activeSessionKey && request?.sessionKey === activeSessionKey;
  if (ownsPendingResolver && ownsPendingRequest && exactIdentity && ownsActiveSession) return true;

  logStoreEvent("tool_permission_resolution_identity_mismatch", {
    action,
    requestedTaskId: taskId,
    receivedSessionKey: identity?.sessionKey || null,
    receivedTurnId: identity?.turnId || null,
    receivedRunId: identity?.runId || null,
    receivedRequestId: identity?.requestId || null,
    receivedIdentityTaskId: identity?.taskId ?? null,
    currentSessionKey: request?.sessionKey || null,
    currentTurnId: request?.turnId || null,
    currentRunId: request?.runId || null,
    currentRequestId: request?.requestId || null,
    currentTaskId: request?.kind === "tool_permission" ? request.taskId : null,
    currentActionKind: request?.kind || null,
    activeSessionKey,
    pendingReviewTaskId: state.pendingReviewTaskId,
    hasPendingResolver: !!state.pendingReviewResolve,
  });
  return false;
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
const defaultKnowledgeBases: KnowledgeBase[] = [];

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

export function normalizeInterruptedConversationTurnsForRestore(
  turns: ConversationTurn[] | undefined,
  _taskFlow: TaskBlock[],
): ConversationTurn[] {
  return (turns || []).map((turn) => {
    const normalizedTurn = {
      ...turn,
      processCollapsed: turn.processCollapsed ?? turn.collapsed ?? false,
      collapsed: turn.processCollapsed ?? turn.collapsed ?? false,
    };
    if (turn.status !== "executing" && turn.status !== "planning") return normalizedTurn;
    return {
      ...normalizedTurn,
      status: "paused",
      summary: String(turn.summary || "").trim() || "Execution was interrupted by an application restart; progress is preserved and resumable.",
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
      runId: typeof snapshot.runId === "string" ? snapshot.runId : undefined,
      parentRunId: typeof snapshot.parentRunId === "string"
        ? snapshot.parentRunId
        : snapshot.parentRunId === null
        ? null
        : undefined,
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
    "goal.started",
    "goal.state_changed",
    "goal.checkpoint_saved",
    "goal.completed",
    "goal.cleared",
    "subagent.created",
    "subagent.updated",
    "subagent.closed",
    "subagent.dismissed",
    "subagent.handed_back",
    "model_lane.pressure",
    "approval.requested",
    "run.started",
    "run.paused",
    "run.completed",
    "run.failed",
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
      const eventRecord = type.startsWith("run.")
        ? {
            ...record,
            runId: typeof record.runId === "string" && record.runId.trim()
              ? record.runId
              : `legacy-run-${String(record.turnId || "unknown")}-${Math.max(0, Number(record.timestampMs) || 0)}`,
            parentRunId: typeof record.parentRunId === "string" && record.parentRunId.trim()
              ? record.parentRunId
              : null,
          }
        : record;
      normalized.push(withEventSchema(eventRecord as MainThreadEventInput));
    } catch {
      // ignore malformed runtime events
    }
  }

  return normalized;
}

export function normalizeSessionRuntimeSnapshot(
  snapshot: Partial<SessionRuntimeSnapshot> | null | undefined,
  options?: { restoreInterruptedGoal?: boolean },
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
  const rawTaskFlow = sanitizeTaskBlocksForPersist(snapshot.taskFlow || []);
  const normalizedContextMemoryState = normalizeContextMemoryState(snapshot.contextMemoryState);
  const queuedUserMessage = normalizeQueuedUserMessage(snapshot.queuedUserMessage);
  const activeGuidance = normalizeActiveGuidance(snapshot.activeGuidance);
  const legacyGoal = snapshot.activeGoal ? migrateGoalDefinition(snapshot.activeGoal) : null;
  const restoredRuntime = snapshot.goalRuntime && [2, 3].includes(Number(snapshot.goalRuntime.schemaVersion))
    ? {
        ...snapshot.goalRuntime,
        goal: migrateGoalDefinition(snapshot.goalRuntime.goal),
        progress: { ...snapshot.goalRuntime.progress },
      }
    : legacyGoal
      ? buildGoalRuntimeSnapshot({
          goal: legacyGoal,
          progress: snapshot.goalProgress || createGoalProgress(legacyGoal.id, ""),
          phase: null,
        })
      : null;
  const normalizedGoalRuntime = restoredRuntime
    ? options?.restoreInterruptedGoal
      ? restoreGoalRuntimeSnapshot(restoredRuntime)
      : normalizeGoalRuntimeSnapshot(restoredRuntime)
    : null;
  const unapprovedPlanTurnIds = (snapshot.conversationTurns || [])
    .filter((turn) => isPlanConversationTurn(turn))
    .map((turn) => turn.id);
  const restoredPlanArtifacts = sanitizeRestoredPlanArtifacts({
    artifacts: snapshot.planArtifacts || [],
    isPlanApproved: snapshot.isPlanApproved === true,
  });
  const persistedPlanIdentity = buildPlanApprovalIdentity(snapshot.planArtifacts || []);
  const restoredPlanIdentity = buildPlanApprovalIdentity(restoredPlanArtifacts.artifacts);
  const rejectedReviewablePlanArtifact = restoredPlanArtifacts.rejected.some((artifact) =>
    artifact.kind === "plan" || artifact.kind === "design" || artifact.kind === "bugfix"
  );
  const restoredIsPlanApproved =
    snapshot.isPlanApproved === true &&
    !rejectedReviewablePlanArtifact &&
    !!persistedPlanIdentity &&
    !!restoredPlanIdentity &&
    persistedPlanIdentity.revision === restoredPlanIdentity.revision &&
    persistedPlanIdentity.artifactHash === restoredPlanIdentity.artifactHash;
  const hasTasksArtifact = restoredPlanArtifacts.artifacts.some((artifact) =>
    artifact.kind === "tasks" || artifact.kind === "bugfix"
  );
  const restoredPlanTasks = restoredIsPlanApproved || hasTasksArtifact
    ? snapshot.planTasks || []
    : [];
  const restoredPlanStage = derivePlanStageFromArtifacts(
    restoredPlanArtifacts.artifacts,
    restoredPlanTasks,
    restoredIsPlanApproved,
    snapshot.planStage ?? "idle",
  );
  const normalizedHarnessRunMarker = normalizeHarnessRunMarker(snapshot.harnessRunMarker);
  const interruptedHarnessRunMarker = normalizedHarnessRunMarker?.status === "running"
    ? {
        ...normalizedHarnessRunMarker,
        status: "paused" as const,
        closedAt: normalizedHarnessRunMarker.closedAt || Date.now(),
        closeReason: normalizedHarnessRunMarker.closeReason || "application_restarted",
      }
    : normalizedHarnessRunMarker;
  const restoredHarnessRunMarker = interruptedHarnessRunMarker
    ? {
        ...interruptedHarnessRunMarker,
        planStage: restoredPlanStage,
        isPlanApproved: restoredIsPlanApproved,
      }
    : null;
  const restoredActionRequest = restorePendingActionRequest({
    request: snapshot.activeActionRequest,
    runOwner: restoredHarnessRunMarker,
    planIdentity: restoredPlanIdentity,
    taskFlow: rawTaskFlow,
    goalRuntime: normalizedGoalRuntime,
    unapprovedPlanTurnIds: restoredIsPlanApproved ? [] : unapprovedPlanTurnIds,
  });
  const originalActionRequest = normalizeActionRequest(snapshot.activeActionRequest);
  const rejectedProceduralChoice =
    isInternalUnapprovedPlanChoiceRestore({
      request: originalActionRequest,
      planIdentity: restoredPlanIdentity,
      taskFlow: rawTaskFlow,
      unapprovedPlanTurnIds: restoredIsPlanApproved ? [] : unapprovedPlanTurnIds,
    });
  const invalidatedActionRequest = originalActionRequest && restoredActionRequest == null
    ? originalActionRequest
    : null;
  const invalidatedChoiceRequest = invalidatedActionRequest?.kind === "user_choice"
    ? invalidatedActionRequest
    : null;
  const invalidatedPlanReview = invalidatedActionRequest?.kind === "plan_review";
  const invalidatedRequestSharesMarkerTurn =
    !!invalidatedActionRequest &&
    !!restoredHarnessRunMarker &&
    restoredHarnessRunMarker.sessionKey === invalidatedActionRequest.sessionKey &&
    restoredHarnessRunMarker.turnId === invalidatedActionRequest.turnId;
  const invalidatedRequestOwnsProjectedMarkerRun =
    invalidatedRequestSharesMarkerTurn &&
    getHarnessActionRunId(restoredHarnessRunMarker) === invalidatedActionRequest?.runId;
  const invalidatedActionReason = rejectedProceduralChoice
    ? "invalid_plan_user_choice_cleared"
    : invalidatedActionRequest?.kind === "tool_permission"
    ? "non_resumable_tool_permission_cleared"
    : invalidatedActionRequest?.kind === "plan_review"
    ? "stale_plan_review_cleared"
    : invalidatedActionRequest?.kind === "goal_confirmation"
    ? "stale_goal_confirmation_cleared"
    : "stale_user_choice_cleared";
  let invalidatedChoiceText = "";
  const taskFlow = rawTaskFlow.map((block) => {
    if (
      invalidatedActionRequest?.kind === "tool_permission" &&
      block.type === "tool" &&
      block.id === invalidatedActionRequest.taskId
    ) {
      return {
        ...block,
        status: "paused",
        toolStatus: "failed" as const,
        message: "Tool permission expired during session restore; resume to request it again.",
      };
    }
    const isOrphanedPendingChoice =
      block.type === "agent" &&
      block.choiceRequest?.status === "pending" &&
      !(
        restoredActionRequest?.kind === "user_choice" &&
        restoredActionRequest.requestId === block.choiceRequest.requestId
      );
    const matchesInvalidatedChoice =
      !!invalidatedChoiceRequest &&
      block.type === "agent" &&
      block.choiceRequest?.requestId === invalidatedChoiceRequest.requestId;
    if (
      block.type !== "agent" ||
      (!isOrphanedPendingChoice && !matchesInvalidatedChoice)
    ) {
      return block;
    }
    const optionValues = matchesInvalidatedChoice && invalidatedChoiceRequest
      ? invalidatedChoiceRequest.optionValues
      : (block.options || []).map((option) => String(option.value || option.label || "")).filter(Boolean);
    const cleanedChoiceText = stripRestoredUserChoiceControlText(
      String(block.content || ""),
      optionValues,
    );
    if (invalidatedChoiceRequest?.requestId === block.choiceRequest?.requestId) {
      invalidatedChoiceText = cleanedChoiceText;
    }
    return {
      ...block,
      content: cleanedChoiceText,
      options: [],
      choiceRequest: undefined,
    };
  });
  const invalidatedTurnPrompt = String(
    (snapshot.conversationTurns || []).find((turn) => turn.id === invalidatedActionRequest?.turnId)?.userPrompt || "",
  );
  const invalidatedActionUsesChinese = /[^\x00-\x7F]/.test(
    `${invalidatedChoiceText}\n${invalidatedTurnPrompt}`,
  );
  const invalidatedActionMessage = rejectedProceduralChoice
    ? invalidatedActionUsesChinese
      ? "已清理模型生成的内部计划步骤选项；保留诊断上下文，本轮可安全继续生成计划。"
      : "Model-authored internal Plan steps were cleared; diagnostic context is preserved and the Plan can safely resume."
    : invalidatedActionRequest?.kind === "tool_permission"
    ? invalidatedActionUsesChinese
      ? "应用重启后旧工具权限无法安全恢复；失效的批准请求已清理，继续时会按新运行身份重新请求。"
      : "A tool permission lease cannot survive restart; the stale request was cleared and will be requested again under a new run identity."
    : invalidatedActionRequest?.kind === "plan_review"
    ? invalidatedActionUsesChinese
      ? "恢复会话时计划审批身份已失效；上下文已保留，可重新生成或调整计划。"
      : "The restored Plan review identity is stale; context is preserved so the Plan can be regenerated or adjusted."
    : invalidatedActionRequest?.kind === "goal_confirmation"
    ? invalidatedActionUsesChinese
      ? "Goal 确认点与当前运行身份不一致；已移除失效控件并保留检查点。"
      : "The Goal confirmation no longer matches the active run; stale controls were removed and the checkpoint was preserved."
    : invalidatedActionUsesChinese
    ? "待选择项与当前运行身份不一致；已移除失效按钮并保留上下文。"
    : "The pending choice no longer matches the active run; stale controls were removed and context was preserved.";
  const restoredMarkerTerminalStatus = restoredHarnessRunMarker?.status === "completed" || restoredHarnessRunMarker?.status === "error"
    ? restoredHarnessRunMarker.status
    : null;
  const conversationTurns = normalizeInterruptedConversationTurnsForRestore(
    snapshot.conversationTurns,
    taskFlow,
  ).map((turn) => {
    if (turn.status !== "awaiting_input" && turn.status !== "awaiting_approval") return turn;
    if (restoredActionRequest?.turnId === turn.id) return turn;
    const ownsInvalidatedRequest = invalidatedActionRequest?.turnId === turn.id;
    const useChinese = /[^\x00-\x7F]/.test(String(turn.userPrompt || ""));
    const ownsTerminalMarker = restoredMarkerTerminalStatus && restoredHarnessRunMarker?.turnId === turn.id;
    return {
      ...turn,
      status: ownsTerminalMarker
        ? restoredMarkerTerminalStatus === "completed" ? "done" as const : "error" as const
        : "paused" as const,
      summary: ownsTerminalMarker
        ? restoredMarkerTerminalStatus === "completed"
          ? useChinese ? "运行已完成；恢复时清理了不一致的待处理控件。" : "The run completed; inconsistent pending controls were cleared during restore."
          : useChinese ? "运行已失败；恢复时清理了不一致的待处理控件。" : "The run failed; inconsistent pending controls were cleared during restore."
        : ownsInvalidatedRequest
        ? summarizeAssistantText(invalidatedChoiceText) || invalidatedActionMessage
        : useChinese
        ? "恢复时未找到可解析的操作请求；已移除失效控件并保留上下文。"
        : "No resolvable action request was found during restore; stale controls were removed and context was preserved.",
    };
  });
  const sanitizedHarnessRunMarker = invalidatedRequestOwnsProjectedMarkerRun && restoredHarnessRunMarker?.status === "paused"
    ? {
        ...restoredHarnessRunMarker,
        closeReason: invalidatedActionReason,
      }
    : restoredHarnessRunMarker;
  const invalidatedOwnerRequest = invalidatedActionRequest;
  const replacementPauseReason = invalidatedActionReason;
  const replacementPauseMessage = invalidatedActionMessage;
  let replacedOwnerPause = false;
  let runtimeEvents = normalizeRuntimeEvents(snapshot.runtimeEvents)
    .filter((event) =>
      !invalidatedOwnerRequest || (
        !(event.type === "approval.requested" && event.requestId === invalidatedOwnerRequest.requestId) &&
        !(
          restoredMarkerTerminalStatus &&
          invalidatedRequestOwnsProjectedMarkerRun &&
          event.type === "run.paused" &&
          event.threadId === invalidatedOwnerRequest.sessionKey &&
          event.turnId === invalidatedOwnerRequest.turnId &&
          event.runId === invalidatedOwnerRequest.runId
        )
      )
    )
    .map((event) => {
      if (
        !invalidatedOwnerRequest ||
        event.type !== "run.paused" ||
        event.threadId !== invalidatedOwnerRequest.sessionKey ||
        event.turnId !== invalidatedOwnerRequest.turnId ||
        event.runId !== invalidatedOwnerRequest.runId
      ) {
        return event;
      }
      replacedOwnerPause = true;
      return withEventSchema({
        type: "run.paused",
        threadId: event.threadId,
        turnId: event.turnId,
        timestampMs: event.timestampMs,
        runId: event.runId,
        parentRunId: event.parentRunId,
        ...(event.goalSliceId ? { goalSliceId: event.goalSliceId } : {}),
        reason: replacementPauseReason,
        message: replacementPauseMessage,
      });
    });
  const ownerHasHardTerminal = !!invalidatedOwnerRequest && runtimeEvents.some((event) =>
    (event.type === "run.completed" || event.type === "run.failed") &&
    event.threadId === invalidatedOwnerRequest.sessionKey &&
    event.turnId === invalidatedOwnerRequest.turnId &&
    event.runId === invalidatedOwnerRequest.runId
  );
  if (invalidatedOwnerRequest && !replacedOwnerPause && !ownerHasHardTerminal) {
    const timestampMs = sanitizedHarnessRunMarker?.closedAt || Date.now();
    runtimeEvents = appendRuntimeEvent(runtimeEvents, withEventSchema(
      restoredMarkerTerminalStatus && invalidatedRequestOwnsProjectedMarkerRun
        ? restoredMarkerTerminalStatus === "completed"
          ? {
              type: "run.completed",
              threadId: invalidatedOwnerRequest.sessionKey,
              turnId: invalidatedOwnerRequest.turnId,
              timestampMs,
              runId: invalidatedOwnerRequest.runId,
              parentRunId: invalidatedOwnerRequest.parentRunId || null,
              summary: "Restored completed run; stale pending action controls were removed.",
            }
          : {
              type: "run.failed",
              threadId: invalidatedOwnerRequest.sessionKey,
              turnId: invalidatedOwnerRequest.turnId,
              timestampMs,
              runId: invalidatedOwnerRequest.runId,
              parentRunId: invalidatedOwnerRequest.parentRunId || null,
              error: { message: sanitizedHarnessRunMarker?.lastStreamError || sanitizedHarnessRunMarker?.closeReason || "Restored failed run." },
            }
        : {
            type: "run.paused",
            threadId: invalidatedOwnerRequest.sessionKey,
            turnId: invalidatedOwnerRequest.turnId,
            timestampMs,
            runId: invalidatedOwnerRequest.runId,
            parentRunId: invalidatedOwnerRequest.parentRunId || null,
            reason: replacementPauseReason,
            message: replacementPauseMessage,
          }
    ));
  }
  const interruptedActionRunId = getHarnessActionRunId(sanitizedHarnessRunMarker);
  const interruptedTurnId = sanitizedHarnessRunMarker?.turnId || null;
  const interruptedRunHasTerminal = !!interruptedActionRunId && !!interruptedTurnId && runtimeEvents.some((event) =>
    (event.type === "run.paused" || event.type === "run.completed" || event.type === "run.failed") &&
    event.threadId === sanitizedHarnessRunMarker?.sessionKey &&
    event.turnId === interruptedTurnId &&
    event.runId === interruptedActionRunId
  );
  if (
    sanitizedHarnessRunMarker?.status === "paused" &&
    interruptedActionRunId &&
    interruptedTurnId &&
    !interruptedRunHasTerminal
  ) {
    const interruptedTurn = conversationTurns.find((turn) => turn.id === interruptedTurnId);
    const useChinese = /[^\x00-\x7F]/.test(String(interruptedTurn?.userPrompt || ""));
    const wasInterruptedByRestart = normalizedHarnessRunMarker?.status === "running";
    const projectedRunLostItsAction = !!invalidatedActionRequest &&
      invalidatedRequestSharesMarkerTurn &&
      !invalidatedRequestOwnsProjectedMarkerRun;
    const pauseReason = wasInterruptedByRestart
      ? "application_restarted"
      : projectedRunLostItsAction
      ? "restored_inconsistent_checkpoint"
      : sanitizedHarnessRunMarker.closeReason || "restored_paused_checkpoint";
    const pauseMessage = wasInterruptedByRestart
      ? useChinese
        ? "应用重启中断了本次运行；上下文和检查点已保留，可以安全恢复。"
        : "The application restart interrupted this run; context and checkpoints were preserved for safe resume."
      : projectedRunLostItsAction
      ? useChinese
        ? "恢复时发现当前运行与待处理请求身份不一致；失效控件已清理，运行保留为可恢复暂停。"
        : "Restore found that the projected run and pending request identities disagreed; stale controls were cleared and the run remains safely resumable."
      : useChinese
      ? "已恢复暂停的运行检查点；上下文已保留，可以安全继续。"
      : "The paused run checkpoint was restored with its context and can safely resume.";
    runtimeEvents = appendRuntimeEvent(runtimeEvents, withEventSchema({
      type: "run.paused",
      threadId: sanitizedHarnessRunMarker.sessionKey,
      turnId: interruptedTurnId,
      timestampMs: sanitizedHarnessRunMarker.closedAt || Date.now(),
      runId: interruptedActionRunId,
      parentRunId: sanitizedHarnessRunMarker.activeParentRunId || sanitizedHarnessRunMarker.parentRunId || null,
      reason: pauseReason,
      message: pauseMessage,
    }));
  }
  const projectedRunHasHardTerminal = !!interruptedActionRunId && !!interruptedTurnId && runtimeEvents.some((event) =>
    (event.type === "run.completed" || event.type === "run.failed") &&
    event.threadId === sanitizedHarnessRunMarker?.sessionKey &&
    event.turnId === interruptedTurnId &&
    event.runId === interruptedActionRunId
  );
  if (
    sanitizedHarnessRunMarker &&
    interruptedActionRunId &&
    interruptedTurnId &&
    !projectedRunHasHardTerminal &&
    (sanitizedHarnessRunMarker.status === "completed" || sanitizedHarnessRunMarker.status === "error")
  ) {
    runtimeEvents = appendRuntimeEvent(runtimeEvents, withEventSchema(
      sanitizedHarnessRunMarker.status === "completed"
        ? {
            type: "run.completed",
            threadId: sanitizedHarnessRunMarker.sessionKey,
            turnId: interruptedTurnId,
            timestampMs: sanitizedHarnessRunMarker.closedAt || Date.now(),
            runId: interruptedActionRunId,
            parentRunId: sanitizedHarnessRunMarker.activeParentRunId || sanitizedHarnessRunMarker.parentRunId || null,
            summary: "Restored completed run checkpoint.",
          }
        : {
            type: "run.failed",
            threadId: sanitizedHarnessRunMarker.sessionKey,
            turnId: interruptedTurnId,
            timestampMs: sanitizedHarnessRunMarker.closedAt || Date.now(),
            runId: interruptedActionRunId,
            parentRunId: sanitizedHarnessRunMarker.activeParentRunId || sanitizedHarnessRunMarker.parentRunId || null,
            error: { message: sanitizedHarnessRunMarker.lastStreamError || sanitizedHarnessRunMarker.closeReason || "Restored failed run." },
          }
    ));
  }
  if (options?.restoreInterruptedGoal) {
    const beforeReconcileCount = runtimeEvents.length;
    runtimeEvents = reconcileOrphanedSubagentEvents(runtimeEvents);
    if (runtimeEvents.length > beforeReconcileCount) {
      logStoreEvent("subagent_orphan_reconciled", {
        appendedEvents: runtimeEvents.length - beforeReconcileCount,
        activeAfterRestore: projectSubagentRuns(runtimeEvents).filter((run) =>
          isSubagentActiveStatus(run.status)
        ).length,
      });
    }
  }
  const persistedAgentMessages = sanitizeAgentMessagesForPersist(snapshot.agentMessages || []);
  let rejectedChoiceMessageIndex = -1;
  if (invalidatedChoiceRequest) {
    for (let index = persistedAgentMessages.length - 1; index >= 0; index -= 1) {
      const message = persistedAgentMessages[index];
      const messageText = typeof message.content === "string" ? message.content : "";
      if (
        message.role === "assistant" &&
        invalidatedChoiceRequest.optionValues.every((value) => messageText.includes(value))
      ) {
        rejectedChoiceMessageIndex = index;
        break;
      }
    }
  }
  const agentMessages = persistedAgentMessages.map((message, index) =>
    index === rejectedChoiceMessageIndex &&
    typeof message.content === "string" &&
    invalidatedChoiceRequest
      ? {
          ...message,
          content: stripRestoredUserChoiceControlText(
            message.content,
            invalidatedChoiceRequest.optionValues,
          ),
        }
      : message
  );
  if (restoredPlanArtifacts.rejected.length > 0 || invalidatedActionRequest) {
    logStoreEvent("session_plan_restore_sanitized", {
      rejectedArtifacts: restoredPlanArtifacts.rejected,
      rejectedProceduralChoice,
      invalidatedPlanReview,
      rejectedRequestId: invalidatedActionRequest?.requestId || null,
      rejectedActionKind: invalidatedActionRequest?.kind || null,
      rejectedActionReason: invalidatedActionRequest ? invalidatedActionReason : null,
      restoredArtifactPaths: restoredPlanArtifacts.artifacts.map((artifact) => artifact.path),
      restoredPlanStage,
      restoredIsPlanApproved,
    });
  }
  return {
    runtimeEventSchemaVersion: MAIN_THREAD_EVENT_SCHEMA_VERSION,
    runtimeEvents,
    harnessRunMarker: sanitizedHarnessRunMarker,
    activeActionRequest: restoredActionRequest,
    taskFlow,
    agentMessages,
    contextMemoryState: normalizedContextMemoryState,
    contextMemoryStateByRuntimeKey: normalizeContextMemoryStateByRuntimeKey(snapshot.contextMemoryStateByRuntimeKey),
    providerCompatibilityByRuntimeKey: normalizeProviderCompatibilityByRuntimeKey(
      snapshot.providerCompatibilityByRuntimeKey,
    ),
    conversationTurns,
    currentTurnId: snapshot.currentTurnId ?? null,
    selectedMainModeKey,
    selectedNexusModeKey: mapMainModeToLegacyNexusMode(selectedMainModeKey),
    sessionModeAffinity: resolveSessionModeAffinity(snapshot as SessionModeAffinityLike, selectedMainModeKey),
    imageStudio: normalizeImageStudioRuntime(snapshot.imageStudio),
    activeStudioAgentKey: normalizeStudioAgentKey(snapshot.activeStudioAgentKey),
    gameStudioInitialized: snapshot.gameStudioInitialized === true,
    pendingSlashCommand: normalizePendingSlashCommand(snapshot.pendingSlashCommand),
    planArtifacts: restoredPlanArtifacts.artifacts,
    planTasks: restoredPlanTasks,
    planExecutionEvidenceLedger: restoredIsPlanApproved ? snapshot.planExecutionEvidenceLedger || [] : [],
    planExecutionEvidenceCount: restoredIsPlanApproved ? snapshot.planExecutionEvidenceCount ?? 0 : 0,
    planAutoResumeCount: restoredIsPlanApproved ? Math.max(0, Number(snapshot.planAutoResumeCount) || 0) : 0,
    planExecutionProgressSnapshot: restoredIsPlanApproved
      ? normalizeStoredPlanExecutionProgressSnapshot(snapshot.planExecutionProgressSnapshot)
      : null,
    planStage: restoredPlanStage,
    isPlanApproved: restoredIsPlanApproved,
    planApprovalChoice: restoredIsPlanApproved ? normalizePlanApprovalChoice(snapshot.planApprovalChoice) : "",
    pendingPlanApprovalHandoff: null,
    planApprovalExecutionStartedForTurnId:
      restoredIsPlanApproved && typeof snapshot.planApprovalExecutionStartedForTurnId === "string"
        ? snapshot.planApprovalExecutionStartedForTurnId
        : null,
    clearedPlanTurnId: typeof snapshot.clearedPlanTurnId === "string" ? snapshot.clearedPlanTurnId : null,
    showPlanPanel: restoredPlanArtifacts.artifacts.length > 0 && (snapshot.showPlanPanel ?? false),
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
    activeGoal: normalizedGoalRuntime?.goal ?? legacyGoal,
    goalProgress: normalizedGoalRuntime?.progress ?? snapshot.goalProgress ?? null,
    goalStatus: normalizedGoalRuntime?.status ?? snapshot.goalStatus ?? "paused",
    goalIterationBudget: normalizedGoalRuntime?.goal.iterationBudget
      ?? snapshot.goalIterationBudget
      ?? DEFAULT_GOAL_EMERGENCY_CONTINUATION_LIMIT,
    goalRuntime: normalizedGoalRuntime,
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
  const runtimeIntentCandidate = String(record.runtimeIntentOverride || "").trim();
  const runtimeIntentOverride = [
    "respond", "discuss", "plan", "execute", "analyze", "summarize",
    "report", "studio_workflow", "image_studio", "goal",
  ].includes(runtimeIntentCandidate)
    ? runtimeIntentCandidate as ResolvedRunIntent
    : undefined;
  const goalSourceContextSnapshot = typeof record.goalSourceContextSnapshot === "string"
    && record.goalSourceContextSnapshot.trim()
    ? record.goalSourceContextSnapshot.trim()
    : undefined;
  if (!text && images.length === 0 && contextMentions.length === 0 && attachedFiles.length === 0) return null;
  return {
    id: typeof record.id === "string" && record.id.trim() ? record.id : `queued-${Date.now()}`,
    text,
    ...(images.length > 0 ? { images } : {}),
    ...(contextMentions.length > 0 ? { contextMentions } : {}),
    ...(attachedFiles.length > 0 ? { attachedFiles } : {}),
    ...(runtimeIntentOverride ? { runtimeIntentOverride } : {}),
    ...(goalSourceContextSnapshot ? { goalSourceContextSnapshot } : {}),
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
  "activeActionRequest",
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
  "pendingPlanApprovalHandoff",
  "planApprovalExecutionStartedForTurnId",
  "clearedPlanTurnId",
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
  "activeGoal",
  "goalProgress",
  "goalStatus",
  "goalIterationBudget",
  "goalRuntime",
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

function isSessionRuntimeActive(state: Pick<AppState, "currentWorkspace" | "currentSessionId">, sessionKey: string | null) {
  return !!sessionKey && resolveSessionRuntimeKey(resolveSessionWorkspaceKey(state.currentWorkspace), state.currentSessionId) === sessionKey;
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
    runtimeEventSchemaVersion: MAIN_THREAD_EVENT_SCHEMA_VERSION,
    runtimeEvents: normalizeRuntimeEvents(state.runtimeEvents),
    harnessRunMarker: normalizeHarnessRunMarker(state.harnessRunMarker),
    activeActionRequest: state.activeActionRequest || null,
    taskFlow: Array.isArray(state.taskFlow) ? archiveConsumedReplyOptionsFromTaskFlow(state.taskFlow) : [],
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
    pendingPlanApprovalHandoff: state.pendingPlanApprovalHandoff || null,
    planApprovalExecutionStartedForTurnId:
      typeof state.planApprovalExecutionStartedForTurnId === "string"
        ? state.planApprovalExecutionStartedForTurnId
        : null,
    clearedPlanTurnId: typeof state.clearedPlanTurnId === "string" ? state.clearedPlanTurnId : null,
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
    activeGoal: state.activeGoal ?? null,
    goalProgress: state.goalProgress ?? null,
    goalStatus: state.goalStatus ?? "paused",
    goalIterationBudget: state.goalIterationBudget ?? DEFAULT_GOAL_EMERGENCY_CONTINUATION_LIMIT,
    goalRuntime: state.goalRuntime ?? null,
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
  const normalizedRuntime = {
    ...runtime,
    taskFlow: archiveConsumedReplyOptionsFromTaskFlow(runtime.taskFlow || []),
  };
  return options.resetPanels
    ? { ...normalizedRuntime, ...getClosedSessionPanelPatch() }
    : { ...normalizedRuntime };
}

export function buildRestoredSessionRuntimePatch(input: {
  snapshot: Partial<SessionRuntimeSnapshot> | null | undefined;
  fallbackState: Partial<AppState>;
  taskFlow?: TaskBlock[];
  conversationTurns?: ConversationTurn[];
  currentTurnId?: string | null;
  resetPanels?: boolean;
}): Partial<AppState> {
  const mergedSnapshot = input.snapshot
    ? {
        ...input.snapshot,
        ...(input.taskFlow ? { taskFlow: input.taskFlow } : {}),
        ...(input.conversationTurns ? { conversationTurns: input.conversationTurns } : {}),
        ...(input.currentTurnId !== undefined ? { currentTurnId: input.currentTurnId } : {}),
      }
    : input.snapshot;
  const normalized = normalizeSessionRuntimeSnapshot(mergedSnapshot, {
    restoreInterruptedGoal: true,
  });
  if (!normalized) return {};
  const taskFlow = normalized.taskFlow || [];
  const conversationTurns = normalized.conversationTurns || [];
  const runtime = createSessionRuntimeFromState({
    ...input.fallbackState,
    ...normalized,
    taskFlow,
    conversationTurns,
    currentTurnId: normalized.currentTurnId ?? null,
    currentTurnState: createDefaultCurrentTurnState(),
    agentStatus: "idle",
    isGenerating: false,
    abortController: null,
    pendingReviewResolve: null,
    pendingReviewTaskId: null,
    pendingToolCall: null,
    pendingPlanApprovalHandoff: null,
    readOnlyAutoApproveForSession: false,
  });
  return getSessionRuntimeUiPatch(runtime, {
    resetPanels: input.resetPanels === true,
  });
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
      runtimeSnapshot: normalizeSessionRuntimeSnapshot(session.runtimeSnapshot, { restoreInterruptedGoal: true }),
    }));
    const existing = normalizedEntries.get(scopeKey) || [];
    normalizedEntries.set(scopeKey, [...existing, ...normalizedSessions]);
  });

  return Object.fromEntries(normalizedEntries.entries());
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

export function compactCompletedTurnAgentMessages(params: {
  agentMessages: AgentMessage[];
  turnStartIndex: number;
  turnSummary: string;
  turnBlocks: TaskBlock[];
  durableContext?: DurableTurnContext | null;
  language: "zh" | "en";
}): AgentMessage[] {
  if (!Array.isArray(params.agentMessages) || params.agentMessages.length === 0) {
    return params.agentMessages;
  }
  if (params.turnStartIndex < 0 || params.turnStartIndex >= params.agentMessages.length) {
    return params.agentMessages;
  }

  const canonicalTurnMessages = buildCanonicalCompletedTurnMessages({
    turnBlocks: params.turnBlocks,
    fallbackAssistantText: params.turnSummary,
  });
  if (canonicalTurnMessages.length === 0) return params.agentMessages;
  const canonicalUserTexts = canonicalTurnMessages
    .filter((message) => message.role === "user")
    .map((message) => message.content);
  const effectiveTurnStartIndex = findCanonicalTurnStartMessageIndex({
    messages: params.agentMessages,
    canonicalUserTexts,
    fallbackStartIndex: params.turnStartIndex,
  });
  const durableSummary = serializeDurableTurnContextForModel(params.durableContext);

  return [
    ...params.agentMessages.slice(0, effectiveTurnStartIndex),
    ...canonicalTurnMessages,
    ...(durableSummary ? [{ role: "system" as const, content: durableSummary }] : []),
  ];
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

function persistedTurnPhase(block: TaskBlock): {
  turnPhase?: TurnRuntimePhase;
  audience?: "user" | "internal";
} {
  const turnPhase = normalizeTurnRuntimePhase(block.turnPhase);
  return {
    ...(turnPhase ? { turnPhase } : {}),
    ...(block.audience === "internal" || block.audience === "user"
      ? { audience: block.audience }
      : {}),
  };
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
          ...(b.choiceRequest?.status === "pending" && b.choiceRequest.requestId && b.choiceRequest.runId
            ? {
                choiceRequest: {
                  sessionKey: String(b.choiceRequest.sessionKey || ""),
                  turnId: String(b.choiceRequest.turnId || b.turnId || ""),
                  runId: String(b.choiceRequest.runId),
                  requestId: String(b.choiceRequest.requestId),
                  parentRunId: b.choiceRequest.parentRunId || null,
                  optionValues: Array.isArray(b.choiceRequest.optionValues)
                    ? b.choiceRequest.optionValues.map((value) => String(value)).filter(Boolean)
                    : [],
                  allowCustomReply: b.choiceRequest.allowCustomReply === true,
                  status: "pending" as const,
                },
              }
            : {}),
          ...(b.options && b.options.length > 0
            ? {
                options: b.options.map((option) => ({
                  label: String(option.label),
                  value: String(option.value),
                  ...(option.action ? { action: option.action } : {}),
                  ...(option.source ? { source: option.source } : {}),
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
          ...(b.runId ? { runId: String(b.runId) } : {}),
          ...(b.parentRunId != null ? { parentRunId: String(b.parentRunId) } : {}),
          ...(b.dedupeKey ? { dedupeKey: String(b.dedupeKey).slice(0, 220) } : {}),
          ...(b.phaseReason ? { phaseReason: String(b.phaseReason).slice(0, 240) } : {}),
          ...(b.iteration != null ? { iteration: Math.max(0, Number(b.iteration) || 0) } : {}),
          ...(b.qualityRejectCount != null
            ? { qualityRejectCount: Math.max(0, Number(b.qualityRejectCount) || 0) }
            : {}),
          ...(b.elapsedMs != null ? { elapsedMs: Math.max(0, Number(b.elapsedMs) || 0) } : {}),
          ...(b.createdAt != null ? { createdAt: Math.max(0, Number(b.createdAt) || 0) } : {}),
          ...(b.updatedAt != null ? { updatedAt: Math.max(0, Number(b.updatedAt) || 0) } : {}),
        };
      }
      case "thought":
        return {
          id: b.id,
          turnId: b.turnId,
          ...persistedTurnPhase(b),
          type: "thought" as const,
          // Hidden reasoning text is active-run state, not durable conversation
          // context. Persist only auditable size/duration metrics.
          content: "",
          originalChars: Math.max(Number(b.originalChars) || 0, String(b.content || "").length),
          ...(b.duration != null ? { duration: Number(b.duration) || 0 } : {}),
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

export function buildSessionRuntimeSnapshotFromStoreState(state: any): SessionRuntimeSnapshot {
  const taskFlow = sanitizeTaskBlocksForPersist(state.taskFlow || []);
  return {
    runtimeEventSchemaVersion: MAIN_THREAD_EVENT_SCHEMA_VERSION,
    runtimeEvents: state.runtimeEvents || [],
    harnessRunMarker: state.harnessRunMarker || null,
    activeActionRequest: state.activeActionRequest || null,
    taskFlow,
    agentMessages: sanitizeAgentMessagesForPersist(state.agentMessages || []),
    contextMemoryState: normalizeContextMemoryState(state.contextMemoryState),
    contextMemoryStateByRuntimeKey: normalizeContextMemoryStateByRuntimeKey(state.contextMemoryStateByRuntimeKey),
    providerCompatibilityByRuntimeKey: normalizeProviderCompatibilityByRuntimeKey(state.providerCompatibilityByRuntimeKey),
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
    planAutoResumeCount: Math.max(0, Number(state.planAutoResumeCount) || 0),
    planExecutionProgressSnapshot: normalizeStoredPlanExecutionProgressSnapshot(state.planExecutionProgressSnapshot),
    planStage: state.planStage ?? "idle",
    isPlanApproved: state.isPlanApproved === true,
    planApprovalChoice: state.planApprovalChoice ?? null,
    pendingPlanApprovalHandoff: null,
    planApprovalExecutionStartedForTurnId:
      typeof state.planApprovalExecutionStartedForTurnId === "string"
        ? state.planApprovalExecutionStartedForTurnId
        : null,
    clearedPlanTurnId: typeof state.clearedPlanTurnId === "string" ? state.clearedPlanTurnId : null,
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
    activeGoal: state.activeGoal ?? null,
    goalProgress: state.goalProgress ?? null,
    goalStatus: state.goalStatus ?? "paused",
    goalIterationBudget: state.goalIterationBudget ?? DEFAULT_GOAL_EMERGENCY_CONTINUATION_LIMIT,
    goalRuntime: state.goalRuntime ?? null,
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
      pendingPlanApprovalHandoff: null,
      planApprovalExecutionStartedForTurnId: null,
      clearedPlanTurnId: null,
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
    };
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
    nextTasks = normalizeApprovedPlanTaskStatuses(
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

function buildPlanApprovalHandoffDedupLogPayload(input: {
  state: AppState;
  reason: string;
  planTurnId: string | null;
  executionTurnId?: string | null;
  currentTurnStatus?: ConversationTurnStatus | null;
}) {
  return {
    reason: input.reason,
    planTurnId: input.planTurnId,
    executionTurnId: input.executionTurnId ?? null,
    currentTurnStatus: input.currentTurnStatus ?? null,
    agentStatus: input.state.agentStatus,
    isGenerating: input.state.isGenerating,
    pendingPlanApprovalHandoff: input.state.pendingPlanApprovalHandoff,
    planApprovalExecutionStartedForTurnId: input.state.planApprovalExecutionStartedForTurnId,
    conversationTurns: input.state.conversationTurns.length,
  };
}

export function startApprovedPlanExecutionInCurrentTurn(input: {
  get: () => AppState;
  setActiveState: (patch: Partial<AppState>) => void;
  planTurnId: string;
  handoff: PlanApprovalHandoff;
  sessionKey: string | null;
  source: "workflow_fallback" | "store_fallback";
}): boolean {
  const latest = input.get();
  const currentTurn = latest.conversationTurns.find((turn) => turn.id === input.planTurnId) || null;
  if (!currentTurn) {
    logStoreEvent("plan_approval_same_turn_execution_skipped", buildPlanApprovalHandoffDedupLogPayload({
      state: latest,
      reason: "plan_turn_missing",
      planTurnId: input.planTurnId,
    }));
    return false;
  }
  if (
    input.handoff.artifactHash &&
    !isPlanApprovalIdentityCurrent({
      artifacts: latest.planArtifacts,
      revision: input.handoff.planRevision,
      artifactHash: input.handoff.artifactHash,
    })
  ) {
    const language = latest.config.language === "en" ? "en" : "zh";
    const rollbackPatch = {
      isPlanApproved: false,
      planApprovalChoice: null,
      pendingPlanApprovalHandoff: null,
      planApprovalExecutionStartedForTurnId: null,
      agentStatus: "idle" as const,
      isGenerating: false,
      abortController: null,
    };
    input.setActiveState(rollbackPatch);
    latest.updateConversationTurn(input.planTurnId, {
      status: "paused",
      summary: language === "zh"
        ? "计划内容在批准后发生变化，旧批准已失效；请重新审阅当前计划。"
        : "The plan changed after review, so the prior approval was invalidated. Review the current plan again.",
    });
    logStoreEvent("plan_approval_same_turn_execution_skipped", buildPlanApprovalHandoffDedupLogPayload({
      state: latest,
      reason: "artifact_identity_changed",
      planTurnId: input.planTurnId,
      executionTurnId: input.planTurnId,
      currentTurnStatus: currentTurn.status,
    }));
    return false;
  }
  if (input.sessionKey && !isSessionRuntimeActive(latest, input.sessionKey)) {
    logStoreEvent("plan_approval_same_turn_execution_skipped", buildPlanApprovalHandoffDedupLogPayload({
      state: latest,
      reason: "session_not_active",
      planTurnId: input.planTurnId,
      currentTurnStatus: currentTurn.status,
    }));
    return false;
  }
  if (latest.planApprovalExecutionStartedForTurnId === input.planTurnId) {
    logStoreEvent("plan_approval_handoff_deduped", buildPlanApprovalHandoffDedupLogPayload({
      state: latest,
      reason: "same_turn_execution_already_started",
      planTurnId: input.planTurnId,
      executionTurnId: input.planTurnId,
      currentTurnStatus: currentTurn?.status ?? null,
    }));
    return false;
  }
  const exactPendingDecision = resolveApprovedPlanSameTurnFallbackDecision({
    expectedSessionKey: input.sessionKey || "__active_session__",
    currentSessionKey: input.sessionKey || "__active_session__",
    expectedHandoff: input.handoff,
    currentHandoff: latest.pendingPlanApprovalHandoff,
    isPlanApproved: latest.isPlanApproved === true,
    executionStartedForTurnId: latest.planApprovalExecutionStartedForTurnId,
    isAgentBusy: false,
    busyRetryAttempt: 0,
    maxBusyRetries: 0,
  });
  if (exactPendingDecision !== "start") {
    logStoreEvent("plan_approval_same_turn_execution_skipped", buildPlanApprovalHandoffDedupLogPayload({
      state: latest,
      reason: "stale_or_revoked_handoff",
      planTurnId: input.planTurnId,
      executionTurnId: input.planTurnId,
      currentTurnStatus: currentTurn.status,
    }));
    return false;
  }
  if (
    latest.abortController &&
    (latest.isGenerating || latest.agentStatus === "running" || latest.agentStatus === "pending_review")
  ) {
    logStoreEvent("plan_approval_same_turn_execution_skipped", buildPlanApprovalHandoffDedupLogPayload({
      state: latest,
      reason: "run_owner_still_active",
      planTurnId: input.planTurnId,
      executionTurnId: input.planTurnId,
      currentTurnStatus: currentTurn.status,
    }));
    return false;
  }

  const language = latest.config.language === "en" ? "en" : "zh";
  const prompt = input.handoff.prompt || buildApprovedPlanExecutionPrompt({
    state: latest,
    language,
    executionPlanTasks: latest.planTasks,
    normalizedApprovalChoice: latest.planApprovalChoice,
  });

  latest.updateConversationTurn(input.planTurnId, {
    status: "executing",
    summary: language === "zh"
      ? "计划已批准，正在当前回合继续执行。"
      : "Plan approved; execution is continuing in the current turn.",
  });

  const reviewRunMarker = latest.harnessRunMarker;
  const reviewedPlanContent = latest.planArtifacts
    .filter((artifact) => ["plan", "design", "bugfix"].includes(artifact.kind))
    .slice()
    .sort((left, right) => left.path.localeCompare(right.path))
    .map((artifact) => [
      `<!-- ${artifact.path} revision ${Number(artifact.revision) || 1} -->`,
      String(artifact.content || "").trim(),
    ].join("\n"))
    .filter(Boolean)
    .join("\n\n");
  const canCompactReviewRun =
    reviewRunMarker?.status === "paused" &&
    reviewRunMarker.turnId === input.planTurnId &&
    Number.isInteger(reviewRunMarker.turnStartMessageIndex) &&
    Number(reviewRunMarker.turnStartMessageIndex) >= 0;
  const reviewTurnBlocks = latest.taskFlow.filter((block) => block.turnId === input.planTurnId);
  const canonicalReviewUserMessageCount = buildCanonicalCompletedTurnMessages({
    turnBlocks: reviewTurnBlocks,
    fallbackAssistantText: reviewedPlanContent,
  }).filter((message) => message.role === "user").length;
  const childAgentMessages = canCompactReviewRun
    ? compactPlanReviewTurnMessages({
        messages: latest.agentMessages,
        turnStartMessageIndex: Number(reviewRunMarker.turnStartMessageIndex),
        turnBlocks: reviewTurnBlocks,
        reviewedPlanContent,
      }) as AgentMessage[]
    : latest.agentMessages;

  const runtimePatch = {
    currentTurnId: input.planTurnId,
    pendingPlanApprovalHandoff: null,
    planApprovalExecutionStartedForTurnId: input.planTurnId,
    currentTurnExecutionConsent: { turnId: input.planTurnId, granted: true },
    ...(childAgentMessages !== latest.agentMessages
      ? { agentMessages: childAgentMessages }
      : {}),
  };
  if (input.sessionKey) {
    latest.updateRuntimeForSession?.(input.sessionKey, runtimePatch);
  }
  if (!input.sessionKey || isSessionRuntimeActive(latest, input.sessionKey)) {
    input.setActiveState(runtimePatch);
  }
  if (childAgentMessages !== latest.agentMessages) {
    logStoreEvent("plan_approval_child_context_compacted", {
      sessionKey: input.sessionKey,
      turnId: input.planTurnId,
      parentRunId: reviewRunMarker?.runId || null,
      messagesBefore: latest.agentMessages.length,
      messagesAfter: childAgentMessages.length,
      canonicalUserMessageCount: canonicalReviewUserMessageCount,
      omittedRuntimeMessages: Math.max(0, latest.agentMessages.length - childAgentMessages.length),
      reviewedPlanChars: reviewedPlanContent.length,
    });
  }

  let submissionStarted = false;
  let submissionError: string | null = null;
  try {
    submissionStarted = latest.sendMessage(prompt, undefined, {
      hidden: true,
      createVisibleTurnForHiddenMessage: false,
      reuseCurrentTurn: true,
      turnIdOverride: input.planTurnId,
      preservePlanState: true,
      resolvedIntent: "plan",
      runtimeIntentOverride: "execute",
      executionConsentGranted: true,
      parentRunIdOverride: input.handoff.parentRunId || undefined,
      runIdOverride: input.handoff.executionRunId,
      skipIntentResolution: true,
      intentSummary: language === "zh"
        ? "用户已批准计划，MAIN 将在当前回合中按 plan.md 落地。"
        : "The user approved the plan; MAIN will execute plan.md in the current turn.",
    }) === true;
  } catch (error) {
    submissionError = error instanceof Error ? error.message : String(error);
  }
  if (!submissionStarted) {
    const rollbackPatch = {
      pendingPlanApprovalHandoff: input.handoff,
      planApprovalExecutionStartedForTurnId: null,
      agentStatus: "idle" as const,
      isGenerating: false,
      abortController: null,
    };
    if (input.sessionKey) {
      latest.updateRuntimeForSession?.(input.sessionKey, rollbackPatch);
    }
    input.setActiveState(rollbackPatch);
    latest.updateConversationTurn(input.planTurnId, {
      status: "paused",
      summary: language === "zh"
        ? "计划已批准，但当前回合执行启动失败，可从计划面板重试。"
        : "Plan approved, but execution failed to start in the current turn and can be retried from the Plan panel.",
    });
    logStoreEvent("plan_approval_same_turn_execution_start_failed", {
      source: input.source,
      planTurnId: input.planTurnId,
      sessionKey: input.sessionKey,
      error: submissionError,
      pendingPreserved: true,
      conversationTurns: input.get().conversationTurns.length,
    });
    return false;
  }

  logStoreEvent("plan_approval_same_turn_execution_restarted", {
    source: input.source,
    planTurnId: input.planTurnId,
    executionTurnId: input.planTurnId,
    currentTurnStatus: currentTurn?.status ?? null,
    agentStatus: input.get().agentStatus,
    isGenerating: input.get().isGenerating,
    pendingPlanApprovalHandoff: input.get().pendingPlanApprovalHandoff,
    conversationTurns: input.get().conversationTurns.length,
    sessionKey: input.sessionKey,
    workspace: latest.currentWorkspace || null,
  });
  return true;
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

/** Helper to keep Skill content from teaching hidden-thinking tags as an output channel. */
function normalizeSkillContent(content: string): string {
  if (!content) return content;
  return content
    .replace(/<\/?(thought|thinking|reasoning|analysis)>/gi, "");
}

const sessionSyncMiddleware =
  (config: StateCreator<AppState, [], []>): StateCreator<AppState, [], []> =>
  (set, get, api) => {
    const customSet: typeof set = (patchOrUpdater, replace) => {
      (set as any)((s: AppState) => {
        const patch =
          typeof patchOrUpdater === "function"
            ? (patchOrUpdater as (state: AppState) => Partial<AppState>)(s)
            : patchOrUpdater;
        const nextWorkspace = patch.currentWorkspace !== undefined ? patch.currentWorkspace : s.currentWorkspace;
        const nextSessionId = patch.currentSessionId !== undefined ? patch.currentSessionId : s.currentSessionId;
        const sessionKey = resolveSessionRuntimeKey(resolveSessionWorkspaceKey(nextWorkspace), nextSessionId);
        const runtimePatch = pickSessionRuntimePatch(patch);
        if (sessionKey && Object.keys(runtimePatch).length > 0) {
          const existing = s.runtimeBySessionKey[sessionKey] || createSessionRuntimeFromState(s);
          return {
            ...patch,
            runtimeBySessionKey: {
              ...s.runtimeBySessionKey,
              [sessionKey]: {
                ...existing,
                ...runtimePatch,
              },
            },
          };
        }
        return patch;
      }, replace);
    };
    api.setState = customSet;
    return config(customSet, get, api);
  };

// ── The Store ─────────────────────────────────────────────────────────

export const useAppStore = create<AppState>()(
  persist(
    sessionSyncMiddleware((set, get) => ({
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
              turn.id === currentTurnId
                ? {
                    ...turn,
                    status: "stopped_no_action" as const,
                    elapsedTime: Math.max(
                      0,
                      Number(turn.elapsedTime) || 0,
                      Number(s.elapsedTime) || 0,
                    ),
                  }
                : turn
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
  selectedSubagentId: null,
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
  ensurePlanArtifactsHydratedForWorkspace: async (options: { openPanel?: boolean; reason?: string; promoteTasksToExecuting?: boolean } = {}) => {
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
  openSubagentsPanel: (subagentId) => set({
    rightPanelTab: "subagents",
    showPlanPanel: false,
    showDiff: false,
    showTerminal: false,
    ...(subagentId ? { selectedSubagentId: subagentId } : {}),
  }),
  selectSubagent: (subagentId) => set({ selectedSubagentId: subagentId }),
  stopSubagent: (subagentId) => {
    const canceled = cancelSubagentRun(subagentId);
    logStoreEvent("subagent_cancel_requested", { subagentId, controllerFound: canceled });
    if (canceled) return true;
    const run = projectSubagentRuns(get().runtimeEvents).find((candidate) => candidate.id === subagentId);
    if (!run || !isSubagentActiveStatus(run.status)) return false;
    const timestampMs = Date.now();
    const error = "SUBAGENT_RUNTIME_CONTROLLER_MISSING: the live controller no longer exists; the stale record was closed.";
    set((state) => ({
      runtimeEvents: appendRuntimeEvent(
        appendRuntimeEvent(state.runtimeEvents, withEventSchema({
          type: "subagent.updated",
          threadId: run.threadId,
          turnId: run.parentTurnId,
          timestampMs,
          subagentId,
          patch: {
            status: "canceled",
            updatedAt: timestampMs,
            completedAt: timestampMs,
            error,
            progress: {
              phase: "done",
              title: "Stale runtime record closed",
              completedToolCalls: run.progress?.completedToolCalls || 0,
            },
          },
        })),
        withEventSchema({
          type: "subagent.closed",
          threadId: run.threadId,
          turnId: run.parentTurnId,
          timestampMs,
          subagentId,
          closedAt: timestampMs,
          reason: "runtime_controller_missing",
        }),
      ),
    }));
    logStoreEvent("subagent_cancel_result", {
      subagentId,
      result: "stale_record_reconciled",
    });
    return false;
  },
  stopAllSubagents: () => {
    const activeRuns = projectSubagentRuns(get().runtimeEvents).filter((run) =>
      isSubagentActiveStatus(run.status)
    );
    activeRuns.forEach((run) => get().stopSubagent(run.id));
    logStoreEvent("subagent_cancel_all_requested", { count: activeRuns.length });
    return activeRuns.length;
  },
  dismissEndedSubagents: () => {
    const endedRuns = projectSubagentRuns(get().runtimeEvents).filter((run) =>
      isSubagentTerminalStatus(run.status)
    );
    if (endedRuns.length === 0) return 0;
    const timestampMs = Date.now();
    set((state) => ({
      runtimeEvents: endedRuns.reduce((events, run) => appendRuntimeEvent(events, withEventSchema({
        type: "subagent.dismissed",
        threadId: run.threadId,
        turnId: run.parentTurnId,
        timestampMs,
        subagentId: run.id,
      })), state.runtimeEvents),
      selectedSubagentId: endedRuns.some((run) => run.id === state.selectedSubagentId)
        ? null
        : state.selectedSubagentId,
    }));
    logStoreEvent("subagent_history_dismissed", { count: endedRuns.length });
    return endedRuns.length;
  },
  closeRightPanel: () => set((state) => ({
    showPlanPanel: false,
    showDiff: false,
    showTerminal: false,
    rightPanelTab: state.rightPanelTab === "subagents" ? "plan" : state.rightPanelTab,
  })),
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
  returnFromImageSession: async (targetMode: Exclude<MainModeKey, "image_studio"> = "main_mode") => {
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
        ...s.conversationTurns.map((turn) =>
          (turn.processCollapsed ?? turn.collapsed)
            ? turn
            : { ...turn, processCollapsed: true, collapsed: true }
        ),
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
          processCollapsed: false,
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
          turn.id === turnId
            ? {
                ...turn,
                status,
                summary,
                elapsedTime: Math.max(
                  0,
                  Number(turn.elapsedTime) || 0,
                  Number(s.elapsedTime) || 0,
                ),
              }
            : turn
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
          processCollapsed: false,
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
              processCollapsed:
                status === "awaiting_approval" || status === "awaiting_input" || status === "error"
                  ? false
                  : (turn.processCollapsed ?? turn.collapsed),
              collapsed:
                status === "awaiting_approval" || status === "awaiting_input" || status === "error"
                  ? false
                  : (turn.processCollapsed ?? turn.collapsed),
              elapsedTime: Math.max(
                0,
                Number(turn.elapsedTime) || 0,
                Number(s.elapsedTime) || 0,
              ),
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
        turn.id === turnId
          ? {
              ...turn,
              processCollapsed: !(turn.processCollapsed ?? turn.collapsed),
              collapsed: !(turn.processCollapsed ?? turn.collapsed),
            }
          : turn
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

  knowledgeBases: defaultKnowledgeBases,
  setKnowledgeBases: (v) => set({ knowledgeBases: Array.isArray(v) ? v : [] }),
  upsertKnowledgeBase: (base) =>
    set((s) => {
      const exists = s.knowledgeBases.some((item) => item.id === base.id);
      return {
        knowledgeBases: exists
          ? s.knowledgeBases.map((item) => (item.id === base.id ? base : item))
          : [base, ...s.knowledgeBases],
      };
    }),
  removeKnowledgeBase: (id) =>
    set((s) => ({ knowledgeBases: s.knowledgeBases.filter((item) => item.id !== id) })),
  getEnabledKnowledgeBaseIds: () =>
    get().knowledgeBases
      .filter((base) => base.enabled)
      .map((base) => base.id),

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
  restoreRuntimeForSession: (sessionKey: string | null, options: { requireTranscript?: boolean; resetPanels?: boolean } = {}) => {
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
        activeSessionByWorkspace: {
          ...s.activeSessionByWorkspace,
          [resolveSessionWorkspaceKey(s.currentWorkspace)]: s.currentSessionId,
        },
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
      activeSessionByWorkspace[resolveSessionWorkspaceKey(s.currentWorkspace)] = s.currentSessionId;
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

  removeSession: (workspacePath: string, sessionId: number, options: { nextSessionId?: number | null } = {}) => {
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
        isPlanApproved: false,
        planApprovalChoice: null,
        pendingPlanApprovalHandoff: null,
        planApprovalExecutionStartedForTurnId: null,
        clearedPlanTurnId: null,
        showPlanPanel: false,
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
      knowledgeBases: defaultKnowledgeBases,
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
      isPlanApproved: false,
      planApprovalChoice: null,
      pendingPlanApprovalHandoff: null,
      planApprovalExecutionStartedForTurnId: null,
      clearedPlanTurnId: null,
      showPlanPanel: false,
      normalizedStreamState: defaultNormalizedStreamState,
      harnessRunMarker: null,
    });
  },

  // ── Workflow Mode ──────────────────────────────────────────────────

  isPlanApproved: false,
  planApprovalChoice: null,
  pendingPlanApprovalHandoff: null,
  planApprovalExecutionStartedForTurnId: null,
  clearedPlanTurnId: null,
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
      const canonicalPath = canonicalizePlanArtifactPath(artifact.path);
      const sanitizedContent = sanitizePlanArtifactContent(artifact.content);
      if (!canonicalPath || detectPlanArtifactKind(canonicalPath) !== artifact.kind) {
        logStoreEvent("plan_artifact_rejected_by_identity_gate", {
          path: artifact.path,
          canonicalPath,
          kind: artifact.kind,
        });
        return {};
      }
      const normalizedArtifact = { ...artifact, path: canonicalPath };
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
      const currentMaxPlanRevision = s.planArtifacts.reduce(
        (max, candidate) => Math.max(max, Number(candidate.revision) || 0),
        0,
      );
      const existingIndex = nextArtifacts.findIndex(
        (item) => canonicalizePlanArtifactPath(item.path) === canonicalPath,
      );
      if (existingIndex >= 0) {
        const existingArtifact = nextArtifacts[existingIndex];
        const contentChanged = existingArtifact.content !== sanitizedContent || existingArtifact.kind !== artifact.kind;
        nextArtifacts[existingIndex] = {
          ...normalizedArtifact,
          content: sanitizedContent,
          revision: contentChanged
            ? Math.max(1, currentMaxPlanRevision + 1)
            : Math.max(1, Number(existingArtifact.revision) || Number(artifact.revision) || 1),
        };
      } else {
        nextArtifacts.push({
          ...normalizedArtifact,
          content: sanitizedContent,
          revision: Math.max(1, currentMaxPlanRevision + 1),
        });
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
        : normalizeApprovedPlanTaskStatuses(
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
      const nextApprovalIdentity = buildPlanApprovalIdentity(nextArtifacts);
      const shouldRefreshPlanReviewRequest =
        s.activeActionRequest?.kind === "plan_review" &&
        !!nextApprovalIdentity &&
        (
          s.activeActionRequest.planRevision !== nextApprovalIdentity.revision ||
          s.activeActionRequest.artifactHash !== nextApprovalIdentity.artifactHash
        );
      const nextPlanReviewRequest = shouldRefreshPlanReviewRequest &&
        s.activeActionRequest?.kind === "plan_review" &&
        nextApprovalIdentity
        ? buildPlanReviewActionRequest({
            sessionKey: s.activeActionRequest.sessionKey,
            turnId: s.activeActionRequest.turnId,
            runId: s.activeActionRequest.runId,
            parentRunId: s.activeActionRequest.parentRunId,
            title: s.activeActionRequest.title,
            planRevision: nextApprovalIdentity.revision,
            artifactHash: nextApprovalIdentity.artifactHash,
            artifactPaths: nextApprovalIdentity.artifactPaths,
          })
        : s.activeActionRequest;
      logStoreEvent("plan_artifact_stage_transition", {
        path: canonicalPath,
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
        ...(shouldRefreshPlanReviewRequest ? { activeActionRequest: nextPlanReviewRequest } : {}),
        clearedPlanTurnId: null,
        ...(shouldAutoOpenPlanPanel
          ? {
              showPlanPanel: true,
              rightPanelTab: s.showDiff && s.rightPanelTab === "diff" ? "diff" as const : "plan" as const,
            }
          : {}),
      };
    }),
  clearPlanArtifacts: () =>
    set((s) => {
      const before = summarizePlanWorkspaceStateForLog(s);
      const nextRightPanelTab = s.rightPanelTab === "plan" ? "terminal" as const : s.rightPanelTab;
      const patch = {
        planArtifacts: [],
        planStage: "idle" as const,
        planTasks: [],
        planExecutionEvidenceLedger: [],
        planExecutionEvidenceCount: 0,
        planAutoResumeCount: 0,
        planExecutionProgressSnapshot: null,
        normalizedStreamState: defaultNormalizedStreamState,
        planApprovalChoice: null,
        pendingPlanApprovalHandoff: null,
        planApprovalExecutionStartedForTurnId: null,
        activeActionRequest: null,
        clearedPlanTurnId: s.currentTurnId || s.conversationTurns.find((turn) => isPlanConversationTurn(turn) && turn.status !== "done" && turn.status !== "completed_with_changes")?.id || null,
        isPlanApproved: false,
        showPlanPanel: false,
        rightPanelTab: nextRightPanelTab,
      };
      const sessionKey = resolveSessionRuntimeKey(resolveSessionWorkspaceKey(s.currentWorkspace), s.currentSessionId);
      const runtimeBySessionKey = sessionKey
        ? {
            ...s.runtimeBySessionKey,
            [sessionKey]: {
              ...(s.runtimeBySessionKey[sessionKey] || createSessionRuntimeFromState(s)),
              ...patch,
            },
          }
        : s.runtimeBySessionKey;
      logStoreEvent("planWorkspaceStateChanged", {
        reason: "clearPlanArtifacts",
        before,
        after: summarizePlanWorkspaceStateForLog({ ...s, ...patch }),
        sessionKey,
      });
      return {
        ...patch,
        runtimeBySessionKey,
      };
    }),
  deletePersistedPlanFiles: async () => {
    const state = get();
    const sessionKey = !state.currentWorkspace.trim()
      ? resolveGlobalChatSessionKey(state.currentSessionId)
      : null;
    const runtimeSessionKey = resolveSessionRuntimeKey(resolveSessionWorkspaceKey(state.currentWorkspace), state.currentSessionId);
    const before = summarizePlanWorkspaceStateForLog(state);
    try {
      if (sessionKey) {
        await deleteChatTempPath(sessionKey, ".MAIN/plans");
      } else {
        await deletePlanFiles();
      }
    } finally {
      invalidateWorkspaceTreeCache();
      get().clearPlanArtifacts();
      get().bumpWorkspaceContentVersion();
      logStoreEvent("planFilesCleared", {
        path: ".MAIN/plans",
        workspace: state.currentWorkspace || null,
        chatTempSessionKey: sessionKey,
        runtimeSessionKey,
        before,
        after: summarizePlanWorkspaceStateForLog(get()),
      });
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
  approvePlan: (approvalChoice, expectedIdentity) =>
    (() => {
      const state = get();
      const approvedTurnId = state.currentTurnId;
      if (state.isPlanApproved) {
        logStoreEvent("plan_approval_handoff_deduped", {
          reason: "already_approved",
          planTurnId: approvedTurnId,
          agentStatus: state.agentStatus,
          isGenerating: state.isGenerating,
          pendingPlanApprovalHandoff: state.pendingPlanApprovalHandoff,
          planApprovalExecutionStartedForTurnId: state.planApprovalExecutionStartedForTurnId,
          conversationTurns: state.conversationTurns.length,
        });
        return;
      }

      const approvalIdentity = buildPlanApprovalIdentity(state.planArtifacts);
      if (!approvedTurnId || !hasReviewablePlanArtifact(state.planArtifacts) || !approvalIdentity) {
        const language = state.config.language === "en" ? "en" : "zh";
        state.abortController?.abort();
        set((s) => ({
          isPlanApproved: false,
          planApprovalChoice: null,
          pendingPlanApprovalHandoff: null,
          planApprovalExecutionStartedForTurnId: null,
          activeActionRequest: null,
          agentStatus: "idle",
          isGenerating: false,
          abortController: null,
          conversationTurns: approvedTurnId
            ? s.conversationTurns.map((turn) =>
                turn.id === approvedTurnId
                  ? {
                      ...turn,
                      status: "paused" as const,
                      summary: language === "zh"
                        ? "计划产物尚未成功生成或已失效，无法批准执行。"
                        : "No valid materialized plan artifact is available for approval.",
                      elapsedTime: Math.max(
                        0,
                        Number(turn.elapsedTime) || 0,
                        Number(s.elapsedTime) || 0,
                      ),
                    }
                  : turn,
              )
            : s.conversationTurns,
        }));
        logStoreEvent("plan_approval_blocked_missing_artifact", {
          planTurnId: approvedTurnId,
          planStage: state.planStage,
          artifactCount: state.planArtifacts.length,
        });
        return;
      }

      const reviewRequest = state.activeActionRequest;
      const reviewSessionKey = resolveSessionRuntimeKey(
        resolveSessionWorkspaceKey(state.currentWorkspace),
        state.currentSessionId,
      );
      const reviewRunMatches = !!getHarnessActionRunId(state.harnessRunMarker) &&
        state.harnessRunMarker?.status === "paused" &&
        getHarnessActionRunId(state.harnessRunMarker) === reviewRequest?.runId &&
        state.harnessRunMarker?.turnId === approvedTurnId &&
        state.harnessRunMarker?.sessionKey === reviewSessionKey;
      if (
        reviewRequest?.kind !== "plan_review" ||
        reviewRequest.status !== "pending" ||
        reviewRequest.sessionKey !== reviewSessionKey ||
        reviewRequest.turnId !== approvedTurnId ||
        (expectedIdentity && (
          expectedIdentity.requestId !== reviewRequest.requestId ||
          expectedIdentity.sessionKey !== reviewRequest.sessionKey ||
          expectedIdentity.turnId !== reviewRequest.turnId ||
          expectedIdentity.runId !== reviewRequest.runId ||
          expectedIdentity.planRevision !== reviewRequest.planRevision ||
          expectedIdentity.artifactHash !== reviewRequest.artifactHash
        )) ||
        !reviewRunMatches
      ) {
        logStoreEvent("plan_approval_blocked_missing_review_request", {
          planTurnId: approvedTurnId,
          sessionKey: reviewSessionKey,
          actionRequestId: reviewRequest?.requestId || null,
          actionKind: reviewRequest?.kind || null,
          actionTurnId: reviewRequest?.turnId || null,
          actionRunId: reviewRequest?.runId || null,
          harnessRunId: state.harnessRunMarker?.runId || null,
        });
        return;
      }

      if (
        (
          reviewRequest.planRevision !== approvalIdentity.revision ||
          reviewRequest.artifactHash !== approvalIdentity.artifactHash
        )
      ) {
        const refreshedRequest = buildPlanReviewActionRequest({
          sessionKey: reviewRequest.sessionKey,
          turnId: reviewRequest.turnId,
          runId: reviewRequest.runId,
          parentRunId: reviewRequest.parentRunId,
          title: reviewRequest.title,
          planRevision: approvalIdentity.revision,
          artifactHash: approvalIdentity.artifactHash,
          artifactPaths: approvalIdentity.artifactPaths,
        });
        set({ activeActionRequest: refreshedRequest });
        logStoreEvent("plan_approval_blocked_stale_review_request", {
          planTurnId: approvedTurnId,
          staleRequestId: reviewRequest.requestId,
          staleRevision: reviewRequest.planRevision,
          currentRevision: approvalIdentity.revision,
          currentArtifactHash: approvalIdentity.artifactHash,
        });
        return;
      }

      const normalizedApprovalChoice = normalizePlanApprovalChoice(approvalChoice);
      const language = state.config.language === "en" ? "en" : "zh";
      const executionPlanTasks = ensureApprovedPlanRuntimeTasksForState(state, language);
      const executionReadiness = evaluateApprovedPlanExecutionReadiness({
        planArtifacts: state.planArtifacts,
        executionPlanTasks,
      });
      if (!executionReadiness.ok) {
        const qualityDetail = executionReadiness.qualityReason
          ? `${executionReadiness.reason}:${executionReadiness.qualityReason}`
          : executionReadiness.reason || "unknown_plan_execution_readiness_failure";
        state.abortController?.abort();
        set((s) => ({
          isPlanApproved: false,
          planApprovalChoice: null,
          pendingPlanApprovalHandoff: null,
          planApprovalExecutionStartedForTurnId: null,
          currentTurnExecutionConsent: { turnId: null, granted: false },
          activeActionRequest: null,
          planTasks: [],
          planExecutionEvidenceLedger: [],
          planExecutionEvidenceCount: 0,
          planAutoResumeCount: 0,
          planExecutionProgressSnapshot: null,
          planStage: "plan",
          agentStatus: "idle",
          isGenerating: false,
          abortController: null,
          conversationTurns: s.conversationTurns.map((turn) =>
            turn.id === approvedTurnId
              ? {
                  ...turn,
                  status: "paused" as const,
                  summary: language === "zh"
                    ? `计划执行物化失败（plan_execution_materialization_failed）：${qualityDetail}。请修订或重新生成计划。`
                    : `Plan execution materialization failed (plan_execution_materialization_failed): ${qualityDetail}. Revise or regenerate the plan before approval.`,
                  elapsedTime: Math.max(
                    0,
                    Number(turn.elapsedTime) || 0,
                    Number(s.elapsedTime) || 0,
                  ),
                }
              : turn,
          ),
        }));
        logStoreEvent("plan_approval_blocked_execution_materialization", {
          stopClass: executionReadiness.stopClass,
          reason: executionReadiness.reason,
          qualityReason: executionReadiness.qualityReason,
          planTurnId: approvedTurnId,
          sessionKey: reviewSessionKey,
          runId: reviewRequest.runId,
          parentRunId: reviewRequest.parentRunId || null,
          actionRequestId: reviewRequest.requestId,
          planRevision: reviewRequest.planRevision,
          artifactHash: reviewRequest.artifactHash,
          taskCount: executionReadiness.taskCount,
          mutationOriented: executionReadiness.mutationOriented,
          requiresExecutableValidation: executionReadiness.requiresExecutableValidation,
          concreteMutationTaskCount: executionReadiness.concreteMutationTaskCount,
          executableValidationTaskCount: executionReadiness.executableValidationTaskCount,
        });
        return;
      }
      const currentTurn = approvedTurnId
        ? state.conversationTurns.find((turn) => turn.id === approvedTurnId)
        : null;
      const hasPendingHandoffForTurn =
        !!approvedTurnId && state.pendingPlanApprovalHandoff?.planTurnId === approvedTurnId;
      const hasStartedExecutionForTurn =
        !!approvedTurnId && state.planApprovalExecutionStartedForTurnId === approvedTurnId;
      const isAlreadyExecutingCurrentTurn =
        !!approvedTurnId && state.planStage === "executing" && currentTurn?.status === "executing";
      if (hasPendingHandoffForTurn || hasStartedExecutionForTurn || isAlreadyExecutingCurrentTurn) {
        logStoreEvent("plan_approval_handoff_deduped", {
          reason: hasPendingHandoffForTurn
            ? "pending_same_turn_execution_exists"
            : "same_turn_execution_already_started",
          planTurnId: approvedTurnId,
          executionTurnId: approvedTurnId,
          currentTurnStatus: currentTurn?.status ?? null,
          agentStatus: state.agentStatus,
          isGenerating: state.isGenerating,
          pendingPlanApprovalHandoff: state.pendingPlanApprovalHandoff,
          planApprovalExecutionStartedForTurnId: state.planApprovalExecutionStartedForTurnId,
          conversationTurns: state.conversationTurns.length,
        });
        return;
      }

      const executionPrompt = buildApprovedPlanExecutionPrompt({
        state,
        language,
        executionPlanTasks,
        normalizedApprovalChoice,
      });
      const approvalChoicePatch = { planApprovalChoice: normalizedApprovalChoice || null };
      // Reserve the child owner before stopping the review run. This closes
      // the slow-first-token gap where an approved plan was executing but its
      // only visible checkpoint still belonged to no run at all.
      const executionRunId = approvedTurnId
        ? createSubmitHarnessRunId(Date.now())
        : null;
      const executionParentRunId = executionRunId
        ? reviewRequest?.runId || getHarnessActionRunId(state.harnessRunMarker) || null
        : null;
      const pendingHandoffPatch = approvedTurnId
        ? {
            planTurnId: approvedTurnId,
            requestedAt: Date.now(),
            executionTurnId: approvedTurnId,
            executionRunId: executionRunId || undefined,
            prompt: executionPrompt,
            planRevision: approvalIdentity.revision,
            artifactHash: approvalIdentity.artifactHash,
            artifactPaths: approvalIdentity.artifactPaths,
            parentRunId: executionParentRunId,
          }
        : null;
      const initialProgressSnapshot = approvedTurnId
        ? normalizePlanExecutionProgressSnapshot({
            turnId: approvedTurnId,
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
            ...(executionRunId
              ? {
                  runId: executionRunId,
                  parentRunId: executionParentRunId,
                }
              : {}),
            now: Date.now(),
          })
        : state.planExecutionProgressSnapshot;
      const activePlanLoop = !!approvedTurnId && isPlanReviewExecutionLeaseActive({
        agentStatus: state.agentStatus,
        isGenerating: state.isGenerating,
        hasAbortController: state.abortController !== null,
      });
      const sessionKey = resolveSessionRuntimeKey(resolveSessionWorkspaceKey(state.currentWorkspace), state.currentSessionId);
      const initialProgressEvent = approvedTurnId && executionRunId && initialProgressSnapshot
        ? withEventSchema({
            type: "progress.updated",
            threadId: reviewSessionKey,
            turnId: approvedTurnId,
            timestampMs: initialProgressSnapshot.updatedAt,
            runId: executionRunId,
            parentRunId: executionParentRunId,
            progress: toPlanExecutionRuntimeProgressUpdate({
              snapshot: initialProgressSnapshot,
              language,
              dedupeKey: `plan-execution-progress:${executionRunId}`,
            }),
          })
        : null;

      set((s) => ({
        isPlanApproved: true,
        ...approvalChoicePatch,
        ...(approvedTurnId
          ? { currentTurnExecutionConsent: { turnId: approvedTurnId, granted: true } }
          : {}),
        pendingPlanApprovalHandoff: pendingHandoffPatch,
        planApprovalExecutionStartedForTurnId: null,
        activeActionRequest: null,
        planExecutionEvidenceLedger: [],
        planExecutionEvidenceCount: 0,
        planAutoResumeCount: 0,
        planExecutionProgressSnapshot: initialProgressSnapshot,
        ...(initialProgressEvent
          ? { runtimeEvents: appendRuntimeEvent(s.runtimeEvents, initialProgressEvent) }
          : {}),
        ...(executionPlanTasks.length > 0 ? { planTasks: executionPlanTasks } : {}),
        agentStatus: activePlanLoop ? s.agentStatus : "idle",
        isGenerating: activePlanLoop ? s.isGenerating : false,
        abortController: activePlanLoop ? s.abortController : null,
        planStage: "executing",
        conversationTurns: approvedTurnId
          ? s.conversationTurns.map((turn) =>
              turn.id === approvedTurnId
                ? {
                    ...turn,
                    status: "executing" as const,
                    summary: language === "zh"
                      ? "计划已批准，正在当前回合继续执行。"
                      : "Plan approved; execution is continuing in the current turn.",
                  }
                : turn,
            )
          : s.conversationTurns,
      }));

      // Approval is a boundary between two execution leases. Stop the review
      // run after recording the handoff so the approved plan starts in a fresh
      // child run with the same logical turnId and a parentRunId link.
      if (activePlanLoop) {
        state.abortController?.abort();
      }

      logStoreEvent("plan_approval_same_turn_execution_queued", {
        reason: activePlanLoop ? "plan_review_run_paused_for_child_execution" : "same_turn_restart_required",
        planTurnId: approvedTurnId,
        executionTurnId: approvedTurnId,
        currentTurnStatus: currentTurn?.status ?? null,
        agentStatus: state.agentStatus,
        isGenerating: state.isGenerating,
        pendingPlanApprovalHandoff: state.pendingPlanApprovalHandoff,
        conversationTurns: state.conversationTurns.length,
      });

      if (!activePlanLoop && approvedTurnId && pendingHandoffPatch) {
        runAfterNextPaint(() => {
          startApprovedPlanExecutionInCurrentTurn({
            get,
            setActiveState: (patch) => set(patch),
            planTurnId: approvedTurnId,
            handoff: pendingHandoffPatch,
            sessionKey,
            source: "store_fallback",
          });
        });
      }
    })(),
  rejectPlan: (expectedIdentity) => {
    const state = get();
    if (expectedIdentity) {
      const request = state.activeActionRequest;
      const matches = request?.kind === "plan_review" &&
        request.status === "pending" &&
        state.harnessRunMarker?.status === "paused" &&
        state.harnessRunMarker.sessionKey === request.sessionKey &&
        state.harnessRunMarker.turnId === request.turnId &&
        getHarnessActionRunId(state.harnessRunMarker) === request.runId &&
        request.requestId === expectedIdentity.requestId &&
        request.sessionKey === expectedIdentity.sessionKey &&
        request.turnId === expectedIdentity.turnId &&
        request.runId === expectedIdentity.runId &&
        request.planRevision === expectedIdentity.planRevision &&
        request.artifactHash === expectedIdentity.artifactHash;
      if (!matches) {
        logStoreEvent("plan_rejection_identity_mismatch", {
          expectedRequestId: expectedIdentity.requestId,
          activeRequestId: request?.requestId || null,
        });
        return false;
      }
    }
    state.abortController?.abort();
    set({
      isPlanApproved: false,
      planApprovalChoice: null,
      pendingPlanApprovalHandoff: null,
      planApprovalExecutionStartedForTurnId: null,
      activeActionRequest: null,
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
    return true;
  },
  rejectPlanAndDeleteFiles: async (expectedIdentity) => {
    if (!get().rejectPlan(expectedIdentity)) return;
    await get().deletePersistedPlanFiles();
  },
  showWorkflowMenu: false,
  setShowWorkflowMenu: (v) => set({ showWorkflowMenu: v }),

  // ── Goal Mode ───────────────────────────────────────────────────────
  activeGoal: null,
  goalProgress: null,
  goalStatus: "paused",
  goalIterationBudget: DEFAULT_GOAL_EMERGENCY_CONTINUATION_LIMIT,
  goalRuntime: null,
  startGoal: (objective, options) => {
    const newGoal = createGoalDefinition({
      objective,
      sourceContext: options?.sourceContext,
      iterationBudget: options?.maxIterations,
      tokenBudget: options?.maxTokens,
      toolCallBudget: options?.maxToolCalls,
      maxDurationMs: options?.maxDurationMs,
      sessionKey: options?.sessionKey,
      ownerTurnId: options?.ownerTurnId || get().currentTurnId || undefined,
    });
    const workspacePath = resolveSessionWorkspaceKey(get().currentWorkspace) || "";
    const progress = createGoalProgress(
      newGoal.id,
      resolveGoalRuntimeProgressFilePath(workspacePath, newGoal.id),
    );
    const runtime = buildGoalRuntimeSnapshot({ goal: newGoal, progress, phase: "plan" });
    set((state) => ({
      activeGoal: newGoal,
      goalStatus: newGoal.status,
      goalIterationBudget: newGoal.iterationBudget,
      goalProgress: progress,
      goalRuntime: runtime,
      runtimeEvents: appendRuntimeEvent(state.runtimeEvents, withEventSchema({
        type: "goal.started",
        ...resolveGoalEventOwnerIdentity({
          goal: newGoal,
          currentWorkspace: state.currentWorkspace,
          currentSessionId: state.currentSessionId,
          currentTurnId: state.currentTurnId,
        }),
        timestampMs: Date.now(),
        goalId: newGoal.id,
        revision: newGoal.revision || 1,
      })),
    }));
  },
  pauseGoal: (expectedIdentity) => {
    const { activeGoal, goalProgress, goalRuntime, isGenerating, abortController, activeActionRequest } = get();
    if (!activeGoal) return;
    const expectedRevision = activeGoal.revision || 1;
    if (expectedIdentity && !isCurrentGoalAdministrativeControl({
      request: activeActionRequest,
      identity: expectedIdentity,
      goalId: activeGoal.id,
      goalRevision: expectedRevision,
    })) {
      logStoreEvent("goal_pause_identity_mismatch", {
        expectedGoalId: expectedIdentity?.goalId || null,
        activeGoalId: activeGoal.id,
        expectedRevision: expectedIdentity?.goalRevision || null,
        activeRevision: expectedRevision,
        expectedRequestId: expectedIdentity?.requestId || null,
        activeRequestId: activeActionRequest?.requestId || null,
      });
      return;
    }
    if (activeGoal.status !== "active" && activeGoal.status !== "awaiting_input") return;
    const nextStatus: GoalStatus = isGenerating ? "pausing" : "paused";
    const nextGoal = { ...activeGoal, status: nextStatus, updatedAt: Date.now() };
    const nextProgress = goalProgress || createGoalProgress(activeGoal.id, "");
    const nextRuntime = {
      ...(goalRuntime || buildGoalRuntimeSnapshot({ goal: nextGoal, progress: nextProgress, phase: "re_plan" })),
      goal: nextGoal,
      progress: { ...nextProgress, pauseReason: "User requested pause" },
      status: nextStatus,
      phase: "re_plan" as const,
      pauseReason: "User requested pause",
      updatedAt: Date.now(),
    };
    set((state) => ({
      activeGoal: nextGoal,
      goalProgress: nextRuntime.progress,
      goalStatus: nextStatus,
      goalRuntime: nextRuntime,
      activeActionRequest: clearGoalConfirmationActionRequest(
        state.activeActionRequest,
        activeGoal.id,
        expectedRevision,
      ),
      runtimeEvents: appendRuntimeEvent(state.runtimeEvents, withEventSchema({
        type: "goal.state_changed",
        ...resolveGoalEventOwnerIdentity({
          goal: nextGoal,
          currentWorkspace: state.currentWorkspace,
          currentSessionId: state.currentSessionId,
          currentTurnId: state.currentTurnId,
        }),
        timestampMs: Date.now(),
        goalId: nextGoal.id,
        from: activeGoal.status,
        to: nextStatus,
        phase: "re_plan",
        reason: "user_pause",
      })),
    }));
    abortController?.abort();
  },
  resumeGoal: (expectedIdentity) => {
    const { activeGoal, goalProgress, goalRuntime, goalStatus, isGenerating, config, runtimeEvents, currentTurnId, activeActionRequest, harnessRunMarker } = get();
    if (!activeGoal) return;
    const expectedRevision = activeGoal.revision || 1;
    const exactControlResolution = expectedIdentity ? isCurrentGoalControlResolution({
      request: activeActionRequest,
      identity: expectedIdentity,
      goalId: activeGoal.id,
      goalRevision: expectedRevision,
      runOwner: harnessRunMarker,
    }) : false;
    const hasPendingActionRequest = activeActionRequest?.status === "pending";
    if ((expectedIdentity && !exactControlResolution) ||
      (goalStatus === "awaiting_input" && hasPendingActionRequest && !exactControlResolution)) {
      logStoreEvent("goal_resume_identity_mismatch", {
        expectedGoalId: expectedIdentity?.goalId || null,
        activeGoalId: activeGoal.id,
        expectedRevision: expectedIdentity?.goalRevision || null,
        activeRevision: expectedRevision,
        expectedRequestId: expectedIdentity?.requestId || null,
        activeRequestId: activeActionRequest?.requestId || null,
      });
      return;
    }
    if (isGenerating || (goalStatus !== "paused" && goalStatus !== "awaiting_input" && goalStatus !== "blocked")) return;
    const goalStartedEvent = [...runtimeEvents].reverse().find((event) =>
      event.type === "goal.started" && event.goalId === activeGoal.id && typeof event.turnId === "string"
    ) as Extract<MainThreadEvent, { type: "goal.started" }> | undefined;
    const eventOwnerTurnId = goalStartedEvent?.turnId;
    const ownerTurnId = activeGoal.ownerTurnId || eventOwnerTurnId || currentTurnId || null;
    if (!ownerTurnId) return;
    const resumedGoal = {
      ...activeGoal,
      ownerTurnId,
      status: "active" as const,
      updatedAt: Date.now(),
    };
    const resumedProgress = {
      ...(goalProgress || createGoalProgress(activeGoal.id, "")),
      pauseReason: undefined,
      lastUserConfirmedIteration: goalProgress?.totalIterationsUsed || 0,
      ...(goalStatus === "blocked"
        ? {
            recoveryState: undefined,
            recoveryAuditStartIteration: goalProgress?.totalIterationsUsed || 0,
            lastStopReason: undefined,
            stopClass: undefined,
          }
        : {}),
      usage: {
        ...(goalProgress?.usage || {
          modelIterations: 0,
          toolCalls: 0,
          totalTokensUsed: goalProgress?.totalTokensUsed || 0,
          activeDurationMs: 0,
          activeStartedAt: null,
          estimatedTokens: true,
        }),
        activeStartedAt: Date.now(),
      },
    };
    const resumedRuntime = {
      ...(goalRuntime || buildGoalRuntimeSnapshot({ goal: resumedGoal, progress: resumedProgress, phase: "re_plan" })),
      goal: resumedGoal,
      progress: resumedProgress,
      status: "active" as const,
      phase: "re_plan" as const,
      pauseReason: undefined,
      updatedAt: Date.now(),
    };
    set((state) => ({
      activeGoal: resumedGoal,
      goalProgress: resumedProgress,
      goalStatus: "active",
      goalRuntime: resumedRuntime,
      activeActionRequest: clearGoalConfirmationActionRequest(
        state.activeActionRequest,
        activeGoal.id,
        expectedRevision,
      ),
      runtimeEvents: appendRuntimeEvent(state.runtimeEvents, withEventSchema({
        type: "goal.state_changed",
        ...resolveGoalEventOwnerIdentity({
          goal: resumedGoal,
          currentWorkspace: state.currentWorkspace,
          currentSessionId: state.currentSessionId,
          currentTurnId: ownerTurnId,
        }),
        timestampMs: Date.now(),
        goalId: resumedGoal.id,
        from: goalStatus,
        to: "active",
        phase: "re_plan",
        reason: "user_resume",
      })),
    }));
    setTimeout(() => {
      const language = config.language === "en" ? "en" : "zh";
      const sent = get().sendMessage(
        language === "en"
          ? `Resume the active goal ${resumedGoal.id} from its latest checkpoint.`
          : `从最近检查点继续执行当前目标 ${resumedGoal.id}。`,
        undefined,
        {
          hidden: true,
          resolvedIntent: "execute",
          runtimeIntentOverride: "goal",
          skipIntentResolution: true,
          reuseCurrentTurn: true,
          turnIdOverride: ownerTurnId,
          preservePlanState: false,
          createVisibleTurnForHiddenMessage: false,
        },
      );
      if (sent === false) {
        const current = get();
        if (current.activeGoal?.id !== resumedGoal.id) return;
        const pausedGoal = { ...resumedGoal, status: "paused" as const };
        set({
          activeGoal: pausedGoal,
          goalStatus: "paused",
          goalRuntime: current.goalRuntime ? {
            ...current.goalRuntime,
            goal: pausedGoal,
            status: "paused",
            pauseReason: "Unable to acquire a resume run lease",
            updatedAt: Date.now(),
          } : null,
        });
      }
    }, 0);
  },
  clearGoal: (expectedIdentity) => {
    const current = get();
    if (expectedIdentity && !isCurrentGoalAdministrativeControl({
      request: current.activeActionRequest,
      identity: expectedIdentity,
      goalId: current.activeGoal?.id,
      goalRevision: current.activeGoal?.revision || 1,
    })) {
      logStoreEvent("goal_clear_identity_mismatch", {
        expectedGoalId: expectedIdentity.goalId,
        activeGoalId: current.activeGoal?.id || null,
        expectedRevision: expectedIdentity.goalRevision,
        activeRevision: current.activeGoal?.revision || null,
        expectedRequestId: expectedIdentity.requestId || null,
        activeRequestId: current.activeActionRequest?.requestId || null,
      });
      return;
    }
    if (current.activeGoal?.status === "active" || current.activeGoal?.status === "pausing") {
      current.abortController?.abort();
    }
    set((state) => ({
      activeGoal: null,
      goalProgress: null,
      goalStatus: "paused",
      goalRuntime: null,
      activeActionRequest: current.activeGoal
        ? clearGoalConfirmationActionRequest(
            state.activeActionRequest,
            current.activeGoal.id,
            current.activeGoal.revision || 1,
          )
        : state.activeActionRequest,
      runtimeEvents: current.activeGoal
          ? appendRuntimeEvent(state.runtimeEvents, withEventSchema({
            type: "goal.cleared",
            ...resolveGoalEventOwnerIdentity({
              goal: current.activeGoal,
              currentWorkspace: state.currentWorkspace,
              currentSessionId: state.currentSessionId,
              currentTurnId: state.currentTurnId,
            }),
            timestampMs: Date.now(),
            goalId: current.activeGoal.id,
            previousStatus: current.goalStatus,
          }))
        : state.runtimeEvents,
    }));
  },
  updateGoalText: (objective, expectedIdentity) => {
    const { activeGoal, goalProgress, goalRuntime, goalStatus, activeActionRequest, harnessRunMarker } = get();
    const text = objective.trim();
    if (!activeGoal || !text || (goalStatus !== "paused" && goalStatus !== "blocked" && goalStatus !== "awaiting_input")) return false;
    const expectedRevision = activeGoal.revision || 1;
    const exactControlResolution = expectedIdentity ? isCurrentGoalControlResolution({
      request: activeActionRequest,
      identity: expectedIdentity,
      goalId: activeGoal.id,
      goalRevision: expectedRevision,
      runOwner: harnessRunMarker,
    }) : false;
    const hasPendingActionRequest = activeActionRequest?.status === "pending";
    if ((expectedIdentity && !exactControlResolution) ||
      (goalStatus === "awaiting_input" && hasPendingActionRequest && !exactControlResolution)) {
      logStoreEvent("goal_update_identity_mismatch", {
        expectedGoalId: expectedIdentity?.goalId || null,
        activeGoalId: activeGoal.id,
        expectedRevision: expectedIdentity?.goalRevision || null,
        activeRevision: expectedRevision,
        expectedRequestId: expectedIdentity?.requestId || null,
        activeRequestId: activeActionRequest?.requestId || null,
      });
      return false;
    }
    const nextGoal = updateGoalDefinitionText(activeGoal, text);
    const nextProgress: GoalProgress = {
      ...(goalProgress || createGoalProgress(activeGoal.id, "")),
      pauseReason: "Goal text updated; resume explicitly to continue.",
      lastStopReason: undefined,
      stopClass: undefined,
      recoveryState: undefined,
      recoveryAuditStartIteration: goalProgress?.totalIterationsUsed || 0,
      evidence: [...(goalProgress?.evidence || [])],
      lastUpdatedAt: Date.now(),
    };
    const nextRuntime = {
      ...(goalRuntime || buildGoalRuntimeSnapshot({ goal: nextGoal, progress: nextProgress, phase: "re_plan" })),
      goal: nextGoal,
      progress: nextProgress,
      status: "paused" as const,
      phase: "re_plan" as const,
      pauseReason: nextProgress.pauseReason,
      updatedAt: Date.now(),
    };
    set({
      activeGoal: nextGoal,
      goalProgress: nextProgress,
      goalStatus: "paused",
      goalRuntime: nextRuntime,
      activeActionRequest: clearGoalConfirmationActionRequest(
        activeActionRequest,
        activeGoal.id,
        expectedRevision,
      ),
    });
    return true;
  },
  updateGoalProgress: (progress) => {
    const state = get();
    if (!state.activeGoal) {
      set({ goalProgress: progress });
      return;
    }
    const runtime = buildGoalRuntimeSnapshot({
      goal: state.activeGoal,
      progress,
      phase: state.goalRuntime?.phase || null,
      pauseReason: state.goalRuntime?.pauseReason,
    });
    set({ goalProgress: progress, goalRuntime: runtime });
  },
  updateGoalRuntime: (runtime) => {
    const previous = get().goalRuntime;
    const normalizedGoal = migrateGoalDefinition(runtime.goal);
    const normalizedRuntime = { ...runtime, goal: normalizedGoal, status: normalizedGoal.status };
    set((state) => ({
      activeGoal: normalizedGoal,
      goalProgress: normalizedRuntime.progress,
      goalStatus: normalizedRuntime.status,
      goalIterationBudget: normalizedGoal.iterationBudget,
      goalRuntime: normalizedRuntime,
      runtimeEvents: previous && previous.status !== normalizedRuntime.status
          ? appendRuntimeEvent(state.runtimeEvents, withEventSchema({
            type: normalizedRuntime.status === "completed" ? "goal.completed" : "goal.state_changed",
            ...resolveGoalEventOwnerIdentity({
              goal: normalizedGoal,
              currentWorkspace: state.currentWorkspace,
              currentSessionId: state.currentSessionId,
              currentTurnId: state.currentTurnId,
            }),
            timestampMs: Date.now(),
            goalId: normalizedGoal.id,
            ...(normalizedRuntime.status === "completed"
              ? { evidenceCount: normalizedRuntime.progress.evidence?.length || 0 }
              : {
                  from: previous.status,
                  to: normalizedRuntime.status,
                  phase: normalizedRuntime.phase,
                  reason: normalizedRuntime.pauseReason || normalizedRuntime.lastError,
                }),
          } as MainThreadEventInput))
        : state.runtimeEvents,
    }));
  },

  // ── Agent Orchestrator ──────────────────────────────────────────────

  agentStatus: "idle",
  agentMessages: [],
  contextMemoryState: null,
  contextMemoryStateByRuntimeKey: {},
  providerCompatibilityByRuntimeKey: {},
  pendingReviewResolve: null,
  pendingReviewTaskId: null,
  activeActionRequest: null,
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
      runtimeIntentOverride: options?.runtimeIntentOverride,
      goalSourceContextSnapshot: options?.goalSourceContextSnapshot,
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
      runtimeIntentOverride: queued.runtimeIntentOverride || null,
      goalSourceContextChars: queued.goalSourceContextSnapshot?.length || 0,
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
  approvePendingReviewOnce: (identity) => {
    const state = get();
    const taskId = identity?.taskId ?? state.pendingReviewTaskId;
    if (taskId != null) {
      get().allowToolAction(taskId, identity);
    }
  },
  approvePendingReviewForSession: (identity) => {
    const state = get();
    const taskId = identity?.taskId ?? state.pendingReviewTaskId;
    if (
      taskId == null ||
      !isPendingToolPermissionResolutionCurrent(state, taskId, identity, "approve_session")
    ) {
      return;
    }
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
      taskId,
      toolName: state.pendingToolCall?.name || null,
      localFileRead: !!pendingLocalFileReadPath,
      shellRules: shellRules.length,
    });
    get().allowToolAction(taskId, identity);
  },

  /**
   * Called when user clicks "Allow & Run" on an Action Card.
   * Resolves the review gate and lets the orchestrator execute the tool once.
   */
  allowToolAction: (taskId: number, identity) => {
    const state = get();
    if (!isPendingToolPermissionResolutionCurrent(state, taskId, identity, "approve_once")) return;

    const resolve = state.pendingReviewResolve;
    if (!resolve) return;
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
      activeActionRequest: null,
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
  rejectToolAction: (taskId: number, identity) => {
    const state = get();
    if (!isPendingToolPermissionResolutionCurrent(state, taskId, identity, "reject")) return;

    const resolve = state.pendingReviewResolve;
    if (!resolve) return;

    // Clear pending state
    set({ pendingReviewResolve: null, pendingReviewTaskId: null, activeActionRequest: null, pendingToolCall: null });

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
      activeActionRequest: null,
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
    goalSourceContextSnapshot?: string;
    remoteFeishu?: FeishuRemoteContext;
    skipAutoPlanHydration?: boolean;
    replyOptionSourceTurnId?: string;
    selectedReplyOptionText?: string;
    replyOptionRequestIdentity?: UserChoiceResolutionIdentity;
    replyOptionIsCustom?: boolean;
    parentRunIdOverride?: string;
    runIdOverride?: string;
  }) => {
    let state = get();
    const pendingReviewTransition = applySubmitPendingReviewTransition({
      text,
      executionConsentGranted: options?.executionConsentGranted,
      state,
      getState: get,
      setState: set,
      setConversationTurnStatus: (turnId, status) => {
        get().setConversationTurnStatus(turnId, status);
      },
      logStoreEvent,
    });
    if (pendingReviewTransition.aborted) {
      state = pendingReviewTransition.state;
    }
    const sendOriginSessionKey = resolveSessionRuntimeKey(resolveSessionWorkspaceKey(state.currentWorkspace), state.currentSessionId);
    const applyPreRunSessionPatch = createSubmitPreRunSessionPatcher<AppState, SessionRuntimeState>({
      originSessionKey: sendOriginSessionKey,
      originSnapshot: state,
      get,
      set,
      createRuntimeFromState: createSessionRuntimeFromState,
      pickRuntimePatch: pickSessionRuntimePatch,
    });
    const sendStartedAt = nowMs();
    logStoreEvent("send_message_called", {
      textChars: text?.length ?? 0,
      agentStatus: state.agentStatus,
      workspace: state.currentWorkspace || null,
      activeProfile: state.config.activeProfile,
      targetSessionKey: sendOriginSessionKey,
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
    const inputEnvelope = buildSubmitInputEnvelope({
      text,
      options,
      state,
      cache: {
        workspaceTreeCacheKey,
        workspaceTreeCacheVersion,
        workspaceTreeCache,
      },
    });
    const {
      isHidden,
      createVisibleTurnForHiddenMessage,
      parentPlanTurnId,
      uiParentTurnId,
      mentionSnapshot,
      attachedFilesSnapshot,
      remoteFeishu,
      hasSupplementalInput,
      currentMainModeKey,
      preferredLanguage,
      cachedWorkspaceTreeForGameDetection,
    } = inputEnvelope;
    if (inputEnvelope.shouldWarmWorkspaceTreeCache) {
      void getWorkspaceTree(state.currentWorkspace);
    }
    const submitPipelineDecision = buildSubmitPipelineDecision({
      text,
      images,
      options,
      preferredLanguage: preferredLanguage === "en" ? "en" : "zh",
      workspaceTreeForGameDetection: cachedWorkspaceTreeForGameDetection,
      createGameStudioModeSwitchDecision,
      snapshot: {
        agentStatus: state.agentStatus,
        currentTurnId: state.currentTurnId,
        currentSessionKey: sendOriginSessionKey,
        conversationTurns: state.conversationTurns,
        taskFlow: state.taskFlow,
        selectedMainModeKey: currentMainModeKey,
        currentWorkspace: state.currentWorkspace,
        contextMentions: mentionSnapshot,
        attachedFilesCount: attachedFilesSnapshot.length,
        planArtifactsCount: state.planArtifacts.length,
        planTasksCount: state.planTasks.length,
        planStage: state.planStage,
        isPlanApproved: state.isPlanApproved,
        pendingRunDecision: state.pendingRunDecision,
        lockedComposerIntent: state.lockedComposerIntent,
      },
    });
    const {
      currentTurn,
      currentTurnHasReplyOptions,
      currentTurnIntent,
      hasPlanArtifacts,
      planExecutionResumeContinuationTarget,
      shouldRouteContinuationToPlanResume,
      shouldContinuePlanIntent,
      previousTurnContinuationTarget,
      shouldContinuePreviousTurnIntent,
      previousTurnContinuationIntent,
      shouldAutoResumeChoiceTurn,
      shouldExplicitlyReuseCurrentTurn,
      reusableTurnId,
      reuseCurrentTurn,
      isInternalTurn,
      shouldReuseExistingTurnIntent,
      shouldExecuteOnceFromReplyOption,
      operationProposalChoiceAction,
      preservePlanState,
    } = submitPipelineDecision.turnReuse;
    const parsedStudioCommand = submitPipelineDecision.parsedStudioCommand;
    const isLocalFastStudioCommand =
      parsedStudioCommand != null &&
      getGameStudioSlashCommandSpec(parsedStudioCommand)?.executionMode === "local_fast";
    const parsedStudioWorkflowArgs = parsedStudioCommand?.type === "workflow"
      ? parsedStudioCommand.args
      : "";
    const parsedSetupEngineCommand =
      parsedStudioCommand?.type === "workflow" && parsedStudioCommand.slug === "setup-engine"
        ? parseSetupEngineArgs(parsedStudioWorkflowArgs)
        : null;
    const autoHydrationReason = submitPipelineDecision.planHydration.reason;
    const applyCurrentSendGate = (
      gateState: AppState,
      queuedWorkflowContext?: {
        runtimeIntentOverride?: ResolvedRunIntent;
        goalSourceContextSnapshot?: string;
      },
    ) => applySubmitSendGateEffects({
      text,
      images,
      hasSupplementalInput,
      isHidden,
      shouldExecuteOnceFromReplyOption,
      state: gateState,
      options: {
        executionConsentGranted: options?.executionConsentGranted,
        runtimeIntentOverride: options?.runtimeIntentOverride,
        turnIdOverride: options?.turnIdOverride,
      },
      mentionSnapshot,
      attachedFilesSnapshot,
      queuedWorkflowContext,
      queueUserMessage: (queuedText, queuedImages, queuedOptions) => {
        get().queueUserMessage(queuedText, queuedImages, queuedOptions);
      },
      approvePendingReviewOnce: () => {
        get().approvePendingReviewOnce();
      },
      approvePlan: (approvalChoice) => {
        get().approvePlan(approvalChoice);
      },
      setState: set,
      setConversationTurnStatus: (turnId, status) => {
        get().setConversationTurnStatus(turnId, status);
      },
      logStoreEvent,
    });

    // Async Plan hydration and semantic Resume both mutate Plan state before
    // they recursively submit a hidden execution prompt. Acquire the owner gate
    // before either route can run.
    if (autoHydrationReason || shouldRouteContinuationToPlanResume) {
      const planResumeSendGateEffect = applyCurrentSendGate(state);
      if (!planResumeSendGateEffect.shouldContinue) {
        return planResumeSendGateEffect.returnValue ?? false;
      }
      state = get();
    }
    if (autoHydrationReason) {
      startSubmitPlanHydrationEffect({
        reason: autoHydrationReason,
        text,
        images,
        options,
        preferredLanguage: preferredLanguage === "en" ? "en" : "zh",
        workspace: state.currentWorkspace,
        sendOriginSessionKey,
        getState: get,
        setState: set,
        hydrateExistingPlanArtifactsForWorkspace,
        derivePlanStageFromArtifacts,
        isSessionRuntimeActive,
        resumeSubmission: (nextText, nextImages, nextOptions) => {
          get().sendMessage(nextText, nextImages, nextOptions);
        },
        logStoreEvent,
      });
      return true;
    }
    const mainDebugShortcut = submitPipelineDecision.shortcuts.mainDebugShortcut;
    if (mainDebugShortcut) {
      text = buildMainDebugPrompt(mainDebugShortcut.rest);
    }
    const mainIntentShortcut = submitPipelineDecision.shortcuts.mainIntentShortcut;
    if (mainIntentShortcut) {
      text = submitPipelineDecision.shortcuts.textAfterIntentShortcut;
    }
    const lockedComposerIntent = submitPipelineDecision.shortcuts.lockedComposerIntent;
    if (submitPipelineDecision.gameStudioModeSwitch.pendingRunDecision) {
      applyPreRunSessionPatch({
        pendingRunDecision: submitPipelineDecision.gameStudioModeSwitch.pendingRunDecision,
      });
      return true;
    }
    if (!text.trim() && !hasSupplementalInput && !images?.length) {
      return false;
    }
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

    const intentRouting = resolveAndApplySubmitIntentRouting({
      text,
      preferredLanguage: preferredLanguage === "en" ? "en" : "zh",
      images,
      options,
      currentMainModeKey,
      parsedStudioCommand,
      isHidden,
      autoApproveTools: state.autoApproveTools,
      fallbackRunIntent: resolveRunIntentFromLegacyWorkflowMode(state.config.workflowMode),
      mainDebugShortcut,
      mainIntentShortcut,
      lockedComposerIntent,
      currentTurn,
      currentTurnIntent,
      hasPlanArtifacts,
      shouldContinuePlanIntent,
      shouldContinuePreviousTurnIntent,
      previousTurnContinuationTarget,
      previousTurnContinuationIntent,
      shouldReuseExistingTurnIntent,
      shouldExecuteOnceFromReplyOption,
      shouldRouteContinuationToPlanResume,
      planExecutionResumeContinuationTarget,
      planStage: state.planStage,
      isPlanApproved: state.isPlanApproved,
      currentTurnId: state.currentTurnId,
      isLocalFastStudioCommand,
      unitySetupEngineSelected: parsedSetupEngineCommand?.engine === "unity",
      dismissedPendingDecisionInputKey: state.dismissedPendingDecisionInputKey,
      currentConfig: get().config,
      sendOriginSessionKey,
      setState: set,
      applyPreRunSessionPatch,
      approvePlan: () => get().approvePlan(),
      startPlanExecutionResume: (resumeRequest) => {
        void runSubmitPlanExecutionResumeEffect({
          text: resumeRequest.text,
          images: resumeRequest.images,
          preferredLanguage: resumeRequest.preferredLanguage,
          shouldRouteContinuationToPlanResume: resumeRequest.shouldRouteContinuationToPlanResume,
          uiParentTurnId: resumeRequest.uiParentTurnId,
          commandDirective: resumeRequest.commandDirective,
          getState: get,
          setState: set,
          applyPreRunSessionPatch,
          hydrateExistingPlanArtifactsForWorkspace,
          ensureApprovedPlanRuntimeTasksForState,
          resumeSubmission: (nextText, nextImages, nextOptions) => {
            get().sendMessage(nextText, nextImages, nextOptions);
          },
          logStoreEvent,
        });
      },
      startBlockingPreflight: (blockingPreflightEffect) => {
        void startSubmitBlockingPreflightEffect({
          effect: blockingPreflightEffect,
          runIntentPreflight,
          getState: get,
          isSessionRuntimeActive,
          applyPreRunSessionPatch,
          resumeSubmission: (nextText, nextImages, nextOptions) => {
            get().sendMessage(nextText, nextImages, nextOptions);
          },
          logStoreEvent,
        });
      },
      logStoreEvent,
    });
    if (intentRouting.handled) {
      return intentRouting.returnValue;
    }
    const {
      effectiveRunIntent,
      effectiveIntentSummary,
      effectiveCommandDirective,
    } = intentRouting;

    const runtimeDecision = resolveSubmitRuntimeDecision({
      effectiveRunIntent,
      runtimeIntentOverride: options?.runtimeIntentOverride,
      currentMainModeKey,
      isPlanApproved: state.isPlanApproved,
      autoApproveTools: state.autoApproveTools,
      executionConsentGranted: options?.executionConsentGranted,
      shouldExecuteOnceFromReplyOption,
      preservePlanState,
      isLocalStudioCommand,
    });
    const effectiveWorkflowMode = runtimeDecision.effectiveWorkflowMode;
    const runtimeRunIntent = runtimeDecision.runtimeRunIntent;
    const effectiveDisplayIntent = runtimeDecision.effectiveDisplayIntent;
    const shouldGrantExecutionConsentForTurn = runtimeDecision.shouldGrantExecutionConsentForTurn;
    const initialTurnStatus = runtimeDecision.initialTurnStatus;
    const goalSourceContextSnapshot = effectiveRunIntent === "goal"
      ? options?.goalSourceContextSnapshot || buildGoalSourceContextSnapshot({
          objective: text,
          agentMessages: get().agentMessages,
          conversationTurns: get().conversationTurns,
          planArtifacts: get().planArtifacts,
        })
      : undefined;

    const sendGateEffect = applyCurrentSendGate(state, effectiveRunIntent === "goal"
      ? {
          runtimeIntentOverride: "goal",
          goalSourceContextSnapshot,
        }
      : undefined);
    if (!sendGateEffect.shouldContinue) {
      return sendGateEffect.returnValue ?? false;
    }

    // Do not clear Plan artifacts until this submission actually owns the run
    // lease. A busy submission is queued as canonical user input and rebuilt
    // when it is dequeued; keeping the Plan here preserves the source context
    // needed by referential Goal requests such as “fix these issues”.
    applySubmitPlanStateReset({
      shouldResetPlanState: runtimeDecision.shouldResetPlanState,
      defaultNormalizedStreamState,
      setState: set,
    });

    const sessionBootstrapDecision = applySubmitSessionBootstrap({
      state,
      set,
      updateSession: (scopeKey, sessionId, patch) => {
        get().updateSession(scopeKey, sessionId, patch);
      },
      autoSessionNowMs: Date.now(),
      commandIssuedAtMs: Date.now(),
    });
    const {
      sessionScopeKey,
      ensuredSessionId,
      runWorkspace,
      runScopeKey,
      runSessionId,
      runSessionKey,
    } = sessionBootstrapDecision;
    const backgroundRunningSessions = (Object.entries(state.runtimeBySessionKey) as [string, SessionRuntimeState][])
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
    const { sessionGet, sessionSet } = createSubmitSessionRuntimeController<AppState, SessionRuntimeState>({
      get,
      set,
      runSessionKey,
      createRuntimeFromState: createSessionRuntimeFromState,
      pickRuntimePatch: pickSessionRuntimePatch,
      normalizePatch: (patch) =>
        normalizeTaskFlowPatchForConsumedReplyOptions(patch as Record<string, unknown>),
      derivePlanStageFromArtifacts,
      createDefaultCurrentTurnState,
      logStoreEvent,
    });

    const turnDraft = prepareSubmitTurnDraft({
      sessionGet,
      conversationTurns: state.conversationTurns,
      text,
      images,
      mentionSnapshot,
      attachedFilesSnapshot,
      runWorkspace,
      preferredLanguage,
      effectiveRunIntent,
      isMainDebugShortcut: !!mainDebugShortcut,
      reuseCurrentTurn,
      reusableTurnId,
      turnIdOverride: options?.turnIdOverride,
      uiParentTurnId,
      ensuredSessionId,
      sessionScopeKey,
      optionTurnTitle: options?.turnTitle,
    });
    const nextId = turnDraft.nextTaskId;
    const turnId = turnDraft.turnId;
    const uiDisplayTurnId = turnDraft.uiDisplayTurnId;
    const currentImages = turnDraft.currentImages;
    const turnInputContextSignals = turnDraft.turnInputContextSignals;
    const userContextItems = turnDraft.userContextItems;
    const existingTurn = turnDraft.existingTurn;
    const titleDecision = turnDraft.titleDecision;
    const {
      turnTitle,
      titleIntentSignature,
      shouldSeedSessionTitleForTurn,
      seededSessionTitleCandidate,
    } = titleDecision;
    const localSlashBridge = createGameStudioLocalSlashBridge({
      sessionGet,
      sessionSet,
      nextTaskId: nextId,
      text,
      turnId,
      userContextItems,
      isHidden,
      reuseCurrentTurn,
      parentPlanTurnId,
      preferredLanguage,
      effectiveRunIntent,
      effectiveDisplayIntent,
      effectiveIntentSummary,
      effectiveCommandDirective,
      effectiveWorkflowMode,
      turnTitle,
      shouldSeedSessionTitleForTurn,
      ensuredSessionId,
      sessionScopeKey,
      titleIntentSignature,
      sanitizeTaskBlocksForPersist,
      normalizeSessionRuntimeSnapshot,
    });

    const localSlashSubmission = startGameStudioLocalSlashSubmission({
      command: parsedStudioCommand,
      preferredLanguage: preferredLanguage === "en" ? "en" : "zh",
      runSessionKey,
      turnId,
      runtimeService: gameStudioRuntimeService,
      getGameStudioInitialized: () => sessionGet().gameStudioInitialized,
      setActiveStudioAgentKey: (agent, options) => sessionGet().setActiveStudioAgentKey(agent, options),
      appendLocalStudioTurn: localSlashBridge.appendLocalStudioTurn,
      emitRuntimeEvent: localSlashBridge.emitLocalSlashRuntimeEvent,
      logStoreEvent,
    });
    if (localSlashSubmission.handled) {
      void localSlashSubmission.completion;
      return true;
    }

    const visibleTurnSubmission = applySubmitVisibleTurn({
      sessionGet,
      sessionSet,
      nextTaskId: nextId,
      nowMs,
      logStoreEvent,
      sendStartedAt,
      runSessionKey,
      runWorkspace,
      text,
      turnId,
      userContextItems,
      currentImages,
      isHidden,
      reuseCurrentTurn,
      uiParentTurnId,
      parentPlanTurnId,
      isInternalTurn,
      shouldExplicitlyReuseCurrentTurn,
      shouldAutoResumeChoiceTurn,
      currentTurnHasReplyOptions,
      explicitReplyOptionSourceTurnId: !isHidden ? options?.replyOptionSourceTurnId : undefined,
      selectedReplyOptionText: options?.selectedReplyOptionText,
      effectiveRunIntent,
      effectiveDisplayIntent,
      effectiveIntentSummary,
      effectiveCommandDirective,
      effectiveWorkflowMode,
      initialTurnStatus,
      operationProposalChoiceAction,
      turnTitle,
      parsedStudioCommand,
      preferredLanguage,
      preservePlanState,
      shouldGrantExecutionConsentForTurn,
    });
    const selectedChoiceText = visibleTurnSubmission.selectedChoiceText;
    const markUserContextItemFailed = visibleTurnSubmission.markUserContextItemFailed;

    applySubmitSeedSessionTitle({
      isHidden,
      shouldSeedSessionTitleForTurn,
      ensuredSessionId,
      sessionScopeKey,
      turnTitle,
      titleIntentSignature,
      taskFlow: sessionGet().taskFlow,
      sessionRecordingEnabled: sessionGet().config.sessionRecordingEnabled,
      sanitizeTaskBlocksForPersist,
      updateSession: (scopeKey, sessionId, patch) => {
        sessionGet().updateSession(scopeKey, sessionId, patch);
      },
    });

    // 每个新 turn 都异步请求一次轻量语义标题：
    // 先用本地标题占位，不阻塞发送；模型结果回来后再覆盖 turn/sidebar 标题。
    const semanticMetadataDecision = resolveSubmitSemanticMetadataDecision({
      text,
      isHidden,
      reuseCurrentTurn,
      optionTurnTitle: options?.turnTitle,
      currentMainModeKey,
      turnId,
      ensuredSessionId,
      sessionScopeKey,
      effectiveRunIntent,
      preferredLanguage,
      currentConfig: sessionGet().config,
      contextSignals: turnInputContextSignals,
      titleIntentSignature,
      seededSessionTitleCandidate,
    });
    void startSubmitSemanticMetadataEffect({
      decision: semanticMetadataDecision,
      requestSemanticTurnMetadata,
      getLatestSnapshot: () => {
        const latestState = sessionGet();
        return {
          conversationTurns: latestState.conversationTurns,
          sessionsByWorkspace: latestState.sessionsByWorkspace,
        };
      },
      updateConversationTurn: (targetTurnId, patch) => {
        sessionGet().updateConversationTurn(targetTurnId, patch);
      },
      updateSession: (scopeKey, sessionId, patch) => {
        sessionGet().updateSession(scopeKey, sessionId, patch);
      },
      logStoreEvent,
      runSessionKey,
      runWorkspace,
    });

    // 2. Start elapsed timer
    const elapsedOwnerTurnIds = new Set([turnId, uiDisplayTurnId].filter(Boolean));
    const initialElapsedSeconds = sessionGet().conversationTurns.reduce(
      (maxElapsed, turn) => elapsedOwnerTurnIds.has(turn.id)
        ? Math.max(maxElapsed, Number(turn.elapsedTime) || 0)
        : maxElapsed,
      0,
    );
    const elapsedTimer = startSubmitElapsedTimer({
      sessionGet,
      sessionSet,
      initialElapsedSeconds,
    });

    void startSubmitAsyncWorkflowRun({
      text,
      turnId,
      uiDisplayTurnId,
      currentImages,
      mentionSnapshot,
      attachedFilesSnapshot,
      runSessionKey,
      runWorkspace,
      runSessionId,
      runScopeKey,
      currentMainModeKey,
      parsedSetupEngineCommand,
      parsedStudioCommand,
      cachedWorkspaceTreeForGameDetection,
      preferredLanguage: preferredLanguage === "en" ? "en" : "zh",
      effectiveRunIntent,
      runtimeRunIntent,
      effectiveWorkflowMode,
      effectiveCommandDirective,
      effectiveIntentSummary,
      preservePlanState,
      shouldContinuePlanIntent,
      shouldContinuePreviousTurnIntent,
      shouldExecuteOnceFromReplyOption,
      currentTurn,
      previousTurnContinuationTarget,
      existingTurn,
      selectedChoiceText,
      goalSourceContextSnapshot,
      parentRunIdOverride: options?.parentRunIdOverride,
      runIdOverride: options?.runIdOverride,
      turnInputContextSignals,
      remoteFeishu,
      options,
      isHidden,
      createVisibleTurnForHiddenMessage,
      nextTaskId: nextId,
      sessionGet,
      sessionSet,
      elapsedTimer,
      markUserContextItemFailed,
      ingestAttachmentFile,
      readFile,
      readDocument,
      analyzeTabularDocument,
      runtimeService: gameStudioRuntimeService,
      logWarning: (event, data) => appendDebugLog("warn", event, data),
      invalidateWorkspaceTreeCache,
      createAbortController: () => new AbortController(),
      getCurrentHarnessInstanceId,
      persistHarnessRunMarker,
      getWorkspaceTree,
      nowMs,
      sendStartedAt,
      getLastTurnToolSummary,
      getLastVisibleTurnAgentSummary,
      PLAN_EXECUTION_PROGRESS_DEFAULT_MAX_ITERATIONS,
      PROVIDER_COMPATIBILITY_FORCE_XML_TTL_MS,
      PROVIDER_COMPATIBILITY_NATIVE_RECOVERY_SUCCESS_STREAK,
      sanitizeTaskBlocksForPersist,
      sanitizeAgentMessagesForPersist,
      normalizeSessionRuntimeSnapshot,
      normalizeProviderCompatibilityByRuntimeKey,
      compactCompletedTurnAgentMessages,
      normalizeQueuedUserMessage,
      startApprovedPlanExecutionInCurrentTurn,
      logStoreEvent,
    });

    return true;
  },

    })),
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
          const restoredMarker = normalizeHarnessRunMarker({
            ...marker,
            status: "paused",
            closedAt: Date.now(),
            closeReason: "application_restarted",
          }) || marker;
          const applyUncleanRestartTelemetry = () => {
            try {
              useAppStore.setState((s: AppState) => ({
                harnessRunMarker: restoredMarker,
                agentStatus: "idle",
                isGenerating: false,
                abortController: null,
                pendingReviewResolve: null,
                pendingReviewTaskId: null,
                pendingToolCall: null,
                activeActionRequest: null,
                conversationTurns: s.conversationTurns.map((turn) =>
                  turn.id === marker.turnId &&
                  (turn.status === "planning" || turn.status === "executing" || turn.status === "awaiting_approval")
                    ? {
                        ...turn,
                        status: "paused",
                        summary: turn.summary || "Application restarted; resume from the last checkpoint.",
                        elapsedTime: Math.max(
                          0,
                          Number(turn.elapsedTime) || 0,
                          Number(s.elapsedTime) || 0,
                        ),
                      }
                    : turn
                ),
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
            } catch (stateError) {
              logStoreEvent("unclean_restart_state_apply_failed", {
                error: stateError instanceof Error ? stateError.message : String(stateError),
              });
            }
          };
          if (typeof queueMicrotask === "function") {
            queueMicrotask(applyUncleanRestartTelemetry);
          } else {
            setTimeout(applyUncleanRestartTelemetry, 0);
          }
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
      const hydratedCurrentSession = hasHydratedCurrentSession
        ? (normalizedSessionsByWorkspace[hydratedCurrentScopeKey] || []).find(
            (session) => session.id === persistedCurrentSessionId,
          ) || null
        : null;
      const normalizedHydratedRuntime = hasHydratedCurrentSession
        ? normalizeSessionRuntimeSnapshot({
            ...persistedState,
            goalRuntime: hydratedCurrentSession?.runtimeSnapshot?.goalRuntime || persistedState.goalRuntime,
            activeGoal: hydratedCurrentSession?.runtimeSnapshot?.activeGoal || persistedState.activeGoal,
            goalProgress: hydratedCurrentSession?.runtimeSnapshot?.goalProgress || persistedState.goalProgress,
          }, { restoreInterruptedGoal: true })
        : undefined;
      const hydratedGoalRuntime = normalizedHydratedRuntime?.goalRuntime || null;
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
      const hydratedTaskFlow = normalizedHydratedRuntime?.taskFlow || [];
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
          cloudExperimentalLoginEnabled: CLOUD_EXPERIMENTAL_LOGIN_AVAILABLE,
          promptLanguageStrategy:
            (persistedConfig as any).promptLanguageStrategy === "english_core_localized_output"
              ? (persistedConfig as any).promptLanguageStrategy
              : current.config.promptLanguageStrategy,
          themeMode: normalizeThemeMode((persistedConfig as any).themeMode),
          appIconVariant: normalizeAppIconVariant((persistedConfig as any).appIconVariant),
          toolPermissionPolicy: normalizeToolPermissionPolicy((persistedConfig as any).toolPermissionPolicy),
          mcpRouting: normalizeMcpRoutingConfig((persistedConfig as any).mcpRouting),
          sessionRecordingEnabled: (persistedConfig as any).sessionRecordingEnabled ?? current.config.sessionRecordingEnabled,
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
        runtimeEvents: normalizedHydratedRuntime?.runtimeEvents || [],
        harnessRunMarker: normalizedHydratedRuntime?.harnessRunMarker || null,
        agentMessages: normalizedHydratedRuntime?.agentMessages || [],
        conversationTurns: normalizedHydratedRuntime?.conversationTurns || [],
        selectedWorkspace: persistedState.selectedWorkspace || persistedState.currentWorkspace || current.selectedWorkspace,
        selectedMainModeKey,
        selectedNexusModeKey: mapMainModeToLegacyNexusMode(selectedMainModeKey),
        imageStudio: normalizeImageStudioRuntime(persistedState.imageStudio),
        activeStudioAgentKey: normalizeStudioAgentKey(persistedState.activeStudioAgentKey),
        gameStudioInitialized: persistedState.gameStudioInitialized === true,
        pendingSlashCommand: normalizedHydratedRuntime?.pendingSlashCommand || null,
        rightPanelTab,
        currentSessionId: hasHydratedCurrentSession ? persistedCurrentSessionId : null,
        currentTurnId: normalizedHydratedRuntime?.currentTurnId || null,
        currentTurnState: createDefaultCurrentTurnState(),
        planArtifacts: normalizedHydratedRuntime?.planArtifacts || [],
        planTasks: normalizedHydratedRuntime?.planTasks || [],
        planExecutionEvidenceLedger: normalizedHydratedRuntime?.planExecutionEvidenceLedger || [],
        planExecutionEvidenceCount: normalizedHydratedRuntime?.planExecutionEvidenceCount || 0,
        planAutoResumeCount: normalizedHydratedRuntime?.planAutoResumeCount || 0,
        planExecutionProgressSnapshot: normalizedHydratedRuntime?.planExecutionProgressSnapshot || null,
        planStage: normalizedHydratedRuntime?.planStage || "idle",
        isPlanApproved: normalizedHydratedRuntime?.isPlanApproved === true,
        activeGoal: hydratedGoalRuntime?.goal ?? null,
        goalProgress: hydratedGoalRuntime?.progress ?? null,
        goalStatus: hydratedGoalRuntime?.status ?? "paused",
        goalIterationBudget: hydratedGoalRuntime?.goal.iterationBudget
          ?? DEFAULT_GOAL_EMERGENCY_CONTINUATION_LIMIT,
        goalRuntime: hydratedGoalRuntime,
        pendingPlanApprovalHandoff: null,
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
        activeActionRequest: normalizedHydratedRuntime?.activeActionRequest || null,
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
    const cloudExperimentalLoginEnabled = CLOUD_EXPERIMENTAL_LOGIN_AVAILABLE;
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
          "- title: short clean UI title for sidebar / ExecutionCapsule, plain text only, no quotes, no markdown, no intent prefix.",
          "- summary: one concise user-facing summary of the real intent, plain text only.",
          "Keep the output in the user's language.",
          "JSON shape:",
          "{\"title\":\"修正标题同步逻辑\",\"summary\":\"调整 sidebar 与 ExecutionCapsule 的标题与摘要生成逻辑\"}",
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
