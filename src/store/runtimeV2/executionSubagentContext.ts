import type {
  RuntimeV2SubagentJob,
  TurnAggregateV1,
} from "../../lib/runtime-v2";
import type { RuntimeV2ModelContextEntry } from "./executionTypes";

const MAX_PARENT_CONTEXT_ENTRIES = 6;
const MAX_PARENT_CONTEXT_ENTRY_CHARS = 2_400;
const MAX_PARENT_CONTEXT_CAPSULE_CHARS = 20_000;

function normalizedPath(value: string): string {
  return value.trim()
    .replace(/^file:\/\//i, "")
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/")
    .replace(/^\.\//, "")
    .replace(/\/$/, "");
}

function pathsOverlap(left: string, right: string): boolean {
  const a = normalizedPath(left);
  const b = normalizedPath(right);
  if (!a || !b || a === "." || b === ".") return true;
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

function entryMatchesScope(
  entry: RuntimeV2ModelContextEntry,
  allowedPaths: readonly string[],
): boolean {
  if (
    entry.source === "workspace" ||
    entry.source === "plan" ||
    entry.source === "provider"
  ) {
    return true;
  }
  return allowedPaths.some((allowedPath) =>
    pathsOverlap(entry.target, allowedPath)
  );
}

function bounded(value: string, max: number): string {
  const text = String(value || "").trim();
  return text.length <= max
    ? text
    : `${text.slice(0, max)}\n...<parent-context-truncated>`;
}

function activeAuthority(aggregate: TurnAggregateV1): unknown {
  if (aggregate.executionContract?.status === "active") {
    return {
      kind: "execution_contract",
      id: aggregate.executionContract.id,
      revision: aggregate.executionContract.revision,
      criteria: aggregate.executionContract.criteria,
      changes: aggregate.executionContract.changes,
      validations: aggregate.executionContract.validations,
    };
  }
  if (
    aggregate.workPlan?.status === "approved" &&
    aggregate.sealedWorkPlan
  ) {
    return {
      kind: "approved_work_plan",
      id: aggregate.sealedWorkPlan.id,
      revision: aggregate.sealedWorkPlan.revision,
      objective: aggregate.sealedWorkPlan.draft.objective,
      steps: aggregate.sealedWorkPlan.draft.steps,
      validations: aggregate.sealedWorkPlan.draft.validations,
    };
  }
  return null;
}

/** Build a bounded handoff from durable parent facts. Inherited entries are
 * context only: they let a late child start at the current lifecycle boundary,
 * but never become child-owned evidence or satisfy the structured report gate.
 */
export function buildRuntimeV2SubagentContextCapsule(input: {
  readonly aggregate: TurnAggregateV1 | null;
  readonly job: RuntimeV2SubagentJob;
  readonly modelContext: readonly RuntimeV2ModelContextEntry[];
}): string {
  const aggregate = input.aggregate;
  if (!aggregate) return "";
  const relevantContext = input.modelContext
    .filter((entry) =>
      entryMatchesScope(entry, input.job.allowedPaths)
    )
    .slice(-MAX_PARENT_CONTEXT_ENTRIES)
    .map((entry) => ({
      id: entry.id,
      source: entry.source,
      label: entry.label,
      target: entry.target,
      status: entry.status,
      content: bounded(entry.content, MAX_PARENT_CONTEXT_ENTRY_CHARS),
    }));
  const capsule = {
    userObjective: aggregate.objective.text,
    acceptanceCriteria: aggregate.objective.acceptanceCriteria.map(
      (text, index) => ({
        id:
          aggregate.objective.acceptanceCriterionIds?.[index] ||
          `criterion-${index + 1}`,
        text,
      }),
    ),
    lifecyclePhase: aggregate.phase,
    authority: activeAuthority(aggregate),
    parentEvidenceCatalog: aggregate.evidence.slice(-32).map((evidence) => ({
      id: evidence.id,
      kind: evidence.kind,
      target: evidence.target,
      version: evidence.version,
    })),
    committedMutationTargets: [
      ...new Set(
        aggregate.evidence
          .filter((evidence) => evidence.kind === "mutation")
          .map((evidence) => evidence.target),
      ),
    ],
    relevantParentContext: relevantContext,
  };
  return bounded(JSON.stringify(capsule, null, 2), MAX_PARENT_CONTEXT_CAPSULE_CHARS);
}
