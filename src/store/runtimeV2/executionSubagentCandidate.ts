import type {
  RuntimeV2Command,
  SchedulerPort,
} from "../../lib/runtime-v2";
import {
  READ_ONLY_SUBAGENT_ACCESS_MODES,
  READ_ONLY_SUBAGENT_TASK_KINDS,
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

/** Compile the provider-authored collaboration call into one narrow,
 * read-only scheduler candidate. Omitted scope never expands to ".". */
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
  if (!taskKey || !objective) {
    throw new Error(
      "spawn_subagent requires an objective and a stable tool-call identity.",
    );
  }
  if (
    !(READ_ONLY_SUBAGENT_ACCESS_MODES as readonly string[])
      .includes(accessMode) ||
    !(READ_ONLY_SUBAGENT_TASK_KINDS as readonly string[])
      .includes(taskKind)
  ) {
    throw new Error(
      "Runtime v2 collaboration currently accepts read-only explore, review, or validation investigations only.",
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
      "spawn_subagent requires a narrow read scope in allowed_paths or required_paths; Runtime v2 will not widen an omitted scope to the whole workspace.",
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
    taskKind: taskKind as "explore" | "review" | "validate",
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
