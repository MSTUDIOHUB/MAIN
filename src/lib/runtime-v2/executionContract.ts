import type { TurnAggregateV1 } from "./aggregate";
import type { RuntimeV2EvidenceReference } from "./contracts";
import { workspacePathsReferToSameFile } from "../workspacePaths";

export const RECORD_RUNTIME_V2_EXECUTION_CONTRACT_TOOL_NAME =
  "record_execution_contract";

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

export function scheduledCommandsByKey(
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

export function versionedSourceEvidenceBefore(
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

export function runtimeV2ExecutionContractMutationTargets(
  contract: RuntimeV2ExecutionContract | null,
): string[] {
  return contract
    ? [...new Set(contract.changes
        .filter((change) => change.operation !== "preserve")
        .flatMap((change) => change.targets))]
    : [];
}

