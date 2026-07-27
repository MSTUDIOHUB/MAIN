import { getToolTarget } from "../../lib/toolTarget";
import { executeTool } from "../../lib/toolExecutor";
import {
  buildToolDiffPreview,
  type ToolDiffPreview,
} from "../../lib/toolDiff";
import { isWorkspaceMutationToolName } from "../../lib/workspaceMutationTools";
import { preflightWorkspaceMutation } from "../../lib/workspaceMutationPreflight";
import type { ToolPort } from "../../lib/runtime-v2";
import { RUNTIME_V2_WORKSPACE_SOURCE_TOOL_NAMES } from "../../lib/runtime-v2/workspaceReadPolicy";
import {
  RUNTIME_V2_VALIDATION_TOOL_NAMES,
  authorizationFor,
  authorizeToolForCurrentTurn,
  boundedToolContent,
  latestAcceptanceFailureSourceWindow,
  modelContextContentForToolOutput,
  modelContextStatusForCompletion,
  nextEvidenceId,
  recordModelContext,
  recordToolModelContext,
  stringValue,
  toolCompletionFor,
  toolDefinitionExists,
  validateToolAgainstPhaseAndPlan,
  type RuntimeV2ExecutionPortsInput,
} from "./executionContext";
import { resolveRuntimeV2SourceEvidenceVersion } from "./sourceEvidenceVersion";
import { executeRuntimeV2ToolWithDeadline } from "./executionToolDeadline";

const RUNTIME_V2_MAX_MUTATION_LINES = 96;
const RUNTIME_V2_MAX_CORRECTIVE_MUTATION_LINES = 48;

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
      input.logStoreEvent("runtime_v2_tool_execution_started", {
        turnId: command.run.turnId,
        runId: command.run.runId,
        commandKind: command.kind,
        toolName,
        target: target || null,
      });
      if (!toolDefinitionExists(input, toolName)) {
        recordToolModelContext({
          ports: input,
          command,
          toolName,
          target,
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
          target,
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
          target,
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
          target,
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
          target,
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
          target,
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
          target,
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
          target,
          null,
          "blocked",
          "not_authorized",
        );
      }
      try {
        let diffPreview: ToolDiffPreview | undefined;
        const toolExecutionOptions = {
          toolCatalog: authorizationFor(input).toolCatalog,
          allowExternalLocalRead: authorization.allowExternalLocalRead,
          ...(authorization.shellPermissionApproval
            ? { shellPermissionApproval: authorization.shellPermissionApproval }
            : {}),
        };
        if (isWorkspaceMutationToolName(toolName)) {
          const correctiveSource = latestAcceptanceFailureSourceWindow(
            input.live,
            input.context.runWorkspace || "",
          );
          const preflight = await preflightWorkspaceMutation({
            toolName,
            args,
            language: input.context.phaseLanguage,
            workspaceRoot: input.context.runWorkspace || "",
            maxTouchedLines: correctiveSource
              ? RUNTIME_V2_MAX_CORRECTIVE_MUTATION_LINES
              : RUNTIME_V2_MAX_MUTATION_LINES,
            readFile: async (path) => String(
              await executeRuntimeV2ToolWithDeadline({
                toolName: "read_file",
                lifecycleDeadlineAt: input.lifecycleDeadlineAt,
                now: input.now,
                task: () => executeTool(
                  "read_file",
                  { path, __raw: true },
                  input.context.runWorkspace || "",
                  input.context.runSessionKey,
                  toolExecutionOptions,
                ),
              }),
            ),
          });
          if (!preflight.ok) {
            const mismatchRange =
              preflight.patchRecoveryMismatch?.requestedRange;
            const mismatchPath =
              preflight.patchRecoveryMismatch?.target ||
              preflight.path ||
              target;
            const sourceMismatch =
              preflight.recoveryKind === "source_mismatch";
            const targetInvalid =
              preflight.recoveryKind === "target_invalid";
            const mutationRejected =
              preflight.recoveryKind === "mutation_rejected";
            const refreshLine = mismatchRange?.startLine
              ? Math.floor(
                  (
                    mismatchRange.startLine +
                    (mismatchRange.endLine || mismatchRange.startLine)
                  ) / 2,
                )
              : mutationRejected &&
                  correctiveSource &&
                  correctiveSource.path === mismatchPath
                ? correctiveSource.failureLine
                : null;
            const sourceRefreshHint =
              (sourceMismatch || mutationRejected) &&
              mismatchPath &&
              refreshLine
              ? `${mismatchPath}:${refreshLine}:1 - refresh this exact source window before retrying a smaller valid mutation`
              : "";
            const content = [
              preflight.message ||
                `MUTATION_PREFLIGHT_BLOCKED: ${preflight.reason || "invalid mutation"}`,
              sourceRefreshHint,
            ].filter(Boolean).join("\n");
            recordToolModelContext({
              ports: input,
              command,
              toolName,
              target: preflight.path || target,
              status: "failed",
              content,
            });
            input.logStoreEvent("runtime_v2_mutation_preflight_rejected", {
              turnId: command.run.turnId,
              runId: command.run.runId,
              commandKind: command.kind,
              toolName,
              target: preflight.path || target || null,
              reason: preflight.reason || "invalid_mutation",
              recoveryKind: preflight.recoveryKind || null,
              mismatchTarget:
                preflight.patchRecoveryMismatch?.target || null,
              mismatchStartLine: mismatchRange?.startLine || null,
              mismatchEndLine: mismatchRange?.endLine || null,
              message: preflight.message?.slice(0, 1_000) || null,
            });
            return toolCompletionFor(
              input,
              command,
              toolName,
              args,
              preflight.path || target,
              null,
              "failed",
              sourceMismatch
                ? "source_mismatch"
                : targetInvalid
                  ? "target_invalid"
                  : mutationRejected
                    ? "mutation_rejected"
                    : "protocol_invalid",
            );
          }
          try {
            diffPreview = await buildToolDiffPreview(toolName, args, {
              workspace: input.context.runWorkspace || "",
              sessionKey: input.context.runSessionKey,
            });
          } catch (error) {
            input.logStoreEvent("runtime_v2_tool_diff_preview_failed", {
              turnId: command.run.turnId,
              runId: command.run.runId,
              commandKind: command.kind,
              toolName,
              target: target || null,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
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
            args,
            input.context.runWorkspace || "",
            input.context.runSessionKey,
            toolExecutionOptions,
          ),
        });
        const output = boundedToolContent(
          modelContextContentForToolOutput(rawOutput),
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
          target,
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
          target,
          null,
          "failed",
          "execution_failed",
        );
      }
    },
  };
}
