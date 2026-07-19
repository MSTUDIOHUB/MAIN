import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import fsSync from "node:fs";

const workspaceRoot = process.cwd();
const browserEvaluateScript = path.join(workspaceRoot, "scripts/browser_evaluate.mjs");
const tauriLibSource = fsSync.readFileSync(path.join(workspaceRoot, "src-tauri/src/lib.rs"), "utf8");

async function startServer(html) {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(html);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not expose a TCP port");
  return {
    url: `http://127.0.0.1:${address.port}/`,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

async function runBrowserEvaluate(input, cwd = workspaceRoot) {
  const child = spawn(process.execPath, [browserEvaluateScript], {
    cwd,
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

test("browser evaluator keeps page diagnostics when a body-text wait times out on the page title", async (t) => {
  const server = await startServer("<!doctype html><title>MD Viewer</title><main id=app></main>");
  t.after(server.close);

  const result = await runBrowserEvaluate({
    url: server.url,
    waitForText: "MD Viewer",
    timeoutMs: 1000,
    screenshot: false,
  });

  assert.equal(result.status, 200);
  assert.equal(result.title, "MD Viewer");
  assert.equal(result.finalUrl, server.url);
  assert.match(result.error, /wait_for_text only searches document\.body text/);
  assert.match(result.error, /title check/);
  assert.ok(result.failureReasons.includes("validation_spec_error"));
  assert.equal(result.failureType, "validation_spec_error");
  assert.equal(result.validationSpecError.code, "body_text_matches_title_only");
  assert.equal(result.validationSpecError.phase, "wait_for_text");
  assert.equal(result.validationSpecError.expectedText, "MD Viewer");
  assert.match(result.failureFingerprint, /^browser-failure-/);
  assert.match(result.validationSpecError.fingerprint, /^validation-spec-/);
});

test("browser evaluator reports a stable missing-selector specification error with locator inventory", async (t) => {
  const buttons = Array.from({ length: 40 }, (_, index) =>
    `<button id="button-${index}" aria-label="Action ${index}">Action ${index}</button>`
  ).join("");
  const server = await startServer(`<!doctype html><title>Controls</title><main>${buttons}</main>`);
  t.after(server.close);

  const input = {
    url: server.url,
    actions: "click: #new-file-btn",
    timeoutMs: 1000,
    screenshot: false,
  };
  const first = await runBrowserEvaluate(input);
  const second = await runBrowserEvaluate(input);

  for (const result of [first, second]) {
    assert.equal(result.ok, false);
    assert.ok(result.failureReasons.includes("validation_spec_error"));
    assert.equal(result.failureType, "validation_spec_error");
    assert.ok(result.failureReasons.includes("action_failed"));
    assert.equal(result.validationSpecError.code, "selector_not_found");
    assert.equal(result.validationSpecError.selector, "#new-file-btn");
    assert.equal(result.failedAction.kind, "click");
    assert.equal(result.failedAction.selector, "#new-file-btn");
    assert.equal(result.failedAction.actionFingerprint, result.validationSpecError.actionFingerprint);
    assert.equal(result.failedAction.selectorFingerprint, result.validationSpecError.selectorFingerprint);
    assert.ok(result.interactiveElements.length > 0);
    assert.ok(result.interactiveElements.length <= 32);
    assert.ok(result.interactiveElements.some((element) =>
      element.selectorCandidates.includes("#button-0")
    ));
    assert.equal(result.renderDiagnostics.interactiveElementInventoryTruncated, true);
    assert.match(result.failureSummary, /Inspect interactiveElements/);
  }

  assert.equal(first.failureFingerprint, second.failureFingerprint);
  assert.equal(first.failedAction.actionFingerprint, second.failedAction.actionFingerprint);
  assert.equal(first.failedAction.selectorFingerprint, second.failedAction.selectorFingerprint);
});

test("browser evaluator keeps a navigation failure transient instead of labeling it as a deterministic blank page", async () => {
  const server = await startServer("<!doctype html><main>temporary</main>");
  const unavailableUrl = server.url;
  await server.close();

  const result = await runBrowserEvaluate({
    url: unavailableUrl,
    timeoutMs: 1000,
    screenshot: false,
  });

  assert.equal(result.ok, false);
  assert.ok(result.failureReasons.includes("runtime_error"));
  assert.equal(result.failureReasons.includes("blank_page"), false);
  assert.equal(result.navigationCompleted, false);
  assert.equal(result.validationSpecError, null);
  assert.match(result.error, /ERR_CONNECTION_REFUSED|ECONNREFUSED/);
});

test("browser evaluator completes a DOM validation without a title/body mismatch", async (t) => {
  const server = await startServer("<!doctype html><title>Ready</title><main id=app>Ready</main>");
  t.after(server.close);

  const result = await runBrowserEvaluate({
    url: server.url,
    waitForText: "Ready",
    checks: "selector: #app;;title: Ready",
    timeoutMs: 2500,
    screenshot: false,
  });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.status, 200);
  assert.equal(result.title, "Ready");
  assert.equal(result.assertions.length, 2);
});

test("browser evaluator causally links an action, DOM state change, and post-action assertion", async (t) => {
  const server = await startServer([
    "<!doctype html><title>Actions</title>",
    "<button id=new-btn>New</button><main id=status>Existing</main>",
    "<script>document.querySelector('#new-btn').addEventListener('click', () => { document.querySelector('#status').textContent = 'Untitled'; });</script>",
  ].join(""));
  t.after(server.close);

  const result = await runBrowserEvaluate({
    url: server.url,
    actions: "click: #new-btn",
    checks: "text: Untitled;;no_console_errors",
    timeoutMs: 2500,
    screenshot: false,
  });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.actions[0].id, "action-1");
  assert.equal(result.actions[0].stateChanged, true);
  assert.equal(result.actions[0].effectStateChanged, true);
  assert.ok(result.actions[0].changedFields.includes("bodyText"));
  assert.ok(result.actions[0].effectChangedFields.includes("bodyText"));
  assert.equal(result.assertions[0].afterActionId, "action-1");
  assert.equal(result.assertions[0].beforePassed, false);
  assert.equal(result.assertions[0].changedAfterAction, true);
  assert.equal(result.assertions[0].causallyLinked, true);
  assert.equal(result.assertions[0].passed, true);
});

test("browser evaluator validates independent New Theme and Mode interactions", async (t) => {
  const server = await startServer([
    "<!doctype html><title>MD Viewer controls</title>",
    "<button id=new-btn>New</button><button id=theme-btn>Theme</button><button id=mode-btn>Mode</button>",
    "<main id=document-state>Existing</main><section id=editor-state>Preview</section>",
    "<script>",
    "document.querySelector('#new-btn').addEventListener('click', () => { document.querySelector('#document-state').textContent = 'Untitled'; });",
    "document.querySelector('#theme-btn').addEventListener('click', () => { document.body.classList.add('dark'); });",
    "document.querySelector('#mode-btn').addEventListener('click', () => { document.querySelector('#editor-state').classList.add('active'); });",
    "</script>",
  ].join(""));
  t.after(server.close);

  const result = await runBrowserEvaluate({
    url: server.url,
    actions: "click: #new-btn;;click: #theme-btn;;click: #mode-btn",
    checks: "text: Untitled;;selector: body.dark;;selector: #editor-state.active;;no_console_errors",
    timeoutMs: 2500,
    screenshot: false,
  });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.actions.map((action) => action.id), ["action-1", "action-2", "action-3"]);
  assert.equal(result.actions.every((action) => action.effectStateChanged === true), true);
  assert.deepEqual(
    result.assertions.slice(0, 3).map((assertion) => assertion.afterActionId),
    ["action-1", "action-2", "action-3"],
  );
  assert.equal(result.assertions.every((assertion) => assertion.passed === true), true);
  assert.equal(result.pageErrors.length, 0);
  assert.equal(result.consoleErrors.length, 0);
});

test("browser evaluator separates an input's native value change from a business effect", async (t) => {
  const server = await startServer([
    "<!doctype html><title>Native input</title>",
    "<input id=name required><main id=status>Ready</main>",
  ].join(""));
  t.after(server.close);

  const result = await runBrowserEvaluate({
    url: server.url,
    actions: "fill: #name => Ada",
    checks: "selector: #name:valid",
    timeoutMs: 2500,
    screenshot: false,
  });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.actions[0].stateChanged, true);
  assert.deepEqual(result.actions[0].nativeChangedFields, ["target.value"]);
  assert.equal(result.actions[0].effectStateChanged, false);
  assert.equal(result.assertions[0].beforePassed, false);
  assert.equal(result.assertions[0].changedAfterAction, true);
  assert.equal(result.assertions[0].causallyLinked, false);
});

test("an unrelated asynchronous DOM change cannot promote a pre-existing assertion", async (t) => {
  const server = await startServer([
    "<!doctype html><title>Unrelated change</title>",
    "<button id=run>Run</button><main id=status>Ready</main><aside id=clock>0</aside>",
    "<script>document.querySelector('#run').addEventListener('click', () => { setTimeout(() => { document.querySelector('#clock').textContent = '1'; }, 5); });</script>",
  ].join(""));
  t.after(server.close);

  const result = await runBrowserEvaluate({
    url: server.url,
    actions: "click: #run;;wait: 30",
    checks: "text: Ready",
    timeoutMs: 2500,
    screenshot: false,
  });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.actions[0].effectStateChanged, true);
  assert.equal(result.assertions[0].beforePassed, true);
  assert.equal(result.assertions[0].changedAfterAction, false);
  assert.equal(result.assertions[0].causallyLinked, false);
  assert.equal(result.assertions[0].afterActionId, null);
});

test("browser evaluator captures a screenshot by default and rejects a blank app shell", async (t) => {
  const server = await startServer("<!doctype html><title>Blank</title><main id=app></main>");
  const tempWorkspace = await mkdtemp(path.join(os.tmpdir(), "main-browser-evaluate-"));
  t.after(server.close);
  t.after(() => rm(tempWorkspace, { recursive: true, force: true }));

  const result = await runBrowserEvaluate({
    url: server.url,
    timeoutMs: 2500,
  }, tempWorkspace);

  assert.equal(result.ok, false);
  assert.equal(result.blankPage, true);
  assert.ok(result.failureReasons.includes("blank_page"));
  assert.match(result.failureSummary, /blank_page/);
  assert.match(result.screenshotPath, /^\.MAIN\/browser-validation\/browser-\d+-\d+\.png$/);
  await access(path.join(tempWorkspace, result.screenshotPath));
});

test("browser evaluator short-circuits body waits after a page runtime error and preserves evidence", async (t) => {
  const server = await startServer([
    "<!doctype html><title>Broken</title><main id=app></main>",
    "<script>document.querySelector('#missing').onclick = () => {};</script>",
  ].join(""));
  const tempWorkspace = await mkdtemp(path.join(os.tmpdir(), "main-browser-error-"));
  t.after(server.close);
  t.after(() => rm(tempWorkspace, { recursive: true, force: true }));

  const result = await runBrowserEvaluate({
    url: server.url,
    waitForText: "never appears",
    timeoutMs: 10_000,
  }, tempWorkspace);

  assert.equal(result.ok, false);
  assert.ok(result.failureReasons.includes("page_error"));
  assert.match(result.failureSummary, /Cannot set properties of null|Cannot set property/);
  assert.ok(result.durationMs < 5000, `runtime error should stop the wait early, got ${result.durationMs}ms`);
  assert.match(result.screenshotPath, /^\.MAIN\/browser-validation\/browser-\d+-\d+\.png$/);
  await access(path.join(tempWorkspace, result.screenshotPath));
});

test("blocking browser and finite command processes stay off the Tauri UI thread", () => {
  assert.match(
    tauriLibSource,
    /async fn browser_evaluate\([\s\S]{0,1200}?tauri::async_runtime::spawn_blocking/,
  );
  assert.match(
    tauriLibSource,
    /async fn run_command\([\s\S]{0,900}?tauri::async_runtime::spawn_blocking/,
  );
});
