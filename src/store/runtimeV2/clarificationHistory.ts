import type { AgentMessage } from "../../lib/agentMessages";
import type { RuntimeV2Event } from "../../lib/runtime-v2";

/** User answers are canonical history, not model-generated authorization. */
export function runtimeV2ClarificationMessage(event: RuntimeV2Event): AgentMessage | null {
  if (event.type === "run.decision_recorded" && event.answer) {
    return { role: "user", content: `Confirmed information (not execution approval):\n${JSON.stringify(event.answer.answers)}` };
  }
  return event.type === "run.decision_recorded" && event.reply?.trim()
    ? { role: "user", content: event.reply } : null;
}
