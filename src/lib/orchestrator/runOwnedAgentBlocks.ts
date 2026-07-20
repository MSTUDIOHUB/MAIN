import type { TaskBlock } from "../taskTypes";

type AgentBlock = Extract<TaskBlock, { type: "agent" }>;

const DURABLE_ASSISTANT_VISIBILITIES = new Set([
  "assistant_update",
  "assistant_final",
  "stage_summary",
  "substantive_plan_text",
]);

/**
 * Public assistant checkpoints survive stream retries. They are transcript
 * evidence, not the transient stream buffer that a later tool-call iteration
 * is allowed to replace or clear.
 */
export function isDurableAssistantPresentationBlock(block: AgentBlock): boolean {
  return DURABLE_ASSISTANT_VISIBILITIES.has(String(block.visibility || "")) ||
    (Array.isArray(block.options) && block.options.length > 0) ||
    !!block.choiceRequest;
}

/**
 * Select retryable assistant output owned by the current execution lease. A
 * continuation run can share a logical turn with durable commentary or an
 * earlier choice checkpoint, so turnId alone never grants authority to replace
 * or delete a block.
 */
export function findLatestRunOwnedAgentBlock(
  taskFlow: TaskBlock[],
  displayTurnId: string,
  agentBlockIdsCreatedThisRun: ReadonlySet<number>,
  options?: { requireSettled?: boolean },
): AgentBlock | null {
  for (let index = taskFlow.length - 1; index >= 0; index -= 1) {
    const block = taskFlow[index];
    if (
      block?.type !== "agent" ||
      block.turnId !== displayTurnId ||
      !agentBlockIdsCreatedThisRun.has(block.id) ||
      block.archivedAfterChoice === true ||
      isDurableAssistantPresentationBlock(block) ||
      (options?.requireSettled === true && block.streaming === true)
    ) {
      continue;
    }
    return block;
  }
  return null;
}
