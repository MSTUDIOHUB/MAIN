import {
  isWorkspaceMutationToolName,
  resolveWorkspaceMutationTargets,
} from "../../lib/workspaceMutationTools";
import { normalizeRuntimeV2WorkspacePath } from "./executionProviderContext";

interface RuntimeV2RepeatedActionFeedbackInput {
  readonly call: {
    readonly name: string;
    readonly arguments: Readonly<Record<string, unknown>>;
  };
  readonly reason: "already_completed" | "already_rejected";
  readonly workspace: string;
  readonly visibleSourceTargets?: readonly string[];
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
    );
  }
  return lines.join("\n");
}
