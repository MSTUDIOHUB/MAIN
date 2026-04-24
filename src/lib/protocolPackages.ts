export interface ProtocolPackageLike {
  active?: boolean;
  type?: string;
  packagePath?: string | null;
  entryPoint?: string | null;
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

export function getProtocolPackageEntryPath(pkg: Pick<ProtocolPackageLike, "packagePath" | "entryPoint">): string {
  const entry = trimPathEdges(pkg.entryPoint || "SKILL.md", true);
  const root = trimPathEdges(pkg.packagePath || "");

  if (!entry) return root;
  if (!root || isAbsoluteFilePath(entry)) return entry;
  if (entry === root || entry.startsWith(`${root}/`)) return entry;
  return `${root}/${entry}`;
}

export function resolveProtocolPackageReadPath(
  requestedPath: string,
  skills: ProtocolPackageLike[],
): string {
  const normalizedPath = normalizeSlashPath(requestedPath || "");
  if (!normalizedPath) return normalizedPath;
  if (isAbsoluteFilePath(normalizedPath)) return normalizedPath;

  const matches = skills
    .filter((skill) => skill.active && skill.type === "package" && skill.packagePath)
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
