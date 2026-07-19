import {
  analyzePtyObservationResult,
  isLocalDevServerHealthProbeCommand,
  localDevServerUrlsShareOrigin,
  resolveDevServerRuntimeState,
} from "./devServerRuntime";
import {
  browserResultLooksSuccessful,
  commandResultLooksSuccessful,
  resolveStructuredDesktopAutomationOutcome,
} from "./planEvidence";
import {
  parseToolFeedbackEnvelope,
  type ToolFeedbackStatus,
} from "./toolFeedbackEnvelope";
import {
  classifyFiniteValidationCommandCapability,
  isFinitePlanValidationCommand,
  planCommandEvidenceMatchesExecution,
  requiresPtyObservationForPlanCommand,
  type PlanExecutionEvidenceEntry,
  type PlanTask,
  type ValidationObligation,
} from "./workflowModels";
import {
  looksLikeExplicitShellCommandInput,
  type CommandDirective,
} from "./runIntent";
import type { RecoveryActionContract } from "./executeRecoveryTools";
import { isWorkspaceMutationToolName } from "./workspaceMutationTools";

export const VERIFICATION_TOOL_NAMES = new Set([
  "run_command",
  "browser_evaluate",
  "computer_use",
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
  | "mutation_required"
  | "validation_required"
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

export type UnreconciledFailureDomain =
  | "process"
  | "browser"
  | "command"
  | "mutation"
  | "other";

export interface UnreconciledFailureSignal {
  entry: PlanExecutionEvidenceEntry;
  domain: UnreconciledFailureDomain;
  /** Workspace source implicated by structured evidence, never model prose. */
  sourceTarget: string | null;
  /** Compact structured failure detail suitable for a runtime checkpoint. */
  detail: string;
}

export function scopeExecutionEvidenceLedger(
  ledger: PlanExecutionEvidenceEntry[],
  transactionId?: string | null,
): PlanExecutionEvidenceEntry[] {
  return transactionId
    ? ledger.filter((entry) => entry.transactionId === transactionId)
    : [...ledger];
}

function isSuccessfulStructuredEvidence(entry: PlanExecutionEvidenceEntry): boolean {
  return !["failed", "pending", "unknown", "running", "stopped"].includes(
    String(entry.observationStatus || ""),
  );
}

/**
 * Decide max-iteration continuation from trusted transaction evidence only.
 * Tool-call prose and successful cache/policy responses never participate.
 */
export function hasDurableExecutionProgress(input: {
  ledger: PlanExecutionEvidenceEntry[];
  transactionId?: string | null;
  recoveryActionContract: Pick<RecoveryActionContract, "ptyGeneration">;
}): boolean {
  const ledger = scopeExecutionEvidenceLedger(input.ledger, input.transactionId);
  if (ledger.some((entry) => isSuccessfulStructuredEvidence(entry) && (
    (entry.kind === "file" && isWorkspaceMutationToolName(entry.sourceTool)) ||
    (entry.kind === "cmd" && entry.sourceTool === "run_command" &&
      isFinitePlanValidationCommand(entry.value || entry.target || "")) ||
    entry.kind === "browser_dom" || entry.kind === "browser_screenshot"
  ))) return true;

  const generation = input.recoveryActionContract.ptyGeneration;
  if (typeof generation !== "number") return false;
  const devServerState = resolveDevServerRuntimeState(ledger);
  return devServerState.status === "ready" &&
    devServerState.foregroundGeneration === generation &&
    ledger.some((entry) =>
    entry.sourceTool === "execute_command" &&
    (entry.observationStatus === "pending" || entry.observationStatus === "running") &&
    entry.foregroundGeneration === generation
  ) && ledger.some((entry) =>
    PTY_OBSERVATION_TOOL_NAMES.has(entry.sourceTool) &&
    entry.observationStatus === "ready" &&
    entry.foregroundGeneration === generation
  );
}

function evidenceTime(entry: PlanExecutionEvidenceEntry): number {
  const value = Number(entry.createdAt || 0);
  return Number.isFinite(value) ? value : 0;
}

function isMutationEvidenceEntry(entry: PlanExecutionEvidenceEntry): boolean {
  return entry.kind === "file" || entry.kind === "deliverable";
}

function isSuccessfulValidationEvidenceEntry(entry: PlanExecutionEvidenceEntry): boolean {
  if (!isSuccessfulStructuredEvidence(entry)) return false;
  if (entry.kind === "browser_dom" || entry.kind === "browser_screenshot") return true;
  if (entry.automaticValidation === true) return true;
  return entry.kind === "cmd" &&
    entry.sourceTool === "run_command" &&
    isFinitePlanValidationCommand(entry.value || entry.target || "");
}

function isSuccessfulOperationalCommandEntry(
  entry: PlanExecutionEvidenceEntry,
): boolean {
  return entry.kind === "cmd" &&
    entry.sourceTool === "run_command" &&
    isSuccessfulStructuredEvidence(entry);
}

function operationalCommandEvidenceSatisfiesRequirements(
  entries: PlanExecutionEvidenceEntry[],
  requiredCommands: string[],
): boolean {
  if (requiredCommands.length === 0) {
    return entries.some((entry) =>
      isFinitePlanValidationCommand(entry.value || entry.target || "")
    );
  }
  return requiredCommands.every((required) =>
    entries.some((entry) =>
      commandEvidenceRequirementMatchesExecution(
        required,
        entry.value || entry.target || "",
      )
    )
  );
}

const COMMAND_CAPABILITY_REQUIREMENT_PREFIX = "capability:";

function commandEvidenceRequirementMatchesExecution(
  required: string,
  actual: string,
): boolean {
  if (required.startsWith(COMMAND_CAPABILITY_REQUIREMENT_PREFIX)) {
    const capability = required.slice(COMMAND_CAPABILITY_REQUIREMENT_PREFIX.length);
    if (capability === "operational") return String(actual || "").trim().length > 0;
    if (capability === "start") return requiresPtyObservationForPlanCommand(actual);
    return classifyFiniteValidationCommandCapability(actual) === capability;
  }
  return planCommandEvidenceMatchesExecution(required, actual);
}

function normalizeCommandRequirement(value: unknown): string {
  return String(value || "").replace(/\s+/g, " ").trim();
}

/**
 * Derive exact command ownership from structured Plan/directive metadata.
 * Natural-language targets describe intent; they are never executable
 * acceptance strings. Without an exact command, a small structured capability
 * (test/build/start/operational) owns the acceptable evidence class.
 */
export function resolveCommandEvidenceRequirements(input: {
  tasks?: PlanTask[];
  commandDirective?: CommandDirective | null;
}): string[] {
  const requirements = (input.tasks || []).flatMap((task) =>
    (task.evidence || [])
      .filter((evidence) => evidence.kind === "cmd")
      .map((evidence) => normalizeCommandRequirement(evidence.value))
      .filter(Boolean)
  );
  const directive = input.commandDirective;
  if (requirements.length === 0 && directive?.kind === "shell") {
    const exactCommand = normalizeCommandRequirement(directive.exactCommand);
    const legacyExactTarget = normalizeCommandRequirement(directive.target);
    if (exactCommand) requirements.push(exactCommand);
    else if (
      looksLikeExplicitShellCommandInput(legacyExactTarget)
    ) requirements.push(legacyExactTarget);
    else if (["test", "build", "lint", "typecheck", "check", "start"].includes(
      normalizeCommandRequirement(directive.action),
    )) {
      requirements.push(
        `${COMMAND_CAPABILITY_REQUIREMENT_PREFIX}${normalizeCommandRequirement(directive.action)}`,
      );
    }
    else if (["run", "deploy"].includes(normalizeCommandRequirement(directive.action))) {
      requirements.push(`${COMMAND_CAPABILITY_REQUIREMENT_PREFIX}operational`);
    }
  }
  if (requirements.length === 0 && directive?.kind === "git") {
    const target = normalizeCommandRequirement(directive.target);
    if (/^git\s+/i.test(target)) {
      requirements.push(target);
    } else {
      const actionParts = normalizeCommandRequirement(directive.action)
        .split(/[_\s-]+/g)
        .filter((part) => part && !/^(?:and|then)$/i.test(part));
      for (const part of actionParts) requirements.push(`git ${part}`);
    }
  }
  return Array.from(new Set(requirements));
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
  behaviorTargetGroups: string[][];
} {
  if (entry.interactionMutation === false) {
    return { required: false, behaviorTargets: [], behaviorTargetGroups: [] };
  }
  const structuralTargets = (entry.interactionBehaviorTargets || [])
    .map((target) => String(target || "").trim())
    .filter(Boolean);
  if (entry.interactionMutation === true) {
    return {
      required: true,
      behaviorTargets: Array.from(new Set(structuralTargets)).slice(0, 80),
      behaviorTargetGroups: groupStructuralInteractionTargets(structuralTargets),
    };
  }
  const identifiers = entry.changedIdentifiers || [];
  if (!identifiers.some((identifier) => INTERACTION_BINDING_IDENTIFIER_RE.test(identifier))) {
    return { required: false, behaviorTargets: [], behaviorTargetGroups: [] };
  }
  const behaviorTargets = Array.from(new Set(identifiers.filter((identifier) =>
    !INTERACTION_BINDING_IDENTIFIER_RE.test(identifier) && identifierParts(identifier).length > 0
  ))).slice(0, 80);
  return {
    required: true,
    behaviorTargets,
    // Legacy identifier-only evidence cannot prove which names are aliases
    // for one control. Preserve its former single obligation conservatively.
    behaviorTargetGroups: [behaviorTargets],
  };
}

function canonicalStructuralInteractionTarget(value: string): string {
  return String(value || "")
    .trim()
    .toLocaleLowerCase()
    .replace(/^[#.](?=[a-z0-9_-]+$)/, "")
    .replace(/[^a-z0-9_-]+/g, "");
}

function groupStructuralInteractionTargets(targets: string[]): string[][] {
  const groups = new Map<string, string[]>();
  for (const target of targets) {
    const clean = String(target || "").trim();
    if (!clean) continue;
    const key = canonicalStructuralInteractionTarget(clean) || clean.toLocaleLowerCase();
    const group = groups.get(key) || [];
    if (!group.includes(clean)) group.push(clean);
    groups.set(key, group);
  }
  return groups.size > 0 ? [...groups.values()] : [[]];
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
    const laterBrowserEntries = indexedBrowserEntries.filter(({ index }) => index > mutationIndex);
    interactionRequirement.behaviorTargetGroups.forEach((behaviorTargets, groupIndex) => {
      const latestRelevantBrowser = [...laterBrowserEntries].reverse().find(({ entry }) => {
        const interaction = entry.browserInteraction;
        if (entry.observationStatus === "failed" && (!interaction || interaction.actions.length === 0)) {
          return true;
        }
        return Boolean(interaction?.actions.some((action) =>
          actionMatchesBehaviorTargets(action.target, behaviorTargets)
        ));
      })?.entry;
      // Browser evidence is temporal per independent behavior target. A click
      // on one changed control cannot certify every other control in the same
      // source patch.
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
        id: `browser-interaction:${mutation.id}:${groupIndex + 1}`,
        kind: "browser_interaction",
        mutationEvidenceId: mutation.id,
        target: mutation.target || mutation.value,
        behaviorTargets,
        status: latestFailed ? "failed" : satisfyingEntry ? "satisfied" : "open",
        ...(satisfyingEntry ? { satisfiedByEvidenceId: satisfyingEntry.id } : {}),
      });
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
    const isMutationOperation = isWorkspaceMutationToolName(entry.sourceTool) ||
      entry.kind === "file" || entry.kind === "deliverable";
    const isBrowserOperation = entry.kind === "browser_dom" ||
      entry.kind === "browser_screenshot" ||
      /(?:browser|playwright|puppeteer|cypress)/i.test(entry.sourceTool);
    const finiteValidationCapability = entry.sourceTool === "run_command"
      ? classifyFiniteValidationCommandCapability(entry.value || entry.target || "")
      : null;
    // Exploratory read/search/list failures remain diagnostic evidence, but
    // they do not own a task acceptance obligation and cannot hold completion
    // open after a real mutation and validation succeed.
    if (
      !isDevServerReconciliation &&
      !isMutationOperation &&
      !isBrowserOperation &&
      !finiteValidationCapability
    ) continue;
    const key = isDevServerReconciliation
      ? "dev_server_runtime"
      : finiteValidationCapability
      ? `finite_validation:${finiteValidationCapability}`
      : isMutationOperation
      ? `mutation:${normalizedTarget}`
      : isBrowserOperation
      ? `browser:${normalizedTarget}`
      : `${entry.sourceTool}:${normalizedTarget}`;
    latestByOperation.set(key, entry);
  }
  return [...latestByOperation.values()].filter((entry) =>
    entry.observationStatus === "failed" || entry.portConflict === true
  );
}

function isWorkspaceReference(value: unknown): value is string {
  const candidate = String(value || "").trim();
  return Boolean(candidate) &&
    !/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate) &&
    !/^(?:pty|terminal)(?:-|$)/i.test(candidate);
}

function sourceTargetFromBrowserErrors(entry: PlanExecutionEvidenceEntry): string | null {
  const errors = [
    ...(entry.browserInteraction?.pageErrors || []),
    ...(entry.browserInteraction?.consoleErrors || []),
  ].join("\n");
  for (const match of errors.matchAll(/https?:\/\/[^\s)'"`]+/gi)) {
    try {
      const pathname = decodeURIComponent(new URL(match[0]).pathname)
        .replace(/^\/+/, "")
        .replace(/:\d+(?::\d+)?$/, "");
      if (/\.[A-Za-z0-9]{1,10}$/.test(pathname)) return pathname;
    } catch {
      // Continue to the relative stack-frame form below.
    }
  }
  const relative = errors.match(
    /(?:^|[\s(])((?:\.{1,2}\/|[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+\.[A-Za-z0-9]{1,10})(?::\d+(?::\d+)?)?/m,
  )?.[1];
  return relative?.replace(/^\.\//, "") || null;
}

/**
 * Return the latest still-live failure and its owning domain. Recovery uses
 * this structured attribution instead of treating every failure observed
 * while a dev server exists as a server failure.
 */
export function resolveLatestUnreconciledFailureSignal(input: {
  ledger: PlanExecutionEvidenceEntry[];
  transactionId?: string | null;
}): UnreconciledFailureSignal | null {
  const ledger = scopeExecutionEvidenceLedger(input.ledger, input.transactionId);
  const unresolved = latestUnresolvedFailures(ledger);
  const unresolvedIds = new Set(unresolved.map((entry) => entry.id));
  const entry = [...ledger].reverse().find((candidate) => unresolvedIds.has(candidate.id));
  if (!entry) return null;

  const sourceTool = String(entry.sourceTool || "");
  const domain: UnreconciledFailureDomain =
    sourceTool === "execute_command" ||
      PTY_OBSERVATION_TOOL_NAMES.has(sourceTool) ||
      entry.portConflict === true
      ? "process"
      : entry.kind === "browser_dom" ||
        entry.kind === "browser_screenshot" ||
        /(?:browser|playwright|puppeteer|cypress)/i.test(sourceTool)
      ? "browser"
      : sourceTool === "run_command"
      ? "command"
      : isWorkspaceMutationToolName(sourceTool) ||
        entry.kind === "file" ||
        entry.kind === "deliverable"
      ? "mutation"
      : "other";
  // Browser references commonly start with the captured screenshot receipt.
  // A receipt proves what was observed but is never the source to repair;
  // runtime stack frames are the authoritative browser-to-source link.
  const sourceTarget = (domain === "browser"
    ? sourceTargetFromBrowserErrors(entry)
    : (entry.references || []).find(isWorkspaceReference)) ||
    ((domain === "mutation" && isWorkspaceReference(entry.target || entry.value))
      ? String(entry.target || entry.value).trim()
      : null);
  const interaction = entry.browserInteraction;
  const detail = String(
    interaction?.pageErrors[0] ||
    interaction?.consoleErrors[0] ||
    entry.target ||
    entry.value ||
    sourceTool,
  ).replace(/\s+/g, " ").trim().slice(0, 600);
  return { entry, domain, sourceTarget, detail };
}

/**
 * Runtime-owned completion audit. A source mutation opens a new verification
 * epoch: only evidence created after that mutation can close it. A long-lived
 * launch additionally requires fresh PTY readiness. Browser validation is a
 * separate obligation and is required only when structured interaction
 * evidence opened one; merely starting the process or rereading source cannot
 * complete the turn.
 */
export function buildExecuteEvidenceClosureAudit(input: {
  ledger: PlanExecutionEvidenceEntry[];
  validationExpected: boolean;
  mutationExpected?: boolean;
  transactionId?: string | null;
  requiredCommandEvidence?: string[];
}): ExecuteEvidenceClosureAudit {
  // The ledger is append-only and therefore supplies a stronger causal order
  // than millisecond timestamps. Multiple tool results can legitimately share
  // one Date.now() tick; sorting/filtering only by time could let a validation
  // that occurred before the mutation close the new verification epoch.
  const ordered = scopeExecutionEvidenceLedger(input.ledger, input.transactionId);
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
  const hasBrowserInteractionObligation = validationObligations.some((obligation) =>
    obligation.kind === "browser_interaction"
  );
  const hasUnsatisfiedBrowserInteraction = unsatisfiedObligations.some((obligation) =>
    obligation.kind === "browser_interaction"
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
  const devServerState = hasDevServerLifecycle
    ? resolveDevServerRuntimeState(epoch)
    : null;
  if (input.mutationExpected === true && latestMutationAt === null) {
    const validations = ordered.filter(isSuccessfulValidationEvidenceEntry);
    const gap: ExecuteEvidenceGap = unresolvedFailures.length > 0 ||
      devServerState?.status === "failed" ||
      devServerState?.portConflict === true
      ? "unreconciled_failure"
      : "mutation_required";
    return {
      mutationCount: 0,
      validationCount: validations.length,
      latestMutationAt: null,
      latestValidationAt: validations.length > 0
        ? evidenceTime(validations[validations.length - 1])
        : null,
      latestReadyAt: null,
      longRunningStatus: devServerState?.status ?? "none",
      unresolvedFailureCount: unresolvedFailures.length,
      validationObligations,
      unsatisfiedObligationCount: unsatisfiedObligations.length,
      validationAfterLatestMutation: false,
      completionAllowed: false,
      gap,
    };
  }
  // A real long-running launch creates its own causal validation obligation.
  // A command-only task also requires successful command evidence even though
  // it intentionally has no file mutation. "No mutation" must never collapse
  // into "no execution required".
  if (
    !input.validationExpected &&
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

  const requiredCommandEvidence = input.requiredCommandEvidence || [];
  const successfulOperationalCommands = epoch.filter(isSuccessfulOperationalCommandEntry);
  const commandRequirementsSatisfied = operationalCommandEvidenceSatisfiesRequirements(
    successfulOperationalCommands,
    requiredCommandEvidence,
  );
  const successfulValidations = epoch.filter((entry) => {
    const commandOnlyExecution =
      latestMutationAt === null &&
      input.validationExpected &&
      entry.kind === "cmd" &&
      entry.sourceTool === "run_command";
    if (commandOnlyExecution) {
      if (!commandRequirementsSatisfied || !isSuccessfulOperationalCommandEntry(entry)) {
        return false;
      }
      if (requiredCommandEvidence.length === 0) {
        return isFinitePlanValidationCommand(entry.value || entry.target || "");
      }
      const actual = entry.value || entry.target || "";
      return requiredCommandEvidence.some((required) =>
        commandEvidenceRequirementMatchesExecution(required, actual)
      );
    }
    return isSuccessfulValidationEvidenceEntry(entry);
  });
  const latestValidationAt = successfulValidations.length > 0
    ? evidenceTime(successfulValidations[successfulValidations.length - 1])
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
        isLocalDevServerHealthProbeCommand(entry.value || entry.target || "") &&
        !!devServerState.url &&
        localDevServerUrlsShareOrigin(entry.value || entry.target || "", devServerState.url);
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
    !!devServerState?.url &&
    localDevServerUrlsShareOrigin(entry.target || entry.value || "", devServerState.url) &&
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
  } else if (
    hasUnsatisfiedBrowserInteraction ||
    (hasDevServerLifecycle && hasBrowserInteractionObligation && !browserAfterReady)
  ) {
    gap = "browser_validation_required";
  } else if (
    !hasDevServerLifecycle &&
    input.validationExpected &&
    latestValidationAt === null
  ) {
    gap = latestMutationAt === null
      ? "validation_required"
      : "validation_after_mutation_required";
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
  if (observation.name === "computer_use") {
    return resolveStructuredDesktopAutomationOutcome(content, {
      requireCausalInteraction: true,
    }) === "verified";
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
