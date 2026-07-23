import {
  buildPlanApprovalIdentity,
  buildTypedPlanApprovalIdentity,
  type PlanApprovalIdentity,
} from "./planApprovalIdentity";
import {
  derivePlanTasksFromCandidate,
  hashPlanCandidate,
  validateSealedPlanCandidate,
} from "./planContract";
import { sanitizePlanArtifactContent } from "./sanitize";
import {
  canonicalizePlanArtifactPath,
  detectPlanArtifactKind,
  extractPlanTasks,
  findDroppedPlanTasks,
  reconcilePlanTaskCompletion,
  validateActionablePlanArtifact,
  validatePlanArtifactContent,
  type PlanArtifact,
  type PlanExecutionEvidenceEntry,
  type PlanStage,
  type PlanTask,
} from "./workflowModels";

export interface PlanArtifactCommitState {
  artifacts: PlanArtifact[];
  tasks: PlanTask[];
  evidenceLedger: PlanExecutionEvidenceEntry[];
  isApproved: boolean;
  stage: PlanStage;
}

export type PlanArtifactCommitRejection =
  | {
      accepted: false;
      gate: "authority";
      canonicalPath: string;
      reason:
        | "implicit_legacy_plan_forbidden"
        | "mixed_typed_legacy_authority"
        | "typed_candidate_forbidden_for_kind"
        | "legacy_projection_forbidden_for_kind";
    }
  | {
      accepted: false;
      gate: "identity";
      canonicalPath: string;
    }
  | {
      accepted: false;
      gate: "typed_contract";
      canonicalPath: string;
      failures: string[];
      candidateHashMismatch: boolean;
      authoringContractMismatch: boolean;
    }
  | {
      accepted: false;
      gate: "quality";
      canonicalPath: string;
      reason: string | undefined;
      contentChars: number;
    };

export interface PlanArtifactCommitAccepted {
  accepted: true;
  canonicalPath: string;
  artifact: PlanArtifact;
  artifacts: PlanArtifact[];
  tasks: PlanTask[];
  droppedTasks: PlanTask[];
  /** Compatibility identity for lifecycle/history and existing execution leases. */
  artifactIdentity: PlanApprovalIdentity | null;
  /** Typed authority allowed to create or refresh a Plan review request. */
  reviewIdentity: PlanApprovalIdentity | null;
  ownsFreshTaskProjection: boolean;
  revisionAdvanced: boolean;
}

export type PlanArtifactCommitResult =
  | PlanArtifactCommitAccepted
  | PlanArtifactCommitRejection;

type TypedPlanArtifact = PlanArtifact & {
  kind: "plan";
  candidate: NonNullable<PlanArtifact["candidate"]>;
  candidateHash: string;
  authoringContractId: string;
  legacyTaskProjection?: never;
};

type LegacyImportedPlanArtifact = PlanArtifact & {
  kind: "plan";
  candidate?: undefined;
  candidateHash?: undefined;
  authoringContractId?: undefined;
  legacyTaskProjection: PlanTask[];
};

type SupportingPlanArtifact = PlanArtifact & {
  candidate?: undefined;
  candidateHash?: undefined;
  authoringContractId?: undefined;
  legacyTaskProjection?: undefined;
};

export type PreparedPlanArtifactCommit =
  | { protocol: "typed_plan"; artifact: TypedPlanArtifact }
  | { protocol: "legacy_import"; artifact: LegacyImportedPlanArtifact }
  | { protocol: "supporting_artifact"; artifact: SupportingPlanArtifact };

export type PreparePlanArtifactCommitResult =
  | { accepted: true; commit: PreparedPlanArtifactCommit }
  | PlanArtifactCommitRejection;

/**
 * The only raw-artifact adapter. New Plan writes must carry a complete typed
 * authority; pre-contract Markdown is accepted only through the explicit
 * hydration/migration marker. Supporting artifacts cannot smuggle candidate
 * or legacy task authority into the runtime graph.
 */
export function preparePlanArtifactCommit(
  artifact: PlanArtifact,
): PreparePlanArtifactCommitResult {
  const canonicalPath = canonicalizePlanArtifactPath(artifact.path);
  const hasCandidate = artifact.candidate !== undefined;
  const hasCandidateHash = typeof artifact.candidateHash === "string" && artifact.candidateHash.length > 0;
  const hasAuthoringContractId =
    typeof artifact.authoringContractId === "string" && artifact.authoringContractId.length > 0;
  const hasAnyTypedMetadata = hasCandidate || artifact.candidateHash !== undefined ||
    artifact.authoringContractId !== undefined;
  const hasLegacyProjection = artifact.legacyTaskProjection !== undefined;

  if (artifact.kind === "plan") {
    if (hasCandidate) {
      if (hasLegacyProjection) {
        return {
          accepted: false,
          gate: "authority",
          canonicalPath,
          reason: "mixed_typed_legacy_authority",
        };
      }
      const failures = [
        ...(!hasCandidateHash ? ["candidate_hash_missing"] : []),
        ...(!hasAuthoringContractId ? ["candidate_authoring_contract_missing"] : []),
      ];
      if (failures.length > 0) {
        return {
          accepted: false,
          gate: "typed_contract",
          canonicalPath,
          failures,
          candidateHashMismatch: false,
          authoringContractMismatch: false,
        };
      }
      return {
        accepted: true,
        commit: { protocol: "typed_plan", artifact: artifact as TypedPlanArtifact },
      };
    }
    if (hasAnyTypedMetadata) {
      return {
        accepted: false,
        gate: "typed_contract",
        canonicalPath,
        failures: ["candidate_payload_missing"],
        candidateHashMismatch: false,
        authoringContractMismatch: false,
      };
    }
    if (!hasLegacyProjection) {
      return {
        accepted: false,
        gate: "authority",
        canonicalPath,
        reason: "implicit_legacy_plan_forbidden",
      };
    }
    return {
      accepted: true,
      commit: { protocol: "legacy_import", artifact: artifact as LegacyImportedPlanArtifact },
    };
  }

  if (hasAnyTypedMetadata) {
    return {
      accepted: false,
      gate: "authority",
      canonicalPath,
      reason: "typed_candidate_forbidden_for_kind",
    };
  }
  if (hasLegacyProjection) {
    return {
      accepted: false,
      gate: "authority",
      canonicalPath,
      reason: "legacy_projection_forbidden_for_kind",
    };
  }
  return {
    accepted: true,
    commit: { protocol: "supporting_artifact", artifact: artifact as SupportingPlanArtifact },
  };
}

function planArtifactRevisionIdentity(artifact: PlanArtifact): string {
  return [
    artifact.kind,
    artifact.content,
    artifact.candidateHash || "",
    artifact.authoringContractId || "",
  ].join("\u001f");
}

/**
 * Provider-neutral, side-effect-free Plan artifact commit policy.
 *
 * Lifecycle ownership, approval invalidation, tool permission settlement, Run
 * cancellation, persistence and UI projection intentionally remain with the
 * caller. This reducer owns the artifact contract shared by global and
 * owner-scoped session entry points.
 */
export function reducePlanArtifactCommit(input: {
  state: PlanArtifactCommitState;
  commit: PreparedPlanArtifactCommit;
}): PlanArtifactCommitResult {
  const { state } = input;
  const { artifact } = input.commit;
  const canonicalPath = canonicalizePlanArtifactPath(artifact.path);
  const sanitizedContent = sanitizePlanArtifactContent(artifact.content);
  if (!canonicalPath || detectPlanArtifactKind(canonicalPath) !== artifact.kind) {
    return {
      accepted: false,
      gate: "identity",
      canonicalPath,
    };
  }

  const normalizedArtifact: PlanArtifact = {
    ...artifact,
    path: canonicalPath,
    content: sanitizedContent,
  };
  if (input.commit.protocol === "typed_plan") {
    const typedArtifact = input.commit.artifact;
    try {
      const failures = validateSealedPlanCandidate({
        candidate: typedArtifact.candidate,
        expectedContent: sanitizedContent,
      });
      const computedCandidateHash = hashPlanCandidate(typedArtifact.candidate);
      const candidateHashMismatch = typedArtifact.candidateHash !== computedCandidateHash;
      const authoringContractMismatch =
        typedArtifact.authoringContractId !== typedArtifact.candidate.authoringContractId;
      if (failures.length > 0 || candidateHashMismatch || authoringContractMismatch) {
        return {
          accepted: false,
          gate: "typed_contract",
          canonicalPath,
          failures,
          candidateHashMismatch,
          authoringContractMismatch,
        };
      }
      normalizedArtifact.candidateHash = computedCandidateHash;
      normalizedArtifact.authoringContractId = typedArtifact.candidate.authoringContractId;
    } catch {
      return {
        accepted: false,
        gate: "typed_contract",
        canonicalPath,
        failures: ["candidate_payload_malformed"],
        candidateHashMismatch: false,
        authoringContractMismatch: false,
      };
    }
  }

  // A sealed typed candidate already binds its exact review projection above.
  // Re-interpreting that projection with the legacy Markdown heuristics would
  // create a second authority capable of overruling the typed contract. Keep
  // those heuristics only at their compatibility boundary; supporting
  // artifacts continue to use their native content schema.
  if (input.commit.protocol !== "typed_plan") {
    const validation = input.commit.protocol === "legacy_import"
      ? validateActionablePlanArtifact(sanitizedContent)
      : validatePlanArtifactContent(sanitizedContent, artifact.kind);
    if (!validation.ok) {
      return {
        accepted: false,
        gate: "quality",
        canonicalPath,
        reason: validation.reason,
        contentChars: sanitizedContent.length,
      };
    }
  }

  const artifacts = [...state.artifacts];
  const currentMaxRevision = state.artifacts.reduce(
    (max, candidate) => Math.max(max, Number(candidate.revision) || 0),
    0,
  );
  const existingIndex = artifacts.findIndex(
    (item) => canonicalizePlanArtifactPath(item.path) === canonicalPath,
  );
  let revisionAdvanced = true;
  if (existingIndex >= 0) {
    const existingArtifact = artifacts[existingIndex];
    revisionAdvanced =
      planArtifactRevisionIdentity(existingArtifact) !==
      planArtifactRevisionIdentity(normalizedArtifact);
    normalizedArtifact.revision = revisionAdvanced
      ? Math.max(1, currentMaxRevision + 1)
      : Math.max(
          1,
          Number(existingArtifact.revision) || Number(artifact.revision) || 1,
        );
    artifacts[existingIndex] = normalizedArtifact;
  } else {
    normalizedArtifact.revision = Math.max(1, currentMaxRevision + 1);
    artifacts.push(normalizedArtifact);
  }

  const typedCandidateTasks = input.commit.protocol === "typed_plan"
    ? derivePlanTasksFromCandidate(input.commit.artifact.candidate)
    : [];
  const ownsFreshTaskProjection =
    typedCandidateTasks.length > 0 || artifact.kind === "tasks" || artifact.kind === "bugfix";
  const projectedTasks = typedCandidateTasks.length > 0
    ? typedCandidateTasks
    : artifact.kind === "tasks" || artifact.kind === "bugfix"
      ? extractPlanTasks(sanitizedContent)
      : state.tasks;
  const preserveTaskHistory =
    state.isApproved ||
    state.stage === "executing" ||
    state.stage === "completed" ||
    state.tasks.length > 0;
  const droppedTasks = ownsFreshTaskProjection
    ? findDroppedPlanTasks(state.tasks, projectedTasks)
    : [];
  const tasks = ownsFreshTaskProjection
    ? reconcilePlanTaskCompletion(state.tasks, projectedTasks, state.evidenceLedger, {
        preserveMissing: preserveTaskHistory,
        highlightNext: state.isApproved && state.evidenceLedger.length > 0,
      })
    : reconcilePlanTaskCompletion([], state.tasks, state.evidenceLedger, {
        preserveMissing: false,
        highlightNext: state.isApproved && state.evidenceLedger.length > 0,
      });
  const sortedArtifacts = artifacts.sort((left, right) => left.updatedAt - right.updatedAt);

  return {
    accepted: true,
    canonicalPath,
    artifact: normalizedArtifact,
    artifacts: sortedArtifacts,
    tasks,
    droppedTasks,
    artifactIdentity: buildPlanApprovalIdentity(sortedArtifacts),
    reviewIdentity: buildTypedPlanApprovalIdentity(sortedArtifacts),
    ownsFreshTaskProjection,
    revisionAdvanced,
  };
}
