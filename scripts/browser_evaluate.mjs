#!/usr/bin/env node
import { mkdir, readdir, unlink } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const MAX_PREVIEW_CHARS = 4000;
const MAX_CONSOLE_ITEMS = 80;
const MAX_FAILED_REQUESTS = 40;
const MAX_SAVED_SCREENSHOTS = 20;
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_FAILURE_SUMMARY_CHARS = 1200;
const MAX_INTERACTIVE_ELEMENT_INVENTORY = 32;
const MAX_INVENTORY_TEXT_CHARS = 120;

function stableHash(value) {
  let hash = 2166136261;
  const text = String(value || "");
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function normalizeFingerprintPart(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function buildStableFingerprint(kind, ...parts) {
  const canonical = [kind, ...parts].map(normalizeFingerprintPart).join("\u001f");
  return `${kind}-${stableHash(canonical)}`;
}

function createValidationSpecError(details) {
  const code = normalizeFingerprintPart(details.code || "invalid_validation_spec");
  const message = normalizeFingerprintPart(details.message || "The browser validation specification is invalid.");
  const phase = normalizeFingerprintPart(details.phase || "validation");
  const actionKind = normalizeFingerprintPart(details.actionKind);
  const selector = normalizeFingerprintPart(details.selector);
  const expectedText = normalizeFingerprintPart(details.expectedText);
  const actionFingerprint = details.actionFingerprint || (actionKind
    ? buildStableFingerprint("action", actionKind, selector || details.actionValue)
    : null);
  const selectorFingerprint = details.selectorFingerprint || (selector
    ? buildStableFingerprint("selector", selector)
    : null);
  const validationSpecError = {
    code,
    message,
    phase,
    actionId: details.actionId || null,
    actionIndex: Number.isInteger(details.actionIndex) ? details.actionIndex : null,
    actionKind: actionKind || null,
    selector: selector || null,
    expectedText: expectedText || null,
    actionFingerprint,
    selectorFingerprint,
    fingerprint: buildStableFingerprint(
      "validation-spec",
      code,
      phase,
      actionKind,
      selector,
      expectedText,
    ),
  };
  const error = new Error(message);
  error.name = "ValidationSpecError";
  error.validationSpecError = validationSpecError;
  return error;
}

function clampNumber(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.floor(parsed), min), max);
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

function normalizeActionName(value) {
  return String(value || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
}

function parseLines(value) {
  return String(value || "")
    .split(/\r?\n|;;/g)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
}

function parseDirective(line, fallbackKind) {
  const match = line.match(/^([a-zA-Z_][a-zA-Z0-9_-]*)\s*:\s*([\s\S]*)$/);
  if (!match) return { kind: fallbackKind, value: line.trim() };
  return { kind: normalizeActionName(match[1]), value: String(match[2] || "").trim() };
}

function splitSelectorValue(value) {
  const arrowIndex = value.indexOf("=>");
  if (arrowIndex === -1) return [value.trim(), ""];
  return [value.slice(0, arrowIndex).trim(), value.slice(arrowIndex + 2).trim()];
}

function normalizeUrlForBrowser(rawUrl, workspace) {
  const raw = String(rawUrl || "").trim();
  if (!raw) throw new Error("browser_evaluate requires url.");

  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw)) {
    return pathToFileURL(path.resolve(workspace, raw)).toString();
  }

  const parsed = new URL(raw);
  if (parsed.protocol === "file:") {
    const filePath = path.resolve(fileURLToPath(parsed));
    const root = path.resolve(workspace);
    if (filePath !== root && !filePath.startsWith(`${root}${path.sep}`)) {
      throw new Error("file:// browser validation is limited to files under the workspace.");
    }
    return parsed.toString();
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("browser_evaluate only supports http(s) localhost URLs or workspace file:// URLs.");
  }

  const hostname = parsed.hostname.toLowerCase();
  const localHosts = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0"]);
  if (!localHosts.has(hostname) && !hostname.endsWith(".localhost")) {
    throw new Error("browser_evaluate is local-only; use localhost, 127.0.0.1, [::1], or file:// workspace URLs.");
  }

  return parsed.toString();
}

function resolveWorkspaceFile(value, workspace) {
  const raw = String(value || "").trim();
  if (!raw) throw new Error("select_file requires a file path.");
  const resolved = path.resolve(workspace, raw);
  const root = path.resolve(workspace);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error("select_file paths must stay under the workspace.");
  }
  return resolved;
}

async function loadChromium() {
  const errors = [];
  for (const specifier of ["playwright", "@playwright/test"]) {
    try {
      const mod = await import(specifier);
      if (mod.chromium) return mod.chromium;
    } catch (error) {
      errors.push(`${specifier}: ${error?.message || String(error)}`);
    }
  }
  throw new Error(`Playwright is not available to browser_evaluate. ${errors.join(" | ")}`);
}

async function bodyText(page) {
  try {
    return await page.locator("body").innerText({ timeout: 1000 });
  } catch {
    return await page.textContent("body", { timeout: 1000 }) || "";
  }
}

async function inspectRenderedPage(page) {
  return await page.evaluate(({ maxItems, maxTextChars }) => {
    const body = document.body;
    if (!body) {
      return {
        bodyTextChars: 0,
        bodyElementCount: 0,
        visibleMeaningfulElementCount: 0,
        visibleInteractiveElementCount: 0,
        visibleMediaElementCount: 0,
        visibleBackgroundImageCount: 0,
        visiblePseudoContentCount: 0,
        interactiveElements: [],
        interactiveElementInventoryTruncated: false,
        blankPage: true,
      };
    }

    const stableHash = (value) => {
      let hash = 2166136261;
      const text = String(value || "");
      for (let index = 0; index < text.length; index += 1) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
      }
      return (hash >>> 0).toString(36);
    };
    const trimText = (value) => String(value || "").replace(/\s+/g, " ").trim().slice(0, maxTextChars);
    const escapeAttribute = (value) => String(value || "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const escapeCssIdentifier = (value) => {
      if (globalThis.CSS?.escape) return globalThis.CSS.escape(String(value || ""));
      return String(value || "").replace(/([^a-zA-Z0-9_-])/g, "\\$1");
    };

    const isVisible = (element) => {
      const style = window.getComputedStyle(element);
      if (
        style.display === "none" ||
        style.visibility === "hidden" ||
        Number.parseFloat(style.opacity || "1") <= 0
      ) {
        return false;
      }
      const rect = element.getBoundingClientRect();
      return rect.width >= 1 && rect.height >= 1 &&
        rect.bottom >= 0 && rect.right >= 0 &&
        rect.top <= window.innerHeight && rect.left <= window.innerWidth;
    };

    const allElements = Array.from(body.querySelectorAll("*"));
    const visibleElements = allElements.filter(isVisible);
    const interactiveSelector = [
      "a[href]",
      "button",
      "input",
      "textarea",
      "select",
      "summary",
      "[contenteditable='true']",
      "[role='button']",
      "[role='link']",
      "[role='textbox']",
      "[role='checkbox']",
      "[role='radio']",
      "[role='tab']",
    ].join(",");
    const mediaSelector = "img[src],picture,video,canvas,svg,iframe,object,embed";
    const semanticSelector = [
      interactiveSelector,
      mediaSelector,
      "table",
      "pre",
      "code",
      "[aria-label]",
      "[aria-labelledby]",
    ].join(",");
    const visibleInteractiveElementCount = visibleElements.filter((element) => element.matches(interactiveSelector)).length;
    const visibleMediaElementCount = visibleElements.filter((element) => element.matches(mediaSelector)).length;
    const visibleMeaningfulElementCount = visibleElements.filter((element) => element.matches(semanticSelector)).length;
    const visibleBackgroundImageCount = visibleElements.filter((element) => {
      const backgroundImage = window.getComputedStyle(element).backgroundImage;
      return backgroundImage && backgroundImage !== "none";
    }).length;
    const visiblePseudoContentCount = visibleElements.filter((element) => {
      const before = window.getComputedStyle(element, "::before").content;
      const after = window.getComputedStyle(element, "::after").content;
      return [before, after].some((content) => content && content !== "none" && content !== "normal" && content !== "\"\"");
    }).length;
    const visibleText = typeof body.innerText === "string" ? body.innerText : body.textContent || "";
    const normalizedText = String(visibleText).replace(/\s+/g, "").trim();
    const visibleInteractiveElements = visibleElements.filter((element) => element.matches(interactiveSelector));
    const interactiveElements = visibleInteractiveElements.slice(0, maxItems).map((element) => {
      const tag = element.tagName.toLowerCase();
      const type = "type" in element ? trimText(element.type) : "";
      const role = trimText(element.getAttribute("role"));
      const id = trimText(element.id);
      const name = trimText(element.getAttribute("name"));
      const ariaLabel = trimText(element.getAttribute("aria-label"));
      const placeholder = trimText(element.getAttribute("placeholder"));
      const testId = trimText(element.getAttribute("data-testid"));
      const text = trimText(element.textContent);
      const selectorCandidates = [];
      if (id) selectorCandidates.push(`#${escapeCssIdentifier(id)}`);
      if (testId) selectorCandidates.push(`[data-testid="${escapeAttribute(testId)}"]`);
      if (ariaLabel) selectorCandidates.push(`${tag}[aria-label="${escapeAttribute(ariaLabel)}"]`);
      if (name) selectorCandidates.push(`${tag}[name="${escapeAttribute(name)}"]`);
      if (selectorCandidates.length === 0 && type) selectorCandidates.push(`${tag}[type="${escapeAttribute(type)}"]`);
      if (selectorCandidates.length === 0) selectorCandidates.push(tag);
      return {
        tag,
        type,
        role,
        id,
        name,
        text,
        ariaLabel,
        placeholder,
        testId,
        selectorCandidates: selectorCandidates.slice(0, 4),
        fingerprint: `interactive-${stableHash([tag, type, role, id, name, ariaLabel, placeholder, testId, text].join("\u001f"))}`,
      };
    });
    const blankPage = normalizedText.length === 0 &&
      visibleMeaningfulElementCount === 0 &&
      visibleBackgroundImageCount === 0 &&
      visiblePseudoContentCount === 0;

    return {
      bodyTextChars: normalizedText.length,
      bodyElementCount: allElements.length,
      visibleMeaningfulElementCount,
      visibleInteractiveElementCount,
      visibleMediaElementCount,
      visibleBackgroundImageCount,
      visiblePseudoContentCount,
      interactiveElements,
      interactiveElementInventoryTruncated: visibleInteractiveElements.length > interactiveElements.length,
      blankPage,
    };
  }, {
    maxItems: MAX_INTERACTIVE_ELEMENT_INVENTORY,
    maxTextChars: MAX_INVENTORY_TEXT_CHARS,
  });
}

async function capturePageDiagnostics(page, result) {
  result.finalUrl = page.url();
  try {
    result.title = await page.title();
  } catch {
    // A navigation failure is reported by the main validation path below.
  }
  try {
    result.textPreview = (await bodyText(page)).slice(0, MAX_PREVIEW_CHARS);
  } catch {
    // Keep the navigation result even when body extraction itself fails.
  }
  try {
    const inspection = await inspectRenderedPage(page);
    const { interactiveElements, ...renderDiagnostics } = inspection;
    result.renderDiagnostics = renderDiagnostics;
    result.interactiveElements = interactiveElements;
    result.blankPage = result.renderDiagnostics.blankPage === true;
  } catch {
    // A page can disappear during failed navigation; retain the other diagnostics.
  }
}

async function captureScreenshot(page, result, workspace) {
  const screenshotDir = path.resolve(workspace, ".MAIN", "browser-validation");
  await mkdir(screenshotDir, { recursive: true });
  const screenshotPath = path.join(screenshotDir, `browser-${Date.now()}-${process.pid}.png`);
  await page.screenshot({ path: screenshotPath, fullPage: true });
  result.screenshotPath = path.relative(workspace, screenshotPath).replace(/\\/g, "/");
  try {
    const staleScreenshots = (await readdir(screenshotDir))
      .filter((name) => /^browser-\d+(?:-\d+)?\.png$/.test(name))
      .sort()
      .slice(0, -MAX_SAVED_SCREENSHOTS);
    await Promise.all(staleScreenshots.map((name) => unlink(path.join(screenshotDir, name))));
  } catch {
    // Retention cleanup is best-effort and must not hide the validation result.
  }
}

function finalizeValidationOutcome(result, failOnConsoleError) {
  const reasons = [];
  const summaries = [];
  const addFailure = (reason, summary) => {
    if (!reasons.includes(reason)) reasons.push(reason);
    const normalized = String(summary || "")
      .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (normalized) summaries.push(`${reason}: ${normalized}`);
  };

  if (result.validationSpecError) {
    addFailure(
      "validation_spec_error",
      `${result.validationSpecError.code}: ${result.validationSpecError.message}`,
    );
  } else if (result.error) {
    addFailure("runtime_error", result.error);
  }
  if (typeof result.status === "number" && (result.status < 200 || result.status >= 400)) {
    addFailure("http_status", `navigation returned HTTP ${result.status}`);
  }
  if (failOnConsoleError && result.pageErrors.length > 0) {
    addFailure("page_error", result.pageErrors[0]);
  }
  if (failOnConsoleError && result.consoleErrors.length > 0) {
    addFailure("console_error", result.consoleErrors[0]);
  }
  const failedAssertion = result.assertions.find((item) => item.passed === false);
  if (failedAssertion) {
    addFailure("assertion_failed", `${failedAssertion.kind}: ${failedAssertion.value} (${failedAssertion.detail || "failed"})`);
  }
  const failedAction = result.actions.find((item) => item.ok === false);
  if (failedAction) addFailure("action_failed", `${failedAction.kind}: ${failedAction.value}`);
  const pageWasReached = result.navigationCompleted === true;
  if (result.blankPage && pageWasReached) {
    const diagnostics = result.renderDiagnostics || {};
    addFailure(
      "blank_page",
      `no visible text or meaningful rendered content after load (bodyElements=${diagnostics.bodyElementCount ?? 0})`,
    );
  }
  if (result.screenshotError) addFailure("screenshot_failed", result.screenshotError);

  result.failureReasons = reasons;
  result.failureType = result.validationSpecError ? "validation_spec_error" : reasons[0] || null;
  result.failureSummary = summaries.join(" | ").slice(0, MAX_FAILURE_SUMMARY_CHARS);
  result.ok = reasons.length === 0;
  result.failedAction = failedAction
    ? {
        id: failedAction.id,
        index: failedAction.index,
        kind: failedAction.kind,
        value: failedAction.value,
        selector: failedAction.selector || null,
        error: failedAction.error || null,
        actionFingerprint: failedAction.actionFingerprint || null,
        selectorFingerprint: failedAction.selectorFingerprint || null,
      }
    : null;
  result.failureFingerprint = reasons.length === 0
    ? null
    : buildStableFingerprint(
        "browser-failure",
        result.url || result.finalUrl,
        result.validationSpecError?.fingerprint,
        reasons.join(","),
        failedAction?.actionFingerprint,
        failedAssertion ? `${failedAssertion.kind}:${failedAssertion.value}` : "",
        result.status,
        result.blankPage,
        result.pageErrors[0],
        result.consoleErrors[0],
      );
}

function describeWaitForTextFailure(error, expectedText, title) {
  const message = error?.message || String(error);
  const expected = String(expectedText || "").trim();
  const pageTitle = String(title || "").trim();
  if (
    expected &&
    pageTitle.includes(expected) &&
    /timeout/i.test(message)
  ) {
    return [
      message,
      `wait_for_text only searches document.body text; "${expected}" matches the current page title "${pageTitle}" instead. Use a title check (title: ${expected}) or wait_for_selector for a DOM element.`,
    ].join("\n");
  }
  return message;
}

function waitForTextSpecError(error, expectedText, title, details = {}) {
  const message = error?.message || String(error);
  const expected = String(expectedText || "").trim();
  const pageTitle = String(title || "").trim();
  if (!expected || !pageTitle.includes(expected) || !/timeout/i.test(message)) return null;
  return createValidationSpecError({
    code: "body_text_matches_title_only",
    message: describeWaitForTextFailure(error, expected, pageTitle),
    phase: details.phase || "wait_for_text",
    actionId: details.actionId,
    actionIndex: details.actionIndex,
    actionKind: details.actionKind || "wait_for_text",
    actionValue: expected,
    expectedText: expected,
    actionFingerprint: details.actionFingerprint,
  });
}

function pageReachedSuccessfully(result) {
  if (result.navigationCompleted !== true) return false;
  if (typeof result.status === "number") return result.status >= 200 && result.status < 400;
  return Boolean(result.finalUrl && result.finalUrl !== "about:blank");
}

async function selectorSpecError(page, result, error, details) {
  if (!details.selector || !pageReachedSuccessfully(result)) return null;
  let count;
  try {
    count = await page.locator(details.selector).count();
  } catch (selectorError) {
    return createValidationSpecError({
      ...details,
      code: "invalid_selector",
      message: `Invalid selector "${details.selector}": ${selectorError?.message || String(selectorError)}`,
    });
  }
  if (count !== 0) return null;
  return createValidationSpecError({
    ...details,
    code: "selector_not_found",
    message: `Selector "${details.selector}" matched no elements on the successfully loaded page. Inspect interactiveElements for available locator candidates. Original error: ${error?.message || String(error)}`,
  });
}

function pushBounded(list, item, max) {
  list.push(item);
  if (list.length > max) list.splice(0, list.length - max);
}

const STATEFUL_ACTION_KINDS = new Set([
  "click",
  "fill",
  "press",
  "select_file",
  "set_input_files",
  "upload",
]);

function selectorForAction(kind, value) {
  if (kind === "fill" || kind === "press" || kind === "select_file" || kind === "set_input_files" || kind === "upload") {
    return splitSelectorValue(value)[0];
  }
  return kind === "click" ? value : "";
}

async function captureInteractionState(page, selector) {
  return page.evaluate((targetSelector) => {
    const stableHash = (value) => {
      let hash = 2166136261;
      for (let index = 0; index < value.length; index += 1) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
      }
      return (hash >>> 0).toString(36);
    };
    let target = null;
    if (targetSelector) {
      try {
        target = document.querySelector(targetSelector);
      } catch {
        target = null;
      }
    }
    const targetState = target
      ? {
          tag: target.tagName.toLowerCase(),
          type: "type" in target ? String(target.type || "") : "",
          id: target.id || "",
          className: typeof target.className === "string" ? target.className : "",
          text: String(target.textContent || "").trim().slice(0, 400),
          value: "value" in target ? String(target.value ?? "").slice(0, 400) : "",
          checked: "checked" in target ? Boolean(target.checked) : false,
          disabled: "disabled" in target ? Boolean(target.disabled) : false,
          ariaPressed: target.getAttribute("aria-pressed") || "",
          ariaSelected: target.getAttribute("aria-selected") || "",
          dataState: target.getAttribute("data-state") || "",
        }
      : null;
    let externalDomFingerprint = "";
    if (document.body) {
      const clone = document.body.cloneNode(true);
      if (targetSelector) {
        try {
          const clonedTarget = clone.matches?.(targetSelector)
            ? clone
            : clone.querySelector(targetSelector);
          clonedTarget?.replaceWith(document.createComment("browser-action-target"));
        } catch {
          // Invalid selectors are reported by the action itself. Keep a whole-body fingerprint here.
        }
      }
      externalDomFingerprint = stableHash(String(clone.innerHTML || ""));
    }
    return {
      url: location.href,
      title: document.title,
      bodyText: String(document.body?.innerText || "").trim().slice(0, 1600),
      bodyClass: document.body?.className || "",
      htmlClass: document.documentElement?.className || "",
      externalDomFingerprint,
      target: targetState,
    };
  }, selector);
}

function changedInteractionStateFields(beforeState, afterState) {
  if (!beforeState || !afterState) return [];
  const changed = Object.keys({ ...beforeState, ...afterState })
    .filter((key) => key !== "target")
    .filter((key) => JSON.stringify(beforeState[key]) !== JSON.stringify(afterState[key]));
  const beforeTarget = beforeState.target || {};
  const afterTarget = afterState.target || {};
  for (const key of Object.keys({ ...beforeTarget, ...afterTarget })) {
    if (JSON.stringify(beforeTarget[key]) !== JSON.stringify(afterTarget[key])) {
      changed.push(`target.${key}`);
    }
  }
  return changed;
}

function nativeInteractionStateFields(action) {
  if (action.kind === "fill" || action.kind === "select_file" || action.kind === "set_input_files" || action.kind === "upload") {
    return new Set(["target.value", "target.checked"]);
  }
  if (action.kind === "press") {
    return new Set(["target.value", "target.checked"]);
  }
  const targetType = String(action.beforeState?.target?.type || action.afterState?.target?.type || "").toLowerCase();
  if (action.kind === "click" && (targetType === "checkbox" || targetType === "radio")) {
    return new Set(["target.checked"]);
  }
  return new Set();
}

function refreshActionState(action, afterState) {
  action.afterState = afterState;
  action.changedFields = changedInteractionStateFields(action.beforeState, action.afterState);
  const nativeFields = nativeInteractionStateFields(action);
  action.nativeChangedFields = action.changedFields.filter((field) => nativeFields.has(field));
  action.effectChangedFields = action.changedFields.filter((field) => !nativeFields.has(field));
  action.stateChanged = action.changedFields.length > 0;
  action.effectStateChanged = action.effectChangedFields.length > 0;
}

function parseCheckDirectives(input) {
  return parseLines(input.checks).map((line) => normalizeActionName(line) === "no_console_errors"
    ? { kind: "no_console_errors", value: "" }
    : parseDirective(line, "text"));
}

async function evaluateCheck(page, result, check) {
  const { kind, value } = check;
  const consoleText = result.consoleMessages.map((item) => item.text).join("\n");
  const consoleErrors = [...result.consoleErrors, ...result.pageErrors];
  if (kind === "text" || kind === "not_text") {
    const text = await bodyText(page);
    const includes = text.includes(value);
    return {
      passed: kind === "text" ? includes : !includes,
      detail: kind === "text"
        ? (includes ? "text found" : "text not found in body")
        : (!includes ? "text absent" : "unexpected text found in body"),
    };
  }
  if (kind === "selector" || kind === "not_selector") {
    const count = await page.locator(value).count();
    return {
      passed: kind === "selector" ? count > 0 : count === 0,
      detail: `matched ${count} element(s)`,
    };
  }
  if (kind === "title") {
    const title = await page.title();
    return { passed: title.includes(value), detail: `title: ${title}` };
  }
  if (kind === "console" || kind === "not_console") {
    const includes = consoleText.includes(value);
    return {
      passed: kind === "console" ? includes : !includes,
      detail: kind === "console"
        ? (includes ? "console text found" : "console text not found")
        : (!includes ? "console text absent" : "unexpected console text found"),
    };
  }
  if (kind === "no_console_errors") {
    return {
      passed: consoleErrors.length === 0,
      detail: consoleErrors.length === 0 ? "no console errors" : `${consoleErrors.length} console/page error(s)`,
    };
  }
  return { passed: false, detail: `unsupported assertion kind: ${kind}` };
}

async function createAssertionTrackers(page, input, result) {
  const trackers = [];
  for (const check of parseCheckDirectives(input)) {
    const baseline = await evaluateCheck(page, result, check);
    trackers.push({
      ...check,
      beforePassed: baseline.passed,
      currentPassed: baseline.passed,
      causalActionId: null,
      changedAfterAction: false,
    });
  }
  return trackers;
}

async function observeAssertionTransitions(page, result, trackers, action) {
  if (!action) return;
  for (const tracker of trackers) {
    const observed = await evaluateCheck(page, result, tracker);
    if (
      tracker.beforePassed === false &&
      tracker.currentPassed === false &&
      observed.passed === true &&
      !tracker.causalActionId
    ) {
      tracker.causalActionId = action.id;
      tracker.changedAfterAction = true;
    }
    tracker.currentPassed = observed.passed;
  }
}

function assertionEffectFieldsMatch(kind, changedFields) {
  const fields = new Set(changedFields || []);
  if (kind === "text" || kind === "not_text") {
    return fields.has("bodyText") || fields.has("externalDomFingerprint") || fields.has("target.text");
  }
  if (kind === "selector" || kind === "not_selector") {
    return fields.has("externalDomFingerprint") || [...fields].some((field) => field.startsWith("target."));
  }
  if (kind === "title") return fields.has("title");
  return false;
}

async function runActions(page, input, result, timeoutMs, workspace, assertionTrackers) {
  const actionLines = parseLines(input.actions);
  let latestStatefulAction = null;
  for (let index = 0; index < actionLines.length; index += 1) {
    const line = actionLines[index];
    const { kind, value } = parseDirective(line, "click");
    const selector = selectorForAction(kind, value);
    const actionFingerprint = buildStableFingerprint("action", kind, value);
    const selectorFingerprint = selector ? buildStableFingerprint("selector", selector) : null;
    const action = {
      id: `action-${index + 1}`,
      index: index + 1,
      kind,
      value,
      selector: selector || null,
      actionFingerprint,
      selectorFingerprint,
      ok: false,
      error: null,
      beforeState: STATEFUL_ACTION_KINDS.has(kind)
        ? await captureInteractionState(page, selector)
        : null,
      afterState: null,
      stateChanged: false,
      changedFields: [],
      nativeChangedFields: [],
      effectChangedFields: [],
      effectStateChanged: false,
    };
    result.actions.push(action);
    try {
      if (!value && kind !== "no_console_errors") {
        throw createValidationSpecError({
          code: "missing_action_value",
          message: `Action ${kind} requires a value.`,
          phase: "action",
          actionId: action.id,
          actionIndex: action.index,
          actionKind: kind,
          actionValue: value,
          actionFingerprint,
          selector,
          selectorFingerprint,
        });
      }

      if (kind === "click") {
        await page.locator(value).first().click({ timeout: timeoutMs });
      } else if (kind === "fill") {
        const [selector, text] = splitSelectorValue(value);
        if (!selector) throw new Error("fill requires selector => text.");
        await page.locator(selector).first().fill(text, { timeout: timeoutMs });
      } else if (kind === "press") {
        const [selector, key] = splitSelectorValue(value);
        if (!selector || !key) throw new Error("press requires selector => key.");
        await page.locator(selector).first().press(key, { timeout: timeoutMs });
      } else if (kind === "select_file" || kind === "set_input_files" || kind === "upload") {
        const [selector, filePath] = splitSelectorValue(value);
        if (!selector || !filePath) throw new Error("select_file requires selector => relative/path.");
        await page.locator(selector).first().setInputFiles(resolveWorkspaceFile(filePath, workspace), { timeout: timeoutMs });
      } else if (kind === "wait_for_selector" || kind === "wait_selector") {
        await page.locator(value).first().waitFor({ state: "visible", timeout: timeoutMs });
      } else if (kind === "wait_for_text" || kind === "wait_text") {
        try {
          await page.waitForFunction(
            (needle) => document.body?.innerText?.includes(needle),
            value,
            { timeout: timeoutMs },
          );
        } catch (error) {
          throw waitForTextSpecError(error, value, result.title, {
            phase: "action",
            actionId: action.id,
            actionIndex: action.index,
            actionKind: kind,
            actionFingerprint,
          }) || error;
        }
      } else if (kind === "wait") {
        await page.waitForTimeout(clampNumber(value, 500, 0, Math.min(timeoutMs, 10_000)));
      } else {
        throw createValidationSpecError({
          code: "unsupported_action",
          message: `Unsupported browser action: ${kind}`,
          phase: "action",
          actionId: action.id,
          actionIndex: action.index,
          actionKind: kind,
          actionValue: value,
          actionFingerprint,
          selector,
          selectorFingerprint,
        });
      }
    } catch (error) {
      const validationSpecError = error?.validationSpecError || await selectorSpecError(page, result, error, {
        phase: "action",
        actionId: action.id,
        actionIndex: action.index,
        actionKind: kind,
        actionValue: value,
        actionFingerprint,
        selector,
        selectorFingerprint,
      });
      action.error = validationSpecError?.message || error?.message || String(error);
      throw validationSpecError || error;
    }
    action.ok = true;
    if (STATEFUL_ACTION_KINDS.has(kind)) {
      latestStatefulAction = action;
      await page.waitForTimeout(25);
      refreshActionState(action, await captureInteractionState(page, selector));
    } else if (latestStatefulAction) {
      const latestSelector = selectorForAction(latestStatefulAction.kind, latestStatefulAction.value);
      refreshActionState(latestStatefulAction, await captureInteractionState(page, latestSelector));
    }
    await observeAssertionTransitions(page, result, assertionTrackers, latestStatefulAction);
  }
}

async function runChecks(page, result, assertionTrackers) {
  const text = await bodyText(page);

  const latestStatefulAction = [...result.actions]
    .reverse()
    .find((action) => action.ok && STATEFUL_ACTION_KINDS.has(action.kind));
  if (latestStatefulAction) {
    const selector = selectorForAction(latestStatefulAction.kind, latestStatefulAction.value);
    refreshActionState(latestStatefulAction, await captureInteractionState(page, selector));
    await observeAssertionTransitions(page, result, assertionTrackers, latestStatefulAction);
  }

  for (const tracker of assertionTrackers) {
    const { kind, value } = tracker;
    const observed = await evaluateCheck(page, result, tracker);
    const linkedAction = result.actions.find((action) => action.id === tracker.causalActionId);
    const causallyLinked = Boolean(
      observed.passed &&
      tracker.beforePassed === false &&
      tracker.changedAfterAction &&
      linkedAction?.effectStateChanged === true &&
      assertionEffectFieldsMatch(kind, linkedAction.effectChangedFields)
    );
    const assertion = {
      kind,
      value,
      passed: observed.passed,
      detail: observed.detail,
      beforePassed: tracker.beforePassed,
      changedAfterAction: tracker.changedAfterAction,
      afterActionId: tracker.causalActionId,
      causallyLinked,
    };
    result.assertions.push(assertion);
  }

  result.textPreview = text.slice(0, MAX_PREVIEW_CHARS);
}

async function main() {
  const startedAt = Date.now();
  const input = JSON.parse((await readStdin()) || "{}");
  const workspace = process.cwd();
  const timeoutMs = clampNumber(input.timeoutMs ?? input.timeout_ms, DEFAULT_TIMEOUT_MS, 1_000, 180_000);
  const failOnConsoleError = input.failOnConsoleError ?? input.fail_on_console_error ?? true;
  const shouldCaptureScreenshot = input.screenshot !== false && input.screenshot !== "false";
  const normalizedUrl = normalizeUrlForBrowser(input.url, workspace);

  const result = {
    ok: false,
    failureSummary: "",
    failureReasons: [],
    failureFingerprint: null,
    failureType: null,
    validationSpecError: null,
    failedAction: null,
    blankPage: false,
    url: normalizedUrl,
    finalUrl: "",
    status: null,
    title: "",
    actions: [],
    assertions: [],
    consoleMessages: [],
    consoleErrors: [],
    pageErrors: [],
    failedRequests: [],
    screenshotPath: null,
    screenshotError: null,
    renderDiagnostics: null,
    interactiveElements: [],
    textPreview: "",
    durationMs: 0,
    error: null,
    navigationCompleted: false,
  };

  let browser;
  let page;
  try {
    const chromium = await loadChromium();
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      ignoreHTTPSErrors: true,
      viewport: {
        width: clampNumber(input.viewportWidth ?? input.viewport_width, 1280, 320, 3840),
        height: clampNumber(input.viewportHeight ?? input.viewport_height, 900, 240, 2160),
      },
    });
    page = await context.newPage();

    page.on("console", (message) => {
      const item = { type: message.type(), text: message.text() };
      pushBounded(result.consoleMessages, item, MAX_CONSOLE_ITEMS);
      if (message.type() === "error") pushBounded(result.consoleErrors, item.text, MAX_CONSOLE_ITEMS);
    });
    page.on("pageerror", (error) => {
      pushBounded(result.pageErrors, error?.message || String(error), MAX_CONSOLE_ITEMS);
    });
    page.on("requestfailed", (request) => {
      pushBounded(
        result.failedRequests,
        `${request.method()} ${request.url()} ${request.failure()?.errorText || ""}`.trim(),
        MAX_FAILED_REQUESTS,
      );
    });

    const response = await page.goto(normalizedUrl, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    result.status = response?.status() ?? null;
    result.navigationCompleted = true;
    await capturePageDiagnostics(page, result);

    try {
      await page.waitForLoadState("networkidle", { timeout: Math.min(timeoutMs, 3000) });
    } catch {
      // Network idleness is best-effort; SPAs often keep dev connections open.
    }

    if (failOnConsoleError && result.pageErrors.length > 0) {
      throw new Error(`PAGE_RUNTIME_ERROR: ${result.pageErrors[0]}`);
    }

    if (input.waitForSelector || input.wait_for_selector) {
      const selector = String(input.waitForSelector || input.wait_for_selector);
      try {
        await page.locator(selector).first().waitFor({
          state: "visible",
          timeout: timeoutMs,
        });
      } catch (error) {
        throw await selectorSpecError(page, result, error, {
          phase: "wait_for_selector",
          actionKind: "wait_for_selector",
          actionValue: selector,
          selector,
        }) || error;
      }
    }
    if (input.waitForText || input.wait_for_text) {
      const expectedText = String(input.waitForText || input.wait_for_text);
      try {
        await page.waitForFunction(
          (needle) => document.body?.innerText?.includes(needle),
          expectedText,
          { timeout: timeoutMs },
        );
      } catch (error) {
        throw waitForTextSpecError(error, expectedText, result.title, {
          phase: "wait_for_text",
          actionKind: "wait_for_text",
        }) || error;
      }
    }

    const assertionTrackers = await createAssertionTrackers(page, input, result);
    await runActions(page, input, result, timeoutMs, workspace, assertionTrackers);
    await runChecks(page, result, assertionTrackers);

    await capturePageDiagnostics(page, result);
  } catch (error) {
    result.error = error?.message || String(error);
    result.validationSpecError = error?.validationSpecError || null;
  } finally {
    if (page) {
      try {
        await capturePageDiagnostics(page, result);
      } catch {
        // Preserve the original navigation or action failure.
      }
      if (shouldCaptureScreenshot) {
        try {
          await captureScreenshot(page, result, workspace);
        } catch (error) {
          result.screenshotError = error?.message || String(error);
        }
      }
    }
    finalizeValidationOutcome(result, failOnConsoleError);
    result.durationMs = Date.now() - startedAt;
    if (browser) {
      try {
        await browser.close();
      } catch {
        // Ignore cleanup failures; the validation result above is the useful signal.
      }
    }
  }

  process.stdout.write(`${JSON.stringify(result)}\n`);
}

main().catch((error) => {
  process.stdout.write(JSON.stringify({
    ok: false,
    error: error?.message || String(error),
    durationMs: 0,
  }) + "\n");
});
