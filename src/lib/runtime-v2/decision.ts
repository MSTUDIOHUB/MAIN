import { runtimeV2PendingGuidance } from "./guidance";
import type { RuntimeV2ProviderRecoveryPressure, RuntimeV2ProviderRecoveryWindow } from "./providerRecovery";
export type { RuntimeV2ProviderRecoveryPressure, RuntimeV2ProviderRecoveryWindow } from "./providerRecovery";
import type { TurnAggregateV1 } from "./aggregate";
import type { RuntimeV2ProactiveSkipReason } from "./collaborationDecision";
import { deriveUnityCompilation, deriveUnityShaderImport, nextUnityEditorCheck, unresolvedUnityEditorCheck, UNITY_COMPILE_PROJECT_TOOL } from "./unityCompilation";
import { analyzeValidationCommand } from "../validationContract";
import { deriveReadOnlyRecoveryWindow } from "./readOnlyProgress";
import { exhaustedRuntimeV2ResultKind } from "./completion";
import { runtimeV2ProviderAnswerText } from "./providerAnswer";
import type {
  RuntimeV2Command,
  RuntimeV2CommandKind,
  RuntimeV2ExecutionValidationAuthority,
  RuntimeV2ResultKind,
} from "./contracts";
import type { RuntimeV2Event } from "./events";
import { runtimeV2ActionFingerprint } from "./recovery";
import { isRuntimeV2ValidationAttempt } from "./validationAttempt";
import { deriveRuntimeV2ExecutionContract } from "./executionContract";
import {
  resolveRuntimeV2SubagentReferences,
  runtimeV2SubagentModelHandle,
  type RuntimeV2SubagentScopeCandidate,
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
  deriveRuntimeV2ValidationBoundary,
  latestRuntimeV2WorkspaceChange,
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
  /** Admission-time collaboration policy, independent of a hard requirement. */
  readonly subagentPreference?:
    | "unspecified"
    | "forbidden"
    | "allowed"
    | "preferred";
  /** Provider-lane capacity after reserving one request for the parent. */
  readonly subagentCapacity?: number;
  /** Whether the admitted parent/child provider requests can really overlap. */
  readonly subagentRequestMode?: "parallel" | "serialized";
  readonly proactiveCollaboration?: { readonly candidate: RuntimeV2SubagentScopeCandidate } | { readonly reason: RuntimeV2ProactiveSkipReason };
  readonly settledProactiveJobIds?: readonly string[];
  readonly checkUnityCompilation?: boolean;
  readonly projectValidationRecovery?: { readonly command: string; readonly manifestVersion: string };
}

function commaSeparatedValues(value: unknown): string[] {
  return String(value || "")
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function currentRunSubagents(state: TurnAggregateV1) {
  const parentRunId = state.run?.identity.runId;
  return parentRunId
    ? state.subagents.filter((job) => job.parentRunId === parentRunId)
    : [];
}

function admittedMaxChildRuns(
  state: TurnAggregateV1,
  currentCapacity: number,
): number {
  const currentRunId = state.run?.identity.runId;
  let admittedMaximum = 0;
  let foundAdmission = false;
  for (const event of state.events) {
    if (
      event.type !== "command.scheduled" ||
      event.command.kind !== "request_model" ||
      event.command.run.runId !== currentRunId
    ) {
      continue;
    }
    const admitted = Number(event.command.payload.maxChildRuns);
    if (Number.isSafeInteger(admitted) && admitted >= 0) {
      admittedMaximum = Math.max(admittedMaximum, admitted);
      foundAdmission = true;
    }
  }
  return foundAdmission
    ? Math.max(admittedMaximum, currentCapacity)
    : currentCapacity;
}

export function runtimeV2CollaborationPayload(
  state: TurnAggregateV1,
  input: RuntimeV2DecisionInput,
): Readonly<Record<string, unknown>> {
  const collaborationAllowed =
    input.subagentPreference === "allowed" ||
    input.subagentPreference === "preferred";
  const currentCapacity = Math.max(
    0,
    Math.floor(Number(input.subagentCapacity) || 0),
  );
  // Keep the legacy capacity observation for persisted-command compatibility.
  // It is not an admitted total task budget: queued jobs acquire the existing
  // model lane before any provider request can start.
  const maxChildRuns = admittedMaxChildRuns(state, currentCapacity);
  const maxActiveSubagents = currentCapacity;
  const runSubagents = currentRunSubagents(state);
  const activeSubagents = runSubagents
    .filter((job) => job.status === "queued" || job.status === "running")
    .map((job) => ({
      id: runtimeV2SubagentModelHandle(job),
      name: job.name || job.scopeKey,
      objective: job.objective,
    }));
  const failedSubagents = runSubagents
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
    collaborationRequestMode:
      input.subagentRequestMode ||
      (currentCapacity > 0 ? "parallel" : "serialized"),
    collaborationAction:
      activeSubagents.length > 0
        ? "children_active"
        : "optional",
    ...((input.proactiveCollaboration && "reason" in input.proactiveCollaboration)
      ? { proactiveSkipReason: input.proactiveCollaboration.reason }
      : {}),
    activeSubagents,
    failedSubagents,
    maxActiveSubagents,
    maxChildRuns,
    // Explicitly requested jobs can queue. Proactive dispatch checks free
    // slots separately, and the lane admits only as many streams as it can run.
    remainingSubagentCapacity: maxActiveSubagents,
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
  // `completedCommands` is a bounded replay cache. Command identity must be
  // derived from the canonical ledger or its attempt number can roll back
  // when an old receipt leaves that cache.
  return state.events.filter((event) =>
    event.type === "command.scheduled" &&
    runtimeV2ActionFingerprint(event.command) === fingerprint
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
  const guidance = kind === "request_model" ? runtimeV2PendingGuidance(state) : undefined;
  const commandPayload = guidance ? { ...payload, guidanceId: guidance.eventId } : payload;
  const fingerprint = actionFingerprint(state, kind, commandPayload);
  const attempt = actionAttemptCount(state, fingerprint) + 1;
  return {
    idempotencyKey: deterministicCommandKey(state, kind, fingerprint, attempt),
    kind,
    run: state.run.identity,
    phase: state.phase,
    payload: {
      ...commandPayload,
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
  // A passing intermediate check does not say that the provider has finished
  // the complete objective. Ordinary Execute keeps its action surface until
  // a natural final; explicit implementation contracts retain their boundary.
  if (state.strategy === "execute" && !deriveRuntimeV2ExecutionContract(state)) return false;
  return runtimeV2DirectExecuteReadyForConclusion(state);
}

function providerRequestCommandKeys(
  events: readonly RuntimeV2Event[],
): ReadonlySet<string> {
  return new Set(events.flatMap((event) =>
    event.type === "command.scheduled" &&
      event.command.kind === "request_model"
      ? [event.command.idempotencyKey]
      : []
  ));
}

function providerRequestModesByCommandKey(
  events: readonly RuntimeV2Event[],
): ReadonlyMap<string, string> {
  return new Map(events.flatMap((event) =>
    event.type === "command.scheduled" &&
      event.command.kind === "request_model"
      ? [[
          event.command.idempotencyKey,
          String(event.command.payload.mode || "").trim(),
        ] as const]
      : []
  ));
}

function providerToolCallProgress(
  events: readonly RuntimeV2Event[],
  novelSequences: ReadonlySet<number>,
): {
  readonly progressed: ReadonlySet<string>;
  readonly settledWithoutProgress: ReadonlySet<string>;
} {
  const toolCallIdByCommandKey = new Map<string, string>();
  for (const event of events) {
    if (event.type !== "command.scheduled") continue;
    const toolCallId = String(event.command.payload.toolCallId || "").trim();
    if (toolCallId) {
      toolCallIdByCommandKey.set(event.command.idempotencyKey, toolCallId);
    }
  }
  const progressed = new Set<string>();
  const settledWithoutProgress = new Set<string>();
  for (const event of events) {
    if (event.type === "tool.completed") {
      const toolCallId = toolCallIdByCommandKey.get(event.idempotencyKey);
      if (!toolCallId) continue;
      if (novelSequences.has(event.sequence)) progressed.add(toolCallId);
      else settledWithoutProgress.add(toolCallId);
      continue;
    }
    if (event.type !== "validation.completed") continue;
    const toolCallId = toolCallIdByCommandKey.get(event.idempotencyKey);
    if (!toolCallId) continue;
    if (
      isRuntimeV2ValidationAttempt(event) && (event.passed ||
      event.failureKind === "assertion_failed" ||
      event.failureKind === "execution_failed" ||
      !event.failureKind)
    ) {
      progressed.add(toolCallId);
    } else {
      settledWithoutProgress.add(toolCallId);
    }
  }
  return { progressed, settledWithoutProgress };
}

/**
 * Derive one bounded recovery fact from the canonical ledger. The count is not
 * a completion or authorization rule: it selects a materially different next
 * decision prompt while the task remains open.
 */
export function deriveRuntimeV2ProviderRecoveryWindow(
  state: TurnAggregateV1,
): RuntimeV2ProviderRecoveryWindow | null {
  if (state.strategy === "chat" || state.strategy === "analyze") return deriveReadOnlyRecoveryWindow(state);
  if (state.pendingToolCalls.length > 0) return null;
  const providerRequestKeys = providerRequestCommandKeys(state.events);
  const providerRequestModes = providerRequestModesByCommandKey(state.events);
  let occurrence = 0;
  let latestReason: RuntimeV2ProviderRecoveryPressure["reason"] | null = null;
  let startedAt = 0;
  const novelSequences = new Set<number>();
  const facts = new Set<string>();
  for (const event of state.events) {
    const evidence = event.type === "tool.completed" && event.status === "succeeded" && event.receiptOrigin !== "replayed" ? event.evidence
      : event.type === "observation.recorded" ? [event.evidence]
      : event.type === "subagent.completed" && event.status === "completed" ? event.evidence : [];
    for (const item of evidence) {
      const key = JSON.stringify([item.kind, item.target, item.version, event.type === "tool.completed" ? event.modelContent : undefined]);
      if (!facts.has(key)) { facts.add(key); novelSequences.add(event.sequence); }
    }
  }
  const toolCallProgress = providerToolCallProgress(state.events, novelSequences);

  for (let index = state.events.length - 1; index >= 0; index -= 1) {
    const event = state.events[index]!;
    if (event.type === "provider.responded") {
      const requestMode = providerRequestModes.get(event.idempotencyKey) || "";
      const executableProgressRequired =
        requestMode === "execute" || requestMode === "validate";
      const repeated = event.result.diagnostics.some((diagnostic) =>
        diagnostic.code === "repeated_action_rejected"
      );
      const failedToolDecision = event.result.toolCalls.length > 0 &&
        event.result.toolCalls.every((call) =>
          toolCallProgress.settledWithoutProgress.has(call.id) &&
          !toolCallProgress.progressed.has(call.id)
        );
      const answerText = runtimeV2ProviderAnswerText(state, event);
      const nonActionable =
        (event.result.toolCalls.length === 0 || failedToolDecision) &&
        (
          executableProgressRequired ||
          !answerText
        );
      if (!nonActionable) break;
      occurrence += 1;
      startedAt = event.at;
      if (!latestReason) {
        latestReason = repeated
          ? "repeated_action_rejected"
          : failedToolDecision
            ? "tool_execution_failed"
            : event.result.diagnostics.length > 0
              ? "provider_response_rejected"
              : answerText
                ? "non_actionable_response"
                : "empty_response";
      }
      continue;
    }
    if (
      event.type === "command.completed" &&
      event.status === "failed" &&
      providerRequestKeys.has(event.idempotencyKey)
    ) {
      occurrence += 1;
      startedAt = event.at;
      latestReason ||= "provider_request_failed";
      continue;
    }
    if (event.type === "tool.completed") {
      if (novelSequences.has(event.sequence)) break;
      continue;
    }
    if (event.type === "validation.completed") {
      if (
        isRuntimeV2ValidationAttempt(event) && (event.passed ||
        event.failureKind === "assertion_failed" ||
        event.failureKind === "execution_failed" ||
        !event.failureKind)
      ) {
        break;
      }
      continue;
    }
    if (
      (event.type === "observation.recorded" && novelSequences.has(event.sequence)) ||
      event.type === "work_plan.sealed" ||
      event.type === "work_plan.approved" ||
      event.type === "work_plan.invalidated" ||
      (event.type === "subagent.completed" && novelSequences.has(event.sequence)) ||
      event.type === "subagent.handoff_applied" ||
      event.type === "run.started" || event.type === "run.resumed"
    ) {
      break;
    }
  }

  if (!latestReason || occurrence === 0) return null;
  let waitStart: number | null = null;
  let waited = 0;
  for (const event of state.events) {
    if (event.at < startedAt) continue;
    if (event.type === "run.wait_started") waitStart ??= event.at;
    if (event.type === "run.wait_ended" && waitStart !== null) { waited += event.at - waitStart; waitStart = null; }
  }
  if (waitStart !== null) waited += state.updatedAt - waitStart;
  return {
    startedAt: startedAt + waited,
    pressure: {
      schemaVersion: "runtime-v2-provider-recovery.v1",
      reason: latestReason,
      occurrence,
      stage: occurrence === 1
        ? "reconsider"
        : occurrence === 2
          ? "reframe"
          : "alternative",
    },
  };
}

export function deriveRuntimeV2ProviderRecoveryPressure(
  state: TurnAggregateV1,
): RuntimeV2ProviderRecoveryPressure | null {
  return deriveRuntimeV2ProviderRecoveryWindow(state)?.pressure || null;
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
  const mutationBoundarySequence = latestRuntimeV2WorkspaceChange(state)?.sequence ?? 0;
  let sourceBoundarySequence = 0;
  let latestSourceEvidenceId = "";

  for (const event of state.events) {
    if (
      event.sequence <= mutationBoundarySequence ||
      event.type !== "tool.completed" ||
      event.status !== "succeeded"
    ) {
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
  const compilation = unresolvedUnityEditorCheck(state);
  // A missing Editor verdict stays pending in the terminal result.
  // Only an observed failure keeps this request in correction mode.
  const ready = compilation?.result.status !== "failed" &&
    !runtimeV2PendingGuidance(state) && executeReadyForConclusion(state);
  const mode = ready
    ? "conclude"
    : state.phase === "validating" && compilation?.result.status !== "failed"
      ? "validate"
      : "execute";
  const effectPressure = mode === "execute"
    ? deriveRuntimeV2EffectPressure(state)
    : null;
  const recoveryPressure = mode === "execute" || mode === "validate"
    ? deriveRuntimeV2ProviderRecoveryPressure(state)
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
    ...(recoveryPressure ? { recoveryPressure } : {}),
    ...runtimeV2CollaborationPayload(state, input),
  });
}

function projectValidationRecoveryCommand(state: TurnAggregateV1, option: RuntimeV2DecisionInput["projectValidationRecovery"]): RuntimeV2Command | undefined {
  if (!option || state.strategy !== "execute" || state.workPlan || state.sealedWorkPlan ||
      deriveRuntimeV2ExecutionContract(state) || runtimeV2PendingGuidance(state) ||
      state.objective.acceptanceEvidenceRequirements?.includes("interaction") ||
      state.objective.capabilityRestrictions?.includes("workspace_read") || state.objective.approvalRequiredCapabilities?.includes("workspace_read") ||
      unresolvedUnityEditorCheck(state) || runtimeV2DirectExecuteReadyForConclusion(state) ||
      deriveRuntimeV2ProviderRecoveryPressure(state)?.reason !== "non_actionable_response") return;
  const spec = analyzeValidationCommand(option.command).spec;
  if (spec?.kind !== "finite_command" || spec.capability !== "test" || !/^sha256-[a-f0-9]{64}$/.test(option.manifestVersion)) return;
  const { mutationBoundarySequence } = deriveRuntimeV2ValidationBoundary(state, []);
  const checkedLatestMutation = [deriveUnityCompilation(state), deriveUnityShaderImport(state)].some(check =>
    check?.sequence === mutationBoundarySequence && check.receipt?.result.status === "passed");
  if (!checkedLatestMutation || state.events.some(event => event.sequence > mutationBoundarySequence &&
    "run" in event && event.run.runId === state.run?.identity.runId &&
    (event.type === "validation.completed" && isRuntimeV2ValidationAttempt(event) ||
      event.type === "command.scheduled" && event.command.payload.projectValidationManifestVersion))) return;
  const validationAuthority = resolveRuntimeV2DirectExecuteValidationAuthority({ aggregate: state,
    turnId: state.turn.turnId, objective: state.objective, validationId: `project-test:${mutationBoundarySequence}` });
  if (!validationAuthority) return;
  return boundedCommand(state, "execute_validation", {
    toolName: "run_command", arguments: { command: spec.command, description: "Run the project's declared test suite" },
    validationAuthority, projectValidationManifestVersion: option.manifestVersion,
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
  if (state.run?.status === "paused") return [];
  if (!state.run || state.run.status === "completed" || state.terminalOutcome) return [];
  if (state.scheduledCommands.length > 0) return [];
  if (input.resultKind && input.resultReason) {
    if ((input.resultKind === "success" || input.resultKind === "partial") &&
      runtimeV2PendingGuidance(state) && !state.recovery.exhausted && !state.pendingToolCalls.length &&
      state.phase !== "finalizing" && state.phase !== "reviewing") {
      if (state.strategy === "execute" || state.workPlan?.status === "approved") return [executeModelRequest(state, input)];
      if (state.strategy === "chat" || state.strategy === "analyze") {
        return [boundedCommand(state, "request_model", {
          mode: state.strategy, toolExpectation: "optional",
          objective: state.objective.text, evidenceIds: state.evidence.map(item => item.id),
        })];
      }
    }
    const activeJobIds = currentRunSubagents(state)
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
    const activeJobIds = currentRunSubagents(state)
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
  if (input.checkUnityCompilation) {
    const compilation = nextUnityEditorCheck(state);
    if (compilation) {
      return [boundedCommand(state, "execute_tool", {
        toolName: UNITY_COMPILE_PROJECT_TOOL,
        runtimeOwnedUnityCompile: true,
        editorCheckKind: compilation.kind,
        ...(compilation.importTargets ? { shaderImportTargets: compilation.importTargets } : {}),
        mutationSequence: compilation.sequence,
        target: compilation.targets.join(", "),
      })];
    }
    return [];
  }
  if (state.pendingToolCalls.length > 0) {
    const toolCall = state.pendingToolCalls[0];
    if (toolCall.name === "spawn_subagent") {
      const collaboration = runtimeV2CollaborationPayload(state, input);
      return [boundedCommand(state, "schedule_subagents", {
        toolCallId: toolCall.id,
        arguments: toolCall.arguments,
        maxActiveSubagents: collaboration.maxActiveSubagents,
        maxChildRuns: collaboration.maxChildRuns,
        collaborationRequestMode:
          collaboration.collaborationRequestMode,
      })];
    }
    if (toolCall.name === "wait_subagents") {
      const requested = [
        ...commaSeparatedValues(toolCall.arguments.subagent_ids),
        ...commaSeparatedValues(toolCall.arguments.collaboration_task_ids),
      ];
      const activeJobs = currentRunSubagents(state)
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
        aggregate: state,
        toolName: toolCall.name,
        args: toolCall.arguments,
      });
      const validationIndex = scope.allowed
        ? scope.matchingValidationIndexes[0]
        : undefined;
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
    const collaboration = runtimeV2CollaborationPayload(state, input);
    const command = boundedCommand(state, kind, {
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      arguments: executionArguments,
      collaborationPreferred: collaboration.collaborationPreferred,
      collaborationAction: collaboration.collaborationAction,
      maxActiveSubagents: collaboration.maxActiveSubagents,
      maxChildRuns: collaboration.maxChildRuns,
      ...(validationAuthority ? { validationAuthority } : {}),
    });
    return [command];
  }

  const settledProactive = currentRunSubagents(state).filter(job => job.proactiveKey &&
    (job.status === "queued" || job.status === "running") && input.settledProactiveJobIds?.includes(job.id));
  if (settledProactive.length) return [boundedCommand(state, "join_subagents", { jobIds: settledProactive.map(job => job.id) })];
  if (input.subagentPreference === "preferred" && state.subagentRequirement !== "required" &&
      input.subagentRequestMode === "parallel" && input.subagentCapacity &&
      input.proactiveCollaboration && "candidate" in input.proactiveCollaboration) {
    const candidate = input.proactiveCollaboration.candidate;
    if (candidate.proactiveKey && candidate.accessMode === "read" && candidate.taskKind !== "implement") {
      return [boundedCommand(state, "schedule_subagents", {
        proactiveKey: candidate.proactiveKey,
        arguments: { task_key: candidate.scopeKey, name: candidate.name, task_kind: candidate.taskKind, access_mode: "read",
          objective: candidate.objective, success_criteria: candidate.successCriteria, allowed_paths: candidate.allowedPaths.join("\n") },
        maxActiveSubagents: input.subagentCapacity,
        collaborationRequestMode: input.subagentRequestMode,
      })];
    }
  }

  switch (state.phase) {
    case "preparing":
      return [boundedCommand(state, "collect_observation", {
        objective: state.objective.text,
        acceptanceCriteria: state.objective.acceptanceCriteria,
      })];
    case "observing": {
      if (state.strategy === "chat" || state.strategy === "analyze") {
        const recovery = deriveReadOnlyRecoveryWindow(state);
        return [boundedCommand(state, "request_model", {
          mode: state.strategy,
          toolExpectation: "optional",
          objective: state.objective.text,
          evidenceIds: state.evidence.map((item) => item.id),
          ...(recovery ? { recoveryPressure: recovery.pressure } : {}),
          ...(state.strategy === "analyze" ? runtimeV2CollaborationPayload(state, input) : {}),
        })];
      }
      return [executeModelRequest(state, input)];
    }
    case "planning":
      return [boundedCommand(state, "request_model", {
        mode: "plan",
        objective: state.objective.text,
        evidenceIds: state.evidence.map((item) => item.id),
        ...runtimeV2CollaborationPayload(state, input),
      })];
    case "reviewing":
      return [];
    case "validating":
      return [projectValidationRecoveryCommand(state, input.projectValidationRecovery) || executeModelRequest(state, input)];
    case "acting":
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
