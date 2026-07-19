#!/usr/bin/env node

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";

const MAX_INPUT_BYTES = 256 * 1024;
const MAX_APP_NAME_CHARS = 160;
const MAX_ACTIONS = 24;
const MAX_CHECKS = 24;
const MAX_INVENTORY_ITEMS = 60;
const MAX_ACTION_LINE_CHARS = 4_500;
const MAX_CONTROL_TARGET_CHARS = 500;
const MAX_FILL_VALUE_CHARS = 4_000;
const MAX_PATH_CHARS = 2_000;
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 180;

const JXA_ACCESSIBILITY_SCRIPT = String.raw`
var MAX_AMBIGUOUS_CANDIDATES = 5;
var FRONTMOST_CONFIRM_ATTEMPTS = 20;
var FRONTMOST_CONFIRM_DELAY_SECONDS = 0.05;

function safe(getter, fallback) {
  try {
    const value = getter();
    return value === undefined || value === null ? fallback : value;
  } catch (_) {
    return fallback;
  }
}

function compact(value, maxChars) {
  const text = String(value === undefined || value === null ? "" : value)
    .replace(/\s+/g, " ")
    .trim();
  return text.length <= maxChars ? text : text.slice(0, maxChars);
}

function normalized(value) {
  return compact(value, 240).toLowerCase();
}

function isSensitiveElementMetadata(role, subrole, name, title, description) {
  var roleText = normalized(role) + " " + normalized(subrole);
  if (roleText.indexOf("axsecuretextfield") >= 0) return true;
  var semanticText = [name, title, description].map(normalized).join(" ");
  return /(?:password|passcode|passphrase|secret|token|api\s*key|access\s*key|auth(?:entication)?\s*(?:key|token)|bearer\s*token|private\s*key|credential|密码|口令|令牌|密钥|凭据)/i.test(semanticText);
}

function isProtectedAccessibilityElement(element) {
  return Boolean(safe(function () {
    var attribute = element.attributes.byName("AXProtectedContent");
    return attribute.exists() && attribute.value();
  }, false));
}

function describeElement(element, index) {
  var role = compact(safe(function () { return element.role(); }, ""), 80);
  var subrole = compact(safe(function () { return element.subrole(); }, ""), 80);
  var name = compact(safe(function () { return element.name(); }, ""), 120);
  var title = compact(safe(function () { return element.title(); }, ""), 120);
  var description = compact(safe(function () { return element.description(); }, ""), 120);
  var sensitive = isProtectedAccessibilityElement(element) ||
    isSensitiveElementMetadata(role, subrole, name, title, description);
  var described = {
    index: index,
    role: role,
    subrole: subrole,
    name: name,
    title: title,
    description: description,
    enabled: Boolean(safe(function () { return element.enabled(); }, true)),
  };
  if (sensitive) {
    described.valueRedacted = true;
  } else {
    described.value = compact(safe(function () { return element.value(); }, ""), 120);
  }
  return described;
}

function elementScore(item, target) {
  const wanted = normalized(target);
  if (!wanted) return -1;
  const fields = [item.name, item.title, item.description]
    .map(normalized)
    .filter(Boolean);
  if (fields.some(function (field) { return field === wanted; })) return 100;
  if (fields.some(function (field) { return field.indexOf(wanted) >= 0; })) return 60;
  return -1;
}

function publicCandidate(item) {
  return {
    index: item.index,
    role: item.role,
    subrole: item.subrole,
    name: item.name,
    title: item.title,
    description: item.description,
    enabled: item.enabled,
  };
}

function confirmFrontmost(proc, appName) {
  proc.frontmost = true;
  delay(FRONTMOST_CONFIRM_DELAY_SECONDS);
  for (var attempt = 0; attempt < FRONTMOST_CONFIRM_ATTEMPTS; attempt += 1) {
    if (Boolean(safe(function () { return proc.frontmost(); }, false))) return true;
    delay(FRONTMOST_CONFIRM_DELAY_SECONDS);
  }
  throw new Error("TARGET_PROCESS_NOT_FRONTMOST: " + appName);
}

function collectBoundedElements(proc, maxElements) {
  const roots = safe(function () { return proc.uiElements(); }, []);
  const queue = roots.slice(0, maxElements);
  const collected = [];
  while (queue.length > 0 && collected.length < maxElements) {
    const element = queue.shift();
    collected.push(element);
    const remaining = maxElements - collected.length - queue.length;
    if (remaining <= 0) continue;
    const children = safe(function () { return element.uiElements(); }, []);
    for (let index = 0; index < children.length && index < remaining; index += 1) {
      queue.push(children[index]);
    }
  }
  return collected;
}

function processSnapshot(proc, rawElements, described) {
  const windows = safe(function () { return proc.windows(); }, []).slice(0, 12).map(function (window, index) {
    const position = safe(function () { return window.position(); }, []);
    const size = safe(function () { return window.size(); }, []);
    return {
      index: index,
      title: compact(safe(function () { return window.name(); }, ""), 160),
      position: Array.isArray(position) ? position.slice(0, 2).map(Number) : [],
      size: Array.isArray(size) ? size.slice(0, 2).map(Number) : [],
    };
  });
  return {
    running: true,
    frontmost: Boolean(safe(function () { return proc.frontmost(); }, false)),
    windows: windows,
    elementCount: rawElements.length,
    inventory: described.slice(0, ${MAX_INVENTORY_ITEMS}),
  };
}

function run(argv) {
  const operation = String(argv[0] || "inspect");
  const appName = String(argv[1] || "");
  const target = String(argv[2] || "");
  const value = String(argv[3] || "");
  const systemEvents = Application("System Events");
  const proc = systemEvents.processes.byName(appName);
  if (!safe(function () { return proc.exists(); }, false)) {
    throw new Error("APP_NOT_RUNNING: " + appName);
  }

  if (operation === "activate") {
    confirmFrontmost(proc, appName);
    return JSON.stringify({ ok: true, operation: operation, frontmost: true });
  }

  if (operation === "press") {
    const keyCodes = {
      enter: 36,
      return: 36,
      tab: 48,
      escape: 53,
      esc: 53,
      space: 49,
      arrowleft: 123,
      arrowright: 124,
      arrowdown: 125,
      arrowup: 126,
      delete: 51,
      backspace: 51,
    };
    const key = normalized(target).replace(/[\s_-]+/g, "");
    if (keyCodes[key] === undefined) throw new Error("UNSUPPORTED_KEY: " + target);
    confirmFrontmost(proc, appName);
    systemEvents.keyCode(keyCodes[key]);
    return JSON.stringify({ ok: true, operation: operation, frontmost: true, matched: { role: "keyboard", name: target } });
  }

  if (operation === "choose_file") {
    confirmFrontmost(proc, appName);
    systemEvents.keystroke("g", { using: ["command down", "shift down"] });
    delay(0.25);
    systemEvents.keystroke(target);
    delay(0.15);
    systemEvents.keyCode(36);
    delay(0.35);
    systemEvents.keyCode(36);
    return JSON.stringify({ ok: true, operation: operation, frontmost: true, matched: { role: "file", name: target } });
  }

  const rawElements = operation === "window_snapshot" ? [] : collectBoundedElements(proc, 180);
  const described = rawElements.map(describeElement);
  const snapshot = processSnapshot(proc, rawElements, described);

  if (operation === "inspect" || operation === "window_snapshot") {
    return JSON.stringify({ ok: true, operation: operation, snapshot: snapshot });
  }

  let bestScore = -1;
  let bestIndexes = [];
  for (let index = 0; index < described.length; index += 1) {
    const score = elementScore(described[index], target);
    if (score > bestScore) {
      bestScore = score;
      bestIndexes = score >= 0 ? [index] : [];
    } else if (score >= 0 && score === bestScore) {
      bestIndexes.push(index);
    }
  }
  if (bestIndexes.length === 0 || bestScore < 0) {
    throw new Error("ACCESSIBILITY_TARGET_NOT_FOUND: " + target);
  }
  if (bestIndexes.length > 1) {
    return JSON.stringify({
      ok: false,
      operation: operation,
      failureType: "ambiguous_target",
      error: "AMBIGUOUS_ACCESSIBILITY_TARGET: " + target,
      candidateCount: bestIndexes.length,
      candidates: bestIndexes.slice(0, MAX_AMBIGUOUS_CANDIDATES).map(function (index) {
        return publicCandidate(described[index]);
      }),
    });
  }
  const bestIndex = bestIndexes[0];
  const element = rawElements[bestIndex];
  const matched = described[bestIndex];
  proc.frontmost = true;

  if (operation === "click") {
    let pressed = false;
    try {
      const action = element.actions.byName("AXPress");
      if (action.exists()) {
        action.perform();
        pressed = true;
      }
    } catch (_) {}
    if (!pressed) element.click();
  } else if (operation === "fill") {
    element.value = value;
  } else {
    throw new Error("UNSUPPORTED_OPERATION: " + operation);
  }

  return JSON.stringify({ ok: true, operation: operation, matched: matched });
}
`;

function compact(value, maxChars = 240) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length <= maxChars ? text : `${text.slice(0, maxChars).trim()}…`;
}

function isSensitiveAccessibilityItem(item) {
  const roleText = `${String(item?.role || "")} ${String(item?.subrole || "")}`.toLowerCase();
  if (roleText.includes("axsecuretextfield")) return true;
  const semanticText = [item?.name, item?.title, item?.description]
    .map((value) => String(value || "").replace(/\s+/g, " ").trim())
    .join(" ");
  return /(?:password|passcode|passphrase|secret|token|api\s*key|access\s*key|auth(?:entication)?\s*(?:key|token)|bearer\s*token|private\s*key|credential|密码|口令|令牌|密钥|凭据)/i.test(semanticText);
}

function sanitizeAccessibilityItem(item) {
  if (!item || typeof item !== "object" || Array.isArray(item)) return null;
  const sanitized = {
    index: Number.isFinite(Number(item.index)) ? Number(item.index) : undefined,
    role: compact(item.role, 80),
    subrole: compact(item.subrole, 80),
    name: compact(item.name, 120),
    title: compact(item.title, 120),
    description: compact(item.description, 120),
    enabled: item.enabled !== false,
  };
  if (isSensitiveAccessibilityItem(sanitized) || item.valueRedacted === true) {
    return { ...sanitized, valueRedacted: true };
  }
  return { ...sanitized, value: compact(item.value, 120) };
}

function sanitizeAccessibilitySnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return {};
  return {
    ...snapshot,
    inventory: Array.isArray(snapshot.inventory)
      ? snapshot.inventory.map(sanitizeAccessibilityItem).filter(Boolean).slice(0, MAX_INVENTORY_ITEMS)
      : [],
  };
}

function sanitizeAmbiguousCandidates(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map(sanitizeAccessibilityItem)
    .filter(Boolean)
    .map(({ value: _value, valueRedacted: _valueRedacted, ...candidate }) => candidate)
    .slice(0, 5);
}

function clampTimeout(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_TIMEOUT_MS;
  return Math.min(MAX_TIMEOUT_MS, Math.max(1_000, Math.floor(parsed)));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function remainingBudgetMs(deadline, operation, cap = Number.POSITIVE_INFINITY) {
  const remaining = deadline - Date.now();
  if (remaining <= 50) throw new Error(`DESKTOP_TOTAL_TIMEOUT: ${operation}`);
  return Math.max(50, Math.min(remaining, cap));
}

async function sleepWithinBudget(ms, deadline, operation) {
  const requested = Math.max(0, Number(ms) || 0);
  const remaining = remainingBudgetMs(deadline, operation);
  if (requested > remaining) throw new Error(`DESKTOP_TOTAL_TIMEOUT: ${operation}`);
  await sleep(requested);
}

function normalizeBoolean(value, fallback) {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return fallback;
}

async function readStdin() {
  const chunks = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    total += chunk.length;
    if (total > MAX_INPUT_BYTES) throw new Error("INPUT_TOO_LARGE");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function runProcess(command, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout = [];
    const stderr = [];
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      reject(new Error(`PROCESS_TIMEOUT: ${command}`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const out = Buffer.concat(stdout).toString("utf8").trim();
      const err = Buffer.concat(stderr).toString("utf8").trim();
      if (code !== 0) {
        reject(new Error(compact(err || out || `${command} exited with ${code}`, 1_200)));
        return;
      }
      resolve({ stdout: out, stderr: err });
    });
  });
}

function classifyRuntimeError(error) {
  const message = compact(error instanceof Error ? error.message : error, 1_200);
  if (error && typeof error === "object" && error.desktopFailureType) {
    return {
      failureType: String(error.desktopFailureType),
      error: message,
      detail: message,
      ...(Array.isArray(error.desktopCandidates) ? { candidates: error.desktopCandidates } : {}),
      ...(Number.isFinite(error.desktopCandidateCount)
        ? { candidateCount: Number(error.desktopCandidateCount) }
        : {}),
    };
  }
  if (/PROCESS_TIMEOUT:\s*\/usr\/bin\/osascript/i.test(message)) {
    return {
      failureType: "permission_required",
      error: "macOS System Events did not answer the Accessibility request before the timeout. Check the pending Automation prompt, then enable MAIN in System Settings > Privacy & Security > Accessibility and Automation before retrying.",
      detail: message,
    };
  }
  if (/not allowed assistive access|not authorized to send apple events|automation permission|(-1719|-1743)|accessibility/i.test(message)) {
    return {
      failureType: "permission_required",
      error: "macOS Accessibility/Automation permission is required for real desktop control. Enable MAIN (or its launched runtime) in System Settings > Privacy & Security > Accessibility and Automation, then retry.",
      detail: message,
    };
  }
  if (/APP_NOT_RUNNING/i.test(message)) {
    return { failureType: "app_not_running", error: message, detail: message };
  }
  if (/TARGET_PROCESS_NOT_FRONTMOST/i.test(message)) {
    return { failureType: "target_not_frontmost", error: message, detail: message };
  }
  if (/AMBIGUOUS_ACCESSIBILITY_TARGET/i.test(message)) {
    return { failureType: "ambiguous_target", error: message, detail: message, candidates: [] };
  }
  if (/DESKTOP_TOTAL_TIMEOUT/i.test(message)) {
    return {
      failureType: "timeout",
      error: "The desktop-control call exhausted its total time budget before every requested action and check completed.",
      detail: message,
    };
  }
  if (/Application can't be found\. \(-2700\)/i.test(message)) {
    return {
      failureType: "automation_unavailable",
      error: "macOS System Events is unavailable in the current process environment; desktop control cannot run here.",
      detail: message,
    };
  }
  if (/ACCESSIBILITY_TARGET_NOT_FOUND|UNSUPPORTED_KEY|UNSUPPORTED_OPERATION/i.test(message)) {
    return { failureType: "validation_spec_error", error: message, detail: message };
  }
  return { failureType: "runtime_error", error: message, detail: message };
}

async function runJxa(operation, appName, target = "", value = "", timeoutMs = DEFAULT_TIMEOUT_MS) {
  const result = await runProcess(
    "/usr/bin/osascript",
    ["-l", "JavaScript", "-e", JXA_ACCESSIBILITY_SCRIPT, "--", operation, appName, target, value],
    timeoutMs,
  );
  const parsed = JSON.parse(result.stdout || "{}");
  if (!parsed || typeof parsed !== "object") throw new Error("INVALID_ACCESSIBILITY_RESPONSE");
  if (parsed.ok === false) {
    const error = new Error(compact(parsed.error || `DESKTOP_OPERATION_FAILED: ${operation}`, 1_200));
    error.desktopFailureType = String(parsed.failureType || "runtime_error");
    error.desktopCandidates = sanitizeAmbiguousCandidates(parsed.candidates);
    error.desktopCandidateCount = Number(parsed.candidateCount) || error.desktopCandidates.length;
    throw error;
  }
  return parsed;
}

function parseLines(value, limit, label) {
  const lines = String(value || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  if (lines.length > limit) throw new Error(`INVALID_TOO_MANY_${label}: maximum ${limit}`);
  if (lines.some((line) => line.length > MAX_ACTION_LINE_CHARS)) {
    throw new Error(`INVALID_${label}_LINE_TOO_LONG: maximum ${MAX_ACTION_LINE_CHARS} characters`);
  }
  return lines;
}

function resolveExistingWorkspacePath(workspace, requested, kind) {
  const errorCode = kind === "app"
    ? "APP_PATH_OUTSIDE_WORKSPACE_OR_MISSING"
    : "CHOOSE_FILE_OUTSIDE_WORKSPACE_OR_MISSING";
  if (!requested || String(requested).length > MAX_PATH_CHARS) {
    throw new Error(`${errorCode}: ${requested}`);
  }
  const workspaceReal = fs.realpathSync(workspace);
  const resolved = path.resolve(workspace, requested);
  if (!fs.existsSync(resolved)) throw new Error(`${errorCode}: ${requested}`);
  const actual = fs.realpathSync(resolved);
  const relative = path.relative(workspaceReal, actual);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${errorCode}: ${requested}`);
  }
  const stat = fs.statSync(actual);
  if (kind === "app") {
    if (!actual.toLowerCase().endsWith(".app") || !stat.isDirectory()) {
      throw new Error(`${errorCode}: ${requested}`);
    }
  } else if (!stat.isFile()) {
    throw new Error(`${errorCode}: ${requested}`);
  }
  return actual;
}

function parseActionLine(line, workspace) {
  if (/^(?:activate|inspect)$/i.test(line)) {
    return { kind: line.toLowerCase(), target: "" };
  }
  const match = line.match(/^([a-z_]+)\s*:\s*([\s\S]*)$/i);
  if (!match) throw new Error(`INVALID_ACTION: ${line}`);
  const kind = match[1].toLowerCase();
  const rest = match[2].trim();
  if (kind === "wait") {
    const waitMs = Number(rest);
    if (!Number.isFinite(waitMs) || waitMs < 0) throw new Error(`INVALID_WAIT: ${line}`);
    return { kind, target: String(Math.min(5_000, Math.floor(waitMs))) };
  }
  if (kind === "fill") {
    const separator = rest.indexOf("=>");
    if (separator < 1) throw new Error(`INVALID_FILL_ACTION: ${line}`);
    const target = rest.slice(0, separator).trim();
    const value = rest.slice(separator + 2).trim();
    if (!target || target.length > MAX_CONTROL_TARGET_CHARS || value.length > MAX_FILL_VALUE_CHARS) {
      throw new Error(`INVALID_FILL_ACTION: ${line}`);
    }
    return { kind, target, value };
  }
  if (kind === "choose_file") {
    if (!rest) throw new Error(`INVALID_CHOOSE_FILE_ACTION: ${line}`);
    return { kind, target: resolveExistingWorkspacePath(workspace, rest, "file") };
  }
  if (!["click", "press", "wait_for"].includes(kind) || !rest || rest.length > MAX_CONTROL_TARGET_CHARS) {
    throw new Error(`UNSUPPORTED_ACTION: ${line}`);
  }
  return { kind, target: rest };
}

function parseCheckLine(line) {
  const match = line.match(/^([a-z_]+)\s*:\s*([\s\S]+)$/i);
  if (!match) throw new Error(`INVALID_CHECK: ${line}`);
  const kind = match[1].toLowerCase();
  const target = match[2].trim();
  if (!["text", "not_text", "window", "not_window", "role", "not_role", "dialog"].includes(kind)) {
    throw new Error(`UNSUPPORTED_CHECK: ${line}`);
  }
  if (!target || target.length > MAX_CONTROL_TARGET_CHARS) throw new Error(`INVALID_CHECK: ${line}`);
  return { kind, target };
}

function snapshotFingerprint(snapshot) {
  const stable = {
    windows: Array.isArray(snapshot?.windows) ? snapshot.windows : [],
    inventory: Array.isArray(snapshot?.inventory) ? snapshot.inventory : [],
  };
  return createHash("sha256").update(JSON.stringify(stable)).digest("hex").slice(0, 16);
}

function compactSnapshot(snapshot) {
  return {
    windowTitles: Array.isArray(snapshot?.windows)
      ? snapshot.windows.map((item) => compact(item?.title, 120)).filter(Boolean).slice(0, 12)
      : [],
    elementCount: Number(snapshot?.elementCount || 0),
    accessibilityFingerprint: snapshotFingerprint(snapshot),
  };
}

function searchableSnapshotText(snapshot) {
  const inventory = Array.isArray(snapshot?.inventory) ? snapshot.inventory : [];
  const windows = Array.isArray(snapshot?.windows) ? snapshot.windows : [];
  return [
    ...windows.map((item) => item?.title),
    ...inventory.flatMap((item) => [item?.role, item?.subrole, item?.name, item?.title, item?.description, item?.value]),
  ].map((item) => String(item || "")).join("\n").toLowerCase();
}

function evaluateCheck(check, snapshot) {
  const text = searchableSnapshotText(snapshot);
  const target = check.target.toLowerCase();
  const windows = Array.isArray(snapshot?.windows) ? snapshot.windows : [];
  const inventory = Array.isArray(snapshot?.inventory) ? snapshot.inventory : [];
  if (check.kind === "text") return text.includes(target);
  if (check.kind === "not_text") return !text.includes(target);
  if (check.kind === "window" || check.kind === "not_window") {
    const found = windows.some((item) => String(item?.title || "").toLowerCase().includes(target));
    return check.kind === "window" ? found : !found;
  }
  if (check.kind === "role" || check.kind === "not_role") {
    const found = inventory.some((item) => [item?.role, item?.subrole].some((value) => String(value || "").toLowerCase() === target));
    return check.kind === "role" ? found : !found;
  }
  const dialogVisible = inventory.some((item) => /^(?:AXDialog|AXSheet)$/i.test(String(item?.role || item?.subrole || "")));
  return /^(?:visible|present|open|true|yes|显示|存在|打开)$/i.test(check.target)
    ? dialogVisible
    : /^(?:hidden|absent|closed|false|no|隐藏|不存在|关闭)$/i.test(check.target)
    ? !dialogVisible
    : false;
}

async function inspect(appName, timeoutMs, includeInventory = true) {
  const result = await runJxa(includeInventory ? "inspect" : "window_snapshot", appName, "", "", timeoutMs);
  return sanitizeAccessibilitySnapshot(result.snapshot || {});
}

async function waitForAccessibleTarget(appName, target, deadline) {
  let latest = null;
  while (Date.now() <= deadline) {
    latest = await inspect(appName, remainingBudgetMs(deadline, "wait_for", 5_000));
    if (searchableSnapshotText(latest).includes(target.toLowerCase())) return latest;
    await sleepWithinBudget(
      Math.min(POLL_INTERVAL_MS, Math.max(0, deadline - Date.now() - 50)),
      deadline,
      "wait_for",
    );
  }
  throw new Error(`ACCESSIBILITY_TARGET_NOT_FOUND: ${target}`);
}

async function captureWindowScreenshot(workspace, snapshot, timeoutMs) {
  const firstWindow = Array.isArray(snapshot?.windows) ? snapshot.windows[0] : null;
  const position = Array.isArray(firstWindow?.position) ? firstWindow.position.map(Number) : [];
  const size = Array.isArray(firstWindow?.size) ? firstWindow.size.map(Number) : [];
  if (position.length < 2 || size.length < 2 || size[0] <= 0 || size[1] <= 0) {
    throw new Error("WINDOW_BOUNDS_UNAVAILABLE");
  }
  const workspaceReal = fs.realpathSync(workspace);
  const directory = path.resolve(workspaceReal, ".MAIN", "desktop-validation");
  fs.mkdirSync(directory, { recursive: true });
  const directoryReal = fs.realpathSync(directory);
  const relativeDirectory = path.relative(workspaceReal, directoryReal);
  if (relativeDirectory.startsWith("..") || path.isAbsolute(relativeDirectory)) {
    throw new Error("SCREENSHOT_PATH_OUTSIDE_WORKSPACE");
  }
  const screenshotPath = path.join(directoryReal, `desktop-${Date.now()}.png`);
  const region = `${Math.floor(position[0])},${Math.floor(position[1])},${Math.floor(size[0])},${Math.floor(size[1])}`;
  await runProcess("/usr/sbin/screencapture", ["-x", "-R", region, screenshotPath], timeoutMs);
  if (!fs.existsSync(screenshotPath) || fs.statSync(screenshotPath).size === 0) {
    throw new Error("SCREENSHOT_NOT_CREATED");
  }
  return screenshotPath;
}

function emit(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

const startedAt = Date.now();
let appName = "";
try {
  const raw = await readStdin();
  const input = raw.trim() ? JSON.parse(raw) : {};
  appName = String(input.appName ?? input.app_name ?? input.app ?? "").trim();
  const workspace = path.resolve(String(input.workspace || process.cwd()));
  const timeoutMs = clampTimeout(input.timeoutMs ?? input.timeout_ms);
  const deadline = startedAt + timeoutMs;
  const shouldLaunch = normalizeBoolean(input.launch, false);
  const shouldActivate = normalizeBoolean(input.activate, true);
  const shouldScreenshot = normalizeBoolean(input.screenshot, false);
  const appPathRaw = String(input.appPath ?? input.app_path ?? "").trim();

  if (process.platform !== "darwin") {
    emit({
      ok: false,
      failureType: "unsupported_platform",
      error: `computer_use currently requires macOS Accessibility APIs; platform=${process.platform}`,
      actions: [],
      assertions: [],
      durationMs: Date.now() - startedAt,
    });
    process.exit(0);
  }
  if (!appName || appName.length > MAX_APP_NAME_CHARS || /[\u0000-\u001f\u007f]/.test(appName)) {
    throw new Error("INVALID_APP_NAME");
  }
  if (appPathRaw.length > MAX_PATH_CHARS) throw new Error("APP_PATH_OUTSIDE_WORKSPACE_OR_MISSING: path too long");

  const actionLines = parseLines(input.actions, MAX_ACTIONS, "ACTIONS");
  const checkLines = parseLines(input.checks, MAX_CHECKS, "CHECKS");
  const actions = actionLines.map((line) => parseActionLine(line, workspace));
  const checks = checkLines.map(parseCheckLine);

  if (shouldLaunch) {
    if (appPathRaw) {
      const resolvedAppPath = resolveExistingWorkspacePath(workspace, appPathRaw, "app");
      await runProcess("/usr/bin/open", [resolvedAppPath], remainingBudgetMs(deadline, "launch", 15_000));
    } else {
      await runProcess("/usr/bin/open", ["-a", appName], remainingBudgetMs(deadline, "launch", 15_000));
    }
    await sleepWithinBudget(700, deadline, "launch_settle");
  }

  if (shouldLaunch && actions.length === 0 && checks.length === 0 && !shouldScreenshot) {
    emit({
      ok: true,
      failureType: null,
      failureSummary: null,
      failureReasons: [],
      appName,
      launched: true,
      actions: [{ id: "desktop-action-1", kind: "launch", target: appName, ok: true, interaction: false }],
      assertions: [],
      causalAssertionSatisfied: false,
      accessibility: null,
      screenshotPath: null,
      screenshotError: null,
      durationMs: Date.now() - startedAt,
      error: null,
    });
    process.exit(0);
  }

  if (shouldActivate) {
    await runJxa("activate", appName, "", "", remainingBudgetMs(deadline, "activate", 8_000));
  }
  const inventoryRequired = actions.some((action) => ["click", "fill", "wait_for", "choose_file"].includes(action.kind)) ||
    checks.some((check) => ["text", "not_text", "role", "not_role", "dialog"].includes(check.kind));
  const initialSnapshot = await inspect(
    appName,
    remainingBudgetMs(deadline, "initial_inspect", 12_000),
    inventoryRequired,
  );
  let latestSnapshot = initialSnapshot;
  const actionResults = [];

  for (let index = 0; index < actions.length; index += 1) {
    const action = actions[index];
    const before = latestSnapshot;
    const actionId = `desktop-action-${index + 1}`;
    try {
      let detail = null;
      if (action.kind === "wait") {
        await sleepWithinBudget(Number(action.target), deadline, "wait");
      } else if (action.kind === "wait_for") {
        latestSnapshot = await waitForAccessibleTarget(appName, action.target, deadline);
      } else if (action.kind === "inspect") {
        latestSnapshot = await inspect(
          appName,
          remainingBudgetMs(deadline, "inspect", 12_000),
          inventoryRequired,
        );
      } else {
        const result = await runJxa(
          action.kind,
          appName,
          action.target,
          action.value || "",
          remainingBudgetMs(deadline, action.kind),
        );
        detail = result.matched || null;
      }
      if (action.kind !== "wait_for" && action.kind !== "inspect") {
        await sleepWithinBudget(120, deadline, "post_action_settle");
        latestSnapshot = await inspect(
          appName,
          remainingBudgetMs(deadline, "post_action_inspect", 12_000),
          inventoryRequired,
        );
      }
      const beforeState = compactSnapshot(before);
      const afterState = compactSnapshot(latestSnapshot);
      const stateChanged = beforeState.accessibilityFingerprint !== afterState.accessibilityFingerprint;
      actionResults.push({
        id: actionId,
        kind: action.kind,
        target: action.target,
        ok: true,
        interaction: ["click", "fill", "press", "choose_file"].includes(action.kind),
        beforeState,
        afterState,
        stateChanged,
        changedFields: stateChanged ? ["accessibilityFingerprint"] : [],
        ...(detail ? { detail } : {}),
      });
    } catch (error) {
      const classified = classifyRuntimeError(error);
      actionResults.push({
        id: actionId,
        kind: action.kind,
        target: action.target,
        ok: false,
        interaction: ["click", "fill", "press", "choose_file"].includes(action.kind),
        error: classified.error,
        failureType: classified.failureType,
        beforeState: compactSnapshot(before),
        ...(Array.isArray(classified.candidates) ? { candidates: classified.candidates } : {}),
        ...(Number.isFinite(classified.candidateCount) ? { candidateCount: classified.candidateCount } : {}),
      });
      break;
    }
  }

  try {
    latestSnapshot = await inspect(
      appName,
      remainingBudgetMs(deadline, "final_inspect", 12_000),
      inventoryRequired,
    );
  } catch (error) {
    if (actionResults.length === 0 || actionResults.every((item) => item.ok)) throw error;
  }

  const lastInteractiveAction = [...actionResults].reverse().find((item) => item.interaction && item.ok);
  const assertions = checks.map((check) => {
    const beforePassed = evaluateCheck(check, initialSnapshot);
    const passed = evaluateCheck(check, latestSnapshot);
    const changedAfterAction = beforePassed !== passed;
    return {
      kind: check.kind,
      target: check.target,
      passed,
      beforePassed,
      changedAfterAction,
      causallyLinked: Boolean(lastInteractiveAction && beforePassed === false && passed === true),
      ...(lastInteractiveAction ? { afterActionId: lastInteractiveAction.id } : {}),
    };
  });

  let screenshotPath = null;
  let screenshotError = null;
  if (shouldScreenshot) {
    try {
      screenshotPath = await captureWindowScreenshot(
        workspace,
        latestSnapshot,
        remainingBudgetMs(deadline, "screenshot", 15_000),
      );
    } catch (error) {
      screenshotError = compact(error instanceof Error ? error.message : error, 500);
    }
  }

  const failedAction = actionResults.find((item) => !item.ok);
  const failedAssertions = assertions.filter((item) => !item.passed);
  const failureReasons = [
    ...(failedAction ? [failedAction.error || `${failedAction.kind} failed`] : []),
    ...failedAssertions.map((item) => `assertion failed: ${item.kind}: ${item.target}`),
    ...(shouldScreenshot && screenshotError ? [`screenshot failed: ${screenshotError}`] : []),
  ];
  const ok = failureReasons.length === 0;
  emit({
    ok,
    failureType: !ok
      ? failedAction?.failureType || (failedAssertions.length > 0 ? "assertion_failed" : "evidence_capture_error")
      : null,
    failureSummary: failureReasons[0] || null,
    failureReasons,
    ...(Array.isArray(failedAction?.candidates) ? { candidates: failedAction.candidates } : {}),
    ...(Number.isFinite(failedAction?.candidateCount) ? { candidateCount: failedAction.candidateCount } : {}),
    appName,
    launched: shouldLaunch,
    actions: actionResults,
    assertions,
    causalAssertionSatisfied: assertions.some((item) => item.causallyLinked && item.passed),
    accessibility: {
      ...compactSnapshot(latestSnapshot),
      inventory: Array.isArray(latestSnapshot?.inventory)
        ? latestSnapshot.inventory.slice(0, MAX_INVENTORY_ITEMS)
        : [],
    },
    screenshotPath,
    screenshotError,
    durationMs: Date.now() - startedAt,
    error: failureReasons[0] || null,
  });
} catch (error) {
  const rawMessage = compact(error instanceof Error ? error.message : error, 1_200);
  const validationSpecError = /^(?:INVALID_|UNSUPPORTED_ACTION|UNSUPPORTED_CHECK|APP_PATH_OUTSIDE_WORKSPACE_OR_MISSING|CHOOSE_FILE_OUTSIDE_WORKSPACE_OR_MISSING)/i.test(rawMessage);
  const classified = validationSpecError
    ? { failureType: "validation_spec_error", error: rawMessage, detail: rawMessage }
    : classifyRuntimeError(error);
  emit({
    ok: false,
    failureType: classified.failureType,
    failureSummary: classified.error,
    failureReasons: [classified.error],
    appName: appName || null,
    actions: [],
    assertions: [],
    screenshotPath: null,
    durationMs: Date.now() - startedAt,
    error: classified.error,
    ...(Array.isArray(classified.candidates) ? { candidates: classified.candidates } : {}),
    ...(Number.isFinite(classified.candidateCount) ? { candidateCount: classified.candidateCount } : {}),
    ...(classified.detail && classified.detail !== classified.error ? { detail: classified.detail } : {}),
  });
}
