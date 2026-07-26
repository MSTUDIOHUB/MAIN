import type { AppConfig } from "../../appTypes";
import { compactContextForExecuteRecovery, computeContextBudgets, manageContext } from "../../contextTrim";
import {
  type ExecuteRecoveryMode,
  type RecoveryActionContract,
} from "../../executeRecoveryTools";
import {
  buildFileReadWindowIdentity,
  getFileReadObservationForState,
  selectFileReadStateForRecoveryContext,
  type FileReadState,
} from "../../orchestrator/fileReadCache";
import {
  computeContextForceReason,
  computeManagedContextLimit,
  isContentInActiveMessages,
  logAgentEvent,
  shouldUseXmlToolProtocol,
} from "../../orchestrator";
import type { PlanToolActivitySummary } from "../../planExecutionRecovery";
import type { StreamSettings } from "../../streaming";
import type { ToolDefinition } from "../../toolSchemas";
import { type PlanExecutionProgressPhase } from "../../workflowModels";
import {
  captureLatestUnconsumedToolResultBatch,
  countToolResultChars,
  markLatestUnconsumedToolResultBatch,
  pruneEphemeralItems,
  restoreLatestUnconsumedToolResultBatch,
} from "../state/EphemeralPruner";
import { strainReasoning } from "../state/ReasoningStrainer";
import type { AgentMessage, OrchestratorCallbacks } from "../types";
import type { TurnIterationContext } from "./turnIterationContext";

export interface IterationContextManagementResult {
  managedAgentMessages: AgentMessage[];
  providerCompatibilityOverride: boolean | undefined;
  forceXmlTools: boolean;
  llmTools: ToolDefinition[];
}

/**
 * An explicit recovery observation is the transaction's source identity.
 * Recent activity is only a legacy fallback when the transaction has no
 * identity of its own. Appending a nearby historical window after the active
 * one makes the last system message contradict the exact diagnostic lease and
 * can send a repair back to an already-resolved source range.
 */
export function resolveRecoveryContextObservationKeys(input: {
  leaseObservationKeys?: string[];
  sourceObservationKey?: string | null;
  recentActivityObservationKey?: string | null;
}): string[] {
  const explicitKeys = Array.from(new Set([
    ...(input.leaseObservationKeys || []),
    ...(input.sourceObservationKey ? [input.sourceObservationKey] : []),
  ].map((key) => String(key || "").trim()).filter(Boolean)));
  if (explicitKeys.length > 0) return explicitKeys;
  const fallback = String(input.recentActivityObservationKey || "").trim();
  return fallback ? [fallback] : [];
}

export function buildExecuteRecoverySourceContextMessage(
  state: FileReadState,
  language: "zh" | "en",
): string {
  const observation = getFileReadObservationForState(state, "replay");
  const window = state.window || buildFileReadWindowIdentity(state.modelContent);
  const windowLabel = window
    ? `${window.startLine}-${window.endLine}/${window.totalLines}`
    : "full-or-summary";
  const identity = `observation=${observation.key}; version=${observation.versionToken}; window=${windowLabel}`;
  return language === "zh"
    ? `[System: 恢复源码窗口] 以下是本次修改所依据的精确缓存窗口 (${state.path}; ${identity})。请直接基于该版本和范围修正修改；若工具报告文件版本已变化，再重新读取目标范围。\n\n${state.modelContent}`
    : `[System: Recovery source window] This is the exact cached source window used by the pending edit (${state.path}; ${identity}). Correct the edit from this version and range; reread the target range only if the tool reports a changed file version.\n\n${state.modelContent}`;
}

export function resolveRecoverySourceContextFreshness(input: {
  state: FileReadState;
  currentMetadata: { path: string; sizeBytes: number; modifiedMs: number } | null;
}): {
  current: boolean;
  observedVersion: string;
  currentVersion: string | null;
  reason: "metadata_match" | "metadata_changed" | "metadata_unavailable";
} {
  const observedVersion = `${input.state.sizeBytes}:${input.state.modifiedMs}`;
  if (!input.currentMetadata) {
    return {
      current: false,
      observedVersion,
      currentVersion: null,
      reason: "metadata_unavailable",
    };
  }
  const currentVersion = `${input.currentMetadata.sizeBytes}:${input.currentMetadata.modifiedMs}`;
  const current = input.state.sizeBytes === input.currentMetadata.sizeBytes &&
    input.state.modifiedMs === input.currentMetadata.modifiedMs;
  return {
    current,
    observedVersion,
    currentVersion,
    reason: current ? "metadata_match" : "metadata_changed",
  };
}

export function advanceFileReadContextEvictionEpochs(input: {
  fileReadStates: Map<string, FileReadState>;
  beforeMessages: AgentMessage[];
  afterMessages: AgentMessage[];
}): number {
  let evictions = 0;
  const removedObservationIds: string[] = [];
  for (const state of input.fileReadStates.values()) {
    if (
      isContentInActiveMessages(state.modelContent, input.beforeMessages) &&
      !isContentInActiveMessages(state.modelContent, input.afterMessages)
    ) {
      state.contextEvictionEpoch = (state.contextEvictionEpoch || 0) + 1;
      evictions += 1;
      removedObservationIds.push(getFileReadObservationForState(state, "replay").key);
    }
  }
  if (removedObservationIds.length > 0) {
    const messageChars = (messages: AgentMessage[]) => messages.reduce(
      (sum, message) => sum + String(message.content || "").length,
      0,
    );
    logAgentEvent("file_read_context_eviction_advanced", {
      evictedObservationCount: removedObservationIds.length,
      removedObservationIds: removedObservationIds.slice(0, 24),
      contextCharsBefore: messageChars(input.beforeMessages),
      contextCharsAfter: messageChars(input.afterMessages),
    });
  }
  return evictions;
}

export function buildContextPackTelemetry(input: {
  messagesBefore: number;
  messagesAfter: number;
  managedResult: Pick<
    ReturnType<typeof manageContext>,
    | "tokenCountBefore"
    | "tokenCountAfter"
    | "droppedMessageCount"
    | "microCompactionKind"
    | "microCompactedCount"
  >;
  contextForce: ReturnType<typeof computeContextForceReason>;
}) {
  const { messagesBefore, messagesAfter, managedResult, contextForce } = input;
  return {
    messagesBefore,
    messagesAfter,
    tokenBefore: Math.round(managedResult.tokenCountBefore),
    tokenAfter: Math.round(managedResult.tokenCountAfter),
    droppedMessageCount: managedResult.droppedMessageCount,
    microCompactionKind: managedResult.microCompactionKind,
    microCompactedCount: managedResult.microCompactedCount,
    forceManaged: contextForce.shouldForce,
    forceReason: contextForce.reason,
    textChars: contextForce.textChars,
    toolChars: contextForce.toolChars,
    toolMessages: contextForce.toolMessages,
    estimatedTokens: Math.round(contextForce.estimatedTokens),
    tokenPressure: Number(contextForce.tokenPressure.toFixed(3)),
  };
}

/**
 * A pinned mutation gets one ordinary model attempt with the accumulated
 * investigation. If that phase makes no progress, focus the next attempt once
 * on the durable objective/checkpoint and the exact source window. Later
 * retries reuse that compacted transcript instead of repeatedly rewriting it.
 */
export function shouldFocusPinnedMutationRecoveryContext(input: {
  isExecuteRecoveryEligible: boolean;
  contract: Pick<
    RecoveryActionContract,
    | "phase"
    | "nextRequiredCapability"
    | "expectedTarget"
    | "sourceObservationKey"
    | "phaseNoProgressCount"
    | "decisionCheckpoint"
  >;
}): boolean {
  const { contract } = input;
  const validationRepairCount = Math.max(
    0,
    Math.floor(
      Number(contract.decisionCheckpoint?.validationMutationReopenCount) || 0,
    ),
  );
  return input.isExecuteRecoveryEligible &&
    contract.phase === "mutation" &&
    contract.nextRequiredCapability === "mutation" &&
    Boolean(contract.expectedTarget && contract.sourceObservationKey) &&
    (
      contract.phaseNoProgressCount === 2 ||
      validationRepairCount === 2
    );
}

export const FOCUSED_PINNED_MUTATION_COMPACTION_LIMITS = Object.freeze({
  maxMessages: 18,
  maxToolResultMessages: 6,
  maxToolChars: 10_000,
  maxToolCallGroups: 3,
  maxToolResultTokens: 600,
  latestUserMessages: 2,
});

export function isRecoverySourceStableOutsideNativeToolHistory(
  modelContent: string,
  messages: AgentMessage[],
): boolean {
  if (!modelContent || !modelContent.trim()) return false;
  return messages.some((message) =>
    message.role !== "tool" &&
    typeof message.content === "string" &&
    message.content.includes(modelContent)
  );
}

export function prepareManagedMessagesForIteration(input: {
  callbacks: OrchestratorCallbacks;
  config: AppConfig;
  settings: StreamSettings;
  isCloudProfile: boolean;
  iteration: number;
  workflowMode: "chat" | "edit" | "plan";
  iterationContext: Pick<TurnIterationContext, "eventTurnId" | "turnContext">;
  iterationAllTools: ToolDefinition[];
  snapshotContextLimit: number | null | undefined;
  isExecuteRecoveryEligible: boolean;
  executeRecoveryMode: ExecuteRecoveryMode;
  executeRecoveryReason: string;
  recoveryActionContract: RecoveryActionContract;
  executeRecoveryExpectedTarget?: string | null;
  executeRecoverySourceObservationKey?: string | null;
  executeRecoverySourceObservationKeys?: string[];
  recentToolActivity: PlanToolActivitySummary[];
  fileReadStates: Map<string, FileReadState>;
  emitPlanExecutionProgress: (phase: PlanExecutionProgressPhase) => void;
}): IterationContextManagementResult {
  const {
    callbacks,
    config,
    settings,
    isCloudProfile,
    iteration,
    workflowMode,
    iterationContext,
    iterationAllTools,
    snapshotContextLimit,
    isExecuteRecoveryEligible,
    executeRecoveryMode,
    executeRecoveryReason,
    recoveryActionContract,
    executeRecoveryExpectedTarget,
    executeRecoverySourceObservationKey,
    executeRecoverySourceObservationKeys = [],
    recentToolActivity,
    fileReadStates,
    emitPlanExecutionProgress,
  } = input;
  const { eventTurnId, turnContext } = iterationContext;

  const sourceAgentMessages = callbacks.getMessages() as AgentMessage[];
  const latestUnconsumedToolResultBatch = captureLatestUnconsumedToolResultBatch(sourceAgentMessages);
  const batchMarkedSourceAgentMessages = markLatestUnconsumedToolResultBatch(
    sourceAgentMessages,
    latestUnconsumedToolResultBatch,
  );
  let managedAgentMessages = sourceAgentMessages;
  let burnedToolResults = 0;
  let burnedToolChars = 0;
  let toolCharsAfterPrune = countToolResultChars(sourceAgentMessages);
  let restoredToolResults = 0;
  let reinsertedToolResults = 0;
  let restoredToolChars = 0;
  const providerCompatibilityOverride = callbacks.shouldForceXmlForProviderCompatibility?.();
  const forceXmlTools = shouldUseXmlToolProtocol(
    config,
    settings,
    callbacks.getMessages(),
    providerCompatibilityOverride,
  );
  const llmTools = !forceXmlTools ? iterationAllTools : [];
  const cloudResponsesCompact = isCloudProfile && config.cloud.apiFormat === "responses";
  const contextLimitForManagement = snapshotContextLimit ?? settings.contextLimit ?? null;
  const effectiveContextLimitForManagement = contextLimitForManagement != null
    ? computeManagedContextLimit(contextLimitForManagement, llmTools)
    : null;
  const contextBudgetsForManagement = effectiveContextLimitForManagement != null
    ? computeContextBudgets(effectiveContextLimitForManagement)
    : null;
  const contextForceForManagement = contextBudgetsForManagement
    ? computeContextForceReason({
        messages: callbacks.getMessages() as AgentMessage[],
        iteration,
        workflowMode,
        isPlanApproved: callbacks.getIsPlanApproved(),
        inputBudget: contextBudgetsForManagement.inputBudget,
        proactiveTriggerBudget: contextBudgetsForManagement.proactiveTriggerBudget,
      })
    : null;
  const focusedPinnedMutationRetry = shouldFocusPinnedMutationRecoveryContext({
    isExecuteRecoveryEligible,
    contract: recoveryActionContract,
  });
  const shouldCompactExecuteRecoveryContext =
    contextForceForManagement?.shouldForce === true ||
    focusedPinnedMutationRetry;
  const executeRecoveryCompactionLimits = focusedPinnedMutationRetry
    ? FOCUSED_PINNED_MUTATION_COMPACTION_LIMITS
    : {
        maxMessages: config.activeProfile === "local" ? 60 : 36,
        maxToolResultMessages: config.activeProfile === "local" ? 24 : 12,
        maxToolChars: config.activeProfile === "local" ? 30_000 : 12_000,
        maxToolCallGroups: config.activeProfile === "local" ? 12 : 6,
        maxToolResultTokens: config.activeProfile === "local" ? 1200 : 360,
        latestUserMessages: config.activeProfile === "local" ? 4 : 2,
      };
  let executeRecoveryContextAlreadyCompacted = false;
  if (isExecuteRecoveryEligible && shouldCompactExecuteRecoveryContext) {
    const recoveryMessagesBefore = batchMarkedSourceAgentMessages.length;
    const recoveryManagedResult = compactContextForExecuteRecovery(
      batchMarkedSourceAgentMessages,
      {
        previousMemoryState: callbacks.getContextMemoryState?.() || null,
        turnId: callbacks.getCurrentTurnId?.() || eventTurnId,
        ...executeRecoveryCompactionLimits,
      },
    );
    callbacks.onContextMemoryBuilt?.(recoveryManagedResult.memoryState, recoveryManagedResult.memoryPacket);
    const recoveryRestoration = restoreLatestUnconsumedToolResultBatch(
      recoveryManagedResult.messages as AgentMessage[],
      latestUnconsumedToolResultBatch,
    );
    toolCharsAfterPrune = countToolResultChars(recoveryManagedResult.messages as AgentMessage[]);
    managedAgentMessages = recoveryRestoration.messages;
    restoredToolResults += recoveryRestoration.restoredToolResults;
    reinsertedToolResults += recoveryRestoration.reinsertedToolResults;
    restoredToolChars += recoveryRestoration.restoredToolChars;
    if (recoveryManagedResult.changed) {
      try {
        callbacks.replaceMessages(managedAgentMessages);
      } catch (replaceErr) {
        logAgentEvent("replace_messages_error", {
          iteration,
          error: (replaceErr as Error).message || String(replaceErr),
          messagesLength: managedAgentMessages.length,
          reason: "execute_recovery_context_trim",
        });
      }
      try {
        callbacks.onContextCompress({
          droppedCount: recoveryManagedResult.droppedCount,
          droppedMessageCount: recoveryManagedResult.droppedMessageCount,
          tokenCountBefore: recoveryManagedResult.tokenCountBefore,
          tokenCountAfter: recoveryManagedResult.tokenCountAfter,
          tokenReduction: recoveryManagedResult.tokenReduction,
          compressedContext: recoveryManagedResult.compressedContext,
          displaySummary: recoveryManagedResult.displaySummary,
          memoryPacket: recoveryManagedResult.memoryPacket,
          microCompactionKind: recoveryManagedResult.microCompactionKind,
          microCompactedCount: recoveryManagedResult.microCompactedCount,
          tokenBreakdown: recoveryManagedResult.tokenBreakdownBefore,
        }, "execute_recovery");
      } catch (compressErr) {
        logAgentEvent("on_context_compress_error", {
          iteration,
          error: (compressErr as Error).message || String(compressErr),
          reason: "execute_recovery_context_trim",
        });
      }
    }

    executeRecoveryContextAlreadyCompacted = true;
    logAgentEvent("execute_recovery_context_compacted", {
      iteration,
      executeRecoveryMode,
      executeRecoveryReason,
      forceReason: contextForceForManagement?.shouldForce
        ? contextForceForManagement.reason
        : "pinned_mutation_retry",
      focusedPinnedMutationRetry,
      estimatedTokens: contextForceForManagement
        ? Math.round(contextForceForManagement.estimatedTokens)
        : null,
      tokenPressure: contextForceForManagement
        ? Number(contextForceForManagement.tokenPressure.toFixed(3))
        : null,
      messagesBefore: recoveryMessagesBefore,
      messagesAfter: managedAgentMessages.length,
      droppedMessageCount: recoveryManagedResult.droppedMessageCount,
      tokenBefore: Math.round(recoveryManagedResult.tokenCountBefore),
      tokenAfter: Math.round(recoveryManagedResult.tokenCountAfter),
      tokenReduction: Math.round(recoveryManagedResult.tokenReduction),
      compressionRatio: recoveryManagedResult.tokenCountBefore > 0
        ? Number((recoveryManagedResult.tokenReduction / recoveryManagedResult.tokenCountBefore).toFixed(3))
        : 0,
      toolResultMessagesAfter: managedAgentMessages.filter((message) => message.role === "tool").length,
      toolCharsAfter: managedAgentMessages.reduce((sum, message) =>
        message.role === "tool" && typeof message.content === "string"
          ? sum + message.content.length
          : sum,
      0),
      recoveryToolSurface: recoveryActionContract.surfaceDescription,
    });
  } else if (isExecuteRecoveryEligible) {
    logAgentEvent("execute_recovery_context_skipped", {
      iteration,
      executeRecoveryMode,
      executeRecoveryReason,
      reason: "below_context_threshold",
      estimatedTokens: contextForceForManagement
        ? Math.round(contextForceForManagement.estimatedTokens)
        : null,
      tokenPressure: contextForceForManagement
        ? Number(contextForceForManagement.tokenPressure.toFixed(3))
        : null,
      proactiveTriggerBudget: contextBudgetsForManagement?.proactiveTriggerBudget ?? null,
      recoveryToolSurface: recoveryActionContract.surfaceDescription,
    });
  }
  if (
    !executeRecoveryContextAlreadyCompacted &&
    effectiveContextLimitForManagement != null &&
    contextBudgetsForManagement &&
    contextForceForManagement &&
    (contextForceForManagement.shouldForce || cloudResponsesCompact)
  ) {
    const effectiveContextLimit = effectiveContextLimitForManagement;
    const contextBudgets = contextBudgetsForManagement;
    const { inputBudget, outputBudget } = contextBudgets;
    const contextForce = contextForceForManagement;
    const messagesForPruning = batchMarkedSourceAgentMessages;

    const strainResult = strainReasoning(messagesForPruning, {
      currentTurnReasoningThreshold: config.activeProfile === "local" ? 1200 : 2000,
    });
    const reasoningStrained = strainResult.messages;
    if (strainResult.isReasoningDominated) {
      logAgentEvent("reasoning_dominated_detected", {
        turnId: eventTurnId,
        reasoningChars: strainResult.totalPurgedReasoningChars,
        messagesStrained: strainResult.messagesStrained,
      });
    }

    const prunedResult = pruneEphemeralItems(
      reasoningStrained,
      turnContext,
      {
        maxToolChars: config.activeProfile === "local" ? 2000 : 4000,
        maxReasoningChars: 500,
        purgeReasoningFromPriorTurns: true,
      },
    );
    burnedToolResults = prunedResult.burnedToolResults;
    burnedToolChars = prunedResult.burnedToolChars;
    toolCharsAfterPrune = prunedResult.toolCharsAfter;
    const prunedMessages = prunedResult.messages;

    for (const _rep of turnContext.getBurnedReplacements()) {
      // Replacements were recorded during pruneEphemeralItems.
    }

    const isUnapprovedPlanContext = workflowMode === "plan" && !callbacks.getIsPlanApproved();
    const forcedContextToolBudget = contextForce.shouldForce
      ? callbacks.getIsPlanApproved()
        ? 1200
        : isUnapprovedPlanContext
        ? 1000
        : 1600
      : null;
    const forcedContextAssistantBudget = contextForce.shouldForce
      ? callbacks.getIsPlanApproved()
        ? 900
        : isUnapprovedPlanContext
        ? 700
        : 1000
      : null;

    const managedResult = manageContext(
      prunedMessages,
      effectiveContextLimit,
      cloudResponsesCompact ? Math.min(outputBudget, 2048) : outputBudget,
      cloudResponsesCompact
        ? 700
        : forcedContextToolBudget
        ? forcedContextToolBudget
        : isUnapprovedPlanContext
        ? 1200
        : callbacks.getIsPlanApproved()
        ? 2200
        : Math.max(4000, Math.floor(inputBudget * 0.32)),
      cloudResponsesCompact
        ? 500
        : forcedContextAssistantBudget
        ? forcedContextAssistantBudget
        : isUnapprovedPlanContext
        ? 900
        : callbacks.getIsPlanApproved()
        ? 1400
        : Math.max(2000, Math.floor(inputBudget * 0.18)),
      contextForce.shouldForce,
      {
        previousMemoryState: callbacks.getContextMemoryState?.() || null,
        turnId: callbacks.getCurrentTurnId?.() || eventTurnId,
      },
    );
    callbacks.onContextMemoryBuilt?.(managedResult.memoryState, managedResult.memoryPacket);
    logAgentEvent("context_memory_built", {
      memoryId: managedResult.memoryState.id,
      goals: managedResult.memoryState.goals.length,
      constraints: managedResult.memoryState.constraints.length,
      evidence: managedResult.memoryState.evidence.length,
      files: managedResult.memoryState.files.length,
      packetChars: managedResult.memoryPacket.length,
    });
    const managedRestoration = restoreLatestUnconsumedToolResultBatch(
      managedResult.messages as AgentMessage[],
      latestUnconsumedToolResultBatch,
    );
    managedAgentMessages = managedRestoration.messages;
    restoredToolResults += managedRestoration.restoredToolResults;
    reinsertedToolResults += managedRestoration.reinsertedToolResults;
    restoredToolChars += managedRestoration.restoredToolChars;
    try {
      if (managedResult.changed) {
        callbacks.replaceMessages(managedAgentMessages);
      }
    } catch (replaceErr) {
      logAgentEvent("replace_messages_error", {
        iteration,
        error: (replaceErr as Error).message || String(replaceErr),
        messagesLength: managedAgentMessages.length,
        reason: "proactive_context_trim",
      });
    }
    const compressionRatio = managedResult.tokenCountBefore > 0
      ? managedResult.tokenReduction / managedResult.tokenCountBefore
      : 0;
    const shouldAnnounceCompression =
      managedResult.droppedMessageCount > 0 ||
      managedResult.tokenReduction >= 1024 ||
      compressionRatio >= 0.05;
    if (managedResult.changed && shouldAnnounceCompression) {
      try {
        callbacks.onContextCompress({
          droppedCount: managedResult.droppedCount,
          droppedMessageCount: managedResult.droppedMessageCount,
          tokenCountBefore: managedResult.tokenCountBefore,
          tokenCountAfter: managedResult.tokenCountAfter,
          tokenReduction: managedResult.tokenReduction,
          compressedContext: managedResult.compressedContext,
          displaySummary: managedResult.displaySummary,
          memoryPacket: managedResult.memoryPacket,
          microCompactionKind: managedResult.microCompactionKind,
          microCompactedCount: managedResult.microCompactedCount,
          tokenBreakdown: managedResult.tokenBreakdownBefore,
        }, "proactive");
        emitPlanExecutionProgress("context_compression");
      } catch (compressErr) {
        logAgentEvent("on_context_compress_error", {
          iteration,
          error: (compressErr as Error).message || String(compressErr),
          reason: "proactive_context_trim",
        });
      }
    }
    logAgentEvent("context_pack_built", buildContextPackTelemetry({
      messagesBefore: callbacks.getMessages().length,
      messagesAfter: managedAgentMessages.length,
      managedResult,
      contextForce,
    }));
  }

  const toolCharsBefore = countToolResultChars(sourceAgentMessages);
  if (toolCharsBefore > 0) {
    logAgentEvent("ephemeral_prune_summary", {
      iteration,
      burnedToolResults,
      burnedToolChars,
      preservedToolResults: latestUnconsumedToolResultBatch?.toolResults.length || 0,
      preservedToolChars: latestUnconsumedToolResultBatch?.toolChars || 0,
      restoredToolResults,
      reinsertedToolResults,
      restoredToolChars,
      toolCharsBefore,
      toolCharsAfterPrune,
      toolCharsAfter: countToolResultChars(managedAgentMessages),
    });
  }

  const recoverySourceContract = recoveryActionContract;
  if (
    executeRecoveryMode !== "normal" &&
    (recoverySourceContract.phase === "context" || recoverySourceContract.phase === "mutation")
  ) {
    const lastActivity = recentToolActivity[recentToolActivity.length - 1];
    const failedTarget = lastActivity?.status === "failed" ? lastActivity.target : "";
    const activityObservation = lastActivity?.readFileObservation;
    const observationKeys = resolveRecoveryContextObservationKeys({
      leaseObservationKeys: executeRecoverySourceObservationKeys,
      sourceObservationKey: executeRecoverySourceObservationKey,
      recentActivityObservationKey: activityObservation?.key,
    });
    const targetPath = executeRecoveryExpectedTarget || failedTarget;
    // Never substitute "the newest window for this path" for a missing
    // observation identity. That previously pinned an unrelated tail window
    // after a patch mismatch and made the recovery prompt contradict its
    // exact target range.
    for (const observationKey of observationKeys) {
      const matchedState = selectFileReadStateForRecoveryContext({
        states: fileReadStates,
        targetPath,
        observationKey,
      });
      if (matchedState?.modelContent) {
        const observation = getFileReadObservationForState(matchedState, "replay");
        const window = matchedState.window || buildFileReadWindowIdentity(matchedState.modelContent);
        const sourceAlreadyActive = isContentInActiveMessages(
          matchedState.modelContent,
          managedAgentMessages,
        );
        const sourceStableOutsideNativeToolHistory =
          isRecoverySourceStableOutsideNativeToolHistory(
            matchedState.modelContent,
            managedAgentMessages,
          );
        if (!sourceStableOutsideNativeToolHistory) {
          managedAgentMessages = [
            ...managedAgentMessages,
            {
              role: "system",
              content: buildExecuteRecoverySourceContextMessage(
                matchedState,
                callbacks.getPreferredLanguage(),
              ),
            } as AgentMessage,
          ];
        }
        logAgentEvent("execute_recovery_source_context_pinned", {
          iteration,
          target: matchedState.path,
          observationKey: observation.key,
          versionToken: observation.versionToken,
          requestSignature: observation.requestSignature,
          windowStartLine: window?.startLine ?? null,
          windowEndLine: window?.endLine ?? null,
          totalLines: window?.totalLines ?? null,
          sourceAlreadyActive,
          sourceStableOutsideNativeToolHistory,
          contentChars: matchedState.modelContent.length,
        });
      }
    }
  }

  const fileReadContextEvictions = advanceFileReadContextEvictionEpochs({
    fileReadStates,
    beforeMessages: sourceAgentMessages,
    afterMessages: managedAgentMessages,
  });
  if (fileReadContextEvictions > 0) {
    logAgentEvent("file_read_context_eviction_epoch_advanced", {
      iteration,
      evictedWindows: fileReadContextEvictions,
    });
  }

  return {
    managedAgentMessages,
    providerCompatibilityOverride,
    forceXmlTools,
    llmTools,
  };
}
