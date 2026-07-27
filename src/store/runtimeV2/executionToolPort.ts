import { getToolTarget } from "../../lib/toolTarget";
import { executeTool } from "../../lib/toolExecutor";
import { isWorkspaceMutationToolName } from "../../lib/workspaceMutationTools";
import type { ToolPort } from "../../lib/runtime-v2";
import {
  RUNTIME_V2_VALIDATION_TOOL_NAMES,
  authorizationFor,
  authorizeToolForCurrentTurn,
  boundedToolContent,
  deriveSubagentCandidates,
  nextEvidenceId,
  recordModelContext,
  recordToolModelContext,
  stringValue,
  toolCompletionFor,
  toolDefinitionExists,
  validateToolAgainstPhaseAndPlan,
  type RuntimeV2ExecutionPortsInput,
} from "./executionContext";

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
          const overview = boundedToolContent(await executeTool(
            "get_project_skeleton",
            {},
            input.context.runWorkspace || "",
            input.context.runSessionKey,
            { toolCatalog: authorizationFor(input).toolCatalog },
          ), 12_000);
          input.live.workspaceOverview = overview;
          input.live.subagentCandidates = deriveSubagentCandidates(
            overview,
            String(command.payload.objective || ""),
          );
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
            discoveredSubagentScopes: input.live.subagentCandidates.map((candidate) => candidate.scopeKey),
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
        const rawOutput = await executeTool(
          toolName,
          args,
          input.context.runWorkspace || "",
          input.context.runSessionKey,
          {
            toolCatalog: authorizationFor(input).toolCatalog,
            allowExternalLocalRead: authorization.allowExternalLocalRead,
            ...(authorization.shellPermissionApproval
              ? { shellPermissionApproval: authorization.shellPermissionApproval }
              : {}),
          },
        );
        const output = boundedToolContent(rawOutput);
        recordToolModelContext({
          ports: input,
          command,
          toolName,
          target,
          status: "succeeded",
          content: output,
        });
        const completion = toolCompletionFor(
          input,
          command,
          toolName,
          args,
          target,
          rawOutput,
          "succeeded",
        );
        input.logStoreEvent("runtime_v2_tool_execution_completed", {
          turnId: command.run.turnId,
          runId: command.run.runId,
          commandKind: command.kind,
          toolName,
          target: target || null,
          status: completion.type === "validation.completed" && !completion.passed ? "failed" : "succeeded",
          mutationCommitted: isWorkspaceMutationToolName(toolName),
          validationPassed: completion.type === "validation.completed" ? completion.passed : null,
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
