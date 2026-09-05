import {
  canonicalizeWorkspacePath,
  getFileMetadata,
  getGitStatus,
  globSearch,
  listDirectory,
  readFile,
} from "./ipc";
import type {
  ProjectBaselineDirectoryEntry,
  ProjectBaselineIo,
} from "./projectBaseline";
import type { WorkspaceAdmissionIo } from "./workspaceAdmission";

/**
 * Production adapter for deterministic project-baseline reads.
 *
 * `list_directory` reports symlinks without following them. The baseline
 * builder can therefore exclude them instead of treating an untrusted link as
 * a file or directory.
 */
export const projectBaselineIpcIo: ProjectBaselineIo = Object.freeze({
  canonicalizeWorkspace(workspace: string): Promise<string> {
    return canonicalizeWorkspacePath(workspace);
  },
  async resolveVcsRoot(canonicalWorkspace: string): Promise<string | null> {
    const status = await getGitStatus(canonicalWorkspace, false);
    return status.isRepo && status.repoRoot
      ? String(status.repoRoot)
      : null;
  },
  async getFileByteSize(input: {
    readonly workspace: string;
    readonly path: string;
  }): Promise<number> {
    const metadata = await getFileMetadata(input.path, input.workspace);
    return metadata.sizeBytes;
  },
  async listDirectory(input: {
    readonly workspace: string;
    readonly path: string;
  }): Promise<readonly ProjectBaselineDirectoryEntry[]> {
    const nodes = await listDirectory(
      input.path || input.workspace,
      input.workspace,
    );
    return nodes.map((node) => ({
      name: node.name,
      kind: node.is_symlink
        ? "symlink" as const
        : node.is_dir
          ? "directory" as const
          : "file" as const,
    }));
  },
  readFile(input: {
    readonly workspace: string;
    readonly path: string;
  }): Promise<string> {
    return readFile(input.path, input.workspace);
  },
});

/** Shared-read admission adapter. The resolver layers one read-through cache
 * over these primitives for instructions and baseline anchors. */
export const workspaceAdmissionIpcIo: WorkspaceAdmissionIo = Object.freeze({
  canonicalizeWorkspace: projectBaselineIpcIo.canonicalizeWorkspace,
  resolveVcsRoot: projectBaselineIpcIo.resolveVcsRoot,
  getFileByteSize(path: string, canonicalWorkspace: string) {
    return projectBaselineIpcIo.getFileByteSize!({
      workspace: canonicalWorkspace,
      path,
    });
  },
  async listDirectory(path: string, canonicalWorkspace: string) {
    return projectBaselineIpcIo.listDirectory({
      workspace: canonicalWorkspace,
      path,
    });
  },
  readFile(path: string, canonicalWorkspace: string) {
    return readFile(path, canonicalWorkspace);
  },
  globSearch(pattern: string, canonicalWorkspace: string) {
    return globSearch(pattern, canonicalWorkspace);
  },
});
