import {
  isWorkspaceMutationToolName,
  resolveWorkspaceMutationTargets,
} from "../../lib/workspaceMutationTools";
import { normalizeRuntimeV2WorkspacePath } from "./executionProviderContext";
import type { RuntimeV2NormalizedProviderResult, RuntimeV2NormalizedToolCall, TurnAggregateV1 } from "../../lib/runtime-v2";
import { runtimeV2ProviderToolCallIdentity } from "./providerToolSurface";

interface RuntimeV2RepeatedActionFeedbackInput {
  readonly call: {
    readonly name: string;
    readonly arguments: Readonly<Record<string, unknown>>;
  };
  readonly reason: "already_completed" | "already_rejected";
  readonly workspace: string;
  readonly visibleSourceTargets?: readonly string[];
  readonly failureDetail?: string;
}

function boundedWorkspaceFeedbackTarget(
  value: unknown,
  workspace: string,
): string | null {
  const raw = String(value || "").trim();
  if (!raw || /[\u0000-\u001f\u007f]/.test(raw)) return null;
  const target = normalizeRuntimeV2WorkspacePath(raw, workspace).trim();
  if (
    !target ||
    target.length > 300 ||
    /[\u0000-\u001f\u007f]/.test(target) ||
    target.startsWith("/") ||
    target.startsWith("../") ||
    target.split("/").includes("..")
  ) {
    return null;
  }
  return target;
}

function boundedRejectedMutationTargets(
  input: RuntimeV2RepeatedActionFeedbackInput,
): string[] {
  if (!isWorkspaceMutationToolName(input.call.name)) return [];
  return resolveWorkspaceMutationTargets(
    input.call.name,
    { ...input.call.arguments },
  )
    .map((target) =>
      boundedWorkspaceFeedbackTarget(target, input.workspace)
    )
    .filter((target): target is string => Boolean(target))
    .slice(0, 4)
    .filter((target, index, targets) =>
      targets.indexOf(target) === index
    );
}

/**
 * Turn an exact duplicate rejection into a positive next decision without
 * retaining the rejected patch or narrowing the provider's authorized tools.
 * A mutation target is safe to expose, while search/replace bodies are not.
 */
export function runtimeV2RepeatedActionFeedback(
  input: RuntimeV2RepeatedActionFeedbackInput,
): string {
  const completed = input.reason === "already_completed";
  const lines = [
    `ACTION_NOT_EXECUTED: the latest ${input.call.name} action matched one ${completed ? "already completed" : "already rejected"} at the current mutation boundary.`,
  ];
  const targets = boundedRejectedMutationTargets(input);
  if (input.failureDetail) lines.push(`Original failure: ${input.failureDetail.slice(0, 800)}`);
  if (!completed && targets.length > 0) {
    const visibleTargets = new Set(
      (input.visibleSourceTargets || [])
        .map((target) =>
          boundedWorkspaceFeedbackTarget(target, input.workspace)
        )
        .filter((target): target is string => Boolean(target)),
    );
    const missingTargets = targets.filter((target) =>
      !visibleTargets.has(target)
    );
    lines.push(
      `targets: ${JSON.stringify(targets)}`,
      "effect: none",
      "Do not resubmit the same mutation.",
      missingTargets.length > 0
        ? `next: call read_file for the missing target source ${JSON.stringify(missingTargets)}, then derive a materially different mutation from the returned version.`
        : "next: current versioned source for these targets is already visible. Derive a materially different mutation from that source, or choose another allowed action.",
      "Other allowed tools and targets remain available.",
    );
  } else {
    lines.push(
      "No tool effect ran. Reuse a committed result when applicable; otherwise choose materially different arguments or another allowed action.",
      "If no materially different authorized action can advance the objective, return a concise evidence report without a tool call; the Runtime will preserve the incomplete result without claiming success.",
    );
  }
  return lines.join("\n");
}

export function buildRuntimeV2RepeatedActionReceipts(input: {
  calls: readonly RuntimeV2NormalizedToolCall[];
  aggregate: TurnAggregateV1 | null;
  reason: "already_completed" | "already_rejected";
  workspace: string;
  visibleSourceTargets: readonly string[];
  observed: ReadonlySet<string> | undefined;
  nextId: () => string;
}): NonNullable<RuntimeV2NormalizedProviderResult["actionReceipts"]> {
  const commands = new Map(input.aggregate?.events.flatMap(event => event.type === "command.scheduled" ? [[event.command.idempotencyKey, event.command] as const] : []) || []);
  return input.calls.map(call => {
    const actionIdentity = runtimeV2ProviderToolCallIdentity(call);
    const failure = [...(input.aggregate?.events || [])].reverse().find(event => {
      if (event.type !== "tool.completed" || event.status === "succeeded") return false;
      const command = commands.get(event.idempotencyKey);
      return command && runtimeV2ProviderToolCallIdentity({ name: String(command.payload.toolName), arguments: command.payload.arguments as Record<string, unknown> || {} }) === actionIdentity;
    });
    const feedback = runtimeV2RepeatedActionFeedback({ ...input, call,
      failureDetail: failure?.type === "tool.completed" ? `${failure.status}: ${failure.failureReasonCode || failure.failureKind}: ${failure.presentation?.message || ""}` : undefined });
    return { call: { ...call, id: input.nextId(), arguments: isWorkspaceMutationToolName(call.name)
      ? { runtime_v2_rejected_action: actionIdentity, effect: "none" } : call.arguments },
      actionIdentity, status: "rejected", reasonCode: input.reason, feedback,
      priorFeedbackObserved: input.observed?.has(actionIdentity) === true };
  });
}

export function runtimeV2DeferredToolReceipts(calls: readonly RuntimeV2NormalizedToolCall[], nextId: () => string): NonNullable<RuntimeV2NormalizedProviderResult["actionReceipts"]> {
  return calls.map(call => {
    const actionIdentity = runtimeV2ProviderToolCallIdentity(call);
    return { call: { ...call, id: nextId(), arguments: isWorkspaceMutationToolName(call.name)
      ? { runtime_v2_rejected_action: actionIdentity, effect: "none" } : call.arguments },
      actionIdentity, status: "not_executed", reasonCode: "provider_batch_deferred",
      feedback: "ACTION_NOT_EXECUTED: this call was deferred by batch ordering or matched a prior action. No new effect ran for this call. Reuse its committed result or propose it separately after observing the selected calls' results." };
  });
}
