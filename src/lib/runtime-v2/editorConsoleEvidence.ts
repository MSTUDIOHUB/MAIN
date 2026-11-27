import { extractExactReadFileWindow } from "../readFileWindow";
import { normalizeValidationWorkspaceCwd } from "../validationContract";
import type { TurnAggregateV1 } from "./aggregate";
import { latestRuntimeV2WorkspaceChange, runtimeV2WorkspaceChangeReceipts } from "./validationReceipt";

export interface RuntimeV2ConsoleDiagnostic {
  readonly kind: "csharp" | "shader_import" | "runtime";
  readonly path?: string;
  readonly line?: number;
  readonly code?: string;
  readonly shaderName?: string;
}

export interface RuntimeV2EditorConsoleEvidence {
  readonly instanceId: string;
  readonly editorVersion: string;
  readonly editorPid?: number;
  readonly complete: boolean;
  readonly diagnostics: readonly RuntimeV2ConsoleDiagnostic[];
  readonly retainedDiagnostics?: readonly RuntimeV2ConsoleDiagnostic[];
  readonly pipeline?: {
    readonly retainedWindowComplete: boolean;
    readonly retainedErrors?: number;
    readonly retainedWarnings?: number;
    readonly session?: string;
    readonly cursor?: number;
    readonly live?: RuntimeV2PipelineConsoleSample;
  };
}

export interface RuntimeV2PipelineConsoleSample {
  readonly ageMs: number;
  readonly sampledAt: number;
  readonly compiling: boolean;
  readonly compilationFailed: boolean;
  readonly errors: number;
  readonly warnings: number;
}

type EditorBinding = Pick<RuntimeV2EditorConsoleEvidence, "instanceId" | "editorVersion" | "editorPid">;
const PIPELINE_SAMPLE_MAX_AGE_MS = 2_000;

function consoleRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function nonnegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function pipelineConsoleSample(value: unknown): RuntimeV2PipelineConsoleSample | undefined {
  const sample = consoleRecord(value);
  if (!sample || typeof sample.compiling !== "boolean" || typeof sample.compilationFailed !== "boolean") return;
  const ageMs = nonnegativeInteger(sample.ageMs);
  const errors = nonnegativeInteger(sample.consoleErrors);
  const warnings = nonnegativeInteger(sample.consoleWarnings);
  const sampledAt = typeof sample.sampledUtc === "string" ? Date.parse(sample.sampledUtc) : NaN;
  if (ageMs === undefined || errors === undefined || warnings === undefined || !Number.isFinite(sampledAt)) return;
  return { ageMs, sampledAt, errors, warnings, compiling: sample.compiling, compilationFailed: sample.compilationFailed };
}

export function freshRuntimeV2PipelineConsoleSample(sample: RuntimeV2PipelineConsoleSample | undefined) {
  return sample && nonnegativeInteger(sample.ageMs) !== undefined && sample.ageMs <= PIPELINE_SAMPLE_MAX_AGE_MS &&
    Number.isFinite(sample.sampledAt) && sample.compiling === false ? sample : undefined;
}

export function sameRuntimeV2ConsoleEditor(left: EditorBinding, right: EditorBinding) {
  return left.editorVersion === right.editorVersion && (left.editorPid !== undefined && right.editorPid !== undefined
    ? left.editorPid === right.editorPid
    : left.instanceId === right.instanceId);
}

function isPipelineBinding(binding: EditorBinding) {
  return /^unity-(?:cli|official-mcp):/.test(binding.instanceId);
}

function parseDiagnostic(entry: unknown, workspace: string): RuntimeV2ConsoleDiagnostic | undefined {
  const row = entry && typeof entry === "object" ? entry as Record<string, unknown> : undefined;
  const type = String(row?.type || "").toLowerCase();
  if (type === "warning" || type === "log") return;
  const message = String(row?.message || (typeof entry === "string" ? entry : ""));
  if (!type && /(?:\bwarning CS\d+:|^Shader warning in )/i.test(message)) return;
  const compiler = /^(.+?)\((\d+)(?:,\d+)?\):\s*error\s+(CS\d+)\b/i.exec(message);
  const shader = /^Shader error in ['"]([^'"\r\n]+)['"]/i.exec(message);
  const shaderPath = shader && /\bat\s+((?:Assets|Packages)\/[^\r\n]+?\.(?:shader|compute))\s*\(/i.exec(message)?.[1];
  const path = normalizeValidationWorkspaceCwd(compiler?.[1] || shaderPath || row?.file, workspace);
  const line = Number(compiler?.[2] || row?.line || /\bat line (\d+)\b/i.exec(message)?.[1]);
  const location = Number.isSafeInteger(line) && line > 0 ? { line } : {};
  if (compiler) {
    return { kind: "csharp", code: compiler[3]!.toUpperCase(), ...location,
      ...(path && /^(?:Assets|Packages)\/.*\.cs$/i.test(path) ? { path } : {}) };
  }
  if (shader) {
    return { kind: "shader_import", shaderName: shader[1]!.slice(0, 180), ...location,
      ...(path && /^(?:Assets|Packages)\/.*\.(?:shader|compute)$/i.test(path) ? { path } : {}) };
  }
  return { kind: "runtime", ...(path && path !== "." ? { path } : {}), ...location };
}

export function runtimeV2EditorConsoleEvidence(input: {
  readonly workspace: string;
  readonly binding: EditorBinding;
  readonly args: Readonly<Record<string, unknown>>;
  readonly result: Record<string, unknown> | null;
}): RuntimeV2EditorConsoleEvidence | undefined {
  if (input.result?.success !== true) return;
  const data = input.result.data;
  const page = data && typeof data === "object" && !Array.isArray(data) ? data as Record<string, unknown> : null;
  const entries = Array.isArray(data) ? data : page?.items;
  if (!Array.isArray(entries)) return;
  const diagnostics = entries.slice(0, 100).flatMap(entry => parseDiagnostic(entry, input.workspace) ?? []);
  const { instanceId, editorVersion, editorPid } = input.binding;
  const binding = { instanceId, editorVersion, ...(editorPid === undefined ? {} : { editorPid }) };
  const retained = consoleRecord(page?.consoleEvidence);
  if (isPipelineBinding(binding) || retained?.rowSource === "retained") {
    const sample = pipelineConsoleSample(page?.groundTruth);
    const pipeline = retained?.rowSource === "retained" ? {
      retainedWindowComplete: retained.retainedWindowComplete === true,
      retainedErrors: nonnegativeInteger(retained.retainedErrors),
      retainedWarnings: nonnegativeInteger(retained.retainedWarnings),
      session: typeof retained.session === "string" && retained.session.length <= 80 ? retained.session : undefined,
      cursor: nonnegativeInteger(retained.cursor),
      live: sample,
    } : undefined;
    const live = freshRuntimeV2PipelineConsoleSample(pipeline?.live);
    return { ...binding, complete: live?.errors === 0 && !live.compilationFailed, diagnostics: [],
      retainedDiagnostics: diagnostics, ...(pipeline ? { pipeline } : {}) };
  }
  const { args } = input;
  // The raw MCP Console schema defaults to ten rows. A full capped window
  // cannot establish that all original errors were observed.
  const count = Number(args.count ?? 10);
  let types = args.types;
  if (typeof types === "string") {
    try { types = JSON.parse(types); } catch { types = []; }
  }
  const unfilteredErrors = !String(args.filter_text || args.filterText || "").trim() && Number(args.cursor ?? 0) === 0 &&
    (types == null || Array.isArray(types) && types.some(type => ["error", "all"].includes(String(type).trim().toLowerCase())));
  const complete = unfilteredErrors && entries.length <= 100 && (page
    ? page.truncated === false && Number(page.cursor ?? 0) === 0 && Number(page.total ?? entries.length) === entries.length
    : Number.isInteger(count) && count > 0 && entries.length < count);
  return { ...binding, complete, diagnostics };
}

/** Older official/CLI receipts treated the captured rows as editor rows. */
function currentConsoleEvidence(scope: RuntimeV2EditorConsoleEvidence) {
  return isPipelineBinding(scope) && !scope.pipeline
    ? { ...scope, complete: false, diagnostics: [], retainedDiagnostics: scope.retainedDiagnostics ?? scope.diagnostics }
    : scope;
}

export function isRuntimeV2EditorDiagnosticRepair(state: TurnAggregateV1 | null): boolean {
  const requirement = state?.objective.completionRequirement;
  return requirement?.kind === "workspace_change" && requirement.editorDiagnostics === true;
}

export function runtimeV2EditorConsoleDebugSummary(evidence: RuntimeV2EditorConsoleEvidence | undefined) {
  if (!evidence) return {};
  const live = evidence.pipeline?.live;
  return {
    editorDiagnosticCount: evidence.diagnostics.length,
    editorRetainedDiagnosticCount: evidence.retainedDiagnostics?.length ?? null,
    editorLiveErrorCount: live?.errors ?? null,
    editorConsoleSampleAgeMs: live?.ageMs ?? null,
    editorConsoleCompiling: live?.compiling ?? null,
  };
}

const scopes = new WeakMap<TurnAggregateV1, RuntimeV2EditorConsoleEvidence | undefined>();

/** Keep early error targets for the current Editor. A verified replacement
 * process starts a new evidence scope. */
export function runtimeV2EditorDiagnosticScope(state: TurnAggregateV1): RuntimeV2EditorConsoleEvidence | undefined {
  if (!isRuntimeV2EditorDiagnosticRepair(state)) return;
  if (scopes.has(state)) return scopes.get(state);
  const observed = state.events.flatMap(event => {
    if (event.type !== "tool.completed" || event.status !== "succeeded" ||
        event.run.runId !== state.run?.identity.runId || !event.editorConsole) return [];
    const scope = currentConsoleEvidence(event.editorConsole);
    const live = freshRuntimeV2PipelineConsoleSample(scope.pipeline?.live);
    return scope.diagnostics.length || scope.retainedDiagnostics?.length || live
      ? [{ sequence: event.sequence, scope }] : [];
  });
  let bindingStart = 0;
  for (let index = 1; index < observed.length; index += 1) {
    const first = observed[bindingStart]!.scope;
    const next = observed[index]!.scope;
    if (first.editorPid && next.editorPid && !sameRuntimeV2ConsoleEditor(first, next) &&
        (freshRuntimeV2PipelineConsoleSample(next.pipeline?.live) || next.complete)) bindingStart = index;
  }
  const initial = observed[bindingStart];
  const firstWrite = runtimeV2WorkspaceChangeReceipts(state).find(event => event.sequence > (initial?.sequence ?? -1))?.sequence ?? Infinity;
  const candidates = observed.slice(bindingStart);
  const scope = initial && (initial.scope.complete && initial.scope.diagnostics.length ? initial.scope : candidates.find(item => item.sequence < firstWrite &&
    item.scope.complete && item.scope.diagnostics.length && sameRuntimeV2ConsoleEditor(item.scope, initial.scope))?.scope ??
    candidates.find(item => item.sequence < firstWrite && sameRuntimeV2ConsoleEditor(item.scope, initial.scope) &&
      freshRuntimeV2PipelineConsoleSample(item.scope.pipeline?.live)?.compilationFailed)?.scope ?? initial.scope);
  if (!scope || scope.diagnostics.every(item => item.kind !== "shader_import" || item.path)) {
    scopes.set(state, scope);
    return scope;
  }
  const shaderPaths = new Map<string, Set<string>>();
  for (const event of state.events) {
    if (event.type !== "tool.completed" || event.status !== "succeeded" || !event.modelContent) continue;
    const window = extractExactReadFileWindow(event.modelContent);
    const path = window && normalizeValidationWorkspaceCwd(window.metadata.path, state.turn.workspaceKey);
    if (!path || !/^(?:Assets|Packages)\/.*\.shader$/i.test(path) ||
        !event.evidence.some(item => item.kind === "source" && item.version === window.metadata.contentVersion)) continue;
    const name = /^\s*Shader\s+"([^"\r\n]+)"/m.exec(window.content)?.[1];
    if (!name) continue;
    const paths = shaderPaths.get(name) ?? new Set<string>();
    paths.add(path);
    shaderPaths.set(name, paths);
  }
  const resolved = { ...scope, diagnostics: scope.diagnostics.map(item => {
    const paths = item.shaderName && shaderPaths.get(item.shaderName);
    return !item.path && paths && paths.size === 1 ? { ...item, path: [...paths][0] } : item;
  }) };
  scopes.set(state, resolved);
  return resolved;
}

export function runtimeV2EditorDiagnosticFocus(state: TurnAggregateV1, checked: readonly RuntimeV2ConsoleDiagnostic["kind"][]) {
  const modified = new Set(runtimeV2WorkspaceChangeReceipts(state).flatMap(event => event.evidence.flatMap(item => {
    const target = item.kind === "mutation" && normalizeValidationWorkspaceCwd(item.target, state.turn.workspaceKey);
    return target ? [target] : [];
  })));
  const diagnostics = runtimeV2EditorDiagnosticScope(state)?.diagnostics || [];
  return diagnostics.find(item => !checked.includes(item.kind) && (!item.path || !modified.has(item.path)));
}

export function runtimeV2EditorRepairInstruction(
  state: TurnAggregateV1 | null,
  checked: readonly RuntimeV2ConsoleDiagnostic["kind"][],
  consoleTool: string | undefined,
): string {
  if (!state || !isRuntimeV2EditorDiagnosticRepair(state)) return "";
  const focus = runtimeV2EditorDiagnosticFocus(state, checked);
  if (focus?.path) return `Console repair still needs a verified fix. Start with ${JSON.stringify(focus.path)}${focus.line ? ` at line ${focus.line}` : ""}${focus.code ? ` (${focus.code})` : ""}. Reuse the current source window when available, make the smallest justified change, and continue from the Editor's check.`;
  if (focus?.shaderName) return `Locate the declaration of Shader ${JSON.stringify(focus.shaderName)} in the workspace and inspect the reported source before editing.`;
  if (latestRuntimeV2WorkspaceChange(state)) return "Continue from the actual C# compilation and Shader import receipts. Runtime exceptions also require a corresponding reproduction or test.";
  return consoleTool
    ? `Read the bound Editor Console with ${consoleTool}. Choose one diagnostic target, make the smallest justified change, and continue from the Editor check.`
    : "A connected Unity Console reader is unavailable. Use available project evidence to investigate and report any missing Editor verification.";
}
