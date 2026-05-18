import {
  compactToolPresentationTarget,
  deriveToolIntentSummary,
  deriveToolPhase,
  type ToolPresentationLanguage,
} from "./toolPresentation";

export type TurnArchiveStepKind = "thinking" | "discover" | "inspect" | "edit" | "command" | "verify" | "blocked" | "message";
export type TurnArchiveStepStatus = "running" | "done" | "failed" | "rejected";

export interface TurnArchiveStep {
  id: string;
  kind: TurnArchiveStepKind;
  status: TurnArchiveStepStatus;
  intent: string;
  summary: string;
  targets: string[];
  items: any[];
  expandedByDefault: boolean;
}

export interface TurnProcessArchiveCounts {
  discover: number;
  inspect: number;
  edit: number;
  command: number;
  verify: number;
  blocked: number;
  failed: number;
  rejected: number;
  message: number;
  thought: number;
  table: number;
}

export interface TurnProcessArchiveModel {
  blocks: any[];
  steps: TurnArchiveStep[];
  counts: TurnProcessArchiveCounts;
  totalCount: number;
  stepCount: number;
  summaryText: string;
  previewTargets: string[];
}

function normalizeLanguage(language?: ToolPresentationLanguage): ToolPresentationLanguage {
  return language === "en" ? "en" : "zh";
}

function isToolBlock(block: any): boolean {
  return block?.type === "tool";
}

function isThoughtBlock(block: any): boolean {
  return block?.type === "thought" && String(block.content || "").trim().length > 0;
}

function getLatestThoughtBlock(blocks: any[]): any | null {
  return [...blocks].reverse().find(isThoughtBlock) || null;
}

function isFinalConclusionBlock(block: any, finalVisibleAgentIndex: number, blockIndex: number): boolean {
  return block?.type === "agent" && blockIndex === finalVisibleAgentIndex;
}

function isProcessArchiveCandidate(block: any, finalVisibleAgentIndex: number, blockIndex: number): boolean {
  if (!block || block.type === "user") return false;
  if (isFinalConclusionBlock(block, finalVisibleAgentIndex, blockIndex)) return false;
  if (block.type === "system") {
    return block.variant !== "context_compression" && block.variant !== "plan_execution_checkpoint";
  }
  return block.type === "tool" || block.type === "thought" || block.type === "jobList" || block.type === "agent" || block.type === "system";
}

function mapToolStatus(block: any): TurnArchiveStepStatus {
  const status = String(block?.toolStatus || block?.status || "").toLowerCase();
  if (status === "failed" || status === "error") return "failed";
  if (status === "rejected") return "rejected";
  if (status === "running" || status === "pending" || status === "pending_review") return "running";
  return "done";
}

function isContextPhase(kind: TurnArchiveStepKind): boolean {
  return kind === "discover" || kind === "inspect";
}

function getToolStepKind(block: any): TurnArchiveStepKind {
  const phase = deriveToolPhase({
    toolName: String(block?.toolName || ""),
    target: String(block?.target || ""),
    status: String(block?.status || ""),
    toolStatus: String(block?.toolStatus || ""),
  });
  if (phase === "blocked") return "blocked";
  return phase as TurnArchiveStepKind;
}

function compactTarget(block: any, language: ToolPresentationLanguage): string {
  if (!isToolBlock(block)) return "";
  return compactToolPresentationTarget(
    String(block.target || ""),
    String(block.toolName || ""),
    language,
  );
}

function uniqueTargets(blocks: any[], language: ToolPresentationLanguage): string[] {
  const targets: string[] = [];
  for (const block of blocks) {
    const target = compactTarget(block, language);
    if (target && !targets.includes(target)) targets.push(target);
  }
  return targets;
}

function firstMeaningfulLine(text: string): string {
  return String(text || "")
    .split(/\r?\n+/)
    .map((line) => line.trim())
    .find(Boolean) || "";
}

function defaultIntentForStep(kind: TurnArchiveStepKind, language: ToolPresentationLanguage): string {
  if (language === "en") {
    if (kind === "thinking") return "Summarize the current judgment before the next action.";
    if (kind === "discover" || kind === "inspect") return "Collect and confirm the relevant context before changing anything.";
    if (kind === "edit") return "Apply the planned file changes.";
    if (kind === "verify") return "Verify that the changes behave as expected.";
    if (kind === "command") return "Run the command and inspect the result.";
    if (kind === "blocked") return "Keep the blocked step visible so it can be recovered.";
    return "Keep this process message in the turn archive.";
  }
  if (kind === "thinking") return "整理当前判断，再进入下一步动作。";
  if (kind === "discover" || kind === "inspect") return "收集并确认相关上下文，再决定修改范围。";
  if (kind === "edit") return "按方案实施文件修改。";
  if (kind === "verify") return "验证改动是否达到预期。";
  if (kind === "command") return "运行命令并查看结果。";
  if (kind === "blocked") return "保留受阻步骤，方便恢复处理。";
  return "保留过程消息，便于追溯。";
}

function resolveToolIntent(block: any, kind: TurnArchiveStepKind, language: ToolPresentationLanguage): string {
  const persisted = String(block?.intentSummary || "").replace(/\s+/g, " ").trim();
  if (persisted) return persisted;
  if (!isToolBlock(block)) return defaultIntentForStep(kind, language);
  return deriveToolIntentSummary({
    toolName: String(block.toolName || ""),
    target: String(block.target || ""),
    language,
    status: String(block.status || ""),
    toolStatus: String(block.toolStatus || ""),
  });
}

function makeSummaryForStep(step: TurnArchiveStep, language: ToolPresentationLanguage): string {
  const blocks = step.items;
  const targets = uniqueTargets(blocks, language);
  const hiddenCount = Math.max(0, targets.length - 3);
  const targetText = targets.slice(0, 3).join(language === "zh" ? "、" : ", ");
  const toolCount = blocks.filter(isToolBlock).length;

  if (step.kind === "thinking") {
    const first = firstMeaningfulLine(String(blocks[0]?.content || ""));
    return language === "en" ? first || "Latest thought summary" : first || "最新一步思考摘要";
  }
  if (step.kind === "edit") {
    return language === "en"
      ? `${toolCount} file edit${toolCount > 1 ? "s" : ""}${targetText ? `: ${targetText}${hiddenCount ? ` +${hiddenCount}` : ""}` : ""}`
      : `${toolCount} 次文件修改${targetText ? `：${targetText}${hiddenCount ? ` +${hiddenCount}` : ""}` : ""}`;
  }
  if (step.kind === "verify" || step.kind === "command") {
    return targetText || (language === "en" ? `${toolCount} command operation${toolCount > 1 ? "s" : ""}` : `${toolCount} 次命令操作`);
  }
  if (step.kind === "blocked") {
    return targetText || (language === "en" ? "Blocked step" : "步骤受阻");
  }
  if (step.kind === "message") {
    const message = blocks.map((block) => firstMeaningfulLine(String(block.content || block.message || ""))).find(Boolean);
    return message || (language === "en" ? "Process message" : "过程消息");
  }
  return language === "en"
    ? `${toolCount} context operation${toolCount > 1 ? "s" : ""}${targetText ? `: ${targetText}${hiddenCount ? ` +${hiddenCount}` : ""}` : ""}`
    : `${toolCount} 次上下文操作${targetText ? `：${targetText}${hiddenCount ? ` +${hiddenCount}` : ""}` : ""}`;
}

function canMergeSteps(current: TurnArchiveStep | null, next: TurnArchiveStep): boolean {
  if (!current) return false;
  if (current.status !== next.status) return false;
  if (current.status === "failed" || current.status === "rejected") return false;
  if (isContextPhase(current.kind) && isContextPhase(next.kind)) return true;
  return current.kind === next.kind && current.kind !== "thinking" && current.kind !== "message" && current.kind !== "blocked";
}

function makeStep(input: {
  block: any;
  index: number;
  language: ToolPresentationLanguage;
}): TurnArchiveStep {
  const { block, index, language } = input;
  if (block.type === "thought") {
    return {
      id: `turn-archive-step-thinking-${block.id ?? index}`,
      kind: "thinking",
      status: block.isStreaming ? "running" : "done",
      intent: defaultIntentForStep("thinking", language),
      summary: "",
      targets: [],
      items: [block],
      expandedByDefault: true,
    };
  }

  if (isToolBlock(block)) {
    const status = mapToolStatus(block);
    const kind = status === "failed" || status === "rejected" ? "blocked" : getToolStepKind(block);
    const target = compactTarget(block, language);
    return {
      id: `turn-archive-step-${kind}-${block.id ?? index}`,
      kind,
      status,
      intent: resolveToolIntent(block, kind, language),
      summary: "",
      targets: target ? [target] : [],
      items: [block],
      expandedByDefault: status === "failed" || status === "rejected",
    };
  }

  return {
    id: `turn-archive-step-message-${block.id ?? index}`,
    kind: "message",
    status: "done",
    intent: defaultIntentForStep("message", language),
    summary: "",
    targets: [],
    items: [block],
    expandedByDefault: false,
  };
}

function finalizeStep(step: TurnArchiveStep, language: ToolPresentationLanguage): TurnArchiveStep {
  const targets = uniqueTargets(step.items, language);
  const kind = step.kind;
  const intent = isContextPhase(kind) && step.items.length > 1
    ? defaultIntentForStep(kind, language)
    : step.intent || defaultIntentForStep(kind, language);
  return {
    ...step,
    targets,
    intent,
    summary: makeSummaryForStep({ ...step, targets }, language),
  };
}

function makeCounts(steps: TurnArchiveStep[]): TurnProcessArchiveCounts {
  const counts: TurnProcessArchiveCounts = {
    discover: 0,
    inspect: 0,
    edit: 0,
    command: 0,
    verify: 0,
    blocked: 0,
    failed: 0,
    rejected: 0,
    message: 0,
    thought: 0,
    table: 0,
  };
  for (const step of steps) {
    if (step.kind === "thinking") counts.thought += 1;
    else counts[step.kind] += 1;
    if (step.status === "failed") counts.failed += 1;
    if (step.status === "rejected") counts.rejected += 1;
    for (const item of step.items) {
      const toolName = String(item?.toolName || "");
      if (toolName === "analyze_tabular_document" || toolName === "query_tabular_document") {
        counts.table += 1;
      }
    }
  }
  return counts;
}

function makeSummaryText(steps: TurnArchiveStep[], counts: TurnProcessArchiveCounts, language: ToolPresentationLanguage): string {
  const parts: string[] = [];
  if (language === "en") {
    parts.push(`${steps.length} step${steps.length === 1 ? "" : "s"}`);
    const contextCount = counts.discover + counts.inspect;
    if (contextCount) parts.push(`${contextCount} context`);
    if (counts.edit) parts.push(`${counts.edit} edit`);
    if (counts.verify) parts.push(`${counts.verify} verify`);
    if (counts.command) parts.push(`${counts.command} command`);
    if (counts.blocked) parts.push(`${counts.blocked} blocked`);
    if (counts.thought) parts.push(`${counts.thought} thought`);
    return parts.join(" / ");
  }

  parts.push(`${steps.length} 步`);
  const contextCount = counts.discover + counts.inspect;
  if (contextCount) parts.push(`上下文 ${contextCount}`);
  if (counts.edit) parts.push(`编辑 ${counts.edit}`);
  if (counts.verify) parts.push(`验证 ${counts.verify}`);
  if (counts.command) parts.push(`命令 ${counts.command}`);
  if (counts.blocked) parts.push(`受阻 ${counts.blocked}`);
  if (counts.thought) parts.push(`思考 ${counts.thought}`);
  return parts.join(" / ");
}

export function buildTurnProcessArchiveModel(input: {
  blocks: any[];
  finalVisibleAgentIndex: number;
  language?: ToolPresentationLanguage;
}): TurnProcessArchiveModel {
  const language = normalizeLanguage(input.language);
  const latestThoughtId = getLatestThoughtBlock(input.blocks)?.id ?? null;
  const archiveBlocks = input.blocks.filter((block, index) => {
    if (!isProcessArchiveCandidate(block, input.finalVisibleAgentIndex, index)) return false;
    if (block.type === "thought" && block.id !== latestThoughtId) return false;
    return true;
  });

  const steps: TurnArchiveStep[] = [];
  archiveBlocks.forEach((block, index) => {
    const next = makeStep({ block, index, language });
    const current = steps[steps.length - 1] || null;
    if (canMergeSteps(current, next)) {
      current!.items.push(...next.items);
      current!.targets = uniqueTargets(current!.items, language);
      current!.expandedByDefault = current!.expandedByDefault || next.expandedByDefault;
      if (isContextPhase(current!.kind) && isContextPhase(next.kind)) {
        current!.intent = defaultIntentForStep(current!.kind, language);
      }
      return;
    }
    steps.push(next);
  });

  const finalizedSteps = steps.map((step) => finalizeStep(step, language));
  const counts = makeCounts(finalizedSteps);
  const previewTargets: string[] = [];
  for (const step of finalizedSteps) {
    for (const target of step.targets) {
      if (target && previewTargets.length < 3 && !previewTargets.includes(target)) {
        previewTargets.push(target);
      }
    }
  }

  return {
    blocks: archiveBlocks,
    steps: finalizedSteps,
    counts,
    totalCount: archiveBlocks.length,
    stepCount: finalizedSteps.length,
    summaryText: makeSummaryText(finalizedSteps, counts, language),
    previewTargets,
  };
}
