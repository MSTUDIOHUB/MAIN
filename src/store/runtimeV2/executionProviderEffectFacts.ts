import type {
  RuntimeV2Command,
  TurnAggregateV1,
} from "../../lib/runtime-v2";
import {
  isWorkspaceMutationToolName,
  resolveWorkspaceMutationTargets,
} from "../../lib/workspaceMutationTools";
import {
  runtimeV2ProviderToolCallIdentity,
} from "./providerReadReceipts";

export interface RuntimeV2ProviderEffectFacts {
  /** Runtime-scoped provider tool-call id -> committed mutation targets.
   *
   * This projection is derived from the durable command/effect ledger. The
   * provider transcript is transport history and must never infer that a
   * mutation committed merely because a tool message exists. */
  readonly committedMutationTargetsByToolCallId:
    ReadonlyMap<string, readonly string[]>;
  /** Provider tool-call ids whose successful pair was closed with an
   * already-committed read receipt rather than a second workspace read.
   *
   * Replay is control state owned by the durable effect ledger. It must not
   * be encoded into the source text shown to the model. */
  readonly replayedToolCallIds: ReadonlySet<string>;
  /** Count of cached source receipts re-materialized since the latest
   * committed mutation. The first replay is allowed to restore an evicted
   * source; once that exact source is visible again, another inspection
   * decision would be workset cycling rather than a new evidence frontier. */
  readonly replayedSourceReceiptCountSinceMutation: number;
  /** Successful source reads proven by the effect ledger. Failed/rejected
   * tool text must never replace a current source artifact in the workset. */
  readonly sourceReadVersionsByToolCallId: ReadonlyMap<string, {
    readonly target: string;
    readonly version: string;
  }>;
  /** Source receipts invalidated by a committed child transaction that has no
   * parent provider tool-call pair. They remain transport history but cannot
   * grant cache replay, action identity, or mutation authority. */
  readonly invalidatedSourceReadToolCallIds: ReadonlySet<string>;
  /** A correctable failed editor reopens one cache replay for that exact
   * target. This fact comes from the durable command/effect ledger so restart
   * cannot change the recovery surface. */
  readonly correctiveReplayTargetsByToolCallId?:
    ReadonlyMap<string, readonly string[]>;
  /** Correctable workspace-mutation failures whose bounded diagnostic must
   * remain in the active decision view across the source replay they request.
   * The rejected patch body stays redacted; this durable id set preserves the
   * causal result until a mutation commits and establishes a new boundary. */
  readonly correctiveMutationFailureToolCallIds?: ReadonlySet<string>;
  /** Exact failed editor request owned by each corrective failure. This is
   * control evidence only: it lets the action window prove that a newly
   * materialized source range actually covers the rejected mutation instead
   * of treating any prefix from the same file as sufficient. The provider
   * patch body is never rendered back into the recovery prompt. */
  readonly correctiveMutationRequirementsByToolCallId?: ReadonlyMap<
    string,
    {
      /** Durable event order for resolving competing recovery frontiers. */
      readonly sequence?: number;
      readonly toolName: string;
      readonly arguments: Readonly<Record<string, unknown>>;
      readonly target: string;
      readonly reasonCode: string;
    }
  >;
  /** Latest failed validation may remain beside newer source/recovery
   * frontiers. The durable validation ledger, never tool-result prose,
   * identifies which provider call owns that fact. */
  readonly failedValidationToolCallIds?: ReadonlySet<string>;
  /** Exact deterministic action failures since the latest committed mutation.
   * This set is derived from the canonical command/effect ledger, so it
   * survives checkpoint restore and has no process-local capacity limit. */
  readonly rejectedActionIdentities: ReadonlySet<string>;
  /** Observation or validation tools that returned the same non-empty result
   * for two materially different actions since the latest committed mutation.
   * Changing only query/path/command syntax cannot manufacture a new evidence
   * frontier from an equivalent diagnostic. */
  readonly repeatedObservationToolNames: ReadonlySet<string>;
}

const RESULT_SEMANTIC_TOOL_NAMES = new Set([
  "grep_search",
  "glob_search",
  "repo_map_search",
  "repo_map_context",
  "code_ast_query",
  "find_symbol_references",
  "git_status",
  "git_diff",
  "run_command",
  "browser_evaluate",
]);

export function deriveRuntimeV2ProviderEffectFacts(
  aggregate: TurnAggregateV1 | null,
): RuntimeV2ProviderEffectFacts {
  const toolCallIdsByCommand = new Map<string, string>();
  const commandsByIdempotencyKey =
    new Map<string, RuntimeV2Command>();
  for (const event of aggregate?.events || []) {
    if (event.type !== "command.scheduled") continue;
    commandsByIdempotencyKey.set(
      event.command.idempotencyKey,
      event.command,
    );
    const toolCallId = String(
      event.command.payload.toolCallId || "",
    ).trim();
    if (toolCallId) {
      toolCallIdsByCommand.set(
        event.command.idempotencyKey,
        toolCallId,
      );
    }
  }

  const committedMutationTargetsByToolCallId =
    new Map<string, readonly string[]>();
  const replayedToolCallIds = new Set<string>();
  let replayedSourceReceiptCountSinceMutation = 0;
  const sourceReadVersionsByToolCallId = new Map<string, {
    readonly target: string;
    readonly version: string;
  }>();
  const failedValidationToolCallIds = new Set<string>();
  const invalidatedSourceReadToolCallIds = new Set<string>();
  const correctiveReplayTargetsByToolCallId =
    new Map<string, readonly string[]>();
  const correctiveMutationFailureToolCallIds = new Set<string>();
  const correctiveMutationRequirementsByToolCallId = new Map<
    string,
    {
      readonly sequence?: number;
      readonly toolName: string;
      readonly arguments: Readonly<Record<string, unknown>>;
      readonly target: string;
      readonly reasonCode: string;
    }
  >();
  const rejectedActionIdentities = new Set<string>();
  const observationActionsByFingerprint =
    new Map<string, Set<string>>();
  const repeatedObservationToolNames = new Set<string>();
  for (const event of aggregate?.events || []) {
    if (event.type !== "validation.completed" || event.passed) continue;
    const toolCallId = toolCallIdsByCommand.get(event.idempotencyKey);
    if (toolCallId) failedValidationToolCallIds.add(toolCallId);
  }
  for (const event of aggregate?.events || []) {
    if (
      event.type === "subagent.completed" &&
      event.status === "completed" &&
      event.evidence.some((evidence) => evidence.kind === "mutation")
    ) {
      for (const toolCallId of sourceReadVersionsByToolCallId.keys()) {
        invalidatedSourceReadToolCallIds.add(toolCallId);
      }
      correctiveMutationFailureToolCallIds.clear();
      correctiveMutationRequirementsByToolCallId.clear();
      rejectedActionIdentities.clear();
      observationActionsByFingerprint.clear();
      repeatedObservationToolNames.clear();
      replayedSourceReceiptCountSinceMutation = 0;
      continue;
    }
    if (event.type !== "tool.completed") continue;
    const command = commandsByIdempotencyKey.get(
      event.idempotencyKey,
    );
    const targets = [...new Set(
      event.evidence
        .filter((evidence) => evidence.kind === "mutation")
        .map((evidence) => String(evidence.target || "").trim())
        .filter(Boolean),
    )];
    const toolCallId = toolCallIdsByCommand.get(event.idempotencyKey);
    const rawArguments = command?.payload.arguments;
    const argumentsValue =
      rawArguments &&
        typeof rawArguments === "object" &&
        !Array.isArray(rawArguments)
        ? rawArguments as Record<string, unknown>
        : {};
    const toolName = String(
      command?.payload.toolName || "",
    ).trim();
    const mutationLeaseFailure =
      event.failureReasonCode === "mutation_source_lease_missing" ||
      event.failureReasonCode === "mutation_source_text_mismatch" ||
      event.failureReasonCode === "mutation_target_lease_mismatch";
    if (
      toolCallId &&
      toolName &&
      isWorkspaceMutationToolName(toolName) &&
      event.status !== "succeeded" &&
      (
        event.failureKind === "source_mismatch" ||
        event.failureKind === "mutation_rejected" ||
        mutationLeaseFailure
      )
    ) {
      const mismatchTargets = [...new Set(
        resolveWorkspaceMutationTargets(
          toolName,
          argumentsValue,
          event.presentation?.target || "",
        )
          .map((target) => String(target || "").trim())
          .filter(Boolean),
      )];
      if (mismatchTargets.length > 0) {
        correctiveReplayTargetsByToolCallId.set(
          toolCallId,
          mismatchTargets,
        );
      }
      correctiveMutationFailureToolCallIds.add(toolCallId);
      correctiveMutationRequirementsByToolCallId.set(toolCallId, {
        ...(Number.isFinite(event.sequence)
          ? { sequence: event.sequence }
          : {}),
        toolName,
        arguments: argumentsValue,
        target: String(event.presentation?.target || "").trim(),
        reasonCode: String(event.failureReasonCode || "").trim(),
      });
    }
    if (
      command?.kind === "execute_tool" &&
      event.status !== "succeeded" &&
      (
        event.failureKind === "protocol_invalid" ||
        event.failureKind === "mutation_rejected" ||
        event.failureKind === "source_mismatch" ||
        event.failureKind === "target_invalid"
      )
    ) {
      if (toolName) {
        rejectedActionIdentities.add(
          runtimeV2ProviderToolCallIdentity({
            name: toolName,
            arguments: argumentsValue,
          }),
        );
      }
    }
    if (toolCallId && event.receiptOrigin === "replayed") {
      replayedToolCallIds.add(toolCallId);
      replayedSourceReceiptCountSinceMutation += 1;
    }
    const source = event.evidence.find(
      (evidence) => evidence.kind === "source",
    );
    if (toolCallId && source) {
      sourceReadVersionsByToolCallId.set(toolCallId, {
        target: String(source.target || "").trim(),
        version: String(source.version || "").trim(),
      });
    }
    const observation = event.evidence.find((evidence) =>
      evidence.kind === "source" || evidence.kind === "tool"
    );
    const observationVersion = String(
      observation?.version || "",
    ).trim();
    const observationSummary = String(
      event.presentation?.observationSummary || "",
    ).trim();
    if (
      event.status === "succeeded" &&
      event.receiptOrigin !== "replayed" &&
      toolName &&
      RESULT_SEMANTIC_TOOL_NAMES.has(toolName) &&
      observationVersion &&
      observationSummary
    ) {
      const fingerprint = `${toolName}:${observationVersion}`;
      const actions = observationActionsByFingerprint.get(fingerprint) ||
        new Set<string>();
      actions.add(runtimeV2ProviderToolCallIdentity({
        name: toolName,
        arguments: argumentsValue,
      }));
      observationActionsByFingerprint.set(fingerprint, actions);
      if (actions.size >= 2) {
        repeatedObservationToolNames.add(toolName);
      }
    }
    if (
      event.status === "succeeded" &&
      toolCallId &&
      targets.length > 0
    ) {
      committedMutationTargetsByToolCallId.set(toolCallId, targets);
      correctiveMutationFailureToolCallIds.clear();
      correctiveMutationRequirementsByToolCallId.clear();
      rejectedActionIdentities.clear();
      observationActionsByFingerprint.clear();
      repeatedObservationToolNames.clear();
      replayedSourceReceiptCountSinceMutation = 0;
    }
  }
  return {
    committedMutationTargetsByToolCallId,
    replayedToolCallIds,
    replayedSourceReceiptCountSinceMutation,
    sourceReadVersionsByToolCallId,
    invalidatedSourceReadToolCallIds,
    correctiveReplayTargetsByToolCallId,
    correctiveMutationFailureToolCallIds,
    correctiveMutationRequirementsByToolCallId,
    failedValidationToolCallIds,
    rejectedActionIdentities,
    repeatedObservationToolNames,
  };
}

export interface RuntimeV2LatestCorrectiveMutationFailure {
  readonly toolCallId: string;
  readonly targets: readonly string[];
  readonly requirement: {
    readonly sequence?: number;
    readonly toolName: string;
    readonly arguments: Readonly<Record<string, unknown>>;
    readonly target: string;
    readonly reasonCode: string;
  } | null;
}

/** Older rejected editors are closed branches. Only the newest failed
 * mutation may own the next corrective source or mutation decision. */
export function latestRuntimeV2CorrectiveMutationFailure(
  effects: RuntimeV2ProviderEffectFacts,
): RuntimeV2LatestCorrectiveMutationFailure | null {
  const toolCallIds = [
    ...(effects.correctiveMutationFailureToolCallIds || []),
  ];
  const toolCallId = toolCallIds[toolCallIds.length - 1] || "";
  if (!toolCallId) return null;
  return {
    toolCallId,
    targets:
      effects.correctiveReplayTargetsByToolCallId?.get(toolCallId) || [],
    requirement:
      effects.correctiveMutationRequirementsByToolCallId?.get(toolCallId) ||
      null,
  };
}
