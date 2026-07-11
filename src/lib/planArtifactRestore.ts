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
 * Persisted unapproved artifacts are candidates, not proof that a review
 * boundary was reached. Re-apply the actionable Plan gate on restore so an
 * older runtime cannot revive a draft that the current runtime would reject.
 * Already-approved work keeps the narrower structural gate to preserve a
 * resumable execution lease across validator upgrades.
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

    const validation = kind === "plan" && !input.isPlanApproved
      ? validateActionablePlanArtifact(content)
      : validatePlanArtifactContent(content, kind);
    if (!validation.ok) {
      rejected.push({
        path,
        kind,
        reason: validation.reason || "quality_gate",
      });
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
