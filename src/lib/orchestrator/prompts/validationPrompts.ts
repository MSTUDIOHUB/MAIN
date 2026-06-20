export function buildProseCodeDumpNotice(language: "zh" | "en", charCount: number): string {
  const formatted = charCount.toLocaleString();
  return language === "zh"
    ? `模型刚才把约 ${formatted} 个字符的代码作为聊天正文输出了，但没有通过写入工具落到真实文件。为避免界面卡死，我已将这段超长正文收起；接下来会强制它改用 \`apply_patch\` / \`write_file\` / \`replace_in_file\` 写入项目文件。`
    : `The model just produced about ${formatted} characters of code as chat text instead of writing real files. To keep the UI responsive, I compacted that oversized reply and will force the next step to use \`apply_patch\` / \`write_file\` / \`replace_in_file\` for actual project files.`;
}

export function buildNonActionableStopMessage(language: "zh" | "en", reason: "no_output" | "missing_tool_loop" | "incomplete_plan" | "plain_text_execution"): string {
  if (language === "zh") {
    switch (reason) {
      case "no_output":
        return "模型连续没有产生可见结果或可执行动作，本轮已停止。没有生成计划文件，也没有写入项目文件。";
      case "missing_tool_loop":
        return "模型连续输出说明或代码正文，但没有使用写入/读取工具，本轮已停止。聊天内容不会被当作已写入文件。";
      case "incomplete_plan":
        return "计划生成已暂停：模型写出的 plan.md 没有通过质量门，MAIN 也无法从当前干净证据生成可审批的 \`.MAIN/plans/plan.md\`。请查看调试日志中的 \`plan_evidence_sanitized\` 与 \`plan_quality_gate_recovery_decision\`，优先补足缺失的源码证据或修复证据污染。";
      default:
        return "模型只输出了文字说明，没有产生真实工具调用或文件变更，本轮已停止。";
    }
  }

  switch (reason) {
    case "no_output":
      return "The model repeatedly produced no visible result or executable action, so this turn stopped. No plan files or project files were created.";
    case "missing_tool_loop":
      return "The model kept producing prose or code in chat without using read/write tools, so this turn stopped. Chat text is not treated as written files.";
    case "incomplete_plan":
      return "Plan generation paused: the model's plan.md failed the quality gate, and MAIN could not generate a reviewable \`.MAIN/plans/plan.md\` from the current clean evidence. Check \`plan_evidence_sanitized\` and \`plan_quality_gate_recovery_decision\` in the debug log, then add the missing source evidence or fix evidence pollution.";
    default:
      return "The model only produced prose and did not create real tool calls or file changes, so this turn stopped.";
  }
}
