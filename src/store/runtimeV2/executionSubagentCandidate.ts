import type {
  RuntimeV2Command,
  SchedulerPort,
} from "../../lib/runtime-v2";
import {
  RUNTIME_V2_SUBAGENT_ACCESS_MODES,
  RUNTIME_V2_SUBAGENT_IMPLEMENTATION_OPERATIONS,
  RUNTIME_V2_SUBAGENT_TASK_KINDS,
} from "../../lib/toolSchemas";

function boundedArgument(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function commaSeparatedPaths(value: unknown): string[] {
  return String(value || "")
    .split(/[\n,]/)
    .map((entry) =>
      entry.trim().replace(/\\/g, "/").replace(/^\.\//, "")
        .replace(/\/+$/, "")
    )
    .filter((entry) =>
      !!entry &&
      !entry.startsWith("/") &&
      !/^[A-Za-z]:\//.test(entry) &&
      !entry.split("/").includes("..")
    )
    .slice(0, 6);
}

/** Compile the provider-authored collaboration call into one narrow scheduler
 * candidate. Omitted scope never expands to ".". Write access is accepted
 * only for an explicit implement contract with one operation class and a
 * concrete parent-authored plan. */
export function runtimeV2ModelSelectedSubagentCandidate(
  command: Parameters<
    NonNullable<SchedulerPort["prepareSchedule"]>
  >[0]["command"],
) {
  const args =
    command.payload.arguments &&
      typeof command.payload.arguments === "object" &&
      !Array.isArray(command.payload.arguments)
      ? command.payload.arguments as Record<string, unknown>
      : {};
  const sourceToolCallId =
    boundedArgument(command.payload.toolCallId, 256);
  const taskKey =
    boundedArgument(args.task_key, 256) ||
    sourceToolCallId ||
    boundedArgument(command.idempotencyKey, 256);
  const name = boundedArgument(args.name, 128);
  const role = boundedArgument(args.role, 128);
  const objective = boundedArgument(args.objective, 2_000);
  const successCriteria = boundedArgument(args.success_criteria, 1_000);
  const accessMode = boundedArgument(args.access_mode, 32) || "read";
  const taskKind = boundedArgument(args.task_kind, 32) || "explore";
  const implementationOperation = boundedArgument(
    args.implementation_operation,
    32,
  );
  const implementationPlan = boundedArgument(
    args.implementation_plan,
    4_000,
  );
  if (!taskKey || !objective) {
    throw new Error(
      "spawn_subagent requires an objective and a stable tool-call identity.",
    );
  }
  if (
    !(RUNTIME_V2_SUBAGENT_ACCESS_MODES as readonly string[])
      .includes(accessMode) ||
    !(RUNTIME_V2_SUBAGENT_TASK_KINDS as readonly string[])
      .includes(taskKind)
  ) {
    throw new Error(
      "Runtime v2 collaboration accepts read-only explore/review/validate jobs or an explicitly planned implement write job.",
    );
  }
  const writeJob = accessMode === "write" || taskKind === "implement";
  if (
    writeJob &&
    (
      accessMode !== "write" ||
      taskKind !== "implement" ||
      !(RUNTIME_V2_SUBAGENT_IMPLEMENTATION_OPERATIONS as readonly string[])
        .includes(implementationOperation) ||
      !implementationPlan ||
      !successCriteria
    )
  ) {
    throw new Error(
      "implement subagents require access_mode=write, implementation_operation, implementation_plan, and success_criteria.",
    );
  }
  if (!writeJob && accessMode !== "read") {
    throw new Error(
      "explore, review, and validate subagents must remain read-only.",
    );
  }
  const explicitlyAllowedPaths = commaSeparatedPaths(args.allowed_paths);
  const requiredPaths = commaSeparatedPaths(args.required_paths);
  const allowedPaths =
    explicitlyAllowedPaths.length > 0
      ? explicitlyAllowedPaths
      : requiredPaths;
  if (allowedPaths.length === 0) {
    throw new Error(
      "spawn_subagent requires a narrow scope in allowed_paths or required_paths; Runtime v2 will not widen an omitted scope to the whole workspace.",
    );
  }
  if (writeJob && allowedPaths.includes(".")) {
    throw new Error(
      "implement subagents require narrow file or directory ownership; the workspace root cannot be a write scope.",
    );
  }
  if (
    requiredPaths.some((requiredPath) =>
      !allowedPaths.some((allowedPath) =>
        requiredPath === allowedPath ||
        requiredPath.startsWith(`${allowedPath}/`)
      )
    )
  ) {
    throw new Error(
      "spawn_subagent required_paths must be contained by allowed_paths.",
    );
  }
  return {
    sourceToolCallId,
    scopeKey: taskKey,
    taskKind: taskKind as "explore" | "review" | "validate" | "implement",
    accessMode: accessMode as "read" | "write",
    ...(writeJob
      ? {
          implementationOperation:
            implementationOperation as "create" | "modify" | "delete",
          implementationPlan,
        }
      : {}),
    name,
    role,
    objective,
    successCriteria,
    expectedOutput: boundedArgument(args.expected_output, 1_000),
    allowedPaths,
  };
}

export function runtimeV2SubagentCapacityFromCommand(
  command: RuntimeV2Command,
): number {
  return Math.max(
    0,
    Math.floor(Number(command.payload.maxActiveSubagents) || 0),
  );
}

export function runtimeV2SubagentTotalBudgetFromCommand(
  command: RuntimeV2Command,
): number {
  const admitted = Number(command.payload.maxChildRuns);
  if (Number.isSafeInteger(admitted) && admitted >= 0) {
    return admitted;
  }
  return runtimeV2SubagentCapacityFromCommand(command);
}
