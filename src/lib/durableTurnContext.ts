import type { TaskBlock } from "./taskTypes";
import { classifyKnownBuiltInTool } from "./toolCapabilities";
import { buildCanonicalCompletedTurnMessages } from "./turnContext";
import { isEphemeralPlanArtifactPath, type DurableTurnContext } from "./workflowModels";
import { classifyCommandResultOutcome } from "./planEvidence";

const VALIDATION_TARGET_RE = /(?:\btest\b|pytest|vitest|jest|playwright|\bbuild\b|\blint\b|typecheck|\btsc\b|cargo\s+check|go\s+test)/i;

/**
 * Both successful and failed terminal runs must shed transient recovery/control
 * messages before the next logical turn is assembled.
 */
export function shouldCanonicalizeTerminalTurnContext(status: string): boolean {
  return status === "completed" || status === "error";
}

function compact(value: unknown, maxChars = 260): string {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length <= maxChars ? text : `${text.slice(0, Math.max(1, maxChars - 3))}...`;
}

function unique(values: string[], maxItems = 24): string[] {
  return [...new Set(values.map((value) => compact(value)).filter(Boolean))].slice(0, maxItems);
}

export function buildDurableTurnContext(input: {
  turnId: string;
  turnBlocks: TaskBlock[];
  fallbackAssistantText?: string;
  artifactPaths?: string[];
  unfinished?: string[];
  now?: number;
}): DurableTurnContext | null {
  const canonicalMessages = buildCanonicalCompletedTurnMessages({
    turnBlocks: input.turnBlocks,
    fallbackAssistantText: input.fallbackAssistantText,
  });
  const visibleUserMessages = canonicalMessages
    .filter((message) => message.role === "user")
    .map((message) => message.content);
  const finalAssistantAnswer = [...canonicalMessages]
    .reverse()
    .find((message) => message.role === "assistant")?.content || "";
  if (visibleUserMessages.length === 0 || !finalAssistantAnswer) return null;

  const decisions: string[] = [];
  const modifiedFiles: string[] = [];
  const validations: string[] = [];
  const failures: string[] = [];

  for (const block of input.turnBlocks) {
    if (block.type === "agent" && block.selectedOption) {
      decisions.push(block.selectedOption);
      continue;
    }
    if (block.type === "system" && /^\s*❌/.test(block.content || "")) {
      failures.push(block.content);
      continue;
    }
    if (block.type !== "tool") continue;
    const risk = classifyKnownBuiltInTool(block.toolName);
    const target = compact(block.diff?.path || block.target || block.toolName);
    const resultText = String(
      (block as typeof block & { output?: string }).output ||
      block.message ||
      block.evidence ||
      "",
    );
    const commandOutcome = block.toolStatus === "executed"
      ? classifyCommandResultOutcome(block.toolName, resultText)
      : null;
    const commandFailed = commandOutcome === "failed";
    if (
      block.toolStatus === "executed" &&
      (risk === "workspace_write" || risk === "destructive") &&
      !isEphemeralPlanArtifactPath(target)
    ) {
      modifiedFiles.push(target);
    }
    if (
      block.toolStatus === "executed" &&
      (
        risk === "browser_control" ||
        (risk === "shell" && commandOutcome === "succeeded" && VALIDATION_TARGET_RE.test(block.target || ""))
      )
    ) {
      validations.push(`${block.toolName}: ${target}`);
    }
    if (block.toolStatus === "failed" || commandFailed) {
      failures.push(`${block.toolName}: ${target}`);
    }
  }

  return {
    schemaVersion: 1,
    turnId: input.turnId,
    visibleUserMessages,
    finalAssistantAnswer,
    execution: {
      decisions: unique(decisions),
      modifiedFiles: unique(modifiedFiles),
      validations: unique(validations),
      failures: unique(failures),
      unfinished: unique(input.unfinished || []),
      artifacts: unique(input.artifactPaths || []),
    },
    committedAt: input.now ?? Date.now(),
  };
}

export function serializeDurableTurnContextForModel(
  context: DurableTurnContext | null | undefined,
): string {
  if (!context) return "";
  const execution = context.execution;
  const hasStructuredExecution = Object.values(execution).some((values) => values.length > 0);
  if (!hasStructuredExecution) return "";
  return [
    "[durable_turn_context]",
    `turnId: ${context.turnId}`,
    `decisions: ${JSON.stringify(execution.decisions)}`,
    `modifiedFiles: ${JSON.stringify(execution.modifiedFiles)}`,
    `validations: ${JSON.stringify(execution.validations)}`,
    `failures: ${JSON.stringify(execution.failures)}`,
    `unfinished: ${JSON.stringify(execution.unfinished)}`,
    `artifacts: ${JSON.stringify(execution.artifacts)}`,
    "[/durable_turn_context]",
  ].join("\n");
}
