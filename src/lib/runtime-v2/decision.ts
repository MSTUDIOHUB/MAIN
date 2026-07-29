import type { TurnAggregateV1 } from "./aggregate";
import { exhaustedRuntimeV2ResultKind } from "./completion";
import type {
  RuntimeV2Command,
  RuntimeV2CommandKind,
  RuntimeV2ExecutionValidationAuthority,
  RuntimeV2ResultKind,
} from "./contracts";
import { runtimeV2ActionFingerprint } from "./recovery";
import {
  MAX_RUNTIME_V2_READ_ONLY_SUBAGENTS,
  resolveRuntimeV2SubagentReferences,
  runtimeV2SubagentModelHandle,
} from "./subagents";
import {
  deriveRuntimeV2PlanExecutionCoverage,
  resolveRuntimeV2PlanValidationScope,
  runtimeV2PlanValidationAuthority,
} from "./planExecution";
import { runtimeV2DirectExecuteReadyForConclusion } from "./phaseTransition";
import { isWorkspaceMutationToolName } from "../workspaceMutationTools";
import { RUNTIME_V2_WORKSPACE_SOURCE_TOOL_NAMES } from "./workspaceReadPolicy";

export interface RuntimeV2DecisionInput {
  /**
   * This is supplied only by the store-side evidence gate. Provider prose is
   * never converted into this field inside the Runtime core.
   */
  readonly resultKind?: RuntimeV2ResultKind;
  readonly resultReason?: string;
  /** User-visible, provider-authored conclusion after the adapter has already
   * checked the structured evidence gate. It is presentation data only. */
  readonly finalMarkdown?: string;
  /**
   * Admission-time collaboration policy. It controls only the model's tool
   * surface; task identity, name, objective and scope must come from an actual
   * spawn_subagent call.
   */
  readonly subagentPreference?:
    | "unspecified"
    | "forbidden"
    | "allowed"
    | "preferred";
}

const VALIDATION_TOOL_NAMES = new Set([
  "run_command",
  "browser_evaluate",
  "computer_use",
]);

function commaSeparatedValues(value: unknown): string[] {
  return String(value || "")
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .slice(0, MAX_RUNTIME_V2_READ_ONLY_SUBAGENTS);
}

function collaborationPayload(
  state: TurnAggregateV1,
  input: RuntimeV2DecisionInput,
): Readonly<Record<string, unknown>> {
  const collaborationAllowed =
    input.subagentPreference === "allowed" ||
    input.subagentPreference === "preferred";
  const activeSubagents = state.subagents
    .filter((job) => job.status === "queued" || job.status === "running")
    .map((job) => ({
      id: runtimeV2SubagentModelHandle(job),
      name: job.name || job.scopeKey,
      objective: job.objective,
    }));
  const failedSubagents = state.subagents
    .filter((job) =>
      job.status === "failed" || job.status === "degraded"
    )
    .slice(-MAX_RUNTIME_V2_READ_ONLY_SUBAGENTS)
    .map((job) => ({
      id: runtimeV2SubagentModelHandle(job),
      name: job.name || job.scopeKey,
      objective: job.objective,
      status: job.status,
      summary: job.summary || "No structured report was committed.",
    }));
  const failedCommandKeys = new Set(state.events.flatMap((event) =>
    event.type === "command.completed" && event.status === "failed"
      ? [event.idempotencyKey]
      : []
  ));
  let latestCollaborationFailureIndex = -1;
  state.events.forEach((event, index) => {
    if (
      (
        event.type === "subagent.completed" &&
        (event.status === "failed" || event.status === "degraded")
      ) ||
      (
        event.type === "command.scheduled" &&
        event.command.kind === "schedule_subagents" &&
        failedCommandKeys.has(event.command.idempotencyKey)
      )
    ) {
      latestCollaborationFailureIndex = index;
    }
  });
  const parentProgressAfterFailure =
    latestCollaborationFailureIndex >= 0 &&
    state.events.slice(latestCollaborationFailureIndex + 1).some((event) =>
      (
        event.type === "tool.completed" &&
        event.status === "succeeded" &&
        event.evidence.length > 0
      )
    );
  const parentTakeoverRequired =
    latestCollaborationFailureIndex >= 0 &&
    !parentProgressAfterFailure;
  return {
    collaborationAllowed,
    collaborationPreferred:
      input.subagentPreference === "preferred",
    collaborationAction:
      activeSubagents.length > 0
        ? "children_active"
        : parentTakeoverRequired
          ? "parent_takeover_required"
          : "optional",
    activeSubagents,
    failedSubagents,
    remainingSubagentCapacity: Math.max(
      0,
      parentTakeoverRequired
        ? 0
        : MAX_RUNTIME_V2_READ_ONLY_SUBAGENTS - activeSubagents.length,
    ),
  };
}

function actionFingerprint(
  state: TurnAggregateV1,
  kind: RuntimeV2CommandKind,
  payload: Readonly<Record<string, unknown>>,
): string {
  if (state.phase === "completed") {
    throw new Error("Cannot fingerprint a command for a completed Runtime v2 Run.");
  }
  return runtimeV2ActionFingerprint({
    kind,
    phase: state.phase,
    payload,
  });
}

function actionAttemptCount(state: TurnAggregateV1, fingerprint: string): number {
  return state.completedCommands.filter((receipt) => receipt.actionFingerprint === fingerprint).length +
    state.scheduledCommands.filter((scheduled) => runtimeV2ActionFingerprint(scheduled) === fingerprint).length;
}

function deterministicCommandKey(
  state: TurnAggregateV1,
  kind: RuntimeV2CommandKind,
  fingerprint: string,
  attempt: number,
): string {
  const run = state.run;
  if (!run) throw new Error("A Runtime v2 command requires an active run.");
  return [
    run.identity.runId,
    state.phase,
    kind,
    `epoch-${state.recovery.epoch}`,
    `attempt-${attempt}`,
    fingerprint,
  ].join(":");
}

function makeCommand(
  state: TurnAggregateV1,
  kind: RuntimeV2CommandKind,
  payload: Readonly<Record<string, unknown>> = {},
): RuntimeV2Command {
  if (!state.run || state.phase === "completed") {
    throw new Error("Cannot decide a command without an active Runtime v2 run.");
  }
  const fingerprint = actionFingerprint(state, kind, payload);
  const attempt = actionAttemptCount(state, fingerprint) + 1;
  return {
    idempotencyKey: deterministicCommandKey(state, kind, fingerprint, attempt),
    kind,
    run: state.run.identity,
    phase: state.phase,
    payload: {
      ...payload,
      actionFingerprint: fingerprint,
      attempt,
    },
  };
}

function boundedCommand(
  state: TurnAggregateV1,
  kind: Exclude<RuntimeV2CommandKind, "finalize_turn">,
  payload: Readonly<Record<string, unknown>> = {},
): RuntimeV2Command {
  return makeCommand(state, kind, payload);
}

function repeatedObservationReason(
  state: TurnAggregateV1,
  command: RuntimeV2Command,
):
  | "unchanged_source_repeat"
  | "unchanged_observation_repeat"
  | "repeated_validation"
  | null {
  const requestedToolName = String(command.payload.toolName || "");
  if (
    (
      command.kind !== "execute_tool" &&
      command.kind !== "execute_validation"
    ) ||
    (
      command.kind === "execute_tool" &&
      !RUNTIME_V2_WORKSPACE_SOURCE_TOOL_NAMES.has(requestedToolName)
    )
  ) return null;
  const toolActionFingerprint = (candidate: RuntimeV2Command) =>
    runtimeV2ActionFingerprint({
      kind: "execute_tool",
      phase: "acting",
      payload: {
        toolName: candidate.payload.toolName,
        arguments: candidate.payload.arguments,
      },
    });
  const fingerprint = toolActionFingerprint(command);
  const scheduled = new Map<string, RuntimeV2Command>();
  const versions: string[] = [];
  let identicalObservations = 0;
  for (const event of state.events) {
    if (event.type === "command.scheduled") {
      scheduled.set(event.command.idempotencyKey, event.command);
      continue;
    }
    if (
      event.type !== "tool.completed" &&
      event.type !== "validation.completed"
    ) {
      continue;
    }
    const completed = scheduled.get(event.idempotencyKey);
    if (!completed) continue;
    const toolName = String(completed.payload.toolName || "");
    if (
      event.type === "tool.completed" &&
      event.status === "succeeded" &&
      isWorkspaceMutationToolName(toolName)
    ) {
      // A committed mutation opens a new source boundary. Reads after it must
      // remain available, and validations must re-run against the new source.
      versions.length = 0;
      identicalObservations = 0;
      continue;
    }
    if (
      completed.kind !== command.kind ||
      toolName !== requestedToolName ||
      toolActionFingerprint(completed) !== fingerprint ||
      (
        completed.kind === "execute_tool" &&
        (
          event.type !== "tool.completed" ||
          event.status !== "succeeded"
        )
      ) ||
      (
        completed.kind === "execute_validation" &&
        event.type !== "validation.completed"
      )
    ) {
      continue;
    }
    identicalObservations += 1;
    if (command.kind === "execute_validation") continue;
    if (requestedToolName !== "read_file") continue;
    const version = event.evidence.find(
      (evidence) => evidence.kind === "source",
    )?.version;
    if (version) versions.push(version);
  }
  if (command.kind === "execute_validation") {
    return identicalObservations >= 2
      ? "repeated_validation"
      : null;
  }
  if (requestedToolName !== "read_file") {
    return identicalObservations >= 2
      ? "unchanged_observation_repeat"
      : null;
  }
  return versions.length >= 2 &&
      versions[versions.length - 1] === versions[versions.length - 2]
    ? "unchanged_source_repeat"
    : null;
}

function executeReadyForConclusion(state: TurnAggregateV1): boolean {
  const planCoverage = deriveRuntimeV2PlanExecutionCoverage(state);
  if (planCoverage) {
    return planCoverage.allMutationTargetsCovered &&
      planCoverage.allRequiredValidationsPassed;
  }
  return runtimeV2DirectExecuteReadyForConclusion(state);
}

function executeModelRequest(
  state: TurnAggregateV1,
  input: RuntimeV2DecisionInput,
): RuntimeV2Command {
  const ready = executeReadyForConclusion(state);
  return boundedCommand(state, "request_model", {
    mode: ready
      ? "conclude"
      : state.phase === "validating"
        ? "validate"
        : "execute",
    toolExpectation: ready ? "optional" : "required",
    objective: state.objective.text,
    acceptanceCriteria: state.objective.acceptanceCriteria,
    evidenceIds: state.evidence.map((item) => item.id),
    hasVersionedSourceEvidence: state.evidence.some(
      (item) => item.kind === "source" && !!item.version,
    ),
    ...collaborationPayload(state, input),
  });
}

/**
 * Pure next-command policy. It never chooses an outcome from model prose and
 * it never hides an Execute tool because the current phase looks inconvenient.
 * A caller supplies a truthful success/error outcome only after its evidence
 * gate; bounded recovery may independently produce a partial conclusion.
 */
export function decideNextCommands(
  state: TurnAggregateV1,
  input: RuntimeV2DecisionInput = {},
): readonly RuntimeV2Command[] {
  if (!state.run || state.run.status === "completed" || state.terminalOutcome) return [];
  if (state.scheduledCommands.length > 0) return [];
  if (input.resultKind && input.resultReason) {
    const activeJobIds = state.subagents
      .filter((job) => job.status === "queued" || job.status === "running")
      .map((job) => job.id);
    if (activeJobIds.length > 0) {
      return [boundedCommand(state, "join_subagents", {
        mode: "read_only",
        jobIds: activeJobIds,
        finalJoin: true,
      })];
    }
    return [makeCommand(state, "finalize_turn", {
      resultKind: input.resultKind,
      resultReason: input.resultReason,
      ...(typeof input.finalMarkdown === "string" && input.finalMarkdown.trim()
        ? { finalMarkdown: input.finalMarkdown.trim().slice(0, 24_000) }
      : {}),
    })];
  }
  if (state.recovery.exhausted) {
    const activeJobIds = state.subagents
      .filter((job) => job.status === "queued" || job.status === "running")
      .map((job) => job.id);
    if (activeJobIds.length > 0) {
      return [boundedCommand(state, "join_subagents", {
        mode: "read_only",
        jobIds: activeJobIds,
        finalJoin: true,
      })];
    }
    return [makeCommand(state, "finalize_turn", {
      resultKind: state.recovery.exhausted.scope === "transport"
        ? "error"
        : exhaustedRuntimeV2ResultKind(state),
      resultReason: state.recovery.exhausted.reason,
    })];
  }
  if (state.pendingToolCalls.length > 0) {
    const toolCall = state.pendingToolCalls[0];
    if (toolCall.name === "spawn_subagent") {
      return [boundedCommand(state, "schedule_subagents", {
        toolCallId: toolCall.id,
        arguments: toolCall.arguments,
      })];
    }
    if (toolCall.name === "wait_subagents") {
      const requested = [
        ...commaSeparatedValues(toolCall.arguments.subagent_ids),
        ...commaSeparatedValues(toolCall.arguments.collaboration_task_ids),
      ];
      const activeJobs = state.subagents
        .filter((job) => job.status === "queued" || job.status === "running")
      const resolution = resolveRuntimeV2SubagentReferences({
        jobs: activeJobs,
        requested,
      });
      return [boundedCommand(state, "join_subagents", {
        toolCallId: toolCall.id,
        arguments: toolCall.arguments,
        requestedJobIds: requested,
        jobIds: requested.length > 0
          ? resolution.jobIds
          : activeJobs.map((job) => job.id),
        unresolvedJobIds: resolution.unresolved,
      })];
    }
    const kind = VALIDATION_TOOL_NAMES.has(toolCall.name)
      ? "execute_validation"
      : "execute_tool";
    let validationAuthority:
      | RuntimeV2ExecutionValidationAuthority
      | undefined;
    if (
      kind === "execute_validation" &&
      state.workPlan?.status === "approved" &&
      state.sealedWorkPlan
    ) {
      const scope = resolveRuntimeV2PlanValidationScope({
        plan: state.sealedWorkPlan,
        toolName: toolCall.name,
        args: toolCall.arguments,
      });
      const validationIndex = scope.matchingValidationIndexes[0];
      const validation = validationIndex === undefined
        ? undefined
        : state.sealedWorkPlan.draft.validations[validationIndex];
      if (validation && validationIndex !== undefined) {
        validationAuthority =
          runtimeV2PlanValidationAuthority({
            plan: state.sealedWorkPlan,
            validationIndex,
          }) || undefined;
      }
    }
    const command = boundedCommand(state, kind, {
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      arguments: toolCall.arguments,
      ...(validationAuthority ? { validationAuthority } : {}),
    });
    const repeatedActionReason = repeatedObservationReason(
      state,
      command,
    );
    return [repeatedActionReason
      ? {
          ...command,
          payload: {
            ...command.payload,
            repeatedActionRejected: true,
            repeatedActionReason,
          },
        }
      : command];
  }

  switch (state.phase) {
    case "preparing":
      return [boundedCommand(state, "collect_observation", {
        objective: state.objective.text,
        acceptanceCriteria: state.objective.acceptanceCriteria,
      })];
    case "observing": {
      if (state.strategy === "chat") {
        return [boundedCommand(state, "request_model", {
          mode: "chat",
          toolExpectation: "optional",
          objective: state.objective.text,
        })];
      }
      if (state.strategy === "analyze") {
        return [boundedCommand(state, "request_model", {
          mode: "analyze",
          toolExpectation: "optional",
          objective: state.objective.text,
          evidenceIds: state.evidence.map((item) => item.id),
          ...collaborationPayload(state, input),
        })];
      }
      return [executeModelRequest(state, input)];
    }
    case "planning":
      return [boundedCommand(state, "request_model", {
        mode: "plan",
        objective: state.objective.text,
        evidenceIds: state.evidence.map((item) => item.id),
      })];
    case "reviewing":
      return [];
    case "acting":
    case "validating":
      return [executeModelRequest(state, input)];
    case "finalizing":
      if (!input.resultKind || !input.resultReason) return [];
      return [makeCommand(state, "finalize_turn", {
        resultKind: input.resultKind,
        resultReason: input.resultReason,
      })];
    case "completed":
      return [];
  }
}
