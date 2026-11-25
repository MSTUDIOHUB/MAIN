import { readFileWindow } from "../../lib/ipc";
import {
  isRuntimeV2FileVersion,
  normalizeRuntimeV2Checkpoint,
  type RuntimeV2EvidenceReference,
  type RuntimeV2RunIdentity,
  type WorkPlanRuntimeEvidence,
} from "../../lib/runtime-v2";
import { normalizeValidationWorkspaceCwd } from "../../lib/validationContract";
import { isEphemeralPlanArtifactPath } from "../../lib/workflowModels";
import { nextEvidenceId } from "./executionEvidence";
import type { RuntimeV2LiveExecutionState } from "./executionTypes";

export interface CarriedSessionSourceCandidate {
  readonly target: string;
  readonly version: string;
}

const DEFAULT_CARRYOVER_MAX_FILES = 48;

export function canonicalCarryoverSha256Version(raw: unknown): string | null {
  const value = String(raw || "").trim().toLowerCase();
  if (!value || value.startsWith("deleted")) return null;
  if (/^sha256-[a-f0-9]{64}$/.test(value)) return value;
  if (/^[a-f0-9]{64}$/.test(value)) return `sha256-${value}`;
  return null;
}

function recordCandidateVersion(
  latestByTarget: Map<string, string>,
  workspaceKey: string,
  evidence: RuntimeV2EvidenceReference,
): void {
  if (evidence.kind !== "source" && evidence.kind !== "mutation") return;
  const target = normalizeValidationWorkspaceCwd(evidence.target, workspaceKey);
  if (
    !target ||
    target === "." ||
    isEphemeralPlanArtifactPath(target) ||
    target.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase().startsWith(".main/plans/")
  ) return;
  if (String(evidence.version || "").trim().toLowerCase().startsWith("deleted")) {
    latestByTarget.delete(target);
    return;
  }
  if (!isRuntimeV2FileVersion(evidence.version)) return;
  const canonical = canonicalCarryoverSha256Version(evidence.version);
  if (!canonical) return;
  latestByTarget.delete(target);
  latestByTarget.set(target, canonical);
}

/** Collect latest SHA-256 file versions observed or written in earlier closed
 * turns of the same session & workspace so follow-up turns do not start blind. */
export function collectPriorSessionVersionedSources(input: {
  readonly state: any;
  readonly sessionKey: string;
  readonly workspaceKey: string;
  readonly excludeTurnId: string;
  readonly maxFiles?: number;
}): readonly CarriedSessionSourceCandidate[] {
  const sessionKey = String(input.sessionKey || "").trim();
  const workspaceKey = String(input.workspaceKey || "").trim();
  const checkpoints = input.state?.runtimeV2Checkpoints;
  if (!sessionKey || !workspaceKey || !checkpoints || typeof checkpoints !== "object") {
    return [];
  }
  const normalizedCheckpoints = Object.entries(checkpoints as Record<string, unknown>)
    .map(([turnId, raw]) =>
      normalizeRuntimeV2Checkpoint(raw, { sessionKey, turnId }),
    )
    .filter((cp): cp is NonNullable<typeof cp> =>
      Boolean(
        cp &&
        cp.owner.turnId !== input.excludeTurnId &&
        cp.owner.workspaceKey === workspaceKey &&
        cp.aggregate.terminalOutcome,
      ),
    )
    .sort((left, right) => {
      const timeDiff =
        (left.updatedAt || left.aggregate.updatedAt || 0) -
        (right.updatedAt || right.aggregate.updatedAt || 0);
      return timeDiff !== 0 ? timeDiff : left.owner.turnId.localeCompare(right.owner.turnId);
    });

  const latestByTarget = new Map<string, string>();
  for (const cp of normalizedCheckpoints) {
    let sawEventEvidence = false;
    for (const event of cp.aggregate.events) {
      if (event.type === "observation.recorded") {
        sawEventEvidence = true;
        recordCandidateVersion(latestByTarget, workspaceKey, event.evidence);
      } else if (
        (event.type === "tool.completed" && event.status === "succeeded") ||
        (event.type === "subagent.completed" && event.status === "completed")
      ) {
        sawEventEvidence = true;
        for (const evidence of event.evidence) {
          recordCandidateVersion(latestByTarget, workspaceKey, evidence);
        }
      }
    }
    if (!sawEventEvidence) {
      for (const evidence of cp.aggregate.evidence || []) {
        recordCandidateVersion(latestByTarget, workspaceKey, evidence);
      }
    }
  }

  const limit = Math.max(1, input.maxFiles ?? DEFAULT_CARRYOVER_MAX_FILES);
  return [...latestByTarget.entries()]
    .slice(-limit)
    .map(([target, version]) => ({ target, version }));
}

export async function defaultReadWorkspaceFileVersion(
  target: string,
  workspaceKey: string,
): Promise<string | null> {
  try {
    const windowResult = await readFileWindow(target, workspaceKey, 1, 1, 1, 1);
    return canonicalCarryoverSha256Version(windowResult?.contentVersion);
  } catch {
    return null;
  }
}

/** Verify each candidate on disk and admit unchanged files as versioned source
 * observations. Unchanged files satisfy execution-contract & delegation checks,
 * while parent direct line-edits still enforce live window coverage. */
export async function admitReverifiedSessionSources(input: {
  readonly candidates: readonly CarriedSessionSourceCandidate[];
  readonly workspaceKey: string;
  readonly readFileVersion?: (target: string, workspaceKey: string) => Promise<string | null>;
  readonly recordObservation: (evidence: {
    readonly id: string;
    readonly kind: "source";
    readonly target: string;
    readonly version: string;
  }) => Promise<unknown>;
  readonly nextEvidenceId: () => string;
  readonly signal?: AbortSignal;
}): Promise<{ readonly admittedCount: number; readonly skippedStaleCount: number }> {
  if (!input.workspaceKey || input.candidates.length === 0) {
    return { admittedCount: 0, skippedStaleCount: 0 };
  }
  const readVersion = input.readFileVersion || defaultReadWorkspaceFileVersion;
  let admittedCount = 0;
  let skippedStaleCount = 0;
  const verified = await Promise.all(
    input.candidates.map(async (candidate) => {
      if (input.signal?.aborted) return null;
      const diskVersion = await readVersion(candidate.target, input.workspaceKey);
      return { candidate, matched: diskVersion !== null && diskVersion === candidate.version };
    }),
  );
  input.signal?.throwIfAborted();
  for (const entry of verified) {
    if (!entry) continue;
    if (!entry.matched) {
      skippedStaleCount += 1;
      continue;
    }
    input.signal?.throwIfAborted();
    await input.recordObservation({
      id: input.nextEvidenceId(),
      kind: "source",
      target: entry.candidate.target,
      version: entry.candidate.version,
    });
    admittedCount += 1;
  }
  return { admittedCount, skippedStaleCount };
}

export async function carryOverPriorSessionSources(input: {
  readonly state: any;
  readonly sessionKey: string;
  readonly workspaceKey: string;
  readonly turnId: string;
  readonly runId: string;
  readonly signal?: AbortSignal;
  readonly readFileVersion?: (target: string, workspaceKey: string) => Promise<string | null>;
  readonly recordObservation: (evidence: {
    readonly id: string;
    readonly kind: "source";
    readonly target: string;
    readonly version: string;
  }) => Promise<unknown>;
  readonly nextEvidenceId: () => string;
  readonly logStoreEvent?: (event: string, data?: Record<string, unknown>) => void;
}): Promise<{ readonly admittedCount: number; readonly skippedStaleCount: number }> {
  const candidates = collectPriorSessionVersionedSources({
    state: input.state,
    sessionKey: input.sessionKey,
    workspaceKey: input.workspaceKey,
    excludeTurnId: input.turnId,
  });
  if (candidates.length === 0) return { admittedCount: 0, skippedStaleCount: 0 };
  const result = await admitReverifiedSessionSources({
    candidates,
    workspaceKey: input.workspaceKey,
    readFileVersion: input.readFileVersion,
    recordObservation: input.recordObservation,
    nextEvidenceId: input.nextEvidenceId,
    signal: input.signal,
  });
  input.logStoreEvent?.("runtime_v2_session_sources_carried_over", {
    turnId: input.turnId,
    runId: input.runId,
    candidateCount: candidates.length,
    admittedCount: result.admittedCount,
    skippedStaleCount: result.skippedStaleCount,
  });
  return result;
}

export async function admitExecuteSessionSourceCarryover(input: {
  readonly state: any;
  readonly sessionKey: string;
  readonly workspaceKey: string;
  readonly turnId: string;
  readonly runId: string;
  readonly capabilityRestrictions?: readonly string[];
  readonly approvalRequiredCapabilities?: readonly string[];
  readonly live: RuntimeV2LiveExecutionState;
  readonly signal?: AbortSignal;
  readonly recordObservation: (evidence: {
    readonly id: string;
    readonly kind: "source";
    readonly target: string;
    readonly version: string;
  }) => Promise<unknown>;
  readonly logStoreEvent?: (event: string, data?: Record<string, unknown>) => void;
}): Promise<{ readonly admittedCount: number; readonly skippedStaleCount: number }> {
  if (
    !input.workspaceKey ||
    input.capabilityRestrictions?.includes("workspace_read") ||
    input.approvalRequiredCapabilities?.includes("workspace_read")
  ) {
    return { admittedCount: 0, skippedStaleCount: 0 };
  }
  return carryOverPriorSessionSources({
    state: input.state,
    sessionKey: input.sessionKey,
    workspaceKey: input.workspaceKey,
    turnId: input.turnId,
    runId: input.runId,
    signal: input.signal,
    recordObservation: input.recordObservation,
    nextEvidenceId: () => nextEvidenceId(input.live),
    logStoreEvent: input.logStoreEvent,
  });
}

export async function admitPlanSessionSourceCarryover(input: {
  readonly state: any;
  readonly run: RuntimeV2RunIdentity;
  readonly workspaceKey: string;
  readonly ledger: { readonly append: (event: any) => Promise<unknown> };
  readonly evidence: WorkPlanRuntimeEvidence[];
  readonly evidenceContents: Map<string, string>;
  readonly signal?: AbortSignal;
  readonly logStoreEvent?: (event: string, data?: Record<string, unknown>) => void;
}): Promise<{ readonly admittedCount: number; readonly skippedStaleCount: number }> {
  const nextPlanEvidenceId = (): string => {
    const maxIndex = input.evidence.reduce(
      (max, entry) => Math.max(max, /^E\d+$/.test(entry.id) ? Number(entry.id.slice(1)) : 0),
      0,
    );
    return `E${maxIndex + 1}`;
  };
  return carryOverPriorSessionSources({
    state: input.state,
    sessionKey: input.run.sessionKey,
    workspaceKey: input.workspaceKey,
    turnId: input.run.turnId,
    runId: input.run.runId,
    signal: input.signal,
    nextEvidenceId: nextPlanEvidenceId,
    recordObservation: async (evidence) => {
      const marker = `[carried-over] ${evidence.target} (${evidence.version}) verified unchanged on disk from earlier session turn.`;
      input.evidence.push({
        id: evidence.id,
        target: evidence.target,
        version: evidence.version,
        statement: `已跨轮复核 ${evidence.target} 的当前文件内容未变化。`,
      });
      input.evidenceContents.set(evidence.id, marker);
      await input.ledger.append({
        type: "observation.recorded",
        run: input.run,
        modelContent: marker,
        evidence,
      });
    },
    logStoreEvent: input.logStoreEvent,
  });
}
