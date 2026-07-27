import type { TurnAggregateV1 } from "./aggregate";
import { exhaustedRuntimeV2ResultKind } from "./completion";
import type {
  RuntimeV2Command,
  RuntimeV2CommandKind,
  RuntimeV2RecoveryScope,
  RuntimeV2ResultKind,
} from "./contracts";
import { RUNTIME_V2_RECOVERY_LIMITS, runtimeV2ActionFingerprint } from "./recovery";

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
  readonly allowReadOnlySubagents?: boolean;
  /** The store scheduler has already proved that two frozen scopes exist. */
  readonly hasReadOnlySubagentScopes?: boolean;
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
 * A command can be attempted twice for an identical structural action. The
 * third attempt becomes a truthful partial conclusion instead of another
 * indefinitely-running model request. New evidence opens a new epoch and
 * therefore creates a new action fingerprint/attempt lineage.
 */
function boundedCommand(
  state: TurnAggregateV1,
  kind: Exclude<RuntimeV2CommandKind, "finalize_turn">,
  payload: Readonly<Record<string, unknown>> = {},
): RuntimeV2Command {
  const fingerprint = actionFingerprint(state, kind, payload);
  if (actionAttemptCount(state, fingerprint) >= RUNTIME_V2_RECOVERY_LIMITS.action) {
    const failedAttempts = state.completedCommands.filter((receipt) =>
      receipt.actionFingerprint === fingerprint && receipt.status === "failed"
    ).length;
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
      if (input.allowReadOnlySubagents && input.hasReadOnlySubagentScopes) {
        const activeChildren = state.subagents.some((job) => job.status === "queued" || job.status === "running");
        if (state.subagents.length === 0) {
          return [boundedCommand(state, "schedule_subagents", {
            mode: "read_only",
            objective: state.objective.text,
          })];
        }
        if (activeChildren) {
          const lastScheduleIndex = state.events.map((event) => event.type).lastIndexOf("subagents.scheduled");
          const parentObservedWhileChildrenRun = state.events.some((event, index) =>
            index > lastScheduleIndex && event.type === "provider.responded"
          );
          // Let the parent make one independent observation while the child
          // HTTP requests are in flight. It is a structural schedule fact,
          // not a guess from child/model wording.
          if (!parentObservedWhileChildrenRun) {
            return [boundedCommand(state, "request_model", {
              mode: state.strategy === "analyze" ? "analyze" : "observe",
              toolExpectation: "optional",
              objective: state.objective.text,
              evidenceIds: state.evidence.map((item) => item.id),
              childEvidencePending: true,
            })];
          }
          return [boundedCommand(state, "join_subagents", {
            mode: "read_only",
            jobIds: state.subagents.map((job) => job.id),
          })];
        }
      }
      return [boundedCommand(state, "request_model", {
        mode: state.strategy === "analyze" ? "analyze" : "observe",
        toolExpectation: "optional",
        objective: state.objective.text,
        evidenceIds: state.evidence.map((item) => item.id),
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
