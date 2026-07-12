import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";

const workspaceRoot = process.cwd();
const browserEvaluateScript = path.join(workspaceRoot, "scripts/browser_evaluate.mjs");

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

async function runBrowserEvaluate(input) {
  const child = spawn(process.execPath, [browserEvaluateScript], {
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

test("browser evaluator keeps page diagnostics when a body-text wait times out on the page title", async (t) => {
  const server = await startServer("<!doctype html><title>MD Viewer</title><main id=app></main>");
  t.after(server.close);

  const result = await runBrowserEvaluate({
    url: server.url,
    waitForText: "MD Viewer",
    timeoutMs: 1000,
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
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, 200);
  assert.equal(result.title, "Ready");
  assert.equal(result.assertions.length, 2);
});
