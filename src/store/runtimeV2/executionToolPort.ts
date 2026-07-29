import { getToolTarget } from "../../lib/toolTarget";
import { extractReadFileWindowMetadata } from "../../lib/readFileWindow";
import { executeTool } from "../../lib/toolExecutor";
import { isWorkspaceMutationToolName } from "../../lib/workspaceMutationTools";
import type { ToolPort } from "../../lib/runtime-v2";
import { RUNTIME_V2_WORKSPACE_SOURCE_TOOL_NAMES } from "../../lib/runtime-v2/workspaceReadPolicy";
import {
  RUNTIME_V2_VALIDATION_TOOL_NAMES,
  authorizationFor,
  authorizeToolForCurrentTurn,
  boundedRuntimeV2ToolContent,
  boundedToolContent,
  modelContextContentForToolOutput,
  modelContextStatusForCompletion,
  nextEvidenceId,
  recordModelContext,
  recordToolModelContext,
  runtimeV2ContextBoundToolArguments,
  stringValue,
  toolCompletionFor,
  toolDefinitionExists,
  validateToolAgainstPhaseAndPlan,
  type RuntimeV2ExecutionPortsInput,
} from "./executionContext";
import { resolveRuntimeV2SourceEvidenceVersion } from "./sourceEvidenceVersion";
import { executeRuntimeV2ToolWithDeadline } from "./executionToolDeadline";
import { prepareRuntimeV2Mutation } from "./executionMutationPreflight";
import {
  runtimeV2ProviderToolCallConstraint,
  runtimeV2ProviderToolCallIdentity,
} from "./providerToolSurface";
import {
  runtimeV2MutationFailureContextTarget,
} from "./correctiveMutationPolicy";

export function createRuntimeV2ToolPort(
  input: RuntimeV2ExecutionPortsInput,
): ToolPort {
  return {
    async execute({ command }) {
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
          input.live.workspaceOverview = overview;
          const evidenceId = nextEvidenceId(input.live);
          recordModelContext(input.live, {
            id: evidenceId,
            source: "workspace",
            label: "workspace_overview",
            target: input.context.runWorkspace || "workspace",
            status: "succeeded",
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
      // Keep authorization bound to the provider's actual arguments. For
      // recovery correlation only, attribute a target-less failed editor to
      // the active mutation lease. Otherwise an empty native tool payload is
      // recorded against the literal tool name and the same broken editor
      // remains eligible forever on the leased source version.
      const failureContextTarget =
        runtimeV2MutationFailureContextTarget({
          ports: input,
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
      const toolCallId = String(command.payload.toolCallId || "");
      const hasCoveredSourceReceipt =
        !!toolCallId &&
        input.live.coveredReadToolResults.has(toolCallId);
      const cachedSourceReceipt = hasCoveredSourceReceipt
        ? input.live.coveredReadToolResults.get(toolCallId) || null
        : null;
      if (hasCoveredSourceReceipt) {
        input.live.coveredReadToolResults.delete(toolCallId);
      }
      if (
        cachedSourceReceipt &&
        command.payload.repeatedActionRejected !== true
      ) {
        recordToolModelContext({
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
        });
        return toolCompletionFor(
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
      }
      const coveredSourceRepeat =
        hasCoveredSourceReceipt;
      if (
        coveredSourceRepeat ||
        command.payload.repeatedActionRejected === true
      ) {
        const rejectedAction = {
          name: toolName,
          arguments: args,
        };
        const rejectedActionIdentity =
          runtimeV2ProviderToolCallIdentity(rejectedAction);
        input.live.rejectedProviderActions.set(
          rejectedActionIdentity,
          runtimeV2ProviderToolCallConstraint(rejectedAction),
        );
        while (input.live.rejectedProviderActions.size > 12) {
          const oldest = input.live.rejectedProviderActions.keys()
            .next().value;
          if (!oldest) break;
          input.live.rejectedProviderActions.delete(oldest);
        }
        const unchangedSourceRepeat =
          coveredSourceRepeat ||
          command.payload.repeatedActionReason ===
            "unchanged_source_repeat";
        const unchangedObservationRepeat =
          command.payload.repeatedActionReason ===
            "unchanged_observation_repeat";
        recordToolModelContext({
          ports: input,
          command,
          toolName,
          target: failureContextTarget,
          status: "failed",
          content: unchangedSourceRepeat
            ? [
                coveredSourceRepeat
                  ? "UNCHANGED_SOURCE_COVERAGE_REUSED: this requested path and range is already fully covered by same-version read results since the latest mutation."
                  : "UNCHANGED_SOURCE_REPEAT_REJECTED: this exact path and range already returned the same committed source version twice since the latest mutation.",
                "The complete earlier result remains in the tool transcript. Reuse it and choose a mutation, validation, or a genuinely different uncovered target or range. The Turn remains active and safe reads reopen after every mutation.",
              ].join(" ")
            : unchangedObservationRepeat
              ? [
                  "UNCHANGED_OBSERVATION_REPEAT_REJECTED: this exact read-only query already completed twice since the latest mutation.",
                  "Its prior results remain in the tool transcript. Choose a mutation, validation, or a structurally different missing observation. The Turn remains active.",
                ].join(" ")
            : [
                "REPEATED_ACTION_REJECTED: this exact failed action reached its retry protection line.",
                "Choose a different read, mutation, or validator from the currently available tool surface. The Turn remains active.",
              ].join(" "),
        });
        input.logStoreEvent("runtime_v2_repeated_action_rejected", {
          turnId: command.run.turnId,
          runId: command.run.runId,
          commandKind: command.kind,
          toolName,
          target: target || null,
          reason: unchangedSourceRepeat
            ? coveredSourceRepeat
              ? "covered_source_range_repeat"
              : "unchanged_source_repeat"
            : unchangedObservationRepeat
              ? "unchanged_observation_repeat"
            : "failed_action_retry_limit",
          actionIdentity: rejectedActionIdentity,
        });
        return toolCompletionFor(
          input,
          command,
          toolName,
          args,
          failureContextTarget,
          null,
          "failed",
          "protocol_invalid",
        );
      }
      if (!toolDefinitionExists(input, toolName)) {
        recordToolModelContext({
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
          null,
          "failed",
          "protocol_invalid",
        );
      }
      if (command.kind === "execute_validation" && !RUNTIME_V2_VALIDATION_TOOL_NAMES.has(toolName)) {
        recordToolModelContext({
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
          null,
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
        recordToolModelContext({
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
          null,
          "blocked",
          phaseAndPlan.failureKind || "not_authorized",
        );
      }
      const authorization = await authorizeToolForCurrentTurn(input, toolName, args);
      if (!authorization.allowed) {
        recordToolModelContext({
          ports: input,
          command,
          toolName,
          target: failureContextTarget,
          status: "blocked",
          content: `TOOL_BLOCKED: ${authorization.reason || `${toolName} is not authorized for this Turn.`}`,
        });
        input.logStoreEvent("runtime_v2_tool_execution_blocked", {
          turnId: command.run.turnId,
          runId: command.run.runId,
          commandKind: command.kind,
          toolName,
          target: target || null,
          reason: authorization.reason || "authorization_required",
        });
        return toolCompletionFor(
          input,
          command,
          toolName,
          args,
          failureContextTarget,
          null,
          "blocked",
          "not_authorized",
        );
      }
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
        );
        const rawOutput = await executeRuntimeV2ToolWithDeadline({
          toolName,
          lifecycleDeadlineAt: input.lifecycleDeadlineAt,
          now: input.now,
          onTimeout: (timeoutMs) => {
            input.logStoreEvent("runtime_v2_tool_deadline_exceeded", {
              turnId: command.run.turnId,
              runId: command.run.runId,
              commandKind: command.kind,
              toolName,
              target: target || null,
              timeoutMs,
            });
          },
          task: () => executeTool(
            toolName,
            executionArgs,
            input.context.runWorkspace || "",
            input.context.runSessionKey,
            toolExecutionOptions,
          ),
        });
        const output = boundedRuntimeV2ToolContent(
          toolName,
          modelContextContentForToolOutput(rawOutput),
          input.context.runtimeContextBudget,
        );
        const sourceVersion = RUNTIME_V2_WORKSPACE_SOURCE_TOOL_NAMES.has(toolName)
          ? await resolveRuntimeV2SourceEvidenceVersion({
              toolName,
              args,
              output: rawOutput,
              readExactFile: () => executeRuntimeV2ToolWithDeadline({
                toolName: "read_file",
                lifecycleDeadlineAt: input.lifecycleDeadlineAt,
                now: input.now,
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
        const completion = toolCompletionFor(
          input,
          command,
          toolName,
          args,
          target,
          rawOutput,
          "succeeded",
          undefined,
          sourceVersion,
          diffPreview,
        );
        const semanticStatus = modelContextStatusForCompletion(completion);
        if (
          semanticStatus === "succeeded" &&
          isWorkspaceMutationToolName(toolName)
        ) {
          input.live.rejectedProviderActions.clear();
        }
        recordToolModelContext({
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
        recordToolModelContext({
          ports: input,
          command,
          toolName,
          target: failureContextTarget,
          status: "failed",
          content: `TOOL_ERROR: ${error instanceof Error ? error.message : String(error)}`,
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
          null,
          "failed",
          "execution_failed",
        );
      }
    },
  };
}
