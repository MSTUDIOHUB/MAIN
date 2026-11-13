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
  readonly complete: boolean;
  readonly diagnostics: readonly RuntimeV2ConsoleDiagnostic[];
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
  readonly binding: Pick<RuntimeV2EditorConsoleEvidence, "instanceId" | "editorVersion">;
  readonly args: Readonly<Record<string, unknown>>;
  readonly result: Record<string, unknown> | null;
}): RuntimeV2EditorConsoleEvidence | undefined {
  if (input.result?.success !== true) return;
  const data = input.result.data;
  const page = data && typeof data === "object" && !Array.isArray(data) ? data as Record<string, unknown> : null;
  const entries = Array.isArray(data) ? data : page?.items;
  if (!Array.isArray(entries)) return;
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
  const diagnostics = entries.slice(0, 100).flatMap(entry => parseDiagnostic(entry, input.workspace) ?? []);
  return { instanceId: input.binding.instanceId, editorVersion: input.binding.editorVersion, complete, diagnostics };
}

export function isRuntimeV2EditorDiagnosticRepair(state: TurnAggregateV1 | null): boolean {
  const requirement = state?.objective.completionRequirement;
  return requirement?.kind === "workspace_change" && requirement.editorDiagnostics === true;
}

const scopes = new WeakMap<TurnAggregateV1, RuntimeV2EditorConsoleEvidence | undefined>();

/** Keep the initial error set after a repair starts. Subsequent Console
 * reads cannot remove acceptance targets while their fixes are unverified. */
export function runtimeV2EditorDiagnosticScope(state: TurnAggregateV1): RuntimeV2EditorConsoleEvidence | undefined {
  if (!isRuntimeV2EditorDiagnosticRepair(state)) return;
  if (scopes.has(state)) return scopes.get(state);
  const firstWrite = runtimeV2WorkspaceChangeReceipts(state)[0]?.sequence ?? Infinity;
  const observed = state.events.flatMap(event => event.type === "tool.completed" && event.status === "succeeded" &&
    event.run.runId === state.run?.identity.runId && event.editorConsole?.diagnostics.length ? [{ sequence: event.sequence, scope: event.editorConsole }] : []);
  const initial = observed[0];
  const scope = initial && (initial.scope.complete ? initial.scope : observed.find(item => item.sequence < firstWrite &&
    item.scope.complete && item.scope.instanceId === initial.scope.instanceId && item.scope.editorVersion === initial.scope.editorVersion)?.scope ?? initial.scope);
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

export function runtimeV2EditorRepairInstruction(state: TurnAggregateV1 | null, checked: readonly RuntimeV2ConsoleDiagnostic["kind"][] = []): string {
  if (!state || !isRuntimeV2EditorDiagnosticRepair(state)) return "";
  const focus = runtimeV2EditorDiagnosticFocus(state, checked);
  if (focus?.path) return `Console repair still needs a verified fix. Start with ${JSON.stringify(focus.path)}${focus.line ? ` at line ${focus.line}` : ""}${focus.code ? ` (${focus.code})` : ""}. Reuse the current source window when available, make the smallest justified change, and continue from the Editor's check.`;
  if (focus?.shaderName) return `Locate the declaration of Shader ${JSON.stringify(focus.shaderName)} in the workspace and inspect the reported source before editing.`;
  if (latestRuntimeV2WorkspaceChange(state)) return "Continue from the actual C# compilation and Shader import receipts. Runtime exceptions also require a corresponding reproduction or test.";
  return "Read the bound Editor Console with unity_mcp_console when available. Choose one diagnostic target, make the smallest justified change, and continue from the Editor check.";
}
