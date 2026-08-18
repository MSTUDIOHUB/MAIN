import {
  normalizeApplyPatchHeaderPath,
  parseApplyPatch,
} from "./applyPatchTool";

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

export type WorkspaceMutationOperation = "create" | "modify" | "delete";

export interface WorkspaceMutationRequest {
  readonly target: string;
  readonly operation: WorkspaceMutationOperation | null;
}

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
  for (const match of String(patch || "").matchAll(/^\*\*\*\s+Move\s+to:\s*(.+)$/gmi)) {
    if (match[1]) targets.push(normalizeApplyPatchHeaderPath(match[1]));
  }
  return [...new Set(targets.filter(Boolean))];
}

function extractApplyPatchMutationRequests(
  patch: string,
): WorkspaceMutationRequest[] {
  const parsed = parseApplyPatch(String(patch || ""));
  if (!parsed.ok) return [];
  const requests: WorkspaceMutationRequest[] = parsed.operations.flatMap(
    (operation): WorkspaceMutationRequest[] => {
      if (operation.kind === "add") {
        return [{ target: operation.path, operation: "create" as const }];
      }
      if (operation.kind === "delete") {
        return [{ target: operation.path, operation: "delete" as const }];
      }
      if (operation.newPath) {
        // preview/apply materializes a move as removal of the reviewed source
        // plus creation of a distinct destination. Authorization must reflect
        // those real effects rather than pretending both paths were modified.
        return [
          { target: operation.path, operation: "delete" as const },
          { target: operation.newPath, operation: "create" as const },
        ];
      }
      return [{ target: operation.path, operation: "modify" as const }];
    },
  );
  return requests.filter((request, index, values) =>
    values.findIndex((candidate) =>
      candidate.operation === request.operation &&
      candidate.target === request.target
    ) === index
  );
}

function extractApplyPatchCreationTargets(patch: string): string[] {
  const targets: string[] = [];
  for (const match of String(patch || "").matchAll(/^\*\*\*\s+Add\s+File:\s*(.+)$/gmi)) {
    if (match[1]) targets.push(normalizeApplyPatchHeaderPath(match[1]));
  }
  return [...new Set(targets.filter(Boolean))];
}

function extractApplyPatchMoveTargets(patch: string): string[] {
  const targets: string[] = [];
  for (const match of String(patch || "").matchAll(/^\*\*\*\s+Move\s+to:\s*(.+)$/gmi)) {
    if (match[1]) targets.push(normalizeApplyPatchHeaderPath(match[1]));
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

/**
 * Resolve the semantic operation as well as the exact path for a workspace
 * mutation. Approved WorkPlan execution uses this lower-level fact to prevent
 * a provider from satisfying a reviewed create/delete step with a different
 * mutation primitive that merely happens to name the same path.
 */
export function resolveWorkspaceMutationRequests(
  name: string,
  args: Record<string, unknown> = {},
  fallbackTarget = "",
): WorkspaceMutationRequest[] {
  if (!isWorkspaceMutationToolCall(name, args)) return [];
  if (name === "apply_patch") {
    const requests = extractApplyPatchMutationRequests(String(args.patch || ""));
    if (requests.length > 0) return requests;
    return resolveWorkspaceMutationTargets(name, args, fallbackTarget).map(
      (target) => ({ target, operation: null }),
    );
  }
  const operation: WorkspaceMutationOperation | null =
    name === "write_file" || name === "create_script"
      ? "create"
      : name === "replace_in_file" ||
          name === "apply_text_edits" ||
          name === "script_apply_edits"
        ? "modify"
        : name === "delete_workspace_path" || name === "delete_script"
          ? "delete"
          : name === "manage_script"
            ? String(args.action || "").trim().toLowerCase() === "create"
              ? "create"
              : String(args.action || "").trim().toLowerCase() === "delete"
                ? "delete"
                : null
            : null;
  return resolveWorkspaceMutationTargets(name, args, fallbackTarget).map(
    (target) => ({ target, operation }),
  );
}

/**
 * Targets whose mutation request explicitly permits creating a file that does
 * not exist yet. Callers must still verify non-existence before treating these
 * as creations; `write_file` can also overwrite an existing file.
 */
export function resolveWorkspaceMutationCreationTargets(
  name: string,
  args: Record<string, unknown> = {},
  fallbackTarget = "",
): string[] {
  if (name === "apply_patch") {
    // A Move destination is creation-capable but not unconditionally
    // create-only: callers must prove it absent, and the executor rechecks it.
    return extractApplyPatchMoveTargets(String(args.patch || ""));
  }
  if (name === "write_file") {
    return resolveWorkspaceMutationTargets(name, args, fallbackTarget);
  }
  return [];
}

/** Create-only mutations fail instead of overwriting when the target exists. */
export function resolveWorkspaceMutationCreateOnlyTargets(
  name: string,
  args: Record<string, unknown> = {},
): string[] {
  if (name === "apply_patch") {
    return extractApplyPatchCreationTargets(String(args.patch || ""));
  }
  return [];
}

export function hasResolvedWorkspaceMutationTarget(name: string, target: string): boolean {
  const normalizedTarget = normalizeMutationPath(target);
  return Boolean(normalizedTarget && normalizedTarget.toLowerCase() !== String(name || "").toLowerCase());
}
