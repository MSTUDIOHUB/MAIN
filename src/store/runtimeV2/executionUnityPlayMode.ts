import { runUnityEditorOperation, type ShellPermissionApproval } from "../../lib/ipc";
import { runtimeV2EditorDiagnosticScope, type RuntimeV2PipelineConsoleSample } from "../../lib/runtime-v2/editorConsoleEvidence";
import { runtimeV2UnityPlayModeBindingForCommand } from "../../lib/runtime-v2/unityPlayMode";
import type { RuntimeV2Command } from "../../lib/runtime-v2";
import { normalizeMcpWorkspace } from "../../lib/workspaceMcp";
import { aggregateForCurrentTurn } from "./executionAggregate";
import { runtimeV2StructuredToolOutcome } from "./executionToolOutcome";
import { toolCompletionFor } from "./executionEvidence";
import type { RuntimeV2ExecutionPortsInput } from "./executionTypes";
import { confirmRuntimeV2BoundUnityConsole } from "./executionUnityCompilation";

export function boundRuntimeV2UnityPlayMode(ports: RuntimeV2ExecutionPortsInput, command: RuntimeV2Command) {
  if (!command.payload.unityPlayModeBinding) return;
  const aggregate = aggregateForCurrentTurn(ports);
  const workspace = ports.context.runWorkspace;
  if (!aggregate || !workspace || normalizeMcpWorkspace(workspace) !== normalizeMcpWorkspace(aggregate.turn.workspaceKey)) return;
  return runtimeV2UnityPlayModeBindingForCommand(aggregate, command);
}

export function rejectedUnityPlayModeBinding(ports: RuntimeV2ExecutionPortsInput, command: RuntimeV2Command,
    args: Record<string, unknown>, target: string, binding: ReturnType<typeof boundRuntimeV2UnityPlayMode>) {
  if (command.payload.unityPlayModeBinding && !binding) {
    return toolCompletionFor(ports, command, "run_command", args, target, "The admitted Unity PlayMode scope changed before execution.",
      "blocked", "not_executed", undefined, undefined, "unity_playmode_scope_changed");
  }
}

export async function executeManagedUnityPlayMode(
  ports: RuntimeV2ExecutionPortsInput, command: RuntimeV2Command, args: Record<string, unknown>,
  permissionApproval: ShellPermissionApproval | undefined, signal: AbortSignal, binding: ReturnType<typeof boundRuntimeV2UnityPlayMode>,
) {
  const workspace = ports.context.runWorkspace || "";
  const deadlineAt = Math.min(Date.now() + 300_000, ports.lifecycleDeadlineAt ?? Infinity);
  const result = await runUnityEditorOperation("unity_test_project", {
    workspace, approvedCommand: String(args.command || ""), permissionApproval,
    ...(binding ? { consoleBinding: binding.consoleBinding, expectedVersions: binding.expectedVersions } : {}),
  }, signal, deadlineAt);
  if (!binding || runtimeV2StructuredToolOutcome("run_command", result, args, command.payload.validationAuthority).status !== "succeeded") return { result };
  const aggregate = aggregateForCurrentTurn(ports);
  const scope = aggregate && runtimeV2EditorDiagnosticScope(aggregate);
  if (!scope || scope.editorPid !== binding.consoleBinding.editorPid || scope.editorVersion !== binding.consoleBinding.editorVersion) return { result };
  const console = await confirmRuntimeV2BoundUnityConsole(ports, workspace, scope, Date.now(), deadlineAt, signal, true);
  return { result, console };
}

export function unityPlayModeConsoleFailure(sample: RuntimeV2PipelineConsoleSample | undefined) {
  if (!sample) return { reason: "unity_playmode_console_unavailable", kind: "not_executed" as const,
    message: "The PlayMode tests passed. A fresh Console sample from the bound Editor was unavailable after execution." };
  if (sample.errors || sample.compilationFailed) return { reason: "unity_playmode_console_errors", kind: "execution_failed" as const,
    message: `The PlayMode tests passed, but the bound Editor reported ${sample.errors} live Console errors after execution. Read the current Console and repair the remaining errors.` };
}

export function unityPlayModePrerequisiteUnavailable(error: string): boolean {
  return /^(?:UNITY_(?:EDITOR_INSTANCE_CHANGED|PLAYMODE_BUSY|PROJECT_REQUIRED|CHECK_TARGET_CHANGED|CLI_UNAVAILABLE|EDITOR_NOT_READY|OPERATION_TIMEOUT)|RUNTIME_V2_TOOL_TIMEOUT)\b/.test(error);
}
