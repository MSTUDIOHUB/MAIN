import type { PlanToolActivitySummary } from "../../planExecutionRecovery";
import type { PlanTaskEvidenceAudit } from "../../workflowModels";

export interface StrategySwitchContext {
  language: "zh" | "en";
  remainingText: string;
  repeatedTargets: string[];
  recentToolActivity: PlanToolActivitySummary[];
  allowFileRead?: boolean;
}

export interface PauseMessageContext {
  language: "zh" | "en";
  remainingText: string;
  consecutiveNoToolCount: number;
  audit?: PlanTaskEvidenceAudit;
  completionClaimRejected?: boolean;
  availableToolNames?: Iterable<string> | null;
}

/**
 * ExecutionPolicy defines the strategy for model-specific behaviors
 * during orchestrator execution. Different policies (e.g., Local vs. Cloud)
 * can implement these methods to provide tailored prompts and constraints.
 */
export interface ExecutionPolicy {
  /**
   * The name of the policy (e.g., "local-reasoning", "cloud-standard").
   */
  name: string;

  /**
   * Returns a prompt that attempts to break the model out of a no-progress loop.
   * Local models might need stronger, more explicit interruptions.
   */
  getNoProgressStrategySwitchPrompt(context: StrategySwitchContext): string;

  /**
   * Returns a pause message when the model repeatedly stops without using a tool.
   * Local models might need stricter guidance to resume correctly.
   */
  getNoToolPauseMessage(context: PauseMessageContext): string;

  /**
   * Defines the maximum allowed consecutive read-only passes before forcing a strategy switch.
   */
  getMaxReadOnlyPasses(): number;

  /**
   * Defines the maximum allowed consecutive stops without tools.
   */
  getMaxNoToolStops(): number;

  /**
   * Returns a stop/halt message when the model outputs >80% reasoning content with no tool calls.
   */
  getReasoningDominatedStopMessage(language: "zh" | "en", reasoningRatio: number): string;

  /**
   * Returns a JSON schema or constraint structure for tool execution turns to force structured outputs.
   */
  getResponseFormatSchema?(): Record<string, unknown>;
}
