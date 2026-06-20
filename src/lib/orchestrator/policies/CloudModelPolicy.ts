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
}
