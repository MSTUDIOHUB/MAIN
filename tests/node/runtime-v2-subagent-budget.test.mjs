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

function fixtureChildReportTool(evidenceIds) {
  return {
    type: "function",
    function: {
      name: "submit_runtime_v2_subagent_report",
      description: "Submit the evidence-linked child report.",
      parameters: {
        type: "object",
        properties: {
          summary: { type: "string" },
          findings: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              properties: {
                statement: { type: "string" },
                evidence_ids: {
                  type: "array",
                  minItems: 1,
                  items: { type: "string", enum: [...evidenceIds] },
                },
              },
              required: ["statement", "evidence_ids"],
            },
          },
          unresolved: { type: "array", items: { type: "string" } },
        },
        required: ["summary", "findings", "unresolved"],
      },
    },
  };
}

test("a child step is bounded to the parent request ceiling and still reports cited evidence", async () => {
  const runtime = loadTsWithMocks(
    path.join(workspaceRoot, "src/lib/runtime-v2/index.ts"),
    new Map(),
  );
  const requestedOutputBudgets = [];
  let modelProgressMarks = 0;
  let providerRound = 0;
  let reportedEvidenceId = "";
  const reasoningTokensBeforeAction = 6_000;
  const minimumActionAndReportTokens = 1_024;
  const streamChatCompletion = async (
    messages,
    _settings,
    callbacks,
    _signal,
    _tools,
    maxOutputTokens,
  ) => {
    providerRound += 1;
    requestedOutputBudgets.push(maxOutputTokens);
    callbacks.onLifecycle?.({
      phase: "model_progress",
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
    reportedEvidenceId = messages
      .map((message) => String(message.content || ""))
      .join("\n")
      .match(/child:[^\s,]+:E1/)?.[0] || "";
    assert.match(reportedEvidenceId, /^child:[0-9a-f]{32}:E1$/);
    return {
      content:
        `The save path is confirmed by ${reportedEvidenceId}.`,
      semanticContent:
        `The save path is confirmed by ${reportedEvidenceId}.`,
      actionableContent:
        `The save path is confirmed by ${reportedEvidenceId}.`,
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
        markFirstToken() { modelProgressMarks += 1; },
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
      runtimeV2SubagentInheritedSourceTargets: () => [],
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
    [reportedEvidenceId],
  );
  assert.deepEqual(requestedOutputBudgets, [8_192, 8_192]);
  assert.equal(modelProgressMarks, 2);
  assert.ok(
    requestedOutputBudgets.every((budget) =>
      budget > reasoningTokensBeforeAction + minimumActionAndReportTokens
    ),
  );
});

test("child evidence ids bind the complete child Run identity", () => {
  const runtime = loadTsWithMocks(
    path.join(workspaceRoot, "src/lib/runtime-v2/index.ts"),
    new Map(),
  );
  const job = {
    id: "scope:shared-millisecond:1",
    run: {
      sessionKey: "session",
      sessionEpoch: "epoch",
      turnId: "turn-a",
      runId: "child-run-a",
      parentRunId: "parent-run-a",
      attemptId: "attempt",
    },
    parentRunId: "parent-run-a",
  };
  const first = runtime.runtimeV2ChildEvidenceId(job, 1);
  assert.match(first, /^child:[0-9a-f]{32}:E1$/);
  assert.equal(runtime.runtimeV2ChildEvidenceId(structuredClone(job), 1), first);
  assert.notEqual(
    runtime.runtimeV2ChildEvidenceId({
      ...job,
      run: {
        ...job.run,
        turnId: "turn-b",
        runId: "child-run-b",
        parentRunId: "parent-run-b",
      },
      parentRunId: "parent-run-b",
    }, 1),
    first,
  );
  assert.throws(
    () => runtime.runtimeV2ChildEvidenceId(job, 0),
    /CHILD_EVIDENCE_ORDINAL_INVALID/,
  );
});

test("a child report repair exposes one required effect-free report tool", async () => {
  const runtime = loadTsWithMocks(
    path.join(workspaceRoot, "src/lib/runtime-v2/index.ts"),
    new Map(),
  );
  const evidenceId =
    "child:0123456789abcdef0123456789abcdef:E1";
  const reportTool = fixtureChildReportTool([evidenceId]);
  let wireMessages = [];
  let wireTools = null;
  let wireOptions = null;
  let wireMaxOutputTokens = null;
  const logs = [];
  const provenStructuredToolTransports = new Set();
  const provider = loadTsWithMocks(
    path.join(
      workspaceRoot,
      "src/store/runtimeV2/executionSubagentProvider.ts",
    ),
    new Map([
      ["../../lib/modelLaneCoordinator", {
        acquireModelLane: async () => ({
          markFirstToken() {},
          reportFailure() {},
          setPressureHandler() {},
          release() {},
        }),
      }],
      ["../../lib/providerLaneSettings", {
        deriveBudgetedStreamSettings: () => ({}),
      }],
      ["../../lib/runtimeContextBudget", {
        boundRuntimeMessagesToContext: (messages) => [...messages],
      }],
      ["../../lib/sanitize", {
        sanitizeAssistantDisplayContent: (value) => String(value || ""),
      }],
      ["../../lib/streaming", {
        streamChatCompletion: async (
          messages,
          _settings,
          callbacks,
          _signal,
          tools,
          maxOutputTokens,
          options,
        ) => {
          wireMessages = [...messages];
          wireTools = [...tools];
          wireOptions = { ...options };
          wireMaxOutputTokens = maxOutputTokens;
          callbacks.onLifecycle?.({ phase: "first_chunk" });
          const reportArguments = {
            summary: "The retained source evidence supports the finding.",
            findings: [{
              statement: "The source has a bounded test seam.",
              evidence_ids: [evidenceId],
            }],
            unresolved: [],
          };
          return {
            content: JSON.stringify(reportArguments),
            semanticContent: JSON.stringify(reportArguments),
            actionableContent: JSON.stringify(reportArguments),
            toolCalls: [],
            usage: {},
            protocolViolation: null,
          };
        },
      }],
      ["../../lib/runtime-v2", runtime],
      ["./executionContext", {
        baseProviderProfile: () => ({
          schemaVersion: "provider-lane.v1",
          nativeTools: true,
          requiredToolChoice: false,
          streaming: true,
          textToolEnvelope: true,
          reasoning: true,
          imageInput: false,
          toolResultRole: "tool",
        }),
        compactTextEnvelopeCatalog: () => "TEXT_ENVELOPE_CATALOG_MARKER",
        containsProviderTextEnvelopePrompt: () => "TEXT_ENVELOPE_PROMPT_MARKER",
      }],
      ["./executionSubagentPolicy", {
        normalizeRuntimeV2ChildToolCalls: (calls) => calls,
        runtimeV2ChildOutputTokenLimit: () => 8_192,
      }],
      ["./providerToolSurface", {
        scopeRuntimeV2ProviderToolCallIds: (calls) => calls,
      }],
    ]),
  );
  const startedAt = Date.now();
  const result = await provider.requestRuntimeV2ChildStep({
    job: {
      id: "child-report-repair",
      run: {
        sessionKey: "session",
        sessionEpoch: "epoch",
        turnId: "turn",
        runId: "child-run",
        parentRunId: "parent-run",
        attemptId: "attempt",
      },
      parentRunId: "parent-run",
      scopeKey: "report",
      taskKind: "review",
      accessMode: "read",
      objective: "Conclude from retained evidence.",
      allowedPaths: ["snake.py"],
      status: "running",
      requestedAt: startedAt,
      firstTokenAt: null,
      closedAt: null,
      summary: null,
    },
    ports: {
      get: () => ({ config: {} }),
      context: {
        phaseLanguage: "en",
        runWorkspace: "/fixture",
        runSessionKey: "session",
        workspaceInstructionContext: "",
      },
      live: {
        childTelemetry: new Map(),
        provenStructuredToolTransports,
      },
      nextId: () => "child-call",
      now: Date.now,
      logStoreEvent: (eventName, data) => logs.push({ eventName, data }),
    },
    messages: [{
      role: "system",
      content:
        `CHILD_REPORT_REJECTED. Available exact evidence IDs: ${evidenceId}.`,
    }],
    tools: [reportTool],
    responseMode: "report_required",
    signal: new AbortController().signal,
    deadlineAt: startedAt + 2_000,
    recoveryOccurrence: 1,
  });

  assert.deepEqual(
    result.toolCalls.map((call) => call.name),
    ["submit_runtime_v2_subagent_report"],
  );
  assert.deepEqual(
    wireTools.map((tool) => tool.function.name),
    ["submit_runtime_v2_subagent_report"],
  );
  assert.deepEqual(
    wireTools[0].function.parameters.properties.findings.items.properties
      .evidence_ids.items.enum,
    [evidenceId],
  );
  assert.equal(wireOptions.toolChoice, "required");
  assert.equal(wireMaxOutputTokens, 4_096);
  const transcript = wireMessages
    .map((message) => String(message.content || ""))
    .join("\n");
  assert.doesNotMatch(transcript, /CHILD_RECOVERY_PIVOT/);
  assert.doesNotMatch(transcript, /TEXT_ENVELOPE_(?:PROMPT|CATALOG)_MARKER/);
  assert.equal(
    logs.find((entry) =>
      entry.eventName === "runtime_v2_subagent_provider_result"
    )?.data?.transport,
    "native_required",
  );
  assert.deepEqual(
    [...provenStructuredToolTransports],
    [],
    "schema-valid JSON adapted through requiredSingleTool is not raw native tool-call proof",
  );
});

test("the child report text-envelope catalog preserves the exact nested evidence enum", () => {
  const firstEvidenceId =
    "child:0123456789abcdef0123456789abcdef:E1";
  const secondEvidenceId =
    "child:0123456789abcdef0123456789abcdef:E2";
  const recovery = loadTsWithMocks(
    path.join(
      workspaceRoot,
      "src/store/runtimeV2/executionSubagentReportRecovery.ts",
    ),
    new Map(),
  );
  const reportTool = recovery.runtimeV2ChildReportTool({
    evidence: [{
      id: firstEvidenceId,
      kind: "subagent",
      target: "snake.py",
      version: "source-a",
    }],
    inheritedEvidence: [{
      id: firstEvidenceId,
      kind: "subagent",
      target: "snake.py",
      version: "source-a",
    }, {
      id: secondEvidenceId,
      kind: "subagent",
      target: "README.md",
      version: "source-b",
    }],
  });
  assert.ok(reportTool);
  assert.deepEqual(
    reportTool.function.parameters.properties.findings.items.properties
      .evidence_ids.items.enum,
    [firstEvidenceId, secondEvidenceId],
  );
  assert.equal(
    recovery.runtimeV2ChildReportTool({
      evidence: [],
      inheritedEvidence: [],
    }),
    null,
  );

  const schema = loadTsWithMocks(
    path.join(
      workspaceRoot,
      "src/store/runtimeV2/executionProviderToolSchema.ts",
    ),
    new Map(),
  );
  const catalog = schema.buildRuntimeV2TextEnvelopeCatalog([reportTool]);
  const entries = JSON.parse(catalog.split("\n").slice(1).join("\n"));
  assert.deepEqual(
    entries[0].properties.findings.items.properties.evidence_ids.items.enum,
    [firstEvidenceId, secondEvidenceId],
  );
  assert.equal(entries[0].properties.findings.minItems, 1);
  assert.deepEqual(
    entries[0].properties.findings.items.required,
    ["statement", "evidence_ids"],
  );
});

test("a missing native child report falls back to a required text envelope", async () => {
  const runtime = loadTsWithMocks(
    path.join(workspaceRoot, "src/lib/runtime-v2/index.ts"),
    new Map(),
  );
  const evidenceId =
    "child:0123456789abcdef0123456789abcdef:E1";
  const reportTool = fixtureChildReportTool([evidenceId]);
  const attempts = [];
  const logs = [];
  const provider = loadTsWithMocks(
    path.join(
      workspaceRoot,
      "src/store/runtimeV2/executionSubagentProvider.ts",
    ),
    new Map([
      ["../../lib/modelLaneCoordinator", {
        acquireModelLane: async () => ({
          markFirstToken() {},
          reportFailure() {},
          setPressureHandler() {},
          release() {},
        }),
      }],
      ["../../lib/providerLaneSettings", {
        deriveBudgetedStreamSettings: () => ({}),
      }],
      ["../../lib/runtimeContextBudget", {
        boundRuntimeMessagesToContext: (messages) => [...messages],
      }],
      ["../../lib/sanitize", {
        sanitizeAssistantDisplayContent: (value) => String(value || ""),
      }],
      ["../../lib/streaming", {
        streamChatCompletion: async (
          messages,
          _settings,
          callbacks,
          _signal,
          tools,
          _maxOutputTokens,
          options,
        ) => {
          attempts.push({
            messages: [...messages],
            tools: [...tools],
            options: { ...options },
          });
          callbacks.onLifecycle?.({ phase: "first_chunk" });
          if (tools.length > 0) {
            return {
              content: "I have enough evidence to report.",
              semanticContent: "I have enough evidence to report.",
              actionableContent: "I have enough evidence to report.",
              toolCalls: [],
              usage: {},
              protocolViolation: null,
            };
          }
          const envelope = [
            "<runtime-v2-tools>",
            JSON.stringify({
              toolCalls: [{
                id: "report-envelope-call",
                name: "submit_runtime_v2_subagent_report",
                arguments: {
                  summary: "The retained source supports the finding.",
                  findings: [{
                    statement: "The source has a bounded test seam.",
                    evidence_ids: [evidenceId],
                  }],
                  unresolved: [],
                },
              }],
            }),
            "</runtime-v2-tools>",
          ].join("");
          return {
            content: envelope,
            semanticContent: envelope,
            actionableContent: envelope,
            toolCalls: [],
            usage: {},
            protocolViolation: null,
          };
        },
      }],
      ["../../lib/runtime-v2", runtime],
      ["./executionContext", {
        baseProviderProfile: () => ({
          schemaVersion: "provider-lane.v1",
          nativeTools: true,
          requiredToolChoice: false,
          streaming: true,
          textToolEnvelope: true,
          reasoning: true,
          imageInput: false,
          toolResultRole: "tool",
        }),
        compactTextEnvelopeCatalog: () =>
          "TEXT_ENVELOPE_CATALOG_WITH_NESTED_EVIDENCE_ENUM",
        containsProviderTextEnvelopePrompt: (_language, required) =>
          required
            ? "TEXT_ENVELOPE_REQUIRED_PROMPT"
            : "TEXT_ENVELOPE_OPTIONAL_PROMPT",
      }],
      ["./executionSubagentPolicy", {
        normalizeRuntimeV2ChildToolCalls: (calls) => calls,
        runtimeV2ChildOutputTokenLimit: () => 4_096,
      }],
      ["./providerToolSurface", {
        scopeRuntimeV2ProviderToolCallIds: (calls) => calls,
      }],
    ]),
  );
  const startedAt = Date.now();
  const result = await provider.requestRuntimeV2ChildStep({
    job: {
      id: "child-report-fallback",
      run: {
        sessionKey: "session",
        sessionEpoch: "epoch",
        turnId: "turn",
        runId: "child-run",
        parentRunId: "parent-run",
        attemptId: "attempt",
      },
      parentRunId: "parent-run",
      scopeKey: "report",
      taskKind: "review",
      accessMode: "read",
      objective: "Submit the retained report.",
      allowedPaths: ["snake.py"],
      status: "running",
      requestedAt: startedAt,
      firstTokenAt: null,
      closedAt: null,
      summary: null,
    },
    ports: {
      get: () => ({ config: {} }),
      context: {
        phaseLanguage: "en",
        runWorkspace: "/fixture",
        runSessionKey: "session",
        workspaceInstructionContext: "",
      },
      live: {
        childTelemetry: new Map(),
        provenStructuredToolTransports: new Set(),
      },
      nextId: () => "child-call",
      now: Date.now,
      logStoreEvent: (eventName, data) => logs.push({ eventName, data }),
    },
    messages: [{
      role: "system",
      content: `CHILD_REPORT_REJECTED. Available exact evidence IDs: ${evidenceId}.`,
    }],
    tools: [reportTool],
    responseMode: "report_required",
    signal: new AbortController().signal,
    deadlineAt: startedAt + 5_000,
    recoveryOccurrence: 1,
  });

  assert.equal(attempts.length, 2);
  assert.deepEqual(
    attempts[0].tools.map((tool) => tool.function.name),
    ["submit_runtime_v2_subagent_report"],
  );
  assert.equal(attempts[0].options.toolChoice, "required");
  assert.deepEqual(attempts[1].tools, []);
  assert.equal("toolChoice" in attempts[1].options, false);
  const fallbackTranscript = attempts[1].messages
    .map((message) => String(message.content || ""))
    .join("\n");
  assert.match(fallbackTranscript, /TEXT_ENVELOPE_REQUIRED_PROMPT/);
  assert.doesNotMatch(fallbackTranscript, /TEXT_ENVELOPE_OPTIONAL_PROMPT/);
  assert.match(
    fallbackTranscript,
    /TEXT_ENVELOPE_CATALOG_WITH_NESTED_EVIDENCE_ENUM/,
  );
  assert.deepEqual(
    result.toolCalls.map((call) => call.name),
    ["submit_runtime_v2_subagent_report"],
  );
  assert.equal(
    logs.find((entry) =>
      entry.eventName === "runtime_v2_subagent_protocol_drift"
    )?.data?.transportFallbackAllowed,
    true,
  );
  assert.equal(
    logs.find((entry) =>
      entry.eventName === "runtime_v2_subagent_provider_result"
    )?.data?.transport,
    "text_envelope",
  );
});

test("a required tool_choice compatibility rejection falls directly back to the text envelope", async () => {
  const runtime = loadTsWithMocks(
    path.join(workspaceRoot, "src/lib/runtime-v2/index.ts"),
    new Map(),
  );
  const evidenceId =
    "child:0123456789abcdef0123456789abcdef:E1";
  const reportTool = fixtureChildReportTool([evidenceId]);
  const attempts = [];
  const logs = [];
  const provider = loadTsWithMocks(
    path.join(
      workspaceRoot,
      "src/store/runtimeV2/executionSubagentProvider.ts",
    ),
    new Map([
      ["../../lib/modelLaneCoordinator", {
        acquireModelLane: async () => ({
          markFirstToken() {},
          reportFailure() {},
          setPressureHandler() {},
          release() {},
        }),
      }],
      ["../../lib/providerLaneSettings", {
        deriveBudgetedStreamSettings: () => ({}),
      }],
      ["../../lib/runtimeContextBudget", {
        boundRuntimeMessagesToContext: (messages) => [...messages],
      }],
      ["../../lib/sanitize", {
        sanitizeAssistantDisplayContent: (value) => String(value || ""),
      }],
      ["../../lib/streaming", {
        streamChatCompletion: async (
          messages,
          _settings,
          callbacks,
          _signal,
          tools,
          _maxOutputTokens,
          options,
        ) => {
          attempts.push({
            messages: [...messages],
            tools: [...tools],
            options: { ...options },
          });
          callbacks.onLifecycle?.({ phase: "first_chunk" });
          if (tools.length > 0) {
            throw new Error(
              "HTTP 400: invalid tool_choice 'required'; only supports auto",
            );
          }
          const envelope = [
            "<runtime-v2-tools>",
            JSON.stringify({
              toolCalls: [{
                id: "report-envelope-call",
                name: "submit_runtime_v2_subagent_report",
                arguments: {
                  summary: "The retained source supports the finding.",
                  findings: [{
                    statement: "The source has a bounded test seam.",
                    evidence_ids: [evidenceId],
                  }],
                  unresolved: [],
                },
              }],
            }),
            "</runtime-v2-tools>",
          ].join("");
          return {
            content: envelope,
            semanticContent: envelope,
            actionableContent: envelope,
            toolCalls: [],
            usage: {},
            protocolViolation: null,
          };
        },
      }],
      ["../../lib/runtime-v2", runtime],
      ["./executionContext", {
        baseProviderProfile: () => ({
          schemaVersion: "provider-lane.v1",
          nativeTools: true,
          requiredToolChoice: false,
          streaming: true,
          textToolEnvelope: true,
          reasoning: true,
          imageInput: false,
          toolResultRole: "tool",
        }),
        compactTextEnvelopeCatalog: () => "TEXT_ENVELOPE_CATALOG",
        containsProviderTextEnvelopePrompt: () =>
          "TEXT_ENVELOPE_REQUIRED_PROMPT",
      }],
      ["./executionSubagentPolicy", {
        normalizeRuntimeV2ChildToolCalls: (calls) => calls,
        runtimeV2ChildOutputTokenLimit: () => 4_096,
      }],
      ["./providerToolSurface", {
        scopeRuntimeV2ProviderToolCallIds: (calls) => calls,
      }],
    ]),
  );
  const startedAt = Date.now();
  const result = await provider.requestRuntimeV2ChildStep({
    job: {
      id: "child-required-tool-choice-fallback",
      run: {
        sessionKey: "session",
        sessionEpoch: "epoch",
        turnId: "turn",
        runId: "child-run",
        parentRunId: "parent-run",
        attemptId: "attempt",
      },
      parentRunId: "parent-run",
      scopeKey: "report",
      taskKind: "review",
      accessMode: "read",
      objective: "Submit the retained report.",
      allowedPaths: ["snake.py"],
      status: "running",
      requestedAt: startedAt,
      firstTokenAt: null,
      closedAt: null,
      summary: null,
    },
    ports: {
      get: () => ({ config: {} }),
      context: {
        phaseLanguage: "en",
        runWorkspace: "/fixture",
        runSessionKey: "session",
        workspaceInstructionContext: "",
      },
      live: {
        childTelemetry: new Map(),
        provenStructuredToolTransports: new Set(),
      },
      nextId: () => "child-call",
      now: Date.now,
      logStoreEvent: (eventName, data) => logs.push({ eventName, data }),
    },
    messages: [{
      role: "system",
      content: `CHILD_REPORT_REJECTED. Available exact evidence IDs: ${evidenceId}.`,
    }],
    tools: [reportTool],
    responseMode: "report_required",
    signal: new AbortController().signal,
    deadlineAt: startedAt + 5_000,
    recoveryOccurrence: 1,
  });

  assert.equal(attempts.length, 2);
  assert.deepEqual(
    attempts.map((attempt) => ({
      tools: attempt.tools.map((tool) => tool.function.name),
      toolChoice: attempt.options.toolChoice ?? null,
    })),
    [{
      tools: ["submit_runtime_v2_subagent_report"],
      toolChoice: "required",
    }, {
      tools: [],
      toolChoice: null,
    }],
  );
  assert.match(
    attempts[1].messages
      .map((message) => String(message.content || ""))
      .join("\n"),
    /TEXT_ENVELOPE_REQUIRED_PROMPT/,
  );
  assert.deepEqual(
    result.toolCalls.map((call) => call.name),
    ["submit_runtime_v2_subagent_report"],
  );
  const compatibilityLog = logs.find((entry) =>
    entry.eventName === "runtime_v2_subagent_protocol_drift"
  );
  assert.equal(compatibilityLog?.data?.transport, "native_required");
  assert.equal(compatibilityLog?.data?.transportFallbackAllowed, true);
  assert.equal(
    logs.some((entry) =>
      entry.data?.transport === "native_auto"
    ),
    false,
  );
});

test("a child provider request hard-stops when the transport ignores abort", async () => {
  const runtime = loadTsWithMocks(
    path.join(workspaceRoot, "src/lib/runtime-v2/index.ts"),
    new Map(),
  );
  let released = 0;
  let observedAbort = false;
  const provider = loadTsWithMocks(
    path.join(
      workspaceRoot,
      "src/store/runtimeV2/executionSubagentProvider.ts",
    ),
    new Map([
      ["../../lib/modelLaneCoordinator", {
        acquireModelLane: async ({ signal }) => ({
          markFirstToken() {},
          reportFailure() {},
          setPressureHandler() {},
          release() { released += 1; },
          signal,
        }),
      }],
      ["../../lib/providerLaneSettings", {
        deriveBudgetedStreamSettings: () => ({}),
      }],
      ["../../lib/runtimeContextBudget", {
        boundRuntimeMessagesToContext: (messages) => [...messages],
      }],
      ["../../lib/sanitize", {
        sanitizeAssistantDisplayContent: (value) => String(value || ""),
      }],
      ["../../lib/streaming", {
        streamChatCompletion: async (
          _messages,
          _settings,
          _callbacks,
          signal,
        ) => {
          signal.addEventListener("abort", () => {
            observedAbort = true;
          }, { once: true });
          return await new Promise(() => undefined);
        },
      }],
      ["../../lib/runtime-v2", runtime],
      ["./executionContext", {
        baseProviderProfile: () => ({
          schemaVersion: "provider-lane.v1",
          nativeTools: true,
          requiredToolChoice: false,
          streaming: true,
          textToolEnvelope: true,
          reasoning: true,
          imageInput: false,
          toolResultRole: "tool",
        }),
        compactTextEnvelopeCatalog: () => "",
        containsProviderTextEnvelopePrompt: () => "",
      }],
      ["./executionSubagentPolicy", {
        normalizeRuntimeV2ChildToolCalls: (calls) => calls,
        runtimeV2ChildOutputTokenLimit: () => 2_048,
      }],
      ["./providerToolSurface", {
        scopeRuntimeV2ProviderToolCallIds: (calls) => calls,
      }],
    ]),
  );
  const startedAt = Date.now();
  await assert.rejects(
    provider.requestRuntimeV2ChildStep({
      job: {
        id: "child-hard-deadline",
        run: {
          sessionKey: "session",
          sessionEpoch: "epoch",
          turnId: "turn",
          runId: "child-run",
          parentRunId: "parent-run",
          attemptId: "attempt",
        },
        parentRunId: "parent-run",
        scopeKey: "deadline",
        taskKind: "explore",
        accessMode: "read",
        objective: "Observe the hard deadline.",
        allowedPaths: ["snake.py"],
        status: "running",
        requestedAt: startedAt,
        firstTokenAt: null,
        closedAt: null,
        summary: null,
      },
      ports: {
        get: () => ({ config: {} }),
        context: {
          phaseLanguage: "en",
          runWorkspace: "/fixture",
          runSessionKey: "session",
          workspaceInstructionContext: "",
        },
        live: {
          childTelemetry: new Map(),
          provenStructuredToolTransports: new Set(),
        },
        nextId: () => "child-call",
        now: Date.now,
        logStoreEvent() {},
      },
      messages: [{ role: "user", content: "test" }],
      tools: [],
      signal: new AbortController().signal,
      deadlineAt: startedAt + 40,
      recoveryOccurrence: 0,
      responseMode: "action_or_final",
    }),
    /RUNTIME_V2_SUBAGENT_PROVIDER_REQUEST_TIMEOUT/,
  );
  assert.ok(Date.now() - startedAt < 500);
  assert.equal(observedAbort, true);
  assert.equal(released, 1);
});
