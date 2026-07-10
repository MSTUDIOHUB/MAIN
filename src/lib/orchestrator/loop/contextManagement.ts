import type { AppConfig } from "../../appTypes";
import { compactContextForExecuteRecovery, computeContextBudgets, manageContext } from "../../contextTrim";
import { type ExecuteRecoveryMode } from "../../executeRecoveryTools";
import { type FileReadState } from "../../orchestrator/fileReadCache";
import { describeExecuteRecoveryToolSurface } from "../../executeRecoveryTools";
import {
  computeContextForceReason,
  computeManagedContextLimit,
  logAgentEvent,
  shouldUseXmlToolProtocol,
} from "../../orchestrator";
import type { PlanToolActivitySummary } from "../../planExecutionRecovery";
import type { StreamSettings } from "../../streaming";
import type { ToolDefinition } from "../../toolSchemas";
import { type PlanExecutionProgressPhase } from "../../workflowModels";
import { pruneEphemeralItems } from "../state/EphemeralPruner";
import { strainReasoning } from "../state/ReasoningStrainer";
import type { AgentMessage, OrchestratorCallbacks } from "../types";
import type { TurnIterationContext } from "./turnIterationContext";

export interface IterationContextManagementResult {
  managedAgentMessages: AgentMessage[];
  providerCompatibilityOverride: boolean | undefined;
  forceXmlTools: boolean;
  llmTools: ToolDefinition[];
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
  recentToolActivity: PlanToolActivitySummary[];
  fileReadStates: Map<string, FileReadState>;
  allowExecuteRecoveryFileRead: boolean;
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
    recentToolActivity,
    fileReadStates,
    allowExecuteRecoveryFileRead,
    emitPlanExecutionProgress,
  } = input;
  const { eventTurnId, turnContext } = iterationContext;

  let managedAgentMessages = callbacks.getMessages() as AgentMessage[];
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
        proactiveTriggerBudget: isExecuteRecoveryEligible
          ? Math.min(16000, contextBudgetsForManagement.proactiveTriggerBudget)
          : contextBudgetsForManagement.proactiveTriggerBudget,
      })
    : null;
  let executeRecoveryContextAlreadyCompacted = false;
  if (isExecuteRecoveryEligible && contextForceForManagement?.shouldForce) {
    const recoveryMessagesBefore = callbacks.getMessages().length;
    const recoveryManagedResult = compactContextForExecuteRecovery(
      callbacks.getMessages(),
      {
        previousMemoryState: callbacks.getContextMemoryState?.() || null,
        turnId: callbacks.getCurrentTurnId?.() || eventTurnId,
        maxMessages: config.activeProfile === "local" ? 60 : 36,
        maxToolResultMessages: config.activeProfile === "local" ? 24 : 12,
        maxToolChars: config.activeProfile === "local" ? 30000 : 12000,
        maxToolCallGroups: config.activeProfile === "local" ? 12 : 6,
        maxToolResultTokens: config.activeProfile === "local" ? 1200 : 360,
        latestUserMessages: config.activeProfile === "local" ? 4 : 2,
      },
    );
    callbacks.onContextMemoryBuilt?.(recoveryManagedResult.memoryState, recoveryManagedResult.memoryPacket);
    managedAgentMessages = recoveryManagedResult.messages as AgentMessage[];
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

    if (executeRecoveryMode !== "normal" && recentToolActivity.length > 0) {
      const lastActivity = recentToolActivity[recentToolActivity.length - 1];
      if (lastActivity && lastActivity.target && lastActivity.status === "failed") {
        const targetPath = lastActivity.target.trim().replace(/^['"]|['"]$/g, "");
        let matchedState;
        for (const state of fileReadStates.values()) {
          if (targetPath.includes(state.path) || state.path.includes(targetPath)) {
            matchedState = state;
            break;
          }
        }
        if (matchedState && matchedState.modelContent) {
          const lines = matchedState.modelContent.split("\n");
          const truncatedContent = lines.slice(0, 150).join("\n");
          const isTruncated = lines.length > 150;
          const language = callbacks.getPreferredLanguage();
          const adaptiveMessage = language === "zh"
            ? `[System: 恢复模式自适应上下文保留] 这是你最近尝试修改但失败的文件 (${matchedState.path}) 的缓存内容${isTruncated ? "（前 150 行）" : ""}：\n\n${truncatedContent}\n\n[请基于此内容重新生成正确的修改操作]`
            : `[System: Recovery Mode Adaptive Context] Here is the cached content of the file you recently failed to edit (${matchedState.path})${isTruncated ? " (first 150 lines)" : ""}:\n\n${truncatedContent}\n\n[Please base your corrected edit on this content]`;
          managedAgentMessages = [
            ...managedAgentMessages,
            { role: "system", content: adaptiveMessage } as AgentMessage,
          ];
          logAgentEvent("execute_recovery_adaptive_context_injected", {
            iteration,
            target: matchedState.path,
            lines: Math.min(lines.length, 150),
          });
        }
      }
    }
    executeRecoveryContextAlreadyCompacted = true;
    logAgentEvent("execute_recovery_context_compacted", {
      iteration,
      executeRecoveryMode,
      executeRecoveryReason,
      forceReason: contextForceForManagement.reason,
      estimatedTokens: Math.round(contextForceForManagement.estimatedTokens),
      tokenPressure: Number(contextForceForManagement.tokenPressure.toFixed(3)),
      messagesBefore: recoveryMessagesBefore,
      messagesAfter: managedAgentMessages.length,
      droppedMessageCount: recoveryManagedResult.droppedMessageCount,
      tokenBefore: Math.round(recoveryManagedResult.tokenCountBefore),
      tokenAfter: Math.round(recoveryManagedResult.tokenCountAfter),
      toolResultMessagesAfter: managedAgentMessages.filter((message) => message.role === "tool").length,
      toolCharsAfter: managedAgentMessages.reduce((sum, message) =>
        message.role === "tool" && typeof message.content === "string"
          ? sum + message.content.length
          : sum,
      0),
      recoveryToolSurface: describeExecuteRecoveryToolSurface(executeRecoveryMode, allowExecuteRecoveryFileRead),
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
      recoveryToolSurface: describeExecuteRecoveryToolSurface(executeRecoveryMode, allowExecuteRecoveryFileRead),
    });
  }
  if (
    !executeRecoveryContextAlreadyCompacted &&
    effectiveContextLimitForManagement != null &&
    contextBudgetsForManagement &&
    contextForceForManagement
  ) {
    const effectiveContextLimit = effectiveContextLimitForManagement;
    const contextBudgets = contextBudgetsForManagement;
    const { inputBudget, outputBudget } = contextBudgets;
    const contextForce = contextForceForManagement;
    const messagesForPruning = callbacks.getMessages();

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
    managedAgentMessages = managedResult.messages as AgentMessage[];
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

  return {
    managedAgentMessages,
    providerCompatibilityOverride,
    forceXmlTools,
    llmTools,
  };
}
