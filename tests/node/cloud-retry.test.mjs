import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";

import ts from "typescript";

const require = createRequire(import.meta.url);
const workspaceRoot = process.cwd();

async function loadCloudRetryModule() {
  const sourcePath = path.join(workspaceRoot, "src/lib/cloudRetry.ts");
  const source = await fs.readFile(sourcePath, "utf8");
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
    fileName: sourcePath,
  }).outputText;

  const module = { exports: {} };
  const factory = new Function("exports", "module", "require", transpiled);
  factory(module.exports, module, require);
  return module.exports;
}

const { isCloudGatewayTimeoutMessage, isRetryableCloudErrorMessage } = await loadCloudRetryModule();

test("cloud retry helper matches transient upstream gateway failures", () => {
  assert.equal(
    isRetryableCloudErrorMessage('HTTP 502 Bad Gateway: {"error":{"message":"Upstream request failed","type":"upstream_error"}}'),
    true,
  );
  assert.equal(isRetryableCloudErrorMessage("HTTP 504 Gateway Timeout"), true);
});

test("cloud retry helper ignores non-retryable validation failures", () => {
  assert.equal(
    isRetryableCloudErrorMessage('HTTP 400 Bad Request: {"error":{"message":"Unsupported content type","type":"invalid_request_error"}}'),
    false,
  );
});

test("cloud retry helper exposes 524 as a terminal gateway timeout category", () => {
  assert.equal(isRetryableCloudErrorMessage("HTTP 524: error code: 524"), true);
  assert.equal(isCloudGatewayTimeoutMessage("HTTP 524: error code: 524"), true);
  assert.equal(isCloudGatewayTimeoutMessage("HTTP 504 Gateway Timeout"), false);
});
