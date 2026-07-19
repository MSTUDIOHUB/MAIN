import {
  buildRepeatLoopArgsKey,
  buildRepeatLoopSignature,
} from "./repetitionGuard";

export interface BrowserValidationSpecError {
  code: string;
  message: string;
  phase: string;
  actionId: string | null;
  actionIndex: number | null;
  actionKind: string | null;
  selector: string | null;
  expectedText: string | null;
  actionFingerprint: string | null;
  selectorFingerprint: string | null;
  fingerprint: string;
}

export interface BrowserInteractiveElement {
  tag: string;
  type: string;
  role: string;
  id: string;
  name: string;
  text: string;
  ariaLabel: string;
  placeholder: string;
  testId: string;
  selectorCandidates: string[];
  fingerprint: string;
}

export interface BrowserFailedAction {
  id: string | null;
  index: number | null;
  kind: string;
  value: string;
  selector: string | null;
  error: string | null;
  actionFingerprint: string | null;
  selectorFingerprint: string | null;
}

export interface BrowserValidationOutcome {
  ok: boolean | null;
  failureType: string | null;
  failureSummary: string;
  failureReasons: string[];
  blankPage: boolean;
  screenshotPath: string | null;
  pageErrors: string[];
  consoleErrors: string[];
  failedAssertionCount: number;
  durationMs: number | null;
  error: string | null;
  failureFingerprint: string | null;
  validationSpecError: BrowserValidationSpecError | null;
  failedAction: BrowserFailedAction | null;
  interactiveElements: BrowserInteractiveElement[];
}

function normalizeBoolean(value: unknown, fallback: boolean): boolean {
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  return fallback;
}

function normalizeBrowserUrl(value: unknown): string {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    return new URL(raw).toString();
  } catch {
    return raw;
  }
}

export function buildBrowserValidationCacheSignature(
  args: Record<string, unknown>,
): string {
  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args || {})) {
    if (
      value === undefined ||
      value === null ||
      key === "timeout_ms" ||
      key === "timeoutMs" ||
      key === "description"
    ) {
      continue;
    }
    normalized[key] = typeof value === "string" ? value.trim() : value;
  }

  normalized.url = normalizeBrowserUrl(normalized.url);
  normalized.wait_for_text = String(normalized.wait_for_text ?? normalized.waitForText ?? "").trim();
  normalized.wait_for_selector = String(normalized.wait_for_selector ?? normalized.waitForSelector ?? "").trim();
  normalized.screenshot = normalizeBoolean(normalized.screenshot, true);
  normalized.fail_on_console_error = normalizeBoolean(
    normalized.fail_on_console_error ?? normalized.failOnConsoleError,
    true,
  );
  delete normalized.waitForText;
  delete normalized.waitForSelector;
  delete normalized.failOnConsoleError;

  return buildRepeatLoopSignature(
    "browser_evaluate",
    buildRepeatLoopArgsKey(normalized),
  );
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => String(item || "").replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.replace(/\s+/g, " ").trim() : null;
}

function nullableInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function parseValidationSpecError(value: unknown): BrowserValidationSpecError | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const code = nullableString(record.code);
  const message = nullableString(record.message);
  const fingerprint = nullableString(record.fingerprint);
  if (!code || !message || !fingerprint) return null;
  return {
    code,
    message,
    phase: nullableString(record.phase) || "validation",
    actionId: nullableString(record.actionId ?? record.action_id),
    actionIndex: nullableInteger(record.actionIndex ?? record.action_index),
    actionKind: nullableString(record.actionKind ?? record.action_kind),
    selector: nullableString(record.selector),
    expectedText: nullableString(record.expectedText ?? record.expected_text),
    actionFingerprint: nullableString(record.actionFingerprint ?? record.action_fingerprint),
    selectorFingerprint: nullableString(record.selectorFingerprint ?? record.selector_fingerprint),
    fingerprint,
  };
}

function parseFailedAction(value: unknown): BrowserFailedAction | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const kind = nullableString(record.kind);
  if (!kind) return null;
  return {
    id: nullableString(record.id),
    index: nullableInteger(record.index),
    kind,
    value: nullableString(record.value) || "",
    selector: nullableString(record.selector),
    error: nullableString(record.error),
    actionFingerprint: nullableString(record.actionFingerprint ?? record.action_fingerprint),
    selectorFingerprint: nullableString(record.selectorFingerprint ?? record.selector_fingerprint),
  };
}

function parseInteractiveElements(value: unknown): BrowserInteractiveElement[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 32).flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const record = item as Record<string, unknown>;
    const tag = nullableString(record.tag);
    const fingerprint = nullableString(record.fingerprint);
    if (!tag || !fingerprint) return [];
    return [{
      tag,
      type: nullableString(record.type) || "",
      role: nullableString(record.role) || "",
      id: nullableString(record.id) || "",
      name: nullableString(record.name) || "",
      text: nullableString(record.text) || "",
      ariaLabel: nullableString(record.ariaLabel ?? record.aria_label) || "",
      placeholder: nullableString(record.placeholder) || "",
      testId: nullableString(record.testId ?? record.test_id) || "",
      selectorCandidates: stringArray(record.selectorCandidates ?? record.selector_candidates).slice(0, 4),
      fingerprint,
    }];
  });
}

export function parseBrowserValidationRecord(result: string): Record<string, unknown> | null {
  const raw = String(result || "").trim();
  if (!raw) return null;
  const candidates = [raw];
  const marker = "BROWSER_VALIDATION_FAILED:";
  const markerIndex = raw.lastIndexOf(marker);
  if (markerIndex >= 0) {
    const payloadStart = raw.indexOf("\n", markerIndex + marker.length);
    if (payloadStart >= 0) candidates.unshift(raw.slice(payloadStart + 1).trim());
  }
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Reused validation feedback may contain guidance before the structured
      // BROWSER_VALIDATION_FAILED payload. Try every bounded candidate.
    }
  }
  return null;
}

export function parseBrowserValidationOutcome(result: string): BrowserValidationOutcome | null {
  const record = parseBrowserValidationRecord(result);
  if (!record) return null;

  const assertions = Array.isArray(record.assertions) ? record.assertions : [];
  const pageErrors = stringArray(record.pageErrors ?? record.page_errors);
  const consoleErrors = stringArray(record.consoleErrors ?? record.console_errors);
  const blankPage = record.blankPage === true || record.blank_page === true;
  const failedAssertionCount = assertions.filter((item) =>
    item && typeof item === "object" && (item as Record<string, unknown>).passed === false
  ).length;
  const failureReasons = stringArray(record.failureReasons ?? record.failure_reasons);
  const validationSpecError = parseValidationSpecError(
    record.validationSpecError ?? record.validation_spec_error,
  );
  if (failureReasons.length === 0) {
    if (pageErrors.length > 0) failureReasons.push("page_error");
    if (consoleErrors.length > 0) failureReasons.push("console_error");
    if (failedAssertionCount > 0) failureReasons.push("assertion_failed");
    if (blankPage) failureReasons.push("blank_page");
    if (validationSpecError) failureReasons.push("validation_spec_error");
  }
  return {
    ok: typeof record.ok === "boolean"
      ? record.ok
      : typeof record.success === "boolean" ? record.success : null,
    failureType: nullableString(record.failureType ?? record.failure_type),
    failureSummary: String(record.failureSummary || record.failure_summary || "").replace(/\s+/g, " ").trim(),
    failureReasons,
    blankPage,
    screenshotPath: typeof record.screenshotPath === "string"
      ? record.screenshotPath
      : typeof record.screenshot_path === "string" ? record.screenshot_path : null,
    pageErrors,
    consoleErrors,
    failedAssertionCount,
    durationMs: typeof record.durationMs === "number"
      ? record.durationMs
      : typeof record.duration_ms === "number" ? record.duration_ms : null,
    error: typeof record.error === "string" && record.error.trim()
      ? record.error.replace(/\s+/g, " ").trim()
      : null,
    failureFingerprint: nullableString(record.failureFingerprint ?? record.failure_fingerprint),
    validationSpecError,
    failedAction: parseFailedAction(record.failedAction ?? record.failed_action),
    interactiveElements: parseInteractiveElements(record.interactiveElements ?? record.interactive_elements),
  };
}

const DETERMINISTIC_BROWSER_FAILURES = new Set([
  "http_status",
  "page_error",
  "console_error",
  "assertion_failed",
  "blank_page",
  "validation_spec_error",
]);

const TRANSIENT_BROWSER_ERROR_PATTERN = /(?:\bnet::ERR_|\bECONN(?:REFUSED|RESET|ABORTED)\b|browser (?:launch|startup)|browser has been closed|target page[^\n]*closed|playwright is not available|navigation[^\n]*timed out)/i;

export function isBrowserValidationResultCacheable(result: string): boolean {
  const outcome = parseBrowserValidationOutcome(result);
  if (!outcome) return false;
  if (outcome.ok === true) return true;
  if (outcome.validationSpecError) return true;
  if (outcome.error && TRANSIENT_BROWSER_ERROR_PATTERN.test(outcome.error)) return false;
  return outcome.failureReasons.some((reason) => DETERMINISTIC_BROWSER_FAILURES.has(reason));
}

/**
 * Persist only deterministic failed validations across loop/Goal boundaries.
 * The signature intentionally shares the live browser cache contract, so a
 * corrected URL, selector, action, or check remains a different invocation.
 */
export function resolvePersistentBrowserFailureCallSignature(
  args: Record<string, unknown>,
  result: string,
): string | null {
  const outcome = parseBrowserValidationOutcome(result);
  if (!outcome || outcome.ok === true || !isBrowserValidationResultCacheable(result)) {
    return null;
  }
  return buildBrowserValidationCacheSignature(args);
}

export function buildBrowserValidationFailureContent(result: string): string {
  const outcome = parseBrowserValidationOutcome(result);
  const summary = outcome?.failureSummary ||
    outcome?.pageErrors[0] ||
    outcome?.consoleErrors[0] ||
    outcome?.error ||
    (outcome?.blankPage ? "blank_page: no meaningful rendered content was detected" : "browser validation returned ok:false");
  return `BROWSER_VALIDATION_FAILED: ${summary}\n${result}`;
}
