import type { TurnAggregateV1 } from "./aggregate";
import { exhaustedRuntimeV2ResultKind } from "./completion";
import type {
  RuntimeV2Command,
  RuntimeV2CommandKind,
  RuntimeV2ExecutionValidationAuthority,
  RuntimeV2RecoveryScope,
  RuntimeV2ResultKind,
} from "./contracts";
import { RUNTIME_V2_RECOVERY_LIMITS, runtimeV2ActionFingerprint } from "./recovery";
import {
  MAX_RUNTIME_V2_READ_ONLY_SUBAGENTS,
  resolveRuntimeV2SubagentReferences,
  runtimeV2SubagentModelHandle,
} from "./subagents";
import {
  resolveRuntimeV2ExecutionContractValidation,
  runtimeV2ExecutionValidationAuthority,
} from "./executionContract";
import { deriveRuntimeV2ExecutionContractCoverage } from "./executionContractCoverage";
import {
  activeRuntimeV2ExecutionContractDraft as activeExecutionContractDraft,
  currentRuntimeV2PhaseEvents as currentPhaseEvents,
  latestRuntimeV2BrowserValidationTarget as latestBrowserValidationTarget,
  latestRuntimeV2ExecutionContractRejection as latestExecutionContractRejection,
  latestRuntimeV2RepeatedSourceTarget as latestRepeatedSourceTarget,
  requiredRuntimeV2ExecutionContractSourceTarget as requiredExecutionContractSourceTarget,
  requiredRuntimeV2MutationSourceTarget as requiredMutationSourceTarget,
  runtimeV2ActingExecutePolicy as actingExecutePolicy,
  runtimeV2ActingMutationProgressionRequired as actingMutationProgressionRequired,
  runtimeV2ExecutionEvidenceCatalog as executionEvidenceCatalog,
  runtimeV2ObservationContractRequired as observationContractRequired,
  runtimeV2ValidationParentTakeoverReadRequired as validationParentTakeoverReadRequired,
} from "./executionDecisionPolicy";
import {
  deriveRuntimeV2PlanExecutionCoverage,
  resolveRuntimeV2PlanValidationScope,
  runtimeV2PlanValidationAuthority,
} from "./planExecution";
import { isRuntimeV2WorkspaceReadToolName } from "./workspaceReadPolicy";
import { workspacePathsReferToSameFile } from "../workspacePaths";

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
    .filter((job) => job.status === "failed")
    .slice(-MAX_RUNTIME_V2_READ_ONLY_SUBAGENTS)
    .map((job) => ({
      id: runtimeV2SubagentModelHandle(job),
      name: job.name || job.scopeKey,
      objective: job.objective,
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
        event.status === "failed"
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
      ) ||
      event.type === "execution_contract.committed"
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

function successfulSourceActionAttemptCount(
  state: TurnAggregateV1,
  fingerprint: string,
): number {
  const commandKeys = new Set(state.completedCommands
    .filter((receipt) =>
      receipt.actionFingerprint === fingerprint &&
      receipt.status === "succeeded"
    )
    .map((receipt) => receipt.idempotencyKey));
  if (commandKeys.size === 0) return 0;
  return state.events.filter((event) =>
    event.type === "tool.completed" &&
    event.status === "succeeded" &&
    commandKeys.has(event.idempotencyKey) &&
    event.evidence.length > 0 &&
    event.evidence.every((evidence) => evidence.kind === "source")
  ).length;
}

function successfulSourceTargetAttemptCount(
  state: TurnAggregateV1,
  payload: Readonly<Record<string, unknown>>,
): number {
  const args = payload.arguments &&
      typeof payload.arguments === "object" &&
      !Array.isArray(payload.arguments)
    ? payload.arguments as Record<string, unknown>
    : {};
  const target = String(
    args.path || args.file_path || args.directory || args.target || "",
  ).trim();
  if (!target) return 0;
  return currentPhaseEvents(state).filter((event) =>
    event.type === "tool.completed" &&
    event.status === "succeeded" &&
    event.evidence.some((evidence) =>
      evidence.kind === "source" &&
      workspacePathsReferToSameFile(evidence.target, target) &&
      !!evidence.version
    )
  ).length;
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
  const unchangedSourceRepeats =
    kind === "execute_tool"
      ? Math.max(
          successfulSourceActionAttemptCount(state, fingerprint),
          successfulSourceTargetAttemptCount(state, payload),
        )
      : 0;
  const command = makeCommand(state, kind, payload);
  if (
    (
      failedAttempts >= RUNTIME_V2_RECOVERY_LIMITS.action ||
      unchangedSourceRepeats >= 2
    ) &&
    kind !== "request_model" &&
    kind !== "collect_observation"
  ) {
    // Refuse only this repeated structural action. The provider receives the
    // rejection as ordinary context and may choose another action; it never
    // becomes a Turn terminal merely because an action counter was reached.
    return {
      ...command,
      payload: {
        ...command.payload,
        repeatedActionRejected: true,
        repeatedActionReason:
          unchangedSourceRepeats >= 2
            ? "unchanged_source_repeat"
            : "failed_action_retry_limit",
      },
    };
  }
  return command;
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
    return [recoveryFinalization(
      state,
      state.recovery.exhausted.fingerprint,
      state.recovery.exhausted.reason,
      state.recovery.exhausted.scope === "transport"
        ? "error"
        : exhaustedRuntimeV2ResultKind(state),
      state.recovery.exhausted.scope,
    )];
  }
  if (state.pendingToolCalls.length > 0) {
    const toolCall = state.pendingToolCalls[0];
    if (toolCall.name === "submit_execution_contract") {
      return [boundedCommand(state, "commit_execution_contract", {
        toolCallId: toolCall.id,
        arguments: toolCall.arguments,
      })];
    }
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
    // Validation remains an evidence-gathering phase. A failed child handoff
    // may leave the parent needing one more safe source read before it can run
    // the authority-linked validator. Classify that read as an ordinary tool
    // observation so it cannot fabricate a validation receipt.
    const kind =
      state.phase === "validating" &&
        !isRuntimeV2WorkspaceReadToolName(toolCall.name)
        ? "execute_validation"
        : "execute_tool";
    let validationAuthority:
      | RuntimeV2ExecutionValidationAuthority
      | undefined;
    if (kind === "execute_validation" && state.executionContract) {
      const validation = resolveRuntimeV2ExecutionContractValidation({
        contract: state.executionContract,
        toolName: toolCall.name,
        args: toolCall.arguments,
      });
      if (validation) {
        validationAuthority = runtimeV2ExecutionValidationAuthority({
          contract: state.executionContract,
          validation,
        });
      }
    } else if (
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
    return [boundedCommand(state, kind, {
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      arguments: toolCall.arguments,
      ...(validationAuthority ? { validationAuthority } : {}),
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
      const repeatedSourceTarget =
        state.strategy === "execute" && !state.executionContract
          ? latestRepeatedSourceTarget(state)
          : null;
      const contractRequired =
        state.strategy === "execute" &&
        !state.executionContract &&
        observationContractRequired(state);
      const requiredContractSourceTarget =
        state.strategy === "execute" &&
        !state.executionContract
          ? requiredExecutionContractSourceTarget(state)
          : null;
      return [boundedCommand(state, "request_model", {
        mode: state.strategy === "analyze" ? "analyze" : "observe",
        toolExpectation:
          repeatedSourceTarget || requiredContractSourceTarget
            ? "required"
            : "optional",
        observationPolicy:
          requiredContractSourceTarget
            ? "execution_contract_source_required"
            : contractRequired
            ? "execution_contract_required"
            : repeatedSourceTarget
            ? "different_action_or_contract_required"
            : "evidence_gap_allowed",
        repeatedSourceTarget,
        requiredExecutionContractSourceTarget:
          requiredContractSourceTarget,
        objective: state.objective.text,
        acceptanceCriteria: state.objective.acceptanceCriteria.map(
          (criterion, index) => ({
            id:
              state.objective.acceptanceCriterionIds?.[index] ||
              `criterion-${index + 1}`,
            text: criterion,
          }),
        ),
        evidenceIds: state.evidence.map((item) => item.id),
        executionEvidenceCatalog: executionEvidenceCatalog(state),
        executionContractRejection:
          latestExecutionContractRejection(state),
        executionContractRevision:
          state.executionContract?.revision || null,
        ...collaborationPayload(state, input),
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
    case "acting": {
      const executePolicy = actingExecutePolicy(state);
      const mutationProgressionRequired =
        executePolicy === "mutation_required" &&
        actingMutationProgressionRequired(state);
      return [boundedCommand(state, "request_model", {
        mode: "execute",
        executePolicy,
        toolExpectation: "required",
        objective: state.objective.text,
        workPlanRevision: state.workPlan?.revision || null,
        executionContractRevision:
          state.executionContract?.revision || null,
        activeExecutionContractDraft:
          activeExecutionContractDraft(state),
        executionContractRejection:
          latestExecutionContractRejection(state),
        mutationProgressionRequired:
          mutationProgressionRequired,
        requiredMutationSourceTarget:
          requiredMutationSourceTarget(
            state,
            mutationProgressionRequired,
          ),
        evidenceIds: state.evidence.map((item) => item.id),
        executionEvidenceCatalog: executionEvidenceCatalog(state),
        ...collaborationPayload(state, input),
      })];
    }
    case "validating": {
      const executionCoverage =
        deriveRuntimeV2ExecutionContractCoverage(state);
      const planCoverage = deriveRuntimeV2PlanExecutionCoverage(state);
      const validationCoverageComplete = executionCoverage
        ? executionCoverage.missingValidationIds.length === 0 &&
          executionCoverage.missingCriterionIds.length === 0
        : planCoverage
          ? planCoverage.allRequiredValidationsPassed
          : false;
      return [boundedCommand(state, "request_model", {
        mode: validationCoverageComplete ? "conclude" : "validate",
        toolExpectation: validationCoverageComplete ? "optional" : "required",
        objective: state.objective.text,
        acceptanceCriteria: state.objective.acceptanceCriteria,
        evidenceIds: state.evidence.map((item) => item.id),
        executionContractRevision:
          state.executionContract?.revision || null,
        activeExecutionContractDraft:
          activeExecutionContractDraft(state),
        validationRetryTarget:
          latestBrowserValidationTarget(state),
        validationParentTakeoverReadRequired:
          validationParentTakeoverReadRequired(state),
        ...collaborationPayload(state, input),
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
