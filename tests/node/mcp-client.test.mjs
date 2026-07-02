import test from "node:test";
import assert from "node:assert/strict";
import fsSync from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

import ts from "typescript";

const workspaceRoot = process.cwd();
const transpiledModuleCache = new Map();

function loadTranspiledModuleSync(sourcePath) {
  const normalizedPath = path.resolve(sourcePath);
  if (transpiledModuleCache.has(normalizedPath)) {
    return transpiledModuleCache.get(normalizedPath);
  }

  const source = fsSync.readFileSync(normalizedPath, "utf8");
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
    fileName: normalizedPath,
  }).outputText;

  const module = { exports: {} };
  transpiledModuleCache.set(normalizedPath, module.exports);
  const localRequire = createRequire(normalizedPath);
  const factory = new Function("exports", "module", "require", transpiled);
  factory(module.exports, module, localRequire);
  transpiledModuleCache.set(normalizedPath, module.exports);
  return module.exports;
}

const {
  __clearMcpDiscoveryFailureCacheForTests,
  __setMcpInvokeForTests,
  discoverAllMcpTools,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/mcpClient.ts"));

test("discoverAllMcpTools caches unreachable discovery failures and force refresh bypasses cache", async () => {
  __clearMcpDiscoveryFailureCacheForTests();

  let proxyCalls = 0;
  __setMcpInvokeForTests(async () => {
    proxyCalls += 1;
    throw new Error("connect ECONNREFUSED 127.0.0.1:8080");
  });

  const servers = [
    { name: "unityMCP", type: "http", url: "http://localhost:8080/mcp", enabled: true },
  ];

  const first = await discoverAllMcpTools(servers, {
    nowMs: 1_000,
    failureBackoffMs: 60_000,
  });
  assert.equal(proxyCalls, 1);
  assert.equal(first.serverStatuses[0].status, "failed");
  assert.equal(first.serverStatuses[0].category, "unreachable");
  assert.notEqual(first.serverStatuses[0].cached, true);

  const second = await discoverAllMcpTools(servers, {
    nowMs: 2_000,
    failureBackoffMs: 60_000,
  });
  assert.equal(proxyCalls, 1);
  assert.equal(second.serverStatuses[0].status, "failed");
  assert.equal(second.serverStatuses[0].category, "unreachable");
  assert.equal(second.serverStatuses[0].cached, true);

  const forced = await discoverAllMcpTools(servers, {
    nowMs: 3_000,
    failureBackoffMs: 60_000,
    forceRefresh: true,
  });
  assert.equal(proxyCalls, 2);
  assert.equal(forced.serverStatuses[0].status, "failed");
  assert.equal(forced.serverStatuses[0].category, "unreachable");
  assert.notEqual(forced.serverStatuses[0].cached, true);

  __clearMcpDiscoveryFailureCacheForTests();
  __setMcpInvokeForTests(null);
});
