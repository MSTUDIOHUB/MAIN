export interface ProtocolPackageLike {
  active?: boolean;
  type?: string;
  packagePath?: string | null;
  entryPoint?: string | null;
  workspaceScope?: string | null;
  name?: string;
}

function normalizeSlashPath(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+/g, "/").trim();
}

function trimPathEdges(value: string, trimLeadingSlash = false): string {
  let normalized = normalizeSlashPath(value);
  if (trimLeadingSlash && !isAbsoluteFilePath(normalized)) {
    normalized = normalized.replace(/^\/+/, "");
  }
  return normalized.replace(/\/+$/, "");
}

function isAbsoluteFilePath(value: string): boolean {
  return /^\/|^[a-zA-Z]:[\\/]/.test(value);
}

function hasUnsafePathSegment(value: string): boolean {
  return normalizeSlashPath(value)
    .split("/")
    .some((segment) => !segment || segment === "." || segment === ".." || segment.includes("\0"));
}

export function isSafeProtocolPackagePath(
  packagePath: string,
  entryPoint: string,
): boolean {
  const root = trimPathEdges(packagePath || "");
  const entry = trimPathEdges(entryPoint || "SKILL.md", true);
  if (!root || !entry || isAbsoluteFilePath(root) || isAbsoluteFilePath(entry)) {
    return false;
  }
  if (!root.startsWith(".protocols/") || hasUnsafePathSegment(root) || hasUnsafePathSegment(entry)) {
    return false;
  }
  return true;
}

function normalizeWorkspaceScope(value: string | null | undefined): string {
  return normalizeSlashPath(value || "").replace(/\/+$/, "");
}

export function isProtocolPackageApplicableToWorkspace(
  pkg: Pick<ProtocolPackageLike, "active" | "type" | "packagePath" | "entryPoint" | "workspaceScope">,
  workspace: string,
): boolean {
  if (!pkg.active || pkg.type !== "package" || !pkg.packagePath) return false;

  const workspaceScope = normalizeWorkspaceScope(pkg.workspaceScope);
  if (workspaceScope) {
    return workspaceScope === normalizeWorkspaceScope(workspace) &&
      isSafeProtocolPackagePath(
        pkg.packagePath,
        pkg.entryPoint || "SKILL.md",
      );
  }

  // A legacy package without an installation workspace has no trustworthy
  // authority boundary. Keep the record visible in UI, but fail closed until
  // the user reinstalls it into an explicit workspace.
  return false;
}

export function getApplicableProtocolPackagesForWorkspace<T extends ProtocolPackageLike>(
  skills: T[],
  workspace: string,
): T[] {
  return skills.filter((skill) => isProtocolPackageApplicableToWorkspace(skill, workspace));
}

export function getProtocolPackageEntryPath(pkg: Pick<ProtocolPackageLike, "packagePath" | "entryPoint">): string {
  const entry = trimPathEdges(pkg.entryPoint || "SKILL.md", true);
  const root = trimPathEdges(pkg.packagePath || "");

  if (!isSafeProtocolPackagePath(root, entry)) {
    throw new Error("Invalid protocol package path: entry must stay within .protocols/.");
  }

  if (!entry) return root;
  if (!root || isAbsoluteFilePath(entry)) return entry;
  if (entry === root || entry.startsWith(`${root}/`)) return entry;
  return `${root}/${entry}`;
}

export function resolveProtocolPackageReadPath(
  requestedPath: string,
  skills: ProtocolPackageLike[],
  workspace: string,
): string {
  const normalizedPath = normalizeSlashPath(requestedPath || "");
  if (!normalizedPath) return normalizedPath;
  if (isAbsoluteFilePath(normalizedPath)) return normalizedPath;

  const matches = getApplicableProtocolPackagesForWorkspace(skills, workspace)
    .map((skill) => {
      const entry = trimPathEdges(skill.entryPoint || "SKILL.md", true);
      const entryPath = getProtocolPackageEntryPath(skill);
      const entryBase = entry.split("/").pop() || entry;
      return { entry, entryBase, entryPath };
    })
    .filter(({ entry, entryBase, entryPath }) =>
      normalizedPath === entryPath ||
      normalizedPath === entry ||
      normalizedPath === entryBase,
    );

  if (matches.length !== 1) return normalizedPath;
  return matches[0].entryPath;
}
