import type {
  RuntimeV2SubagentJob,
  TurnAggregateV1,
} from "../../lib/runtime-v2";
import type { RuntimeContextBudget } from "../../lib/runtimeContextBudget";
import type { RuntimeV2ModelContextEntry } from "./executionTypes";

const DEFAULT_PARENT_CONTEXT_CAPSULE_CHARS = 20_000;
const MAX_PARENT_CONTEXT_CAPSULE_CHARS = 160_000;
const MAX_PARENT_CONTEXT_ENTRY_CHARS = 64_000;

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

function parentContextCapacity(
  budget?: Pick<RuntimeContextBudget, "inputBudget">,
): {
  readonly capsuleChars: number;
  readonly entryChars: number;
} {
  const inputBudget = Math.max(
    0,
    Math.floor(Number(budget?.inputBudget) || 0),
  );
  const capsuleChars = inputBudget > 0
    ? Math.max(
        DEFAULT_PARENT_CONTEXT_CAPSULE_CHARS,
        Math.min(
          MAX_PARENT_CONTEXT_CAPSULE_CHARS,
          Math.floor(inputBudget * 2.5 * 0.35),
        ),
      )
    : DEFAULT_PARENT_CONTEXT_CAPSULE_CHARS;
  return {
    capsuleChars,
    entryChars: Math.max(
      8_000,
      Math.min(
        MAX_PARENT_CONTEXT_ENTRY_CHARS,
        Math.floor(capsuleChars * 0.6),
      ),
    ),
  };
}

function selectRelevantParentContext(input: {
  readonly entries: readonly RuntimeV2ModelContextEntry[];
  readonly allowedPaths: readonly string[];
  readonly capacityChars: number;
  readonly entryChars: number;
}): Array<RuntimeV2ModelContextEntry & { content: string }> {
  const relevant = input.entries.filter((entry) =>
    entryMatchesScope(entry, input.allowedPaths)
  );
  const selected: Array<
    RuntimeV2ModelContextEntry & { content: string }
  > = [];
  let retainedChars = 0;
  for (let index = relevant.length - 1; index >= 0; index -= 1) {
    const entry = relevant[index]!;
    const content = bounded(entry.content, input.entryChars);
    const estimatedChars =
      content.length +
      entry.id.length +
      entry.label.length +
      entry.target.length +
      160;
    if (
      selected.length > 0 &&
      retainedChars + estimatedChars > input.capacityChars
    ) {
      continue;
    }
    selected.unshift({ ...entry, content });
    retainedChars += estimatedChars;
  }
  return selected;
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
  readonly contextBudget?: Pick<RuntimeContextBudget, "inputBudget">;
}): string {
  const aggregate = input.aggregate;
  if (!aggregate) return "";
  const capacity = parentContextCapacity(input.contextBudget);
  const relevantContext = selectRelevantParentContext({
    entries: input.modelContext,
    allowedPaths: input.job.allowedPaths,
    capacityChars: Math.max(4_000, capacity.capsuleChars - 8_000),
    entryChars: capacity.entryChars,
  })
    .map((entry) => ({
      id: entry.id,
      source: entry.source,
      label: entry.label,
      target: entry.target,
      status: entry.status,
      content: entry.content,
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
  return bounded(
    JSON.stringify(capsule, null, 2),
    capacity.capsuleChars,
  );
}
