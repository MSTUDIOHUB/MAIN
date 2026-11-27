import { workspacePathsReferToSameFile } from "../workspacePaths";
import { sha256Hex } from "../sha256";
import type {
  RuntimeV2ExecutionValidationAuthority,
  RuntimeV2Objective,
  RuntimeV2ValidatedMutationVersion,
} from "./contracts";
import { approvedRuntimeV2PlanContinuation } from "./planContinuationBaseline";
import { normalizeValidationWorkspaceCwd } from "../validationContract";
import { isWorkspaceMutationToolCall } from "../workspaceMutationTools";
import type { RuntimeV2Event } from "./events";

export interface RuntimeV2ValidationBoundary {
  /** Latest mutation anywhere in the Turn when validation began. */
  readonly mutationBoundarySequence: number;
  /** Latest mutation for every target claimed by this validator. */
  readonly validatedMutationVersions:
    readonly RuntimeV2ValidatedMutationVersion[];
}

interface RuntimeV2ValidationBoundaryAggregate {
  readonly events: readonly RuntimeV2Event[];
  readonly turn?: { readonly workspaceKey: string };
}

export function isRuntimeV2FileVersion(version: string | null): boolean {
  return !!version && /^(?:(?:sha256-)?[a-f0-9]{64}|deleted(?::.+)?)$/.test(version);
}

type WorkspaceChangeReceipt = Extract<RuntimeV2Event, { type: "tool.completed" | "subagent.completed" }>;
const mutationReceiptsByLedger = new WeakMap<readonly RuntimeV2Event[], readonly WorkspaceChangeReceipt[]>();

/** Only a settled workspace write, or an admitted child writeback, contributes
 * file changes. Old ledgers may have used `mutation` for unrelated MCP calls. */
export function runtimeV2WorkspaceChangeReceipts(aggregate: RuntimeV2ValidationBoundaryAggregate): readonly WorkspaceChangeReceipt[] {
  const cached = mutationReceiptsByLedger.get(aggregate.events);
  if (cached) return cached;
  const scheduledTools = new Set<string>();
  const scheduledWrites = new Set<string>();
  const receipts: WorkspaceChangeReceipt[] = [];
  for (const event of aggregate.events) {
    if (event.type === "command.scheduled" && event.command.kind === "execute_tool" && event.command.payload.runtimeOwnedPlanArtifact !== true) {
      scheduledTools.add(event.command.idempotencyKey);
      if (isWorkspaceMutationToolCall(String(event.command.payload.toolName || ""), event.command.payload.arguments as Record<string, unknown> || {})) {
        scheduledWrites.add(event.command.idempotencyKey);
      }
    }
    const parentWrite = event.type === "tool.completed" && event.status === "succeeded" &&
      event.receiptOrigin !== "replayed" && scheduledTools.has(event.idempotencyKey) && (event.effectKind === "workspace_change" ||
        event.effectKind === undefined && scheduledWrites.has(event.idempotencyKey));
    if (!parentWrite && !(event.type === "subagent.completed" && event.status === "completed")) continue;
    if (event.type === "tool.completed" && event.effectKind === "workspace_change" &&
        event.evidence.some(evidence => evidence.kind === "mutation" && !isRuntimeV2FileVersion(evidence.version))) continue;
    if (event.evidence.some(evidence => evidence.kind === "mutation")) receipts.push(event);
  }
  mutationReceiptsByLedger.set(aggregate.events, receipts);
  return receipts;
}

export function latestRuntimeV2WorkspaceChange(aggregate: RuntimeV2ValidationBoundaryAggregate): WorkspaceChangeReceipt | undefined {
  const receipts = runtimeV2WorkspaceChangeReceipts(aggregate);
  return receipts[receipts.length - 1];
}

export interface RuntimeV2WorkspaceNetChange {
  readonly target: string;
  readonly beforeVersion: string | null | undefined;
  readonly version: string | null;
  readonly status: "created" | "modified" | "deleted" | "unchanged" | "unverified";
}

const workspaceNetChangesByLedger = new WeakMap<readonly RuntimeV2Event[], {
  workspaceKey?: string;
  changes: readonly RuntimeV2WorkspaceNetChange[];
}>();

function comparableMutationVersion(version: string | null | undefined): string | null | undefined {
  if (version?.startsWith("deleted:")) return "deleted";
  return version && /^[a-f0-9]{64}$/.test(version) ? `sha256-${version}` : version;
}

/** Keep effects and delivery separate. A restored byte version or create/delete
 * pair still invalidates old validation, but delivers no changed path. */
export function deriveRuntimeV2WorkspaceNetChanges(
  aggregate: RuntimeV2ValidationBoundaryAggregate,
  afterSequence = -1,
): readonly RuntimeV2WorkspaceNetChange[] {
  const workspaceKey = aggregate.turn?.workspaceKey;
  const cached = afterSequence === -1 ? workspaceNetChangesByLedger.get(aggregate.events) : undefined;
  if (cached && cached.workspaceKey === workspaceKey) return cached.changes;
  const changes = new Map<string, {
    beforeVersion: string | null | undefined;
    version: string | null;
    discontinuous: boolean;
  }>();
  const key = (target: string) => normalizeValidationWorkspaceCwd(target, workspaceKey);
  const writes = new Set(runtimeV2WorkspaceChangeReceipts(aggregate));
  for (const receipt of aggregate.events) {
    if (receipt.sequence <= afterSequence) continue;
    if (receipt.type === "tool.completed" && receipt.presentation?.toolName === "run_command") {
      for (const observed of receipt.observedWorkspaceRemovals || []) {
        const path = key(observed.target);
        if (!path) continue;
        const prior = changes.get(path);
        if (prior && prior.beforeVersion === "deleted" && prior.version === comparableMutationVersion(observed.priorMutationVersion)) {
          changes.set(path, { ...prior, version: "deleted" });
        }
      }
    }
    if (receipt.type !== "tool.completed" && receipt.type !== "subagent.completed" || !writes.has(receipt)) continue;
    for (const evidence of receipt.evidence) {
      if (evidence.kind !== "mutation") continue;
      const path = key(evidence.target);
      if (!path || path === ".") continue;
      const created = receipt.type === "tool.completed" && receipt.mutationRequests?.some(
        request => request.operation === "create" && key(request.target) === path,
      );
      const previous = comparableMutationVersion(evidence.previousVersion ?? (created ? "deleted" : evidence.previousVersion));
      const version = comparableMutationVersion(evidence.version) ?? null;
      const prior = changes.get(path);
      changes.set(path, {
        beforeVersion: prior ? prior.beforeVersion : previous,
        version,
        discontinuous: Boolean(prior?.discontinuous || prior && previous &&
          previous !== prior.version && !(previous === "present" && prior.version !== "deleted")),
      });
    }
  }
  const net: RuntimeV2WorkspaceNetChange[] = [...changes].map(([target, { beforeVersion, version, discontinuous }]) => ({
    target, beforeVersion, version,
    status: discontinuous || beforeVersion === null || version === null ? "unverified"
      : beforeVersion === version ? "unchanged"
      : version === "deleted" ? "deleted"
      : beforeVersion === "deleted" ? "created"
      : "modified",
  }));
  if (afterSequence === -1) workspaceNetChangesByLedger.set(aggregate.events, { workspaceKey, changes: net });
  return net;
}

export function runtimeV2DeliveredWorkspacePaths(
  aggregate: RuntimeV2ValidationBoundaryAggregate,
  afterSequence = -1,
): readonly string[] {
  return deriveRuntimeV2WorkspaceNetChanges(aggregate, afterSequence).flatMap(change =>
    change.status === "unchanged" || change.status === "unverified" ? [] : [change.target]);
}

function uniqueTargets(targets: readonly string[]): readonly string[] {
  const unique: string[] = [];
  for (const target of targets) {
    const candidate = String(target || "").trim();
    if (
      candidate &&
      !unique.some((existing) =>
        workspacePathsReferToSameFile(existing, candidate)
      )
    ) {
      unique.push(candidate);
    }
  }
  return unique;
}

export function runtimeV2DirectExecuteCriterionIds(
  objective: RuntimeV2Objective,
): readonly string[] {
  const supplied = objective.acceptanceCriterionIds || [];
  return objective.acceptanceCriteria.map((_, index) =>
    String(supplied[index] || "").trim() || `criterion-${index + 1}`
  );
}

export function runtimeV2DirectExecuteMutationTargets(
  aggregate: RuntimeV2ValidationBoundaryAggregate,
): readonly string[] {
  return runtimeV2DeliveredWorkspacePaths(aggregate);
}

export function runtimeV2DirectExecuteAuthorityDigest(input: {
  readonly turnId: string;
  readonly objective: RuntimeV2Objective;
}): string {
  return sha256Hex(JSON.stringify({
    turnId: input.turnId,
    objective: input.objective.text,
    criteria: input.objective.acceptanceCriteria.map((text, index) => ({
      id: runtimeV2DirectExecuteCriterionIds(input.objective)[index],
      text,
      evidenceRequirement:
        input.objective.acceptanceEvidenceRequirements?.[index] || null,
    })),
  }));
}

/**
 * Bind a direct Execute validator to the complete runtime-owned acceptance
 * scope at the current mutation boundary. The provider chooses the validator,
 * but it cannot omit a criterion or mutation target from the resulting
 * receipt.
 */
export function resolveRuntimeV2DirectExecuteValidationAuthority(input: {
  readonly aggregate: RuntimeV2ValidationBoundaryAggregate;
  readonly turnId: string;
  readonly objective: RuntimeV2Objective;
  readonly validationId: string;
}): RuntimeV2ExecutionValidationAuthority | null {
  const admittedCriteria = runtimeV2DirectExecuteCriterionIds(
    input.objective,
  );
  const mutationTargets = runtimeV2DirectExecuteMutationTargets(
    input.aggregate,
  );
  if (
    !input.validationId.trim() ||
    admittedCriteria.length === 0 ||
    mutationTargets.length === 0
  ) {
    return null;
  }
  return {
    kind: "direct_execute",
    id: input.turnId,
    revision: 1,
    digest: runtimeV2DirectExecuteAuthorityDigest({
      turnId: input.turnId,
      objective: input.objective,
    }),
    validationId: input.validationId,
    criterionIds: admittedCriteria,
    targetPaths: mutationTargets,
  };
}

export function deriveRuntimeV2ValidationBoundary(
  aggregate: RuntimeV2ValidationBoundaryAggregate,
  targetPaths: readonly string[],
): RuntimeV2ValidationBoundary {
  const mutations = runtimeV2WorkspaceChangeReceipts(aggregate);
  const baseline = approvedRuntimeV2PlanContinuation(aggregate.events);
  const validatedMutationVersions = uniqueTargets(targetPaths)
    .map((target): RuntimeV2ValidatedMutationVersion | null => {
      for (let index = mutations.length - 1; index >= 0; index -= 1) {
        const event = mutations[index]!;
        const evidence = [...event.evidence].reverse().find((entry) =>
          entry.kind === "mutation" &&
          workspacePathsReferToSameFile(entry.target, target)
        );
        if (evidence) {
          return {
            target,
            mutationEvidenceId: evidence.id,
            mutationSequence: event.sequence,
            version: evidence.version,
          };
        }
      }
      const workspace = baseline?.continuation.source.turn.workspaceKey;
      const path = normalizeValidationWorkspaceCwd(target, workspace);
      const carried = path && baseline?.continuation.carriedTargets.find(item =>
        normalizeValidationWorkspaceCwd(item.target, workspace) === path);
      return carried && baseline ? {
        target,
        mutationEvidenceId: `continued:${baseline.continuation.source.turn.turnId}:${carried.receiptId}`,
        mutationSequence: baseline.sequence,
        version: carried.version,
      } : null;
    })
    .filter(
      (entry): entry is RuntimeV2ValidatedMutationVersion => entry !== null,
    );
  return {
    mutationBoundarySequence: mutations.reduce(
      (latest, event) => Math.max(latest, event.sequence),
      baseline?.sequence ?? 0,
    ),
    validatedMutationVersions,
  };
}

export function runtimeV2ValidationBoundaryMatchesCurrent(input: {
  readonly aggregate: RuntimeV2ValidationBoundaryAggregate;
  readonly targetPaths: readonly string[];
  readonly mutationBoundarySequence: number | undefined;
  readonly validatedMutationVersions:
    | readonly RuntimeV2ValidatedMutationVersion[]
    | undefined;
}): boolean {
  const expected = deriveRuntimeV2ValidationBoundary(
    input.aggregate,
    input.targetPaths,
  );
  const supplied = input.validatedMutationVersions || [];
  const targets = uniqueTargets(input.targetPaths);
  if (
    !Number.isInteger(input.mutationBoundarySequence) ||
    input.mutationBoundarySequence !== expected.mutationBoundarySequence ||
    expected.validatedMutationVersions.length !== targets.length ||
    supplied.length !== expected.validatedMutationVersions.length
  ) {
    return false;
  }
  return expected.validatedMutationVersions.every((current) =>
    supplied.some((candidate) =>
      workspacePathsReferToSameFile(candidate.target, current.target) &&
      candidate.mutationEvidenceId === current.mutationEvidenceId &&
      candidate.mutationSequence === current.mutationSequence &&
      candidate.version === current.version
    )
  );
}
