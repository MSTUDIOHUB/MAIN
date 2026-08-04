import { looksLongRunningShellCommand } from "./toolExecutionContract";

/**
 * Provider-neutral validation primitives.  These records describe runtime
 * work; they are not a second evidence ledger and never own task completion.
 */
export type ValidationAcceptance = "required" | "advisory";

export type FiniteValidationCommandCapability =
  | "test"
  | "build"
  | "lint"
  | "typecheck"
  | "check"
  | "inline_assertion";

export type ValidationPrimitiveClass =
  | "finite_command"
  | "service_observation"
  | "interaction"
  | "assertion";

export type ValidationShellConnector = "start" | "and" | "or" | "sequence";

export interface ValidationCommandSegment {
  command: string;
  connector: ValidationShellConnector;
  role: "prelude" | "validator" | "service" | "unknown";
  capability?: FiniteValidationCommandCapability;
}

interface ValidationSpecBase {
  id?: string;
  acceptance: ValidationAcceptance;
  description?: string;
}

export interface FiniteCommandValidationSpec extends ValidationSpecBase {
  kind: "finite_command";
  acceptance: "required";
  command: string;
  cwd?: string;
  timeoutMs?: number;
  capability: FiniteValidationCommandCapability;
  segments: ValidationCommandSegment[];
}

export interface ServiceReadinessSpec {
  kind: "process_status" | "output_pattern" | "port" | "custom";
  expected: string | number | boolean;
  target?: string;
}

export interface ServiceObservationValidationSpec extends ValidationSpecBase {
  kind: "service_observation";
  /** A service observation can be a prerequisite, but never closes acceptance. */
  acceptance: "advisory";
  launchCommand: string;
  cwd?: string;
  ownerKey: string;
  readiness: ServiceReadinessSpec;
  segments: ValidationCommandSegment[];
}

export interface ValidationInteractionActionSpec {
  id?: string;
  kind: string;
  target: string;
}

export interface ValidationInteractionAssertionSpec {
  kind: string;
  target: string;
  afterActionId?: string;
  expected?: string | number | boolean | null;
}

interface InteractionValidationSpecBase extends ValidationSpecBase {
  actions: ValidationInteractionActionSpec[];
  assertions: ValidationInteractionAssertionSpec[];
  /** Actions must cause at least one post-action assertion when true. */
  requireCausalAssertion?: boolean;
}

export interface BrowserInteractionValidationSpec extends InteractionValidationSpecBase {
  kind: "browser_interaction";
}

export interface DesktopInteractionValidationSpec extends InteractionValidationSpecBase {
  kind: "desktop_interaction";
}

export type AssertionMatcher =
  | "equals"
  | "not_equals"
  | "contains"
  | "matches"
  | "exists"
  | "not_exists"
  | "runtime_result";

/** Declared observation source for a non-blocking standalone assertion. */
export type AssertionResultProducer =
  | "runtime_evidence_ledger"
  | "workspace_file_state"
  | "artifact_store";

export interface AssertionValidationSpec extends ValidationSpecBase {
  kind: "assertion";
  /** Standalone assertions have no trusted runtime producer and cannot close acceptance. */
  acceptance: "advisory";
  target: string;
  matcher: AssertionMatcher;
  producer?: AssertionResultProducer;
  expected?: string | number | boolean | null;
}

export interface AdvisoryValidationSpec extends ValidationSpecBase {
  kind: "advisory";
  acceptance: "advisory";
  note: string;
  owner?: "user" | "external" | "runtime";
}

export type ValidationPrimitiveSpec =
  | FiniteCommandValidationSpec
  | ServiceObservationValidationSpec
  | BrowserInteractionValidationSpec
  | DesktopInteractionValidationSpec
  | AssertionValidationSpec
  | AdvisoryValidationSpec;

export interface ValidationInteractionActionResult {
  id?: string;
  kind: string;
  target: string;
  succeeded: boolean;
}

export interface ValidationInteractionAssertionResult {
  kind: string;
  target: string;
  passed: boolean;
  afterActionId?: string;
  beforePassed?: boolean;
  changedAfterAction?: boolean;
  causallyLinked?: boolean;
  actual?: unknown;
}

export type ValidationEvidence =
  | {
      kind: "finite_command_result";
      evidenceId?: string;
      command: string;
      cwd?: string;
      completed: boolean;
      exitCode?: number | null;
      timedOut?: boolean;
    }
  | {
      kind: "service_observation_result";
      evidenceId?: string;
      ownerKey: string;
      status: "pending" | "unknown" | "running" | "ready" | "failed" | "stopped";
    }
  | {
      kind: "browser_interaction_result" | "desktop_interaction_result";
      evidenceId?: string;
      actions: ValidationInteractionActionResult[];
      assertions: ValidationInteractionAssertionResult[];
      pageErrors?: string[];
      consoleErrors?: string[];
    }
  | {
      kind: "assertion_result";
      evidenceId?: string;
      target: string;
      producer?: AssertionResultProducer;
      passed: boolean;
      actual?: unknown;
    };

export type ValidationEvaluationStatus =
  | "pending"
  | "satisfied"
  | "failed"
  | "observed"
  | "advisory"
  | "invalid";

export interface ValidationEvaluation {
  status: ValidationEvaluationStatus;
  acceptanceSatisfied: boolean;
  canSatisfyAcceptance: boolean;
  reason: string;
  evidenceIds: string[];
}

export type ValidationCommandRejectionReason =
  | "empty_command"
  | "unsafe_shell_syntax"
  | "background_process"
  | "pipeline_exit_status_ambiguous"
  | "non_fail_fast_connector"
  | "mixed_service_and_acceptance"
  | "unbounded_command_segment"
  | "inline_assertion_missing_failure_semantics"
  | "no_validation_segment";

export interface ValidationCommandAnalysis {
  command: string;
  segments: ValidationCommandSegment[];
  spec: FiniteCommandValidationSpec | ServiceObservationValidationSpec | null;
  rejectionReason: ValidationCommandRejectionReason | null;
}

interface SplitShellSegment {
  command: string;
  connector: ValidationShellConnector;
}

interface SplitShellResult {
  segments: SplitShellSegment[];
  rejectionReason: ValidationCommandRejectionReason | null;
}

function splitShellSegments(value: string): SplitShellResult {
  const segments: SplitShellSegment[] = [];
  let current = "";
  let quote = "";
  let escaped = false;
  let nextConnector: ValidationShellConnector = "start";

  const push = (connector: ValidationShellConnector) => {
    const command = current.trim();
    current = "";
    if (command) segments.push({ command, connector: nextConnector });
    nextConnector = connector;
  };

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index] || "";
    const next = value[index + 1] || "";
    const previous = value[index - 1] || "";
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (quote) {
      current += char;
      if (char === "\\" && quote !== "'") escaped = true;
      else if (char === quote) quote = "";
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      current += char;
      continue;
    }
    if (char === "\\") {
      current += char;
      escaped = true;
      continue;
    }
    // Subshells and process substitution can hide an unbounded child process.
    if (char === "`" || (char === "$" && next === "(") || (/[<>]/.test(char) && next === "(")) {
      return { segments, rejectionReason: "unsafe_shell_syntax" };
    }
    if (char === "&") {
      // File-descriptor redirection (`2>&1`, `>&2`, `&>file`) is not a
      // background-process operator. Preserve it in the command so a later
      // pipeline, if present, is rejected for its real exit-status ambiguity.
      if (previous === ">" || previous === "<" || next === ">") {
        current += char;
        continue;
      }
      if (next !== "&") {
        return { segments, rejectionReason: "background_process" };
      }
      push("and");
      index += 1;
      continue;
    }
    if (char === "|") {
      if (next !== "|") {
        return { segments, rejectionReason: "pipeline_exit_status_ambiguous" };
      }
      push("or");
      index += 1;
      continue;
    }
    if (char === ";" || char === "\n") {
      push("sequence");
      continue;
    }
    current += char;
  }

  if (quote || escaped) {
    return { segments, rejectionReason: "unsafe_shell_syntax" };
  }
  push("start");
  return { segments, rejectionReason: null };
}

function stripShellDecorators(value: string): string {
  let command = String(value || "")
    .replace(/^\(+\s*|\s*\)+$/g, "")
    .trim();
  command = command.replace(/^(?:command\s+|env\s+)+/i, "").trim();
  command = command.replace(/^(?:(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|[^\s]+)\s+)+/i, "").trim();
  return command;
}

function isShellPrelude(value: string): boolean {
  const command = String(value || "").replace(/^\(+\s*|\s*\)+$/g, "").trim();
  return /^(?:cd|pushd|popd)\b[^;&|]*$/i.test(command) ||
    /^(?:set\s+-[A-Za-z]+|export\s+)?(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|[^\s]+)\s*)+$/i.test(command);
}

const INLINE_INVOCATION_RE =
  /\b(?:node|bun|deno)\b[^\n]{0,400}\s(?:-e|--eval)(?:\s|=)|\bpython3?\b[^\n]{0,300}\s-c(?:\s|$)|\b(?:ruby\b[^\n]{0,300}\s-e|php\b[^\n]{0,300}\s-r)(?:\s|$)|\bnpx\s+(?:tsx|ts-node)\b[^\n]{0,400}\s(?:-e|--eval)(?:\s|=)/i;

const UNBOUNDED_INLINE_RE =
  /\bsetInterval\s*\(|\bsetTimeout\s*\(|\.listen\s*\(|\bcreateServer\s*\(|\bserve_forever\s*\(|\bwhile\s*\(\s*(?:true|1)\s*\)|\bfor\s*\(\s*;\s*;\s*\)|\bwhile\s+(?:True|1)\s*:|\bloop\s*\{|\bThread\.sleep\s*\(\s*(?:Float::INFINITY|INFINITY)/i;

function inlineHasDecidableFailureSemantics(command: string): boolean {
  if (!INLINE_INVOCATION_RE.test(command) || UNBOUNDED_INLINE_RE.test(command)) return false;

  // Language runtimes disagree on assertion syntax, but each accepted form
  // either invokes a real assertion or conditionally produces a non-zero/fail
  // outcome. Logging or merely printing an expected value is never enough.
  if (/(?:^|[^\w.])assert(?:\s+|\s*\(|\.)/i.test(command)) return true;
  if (/(?:^|[^\w.])expect\s*(?:\(|\.)/i.test(command)) return true;
  if (/\bif\b[\s\S]{1,280}\b(?:throw|raise|abort)\b/i.test(command)) return true;
  if (/\bif\b[\s\S]{1,280}\b(?:process|Deno)\.exit\s*\(\s*[1-9]\d*\s*\)/i.test(command)) return true;
  if (/\bif\b[\s\S]{1,280}\bsys\.exit\s*\(\s*[1-9]\d*\s*\)/i.test(command)) return true;
  if (/\bif\b[\s\S]{1,280}\bexit\s*(?:\(\s*)?[1-9]\d*/i.test(command)) return true;
  return false;
}

function looksLikeServiceSegment(raw: string): boolean {
  const command = stripShellDecorators(raw);
  return looksLongRunningShellCommand(command) ||
    UNBOUNDED_INLINE_RE.test(command) ||
    /(?:^|\s)(?:--watch(?:all)?|--ui|-w)(?:[=\s]|$)/i.test(command) ||
    /\b(?:vitest|jest|mocha|ava)\s+(?:watch|--watch)|\bcypress\s+open\b|\bcargo\s+watch\b/i.test(command) ||
    /\bnode\s+(?:[^\s]+\/)*(?:server|serve|dev-server)\.(?:[cm]?js|ts)\b/i.test(command) ||
    /\b(?:python3?\s+-m\s+http\.server|uvicorn\b|gunicorn\b|flask\s+run\b|manage\.py\s+runserver\b)/i.test(command) ||
    /\b(?:deno\s+(?:run\s+)?[^\n]*\bserve\b|cargo\s+run\b|electron\s+\.)/i.test(command);
}

function classifyFiniteSegment(
  raw: string,
): { capability: FiniteValidationCommandCapability | null; inlineMissingAssertion: boolean } {
  const command = stripShellDecorators(raw);
  if (!command || looksLikeServiceSegment(command)) {
    return { capability: null, inlineMissingAssertion: false };
  }

  const packageScript = command.match(
    /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?((?:test|build|lint|typecheck|type-check|check)(?::[A-Za-z0-9_.-]+)?)\b/i,
  )?.[1]?.toLowerCase() || "";
  if (packageScript.startsWith("test")) return { capability: "test", inlineMissingAssertion: false };
  if (packageScript.startsWith("build")) return { capability: "build", inlineMissingAssertion: false };
  if (packageScript.startsWith("lint")) return { capability: "lint", inlineMissingAssertion: false };
  if (packageScript.startsWith("typecheck") || packageScript.startsWith("type-check")) {
    return { capability: "typecheck", inlineMissingAssertion: false };
  }
  if (packageScript.startsWith("check")) return { capability: "check", inlineMissingAssertion: false };

  if (/\b(?:node\s+--test|npx\s+playwright\s+test|npx\s+cypress\s+run|npx\s+vitest(?:\s+run|[^\n;&|]*\s--run(?:\s|$))|npx\s+jest\b|pytest\b|python3?\s+-m\s+(?:pytest|unittest)\b|cargo\s+test\b|go\s+test\b|swift\s+test\b|dotnet\s+test\b|(?:\.\/)?mvnw?\s+(?:test|verify)\b|(?:\.\/)?gradlew?\s+(?:test|check)\b|xcodebuild\b[^\n;&|]*\btest\b|bundle\s+exec\s+rspec\b|rspec\b|phpunit\b|composer\s+(?:run-script\s+)?test\b|make\s+(?:test|check)\b|ctest\b)/i.test(command)) {
    return { capability: "test", inlineMissingAssertion: false };
  }
  if (/\b(?:cargo\s+build\b|go\s+build\b|swift\s+build\b|dotnet\s+build\b|(?:\.\/)?mvnw?\s+(?:package|compile)\b|(?:\.\/)?gradlew?\s+build\b|xcodebuild\b[^\n;&|]*\bbuild\b|cmake\s+--build\b|make\s+build\b|(?:(?:npx|bunx|pnpm\s+(?:dlx|exec)|yarn\s+dlx)\s+)?vite\s+build\b|(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?tauri\s+build\b|(?:cargo\s+)?tauri\s+build\b)/i.test(command)) {
    return { capability: "build", inlineMissingAssertion: false };
  }
  if (/\b(?:cargo\s+clippy\b|eslint\b|biome\s+(?:lint|check)\b|ruff\s+check\b|make\s+lint\b)/i.test(command)) {
    return { capability: "lint", inlineMissingAssertion: false };
  }
  if (/\b(?:npx\s+tsc\b|mypy\b|python3?\s+-m\s+mypy\b|dotnet\s+build\b)/i.test(command)) {
    return { capability: "typecheck", inlineMissingAssertion: false };
  }
  if (/\b(?:cargo\s+check\b|cargo\s+fmt\b[^\n;&|]*--check\b|go\s+vet\b|python3?\s+-m\s+compileall\b|make\s+check\b)/i.test(command)) {
    return { capability: "check", inlineMissingAssertion: false };
  }
  if (INLINE_INVOCATION_RE.test(command)) {
    return {
      capability: inlineHasDecidableFailureSemantics(command) ? "inline_assertion" : null,
      inlineMissingAssertion: !inlineHasDecidableFailureSemantics(command),
    };
  }
  return { capability: null, inlineMissingAssertion: false };
}

function normalizeCommandIdentity(value: string): string {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function serviceOwnerKey(command: string, cwd?: string): string {
  return `${String(cwd || ".").trim() || "."}::${normalizeCommandIdentity(command)}`;
}

export function analyzeValidationCommand(
  value: string,
  options: { cwd?: string; timeoutMs?: number; readiness?: ServiceReadinessSpec; ownerKey?: string } = {},
): ValidationCommandAnalysis {
  const command = normalizeCommandIdentity(value);
  if (!command) {
    return { command, segments: [], spec: null, rejectionReason: "empty_command" };
  }
  const split = splitShellSegments(command);
  if (split.rejectionReason) {
    return { command, segments: [], spec: null, rejectionReason: split.rejectionReason };
  }
  if (split.segments.some((segment) => segment.connector === "or" || segment.connector === "sequence")) {
    return { command, segments: [], spec: null, rejectionReason: "non_fail_fast_connector" };
  }

  let firstCapability: FiniteValidationCommandCapability | null = null;
  let serviceCount = 0;
  let validatorCount = 0;
  let unknownCount = 0;
  let inlineMissingAssertion = false;
  const segments: ValidationCommandSegment[] = split.segments.map((segment) => {
    if (isShellPrelude(segment.command)) {
      return { ...segment, role: "prelude" as const };
    }
    if (looksLikeServiceSegment(segment.command)) {
      serviceCount += 1;
      return { ...segment, role: "service" as const };
    }
    const classified = classifyFiniteSegment(segment.command);
    if (classified.capability) {
      validatorCount += 1;
      firstCapability ||= classified.capability;
      return {
        ...segment,
        role: "validator" as const,
        capability: classified.capability,
      };
    }
    inlineMissingAssertion ||= classified.inlineMissingAssertion;
    unknownCount += 1;
    return { ...segment, role: "unknown" as const };
  });

  if (serviceCount > 0 && validatorCount > 0) {
    return { command, segments, spec: null, rejectionReason: "mixed_service_and_acceptance" };
  }
  if (unknownCount > 0) {
    return {
      command,
      segments,
      spec: null,
      rejectionReason: inlineMissingAssertion
        ? "inline_assertion_missing_failure_semantics"
        : "unbounded_command_segment",
    };
  }
  if (serviceCount > 0) {
    return {
      command,
      segments,
      rejectionReason: null,
      spec: {
        kind: "service_observation",
        acceptance: "advisory",
        launchCommand: command,
        ...(options.cwd ? { cwd: options.cwd } : {}),
        ownerKey: options.ownerKey || serviceOwnerKey(command, options.cwd),
        readiness: options.readiness || { kind: "process_status", expected: "ready" },
        segments,
      },
    };
  }
  if (validatorCount > 0 && firstCapability) {
    return {
      command,
      segments,
      rejectionReason: null,
      spec: {
        kind: "finite_command",
        acceptance: "required",
        command,
        ...(options.cwd ? { cwd: options.cwd } : {}),
        ...(typeof options.timeoutMs === "number" ? { timeoutMs: options.timeoutMs } : {}),
        capability: firstCapability,
        segments,
      },
    };
  }
  return { command, segments, spec: null, rejectionReason: "no_validation_segment" };
}

export function createValidationCommandSpec(
  command: string,
  options: { cwd?: string; timeoutMs?: number; readiness?: ServiceReadinessSpec; ownerKey?: string } = {},
): FiniteCommandValidationSpec | ServiceObservationValidationSpec | null {
  return analyzeValidationCommand(command, options).spec;
}

/** True even for a rejected mixed command, so callers still route it to PTY rather than a one-shot executor. */
export function commandContainsServiceProcess(command: string): boolean {
  const split = splitShellSegments(String(command || ""));
  return split.segments.some((segment) => looksLikeServiceSegment(segment.command));
}

export function validationPrimitiveClass(spec: ValidationPrimitiveSpec): ValidationPrimitiveClass {
  if (spec.kind === "finite_command") return "finite_command";
  if (spec.kind === "service_observation") return "service_observation";
  if (spec.kind === "browser_interaction" || spec.kind === "desktop_interaction") return "interaction";
  return "assertion";
}

export const SUPPORTED_BROWSER_INTERACTION_ACTION_KINDS = [
  "click", "fill", "type", "press", "select", "check", "uncheck",
  "navigate", "hover", "scroll", "drag", "upload", "direct_action",
] as const;
export const SUPPORTED_DESKTOP_INTERACTION_ACTION_KINDS = [
  "click", "fill", "type", "press", "select", "check", "uncheck",
  "open", "hover", "scroll", "drag", "direct_action",
] as const;
export const SUPPORTED_INTERACTION_ASSERTION_KINDS = [
  "visibility", "text", "value", "count", "checked", "url", "dialog",
  "exists", "not_exists", "dom_state", "observable_state",
] as const;

const BROWSER_INTERACTION_ACTION_KIND_SET = new Set<string>(
  SUPPORTED_BROWSER_INTERACTION_ACTION_KINDS,
);
const DESKTOP_INTERACTION_ACTION_KIND_SET = new Set<string>(
  SUPPORTED_DESKTOP_INTERACTION_ACTION_KINDS,
);
const INTERACTION_ASSERTION_KIND_SET = new Set<string>(
  SUPPORTED_INTERACTION_ASSERTION_KINDS,
);

function isSupportedInteractionAction(
  surface: "browser_interaction" | "desktop_interaction",
  action: ValidationInteractionActionSpec,
): boolean {
  const kind = normalizedInteractionToken(action.kind);
  const supported = surface === "browser_interaction"
    ? BROWSER_INTERACTION_ACTION_KIND_SET
    : DESKTOP_INTERACTION_ACTION_KIND_SET;
  return supported.has(kind) && !!action.target.trim();
}

function isSupportedInteractionAssertion(
  assertion: ValidationInteractionAssertionSpec,
): boolean {
  return INTERACTION_ASSERTION_KIND_SET.has(normalizedInteractionToken(assertion.kind)) &&
    !!assertion.target.trim();
}

export function isWellFormedAdvisoryAssertionSpec(spec: AssertionValidationSpec): boolean {
  if (spec.acceptance !== "advisory") return false;
  if (!["equals", "not_equals", "contains", "matches", "exists", "not_exists", "runtime_result"].includes(spec.matcher)) {
    return false;
  }
  const matcherNeedsExpected = ["equals", "not_equals", "contains", "matches"].includes(spec.matcher);
  if (matcherNeedsExpected && spec.expected === undefined) return false;
  const target = spec.target.trim();
  if (spec.producer === "runtime_evidence_ledger") {
    return /^runtime:[A-Za-z0-9_.:/-]+$/.test(target);
  }
  if (spec.producer === "workspace_file_state") {
    return /^workspace:(?!\/|\.\.\/).+/.test(target) &&
      ["equals", "not_equals", "contains", "matches", "exists", "not_exists"].includes(spec.matcher);
  }
  if (spec.producer === "artifact_store") {
    return /^artifact:(?!\/|\.\.\/).+/.test(target) &&
      ["equals", "not_equals", "contains", "matches", "exists", "not_exists"].includes(spec.matcher);
  }
  return false;
}

export function isAcceptanceCapableValidationSpec(spec: ValidationPrimitiveSpec): boolean {
  // A standalone assertion has no trusted producer adapter. Assertions can
  // still close acceptance when they are nested inside browser/desktop
  // interactions, or encoded as a finite inline assertion command.
  if (spec.kind === "assertion") return false;
  if (spec.acceptance !== "required") return false;
  if (spec.kind === "finite_command") {
    return analyzeValidationCommand(spec.command, {
      cwd: spec.cwd,
      timeoutMs: spec.timeoutMs,
    }).spec?.kind === "finite_command";
  }
  if (spec.kind === "browser_interaction" || spec.kind === "desktop_interaction") {
    if (
      spec.assertions.length === 0 ||
      !spec.actions.every((action) => isSupportedInteractionAction(spec.kind, action)) ||
      !spec.assertions.every(isSupportedInteractionAssertion)
    ) return false;
    return true;
  }
  return false;
}

function normalizedInteractionToken(value: string): string {
  return String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
}

function actionMatches(
  expected: ValidationInteractionActionSpec,
  actual: ValidationInteractionActionResult,
): boolean {
  if (expected.id && expected.id !== actual.id) return false;
  return normalizedInteractionToken(expected.kind) === normalizedInteractionToken(actual.kind) &&
    normalizedInteractionToken(expected.target) === normalizedInteractionToken(actual.target);
}

function assertionMatches(
  expected: ValidationInteractionAssertionSpec,
  actual: ValidationInteractionAssertionResult,
): boolean {
  if (expected.afterActionId && expected.afterActionId !== actual.afterActionId) {
    return false;
  }
  if (
    normalizedInteractionToken(expected.kind) !== normalizedInteractionToken(actual.kind) ||
    normalizedInteractionToken(expected.target) !== normalizedInteractionToken(actual.target)
  ) return false;
  if (expected.expected === undefined) return true;
  return Object.is(expected.expected, actual.actual);
}

function evidenceIds(evidence: ValidationEvidence[]): string[] {
  return evidence.map((entry) => entry.evidenceId || "").filter(Boolean);
}

function evaluateFiniteCommand(
  spec: FiniteCommandValidationSpec,
  evidence: ValidationEvidence[],
): ValidationEvaluation {
  if (!isAcceptanceCapableValidationSpec(spec)) {
    return {
      status: "invalid",
      acceptanceSatisfied: false,
      canSatisfyAcceptance: false,
      reason: "finite_command_contract_invalid",
      evidenceIds: [],
    };
  }
  const matches = evidence.filter((entry): entry is Extract<ValidationEvidence, { kind: "finite_command_result" }> =>
    entry.kind === "finite_command_result" &&
    normalizeCommandIdentity(entry.command) === normalizeCommandIdentity(spec.command) &&
    (!spec.cwd || entry.cwd === spec.cwd)
  );
  const latest = matches[matches.length - 1];
  if (!latest || !latest.completed) {
    return {
      status: "pending",
      acceptanceSatisfied: false,
      canSatisfyAcceptance: true,
      reason: "finite_command_result_missing",
      evidenceIds: evidenceIds(matches),
    };
  }
  const satisfied = latest.timedOut !== true && latest.exitCode === 0;
  return {
    status: satisfied ? "satisfied" : "failed",
    acceptanceSatisfied: satisfied,
    canSatisfyAcceptance: true,
    reason: satisfied ? "finite_command_exit_zero" : "finite_command_failed",
    evidenceIds: evidenceIds(matches),
  };
}

function evaluateServiceObservation(
  spec: ServiceObservationValidationSpec,
  evidence: ValidationEvidence[],
): ValidationEvaluation {
  const matches = evidence.filter((entry): entry is Extract<ValidationEvidence, { kind: "service_observation_result" }> =>
    entry.kind === "service_observation_result" && entry.ownerKey === spec.ownerKey
  );
  const latest = matches[matches.length - 1];
  const failed = latest?.status === "failed" || latest?.status === "stopped";
  const observed = latest?.status === "ready" || latest?.status === "running";
  return {
    status: failed ? "failed" : observed ? "observed" : "pending",
    acceptanceSatisfied: false,
    canSatisfyAcceptance: false,
    reason: failed
      ? "service_observation_failed"
      : observed
      ? "service_observation_ready_but_not_acceptance"
      : "service_observation_pending",
    evidenceIds: evidenceIds(matches),
  };
}

function evaluateInteraction(
  spec: BrowserInteractionValidationSpec | DesktopInteractionValidationSpec,
  evidence: ValidationEvidence[],
): ValidationEvaluation {
  if (!isAcceptanceCapableValidationSpec(spec)) {
    return {
      status: spec.acceptance === "advisory" ? "advisory" : "invalid",
      acceptanceSatisfied: false,
      canSatisfyAcceptance: false,
      reason: spec.acceptance === "advisory"
        ? "interaction_is_advisory"
        : "interaction_contract_missing_action_or_assertion",
      evidenceIds: [],
    };
  }
  const resultKind = spec.kind === "browser_interaction"
    ? "browser_interaction_result"
    : "desktop_interaction_result";
  const matches = evidence.filter((entry): entry is Extract<ValidationEvidence, { kind: typeof resultKind }> =>
    entry.kind === resultKind
  );
  for (let index = matches.length - 1; index >= 0; index -= 1) {
    const result = matches[index];
    if (!result || (result.pageErrors?.length || 0) > 0 || (result.consoleErrors?.length || 0) > 0) continue;
    const actionsSatisfied = spec.actions.every((expected) =>
      result.actions.some((actual) => actual.succeeded && actionMatches(expected, actual))
    );
    if (!actionsSatisfied) continue;
    const matchedAssertions = spec.assertions.map((expected) =>
      result.assertions.find((actual) => actual.passed && assertionMatches(expected, actual))
    );
    if (matchedAssertions.some((actual) => !actual)) continue;
    const requiresCausality = spec.requireCausalAssertion ?? spec.actions.length > 0;
    if (
      requiresCausality &&
      !matchedAssertions.some((actual) =>
        actual?.causallyLinked === true ||
        (actual?.changedAfterAction === true && actual?.beforePassed === false)
      )
    ) continue;
    return {
      status: "satisfied",
      acceptanceSatisfied: true,
      canSatisfyAcceptance: true,
      reason: "interaction_actions_and_assertions_satisfied",
      evidenceIds: evidenceIds([result]),
    };
  }
  return {
    status: matches.length > 0 ? "failed" : "pending",
    acceptanceSatisfied: false,
    canSatisfyAcceptance: true,
    reason: matches.length > 0
      ? "interaction_result_does_not_satisfy_contract"
      : "interaction_result_missing",
    evidenceIds: evidenceIds(matches),
  };
}

function evaluateAssertion(
  spec: AssertionValidationSpec,
  _evidence: ValidationEvidence[],
): ValidationEvaluation {
  if (!isWellFormedAdvisoryAssertionSpec(spec)) {
    return {
      status: "invalid",
      acceptanceSatisfied: false,
      canSatisfyAcceptance: false,
      reason: "assertion_producer_contract_invalid",
      evidenceIds: [],
    };
  }
  return {
    status: "advisory",
    acceptanceSatisfied: false,
    canSatisfyAcceptance: false,
    reason: "assertion_is_advisory",
    evidenceIds: [],
  };
}

export function evaluateValidationSpec(
  spec: ValidationPrimitiveSpec,
  evidence: ValidationEvidence[] = [],
): ValidationEvaluation {
  if (spec.kind === "finite_command") return evaluateFiniteCommand(spec, evidence);
  if (spec.kind === "service_observation") return evaluateServiceObservation(spec, evidence);
  if (spec.kind === "browser_interaction" || spec.kind === "desktop_interaction") {
    return evaluateInteraction(spec, evidence);
  }
  if (spec.kind === "assertion") return evaluateAssertion(spec, evidence);
  return {
    status: "advisory",
    acceptanceSatisfied: false,
    canSatisfyAcceptance: false,
    reason: "advisory_does_not_satisfy_acceptance",
    evidenceIds: [],
  };
}
