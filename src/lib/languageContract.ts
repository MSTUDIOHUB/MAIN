import { detectResponseLanguageMismatch } from "./workflowModels";

export function buildRuntimeLanguageDirective(language: "zh" | "en"): string {
  if (language === "en") {
    return [
      "[LANGUAGE CONTRACT]",
      "Always write every user-facing text in idiomatic English: brief progress updates before tool calls, interactive questions and options, subagent summaries, plan documents, and final responses.",
      "Keep code symbols, file paths, and shell commands verbatim.",
    ].join(" ");
  }
  return [
    "[语言一致性契约]",
    "面向用户的所有输出必须全程使用简体中文，包括：调用工具前附带的 1–2 句阶段进展说明、澄清提问与选项、子智能体汇报摘要、计划文档正文以及最终总结。",
    "严禁在调用工具前输出 \"I'll start by...\"、\"I've now...\"、\"Let me...\" 等英文过渡句；仅代码标识符、文件路径与 Shell 命令保留原文。",
  ].join(" ");
}

export function shouldPublishPublicCommentary(
  text: string,
  targetLanguage: "zh" | "en",
): {
  readonly allow: boolean;
  readonly reason: "empty" | "language_mismatch" | null;
  readonly detectedLanguage: "zh" | "en" | null;
  readonly hanCount: number;
  readonly latinWords: number;
} {
  const trimmed = String(text || "").trim();
  if (!trimmed) {
    return {
      allow: false,
      reason: "empty",
      detectedLanguage: null,
      hanCount: 0,
      latinWords: 0,
    };
  }
  const check = detectResponseLanguageMismatch({
    text: trimmed,
    targetLanguage,
  });
  return {
    allow: !check.mismatch,
    reason: check.mismatch ? "language_mismatch" : null,
    detectedLanguage: check.detectedLanguage,
    hanCount: check.hanCount,
    latinWords: check.latinWords,
  };
}

export function buildCommentaryLanguageAnchor(targetLanguage: "zh" | "en"): string {
  return targetLanguage === "zh"
    ? "上一轮随工具附带的英文进展说明已被系统拦截。接下来的所有面向用户的阶段说明、提问与计划正文必须全部使用简体中文（代码/路径/命令除外）。"
    : "The previous non-English progress commentary was suppressed. Write all upcoming user-facing progress notes, questions, and plan text in English (keeping code/paths/commands verbatim).";
}

export function buildPlanDeliverableLanguageRejection(targetLanguage: "zh" | "en"): string {
  return targetLanguage === "zh"
    ? "WORK_PLAN_REJECTED: 提交的计划正文（planMarkdown/markdown）使用了与用户语言不一致的英文。请保持相同技术方案与步骤，将全部面向用户的计划正文、标题与说明改写为简体中文后重新提交（代码符号、路径与命令保持原样）。"
    : "WORK_PLAN_REJECTED: The submitted plan Markdown body does not match the user's English language requirement. Rewrite all user-facing headings, prose, and descriptions in English (keeping code symbols, paths, and commands verbatim) and resubmit.";
}
