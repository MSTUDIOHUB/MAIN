import { normalizeValidationWorkspaceCwd, unityValidationInvocations } from "../validationContract";
import type { TurnAggregateV1 } from "./aggregate";
import { approvedRuntimeV2PlanContinuation } from "./planContinuationBaseline";
import { runtimeV2EditorDiagnosticScope, isRuntimeV2EditorDiagnosticRepair } from "./editorConsoleEvidence";
import { runtimeV2DirectExecuteMutationTargets, runtimeV2WorkspaceChangeReceipts } from "./validationReceipt";
import { extractExactReadFileWindow } from "../readFileWindow";

export const UNITY_COMPILE_PROJECT_TOOL = "unity_compile_project";
export type UnityEditorCheckKind = "csharp" | "shader_import";

export interface UnityCompilationResult {
  readonly status: "passed" | "failed" | "unavailable" | "deferred_closed" | "not_unity_project";
  readonly editor?: "connected" | "closed";
  readonly editorPid?: number | null;
  readonly editorInstanceId?: string;
  readonly editorVersion?: string;
  readonly kind?: UnityEditorCheckKind;
  readonly targets?: readonly { readonly path: string; readonly version: string | null }[];
  readonly importedPaths?: readonly string[];
  readonly message?: string;
  readonly errorCount?: number;
  readonly diagnostics?: readonly {
    readonly file: string | null;
    readonly line: number;
    readonly column: number;
    readonly code: string;
    readonly message: string;
  }[];
}

export interface ApprovedPlanExecutionRepair {
  readonly kind: "compiler_scope" | "playmode_route";
  readonly target: string;
  readonly diagnostic?: string;
}

export function approvedPlanExecutionRepair(aggregate: TurnAggregateV1 | null): ApprovedPlanExecutionRepair | undefined {
  if (!aggregate?.run || aggregate.workPlan?.status !== "approved") return;
  for (let index = aggregate.events.length - 1; index >= 0; index -= 1) {
    const event = aggregate.events[index]!;
    if (event.type === "work_plan.approved") return;
    if ((event.type === "tool.completed" || event.type === "validation.completed") &&
        event.run.runId === aggregate.run.identity.runId && event.approvedPlanRepair) return event.approvedPlanRepair;
  }
}

export function unityCompilationTarget(path: string, workspace: string): string | null {
  const relative = normalizeValidationWorkspaceCwd(path, workspace);
  return relative && /^(?:Assets|Packages)\/.*\.(?:cs|asmdef|asmref)$/i.test(relative) ? relative : null;
}

export function unityShaderImportTarget(path: string, workspace: string): string | null {
  const relative = normalizeValidationWorkspaceCwd(path, workspace);
  return relative && /^(?:Assets|Packages)\/.*\.(?:shader|hlsl|cginc|compute)$/i.test(relative) ? relative : null;
}

function referencedShaderInclude(owner: string, include: string): string | null {
  if (/^(?:\/|[a-z]:)|[\\\u0000-\u001f]/i.test(include)) return null;
  const segments = /^(?:Assets|Packages)\//.test(include) ? [] : owner.split("/").slice(0, -1);
  for (const part of include.split("/")) {
    if (part === "..") {
      if (segments.length < 2) return null;
      segments.pop();
    } else if (part && part !== ".") segments.push(part);
  }
  return segments.join("/");
}

/** Import exact Shader owners while version-fencing any changed includes.
 * A literal dependency must come from the same source version we verify. */
function shaderImportsCoveringTargets(state: TurnAggregateV1, targets: readonly string[], versions: ReadonlyMap<string, string | null>) {
  const shaders = targets.filter(path => /\.(?:shader|compute)$/i.test(path) && versions.get(path) !== null);
  if (!shaders.length) return;
  if (shaders.length === targets.length) return shaders;
  const includes = new Set<string>();
  for (const event of state.events) {
    if (event.type !== "tool.completed" || event.status !== "succeeded" || !event.modelContent) continue;
    const source = extractExactReadFileWindow(event.modelContent);
    const path = source && normalizeValidationWorkspaceCwd(source.metadata.path, state.turn.workspaceKey);
    const hash = source?.metadata.contentVersion?.replace(/^sha256-/, "");
    if (!source || !path || !hash || !shaders.includes(path) || versions.get(path) !== `sha256-${hash}` ||
        !event.evidence.some(item => item.kind === "source" && item.version?.replace(/^sha256-/, "") === hash &&
          normalizeValidationWorkspaceCwd(item.target, state.turn.workspaceKey) === path)) continue;
    const content = source.content.replace(/\/\*[\s\S]*?\*\//g, "");
    for (const match of content.matchAll(/^\s*#\s*include(?:_with_pragmas)?\s+["<]([^">\r\n]+)[">]/gm)) {
      const include = referencedShaderInclude(path, match[1]!);
      if (include) includes.add(include);
    }
  }
  return targets.every(path => shaders.includes(path) || versions.get(path) && includes.has(path)) ? shaders : undefined;
}

function computeUnityEditorCheck(aggregate: TurnAggregateV1, kind: UnityEditorCheckKind) {
  const run = aggregate?.run;
  if (!run || (aggregate.strategy !== "execute" &&
      !(aggregate.strategy === "plan" && aggregate.workPlan?.status === "approved"))) return null;
  const workspace = aggregate.turn.workspaceKey;
  const consoleRepair = isRuntimeV2EditorDiagnosticRepair(aggregate);
  const changes = new Set(runtimeV2WorkspaceChangeReceipts(aggregate));
  const continuation = approvedRuntimeV2PlanContinuation(aggregate.events);
  let sequence = -1;
  let targets: string[] = [];
  const versions = new Map<string, string | null>();
  const compileCommands = new Map<string, { sequence: number; hasImportTargets: boolean }>();
  let receipt: { boundary: number; sequence: number; result: UnityCompilationResult; hasImportTargets: boolean } | undefined;
  let recheckRequestId: string | undefined;
  for (const event of aggregate.events) {
    if (!("run" in event) || event.run.runId !== run.identity.runId) continue;
    const changed = (event.type === "tool.completed" || event.type === "subagent.completed") && changes.has(event)
      ? event.evidence.filter(item => item.kind === "mutation")
      : event.type === "work_plan.approved" && event.sequence === continuation?.sequence
        ? continuation.continuation.carriedTargets.map(item => ({ target: item.target, version: item.version ?? "deleted" })) : [];
    const resolveTarget = kind === "csharp" ? unityCompilationTarget : unityShaderImportTarget;
    const affected = changed.flatMap(item => {
      const target = resolveTarget(item.target, workspace);
      if (!target) return [];
      const version = item.version || "";
      if (version === "deleted" || version.startsWith("deleted:")) versions.set(target, null);
      else if (/^(?:sha256-)?[a-f0-9]{64}$/.test(version)) {
        versions.set(target, version.startsWith("sha256-") ? version : `sha256-${version}`);
      } else versions.delete(target);
      return [target];
    });
    if (affected.length) {
      const pendingPaths = consoleRepair || kind === "shader_import" && receipt?.result.status !== "passed" ? targets : [];
      sequence = event.sequence;
      targets = [...new Set([...pendingPaths, ...affected])];
    }
    if (event.type === "run.paused" && event.blocker.reasonCode === "unity_editor_verification_pending" &&
        event.blocker.evidenceSequence === receipt?.sequence) recheckRequestId = event.blocker.requestId;
    if (event.type === "run.decision_recorded" && event.requestId === recheckRequestId && event.choice !== "recheck") {
      recheckRequestId = undefined;
    }
    if (event.type === "run.resumed" && event.requestId === recheckRequestId) {
      if (receipt?.boundary === sequence) receipt = undefined;
      recheckRequestId = undefined;
    }
    if (event.type === "command.scheduled" && event.command.kind === "execute_tool" &&
        event.command.payload.toolName === UNITY_COMPILE_PROJECT_TOOL && event.command.payload.runtimeOwnedUnityCompile === true &&
        (event.command.payload.editorCheckKind ?? "csharp") === kind) {
      compileCommands.set(event.command.idempotencyKey, { sequence: Number(event.command.payload.mutationSequence),
        hasImportTargets: Array.isArray(event.command.payload.shaderImportTargets) });
    }
    if (event.type !== "tool.completed" && event.type !== "command.completed") continue;
    const boundary = compileCommands.get(event.idempotencyKey);
    if (boundary?.sequence !== sequence) continue;
    let result: UnityCompilationResult = { status: "unavailable", kind, message: "The Unity Editor check did not return a verified verdict." };
    if (event.type === "tool.completed" && event.modelContent) {
      try {
        const parsed = JSON.parse(event.modelContent) as UnityCompilationResult | null;
        if (parsed?.status) result = parsed;
      } catch { /* Invalid receipt remains unavailable. */ }
    }
    receipt = { boundary: boundary.sequence, sequence: event.sequence, result, hasImportTargets: boundary.hasImportTargets };
  }
  if (sequence < 0) return null;
  const diagnosticTargets = runtimeV2EditorDiagnosticScope(aggregate)?.diagnostics.flatMap(item => item.kind === kind && item.path ? [item.path] : []) || [];
  targets = [...new Set([...targets, ...diagnosticTargets])];
  if (consoleRepair && kind === "shader_import") {
    for (const evidence of [...aggregate.evidence].reverse()) {
      const path = evidence.kind === "source" && unityShaderImportTarget(evidence.target, workspace);
      if (path && diagnosticTargets.includes(path) && !versions.has(path) && /^(?:sha256-)?[a-f0-9]{64}$/.test(evidence.version || "")) {
        const version = evidence.version!;
        versions.set(path, version.startsWith("sha256-") ? version : `sha256-${version}`);
      }
    }
  }
  const expectedVersions = Object.fromEntries([...versions].filter(([target]) => targets.includes(target)));
  const importTargets = kind === "shader_import" ? shaderImportsCoveringTargets(aggregate, targets, versions) : undefined;
  if (importTargets && receipt?.result.status === "unavailable" && !receipt.hasImportTargets &&
      receipt.result.message?.startsWith("UNITY_SHADER_INCLUDE_OWNER_UNVERIFIED:")) receipt = undefined;
  if (consoleRepair && receipt?.result.status === "passed" && targets.some(path =>
    !receipt?.result.targets?.some(item => item.path === path))) receipt = undefined;
  return { kind, sequence, targets, expectedVersions, importTargets, receipt: receipt?.boundary === sequence ? receipt : undefined };
}

const checksByAggregate = new WeakMap<TurnAggregateV1, readonly [
  ReturnType<typeof computeUnityEditorCheck>, ReturnType<typeof computeUnityEditorCheck>,
]>();
function deriveUnityEditorChecks(aggregate: TurnAggregateV1 | null) {
  if (!aggregate) return [null, null] as const;
  const cached = checksByAggregate.get(aggregate);
  if (cached) return cached;
  const checks = [computeUnityEditorCheck(aggregate, "csharp"), computeUnityEditorCheck(aggregate, "shader_import")] as const;
  checksByAggregate.set(aggregate, checks);
  return checks;
}

export function deriveUnityCompilation(aggregate: TurnAggregateV1 | null) {
  return deriveUnityEditorChecks(aggregate)[0];
}

export function deriveUnityShaderImport(aggregate: TurnAggregateV1 | null) {
  return deriveUnityEditorChecks(aggregate)[1];
}

export function nextUnityEditorCheck(aggregate: TurnAggregateV1 | null) {
  return deriveUnityEditorChecks(aggregate).find(check => check && !check.receipt) ?? null;
}

/** The original Console diagnostics and the final file revisions must both
 * be covered by successful Editor-owned checks for each diagnostic kind. */
export function verifiedUnityConsoleRepair(state: TurnAggregateV1) {
  const scope = runtimeV2EditorDiagnosticScope(state);
  const mutationTargets = runtimeV2DirectExecuteMutationTargets(state);
  if (!scope?.complete || !scope.diagnostics.length || !mutationTargets.length ||
      scope.diagnostics.some(item => item.kind !== "runtime" && !item.path)) return null;
  const workspace = state.turn.workspaceKey;
  const checks = deriveUnityEditorChecks(state).filter(check => check !== null);
  const requiresBehavioralValidation = scope.diagnostics.some(item => item.kind === "runtime") ||
    mutationTargets.some(path => !unityCompilationTarget(path, workspace) && !unityShaderImportTarget(path, workspace));
  if (scope.diagnostics.some(item => item.kind !== "runtime" && !checks.some(check => check.kind === item.kind))) return null;
  const results = checks.flatMap(check => {
    const receipt = check.receipt;
    if (!receipt || receipt.result.status !== "passed" || (receipt.result.errorCount ?? 0) > 0 || receipt.result.editorVersion !== scope.editorVersion ||
        (receipt.result.editor !== "connected" && (check.kind !== "csharp" || receipt.result.editor !== "closed")) ||
        (receipt.result.editorInstanceId && receipt.result.editorInstanceId !== scope.instanceId) ||
        (receipt.result.editor === "connected" && !receipt.result.editorInstanceId && !(Number(receipt.result.editorPid) > 0))) return [];
    const writesCovered = mutationTargets.flatMap(target => {
      const path = (check.kind === "csharp" ? unityCompilationTarget : unityShaderImportTarget)(target, workspace);
      return path ? [path] : [];
    }).every(path => Object.prototype.hasOwnProperty.call(check.expectedVersions, path) &&
      receipt.result.targets?.some(target => target.path === path && target.version === check.expectedVersions[path]));
    const targetsCovered = check.targets.every(path => receipt.result.targets?.some(target => target.path === path &&
      (target.version === null && check.kind === "csharp" && check.expectedVersions[path] === null || /^sha256-[a-f0-9]{64}$/.test(target.version || ""))));
    const importsCovered = check.kind !== "shader_import" || check.importTargets?.every(path =>
      (receipt.result.importedPaths ?? receipt.result.targets?.filter(target => /\.(?:shader|compute)$/i.test(target.path)).map(target => target.path))?.includes(path));
    return writesCovered && targetsCovered && importsCovered ? [receipt] : [];
  });
  const nativeInstances = new Set(results.flatMap(item => item.result.editorPid ? [item.result.editorPid] : []));
  if ((!checks.length && !requiresBehavioralValidation) || results.length !== checks.length || nativeInstances.size > 1) return null;
  return { receipts: results, requiresBehavioralValidation };
}

export function unityCompilationMessage(result: UnityCompilationResult): string {
  const diagnostics = result.diagnostics?.map(diagnostic =>
    `${diagnostic.file ? `${diagnostic.file}:${diagnostic.line}:${diagnostic.column} ` : ""}${diagnostic.code} ${diagnostic.message}`.trim()) ?? [];
  return [result.message, ...diagnostics].filter(Boolean).join("\n");
}

/** A verified compiler/test command can settle an unavailable compiler
 * operation after the same edit boundary. Generic shell success cannot. */
export function unresolvedUnityCompilation(aggregate: TurnAggregateV1 | null) {
  const compilation = deriveUnityCompilation(aggregate);
  const receipt = compilation?.receipt;
  if (!aggregate || !compilation || !receipt ||
      (receipt.result.status !== "failed" && receipt.result.status !== "unavailable")) return null;
  const verified = aggregate.events.some(event => event.type === "validation.completed" && event.passed &&
    event.sequence > receipt.sequence && event.run.runId === aggregate.run?.identity.runId &&
    unityValidationInvocations(event.presentation?.target || "").length > 0);
  return verified ? null : receipt;
}

export function unresolvedUnityShaderImport(aggregate: TurnAggregateV1 | null) {
  const receipt = deriveUnityShaderImport(aggregate)?.receipt;
  return receipt && ["failed", "unavailable", "deferred_closed"].includes(receipt.result.status) ? receipt : null;
}

export function unresolvedUnityEditorCheck(aggregate: TurnAggregateV1 | null) {
  const pending = [unresolvedUnityCompilation(aggregate), unresolvedUnityShaderImport(aggregate)];
  return pending.find(receipt => receipt?.result.status === "failed") ?? pending.find(Boolean) ?? null;
}


export function retryableUnityEditorCheck(aggregate: TurnAggregateV1) {
  const receipt = unresolvedUnityEditorCheck(aggregate);
  if (receipt?.result.status !== "unavailable") return null;
  return /^UNITY_(?:EDITOR_UNREACHABLE|EDITOR_INSTANCE_CHANGED|EDITOR_NOT_READY|CLI_UNAVAILABLE|COMPILE_VERDICT_UNAVAILABLE|SHADER_IMPORT_UNVERIFIED):/.test(
    receipt.result.message || "",
  ) ? receipt : null;
}

export function readyUnityEditorRoute(
  result: UnityCompilationResult,
  observation: unknown,
): string | null {
  if (result.status !== "unavailable" || !observation || typeof observation !== "object") return null;
  const { route, pid, version } = observation as { route?: unknown; pid?: number; version?: unknown };
  if (typeof version !== "string" || !version) return null;
  const connectionIssue = /^UNITY_(?:EDITOR_UNREACHABLE|EDITOR_INSTANCE_CHANGED|EDITOR_NOT_READY|CLI_UNAVAILABLE):/.test(result.message || "");
  if (route === "closed") return result.kind !== "shader_import" && connectionIssue ? `closed:${version}` : null;
  if (route !== "connected" || !Number.isSafeInteger(pid) || Number(pid) <= 0) return null;
  const changedInstance = result.editorPid != null && result.editorPid !== pid;
  const opened = result.editor === "closed";
  return connectionIssue || changedInstance || opened ? `connected:${version}:${pid}` : null;
}
