import type { TaskBlock } from "./taskTypes";
import { collectDurableTurnExecutionSummary } from "./durableTurnContext";
import {
  buildPlanTaskEvidenceAudit,
  canDowngradeUnavailableBrowserValidationToAdvisory,
  hasBrowserValidationCapability,
  isPlanTaskAwaitingBrowserValidation,
  isPlanTaskAwaitingExternalValidation,
  isPlanTaskBlockingAutomation,
  type DurableTurnExecutionSummary,
  type PlanExecutionEvidenceEntry,
  type PlanTask,
} from "./workflowModels";

export interface CompletedTurnFinalPresentation {
  text: string;
  source: "model_final" | "durable_evidence_fallback";
  execution: DurableTurnExecutionSummary;
  hasChanges: boolean;
}

export interface TerminalTurnOwnership {
  ownerTurnId: string;
  evidenceTurnIds: string[];
}

export function resolveTerminalTurnOwnership(input: {
  turnId: string;
  uiDisplayTurnId?: string | null;
}): TerminalTurnOwnership {
  const ownerTurnId = String(input.uiDisplayTurnId || input.turnId || "").trim();
  return {
    ownerTurnId,
    evidenceTurnIds: [...new Set([input.turnId, input.uiDisplayTurnId]
      .map((value) => String(value || "").trim())
      .filter(Boolean))],
  };
}

export function shouldCommitCompletedTurnFinalPresentation(input: {
  outcomeStatus: string;
  hasPendingSameTurnExecution?: boolean;
}): boolean {
  return input.outcomeStatus === "completed" && input.hasPendingSameTurnExecution !== true;
}

/**
 * Project only automation-blocking Plan work into a terminal summary. Tasks
 * whose remaining evidence is explicitly user/Tauri validation are advisory
 * once the Plan audit accepts automation completion, not unfinished work.
 */
export function collectPlanTaskTerminalProjection(input: {
  tasks?: PlanTask[] | null;
  evidenceLedger?: PlanExecutionEvidenceEntry[] | null;
  availableToolNames?: Iterable<string> | null;
}): { blocking: string[]; advisories: string[] } {
  const tasks = Array.isArray(input.tasks) ? input.tasks : [];
  if (tasks.length === 0) return { blocking: [], advisories: [] };
  const audit = buildPlanTaskEvidenceAudit({
    tasks,
    ...(Array.isArray(input.evidenceLedger) ? { evidenceLedger: input.evidenceLedger } : {}),
  });
  // Unknown capability is conservative: callers that cannot prove the
  // browser surface was unavailable must keep browser validation blocking.
  const browserValidationAvailable = input.availableToolNames == null
    ? true
    : hasBrowserValidationCapability(input.availableToolNames);
  const unavailableBrowserIsAdvisory = !browserValidationAvailable &&
    canDowngradeUnavailableBrowserValidationToAdvisory(audit);
  const blockingTasks = audit.tasks.filter((task) => isPlanTaskBlockingAutomation(task, {
    browserValidationAvailable,
    unavailableBrowserIsAdvisory,
  }));
  const advisoryTasks = audit.tasks.filter((task) =>
    !isPlanTaskBlockingAutomation(task, {
      browserValidationAvailable,
      unavailableBrowserIsAdvisory,
    }) &&
    (
      isPlanTaskAwaitingExternalValidation(task) ||
      (
        unavailableBrowserIsAdvisory &&
        isPlanTaskAwaitingBrowserValidation(task)
      )
    )
  );
  return {
    blocking: [...new Set(
    blockingTasks
      .map((task) => String(task.text || "").trim())
      .filter(Boolean),
    )],
    advisories: [...new Set(
      advisoryTasks
        .map((task) => String(task.text || "").trim())
        .filter(Boolean),
    )],
  };
}

export function collectBlockingPlanTaskTextsForTerminalSummary(input: {
  tasks?: PlanTask[] | null;
  evidenceLedger?: PlanExecutionEvidenceEntry[] | null;
  availableToolNames?: Iterable<string> | null;
}): string[] {
  return collectPlanTaskTerminalProjection(input).blocking;
}

function bulletList(values: string[]): string[] {
  return values.map((value) => `- ${value}`);
}

function formatAdvisorySection(values: string[], language: "zh" | "en"): string {
  return [
    language === "zh" ? "建议复核" : "Manual review",
    ...bulletList(values),
  ].join("\n");
}

function formatEvidenceFallback(
  execution: DurableTurnExecutionSummary,
  language: "zh" | "en",
): string {
  const sections: string[] = [];
  const hasUnfinished = execution.unfinished.length > 0;
  const hasDurableEvidence = Object.values(execution).some((values) => values.length > 0);
  sections.push(
    hasUnfinished
      ? language === "zh"
        ? "本轮执行已结束，但仍有未完成项。"
        : "This run has ended, but some work remains incomplete."
      : !hasDurableEvidence
      ? language === "zh"
        ? "本轮运行已结束。"
        : "This run has ended."
      : language === "zh"
      ? "已完成本轮工作。"
      : "Completed this task.",
  );

  if (execution.modifiedFiles.length > 0) {
    sections.push([
      language === "zh" ? "修改" : "Changes",
      ...bulletList(execution.modifiedFiles.map((path) => `\`${path}\``)),
    ].join("\n"));
  }
  if (execution.artifacts.length > 0) {
    sections.push([
      language === "zh" ? "产物" : "Artifacts",
      ...bulletList(execution.artifacts.map((path) => `\`${path}\``)),
    ].join("\n"));
  }
  if (execution.validations.length > 0) {
    sections.push([
      language === "zh" ? "验证" : "Validation",
      ...bulletList(execution.validations),
    ].join("\n"));
  } else if (execution.modifiedFiles.length > 0) {
    sections.push(language === "zh" ? "验证：未记录独立的自动验证结果。" : "Validation: no separate automated validation was recorded.");
  }
  if (execution.failures.length > 0) {
    sections.push([
      language === "zh" ? "执行记录中的失败" : "Failures recorded during execution",
      ...bulletList(execution.failures),
    ].join("\n"));
  }
  if (execution.unfinished.length > 0) {
    sections.push([
      language === "zh" ? "未完成" : "Incomplete",
      ...bulletList(execution.unfinished),
    ].join("\n"));
  }
  if (execution.advisories.length > 0) {
    sections.push(formatAdvisorySection(execution.advisories, language));
  }

  if (!hasDurableEvidence) {
    sections.push(
      language === "zh"
        ? "模型没有留下可恢复的最终说明，也没有记录可用于生成执行摘要的持久证据。"
        : "The model left no recoverable final explanation and no durable execution evidence was recorded for a richer summary.",
    );
  }

  return sections.join("\n\n");
}

/**
 * Resolve the one canonical assistant result for an already-committed
 * completed outcome. Progress prose and held drafts are deliberately excluded
 * by the caller; when no published model final exists, this function produces
 * a deterministic report from durable tool evidence.
 */
export function resolveCompletedTurnFinalPresentation(input: {
  turnBlocks: TaskBlock[];
  publishedModelFinalText?: string | null;
  artifactPaths?: string[];
  unfinished?: string[];
  advisories?: string[];
  language: "zh" | "en";
}): CompletedTurnFinalPresentation {
  const execution = collectDurableTurnExecutionSummary({
    turnBlocks: input.turnBlocks,
    artifactPaths: input.artifactPaths,
    unfinished: input.unfinished,
    advisories: input.advisories,
  });
  const publishedModelFinalText = String(input.publishedModelFinalText || "").trim();
  // Runtime-owned blocking evidence outranks model-authored success prose. A
  // completed projection should be rare in this state, but persisted or
  // compatibility runs must still leave a truthful, recoverable conclusion.
  const canUsePublishedModelFinal = Boolean(publishedModelFinalText) &&
    execution.unfinished.length === 0;
  const publishedTextWithAdvisories = canUsePublishedModelFinal && execution.advisories.length > 0
    ? `${publishedModelFinalText}\n\n${formatAdvisorySection(execution.advisories, input.language)}`
    : publishedModelFinalText;
  return {
    text: canUsePublishedModelFinal
      ? publishedTextWithAdvisories
      : formatEvidenceFallback(execution, input.language),
    source: canUsePublishedModelFinal ? "model_final" : "durable_evidence_fallback",
    execution,
    hasChanges: execution.modifiedFiles.length > 0,
  };
}
