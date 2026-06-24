import type { ExecutionPolicy, PauseMessageContext, StrategySwitchContext } from "./ExecutionPolicy";
import {
  buildApprovedPlanNoProgressStrategySwitchPrompt,
  buildApprovedPlanNoToolPauseMessage
} from "../prompts/planPrompts";

export class CloudModelPolicy implements ExecutionPolicy {
  name = "cloud-standard";

  getNoProgressStrategySwitchPrompt(context: StrategySwitchContext): string {
    return buildApprovedPlanNoProgressStrategySwitchPrompt(context);
  }

  getNoToolPauseMessage(context: PauseMessageContext): string {
    return buildApprovedPlanNoToolPauseMessage(
      context.language,
      context.remainingText,
      context.consecutiveNoToolCount,
      context.audit,
      context.completionClaimRejected,
      context.availableToolNames
    );
  }

  getMaxReadOnlyPasses(): number {
    return 4; // Default cloud behavior
  }

  getMaxNoToolStops(): number {
    return 3; // Default cloud behavior
  }

  getReasoningDominatedStopMessage(language: "zh" | "en", reasoningRatio: number): string {
    const percentage = Math.round(reasoningRatio * 100);
    if (language === "en") {
      return `Halted: cloud execution loop stopped because assistant reasoning output reached ${percentage}% of tokens without any tool calls.`;
    }
    return `执行中止：云端模型输出的推理 Token 占比达到 ${percentage}% 且未调用任何工具，已暂停以防止无意义的上下文消耗。`;
  }
}
