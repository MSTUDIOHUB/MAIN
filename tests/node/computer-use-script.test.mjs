import test from "node:test";
import assert from "node:assert/strict";
import fsSync from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import vm from "node:vm";

const workspaceRoot = process.cwd();
const computerUseScript = path.join(workspaceRoot, "scripts/computer_use.mjs");
const scriptSource = fsSync.readFileSync(computerUseScript, "utf8");
const tauriSource = fsSync.readFileSync(path.join(workspaceRoot, "src-tauri/src/lib.rs"), "utf8");
const tauriConfig = JSON.parse(fsSync.readFileSync(path.join(workspaceRoot, "src-tauri/tauri.conf.json"), "utf8"));

function extractFixedJxaSource() {
  const prefix = "const JXA_ACCESSIBILITY_SCRIPT = String.raw`";
  const start = scriptSource.indexOf(prefix);
  const end = scriptSource.indexOf("`;\n\nfunction compact", start + prefix.length);
  assert.notEqual(start, -1, "fixed JXA source start must exist");
  assert.notEqual(end, -1, "fixed JXA source end must exist");
  return scriptSource
    .slice(start + prefix.length, end)
    .replaceAll("${MAX_INVENTORY_ITEMS}", "60");
}

function fakeElement(input = {}) {
  return {
    role: () => input.role || "AXButton",
    subrole: () => input.subrole || "",
    name: () => input.name || "",
    title: () => input.title || "",
    description: () => input.description || "",
    enabled: () => input.enabled !== false,
    value: () => {
      input.onValueRead?.();
      return input.value || "";
    },
    uiElements: () => input.children || [],
    attributes: {
      byName: (name) => ({
        exists: () => name === "AXProtectedContent" && input.protectedContent === true,
        value: () => input.protectedContent === true,
      }),
    },
    actions: {
      byName: () => ({
        exists: () => true,
        perform: () => input.onPress?.(),
      }),
    },
    click: () => input.onClick?.(),
  };
}

function createJxaHarness({ elements = [], frontmostWorks = true } = {}) {
  let frontmost = false;
  const keyCodes = [];
  const keystrokes = [];
  const delays = [];
  const processTarget = {
    exists: () => true,
    uiElements: () => elements,
    windows: () => [],
  };
  const processProxy = new Proxy(processTarget, {
    get(target, property) {
      if (property === "frontmost") return () => frontmost;
      return target[property];
    },
    set(target, property, value) {
      if (property === "frontmost") {
        if (frontmostWorks) frontmost = Boolean(value);
        return true;
      }
      target[property] = value;
      return true;
    },
  });
  const systemEvents = {
    processes: { byName: () => processProxy },
    keyCode: (code) => keyCodes.push(code),
    keystroke: (text, options) => keystrokes.push({ text, options }),
  };
  const context = vm.createContext({
    Application: () => systemEvents,
    delay: (seconds) => delays.push(seconds),
  });
  vm.runInContext(`${extractFixedJxaSource()}\nthis.__computerUseRun = run;`, context, {
    filename: "computer_use_fixed_jxa.js",
  });
  return {
    run: (operation, target = "", value = "") => context.__computerUseRun([operation, "MAIN", target, value]),
    keyCodes,
    keystrokes,
    delays,
  };
}

async function runComputerUse(input) {
  const child = spawn(process.execPath, [computerUseScript], {
    cwd: workspaceRoot,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.stdin.end(JSON.stringify(input));
  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  assert.equal(exitCode, 0, stderr);
  return JSON.parse(stdout);
}

test("computer_use rejects arbitrary or unknown action languages before desktop access", async () => {
  const result = await runComputerUse({
    appName: "MAIN",
    actions: "script: tell application System Events\nclick_at: 10,20",
  });

  assert.equal(result.ok, false);
  assert.equal(result.failureType, "validation_spec_error");
  assert.match(result.error, /UNSUPPORTED_ACTION/);
  assert.deepEqual(result.actions, []);
});

test("computer_use rejects truncated action plans instead of silently skipping work", async () => {
  const result = await runComputerUse({
    appName: "MAIN",
    actions: Array.from({ length: 25 }, () => "inspect").join("\n"),
  });

  assert.equal(result.ok, false);
  assert.equal(result.failureType, "validation_spec_error");
  assert.match(result.error, /INVALID_TOO_MANY_ACTIONS/);
});

test("computer_use rejects launch and file-selection paths outside the workspace", async () => {
  const launch = await runComputerUse({
    appName: "External",
    appPath: "/Applications/TextEdit.app",
    launch: true,
  });
  assert.equal(launch.ok, false);
  assert.equal(launch.failureType, "validation_spec_error");
  assert.match(launch.error, /APP_PATH_OUTSIDE_WORKSPACE_OR_MISSING/);

  const choose = await runComputerUse({
    appName: "MAIN",
    actions: "choose_file: /etc/hosts",
  });
  assert.equal(choose.ok, false);
  assert.equal(choose.failureType, "validation_spec_error");
  assert.match(choose.error, /CHOOSE_FILE_OUTSIDE_WORKSPACE_OR_MISSING/);
});

test("computer_use adapter keeps automation code fixed and passes model values only as argv", () => {
  assert.match(scriptSource, /const JXA_ACCESSIBILITY_SCRIPT = String\.raw/);
  assert.match(scriptSource, /\["-l", "JavaScript", "-e", JXA_ACCESSIBILITY_SCRIPT, "--", operation, appName, target, value\]/);
  assert.doesNotMatch(scriptSource, /eval\s*\(/);
  assert.doesNotMatch(scriptSource, /shell\s*:\s*true/);
  assert.match(scriptSource, /Accessibility\/Automation permission is required/);
  assert.match(scriptSource, /interaction: \["click", "fill", "press", "choose_file"\]/);
  assert.match(scriptSource, /remainingBudgetMs\(deadline/);
  assert.match(scriptSource, /DESKTOP_TOTAL_TIMEOUT/);
  assert.match(scriptSource, /fs\.realpathSync\(workspace\)/);
});

test("computer_use never reads or returns values from secure and credential-like controls", () => {
  let secureValueReads = 0;
  let tokenValueReads = 0;
  let protectedValueReads = 0;
  const harness = createJxaHarness({
    elements: [
      fakeElement({
        role: "AXTextField",
        subrole: "AXSecureTextField",
        name: "Password",
        value: "super-secret-password",
        onValueRead: () => { secureValueReads += 1; },
      }),
      fakeElement({
        role: "AXTextField",
        name: "API Token",
        value: "token-value-123",
        onValueRead: () => { tokenValueReads += 1; },
      }),
      fakeElement({
        role: "AXTextField",
        name: "Account field",
        protectedContent: true,
        value: "protected-value-456",
        onValueRead: () => { protectedValueReads += 1; },
      }),
      fakeElement({ role: "AXStaticText", name: "Status", value: "Ready" }),
    ],
  });

  const result = JSON.parse(harness.run("inspect"));
  assert.equal(result.ok, true);
  assert.equal(secureValueReads, 0);
  assert.equal(tokenValueReads, 0);
  assert.equal(protectedValueReads, 0);
  assert.equal(result.snapshot.inventory[0].value, undefined);
  assert.equal(result.snapshot.inventory[0].valueRedacted, true);
  assert.equal(result.snapshot.inventory[1].value, undefined);
  assert.equal(result.snapshot.inventory[1].valueRedacted, true);
  assert.equal(result.snapshot.inventory[2].value, undefined);
  assert.equal(result.snapshot.inventory[2].valueRedacted, true);
  assert.equal(result.snapshot.inventory[3].value, "Ready");
  assert.doesNotMatch(JSON.stringify(result), /super-secret-password|token-value-123|protected-value-456/);
});

test("computer_use refuses global keys unless the requested process is confirmed frontmost", () => {
  const pressHarness = createJxaHarness({ frontmostWorks: false });
  assert.throws(
    () => pressHarness.run("press", "Enter"),
    /TARGET_PROCESS_NOT_FRONTMOST: MAIN/,
  );
  assert.deepEqual(pressHarness.keyCodes, []);
  assert.deepEqual(pressHarness.keystrokes, []);
  assert.ok(pressHarness.delays.length > 0, "frontmost confirmation must wait before refusing global input");

  const chooseHarness = createJxaHarness({ frontmostWorks: false });
  assert.throws(
    () => chooseHarness.run("choose_file", "/workspace/example.md"),
    /TARGET_PROCESS_NOT_FRONTMOST: MAIN/,
  );
  assert.deepEqual(chooseHarness.keyCodes, []);
  assert.deepEqual(chooseHarness.keystrokes, []);
  assert.ok(chooseHarness.delays.length > 0, "file chooser must wait for confirmed focus before typing");

  const confirmedHarness = createJxaHarness({ frontmostWorks: true });
  const confirmed = JSON.parse(confirmedHarness.run("press", "Enter"));
  assert.equal(confirmed.ok, true);
  assert.equal(confirmed.frontmost, true);
  assert.ok(confirmedHarness.delays.length > 0);
  assert.deepEqual(confirmedHarness.keyCodes, [36]);
  assert.match(scriptSource, /failureType:\s*"target_not_frontmost"/);
});

test("computer_use rejects tied accessibility matches with bounded value-free candidates", () => {
  let pressed = 0;
  const elements = Array.from({ length: 8 }, (_, index) => fakeElement({
    role: "AXButton",
    name: "Save",
    description: `Save button ${index + 1}`,
    value: `private-value-${index + 1}`,
    onPress: () => { pressed += 1; },
  }));
  const harness = createJxaHarness({ elements });
  const result = JSON.parse(harness.run("click", "Save"));

  assert.equal(result.ok, false);
  assert.equal(result.failureType, "ambiguous_target");
  assert.equal(result.candidateCount, 8);
  assert.equal(result.candidates.length, 5);
  assert.equal(pressed, 0);
  assert.ok(result.candidates.every((candidate) => !("value" in candidate)));
  assert.doesNotMatch(JSON.stringify(result), /private-value/);
});

test("computer_use target resolution never matches accessibility values", () => {
  let pressed = 0;
  const harness = createJxaHarness({
    elements: [fakeElement({
      role: "AXButton",
      name: "Unrelated control",
      value: "Hidden Target",
      onPress: () => { pressed += 1; },
    })],
  });

  assert.throws(
    () => harness.run("click", "Hidden Target"),
    /ACCESSIBILITY_TARGET_NOT_FOUND/,
  );
  assert.equal(pressed, 0);
  assert.match(scriptSource, /const fields = \[item\.name, item\.title, item\.description\]/);
  assert.doesNotMatch(scriptSource, /const fields = \[[^\]]*item\.value/);
});

test("Tauri registers computer_use and supervises the adapter off the async runtime", () => {
  assert.match(tauriSource, /async fn computer_use\(/);
  assert.match(tauriSource, /run_computer_use_process\(/);
  assert.match(tauriSource, /tauri::async_runtime::spawn_blocking/);
  assert.match(tauriSource, /computer_use,/);
  assert.match(tauriSource, /computer_use_script_path\(\)/);
  assert.equal(tauriConfig.bundle.resources["../scripts/computer_use.mjs"], "scripts/computer_use.mjs");
  assert.equal(tauriConfig.bundle.resources["../scripts/browser_evaluate.mjs"], "scripts/browser_evaluate.mjs");
});
