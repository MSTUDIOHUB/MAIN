export function normalizeSyntheticContinuationText(input: unknown): string {
  return String(input || "")
    .replace(/\s+/g, " ")
    .trim();
}

const SYNTHETIC_PREFIX_PATTERNS: RegExp[] = [
  /^\[System:/i,
  /^\[turn_intake\]/i,
  /^EXECUTE_RECOVERY:/i,
  /^PLAN_[A-Z_]+:/i,
  /^Recovery(?:Details)?:/i,
  /^Repeated read-only tool call skipped:/i,
];

const SYNTHETIC_STRONG_PATTERNS: RegExp[] = [
  /^EXECUTE_RECOVERY:/i,
  /用户已经批准本轮执行，但上一条回复/i,
  /The user already approved this execution turn, but the previous response/i,
  /不要询问用户指示[^。\n]{0,40}(?:自己做决定并执行|自行决定并执行)/i,
  /Do not ask the user what to do next/i,
  /Now immediately continue using tools/i,
  /现在请立即用工具继续执行/i,
  /Output exactly one [`<]tool_use[`>] block/i,
  /只输出一个 [`<]tool_use[`>] 工具调用块/i,
  /必须使用 [`<]tool_use[`>] 格式调用工具/i,
];

const SYNTHETIC_BODY_PATTERNS: RegExp[] = [
  /上一条回复(?:仍然|是空的|把|只有|语言)/i,
  /用户已经批准本轮执行，但上一条回复/i,
  /当前 Execute 回合已经耗尽只读预算/i,
  /恢复工具面[:：]/i,
  /Recovery tool surface:/i,
  /The current Execute turn has spent its read-only budget/i,
  /请继续执行你的计划/i,
  /现在请立即用工具继续执行/i,
  /不要只描述接下来要做什么/i,
  /只输出一个 [`<]tool_use[`>] 工具调用块/i,
  /不要询问用户指示/i,
  /Output exactly one [`<]tool_use[`>] block/i,
  /Please continue executing your plan/i,
  /Your previous reply/i,
  /The previous reply/i,
  /Now immediately continue using tools/i,
  /RecoveryDetails:/i,
  /duplicateTool:/i,
  /suggestedNextTask:/i,
  /Detected a repetition loop/i,
  /REPEATED_FAILURE_BLOCKED:/i,
];

function computeSyntheticScore(text: string): number {
  let score = 0;

  if (SYNTHETIC_PREFIX_PATTERNS.some((pattern) => pattern.test(text))) {
    score += 3;
  }
  if (/<tool_use>/i.test(text) && /<tool>/i.test(text) && /<parameter/i.test(text)) {
    score += 2;
  }
  for (const pattern of SYNTHETIC_BODY_PATTERNS) {
    if (pattern.test(text)) score += 1;
  }
  return score;
}

export function looksLikeSyntheticContinuationText(input: unknown): boolean {
  const text = normalizeSyntheticContinuationText(input);
  if (!text) return false;
  if (SYNTHETIC_STRONG_PATTERNS.some((pattern) => pattern.test(text))) {
    return true;
  }
  return computeSyntheticScore(text) >= 3;
}
