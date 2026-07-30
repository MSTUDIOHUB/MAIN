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
  resolveRuntimeV2SubagentReferences,
  runtimeV2SubagentModelHandle,
} from "./subagents";
import {
  deriveRuntimeV2PlanExecutionCoverage,
  resolveRuntimeV2PlanValidationScope,
  runtimeV2PlanValidationAuthority,
} from "./planExecution";
import {
  isRuntimeV2ValidationToolCall,
  runtimeV2DirectExecuteReadyForConclusion,
} from "./phaseTransition";
import {
  resolveRuntimeV2DirectExecuteValidationAuthority,
} from "./validationReceipt";

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
  /** Provider-lane capacity after reserving one request for the parent. */
  readonly subagentCapacity?: number;
}

function commaSeparatedValues(value: unknown): string[] {
  return String(value || "")
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function collaborationPayload(
  state: TurnAggregateV1,
  input: RuntimeV2DecisionInput,
): Readonly<Record<string, unknown>> {
  const collaborationAllowed =
    input.subagentPreference === "allowed" ||
    input.subagentPreference === "preferred";
  const maxActiveSubagents = Math.max(
    0,
    Math.floor(Number(input.subagentCapacity) || 0),
  );
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
    .slice(-Math.max(1, maxActiveSubagents))
    .map((job) => ({
      id: runtimeV2SubagentModelHandle(job),
      name: job.name || job.scopeKey,
      objective: job.objective,
      status: job.status,
      summary: job.summary || "No structured report was committed.",
    }));
  return {
    collaborationAllowed,
    collaborationPreferred:
      input.subagentPreference === "preferred",
    collaborationAction:
      activeSubagents.length > 0
        ? "children_active"
        : "optional",
    activeSubagents,
    failedSubagents,
    maxActiveSubagents,
    remainingSubagentCapacity: Math.max(
      0,
      maxActiveSubagents - activeSubagents.length,
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

function executeReadyForConclusion(state: TurnAggregateV1): boolean {
  const planCoverage = deriveRuntimeV2PlanExecutionCoverage(state);
  if (planCoverage) {
    return planCoverage.allMutationTargetsCovered &&
      planCoverage.allRequiredValidationsPassed;
  }
  return runtimeV2DirectExecuteReadyForConclusion(state);
}

/**
 * Source evidence is necessary authority for an edit, but it is not itself a
 * workspace effect. Keep this pressure active across additional reads until a
 * mutation commits. The provider still retains every safe read tool; this
 * durable fact only distinguishes "more evidence" from "objective advanced".
 */
export function deriveRuntimeV2EffectPressure(
  state: TurnAggregateV1,
): {
  readonly schemaVersion: "runtime-v2-effect-pressure.v1";
  readonly reason: "source_only_frontier";
  readonly mutationBoundarySequence: number;
  readonly sourceBoundarySequence: number;
  readonly latestSourceEvidenceId: string;
} | null {
  let mutationBoundarySequence = 0;
  let sourceBoundarySequence = 0;
  let latestSourceEvidenceId = "";

  for (const event of state.events) {
    if (
      event.type !== "tool.completed" ||
      event.status !== "succeeded"
    ) {
      continue;
    }
    if (event.evidence.some((evidence) => evidence.kind === "mutation")) {
      mutationBoundarySequence = event.sequence;
      sourceBoundarySequence = 0;
      latestSourceEvidenceId = "";
      continue;
    }
    if (event.receiptOrigin === "replayed") continue;
    const source = [...event.evidence].reverse().find((evidence) =>
      evidence.kind === "source" && !!evidence.version
    );
    if (!source) continue;
    sourceBoundarySequence = event.sequence;
    latestSourceEvidenceId = source.id;
  }

  return sourceBoundarySequence > mutationBoundarySequence &&
      !!latestSourceEvidenceId
    ? {
        schemaVersion: "runtime-v2-effect-pressure.v1",
        reason: "source_only_frontier",
        mutationBoundarySequence,
        sourceBoundarySequence,
        latestSourceEvidenceId,
      }
    : null;
}

function executeModelRequest(
  state: TurnAggregateV1,
  input: RuntimeV2DecisionInput,
): RuntimeV2Command {
  const ready = executeReadyForConclusion(state);
  const mode = ready
    ? "conclude"
    : state.phase === "validating"
      ? "validate"
      : "execute";
  const effectPressure = mode === "execute"
    ? deriveRuntimeV2EffectPressure(state)
    : null;
  return boundedCommand(state, "request_model", {
    mode,
    objective: state.objective.text,
    acceptanceCriteria: state.objective.acceptanceCriteria,
    evidenceIds: state.evidence.map((item) => item.id),
    hasVersionedSourceEvidence: state.evidence.some(
      (item) => item.kind === "source" && !!item.version,
    ),
    ...(effectPressure ? { effectPressure } : {}),
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
        maxActiveSubagents: Math.max(
          0,
          Math.floor(Number(input.subagentCapacity) || 0),
        ),
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
    const kind = isRuntimeV2ValidationToolCall(toolCall)
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
    if (
      kind === "execute_validation" &&
      !validationAuthority &&
      state.strategy === "execute"
    ) {
      validationAuthority =
        resolveRuntimeV2DirectExecuteValidationAuthority({
          aggregate: state,
          turnId: state.turn.turnId,
          objective: state.objective,
          validationId: toolCall.id,
        }) || undefined;
    }
    const executionArguments = kind === "execute_validation"
      ? Object.fromEntries(
          Object.entries(toolCall.arguments).filter(([key]) =>
            key !== "criterion_ids" && key !== "target_paths"
          ),
        )
      : toolCall.arguments;
    const command = boundedCommand(state, kind, {
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      arguments: executionArguments,
      ...(validationAuthority ? { validationAuthority } : {}),
    });
    return [command];
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
