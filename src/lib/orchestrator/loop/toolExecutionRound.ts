import type { HooksConfig } from "../../hooks";
import type { FileReadState } from "../../orchestrator/fileReadCache";
import {
  buildFileReadObservationIdentity,
  buildFileReadWindowIdentity,
  extractStructuredChangedPaths,
  hashString,
  invalidateWorkspaceReadCachesAfterMutation,
  pruneFileReadStates,
} from "../../orchestrator/fileReadCache";
import {
  buildBrowserValidationCacheSignature,
  isBrowserValidationResultCacheable,
} from "../../browserValidation";
import { buildRepeatLoopArgsKey } from "../../repetitionGuard";
import type { PlanToolActivitySummary } from "../../planExecutionRecovery";
import type { ToolDefinition } from "../../toolSchemas";
import type { ToolCatalog } from "../../toolCatalog";
import type { ToolCapabilityRegistry } from "../../toolCapabilities";
import type { TurnInputContextSignals } from "../../turnIntake";
import type { SpawnSubagentResult } from "../../subagents";
import { isWorkspaceMutationToolCall } from "../../workspaceMutationTools";
import { isPtyControlInput } from "../../ptyCommandRuntime";
import {
  getToolExecutionArgs,
  getToolExecutionName,
  hasCompletedToolExecution,
  hasVerifiedWorkspaceMutationEffect,
  mayHaveWorkspaceSideEffects,
} from "../../toolResultEffect";
import {
  executeLocalFileReadToolWithReview,
  executeReadOnlyToolsConcurrently,
  executeWriteToolWithReview,
  logAgentEvent,
  parseToolCallArguments,
  readFileMetadataIfAvailable,
  truncateForLog,
} from "../../orchestrator";
import type {
  CachedReadOnlyToolResult,
  OrchestratorCallbacks,
  ToolCallToExecute,
  ToolExecutionResult,
} from "../types";

export type ReadOnlyToolCallForRound = ToolCallToExecute & {
  allowExternalLocalRead?: boolean;
  authorizationMode?: "automatic" | "session";
  /** Runtime-only lease roots; never accepted from model-authored arguments. */
  scopedReadPaths?: string[];
};

export type LocalFileReadToolCallForRound = ToolCallToExecute & {
  localFileReadPath: string;
};

export type WriteToolCallForRound = ToolCallToExecute & {
  skipUserReview?: boolean;
};

export function shouldAdvanceWorkspaceObservationEpoch(
  toolName: string,
  result: ToolExecutionResult,
  toolArgs: Record<string, unknown> = {},
): boolean {
  const executionName = getToolExecutionName(result) || toolName;
  const executedArgs = getToolExecutionArgs(result, toolArgs);
  const isExplicitWorkspaceMutation = isWorkspaceMutationToolCall(executionName, executedArgs);
  const isNonControlPtyInteraction = toolName === "send_pty_input" &&
    !isPtyControlInput(
      typeof executedArgs.input === "string" ? executedArgs.input : "",
      typeof executedArgs.control === "string" ? executedArgs.control : undefined,
    );
  const isOpaqueWorkspaceAction =
    toolName === "run_command" ||
    toolName === "execute_command" ||
    isNonControlPtyInteraction;
  if (!isExplicitWorkspaceMutation && !isOpaqueWorkspaceAction) return false;
  if (isExplicitWorkspaceMutation) {
    const effectResult = result.name
      ? result
      : { ...result, name: executionName, target: result.target || "", toolCallId: result.toolCallId || "" };
    return hasVerifiedWorkspaceMutationEffect(effectResult, executedArgs) ||
      mayHaveWorkspaceSideEffects(effectResult, executedArgs);
  }
  return hasCompletedToolExecution(result) || mayHaveWorkspaceSideEffects(result, executedArgs);
}

export type ToolExecutionRoundResult =
  | {
      status: "completed";
      results: ToolExecutionResult[];
    }
  | {
      status: "aborted";
      results: ToolExecutionResult[];
    };

export async function executeToolExecutionRound(input: {
  readOnlyCalls: ReadOnlyToolCallForRound[];
  localFileReadCalls: LocalFileReadToolCallForRound[];
  specFileCalls: ToolCallToExecute[];
  writeCalls: WriteToolCallForRound[];
  workspace: string;
  callbacks: OrchestratorCallbacks;
  iteration: number;
  iterationAllTools: ToolDefinition[];
  toolCatalog: ToolCatalog;
  toolCapabilityRegistry: ToolCapabilityRegistry;
  hooksConfig: HooksConfig;
  turnInputContextSignals: TurnInputContextSignals;
  recentPlanToolActivity: PlanToolActivitySummary[];
  attemptedPlanWriteTargets: string[];
  abortSignal: AbortSignal;
  readOnlyCallSignatures: Map<string, string>;
  readFileWindowNarrowedNotes: Map<string, string>;
  readOnlyResultCache: Map<string, CachedReadOnlyToolResult>;
  readOnlyDuplicateSkipCounts: Map<string, number>;
  fileReadStates: Map<string, FileReadState>;
  browserValidationCache: Map<string, ToolExecutionResult>;
  onSubagentSpawnCreated?: (
    outcome: SpawnSubagentResult,
  ) => void | Promise<void>;
}): Promise<ToolExecutionRoundResult> {
  const {
    readOnlyCalls,
    localFileReadCalls,
    specFileCalls,
    writeCalls,
    workspace,
    callbacks,
    iteration,
    iterationAllTools,
    toolCatalog,
    toolCapabilityRegistry,
    hooksConfig,
    turnInputContextSignals,
    recentPlanToolActivity,
    attemptedPlanWriteTargets,
    abortSignal,
    readOnlyCallSignatures,
    readFileWindowNarrowedNotes,
    readOnlyResultCache,
    readOnlyDuplicateSkipCounts,
    fileReadStates,
    browserValidationCache,
  } = input;

  const allResults: ToolExecutionResult[] = [];
  const finishAborted = (): ToolExecutionRoundResult => {
    callbacks.onStatusChange("idle");
    return { status: "aborted", results: allResults };
  };

  if (abortSignal.aborted) return finishAborted();

  if (readOnlyCalls.length > 0) {
    const readResults = await executeReadOnlyToolsConcurrently(
      readOnlyCalls,
      workspace,
      callbacks,
      iterationAllTools,
      hooksConfig,
      {
        abortSignal,
        turnContext: turnInputContextSignals,
        recentPlanToolActivity,
        attemptedPlanWriteTargets,
        toolCatalog,
        toolCapabilityRegistry,
        onSubagentSpawnCreated: input.onSubagentSpawnCreated,
      },
    );
    const normalizedReadResults: ToolExecutionResult[] = [];
    let sawSuccessfulPtyObservation = false;
    for (const result of readResults) {
      if (
        !result.isError &&
        (
          result.name === "read_pty_buffer" ||
          result.name === "read_pty_tail" ||
          result.name === "read_pty_since" ||
          result.name === "get_pty_status"
        )
      ) {
        sawSuccessfulPtyObservation = true;
      }
      const narrowedNote = readFileWindowNarrowedNotes.get(result.toolCallId);
      let resultForModel = narrowedNote && !result.isError
        ? {
            ...result,
            content: `${narrowedNote}\n\n${result.content}`,
            displayContent: result.displayContent || `${narrowedNote}\n\n${result.content}`,
          }
        : result;
      const signature = readOnlyCallSignatures.get(result.toolCallId);
      if (signature && !result.isError) {
        readOnlyResultCache.set(signature, {
          name: result.name,
          target: result.target,
          content: result.content,
        });
        readOnlyDuplicateSkipCounts.delete(signature);
      }
      const fileReadSignature = readOnlyCallSignatures.get(`${result.toolCallId}:file_read`);
      if (fileReadSignature && result.name === "read_file" && !result.isError) {
        const parsedCall = readOnlyCalls.find((call) => call.id === result.toolCallId);
        const args = parsedCall ? parseToolCallArguments(parsedCall, workspace) : {};
        const path = typeof args.path === "string" ? args.path : result.target;
        const metadata = await readFileMetadataIfAvailable(path, workspace);
        const contentHash = hashString(result.content);
        const window = buildFileReadWindowIdentity(result.content);
        const observation = metadata
          ? buildFileReadObservationIdentity({
              requestSignature: fileReadSignature,
              path: metadata.path,
              sizeBytes: metadata.sizeBytes,
              modifiedMs: metadata.modifiedMs,
              contentHash,
              source: "fresh",
              ...(window ? { window } : {}),
            })
          : undefined;
        if (metadata) {
          resultForModel = {
            ...resultForModel,
            readFileObservation: observation,
          };
        }
        const previous = fileReadStates.get(fileReadSignature);
        if (metadata && (!previous || previous.contentHash !== contentHash || previous.modifiedMs !== metadata.modifiedMs || previous.sizeBytes !== metadata.sizeBytes)) {
          fileReadStates.set(fileReadSignature, {
            signature: fileReadSignature,
            path: metadata.path,
            argsKey: buildRepeatLoopArgsKey(
              Object.fromEntries(Object.entries(args).filter(([key]) => key !== "path")),
            ),
            contentHash,
            contentLength: result.content.length,
            sizeBytes: metadata.sizeBytes,
            modifiedMs: metadata.modifiedMs,
            modelContent: result.content,
            observation,
            window,
            updatedAt: Date.now(),
          });
          pruneFileReadStates(fileReadStates);
          logAgentEvent("file_read_cache_stored", {
            iteration,
            target: result.target || metadata.path,
            signature: truncateForLog(fileReadSignature, 180),
            reason: previous ? "content_or_metadata_changed" : "new_read",
            cacheSize: fileReadStates.size,
            sizeBytes: metadata.sizeBytes,
            modifiedMs: metadata.modifiedMs,
            contentChars: result.content.length,
            contentHash,
          });
        } else if (metadata && previous) {
          // Preserve the exact identity/range even when a fresh tool call
          // confirms the same bytes and metadata as the retained observation.
          previous.observation = observation;
          previous.window = window;
          previous.modelContent = result.content;
          previous.contentLength = result.content.length;
          previous.updatedAt = Date.now();
        }
        readOnlyDuplicateSkipCounts.delete(fileReadSignature);
      }
      normalizedReadResults.push(resultForModel);
    }
    if (sawSuccessfulPtyObservation) {
      // A long-running process can mutate files between PTY polls. Exact
      // read_file windows are already guarded by current size/mtime and must
      // retain their versioned replay count; only args-only observations lack
      // that guard and need refreshing here.
      const invalidatedReadOnlyEntries = readOnlyResultCache.size;
      const invalidatedKeys = [...readOnlyResultCache.keys()];
      readOnlyResultCache.clear();
      invalidatedKeys.forEach((key) => readOnlyDuplicateSkipCounts.delete(key));
      logAgentEvent("workspace_read_cache_invalidated_after_pty_observation", {
        iteration,
        invalidatedFileReadStates: 0,
        invalidatedReadOnlyEntries,
      });
    }
    allResults.push(...normalizedReadResults);
    if (abortSignal.aborted) return finishAborted();
  }

  for (const tc of localFileReadCalls) {
    if (abortSignal.aborted) return finishAborted();
    const toolArgs = parseToolCallArguments(tc, workspace);
    const result = await executeLocalFileReadToolWithReview(
      tc,
      toolArgs,
      tc.localFileReadPath,
      workspace,
      callbacks,
      iterationAllTools,
      hooksConfig,
      { toolCatalog, toolCapabilityRegistry },
    );
    allResults.push(result);

    if (abortSignal.aborted) return finishAborted();
  }

  if (abortSignal.aborted) return finishAborted();
  if (specFileCalls.length > 0) {
    const specResults = await executeReadOnlyToolsConcurrently(
      specFileCalls,
      workspace,
      callbacks,
      iterationAllTools,
      hooksConfig,
      {
        abortSignal,
        turnContext: turnInputContextSignals,
        recentPlanToolActivity,
        attemptedPlanWriteTargets,
        toolCatalog,
        toolCapabilityRegistry,
        onSubagentSpawnCreated: input.onSubagentSpawnCreated,
        authorizationMode: "plan_artifact",
      },
    );
    allResults.push(...specResults);
    if (abortSignal.aborted) return finishAborted();
  }

  for (const tc of writeCalls) {
    if (abortSignal.aborted) return finishAborted();
    const result = await executeWriteToolWithReview(
      tc,
      workspace,
      callbacks,
      iterationAllTools,
      hooksConfig,
      {
        turnContext: turnInputContextSignals,
        recentPlanToolActivity,
        attemptedPlanWriteTargets,
        skipUserReview: tc.skipUserReview === true,
        toolCatalog,
        toolCapabilityRegistry,
      },
    );
    allResults.push(result);
    const toolArgs = getToolExecutionArgs(result, parseToolCallArguments(tc, workspace));
    const executionName = getToolExecutionName(result) || tc.name;
    const refreshAfterPtyControl = tc.name === "send_pty_input" &&
      isPtyControlInput(
        typeof toolArgs.input === "string" ? toolArgs.input : "",
        typeof toolArgs.control === "string" ? toolArgs.control : undefined,
      ) &&
      !result.isError &&
      result.lifecycleState !== "blocked" &&
      result.lifecycleState !== "declined";
    if (shouldAdvanceWorkspaceObservationEpoch(executionName, result, toolArgs) || refreshAfterPtyControl) {
      const changedPaths = [
        ...(result.workspaceMutationEvidence?.changedPaths || []),
        ...extractStructuredChangedPaths(result.content),
      ];
      const invalidation = invalidateWorkspaceReadCachesAfterMutation({
        toolName: executionName,
        args: toolArgs,
        target: result.target,
        changedPaths,
        fileReadStates,
        readOnlyResultCache,
        readOnlyDuplicateSkipCounts,
      });
      logAgentEvent("workspace_read_cache_invalidated_after_mutation", {
        iteration,
        tool: executionName,
        target: result.target,
        changedPaths,
        invalidatedFileReadStates: invalidation.invalidatedFileReadSignatures.length,
        invalidatedReadOnlyEntries: invalidation.invalidatedReadOnlyEntries,
      });
    }
    if (
      tc.name !== "browser_evaluate" &&
      browserValidationCache.size > 0 &&
      (hasCompletedToolExecution(result) || mayHaveWorkspaceSideEffects(result, toolArgs))
    ) {
      browserValidationCache.clear();
      logAgentEvent("browser_validation_cache_invalidated", {
        iteration,
        tool: tc.name,
        reason: "non_browser_tool_executed",
      });
    }
    if (tc.name === "browser_evaluate") {
      const toolArgs = parseToolCallArguments(tc, workspace);
      const signature = buildBrowserValidationCacheSignature(toolArgs);
      const cacheable = isBrowserValidationResultCacheable(result.content || result.displayContent || "");
      if (cacheable) browserValidationCache.set(signature, result);
      logAgentEvent(cacheable ? "browser_validation_cache_stored" : "browser_validation_cache_skipped", {
        iteration,
        signature: truncateForLog(signature, 180),
        status: result.isError ? "failed" : "succeeded",
        lifecycleState: result.lifecycleState || null,
        reason: cacheable ? "stable_browser_state" : "transient_or_unstructured_result",
      });
    }

    if (abortSignal.aborted) return finishAborted();
  }

  return { status: "completed", results: allResults };
}
