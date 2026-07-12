#!/usr/bin/env node
import { mkdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const MAX_PREVIEW_CHARS = 4000;
const MAX_CONSOLE_ITEMS = 80;
const MAX_FAILED_REQUESTS = 40;

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
  const timeoutMs = clampNumber(input.timeoutMs ?? input.timeout_ms, 60_000, 1_000, 180_000);
  const failOnConsoleError = input.failOnConsoleError ?? input.fail_on_console_error ?? true;
  const normalizedUrl = normalizeUrlForBrowser(input.url, workspace);

  const result = {
    ok: false,
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
    textPreview: "",
    durationMs: 0,
    error: null,
  };

  let browser;
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
    const page = await context.newPage();

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

    if (input.screenshot === true || input.screenshot === "true") {
      const screenshotDir = path.resolve(workspace, ".MAIN", "browser-validation");
      await mkdir(screenshotDir, { recursive: true });
      const screenshotPath = path.join(screenshotDir, `browser-${Date.now()}.png`);
      await page.screenshot({ path: screenshotPath, fullPage: true });
      result.screenshotPath = path.relative(workspace, screenshotPath).replace(/\\/g, "/");
    }

    const assertionsPassed = result.assertions.every((item) => item.passed !== false);
    const actionsPassed = result.actions.every((item) => item.ok !== false);
    const consolePassed = failOnConsoleError ? result.consoleErrors.length === 0 && result.pageErrors.length === 0 : true;
    result.ok = actionsPassed && assertionsPassed && consolePassed;
  } catch (error) {
    result.error = error?.message || String(error);
    result.ok = false;
  } finally {
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
