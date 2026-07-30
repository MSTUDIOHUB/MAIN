import type {
  RuntimeV2Command,
  TurnAggregateV1,
} from "../../lib/runtime-v2";
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
  /** Successful source reads proven by the effect ledger. Failed/rejected
   * tool text must never replace a current source artifact in the workset. */
  readonly sourceReadVersionsByToolCallId: ReadonlyMap<string, {
    readonly target: string;
    readonly version: string;
  }>;
  /** Latest failed validation may remain beside newer source/recovery
   * frontiers. The durable validation ledger, never tool-result prose,
   * identifies which provider call owns that fact. */
  readonly failedValidationToolCallIds?: ReadonlySet<string>;
  /** Exact deterministic action failures since the latest committed mutation.
   * This set is derived from the canonical command/effect ledger, so it
   * survives checkpoint restore and has no process-local capacity limit. */
  readonly rejectedActionIdentities: ReadonlySet<string>;
}

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
  const sourceReadVersionsByToolCallId = new Map<string, {
    readonly target: string;
    readonly version: string;
  }>();
  const failedValidationToolCallIds = new Set<string>();
  const rejectedActionIdentities = new Set<string>();
  for (const event of aggregate?.events || []) {
    if (event.type !== "validation.completed" || event.passed) continue;
    const toolCallId = toolCallIdsByCommand.get(event.idempotencyKey);
    if (toolCallId) failedValidationToolCallIds.add(toolCallId);
  }
  for (const event of aggregate?.events || []) {
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
      const toolName = String(
        command.payload.toolName || "",
      ).trim();
      const rawArguments = command.payload.arguments;
      const argumentsValue =
        rawArguments &&
          typeof rawArguments === "object" &&
          !Array.isArray(rawArguments)
          ? rawArguments as Record<string, unknown>
          : {};
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
    if (
      event.status === "succeeded" &&
      toolCallId &&
      targets.length > 0
    ) {
      committedMutationTargetsByToolCallId.set(toolCallId, targets);
      rejectedActionIdentities.clear();
    }
  }
  return {
    committedMutationTargetsByToolCallId,
    replayedToolCallIds,
    sourceReadVersionsByToolCallId,
    failedValidationToolCallIds,
    rejectedActionIdentities,
  };
}
