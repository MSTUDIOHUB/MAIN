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
  type ValidationObligation,
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
  validationObligations: ValidationObligation[];
  unsatisfiedObligationCount: number;
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
  if (entry.automaticValidation === true) return true;
  return entry.kind === "cmd" &&
    entry.sourceTool === "run_command" &&
    isFinitePlanValidationCommand(entry.value || entry.target || "");
}

const INTERACTION_BINDING_IDENTIFIER_RE = /^(?:addEventListener|on[A-Z_$][\w$]*|on(?:click|change|input|submit|keydown|keyup|pointer\w*|mouse\w*|touch\w*)|handle[A-Z_$][\w$]*|[\w$]*(?:Handler|Callback|Listener))$/;
const GENERIC_IDENTIFIER_PARTS = new Set([
  "add", "event", "listener", "handle", "handler", "callback", "function",
  "const", "let", "var", "document", "window", "element", "target", "current",
  "query", "selector", "get", "by", "id", "class", "name", "click", "change",
]);

function identifierParts(value: string): string[] {
  return String(value || "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((part) => part.length > 1 && !GENERIC_IDENTIFIER_PARTS.has(part));
}

function deriveInteractionRequirement(entry: PlanExecutionEvidenceEntry): {
  required: boolean;
  behaviorTargets: string[];
} {
  const structuralTargets = (entry.interactionBehaviorTargets || [])
    .map((target) => String(target || "").trim())
    .filter(Boolean);
  if (entry.interactionMutation === true) {
    return {
      required: true,
      behaviorTargets: Array.from(new Set(structuralTargets)).slice(0, 80),
    };
  }
  const identifiers = entry.changedIdentifiers || [];
  if (!identifiers.some((identifier) => INTERACTION_BINDING_IDENTIFIER_RE.test(identifier))) {
    return { required: false, behaviorTargets: [] };
  }
  return {
    required: true,
    behaviorTargets: Array.from(new Set(identifiers.filter((identifier) =>
      !INTERACTION_BINDING_IDENTIFIER_RE.test(identifier) && identifierParts(identifier).length > 0
    ))).slice(0, 80),
  };
}

function actionMatchesBehaviorTargets(actionTarget: string, behaviorTargets: string[]): boolean {
  // A browser action can close an interaction obligation only when the source
  // mutation supplied a concrete behavior target. Treating an empty target
  // set as a wildcard would let an unrelated click certify unknown behavior.
  if (behaviorTargets.length === 0) return false;
  const normalizedAction = String(actionTarget || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
  const actionParts = new Set(identifierParts(actionTarget));
  return behaviorTargets.some((behaviorTarget) => {
    const normalizedBehavior = behaviorTarget.toLowerCase().replace(/[^a-z0-9]+/g, "");
    if (normalizedBehavior.length >= 3 && normalizedAction.includes(normalizedBehavior)) return true;
    const behaviorParts = identifierParts(behaviorTarget);
    if (behaviorParts.length === 0) return false;
    const overlap = behaviorParts.filter((part) => actionParts.has(part));
    return overlap.length >= Math.min(2, behaviorParts.length) ||
      overlap.some((part) => part.length >= 4);
  });
}

function assertionMatchesActionEffect(
  assertionKind: string,
  effectChangedFields: string[],
): boolean {
  const fields = new Set(effectChangedFields);
  if (assertionKind === "text" || assertionKind === "not_text") {
    return fields.has("bodyText") ||
      fields.has("externalDomFingerprint") ||
      fields.has("target.text");
  }
  if (assertionKind === "selector" || assertionKind === "not_selector") {
    return fields.has("externalDomFingerprint") ||
      [...fields].some((field) => field.startsWith("target."));
  }
  return assertionKind === "title" && fields.has("title");
}

export function browserInteractionSatisfiesObligation(
  entry: PlanExecutionEvidenceEntry,
  behaviorTargets: string[],
): boolean {
  const interaction = entry.browserInteraction;
  if (
    behaviorTargets.length === 0 ||
    entry.observationStatus === "failed" ||
    !interaction ||
    interaction.pageErrors.length > 0 ||
    interaction.consoleErrors.length > 0 ||
    interaction.actions.length === 0 ||
    interaction.assertions.length === 0 ||
    interaction.actions.some((action) => !action.succeeded) ||
    interaction.assertions.some((assertion) => !assertion.passed)
  ) {
    return false;
  }
  return interaction.actions.some((action) => {
    if (
      !action.succeeded ||
      action.stateChanged !== true ||
      action.effectStateChanged !== true ||
      !Array.isArray(action.effectChangedFields) ||
      action.effectChangedFields.length === 0 ||
      !action.id ||
      !actionMatchesBehaviorTargets(action.target, behaviorTargets)
    ) return false;
    return interaction.assertions.some((assertion) =>
      assertion.passed &&
      assertion.beforePassed === false &&
      assertion.changedAfterAction === true &&
      assertion.causallyLinked === true &&
      assertion.afterActionId === action.id &&
      assertion.kind !== "no_console_errors" &&
      assertionMatchesActionEffect(assertion.kind, action.effectChangedFields || []) &&
      String(assertion.target || "").trim().length > 0
    );
  });
}

/** Build acceptance work only from structured mutation and tool evidence. */
export function buildValidationObligations(
  ledger: PlanExecutionEvidenceEntry[],
): ValidationObligation[] {
  const obligations: ValidationObligation[] = ledger
    .filter((entry) => entry.kind === "tauri_required")
    .map((entry) => ({
      id: `external-advisory:${entry.id}`,
      kind: "external_advisory" as const,
      target: entry.target || entry.value,
      status: "advisory" as const,
    }));
  const indexedBrowserEntries = ledger.flatMap((entry, index) => (
    entry.kind === "browser_dom" ||
    entry.kind === "browser_screenshot" ||
    /(?:browser|playwright|puppeteer|cypress)/i.test(entry.sourceTool)
  ) ? [{ entry, index }] : []);

  ledger.forEach((mutation, mutationIndex) => {
    if (!isMutationEvidenceEntry(mutation)) return;
    const interactionRequirement = deriveInteractionRequirement(mutation);
    if (!interactionRequirement.required) return;
    const behaviorTargets = interactionRequirement.behaviorTargets;
    const laterBrowserEntries = indexedBrowserEntries.filter(({ index }) => index > mutationIndex);
    const latestRelevantBrowser = [...laterBrowserEntries].reverse().find(({ entry }) => {
      const interaction = entry.browserInteraction;
      if (entry.observationStatus === "failed" && (!interaction || interaction.actions.length === 0)) {
        return true;
      }
      return Boolean(interaction?.actions.some((action) =>
        actionMatchesBehaviorTargets(action.target, behaviorTargets)
      ));
    })?.entry;
    // Browser evidence is temporal: a later failed interaction invalidates an
    // older success for the same behavior target. Completion must describe the
    // latest observed page state, not cherry-pick a historical passing click.
    const satisfyingEntry = latestRelevantBrowser &&
      browserInteractionSatisfiesObligation(latestRelevantBrowser, behaviorTargets)
      ? latestRelevantBrowser
      : undefined;
    const latestInteraction = latestRelevantBrowser?.browserInteraction;
    const latestFailed = Boolean(
      latestRelevantBrowser?.observationStatus === "failed" ||
      latestInteraction?.pageErrors.length ||
      latestInteraction?.consoleErrors.length ||
      latestInteraction?.actions.some((action) => !action.succeeded) ||
      latestInteraction?.assertions.some((assertion) => !assertion.passed) ||
      (latestRelevantBrowser && !browserInteractionSatisfiesObligation(latestRelevantBrowser, behaviorTargets))
    );
    obligations.push({
      id: `browser-interaction:${mutation.id}`,
      kind: "browser_interaction",
      mutationEvidenceId: mutation.id,
      target: mutation.target || mutation.value,
      behaviorTargets,
      status: latestFailed ? "failed" : satisfyingEntry ? "satisfied" : "open",
      ...(satisfyingEntry ? { satisfiedByEvidenceId: satisfyingEntry.id } : {}),
    });
  });
  return obligations;
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
  const validationObligations = buildValidationObligations(ordered);
  const unsatisfiedObligations = validationObligations.filter((obligation) =>
    obligation.status === "open" || obligation.status === "failed"
  );
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
  if (
    (latestMutationAt === null || !input.validationExpected) &&
    !hasDevServerLifecycle &&
    unsatisfiedObligations.length === 0
  ) {
    const completionAllowed = unresolvedFailures.length === 0;
    return {
      mutationCount: mutations.length,
      validationCount: 0,
      latestMutationAt,
      latestValidationAt: null,
      latestReadyAt: null,
      longRunningStatus: "none",
      unresolvedFailureCount: unresolvedFailures.length,
      validationObligations,
      unsatisfiedObligationCount: unsatisfiedObligations.length,
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
    isSuccessfulValidationEvidenceEntry(entry) &&
    (
      !validationObligations.some((obligation) => obligation.kind === "browser_interaction") ||
      validationObligations.some((obligation) =>
        obligation.kind === "browser_interaction" &&
        obligation.satisfiedByEvidenceId === entry.id
      )
    )
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
  } else if (unsatisfiedObligations.some((obligation) => obligation.kind === "browser_interaction")) {
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
    validationObligations,
    unsatisfiedObligationCount: unsatisfiedObligations.length,
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
