import type { AgentMessage } from "../../lib/agentMessages";
import type {
  RuntimeV2SubagentJob,
  TurnAggregateV1,
} from "../../lib/runtime-v2";
import type { RuntimeContextBudget } from "../../lib/runtimeContextBudget";
import {
  RUNTIME_V2_CONTEXT_ANCHOR_PREFIX,
} from "./executionProviderAnchors";
import {
  buildRuntimeV2DecisionView,
  materializedRuntimeV2SourceCoverage,
} from "./executionProviderDecisionView";
import type {
  RuntimeV2ProviderEffectFacts,
} from "./executionProviderEffectFacts";

const DEFAULT_PARENT_CONTEXT_CAPSULE_CHARS = 20_000;

interface RuntimeV2ParentContextEntry {
  readonly id: string;
  readonly source: "workspace" | "plan" | "tool";
  readonly label: string;
  readonly target: string;
  readonly status: "succeeded";
  readonly content: string;
}

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

function messageText(message: AgentMessage): string {
  if (typeof message.content === "string") return message.content;
  return message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

function canonicalContextAnchors(
  messages: readonly AgentMessage[],
): RuntimeV2ParentContextEntry[] {
  return messages.flatMap((message) => {
    if (message.role !== "system") return [];
    const content = messageText(message);
    if (!content.startsWith(RUNTIME_V2_CONTEXT_ANCHOR_PREFIX)) return [];
    const firstLine = content.split(/\r?\n/, 1)[0] || "";
    const key = firstLine
      .slice(RUNTIME_V2_CONTEXT_ANCHOR_PREFIX.length)
      .replace(/\]$/, "")
      .trim();
    if (key !== "workspace-overview" && key !== "approved-work-plan") {
      return [];
    }
    return [{
      id: `context:${key}`,
      source: key === "workspace-overview" ? "workspace" : "plan",
      label: key,
      target: key === "workspace-overview"
        ? "workspace"
        : ".MAIN/workplan.json",
      status: "succeeded" as const,
      content,
    }];
  });
}

function canonicalSourceContext(input: {
  readonly messages: readonly AgentMessage[];
  readonly effectFacts?: RuntimeV2ProviderEffectFacts;
  readonly workspace: string;
  readonly allowedPaths: readonly string[];
}): RuntimeV2ParentContextEntry[] {
  const currentDecision = buildRuntimeV2DecisionView(
    input.messages,
    input.effectFacts,
  );
  return materializedRuntimeV2SourceCoverage(
    currentDecision,
    input.workspace,
    input.effectFacts,
  ).flatMap((coverage) => {
    if (
      !input.allowedPaths.some((allowedPath) =>
        pathsOverlap(coverage.target, allowedPath)
      )
    ) {
      return [];
    }
    return coverage.windows.map((window) => ({
      id:
        `source:${coverage.target}:${coverage.version}:${window.startLine}-${window.endLine}`,
      source: "tool" as const,
      label: "read_file",
      target: coverage.target,
      status: "succeeded" as const,
      content: [
        "READ_FILE_RESULT",
        `path: ${coverage.target}`,
        `contentVersion: ${coverage.version}`,
        `totalLines: ${coverage.totalLines}`,
        `returnedLines: ${window.startLine}-${window.endLine}`,
        `complete: ${coverage.complete}`,
        "---CONTENT START---",
        window.content,
        "---CONTENT END---",
      ].join("\n"),
    }));
  });
}

function parentContextCapacity(
  budget?: Pick<RuntimeContextBudget, "inputBudget">,
): number {
  const inputBudget = Math.max(
    0,
    Math.floor(Number(budget?.inputBudget) || 0),
  );
  return inputBudget > 0
    ? Math.max(
        DEFAULT_PARENT_CONTEXT_CAPSULE_CHARS,
        Math.floor(inputBudget * 2.5 * 0.35),
      )
    : DEFAULT_PARENT_CONTEXT_CAPSULE_CHARS;
}

function activeAuthority(aggregate: TurnAggregateV1): unknown {
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

/**
 * Build a child handoff from the one canonical parent transcript and durable
 * receipts. Exact source windows are inherited only when they still belong to
 * the current decision boundary and overlap the child's declared read scope.
 * Entries are admitted whole; an oversized source is omitted for an explicit
 * child read instead of being silently truncated into misleading code.
 */
export function buildRuntimeV2SubagentContextCapsule(input: {
  readonly aggregate: TurnAggregateV1 | null;
  readonly job: RuntimeV2SubagentJob;
  readonly messages: readonly AgentMessage[];
  readonly effectFacts?: RuntimeV2ProviderEffectFacts;
  readonly workspace?: string;
  readonly contextBudget?: Pick<RuntimeContextBudget, "inputBudget">;
}): string {
  const aggregate = input.aggregate;
  if (!aggregate) return "";
  const allowedEvidence = aggregate.evidence.filter((evidence) =>
    input.job.allowedPaths.some((path) =>
      pathsOverlap(evidence.target, path)
    )
  );
  const candidates = [
    ...canonicalContextAnchors(input.messages),
    ...canonicalSourceContext({
      messages: input.messages,
      effectFacts: input.effectFacts,
      workspace: input.workspace || "",
      allowedPaths: input.job.allowedPaths,
    }),
  ];
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
    parentEvidenceCatalog: allowedEvidence.slice(-32).map((evidence) => ({
      id: evidence.id,
      kind: evidence.kind,
      target: evidence.target,
      version: evidence.version,
    })),
    committedMutationTargets: [
      ...new Set(
        allowedEvidence
          .filter((evidence) => evidence.kind === "mutation")
          .map((evidence) => evidence.target),
      ),
    ],
    relevantParentContext: [] as RuntimeV2ParentContextEntry[],
    omittedParentContext: [] as string[],
  };
  const capacity = parentContextCapacity(input.contextBudget);
  for (const entry of candidates) {
    const next = {
      ...capsule,
      relevantParentContext: [...capsule.relevantParentContext, entry],
    };
    if (JSON.stringify(next).length <= capacity) {
      capsule.relevantParentContext.push(entry);
    } else {
      capsule.omittedParentContext.push(entry.id);
    }
  }
  return JSON.stringify(capsule, null, 2);
}
