import { hashPlanDraftCandidate } from "../../lib/planDrafts";
import type { RuntimeV2Event, RuntimeV2RunIdentity, TurnAggregateV1 } from "../../lib/runtime-v2";
import { TOOL_SEARCH_TOOL_NAME } from "../../lib/toolSearch";
import { SUBMIT_WORK_PLAN_TOOL_NAME } from "./planModelProtocol";
import { PLAN_SUBMISSION_VALIDATION_REJECTION_CODE } from "./planSubmissionRepair";

export const PLAN_VALIDATION_REPAIR_FAILED = "runtime_v2_plan_validation_repair_failed";

const REJECTION_PREFIX = "WORK_PLAN_REJECTED: ";
const VALIDATION_PATH = /^validations(?:\[\d*\](?:\.\w+|\[\d+\])*)?$/;
const VALIDATION_DIAGNOSTIC_CODES = new Set([
  "plan_validation_not_required",
  "plan_validation_missing",
  "plan_validation_evidence_mismatch",
  "plan_structure_invalid",
]);

function sameRun(left: RuntimeV2RunIdentity, right: RuntimeV2RunIdentity): boolean {
  return left.sessionKey === right.sessionKey && left.sessionEpoch === right.sessionEpoch &&
    left.turnId === right.turnId && left.runId === right.runId &&
    left.parentRunId === right.parentRunId && left.attemptId === right.attemptId;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function validationOnlyDiagnostics(feedback: string): readonly Record<string, unknown>[] | null {
  if (feedback.length > 4_000 || !feedback.startsWith(REJECTION_PREFIX)) return null;
  try {
    const parsed: unknown = JSON.parse(feedback.slice(REJECTION_PREFIX.length));
    return isRecord(parsed) && parsed.code === "PLAN_EXECUTION_READINESS_INCOMPLETE" &&
      (parsed.omittedDiagnosticCount === undefined || parsed.omittedDiagnosticCount === 0) &&
      Array.isArray(parsed.diagnostics) && parsed.diagnostics.length > 0 &&
      parsed.diagnostics.every((diagnostic: unknown) => isRecord(diagnostic) &&
        typeof diagnostic.code === "string" && VALIDATION_DIAGNOSTIC_CODES.has(diagnostic.code) &&
        typeof diagnostic.fieldPath === "string" && VALIDATION_PATH.test(diagnostic.fieldPath) &&
        typeof diagnostic.message === "string" && !!diagnostic.message.trim() &&
        Array.isArray(diagnostic.criterionIds) &&
        diagnostic.criterionIds.every(id => typeof id === "string" && !!id.trim()))
      ? parsed.diagnostics : null;
  } catch {
    return null;
  }
}

function rejectedValidationCommands(
  candidate: Record<string, unknown>,
  diagnostics: readonly Record<string, unknown>[],
): readonly string[] {
  const validations = Array.isArray(candidate.validations) ? candidate.validations : [];
  const commands = diagnostics.flatMap(diagnostic => {
    const field = /^validations\[(\d+)\](\.command)?$/.exec(String(diagnostic.fieldPath));
    if (!field || (!field[2] && diagnostic.normalizationReason !== "non_finite_command_downgraded_to_advisory")) return [];
    const validation: unknown = validations[Number(field[1])];
    const command = isRecord(validation) && typeof validation.command === "string" ? validation.command.trim() : "";
    return command ? [command] : [];
  });
  return [...new Set(commands)];
}

interface ValidationRepairCandidate {
  candidate: Record<string, unknown>;
  feedback: string;
  rejectedCommands: readonly string[];
}

type ValidationRecovery =
  | ({ kind: "focus" | "repair"; reason?: "closed_capability_discovery" } & ValidationRepairCandidate)
  | { kind: "exhausted" };

/** Match the effective capability result, so changing the query text does not
 * reopen the same closed observation. Undecodable and old receipts carry no fact. */
function capabilitySearchResult(content: string | undefined): { unlocked: boolean; key: string } | null {
  if (!content) return null;
  try {
    const result: unknown = JSON.parse(content);
    if (!isRecord(result) || result.type !== "tool_search.result" || !Array.isArray(result.newlyUnlocked) ||
      !Array.isArray(result.alreadyAvailable) || !result.alreadyAvailable.every(name => typeof name === "string")) return null;
    return { unlocked: result.newlyUnlocked.length > 0, key: JSON.stringify([...new Set(result.alreadyAvailable)].sort()) };
  } catch {
    return null;
  }
}

/** Reframe validated but fruitless capability discovery at the current
 * evidence frontier, which is reconstructed from the ledger after a restart. */
export function planValidationRecovery(
  aggregate: TurnAggregateV1,
  run: RuntimeV2RunIdentity,
  recoveryStartedSequence: number | undefined,
): ValidationRecovery | null {
  if (recoveryStartedSequence === undefined) return null;
  const commands = new Map<string, Extract<RuntimeV2Event, { type: "command.scheduled" }>>();
  const rejectedCandidates = new Set<string>();
  const seenCapabilityResults = new Set<string>();
  let latestGap: ValidationRepairCandidate | null = null;
  let duplicate: ValidationRepairCandidate | null = null;
  let closedDiscovery = false;
  let focusSettled = false;
  let repairResponded = false;
  let repairSubmission: { responseSequence: number; callId: string; hash: string } | null = null;
  for (const event of aggregate.events) {
    if (!("run" in event) || !sameRun(event.run, run)) continue;
    if (event.type === "command.scheduled") {
      if (sameRun(event.command.run, run)) commands.set(event.command.idempotencyKey, event);
      continue;
    }
    if (event.type === "provider.responded") {
      repairSubmission = null;
      if (event.sequence < recoveryStartedSequence) continue;
      const request = commands.get(event.idempotencyKey)?.command;
      if (request?.kind === "request_model" && request.payload.planValidationDiscoveryFocus === true) focusSettled = true;
      if (request?.kind !== "request_model" || request.payload.planValidationOnlyRepair !== true) continue;
      repairResponded = true;
      const calls = event.result.toolCalls;
      if (!calls.length) return { kind: "exhausted" };
      const call = calls.length === 1 ? calls[0] : undefined;
      if (call?.name === SUBMIT_WORK_PLAN_TOOL_NAME) {
        repairSubmission = { responseSequence: event.sequence, callId: call.id, hash: hashPlanDraftCandidate(call.arguments) };
      }
      continue;
    }
    if (event.type === "command.completed" && event.status === "failed" && event.failureReasonCode &&
      event.sequence >= recoveryStartedSequence) {
      const request = commands.get(event.idempotencyKey)?.command;
      if (request?.kind === "request_model" && request.payload.planValidationDiscoveryFocus === true) focusSettled = true;
      if (request?.kind === "request_model" && request.payload.planValidationOnlyRepair === true &&
        event.failureReasonCode === PLAN_VALIDATION_REPAIR_FAILED) return { kind: "exhausted" };
      continue;
    }
    if (event.type !== "tool.completed") continue;
    const scheduled = commands.get(event.idempotencyKey);
    if (!scheduled) continue;
    const { command } = scheduled;
    if (latestGap && event.sequence >= recoveryStartedSequence && command.kind === "execute_tool" &&
      command.payload.toolName === TOOL_SEARCH_TOOL_NAME && event.status === "succeeded" && event.receiptOrigin !== "replayed") {
      const result = capabilitySearchResult(event.modelContent);
      if (!result) continue;
      if (result.unlocked) {
        seenCapabilityResults.clear();
        closedDiscovery = false;
      } else {
        closedDiscovery ||= seenCapabilityResults.has(result.key);
        seenCapabilityResults.add(result.key);
      }
      continue;
    }
    if (event.status !== "failed" || event.failureKind !== "protocol_invalid" ||
      event.failureReasonCode !== PLAN_SUBMISSION_VALIDATION_REJECTION_CODE) continue;
    if (command.kind !== "execute_tool" || command.payload.runtimeControlPlane !== true ||
      command.payload.toolName !== SUBMIT_WORK_PLAN_TOOL_NAME || typeof command.payload.toolCallId !== "string") continue;
    latestGap = null;
    duplicate = null;
    if (!focusSettled) {
      seenCapabilityResults.clear();
      closedDiscovery = false;
    }
    const candidate = command.payload.arguments;
    if (!isRecord(candidate)) continue;
    const hash = hashPlanDraftCandidate(candidate);
    if (repairSubmission && scheduled.sequence > repairSubmission.responseSequence &&
      repairSubmission.callId === command.payload.toolCallId && repairSubmission.hash === hash) return { kind: "exhausted" };
    const feedback = event.modelContent || event.presentation?.message;
    if (typeof candidate.planMarkdown !== "string" || !candidate.planMarkdown.trim() || !feedback) continue;
    const diagnostics = validationOnlyDiagnostics(feedback);
    if (!diagnostics) continue;
    latestGap = { candidate, feedback, rejectedCommands: rejectedValidationCommands(candidate, diagnostics) };
    if (event.sequence < recoveryStartedSequence) continue;
    if (rejectedCandidates.has(hash)) duplicate = latestGap;
    rejectedCandidates.add(hash);
  }
  if (repairResponded) return null;
  if (duplicate) return { kind: "repair", ...duplicate };
  return closedDiscovery && latestGap
    ? { kind: focusSettled ? "repair" : "focus", reason: "closed_capability_discovery", ...latestGap }
    : null;
}
