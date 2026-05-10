export interface ToolUiGroupBlock {
  type?: string;
  toolName?: string;
  toolStatus?: string;
  diff?: unknown;
}

export interface CompletedToolGroupRange {
  startIndex: number;
  endIndex: number;
}

interface BuildCompletedToolGroupRangesInput {
  blocks: ToolUiGroupBlock[];
  excludedToolNames?: Set<string>;
}

function isCompletedToolGroupCandidate(
  block: ToolUiGroupBlock,
  excludedToolNames: Set<string>,
): boolean {
  if (block.type !== "tool") return false;
  if (String(block.toolStatus || "") !== "executed") return false;
  if (block.diff) return false;
  if (excludedToolNames.has(String(block.toolName || ""))) return false;
  return true;
}

export function buildCompletedToolGroupRanges(
  input: BuildCompletedToolGroupRangesInput,
): CompletedToolGroupRange[] {
  const ranges: CompletedToolGroupRange[] = [];
  const excludedToolNames = input.excludedToolNames || new Set<string>();
  let startIndex = -1;

  for (let index = 0; index < input.blocks.length; index += 1) {
    const block = input.blocks[index];
    const candidate = isCompletedToolGroupCandidate(block, excludedToolNames);

    if (candidate) {
      if (startIndex < 0) startIndex = index;
      continue;
    }

    if (startIndex >= 0 && index - startIndex >= 2) {
      ranges.push({ startIndex, endIndex: index - 1 });
    }
    startIndex = -1;
  }

  if (startIndex >= 0 && input.blocks.length - startIndex >= 2) {
    ranges.push({ startIndex, endIndex: input.blocks.length - 1 });
  }

  return ranges;
}

export function countCompletedToolCalls(blocks: ToolUiGroupBlock[]): number {
  return blocks.filter((block) => block.type === "tool" && String(block.toolStatus || "") === "executed").length;
}
