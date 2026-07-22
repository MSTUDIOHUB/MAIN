import { type OpenAiToolChoice, type StreamResult } from "../streaming";
import type { ContextMemoryState } from "../contextMemory";
import { type MCPServer, type MCPTool } from "../mcpClient";
import { type ToolDiffPreview } from "../toolDiff";
import { type SessionAutoApproveScope, type ToolLifecycleState } from "../runtimeTools";
import type { AppConfig, Skill } from "../appTypes";
import { type PlanArtifact, type PlanArtifactQualityResult, type PlanArtifactRecoveryAction, type PlanExecutionEvidenceEntry, type PlanExecutionProgressUpdate, type PlanTask, type ReplyOption } from "../workflowModels";
import type { MainModeKey } from "../mainModes";
import { type CommandDirective, type ResolvedUserIntent } from "../runIntent";
import { type ResolvedInstructionSet } from "../instructions";
import { type HookDefinition, type HookExecutionRecord, type HookEvent } from "../hooks";
import type { PendingSlashCommand, StudioAgentKey, StudioConfig } from "../gameStudio/catalog";
import { type PlanMaxIterationsCheckpoint, type PlanToolActivitySummary } from "../planExecutionRecovery";
import {
  type ExecuteRecoveryContractPhase,
  type ExecuteRecoveryMode,
  type ExecutionDecisionCheckpoint,
  type PatchRecoveryMismatchEvidence,
  type RecoveryReadLease,
} from "../executeRecoveryTools";
import { type MainThreadEvent } from "../turnEvents";
import { type PlanMaterializationSource } from "../planMaterialization";
import { type ProgressNarration } from "../progressNarration";
import type { ShellPermissionApproval, ShellPermissionDecision } from "../ipc";
import type { ToolRiskLevel } from "../toolCapabilities";
import type { ToolCatalogSource } from "../toolCatalog";
import { type TurnInputContextSignals } from "../turnIntake";
import type {
  RuntimeTraceContext,
  SpawnSubagentRequest,
  SpawnSubagentResult,
  SubagentExecutionScope,
  WaitSubagentsRequest,
  WaitSubagentsResult,
} from "../subagents";
export type {
  AgentLoopOutcome,
  AgentLoopOutcomeStatus,
  AgentLoopPauseKind,
  AgentLoopResultKind,
} from "../runOutcome";

export interface ToolCallInMessage {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface TextContentPart {
  type: "text";
  text: string;
}

export interface ImageUrlContentPart {
  type: "image_url";
  image_url: { url: string };
}

export interface AgentMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ContentPart[];
  tool_calls?: ToolCallInMessage[];
  tool_call_id?: string;
  reasoning_content?: string;
  reasoning?: string;
}

export type MaxIterationsCheckpointHandling =
  | boolean
  | {
      status: "auto_resume_scheduled";
      checkpoint: PlanMaxIterationsCheckpoint;
    };

export type ToolFailureKind = "actual" | "policy";

export interface ToolCatalogIdentity {
  /** Runtime-owned registration source. External tool output cannot set this value. */
  source: ToolCatalogSource | "unknown";
  /** Stable catalog name used to resolve this invocation. */
  canonicalName: string;
}

export interface ToolErrorLifecycleMeta {
  toolCallId?: string;
  /** Runtime-resolved backend name; keep the provider-facing name for display only. */
  executionName?: string;
  /** Runtime-owned catalog provenance for the resolved invocation. */
  catalogIdentity?: ToolCatalogIdentity;
  /** Observed workspace mutation even when the executor ultimately failed. */
  diff?: ToolDiffPreview;
  workspaceMutationEvidence?: {
    changedPaths: string[];
    diff?: ToolDiffPreview;
  };
  qualityGateReason?: string | null;
  planRecoveryReason?: string | null;
  failureKind?: ToolFailureKind;
  internalFeedback?: boolean;
}

export interface OrchestratorCallbacks {
  // State accessors
  getMessages: () => AgentMessage[];
  getConfig: () => AppConfig;
  getPreferredLanguage: () => "zh" | "en";
  getSkills: () => Skill[];
  getMainModeKey: () => MainModeKey;
  getActiveStudioAgentKey: () => StudioAgentKey;
  getGameStudioInitialized: () => boolean;
  getPendingSlashCommand: () => PendingSlashCommand | null;
  getGameStudioConfig?: () => StudioConfig | null;
  getWorkspaceTree: () => string;
  getMcpServers: () => MCPServer[];
  getMcpDiscoveredTools: () => MCPTool[];
  getWebSearchEnabled?: () => boolean;
  getWebSearchProvider?: () => string;
  getEnabledKnowledgeBaseIds?: () => string[];
  getAssociatedPaths: () => string[];
  getSessionKey: () => string;
  getCurrentTurnId?: () => string | null;
  getCurrentRunIdentity?: () => {
    runId: string;
    parentRunId: string | null;
    goalSliceId?: string;
  };
  getSubagentDepth?: () => number;
  getSubagentScope?: () => SubagentExecutionScope | null;
  getRuntimeTraceContext?: () => RuntimeTraceContext;
  hasSessionHookInitialized: (sessionKey: string) => boolean;
  markSessionHookInitialized: (sessionKey: string) => void;
  // Planning & Management
  getCurrentRunIntent: () => ResolvedUserIntent;
  getRuntimeRunIntent?: () => ResolvedUserIntent;
  getGoalTurnContract?: () => import("../goalState").GoalTurnContract | null;
  getExecutionConsentGranted?: () => boolean;
  getForcedExecuteRecoveryMode?: () => ExecuteRecoveryMode | null;
  getForcedExecuteRecoveryState?: () => {
    mode: ExecuteRecoveryMode;
    reason?: string | null;
    expectedTarget?: string | null;
    attempts?: number;
    phase?: ExecuteRecoveryContractPhase;
    phaseNoProgressCount?: number;
    protocolNoProgressCount?: number;
    protocolNoProgressFingerprint?: string | null;
    readLease?: RecoveryReadLease | null;
    sourceObservationKey?: string | null;
    decisionCheckpoint?: ExecutionDecisionCheckpoint | null;
  } | null;
  getCommandDirective?: () => CommandDirective | null;
  getWorkflowMode: () => "chat" | "edit" | "plan";
  getIsPlanApproved: () => boolean;
  getPlanApprovalChoice: () => string | null;
  getReadOnlyAutoApproveForSession: () => boolean;
  getApprovedLocalFileReadPaths: () => string[];
  getAutoApproveToolScopes?: () => SessionAutoApproveScope[];
  getPlanStage: () => "idle" | "plan" | "requirements" | "design" | "tasks" | "bugfix" | "ready_to_execute" | "executing" | "completed";
  getPlanArtifacts?: () => PlanArtifact[];
  getPlanTasks: () => PlanTask[];
  getPlanExecutionEvidenceLedger: () => PlanExecutionEvidenceEntry[];
  getPlanAutoResumeCount?: () => number;
  getIsApprovedPlanExecutionTransitionPending?: () => boolean;
  getStatus: () => "idle" | "running" | "pending_review" | "error";
  consumeActiveGuidance?: () => { id: string; text: string; turnId: string | null } | null;
  onGuidanceInjected?: (text: string) => void;
  startNewTurn: () => void;
  getContextMemoryState?: () => ContextMemoryState | null;
  shouldForceXmlForProviderCompatibility?: () => boolean;
  onProviderCompatibilityFallback?: (reason: string) => void;
  onProviderNativeToolSuccess?: () => void;
  onToolSurfaceResolved?: (availableToolNames: string[]) => void;
  onDebugEvent?: (event: string, data?: Record<string, unknown>) => void;
  onModelUsage?: (usage: NonNullable<import("../streaming").StreamResult["usage"]>) => void;
  onExecuteRecoveryStateChange?: (state: {
    mode: ExecuteRecoveryMode;
    reason: string;
    expectedTarget: string | null;
    attempts: number;
    phase: ExecuteRecoveryContractPhase;
    phaseNoProgressCount: number;
    protocolNoProgressCount: number;
    protocolNoProgressFingerprint: string | null;
    readLease: RecoveryReadLease | null;
    sourceObservationKey: string | null;
    decisionCheckpoint: ExecutionDecisionCheckpoint | null;
  }) => void;
  evaluateGoalToolResultCheckpoint?: (results: ToolExecutionResult[]) => {
    complete: boolean;
    reasons: string[];
    evidenceCount: number;
    supportingEvidenceIds: string[];
  };
  getPendingSubagentIds?: () => string[];
  runSubagent?: (
    request: SpawnSubagentRequest,
    options?: { signal?: AbortSignal },
  ) => Promise<SpawnSubagentResult>;
  waitSubagents?: (
    request: WaitSubagentsRequest,
    options?: { signal?: AbortSignal },
  ) => Promise<WaitSubagentsResult>;

  // Goal Mode Support
  onGoalProgressUpdate?: (progress: import("../goalState").GoalProgress, goal: import("../goalState").GoalDefinition) => void;
  onGoalRuntimeUpdate?: (runtime: import("../goalState").GoalRuntimeSnapshot) => void;
  onGoalIterationStart?: (iteration: import("../goalState").GoalIteration) => void;
  onGoalIterationEnd?: (iteration: import("../goalState").GoalIteration) => void;
  onGoalCheckpointSaved?: (checkpoint: import("../goalState").GoalCheckpoint) => void;
  onGoalUserConfirmNeeded?: (message: string) => Promise<boolean>;
  onGoalOutcome?: (outcome: import("../goalState").GoalLoopOutcome) => void;

  // UI updates
  onStreamToken: (token: string, messageId: string) => void;
  onStreamDone: (
    fullText: string,
    messageId: string,
    truncated: boolean,
    meta?: {
      suppressTruncationWarning?: boolean;
      reason?: string;
      streamDiagnostics?: StreamResult["streamDiagnostics"];
    },
  ) => void;
  onThought: (thought: string) => void;
  /** Durable, user-visible progress commentary. This is not a terminal answer. */
  onAssistantCommentary?: (
    text: string,
    meta?: {
      visibility: "assistant_update";
      modelAuthored?: boolean;
      progress?: ProgressNarration;
      toolCalls?: Array<{ id?: string; name: string; target: string }>;
    },
  ) => void;
  onAssistantFinalText: (
    text: string,
    replyOptions?: ReplyOption[],
    meta?: {
      hasToolCalls?: boolean;
      hiddenThought?: string;
      visibility?: "user_progress" | "hidden_process" | "assistant_update" | "stage_summary" | "substantive_plan_text";
      preserveAssistantText?: boolean;
      capsuleCandidate?: boolean;
      modelAuthored?: boolean;
      progress?: ProgressNarration;
      toolCalls?: Array<{ id?: string; name: string; target: string }>;
      awaitingInput?: boolean;
    },
  ) => void;
  onStatusChange: (status: "idle" | "running" | "pending_review" | "error") => void;
  onError: (error: string) => void;
  onNonActionableStop: (
    message: string,
    reason: "no_output" | "no_action" | "missing_tool_loop" | "incomplete_plan",
    progress?: Partial<PlanExecutionProgressUpdate>,
  ) => void;
  onPlanArtifactUpdated: (path: string, content: string, kind: "plan" | "requirements" | "design" | "tasks" | "bugfix") => void;
  onPlanArtifactRejected?: (
    path: string,
    kind: "plan" | "requirements" | "design" | "tasks" | "bugfix",
    reason: string,
  ) => void;
  onPlanStageChanged: (stage: "idle" | "plan" | "requirements" | "design" | "tasks" | "bugfix" | "ready_to_execute" | "executing" | "completed") => void;
  onPlanApprovalInvalidated?: (reason: string) => void;
  onPlanTasksUpdated: (content: string) => void;
  onPlanExecutionProgress?: (progress: PlanExecutionProgressUpdate) => void;
  /** A fixed, user-safe plan drafting narration. Raw phases stay in the loop. */
  onPlanRuntimeNarration?: (narration: string | null) => void;
  onPlanMaxIterationsCheckpoint?: (
    checkpoint: PlanMaxIterationsCheckpoint,
  ) => MaxIterationsCheckpointHandling | Promise<MaxIterationsCheckpointHandling>;
  onExecuteMaxIterationsCheckpoint?: (
    checkpoint: PlanMaxIterationsCheckpoint,
  ) => MaxIterationsCheckpointHandling | Promise<MaxIterationsCheckpointHandling>;
  onChatMaxIterationsCheckpoint?: (
    checkpoint: PlanMaxIterationsCheckpoint,
  ) => MaxIterationsCheckpointHandling | Promise<MaxIterationsCheckpointHandling>;
  onTurnSummaryReady: (summary: string) => void;
  onExecutionDigestUpdate?: (summary: string) => void;
  onTurnRuntimePhaseChanged?: (phase: {
    id: string;
    kind: "scope" | "context" | "diagnosis" | "implementation" | "validation";
    title: string;
    summary?: string;
    domain?: string;
    status?: "pending" | "running" | "done" | "failed";
    reason?: string;
    iteration?: number;
    qualityRejectCount?: number;
  }) => void;
  onTurnEvent?: (event: MainThreadEvent) => void;
  hasRuntimeThreadStarted?: (threadId: string) => boolean;
  onHarnessRunUpdate?: (patch: Record<string, unknown>) => void;
  onInstructionsResolved: (resolved: ResolvedInstructionSet) => void;
  onHooksLoaded: (hooks: HookDefinition[], loadedAt?: number | null) => void;
  onHookStart: (event: HookEvent, hook: HookDefinition) => void;
  onHookResult: (record: HookExecutionRecord) => void;
  onHookBlocked: (event: HookEvent, reason: string, record?: HookExecutionRecord) => void;

  // Message history management
  appendMessage: (msg: AgentMessage) => void;
  replaceMessages: (msgs: AgentMessage[]) => void;
  onContextMemoryBuilt?: (state: ContextMemoryState, packet: string) => void;
  onContextCompress: (
    stats: {
      droppedCount: number;
      droppedMessageCount?: number;
      tokenCountBefore: number;
      tokenCountAfter: number;
      tokenReduction: number;
      compressedContext?: string;
      displaySummary?: string;
      memoryPacket?: string;
      microCompactionKind?: "none" | "tool_results" | "assistant_messages" | "mixed";
      microCompactedCount?: number;
      tokenBreakdown?: {
        topSourceLabel: string;
        topSourceTokens: number;
        total: number;
      };
    },
    reason: "proactive" | "reactive" | "execute_recovery",
  ) => void;

  // Tool execution UI feedback
  onToolExecuting: (
    toolName: string,
    target: string,
    diff?: ToolDiffPreview,
    meta?: { toolCallId?: string; executionName?: string; catalogIdentity?: ToolCatalogIdentity },
  ) => void;
  onToolDone: (
    toolName: string,
    target: string,
    result: string,
    meta?: {
      toolCallId?: string;
      executionName?: string;
      catalogIdentity?: ToolCatalogIdentity;
      diff?: ToolDiffPreview;
      internalFeedback?: boolean;
      qualityGateReason?: string | null;
      /** Exact structured payload for evidence parsing when the UI result is truncated. */
      evidenceResult?: string;
    },
  ) => void;
  /** Structured post-execution observation used by non-UI evidence collectors. */
  onToolResultObserved?: (result: ToolExecutionResult) => void;
  onToolError: (
    toolName: string,
    target: string,
    error: string,
    meta?: ToolErrorLifecycleMeta,
  ) => void;

  // Human-in-the-loop — only for write/execute tools.
  // Read-only tools are auto-executed by the orchestrator.
  requestReview: (toolCall: {
    toolCallId?: string;
    name: string;
    arguments: Record<string, unknown>;
    risk?: ToolRiskLevel;
    localFileReadPath?: string;
    shellPermissionDecision?: ShellPermissionDecision;
  }) => Promise<ReviewDecision>;
}

export interface FetchLLMStreamOptions {
  noVisibleTokenTimeoutMs?: number;
  noVisibleTokenTimeoutLabel?: string;
  maxStreamElapsedMs?: number;
  maxStreamElapsedLabel?: string;
  toolChoice?: OpenAiToolChoice;
  workflowMode?: string;
  runtimeIntent?: string;
  responseFormat?: Record<string, unknown>;
}

export interface ToolCallToExecute {
  id: string;
  name: string;
  arguments: string;
}

export interface ToolExecutionResult {
  toolCallId: string;
  name: string;
  /** Runtime-resolved backend tool name; provider-facing aliases are not execution identity. */
  executionName?: string;
  /** Runtime-owned registration provenance; absent/unknown identities are never trusted as built-ins. */
  catalogIdentity?: ToolCatalogIdentity;
  /** Final runtime-owned arguments after compatibility resolution and PreToolUse hooks. */
  executedArgs?: Record<string, unknown>;
  target: string;
  content: string; // model-facing result or error message
  displayContent?: string; // UI-facing result, can differ from model-facing content
  /** Exact runtime-owned payload for structured evidence parsing when content is truncated. */
  runtimeEvidenceContent?: string;
  isError: boolean;
  /** Runtime-owned child registration outcome; do not reconstruct this from model-facing text. */
  subagentSpawnOutcome?: SpawnSubagentResult;
  lifecycleState?: ToolLifecycleState;
  /** The backend invocation was entered; failure may still have produced side effects. */
  executionAttempted?: boolean;
  /** Workspace-side-effect disposition is independent from execution success. */
  workspaceEffect?: "none" | "verified" | "possible" | "partial";
  additionalContexts?: string[];
  internalFeedback?: boolean;
  /** Observed workspace change owned by the runtime, never inferred from tool prose. */
  workspaceMutationEvidence?: {
    changedPaths: string[];
    diff?: ToolDiffPreview;
  };
  qualityGateReason?: string;
  planRecoveryAction?: PlanArtifactRecoveryAction;
  missingPlanSections?: string[];
  /** Internal identity for one versioned read_file request window. */
  readFileObservation?: import("./fileReadCache").FileReadObservationIdentity;
  /** Runtime-owned observations for one safely fanned-out scoped read call. */
  scopedReadObservations?: Array<{
    sourcePath: string;
    content: string;
    negative: boolean;
  }>;
  /** Runtime-owned coverage truth for a safely fanned-out scoped read. */
  scopedReadCoverage?: {
    requiredPaths: string[];
    coveredPaths: string[];
    failedPaths: string[];
  };
  patchRecoveryMismatch?: PatchRecoveryMismatchEvidence;
  /** Structured workspace mutation preflight outcome; never inferred from localized text. */
  mutationPreflightReason?: import("../workspaceMutationPreflight").WorkspaceMutationPreflightReason;
  /** Structured policy identity for an out-of-scope approved-Plan mutation. */
  approvedPlanScopeConflict?: {
    requestedTargets: string[];
    unexpectedTargets: string[];
    plannedTargets: string[];
  };
}

export interface PlanMaterializationResultForLoop {
  ok: boolean;
  path?: string;
  kind?: "plan" | "design";
  content?: string;
  reason?: string;
  source?: PlanMaterializationSource;
  quality?: PlanArtifactQualityResult;
  toolResult?: ToolExecutionResult;
}

export interface CachedReadOnlyToolResult {
  name: string;
  target: string;
  content: string;
}

export interface ExecuteToolLifecycleOptions {
  allowExternalLocalRead?: boolean;
  shellPermissionApproval?: ShellPermissionApproval;
  turnContext?: TurnInputContextSignals;
  recentPlanToolActivity?: PlanToolActivitySummary[];
  attemptedPlanWriteTargets?: string[];
}

export type ContentPart = TextContentPart | ImageUrlContentPart;

export type ReviewDecision =
  | { action: "accept"; grantLocalFileReadPath?: string; shellPermissionApproval?: ShellPermissionApproval }
  | { action: "reject" }
  | { action: "error"; error: string };
