import { sha256Hex } from "../sha256";
import type { TurnAggregateV1 } from "./aggregate";
import type {
  RuntimeV2Command,
  RuntimeV2RunIdentity,
} from "./contracts";

export const RUNTIME_V2_STUDIO_ACTION_SCHEMA_VERSION =
  "runtime-v2-studio-action.v1" as const;
export const RUNTIME_V2_STUDIO_TOOL_NAME = "studio_action" as const;

export type RuntimeV2StudioEngine = "unity" | "godot" | "unreal";

interface RuntimeV2StudioActionBase {
  readonly schemaVersion: typeof RUNTIME_V2_STUDIO_ACTION_SCHEMA_VERSION;
}

export type RuntimeV2StudioAction =
  | (RuntimeV2StudioActionBase & {
      readonly kind: "launch";
    })
  | (RuntimeV2StudioActionBase & {
      readonly kind: "observe";
    })
  | (RuntimeV2StudioActionBase & {
      readonly kind: "interact";
      readonly engine: RuntimeV2StudioEngine;
      readonly engineVersion?: string;
    });

export type RuntimeV2StudioLifecyclePhase =
  | "idle"
  | "launched"
  | "observed"
  | "interacted";

export interface RuntimeV2StudioLedgerState {
  readonly phase: RuntimeV2StudioLifecyclePhase;
  readonly successfulActions: readonly RuntimeV2StudioAction[];
}

export type RuntimeV2StudioAdmissionRejection =
  | "run_not_active"
  | "command_not_scheduled"
  | "command_not_studio_action"
  | "studio_action_requires_acting_phase"
  | "launch_already_committed"
  | "observe_requires_launch"
  | "interact_requires_observation";

export type RuntimeV2StudioActionAdmission =
  | {
      readonly ok: true;
      readonly action: RuntimeV2StudioAction;
      readonly lifecycle: RuntimeV2StudioLedgerState;
    }
  | {
      readonly ok: false;
      readonly reason: RuntimeV2StudioAdmissionRejection;
    };

export type RuntimeV2StudioActionPlanValidation =
  | { readonly ok: true; readonly actions: readonly RuntimeV2StudioAction[] }
  | {
      readonly ok: false;
      readonly reason:
        | "action_plan_empty"
        | "action_plan_too_large"
        | "action_plan_invalid"
        | "action_plan_order_invalid"
        | "action_plan_requires_final_observation";
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(
  value: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
): boolean {
  const keys = Object.keys(value).sort();
  return keys.length === allowed.length &&
    keys.every((key, index) => key === [...allowed].sort()[index]);
}

function isBoundedVersion(value: unknown): value is string {
  return typeof value === "string" &&
    value === value.trim() &&
    value.length > 0 &&
    value.length <= 128;
}

function isStudioEngine(value: unknown): value is RuntimeV2StudioEngine {
  return value === "unity" || value === "godot" || value === "unreal";
}

/** Strict ingress: generated prose, aliases and extra fields are not actions. */
export function parseRuntimeV2StudioAction(
  value: unknown,
): RuntimeV2StudioAction | null {
  if (!isRecord(value) ||
    value.schemaVersion !== RUNTIME_V2_STUDIO_ACTION_SCHEMA_VERSION) {
    return null;
  }
  if (value.kind === "launch" || value.kind === "observe") {
    if (!hasExactKeys(value, ["kind", "schemaVersion"])) return null;
    return {
      schemaVersion: RUNTIME_V2_STUDIO_ACTION_SCHEMA_VERSION,
      kind: value.kind,
    };
  }
  if (value.kind !== "interact" || !isStudioEngine(value.engine)) return null;
  const hasVersion = Object.prototype.hasOwnProperty.call(value, "engineVersion");
  if (!hasExactKeys(
    value,
    hasVersion
      ? ["engine", "engineVersion", "kind", "schemaVersion"]
      : ["engine", "kind", "schemaVersion"],
  )) return null;
  if (hasVersion && !isBoundedVersion(value.engineVersion)) return null;
  return {
    schemaVersion: RUNTIME_V2_STUDIO_ACTION_SCHEMA_VERSION,
    kind: "interact",
    engine: value.engine,
    ...(hasVersion ? { engineVersion: value.engineVersion as string } : {}),
  };
}

export function runtimeV2StudioActionFromCommand(
  command: RuntimeV2Command,
): RuntimeV2StudioAction | null {
  if (
    command.kind !== "execute_tool" ||
    command.payload.toolName !== RUNTIME_V2_STUDIO_TOOL_NAME
  ) return null;
  return parseRuntimeV2StudioAction(command.payload.arguments);
}

function sameRun(
  left: RuntimeV2RunIdentity,
  right: RuntimeV2RunIdentity,
): boolean {
  return left.sessionKey === right.sessionKey &&
    left.sessionEpoch === right.sessionEpoch &&
    left.turnId === right.turnId &&
    left.runId === right.runId &&
    left.parentRunId === right.parentRunId &&
    left.attemptId === right.attemptId;
}

/**
 * Studio lifecycle is a read-only derivation of the Runtime v2 ledger.
 * Assistant text and service return messages are intentionally absent.
 */
export function deriveRuntimeV2StudioLedgerState(
  aggregate: TurnAggregateV1,
): RuntimeV2StudioLedgerState {
  const scheduled = new Map<string, RuntimeV2StudioAction>();
  const successfulActions: RuntimeV2StudioAction[] = [];
  for (const event of aggregate.events) {
    if (event.type === "command.scheduled") {
      const action = runtimeV2StudioActionFromCommand(event.command);
      if (action) scheduled.set(event.command.idempotencyKey, action);
      continue;
    }
    if (event.type !== "tool.completed" || event.status !== "succeeded") continue;
    const action = scheduled.get(event.idempotencyKey);
    if (action) successfulActions.push(action);
  }
  const latestAction = successfulActions[successfulActions.length - 1];
  const phase = latestAction?.kind === "launch"
    ? "launched"
    : latestAction?.kind === "observe"
      ? "observed"
      : latestAction?.kind === "interact"
        ? "interacted"
        : "idle";
  return { phase, successfulActions };
}

export function admitRuntimeV2StudioAction(input: {
  readonly aggregate: TurnAggregateV1;
  readonly command: RuntimeV2Command;
}): RuntimeV2StudioActionAdmission {
  const { aggregate, command } = input;
  if (
    !aggregate.run ||
    aggregate.run.status !== "running" ||
    !sameRun(aggregate.run.identity, command.run)
  ) return { ok: false, reason: "run_not_active" };
  if (!aggregate.scheduledCommands.some(
    (candidate) => candidate.idempotencyKey === command.idempotencyKey,
  )) return { ok: false, reason: "command_not_scheduled" };
  const action = runtimeV2StudioActionFromCommand(command);
  if (!action) return { ok: false, reason: "command_not_studio_action" };
  if (aggregate.phase !== "acting" || command.phase !== "acting") {
    return { ok: false, reason: "studio_action_requires_acting_phase" };
  }
  const lifecycle = deriveRuntimeV2StudioLedgerState(aggregate);
  if (action.kind === "launch" && lifecycle.phase !== "idle") {
    return { ok: false, reason: "launch_already_committed" };
  }
  if (
    action.kind === "observe" &&
    lifecycle.phase !== "launched" &&
    lifecycle.phase !== "interacted"
  ) return { ok: false, reason: "observe_requires_launch" };
  if (action.kind === "interact" && lifecycle.phase !== "observed") {
    return { ok: false, reason: "interact_requires_observation" };
  }
  return { ok: true, action, lifecycle };
}

function canonicalAction(action: RuntimeV2StudioAction): string {
  return JSON.stringify({
    engine: action.kind === "interact" ? action.engine : null,
    engineVersion: action.kind === "interact" ? action.engineVersion || null : null,
    kind: action.kind,
    schemaVersion: action.schemaVersion,
  });
}

export function runtimeV2StudioActionDigest(
  action: RuntimeV2StudioAction,
): string {
  return `studio-action-sha256-${sha256Hex(canonicalAction(action))}`;
}

export function validateRuntimeV2StudioActionPlan(
  values: readonly unknown[],
): RuntimeV2StudioActionPlanValidation {
  if (values.length === 0) return { ok: false, reason: "action_plan_empty" };
  if (values.length > 16) return { ok: false, reason: "action_plan_too_large" };
  const actions = values.map(parseRuntimeV2StudioAction);
  if (actions.some((action) => !action)) {
    return { ok: false, reason: "action_plan_invalid" };
  }
  let phase: RuntimeV2StudioLifecyclePhase = "idle";
  for (const action of actions as RuntimeV2StudioAction[]) {
    if (action.kind === "launch") {
      if (phase !== "idle") return { ok: false, reason: "action_plan_order_invalid" };
      phase = "launched";
    } else if (action.kind === "observe") {
      if (phase !== "launched" && phase !== "interacted") {
        return { ok: false, reason: "action_plan_order_invalid" };
      }
      phase = "observed";
    } else {
      if (phase !== "observed") return { ok: false, reason: "action_plan_order_invalid" };
      phase = "interacted";
    }
  }
  if (phase !== "observed") {
    return { ok: false, reason: "action_plan_requires_final_observation" };
  }
  return { ok: true, actions: actions as RuntimeV2StudioAction[] };
}

export function runtimeV2StudioActionPlanDigest(
  actions: readonly RuntimeV2StudioAction[],
): string {
  return `studio-plan-sha256-${sha256Hex(
    actions.map(runtimeV2StudioActionDigest).join("\u0000"),
  )}`;
}

/**
 * Writes retain one stable key across Runtime retry attempts. A read-only
 * observation may use its command key and can therefore be retried safely.
 */
export function runtimeV2StudioReceiptKey(input: {
  readonly run: RuntimeV2RunIdentity;
  readonly commandIdempotencyKey: string;
  readonly action: RuntimeV2StudioAction;
}): string {
  const suffix = input.action.kind === "observe"
    ? input.commandIdempotencyKey
    : runtimeV2StudioActionDigest(input.action);
  return `studio-receipt-${sha256Hex([
    input.run.sessionKey,
    input.run.sessionEpoch,
    input.run.turnId,
    input.run.runId,
    suffix,
  ].join("\u0000"))}`;
}

export function runtimeV2StudioActionMayWrite(
  action: RuntimeV2StudioAction,
): boolean {
  return action.kind === "launch" || action.kind === "interact";
}
