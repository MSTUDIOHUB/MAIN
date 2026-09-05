import {
  commitProjectInit,
  inspectProjectInitTarget,
} from "./ipc";
import {
  buildProjectBaselineContext,
  type ProjectBaselineIo,
} from "./projectBaseline";
import {
  type ProjectInitCasResult,
  type ProjectInitCasInput,
  type ProjectInitInspection,
  type ProjectInitIo,
} from "./projectInit";
import { projectBaselineIpcIo } from "./projectBaselineIpc";
import { sha256Hex } from "./sha256";

const PROJECT_INIT_MANAGED_TARGET = "agents.md";

/** `/init` must not hash the managed file back into the block written to that
 * same file. Excluding the root target from this one baseline view prevents a
 * self-referential fingerprint from changing on every refresh. Normal Turn
 * admission still includes the complete AGENTS.md instruction source. */
const projectInitBaselineIpcIo: ProjectBaselineIo = Object.freeze({
  canonicalizeWorkspace: projectBaselineIpcIo.canonicalizeWorkspace,
  ...(projectBaselineIpcIo.resolveVcsRoot
    ? { resolveVcsRoot: projectBaselineIpcIo.resolveVcsRoot }
    : {}),
  ...(projectBaselineIpcIo.getFileByteSize
    ? {
        getFileByteSize: (input: {
          readonly workspace: string;
          readonly path: string;
        }) => {
          if (
            String(input.path || "").replace(/\\/g, "/").toLowerCase() ===
              PROJECT_INIT_MANAGED_TARGET
          ) {
            return Promise.reject(
              new Error("PROJECT_INIT_MANAGED_TARGET_EXCLUDED"),
            );
          }
          return projectBaselineIpcIo.getFileByteSize!(input);
        },
      }
    : {}),
  async listDirectory(input: {
    readonly workspace: string;
    readonly path: string;
  }) {
    const entries = await projectBaselineIpcIo.listDirectory(input);
    if (String(input.path || "").trim()) return entries;
    return entries.filter(
      (entry) => String(entry.name || "").toLowerCase() !== PROJECT_INIT_MANAGED_TARGET,
    );
  },
  readFile(input: { readonly workspace: string; readonly path: string }) {
    if (
      String(input.path || "").replace(/\\/g, "/").toLowerCase() ===
        PROJECT_INIT_MANAGED_TARGET
    ) {
      return Promise.reject(new Error("PROJECT_INIT_MANAGED_TARGET_EXCLUDED"));
    }
    return projectBaselineIpcIo.readFile(input);
  },
});

export function projectWorkspaceIdentity(canonicalWorkspace: string): string {
  return `project-workspace-sha256-${sha256Hex(
    normalizeProjectWorkspacePath(canonicalWorkspace),
  )}`;
}

export function normalizeProjectWorkspacePath(workspace: string): string {
  let normalized = String(workspace || "").trim().replace(/\\/g, "/");
  if (normalized === "/" || /^[A-Za-z]:\/$/.test(normalized)) return normalized;
  normalized = normalized.replace(/\/+$/, "");
  return normalized;
}

function staleReason(error: unknown): ProjectInitCasResult | null {
  const message = error instanceof Error ? error.message : String(error || "");
  if (/PROJECT_INIT_WORKSPACE_STALE/.test(message)) {
    return { status: "stale", reason: "workspace_identity" };
  }
  if (/PROJECT_INIT_TARGET_(?:STALE|IDENTITY_CHANGED)/.test(message)) {
    return { status: "stale", reason: "target_path" };
  }
  if (/PROJECT_INIT_CONTENT_STALE|CREATE_NEW_TARGET_EXISTS/.test(message)) {
    return { status: "stale", reason: "base_version" };
  }
  return null;
}

/** Production bridge for the pure `/init` preview/CAS service. */
export const projectInitIpcIo: ProjectInitIo = Object.freeze({
  async inspect(input: {
    readonly workspace: string;
    readonly targetPath: "AGENTS.md";
  }): Promise<ProjectInitInspection> {
    const snapshot = await inspectProjectInitTarget(input.workspace);
    const canonicalWorkspace = normalizeProjectWorkspacePath(
      snapshot.canonicalWorkspace,
    );
    return {
      canonicalWorkspace,
      workspaceIdentity: projectWorkspaceIdentity(canonicalWorkspace),
      targetPath: snapshot.targetPath,
      exists: snapshot.exists,
      content: snapshot.content,
      baseVersion: snapshot.contentVersion,
    };
  },
  async buildBaseline(input: {
    readonly canonicalWorkspace: string;
    readonly workspaceIdentity: string;
  }) {
    const baseline = await buildProjectBaselineContext({
      workspace: input.canonicalWorkspace,
      io: projectInitBaselineIpcIo,
    });
    if (baseline.workspace.identity !== input.workspaceIdentity) {
      throw new Error("PROJECT_INIT_BASELINE_WORKSPACE_MISMATCH");
    }
    return baseline;
  },
  async commit(input: ProjectInitCasInput): Promise<ProjectInitCasResult> {
    if (
      projectWorkspaceIdentity(input.expectedCanonicalWorkspace) !==
        input.expectedWorkspaceIdentity
    ) {
      return { status: "stale", reason: "workspace_identity" } as const;
    }
    try {
      const result = await commitProjectInit({
        workspace: input.expectedCanonicalWorkspace,
        expectedTargetPath: input.expectedTargetPath,
        expectedBaseVersion: input.expectedBaseVersion,
        content: input.proposedContent,
      });
      return result.unchanged
        ? { status: "no_op", version: result.contentVersion } as const
        : { status: "committed", version: result.contentVersion } as const;
    } catch (error) {
      const stale = staleReason(error);
      if (stale) return stale;
      throw error;
    }
  },
});
