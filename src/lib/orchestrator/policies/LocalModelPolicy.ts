import type { ExecutionPolicy, PauseMessageContext, StrategySwitchContext } from "./ExecutionPolicy";

export class LocalModelPolicy implements ExecutionPolicy {
  name = "local-reasoning";

  getNoProgressStrategySwitchPrompt(context: StrategySwitchContext): string {
    const { language, remainingText, repeatedTargets, allowFileRead } = context;
    const repeatedTargetsStr = repeatedTargets.length > 0
      ? repeatedTargets.join(language === "zh" ? "、" : ", ")
      : language === "zh" ? "最近已读目标" : "recently read targets";

    if (language === "en") {
      return [
        "CRITICAL INSTRUCTION: You are trapped in a thinking loop. You are reading the same information repeatedly without taking action.",
        "STOP internal debate. DO NOT read these targets again:",
        `[ ${repeatedTargetsStr} ]`,
        "You MUST take a concrete action now.",
        allowFileRead
          ? "You may read exactly ONE new file, or immediately use an action tool (like `apply_patch`, `run_command`)."
          : "READING IS BLOCKED. You MUST use an action tool (`apply_patch`, `replace_in_file`, `write_file`, `run_command`). If you cannot, you must output a tool call declaring your exact blocker.",
        `Unsatisfied task: ${remainingText}`,
      ].join("\n");
    }

    return [
        "【严重警告】你陷入了死循环。你在反复读取相同的信息而没有任何实质行动，这会导致上下文溢出！",
        "停止内部的反复纠结！不要再读取以下目标：",
        `[ ${repeatedTargetsStr} ]`,
        "你必须立即采取具体的修改或验证行动！",
        allowFileRead
          ? "你可以再读取一个新文件，或者立刻调用行动工具（如 `apply_patch`、`run_command`）。"
          : "【读取已被系统拦截】你必须使用修改工具 (`apply_patch`, `replace_in_file`, `write_file`) 或运行命令。如果你真的一筹莫展，请用工具返回具体的阻塞原因！",
        `证据未满足任务：${remainingText}`,
    ].join("\n");
  }

  getNoToolPauseMessage(context: PauseMessageContext): string {
    const { language, remainingText, consecutiveNoToolCount, completionClaimRejected } = context;
    
    if (language === "en") {
      return [
        "CRITICAL ERROR: Plan Execution Halted.",
        completionClaimRejected
          ? "You claimed completion, but the verification audit failed. Your text output does NOT count as evidence."
          : `You returned pure text ${consecutiveNoToolCount} times without invoking any tool! Prose cannot execute tasks.`,
        "Your internal reasoning is completely disconnected from the required actions.",
        `Remaining tasks: ${remainingText}`,
        "Next Action: You must invoke a valid tool. Do not generate another lengthy prose explanation."
      ].join("\n");
    }

    return [
      "【致命错误】执行已强制中断！",
      completionClaimRejected
        ? "你声称计划已完成，但系统审计未通过！你输出的纯文本无法作为任务完成的证据。"
        : `你已经连续 ${consecutiveNoToolCount} 次只输出聊天文本而没有调用任何工具！聊天文本无法修改代码！`,
      "你的思维过程已经与实际执行脱节。",
      `未完成任务：${remainingText}`,
      "下一步行动指令：点击继续后，你必须立刻调用一个有效的工具！严禁再输出长篇大论的分析文本！"
    ].join("\n");
  }

  getMaxReadOnlyPasses(): number {
    return 2; // Strict limit to prevent local reasoning models from endlessly exploring
  }

  getMaxNoToolStops(): number {
    return 2; // Strict limit to stop text loops faster
  }
}
