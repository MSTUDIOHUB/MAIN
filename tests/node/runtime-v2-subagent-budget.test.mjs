import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";

const workspaceRoot = process.cwd();

function loadTsWithMocks(sourcePath, mocks, cache = new Map()) {
  const normalized = path.resolve(sourcePath);
  if (cache.has(normalized)) return cache.get(normalized);
  const source = fs.readFileSync(normalized, "utf8");
  const localRequire = createRequire(normalized);
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
    fileName: normalized,
  }).outputText;
  const module = { exports: {} };
  cache.set(normalized, module.exports);
  const runtimeRequire = (specifier) => {
    if (mocks.has(specifier)) return mocks.get(specifier);
    if (specifier.startsWith(".")) {
      const base = path.resolve(path.dirname(normalized), specifier);
      for (const candidate of [
        base,
        `${base}.ts`,
        path.join(base, "index.ts"),
      ]) {
        if (fs.existsSync(candidate) && candidate.endsWith(".ts")) {
          return loadTsWithMocks(candidate, mocks, cache);
        }
      }
    }
    return localRequire(specifier);
  };
  new Function("exports", "module", "require", output)(
    module.exports,
    module,
    runtimeRequire,
  );
  cache.set(normalized, module.exports);
  return module.exports;
}

test("a reasoning-heavy child retains the Run budget through tool use and evidence reporting", async () => {
  const runtime = loadTsWithMocks(
    path.join(workspaceRoot, "src/lib/runtime-v2/index.ts"),
    new Map(),
  );
  const requestedOutputBudgets = [];
  let firstChunkMarks = 0;
  let providerRound = 0;
  const reasoningTokensBeforeAction = 10_000;
  const minimumActionAndReportTokens = 1_024;
  const streamChatCompletion = async (
    _messages,
    _settings,
    callbacks,
    _signal,
    _tools,
    maxOutputTokens,
  ) => {
    providerRound += 1;
    requestedOutputBudgets.push(maxOutputTokens);
    callbacks.onLifecycle?.({
      phase: "first_chunk",
      chunkCount: 1,
      byteCount: 1,
    });
    if (
      maxOutputTokens <
        reasoningTokensBeforeAction + minimumActionAndReportTokens
    ) {
      return {
        content: "",
        semanticContent: "",
        actionableContent: "",
        reasoningContent: "reasoning stopped before the action",
        toolCalls: [],
        finishReason: "length",
        usage: { completion_tokens: maxOutputTokens },
        protocolViolation: null,
      };
    }
    if (providerRound === 1) {
      return {
        content: "",
        semanticContent: "",
        actionableContent: "",
        reasoningContent: "reasoning completed before the source read",
        toolCalls: [{
          index: 0,
          id: "qwen-read",
          name: "read_file",
          arguments: JSON.stringify({ path: "src/main.js" }),
        }],
        finishReason: "tool_calls",
        usage: {
          completion_tokens:
            reasoningTokensBeforeAction + minimumActionAndReportTokens,
        },
        protocolViolation: null,
      };
    }
    return {
      content:
        "The save path is confirmed by child:child-qwen:E1.",
      semanticContent:
        "The save path is confirmed by child:child-qwen:E1.",
      actionableContent:
        "The save path is confirmed by child:child-qwen:E1.",
      reasoningContent: "reasoning completed before the evidence report",
      toolCalls: [],
      finishReason: "stop",
      usage: {
        completion_tokens:
          reasoningTokensBeforeAction + minimumActionAndReportTokens,
      },
      protocolViolation: null,
    };
  };
  const mocks = new Map([
    ["../../lib/providerLaneSettings", {
      deriveBudgetedStreamSettings: () => ({}),
    }],
    ["../../lib/runtimeContextBudget", {
      boundRuntimeMessagesToContext: (messages) => [...messages],
    }],
    ["../../lib/modelLaneCoordinator", {
      acquireModelLane: async () => ({
        markFirstToken() { firstChunkMarks += 1; },
        reportFailure() {},
        release() {},
        setPressureHandler() {},
      }),
    }],
    ["../../lib/sanitize", {
      sanitizeAssistantDisplayContent: (value) => String(value || ""),
    }],
    ["../../lib/streaming", { streamChatCompletion }],
    ["../../lib/toolSchemas", {
      TOOL_DEFINITIONS: [{
        type: "function",
        function: {
          name: "read_file",
          description: "Read one source file.",
          parameters: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
          },
        },
      }],
    }],
    ["../../lib/toolExecutor", {
      executeTool: async () => "export const saveReady = true;",
    }],
    ["../../lib/toolTarget", {
      getToolTarget: (_name, args) => String(args.path || ""),
    }],
    ["../../lib/runtime-v2", runtime],
    ["../../lib/validationContract", {
      analyzeValidationCommand: () => ({ spec: null }),
    }],
    ["./executionContext", {
      authorizationFor: () => ({ toolCatalog: {} }),
      authorizeToolForCurrentTurn: async () => ({ allowed: true }),
      baseProviderProfile: () => ({
        schemaVersion: "provider-lane.v1",
        nativeTools: true,
        requiredToolChoice: true,
        streaming: true,
        textToolEnvelope: true,
        reasoning: true,
        imageInput: false,
        toolResultRole: "tool",
      }),
      boundedRuntimeV2ToolContent: (_name, value) => String(value),
      childScopeAllows: () => true,
      compactTextEnvelopeCatalog: () => "",
      containsProviderTextEnvelopePrompt: () => "",
      runtimeV2ContextBoundToolArguments: (_name, args) => args,
      runtimeV2ParallelReadCount: (calls) => calls.length,
    }],
    ["./executionAggregate", {
      aggregateForCurrentTurn: () => null,
    }],
    ["./executionEvidence", {
      isRuntimeV2ValidationPassed: () => true,
      runtimeV2ValidationEvidenceVersion: () => "validation-version",
    }],
    ["./executionSubagentContext", {
      buildRuntimeV2SubagentContextCapsule: () => "",
    }],
    ["./providerToolSurface", {
      boundRuntimeV2ProviderToolCalls: (calls) => ({
        accepted: [...calls],
        discarded: [],
        selection: calls.length > 0 ? "first" : "empty",
      }),
      completedRuntimeV2ProviderToolCallIdentities: () => new Set(),
      scopeRuntimeV2ProviderToolCallIds: (calls, allocateId) =>
        calls.map((call) => ({ ...call, id: allocateId() })),
    }],
  ]);
  const runner = loadTsWithMocks(
    path.join(
      workspaceRoot,
      "src/store/runtimeV2/executionSubagentRunner.ts",
    ),
    mocks,
  );
  let nextId = 0;
  const live = {
    childAbortControllers: new Map(),
    childTelemetry: new Map([[
      "child-qwen",
      { firstTokenAt: null, closedAt: null },
    ]]),
    provenStructuredToolTransports: new Set(),
  };
  const result = await runner.startRuntimeV2ReadOnlyChild({
    get: () => ({ config: {} }),
    context: {
      phaseLanguage: "en",
      runWorkspace: "/fixture",
      runSessionKey: "session",
      runtimeContextBudget: {
        contextLimit: 32_768,
        outputBudget: 16_384,
        inputBudget: 16_384,
        readWindowChars: 18_000,
        source: "configured",
        providerContextLimit: null,
        providerOutputLimit: null,
        preserveAssistantReasoning: true,
        availableMemoryBytes: null,
      },
      workspaceInstructionContext: "",
    },
    live,
    nextId: () => `child-call-${++nextId}`,
    now: () => Date.now(),
    lifecycleDeadlineAt: Date.now() + 30_000,
    logStoreEvent() {},
  }, {
    id: "child-qwen",
    run: {
      sessionKey: "session",
      sessionEpoch: "epoch",
      turnId: "turn",
      runId: "child-run",
      parentRunId: "parent-run",
      attemptId: "attempt",
    },
    parentRunId: "parent-run",
    scopeKey: "src/main.js",
    taskKind: "explore",
    name: "Save path reviewer",
    role: "reviewer",
    objective: "Confirm the save path.",
    successCriteria: "Return cited source evidence.",
    expectedOutput: "One cited finding.",
    allowedPaths: ["src/main.js"],
    status: "running",
    requestedAt: Date.now(),
    firstTokenAt: null,
    closedAt: null,
    summary: null,
  }, new AbortController().signal);

  assert.equal(result.status, "completed");
  assert.equal(result.evidence.length, 1);
  assert.deepEqual(
    result.report?.findings[0]?.evidenceIds,
    ["child:child-qwen:E1"],
  );
  assert.deepEqual(requestedOutputBudgets, [16_384, 16_384]);
  assert.equal(firstChunkMarks, 2);
  assert.ok(
    requestedOutputBudgets.every((budget) =>
      budget > reasoningTokensBeforeAction + minimumActionAndReportTokens
    ),
  );
});
