import test from "node:test";
import assert from "node:assert/strict";
import fsSync from "node:fs";
import path from "node:path";

const workspaceRoot = process.cwd();

function sourceFor(relativePath) {
  return fsSync.readFileSync(path.join(workspaceRoot, relativePath), "utf8");
}

function indexOfRequired(source, pattern) {
  const index = source.search(pattern);
  assert.notEqual(index, -1, `Expected source to contain ${pattern}`);
  return index;
}

test("tool surface runtime owns intent filtering global scope and Unity MCP ordering", () => {
  const runtimeSource = sourceFor("src/lib/orchestrator/loop/toolSurfaceRuntime.ts");

  assert.match(runtimeSource, /export function createAgentLoopToolSurfaceRuntime/);

  const intentFiltering = indexOfRequired(runtimeSource, /filterToolDefinitionsForIntent\(/);
  const globalScope = indexOfRequired(runtimeSource, /filterGlobalChatToolDefinitions\(\{/);
  const unityMcpOrdering = indexOfRequired(runtimeSource, /resolveUnityMcpFirstPhaseTools\(\{/);

  assert.ok(intentFiltering < globalScope);
  assert.ok(globalScope < unityMcpOrdering);
});

test("tool surface runtime owns tool-surface fallback telemetry", () => {
  const runtimeSource = sourceFor("src/lib/orchestrator/loop/toolSurfaceRuntime.ts");

  assert.match(runtimeSource, /global_chat_tool_scope_applied/);
  assert.match(runtimeSource, /unity_mcp_fallback/);
  assert.match(runtimeSource, /activateUnityMcpFallbackState\(/);
});

test("agent loop delegates tool surface details to runtime module", () => {
  const orchestratorSource = sourceFor("src/lib/orchestrator/loop/AgentOrchestrator.ts");

  assert.match(orchestratorSource, /createAgentLoopToolSurfaceRuntime\(\{/);
  assert.doesNotMatch(orchestratorSource, /filterToolDefinitionsForIntent\(/);
  assert.doesNotMatch(orchestratorSource, /filterGlobalChatToolDefinitions\(/);
  assert.doesNotMatch(orchestratorSource, /resolveUnityMcpFirstPhaseTools\(/);
  assert.doesNotMatch(orchestratorSource, /global_chat_tool_scope_applied/);
});
