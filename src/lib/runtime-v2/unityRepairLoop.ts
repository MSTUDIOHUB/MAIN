import type { TurnAggregateV1 } from "./aggregate";
import type { RuntimeV2Command } from "./contracts";
import type { RuntimeV2Event } from "./events";
import { runtimeV2EvidenceVersion } from "./evidenceVersion";
import { normalizeValidationWorkspaceCwd } from "../validationContract";
import {
  freshRuntimeV2PipelineConsoleSample, isRuntimeV2EditorDiagnosticRepair, runtimeV2EditorDiagnosticScope, sameRuntimeV2ConsoleEditor,
  type RuntimeV2ConsoleDiagnostic,
} from "./editorConsoleEvidence";
import {
  deriveUnityCompilation, runtimeV2UnityBaselineReceipt, unityCheckTargetInProject, unityCompilationTarget,
  UNITY_BASELINE_CHECK_KIND, UNITY_COMPILE_PROJECT_TOOL, type UnityCompilationResult,
} from "./unityCompilation";

export const UNITY_INSPECT_ASSEMBLIES_TOOL = "unity_inspect_assemblies";
const ASSEMBLY_SOURCE_LIMIT = 8;
const ASSEMBLY_ERROR_CODE = /^CS(?:0006|0012|0234|0246|1069|1705)$/i;

export interface RuntimeV2UnityBaselinePayload {
  readonly toolName: typeof UNITY_COMPILE_PROJECT_TOOL;
  readonly runtimeOwnedUnityBaselineCompile: true;
  readonly editorCheckKind: typeof UNITY_BASELINE_CHECK_KIND;
  readonly consoleSequence: number;
  readonly editorPid: number;
  readonly editorVersion: string;
  readonly sourcePaths: readonly string[];
}

export interface RuntimeV2UnityAssemblyDiagnosisPayload {
  readonly toolName: typeof UNITY_INSPECT_ASSEMBLIES_TOOL;
  readonly runtimeOwnedUnityAssemblyDiagnosis: true;
  readonly diagnosticSequence: number;
  readonly editorPid?: number;
  readonly editorVersion: string;
  readonly sourcePaths: readonly string[];
}

export interface RuntimeV2UnityAssemblyReport {
  readonly complete: boolean;
  readonly sources: readonly {
    readonly path: string;
    readonly sourceVersion?: string;
    readonly assembly?: {
      readonly name: string;
      readonly path?: string;
      readonly version?: string;
      readonly predefined: boolean;
      readonly dependencyClosure?: readonly { readonly path: string; readonly version: string }[];
      readonly references: readonly {
        readonly reference: string;
        readonly status: "resolved" | "missing" | "ambiguous" | "predefined";
        readonly resolved?: {
          readonly name: string;
          readonly path: string;
          readonly package?: string;
          readonly packageVersion?: string;
          readonly version?: string;
        };
        readonly candidate?: {
          readonly name: string;
          readonly path: string;
          readonly package?: string;
          readonly packageVersion?: string;
          readonly version?: string;
          readonly namespace?: string;
        };
      }[];
    } | null;
  }[];
}

export type RuntimeV2UnityAssemblyReference = NonNullable<RuntimeV2UnityAssemblyReport["sources"][number]["assembly"]>["references"][number];

export function decodeRuntimeV2UnityAssemblyReport(value: unknown, sourcePaths?: readonly string[]): RuntimeV2UnityAssemblyReport | undefined {
  const report = value as RuntimeV2UnityAssemblyReport | null;
  if (!report || typeof report.complete !== "boolean" || !Array.isArray(report.sources) || report.sources.length > ASSEMBLY_SOURCE_LIMIT) return;
  if (report.sources.some(source => !source || typeof source.path !== "string" || sourcePaths && !sourcePaths.includes(source.path) ||
      source.assembly && (typeof source.assembly.name !== "string" || !Array.isArray(source.assembly.references) ||
        source.assembly.references.some((reference: RuntimeV2UnityAssemblyReference) => !reference || typeof reference.reference !== "string" ||
          !["resolved", "missing", "ambiguous", "predefined"].includes(reference.status))))) return;
  return report;
}

type UnityRepairPayload = RuntimeV2UnityBaselinePayload | RuntimeV2UnityAssemblyDiagnosisPayload;

interface UnityRepairDiagnostic {
  readonly sequence: number;
  readonly sourcePaths: readonly string[];
  readonly result?: UnityCompilationResult;
}

interface UnityRepairContext {
  readonly baseline?: ReturnType<typeof runtimeV2UnityBaselineReceipt>;
  readonly diagnostic?: UnityRepairDiagnostic;
  readonly assemblyReport?: { readonly sequence: number; readonly sourcePaths: readonly string[]; readonly report: RuntimeV2UnityAssemblyReport };
  readonly next?: UnityRepairPayload;
}

function sourcePathsForDiagnostics(state: TurnAggregateV1, diagnostics: readonly RuntimeV2ConsoleDiagnostic[]) {
  const targets = diagnostics.flatMap(item => {
    if (item.kind !== "csharp" || !item.path) return [];
    const path = unityCompilationTarget(item.path, state.turn.workspaceKey);
    return path && unityCheckTargetInProject(path) && /\.cs$/i.test(path) ? [path] : [];
  });
  return [...new Set(targets)].sort().slice(0, ASSEMBLY_SOURCE_LIMIT);
}

function compilationDiagnostic(state: TurnAggregateV1, sequence: number, result: UnityCompilationResult): UnityRepairDiagnostic {
  const diagnostics = Array.isArray(result.diagnostics) ? result.diagnostics.flatMap(item =>
    item && typeof item.file === "string" && typeof item.code === "string" ? [{ kind: "csharp" as const, path: item.file, code: item.code }] : []) : [];
  const paths = sourcePathsForDiagnostics(state, diagnostics);
  return { sequence, result, sourcePaths: paths.length > 1 ? paths :
    sourcePathsForDiagnostics(state, diagnostics.filter(item => ASSEMBLY_ERROR_CODE.test(item.code))) };
}

function directDiagnosticKey(diagnostics: readonly RuntimeV2ConsoleDiagnostic[]): string {
  return JSON.stringify([...new Set(diagnostics.filter(item => item.kind === "csharp" && item.code && ASSEMBLY_ERROR_CODE.test(item.code))
    .map(item => JSON.stringify([item.code, item.path, item.line])))].sort());
}

/** A file can move within its source without changing the compiler's finding. */
function compilerVerdictKey(result: UnityCompilationResult, workspace: string): string | undefined {
  const editor = result.editorPid || result.editorInstanceId;
  if (result.projectRoot !== "." || result.kind !== "csharp" || result.editor !== "connected" ||
      !editor || !result.editorVersion || (result.status !== "failed" && result.status !== "passed")) return;
  const diagnostics = Array.isArray(result.diagnostics) ? result.diagnostics.flatMap(item => {
    if (!item || typeof item.code !== "string" || typeof item.message !== "string") return [];
    const file = typeof item.file === "string" ? normalizeValidationWorkspaceCwd(item.file, workspace) ?? item.file : null;
    return [JSON.stringify([file, item.code.toUpperCase(), item.message.replace(/\s+/g, " ").trim()])];
  }) : [];
  // A failure without typed findings cannot demonstrate that the fault repeated.
  if (result.status === "failed" && (!diagnostics.length || (result.errorCount ?? 0) > diagnostics.length)) return;
  return runtimeV2EvidenceVersion([workspace, editor, result.editorVersion, result.status, [...new Set(diagnostics)].sort()]);
}

const observationsByAggregate = new WeakMap<TurnAggregateV1, ReadonlyMap<number, string>>();

/** Only completed, runtime-owned checks contribute verdicts. Command IDs, request
 * wording, source offsets and timestamps are incidental to semantic progress. */
export function runtimeV2UnityRepairObservations(state: TurnAggregateV1): ReadonlyMap<number, string> {
  const cached = observationsByAggregate.get(state);
  if (cached) return cached;
  const observations = new Map<number, string>();
  observationsByAggregate.set(state, observations);
  const workspace = state.turn.workspaceKey;
  const runId = state.run?.identity.runId;
  const commands = new Map<string, RuntimeV2Command["payload"]>();
  for (const event of state.events) {
    if (!("run" in event) || event.run.runId !== runId) continue;
    if (event.type === "command.scheduled" && event.command.kind === "execute_tool") {
      commands.set(event.command.idempotencyKey, event.command.payload);
      continue;
    }
    if (event.type !== "tool.completed" || event.receiptOrigin === "replayed" || !event.modelContent) continue;
    const payload = commands.get(event.idempotencyKey);
    try {
      if (payload?.toolName === UNITY_COMPILE_PROJECT_TOOL && (payload.runtimeOwnedUnityBaselineCompile === true ||
          payload.runtimeOwnedUnityCompile === true && (payload.editorCheckKind ?? "csharp") === "csharp")) {
        const result = JSON.parse(event.modelContent) as UnityCompilationResult | null;
        if (!result || payload.runtimeOwnedUnityBaselineCompile === true &&
            (result.editorPid !== payload.editorPid || result.editorVersion !== payload.editorVersion)) continue;
        const key = compilerVerdictKey(result, workspace);
        if (key) observations.set(event.sequence, `unity-compiler:${key}`);
      } else if (payload?.toolName === UNITY_INSPECT_ASSEMBLIES_TOOL && payload.runtimeOwnedUnityAssemblyDiagnosis === true && event.status === "succeeded") {
        const report = decodeRuntimeV2UnityAssemblyReport(JSON.parse(event.modelContent));
        if (report) observations.set(event.sequence, `unity-assemblies:${runtimeV2EvidenceVersion([
          workspace, payload.editorPid, payload.editorVersion, report.complete,
          [...report.sources].sort((a, b) => a.path.localeCompare(b.path)),
        ])}`);
      }
    } catch { /* Malformed historical results carry no semantic progress. */ }
  }
  return observations;
}

export function runtimeV2UnityCompilerDecision(state: TurnAggregateV1 | null) {
  if (!state) return;
  const current = runtimeV2UnityRepairContext(state).diagnostic;
  if (!current?.result) return;
  const observations = runtimeV2UnityRepairObservations(state);
  const key = observations.get(current.sequence);
  if (!key) return;
  const previous = [...observations].reverse().find(([sequence, value]) => sequence < current.sequence && value.startsWith("unity-compiler:"));
  return { key, repeated: previous?.[1] === key };
}

function samePayload(actual: RuntimeV2Command["payload"], expected: UnityRepairPayload): boolean {
  return Object.entries(expected).every(([key, value]) => Array.isArray(value)
    ? Array.isArray(actual[key]) && JSON.stringify(actual[key]) === JSON.stringify(value)
    : actual[key] === value);
}

function assemblyAttempt(state: TurnAggregateV1, payload: RuntimeV2UnityAssemblyDiagnosisPayload) {
  const runId = state.run?.identity.runId;
  const attempts = new Set(state.events.flatMap(event =>
    event.type === "command.scheduled" && event.run.runId === runId && event.command.kind === "execute_tool" && samePayload(event.command.payload, payload)
      ? [event.command.idempotencyKey] : []));
  for (const event of [...state.events].reverse()) {
    if ((event.type !== "tool.completed" && event.type !== "command.completed") || event.run.runId !== runId ||
        !attempts.has(event.idempotencyKey)) continue;
    if (event.type === "tool.completed" && event.status === "succeeded" && event.modelContent) {
      try {
        const report = decodeRuntimeV2UnityAssemblyReport(JSON.parse(event.modelContent), payload.sourcePaths);
        if (report) {
          return { sequence: event.sequence, sourcePaths: payload.sourcePaths, report };
        }
      } catch { /* An invalid report is an attempted observation without a result. */ }
    }
    return null;
  }
  return undefined;
}

function computeUnityRepairContext(state: TurnAggregateV1): UnityRepairContext {
  const scope = runtimeV2EditorDiagnosticScope(state);
  if (!state.run || (state.strategy !== "execute" && state.workPlan?.status !== "approved")) return {};
  const runId = state.run.identity.runId;
  const consoleReceipt = scope && [...state.events].reverse().find(event => event.type === "tool.completed" && event.status === "succeeded" &&
    event.receiptOrigin !== "replayed" && event.run.runId === runId && event.editorConsole && sameRuntimeV2ConsoleEditor(scope, event.editorConsole));
  const latest = consoleReceipt?.type === "tool.completed" ? consoleReceipt.editorConsole : undefined;
  const live = freshRuntimeV2PipelineConsoleSample(latest?.pipeline?.live);
  const baseline = scope && runtimeV2UnityBaselineReceipt(state, scope);
  const compile = deriveUnityCompilation(state);
  const editorVersion = scope?.editorVersion ?? compile?.receipt?.result.editorVersion;
  const editorPid = scope?.editorPid ?? compile?.receipt?.result.editorPid;
  if (!editorVersion) return {};
  let diagnostic: UnityRepairDiagnostic | undefined;
  if (compile) {
    const check = compile.receipt;
    const versions = check?.result.targets;
    const exactTargets = versions?.length === compile.targets.length && compile.targets.every(path =>
      versions.some(target => target.path === path && (Object.prototype.hasOwnProperty.call(compile.expectedVersions, path)
        ? target.version === compile.expectedVersions[path] : !!scope && /^sha256-[a-f0-9]{64}$/.test(target.version ?? ""))));
    if (check?.result.status === "failed" && check.result.kind === "csharp" && check.result.editorVersion === editorVersion &&
        check.result.projectRoot === "." && exactTargets && (!scope?.editorPid || check.result.editorPid === scope.editorPid)) {
      diagnostic = compilationDiagnostic(state, check.sequence, check.result);
    }
  } else if (scope?.editorPid && latest && consoleReceipt && live?.compilationFailed && live.errors > 0) {
    if (!baseline) return { next: {
      toolName: UNITY_COMPILE_PROJECT_TOOL, runtimeOwnedUnityBaselineCompile: true, editorCheckKind: UNITY_BASELINE_CHECK_KIND,
      consoleSequence: consoleReceipt.sequence, editorPid: scope.editorPid, editorVersion: scope.editorVersion,
      sourcePaths: sourcePathsForDiagnostics(state, latest.retainedDiagnostics ?? []),
    } };
    if (baseline.result.status === "failed") diagnostic = compilationDiagnostic(state, baseline.sequence, baseline.result);
  } else if (scope?.complete && latest?.complete && !latest.pipeline && consoleReceipt && !baseline) {
    // A complete direct Console read has typed current rows. Pipeline history alone never selects a package lookup.
    const key = directDiagnosticKey(latest.diagnostics);
    let sequence = consoleReceipt.sequence;
    for (const event of [...state.events].reverse()) {
      if (event.type !== "tool.completed" || event.sequence >= sequence || event.run.runId !== runId || !event.editorConsole ||
          event.status !== "succeeded" || event.receiptOrigin === "replayed") continue;
      if (!event.editorConsole.complete || !sameRuntimeV2ConsoleEditor(scope, event.editorConsole) ||
          directDiagnosticKey(event.editorConsole.diagnostics) !== key) break;
      sequence = event.sequence;
    }
    diagnostic = { sequence, sourcePaths: sourcePathsForDiagnostics(state,
      latest.diagnostics.filter(item => item.code && ASSEMBLY_ERROR_CODE.test(item.code))) };
  }
  if (!diagnostic?.sourcePaths.length) return { baseline, diagnostic };
  const payload: RuntimeV2UnityAssemblyDiagnosisPayload = {
    toolName: UNITY_INSPECT_ASSEMBLIES_TOOL, runtimeOwnedUnityAssemblyDiagnosis: true, diagnosticSequence: diagnostic.sequence,
    ...(editorPid ? { editorPid } : {}), editorVersion, sourcePaths: diagnostic.sourcePaths,
  };
  const attempt = assemblyAttempt(state, payload);
  return { baseline, diagnostic, ...(attempt ? { assemblyReport: attempt } : {}), ...(attempt === undefined ? { next: payload } : {}) };
}

const repairContexts = new WeakMap<TurnAggregateV1, UnityRepairContext>();

export function runtimeV2UnityRepairContext(state: TurnAggregateV1 | null): UnityRepairContext {
  if (!state) return {};
  const cached = repairContexts.get(state);
  if (cached) return cached;
  const context = computeUnityRepairContext(state);
  repairContexts.set(state, context);
  return context;
}

export function nextRuntimeV2UnityRepairStep(state: TurnAggregateV1): UnityRepairPayload | undefined {
  return runtimeV2UnityRepairContext(state).next;
}

export function runtimeV2UnityRepairPayloadForCommand(state: TurnAggregateV1 | null, command: RuntimeV2Command): UnityRepairPayload | undefined {
  const expected = runtimeV2UnityRepairContext(state).next;
  const queued = state?.scheduledCommands.find(item => item.idempotencyKey === command.idempotencyKey);
  if (expected && state?.run?.status === "running" && command.kind === "execute_tool" && queued?.kind === "execute_tool" &&
      state.run.identity.runId === command.run.runId && queued.run.runId === command.run.runId &&
      samePayload(queued.payload, expected) && samePayload(command.payload, expected)) return expected;
}

/** A new timestamp on the same Console state does not renew the recovery lease. */
export function runtimeV2UnityRepairObservationKey(state: TurnAggregateV1, event: RuntimeV2Event): string | undefined {
  if (event.type !== "tool.completed" || !isRuntimeV2EditorDiagnosticRepair(state)) return;
  const console = event.editorConsole;
  const live = freshRuntimeV2PipelineConsoleSample(console?.pipeline?.live);
  if (console && live) return JSON.stringify(["unity-console", console.editorPid ?? console.instanceId,
    console.editorVersion, live.errors, live.compilationFailed]);
  if (console?.complete) return JSON.stringify(["unity-console", console.editorPid ?? console.instanceId,
    console.editorVersion, [...new Set(console.diagnostics.map(item => JSON.stringify([item.kind, item.code, item.path, item.line, item.shaderName])))].sort()]);
}
