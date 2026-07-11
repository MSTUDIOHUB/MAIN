import type { TaskBlock } from "../taskTypes";

type AgentBlock = Extract<TaskBlock, { type: "agent" }>;

/**
 * Select assistant presentation owned by the current execution lease. A
 * continuation run can share a logical turn with an earlier choice checkpoint,
 * so turnId alone never grants authority to replace or delete a block.
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
      (options?.requireSettled === true && block.streaming === true)
    ) {
      continue;
    }
    return block;
  }
  return null;
}
