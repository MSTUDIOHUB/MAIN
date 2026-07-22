export interface DirectoryToolNode {
  name: string;
  path: string;
  is_dir: boolean;
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "");
}

/**
 * Normalize a path used as a workspace-file identity.  This deliberately
 * keeps the distinction between a workspace-relative path and an absolute
 * path: `src/main.rs` must never become an alias for
 * `src-tauri/src/main.rs` merely because their suffixes overlap.
 */
export function normalizeWorkspacePathIdentity(value: string): string {
  return String(value || "")
    .replace(/\\/g, "/")
    .replace(/^[`'\"]+|[`'\"]+$/g, "")
    .replace(/^\.\//, "")
    .replace(/\/+$/, "")
    .trim()
    .toLocaleLowerCase();
}

export function isAbsoluteWorkspacePath(value: string): boolean {
  const normalized = String(value || "").replace(/\\/g, "/").trim();
  return /^(?:\/|[a-z]:\/)/i.test(normalized);
}

/**
 * Compare workspace file identities without accepting a relative suffix as a
 * different relative file.  Absolute tool targets can still match their
 * workspace-relative equivalent, which preserves local-path tool support.
 */
export function workspacePathsReferToSameFile(left: string, right: string): boolean {
  const a = normalizeWorkspacePathIdentity(left);
  const b = normalizeWorkspacePathIdentity(right);
  if (!a || !b) return false;
  if (a === b) return true;

  const aIsAbsolute = isAbsoluteWorkspacePath(a);
  const bIsAbsolute = isAbsoluteWorkspacePath(b);
  if (aIsAbsolute === bIsAbsolute) return false;

  const absolute = aIsAbsolute ? a : b;
  const relative = aIsAbsolute ? b : a;
  return absolute.endsWith(`/${relative}`);
}

/**
 * Resolve a model/user file reference against a closed set of runtime-known
 * workspace files. Exact identities retain the strict path policy above. A
 * basename-only reference is accepted only when it identifies exactly one
 * candidate; relative suffixes such as `src/main.rs` never alias a different
 * tree such as `src-tauri/src/main.rs`.
 */
export function resolveUniqueWorkspaceFileReference(
  reference: string,
  candidates: Iterable<string>,
): string | null {
  const rawCandidates = [...candidates]
    .map((candidate) => String(candidate || "").trim())
    .filter(Boolean);
  const exactMatches = rawCandidates.filter((candidate) =>
    workspacePathsReferToSameFile(reference, candidate)
  );
  const uniqueExact = [...new Map(exactMatches.map((candidate) => [
    normalizeWorkspacePathIdentity(candidate),
    candidate,
  ])).values()];
  if (uniqueExact.length === 1) return uniqueExact[0];
  if (uniqueExact.length > 1) return null;

  const normalizedReference = normalizeWorkspacePathIdentity(reference);
  if (
    !normalizedReference ||
    isAbsoluteWorkspacePath(normalizedReference) ||
    normalizedReference.includes("/")
  ) return null;
  const basenameMatches = rawCandidates.filter((candidate) => {
    const normalizedCandidate = normalizeWorkspacePathIdentity(candidate);
    return (normalizedCandidate.split("/").pop() || normalizedCandidate) === normalizedReference;
  });
  const uniqueBasenameMatches = [...new Map(basenameMatches.map((candidate) => [
    normalizeWorkspacePathIdentity(candidate),
    candidate,
  ])).values()];
  return uniqueBasenameMatches.length === 1 ? uniqueBasenameMatches[0] : null;
}

export function relativizeToWorkspacePath(fullPath: string, workspace: string): string {
  const normalizedFullPath = normalizePath(fullPath);
  const normalizedWorkspace = normalizePath(workspace);

  if (!normalizedWorkspace) return normalizedFullPath;
  if (normalizedFullPath === normalizedWorkspace) return ".";

  const prefix = `${normalizedWorkspace}/`;
  if (normalizedFullPath.startsWith(prefix)) {
    return normalizedFullPath.slice(prefix.length);
  }

  return normalizedFullPath;
}

export function formatDirectoryNodesForTool(
  nodes: DirectoryToolNode[],
  workspace: string,
): string[] {
  return nodes.map((node) => {
    const relativePath = relativizeToWorkspacePath(node.path, workspace) || node.name;
    return node.is_dir ? `${relativePath.replace(/\/+$/, "")}/` : relativePath;
  });
}
