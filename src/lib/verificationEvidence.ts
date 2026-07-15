import {
  analyzePtyObservationResult,
  isLocalDevServerHealthProbeCommand,
  resolveDevServerRuntimeState,
} from "./devServerRuntime";
import {
  browserResultLooksSuccessful,
  commandResultLooksSuccessful,
} from "./planEvidence";
import {
  parseToolFeedbackEnvelope,
  type ToolFeedbackStatus,
} from "./toolFeedbackEnvelope";
import {
  isFinitePlanValidationCommand,
  type PlanExecutionEvidenceEntry,
} from "./workflowModels";
import { isWorkspaceMutationToolName } from "./workspaceMutationTools";

export const VERIFICATION_TOOL_NAMES = new Set([
  "run_command",
  "browser_evaluate",
  "execute_command",
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

export type ExecuteEvidenceGap =
  | "none"
  | "validation_after_mutation_required"
  | "pty_observation_required"
  | "browser_validation_required"
  | "unreconciled_failure";

export interface ExecuteEvidenceClosureAudit {
  mutationCount: number;
  validationCount: number;
  latestMutationAt: number | null;
  latestValidationAt: number | null;
  latestReadyAt: number | null;
  longRunningStatus: ReturnType<typeof resolveDevServerRuntimeState>["status"];
  unresolvedFailureCount: number;
  validationAfterLatestMutation: boolean;
  completionAllowed: boolean;
  gap: ExecuteEvidenceGap;
}

function evidenceTime(entry: PlanExecutionEvidenceEntry): number {
  const value = Number(entry.createdAt || 0);
  return Number.isFinite(value) ? value : 0;
}

function isMutationEvidenceEntry(entry: PlanExecutionEvidenceEntry): boolean {
  return entry.kind === "file" || entry.kind === "deliverable";
}

function isSuccessfulValidationEvidenceEntry(entry: PlanExecutionEvidenceEntry): boolean {
  if (
    entry.observationStatus === "failed" ||
    entry.observationStatus === "pending" ||
    entry.observationStatus === "unknown" ||
    entry.observationStatus === "running" ||
    entry.observationStatus === "stopped"
  ) {
    return false;
  }
  if (entry.kind === "browser_dom" || entry.kind === "browser_screenshot") return true;
  if (entry.kind === "tauri_required") return true;
  return entry.kind === "cmd" &&
    entry.sourceTool === "run_command" &&
    isFinitePlanValidationCommand(entry.value || entry.target || "");
}

function latestUnresolvedFailures(
  ledger: PlanExecutionEvidenceEntry[],
): PlanExecutionEvidenceEntry[] {
  const latestByOperation = new Map<string, PlanExecutionEvidenceEntry>();
  for (const entry of ledger) {
    const normalizedTarget = String(entry.target || entry.value || "").trim().toLowerCase();
    const isHealthyExistingServer = entry.sourceTool === "run_command" &&
      entry.observationStatus !== "failed" &&
      isLocalDevServerHealthProbeCommand(entry.value || entry.target || "");
    const isDevServerReconciliation = entry.sourceTool === "execute_command" ||
      PTY_OBSERVATION_TOOL_NAMES.has(entry.sourceTool) ||
      entry.portConflict === true ||
      entry.observationStatus === "ready" ||
      isHealthyExistingServer;
    const key = isDevServerReconciliation
      ? "dev_server_runtime"
      : isWorkspaceMutationToolName(entry.sourceTool) || entry.kind === "file" || entry.kind === "deliverable"
      ? `mutation:${normalizedTarget}`
      : entry.kind === "browser_dom" ||
        entry.kind === "browser_screenshot" ||
        /(?:browser|playwright|puppeteer|cypress)/i.test(entry.sourceTool)
      ? `browser:${normalizedTarget}`
      : `${entry.sourceTool}:${normalizedTarget}`;
    latestByOperation.set(key, entry);
  }
  return [...latestByOperation.values()].filter((entry) =>
    entry.observationStatus === "failed" || entry.portConflict === true
  );
}

/**
 * Runtime-owned completion audit. A source mutation opens a new verification
 * epoch: only evidence created after that mutation can close it. A long-lived
 * launch additionally requires fresh PTY readiness and a later browser check;
 * merely starting the process or rereading source cannot complete the turn.
 */
export function buildExecuteEvidenceClosureAudit(input: {
  ledger: PlanExecutionEvidenceEntry[];
  validationExpected: boolean;
}): ExecuteEvidenceClosureAudit {
  // The ledger is append-only and therefore supplies a stronger causal order
  // than millisecond timestamps. Multiple tool results can legitimately share
  // one Date.now() tick; sorting/filtering only by time could let a validation
  // that occurred before the mutation close the new verification epoch.
  const ordered = [...input.ledger];
  const mutations = ordered.filter(isMutationEvidenceEntry);
  let latestMutationIndex = -1;
  for (let index = ordered.length - 1; index >= 0; index -= 1) {
    if (!isMutationEvidenceEntry(ordered[index])) continue;
    latestMutationIndex = index;
    break;
  }
  const latestMutationAt = mutations.length > 0
    ? evidenceTime(mutations[mutations.length - 1])
    : null;
  const epoch = latestMutationIndex >= 0
    ? ordered.slice(latestMutationIndex)
    : ordered;
  const unresolvedFailures = latestUnresolvedFailures(epoch);
  const devServerLaunches = epoch.filter((entry) =>
    entry.sourceTool === "execute_command" &&
    (
      entry.observationStatus === "pending" ||
      entry.observationStatus === "running" ||
      entry.observationStatus === "failed"
    )
  );
  const hasDevServerLifecycle = devServerLaunches.length > 0;
  // A real long-running launch creates its own causal validation obligation,
  // even when the task did not mutate a file. Do not let the no-mutation fast
  // path skip PTY readiness and the later browser observation.
  if ((latestMutationAt === null || !input.validationExpected) && !hasDevServerLifecycle) {
    const completionAllowed = unresolvedFailures.length === 0;
    return {
      mutationCount: mutations.length,
      validationCount: 0,
      latestMutationAt,
      latestValidationAt: null,
      latestReadyAt: null,
      longRunningStatus: "none",
      unresolvedFailureCount: unresolvedFailures.length,
      validationAfterLatestMutation: completionAllowed,
      completionAllowed,
      gap: completionAllowed ? "none" : "unreconciled_failure",
    };
  }

  const successfulValidations = epoch.filter(isSuccessfulValidationEvidenceEntry);
  const latestValidationAt = successfulValidations.length > 0
    ? evidenceTime(successfulValidations[successfulValidations.length - 1])
    : null;
  const devServerState = hasDevServerLifecycle
    ? resolveDevServerRuntimeState(epoch)
    : null;
  let latestLaunchIndex = -1;
  for (let index = epoch.length - 1; index >= 0; index -= 1) {
    if (
      epoch[index].sourceTool !== "execute_command" ||
      !["pending", "running", "failed"].includes(String(epoch[index].observationStatus || ""))
    ) continue;
    latestLaunchIndex = index;
    break;
  }
  let latestReadyIndex = -1;
  if (hasDevServerLifecycle && devServerState?.status === "ready") {
    for (let index = epoch.length - 1; index > latestLaunchIndex; index -= 1) {
      const entry = epoch[index];
      const readyPtyObservation =
        entry.observationStatus === "ready" &&
        PTY_OBSERVATION_TOOL_NAMES.has(entry.sourceTool) &&
        !(
          typeof devServerState.foregroundGeneration === "number" &&
          entry.foregroundGeneration !== devServerState.foregroundGeneration
        );
      const healthyExistingServer =
        entry.sourceTool === "run_command" &&
        entry.observationStatus !== "failed" &&
        isLocalDevServerHealthProbeCommand(entry.value || entry.target || "");
      if (!readyPtyObservation && !healthyExistingServer) continue;
      latestReadyIndex = index;
      break;
    }
  }
  const latestReadyAt = latestReadyIndex >= 0
    ? evidenceTime(epoch[latestReadyIndex])
    : null;
  const browserAfterReady = latestReadyIndex >= 0 && epoch.some((entry, index) =>
    index > latestReadyIndex &&
    (entry.kind === "browser_dom" || entry.kind === "browser_screenshot") &&
    isSuccessfulValidationEvidenceEntry(entry)
  );

  let gap: ExecuteEvidenceGap = "none";
  if (
    unresolvedFailures.length > 0 ||
    (hasDevServerLifecycle && (devServerState?.status === "failed" || devServerState?.portConflict === true))
  ) {
    gap = "unreconciled_failure";
  } else if (hasDevServerLifecycle && latestReadyAt === null) {
    gap = devServerState?.status === "failed"
      ? "unreconciled_failure"
      : "pty_observation_required";
  } else if (hasDevServerLifecycle && !browserAfterReady) {
    gap = "browser_validation_required";
  } else if (
    !hasDevServerLifecycle &&
    input.validationExpected &&
    latestMutationAt !== null &&
    latestValidationAt === null
  ) {
    gap = "validation_after_mutation_required";
  }

  return {
    mutationCount: mutations.length,
    validationCount: successfulValidations.length,
    latestMutationAt,
    latestValidationAt,
    latestReadyAt,
    longRunningStatus: devServerState?.status ?? "none",
    unresolvedFailureCount: unresolvedFailures.length,
    validationAfterLatestMutation: gap === "none",
    completionAllowed: gap === "none",
    gap,
  };
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
  if (observation.name === "execute_command") {
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
