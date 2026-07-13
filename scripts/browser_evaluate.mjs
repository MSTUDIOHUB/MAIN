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
  return await page.evaluate(() => {
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
        blankPage: true,
      };
    }

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
      blankPage,
    };
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
    result.renderDiagnostics = await inspectRenderedPage(page);
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

  if (result.error) addFailure("runtime_error", result.error);
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
  const pageWasReached = typeof result.status === "number" || (result.finalUrl && result.finalUrl !== "about:blank");
  if (result.blankPage && pageWasReached) {
    const diagnostics = result.renderDiagnostics || {};
    addFailure(
      "blank_page",
      `no visible text or meaningful rendered content after load (bodyElements=${diagnostics.bodyElementCount ?? 0})`,
    );
  }
  if (result.screenshotError) addFailure("screenshot_failed", result.screenshotError);

  result.failureReasons = reasons;
  result.failureSummary = summaries.join(" | ").slice(0, MAX_FAILURE_SUMMARY_CHARS);
  result.ok = reasons.length === 0;
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

function pushBounded(list, item, max) {
  list.push(item);
  if (list.length > max) list.splice(0, list.length - max);
}

async function runActions(page, input, result, timeoutMs, workspace) {
  for (const line of parseLines(input.actions)) {
    const { kind, value } = parseDirective(line, "click");
    const action = { kind, value, ok: false };
    result.actions.push(action);
    if (!value && kind !== "no_console_errors") throw new Error(`Action ${kind} requires a value.`);

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
        throw new Error(describeWaitForTextFailure(error, value, result.title));
      }
    } else if (kind === "wait") {
      await page.waitForTimeout(clampNumber(value, 500, 0, Math.min(timeoutMs, 10_000)));
    } else {
      throw new Error(`Unsupported browser action: ${kind}`);
    }
    action.ok = true;
  }
}

async function runChecks(page, input, result) {
  const text = await bodyText(page);
  const consoleText = result.consoleMessages.map((item) => item.text).join("\n");
  const consoleErrors = [...result.consoleErrors, ...result.pageErrors];

  for (const line of parseLines(input.checks)) {
    const { kind, value } = parseDirective(line, "text");
    const assertion = { kind, value, passed: false, detail: "" };
    result.assertions.push(assertion);

    if (kind === "text") {
      assertion.passed = text.includes(value);
      assertion.detail = assertion.passed ? "text found" : "text not found in body";
    } else if (kind === "not_text") {
      assertion.passed = !text.includes(value);
      assertion.detail = assertion.passed ? "text absent" : "unexpected text found in body";
    } else if (kind === "selector") {
      const count = await page.locator(value).count();
      assertion.passed = count > 0;
      assertion.detail = `matched ${count} element(s)`;
    } else if (kind === "not_selector") {
      const count = await page.locator(value).count();
      assertion.passed = count === 0;
      assertion.detail = `matched ${count} element(s)`;
    } else if (kind === "title") {
      const title = await page.title();
      assertion.passed = title.includes(value);
      assertion.detail = `title: ${title}`;
    } else if (kind === "console") {
      assertion.passed = consoleText.includes(value);
      assertion.detail = assertion.passed ? "console text found" : "console text not found";
    } else if (kind === "not_console") {
      assertion.passed = !consoleText.includes(value);
      assertion.detail = assertion.passed ? "console text absent" : "unexpected console text found";
    } else if (kind === "no_console_errors") {
      assertion.passed = consoleErrors.length === 0;
      assertion.detail = assertion.passed ? "no console errors" : `${consoleErrors.length} console/page error(s)`;
    } else {
      assertion.detail = `unsupported assertion kind: ${kind}`;
    }
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
    textPreview: "",
    durationMs: 0,
    error: null,
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
      await page.locator(String(input.waitForSelector || input.wait_for_selector)).first().waitFor({
        state: "visible",
        timeout: timeoutMs,
      });
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
        throw new Error(describeWaitForTextFailure(error, expectedText, result.title));
      }
    }

    await runActions(page, input, result, timeoutMs, workspace);
    await runChecks(page, input, result);

    await capturePageDiagnostics(page, result);
  } catch (error) {
    result.error = error?.message || String(error);
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
