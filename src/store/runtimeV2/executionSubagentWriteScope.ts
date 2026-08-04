import type { RuntimeV2SubagentJob } from "../../lib/runtime-v2";
import type { RuntimeV2LiveExecutionState } from "./executionTypes";

export function normalizedRuntimeV2SubagentPath(value: unknown): string {
  return String(value || "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/")
    .replace(/^\.\//, "")
    .replace(/\/$/, "");
}

export function runtimeV2SubagentPathsOverlap(
  left: unknown,
  right: unknown,
): boolean {
  const a = normalizedRuntimeV2SubagentPath(left);
  const b = normalizedRuntimeV2SubagentPath(right);
  if (!a || !b || a === "." || b === ".") return true;
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

export function runtimeV2JobOwnsMutationTargets(input: {
  readonly job: RuntimeV2SubagentJob;
  readonly targets: readonly string[];
}): boolean {
  return input.job.taskKind === "implement" &&
    input.job.accessMode === "write" &&
    input.targets.length > 0 &&
    input.targets.every((target) =>
      input.job.allowedPaths.some((ownedTarget) =>
        normalizedRuntimeV2SubagentPath(target) ===
          normalizedRuntimeV2SubagentPath(ownedTarget)
      )
    );
}

export function activeRuntimeV2ChildWriteConflict(input: {
  readonly live: RuntimeV2LiveExecutionState;
  readonly targets: readonly string[];
  readonly excludeJobId?: string;
}): { readonly jobId: string; readonly scope: readonly string[] } | null {
  for (const [jobId, scope] of input.live.childWriteScopes || new Map()) {
    if (jobId === input.excludeJobId) continue;
    if (input.targets.some((target) =>
      scope.some((root) => runtimeV2SubagentPathsOverlap(root, target))
    )) {
      return { jobId, scope };
    }
  }
  return null;
}

/** Durable counterpart to the process-local lock map. After restart an
 * active implementation request cannot be resumed, but its aggregate job
 * still owns the exact targets until join records the transaction as
 * committed or discarded. */
export function activeRuntimeV2SubagentJobWriteConflict(input: {
  readonly jobs: readonly RuntimeV2SubagentJob[];
  readonly targets: readonly string[];
  readonly excludeJobId?: string;
}): { readonly jobId: string; readonly scope: readonly string[] } | null {
  for (const job of input.jobs) {
    if (
      job.id === input.excludeJobId ||
      (job.status !== "queued" && job.status !== "running") ||
      job.taskKind !== "implement" ||
      job.accessMode !== "write"
    ) {
      continue;
    }
    if (input.targets.some((target) =>
      job.allowedPaths.some((ownedTarget) =>
        runtimeV2SubagentPathsOverlap(ownedTarget, target)
      )
    )) {
      return { jobId: job.id, scope: job.allowedPaths };
    }
  }
  return null;
}
