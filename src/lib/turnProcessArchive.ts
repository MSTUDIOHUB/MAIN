import {
  compactToolPresentationTarget,
  deriveToolIntentSummary,
  deriveToolPhase,
  type ToolPresentationLanguage,
} from "./toolPresentation";
import { deriveThoughtDisplay } from "./thoughtDisplay";

export type TurnArchiveStepKind = "thinking" | "discover" | "inspect" | "edit" | "command" | "verify" | "blocked" | "message";
export type TurnArchiveStepStatus = "running" | "done" | "failed" | "rejected";

export interface TurnArchiveStep {
  id: string;
  kind: TurnArchiveStepKind;
  status: TurnArchiveStepStatus;
  intent: string;
  why: string;
  action: string;
  result: string;
  next: string;
  note: string;
  summary: string;
  targets: string[];
  items: any[];
  expandedByDefault: boolean;
  sourceIndex: number;
  sourceEndIndex: number;
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
  currentJudgment: string;
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

function isLiveProcessCandidate(block: any): boolean {
  if (!block || block.type === "user" || block.type === "thought") return false;
  if (block.type === "agent") return block.hiddenProcess === true;
  if (block.type === "system") {
    return block.variant !== "context_compression" && block.variant !== "plan_execution_checkpoint";
  }
  return block.type === "tool" || block.type === "jobList" || block.type === "system";
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

function compactLine(text: string, maxChars = 180): string {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars - 3).trim()}...`;
}

function isLowValueProcessNote(text: string): boolean {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  if (!normalized) return true;
  if (/^我会执行下一步工具动作[:：]/.test(normalized)) return true;
  if (/^I will run the next tool action:/i.test(normalized)) return true;
  if (/^(?:让我|我(?:会|将|要|需要|继续|正在)|接下来|现在)?\s*(?:继续|再|先)?\s*(?:读取|检查|查看|分析|梳理|确认)(?:剩余|更多|相关|关键|必要)?(?:的)?(?:文件|内容|上下文|实现|代码)?[。.!！]*$/i.test(normalized)) return true;
  if (/^(?:let me|i(?:'ll| will| need to| am going to)?|next)?\s*(?:continue|keep|first)?\s*(?:read|check|inspect|look at|analyze)\s+(?:the\s+)?(?:remaining|more|relevant|key)?\s*(?:files?|content|context|implementation|code)\.?$/i.test(normalized)) return true;
  if (/等待(?:可见回复|模型|下一步动作|工具结果)|waiting for (?:the )?(?:model|next step|tool result)/i.test(normalized)) return true;
  return false;
}

function extractReasoningNoteFromText(
  text: string,
  language: ToolPresentationLanguage,
  maxLines = 3,
): string {
  const display = deriveThoughtDisplay(String(text || ""), {
    language,
    mode: "latest",
    density: "adaptive",
    maxSummaryLines: maxLines,
  });
  const usefulLines = display.summaryLines
    .map((line) => line.trim())
    .filter((line) => line && !isLowValueProcessNote(line));
  if (usefulLines.length === 0) return "";
  return compactLine(usefulLines.join(language === "zh" ? " " : " "), 320);
}

function isReasoningSourceBlock(block: any, includeThoughts: boolean): boolean {
  if (!includeThoughts) return false;
  if (!block) return false;
  if (block.type === "thought") return true;
  if (block.type === "agent") return String(block.content || "").trim().length > 0;
  return false;
}

function getLatestReasoningNote(
  blocks: any[],
  language: ToolPresentationLanguage,
  includeThoughts: boolean,
): string {
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index];
    if (!isReasoningSourceBlock(block, includeThoughts)) continue;
    const note = extractReasoningNoteFromText(String(block.content || ""), language);
    if (note) return note;
  }
  return "";
}

function findNearestReasoningNote(input: {
  sourceBlocks: any[];
  beforeIndex: number;
  kind: TurnArchiveStepKind;
  language: ToolPresentationLanguage;
  includeThoughts: boolean;
}): string {
  const maxLookback = 10;
  for (let index = Math.min(input.beforeIndex - 1, input.sourceBlocks.length - 1); index >= 0 && input.beforeIndex - index <= maxLookback; index -= 1) {
    const block = input.sourceBlocks[index];
    if (!isReasoningSourceBlock(block, input.includeThoughts)) continue;
    const note = extractReasoningNoteFromText(String(block.content || ""), input.language);
    if (note && noteMatchesStepKind(note, input.kind)) return note;
  }
  return "";
}

function noteMatchesStepKind(note: string, kind: TurnArchiveStepKind): boolean {
  const text = String(note || "").toLowerCase();
  if (!text) return false;
  if (kind === "message" || kind === "thinking" || kind === "blocked") return true;
  if (kind === "discover" || kind === "inspect") {
    return /定位|搜索|读取|检查|查看|确认|审计|日志|上下文|范围|实现|文件|代码|look|read|inspect|check|search|scope|context|log|implementation|file/.test(text) &&
      !/最终回复|整理验证结果|完成实现|final response|validation result/.test(text);
  }
  if (kind === "edit") {
    return /修改|修复|调整|实现|接入|补充|落到|改成|rewrite|change|fix|edit|implement|wire|update/.test(text);
  }
  if (kind === "verify") {
    return /验证|测试|回归|构建|build|test|verify|regression|check result/.test(text) &&
      !/准备验证|整理验证结果|prepare.*validat|organize.*validat/.test(text);
  }
  if (kind === "command") {
    return /命令|运行|执行|终端|command|run|terminal|shell/.test(text);
  }
  return true;
}

function getBlockResultLine(block: any): string {
  return firstMeaningfulLine(String(block?.message || block?.summary || block?.resultPreview || block?.output || block?.content || ""));
}

function makeTargetSummary(targets: string[], language: ToolPresentationLanguage): string {
  const visible = targets.slice(0, 3).filter(Boolean);
  const hiddenCount = Math.max(0, targets.length - visible.length);
  const joined = visible.join(language === "zh" ? "、" : ", ");
  if (!joined) return "";
  return hiddenCount > 0 ? `${joined} +${hiddenCount}` : joined;
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

function defaultNarrativeForStep(
  step: Pick<TurnArchiveStep, "kind" | "status" | "items" | "targets" | "summary">,
  language: ToolPresentationLanguage,
): Pick<TurnArchiveStep, "why" | "action" | "result" | "next"> {
  const targets = step.targets.length > 0
    ? step.targets.slice(0, 3).join(language === "zh" ? "、" : ", ")
    : language === "zh" ? "当前工作区" : "current workspace";
  const resultLine = compactLine(step.items.map(getBlockResultLine).find(Boolean) || step.summary || "", 150);
  const failed = step.status === "failed" || step.status === "rejected" || step.kind === "blocked";

  if (language === "en") {
    if (step.kind === "thinking") {
      return {
        why: "Keep the latest model judgment visible without stacking older thoughts.",
        action: "Summarized the newest useful reasoning step.",
        result: resultLine || "Latest thought summary is available.",
        next: "Use this judgment to guide the next operation.",
      };
    }
    if (step.kind === "discover") {
      return {
        why: "Narrow the task to relevant files and symbols before reading more.",
        action: `Searched or scanned ${targets}.`,
        result: resultLine || `Relevant targets were narrowed to ${targets}.`,
        next: "Read the smallest useful context next.",
      };
    }
    if (step.kind === "inspect") {
      return {
        why: "Confirm the current implementation before deciding the change.",
        action: `Read or inspected ${targets}.`,
        result: resultLine || `Context from ${targets} was captured for the turn.`,
        next: "Apply only the change supported by this context.",
      };
    }
    if (step.kind === "edit") {
      return {
        why: "Apply the approved change to the concrete project files.",
        action: `Edited ${targets}.`,
        result: step.summary || resultLine || "File changes were recorded with diff evidence.",
        next: "Verify the touched behavior.",
      };
    }
    if (step.kind === "verify") {
      return {
        why: "Check whether the implementation now satisfies the requested behavior.",
        action: `Ran verification for ${targets}.`,
        result: resultLine || step.summary || "Verification evidence was recorded.",
        next: failed ? "Fix the failure before claiming completion." : "Use the result as completion evidence when it matches the task.",
      };
    }
    if (step.kind === "command") {
      return {
        why: "Use command output as concrete feedback for the next step.",
        action: `Ran ${targets}.`,
        result: resultLine || step.summary || "Command output was recorded.",
        next: failed ? "Diagnose the failed command before retrying." : "Continue from the command result.",
      };
    }
    if (failed) {
      return {
        why: "Keep the blocked operation visible so recovery starts from the real failure.",
        action: `Attempted ${targets}.`,
        result: resultLine || "The operation did not complete successfully.",
        next: "Adjust the target, permission, or approach before retrying.",
      };
    }
    return {
      why: "Preserve process context for auditability.",
      action: `Recorded process message for ${targets}.`,
      result: resultLine || "Process message was kept in the archive.",
      next: "Continue from the latest useful evidence.",
    };
  }

  if (step.kind === "thinking") {
    return {
      why: "保留最新判断，避免旧思考在时间线里堆叠。",
      action: "提取最新一段有效思考摘要。",
      result: resultLine || "已生成最新思考摘要。",
      next: "用这段判断指导下一步操作。",
    };
  }
  if (step.kind === "discover") {
    return {
      why: "先把任务定位到相关文件或符号，减少无关读取。",
      action: `搜索或扫描了 ${targets}。`,
      result: resultLine || `已把范围收敛到 ${targets}。`,
      next: "下一步读取最小必要上下文。",
    };
  }
  if (step.kind === "inspect") {
    return {
      why: "在修改前确认当前实现，避免凭猜测改动。",
      action: `读取或检查了 ${targets}。`,
      result: resultLine || `已记录 ${targets} 的上下文。`,
      next: "只基于已确认的上下文实施修改。",
    };
  }
  if (step.kind === "edit") {
    return {
      why: "把已确认的方案落到具体项目文件。",
      action: `编辑了 ${targets}。`,
      result: step.summary || resultLine || "已记录文件 diff 证据。",
      next: "继续验证被影响的行为。",
    };
  }
  if (step.kind === "verify") {
    return {
      why: "确认改动是否真正满足任务，而不是只看文字总结。",
      action: `运行验证：${targets}。`,
      result: resultLine || step.summary || "已记录验证证据。",
      next: failed ? "先修复失败原因，再重新验证。" : "若证据匹配任务，可用于完成审计。",
    };
  }
  if (step.kind === "command") {
    return {
      why: "用命令输出作为下一步判断的真实反馈。",
      action: `执行了 ${targets}。`,
      result: resultLine || step.summary || "已记录命令输出。",
      next: failed ? "先诊断失败命令，再调整重试。" : "根据命令结果继续推进。",
    };
  }
  if (failed) {
    return {
      why: "保留受阻操作，恢复时从真实失败点继续。",
      action: `尝试处理 ${targets}。`,
      result: resultLine || "该操作没有成功完成。",
      next: "调整目标、权限或方案后再继续。",
    };
  }
  return {
    why: "保留过程上下文，方便审计和回看。",
    action: `记录了 ${targets} 的过程消息。`,
    result: resultLine || "过程消息已进入归档。",
    next: "从最新有效证据继续。",
  };
}

function makeNarrativeIntent(step: TurnArchiveStep, language: ToolPresentationLanguage): string {
  const note = String(step.note || "").trim();
  if (note && !isLowValueProcessNote(note)) {
    return compactLine(note, 320);
  }

  const targets = makeTargetSummary(step.targets, language);
  const failed = step.status === "failed" || step.status === "rejected" || step.kind === "blocked";
  if (language === "en") {
    if (step.kind === "discover") return compactLine(`Narrow the relevant scope${targets ? ` around ${targets}` : ""}.`, 180);
    if (step.kind === "inspect") return compactLine(`Check the necessary context${targets ? ` in ${targets}` : ""}.`, 180);
    if (step.kind === "edit") return compactLine(`Apply the focused change${targets ? ` in ${targets}` : ""}.`, 180);
    if (step.kind === "verify") return compactLine(`Verify the changed behavior${targets ? ` with ${targets}` : ""}.`, 180);
    if (step.kind === "command") return compactLine(`Run the command${targets ? `: ${targets}` : ""}.`, 180);
    if (failed) return compactLine(`This step is blocked${targets ? ` at ${targets}` : ""}; keep the evidence available.`, 180);
    return compactLine(step.summary || step.action || step.why || "Keep this process step available.", 180);
  }
  if (step.kind === "discover") return compactLine(`收敛相关范围${targets ? `：${targets}` : ""}。`, 180);
  if (step.kind === "inspect") return compactLine(`核对必要上下文${targets ? `：${targets}` : ""}。`, 180);
  if (step.kind === "edit") return compactLine(`实施聚焦修改${targets ? `：${targets}` : ""}。`, 180);
  if (step.kind === "verify") return compactLine(`验证受影响行为${targets ? `：${targets}` : ""}。`, 180);
  if (step.kind === "command") return compactLine(`执行命令${targets ? `：${targets}` : ""}。`, 180);
  if (failed) return compactLine(`该步骤受阻${targets ? `：${targets}` : ""}，保留证据便于恢复。`, 180);
  return compactLine(step.summary || step.action || step.why || "保留过程步骤。", 180);
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
      why: "",
      action: "",
      result: "",
      next: "",
      note: extractReasoningNoteFromText(String(block.content || ""), language),
      summary: "",
      targets: [],
      items: [block],
      expandedByDefault: true,
      sourceIndex: index,
      sourceEndIndex: index,
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
      why: "",
      action: "",
      result: "",
      next: "",
      note: "",
      summary: "",
      targets: target ? [target] : [],
      items: [block],
      expandedByDefault: status === "failed" || status === "rejected",
      sourceIndex: index,
      sourceEndIndex: index,
    };
  }

  const note = block.type === "agent"
    ? extractReasoningNoteFromText(String(block.content || block.message || ""), language)
    : "";
  return {
    id: `turn-archive-step-message-${block.id ?? index}`,
    kind: "message",
    status: "done",
    intent: defaultIntentForStep("message", language),
    why: "",
    action: "",
    result: "",
    next: "",
    note,
    summary: "",
    targets: [],
    items: [block],
    expandedByDefault: false,
    sourceIndex: index,
    sourceEndIndex: index,
  };
}

function finalizeStep(
  step: TurnArchiveStep,
  language: ToolPresentationLanguage,
  sourceBlocks: any[],
  includeThoughtNotes: boolean,
): TurnArchiveStep {
  const targets = uniqueTargets(step.items, language);
  const kind = step.kind;
  const fallbackIntent = isContextPhase(kind) && step.items.length > 1
    ? defaultIntentForStep(kind, language)
    : step.intent || defaultIntentForStep(kind, language);
  const summary = makeSummaryForStep({ ...step, targets }, language);
  const narrative = defaultNarrativeForStep({ ...step, targets, summary }, language);
  const hasPersistedIntent = step.items.length === 1 && String(step.items[0]?.intentSummary || "").trim().length > 0;
  const note = step.note || findNearestReasoningNote({
    sourceBlocks,
    beforeIndex: step.sourceIndex,
    kind: step.kind,
    language,
    includeThoughts: includeThoughtNotes,
  });
  const intent = hasPersistedIntent ? fallbackIntent : makeNarrativeIntent({ ...step, targets, ...narrative, note, summary }, language);
  return {
    ...step,
    targets,
    ...narrative,
    note,
    intent,
    summary,
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

function buildModelFromSteps(input: {
  blocks: any[];
  sourceBlocks?: any[];
  steps: TurnArchiveStep[];
  language: ToolPresentationLanguage;
  includeThoughtNotes?: boolean;
}): TurnProcessArchiveModel {
  const includeThoughtNotes = input.includeThoughtNotes !== false;
  const sourceBlocks = input.sourceBlocks || input.blocks;
  const finalizedSteps = input.steps.map((step) => finalizeStep(step, input.language, sourceBlocks, includeThoughtNotes));
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
    blocks: input.blocks,
    steps: finalizedSteps,
    counts,
    totalCount: input.blocks.length,
    stepCount: finalizedSteps.length,
    summaryText: makeSummaryText(finalizedSteps, counts, input.language),
    currentJudgment: includeThoughtNotes ? getLatestReasoningNote(sourceBlocks, input.language, includeThoughtNotes) : "",
    previewTargets,
  };
}

export function buildTurnProcessArchiveModel(input: {
  blocks: any[];
  finalVisibleAgentIndex: number;
  language?: ToolPresentationLanguage;
  includeThoughts?: boolean;
  includeThoughtNotes?: boolean;
}): TurnProcessArchiveModel {
  const language = normalizeLanguage(input.language);
  const includeThoughts = input.includeThoughts !== false;
  const includeThoughtNotes = input.includeThoughtNotes !== false;
  const latestThoughtId = getLatestThoughtBlock(input.blocks)?.id ?? null;
  const archiveEntries = input.blocks
    .map((block, index) => ({ block, index }))
    .filter(({ block, index }) => {
    if (!isProcessArchiveCandidate(block, input.finalVisibleAgentIndex, index)) return false;
    if (block.type === "thought" && !includeThoughts) return false;
    if (block.type === "thought" && block.id !== latestThoughtId) return false;
    return true;
  });
  const archiveBlocks = archiveEntries.map((entry) => entry.block);

  const steps: TurnArchiveStep[] = [];
  archiveEntries.forEach(({ block, index }) => {
    const next = makeStep({ block, index, language });
    const current = steps[steps.length - 1] || null;
    if (canMergeSteps(current, next)) {
      current!.items.push(...next.items);
      current!.targets = uniqueTargets(current!.items, language);
      current!.expandedByDefault = current!.expandedByDefault || next.expandedByDefault;
      current!.sourceEndIndex = next.sourceEndIndex;
      if (isContextPhase(current!.kind) && isContextPhase(next.kind)) {
        current!.intent = defaultIntentForStep(current!.kind, language);
      }
      return;
    }
    steps.push(next);
  });

  return buildModelFromSteps({
    blocks: archiveBlocks,
    sourceBlocks: input.blocks,
    steps,
    language,
    includeThoughtNotes,
  });
}

export function buildLiveTurnProcessTimelineModel(input: {
  blocks: any[];
  language?: ToolPresentationLanguage;
  includeThoughts?: boolean;
}): TurnProcessArchiveModel {
  const language = normalizeLanguage(input.language);
  const includeThoughts = input.includeThoughts !== false;
  const liveBlocks: any[] = [];
  const steps: TurnArchiveStep[] = [];
  let current: TurnArchiveStep | null = null;

  input.blocks.forEach((block, index) => {
    if (!block || block.type === "user") return;
    if (block.type === "thought") {
      current = null;
      return;
    }
    if (!isLiveProcessCandidate(block)) {
      current = null;
      return;
    }

    liveBlocks.push(block);
    const next = makeStep({ block, index, language });
    if (canMergeSteps(current, next)) {
      current!.items.push(...next.items);
      current!.targets = uniqueTargets(current!.items, language);
      current!.expandedByDefault = current!.expandedByDefault || next.expandedByDefault;
      current!.sourceEndIndex = next.sourceEndIndex;
      if (isContextPhase(current!.kind) && isContextPhase(next.kind)) {
        current!.intent = defaultIntentForStep(current!.kind, language);
      }
      return;
    }

    steps.push(next);
    current = next;
  });

  return buildModelFromSteps({
    blocks: liveBlocks,
    sourceBlocks: input.blocks,
    steps,
    language,
    includeThoughtNotes: includeThoughts,
  });
}
