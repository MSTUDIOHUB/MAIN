import { inspectUnityAssemblies, runUnityEditorOperation } from "../../lib/ipc";
import { isRuntimeV2LifecycleDeadlineError, type RuntimeV2Command, type RuntimeV2EventDraft } from "../../lib/runtime-v2";
import { UNITY_COMPILE_PROJECT_TOOL, unityCompilationMessage, type UnityCompilationResult } from "../../lib/runtime-v2/unityCompilation";
import { decodeRuntimeV2UnityAssemblyReport, runtimeV2UnityRepairPayloadForCommand } from "../../lib/runtime-v2/unityRepairLoop";
import { normalizeMcpWorkspace } from "../../lib/workspaceMcp";
import { unityPredefinedScriptReferenceIssues } from "../../lib/unityAssemblyReferences";
import { aggregateForCurrentTurn } from "./executionAggregate";
import { authorizationFor, runtimeV2ToolApprovalCapability, runtimeV2ToolCapabilityRestriction } from "./executionAuthorizationContext";
import { executeRuntimeV2ToolWithDeadline } from "./executionToolDeadline";
import { executeUnityCompilation, UNITY_COMPILE_TIMEOUT_MS } from "./executionUnityCompilation";
import type { RuntimeV2ExecutionPortsInput } from "./executionTypes";

function isBoundBaseline(result: UnityCompilationResult | null, targets: readonly string[], pid: number | undefined, version: string) {
  if (!result || result.kind !== "csharp" || !["failed", "passed"].includes(result.status) ||
      result.projectRoot !== "." || result.editor !== "connected" || result.editorPid !== pid || result.editorVersion !== version) return false;
  const checked = result.targets ?? [];
  return checked.length === targets.length && targets.every(path => checked.some(target =>
    target.path === path && (target.version === null || /^sha256-[a-f0-9]{64}$/.test(target.version || ""))));
}

async function collectRepairEvidence(ports: RuntimeV2ExecutionPortsInput, command: RuntimeV2Command, signal: AbortSignal): Promise<RuntimeV2EventDraft> {
  const aggregate = aggregateForCurrentTurn(ports);
  const workspace = ports.context.runWorkspace;
  const payload = aggregate && runtimeV2UnityRepairPayloadForCommand(aggregate, command);
  if (!workspace || !aggregate || !payload || normalizeMcpWorkspace(workspace) !== normalizeMcpWorkspace(aggregate.turn.workspaceKey)) {
    throw new Error("UNITY_REPAIR_EVIDENCE_AUTHORITY_INVALID");
  }
  const baseline = "runtimeOwnedUnityBaselineCompile" in payload;
  const toolName = payload.toolName;
  const { sourcePaths, editorPid, editorVersion } = payload;
  const target = sourcePaths.join(", ") || ".";
  const allowed = (name: string, args: Record<string, unknown>) =>
    !runtimeV2ToolCapabilityRestriction(ports, name, args) && !runtimeV2ToolApprovalCapability(ports, name, args);
  const en = ports.context.phaseLanguage === "en";
  const assemblySummary = en ? "Inspected the affected Unity assemblies." : "已检查报错源码对应的 Unity 程序集。";
  const unavailable = (message: string) => ({ status: "unavailable" as const, message });
  const allowedRead = (sourcePaths.length ? sourcePaths : ["ProjectSettings/ProjectVersion.txt"])
    .every(path => allowed("read_file", { path }));
  const authorization = authorizationFor(ports);
  const canCompile = !baseline || authorization.capabilityRegistry.tools.run_command?.enabled &&
    !authorization.policy.disabledRiskLevels.includes("shell") && allowed("run_command", { command: "unity recompile" });
  const timeoutMs = baseline ? UNITY_COMPILE_TIMEOUT_MS : 8_000;
  let result: Record<string, unknown>;
  let message: string;
  try {
    if (!allowedRead || !canCompile) throw new Error(en ? "Unity diagnosis requires workspace read or compiler approval." : "Unity 诊断需要工作区读取或编译权限。");
    result = await executeRuntimeV2ToolWithDeadline({
      toolName, toolTimeoutMs: timeoutMs + 1_000, lifecycleDeadlineAt: ports.lifecycleDeadlineAt, now: ports.now,
      activity: { run: command.run, commandKey: command.idempotencyKey, signal, toolName, target },
      task: async () => {
        const deadlineAt = Math.min(Date.now() + timeoutMs, ports.lifecycleDeadlineAt ?? Infinity);
        const operationSignal = AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, deadlineAt - Date.now()))]);
        if (!baseline) {
          const report = decodeRuntimeV2UnityAssemblyReport(await inspectUnityAssemblies(workspace, sourcePaths), sourcePaths);
          operationSignal.throwIfAborted();
          return report ? { ...report } :
            unavailable(en ? "The Editor assembly report could not be verified." : "无法核验 Unity 程序集报告。");
        }
        const output = await runUnityEditorOperation(UNITY_COMPILE_PROJECT_TOOL, {
          workspace, deferClosed: true, checkKind: "csharp_baseline", targets: sourcePaths, expectedVersions: {},
          consoleBinding: { editorPid, editorVersion },
        }, operationSignal, deadlineAt) as UnityCompilationResult | null;
        if (isBoundBaseline(output, sourcePaths, editorPid, editorVersion)) return { ...output };
        return unavailable(output?.status === "unavailable" && output.message ? output.message :
          (en ? "The compiler baseline did not match the current Editor and source versions." : "编译诊断与当前 Editor 或源码版本不一致。"));
      },
    });
    message = result.status === "unavailable" ? String(result.message) : baseline
      ? unityCompilationMessage(result as unknown as UnityCompilationResult) || (en ? "Read the current Unity compiler verdict." : "已取得当前 Unity 编译结果。")
      : assemblySummary;
  } catch (error) {
    signal.throwIfAborted();
    if (isRuntimeV2LifecycleDeadlineError(error)) throw error;
    message = String(error instanceof Error ? error.message : error).slice(0, 1_200);
    result = unavailable(message);
  }
  signal.throwIfAborted();
  const succeeded = result.status !== "unavailable";
  const report = !baseline && succeeded ? decodeRuntimeV2UnityAssemblyReport(result, sourcePaths) : undefined;
  const issues = report ? unityPredefinedScriptReferenceIssues(report) : [];
  const firstIssue = issues[0];
  const observationSummary = firstIssue
    ? en ? `${firstIssue.ownerPath} references the predefined assembly ${firstIssue.reference}. Check which named assembly should own the required types.`
      : `${firstIssue.ownerPath} 引用了预定义程序集 ${firstIssue.reference}。下一步核对报错类型应归属哪个命名程序集。`
    : undefined;
  ports.logStoreEvent("runtime_v2_unity_repair_evidence_completed", {
    turnId: command.run.turnId, runId: command.run.runId, commandKey: command.idempotencyKey,
    toolName, baseline, editorPid: editorPid ?? null, status: result.status ?? "inspected", sourceCount: sourcePaths.length,
  });
  return { type: "tool.completed", run: command.run, idempotencyKey: command.idempotencyKey,
    status: succeeded ? "succeeded" : "failed", evidence: [], effectKind: "observation", modelContent: JSON.stringify(result),
    ...(succeeded ? {} : { failureKind: "execution_failed" as const, failureReasonCode: baseline ? "unity_compiler_baseline_unavailable" : "unity_assembly_diagnosis_unavailable" }),
    presentation: { toolName, target, message, ...(observationSummary ? { observationSummary } : {}) },
  };
}

export function executeRuntimeV2UnityTool(ports: RuntimeV2ExecutionPortsInput, command: RuntimeV2Command, signal: AbortSignal) {
  if (command.kind !== "execute_tool") return;
  if (command.payload.toolName === UNITY_COMPILE_PROJECT_TOOL && command.payload.runtimeOwnedUnityCompile === true) {
    return executeUnityCompilation(ports, command, signal);
  }
  if (command.payload.runtimeOwnedUnityBaselineCompile === true || command.payload.runtimeOwnedUnityAssemblyDiagnosis === true) {
    return collectRepairEvidence(ports, command, signal);
  }
}
