// store/useAppStore.ts
// Zustand global state for Local Agent IDE
// All state that was previously scattered as useState in the monolith lives here.
import { create, type StateCreator } from "zustand";
import { persist } from "zustand/middleware";
import { type AgentMessage, type ReviewDecision, type ContentPart } from "../lib/orchestrator";
import type {
  ExecuteRecoveryMode,
  ForcedExecuteRecoveryRuntimeState,
} from "../lib/executeRecoveryTools";
import type { SessionAutoApproveScope } from "../lib/runtimeTools";
import {
  analyzeTabularDocument,
  cancelImageStudioJob,
  clearProjectSessions,
  deleteChatTempPath,
  deletePlanFiles,
  deleteWorkspacePath,
  ingestAttachmentFile,
  listDirectory,
  loadProjectSessionMeta,
  readChatTempFile,
  readDocument,
  readFile,
  readFileWindow,
  saveProjectSession,
  writeChatTempFile,
  writeFile,
  writeFileAtomic,
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
  acquireHarnessRunMarker,
  consumePendingUncleanRestartDiagnostic,
  closeHarnessRunMarkerForSessionDeletion,
  getHarnessActionRunId,
  getCurrentHarnessInstanceId,
  normalizeHarnessRunMarker,
  persistHarnessRunMarkerIfOwned,
  readHarnessRunMarker,
  settleHarnessRunMarkerIfOwned,
  type HarnessRunMarker,
} from "../lib/harnessCrashTelemetry";
import { normalizeContextMemoryState, type ContextMemoryState } from "../lib/contextMemory";
import { setMcpToolServerMap, type MCPServer, type MCPTool } from "../lib/mcpClient";
import { sanitizePlanArtifactContent } from "../lib/sanitize";
import { stripVisualObservationProtocolComments } from "../lib/sanitize";
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
  isConversationTurnRuntimeClosed,
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
  isRunTerminalEvent,
  isTerminalTurnEvent,
  normalizeEventStreamMode,
  normalizePersistedMainThreadEvent,
  normalizeToolFeedbackFormat,
  withEventSchema,
  type MainThreadEvent,
  type MainThreadEventInput,
  type LegacyFailedMainThreadEvent,
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
  buildPlanExecutionInstructionHash,
  isPlanApprovalIdentityCurrent,
} from "../lib/planApprovalIdentity";
import {
  PLAN_LIFECYCLE_SCHEMA_VERSION,
  applyPlanArtifactIdentity,
  applyPlanLifecyclePause,
  applyPlanReviewIdentity,
  createPlanLifecycleState,
  createPlanLifecycleSessionEpoch,
  ensurePlanLifecycleOwner,
  isPlanApprovalLeaseBoundToState,
  isPlanLifecycleExecutionAuthorized,
  migrateLegacyPlanLifecycle,
  reducePlanLifecycle,
  type PlanApprovalLease,
  type PlanArtifactIdentity,
  type PlanExecutionLease,
  type PlanLifecycleState,
  type PlanReviewIdentity,
} from "../lib/planLifecycle";
import {
  buildPlanExecutionProgressUpdate,
  isPlanReviewExecutionLeaseActive,
  normalizePlanExecutionProgressSnapshot,
  resolveRestoredPlanExecutionTaskIdentity,
  resolveApprovedPlanInitialExecutionRecovery,
  resolveApprovedPlanSameTurnFallbackDecision,
} from "../lib/planExecutionRecovery";
import {
  claimPlanExecutionDispatch,
  releasePlanExecutionDispatch,
} from "../lib/planExecutionDispatchClaim";
import {
  type AttachedFile,
  normalizeAttachedFile,
} from "../lib/attachments";
import {
  buildSemanticMetadataContextLines,
  normalizeTurnInputContextSignals,
  type SubagentDelegationPreference,
  type TurnInputContextSignals,
} from "../lib/turnIntake";
import {
  buildCanonicalCompletedTurnMessages,
  compactPlanReviewTurnMessages,
  findCanonicalTurnStartMessageIndex,
} from "../lib/turnContext";
import { serializeDurableTurnContextForModel } from "../lib/durableTurnContext";
import { buildGoalSourceContextSnapshot } from "../lib/goalSourceContext";
import {
  buildAcceptedGoalContinuationState,
  resolveGoalResumeTurnBoundary,
} from "../lib/goalResumeBoundary";
import { resolveGoalEventOwnerIdentity } from "../lib/goalEventIdentity";
import {
  buildPendingPlanToolPermissionInvalidation,
  buildPlanReviewActionRequest,
  clearGoalConfirmationActionRequest,
  isCurrentGoalAdministrativeControl,
  isCurrentGoalControlResolution,
  isExactToolPermissionResolutionIdentity,
  isToolPermissionPlanExecutionIdentityCurrent,
  isToolPermissionActionRequest,
  normalizeActionRequest,
  settlePendingPlanToolPermissionInvalidation,
  type ActionRequest,
  type PendingPlanToolPermissionInvalidation,
  type ToolPermissionResolutionIdentity,
  type UserChoiceResolutionIdentity,
  type PlanReviewResolutionIdentity,
  type GoalControlIdentity,
} from "../lib/actionRequest";
import { issuePlanExplicitResumeAttempt } from "../lib/planExecutionContinuation";
import { isHarnessMarkerOwnedByPlanExecution } from "../lib/planExecutionOwnership";
import {
  isInternalUnapprovedPlanChoiceRestore,
  restorePendingActionRequest,
  stripRestoredUserChoiceControlText,
} from "../lib/actionRequestRestore";
import { getFilePreviewStrategy } from "../lib/filePreviewStrategy";
import {
  sanitizeUserContextItemsForPersist,
} from "../lib/userContextItems";
import { resolveSessionTranscriptPageMetadata } from "../lib/sessionTranscriptPaging";
import {
  LOCAL_PERSIST_SCHEMA_VERSION,
  buildPersistedAppState,
  sanitizeHydratedLockedComposerIntent,
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
  parseGameStudioSlashCommand,
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
  archiveReplyOptionBlocksForChoice,
  buildSubmitInputEnvelope,
  buildLocalTurnTitle,
  buildMainDebugPrompt,
  buildRunIntentSummary,
  buildSubmitPipelineDecision,
  createGoalContinuationAuthorization,
  createGoalContinuationAuthorizationBroker,
  createVisibleGoalSubmissionAuthorizationBroker,
  isResolvedUserIntentChoice,
  normalizeIntentSummary,
  normalizeTaskFlowPatchForConsumedReplyOptions,
  isGoalCreationAuthorization,
  isGoalContinuationAuthorization,
  isExactQueuedMessageReplay,
  resolveQueuedGoalCreationAuthorization,
  resolveQueuedGoalContinuationAuthorization,
  resolveVisibleGoalSubmissionSessionKey,
  resolveSubmitRuntimeDecision,
  resolveSubmitSemanticMetadataDecision,
  validateGoalContinuationAuthorization,
  type GoalContinuationAuthorization,
  type GoalContinuationEnvelope,
  type GoalCreationAuthorization,
  type VisibleGoalSubmissionEnvelope,
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
import {
  isQueuedGoalContinuationOwnedByGoal,
  resolveGoalPauseTransition,
  resolveQueuedGoalContinuationRemoval,
  resolveGoalActionRequestOwnership,
  resolveGoalPendingReviewOwnership,
  resolveGoalRunAbortOwnership,
  type QueuedGoalContinuationRemovalMode,
} from "../lib/goalRunOwnership";
import {
  isGoalRuntimeDeleted,
  markGoalRuntimeDeleted,
  resolveGoalDeletionFenceRelativePath,
  resolveGoalRuntimeProgressFilePath,
  resolveGoalRuntimeRelativeDirPath,
  serializeGoalDeletionFence,
  unmarkGoalRuntimeDeleted,
} from "../lib/goalPersistence";
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
  preserveSubmitSessionRuntimeOwnership,
  startSubmitElapsedTimer,
} from "./submitRuntimeFacade";
import { createSubmitSessionRuntimeController } from "./submitSessionRuntimeController";
import { startSubmitBlockingPreflightEffect } from "./submitPreflightExecutor";
import {
  startGameStudioLocalSlashSubmission,
  type GameStudioLocalSlashCompletionResult,
} from "./gameStudioLocalSlashSubmission";
import {
  applySubmitSeedSessionTitle,
  startSubmitSemanticMetadataEffect,
} from "./submitTitleEffects";
import { applySubmitSessionBootstrap } from "./submitSessionBootstrap";
import { createGameStudioLocalSlashBridge } from "./gameStudioLocalSlashBridge";
import { commitGameStudioLocalSlashProjection } from "./commitGameStudioLocalSlashProjection";
import { applySubmitVisibleTurn } from "./submitVisibleTurn";
import { prepareSubmitTurnDraft } from "./submitTurnDraft";
import { startSubmitPlanHydrationEffect } from "./submitPlanHydration";
import { runSubmitPlanExecutionResumeEffect } from "./submitPlanExecutionResume";
import { applySubmitPendingReviewTransition } from "./submitPendingReviewTransition";
import { applySubmitPlanStateReset } from "./submitPlanStateReset";
import { applySubmitSendGateEffects } from "./submitSendGateEffects";
import { resolveAndApplySubmitIntentRouting } from "./submitIntentRouting";
import { startSubmitAsyncWorkflowRun } from "./submitAsyncWorkflowRun";
import {
  buildTemporarySubmitRuntimeProjection,
  persistSubmitRuntimeProjection,
} from "./persistSubmitRuntimeProjection";
import { commitCanceledTurn } from "./commitCanceledTurn";
import {
  beginSessionCancellation,
  deferUntilSessionCancellationSettled,
  getPendingSessionCancellation,
  hasCanceledTurnTerminalProjection,
  resolveDeferredSessionSubmissionDecision,
  type SessionCancellationSettlement,
} from "./sessionCancellationBarrier";
import {
  revokeAllSessionRuntimesBeforeSettingsReset,
  revokeSessionRuntimeBeforeDelete,
  revokeWorkspaceSessionRuntimesBeforeClear,
} from "./sessionRuntimeRevocation";
import {
  beginWorkspaceClearSubmissionBarrier,
  discardAllWorkspaceClearSubmissionStateForSettingsReset,
  discardWorkspaceClearSubmissionState,
  deferSubmissionForWorkspaceClear,
  peekSettledWorkspaceClearSubmission,
  resolveWorkspaceClearBarrierForSubmission,
  restoreSettledWorkspaceClearSubmission,
  settleWorkspaceClearSubmissionBarrier,
  takeSettledWorkspaceClearSubmission,
} from "./workspaceClearSubmissionBarrier";
import { projectCanceledTurn } from "../lib/canceledTurnProjection";
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
  WORKSPACE_INSTRUCTION_SCHEMA_VERSION,
  type WorkspaceInstruction,
  type WorkspaceInstructionLedgerEntry,
  type WorkspaceInstructionReceipt,
  type WorkspaceInstructionSource,
  type WorkspaceJsonObject,
  type WorkspaceTurnQueueEntry,
  type WorkspaceTurnQueueState,
  type WorkspaceTurnTerminalOwner,
} from "../lib/workspaceInstruction";
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
import { stripAssistantPublicProgress } from "../lib/assistantPublicProgress";
import type { FeishuRemoteContext } from "../lib/remoteContextTypes";
import { compactThoughtContent } from "../lib/thoughtCompaction";
import {
  buildWorkspaceTurnQueueEntryIdentity,
  createWorkspaceTurnQueueState,
  normalizeWorkspaceInstructionLedger,
  reconcileWorkspaceTurnQueueOnRestore,
  reduceWorkspaceTurnQueue,
} from "./workspaceTurnQueue";
import {
  buildWorkspaceInstructionPayloadIdentity,
  buildWorkspaceInstructionUserContext,
} from "./workspaceInstructionAdmission";
import {
  buildWorkspaceInstructionConversationTurn,
  normalizeWorkspaceInstructionIntentHint,
  reconcileWorkspaceInstructionProjection,
} from "./workspaceInstructionProjection";
import {
  resolveWorkspaceInstructionActionDecision,
  resolveWorkspaceInstructionExecutionConsent,
} from "./workspaceInstructionApproval";
import { waitForSessionAdmissionReadiness } from "./sessionAdmissionReadiness";
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

const GOAL_DELETE_RUN_SETTLE_TIMEOUT_MS = 10_000;

async function waitForGoalRunLeaseRelease(input: {
  abortController: AbortController | null;
  harnessRunId: string | null;
  getLeaseSnapshot: () => Pick<AppState, "abortController" | "harnessRunMarker"> | null;
  timeoutMs?: number;
}): Promise<boolean> {
  const deadline = Date.now() + Math.max(0, input.timeoutMs ?? GOAL_DELETE_RUN_SETTLE_TIMEOUT_MS);
  while (true) {
    const current = input.getLeaseSnapshot();
    const controllerReleased = !input.abortController || current?.abortController !== input.abortController;
    const markerReleased = !input.harnessRunId ||
      !current?.harnessRunMarker ||
      current.harnessRunMarker.runId !== input.harnessRunId ||
      current.harnessRunMarker.status !== "running";
    if (controllerReleased && markerReleased) return true;
    if (Date.now() >= deadline) return false;
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
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

const UNBOUND_PLAN_SESSION_KEY = "__MAIN_UNBOUND_PLAN_SESSION__";
const UNBOUND_PLAN_SESSION_EPOCH = "__MAIN_UNBOUND_PLAN_EPOCH__";

function createEmptyPlanLifecycleForSession(
  sessionKey: string | null | undefined,
  options?: { sessionEpoch?: string; now?: number },
): PlanLifecycleState {
  const normalizedSessionKey = String(sessionKey || "").trim() || UNBOUND_PLAN_SESSION_KEY;
  const now = options?.now ?? Date.now();
  const sessionEpoch = String(options?.sessionEpoch || "").trim() || (
    normalizedSessionKey === UNBOUND_PLAN_SESSION_KEY
      ? UNBOUND_PLAN_SESSION_EPOCH
      : createPlanLifecycleSessionEpoch(now)
  );
  return createPlanLifecycleState({
    sessionKey: normalizedSessionKey,
    sessionEpoch,
    updatedAt: now,
  });
}

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
  planLifecycle?: PlanLifecycleState;
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
  preferSubagents?: boolean;
  webSearchEnabled?: boolean;
  webSearchProvider?: WebSearchProvider;
  approvedShellPermissionRules?: string[];
  queuedUserMessage?: QueuedUserMessage | null;
  activeGuidance?: ActiveGuidance | null;
  /** Durable per-Session FIFO for workspace-visible instructions. */
  workspaceTurnQueue?: WorkspaceTurnQueueState | null;
  /** Retry tombstones remain available when older Turns are paged out. */
  workspaceInstructionLedger?: readonly WorkspaceInstructionLedgerEntry[];
  
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
  preferSubagents: boolean;
  webSearchEnabled: boolean;
  webSearchProvider: WebSearchProvider;
  currentTurnExecutionConsent: { turnId: string | null; granted: boolean };
  approvedLocalFileReadPaths: string[];
  approvedShellPermissionRules: string[];
  readOnlyAutoApproveForSession: boolean;
  queuedUserMessage: QueuedUserMessage | null;
  activeGuidance: ActiveGuidance | null;
  workspaceTurnQueue: WorkspaceTurnQueueState | null;
  workspaceInstructionLedger: readonly WorkspaceInstructionLedgerEntry[];
  transcriptPartial: boolean;
  transcriptLoadedTurns: number;
  transcriptTotalTurns: number;
  planLifecycle: PlanLifecycleState;
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
  /** Container-owned Plan generation; runtime snapshots cannot self-assert it. */
  planLifecycleEpoch?: string;
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
  /** SQLite-owned CAS revision returned by Project Session persistence. */
  storageRevision?: number;
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

export interface AcceptWorkspaceInstructionInput {
  text: string;
  images?: string[];
  contextMentions?: string[];
  attachedFiles?: Array<AttachedFile | string>;
  source?: WorkspaceInstructionSource;
  /** Stable id supplied by remote/UI clients for retry-safe admission. */
  clientSubmissionId?: string;
  /** JSON-only routing candidates. Every capability is revalidated at dispatch. */
  dispatchHints?: WorkspaceJsonObject;
  /** Transient broker envelope consumed during admission; never persisted. */
  goalContinuationEnvelope?: GoalContinuationEnvelope;
  /** Remote reply target copied into JSON-safe dispatch hints. */
  remoteFeishu?: FeishuRemoteContext;
  /** Internal fail-closed path after a clear replay exhausts safe retries. */
  forceVisibleErrorConclusion?: "workspace_clear_replay_exhausted";
}

export type WorkspaceInstructionAcceptance =
  | {
      accepted: true;
      receipt: WorkspaceInstructionReceipt;
      disposition: "admitted" | "duplicate";
      durability: "session" | "memory";
      queuePosition: number;
    }
  | {
      accepted: false;
      reason:
        | "empty"
        | "workspace_required"
        | "session_required"
        | "session_changed"
        | "admission_conflict"
        | "persistence_failed";
      retryable: boolean;
    };

export interface WorkspaceInstructionDispatchClaim {
  claimId: string;
  receiptId: string;
  clientSubmissionId: string;
  sessionKey: string;
  sessionEpoch: string;
  turnId: string;
  admittedUserBlockId: number;
  /** Canonical immutable instruction+receipt envelope captured at claim time. */
  instructionEnvelopeIdentity: string;
}

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
  closeTurnAsCanceled: (turnId: string, options?: { reason?: string; message?: string }) => boolean;
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
  ensurePlanArtifactsHydratedForWorkspace: (options?: { openPanel?: boolean; reason?: string }) => Promise<boolean>;
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
  runImageStudioGeneration: (
    text: string,
    images?: string[],
    admittedOwner?: WorkspaceInstructionDispatchClaim,
  ) => boolean;
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
  markWorkspaceClearSubmissionReplayReady: (
    workspacePath: string,
    sessionId: number | null,
  ) => boolean;
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
  clearChatHistory: () => Promise<void>;
  resetAllSettings: () => void;

  // Workflow mode
  planLifecycle: PlanLifecycleState;
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
  setPlanStage: (stage: PlanStage) => void;
  upsertPlanArtifact: (artifact: PlanArtifact) => void;
  clearPlanArtifacts: () => void;
  deletePersistedPlanFiles: () => Promise<void>;
  deleteBrowserValidationArtifacts: () => Promise<void>;
  setPlanTasks: (tasks: PlanTask[]) => void;
  setNormalizedStreamState: (state: NormalizedStreamState) => void;
  approvePlan: (approvalChoice?: string, expected?: PlanReviewResolutionIdentity) => void;
  resumePlanExecution: (instruction: string) => boolean;
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
  startGoal: (objective: string, options?: Partial<GoalBudget> & { sessionKey?: string; sourceContext?: string; ownerTurnId?: string; subagentPreference?: SubagentDelegationPreference }) => void;
  pauseGoal: (expected?: GoalControlIdentity) => void;
  resumeGoal: (expected?: GoalControlIdentity) => void;
  clearGoal: (expected: GoalControlIdentity) => Promise<boolean>;
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
  preferSubagents: boolean;
  webSearchEnabled: boolean;
  webSearchProvider: WebSearchProvider;
  currentTurnExecutionConsent: { turnId: string | null; granted: boolean };
  approvedLocalFileReadPaths: string[];
  approvedShellPermissionRules: string[];
  readOnlyAutoApproveForSession: boolean;
  queuedUserMessage: QueuedUserMessage | null;
  activeGuidance: ActiveGuidance | null;
  workspaceTurnQueue: WorkspaceTurnQueueState | null;
  workspaceInstructionLedger: readonly WorkspaceInstructionLedgerEntry[];
  transcriptPartial: boolean;
  transcriptLoadedTurns: number;
  transcriptTotalTurns: number;
  pendingRunDecisionResolver:
    | ((choice: "approve_once" | "approve_thread" | "cancel") => void)
    | null;
  setAutoApproveTools: (v: boolean) => void;
  setPreferSubagents: (v: boolean) => void;
  setWebSearchEnabled: (v: boolean) => void;
  setWebSearchProvider: (provider: WebSearchProvider) => void;
  setReadOnlyAutoApproveForSession: (v: boolean) => void;
  captureVisibleGoalSubmissionEnvelope: (
    text: string,
  ) => VisibleGoalSubmissionEnvelope | null;
  captureGoalContinuationEnvelope: (
    text: string,
    options: {
      source: GoalContinuationAuthorization["source"];
      requestId?: string;
    },
  ) => GoalContinuationEnvelope | null;
  queueUserMessage: (
    text: string,
    images?: string[],
    options?: {
      contextMentions?: string[];
      attachedFiles?: AttachedFile[];
      runtimeIntentOverride?: ResolvedRunIntent;
      goalSourceContextSnapshot?: string;
      /** Opaque one-shot capability captured by the visible composer submit. */
      visibleGoalSubmissionEnvelope?: VisibleGoalSubmissionEnvelope;
      /** Internal: already validated by the submit pipeline before send-gate queueing. */
      goalCreationAuthorization?: GoalCreationAuthorization;
      /** Internal: existing-Goal continuation validated before send-gate queueing. */
      goalContinuationAuthorization?: GoalContinuationAuthorization;
      /** Exact user guidance paired with the authorized Goal continuation. */
      goalContinuationGuidance?: string;
      replyOptionRequestIdentity?: UserChoiceResolutionIdentity;
      replyOptionIsCustom?: boolean;
      parentRunIdOverride?: string;
    },
  ) => QueuedUserMessage | null;
  clearQueuedUserMessage: (options?: {
    expectedId?: string;
    disposition?: Exclude<QueuedGoalContinuationRemovalMode, "replaced">;
    reason?: string;
  }) => boolean;
  setActiveGuidance: (text: string, turnId?: string | null) => void;
  clearActiveGuidance: () => void;
  consumeActiveGuidance: (turnId?: string | null) => ActiveGuidance | null;
  acceptWorkspaceInstruction: (
    input: AcceptWorkspaceInstructionInput,
  ) => Promise<WorkspaceInstructionAcceptance>;
  /** Reconcile a terminal head and claim at most one exact FIFO entry. */
  dispatchNextWorkspaceInstruction: (expectedSessionKey?: string) => boolean;
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
      forceExecuteRecoveryState?: ForcedExecuteRecoveryRuntimeState;
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
      /** Opaque one-shot capability captured before visible UI state is cleared. */
      visibleGoalSubmissionEnvelope?: VisibleGoalSubmissionEnvelope;
      goalContinuationEnvelope?: GoalContinuationEnvelope;
      queuedUserMessageId?: string;
      submissionOriginSessionKey?: string;
      remoteFeishu?: FeishuRemoteContext;
      skipAutoPlanHydration?: boolean;
      parentRunIdOverride?: string;
      /** @deprecated Ignored without a valid goalContinuationEnvelope. */
      continueExistingGoal?: boolean;
      goalContinuationGuidance?: string;
      /** Reserved child run identity for an approved Plan handoff. */
      runIdOverride?: string;
      /** Exact one-shot Plan execution attempt consumed only after Run admission. */
      planExecutionLeaseId?: string;
      planExecutionInstructionHash?: string;
      /** Internal proof that an already-admitted Turn owns this dispatch. */
      workspaceInstructionClaim?: WorkspaceInstructionDispatchClaim;
      adoptExistingTurn?: boolean;
      admittedUserBlockId?: number;
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
  const planCapabilityCurrent = !isToolPermissionActionRequest(request) || !request.planExecution || (
    isToolPermissionPlanExecutionIdentityCurrent(request, state.planLifecycle) &&
    isPlanApprovalIdentityCurrent({
      artifacts: state.planArtifacts,
      revision: request.planExecution.planRevision,
      artifactHash: request.planExecution.artifactHash,
    })
  );
  if (
    ownsPendingResolver &&
    ownsPendingRequest &&
    exactIdentity &&
    ownsActiveSession &&
    planCapabilityCurrent
  ) return true;

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
    planCapabilityCurrent,
  });
  return false;
}

function buildStalePendingPlanToolPermissionInvalidation(
  state: AppState,
): PendingPlanToolPermissionInvalidation | null {
  const request = state.activeActionRequest;
  if (
    !isToolPermissionActionRequest(request) ||
    !request.planExecution ||
    (
      isToolPermissionPlanExecutionIdentityCurrent(request, state.planLifecycle) &&
      isPlanApprovalIdentityCurrent({
        artifacts: state.planArtifacts,
        revision: request.planExecution.planRevision,
        artifactHash: request.planExecution.artifactHash,
      })
    )
  ) {
    return null;
  }
  return buildPendingPlanToolPermissionInvalidation(state, true);
}

function invalidateStalePendingPlanToolPermission(input: {
  state: AppState;
  action: "approve_once" | "approve_session" | "reject";
  applyPatch: (patch: Partial<AppState>) => void;
}): boolean {
  const invalidation = buildStalePendingPlanToolPermissionInvalidation(input.state);
  if (!invalidation) return false;
  input.applyPatch({ ...invalidation.patch });
  let settled = false;
  try {
    settled = settlePendingPlanToolPermissionInvalidation(invalidation);
  } catch (error) {
    logStoreEvent("stale_plan_tool_permission_settlement_failed", {
      action: input.action,
      requestId: invalidation.requestId,
      taskId: invalidation.taskId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  logStoreEvent("stale_plan_tool_permission_invalidated", {
    action: input.action,
    requestId: invalidation.requestId,
    taskId: invalidation.taskId,
    settled,
  });
  return true;
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

function normalizeLiveConversationTurns(
  turns: ConversationTurn[] | undefined,
): ConversationTurn[] {
  return (turns || []).map((turn) => {
    return {
      ...turn,
      processCollapsed: turn.processCollapsed ?? turn.collapsed ?? false,
      collapsed: turn.processCollapsed ?? turn.collapsed ?? false,
    };
  });
}

export function normalizeInterruptedConversationTurnsForRestore(
  turns: ConversationTurn[] | undefined,
  _taskFlow: TaskBlock[],
): ConversationTurn[] {
  return normalizeLiveConversationTurns(turns).map((normalizedTurn) => {
    const turn = normalizedTurn;
    if (turn.status !== "executing" && turn.status !== "planning") return normalizedTurn;
    return {
      ...normalizedTurn,
      status: "paused",
      summary: String(turn.summary || "").trim() || "Execution was interrupted by an application restart; progress is preserved and resumable.",
    };
  });
}

function nextRestoredTaskBlockId(
  taskFlow: TaskBlock[],
  conversationTurns: ConversationTurn[],
  reservedTaskBlockIds: readonly number[] = [],
): number {
  const occupied = new Set<number>();
  for (const block of taskFlow) {
    if (Number.isSafeInteger(block.id) && block.id > 0) occupied.add(block.id);
  }
  for (const turn of conversationTurns) {
    for (const blockId of turn.blockIds) {
      if (Number.isSafeInteger(blockId) && blockId > 0) occupied.add(blockId);
    }
  }
  for (const blockId of reservedTaskBlockIds) {
    if (Number.isSafeInteger(blockId) && blockId > 0) occupied.add(blockId);
  }
  let maxId = 0;
  for (const id of occupied) maxId = Math.max(maxId, id);
  if (maxId < Number.MAX_SAFE_INTEGER) return maxId + 1;
  for (let candidate = 1; candidate < Number.MAX_SAFE_INTEGER; candidate += 1) {
    if (!occupied.has(candidate)) return candidate;
  }
  throw new Error("RESTORE_TASK_BLOCK_ID_EXHAUSTED");
}

function buildRestoredTerminalFinalText(input: {
  resultKind: "success" | "partial" | "blocked" | "error" | "canceled";
  runSummary?: string | null;
  markerError?: string | null;
  markerReason?: string | null;
  turn?: ConversationTurn | null;
}): string {
  const useChinese = /[^\x00-\x7F]/.test(String(input.turn?.userPrompt || ""));
  const prefix = useChinese
    ? {
        success: "本轮运行已完成；恢复时已补齐此前未写入界面的最终结论。",
        partial: "本轮已得出部分完成结论；恢复时已补齐最终说明。",
        blocked: "本轮已得出受阻结论；恢复时已补齐最终说明。",
        error: "本轮已得出错误结论；恢复时已补齐最终说明。",
        canceled: "本轮已取消；恢复时已补齐最终说明。",
      }[input.resultKind]
    : {
        success: "This run completed. Its missing final conclusion was recovered from the terminal checkpoint.",
        partial: "This run concluded with a partial result. Its missing final explanation was recovered.",
        blocked: "This run concluded as blocked. Its missing final explanation was recovered.",
        error: "This run concluded with an error. Its missing final explanation was recovered.",
        canceled: "This run was canceled. Its missing final explanation was recovered.",
      }[input.resultKind];
  const detail = String(
    input.resultKind === "error"
      ? input.markerError || input.runSummary || input.markerReason || input.turn?.summary || ""
      : input.runSummary || input.markerReason || input.turn?.summary || "",
  ).trim();
  return detail && detail !== prefix ? `${prefix}\n\n${detail}` : prefix;
}

function canonicalizeRestoredTerminalTurnFinal(input: {
  taskFlow: TaskBlock[];
  conversationTurns: ConversationTurn[];
  turnId: string;
  resultKind: "success" | "partial" | "blocked" | "error" | "canceled";
  runId?: string | null;
  parentRunId?: string | null;
  completedAt?: number | null;
  runSummary?: string | null;
  markerError?: string | null;
  markerReason?: string | null;
  finalText?: string | null;
  forceFinalText?: boolean;
  /** Durable FIFO receipts reserve their user block IDs before projection. */
  reservedTaskBlockIds?: readonly number[];
}): { taskFlow: TaskBlock[]; conversationTurns: ConversationTurn[] } {
  const turn = input.conversationTurns.find((candidate) => candidate.id === input.turnId);
  const restoredFinalText = String(input.finalText || "").trim() ||
    buildRestoredTerminalFinalText({
      resultKind: input.resultKind,
      runSummary: input.runSummary,
      markerError: input.markerError,
      markerReason: input.markerReason,
      turn,
    });
  const finalIndexes = input.taskFlow.flatMap((block, index) =>
    block.type === "agent" &&
    block.turnId === input.turnId &&
    block.visibility === "assistant_final"
      ? [index]
      : []
  );
  const canonicalFinalIndex = finalIndexes.length > 0
    ? finalIndexes[finalIndexes.length - 1]
    : undefined;
  const existingFinal = canonicalFinalIndex === undefined
    ? null
    : input.taskFlow[canonicalFinalIndex];
  const finalBlockId = existingFinal?.id ?? nextRestoredTaskBlockId(
    input.taskFlow,
    input.conversationTurns,
    input.reservedTaskBlockIds,
  );
  let taskFlow = input.taskFlow.map((block, index) => {
    if (
      index === canonicalFinalIndex &&
      block.type === "agent" &&
      block.turnId === input.turnId &&
      block.visibility === "assistant_final"
    ) {
      return {
        ...stripAssistantPublicProgress(block),
        content: input.forceFinalText || !String(block.content || "").trim()
          ? restoredFinalText
          : block.content,
        streaming: false,
        hiddenProcess: false,
        visibility: "assistant_final" as const,
      };
    }
    if (
      index !== canonicalFinalIndex &&
      block.type === "agent" &&
      block.turnId === input.turnId &&
      block.visibility === "assistant_final"
    ) {
      return {
        ...stripAssistantPublicProgress(block),
        visibility: "assistant_update" as const,
      };
    }
    return block;
  });
  if (canonicalFinalIndex === undefined) {
    taskFlow = [...taskFlow, {
      id: finalBlockId,
      turnId: input.turnId,
      type: "agent",
      content: restoredFinalText,
      streaming: false,
      hiddenProcess: false,
      visibility: "assistant_final",
    }];
  }
  const runId = String(input.runId || turn?.runtimeOutcome?.runId || "").trim() ||
    `restored-run-${input.turnId}`;
  const parentRunId = input.parentRunId !== undefined
    ? input.parentRunId
    : turn?.runtimeOutcome?.parentRunId || null;
  const completedAt = Math.max(
    0,
    Number(input.completedAt) || Number(turn?.runtimeOutcome?.updatedAt) || Date.now(),
  );
  const reason = String(
    input.markerError ||
    input.markerReason ||
    input.runSummary ||
    turn?.runtimeOutcome?.reason ||
    "restored_turn_completion",
  ).trim() || "restored_turn_completion";
  const authoritativeSummary = String(
    input.runSummary || input.markerError || input.markerReason || turn?.summary || "",
  ).trim();
  const restoredSummary = input.forceFinalText
    ? authoritativeSummary || restoredFinalText
    : summarizeAssistantText(authoritativeSummary);
  return {
    taskFlow,
    conversationTurns: input.conversationTurns.map((turn) =>
      turn.id === input.turnId
        ? {
            ...turn,
            status: input.forceFinalText && input.resultKind === "error"
              ? "error" as const
              : "done" as const,
            ...(restoredSummary ? { summary: restoredSummary } : {}),
            runtimeOutcome: {
              status: "completed" as const,
              reason,
              resultKind: input.resultKind,
              runId,
              parentRunId,
              updatedAt: completedAt,
            },
            blockIds: turn.blockIds.includes(finalBlockId)
              ? turn.blockIds
              : [...turn.blockIds, finalBlockId],
          }
        : turn
    ),
  };
}

type WorkspaceInstructionTerminalResultKind =
  | "success"
  | "partial"
  | "blocked"
  | "error"
  | "canceled";

function workspaceInstructionEnvelopeIdentity(
  entry: WorkspaceTurnQueueEntry,
): string {
  return buildWorkspaceTurnQueueEntryIdentity(entry);
}

function sameStringSequence(
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
): boolean {
  const normalizedLeft = left || [];
  const normalizedRight = right || [];
  return normalizedLeft.length === normalizedRight.length &&
    normalizedLeft.every((value, index) => value === normalizedRight[index]);
}

function resolveExactWorkspaceInstructionProjection(input: {
  entry: WorkspaceTurnQueueEntry;
  taskFlow: readonly TaskBlock[];
  conversationTurns: readonly ConversationTurn[];
}): { turn: ConversationTurn; userBlock: Extract<TaskBlock, { type: "user" }> } | null {
  const { entry } = input;
  const expectedContextItems = buildWorkspaceInstructionUserContext({
    contextMentions: entry.instruction.payload.contextMentions
      ? [...entry.instruction.payload.contextMentions]
      : [],
    attachedFiles: entry.instruction.payload.attachedFiles
      ? entry.instruction.payload.attachedFiles.map((file) => ({ ...file }))
      : [],
    images: entry.instruction.payload.images
      ? [...entry.instruction.payload.images]
      : [],
    workspace: "",
    language: "en",
  });
  const contextItemIdentitiesEqual = (
    left: Extract<TaskBlock, { type: "user" }>["contextItems"],
  ) => {
    const normalizedLeft = sanitizeUserContextItemsForPersist(left) || [];
    const normalizedRight = sanitizeUserContextItemsForPersist(expectedContextItems) || [];
    return normalizedLeft.length === normalizedRight.length &&
      normalizedLeft.every((item, index) => {
        const candidate = normalizedRight[index];
        return item.id === candidate.id &&
          item.kind === candidate.kind &&
          (item.path || "") === (candidate.path || "");
      });
  };
  const sourceTurns = input.conversationTurns.filter(
    (candidate) => candidate.id === entry.receipt.turnId,
  );
  const submissionTurns = input.conversationTurns.filter(
    (candidate) =>
      candidate.clientSubmissionId === entry.instruction.clientSubmissionId,
  );
  const receiptTurns = input.conversationTurns.filter(
    (candidate) =>
      candidate.workspaceInstructionReceiptId === entry.receipt.receiptId,
  );
  const turn = sourceTurns.length === 1 &&
      submissionTurns.length === 1 &&
      receiptTurns.length === 1 &&
      sourceTurns[0] === submissionTurns[0] &&
      sourceTurns[0] === receiptTurns[0] &&
      sourceTurns[0].id === entry.receipt.turnId &&
    sourceTurns[0].clientSubmissionId === entry.instruction.clientSubmissionId &&
    sourceTurns[0].workspaceInstructionReceiptId === entry.receipt.receiptId &&
    sourceTurns[0].workspaceInstructionSource === entry.instruction.source &&
    sourceTurns[0].userPrompt === entry.instruction.payload.text &&
    sourceTurns[0].blockIds.filter(
      (blockId) => blockId === entry.receipt.userBlockId,
    ).length === 1 &&
    sourceTurns[0].createdAt === entry.receipt.acceptedAt
    ? sourceTurns[0]
    : null;
  const userBlockIdCandidates = input.taskFlow.filter(
    (block) => block.id === entry.receipt.userBlockId,
  );
  const sourceUserBlocks = input.taskFlow.filter((block) =>
    block.type === "user" && block.turnId === entry.receipt.turnId
  );
  const userBlock = userBlockIdCandidates.length === 1 &&
      sourceUserBlocks.length === 1 &&
      userBlockIdCandidates[0] === sourceUserBlocks[0] &&
      userBlockIdCandidates[0].type === "user" &&
      userBlockIdCandidates[0].id === entry.receipt.userBlockId &&
      userBlockIdCandidates[0].turnId === entry.receipt.turnId &&
      userBlockIdCandidates[0].content === entry.instruction.payload.text &&
      sameStringSequence(
        userBlockIdCandidates[0].images,
        entry.instruction.payload.images,
      ) &&
      contextItemIdentitiesEqual(userBlockIdCandidates[0].contextItems)
    ? userBlockIdCandidates[0]
    : null;
  return turn && userBlock ? { turn, userBlock } : null;
}

function inspectWorkspaceInstructionTerminalProjection(input: {
  entry: WorkspaceTurnQueueEntry;
  sessionKey: string;
  taskFlow: readonly TaskBlock[];
  conversationTurns: readonly ConversationTurn[];
  runtimeEvents: readonly MainThreadEvent[];
}): {
  owner: { turn: ConversationTurn; userBlock: Extract<TaskBlock, { type: "user" }> } | null;
  terminals: Extract<MainThreadEvent, { type: "turn.completed" }>[];
  canonical: boolean;
} {
  const owner = resolveExactWorkspaceInstructionProjection(input);
  const terminals = input.runtimeEvents.filter(
    (event): event is Extract<MainThreadEvent, { type: "turn.completed" }> =>
      event.type === "turn.completed" &&
      event.threadId === input.sessionKey &&
      event.turnId === input.entry.receipt.turnId,
  );
  const outcome = owner?.turn.runtimeOutcome?.status === "completed"
    ? owner.turn.runtimeOutcome
    : null;
  const starts = outcome
    ? input.runtimeEvents.filter((event) =>
        event.type === "run.started" &&
        event.threadId === input.sessionKey &&
        event.turnId === input.entry.receipt.turnId &&
        event.runId === outcome.runId &&
        event.parentRunId === outcome.parentRunId
      )
    : [];
  const conclusions = outcome
    ? input.runtimeEvents.filter(
        (event): event is Extract<MainThreadEvent, { type: "run.completed" }> =>
          event.type === "run.completed" &&
          event.threadId === input.sessionKey &&
          event.turnId === input.entry.receipt.turnId &&
          event.runId === outcome.runId &&
          event.parentRunId === outcome.parentRunId,
      )
    : [];
  const aborts = outcome
    ? input.runtimeEvents.filter(
        (event): event is Extract<MainThreadEvent, { type: "run.aborted" }> =>
          event.type === "run.aborted" &&
          event.threadId === input.sessionKey &&
          event.turnId === input.entry.receipt.turnId &&
          event.runId === outcome.runId &&
          event.parentRunId === outcome.parentRunId,
      )
    : [];
  const allOutcomeRunStarts = outcome
    ? input.runtimeEvents.filter((event) =>
        event.type === "run.started" &&
        event.threadId === input.sessionKey &&
        event.turnId === input.entry.receipt.turnId &&
        event.runId === outcome.runId
      )
    : [];
  const allOutcomeRunConclusions = outcome
    ? input.runtimeEvents.filter((event) =>
        event.type === "run.completed" &&
        event.threadId === input.sessionKey &&
        event.turnId === input.entry.receipt.turnId &&
        event.runId === outcome.runId
      )
    : [];
  const allOutcomeRunAborts = outcome
    ? input.runtimeEvents.filter(
        (event): event is Extract<MainThreadEvent, { type: "run.aborted" }> =>
          event.type === "run.aborted" &&
          event.threadId === input.sessionKey &&
          event.turnId === input.entry.receipt.turnId &&
          event.runId === outcome.runId,
      )
    : [];
  const finals = input.taskFlow.filter(
    (block): block is Extract<TaskBlock, { type: "agent" }> =>
      block.type === "agent" &&
      block.turnId === input.entry.receipt.turnId &&
      block.visibility === "assistant_final",
  );
  const terminal = terminals[0];
  const start = starts[0];
  const conclusion = conclusions[0];
  const sourceStarts = input.runtimeEvents.filter(
    (event): event is Extract<MainThreadEvent, { type: "run.started" }> =>
      event.type === "run.started" &&
      event.threadId === input.sessionKey &&
      event.turnId === input.entry.receipt.turnId,
  );
  const sourceConclusions = input.runtimeEvents.filter(
    (event): event is Extract<MainThreadEvent, { type: "run.completed" }> =>
      event.type === "run.completed" &&
      event.threadId === input.sessionKey &&
      event.turnId === input.entry.receipt.turnId,
  );
  const sourceAborts = input.runtimeEvents.filter(
    (event): event is Extract<MainThreadEvent, { type: "run.aborted" }> =>
      event.type === "run.aborted" &&
      event.threadId === input.sessionKey &&
      event.turnId === input.entry.receipt.turnId,
  );
  const everySourceRunIsClosed = !!terminal &&
    sourceStarts.every((candidateStart) => {
      const matching = sourceConclusions.filter((candidateConclusion) =>
        candidateConclusion.runId === candidateStart.runId &&
        candidateConclusion.parentRunId === candidateStart.parentRunId
      );
      return sourceStarts.filter(
        (candidate) => candidate.runId === candidateStart.runId,
      ).length === 1 &&
        matching.length === 1 &&
        input.runtimeEvents.indexOf(candidateStart) < input.runtimeEvents.indexOf(matching[0]) &&
        input.runtimeEvents.indexOf(matching[0]) < input.runtimeEvents.indexOf(terminal);
    }) &&
    sourceConclusions.every((candidateConclusion) => {
      const matching = sourceStarts.filter((candidateStart) =>
        candidateStart.runId === candidateConclusion.runId &&
        candidateStart.parentRunId === candidateConclusion.parentRunId
      );
      const matchingAborts = sourceAborts.filter((candidateAbort) =>
        candidateAbort.runId === candidateConclusion.runId &&
        candidateAbort.parentRunId === candidateConclusion.parentRunId
      );
      return sourceConclusions.filter(
        (candidate) => candidate.runId === candidateConclusion.runId,
      ).length === 1 &&
        matching.length === 1 &&
        ((candidateConclusion.resultKind || "success") === "canceled"
          ? matchingAborts.length === 1 &&
            input.runtimeEvents.indexOf(matching[0]) < input.runtimeEvents.indexOf(matchingAborts[0]) &&
            input.runtimeEvents.indexOf(matchingAborts[0]) < input.runtimeEvents.indexOf(candidateConclusion)
          : matchingAborts.length === 0) &&
        input.runtimeEvents.indexOf(matching[0]) <
          input.runtimeEvents.indexOf(candidateConclusion) &&
        input.runtimeEvents.indexOf(candidateConclusion) < input.runtimeEvents.indexOf(terminal);
    }) &&
    sourceAborts.every((candidateAbort) => {
      const matchingStarts = sourceStarts.filter((candidateStart) =>
        candidateStart.runId === candidateAbort.runId &&
        candidateStart.parentRunId === candidateAbort.parentRunId
      );
      const matchingConclusions = sourceConclusions.filter((candidateConclusion) =>
        candidateConclusion.runId === candidateAbort.runId &&
        candidateConclusion.parentRunId === candidateAbort.parentRunId &&
        (candidateConclusion.resultKind || "success") === "canceled"
      );
      return sourceAborts.filter(
        (candidate) => candidate.runId === candidateAbort.runId,
      ).length === 1 &&
        matchingStarts.length === 1 &&
        matchingConclusions.length === 1 &&
        input.runtimeEvents.indexOf(matchingStarts[0]) < input.runtimeEvents.indexOf(candidateAbort) &&
        input.runtimeEvents.indexOf(candidateAbort) < input.runtimeEvents.indexOf(matchingConclusions[0]) &&
        input.runtimeEvents.indexOf(matchingConclusions[0]) < input.runtimeEvents.indexOf(terminal);
    });
  const exactCancellationBoundaryIsCanonical = outcome?.resultKind === "canceled"
    ? aborts.length === 1 &&
      allOutcomeRunAborts.length === 1 &&
      !!start &&
      !!conclusion &&
      input.runtimeEvents.indexOf(start) < input.runtimeEvents.indexOf(aborts[0]) &&
      input.runtimeEvents.indexOf(aborts[0]) < input.runtimeEvents.indexOf(conclusion)
    : aborts.length === 0 && allOutcomeRunAborts.length === 0;
  return {
    owner,
    terminals,
    canonical: !!owner &&
      terminals.length === 1 &&
      starts.length === 1 &&
      conclusions.length === 1 &&
      allOutcomeRunStarts.length === 1 &&
      allOutcomeRunConclusions.length === 1 &&
      exactCancellationBoundaryIsCanonical &&
      everySourceRunIsClosed &&
      finals.length === 1 &&
      !!terminal &&
      !!start &&
      !!conclusion &&
      input.runtimeEvents.indexOf(start) < input.runtimeEvents.indexOf(conclusion) &&
      input.runtimeEvents.indexOf(conclusion) < input.runtimeEvents.indexOf(terminal) &&
      (terminal.resultKind || "success") === outcome?.resultKind &&
      (conclusion.resultKind || "success") === outcome?.resultKind &&
      conclusion.summary === owner.turn.summary &&
      finals[0].streaming !== true &&
      finals[0].content === conclusion.summary,
  };
}

function uniqueWorkspaceRecoveryTurnId(input: {
  receiptId: string;
  taskFlow: readonly TaskBlock[];
  conversationTurns: readonly ConversationTurn[];
  runtimeEvents: readonly MainThreadEvent[];
}): string {
  const safeReceiptId = input.receiptId
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "receipt";
  const base = `workspace-recovery-${safeReceiptId}`;
  let candidate = base;
  let suffix = 2;
  const occupied = (turnId: string) =>
    input.conversationTurns.some((turn) => turn.id === turnId) ||
    input.taskFlow.some((block) => block.turnId === turnId) ||
    input.runtimeEvents.some((event) => "turnId" in event && event.turnId === turnId);
  while (occupied(candidate)) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  return candidate;
}

function uniqueWorkspaceConclusionRunId(
  runtimeEvents: readonly MainThreadEvent[],
  preferredId: string,
): string {
  const base = preferredId
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "run-workspace-conclusion";
  let candidate = base;
  let suffix = 2;
  while (runtimeEvents.some((event) => "runId" in event && event.runId === candidate)) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  return candidate;
}

/**
 * Close one exact durable FIFO receipt without trusting a lookalike turnId.
 * Exact owners are repaired in place; ambiguous history is left untouched and
 * receives a separate visible recovery child with a self-consistent lifecycle.
 */
function concludeWorkspaceInstructionEntry(input: {
  entry: WorkspaceTurnQueueEntry;
  sessionKey: string;
  taskFlow: TaskBlock[];
  conversationTurns: ConversationTurn[];
  runtimeEvents: MainThreadEvent[];
  resultKind: WorkspaceInstructionTerminalResultKind;
  summary: string;
  timestampMs: number;
  forceRecovery?: boolean;
  recoveryReason?: string | null;
  language: "zh" | "en";
  reservedTaskBlockIds?: readonly number[];
}): {
  taskFlow: TaskBlock[];
  conversationTurns: ConversationTurn[];
  runtimeEvents: MainThreadEvent[];
  disposition: "canonical" | "source_completed" | "recovery_completed";
  presentationTurnId: string;
} {
  const inspection = inspectWorkspaceInstructionTerminalProjection(input);
  const sourceTurnId = input.entry.receipt.turnId;
  if (inspection.canonical && !input.forceRecovery) {
    return {
      taskFlow: input.taskFlow,
      conversationTurns: input.conversationTurns,
      runtimeEvents: input.runtimeEvents,
      disposition: "canonical",
      presentationTurnId: sourceTurnId,
    };
  }

  const persistedSourceStarts = input.runtimeEvents.filter(
    (event): event is Extract<MainThreadEvent, { type: "run.started" }> =>
      event.type === "run.started" &&
      event.threadId === input.sessionKey &&
      event.turnId === sourceTurnId,
  );
  const persistedSourceConclusions = input.runtimeEvents.filter(
    (event): event is Extract<MainThreadEvent, { type: "run.completed" }> =>
      event.type === "run.completed" &&
      event.threadId === input.sessionKey &&
      event.turnId === sourceTurnId,
  );
  const persistedSourceAborts = input.runtimeEvents.filter(
    (event): event is Extract<MainThreadEvent, { type: "run.aborted" }> =>
      event.type === "run.aborted" &&
      event.threadId === input.sessionKey &&
      event.turnId === sourceTurnId,
  );
  const ownerRuntimeOutcome = inspection.owner?.turn.runtimeOutcome;
  const persistedClosedOutcome = ownerRuntimeOutcome?.status === "completed" ||
      ownerRuntimeOutcome?.status === "aborted"
    ? ownerRuntimeOutcome
    : null;
  const persistedOutcomeResultKind: WorkspaceInstructionTerminalResultKind | null =
    persistedClosedOutcome?.status === "aborted"
      ? "canceled"
      : persistedClosedOutcome?.resultKind || null;
  const sourceRunOwnersAreUnambiguous = persistedSourceStarts.every((start) => {
    const sameRunStarts = persistedSourceStarts.filter(
      (candidate) => candidate.runId === start.runId,
    );
    const sameRunConclusions = persistedSourceConclusions.filter(
      (candidate) => candidate.runId === start.runId,
    );
    return sameRunStarts.length === 1 &&
      sameRunConclusions.length <= 1 &&
      sameRunConclusions.every(
        (conclusion) => conclusion.parentRunId === start.parentRunId,
      );
  }) && persistedSourceConclusions.every((conclusion) => {
    const sameRunConclusions = persistedSourceConclusions.filter(
      (candidate) => candidate.runId === conclusion.runId,
    );
    const sameRunStarts = persistedSourceStarts.filter(
      (candidate) => candidate.runId === conclusion.runId,
    );
    return sameRunConclusions.length === 1 &&
      sameRunStarts.length <= 1 &&
      sameRunStarts.every((start) => start.parentRunId === conclusion.parentRunId);
  }) && persistedSourceAborts.every((abort) => {
    const sameRunAborts = persistedSourceAborts.filter(
      (candidate) => candidate.runId === abort.runId,
    );
    const sameRunStarts = persistedSourceStarts.filter(
      (candidate) => candidate.runId === abort.runId,
    );
    const sameRunConclusions = persistedSourceConclusions.filter(
      (candidate) => candidate.runId === abort.runId,
    );
    return sameRunAborts.length === 1 &&
      sameRunStarts.length <= 1 &&
      sameRunStarts.every((start) => start.parentRunId === abort.parentRunId) &&
      sameRunConclusions.length <= 1 &&
      sameRunConclusions.every(
        (conclusion) => conclusion.parentRunId === abort.parentRunId,
      );
  });
  const persistedOutcomeLifecycleEvents = persistedClosedOutcome
    ? input.runtimeEvents.filter((event) =>
        (event.type === "run.started" ||
          event.type === "run.paused" ||
          event.type === "run.aborted" ||
          event.type === "run.completed") &&
        event.runId === persistedClosedOutcome.runId
      )
    : [];
  const persistedOutcomeIdentityIsCompatible = !persistedClosedOutcome ||
    persistedOutcomeLifecycleEvents.every((event) =>
      "turnId" in event &&
      "parentRunId" in event &&
      event.threadId === input.sessionKey &&
      event.turnId === sourceTurnId &&
      event.parentRunId === persistedClosedOutcome.parentRunId
    ) &&
    persistedSourceStarts.filter(
      (event) => event.runId === persistedClosedOutcome.runId,
    ).length <= 1 &&
    persistedSourceConclusions.filter(
      (event) => event.runId === persistedClosedOutcome.runId,
    ).length <= 1 &&
    (persistedOutcomeResultKind === "canceled"
      ? persistedSourceAborts.filter(
          (event) => event.runId === persistedClosedOutcome.runId,
        ).length <= 1
      : persistedSourceAborts.every(
          (event) => event.runId !== persistedClosedOutcome.runId,
        ));
  const canRepairSource = !!inspection.owner &&
    !input.forceRecovery &&
    inspection.terminals.length <= 1 &&
    sourceRunOwnersAreUnambiguous &&
    persistedOutcomeIdentityIsCompatible;
  if (canRepairSource) {
    const terminal = inspection.terminals[0] || null;
    let resultKind: WorkspaceInstructionTerminalResultKind =
      terminal?.resultKind || persistedOutcomeResultKind || input.resultKind;
    let runtimeEvents = input.runtimeEvents;
    for (const orphanConclusion of persistedSourceConclusions) {
      runtimeEvents = insertRestoredRunStartBeforeTerminal({
        runtimeEvents,
        sessionKey: input.sessionKey,
        turnId: sourceTurnId,
        runId: orphanConclusion.runId,
        parentRunId: orphanConclusion.parentRunId,
        timestampMs: Math.min(input.timestampMs, orphanConclusion.timestampMs),
      });
    }
    let selectedRunId = "";
    let selectedParentRunId: string | null = null;
    let selectedSummary = input.summary;

    if (terminal) {
      const terminalIndex = runtimeEvents.indexOf(terminal);
      const sourceConclusions = runtimeEvents.filter(
        (event): event is Extract<MainThreadEvent, { type: "run.completed" }> =>
          event.type === "run.completed" &&
          event.threadId === input.sessionKey &&
          event.turnId === sourceTurnId,
      );
      const sourceStarts = runtimeEvents.filter(
        (event): event is Extract<MainThreadEvent, { type: "run.started" }> =>
          event.type === "run.started" &&
          event.threadId === input.sessionKey &&
          event.turnId === sourceTurnId,
      );
      const openStarts = sourceStarts.filter((start) =>
        !runtimeEvents.some((event) =>
          event.type === "run.completed" &&
          event.threadId === input.sessionKey &&
          event.turnId === sourceTurnId &&
          event.runId === start.runId
        )
      );
      const reusable = sourceConclusions.filter((conclusion) => {
        if (
          runtimeEvents.indexOf(conclusion) >= terminalIndex ||
          (conclusion.resultKind || "success") !== resultKind ||
          !String(conclusion.summary || "").trim()
        ) return false;
        const sameRunConclusions = sourceConclusions.filter(
          (candidate) => candidate.runId === conclusion.runId,
        );
        const sameRunStarts = runtimeEvents.filter(
          (event): event is Extract<MainThreadEvent, { type: "run.started" }> =>
            event.type === "run.started" &&
            event.threadId === input.sessionKey &&
            event.turnId === sourceTurnId &&
            event.runId === conclusion.runId,
        );
        return sameRunConclusions.length === 1 &&
          sameRunStarts.length <= 1 &&
          sameRunStarts.every((start) => start.parentRunId === conclusion.parentRunId);
      });
      const exactOutcomeConclusion = persistedClosedOutcome
        ? reusable.find((conclusion) =>
            conclusion.runId === persistedClosedOutcome.runId &&
            conclusion.parentRunId === persistedClosedOutcome.parentRunId &&
            persistedOutcomeResultKind === resultKind
          )
        : null;
      const selected = exactOutcomeConclusion || (
        !persistedClosedOutcome ? reusable[reusable.length - 1] || null : null
      );
      if (selected) {
        selectedRunId = selected.runId;
        selectedParentRunId = selected.parentRunId;
        selectedSummary = String(selected.summary || "").trim();
        runtimeEvents = insertRestoredRunStartBeforeTerminal({
          runtimeEvents,
          sessionKey: input.sessionKey,
          turnId: sourceTurnId,
          runId: selectedRunId,
          parentRunId: selectedParentRunId,
          timestampMs: Math.min(input.timestampMs, selected.timestampMs),
        });
      } else {
        selectedRunId = persistedClosedOutcome?.runId || uniqueWorkspaceConclusionRunId(
          runtimeEvents,
          `run-admission-repair-${input.entry.receipt.receiptId}`,
        );
        selectedParentRunId = persistedClosedOutcome?.parentRunId || null;
        resultKind = persistedOutcomeResultKind || resultKind;
        selectedSummary = String(inspection.owner!.turn.summary || "").trim() || selectedSummary;
        runtimeEvents = insertRestoredRunStartBeforeTerminal({
          runtimeEvents,
          sessionKey: input.sessionKey,
          turnId: sourceTurnId,
          runId: selectedRunId,
          parentRunId: selectedParentRunId,
          timestampMs: Math.min(input.timestampMs, terminal.timestampMs),
        });
        runtimeEvents = insertRestoredRunConclusionBeforeTurnTerminal({
          runtimeEvents,
          sessionKey: input.sessionKey,
          turnId: sourceTurnId,
          runId: selectedRunId,
          parentRunId: selectedParentRunId,
          timestampMs: Math.min(input.timestampMs, terminal.timestampMs),
          resultKind,
          summary: selectedSummary,
        });
      }
      if (resultKind === "canceled") {
        runtimeEvents = insertRestoredRunAbortBeforeConclusion({
          runtimeEvents,
          sessionKey: input.sessionKey,
          turnId: sourceTurnId,
          runId: selectedRunId,
          parentRunId: selectedParentRunId,
          timestampMs: Math.min(input.timestampMs, terminal.timestampMs),
          reason: input.recoveryReason || "workspace_instruction_canceled",
          message: selectedSummary,
        });
      }
      for (const openStart of openStarts) {
        runtimeEvents = insertRestoredRunConclusionBeforeTurnTerminal({
          runtimeEvents,
          sessionKey: input.sessionKey,
          turnId: sourceTurnId,
          runId: openStart.runId,
          parentRunId: openStart.parentRunId,
          timestampMs: Math.min(input.timestampMs, terminal.timestampMs),
          resultKind: "error",
          summary: input.language === "en"
            ? "A stale admitted Run was closed while repairing the Turn's durable terminal projection."
            : "修复回合持久化终态时，已将遗留运行收口。",
        });
      }
    } else {
      const sourceStarts = runtimeEvents.filter(
        (event): event is Extract<MainThreadEvent, { type: "run.started" }> =>
          event.type === "run.started" &&
          event.threadId === input.sessionKey &&
          event.turnId === sourceTurnId,
      );
      const sourceConclusions = runtimeEvents.filter(
        (event): event is Extract<MainThreadEvent, { type: "run.completed" }> =>
          event.type === "run.completed" &&
          event.threadId === input.sessionKey &&
          event.turnId === sourceTurnId,
      );
      const openStarts = sourceStarts.filter((start) =>
        !runtimeEvents.some((event) =>
          event.type === "run.completed" &&
          event.threadId === input.sessionKey &&
          event.turnId === sourceTurnId &&
          event.runId === start.runId
        )
      );
      const trustworthyConclusions = sourceConclusions.filter((conclusion) => {
        if (!String(conclusion.summary || "").trim()) return false;
        const sameRunConclusions = sourceConclusions.filter(
          (candidate) => candidate.runId === conclusion.runId,
        );
        const matchingStarts = sourceStarts.filter((start) =>
          start.runId === conclusion.runId &&
          start.parentRunId === conclusion.parentRunId
        );
        const allSameRunStarts = sourceStarts.filter(
          (start) => start.runId === conclusion.runId,
        );
        return sameRunConclusions.length === 1 &&
          matchingStarts.length === 1 &&
          allSameRunStarts.length === 1 &&
          runtimeEvents.indexOf(matchingStarts[0]) < runtimeEvents.indexOf(conclusion);
      });
      const exactOutcomeConclusion = persistedClosedOutcome
        ? trustworthyConclusions.find((conclusion) =>
            conclusion.runId === persistedClosedOutcome.runId &&
            conclusion.parentRunId === persistedClosedOutcome.parentRunId &&
            (conclusion.resultKind || "success") === persistedOutcomeResultKind
          )
        : null;
      const preservedConclusion = exactOutcomeConclusion || (
        !persistedClosedOutcome && trustworthyConclusions.length === 1
          ? trustworthyConclusions[0]
          : null
      );
      if (preservedConclusion) {
        selectedRunId = preservedConclusion.runId;
        selectedParentRunId = preservedConclusion.parentRunId;
        selectedSummary = String(preservedConclusion.summary || "").trim();
        resultKind = preservedConclusion.resultKind || "success";
        for (const openStart of openStarts) {
          runtimeEvents = appendRuntimeEvent(runtimeEvents, withEventSchema({
            type: "run.completed",
            threadId: input.sessionKey,
            turnId: sourceTurnId,
            timestampMs: input.timestampMs,
            runId: openStart.runId,
            parentRunId: openStart.parentRunId,
            resultKind: "error",
            summary: input.language === "en"
              ? "A stale admitted Run was closed while preserving the Turn's durable conclusion."
              : "保留回合持久化结论时，已将遗留运行收口。",
          }));
        }
        if (resultKind === "canceled") {
          runtimeEvents = insertRestoredRunAbortBeforeConclusion({
            runtimeEvents,
            sessionKey: input.sessionKey,
            turnId: sourceTurnId,
            runId: selectedRunId,
            parentRunId: selectedParentRunId,
            timestampMs: input.timestampMs,
            reason: input.recoveryReason || "workspace_instruction_canceled",
            message: selectedSummary,
          });
        }
        runtimeEvents = appendRuntimeEvent(runtimeEvents, withEventSchema({
          type: "turn.completed",
          threadId: input.sessionKey,
          turnId: sourceTurnId,
          timestampMs: input.timestampMs,
          resultKind,
        }));
      } else {
        const selectableStarts = openStarts.filter((start) =>
          sourceStarts.filter((candidate) => candidate.runId === start.runId).length === 1
        );
        const exactOutcomeStart = persistedClosedOutcome
          ? selectableStarts.find((start) =>
              start.runId === persistedClosedOutcome.runId &&
              start.parentRunId === persistedClosedOutcome.parentRunId
            ) || null
          : null;
        const selectedStart = exactOutcomeStart || (
          !persistedClosedOutcome
            ? selectableStarts[selectableStarts.length - 1] || null
            : null
        );
        selectedRunId = persistedClosedOutcome?.runId || selectedStart?.runId ||
          uniqueWorkspaceConclusionRunId(
            runtimeEvents,
            `run-admission-${input.entry.receipt.receiptId}`,
          );
        selectedParentRunId = persistedClosedOutcome?.parentRunId ||
          selectedStart?.parentRunId || null;
        resultKind = persistedOutcomeResultKind || resultKind;
        selectedSummary = String(inspection.owner!.turn.summary || "").trim() || selectedSummary;
        runtimeEvents = insertRestoredRunStartBeforeTerminal({
          runtimeEvents,
          sessionKey: input.sessionKey,
          turnId: sourceTurnId,
          timestampMs: input.timestampMs,
          runId: selectedRunId,
          parentRunId: selectedParentRunId,
        });
        for (const openStart of openStarts) {
          if (openStart.runId === selectedRunId &&
              openStart.parentRunId === selectedParentRunId) continue;
          runtimeEvents = appendRuntimeEvent(runtimeEvents, withEventSchema({
            type: "run.completed",
            threadId: input.sessionKey,
            turnId: sourceTurnId,
            timestampMs: input.timestampMs,
            runId: openStart.runId,
            parentRunId: openStart.parentRunId,
            resultKind: "error",
            summary: input.language === "en"
              ? "A stale admitted Run was closed while reconciling its durable Turn owner."
              : "协调持久化回合所有权时，已将遗留运行收口。",
          }));
        }
        if (resultKind === "canceled") {
          runtimeEvents = insertRestoredRunAbortBeforeConclusion({
            runtimeEvents,
            sessionKey: input.sessionKey,
            turnId: sourceTurnId,
            runId: selectedRunId,
            parentRunId: selectedParentRunId,
            timestampMs: input.timestampMs,
            reason: input.recoveryReason || "workspace_instruction_canceled",
            message: selectedSummary,
          });
        }
        runtimeEvents = insertRestoredRunConclusionBeforeTurnTerminal({
          runtimeEvents,
          sessionKey: input.sessionKey,
          turnId: sourceTurnId,
          timestampMs: input.timestampMs,
          runId: selectedRunId,
          parentRunId: selectedParentRunId,
          resultKind,
          summary: selectedSummary,
        });
        runtimeEvents = appendRuntimeEvent(runtimeEvents, withEventSchema({
          type: "turn.completed",
          threadId: input.sessionKey,
          turnId: sourceTurnId,
          timestampMs: input.timestampMs,
          resultKind,
        }));
      }
    }
    const canonical = canonicalizeRestoredTerminalTurnFinal({
      taskFlow: input.taskFlow,
      conversationTurns: input.conversationTurns,
      turnId: sourceTurnId,
      resultKind,
      runId: selectedRunId,
      parentRunId: selectedParentRunId,
      completedAt: input.timestampMs,
      runSummary: selectedSummary,
      finalText: selectedSummary,
      forceFinalText: true,
      markerReason: input.recoveryReason || (
        input.resultKind === "error"
          ? "workspace_instruction_dispatch_rejected"
          : "workspace_instruction_action_applied"
      ),
      reservedTaskBlockIds: input.reservedTaskBlockIds,
    });
    return {
      ...canonical,
      runtimeEvents,
      disposition: "source_completed",
      presentationTurnId: sourceTurnId,
    };
  }

  const recoverySummary = String(input.summary || "").trim() || (
    input.language === "en"
      ? "MAIN found an ownership conflict while closing this workspace Turn. Unrelated history was preserved and a separate recovery Turn recorded the error."
      : "MAIN 在收口工作区回合时发现所有权冲突；无关历史保持不变，并由独立恢复回合记录该错误。"
  );
  let recoveryBaseTaskFlow = input.taskFlow;
  let recoveryBaseConversationTurns = input.conversationTurns;
  let recoveryBaseRuntimeEvents = input.runtimeEvents;
  let repairedSourceRunId: string | null = null;
  if (inspection.owner) {
    const sourceTerminal = inspection.terminals[0] || null;
    const sourceResultKind: WorkspaceInstructionTerminalResultKind =
      sourceTerminal?.resultKind || "error";
    const preservedSourceSummary = sourceResultKind === "error"
      ? recoverySummary
      : String(inspection.owner.turn.summary || "").trim() || (
          input.language === "en"
            ? "The existing terminal result was preserved while its corrupt Run trace was isolated."
            : "已保留现有终态结果，并隔离损坏的运行轨迹。"
        );
    const closedCorruptRunIds = new Set<string>();
    for (const sourceStart of persistedSourceStarts) {
      if (closedCorruptRunIds.has(sourceStart.runId)) continue;
      closedCorruptRunIds.add(sourceStart.runId);
      const hasRunBoundary = persistedSourceConclusions.some(
        (conclusion) => conclusion.runId === sourceStart.runId,
      );
      if (hasRunBoundary) continue;
      recoveryBaseRuntimeEvents = insertRestoredRunConclusionBeforeTurnTerminal({
        runtimeEvents: recoveryBaseRuntimeEvents,
        sessionKey: input.sessionKey,
        turnId: sourceTurnId,
        runId: sourceStart.runId,
        parentRunId: sourceStart.parentRunId,
        timestampMs: sourceTerminal
          ? Math.min(input.timestampMs, sourceTerminal.timestampMs)
          : input.timestampMs,
        resultKind: "error",
        summary: input.language === "en"
          ? "This ambiguous Run owner was closed while isolating a corrupt workspace Turn trace."
          : "隔离损坏的工作区回合轨迹时，已将这个含歧义的运行所有者收口。",
      });
    }
    repairedSourceRunId = uniqueWorkspaceConclusionRunId(
      recoveryBaseRuntimeEvents,
      `run-admission-source-recovery-${input.entry.receipt.receiptId}`,
    );
    recoveryBaseRuntimeEvents = insertRestoredRunStartBeforeTerminal({
      runtimeEvents: recoveryBaseRuntimeEvents,
      sessionKey: input.sessionKey,
      turnId: sourceTurnId,
      runId: repairedSourceRunId,
      parentRunId: null,
      timestampMs: sourceTerminal
        ? Math.min(input.timestampMs, sourceTerminal.timestampMs)
        : input.timestampMs,
    });
    recoveryBaseRuntimeEvents = insertRestoredRunConclusionBeforeTurnTerminal({
      runtimeEvents: recoveryBaseRuntimeEvents,
      sessionKey: input.sessionKey,
      turnId: sourceTurnId,
      runId: repairedSourceRunId,
      parentRunId: null,
      timestampMs: sourceTerminal
        ? Math.min(input.timestampMs, sourceTerminal.timestampMs)
        : input.timestampMs,
      resultKind: sourceResultKind,
      summary: preservedSourceSummary,
    });
    if (sourceResultKind === "canceled") {
      recoveryBaseRuntimeEvents = insertRestoredRunAbortBeforeConclusion({
        runtimeEvents: recoveryBaseRuntimeEvents,
        sessionKey: input.sessionKey,
        turnId: sourceTurnId,
        runId: repairedSourceRunId,
        parentRunId: null,
        timestampMs: sourceTerminal
          ? Math.min(input.timestampMs, sourceTerminal.timestampMs)
          : input.timestampMs,
        reason: input.recoveryReason || "workspace_instruction_canceled",
        message: preservedSourceSummary,
      });
    }
    if (!sourceTerminal) {
      recoveryBaseRuntimeEvents = appendRuntimeEvent(
        recoveryBaseRuntimeEvents,
        withEventSchema({
          type: "turn.completed",
          threadId: input.sessionKey,
          turnId: sourceTurnId,
          timestampMs: input.timestampMs,
          resultKind: sourceResultKind,
        }),
      );
    }
    const closedSource = canonicalizeRestoredTerminalTurnFinal({
      taskFlow: recoveryBaseTaskFlow,
      conversationTurns: recoveryBaseConversationTurns,
      turnId: sourceTurnId,
      resultKind: sourceResultKind,
      runId: repairedSourceRunId,
      parentRunId: null,
      completedAt: input.timestampMs,
      runSummary: preservedSourceSummary,
      finalText: preservedSourceSummary,
      forceFinalText: true,
      markerReason: "workspace_instruction_source_trace_corrupt",
      reservedTaskBlockIds: input.reservedTaskBlockIds,
    });
    recoveryBaseTaskFlow = closedSource.taskFlow;
    recoveryBaseConversationTurns = closedSource.conversationTurns;
  }
  const recoveryTurnId = uniqueWorkspaceRecoveryTurnId({
    receiptId: input.entry.receipt.receiptId,
    taskFlow: recoveryBaseTaskFlow,
    conversationTurns: recoveryBaseConversationTurns,
    runtimeEvents: recoveryBaseRuntimeEvents,
  });
  const exactOutcome = inspection.owner?.turn.runtimeOutcome?.status === "completed"
    ? inspection.owner.turn.runtimeOutcome
    : null;
  const trustworthyParentConclusions = exactOutcome
    ? recoveryBaseRuntimeEvents.filter(
        (event): event is Extract<MainThreadEvent, { type: "run.completed" }> =>
          event.type === "run.completed" &&
          event.threadId === input.sessionKey &&
          event.turnId === sourceTurnId &&
          event.runId === exactOutcome.runId &&
          event.parentRunId === exactOutcome.parentRunId &&
          (event.resultKind || "success") === exactOutcome.resultKind,
      )
    : [];
  const trustworthyParentStarts = exactOutcome
    ? recoveryBaseRuntimeEvents.filter(
        (event): event is Extract<MainThreadEvent, { type: "run.started" }> =>
          event.type === "run.started" &&
          event.threadId === input.sessionKey &&
          event.turnId === sourceTurnId &&
          event.runId === exactOutcome.runId &&
          event.parentRunId === exactOutcome.parentRunId,
      )
    : [];
  const parentRunId = repairedSourceRunId || (
    trustworthyParentConclusions.length === 1 &&
      trustworthyParentStarts.length === 1 &&
      recoveryBaseRuntimeEvents.indexOf(trustworthyParentStarts[0]) <
        recoveryBaseRuntimeEvents.indexOf(trustworthyParentConclusions[0])
    ? trustworthyParentConclusions[0].runId
    : null
  );
  const recoveryRunId = uniqueWorkspaceConclusionRunId(
    recoveryBaseRuntimeEvents,
    `run-workspace-recovery-${input.entry.receipt.receiptId}`,
  );
  const recoveryUserBlockId = nextRestoredTaskBlockId(
    recoveryBaseTaskFlow,
    recoveryBaseConversationTurns,
    input.reservedTaskBlockIds,
  );
  const recoveryFinalBlockId = nextRestoredTaskBlockId(
    [...recoveryBaseTaskFlow, {
      id: recoveryUserBlockId,
      turnId: recoveryTurnId,
      type: "user",
      content: input.entry.instruction.payload.text,
    }],
    recoveryBaseConversationTurns,
    input.reservedTaskBlockIds,
  );
  let runtimeEvents = appendRuntimeEvent(recoveryBaseRuntimeEvents, withEventSchema({
    type: "run.started",
    threadId: input.sessionKey,
    turnId: recoveryTurnId,
    timestampMs: input.timestampMs,
    runId: recoveryRunId,
    parentRunId,
  }));
  runtimeEvents = appendRuntimeEvent(runtimeEvents, withEventSchema({
    type: "run.completed",
    threadId: input.sessionKey,
    turnId: recoveryTurnId,
    timestampMs: input.timestampMs,
    runId: recoveryRunId,
    parentRunId,
    resultKind: "error",
    summary: recoverySummary,
  }));
  runtimeEvents = appendRuntimeEvent(runtimeEvents, withEventSchema({
    type: "turn.completed",
    threadId: input.sessionKey,
    turnId: recoveryTurnId,
    timestampMs: input.timestampMs,
    resultKind: "error",
  }));
  const conversationTurns = [...recoveryBaseConversationTurns, {
    id: recoveryTurnId,
    userPrompt: input.entry.instruction.payload.text,
    title: normalizeConversationDisplayTitle(
      input.entry.instruction.payload.text,
      input.language === "en" ? 48 : 40,
      input.language === "en" ? "Workspace recovery" : "工作区恢复",
    ),
    intentSummary: input.language === "en"
      ? "A durable workspace receipt was closed at an ownership recovery boundary."
      : "持久化工作区回执已在所有权恢复边界收口。",
    mode: "chat" as const,
    intent: "respond" as const,
    displayIntent: "respond" as const,
    status: "error" as const,
    summary: recoverySummary,
    blockIds: [recoveryUserBlockId, recoveryFinalBlockId],
    processCollapsed: false,
    collapsed: false,
    createdAt: input.timestampMs,
    runtimeOutcome: {
      status: "completed" as const,
      reason: input.recoveryReason || "workspace_instruction_projection_conflict",
      resultKind: "error" as const,
      runId: recoveryRunId,
      parentRunId,
      updatedAt: input.timestampMs,
    },
  }];
  return {
    taskFlow: [
      ...recoveryBaseTaskFlow,
      {
        id: recoveryUserBlockId,
        turnId: recoveryTurnId,
        type: "user",
        content: input.entry.instruction.payload.text,
        ...(input.entry.instruction.payload.images?.length
          ? { images: [...input.entry.instruction.payload.images] }
          : {}),
      },
      {
        id: recoveryFinalBlockId,
        turnId: recoveryTurnId,
        type: "agent",
        content: recoverySummary,
        streaming: false,
        visibility: "assistant_final",
      },
    ],
    conversationTurns,
    runtimeEvents,
    disposition: "recovery_completed",
    presentationTurnId: recoveryTurnId,
  };
}

function isRestoredLocalFastQueueEntry(
  entry: WorkspaceTurnQueueEntry,
): boolean {
  const command = parseGameStudioSlashCommand(entry.instruction.payload.text);
  return !!command &&
    getGameStudioSlashCommandSpec(command)?.executionMode === "local_fast";
}

function hasCanonicalRestoredLocalFastConclusion(input: {
  entry: WorkspaceTurnQueueEntry;
  sessionKey: string;
  taskFlow: TaskBlock[];
  conversationTurns: ConversationTurn[];
  runtimeEvents: MainThreadEvent[];
  workspacePath?: string | null;
}): boolean {
  const sourceTurnId = input.entry.receipt.turnId;
  const useChinese = /[^\x00-\x7F]/.test(input.entry.instruction.payload.text);
  const projection = reconcileWorkspaceInstructionProjection({
    entry: input.entry,
    taskFlow: input.taskFlow,
    conversationTurns: input.conversationTurns,
    userContextItems: buildWorkspaceInstructionUserContext({
      contextMentions: input.entry.instruction.payload.contextMentions
        ? [...input.entry.instruction.payload.contextMentions]
        : [],
      attachedFiles: input.entry.instruction.payload.attachedFiles
        ? input.entry.instruction.payload.attachedFiles.map((file) => ({ ...file }))
        : [],
      images: input.entry.instruction.payload.images
        ? [...input.entry.instruction.payload.images]
        : [],
      workspace: input.workspacePath || "",
      language: useChinese ? "zh" : "en",
    }),
    language: useChinese ? "zh" : "en",
  });
  if (
    projection.disposition === "ready" &&
    !projection.changed &&
    projection.turn.createdAt === input.entry.receipt.acceptedAt
  ) {
    const turn = projection.turn;
    const outcome = turn.runtimeOutcome;
    const sourceStarts = input.runtimeEvents.filter(
      (event): event is Extract<MainThreadEvent, { type: "run.started" }> =>
        event.type === "run.started" &&
        event.threadId === input.sessionKey &&
        event.turnId === sourceTurnId,
    );
    const exactSourceStarts = sourceStarts.filter(
      (event) => event.runId === outcome?.runId,
    );
    const allSourceRunConclusions = input.runtimeEvents.filter((event) =>
      event.type === "run.completed" &&
      event.threadId === input.sessionKey &&
      event.turnId === sourceTurnId
    );
    const runConclusions = allSourceRunConclusions.filter(
      (event) => event.type === "run.completed" && event.runId === outcome?.runId,
    );
    const turnConclusions = input.runtimeEvents.filter((event) =>
      event.type === "turn.completed" &&
      event.threadId === input.sessionKey &&
      event.turnId === sourceTurnId
    );
    const finals = input.taskFlow.filter(
      (block): block is Extract<TaskBlock, { type: "agent" }> =>
        block.type === "agent" &&
        block.turnId === sourceTurnId &&
        block.visibility === "assistant_final",
    );
    const sourceStart = exactSourceStarts[0];
    const runConclusion = runConclusions[0];
    const turnConclusion = turnConclusions[0];
    const sourceStartIndex = sourceStart
      ? input.runtimeEvents.indexOf(sourceStart)
      : -1;
    const runConclusionIndex = runConclusion
      ? input.runtimeEvents.indexOf(runConclusion)
      : -1;
    const turnConclusionIndex = turnConclusion
      ? input.runtimeEvents.indexOf(turnConclusion)
      : -1;
    if (
      outcome?.status === "completed" &&
      !!outcome.resultKind &&
      sourceStarts.length === 1 &&
      exactSourceStarts.length === 1 &&
      sourceStart?.type === "run.started" &&
      sourceStart.parentRunId === outcome.parentRunId &&
      sourceStartIndex >= 0 &&
      sourceStartIndex < runConclusionIndex &&
      runConclusionIndex < turnConclusionIndex &&
      allSourceRunConclusions.length === 1 &&
      runConclusions.length === 1 &&
      runConclusion?.type === "run.completed" &&
      runConclusion.parentRunId === outcome.parentRunId &&
      runConclusion.resultKind === outcome.resultKind &&
      typeof runConclusion.summary === "string" &&
      runConclusion.summary === turn.summary &&
      turnConclusions.length === 1 &&
      turnConclusion?.type === "turn.completed" &&
      turnConclusion.resultKind === outcome.resultKind &&
      finals.length === 1 &&
      finals[0].streaming !== true &&
      finals[0].content === runConclusion.summary
    ) return true;
  }

  // A same-ID replacement cannot own the source receipt's Turn terminal. The
  // immutable source Run is closed, while a visible recovery child owns the
  // final/Turn pair and links back through parentRunId.
  const sourceRunConclusions = input.runtimeEvents.filter(
    (event): event is Extract<MainThreadEvent, { type: "run.completed" }> =>
      event.type === "run.completed" &&
      event.threadId === input.sessionKey &&
      event.turnId === sourceTurnId,
  );
  return sourceRunConclusions.some((sourceConclusion) =>
    input.runtimeEvents.some((recoveryStart) => {
      if (
        recoveryStart.type !== "run.started" ||
        recoveryStart.threadId !== input.sessionKey ||
        recoveryStart.turnId === sourceTurnId ||
        recoveryStart.parentRunId !== sourceConclusion.runId
      ) return false;
      const recoveryStarts = input.runtimeEvents.filter(
        (event): event is Extract<MainThreadEvent, { type: "run.started" }> =>
          event.type === "run.started" &&
          event.threadId === input.sessionKey &&
          event.turnId === recoveryStart.turnId,
      );
      const recoveryRunConclusions = input.runtimeEvents.filter((event) =>
        event.type === "run.completed" &&
        event.threadId === input.sessionKey &&
        event.turnId === recoveryStart.turnId &&
        event.runId === recoveryStart.runId
      );
      const recoveryTurnConclusions = input.runtimeEvents.filter((event) =>
        event.type === "turn.completed" &&
        event.threadId === input.sessionKey &&
        event.turnId === recoveryStart.turnId
      );
      const recoveryTurn = input.conversationTurns.find(
        (candidate) => candidate.id === recoveryStart.turnId,
      );
      const recoveryFinals = input.taskFlow.filter(
        (block): block is Extract<TaskBlock, { type: "agent" }> =>
          block.type === "agent" &&
          block.turnId === recoveryStart.turnId &&
          block.visibility === "assistant_final",
      );
      const recoveryRunConclusion = recoveryRunConclusions[0];
      const recoveryTurnConclusion = recoveryTurnConclusions[0];
      const recoveryStartIndex = input.runtimeEvents.indexOf(recoveryStart);
      const recoveryRunConclusionIndex = recoveryRunConclusion
        ? input.runtimeEvents.indexOf(recoveryRunConclusion)
        : -1;
      const recoveryTurnConclusionIndex = recoveryTurnConclusion
        ? input.runtimeEvents.indexOf(recoveryTurnConclusion)
        : -1;
      return recoveryStarts.length === 1 &&
        recoveryStarts[0]?.runId === recoveryStart.runId &&
        recoveryStarts[0]?.parentRunId === sourceConclusion.runId &&
        recoveryStartIndex >= 0 &&
        recoveryStartIndex < recoveryRunConclusionIndex &&
        recoveryRunConclusionIndex < recoveryTurnConclusionIndex &&
        recoveryRunConclusions.length === 1 &&
        recoveryTurnConclusions.length === 1 &&
        recoveryRunConclusion?.type === "run.completed" &&
        recoveryTurnConclusion?.type === "turn.completed" &&
        recoveryRunConclusion.resultKind === recoveryTurnConclusion.resultKind &&
        recoveryRunConclusion.summary === recoveryTurn?.summary &&
        recoveryTurn?.runtimeOutcome?.status === "completed" &&
        recoveryTurn.runtimeOutcome.runId === recoveryStart.runId &&
        recoveryTurn.runtimeOutcome.parentRunId === sourceConclusion.runId &&
        recoveryTurn.runtimeOutcome.resultKind === recoveryRunConclusion.resultKind &&
        recoveryFinals.length === 1 &&
        recoveryFinals[0].streaming !== true &&
        recoveryFinals[0].content === recoveryRunConclusion.summary;
    })
  );
}

function insertRestoredRunStartBeforeTerminal(input: {
  runtimeEvents: MainThreadEvent[];
  sessionKey: string;
  turnId: string;
  runId: string;
  parentRunId: string | null;
  timestampMs: number;
}): MainThreadEvent[] {
  const matchingStarts = input.runtimeEvents.filter(
    (event): event is Extract<MainThreadEvent, { type: "run.started" }> =>
      event.type === "run.started" &&
      event.threadId === input.sessionKey &&
      event.turnId === input.turnId &&
      event.runId === input.runId &&
      event.parentRunId === input.parentRunId,
  );
  const sameRunStarts = input.runtimeEvents.filter(
    (event): event is Extract<MainThreadEvent, { type: "run.started" }> =>
      event.type === "run.started" &&
      event.threadId === input.sessionKey &&
      event.turnId === input.turnId &&
      event.runId === input.runId,
  );
  const findTerminalIndex = (events: MainThreadEvent[]) => events.findIndex((event) =>
    event.threadId === input.sessionKey &&
    "turnId" in event &&
      event.turnId === input.turnId &&
      (
      (
        (event.type === "run.paused" ||
          event.type === "run.aborted" ||
          event.type === "run.completed") &&
        event.runId === input.runId &&
        event.parentRunId === input.parentRunId
      ) ||
      event.type === "turn.completed"
    )
  );
  const terminalIndex = findTerminalIndex(input.runtimeEvents);
  const placeExistingStartBeforeTerminal = (
    existingStart: Extract<MainThreadEvent, { type: "run.started" }>,
  ): MainThreadEvent[] => {
    const startIndex = input.runtimeEvents.indexOf(existingStart);
    if (terminalIndex < 0 || startIndex < terminalIndex) return input.runtimeEvents;
    const withoutLateStart = input.runtimeEvents.filter((event) => event !== existingStart);
    const nextTerminalIndex = findTerminalIndex(withoutLateStart);
    return [
      ...withoutLateStart.slice(0, nextTerminalIndex),
      existingStart,
      ...withoutLateStart.slice(nextTerminalIndex),
    ];
  };
  if (matchingStarts.length === 1) {
    return placeExistingStartBeforeTerminal(matchingStarts[0]);
  }
  if (matchingStarts.length > 1) return input.runtimeEvents;
  // A parent mismatch is corrupt ownership evidence and forces recovery, but
  // the existing same-run start still precedes this completion. Do not invent
  // a second start with the same runId merely to paper over that conflict.
  if (sameRunStarts.length === 1) {
    return placeExistingStartBeforeTerminal(sameRunStarts[0]);
  }
  if (sameRunStarts.length > 1) return input.runtimeEvents;
  const start = withEventSchema({
    type: "run.started",
    threadId: input.sessionKey,
    turnId: input.turnId,
    timestampMs: input.timestampMs,
    runId: input.runId,
    parentRunId: input.parentRunId,
  });
  if (terminalIndex < 0) {
    return appendRuntimeEvent(input.runtimeEvents, start);
  }
  return [
    ...input.runtimeEvents.slice(0, terminalIndex),
    start,
    ...input.runtimeEvents.slice(terminalIndex),
  ];
}

function insertRestoredRunConclusionBeforeTurnTerminal(input: {
  runtimeEvents: MainThreadEvent[];
  sessionKey: string;
  turnId: string;
  runId: string;
  parentRunId: string | null;
  timestampMs: number;
  resultKind: "success" | "partial" | "blocked" | "error" | "canceled";
  summary: string;
}): MainThreadEvent[] {
  const matchingConclusions = input.runtimeEvents.filter((event) =>
    event.type === "run.completed" &&
    event.threadId === input.sessionKey &&
    event.turnId === input.turnId &&
    event.runId === input.runId
  );
  const findTurnTerminalIndex = (events: MainThreadEvent[]) => events.findIndex((event) =>
    event.type === "turn.completed" &&
    event.threadId === input.sessionKey &&
    event.turnId === input.turnId
  );
  const turnTerminalIndex = findTurnTerminalIndex(input.runtimeEvents);
  if (matchingConclusions.length === 1) {
    const existingConclusion = matchingConclusions[0];
    const conclusionIndex = input.runtimeEvents.indexOf(existingConclusion);
    if (turnTerminalIndex < 0 || conclusionIndex < turnTerminalIndex) {
      return input.runtimeEvents;
    }
    const withoutLateConclusion = input.runtimeEvents.filter(
      (event) => event !== existingConclusion,
    );
    const nextTurnTerminalIndex = findTurnTerminalIndex(withoutLateConclusion);
    return [
      ...withoutLateConclusion.slice(0, nextTurnTerminalIndex),
      existingConclusion,
      ...withoutLateConclusion.slice(nextTurnTerminalIndex),
    ];
  }
  if (matchingConclusions.length > 1) return input.runtimeEvents;
  const conclusion = withEventSchema({
    type: "run.completed",
    threadId: input.sessionKey,
    turnId: input.turnId,
    timestampMs: input.timestampMs,
    runId: input.runId,
    parentRunId: input.parentRunId,
    resultKind: input.resultKind,
    summary: input.summary,
  });
  if (turnTerminalIndex < 0) {
    return appendRuntimeEvent(input.runtimeEvents, conclusion);
  }
  return [
    ...input.runtimeEvents.slice(0, turnTerminalIndex),
    conclusion,
    ...input.runtimeEvents.slice(turnTerminalIndex),
  ];
}

function insertRestoredRunAbortBeforeConclusion(input: {
  runtimeEvents: MainThreadEvent[];
  sessionKey: string;
  turnId: string;
  runId: string;
  parentRunId: string | null;
  timestampMs: number;
  reason: string;
  message: string;
}): MainThreadEvent[] {
  const matchingAborts = input.runtimeEvents.filter(
    (event): event is Extract<MainThreadEvent, { type: "run.aborted" }> =>
      event.type === "run.aborted" &&
      event.threadId === input.sessionKey &&
      event.turnId === input.turnId &&
      event.runId === input.runId &&
      event.parentRunId === input.parentRunId,
  );
  const sameRunAborts = input.runtimeEvents.filter(
    (event): event is Extract<MainThreadEvent, { type: "run.aborted" }> =>
      event.type === "run.aborted" &&
      event.threadId === input.sessionKey &&
      event.turnId === input.turnId &&
      event.runId === input.runId,
  );
  const findConclusionIndex = (events: MainThreadEvent[]) => events.findIndex((event) =>
    event.threadId === input.sessionKey &&
    "turnId" in event &&
    event.turnId === input.turnId &&
    (
      (event.type === "run.completed" &&
        event.runId === input.runId &&
        event.parentRunId === input.parentRunId) ||
      event.type === "turn.completed"
    )
  );
  const conclusionIndex = findConclusionIndex(input.runtimeEvents);
  if (matchingAborts.length === 1) {
    const existingAbort = matchingAborts[0];
    const abortIndex = input.runtimeEvents.indexOf(existingAbort);
    if (conclusionIndex < 0 || abortIndex < conclusionIndex) return input.runtimeEvents;
    const withoutLateAbort = input.runtimeEvents.filter((event) => event !== existingAbort);
    const nextConclusionIndex = findConclusionIndex(withoutLateAbort);
    return [
      ...withoutLateAbort.slice(0, nextConclusionIndex),
      existingAbort,
      ...withoutLateAbort.slice(nextConclusionIndex),
    ];
  }
  if (matchingAborts.length > 1 || sameRunAborts.length > 0) {
    return input.runtimeEvents;
  }
  const abort = withEventSchema({
    type: "run.aborted",
    threadId: input.sessionKey,
    turnId: input.turnId,
    timestampMs: input.timestampMs,
    runId: input.runId,
    parentRunId: input.parentRunId,
    reason: input.reason,
    message: input.message,
  });
  if (conclusionIndex < 0) {
    return appendRuntimeEvent(input.runtimeEvents, abort);
  }
  return [
    ...input.runtimeEvents.slice(0, conclusionIndex),
    abort,
    ...input.runtimeEvents.slice(conclusionIndex),
  ];
}

function quarantineRestoredLocalFastEntry(input: {
  entry: WorkspaceTurnQueueEntry;
  sessionKey: string;
  taskFlow: TaskBlock[];
  conversationTurns: ConversationTurn[];
  runtimeEvents: MainThreadEvent[];
  at: number;
  workspacePath?: string | null;
  reservedTaskBlockIds?: readonly number[];
}): {
  taskFlow: TaskBlock[];
  conversationTurns: ConversationTurn[];
  runtimeEvents: MainThreadEvent[];
  presentationTurnId: string;
} {
  const sourceTurnId = input.entry.receipt.turnId;
  const sourceStarts = input.runtimeEvents.filter(
    (event): event is Extract<MainThreadEvent, { type: "run.started" }> =>
      event.type === "run.started" &&
      event.threadId === input.sessionKey &&
      event.turnId === sourceTurnId,
  );
  const useChinese = /[^\x00-\x7F]/.test(input.entry.instruction.payload.text);
  const quarantineSummary = useChinese
    ? "应用重启时无法确认这条本地命令是否已经执行。为避免重复副作用，MAIN 未自动重放，并将本回合以错误结论收口；请发送一条新指令重试。"
    : "MAIN could not prove whether this local command already executed before restart. To prevent a duplicate side effect, it was not replayed; this turn is closed with an error. Submit a new instruction to retry.";
  const projection = reconcileWorkspaceInstructionProjection({
    entry: input.entry,
    taskFlow: input.taskFlow,
    conversationTurns: input.conversationTurns,
    userContextItems: buildWorkspaceInstructionUserContext({
      contextMentions: input.entry.instruction.payload.contextMentions
        ? [...input.entry.instruction.payload.contextMentions]
        : [],
      attachedFiles: input.entry.instruction.payload.attachedFiles
        ? input.entry.instruction.payload.attachedFiles.map((file) => ({ ...file }))
        : [],
      images: input.entry.instruction.payload.images
        ? [...input.entry.instruction.payload.images]
        : [],
      workspace: input.workspacePath || "",
      language: useChinese ? "zh" : "en",
    }),
    language: useChinese ? "zh" : "en",
  });
  const exactTurn = projection.disposition === "ready" &&
      projection.turn.createdAt === input.entry.receipt.acceptedAt
    ? projection.turn
    : null;
  const allSourceConclusions = input.runtimeEvents.filter(
    (event): event is Extract<MainThreadEvent, { type: "run.completed" }> =>
      event.type === "run.completed" &&
      event.threadId === input.sessionKey &&
      event.turnId === sourceTurnId,
  );
  // A crash may persist the terminal projection while omitting run.started.
  // Repair that exact immutable Turn using its recorded run owner; do not
  // invent a second Run and leave the already-completed Run orphaned.
  const latestSourceStart = sourceStarts[sourceStarts.length - 1] || null;
  const sourceRunId = latestSourceStart?.runId ||
    exactTurn?.runtimeOutcome?.runId ||
    (allSourceConclusions.length === 1 ? allSourceConclusions[0].runId : "") ||
    `run-local-fast-quarantine-${input.entry.receipt.receiptId}`;
  const sourceParentRunId = latestSourceStart
    ? latestSourceStart.parentRunId
    : exactTurn?.runtimeOutcome
    ? exactTurn.runtimeOutcome.parentRunId
    : allSourceConclusions.length === 1
    ? allSourceConclusions[0].parentRunId
    : null;
  const sourceConclusions = allSourceConclusions.filter(
    (event) => event.runId === sourceRunId,
  );
  const existingSourceConclusion = sourceConclusions[0];
  const turnConclusions = input.runtimeEvents.filter(
    (event): event is Extract<MainThreadEvent, { type: "turn.completed" }> =>
      event.type === "turn.completed" &&
      event.threadId === input.sessionKey &&
      event.turnId === sourceTurnId,
  );
  const existingTurnConclusion = turnConclusions[0];
  const preservedSummary = String(existingSourceConclusion?.summary || "").trim();
  const resultKind = existingSourceConclusion?.resultKind ||
    existingTurnConclusion?.resultKind ||
    "error";
  const directSummary = preservedSummary || quarantineSummary;
  const exactOutcome = exactTurn?.runtimeOutcome;
  const existingSourceParentMatches = !existingSourceConclusion ||
    existingSourceConclusion.parentRunId === sourceParentRunId;
  const exactOutcomeOwnerMatches = !exactOutcome ||
    (
      exactOutcome.runId === sourceRunId &&
      exactOutcome.parentRunId === sourceParentRunId
    );
  const trustedExactOutcomeSummary = exactOutcome?.status === "completed" &&
      exactOutcomeOwnerMatches
    ? String(exactTurn?.summary || "").trim()
    : "";
  const canPreserveExactOutcome = !!trustedExactOutcomeSummary &&
    exactOutcome?.status === "completed" &&
    exactOutcome.resultKind === resultKind;
  const allSourceConclusionsMatchOwner = allSourceConclusions.length ===
      sourceConclusions.length &&
    allSourceConclusions.every((event) =>
      event.runId === sourceRunId && event.parentRunId === sourceParentRunId
    );
  const existingTerminalOrderIsValid = !existingTurnConclusion ||
    (
      !!existingSourceConclusion &&
      input.runtimeEvents.indexOf(existingSourceConclusion) <
        input.runtimeEvents.indexOf(existingTurnConclusion)
    );
  const canCloseExactTurn = !!exactTurn &&
    sourceStarts.length <= 1 &&
    sourceConclusions.length <= 1 &&
    existingSourceParentMatches &&
    exactOutcomeOwnerMatches &&
    allSourceConclusionsMatchOwner &&
    existingTerminalOrderIsValid &&
    turnConclusions.length <= 1 &&
    (!existingTurnConclusion || existingTurnConclusion.resultKind === resultKind) &&
    (!existingSourceConclusion || !!preservedSummary);
  let runtimeEvents = input.runtimeEvents;
  // A terminal record without a start is still useful owner evidence. Insert
  // the missing start before its first terminal event so replay/golden traces
  // retain the required start -> run.completed -> turn.completed order.
  for (const conclusion of allSourceConclusions) {
    runtimeEvents = insertRestoredRunStartBeforeTerminal({
      runtimeEvents,
      sessionKey: input.sessionKey,
      turnId: sourceTurnId,
      runId: conclusion.runId,
      parentRunId: conclusion.parentRunId,
      timestampMs: Math.min(input.at, conclusion.timestampMs),
    });
    runtimeEvents = insertRestoredRunConclusionBeforeTurnTerminal({
      runtimeEvents,
      sessionKey: input.sessionKey,
      turnId: sourceTurnId,
      runId: conclusion.runId,
      parentRunId: conclusion.parentRunId,
      timestampMs: conclusion.timestampMs,
      resultKind: conclusion.resultKind || "success",
      summary: String(conclusion.summary || ""),
    });
  }
  if (sourceStarts.length === 0) {
    const firstSourceTerminalAt = Math.min(
      ...[
        ...sourceConclusions.map((event) => event.timestampMs),
        ...turnConclusions.map((event) => event.timestampMs),
      ].filter((timestampMs) => Number.isFinite(timestampMs)),
    );
    runtimeEvents = insertRestoredRunStartBeforeTerminal({
      runtimeEvents,
      sessionKey: input.sessionKey,
      turnId: sourceTurnId,
      runId: sourceRunId,
      parentRunId: sourceParentRunId,
      timestampMs: Number.isFinite(firstSourceTerminalAt)
        ? Math.min(input.at, firstSourceTerminalAt)
        : input.at,
    });
  }
  // Corrupt traces may contain more than one admitted source Run. Every old
  // Run is closed before the receipt leaves FIFO; none is silently abandoned.
  for (const sourceStart of sourceStarts) {
    const hasConclusion = runtimeEvents.some((event) =>
      event.type === "run.completed" &&
      event.threadId === input.sessionKey &&
      event.turnId === sourceTurnId &&
      event.runId === sourceStart.runId
    );
    if (hasConclusion) continue;
    runtimeEvents = insertRestoredRunConclusionBeforeTurnTerminal({
      runtimeEvents,
      sessionKey: input.sessionKey,
      turnId: sourceTurnId,
      timestampMs: existingTurnConclusion
        ? Math.min(input.at, existingTurnConclusion.timestampMs)
        : input.at,
      runId: sourceStart.runId,
      parentRunId: sourceStart.parentRunId,
      resultKind: sourceStart.runId === sourceRunId && canCloseExactTurn
        ? resultKind
        : "error",
      summary: sourceStart.runId === sourceRunId && canCloseExactTurn
        ? directSummary
        : quarantineSummary,
    });
  }
  if (!existingSourceConclusion) {
    const nowHasSourceConclusion = runtimeEvents.some((event) =>
      event.type === "run.completed" &&
      event.threadId === input.sessionKey &&
      event.turnId === sourceTurnId &&
      event.runId === sourceRunId
    );
    if (!nowHasSourceConclusion) {
      runtimeEvents = insertRestoredRunConclusionBeforeTurnTerminal({
        runtimeEvents,
        sessionKey: input.sessionKey,
        turnId: sourceTurnId,
        timestampMs: existingTurnConclusion
          ? Math.min(input.at, existingTurnConclusion.timestampMs)
          : input.at,
        runId: sourceRunId,
        parentRunId: sourceParentRunId,
        resultKind: canCloseExactTurn || canPreserveExactOutcome
          ? resultKind
          : "error",
        summary: canCloseExactTurn
          ? directSummary
          : canPreserveExactOutcome
          ? trustedExactOutcomeSummary
          : quarantineSummary,
      });
    }
  }

  if (canCloseExactTurn) {
    runtimeEvents = appendRuntimeEvent(runtimeEvents, withEventSchema({
      type: "turn.completed",
      threadId: input.sessionKey,
      turnId: sourceTurnId,
      timestampMs: input.at,
      resultKind,
    }));
    const canonical = canonicalizeRestoredTerminalTurnFinal({
      taskFlow: projection.disposition === "ready" ? projection.taskFlow : input.taskFlow,
      conversationTurns: projection.disposition === "ready"
        ? projection.conversationTurns
        : input.conversationTurns,
      turnId: sourceTurnId,
      resultKind,
      runId: sourceRunId,
      parentRunId: sourceParentRunId,
      completedAt: input.at,
      runSummary: directSummary,
      finalText: directSummary,
      forceFinalText: true,
      markerReason: "local_fast_restart_quarantined",
      reservedTaskBlockIds: input.reservedTaskBlockIds,
    });
    return {
      ...canonical,
      runtimeEvents,
      presentationTurnId: sourceTurnId,
    };
  }

  let recoveryBaseTaskFlow = input.taskFlow;
  let recoveryBaseConversationTurns = input.conversationTurns;
  if (exactTurn && turnConclusions.length === 0) {
    // Identity is still the admitted receipt, but its persisted Run set is
    // corrupt. Close that exact source Turn before adding the diagnostic child
    // so every admitted Turn retains one terminal lifecycle event.
    runtimeEvents = appendRuntimeEvent(runtimeEvents, withEventSchema({
      type: "turn.completed",
      threadId: input.sessionKey,
      turnId: sourceTurnId,
      timestampMs: input.at,
      resultKind: "error",
    }));
    const closedSource = canonicalizeRestoredTerminalTurnFinal({
      taskFlow: projection.disposition === "ready" ? projection.taskFlow : input.taskFlow,
      conversationTurns: projection.disposition === "ready"
        ? projection.conversationTurns
        : input.conversationTurns,
      turnId: sourceTurnId,
      resultKind: "error",
      runId: sourceRunId,
      parentRunId: sourceParentRunId,
      completedAt: input.at,
      runSummary: quarantineSummary,
      finalText: quarantineSummary,
      forceFinalText: true,
      markerReason: "local_fast_restart_source_trace_corrupt",
      reservedTaskBlockIds: input.reservedTaskBlockIds,
    });
    recoveryBaseTaskFlow = closedSource.taskFlow;
    recoveryBaseConversationTurns = closedSource.conversationTurns;
  }

  const safeReceiptId = input.entry.receipt.receiptId
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "receipt";
  const baseRecoveryTurnId = `local-slash-recovery-${safeReceiptId}`;
  let recoveryTurnId = baseRecoveryTurnId;
  let suffix = 2;
  const recoveryTurnIdOccupied = (turnId: string) =>
    recoveryBaseConversationTurns.some((turn) => turn.id === turnId) ||
    recoveryBaseTaskFlow.some((block) => block.turnId === turnId) ||
    runtimeEvents.some((event) => "turnId" in event && event.turnId === turnId);
  while (recoveryTurnIdOccupied(recoveryTurnId)) {
    recoveryTurnId = `${baseRecoveryTurnId}-${suffix}`;
    suffix += 1;
  }
  const recoveryRunId = `${sourceRunId}-restart-quarantine`;
  const recoveryUserBlockId = nextRestoredTaskBlockId(
    recoveryBaseTaskFlow,
    recoveryBaseConversationTurns,
    input.reservedTaskBlockIds,
  );
  const recoveryFinalBlockId = nextRestoredTaskBlockId(
    [...recoveryBaseTaskFlow, {
      id: recoveryUserBlockId,
      turnId: recoveryTurnId,
      type: "user",
      content: input.entry.instruction.payload.text,
    }],
    recoveryBaseConversationTurns,
    input.reservedTaskBlockIds,
  );
  runtimeEvents = appendRuntimeEvent(runtimeEvents, withEventSchema({
    type: "run.started",
    threadId: input.sessionKey,
    turnId: recoveryTurnId,
    timestampMs: input.at,
    runId: recoveryRunId,
    parentRunId: sourceRunId,
  }));
  runtimeEvents = appendRuntimeEvent(runtimeEvents, withEventSchema({
    type: "run.completed",
    threadId: input.sessionKey,
    turnId: recoveryTurnId,
    timestampMs: input.at,
    runId: recoveryRunId,
    parentRunId: sourceRunId,
    resultKind: "error",
    summary: quarantineSummary,
  }));
  runtimeEvents = appendRuntimeEvent(runtimeEvents, withEventSchema({
    type: "turn.completed",
    threadId: input.sessionKey,
    turnId: recoveryTurnId,
    timestampMs: input.at,
    resultKind: "error",
  }));
  return {
    taskFlow: [
      ...recoveryBaseTaskFlow,
      {
        id: recoveryUserBlockId,
        turnId: recoveryTurnId,
        type: "user",
        content: input.entry.instruction.payload.text,
      },
      {
        id: recoveryFinalBlockId,
        turnId: recoveryTurnId,
        type: "agent",
        content: quarantineSummary,
        streaming: false,
        visibility: "assistant_final",
      },
    ],
    conversationTurns: [
      ...recoveryBaseConversationTurns,
      {
        id: recoveryTurnId,
        userPrompt: input.entry.instruction.payload.text,
        title: useChinese ? "本地命令恢复隔离" : "Local command recovery quarantine",
        intentSummary: quarantineSummary,
        mode: "chat",
        intent: "respond",
        displayIntent: "respond",
        status: "error",
        summary: quarantineSummary,
        blockIds: [recoveryUserBlockId, recoveryFinalBlockId],
        processCollapsed: false,
        collapsed: false,
        createdAt: input.entry.receipt.acceptedAt,
        runtimeOutcome: {
          status: "completed",
          reason: "local_fast_restart_quarantined",
          resultKind: "error",
          runId: recoveryRunId,
          parentRunId: sourceRunId,
          updatedAt: input.at,
        },
      },
    ],
    runtimeEvents,
    presentationTurnId: recoveryTurnId,
  };
}



function normalizeStoredPlanExecutionProgressSnapshot(
  value: unknown,
  migratedCurrentTaskId?: string,
): PlanExecutionProgressSnapshot | null {
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
      currentTaskId: typeof snapshot.currentTaskId === "string"
        ? snapshot.currentTaskId
        : migratedCurrentTaskId,
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
    "run.aborted",
    "run.failed",
    "item.started",
    "item.updated",
    "item.completed",
    "error",
  ]);

  let normalized: MainThreadEvent[] = [];
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
      const event = normalizePersistedMainThreadEvent(
        eventRecord as MainThreadEventInput | LegacyFailedMainThreadEvent,
      );
      normalized = appendRuntimeEvent(normalized, event);
      // Persisted abort-only traces predate the unique Run conclusion. Repair
      // them at the read boundary so live consumers always see the canonical
      // cancellation sequence before any Turn conclusion.
      if (event.type === "run.aborted") {
        normalized = appendRuntimeEvent(normalized, withEventSchema({
          type: "run.completed",
          threadId: event.threadId,
          turnId: event.turnId,
          timestampMs: event.timestampMs,
          runId: event.runId,
          parentRunId: event.parentRunId,
          ...(event.goalSliceId ? { goalSliceId: event.goalSliceId } : {}),
          resultKind: "canceled",
          summary: event.message || event.reason,
        }));
      }
    } catch {
      // ignore malformed runtime events
    }
  }

  return normalized;
}

function isActionRequestOwnedByGoalForDeletion(input: {
  request: ActionRequest | null;
  marker: HarnessRunMarker | null;
  goal: GoalDefinition | null;
}): boolean {
  const { request, marker, goal } = input;
  if (!request || !marker || !goal) return false;
  return resolveGoalActionRequestOwnership({
    goal,
    marker,
    currentWorkspace: marker.workspace,
    currentSessionKey: marker.sessionKey,
    actionRequest: request,
  }).owned;
}

function summarizeRestoredTerminalResult(
  resultKind: "success" | "partial" | "blocked" | "error" | "canceled",
  useChinese: boolean,
): string {
  switch (resultKind) {
    case "success":
      return useChinese
        ? "运行已成功完成；恢复时清理了不一致的待处理控件。"
        : "The run completed successfully; inconsistent pending controls were cleared during restore.";
    case "partial":
      return useChinese
        ? "运行已得出部分完成结论；未完成信息已保留，恢复时清理了不一致的待处理控件。"
        : "The run concluded partially; unfinished details were retained and inconsistent pending controls were cleared during restore.";
    case "blocked":
      return useChinese
        ? "运行已收口但无法证明全部完成；阻塞信息已保留，恢复时清理了不一致的待处理控件。"
        : "The run concluded without proof of full completion; blocker details were retained and inconsistent pending controls were cleared during restore.";
    case "canceled":
      return useChinese
        ? "运行已取消；恢复时清理了不一致的待处理控件。"
        : "The run was canceled; inconsistent pending controls were cleared during restore.";
    case "error":
      return useChinese
        ? "运行已得出错误结论；恢复时清理了不一致的待处理控件。"
        : "The run concluded with an error; inconsistent pending controls were cleared during restore.";
  }
}

export function normalizeSessionRuntimeSnapshot(
  snapshot: Partial<SessionRuntimeSnapshot> | null | undefined,
  options?: {
    restoreInterruptedGoal?: boolean;
    workspacePath?: string | null;
    expectedSessionKey?: string | null;
    expectedSessionEpoch?: string | null;
    /** True only while hydrating a persisted snapshot after process loss. */
    quarantineInterruptedLocalFast?: boolean;
  },
): SessionRuntimeSnapshot | undefined {
  if (!snapshot) return undefined;
  const expectedContainerSessionKey = String(options?.expectedSessionKey || "").trim();
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
  const persistedWorkspaceQueueEntries = Array.isArray(
    snapshot.workspaceTurnQueue?.entries,
  )
    ? snapshot.workspaceTurnQueue.entries
    : [];
  const reservedWorkspaceInstructionBlockIds = persistedWorkspaceQueueEntries.flatMap((entry) => {
    const blockId = Number(entry?.receipt?.userBlockId);
    return Number.isSafeInteger(blockId) && blockId > 0 ? [blockId] : [];
  });
  const normalizedContextMemoryState = normalizeContextMemoryState(snapshot.contextMemoryState);
  const queuedUserMessageCandidate = normalizeQueuedUserMessage(snapshot.queuedUserMessage);
  const queuedUserMessageOwnerKeys = queuedUserMessageCandidate
    ? [
        queuedUserMessageCandidate.sessionKey,
        queuedUserMessageCandidate.goalContinuationAuthorization?.sessionKey,
      ].filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    : [];
  const queuedUserMessage = queuedUserMessageCandidate && (
    !expectedContainerSessionKey ||
    (
      queuedUserMessageOwnerKeys.length > 0 &&
      queuedUserMessageOwnerKeys.every((sessionKey) => sessionKey === expectedContainerSessionKey)
    )
  )
    ? queuedUserMessageCandidate
    : null;
  const activeGuidance = normalizeActiveGuidance(snapshot.activeGuidance);
  const migratedLegacyGoalCandidate = snapshot.activeGoal
    ? migrateGoalDefinition(snapshot.activeGoal)
    : null;
  const migratedRuntimeGoalCandidate = snapshot.goalRuntime?.goal
    ? migrateGoalDefinition(snapshot.goalRuntime.goal)
    : null;
  const progressForAcceptedGoal = (
    goal: GoalDefinition,
    progress: GoalProgress | null | undefined,
  ): GoalProgress => progress?.goalId === goal.id
    ? { ...progress }
    : createGoalProgress(goal.id, "");
  const legacyWorkspaceGoalSessionKey = String(options?.workspacePath || "").trim();
  const snapshotConversationTurnIds = new Set(
    (snapshot.conversationTurns || [])
      .map((turn) => String(turn?.id || "").trim())
      .filter(Boolean),
  );
  const snapshotRuntimeEvents = normalizeRuntimeEvents(snapshot.runtimeEvents);
  const hasLegacyGoalOwnerEvidence = (goal: GoalDefinition): boolean => {
    const ownerTurnId = String(goal.ownerTurnId || "").trim();
    if (!ownerTurnId) return false;
    if (snapshotConversationTurnIds.has(ownerTurnId)) return true;
    return snapshotRuntimeEvents.some((event) =>
      event.threadId === expectedContainerSessionKey &&
      "turnId" in event &&
      event.turnId === ownerTurnId
    );
  };
  const goalMatchesExpectedContainer = (goal: GoalDefinition | null): boolean =>
    !goal ||
    !expectedContainerSessionKey ||
    goal.sessionKey === expectedContainerSessionKey ||
    (
      (
        !String(goal.sessionKey || "").trim() ||
        (!!legacyWorkspaceGoalSessionKey && goal.sessionKey === legacyWorkspaceGoalSessionKey)
      ) &&
      hasLegacyGoalOwnerEvidence(goal)
    );
  const migratedLegacyGoal = goalMatchesExpectedContainer(migratedLegacyGoalCandidate)
    ? migratedLegacyGoalCandidate
    : null;
  const migratedLegacyGoalProgress = migratedLegacyGoal
    ? progressForAcceptedGoal(migratedLegacyGoal, snapshot.goalProgress)
    : null;
  const restoredRuntime = snapshot.goalRuntime &&
    migratedRuntimeGoalCandidate &&
    [2, 3].includes(Number(snapshot.goalRuntime.schemaVersion)) &&
    goalMatchesExpectedContainer(migratedRuntimeGoalCandidate)
    ? {
        ...snapshot.goalRuntime,
        goal: migratedRuntimeGoalCandidate,
        progress: progressForAcceptedGoal(
          migratedRuntimeGoalCandidate,
          snapshot.goalRuntime.progress,
        ),
      }
    : migratedLegacyGoal
      ? buildGoalRuntimeSnapshot({
          goal: migratedLegacyGoal,
          progress: migratedLegacyGoalProgress || createGoalProgress(migratedLegacyGoal.id, ""),
          phase: null,
        })
      : null;
  const candidateNormalizedGoalRuntime = restoredRuntime
    ? options?.restoreInterruptedGoal
      ? restoreGoalRuntimeSnapshot(restoredRuntime)
      : normalizeGoalRuntimeSnapshot(restoredRuntime)
    : null;
  const restoredGoalCandidate = candidateNormalizedGoalRuntime?.goal || migratedLegacyGoal;
  const goalDeletionFenced = !!(
    options?.workspacePath &&
    restoredGoalCandidate?.id &&
    isGoalRuntimeDeleted(options.workspacePath, restoredGoalCandidate.id)
  );
  const legacyGoal = goalDeletionFenced ? null : migratedLegacyGoal;
  const normalizedGoalRuntime = goalDeletionFenced
    ? null
    : candidateNormalizedGoalRuntime;
  const restoredQueuedUserMessage = goalDeletionFenced &&
    queuedUserMessage?.goalContinuationAuthorization?.goalId === restoredGoalCandidate?.id
    ? null
    : queuedUserMessage;
  const unapprovedPlanTurnIds = (snapshot.conversationTurns || [])
    .filter((turn) => isPlanConversationTurn(turn))
    .map((turn) => turn.id);
  const restoredPlanArtifacts = sanitizeRestoredPlanArtifacts({
    artifacts: snapshot.planArtifacts || [],
    isPlanApproved: snapshot.isPlanApproved === true,
  });
  const persistedPlanIdentity = buildPlanApprovalIdentity(snapshot.planArtifacts || []);
  const restoredPlanIdentity = buildPlanApprovalIdentity(restoredPlanArtifacts.artifacts);
  const actionRequestCandidate = normalizeActionRequest(snapshot.activeActionRequest);
  const originalActionRequest = actionRequestCandidate && (
    !expectedContainerSessionKey ||
    actionRequestCandidate.sessionKey === expectedContainerSessionKey
  )
    ? actionRequestCandidate
    : null;
  const rawPlanLifecycle = snapshot.planLifecycle;
  const restoredLifecycleSessionKey = String(options?.expectedSessionKey || "").trim() ||
    UNBOUND_PLAN_SESSION_KEY;
  const suppliedLifecycleSessionEpoch = String(options?.expectedSessionEpoch || "").trim();
  const restoredLifecycleSessionEpoch = suppliedLifecycleSessionEpoch || (
    restoredLifecycleSessionKey === UNBOUND_PLAN_SESSION_KEY
      ? UNBOUND_PLAN_SESSION_EPOCH
      : createPlanLifecycleSessionEpoch(Date.now())
  );
  const rawPlanOwnerMatchesContainer = !!rawPlanLifecycle &&
    !!suppliedLifecycleSessionEpoch &&
    rawPlanLifecycle.sessionKey === restoredLifecycleSessionKey &&
    rawPlanLifecycle.sessionEpoch === restoredLifecycleSessionEpoch;
  const restoredReviewIdentity: PlanReviewIdentity | null = rawPlanOwnerMatchesContainer
    ? rawPlanLifecycle.reviewIdentity || null
    : null;
  const candidateRestoredPlanLifecycle = migrateLegacyPlanLifecycle({
    version: rawPlanLifecycle?.version,
    status: rawPlanLifecycle?.status,
    sessionKey: restoredLifecycleSessionKey,
    sessionEpoch: restoredLifecycleSessionEpoch,
    planTurnId: rawPlanLifecycle?.planTurnId || snapshot.currentTurnId || null,
    artifactIdentity: restoredPlanIdentity,
    reviewIdentity: restoredReviewIdentity,
    approvalLease: rawPlanOwnerMatchesContainer ? rawPlanLifecycle?.approvalLease || null : null,
    executionLease: rawPlanOwnerMatchesContainer ? rawPlanLifecycle?.executionLease || null : null,
    lastIssuedAttempt: rawPlanOwnerMatchesContainer ? rawPlanLifecycle?.lastIssuedAttempt : 0,
    execution: rawPlanOwnerMatchesContainer ? rawPlanLifecycle?.execution || null : null,
    isPlanApproved: snapshot.planStage === "completed" ? false : snapshot.isPlanApproved === true,
    planStage: snapshot.planStage,
    updatedAt: rawPlanLifecycle?.updatedAt,
  });
  const rejectedReviewablePlanArtifact = restoredPlanArtifacts.rejected.some((artifact) =>
    artifact.kind === "plan" || artifact.kind === "design" || artifact.kind === "bugfix"
  );
  const restoredArtifactTaskSeed = restoredPlanArtifacts.artifacts
    .filter((artifact) => artifact.kind === "tasks")
    .flatMap((artifact) => extractPlanTasks(artifact.content));
  const rederivedPlanTasks = ensureApprovedPlanRuntimeTasksForState({
    planArtifacts: restoredPlanArtifacts.artifacts,
    planTasks: restoredArtifactTaskSeed,
    planExecutionEvidenceLedger: snapshot.planExecutionEvidenceLedger || [],
    // Identity migration must inspect the neutral reviewed graph. Marking an
    // arbitrary first task in_progress before the legacy checkpoint is
    // resolved would turn an ambiguous same-file graph into a false match.
    isPlanApproved: false,
    currentTurnId: snapshot.currentTurnId ?? null,
    conversationTurns: (snapshot.conversationTurns || []).map((turn) => ({
      id: turn.id,
      userPrompt: turn.userPrompt || "",
    })),
  }, "zh");
  const restoredExecutionReadiness = evaluateApprovedPlanExecutionReadiness({
    planArtifacts: restoredPlanArtifacts.artifacts,
    executionPlanTasks: rederivedPlanTasks,
  });
  const restoredTaskIdentity = resolveRestoredPlanExecutionTaskIdentity({
    snapshot: snapshot.planExecutionProgressSnapshot,
    tasks: rederivedPlanTasks,
  });
  const harnessRunMarkerCandidate = normalizeHarnessRunMarker(snapshot.harnessRunMarker);
  const normalizedHarnessRunMarker = harnessRunMarkerCandidate && (
    !expectedContainerSessionKey ||
    harnessRunMarkerCandidate.sessionKey === expectedContainerSessionKey
  )
    ? harnessRunMarkerCandidate
    : null;
  const restoredProgress = snapshot.planExecutionProgressSnapshot;
  const expectedProgressTurnId = snapshot.currentTurnId ||
    snapshot.planApprovalExecutionStartedForTurnId ||
    null;
  const progressTurnOwnerValid = !restoredProgress || (
    typeof restoredProgress.turnId === "string" &&
    restoredProgress.turnId.length > 0 &&
    (!expectedProgressTurnId || restoredProgress.turnId === expectedProgressTurnId) &&
    (snapshot.conversationTurns || []).some((turn) =>
      turn.id === restoredProgress.turnId && isPlanConversationTurn(turn)
    )
  );
  const restoredActionRunId = getHarnessActionRunId(normalizedHarnessRunMarker);
  const restoredActionParentRunId = normalizedHarnessRunMarker?.activeParentRunId ||
    normalizedHarnessRunMarker?.parentRunId ||
    null;
  const progressRunOwnerValid = !restoredProgress?.runId || Boolean(
    restoredActionRunId === restoredProgress.runId &&
    restoredActionParentRunId === (restoredProgress.parentRunId || null) &&
    normalizedHarnessRunMarker?.turnId === restoredProgress.turnId
  );
  const hasExactRestoredPlanApprovalCapability =
    rawPlanOwnerMatchesContainer &&
    isPlanApprovalLeaseBoundToState(candidateRestoredPlanLifecycle) &&
    !rejectedReviewablePlanArtifact &&
    restoredExecutionReadiness.ok &&
    !restoredTaskIdentity.ambiguous &&
    progressTurnOwnerValid &&
    progressRunOwnerValid &&
    !!persistedPlanIdentity &&
    !!restoredPlanIdentity &&
    persistedPlanIdentity.revision === restoredPlanIdentity.revision &&
    persistedPlanIdentity.artifactHash === restoredPlanIdentity.artifactHash;
  // Restart restoration never grants active execution authority. An exact
  // approval capability can be retained only for a new explicit-resume lease.
  const restoredIsPlanApproved = false;
  const hasTasksArtifact = restoredPlanArtifacts.artifacts.some((artifact) =>
    artifact.kind === "tasks" || artifact.kind === "bugfix"
  );
  const restoredApprovedPlanTasks = restoredTaskIdentity.currentTaskId
    ? rederivedPlanTasks.map((task) => {
        if (task.status === "completed" || task.evidenceStatus === "satisfied") return task;
        return {
          ...task,
          status: task.id === restoredTaskIdentity.currentTaskId
            ? "in_progress" as const
            : "pending" as const,
        };
      })
    : rederivedPlanTasks;
  const restoredPlanTasks = hasExactRestoredPlanApprovalCapability || hasTasksArtifact
    ? hasExactRestoredPlanApprovalCapability
      ? restoredApprovedPlanTasks
      : restoredArtifactTaskSeed
    : [];
  const restoredPlanStage = hasExactRestoredPlanApprovalCapability
    ? "ready_to_execute" as const
    : snapshot.isPlanApproved === true
    ? "plan" as const
    : derivePlanStageFromArtifacts(
        restoredPlanArtifacts.artifacts,
        restoredPlanTasks,
        restoredIsPlanApproved,
        snapshot.planStage ?? "idle",
      );
  const interruptedHarnessRunMarker = normalizedHarnessRunMarker?.status === "running"
    ? {
        ...normalizedHarnessRunMarker,
        status: "paused" as const,
        closedAt: normalizedHarnessRunMarker.closedAt || Date.now(),
        closeReason: normalizedHarnessRunMarker.closeReason || "application_restarted",
      }
    : normalizedHarnessRunMarker;
  const restoredHarnessRunMarker = interruptedHarnessRunMarker && !(
    goalDeletionFenced &&
    interruptedHarnessRunMarker.runtimeIntent === "goal" &&
    interruptedHarnessRunMarker.turnId === restoredGoalCandidate?.ownerTurnId &&
    (
      !restoredGoalCandidate?.sessionKey ||
      interruptedHarnessRunMarker.sessionKey === restoredGoalCandidate.sessionKey
    )
  )
    ? {
        ...interruptedHarnessRunMarker,
        planStage: restoredPlanStage,
        isPlanApproved: restoredIsPlanApproved,
      }
    : null;
  const deletionOwnedActionRequest = goalDeletionFenced &&
    isActionRequestOwnedByGoalForDeletion({
      request: originalActionRequest,
      marker: interruptedHarnessRunMarker,
      goal: restoredGoalCandidate,
    });
  const restoredActionRequestCandidate = restorePendingActionRequest({
        request: deletionOwnedActionRequest ? null : originalActionRequest,
        runOwner: restoredHarnessRunMarker,
        planIdentity: restoredPlanIdentity,
        taskFlow: rawTaskFlow,
        goalRuntime: normalizedGoalRuntime,
        unapprovedPlanTurnIds: restoredIsPlanApproved ? [] : unapprovedPlanTurnIds,
      });
  const lifecycleReview = candidateRestoredPlanLifecycle.reviewIdentity;
  const restoredActionRequest = restoredActionRequestCandidate?.kind === "plan_review"
    ? candidateRestoredPlanLifecycle.status === "awaiting_approval" &&
        !!lifecycleReview &&
        lifecycleReview.sessionKey === restoredActionRequestCandidate.sessionKey &&
        lifecycleReview.sessionEpoch === restoredLifecycleSessionEpoch &&
        lifecycleReview.turnId === restoredActionRequestCandidate.turnId &&
        lifecycleReview.runId === restoredActionRequestCandidate.runId &&
        lifecycleReview.parentRunId === (restoredActionRequestCandidate.parentRunId || null) &&
        lifecycleReview.requestId === restoredActionRequestCandidate.requestId &&
        lifecycleReview.planRevision === restoredActionRequestCandidate.planRevision &&
        lifecycleReview.artifactHash === restoredActionRequestCandidate.artifactHash &&
        JSON.stringify([...lifecycleReview.artifactPaths].sort()) ===
          JSON.stringify([...restoredActionRequestCandidate.artifactPaths].map(canonicalizePlanArtifactPath).sort()) &&
        restoredHarnessRunMarker?.sessionKey === restoredActionRequestCandidate.sessionKey &&
        restoredHarnessRunMarker.turnId === restoredActionRequestCandidate.turnId &&
        getHarnessActionRunId(restoredHarnessRunMarker) === restoredActionRequestCandidate.runId
      ? restoredActionRequestCandidate
      : null
    : restoredActionRequestCandidate;
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
  let restoredPlanLifecycle = candidateRestoredPlanLifecycle;
  if (!hasExactRestoredPlanApprovalCapability && restoredPlanLifecycle.approvalLease) {
    restoredPlanLifecycle = migrateLegacyPlanLifecycle({
      version: restoredPlanLifecycle.version,
      status: "paused",
      sessionKey: restoredPlanLifecycle.sessionKey,
      sessionEpoch: restoredPlanLifecycle.sessionEpoch,
      planTurnId: restoredPlanLifecycle.planTurnId,
      artifactIdentity: restoredPlanLifecycle.artifactIdentity,
      reviewIdentity: null,
      approvalLease: null,
      isPlanApproved: true,
      planStage: restoredPlanStage,
      updatedAt: restoredPlanLifecycle.updatedAt,
    });
  }
  if (
    restoredPlanLifecycle.status === "awaiting_approval" &&
    restoredActionRequest?.kind !== "plan_review" &&
    restoredPlanLifecycle.planTurnId
  ) {
    const downgraded = reducePlanLifecycle(restoredPlanLifecycle, {
      type: "start_drafting",
      expectedVersion: restoredPlanLifecycle.version,
      at: restoredPlanLifecycle.updatedAt,
      planTurnId: restoredPlanLifecycle.planTurnId,
      artifactIdentity: restoredPlanLifecycle.artifactIdentity,
    });
    if (downgraded.disposition !== "rejected") {
      restoredPlanLifecycle = downgraded.state;
    }
  }
  let invalidatedChoiceText = "";
  let taskFlow = rawTaskFlow.map((block) => {
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
  const restoredRuntimeEvents = normalizeRuntimeEvents(snapshot.runtimeEvents).filter(
    (event) => !expectedContainerSessionKey || event.threadId === expectedContainerSessionKey,
  );
  const restoredMarkerRunId = getHarnessActionRunId(restoredHarnessRunMarker);
  const restoredMarkerRunConclusion = restoredMarkerRunId
    ? [...restoredRuntimeEvents].reverse().find((event): event is Extract<MainThreadEvent, { type: "run.completed" }> =>
        event.type === "run.completed" &&
        event.threadId === restoredHarnessRunMarker?.sessionKey &&
        event.turnId === restoredHarnessRunMarker?.turnId &&
        event.runId === restoredMarkerRunId
      )
    : undefined;
  const restoredMarkerRunAbort = restoredMarkerRunId
    ? [...restoredRuntimeEvents].reverse().find((event): event is Extract<MainThreadEvent, { type: "run.aborted" }> =>
        event.type === "run.aborted" &&
        event.threadId === restoredHarnessRunMarker?.sessionKey &&
        event.turnId === restoredHarnessRunMarker?.turnId &&
        event.runId === restoredMarkerRunId
      )
    : undefined;
  const restoredMarkerTerminalStatus = restoredHarnessRunMarker?.status === "completed" || restoredHarnessRunMarker?.status === "error"
    ? restoredHarnessRunMarker.status
    : null;
  let conversationTurns = normalizeInterruptedConversationTurnsForRestore(
    snapshot.conversationTurns,
    taskFlow,
  ).map((turn) => {
    const ownsTerminalMarker = !!restoredMarkerTerminalStatus && restoredHarnessRunMarker?.turnId === turn.id;
    const hasRecoverableAwaitingState = turn.status === "awaiting_input" || turn.status === "awaiting_approval";
    if (!ownsTerminalMarker && !hasRecoverableAwaitingState) return turn;
    if (!ownsTerminalMarker && restoredActionRequest?.turnId === turn.id) return turn;
    const ownsInvalidatedRequest = invalidatedActionRequest?.turnId === turn.id;
    const useChinese = /[^\x00-\x7F]/.test(String(turn.userPrompt || ""));
    const terminalResultKind = restoredMarkerRunConclusion?.type === "run.completed" && restoredMarkerRunConclusion.resultKind
      ? restoredMarkerRunConclusion.resultKind
      : restoredHarnessRunMarker?.terminalResultKind
      ? restoredHarnessRunMarker.terminalResultKind
      : restoredMarkerTerminalStatus === "error"
      ? "error" as const
      : "blocked" as const;
    const terminalWasAborted = terminalResultKind === "canceled" && !!restoredMarkerRunAbort;
    const terminalReason = terminalWasAborted
      ? restoredMarkerRunAbort?.reason
      : restoredMarkerRunConclusion?.summary || restoredHarnessRunMarker?.closeReason;
    return {
      ...turn,
      status: ownsTerminalMarker
        ? "done" as const
        : "paused" as const,
      summary: ownsTerminalMarker
        ? summarizeRestoredTerminalResult(terminalResultKind, useChinese)
        : ownsInvalidatedRequest
        ? summarizeAssistantText(invalidatedChoiceText) || invalidatedActionMessage
        : useChinese
        ? "恢复时未找到可解析的操作请求；已移除失效控件并保留上下文。"
        : "No resolvable action request was found during restore; stale controls were removed and context was preserved.",
      ...(ownsTerminalMarker
        ? {
            runtimeOutcome: {
              status: "completed" as const,
              reason: terminalReason || "restored_terminal_checkpoint",
              resultKind: terminalResultKind,
              runId: restoredHarnessRunMarker?.activeRunId || restoredHarnessRunMarker?.runId || "restored-run",
              parentRunId: restoredHarnessRunMarker?.activeParentRunId || restoredHarnessRunMarker?.parentRunId || null,
              updatedAt: restoredHarnessRunMarker?.closedAt || restoredHarnessRunMarker?.updatedAt || Date.now(),
            },
          }
        : {}),
    };
  });
  let sanitizedHarnessRunMarker = invalidatedRequestOwnsProjectedMarkerRun && restoredHarnessRunMarker?.status === "paused"
    ? {
        ...restoredHarnessRunMarker,
        closeReason: invalidatedActionReason,
      }
    : restoredHarnessRunMarker;
  let reconciledRestoredActionRequest = restoredActionRequest;
  const invalidatedOwnerRequest = invalidatedActionRequest;
  const replacementPauseReason = invalidatedActionReason;
  const replacementPauseMessage = invalidatedActionMessage;
  let replacedOwnerPause = false;
  let runtimeEvents = restoredRuntimeEvents
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
  const ownerHasConclusion = !!invalidatedOwnerRequest && runtimeEvents.some((event) =>
    event.type === "run.completed" &&
    event.threadId === invalidatedOwnerRequest.sessionKey &&
    event.turnId === invalidatedOwnerRequest.turnId &&
    event.runId === invalidatedOwnerRequest.runId
  );
  if (invalidatedOwnerRequest && !replacedOwnerPause && !ownerHasConclusion) {
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
              resultKind: sanitizedHarnessRunMarker?.terminalResultKind || "blocked",
              summary: "Restored completed run; stale pending action controls were removed.",
            }
          : {
              type: "run.completed",
              threadId: invalidatedOwnerRequest.sessionKey,
              turnId: invalidatedOwnerRequest.turnId,
              timestampMs,
              runId: invalidatedOwnerRequest.runId,
              parentRunId: invalidatedOwnerRequest.parentRunId || null,
              resultKind: "error",
              summary: sanitizedHarnessRunMarker?.lastStreamError || sanitizedHarnessRunMarker?.closeReason || "Restored error conclusion.",
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
  const interruptedRunHasLifecycleBoundary = !!interruptedActionRunId && !!interruptedTurnId && runtimeEvents.some((event) =>
    (event.type === "run.paused" || event.type === "run.completed" || event.type === "run.aborted") &&
    event.threadId === sanitizedHarnessRunMarker?.sessionKey &&
    event.turnId === interruptedTurnId &&
    event.runId === interruptedActionRunId
  );
  if (
    sanitizedHarnessRunMarker?.status === "paused" &&
    interruptedActionRunId &&
    interruptedTurnId &&
    !interruptedRunHasLifecycleBoundary
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
  const projectedRunHasConclusion = !!interruptedActionRunId && !!interruptedTurnId && runtimeEvents.some((event) =>
    event.type === "run.completed" &&
    event.threadId === sanitizedHarnessRunMarker?.sessionKey &&
    event.turnId === interruptedTurnId &&
    event.runId === interruptedActionRunId
  );
  if (
    sanitizedHarnessRunMarker &&
    interruptedActionRunId &&
    interruptedTurnId &&
    !projectedRunHasConclusion &&
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
            resultKind: sanitizedHarnessRunMarker.terminalResultKind || "blocked",
            summary: "Restored completed run checkpoint.",
          }
        : {
            type: "run.completed",
            threadId: sanitizedHarnessRunMarker.sessionKey,
            turnId: interruptedTurnId,
            timestampMs: sanitizedHarnessRunMarker.closedAt || Date.now(),
            runId: interruptedActionRunId,
            parentRunId: sanitizedHarnessRunMarker.activeParentRunId || sanitizedHarnessRunMarker.parentRunId || null,
            resultKind: "error",
            summary: sanitizedHarnessRunMarker.lastStreamError || sanitizedHarnessRunMarker.closeReason || "Restored error conclusion.",
          }
    ));
  }
  const restoredProjectedRunConclusion = interruptedActionRunId && interruptedTurnId
    ? [...runtimeEvents].reverse().find((event) =>
        event.type === "run.completed" &&
        event.threadId === sanitizedHarnessRunMarker?.sessionKey &&
        event.turnId === interruptedTurnId &&
        event.runId === interruptedActionRunId
      )
    : undefined;
  const restoredTurnHasConclusion = !!interruptedTurnId && runtimeEvents.some((event) =>
    event.type === "turn.completed" &&
    event.threadId === sanitizedHarnessRunMarker?.sessionKey &&
    event.turnId === interruptedTurnId
  );
  if (
    sanitizedHarnessRunMarker &&
    interruptedTurnId &&
    !restoredTurnHasConclusion &&
    (sanitizedHarnessRunMarker.status === "completed" || sanitizedHarnessRunMarker.status === "error")
  ) {
    runtimeEvents = appendRuntimeEvent(runtimeEvents, withEventSchema({
      type: "turn.completed",
      threadId: sanitizedHarnessRunMarker.sessionKey,
      turnId: interruptedTurnId,
      timestampMs: sanitizedHarnessRunMarker.closedAt || Date.now(),
      resultKind: sanitizedHarnessRunMarker.status === "error"
        ? "error"
        : restoredProjectedRunConclusion?.type === "run.completed" && restoredProjectedRunConclusion.resultKind
        ? restoredProjectedRunConclusion.resultKind
        : sanitizedHarnessRunMarker.terminalResultKind || "blocked",
    }));
  }
  // A durable Turn conclusion is authoritative even when its Harness marker
  // was already cleared before a crash. Project every currently loaded Turn;
  // events for paged-out Turns remain untouched until those Turns are loaded.
  for (const loadedTurn of conversationTurns) {
    const hasColdLocalFastQueueOwner = !!options?.quarantineInterruptedLocalFast &&
      !!snapshot.workspaceTurnQueue?.entries.some((entry) =>
        entry.receipt.turnId === loadedTurn.id &&
        isRestoredLocalFastQueueEntry(entry)
      );
    if (hasColdLocalFastQueueOwner) {
      // The strict local-fast quarantine below must evaluate the persisted Turn
      // identity before generic terminal projection can select another Run.
      continue;
    }
    const restoredTurnConclusion = [...runtimeEvents].reverse().find(
      (event): event is Extract<MainThreadEvent, { type: "turn.completed" }> =>
        event.type === "turn.completed" && event.turnId === loadedTurn.id,
    );
    if (!restoredTurnConclusion) continue;
    let restoredTurnConclusionIndex = runtimeEvents.indexOf(restoredTurnConclusion);
    let restoredRunConclusions = runtimeEvents.filter(
      (event): event is Extract<MainThreadEvent, { type: "run.completed" }> =>
        event.type === "run.completed" &&
        event.threadId === restoredTurnConclusion.threadId &&
        event.turnId === loadedTurn.id &&
        runtimeEvents.indexOf(event) < restoredTurnConclusionIndex,
    );
    // Older snapshots may have persisted terminal events without their starts.
    // Repair every pre-Turn completion by exact owner before selecting the
    // authoritative completion. This is restore-only compatibility and does
    // not weaken the live writer contract.
    for (const legacyConclusion of restoredRunConclusions) {
      runtimeEvents = insertRestoredRunStartBeforeTerminal({
        runtimeEvents,
        sessionKey: legacyConclusion.threadId,
        turnId: legacyConclusion.turnId,
        runId: legacyConclusion.runId,
        parentRunId: legacyConclusion.parentRunId,
        timestampMs: Math.min(
          legacyConclusion.timestampMs,
          restoredTurnConclusion.timestampMs,
        ),
      });
    }
    restoredTurnConclusionIndex = runtimeEvents.indexOf(restoredTurnConclusion);
    restoredRunConclusions = runtimeEvents.filter(
      (event): event is Extract<MainThreadEvent, { type: "run.completed" }> =>
        event.type === "run.completed" &&
        event.threadId === restoredTurnConclusion.threadId &&
        event.turnId === loadedTurn.id &&
        runtimeEvents.indexOf(event) < restoredTurnConclusionIndex,
    );
    const orderedRunConclusions = restoredRunConclusions.filter((conclusion) => {
      const matchingStarts = runtimeEvents.filter((event) =>
        event.type === "run.started" &&
        event.threadId === conclusion.threadId &&
        event.turnId === conclusion.turnId &&
        event.runId === conclusion.runId &&
        event.parentRunId === conclusion.parentRunId
      );
      return matchingStarts.length === 1 &&
        runtimeEvents.indexOf(matchingStarts[0]) < runtimeEvents.indexOf(conclusion);
    });
    const loadedOutcome = loadedTurn.runtimeOutcome?.status === "completed"
      ? loadedTurn.runtimeOutcome
      : null;
    const turnResultKind = restoredTurnConclusion.resultKind || "success";
    const exactOutcomeConclusions = loadedOutcome
      ? orderedRunConclusions.filter((conclusion) =>
          conclusion.runId === loadedOutcome.runId &&
          conclusion.parentRunId === loadedOutcome.parentRunId &&
          (conclusion.resultKind || "success") === loadedOutcome.resultKind &&
          loadedOutcome.resultKind === turnResultKind
        )
      : [];
    const restoredRunConclusion = exactOutcomeConclusions.length === 1
      ? exactOutcomeConclusions[0]
      : [...orderedRunConclusions].reverse().find(
          (conclusion) => (conclusion.resultKind || "success") === turnResultKind,
        );
    const restoredRunAbort = [...runtimeEvents].reverse().find(
      (event): event is Extract<MainThreadEvent, { type: "run.aborted" }> =>
        event.type === "run.aborted" &&
        event.threadId === restoredTurnConclusion.threadId &&
        event.turnId === loadedTurn.id &&
        (!restoredRunConclusion || event.runId === restoredRunConclusion.runId),
    );
    const terminalMarkerOwnsTurn = !!sanitizedHarnessRunMarker &&
      sanitizedHarnessRunMarker.turnId === loadedTurn.id &&
      sanitizedHarnessRunMarker.sessionKey === restoredTurnConclusion.threadId &&
      (sanitizedHarnessRunMarker.status === "completed" || sanitizedHarnessRunMarker.status === "error");
    const resultKind = restoredTurnConclusion.resultKind ||
      restoredRunConclusion?.resultKind ||
      (terminalMarkerOwnsTurn && sanitizedHarnessRunMarker?.status === "error"
        ? "error" as const
        : "success" as const);
    const restoredFinal = canonicalizeRestoredTerminalTurnFinal({
      taskFlow,
      conversationTurns,
      turnId: loadedTurn.id,
      resultKind,
      runId: restoredRunConclusion?.runId || (
        terminalMarkerOwnsTurn ? getHarnessActionRunId(sanitizedHarnessRunMarker) : null
      ),
      parentRunId: restoredRunConclusion?.parentRunId ?? (
        terminalMarkerOwnsTurn
          ? sanitizedHarnessRunMarker?.activeParentRunId || sanitizedHarnessRunMarker?.parentRunId || null
          : undefined
      ),
      completedAt: restoredTurnConclusion.timestampMs || restoredRunConclusion?.timestampMs || (
        terminalMarkerOwnsTurn
          ? sanitizedHarnessRunMarker?.closedAt || sanitizedHarnessRunMarker?.updatedAt
          : null
      ),
      runSummary: restoredRunConclusion?.summary,
      markerError: terminalMarkerOwnsTurn ? sanitizedHarnessRunMarker?.lastStreamError : null,
      markerReason: restoredRunAbort?.reason || (
        terminalMarkerOwnsTurn ? sanitizedHarnessRunMarker?.closeReason : null
      ),
      reservedTaskBlockIds: reservedWorkspaceInstructionBlockIds,
    });
    taskFlow = restoredFinal.taskFlow;
    conversationTurns = restoredFinal.conversationTurns;
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
  const canRestoreWorkspaceQueue = suppliedLifecycleSessionEpoch &&
    restoredLifecycleSessionKey !== UNBOUND_PLAN_SESSION_KEY &&
    !restoredLifecycleSessionKey.startsWith(`${GLOBAL_CHAT_KEY}:`);
  const restoreAt = Date.now();
  const restoredQueueCandidate = canRestoreWorkspaceQueue
    ? reconcileWorkspaceTurnQueueOnRestore({
        snapshot: snapshot.workspaceTurnQueue,
        sessionKey: restoredLifecycleSessionKey,
        sessionEpoch: restoredLifecycleSessionEpoch,
        terminalOwners: [],
        at: restoreAt,
      })
    : null;
  const restoredLocalFastQueueEntries = options?.quarantineInterruptedLocalFast
    ? restoredQueueCandidate?.entries.filter(isRestoredLocalFastQueueEntry) || []
    : [];

  // There is no durable pre-execution fence in this schema generation. A disk
  // snapshot may therefore still say `queued` even if a local side effect ran
  // and its terminal save later failed. Cold restore cannot distinguish that
  // case from never-started work without risking duplicate side effects. Close
  // every noncanonical local-fast receipt visibly and require an explicit new
  // Turn to retry; model-workflow queue semantics remain unchanged.
  for (const entry of restoredLocalFastQueueEntries) {
    if (hasCanonicalRestoredLocalFastConclusion({
      entry,
      sessionKey: restoredLifecycleSessionKey,
      taskFlow,
      conversationTurns,
      runtimeEvents,
      workspacePath: options?.workspacePath,
    })) continue;
    const quarantined = quarantineRestoredLocalFastEntry({
      entry,
      sessionKey: restoredLifecycleSessionKey,
      taskFlow,
      conversationTurns,
      runtimeEvents,
      at: restoreAt,
      workspacePath: options?.workspacePath,
      reservedTaskBlockIds: reservedWorkspaceInstructionBlockIds,
    });
    taskFlow = quarantined.taskFlow;
    conversationTurns = quarantined.conversationTurns;
    runtimeEvents = quarantined.runtimeEvents;
    logStoreEvent("workspace_local_fast_restore_quarantined", {
      sessionKey: restoredLifecycleSessionKey,
      sessionEpoch: restoredLifecycleSessionEpoch,
      receiptId: entry.receipt.receiptId,
      sourceTurnId: entry.receipt.turnId,
      presentationTurnId: quarantined.presentationTurnId,
      reason: "missing_durable_pre_execution_fence",
    });
  }
  const restoredTerminalOwners: WorkspaceTurnTerminalOwner[] = [];
  const restoredAdoptedOwners: WorkspaceTurnTerminalOwner[] = [];
  const restoredRecoveryOwners: WorkspaceTurnTerminalOwner[] = [];
  const ownerIdentityForEntry = (
    entry: WorkspaceTurnQueueEntry,
  ): WorkspaceTurnTerminalOwner => ({
    sessionKey: restoredLifecycleSessionKey,
    sessionEpoch: restoredLifecycleSessionEpoch,
    turnId: entry.receipt.turnId,
    receiptId: entry.receipt.receiptId,
    clientSubmissionId: entry.instruction.clientSubmissionId,
    instructionEnvelopeIdentity: workspaceInstructionEnvelopeIdentity(entry),
  });
  const settlePausedHarnessOwnerForCompletedEntry = (
    entry: WorkspaceTurnQueueEntry,
  ) => {
    if (
      sanitizedHarnessRunMarker?.status !== "paused" ||
      sanitizedHarnessRunMarker.sessionKey !== restoredLifecycleSessionKey ||
      sanitizedHarnessRunMarker.turnId !== entry.receipt.turnId
    ) return;
    const markerRunId = getHarnessActionRunId(sanitizedHarnessRunMarker);
    sanitizedHarnessRunMarker = null;
    if (
      reconciledRestoredActionRequest?.sessionKey === restoredLifecycleSessionKey &&
      reconciledRestoredActionRequest.turnId === entry.receipt.turnId &&
      (!markerRunId || reconciledRestoredActionRequest.runId === markerRunId)
    ) {
      reconciledRestoredActionRequest = null;
    }
  };

  for (const entry of restoredQueueCandidate?.entries || []) {
    const ownerIdentity = ownerIdentityForEntry(entry);
    if (isRestoredLocalFastQueueEntry(entry)) {
      if (!hasCanonicalRestoredLocalFastConclusion({
        entry,
        sessionKey: restoredLifecycleSessionKey,
        taskFlow,
        conversationTurns,
        runtimeEvents,
        workspacePath: options?.workspacePath,
      })) continue;
      const sourceInspection = inspectWorkspaceInstructionTerminalProjection({
        entry,
        sessionKey: restoredLifecycleSessionKey,
        taskFlow,
        conversationTurns,
        runtimeEvents,
      });
      (sourceInspection.canonical
        ? restoredTerminalOwners
        : restoredRecoveryOwners).push(ownerIdentity);
      settlePausedHarnessOwnerForCompletedEntry(entry);
      continue;
    }

    let inspection = inspectWorkspaceInstructionTerminalProjection({
      entry,
      sessionKey: restoredLifecycleSessionKey,
      taskFlow,
      conversationTurns,
      runtimeEvents,
    });
    if (inspection.canonical) {
      restoredTerminalOwners.push(ownerIdentity);
      settlePausedHarnessOwnerForCompletedEntry(entry);
      continue;
    }

    const turnIdOccupied = conversationTurns.some(
      (turn) => turn.id === entry.receipt.turnId,
    );
    const userBlockIdOccupied = taskFlow.some(
      (block) => block.id === entry.receipt.userBlockId,
    );
    let projectionConflict = !inspection.owner &&
      (turnIdOccupied || userBlockIdOccupied);
    if (!inspection.owner && !projectionConflict) {
      const useChinese = /[^\x00-\x7F]/.test(entry.instruction.payload.text);
      const projection = reconcileWorkspaceInstructionProjection({
        entry,
        taskFlow,
        conversationTurns,
        userContextItems: buildWorkspaceInstructionUserContext({
          contextMentions: entry.instruction.payload.contextMentions
            ? [...entry.instruction.payload.contextMentions]
            : [],
          attachedFiles: entry.instruction.payload.attachedFiles
            ? entry.instruction.payload.attachedFiles.map((file) => ({ ...file }))
            : [],
          images: entry.instruction.payload.images
            ? [...entry.instruction.payload.images]
            : [],
          workspace: options?.workspacePath || "",
          language: useChinese ? "zh" : "en",
        }),
        language: useChinese ? "zh" : "en",
      });
      if (projection.disposition === "ready") {
        taskFlow = projection.taskFlow;
        conversationTurns = projection.conversationTurns;
        inspection = inspectWorkspaceInstructionTerminalProjection({
          entry,
          sessionKey: restoredLifecycleSessionKey,
          taskFlow,
          conversationTurns,
          runtimeEvents,
        });
        projectionConflict = !inspection.owner;
      } else {
        projectionConflict = true;
      }
    }

    const actionRunId = getHarnessActionRunId(sanitizedHarnessRunMarker);
    const markerParentRunId = sanitizedHarnessRunMarker?.activeParentRunId ||
      sanitizedHarnessRunMarker?.parentRunId ||
      null;
    const rawMarkerStarts = actionRunId && Array.isArray(snapshot.runtimeEvents)
      ? snapshot.runtimeEvents.filter((rawEvent) => {
          if (!rawEvent || typeof rawEvent !== "object") return false;
          const event = rawEvent as Record<string, unknown>;
          return event.type === "run.started" &&
            event.threadId === restoredLifecycleSessionKey &&
            event.turnId === entry.receipt.turnId &&
            event.runId === actionRunId;
        })
      : [];
    let allMarkerStarts = actionRunId
      ? runtimeEvents.filter((event) =>
          event.type === "run.started" &&
          event.threadId === restoredLifecycleSessionKey &&
          event.turnId === entry.receipt.turnId &&
          event.runId === actionRunId
        )
      : [];
    const markerHasTerminalBoundary = !!actionRunId && runtimeEvents.some((event) =>
      event.threadId === restoredLifecycleSessionKey &&
      "turnId" in event &&
      event.turnId === entry.receipt.turnId &&
      (
        event.type === "turn.completed" ||
        ((event.type === "run.completed" || event.type === "run.aborted") &&
          event.runId === actionRunId)
      )
    );
    if (
      inspection.owner &&
      sanitizedHarnessRunMarker?.sessionKey === restoredLifecycleSessionKey &&
      sanitizedHarnessRunMarker.turnId === entry.receipt.turnId &&
      sanitizedHarnessRunMarker.status === "paused" &&
      actionRunId &&
      allMarkerStarts.length === 0 &&
      inspection.terminals.length === 0 &&
      !markerHasTerminalBoundary
    ) {
      const firstPauseIndex = runtimeEvents.findIndex((event) =>
        event.type === "run.paused" &&
        event.threadId === restoredLifecycleSessionKey &&
        event.turnId === entry.receipt.turnId &&
        event.runId === actionRunId
      );
      const pauseTimestamp = firstPauseIndex >= 0
        ? runtimeEvents[firstPauseIndex].timestampMs
        : sanitizedHarnessRunMarker.updatedAt;
      const restoredStart = withEventSchema({
        type: "run.started",
        threadId: restoredLifecycleSessionKey,
        turnId: entry.receipt.turnId,
        timestampMs: Math.min(
          Number(sanitizedHarnessRunMarker.updatedAt) || restoreAt,
          Number(pauseTimestamp) || restoreAt,
        ),
        runId: actionRunId,
        parentRunId: markerParentRunId,
      });
      runtimeEvents = firstPauseIndex >= 0
        ? [
            ...runtimeEvents.slice(0, firstPauseIndex),
            restoredStart,
            ...runtimeEvents.slice(firstPauseIndex),
          ]
        : appendRuntimeEvent(runtimeEvents, restoredStart);
      allMarkerStarts = [restoredStart];
    }
    const exactMarkerStarts = actionRunId
      ? runtimeEvents.filter((event) =>
          event.type === "run.started" &&
          event.threadId === restoredLifecycleSessionKey &&
          event.turnId === entry.receipt.turnId &&
          event.runId === actionRunId &&
          event.parentRunId === markerParentRunId
        )
      : [];
    const markerOwnsExactPausedRun = !!inspection.owner &&
      !!sanitizedHarnessRunMarker &&
      sanitizedHarnessRunMarker.sessionKey === restoredLifecycleSessionKey &&
      sanitizedHarnessRunMarker.turnId === entry.receipt.turnId &&
      sanitizedHarnessRunMarker.status === "paused" &&
      !!actionRunId &&
      rawMarkerStarts.length <= 1 &&
      allMarkerStarts.length === 1 &&
      exactMarkerStarts.length === 1 &&
      inspection.terminals.length === 0 &&
      !markerHasTerminalBoundary;
    if (markerOwnsExactPausedRun) {
      restoredAdoptedOwners.push(ownerIdentity);
      continue;
    }

    const hasSourceLifecycleEvidence = runtimeEvents.some((event) =>
      event.threadId === restoredLifecycleSessionKey &&
      "turnId" in event &&
      event.turnId === entry.receipt.turnId
    ) || !!inspection.owner?.turn.runtimeOutcome;
    if (!projectionConflict && inspection.owner && !hasSourceLifecycleEvidence) {
      // Never-started model workflow work remains FIFO-queued for exact replay.
      continue;
    }

    const useChinese = /[^\x00-\x7F]/.test(entry.instruction.payload.text);
    const summary = projectionConflict
      ? useChinese
        ? "恢复工作区回合时发现不可变所有权冲突。无关历史保持不变，并已通过独立恢复回合给出可见错误结论。"
        : "Restore found an immutable ownership conflict for this workspace Turn. Unrelated history was preserved and a separate recovery Turn recorded the visible error conclusion."
      : useChinese
      ? "应用重启后无法证明这条已接纳指令的运行仍由可恢复执行器持有。为避免重复执行，本回合已用可见错误结论收口；请发送新指令重试。"
      : "After restart, MAIN could not prove that a resumable executor still owned this admitted instruction. To prevent duplicate execution, the Turn was closed with a visible error; submit a new instruction to retry.";
    const conclusion = concludeWorkspaceInstructionEntry({
      entry,
      sessionKey: restoredLifecycleSessionKey,
      taskFlow,
      conversationTurns,
      runtimeEvents,
      resultKind: "error",
      summary,
      timestampMs: restoreAt,
      forceRecovery: projectionConflict,
      recoveryReason: projectionConflict
        ? "workspace_instruction_restore_projection_conflict"
        : "workspace_instruction_restore_owner_unverified",
      language: useChinese ? "zh" : "en",
      reservedTaskBlockIds: reservedWorkspaceInstructionBlockIds,
    });
    taskFlow = conclusion.taskFlow;
    conversationTurns = conclusion.conversationTurns;
    runtimeEvents = conclusion.runtimeEvents;
    (conclusion.disposition === "recovery_completed"
      ? restoredRecoveryOwners
      : restoredTerminalOwners).push(ownerIdentity);
    settlePausedHarnessOwnerForCompletedEntry(entry);
    logStoreEvent("workspace_instruction_restore_reconciled", {
      sessionKey: restoredLifecycleSessionKey,
      sessionEpoch: restoredLifecycleSessionEpoch,
      receiptId: entry.receipt.receiptId,
      sourceTurnId: entry.receipt.turnId,
      presentationTurnId: conclusion.presentationTurnId,
      disposition: conclusion.disposition,
    });
  }
  const restoredWorkspaceTurnQueue = canRestoreWorkspaceQueue && restoredQueueCandidate
      ? reconcileWorkspaceTurnQueueOnRestore({
          snapshot: restoredQueueCandidate,
          sessionKey: restoredLifecycleSessionKey,
          sessionEpoch: restoredLifecycleSessionEpoch,
          at: restoreAt,
          terminalOwners: restoredTerminalOwners,
          adoptedOwners: restoredAdoptedOwners,
          recoveryOwners: restoredRecoveryOwners,
        })
      : null;
  const restoredWorkspaceInstructionLedger =
    suppliedLifecycleSessionEpoch &&
    restoredLifecycleSessionKey !== UNBOUND_PLAN_SESSION_KEY &&
    !restoredLifecycleSessionKey.startsWith(`${GLOBAL_CHAT_KEY}:`)
      ? normalizeWorkspaceInstructionLedger(
          snapshot.workspaceInstructionLedger,
          restoredLifecycleSessionKey,
          restoredLifecycleSessionEpoch,
        )
      : [];
  return {
    runtimeEventSchemaVersion: MAIN_THREAD_EVENT_SCHEMA_VERSION,
    runtimeEvents,
    harnessRunMarker: sanitizedHarnessRunMarker,
    activeActionRequest: reconciledRestoredActionRequest,
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
    planExecutionEvidenceLedger: hasExactRestoredPlanApprovalCapability
      ? snapshot.planExecutionEvidenceLedger || []
      : [],
    planExecutionEvidenceCount: hasExactRestoredPlanApprovalCapability
      ? snapshot.planExecutionEvidenceCount ?? 0
      : 0,
    planAutoResumeCount: hasExactRestoredPlanApprovalCapability
      ? Math.max(0, Number(snapshot.planAutoResumeCount) || 0)
      : 0,
    planExecutionProgressSnapshot: hasExactRestoredPlanApprovalCapability
      ? (() => {
          const restored = normalizeStoredPlanExecutionProgressSnapshot(
            snapshot.planExecutionProgressSnapshot,
            restoredTaskIdentity.currentTaskId,
          );
          return restored ? { ...restored, phase: "paused" as const } : null;
        })()
      : null,
    planLifecycle: restoredPlanLifecycle,
    planStage: restoredPlanStage,
    isPlanApproved: restoredIsPlanApproved,
    planApprovalChoice: hasExactRestoredPlanApprovalCapability
      ? normalizePlanApprovalChoice(snapshot.planApprovalChoice)
      : "",
    pendingPlanApprovalHandoff: null,
    planApprovalExecutionStartedForTurnId: null,
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
    preferSubagents: snapshot.preferSubagents === true,
    webSearchEnabled: snapshot.webSearchEnabled === true,
    webSearchProvider: normalizeWebSearchProvider(snapshot.webSearchProvider),
    approvedShellPermissionRules: Array.isArray(snapshot.approvedShellPermissionRules)
      ? snapshot.approvedShellPermissionRules.filter((rule): rule is string => typeof rule === "string" && rule.trim().length > 0)
      : [],
    queuedUserMessage: restoredQueuedUserMessage,
    activeGuidance,
    workspaceTurnQueue: restoredWorkspaceTurnQueue,
    workspaceInstructionLedger: restoredWorkspaceInstructionLedger,
    activeGoal: normalizedGoalRuntime?.goal ?? legacyGoal,
    goalProgress: goalDeletionFenced
      ? null
      : normalizedGoalRuntime?.progress ?? (legacyGoal ? migratedLegacyGoalProgress : null),
    goalStatus: goalDeletionFenced
      ? "paused"
      : normalizedGoalRuntime?.status ?? (legacyGoal ? snapshot.goalStatus ?? "paused" : "paused"),
    goalIterationBudget: normalizedGoalRuntime?.goal.iterationBudget
      ?? (legacyGoal ? snapshot.goalIterationBudget : undefined)
      ?? DEFAULT_GOAL_EMERGENCY_CONTINUATION_LIMIT,
    goalRuntime: normalizedGoalRuntime,
  };
}

/**
 * Serialization sanitizer for a live Session. Unlike restart restoration it
 * must not retire a running Plan lease, close a Harness marker, or rewrite Turn
 * status merely because a checkpoint is being persisted.
 */
export function sanitizeSessionRuntimeSnapshotForPersist(
  snapshot: Partial<SessionRuntimeSnapshot> | null | undefined,
): SessionRuntimeSnapshot | undefined {
  if (!snapshot) return undefined;
  const sanitizedPlanArtifacts = sanitizeRestoredPlanArtifacts({
    artifacts: snapshot.planArtifacts || [],
    isPlanApproved: snapshot.isPlanApproved === true,
  }).artifacts;
  const planLifecycle = snapshot.planLifecycle || createEmptyPlanLifecycleForSession(
    snapshot.harnessRunMarker?.sessionKey || null,
    { now: Date.now() },
  );
  return {
    ...snapshot,
    runtimeEventSchemaVersion: MAIN_THREAD_EVENT_SCHEMA_VERSION,
    runtimeEvents: normalizeRuntimeEvents(snapshot.runtimeEvents),
    harnessRunMarker: normalizeHarnessRunMarker(snapshot.harnessRunMarker),
    activeActionRequest: normalizeActionRequest(snapshot.activeActionRequest),
    taskFlow: sanitizeTaskBlocksForPersist(snapshot.taskFlow || []),
    agentMessages: sanitizeAgentMessagesForPersist(snapshot.agentMessages || []),
    planArtifacts: sanitizedPlanArtifacts,
    planLifecycle,
    isPlanApproved: snapshot.isPlanApproved === true &&
      planLifecycle.status === "executing" &&
      isPlanLifecycleExecutionAuthorized(planLifecycle),
  } as SessionRuntimeSnapshot;
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
  const goalCreationAuthorization = isGoalCreationAuthorization(record.goalCreationAuthorization)
    ? record.goalCreationAuthorization
    : undefined;
  const goalContinuationAuthorization = isGoalContinuationAuthorization(
    record.goalContinuationAuthorization,
  )
    ? record.goalContinuationAuthorization
    : undefined;
  const goalContinuationGuidance = typeof record.goalContinuationGuidance === "string" &&
    record.goalContinuationGuidance.trim()
    ? record.goalContinuationGuidance.trim()
    : undefined;
  if (!text && images.length === 0 && contextMentions.length === 0 && attachedFiles.length === 0) return null;
  return {
    id: typeof record.id === "string" && record.id.trim() ? record.id : `queued-${Date.now()}`,
    ...(typeof record.sessionKey === "string" && record.sessionKey.trim()
      ? { sessionKey: record.sessionKey.trim() }
      : {}),
    text,
    ...(images.length > 0 ? { images } : {}),
    ...(contextMentions.length > 0 ? { contextMentions } : {}),
    ...(attachedFiles.length > 0 ? { attachedFiles } : {}),
    ...(runtimeIntentOverride ? { runtimeIntentOverride } : {}),
    ...(goalSourceContextSnapshot ? { goalSourceContextSnapshot } : {}),
    ...(goalCreationAuthorization ? { goalCreationAuthorization } : {}),
    ...(goalContinuationAuthorization ? { goalContinuationAuthorization } : {}),
    ...(goalContinuationAuthorization && goalContinuationGuidance
      ? { goalContinuationGuidance }
      : {}),
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
  "planLifecycle",
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
  "transcriptPartial",
  "transcriptLoadedTurns",
  "transcriptTotalTurns",
  "input",
  "contextMentions",
  "attachedFiles",
  "preferredResponseLanguage",
  "lockedComposerIntent",
  "pendingRunDecision",
  "pendingRunDecisionResolver",
  "autoApproveTools",
  "autoApproveToolScopes",
  "preferSubagents",
  "webSearchEnabled",
  "webSearchProvider",
  "currentTurnExecutionConsent",
  "approvedLocalFileReadPaths",
  "approvedShellPermissionRules",
  "readOnlyAutoApproveForSession",
  "queuedUserMessage",
  "activeGuidance",
  "workspaceTurnQueue",
  "workspaceInstructionLedger",
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

function resolveActiveSessionPlanLifecycleEpoch(
  state: Pick<AppState, "currentWorkspace" | "currentSessionId" | "sessionsByWorkspace">,
  sessionKey: string | null,
): string | null {
  if (!sessionKey || !isSessionRuntimeActive(state, sessionKey)) return null;
  const scopeKey = resolveSessionWorkspaceKey(state.currentWorkspace);
  const session = (state.sessionsByWorkspace[scopeKey] || []).find(
    (candidate) => candidate.id === state.currentSessionId,
  );
  const epoch = String(session?.planLifecycleEpoch || "").trim();
  return epoch || null;
}

function buildQueuedGoalContinuationRemovalPatch(
  state: AppState,
  queuedMessage: QueuedUserMessage | null | undefined,
  mode: QueuedGoalContinuationRemovalMode,
  reason: string,
): {
  patch: Partial<AppState>;
  goalId: string | null;
  decisionReason: ReturnType<typeof resolveQueuedGoalContinuationRemoval>["reason"];
  leaseReason?: ReturnType<typeof resolveQueuedGoalContinuationRemoval>["leaseReason"];
} {
  const goal = state.activeGoal;
  if (!goal) {
    return {
      patch: {},
      goalId: null,
      decisionReason: "queue_owner_mismatch",
    };
  }
  const workspaceKey = resolveSessionWorkspaceKey(state.currentWorkspace);
  const sessionKey = resolveVisibleGoalSubmissionSessionKey(state);
  const decision = resolveQueuedGoalContinuationRemoval({
    mode,
    queuedMessage,
    goal,
    marker: state.harnessRunMarker,
    currentWorkspace: workspaceKey,
    currentSessionKey: sessionKey,
  });
  if (!decision.shouldPauseGoal) {
    return {
      patch: {},
      goalId: goal.id,
      decisionReason: decision.reason,
      leaseReason: decision.leaseReason,
    };
  }

  const now = Date.now();
  const pauseReason = `Goal continuation removed before run lease acquisition (${reason})`;
  const pausedGoal: GoalDefinition = {
    ...goal,
    status: "paused",
    updatedAt: now,
  };
  const currentProgress = state.goalProgress?.goalId === goal.id
    ? state.goalProgress
    : null;
  const pausedProgress = currentProgress
    ? {
        ...currentProgress,
        pauseReason,
        lastUpdatedAt: now,
        ...(currentProgress.usage
          ? { usage: { ...currentProgress.usage, activeStartedAt: null } }
          : {}),
      }
    : null;
  const currentRuntime = state.goalRuntime?.goal.id === goal.id &&
      (state.goalRuntime.goal.revision || 1) === (goal.revision || 1)
    ? state.goalRuntime
    : null;
  const pausedRuntime = currentRuntime
    ? {
        ...currentRuntime,
        goal: pausedGoal,
        progress: pausedProgress || currentRuntime.progress,
        status: "paused" as const,
        phase: "re_plan" as const,
        pauseReason,
        updatedAt: now,
      }
    : state.goalRuntime;

  return {
    patch: {
      activeGoal: pausedGoal,
      goalStatus: "paused",
      ...(pausedProgress ? { goalProgress: pausedProgress } : {}),
      goalRuntime: pausedRuntime,
      runtimeEvents: appendRuntimeEvent(state.runtimeEvents, withEventSchema({
        type: "goal.state_changed",
        ...resolveGoalEventOwnerIdentity({
          goal: pausedGoal,
          currentWorkspace: state.currentWorkspace,
          currentSessionId: state.currentSessionId,
          currentTurnId: goal.ownerTurnId || state.currentTurnId,
        }),
        timestampMs: now,
        goalId: goal.id,
        from: goal.status,
        to: "paused",
        phase: "re_plan",
        reason: `queued_continuation_${mode}_before_run`,
      })),
    },
    goalId: goal.id,
    decisionReason: decision.reason,
    leaseReason: decision.leaseReason,
  };
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
    planLifecycle: state.planLifecycle || createEmptyPlanLifecycleForSession(
      resolveSessionRuntimeKey(
        resolveSessionWorkspaceKey(state.currentWorkspace),
        state.currentSessionId,
      ),
    ),
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
    transcriptPartial: state.transcriptPartial === true,
    transcriptLoadedTurns: Math.max(0, Number(state.transcriptLoadedTurns) || 0),
    transcriptTotalTurns: Math.max(0, Number(state.transcriptTotalTurns) || 0),
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
    preferSubagents: state.preferSubagents === true,
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
    workspaceTurnQueue: state.workspaceTurnQueue || null,
    workspaceInstructionLedger: Array.isArray(state.workspaceInstructionLedger)
      ? state.workspaceInstructionLedger
      : [],
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

function settleCanceledTurnHarnessProjection(
  projectedMarker: HarnessRunMarker,
  sourceMarker: HarnessRunMarker | null,
): HarnessRunMarker | null {
  if (!sourceMarker) return projectedMarker;
  const exactOwner = {
    runId: sourceMarker.runId,
    sessionKey: sourceMarker.sessionKey,
    turnId: sourceMarker.turnId || "",
    instanceId: sourceMarker.instanceId,
    startedAt: sourceMarker.startedAt,
  };
  const latestMarker = readHarnessRunMarker();
  const ownsExactGlobalGeneration = !!latestMarker &&
    latestMarker.runId === exactOwner.runId &&
    latestMarker.sessionKey === exactOwner.sessionKey &&
    latestMarker.turnId === exactOwner.turnId &&
    latestMarker.instanceId === exactOwner.instanceId &&
    latestMarker.startedAt === exactOwner.startedAt;
  if (!ownsExactGlobalGeneration) {
    logStoreEvent("canceled_turn_harness_owner_lost_before_terminal_publish", {
      expected: exactOwner,
      actual: latestMarker
        ? {
            runId: latestMarker.runId,
            sessionKey: latestMarker.sessionKey,
            turnId: latestMarker.turnId,
            instanceId: latestMarker.instanceId,
            startedAt: latestMarker.startedAt,
            status: latestMarker.status,
          }
        : null,
    });
    return null;
  }
  if (
    latestMarker.status !== "running" &&
    latestMarker.status !== "paused" &&
    (
      latestMarker.status !== projectedMarker.status ||
      latestMarker.closeReason !== projectedMarker.closeReason
    )
  ) {
    logStoreEvent("canceled_turn_harness_terminal_conflict", {
      expected: exactOwner,
      existingStatus: latestMarker.status,
      existingReason: latestMarker.closeReason,
      requestedStatus: projectedMarker.status,
      requestedReason: projectedMarker.closeReason,
    });
    return null;
  }
  const settledMarker = settleHarnessRunMarkerIfOwned(projectedMarker, exactOwner);
  if (!settledMarker) {
    logStoreEvent("canceled_turn_harness_persist_degraded", {
      expected: exactOwner,
      requestedStatus: projectedMarker.status,
      requestedReason: projectedMarker.closeReason,
    });
  }
  return settledMarker;
}

function hasTurnTerminalConclusion(
  state: Pick<AppState, "runtimeEvents" | "taskFlow">,
  sessionKey: string,
  turnId: string,
): boolean {
  const hasTerminal = state.runtimeEvents.some((event) =>
    isTerminalTurnEvent(event) &&
    event.threadId === sessionKey &&
    event.turnId === turnId
  );
  const hasVisibleFinal = state.taskFlow.some((block) =>
    block.type === "agent" &&
    block.turnId === turnId &&
    block.visibility === "assistant_final"
  );
  return hasTerminal && hasVisibleFinal;
}

function hasTurnTerminalEvent(
  state: Pick<AppState, "runtimeEvents">,
  sessionKey: string,
  turnId: string,
): boolean {
  return state.runtimeEvents.some((event) =>
    isTerminalTurnEvent(event) &&
    event.threadId === sessionKey &&
    event.turnId === turnId
  );
}

function ensureCanceledTurnVisibleConclusion(input: {
  state: AppState;
  sessionKey: string;
  turnId: string;
  message: string;
  nextTaskId: () => number;
}): AppState {
  const existingFinal = input.state.taskFlow.find((block) =>
    block.type === "agent" &&
    block.turnId === input.turnId &&
    block.visibility === "assistant_final"
  );
  if (existingFinal) return input.state;
  const turn = input.state.conversationTurns.find((candidate) => candidate.id === input.turnId);
  const turnConclusion = [...input.state.runtimeEvents].reverse().find(
    (event): event is Extract<MainThreadEvent, { type: "turn.completed" }> =>
      isTerminalTurnEvent(event) &&
      event.threadId === input.sessionKey &&
      event.turnId === input.turnId,
  );
  const runConclusion = [...input.state.runtimeEvents].reverse().find(
    (event): event is Extract<MainThreadEvent, { type: "run.completed" }> =>
      isRunTerminalEvent(event) &&
      event.threadId === input.sessionKey &&
      event.turnId === input.turnId,
  );
  const resultKind = turn?.runtimeOutcome?.resultKind ||
    turnConclusion?.resultKind ||
    runConclusion?.resultKind ||
    "canceled";
  const usesChinese = /[^\x00-\x7F]/.test(String(turn?.userPrompt || input.message));
  const canonicalMessage = String(turn?.summary || runConclusion?.summary || "").trim() || (
    resultKind === "success"
      ? usesChinese ? "本回合已完成。" : "This turn completed."
      : resultKind === "error"
        ? usesChinese ? "本回合已得出错误结论。" : "This turn concluded with an error."
        : input.message
  );
  const finalBlockId = input.nextTaskId();
  return {
    ...input.state,
    taskFlow: [...input.state.taskFlow, {
      id: finalBlockId,
      turnId: input.turnId,
      type: "agent",
      content: canonicalMessage,
      streaming: false,
      visibility: "assistant_final",
    }],
    conversationTurns: input.state.conversationTurns.map((turn) =>
      turn.id === input.turnId
        ? {
            ...turn,
            status: "done" as const,
            summary: canonicalMessage,
            collapsed: false,
            blockIds: turn.blockIds.includes(finalBlockId)
              ? turn.blockIds
              : [...turn.blockIds, finalBlockId],
          }
        : turn
    ),
  };
}

async function reconcileCanceledTurnWithLatestRuntime(input: {
  getState: () => AppState;
  setState: (
    patchOrUpdater: Partial<AppState> | ((state: AppState) => Partial<AppState>),
  ) => void;
  sessionKey: string;
  scopeKey: string;
  sessionId: number | null;
  turnId: string;
  runId: string | null;
  parentRunId: string | null;
  reason: string;
  message: string;
  expectedAbortController: AbortController | null;
  nextTaskId: () => number;
}): Promise<SessionCancellationSettlement> {
  let sessionDeleted = false;
  let targetWasActive = false;
  let projectedRuntime: SessionRuntimeState | null = null;
  let discardedQueueId: string | null = null;
  let ownerTransferred = false;

  input.setState((latest) => {
    const sessionRecord = input.sessionId == null
      ? null
      : (latest.sessionsByWorkspace[input.scopeKey] || []).find(
          (candidate) => candidate.id === input.sessionId,
        ) || null;
    targetWasActive = isSessionRuntimeActive(latest, input.sessionKey);
    if (!sessionRecord) {
      sessionDeleted = true;
      const existingRuntime = latest.runtimeBySessionKey[input.sessionKey];
      discardedQueueId = (
        targetWasActive
          ? latest.queuedUserMessage
          : existingRuntime?.queuedUserMessage
      )?.id || null;
      const runtimeBySessionKey = { ...latest.runtimeBySessionKey };
      delete runtimeBySessionKey[input.sessionKey];
      return {
        runtimeBySessionKey,
        ...(targetWasActive
          ? {
              currentSessionId: null,
              queuedUserMessage: null,
              workspaceTurnQueue: null,
              workspaceInstructionLedger: [],
              transcriptPartial: false,
              transcriptLoadedTurns: 0,
              transcriptTotalTurns: 0,
              input: "",
              contextMentions: [],
              attachedFiles: [],
            }
          : {}),
      };
    }

    let ownerRuntime = targetWasActive
      ? createSessionRuntimeFromState(latest)
      : latest.runtimeBySessionKey[input.sessionKey];
    if (!ownerRuntime && sessionRecord.runtimeSnapshot) {
      const restoredSnapshot = normalizeSessionRuntimeSnapshot(
        sessionRecord.runtimeSnapshot,
        {
          restoreInterruptedGoal: true,
          workspacePath: input.scopeKey,
          expectedSessionKey: input.sessionKey,
          expectedSessionEpoch: sessionRecord.planLifecycleEpoch || null,
        },
      );
      ownerRuntime = createSessionRuntimeFromState({
        ...latest,
        ...restoredSnapshot,
      });
    }
    if (!ownerRuntime) return {};

    const scopedState = (targetWasActive
      ? latest
      : {
          ...latest,
          ...ownerRuntime,
          runtimeEvents: ownerRuntime.runtimeEvents || [],
        }) as AppState;
    const targetAlreadyTerminal = hasTurnTerminalEvent(
      scopedState,
      input.sessionKey,
      input.turnId,
    );
    if (
      !targetAlreadyTerminal &&
      (scopedState.abortController ?? null) !== input.expectedAbortController
    ) {
      ownerTransferred = true;
      return {};
    }
    const projection = projectCanceledTurn({
      state: scopedState,
      sessionKey: input.sessionKey,
      turnId: input.turnId,
      runId: input.runId,
      parentRunId: input.parentRunId,
      reason: input.reason,
      message: input.message,
      nextTaskId: input.nextTaskId,
      controlPlaneFence: {
        abortController: input.expectedAbortController,
      },
    });
    if (projection.disposition === "ownership_lost") {
      ownerTransferred = true;
      return {};
    }
    let projectedState = projection.state;
    if (
      projection.disposition === "already_closed" &&
      !hasTurnTerminalConclusion(projectedState, input.sessionKey, input.turnId)
    ) {
      projectedState = ensureCanceledTurnVisibleConclusion({
        state: projectedState,
        sessionKey: input.sessionKey,
        turnId: input.turnId,
        message: input.message,
        nextTaskId: input.nextTaskId,
      });
    }
    if (
      projection.harnessRunMarker &&
      projection.harnessRunMarker !== scopedState.harnessRunMarker
    ) {
      settleCanceledTurnHarnessProjection(
        projection.harnessRunMarker,
        scopedState.harnessRunMarker || null,
      );
    }
    projectedRuntime = createSessionRuntimeFromState(projectedState);
    return {
      runtimeBySessionKey: {
        ...latest.runtimeBySessionKey,
        [input.sessionKey]: projectedRuntime,
      },
    };
  });

  if (sessionDeleted) {
    logStoreEvent("canceled_turn_reconciliation_session_deleted", {
      sessionKey: input.sessionKey,
      turnId: input.turnId,
      discardedQueueId,
    });
    return {
      sessionKey: input.sessionKey,
      turnId: input.turnId,
      terminalSettled: false,
      disposition: "session_deleted",
      queueDisposition: "discard",
    };
  }
  if (ownerTransferred) {
    logStoreEvent("canceled_turn_reconciliation_owner_transferred", {
      sessionKey: input.sessionKey,
      turnId: input.turnId,
      runId: input.runId,
    });
    return {
      sessionKey: input.sessionKey,
      turnId: input.turnId,
      terminalSettled: false,
      disposition: "owner_transferred",
    };
  }
  if (!projectedRuntime) {
    return {
      sessionKey: input.sessionKey,
      turnId: input.turnId,
      terminalSettled: false,
      disposition: "latest_runtime_missing",
    };
  }
  if (targetWasActive) {
    input.setState(pickSessionRuntimePatch(projectedRuntime));
  }
  const latest = input.getState();
  const latestRuntime = isSessionRuntimeActive(latest, input.sessionKey)
    ? createSessionRuntimeFromState(latest)
    : latest.runtimeBySessionKey[input.sessionKey];
  const terminalSettled = !!latestRuntime && hasTurnTerminalConclusion(
    {
      runtimeEvents: latestRuntime.runtimeEvents || [],
      taskFlow: latestRuntime.taskFlow,
    },
    input.sessionKey,
    input.turnId,
  );
  logStoreEvent("canceled_turn_reconciled_memory_terminal", {
    sessionKey: input.sessionKey,
    turnId: input.turnId,
    terminalSettled,
  });
  return {
    sessionKey: input.sessionKey,
    turnId: input.turnId,
    terminalSettled,
    disposition: terminalSettled
      ? "reconciled_memory_terminal"
      : "memory_terminal_verification_failed",
  };
}

function buildHistoryClearRevokedRuntime(
  runtime: SessionRuntimeState,
  pauseReason: string,
  now = Date.now(),
  preserveQueuedUserMessage = false,
): SessionRuntimeState {
  const resetLifecycle = reducePlanLifecycle(runtime.planLifecycle, {
    type: "reset",
    expectedVersion: runtime.planLifecycle.version,
    at: now,
  });
  let revokedPlanLifecycle = resetLifecycle.disposition === "rejected"
    ? runtime.planLifecycle
    : resetLifecycle.state;
  const retainedArtifactIdentity = toPlanLifecycleArtifactIdentity(
    buildPlanApprovalIdentity(runtime.planArtifacts || []),
  );
  if (resetLifecycle.disposition !== "rejected" && retainedArtifactIdentity) {
    const discovery = reducePlanLifecycle(revokedPlanLifecycle, {
      type: "hydrate_discovery",
      expectedVersion: revokedPlanLifecycle.version,
      at: now,
      planTurnId: runtime.currentTurnId || runtime.planLifecycle.planTurnId || null,
      artifactIdentity: retainedArtifactIdentity,
    });
    if (discovery.disposition !== "rejected") revokedPlanLifecycle = discovery.state;
  }
  const activeGoal = runtime.activeGoal
    ? { ...runtime.activeGoal, status: "paused" as const, updatedAt: now }
    : null;
  const goalProgress = runtime.goalProgress
    ? {
        ...runtime.goalProgress,
        pauseReason,
        lastUpdatedAt: now,
        ...(runtime.goalProgress.usage
          ? { usage: { ...runtime.goalProgress.usage, activeStartedAt: null } }
          : {}),
      }
    : null;
  const goalRuntime = runtime.goalRuntime
    ? {
        ...runtime.goalRuntime,
        goal: activeGoal || {
          ...runtime.goalRuntime.goal,
          status: "paused" as const,
          updatedAt: now,
        },
        progress: goalProgress || runtime.goalRuntime.progress,
        status: "paused" as const,
        phase: "re_plan" as const,
        pauseReason,
        updatedAt: now,
      }
    : null;
  return {
    ...runtime,
    currentTurnState: createDefaultCurrentTurnState(),
    isGenerating: false,
    agentStatus: "idle",
    abortController: null,
    harnessRunMarker: null,
    pendingRunDecision: null,
    pendingRunDecisionResolver: null,
    pendingReviewResolve: null,
    pendingReviewTaskId: null,
    activeActionRequest: null,
    pendingToolCall: null,
    planLifecycle: revokedPlanLifecycle,
    isPlanApproved: false,
    planApprovalChoice: null,
    planStage: retainedArtifactIdentity ? "plan" : "idle",
    pendingPlanApprovalHandoff: null,
    planApprovalExecutionStartedForTurnId: null,
    queuedUserMessage: preserveQueuedUserMessage ? runtime.queuedUserMessage : null,
    activeGuidance: null,
    currentTurnExecutionConsent: { turnId: null, granted: false },
    normalizedStreamState: defaultNormalizedStreamState,
    activeGoal,
    goalProgress,
    goalStatus: "paused",
    goalRuntime,
  };
}

function buildHistoryClearFailedTerminalRuntime(input: {
  runtime: SessionRuntimeState;
  sessionKey: string;
  message: string;
  nextTaskId: () => number;
  now: number;
}): SessionRuntimeState {
  const currentTurnId = input.runtime.currentTurnId;
  const currentTurn = currentTurnId
    ? input.runtime.conversationTurns.find((turn) => turn.id === currentTurnId) || null
    : null;
  const legacyTerminal = !!currentTurn && (
    currentTurn.status === "done" ||
    currentTurn.status === "completed_with_changes" ||
    currentTurn.status === "stopped_no_action" ||
    currentTurn.status === "stopped_no_output" ||
    currentTurn.status === "error"
  );
  if (!currentTurnId || !currentTurn || legacyTerminal || isConversationTurnRuntimeClosed(currentTurn.runtimeOutcome)) {
    return buildHistoryClearRevokedRuntime(input.runtime, input.message, input.now, true);
  }
  const cancelableRuntime: SessionRuntimeState & { runtimeEvents: MainThreadEvent[] } = {
    ...input.runtime,
    runtimeEvents: input.runtime.runtimeEvents || [],
  };
  const projection = projectCanceledTurn<SessionRuntimeState & { runtimeEvents: MainThreadEvent[] }>({
    state: cancelableRuntime,
    sessionKey: input.sessionKey,
    turnId: currentTurnId,
    reason: "workspace_history_clear_failed_runtime_revoked",
    message: input.message,
    nextTaskId: input.nextTaskId,
    nowMs: input.now,
  });
  return buildHistoryClearRevokedRuntime(
    createSessionRuntimeFromState(projection.state),
    input.message,
    input.now,
    true,
  );
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
  workspacePath?: string | null;
  expectedSessionKey?: string | null;
  expectedSessionEpoch?: string | null;
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
    quarantineInterruptedLocalFast: true,
    workspacePath: input.workspacePath ?? input.fallbackState.currentWorkspace,
    expectedSessionKey: input.expectedSessionKey,
    expectedSessionEpoch: input.expectedSessionEpoch,
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
    lockedComposerIntent: sanitizeHydratedLockedComposerIntent(
      input.fallbackState.lockedComposerIntent,
    ) as MainIntentShortcut | null,
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
    const normalizedSessions = (sessions || []).map((session) => {
      const planLifecycleEpoch = String(session.planLifecycleEpoch || "").trim() ||
        createPlanLifecycleSessionEpoch(Number(session.id) || Date.now());
      return {
        ...session,
        planLifecycleEpoch,
        sessionModeAffinity: resolveSessionModeAffinity(session as SessionModeAffinityLike, "main_mode"),
        messages: sanitizeTaskBlocksForPersist(session.messages || []),
        runtimeSnapshot: normalizeSessionRuntimeSnapshot(session.runtimeSnapshot, {
          restoreInterruptedGoal: true,
          quarantineInterruptedLocalFast: true,
          workspacePath: scopeKey,
          expectedSessionKey: resolveSessionRuntimeKey(scopeKey, session.id),
          expectedSessionEpoch: planLifecycleEpoch,
        }),
      };
    });
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
const scheduledWorkspaceClearSubmissionReplays = new Set<string>();
const workspaceClearSubmissionReplayAttempts = new Map<string, {
  workspaceKey: string;
  attempt: number;
}>();
const workspaceClearSubmissionReplayNotReady = new Set<string>();
const workspaceClearSubmissionReplayReadySessionKeys = new Map<string, string | null>();
const workspaceClearTransactions = new Map<string, Promise<void>>();
const invalidatedWorkspaceClearTransactions = new WeakSet<Promise<void>>();
const WORKSPACE_CLEAR_SUBMISSION_MAX_AUTO_REPLAYS = 3;
let planDiffRevertResetGeneration = 0;
let planDiffRevertOperationCounter = 0;

function discardWorkspaceClearSubmissionReplayState(workspaceKeyInput: string): void {
  const workspaceKey = resolveSessionWorkspaceKey(workspaceKeyInput);
  scheduledWorkspaceClearSubmissionReplays.delete(workspaceKey);
  workspaceClearSubmissionReplayNotReady.delete(workspaceKey);
  workspaceClearSubmissionReplayReadySessionKeys.delete(workspaceKey);
  for (const [submissionId, entry] of workspaceClearSubmissionReplayAttempts) {
    if (entry.workspaceKey === workspaceKey) {
      workspaceClearSubmissionReplayAttempts.delete(submissionId);
    }
  }
}

function invalidateWorkspaceClearTransaction(workspaceKeyInput: string): void {
  const workspaceKey = resolveSessionWorkspaceKey(workspaceKeyInput);
  const transaction = workspaceClearTransactions.get(workspaceKey);
  if (!transaction) return;
  invalidatedWorkspaceClearTransactions.add(transaction);
  if (workspaceClearTransactions.get(workspaceKey) === transaction) {
    workspaceClearTransactions.delete(workspaceKey);
  }
}

function scheduleWorkspaceClearSubmissionReplay(workspaceKeyInput: string): void {
  const workspaceKey = resolveSessionWorkspaceKey(workspaceKeyInput);
  if (scheduledWorkspaceClearSubmissionReplays.has(workspaceKey)) return;
  scheduledWorkspaceClearSubmissionReplays.add(workspaceKey);
  setTimeout(async () => {
    scheduledWorkspaceClearSubmissionReplays.delete(workspaceKey);
    if (workspaceClearSubmissionReplayNotReady.has(workspaceKey)) return;
    const latest = useAppStore.getState();
    if (resolveSessionWorkspaceKey(latest.currentWorkspace) !== workspaceKey) return;
    const activeSessionKey = resolveSessionRuntimeKey(workspaceKey, latest.currentSessionId);
    if (
      !workspaceClearSubmissionReplayReadySessionKeys.has(workspaceKey) ||
      workspaceClearSubmissionReplayReadySessionKeys.get(workspaceKey) !== activeSessionKey
    ) {
      return;
    }
    const queued = peekSettledWorkspaceClearSubmission(workspaceKey);
    if (
      queued?.outcome === "preserved" &&
      queued.targetSessionKey &&
      queued.targetSessionKey === activeSessionKey &&
      latest.runtimeBySessionKey[queued.targetSessionKey]
    ) {
      // A Session activation may begin an async disk restore in App.tsx. The
      // clear failure path already owns a complete terminal in-memory runtime;
      // publish that exact snapshot before replay instead of racing disk I/O.
      latest.restoreRuntimeForSession(queued.targetSessionKey, {
        resetPanels: true,
      });
    }
    const pending = takeSettledWorkspaceClearSubmission({
      workspaceKey,
      activeSessionKey,
    });
    if (!pending) return;
    let started = false;
    try {
      started = await pending.replay(pending.outcome) === true;
    } catch (error) {
      logStoreEvent("workspace_clear_submission_replay_failed", {
        workspaceKey,
        submissionId: pending.id,
        outcome: pending.outcome,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    if (!started) {
      const attempt = (workspaceClearSubmissionReplayAttempts.get(pending.id)?.attempt || 0) + 1;
      if (attempt >= WORKSPACE_CLEAR_SUBMISSION_MAX_AUTO_REPLAYS) {
        workspaceClearSubmissionReplayAttempts.delete(pending.id);
        try {
          pending.onDiscard?.("replay_failed");
        } catch {
          // The head is already removed. A diagnostic callback must not block
          // later user instructions from reaching their own conclusion.
        }
        logStoreEvent("workspace_clear_submission_replay_exhausted", {
          workspaceKey,
          submissionId: pending.id,
          outcome: pending.outcome,
          attempt,
          maxAutoReplays: WORKSPACE_CLEAR_SUBMISSION_MAX_AUTO_REPLAYS,
          disposition: "discarded_after_visible_failure",
        });
        const exhaustedState = useAppStore.getState();
        if (resolveSessionWorkspaceKey(exhaustedState.currentWorkspace) === workspaceKey) {
          workspaceClearSubmissionReplayReadySessionKeys.set(
            workspaceKey,
            resolveSessionRuntimeKey(workspaceKey, exhaustedState.currentSessionId),
          );
        }
        if (peekSettledWorkspaceClearSubmission(workspaceKey)) {
          scheduleWorkspaceClearSubmissionReplay(workspaceKey);
        }
        return;
      }
      const retained = restoreSettledWorkspaceClearSubmission(pending);
      if (retained) {
        workspaceClearSubmissionReplayAttempts.set(pending.id, { workspaceKey, attempt });
      }
      else workspaceClearSubmissionReplayAttempts.delete(pending.id);
      logStoreEvent("workspace_clear_submission_replay_retained", {
        workspaceKey,
        submissionId: pending.id,
        outcome: pending.outcome,
        retained,
        attempt,
        maxAutoReplays: WORKSPACE_CLEAR_SUBMISSION_MAX_AUTO_REPLAYS,
      });
      if (retained) {
        setTimeout(
          () => scheduleWorkspaceClearSubmissionReplay(workspaceKey),
          attempt * 75,
        );
      }
      return;
    }
    workspaceClearSubmissionReplayAttempts.delete(pending.id);
    logStoreEvent("workspace_clear_submission_replayed", {
      workspaceKey,
      submissionId: pending.id,
      outcome: pending.outcome,
      targetSessionKey: pending.targetSessionKey,
    });
    const replayedState = useAppStore.getState();
    if (resolveSessionWorkspaceKey(replayedState.currentWorkspace) === workspaceKey) {
      // The first cleared replay can create the replacement Session. Carry the
      // already-published drain lease onto that exact Session so later FIFO
      // entries do not stall behind the obsolete pre-replay null owner.
      workspaceClearSubmissionReplayReadySessionKeys.set(
        workspaceKey,
        resolveSessionRuntimeKey(workspaceKey, replayedState.currentSessionId),
      );
    }
    // Advance only after the exact head reports successful acceptance. A
    // failed head is restored above and therefore always blocks later items.
    if (peekSettledWorkspaceClearSubmission(workspaceKey)) {
      scheduleWorkspaceClearSubmissionReplay(workspaceKey);
    }
  }, 0);
}

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
    if (
      block.turnId !== turnId ||
      block.type !== "agent" ||
      block.hiddenProcess ||
      block.visibility !== "assistant_final"
    ) continue;
    const summary = summarizeAssistantText(block.content || "");
    if (summary) return summary;
  }
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
        const publicProgress = b.publicProgress &&
          b.publicProgress.schemaVersion === 1 &&
          (b.publicProgress.kind === "assistant_commentary" || b.publicProgress.kind === "capsule_activity") &&
          b.publicProgress.source === "model_visible_content" &&
          String(b.publicProgress.sessionKey || "").trim() &&
          String(b.publicProgress.turnId || "").trim() &&
          String(b.publicProgress.displayTurnId || "").trim() &&
          String(b.publicProgress.runId || "").trim()
            ? {
                schemaVersion: 1 as const,
                kind: b.publicProgress.kind,
                source: "model_visible_content" as const,
                sessionKey: String(b.publicProgress.sessionKey).trim(),
                turnId: String(b.publicProgress.turnId).trim(),
                displayTurnId: String(b.publicProgress.displayTurnId).trim(),
                runId: String(b.publicProgress.runId).trim(),
                parentRunId: String(b.publicProgress.parentRunId || "").trim() || null,
                createdAt: Math.max(0, Number(b.publicProgress.createdAt) || 0),
              }
            : null;
        return {
          id: b.id,
          turnId: b.turnId,
          ...persistedTurnPhase(b),
          type: "agent" as const,
          content: stripVisualObservationProtocolComments(String(b.content)),
          ...(b.hiddenProcess ? { hiddenProcess: true } : {}),
          ...(b.visibility ? { visibility: b.visibility } : {}),
          ...(publicProgress ? { publicProgress } : {}),
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
    // Building an online persistence snapshot must preserve the live Turn.
    // Restart-only interruption normalization is applied by the restore path.
    conversationTurns: normalizeLiveConversationTurns(state.conversationTurns),
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
    planLifecycle: state.planLifecycle || createEmptyPlanLifecycleForSession(
      resolveSessionRuntimeKey(
        resolveSessionWorkspaceKey(state.currentWorkspace),
        state.currentSessionId,
      ),
    ),
    planStage: state.planStage ?? "idle",
    isPlanApproved: state.isPlanApproved === true,
    planApprovalChoice: state.planApprovalChoice ?? null,
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
    transcriptPartial: state.transcriptPartial === true,
    transcriptLoadedTurns: Math.max(0, Number(state.transcriptLoadedTurns) || 0),
    transcriptTotalTurns: Math.max(0, Number(state.transcriptTotalTurns) || 0),
    autoApproveTools: state.autoApproveTools === true,
    autoApproveToolScopes: state.autoApproveToolScopes || [],
    preferSubagents: state.preferSubagents === true,
    webSearchEnabled: state.webSearchEnabled === true,
    webSearchProvider: normalizeWebSearchProvider(state.webSearchProvider),
    approvedShellPermissionRules: Array.isArray(state.approvedShellPermissionRules)
      ? state.approvedShellPermissionRules.filter((rule: unknown) => typeof rule === "string")
      : [],
    queuedUserMessage: state.queuedUserMessage ?? null,
    activeGuidance: state.activeGuidance ?? null,
    workspaceTurnQueue: state.workspaceTurnQueue ?? null,
    workspaceInstructionLedger: Array.isArray(state.workspaceInstructionLedger)
      ? state.workspaceInstructionLedger
      : [],
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

export function buildEmptySessionRuntimeSnapshot(
  state: any,
  affinity: SessionModeAffinity,
  owner: { sessionKey: string; sessionEpoch: string; createdAt: number },
): SessionRuntimeSnapshot {
  const selectedMainModeKey = normalizeSessionModeAffinity(affinity, "main_mode");
  const previousImageStudio = normalizeImageStudioRuntime(
    state.imageStudio || createDefaultImageStudioRuntime(),
  );
  const snapshot = {
    runtimeEventSchemaVersion: MAIN_THREAD_EVENT_SCHEMA_VERSION,
    runtimeEvents: [],
    harnessRunMarker: null,
    activeActionRequest: null,
    taskFlow: [],
    agentMessages: [],
    contextMemoryState: null,
    contextMemoryStateByRuntimeKey: {},
    providerCompatibilityByRuntimeKey: {},
    conversationTurns: [],
    currentTurnId: null,
    selectedMainModeKey,
    selectedNexusModeKey: mapMainModeToLegacyNexusMode(selectedMainModeKey),
    sessionModeAffinity: selectedMainModeKey,
    imageStudio: {
      ...previousImageStudio,
      activeJobId: null,
      activeStreamId: null,
    },
    activeStudioAgentKey: "studio_auto",
    gameStudioInitialized: false,
    pendingSlashCommand: null,
    planArtifacts: [],
    planTasks: [],
    planExecutionEvidenceLedger: [],
    planExecutionEvidenceCount: 0,
    planAutoResumeCount: 0,
    planExecutionProgressSnapshot: null,
    planLifecycle: createEmptyPlanLifecycleForSession(owner.sessionKey, {
      sessionEpoch: owner.sessionEpoch,
      now: owner.createdAt,
    }),
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
    transcriptPartial: false,
    transcriptLoadedTurns: 0,
    transcriptTotalTurns: 0,
    autoApproveTools: false,
    autoApproveToolScopes: [],
    preferSubagents: false,
    webSearchEnabled: false,
    webSearchProvider: "duckduckgo",
    approvedShellPermissionRules: [],
    queuedUserMessage: null,
    activeGuidance: null,
    workspaceTurnQueue: owner.sessionKey.startsWith(`${GLOBAL_CHAT_KEY}:`)
      ? null
      : createWorkspaceTurnQueueState({
          sessionKey: owner.sessionKey,
          sessionEpoch: owner.sessionEpoch,
          updatedAt: owner.createdAt,
        }),
    workspaceInstructionLedger: [],
    activeGoal: null,
    goalProgress: null,
    goalStatus: "paused",
    goalIterationBudget: DEFAULT_GOAL_EMERGENCY_CONTINUATION_LIMIT,
    goalRuntime: null,
  } satisfies Required<SessionRuntimeSnapshot>;
  return snapshot;
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
  const planLifecycleEpoch = createPlanLifecycleSessionEpoch(createdAt);
  const sessionKey = resolveSessionRuntimeKey(params.scopeKey, createdAt)!;
  return {
    id: createdAt,
    planLifecycleEpoch,
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
    runtimeSnapshot: buildEmptySessionRuntimeSnapshot(params.state, params.affinity, {
      sessionKey,
      sessionEpoch: planLifecycleEpoch,
      createdAt,
    }),
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
            const text = String(part.text ?? "");
            parts.push({
              type: "text",
              text: message.role === "assistant"
                ? stripVisualObservationProtocolComments(text)
                : text,
            });
          }
          // Avoid persisting large data URLs in local storage snapshots.
          return parts;
        }, [])
      : message.role === "assistant"
      ? stripVisualObservationProtocolComments(String(message.content ?? ""))
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

function toPlanLifecycleArtifactIdentity(
  identity: ReturnType<typeof buildPlanApprovalIdentity>,
): PlanArtifactIdentity | null {
  if (!identity) return null;
  return {
    revision: identity.revision,
    artifactHash: identity.artifactHash,
    artifactPaths: identity.artifactPaths,
  };
}

function createPlanApprovalLeaseId(now = Date.now()): string {
  const nonce = globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2, 12);
  return `plan-approval-${now}-${nonce}`;
}

function createPlanExecutionLeaseId(now = Date.now()): string {
  const nonce = globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2, 12);
  return `plan-execution-${now}-${nonce}`;
}

function ensurePlanLifecycleSessionOwner(
  lifecycle: PlanLifecycleState | null | undefined,
  sessionKey: string,
  now = Date.now(),
): PlanLifecycleState {
  return ensurePlanLifecycleOwner({
    lifecycle,
    sessionKey,
    at: now,
  });
}

function toPlanLifecycleReviewIdentity(
  request: Extract<ActionRequest, { kind: "plan_review" }>,
  sessionEpoch: string,
): PlanReviewIdentity {
  return {
    sessionKey: request.sessionKey,
    sessionEpoch,
    turnId: request.turnId,
    runId: request.runId,
    parentRunId: request.parentRunId || null,
    requestId: request.requestId,
    planRevision: request.planRevision,
    artifactHash: request.artifactHash,
    artifactPaths: request.artifactPaths,
  };
}

function alignPlanLifecycleWithReview(input: {
  lifecycle: PlanLifecycleState | null | undefined;
  sessionKey: string;
  request: Extract<ActionRequest, { kind: "plan_review" }>;
  artifactIdentity: PlanArtifactIdentity;
  now?: number;
}): PlanLifecycleState | null {
  const now = input.now ?? Date.now();
  const owner = ensurePlanLifecycleSessionOwner(input.lifecycle, input.sessionKey, now);
  return applyPlanReviewIdentity({
    lifecycle: owner,
    artifactIdentity: input.artifactIdentity,
    reviewIdentity: toPlanLifecycleReviewIdentity(input.request, owner.sessionEpoch),
    at: now,
  });
}

function transitionPlanLifecycleArtifactIdentity(input: {
  lifecycle: PlanLifecycleState | null | undefined;
  sessionKey: string;
  artifactIdentity: PlanArtifactIdentity | null;
  now?: number;
}): PlanLifecycleState {
  const now = input.now ?? Date.now();
  return applyPlanArtifactIdentity({
    lifecycle: input.lifecycle,
    sessionKey: input.sessionKey,
    at: now,
    artifactIdentity: input.artifactIdentity,
  });
}

function pausePlanLifecycle(input: {
  lifecycle: PlanLifecycleState;
  reason: string;
  resultKind: "partial" | "blocked" | "error";
  resumeCondition: string;
  now?: number;
}): PlanLifecycleState {
  return applyPlanLifecyclePause({
    lifecycle: input.lifecycle,
    at: input.now ?? Date.now(),
    pause: {
      reason: input.reason,
      resultKind: input.resultKind,
      resumeCondition: input.resumeCondition,
    },
  });
}

function revokePlanLifecycleToDiscovery(input: {
  lifecycle: PlanLifecycleState;
  sessionKey: string;
  artifacts: PlanArtifact[];
  planTurnId?: string | null;
  now?: number;
}): PlanLifecycleState {
  const now = input.now ?? Date.now();
  const owner = ensurePlanLifecycleSessionOwner(input.lifecycle, input.sessionKey, now);
  const reset = reducePlanLifecycle(owner, {
    type: "reset",
    expectedVersion: owner.version,
    at: now,
  });
  if (reset.disposition === "rejected") return owner;
  const artifactIdentity = toPlanLifecycleArtifactIdentity(
    buildPlanApprovalIdentity(input.artifacts),
  );
  if (!artifactIdentity) return reset.state;
  const discovery = reducePlanLifecycle(reset.state, {
    type: "hydrate_discovery",
    expectedVersion: reset.state.version,
    at: now,
    planTurnId: input.planTurnId || null,
    artifactIdentity,
  });
  return discovery.disposition === "rejected" ? reset.state : discovery.state;
}

function supportsFullFileDiffRevert(block: Extract<TaskBlock, { type: "tool" }>): boolean {
  if (!block.diff) return false;
  if (block.diff.fullFile === true) return true;
  if (block.diff.fullFile === false) return false;
  return block.toolName === "write_file";
}

interface PlanArtifactRevertTransition {
  patch: Partial<AppState>;
  pendingPermissionInvalidation: PendingPlanToolPermissionInvalidation | null;
  revokedExecutionAbort: (() => void) | null;
  approvalInvalidated: boolean;
}

function buildPlanArtifactRevertTransition(
  state: AppState,
  path: string,
  oldText: string,
  existed: boolean,
  now = Date.now(),
): PlanArtifactRevertTransition {
  const canonicalPath = canonicalizePlanArtifactPath(path);
  const kind = detectPlanArtifactKind(canonicalPath);
  const noPlanTransition: PlanArtifactRevertTransition = {
    patch: {},
    pendingPermissionInvalidation: null,
    revokedExecutionAbort: null,
    approvalInvalidated: false,
  };
  if (!canonicalPath || !kind || kind === "summary") return noPlanTransition;

  const sanitized = sanitizePlanArtifactContent(oldText);
  const shouldKeepArtifact = existed && sanitized.trim().length > 0;
  const currentMaxPlanRevision = state.planArtifacts.reduce(
    (max, artifact) => Math.max(max, Number(artifact.revision) || 0),
    0,
  );
  const existingIndex = state.planArtifacts.findIndex(
    (artifact) => canonicalizePlanArtifactPath(artifact.path) === canonicalPath,
  );
  const nextArtifacts = state.planArtifacts.slice();
  if (shouldKeepArtifact) {
    const existingArtifact = existingIndex >= 0 ? nextArtifacts[existingIndex] : null;
    const contentChanged = !existingArtifact ||
      existingArtifact.kind !== kind ||
      existingArtifact.content !== sanitized;
    const restoredArtifact: PlanArtifact = {
      kind,
      path: canonicalPath,
      title: getPlanArtifactTitle(kind, state.config.language === "en" ? "en" : "zh"),
      content: sanitized,
      revision: contentChanged
        ? Math.max(1, currentMaxPlanRevision + 1)
        : Math.max(1, Number(existingArtifact?.revision) || 1),
      updatedAt: contentChanged ? now : existingArtifact?.updatedAt || now,
    };
    if (existingIndex >= 0) nextArtifacts[existingIndex] = restoredArtifact;
    else nextArtifacts.push(restoredArtifact);
  } else if (existingIndex >= 0) {
    nextArtifacts.splice(existingIndex, 1);
  }

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

  const nextApprovalIdentity = buildPlanApprovalIdentity(nextArtifacts);
  const lifecycleSessionKey = resolveSessionRuntimeKey(
    resolveSessionWorkspaceKey(state.currentWorkspace),
    state.currentSessionId,
  ) || UNBOUND_PLAN_SESSION_KEY;
  let nextPlanLifecycle = transitionPlanLifecycleArtifactIdentity({
    lifecycle: state.planLifecycle,
    sessionKey: lifecycleSessionKey,
    artifactIdentity: toPlanLifecycleArtifactIdentity(nextApprovalIdentity),
    now,
  });
  const heldPlanAuthority = state.isPlanApproved ||
    !!state.planLifecycle.approvalLease ||
    !!state.planLifecycle.executionLease;
  const approvalInvalidated = heldPlanAuthority &&
    !isPlanApprovalLeaseBoundToState(nextPlanLifecycle);
  const pendingPermissionInvalidation = buildPendingPlanToolPermissionInvalidation(
    state,
    approvalInvalidated,
  );
  const revokedExecutionAbort = approvalInvalidated &&
    !pendingPermissionInvalidation &&
    isHarnessMarkerOwnedByPlanExecution({
      lifecycle: state.planLifecycle,
      marker: state.harnessRunMarker,
    }) &&
    state.abortController &&
    !state.abortController.signal.aborted
      ? () => state.abortController?.abort()
      : null;
  const effectivePlanApproved = state.isPlanApproved &&
    isPlanApprovalLeaseBoundToState(nextPlanLifecycle);
  const shouldRefreshPlanReviewRequest =
    state.activeActionRequest?.kind === "plan_review" &&
    !!nextApprovalIdentity &&
    (
      state.activeActionRequest.planRevision !== nextApprovalIdentity.revision ||
      state.activeActionRequest.artifactHash !== nextApprovalIdentity.artifactHash
    );
  const clearsPlanReviewRequest =
    state.activeActionRequest?.kind === "plan_review" && !nextApprovalIdentity;
  const nextPlanReviewRequest = shouldRefreshPlanReviewRequest &&
    state.activeActionRequest?.kind === "plan_review" &&
    nextApprovalIdentity
      ? buildPlanReviewActionRequest({
          sessionKey: state.activeActionRequest.sessionKey,
          turnId: state.activeActionRequest.turnId,
          runId: state.activeActionRequest.runId,
          parentRunId: state.activeActionRequest.parentRunId,
          title: state.activeActionRequest.title,
          planRevision: nextApprovalIdentity.revision,
          artifactHash: nextApprovalIdentity.artifactHash,
          artifactPaths: nextApprovalIdentity.artifactPaths,
        })
      : state.activeActionRequest;
  if (
    shouldRefreshPlanReviewRequest &&
    nextPlanReviewRequest?.kind === "plan_review" &&
    nextApprovalIdentity
  ) {
    const alignedLifecycle = alignPlanLifecycleWithReview({
      lifecycle: nextPlanLifecycle,
      sessionKey: lifecycleSessionKey,
      request: nextPlanReviewRequest,
      artifactIdentity: nextApprovalIdentity,
      now,
    });
    if (alignedLifecycle) nextPlanLifecycle = alignedLifecycle;
  }
  const effectiveTasks = approvalInvalidated ? [] : nextTasks;
  const nextStage = derivePlanStageFromArtifacts(
    nextArtifacts,
    effectiveTasks,
    effectivePlanApproved,
    state.planStage,
  );
  const shouldAutoOpenPlanPanel = !effectivePlanApproved && state.planStage !== "executing";

  return {
    patch: {
      planArtifacts: nextArtifacts.sort((a, b) => a.updatedAt - b.updatedAt),
      planTasks: effectiveTasks,
      planLifecycle: nextPlanLifecycle,
      planStage: nextStage,
      isPlanApproved: effectivePlanApproved,
      clearedPlanTurnId: null,
      ...(shouldRefreshPlanReviewRequest
        ? { activeActionRequest: nextPlanReviewRequest }
        : clearsPlanReviewRequest
          ? { activeActionRequest: null }
          : {}),
      ...(pendingPermissionInvalidation?.patch || {}),
      ...(approvalInvalidated
        ? {
            planApprovalChoice: null,
            pendingPlanApprovalHandoff: null,
            planApprovalExecutionStartedForTurnId: null,
            currentTurnExecutionConsent: { turnId: null, granted: false },
            planExecutionEvidenceLedger: [],
            planExecutionEvidenceCount: 0,
            planAutoResumeCount: 0,
            planExecutionProgressSnapshot: null,
          }
        : {}),
      ...(shouldAutoOpenPlanPanel
        ? {
            showPlanPanel: true,
            rightPanelTab: state.showDiff && state.rightPanelTab === "diff"
              ? "diff" as const
              : "plan" as const,
          }
        : {}),
    },
    pendingPermissionInvalidation,
    revokedExecutionAbort,
    approvalInvalidated,
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
  const lifecycle = latest.planLifecycle;
  const approvalLease = lifecycle.approvalLease;
  const executionLease = lifecycle.executionLease;
  const expectedSessionKey = input.sessionKey || lifecycle.sessionKey;
  const exactLifecycleHandoff =
    lifecycle.status === "handoff_pending" &&
    !!approvalLease &&
    !!executionLease &&
    isPlanApprovalLeaseBoundToState(lifecycle) &&
    lifecycle.sessionKey === expectedSessionKey &&
    approvalLease.planTurnId === input.planTurnId &&
    executionLease.executionTurnId === (input.handoff.executionTurnId || input.planTurnId) &&
    executionLease.executionRunId === input.handoff.executionRunId &&
    executionLease.parentRunId === input.handoff.parentRunId &&
    executionLease.attempt === input.handoff.executionAttempt &&
    executionLease.instructionHash === input.handoff.executionInstructionHash &&
    approvalLease.leaseId === input.handoff.approvalLeaseId &&
    executionLease.executionLeaseId === input.handoff.executionLeaseId &&
    approvalLease.sessionEpoch === input.handoff.sessionEpoch &&
    approvalLease.requestId === input.handoff.reviewRequestId;
  if (!exactLifecycleHandoff || !approvalLease || !executionLease) {
    logStoreEvent("plan_approval_same_turn_execution_skipped", buildPlanApprovalHandoffDedupLogPayload({
      state: latest,
      reason: "approval_lease_mismatch",
      planTurnId: input.planTurnId,
      executionTurnId: input.handoff.executionTurnId || input.planTurnId,
      currentTurnStatus: currentTurn.status,
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
    const currentArtifactIdentity = toPlanLifecycleArtifactIdentity(
      buildPlanApprovalIdentity(latest.planArtifacts),
    );
    const rollbackPatch = {
      planLifecycle: transitionPlanLifecycleArtifactIdentity({
        lifecycle,
        sessionKey: expectedSessionKey,
        artifactIdentity: currentArtifactIdentity,
      }),
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
  const exactPendingDecision = resolveApprovedPlanSameTurnFallbackDecision({
    expectedSessionKey: input.sessionKey || "__active_session__",
    currentSessionKey: input.sessionKey || "__active_session__",
    expectedHandoff: input.handoff,
    currentHandoff: latest.pendingPlanApprovalHandoff,
    hasExactPlanApprovalHandoff: exactLifecycleHandoff,
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
  if (!claimPlanExecutionDispatch(executionLease.executionLeaseId)) {
    logStoreEvent("plan_approval_handoff_deduped", buildPlanApprovalHandoffDedupLogPayload({
      state: latest,
      reason: "execution_lease_dispatch_already_claimed",
      planTurnId: input.planTurnId,
      executionTurnId: executionLease.executionTurnId,
      currentTurnStatus: currentTurn.status,
    }));
    return false;
  }

  const language = latest.config.language === "en" ? "en" : "zh";
  const prompt = input.handoff.prompt;
  if (buildPlanExecutionInstructionHash(prompt) !== executionLease.instructionHash) {
    releasePlanExecutionDispatch(executionLease.executionLeaseId);
    logStoreEvent("plan_approval_same_turn_execution_skipped", buildPlanApprovalHandoffDedupLogPayload({
      state: latest,
      reason: "execution_instruction_hash_mismatch",
      planTurnId: input.planTurnId,
      executionTurnId: executionLease.executionTurnId,
      currentTurnStatus: currentTurn.status,
    }));
    return false;
  }
  const initialExecuteRecoveryState = resolveApprovedPlanInitialExecutionRecovery(
    latest.planTasks,
  );

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

  if (childAgentMessages !== latest.agentMessages) {
    const contextPatch = { agentMessages: childAgentMessages };
    if (input.sessionKey) latest.updateRuntimeForSession?.(input.sessionKey, contextPatch);
    if (!input.sessionKey || isSessionRuntimeActive(latest, input.sessionKey)) {
      input.setActiveState(contextPatch);
    }
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
      // Approval starts a new execute run. The reviewed Plan remains durable
      // scope/evidence provenance through preservePlanState; it is no longer a
      // second runtime mode that the tool layer has to reinterpret.
      resolvedIntent: "execute",
      ...(initialExecuteRecoveryState
        ? {
            forceExecuteRecoveryMode: initialExecuteRecoveryState.mode,
            forceExecuteRecoveryState: initialExecuteRecoveryState,
          }
        : {}),
      executionConsentGranted: false,
      parentRunIdOverride: input.handoff.parentRunId || undefined,
      runIdOverride: input.handoff.executionRunId,
      planExecutionLeaseId: executionLease.executionLeaseId,
      planExecutionInstructionHash: executionLease.instructionHash,
      skipIntentResolution: true,
      intentSummary: language === "zh"
        ? "用户已批准计划，MAIN 将在当前回合中按 plan.md 落地。"
        : "The user approved the plan; MAIN will execute plan.md in the current turn.",
    }) === true;
  } catch (error) {
    submissionError = error instanceof Error ? error.message : String(error);
  }
  if (!submissionStarted) {
    releasePlanExecutionDispatch(executionLease.executionLeaseId);
    const failedAt = Date.now();
    const failedSnapshot = input.get();
    const failedLifecycle = failedSnapshot.planLifecycle;
    const ownsFailedReservation =
      failedLifecycle.status === "handoff_pending" &&
      failedLifecycle.executionLease?.executionLeaseId === executionLease.executionLeaseId &&
      failedLifecycle.executionLease.executionRunId === input.handoff.executionRunId &&
      failedLifecycle.executionLease.parentRunId === input.handoff.parentRunId &&
      failedLifecycle.approvalLease?.leaseId === input.handoff.approvalLeaseId &&
      isPlanApprovalLeaseBoundToState(failedLifecycle);
    const failedDispatchTransition = ownsFailedReservation
      ? reducePlanLifecycle(failedLifecycle, {
          type: "pause",
          expectedVersion: failedLifecycle.version,
          at: failedAt,
          pause: {
            reason: "plan_execution_dispatch_failed",
            resultKind: "error",
            resumeCondition: "explicit_resume",
          },
        })
      : null;
    const reservedAttemptPaused = !!failedDispatchTransition &&
      failedDispatchTransition.disposition !== "rejected" &&
      failedDispatchTransition.state.status === "paused";
    const rollbackPatch = {
      ...(reservedAttemptPaused
        ? { planLifecycle: failedDispatchTransition.state }
        : {}),
      isPlanApproved: false,
      currentTurnExecutionConsent: { turnId: null, granted: false },
      pendingPlanApprovalHandoff: reservedAttemptPaused ? null : input.handoff,
      planApprovalExecutionStartedForTurnId: null,
      planStage: "ready_to_execute" as const,
      agentStatus: "idle" as const,
      isGenerating: false,
      abortController: null,
    };
    if (input.sessionKey) {
      failedSnapshot.updateRuntimeForSession?.(input.sessionKey, rollbackPatch);
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
      pendingPreserved: !reservedAttemptPaused,
      lifecyclePaused: reservedAttemptPaused,
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
        // A Zustand updater that returns the current Store object is a semantic
        // no-op. Treating it as an authored patch would feed every runtime field
        // back through the Session synchronizer and replace the opaque owner CAS
        // token. Preserve explicit `replace=true` restores unchanged.
        if (patch === s && replace !== true) return {};
        const currentSessionKey = resolveSessionRuntimeKey(
          resolveSessionWorkspaceKey(s.currentWorkspace),
          s.currentSessionId,
        );
        const nextWorkspace = patch.currentWorkspace !== undefined ? patch.currentWorkspace : s.currentWorkspace;
        const nextSessionId = patch.currentSessionId !== undefined ? patch.currentSessionId : s.currentSessionId;
        const sessionKey = resolveSessionRuntimeKey(resolveSessionWorkspaceKey(nextWorkspace), nextSessionId);
        const runtimePatch = pickSessionRuntimePatch(patch);
        // A patch that changes the visible Session owner is a UI/bootstrap
        // transition, not an implicit publication to the destination runtime.
        // Destination runtime state must be restored or written explicitly via
        // runtimeBySessionKey/updateRuntimeForSession; inferring ownership from
        // the post-transition key can overwrite a live background Session.
        const changesSessionOwner = currentSessionKey !== sessionKey;
        if (sessionKey && !changesSessionOwner && Object.keys(runtimePatch).length > 0) {
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

// Transient capability broker: envelopes never enter persisted Zustand state.
// They bridge the synchronous visible submit event to a next-paint Store call.
const visibleGoalSubmissionAuthorizationBroker =
  createVisibleGoalSubmissionAuthorizationBroker();
const goalContinuationAuthorizationBroker =
  createGoalContinuationAuthorizationBroker();

// Admission persistence is serialized per exact Session. This prevents a
// later A/B/C snapshot from overtaking an earlier one while still allowing
// unrelated Sessions to persist independently.
const workspaceInstructionAdmissionPipelines = new Map<string, Promise<void>>();
const workspaceInstructionAdmissionsByIdentity = new Map<
  string,
  Promise<WorkspaceInstructionAcceptance>
>();
const workspaceInstructionCancellationRedispatchBySession = new Map<
  string,
  Promise<SessionCancellationSettlement>
>();
interface WorkspaceInstructionCancellationFailure {
  sessionEpoch: string;
  receiptId: string;
  turnId: string;
  disposition: string;
}
const workspaceInstructionCancellationFailureBySession = new Map<
  string,
  WorkspaceInstructionCancellationFailure
>();
const WORKSPACE_INSTRUCTION_START_GRACE_MS = 250;
const workspaceInstructionStartingGraceByClaim = new Map<
  string,
  "scheduled" | "consumed"
>();
const workspaceInstructionStartingGraceTimeoutByClaim = new Map<
  string,
  ReturnType<typeof setTimeout>
>();

function clearWorkspaceInstructionStartingGrace(claimId: string): void {
  const timeoutId = workspaceInstructionStartingGraceTimeoutByClaim.get(claimId);
  if (timeoutId !== undefined) clearTimeout(timeoutId);
  workspaceInstructionStartingGraceTimeoutByClaim.delete(claimId);
  workspaceInstructionStartingGraceByClaim.delete(claimId);
}

interface LocalFastExecutionLease {
  readonly sessionKey: string;
  readonly turnId: string;
  readonly runId: string;
  readonly clientSubmissionId: string | null;
  readonly receiptId: string | null;
  readonly controller: AbortController;
  readonly claim: WorkspaceInstructionDispatchClaim | null;
  readonly completion: Promise<GameStudioLocalSlashCompletionResult>;
  readonly hasRuntimeOwnership: () => boolean;
  readonly retireWorkspaceClaim: () => boolean;
  readonly release: () => void;
  settled: boolean;
  dispatcherObserved: boolean;
}

const localFastExecutionLeasesByOwner = new Map<string, LocalFastExecutionLease>();
const localFastExecutionLeasesByClaim = new Map<string, LocalFastExecutionLease>();

function localFastExecutionOwnerKey(sessionKey: string, turnId: string): string {
  return `${sessionKey}\u0000${turnId}`;
}

function readLocalFastOwnerState(
  state: AppState,
  sessionKey: string,
): AppState | null {
  if (isSessionRuntimeActive(state, sessionKey)) return state;
  const runtime = state.runtimeBySessionKey[sessionKey];
  return runtime ? ({ ...state, ...runtime } as AppState) : null;
}

function hasVerifiedLocalFastConclusion(
  state: AppState,
  claim: WorkspaceInstructionDispatchClaim,
  result: GameStudioLocalSlashCompletionResult,
): boolean {
  const ownerState = readLocalFastOwnerState(state, claim.sessionKey);
  const owner = result.conclusionOwner;
  if (!ownerState || !result.conclusionAppended || !owner) return false;
  if (
    owner.disposition === "recovery_completed"
      ? owner.parentRunId !== result.runId
      : owner.runId !== result.runId
  ) return false;
  const hasCanonicalProjection = (
    runtimeEvents: readonly MainThreadEvent[],
    conversationTurns: readonly ConversationTurn[],
    taskFlow: readonly TaskBlock[],
  ) => {
    const turn = conversationTurns.find((candidate) => candidate.id === owner.turnId);
    const outcome = turn?.runtimeOutcome;
    const runConclusions = runtimeEvents.filter((event) =>
      event.type === "run.completed" &&
      event.threadId === claim.sessionKey &&
      event.turnId === owner.turnId &&
      event.runId === owner.runId
    );
    const turnConclusions = runtimeEvents.filter((event) =>
      event.type === "turn.completed" &&
      event.threadId === claim.sessionKey &&
      event.turnId === owner.turnId
    );
    const runConclusion = runConclusions[0];
    const turnConclusion = turnConclusions[0];
    const finals = taskFlow.filter(
      (block): block is Extract<TaskBlock, { type: "agent" }> =>
      block.turnId === owner.turnId &&
      block.type === "agent" &&
      block.visibility === "assistant_final"
    );
    if (
      !turn ||
      outcome?.status !== "completed" ||
      outcome.runId !== owner.runId ||
      outcome.parentRunId !== owner.parentRunId ||
      outcome.resultKind !== owner.resultKind ||
      runConclusions.length !== 1 ||
      runConclusion?.type !== "run.completed" ||
      runConclusion.parentRunId !== owner.parentRunId ||
      runConclusion.resultKind !== owner.resultKind ||
      runConclusion.summary !== owner.summary ||
      turnConclusions.length !== 1 ||
      turnConclusion?.type !== "turn.completed" ||
      turnConclusion.resultKind !== owner.resultKind ||
      finals.length !== 1 ||
      finals[0].content !== owner.summary ||
      finals[0].streaming === true
    ) return false;
    if (
      owner.disposition !== "recovery_completed" &&
      (
        turn.clientSubmissionId !== claim.clientSubmissionId ||
        turn.workspaceInstructionReceiptId !== claim.receiptId
      )
    ) return false;
    if (owner.disposition !== "recovery_completed") return true;
    return runtimeEvents.filter((event) =>
      event.type === "run.completed" &&
      event.threadId === claim.sessionKey &&
      event.turnId === claim.turnId &&
      event.runId === result.runId
    ).length === 1;
  };
  if (!hasCanonicalProjection(
    ownerState.runtimeEvents,
    ownerState.conversationTurns,
    ownerState.taskFlow,
  )) {
    return false;
  }
  const queue = ownerState.workspaceTurnQueue;
  const head = queue?.entries[0];
  // The durability barrier deliberately persists the terminal projection
  // while retaining its dispatching FIFO head. This prevents an older generic
  // autosave from resurrecting a nonterminal snapshot. The dispatcher may
  // retire the head in memory only after observing both halves together.
  return !!queue &&
    queue.sessionKey === claim.sessionKey &&
    queue.sessionEpoch === claim.sessionEpoch &&
    head?.status === "dispatching" &&
    head.claim?.claimId === claim.claimId &&
    head.receipt.receiptId === claim.receiptId &&
    head.receipt.clientSubmissionId === claim.clientSubmissionId &&
    head.receipt.turnId === claim.turnId &&
    workspaceInstructionEnvelopeIdentity(head) === claim.instructionEnvelopeIdentity;
}

function createWorkspaceRuntimeIdentity(prefix: string, at = Date.now()): string {
  const randomPart = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2, 12);
  return `${prefix}-${at}-${randomPart}`;
}

function enqueueWorkspaceInstructionAdmission<T>(
  sessionKey: string,
  task: () => Promise<T>,
): Promise<T> {
  const previous = workspaceInstructionAdmissionPipelines.get(sessionKey) || Promise.resolve();
  const current = previous.catch(() => undefined).then(task);
  const settled = current.then(() => undefined, () => undefined);
  workspaceInstructionAdmissionPipelines.set(sessionKey, settled);
  void settled.finally(() => {
    if (workspaceInstructionAdmissionPipelines.get(sessionKey) === settled) {
      workspaceInstructionAdmissionPipelines.delete(sessionKey);
    }
  });
  return current;
}

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
  closeTurnAsCanceled: (turnId, options) => {
    const current = get();
    const turn = current.conversationTurns.find((candidate) => candidate.id === turnId);
    if (!turn) return false;
    const language = current.config.language === "en" ? "en" : "zh";
    const reason = String(options?.reason || "user_cancelled").trim() || "user_cancelled";
    const message = String(options?.message || "").trim() || (
      language === "en"
        ? "This turn was canceled by the user and is now closed."
        : "用户已取消，本回合已完成收口。"
    );
    const scopeKey = resolveSessionWorkspaceKey(current.currentWorkspace);
    const sessionKey = resolveSessionRuntimeKey(scopeKey, current.currentSessionId);
    if (!sessionKey) return false;
    const pendingCancellation = getPendingSessionCancellation(sessionKey);
    if (pendingCancellation) {
      logStoreEvent("canceled_turn_transaction_already_pending", {
        sessionKey,
        requestedTurnId: turnId,
        pendingTurnId: pendingCancellation.turnId,
      });
      return true;
    }
    const ownedActionRequest = current.activeActionRequest?.sessionKey === sessionKey &&
      current.activeActionRequest.turnId === turnId
        ? current.activeActionRequest
        : null;
    const ownedMarker = current.harnessRunMarker?.sessionKey === sessionKey &&
      current.harnessRunMarker.turnId === turnId
        ? current.harnessRunMarker
        : null;
    const ownerRunId = ownedActionRequest?.runId || getHarnessActionRunId(ownedMarker);
    const ownerParentRunId = ownedActionRequest?.parentRunId || ownedMarker?.parentRunId || null;
    const expectedAbortController = current.abortController;
    const {
      sessionGet,
      sessionSet,
      getSessionRevisionToken,
      publishOwnerScopedRuntimeProjection,
    } = createSubmitSessionRuntimeController<AppState, SessionRuntimeState>({
      get,
      set,
      runSessionKey: sessionKey,
      createRuntimeFromState: createSessionRuntimeFromState,
      pickRuntimePatch: pickSessionRuntimePatch,
      normalizePatch: (patch) =>
        normalizeTaskFlowPatchForConsumedReplyOptions(patch as Record<string, unknown>),
      derivePlanStageFromArtifacts,
      createDefaultCurrentTurnState,
      logStoreEvent,
    });

    const cancellationStart = beginSessionCancellation(sessionKey, turnId, async () => {
      const result = await commitCanceledTurn({
        sessionKey,
        scopeKey,
        sessionId: current.currentSessionId,
        turnId,
        runId: ownerRunId,
        parentRunId: ownerParentRunId,
        reason,
        message,
        expectedAbortController,
        nextTaskId: () => get()._nextTaskId(),
        sessionGet,
        getSessionRevisionToken,
        persistProjection: (projectedState) => persistSubmitRuntimeProjection({
          state: projectedState,
          scopeKey,
          sessionId: current.currentSessionId,
          sanitizeTaskBlocksForPersist,
          buildRuntimeSnapshot: buildSessionRuntimeSnapshotFromStoreState,
          persistSessionRecord: saveProjectSession,
          nowMs,
        }),
        publishProjection: publishOwnerScopedRuntimeProjection,
        persistHarnessMarker: settleCanceledTurnHarnessProjection,
        log: logStoreEvent,
        nowMs,
      });
      const settledState = sessionGet();
      const hasExistingTerminal = settledState.runtimeEvents.some((event) =>
        isTerminalTurnEvent(event) &&
        event.threadId === sessionKey &&
        event.turnId === turnId
      );
      const hasVisibleFinal = settledState.taskFlow.some((block) =>
        block.type === "agent" &&
        block.turnId === turnId &&
        block.visibility === "assistant_final"
      );
      const terminalSettled = result.disposition.startsWith("already_closed")
        ? hasExistingTerminal && hasVisibleFinal
        : hasCanceledTurnTerminalProjection({
            sessionKey,
            turnId,
            runtimeEvents: settledState.runtimeEvents,
            taskFlow: settledState.taskFlow,
          });
      logStoreEvent("canceled_turn_transaction_settled", {
        sessionKey,
        turnId,
        runId: result.cancellationRunId,
        committed: result.committed,
        disposition: result.disposition,
        attempts: result.attempts,
        terminalSettled,
      });
      return {
        sessionKey,
        turnId,
        terminalSettled,
        disposition: result.disposition,
      };
    }, {
      maxReconciliationAttempts: 2,
      reconcile: async ({ attempt, previousSettlement, error }) => {
        logStoreEvent("canceled_turn_reconciliation_started", {
          sessionKey,
          turnId,
          attempt,
          previousDisposition: previousSettlement?.disposition || null,
          error: error instanceof Error ? error.message : error ? String(error) : null,
        });
        return reconcileCanceledTurnWithLatestRuntime({
          getState: get,
          setState: set,
          sessionKey,
          scopeKey,
          sessionId: current.currentSessionId,
          turnId,
          runId: ownerRunId,
          parentRunId: ownerParentRunId,
          reason,
          message,
          expectedAbortController,
          nextTaskId: () => get()._nextTaskId(),
        });
      },
    });
    if (!cancellationStart.started) return true;

    // The fence above must exist before revoking any transient control-plane
    // capability. Keep the Turn visibly running/paused until commitCanceledTurn
    // has durably persisted (or explicitly selected memory fallback) and the
    // owner-scoped terminal projection publishes idle with the conclusion.
    sessionSet((state) => {
      const action = state.activeActionRequest;
      const ownsAction = !!action &&
        action.sessionKey === sessionKey &&
        action.turnId === turnId &&
        (!ownerRunId || action.runId === ownerRunId);
      const ownsCurrentExecution = state.currentTurnId === turnId && (
        !ownerRunId ||
        getHarnessActionRunId(state.harnessRunMarker) === ownerRunId ||
        ownsAction
      );
      return {
        ...(ownsAction ? { activeActionRequest: null } : {}),
        ...(ownsAction || ownsCurrentExecution
          ? {
              pendingReviewResolve: null,
              pendingReviewTaskId: null,
              pendingToolCall: null,
            }
          : {}),
      };
    });
    return true;
  },
  stopGeneration: () => {
    const currentTurnId = get().currentTurnId;
    if (get().selectedMainModeKey === "image_studio" || get().imageStudio.activeStreamId) {
      activeImageStudioStreamCleanup?.();
      activeImageStudioStreamCleanup = null;
      void cancelImageStudioJob().catch(() => {});
      set((s) => ({
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
      }));
      if (currentTurnId) {
        get().closeTurnAsCanceled(currentTurnId, { reason: "image_generation_cancelled" });
      } else {
        set({ isGenerating: false, abortController: null, agentStatus: "idle" });
      }
      return;
    }
    const currentSessionKey = get().getCurrentSessionKey();
    const localFastLease = currentTurnId && currentSessionKey
      ? localFastExecutionLeasesByOwner.get(
          localFastExecutionOwnerKey(currentSessionKey, currentTurnId),
        ) || null
      : null;
    const localFastLeaseOwnsCurrentTurn = !!localFastLease && (
      !localFastLease.claim || get().conversationTurns.some((turn) =>
        turn.id === currentTurnId &&
        turn.clientSubmissionId === localFastLease.clientSubmissionId &&
        turn.workspaceInstructionReceiptId === localFastLease.receiptId
      )
    );
    if (
      localFastLease &&
      !localFastLease.settled &&
      localFastLeaseOwnsCurrentTurn &&
      get().abortController === localFastLease.controller
    ) {
      // The local-fast completion owns the only cancellation conclusion. Do
      // not let the generic cancel path race it with a second Turn terminal.
      localFastLease.controller.abort();
      set((s) => ({
        taskFlow: s.taskFlow.map((block) =>
          block.turnId === currentTurnId && block.type === "agent" && block.options?.length
            ? { ...block, options: undefined }
            : block
        ),
      }));
      return;
    }
    get().abortController?.abort();
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
    clearCurrentTurnOptions();
    if (currentTurnId) {
      get().closeTurnAsCanceled(currentTurnId, {
        reason: currentStatus === "pending_review" ? "review_cancelled" : "user_cancelled",
      });
    } else {
      set({
        isGenerating: false,
        abortController: null,
        agentStatus: "idle",
        pendingRunDecision: null,
        pendingRunDecisionResolver: null,
      });
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
  ensurePlanArtifactsHydratedForWorkspace: async (options: { openPanel?: boolean; reason?: string } = {}) => {
    const state = get();
    const hydrationWorkspace = state.currentWorkspace;
    const hydrationSessionKey = resolveSessionRuntimeKey(
      resolveSessionWorkspaceKey(hydrationWorkspace),
      state.currentSessionId,
    );
    const hydrationSessionEpoch = resolveActiveSessionPlanLifecycleEpoch(
      state,
      hydrationSessionKey,
    );
    const language = state.config.language === "en" ? "en" : "zh";
    const alreadyHasPlanState =
      state.planArtifacts.length > 0 ||
      state.planTasks.length > 0 ||
      state.planStage !== "idle" ||
      state.planLifecycle.status !== "empty";

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
      hydrated = await hydrateExistingPlanArtifactsForWorkspace(hydrationWorkspace, language);
    } catch {
      hydrated = null;
    }
    const stateAfterHydrationRead = get();
    const liveSessionKey = resolveSessionRuntimeKey(
      resolveSessionWorkspaceKey(stateAfterHydrationRead.currentWorkspace),
      stateAfterHydrationRead.currentSessionId,
    );
    const liveSessionEpoch = resolveActiveSessionPlanLifecycleEpoch(
      stateAfterHydrationRead,
      liveSessionKey,
    );
    if (
      stateAfterHydrationRead.currentWorkspace !== hydrationWorkspace ||
      liveSessionKey !== hydrationSessionKey ||
      !hydrationSessionEpoch ||
      liveSessionEpoch !== hydrationSessionEpoch
    ) {
      logStoreEvent("plan_workspace_hydration_skipped_stale_owner", {
        workspace: hydrationWorkspace || null,
        sessionKey: hydrationSessionKey,
        liveWorkspace: stateAfterHydrationRead.currentWorkspace || null,
        liveSessionKey,
        hydrationSessionEpoch,
        liveSessionEpoch,
        reason: options.reason || "open_plan_panel",
      });
      return false;
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
      const scopedSessionKey = resolveSessionRuntimeKey(
        resolveSessionWorkspaceKey(s.currentWorkspace),
        s.currentSessionId,
      );
      const scopedSessionEpoch = resolveActiveSessionPlanLifecycleEpoch(s, scopedSessionKey);
      if (
        s.currentWorkspace !== hydrationWorkspace ||
        scopedSessionKey !== hydrationSessionKey ||
        !hydrationSessionEpoch ||
        scopedSessionEpoch !== hydrationSessionEpoch
      ) {
        return {};
      }
      const liveAlreadyHasPlanState =
        s.planArtifacts.length > 0 ||
        s.planTasks.length > 0 ||
        s.planStage !== "idle" ||
        s.planLifecycle.status !== "empty";
      if (liveAlreadyHasPlanState) return openPanelPatch;

      const nextStage = derivePlanStageFromArtifacts(
        hydratedPlan.artifacts,
        hydratedPlan.tasks,
        false,
        s.planStage,
      );
      const threadId =
        resolveSessionRuntimeKey(resolveSessionWorkspaceKey(s.currentWorkspace), s.currentSessionId) ||
        "default";
      const timestampMs = Date.now();
      const ownerLifecycle =
        s.planLifecycle.sessionKey === threadId &&
        s.planLifecycle.sessionEpoch === hydrationSessionEpoch
        ? s.planLifecycle
        : createPlanLifecycleState({
            sessionKey: threadId,
            sessionEpoch: hydrationSessionEpoch,
            updatedAt: timestampMs,
          });
      const lifecycleTransition = reducePlanLifecycle(ownerLifecycle, {
        type: "hydrate_discovery",
        expectedVersion: ownerLifecycle.version,
        at: timestampMs,
        planTurnId: s.currentTurnId || null,
        artifactIdentity: buildPlanApprovalIdentity(hydratedPlan.artifacts),
      });
      const nextEvent = withEventSchema({
        type: "plan_state_hydrated",
        threadId,
        turnId: s.currentTurnId || undefined,
        timestampMs,
        reason: options.reason || "open_plan_panel",
        taskCount: hydratedPlan.tasks.length,
        artifactPaths: hydratedPlan.artifacts.map((artifact) => artifact.path),
      });

      return {
        planArtifacts: hydratedPlan.artifacts,
        planTasks: hydratedPlan.tasks,
        isPlanApproved: false,
        planStage: nextStage,
        planLifecycle: lifecycleTransition.disposition === "rejected"
          ? ownerLifecycle
          : lifecycleTransition.state,
        ...openPanelPatch,
        runtimeEvents: appendRuntimeEvent(s.runtimeEvents, nextEvent),
      };
    });
    logStoreEvent("plan_workspace_hydrated_for_panel", {
      workspace: state.currentWorkspace || null,
      reason: options.reason || "open_plan_panel",
      artifacts: hydratedPlan.artifacts.map((artifact) => artifact.path),
      taskCount: hydratedPlan.tasks.length,
      promotedToExecuting: false,
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
      preferSubagents: false,
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
  runImageStudioGeneration: (text, images, admittedOwner) => {
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
    const turnId = admittedOwner?.turnId || `image-turn-${issuedAt}-${Math.random().toString(36).slice(2, 8)}`;
    const userBlockId = admittedOwner?.admittedUserBlockId ?? get()._nextTaskId();
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
        runtimeSnapshot: sanitizeSessionRuntimeSnapshotForPersist(buildSessionRuntimeSnapshotFromStoreState(latest)),
      });
    };

    set((s) => ({
      taskFlow: admittedOwner
        ? [...s.taskFlow, generationBlock]
        : [...s.taskFlow, userBlock, generationBlock],
      conversationTurns: admittedOwner
        ? s.conversationTurns.map((turn) =>
            turn.id === turnId
              ? {
                  ...turn,
                  title: turnTitle,
                  intentSummary: language === "en" ? "Generate an image in Image Studio." : "在图像工作室中生成图片。",
                  mode: "chat" as const,
                  intent: "respond" as const,
                  displayIntent: "respond" as const,
                  status: "executing" as const,
                  summary: "",
                  blockIds: turn.blockIds.includes(generationBlockId)
                    ? turn.blockIds
                    : [...turn.blockIds, generationBlockId],
                  processCollapsed: false,
                  collapsed: false,
                }
              : (turn.processCollapsed ?? turn.collapsed)
              ? turn
              : { ...turn, processCollapsed: true, collapsed: true }
          )
        : [
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
              mode: "chat" as const,
              intent: "respond" as const,
              displayIntent: "respond" as const,
              status: "executing" as const,
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
    const finishTurn = (resultKind: "success" | "error", summary: string) => {
      const isWebFallback = !isLocalImageStudioProvider(get().imageStudio.config);
      const timestampMs = Date.now();
      const runId = `run-image-${turnId}`;
      set((s) => {
        if (s.runtimeEvents.some((event) =>
          isTerminalTurnEvent(event) && event.threadId === runSessionKey && event.turnId === turnId
        )) return {};
        const existingFinal = [...s.taskFlow].reverse().find((block) =>
          block.turnId === turnId && block.type === "agent" && block.visibility === "assistant_final"
        );
        const finalBlockId = existingFinal?.id ?? s._nextTaskId();
        let foundFinal = false;
        let taskFlow = s.taskFlow.map((block) => {
          if (block.id !== finalBlockId || block.type !== "agent") return block;
          foundFinal = true;
          return {
            ...stripAssistantPublicProgress(block),
            content: summary,
            streaming: false,
            hiddenProcess: false,
            visibility: "assistant_final" as const,
          };
        });
        if (!foundFinal) {
          taskFlow = [...taskFlow, {
            id: finalBlockId,
            turnId,
            type: "agent" as const,
            content: summary,
            streaming: false,
            visibility: "assistant_final" as const,
          }];
        }
        let runtimeEvents = s.runtimeEvents;
        if (!runtimeEvents.some((event) =>
          event.type === "run.started" && event.threadId === runSessionKey && event.turnId === turnId && event.runId === runId
        )) {
          runtimeEvents = appendRuntimeEvent(runtimeEvents, withEventSchema({
            type: "run.started",
            threadId: runSessionKey,
            turnId,
            timestampMs,
            runId,
            parentRunId: null,
          }));
        }
        runtimeEvents = appendRuntimeEvent(runtimeEvents, withEventSchema({
          type: "run.completed",
          threadId: runSessionKey,
          turnId,
          timestampMs,
          runId,
          parentRunId: null,
          resultKind,
          summary,
        }));
        runtimeEvents = appendRuntimeEvent(runtimeEvents, withEventSchema({
          type: "turn.completed",
          threadId: runSessionKey,
          turnId,
          timestampMs,
          resultKind,
        }));
        return {
        isGenerating: false,
        abortController: null,
        agentStatus: "idle",
        imageStudio: {
          ...s.imageStudio,
          activeJobId: null,
          activeStreamId: null,
          ...(isWebFallback ? { cooldownUntil: Date.now() + 15000 } : {}),
        },
        taskFlow,
        runtimeEvents,
        conversationTurns: s.conversationTurns.map((turn) =>
          turn.id === turnId
            ? {
                ...turn,
                status: "done" as const,
                summary,
                collapsed: false,
                blockIds: turn.blockIds.includes(finalBlockId)
                  ? turn.blockIds
                  : [...turn.blockIds, finalBlockId],
                runtimeOutcome: {
                  status: "completed" as const,
                  reason: resultKind === "error" ? summary : "image_generation_completed",
                  resultKind,
                  runId,
                  parentRunId: null,
                  updatedAt: timestampMs,
                },
                elapsedTime: Math.max(
                  0,
                  Number(turn.elapsedTime) || 0,
                  Number(s.elapsedTime) || 0,
                ),
              }
            : turn
        ),
        };
      });
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
          get().closeTurnAsCanceled(turnId, {
            reason: "image_generation_cancelled",
            message: language === "en" ? "Image generation was canceled; this turn is now closed." : "图片生成已取消，本回合已完成收口。",
          });
          persistSession();
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
        finishTurn("success", language === "en" ? "Image generated." : "图片已生成。");
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
    invalidateWorkspaceClearTransaction(normalizedPath);
    discardWorkspaceClearSubmissionState(normalizedPath, "workspace_removed");
    discardWorkspaceClearSubmissionReplayState(normalizedPath);
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
    set((s) => {
      const sessionKey = resolveSessionRuntimeKey(
        resolveSessionWorkspaceKey(s.currentWorkspace),
        s.currentSessionId,
      );
      if (!sessionKey) return {};
      const replacement = createSessionRuntimeFromState(s);
      return {
        runtimeBySessionKey: {
          ...s.runtimeBySessionKey,
          [sessionKey]: preserveSubmitSessionRuntimeOwnership(
            s.runtimeBySessionKey[sessionKey],
            replacement,
          ),
        },
      };
    });
  },
  restoreRuntimeForSession: (sessionKey: string | null, options: { requireTranscript?: boolean; resetPanels?: boolean } = {}) => {
    if (!sessionKey) return false;
    const state = get();
    const storedRuntime = state.runtimeBySessionKey[sessionKey];
    // runtimeBySessionKey is an in-process cache, not a restart boundary. Running
    // Harness owners and Plan execution leases must survive an ordinary Session
    // switch; restart normalization would incorrectly retire both here.
    const runtime = storedRuntime;
    if (!runtime) return false;
    if (options.requireTranscript && !hasSessionRuntimeTranscript(runtime)) return false;
    set({
      ...getSessionRuntimeUiPatch(runtime, options),
      dismissedPendingDecisionInputKey: null,
    });
    return true;
  },
  markWorkspaceClearSubmissionReplayReady: (workspacePath, sessionId) => {
    const workspaceKey = resolveSessionWorkspaceKey(workspacePath);
    const state = get();
    if (
      resolveSessionWorkspaceKey(state.currentWorkspace) !== workspaceKey ||
      state.currentSessionId !== sessionId
    ) {
      return false;
    }
    workspaceClearSubmissionReplayReadySessionKeys.set(
      workspaceKey,
      resolveSessionRuntimeKey(workspaceKey, sessionId),
    );
    scheduleWorkspaceClearSubmissionReplay(workspaceKey);
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
      workspaceClearSubmissionReplayNotReady.add(GLOBAL_CHAT_KEY);
      workspaceClearSubmissionReplayReadySessionKeys.delete(GLOBAL_CHAT_KEY);
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
        preferSubagents: false,
        webSearchEnabled: false,
        webSearchProvider: "duckduckgo",
        approvedLocalFileReadPaths: [],
        approvedShellPermissionRules: [],
        readOnlyAutoApproveForSession: false,
        queuedUserMessage: null,
        activeGuidance: null,
        workspaceTurnQueue: null,
        workspaceInstructionLedger: [],
        transcriptPartial: false,
        transcriptLoadedTurns: 0,
        transcriptTotalTurns: 0,
        showWorkspaceTreePanel: false,
      }));
      void get().refreshInstructionAndHookState()
        .finally(() => {
          workspaceClearSubmissionReplayNotReady.delete(GLOBAL_CHAT_KEY);
          scheduleWorkspaceClearSubmissionReplay(GLOBAL_CHAT_KEY);
        });
      return;
    }
    workspaceClearSubmissionReplayNotReady.add(resolveSessionWorkspaceKey(normalizedPath));
    workspaceClearSubmissionReplayReadySessionKeys.delete(resolveSessionWorkspaceKey(normalizedPath));
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
        preferSubagents: false,
        webSearchEnabled: false,
        webSearchProvider: "duckduckgo",
        approvedLocalFileReadPaths: [],
        approvedShellPermissionRules: [],
        readOnlyAutoApproveForSession: false,
        queuedUserMessage: null,
        activeGuidance: null,
        workspaceTurnQueue: null,
        workspaceInstructionLedger: [],
        transcriptPartial: false,
        transcriptLoadedTurns: 0,
        transcriptTotalTurns: 0,
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
        return get().refreshInstructionAndHookState()
          .finally(() => {
            workspaceClearSubmissionReplayNotReady.delete(resolveSessionWorkspaceKey(normalizedPath));
            workspaceClearSubmissionReplayNotReady.delete(resolveSessionWorkspaceKey(stablePath));
            scheduleWorkspaceClearSubmissionReplay(stablePath);
          });
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
    const sessionKey = resolveSessionRuntimeKey(workspacePath, sessionId);
    const current = get();
    const activeSessionKey = resolveSessionRuntimeKey(
      resolveSessionWorkspaceKey(current.currentWorkspace),
      current.currentSessionId,
    );
    const ownedRuntime = sessionKey
      ? activeSessionKey === sessionKey
        ? createSessionRuntimeFromState(current)
        : current.runtimeBySessionKey[sessionKey] || null
      : null;
    if (ownedRuntime && sessionKey) {
      const revocation = revokeSessionRuntimeBeforeDelete({
        runtime: ownedRuntime,
        sessionKey,
        closeHarness: (marker) => !!closeHarnessRunMarkerForSessionDeletion({
          runId: marker.runId,
          sessionKey: marker.sessionKey,
          turnId: marker.turnId!,
          instanceId: marker.instanceId,
          startedAt: marker.startedAt,
        }),
        onError: (phase, error) => {
          logStoreEvent("session_delete_runtime_revocation_failed", {
            sessionKey,
            phase,
            error: error instanceof Error ? error.message : String(error),
          });
        },
      });
      logStoreEvent("session_runtime_revoked_before_delete", {
        sessionKey,
        turnId: ownedRuntime.currentTurnId,
        agentStatus: ownedRuntime.agentStatus,
        ...revocation,
      });
    }
    set((s) => {
      const wsSessions = s.sessionsByWorkspace[workspacePath];
      if (!wsSessions) return s;
      const filtered = wsSessions.filter((sess) => sess.id !== sessionId);
      const isCurrentSession = s.currentSessionId === sessionId;
      const nextSessionId = isCurrentSession
        ? options.nextSessionId ?? filtered[0]?.id ?? null
        : s.currentSessionId;
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
              preferSubagents: false,
              webSearchEnabled: false,
              webSearchProvider: "duckduckgo",
              approvedLocalFileReadPaths: [],
              approvedShellPermissionRules: [],
              readOnlyAutoApproveForSession: false,
              queuedUserMessage: null,
              activeGuidance: null,
              workspaceTurnQueue: null,
              workspaceInstructionLedger: [],
              transcriptPartial: false,
              transcriptLoadedTurns: 0,
              transcriptTotalTurns: 0,
            }
          : {}),
      };
    });
  },

  updateSession: (workspacePath: string, sessionId: number, patch: Partial<Session>) => {
    set((s) => {
      const wsSessions = s.sessionsByWorkspace[workspacePath];
      // Returning the whole Store for a semantic no-op makes the Session sync
      // middleware interpret every runtime field as an authored patch. That
      // needlessly replaces the opaque owner runtime object and invalidates
      // revision-token CAS used by durable local-fast publication.
      if (!wsSessions) return {};
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
      if (!changed) return {};
      return {
        sessionsByWorkspace: {
          ...s.sessionsByWorkspace,
          [workspacePath]: nextSessions,
        },
      };
    });
  },

  setCurrentSessionId: (id: number | null) => {
    const workspaceKey = resolveSessionWorkspaceKey(get().currentWorkspace);
    if (get().currentSessionId !== id) {
      workspaceClearSubmissionReplayReadySessionKeys.delete(workspaceKey);
    }
    set((s) => ({
      currentSessionId: id,
      activeSessionByWorkspace: {
        ...s.activeSessionByWorkspace,
        [resolveSessionWorkspaceKey(s.currentWorkspace)]: id,
      },
      ...(s.currentSessionId !== id ? { autoApproveTools: false, autoApproveToolScopes: [] } : {}),
      ...(s.currentSessionId !== id ? { preferSubagents: false } : {}),
      ...(s.currentSessionId !== id ? { webSearchEnabled: false, webSearchProvider: "duckduckgo" } : {}),
      ...(s.currentSessionId !== id ? { readOnlyAutoApproveForSession: false } : {}),
      ...(s.currentSessionId !== id ? { approvedLocalFileReadPaths: [] } : {}),
      ...(s.currentSessionId !== id ? { approvedShellPermissionRules: [] } : {}),
      ...(s.currentSessionId !== id
        ? {
            queuedUserMessage: null,
            activeGuidance: null,
            workspaceTurnQueue: null,
            workspaceInstructionLedger: [],
            transcriptPartial: false,
            transcriptLoadedTurns: 0,
            transcriptTotalTurns: 0,
          }
        : {}),
    }));
    scheduleWorkspaceClearSubmissionReplay(workspaceKey);
  },

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
    const sourceInitialState = get();
    const sourceWorkspace = sourceInitialState.currentWorkspace.trim();
    const sourceWorkspaceKey = resolveSessionWorkspaceKey(sourceWorkspace);
    const sourceSessionId = sourceInitialState.currentSessionId;
    const sourceSessionKey = resolveSessionRuntimeKey(sourceWorkspaceKey, sourceSessionId);
    const sourceSessionRecord = sourceSessionId == null
      ? null
      : (sourceInitialState.sessionsByWorkspace[sourceWorkspaceKey] || []).find(
          (session) => session.id === sourceSessionId,
        ) || null;
    const sourceRecordEpoch = String(sourceSessionRecord?.planLifecycleEpoch || "").trim();
    const sourceLifecycleEpoch = sourceInitialState.planLifecycle?.sessionKey === sourceSessionKey
      ? String(sourceInitialState.planLifecycle.sessionEpoch || "").trim()
      : "";
    const sourceSessionEpoch = sourceRecordEpoch || sourceLifecycleEpoch || (
      sourceSessionRecord
        ? createPlanLifecycleSessionEpoch(Number(sourceSessionRecord.id) || Date.now())
        : ""
    );
    const resetGeneration = planDiffRevertResetGeneration;
    planDiffRevertOperationCounter += 1;
    const operationId = `plan-diff-revert-${planDiffRevertOperationCounter}`;
    const language = sourceInitialState.config.language === "en" ? "en" : "zh";
    const copy = {
      noPath: language === "zh" ? "缺少文件路径，无法撤销。" : "Missing file path; cannot revert.",
      noExecuted: language === "zh" ? "没有已执行的修改可撤销。" : "No executed change is available to revert.",
      unsafeLegacy: language === "zh" ? "这条历史 Diff 不是完整文件快照，无法安全撤销。" : "This historical diff is not a full-file snapshot, so it cannot be safely reverted.",
      conflict: language === "zh" ? "文件内容已经变化，未覆盖后续改动。" : "The file has changed since this diff was recorded; later edits were not overwritten.",
      missingExisting: language === "zh" ? "原文件不存在，无法恢复旧内容。" : "The file no longer exists, so the old content cannot be restored.",
      rejected: language === "zh" ? "待审批修改已拒绝。" : "Pending change rejected.",
      restored: language === "zh" ? "已恢复到修改前内容。" : "Restored to the content before this change.",
      deleted: language === "zh" ? "已删除 AI 新建的文件。" : "Deleted the file created by the AI.",
      sourceOwnerUnavailable: language === "zh"
        ? "无法确认发起撤销的 Session 所有权，未执行文件修改。"
        : "The source Session owner could not be verified; no file mutation was performed.",
      settingsReset: (diskMayHaveChanged: boolean) => language === "zh"
        ? diskMayHaveChanged
          ? "设置重置已使本次撤销失效；文件操作可能已经完成，但旧 Session/Plan 状态不会重新注入。"
          : "设置重置已使本次撤销失效；未继续执行文件修改，也不会重新注入旧 Session/Plan 状态。"
        : diskMayHaveChanged
        ? "Settings reset invalidated this revert. The file operation may have completed, but the retired Session/Plan state was not republished."
        : "Settings reset invalidated this revert. No further file mutation was performed and the retired Session/Plan state was not republished.",
      sourceOwnerChanged: (diskMayHaveChanged: boolean) => language === "zh"
        ? diskMayHaveChanged
          ? "源 Session 已被删除或更换所有者；文件操作可能已经完成，但结果未发布到任何其他 Session。"
          : "源 Session 已被删除或更换所有者；未继续执行文件修改，也未污染当前 Session。"
        : diskMayHaveChanged
        ? "The source Session was removed or replaced. The file operation may have completed, but no state was published to another Session."
        : "The source Session was removed or replaced. No further file mutation was performed and the current Session was not changed.",
      invalidPlan: (reason: string) => language === "zh"
        ? `撤销后的 Plan 文件未通过质量校验，未写入：${reason}`
        : `The reverted Plan artifact failed validation and was not written: ${reason}`,
    };
    const results: DiffRevertResult[] = [];

    type SourceFenceDisposition = "current" | "settings_reset" | "source_owner_lost";
    type SourceRuntimeSnapshot = {
      disposition: SourceFenceDisposition;
      state: AppState | null;
      active: boolean;
      runtime: SessionRuntimeState | null;
    };
    type SourcePublication<T> = {
      disposition: "published" | Exclude<SourceFenceDisposition, "current">;
      value: T | null;
    };

    if (!sourceSessionKey || !sourceSessionRecord || !sourceSessionEpoch) {
      return groups.map((group) => ({
        path: String(group.path || "").trim(),
        taskIds: group.taskIds.filter((id) => Number.isFinite(id)),
        ok: false,
        message: copy.sourceOwnerUnavailable,
      }));
    }
    const exactSourceSessionKey = sourceSessionKey;

    // Some temporary Sessions predate the persisted epoch field, and an
    // ordinary Execute run need not bind the Plan lifecycle at all. Materialize
    // the Session-owned generation before the first await so every later CAS
    // can fence the exact container without rejecting non-Plan Diff cards.
    let sourceEpochMaterialized = false;
    set((latest) => {
      if (
        planDiffRevertResetGeneration !== resetGeneration ||
        !isSessionRuntimeActive(latest, exactSourceSessionKey)
      ) {
        return {};
      }
      const sessions = latest.sessionsByWorkspace[sourceWorkspaceKey] || [];
      const owner = sessions.find((session) => session.id === sourceSessionId);
      const currentEpoch = String(owner?.planLifecycleEpoch || "").trim();
      if (!owner || (currentEpoch && currentEpoch !== sourceSessionEpoch)) return {};
      sourceEpochMaterialized = true;
      if (currentEpoch === sourceSessionEpoch) return {};
      return {
        sessionsByWorkspace: {
          ...latest.sessionsByWorkspace,
          [sourceWorkspaceKey]: sessions.map((session) =>
            session.id === sourceSessionId
              ? { ...session, planLifecycleEpoch: sourceSessionEpoch }
              : session
          ),
        },
      };
    });
    if (!sourceEpochMaterialized) {
      return groups.map((group) => ({
        path: String(group.path || "").trim(),
        taskIds: group.taskIds.filter((id) => Number.isFinite(id)),
        ok: false,
        message: copy.sourceOwnerUnavailable,
      }));
    }

    const ownsExactSourceContainer = (candidate: AppState): boolean => {
      const owner = (candidate.sessionsByWorkspace[sourceWorkspaceKey] || []).find(
        (session) => session.id === sourceSessionId,
      );
      if (String(owner?.planLifecycleEpoch || "").trim() !== sourceSessionEpoch) return false;
      const lifecycle = candidate.planLifecycle;
      return lifecycle.sessionKey === UNBOUND_PLAN_SESSION_KEY
        ? lifecycle.sessionEpoch === UNBOUND_PLAN_SESSION_EPOCH
        : lifecycle.sessionKey === exactSourceSessionKey &&
          lifecycle.sessionEpoch === sourceSessionEpoch;
    };

    const readSourceRuntime = (): SourceRuntimeSnapshot => {
      if (planDiffRevertResetGeneration !== resetGeneration) {
        return {
          disposition: "settings_reset",
          state: null,
          active: false,
          runtime: null,
        };
      }
      const latest = get();
      const active = isSessionRuntimeActive(latest, exactSourceSessionKey);
      const runtime = active
        ? createSessionRuntimeFromState(latest)
        : latest.runtimeBySessionKey[exactSourceSessionKey] || null;
      if (!runtime) {
        return {
          disposition: "source_owner_lost",
          state: null,
          active,
          runtime: null,
        };
      }
      const scopedState = (active
        ? latest
        : {
            ...latest,
            ...runtime,
            currentWorkspace: sourceWorkspace,
            currentSessionId: sourceSessionId,
          }) as AppState;
      if (!ownsExactSourceContainer(scopedState)) {
        return {
          disposition: "source_owner_lost",
          state: null,
          active,
          runtime,
        };
      }
      return { disposition: "current", state: scopedState, active, runtime };
    };

    const publishSourceRuntime = <T>(
      build: (sourceState: AppState) => { patch: Partial<AppState>; value: T },
    ): SourcePublication<T> => {
      let publication: SourcePublication<T> = {
        disposition: "source_owner_lost",
        value: null,
      };
      set((latest) => {
        if (planDiffRevertResetGeneration !== resetGeneration) {
          publication = { disposition: "settings_reset", value: null };
          return {};
        }
        const active = isSessionRuntimeActive(latest, exactSourceSessionKey);
        const runtime = active
          ? createSessionRuntimeFromState(latest)
          : latest.runtimeBySessionKey[exactSourceSessionKey] || null;
        if (!runtime) {
          publication = { disposition: "source_owner_lost", value: null };
          return {};
        }
        const scopedState = (active
          ? latest
          : {
              ...latest,
              ...runtime,
              currentWorkspace: sourceWorkspace,
              currentSessionId: sourceSessionId,
            }) as AppState;
        if (!ownsExactSourceContainer(scopedState)) {
          publication = { disposition: "source_owner_lost", value: null };
          return {};
        }
        const built = build(scopedState);
        publication = { disposition: "published", value: built.value };
        if (active) return built.patch;
        const runtimePatch = pickSessionRuntimePatch(built.patch);
        return {
          runtimeBySessionKey: {
            ...latest.runtimeBySessionKey,
            [exactSourceSessionKey]: {
              ...runtime,
              ...runtimePatch,
            },
          },
        };
      });
      return publication;
    };

    const fenceFailureMessage = (
      disposition: SourceFenceDisposition,
      diskMayHaveChanged: boolean,
    ) => disposition === "settings_reset"
      ? copy.settingsReset(diskMayHaveChanged)
      : copy.sourceOwnerChanged(diskMayHaveChanged);
    const publishWorkspaceMutationVersion = () => {
      invalidateWorkspaceTreeCache();
      const latest = get();
      if (
        planDiffRevertResetGeneration === resetGeneration &&
        resolveSessionWorkspaceKey(latest.currentWorkspace) === sourceWorkspaceKey
      ) {
        latest.bumpWorkspaceContentVersion();
      }
    };

    for (const group of groups) {
      const path = String(group.path || "").trim();
      const taskIds = group.taskIds.filter((id) => Number.isFinite(id));
      if (!path) {
        results.push({ path, taskIds, ok: false, message: copy.noPath });
        continue;
      }

      const sourceSnapshot = readSourceRuntime();
      if (sourceSnapshot.disposition !== "current" || !sourceSnapshot.state) {
        results.push({
          path,
          taskIds,
          ok: false,
          message: fenceFailureMessage(sourceSnapshot.disposition, false),
        });
        continue;
      }
      const state = sourceSnapshot.state;
      const taskIdSet = new Set(taskIds);
      const relatedBlocks = state.taskFlow.filter(
        (block): block is Extract<TaskBlock, { type: "tool" }> =>
          block.type === "tool" && taskIdSet.has(block.id) && !!block.diff,
      );
      const pendingBlock = relatedBlocks.find((block) => block.toolStatus === "pending");
      if (pendingBlock) {
        const rejected = publishSourceRuntime((sourceState) => {
          const request = sourceState.activeActionRequest;
          const marker = sourceState.harnessRunMarker;
          const ownsExactPendingReview =
            request?.kind === "tool_permission" &&
            request.status === "pending" &&
            request.sessionKey === exactSourceSessionKey &&
            request.turnId === pendingBlock.turnId &&
            request.taskId === pendingBlock.id &&
            sourceState.pendingReviewTaskId === pendingBlock.id &&
            typeof sourceState.pendingReviewResolve === "function" &&
            marker?.sessionKey === exactSourceSessionKey &&
            (marker.status === "running" || marker.status === "paused") &&
            marker.turnId === request.turnId &&
            getHarnessActionRunId(marker) === request.runId &&
            (marker.activeParentRunId || null) === (request.parentRunId || null);
          const resolve = ownsExactPendingReview
            ? sourceState.pendingReviewResolve
            : null;
          return {
            patch: {
              taskFlow: sourceState.taskFlow.map((block) =>
                block.id === pendingBlock.id && block.type === "tool"
                  ? {
                      ...block,
                      status: "error",
                      toolStatus: "rejected",
                      message: "Changes rejected by user.",
                    }
                  : block
              ),
              showDiff: false,
              ...(resolve
                ? {
                    pendingReviewResolve: null,
                    pendingReviewTaskId: null,
                    activeActionRequest: null,
                    pendingToolCall: null,
                  }
                : {}),
            },
            value: resolve,
          };
        });
        if (rejected.disposition !== "published") {
          results.push({
            path,
            taskIds,
            ok: false,
            message: fenceFailureMessage(rejected.disposition, false),
          });
          continue;
        }
        if (rejected.value) {
          runAfterNextPaint(() => rejected.value?.({ action: "reject" }));
        }
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
        const publication = publishSourceRuntime((sourceState) => ({
          patch: {
            taskFlow: sourceState.taskFlow.map((block) =>
              block.type === "tool" && taskIdSet.has(block.id)
                ? { ...block, revertStatus: "failed" as const, revertMessage: message }
                : block
            ),
          },
          value: true,
        }));
        results.push({
          path,
          taskIds,
          ok: false,
          message: publication.disposition === "published"
            ? message
            : fenceFailureMessage(publication.disposition, false),
        });
        continue;
      }

      const existed = group.existed ?? executedBlocks[0]?.diff?.existed ?? true;
      const chatTempSessionKey = !sourceWorkspace
        ? resolveGlobalChatSessionKey(sourceSessionId)
        : null;
      const useChatTempStorage = !!chatTempSessionKey && !sourceWorkspace;

      const reverting = publishSourceRuntime((sourceState) => ({
        patch: {
          taskFlow: sourceState.taskFlow.map((block) =>
            block.type === "tool" && taskIdSet.has(block.id) && block.toolStatus === "executed"
              ? { ...block, revertStatus: "reverting" as const, revertMessage: "" }
              : block
          ),
        },
        value: true,
      }));
      if (reverting.disposition !== "published") {
        results.push({
          path,
          taskIds,
          ok: false,
          message: fenceFailureMessage(reverting.disposition, false),
        });
        continue;
      }

      let diskMutationStarted = false;
      try {
        const canonicalPlanPath = canonicalizePlanArtifactPath(path);
        const planArtifactKind = detectPlanArtifactKind(canonicalPlanPath);
        const sanitizedOldText = sanitizePlanArtifactContent(group.oldText);
        if (
          existed &&
          planArtifactKind &&
          planArtifactKind !== "summary" &&
          sanitizedOldText.trim().length > 0
        ) {
          const validation = validatePlanArtifactContent(sanitizedOldText, planArtifactKind);
          if (!validation.ok) {
            throw new Error(copy.invalidPlan(validation.reason || "invalid_plan_artifact"));
          }
        }

        let currentContent = "";
        let missingCurrentFile = false;
        try {
          currentContent = useChatTempStorage
            ? await readChatTempFile(chatTempSessionKey!, path)
            : await readFile(path, sourceWorkspace || undefined);
        } catch {
          missingCurrentFile = true;
        }

        const afterReadFence = readSourceRuntime();
        if (afterReadFence.disposition !== "current") {
          results.push({
            path,
            taskIds,
            ok: false,
            message: fenceFailureMessage(afterReadFence.disposition, false),
          });
          continue;
        }

        if (missingCurrentFile) {
          if (existed) throw new Error(copy.missingExisting);
        } else if (currentContent !== group.newText) {
          throw new Error(copy.conflict);
        }

        diskMutationStarted = true;
        if (!existed) {
          if (useChatTempStorage) {
            await deleteChatTempPath(chatTempSessionKey!, path);
          } else {
            await deleteWorkspacePath(path, sourceWorkspace || undefined);
          }
        } else if (useChatTempStorage) {
          await writeChatTempFile(chatTempSessionKey!, path, group.oldText);
        } else {
          await writeFile(path, group.oldText, sourceWorkspace || undefined);
        }

        const message = existed ? copy.restored : copy.deleted;
        const publication = publishSourceRuntime((sourceState) => {
          const planTransition = buildPlanArtifactRevertTransition(
            sourceState,
            path,
            group.oldText,
            existed,
          );
          return {
            patch: {
              taskFlow: sourceState.taskFlow.map((block) =>
                block.type === "tool" && taskIdSet.has(block.id) && block.toolStatus === "executed"
                  ? { ...block, revertStatus: "reverted" as const, revertMessage: message }
                  : block
              ),
              ...planTransition.patch,
            },
            value: planTransition,
          };
        });
        if (publication.disposition !== "published") {
          publishWorkspaceMutationVersion();
          results.push({
            path,
            taskIds,
            ok: false,
            message: fenceFailureMessage(publication.disposition, true),
          });
          continue;
        }
        const planTransition = publication.value;
        const sideEffectFence = readSourceRuntime();
        if (sideEffectFence.disposition !== "current") {
          publishWorkspaceMutationVersion();
          results.push({
            path,
            taskIds,
            ok: false,
            message: fenceFailureMessage(sideEffectFence.disposition, true),
          });
          continue;
        }
        const pendingPermissionInvalidation = planTransition?.pendingPermissionInvalidation;
        if (pendingPermissionInvalidation) {
          let settled = false;
          try {
            settled = settlePendingPlanToolPermissionInvalidation(pendingPermissionInvalidation);
          } catch (settlementError) {
            logStoreEvent("plan_tool_permission_revert_settlement_failed", {
              requestId: pendingPermissionInvalidation.requestId,
              taskId: pendingPermissionInvalidation.taskId,
              error: settlementError instanceof Error
                ? settlementError.message
                : String(settlementError),
            });
          }
          logStoreEvent("plan_tool_permission_invalidated_by_diff_revert", {
            requestId: pendingPermissionInvalidation.requestId,
            taskId: pendingPermissionInvalidation.taskId,
            sessionKey: exactSourceSessionKey,
            operationId,
            settled,
          });
        } else if (planTransition?.revokedExecutionAbort) {
          try {
            planTransition.revokedExecutionAbort();
            logStoreEvent("plan_execution_aborted_by_diff_revert", {
              path: canonicalPlanPath,
              sessionKey: exactSourceSessionKey,
              operationId,
            });
          } catch (abortError) {
            // The filesystem mutation and source-Session CAS are already
            // committed. An observer/controller throwing during revocation
            // must not rewrite that successful result as a failed revert.
            logStoreEvent("plan_execution_diff_revert_abort_failed", {
              path: canonicalPlanPath,
              sessionKey: exactSourceSessionKey,
              operationId,
              error: abortError instanceof Error
                ? abortError.message
                : String(abortError),
            });
          }
        }
        if (planTransition?.approvalInvalidated) {
          logStoreEvent("plan_authority_invalidated_by_diff_revert", {
            path: canonicalPlanPath,
            sessionKey: exactSourceSessionKey,
            operationId,
          });
        }
        publishWorkspaceMutationVersion();
        results.push({ path, taskIds, ok: true, message });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        const publication = publishSourceRuntime((sourceState) => ({
          patch: {
            taskFlow: sourceState.taskFlow.map((block) =>
              block.type === "tool" && taskIdSet.has(block.id) && block.toolStatus === "executed"
                ? { ...block, revertStatus: "failed" as const, revertMessage: errorMessage }
                : block
            ),
          },
          value: true,
        }));
        if (diskMutationStarted) publishWorkspaceMutationVersion();
        results.push({
          path,
          taskIds,
          ok: false,
          message: publication.disposition === "published"
            ? errorMessage
            : fenceFailureMessage(publication.disposition, diskMutationStarted),
        });
      }
    }

    return results;
  },

  // ── Data Management ──────────────────────────────────────────────────

  clearChatHistory: () => {
    const current = get();
    const workspaceKey = resolveSessionWorkspaceKey(current.currentWorkspace);
    const existingTransaction = workspaceClearTransactions.get(workspaceKey);
    if (existingTransaction) return existingTransaction;
    let resolveTransaction!: () => void;
    let rejectTransaction!: (error: unknown) => void;
    const transaction = new Promise<void>((resolve, reject) => {
      resolveTransaction = resolve;
      rejectTransaction = reject;
    });
    workspaceClearTransactions.set(workspaceKey, transaction);
    void (async () => {
    const workspaceClearBarrierToken = beginWorkspaceClearSubmissionBarrier(workspaceKey);
    workspaceClearSubmissionReplayReadySessionKeys.delete(workspaceKey);
    let workspaceClearBarrierOutcome: "cleared" | "preserved" = "preserved";
    let workspaceClearReplayPublicationReady = false;
    let workspaceClearBarrierSettled = false;
    try {
    const activeSessionKey = resolveSessionRuntimeKey(workspaceKey, current.currentSessionId);
    const activeRuntime = activeSessionKey ? createSessionRuntimeFromState(current) : null;
    const ownedRuntimesForRecovery = new Map<string, SessionRuntimeState>();
    const runtimeSessionPrefix = `${workspaceKey}:`;
    Object.entries(current.runtimeBySessionKey).forEach(([sessionKey, runtime]) => {
      if (sessionKey.startsWith(runtimeSessionPrefix)) {
        ownedRuntimesForRecovery.set(sessionKey, runtime);
      }
    });
    if (activeSessionKey && activeRuntime) {
      ownedRuntimesForRecovery.set(activeSessionKey, activeRuntime);
    }
    const sessionIds = new Set<string>(
      (current.sessionsByWorkspace[workspaceKey] || []).map((session) => String(session.id)),
    );
    if (current.currentSessionId != null) sessionIds.add(String(current.currentSessionId));
    Object.keys(current.runtimeBySessionKey).forEach((sessionKey) => {
      if (sessionKey.startsWith(runtimeSessionPrefix)) {
        const sessionId = sessionKey.slice(runtimeSessionPrefix.length);
        if (sessionId) sessionIds.add(sessionId);
      }
    });

    const revocations = revokeWorkspaceSessionRuntimesBeforeClear({
      workspaceKey,
      activeSessionKey,
      activeRuntime,
      runtimeBySessionKey: current.runtimeBySessionKey,
      closeHarness: (marker) => !!closeHarnessRunMarkerForSessionDeletion({
        runId: marker.runId,
        sessionKey: marker.sessionKey,
        turnId: marker.turnId!,
        instanceId: marker.instanceId,
        startedAt: marker.startedAt,
      }),
      onError: (sessionKey, phase, error) => {
        logStoreEvent("workspace_history_runtime_revocation_failed", {
          workspaceKey,
          sessionKey,
          phase,
          error: error instanceof Error ? error.message : String(error),
        });
      },
    });
    revocations.forEach((revocation) => {
      logStoreEvent("workspace_history_runtime_revoked", {
        workspaceKey,
        ...revocation,
      });
    });

    const pendingSummary = current.config.language === "en"
      ? "History clearing was requested. The previous runtime was revoked before storage mutation."
      : "已请求清空历史；旧运行已在存储变更前撤销。";
    set((state) => {
      const runtimeBySessionKey = { ...state.runtimeBySessionKey };
      Object.keys(runtimeBySessionKey).forEach((sessionKey) => {
        if (sessionKey.startsWith(runtimeSessionPrefix)) delete runtimeBySessionKey[sessionKey];
      });
      const ownsVisibleSession = resolveSessionRuntimeKey(
        resolveSessionWorkspaceKey(state.currentWorkspace),
        state.currentSessionId,
      ) === activeSessionKey;
      if (!ownsVisibleSession) return { runtimeBySessionKey };
      return {
        ...buildHistoryClearRevokedRuntime(
          createSessionRuntimeFromState(state),
          pendingSummary,
        ),
        currentSessionId: null,
        activeSessionByWorkspace: {
          ...state.activeSessionByWorkspace,
          [workspaceKey]: null,
        },
        runtimeBySessionKey,
      };
    });
    logStoreEvent("workspace_history_runtime_generation_revoked", {
      workspaceKey,
      activeSessionKey,
      runtimeOwnerCount: ownedRuntimesForRecovery.size,
    });

    try {
      await clearProjectSessions(workspaceKey, Array.from(sessionIds));
    } catch (error) {
      if (invalidatedWorkspaceClearTransactions.has(transaction)) {
        logStoreEvent("workspace_history_clear_recovery_skipped_invalidated", {
          workspaceKey,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
      const failureSummary = current.config.language === "en"
        ? "History clearing could not be persisted. The Session was preserved, and its revoked turn was canceled and closed. Send a new instruction to continue."
        : "历史清理未能持久化。Session 已保留，已撤销的回合已取消并收口；可发送新指令继续。";
      const terminalizedAt = Date.now();
      const recoveryState = get();
      const recoverySessions = recoveryState.sessionsByWorkspace[workspaceKey] || [];
      const terminalRuntimes = new Map<string, SessionRuntimeState>();
      const terminalSessionRecords = new Map<string, Session>();
      let memoryFallbackCount = 0;

      ownedRuntimesForRecovery.forEach((runtime, sessionKey) => {
        const terminalRuntime = createSessionRuntimeFromState(
          buildHistoryClearFailedTerminalRuntime({
            runtime: createSessionRuntimeFromState(runtime),
            sessionKey,
            message: failureSummary,
            nextTaskId: get()._nextTaskId,
            now: terminalizedAt,
          }),
        );
        terminalRuntimes.set(sessionKey, terminalRuntime);
        const ownerSessionId = sessionKey.startsWith(runtimeSessionPrefix)
          ? sessionKey.slice(runtimeSessionPrefix.length)
          : "";
        const ownerSession = recoverySessions.find(
          (session) => String(session.id) === ownerSessionId,
        );
        if (!ownerSession) {
          memoryFallbackCount += 1;
          logStoreEvent("workspace_history_terminal_snapshot_memory_fallback", {
            workspaceKey,
            sessionKey,
            sessionId: ownerSessionId || null,
            reason: "session_record_missing",
          });
          return;
        }
        const updatedAt = new Date(terminalizedAt).toISOString();
        terminalSessionRecords.set(sessionKey, {
          ...ownerSession,
          messages: sanitizeTaskBlocksForPersist(terminalRuntime.taskFlow || []),
          runtimeSnapshot: buildSessionRuntimeSnapshotFromStoreState({
            ...recoveryState,
            ...terminalRuntime,
            currentWorkspace: workspaceKey,
            currentSessionId: ownerSession.id,
          }),
          updatedAt,
          updatedAtMs: terminalizedAt,
        });
      });

      // Keep the Session invisible until every affected owner has had a chance
      // to durably record its terminal Turn projection. A failed owner save is
      // an explicit memory fallback, never a reason to republish an open Turn.
      for (const [sessionKey, terminalSession] of terminalSessionRecords) {
        if (invalidatedWorkspaceClearTransactions.has(transaction)) break;
        try {
          const saved = await saveProjectSession(workspaceKey, terminalSession);
          if (saved && typeof saved === "object") {
            terminalSessionRecords.set(sessionKey, {
              ...terminalSession,
              ...(saved as Partial<Session>),
              id: terminalSession.id,
              messages: terminalSession.messages,
              runtimeSnapshot: terminalSession.runtimeSnapshot,
            });
          }
          logStoreEvent("workspace_history_terminal_snapshot_persisted", {
            workspaceKey,
            sessionKey,
            sessionId: terminalSession.id,
          });
        } catch (saveError) {
          memoryFallbackCount += 1;
          logStoreEvent("workspace_history_terminal_snapshot_memory_fallback", {
            workspaceKey,
            sessionKey,
            sessionId: terminalSession.id,
            reason: "session_save_failed",
            error: saveError instanceof Error ? saveError.message : String(saveError),
          });
        }
      }

      if (invalidatedWorkspaceClearTransactions.has(transaction)) {
        logStoreEvent("workspace_history_clear_recovery_skipped_invalidated", {
          workspaceKey,
          phase: "after_terminal_persistence",
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }

      set((state) => {
        const workspaceSessions = state.sessionsByWorkspace[workspaceKey] || [];
        const survivingSessionIds = new Set(workspaceSessions.map((session) => String(session.id)));
        const runtimeBySessionKey = { ...state.runtimeBySessionKey };
        terminalRuntimes.forEach((runtime, sessionKey) => {
          const ownerSessionId = sessionKey.startsWith(runtimeSessionPrefix)
            ? sessionKey.slice(runtimeSessionPrefix.length)
            : "";
          if (!survivingSessionIds.has(ownerSessionId)) return;
          runtimeBySessionKey[sessionKey] = createSessionRuntimeFromState(runtime);
        });
        const sessionsByWorkspace = {
          ...state.sessionsByWorkspace,
          [workspaceKey]: workspaceSessions.map((session) => {
            const sessionKey = `${workspaceKey}:${session.id}`;
            const terminalSession = terminalSessionRecords.get(sessionKey);
            return terminalSession
              ? { ...session, ...terminalSession, id: session.id, active: session.active }
              : session;
          }),
        };
        const visibleRuntime = activeSessionKey && survivingSessionIds.has(String(current.currentSessionId))
          ? terminalRuntimes.get(activeSessionKey) || null
          : null;
        const shouldPublishVisibleRuntime = !!visibleRuntime &&
          resolveSessionWorkspaceKey(state.currentWorkspace) === workspaceKey &&
          state.currentSessionId == null;
        return shouldPublishVisibleRuntime
          ? { ...visibleRuntime, sessionsByWorkspace, runtimeBySessionKey }
          : { sessionsByWorkspace, runtimeBySessionKey };
      });
      if (activeSessionKey && current.currentSessionId != null) {
        set((state) => {
          const sessionStillExists = (state.sessionsByWorkspace[workspaceKey] || []).some(
            (session) => String(session.id) === String(current.currentSessionId),
          );
          if (!sessionStillExists) return {};
          const shouldRestoreVisibleSession =
            resolveSessionWorkspaceKey(state.currentWorkspace) === workspaceKey &&
            state.currentSessionId == null;
          const shouldRestoreWorkspacePointer = state.activeSessionByWorkspace[workspaceKey] == null;
          if (!shouldRestoreVisibleSession && !shouldRestoreWorkspacePointer) return {};
          return {
            ...(shouldRestoreVisibleSession ? { currentSessionId: current.currentSessionId } : {}),
            ...(shouldRestoreWorkspacePointer
              ? {
                  activeSessionByWorkspace: {
                    ...state.activeSessionByWorkspace,
                    [workspaceKey]: current.currentSessionId,
                  },
                }
              : {}),
          };
        });
      }
      workspaceClearReplayPublicationReady = true;
      logStoreEvent("workspace_history_clear_failed", {
        workspaceKey,
        ownerCount: sessionIds.size,
        terminalOwnerCount: terminalRuntimes.size,
        memoryFallbackCount,
        recovery: "session_preserved_turns_canceled",
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
    if (invalidatedWorkspaceClearTransactions.has(transaction)) {
      logStoreEvent("workspace_history_clear_publication_skipped_invalidated", {
        workspaceKey,
        outcome: "cleared",
      });
      return;
    }
    // Durable deletion is the monotonic capability boundary. Even if a later
    // local publication hook throws, no replay may reuse the deleted Session.
    workspaceClearBarrierOutcome = "cleared";

    set((s) => {
      const sessionsByWorkspace = { ...s.sessionsByWorkspace };
      const activeSessionByWorkspace = { ...s.activeSessionByWorkspace };
      const runtimeBySessionKey = { ...s.runtimeBySessionKey };
      delete sessionsByWorkspace[workspaceKey];
      delete activeSessionByWorkspace[workspaceKey];
      Object.keys(runtimeBySessionKey).forEach((key) => {
        if (key.startsWith(runtimeSessionPrefix)) delete runtimeBySessionKey[key];
      });
      const workspaceStillVisible = resolveSessionWorkspaceKey(s.currentWorkspace) === workspaceKey;
      if (!workspaceStillVisible) {
        return { sessionsByWorkspace, activeSessionByWorkspace, runtimeBySessionKey };
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
        currentTurnState: createDefaultCurrentTurnState(),
        pendingRunDecision: null,
        pendingRunDecisionResolver: null,
        isGenerating: false,
        agentStatus: "idle",
        abortController: null,
        elapsedTime: 0,
        pendingReviewResolve: null,
        pendingReviewTaskId: null,
        activeActionRequest: null,
        pendingToolCall: null,
        executionConsentPolicy: "ask_per_turn",
        currentTurnExecutionConsent: { turnId: null, granted: false },
        autoApproveTools: false,
        autoApproveToolScopes: [],
        preferSubagents: false,
        webSearchEnabled: false,
        webSearchProvider: "duckduckgo",
        approvedLocalFileReadPaths: [],
        approvedShellPermissionRules: [],
        readOnlyAutoApproveForSession: false,
        queuedUserMessage: null,
        activeGuidance: null,
        workspaceTurnQueue: null,
        workspaceInstructionLedger: [],
        transcriptPartial: false,
        transcriptLoadedTurns: 0,
        transcriptTotalTurns: 0,
        planArtifacts: [],
        planTasks: [],
        planExecutionEvidenceLedger: [],
        planExecutionEvidenceCount: 0,
        planAutoResumeCount: 0,
        planExecutionProgressSnapshot: null,
        planLifecycle: createEmptyPlanLifecycleForSession(null),
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
        activeGoal: null,
        goalProgress: null,
        goalStatus: "paused",
        goalIterationBudget: DEFAULT_GOAL_EMERGENCY_CONTINUATION_LIMIT,
        goalRuntime: null,
        currentSessionId: null,
        sessionsByWorkspace,
        activeSessionByWorkspace,
        runtimeBySessionKey,
      };
    });
    workspaceClearReplayPublicationReady = true;
    logStoreEvent("workspace_history_cleared", {
      workspaceKey,
      ownerCount: sessionIds.size,
      runtimeOwnerCount: revocations.length,
    });
    } finally {
      if (!workspaceClearBarrierSettled) {
        workspaceClearBarrierSettled = true;
        const barrierSettlement = settleWorkspaceClearSubmissionBarrier({
          token: workspaceClearBarrierToken,
          outcome: workspaceClearBarrierOutcome,
        });
        if (barrierSettlement.settled) {
          const latest = get();
          if (
            workspaceClearReplayPublicationReady &&
            resolveSessionWorkspaceKey(latest.currentWorkspace) === workspaceKey
          ) {
            get().markWorkspaceClearSubmissionReplayReady(
              workspaceKey,
              latest.currentSessionId,
            );
          }
          scheduleWorkspaceClearSubmissionReplay(workspaceKey);
        }
      }
    }
    })().then(
      () => {
        if (workspaceClearTransactions.get(workspaceKey) === transaction) {
          workspaceClearTransactions.delete(workspaceKey);
        }
        resolveTransaction();
      },
      (error) => {
        if (workspaceClearTransactions.get(workspaceKey) === transaction) {
          workspaceClearTransactions.delete(workspaceKey);
        }
        rejectTransaction(error);
      },
    );
    return transaction;
  },

  resetAllSettings: () => {
    // Invalidate every async Diff revert before revocation or state clearing.
    // A late filesystem promise may settle, but it can no longer republish a
    // retired Plan or transient capability into the reset Store.
    planDiffRevertResetGeneration += 1;
    const current = get();
    const activeSessionKey = resolveSessionRuntimeKey(
      resolveSessionWorkspaceKey(current.currentWorkspace),
      current.currentSessionId,
    );
    const hasActiveRuntimeCapability = current.currentSessionId != null ||
      !!current.abortController ||
      !!current.pendingRunDecisionResolver ||
      !!current.pendingReviewResolve ||
      !!current.harnessRunMarker;
    const revocations = revokeAllSessionRuntimesBeforeSettingsReset({
      activeSessionKey,
      activeRuntime: hasActiveRuntimeCapability
        ? createSessionRuntimeFromState(current)
        : null,
      runtimeBySessionKey: current.runtimeBySessionKey,
      closeHarness: (marker) => !!closeHarnessRunMarkerForSessionDeletion({
        runId: marker.runId,
        sessionKey: marker.sessionKey,
        turnId: marker.turnId!,
        instanceId: marker.instanceId,
        startedAt: marker.startedAt,
      }),
      onError: (identity, phase, error) => {
        logStoreEvent("settings_reset_runtime_revocation_failed", {
          ...identity,
          phase,
          error: error instanceof Error ? error.message : String(error),
        });
      },
    });
    revocations.forEach(({ identity, ...result }) => {
      logStoreEvent("settings_reset_runtime_revoked", {
        ...identity,
        ...result,
      });
    });
    for (const transaction of workspaceClearTransactions.values()) {
      invalidatedWorkspaceClearTransactions.add(transaction);
    }
    workspaceClearTransactions.clear();
    discardAllWorkspaceClearSubmissionStateForSettingsReset();
    scheduledWorkspaceClearSubmissionReplays.clear();
    workspaceClearSubmissionReplayAttempts.clear();
    workspaceClearSubmissionReplayNotReady.clear();
    workspaceClearSubmissionReplayReadySessionKeys.clear();
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
      input: "",
      contextMentions: [],
      attachedFiles: [],
      lockedComposerIntent: null,
      conversationTurns: [],
      currentTurnId: null,
      currentTurnState: createDefaultCurrentTurnState(),
      pendingRunDecision: null,
      pendingRunDecisionResolver: null,
      pendingReviewResolve: null,
      pendingReviewTaskId: null,
      activeActionRequest: null,
      pendingToolCall: null,
      pendingSlashCommand: null,
      abortController: null,
      agentStatus: "idle",
      isGenerating: false,
      elapsedTime: 0,
      executionConsentPolicy: "ask_per_turn",
      currentTurnExecutionConsent: { turnId: null, granted: false },
      autoApproveTools: false,
      autoApproveToolScopes: [],
      preferSubagents: false,
      webSearchEnabled: false,
      webSearchProvider: "duckduckgo",
      approvedLocalFileReadPaths: [],
      approvedShellPermissionRules: [],
      readOnlyAutoApproveForSession: false,
      queuedUserMessage: null,
      activeGuidance: null,
      workspaceTurnQueue: null,
      workspaceInstructionLedger: [],
      transcriptPartial: false,
      transcriptLoadedTurns: 0,
      transcriptTotalTurns: 0,
      resolvedInstructionSet: null,
      instructionSources: [],
      loadedHookDefinitions: defaultHookDefinitions,
      hookExecutionRecords: [],
      instructionLastLoadedAt: null,
      hookLastLoadedAt: null,
      sessionHookCache: [],
      activeGoal: null,
      goalProgress: null,
      goalStatus: "paused",
      goalIterationBudget: DEFAULT_GOAL_EMERGENCY_CONTINUATION_LIMIT,
      goalRuntime: null,
      planArtifacts: [],
      planTasks: [],
      planExecutionEvidenceLedger: [],
      planExecutionEvidenceCount: 0,
      planAutoResumeCount: 0,
      planExecutionProgressSnapshot: null,
      planLifecycle: createEmptyPlanLifecycleForSession(null),
      planStage: "idle",
      isPlanApproved: false,
      planApprovalChoice: null,
      pendingPlanApprovalHandoff: null,
      planApprovalExecutionStartedForTurnId: null,
      clearedPlanTurnId: null,
      showPlanPanel: false,
      normalizedStreamState: defaultNormalizedStreamState,
      harnessRunMarker: null,
      ...getClosedSessionPanelPatch(),
    });
  },

  // ── Workflow Mode ──────────────────────────────────────────────────

  planLifecycle: createEmptyPlanLifecycleForSession(null, { now: 0 }),
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
  setPlanStage: (stage) => set({ planStage: stage }),
  upsertPlanArtifact: (artifact) => {
    const invalidatedPlanToolReviewRef: {
      current: PendingPlanToolPermissionInvalidation | null;
    } = { current: null };
    const revokedPlanExecutionAbortRef: { current: (() => void) | null } = { current: null };
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
      const nextApprovalIdentity = buildPlanApprovalIdentity(nextArtifacts);
      const lifecycleSessionKey = resolveSessionRuntimeKey(
        resolveSessionWorkspaceKey(s.currentWorkspace),
        s.currentSessionId,
      ) || UNBOUND_PLAN_SESSION_KEY;
      const lifecycleNow = Date.now();
      let nextPlanLifecycle = transitionPlanLifecycleArtifactIdentity({
        lifecycle: s.planLifecycle,
        sessionKey: lifecycleSessionKey,
        artifactIdentity: toPlanLifecycleArtifactIdentity(nextApprovalIdentity),
        now: lifecycleNow,
      });
      const approvalInvalidated = Boolean(
        (s.isPlanApproved || s.planLifecycle.approvalLease) &&
        !nextPlanLifecycle.approvalLease,
      );
      const planToolInvalidation = buildPendingPlanToolPermissionInvalidation(
        s,
        approvalInvalidated,
      );
      invalidatedPlanToolReviewRef.current = planToolInvalidation;
      if (
        approvalInvalidated &&
        !planToolInvalidation &&
        isHarnessMarkerOwnedByPlanExecution({
          lifecycle: s.planLifecycle,
          marker: s.harnessRunMarker,
        }) &&
        s.abortController &&
        !s.abortController.signal.aborted
      ) {
        revokedPlanExecutionAbortRef.current = () => s.abortController?.abort();
      }
      const effectivePlanApproved = s.isPlanApproved &&
        isPlanApprovalLeaseBoundToState(nextPlanLifecycle);
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
      if (
        shouldRefreshPlanReviewRequest &&
        nextPlanReviewRequest?.kind === "plan_review" &&
        nextApprovalIdentity
      ) {
        const alignedLifecycle = alignPlanLifecycleWithReview({
          lifecycle: nextPlanLifecycle,
          sessionKey: lifecycleSessionKey,
          request: nextPlanReviewRequest,
          artifactIdentity: nextApprovalIdentity,
          now: lifecycleNow,
        });
        if (alignedLifecycle) nextPlanLifecycle = alignedLifecycle;
      }
      const nextStage = derivePlanStageFromArtifacts(
        nextArtifacts,
        approvalInvalidated ? [] : normalizedTasks,
        effectivePlanApproved,
        s.planStage,
      );
      logStoreEvent("plan_artifact_stage_transition", {
        path: canonicalPath,
        kind: artifact.kind,
        previousStage: s.planStage,
        nextStage,
        artifacts: nextArtifacts.length,
        tasks: normalizedTasks.length,
        approved: effectivePlanApproved,
        approvalInvalidated,
        lifecycleStatus: nextPlanLifecycle.status,
        lifecycleVersion: nextPlanLifecycle.version,
      });

      const shouldAutoOpenPlanPanel = !effectivePlanApproved && s.planStage !== "executing";

      return {
        planArtifacts: nextArtifacts.sort((a, b) => a.updatedAt - b.updatedAt),
        planStage: nextStage,
        planTasks: approvalInvalidated ? [] : normalizedTasks,
        planLifecycle: nextPlanLifecycle,
        ...(shouldRefreshPlanReviewRequest ? { activeActionRequest: nextPlanReviewRequest } : {}),
        ...(planToolInvalidation?.patch || {}),
        clearedPlanTurnId: null,
        ...(approvalInvalidated
          ? {
              isPlanApproved: false,
              planApprovalChoice: null,
              pendingPlanApprovalHandoff: null,
              planApprovalExecutionStartedForTurnId: null,
              currentTurnExecutionConsent: { turnId: null, granted: false },
              planExecutionEvidenceLedger: [],
              planExecutionEvidenceCount: 0,
              planAutoResumeCount: 0,
              planExecutionProgressSnapshot: null,
            }
          : {}),
        ...(shouldAutoOpenPlanPanel
          ? {
              showPlanPanel: true,
              rightPanelTab: s.showDiff && s.rightPanelTab === "diff" ? "diff" as const : "plan" as const,
            }
          : {}),
      };
    });
    const invalidatedPlanToolReview = invalidatedPlanToolReviewRef.current;
    if (invalidatedPlanToolReview) {
      const settled = settlePendingPlanToolPermissionInvalidation(invalidatedPlanToolReview);
      logStoreEvent("plan_tool_permission_invalidated_by_artifact_change", {
        requestId: invalidatedPlanToolReview.requestId,
        taskId: invalidatedPlanToolReview.taskId,
        sessionKey: get().getCurrentSessionKey(),
        settled,
        source: "global_upsert",
      });
    }
    if (revokedPlanExecutionAbortRef.current) {
      try {
        revokedPlanExecutionAbortRef.current();
        logStoreEvent("plan_execution_aborted_by_artifact_change", {
          sessionKey: get().getCurrentSessionKey(),
          source: "global_upsert",
        });
      } catch (error) {
        logStoreEvent("plan_execution_abort_failed_after_artifact_change", {
          sessionKey: get().getCurrentSessionKey(),
          source: "global_upsert",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  },
  clearPlanArtifacts: () => {
    const invalidatedPlanToolReviewRef: {
      current: PendingPlanToolPermissionInvalidation | null;
    } = { current: null };
    const revokedPlanExecutionAbortRef: { current: (() => void) | null } = { current: null };
    set((s) => {
      const before = summarizePlanWorkspaceStateForLog(s);
      const nextRightPanelTab = s.rightPanelTab === "plan" ? "terminal" as const : s.rightPanelTab;
      const sessionKey = resolveSessionRuntimeKey(resolveSessionWorkspaceKey(s.currentWorkspace), s.currentSessionId);
      const lifecycleOwner = ensurePlanLifecycleSessionOwner(
        s.planLifecycle,
        sessionKey || UNBOUND_PLAN_SESSION_KEY,
      );
      const lifecycleReset = reducePlanLifecycle(lifecycleOwner, {
        type: "reset",
        expectedVersion: lifecycleOwner.version,
        at: Date.now(),
      });
      const planToolInvalidation = buildPendingPlanToolPermissionInvalidation(s, true);
      invalidatedPlanToolReviewRef.current = planToolInvalidation;
      if (
        !planToolInvalidation &&
        (s.planLifecycle.approvalLease || s.planLifecycle.executionLease) &&
        isHarnessMarkerOwnedByPlanExecution({
          lifecycle: s.planLifecycle,
          marker: s.harnessRunMarker,
        }) &&
        s.abortController &&
        !s.abortController.signal.aborted
      ) {
        revokedPlanExecutionAbortRef.current = () => s.abortController?.abort();
      }
      const clearsPlanReviewRequest = s.activeActionRequest?.kind === "plan_review";
      const patch = {
        planLifecycle: lifecycleReset.disposition === "rejected"
          ? lifecycleOwner
          : lifecycleReset.state,
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
        ...(clearsPlanReviewRequest ? { activeActionRequest: null } : {}),
        ...(planToolInvalidation?.patch || {}),
        clearedPlanTurnId: s.currentTurnId || s.conversationTurns.find((turn) => isPlanConversationTurn(turn) && turn.status !== "done" && turn.status !== "completed_with_changes")?.id || null,
        isPlanApproved: false,
        showPlanPanel: false,
        rightPanelTab: nextRightPanelTab,
      };
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
    });
    const invalidatedPlanToolReview = invalidatedPlanToolReviewRef.current;
    if (invalidatedPlanToolReview) {
      const settled = settlePendingPlanToolPermissionInvalidation(invalidatedPlanToolReview);
      logStoreEvent("plan_tool_permission_invalidated_by_artifact_change", {
        requestId: invalidatedPlanToolReview.requestId,
        taskId: invalidatedPlanToolReview.taskId,
        sessionKey: get().getCurrentSessionKey(),
        settled,
        source: "global_clear",
      });
    }
    if (revokedPlanExecutionAbortRef.current) {
      try {
        revokedPlanExecutionAbortRef.current();
        logStoreEvent("plan_execution_aborted_by_artifact_change", {
          sessionKey: get().getCurrentSessionKey(),
          source: "global_clear",
        });
      } catch (error) {
        logStoreEvent("plan_execution_abort_failed_after_artifact_change", {
          sessionKey: get().getCurrentSessionKey(),
          source: "global_clear",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  },
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
      if (state.isPlanApproved && isPlanApprovalLeaseBoundToState(state.planLifecycle)) {
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
        const approvalSessionKey = resolveSessionRuntimeKey(
          resolveSessionWorkspaceKey(state.currentWorkspace),
          state.currentSessionId,
        ) || UNBOUND_PLAN_SESSION_KEY;
        state.abortController?.abort();
        set((s) => ({
          planLifecycle: revokePlanLifecycleToDiscovery({
            lifecycle: s.planLifecycle,
            sessionKey: approvalSessionKey,
            artifacts: s.planArtifacts,
            planTurnId: approvedTurnId,
          }),
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
        const refreshedLifecycle = alignPlanLifecycleWithReview({
          lifecycle: state.planLifecycle,
          sessionKey: reviewSessionKey || UNBOUND_PLAN_SESSION_KEY,
          request: refreshedRequest,
          artifactIdentity: approvalIdentity,
        });
        set({
          activeActionRequest: refreshedRequest,
          ...(refreshedLifecycle ? { planLifecycle: refreshedLifecycle } : {}),
          isPlanApproved: false,
        });
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
          planLifecycle: pausePlanLifecycle({
            lifecycle: ensurePlanLifecycleSessionOwner(
              s.planLifecycle,
              reviewSessionKey || UNBOUND_PLAN_SESSION_KEY,
            ),
            reason: "plan_execution_materialization_failed",
            resultKind: "blocked",
            resumeCondition: "revise_and_review_plan",
          }),
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
      const isAlreadyExecutingCurrentAttempt =
        !!approvedTurnId &&
        state.planLifecycle.status === "executing" &&
        state.planLifecycle.execution?.turnId === approvedTurnId;
      if (hasPendingHandoffForTurn || isAlreadyExecutingCurrentAttempt) {
        logStoreEvent("plan_approval_handoff_deduped", {
          reason: hasPendingHandoffForTurn
            ? "pending_same_turn_execution_exists"
            : "execution_attempt_already_started",
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
      const approvalTimestamp = Date.now();
      const executionRunId = createSubmitHarnessRunId(approvalTimestamp);
      const executionParentRunId = reviewRequest.runId;
      const executionInstructionHash = buildPlanExecutionInstructionHash(executionPrompt);
      const reviewLifecycle = alignPlanLifecycleWithReview({
        lifecycle: state.planLifecycle,
        sessionKey: reviewSessionKey || UNBOUND_PLAN_SESSION_KEY,
        request: reviewRequest,
        artifactIdentity: approvalIdentity,
        now: approvalTimestamp,
      });
      if (!reviewLifecycle) {
        logStoreEvent("plan_approval_blocked_lifecycle_alignment", {
          planTurnId: approvedTurnId,
          sessionKey: reviewSessionKey,
          requestId: reviewRequest.requestId,
          planRevision: approvalIdentity.revision,
        });
        return;
      }
      const approvalLease: PlanApprovalLease = Object.freeze({
        schemaVersion: PLAN_LIFECYCLE_SCHEMA_VERSION,
        leaseId: createPlanApprovalLeaseId(approvalTimestamp),
        sessionKey: reviewRequest.sessionKey,
        sessionEpoch: reviewLifecycle.sessionEpoch,
        planTurnId: approvedTurnId,
        reviewRunId: reviewRequest.runId,
        requestId: reviewRequest.requestId,
        planRevision: approvalIdentity.revision,
        artifactHash: approvalIdentity.artifactHash,
        artifactPaths: Object.freeze([...approvalIdentity.artifactPaths]),
        approvedAt: approvalTimestamp,
        approvalTurnId: approvedTurnId,
        approvalRunId: reviewRequest.runId,
        approvalDecisionKind: "action_decision",
      });
      const approvalDecision = Object.freeze({
        sessionKey: reviewRequest.sessionKey,
        sessionEpoch: reviewLifecycle.sessionEpoch,
        turnId: approvedTurnId,
        runId: reviewRequest.runId,
        requestId: reviewRequest.requestId,
        kind: "action_decision" as const,
      });
      const executionLease: PlanExecutionLease = Object.freeze({
        schemaVersion: PLAN_LIFECYCLE_SCHEMA_VERSION,
        executionLeaseId: createPlanExecutionLeaseId(approvalTimestamp),
        approvalLeaseId: approvalLease.leaseId,
        sessionKey: approvalLease.sessionKey,
        sessionEpoch: approvalLease.sessionEpoch,
        planTurnId: approvedTurnId,
        executionTurnId: approvedTurnId,
        executionRunId,
        parentRunId: executionParentRunId,
        attempt: 1,
        issuedAt: approvalTimestamp,
        reason: "initial_approval",
        instructionHash: executionInstructionHash,
        authorization: approvalDecision,
      });
      const approvalTransition = reducePlanLifecycle(reviewLifecycle, {
        type: "approve",
        expectedVersion: reviewLifecycle.version,
        at: approvalTimestamp,
        expectedReviewIdentity: toPlanLifecycleReviewIdentity(
          reviewRequest,
          reviewLifecycle.sessionEpoch,
        ),
        decisionIdentity: approvalDecision,
        lease: approvalLease,
        executionLease,
      });
      if (approvalTransition.disposition === "rejected") {
        logStoreEvent("plan_approval_blocked_lifecycle_transition", {
          reason: approvalTransition.reason || "unknown",
          planTurnId: approvedTurnId,
          sessionKey: reviewSessionKey,
          requestId: reviewRequest.requestId,
          lifecycleVersion: reviewLifecycle.version,
        });
        return;
      }
      const approvedPlanLifecycle = approvalTransition.state;
      const pendingHandoffPatch: PlanApprovalHandoff = {
        planTurnId: approvedTurnId,
        requestedAt: approvalTimestamp,
        executionTurnId: approvedTurnId,
        executionRunId,
        executionAttempt: executionLease.attempt,
        executionInstructionHash,
        prompt: executionPrompt,
        planRevision: approvalIdentity.revision,
        artifactHash: approvalIdentity.artifactHash,
        artifactPaths: approvalIdentity.artifactPaths,
        parentRunId: executionParentRunId,
        approvalLeaseId: approvalLease.leaseId,
        executionLeaseId: executionLease.executionLeaseId,
        sessionEpoch: approvalLease.sessionEpoch,
        reviewRequestId: approvalLease.requestId,
      };
      const activePlanLoop = !!approvedTurnId && isPlanReviewExecutionLeaseActive({
        agentStatus: state.agentStatus,
        isGenerating: state.isGenerating,
        hasAbortController: state.abortController !== null,
      });
      const sessionKey = resolveSessionRuntimeKey(resolveSessionWorkspaceKey(state.currentWorkspace), state.currentSessionId);

      set((s) => ({
        planLifecycle: approvedPlanLifecycle,
        isPlanApproved: false,
        ...approvalChoicePatch,
        currentTurnExecutionConsent: { turnId: null, granted: false },
        pendingPlanApprovalHandoff: pendingHandoffPatch,
        planApprovalExecutionStartedForTurnId: null,
        activeActionRequest: null,
        planExecutionEvidenceLedger: [],
        planExecutionEvidenceCount: 0,
        planAutoResumeCount: 0,
        planExecutionProgressSnapshot: null,
        ...(executionPlanTasks.length > 0 ? { planTasks: executionPlanTasks } : {}),
        agentStatus: activePlanLoop ? s.agentStatus : "idle",
        isGenerating: activePlanLoop ? s.isGenerating : false,
        abortController: activePlanLoop ? s.abortController : null,
        planStage: "ready_to_execute",
        conversationTurns: approvedTurnId
          ? s.conversationTurns.map((turn) =>
              turn.id === approvedTurnId
                ? {
                    ...turn,
                    status: "paused" as const,
                    summary: language === "zh"
                      ? "计划已批准，正在接纳新的执行 Run。"
                      : "Plan approved; the new execution Run is being admitted.",
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
  resumePlanExecution: (instruction) => {
    const state = get();
    const lifecycle = state.planLifecycle;
    const prompt = String(instruction || "").trim();
    const sessionKey = resolveSessionRuntimeKey(
      resolveSessionWorkspaceKey(state.currentWorkspace),
      state.currentSessionId,
    );
    const planTurnAlreadyTerminal = !!sessionKey &&
      !!lifecycle.planTurnId &&
      state.runtimeEvents.some((event) =>
        isTerminalTurnEvent(event) &&
        event.threadId === sessionKey &&
        event.turnId === lifecycle.planTurnId
      );
    const buildTerminalPlanOwnerRevocationPatch = (latest: AppState): Partial<AppState> => ({
      planLifecycle: revokePlanLifecycleToDiscovery({
        lifecycle: latest.planLifecycle,
        sessionKey: sessionKey || UNBOUND_PLAN_SESSION_KEY,
        artifacts: latest.planArtifacts,
        planTurnId: lifecycle.planTurnId,
      }),
      isPlanApproved: false,
      planApprovalChoice: null,
      pendingPlanApprovalHandoff: null,
      planApprovalExecutionStartedForTurnId: null,
      currentTurnExecutionConsent: { turnId: null, granted: false },
      planStage: derivePlanStageFromArtifacts(
        latest.planArtifacts,
        latest.planTasks,
        false,
        "idle",
      ),
      showPlanPanel: latest.planArtifacts.length > 0,
    });
    if (planTurnAlreadyTerminal) {
      if (
        lifecycle.status !== "paused" ||
        !lifecycle.approvalLease ||
        !isPlanApprovalLeaseBoundToState(lifecycle)
      ) {
        logStoreEvent("plan_explicit_resume_rejected", {
          reason: "plan_turn_already_terminal_without_resumable_owner",
          sessionKey,
          planTurnId: lifecycle.planTurnId,
          lifecycleStatus: lifecycle.status,
        });
        return false;
      }
      let revoked = false;
      set((latest) => {
        const owner = latest.planLifecycle;
        const stillTerminal = latest.runtimeEvents.some((event) =>
          isTerminalTurnEvent(event) &&
          event.threadId === sessionKey &&
          event.turnId === lifecycle.planTurnId
        );
        if (
          !stillTerminal ||
          owner.sessionKey !== lifecycle.sessionKey ||
          owner.sessionEpoch !== lifecycle.sessionEpoch ||
          owner.version !== lifecycle.version
        ) return {};
        revoked = true;
        return buildTerminalPlanOwnerRevocationPatch(latest);
      });
      logStoreEvent("plan_explicit_resume_rejected", {
        reason: revoked
          ? "plan_turn_terminal_owner_revoked_to_discovery"
          : "plan_turn_terminal_owner_compare_and_swap_conflict",
        sessionKey,
        planTurnId: lifecycle.planTurnId,
        lifecycleStatus: lifecycle.status,
      });
      return false;
    }
    const busy = !!state.abortController || state.isGenerating ||
      state.agentStatus === "running" || state.agentStatus === "pending_review";
    if (
      !prompt ||
      !sessionKey ||
      lifecycle.sessionKey !== sessionKey ||
      lifecycle.status !== "paused" ||
      !lifecycle.planTurnId ||
      !lifecycle.approvalLease ||
      !isPlanApprovalLeaseBoundToState(lifecycle) ||
      busy ||
      !!state.activeActionRequest
    ) {
      logStoreEvent("plan_explicit_resume_rejected", {
        reason: !prompt
          ? "empty_instruction"
          : !sessionKey || lifecycle.sessionKey !== sessionKey
          ? "session_owner_mismatch"
          : lifecycle.status !== "paused"
          ? "plan_execution_not_paused"
          : !lifecycle.approvalLease || !isPlanApprovalLeaseBoundToState(lifecycle)
          ? "approval_lease_missing_or_stale"
          : busy
          ? "run_owner_still_active"
          : state.activeActionRequest
          ? "action_request_pending"
          : "plan_turn_missing",
        sessionKey,
        planTurnId: lifecycle.planTurnId,
        lifecycleStatus: lifecycle.status,
      });
      return false;
    }

    const issuedAt = Date.now();
    const executionRunId = createSubmitHarnessRunId(issuedAt);
    const requestId = `plan-resume-action-${executionRunId}`;
    const resumeActionOwner = lifecycle.execution
      ? {
          turnId: lifecycle.execution.turnId,
          runId: lifecycle.execution.runId,
        }
      : {
          turnId: lifecycle.approvalLease.approvalTurnId,
          runId: lifecycle.approvalLease.approvalRunId,
        };
    const issued = issuePlanExplicitResumeAttempt({
      lifecycle,
      instruction: prompt,
      executionRunId,
      executionLeaseId: `plan-execution-resume-${executionRunId}`,
      authorization: {
        kind: "action_decision",
        turnId: resumeActionOwner.turnId,
        runId: resumeActionOwner.runId,
        requestId,
      },
      issuedAt,
    });
    if (!issued.ok) {
      logStoreEvent("plan_explicit_resume_rejected", {
        reason: issued.reason,
        sessionKey,
        planTurnId: lifecycle.planTurnId,
        priorRunId: lifecycle.execution?.runId || lifecycle.approvalLease.approvalRunId,
      });
      return false;
    }

    let reserved = false;
    let reservationRejectionReason = "lifecycle_compare_and_swap_conflict";
    set((latest) => {
      const owner = latest.planLifecycle;
      const ownerTurnAlreadyTerminal = latest.runtimeEvents.some((event) =>
        isTerminalTurnEvent(event) &&
        event.threadId === sessionKey &&
        event.turnId === lifecycle.planTurnId
      );
      if (
        owner.sessionKey !== lifecycle.sessionKey ||
        owner.sessionEpoch !== lifecycle.sessionEpoch ||
        owner.version !== lifecycle.version ||
        owner.status !== "paused" ||
        latest.abortController ||
        latest.isGenerating ||
        latest.agentStatus === "running" ||
        latest.agentStatus === "pending_review" ||
        latest.activeActionRequest ||
        ownerTurnAlreadyTerminal
      ) {
        if (ownerTurnAlreadyTerminal) {
          reservationRejectionReason = "plan_turn_terminal_owner_revoked_to_discovery";
          if (
            owner.sessionKey === lifecycle.sessionKey &&
            owner.sessionEpoch === lifecycle.sessionEpoch &&
            owner.version === lifecycle.version
          ) {
            return buildTerminalPlanOwnerRevocationPatch(latest);
          }
        }
        return {};
      }
      reserved = true;
      return {
        planLifecycle: issued.lifecycle,
        isPlanApproved: false,
        pendingPlanApprovalHandoff: issued.handoff,
        planApprovalExecutionStartedForTurnId: null,
        currentTurnExecutionConsent: { turnId: null, granted: false },
        planStage: "ready_to_execute",
        conversationTurns: latest.conversationTurns.map((turn) =>
          turn.id === lifecycle.planTurnId
            ? {
                ...turn,
                status: "paused" as const,
                summary: latest.config.language === "en"
                  ? "The explicit Plan resume was accepted and its child Run is being admitted."
                  : "计划续跑操作已接受，正在接纳新的子 Run。",
              }
            : turn
        ),
      };
    });
    if (!reserved) {
      logStoreEvent("plan_explicit_resume_rejected", {
        reason: reservationRejectionReason,
        sessionKey,
        planTurnId: lifecycle.planTurnId,
        expectedVersion: lifecycle.version,
      });
      return false;
    }

    logStoreEvent("plan_explicit_resume_reserved", {
      sessionKey,
      planTurnId: lifecycle.planTurnId,
      requestId,
      executionRunId,
      executionLeaseId: issued.handoff.executionLeaseId,
      executionAttempt: issued.handoff.executionAttempt,
    });
    runAfterNextPaint(() => {
      startApprovedPlanExecutionInCurrentTurn({
        get,
        setActiveState: (patch) => set(patch),
        planTurnId: lifecycle.planTurnId!,
        handoff: issued.handoff,
        sessionKey,
        source: "store_fallback",
      });
    });
    return true;
  },
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
    const canceledTurnId = state.activeActionRequest?.kind === "plan_review"
      ? state.activeActionRequest.turnId
      : state.currentTurnId;
    if (canceledTurnId) {
      get().closeTurnAsCanceled(canceledTurnId, {
        reason: "plan_rejected",
        message: state.config.language === "en"
          ? "The plan was rejected by the user; this turn is now closed."
          : "用户已拒绝计划，本回合已完成收口。",
      });
    }
    const rejectionSessionKey = resolveSessionRuntimeKey(
      resolveSessionWorkspaceKey(state.currentWorkspace),
      state.currentSessionId,
    ) || UNBOUND_PLAN_SESSION_KEY;
    set((latest) => ({
      planLifecycle: revokePlanLifecycleToDiscovery({
        lifecycle: latest.planLifecycle,
        sessionKey: rejectionSessionKey,
        artifacts: latest.planArtifacts,
        planTurnId: canceledTurnId,
      }),
      isPlanApproved: false,
      planApprovalChoice: null,
      pendingPlanApprovalHandoff: null,
      planApprovalExecutionStartedForTurnId: null,
      activeActionRequest: null,
      planExecutionEvidenceLedger: [],
      planExecutionEvidenceCount: 0,
      planAutoResumeCount: 0,
      planExecutionProgressSnapshot: null,
      ...(canceledTurnId
        ? {}
        : { agentStatus: "idle", isGenerating: false, abortController: null }),
    }));
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
    const workspacePath = String(get().currentWorkspace || "").trim();
    if (!workspacePath || workspacePath === GLOBAL_CHAT_KEY) {
      logStoreEvent("goal_start_rejected_without_workspace", {
        sessionKey: options?.sessionKey || null,
        ownerTurnId: options?.ownerTurnId || get().currentTurnId || null,
      });
      return;
    }
    const newGoal = createGoalDefinition({
      objective,
      sourceContext: options?.sourceContext,
      subagentPreference: options?.subagentPreference,
      iterationBudget: options?.maxIterations,
      tokenBudget: options?.maxTokens,
      toolCallBudget: options?.maxToolCalls,
      maxDurationMs: options?.maxDurationMs,
      sessionKey: options?.sessionKey,
      ownerTurnId: options?.ownerTurnId || get().currentTurnId || undefined,
    });
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
    const current = get();
    const {
      activeGoal,
      goalProgress,
      goalRuntime,
      isGenerating,
      abortController,
      activeActionRequest,
    } = current;
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
    const sessionKey = resolveVisibleGoalSubmissionSessionKey(current);
    const pendingReviewOwnership = resolveGoalPendingReviewOwnership({
      goal: activeGoal,
      marker: current.harnessRunMarker,
      currentWorkspace: resolveSessionWorkspaceKey(current.currentWorkspace),
      currentSessionKey: sessionKey,
      agentStatus: current.agentStatus,
      actionRequest: activeActionRequest,
      pendingReviewTaskId: current.pendingReviewTaskId,
      hasPendingReviewResolver: !!current.pendingReviewResolve,
    });
    const pauseTransition = resolveGoalPauseTransition({
      goal: activeGoal,
      queuedMessage: current.queuedUserMessage,
      marker: current.harnessRunMarker,
      currentWorkspace: resolveSessionWorkspaceKey(current.currentWorkspace),
      currentSessionKey: sessionKey,
      isGenerating,
      hasAbortController: !!abortController,
      hasOwnedPendingReview: pendingReviewOwnership.owned,
    });
    const nextStatus: GoalStatus = pauseTransition.nextStatus;
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
    set((state) => {
      return {
        activeGoal: nextGoal,
        goalProgress: nextRuntime.progress,
        goalStatus: nextStatus,
        goalRuntime: nextRuntime,
        ...(pauseTransition.shouldClearQueuedContinuation ? { queuedUserMessage: null } : {}),
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
      };
    });
    if (!pauseTransition.shouldAbortRun && isGenerating && abortController) {
      logStoreEvent("goal_pause_foreign_run_preserved", {
        goalId: activeGoal.id,
        goalRevision: expectedRevision,
        reason: pauseTransition.abortReason,
        markerRuntimeIntent: current.harnessRunMarker?.runtimeIntent || null,
        markerSessionKey: current.harnessRunMarker?.sessionKey || null,
        markerTurnId: current.harnessRunMarker?.turnId || null,
      });
    }
    if (pauseTransition.shouldAbortRun) abortController?.abort();
  },
  resumeGoal: (expectedIdentity) => {
    const {
      activeGoal,
      goalStatus,
      isGenerating,
      config,
      runtimeEvents,
      conversationTurns,
      currentTurnId,
      activeActionRequest,
      harnessRunMarker,
      currentWorkspace,
      currentSessionId,
    } = get();
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
      (hasPendingActionRequest && !exactControlResolution)) {
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
    const previousOwnerTurnId = activeGoal.ownerTurnId || eventOwnerTurnId || currentTurnId || null;
    if (!previousOwnerTurnId) return;
    const ownerWorkspaceKey = resolveSessionWorkspaceKey(currentWorkspace);
    const ownerSessionKey = resolveVisibleGoalSubmissionSessionKey({
      currentWorkspace,
      currentSessionId,
    });
    const resumeBoundary = resolveGoalResumeTurnBoundary({
      ownerTurnId: previousOwnerTurnId,
      sessionKey: ownerSessionKey,
      conversationTurns,
      runtimeEvents,
    });
    const resumeTurnId = resumeBoundary.turnId;
    logStoreEvent("goal_resume_turn_boundary_resolved", {
      goalId: activeGoal.id,
      goalRevision: activeGoal.revision || 1,
      previousOwnerTurnId,
      resumeTurnId,
      reuseCurrentTurn: resumeBoundary.reuseCurrentTurn,
      reason: resumeBoundary.reason,
    });
    const language = config.language === "en" ? "en" : "zh";
    const resumeText = language === "en"
      ? `Resume the active goal ${activeGoal.id} from its latest checkpoint.`
      : `从最近检查点继续执行当前目标 ${activeGoal.id}。`;
    const goalContinuationEnvelope = get().captureGoalContinuationEnvelope(
      resumeText,
      {
        source: "goal_manual_resume",
        ...(exactControlResolution && activeActionRequest?.kind === "goal_confirmation"
          ? { requestId: activeActionRequest.requestId }
          : {}),
      },
    );
    if (!goalContinuationEnvelope) {
      logStoreEvent("goal_resume_authorization_capture_failed", {
        goalId: activeGoal.id,
        goalRevision: expectedRevision,
        ownerSessionKey,
      });
      return;
    }
    setTimeout(() => {
      const sent = get().sendMessage(
        resumeText,
        undefined,
        {
          hidden: true,
          resolvedIntent: "execute",
          runtimeIntentOverride: "goal",
          goalContinuationEnvelope,
          goalContinuationGuidance: resumeText,
          skipIntentResolution: true,
          reuseCurrentTurn: resumeBoundary.reuseCurrentTurn,
          turnIdOverride: resumeTurnId,
          parentRunIdOverride: resumeBoundary.parentRunId || undefined,
          preservePlanState: false,
          createVisibleTurnForHiddenMessage: resumeBoundary.createVisibleTurnForHiddenMessage,
          submissionOriginSessionKey: ownerSessionKey,
        },
      );
      if (sent === false) {
        const current = get();
        const activeSessionKey = resolveVisibleGoalSubmissionSessionKey(current);
        const ownerRuntime = activeSessionKey === ownerSessionKey
          ? createSessionRuntimeFromState(current)
          : current.runtimeBySessionKey[ownerSessionKey] || null;
        if (!ownerRuntime) return;
        if (isQueuedGoalContinuationOwnedByGoal({
          queuedMessage: ownerRuntime.queuedUserMessage,
          goal: activeGoal,
          workspaceKey: ownerWorkspaceKey,
          sessionKey: ownerSessionKey,
          expectedText: resumeText,
          expectedSource: "goal_manual_resume",
        })) {
          logStoreEvent("goal_resume_waiting_in_exact_queue", {
            goalId: activeGoal.id,
            goalRevision: activeGoal.revision || 1,
            ownerSessionKey,
          });
          return;
        }
        logStoreEvent("goal_resume_submission_rejected", {
          goalId: activeGoal.id,
          goalRevision: activeGoal.revision || 1,
          ownerSessionKey,
          activeSessionKey,
        });
      }
    }, 0);
  },
  clearGoal: async (expectedIdentity) => {
    const current = get();
    const goal = current.activeGoal;
    if (!goal || !isCurrentGoalAdministrativeControl({
      request: current.activeActionRequest,
      identity: expectedIdentity,
      goalId: goal?.id,
      goalRevision: goal?.revision || 1,
    })) {
      logStoreEvent("goal_clear_identity_mismatch", {
        expectedGoalId: expectedIdentity?.goalId || null,
        activeGoalId: goal?.id || null,
        expectedRevision: expectedIdentity?.goalRevision || null,
        activeRevision: goal?.revision || null,
        expectedRequestId: expectedIdentity?.requestId || null,
        activeRequestId: current.activeActionRequest?.requestId || null,
      });
      return false;
    }

    const goalRevision = goal.revision || 1;
    const workspace = String(current.currentWorkspace || "").trim();
    const ownerScopeKey = resolveSessionWorkspaceKey(workspace);
    const currentSessionKey = resolveSessionRuntimeKey(
      ownerScopeKey,
      current.currentSessionId,
    );
    const goalSessionKey = String(goal.sessionKey || "").trim();
    if (!workspace || !current.currentSessionId || !currentSessionKey || (
      goalSessionKey &&
      goalSessionKey !== workspace &&
      goalSessionKey !== currentSessionKey
    )) {
      logStoreEvent("goal_clear_workspace_identity_mismatch", {
        goalId: goal.id,
        goalRevision,
        workspace: workspace || null,
        goalSessionKey: goalSessionKey || null,
        currentSessionKey,
      });
      return false;
    }
    const ownerSessionKey = currentSessionKey;
    const ownerSessionId = current.currentSessionId;
    const ownerRuntimeSnapshot = createSessionRuntimeFromState(current);
    get().updateRuntimeForSession(ownerSessionKey, () => ownerRuntimeSnapshot);
    const hasDeletedGoalIdentity = (candidate: GoalDefinition | null | undefined) =>
      candidate?.id === goal.id && (candidate.revision || 1) === goalRevision;
    const runtimeHasDeletedGoal = (runtime: Pick<SessionRuntimeState, "activeGoal" | "goalRuntime">) =>
      hasDeletedGoalIdentity(runtime.activeGoal) || hasDeletedGoalIdentity(runtime.goalRuntime?.goal);
    const resolveActiveSessionKey = (state: Pick<AppState, "currentWorkspace" | "currentSessionId">) =>
      resolveSessionRuntimeKey(
        resolveSessionWorkspaceKey(state.currentWorkspace),
        state.currentSessionId,
      );
    const resolveOwnerRuntime = (): SessionRuntimeState => {
      const state = get();
      if (resolveActiveSessionKey(state) === ownerSessionKey) {
        return createSessionRuntimeFromState(state);
      }
      return state.runtimeBySessionKey[ownerSessionKey] || ownerRuntimeSnapshot;
    };
    const applyOwnerRuntimePatch = (
      updater: (runtime: SessionRuntimeState) => Partial<SessionRuntimeState>,
    ) => {
      let appliedToActiveProjection = false;
      set((state) => {
        if (resolveActiveSessionKey(state) !== ownerSessionKey) return {};
        appliedToActiveProjection = true;
        return pickSessionRuntimePatch(updater(createSessionRuntimeFromState(state)));
      });
      if (!appliedToActiveProjection) {
        get().updateRuntimeForSession(ownerSessionKey, updater);
      }
    };
    const updateOwnerSessionRecord = (
      runtime: SessionRuntimeState,
      savedSessionPatch?: Partial<Session>,
    ) => {
      const state = get();
      const runtimeSnapshot = buildSessionRuntimeSnapshotFromStoreState({
        ...state,
        ...runtime,
        currentWorkspace: workspace,
        currentSessionId: ownerSessionId,
      });
      const messages = sanitizeTaskBlocksForPersist(runtime.taskFlow || []);
      state.updateSession(ownerScopeKey, ownerSessionId, {
        ...savedSessionPatch,
        messages,
        runtimeSnapshot,
      });
      return { messages, runtimeSnapshot };
    };

    let deletionPath: string;
    let deletionFencePath: string;
    try {
      deletionPath = resolveGoalRuntimeRelativeDirPath(goal.id);
      deletionFencePath = resolveGoalDeletionFenceRelativePath(goal.id);
    } catch (error) {
      logStoreEvent("goal_clear_invalid_goal_id", {
        goalId: goal.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
    const deletionRequestedAt = Date.now();

    const pendingReviewOwnership = resolveGoalPendingReviewOwnership({
      goal,
      marker: current.harnessRunMarker,
      currentWorkspace: workspace,
      currentSessionKey: ownerSessionKey,
      agentStatus: current.agentStatus,
      actionRequest: current.activeActionRequest,
      pendingReviewTaskId: current.pendingReviewTaskId,
      hasPendingReviewResolver: !!current.pendingReviewResolve,
    });
    const ownedPendingReviewResolve = pendingReviewOwnership.owned
      ? current.pendingReviewResolve
      : null;
    const ownedPendingReviewTaskId = pendingReviewOwnership.owned
      ? current.pendingReviewTaskId
      : null;
    const ownedPendingReviewRequestId = pendingReviewOwnership.owned
      ? current.activeActionRequest?.requestId || null
      : null;
    const goalActionRunId = getHarnessActionRunId(current.harnessRunMarker);
    const resolveOwnedGoalActionRequest = (
      runtime: SessionRuntimeState,
    ): ActionRequest | null => {
      const request = runtime.activeActionRequest;
      if (!request) return null;
      const ownership = resolveGoalActionRequestOwnership({
        goal,
        marker: runtime.harnessRunMarker,
        currentWorkspace: workspace,
        currentSessionKey: ownerSessionKey,
        actionRequest: request,
      });
      return ownership.owned ? request : null;
    };
    const ownedGoalUserChoice = current.activeActionRequest?.kind === "user_choice" &&
      current.activeActionRequest.status === "pending" &&
      current.harnessRunMarker?.status === "paused" &&
      current.harnessRunMarker.runtimeIntent === "goal" &&
      current.harnessRunMarker.sessionKey === ownerSessionKey &&
      current.harnessRunMarker.turnId === goal.ownerTurnId &&
      current.activeActionRequest.sessionKey === ownerSessionKey &&
      current.activeActionRequest.turnId === goal.ownerTurnId &&
      current.activeActionRequest.runId === goalActionRunId
        ? current.activeActionRequest
        : null;
    const abortOwnership = resolveGoalRunAbortOwnership({
      goal,
      marker: current.harnessRunMarker,
      currentWorkspace: workspace,
      currentSessionKey: ownerSessionKey,
      isGenerating: current.isGenerating,
      hasAbortController: !!current.abortController,
      hasOwnedPendingReview: pendingReviewOwnership.owned,
    });
    const runAbortController = abortOwnership.owned ? current.abortController : null;
    if (
      !abortOwnership.owned &&
      (goal.status === "active" || goal.status === "pausing") &&
      current.isGenerating &&
      current.abortController
    ) {
      logStoreEvent("goal_clear_foreign_run_preserved", {
        goalId: goal.id,
        goalRevision,
        reason: abortOwnership.reason,
        markerRuntimeIntent: current.harnessRunMarker?.runtimeIntent || null,
        markerSessionKey: current.harnessRunMarker?.sessionKey || null,
        markerTurnId: current.harnessRunMarker?.turnId || null,
      });
    }
    markGoalRuntimeDeleted(workspace, goal.id, { retainFenceForProcess: true });
    try {
      await writeFileAtomic(
        deletionFencePath,
        serializeGoalDeletionFence({
          goalId: goal.id,
          ownerSessionKey,
          deletedAt: deletionRequestedAt,
        }),
        workspace,
      );
    } catch (error) {
      unmarkGoalRuntimeDeleted(workspace, goal.id);
      logStoreEvent("goal_clear_deletion_fence_write_failed", {
        goalId: goal.id,
        goalRevision,
        ownerSessionKey,
        path: deletionFencePath,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error instanceof Error ? error : new Error(String(error));
    }
    const buildDeletionFailurePatch = (
      runtime: SessionRuntimeState,
      message: string,
      tombstoneRetained: boolean,
    ): Partial<SessionRuntimeState> => {
      if (!runtimeHasDeletedGoal(runtime)) return {};
      const nextStatus = tombstoneRetained ? "pausing" as const : "paused" as const;
      const notice = tombstoneRetained
        ? `Goal deletion is still pending: ${message}`
        : `Goal deletion failed: ${message}`;
      let runtimeGoal: GoalDefinition = goal;
      if (runtime.goalRuntime && hasDeletedGoalIdentity(runtime.goalRuntime.goal)) {
        runtimeGoal = runtime.goalRuntime.goal;
      } else if (runtime.activeGoal && hasDeletedGoalIdentity(runtime.activeGoal)) {
        runtimeGoal = runtime.activeGoal;
      }
      const pendingGoal = {
        ...runtimeGoal,
        status: nextStatus,
        updatedAt: Date.now(),
      };
      const pendingProgress = runtime.goalProgress?.goalId === goal.id
        ? {
            ...runtime.goalProgress,
            pauseReason: notice,
            lastUpdatedAt: Date.now(),
          }
        : runtime.goalProgress;
      const pendingRuntime = hasDeletedGoalIdentity(runtime.goalRuntime?.goal) && runtime.goalRuntime
        ? {
            ...runtime.goalRuntime,
            goal: pendingGoal,
            progress: pendingProgress || runtime.goalRuntime.progress,
            status: nextStatus,
            phase: "re_plan" as const,
            pauseReason: notice,
            lastError: message,
            updatedAt: Date.now(),
          }
        : runtime.goalRuntime;
      return {
        ...(hasDeletedGoalIdentity(runtime.activeGoal) ? { activeGoal: pendingGoal } : {}),
        goalProgress: pendingProgress,
        goalStatus: nextStatus,
        goalRuntime: pendingRuntime,
        ...(isQueuedGoalContinuationOwnedByGoal({
          queuedMessage: runtime.queuedUserMessage,
          goal,
          workspaceKey: ownerScopeKey,
          sessionKey: ownerSessionKey,
        })
          ? { queuedUserMessage: null }
          : {}),
      };
    };

    // Record a visible deletion-pending projection before touching disk. It
    // prevents a session switch or app interruption from restoring this Goal
    // as actively running while the destructive transaction is in flight.
    applyOwnerRuntimePatch((runtime) => buildDeletionFailurePatch(
      runtime,
      "waiting for the Goal run to stop and persistent data to be removed",
      true,
    ));
    updateOwnerSessionRecord(resolveOwnerRuntime());

    let ownerLeaseReleased = !runAbortController && !pendingReviewOwnership.owned;
    let diskDeleted = false;

    try {
      runAbortController?.abort();
      if (ownedPendingReviewResolve) {
        applyOwnerRuntimePatch((runtime) => {
          if (
            runtime.pendingReviewResolve !== ownedPendingReviewResolve ||
            runtime.pendingReviewTaskId !== ownedPendingReviewTaskId ||
            runtime.activeActionRequest?.requestId !== ownedPendingReviewRequestId
          ) {
            return {};
          }
          return {
            pendingReviewResolve: null,
            pendingReviewTaskId: null,
            activeActionRequest: null,
            pendingToolCall: null,
          };
        });
        ownedPendingReviewResolve({ action: "reject" });
      }
      if (runAbortController || pendingReviewOwnership.owned) {
        const settled = await waitForGoalRunLeaseRelease({
          abortController: runAbortController,
          harnessRunId: current.harnessRunMarker?.runId || null,
          getLeaseSnapshot: () => {
            const state = get();
            const runtime = resolveActiveSessionKey(state) === ownerSessionKey
              ? state
              : state.runtimeBySessionKey[ownerSessionKey] || null;
            return runtime
              ? {
                  abortController: runtime.abortController,
                  harnessRunMarker: runtime.harnessRunMarker || null,
                }
              : null;
          },
        });
        if (!settled) {
          throw new Error("The active Goal run did not stop before the deletion timeout");
        }
        ownerLeaseReleased = true;
      }

      await deleteWorkspacePath(deletionPath, workspace);
      diskDeleted = true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      let deletionFenceRemoved = false;
      try {
        await deleteWorkspacePath(deletionFencePath, workspace);
        deletionFenceRemoved = true;
      } catch (fenceError) {
        logStoreEvent("goal_clear_deletion_fence_cleanup_failed", {
          goalId: goal.id,
          goalRevision,
          ownerSessionKey,
          path: deletionFencePath,
          error: fenceError instanceof Error ? fenceError.message : String(fenceError),
        });
      }
      const tombstoneRetained = !ownerLeaseReleased || !deletionFenceRemoved;
      if (!tombstoneRetained) {
        unmarkGoalRuntimeDeleted(workspace, goal.id);
      }
      applyOwnerRuntimePatch((runtime) => buildDeletionFailurePatch(
        runtime,
        message,
        tombstoneRetained,
      ));
      updateOwnerSessionRecord(resolveOwnerRuntime());
      logStoreEvent("goal_clear_delete_failed", {
        goalId: goal.id,
        goalRevision,
        workspace,
        path: deletionPath,
        error: message,
        ownerSessionKey,
        ownerLeaseReleased,
        diskDeleted,
        deletionFenceRemoved,
        tombstoneRetained,
        deletionRequestedAt,
      });
      throw error instanceof Error ? error : new Error(message);
    }

    const clearedEvent = withEventSchema({
      type: "goal.cleared",
      ...resolveGoalEventOwnerIdentity({
        goal,
        currentWorkspace: workspace,
        currentSessionId: ownerSessionId,
        currentTurnId: goal.ownerTurnId || current.currentTurnId,
      }),
      timestampMs: Date.now(),
      goalId: goal.id,
      previousStatus: current.goalStatus,
    });
    const buildClearedOwnerRuntime = (runtime: SessionRuntimeState): SessionRuntimeState => {
      const runtimeOwnedActionRequest = resolveOwnedGoalActionRequest(runtime);
      const runtimeOwnedWaitingAction = runtimeOwnedActionRequest || (
        ownedGoalUserChoice &&
        runtime.activeActionRequest?.requestId === ownedGoalUserChoice.requestId
          ? ownedGoalUserChoice
          : null
      );
      const cancelableRuntime = {
        ...runtime,
        runtimeEvents: runtime.runtimeEvents || [],
        taskFlow: runtime.taskFlow || [],
        conversationTurns: runtime.conversationTurns || [],
      };
      const closedWaitingRuntime: SessionRuntimeState = runtimeOwnedWaitingAction
        ? projectCanceledTurn({
            state: cancelableRuntime,
            sessionKey: ownerSessionKey,
            turnId: runtimeOwnedWaitingAction.turnId,
            runId: runtimeOwnedWaitingAction.runId,
            parentRunId: runtimeOwnedWaitingAction.parentRunId || null,
            reason: "goal_cleared",
            message: current.config.language === "en"
              ? "The Goal was cleared; its waiting turn was canceled and closed."
              : "Goal 已清除；等待中的回合已取消并收口。",
            nextTaskId: get()._nextTaskId,
          }).state
        : runtime;
      const activeGoalMatches = hasDeletedGoalIdentity(closedWaitingRuntime.activeGoal);
      const runtimeGoalMatches = hasDeletedGoalIdentity(closedWaitingRuntime.goalRuntime?.goal);
      const progressMatches = closedWaitingRuntime.goalProgress?.goalId === goal.id;
      const nextActiveGoal = activeGoalMatches ? null : closedWaitingRuntime.activeGoal;
      const nextGoalRuntime = runtimeGoalMatches ? null : closedWaitingRuntime.goalRuntime;
      // An action request is global session runtime state. Clear it only when
      // strict Goal marker ownership was proven; a stale Goal must not consume
      // a request owned by a newer Execute run on the same logical turn.
      let nextActionRequest = closedWaitingRuntime.activeActionRequest;
      if (
        ownedPendingReviewRequestId &&
        nextActionRequest?.requestId === ownedPendingReviewRequestId
      ) {
        nextActionRequest = null;
      }
      if (
        ownedGoalUserChoice &&
        nextActionRequest?.requestId === ownedGoalUserChoice.requestId
      ) {
        nextActionRequest = null;
      }
      if (
        runtimeOwnedActionRequest &&
        nextActionRequest?.requestId === runtimeOwnedActionRequest.requestId
      ) {
        nextActionRequest = null;
      }
      const pendingResolverMatches = !!ownedPendingReviewResolve &&
        closedWaitingRuntime.pendingReviewResolve === ownedPendingReviewResolve &&
        closedWaitingRuntime.pendingReviewTaskId === ownedPendingReviewTaskId;
      const runtimePendingResolverMatches =
        runtimeOwnedActionRequest?.kind === "tool_permission" &&
        closedWaitingRuntime.pendingReviewTaskId === runtimeOwnedActionRequest.taskId;
      const runtimeEvents = closedWaitingRuntime.runtimeEvents || [];
      const alreadyRecorded = runtimeEvents.some((event) =>
        event.type === "goal.cleared" && event.goalId === goal.id
      );
      return {
        ...closedWaitingRuntime,
        activeGoal: nextActiveGoal,
        goalProgress: progressMatches ? null : closedWaitingRuntime.goalProgress,
        goalStatus: !nextActiveGoal && !nextGoalRuntime ? "paused" : closedWaitingRuntime.goalStatus,
        goalRuntime: nextGoalRuntime,
        activeActionRequest: nextActionRequest,
        ...(pendingResolverMatches || runtimePendingResolverMatches
          ? {
              pendingReviewResolve: null,
              pendingReviewTaskId: null,
              pendingToolCall: null,
            }
          : {}),
        ...(runAbortController && closedWaitingRuntime.abortController === runAbortController
          ? { abortController: null }
          : {}),
        runtimeEvents: alreadyRecorded
          ? runtimeEvents
          : appendRuntimeEvent(runtimeEvents, clearedEvent),
      };
    };

    const clearedOwnerRuntime = buildClearedOwnerRuntime(resolveOwnerRuntime());
    const ownerSession = (get().sessionsByWorkspace[ownerScopeKey] || []).find(
      (session) => session.id === ownerSessionId,
    );
    const clearedSessionRecord = updateOwnerSessionRecord(clearedOwnerRuntime);
    const shouldPersistOwnerSession = !!ownerSession && (
      ownerSession.storageStatus === "ok" ||
      (get().config.sessionRecordingEnabled && ownerSession.recordingDisabled !== true)
    );
    let savedSessionPatch: Partial<Session> | undefined;
    let ownerSessionSnapshotSaved = !shouldPersistOwnerSession;
    let ownerSessionSaveError: unknown = null;
    if (ownerSession && shouldPersistOwnerSession) {
      for (let attempt = 1; attempt <= 2 && !ownerSessionSnapshotSaved; attempt += 1) {
        try {
          const saved = await saveProjectSession(ownerScopeKey, {
            ...ownerSession,
            messages: clearedSessionRecord.messages,
            runtimeSnapshot: clearedSessionRecord.runtimeSnapshot,
          });
          if (saved && typeof saved === "object") {
            savedSessionPatch = saved as Partial<Session>;
          }
          ownerSessionSnapshotSaved = true;
        } catch (error) {
          ownerSessionSaveError = error;
          logStoreEvent(attempt === 1
            ? "goal_clear_owner_session_save_failed"
            : "goal_clear_owner_session_resave_failed", {
            goalId: goal.id,
            goalRevision,
            ownerSessionKey,
            attempt,
            retryExhausted: attempt === 2,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

    if (!ownerSessionSnapshotSaved) {
      const persistenceDetail = ownerSessionSaveError instanceof Error
        ? ownerSessionSaveError.message
        : String(ownerSessionSaveError || "unknown session persistence error");
      const message = `The Goal directory was removed, but the owner session could not record the deletion: ${persistenceDetail}. Retry deletion before restarting MAIN.`;
      applyOwnerRuntimePatch((runtime) => buildDeletionFailurePatch(runtime, message, true));
      updateOwnerSessionRecord(resolveOwnerRuntime());
      logStoreEvent("goal_clear_session_commit_required", {
        goalId: goal.id,
        goalRevision,
        ownerSessionKey,
        diskDeleted: true,
        error: persistenceDetail,
      });
      throw new Error(message);
    }

    // Disk deletion has succeeded. Commit the original owner session even
    // if the user switched sessions or replaced the active UI projection
    // while the async transaction was running.
    applyOwnerRuntimePatch((runtime) => buildClearedOwnerRuntime(runtime));
    const committedOwnerRuntime = resolveOwnerRuntime();
    updateOwnerSessionRecord(committedOwnerRuntime, savedSessionPatch);
    // Keep the durable fence for the rest of this process. An autosave that
    // started before this transaction may still finish after the explicit
    // cleared-session save and rewrite a stale Goal snapshot. Startup recovery
    // in the next process performs the final scrub, then removes the marker.
    logStoreEvent("goal_clear_deletion_fence_retained", {
      goalId: goal.id,
      goalRevision,
      ownerSessionKey,
      path: deletionFencePath,
      committed: true,
      cleanup: "next_process_startup_recovery",
    });

    if (resolveActiveSessionKey(get()) !== ownerSessionKey) {
      logStoreEvent("goal_clear_late_identity_mismatch", {
        deletedGoalId: goal.id,
        deletedGoalRevision: goalRevision,
        ownerSessionKey,
        activeSessionKey: resolveActiveSessionKey(get()),
        activeGoalId: get().activeGoal?.id || null,
        activeGoalRevision: get().activeGoal?.revision || null,
        diskDeleted: true,
      });
    }
    return true;
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
    const activeGoal = state.activeGoal;
    const workspace = String(state.currentWorkspace || "").trim();
    if (
      !activeGoal ||
      progress.goalId !== activeGoal.id ||
      isGoalRuntimeDeleted(workspace, progress.goalId)
    ) {
      logStoreEvent("goal_progress_update_ignored_stale", {
        progressGoalId: progress.goalId,
        activeGoalId: activeGoal?.id || null,
        deletionTombstone: isGoalRuntimeDeleted(workspace, progress.goalId),
      });
      return;
    }
    const runtime = buildGoalRuntimeSnapshot({
      goal: activeGoal,
      progress,
      phase: state.goalRuntime?.phase || null,
      pauseReason: state.goalRuntime?.pauseReason,
    });
    set({ goalProgress: progress, goalRuntime: runtime });
  },
  updateGoalRuntime: (runtime) => {
    const current = get();
    const activeGoal = current.activeGoal;
    const workspace = String(current.currentWorkspace || "").trim();
    const normalizedGoal = migrateGoalDefinition(runtime.goal);
    if (
      !activeGoal ||
      normalizedGoal.id !== activeGoal.id ||
      (normalizedGoal.revision || 1) !== (activeGoal.revision || 1) ||
      isGoalRuntimeDeleted(workspace, normalizedGoal.id)
    ) {
      logStoreEvent("goal_runtime_update_ignored_stale", {
        runtimeGoalId: normalizedGoal.id,
        runtimeGoalRevision: normalizedGoal.revision || 1,
        activeGoalId: activeGoal?.id || null,
        activeGoalRevision: activeGoal?.revision || null,
        deletionTombstone: isGoalRuntimeDeleted(workspace, normalizedGoal.id),
      });
      return;
    }
    const previous = current.goalRuntime;
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
  preferSubagents: false,
  webSearchEnabled: false,
  webSearchProvider: "duckduckgo",
  approvedLocalFileReadPaths: [],
  approvedShellPermissionRules: [],
  readOnlyAutoApproveForSession: false,
  currentTurnExecutionConsent: { turnId: null, granted: false },
  queuedUserMessage: null,
  activeGuidance: null,
  workspaceTurnQueue: null,
  workspaceInstructionLedger: [],
  transcriptPartial: false,
  transcriptLoadedTurns: 0,
  transcriptTotalTurns: 0,
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
  setPreferSubagents: (v) => {
    const state = get();
    if (state.isGenerating || state.agentStatus === "running") {
      logStoreEvent("subagent_preference_toggle_blocked", {
        agentStatus: state.agentStatus,
        isGenerating: state.isGenerating,
      });
      return;
    }
    set({ preferSubagents: v });
    logStoreEvent("subagent_preference_toggled", { enabled: v });
  },
  setWebSearchEnabled: (v) => set({ webSearchEnabled: v }),
  setWebSearchProvider: (provider) => set({ webSearchProvider: normalizeWebSearchProvider(provider) }),
  setReadOnlyAutoApproveForSession: (v) => set({ readOnlyAutoApproveForSession: v }),
  captureVisibleGoalSubmissionEnvelope: (text) => {
    const state = get();
    if (!state.currentWorkspace || state.currentWorkspace === GLOBAL_CHAT_KEY) {
      logStoreEvent("visible_goal_submission_authorization_rejected_without_workspace", {
        sessionKey: resolveVisibleGoalSubmissionSessionKey(state),
        textChars: text.length,
      });
      return null;
    }
    const sessionKey = resolveVisibleGoalSubmissionSessionKey(state);
    const envelope = visibleGoalSubmissionAuthorizationBroker.capture({
      text,
      sessionKey,
      currentMainModeKey: state.selectedMainModeKey,
      lockedComposerIntent: state.lockedComposerIntent,
    });
    if (envelope) {
      logStoreEvent("visible_goal_submission_authorization_captured", {
        sessionKey,
        textChars: text.length,
        source: state.lockedComposerIntent === "goal" ? "capsule" : "shortcut",
      });
    }
    return envelope;
  },
  captureGoalContinuationEnvelope: (text, options) => {
    const state = get();
    const goal = state.activeGoal;
    if (!goal) return null;
    const workspaceKey = resolveSessionWorkspaceKey(state.currentWorkspace);
    const sessionKey = resolveVisibleGoalSubmissionSessionKey(state);
    const candidate = createGoalContinuationAuthorization({
      source: options.source,
      workspaceKey,
      sessionKey,
      goalId: goal.id,
      goalRevision: goal.revision || 1,
      ownerTurnId: String(goal.ownerTurnId || "").trim(),
      ...(options.requestId ? { requestId: options.requestId } : {}),
    });
    const authorization = validateGoalContinuationAuthorization({
      authorization: candidate,
      currentWorkspace: state.currentWorkspace,
      currentSessionId: state.currentSessionId,
      activeGoal: goal,
      activeActionRequest: state.activeActionRequest,
    });
    if (!authorization) {
      logStoreEvent("goal_continuation_authorization_rejected", {
        source: options.source,
        goalId: goal.id,
        requestId: options.requestId || null,
      });
      return null;
    }
    const envelope = goalContinuationAuthorizationBroker.issueValidated({
      text,
      authorization,
    });
    logStoreEvent("goal_continuation_authorization_captured", {
      source: authorization.source,
      goalId: authorization.goalId,
      goalRevision: authorization.goalRevision,
      ownerTurnId: authorization.ownerTurnId,
      requestId: authorization.requestId || null,
    });
    return envelope;
  },
  queueUserMessage: (text, images, options) => {
    const state = get();
    const sessionKey = resolveVisibleGoalSubmissionSessionKey(state);
    const visibleGoalCreationAuthorization =
      visibleGoalSubmissionAuthorizationBroker.consume({
        envelope: options?.visibleGoalSubmissionEnvelope,
        text,
        sessionKey,
      });
    const goalCreationAuthorization = visibleGoalCreationAuthorization ||
      (isGoalCreationAuthorization(options?.goalCreationAuthorization)
        ? options.goalCreationAuthorization
        : undefined);
    const goalContinuationAuthorization =
      isGoalContinuationAuthorization(options?.goalContinuationAuthorization)
        ? options.goalContinuationAuthorization
        : undefined;
    const queued = normalizeQueuedUserMessage({
      id: `queued-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      sessionKey,
      text,
      images,
      contextMentions: options?.contextMentions,
      attachedFiles: options?.attachedFiles,
      runtimeIntentOverride: options?.runtimeIntentOverride,
      goalSourceContextSnapshot: options?.goalSourceContextSnapshot,
      goalCreationAuthorization,
      goalContinuationAuthorization,
      goalContinuationGuidance:
        goalContinuationAuthorization && options?.goalContinuationGuidance?.trim()
          ? options.goalContinuationGuidance.trim()
          : undefined,
      createdAt: Date.now(),
      status: "queued",
    });
    if (!queued) return null;
    const replacedQueueId = state.queuedUserMessage?.id || null;
    const removal = buildQueuedGoalContinuationRemovalPatch(
      state,
      state.queuedUserMessage,
      "replaced",
      "queue_replaced",
    );
    set({
      ...removal.patch,
      queuedUserMessage: queued,
    });
    if (removal.decisionReason === "orphaned_before_run_lease") {
      logStoreEvent("queued_goal_continuation_orphan_rolled_back", {
        goalId: removal.goalId,
        mode: "replaced",
        replacementQueueId: queued.id,
        leaseReason: removal.leaseReason || null,
      });
    }
    logStoreEvent("queued_user_message_set", {
      queueId: queued.id,
      queuePolicy: "single_slot_latest_wins",
      replacedQueueId,
      chars: queued.text.length,
      images: queued.images?.length || 0,
      contextMentions: queued.contextMentions?.length || 0,
      attachedFiles: queued.attachedFiles?.length || 0,
      runtimeIntentOverride: queued.runtimeIntentOverride || null,
      goalSourceContextChars: queued.goalSourceContextSnapshot?.length || 0,
      goalCreationAuthorizationSource: queued.goalCreationAuthorization?.source || null,
      goalContinuationAuthorizationSource:
        queued.goalContinuationAuthorization?.source || null,
      goalContinuationGuidanceChars: queued.goalContinuationGuidance?.length || 0,
      visibleGoalSubmissionEnvelopeConsumed: !!visibleGoalCreationAuthorization,
    });
    return queued;
  },
  clearQueuedUserMessage: (options) => {
    const state = get();
    const queuedMessage = state.queuedUserMessage;
    if (!queuedMessage) return false;
    if (options?.expectedId && queuedMessage.id !== options.expectedId) {
      logStoreEvent("queued_user_message_clear_identity_mismatch", {
        expectedId: options.expectedId,
        activeId: queuedMessage.id,
      });
      return false;
    }
    const disposition = options?.disposition || "discarded";
    const removal = buildQueuedGoalContinuationRemovalPatch(
      state,
      queuedMessage,
      disposition,
      options?.reason || "queue_cleared",
    );
    set({
      ...removal.patch,
      queuedUserMessage: null,
    });
    if (removal.decisionReason === "orphaned_before_run_lease") {
      logStoreEvent("queued_goal_continuation_orphan_rolled_back", {
        goalId: removal.goalId,
        mode: disposition,
        queueId: queuedMessage.id,
        leaseReason: removal.leaseReason || null,
      });
    }
    logStoreEvent("queued_user_message_cleared", {
      queueId: queuedMessage.id,
      disposition,
      reason: options?.reason || null,
      goalRollbackReason: removal.decisionReason,
    });
    return true;
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
  acceptWorkspaceInstruction: async (input) => {
    let initial = get();
    const text = String(input.text || "");
    const images = Array.isArray(input.images)
      ? input.images.filter((value): value is string => typeof value === "string" && value.length > 0)
      : [];
    const contextMentions = Array.isArray(input.contextMentions)
      ? input.contextMentions.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      : [...initial.contextMentions];
    const attachedFiles = (input.attachedFiles || initial.attachedFiles)
      .map((file) => normalizeAttachedFile(file));
    if (!text.trim() && images.length === 0 && contextMentions.length === 0 && attachedFiles.length === 0) {
      return { accepted: false, reason: "empty", retryable: false };
    }

    const workspace = String(initial.currentWorkspace || "").trim();
    const scopeKey = resolveSessionWorkspaceKey(workspace);
    if (!workspace || scopeKey === GLOBAL_CHAT_KEY) {
      return { accepted: false, reason: "workspace_required", retryable: false };
    }
    const requestedAt = Date.now();
    const clientSubmissionId = String(input.clientSubmissionId || "").trim() ||
      createWorkspaceRuntimeIdentity("workspace-submission", requestedAt);
    const instructionSource = input.source || "composer";
    const originSessionId = initial.currentSessionId;
    const originSession = originSessionId == null
      ? null
      : (initial.sessionsByWorkspace[scopeKey] || []).find(
          (candidate) => candidate.id === originSessionId,
        ) || null;
    const originSessionKey = originSession
      ? resolveSessionRuntimeKey(scopeKey, originSession.id)
      : null;
    const workspaceClearBarrierWorkspace = resolveWorkspaceClearBarrierForSubmission({
      currentWorkspaceKey: scopeKey,
      submissionOriginSessionKey: originSessionKey,
    });
    if (workspaceClearBarrierWorkspace) {
      let deferredGoalContinuationAuthorization: GoalContinuationAuthorization | null = null;
      let settleDeferredAdmission!: (result: WorkspaceInstructionAcceptance) => void;
      const deferredAdmission = new Promise<WorkspaceInstructionAcceptance>((resolve) => {
        settleDeferredAdmission = resolve;
      });
      let admissionSettled = false;
      const settleOnce = (result: WorkspaceInstructionAcceptance) => {
        if (admissionSettled) return;
        admissionSettled = true;
        settleDeferredAdmission(result);
      };
      const deferred = deferSubmissionForWorkspaceClear({
        currentWorkspaceKey: scopeKey,
        submissionOriginSessionKey: originSessionKey,
        submission: {
          id: `workspace-clear-admission-${clientSubmissionId}`,
          targetSessionKey: originSessionKey,
          createdAt: requestedAt,
          replay: async () => {
            const acceptance = await get().acceptWorkspaceInstruction({
              text,
              ...(images.length > 0 ? { images: [...images] } : {}),
              contextMentions: [...contextMentions],
              attachedFiles: attachedFiles.map((file) => ({ ...file })),
              source: instructionSource,
              clientSubmissionId,
              ...(input.dispatchHints ? { dispatchHints: input.dispatchHints } : {}),
              ...(deferredGoalContinuationAuthorization
                ? {
                    goalContinuationEnvelope: goalContinuationAuthorizationBroker.issueValidated({
                      text,
                      authorization: deferredGoalContinuationAuthorization,
                    }),
                  }
                : {}),
              ...(input.remoteFeishu ? { remoteFeishu: input.remoteFeishu } : {}),
            });
            if (acceptance.accepted || !acceptance.retryable) {
              settleOnce(acceptance);
              return true;
            }
            return false;
          },
          onDiscard: (reason) => {
            if (reason === "replay_failed") {
              void get().acceptWorkspaceInstruction({
                text,
                ...(images.length > 0 ? { images: [...images] } : {}),
                contextMentions: [...contextMentions],
                attachedFiles: attachedFiles.map((file) => ({ ...file })),
                source: instructionSource,
                clientSubmissionId,
                ...(input.remoteFeishu ? { remoteFeishu: input.remoteFeishu } : {}),
                forceVisibleErrorConclusion: "workspace_clear_replay_exhausted",
              }).then(settleOnce, () => {
                settleOnce({ accepted: false, reason: "session_changed", retryable: true });
              });
              return;
            }
            settleOnce({ accepted: false, reason: "session_changed", retryable: true });
          },
        },
      });
      if (deferred.deferred) {
        // The UI envelope is a short-lived, one-shot transport capability.
        // Consume it only after the synchronous fence accepted this item, then
        // retain the exact authorization in this closure and mint a fresh
        // envelope for each replay attempt. Long clears cannot expire it.
        deferredGoalContinuationAuthorization =
          goalContinuationAuthorizationBroker.consume({
            envelope: input.goalContinuationEnvelope,
            text,
          });
        logStoreEvent("workspace_instruction_admission_deferred_for_clear", {
          workspaceKey: deferred.workspaceKey,
          clientSubmissionId,
          queuePosition: deferred.queuePosition,
          source: instructionSource,
          queuePolicy: "strict_fifo",
        });
        return deferredAdmission;
      }
    }
    let sessionId = initial.currentSessionId;
    let sessionKey = resolveSessionRuntimeKey(scopeKey, sessionId);
    let session = sessionId == null
      ? null
      : (initial.sessionsByWorkspace[scopeKey] || []).find((candidate) => candidate.id === sessionId) || null;
    if (!sessionId || !sessionKey || !session) {
      const language = initial.config.language === "en" ? "en" : "zh";
      const autoSession = buildNewSessionRecord({
        state: initial,
        scopeKey,
        affinity: initial.selectedMainModeKey === "image_studio" ? "image_studio" : "main_mode",
        language,
      });
      const autoSessionRuntimePatch = getSessionRuntimeUiPatch(
        createSessionRuntimeFromState(autoSession.runtimeSnapshot || {}),
        { resetPanels: true },
      );
      set((state) => ({
        sessionsByWorkspace: {
          ...state.sessionsByWorkspace,
          [scopeKey]: [
            autoSession,
            ...(state.sessionsByWorkspace[scopeKey] || []).map((candidate) => ({
              ...candidate,
              active: false,
            })),
          ],
        },
        activeSessionByWorkspace: {
          ...state.activeSessionByWorkspace,
          [scopeKey]: autoSession.id,
        },
        currentSessionId: autoSession.id,
        ...autoSessionRuntimePatch,
        // Composer evidence and its one-shot intent belong to the submission
        // that is creating this Session. Preserve them until admission has
        // captured the exact payload/capability and the UI performs its
        // acceptance CAS cleanup.
        input: state.input,
        contextMentions: state.contextMentions,
        attachedFiles: state.attachedFiles,
        lockedComposerIntent: state.lockedComposerIntent,
      }));
      initial = get();
      sessionId = autoSession.id;
      sessionKey = resolveSessionRuntimeKey(scopeKey, sessionId);
      session = autoSession;
    }
    if (!sessionKey || !session) {
      return { accepted: false, reason: "session_required", retryable: true };
    }
    if (resolveWorkspaceClearBarrierForSubmission({
      currentWorkspaceKey: scopeKey,
      submissionOriginSessionKey: sessionKey,
    })) {
      return { accepted: false, reason: "session_changed", retryable: true };
    }

    if (input.forceVisibleErrorConclusion === "workspace_clear_replay_exhausted") {
      const sessionEpoch = String(session.planLifecycleEpoch || "").trim();
      if (!sessionEpoch) {
        return { accepted: false, reason: "session_changed", retryable: true };
      }
      const existing = initial.workspaceInstructionLedger.find(
        (entry) => entry.clientSubmissionId === clientSubmissionId,
      );
      if (existing) {
        return {
          accepted: true,
          receipt: existing.receipt,
          disposition: "duplicate",
          durability: "memory",
          queuePosition: 0,
        };
      }
      const concludedAt = Date.now();
      const turnId = createWorkspaceRuntimeIdentity("turn", concludedAt);
      const userBlockId = initial._nextTaskId();
      const finalBlockId = initial._nextTaskId();
      const receipt: WorkspaceInstructionReceipt = {
        schemaVersion: WORKSPACE_INSTRUCTION_SCHEMA_VERSION,
        kind: "workspace_turn_receipt",
        receiptId: createWorkspaceRuntimeIdentity("workspace-receipt", concludedAt),
        clientSubmissionId,
        sessionKey,
        sessionEpoch,
        turnId,
        userBlockId,
        acceptedAt: concludedAt,
      };
      const summary = initial.config.language === "en"
        ? "MAIN could not safely replay this instruction after workspace history clearing. The instruction was preserved as a Turn and closed with a visible error; retrying creates a new Turn."
        : "工作区历史清理后，MAIN 无法安全重放这条指令。该指令已保留为独立回合并以可见错误结论收口；重试会创建新的回合。";
      const runId = `run-clear-replay-${turnId}`;
      const payloadIdentity = buildWorkspaceInstructionPayloadIdentity({
        text,
        images,
        contextMentions,
        attachedFiles,
        source: instructionSource,
      });
      let terminalized = false;
      set((state) => {
        const activeSessionKey = resolveSessionRuntimeKey(
          resolveSessionWorkspaceKey(state.currentWorkspace),
          state.currentSessionId,
        );
        const activeSession = (state.sessionsByWorkspace[scopeKey] || []).find(
          (candidate) => candidate.id === sessionId,
        );
        if (
          activeSessionKey !== sessionKey ||
          !activeSession ||
          String(activeSession.planLifecycleEpoch || "").trim() !== sessionEpoch ||
          state.workspaceInstructionLedger.some(
            (entry) => entry.clientSubmissionId === clientSubmissionId,
          )
        ) return {};
        const userContextItems = buildWorkspaceInstructionUserContext({
          contextMentions,
          attachedFiles,
          images,
          workspace,
          language: state.config.language === "en" ? "en" : "zh",
        });
        let runtimeEvents = appendRuntimeEvent(state.runtimeEvents, withEventSchema({
          type: "run.started",
          threadId: sessionKey,
          turnId,
          timestampMs: concludedAt,
          runId,
          parentRunId: null,
        }));
        runtimeEvents = appendRuntimeEvent(runtimeEvents, withEventSchema({
          type: "run.completed",
          threadId: sessionKey,
          turnId,
          timestampMs: concludedAt,
          runId,
          parentRunId: null,
          resultKind: "error",
          summary,
        }));
        runtimeEvents = appendRuntimeEvent(runtimeEvents, withEventSchema({
          type: "turn.completed",
          threadId: sessionKey,
          turnId,
          timestampMs: concludedAt,
          resultKind: "error",
        }));
        const conversationTurns = [...state.conversationTurns, {
          id: turnId,
          clientSubmissionId,
          workspaceInstructionReceiptId: receipt.receiptId,
          workspaceInstructionSource: instructionSource,
          userPrompt: text,
          title: normalizeConversationDisplayTitle(
            text,
            state.config.language === "en" ? 48 : 40,
            state.config.language === "en" ? "Workspace instruction" : "工作区指令",
          ),
          intentSummary: summary,
          mode: "chat" as const,
          intent: "respond" as const,
          displayIntent: "respond" as const,
          status: "error" as const,
          summary,
          blockIds: [userBlockId, finalBlockId],
          processCollapsed: false,
          collapsed: false,
          createdAt: concludedAt,
          runtimeOutcome: {
            status: "completed" as const,
            reason: "workspace_clear_replay_exhausted",
            resultKind: "error" as const,
            runId,
            parentRunId: null,
            updatedAt: concludedAt,
          },
        }];
        const transcriptMetadata = resolveSessionTranscriptPageMetadata({
          loadedTurns: conversationTurns.length,
          totalTurns: Math.max(
            state.conversationTurns.length,
            Number(state.transcriptLoadedTurns) || 0,
            Number(state.transcriptTotalTurns) || 0,
          ) + 1,
          hasMore: state.transcriptPartial === true,
        });
        terminalized = true;
        return {
          workspaceInstructionLedger: [
            ...state.workspaceInstructionLedger,
            { clientSubmissionId, payloadIdentity, receipt },
          ],
          taskFlow: [
            ...state.taskFlow,
            {
              id: userBlockId,
              turnId,
              type: "user" as const,
              content: text,
              ...(images.length > 0 ? { images: [...images] } : {}),
              ...(userContextItems.length > 0 ? { contextItems: userContextItems } : {}),
            },
            {
              id: finalBlockId,
              turnId,
              type: "agent" as const,
              content: summary,
              streaming: false,
              visibility: "assistant_final" as const,
            },
          ],
          runtimeEvents,
          conversationTurns,
          currentTurnId: turnId,
          ...transcriptMetadata,
        };
      });
      if (!terminalized) {
        return { accepted: false, reason: "session_changed", retryable: true };
      }
      logStoreEvent("workspace_clear_submission_memory_terminalized", {
        sessionKey,
        sessionEpoch,
        clientSubmissionId,
        receiptId: receipt.receiptId,
        turnId,
        durability: "memory",
        resultKind: "error",
      });
      return {
        accepted: true,
        receipt,
        disposition: "admitted",
        durability: "memory",
        queuePosition: 0,
      };
    }

    const initialSessionEpoch = String(session.planLifecycleEpoch || "").trim();
    const admissionReadiness = await waitForSessionAdmissionReadiness({
      sessionKey,
      sessionEpoch: initialSessionEpoch,
    });
    initial = get();
    const readySessionKey = resolveSessionRuntimeKey(
      resolveSessionWorkspaceKey(initial.currentWorkspace),
      initial.currentSessionId,
    );
    session = (initial.sessionsByWorkspace[scopeKey] || []).find(
      (candidate) => candidate.id === sessionId,
    ) || null;
    if (
      admissionReadiness !== "ready" ||
      readySessionKey !== sessionKey ||
      !session ||
      String(session.planLifecycleEpoch || "").trim() !== initialSessionEpoch
    ) {
      return { accepted: false, reason: "session_changed", retryable: true };
    }

    const submittedAt = Date.now();
    const payloadIdentity = buildWorkspaceInstructionPayloadIdentity({
      text,
      images,
      contextMentions,
      attachedFiles,
      source: instructionSource,
      dispatchHints: input.dispatchHints,
      remoteContext: input.remoteFeishu,
    });
    const admissionIdentityKey = JSON.stringify([sessionKey, clientSubmissionId]);
    const existingLedgerEntry = initial.workspaceInstructionLedger.find(
      (entry) => entry.clientSubmissionId === clientSubmissionId,
    );
    const duplicateTurn = initial.conversationTurns.find(
      (turn) => turn.clientSubmissionId === clientSubmissionId,
    );
    if (existingLedgerEntry || duplicateTurn) {
      if (
        (existingLedgerEntry && existingLedgerEntry.payloadIdentity !== payloadIdentity) ||
        (!existingLedgerEntry && duplicateTurn?.userPrompt !== text)
      ) {
        return { accepted: false, reason: "admission_conflict", retryable: false };
      }
      const inFlight = workspaceInstructionAdmissionsByIdentity.get(admissionIdentityKey);
      if (inFlight) {
        const settled = await inFlight;
        return settled.accepted
          ? { ...settled, disposition: "duplicate" as const }
          : settled;
      }
      const existingEntry = initial.workspaceTurnQueue?.entries.find(
        (entry) => entry.instruction.clientSubmissionId === clientSubmissionId,
      );
      const durableReceipt = existingLedgerEntry?.receipt || existingEntry?.receipt;
      const duplicateUserBlock = durableReceipt
        ? null
        : duplicateTurn!.blockIds
          .map((blockId) => initial.taskFlow.find((block) => block.id === blockId))
          .find((block) => block?.type === "user" && block.turnId === duplicateTurn!.id);
      if (!durableReceipt && (!duplicateUserBlock || duplicateUserBlock.type !== "user")) {
        return { accepted: false, reason: "admission_conflict", retryable: false };
      }
      const receipt: WorkspaceInstructionReceipt = durableReceipt || {
          schemaVersion: WORKSPACE_INSTRUCTION_SCHEMA_VERSION,
          kind: "workspace_turn_receipt",
          receiptId: duplicateTurn!.workspaceInstructionReceiptId ||
            createWorkspaceRuntimeIdentity("workspace-receipt", duplicateTurn!.createdAt),
          clientSubmissionId,
          sessionKey,
          sessionEpoch: String(session.planLifecycleEpoch || initial.planLifecycle.sessionEpoch || ""),
          turnId: duplicateTurn!.id,
          userBlockId: duplicateUserBlock!.id,
          acceptedAt: duplicateTurn!.createdAt,
        };
      return {
        accepted: true,
        receipt,
        disposition: "duplicate",
        durability: session.recordingDisabled || !initial.config.sessionRecordingEnabled
          ? "memory"
          : "session",
        queuePosition: existingEntry
          ? Math.max(1, (initial.workspaceTurnQueue?.entries.indexOf(existingEntry) ?? 0) + 1)
          : 0,
      };
    }

    const visibleGoalEnvelope = initial.captureVisibleGoalSubmissionEnvelope(text);
    const goalCreationAuthorization = visibleGoalSubmissionAuthorizationBroker.consume({
      envelope: visibleGoalEnvelope,
      text,
      sessionKey,
    });
    const goalContinuationAuthorization = goalContinuationAuthorizationBroker.consume({
      envelope: input.goalContinuationEnvelope,
      text,
    });
    let admissionAuthorizationsSettled = false;
    const restoreAdmissionAuthorizations = () => {
      if (admissionAuthorizationsSettled) return;
      admissionAuthorizationsSettled = true;
      if (goalCreationAuthorization) {
        visibleGoalSubmissionAuthorizationBroker.restoreConsumed({
          envelope: visibleGoalEnvelope,
          text,
          sessionKey,
          authorization: goalCreationAuthorization,
        });
      }
      if (goalContinuationAuthorization) {
        goalContinuationAuthorizationBroker.restoreConsumed({
          envelope: input.goalContinuationEnvelope,
          text,
          authorization: goalContinuationAuthorization,
        });
      }
    };
    const commitAdmissionAuthorizations = () => {
      admissionAuthorizationsSettled = true;
    };
    let dispatchHints: WorkspaceJsonObject;
    try {
      dispatchHints = JSON.parse(JSON.stringify({
        ...(input.dispatchHints || {}),
        ...(goalCreationAuthorization ? { goalCreationAuthorization } : {}),
        ...(goalContinuationAuthorization ? { goalContinuationAuthorization } : {}),
        ...(input.remoteFeishu ? { remoteFeishu: input.remoteFeishu } : {}),
      })) as WorkspaceJsonObject;
    } catch {
      restoreAdmissionAuthorizations();
      return { accepted: false, reason: "admission_conflict", retryable: false };
    }

    let receipt: WorkspaceInstructionReceipt | null = null;
    let queuePosition = 0;
    let admissionEpoch = String(session.planLifecycleEpoch || "").trim();
    let admissionApplied = false;
    set((state) => {
      const activeSessionKey = resolveSessionRuntimeKey(
        resolveSessionWorkspaceKey(state.currentWorkspace),
        state.currentSessionId,
      );
      if (activeSessionKey !== sessionKey) return {};
      const activeSession = (state.sessionsByWorkspace[scopeKey] || []).find(
        (candidate) => candidate.id === sessionId,
      );
      if (!activeSession) return {};
      admissionEpoch = String(activeSession.planLifecycleEpoch || admissionEpoch).trim() ||
        createPlanLifecycleSessionEpoch(submittedAt);
      const currentQueue = state.workspaceTurnQueue?.sessionKey === sessionKey &&
        state.workspaceTurnQueue.sessionEpoch === admissionEpoch
        ? state.workspaceTurnQueue
        : createWorkspaceTurnQueueState({
            sessionKey,
            sessionEpoch: admissionEpoch,
            updatedAt: submittedAt,
          });
      const turnId = createWorkspaceRuntimeIdentity("turn", submittedAt);
      const userBlockId = state._nextTaskId();
      const nextReceipt: WorkspaceInstructionReceipt = {
        schemaVersion: WORKSPACE_INSTRUCTION_SCHEMA_VERSION,
        kind: "workspace_turn_receipt",
        receiptId: createWorkspaceRuntimeIdentity("workspace-receipt", submittedAt),
        clientSubmissionId,
        sessionKey,
        sessionEpoch: admissionEpoch,
        turnId,
        userBlockId,
        acceptedAt: submittedAt,
      };
      const instruction: WorkspaceInstruction = {
        schemaVersion: WORKSPACE_INSTRUCTION_SCHEMA_VERSION,
        kind: "workspace_instruction",
        clientSubmissionId,
        sessionKey,
        sessionEpoch: admissionEpoch,
        source: instructionSource,
        submittedAt,
        payload: {
          text,
          ...(images.length > 0 ? { images } : {}),
          ...(contextMentions.length > 0 ? { contextMentions } : {}),
          ...(attachedFiles.length > 0 ? { attachedFiles } : {}),
          ...(Object.keys(dispatchHints).length > 0 ? { dispatchHints } : {}),
        },
      };
      const appended = reduceWorkspaceTurnQueue(currentQueue, {
        type: "append",
        expectedVersion: currentQueue.version,
        at: submittedAt,
        instruction,
        receipt: nextReceipt,
      });
      if (appended.disposition !== "applied") return {};

      const language = state.config.language === "en" ? "en" : "zh";
      const userContextItems = buildWorkspaceInstructionUserContext({
        contextMentions,
        attachedFiles,
        images,
        workspace,
        language,
      });
      const userBlock: TaskBlock = {
        id: userBlockId,
        turnId,
        type: "user",
        content: text,
        ...(images.length > 0 ? { images: [...images] } : {}),
        ...(userContextItems.length > 0 ? { contextItems: userContextItems } : {}),
      };
      const turn = buildWorkspaceInstructionConversationTurn({
        instruction,
        receipt: nextReceipt,
        language,
        blockIds: [userBlockId],
      });
      const conversationTurns = [...state.conversationTurns, turn];
      const transcriptMetadata = resolveSessionTranscriptPageMetadata({
        loadedTurns: conversationTurns.length,
        totalTurns: Math.max(
          state.conversationTurns.length,
          Number(state.transcriptLoadedTurns) || 0,
          Number(state.transcriptTotalTurns) || 0,
        ) + 1,
        hasMore: state.transcriptPartial === true,
      });
      receipt = nextReceipt;
      queuePosition = appended.state.entries.length;
      admissionApplied = true;
      const ledgerEntry: WorkspaceInstructionLedgerEntry = {
        clientSubmissionId,
        payloadIdentity,
        receipt: nextReceipt,
      };
      return {
        workspaceTurnQueue: appended.state,
        workspaceInstructionLedger: [
          ...state.workspaceInstructionLedger,
          ledgerEntry,
        ],
        taskFlow: [...state.taskFlow, userBlock],
        conversationTurns,
        ...transcriptMetadata,
        sessionsByWorkspace: activeSession.planLifecycleEpoch
          ? state.sessionsByWorkspace
          : {
              ...state.sessionsByWorkspace,
              [scopeKey]: (state.sessionsByWorkspace[scopeKey] || []).map((candidate) =>
                candidate.id === sessionId
                  ? { ...candidate, planLifecycleEpoch: admissionEpoch }
                  : candidate
              ),
            },
      };
    });

    if (!admissionApplied || !receipt) {
      restoreAdmissionAuthorizations();
      return { accepted: false, reason: "session_changed", retryable: true };
    }
    const admittedReceipt = receipt as WorkspaceInstructionReceipt;

    const persistOwnerProjection = async (): Promise<"session" | "memory"> => {
      const latest = get();
      const ownerSession = (latest.sessionsByWorkspace[scopeKey] || []).find(
        (candidate) => candidate.id === sessionId,
      );
      if (!ownerSession || ownerSession.planLifecycleEpoch !== admissionEpoch) {
        throw new Error("workspace instruction Session owner changed before persistence");
      }
      const ownerRuntime = isSessionRuntimeActive(latest, sessionKey)
        ? createSessionRuntimeFromState(latest)
        : latest.runtimeBySessionKey[sessionKey];
      if (!ownerRuntime) {
        throw new Error("workspace instruction runtime owner disappeared before persistence");
      }
      const ownerQueue = ownerRuntime.workspaceTurnQueue;
      const exactPersistingEntry = ownerQueue?.entries.find((entry) =>
        entry.receipt.receiptId === admittedReceipt.receiptId &&
        entry.instruction.clientSubmissionId === clientSubmissionId &&
        entry.status === "persisting"
      );
      if (!ownerQueue || !exactPersistingEntry) {
        throw new Error("workspace instruction persistence owner is no longer exact");
      }
      // Concurrent callers may already have materialized later persisting
      // placeholders in memory. They are not durable yet and must never hitch
      // a ride in this transaction's snapshot.
      const excludedPendingTurnIds = new Set(
        ownerQueue.entries
          .filter((entry) =>
            entry.status === "persisting" &&
            entry.receipt.receiptId !== admittedReceipt.receiptId
          )
          .map((entry) => entry.receipt.turnId),
      );
      const persistenceRuntimeBase: SessionRuntimeState = excludedPendingTurnIds.size === 0
        ? ownerRuntime
        : {
            ...ownerRuntime,
            workspaceTurnQueue: {
              ...ownerQueue,
              entries: ownerQueue.entries.filter((entry) =>
                !excludedPendingTurnIds.has(entry.receipt.turnId)
              ),
            },
            workspaceInstructionLedger: ownerRuntime.workspaceInstructionLedger.filter((entry) =>
              !excludedPendingTurnIds.has(entry.receipt.turnId)
            ),
            taskFlow: ownerRuntime.taskFlow.filter((block) =>
              !block.turnId || !excludedPendingTurnIds.has(block.turnId)
            ),
            conversationTurns: ownerRuntime.conversationTurns.filter((turn) =>
              !excludedPendingTurnIds.has(turn.id)
            ),
          };
      const omittedLoadedTurnCount = Math.max(
        0,
        ownerRuntime.conversationTurns.length - persistenceRuntimeBase.conversationTurns.length,
      );
      const persistenceTranscriptMetadata = resolveSessionTranscriptPageMetadata({
        loadedTurns: persistenceRuntimeBase.conversationTurns.length,
        totalTurns: Math.max(
          ownerRuntime.conversationTurns.length,
          Number(ownerRuntime.transcriptLoadedTurns) || 0,
          Number(ownerRuntime.transcriptTotalTurns) || 0,
        ) - omittedLoadedTurnCount,
        hasMore: ownerRuntime.transcriptPartial === true,
      });
      const persistenceRuntime: SessionRuntimeState = {
        ...persistenceRuntimeBase,
        ...persistenceTranscriptMetadata,
      };
      const runtimeSnapshot = sanitizeSessionRuntimeSnapshotForPersist(
        buildSessionRuntimeSnapshotFromStoreState({
          ...latest,
          ...persistenceRuntime,
          currentWorkspace: scopeKey,
          currentSessionId: sessionId,
        }),
      );
      const messages = sanitizeTaskBlocksForPersist(persistenceRuntime.taskFlow || []);
      const updatedAtMs = Date.now();
      const sessionRecord: Session = {
        ...ownerSession,
        messages,
        runtimeSnapshot,
        ...persistenceTranscriptMetadata,
        updatedAt: new Date(updatedAtMs).toISOString(),
        updatedAtMs,
        storageStatus: latest.config.sessionRecordingEnabled && ownerSession.recordingDisabled !== true
          ? "ok"
          : "temporary",
        recordingDisabled: !latest.config.sessionRecordingEnabled || ownerSession.recordingDisabled === true,
      };
      const persistedProjectionIdentity = JSON.stringify({
        messages,
        runtimeSnapshot,
        transcriptPartial: sessionRecord.transcriptPartial === true,
        transcriptLoadedTurns: sessionRecord.transcriptLoadedTurns || 0,
        transcriptTotalTurns: sessionRecord.transcriptTotalTurns || 0,
      });
      if (!latest.config.sessionRecordingEnabled || ownerSession.recordingDisabled === true) {
        get().updateSession(scopeKey, sessionId, sessionRecord);
        return "memory";
      }
      const saved = await saveProjectSession(scopeKey, sessionRecord, {
        allowPersistingWorkspaceReceiptId: admittedReceipt.receiptId,
      });
      const postSave = get();
      const currentOwner = (postSave.sessionsByWorkspace[scopeKey] || []).find(
        (candidate) => candidate.id === sessionId,
      );
      if (currentOwner?.planLifecycleEpoch === admissionEpoch) {
        const currentRuntime = isSessionRuntimeActive(postSave, sessionKey)
          ? createSessionRuntimeFromState(postSave)
          : postSave.runtimeBySessionKey[sessionKey];
        const currentRuntimeSnapshot = currentRuntime
          ? sanitizeSessionRuntimeSnapshotForPersist(
              buildSessionRuntimeSnapshotFromStoreState({
                ...postSave,
                ...currentRuntime,
                currentWorkspace: scopeKey,
                currentSessionId: sessionId,
              }),
            )
          : null;
        const currentProjectionIdentity = currentRuntime && currentRuntimeSnapshot
          ? JSON.stringify({
              messages: sanitizeTaskBlocksForPersist(currentRuntime.taskFlow || []),
              runtimeSnapshot: currentRuntimeSnapshot,
              transcriptPartial: currentRuntime.transcriptPartial === true,
              transcriptLoadedTurns: Math.max(
                0,
                Number(currentRuntime.transcriptLoadedTurns) || currentRuntime.conversationTurns.length,
              ),
              transcriptTotalTurns: Math.max(
                currentRuntime.conversationTurns.length,
                Number(currentRuntime.transcriptTotalTurns) || 0,
              ),
            })
          : "";
        const projectionStillCurrent =
          currentProjectionIdentity === persistedProjectionIdentity;
        const recordingStillEnabled =
          postSave.config.sessionRecordingEnabled && currentOwner.recordingDisabled !== true;
        const savedProjection = saved && typeof saved === "object"
          ? saved as Partial<Session>
          : {};
        if (projectionStillCurrent && recordingStillEnabled) {
          const savedUpdatedAtMs = Number(savedProjection.updatedAtMs) ||
            (typeof savedProjection.updatedAt === "string"
              ? Date.parse(savedProjection.updatedAt)
              : Number(savedProjection.updatedAt)) ||
            Number(sessionRecord.updatedAtMs) || 0;
          const currentUpdatedAtMs = Number(currentOwner.updatedAtMs) ||
            (typeof currentOwner.updatedAt === "string"
              ? Date.parse(currentOwner.updatedAt)
              : Number(currentOwner.updatedAt)) ||
            0;
          const keepCurrentTimestamp = currentUpdatedAtMs > savedUpdatedAtMs;
          // The disk writer owns transcript/runtime persistence fields only.
          // Keep the live Session container's title, active flag, mode
          // affinity, and any newer timestamp written while I/O was pending.
          get().updateSession(scopeKey, sessionId, {
            messages,
            runtimeSnapshot,
            transcriptPartial: savedProjection.transcriptPartial ?? sessionRecord.transcriptPartial,
            transcriptLoadedTurns:
              savedProjection.transcriptLoadedTurns ?? sessionRecord.transcriptLoadedTurns,
            transcriptTotalTurns:
              savedProjection.transcriptTotalTurns ?? sessionRecord.transcriptTotalTurns,
            ...(typeof savedProjection.turnCount === "number"
              ? { turnCount: savedProjection.turnCount }
              : {}),
            ...(typeof savedProjection.messageCount === "number"
              ? { messageCount: savedProjection.messageCount }
              : {}),
            ...(typeof savedProjection.storageRevision === "number"
              ? { storageRevision: savedProjection.storageRevision }
              : {}),
            updatedAt: keepCurrentTimestamp
              ? currentOwner.updatedAt
              : savedProjection.updatedAt ?? sessionRecord.updatedAt,
            updatedAtMs: keepCurrentTimestamp
              ? currentOwner.updatedAtMs
              : savedProjection.updatedAtMs ?? sessionRecord.updatedAtMs,
            ...(typeof savedProjection.workspaceRoot === "string"
              ? { workspaceRoot: savedProjection.workspaceRoot }
              : {}),
            ...(typeof savedProjection.projectId === "string"
              ? { projectId: savedProjection.projectId }
              : {}),
            storageStatus: "ok",
            recordingDisabled: false,
          });
        } else {
          logStoreEvent("workspace_instruction_persistence_ack_stale", {
            sessionKey,
            sessionEpoch: admissionEpoch,
            receiptId: admittedReceipt.receiptId,
            projectionStillCurrent,
            recordingStillEnabled,
          });
        }
      }
      return "session";
    };

    const admissionPromise = enqueueWorkspaceInstructionAdmission(sessionKey, async () => {
      let durability: "session" | "memory";
      try {
        durability = await persistOwnerProjection();
        // The one-shot capabilities are now part of the durable (or explicitly
        // memory-only) queue projection. From this point a retry must resolve
        // through the receipt ledger, never by restoring the UI envelope.
        commitAdmissionAuthorizations();
      } catch (error) {
        const failureSummary = get().config.language === "en"
          ? "MAIN accepted this workspace instruction, but durable Session recording failed. The Turn was closed with a visible error; retrying creates a new Turn."
          : "MAIN 已接纳这条工作区指令，但 Session 持久化失败。本回合已以可见错误结论收口；重试会创建新的回合。";
        let memoryTerminalized = false;
        set((state) => {
          const ownerActive = isSessionRuntimeActive(state, sessionKey);
          const ownerRuntime = ownerActive
            ? createSessionRuntimeFromState(state)
            : state.runtimeBySessionKey[sessionKey];
          const ownerQueue = ownerRuntime?.workspaceTurnQueue;
          if (!ownerRuntime || !ownerQueue) return {};
          const rolledBack = reduceWorkspaceTurnQueue(ownerQueue, {
            type: "rollback",
            expectedVersion: ownerQueue.version,
            at: Date.now(),
            clientSubmissionId,
            receiptId: admittedReceipt.receiptId,
            sessionKey,
            sessionEpoch: admissionEpoch,
          });
          if (rolledBack.disposition !== "applied") return {};
          const ownedTurn = ownerRuntime.conversationTurns.find((turn) =>
            turn.id === admittedReceipt.turnId &&
            turn.clientSubmissionId === clientSubmissionId &&
            turn.workspaceInstructionReceiptId === admittedReceipt.receiptId
          );
          const ownedUserBlock = ownerRuntime.taskFlow.find((block) =>
            block.id === admittedReceipt.userBlockId &&
            block.turnId === admittedReceipt.turnId &&
            block.type === "user"
          );
          if (!ownedTurn || !ownedUserBlock) return {};
          const timestampMs = Date.now();
          const runId = `run-admission-persistence-${admittedReceipt.turnId}`;
          const finalBlockId = state._nextTaskId();
          let runtimeEvents = appendRuntimeEvent(ownerRuntime.runtimeEvents, withEventSchema({
            type: "run.started",
            threadId: sessionKey,
            turnId: admittedReceipt.turnId,
            timestampMs,
            runId,
            parentRunId: null,
          }));
          runtimeEvents = appendRuntimeEvent(runtimeEvents, withEventSchema({
            type: "run.completed",
            threadId: sessionKey,
            turnId: admittedReceipt.turnId,
            timestampMs,
            runId,
            parentRunId: null,
            resultKind: "error",
            summary: failureSummary,
          }));
          runtimeEvents = appendRuntimeEvent(runtimeEvents, withEventSchema({
            type: "turn.completed",
            threadId: sessionKey,
            turnId: admittedReceipt.turnId,
            timestampMs,
            resultKind: "error",
          }));
          const conversationTurns = ownerRuntime.conversationTurns.map((turn) =>
            turn.id === admittedReceipt.turnId &&
              turn.clientSubmissionId === clientSubmissionId &&
              turn.workspaceInstructionReceiptId === admittedReceipt.receiptId
              ? {
                  ...turn,
                  status: "error" as const,
                  summary: failureSummary,
                  blockIds: turn.blockIds.includes(finalBlockId)
                    ? turn.blockIds
                    : [...turn.blockIds, finalBlockId],
                  runtimeOutcome: {
                    status: "completed" as const,
                    reason: "workspace_instruction_persistence_failed",
                    resultKind: "error" as const,
                    runId,
                    parentRunId: null,
                    updatedAt: timestampMs,
                  },
                }
              : turn
          );
          const runtimePatch = {
            workspaceTurnQueue: rolledBack.state,
            // Keep the receipt ledger in memory so a client retry with the
            // same id resolves to this exact concluded Turn instead of
            // materializing a duplicate after the failed durable write.
            workspaceInstructionLedger: ownerRuntime.workspaceInstructionLedger,
            taskFlow: [
              ...ownerRuntime.taskFlow,
              {
                id: finalBlockId,
                turnId: admittedReceipt.turnId,
                type: "agent" as const,
                content: failureSummary,
                streaming: false,
                visibility: "assistant_final" as const,
              },
            ],
            runtimeEvents,
            conversationTurns,
            transcriptLoadedTurns: Math.max(
              ownerRuntime.transcriptLoadedTurns,
              conversationTurns.length,
            ),
            transcriptTotalTurns: Math.max(
              ownerRuntime.transcriptTotalTurns,
              conversationTurns.length,
            ),
          };
          memoryTerminalized = true;
          return ownerActive
            ? runtimePatch
            : {
                runtimeBySessionKey: {
                  ...state.runtimeBySessionKey,
                  [sessionKey]: { ...ownerRuntime, ...runtimePatch },
                },
              };
        });
        logStoreEvent("workspace_instruction_admission_rolled_back", {
          sessionKey,
          sessionEpoch: admissionEpoch,
          clientSubmissionId,
          receiptId: admittedReceipt.receiptId,
          error: error instanceof Error ? error.message : String(error),
          memoryTerminalized,
        });
        if (memoryTerminalized) {
          commitAdmissionAuthorizations();
          logStoreEvent("workspace_instruction_admission_memory_terminalized", {
            sessionKey,
            sessionEpoch: admissionEpoch,
            clientSubmissionId,
            receiptId: admittedReceipt.receiptId,
            turnId: admittedReceipt.turnId,
            durability: "memory",
            resultKind: "error",
          });
          runAfterNextPaint(() => get().dispatchNextWorkspaceInstruction(sessionKey));
          return {
            accepted: true,
            receipt: admittedReceipt,
            disposition: "admitted",
            durability: "memory",
            queuePosition: 0,
          } as const;
        }
        restoreAdmissionAuthorizations();
        return { accepted: false, reason: "persistence_failed", retryable: true } as const;
      }

      let committed = false;
      set((state) => {
        const ownerActive = isSessionRuntimeActive(state, sessionKey);
        const ownerRuntime = ownerActive
          ? createSessionRuntimeFromState(state)
          : state.runtimeBySessionKey[sessionKey];
        const ownerQueue = ownerRuntime?.workspaceTurnQueue;
        if (!ownerRuntime || !ownerQueue) return {};
        const transition = reduceWorkspaceTurnQueue(ownerQueue, {
          type: "commit",
          expectedVersion: ownerQueue.version,
          at: Date.now(),
          clientSubmissionId,
          receiptId: admittedReceipt.receiptId,
          sessionKey,
          sessionEpoch: admissionEpoch,
        });
        if (transition.disposition === "rejected") return {};
        committed = true;
        return ownerActive
          ? { workspaceTurnQueue: transition.state }
          : {
              runtimeBySessionKey: {
                ...state.runtimeBySessionKey,
                [sessionKey]: { ...ownerRuntime, workspaceTurnQueue: transition.state },
              },
            };
      });
      if (!committed) {
        logStoreEvent("workspace_instruction_admitted_restore_pending", {
          sessionKey,
          sessionEpoch: admissionEpoch,
          clientSubmissionId,
          receiptId: admittedReceipt.receiptId,
          turnId: admittedReceipt.turnId,
          queuePosition,
          durability,
        });
        // Persistence is the admission commit point. The durable `persisting`
        // entry is intentionally reconciled to `queued` on the next exact
        // Session restore, so a UI owner switch must not tell the caller to
        // resend and create a second Turn.
        return {
          accepted: true,
          receipt: admittedReceipt,
          disposition: "admitted",
          durability,
          queuePosition,
        } as const;
      }
      logStoreEvent("workspace_instruction_admitted", {
        sessionKey,
        sessionEpoch: admissionEpoch,
        clientSubmissionId,
        receiptId: admittedReceipt.receiptId,
        turnId: admittedReceipt.turnId,
        queuePosition,
        durability,
      });
      runAfterNextPaint(() => {
        get().dispatchNextWorkspaceInstruction(sessionKey);
      });
      return {
        accepted: true,
        receipt: admittedReceipt,
        disposition: "admitted",
        durability,
        queuePosition,
      } as const;
    });
    workspaceInstructionAdmissionsByIdentity.set(admissionIdentityKey, admissionPromise);
    const clearAdmissionIdentity = () => {
      if (workspaceInstructionAdmissionsByIdentity.get(admissionIdentityKey) === admissionPromise) {
        workspaceInstructionAdmissionsByIdentity.delete(admissionIdentityKey);
      }
    };
    // Observe both outcomes directly. `finally()` would create an unobserved
    // derived rejection if an unexpected admission bug escaped the task.
    void admissionPromise.then(clearAdmissionIdentity, clearAdmissionIdentity);
    return admissionPromise;
  },
  dispatchNextWorkspaceInstruction: (expectedSessionKey) => {
    let state = get();
    const sessionKey = resolveSessionRuntimeKey(
      resolveSessionWorkspaceKey(state.currentWorkspace),
      state.currentSessionId,
    );
    if (!sessionKey || (expectedSessionKey && expectedSessionKey !== sessionKey)) return false;
    let queue = state.workspaceTurnQueue;
    if (!queue || queue.sessionKey !== sessionKey) return false;
    const deferDispatchUntilCancellationSettles = (phase: "before_claim" | "claim_race") => {
      const pendingCancellation = getPendingSessionCancellation(sessionKey);
      if (!pendingCancellation) return false;
      const fencedEntry = queue?.entries[0] || null;
      if (
        workspaceInstructionCancellationRedispatchBySession.get(sessionKey) !==
          pendingCancellation.promise
      ) {
        workspaceInstructionCancellationRedispatchBySession.set(
          sessionKey,
          pendingCancellation.promise,
        );
        void pendingCancellation.promise.then(
          (settlement) => {
            const ownsFence =
              workspaceInstructionCancellationRedispatchBySession.get(sessionKey) ===
                pendingCancellation.promise;
            if (!ownsFence) return;
            workspaceInstructionCancellationRedispatchBySession.delete(sessionKey);
            logStoreEvent("workspace_instruction_cancellation_fence_settled", {
              sessionKey,
              canceledTurnId: settlement.turnId,
              terminalSettled: settlement.terminalSettled,
              queueDisposition: settlement.queueDisposition || null,
              disposition: settlement.disposition,
            });
            if (fencedEntry) {
              const existingFailure = workspaceInstructionCancellationFailureBySession.get(
                sessionKey,
              );
              const exactFailure = !!existingFailure &&
                existingFailure.sessionEpoch === fencedEntry.receipt.sessionEpoch &&
                existingFailure.receiptId === fencedEntry.receipt.receiptId &&
                existingFailure.turnId === fencedEntry.receipt.turnId;
              if (settlement.terminalSettled || settlement.queueDisposition === "discard") {
                if (exactFailure) {
                  workspaceInstructionCancellationFailureBySession.delete(sessionKey);
                }
              } else {
                workspaceInstructionCancellationFailureBySession.set(sessionKey, {
                  sessionEpoch: fencedEntry.receipt.sessionEpoch,
                  receiptId: fencedEntry.receipt.receiptId,
                  turnId: fencedEntry.receipt.turnId,
                  disposition: settlement.disposition,
                });
              }
            }
            if (settlement.terminalSettled || settlement.queueDisposition === "discard") {
              runAfterNextPaint(() => get().dispatchNextWorkspaceInstruction(sessionKey));
              return;
            }
            // Reconciliation exhausted without a terminal cancel conclusion.
            // The fence has been released, so retry the dispatcher in an exact
            // fail-closed mode that completes the admitted Turn with a visible
            // error instead of executing it or leaving FIFO silently wedged.
            runAfterNextPaint(() => get().dispatchNextWorkspaceInstruction(sessionKey));
          },
          (error) => {
            const ownsFence =
              workspaceInstructionCancellationRedispatchBySession.get(sessionKey) ===
                pendingCancellation.promise;
            if (!ownsFence) return;
            workspaceInstructionCancellationRedispatchBySession.delete(sessionKey);
            if (fencedEntry) {
              workspaceInstructionCancellationFailureBySession.set(sessionKey, {
                sessionEpoch: fencedEntry.receipt.sessionEpoch,
                receiptId: fencedEntry.receipt.receiptId,
                turnId: fencedEntry.receipt.turnId,
                disposition: error instanceof Error ? error.message : String(error),
              });
            }
            logStoreEvent("workspace_instruction_cancellation_fence_retained", {
              sessionKey,
              canceledTurnId: pendingCancellation.turnId,
              error: error instanceof Error ? error.message : String(error),
            });
            runAfterNextPaint(() => get().dispatchNextWorkspaceInstruction(sessionKey));
          },
        );
      }
      logStoreEvent("workspace_instruction_dispatch_deferred_for_cancellation", {
        sessionKey,
        canceledTurnId: pendingCancellation.turnId,
        queuedTurnId: queue?.entries[0]?.receipt.turnId || null,
        phase,
      });
      return true;
    };

    const terminalHead = queue.entries[0];
    if (terminalHead?.status === "dispatching" && terminalHead.claim) {
      const activeLocalFastLease = localFastExecutionLeasesByClaim.get(
        terminalHead.claim.claimId,
      );
      if (
        activeLocalFastLease &&
        !activeLocalFastLease.settled &&
        activeLocalFastLease.sessionKey === sessionKey &&
        activeLocalFastLease.turnId === terminalHead.receipt.turnId &&
        activeLocalFastLease.claim?.receiptId === terminalHead.receipt.receiptId &&
        activeLocalFastLease.claim.instructionEnvelopeIdentity ===
          workspaceInstructionEnvelopeIdentity(terminalHead)
      ) {
        // A live local-fast lease has accepted the Run but has no recoverable
        // executor checkpoint. Retain its durable FIFO head until the verified
        // atomic conclusion callback removes it.
        return false;
      }
      const terminalCommand = parseGameStudioSlashCommand(
        terminalHead.instruction.payload.text,
      );
      const terminalHeadIsLocalFast = !!terminalCommand &&
        getGameStudioSlashCommandSpec(terminalCommand)?.executionMode === "local_fast";
      if (terminalHeadIsLocalFast) {
        const at = Date.now();
        const alreadyCanonical = hasCanonicalRestoredLocalFastConclusion({
          entry: terminalHead,
          sessionKey,
          taskFlow: state.taskFlow,
          conversationTurns: state.conversationTurns,
          runtimeEvents: state.runtimeEvents,
          workspacePath: resolveSessionWorkspaceKey(state.currentWorkspace),
        });
        const quarantined = alreadyCanonical
          ? {
              taskFlow: state.taskFlow,
              conversationTurns: state.conversationTurns,
              runtimeEvents: state.runtimeEvents,
              presentationTurnId: terminalHead.receipt.turnId,
            }
          : quarantineRestoredLocalFastEntry({
              entry: terminalHead,
              sessionKey,
              taskFlow: state.taskFlow,
              conversationTurns: state.conversationTurns,
              runtimeEvents: state.runtimeEvents,
              at,
              workspacePath: resolveSessionWorkspaceKey(state.currentWorkspace),
              reservedTaskBlockIds: queue.entries.map(
                (entry) => entry.receipt.userBlockId,
              ),
            });
        const canonicalAfterReconcile = hasCanonicalRestoredLocalFastConclusion({
          entry: terminalHead,
          sessionKey,
          taskFlow: quarantined.taskFlow,
          conversationTurns: quarantined.conversationTurns,
          runtimeEvents: quarantined.runtimeEvents,
          workspacePath: resolveSessionWorkspaceKey(state.currentWorkspace),
        });
        const removed = canonicalAfterReconcile
          ? reduceWorkspaceTurnQueue(queue, {
          type: "remove",
          expectedVersion: queue.version,
          at,
          claimId: terminalHead.claim.claimId,
          sessionKey: queue.sessionKey,
          sessionEpoch: queue.sessionEpoch,
          terminalOwner: {
            sessionKey: queue.sessionKey,
            sessionEpoch: queue.sessionEpoch,
            turnId: terminalHead.receipt.turnId,
            receiptId: terminalHead.receipt.receiptId,
            clientSubmissionId: terminalHead.instruction.clientSubmissionId,
            instructionEnvelopeIdentity: workspaceInstructionEnvelopeIdentity(terminalHead),
          },
        })
          : null;
        if (removed?.disposition === "applied") {
          set({
            workspaceTurnQueue: removed.state,
            taskFlow: quarantined.taskFlow,
            conversationTurns: quarantined.conversationTurns,
            runtimeEvents: quarantined.runtimeEvents,
            transcriptLoadedTurns: Math.max(
              state.transcriptLoadedTurns,
              quarantined.conversationTurns.length,
            ),
            transcriptTotalTurns: Math.max(
              state.transcriptTotalTurns,
              quarantined.conversationTurns.length,
            ),
          });
          get().saveCurrentRuntimeToSession();
          logStoreEvent("workspace_local_fast_lost_lease_quarantined", {
            sessionKey,
            receiptId: terminalHead.receipt.receiptId,
            sourceTurnId: terminalHead.receipt.turnId,
            presentationTurnId: quarantined.presentationTurnId,
            preservedCanonicalConclusion: alreadyCanonical,
          });
          queue = removed.state;
          state = get();
        } else {
          logStoreEvent("workspace_local_fast_lost_lease_quarantine_rejected", {
            sessionKey,
            receiptId: terminalHead.receipt.receiptId,
            sourceTurnId: terminalHead.receipt.turnId,
            canonicalAfterReconcile,
            queueDisposition: removed?.disposition || null,
          });
        }
      } else {
        const inspection = inspectWorkspaceInstructionTerminalProjection({
          entry: terminalHead,
          sessionKey,
          taskFlow: state.taskFlow,
          conversationTurns: state.conversationTurns,
          runtimeEvents: state.runtimeEvents,
        });
        const sourceStarts = state.runtimeEvents.filter(
          (event): event is Extract<MainThreadEvent, { type: "run.started" }> =>
            event.type === "run.started" &&
            event.threadId === sessionKey &&
            event.turnId === terminalHead.receipt.turnId,
        );
        const openSourceStarts = sourceStarts.filter((start) =>
          !state.runtimeEvents.some((event) =>
            (event.type === "run.completed" || event.type === "run.aborted") &&
            event.threadId === sessionKey &&
            event.turnId === terminalHead.receipt.turnId &&
            event.runId === start.runId
          )
        );
        const sourceHasTerminalBoundary = inspection.terminals.length > 0 ||
          isConversationTurnRuntimeClosed(inspection.owner?.turn.runtimeOutcome);
        const liveMarkerRunId = getHarnessActionRunId(state.harnessRunMarker);
        const liveMarkerParentRunId = state.harnessRunMarker?.activeParentRunId ||
          state.harnessRunMarker?.parentRunId ||
          null;
        const exactLiveMarkerStarts = liveMarkerRunId
          ? sourceStarts.filter((start) =>
              start.runId === liveMarkerRunId &&
              start.parentRunId === liveMarkerParentRunId
            )
          : [];
        const allLiveMarkerStarts = liveMarkerRunId
          ? sourceStarts.filter((start) => start.runId === liveMarkerRunId)
          : [];
        const markerProvesRuntimeOwner = !!state.harnessRunMarker &&
          state.harnessRunMarker.sessionKey === sessionKey &&
          state.harnessRunMarker.turnId === terminalHead.receipt.turnId &&
          (state.harnessRunMarker.status === "running" ||
            state.harnessRunMarker.status === "paused") &&
          !!liveMarkerRunId &&
          exactLiveMarkerStarts.length === 1 &&
          allLiveMarkerStarts.length === 1 &&
          openSourceStarts.some((start) => start === exactLiveMarkerStarts[0]);
        const activeGenerationProvesRuntimeOwner =
          state.currentTurnId === terminalHead.receipt.turnId &&
          (state.isGenerating ||
            state.agentStatus === "running" ||
            state.agentStatus === "pending_review") &&
          openSourceStarts.length === 1 &&
          sourceStarts.filter(
            (start) => start.runId === openSourceStarts[0].runId,
          ).length === 1;
        const exactRuntimeIsActive = !!inspection.owner &&
          !sourceHasTerminalBoundary &&
          (markerProvesRuntimeOwner || activeGenerationProvesRuntimeOwner);
        const exactRuntimeIsStarting = !!inspection.owner &&
          !sourceHasTerminalBoundary &&
          sourceStarts.length === 0 &&
          state.currentTurnId === terminalHead.receipt.turnId &&
          (state.isGenerating || state.agentStatus === "running");
        if (exactRuntimeIsStarting) {
          const claimId = terminalHead.claim.claimId;
          const graceState = workspaceInstructionStartingGraceByClaim.get(claimId);
          const claimAgeMs = Math.max(0, Date.now() - terminalHead.claim.claimedAt);
          if (claimAgeMs <= WORKSPACE_INSTRUCTION_START_GRACE_MS && !graceState) {
            // A synchronous re-entrant dispatch can observe the adopted Turn
            // immediately before run.started. Give that handoff exactly one
            // next-paint retry; a second observation fails closed below.
            workspaceInstructionStartingGraceByClaim.set(claimId, "scheduled");
            const retryStartingClaim = () => {
              if (workspaceInstructionStartingGraceByClaim.get(claimId) !== "scheduled") {
                return;
              }
              workspaceInstructionStartingGraceByClaim.set(claimId, "consumed");
              const timeoutId = workspaceInstructionStartingGraceTimeoutByClaim.get(claimId);
              if (timeoutId !== undefined) clearTimeout(timeoutId);
              workspaceInstructionStartingGraceTimeoutByClaim.delete(claimId);
              try {
                if (isSessionRuntimeActive(get(), sessionKey)) {
                  get().dispatchNextWorkspaceInstruction(sessionKey);
                }
              } finally {
                if (workspaceInstructionStartingGraceByClaim.get(claimId) === "consumed") {
                  clearWorkspaceInstructionStartingGrace(claimId);
                }
              }
            };
            workspaceInstructionStartingGraceTimeoutByClaim.set(
              claimId,
              setTimeout(retryStartingClaim, WORKSPACE_INSTRUCTION_START_GRACE_MS),
            );
            runAfterNextPaint(retryStartingClaim);
            return false;
          }
          if (graceState === "scheduled") return false;
          clearWorkspaceInstructionStartingGrace(claimId);
        } else {
          clearWorkspaceInstructionStartingGrace(terminalHead.claim.claimId);
        }
        const at = Date.now();
        const exactOwner = {
          sessionKey: queue.sessionKey,
          sessionEpoch: queue.sessionEpoch,
          turnId: terminalHead.receipt.turnId,
          receiptId: terminalHead.receipt.receiptId,
          clientSubmissionId: terminalHead.instruction.clientSubmissionId,
          instructionEnvelopeIdentity: workspaceInstructionEnvelopeIdentity(terminalHead),
        };
        const transition = exactRuntimeIsActive
          ? reduceWorkspaceTurnQueue(queue, {
              type: "ack",
              expectedVersion: queue.version,
              at,
              claimId: terminalHead.claim.claimId,
              sessionKey: queue.sessionKey,
              sessionEpoch: queue.sessionEpoch,
              turnOwner: exactOwner,
            })
          : reduceWorkspaceTurnQueue(queue, {
              type: "remove",
              expectedVersion: queue.version,
              at,
              claimId: terminalHead.claim.claimId,
              sessionKey: queue.sessionKey,
              sessionEpoch: queue.sessionEpoch,
              terminalOwner: exactOwner,
            });
        if (transition.disposition === "applied") {
          if (exactRuntimeIsActive) {
            set({ workspaceTurnQueue: transition.state });
          } else {
            const useChinese = /[^\x00-\x7F]/.test(
              terminalHead.instruction.payload.text,
            );
            const conclusion = concludeWorkspaceInstructionEntry({
              entry: terminalHead,
              sessionKey,
              taskFlow: state.taskFlow,
              conversationTurns: state.conversationTurns,
              runtimeEvents: state.runtimeEvents,
              resultKind: "error",
              summary: useChinese
                ? "MAIN 无法证明这个遗留调度声明仍由精确执行器持有。为避免重复执行，已保留无关历史，并用可见错误结论收口。"
                : "MAIN could not prove that this stale dispatch claim was still owned by its exact executor. To prevent duplicate execution, unrelated history was preserved and a visible error conclusion was recorded.",
              timestampMs: at,
              forceRecovery: !inspection.owner,
              recoveryReason: inspection.owner
                ? "workspace_instruction_stale_claim_unverified"
                : "workspace_instruction_stale_claim_owner_conflict",
              language: useChinese ? "zh" : "en",
              reservedTaskBlockIds: queue.entries.map(
                (entry) => entry.receipt.userBlockId,
              ),
            });
            const staleExactTurnOwnsControlPlane = !!inspection.owner &&
              state.currentTurnId === terminalHead.receipt.turnId;
            const staleActionOwnsControlPlane =
              state.activeActionRequest?.sessionKey === sessionKey &&
              state.activeActionRequest.turnId === terminalHead.receipt.turnId;
            const staleDecisionOwnsControlPlane =
              state.pendingRunDecision?.turnId === terminalHead.receipt.turnId;
            if (staleExactTurnOwnsControlPlane) {
              state.abortController?.abort();
            }
            set({
              workspaceTurnQueue: transition.state,
              taskFlow: conclusion.taskFlow,
              conversationTurns: conclusion.conversationTurns,
              runtimeEvents: conclusion.runtimeEvents,
              transcriptLoadedTurns: Math.max(
                state.transcriptLoadedTurns,
                conclusion.conversationTurns.length,
              ),
              transcriptTotalTurns: Math.max(
                state.transcriptTotalTurns,
                conclusion.conversationTurns.length,
              ),
              ...(staleExactTurnOwnsControlPlane
                ? {
                    currentTurnId: null,
                    currentTurnState: createDefaultCurrentTurnState(),
                    isGenerating: false,
                    agentStatus: "idle" as const,
                    abortController: null,
                    harnessRunMarker:
                      state.harnessRunMarker?.sessionKey === sessionKey &&
                        state.harnessRunMarker.turnId === terminalHead.receipt.turnId
                        ? null
                        : state.harnessRunMarker,
                    activeActionRequest:
                      staleActionOwnsControlPlane
                        ? null
                        : state.activeActionRequest,
                    pendingReviewResolve: staleActionOwnsControlPlane
                      ? null
                      : state.pendingReviewResolve,
                    pendingReviewTaskId: staleActionOwnsControlPlane
                      ? null
                      : state.pendingReviewTaskId,
                    pendingToolCall: staleActionOwnsControlPlane
                      ? null
                      : state.pendingToolCall,
                    pendingRunDecision: staleDecisionOwnsControlPlane
                      ? null
                      : state.pendingRunDecision,
                    pendingRunDecisionResolver: staleDecisionOwnsControlPlane
                      ? null
                      : state.pendingRunDecisionResolver,
                    normalizedStreamState: defaultNormalizedStreamState,
                  }
                : {}),
            });
          }
          get().saveCurrentRuntimeToSession();
          queue = transition.state;
          state = get();
        }
      }
    }

    const head = queue.entries[0];
    if (!head || head.status !== "queued") return false;
    // A cancel transaction owns the Session until its terminal projection is
    // durable. Keep the exact FIFO head queued; it must never become a second
    // owner or fall back to the legacy latest-wins message slot.
    if (deferDispatchUntilCancellationSettles("before_claim")) return false;
    const candidateCancellationFailure =
      workspaceInstructionCancellationFailureBySession.get(sessionKey) || null;
    const cancellationFailure =
      candidateCancellationFailure &&
      candidateCancellationFailure.sessionEpoch === queue.sessionEpoch &&
      candidateCancellationFailure.receiptId === head.receipt.receiptId &&
      candidateCancellationFailure.turnId === head.receipt.turnId
        ? candidateCancellationFailure
        : null;
    if (candidateCancellationFailure && !cancellationFailure) {
      workspaceInstructionCancellationFailureBySession.delete(sessionKey);
    }
    if (
      !cancellationFailure &&
      state.agentStatus !== "pending_review" &&
      (state.isGenerating || state.agentStatus === "running")
    ) {
      return false;
    }
    const projection = reconcileWorkspaceInstructionProjection({
      entry: head,
      taskFlow: state.taskFlow,
      conversationTurns: state.conversationTurns,
      userContextItems: buildWorkspaceInstructionUserContext({
        contextMentions: head.instruction.payload.contextMentions
          ? [...head.instruction.payload.contextMentions]
          : [],
        attachedFiles: head.instruction.payload.attachedFiles
          ? head.instruction.payload.attachedFiles.map((file) => ({ ...file }))
          : [],
        images: head.instruction.payload.images
          ? [...head.instruction.payload.images]
          : [],
        workspace: resolveSessionWorkspaceKey(state.currentWorkspace),
        language: state.config.language === "en" ? "en" : "zh",
      }),
      language: state.config.language === "en" ? "en" : "zh",
    });
    const projectionConflictReason = projection.disposition === "conflict"
      ? projection.reason
      : null;
    if (projection.disposition === "ready" && projection.changed) {
      syncTaskIdCounterFromBlocks(projection.taskFlow);
      set({
        taskFlow: projection.taskFlow,
        conversationTurns: projection.conversationTurns,
        transcriptLoadedTurns: Math.max(
          state.transcriptLoadedTurns,
          projection.conversationTurns.length,
        ),
        transcriptTotalTurns: Math.max(
          state.transcriptTotalTurns,
          projection.conversationTurns.length,
        ),
      });
      state = get();
      logStoreEvent("workspace_instruction_projection_rebuilt", {
        sessionKey,
        sessionEpoch: queue.sessionEpoch,
        receiptId: head.receipt.receiptId,
        turnId: head.receipt.turnId,
        userBlockId: head.receipt.userBlockId,
      });
    } else if (projectionConflictReason) {
      logStoreEvent("workspace_instruction_projection_conflict", {
        sessionKey,
        sessionEpoch: queue.sessionEpoch,
        receiptId: head.receipt.receiptId,
        turnId: head.receipt.turnId,
        userBlockId: head.receipt.userBlockId,
        reason: projectionConflictReason,
      });
    }
    const admittedUserBlock = projection.disposition === "ready"
      ? projection.userBlock
      : null;

    const claimId = createWorkspaceRuntimeIdentity("workspace-claim");
    const claimed = reduceWorkspaceTurnQueue(queue, {
      type: "claim",
      expectedVersion: queue.version,
      at: Date.now(),
      claimId,
      sessionKey: queue.sessionKey,
      sessionEpoch: queue.sessionEpoch,
    });
    if (claimed.disposition !== "applied" || !claimed.entry?.claim) return false;
    set({ workspaceTurnQueue: claimed.state });
    const exactClaim: WorkspaceInstructionDispatchClaim = {
      claimId,
      receiptId: head.receipt.receiptId,
      clientSubmissionId: head.instruction.clientSubmissionId,
      sessionKey: queue.sessionKey,
      sessionEpoch: queue.sessionEpoch,
      turnId: head.receipt.turnId,
      admittedUserBlockId: head.receipt.userBlockId,
      instructionEnvelopeIdentity: workspaceInstructionEnvelopeIdentity(head),
    };
    const hints = head.instruction.payload.dispatchHints || {};
    const candidateGoalCreation = isGoalCreationAuthorization(hints.goalCreationAuthorization)
      ? hints.goalCreationAuthorization
      : null;
    const candidateGoalContinuation = isGoalContinuationAuthorization(hints.goalContinuationAuthorization)
      ? hints.goalContinuationAuthorization
      : null;
    const visibleGoalSubmissionEnvelope = candidateGoalCreation
      ? visibleGoalSubmissionAuthorizationBroker.carryValidated({
          text: head.instruction.payload.text,
          sessionKey,
          authorization: candidateGoalCreation,
        })
      : undefined;
    const goalContinuationEnvelope = candidateGoalContinuation
      ? goalContinuationAuthorizationBroker.issueValidated({
          text: head.instruction.payload.text,
          authorization: candidateGoalContinuation,
        })
      : undefined;
    const remoteFeishu = hints.remoteFeishu && typeof hints.remoteFeishu === "object" && !Array.isArray(hints.remoteFeishu)
      ? hints.remoteFeishu as unknown as FeishuRemoteContext
      : undefined;
    const hintedIntent = normalizeWorkspaceInstructionIntentHint(
      hints.resolvedIntent,
    ) || undefined;
    const hintedRuntimeIntent = normalizeWorkspaceInstructionIntentHint(
      hints.runtimeIntentOverride,
    ) || undefined;
    const executionConsentDecision = resolveWorkspaceInstructionExecutionConsent({
      sessionKey,
      taskFlow: state.taskFlow,
      hints,
      activeActionRequest: state.activeActionRequest,
    });
    const pendingReviewActionDecision = state.agentStatus === "pending_review"
      ? resolveWorkspaceInstructionActionDecision({
          sessionKey,
          taskFlow: state.taskFlow,
          hints,
          activeActionRequest: state.activeActionRequest,
        })
      : { actionDecision: null, reason: "not_requested" as const };
    const hintedReplyRequestId =
      hints.replyOptionRequestIdentity &&
      typeof hints.replyOptionRequestIdentity === "object" &&
      !Array.isArray(hints.replyOptionRequestIdentity)
        ? (hints.replyOptionRequestIdentity as WorkspaceJsonObject).requestId
        : null;
    if (hints.executionConsentGranted === true && !executionConsentDecision.granted) {
      logStoreEvent("workspace_instruction_execution_consent_rejected", {
        sessionKey,
        turnId: head.receipt.turnId,
        receiptId: head.receipt.receiptId,
        reason: executionConsentDecision.reason,
        requestId: typeof hintedReplyRequestId === "string" ? hintedReplyRequestId : null,
      });
    }

    let pendingReviewActionApplied = false;
    if (
      !projectionConflictReason &&
      !cancellationFailure &&
      pendingReviewActionDecision.actionDecision
    ) {
      const current = get();
      const identity = pendingReviewActionDecision.identity;
      const pendingResolver = current.pendingReviewResolve;
      if (pendingResolver) {
        try {
          pendingResolver({
            action: pendingReviewActionDecision.actionDecision === "approve"
              ? "accept"
              : "reject",
          });
        } catch (error) {
          logStoreEvent("workspace_instruction_pending_review_resolver_error", {
            sessionKey,
            sourceTurnId: identity.turnId,
            requestId: identity.requestId,
            actionDecision: pendingReviewActionDecision.actionDecision,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        const selectedText = typeof hints.selectedReplyOptionText === "string"
          ? hints.selectedReplyOptionText
          : head.instruction.payload.text;
        const baseState = pendingReviewActionDecision.actionDecision === "reject"
          ? (() => {
              current.abortController?.abort();
              return projectCanceledTurn({
                state: current,
                sessionKey,
                turnId: identity.turnId,
                runId: identity.runId,
                parentRunId: identity.parentRunId,
                reason: "operation_cancelled",
                message: current.config.language === "en"
                  ? "The proposed operation was rejected; the previous turn is now closed."
                  : "用户已拒绝拟议操作，旧回合已完成收口。",
                nextTaskId: () => get()._nextTaskId(),
                nowMs: Date.now(),
              });
            })()
          : { state: current, disposition: "committed" as const };
        const archived = archiveReplyOptionBlocksForChoice(
          baseState.state.taskFlow,
          identity.turnId,
          selectedText,
          identity,
        );
        if (baseState.disposition !== "ownership_lost") {
          const actionDecision = pendingReviewActionDecision.actionDecision;
          set({
            ...baseState.state,
            taskFlow: archived.taskFlow,
            activeActionRequest: null,
            pendingReviewResolve: null,
            pendingReviewTaskId: null,
            pendingToolCall: null,
            agentStatus: actionDecision === "approve" ? "running" : "idle",
            isGenerating: actionDecision === "approve",
            ...(actionDecision === "reject" ? { abortController: null } : {}),
            conversationTurns: baseState.state.conversationTurns.map((turn) =>
              turn.id === identity.turnId && turn.pendingOperationProposal
                ? {
                    ...turn,
                    pendingOperationProposal: {
                      ...turn.pendingOperationProposal,
                      approvalStatus: actionDecision === "approve"
                        ? "approved" as const
                        : "cancelled" as const,
                      ...(actionDecision === "approve" ? { approvedAt: Date.now() } : {}),
                    },
                  }
                : turn
            ),
          });
          pendingReviewActionApplied = true;
          logStoreEvent("workspace_instruction_pending_review_action_applied", {
            sessionKey,
            sourceTurnId: identity.turnId,
            admittedTurnId: head.receipt.turnId,
            requestId: identity.requestId,
            actionDecision,
          });
        }
      }
    }

    const started = projectionConflictReason || cancellationFailure
      ? false
      : pendingReviewActionDecision.actionDecision
        ? pendingReviewActionApplied
      : get().sendMessage(
      head.instruction.payload.text,
      head.instruction.payload.images ? [...head.instruction.payload.images] : undefined,
      {
        contextMentionsSnapshot: head.instruction.payload.contextMentions
          ? [...head.instruction.payload.contextMentions]
          : [],
        attachedFilesSnapshot: head.instruction.payload.attachedFiles
          ? head.instruction.payload.attachedFiles.map((file) => ({ ...file }))
          : [],
        submissionOriginSessionKey: sessionKey,
        turnIdOverride: head.receipt.turnId,
        adoptExistingTurn: true,
        admittedUserBlockId: admittedUserBlock!.id,
        workspaceInstructionClaim: exactClaim,
        suppressGameStudioSuggestion: true,
        skipAutoPlanHydration: true,
        ...(hintedIntent ? { resolvedIntent: hintedIntent } : {}),
        ...(hintedRuntimeIntent ? { runtimeIntentOverride: hintedRuntimeIntent } : {}),
        ...(hintedIntent || hints.skipIntentResolution === true
          ? { skipIntentResolution: true }
          : {}),
        ...(typeof hints.turnTitle === "string" ? { turnTitle: hints.turnTitle } : {}),
        ...(typeof hints.intentSummary === "string" ? { intentSummary: hints.intentSummary } : {}),
        ...(executionConsentDecision.granted ? { executionConsentGranted: true } : {}),
        ...(typeof hints.replyOptionSourceTurnId === "string"
          ? { replyOptionSourceTurnId: hints.replyOptionSourceTurnId }
          : {}),
        ...(typeof hints.selectedReplyOptionText === "string"
          ? { selectedReplyOptionText: hints.selectedReplyOptionText }
          : {}),
        ...(hints.replyOptionRequestIdentity && typeof hints.replyOptionRequestIdentity === "object" && !Array.isArray(hints.replyOptionRequestIdentity)
          ? { replyOptionRequestIdentity: hints.replyOptionRequestIdentity as unknown as UserChoiceResolutionIdentity }
          : {}),
        ...(hints.replyOptionIsCustom === true ? { replyOptionIsCustom: true } : {}),
        ...(typeof hints.parentRunIdOverride === "string"
          ? { parentRunIdOverride: hints.parentRunIdOverride }
          : {}),
        ...(typeof hints.parentPlanTurnId === "string"
          ? { parentPlanTurnId: hints.parentPlanTurnId }
          : {}),
        ...(hints.preservePlanState === true ? { preservePlanState: true } : {}),
        ...(visibleGoalSubmissionEnvelope ? { visibleGoalSubmissionEnvelope } : {}),
        ...(goalContinuationEnvelope
          ? {
              goalContinuationEnvelope,
              goalContinuationGuidance: head.instruction.payload.text,
            }
          : {}),
        ...(remoteFeishu ? { remoteFeishu } : {}),
      },
    );

    const completeAdmittedTurn = (
      resultKind: WorkspaceInstructionTerminalResultKind,
      summary: string,
    ) => {
      let completed = false;
      set((current) => {
        const activeQueue = current.workspaceTurnQueue;
        const activeHead = activeQueue?.entries[0];
        if (
          !activeQueue ||
          activeHead?.status !== "dispatching" ||
          activeHead.claim?.claimId !== claimId ||
          activeHead.receipt.receiptId !== head.receipt.receiptId ||
          activeHead.receipt.turnId !== head.receipt.turnId ||
          activeHead.receipt.userBlockId !== head.receipt.userBlockId ||
          activeHead.instruction.clientSubmissionId !==
            head.instruction.clientSubmissionId ||
          workspaceInstructionEnvelopeIdentity(activeHead) !==
            exactClaim.instructionEnvelopeIdentity ||
          activeQueue.sessionKey !== head.receipt.sessionKey ||
          activeQueue.sessionEpoch !== head.receipt.sessionEpoch
        ) return {};
        const timestampMs = Date.now();
        const removed = reduceWorkspaceTurnQueue(activeQueue, {
          type: "remove",
          expectedVersion: activeQueue.version,
          at: timestampMs,
          claimId,
          sessionKey: activeQueue.sessionKey,
          sessionEpoch: activeQueue.sessionEpoch,
          terminalOwner: {
            sessionKey: activeQueue.sessionKey,
            sessionEpoch: activeQueue.sessionEpoch,
            turnId: head.receipt.turnId,
            receiptId: head.receipt.receiptId,
            clientSubmissionId: head.instruction.clientSubmissionId,
            instructionEnvelopeIdentity: exactClaim.instructionEnvelopeIdentity,
          },
        });
        if (removed.disposition !== "applied") return {};
        completed = true;
        const conclusion = concludeWorkspaceInstructionEntry({
          entry: activeHead,
          sessionKey,
          taskFlow: current.taskFlow,
          conversationTurns: current.conversationTurns,
          runtimeEvents: current.runtimeEvents,
          resultKind,
          summary,
          timestampMs,
          forceRecovery: !!projectionConflictReason,
          recoveryReason: projectionConflictReason,
          language: current.config.language === "en" ? "en" : "zh",
          reservedTaskBlockIds: activeQueue.entries.map(
            (entry) => entry.receipt.userBlockId,
          ),
        });
        return {
          workspaceTurnQueue: removed.state,
          taskFlow: conclusion.taskFlow,
          runtimeEvents: conclusion.runtimeEvents,
          conversationTurns: conclusion.conversationTurns,
          transcriptLoadedTurns: Math.max(
            current.transcriptLoadedTurns,
            conclusion.conversationTurns.length,
          ),
          transcriptTotalTurns: Math.max(
            current.transcriptTotalTurns,
            conclusion.conversationTurns.length,
          ),
        };
      });
      if (completed) {
        get().saveCurrentRuntimeToSession();
        runAfterNextPaint(() => get().dispatchNextWorkspaceInstruction(sessionKey));
      }
      return completed;
    };

    const acknowledgeAdmittedTurn = () => {
      let acknowledged = false;
      set((current) => {
        const activeQueue = current.workspaceTurnQueue;
        const activeHead = activeQueue?.entries[0];
        if (
          !activeQueue ||
          activeHead?.status !== "dispatching" ||
          activeHead.claim?.claimId !== claimId ||
          activeHead.receipt.receiptId !== head.receipt.receiptId ||
          workspaceInstructionEnvelopeIdentity(activeHead) !==
            exactClaim.instructionEnvelopeIdentity
        ) return {};
        const transition = reduceWorkspaceTurnQueue(activeQueue, {
          type: "ack",
          expectedVersion: activeQueue.version,
          at: Date.now(),
          claimId,
          sessionKey: activeQueue.sessionKey,
          sessionEpoch: activeQueue.sessionEpoch,
          turnOwner: {
            sessionKey: activeQueue.sessionKey,
            sessionEpoch: activeQueue.sessionEpoch,
            turnId: head.receipt.turnId,
            receiptId: head.receipt.receiptId,
            clientSubmissionId: head.instruction.clientSubmissionId,
            instructionEnvelopeIdentity: exactClaim.instructionEnvelopeIdentity,
          },
        });
        if (transition.disposition !== "applied") return {};
        acknowledged = true;
        return { workspaceTurnQueue: transition.state };
      });
      if (acknowledged) {
        get().saveCurrentRuntimeToSession();
        runAfterNextPaint(() => get().dispatchNextWorkspaceInstruction(sessionKey));
      }
      return acknowledged;
    };

    const releaseAdmittedTurnClaim = () => {
      let releasedClaim = false;
      set((current) => {
        const activeQueue = current.workspaceTurnQueue;
        const activeHead = activeQueue?.entries[0];
        if (
          !activeQueue ||
          activeHead?.status !== "dispatching" ||
          activeHead.claim?.claimId !== claimId ||
          activeHead.receipt.receiptId !== head.receipt.receiptId ||
          workspaceInstructionEnvelopeIdentity(activeHead) !==
            exactClaim.instructionEnvelopeIdentity
        ) return {};
        const released = reduceWorkspaceTurnQueue(activeQueue, {
          type: "release",
          expectedVersion: activeQueue.version,
          at: Date.now(),
          claimId,
          sessionKey: activeQueue.sessionKey,
          sessionEpoch: activeQueue.sessionEpoch,
        });
        if (released.disposition !== "applied") return {};
        releasedClaim = true;
        return { workspaceTurnQueue: released.state };
      });
      return releasedClaim;
    };

    const latest = get();
    if (!started) {
      if (getPendingSessionCancellation(sessionKey)) {
        releaseAdmittedTurnClaim();
        deferDispatchUntilCancellationSettles("claim_race");
        return false;
      }
      if (cancellationFailure) {
        const summary = latest.config.language === "en"
          ? "MAIN could not verify the preceding cancellation terminal state, so this admitted workspace Turn was not executed and was closed with a visible error. Retry creates a new Turn after the Session is reconciled."
          : "MAIN 无法确认前一回合的取消终态，因此未执行这条已接纳的工作区指令，并已用可见错误结论收口；Session 完成协调后，重试会创建新回合。";
        logStoreEvent("workspace_instruction_cancellation_fence_failed_closed", {
          sessionKey,
          turnId: head.receipt.turnId,
          receiptId: head.receipt.receiptId,
          disposition: cancellationFailure.disposition,
        });
        if (completeAdmittedTurn("error", summary)) {
          if (
            workspaceInstructionCancellationFailureBySession.get(sessionKey) ===
              cancellationFailure
          ) {
            workspaceInstructionCancellationFailureBySession.delete(sessionKey);
          }
          return true;
        }
        releaseAdmittedTurnClaim();
        return false;
      }
      const busyRace = latest.isGenerating ||
        latest.agentStatus === "running" ||
        latest.agentStatus === "pending_review";
      if (!busyRace) {
        const summary = projectionConflictReason
          ? latest.config.language === "en"
            ? "MAIN found an ownership conflict while restoring this admitted workspace Turn. It was closed with a visible error without adopting unrelated history."
            : "MAIN 在恢复这条已接纳的工作区回合时发现所有权冲突；已在不采用无关历史记录的前提下，以可见错误结论收口。"
          : latest.config.language === "en"
            ? "MAIN could not start this admitted workspace instruction. The turn was closed with an error; retrying creates a new Turn."
            : "MAIN 无法启动这条已接纳的工作区指令；本回合已按错误结论收口，重试会创建新的回合。";
        if (completeAdmittedTurn("error", summary)) return true;
      }
      releaseAdmittedTurnClaim();
      return false;
    }
    const localFastLease = localFastExecutionLeasesByClaim.get(claimId);
    if (
      localFastLease &&
      localFastLease.claim?.receiptId === head.receipt.receiptId &&
      localFastLease.sessionKey === sessionKey &&
      localFastLease.turnId === head.receipt.turnId
    ) {
      if (!localFastLease.dispatcherObserved) {
        localFastLease.dispatcherObserved = true;
        const releaseUnverifiedLeaseForFailClosedReconcile = (detail: string) => {
          logStoreEvent("workspace_local_fast_conclusion_unverified", {
            sessionKey,
            turnId: head.receipt.turnId,
            receiptId: head.receipt.receiptId,
            runId: localFastLease.runId,
            detail,
          });
          const ownerStillCurrent = localFastLease.hasRuntimeOwnership();
          // Never retain a rejected completion as a permanent execution lease.
          // The still-dispatching head is not released back to queued: once the
          // transient map is gone, the dispatcher's lost-lease branch closes it
          // through the identity-safe quarantine projection without rerunning
          // the local handler.
          localFastLease.release();
          if (ownerStillCurrent && isSessionRuntimeActive(get(), sessionKey)) {
            runAfterNextPaint(() => {
              if (isSessionRuntimeActive(get(), sessionKey)) {
                get().dispatchNextWorkspaceInstruction(sessionKey);
              }
            });
          }
        };
        void localFastLease.completion.then(
          (result) => {
            if (hasVerifiedLocalFastConclusion(get(), exactClaim, result)) {
              if (!localFastLease.retireWorkspaceClaim()) {
                releaseUnverifiedLeaseForFailClosedReconcile(
                  "terminal_verified_but_fifo_retirement_rejected",
                );
                return;
              }
              localFastLease.release();
              if (isSessionRuntimeActive(get(), sessionKey)) {
                runAfterNextPaint(() => {
                  if (isSessionRuntimeActive(get(), sessionKey)) {
                    get().dispatchNextWorkspaceInstruction(sessionKey);
                  }
                });
              }
              return;
            }
            releaseUnverifiedLeaseForFailClosedReconcile(
              result.error?.message || "terminal_projection_unverified",
            );
          },
          (error) => {
            releaseUnverifiedLeaseForFailClosedReconcile(
              error instanceof Error ? error.message : String(error),
            );
          },
        );
      }
      return true;
    }
    const postDispatch = get();
    const postDispatchInspection = inspectWorkspaceInstructionTerminalProjection({
      entry: head,
      sessionKey,
      taskFlow: postDispatch.taskFlow,
      conversationTurns: postDispatch.conversationTurns,
      runtimeEvents: postDispatch.runtimeEvents,
    });
    const adoptedTurnOwnsRuntime = !!postDispatchInspection.owner && (
      postDispatch.currentTurnId === head.receipt.turnId ||
      (
        postDispatch.harnessRunMarker?.sessionKey === sessionKey &&
        postDispatch.harnessRunMarker.turnId === head.receipt.turnId
      )
    );
    const admittedTurnAlreadyTerminal = postDispatchInspection.terminals.length > 0 ||
      isConversationTurnRuntimeClosed(
        postDispatchInspection.owner?.turn.runtimeOutcome,
    );
    if (admittedTurnAlreadyTerminal) {
      const closedOutcome = postDispatchInspection.owner?.turn.runtimeOutcome;
      const completedOutcome = closedOutcome?.status === "completed" ? closedOutcome : null;
      const outcomeResultKind: WorkspaceInstructionTerminalResultKind =
        closedOutcome?.status === "aborted"
          ? "canceled"
          : completedOutcome?.resultKind || "success";
      const durableResultKind = postDispatchInspection.terminals.length === 1
        ? postDispatchInspection.terminals[0].resultKind || outcomeResultKind
        : outcomeResultKind;
      const terminalSummary = String(
        postDispatchInspection.owner?.turn.summary || "",
      ).trim() || (
        postDispatch.config.language === "en"
          ? "The admitted workspace Turn reached its terminal conclusion."
          : "已接纳的工作区回合已得出最终结论。"
      );
      completeAdmittedTurn(durableResultKind, terminalSummary);
      return true;
    }
    if (adoptedTurnOwnsRuntime) {
      acknowledgeAdmittedTurn();
      return true;
    }
    const summary = postDispatchInspection.owner
      ? postDispatch.config.language === "en"
        ? "The instruction was accepted and applied to the active workflow. Any resulting execution continues in its owning Turn."
        : "该指令已接纳并应用到当前工作流；由它触发的后续执行将在所属回合中继续。"
      : postDispatch.config.language === "en"
      ? "The execution adapter lost the exact admitted Turn owner. Unrelated history was preserved and a recovery Turn recorded the visible error."
      : "执行适配器失去了已接纳回合的精确所有权；无关历史保持不变，并由恢复回合记录可见错误。";
    completeAdmittedTurn(postDispatchInspection.owner ? "success" : "error", summary);
    return true;
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
    if (taskId == null) return;
    if (!isPendingToolPermissionResolutionCurrent(state, taskId, identity, "approve_session")) {
      invalidateStalePendingPlanToolPermission({
        state,
        action: "approve_session",
        applyPatch: (patch) => set(patch),
      });
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
    if (!isPendingToolPermissionResolutionCurrent(state, taskId, identity, "approve_once")) {
      invalidateStalePendingPlanToolPermission({
        state,
        action: "approve_once",
        applyPatch: (patch) => set(patch),
      });
      return;
    }

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
    if (!isPendingToolPermissionResolutionCurrent(state, taskId, identity, "reject")) {
      invalidateStalePendingPlanToolPermission({
        state,
        action: "reject",
        applyPatch: (patch) => set(patch),
      });
      return;
    }

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
      preferSubagents: false,
      webSearchEnabled: false,
      webSearchProvider: "duckduckgo",
      approvedLocalFileReadPaths: [],
      approvedShellPermissionRules: [],
      readOnlyAutoApproveForSession: false,
      queuedUserMessage: null,
      activeGuidance: null,
      workspaceTurnQueue: null,
      workspaceInstructionLedger: [],
      transcriptPartial: false,
      transcriptLoadedTurns: 0,
      transcriptTotalTurns: 0,
      currentTurnExecutionConsent: { turnId: null, granted: false },
      planArtifacts: [],
      planTasks: [],
      planExecutionEvidenceLedger: [],
      planExecutionEvidenceCount: 0,
      planAutoResumeCount: 0,
      planExecutionProgressSnapshot: null,
      planLifecycle: createEmptyPlanLifecycleForSession(null),
      planStage: "idle",
      isPlanApproved: false,
      planApprovalChoice: null,
      pendingPlanApprovalHandoff: null,
      planApprovalExecutionStartedForTurnId: null,
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
    forceExecuteRecoveryState?: ForcedExecuteRecoveryRuntimeState;
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
    planExecutionLeaseId?: string;
    planExecutionInstructionHash?: string;
    continueExistingGoal?: boolean;
    goalContinuationGuidance?: string;
    visibleGoalSubmissionEnvelope?: VisibleGoalSubmissionEnvelope;
    goalContinuationEnvelope?: GoalContinuationEnvelope;
    queuedUserMessageId?: string;
    submissionOriginSessionKey?: string;
    workspaceInstructionClaim?: WorkspaceInstructionDispatchClaim;
    adoptExistingTurn?: boolean;
    admittedUserBlockId?: number;
  }) => {
    let state = get();
    if (options?.adoptExistingTurn) {
      const claim = options.workspaceInstructionClaim;
      const head = state.workspaceTurnQueue?.entries[0];
      const exactClaimMatches = !!claim &&
        state.workspaceTurnQueue?.sessionKey === claim.sessionKey &&
        state.workspaceTurnQueue?.sessionEpoch === claim.sessionEpoch &&
        head?.status === "dispatching" &&
        head.claim?.claimId === claim.claimId &&
        head.receipt.receiptId === claim.receiptId &&
        head.receipt.turnId === claim.turnId &&
        head.receipt.userBlockId === claim.admittedUserBlockId &&
        head.instruction.clientSubmissionId === claim.clientSubmissionId &&
        options.turnIdOverride === claim.turnId &&
        options.admittedUserBlockId === claim.admittedUserBlockId;
      if (!exactClaimMatches) {
        logStoreEvent("workspace_turn_dispatch_claim_rejected", {
          expectedSessionKey: claim?.sessionKey || null,
          activeSessionKey: state.workspaceTurnQueue?.sessionKey || null,
          expectedTurnId: claim?.turnId || null,
          activeTurnId: head?.receipt.turnId || null,
          expectedClaimId: claim?.claimId || null,
          activeClaimId: head?.claim?.claimId || null,
        });
        return false;
      }
    } else if (options?.workspaceInstructionClaim) {
      logStoreEvent("workspace_turn_dispatch_claim_rejected", {
        reason: "claim_without_adoption",
        claimId: options.workspaceInstructionClaim.claimId,
      });
      return false;
    }
    const suppliedSubmissionOriginSessionKey = String(
      options?.submissionOriginSessionKey || "",
    ).trim();
    const capturedImages = images ? [...images] : undefined;
    const capturedUserContext = {
      contextMentionsSnapshot: [
        ...(options?.contextMentionsSnapshot || state.contextMentions),
      ],
      attachedFilesSnapshot: (
        options?.attachedFilesSnapshot || state.attachedFiles
      ).map((file) => normalizeAttachedFile(file)),
    };
    const workspaceClearBarrierWorkspace = resolveWorkspaceClearBarrierForSubmission({
      currentWorkspaceKey: resolveSessionWorkspaceKey(state.currentWorkspace),
      submissionOriginSessionKey: suppliedSubmissionOriginSessionKey,
    });
    if (workspaceClearBarrierWorkspace && options?.workspaceInstructionClaim) {
      logStoreEvent("workspace_turn_dispatch_deferred_for_clear", {
        workspaceKey: workspaceClearBarrierWorkspace,
        sessionKey: options.workspaceInstructionClaim.sessionKey,
        turnId: options.workspaceInstructionClaim.turnId,
        claimId: options.workspaceInstructionClaim.claimId,
      });
      return false;
    }
    const staleContinuationDuringClear = !!workspaceClearBarrierWorkspace && (
      options?.hidden === true ||
      !!options?.queuedUserMessageId ||
      options?.reuseCurrentTurn === true ||
      !!options?.turnIdOverride ||
      !!options?.runIdOverride ||
      !!options?.parentRunIdOverride ||
      !!options?.uiParentTurnId ||
      !!options?.parentPlanTurnId ||
      !!options?.replyOptionSourceTurnId ||
      !!options?.replyOptionRequestIdentity ||
      !!options?.forceExecuteRecoveryMode ||
      !!options?.forceExecuteRecoveryState ||
      (options?.continueExistingGoal === true && !options.goalContinuationEnvelope)
    );
    if (staleContinuationDuringClear) {
      logStoreEvent("workspace_clear_stale_continuation_discarded", {
        workspaceKey: workspaceClearBarrierWorkspace,
        submissionOriginSessionKey: suppliedSubmissionOriginSessionKey || null,
        hidden: options?.hidden === true,
        queuedReplay: !!options?.queuedUserMessageId,
        turnBound: !!options?.turnIdOverride || options?.reuseCurrentTurn === true,
        runBound: !!options?.runIdOverride || !!options?.parentRunIdOverride,
        approvalBound: !!options?.replyOptionRequestIdentity,
        textChars: text.length,
        disposition: "discarded_stale_continuation",
      });
      return true;
    }
    const workspaceClearSubmissionId =
      `workspace-clear-submission-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    let deferredGoalContinuationAuthorization: GoalContinuationAuthorization | null = null;
    const workspaceClearDeferral = deferSubmissionForWorkspaceClear({
      currentWorkspaceKey: resolveSessionWorkspaceKey(state.currentWorkspace),
      submissionOriginSessionKey: suppliedSubmissionOriginSessionKey,
      submission: {
        id: workspaceClearSubmissionId,
        targetSessionKey:
          suppliedSubmissionOriginSessionKey &&
          !suppliedSubmissionOriginSessionKey.startsWith("workspace-only:")
            ? suppliedSubmissionOriginSessionKey
            : null,
        createdAt: Date.now(),
        replay: async (outcome) => {
          // Rebuild a fresh durable Turn from user-owned input only. A
          // successful clear invalidates every old Session capability. A
          // preserved clear may carry only the exact Goal continuation envelope
          // so admission can revalidate it for the new Turn.
          const acceptance = await get().acceptWorkspaceInstruction({
            text,
            ...(capturedImages?.length ? { images: capturedImages } : {}),
            contextMentions: capturedUserContext.contextMentionsSnapshot,
            attachedFiles: capturedUserContext.attachedFilesSnapshot,
            source: options?.remoteFeishu ? "im_adapter" : "replay",
            clientSubmissionId: workspaceClearSubmissionId,
            ...(options?.remoteFeishu ? { remoteFeishu: options.remoteFeishu } : {}),
            ...(outcome === "preserved" && deferredGoalContinuationAuthorization
              ? {
                  goalContinuationEnvelope: goalContinuationAuthorizationBroker.issueValidated({
                    text,
                    authorization: deferredGoalContinuationAuthorization,
                  }),
                }
              : {}),
          });
          return acceptance.accepted;
        },
        onDiscard: (reason) => {
          logStoreEvent("workspace_clear_submission_discarded", {
            workspaceKey: workspaceClearBarrierWorkspace,
            reason,
            textChars: text.length,
          });
          if (reason === "replay_failed") {
            void get().acceptWorkspaceInstruction({
              text,
              ...(capturedImages?.length ? { images: capturedImages } : {}),
              contextMentions: capturedUserContext.contextMentionsSnapshot,
              attachedFiles: capturedUserContext.attachedFilesSnapshot,
              source: options?.remoteFeishu ? "im_adapter" : "replay",
              clientSubmissionId: workspaceClearSubmissionId,
              ...(options?.remoteFeishu ? { remoteFeishu: options.remoteFeishu } : {}),
              forceVisibleErrorConclusion: "workspace_clear_replay_exhausted",
            });
          }
        },
      },
    });
    if (workspaceClearDeferral.deferred) {
      deferredGoalContinuationAuthorization =
        goalContinuationAuthorizationBroker.consume({
          envelope: options?.goalContinuationEnvelope,
          text,
        });
      logStoreEvent("workspace_clear_submission_deferred", {
        workspaceKey: workspaceClearDeferral.workspaceKey,
        disposition: workspaceClearDeferral.disposition,
        submissionOriginSessionKey: suppliedSubmissionOriginSessionKey || null,
        queuePosition: workspaceClearDeferral.queuePosition,
        textChars: text.length,
        images: capturedImages?.length || 0,
        queuePolicy: "strict_fifo",
      });
      return true;
    }
    const visibleSubmissionSessionKey =
      resolveVisibleGoalSubmissionSessionKey(state);
    if (
      suppliedSubmissionOriginSessionKey &&
      suppliedSubmissionOriginSessionKey !== visibleSubmissionSessionKey
    ) {
      logStoreEvent("send_async_resume_skipped_inactive_session", {
        phase: "submission_origin_guard",
        sessionKey: suppliedSubmissionOriginSessionKey,
        activeSessionKey: visibleSubmissionSessionKey,
      });
      return false;
    }
    const submissionOriginSessionKey = suppliedSubmissionOriginSessionKey ||
      visibleSubmissionSessionKey;
    type CancellationQueueContext = {
      runtimeIntentOverride?: ResolvedRunIntent;
      goalSourceContextSnapshot?: string;
      goalCreationAuthorization?: GoalCreationAuthorization;
      goalContinuationAuthorization?: GoalContinuationAuthorization;
      goalContinuationGuidance?: string;
    };
    type CancellationSubmissionGate =
      | "none"
      | "legacy_deferred"
      | "workspace_claim_fenced";
    const readCancellationQueuedMessage = (
      candidate: AppState,
    ): QueuedUserMessage | null => normalizeQueuedUserMessage(
      isSessionRuntimeActive(candidate, submissionOriginSessionKey)
        ? candidate.queuedUserMessage
        : candidate.runtimeBySessionKey[submissionOriginSessionKey]?.queuedUserMessage,
    );
    const deferCurrentSubmissionForCancellation = (
      replayOptions: typeof options = options,
      queuedWorkflowContext: CancellationQueueContext = {},
    ): CancellationSubmissionGate => {
      const pendingCancellation = getPendingSessionCancellation(
        submissionOriginSessionKey,
      );
      if (!pendingCancellation) return "none";
      if (replayOptions?.workspaceInstructionClaim) {
        // Durable workspace FIFO already owns this exact Turn. Returning false
        // lets its dispatcher release the claim and retry it after cancel
        // settlement; copying it into queuedUserMessage would lose identity and
        // let the dispatcher fabricate a successful completion.
        logStoreEvent("workspace_turn_dispatch_claim_fenced_by_cancellation", {
          sessionKey: submissionOriginSessionKey,
          canceledTurnId: pendingCancellation.turnId,
          queuedTurnId: replayOptions.workspaceInstructionClaim.turnId,
          claimId: replayOptions.workspaceInstructionClaim.claimId,
        });
        return "workspace_claim_fenced";
      }
      const replayOptionsWithoutSessionOrigin = replayOptions
        ? { ...replayOptions }
        : undefined;
      if (replayOptionsWithoutSessionOrigin) {
        delete replayOptionsWithoutSessionOrigin.submissionOriginSessionKey;
      }

      let queued = readCancellationQueuedMessage(get());
      const reusesExactQueuedMessage = !!replayOptions?.queuedUserMessageId &&
        !!queued &&
        isExactQueuedMessageReplay({
          queuedMessageId: queued.id,
          replayMessageId: replayOptions.queuedUserMessageId,
          queuedText: queued.text,
          replayText: text,
          queuedSessionKey: queued.sessionKey,
          replaySessionKey: submissionOriginSessionKey,
        });
      if (!reusesExactQueuedMessage) {
        const goalContinuationAuthorization =
          queuedWorkflowContext.goalContinuationAuthorization ||
          goalContinuationAuthorizationBroker.consume({
            envelope: replayOptions?.goalContinuationEnvelope,
            text,
          });
        queued = get().queueUserMessage(text, images, {
          contextMentions: replayOptions?.contextMentionsSnapshot || state.contextMentions,
          attachedFiles: (replayOptions?.attachedFilesSnapshot || state.attachedFiles)
            .map((file) => normalizeAttachedFile(file)),
          runtimeIntentOverride:
            queuedWorkflowContext.runtimeIntentOverride ||
            replayOptions?.runtimeIntentOverride,
          goalSourceContextSnapshot:
            queuedWorkflowContext.goalSourceContextSnapshot ||
            replayOptions?.goalSourceContextSnapshot,
          goalCreationAuthorization: queuedWorkflowContext.goalCreationAuthorization,
          goalContinuationAuthorization: goalContinuationAuthorization || undefined,
          goalContinuationGuidance:
            queuedWorkflowContext.goalContinuationGuidance ||
            replayOptions?.goalContinuationGuidance,
          visibleGoalSubmissionEnvelope: replayOptions?.visibleGoalSubmissionEnvelope,
          replyOptionRequestIdentity: replayOptions?.replyOptionRequestIdentity,
          replyOptionIsCustom: replayOptions?.replyOptionIsCustom,
          parentRunIdOverride: replayOptions?.parentRunIdOverride,
        });
      }
      if (!queued) {
        logStoreEvent("send_cancellation_barrier_queue_rejected", {
          sessionKey: submissionOriginSessionKey,
          textChars: text.length,
          images: images?.length || 0,
        });
        return "legacy_deferred";
      }

      const queuedMessageId = queued.id;
      const deferred = deferUntilSessionCancellationSettled({
        sessionKey: submissionOriginSessionKey,
        onSettled: (settlement) => {
          const latest = get();
          const latestQueued = readCancellationQueuedMessage(latest);
          const activeSessionKey = resolveVisibleGoalSubmissionSessionKey(latest);
          const decision = resolveDeferredSessionSubmissionDecision({
            expectedQueueId: queuedMessageId,
            currentQueueId: latestQueued?.id,
            targetSessionKey: submissionOriginSessionKey,
            activeSessionKey,
            terminalSettled: settlement.terminalSettled,
            queueDisposition: settlement.queueDisposition,
          });
          if (decision !== "replay") {
            logStoreEvent(
              decision === "discard_session_deleted"
                ? "send_cancellation_barrier_queue_discarded"
                : "send_cancellation_barrier_queue_retained",
              {
                sessionKey: submissionOriginSessionKey,
                activeSessionKey,
                turnId: settlement.turnId,
                queueId: queuedMessageId,
                activeQueueId: latestQueued?.id || null,
                disposition: settlement.disposition,
                decision,
              },
            );
            return;
          }
          const started = latest.sendMessage(latestQueued!.text, latestQueued!.images, {
            ...replayOptionsWithoutSessionOrigin,
            contextMentionsSnapshot: latestQueued!.contextMentions || [],
            attachedFilesSnapshot: latestQueued!.attachedFiles || [],
            runtimeIntentOverride: latestQueued!.runtimeIntentOverride,
            goalSourceContextSnapshot: latestQueued!.goalSourceContextSnapshot,
            goalContinuationGuidance: latestQueued!.goalContinuationGuidance,
            visibleGoalSubmissionEnvelope: undefined,
            goalContinuationEnvelope: undefined,
            queuedUserMessageId: latestQueued!.id,
            submissionOriginSessionKey,
          });
          if (started) {
            get().clearQueuedUserMessage({
              expectedId: latestQueued!.id,
              disposition: "consumed",
              reason: "cancellation_barrier_run_lease_acquired",
            });
          }
          logStoreEvent("send_cancellation_barrier_replayed", {
            sessionKey: submissionOriginSessionKey,
            turnId: settlement.turnId,
            queueId: latestQueued!.id,
            started,
          });
        },
        onError: (error) => {
          const latestQueued = readCancellationQueuedMessage(get());
          logStoreEvent("send_cancellation_barrier_queue_retained", {
            sessionKey: submissionOriginSessionKey,
            queueId: queuedMessageId,
            activeQueueId: latestQueued?.id || null,
            decision: "retain_for_reconciliation",
            error: error instanceof Error ? error.message : String(error),
          });
        },
      });
      if (!deferred) {
        logStoreEvent("send_cancellation_barrier_queue_retained", {
          sessionKey: submissionOriginSessionKey,
          queueId: queuedMessageId,
          decision: "barrier_changed_before_registration",
        });
      }
      return "legacy_deferred";
    };
    const entryCancellationGate = deferCurrentSubmissionForCancellation();
    if (entryCancellationGate !== "none") {
      if (entryCancellationGate === "workspace_claim_fenced") return false;
      logStoreEvent("send_deferred_for_cancellation_barrier", {
        sessionKey: submissionOriginSessionKey,
        phase: "entry",
      });
      return true;
    }
    const pendingReviewTransition = applySubmitPendingReviewTransition({
      text,
      executionConsentGranted: options?.executionConsentGranted,
      state,
      getState: get,
      setState: set,
      closeTurnAsCanceled: (turnId, cancellationOptions) => {
        return get().closeTurnAsCanceled(turnId, cancellationOptions);
      },
      logStoreEvent,
    });
    if (pendingReviewTransition.aborted) {
      state = pendingReviewTransition.state;
      const supersededCancellationGate = deferCurrentSubmissionForCancellation();
      if (supersededCancellationGate !== "none") {
        if (supersededCancellationGate === "workspace_claim_fenced") return false;
        logStoreEvent("send_deferred_for_cancellation_barrier", {
          sessionKey: submissionOriginSessionKey,
          phase: "pending_review_superseded",
        });
        return true;
      }
    }
    const validatedVisibleGoalCreationAuthorization =
      visibleGoalSubmissionAuthorizationBroker.consume({
        envelope: options?.visibleGoalSubmissionEnvelope,
        text,
        sessionKey: visibleSubmissionSessionKey,
        isHidden: options?.hidden === true,
      });
    const consumedGoalContinuationAuthorization =
      goalContinuationAuthorizationBroker.consume({
        envelope: options?.goalContinuationEnvelope,
        text,
      });
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
      return get().runImageStudioGeneration(
        cleanText,
        images,
        options?.adoptExistingTurn ? options.workspaceInstructionClaim : undefined,
      );
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
    if (options?.queuedUserMessageId && !isExactQueuedMessageReplay({
      queuedMessageId: state.queuedUserMessage?.id,
      replayMessageId: options.queuedUserMessageId,
      queuedText: state.queuedUserMessage?.text,
      replayText: text,
      queuedSessionKey: state.queuedUserMessage?.sessionKey,
      replaySessionKey: visibleSubmissionSessionKey,
    })) {
      logStoreEvent("queued_user_message_replay_identity_mismatch", {
        queuedUserMessageId: options.queuedUserMessageId,
        activeQueuedMessageId: state.queuedUserMessage?.id || null,
        activeQueuedSessionKey: state.queuedUserMessage?.sessionKey || null,
        replaySessionKey: visibleSubmissionSessionKey,
      });
      return false;
    }
    const validatedQueuedGoalCreationAuthorization = resolveQueuedGoalCreationAuthorization({
      queuedMessageId: state.queuedUserMessage?.id,
      replayMessageId: options?.queuedUserMessageId,
      queuedText: state.queuedUserMessage?.text,
      replayText: text,
      queuedSessionKey: state.queuedUserMessage?.sessionKey,
      replaySessionKey: visibleSubmissionSessionKey,
      authorization: state.queuedUserMessage?.goalCreationAuthorization,
    });
    const queuedGoalContinuationAuthorization =
      resolveQueuedGoalContinuationAuthorization({
        queuedMessageId: state.queuedUserMessage?.id,
        replayMessageId: options?.queuedUserMessageId,
        queuedText: state.queuedUserMessage?.text,
        replayText: text,
        queuedSessionKey: state.queuedUserMessage?.sessionKey,
        replaySessionKey: visibleSubmissionSessionKey,
        authorization: state.queuedUserMessage?.goalContinuationAuthorization,
      });
    const goalContinuationAuthorization = validateGoalContinuationAuthorization({
      authorization:
        consumedGoalContinuationAuthorization || queuedGoalContinuationAuthorization,
      currentWorkspace: state.currentWorkspace,
      currentSessionId: state.currentSessionId,
      activeGoal: state.activeGoal,
      activeActionRequest: state.activeActionRequest,
    });
    const requestedGoalContinuation = !!options?.goalContinuationEnvelope ||
      (
        !!options?.queuedUserMessageId &&
        isGoalContinuationAuthorization(
          state.queuedUserMessage?.goalContinuationAuthorization,
        )
      );
    if (requestedGoalContinuation && !goalContinuationAuthorization) {
      logStoreEvent("goal_continuation_submission_rejected_stale", {
        queuedUserMessageId: options?.queuedUserMessageId || null,
        activeGoalId: state.activeGoal?.id || null,
        activeGoalRevision: state.activeGoal?.revision || null,
        sessionKey: visibleSubmissionSessionKey,
      });
      return false;
    }
    const submitPipelineDecision = buildSubmitPipelineDecision({
      text,
      images,
      options,
      validatedVisibleGoalCreationAuthorization,
      validatedQueuedGoalCreationAuthorization,
      preferredLanguage: preferredLanguage === "en" ? "en" : "zh",
      workspaceTreeForGameDetection: cachedWorkspaceTreeForGameDetection,
      createGameStudioModeSwitchDecision,
      snapshot: {
        agentStatus: state.agentStatus,
        currentTurnId: state.currentTurnId,
        currentSessionKey: sendOriginSessionKey,
        runtimeEvents: state.runtimeEvents,
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
        goalCreationAuthorization?: GoalCreationAuthorization;
        goalContinuationAuthorization?: GoalContinuationAuthorization;
        goalContinuationGuidance?: string;
      },
    ) => applySubmitSendGateEffects({
      // A busy visible /goal submission must retain the explicit shortcut so
      // its later dequeue can mint a fresh one-shot authorization. The normal
      // execution path still uses the already stripped canonical objective.
      text: submitPipelineDecision.shortcuts.goalCreationAuthorization?.source === "visible_goal_shortcut"
        ? submitPipelineDecision.originalText
        : text,
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
      closeTurnAsCanceled: (turnId, cancellationOptions) => {
        return get().closeTurnAsCanceled(turnId, cancellationOptions);
      },
      logStoreEvent,
    });
    const deferResetSubmissionForCancellation = (
      queuedWorkflowContext?: CancellationQueueContext,
    ): CancellationSubmissionGate => {
      if (!getPendingSessionCancellation(submissionOriginSessionKey)) return "none";
      return deferCurrentSubmissionForCancellation(options, {
        ...queuedWorkflowContext,
        goalCreationAuthorization:
          queuedWorkflowContext?.goalCreationAuthorization ||
          validatedVisibleGoalCreationAuthorization ||
          undefined,
        goalContinuationAuthorization:
          queuedWorkflowContext?.goalContinuationAuthorization ||
          goalContinuationAuthorization ||
          undefined,
      });
    };

    const earlyGoalCreationAuthorization =
      submitPipelineDecision.shortcuts.goalCreationAuthorization;
    const hasEarlyGoalAuthority = !!earlyGoalCreationAuthorization ||
      !!goalContinuationAuthorization;
    const shouldUseEarlyPlanSendGate =
      !!autoHydrationReason || shouldRouteContinuationToPlanResume;
    const earlyGoalQueuedWorkflowContext =
      shouldUseEarlyPlanSendGate && hasEarlyGoalAuthority
      ? {
          runtimeIntentOverride: "goal" as const,
          goalSourceContextSnapshot:
            options?.goalSourceContextSnapshot || buildGoalSourceContextSnapshot({
              objective: submitPipelineDecision.text,
              agentMessages: state.agentMessages,
              conversationTurns: state.conversationTurns,
              planArtifacts: state.planArtifacts,
            }),
          ...(earlyGoalCreationAuthorization
            ? { goalCreationAuthorization: earlyGoalCreationAuthorization }
            : {}),
          ...(goalContinuationAuthorization
            ? { goalContinuationAuthorization }
            : {}),
          ...(goalContinuationAuthorization && options?.goalContinuationGuidance?.trim()
            ? { goalContinuationGuidance: options.goalContinuationGuidance.trim() }
            : {}),
        }
      : undefined;

    // Async Plan hydration and semantic Resume both mutate Plan state before
    // they recursively submit a hidden execution prompt. Acquire the owner gate
    // before either route can run.
    if (shouldUseEarlyPlanSendGate) {
      const planResumeSendGateEffect = applyCurrentSendGate(
        state,
        earlyGoalQueuedWorkflowContext,
      );
      const earlyResetCancellationGate =
        planResumeSendGateEffect.decision.action.kind === "reset_stuck_state"
          ? deferResetSubmissionForCancellation(earlyGoalQueuedWorkflowContext)
          : "none";
      if (earlyResetCancellationGate !== "none") {
        if (earlyResetCancellationGate === "workspace_claim_fenced") return false;
        logStoreEvent("send_deferred_for_cancellation_barrier", {
          sessionKey: submissionOriginSessionKey,
          phase: "early_stuck_state_reset",
        });
        return true;
      }
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
        sendOriginSessionKey: submissionOriginSessionKey,
        sendOriginSessionEpoch: resolveActiveSessionPlanLifecycleEpoch(
          state,
          submissionOriginSessionKey,
        ),
        getState: get,
        setState: set,
        hydrateExistingPlanArtifactsForWorkspace,
        derivePlanStageFromArtifacts,
        isSessionRuntimeOwnerActive: (
          latestState,
          expectedSessionKey,
          expectedSessionEpoch,
        ) =>
          resolveVisibleGoalSubmissionSessionKey(latestState) === expectedSessionKey &&
          resolveActiveSessionPlanLifecycleEpoch(
            latestState,
            expectedSessionKey,
          ) === expectedSessionEpoch,
        resumeSubmission: (nextText, nextImages, nextOptions) => {
          const goalCreationAuthorization =
            submitPipelineDecision.shortcuts.goalCreationAuthorization;
          const carriedVisibleGoalSubmissionEnvelope =
            goalCreationAuthorization && nextOptions.hidden !== true
              ? visibleGoalSubmissionAuthorizationBroker.carryValidated({
                  text: nextText,
                  sessionKey: visibleSubmissionSessionKey,
                  authorization: goalCreationAuthorization,
                })
              : undefined;
          const carriedGoalContinuationEnvelope = goalContinuationAuthorization
            ? goalContinuationAuthorizationBroker.issueValidated({
                text: nextText,
                authorization: goalContinuationAuthorization,
              })
            : undefined;
          const refreshedGoalSourceContextSnapshot =
            goalCreationAuthorization || goalContinuationAuthorization
            ? buildGoalSourceContextSnapshot({
                objective: submitPipelineDecision.text,
                agentMessages: get().agentMessages,
                conversationTurns: get().conversationTurns,
                planArtifacts: get().planArtifacts,
              })
            : undefined;
          get().sendMessage(nextText, nextImages, {
            ...nextOptions,
            submissionOriginSessionKey,
            goalSourceContextSnapshot: refreshedGoalSourceContextSnapshot,
            visibleGoalSubmissionEnvelope: carriedVisibleGoalSubmissionEnvelope,
            goalContinuationEnvelope: carriedGoalContinuationEnvelope,
          });
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
      preferSubagents: state.preferSubagents,
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
      hasWorkspace: !!state.currentWorkspace?.trim(),
      parsedStudioCommand,
      isHidden,
      autoApproveTools: state.autoApproveTools,
      fallbackRunIntent: resolveRunIntentFromLegacyWorkflowMode(state.config.workflowMode),
      mainDebugShortcut,
      mainIntentShortcut,
      lockedComposerIntent,
      goalCreationAuthorization: submitPipelineDecision.shortcuts.goalCreationAuthorization,
      goalContinuationAuthorization,
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
          onResumeBlocked: (message) => {
            const ownerTurnId = resumeRequest.uiParentTurnId || get().currentTurnId;
            if (!ownerTurnId) return;
            set((s) => {
              const existingFinal = [...s.taskFlow].reverse().find((block) =>
                block.turnId === ownerTurnId &&
                block.type === "agent" &&
                block.visibility === "assistant_final"
              );
              const finalBlockId = existingFinal?.id ?? s._nextTaskId();
              let foundFinal = false;
              const taskFlow = s.taskFlow.map((block) => {
                if (block.id === finalBlockId && block.type === "agent") {
                  foundFinal = true;
                  return {
                    ...stripAssistantPublicProgress(block),
                    content: message,
                    streaming: false,
                    hiddenProcess: false,
                    visibility: "assistant_final" as const,
                  };
                }
                if (
                  block.turnId === ownerTurnId &&
                  block.type === "agent" &&
                  block.visibility === "assistant_final"
                ) {
                  return {
                    ...stripAssistantPublicProgress(block),
                    visibility: "assistant_update" as const,
                  };
                }
                return block;
              });
              if (!foundFinal) {
                taskFlow.push({
                  id: finalBlockId,
                  turnId: ownerTurnId,
                  type: "agent",
                  content: message,
                  streaming: false,
                  visibility: "assistant_final",
                });
              }
              return {
                taskFlow,
                conversationTurns: s.conversationTurns.map((turn) =>
                  turn.id === ownerTurnId
                    ? {
                        ...turn,
                        status: "paused" as const,
                        summary: message,
                        blockIds: turn.blockIds.includes(finalBlockId)
                          ? turn.blockIds
                          : [...turn.blockIds, finalBlockId],
                      }
                    : turn
                ),
                agentStatus: "idle",
                isGenerating: false,
                abortController: null,
              };
            });
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
      goalCreationAuthorization,
    } = intentRouting;

    const hasLivePlanApprovalCapability =
      !!state.planLifecycle.approvalLease &&
      isPlanApprovalLeaseBoundToState(state.planLifecycle);
    const requestsPlanExecution =
      effectiveRunIntent === "execute" &&
      (
        hasLivePlanApprovalCapability ||
        state.planLifecycle.status === "handoff_pending" ||
        state.planLifecycle.status === "executing"
      );
    const requiresPlanExecutionAdmission = Boolean(
      options?.planExecutionLeaseId ||
      options?.planExecutionInstructionHash ||
      requestsPlanExecution
    );
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
      goalCreationAuthorization,
      goalContinuationAuthorization,
      requiresPlanExecutionAdmission,
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

    const sendGateQueuedWorkflowContext: CancellationQueueContext | undefined =
      runtimeRunIntent === "goal"
      ? {
          runtimeIntentOverride: "goal",
          goalSourceContextSnapshot,
          ...(goalCreationAuthorization ? { goalCreationAuthorization } : {}),
          ...(goalContinuationAuthorization ? { goalContinuationAuthorization } : {}),
          ...(goalContinuationAuthorization && options?.goalContinuationGuidance?.trim()
            ? { goalContinuationGuidance: options.goalContinuationGuidance.trim() }
            : {}),
        }
      : undefined;
    const sendGateEffect = applyCurrentSendGate(
      state,
      sendGateQueuedWorkflowContext,
    );
    const resetCancellationGate =
      sendGateEffect.decision.action.kind === "reset_stuck_state"
        ? deferResetSubmissionForCancellation(sendGateQueuedWorkflowContext)
        : "none";
    if (resetCancellationGate !== "none") {
      if (resetCancellationGate === "workspace_claim_fenced") return false;
      logStoreEvent("send_deferred_for_cancellation_barrier", {
        sessionKey: submissionOriginSessionKey,
        phase: "stuck_state_reset",
      });
      return true;
    }
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
      planLifecycle: state.planLifecycle,
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
    const {
      sessionGet,
      sessionSet,
      getSessionRuntimeOwnerToken,
      hasSessionRuntimeOwnership,
      getSessionRevisionToken,
      publishOwnerScopedRuntimeProjection,
    } = createSubmitSessionRuntimeController<AppState, SessionRuntimeState>({
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
      preferSubagents: state.preferSubagents,
      effectiveRunIntent,
      isMainDebugShortcut: !!mainDebugShortcut,
      reuseCurrentTurn,
      adoptExistingTurn: options?.adoptExistingTurn,
      admittedUserBlockId: options?.admittedUserBlockId,
      reusableTurnId,
      turnIdOverride: options?.turnIdOverride,
      uiParentTurnId,
      ensuredSessionId,
      sessionScopeKey,
      optionTurnTitle: options?.turnTitle,
    });
    if (turnDraft.adoptionDecision.kind === "rejected") {
      logStoreEvent("workspace_turn_adoption_rejected_before_run", {
        sessionKey: runSessionKey,
        turnId: options?.turnIdOverride || null,
        admittedUserBlockId: options?.admittedUserBlockId ?? null,
        reason: turnDraft.adoptionDecision.reason,
      });
      return false;
    }
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
    const localSlashRuntimeOwnerToken = getSessionRuntimeOwnerToken();
    const workspaceInstructionClaim = options?.workspaceInstructionClaim || null;
    const localSlashAbortController = new AbortController();
    const localSlashBridge = createGameStudioLocalSlashBridge({
      sessionGet,
      sessionSet,
      nextTaskId: nextId,
      text,
      turnId,
      userContextItems,
      isHidden,
      reuseCurrentTurn,
      adoptExistingTurn: options?.adoptExistingTurn,
      admittedUserBlockId: options?.admittedUserBlockId,
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
      runSessionKey,
      titleIntentSignature,
      sanitizeTaskBlocksForPersist,
      normalizeSessionRuntimeSnapshot: sanitizeSessionRuntimeSnapshotForPersist,
      commitLocalSlashProjection: (context) => {
        if (!isHidden && ensuredSessionId != null) {
          sessionGet().updateSession(sessionScopeKey, ensuredSessionId, {
            storageStatus: "temporary",
          });
        }
        return commitGameStudioLocalSlashProjection({
          context,
          claim: workspaceInstructionClaim,
          sessionGet,
          getSessionRevisionToken,
          hasSessionRuntimeOwnership: () =>
            hasSessionRuntimeOwnership(localSlashRuntimeOwnerToken),
          scopeKey: sessionScopeKey,
          sessionId: ensuredSessionId,
          decorateProjection: (projectedState, commitContext) => {
            if (isHidden || ensuredSessionId == null) return projectedState;
            const sessions = projectedState.sessionsByWorkspace[sessionScopeKey] || [];
            const maySeedTitle = commitContext.includeTitle &&
              shouldSeedSessionTitleForTurn &&
              projectedState.currentTurnId === turnId;
            return {
              ...projectedState,
              sessionsByWorkspace: {
                ...projectedState.sessionsByWorkspace,
                [sessionScopeKey]: sessions.map((candidate) =>
                  candidate.id === ensuredSessionId
                    ? {
                        ...candidate,
                        ...(maySeedTitle
                          ? {
                              title: turnTitle,
                              titleSource: "local_seed" as const,
                              titleIntentSignature,
                            }
                          : {}),
                        // `ok` is owned by the Rust save response. Until that
                        // boundary this projection is explicitly temporary.
                        storageStatus: "temporary" as const,
                        recordingDisabled:
                          !projectedState.config.sessionRecordingEnabled ||
                          candidate.recordingDisabled === true,
                      }
                    : candidate
                ),
              },
            };
          },
          persistProjection: async (projectedState, expectedRevisionToken) =>
            persistSubmitRuntimeProjection({
              state: projectedState,
              scopeKey: sessionScopeKey,
              sessionId: ensuredSessionId,
              sanitizeTaskBlocksForPersist,
              buildRuntimeSnapshot: buildSessionRuntimeSnapshotFromStoreState,
              persistSessionRecord: async (scopeKey, sessionRecord) => {
                try {
                  return await saveProjectSession(scopeKey, sessionRecord, {
                    isCurrent: () =>
                      hasSessionRuntimeOwnership(localSlashRuntimeOwnerToken) &&
                      getSessionRevisionToken() === expectedRevisionToken,
                  });
                } catch (error) {
                  // An external writer may have advanced SQLite's CAS
                  // revision. Refresh both the IPC cache and the in-memory
                  // Session metadata before the durability loop retries.
                  if (ensuredSessionId != null) {
                    try {
                      const meta = await loadProjectSessionMeta(scopeKey, ensuredSessionId);
                      if (typeof meta?.storageRevision === "number") {
                        sessionGet().updateSession(scopeKey, ensuredSessionId, {
                          storageRevision: meta.storageRevision,
                        });
                      }
                    } catch {
                      // Preserve the original persistence error and retry with
                      // exponential backoff; metadata refresh is best effort.
                    }
                  }
                  throw error;
                }
              },
              nowMs,
            }),
          buildMemoryFallbackProjection: (projectedState) =>
            buildTemporarySubmitRuntimeProjection({
              state: projectedState,
              scopeKey: sessionScopeKey,
              sessionId: ensuredSessionId,
              sanitizeTaskBlocksForPersist,
              buildRuntimeSnapshot: buildSessionRuntimeSnapshotFromStoreState,
              nowMs,
            }),
          rememberDurableState: (durableState) => {
            if (ensuredSessionId == null) return;
            const durableRecord = (
              durableState.sessionsByWorkspace[sessionScopeKey] || []
            ).find((candidate) => candidate.id === ensuredSessionId);
            const requiresSessionDurability =
              durableState.config.sessionRecordingEnabled &&
              durableRecord?.recordingDisabled !== true;
            if (
              requiresSessionDurability &&
              (!durableRecord || !(Number(durableRecord.storageRevision) > 0))
            ) {
              throw new Error("LOCAL_SLASH_DURABLE_STORAGE_REVISION_MISSING");
            }
            if (!durableRecord) return;
            const latestRecord = (
              sessionGet().sessionsByWorkspace[sessionScopeKey] || []
            ).find((candidate) => candidate.id === ensuredSessionId);
            sessionGet().updateSession(sessionScopeKey, ensuredSessionId, {
              ...(typeof durableRecord.storageRevision === "number"
                ? {
                    storageRevision: Math.max(
                      Number(latestRecord?.storageRevision) || 0,
                      durableRecord.storageRevision,
                    ),
                  }
                : {}),
              storageStatus: requiresSessionDurability ? "ok" : "temporary",
              recordingDisabled: !requiresSessionDurability,
            });
          },
          publishProjection: publishOwnerScopedRuntimeProjection,
          abortSignal: localSlashAbortController.signal,
          log: logStoreEvent,
        });
      },
    });

    const localSlashSubmission = startGameStudioLocalSlashSubmission({
      command: parsedStudioCommand,
      preferredLanguage: preferredLanguage === "en" ? "en" : "zh",
      runSessionKey,
      turnId,
      runtimeService: gameStudioRuntimeService,
      getGameStudioInitialized: () => sessionGet().gameStudioInitialized,
      commitActiveStudioAgentKey: (agent, commitOptions) => {
        // JavaScript cannot interleave an AbortSignal event between this check
        // and the synchronous state mutation at the start of the Store setter.
        // That call is therefore the local side-effect commit point.
        if (localSlashAbortController.signal.aborted) {
          const error = new Error("Local slash command canceled before side-effect commit");
          error.name = "AbortError";
          throw error;
        }
        return sessionGet().setActiveStudioAgentKey(agent, commitOptions);
      },
      appendLocalStudioTurn: localSlashBridge.appendLocalStudioTurn,
      ensureVisibleConclusion: localSlashBridge.ensureVisibleConclusion,
      emitRuntimeEvent: localSlashBridge.emitLocalSlashRuntimeEvent,
      logStoreEvent,
      runId: options?.runIdOverride,
      parentRunId: options?.parentRunIdOverride ?? null,
      abortSignal: localSlashAbortController.signal,
    });
    if (localSlashSubmission.handled) {
      if (!localSlashSubmission.runId || !localSlashSubmission.completion) {
        throw new Error("Handled local slash submission did not expose an execution lease");
      }
      // Local-fast commands may await workspace metadata before appending their
      // conclusion. Mark the exact admitted Turn as the live owner immediately
      // so the FIFO dispatcher cannot mistake the accepted command for a
      // synchronous ActionDecision and close it ahead of its real result.
      sessionSet((current) => ({
        currentTurnId: turnId,
        conversationTurns: current.conversationTurns.map((turn: ConversationTurn) =>
          turn.id === turnId && !isConversationTurnRuntimeClosed(turn.runtimeOutcome)
            ? { ...turn, status: "executing" as const }
            : turn
        ),
        isGenerating: true,
        agentStatus: "running",
        abortController: localSlashAbortController,
      }));
      const claim = workspaceInstructionClaim;
      const ownerKey = localFastExecutionOwnerKey(runSessionKey, turnId);
      let lease!: LocalFastExecutionLease;
      const retireWorkspaceClaim = () => {
        if (!claim) return true;
        let retired = false;
        sessionSet((current) => {
          const queue = current.workspaceTurnQueue;
          const activeHead = queue?.entries[0];
          if (
            !queue ||
            queue.sessionKey !== claim.sessionKey ||
            queue.sessionEpoch !== claim.sessionEpoch ||
            activeHead?.status !== "dispatching" ||
            activeHead.claim?.claimId !== claim.claimId ||
            activeHead.receipt.receiptId !== claim.receiptId ||
            activeHead.receipt.clientSubmissionId !== claim.clientSubmissionId ||
            activeHead.receipt.turnId !== claim.turnId ||
            workspaceInstructionEnvelopeIdentity(activeHead) !==
              claim.instructionEnvelopeIdentity
          ) return {};
          const transition = reduceWorkspaceTurnQueue(queue, {
            type: "remove",
            expectedVersion: queue.version,
            at: Date.now(),
            claimId: claim.claimId,
            sessionKey: claim.sessionKey,
            sessionEpoch: claim.sessionEpoch,
            terminalOwner: {
              sessionKey: claim.sessionKey,
              sessionEpoch: claim.sessionEpoch,
              turnId: claim.turnId,
              receiptId: claim.receiptId,
              clientSubmissionId: claim.clientSubmissionId,
              instructionEnvelopeIdentity: claim.instructionEnvelopeIdentity,
            },
          });
          if (transition.disposition !== "applied") return {};
          retired = true;
          return { workspaceTurnQueue: transition.state };
        });
        return retired;
      };
      const releaseLease = () => {
        if (lease.settled) return;
        lease.settled = true;
        if (localFastExecutionLeasesByOwner.get(ownerKey) === lease) {
          localFastExecutionLeasesByOwner.delete(ownerKey);
        }
        if (claim && localFastExecutionLeasesByClaim.get(claim.claimId) === lease) {
          localFastExecutionLeasesByClaim.delete(claim.claimId);
        }
        sessionSet((current) => {
          const exactTurnIdentity = !claim || current.conversationTurns.some(
            (candidate: ConversationTurn) =>
              candidate.id === turnId &&
              candidate.clientSubmissionId === claim.clientSubmissionId &&
              candidate.workspaceInstructionReceiptId === claim.receiptId,
          );
          return exactTurnIdentity &&
              current.currentTurnId === turnId &&
              current.abortController === localSlashAbortController
            ? {
                abortController: null,
                isGenerating: false,
                agentStatus: "idle",
              }
            : {};
        });
      };
      lease = {
        sessionKey: runSessionKey,
        turnId,
        runId: localSlashSubmission.runId,
        clientSubmissionId: claim?.clientSubmissionId || null,
        receiptId: claim?.receiptId || null,
        controller: localSlashAbortController,
        claim,
        completion: localSlashSubmission.completion,
        hasRuntimeOwnership: () =>
          hasSessionRuntimeOwnership(localSlashRuntimeOwnerToken),
        retireWorkspaceClaim,
        release: releaseLease,
        settled: false,
        dispatcherObserved: false,
      };
      localFastExecutionLeasesByOwner.set(ownerKey, lease);
      if (claim) localFastExecutionLeasesByClaim.set(claim.claimId, lease);
      // Workspace claims are released only by the dispatcher's owner-scoped
      // verifier. Registering an eager cleanup here races that verifier because
      // Promise callbacks run in registration order. Direct (non-workspace)
      // local-fast submissions have no FIFO owner and may clean themselves up.
      if (!claim) {
        void localSlashSubmission.completion.then(releaseLease, releaseLease);
      }
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
      adoptExistingTurn: options?.adoptExistingTurn,
      admittedUserBlockId: options?.admittedUserBlockId,
      uiParentTurnId,
      parentPlanTurnId,
      isInternalTurn,
      shouldExplicitlyReuseCurrentTurn,
      shouldAutoResumeChoiceTurn,
      currentTurnHasReplyOptions,
      explicitReplyOptionSourceTurnId: !isHidden ? options?.replyOptionSourceTurnId : undefined,
      selectedReplyOptionText: options?.selectedReplyOptionText,
      submittedChoiceIdentity: !isHidden ? options?.replyOptionRequestIdentity : undefined,
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
      requiresPlanExecutionAdmission,
    });
    if (visibleTurnSubmission.adoptionDecision.kind === "rejected") {
      return false;
    }
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
      goalCreationAuthorization,
      goalContinuationAuthorization,
      activateGoalContinuation: ({ authorization, ownerTurnId, timestampMs }) => {
        let accepted = false;
        sessionSet((state: AppState) => {
          const progress = state.goalProgress || state.goalRuntime?.progress || (
            state.activeGoal
              ? createGoalProgress(state.activeGoal.id, "")
              : null
          );
          const transition = buildAcceptedGoalContinuationState({
            goal: state.activeGoal,
            progress,
            runtime: state.goalRuntime,
            authorization,
            ownerTurnId,
            nowMs: timestampMs,
          });
          if (!transition) return {};
          accepted = true;
          if (!transition.transitioned) return {};
          return {
            activeGoal: transition.goal,
            goalProgress: transition.progress,
            goalStatus: "active" as const,
            goalRuntime: transition.runtime,
            activeActionRequest: clearGoalConfirmationActionRequest(
              state.activeActionRequest,
              transition.goal.id,
              transition.goal.revision || 1,
            ),
            runtimeEvents: appendRuntimeEvent(state.runtimeEvents, withEventSchema({
              type: "goal.state_changed",
              threadId: runSessionKey,
              turnId: ownerTurnId,
              timestampMs,
              goalId: transition.goal.id,
              from: transition.previousStatus,
              to: "active",
              phase: "re_plan",
              reason: "resume_run_lease_acquired",
            })),
          };
        });
        if (accepted) {
          logStoreEvent("goal_resume_run_lease_accepted", {
            goalId: authorization.goalId,
            goalRevision: authorization.goalRevision,
            previousOwnerTurnId: authorization.ownerTurnId,
            ownerTurnId,
            sessionKey: runSessionKey,
          });
        }
        return accepted;
      },
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
      planExecutionLeaseId: options?.planExecutionLeaseId,
      planExecutionInstructionHash: options?.planExecutionInstructionHash,
      requiresPlanExecutionAdmission,
      turnInputContextSignals,
      remoteFeishu,
      options,
      isHidden,
      createVisibleTurnForHiddenMessage,
      nextTaskId: nextId,
      sessionGet,
      sessionSet,
      getSessionRuntimeOwnerToken,
      hasSessionRuntimeOwnership,
      getSessionRevisionToken,
      publishOwnerScopedRuntimeProjection,
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
      readHarnessRunMarker,
      acquireHarnessRunMarker,
      persistHarnessRunMarkerIfOwned,
      getWorkspaceTree,
      nowMs,
      sendStartedAt,
      getLastTurnToolSummary,
      getLastVisibleTurnAgentSummary,
      persistBootstrapProjection: (projectedState) => persistSubmitRuntimeProjection({
        state: projectedState,
        scopeKey: runScopeKey,
        sessionId: runSessionId,
        sanitizeTaskBlocksForPersist,
        buildRuntimeSnapshot: buildSessionRuntimeSnapshotFromStoreState,
        persistSessionRecord: saveProjectSession,
        nowMs,
      }),
      PLAN_EXECUTION_PROGRESS_DEFAULT_MAX_ITERATIONS,
      PROVIDER_COMPATIBILITY_FORCE_XML_TTL_MS,
      PROVIDER_COMPATIBILITY_NATIVE_RECOVERY_SUCCESS_STREAK,
      sanitizeTaskBlocksForPersist,
      sanitizeAgentMessagesForPersist,
      normalizeSessionRuntimeSnapshot: sanitizeSessionRuntimeSnapshotForPersist,
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
                  runId: marker.activeRunId || marker.runId || undefined,
                  parentRunId: marker.activeParentRunId || marker.parentRunId || null,
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
          }, {
            restoreInterruptedGoal: true,
            quarantineInterruptedLocalFast: true,
            workspacePath: hydratedCurrentScopeKey,
            expectedSessionKey: resolveSessionRuntimeKey(
              hydratedCurrentScopeKey,
              hydratedCurrentSession?.id || null,
            ),
            expectedSessionEpoch: hydratedCurrentSession?.planLifecycleEpoch || null,
          })
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
        workspaceTurnQueue: normalizedHydratedRuntime?.workspaceTurnQueue || null,
        workspaceInstructionLedger: normalizedHydratedRuntime?.workspaceInstructionLedger || [],
        transcriptPartial: normalizedHydratedRuntime?.transcriptPartial === true,
        transcriptLoadedTurns: Math.max(
          0,
          Number(normalizedHydratedRuntime?.transcriptLoadedTurns) || 0,
        ),
        transcriptTotalTurns: Math.max(
          0,
          Number(normalizedHydratedRuntime?.transcriptTotalTurns) || 0,
        ),
        lockedComposerIntent: sanitizeHydratedLockedComposerIntent(
          persistedState.lockedComposerIntent,
        ) as MainIntentShortcut | null,
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
        preferSubagents: normalizedHydratedRuntime?.preferSubagents === true,
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
