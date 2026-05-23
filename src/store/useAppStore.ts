// store/useAppStore.ts
// Zustand global state for Local Agent IDE
// All state that was previously scattered as useState in the monolith lives here.
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { executeAgentLoop, type AgentMessage, type OrchestratorCallbacks, type ReviewDecision, type ContentPart } from "../lib/orchestrator";
import type { ExecuteRecoveryMode } from "../lib/executeRecoveryTools";
import {
  analyzeTabularDocument,
  deleteChatTempPath,
  deletePlanFiles,
  deleteWorkspacePath,
  ingestAttachmentFile,
  listDirectory,
  readChatTempFile,
  readDocument,
  readFile,
  readFileWindow,
  shellPermissionPreflight,
  writeChatTempFile,
  writeFile,
  type GitDiffEntry,
  type ReadFileWindowResult,
  type ShellPermissionApproval,
  type ShellPermissionDecision,
} from "../lib/ipc";
import { invoke } from "@tauri-apps/api/core";
import { setWorkspaceRoot as setWorkspaceRootIpc } from "../lib/ipc";
import { appendDebugLog } from "../lib/debugLog";
import {
  closeHarnessRunMarker,
  consumePendingUncleanRestartDiagnostic,
  getCurrentHarnessInstanceId,
  normalizeHarnessRunMarker,
  persistHarnessRunMarker,
  type HarnessRunMarker,
} from "../lib/harnessCrashTelemetry";
import { formatWorkspaceTree } from "../lib/systemPrompt";
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
  type PlanExecutionProgressUpdate,
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
  isEphemeralPlanArtifactPath,
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
  appendPlanEvidenceEntry,
  createPlanExecutionEvidenceEntry,
  isPlanEvidenceLedgerTool,
  isPlanExecutionEvidenceTool,
} from "../lib/planEvidence";
import { buildClosedActivePlanRuntimePatch } from "../lib/planLifecycle";
import {
  buildAnthropicRequestBody,
  buildGeminiRequestForAuthMode,
  buildOpenAiResponsesInputCandidates,
  buildOpenAiResponsesRequestExtras,
  ensureOpenAiChatGptCodexRequestBody,
  extractOpenAiResponsesInstructions,
  extractGeminiResponseText,
  extractOpenAiResponseText,
  parseOpenAiResponsesSseText,
  buildCloudHeaders,
  buildCloudMessagesApiUrl,
  extractAnthropicResponseText,
  normalizeCloudProtocol,
  normalizeCloudToolProtocol,
  resolveEffectiveCloudApiFormat,
  normalizeLocalToolProtocol,
  type CloudToolProtocol,
  type ReasoningDisplayMode,
} from "../lib/cloudProtocol";
import {
  createDefaultCloudConfig,
  normalizeCloudServerState,
  type CloudProfileConfig,
  type CloudServerConfig,
} from "../lib/cloudServers";
import { buildToolDiffPreview, supportsToolDiffPreview } from "../lib/toolDiff";
import { resolveStreamingAssistantDisplay } from "../lib/streamDisplayPolicy";
import { findToolLifecycleBlockIndex, type ToolLifecycleMeta } from "../lib/toolLifecycle";
import { deriveToolIntentSummary } from "../lib/toolPresentation";
import {
  buildToolProgressNarration,
  normalizeProgressNarration,
  progressNarrationToText,
  summarizeToolObservation,
  type ProgressNarration,
  type ProgressNarrationSource,
  type ProgressNarrationStatus,
} from "../lib/progressNarration";
import {
  deriveTurnRuntimePhaseForText,
  deriveTurnRuntimePhaseForTool,
  makeTurnRuntimePhase,
  normalizeTurnRuntimePhase,
  withTurnRuntimePhaseStatus,
  type TurnRuntimePhase,
} from "../lib/turnPhase";
import { buildPlanApprovalChoiceHint, normalizePlanApprovalChoice } from "../lib/planControl";
import {
  PLAN_MAX_AUTO_RESUME_LIMIT,
  buildExecuteMaxIterationsAutoResumeNotice,
  buildExecuteMaxIterationsPauseNotice,
  buildExecuteMaxIterationsResumePrompt,
  buildPlanExecutionProgressUpdate,
  formatPlanExecutionProgressSnapshot,
  buildPlanMaxIterationsAutoResumeNotice,
  buildPlanMaxIterationsPauseNotice,
  buildPlanMaxIterationsResumePrompt,
  normalizePlanExecutionProgressSnapshot,
  type PlanMaxIterationsCheckpoint,
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
  setGameStudioActiveAgent,
  setGameStudioEngineConfig,
} from "../lib/gameStudioPack";
import {
  getGameStudioSlashCommandSpec,
  getDefaultStudioAgentForEngine,
  parseSetupEngineArgs,
  normalizeStudioAgentKey,
  parseGameStudioSlashCommand,
  resolveLegacyNexusModeKey,
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
} from "../lib/runIntent";
import {
  resolvePlanStateHydrationReason,
  shouldPromoteHydratedPlanToExecuting,
} from "../lib/planStateHydration";
import { PLAN_ARTIFACT_PATHS, hydratePlanArtifactsFromReader } from "../lib/planArtifactHydration";
import { mapLegacyNexusModeToMainMode, mapMainModeToLegacyNexusMode, type MainModeKey } from "../lib/mainModes";
import { runIntentPreflight } from "../lib/intentPreflight";
import { runAfterNextPaint } from "../lib/uiScheduling";
import {
  FEISHU_APPROVAL_TTL_MS,
  buildFeishuApprovalCard,
  createFeishuApprovalId,
  createFeishuApprovalNonce,
  createDefaultFeishuAdapterRuntimeStatus,
  createDefaultImAdaptersConfig,
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
  createDefaultMcpRoutingConfig,
  createDefaultToolPermissionPolicy,
  isLocalFileReadApproved,
  normalizeLocalFileReadPath,
  normalizeMcpRoutingConfig,
  normalizeToolPermissionPolicy,
  type McpRoutingConfig,
  type PromptLanguageStrategy,
  type ToolPermissionPolicy,
} from "../lib/toolCapabilities";
import { applyShellCwd } from "../lib/toolExecutionContract";
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

function normalizePendingDecisionInputKey(input: string): string {
  return String(input || "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

type SessionAutoApproveScope = "workspace_write" | "shell";

const SESSION_AUTO_APPROVE_SCOPE_SET = new Set<SessionAutoApproveScope>(["workspace_write", "shell"]);
const DEFAULT_SESSION_AUTO_APPROVE_SCOPES: SessionAutoApproveScope[] = ["workspace_write", "shell"];

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

function resolveSessionAutoApproveScopeForToolCall(toolCall: {
  name: string;
  risk?: string;
}): SessionAutoApproveScope | null {
  if (toolCall.risk === "local_file_read") return null;
  if (toolCall.name === "write_file" || toolCall.name === "replace_in_file") return "workspace_write";
  if (toolCall.name === "run_command" || toolCall.name === "execute_command" || toolCall.name === "send_pty_input") return "shell";
  return null;
}

function shouldSessionAutoApproveToolCall(
  toolCall: { name: string; risk?: string },
  scopes: SessionAutoApproveScope[],
): boolean {
  const scope = resolveSessionAutoApproveScopeForToolCall(toolCall);
  return !!scope && scopes.includes(scope);
}

function isShellReviewTool(name: string): boolean {
  return name === "run_command" || name === "execute_command";
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

function buildShellPermissionApproval(
  decision: ShellPermissionDecision,
  scope: "once" | "session",
): ShellPermissionApproval {
  return {
    command: decision.command,
    approvedAtMs: Date.now(),
    scope,
    rules: suggestedShellPermissionRules(decision),
    riskLevel: decision.riskLevel || null,
  };
}

function suggestedShellPermissionRules(decision: ShellPermissionDecision | null | undefined): string[] {
  if (!decision) return [];
  const seen = new Set<string>();
  const rules: string[] = [];
  for (const rule of decision.suggestedRules || []) {
    const cleanRule = String(rule || "").trim();
    if (!cleanRule || seen.has(cleanRule)) continue;
    seen.add(cleanRule);
    rules.push(cleanRule);
  }
  for (const segment of decision.segmentDecisions || []) {
    if (segment.decision !== "ask") continue;
    const rule = String(segment.suggestedRule || segment.matchedRule || "").trim();
    if (!rule || seen.has(rule)) continue;
    seen.add(rule);
    rules.push(rule);
  }
  const fallback = String(decision.suggestedRule || "").trim();
  if (fallback && !seen.has(fallback)) rules.push(fallback);
  return rules;
}

function formatShellPermissionDecisionForUser(
  decision: ShellPermissionDecision,
  language: "zh" | "en",
): string {
  const source =
    decision.source === "workspace_file"
      ? language === "zh"
        ? "项目权限文件"
        : "workspace permission file"
      : language === "zh"
      ? "内置默认策略"
      : "built-in default policy";
  const rules = suggestedShellPermissionRules(decision);
  const rulesText = rules.length > 0 ? rules.map((rule) => `\`${rule}\``).join(", ") : "";
  const riskText = decision.riskLevel ? `risk=${decision.riskLevel}` : "";
  const reasonText = String(decision.reviewReason || "").trim();
  const relevantSegments = (decision.segmentDecisions || [])
    .filter((segment) => segment.decision === decision.decision || (decision.decision === "deny" && segment.decision === "deny"))
    .map((segment) => `\`${segment.command}\``);
  const segmentText = relevantSegments.length > 0 ? relevantSegments.join(", ") : `\`${decision.command}\``;
  const matchedRule = String(decision.matchedRule || "").trim();
  if (decision.decision === "ask") {
    return language === "zh"
      ? `Shell 权限预检：当前命令未静默放行，将按 ${source} 请求批准。${riskText ? `${riskText}。` : ""}${reasonText ? `${reasonText}。` : ""}待批准 segment：${segmentText}。${rulesText ? `本线程批准会记住规则 ${rulesText}。` : ""}`
      : `Shell permission preflight: this command is approval-gated by the ${source}. ${riskText ? `${riskText}. ` : ""}${reasonText ? `${reasonText}. ` : ""}Segment: ${segmentText}. ${rulesText ? `Approving for this thread will remember ${rulesText}.` : ""}`;
  }
  if (decision.decision === "deny") {
    return language === "zh"
      ? `Shell 权限预检：当前命令被 ${source} 阻止。被拒 segment：${segmentText}。${matchedRule ? `命中 deny 规则：\`${matchedRule}\`。` : rulesText ? `缺少允许规则，建议规则：${rulesText}。` : ""}不要尝试读取 .MAIN/permissions.yaml；请调整命令或暂停让用户处理权限。`
      : `Shell permission preflight: this command is blocked by the ${source}. Denied segment: ${segmentText}. ${matchedRule ? `Matched deny rule: \`${matchedRule}\`.` : rulesText ? `Suggested rule: ${rulesText}.` : ""} Do not try to read .MAIN/permissions.yaml; change the command or pause for the user to handle permissions.`;
  }
  return language === "zh"
    ? `Shell 权限预检：当前命令已被 ${source} 允许。`
    : `Shell permission preflight: this command is allowed by the ${source}.`;
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
    main_mode: "MAIN Mode",
    game_studio: "Game Studio",
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
    main_mode: "MAIN 模式",
    game_studio: "游戏工作室",
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
  approvedShellPermissionRules?: string[];
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
  currentTurnExecutionConsent: { turnId: string | null; granted: boolean };
  approvedLocalFileReadPaths: string[];
  approvedShellPermissionRules: string[];
  readOnlyAutoApproveForSession: boolean;
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
  | (TaskBlockBase & { type: "agent"; content: string; options?: ReplyOption[]; streaming?: boolean; hiddenProcess?: boolean; visibility?: AssistantTextVisibility; archivedAfterChoice?: boolean; selectedOption?: string })
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
  setInput: (v: string, options?: { preserveLockedComposerIntent?: boolean }) => void;
  setPreferredResponseLanguage: (lang: Lang) => void;
  setContextMentions: (v: string[]) => void;
  addMention: (file: string) => void;
  removeMention: (file: string) => void;
  setAttachedFiles: (v: Array<AttachedFile | string>) => void;
  setSelectedMainModeKey: (key: MainModeKey) => void;
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
  currentTurnExecutionConsent: { turnId: string | null; granted: boolean };
  approvedLocalFileReadPaths: string[];
  approvedShellPermissionRules: string[];
  readOnlyAutoApproveForSession: boolean;
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
  responseLanguagePolicy: "follow_input_language",
  theme: "purple",
  themeMode: "dark",
  appIconVariant: "dark",
  workflowMode: "chat",
  promptLanguageStrategy: "english_core_localized_output",
  toolPermissionPolicy: createDefaultToolPermissionPolicy(),
  mcpRouting: createDefaultMcpRoutingConfig(),
  instructionsEnabled: true,
  hooksEnabled: true,
  activeProfile: "local",
  chatFontSize: 13,
  sessionRecordingEnabled: true,
  debugRecordFullTurnProcess: false,
  reasoningDisplay: "hidden",
  eventStreamMode: "dual",
  toolFeedbackFormat: "envelope_v1",
  local: { provider: "OMLX", endpoint: "http://127.0.0.1:8080/v1", model: "", contextLimit: 16384, apiKey: "", toolProtocol: "auto" },
  cloud: defaultCloudState.cloud,
  cloudServers: defaultCloudState.cloudServers,
  activeCloudServerId: defaultCloudState.activeCloudServerId,
  cloudExperimentalLoginEnabled: false,
  imAdapters: createDefaultImAdaptersConfig(),
  workspace: "",
};

function normalizeLocalConfig(
  input?: Partial<LocalConfig> | null,
  fallback: LocalConfig = defaultConfig.local,
): LocalConfig {
  const provider = typeof input?.provider === "string" && input.provider.trim()
    ? input.provider
    : fallback.provider;
  const endpoint = typeof input?.endpoint === "string" ? input.endpoint : fallback.endpoint;
  const model = typeof input?.model === "string" ? input.model : fallback.model;
  const contextLimit = typeof input?.contextLimit === "number" && Number.isFinite(input.contextLimit)
    ? input.contextLimit
    : fallback.contextLimit;
  const apiKey = typeof input?.apiKey === "string" ? input.apiKey : fallback.apiKey;
  const hasStoredToolProtocol = !!input && Object.prototype.hasOwnProperty.call(input, "toolProtocol");

  return {
    provider,
    endpoint,
    model,
    contextLimit,
    apiKey,
    toolProtocol: normalizeLocalToolProtocol(
      hasStoredToolProtocol ? input?.toolProtocol : undefined,
      provider,
    ),
  };
}

const PROVIDER_COMPATIBILITY_FORCE_XML_TTL_MS = 12 * 60 * 1000;
const PROVIDER_COMPATIBILITY_NATIVE_RECOVERY_SUCCESS_STREAK = 2;

function normalizeRuntimeLaneToken(value: unknown): string {
  const compacted = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[|\s]+/g, "_");
  return compacted || "-";
}

function resolveRuntimeLaneKey(config: Partial<AppConfig> | null | undefined): string {
  const activeProfile = config?.activeProfile === "cloud" ? "cloud" : "local";
  if (activeProfile === "local") {
    const localProvider =
      typeof config?.local?.provider === "string" && config.local.provider.trim()
        ? config.local.provider
        : defaultConfig.local.provider;
    const localModel =
      typeof config?.local?.model === "string" && config.local.model.trim()
        ? config.local.model
        : defaultConfig.local.model;
    const localToolProtocol = normalizeLocalToolProtocol(config?.local?.toolProtocol, localProvider);
    return [
      "profile=local",
      `provider=${normalizeRuntimeLaneToken(localProvider)}`,
      `model=${normalizeRuntimeLaneToken(localModel)}`,
      `tool=${normalizeRuntimeLaneToken(localToolProtocol)}`,
      "protocol=local",
      "api_format=chat_completions",
    ].join("|");
  }

  const cloudProtocolInput =
    typeof config?.cloud?.protocol === "string" ? config.cloud.protocol : "openai";
  const cloudExperimentalLoginEnabled = config?.cloudExperimentalLoginEnabled === true;
  const cloudAuthMode = cloudExperimentalLoginEnabled
    ? config?.cloud?.auth?.mode ?? "api_key"
    : "api_key";
  const cloudApiFormat = resolveEffectiveCloudApiFormat({
    protocol: cloudProtocolInput,
    apiFormat:
      typeof config?.cloud?.apiFormat === "string"
        ? config.cloud.apiFormat
        : "chat_completions",
    authMode: cloudAuthMode,
  });
  const cloudProvider =
    typeof config?.cloud?.provider === "string" && config.cloud.provider.trim()
      ? config.cloud.provider
      : defaultConfig.cloud.provider;
  const cloudModel =
    typeof config?.cloud?.model === "string" && config.cloud.model.trim()
      ? config.cloud.model
      : defaultConfig.cloud.model;
  const cloudToolProtocol = normalizeCloudToolProtocol(config?.cloud?.toolProtocol);
  const cloudProtocol = normalizeCloudProtocol(cloudProtocolInput);
  return [
    "profile=cloud",
    `provider=${normalizeRuntimeLaneToken(cloudProvider)}`,
    `model=${normalizeRuntimeLaneToken(cloudModel)}`,
    `tool=${normalizeRuntimeLaneToken(cloudToolProtocol)}`,
    `protocol=${normalizeRuntimeLaneToken(cloudProtocol)}`,
    `api_format=${normalizeRuntimeLaneToken(cloudApiFormat)}`,
    `auth=${normalizeRuntimeLaneToken(cloudAuthMode)}`,
  ].join("|");
}

function normalizeContextMemoryStateByRuntimeKey(value: unknown): Record<string, ContextMemoryState | null> {
  if (!value || typeof value !== "object") return {};
  const normalized: Record<string, ContextMemoryState | null> = {};
  for (const [rawLaneKey, laneState] of Object.entries(value as Record<string, unknown>)) {
    const laneKey = String(rawLaneKey || "").trim();
    if (!laneKey) continue;
    const normalizedState = normalizeContextMemoryState(laneState);
    if (normalizedState) normalized[laneKey] = normalizedState;
  }
  return normalized;
}

function resolveContextMemoryStateForRuntimeLane(
  laneKey: string,
  laneMap: Record<string, ContextMemoryState | null> | null | undefined,
  legacyState: ContextMemoryState | null | undefined,
): ContextMemoryState | null {
  const normalizedLaneMap = normalizeContextMemoryStateByRuntimeKey(laneMap);
  const laneState = normalizeContextMemoryState(normalizedLaneMap[laneKey]);
  if (laneState) return laneState;
  return Object.keys(normalizedLaneMap).length === 0
    ? normalizeContextMemoryState(legacyState)
    : null;
}

function upsertContextMemoryStateForRuntimeLane(
  laneMap: Record<string, ContextMemoryState | null> | null | undefined,
  laneKey: string,
  state: ContextMemoryState | null | undefined,
): Record<string, ContextMemoryState | null> {
  const normalizedState = normalizeContextMemoryState(state);
  if (!normalizedState) return normalizeContextMemoryStateByRuntimeKey(laneMap);
  return {
    ...normalizeContextMemoryStateByRuntimeKey(laneMap),
    [laneKey]: normalizedState,
  };
}

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

function normalizeProviderCompatibilityByRuntimeKey(
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

function normalizeReasoningDisplay(value: unknown, fallback: ReasoningDisplayMode = "hidden"): ReasoningDisplayMode {
  return value === "debug_summary" || value === "raw_debug" || value === "hidden"
    ? value
    : fallback;
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

function normalizeStoredRightPanelTab(value: unknown): RightPanelTab {
  return value === "diff" || value === "terminal" ? value : "plan";
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

function normalizeSessionRuntimeSnapshot(
  snapshot: Partial<SessionRuntimeSnapshot> | null | undefined,
): SessionRuntimeSnapshot | undefined {
  if (!snapshot) return undefined;
  const selectedMainModeKey = mapLegacyNexusModeToMainMode(
    (snapshot as Partial<SessionRuntimeSnapshot> & { selectedAgentKey?: string }).selectedMainModeKey ||
      (snapshot as Partial<SessionRuntimeSnapshot> & { selectedAgentKey?: string }).selectedNexusModeKey ||
      (snapshot as Partial<SessionRuntimeSnapshot> & { selectedAgentKey?: string }).selectedAgentKey,
  );
  const normalizedAutoApproveToolScopes = normalizeSessionAutoApproveScopes(snapshot.autoApproveToolScopes);
  const effectiveAutoApproveToolScopes = normalizedAutoApproveToolScopes.length > 0
    ? normalizedAutoApproveToolScopes
    : snapshot.autoApproveTools === true
    ? buildSessionAutoApproveScopes(true)
    : [];
  const taskFlow = sanitizeTaskBlocksForPersist(snapshot.taskFlow || []);
  const normalizedContextMemoryState = normalizeContextMemoryState(snapshot.contextMemoryState);
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
    approvedShellPermissionRules: Array.isArray(snapshot.approvedShellPermissionRules)
      ? snapshot.approvedShellPermissionRules.filter((rule): rule is string => typeof rule === "string" && rule.trim().length > 0)
      : [],
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
  "currentTurnExecutionConsent",
  "approvedLocalFileReadPaths",
  "approvedShellPermissionRules",
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
  const normalizedAutoApproveToolScopes = (() => {
    const scopes = normalizeSessionAutoApproveScopes(state.autoApproveToolScopes);
    if (scopes.length > 0) return scopes;
    return state.autoApproveTools === true ? buildSessionAutoApproveScopes(true) : [];
  })();
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
    currentTurnExecutionConsent: state.currentTurnExecutionConsent || { turnId: null, granted: false },
    approvedLocalFileReadPaths: Array.isArray(state.approvedLocalFileReadPaths)
      ? state.approvedLocalFileReadPaths.filter((path): path is string => typeof path === "string" && path.trim().length > 0)
      : [],
    approvedShellPermissionRules: Array.isArray(state.approvedShellPermissionRules)
      ? state.approvedShellPermissionRules.filter((rule): rule is string => typeof rule === "string" && rule.trim().length > 0)
      : [],
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

function compactThoughtContent(text: string): string {
  const collapsedParagraphs = collapseRepeatedThoughtParagraphs(String(text || ""));
  const collapsedLines = collapseRepeatedThoughtLines(collapsedParagraphs);
  const collapsedNearDuplicates = collapseNearDuplicateThoughtLines(collapsedLines);
  return limitThoughtContent(compactThoughtNoise(collapsedNearDuplicates));
}

function compactThoughtContentForPersist(text: string): string {
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

function pickProcessAssistantText(visibleText: string, hiddenThought: string | undefined, language: "zh" | "en"): string {
  const visible = String(visibleText || "").trim();
  const hidden = String(hiddenThought || "").trim();
  const hiddenSummary = hidden ? compactProcessAssistantText(hidden, language) : "";
  if (hiddenSummary) return hiddenSummary;
  return compactProcessAssistantText(visible, language);
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
  respond: { zh: "回复", en: "Respond" },
  discuss: { zh: "回复", en: "Respond" },
  plan: { zh: "计划", en: "Plan" },
  execute: { zh: "直接执行", en: "Execute" },
  analyze: { zh: "分析", en: "Analyze" },
  summarize: { zh: "总结", en: "Summarize" },
  report: { zh: "报告", en: "Report" },
  studio_workflow: { zh: "Game Studio 工作流", en: "Game Studio Workflow" },
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

function normalizeAgentContentForDedupe(content: string): string {
  return String(content || "")
    .replace(/<(?:analysis|thought|thinking|reasoning)(?:\s[^>]*)?>[\s\S]*?<\/(?:analysis|thought|thinking|reasoning)>/gi, " ")
    .replace(/<\/?(?:analysis|thought|thinking|reasoning)(?:\s[^>]*)?>/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function compactProgressContextText(text: string, maxChars = 180): string {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars - 3).trim()}...`;
}

function getLatestTurnProgressStrategyText(blocks: TaskBlock[], turnId: string): string {
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index];
    if (block.turnId !== turnId) continue;
    if (block.type === "progress") {
      const text = block.why || block.title || block.action;
      if (text) return compactProgressContextText(text);
    }
    if (block.type === "agent" && (block.hiddenProcess || block.visibility === "user_progress")) {
      const text = normalizeAgentContentForDedupe(block.content || "");
      if (text) return compactProgressContextText(text);
    }
  }
  return "";
}

function getLatestTurnToolObservationText(blocks: TaskBlock[], turnId: string): string {
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index];
    if (block.turnId !== turnId || block.type !== "tool") continue;
    const tool = block as Extract<TaskBlock, { type: "tool" }>;
    const text = tool.observationSummary || tool.evidence || tool.message || tool.intentSummary || "";
    if (text) return compactProgressContextText(text);
  }
  return "";
}

function getTurnUserGoal(blocks: TaskBlock[], turnId: string, fallback = ""): string {
  const userBlock = blocks.find((block) => block.turnId === turnId && block.type === "user");
  if (userBlock?.type === "user") return compactProgressContextText(userBlock.content || "", 240);
  return compactProgressContextText(fallback, 240);
}

function progressBlockMatchesTool(block: Extract<TaskBlock, { type: "progress" }>, toolCallId?: string, toolName?: string, target?: string): boolean {
  const normalizedToolCallId = String(toolCallId || "").trim();
  if (normalizedToolCallId) {
    if (String(block.toolCallId || "") === normalizedToolCallId) return true;
    if (Array.isArray(block.toolCallIds) && block.toolCallIds.map(String).includes(normalizedToolCallId)) return true;
  }
  return !!toolName && block.toolName === toolName && String(block.target || "") === String(target || "");
}

function updateRelatedProgressBlocks(input: {
  blocks: TaskBlock[];
  turnId: string;
  toolName: string;
  target: string;
  toolCallId?: string;
  status: ProgressNarrationStatus;
  source: ProgressNarrationSource;
  evidence?: string;
  next?: string;
  evidenceExcerpt?: string;
  observedFact?: string;
  hypothesisStatus?: ProgressNarration["hypothesisStatus"];
  sourceToolCallIds?: string[];
}): TaskBlock[] {
  let matched = false;
  const updated = input.blocks.map((block) => {
    if (block.type !== "progress" || block.turnId !== input.turnId) return block;
    if (!progressBlockMatchesTool(block, input.toolCallId, input.toolName, input.target)) return block;
    matched = true;
    return {
      ...block,
      status: input.status,
      source: input.source,
      ...(input.evidence ? { evidence: input.evidence } : {}),
      ...(input.next ? { next: input.next } : {}),
      ...(input.evidenceExcerpt ? { evidenceExcerpt: input.evidenceExcerpt } : {}),
      ...(input.observedFact ? { observedFact: input.observedFact } : {}),
      ...(input.hypothesisStatus ? { hypothesisStatus: input.hypothesisStatus } : {}),
      ...(input.sourceToolCallIds && input.sourceToolCallIds.length > 0 ? { sourceToolCallIds: input.sourceToolCallIds } : {}),
    };
  });
  if (matched) return updated;

  const fallbackIdx = (() => {
    for (let index = updated.length - 1; index >= 0; index -= 1) {
      const block = updated[index];
      if (block.type === "progress" && block.turnId === input.turnId && block.status === "running") return index;
    }
    return -1;
  })();
  if (fallbackIdx < 0) return updated;
  const fallback = updated[fallbackIdx];
  if (fallback.type !== "progress") return updated;
  const next = [...updated];
  next[fallbackIdx] = {
    ...fallback,
    status: input.status,
    source: input.source,
    ...(input.evidence ? { evidence: input.evidence } : {}),
    ...(input.next ? { next: input.next } : {}),
    ...(input.evidenceExcerpt ? { evidenceExcerpt: input.evidenceExcerpt } : {}),
    ...(input.observedFact ? { observedFact: input.observedFact } : {}),
    ...(input.hypothesisStatus ? { hypothesisStatus: input.hypothesisStatus } : {}),
    ...(input.sourceToolCallIds && input.sourceToolCallIds.length > 0 ? { sourceToolCallIds: input.sourceToolCallIds } : {}),
  };
  return next;
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

function inferPendingOperationTypes(
  text: string,
  directive?: CommandDirective | null,
): PendingOperationProposal["operationTypes"] {
  const normalized = String(text || "");
  const types = new Set<PendingOperationProposal["operationTypes"][number]>();
  if (directive?.kind === "file_modify") types.add("file_write");
  if (directive?.kind === "shell" || /(?:执行命令|运行命令|运行测试|run command|execute command|run tests?)/i.test(normalized)) types.add("command");
  if (directive?.kind === "git" || /\bgit\b|提交|推送|commit|push/i.test(normalized)) types.add("git");
  if (directive?.kind === "studio" || directive?.kind === "unity" || /(?:外部写入|浏览器|Unity|MCP|external write|browser control)/i.test(normalized)) types.add("external_write");
  if (/部署|发布|上线|deploy|publish|ship/i.test(normalized)) types.add("deploy");
  if (/生成(?:文件|交付物|报告|文档)|写入|创建|generate (?:file|deliverable|report|document)|create (?:file|deliverable|report|document)/i.test(normalized)) types.add("deliverable");
  if (/修改|改动|更改|修复|实现|重构|write|modify|edit|fix|implement|refactor|patch/i.test(normalized)) types.add("file_write");
  return types.size > 0 ? [...types] : ["unknown"];
}

function buildPendingOperationProposal(params: {
  sourceTurnId: string;
  text: string;
  replyOptions: ReplyOption[];
  commandDirective?: CommandDirective | null;
  workflowMode?: AppConfig["workflowMode"];
  isPlanApproved?: boolean;
}): PendingOperationProposal | null {
  if (params.workflowMode === "plan" && !params.isPlanApproved) return null;
  if (!hasOperationApprovalReplyOption(params.replyOptions)) return null;
  const summary = summarizeAssistantText(params.text, 180);
  return {
    sourceTurnId: params.sourceTurnId,
    proposalSummary: summary,
    operationTypes: inferPendingOperationTypes(params.text, params.commandDirective),
    approvalStatus: "pending",
    evidenceStatus: "none",
    createdAt: Date.now(),
  };
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

function compactCompletedTurnAgentMessages(params: {
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
  try {
    const entries = await listDirectory(".MAIN/plans", workspace || undefined);
    const fileNames = new Set(
      entries
        .filter((entry) => !entry.is_dir)
        .map((entry) => entry.name.toLowerCase()),
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
    (path) => readFile(path, workspace || undefined),
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

function hasReviewablePlanState(artifacts: PlanArtifact[], stage: PlanStage): boolean {
  if (stage === "ready_to_execute" || stage === "plan" || stage === "design" || stage === "bugfix") return true;
  return artifacts.some((artifact) => artifact.kind === "plan" || artifact.kind === "design" || artifact.kind === "bugfix");
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
    buildPlanTaskEvidenceAudit({ tasks: input.planTasks }).allTrustedComplete;
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
	  // Config
	  config: defaultConfig,
	  setConfig: (patch) =>
	    set((s) => {
	      const nextConfig = typeof patch === "function" ? patch(s.config) : { ...s.config, ...patch };
	      const normalizedConfig: AppConfig = {
	        ...nextConfig,
	        eventStreamMode: normalizeEventStreamMode(nextConfig.eventStreamMode, s.config.eventStreamMode),
	        toolFeedbackFormat: normalizeToolFeedbackFormat(nextConfig.toolFeedbackFormat, s.config.toolFeedbackFormat),
	        reasoningDisplay: normalizeReasoningDisplay(nextConfig.reasoningDisplay, s.config.reasoningDisplay),
	        local: normalizeLocalConfig(nextConfig.local, s.config.local),
	      };
	      const runtimeLaneKey = resolveRuntimeLaneKey(normalizedConfig);
	      return {
	        config: normalizedConfig,
	        contextMemoryState: resolveContextMemoryStateForRuntimeLane(
	          runtimeLaneKey,
	          s.contextMemoryStateByRuntimeKey,
	          s.contextMemoryState,
	        ),
	      };
	    }),

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
  setShowPlanPanel: (v) => set({
    showPlanPanel: v,
    showDiff: v ? false : get().showDiff,
    showTerminal: v ? false : get().showTerminal,
    rightPanelTab: v ? "plan" : get().rightPanelTab,
  }),
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
  setRightPanelTab: (tab) => set({
    rightPanelTab: tab,
    showPlanPanel: tab === "plan",
    showDiff: tab === "diff",
    showTerminal: tab === "terminal",
  }),
  openRightPanelTab: (tab) => get().setRightPanelTab(tab),
  closeRightPanel: () => set({ showPlanPanel: false, showDiff: false, showTerminal: false }),
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
  dismissedPendingDecisionInputKey: null,
  executionConsentPolicy: "ask_per_turn",
  setInput: (v, options) => set((s) => {
    const currentInputKey = normalizePendingDecisionInputKey(s.input);
    const nextInputKey = normalizePendingDecisionInputKey(v);
    return {
      input: v,
      ...(v.trim().length === 0 && !options?.preserveLockedComposerIntent ? { lockedComposerIntent: null } : {}),
      ...(s.dismissedPendingDecisionInputKey && currentInputKey !== nextInputKey
        ? { dismissedPendingDecisionInputKey: null }
        : {}),
    };
  }),
  setPreferredResponseLanguage: (lang) => set({ preferredResponseLanguage: lang }),
  setContextMentions: (v) => set({ contextMentions: v }),
  addMention: (file) =>
    set((s) =>
      s.contextMentions.includes(file) ? {} : { contextMentions: [...s.contextMentions, file], showFilePicker: false }
    ),
  removeMention: (file) =>
    set((s) => ({ contextMentions: s.contextMentions.filter((f) => f !== file) })),
  setAttachedFiles: (v) => set({ attachedFiles: v.map((file) => normalizeAttachedFile(file)) }),
  setSelectedMainModeKey: (key) => set((s) => ({
    selectedMainModeKey: key,
    selectedNexusModeKey: mapMainModeToLegacyNexusMode(key),
    lockedComposerIntent: null,
    rightPanelTab: normalizeStoredRightPanelTab(s.rightPanelTab),
  })),
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
        approvedLocalFileReadPaths: [],
        approvedShellPermissionRules: [],
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
        autoApproveTools: false,
        autoApproveToolScopes: [],
        approvedLocalFileReadPaths: [],
        approvedShellPermissionRules: [],
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
              approvedLocalFileReadPaths: [],
              approvedShellPermissionRules: [],
              readOnlyAutoApproveForSession: false,
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
      ...(s.currentSessionId !== id ? { readOnlyAutoApproveForSession: false } : {}),
      ...(s.currentSessionId !== id ? { approvedLocalFileReadPaths: [] } : {}),
      ...(s.currentSessionId !== id ? { approvedShellPermissionRules: [] } : {}),
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
        approvedLocalFileReadPaths: [],
        approvedShellPermissionRules: [],
        readOnlyAutoApproveForSession: false,
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
      approvedLocalFileReadPaths: [],
      approvedShellPermissionRules: [],
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
  approvedLocalFileReadPaths: [],
  approvedShellPermissionRules: [],
  readOnlyAutoApproveForSession: false,
  currentTurnExecutionConsent: { turnId: null, granted: false },
  pendingRunDecisionResolver: null,
  setAutoApproveTools: (v) =>
    set({
      autoApproveTools: v,
      autoApproveToolScopes: v ? buildSessionAutoApproveScopes(true) : [],
    }),
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
    const pendingLocalFileReadPath = normalizeLocalFileReadPath(state.pendingToolCall?.localFileReadPath);
    const pendingShellDecision = state.pendingToolCall?.shellPermissionDecision || null;
    const shellRules = suggestedShellPermissionRules(pendingShellDecision);
    if (!pendingLocalFileReadPath) {
      if (shellRules.length > 0) {
        set((s) => ({
          approvedShellPermissionRules: [
            ...s.approvedShellPermissionRules,
            ...shellRules.filter((rule) => !s.approvedShellPermissionRules.includes(rule)),
          ],
        }));
      } else {
        set({
          autoApproveTools: true,
          autoApproveToolScopes: buildSessionAutoApproveScopes(true),
        });
      }
    }
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
      approvedLocalFileReadPaths: [],
      approvedShellPermissionRules: [],
      readOnlyAutoApproveForSession: false,
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
    const remoteFeishu = options?.remoteFeishu;
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
    const shouldContinuePlanIntent =
      !isHidden &&
      currentTurnIntent === "plan" &&
      isContinuationPrompt(text) &&
      (state.planStage !== "completed" || state.planArtifacts.length === 0);
    const shouldAllowPreviousTurnContinuation =
      !isHidden &&
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
    const reusableTurnId = shouldContinuePreviousTurnIntent
      ? previousTurnContinuationTarget?.id ?? null
      : state.currentTurnId;
    const reuseCurrentTurn =
      (options?.reuseCurrentTurn === true || shouldAutoResumeChoiceTurn || shouldContinuePlanIntent || shouldContinuePreviousTurnIntent) &&
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
      const resolution = resolveTurnRunIntent(text, {
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
          const shouldHydrateExistingPlan = looksLikeExistingPlanExecutionRequest(text);
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
              reuseCurrentTurn: false,
              uiParentTurnId: state.currentTurnId || undefined,
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
      logStoreEvent("send_blocked", { reason: "generation_in_progress" });
      return false;
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
        logStoreEvent("send_blocked", {
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
        closeRightPanel: () => sessionSet({ showPlanPanel: false, showDiff: false, showTerminal: false }),
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
                      ? { ...turn, status: initialTurnStatus, intent: turn.intent || effectiveRunIntent }
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
              `${planModeLead} If the request is a complex implementation, gather read-only evidence first, then output a concise visible \`<proposed_plan>\` or Codex-style Proposal for approval; MAIN will materialize it into \`.MAIN/plans/plan.md\`. Create \`.MAIN/plans/requirements.md\` only when the user explicitly wants a requirement ledger or the scope needs traceability. Do not write project source files or tasks.md before approval.`,
              "Creating plan.md is an automatic runtime materialization step, not a user choice and not something the model must force through write_file before approval.",
              "The visible plan must follow the Codex app handoff shape: title, Summary, Key Changes / Implementation Changes, Public APIs / Interfaces / Types, Test Plan, and Assumptions / Defaults.",
              "If it is only a discussion-style plan, keep the answer concise and use user options for real decisions.",
              "",
              userContent,
            ].join("\n")
          : [
              `${planModeLead}如果这是复杂实现请求，请先收集只读证据，再输出精简可见的 \`<proposed_plan>\` 或 Codex-style Proposal 供审批；MAIN 会把它物化为 \`.MAIN/plans/plan.md\`。只有用户明确要求需求台账或范围需要追踪时，才额外生成 \`.MAIN/plans/requirements.md\`。等待用户批准后再改源码；批准前不要生成 tasks.md。`,
              "创建 plan.md 是 runtime 自动物化步骤，不是用户需要选择的下一步，也不是模型必须在审批前强制通过 write_file 完成的动作。",
              "可见计划必须对齐 Codex app 的交接计划结构：标题、摘要、关键实现改动、公共 API/接口/类型、测试方案、假设与默认值。",
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
              "Produce real planning progress now. If key choices remain, summarize them briefly and use <user_options>; otherwise output a concise visible `<proposed_plan>` or Proposal. MAIN will materialize `.MAIN/plans/plan.md`. Do not create requirements.md unless a requirement ledger is explicitly needed.",
              "Keep any plan Markdown concise: review-summary style, no tutorial prose, no full code listings, no repeated background.",
              text.trim() ? `Latest user message: ${text.trim()}` : "Latest user message: continue",
            ].join("\n")
          : [
              "请继续上一轮 PLAN 回合。用户是在要求继续推进，不是开启新的普通讨论。",
              originalPlanPrompt ? `上一轮计划请求：${originalPlanPrompt}` : "上一轮计划请求：请依据当前对话上下文继续。",
              "现在必须产生实际规划进展。如果仍有关键选择需要用户确认，就先简短归纳并用面向用户的口吻给出 <user_options>；否则输出精简可见的 `<proposed_plan>` 或 Proposal。MAIN 会物化 `.MAIN/plans/plan.md`。除非明确需要需求台账，否则不要生成 requirements.md。",
              "每个 <option> 必须是用户点击后会发送的完整选择，不要写成“是否……”问题句。",
              "所有计划 Markdown 都要精简成 Codex app 交接计划风格：标题、摘要、关键实现改动、公共 API/接口/类型、测试方案、假设与默认值；不要写教程式长文、完整代码清单或重复背景。",
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

      const emitHarnessTelemetry = (name: string, details: Record<string, unknown>) => {
        const event = withEventSchema({
          type: "harness.telemetry",
          threadId: runSessionKey,
          turnId,
          timestampMs: Date.now(),
          telemetry: { name, details },
        });
        sessionSet((s) => ({
          runtimeEvents: appendRuntimeEvent(s.runtimeEvents, event),
        }));
        appendDebugLog(
          name === "unclean_termination" ? "error" : name.includes("warning") ? "warn" : "info",
          `harness.${name}`,
          details,
        );
      };

      const emitRunEvent = (event: MainThreadEventInput) => {
        if (normalizeEventStreamMode(sessionGet().config.eventStreamMode) === "legacy") return;
        sessionSet((s) => ({
          runtimeEvents: appendRuntimeEvent(s.runtimeEvents, withEventSchema(event)),
        }));
      };

      const emitProgressRuntimeEvent = (
        progress: ProgressNarration,
        details: {
          tool?: string;
          target?: string;
          dedupeKey?: string;
          iteration?: number;
          repeatCount?: number;
        } = {},
      ) => {
        emitRunEvent({
          type: "progress.updated",
          threadId: runSessionKey,
          turnId,
          timestampMs: Date.now(),
          progress: {
            phase: progress.phase,
            title: progress.title,
            status: progress.status,
            summary: progress.observedFact || progress.evidence || progress.action || progress.next || progress.why,
            action: progress.action,
            evidence: progress.evidence || progress.observedFact || progress.evidenceExcerpt,
            next: progress.next,
            target: details.target || progress.targets?.[0] || "",
            tool: details.tool || "",
            dedupeKey: details.dedupeKey || [
              progress.phase,
              details.tool || "",
              details.target || progress.targets?.[0] || progress.title,
            ].join(":"),
            ...(details.iteration != null ? { iteration: details.iteration } : {}),
            ...(details.repeatCount != null ? { repeatCount: details.repeatCount } : {}),
          },
        });
      };

      const updateHarnessRunMarker = (patch: Partial<HarnessRunMarker> & Record<string, unknown>) => {
        const latest = sessionGet();
        const next = persistHarnessRunMarker({
          ...harnessRunMarker,
          ...patch,
          status: (patch.status as HarnessRunMarker["status"]) || "running",
          planStage: latest.planStage,
          isPlanApproved: latest.isPlanApproved,
          messagesLen: typeof patch.messagesLen === "number" ? patch.messagesLen : latest.agentMessages.length,
          updatedAt: Date.now(),
          closedAt: null,
          closeReason: null,
        });
        harnessRunMarker = next;
        sessionSet({ harnessRunMarker: next });
        const streamStatus = typeof patch.streamStatus === "string" ? patch.streamStatus : "";
        if (
          streamStatus === "stream_started" ||
          streamStatus === "first_chunk" ||
          streamStatus === "chunk_progress" ||
          streamStatus === "no_chunk_progress_warning" ||
          streamStatus === "stream_done" ||
          streamStatus === "stream_error" ||
          streamStatus === "stream_cancelled" ||
          streamStatus === "tool_called"
        ) {
          emitHarnessTelemetry(streamStatus, {
            turnId,
            iteration: next.iteration,
            activeStreamId: next.activeStreamId,
            streamStatus: next.streamStatus,
            streamChunkCount: next.streamChunkCount,
            streamByteCount: next.streamByteCount,
            latestTool: next.latestTool,
            latestToolTarget: next.latestToolTarget,
            lastStreamError: next.lastStreamError,
            streamElapsedMs: next.streamElapsedMs,
            streamLifecycleStatus: next.streamLifecycleStatus,
          });
        }
      };

      const closeCurrentHarnessRunMarker = (status: HarnessRunMarker["status"], reason: string) => {
        if (harnessRunMarker.status !== "running") return;
        const closed = closeHarnessRunMarker({
          ...harnessRunMarker,
          status,
          closeReason: reason,
          planStage: sessionGet().planStage,
          isPlanApproved: sessionGet().isPlanApproved,
          messagesLen: sessionGet().agentMessages.length,
        });
        if (closed) {
          harnessRunMarker = closed;
          sessionSet({ harnessRunMarker: closed });
          emitHarnessTelemetry("task_completed", {
            turnId,
            status,
            reason,
            iteration: closed.iteration,
            streamStatus: closed.streamStatus,
            latestTool: closed.latestTool,
            latestToolTarget: closed.latestToolTarget,
          });
          if (status === "completed") {
            emitRunEvent({
              type: "run.completed",
              threadId: runSessionKey,
              turnId,
              timestampMs: Date.now(),
              summary: sessionGet().conversationTurns.find((item) => item.id === turnId)?.summary || "",
            });
          }
        }
      };

      sessionSet({ harnessRunMarker });
      emitHarnessTelemetry("task_started", {
        turnId,
        runtimeIntent: runtimeRunIntent,
        workflowMode: harnessRunMarker.workflowMode,
        planStage: harnessRunMarker.planStage,
        isPlanApproved: harnessRunMarker.isPlanApproved,
      });

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
      const phaseLanguage = preferredLanguage === "en" ? "en" : "zh";
      let currentTurnRuntimePhase = makeTurnRuntimePhase("scope", phaseLanguage);

      const setCurrentTurnRuntimePhase = (phase?: TurnRuntimePhase) => {
        const normalized = normalizeTurnRuntimePhase(phase, phaseLanguage);
        if (normalized) currentTurnRuntimePhase = normalized;
        return currentTurnRuntimePhase;
      };

      const getPlanRuntimePhaseForTool = (status: "running" | "done" | "failed") => {
        const normalized = normalizeTurnRuntimePhase(currentTurnRuntimePhase, phaseLanguage);
        if (
          normalized?.domain === "plan_runtime" &&
          sessionGet().config.workflowMode === "plan" &&
          !sessionGet().isPlanApproved
        ) {
          return setCurrentTurnRuntimePhase(withTurnRuntimePhaseStatus(normalized, status, phaseLanguage));
        }
        return null;
      };

      const phaseForTool = (
        toolName: string,
        target: string,
        status: "running" | "done" | "failed" = "running",
      ) => getPlanRuntimePhaseForTool(status) || setCurrentTurnRuntimePhase(deriveTurnRuntimePhaseForTool({
          toolName,
          target,
          language: phaseLanguage,
          status,
        }));

      const phaseForProcessText = (text: string) => setCurrentTurnRuntimePhase(
        deriveTurnRuntimePhaseForText(text, phaseLanguage, currentTurnRuntimePhase),
      );

      const attachRuntimePhase = <T extends TaskBlock>(block: T, phase?: TurnRuntimePhase): T => {
        const normalized = normalizeTurnRuntimePhase(block.turnPhase || phase || currentTurnRuntimePhase, phaseLanguage);
        return normalized ? { ...block, turnPhase: normalized } : block;
      };

      // ── Turn-based thought deduplication state ──────────────────────────
      // Prevents triple repetition when reasoning is emitted via multiple paths.
      // We rely entirely on the Zustand store's `currentTurnState` which is reset via `startNewTurn()`.

      // 将新产生的可视块自动挂到当前回合，避免聊天区之后再靠扫描推断归属。
      const appendTurnBlock = (block: TaskBlock) => {
        const targetTurnId = block.turnId && block.turnId !== turnId ? block.turnId : uiDisplayTurnId;
        const blockWithTurn: TaskBlock = attachRuntimePhase({ ...block, turnId: targetTurnId } as TaskBlock);
        if (blockWithTurn.type === "agent") {
          agentBlockIdsCreatedThisRun.add(blockWithTurn.id);
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

      const appendPlanRuntimePhaseProgress = (phase?: TurnRuntimePhase) => {
        const normalized = normalizeTurnRuntimePhase(phase, phaseLanguage);
        if (!normalized || normalized.domain !== "plan_runtime") return;
        const progressPhase =
          normalized.kind === "context" ? "investigating" :
          normalized.kind === "validation" ? "verifying" :
          normalized.kind === "implementation" ? "editing" :
          normalized.kind === "diagnosis" ? "summarizing" :
          "understanding";
        const status = normalized.status === "failed"
          ? "failed"
          : normalized.status === "done"
          ? "done"
          : "running";
        const progress = normalizeProgressNarration({
          phase: progressPhase,
          title: normalized.title,
          why: normalized.summary || "",
          action: "",
          evidence: "",
          next: "",
          targets: [],
          status,
          source: "runtime",
          hypothesisStatus: status === "done" ? "confirmed" : status === "failed" ? "blocked" : "unverified",
        });
        const latest = sessionGet().taskFlow
          .slice()
          .reverse()
          .find((block) =>
            block.turnId === uiDisplayTurnId &&
            block.type === "progress" &&
            block.turnPhase?.domain === "plan_runtime" &&
            block.turnPhase?.id === normalized.id &&
            !block.toolName
          ) as ProgressTaskBlock | undefined;
        if (latest) {
          sessionSet((s) => ({
            taskFlow: s.taskFlow.map((block) =>
              block.id === latest.id && block.type === "progress"
                ? {
                    ...block,
                    turnPhase: normalized,
                    ...progress,
                  }
                : block
            ),
          }));
          return;
        }
        appendTurnBlock({
          id: nextId(),
          turnId,
          turnPhase: normalized,
          type: "progress",
          ...progress,
        });
      };

      let understandingProgressBlockId: number | null = null;
      let understandingProgressClosed = false;
      const buildUnderstandingProgress = (status: "running" | "done" = "running") => {
        const hasImages = currentImages.length > 0;
        const hasContextItems = turnInputContextSignals.mentionedFilePaths.length > 0 || turnInputContextSignals.attachedFilePaths.length > 0;
        const contextText = hasImages
          ? phaseLanguage === "zh"
            ? `用户提供了 ${currentImages.length} 张图片；先理解截图、约束和预期行为。`
            : `The user provided ${currentImages.length} image(s); first understand the screenshots, constraints, and expected behavior.`
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
          : phaseLanguage === "zh"
          ? "随后基于上下文给出直接答复。"
          : "Next, answer directly from the available context.";
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
        understandingProgressBlockId = blockId;
        appendTurnBlock({
          id: blockId,
          turnId,
          turnPhase: makeTurnRuntimePhase("scope", phaseLanguage, { status: "running" }),
          type: "progress",
          ...progress,
        });
        emitProgressRuntimeEvent(progress, {
          dedupeKey: `understanding:${turnId}`,
        });
      };
      const closeUnderstandingProgress = () => {
        if (understandingProgressClosed || understandingProgressBlockId == null) return;
        understandingProgressClosed = true;
        const progress = buildUnderstandingProgress("done");
        const blockId = understandingProgressBlockId;
        sessionSet((s) => ({
          taskFlow: s.taskFlow.map((block) =>
            block.id === blockId && block.type === "progress"
              ? {
                  ...block,
                  ...progress,
                  turnPhase: makeTurnRuntimePhase("scope", phaseLanguage, { status: "done" }),
                }
              : block
          ),
        }));
        emitProgressRuntimeEvent(progress, {
          dedupeKey: `understanding:${turnId}`,
        });
      };
      const discardUnderstandingProgress = () => {
        if (understandingProgressClosed || understandingProgressBlockId == null) return;
        understandingProgressClosed = true;
        const blockId = understandingProgressBlockId;
        understandingProgressBlockId = null;
        sessionSet((s) => ({
          taskFlow: s.taskFlow.filter((block) => block.id !== blockId),
          conversationTurns: s.conversationTurns.map((turn) =>
            turn.id === turnId
              ? { ...turn, blockIds: turn.blockIds.filter((id) => id !== blockId) }
              : turn
          ),
        }));
      };
      appendUnderstandingProgress();

      // ── Throttled streaming update ────────────────────────────────────
      // Buffer incoming tokens and flush at a modest cadence. A fixed cadence
      // keeps scrolling and timers responsive during long reasoning streams.
      let tokenBuffer = "";
      let streamingAssistantDisplayBuffer = "";
      let flushTimerHandle: ReturnType<typeof setTimeout> | null = null;
      const STREAMING_UI_FLUSH_INTERVAL_MS = 90;
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
          workflowMode: latest.config.workflowMode,
          effectiveRunIntent,
          runtimeRunIntent,
          activeProfile: latest.config.activeProfile,
          provider: latest.config.activeProfile === "cloud"
            ? latest.config.cloud.provider
            : latest.config.local.provider,
          model: latest.config.activeProfile === "cloud"
            ? latest.config.cloud.model
            : latest.config.local.model,
          toolProtocol: latest.config.activeProfile === "cloud"
            ? latest.config.cloud.toolProtocol
            : latest.config.local.toolProtocol,
          contextLimit: latest.config.activeProfile === "cloud"
            ? null
            : latest.config.local.contextLimit,
          debugRecordFullTurnProcess: latest.config.debugRecordFullTurnProcess,
          rootCauseProbe: "No visible token yet. Check agent.llm_request_shape for prompt/tool/context size and store.stream_done for empty completion.",
        });
        if (
          latest.config.workflowMode === "plan" &&
          latest.config.activeProfile === "local" &&
          latest.config.local.toolProtocol !== "native"
        ) {
          logStoreEvent("plan_no_visible_token_notice_only", {
            turnId,
            elapsedMs: Math.round(nowMs() - sendStartedAt),
            agentMessages: latest.agentMessages.length,
            planStage: latest.planStage,
            activeProfile: latest.config.activeProfile,
            provider: latest.config.local.provider,
            model: latest.config.local.model,
            toolProtocol: latest.config.local.toolProtocol,
            contextLimit: latest.config.local.contextLimit,
            strategy: "notice_only_no_auto_abort",
          });
        }
      }, 120_000);

      const flushBuffer = () => {
        const chunk = tokenBuffer;
        tokenBuffer = "";
        flushTimerHandle = null;

        if (!chunk) return;

        // Run through the thinking interceptor
        let { agent, thinking, thoughtStarted, thoughtEnded } = thinkingInterceptor.feed(chunk);

        const latestStateForDedupe = sessionGet();
        const shouldDisplayReasoningBlocks = latestStateForDedupe.config.reasoningDisplay !== "hidden";
        const nextInterceptorThought = thinking
          ? appendThoughtDelta(latestStateForDedupe.currentTurnState.interceptorThought, thinking)
          : latestStateForDedupe.currentTurnState.interceptorThought;
        const currentInterceptorThoughtContent = thinkingInterceptor.getThinkingContent() || thinking;
        let thoughtIdToCreate: number | null = null;
        let thoughtIdToUpdate = currentThoughtBlockId;
        const thoughtDuration = thoughtStartTime ? Math.round((Date.now() - thoughtStartTime) / 1000) : undefined;

        if (thoughtStarted && shouldDisplayReasoningBlocks) {
          thoughtStartTime = Date.now();
          // Keep one live thought cell per turn; the UI treats it as a replaceable
          // activity summary instead of a transcript of every reasoning fragment.
          const existingThoughtBlock = sessionGet().taskFlow
            .filter((b) => b.turnId === turnId)
            .reverse()
            .find((b) => b.type === "thought");
          if (existingThoughtBlock && !existingThoughtBlock.isStreaming) {
            // Reuse the existing thought block — just update it
            thoughtIdToCreate = null;
            currentThoughtBlockId = existingThoughtBlock.id;
            thoughtIdToUpdate = existingThoughtBlock.id;
          } else if (existingThoughtBlock && existingThoughtBlock.isStreaming) {
            // Already streaming — just append to it
            thoughtIdToCreate = null;
            currentThoughtBlockId = existingThoughtBlock.id;
            thoughtIdToUpdate = existingThoughtBlock.id;
          } else {
            thoughtIdToCreate = nextId();
            currentThoughtBlockId = thoughtIdToCreate;
            thoughtIdToUpdate = thoughtIdToCreate;
          }
        }

        let thoughtEndedId: number | null = null;
        if (thoughtEnded && currentThoughtBlockId !== null && shouldDisplayReasoningBlocks) {
          thoughtEndedId = currentThoughtBlockId;
          currentThoughtBlockId = null;
          thoughtStartTime = null;
        } else if (thoughtEnded && !shouldDisplayReasoningBlocks) {
          currentThoughtBlockId = null;
          thoughtStartTime = null;
        }

        // ── Handle agent content ──
        let agentContent = agent;
        let agentBlockIdToCreate: number | null = null;
        let agentBlockIdToAppend: number | null = null;

        if (agentContent) {
          // Cross-type deduplication: If this is the start of the agent reply and it repeats thought content, strip it.
          if (nextInterceptorThought && currentStreamingBlockId === null) {
            const normThought = nextInterceptorThought.trim().toLowerCase().replace(/\s+/g, ' ');
            const normAgent = agentContent.trim().toLowerCase().replace(/\s+/g, ' ');

            if (normAgent.startsWith(normThought) || normThought.includes(normAgent)) {
              // If the reasoning is being echoed in agent text, wait for real content
              // or strip the overlap if the full block is already present.
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
            const displayCandidate = streamingAssistantDisplayBuffer + agentContent;
            const displayDecision = resolveStreamingAssistantDisplay({
              text: displayCandidate,
              language: phaseLanguage,
              workflowMode: sessionGet().config.workflowMode,
              runIntent: effectiveRunIntent,
              hasVisibleAgentBlock: currentStreamingBlockId !== null,
            });
            if (displayDecision.action === "show") {
              agentContent = displayDecision.text;
              streamingAssistantDisplayBuffer = "";
            } else if (displayDecision.action === "buffer") {
              streamingAssistantDisplayBuffer = displayDecision.bufferText || displayCandidate;
              agentContent = "";
            } else {
              streamingAssistantDisplayBuffer = "";
              agentContent = "";
            }
          }

          if (agentContent) {
            if (currentStreamingBlockId === null) {
              agentBlockIdToCreate = nextId();
              currentStreamingBlockId = agentBlockIdToCreate;
              agentBlockIdsCreatedThisRun.add(agentBlockIdToCreate);
            } else {
              agentBlockIdToAppend = currentStreamingBlockId;
            }
          }
        }

        if (!thinking && !thoughtStarted && !thoughtEndedId && !agentContent) return;

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
          } else if (shouldDisplayReasoningBlocks && thoughtIdToUpdate !== null && thinking) {
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
      };

      const scheduleFlush = () => {
        if (flushTimerHandle === null) {
          flushTimerHandle = setTimeout(flushBuffer, STREAMING_UI_FLUSH_INTERVAL_MS);
        }
      };

      // region: 流式块收尾
      const finalizeStreamingUi = () => {
        if (flushTimerHandle !== null) {
          clearTimeout(flushTimerHandle);
          flushTimerHandle = null;
        }
        clearNoFirstTokenNoticeTimer();
        if (tokenBuffer) {
          flushBuffer();
        }

        let { agent: remainingAgent } = thinkingInterceptor.flush();
        if (remainingAgent) {
          const displayCandidate = streamingAssistantDisplayBuffer + remainingAgent;
          const displayDecision = resolveStreamingAssistantDisplay({
            text: displayCandidate,
            language: phaseLanguage,
            workflowMode: sessionGet().config.workflowMode,
            runIntent: effectiveRunIntent,
            hasVisibleAgentBlock: currentStreamingBlockId !== null,
          });
          if (displayDecision.action === "show") {
            remainingAgent = displayDecision.text;
          } else {
            remainingAgent = "";
          }
          streamingAssistantDisplayBuffer = "";
        } else {
          streamingAssistantDisplayBuffer = "";
        }
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

      const writePlanExecutionProgress = (progress: PlanExecutionProgressUpdate) => {
        const snapshot = normalizePlanExecutionProgressSnapshot({
          turnId,
          update: progress,
          previous: sessionGet().planExecutionProgressSnapshot,
          now: Date.now(),
        });
        const language = sessionGet().preferredResponseLanguage || sessionGet().config.language;
        const content = formatPlanExecutionProgressSnapshot(snapshot, language === "en" ? "en" : "zh").trim();
        if (!content) return;
        appendDebugLog("info", "plan.execution_progress", {
          turnId,
          uiDisplayTurnId,
          phase: snapshot.phase,
          iteration: snapshot.iteration,
          maxIterations: snapshot.maxIterations,
          autoResumeCount: snapshot.autoResumeCount,
          currentTask: snapshot.currentTask,
          currentTool: snapshot.currentTool,
          latestEvidence: snapshot.latestEvidence,
          nextStep: snapshot.nextStep,
          progressSignature: snapshot.progressSignature || null,
          repeatedTargets: snapshot.repeatedTargets || [],
          recoveryReason: snapshot.recoveryReason || null,
          content,
        });
        sessionSet({ planExecutionProgressSnapshot: snapshot });
      };

      const emitLocalPlanExecutionProgress = (
        phase: PlanExecutionProgressUpdate["phase"],
        overrides: Partial<PlanExecutionProgressUpdate> = {},
      ) => {
        const latest = sessionGet();
        if (effectiveRunIntent !== "plan" || !latest.isPlanApproved) return;
        const language = latest.preferredResponseLanguage || latest.config.language;
        const previous = latest.planExecutionProgressSnapshot;
        writePlanExecutionProgress({
          ...buildPlanExecutionProgressUpdate({
            language: language === "en" ? "en" : "zh",
            phase,
            iterationCount: previous?.iteration ?? 0,
            maxIterations: previous?.maxIterations || PLAN_EXECUTION_PROGRESS_DEFAULT_MAX_ITERATIONS,
            autoResumeCount: latest.planAutoResumeCount,
            tasks: latest.planTasks,
            evidenceLedger: latest.planExecutionEvidenceLedger,
            recentToolActivity: [],
          }),
          ...overrides,
        });
      };
      let approvedPlanHandoff:
        | {
            prompt: string;
            parentPlanTurnId: string;
            executionTurnId: string;
            title: string;
            intentSummary: string;
          }
        | null = null;

      const callbacks: OrchestratorCallbacks = {
        getMessages: () => sessionGet().agentMessages,
        getConfig: () => ({ ...sessionGet().config, workspace: runWorkspace }),
        getPreferredLanguage: () => sessionGet().preferredResponseLanguage || sessionGet().config.language,
        getSkills: () => sessionGet().skills,
        getMainModeKey: () => sessionGet().selectedMainModeKey,
        getActiveStudioAgentKey: () => sessionGet().activeStudioAgentKey,
        getGameStudioInitialized: () => sessionGet().gameStudioInitialized,
        getPendingSlashCommand: () => sessionGet().pendingSlashCommand,
        getGameStudioConfig: () => gameStudioConfigForTurn,
        getWorkspaceTree: () => workspaceTree,
        getMcpServers: () => sessionGet().mcpServers,
        getMcpDiscoveredTools: () => sessionGet().mcpDiscoveredTools,
        getAssociatedPaths: () => sessionGet().resolvedInstructionSet?.associatedPaths ?? [],
        getSessionKey: () => runSessionKey,
        getCurrentTurnId: () => turnId,
        hasSessionHookInitialized: (key) => sessionGet().hasSessionHookInitialized(key),
        markSessionHookInitialized: (key) => sessionGet().markSessionHookInitialized(key),
        onInstructionsResolved: (resolved) => sessionGet().setResolvedInstructionSet(resolved),
        onHooksLoaded: (hooks, loadedAt) => sessionGet().setLoadedHookDefinitions(hooks, loadedAt),
        onHookStart: (_event, _hook) => { /* UI feedback placeholder */ },
        onHookResult: (record) => sessionGet().appendHookExecutionRecords([record]),
        onHookBlocked: (_event, _reason, _record) => { /* UI feedback placeholder */ },
        getCurrentRunIntent: () => sessionGet().getCurrentRunIntent(),
        getRuntimeRunIntent: () => runtimeRunIntent,
        getForcedExecuteRecoveryMode: () => options?.forceExecuteRecoveryMode ?? null,
        getCommandDirective: () => effectiveCommandDirective,
        getWorkflowMode: () => getIntentPolicy(sessionGet().getCurrentRunIntent()).workflowMode,
        getIsPlanApproved: () => sessionGet().isPlanApproved,
        getPlanApprovalChoice: () => sessionGet().planApprovalChoice,
        getReadOnlyAutoApproveForSession: () => sessionGet().readOnlyAutoApproveForSession,
        getApprovedLocalFileReadPaths: () => sessionGet().approvedLocalFileReadPaths || [],
        getPlanStage: () => sessionGet().planStage,
        getPlanTasks: () => sessionGet().planTasks,
        getPlanExecutionEvidenceLedger: () => sessionGet().planExecutionEvidenceLedger,
        getPlanAutoResumeCount: () => sessionGet().planAutoResumeCount,
        getStatus: () => sessionGet().agentStatus,
        startNewTurn: () => sessionGet().startNewTurn(),
        onApprovedPlanHandoff: (prompt) => {
          const language = sessionGet().config.language === "en" ? "en" : "zh";
          const executionTurnId = `turn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
          approvedPlanHandoff = {
            prompt,
            parentPlanTurnId: turnId,
            executionTurnId,
            title: language === "zh" ? "执行已批准计划" : "Execute Approved Plan",
            intentSummary: language === "zh"
              ? "用户已批准计划，MAIN 将在新的执行回合中按 plan.md 落地。"
              : "The user approved the plan; MAIN will execute plan.md in a new execution turn.",
          };
          const progressSnapshot = normalizePlanExecutionProgressSnapshot({
            turnId: executionTurnId,
            update: buildPlanExecutionProgressUpdate({
              language,
              phase: "starting",
              iterationCount: 0,
              maxIterations: PLAN_EXECUTION_PROGRESS_DEFAULT_MAX_ITERATIONS,
              autoResumeCount: 0,
              tasks: sessionGet().planTasks,
              evidenceLedger: [],
              recentToolActivity: [],
              nextStep: language === "zh"
                ? "开启新的执行回合并按已批准 plan.md 执行"
                : "start a new execution turn and follow the approved plan.md",
            }),
            previous: sessionGet().planExecutionProgressSnapshot,
            now: Date.now(),
          });
          sessionSet((s) => ({
            currentTurnExecutionConsent: { turnId: executionTurnId, granted: true },
            planExecutionProgressSnapshot: progressSnapshot,
            conversationTurns: s.conversationTurns.map((turn) =>
              turn.id === turnId
                ? {
                    ...turn,
                    status: "done",
                    summary: language === "zh"
                      ? "计划已批准，执行已交接到新的回合。"
                      : "Plan approved; execution was handed off to a new turn.",
                  }
                : turn,
            ),
          }));
          logStoreEvent("plan_approval_handoff_queued", {
            planTurnId: turnId,
            executionTurnId,
            sessionKey: runSessionKey,
            workspace: runWorkspace || null,
          });
        },
        getContextMemoryState: () => {
          const latest = sessionGet();
          const laneKey = resolveRuntimeLaneKey(latest.config);
          return resolveContextMemoryStateForRuntimeLane(
            laneKey,
            latest.contextMemoryStateByRuntimeKey,
            latest.contextMemoryState,
          );
        },
        shouldForceXmlForProviderCompatibility: () => {
          const latest = sessionGet();
          const laneKey = resolveRuntimeLaneKey(latest.config);
          const normalizedMap = normalizeProviderCompatibilityByRuntimeKey(latest.providerCompatibilityByRuntimeKey);
          const laneState = normalizedMap[laneKey];
          if (!laneState?.forceXmlTools) return false;
          if (laneState.fallbackExpiresAt != null && Date.now() >= laneState.fallbackExpiresAt) {
            sessionSet((s) => {
              const nextMap = normalizeProviderCompatibilityByRuntimeKey(s.providerCompatibilityByRuntimeKey);
              const currentLane = nextMap[laneKey];
              if (!currentLane) return {};
              nextMap[laneKey] = {
                ...currentLane,
                forceXmlTools: false,
                fallbackExpiresAt: null,
                nativeSuccessStreak: 0,
              };
              return { providerCompatibilityByRuntimeKey: nextMap };
            });
            return false;
          }
          return true;
        },
        onProviderCompatibilityFallback: (reason) => {
          const laneKey = resolveRuntimeLaneKey(sessionGet().config);
          const now = Date.now();
          logStoreEvent("provider_compatibility_fallback", {
            turnId,
            sessionKey: runSessionKey,
            workspace: runWorkspace || null,
            laneKey,
            reason: String(reason || "").slice(0, 240),
            cooldownMs: PROVIDER_COMPATIBILITY_FORCE_XML_TTL_MS,
          });
          sessionSet((s) => {
            const nextMap = normalizeProviderCompatibilityByRuntimeKey(s.providerCompatibilityByRuntimeKey);
            nextMap[laneKey] = {
              forceXmlTools: true,
              fallbackExpiresAt: now + PROVIDER_COMPATIBILITY_FORCE_XML_TTL_MS,
              nativeSuccessStreak: 0,
              lastFallbackAt: now,
            };
            return { providerCompatibilityByRuntimeKey: nextMap };
          });
        },
        onProviderNativeToolSuccess: () => {
          const laneKey = resolveRuntimeLaneKey(sessionGet().config);
          sessionSet((s) => {
            const nextMap = normalizeProviderCompatibilityByRuntimeKey(s.providerCompatibilityByRuntimeKey);
            const currentLane = nextMap[laneKey];
            if (!currentLane) return {};
            const nextSuccessStreak = currentLane.nativeSuccessStreak + 1;
            if (nextSuccessStreak >= PROVIDER_COMPATIBILITY_NATIVE_RECOVERY_SUCCESS_STREAK) {
              const rest = { ...nextMap };
              delete rest[laneKey];
              logStoreEvent("provider_compatibility_recovered", {
                turnId,
                sessionKey: runSessionKey,
                workspace: runWorkspace || null,
                laneKey,
                successStreak: nextSuccessStreak,
              });
              return { providerCompatibilityByRuntimeKey: rest };
            }
            nextMap[laneKey] = {
              ...currentLane,
              forceXmlTools: false,
              fallbackExpiresAt: null,
              nativeSuccessStreak: nextSuccessStreak,
            };
            return { providerCompatibilityByRuntimeKey: nextMap };
          });
        },
        onHarnessRunUpdate: (patch) => {
          updateHarnessRunMarker(patch as Partial<HarnessRunMarker> & Record<string, unknown>);
        },

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
            streamingAssistantDisplayBuffer = "";
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

        onStreamDone: (_fullText, _msgId, truncated, meta) => {
          finalizeStreamingUi();
          const suppressTruncationWarning =
            !!meta?.suppressTruncationWarning &&
            effectiveRunIntent === "plan" &&
            !sessionGet().isPlanApproved;
          logStoreEvent("stream_done", {
            turnId,
            sessionKey: runSessionKey,
            workspace: runWorkspace || null,
            fullTextChars: _fullText.length,
            truncated,
            suppressTruncationWarning,
            truncationReason: meta?.reason || null,
            firstTokenElapsedMs: firstStreamTokenAt == null ? null : Math.round(firstStreamTokenAt - sendStartedAt),
            streamTokenCount,
            streamTextChars,
            taskFlowBlocks: sessionGet().taskFlow.length,
            agentBlocksCreatedThisRun: agentBlockIdsCreatedThisRun.size,
          });

          // Show truncation warning if the model hit max_tokens
          if (truncated && !suppressTruncationWarning) {
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

          if (sessionGet().config.reasoningDisplay === "hidden") {
            logStoreEvent("reasoning_suppressed", {
              turnId,
              source: "normalized_hidden_thought",
              chars: thought.length,
            });
            return;
          }

          const currentFlow = sessionGet().taskFlow;
          // Find the last thought block in this turn (not just the very last block),
          // so that thought blocks can be merged even when tool blocks appear after them.
          const turnBlocks = currentFlow.filter((b) => b.turnId === turnId);
          const lastThoughtBlock = [...turnBlocks].reverse().find((b) => b.type === "thought");

          if (lastThoughtBlock) {
            const existingContent = (lastThoughtBlock as Extract<TaskBlock, { type: "thought" }>).content;
            const existing = normalizeForComp(existingContent);
            
            // If the incoming thought is already present, update metadata and avoid duplication.
            if (existing.includes(incoming)) {
              if (duration !== undefined) {
                const tid = lastThoughtBlock.id;
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
            const tid = lastThoughtBlock.id;
            const nextContent = appendThoughtDelta(existingContent, thought);
            sessionSet((s) => ({
              taskFlow: s.taskFlow.map((t) =>
                t.id === tid && t.type === "thought"
                  ? { ...t, content: nextContent, isStreaming: true, duration }
                  : t
              ),
            }));
            // Auto-collapse after a brief display period
            setTimeout(() => {
              sessionSet((s) => ({
                taskFlow: s.taskFlow.map((t) =>
                  t.id === tid && t.type === "thought"
                    ? { ...t, content: compactThoughtContentForPersist((t as Extract<TaskBlock, { type: "thought" }>).content), isStreaming: false }
                    : t
                ),
              }));
              thoughtStartTime = null;
            }, 1200);
          } else {
            // No thought block in this turn yet — create the first one
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
                    ? { ...t, content: compactThoughtContentForPersist((t as Extract<TaskBlock, { type: "thought" }>).content), isStreaming: false }
                    : t
                ),
              }));
              thoughtStartTime = null;
            }, 1200);
          }
        },

        onAssistantFinalText: (text, replyOptions = [], meta) => {
          const language = sessionGet().config.language === "en" ? "en" : "zh";
          const fallbackText = replyOptions.length > 0
            ? language === "en"
              ? "Choose how you'd like to continue."
              : "请选择你希望我如何继续。"
            : "";
          const cleanText = text.trim() || fallbackText;
          const metaVisibility = meta?.visibility;
          const hasReplyOptions = replyOptions.length > 0;
          const hasToolCallsWithoutOptions = !!meta?.hasToolCalls && !hasReplyOptions;
          if (hasReplyOptions) {
            discardUnderstandingProgress();
          } else if (!hasToolCallsWithoutOptions && meta?.visibility !== "user_progress") {
            closeUnderstandingProgress();
          }
          const isHiddenProcessText = !hasReplyOptions && metaVisibility === "hidden_process";
          const isSubstantivePlanText = !hasReplyOptions && metaVisibility === "substantive_plan_text";
          const isUserProgressText =
            !hasReplyOptions &&
            (
              metaVisibility === "user_progress" ||
              !!meta?.progress ||
              (hasToolCallsWithoutOptions && !metaVisibility)
            );
          const processPhase = (isHiddenProcessText || isUserProgressText)
            ? (() => {
                const firstCall = meta?.toolCalls?.[0];
                if (firstCall) {
                  return phaseForTool(firstCall.name, firstCall.target || "", "running");
                }
                return phaseForProcessText(cleanText);
              })()
            : currentTurnRuntimePhase;
          const displayText = isHiddenProcessText
            ? pickProcessAssistantText(cleanText, meta?.hiddenThought, language)
            : cleanText;
          const stateVisibleText = isHiddenProcessText ? "" : displayText;
          const progressFromMeta = (() => {
            if (!isUserProgressText) return null;
            if (meta?.progress) return normalizeProgressNarration(meta.progress);
            const firstCall = meta?.toolCalls?.[0];
            if (!firstCall) return null;
            const currentFlowForProgress = sessionGet().taskFlow;
            return buildToolProgressNarration({
              toolName: firstCall.name,
              target: firstCall.target || "",
              language,
              status: "running",
              source: "model",
              userGoal: getTurnUserGoal(currentFlowForProgress, turnId, displayText),
              currentHypothesis: metaVisibility === "user_progress" ? "" : displayText,
              previousObservation: getLatestTurnToolObservationText(currentFlowForProgress, turnId),
              turnIntent: effectiveRunIntent,
              workflowMode: sessionGet().config.workflowMode,
              sourceToolCallIds: (meta?.toolCalls || [])
                .map((call) => String((call as any).id || "").trim())
                .filter(Boolean),
            });
          })();
          const progressDisplayText = progressFromMeta
            ? progressNarrationToText(progressFromMeta, language)
            : displayText;
          const pendingOperationProposal = buildPendingOperationProposal({
            sourceTurnId: turnId,
            text: displayText,
            replyOptions,
            commandDirective: effectiveCommandDirective,
            workflowMode: effectiveWorkflowMode,
            isPlanApproved: sessionGet().isPlanApproved,
          });
          const markPendingOperationProposal = () => {
            if (!pendingOperationProposal) return;
            sessionSet((s) => ({
              conversationTurns: s.conversationTurns.map((turn) =>
                turn.id === turnId
                  ? {
                      ...turn,
                      pendingOperationProposal: pendingOperationProposal,
                    }
                  : turn,
              ),
            }));
          };
          const currentFlow = sessionGet().taskFlow;
          const latestBlock = [...currentFlow].reverse().find((block) =>
            block.turnId === turnId &&
            block.type === "agent" &&
            agentBlockIdsCreatedThisRun.has(block.id)
          );
          const displayTextKey = normalizeAgentContentForDedupe(displayText);
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
            visibility: metaVisibility || (isUserProgressText ? "user_progress" : null),
          });

          if (progressFromMeta) {
            const toolCallIds = (meta?.toolCalls || [])
              .map((call) => String((call as any).id || "").trim())
              .filter(Boolean);
            const firstCall = meta?.toolCalls?.[0];
            const preserveAssistantProgressText =
              meta?.preserveAssistantText === true &&
              displayText.trim().length > 0;
            if (preserveAssistantProgressText && latestBlock?.type === "agent") {
              sessionSet((s) => ({
                normalizedStreamState: {
                  ...s.normalizedStreamState,
                  visibleText: stateVisibleText,
                  replyOptions,
                },
                conversationTurns: s.conversationTurns.map((turn) =>
                  turn.id === turnId && !turn.blockIds.includes(latestBlock.id)
                    ? { ...turn, blockIds: [...turn.blockIds, latestBlock.id] }
                    : turn
                ),
                taskFlow: s.taskFlow.map((block) =>
                  block.id === latestBlock.id && block.type === "agent"
                    ? {
                        ...block,
                        turnPhase: normalizeTurnRuntimePhase(block.turnPhase || processPhase, phaseLanguage),
                        content: displayText,
                        options: undefined,
                        hiddenProcess: undefined,
                        visibility: undefined,
                        streaming: false,
                      }
                    : block
                ),
              }));
            } else {
              sessionSet((s) => ({
                normalizedStreamState: {
                  ...s.normalizedStreamState,
                  visibleText: preserveAssistantProgressText ? stateVisibleText : progressDisplayText,
                  replyOptions,
                },
                ...(latestBlock && latestBlock.type === "agent"
                  ? {
                      taskFlow: s.taskFlow.filter((block) => block.id !== latestBlock.id),
                      conversationTurns: s.conversationTurns.map((turn) =>
                        turn.id === turnId
                          ? { ...turn, blockIds: turn.blockIds.filter((blockId) => blockId !== latestBlock.id) }
                          : turn
                      ),
                    }
                  : {}),
              }));
              if (latestBlock?.type === "agent") {
                agentBlockIdsCreatedThisRun.delete(latestBlock.id);
              }
              if (preserveAssistantProgressText) {
                appendTurnBlock({
                  id: nextId(),
                  turnId,
                  turnPhase: processPhase,
                  type: "agent",
                  content: displayText,
                  streaming: false,
                });
              }
            }
            appendTurnBlock({
              id: nextId(),
              turnId,
              turnPhase: processPhase,
              type: "progress",
              ...progressFromMeta,
              ...(toolCallIds[0] ? { toolCallId: toolCallIds[0] } : {}),
              ...(toolCallIds.length > 0 ? { toolCallIds } : {}),
              ...(firstCall?.name ? { toolName: firstCall.name } : {}),
              ...(firstCall?.target ? { target: firstCall.target } : {}),
            });
            emitProgressRuntimeEvent(progressFromMeta, {
              tool: firstCall?.name,
              target: firstCall?.target,
              dedupeKey: [
                progressFromMeta.phase,
                firstCall?.name || "model",
                firstCall?.target || progressFromMeta.title,
              ].join(":"),
            });
            return;
          }

          if (!displayText) {
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

          if (latestBlock && replyOptions.length === 0 && displayTextKey) {
            const duplicatedEarlierBlock = [...currentFlow]
              .reverse()
              .find((block): block is Extract<TaskBlock, { type: "agent" }> =>
                block.turnId === turnId &&
                block.type === "agent" &&
                block.id !== latestBlock.id &&
                normalizeAgentContentForDedupe(block.content) === displayTextKey
              );

            if (duplicatedEarlierBlock) {
              sessionSet((s) => ({
                normalizedStreamState: {
                  ...s.normalizedStreamState,
                  visibleText: stateVisibleText || String(duplicatedEarlierBlock.content || ""),
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
                visibleText: stateVisibleText,
                replyOptions,
              },
            }));
            appendTurnBlock({
              id: nextId(),
              turnId,
              turnPhase: processPhase,
              type: "agent",
              content: displayText,
              ...(replyOptions.length > 0 ? { options: replyOptions } : {}),
              ...(isHiddenProcessText ? { hiddenProcess: true, visibility: "hidden_process" as const } : {}),
              ...(isSubstantivePlanText ? { visibility: "substantive_plan_text" as const } : {}),
              ...(isUserProgressText ? { visibility: "user_progress" as const } : {}),
              streaming: false,
            });
            markPendingOperationProposal();
            return;
          }

          sessionSet((s) => ({
            normalizedStreamState: {
              ...s.normalizedStreamState,
              visibleText: stateVisibleText,
              replyOptions,
            },
            conversationTurns: s.conversationTurns.map((turn) =>
              turn.id === turnId && !turn.blockIds.includes(latestBlock.id)
                ? { ...turn, blockIds: [...turn.blockIds, latestBlock.id] }
                : turn
            ),
            taskFlow: s.taskFlow.map((t) =>
              t.id === latestBlock.id && t.type === "agent"
                ? {
                    ...t,
                    turnPhase: normalizeTurnRuntimePhase(t.turnPhase || processPhase, phaseLanguage),
                    content: displayText,
                    ...(replyOptions.length > 0 ? { options: replyOptions } : { options: undefined }),
                    ...(isHiddenProcessText ? { hiddenProcess: true, visibility: "hidden_process" as const } : { hiddenProcess: undefined }),
                    ...(isSubstantivePlanText
                      ? { visibility: "substantive_plan_text" as const }
                      : isUserProgressText ? { visibility: "user_progress" as const } : { visibility: undefined }),
                    streaming: false,
                  }
                : t
            ),
          }));
          markPendingOperationProposal();
        },

        onToolExecuting: (toolName, target, diffPreview, meta?: ToolLifecycleMeta) => {
          closeUnderstandingProgress();
          let runningTaskId: number | null = null;
          let shouldAttachDiff = false;
          const normalizedToolCallId = String(meta?.toolCallId || "").trim() || undefined;
          const language = sessionGet().config.language === "en" ? "en" : "zh";
          const turnPhase = phaseForTool(toolName, target, "running");
          const flowBeforeTool = sessionGet().taskFlow;
          const userGoal = getTurnUserGoal(flowBeforeTool, turnId);
          const currentHypothesis = getLatestTurnProgressStrategyText(flowBeforeTool, turnId);
          const previousObservation = getLatestTurnToolObservationText(flowBeforeTool, turnId);
          const progress = buildToolProgressNarration({
            toolName,
            target,
            language,
            status: "running",
            source: "runtime",
            userGoal,
            currentHypothesis,
            previousObservation,
            turnIntent: effectiveRunIntent,
            workflowMode: sessionGet().config.workflowMode,
            sourceToolCallIds: normalizedToolCallId ? [normalizedToolCallId] : [],
          });
          const intentSummary = deriveToolIntentSummary({
            toolName,
            target,
            language,
            toolStatus: "running",
            userGoal,
            currentHypothesis,
            previousObservation,
          });
          const isEphemeralPlanArtifactTool =
            (toolName === "write_file" || toolName === "replace_in_file") &&
            isEphemeralPlanArtifactPath(target);
          emitProgressRuntimeEvent(progress, {
            tool: toolName,
            target,
            dedupeKey: `${progress.phase}:${toolName}:${target}`,
          });

          sessionSet((s) => {
            const pendingIdx = findToolLifecycleBlockIndex({
              taskFlow: s.taskFlow,
              turnId,
              toolName,
              target,
              allowedStatuses: ["pending", "running"],
              meta,
            });
            const nextFlow = [...s.taskFlow];
            let appendedBlockId: number | null = null;
            if (pendingIdx >= 0) {
              const pendingTask = nextFlow[pendingIdx];
              if (pendingTask?.type === "tool") {
                runningTaskId = pendingTask.id;
                shouldAttachDiff = !isEphemeralPlanArtifactTool && !pendingTask.diff && !!diffPreview;
                nextFlow[pendingIdx] = {
                  ...pendingTask,
                  toolStatus: "running",
                  status: "running",
                  ...(normalizedToolCallId ? { toolCallId: normalizedToolCallId } : {}),
                  turnPhase: pendingTask.turnPhase || turnPhase,
                  intentSummary: pendingTask.intentSummary || intentSummary,
                  why: pendingTask.why || progress.why,
                  evidence: pendingTask.evidence || progress.evidence,
                  message: progress.action,
                };
              }
            } else {
              appendedBlockId = nextId();
              runningTaskId = appendedBlockId;
              shouldAttachDiff = !isEphemeralPlanArtifactTool && !!diffPreview && supportsToolDiffPreview(toolName);
              nextFlow.push({
                id: appendedBlockId,
                turnId,
                type: "tool",
                turnPhase,
                toolName,
                target,
                status: "running",
                toolStatus: "running",
                ...(normalizedToolCallId ? { toolCallId: normalizedToolCallId } : {}),
                intentSummary,
                why: progress.why,
                evidence: progress.evidence,
                message: progress.action,
              });
            }
            const hasRelatedProgress = nextFlow.some((block) =>
              block.type === "progress" &&
              block.turnId === turnId &&
              progressBlockMatchesTool(block, normalizedToolCallId, toolName, target)
            );
            if (!hasRelatedProgress) {
              const progressBlockId = nextId();
              const progressBlock: TaskBlock = {
                id: progressBlockId,
                turnId,
                turnPhase,
                type: "progress",
                ...progress,
                ...(normalizedToolCallId ? { toolCallId: normalizedToolCallId, toolCallIds: [normalizedToolCallId] } : {}),
                toolName,
                target,
              };
              const runningIdx = nextFlow.findIndex((block) => block.id === runningTaskId);
              if (runningIdx >= 0) {
                nextFlow.splice(runningIdx, 0, progressBlock);
              } else {
                nextFlow.push(progressBlock);
              }
              appendedBlockId = appendedBlockId == null ? progressBlockId : appendedBlockId;
            }
            return {
              taskFlow: nextFlow,
              conversationTurns: appendedBlockId == null
                ? s.conversationTurns
                : s.conversationTurns.map((turn) =>
                    turn.id === turnId
                      ? {
                          ...turn,
                          blockIds: [
                            ...turn.blockIds,
                            ...nextFlow
                              .filter((block) => block.turnId === turnId && !turn.blockIds.includes(block.id))
                              .map((block) => block.id),
                          ],
                        }
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

          if (!isEphemeralPlanArtifactTool) {
            emitLocalPlanExecutionProgress("tool_start", {
              currentTool: `${toolName}${target ? ` ${target}` : ""}`,
              nextStep: sessionGet().config.language === "en"
                ? "wait for this tool result, then update evidence"
                : "等待该工具返回结果，然后更新执行证据",
            });
          }
        },

        onToolDone: (toolName, target, result, meta?: ToolLifecycleMeta) => {
          const language = sessionGet().config.language === "en" ? "en" : "zh";
          const isEphemeralPlanArtifactTool =
            (toolName === "write_file" || toolName === "replace_in_file") &&
            isEphemeralPlanArtifactPath(target);
          let completedProgressForEvent = null as ProgressNarration | null;
          sessionSet((s) => {
            const idx = findToolLifecycleBlockIndex({
              taskFlow: s.taskFlow,
              turnId,
              toolName,
              target,
              allowedStatuses: ["running"],
              meta,
            });
            if (idx === -1) return {};
            const updated = [...s.taskFlow];
            const previousBlock = updated[idx];
            const resultNoOp = /"noOp"\s*:\s*true/.test(result);
            const noOpWrite =
              toolName === "write_file" &&
              (
                resultNoOp ||
                (
                  previousBlock?.type === "tool" &&
                  !!previousBlock.diff &&
                  previousBlock.diff.old === previousBlock.diff.new
                )
              );
            const observationSummary = summarizeToolObservation({
              toolName,
              target,
              result,
              language,
              noOp: noOpWrite,
            });
            const doneProgress = buildToolProgressNarration({
              toolName,
              target,
              language,
              status: "done",
              source: "tool_result",
              userGoal: getTurnUserGoal(updated, turnId),
              currentHypothesis: getLatestTurnProgressStrategyText(updated, turnId),
              previousObservation: observationSummary,
              result,
              noOp: noOpWrite,
              turnIntent: effectiveRunIntent,
              workflowMode: sessionGet().config.workflowMode,
              sourceToolCallIds: meta?.toolCallId ? [String(meta.toolCallId)] : [],
            });
            completedProgressForEvent = doneProgress;
            updated[idx] = {
              ...updated[idx],
              turnPhase: withTurnRuntimePhaseStatus(
                (updated[idx] as Extract<TaskBlock, { type: "tool" }>).turnPhase || phaseForTool(toolName, target, "done"),
                "done",
                phaseLanguage,
              ),
              toolStatus: "executed" as const,
              status: "done" as const,
              ...(meta?.toolCallId ? { toolCallId: String(meta.toolCallId) } : {}),
              why: (updated[idx] as Extract<TaskBlock, { type: "tool" }>).why || doneProgress.why,
              evidence: doneProgress.evidence,
              observationSummary,
              message: noOpWrite
                ? "No file change: requested content matched the current file, so this did not advance plan evidence."
                : result.length > 500 ? result.slice(0, 500) + "..." : result,
            } as TaskBlock;
            const shouldRecordPlanEvidence =
              effectiveRunIntent === "plan" &&
              s.isPlanApproved &&
              isPlanEvidenceLedgerTool(toolName, target);
            const nextEvidenceLedger = shouldRecordPlanEvidence
              ? appendPlanEvidenceEntry(
                  s.planExecutionEvidenceLedger,
                  createPlanExecutionEvidenceEntry({ toolName, target, result, noOp: noOpWrite }),
                )
              : s.planExecutionEvidenceLedger;
            const evidenceChanged = nextEvidenceLedger !== s.planExecutionEvidenceLedger;
          const nextOperationEvidenceStatus: PendingOperationProposal["evidenceStatus"] =
              toolName === "run_command" ||
              toolName === "browser_evaluate" ||
              toolName === "execute_command" ||
              toolName === "send_pty_input" ||
              toolName === "read_pty_tail" ||
              toolName === "read_pty_since" ||
              toolName === "get_pty_status"
                ? "verified"
                : toolName === "write_file" ||
                  toolName === "replace_in_file" ||
                  toolName === "delete_workspace_path"
                ? "changed"
                : "tool_called";

            const nextTaskFlow = updateRelatedProgressBlocks({
              blocks: updated,
              turnId,
              toolName,
              target,
              toolCallId: meta?.toolCallId ? String(meta.toolCallId) : undefined,
              status: "done",
              source: "tool_result",
              evidence: observationSummary,
              next: doneProgress.next,
              evidenceExcerpt: doneProgress.evidenceExcerpt,
              observedFact: doneProgress.observedFact,
              hypothesisStatus: doneProgress.hypothesisStatus,
              sourceToolCallIds: doneProgress.sourceToolCallIds,
            });

            return {
              taskFlow: nextTaskFlow,
              conversationTurns: s.conversationTurns.map((turn) =>
                turn.id === turnId && turn.pendingOperationProposal
                  ? {
                      ...turn,
                      pendingOperationProposal: {
                        ...turn.pendingOperationProposal,
                        evidenceStatus:
                          turn.pendingOperationProposal.evidenceStatus === "verified"
                            ? "verified"
                            : nextOperationEvidenceStatus,
                      },
                    }
                  : turn,
              ),
              ...(evidenceChanged
                ? {
                    planExecutionEvidenceLedger: nextEvidenceLedger,
                    planExecutionEvidenceCount: nextEvidenceLedger.length,
                    planTasks: normalizePlanTaskStatuses(
                      s.planTasks,
                      nextEvidenceLedger,
                      true,
                    ),
                  }
                : {}),
            };
          });
          const completedProgressEventPayload = completedProgressForEvent;
          if (completedProgressEventPayload) {
            emitProgressRuntimeEvent(completedProgressEventPayload, {
              tool: toolName,
              target,
              dedupeKey: `${completedProgressEventPayload.phase}:${toolName}:${target}`,
            });
          }
          if (!isEphemeralPlanArtifactTool) {
            emitLocalPlanExecutionProgress("tool_done", {
              currentTool: `${toolName}${target ? ` ${target}` : ""}`,
              nextStep: sessionGet().config.language === "en"
                ? "continue with the next task whose evidence is not satisfied"
                : "继续下一个证据未满足的任务",
            });
          }
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

        onToolError: (toolName, target, error, meta?: ToolLifecycleMeta) => {
          const language = sessionGet().config.language === "en" ? "en" : "zh";
          let failedProgressForEvent = null as ProgressNarration | null;
          sessionSet((s) => {
            const idx = findToolLifecycleBlockIndex({
              taskFlow: s.taskFlow,
              turnId,
              toolName,
              target,
              allowedStatuses: ["running"],
              meta,
            });
            if (idx === -1) return {};
            const updated = [...s.taskFlow];
            const failedProgress = buildToolProgressNarration({
              toolName,
              target,
              language,
              status: "failed",
              source: "tool_result",
              userGoal: getTurnUserGoal(updated, turnId),
              currentHypothesis: getLatestTurnProgressStrategyText(updated, turnId),
              previousObservation: compactProgressContextText(error),
              result: error,
              turnIntent: effectiveRunIntent,
              workflowMode: sessionGet().config.workflowMode,
              sourceToolCallIds: meta?.toolCallId ? [String(meta.toolCallId)] : [],
            });
            failedProgressForEvent = failedProgress;
            const observationSummary = language === "en"
              ? `Tool failed: ${compactProgressContextText(error, 180)}`
              : `工具失败：${compactProgressContextText(error, 180)}`;
            updated[idx] = {
              ...updated[idx],
              turnPhase: withTurnRuntimePhaseStatus(
                (updated[idx] as Extract<TaskBlock, { type: "tool" }>).turnPhase || phaseForTool(toolName, target, "failed"),
                "failed",
                phaseLanguage,
              ),
              toolStatus: "failed" as const,
              status: "error" as const,
              ...(meta?.toolCallId ? { toolCallId: String(meta.toolCallId) } : {}),
              why: (updated[idx] as Extract<TaskBlock, { type: "tool" }>).why || failedProgress.why,
              evidence: failedProgress.evidence,
              observationSummary,
              ...(meta?.qualityGateReason ? { qualityGateReason: String(meta.qualityGateReason) } : {}),
              ...(meta?.planRecoveryReason ? { planRecoveryReason: String(meta.planRecoveryReason) } : {}),
              message: error,
            } as TaskBlock;
            const nextTaskFlow = updateRelatedProgressBlocks({
              blocks: updated,
              turnId,
              toolName,
              target,
              toolCallId: meta?.toolCallId ? String(meta.toolCallId) : undefined,
              status: "failed",
              source: "tool_result",
              evidence: observationSummary,
              next: failedProgress.next,
              evidenceExcerpt: failedProgress.evidenceExcerpt,
              observedFact: failedProgress.observedFact,
              hypothesisStatus: failedProgress.hypothesisStatus,
              sourceToolCallIds: failedProgress.sourceToolCallIds,
            });
            return {
              taskFlow: nextTaskFlow,
              conversationTurns: s.conversationTurns.map((turn) =>
                turn.id === turnId && turn.pendingOperationProposal
                  ? {
                      ...turn,
                      pendingOperationProposal: {
                        ...turn.pendingOperationProposal,
                        evidenceStatus: turn.pendingOperationProposal.evidenceStatus === "none"
                          ? "blocked"
                          : turn.pendingOperationProposal.evidenceStatus,
                      },
                    }
                  : turn,
              ),
            };
          });
          const failedProgressEventPayload = failedProgressForEvent;
          if (failedProgressEventPayload) {
            emitProgressRuntimeEvent(failedProgressEventPayload, {
              tool: toolName,
              target,
              dedupeKey: `${failedProgressEventPayload.phase}:${toolName}:${target}`,
            });
          }
          emitLocalPlanExecutionProgress("tool_error", {
            currentTool: `${toolName}${target ? ` ${target}` : ""}`,
            nextStep: sessionGet().config.language === "en"
              ? "recover from the tool error or pause with recovery details"
              : "根据工具错误修正下一步，必要时给出恢复信息",
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
          if (status === "idle" || status === "error") {
            const pausedByTerminalOverride =
              status === "idle" &&
              !abortCtrl.signal.aborted &&
              (
                terminalTurnStatusOverride === "stopped_no_action" ||
                terminalTurnStatusOverride === "stopped_no_output"
              );
            closeCurrentHarnessRunMarker(
              status === "error" ? "error" : abortCtrl.signal.aborted ? "idle" : pausedByTerminalOverride ? "paused" : "completed",
              status === "error"
                ? "agent_status_error"
                : abortCtrl.signal.aborted
                ? "aborted_by_user"
                : pausedByTerminalOverride
                ? "agent_status_idle_paused"
                : "agent_status_idle",
            );
          }
          const finalizeStaleRunningTools = (finalStatus: "executed" | "failed" | "rejected", message: string) => {
            sessionSet((s) => ({
              taskFlow: s.taskFlow.map((task) =>
                task.turnId === turnId && task.type === "tool" && task.toolStatus === "running"
                  ? {
                      ...task,
                      toolStatus: finalStatus,
                      status:
                        finalStatus === "executed"
                          ? "done"
                          : finalStatus === "rejected"
                          ? "stopped_no_action"
                          : "error",
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
            const isApprovedPlanExecution =
              effectiveRunIntent === "plan" &&
              state.isPlanApproved &&
              state.planStage === "executing";
            if (hasPlanContext) {
              logStoreEvent(isApprovedPlanExecution ? "tool_permission_review" : "plan_review", {
                turnId,
                effectiveRunIntent,
                planArtifacts: state.planArtifacts.length,
                planStage: state.planStage,
                isPlanApproved: state.isPlanApproved,
              });
              if (!isApprovedPlanExecution) {
                logStoreEvent("plan_review_prompt_shown", {
                  turnId,
                  effectiveRunIntent,
                  planArtifacts: state.planArtifacts.length,
                  planStage: state.planStage,
                });
                emitRunEvent({
                  type: "approval.requested",
                  threadId: runSessionKey,
                  turnId,
                  timestampMs: Date.now(),
                  reason: "plan_review",
                  target: state.planArtifacts[0]?.path || ".MAIN/plans/plan.md",
                });
                emitLocalPlanExecutionProgress("waiting_review", {
                  nextStep: state.config.language === "en"
                    ? "wait for approval of the pending tool call"
                    : "等待当前工具调用审批",
                });
              }
            }
          }
          if (status === "running") {
            const state = sessionGet();
            if (effectiveRunIntent === "plan" && state.isPlanApproved && state.planStage === "executing") {
              logStoreEvent("plan_execution_running", {
                turnId,
                effectiveRunIntent,
                planStage: state.planStage,
                planArtifacts: state.planArtifacts.length,
              });
            }
          }
          if (turnId) {
            const current = sessionGet();
            const isApprovedPlanExecution =
              effectiveRunIntent === "plan" &&
              current.isPlanApproved &&
              current.planStage === "executing";
            const nextTurnStatus: ConversationTurnStatus =
              status === "error"
                ? "error"
                : status === "idle"
                ? deriveIdleConversationTurnStatus({
                    turnId,
                    effectiveRunIntent,
                    isPlanApproved: current.isPlanApproved,
                    planArtifacts: current.planArtifacts,
                    planStage: current.planStage,
                    planTasks: current.planTasks,
                    planExecutionEvidenceCount: current.planExecutionEvidenceCount,
                    replyOptionCount: current.normalizedStreamState.replyOptions.length,
                    taskFlow: current.taskFlow,
                    override: terminalTurnStatusOverride,
                  })
                : status === "pending_review"
                ? isApprovedPlanExecution ? "executing" : "awaiting_approval"
                : effectiveRunIntent === "plan" &&
                  !current.isPlanApproved &&
                  (current.planArtifacts.length > 0 || current.planStage !== "idle")
                ? "planning"
                : "executing";
            sessionGet().setConversationTurnStatus(turnId, nextTurnStatus);
            if (uiDisplayTurnId !== turnId) {
              sessionGet().setConversationTurnStatus(uiDisplayTurnId, nextTurnStatus);
            }
          }
          if (
            status === "idle" &&
            effectiveRunIntent === "plan" &&
            sessionGet().isPlanApproved &&
            sessionGet().planStage === "completed"
          ) {
            logStoreEvent("plan_runtime_closed_after_completion", {
              turnId,
              sessionKey: runSessionKey,
              workspace: runWorkspace || null,
              planTasks: sessionGet().planTasks.length,
              evidenceCount: sessionGet().planExecutionEvidenceCount,
            });
            sessionSet({
              ...buildClosedActivePlanRuntimePatch(),
              currentTurnExecutionConsent: { turnId: null, granted: false },
            });
          }
          if (status === "idle" || status === "error") {
            clearNoFirstTokenNoticeTimer();
            finalizeStreamingUi();
            const abortedByUser = abortCtrl.signal.aborted;
            finalizeStaleRunningTools(
              abortedByUser ? "rejected" : "failed",
              abortedByUser
                ? "请求已停止，当前步骤未执行完成"
                : status === "idle"
                ? "请求已停止或未返回工具结果"
                : "请求已停止",
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
          emitLocalPlanExecutionProgress("context_compression", {
            nextStep: sessionGet().config.language === "en"
              ? "continue with compacted context and reread current files if needed"
              : "基于压缩后的上下文继续，必要时重新读取当前文件",
          });
        },

        onNonActionableStop: (message, reason, progress) => {
          terminalTurnStatusOverride = reason === "no_output"
            ? "stopped_no_output"
            : "stopped_no_action";
          const isApprovedExecutionPause =
            effectiveRunIntent === "plan" &&
            sessionGet().isPlanApproved &&
            sessionGet().planStage === "executing";
          logStoreEvent("non_actionable_stop", {
            turnId,
            reason,
            message,
            taskFlowBlocks: sessionGet().taskFlow.length,
            agentMessages: sessionGet().agentMessages.length,
          });
          if (isApprovedExecutionPause) {
            appendDebugLog("warn", "plan.non_actionable_stop", {
              turnId,
              uiDisplayTurnId,
              reason,
              message,
            });
            emitLocalPlanExecutionProgress("paused", {
              nextStep: sessionGet().config.language === "en"
                ? "resume from the current workspace state"
                : "基于当前 workspace 状态恢复执行",
              ...progress,
            });
          }
          const language = sessionGet().config.language === "en" ? "en" : "zh";
          const visibleMessage = isApprovedExecutionPause && message.trim()
            ? `${message.trim()}\n\n${language === "en" ? "MAIN kept the current workspace state; use Resume Execution to continue from here." : "MAIN 已保留当前 workspace 状态；可使用 Resume Execution 从这里继续。"}`
            : message;
          emitRunEvent({
            type: "run.paused",
            threadId: runSessionKey,
            turnId,
            timestampMs: Date.now(),
            reason,
            message: visibleMessage,
            progress: {
              phase: "blocked",
              title: language === "en" ? "Run paused" : "运行已暂停",
              status: "paused",
              summary: visibleMessage,
              next: progress?.nextStep || "",
              dedupeKey: `pause:${reason}`,
            },
          });
          const block: TaskBlock = {
            id: nextId(),
            turnId,
            type: "system",
            content: visibleMessage,
            ...(isApprovedExecutionPause ? { variant: "plan_execution_checkpoint" as const } : {}),
          };
          appendTurnBlock(block);
          sessionGet().setConversationTurnSummary(uiDisplayTurnId, summarizeAssistantText(visibleMessage));
        },

        onPlanArtifactUpdated: (path, content, kind) => {
          logStoreEvent("plan_artifact_updated", {
            turnId,
            path,
            kind,
            contentChars: content.length,
          });
          if (kind === "plan") {
            emitRunEvent({
              type: "plan.ready",
              threadId: runSessionKey,
              turnId,
              timestampMs: Date.now(),
              path,
              summary: summarizeAssistantText(content),
            });
          }
          const sanitized = sanitizePlanArtifactContent(content);
          const validation = validatePlanArtifactContent(sanitized, kind);
          if (!validation.ok) {
            logStoreEvent("plan_artifact_quality_blocked", {
              turnId,
              path,
              kind,
              reason: validation.reason,
            });
            const language = sessionGet().config.language === "en" ? "en" : "zh";
            const reason = validation.reason || (language === "en" ? "quality gate" : "质量门禁");
            const blockedMessage =
              kind === "tasks" && validation.reason === "missing_task_evidence"
                ? language === "en"
                  ? `Task list rejected: ${path} is missing verifiable evidence labels (${reason}). MAIN will ask the model to regenerate \`.MAIN/plans/tasks.md\` with unchecked tasks and evidence labels such as \`evidence: file:src/App.tsx\`, \`evidence: cmd:npm test\`, or \`evidence: deliverable:REPORT.md\`.`
                  : `任务清单已被拦截：${path} 缺少可验证 evidence 标签（${reason}）。MAIN 会要求模型重新生成真实的 \`.MAIN/plans/tasks.md\`，每项保持未完成 checkbox，并补充类似 \`证据: file:src/App.tsx\`、\`证据: cmd:npm test\` 或 \`证据: deliverable:REPORT.md\` 的证据标签。`
                : language === "en"
                ? `Plan artifact rejected: ${path} does not look like a reviewable ${kind} document (${reason}). MAIN will ask the model to regenerate a visible plan that can be materialized into \`.MAIN/plans/plan.md\`, or request your decision.`
                : `计划文件已被拦截：${path} 不像可审批的${getPlanArtifactTitle(kind, "zh")}（${reason}）。MAIN 会要求模型重新生成可见计划并物化为 \`.MAIN/plans/plan.md\`，或先向你确认关键分叉。`;
            appendTurnBlock({
              id: nextId(),
              turnId,
              type: "system",
              content: blockedMessage,
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
          if (!latest.isPlanApproved && latest.planStage !== "executing" && !(latest.showDiff && latest.rightPanelTab === "diff")) {
            latest.openRightPanelTab("plan");
          }
        },

        onPlanStageChanged: (stage) => {
          const current = sessionGet();
          const turnBlocks = current.taskFlow.filter((block) => block.turnId === turnId);
          const currentTurn = current.conversationTurns.find((turn) => turn.id === turnId);
          const requestedDocs = detectRequestedRootMarkdownDeliverables(currentTurn?.userPrompt || "");
          const taskAudit = buildPlanTaskEvidenceAudit({
            tasks: current.planTasks,
            evidenceLedger: current.planExecutionEvidenceLedger,
            highlightNext: current.isPlanApproved,
          });
          const canMarkPlanCompleted =
            stage === "completed" &&
            current.isPlanApproved &&
            current.planExecutionEvidenceCount > 0 &&
            taskAudit.allTrustedComplete &&
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

          if (current.planTasks.length > 0) {
            sessionSet({ planTasks: taskAudit.tasks });
          }
          sessionGet().setPlanStage(nextStage);
          if (nextStage !== "idle") {
            const latest = sessionGet();
            if (!latest.isPlanApproved && nextStage !== "executing" && !(latest.showDiff && latest.rightPanelTab === "diff")) {
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

        onPlanExecutionProgress: (progress: PlanExecutionProgressUpdate) => {
          writePlanExecutionProgress(progress);
        },

        onPlanMaxIterationsCheckpoint: (checkpoint: PlanMaxIterationsCheckpoint) => {
          const language = sessionGet().preferredResponseLanguage || sessionGet().config.language;
          const currentCount = Math.max(0, Number(sessionGet().planAutoResumeCount) || 0);
          const shouldAutoResume = currentCount < PLAN_MAX_AUTO_RESUME_LIMIT;
          const effectiveCheckpoint = {
            ...checkpoint,
            autoResumeCount: shouldAutoResume ? currentCount + 1 : currentCount,
          };
          const notice = shouldAutoResume
            ? buildPlanMaxIterationsAutoResumeNotice(effectiveCheckpoint, language)
            : buildPlanMaxIterationsPauseNotice(effectiveCheckpoint, language);
          appendDebugLog(shouldAutoResume ? "info" : "warn", shouldAutoResume ? "plan.max_iterations_auto_resume" : "plan.max_iterations_paused", {
            turnId,
            uiDisplayTurnId,
            checkpoint: effectiveCheckpoint,
            notice,
          });
          const progressSnapshot = normalizePlanExecutionProgressSnapshot({
            turnId,
            update: buildPlanExecutionProgressUpdate({
              language,
              phase: shouldAutoResume ? "auto_resume" : "paused",
              iterationCount: effectiveCheckpoint.iterationCount,
              maxIterations: effectiveCheckpoint.maxIterations,
              autoResumeCount: effectiveCheckpoint.autoResumeCount,
              tasks: sessionGet().planTasks,
              evidenceLedger: sessionGet().planExecutionEvidenceLedger,
              recentToolActivity: effectiveCheckpoint.recentToolActivity,
              latestEvidence: effectiveCheckpoint.completedEvidence[0],
              nextStep: shouldAutoResume
                ? language === "zh"
                  ? "自动开启一次隐藏续跑，先重新读取当前 workspace 状态"
                  : "start one hidden auto-resume and reread current workspace state first"
                : language === "zh"
                ? "点击 Resume Execution 后从检查点继续"
                : "click Resume Execution to continue from checkpoint",
            }),
            previous: sessionGet().planExecutionProgressSnapshot,
            now: Date.now(),
          });
          writePlanExecutionProgress(progressSnapshot);
          const visibleNotice = shouldAutoResume
            ? ""
            : language === "zh"
            ? "计划执行已暂停：已达到安全轮次边界。MAIN 已保留当前 workspace 状态；可使用 Resume Execution 从这里继续。"
            : "Plan execution paused after reaching the safety boundary. MAIN kept the current workspace state; use Resume Execution to continue from here.";

          sessionSet((s) => ({
            planAutoResumeCount: effectiveCheckpoint.autoResumeCount,
            planExecutionProgressSnapshot: progressSnapshot,
            planStage: s.planStage === "completed" ? "completed" : "executing",
            conversationTurns: s.conversationTurns.map((turn) =>
              turn.id === uiDisplayTurnId
                ? { ...turn, status: shouldAutoResume ? "executing" : "stopped_no_action", collapsed: shouldAutoResume ? turn.collapsed : false }
                : turn
            ),
          }));
          if (!shouldAutoResume) {
            appendTurnBlock({
              id: nextId(),
              turnId: uiDisplayTurnId,
              type: "system",
              content: visibleNotice,
              variant: "plan_execution_checkpoint",
            });
            sessionGet().setConversationTurnSummary(uiDisplayTurnId, summarizeAssistantText(visibleNotice));
          }

          if (!shouldAutoResume) {
            logStoreEvent("plan_max_iterations_paused", {
              turnId,
              sessionKey: runSessionKey,
              workspace: runWorkspace || null,
              autoResumeCount: currentCount,
              maxIterations: checkpoint.maxIterations,
            });
            return true;
          }

          logStoreEvent("plan_max_iterations_auto_resume", {
            turnId,
            sessionKey: runSessionKey,
            workspace: runWorkspace || null,
            autoResumeCount: effectiveCheckpoint.autoResumeCount,
            maxIterations: checkpoint.maxIterations,
          });

          runAfterNextPaint(() => {
            const latest = get();
            const latestSessionKey = resolveSessionRuntimeKey(
              resolveSessionWorkspaceKey(latest.currentWorkspace),
              latest.currentSessionId,
            );
            if (latestSessionKey !== runSessionKey) return;
            if (latest.isGenerating || latest.agentStatus === "running" || latest.agentStatus === "pending_review") return;
            if (!latest.isPlanApproved || latest.planStage !== "executing") return;

            const hasTasksArtifact =
              latest.planArtifacts.some((artifact) => artifact.kind === "tasks") ||
              latest.planTasks.length > 0;
            latest.sendMessage(
              buildPlanMaxIterationsResumePrompt({
                language,
                checkpoint: effectiveCheckpoint,
                hasTasksArtifact,
                tasks: latest.planTasks,
                artifacts: latest.planArtifacts,
                evidenceLedger: latest.planExecutionEvidenceLedger,
              }),
              undefined,
              {
                hidden: true,
                reuseCurrentTurn: false,
                uiParentTurnId: turnId,
                preservePlanState: true,
                resolvedIntent: "plan",
                skipIntentResolution: true,
                turnTitle: language === "zh" ? "计划执行自动恢复" : "Plan Execution Auto-Resume",
                intentSummary: language === "zh"
                  ? "计划执行达到安全轮次边界后自动恢复一次。"
                  : "Auto-resume once after the plan execution safety boundary.",
              },
            );
          });

          return true;
        },

        onExecuteMaxIterationsCheckpoint: (checkpoint: PlanMaxIterationsCheckpoint) => {
          terminalTurnStatusOverride = "stopped_no_action";
          const language = sessionGet().preferredResponseLanguage || sessionGet().config.language;
          const currentCount = Math.max(0, Number(sessionGet().planAutoResumeCount) || 0);
          const shouldAutoResume = currentCount < PLAN_MAX_AUTO_RESUME_LIMIT;
          const effectiveCheckpoint = {
            ...checkpoint,
            autoResumeCount: shouldAutoResume ? currentCount + 1 : currentCount,
          };
          const notice = shouldAutoResume
            ? buildExecuteMaxIterationsAutoResumeNotice(effectiveCheckpoint, language)
            : buildExecuteMaxIterationsPauseNotice(effectiveCheckpoint, language);
          appendDebugLog(shouldAutoResume ? "info" : "warn", shouldAutoResume ? "execute.max_iterations_auto_resume" : "execute.max_iterations_paused", {
            turnId,
            uiDisplayTurnId,
            checkpoint: effectiveCheckpoint,
            notice,
          });
          const visibleNotice = shouldAutoResume
            ? ""
            : language === "zh"
            ? "执行已暂停：本轮达到安全边界。MAIN 已保留当前 workspace 状态；可继续执行以从这里恢复。"
            : "Execution paused after reaching the safety boundary. MAIN kept the current workspace state; continue execution to resume from here.";

          sessionSet((s) => ({
            planAutoResumeCount: effectiveCheckpoint.autoResumeCount,
            conversationTurns: s.conversationTurns.map((turn) =>
              turn.id === uiDisplayTurnId
                ? { ...turn, status: shouldAutoResume ? "executing" : "stopped_no_action", collapsed: shouldAutoResume ? turn.collapsed : false }
                : turn
            ),
          }));
          if (!shouldAutoResume) {
            appendTurnBlock({
              id: nextId(),
              turnId: uiDisplayTurnId,
              type: "system",
              content: visibleNotice,
              variant: "execution_checkpoint",
            });
            sessionGet().setConversationTurnSummary(uiDisplayTurnId, summarizeAssistantText(visibleNotice));
          }

          if (!shouldAutoResume) {
            logStoreEvent("execute_max_iterations_paused", {
              turnId,
              sessionKey: runSessionKey,
              workspace: runWorkspace || null,
              autoResumeCount: currentCount,
              maxIterations: checkpoint.maxIterations,
            });
            return true;
          }

          logStoreEvent("execute_max_iterations_auto_resume", {
            turnId,
            sessionKey: runSessionKey,
            workspace: runWorkspace || null,
            autoResumeCount: effectiveCheckpoint.autoResumeCount,
            maxIterations: checkpoint.maxIterations,
          });

          runAfterNextPaint(() => {
            const latest = get();
            const latestSessionKey = resolveSessionRuntimeKey(
              resolveSessionWorkspaceKey(latest.currentWorkspace),
              latest.currentSessionId,
            );
            if (latestSessionKey !== runSessionKey) return;
            if (latest.isGenerating || latest.agentStatus === "running" || latest.agentStatus === "pending_review") return;

            latest.sendMessage(
              buildExecuteMaxIterationsResumePrompt({
                language,
                checkpoint: effectiveCheckpoint,
              }),
              undefined,
              {
                hidden: true,
                reuseCurrentTurn: false,
                uiParentTurnId: turnId,
                // Keep the recovery counter across the hidden Execute resume.
                // The visible Execute request already reset any stale plan state.
                preservePlanState: true,
                resolvedIntent: "execute",
                runtimeIntentOverride: "execute",
                forceExecuteRecoveryMode: "action_plus_targeting",
                executionConsentGranted: true,
                skipIntentResolution: true,
                turnTitle: language === "zh" ? "执行自动恢复" : "Execution Auto-Resume",
                intentSummary: language === "zh"
                  ? "执行达到安全轮次边界后自动恢复一次。"
                  : "Auto-resume once after the execution safety boundary.",
              },
            );
          });

          return true;
        },

        onTurnSummaryReady: (summary) => {
          if (!summary.trim()) return;
          const summarized = summarizeAssistantText(summary);
          if (looksLikeReasoningLeakTitle(summarized)) return;
          sessionGet().setConversationTurnSummary(turnId, summarized);
        },

        onExecutionDigestUpdate: (summary) => {
          if (!summary.trim()) return;
          const summarized = summarizeAssistantText(summary);
          if (looksLikeReasoningLeakTitle(summarized)) return;
          sessionGet().setConversationTurnSummary(turnId, summarized);
        },

        onTurnRuntimePhaseChanged: (phase) => {
          const normalized = setCurrentTurnRuntimePhase(normalizeTurnRuntimePhase(phase, phaseLanguage));
          appendPlanRuntimePhaseProgress(normalized);
        },

        onTurnEvent: (event) => {
          const mode = normalizeEventStreamMode(sessionGet().config.eventStreamMode);
          if (mode === "legacy") return;
          sessionSet((s) => ({
            runtimeEvents: appendRuntimeEvent(s.runtimeEvents, event),
          }));
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

        onContextMemoryBuilt: (state, packet) => {
          logStoreEvent("context_memory_built", {
            turnId,
            sessionKey: runSessionKey,
            workspace: runWorkspace || null,
            memoryId: state.id,
            packetChars: packet.length,
            goals: state.goals.length,
            evidence: state.evidence.length,
            files: state.files.length,
          });
          const laneKey = resolveRuntimeLaneKey(sessionGet().config);
          sessionSet((s) => ({
            contextMemoryState: state,
            contextMemoryStateByRuntimeKey: upsertContextMemoryStateForRuntimeLane(
              s.contextMemoryStateByRuntimeKey,
              laneKey,
              state,
            ),
          }));
        },

        onContextCompress: (stats, reason) => {
          const saved = Math.max(0, Math.round(stats.tokenReduction));
          const before = Math.max(0, Math.round(stats.tokenCountBefore));
          const after = Math.max(0, Math.round(stats.tokenCountAfter));
          const droppedMessageCount = Math.max(0, Math.round(stats.droppedMessageCount ?? stats.droppedCount));
          const microCompactedCount = Math.max(0, Math.round(stats.microCompactedCount || 0));
          const topTokenSource = stats.tokenBreakdown
            ? {
                label: String(stats.tokenBreakdown.topSourceLabel || ""),
                tokens: Math.max(0, Math.round(stats.tokenBreakdown.topSourceTokens || 0)),
                total: Math.max(0, Math.round(stats.tokenBreakdown.total || 0)),
              }
            : undefined;
          const topSourceSuffix = topTokenSource?.label && topTokenSource.tokens > 0
            ? `，最大来源：${topTokenSource.label} ${topTokenSource.tokens.toLocaleString()} tokens`
            : "";
          const label = reason === "reactive"
            ? `上下文溢出，已压缩背景，约 ${before.toLocaleString()} → ${after.toLocaleString()} tokens（释放 ${saved.toLocaleString()}）`
            : droppedMessageCount === 0 && microCompactedCount > 0
              ? `长工具结果已摘要化，约 ${before.toLocaleString()} → ${after.toLocaleString()} tokens（释放 ${saved.toLocaleString()}，保留路径、窗口和证据片段${topSourceSuffix}）`
              : `历史上下文已压缩，约 ${before.toLocaleString()} → ${after.toLocaleString()} tokens（释放 ${saved.toLocaleString()}，保留任务记忆）`;
          logStoreEvent("context_compressed", {
            turnId,
            reason,
            before,
            after,
            saved,
            droppedCount: Math.max(0, Math.round(stats.droppedCount)),
            droppedMessageCount,
            microCompactionKind: stats.microCompactionKind || "none",
            microCompactedCount,
            topTokenSource: topTokenSource?.label || null,
            topTokenSourceTokens: topTokenSource?.tokens ?? null,
          });
          const block: TaskBlock = {
            id: nextId(),
            turnId,
            type: "system",
            content: label,
            variant: "context_compression",
            contextCompression: {
              reason,
              droppedCount: Math.max(0, Math.round(stats.droppedCount)),
              droppedMessageCount,
              tokenCountBefore: before,
              tokenCountAfter: after,
              tokenReduction: saved,
              compressedContext: trimPersistedContextCompression(stats.compressedContext),
              displaySummary: trimPersistedContextCompression(stats.displaySummary),
              memoryPacket: trimPersistedContextCompression(stats.memoryPacket),
              microCompactionKind: stats.microCompactionKind || "none",
              microCompactedCount,
              ...(topTokenSource ? { topTokenSource } : {}),
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
         * If session auto-approve scopes include this tool class
         * (workspace_write/shell), auto-executes without creating
         * a pending card, resolving immediately as "accept".
         */
        requestReview: async (toolCall) => {
          const toolTarget = getToolTarget(toolCall.name, toolCall.arguments);
          const isLocalFileReadApproval =
            toolCall.risk === "local_file_read" && !!toolCall.localFileReadPath;
          const language = sessionGet().config.language === "en" ? "en" : "zh";
          let shellPermissionDecision: ShellPermissionDecision | null = null;
          let sessionShellPermissionApproval: ShellPermissionApproval | undefined;
          if (isShellReviewTool(toolCall.name)) {
            try {
              const rawCommand = typeof toolCall.arguments.command === "string" ? toolCall.arguments.command : "";
              const effectiveCommand = applyShellCwd(rawCommand, toolCall.arguments);
              shellPermissionDecision = await shellPermissionPreflight(effectiveCommand, runWorkspace || undefined);
            } catch (error) {
              const detail = error instanceof Error ? error.message : String(error);
              return {
                action: "error",
                error: language === "zh"
                  ? `Shell 权限预检失败：${detail}`
                  : `Shell permission preflight failed: ${detail}`,
              };
            }

            if (shellPermissionDecision.decision === "deny") {
              return {
                action: "error",
                error: formatShellPermissionDecisionForUser(shellPermissionDecision, language),
              };
            }

            if (isShellDecisionCoveredBySessionRules(shellPermissionDecision, sessionGet().approvedShellPermissionRules)) {
              sessionShellPermissionApproval = buildShellPermissionApproval(shellPermissionDecision, "session");
            }
          }
          const shellRequiresApproval = shellPermissionDecision?.requiresApproval === true;
          const shellReviewMessage = shellRequiresApproval && shellPermissionDecision
            ? formatShellPermissionDecisionForUser(shellPermissionDecision, language)
            : undefined;
          const autoApproveScopes = normalizeSessionAutoApproveScopes(sessionGet().autoApproveToolScopes);
          // ── Auto-approve path ──
          // External local file reads always require first-use approval, even
          // when the session-wide command auto-approval toggle is enabled.
          if (sessionShellPermissionApproval) {
            return { action: "accept", shellPermissionApproval: sessionShellPermissionApproval };
          }
          if (
            !isLocalFileReadApproval &&
            !shellRequiresApproval &&
            shouldSessionAutoApproveToolCall(toolCall, autoApproveScopes)
          ) {
            return { action: "accept" };
          }
          const isEphemeralPlanArtifactTool =
            (toolCall.name === "write_file" || toolCall.name === "replace_in_file") &&
            isEphemeralPlanArtifactPath(toolTarget);
          if (isEphemeralPlanArtifactTool) {
            return { action: "accept" };
          }

          const latestState = sessionGet();
          const isRemoteFeishuTurn = !!remoteFeishu;
          const latestIntent = latestState.getCurrentRunIntent();
          const latestRuntimeIntent = runtimeRunIntent;
          const alreadyApprovedForTurn =
            latestState.currentTurnExecutionConsent.granted &&
            latestState.currentTurnExecutionConsent.turnId === turnId;
          const planExecutionAlreadyApproved =
            latestIntent === "plan" && latestState.isPlanApproved;

          if (
            !isRemoteFeishuTurn &&
            (latestRuntimeIntent === "execute" || latestRuntimeIntent === "studio_workflow") &&
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

              const latestScopes = normalizeSessionAutoApproveScopes(sessionGet().autoApproveToolScopes);
              const latestShellApproval =
                shellPermissionDecision &&
                isShellDecisionCoveredBySessionRules(shellPermissionDecision, sessionGet().approvedShellPermissionRules)
                  ? buildShellPermissionApproval(shellPermissionDecision, "session")
                  : sessionShellPermissionApproval;
              if (latestShellApproval) {
                return { action: "accept", shellPermissionApproval: latestShellApproval } as ReviewDecision;
              }
              if (
                !isLocalFileReadApproval &&
                !shellRequiresApproval &&
                shouldSessionAutoApproveToolCall(toolCall, latestScopes)
              ) {
                return { action: "accept" } as ReviewDecision;
              }

              return new Promise<ReviewDecision>((resolve) => {
                const reviewTaskId = nextId();
                const toolName = toolCall.name;
                const toolArgs = toolCall.arguments;
                const target = getToolTarget(toolName, toolArgs);
                const flowBeforeReview = sessionGet().taskFlow;
                const userGoal = getTurnUserGoal(flowBeforeReview, uiDisplayTurnId);
                const currentHypothesis = getLatestTurnProgressStrategyText(flowBeforeReview, uiDisplayTurnId);
                const previousObservation = getLatestTurnToolObservationText(flowBeforeReview, uiDisplayTurnId);
                const progress = buildToolProgressNarration({
                  toolName,
                  target,
                  language,
                  status: "running",
                  source: "runtime",
                  userGoal,
                  currentHypothesis,
                  previousObservation,
                  turnIntent: effectiveRunIntent,
                  workflowMode: sessionGet().config.workflowMode,
                });
                const intentSummary = deriveToolIntentSummary({
                  toolName,
                  target,
                  language,
                  toolStatus: "pending",
                  userGoal,
                  currentHypothesis,
                  previousObservation,
                });
                const turnPhase = phaseForTool(toolName, target, "running");
                void (async () => {
                  const diff = isLocalFileReadApproval
                    ? undefined
                    : await buildToolDiffPreview(toolName, toolArgs, {
                        workspace: runWorkspace,
                        sessionKey: runSessionKey,
                      });
                  const block: TaskBlock = {
                    id: reviewTaskId,
                    turnId: uiDisplayTurnId,
                    turnPhase,
                    type: "tool",
                    toolName,
                    target,
                    status: "pending_review",
                    toolStatus: "pending",
                    intentSummary,
                    why: progress.why,
                    evidence: progress.evidence,
                    ...(shellReviewMessage ? { message: shellReviewMessage } : {}),
                    ...(shellPermissionDecision ? { shellPermissionDecision } : {}),
                    ...(diff ? { diff } : {}),
                  };

                  sessionSet((s) => ({
                    taskFlow: [...s.taskFlow, attachRuntimePhase(block, turnPhase)],
                    conversationTurns: s.conversationTurns.map((turn) =>
                      turn.id === uiDisplayTurnId && !turn.blockIds.includes(block.id)
                        ? { ...turn, blockIds: [...turn.blockIds, block.id] }
                        : turn
                    ),
                    selectedDiffTaskId: diff ? reviewTaskId : s.selectedDiffTaskId,
                    pendingReviewResolve: resolve,
                    pendingReviewTaskId: reviewTaskId,
                    pendingToolCall: {
                      name: toolName,
                      arguments: toolArgs,
                      ...(isLocalFileReadApproval ? { localFileReadPath: toolCall.localFileReadPath } : {}),
                      ...(shellPermissionDecision ? { shellPermissionDecision } : {}),
                    },
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
            const flowBeforeReview = sessionGet().taskFlow;
            const userGoal = getTurnUserGoal(flowBeforeReview, uiDisplayTurnId);
            const currentHypothesis = getLatestTurnProgressStrategyText(flowBeforeReview, uiDisplayTurnId);
            const previousObservation = getLatestTurnToolObservationText(flowBeforeReview, uiDisplayTurnId);
            const progress = buildToolProgressNarration({
              toolName,
              target,
              language,
              status: "running",
              source: "runtime",
              userGoal,
              currentHypothesis,
              previousObservation,
              turnIntent: effectiveRunIntent,
              workflowMode: sessionGet().config.workflowMode,
            });
            const intentSummary = deriveToolIntentSummary({
              toolName,
              target,
              language,
              toolStatus: "pending",
              userGoal,
              currentHypothesis,
              previousObservation,
            });
            const turnPhase = phaseForTool(toolName, target, "running");
            void (async () => {
              const diff = isLocalFileReadApproval
                ? undefined
                : await buildToolDiffPreview(toolName, toolArgs, {
                    workspace: runWorkspace,
                    sessionKey: runSessionKey,
                  });
              const block: TaskBlock = {
                id: reviewTaskId,
                turnId: uiDisplayTurnId,
                turnPhase,
                type: "tool",
                toolName,
                target,
                status: "pending_review",
                toolStatus: "pending",
                intentSummary,
                why: progress.why,
                evidence: progress.evidence,
                ...(shellReviewMessage ? { message: shellReviewMessage } : {}),
                ...(shellPermissionDecision ? { shellPermissionDecision } : {}),
                ...(diff ? { diff } : {}),
              };

              sessionSet((s) => ({
                taskFlow: [...s.taskFlow, attachRuntimePhase(block, turnPhase)],
                conversationTurns: s.conversationTurns.map((turn) =>
                  turn.id === uiDisplayTurnId && !turn.blockIds.includes(block.id)
                    ? { ...turn, blockIds: [...turn.blockIds, block.id] }
                    : turn
                ),
                selectedDiffTaskId: diff ? reviewTaskId : s.selectedDiffTaskId,
                pendingReviewResolve: resolve,
                pendingReviewTaskId: reviewTaskId,
                pendingToolCall: {
                  name: toolName,
                  arguments: toolArgs,
                  ...(isLocalFileReadApproval ? { localFileReadPath: toolCall.localFileReadPath } : {}),
                  ...(shellPermissionDecision ? { shellPermissionDecision } : {}),
                },
              }));
              if (remoteFeishu) {
                const code = createFeishuApprovalCode();
                const approvalId = createFeishuApprovalId();
                const nonce = createFeishuApprovalNonce();
                const createdAt = Date.now();
                const expiresAt = createdAt + FEISHU_APPROVAL_TTL_MS;
                const language = sessionGet().config.language === "en" ? "en" : "zh";
                const approval: FeishuPendingApproval = {
                  code,
                  approvalId,
                  nonce,
                  taskId: reviewTaskId,
                  chatId: remoteFeishu.chatId,
                  userId: remoteFeishu.userId,
                  messageId: remoteFeishu.messageId,
                  cardMessageId: undefined,
                  toolName,
                  target,
                  workspace: runWorkspace || sessionGet().currentWorkspace,
                  preview: buildFeishuToolPreview(toolName, toolArgs),
                  createdAt,
                  expiresAt,
                  status: "pending",
                };
                sessionGet().addPendingFeishuApproval(approval);
                const card = buildFeishuApprovalCard({
                  language,
                  approvalId,
                  nonce,
                  code,
                  toolName,
                  target,
                  workspace: approval.workspace,
                  preview: approval.preview,
                  requestedAt: createdAt,
                  expiresAt,
                  status: "pending",
                });
                void invoke("send_feishu_card", {
                  chatId: remoteFeishu.chatId,
                  userId: remoteFeishu.userId,
                  openId: remoteFeishu.userId,
                  messageId: remoteFeishu.messageId,
                  approvalId,
                  card,
                }).catch((error) => {
                  logStoreEvent("feishu_approval_send_failed", {
                    error: error instanceof Error ? error.message : String(error),
                    toolName,
                    target,
                  });
                  void invoke("send_feishu_message", {
                    chatId: remoteFeishu.chatId,
                    userId: remoteFeishu.userId,
                    openId: remoteFeishu.userId,
                    messageId: remoteFeishu.messageId,
                    text: buildFeishuApprovalMessage(language, code, toolName, target),
                  }).catch(() => {});
                });
              }
            })();
          });
        },
      };

      // Fire and forget — the loop manages its own lifecycle
      executeAgentLoop(callbacks, abortCtrl).then(() => {
        closeCurrentHarnessRunMarker("completed", "agent_loop_resolved");
        clearInterval(timerInterval);
        sessionSet({ pendingSlashCommand: null, elapsedTime: getElapsedSeconds() });

        let latestState = sessionGet();
        if (!latestState.config.debugRecordFullTurnProcess) {
          const completedTurn = latestState.conversationTurns.find((turn) => turn.id === turnId);
          const completedTurnSummary = String(completedTurn?.summary || "").trim();
          if (completedTurnSummary) {
            const compactedMessages = compactCompletedTurnAgentMessages({
              agentMessages: latestState.agentMessages,
              turnStartIndex: turnAgentMessagesStart,
              turnSummary: completedTurnSummary,
              turnBlocks: latestState.taskFlow.filter((block) => block.turnId === turnId),
              language: (latestState.preferredResponseLanguage || latestState.config.language) === "en" ? "en" : "zh",
            });
            if (compactedMessages !== latestState.agentMessages) {
              sessionSet({ agentMessages: compactedMessages });
              latestState = sessionGet();
            }
          }
        }

        // Save session messages (sanitized for serialization safety)
        const s = latestState;
          if (runSessionId) {
            const messages = sanitizeTaskBlocksForPersist(s.taskFlow);
            s.updateSession(runScopeKey, runSessionId, {
            messages,
            storageStatus: s.config.sessionRecordingEnabled ? "ok" : "temporary",
            recordingDisabled: !s.config.sessionRecordingEnabled,
            runtimeSnapshot: normalizeSessionRuntimeSnapshot({
              runtimeEventSchemaVersion: 1,
              runtimeEvents: s.runtimeEvents,
              harnessRunMarker: s.harnessRunMarker,
              taskFlow: messages,
              agentMessages: sanitizeAgentMessagesForPersist(s.agentMessages),
              contextMemoryState: s.contextMemoryState,
              contextMemoryStateByRuntimeKey: s.contextMemoryStateByRuntimeKey,
              providerCompatibilityByRuntimeKey: s.providerCompatibilityByRuntimeKey,
              conversationTurns: s.conversationTurns,
              currentTurnId: s.currentTurnId,
              selectedMainModeKey: s.selectedMainModeKey,
              selectedNexusModeKey: s.selectedNexusModeKey,
              activeStudioAgentKey: s.activeStudioAgentKey,
              gameStudioInitialized: s.gameStudioInitialized,
              pendingSlashCommand: s.pendingSlashCommand,
              planArtifacts: s.planArtifacts,
              planTasks: s.planTasks,
              planExecutionEvidenceLedger: s.planExecutionEvidenceLedger,
              planExecutionEvidenceCount: s.planExecutionEvidenceCount,
              planAutoResumeCount: s.planAutoResumeCount,
              planExecutionProgressSnapshot: s.planExecutionProgressSnapshot,
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
          const handoff = approvedPlanHandoff;
          if (handoff) {
            approvedPlanHandoff = null;
            runAfterNextPaint(() => {
              const latest = get();
              const latestSessionKey = resolveSessionRuntimeKey(
                resolveSessionWorkspaceKey(latest.currentWorkspace),
                latest.currentSessionId,
              );
              if (latestSessionKey !== runSessionKey) {
                logStoreEvent("plan_approval_handoff_skipped", {
                  reason: "session_changed",
                  planTurnId: handoff.parentPlanTurnId,
                  executionTurnId: handoff.executionTurnId,
                  expectedSessionKey: runSessionKey,
                  latestSessionKey,
                });
                return;
              }
              if (latest.isGenerating || latest.agentStatus === "running" || latest.agentStatus === "pending_review") {
                logStoreEvent("plan_approval_handoff_skipped", {
                  reason: "agent_busy",
                  planTurnId: handoff.parentPlanTurnId,
                  executionTurnId: handoff.executionTurnId,
                  agentStatus: latest.agentStatus,
                });
                return;
              }
              latest.updateConversationTurn(handoff.parentPlanTurnId, {
                status: "done",
                summary: latest.config.language === "en"
                  ? "Plan approved; execution was handed off to a new turn."
                  : "计划已批准，执行已交接到新的回合。",
              });
              logStoreEvent("plan_approval_handoff_starting_execution_turn", {
                planTurnId: handoff.parentPlanTurnId,
                executionTurnId: handoff.executionTurnId,
                sessionKey: runSessionKey,
                workspace: runWorkspace || null,
              });
              latest.sendMessage(handoff.prompt, undefined, {
                hidden: true,
                createVisibleTurnForHiddenMessage: true,
                reuseCurrentTurn: false,
                turnIdOverride: handoff.executionTurnId,
                parentPlanTurnId: handoff.parentPlanTurnId,
                preservePlanState: true,
                resolvedIntent: "plan",
                runtimeIntentOverride: "execute",
                executionConsentGranted: true,
                skipIntentResolution: true,
                turnTitle: handoff.title,
                intentSummary: handoff.intentSummary,
              });
            });
          }
        }).catch((err) => {
        closeCurrentHarnessRunMarker("error", "agent_loop_crashed");
        clearInterval(timerInterval);
        sessionSet({ pendingSlashCommand: null, elapsedTime: getElapsedSeconds() });
        logStoreEvent("agent_loop_crashed", {
          turnId,
          error: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack?.slice(0, 1200) : null,
        });
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
          cloudExperimentalLoginEnabled: (persistedConfig as any).cloudExperimentalLoginEnabled === true,
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
    const cloudExperimentalLoginEnabled = isCloud && params.config.cloudExperimentalLoginEnabled === true;
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
        ? ensureOpenAiChatGptCodexRequestBody({
            model,
            ...(extractOpenAiResponsesInstructions(msgs as Array<{ role: "system" | "user"; content: string }>) ? {
              instructions: extractOpenAiResponsesInstructions(msgs as Array<{ role: "system" | "user"; content: string }>),
            } : {}),
            input: buildOpenAiResponsesInputCandidates(msgs as Array<{ role: "system" | "user"; content: string }>)[0].input,
            ...buildOpenAiResponsesRequestExtras({
              disableResponseStorage: params.config.cloud.disableResponseStorage,
              reasoningEffort: "none",
            }),
          }, { userPromptId: "main-turn-metadata" })
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

function createFeishuApprovalCode(): string {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

function stringifyFeishuPreviewValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value == null) return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function buildFeishuToolPreview(toolName: string, args: Record<string, unknown>): string {
  if (toolName === "browser_evaluate") {
    return [
      `url: ${stringifyFeishuPreviewValue(args.url)}`,
      args.actions ? `actions:\n${stringifyFeishuPreviewValue(args.actions)}` : "",
      args.checks ? `checks:\n${stringifyFeishuPreviewValue(args.checks)}` : "",
    ].filter(Boolean).join("\n\n");
  }
  if (toolName === "run_command" || toolName === "execute_command") {
    return stringifyFeishuPreviewValue(args.command);
  }
  if (toolName === "send_pty_input") {
    return stringifyFeishuPreviewValue(args.input);
  }
  if (toolName === "write_file") {
    return [
      `path: ${stringifyFeishuPreviewValue(args.path)}`,
      "",
      stringifyFeishuPreviewValue(args.content),
    ].join("\n");
  }
  if (toolName === "replace_in_file") {
    return [
      `path: ${stringifyFeishuPreviewValue(args.path)}`,
      "",
      "old:",
      stringifyFeishuPreviewValue(args.oldText ?? args.old_text),
      "",
      "new:",
      stringifyFeishuPreviewValue(args.newText ?? args.new_text),
    ].join("\n");
  }
  const serialized = stringifyFeishuPreviewValue(args);
  return serialized && serialized !== "{}" ? serialized : getToolTarget(toolName, args);
}

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
    case "browser_evaluate": return (args.url as string) || "";
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
