import {
  canonicalizePlanArtifactPath,
  type PlanArtifact,
} from "./workflowModels";

// tasks.md is an execution/checkpoint artifact created after approval. Binding
// it into the reviewed design hash would invalidate a valid approval whenever
// task evidence changes. Only user-reviewable plan/design artifacts participate.
const REVIEWABLE_KINDS = new Set(["plan", "design", "bugfix"]);

export interface PlanApprovalIdentity {
  revision: number;
  artifactHash: string;
  artifactPaths: string[];
  artifactCount: number;
}

function stableHash(input: string): string {
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36).padStart(7, "0");
}

export function getReviewablePlanArtifacts(artifacts: PlanArtifact[]): PlanArtifact[] {
  return (artifacts || [])
    .filter((artifact) => REVIEWABLE_KINDS.has(artifact.kind) && String(artifact.content || "").trim())
    .map((artifact) => ({
      ...artifact,
      path: canonicalizePlanArtifactPath(artifact.path),
    }))
    .slice()
    .sort((left, right) => left.path.localeCompare(right.path));
}

export function buildPlanApprovalIdentity(
  artifacts: PlanArtifact[],
): PlanApprovalIdentity | null {
  const reviewable = getReviewablePlanArtifacts(artifacts);
  if (reviewable.length === 0) return null;
  const revision = reviewable.reduce(
    (max, artifact) => Math.max(max, Number(artifact.revision) || 1),
    1,
  );
  const canonical = reviewable
    .map((artifact) => [
      artifact.kind,
      artifact.path,
      String(Number(artifact.revision) || 1),
      String(artifact.content || "").replace(/\r\n?/g, "\n").trim(),
    ].join("\u001f"))
    .join("\u001e");
  return {
    revision,
    artifactHash: `plan-${stableHash(canonical)}`,
    artifactPaths: reviewable.map((artifact) => artifact.path),
    artifactCount: reviewable.length,
  };
}

export function isPlanApprovalIdentityCurrent(input: {
  artifacts: PlanArtifact[];
  revision?: number | null;
  artifactHash?: string | null;
}): boolean {
  const current = buildPlanApprovalIdentity(input.artifacts);
  if (!current || !input.artifactHash) return false;
  return current.artifactHash === input.artifactHash &&
    (input.revision == null || current.revision === input.revision);
}
