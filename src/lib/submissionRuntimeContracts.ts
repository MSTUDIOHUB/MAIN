import type { AttachedFile } from "./attachments";
import type { StudioConfig as GameStudioConfig } from "./gameStudio/catalog";
import type { PlanExecutionRunProvenance } from "./planExecutionProvenance";
import type { FeishuRemoteContext } from "./remoteContextTypes";
import type { CommandDirective, ResolvedRunIntent } from "./runIntent";
import type { PlanApprovalHandoff, ProviderCompatibilityRuntimeLaneState } from "./sessionTypes";
import type { TaskBlock } from "./taskTypes";
import type { TurnInputContextSignals } from "./turnIntake";
import type { DurableTurnContext } from "./workflowModels";
import type {
  GoalContinuationAuthorization,
  GoalCreationAuthorization,
} from "./submit/turnSubmission";

type SubmissionStoreState = any;

export interface SubmissionRuntimeStorePorts {
  sanitizeTaskBlocksForPersist: (blocks: TaskBlock[]) => TaskBlock[];
  sanitizeAgentMessagesForPersist: (messages: any[]) => any[];
  normalizeSessionRuntimeSnapshot: (snapshot: Record<string, unknown>) => unknown;
  normalizeProviderCompatibilityByRuntimeKey: (value: unknown) => Record<string, ProviderCompatibilityRuntimeLaneState>;
  compactCompletedTurnAgentMessages: (params: {
    agentMessages: any[];
    turnStartIndex: number;
    turnSummary: string;
    turnBlocks: TaskBlock[];
    durableContext?: DurableTurnContext | null;
    language: "zh" | "en";
  }) => any[];
  normalizeQueuedUserMessage: (value: unknown) => any | null;
  getSessionRevisionToken: () => unknown;
  publishOwnerScopedRuntimeProjection: (input: {
    projectedState: SubmissionStoreState;
    durableState?: SubmissionStoreState;
    scopeKey: string;
    sessionId: number | string | null | undefined;
    expectedRevisionToken: unknown;
    beforePublish?: () => void;
  }) => {
    published: boolean;
    disposition: "published" | "revision_conflict" | "ownership_lost" | "durable_session_missing";
  };
  startApprovedPlanExecutionInCurrentTurn: (input: {
    get: () => SubmissionStoreState;
    setActiveState: (patch: Record<string, unknown>) => void;
    planTurnId: string;
    handoff: PlanApprovalHandoff;
    sessionKey: string;
    source: "workflow_fallback";
  }) => void;
  persistSessionRecord: (workspace: string, session: unknown) => Promise<unknown>;
  logStoreEvent: (event: string, data?: Record<string, unknown>) => void;
}

export interface SubmissionRuntimeContext {
  // Constants & Parameters
  turnId: string;
  uiDisplayTurnId: string;
  runWorkspace: string | undefined;
  runSessionKey: string;
  runSessionId: number | null | undefined;
  runScopeKey: string;
  phaseLanguage: "zh" | "en";
  effectiveRunIntent: ResolvedRunIntent;
  runtimeRunIntent: ResolvedRunIntent;
  goalCreationAuthorization: GoalCreationAuthorization | null;
  goalContinuationAuthorization: GoalContinuationAuthorization | null;
  effectiveCommandDirective: CommandDirective | null;
  options: any; // sendMessage options
  attachedFilesSnapshot: Array<AttachedFile | string>;
  mentionSnapshot: string[];
  remoteFeishu: FeishuRemoteContext | undefined;
  workspaceTree: string | null;
  gameStudioConfigForTurn: GameStudioConfig | null;
  abortCtrl: AbortController;
  timerInterval: any;
  sendStartedAt: number;
  harnessRunId: string;
  /** Immutable Plan attempt captured when this Harness Run crossed admission. */
  planExecution: PlanExecutionRunProvenance | null;
  /** Typed first-admission payload metadata. Raw image data stays in transport. */
  turnInputContextSignals: TurnInputContextSignals;
  streamBuffer: any; // StreamingCadenceBuffer
  thinkingInterceptor: any; // StreamingThinkingInterceptor
  turnAgentMessagesStart: number;
  getElapsedSeconds: () => number;

  // Mutable Stream Execution State
  agentBlockIdsCreatedThisRun: Set<number>;
  firstStreamTokenAt: number | null;
  streamTokenCount: number;
  streamTextChars: number;
  iterationStreamTokenCount: number;
  iterationStreamTextChars: number;
  runStreamTokenCount: number;
  runStreamTextChars: number;
  noFirstTokenNoticeTimer: any;
  currentStreamingBlockId: number | null;
  currentThoughtBlockId: number | null;
  thoughtStartTime: number | null;
  streamingAssistantDisplayBuffer: string;
  executionEvidenceDraftHeld: boolean;
  executionEvidenceDraftBuffer: string;
  understandingProgressBlockId: number | null;
  understandingProgressClosed: boolean;

  // Constants
  PLAN_EXECUTION_PROGRESS_DEFAULT_MAX_ITERATIONS: number;
  PROVIDER_COMPATIBILITY_FORCE_XML_TTL_MS: number;
  PROVIDER_COMPATIBILITY_NATIVE_RECOVERY_SUCCESS_STREAK: number;
}
