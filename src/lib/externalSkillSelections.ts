export type ExternalSkillMode = "auto" | "manual" | "disabled";

/** A reference to the native-discovered entry, never a copy of its content. */
export interface ExternalSkillSelection {
  readonly entryPath: string;
  readonly workspaceScope: string | null;
  readonly mode: ExternalSkillMode;
}

/** Native discovery supplies canonical paths. This normalizes presentation
 * separators only; it never resolves a relative path or invents an identity. */
function absolutePath(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const input = value.trim().replace(/\\/g, "/");
  if (!input || /[\u0000-\u001f]/.test(input) ||
      (!input.startsWith("/") && !/^[a-z]:\//i.test(input)) ||
      input.split("/").some((part) => part === "." || part === "..")) return null;
  const prefix = input.startsWith("//") ? "/" : "";
  const normalized = prefix + input.replace(/\/+/g, "/");
  return normalized === "/" || /^[a-z]:\/$/i.test(normalized)
    ? normalized : normalized.replace(/\/+$/, "");
}

/** Invalid persisted records are omitted. A later selection for one exact
 * entry/scope replaces its earlier mode, preserving the caller's last choice. */
export function normalizeExternalSkillSelections(value: unknown): ExternalSkillSelection[] {
  if (!Array.isArray(value)) return [];
  const selections = new Map<string, ExternalSkillSelection>();
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const entryPath = absolutePath(record.entryPath);
    const workspaceScope = record.workspaceScope === null ? null : absolutePath(record.workspaceScope);
    if (!entryPath || (record.workspaceScope !== null && !workspaceScope) ||
        (record.mode !== "auto" && record.mode !== "manual" && record.mode !== "disabled")) continue;
    const selection: ExternalSkillSelection = { entryPath, workspaceScope, mode: record.mode };
    selections.set(JSON.stringify([entryPath, workspaceScope]), selection);
  }
  return [...selections.values()];
}

/** Project overrides are exact, not ancestor matches. Missing means discovered
 * but never added; explicit invocation cannot grant admission. */
export function resolveExternalSkillMode(
  selections: readonly ExternalSkillSelection[] | null | undefined,
  entryPath: string,
  workspace: string | null | undefined,
): ExternalSkillMode | undefined {
  const entry = absolutePath(entryPath);
  if (!entry) return undefined;
  const scope = absolutePath(workspace);
  let global: ExternalSkillMode | undefined;
  let project: ExternalSkillMode | undefined;
  for (const selection of normalizeExternalSkillSelections(selections)) {
    if (selection.entryPath !== entry) continue;
    if (selection.workspaceScope === null) global = selection.mode;
    else if (scope && selection.workspaceScope === scope) project = selection.mode;
  }
  return project ?? global;
}
