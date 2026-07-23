import {
  canonicalizePlanArtifactPath,
  type PlanArtifact,
} from "./workflowModels";
import { hashPlanCandidate } from "./planContract";
import { validatePlanArtifactCandidateIntegrity } from "./planArtifactRestore";
import { sha256Hex } from "./sha256";

const PRIMARY_PLAN_PATH = ".MAIN/plans/plan.md";

export interface PlanApprovalIdentity {
  revision: number;
  artifactHash: string;
  artifactPaths: string[];
  artifactCount: number;
}

export type TypedPlanReviewAuthorityResolution =
  | {
      ok: true;
      artifact: PlanArtifact & { candidate: NonNullable<PlanArtifact["candidate"]> };
    }
  | {
      ok: false;
      reason:
        | "primary_plan_missing"
        | "primary_plan_ambiguous"
        | "primary_plan_path_invalid"
        | "primary_plan_content_missing"
        | "primary_plan_not_typed"
        | `primary_plan_integrity:${string}`;
      path?: string;
    };

export function buildPlanExecutionInstructionHash(instruction: string): string {
  return `plan-instruction-sha256-${sha256Hex(String(instruction))}`;
}

export function getReviewablePlanArtifacts(artifacts: PlanArtifact[]): PlanArtifact[] {
  const primaryCandidates = (artifacts || []).filter((artifact) => artifact.kind === "plan");
  if (primaryCandidates.length !== 1) return [];
  const artifact = primaryCandidates[0]!;
  const path = canonicalizePlanArtifactPath(artifact.path);
  if (path !== PRIMARY_PLAN_PATH || !String(artifact.content || "").trim()) return [];
  return [{ ...artifact, path }];
}

/**
 * Resolve the one artifact allowed to own a new Plan approval. Supporting
 * design/bugfix documents remain visible context, but cannot create, alter, or
 * invalidate the approval lease. Legacy Markdown remains readable for
 * migration/history and is deliberately excluded from new review authority.
 */
export function resolveTypedPlanReviewAuthority(
  artifacts: PlanArtifact[],
): TypedPlanReviewAuthorityResolution {
  const primaryCandidates = (artifacts || []).filter((artifact) => artifact.kind === "plan");
  if (primaryCandidates.length === 0) {
    return { ok: false, reason: "primary_plan_missing" };
  }
  if (primaryCandidates.length !== 1) {
    return { ok: false, reason: "primary_plan_ambiguous" };
  }

  const artifact = primaryCandidates[0]!;
  const path = canonicalizePlanArtifactPath(artifact.path);
  if (path !== PRIMARY_PLAN_PATH) {
    return { ok: false, reason: "primary_plan_path_invalid", path };
  }
  if (!String(artifact.content || "").trim()) {
    return { ok: false, reason: "primary_plan_content_missing", path };
  }

  const integrity = validatePlanArtifactCandidateIntegrity(artifact);
  if (!integrity.ok) {
    return {
      ok: false,
      reason: `primary_plan_integrity:${integrity.reason}`,
      path,
    };
  }
  if (integrity.mode !== "typed" || !artifact.candidate) {
    return { ok: false, reason: "primary_plan_not_typed", path };
  }
  return {
    ok: true,
    artifact: {
      ...artifact,
      path,
      candidate: artifact.candidate,
    },
  };
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
      artifact.candidate ? hashPlanCandidate(artifact.candidate) : "legacy-no-candidate",
      String(artifact.authoringContractId || artifact.candidate?.authoringContractId || ""),
    ].join("\u001f"))
    .join("\u001e");
  return {
    revision,
    artifactHash: `plan-sha256-${sha256Hex(canonical)}`,
    artifactPaths: reviewable.map((artifact) => artifact.path),
    artifactCount: reviewable.length,
  };
}

/** New-review identity. This is the authority shared by runtime handoff and UI. */
export function buildTypedPlanApprovalIdentity(
  artifacts: PlanArtifact[],
): PlanApprovalIdentity | null {
  const authority = resolveTypedPlanReviewAuthority(artifacts);
  if (!authority.ok) return null;
  return buildPlanApprovalIdentity([authority.artifact]);
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
