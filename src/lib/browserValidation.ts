import {
  buildRepeatLoopArgsKey,
  buildRepeatLoopSignature,
} from "./repetitionGuard";

export interface BrowserValidationOutcome {
  ok: boolean | null;
  failureSummary: string;
  failureReasons: string[];
  blankPage: boolean;
  screenshotPath: string | null;
  pageErrors: string[];
  consoleErrors: string[];
  failedAssertionCount: number;
  durationMs: number | null;
  error: string | null;
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

export function parseBrowserValidationOutcome(result: string): BrowserValidationOutcome | null {
  const raw = String(result || "").trim();
  const jsonText = raw.startsWith("BROWSER_VALIDATION_FAILED:") && raw.includes("\n")
    ? raw.slice(raw.indexOf("\n") + 1).trim()
    : raw;
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;

  const record = parsed as Record<string, unknown>;
  const assertions = Array.isArray(record.assertions) ? record.assertions : [];
  const pageErrors = stringArray(record.pageErrors ?? record.page_errors);
  const consoleErrors = stringArray(record.consoleErrors ?? record.console_errors);
  const blankPage = record.blankPage === true || record.blank_page === true;
  const failedAssertionCount = assertions.filter((item) =>
    item && typeof item === "object" && (item as Record<string, unknown>).passed === false
  ).length;
  const failureReasons = stringArray(record.failureReasons ?? record.failure_reasons);
  if (failureReasons.length === 0) {
    if (pageErrors.length > 0) failureReasons.push("page_error");
    if (consoleErrors.length > 0) failureReasons.push("console_error");
    if (failedAssertionCount > 0) failureReasons.push("assertion_failed");
    if (blankPage) failureReasons.push("blank_page");
  }
  return {
    ok: typeof record.ok === "boolean"
      ? record.ok
      : typeof record.success === "boolean" ? record.success : null,
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
  };
}

const DETERMINISTIC_BROWSER_FAILURES = new Set([
  "http_status",
  "page_error",
  "console_error",
  "assertion_failed",
  "blank_page",
]);

export function isBrowserValidationResultCacheable(result: string): boolean {
  const outcome = parseBrowserValidationOutcome(result);
  if (!outcome) return false;
  if (outcome.ok === true) return true;
  return outcome.failureReasons.some((reason) => DETERMINISTIC_BROWSER_FAILURES.has(reason));
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
