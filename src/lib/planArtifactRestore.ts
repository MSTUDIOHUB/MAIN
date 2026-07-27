import { sanitizePlanArtifactContent } from "./sanitize";
import {
  canonicalizePlanArtifactPath,
  detectPlanArtifactKind,
  validateActionablePlanArtifact,
  validatePlanArtifactContent,
  type PlanArtifact,
} from "./workflowModels";
import {
  hashPlanCandidate,
  validateSealedPlanCandidate,
} from "./planContract";

export interface RestoredPlanArtifactSanitization {
  artifacts: PlanArtifact[];
  rejected: Array<{
    path: string;
    kind: string;
    reason: string;
  }>;
  candidateIntegrityRejectedPaths: string[];
}

export type PlanArtifactCandidateIntegrityResult =
  | {
      ok: true;
      mode: "legacy" | "typed";
      candidateHash?: string;
    }
  | {
      ok: false;
      reason: string;
    };

/**
 * Total integrity boundary shared by restore and review readiness. Legacy
 * artifacts have no typed fields at all; once any typed field is present the
 * sealed candidate, its hash and its authoring contract id are one indivisible
 * authority. Partial serialization must never silently fall back to Markdown.
 */
export function validatePlanArtifactCandidateIntegrity(
  artifact: Pick<
    PlanArtifact,
    "kind" | "content" | "candidate" | "candidateHash" | "authoringContractId"
  >,
): PlanArtifactCandidateIntegrityResult {
  const hasCandidate = artifact.candidate !== undefined && artifact.candidate !== null;
  const hasCandidateHash = artifact.candidateHash !== undefined && artifact.candidateHash !== null;
  const hasAuthoringContractId = artifact.authoringContractId !== undefined &&
    artifact.authoringContractId !== null;
  const hasTypedMetadata = hasCandidateHash || hasAuthoringContractId;

  if (!hasCandidate && !hasTypedMetadata) {
    return { ok: true, mode: "legacy" };
  }
  if (!hasCandidate) {
    return { ok: false, reason: "candidate_metadata_without_candidate" };
  }
  if (!hasCandidateHash || !hasAuthoringContractId) {
    return { ok: false, reason: "candidate_metadata_incomplete" };
  }
  if (artifact.kind !== "plan") {
    return { ok: false, reason: "candidate_kind_mismatch" };
  }

  try {
    const failures = validateSealedPlanCandidate({
      candidate: artifact.candidate!,
      expectedContent: sanitizePlanArtifactContent(artifact.content || ""),
    });
    if (failures.length > 0) {
      return { ok: false, reason: failures[0]! };
    }
    const candidateHash = hashPlanCandidate(artifact.candidate!);
    if (artifact.candidateHash !== candidateHash) {
      return { ok: false, reason: "candidate_hash_mismatch" };
    }
    if (artifact.authoringContractId !== artifact.candidate!.authoringContractId) {
      return { ok: false, reason: "candidate_authoring_contract_mismatch" };
    }
    return { ok: true, mode: "typed", candidateHash };
  } catch {
    return { ok: false, reason: "candidate_payload_malformed" };
  }
}

/**
 * Persisted artifacts are candidates, not proof that a review boundary was
 * reached. Legacy Plan Markdown is re-imported through the current actionable
 * gate and supporting artifacts retain their native schemas. A typed Plan has
 * already proven its exact projection at the integrity boundary above, so its
 * display Markdown must not become a second semantic authority during restore.
 */
export function sanitizeRestoredPlanArtifacts(input: {
  artifacts: PlanArtifact[] | null | undefined;
  isPlanApproved: boolean;
}): RestoredPlanArtifactSanitization {
  const artifacts: PlanArtifact[] = [];
  const rejected: RestoredPlanArtifactSanitization["rejected"] = [];
  const candidateIntegrityRejectedPaths: string[] = [];
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

    const candidateIntegrity = validatePlanArtifactCandidateIntegrity({
      ...candidate,
      content,
    });
    if (!candidateIntegrity.ok) {
      rejected.push({
        path,
        kind,
        reason: candidateIntegrity.reason,
      });
      candidateIntegrityRejectedPaths.push(path);
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
    const normalizedCandidate = candidateIntegrity.mode === "legacy" && kind === "plan"
      ? {
          ...candidate,
          // Cold restore is the compatibility adapter. Presence of this
          // projection, even when empty, prevents a legacy artifact from being
          // confused with a new raw Markdown Plan at later commit boundaries.
          legacyTaskProjection: Array.isArray(candidate.legacyTaskProjection)
            ? candidate.legacyTaskProjection
            : [],
        }
      : candidate;

    if (candidateIntegrity.mode !== "typed") {
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
            ...normalizedCandidate,
            path,
            content,
            revision: Math.max(1, Number(candidate.revision) || 1),
            updatedAt: Math.max(0, Number(candidate.updatedAt) || 0),
          });
        }
        continue;
      }
    }

    artifacts.push({
      ...normalizedCandidate,
      path,
      content,
      revision: Math.max(1, Number(candidate.revision) || 1),
      updatedAt: Math.max(0, Number(candidate.updatedAt) || 0),
    });
  }

  return {
    artifacts: artifacts.sort((left, right) => left.updatedAt - right.updatedAt),
    rejected,
    candidateIntegrityRejectedPaths,
  };
}
