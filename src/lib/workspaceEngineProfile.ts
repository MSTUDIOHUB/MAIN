import type { EngineManualPresetId } from "./engineManualSkills";

export interface WorkspaceEngineProfile {
  readonly kind: "unity" | "godot" | "unreal" | "uefn";
  readonly projectRoot: string;
  readonly descriptorPath: string;
  readonly projectVersion: string | null;
  readonly manualPresetId: EngineManualPresetId | null;
  readonly engineAssociation?: string;
  readonly editorBuildTarget?: string;
}

interface WorkspaceEngineProfileOptions {
  readonly contextPaths?: readonly string[];
  readonly projectRootHint?: string;
}

/** Project metadata is guidance. It cannot authorize tools or certify a build. */
export async function resolveWorkspaceEngineProfile(
  workspace: string | null | undefined,
  options: WorkspaceEngineProfileOptions = {},
): Promise<WorkspaceEngineProfile | null> {
  if (!workspace?.trim()) return null;
  try {
    const { inspectWorkspaceEngineProfile } = await import("./ipc");
    return await inspectWorkspaceEngineProfile(workspace, options.contextPaths || [], options.projectRootHint);
  } catch {
    return null;
  }
}
