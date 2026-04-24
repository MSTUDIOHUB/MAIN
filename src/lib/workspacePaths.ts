export interface DirectoryToolNode {
  name: string;
  path: string;
  is_dir: boolean;
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "");
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
