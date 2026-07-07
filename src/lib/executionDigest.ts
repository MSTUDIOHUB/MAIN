import type { ResolvedUserIntent } from "./runIntent";

export interface ExecutionDigestToolResult {
  name: string;
  target: string;
  isError: boolean;
  content: string;
  displayContent?: string;
}

export interface BuildExecutionDigestInput {
  language: "zh" | "en";
  turnIntent: ResolvedUserIntent;
  toolResults: ExecutionDigestToolResult[];
  remainingTask?: string;
}

function compactLine(text: string, maxChars: number): string {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  return normalized.length <= maxChars
    ? normalized
    : `${normalized.slice(0, maxChars).trim()}...`;
}

function resolveGoalLabel(intent: ResolvedUserIntent, language: "zh" | "en"): string {
  if (language === "zh") {
    switch (intent) {
      case "plan": return "推进计划任务执行";
      case "analyze": return "完成只读分析与诊断";
      case "summarize": return "提炼关键信息与结论";
      case "report": return "形成结构化报告";
      case "studio_workflow": return "推进 Game Studio 执行链路";
      case "goal": return "自主迭代推进目标";
      default: return "推进实现与验证";
    }
  }
  switch (intent) {
    case "plan": return "progress approved plan execution";
    case "analyze": return "complete read-only analysis";
    case "summarize": return "deliver concise summary";
    case "report": return "deliver a structured report";
    case "studio_workflow": return "advance Game Studio execution";
    case "goal": return "autonomous goal iteration";
    default: return "advance implementation and verification";
  }
}

function formatLatestAction(result: ExecutionDigestToolResult, language: "zh" | "en"): string {
  const base = `${result.name}${result.target ? ` ${result.target}` : ""}`;
  const status = result.isError
    ? (language === "zh" ? "失败" : "failed")
    : (language === "zh" ? "完成" : "done");
  return compactLine(`${base} (${status})`, 84);
}

export function buildExecutionDigest(input: BuildExecutionDigestInput): string {
  const latest = input.toolResults[input.toolResults.length - 1];
  if (!latest) return "";

  const goal = resolveGoalLabel(input.turnIntent, input.language);
  const latestAction = formatLatestAction(latest, input.language);
  const next = latest.isError
    ? (input.language === "zh"
      ? "先诊断最新错误并调整参数，再继续执行。"
      : "Diagnose the latest error, adjust parameters, then continue.")
    : input.remainingTask
    ? (input.language === "zh"
      ? `继续：${compactLine(input.remainingTask, 72)}`
      : `Next: ${compactLine(input.remainingTask, 72)}`)
    : (input.language === "zh"
      ? "继续执行最小必要的下一步验证。"
      : "Continue with the smallest necessary next verification step.");

  return input.language === "zh"
    ? `执行摘要：目标=${goal}；最新动作=${latestAction}；${next}`
    : `Execution digest: goal=${goal}; latest=${latestAction}; ${next}`;
}
