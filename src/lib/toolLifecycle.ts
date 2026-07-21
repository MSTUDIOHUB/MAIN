export interface ToolLifecycleMeta {
  toolCallId?: string | null;
  qualityGateReason?: string | null;
  planRecoveryReason?: string | null;
}

export interface ToolLifecycleBlock {
  type?: string;
  turnId?: string;
  toolName?: string;
  target?: string;
  toolStatus?: string;
  toolCallId?: string;
}

interface FindToolBlockIndexInput {
  taskFlow: ToolLifecycleBlock[];
  turnId?: string;
  toolName: string;
  target: string;
  allowedStatuses: string[];
  meta?: ToolLifecycleMeta;
}

function findByToolCallId(input: FindToolBlockIndexInput, toolCallId: string): number {
  for (let i = input.taskFlow.length - 1; i >= 0; i -= 1) {
    const block = input.taskFlow[i];
    if (block.type !== "tool") continue;
    if (input.turnId && block.turnId !== input.turnId) continue;
    if (!input.allowedStatuses.includes(String(block.toolStatus || ""))) continue;
    if (String(block.toolCallId || "") === toolCallId) return i;
  }
  return -1;
}

function findByNameAndTarget(input: FindToolBlockIndexInput): number {
  for (let i = input.taskFlow.length - 1; i >= 0; i -= 1) {
    const block = input.taskFlow[i];
    if (block.type !== "tool") continue;
    if (input.turnId && block.turnId !== input.turnId) continue;
    if (!input.allowedStatuses.includes(String(block.toolStatus || ""))) continue;
    if (String(block.toolName || "") !== input.toolName) continue;
    if (String(block.target || "") !== input.target) continue;
    return i;
  }
  return -1;
}

export function findToolLifecycleBlockIndex(input: FindToolBlockIndexInput): number {
  const toolCallId = String(input.meta?.toolCallId || "").trim();
  if (toolCallId) {
    const exact = findByToolCallId(input, toolCallId);
    if (exact >= 0) return exact;
    // A supplied id is the lifecycle owner. Never let an unstarted, stale, or
    // policy-only callback fall back onto another call merely because it used
    // the same tool and target. Legacy name+target matching is available only
    // to callers that do not claim an explicit owner id.
    return -1;
  }
  return findByNameAndTarget(input);
}
