import type { ToolDefinition } from "../../lib/toolSchemas";
import type {
  RuntimeV2EvidenceReference,
  TurnAggregateV1,
} from "../../lib/runtime-v2";
import { workspacePathsReferToSameFile } from "../../lib/workspacePaths";
import { analyzeValidationCommand } from "../../lib/validationContract";
import { finiteValidationCommandRejection } from "./executionValidationCommand";

export const RECORD_RUNTIME_V2_EXECUTION_CONTRACT_TOOL_NAME =
  "record_execution_contract";

/** Contract schema repair is a state-bound protocol correction, not an
 * unbounded reasoning phase. Three complete rejected submissions are enough
 * to prove that the current model/request cannot establish safe mutation
 * authority for this Run. */
export const RUNTIME_V2_EXECUTION_CONTRACT_MAX_REPAIR_ATTEMPTS = 3;

export type RuntimeV2ExecutionContractOperation =
  | "modify"
  | "create"
  | "delete"
  | "preserve";

export interface RuntimeV2ExecutionContractChange {
  readonly operation: RuntimeV2ExecutionContractOperation;
  readonly targets: readonly string[];
  readonly change: string;
  readonly expectedOutcome: string;
}

export interface RuntimeV2ExecutionContractValidation {
  readonly kind:
    | "finite_command"
    | "browser"
    | "desktop"
    | "assertion";
  readonly command?: string;
  readonly expectedOutcome: string;
}

export interface RuntimeV2ExecutionContract {
  readonly schemaVersion: "runtime-v2-execution-contract.v1";
  readonly revision: number;
  readonly summary: string;
  readonly rootCauses: readonly string[];
  readonly changes: readonly RuntimeV2ExecutionContractChange[];
  readonly validations: readonly RuntimeV2ExecutionContractValidation[];
  readonly revisionReason: string | null;
  readonly sourceEvidenceIds: readonly string[];
  readonly recordedAtSequence: number;
}

export interface RuntimeV2ExecutionContractReadWindow {
  readonly supplementalReadBatches: number;
  readonly closed: boolean;
}

export interface RuntimeV2ExecutionContractRepair {
  readonly attempts: number;
  readonly latestSequence: number;
}

export const RECORD_RUNTIME_V2_EXECUTION_CONTRACT_TOOL: ToolDefinition = {
  type: "function",
  function: {
    name: RECORD_RUNTIME_V2_EXECUTION_CONTRACT_TOOL_NAME,
    description:
      "Record or revise the parent Execute implementation contract after reading exact source. This does not modify files. It binds proved causes, exact operations/targets, preserved boundaries, and finite acceptance checks so later parent or child mutations cannot drift outside the evidence-backed solution.",
    parameters: {
      type: "object",
      properties: {
        summary: {
          type: "string",
          description:
            "Concise complete solution connecting every user-visible symptom to the proved cause and intended repair.",
        },
        root_causes: {
          type: "array",
          minItems: 1,
          items: { type: "string" },
          description:
            "Evidence-backed causal findings. Do not list guesses or restate symptoms.",
        },
        changes: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            properties: {
              operation: {
                type: "string",
                enum: ["modify", "create", "delete", "preserve"],
              },
              targets: {
                type: "array",
                minItems: 1,
                items: { type: "string" },
                description:
                  "Every exact workspace-relative file owned by this change. Use preserve for an investigated owner that must remain unchanged.",
              },
              change: {
                type: "string",
                description:
                  "Concrete symbol/API/behavior change and the unrelated behavior it must preserve.",
              },
              expected_outcome: { type: "string" },
            },
            required: ["operation", "targets", "change", "expected_outcome"],
          },
        },
        validations: {
          type: "array",
          minItems: 1,
          description:
            "Static and behavioral checks. For a user-visible objective, build/lint/typecheck alone is invalid; include a real test/inline assertion or browser/desktop observation.",
          items: {
            type: "object",
            properties: {
              kind: {
                type: "string",
                enum: ["finite_command", "browser", "desktop", "assertion"],
              },
              command: {
                type: "string",
                description:
                  "For finite_command only: one bounded build, test, lint, typecheck, check, or inline assertion without shell wrappers.",
              },
              expected_outcome: {
                type: "string",
                description: "Observable pass condition tied to the user objective.",
              },
            },
            required: ["kind", "expected_outcome"],
          },
        },
        behavioral_validation: {
          description:
            "Runtime-required user-visible acceptance. This field becomes required in the advertised schema when the admitted objective has a behavioral or interaction acceptance floor.",
          anyOf: [{
            type: "object",
            properties: {
              kind: { type: "string", enum: ["finite_command"] },
              command: {
                type: "string",
                description:
                  "One finite test or inline assertion. Build, lint, typecheck, source inspection, services, and watchers are not behavioral evidence.",
              },
              expected_outcome: {
                type: "string",
                description:
                  "The observable assertion tied to the user's reported behavior.",
              },
            },
            required: ["kind", "command", "expected_outcome"],
          }, {
            type: "object",
            properties: {
              kind: { type: "string", enum: ["browser", "desktop"] },
              expected_outcome: {
                type: "string",
                description:
                  "The observable post-action result that proves the user's scenario.",
              },
            },
            required: ["kind", "expected_outcome"],
          }],
        },
        revision_reason: {
          type: "string",
          description:
            "Required when replacing an existing contract: name the new source or failed validation evidence that changes the solution or scope.",
        },
      },
      required: ["summary", "root_causes", "changes", "validations"],
    },
  },
};

function boundedString(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function normalizeTarget(value: unknown): string {
  const target = boundedString(value, 400)
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/\/+$/, "");
  if (
    !target ||
    target === "." ||
    target.startsWith("/") ||
    /^[A-Za-z]:\//.test(target) ||
    target.split("/").includes("..") ||
    /[\u0000-\u001f\u007f]/.test(target)
  ) {
    return "";
  }
  return target;
}

function stringArray(value: unknown, maxItems: number, maxChars: number): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(
    value
      .map((entry) => boundedString(entry, maxChars))
      .filter(Boolean),
  )].slice(0, maxItems);
}

function normalizeChanges(value: unknown): RuntimeV2ExecutionContractChange[] {
  if (!Array.isArray(value)) return [];
  const changes: RuntimeV2ExecutionContractChange[] = [];
  for (const entry of value.slice(0, 16)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const operation = boundedString(record.operation, 32);
    if (!["modify", "create", "delete", "preserve"].includes(operation)) {
      continue;
    }
    const targets = Array.isArray(record.targets)
      ? [...new Set(record.targets.map(normalizeTarget).filter(Boolean))]
        .slice(0, 12)
      : [];
    const change = boundedString(record.change, 2_000);
    const expectedOutcome = boundedString(
      record.expected_outcome ?? record.expectedOutcome,
      1_000,
    );
    if (targets.length === 0 || !change || !expectedOutcome) continue;
    changes.push({
      operation: operation as RuntimeV2ExecutionContractOperation,
      targets,
      change,
      expectedOutcome,
    });
  }
  return changes;
}

function normalizeValidations(
  value: unknown,
): RuntimeV2ExecutionContractValidation[] {
  if (!Array.isArray(value)) return [];
  const validations: RuntimeV2ExecutionContractValidation[] = [];
  for (const entry of value.slice(0, 8)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const kind = boundedString(record.kind, 32);
    if (!["finite_command", "browser", "desktop", "assertion"].includes(kind)) {
      continue;
    }
    const command = boundedString(record.command, 1_000);
    const expectedOutcome = boundedString(
      record.expected_outcome ?? record.expectedOutcome,
      1_000,
    );
    if (!expectedOutcome || (kind === "finite_command" && !command)) continue;
    validations.push({
      kind: kind as RuntimeV2ExecutionContractValidation["kind"],
      ...(command ? { command } : {}),
      expectedOutcome,
    });
  }
  return validations;
}

export function parseRuntimeV2ExecutionContractArguments(
  args: Readonly<Record<string, unknown>>,
): Omit<
  RuntimeV2ExecutionContract,
  "schemaVersion" | "revision" | "sourceEvidenceIds" | "recordedAtSequence"
> {
  const validations = normalizeValidations(args.validations);
  const behavioralValidationValue =
    args.behavioral_validation ?? args.behavioralValidation;
  const behavioralValidation = normalizeValidations(
    behavioralValidationValue
      ? [behavioralValidationValue]
      : [],
  );
  return {
    summary: boundedString(args.summary, 4_000),
    rootCauses: stringArray(args.root_causes ?? args.rootCauses, 12, 1_500),
    changes: normalizeChanges(args.changes),
    validations: [...validations, ...behavioralValidation].filter(
      (validation, index, all) => all.findIndex((candidate) =>
        candidate.kind === validation.kind &&
        candidate.command === validation.command &&
        candidate.expectedOutcome === validation.expectedOutcome
      ) === index,
    ),
    revisionReason:
      boundedString(args.revision_reason ?? args.revisionReason, 2_000) || null,
  };
}

function scheduledCommandsByKey(
  aggregate: TurnAggregateV1,
): ReadonlyMap<string, Extract<
  TurnAggregateV1["events"][number],
  { type: "command.scheduled" }
>["command"]> {
  return new Map(aggregate.events.flatMap((event) =>
    event.type === "command.scheduled"
      ? [[event.command.idempotencyKey, event.command] as const]
      : []
  ));
}

function versionedSourceEvidenceBefore(
  aggregate: TurnAggregateV1,
  sequence = Number.POSITIVE_INFINITY,
): RuntimeV2EvidenceReference[] {
  return aggregate.events
    .filter((event) => event.sequence < sequence)
    .flatMap((event) => {
      if (event.type === "observation.recorded") return [event.evidence];
      if (event.type === "tool.completed") return [...event.evidence];
      return [];
    })
    .filter((evidence) => evidence.kind === "source" && !!evidence.version);
}

export function deriveRuntimeV2ExecutionContract(
  aggregate: TurnAggregateV1 | null,
): RuntimeV2ExecutionContract | null {
  if (!aggregate) return null;
  const commands = scheduledCommandsByKey(aggregate);
  let contract: RuntimeV2ExecutionContract | null = null;
  let revision = 0;
  for (const event of aggregate.events) {
    if (event.type !== "tool.completed" || event.status !== "succeeded") continue;
    const command = commands.get(event.idempotencyKey);
    if (
      command?.kind !== "execute_tool" ||
      command.payload.toolName !== RECORD_RUNTIME_V2_EXECUTION_CONTRACT_TOOL_NAME
    ) {
      continue;
    }
    const args = command.payload.arguments &&
        typeof command.payload.arguments === "object" &&
        !Array.isArray(command.payload.arguments)
      ? command.payload.arguments as Record<string, unknown>
      : {};
    const parsed = parseRuntimeV2ExecutionContractArguments(args);
    revision += 1;
    const relevantTargets = parsed.changes.flatMap((change) => change.targets);
    const sourceEvidenceIds = versionedSourceEvidenceBefore(
      aggregate,
      event.sequence,
    ).filter((evidence) => relevantTargets.some((target) =>
      workspacePathsReferToSameFile(evidence.target, target)
    )).map((evidence) => evidence.id);
    contract = {
      schemaVersion: "runtime-v2-execution-contract.v1",
      revision,
      ...parsed,
      sourceEvidenceIds: [...new Set(sourceEvidenceIds)],
      recordedAtSequence: event.sequence,
    };
  }
  return contract;
}

/**
 * A malformed initial contract or revision is a closed protocol repair, not
 * a new inspect/edit decision. Keep the model on the contract tool until one
 * complete submission is accepted; otherwise a small schema mistake can
 * reopen broad reads and turn correction into another repository tour.
 */
export function deriveRuntimeV2ExecutionContractRepair(
  aggregate: TurnAggregateV1 | null,
): RuntimeV2ExecutionContractRepair | null {
  if (!aggregate) return null;
  const commands = scheduledCommandsByKey(aggregate);
  let attempts = 0;
  let latestSequence = 0;
  for (const event of aggregate.events) {
    if (event.type !== "tool.completed") continue;
    const command = commands.get(event.idempotencyKey);
    if (
      command?.kind !== "execute_tool" ||
      command.payload.toolName !==
        RECORD_RUNTIME_V2_EXECUTION_CONTRACT_TOOL_NAME
    ) {
      continue;
    }
    if (event.status === "succeeded") {
      attempts = 0;
      latestSequence = 0;
      continue;
    }
    attempts += 1;
    latestSequence = event.sequence;
  }
  return attempts > 0 ? { attempts, latestSequence } : null;
}

export function runtimeV2ExecutionContractRequired(
  aggregate: TurnAggregateV1 | null,
): boolean {
  if (
    !aggregate ||
    aggregate.strategy !== "execute" ||
    deriveRuntimeV2ExecutionContract(aggregate)
  ) {
    return false;
  }
  const mutationCommitted = aggregate.evidence.some((evidence) =>
    evidence.kind === "mutation"
  );
  if (mutationCommitted) return false;
  const targets = versionedSourceEvidenceBefore(aggregate)
    .map((evidence) => normalizeTarget(evidence.target))
    .filter(Boolean);
  const distinctTargets: string[] = [];
  for (const target of targets) {
    if (!distinctTargets.some((candidate) =>
      workspacePathsReferToSameFile(candidate, target)
    )) {
      distinctTargets.push(target);
    }
  }
  return distinctTargets.length >= 2;
}

/**
 * Once a direct Execute has enough independent source owners to require a
 * contract, permit at most two additional provider-selected source batches
 * for specifically missing causal edges. The following decision is
 * contract-only.
 * Counting provider batches rather than individual calls preserves genuine
 * parallel reads without turning plan formation into an unbounded repository
 * tour. The boundary is reconstructed from provider/tool ledger identities.
 */
export function runtimeV2ExecutionContractReadWindow(
  aggregate: TurnAggregateV1 | null,
): RuntimeV2ExecutionContractReadWindow {
  if (
    !aggregate ||
    !runtimeV2ExecutionContractRequired(aggregate)
  ) {
    return { supplementalReadBatches: 0, closed: false };
  }
  const commands = scheduledCommandsByKey(aggregate);
  const sourceTargetsByToolCallId = new Map<string, string[]>();
  for (const event of aggregate.events) {
    if (event.type !== "tool.completed" || event.status !== "succeeded") {
      continue;
    }
    const command = commands.get(event.idempotencyKey);
    const toolCallId = boundedString(command?.payload.toolCallId, 256);
    const targets = event.evidence
      .filter((evidence) => evidence.kind === "source" && !!evidence.version)
      .map((evidence) => normalizeTarget(evidence.target))
      .filter(Boolean);
    if (toolCallId && targets.length > 0) {
      sourceTargetsByToolCallId.set(toolCallId, targets);
    }
  }
  const distinctTargets: string[] = [];
  let thresholdProviderSequence: number | null = null;
  let supplementalReadBatches = 0;
  for (const event of aggregate.events) {
    if (event.type !== "provider.responded") continue;
    const batchTargets = event.result.toolCalls.flatMap((call) =>
      sourceTargetsByToolCallId.get(call.id) || []
    );
    if (batchTargets.length === 0) continue;
    if (thresholdProviderSequence !== null) {
      supplementalReadBatches += 1;
      continue;
    }
    for (const target of batchTargets) {
      if (!distinctTargets.some((candidate) =>
        workspacePathsReferToSameFile(candidate, target)
      )) {
        distinctTargets.push(target);
      }
    }
    if (distinctTargets.length >= 2) {
      thresholdProviderSequence = event.sequence;
    }
  }
  return {
    supplementalReadBatches,
    closed: supplementalReadBatches >= 2,
  };
}

export function validateRuntimeV2ExecutionContractSubmission(input: {
  readonly aggregate: TurnAggregateV1 | null;
  readonly args: Readonly<Record<string, unknown>>;
}): { readonly allowed: true; readonly contract: ReturnType<typeof parseRuntimeV2ExecutionContractArguments> } |
  { readonly allowed: false; readonly reason: string } {
  if (!input.aggregate || input.aggregate.strategy !== "execute") {
    return {
      allowed: false,
      reason: "EXECUTION_CONTRACT_REJECTED: only a direct Execute Run may record this contract.",
    };
  }
  const parsed = parseRuntimeV2ExecutionContractArguments(input.args);
  if (!parsed.summary || parsed.rootCauses.length === 0) {
    return {
      allowed: false,
      reason:
        "EXECUTION_CONTRACT_REJECTED: provide a concise complete summary and at least one evidence-backed root cause.",
    };
  }
  if (parsed.changes.length === 0 || parsed.validations.length === 0) {
    return {
      allowed: false,
      reason:
        "EXECUTION_CONTRACT_REJECTED: provide at least one concrete change/preserve entry and one finite or observable validation.",
    };
  }
  const invalidFiniteValidation = parsed.validations.find((validation) =>
    validation.kind === "finite_command" &&
    finiteValidationCommandRejection(validation.command)
  );
  if (invalidFiniteValidation) {
    const rejection = finiteValidationCommandRejection(
      invalidFiniteValidation.command,
    );
    return {
      allowed: false,
      reason: [
        "EXECUTION_CONTRACT_REJECTED: finite_command must be one bounded build, test, lint, typecheck, check, or failing inline assertion; services and observers are not acceptance checks.",
        rejection?.message || "The command has no finite validation exit status.",
      ].join(" "),
    };
  }
  const acceptanceRequirements =
    input.aggregate.objective?.acceptanceEvidenceRequirements || [];
  const hasInteractionValidation = parsed.validations.some((validation) =>
    validation.kind === "browser" || validation.kind === "desktop"
  );
  const hasBehavioralFiniteValidation = parsed.validations.some(
    (validation) => {
      if (validation.kind !== "finite_command" || !validation.command) {
        return false;
      }
      const analysis = analyzeValidationCommand(validation.command);
      const capability = analysis.spec?.kind === "finite_command"
        ? analysis.spec.capability
        : null;
      return capability === "test" || capability === "inline_assertion";
    },
  );
  if (
    acceptanceRequirements.includes("interaction") &&
    !hasInteractionValidation
  ) {
    return {
      allowed: false,
      reason:
        "EXECUTION_CONTRACT_REJECTED: the runtime-owned interaction acceptance floor requires a browser or desktop validation with an observable post-action result; a static command cannot replace it.",
    };
  }
  if (
    acceptanceRequirements.includes("behavioral") &&
    !hasInteractionValidation &&
    !hasBehavioralFiniteValidation
  ) {
    return {
      allowed: false,
      reason:
        "EXECUTION_CONTRACT_REJECTED: the runtime-owned behavioral acceptance floor requires a real test/inline assertion or browser/desktop validation; build, lint, and source inspection alone cannot prove the user-visible behavior.",
    };
  }
  const existing = deriveRuntimeV2ExecutionContract(input.aggregate);
  if (existing && !parsed.revisionReason) {
    return {
      allowed: false,
      reason:
        "EXECUTION_CONTRACT_REJECTED: a revision_reason naming the new evidence is required when replacing the current contract.",
    };
  }
  if (existing) {
    const commands = scheduledCommandsByKey(input.aggregate);
    const hasRevisionBasis = input.aggregate.events.some((event) =>
      event.sequence > existing.recordedAtSequence &&
      (
        (
          event.type === "tool.completed" &&
          (
            (
              event.status !== "succeeded" &&
              commands.get(event.idempotencyKey)?.payload.toolName !==
                RECORD_RUNTIME_V2_EXECUTION_CONTRACT_TOOL_NAME
            ) ||
            event.evidence.some((evidence) =>
              evidence.kind === "source" && !!evidence.version
            )
          )
        ) ||
        (event.type === "validation.completed" && !event.passed) ||
        (
          event.type === "subagent.completed" &&
          event.evidence.length > 0
        )
      )
    );
    if (!hasRevisionBasis) {
      return {
        allowed: false,
        reason:
          "EXECUTION_CONTRACT_REJECTED: the active contract cannot be churned without newer source, child, rejected-action, or failed-validation evidence.",
      };
    }
  }
  const sourceEvidence = versionedSourceEvidenceBefore(input.aggregate);
  const unreadTargets = parsed.changes
    .filter((change) => change.operation !== "create")
    .flatMap((change) => change.targets)
    .filter((target) => !sourceEvidence.some((evidence) =>
      workspacePathsReferToSameFile(evidence.target, target)
    ));
  if (unreadTargets.length > 0) {
    return {
      allowed: false,
      reason: [
        "EXECUTION_CONTRACT_REJECTED: every modify/delete/preserve target must have versioned source evidence before planning.",
        `Unread targets: ${[...new Set(unreadTargets)].join(", ")}.`,
      ].join(" "),
    };
  }
  const operationByTarget = new Map<string, RuntimeV2ExecutionContractOperation>();
  for (const change of parsed.changes) {
    for (const target of change.targets) {
      const prior = [...operationByTarget.entries()].find(([candidate]) =>
        workspacePathsReferToSameFile(candidate, target)
      );
      if (prior && prior[1] !== change.operation) {
        return {
          allowed: false,
          reason:
            `EXECUTION_CONTRACT_REJECTED: ${target} has conflicting ${prior[1]} and ${change.operation} operations.`,
        };
      }
      operationByTarget.set(target, change.operation);
    }
  }
  return { allowed: true, contract: parsed };
}

export function runtimeV2ExecutionContractMutationTargets(
  contract: RuntimeV2ExecutionContract | null,
): string[] {
  return contract
    ? [...new Set(contract.changes
        .filter((change) => change.operation !== "preserve")
        .flatMap((change) => change.targets))]
    : [];
}

export function runtimeV2ExecutionContractAllowsTargets(input: {
  readonly contract: RuntimeV2ExecutionContract | null;
  readonly targets: readonly string[];
}): boolean {
  if (!input.contract) return true;
  const allowed = runtimeV2ExecutionContractMutationTargets(input.contract);
  return input.targets.length > 0 && input.targets.every((target) =>
    allowed.some((candidate) => workspacePathsReferToSameFile(candidate, target))
  );
}

export function runtimeV2ExecutionContractAnchor(
  contract: RuntimeV2ExecutionContract | null,
): string {
  if (!contract) return "";
  return `[execution_contract_v1] ${JSON.stringify({
    revision: contract.revision,
    summary: contract.summary,
    rootCauses: contract.rootCauses,
    changes: contract.changes,
    validations: contract.validations,
    sourceEvidenceIds: contract.sourceEvidenceIds,
  })}`;
}
