import { runUnityEditorOperation } from "../../lib/ipc";
import { deriveRuntimeV2PlanExecutionFrontier, type RuntimeV2Command, type RuntimeV2EventDraft } from "../../lib/runtime-v2";
import { deriveUnityCompilation, deriveUnityShaderImport, unityCompilationMessage, unityCompilationTarget, unityShaderImportTarget, UNITY_COMPILE_PROJECT_TOOL, type UnityCompilationResult } from "../../lib/runtime-v2/unityCompilation";
import { aggregateForCurrentTurn } from "./executionAggregate";
import { authorizationFor, runtimeV2ToolApprovalCapability, runtimeV2ToolCapabilityRestriction } from "./executionAuthorizationContext";
import { executeRuntimeV2ToolWithDeadline } from "./executionToolDeadline";
import { observeBoundUnityMcpDiagnostics } from "./executionUnityMcpDiagnostics";
import type { RuntimeV2ExecutionPortsInput } from "./executionTypes";

const UNITY_COMPILE_TIMEOUT_MS = 145_000;

export async function executeUnityCompilation(
  ports: RuntimeV2ExecutionPortsInput, command: RuntimeV2Command, signal: AbortSignal,
): Promise<RuntimeV2EventDraft> {
  const aggregate = aggregateForCurrentTurn(ports);
  const kind = command.payload.editorCheckKind ?? "csharp";
  const shader = kind === "shader_import";
  const boundary = shader ? deriveUnityShaderImport(aggregate) : deriveUnityCompilation(aggregate);
  const resolveTarget = shader ? unityShaderImportTarget : unityCompilationTarget;
  const workspace = ports.context.runWorkspace;
  if ((kind !== "csharp" && kind !== "shader_import") || !workspace || !boundary || boundary.receipt ||
      boundary.sequence !== command.payload.mutationSequence ||
      aggregate?.run?.identity.runId !== command.run.runId || !aggregate.scheduledCommands.some(item =>
        item.idempotencyKey === command.idempotencyKey && item.payload.runtimeOwnedUnityCompile === true)) {
    throw new Error("UNITY_COMPILE_AUTHORITY_INVALID");
  }
  const authorization = authorizationFor(ports);
  const args = { command: shader ? "unity command script eval" : "unity recompile" };
  const nativeAllowed = authorization.capabilityRegistry.tools.run_command?.enabled &&
    !authorization.policy.disabledRiskLevels.includes("shell") &&
    !runtimeV2ToolCapabilityRestriction(ports, "run_command", args) &&
    !runtimeV2ToolApprovalCapability(ports, "run_command", args);
  // A closed Editor takes a full batch boot. Coalesce reviewed script
  // changes until the last script boundary; connected Editors stay live.
  const deferClosed = deriveRuntimeV2PlanExecutionFrontier(aggregate)?.steps.some(step =>
    step.status !== "completed" && step.targets.some(path => resolveTarget(path, workspace))) === true;
  let result = await executeRuntimeV2ToolWithDeadline({
    toolName: UNITY_COMPILE_PROJECT_TOOL,
    toolTimeoutMs: UNITY_COMPILE_TIMEOUT_MS + 2_000,
    lifecycleDeadlineAt: ports.lifecycleDeadlineAt,
    now: ports.now,
    activity: { run: command.run, commandKey: command.idempotencyKey, signal, toolName: UNITY_COMPILE_PROJECT_TOOL,
      target: boundary.targets[0] },
    task: async (): Promise<UnityCompilationResult> => {
      const deadlineAt = Math.min(Date.now() + UNITY_COMPILE_TIMEOUT_MS, ports.lifecycleDeadlineAt ?? Infinity);
      if (shader && !boundary.importTargets) return { status: "unavailable", kind,
        message: "UNITY_SHADER_INCLUDE_OWNER_UNVERIFIED: read the exact dependent Shader source before verifying these changes." };
      let nativeResult: UnityCompilationResult = {
        status: "unavailable",
        message: nativeAllowed
          ? "UNITY_COMPILE_VERDICT_UNAVAILABLE: no verified result for this Editor and file set."
          : "UNITY_COMPILE_REQUIRES_PERMISSION: use a separately approved compiler command.",
      };
      if (nativeAllowed) {
        try {
          const output = await runUnityEditorOperation(UNITY_COMPILE_PROJECT_TOOL, {
            workspace, deferClosed, checkKind: kind, targets: boundary.targets, expectedVersions: boundary.expectedVersions,
            ...(shader ? { shaderImportTargets: boundary.importTargets } : {}),
          }, signal, deadlineAt) as UnityCompilationResult | null;
          if (output && (!output.kind || output.kind === kind) &&
              ["passed", "failed", "unavailable", "not_unity_project", "deferred_closed"].includes(output.status)) {
            const verifiedTargets = output.targets?.length === boundary.targets.length &&
              output.targets.every((target, index) => target.path === boundary.targets[index] &&
                (!shader && target.version === null || /^sha256-[a-f0-9]{64}$/.test(target.version || "")) &&
                (!(target.path in boundary.expectedVersions) || boundary.expectedVersions[target.path] === target.version));
            const verifiedEditor = output.editor === "connected"
              ? Number.isSafeInteger(output.editorPid) && Number(output.editorPid) > 0
              : !shader && output.editor === "closed";
            const verifiesIncludes = !shader || boundary.importTargets?.length === boundary.targets.length ||
              boundary.importTargets?.every(path => output.importedPaths?.includes(path));
            if (output.status !== "passed" || (verifiedTargets && verifiedEditor && verifiesIncludes)) nativeResult = output;
          }
        } catch (error) {
          signal.throwIfAborted();
          nativeResult = { status: "unavailable", message: String(error instanceof Error ? error.message : error).slice(0, 1_200) };
        }
      }
      if (nativeResult.status !== "unavailable") return nativeResult;
      try {
        return await observeBoundUnityMcpDiagnostics({
          ports, signal, deadlineAt, workspace, kind, targets: boundary.targets, expectedVersions: boundary.expectedVersions,
          importTargets: boundary.importTargets,
        }) ?? nativeResult;
      } catch (error) {
        signal.throwIfAborted();
        const reasonCode = error instanceof Error ? /^MCP_UNITY_[A-Z_]+\b/.exec(error.message)?.[0] : undefined;
        ports.logStoreEvent("runtime_v2_unity_mcp_check_unavailable", {
          sessionKey: command.run.sessionKey, turnId: command.run.turnId, runId: command.run.runId,
          commandKey: command.idempotencyKey, checkKind: kind, reasonCode: reasonCode ?? "mcp_check_failed",
        });
        return nativeResult;
      }
    },
  });
  signal.throwIfAborted();
  result = { ...result, kind };
  const en = ports.context.phaseLanguage === "en";
  const silent = result.status === "not_unity_project" || result.status === "deferred_closed";
  const success = result.status === "passed" || silent;
  const message = result.status === "passed"
    ? (shader ? (en ? "Shader import verified" : "已验证 Shader 导入") : (en ? "Compilation passed" : "编译通过"))
    : unityCompilationMessage(result) || (en ? "No verified Editor check result." : "未取得可验证的 Editor 检查结果。");
  ports.logStoreEvent("runtime_v2_unity_compilation_completed", {
    sessionKey: command.run.sessionKey, turnId: command.run.turnId, runId: command.run.runId,
    commandKey: command.idempotencyKey, mutationSequence: boundary.sequence,
    status: result.status, checkKind: kind, editor: result.editor ?? null, editorPid: result.editorPid ?? null, editorInstanceId: result.editorInstanceId ?? null, targets: boundary.targets,
    errorCount: result.errorCount ?? result.diagnostics?.length ?? 0,
  });
  return {
    type: "tool.completed", run: command.run, idempotencyKey: command.idempotencyKey,
    status: success ? "succeeded" : "failed", evidence: [],
    modelContent: JSON.stringify(result),
    ...(success ? {} : { failureKind: "execution_failed", failureReasonCode: shader
      ? (result.status === "failed" ? "unity_shader_import_failed" : "unity_shader_import_unavailable")
      : (result.status === "failed" ? "unity_compilation_failed" : "unity_compilation_unavailable") }),
    ...(silent ? {} : { presentation: {
      toolName: shader ? "unity_import_shader" : UNITY_COMPILE_PROJECT_TOOL, target: boundary.targets.join(", "), message,
    } }),
  };
}
