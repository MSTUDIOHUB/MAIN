import { getToolTarget } from "../../lib/toolTarget";
import {
  ensureVersionedReadFileResultForModel,
  extractReadFileWindowMetadata,
} from "../../lib/readFileWindow";
import { executeTool } from "../../lib/toolExecutor";
import { isWorkspaceMutationToolName } from "../../lib/workspaceMutationTools";
import {
  isRuntimeV2LifecycleDeadlineError,
  type RuntimeV2Command,
  type ToolPort,
} from "../../lib/runtime-v2";
import { RUNTIME_V2_SOURCE_READ_TOOL_NAMES } from "../../lib/runtime-v2/workspaceReadPolicy";
import {
  RUNTIME_V2_VALIDATION_TOOL_NAMES,
  aggregateForCurrentTurn,
  authorizationFor,
  boundedRuntimeV2ToolContent,
  boundedToolContent,
  toolResultContentForModel,
  toolResultStatusForCompletion,
  nextEvidenceId,
  recordToolResultHistory,
  runtimeV2ContextBoundToolArguments,
  runtimeV2SourceToolContent,
  stringValue,
  toolCompletionFor,
  toolDefinitionExists,
  validateToolAgainstPhaseAndPlan,
  upsertRuntimeV2ContextAnchor,
  type RuntimeV2ExecutionPortsInput,
} from "./executionContext";
import { resolveRuntimeV2SourceEvidenceVersion } from "./sourceEvidenceVersion";
import {
  executeRuntimeV2ToolWithDeadline,
  type RuntimeV2ToolDeadlineBoundary,
} from "./executionToolDeadline";
import { prepareRuntimeV2Mutation } from "./executionMutationPreflight";
import {
  runtimeV2ProviderToolCallIdentity,
} from "./providerToolSurface";
import { runtimeV2MutationFailureContextTarget } from "./correctiveMutationPolicy";
import { resolveRuntimeV2ToolAuthorization } from "./executionExternalLocalRead";
import {
  RECORD_RUNTIME_V2_EXECUTION_CONTRACT_TOOL_NAME,
  deriveRuntimeV2ExecutionContract,
  parseRuntimeV2ExecutionContractArguments,
} from "./executionContract";

function logRuntimeV2ToolDeadline(input: {
  readonly ports: RuntimeV2ExecutionPortsInput;
  readonly command: RuntimeV2Command;
  readonly toolName: string;
  readonly target: string | null;
  readonly timeoutMs: number;
  readonly boundary: RuntimeV2ToolDeadlineBoundary;
}): void {
  input.ports.logStoreEvent(
    input.boundary === "lifecycle"
      ? "runtime_v2_lifecycle_deadline_reached"
      : "runtime_v2_tool_deadline_exceeded",
    {
      turnId: input.command.run.turnId,
      runId: input.command.run.runId,
      commandKind: input.command.kind,
      toolName: input.toolName,
      target: input.target,
      timeoutMs: input.timeoutMs,
      lifecycleDeadlineAt: input.boundary === "lifecycle"
        ? input.ports.lifecycleDeadlineAt
        : null,
    },
  );
}

export function createRuntimeV2ToolPort(input: RuntimeV2ExecutionPortsInput): ToolPort {
  return {
    async execute({ command, signal }) {
      if (command.kind === "collect_observation") {
        input.logStoreEvent("runtime_v2_tool_execution_started", {
          turnId: command.run.turnId,
          runId: command.run.runId,
          commandKind: command.kind,
          toolName: "get_project_skeleton",
          target: input.context.runWorkspace || "workspace",
        });
        try {
          const overview = boundedToolContent(
            await executeRuntimeV2ToolWithDeadline({
              toolName: "get_project_skeleton",
              lifecycleDeadlineAt: input.lifecycleDeadlineAt,
              now: input.now,
              onTimeout: (timeoutMs, boundary) =>
                logRuntimeV2ToolDeadline({
                  ports: input,
                  command,
                  toolName: "get_project_skeleton",
                  target: input.context.runWorkspace || "workspace",
                  timeoutMs,
                  boundary,
                }),
              task: () => executeTool(
                "get_project_skeleton",
                {},
                input.context.runWorkspace || "",
                input.context.runSessionKey,
                { toolCatalog: authorizationFor(input).toolCatalog },
              ),
            }),
            12_000,
          );
          const evidenceId = nextEvidenceId(input.live);
          upsertRuntimeV2ContextAnchor(input.live, {
            key: "workspace-overview",
            content: overview,
          });
          input.logStoreEvent("runtime_v2_tool_execution_completed", {
            turnId: command.run.turnId,
            runId: command.run.runId,
            commandKind: command.kind,
            toolName: "get_project_skeleton",
            target: input.context.runWorkspace || "workspace",
            status: "succeeded",
          });
          return {
            type: "observation.recorded",
            run: command.run,
            evidence: {
              id: evidenceId,
              kind: "source",
              target: input.context.runWorkspace || "workspace",
              version: null,
            },
          };
        } catch (error) {
          if (isRuntimeV2LifecycleDeadlineError(error)) throw error;
          input.logStoreEvent("runtime_v2_tool_execution_failed", {
            turnId: command.run.turnId,
            runId: command.run.runId,
            commandKind: command.kind,
            toolName: "get_project_skeleton",
            target: input.context.runWorkspace || "workspace",
            error: error instanceof Error ? error.message : String(error),
          });
          throw error;
        }
      }

      if (command.kind !== "execute_tool" && command.kind !== "execute_validation") {
        throw new Error(`Unsupported Runtime v2 tool command: ${command.kind}`);
      }
      const toolName = stringValue(command.payload.toolName, 256);
      const args = command.payload.arguments && typeof command.payload.arguments === "object" && !Array.isArray(command.payload.arguments)
        ? command.payload.arguments as Record<string, unknown>
        : {};
      const target = getToolTarget(toolName, args);
      const toolCallId = String(command.payload.toolCallId || "");
      const parallelReadCount = input.live.parallelReadCountByToolCallId.get(toolCallId) || 1;
      input.live.parallelReadCountByToolCallId.delete(toolCallId);
      // Keep authorization bound to the provider's actual arguments. For
      // recovery correlation only, attribute a target-less failed editor to
      // the active mutation lease. Otherwise an empty native tool payload is
      // recorded against the literal tool name and the same broken editor
      // remains eligible forever on the leased source version.
      const failureContextTarget =
        runtimeV2MutationFailureContextTarget({
          ports: input,
          toolCallId,
          toolName,
          requestedTarget: target,
        });
      input.logStoreEvent("runtime_v2_tool_execution_started", {
        turnId: command.run.turnId,
        runId: command.run.runId,
        commandKind: command.kind,
        toolName,
        target: target || null,
      });
      const hasCoveredSourceReceipt =
        !!toolCallId &&
        input.live.coveredReadToolResults.has(toolCallId);
      const cachedSourceReceipt = hasCoveredSourceReceipt
        ? input.live.coveredReadToolResults.get(toolCallId) || null
        : null;
      if (hasCoveredSourceReceipt) {
        input.live.coveredReadToolResults.delete(toolCallId);
      }
      if (cachedSourceReceipt) {
        const replayedActionIdentity =
          runtimeV2ProviderToolCallIdentity({
            name: toolName,
            arguments: args,
          });
        recordToolResultHistory({
          ports: input,
          command,
          toolName,
          target,
          status: "succeeded",
          content: cachedSourceReceipt,
        });
        input.logStoreEvent("runtime_v2_source_receipt_replayed", {
          turnId: command.run.turnId,
          runId: command.run.runId,
          toolName,
          target: target || null,
          sourceVersion:
            extractReadFileWindowMetadata(cachedSourceReceipt)
              ?.contentVersion || null,
          actionIdentity: replayedActionIdentity,
        });
        const replayCompletion = toolCompletionFor(
          input,
          command,
          toolName,
          args,
          target,
          cachedSourceReceipt,
          "succeeded",
          undefined,
          extractReadFileWindowMetadata(cachedSourceReceipt)
            ?.contentVersion,
        );
        return replayCompletion.type === "tool.completed"
          ? {
              ...replayCompletion,
              evidence: [],
              receiptOrigin: "replayed",
            }
          : replayCompletion;
      }
      if (!toolDefinitionExists(input, toolName)) {
        recordToolResultHistory({
          ports: input,
          command,
          toolName,
          target: failureContextTarget,
          status: "failed",
          content: `UNKNOWN_TOOL: ${toolName}`,
        });
        input.logStoreEvent("runtime_v2_tool_execution_rejected", {
          turnId: command.run.turnId,
          runId: command.run.runId,
          commandKind: command.kind,
          toolName,
          target: target || null,
          reason: "unknown_tool",
        });
        return toolCompletionFor(
          input,
          command,
          toolName,
          args,
          failureContextTarget,
          `UNKNOWN_TOOL: ${toolName}`,
          "failed",
          "protocol_invalid",
        );
      }
      if (command.kind === "execute_validation" && !RUNTIME_V2_VALIDATION_TOOL_NAMES.has(toolName)) {
        recordToolResultHistory({
          ports: input,
          command,
          toolName,
          target: failureContextTarget,
          status: "failed",
          content: `VALIDATION_TOOL_REJECTED: ${toolName}`,
        });
        input.logStoreEvent("runtime_v2_tool_execution_rejected", {
          turnId: command.run.turnId,
          runId: command.run.runId,
          commandKind: command.kind,
          toolName,
          target: target || null,
          reason: "validation_tool_required",
        });
        return toolCompletionFor(
          input,
          command,
          toolName,
          args,
          failureContextTarget,
          `VALIDATION_TOOL_REJECTED: ${toolName}`,
          "failed",
          "protocol_invalid",
        );
      }
      const phaseAndPlan = validateToolAgainstPhaseAndPlan({
        ports: input,
        command,
        toolName,
        args,
        target,
      });
      if (!phaseAndPlan.allowed) {
        recordToolResultHistory({
          ports: input,
          command,
          toolName,
          target: failureContextTarget,
          status: "blocked",
          content: `TOOL_BLOCKED: ${phaseAndPlan.reason}`,
        });
        input.logStoreEvent("runtime_v2_tool_execution_blocked", {
          turnId: command.run.turnId,
          runId: command.run.runId,
          commandKind: command.kind,
          toolName,
          target: target || null,
          reason: phaseAndPlan.reasonCode,
        });
        return toolCompletionFor(
          input,
          command,
          toolName,
          args,
          failureContextTarget,
          `TOOL_BLOCKED: ${phaseAndPlan.reason}`,
          "blocked",
          phaseAndPlan.failureKind || "not_authorized",
          undefined,
          undefined,
          phaseAndPlan.reasonCode || undefined,
        );
      }
      const authorizationResolution =
        await resolveRuntimeV2ToolAuthorization({
          ports: input,
          command,
          toolName,
          args,
          target,
          failureContextTarget,
          signal,
        });
      if (!authorizationResolution.allowed) {
        return authorizationResolution.completion;
      }
      const authorization = authorizationResolution.authorization;
      try {
        let diffPreview;
        const toolExecutionOptions = {
          toolCatalog: authorizationFor(input).toolCatalog,
          allowExternalLocalRead: authorization.allowExternalLocalRead,
          ...(authorization.shellPermissionApproval
            ? { shellPermissionApproval: authorization.shellPermissionApproval }
            : {}),
        };
        if (isWorkspaceMutationToolName(toolName)) {
          const preparation = await prepareRuntimeV2Mutation({
            ports: input,
            command,
            toolName,
            args,
            target,
            failureContextTarget,
            toolExecutionOptions,
          });
          if (!preparation.allowed) return preparation.completion;
          diffPreview = preparation.diffPreview;
        }
        const executionArgs = runtimeV2ContextBoundToolArguments(
          toolName,
          args,
          input.context.runtimeContextBudget,
          { parallelReadCount },
        );
        const priorExecutionContract =
          toolName === RECORD_RUNTIME_V2_EXECUTION_CONTRACT_TOOL_NAME
            ? deriveRuntimeV2ExecutionContract(
                aggregateForCurrentTurn(input),
              )
            : null;
        const rawOutput =
          toolName === RECORD_RUNTIME_V2_EXECUTION_CONTRACT_TOOL_NAME
            ? JSON.stringify({
                status: "execution_contract_recorded",
                revision: (priorExecutionContract?.revision || 0) + 1,
                ...parseRuntimeV2ExecutionContractArguments(executionArgs),
                effect: "no_workspace_change",
                next:
                  "Advance only a listed exact change or validation; revise explicitly if new evidence changes scope.",
              })
            : await executeRuntimeV2ToolWithDeadline({
                toolName,
                lifecycleDeadlineAt: input.lifecycleDeadlineAt,
                now: input.now,
                onTimeout: (timeoutMs, boundary) =>
                  logRuntimeV2ToolDeadline({
                    ports: input,
                    command,
                    toolName,
                    target: target || null,
                    timeoutMs,
                    boundary,
                  }),
                task: () => executeTool(
                  toolName,
                  executionArgs,
                  input.context.runWorkspace || "",
                  input.context.runSessionKey,
                  toolExecutionOptions,
                ),
              });
        const sourceVersion = RUNTIME_V2_SOURCE_READ_TOOL_NAMES.has(toolName)
          ? await resolveRuntimeV2SourceEvidenceVersion({
              toolName,
              args,
              output: rawOutput,
              readExactFile: () => executeRuntimeV2ToolWithDeadline({
                toolName: "read_file",
                lifecycleDeadlineAt: input.lifecycleDeadlineAt,
                now: input.now,
                onTimeout: (timeoutMs, boundary) =>
                  logRuntimeV2ToolDeadline({
                    ports: input,
                    command,
                    toolName: "read_file",
                    target: target || null,
                    timeoutMs,
                    boundary,
                  }),
                task: () => executeTool(
                  "read_file",
                  { ...args, __raw: true },
                  input.context.runWorkspace || "",
                  input.context.runSessionKey,
                  toolExecutionOptions,
                ),
              }),
            })
          : undefined;
        const receiptOutput = toolName === "read_file"
          ? ensureVersionedReadFileResultForModel(
              String(args.path || target || ""),
              rawOutput,
              sourceVersion || "",
            )
          : rawOutput;
        const output = boundedRuntimeV2ToolContent(
          toolName,
          toolName === "read_file"
            ? runtimeV2SourceToolContent(receiptOutput)
            : toolResultContentForModel(receiptOutput),
          input.context.runtimeContextBudget,
        );
        const completion = toolCompletionFor(
          input,
          command,
          toolName,
          args,
          target,
          receiptOutput,
          "succeeded",
          undefined,
          sourceVersion,
          diffPreview,
        );
        const semanticStatus = toolResultStatusForCompletion(completion);
        if (completion.type === "validation.completed") {
          input.live.correctiveValidationCommand = null;
        }
        if (
          semanticStatus === "succeeded" &&
          isWorkspaceMutationToolName(toolName)
        ) {
          input.live.hasExecutedMutationEffect = true;
          input.live.correctiveValidationCommand = null;
          input.live.mutationSourceCoverageByToolCallId.clear();
          input.live.latestProviderRequestSourceCoverage = [];
        }
        recordToolResultHistory({
          ports: input,
          command,
          toolName,
          target,
          status: semanticStatus,
          content: output,
        });
        input.logStoreEvent("runtime_v2_tool_execution_completed", {
          turnId: command.run.turnId,
          runId: command.run.runId,
          commandKind: command.kind,
          toolName,
          target: target || null,
          status: semanticStatus,
          mutationCommitted: isWorkspaceMutationToolName(toolName),
          validationPassed: completion.type === "validation.completed" ? completion.passed : null,
          executionContractRevision:
            toolName === RECORD_RUNTIME_V2_EXECUTION_CONTRACT_TOOL_NAME
              ? (priorExecutionContract?.revision || 0) + 1
              : null,
          evidenceVersions: completion.type === "tool.completed"
            ? completion.evidence.map((entry) => ({
                kind: entry.kind,
                target: entry.target,
                version: entry.version,
              }))
            : [],
        });
        return completion;
      } catch (error) {
        if (isRuntimeV2LifecycleDeadlineError(error)) throw error;
        const failureContent =
          `TOOL_ERROR: ${error instanceof Error ? error.message : String(error)}`;
        recordToolResultHistory({
          ports: input,
          command,
          toolName,
          target: failureContextTarget,
          status: "failed",
          content: failureContent,
        });
        input.logStoreEvent("runtime_v2_tool_execution_failed", {
          turnId: command.run.turnId,
          runId: command.run.runId,
          commandKind: command.kind,
          toolName,
          target: target || null,
          error: error instanceof Error ? error.message : String(error),
        });
        return toolCompletionFor(
          input,
          command,
          toolName,
          args,
          failureContextTarget,
          failureContent,
          "failed",
          "execution_failed",
        );
      }
    },
  };
}
