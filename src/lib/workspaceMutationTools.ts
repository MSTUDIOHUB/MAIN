import { normalizeApplyPatchHeaderPath } from "./applyPatchTool";

/**
 * Tools that can durably mutate files in the active workspace.
 *
 * This classification deliberately lives below Plan and recovery policy so
 * progress, evidence, cache invalidation, and narrowed tool surfaces cannot
 * disagree about whether an available editor is a real mutation tool.
 */
export const BUILTIN_WORKSPACE_MUTATION_TOOL_NAMES = new Set([
  "write_file",
  "replace_in_file",
  "apply_patch",
  "delete_workspace_path",
]);

export const EXTERNAL_WORKSPACE_MUTATION_TOOL_NAMES = new Set([
  "script_apply_edits",
  "apply_text_edits",
  "manage_script",
  "create_script",
  "delete_script",
]);

export const WORKSPACE_MUTATION_TOOL_NAMES = new Set([
  ...BUILTIN_WORKSPACE_MUTATION_TOOL_NAMES,
  ...EXTERNAL_WORKSPACE_MUTATION_TOOL_NAMES,
]);

export function isWorkspaceMutationToolName(name: string): boolean {
  return WORKSPACE_MUTATION_TOOL_NAMES.has(String(name || ""));
}

export function isWorkspaceMutationToolCall(
  name: string,
  args: Record<string, unknown> = {},
): boolean {
  if (!isWorkspaceMutationToolName(name)) return false;
  if (name !== "manage_script") return true;
  const action = String(args.action || "").trim().toLowerCase();
  return action === "create" || action === "delete";
}

function normalizeMutationPath(value: unknown): string {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (raw.startsWith("file://")) {
    try {
      return decodeURIComponent(raw.replace(/^file:\/\//, "")).replace(/\\/g, "/");
    } catch {
      return raw.replace(/^file:\/\//, "").replace(/\\/g, "/");
    }
  }
  return raw.replace(/\\/g, "/").replace(/\/+/g, "/");
}

function extractApplyPatchTargets(patch: string): string[] {
  const targets: string[] = [];
  for (const match of String(patch || "").matchAll(/^\*\*\*\s+(?:Update|Add|Delete)\s+File:\s*(.+)$/gmi)) {
    if (match[1]) targets.push(normalizeApplyPatchHeaderPath(match[1]));
  }
  for (const match of String(patch || "").matchAll(/^\+\+\+\s+(?:b\/)?([^\s]+)$/gmi)) {
    if (match[1] && match[1] !== "/dev/null") targets.push(normalizeApplyPatchHeaderPath(match[1]));
  }
  return [...new Set(targets.filter(Boolean))];
}

export function resolveWorkspaceMutationTargets(
  name: string,
  args: Record<string, unknown> = {},
  fallbackTarget = "",
): string[] {
  if (!isWorkspaceMutationToolCall(name, args)) return [];
  if (name === "apply_patch") {
    const targets = extractApplyPatchTargets(String(args.patch || ""));
    return targets.length > 0 ? targets : [normalizeMutationPath(fallbackTarget)].filter(Boolean);
  }

  if (name === "apply_text_edits") {
    return [normalizeMutationPath(args.uri || args.path || fallbackTarget)].filter(Boolean);
  }

  if (name === "script_apply_edits" || name === "manage_script") {
    const folder = normalizeMutationPath(args.path);
    const scriptName = String(args.name || "").trim();
    if (folder && scriptName) {
      const fileName = scriptName.endsWith(".cs") ? scriptName : `${scriptName}.cs`;
      return [normalizeMutationPath(`${folder.replace(/\/+$/, "")}/${fileName}`)];
    }
  }

  return [normalizeMutationPath(args.path || fallbackTarget)].filter(Boolean);
}

export function hasResolvedWorkspaceMutationTarget(name: string, target: string): boolean {
  const normalizedTarget = normalizeMutationPath(target);
  return Boolean(normalizedTarget && normalizedTarget.toLowerCase() !== String(name || "").toLowerCase());
}
