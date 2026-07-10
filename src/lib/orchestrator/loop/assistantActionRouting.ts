import { isSyntheticVisibleConclusion } from "../../normalizedTurn";
import {
  choosePseudoToolRecovery,
  extractPseudoToolCallName,
  extractUserMentionedFilePathsFromMessages,
  looksLikeNonStandardToolCallFormat,
  looksLikePseudoToolCallPlaceholder,
  type PseudoToolRecoveryDecision,
} from "../../orchestrator/agentRecovery";
import { WEB_RESEARCH_TOOL_NAMES } from "../../orchestrator";
import type { PlanToolActivitySummary } from "../../planExecutionRecovery";
import type { LegacyWorkflowMode, ResolvedUserIntent } from "../../runIntent";
import { buildRequiredWebResearchQuery, shouldRequireWebResearchForPrompt } from "../../webResearchGuard";
import type { ReplyOption } from "../../workflowModels";
import { generateId } from "../../utils";
import type { AgentMessage, ToolCallToExecute } from "../types";

export interface AssistantActionRoutingDecision {
  effectiveToolCalls: ToolCallToExecute[];
  recoveredPseudoToolCall: boolean;
  injectedRequiredWebResearchCall: boolean;
  pseudoToolNameCandidate: string | null;
  pseudoRecovery: PseudoToolRecoveryDecision | null;
  pseudoToolCallPlaceholder: boolean;
  syntheticVisibleConclusion: boolean;
  userVisibleText: string;
  webResearchQuery: string | null;
  webResearchProvider: string | null;
}

export function resolveAssistantActionRouting(input: {
  effectiveToolCalls: ToolCallToExecute[];
  finalReplyOptions: ReplyOption[];
  compactedProseCodeDump: boolean;
  compactedIncompletePlanText: boolean;
  streamText: string;
  normalizedVisibleText: string;
  normalizedHiddenThought: string;
  finalVisibleText: string;
  messages: AgentMessage[];
  availableToolNames: Set<string>;
  workflowMode: LegacyWorkflowMode;
  turnIntent: ResolvedUserIntent;
  runtimeIntent: ResolvedUserIntent;
  webSearchEnabled: boolean;
  latestUserPromptText: string;
  recentToolActivity: PlanToolActivitySummary[];
  webSearchProvider?: string | null;
  buildToolCallId?: () => string;
}): AssistantActionRoutingDecision {
  let effectiveToolCalls = input.effectiveToolCalls;
  let recoveredPseudoToolCall = false;
  let injectedRequiredWebResearchCall = false;
  let pseudoRecovery: PseudoToolRecoveryDecision | null = null;
  let webResearchQuery: string | null = null;
  let webResearchProvider: string | null = null;

  const canRecoverMissingToolCall =
    effectiveToolCalls.length === 0 &&
    input.finalReplyOptions.length === 0 &&
    !input.compactedProseCodeDump &&
    !input.compactedIncompletePlanText;
  const pseudoToolNameCandidate = canRecoverMissingToolCall
    ? extractPseudoToolCallName(input.normalizedVisibleText) ||
      extractPseudoToolCallName(input.normalizedHiddenThought) ||
      extractPseudoToolCallName(input.streamText)
    : null;

  if (pseudoToolNameCandidate) {
    pseudoRecovery = choosePseudoToolRecovery({
      pseudoToolName: pseudoToolNameCandidate,
      availableToolNames: input.availableToolNames,
      mentionedPaths: extractUserMentionedFilePathsFromMessages(input.messages),
      workflowMode: input.workflowMode,
      turnIntent: input.turnIntent,
    });
    if (pseudoRecovery.call) {
      recoveredPseudoToolCall = true;
      effectiveToolCalls = [pseudoRecovery.call];
    }
  }

  const shouldInjectRequiredWebResearchCall =
    input.webSearchEnabled &&
    input.workflowMode === "chat" &&
    input.runtimeIntent === "respond" &&
    effectiveToolCalls.length === 0 &&
    input.finalReplyOptions.length === 0 &&
    input.availableToolNames.has("web_search") &&
    shouldRequireWebResearchForPrompt(input.latestUserPromptText) &&
    !input.recentToolActivity.some((activity) =>
      WEB_RESEARCH_TOOL_NAMES.has(activity.name || ""),
    );

  if (shouldInjectRequiredWebResearchCall) {
    injectedRequiredWebResearchCall = true;
    webResearchQuery = buildRequiredWebResearchQuery(input.latestUserPromptText);
    webResearchProvider = input.webSearchProvider || "duckduckgo";
    effectiveToolCalls = [{
      id: input.buildToolCallId?.() || `call_${generateId()}`,
      name: "web_search",
      arguments: JSON.stringify({
        query: webResearchQuery,
        provider: webResearchProvider,
        max_results: 5,
      }),
    }];
  }

  const pseudoToolCallPlaceholder =
    effectiveToolCalls.length === 0 &&
    input.finalReplyOptions.length === 0 &&
    !input.compactedProseCodeDump &&
    !input.compactedIncompletePlanText &&
    (
      looksLikePseudoToolCallPlaceholder(input.normalizedVisibleText) ||
      looksLikePseudoToolCallPlaceholder(input.normalizedHiddenThought) ||
      looksLikeNonStandardToolCallFormat(input.streamText)
    );
  const syntheticVisibleConclusion =
    !input.compactedProseCodeDump &&
    !input.compactedIncompletePlanText &&
    (
      recoveredPseudoToolCall ||
      isSyntheticVisibleConclusion(input.finalVisibleText) ||
      pseudoToolCallPlaceholder
    );

  return {
    effectiveToolCalls,
    recoveredPseudoToolCall,
    injectedRequiredWebResearchCall,
    pseudoToolNameCandidate,
    pseudoRecovery,
    pseudoToolCallPlaceholder,
    syntheticVisibleConclusion,
    userVisibleText: syntheticVisibleConclusion ? "" : input.finalVisibleText,
    webResearchQuery,
    webResearchProvider,
  };
}
