import { stripLeakedReasoning } from "./normalizedTurn";
import { sanitizeAssistantDisplayContent } from "./sanitize";
import type { CollaborationAccessMode } from "./collaborationWorkItems";
import type {
  SpawnSubagentRequest,
  SpawnSubagentResult,
} from "./subagents";

export type CollaborationPresentationLanguage = "zh" | "en";

type AdmittedSubagentResult = Extract<
  SpawnSubagentResult,
  { subagentId: string }
>;

function publicMarkdown(value: unknown): string {
  return stripLeakedReasoning(
    sanitizeAssistantDisplayContent(String(value || "")),
  )
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function publicLabel(value: unknown, fallback: string): string {
  return publicMarkdown(value)
    .replace(/[`*_#~[\]<>]/g, "")
    .replace(/\s+/g, " ")
    .trim() || fallback;
}

function markdownPath(value: string): string {
  return `\`${value.replace(/`/g, "")}\``;
}

function scopeText(
  paths: string[],
  accessMode: CollaborationAccessMode,
  language: CollaborationPresentationLanguage,
): string {
  const access = language === "zh"
    ? accessMode === "write" ? "受限写入" : "只读调查"
    : accessMode === "write" ? "scoped write access" : "read-only investigation";
  const normalized = paths.map((path) => String(path || "").trim()).filter(Boolean);
  if (normalized.length === 0 || normalized.every((path) => path === ".")) {
    return language === "zh"
      ? `当前工作区（${access}）`
      : `Current workspace (${access})`;
  }
  return `${normalized.map(markdownPath).join("、")}（${access}）`;
}

/**
 * Build the durable ChatArea handoff for an admitted child. This projection is
 * runtime-authored from the exact structured spawn contract, so the complete
 * assignment survives even though Capsule intentionally keeps only a short
 * live collaboration status.
 */
export function buildSubagentAssignmentUpdate(input: {
  request: SpawnSubagentRequest;
  result: AdmittedSubagentResult;
  language?: CollaborationPresentationLanguage;
}): string {
  const language = input.language === "en" ? "en" : "zh";
  const name = publicLabel(
    input.result.name,
    language === "zh" ? "子智能体" : "subagent",
  );
  const objective = publicMarkdown(input.request.objective);
  const expectedOutput = publicMarkdown(
    input.request.expectedOutput || input.request.successCriteria,
  );
  const scope = scopeText(
    input.result.allowedPaths,
    input.result.accessMode,
    language,
  );

  if (language === "en") {
    return [
      `I've delegated an independent workstream to **${name}**. I’ll continue the non-overlapping parent work and own the final verification.`,
      "",
      "**Assignment**",
      "",
      objective || "Investigate the delegated scope and return source-backed findings.",
      "",
      "**Authorized scope**",
      "",
      scope,
      ...(expectedOutput
        ? ["", "**Expected handoff**", "", expectedOutput]
        : []),
    ].join("\n");
  }

  return [
    `我已把一项独立工作交给子智能体 **${name}**。主体会同时推进不重叠的部分，并负责最终核验。`,
    "",
    "**分工**",
    "",
    objective || "调查已分配的范围，并返回有源码依据的结论。",
    "",
    "**授权范围**",
    "",
    scope,
    ...(expectedOutput
      ? ["", "**预期交付**", "", expectedOutput]
      : []),
  ].join("\n");
}
