import { isRuntimeV2LifecycleDeadlineError, type RuntimeV2Command, type RuntimeV2EventDraft } from "../../lib/runtime-v2";
import { executeTool } from "../../lib/toolExecutor";
import { authorizationFor, boundedToolContent, nextEvidenceId, upsertRuntimeV2ContextAnchor, type RuntimeV2ExecutionPortsInput } from "./executionContext";
import { executeRuntimeV2ToolWithDeadline, logRuntimeV2ToolDeadline } from "./executionToolDeadline";
import { runtimeV2AutomaticObservationDeferredReceipt } from "./executionToolGateReceipt";
import { isReadOnlyContext } from "./readOnlyPolicy";

export async function collectRuntimeV2WorkspaceObservation(
  input: RuntimeV2ExecutionPortsInput,
  command: RuntimeV2Command,
  signal: AbortSignal,
): Promise<RuntimeV2EventDraft> {
  const deferred = runtimeV2AutomaticObservationDeferredReceipt(input, command);
  if (deferred) return deferred;
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
        activity: {
          run: command.run,
          commandKey: command.idempotencyKey,
          signal,
          toolName: "get_project_skeleton",
          target: input.context.runWorkspace || "",
        },
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
          {
            toolCatalog: authorizationFor(input).toolCatalog,
            skillCatalog: input.context.skillCatalog,
          },
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
      ...(isReadOnlyContext(input) ? { modelContent: overview } : {}),
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
