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

  assert.equal(result.ok, true);
  assert.equal(result.status, 200);
  assert.equal(result.title, "Ready");
  assert.equal(result.assertions.length, 2);
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
