import { executeAgentLoop, type OrchestratorCallbacks } from "../orchestrator";
import { invoke } from "@tauri-apps/api/core";
import { 
  appendThoughtDelta, 
  compactThoughtContent, 
  compactThoughtContentForPersist,
  resolveStreamingAssistantDisplay,
  normalizeTurnRuntimePhase,
  makeTurnRuntimePhase,
  getIntentPolicy,
  sanitizeTaskBlocksForPersist,
  sanitizeAgentMessagesForPersist,
  normalizeSessionRuntimeSnapshot,
  buildPlanExecutionProgressUpdate,
  normalizePlanExecutionProgressSnapshot,
  resolveSessionRuntimeKey,
  resolveSessionWorkspaceKey,
  resolveRuntimeLaneKey,
  resolveContextMemoryStateForRuntimeLane,
  normalizeProviderCompatibilityByRuntimeKey,
  compactCompletedTurnAgentMessages,
  normalizeQueuedUserMessage,
  pickProcessAssistantText,
  type AppState,
  type TaskBlock,
  type FeishuRemoteContext,
  type GameStudioConfig,
  type CommandDirective,
  type ResolvedRunIntent,
  type AttachedFile,
  type TurnRuntimePhase,
  logStoreEvent
} from "../../store/useAppStore";
import { appendDebugLog } from "../debugLog";
import { type PlanExecutionProgressPhase, type PlanExecutionProgressUpdate, getPlanArtifactTitle, extractPlanTasks, isEphemeralPlanArtifactPath, reconcilePlanTaskCompletion } from "../workflowModels";
import { createPlanExecutionEvidenceEntry, appendPlanEvidenceEntry } from "../planEvidence";
import { closeHarnessRunMarker, persistHarnessRunMarker, type HarnessRunMarker } from "../harnessCrashTelemetry";
import { runAfterNextPaint } from "../uiScheduling";
import { supportsToolDiffPreview } from "../toolDiff";
import { findToolLifecycleBlockIndex, type ToolLifecycleMeta } from "../toolLifecycle";
import { deriveToolIntentSummary } from "../toolPresentation";
import { buildToolProgressNarration, summarizeToolObservation } from "../progressNarration";
import { deriveTurnRuntimePhaseForTool, withTurnRuntimePhaseStatus } from "../turnPhase";


export interface WorkflowContext {
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
  streamBuffer: any; // StreamingCadenceBuffer
  thinkingInterceptor: any; // StreamingThinkingInterceptor
  turnAgentMessagesStart: number;
  getElapsedSeconds: () => number;

  // Mutable Stream Execution State
  agentBlockIdsCreatedThisRun: Set<number>;
  firstStreamTokenAt: number | null;
  streamTokenCount: number;
  streamTextChars: number;
  noFirstTokenNoticeTimer: any;
  currentStreamingBlockId: number | null;
  currentThoughtBlockId: number | null;
  thoughtStartTime: number | null;
  streamingAssistantDisplayBuffer: string;
  approvedPlanHandoff: {
    prompt: string;
    parentPlanTurnId: string;
    executionTurnId: string;
    title: string;
    intentSummary: string;
  } | null;
  understandingProgressBlockId: number | null;
  understandingProgressClosed: boolean;

  // Constants
  PLAN_EXECUTION_PROGRESS_DEFAULT_MAX_ITERATIONS: number;
  PROVIDER_COMPATIBILITY_FORCE_XML_TTL_MS: number;
  PROVIDER_COMPATIBILITY_NATIVE_RECOVERY_SUCCESS_STREAK: number;
}

export class WorkflowEngine {
  constructor(
    private get: () => AppState,
    private set: any
  ) {}

  public run(context: WorkflowContext): Promise<boolean> {
    const sessionGet = this.get;
    const sessionSet = this.set;

    const phaseLanguage = context.phaseLanguage;
    const turnId = context.turnId;
    const runWorkspace = context.runWorkspace;
    const runSessionKey = context.runSessionKey;
    const runSessionId = context.runSessionId;
    const runScopeKey = context.runScopeKey;
    const effectiveRunIntent = context.effectiveRunIntent;
    const runtimeRunIntent = context.runtimeRunIntent;
    const effectiveCommandDirective = context.effectiveCommandDirective;
    const options = context.options;
    // const attachedFilesSnapshot = context.attachedFilesSnapshot;
    // const mentionSnapshot = context.mentionSnapshot;
    const remoteFeishu = context.remoteFeishu;
    const workspaceTree = context.workspaceTree;
    const gameStudioConfigForTurn = context.gameStudioConfigForTurn;
    const abortCtrl = context.abortCtrl;
    const timerInterval = context.timerInterval;
    const sendStartedAt = context.sendStartedAt;
    const streamBuffer = context.streamBuffer;
    const thinkingInterceptor = context.thinkingInterceptor;
    const turnAgentMessagesStart = context.turnAgentMessagesStart;
    const getElapsedSeconds = context.getElapsedSeconds;

    const PLAN_EXECUTION_PROGRESS_DEFAULT_MAX_ITERATIONS = context.PLAN_EXECUTION_PROGRESS_DEFAULT_MAX_ITERATIONS;
    const PROVIDER_COMPATIBILITY_FORCE_XML_TTL_MS = context.PROVIDER_COMPATIBILITY_FORCE_XML_TTL_MS;
    const PROVIDER_COMPATIBILITY_NATIVE_RECOVERY_SUCCESS_STREAK = context.PROVIDER_COMPATIBILITY_NATIVE_RECOVERY_SUCCESS_STREAK;

    // Helpers
    const attachRuntimePhase = <T extends TaskBlock>(block: T, phase?: TurnRuntimePhase): T => {
      const normalized = normalizeTurnRuntimePhase(block.turnPhase || phase || makeTurnRuntimePhase("scope", phaseLanguage), phaseLanguage);
      return normalized ? { ...block, turnPhase: normalized } : block;
    };

    const appendTurnBlock = (block: TaskBlock) => {
      const targetTurnId = block.turnId && block.turnId !== turnId ? block.turnId : context.uiDisplayTurnId;
      const blockWithTurn: TaskBlock = attachRuntimePhase({ ...block, turnId: targetTurnId } as TaskBlock);
      sessionSet((s: any) => {
        const taskFlow = [...s.taskFlow, blockWithTurn];
        const conversationTurns = s.conversationTurns.map((turn: any) =>
          turn.id === turnId && !turn.blockIds.includes(blockWithTurn.id)
            ? { ...turn, blockIds: [...turn.blockIds, blockWithTurn.id] }
            : turn
        );
        return { taskFlow, conversationTurns };
      });
    };

    const toolDisplayTurnId = context.uiDisplayTurnId || turnId;

    const normalizeToolLifecycleMeta = (meta?: { toolCallId?: string | null }): ToolLifecycleMeta => {
      const toolCallId = String(meta?.toolCallId || "").trim();
      return toolCallId ? { toolCallId } : {};
    };

    const findCurrentToolLifecycleBlockIndex = (
      taskFlow: any[],
      toolName: string,
      target: string,
      allowedStatuses: string[],
      meta?: ToolLifecycleMeta,
    ) => {
      const turnIds = Array.from(new Set([toolDisplayTurnId, turnId].filter(Boolean)));
      for (const candidateTurnId of turnIds) {
        const index = findToolLifecycleBlockIndex({
          taskFlow,
          turnId: candidateTurnId,
          toolName,
          target,
          allowedStatuses,
          meta,
        });
        if (index >= 0) return index;
      }

      const toolCallId = String(meta?.toolCallId || "").trim();
      if (!toolCallId) return -1;
      for (let index = taskFlow.length - 1; index >= 0; index -= 1) {
        const block = taskFlow[index];
        if (block?.type !== "tool") continue;
        if (!allowedStatuses.includes(String(block.toolStatus || ""))) continue;
        if (String(block.toolCallId || block.executionId || "") === toolCallId) return index;
      }
      return -1;
    };

    const shouldAttachToolDiffPreview = (toolName: string, target: string, diffPreview: any) => {
      if (!diffPreview || !supportsToolDiffPreview(toolName)) return false;
      const diffPath = String(diffPreview.path || target || "").trim();
      return !isEphemeralPlanArtifactPath(diffPath);
    };

    const isNoOpToolResult = (text: string) =>
      /FILE_UNCHANGED_STUB|READ_FILE_REPEAT_LIMIT|READ_ONLY_REPEAT_LIMIT|empty_change|invalid_patch|identical_content|no changes|no-op|nothing to (?:change|patch|write)|"noOp"\s*:\s*true/i.test(text);

    const summarizeReviewPatchTarget = (patch: string): string => {
      const text = String(patch || "");
      const targets: string[] = [];
      const addTarget = (value: string) => {
        const clean = String(value || "")
          .replace(/^["']|["']$/g, "")
          .replace(/^[ab]\//, "")
          .trim();
        if (!clean || clean === "/dev/null" || targets.includes(clean)) return;
        targets.push(clean);
      };

      for (const line of text.split(/\r?\n/)) {
        const update = line.match(/^\*\*\* Update File:\s+(.+)$/);
        const add = line.match(/^\*\*\* Add File:\s+(.+)$/);
        const del = line.match(/^\*\*\* Delete File:\s+(.+)$/);
        const unified = line.match(/^\+\+\+\s+(.+)$/);
        if (update) addTarget(update[1]);
        else if (add) addTarget(add[1]);
        else if (del) addTarget(del[1]);
        else if (unified) addTarget(unified[1]);
        if (targets.length >= 3) break;
      }

      if (targets.length === 0) return "";
      const suffix = targets.length > 1 ? ` +${targets.length - 1}` : "";
      return `${targets[0]}${suffix}`;
    };

    const deriveReviewToolTarget = (toolCall: any): string => {
      const args = toolCall?.arguments && typeof toolCall.arguments === "object" ? toolCall.arguments : {};
      const name = String(toolCall?.name || "");
      if (typeof toolCall?.localFileReadPath === "string" && toolCall.localFileReadPath.trim()) {
        return toolCall.localFileReadPath.trim();
      }
      if (name === "apply_patch") {
        return summarizeReviewPatchTarget(String(args.patch || "")) || "workspace patch";
      }
      const candidateKeys = [
        "path",
        "command",
        "url",
        "query",
        "pattern",
        "target",
        "file",
        "cwd",
        "input",
      ];
      for (const key of candidateKeys) {
        const value = args[key];
        if (typeof value === "string" && value.trim()) return value.trim();
      }
      return name || "tool request";
    };

    const clearNoFirstTokenNoticeTimer = () => {
      if (context.noFirstTokenNoticeTimer !== null) {
        clearTimeout(context.noFirstTokenNoticeTimer);
        context.noFirstTokenNoticeTimer = null;
      }
    };

    const enterRealPendingReviewState = () => {
      sessionSet({ agentStatus: "pending_review", isGenerating: false });
      sessionGet().setConversationTurnStatus(turnId, "awaiting_approval");
      if (context.uiDisplayTurnId !== turnId) {
        sessionGet().setConversationTurnStatus(context.uiDisplayTurnId, "awaiting_approval");
      }
    };

    const closeCurrentHarnessRunMarker = (status: "completed" | "error", reason: string) => {
      const marker = sessionGet().harnessRunMarker;
      if (marker && marker.status === "running") {
        const closedAt = Date.now();
        const nextMarker: HarnessRunMarker = {
          ...marker,
          status,
          updatedAt: closedAt,
          closedAt,
          closeReason: reason,
        };
        sessionSet({ harnessRunMarker: nextMarker });
        closeHarnessRunMarker({ status, closeReason: reason });
      }
    };

    const emitProgressRuntimeEvent = (progress: any, meta: { dedupeKey?: string } = {}) => {
      const eventId = `event-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      sessionSet((s: any) => ({
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

    const emitLocalPlanExecutionProgress = (phase: "starting" | "running" | "completed" | "error", update: any) => {
      const progressSnapshot = normalizePlanExecutionProgressSnapshot({
        turnId,
        update: buildPlanExecutionProgressUpdate({
          language: phaseLanguage,
          phase: phase as PlanExecutionProgressPhase,
          iterationCount: update.iteration,
          maxIterations: update.maxIterations,
          autoResumeCount: sessionGet().planAutoResumeCount,
          tasks: sessionGet().planTasks,
          evidenceLedger: sessionGet().planExecutionEvidenceLedger,
          recentToolActivity: update.currentTool ? [update.currentTool] : [],
          nextStep: update.nextStep,
          recoveryReason: update.recoveryReason,
          repeatedTargets: update.repeatedTargets,
        }),
        previous: sessionGet().planExecutionProgressSnapshot,
        now: Date.now(),
      });
      sessionSet({ planExecutionProgressSnapshot: progressSnapshot });
      emitProgressRuntimeEvent(progressSnapshot, { dedupeKey: `plan-execution-progress:${turnId}` });
    };

    const emitPlanStreamHeartbeat = (marker: any) => {
      const previous = sessionGet().planExecutionProgressSnapshot;
      if (!previous || previous.turnId !== turnId) return;
      const currentTool = marker.currentToolName
        ? [
            marker.currentToolName,
            marker.currentToolInputKey,
            marker.currentToolInputTarget,
          ].filter(Boolean).join(" · ")
        : "";
      const zh = phaseLanguage === "zh";
      const streamStatus = marker.streamStatus;
      emitLocalPlanExecutionProgress("running", {
        iteration: marker.iteration || previous.iteration || 0,
        maxIterations: marker.maxIterations || previous.maxIterations || PLAN_EXECUTION_PROGRESS_DEFAULT_MAX_ITERATIONS,
        currentTask: previous.currentTask,
        currentTool,
        latestEvidence: previous.latestEvidence,
        nextStep: streamStatus === "no_chunk_progress_warning"
          ? zh
            ? "模型仍在流式生成但间隔偏长；可继续等待，或停止后查看日志与恢复点"
            : "model is still streaming with a long gap; keep waiting or stop and inspect logs/recovery details"
          : zh
          ? "模型仍在生成；ChatArea 会持续显示流式进度"
          : "model is still generating; ChatArea will keep showing stream progress",
        progressSignature: previous.progressSignature,
        repeatedTargets: previous.repeatedTargets,
        recoveryReason: streamStatus === "no_chunk_progress_warning"
          ? "stream_no_chunk_progress"
          : previous.recoveryReason,
      });
    };

    const updateHarnessRunMarker = (patch: Partial<HarnessRunMarker>) => {
      sessionSet((s: any) => {
        if (!s.harnessRunMarker) return {};
        const nextMarker = {
          ...s.harnessRunMarker,
          ...patch,
        } as HarnessRunMarker;
        persistHarnessRunMarker(nextMarker);
        return {
          harnessRunMarker: nextMarker,
        };
      });
    };

    const callbacks: OrchestratorCallbacks = {
      getMessages: () => sessionGet().agentMessages,
      getConfig: () => ({ ...sessionGet().config, workspace: runWorkspace || "" }),
      getPreferredLanguage: () => sessionGet().preferredResponseLanguage || sessionGet().config.language,
      getSkills: () => sessionGet().skills,
      getMainModeKey: () => sessionGet().selectedMainModeKey,
      getActiveStudioAgentKey: () => sessionGet().activeStudioAgentKey,
      getGameStudioInitialized: () => sessionGet().gameStudioInitialized,
      getPendingSlashCommand: () => sessionGet().pendingSlashCommand,
      getGameStudioConfig: () => gameStudioConfigForTurn,
      getWorkspaceTree: () => workspaceTree || "",
      getMcpServers: () => sessionGet().mcpServers,
      getMcpDiscoveredTools: () => sessionGet().mcpDiscoveredTools,
      getWebSearchEnabled: () => sessionGet().webSearchEnabled === true,
      getWebSearchProvider: () => sessionGet().webSearchProvider || "duckduckgo",
      getEnabledKnowledgeBaseIds: () => sessionGet().getEnabledKnowledgeBaseIds?.() || [],
      getAssociatedPaths: () => sessionGet().resolvedInstructionSet?.associatedPaths ?? [],
      getSessionKey: () => runSessionKey,
      getCurrentTurnId: () => turnId,
      hasSessionHookInitialized: (key: string) => sessionGet().hasSessionHookInitialized(key),
      markSessionHookInitialized: (key: string) => sessionGet().markSessionHookInitialized(key),
      onInstructionsResolved: (resolved: any) => sessionGet().setResolvedInstructionSet(resolved),
      onHooksLoaded: (hooks: any, loadedAt: any) => sessionGet().setLoadedHookDefinitions(hooks, loadedAt),
      onHookStart: (_event: any, _hook: any) => { /* UI feedback placeholder */ },
      onHookResult: (record: any) => sessionGet().appendHookExecutionRecords([record]),
      onHookBlocked: (_event: any, _reason: any, _record: any) => { /* UI feedback placeholder */ },
      getCurrentRunIntent: () => sessionGet().getCurrentRunIntent(),
      getRuntimeRunIntent: () => runtimeRunIntent,
      getForcedExecuteRecoveryMode: () => options?.forceExecuteRecoveryMode ?? null,
      getCommandDirective: () => effectiveCommandDirective,
      getWorkflowMode: () => getIntentPolicy(sessionGet().getCurrentRunIntent()).workflowMode,
      getIsPlanApproved: () => sessionGet().isPlanApproved,
      getPlanApprovalChoice: () => sessionGet().planApprovalChoice,
      getReadOnlyAutoApproveForSession: () => sessionGet().readOnlyAutoApproveForSession,
      getApprovedLocalFileReadPaths: () => sessionGet().approvedLocalFileReadPaths || [],
      getAutoApproveToolScopes: () => sessionGet().autoApproveToolScopes || [],
      getPlanStage: () => sessionGet().planStage,
      getPlanTasks: () => sessionGet().planTasks,
      getPlanExecutionEvidenceLedger: () => sessionGet().planExecutionEvidenceLedger,
      getPlanAutoResumeCount: () => sessionGet().planAutoResumeCount,
      getStatus: () => sessionGet().agentStatus,
      consumeActiveGuidance: () => sessionGet().consumeActiveGuidance(turnId),
      startNewTurn: () => sessionGet().startNewTurn(remoteFeishu),
      onApprovedPlanHandoff: (prompt: string) => {
        const language = sessionGet().config.language === "en" ? "en" : "zh";
        const executionTurnId = `turn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        context.approvedPlanHandoff = {
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
        sessionSet((s: any) => ({
          currentTurnExecutionConsent: { turnId: executionTurnId, granted: true },
          planExecutionProgressSnapshot: progressSnapshot,
          conversationTurns: s.conversationTurns.map((turn: any) =>
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
          sessionSet((s: any) => {
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
      onProviderCompatibilityFallback: (reason: any) => {
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
        sessionSet((s: any) => {
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
        sessionSet((s: any) => {
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
      onHarnessRunUpdate: (patch: any) => {
        const markerPatch = patch as Partial<HarnessRunMarker> & Record<string, unknown>;
        updateHarnessRunMarker(markerPatch);
        emitPlanStreamHeartbeat(markerPatch);
      },
      onDebugEvent: (event: any, data: any = {}) => {
        try {
          appendDebugLog("info", event, {
            turnId,
            sessionKey: runSessionKey,
            workspace: runWorkspace || null,
            ...data,
          });
        } catch {
          // Diagnostics must never affect user workflows.
        }
      },

      onStreamToken: (token: string, _msgId: string | undefined | null) => {
        // Handle escalation reset signal
        if (token.startsWith("__ESCALATION_RESET__:")) {
          logStoreEvent("stream_reset", {
            turnId,
            currentStreamingBlockId: context.currentStreamingBlockId,
            tokenBufferChars: 0,
            agentBlocksCreatedThisRun: context.agentBlockIdsCreatedThisRun.size,
            taskFlowBlocks: sessionGet().taskFlow.length,
          });
          streamBuffer.reset();
          context.firstStreamTokenAt = null;
          context.streamTokenCount = 0;
          context.streamTextChars = 0;
          context.streamingAssistantDisplayBuffer = "";
          // Reset the streaming block content for retry
          if (context.currentStreamingBlockId !== null) {
            const blockId = context.currentStreamingBlockId;
            sessionSet((s: any) => ({
              taskFlow: s.taskFlow.map((t: any) =>
                t.id === blockId && t.type === "agent"
                  ? { ...t, content: "" }
                  : t
                ),
            }));
          } else {
            sessionSet((s: any) => {
              const latestAgent = [...s.taskFlow]
                .reverse()
                .find((block) => block.turnId === turnId && block.type === "agent");
              if (latestAgent) {
                const targetId = latestAgent.id;
                return {
                  taskFlow: s.taskFlow.filter((block: any) => block.id !== targetId),
                  conversationTurns: s.conversationTurns.map((turn: any) =>
                    turn.id === turnId
                      ? { ...turn, blockIds: turn.blockIds.filter((id: any) => id !== targetId) }
                      : turn
                  ),
                };
              }
              return {};
            });
          }
          return;
        }

        if (context.thoughtStartTime === null) context.thoughtStartTime = Date.now();
        if (context.firstStreamTokenAt === null) {
          context.firstStreamTokenAt = Date.now();
          clearNoFirstTokenNoticeTimer();
          logStoreEvent("stream_first_token", {
            turnId,
            sessionKey: runSessionKey,
            workspace: runWorkspace || null,
            elapsedMs: Math.round(context.firstStreamTokenAt! - sendStartedAt),
            tokenChars: token.length,
          });
        }
        context.streamTokenCount++;
        context.streamTextChars += token.length;
        streamBuffer.append(token);
      },

      onStreamDone: (_fullText: string, _msgId: string | undefined | null, truncated: boolean, meta?: any) => {
        streamBuffer.flush();
        clearNoFirstTokenNoticeTimer();

        let { agent: remainingAgent } = thinkingInterceptor.flush();
        if (remainingAgent) {
          const displayCandidate = context.streamingAssistantDisplayBuffer + remainingAgent;
          const displayDecision = resolveStreamingAssistantDisplay({
            text: displayCandidate,
            language: phaseLanguage,
            workflowMode: sessionGet().config.workflowMode,
            runIntent: effectiveRunIntent,
            hasVisibleAgentBlock: context.currentStreamingBlockId !== null,
          });
          if (displayDecision.action === "show") {
            remainingAgent = displayDecision.text;
          } else {
            remainingAgent = "";
          }
          context.streamingAssistantDisplayBuffer = "";
        } else {
          context.streamingAssistantDisplayBuffer = "";
        }
        if (remainingAgent) {
          if (context.currentStreamingBlockId === null) {
            const blockId = sessionGet()._nextTaskId();
            context.currentStreamingBlockId = blockId;
            appendTurnBlock({ id: blockId, turnId, type: "agent", content: remainingAgent, streaming: true });
          } else {
            const blockId = context.currentStreamingBlockId;
            sessionSet((s: AppState) => ({
              taskFlow: s.taskFlow.map((t: TaskBlock) =>
                t.id === blockId && t.type === "agent"
                  ? { ...t, content: (t as Extract<TaskBlock, { type: "agent" }>).content + remainingAgent }
                  : t
              ),
            }));
          }
        }

        const duration = context.thoughtStartTime ? Math.round((Date.now() - context.thoughtStartTime) / 1000) : undefined;
        sessionSet((s: AppState) => {
          const finalizeStreamingTaskBlocks = (taskFlow: TaskBlock[], targetTurnId: string, duration?: number): TaskBlock[] => {
            return taskFlow.map((t) => {
              if (t.turnId !== targetTurnId) return t;
              if (t.type === "agent" && t.streaming) {
                return { ...t, streaming: false };
              }
              if (t.type === "thought" && t.isStreaming) {
                return { ...t, isStreaming: false, duration };
              }
              return t;
            });
          };
          return { taskFlow: finalizeStreamingTaskBlocks(s.taskFlow, turnId, duration) };
        });

        context.currentStreamingBlockId = null;
        context.currentThoughtBlockId = null;
        context.thoughtStartTime = null;

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
          firstTokenElapsedMs: context.firstStreamTokenAt == null ? null : Math.round(context.firstStreamTokenAt - sendStartedAt),
          streamTokenCount: context.streamTokenCount,
          streamTextChars: context.streamTextChars,
          taskFlowBlocks: sessionGet().taskFlow.length,
          agentBlocksCreatedThisRun: context.agentBlockIdsCreatedThisRun.size,
        });

        // Show truncation warning if the model hit max_tokens
        if (truncated && !suppressTruncationWarning) {
          const warnId = sessionGet()._nextTaskId();
          const warnBlock: TaskBlock = {
            id: warnId,
            turnId,
            type: "system",
            content: "⚠️ 回复被截断 — 模型达到了最大 token 限制。回复可能不完整。",
          };
          appendTurnBlock(warnBlock);
        }

        sessionSet((s: AppState) => ({
          normalizedStreamState: {
            ...s.normalizedStreamState,
            finishReason: truncated ? "length" : "stop",
          },
        }));
      },

      onThought: (thought: any) => {
        const duration = context.thoughtStartTime
          ? Math.round((Date.now() - context.thoughtStartTime) / 1000)
          : undefined;

        // ── Turn-based deduplication: clean matching ──────────────
        const normalizeForComp = (s: string) => s.trim().replace(/\s+/g, ' ');
        const incoming = normalizeForComp(thought);
        
        const currentTurn = sessionGet().currentTurnState;

        // ── Interceptor dedup: if StreamingThinkingInterceptor already
        // captured and rendered this exact content, skip it entirely.
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
        sessionSet((s: any) => ({
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
        const turnBlocks = currentFlow.filter((b: any) => b.turnId === turnId);
        const lastThoughtBlock = [...turnBlocks].reverse().find((b) => b.type === "thought");

        if (lastThoughtBlock) {
          const existingContent = (lastThoughtBlock as Extract<TaskBlock, { type: "thought" }>).content;
          const existing = normalizeForComp(existingContent);
          
          if (existing.includes(incoming)) {
            if (duration !== undefined) {
              const tid = lastThoughtBlock.id;
              sessionSet((s: any) => ({
                taskFlow: s.taskFlow.map((t: any) =>
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
          sessionSet((s: any) => ({
            taskFlow: s.taskFlow.map((t: any) =>
              t.id === tid && t.type === "thought"
                ? { ...t, content: nextContent, isStreaming: true, duration }
                : t
            ),
          }));
          // Auto-collapse after a brief display period
          setTimeout(() => {
            sessionSet((s: any) => ({
              taskFlow: s.taskFlow.map((t: any) =>
                t.id === tid && t.type === "thought"
                  ? { ...t, content: compactThoughtContentForPersist((t as Extract<TaskBlock, { type: "thought" }>).content), isStreaming: false }
                  : t
              ),
            }));
            context.thoughtStartTime = null;
          }, 1200);
        } else {
          const thoughtBlockId = sessionGet()._nextTaskId();
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
            sessionSet((s: any) => ({
              taskFlow: s.taskFlow.map((t: any) =>
                t.id === thoughtBlockId && t.type === "thought"
                  ? { ...t, content: compactThoughtContentForPersist((t as Extract<TaskBlock, { type: "thought" }>).content), isStreaming: false }
                  : t
              ),
            }));
            context.thoughtStartTime = null;
          }, 1200);
        }
      },

      onAssistantFinalText: (text: any, replyOptions: any[] = [], meta: any) => {
        const hasToolCalls = meta?.hasToolCalls === true;
        const language = sessionGet().config.language === "en" ? "en" : "zh";
        const fallbackText = replyOptions.length > 0
          ? language === "en"
            ? "Choose how you'd like to continue."
            : "请选择你希望我如何继续。"
          : "";

        const visibleText = String(text || "").trim() || fallbackText;
        const normalizedFinal = sanitizeFinalTextForPersist({
          visibleText,
          hiddenThought: sessionGet().normalizedStreamState.hiddenThought,
          language,
        });

        // Resolve Feishu adaptive card sending. Text emitted before a tool call is
        // progress, not completion, so remote replies wait for the final answer.
        if (remoteFeishu && !hasToolCalls) {
          const cardTitle = sessionGet().config.language === "en" ? "Task Complete" : "任务处理完成";
          const displaySummary = pickProcessAssistantText(
            text,
            sessionGet().normalizedStreamState.hiddenThought,
            language
          );

          void invoke("send_feishu_message", {
            chatId: remoteFeishu.chatId,
            userId: remoteFeishu.userId,
            openId: remoteFeishu.userId,
            messageId: remoteFeishu.messageId,
            text: displaySummary,
            feishuCardTitle: cardTitle,
            feishuCardMarkdown: displaySummary,
            harnessIterationCount: meta?.iterationCount || 0,
            harnessMaxIterations: meta?.maxIterations || PLAN_EXECUTION_PROGRESS_DEFAULT_MAX_ITERATIONS,
            isFeishuReplyCard: true,
          }).catch(() => {});
        }

        // Complete understanding progress
        if (!context.understandingProgressClosed && context.understandingProgressBlockId != null) {
          context.understandingProgressClosed = true;
          const progress = {
            phase: "understanding" as const,
            title: phaseLanguage === "zh" ? "理解需求" : "Understanding request",
            why: sessionGet().planExecutionProgressSnapshot?.nextStep || "",
            action: "",
            evidence: "",
            next: "",
            targets: [],
            status: "done" as const,
            source: "runtime" as const,
            hypothesisStatus: "confirmed" as const,
          };
          const blockId = context.understandingProgressBlockId;
          sessionSet((s: any) => ({
            taskFlow: s.taskFlow.map((block: any) =>
              block.id === blockId && block.type === "progress"
                ? {
                    ...block,
                    ...progress,
                    turnPhase: makeTurnRuntimePhase("scope", phaseLanguage, { status: "done" }),
                  }
                : block
            ),
          }));
          emitProgressRuntimeEvent(progress, { dedupeKey: `understanding:${turnId}` });
        }

        // Finalize state
        sessionSet((s: any) => {
          let taskFlow = s.taskFlow;
          let conversationTurns = s.conversationTurns;
          let nextStreamingBlockId = context.currentStreamingBlockId;

          // Merge answer/progress block. When this text precedes tool calls, close
          // the visible block but keep the overall run active for tool execution
          // and the next model iteration.
          if (context.currentStreamingBlockId !== null) {
            const blockId = context.currentStreamingBlockId;
            taskFlow = taskFlow.map((t: any) =>
              t.id === blockId && t.type === "agent"
                ? { ...t, content: visibleText, streaming: false, options: replyOptions }
                : t
            );
            if (hasToolCalls) {
              nextStreamingBlockId = null;
            }
          } else {
            const existingAgentBlock = [...taskFlow]
              .reverse()
              .find((block) => block.turnId === turnId && block.type === "agent");

            if (existingAgentBlock) {
              const blockId = existingAgentBlock.id;
              taskFlow = taskFlow.map((t: any) =>
                t.id === blockId && t.type === "agent"
                  ? { ...t, content: visibleText, streaming: false, options: replyOptions }
                  : t
              );
            } else {
              const blockId = s._nextTaskId();
              const blockWithTurn = attachRuntimePhase({
                id: blockId,
                turnId,
                type: "agent",
                content: visibleText,
                streaming: false,
                options: replyOptions,
              } as TaskBlock);

              taskFlow = [...taskFlow, blockWithTurn];
              conversationTurns = conversationTurns.map((turn: any) =>
                turn.id === turnId && !turn.blockIds.includes(blockId)
                  ? { ...turn, blockIds: [...turn.blockIds, blockId] }
                  : turn
              );
            }
          }

          context.currentStreamingBlockId = nextStreamingBlockId;

          conversationTurns = conversationTurns.map((turn: any) =>
            turn.id === turnId
              ? hasToolCalls
                ? {
                    ...turn,
                    status: turn.status === "awaiting_approval" ? turn.status : "executing",
                    summary: normalizedFinal || turn.summary,
                  }
                : {
                    ...turn,
                    status: turn.status === "awaiting_approval" || turn.status === "done" ? turn.status : "done",
                    summary: normalizedFinal,
                  }
              : turn
          );

          if (hasToolCalls) {
            return {
              taskFlow,
              conversationTurns,
              agentStatus: s.agentStatus === "pending_review" ? "pending_review" : "running",
              isGenerating: true,
            };
          }

          return {
            taskFlow,
            conversationTurns,
            agentStatus: s.agentStatus === "pending_review" ? "pending_review" : "idle",
            isGenerating: false,
            ...(s.agentStatus === "pending_review" ? {} : { abortController: null }),
          };
        });
      },

      onToolExecuting: (toolName: string, target: string, diffPreview?: any, meta?: { toolCallId?: string }) => {
        const lifecycleMeta = normalizeToolLifecycleMeta(meta);
        const executionId = lifecycleMeta.toolCallId || undefined;
        logStoreEvent("tool_start", {
          turnId,
          sessionKey: runSessionKey,
          workspace: runWorkspace || null,
          toolName,
          executionId,
        });

        // Auto collapse understanding progress
        if (!context.understandingProgressClosed && context.understandingProgressBlockId != null) {
          context.understandingProgressClosed = true;
          const progress = {
            phase: "understanding" as const,
            title: phaseLanguage === "zh" ? "理解需求" : "Understanding request",
            why: sessionGet().planExecutionProgressSnapshot?.nextStep || "",
            action: "",
            evidence: "",
            next: "",
            targets: [],
            status: "done" as const,
            source: "runtime" as const,
            hypothesisStatus: "confirmed" as const,
          };
          const blockId = context.understandingProgressBlockId;
          sessionSet((s: any) => ({
            taskFlow: s.taskFlow.map((block: any) =>
              block.id === blockId && block.type === "progress"
                ? {
                    ...block,
                    ...progress,
                    turnPhase: makeTurnRuntimePhase("scope", phaseLanguage, { status: "done" }),
                  }
                : block
            ),
          }));
          emitProgressRuntimeEvent(progress, { dedupeKey: `understanding:${turnId}` });
        }

        const blockId = sessionGet()._nextTaskId();
        const turnPhase = deriveTurnRuntimePhaseForTool({
          toolName,
          target,
          language: phaseLanguage,
          status: "running",
        });
        const progress = buildToolProgressNarration({
          toolName,
          target,
          language: phaseLanguage,
          status: "running",
          source: "runtime",
          turnIntent: effectiveRunIntent,
          workflowMode: sessionGet().config.workflowMode,
          sourceToolCallIds: executionId ? [executionId] : [],
        });
        const diff = shouldAttachToolDiffPreview(toolName, target, diffPreview) ? diffPreview : undefined;
        const intentSummary = deriveToolIntentSummary({
          toolName,
          target,
          language: phaseLanguage,
          status: "running",
          toolStatus: "running",
        });
        emitProgressRuntimeEvent(progress, { dedupeKey: `tool:${executionId || `${toolName}:${target}`}:running` });
        sessionSet((s: any) => {
          const existingIndex = findCurrentToolLifecycleBlockIndex(
            s.taskFlow,
            toolName,
            target,
            ["pending", "running"],
            lifecycleMeta,
          );
          const updateToolBlock = (block: any) => attachRuntimePhase({
            ...block,
            turnId: block.turnId || toolDisplayTurnId,
            type: "tool",
            toolName,
            target,
            status: "running",
            toolStatus: "running",
            toolCallId: executionId,
            executionId,
            intentSummary,
            why: progress.why,
            evidence: progress.evidence,
            observationSummary: progress.observedFact,
            turnPhase,
            ...(diff ? { diff } : {}),
          } as any, turnPhase);

          if (existingIndex >= 0) {
            return {
              agentStatus: s.agentStatus === "pending_review" ? "pending_review" : "running",
              isGenerating: true,
              taskFlow: s.taskFlow.map((block: any, index: number) =>
                index === existingIndex ? updateToolBlock(block) : block
              ),
            };
          }

          const blockWithTurn = updateToolBlock({
            id: blockId,
            turnId: toolDisplayTurnId,
          });
          return {
            agentStatus: s.agentStatus === "pending_review" ? "pending_review" : "running",
            isGenerating: true,
            taskFlow: [...s.taskFlow, blockWithTurn],
            conversationTurns: s.conversationTurns.map((turn: any) =>
              turn.id === turnId && !turn.blockIds.includes(blockId)
                ? { ...turn, blockIds: [...turn.blockIds, blockId] }
                : turn
            ),
          };
        });
      },

      onToolDone: (toolName: string, target: string, result: string, meta?: { toolCallId?: string; diff?: any }) => {
        const lifecycleMeta = normalizeToolLifecycleMeta(meta);
        const executionId = lifecycleMeta.toolCallId || undefined;
        const resultText = String(result || "");
        const completedDiff = shouldAttachToolDiffPreview(toolName, target, meta?.diff) ? meta?.diff : undefined;
        const noOp = isNoOpToolResult(resultText);
        const entry = createPlanExecutionEvidenceEntry({
          toolName,
          target,
          result: resultText,
          noOp,
        });
        const observationSummary = summarizeToolObservation({
          toolName,
          target,
          result: resultText,
          language: phaseLanguage,
          noOp,
        });
        const progress = buildToolProgressNarration({
          toolName,
          target,
          language: phaseLanguage,
          status: "done",
          source: "tool_result",
          turnIntent: effectiveRunIntent,
          workflowMode: sessionGet().config.workflowMode,
          previousObservation: observationSummary,
          result: resultText,
          noOp,
          hypothesisStatus: noOp ? "blocked" : "confirmed",
          sourceToolCallIds: executionId ? [executionId] : [],
        });
        logStoreEvent("tool_result", {
          turnId,
          sessionKey: runSessionKey,
          workspace: runWorkspace || null,
          toolName,
          executionId,
          resultChars: result?.length ?? 0,
          isError: false,
        });

        sessionSet((s: any) => {
          const existingIndex = findCurrentToolLifecycleBlockIndex(
            s.taskFlow,
            toolName,
            target,
            ["pending", "running", "executed"],
            lifecycleMeta,
          );
          if (existingIndex < 0) return {};

          const nextLedger = appendPlanEvidenceEntry(s.planExecutionEvidenceLedger || [], entry);
          const nextTasks = reconcilePlanTaskCompletion(
            s.planTasks || [],
            s.planTasks || [],
            nextLedger,
            {
              preserveMissing: s.isPlanApproved || s.planStage === "executing" || s.planStage === "completed" || s.planTasks.length > 0,
              highlightNext: s.isPlanApproved && nextLedger.length > 0,
            }
          );

          return {
            planExecutionEvidenceLedger: nextLedger,
            planExecutionEvidenceCount: nextLedger.length,
            planTasks: nextTasks,
            taskFlow: s.taskFlow.map((block: any, index: number) => {
              if (index !== existingIndex) return block;
              const completedPhase = withTurnRuntimePhaseStatus(
                block.turnPhase || deriveTurnRuntimePhaseForTool({
                  toolName,
                  target,
                  language: phaseLanguage,
                  status: "done",
                }),
                "done",
                phaseLanguage,
              );
              return {
                ...block,
                status: "done",
                toolStatus: "executed",
                output: resultText,
                message: resultText,
                ...(completedDiff ? { diff: completedDiff } : block.diff ? { diff: block.diff } : {}),
                intentSummary: block.intentSummary || deriveToolIntentSummary({
                  toolName,
                  target,
                  language: phaseLanguage,
                  status: "done",
                  toolStatus: "executed",
                }),
                why: block.why || progress.why,
                evidence: progress.evidence || block.evidence,
                observationSummary,
                turnPhase: completedPhase || block.turnPhase,
              };
            }),
          };
        });
      },

      onToolError: (toolName: string, target: string, error: string, meta?: { toolCallId?: string }) => {
        const lifecycleMeta = normalizeToolLifecycleMeta(meta);
        const executionId = lifecycleMeta.toolCallId || undefined;
        const errorText = String(error || "");
        const observationSummary = summarizeToolObservation({
          toolName,
          target,
          result: errorText,
          language: phaseLanguage,
        });
        const progress = buildToolProgressNarration({
          toolName,
          target,
          language: phaseLanguage,
          status: "failed",
          source: "tool_result",
          turnIntent: effectiveRunIntent,
          workflowMode: sessionGet().config.workflowMode,
          previousObservation: observationSummary,
          result: errorText,
          hypothesisStatus: "blocked",
          sourceToolCallIds: executionId ? [executionId] : [],
        });
        logStoreEvent("tool_result", {
          turnId,
          sessionKey: runSessionKey,
          workspace: runWorkspace || null,
          toolName,
          executionId,
          resultChars: error?.length ?? 0,
          isError: true,
        });

        sessionSet((s: any) => {
          const existingIndex = findCurrentToolLifecycleBlockIndex(
            s.taskFlow,
            toolName,
            target,
            ["pending", "running", "failed"],
            lifecycleMeta,
          );
          if (existingIndex < 0) return {};
          return {
            taskFlow: s.taskFlow.map((block: any, index: number) => {
              if (index !== existingIndex) return block;
              const failedPhase = withTurnRuntimePhaseStatus(
                block.turnPhase || deriveTurnRuntimePhaseForTool({
                  toolName,
                  target,
                  language: phaseLanguage,
                  status: "failed",
                }),
                "failed",
                phaseLanguage,
              );
              return {
                ...block,
                status: "error",
                toolStatus: "failed",
                output: errorText,
                message: errorText,
                intentSummary: block.intentSummary || deriveToolIntentSummary({
                  toolName,
                  target,
                  language: phaseLanguage,
                  status: "failed",
                  toolStatus: "failed",
                }),
                why: block.why || progress.why,
                evidence: progress.evidence || block.evidence,
                observationSummary,
                turnPhase: failedPhase || block.turnPhase,
              };
            }),
          };
        });
      },

      requestReview: (toolCall: any) => {
        const toolName = String(toolCall?.name || "tool");
        const reviewTarget = deriveReviewToolTarget(toolCall);
        const reviewToolCallId = String(toolCall?.toolCallId || toolCall?.id || "").trim();
        const autoApproveToolScopes = sessionGet().autoApproveToolScopes || [];
        logStoreEvent("request_review_started", {
          turnId,
          toolName,
          target: reviewTarget,
          toolCallId: reviewToolCallId || null,
          toolSource: toolCall?.source ?? null,
          toolRisk: toolCall?.risk ?? null,
          autoApproveToolScopes,
          shellPermissionGated: !!toolCall?.shellPermissionDecision,
        });

        return new Promise<any>((resolve) => {
          enterRealPendingReviewState();

          const taskFlow = sessionGet().taskFlow;
          const toolBlock = [...taskFlow]
            .reverse()
            .find((block: any) => {
              if (block.turnId !== turnId && block.turnId !== toolDisplayTurnId) return false;
              if (block.type !== "tool" || block.toolName !== toolName) return false;
              if (reviewToolCallId && String(block.toolCallId || block.executionId || "") === reviewToolCallId) return true;
              return block.toolStatus === "running" && String(block.target || "") === reviewTarget;
            });
          const taskId = toolBlock ? toolBlock.id : sessionGet()._nextTaskId();
          const pendingPhase = deriveTurnRuntimePhaseForTool({
            toolName,
            target: reviewTarget,
            language: phaseLanguage,
            status: "pending",
          });
          const progress = buildToolProgressNarration({
            toolName,
            target: reviewTarget,
            language: phaseLanguage,
            status: "running",
            source: "runtime",
            turnIntent: effectiveRunIntent,
            workflowMode: sessionGet().config.workflowMode,
            sourceToolCallIds: reviewToolCallId ? [reviewToolCallId] : [],
          });
          const pendingMessage = phaseLanguage === "zh"
            ? "等待用户批准后执行。"
            : "Waiting for approval before execution.";

          sessionSet((s: any) => {
            const updatePendingBlock = (block: any) => attachRuntimePhase({
              ...block,
              turnId: block.turnId || toolDisplayTurnId,
              type: "tool",
              toolName,
              target: block.target || reviewTarget,
              status: "pending_review",
              toolStatus: "pending",
              ...(reviewToolCallId ? { toolCallId: reviewToolCallId, executionId: reviewToolCallId } : {}),
              ...(toolCall?.shellPermissionDecision ? { shellPermissionDecision: toolCall.shellPermissionDecision } : {}),
              message: block.message || pendingMessage,
              intentSummary: block.intentSummary || deriveToolIntentSummary({
                toolName,
                target: reviewTarget,
                language: phaseLanguage,
                status: "running",
                toolStatus: "pending",
              }),
              why: block.why || progress.why,
              evidence: block.evidence || progress.evidence,
              observationSummary: block.observationSummary || progress.observedFact,
              turnPhase: pendingPhase,
            } as any, pendingPhase);

            if (toolBlock) {
              return {
                taskFlow: s.taskFlow.map((block: any) =>
                  block.id === taskId ? updatePendingBlock(block) : block
                ),
              };
            }

            const pendingBlock = updatePendingBlock({
              id: taskId,
              turnId: toolDisplayTurnId,
            });
            return {
              taskFlow: [...s.taskFlow, pendingBlock],
              conversationTurns: s.conversationTurns.map((turn: any) =>
                (turn.id === turnId || turn.id === toolDisplayTurnId) && !turn.blockIds.includes(taskId)
                  ? { ...turn, blockIds: [...turn.blockIds, taskId] }
                  : turn
              ),
            };
          });

          sessionSet({
            pendingReviewTaskId: taskId,
            pendingReviewResolve: resolve,
            pendingToolCall: toolCall,
          });
        });
      },

      onPlanExecutionProgress: (progress: PlanExecutionProgressUpdate) => {
        logStoreEvent("plan_execution_progress", {
          turnId,
          sessionKey: runSessionKey,
          workspace: runWorkspace || null,
          phase: progress.phase,
          iteration: progress.iteration,
          autoResume: progress.autoResumeCount,
        });

        emitLocalPlanExecutionProgress(progress.phase as any, {
          iteration: progress.iteration,
          maxIterations: progress.maxIterations,
          currentTool: progress.currentTool,
          recoveryReason: progress.recoveryReason,
          repeatedTargets: progress.repeatedTargets,
          nextStep: progress.nextStep,
        });
      },

      onStatusChange: (status: "idle" | "running" | "pending_review" | "error") => {
        sessionSet({
          agentStatus: status,
          isGenerating: status === "running",
          ...(status === "idle" || status === "error" ? { abortController: null } : {}),
        });
      },

      onError: (error: string) => {
        sessionSet({ agentStatus: "error", isGenerating: false, abortController: null });
        appendTurnBlock({
          id: sessionGet()._nextTaskId(),
          turnId,
          type: "system",
          content: `❌ 出错了：${error}`,
        });
      },

      onNonActionableStop: (message: string, reason: "no_output" | "no_action" | "missing_tool_loop" | "incomplete_plan", _progress?: Partial<PlanExecutionProgressUpdate>) => {
        logStoreEvent("non_actionable_stop", { message, reason });
        const stoppedStatus = reason === "no_output" ? "stopped_no_output" : "stopped_no_action";
        sessionSet((s: any) => ({
          conversationTurns: s.conversationTurns.map((turn: any) =>
            turn.id === turnId && turn.status !== "awaiting_approval"
              ? { ...turn, status: stoppedStatus }
              : turn
          ),
        }));
      },

      onPlanArtifactUpdated: (path: string, content: string, kind: "plan" | "requirements" | "design" | "tasks" | "bugfix") => {
        sessionGet().upsertPlanArtifact({
          kind,
          path,
          title: getPlanArtifactTitle(kind, sessionGet().config.language === "en" ? "en" : "zh"),
          content,
          updatedAt: Date.now(),
        });
      },

      onPlanStageChanged: (stage: "idle" | "plan" | "requirements" | "design" | "tasks" | "bugfix" | "ready_to_execute" | "executing" | "completed") => {
        sessionSet({ planStage: stage });
      },

      onPlanTasksUpdated: (content: string) => {
        sessionGet().setPlanTasks(extractPlanTasks(content));
      },

      onTurnSummaryReady: (summary: string) => {
        sessionSet((s: any) => ({
          conversationTurns: s.conversationTurns.map((turn: any) =>
            turn.id === turnId ? { ...turn, summary } : turn
          ),
        }));
      },

      appendMessage: (msg: any) => {
        sessionSet((s: any) => ({ agentMessages: [...s.agentMessages, msg] }));
      },

      replaceMessages: (msgs: any[]) => {
        sessionSet({ agentMessages: msgs });
      },

      onContextCompress: (stats: any, reason: "proactive" | "reactive" | "execute_recovery") => {
        logStoreEvent("context_compress", { stats, reason });
      },
    };

    return executeAgentLoop(callbacks, abortCtrl).then(() => {
      closeCurrentHarnessRunMarker("completed", "agent_loop_resolved");
      clearInterval(timerInterval);
      sessionSet({ pendingSlashCommand: null, elapsedTime: getElapsedSeconds() });

      let latestState = sessionGet();
      const queuedAfterRun = normalizeQueuedUserMessage(latestState.queuedUserMessage);
      if (!latestState.config.debugRecordFullTurnProcess) {
        const completedTurn = latestState.conversationTurns.find((turn: any) => turn.id === turnId);
        const completedTurnSummary = String(completedTurn?.summary || "").trim();
        if (completedTurnSummary) {
          const compactedMessages = compactCompletedTurnAgentMessages({
            agentMessages: latestState.agentMessages,
            turnStartIndex: turnAgentMessagesStart,
            turnSummary: completedTurnSummary,
            turnBlocks: latestState.taskFlow.filter((block: any) => block.turnId === turnId),
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
            imageStudio: s.imageStudio,
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
            autoApproveTools: s.autoApproveTools,
            autoApproveToolScopes: s.autoApproveToolScopes,
            queuedUserMessage: s.queuedUserMessage,
            activeGuidance: s.activeGuidance,
          }),
        });
      }
      const handoff = context.approvedPlanHandoff;
      if (handoff) {
        context.approvedPlanHandoff = null;
        runAfterNextPaint(() => {
          const latest = sessionGet();
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
      } else if (queuedAfterRun) {
        sessionSet({
          queuedUserMessage: null,
          input: "",
          contextMentions: [],
          attachedFiles: [],
        });
        runAfterNextPaint(() => {
          const latest = sessionGet();
          const latestSessionKey = resolveSessionRuntimeKey(
            resolveSessionWorkspaceKey(latest.currentWorkspace),
            latest.currentSessionId,
          );
          if (latestSessionKey !== runSessionKey) {
            logStoreEvent("queued_user_message_skipped", {
              reason: "session_changed",
              expectedSessionKey: runSessionKey,
              latestSessionKey,
            });
            return;
          }
          if (latest.isGenerating || latest.agentStatus === "running" || latest.agentStatus === "pending_review") {
            logStoreEvent("queued_user_message_skipped", {
              reason: "agent_busy",
              agentStatus: latest.agentStatus,
            });
            return;
          }
          logStoreEvent("queued_user_message_sending", {
            chars: queuedAfterRun.text.length,
            images: queuedAfterRun.images?.length || 0,
            contextMentions: queuedAfterRun.contextMentions?.length || 0,
            attachedFiles: queuedAfterRun.attachedFiles?.length || 0,
          });
          latest.sendMessage(queuedAfterRun.text, queuedAfterRun.images, {
            contextMentionsSnapshot: queuedAfterRun.contextMentions || [],
            attachedFilesSnapshot: queuedAfterRun.attachedFiles || [],
          });
        });
      }

      return true;
    }).catch((err: any) => {
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
      const crashId = sessionGet()._nextTaskId();
      sessionSet((s: any) => ({
        taskFlow: [...s.taskFlow, {
          id: crashId,
          turnId,
          type: "system" as const,
          content: `❌ Agent loop crashed: ${err instanceof Error ? err.message : String(err)}`,
        }],
        conversationTurns: s.conversationTurns.map((turn: any) =>
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

      return false;
    });
  }
}

function sanitizeFinalTextForPersist(params: { visibleText: string; hiddenThought: string | undefined; language: "zh" | "en" }): string {
  const visible = String(params.visibleText || "").trim();
  const hidden = String(params.hiddenThought || "").trim();
  if (visible) return visible;
  const language = params.language;
  const fallback = language === "en" ? "Task completed." : "任务处理完成。";
  if (hidden) {
    const compactText = compactThoughtContentForPersist(hidden);
    return compactText.length > 240 ? `${compactText.slice(0, 240).trimEnd()}...` : compactText;
  }
  return fallback;
}
