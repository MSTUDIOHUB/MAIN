import test from "node:test";
import assert from "node:assert/strict";
import fsSync from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

import ts from "typescript";

const require = createRequire(import.meta.url);
const workspaceRoot = process.cwd();
const transpiledModuleCache = new Map();

function loadTranspiledModuleSync(sourcePath) {
  const normalizedPath = path.resolve(sourcePath);
  if (transpiledModuleCache.has(normalizedPath)) {
    return transpiledModuleCache.get(normalizedPath);
  }

  const source = fsSync.readFileSync(normalizedPath, "utf8");
  const localRequire = createRequire(normalizedPath);
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
    fileName: normalizedPath,
  }).outputText;

  const module = { exports: {} };
  transpiledModuleCache.set(normalizedPath, module.exports);

  const runtimeRequire = (specifier) => {
    if (specifier.startsWith(".")) {
      const basePath = path.resolve(path.dirname(normalizedPath), specifier);
      const candidates = [
        basePath,
        `${basePath}.ts`,
        `${basePath}.tsx`,
        path.join(basePath, "index.ts"),
      ];

      for (const candidate of candidates) {
        if (!fsSync.existsSync(candidate)) continue;
        if (candidate.endsWith(".ts") || candidate.endsWith(".tsx")) {
          return loadTranspiledModuleSync(candidate);
        }
      }
    }

    return localRequire(specifier);
  };

  const factory = new Function("exports", "module", "require", transpiled);
  factory(module.exports, module, runtimeRequire);
  transpiledModuleCache.set(normalizedPath, module.exports);
  return module.exports;
}

const {
  shouldRepromptBeforeUnityConsoleFallback,
  shouldTriggerUnityMcpFirstIterationFallback,
  shouldTriggerUnityMcpStrictRetry,
} = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/lib/orchestrator.ts"),
);
const {
  shouldExposeGameEngineMcpServer,
} = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/lib/orchestrator/unityDiagnostics.ts"),
);

test("game engine MCP servers stay out of unrelated workspaces", () => {
  const unityServer = { name: "unityMCP", url: "http://localhost:8080/mcp" };
  const genericServer = { name: "docs", url: "http://localhost:9000/mcp" };
  assert.equal(shouldExposeGameEngineMcpServer({
    server: unityServer,
    gameStudioEngineContext: false,
    unityCommandRequested: false,
  }), false);
  assert.equal(shouldExposeGameEngineMcpServer({
    server: unityServer,
    gameStudioEngineContext: true,
    unityCommandRequested: false,
  }), true);
  assert.equal(shouldExposeGameEngineMcpServer({
    server: genericServer,
    gameStudioEngineContext: false,
    unityCommandRequested: false,
  }), true);
});
const {
  activateUnityMcpFallbackState,
  applyUnityMcpNoToolRecoveryState,
  applyUnityMcpToolResultState,
  createUnityMcpRuntimeState,
  handleUnityMcpNoToolRecovery,
  markUnityMcpToolCallsDetected,
  resolveUnityMcpFirstPhaseTools,
  resolveUnityMcpForcedConsoleResult,
  resolveUnityMcpNoToolRecovery,
} = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/lib/orchestrator/loop/unityMcpRuntime.ts"),
);

function tool(name) {
  return { type: "function", function: { name, description: "", parameters: {} } };
}

test("unity XML console path strict-retries before local fallback", () => {
  assert.equal(
    shouldTriggerUnityMcpStrictRetry({
      toolCallCount: 0,
      replyOptionCount: 0,
      unityMcpFirstPhaseActive: true,
      unityMcpFirstIterationPending: true,
      unityConsoleDiagnosticsRequested: true,
      strictRetryAlreadyIssued: false,
    }),
    true,
  );

  assert.equal(
    shouldTriggerUnityMcpStrictRetry({
      toolCallCount: 0,
      replyOptionCount: 0,
      unityMcpFirstPhaseActive: true,
      unityMcpFirstIterationPending: true,
      unityConsoleDiagnosticsRequested: true,
      strictRetryAlreadyIssued: true,
    }),
    false,
  );
});

test("unity fallback triggers only when no tool call, no reply options, and no strict console retry exists", () => {
  assert.equal(
    shouldTriggerUnityMcpFirstIterationFallback({
      toolCallCount: 0,
      replyOptionCount: 0,
      unityMcpFirstPhaseActive: true,
      unityMcpFirstIterationPending: true,
      unityConsoleDiagnosticsRequested: false,
    }),
    true,
  );

  assert.equal(
    shouldTriggerUnityMcpFirstIterationFallback({
      toolCallCount: 0,
      replyOptionCount: 2,
      unityMcpFirstPhaseActive: true,
      unityMcpFirstIterationPending: true,
      unityConsoleDiagnosticsRequested: false,
    }),
    false,
  );

  assert.equal(
    shouldTriggerUnityMcpFirstIterationFallback({
      toolCallCount: 1,
      replyOptionCount: 0,
      unityMcpFirstPhaseActive: true,
      unityMcpFirstIterationPending: true,
      unityConsoleDiagnosticsRequested: false,
    }),
    false,
  );

  assert.equal(
    shouldTriggerUnityMcpFirstIterationFallback({
      toolCallCount: 0,
      replyOptionCount: 0,
      unityMcpFirstPhaseActive: true,
      unityMcpFirstIterationPending: true,
      unityConsoleDiagnosticsRequested: true,
    }),
    false,
  );
});

test("unity forced console path gives one soft reprompt after valid read-only activity", () => {
  assert.equal(
    shouldRepromptBeforeUnityConsoleFallback({
      readConsoleCalled: false,
      hasSuccessfulReadOnlyActivity: true,
      repromptAlreadyIssued: false,
    }),
    true,
  );

  assert.equal(
    shouldRepromptBeforeUnityConsoleFallback({
      readConsoleCalled: true,
      hasSuccessfulReadOnlyActivity: true,
      repromptAlreadyIssued: false,
    }),
    false,
  );

  assert.equal(
    shouldRepromptBeforeUnityConsoleFallback({
      readConsoleCalled: false,
      hasSuccessfulReadOnlyActivity: false,
      repromptAlreadyIssued: false,
    }),
    false,
  );

  assert.equal(
    shouldRepromptBeforeUnityConsoleFallback({
      readConsoleCalled: false,
      hasSuccessfulReadOnlyActivity: true,
      repromptAlreadyIssued: true,
    }),
    false,
  );
});

test("unity MCP runtime prioritizes forced console and scoped Unity tools", () => {
  const result = resolveUnityMcpFirstPhaseTools({
    tools: [tool("grep_search"), tool("read_console"), tool("set_active_instance"), tool("manage_scene")],
    unityMcpFirstPhaseActive: true,
    unityMcpForceConsoleFirstPending: true,
    unityMcpStrictRetryPending: false,
    effectiveUnityMcpToolNameSet: new Set(["read_console", "set_active_instance", "manage_scene"]),
  });

  assert.equal(result.fallbackReason, null);
  assert.deepEqual(
    result.tools.map((item) => item.function.name),
    ["read_console", "set_active_instance", "manage_scene", "grep_search"],
  );
});

test("unity MCP runtime state centralizes fallback and retry mutations", () => {
  let state = createUnityMcpRuntimeState({
    unityMcpFirstEligible: true,
    unityMcpToolCount: 2,
    unityConsoleDiagnosticsRequested: true,
  });

  assert.equal(state.firstPhaseActive, true);
  assert.equal(state.firstIterationPending, true);
  assert.equal(state.forceConsoleFirstPending, true);
  assert.equal(state.strictRetryIssued, false);

  const strictRetry = resolveUnityMcpNoToolRecovery({
    toolCallCount: 0,
    replyOptionCount: 0,
    unityMcpFirstPhaseActive: state.firstPhaseActive,
    unityMcpFirstIterationPending: state.firstIterationPending,
    unityMcpStrictRetryPending: state.strictRetryPending,
    unityMcpStrictRetryIssued: state.strictRetryIssued,
    unityConsoleDiagnosticsRequested: true,
    forceXmlTools: true,
    language: "en",
  });
  state = applyUnityMcpNoToolRecoveryState(state, strictRetry);

  assert.equal(state.firstIterationPending, false);
  assert.equal(state.strictRetryPending, true);
  assert.equal(state.strictRetryIssued, true);

  state = markUnityMcpToolCallsDetected(state);
  assert.equal(state.firstIterationPending, false);
  assert.equal(state.strictRetryPending, false);

  state = applyUnityMcpToolResultState(state, {
    unityConsoleFinalVerificationRequired: true,
    unityConsoleRefreshObservedAfterWrite: false,
    unityMcpForceConsoleFirstPending: true,
    unityConsoleMissingFirstToolRepromptIssued: true,
  });
  assert.equal(state.consoleFinalVerificationRequired, true);
  assert.equal(state.forceConsoleFirstPending, true);
  assert.equal(state.consoleMissingFirstToolRepromptIssued, true);

  const fallback = activateUnityMcpFallbackState(state, "strict_retry_no_tool_call");
  assert.equal(fallback.didActivate, true);
  assert.equal(fallback.state.firstPhaseActive, false);
  assert.equal(fallback.state.forceConsoleFirstPending, false);
  assert.equal(fallback.state.strictRetryPending, false);
  assert.equal(fallback.state.fallbackReason, "strict_retry_no_tool_call");

  const duplicateFallback = activateUnityMcpFallbackState(fallback.state, "late_reason");
  assert.equal(duplicateFallback.didActivate, false);
  assert.equal(duplicateFallback.state.fallbackReason, "strict_retry_no_tool_call");
});

test("unity MCP no-tool handler owns retry side effects and fallback activation", () => {
  const messages = [];
  const statuses = [];
  const fallbackReasons = [];
  const callbacks = {
    getPreferredLanguage: () => "en",
    onStatusChange: (status) => statuses.push(status),
    appendMessage: (message) => messages.push(message),
  };
  let state = createUnityMcpRuntimeState({
    unityMcpFirstEligible: true,
    unityMcpToolCount: 2,
    unityConsoleDiagnosticsRequested: true,
  });

  const strictRetry = handleUnityMcpNoToolRecovery({
    callbacks,
    state,
    iteration: 1,
    toolCallCount: 0,
    replyOptionCount: 0,
    unityConsoleDiagnosticsRequested: true,
    forceXmlTools: true,
    activateUnityMcpFallback: (reason) => fallbackReasons.push(reason),
  });
  state = strictRetry.state;

  assert.equal(strictRetry.status, "continue");
  assert.equal(state.firstIterationPending, false);
  assert.equal(state.strictRetryPending, true);
  assert.equal(state.strictRetryIssued, true);
  assert.deepEqual(fallbackReasons, []);
  assert.deepEqual(statuses, ["running"]);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].role, "user");
  assert.match(messages[0].content, /exactly one standard XML/);

  const fallback = handleUnityMcpNoToolRecovery({
    callbacks,
    state,
    iteration: 2,
    toolCallCount: 0,
    replyOptionCount: 0,
    unityConsoleDiagnosticsRequested: true,
    forceXmlTools: true,
    activateUnityMcpFallback: (reason) => fallbackReasons.push(reason),
  });

  assert.equal(fallback.status, "continue");
  assert.equal(fallback.state.strictRetryPending, false);
  assert.deepEqual(fallbackReasons, ["strict_retry_no_tool_call"]);
  assert.deepEqual(statuses, ["running", "running"]);
  assert.equal(messages.length, 2);
  assert.match(messages[1].content, /auto-fallbacked to local diagnostics/);
});

test("unity MCP runtime falls back when forced console tool is not exposed", () => {
  const result = resolveUnityMcpFirstPhaseTools({
    tools: [tool("grep_search"), tool("set_active_instance")],
    unityMcpFirstPhaseActive: true,
    unityMcpForceConsoleFirstPending: true,
    unityMcpStrictRetryPending: false,
    effectiveUnityMcpToolNameSet: new Set(["read_console", "set_active_instance"]),
  });

  assert.equal(result.fallbackReason, "missing_required_console_tool");
  assert.deepEqual(
    result.tools.map((item) => item.function.name),
    ["grep_search", "set_active_instance"],
  );
});

test("unity forced console result resolves soft reprompt and fallback prompts", () => {
  const reprompt = resolveUnityMcpForcedConsoleResult({
    results: [{ name: "set_active_instance", isError: false, content: "", target: "", toolCallId: "call_1" }],
    unityMcpForceConsoleFirstPending: true,
    unityConsoleMissingFirstToolRepromptIssued: false,
    language: "en",
  });

  assert.equal(reprompt.unityMcpForceConsoleFirstPending, true);
  assert.equal(reprompt.unityConsoleMissingFirstToolRepromptIssued, true);
  assert.equal(reprompt.fallbackReason, null);
  assert.match(reprompt.prompt, /requires `read_console`/);

  const fallback = resolveUnityMcpForcedConsoleResult({
    results: [{ name: "read_console", isError: true, content: "MCP_CALL_FAILURE[unreachable]", target: "", toolCallId: "call_2" }],
    unityMcpForceConsoleFirstPending: true,
    unityConsoleMissingFirstToolRepromptIssued: true,
    language: "zh",
  });

  assert.equal(fallback.unityMcpForceConsoleFirstPending, false);
  assert.equal(fallback.unityConsoleMissingFirstToolRepromptIssued, true);
  assert.equal(fallback.fallbackReason, "forced_console_call_failed:unreachable");
  assert.match(fallback.prompt, /Unity MCP 首轮 read_console 调用失败/);
});

test("unity no-tool recovery chooses strict retry before local fallback", () => {
  const strictRetry = resolveUnityMcpNoToolRecovery({
    toolCallCount: 0,
    replyOptionCount: 0,
    unityMcpFirstPhaseActive: true,
    unityMcpFirstIterationPending: true,
    unityMcpStrictRetryPending: false,
    unityMcpStrictRetryIssued: false,
    unityConsoleDiagnosticsRequested: true,
    forceXmlTools: true,
    language: "en",
  });

  assert.equal(strictRetry.status, "continue");
  assert.equal(strictRetry.reason, "first_iteration_no_tool_call");
  assert.equal(strictRetry.fallbackReason, null);
  assert.equal(strictRetry.unityMcpFirstIterationPending, false);
  assert.equal(strictRetry.unityMcpStrictRetryPending, true);
  assert.equal(strictRetry.unityMcpStrictRetryIssued, true);
  assert.equal(strictRetry.logStrictRetry, true);
  assert.match(strictRetry.prompt, /exactly one standard XML/);

  const fallback = resolveUnityMcpNoToolRecovery({
    toolCallCount: 0,
    replyOptionCount: 0,
    unityMcpFirstPhaseActive: true,
    unityMcpFirstIterationPending: true,
    unityMcpStrictRetryPending: false,
    unityMcpStrictRetryIssued: false,
    unityConsoleDiagnosticsRequested: false,
    forceXmlTools: true,
    language: "zh",
  });

  assert.equal(fallback.status, "continue");
  assert.equal(fallback.fallbackReason, "first_iteration_no_tool_call");
  assert.equal(fallback.unityMcpFirstIterationPending, false);
  assert.equal(fallback.unityMcpStrictRetryPending, false);
  assert.match(fallback.prompt, /Unity MCP 首轮没有触发工具调用/);
});
