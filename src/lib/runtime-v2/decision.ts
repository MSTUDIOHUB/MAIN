import type { TurnAggregateV1 } from "./aggregate";
import { exhaustedRuntimeV2ResultKind } from "./completion";
import type {
  RuntimeV2Command,
  RuntimeV2CommandKind,
  RuntimeV2RecoveryScope,
  RuntimeV2ResultKind,
} from "./contracts";
import { RUNTIME_V2_RECOVERY_LIMITS, runtimeV2ActionFingerprint } from "./recovery";
import { MAX_RUNTIME_V2_READ_ONLY_SUBAGENTS } from "./subagents";

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

function commaSeparatedValues(value: unknown): string[] {
  return String(value || "")
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .slice(0, MAX_RUNTIME_V2_READ_ONLY_SUBAGENTS);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (!value || typeof value !== "object") return JSON.stringify(value);
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([key]) => key !== "actionFingerprint" && key !== "attempt")
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
    .join(",")}}`;
}

function actionFingerprint(
  state: TurnAggregateV1,
  kind: RuntimeV2CommandKind,
  payload: Readonly<Record<string, unknown>>,
): string {
  // Provider tool-call ids are transport-local and change every time a model
  // retries the same request. They must not open an unbounded new recovery
  // lineage for an otherwise identical action.
  const structuralPayload = { ...payload };
  delete structuralPayload.toolCallId;
  return `${state.phase}:${kind}:${canonical(structuralPayload)}`.slice(0, 4_096);
}

function actionAttemptCount(state: TurnAggregateV1, fingerprint: string): number {
  return state.completedCommands.filter((receipt) => receipt.actionFingerprint === fingerprint).length +
    state.scheduledCommands.filter((scheduled) => runtimeV2ActionFingerprint(scheduled) === fingerprint).length;
}

function failedActionAttemptCount(state: TurnAggregateV1, fingerprint: string): number {
  const epochOpenedAt = [...state.events].reverse().find(
    (event) => event.type === "recovery.epoch_opened",
  )?.at ?? Number.NEGATIVE_INFINITY;
  return state.completedCommands.filter((receipt) =>
    receipt.actionFingerprint === fingerprint &&
    receipt.status === "failed" &&
    receipt.completedAt >= epochOpenedAt
  ).length;
}

function currentPhaseEvents(state: TurnAggregateV1) {
  for (let index = state.events.length - 1; index >= 0; index -= 1) {
    const event = state.events[index]!;
    if (
      (event.type === "phase.changed" && event.phase === state.phase) ||
      (event.type === "run.started" && event.phase === state.phase)
    ) {
      return state.events.slice(index + 1);
    }
  }
  return state.events;
}

/**
 * Acting permits a small, ledger-bounded source-gap pass. Once two source
 * operations have succeeded (or the current phase repeats the same source),
 * the next provider request must choose from mutation capabilities. A global
 * iteration-pressure signal must not remove reads from a newly opened
 * corrective phase after validation exposed fresh source gaps.
 * This is a process-stage policy, not a model- or wording-specific heuristic.
 */
function actingExecutePolicy(
  state: TurnAggregateV1,
):
  | "source_refresh_required"
  | "source_reorientation_required"
  | "source_gap_allowed"
  | "mutation_required" {
  const phaseEvents = currentPhaseEvents(state);
  const isSuccessfulSourceOperation = (event: (typeof phaseEvents)[number]) =>
    event.type === "tool.completed" &&
    event.status === "succeeded" &&
    event.evidence.length > 0 &&
    event.evidence.every((evidence) => evidence.kind === "source");
  const successfulSourceOperations = phaseEvents.filter(
    isSuccessfulSourceOperation,
  ).length;
  const pressureObserved = phaseEvents.some((event) =>
    event.type === "soft_signal.observed" &&
    event.signal === "repeat"
  );
  let latestRecoveryFailureIndex = -1;
  let latestRecoveryFailureKind:
    | "mutation_rejected"
    | "source_mismatch"
    | "target_invalid"
    | null = null;
  for (let index = phaseEvents.length - 1; index >= 0; index -= 1) {
    const event = phaseEvents[index]!;
    if (
      event.type === "tool.completed" &&
      event.status !== "succeeded" &&
      (
        event.failureKind === "mutation_rejected" ||
        event.failureKind === "source_mismatch" ||
        event.failureKind === "target_invalid"
      )
    ) {
      latestRecoveryFailureIndex = index;
      latestRecoveryFailureKind = event.failureKind;
      break;
    }
  }
  if (latestRecoveryFailureIndex >= 0) {
    const refreshedSourceOperations = phaseEvents
      .slice(latestRecoveryFailureIndex + 1)
      .filter(isSuccessfulSourceOperation)
      .length;
    if (
      latestRecoveryFailureKind === "source_mismatch" ||
      latestRecoveryFailureKind === "mutation_rejected"
    ) {
      return refreshedSourceOperations > 0
        ? "mutation_required"
        : "source_refresh_required";
    }
    // A nonexistent, external, or otherwise invalid target cannot be repaired
    // by rereading that same path. Reopen two source-only decisions so a weak
    // model can first orient to the workspace and then inspect a real file.
    return refreshedSourceOperations >= 2
      ? "mutation_required"
      : "source_reorientation_required";
  }
  let phaseBoundaryIndex = -1;
  for (let index = state.events.length - 1; index >= 0; index -= 1) {
    const event = state.events[index]!;
    if (event.type === "phase.changed" && event.phase === "acting") {
      phaseBoundaryIndex = index;
      break;
    }
  }
  let previousBoundaryIndex = -1;
  for (let index = phaseBoundaryIndex - 1; index >= 0; index -= 1) {
    const event = state.events[index]!;
    if (event.type === "phase.changed" || event.type === "run.started") {
      previousBoundaryIndex = index;
      break;
    }
  }
  const previousBoundary = previousBoundaryIndex >= 0
    ? state.events[previousBoundaryIndex]
    : null;
  const correctivePhase = phaseBoundaryIndex >= 0 &&
    previousBoundary?.type !== undefined &&
    "phase" in previousBoundary &&
    previousBoundary.phase === "validating" &&
    state.events
      .slice(previousBoundaryIndex + 1, phaseBoundaryIndex)
      .some((event) =>
        event.type === "validation.completed" && !event.passed
      );
  if (correctivePhase) {
    return successfulSourceOperations === 0
      ? "source_refresh_required"
      : "mutation_required";
  }
  return successfulSourceOperations >= 2 || pressureObserved
    ? "mutation_required"
    : "source_gap_allowed";
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

function recoveryFinalization(
  state: TurnAggregateV1,
  fingerprint: string,
  reason: string,
  resultKind: RuntimeV2ResultKind = exhaustedRuntimeV2ResultKind(state),
  recoveryScope: RuntimeV2RecoveryScope = "action",
): RuntimeV2Command {
  return makeCommand(state, "finalize_turn", {
    resultKind,
    resultReason: reason,
    recoveryExhausted: true,
    recoveryScope,
    recoveryFingerprint: fingerprint,
  });
}

/**
 * Recovery limits retries of failed structural actions. A successful read is
 * evidence, not a failed recovery attempt; repeated successful reads are
 * redirected by the acting tool policy instead of being mislabeled terminal.
 */
function boundedCommand(
  state: TurnAggregateV1,
  kind: Exclude<RuntimeV2CommandKind, "finalize_turn">,
  payload: Readonly<Record<string, unknown>> = {},
): RuntimeV2Command {
  const fingerprint = actionFingerprint(state, kind, payload);
  const failedAttempts = failedActionAttemptCount(state, fingerprint);
  if (failedAttempts >= RUNTIME_V2_RECOVERY_LIMITS.action) {
    const transportFailureCount = state.recovery.receipts.find((receipt) =>
      receipt.scope === "transport" &&
      receipt.fingerprint === `transport:${fingerprint}` &&
      receipt.epoch === state.recovery.epoch
    )?.count || 0;
    if (
      kind === "request_model" &&
      failedAttempts >= RUNTIME_V2_RECOVERY_LIMITS.action &&
      transportFailureCount >= failedAttempts
    ) {
      return recoveryFinalization(
        state,
        fingerprint,
        "provider_transport_exhausted",
        "error",
        "transport",
      );
    }
    return recoveryFinalization(
      state,
      fingerprint,
      "当前同一项结构化动作已达到恢复上限；已保留可靠证据并以部分结果收口，避免任务无限停留在执行中。",
    );
  }
  return makeCommand(state, kind, payload);
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
  if (state.recovery.exhausted) {
    return [recoveryFinalization(
      state,
      state.recovery.exhausted.fingerprint,
      state.recovery.exhausted.reason,
    )];
  }
  if (input.resultKind && input.resultReason) {
    return [makeCommand(state, "finalize_turn", {
      resultKind: input.resultKind,
      resultReason: input.resultReason,
      ...(typeof input.finalMarkdown === "string" && input.finalMarkdown.trim()
        ? { finalMarkdown: input.finalMarkdown.trim().slice(0, 24_000) }
        : {}),
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
      const activeIds = state.subagents
        .filter((job) => job.status === "queued" || job.status === "running")
        .map((job) => job.id);
      return [boundedCommand(state, "join_subagents", {
        toolCallId: toolCall.id,
        arguments: toolCall.arguments,
        requestedJobIds: requested,
        jobIds: requested.length > 0
          ? activeIds.filter((id) => requested.includes(id))
          : activeIds,
      })];
    }
    const kind = state.phase === "validating" ? "execute_validation" : "execute_tool";
    return [boundedCommand(state, kind, {
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      arguments: toolCall.arguments,
    })];
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
      const collaborationAllowed =
        input.subagentPreference === "allowed" ||
        input.subagentPreference === "preferred";
      const activeSubagents = state.subagents
        .filter((job) => job.status === "queued" || job.status === "running")
        .map((job) => ({
          id: job.id,
          name: job.name || job.scopeKey,
          objective: job.objective,
        }));
      const initialSpawnRequired =
        input.subagentPreference === "preferred" &&
        state.subagents.length === 0;
      if (activeSubagents.length > 0) {
        const lastScheduleIndex = state.events
          .map((event) => event.type)
          .lastIndexOf("subagents.scheduled");
        const parentObservedWhileChildrenRun = state.events.some(
          (event, index) =>
            index > lastScheduleIndex &&
            event.type === "provider.responded",
        );
        // Child identity and work come only from the provider's real
        // spawn_subagent call. Once the parent has had one independent model
        // turn, the runtime joins the actual active jobs even if a smaller
        // model forgets the explicit wait tool, keeping collaboration finite.
        if (parentObservedWhileChildrenRun) {
          return [boundedCommand(state, "join_subagents", {
            mode: "read_only",
            jobIds: activeSubagents.map((job) => job.id),
          })];
        }
      }
      return [boundedCommand(state, "request_model", {
        mode: state.strategy === "analyze" ? "analyze" : "observe",
        toolExpectation: initialSpawnRequired ? "required" : "optional",
        objective: state.objective.text,
        evidenceIds: state.evidence.map((item) => item.id),
        collaborationAllowed,
        collaborationAction: initialSpawnRequired
          ? "spawn_required"
          : activeSubagents.length > 0
            ? "children_active"
            : "optional",
        activeSubagents,
        remainingSubagentCapacity: Math.max(
          0,
          MAX_RUNTIME_V2_READ_ONLY_SUBAGENTS - state.subagents.length,
        ),
      })];
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
      return [boundedCommand(state, "request_model", {
        mode: "execute",
        executePolicy: actingExecutePolicy(state),
        toolExpectation: "required",
        objective: state.objective.text,
        workPlanRevision: state.workPlan?.revision || null,
        evidenceIds: state.evidence.map((item) => item.id),
      })];
    case "validating": {
      const hasPassedValidation = state.events.some((event) =>
        event.type === "validation.completed" && event.passed
      );
      return [boundedCommand(state, "request_model", {
        mode: hasPassedValidation ? "conclude" : "validate",
        toolExpectation: hasPassedValidation ? "optional" : "required",
        objective: state.objective.text,
        acceptanceCriteria: state.objective.acceptanceCriteria,
        evidenceIds: state.evidence.map((item) => item.id),
      })];
    }
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
