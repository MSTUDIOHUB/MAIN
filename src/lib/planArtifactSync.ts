import {
  canonicalizePlanArtifactPath,
  detectPlanArtifactKind,
  type PlanArtifactKind,
} from "./workflowModels";
import type { PlanCandidateV2 } from "./planContract";

type SyncedPlanArtifactKind = Exclude<PlanArtifactKind, "summary">;

export interface ResolvedPlanArtifactUpdate {
  kind: SyncedPlanArtifactKind;
  path: string;
  content: string;
}

const PLAN_ARTIFACT_MUTATION_TOOLS = new Set(["write_file", "replace_in_file"]);

export interface PlanArtifactSyncCallbacks {
  onPlanArtifactUpdated: (
    path: string,
    content: string,
    kind: SyncedPlanArtifactKind,
    metadata?: { candidate?: PlanCandidateV2 },
  ) => void;
  onPlanTasksUpdated: (content: string) => void;
}

export interface PlanArtifactSyncOptions {
  readFile: (path: string) => Promise<string>;
  warn?: (message: string, error?: unknown) => void;
  candidate?: PlanCandidateV2;
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

  return { kind, path: canonicalizePlanArtifactPath(path) };
}

async function resolveUpdatedPlanArtifactContent(
  toolName: string,
  toolArgs: Record<string, unknown>,
  options: PlanArtifactSyncOptions,
): Promise<string | null> {
  const path = typeof toolArgs.path === "string" ? toolArgs.path : "";
  if (!path) return null;

  // write_file already gives us the exact bytes accepted by the tool. The
  // mutation lifecycle verifies that the target changed, so reading the whole
  // artifact back only duplicates I/O. Incremental mutations still require a
  // read-back because their final content is not present in the arguments.
  if (toolName === "write_file" && typeof toolArgs.content === "string") {
    return toolArgs.content;
  }

  try {
    return await options.readFile(path);
  } catch (error) {
    options.warn?.(
      `[plan-artifact-sync] Failed to read back updated plan artifact ${path}.`,
      error,
    );
    return null;
  }
}

export async function resolvePlanArtifactAfterToolSuccess(
  toolName: string,
  toolArgs: Record<string, unknown>,
  options: PlanArtifactSyncOptions,
): Promise<ResolvedPlanArtifactUpdate | null> {
  const target = getPlanArtifactTarget(toolName, toolArgs);
  if (!target) return null;

  const content = await resolveUpdatedPlanArtifactContent(toolName, toolArgs, options);
  if (content == null) return null;
  return { ...target, content };
}

export function commitResolvedPlanArtifactUpdate(
  update: ResolvedPlanArtifactUpdate,
  callbacks: PlanArtifactSyncCallbacks,
  metadata?: { candidate?: PlanCandidateV2 },
): void {
  if (metadata?.candidate) {
    callbacks.onPlanArtifactUpdated(update.path, update.content, update.kind, metadata);
  } else {
    callbacks.onPlanArtifactUpdated(update.path, update.content, update.kind);
  }
  if (update.kind === "tasks" || update.kind === "bugfix") {
    callbacks.onPlanTasksUpdated(update.content);
  }
}

export async function syncPlanArtifactAfterToolSuccess(
  toolName: string,
  toolArgs: Record<string, unknown>,
  callbacks: PlanArtifactSyncCallbacks,
  options: PlanArtifactSyncOptions,
): Promise<void> {
  const update = await resolvePlanArtifactAfterToolSuccess(toolName, toolArgs, options);
  if (!update) return;
  commitResolvedPlanArtifactUpdate(
    update,
    callbacks,
    options.candidate ? { candidate: options.candidate } : undefined,
  );
}
