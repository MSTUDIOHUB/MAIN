import type { HooksConfig } from "../../hooks";
import type { FileReadState } from "../../orchestrator/fileReadCache";
import {
  hashString,
  pruneFileReadStates,
} from "../../orchestrator/fileReadCache";
import {
  buildRepeatLoopArgsKey,
  buildRepeatLoopSignature,
} from "../../repetitionGuard";
import type { PlanToolActivitySummary } from "../../planExecutionRecovery";
import type { ToolDefinition } from "../../toolSchemas";
import type { TurnInputContextSignals } from "../../turnIntake";
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
    for (const result of readResults) {
      const readFileRepeatLimitResult = isReadFileRepeatLimitResult(result);
      const narrowedNote = readFileWindowNarrowedNotes.get(result.toolCallId);
      const resultForModel = narrowedNote && !result.isError
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
    allResults.push(...normalizedReadResults);
  }

  for (const tc of localFileReadCalls) {
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

    if (abortSignal.aborted) {
      callbacks.onStatusChange("idle");
      return { status: "aborted", results: allResults };
    }
  }

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
  }

  for (const tc of writeCalls) {
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
    if (tc.name !== "browser_evaluate" && browserValidationCache.size > 0) {
      browserValidationCache.clear();
      logAgentEvent("browser_validation_cache_invalidated", {
        iteration,
        tool: tc.name,
        reason: "non_browser_tool_executed",
      });
    }
    if (tc.name === "browser_evaluate") {
      const toolArgs = parseToolCallArguments(tc, workspace);
      const signature = buildRepeatLoopSignature(tc.name, buildRepeatLoopArgsKey(toolArgs));
      browserValidationCache.set(signature, result);
    }

    if (abortSignal.aborted) {
      callbacks.onStatusChange("idle");
      return { status: "aborted", results: allResults };
    }
  }

  return { status: "completed", results: allResults };
}
