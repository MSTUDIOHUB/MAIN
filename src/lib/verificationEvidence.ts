import { analyzePtyObservationResult } from "./devServerRuntime";
import {
  browserResultLooksSuccessful,
  commandResultLooksSuccessful,
} from "./planEvidence";
import {
  parseToolFeedbackEnvelope,
  type ToolFeedbackStatus,
} from "./toolFeedbackEnvelope";

export const VERIFICATION_TOOL_NAMES = new Set([
  "run_command",
  "browser_evaluate",
  "execute_command",
  "send_pty_input",
  "read_pty_buffer",
  "read_pty_tail",
  "read_pty_since",
  "get_pty_status",
]);

const PTY_OBSERVATION_TOOL_NAMES = new Set([
  "read_pty_buffer",
  "read_pty_tail",
  "read_pty_since",
  "get_pty_status",
]);

export interface VerificationToolObservation {
  name: string;
  content: string;
  isError?: boolean;
  internalFeedback?: boolean;
  feedbackStatus?: ToolFeedbackStatus | null;
}

/**
 * Provider-neutral verification classification shared by the live loop and
 * Goal continuation replay. Starting or typing into a PTY is progress; only a
 * later ready observation verifies the long-lived process.
 */
export function isSuccessfulVerificationToolObservation(
  observation: VerificationToolObservation,
): boolean {
  if (
    observation.isError ||
    observation.internalFeedback ||
    !VERIFICATION_TOOL_NAMES.has(observation.name)
  ) {
    return false;
  }

  const parsedFeedback = parseToolFeedbackEnvelope(observation.content || "");
  const feedbackStatus = observation.feedbackStatus ?? parsedFeedback?.envelope.status ?? null;
  if (feedbackStatus !== null && feedbackStatus !== "completed") return false;
  const content = parsedFeedback?.body ?? observation.content ?? "";

  if (observation.name === "browser_evaluate") {
    return browserResultLooksSuccessful(content);
  }
  if (observation.name === "execute_command" || observation.name === "send_pty_input") {
    return false;
  }
  if (PTY_OBSERVATION_TOOL_NAMES.has(observation.name)) {
    return analyzePtyObservationResult(content).status === "ready";
  }
  if (observation.name === "run_command") {
    return commandResultLooksSuccessful(observation.name, content);
  }
  return false;
}
