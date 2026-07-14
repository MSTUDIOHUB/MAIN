import type { HooksConfig } from "../../hooks";
import type { FileReadState } from "../../orchestrator/fileReadCache";
import {
  buildFileReadObservationIdentity,
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
import type { TurnInputContextSignals } from "../../turnIntake";
import { isWorkspaceMutationToolCall } from "../../workspaceMutationTools";
import {
  executeLocalFileReadToolWithReview,
  executeReadOnlyToolsConcurrently,
  executeWriteToolWithReview,
  isReadFileRepeatLimitResult,
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
};

export type LocalFileReadToolCallForRound = ToolCallToExecute & {
  localFileReadPath: string;
};

export type WriteToolCallForRound = ToolCallToExecute & {
  skipUserReview?: boolean;
};

export function shouldAdvanceWorkspaceObservationEpoch(
  toolName: string,
  result: Pick<ToolExecutionResult, "content" | "displayContent" | "isError" | "lifecycleState">,
  toolArgs: Record<string, unknown> = {},
): boolean {
  const isExplicitWorkspaceMutation = isWorkspaceMutationToolCall(toolName, toolArgs);
  const isOpaqueWorkspaceAction =
    toolName === "run_command" ||
    toolName === "execute_command" ||
    toolName === "send_pty_input";
  if (!isExplicitWorkspaceMutation && !isOpaqueWorkspaceAction) return false;
  if (
    result.isError ||
    result.lifecycleState === "blocked" ||
    result.lifecycleState === "declined"
  ) return false;
  if (!isExplicitWorkspaceMutation) return true;
  return !/"noOp"\s*:\s*true|NO_EFFECT_MUTATION|"status"\s*:\s*"(?:no_op|no_effect_mutation)"/i.test(
    result.content || result.displayContent || "",
  );
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
      const readFileRepeatLimitResult = isReadFileRepeatLimitResult(result);
      const narrowedNote = readFileWindowNarrowedNotes.get(result.toolCallId);
      let resultForModel = narrowedNote && !result.isError
        ? {
            ...result,
            content: `${narrowedNote}\n\n${result.content}`,
            displayContent: result.displayContent || `${narrowedNote}\n\n${result.content}`,
          }
        : result;
      const signature = readOnlyCallSignatures.get(result.toolCallId);
      if (signature && !result.isError && !readFileRepeatLimitResult) {
        readOnlyResultCache.set(signature, {
          name: result.name,
          target: result.target,
          content: result.content,
        });
        readOnlyDuplicateSkipCounts.delete(signature);
      }
      const fileReadSignature = readOnlyCallSignatures.get(`${result.toolCallId}:file_read`);
      if (fileReadSignature && result.name === "read_file" && !result.isError && !readFileRepeatLimitResult) {
        const parsedCall = readOnlyCalls.find((call) => call.id === result.toolCallId);
        const args = parsedCall ? parseToolCallArguments(parsedCall, workspace) : {};
        const path = typeof args.path === "string" ? args.path : result.target;
        const metadata = await readFileMetadataIfAvailable(path, workspace);
        const contentHash = hashString(result.content);
        if (metadata) {
          resultForModel = {
            ...resultForModel,
            readFileObservation: buildFileReadObservationIdentity({
              requestSignature: fileReadSignature,
              path: metadata.path,
              sizeBytes: metadata.sizeBytes,
              modifiedMs: metadata.modifiedMs,
              contentHash,
              source: "fresh",
            }),
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
        }
        readOnlyDuplicateSkipCounts.delete(fileReadSignature);
      }
      normalizedReadResults.push(resultForModel);
    }
    if (sawSuccessfulPtyObservation) {
      // A long-running process can mutate files between PTY polls. Treat each
      // successful observation as a new workspace epoch and invalidate after
      // processing the entire concurrent read batch, so a later result in the
      // same batch cannot repopulate a cache that was just cleared.
      const invalidation = invalidateWorkspaceReadCachesAfterMutation({
        toolName: "execute_command",
        args: {},
        fileReadStates,
        readOnlyResultCache,
        readOnlyDuplicateSkipCounts,
      });
      logAgentEvent("workspace_read_cache_invalidated_after_pty_observation", {
        iteration,
        invalidatedFileReadStates: invalidation.invalidatedFileReadSignatures.length,
        invalidatedReadOnlyEntries: invalidation.invalidatedReadOnlyEntries,
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
      },
    );
    allResults.push(result);
    const toolArgs = parseToolCallArguments(tc, workspace);
    if (shouldAdvanceWorkspaceObservationEpoch(tc.name, result, toolArgs)) {
      const invalidation = invalidateWorkspaceReadCachesAfterMutation({
        toolName: tc.name,
        args: toolArgs,
        target: result.target,
        fileReadStates,
        readOnlyResultCache,
        readOnlyDuplicateSkipCounts,
      });
      logAgentEvent("workspace_read_cache_invalidated_after_mutation", {
        iteration,
        tool: tc.name,
        target: result.target,
        invalidatedFileReadStates: invalidation.invalidatedFileReadSignatures.length,
        invalidatedReadOnlyEntries: invalidation.invalidatedReadOnlyEntries,
      });
    }
    if (
      tc.name !== "browser_evaluate" &&
      browserValidationCache.size > 0 &&
      result.lifecycleState !== "blocked" &&
      result.lifecycleState !== "declined"
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
