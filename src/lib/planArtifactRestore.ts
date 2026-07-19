import { sanitizePlanArtifactContent } from "./sanitize";
import {
  canonicalizePlanArtifactPath,
  detectPlanArtifactKind,
  validateActionablePlanArtifact,
  validatePlanArtifactContent,
  type PlanArtifact,
} from "./workflowModels";

export interface RestoredPlanArtifactSanitization {
  artifacts: PlanArtifact[];
  rejected: Array<{
    path: string;
    kind: string;
    reason: string;
  }>;
}

/**
 * Persisted artifacts are candidates, not proof that a review boundary was
 * reached. Re-apply the current actionable Plan gate even to an artifact that
 * an older runtime marked approved. An invalid formerly-approved Plan remains
 * in the artifact list as an audit record, while `rejected` invalidates its
 * execution lease and returns the owning store to an unapproved Plan stage.
 */
export function sanitizeRestoredPlanArtifacts(input: {
  artifacts: PlanArtifact[] | null | undefined;
  isPlanApproved: boolean;
}): RestoredPlanArtifactSanitization {
  const artifacts: PlanArtifact[] = [];
  const rejected: RestoredPlanArtifactSanitization["rejected"] = [];
  const seenPaths = new Set<string>();

  const candidates = [...(input.artifacts || [])].sort(
    (left, right) => (Number(right.updatedAt) || 0) - (Number(left.updatedAt) || 0),
  );
  for (const candidate of candidates) {
    const kind = candidate?.kind;
    const path = canonicalizePlanArtifactPath(candidate?.path);
    const content = sanitizePlanArtifactContent(candidate?.content || "");
    const detectedKind = detectPlanArtifactKind(path);
    const pathKey = path.toLowerCase();
    if (seenPaths.has(pathKey)) {
      rejected.push({ path, kind: String(kind || "unknown"), reason: "duplicate_artifact_path" });
      continue;
    }
    seenPaths.add(pathKey);
    if (!kind || !path || !content.trim() || detectedKind !== kind) {
      rejected.push({ path, kind: String(kind || "unknown"), reason: "invalid_artifact_identity" });
      continue;
    }

    const validation = kind === "plan"
      ? validateActionablePlanArtifact(content)
      : validatePlanArtifactContent(content, kind);
    if (!validation.ok) {
      rejected.push({
        path,
        kind,
        reason: validation.reason || "quality_gate",
      });
      if (kind === "plan" && input.isPlanApproved) {
        artifacts.push({
          ...candidate,
          path,
          content,
          revision: Math.max(1, Number(candidate.revision) || 1),
          updatedAt: Math.max(0, Number(candidate.updatedAt) || 0),
        });
      }
      continue;
    }

    artifacts.push({
      ...candidate,
      path,
      content,
      revision: Math.max(1, Number(candidate.revision) || 1),
      updatedAt: Math.max(0, Number(candidate.updatedAt) || 0),
    });
  }

  return {
    artifacts: artifacts.sort((left, right) => left.updatedAt - right.updatedAt),
    rejected,
  };
}
