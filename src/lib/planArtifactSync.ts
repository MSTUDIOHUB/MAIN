import { detectPlanArtifactKind, type PlanArtifactKind } from "./workflowModels";

type SyncedPlanArtifactKind = Exclude<PlanArtifactKind, "summary">;

const PLAN_ARTIFACT_MUTATION_TOOLS = new Set(["write_file", "replace_in_file"]);

export interface PlanArtifactSyncCallbacks {
  onPlanArtifactUpdated: (path: string, content: string, kind: SyncedPlanArtifactKind) => void;
  onPlanTasksUpdated: (content: string) => void;
}

export interface PlanArtifactSyncOptions {
  readFile: (path: string) => Promise<string>;
  warn?: (message: string, error?: unknown) => void;
}

function getPlanArtifactTarget(
  toolName: string,
  toolArgs: Record<string, unknown>,
): { kind: SyncedPlanArtifactKind; path: string } | null {
  if (!PLAN_ARTIFACT_MUTATION_TOOLS.has(toolName)) return null;

  const path = typeof toolArgs.path === "string" ? toolArgs.path : "";
  if (!path) return null;

  const kind = detectPlanArtifactKind(path);
  if (!kind || kind === "summary") return null;

  return { kind, path };
}

async function resolveUpdatedPlanArtifactContent(
  toolName: string,
  toolArgs: Record<string, unknown>,
  options: PlanArtifactSyncOptions,
): Promise<string | null> {
  const path = typeof toolArgs.path === "string" ? toolArgs.path : "";
  if (!path) return null;

  try {
    return await options.readFile(path);
  } catch (error) {
    if (toolName === "write_file" && typeof toolArgs.content === "string") {
      options.warn?.(
        `[plan-artifact-sync] Failed to read back ${path}; falling back to write_file content.`,
        error,
      );
      return toolArgs.content;
    }

    options.warn?.(
      `[plan-artifact-sync] Failed to read back updated plan artifact ${path}.`,
      error,
    );
    return null;
  }
}

export async function syncPlanArtifactAfterToolSuccess(
  toolName: string,
  toolArgs: Record<string, unknown>,
  callbacks: PlanArtifactSyncCallbacks,
  options: PlanArtifactSyncOptions,
): Promise<void> {
  const target = getPlanArtifactTarget(toolName, toolArgs);
  if (!target) return;

  const content = await resolveUpdatedPlanArtifactContent(toolName, toolArgs, options);
  if (content == null) return;

  callbacks.onPlanArtifactUpdated(target.path, content, target.kind);
  if (target.kind === "tasks" || target.kind === "bugfix") {
    callbacks.onPlanTasksUpdated(content);
  }
}
