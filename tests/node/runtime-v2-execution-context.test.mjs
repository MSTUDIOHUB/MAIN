import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";

const workspaceRoot = process.cwd();
const cache = new Map();

function loadTs(sourcePath) {
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
    if (specifier.startsWith(".")) {
      const base = path.resolve(path.dirname(normalized), specifier);
      for (const candidate of [
        base,
        `${base}.ts`,
        path.join(base, "index.ts"),
      ]) {
        if (fs.existsSync(candidate) && candidate.endsWith(".ts")) {
          return loadTs(candidate);
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

const providerTools = loadTs(path.join(
  workspaceRoot,
  "src/store/runtimeV2/executionProviderTools.ts",
));
const providerToolSurface = loadTs(path.join(
  workspaceRoot,
  "src/store/runtimeV2/providerToolSurface.ts",
));
const authorization = loadTs(path.join(
  workspaceRoot,
  "src/store/runtimeV2/executionAuthorization.ts",
));
const correctiveMutationPolicy = loadTs(path.join(
  workspaceRoot,
  "src/store/runtimeV2/correctiveMutationPolicy.ts",
));
const evidence = loadTs(path.join(
  workspaceRoot,
  "src/store/runtimeV2/executionEvidence.ts",
));
const providerContext = loadTs(path.join(
  workspaceRoot,
  "src/store/runtimeV2/executionProviderContext.ts",
));
const providerHistory = loadTs(path.join(
  workspaceRoot,
  "src/store/runtimeV2/executionProviderHistory.ts",
));
const providerRequest = loadTs(path.join(
  workspaceRoot,
  "src/store/runtimeV2/executionProviderRequest.ts",
));
const providerPort = loadTs(path.join(
  workspaceRoot,
  "src/store/runtimeV2/executionProviderPort.ts",
));
const providerSurfaceRejection = loadTs(path.join(
  workspaceRoot,
  "src/store/runtimeV2/executionProviderSurfaceRejection.ts",
));
const providerDeadline = loadTs(path.join(
  workspaceRoot,
  "src/store/runtimeV2/executionProviderDeadline.ts",
));
const executionTypes = loadTs(path.join(
  workspaceRoot,
  "src/store/runtimeV2/executionTypes.ts",
));
const providerEffectFacts = loadTs(path.join(
  workspaceRoot,
  "src/store/runtimeV2/executionProviderEffectFacts.ts",
));
const providerActionWindow = loadTs(path.join(
  workspaceRoot,
  "src/store/runtimeV2/executionProviderActionWindow.ts",
));
const executionAcceptance = loadTs(path.join(
  workspaceRoot,
  "src/store/runtimeV2/executionAcceptance.ts",
));
const executionToolPort = loadTs(path.join(
  workspaceRoot,
  "src/store/runtimeV2/executionToolPort.ts",
));
const executionToolDeadline = loadTs(path.join(
  workspaceRoot,
  "src/store/runtimeV2/executionToolDeadline.ts",
));
const executionText = loadTs(path.join(
  workspaceRoot,
  "src/store/runtimeV2/executionText.ts",
));
const executionToolDefinitions = loadTs(path.join(
  workspaceRoot,
  "src/store/runtimeV2/executionToolDefinitions.ts",
));
const executionContract = loadTs(path.join(
  workspaceRoot,
  "src/store/runtimeV2/executionContract.ts",
));
const executionContractAdvance = loadTs(path.join(
  workspaceRoot,
  "src/store/runtimeV2/executionContractAdvance.ts",
));
const executionContractFormation = loadTs(path.join(
  workspaceRoot,
  "src/store/runtimeV2/executionContractFormation.ts",
));
const validationCorrection = loadTs(path.join(
  workspaceRoot,
  "src/store/runtimeV2/executionValidationCorrection.ts",
));
const subagentContext = loadTs(path.join(
  workspaceRoot,
  "src/store/runtimeV2/executionSubagentContext.ts",
));
const subagentScopes = loadTs(path.join(
  workspaceRoot,
  "src/store/runtimeV2/executionSubagentScopes.ts",
));
const subagentRunner = loadTs(path.join(
  workspaceRoot,
  "src/store/runtimeV2/executionSubagentRunner.ts",
));
const subagentPolicy = loadTs(path.join(
  workspaceRoot,
  "src/store/runtimeV2/executionSubagentPolicy.ts",
));
const schedulerPort = loadTs(path.join(
  workspaceRoot,
  "src/store/runtimeV2/executionSchedulerPort.ts",
));
const subagentCandidate = loadTs(path.join(
  workspaceRoot,
  "src/store/runtimeV2/executionSubagentCandidate.ts",
));
const reducerGuards = loadTs(path.join(
  workspaceRoot,
  "src/lib/runtime-v2/reducerGuards.ts",
));
const subagentWriteScope = loadTs(path.join(
  workspaceRoot,
  "src/store/runtimeV2/executionSubagentWriteScope.ts",
));
const runtime = loadTs(path.join(
  workspaceRoot,
  "src/lib/runtime-v2/index.ts",
));

test("an explicit zero child budget cannot fall back to later active capacity", () => {
  assert.equal(
    subagentCandidate.runtimeV2SubagentTotalBudgetFromCommand({
      payload: {
        maxChildRuns: 0,
        maxActiveSubagents: 2,
      },
    }),
    0,
  );
});

test("unclassified direct Execute acceptance defaults to behavioral evidence", () => {
  assert.deepEqual(
    executionAcceptance.runtimeV2ExecuteAcceptanceEvidenceRequirements(),
    ["behavioral"],
  );
  assert.deepEqual(
    executionAcceptance.runtimeV2ExecuteAcceptanceEvidenceRequirements([
      { evidenceRequirement: "static" },
      {},
      { evidenceRequirement: "interaction" },
    ]),
    ["static", "behavioral", "interaction"],
  );
});

test("a shared lifecycle boundary stays distinct from a tool timeout", async () => {
  await assert.rejects(
    executionToolDeadline.executeRuntimeV2ToolWithDeadline({
      toolName: "read_file",
      lifecycleDeadlineAt: 100,
      now: () => 100,
      task: async () => "unreachable",
    }),
    (error) => {
      assert.equal(runtime.isRuntimeV2LifecycleDeadlineError(error), true);
      return true;
    },
  );
});

test("a provider request reports the shared lifecycle boundary without a transport failure", async () => {
  const events = [];
  const lifecycleDeadlineAt = Date.now() + 5;
  const command = {
    idempotencyKey: "provider-lifecycle",
    kind: "request_provider",
    phase: "observing",
    run: {
      sessionKey: "session",
      sessionEpoch: "epoch",
      turnId: "turn",
      runId: "run",
      parentRunId: null,
      attemptId: "attempt",
    },
    payload: {},
  };
  await assert.rejects(
    providerDeadline.executeRuntimeV2ProviderWithDeadline({
      ports: {
        lifecycleDeadlineAt,
        logStoreEvent: (event, payload) => events.push({ event, payload }),
      },
      command,
      requestDeadlineAt: lifecycleDeadlineAt,
      transport: "native_auto",
      signal: new AbortController().signal,
      task: () => new Promise(() => undefined),
    }),
    (error) => {
      assert.equal(runtime.isRuntimeV2LifecycleDeadlineError(error), true);
      return true;
    },
  );
  assert.deepEqual(
    events.map((entry) => entry.event),
    ["runtime_v2_lifecycle_deadline_reached"],
  );
});

test("ordinary Execute provider requests have no default whole-request wall-clock deadline", async () => {
  assert.equal(
    providerPort.runtimeV2ExecutionProviderDeadlineAt(1_000),
    undefined,
    "normal Execute must use the transport phase watchdog instead of a total Run/request deadline",
  );

  let observedTimeout = "not-called";
  const result = await providerDeadline.executeRuntimeV2ProviderWithDeadline({
    ports: {
      logStoreEvent: () => undefined,
    },
    command: {
      idempotencyKey: "provider-unbounded-execute",
      kind: "request_model",
      phase: "acting",
      run: {
        sessionKey: "session",
        sessionEpoch: "epoch",
        turnId: "turn",
        runId: "run",
        parentRunId: null,
        attemptId: "attempt",
      },
      payload: { mode: "execute" },
    },
    requestDeadlineAt: undefined,
    transport: "native_auto",
    signal: new AbortController().signal,
    task: async ({ timeoutMs }) => {
      observedTimeout = timeoutMs;
      return "completed";
    },
  });

  assert.equal(result, "completed");
  assert.equal(observedTimeout, undefined);
});

test("successful empty tool output is explicit model evidence", () => {
  assert.equal(
    evidence.toolResultContentForModel(""),
    "TOOL_RESULT_EMPTY: the tool completed successfully and returned no content or matches.",
  );
  assert.equal(
    evidence.toolResultContentForModel(null),
    "TOOL_RESULT_EMPTY: the tool completed successfully and returned no content or matches.",
  );
});

test("read_file model context preserves source text without command-result decoding or trimming", () => {
  const source =
    " \t{\"stdout\":\"source\",\"error\":\"literal\",\"exitCode\":9}\n";

  assert.equal(
    executionText.runtimeV2SourceToolContent(source),
    source,
  );
  assert.equal(
    executionText.boundedRuntimeV2ToolContent("read_file", source),
    source,
  );
});

test("an incomplete character window stays actionable but grants no mutation coverage", () => {
  const result = [
    "READ_FILE_RESULT",
    "path: fixtures/minified.js",
    "contentVersion: sha-minified-v1",
    "truncated: true",
    "totalLines: 1",
    "totalChars: 96000",
    "returnedLines: 0-0",
    "returnedChars: 32000",
    "returnedCharRange: 0-32000",
    "nextStartChar: 32000",
    "note: continue with start_char: 32000 on the same content version.",
    "---CONTENT START---",
    "MINIFIED_SOURCE_PREFIX",
    "---CONTENT END---",
  ].join("\n");
  const messages = [{
    role: "system",
    content: "[MAIN RUNTIME V2]",
  }, {
    role: "user",
    content: "Inspect the minified source.",
  }, {
    role: "assistant",
    content: "",
    tool_calls: [{
      id: "read-minified-prefix",
      type: "function",
      function: {
        name: "read_file",
        arguments: JSON.stringify({
          path: "fixtures/minified.js",
        }),
      },
    }],
  }, {
    role: "tool",
    tool_call_id: "read-minified-prefix",
    content: result,
  }];
  const decisionView =
    providerHistory.buildRuntimeV2DecisionView(messages);

  assert.match(
    decisionView.map((message) => String(message.content || "")).join("\n"),
    /nextStartChar: 32000/,
  );
  assert.deepEqual(
    providerHistory.materializedRuntimeV2SourceCoverage(
      decisionView,
      "/tmp/runtime-v2-character-window",
    ),
    [],
  );
});

test("a malformed READ_FILE_RESULT cannot fall through as raw source authority", () => {
  const messages = [{
    role: "assistant",
    content: "",
    tool_calls: [{
      id: "malformed-source",
      type: "function",
      function: {
        name: "read_file",
        arguments: JSON.stringify({ path: "src/main.js" }),
      },
    }],
  }, {
    role: "tool",
    tool_call_id: "malformed-source",
    content: [
      "READ_FILE_RESULT",
      "path: src/main.js",
      "contentVersion: main-v1",
      "truncated: false",
      "totalLines: 1000",
      "totalChars: 30000",
      "returnedLines: 1-1000",
      "returnedChars: 12",
      "---CONTENT START---",
      "short source",
      "---CONTENT END---",
    ].join("\n"),
  }];
  const effects = {
    committedMutationTargetsByToolCallId: new Map(),
    replayedToolCallIds: new Set(),
    sourceReadVersionsByToolCallId: new Map([[
      "malformed-source",
      { target: "src/main.js", version: "main-v1" },
    ]]),
  };

  assert.deepEqual(
    providerHistory.materializedRuntimeV2SourceCoverage(
      providerHistory.buildRuntimeV2DecisionView(messages, effects),
      "/tmp/runtime-v2-malformed-source",
      effects,
    ),
    [],
  );
});

test("a real raw small-file result retains versioned source authority", () => {
  const source = "export const ready = true;\n";
  const messages = [{
    role: "assistant",
    content: "",
    tool_calls: [{
      id: "raw-small-source",
      type: "function",
      function: {
        name: "read_file",
        arguments: JSON.stringify({ path: "src/small.js" }),
      },
    }],
  }, {
    role: "tool",
    tool_call_id: "raw-small-source",
    content: source,
  }];
  const effects = {
    committedMutationTargetsByToolCallId: new Map(),
    replayedToolCallIds: new Set(),
    sourceReadVersionsByToolCallId: new Map([[
      "raw-small-source",
      { target: "src/small.js", version: "small-v1" },
    ]]),
  };

  assert.deepEqual(
    providerHistory.materializedRuntimeV2SourceCoverage(
      providerHistory.buildRuntimeV2DecisionView(messages, effects),
      "/tmp/runtime-v2-raw-small-source",
      effects,
    ),
    [{
      target: "src/small.js",
      version: "small-v1",
      totalLines: 2,
      windows: [{
        startLine: 1,
        endLine: 2,
        content: source,
      }],
      complete: true,
    }],
  );
});

test("a replay receipt never creates source authority even with a conflicting source fact", () => {
  const source = "export const replayed = true;";
  const messages = [{
    role: "assistant",
    content: "",
    tool_calls: [{
      id: "replayed-source",
      type: "function",
      function: {
        name: "read_file",
        arguments: JSON.stringify({ path: "src/replayed.js" }),
      },
    }],
  }, {
    role: "tool",
    tool_call_id: "replayed-source",
    content: [
      "READ_FILE_RESULT",
      "path: src/replayed.js",
      "contentVersion: replayed-v1",
      "truncated: false",
      "totalLines: 1",
      `totalChars: ${source.length}`,
      "returnedLines: 1-1",
      `returnedChars: ${source.length}`,
      "---CONTENT START---",
      source,
      "---CONTENT END---",
    ].join("\n"),
  }];
  const effects = {
    committedMutationTargetsByToolCallId: new Map(),
    replayedToolCallIds: new Set(["replayed-source"]),
    sourceReadVersionsByToolCallId: new Map([[
      "replayed-source",
      { target: "src/replayed.js", version: "replayed-v1" },
    ]]),
  };

  assert.deepEqual(
    providerHistory.materializedRuntimeV2SourceCoverage(
      providerHistory.buildRuntimeV2DecisionView(messages, effects),
      "/tmp/runtime-v2-replayed-source",
      effects,
    ),
    [],
  );
});

test("Runtime v2 child scope uses required_paths without widening to the workspace", () => {
  const scheduleCommand = {
    idempotencyKey: "schedule-child",
    kind: "schedule_subagents",
    phase: "acting",
    run: {
      sessionKey: "session",
      sessionEpoch: "epoch",
      turnId: "turn",
      runId: "run",
      parentRunId: null,
      attemptId: "attempt",
    },
    payload: {
      toolCallId: "spawn-call",
      arguments: {
        task_key: "review-editor",
        task_kind: "review",
        name: "Editor reviewer",
        role: "reviewer",
        objective: "Review the editor lifecycle",
        success_criteria: "Report evidence",
        required_paths: "src/components/editor.js",
      },
    },
  };
  const candidate =
    subagentCandidate.runtimeV2ModelSelectedSubagentCandidate(scheduleCommand);
  assert.deepEqual(candidate.allowedPaths, ["src/components/editor.js"]);

  assert.throws(
    () => subagentCandidate.runtimeV2ModelSelectedSubagentCandidate({
      ...scheduleCommand,
      payload: {
        ...scheduleCommand.payload,
        arguments: {
          ...scheduleCommand.payload.arguments,
          required_paths: "",
        },
      },
    }),
    /will not widen/i,
  );
});

test("provider mutation facts come only from committed ledger evidence", () => {
  const scheduled = (
    idempotencyKey,
    toolCallId,
    toolName = "read_file",
    argumentsValue = { path: "src/main.js" },
  ) => ({
    type: "command.scheduled",
    command: {
      idempotencyKey,
      kind: "execute_tool",
      phase: "acting",
      payload: {
        toolCallId,
        toolName,
        arguments: argumentsValue,
      },
    },
  });
  const completed = (idempotencyKey, status, evidenceEntries) => ({
    type: "tool.completed",
    idempotencyKey,
    status,
    evidence: evidenceEntries,
  });
  const facts = providerEffectFacts.deriveRuntimeV2ProviderEffectFacts({
    events: [
      scheduled("failed-command", "failed-mutation"),
      completed("failed-command", "failed", []),
      scheduled(
        "mismatch-command",
        "mismatched-mutation",
        "replace_in_file",
        {
          path: "src/components/toolbar.js",
          search_text: "imagined old source",
          replace_text: "new source",
        },
      ),
      {
        ...completed("mismatch-command", "blocked", []),
        failureKind: "source_mismatch",
        presentation: {
          toolName: "replace_in_file",
          target: "src/components/toolbar.js",
        },
      },
      scheduled(
        "preflight-command",
        "preflight-rejected-mutation",
        "replace_in_file",
        {
          path: "src/components/editor.js",
          search_text: "old source",
          replace_text: "duplicate export proposal",
        },
      ),
      {
        ...completed("preflight-command", "failed", []),
        failureKind: "mutation_rejected",
        presentation: {
          toolName: "replace_in_file",
          target: "src/components/editor.js",
        },
      },
      scheduled("read-command", "read-main"),
      {
        ...completed("read-command", "succeeded", []),
        receiptOrigin: "replayed",
      },
      scheduled("source-command", "source-main"),
      completed("source-command", "succeeded", [{
        id: "source",
        kind: "source",
        target: "src/main.js",
        version: "v1",
      }]),
      {
        type: "subagent.completed",
        status: "completed",
        evidence: [{
          id: "child-mutation",
          kind: "mutation",
          target: "src/components/editor.js",
          version: "editor-v2",
        }],
      },
      scheduled("committed-command", "committed-mutation"),
      completed("committed-command", "succeeded", [{
        id: "mutation",
        kind: "mutation",
        target: "src/main.js",
        version: "v2",
      }]),
      scheduled("validation-command", "validate-current"),
      {
        type: "validation.completed",
        idempotencyKey: "validation-command",
        passed: false,
        evidence: [],
      },
    ],
  });

  assert.equal(
    facts.committedMutationTargetsByToolCallId.has("failed-mutation"),
    false,
  );
  assert.equal(
    facts.committedMutationTargetsByToolCallId.has("read-main"),
    false,
  );
  assert.equal(
    facts.replayedToolCallIds.has("read-main"),
    true,
    "cached-read control state must come from the durable effect ledger",
  );
  assert.deepEqual(
    facts.committedMutationTargetsByToolCallId.get("committed-mutation"),
    ["src/main.js"],
  );
  assert.deepEqual(
    facts.sourceReadVersionsByToolCallId.get("source-main"),
    {
      target: "src/main.js",
      version: "v1",
    },
  );
  assert.equal(
    facts.invalidatedSourceReadToolCallIds.has("source-main"),
    true,
    "a committed child transaction must invalidate parent source authority even without a parent tool-call pair",
  );
  assert.equal(
    facts.failedValidationToolCallIds.has("validate-current"),
    true,
  );
  assert.deepEqual(
    facts.correctiveReplayTargetsByToolCallId.get("mismatched-mutation"),
    ["src/components/toolbar.js"],
    "a restart must reconstruct the exact target whose cache replay was reopened",
  );
  assert.deepEqual(
    facts.correctiveReplayTargetsByToolCallId.get(
      "preflight-rejected-mutation",
    ),
    ["src/components/editor.js"],
    "parser-confirmed preflight failures must reopen the same bounded replay after restart",
  );
  assert.equal(
    facts.correctiveMutationFailureToolCallIds.size,
    0,
    "a later committed mutation establishes a new corrective-diagnostic boundary",
  );
});

test("different searches with the same non-empty result close one durable observation branch", () => {
  const scheduled = (id, callId, toolName, argumentsValue) => ({
    type: "command.scheduled",
    command: {
      idempotencyKey: id,
      kind: "execute_tool",
      phase: "acting",
      payload: {
        toolCallId: callId,
        toolName,
        arguments: argumentsValue,
      },
    },
  });
  const completed = (id, toolName, version, summary) => ({
    type: "tool.completed",
    idempotencyKey: id,
    status: "succeeded",
    evidence: [{
      id: `${id}-source`,
      kind: "source",
      target: toolName,
      version,
    }],
    presentation: {
      toolName,
      target: toolName,
      observationSummary: summary,
    },
  });
  const duplicateEvents = [
    scheduled("grep-a", "grep-call-a", "grep_search", {
      path: "src",
      query: "function writeFile",
    }),
    completed("grep-a", "grep_search", "same-result-version", "src/main.js:268: writeFile"),
    scheduled("grep-b", "grep-call-b", "grep_search", {
      path: "src/main.js",
      query: "writeFile",
    }),
    completed("grep-b", "grep_search", "same-result-version", "src/main.js:268: writeFile"),
  ];
  const repeated = providerEffectFacts.deriveRuntimeV2ProviderEffectFacts({
    events: duplicateEvents,
  });
  assert.deepEqual(
    [...repeated.repeatedObservationToolNames],
    ["grep_search"],
    "argument churn returning the identical result is one observation, not new progress",
  );

  const exactRepeat = providerEffectFacts.deriveRuntimeV2ProviderEffectFacts({
    events: [duplicateEvents[0], duplicateEvents[1], duplicateEvents[0], duplicateEvents[1]],
  });
  assert.equal(
    exactRepeat.repeatedObservationToolNames.size,
    0,
    "the semantic guard requires materially different action identities",
  );
  const emptyResults = providerEffectFacts.deriveRuntimeV2ProviderEffectFacts({
    events: duplicateEvents.map((event) =>
      event.type === "tool.completed"
        ? { ...event, presentation: { ...event.presentation, observationSummary: "" } }
        : event
    ),
  });
  assert.equal(
    emptyResults.repeatedObservationToolNames.size,
    0,
    "distinct empty searches remain distinct negative facts",
  );

  const reset = providerEffectFacts.deriveRuntimeV2ProviderEffectFacts({
    events: [
      ...duplicateEvents,
      scheduled("edit", "edit-call", "replace_in_file", {
        path: "src/main.js",
        search_text: "old",
        replace_text: "new",
      }),
      {
        type: "tool.completed",
        idempotencyKey: "edit",
        status: "succeeded",
        evidence: [{
          id: "mutation-main",
          kind: "mutation",
          target: "src/main.js",
          version: "main-v2",
        }],
      },
    ],
  });
  assert.equal(
    reset.repeatedObservationToolNames.size,
    0,
    "a real mutation establishes a fresh observation boundary",
  );
});

test("equivalent failed validations converge across command wrapper churn", () => {
  const diagnostic = [
    "FRESH_FIXTURE_ACCEPTANCE_FAILED: current source violates acceptance:",
    "src/main.js:408: open files must not trigger Save As",
  ].join("\n");
  const firstOutput = JSON.stringify({
    command: "npm run build 2>&1 | head -100",
    exitCode: 1,
    durationMs: 913,
    stdout: "vite build\n✓ built in 913ms",
    stderr: diagnostic,
  });
  const secondOutput = JSON.stringify({
    command: "npx vite build",
    exitCode: 1,
    durationMs: 1_827,
    stdout: "vite build\n✓ built in 1.827 seconds",
    stderr: diagnostic,
  });
  const firstVersion = evidence.runtimeV2ValidationEvidenceVersion(
    firstOutput,
  );
  const secondVersion = evidence.runtimeV2ValidationEvidenceVersion(
    secondOutput,
  );
  assert.equal(
    firstVersion,
    secondVersion,
    "wrapper, stdout, and timing churn must not hide an unchanged failure diagnostic",
  );
  assert.notEqual(
    firstVersion,
    evidence.runtimeV2ValidationEvidenceVersion(JSON.stringify({
      exitCode: 1,
      stderr: "src/editor.js:192: a different acceptance failure",
    })),
  );
  const durableCompletion = evidence.toolCompletionFor(
    { live: executionTypes.createRuntimeV2LiveExecutionState() },
    {
      idempotencyKey: "build-versioned",
      kind: "execute_tool",
      phase: "acting",
      run: {},
      payload: {},
    },
    "run_command",
    { command: "npm run build" },
    "npm run build",
    firstOutput,
    "succeeded",
  );
  assert.equal(
    durableCompletion.evidence[0]?.version,
    firstVersion,
    "successful tool completion records a durable result-semantic version",
  );

  const command = (id, callId, commandText) => ({
    type: "command.scheduled",
    command: {
      idempotencyKey: id,
      kind: "execute_tool",
      phase: "acting",
      payload: {
        toolCallId: callId,
        toolName: "run_command",
        arguments: { command: commandText },
      },
    },
  });
  const completion = (id, version) => ({
    type: "tool.completed",
    idempotencyKey: id,
    status: "succeeded",
    evidence: [{
      id: `${id}-tool`,
      kind: "tool",
      target: "build",
      version,
    }],
    presentation: {
      toolName: "run_command",
      target: "build",
      observationSummary: diagnostic,
    },
  });
  const facts = providerEffectFacts.deriveRuntimeV2ProviderEffectFacts({
    events: [
      command("build-a", "build-call-a", "npm run build 2>&1 | head -100"),
      completion("build-a", firstVersion),
      command("build-b", "build-call-b", "npx vite build"),
      completion("build-b", secondVersion),
    ],
  });
  assert.deepEqual(
    [...facts.repeatedObservationToolNames],
    ["run_command"],
    "equivalent failed builds close the same pre-mutation validation branch",
  );
});

test("multiple cached source re-materializations close durable workset cycling", () => {
  const replay = (id, callId, pathValue) => [{
    type: "command.scheduled",
    command: {
      idempotencyKey: id,
      kind: "execute_tool",
      phase: "acting",
      payload: {
        toolCallId: callId,
        toolName: "read_file",
        arguments: { path: pathValue },
      },
    },
  }, {
    type: "tool.completed",
    idempotencyKey: id,
    status: "succeeded",
    evidence: [],
    receiptOrigin: "replayed",
  }];
  const replayEvents = [
    ...replay("replay-main", "replay-main-call", "src/main.js"),
    ...replay("replay-editor", "replay-editor-call", "src/components/editor.js"),
  ];
  const cycling = providerEffectFacts.deriveRuntimeV2ProviderEffectFacts({
    events: replayEvents,
  });
  assert.equal(
    cycling.replayedSourceReceiptCountSinceMutation,
    2,
  );

  const reset = providerEffectFacts.deriveRuntimeV2ProviderEffectFacts({
    events: [
      ...replayEvents,
      {
        type: "command.scheduled",
        command: {
          idempotencyKey: "mutate-main",
          kind: "execute_tool",
          phase: "acting",
          payload: {
            toolCallId: "mutate-main-call",
            toolName: "replace_in_file",
            arguments: { path: "src/main.js" },
          },
        },
      },
      {
        type: "tool.completed",
        idempotencyKey: "mutate-main",
        status: "succeeded",
        evidence: [{
          id: "mutated-main",
          kind: "mutation",
          target: "src/main.js",
          version: "main-v2",
        }],
      },
    ],
  });
  assert.equal(
    reset.replayedSourceReceiptCountSinceMutation,
    0,
  );
});

test("the durable ledger retains a correctable mutation diagnostic across reads", () => {
  const mutationCommand = {
    type: "command.scheduled",
    command: {
      idempotencyKey: "rejected-mutation-command",
      kind: "execute_tool",
      phase: "acting",
      payload: {
        toolCallId: "rejected-mutation-call",
        toolName: "replace_in_file",
        arguments: {
          path: "src/components/toolbar.js",
          search_text: "imagined source",
          replace_text: "duplicate proposal",
        },
      },
    },
  };
  const rejectedMutation = {
    type: "tool.completed",
    idempotencyKey: "rejected-mutation-command",
    status: "failed",
    failureKind: "mutation_rejected",
    evidence: [],
    presentation: {
      toolName: "replace_in_file",
      target: "src/components/toolbar.js",
    },
  };
  const readCommand = {
    type: "command.scheduled",
    command: {
      idempotencyKey: "recovery-read-command",
      kind: "execute_tool",
      phase: "acting",
      payload: {
        toolCallId: "recovery-read-call",
        toolName: "read_file",
        arguments: { path: "src/components/toolbar.js" },
      },
    },
  };
  const recoveryRead = {
    type: "tool.completed",
    idempotencyKey: "recovery-read-command",
    status: "succeeded",
    failureKind: null,
    evidence: [{
      id: "toolbar-source",
      kind: "source",
      target: "src/components/toolbar.js",
      version: "toolbar-v1",
    }],
  };

  const facts = providerEffectFacts.deriveRuntimeV2ProviderEffectFacts({
    events: [
      mutationCommand,
      rejectedMutation,
      readCommand,
      recoveryRead,
    ],
  });
  assert.equal(
    facts.correctiveMutationFailureToolCallIds.has(
      "rejected-mutation-call",
    ),
    true,
  );
  assert.equal(
    facts.correctiveMutationRequirementsByToolCallId.get(
      "rejected-mutation-call",
    )?.toolName,
    "replace_in_file",
    "reads do not erase the failed editor requirement; current materialized source decides the next action",
  );
});

test("a structured missing-source mutation failure survives restart as corrective recovery", () => {
  const facts = providerEffectFacts.deriveRuntimeV2ProviderEffectFacts({
    events: [{
      type: "command.scheduled",
      command: {
        idempotencyKey: "missing-source-command",
        kind: "execute_tool",
        phase: "acting",
        payload: {
          toolCallId: "missing-source-call",
          toolName: "replace_in_file",
          arguments: {
            path: "src/main.js",
            search_text: "const stale = true;",
            replace_text: "const stale = false;",
          },
        },
      },
    }, {
      type: "tool.completed",
      idempotencyKey: "missing-source-command",
      status: "blocked",
      failureKind: "protocol_invalid",
      failureReasonCode: "mutation_target_lease_mismatch",
      evidence: [],
      presentation: {
        toolName: "replace_in_file",
        target: "src/main.js",
        message: "presentation text is not recovery authority",
      },
    }],
  });

  assert.deepEqual(
    facts.correctiveReplayTargetsByToolCallId.get("missing-source-call"),
    ["src/main.js"],
  );
  assert.equal(
    facts.correctiveMutationFailureToolCallIds.has("missing-source-call"),
    true,
  );
  assert.deepEqual(
    facts.correctiveMutationRequirementsByToolCallId.get(
      "missing-source-call",
    ),
    {
      toolName: "replace_in_file",
      arguments: {
        path: "src/main.js",
        search_text: "const stale = true;",
        replace_text: "const stale = false;",
      },
      target: "src/main.js",
      reasonCode: "mutation_target_lease_mismatch",
    },
  );
});

test("the durable ledger retains every rejected action until a committed mutation", () => {
  const rejectedCalls = Array.from({ length: 13 }, (_, index) => ({
    name: "replace_in_file",
    arguments: {
      path: `src/file-${index}.js`,
      search_text: `old-${index}`,
      replace_text: `new-${index}`,
    },
  }));
  const rejectedEvents = rejectedCalls.flatMap((call, index) => {
    const idempotencyKey = `rejected-command-${index}`;
    return [{
      type: "command.scheduled",
      command: {
        idempotencyKey,
        kind: "execute_tool",
        phase: "acting",
        payload: {
          toolCallId: `rejected-call-${index}`,
          toolName: call.name,
          arguments: call.arguments,
        },
      },
    }, {
      type: "tool.completed",
      idempotencyKey,
      status: index % 2 === 0 ? "failed" : "blocked",
      evidence: [],
      failureKind: "protocol_invalid",
    }];
  });
  const aggregate = { events: rejectedEvents };
  const facts =
    providerEffectFacts.deriveRuntimeV2ProviderEffectFacts(aggregate);

  assert.equal(facts.rejectedActionIdentities.size, 13);
  for (const call of rejectedCalls) {
    assert.equal(
      facts.rejectedActionIdentities.has(
        providerToolSurface.runtimeV2ProviderToolCallIdentity(call),
      ),
      true,
    );
  }
  assert.deepEqual(
    [...providerEffectFacts
      .deriveRuntimeV2ProviderEffectFacts(aggregate)
      .rejectedActionIdentities],
    [...facts.rejectedActionIdentities],
    "checkpoint replay must derive the same guard without process-local state",
  );

  const afterMutation =
    providerEffectFacts.deriveRuntimeV2ProviderEffectFacts({
      events: [
        ...rejectedEvents,
        {
          type: "command.scheduled",
          command: {
            idempotencyKey: "committed-command",
            kind: "execute_tool",
            phase: "acting",
            payload: {
              toolCallId: "committed-call",
              toolName: "replace_in_file",
              arguments: {
                path: "src/main.js",
                search_text: "old",
                replace_text: "new",
              },
            },
          },
        },
        {
          type: "tool.completed",
          idempotencyKey: "committed-command",
          status: "succeeded",
          evidence: [{
            id: "committed-mutation",
            kind: "mutation",
            target: "src/main.js",
            version: "main-v2",
          }],
        },
      ],
    });
  assert.equal(afterMutation.rejectedActionIdentities.size, 0);
});

test("one cached replay preserves source then closes covered ranges on that source", async () => {
  const live = executionTypes.createRuntimeV2LiveExecutionState();
  const rawSource = [
    "export function createToolbar() {",
    "  return { save: true };",
    "}",
  ].join("\n");
  live.messages.push({
    role: "assistant",
    content: "",
    tool_calls: [{
      id: "read-toolbar",
      type: "function",
      function: {
        name: "read_file",
        arguments: JSON.stringify({
          path: "src/components/toolbar.js",
        }),
      },
    }],
  });
  live.coveredReadToolResults.set("read-toolbar", rawSource);
  const port = executionToolPort.createRuntimeV2ToolPort({
    get: () => ({}),
    context: {
      runWorkspace: "/tmp/runtime-v2-replay-fixture",
      runSessionKey: "session",
    },
    live,
    nextId: (scope) => `${scope}-1`,
    now: () => 1,
    lifecycleDeadlineAt: 100_000,
    logStoreEvent() {},
  });
  const completion = await port.execute({
    command: {
      idempotencyKey: "read-toolbar-command",
      kind: "execute_tool",
      phase: "acting",
      run: {
        sessionKey: "session",
        sessionEpoch: "epoch",
        turnId: "turn",
        runId: "run",
        parentRunId: null,
        attemptId: "attempt",
      },
      payload: {
        toolCallId: "read-toolbar",
        toolName: "read_file",
        arguments: {
          path: "src/components/toolbar.js",
        },
      },
    },
  });

  assert.equal(completion.type, "tool.completed");
  assert.equal(completion.receiptOrigin, "replayed");
  assert.deepEqual(completion.evidence, []);
  assert.equal(live.messages.at(-1)?.role, "tool");
  assert.equal(
    live.messages.at(-1)?.content,
    rawSource,
    "replay metadata must not replace or prefix the source artifact",
  );
  assert.equal(
    "rejectedProviderActions" in live,
    false,
    "cache replay truth belongs to the durable ledger and current source workset",
  );
});

test("a thrown tool error is visible to both the model and structured presentation", async () => {
  const live = executionTypes.createRuntimeV2LiveExecutionState();
  const missingPath =
    "/tmp/runtime-v2-missing-workspace/src/does-not-exist.ts";
  live.messages.push({
    role: "assistant",
    content: "",
    tool_calls: [{
      id: "missing-read",
      type: "function",
      function: {
        name: "read_file",
        arguments: JSON.stringify({ path: missingPath }),
      },
    }],
  });
  const port = executionToolPort.createRuntimeV2ToolPort({
    get: () => ({}),
    context: {
      runWorkspace: "/tmp/runtime-v2-missing-workspace",
      runSessionKey: "session",
    },
    live,
    nextId: (scope) => `${scope}-1`,
    now: () => 1,
    lifecycleDeadlineAt: 100_000,
    logStoreEvent() {},
  });

  const completion = await port.execute({
    command: {
      idempotencyKey: "missing-read-command",
      kind: "execute_tool",
      phase: "acting",
      run: {
        sessionKey: "session",
        sessionEpoch: "epoch",
        turnId: "turn",
        runId: "run",
        parentRunId: null,
        attemptId: "attempt",
      },
      payload: {
        toolCallId: "missing-read",
        toolName: "read_file",
        arguments: { path: missingPath },
      },
    },
  });

  assert.equal(completion.type, "tool.completed");
  assert.equal(completion.status, "failed");
  assert.match(String(completion.presentation?.message || ""), /TOOL_ERROR:/);
  assert.doesNotMatch(
    String(completion.presentation?.message || ""),
    /TOOL_RESULT_EMPTY/,
  );
  assert.match(String(live.messages.at(-1)?.content || ""), /TOOL_ERROR:/);
});

test("Runtime v2 collaboration schema exposes read investigations and transactional implementation", () => {
  const spawn = {
    type: "function",
    function: {
      name: "spawn_subagent",
      description: "legacy collaboration contract",
      parameters: {
        type: "object",
        properties: {
          task_key: { type: "string" },
          task_kind: {
            type: "string",
            enum: ["explore", "review", "implement", "validate"],
          },
          objective: { type: "string" },
          success_criteria: { type: "string" },
          name: { type: "string" },
          role: { type: "string" },
          required_paths: { type: "string" },
          allowed_paths: { type: "string" },
          access_mode: {
            type: "string",
            enum: ["read", "write"],
          },
          implementation_operation: {
            type: "string",
            enum: ["create", "modify", "delete"],
          },
          implementation_plan: { type: "string" },
        },
        required: ["objective"],
      },
    },
  };
  const selected = providerTools.selectRuntimeV2ProviderToolDefinitions({
    ports: {
      now: () => 1,
      lifecycleDeadlineAt: 200_000,
    },
    command: {
      ...command("acting"),
      payload: {
        ...command("acting").payload,
        collaborationAllowed: true,
        remainingSubagentCapacity: 1,
      },
    },
    available: [spawn],
  })[0];

  assert.deepEqual(
    selected.function.parameters.properties.task_kind.enum,
    ["explore", "review", "validate", "implement"],
  );
  assert.deepEqual(
    selected.function.parameters.properties.access_mode.enum,
    ["read", "write"],
  );
  assert.match(
    selected.function.description,
    /exclusive narrow paths|stages and commits/i,
  );
  assert.deepEqual(
    selected.function.parameters.required,
    ["objective", "required_paths"],
  );

  const minimal = subagentCandidate.runtimeV2ModelSelectedSubagentCandidate({
    idempotencyKey: "schedule-minimal",
    kind: "schedule_subagents",
    phase: "acting",
    run: {
      sessionKey: "session",
      sessionEpoch: "epoch",
      turnId: "turn",
      runId: "run",
      parentRunId: null,
      attemptId: "attempt",
    },
    payload: {
      toolCallId: "provider-child-call",
      arguments: {
        objective: "Review the current toolbar behavior.",
        required_paths: "src/components/toolbar.js",
      },
    },
  });
  assert.equal(minimal.scopeKey, "provider-child-call");
  assert.equal(minimal.taskKind, "explore");
  assert.deepEqual(minimal.allowedPaths, [
    "src/components/toolbar.js",
  ]);
});

test("multi-owner direct Execute records an evidence-bound contract before its first mutation", () => {
  const turn = {
    workspaceKey: "/fixture",
    sessionKey: "session-contract",
    sessionEpoch: "epoch-contract",
    clientSubmissionId: "submission-contract",
    turnId: "turn-contract",
  };
  const run = {
    sessionKey: turn.sessionKey,
    sessionEpoch: turn.sessionEpoch,
    turnId: turn.turnId,
    runId: "run-contract",
    parentRunId: null,
    attemptId: "attempt-contract",
  };
  let sequence = 0;
  const event = (type, fields) => ({
    schemaVersion: runtime.RUNTIME_V2_EVENT_SCHEMA_VERSION,
    sequence: sequence++,
    eventId: `contract-event-${sequence}`,
    at: sequence,
    type,
    ...fields,
  });
  let aggregate = runtime.transition(null, event("turn.admitted", {
    turn,
    strategy: "execute",
    objective: "Trace both symptoms to their owners and repair them.",
    constraints: [],
    acceptanceCriteria: ["Both observable symptoms are repaired."],
    acceptanceCriterionIds: ["criterion-user-objective"],
  }));
  aggregate = runtime.transition(aggregate, event("run.started", {
    run,
    phase: "observing",
  }));
  const addSource = (id, target, version) => {
    const command = {
      idempotencyKey: `read-${id}`,
      kind: "execute_tool",
      phase: "observing",
      run,
      payload: {
        toolCallId: `read-call-${id}`,
        toolName: "read_file",
        arguments: { path: target },
      },
    };
    aggregate = runtime.transition(aggregate, event("command.scheduled", {
      run,
      command,
    }));
    aggregate = runtime.transition(aggregate, event("tool.completed", {
      run,
      idempotencyKey: command.idempotencyKey,
      status: "succeeded",
      evidence: [{ id, kind: "source", target, version }],
    }));
  };
  addSource("E-main", "src/main.js", "main-v1");
  addSource("E-editor", "src/components/editor.js", "editor-v1");

  assert.equal(
    executionContract.runtimeV2ExecutionContractRequired(aggregate),
    true,
  );
  const beforeCheckpoint = runtime.createRuntimeV2Checkpoint({
    revision: 1,
    aggregate,
    updatedAt: aggregate.updatedAt,
  });
  const ports = {
    get: () => ({
      runtimeV2Checkpoints: { [turn.turnId]: beforeCheckpoint },
    }),
    context: { turnId: turn.turnId },
    now: () => 1,
  };
  const available = executionToolDefinitions.runtimeV2ToolDefinitions({})
    .filter((tool) => [
      "read_file",
      "grep_search",
      "replace_in_file",
      "apply_patch",
      "run_command",
      "record_execution_contract",
    ].includes(tool.function.name));
  const gated = providerTools.selectRuntimeV2ProviderToolDefinitions({
    ports,
    command: {
      ...command("observing"),
      run,
    },
    available,
  });
  assert.deepEqual(gated.map((tool) => tool.function.name), [
    "grep_search",
    "read_file",
    "record_execution_contract",
  ]);
  const gatedContractTool = gated.find((tool) =>
    tool.function.name === "record_execution_contract"
  );
  assert.ok(gatedContractTool);
  if (
    aggregate.objective?.acceptanceEvidenceRequirements?.includes(
      "behavioral",
    )
  ) {
    assert.ok(
      gatedContractTool.function.parameters.required.includes(
        "behavioral_validation",
      ),
      "runtime-owned behavioral acceptance must be encoded in the provider schema before submission",
    );
  }
  const behavioralAggregate = {
    ...aggregate,
    objective: {
      ...(aggregate.objective && typeof aggregate.objective === "object"
        ? aggregate.objective
        : {}),
      acceptanceEvidenceRequirements: ["behavioral"],
    },
  };
  const behavioralCheckpoint = runtime.createRuntimeV2Checkpoint({
    revision: 2,
    aggregate: behavioralAggregate,
    updatedAt: behavioralAggregate.updatedAt,
  });
  const [behavioralContractTool] = providerTools
    .selectRuntimeV2ProviderToolDefinitions({
      ports: {
        ...ports,
        get: () => ({
          runtimeV2Checkpoints: {
            [turn.turnId]: behavioralCheckpoint,
          },
        }),
      },
      command: {
        ...command("observing"),
        run,
      },
      available,
    })
    .filter((tool) => tool.function.name === "record_execution_contract");
  assert.ok(
    behavioralContractTool.function.parameters.required.includes(
      "behavioral_validation",
    ),
  );
  assert.match(
    behavioralContractTool.function.description,
    /build, lint, and typecheck alone are invalid/i,
  );

  const parsedBehavioralContract =
    executionContract.parseRuntimeV2ExecutionContractArguments({
      summary: "Repair the user-visible state flow.",
      root_causes: ["A programmatic state transition triggers a user effect."],
      changes: [{
        operation: "modify",
        targets: ["src/main.js"],
        change: "Separate programmatic loading from user input.",
        expected_outcome: "Loading stays clean.",
      }],
      validations: [{
        kind: "finite_command",
        command: "npm run build",
        expected_outcome: "Static build exits zero.",
      }],
      behavioral_validation: {
        kind: "browser",
        expected_outcome: "Opening a file does not trigger a save dialog.",
      },
    });
  assert.deepEqual(
    parsedBehavioralContract.validations.map((entry) => entry.kind),
    ["finite_command", "browser"],
  );

  const sequenceAfterInitialSources = sequence;
  const rejectedInitialContractCommand = {
    idempotencyKey: "record-initial-contract-rejected",
    kind: "execute_tool",
    phase: "observing",
    run,
    payload: {
      toolCallId: "record-initial-contract-rejected-call",
      toolName: "record_execution_contract",
      arguments: {
        summary: "Incomplete initial contract",
        root_causes: ["A cause without a complete change entry."],
      },
    },
  };
  let rejectedInitialAggregate = runtime.transition(
    aggregate,
    event("command.scheduled", {
      run,
      command: rejectedInitialContractCommand,
    }),
  );
  rejectedInitialAggregate = runtime.transition(
    rejectedInitialAggregate,
    event("tool.completed", {
      run,
      idempotencyKey: rejectedInitialContractCommand.idempotencyKey,
      status: "blocked",
      failureKind: "not_authorized",
      failureReasonCode: "execution_contract_rejected",
      evidence: [],
    }),
  );
  assert.deepEqual(
    executionContract.deriveRuntimeV2ExecutionContractRepair(
      rejectedInitialAggregate,
    ),
    {
      attempts: 1,
      latestSequence: rejectedInitialAggregate.events.at(-1).sequence,
    },
    "an invalid initial contract must enter the same bounded repair window as a revision",
  );
  const rejectedInitialCheckpoint = runtime.createRuntimeV2Checkpoint({
    revision: 2,
    aggregate: rejectedInitialAggregate,
    updatedAt: rejectedInitialAggregate.updatedAt,
  });
  const initialRepairTools =
    providerTools.selectRuntimeV2ProviderToolDefinitions({
      ports: {
        ...ports,
        get: () => ({
          runtimeV2Checkpoints: {
            [turn.turnId]: rejectedInitialCheckpoint,
          },
        }),
      },
      command: {
        ...command("observing"),
        run,
      },
      available,
    });
  assert.deepEqual(
    initialRepairTools.map((tool) => tool.function.name),
    ["record_execution_contract"],
    "a malformed initial contract cannot reopen source discovery",
  );
  const initialRepairPrompt = providerRequest.providerModeInstruction({
    payload: { mode: "execute" },
  }, "", {
    hasReadFile: false,
    hasMutation: false,
    hasSpawnSubagent: false,
    hasWaitSubagents: false,
    executionContractRequired: true,
    executionContractRepairAttempts: 1,
  });
  assert.match(initialRepairPrompt, /complete initial object/i);
  assert.match(initialRepairPrompt, /revision_reason is not needed/i);
  assert.match(initialRepairPrompt, /expected_outcome/i);
  sequence = sequenceAfterInitialSources;

  const contractArguments = {
    summary: "Keep the editor API stable while repairing the caller and owner boundary.",
    root_causes: [
      "Programmatic content replacement dispatches a user input event.",
      "The caller and persistence boundary use inconsistent argument ownership.",
    ],
    changes: [{
      operation: "modify",
      targets: ["src/main.js", "src/components/editor.js"],
      change: "Remove only the synthetic input path and align the existing caller boundary.",
      expected_outcome: "Opening a file remains clean and does not trigger a save dialog.",
    }],
    validations: [{
      kind: "finite_command",
      command: "npm run build",
      expected_outcome: "The bounded production build exits zero.",
    }],
  };
  const contractCommand = {
    idempotencyKey: "record-contract-1",
    kind: "execute_tool",
    phase: "observing",
    run,
    payload: {
      toolCallId: "record-contract-call-1",
      toolName: "record_execution_contract",
      arguments: contractArguments,
    },
  };
  aggregate = runtime.transition(aggregate, event("command.scheduled", {
    run,
    command: contractCommand,
  }));
  aggregate = runtime.transition(aggregate, event("tool.completed", {
    run,
    idempotencyKey: contractCommand.idempotencyKey,
    status: "succeeded",
    evidence: [{
      id: "E-contract",
      kind: "tool",
      target: "record_execution_contract",
      version: "contract-v1",
    }],
  }));
  const recorded = executionContract.deriveRuntimeV2ExecutionContract(
    aggregate,
  );
  const recordedAggregate = aggregate;
  assert.equal(recorded.revision, 1);
  assert.deepEqual(recorded.sourceEvidenceIds.sort(), [
    "E-editor",
    "E-main",
  ]);
  assert.deepEqual(
    executionContract.runtimeV2ExecutionContractMutationTargets(recorded),
    ["src/main.js", "src/components/editor.js"],
  );

  const afterCheckpoint = runtime.createRuntimeV2Checkpoint({
    revision: 2,
    aggregate,
    updatedAt: aggregate.updatedAt,
  });
  const afterPorts = {
    ...ports,
    get: () => ({
      runtimeV2Checkpoints: { [turn.turnId]: afterCheckpoint },
    }),
  };
  const reopened = providerTools.selectRuntimeV2ProviderToolDefinitions({
    ports: afterPorts,
    command: {
      ...command("observing"),
      run,
    },
    available,
  });
  assert.ok(reopened.some((tool) => tool.function.name === "replace_in_file"));
  const replace = reopened.find((tool) =>
    tool.function.name === "replace_in_file"
  );
  assert.deepEqual(replace.function.parameters.properties.path.enum, [
    "src/main.js",
    "src/components/editor.js",
  ]);

  const rejectedRevisionCommand = {
    ...contractCommand,
    idempotencyKey: "record-contract-revision-rejected",
    payload: {
      ...contractCommand.payload,
      toolCallId: "record-contract-revision-call-rejected",
      arguments: {
        summary: "Incomplete revision",
        root_causes: ["A failed acceptance receipt exposed more work."],
      },
    },
  };
  aggregate = runtime.transition(aggregate, event("command.scheduled", {
    run,
    command: rejectedRevisionCommand,
  }));
  aggregate = runtime.transition(aggregate, event("tool.completed", {
    run,
    idempotencyKey: rejectedRevisionCommand.idempotencyKey,
    status: "blocked",
    failureKind: "not_authorized",
    failureReasonCode: "execution_contract_rejected",
    evidence: [],
  }));
  assert.deepEqual(
    executionContract.deriveRuntimeV2ExecutionContractRepair(aggregate),
    {
      attempts: 1,
      latestSequence: aggregate.events.at(-1).sequence,
    },
  );
  const repairCheckpoint = runtime.createRuntimeV2Checkpoint({
    revision: 3,
    aggregate,
    updatedAt: aggregate.updatedAt,
  });
  const repairTools = providerTools.selectRuntimeV2ProviderToolDefinitions({
    ports: {
      ...ports,
      get: () => ({
        runtimeV2Checkpoints: { [turn.turnId]: repairCheckpoint },
      }),
    },
    command: {
      ...command("acting"),
      run,
    },
    available,
  });
  assert.deepEqual(
    repairTools.map((tool) => tool.function.name),
    ["record_execution_contract"],
    "a malformed revision cannot reopen reading or mutation",
  );
  const scopeRejection = authorization.validateToolAgainstPhaseAndPlan({
    ports: {
      ...afterPorts,
      live: executionTypes.createRuntimeV2LiveExecutionState(),
    },
    command: {
      idempotencyKey: "out-of-contract-mutation",
      kind: "execute_tool",
      phase: "observing",
      run,
      payload: { toolCallId: "out-of-contract-call" },
    },
    toolName: "replace_in_file",
    args: {
      path: "src/components/statusbar.js",
      search_text: "old",
      replace_text: "new",
    },
    target: "src/components/statusbar.js",
  });
  assert.equal(scopeRejection.allowed, false);
  assert.equal(
    scopeRejection.reasonCode,
    "execution_contract_mutation_scope",
  );
  const prompt = providerRequest.providerModeInstruction({
    payload: { mode: "execute" },
  }, "", {
    hasReadFile: true,
    hasMutation: true,
    hasSpawnSubagent: false,
    hasWaitSubagents: false,
    executionContract: recorded,
  });
  assert.match(prompt, /execution_contract_v1/);
  assert.match(prompt, /do not broaden into cleanup or redesign/i);

  const mutationCommand = {
    idempotencyKey: "contract-mutation-editor",
    kind: "execute_tool",
    phase: "acting",
    run,
    payload: {
      toolCallId: "contract-mutation-editor-call",
      toolName: "replace_in_file",
      arguments: {
        path: "src/components/editor.js",
        search_text: "old",
        replace_text: "new",
      },
    },
  };
  const mutationEvidence = {
      id: "E-mutation-editor",
      kind: "mutation",
      target: "src/components/editor.js",
      version: null,
  };
  const mutatedAggregate = {
    ...recordedAggregate,
    evidence: [...recordedAggregate.evidence, mutationEvidence],
    events: [
      ...recordedAggregate.events,
      event("command.scheduled", { run, command: mutationCommand }),
      event("tool.completed", {
        run,
        idempotencyKey: mutationCommand.idempotencyKey,
        status: "succeeded",
        evidence: [mutationEvidence],
      }),
    ],
  };
  const advance =
    executionContractAdvance.deriveRuntimeV2ExecutionContractAdvance(
      mutatedAggregate,
    );
  assert.equal(advance.required, true);
  assert.deepEqual(advance.committedTargets, [
    "src/components/editor.js",
  ]);
  assert.deepEqual(advance.pendingTargets, ["src/main.js"]);
  assert.equal(
    advance.sourceReviewAvailable,
    false,
    "a pending contract target must advance before optional post-edit inspection reopens",
  );
  assert.deepEqual(advance.sourceReviewTargets, [
    "src/components/editor.js",
  ]);
  assert.equal(advance.sourceReviewReceiptCount, 0);
  const advanceCheckpoint = runtime.createRuntimeV2Checkpoint({
    revision: 4,
    aggregate: mutatedAggregate,
    updatedAt: mutatedAggregate.updatedAt,
  });
  const advanceTools = providerTools.selectRuntimeV2ProviderToolDefinitions({
    ports: {
      ...ports,
      get: () => ({
        runtimeV2Checkpoints: { [turn.turnId]: advanceCheckpoint },
      }),
    },
    command: {
      ...command("validating"),
      run,
      payload: {
        ...command("validating").payload,
        mode: "validate",
      },
    },
    available,
  });
  const reviewRead = advanceTools.find((tool) =>
    tool.function.name === "read_file"
  );
  assert.equal(reviewRead, undefined);
  assert.equal(
    advanceTools.some((tool) =>
      ["replace_in_file", "apply_patch", "write_file"].includes(
        tool.function.name,
      )
    ),
    true,
    "the next contracted mutation remains directly executable",
  );
  assert.equal(
    advanceTools.some((tool) =>
      tool.function.name === "run_command" ||
      tool.function.name === "browser_evaluate"
    ),
    false,
    "validation cannot skip a contract target that has not received its implementation mutation",
  );
  const recoveryAdvanceTools =
    providerTools.selectRuntimeV2ProviderToolDefinitions({
      ports: {
        ...ports,
        get: () => ({
          runtimeV2Checkpoints: { [turn.turnId]: advanceCheckpoint },
        }),
      },
      command: {
        ...command("validating"),
        run,
        payload: {
          ...command("validating").payload,
          mode: "validate",
        },
      },
      available,
      actionWindow: "closed_recovery",
      correctiveValidationCommand: "npm run build",
    });
  assert.equal(
    recoveryAdvanceTools.some((tool) =>
      tool.function.name === "run_command" ||
      tool.function.name === "browser_evaluate"
    ),
    false,
    "closed recovery cannot advertise validation while a contracted mutation is pending",
  );
  assert.equal(
    recoveryAdvanceTools.some((tool) =>
      ["replace_in_file", "apply_patch", "write_file"].includes(
        tool.function.name,
      )
    ),
    true,
  );
  const advancePorts = {
    ...ports,
    live: executionTypes.createRuntimeV2LiveExecutionState(),
    get: () => ({
      runtimeV2Checkpoints: { [turn.turnId]: advanceCheckpoint },
    }),
  };
  const prematureValidation = authorization.validateToolAgainstPhaseAndPlan({
    ports: advancePorts,
    command: {
      idempotencyKey: "premature-contract-validation",
      kind: "execute_validation",
      phase: "validating",
      run,
      payload: {
        mode: "validate",
        toolName: "run_command",
        arguments: { command: "npm run build" },
      },
    },
    toolName: "run_command",
    args: { command: "npm run build" },
    target: "npm run build",
  });
  assert.equal(prematureValidation.allowed, false);
  assert.equal(
    prematureValidation.reasonCode,
    "execution_contract_pending_mutations",
  );
  const outOfReviewRead = authorization.validateToolAgainstPhaseAndPlan({
    ports: advancePorts,
    command: {
      idempotencyKey: "out-of-review-read",
      kind: "execute_tool",
      phase: "validating",
      run,
      payload: {
        mode: "validate",
        toolName: "read_file",
        arguments: { path: "src/main.js" },
      },
    },
    toolName: "read_file",
    args: { path: "src/main.js" },
    target: "src/main.js",
  });
  assert.equal(outOfReviewRead.allowed, false);
  assert.equal(
    outOfReviewRead.reasonCode,
    "execution_contract_source_review_scope",
  );

  const reviewedAggregate = mutatedAggregate;
  const reviewedAdvance =
    executionContractAdvance.deriveRuntimeV2ExecutionContractAdvance(
      reviewedAggregate,
    );
  assert.equal(reviewedAdvance.required, true);
  assert.equal(reviewedAdvance.sourceReviewAvailable, false);
  assert.equal(reviewedAdvance.sourceReviewReceiptCount, 0);
  const reviewedCheckpoint = runtime.createRuntimeV2Checkpoint({
    revision: 5,
    aggregate: reviewedAggregate,
    updatedAt: reviewedAggregate.updatedAt,
  });
  const reviewedTools = providerTools.selectRuntimeV2ProviderToolDefinitions({
    ports: {
      ...ports,
      get: () => ({
        runtimeV2Checkpoints: { [turn.turnId]: reviewedCheckpoint },
      }),
    },
    command: {
      ...command("validating"),
      run,
      payload: {
        ...command("validating").payload,
        mode: "validate",
      },
    },
    available,
  });
  assert.equal(
    reviewedTools.some((tool) => tool.function.name === "read_file"),
    false,
    "post-edit inspection remains closed until all contracted mutations commit",
  );

  const mainMutationCommand = {
    ...mutationCommand,
    idempotencyKey: "contract-mutation-main",
    payload: {
      ...mutationCommand.payload,
      toolCallId: "contract-mutation-main-call",
      arguments: {
        ...mutationCommand.payload.arguments,
        path: "src/main.js",
      },
    },
  };
  const completeAggregate = {
    ...reviewedAggregate,
    events: [
      ...reviewedAggregate.events,
      event("command.scheduled", { run, command: mainMutationCommand }),
      event("tool.completed", {
        run,
        idempotencyKey: mainMutationCommand.idempotencyKey,
        status: "succeeded",
        evidence: [{
          id: "E-mutation-main",
          kind: "mutation",
          target: "src/main.js",
          version: null,
        }],
      }),
      event("tool.completed", {
        run,
        idempotencyKey: "contract-review-main",
        status: "succeeded",
        evidence: [{
          id: "E-review-main",
          kind: "source",
          target: "src/main.js",
          version: "main-v2",
        }],
      }),
    ],
  };
  const completeAdvance =
    executionContractAdvance.deriveRuntimeV2ExecutionContractAdvance(
      completeAggregate,
    );
  assert.deepEqual(completeAdvance.pendingTargets, []);
  assert.equal(completeAdvance.sourceReviewAvailable, false);
  const completeCheckpoint = runtime.createRuntimeV2Checkpoint({
    revision: 6,
    aggregate: completeAggregate,
    updatedAt: completeAggregate.updatedAt,
  });
  const validationOnlyTools =
    providerTools.selectRuntimeV2ProviderToolDefinitions({
      ports: {
        ...ports,
        get: () => ({
          runtimeV2Checkpoints: {
            [turn.turnId]: completeCheckpoint,
          },
        }),
      },
      command: {
        ...command("validating"),
        run,
        payload: {
          ...command("validating").payload,
          mode: "validate",
        },
      },
      available,
    });
  assert.deepEqual(
    validationOnlyTools.map((tool) => tool.function.name),
    ["run_command"],
    "once every contract target and the one self-review batch are complete, only a finite validation may advance the boundary",
  );

  const failedAggregate = {
    ...completeAggregate,
    events: [...completeAggregate.events, event("validation.completed", {
      run,
      idempotencyKey: "failed-contract-validation",
      passed: false,
      failureKind: "assertion_failed",
      evidence: [],
      presentation: {
        message: [
          "FRESH_ACCEPTANCE_FAILED",
          "src/components/editor.js:190:1 - programmatic input remains dirty",
          "src/main.js:389:1 - pristine tab replacement remains incomplete",
        ].join("\n"),
      },
    })],
  };
  const failedCheckpoint = runtime.createRuntimeV2Checkpoint({
    revision: 7,
    aggregate: failedAggregate,
    updatedAt: failedAggregate.updatedAt,
  });
  const correctionReadTools =
    providerTools.selectRuntimeV2ProviderToolDefinitions({
      ports: {
        ...ports,
        get: () => ({
          runtimeV2Checkpoints: {
            [turn.turnId]: failedCheckpoint,
          },
        }),
      },
      command: {
        ...command("validating"),
        run,
        payload: {
          ...command("validating").payload,
          mode: "validate",
        },
      },
      available,
    });
  assert.deepEqual(
    correctionReadTools.map((tool) => tool.function.name),
    [
      "grep_search",
      "read_file",
      "replace_in_file",
      "apply_patch",
    ],
    "a failed acceptance receipt supersedes the pre-edit outline and returns to one ordinary inspect/edit surface",
  );
  assert.equal(
    correctionReadTools.find((tool) => tool.function.name === "read_file")
      .function.parameters.properties.path.enum,
    undefined,
    "diagnostic locations guide the model but do not become a project-specific path lock",
  );
  for (const toolName of ["replace_in_file", "apply_patch"]) {
    assert.equal(
      correctionReadTools.find((tool) => tool.function.name === toolName)
        .function.parameters.properties.path?.enum,
      undefined,
      "new acceptance evidence must not retain the stale contract target enum",
    );
  }
  const correctionClosedTools =
    providerTools.selectRuntimeV2ProviderToolDefinitions({
      ports: {
        ...ports,
        get: () => ({
          runtimeV2Checkpoints: {
            [turn.turnId]: failedCheckpoint,
          },
        }),
      },
      command: {
        ...command("validating"),
        run,
        payload: {
          ...command("validating").payload,
          mode: "validate",
        },
      },
      available,
      actionWindow: "closed_recovery",
    });
  assert.deepEqual(
    correctionClosedTools.map((tool) => tool.function.name),
    ["replace_in_file", "apply_patch"],
  );
  assert.equal(
    correctionClosedTools.find((tool) =>
      tool.function.name === "replace_in_file"
    ).function.parameters.properties.path.enum,
    undefined,
    "closed recovery must force an edit without forcing it back into the stale pre-validation scope",
  );

  const unavailableValidationCommand = {
    idempotencyKey: "missing-contract-validator",
    kind: "execute_validation",
    phase: "validating",
    run,
    payload: {
      toolCallId: "missing-contract-validator-call",
      mode: "validate",
      toolName: "run_command",
      arguments: { command: "npm run build" },
    },
  };
  const unavailableAggregate = {
    ...completeAggregate,
    events: [
      ...completeAggregate.events,
      event("command.scheduled", {
        run,
        command: unavailableValidationCommand,
      }),
      event("validation.completed", {
        run,
        idempotencyKey: unavailableValidationCommand.idempotencyKey,
        passed: false,
        failureKind: "execution_failed",
        evidence: [],
        presentation: {
          message: 'npm error Missing script: "build"',
        },
      }),
    ],
  };
  const unavailableCorrection =
    validationCorrection.deriveRuntimeV2ValidationCorrectionWindow(
      unavailableAggregate,
    );
  assert.equal(unavailableCorrection.validationCommandUnavailable, true);
  assert.equal(
    unavailableCorrection.failedValidationCommand,
    "npm run build",
  );
  assert.deepEqual(unavailableCorrection.diagnosticSourceHints, []);
  const unavailableCheckpoint = runtime.createRuntimeV2Checkpoint({
    revision: 8,
    aggregate: unavailableAggregate,
    updatedAt: unavailableAggregate.updatedAt,
  });
  const unavailablePorts = {
    ...ports,
    live: executionTypes.createRuntimeV2LiveExecutionState(),
    get: () => ({
      runtimeV2Checkpoints: {
        [turn.turnId]: unavailableCheckpoint,
      },
    }),
  };
  const replacementTools =
    providerTools.selectRuntimeV2ProviderToolDefinitions({
      ports: unavailablePorts,
      command: {
        ...command("validating"),
        run,
        payload: {
          ...command("validating").payload,
          mode: "validate",
        },
      },
      available,
    });
  assert.deepEqual(
    replacementTools.map((tool) => tool.function.name),
    ["run_command"],
    "an unavailable validator opens one alternate finite validation action, not a source or mutation loop",
  );
  assert.equal(
    replacementTools[0].function.parameters.properties.command?.enum,
    undefined,
    "the failed sealed command must not remain the only executable enum",
  );
  const repeatedValidator = authorization.validateToolAgainstPhaseAndPlan({
    ports: unavailablePorts,
    command: unavailableValidationCommand,
    toolName: "run_command",
    args: { command: "npm run build" },
    target: "npm run build",
  });
  assert.equal(repeatedValidator.allowed, false);
  assert.equal(
    repeatedValidator.reasonCode,
    "failed_validation_command_repeated",
  );
  const alternateValidator = authorization.validateToolAgainstPhaseAndPlan({
    ports: unavailablePorts,
    command: {
      ...unavailableValidationCommand,
      idempotencyKey: "alternate-validator",
      payload: {
        ...unavailableValidationCommand.payload,
        arguments: { command: "npm test" },
      },
    },
    toolName: "run_command",
    args: { command: "npm test" },
    target: "npm test",
  });
  assert.equal(
    alternateValidator.allowed,
    true,
    "a materially different finite validator may replace an operationally unavailable sealed command",
  );

  const alternateFailureCommand = {
    ...unavailableValidationCommand,
    idempotencyKey: "alternate-validator-failed",
    payload: {
      ...unavailableValidationCommand.payload,
      toolCallId: "alternate-validator-failed-call",
      arguments: { command: "npm test" },
    },
  };
  const exhaustedAggregate = {
    ...unavailableAggregate,
    events: [
      ...unavailableAggregate.events,
      event("command.scheduled", {
        run,
        command: alternateFailureCommand,
      }),
      event("validation.completed", {
        run,
        idempotencyKey: alternateFailureCommand.idempotencyKey,
        passed: false,
        failureKind: "execution_failed",
        evidence: [],
        presentation: { message: "test runner is unavailable" },
      }),
    ],
  };
  const exhaustedCheckpoint = runtime.createRuntimeV2Checkpoint({
    revision: 9,
    aggregate: exhaustedAggregate,
    updatedAt: exhaustedAggregate.updatedAt,
  });
  assert.deepEqual(
    providerTools.selectRuntimeV2ProviderToolDefinitions({
      ports: {
        ...unavailablePorts,
        get: () => ({
          runtimeV2Checkpoints: {
            [turn.turnId]: exhaustedCheckpoint,
          },
        }),
      },
      command: {
        ...command("validating"),
        run,
        payload: {
          ...command("validating").payload,
          mode: "validate",
        },
      },
      available,
    }),
    [],
    "two source-less operational validator failures must hand off instead of cycling commands",
  );

  const advancePrompt = providerRequest.providerModeInstruction({
    payload: { mode: "validate" },
  }, "npm run build", {
    hasReadFile: false,
    hasMutation: true,
    hasSpawnSubagent: false,
    hasWaitSubagents: false,
    executionContract: recorded,
    executionContractAdvanceRequired: true,
    executionContractCommittedTargets: advance.committedTargets,
    executionContractPendingTargets: advance.pendingTargets,
    executionContractSourceReviewAvailable: false,
    executionContractSourceReviewTargets: advance.sourceReviewTargets,
  });
  assert.match(advancePrompt, /open-ended investigation is closed/i);
  assert.match(advancePrompt, /src\/main\.js/);
  assert.match(advancePrompt, /Submit one concrete mutation/i);
  assert.match(
    advancePrompt,
    /Validation remains unavailable until every pending contract target/i,
  );
  assert.doesNotMatch(
    advancePrompt,
    /Validate the latest committed mutation now/i,
  );
});

test("an Execute contract rejects unread targets, silent revisions, and scope drift", () => {
  const aggregate = {
    strategy: "execute",
    evidence: [
      { id: "E1", kind: "source", target: "src/main.js", version: "v1" },
      { id: "E2", kind: "source", target: "src/editor.js", version: "v1" },
    ],
    events: [
      { sequence: 1, type: "tool.completed", status: "succeeded", evidence: [
        { id: "E1", kind: "source", target: "src/main.js", version: "v1" },
      ] },
      { sequence: 2, type: "tool.completed", status: "succeeded", evidence: [
        { id: "E2", kind: "source", target: "src/editor.js", version: "v1" },
      ] },
    ],
  };
  const base = {
    summary: "Repair the proved two-owner event flow.",
    root_causes: ["The caller turns a programmatic update into user input."],
    changes: [{
      operation: "modify",
      targets: ["src/main.js"],
      change: "Preserve the public API and remove only the synthetic event.",
      expected_outcome: "Programmatic open stays clean.",
    }],
    validations: [{
      kind: "finite_command",
      command: "npm test",
      expected_outcome: "The bounded test exits zero.",
    }],
  };
  assert.equal(
    executionContract.validateRuntimeV2ExecutionContractSubmission({
      aggregate,
      args: base,
    }).allowed,
    true,
  );
  const longRunning =
    executionContract.validateRuntimeV2ExecutionContractSubmission({
      aggregate,
      args: {
        ...base,
        validations: [{
          kind: "finite_command",
          command: "npm run dev",
          expected_outcome: "The watcher starts.",
        }],
      },
    });
  assert.equal(longRunning.allowed, false);
  assert.match(longRunning.reason, /services and observers/i);
  const behavioralAggregate = {
    ...aggregate,
    objective: {
      acceptanceEvidenceRequirements: ["behavioral"],
    },
  };
  const staticOnly =
    executionContract.validateRuntimeV2ExecutionContractSubmission({
      aggregate: behavioralAggregate,
      args: {
        ...base,
        validations: [{
          kind: "finite_command",
          command: "npm run build",
          expected_outcome: "The build exits zero.",
        }],
      },
    });
  assert.equal(staticOnly.allowed, false);
  assert.match(staticOnly.reason, /behavioral acceptance floor/i);
  assert.equal(
    executionContract.validateRuntimeV2ExecutionContractSubmission({
      aggregate: behavioralAggregate,
      args: base,
    }).allowed,
    true,
    "a finite test can satisfy the behavioral planning floor",
  );
  const unread = executionContract.validateRuntimeV2ExecutionContractSubmission({
    aggregate,
    args: {
      ...base,
      changes: [{
        ...base.changes[0],
        targets: ["src/unread.js"],
      }],
    },
  });
  assert.equal(unread.allowed, false);
  assert.match(unread.reason, /Unread targets: src\/unread\.js/);
  const contract = {
    schemaVersion: "runtime-v2-execution-contract.v1",
    revision: 1,
    summary: base.summary,
    rootCauses: base.root_causes,
    changes: executionContract.parseRuntimeV2ExecutionContractArguments(base).changes,
    validations: executionContract.parseRuntimeV2ExecutionContractArguments(base).validations,
    revisionReason: null,
    sourceEvidenceIds: ["E1"],
    recordedAtSequence: 3,
  };
  assert.equal(executionContract.runtimeV2ExecutionContractAllowsTargets({
    contract,
    targets: ["src/main.js"],
  }), true);
  assert.equal(executionContract.runtimeV2ExecutionContractAllowsTargets({
    contract,
    targets: ["src/editor.js"],
  }), false);
});

test("contract preparation allows two novel supplemental provider batches then closes discovery", () => {
  const readCommand = (key, callId, target) => ({
    idempotencyKey: key,
    kind: "execute_tool",
    payload: {
      toolCallId: callId,
      toolName: "read_file",
      arguments: { path: target },
    },
  });
  const sourceCompletion = (sequence, key, id, target) => ({
    sequence,
    type: "tool.completed",
    idempotencyKey: key,
    status: "succeeded",
    evidence: [{ id, kind: "source", target, version: `${id}-v1` }],
  });
  const firstCommands = [
    readCommand("read-main", "call-main", "src/main.js"),
    readCommand("read-editor", "call-editor", "src/components/editor.js"),
  ];
  const thresholdEvents = [{
    sequence: 1,
    type: "provider.responded",
    result: {
      toolCalls: firstCommands.map((entry) => ({
        id: entry.payload.toolCallId,
        name: "read_file",
        arguments: entry.payload.arguments,
      })),
    },
  }, ...firstCommands.map((entry, index) => ({
    sequence: index + 2,
    type: "command.scheduled",
    command: entry,
  })), sourceCompletion(4, "read-main", "E-main", "src/main.js"),
  sourceCompletion(5, "read-editor", "E-editor", "src/components/editor.js")];
  const thresholdAggregate = {
    strategy: "execute",
    evidence: thresholdEvents.flatMap((entry) => entry.evidence || []),
    events: thresholdEvents,
  };

  assert.deepEqual(
    executionContract.runtimeV2ExecutionContractReadWindow(
      thresholdAggregate,
    ),
    { supplementalReadBatches: 0, closed: false },
  );

  const supplementalCommand = readCommand(
    "read-handler",
    "call-handler",
    "src-tauri/src/main.rs",
  );
  const supplementalEvents = [{
    sequence: 6,
    type: "provider.responded",
    result: {
      toolCalls: [{
        id: "call-handler",
        name: "read_file",
        arguments: supplementalCommand.payload.arguments,
      }],
    },
  }, {
    sequence: 7,
    type: "command.scheduled",
    command: supplementalCommand,
  }, sourceCompletion(
    8,
    "read-handler",
    "E-handler",
    "src-tauri/src/main.rs",
  )];
  const firstSupplementalAggregate = {
    ...thresholdAggregate,
    evidence: [
      ...thresholdAggregate.evidence,
      ...supplementalEvents.flatMap((entry) => entry.evidence || []),
    ],
    events: [...thresholdEvents, ...supplementalEvents],
  };

  assert.deepEqual(
    executionContract.runtimeV2ExecutionContractReadWindow(
      firstSupplementalAggregate,
    ),
    { supplementalReadBatches: 1, closed: false },
  );
  const entryCommand = readCommand(
    "read-entry",
    "call-entry",
    "index.html",
  );
  const entryEvents = [{
    sequence: 9,
    type: "provider.responded",
    result: {
      toolCalls: [{
        id: "call-entry",
        name: "read_file",
        arguments: entryCommand.payload.arguments,
      }],
    },
  }, {
    sequence: 10,
    type: "command.scheduled",
    command: entryCommand,
  }, sourceCompletion(11, "read-entry", "E-entry", "index.html")];
  const closedAggregate = {
    ...firstSupplementalAggregate,
    evidence: [
      ...firstSupplementalAggregate.evidence,
      ...entryEvents.flatMap((entry) => entry.evidence || []),
    ],
    events: [...firstSupplementalAggregate.events, ...entryEvents],
  };
  assert.deepEqual(
    executionContract.runtimeV2ExecutionContractReadWindow(closedAggregate),
    { supplementalReadBatches: 2, closed: true },
  );
  const prompt = providerRequest.providerModeInstruction({
    payload: { mode: "execute" },
  }, "", {
    hasReadFile: false,
    hasMutation: false,
    hasSpawnSubagent: false,
    hasWaitSubagents: false,
    executionContractRequired: true,
    executionContractReadWindowClosed: true,
  });
  assert.match(prompt, /observation branch is closed/i);
  assert.match(prompt, /call record_execution_contract now/i);
});

test("a contract-only native decision locks provider tool choice to the contract", () => {
  const contractTool = executionToolDefinitions.runtimeV2ToolDefinitions({})
    .find((tool) => tool.function.name === "record_execution_contract");
  const readTool = executionToolDefinitions.runtimeV2ToolDefinitions({})
    .find((tool) => tool.function.name === "read_file");
  assert.deepEqual(
    providerRequest.runtimeV2ExecutionEffectiveToolChoice({
      requested: null,
      tools: [contractTool],
      textEnvelope: false,
    }),
    {
      type: "function",
      function: { name: "record_execution_contract" },
    },
  );
  assert.equal(
    providerRequest.runtimeV2ExecutionEffectiveToolChoice({
      requested: null,
      tools: [contractTool, readTool],
      textEnvelope: false,
    }),
    null,
  );
  assert.equal(
    providerRequest.runtimeV2ExecutionEffectiveToolChoice({
      requested: null,
      tools: [contractTool, readTool],
      textEnvelope: false,
      forceStructuredAction: true,
    }),
    "required",
  );
  assert.deepEqual(
    providerRequest.runtimeV2ExecutionEffectiveToolChoice({
      requested: null,
      tools: [readTool],
      textEnvelope: false,
      forceStructuredAction: true,
    }),
    {
      type: "function",
      function: { name: "read_file" },
    },
  );
});

test("every provider decision states the exact current tool surface", () => {
  const contractTool = executionToolDefinitions.runtimeV2ToolDefinitions({})
    .find((tool) => tool.function.name === "record_execution_contract");
  const readTool = executionToolDefinitions.runtimeV2ToolDefinitions({})
    .find((tool) => tool.function.name === "read_file");
  assert.match(
    providerRequest.runtimeV2CurrentToolSurfaceInstruction(
      [contractTool],
      true,
    ),
    /exactly 1 tool: record_execution_contract.*requires exactly one structured action.*must be record_execution_contract/i,
  );
  assert.match(
    providerRequest.runtimeV2CurrentToolSurfaceInstruction([
      readTool,
      contractTool,
    ]),
    /exactly 2 tools: read_file, record_execution_contract/i,
  );
  assert.match(
    providerRequest.runtimeV2CurrentToolSurfaceInstruction([]),
    /exposes no tools.*do not emit a tool name/i,
  );
});

test("contract formation keeps committed evidence without executable old tool shapes", () => {
  const projected = executionContractFormation
    .runtimeV2ExecutionContractFormationConversation([{
      role: "system",
      content: "runtime rules",
    }, {
      role: "user",
      content: "repair the complete incident",
    }, {
      role: "assistant",
      content: "",
      reasoning_content: "I should read another file",
      tool_calls: [{
        id: "old-read",
        type: "function",
        function: {
          name: "read_file",
          arguments: JSON.stringify({ path: "src/main.js" }),
        },
      }],
    }, {
      role: "tool",
      tool_call_id: "old-read",
      content: "READ_FILE_RESULT\npath: src/main.js\n---CONTENT START---\ncode\n---CONTENT END---",
    }, {
      role: "assistant",
      content: "A long self-authored reconsideration.",
    }]);

  assert.deepEqual(projected.map((message) => message.role), ["system", "user"]);
  assert.equal(projected.some((message) => message.tool_calls?.length), false);
  assert.equal(projected.some((message) => message.tool_call_id), false);
  assert.match(String(projected[1].content), /committed_observation_receipts_v1/);
  assert.match(String(projected[1].content), /path: src\/main\.js/);
  assert.doesNotMatch(
    projected.map((message) => String(message.content)).join("\n"),
    /long self-authored reconsideration/,
  );
});

test("forced action evidence projection removes stale tool-call templates", () => {
  const projected = executionContractFormation
    .runtimeV2EvidenceOnlyDecisionConversation([{
      role: "system",
      content: "runtime rules",
    }, {
      role: "user",
      content: "fix it",
      runtimeTurnId: "turn-forced-action",
    }, {
      role: "assistant",
      content: "I will read it.",
      tool_calls: [{
        id: "old-read",
        type: "function",
        function: {
          name: "read_file",
          arguments: JSON.stringify({ path: "src/main.js" }),
        },
      }],
    }, {
      role: "tool",
      tool_call_id: "old-read",
      content: [
        "READ_FILE_RESULT",
        "path: src/main.js",
        "contentVersion: sha256-current",
        "truncated: false",
        "totalLines: 1",
        "totalChars: 18",
        "returnedLines: 1-1",
        "returnedChars: 18",
        "---CONTENT START---",
        "const ready = true;",
        "---CONTENT END---",
      ].join("\n"),
    }]);
  assert.equal(
    projected.some((message) => (message.tool_calls || []).length > 0),
    false,
  );
  assert.equal(
    projected.some((message) => message.role === "tool"),
    false,
  );
  const text = projected.map((message) => String(message.content || ""))
    .join("\n");
  assert.match(text, /committed_source_snapshot_v1/);
  assert.match(text, /const ready = true/);
});

test("contract formation emits one latest-version source snapshot without overlapping lines", () => {
  const readResult = ({ path, version, start, end, total, content }) => [
    "READ_FILE_RESULT",
    `path: ${path}`,
    `contentVersion: ${version}`,
    `truncated: ${start !== 1 || end !== total}`,
    `totalLines: ${total}`,
    `totalChars: 999`,
    `returnedLines: ${start}-${end}`,
    `returnedChars: ${content.length}`,
    "---CONTENT START---",
    content,
    "---CONTENT END---",
  ].join("\n");
  const readPair = (id, version, start, end, content) => [{
    role: "assistant",
    content: "",
    tool_calls: [{
      id,
      type: "function",
      function: {
        name: "read_file",
        arguments: JSON.stringify({
          path: "src/main.js",
          start_line: start,
          end_line: end,
        }),
      },
    }],
  }, {
    role: "tool",
    tool_call_id: id,
    content: readResult({
      path: "src/main.js",
      version,
      start,
      end,
      total: 5,
      content,
    }),
  }];
  const projected = executionContractFormation
    .runtimeV2ExecutionContractFormationConversation([{
      role: "system",
      content: "runtime rules",
    }, {
      role: "user",
      runtimeTurnId: "turn-current",
      content: "repair the complete incident",
    }, ...readPair("old", "main-v1", 1, 2, "OLD_LINE_1\nOLD_LINE_2"),
    ...readPair("new-prefix", "main-v2", 1, 3, "NEW_LINE_1\nNEW_LINE_2\nNEW_LINE_3"),
    ...readPair("new-tail", "main-v2", 3, 5, "NEW_LINE_3\nNEW_LINE_4\nNEW_LINE_5"), {
      role: "assistant",
      content: "",
      tool_calls: [{
        id: "rejected-contract",
        type: "function",
        function: {
          name: "record_execution_contract",
          arguments: JSON.stringify({
            summary: "KEEP_THIS_REJECTED_SUMMARY",
            validations: [{ kind: "finite_command", command: "npm run build" }],
          }),
        },
      }],
    }, {
      role: "tool",
      tool_call_id: "rejected-contract",
      content: "EXECUTION_CONTRACT_REJECTED: add behavioral_validation.",
    }, {
      role: "assistant",
      content: "I will narrate the plan instead of submitting it.",
    }]);

  assert.deepEqual(projected.map((message) => message.role), ["system", "user"]);
  const snapshot = String(projected[1].content);
  assert.match(snapshot, /committed_source_snapshot_v1/);
  assert.match(snapshot, /contentVersion: main-v2/);
  assert.doesNotMatch(snapshot, /main-v1|OLD_LINE/);
  for (const line of [1, 2, 3, 4, 5]) {
    assert.equal(
      snapshot.match(new RegExp(`NEW_LINE_${line}`, "g"))?.length || 0,
      1,
      `source line ${line} should appear exactly once`,
    );
  }
  assert.doesNotMatch(snapshot, /READ_FILE_RESULT|narrate the plan/);
  assert.match(snapshot, /previous_submission_json \(data only\)/);
  assert.match(snapshot, /KEEP_THIS_REJECTED_SUMMARY/);
  assert.match(snapshot, /add behavioral_validation/);
});

test("a failed validation preserves diagnostic guidance without creating a read sub-state machine", () => {
  const base = {
    events: [{
      sequence: 1,
      type: "tool.completed",
      status: "succeeded",
      evidence: [{
        id: "E-mutation",
        kind: "mutation",
        target: "src/main.js",
        version: null,
      }],
    }, {
      sequence: 2,
      type: "validation.completed",
      passed: false,
      failureKind: "assertion_failed",
      evidence: [],
      presentation: {
        message: [
          "FRESH_ACCEPTANCE_FAILED",
          "file: /workspace/src/main.js:417:15 - duplicate declaration",
          "src/components/editor.js:190:1 - programmatic input remains dirty",
          "src/main.js:389 - duplicate open path remains",
        ].join("\n"),
      },
    }],
  };
  assert.deepEqual(
    validationCorrection.deriveRuntimeV2ValidationCorrectionWindow(base),
    {
      active: true,
      failureSequence: 2,
      repeatedFailedValidations: 0,
      validationCommandUnavailable: false,
      failedValidationCommand: null,
      diagnosticSourceHints: [{
        target: "/workspace/src/main.js",
        line: 417,
        startLine: 393,
        endLine: 441,
      }, {
        target: "src/components/editor.js",
        line: 190,
        startLine: 166,
        endLine: 214,
      }, {
        target: "src/main.js",
        line: 389,
        startLine: 365,
        endLine: 413,
      }],
    },
  );
  const readCommand = {
    idempotencyKey: "correction-read",
    kind: "execute_tool",
    payload: {
      toolCallId: "correction-read-call",
      toolName: "read_file",
      arguments: { path: "src/main.js", start_line: 260, end_line: 420 },
    },
  };
  const afterRead = {
    events: [...base.events, {
      sequence: 3,
      type: "provider.responded",
      result: {
        toolCalls: [{
          id: "correction-read-call",
          name: "read_file",
          arguments: readCommand.payload.arguments,
        }],
      },
    }, {
      sequence: 4,
      type: "command.scheduled",
      command: readCommand,
    }, {
      sequence: 5,
      type: "tool.completed",
      idempotencyKey: readCommand.idempotencyKey,
      status: "succeeded",
      evidence: [{
        id: "E-correction-source",
        kind: "source",
        target: "src/main.js",
        version: "main-v2",
      }],
    }],
  };
  const afterSource =
    validationCorrection.deriveRuntimeV2ValidationCorrectionWindow(afterRead);
  assert.equal(afterSource.active, true);
  assert.deepEqual(
    afterSource.diagnosticSourceHints,
    validationCorrection.deriveRuntimeV2ValidationCorrectionWindow(base)
      .diagnosticSourceHints,
    "ordinary source reads neither consume nor manufacture validation authority",
  );
  const prompt = providerRequest.providerModeInstruction({
    payload: { mode: "validate" },
  }, "", {
    hasReadFile: true,
    hasMutation: true,
    hasSpawnSubagent: false,
    hasWaitSubagents: false,
    validationCorrectionActive: true,
  });
  assert.match(prompt, /VALIDATION_CORRECTION/);
  assert.match(prompt, /ordinary focused source reads/i);
  assert.match(prompt, /Validation remains withheld until a workspace mutation/i);
  assert.doesNotMatch(prompt, /Validate the latest committed mutation now/i);

  const closedTools = providerTools.selectRuntimeV2ProviderToolDefinitions({
    ports: {
      get: () => afterRead,
      context: { runWorkspace: "/workspace" },
    },
    command: {
      payload: { mode: "execute" },
    },
    available: [
      "read_file",
      "grep_search",
      "replace_in_file",
      "apply_patch",
      "write_file",
      "run_command",
    ].map(definition),
    actionWindow: "closed_recovery",
  }).map((tool) => tool.function.name);
  assert.deepEqual(
    closedTools,
    ["replace_in_file", "apply_patch", "write_file"],
    "general no-effect recovery must close reads even while failed-validation guidance remains active",
  );
});

test("every task kind advertised by the Runtime v2 child schema is executable", () => {
  const spawn = executionToolDefinitions.runtimeV2ToolDefinitions()
    .find((definition) =>
      definition.function.name === "spawn_subagent"
    );
  assert.ok(spawn);
  const taskKinds =
    spawn.function.parameters.properties.task_kind.enum;
  assert.deepEqual(taskKinds, ["explore", "review", "validate", "implement"]);
  assert.deepEqual(
    spawn.function.parameters.properties.access_mode.enum,
    ["read", "write"],
  );
  assert.ok(
    spawn.function.parameters.required.includes("required_paths"),
  );
  assert.doesNotMatch(
    spawn.function.description,
    /唯一工具|必须先创建|only tool|must first/i,
  );

  for (const taskKind of taskKinds) {
    const candidate =
      subagentCandidate.runtimeV2ModelSelectedSubagentCandidate({
        idempotencyKey: `schedule-${taskKind}`,
        kind: "schedule_subagents",
        phase: "acting",
        run: {
          sessionKey: "session",
          sessionEpoch: "epoch",
          turnId: "turn",
          runId: "run",
          parentRunId: null,
          attemptId: "attempt",
        },
        payload: {
          toolCallId: `provider-${taskKind}`,
          arguments: {
            task_key: `child-${taskKind}`,
            task_kind: taskKind,
            name: `${taskKind} child`,
            role: taskKind,
            objective: `Perform ${taskKind}`,
            success_criteria: "Return evidence",
            required_paths: "src/main.js",
            access_mode: taskKind === "implement" ? "write" : "read",
            ...(taskKind === "implement"
              ? {
                  implementation_operation: "modify",
                  implementation_plan:
                    "Update the already-inspected startup owner without changing unrelated behavior.",
                }
              : {}),
          },
        },
      });
    assert.equal(candidate.taskKind, taskKind);
    assert.equal(
      candidate.accessMode,
      taskKind === "implement" ? "write" : "read",
    );
  }
});

test("implementation child admission requires a complete parent-authored contract", () => {
  const base = {
    idempotencyKey: "schedule-implementation",
    kind: "schedule_subagents",
    phase: "acting",
    run: {
      sessionKey: "session",
      sessionEpoch: "epoch",
      turnId: "turn",
      runId: "run",
      parentRunId: null,
      attemptId: "attempt",
    },
    payload: {
      toolCallId: "provider-implementation",
      arguments: {
        task_key: "implementation",
        task_kind: "implement",
        objective: "Implement the proven toolbar repair.",
        success_criteria: "The scoped source implements the assigned behavior.",
        required_paths: "src/components/toolbar.js",
        access_mode: "write",
        implementation_operation: "modify",
      },
    },
  };
  assert.throws(
    () => subagentCandidate.runtimeV2ModelSelectedSubagentCandidate(base),
    /implementation_plan/,
  );
  const accepted =
    subagentCandidate.runtimeV2ModelSelectedSubagentCandidate({
      ...base,
      payload: {
        ...base.payload,
        arguments: {
          ...base.payload.arguments,
          implementation_plan:
            "Reuse the existing open-file boundary and remove the duplicate dispatch.",
        },
      },
    });
  assert.equal(accepted.taskKind, "implement");
  assert.equal(accepted.accessMode, "write");
  assert.equal(accepted.implementationOperation, "modify");
});

test("parallel implementation children require disjoint exclusive scopes", () => {
  const parentRun = {
    sessionKey: "session",
    sessionEpoch: "epoch",
    turnId: "turn",
    runId: "run",
    parentRunId: null,
    attemptId: "attempt",
  };
  let id = 0;
  const decision = runtime.scheduleReadOnlySubagents({
    parentRun,
    candidates: [
      {
        scopeKey: "editor-owner",
        taskKind: "implement",
        accessMode: "write",
        implementationOperation: "modify",
        implementationPlan: "Apply the proven editor-state repair.",
        objective: "Repair editor ownership.",
        successCriteria: "Editor state has one owner.",
        allowedPaths: ["src/components/editor.js"],
      },
      {
        scopeKey: "toolbar-owner",
        taskKind: "implement",
        accessMode: "write",
        implementationOperation: "modify",
        implementationPlan: "Apply the proven toolbar-boundary repair.",
        objective: "Repair toolbar ownership.",
        successCriteria: "Toolbar uses one dialog boundary.",
        allowedPaths: ["src/components/toolbar.js"],
      },
      {
        scopeKey: "overlapping-editor-owner",
        taskKind: "implement",
        accessMode: "write",
        implementationOperation: "modify",
        implementationPlan: "Apply another editor repair.",
        objective: "Also repair editor ownership.",
        successCriteria: "Editor state changes.",
        allowedPaths: ["src/components"],
      },
    ],
    maxActiveJobs: 3,
    requestedAt: 1,
    nextId: () => `child-${++id}`,
  });
  assert.deepEqual(
    decision.jobs.map((job) => job.scopeKey),
    ["editor-owner", "toolbar-owner"],
  );
  assert.deepEqual(decision.rejectedScopeKeys, ["overlapping-editor-owner"]);
});

test("implementation ownership names exact mutation files instead of writable directories", () => {
  const job = {
    taskKind: "implement",
    accessMode: "write",
    allowedPaths: ["src/components"],
  };
  assert.equal(
    subagentWriteScope.runtimeV2JobOwnsMutationTargets({
      job,
      targets: ["src/components/editor.js"],
    }),
    false,
  );
  assert.equal(
    subagentWriteScope.runtimeV2JobOwnsMutationTargets({
      job: { ...job, allowedPaths: ["src/components/editor.js"] },
      targets: ["src/components/editor.js"],
    }),
    true,
  );
});

test("a completed implementation child must return scoped mutation evidence", () => {
  const job = {
    id: "child-editor",
    taskKind: "implement",
    accessMode: "write",
    allowedPaths: ["src/components/editor.js"],
  };
  const report = {
    schemaVersion: "runtime-v2-subagent-report.v1",
    summary: "Committed child:child-editor:E1.",
    findings: [{
      statement: "Committed the assigned editor repair.",
      evidenceIds: ["child:child-editor:E1"],
    }],
    unresolved: [],
  };
  const event = {
    type: "subagent.completed",
    status: "completed",
    evidence: [{
      id: "child:child-editor:E1",
      kind: "mutation",
      target: "src/components/editor.js",
      version: "v2",
    }],
    report,
  };
  assert.equal(reducerGuards.isValidRuntimeV2SubagentCompletion({
    state: { evidence: [] },
    event,
    job,
  }), true);
  assert.equal(reducerGuards.isValidRuntimeV2SubagentCompletion({
    state: { evidence: [] },
    event: { ...event, evidence: [] },
    job,
  }), false);
  assert.equal(reducerGuards.isValidRuntimeV2SubagentCompletion({
    state: { evidence: [] },
    event: {
      ...event,
      evidence: [{
        ...event.evidence[0],
        target: "src/components/toolbar.js",
      }],
    },
    job,
  }), false);
});

test("active child write ownership blocks overlapping parent writes and final validation", () => {
  const live = executionTypes.createRuntimeV2LiveExecutionState();
  live.childWriteScopes.set("child-editor", ["src/components/editor.js"]);
  assert.equal(
    subagentWriteScope.activeRuntimeV2ChildWriteConflict({
      live,
      targets: ["src/components/editor.js"],
    })?.jobId,
    "child-editor",
  );
  assert.equal(
    subagentWriteScope.activeRuntimeV2ChildWriteConflict({
      live,
      targets: ["src/components/toolbar.js"],
    }),
    null,
  );
  assert.equal(
    subagentWriteScope.activeRuntimeV2SubagentJobWriteConflict({
      jobs: [{
        id: "durable-child",
        status: "running",
        taskKind: "implement",
        accessMode: "write",
        allowedPaths: ["src/components/toolbar.js"],
      }],
      targets: ["src/components/toolbar.js"],
    })?.jobId,
    "durable-child",
    "the write lock must survive process-local child state loss",
  );
  const rejected = authorization.validateToolAgainstPhaseAndPlan({
    ports: {
      get: () => ({}),
      context: { turnId: "turn" },
      live,
    },
    command: {
      idempotencyKey: "validate-with-child",
      kind: "execute_validation",
      phase: "validating",
      run: {
        sessionKey: "session",
        sessionEpoch: "epoch",
        turnId: "turn",
        runId: "run",
        parentRunId: null,
        attemptId: "attempt",
      },
      payload: {},
    },
    toolName: "run_command",
    args: { command: "npm test" },
    target: "npm test",
  });
  assert.equal(rejected.allowed, false);
  assert.equal(rejected.reasonCode, "active_child_write_pending");
});

test("Runtime v2 mutation adapter leaves size policy to the shared safety gate", () => {
  const source = fs.readFileSync(path.join(
    workspaceRoot,
    "src/store/runtimeV2/executionMutationPreflight.ts",
  ), "utf8");
  assert.doesNotMatch(source, /MAX_CORRECTIVE_MUTATION_LINES/);
  assert.doesNotMatch(source, /MAX_MUTATION_LINES/);
  assert.doesNotMatch(source, /maxTouchedLines\s*:/);
});

const definition = (name) => ({
  type: "function",
  function: {
    name,
    description: name,
    parameters: { type: "object", properties: {}, required: [] },
  },
});

function command(phase) {
  return {
    idempotencyKey: `command-${phase}`,
    kind: "request_model",
    phase,
    run: {
      sessionKey: "session",
      sessionEpoch: "epoch",
      turnId: "turn",
      runId: "run",
      parentRunId: null,
      attemptId: "attempt",
    },
    payload: {
      mode: "execute",
      collaborationAllowed: false,
      remainingSubagentCapacity: 0,
    },
  };
}

test("Observe, Act, and Validate share one safe inspect-edit-verify surface", () => {
  const available = [
    "read_file",
    "grep_search",
    "apply_patch",
    "run_command",
    "browser_evaluate",
  ].map(definition);
  const ports = {
    now: () => 1,
    lifecycleDeadlineAt: 100_000,
  };
  const names = ["observing", "acting", "validating"].map((phase) =>
    providerTools.selectRuntimeV2ProviderToolDefinitions({
      ports,
      command: command(phase),
      available,
    }).map((tool) => tool.function.name)
  );
  assert.deepEqual(names[0], names[1]);
  assert.deepEqual(names[1], names[2]);
  assert.deepEqual(names[0], [
    "read_file",
    "grep_search",
    "apply_patch",
    "run_command",
    "browser_evaluate",
  ]);
});

test("recovery preserves the current executable surface until the bounded stop", () => {
  const available = [
    "read_file",
    "grep_search",
    "replace_in_file",
    "apply_patch",
    "write_file",
    "run_command",
    "browser_evaluate",
    "spawn_subagent",
    "wait_subagents",
  ].map(definition);
  const validationCommand = {
    ...command("validating"),
    payload: {
      ...command("validating").payload,
      mode: "validate",
      collaborationAllowed: true,
      remainingSubagentCapacity: 1,
      activeSubagents: [{ id: "child-validation" }],
    },
  };
  const ports = {
    now: () => 1,
    lifecycleDeadlineAt: 200_000,
  };
  const ordinary = providerTools.selectRuntimeV2ProviderToolDefinitions({
    ports,
    command: validationCommand,
    available,
  }).map((tool) => tool.function.name);
  assert.deepEqual(ordinary, [
    "read_file",
    "grep_search",
    "replace_in_file",
    "apply_patch",
    "write_file",
    "run_command",
    "browser_evaluate",
    "spawn_subagent",
    "wait_subagents",
  ]);

  const closed = providerTools.selectRuntimeV2ProviderToolDefinitions({
    ports,
    command: validationCommand,
    available,
    actionWindow: "closed_recovery",
  }).map((tool) => tool.function.name);
  assert.deepEqual(closed, [
    "replace_in_file",
    "apply_patch",
    "write_file",
  ]);

  const recovery = providerTools.selectRuntimeV2ProviderToolDefinitions({
    ports,
    command: {
      ...validationCommand,
      payload: {
        ...validationCommand.payload,
        recoveryPressure: {
          reason: "provider_request_failed",
          occurrence: 2,
          stage: "reframe",
        },
      },
    },
    available,
  });
  assert.deepEqual(
    recovery.map((tool) => tool.function.name),
    ordinary,
    "recovery pressure must not erase actions that can still make progress",
  );

  const validationHandoff = providerTools.selectRuntimeV2ProviderToolDefinitions({
    ports,
    command: {
      ...validationCommand,
      payload: {
        ...validationCommand.payload,
        recoveryPressure: {
          reason: "repeated_action_rejected",
          occurrence: 2,
          stage: "reframe",
        },
      },
    },
    available,
    actionWindow: "validation_handoff",
    correctiveValidationCommand: "npm run build",
  });
  assert.deepEqual(
    validationHandoff.map((tool) => tool.function.name),
    ["run_command"],
    "a failed provider choice must retain the one executable validation action",
  );
});

test("one non-actionable validation decision closes inspection", () => {
  const base = {
    command: {
      payload: {
        mode: "validate",
        recoveryPressure: null,
      },
    },
    effects: {},
    sourceCoverage: [],
  };
  assert.equal(
    authorization.runtimeV2ProviderActionWindowFor(base),
    null,
    "fresh validation may inspect the committed source before verifying",
  );
  assert.equal(
    authorization.runtimeV2ProviderActionWindowFor({
      ...base,
      command: {
        payload: {
          mode: "validate",
          recoveryPressure: {
            reason: "provider_request_failed",
            occurrence: 1,
          },
        },
      },
    }),
    "closed_recovery",
    "a non-actionable decision must close inspection while retaining validation and source-backed implementation",
  );
  assert.equal(
    authorization.runtimeV2ProviderActionWindowFor({
      ...base,
      effects: {
        repeatedObservationToolNames: new Set(["grep_search"]),
      },
    }),
    "closed_recovery",
    "equivalent inspection results cannot postpone validation",
  );
});

test("a closed provider decision cannot escape its bounded mutation through reads or collaboration", () => {
  const available = [
    "read_file",
    "grep_search",
    "replace_in_file",
    "apply_patch",
    "write_file",
    "run_command",
    "browser_evaluate",
    "spawn_subagent",
    "wait_subagents",
  ].map(definition);
  const selected = providerTools.selectRuntimeV2ProviderToolDefinitions({
    ports: {
      now: () => 1,
      lifecycleDeadlineAt: 200_000,
    },
    command: {
      ...command("acting"),
      payload: {
        ...command("acting").payload,
        collaborationAllowed: true,
        collaborationAction: "optional",
        remainingSubagentCapacity: 1,
        activeSubagents: [{ id: "child-review" }],
      },
    },
    available,
    actionWindow: "closed_recovery",
  });

  assert.deepEqual(
    selected.map((tool) => tool.function.name),
    [
      "replace_in_file",
      "apply_patch",
      "write_file",
    ],
  );
});

test("a missing mutation source exposes only a target-locked read", () => {
  const available = [
    "read_file",
    "grep_search",
    "replace_in_file",
    "run_command",
    "browser_evaluate",
    "spawn_subagent",
  ].map(definition);
  const selected = providerTools.selectRuntimeV2ProviderToolDefinitions({
    ports: {
      now: () => 1,
      lifecycleDeadlineAt: 200_000,
    },
    command: command("acting"),
    available,
    actionWindow: "corrective_source",
    correctiveSourceTargets: ["src-tauri/src/main.rs"],
  });

  assert.deepEqual(
    selected.map((tool) => tool.function.name),
    ["read_file"],
  );
  assert.deepEqual(
    selected[0].function.parameters.properties.path.enum,
    ["src-tauri/src/main.rs"],
  );
  assert.match(
    selected[0].function.description,
    /single fresh source-recovery batch/i,
  );

  const validating = providerTools.selectRuntimeV2ProviderToolDefinitions({
    ports: {
      now: () => 1,
      lifecycleDeadlineAt: 200_000,
    },
    command: {
      ...command("validating"),
      payload: {
        ...command("validating").payload,
        mode: "validate",
      },
    },
    available,
    actionWindow: "corrective_source",
    correctiveSourceTargets: ["src-tauri/src/main.rs"],
  });
  assert.deepEqual(
    validating.map((tool) => tool.function.name),
    ["read_file"],
    "a corrective source lease outranks the validate-phase tool surface",
  );
  assert.deepEqual(
    validating[0].function.parameters.properties.path.enum,
    ["src-tauri/src/main.rs"],
  );
});

test("a corrective mutation lease outranks validation tools", () => {
  const selected = providerTools.selectRuntimeV2ProviderToolDefinitions({
    ports: {
      now: () => 1,
      lifecycleDeadlineAt: 200_000,
    },
    command: {
      ...command("validating"),
      payload: {
        ...command("validating").payload,
        mode: "validate",
      },
    },
    available: [
      "read_file",
      "replace_in_file",
      "apply_patch",
      "run_command",
      "browser_evaluate",
    ].map(definition),
    actionWindow: "corrective_mutation",
  });
  assert.deepEqual(
    selected.map((tool) => tool.function.name),
    ["replace_in_file", "apply_patch"],
  );
});

test("corrective source recovery rejects an unrelated unread file before execution", () => {
  const live = executionTypes.createRuntimeV2LiveExecutionState();
  live.latestProviderActionWindow = "corrective_source";
  const logs = [];
  let id = 0;
  const input = {
    ports: {
      live,
      nextId: () => `corrective-source-${++id}`,
      logStoreEvent: (event, data) => logs.push({ event, data }),
    },
    command: command("acting"),
    effects: {
      correctiveMutationFailureToolCallIds: new Set([
        "older-rust-edit",
        "failed-main-edit",
      ]),
      correctiveReplayTargetsByToolCallId: new Map([
        ["older-rust-edit", ["src-tauri/src/main.rs"]],
        ["failed-main-edit", ["src/main.js"]],
      ]),
    },
    result: {
      visibleText: "I will inspect another file.",
      toolCalls: [{
        id: "provider-unrelated-read",
        name: "read_file",
        arguments: { path: "src/styles/toolbar.css" },
      }],
      diagnostics: [],
    },
  };
  const rejected = providerSurfaceRejection
    .rejectRuntimeV2InvalidCorrectiveSourceRead(input);
  assert.deepEqual(rejected.toolCalls, []);
  assert.match(live.messages.at(-1).content, /CORRECTIVE_SOURCE_REJECTED/);
  assert.match(live.messages.at(-1).content, /src\/main\.js/);
  assert.doesNotMatch(
    live.messages.at(-1).content,
    /Allowed exact targets?: .*src-tauri/,
    "an older failed editor cannot keep owning the recovery surface",
  );
  assert.ok(logs.some((entry) =>
    entry.event === "runtime_v2_provider_action_rejected" &&
    entry.data.reason === "corrective_source_target_mismatch"
  ));

  assert.equal(
    providerSurfaceRejection.rejectRuntimeV2InvalidCorrectiveSourceRead({
      ...input,
      result: {
        ...input.result,
        toolCalls: [{
          id: "provider-exact-read",
          name: "read_file",
          arguments: { path: "src/main.js" },
        }],
      },
    }),
    null,
  );
});

test("an unavailable native tool becomes one causal rejected action instead of a transport retry", () => {
  const live = executionTypes.createRuntimeV2LiveExecutionState();
  const logs = [];
  let id = 0;
  const ports = {
    live,
    nextId: () => `rejected-${++id}`,
    logStoreEvent: (event, data) => logs.push({ event, data }),
  };
  const input = {
    ports,
    command: command("acting"),
    tools: [definition("apply_patch")],
    result: {
      visibleText: "Let me read it again.",
      toolCalls: [{
        id: "provider-read-1",
        name: "read_file",
        arguments: { path: "src-tauri/src/main.rs" },
      }],
      diagnostics: [],
    },
  };
  const first = providerSurfaceRejection
    .rejectRuntimeV2UnexpectedProviderTool(input);
  assert.deepEqual(first.toolCalls, []);
  assert.equal(first.visibleText, "");
  assert.equal(first.diagnostics[0].code, "repeated_action_rejected");
  assert.equal(live.messages.filter((message) => message.role === "tool").length, 1);
  assert.match(live.messages.at(-1).content, /TOOL_SURFACE_REJECTED/);

  providerSurfaceRejection.rejectRuntimeV2UnexpectedProviderTool({
    ...input,
    result: {
      ...input.result,
      toolCalls: [{
        ...input.result.toolCalls[0],
        id: "provider-read-2",
      }],
    },
  });
  assert.equal(
    live.messages.filter((message) => message.role === "tool").length,
    1,
    "the same unavailable action replaces its rejection pair instead of growing a replay loop",
  );
  assert.ok(logs.some((entry) =>
    entry.event === "runtime_v2_provider_action_rejected" &&
    entry.data.reason === "tool_surface_rejected"
  ));

  providerSurfaceRejection.rejectRuntimeV2UnexpectedProviderTool({
    ...input,
    result: {
      ...input.result,
      toolCalls: [{
        ...input.result.toolCalls[0],
        id: "provider-read-3",
        arguments: {
          path: "src-tauri/src/main.rs",
          start_line: "280",
        },
      }],
    },
  });
  assert.equal(
    live.messages.filter((message) => message.role === "tool").length,
    1,
    "paging a hidden read tool remains one semantic surface violation",
  );
  assert.equal(
    providerSurfaceRejection.runtimeV2UnavailableToolSemanticIdentity({
      name: "read_file",
      arguments: { path: "src-tauri/src/main.rs", start_line: 280 },
    }),
    providerSurfaceRejection.runtimeV2UnavailableToolSemanticIdentity({
      name: "read_file",
      arguments: { path: "src-tauri/src/main.rs", start_line: 340 },
    }),
  );
});

test("validation mode rejects source-search shell commands before they can bypass validation evidence", () => {
  const live = executionTypes.createRuntimeV2LiveExecutionState();
  const logs = [];
  let id = 0;
  const ports = {
    live,
    nextId: () => `validation-rejected-${++id}`,
    logStoreEvent: (event, data) => logs.push({ event, data }),
  };
  const validationCommand = {
    ...command("validating"),
    payload: {
      ...command("validating").payload,
      mode: "validate",
    },
  };
  const input = {
    ports,
    command: validationCommand,
    tools: [definition("run_command"), definition("browser_evaluate")],
    result: {
      visibleText: "I will inspect the handler.",
      toolCalls: [{
        id: "provider-grep",
        name: "run_command",
        arguments: { command: "grep -n handleOpenFile src/main.js" },
      }],
      diagnostics: [],
    },
  };
  const rejected = providerSurfaceRejection
    .rejectRuntimeV2InvalidValidationCommand(input);
  assert.deepEqual(rejected.toolCalls, []);
  assert.equal(rejected.visibleText, "");
  assert.match(live.messages.at(-1).content, /VALIDATION_COMMAND_REJECTED/);
  assert.match(live.messages.at(-1).content, /npm run build/);
  assert.ok(logs.some((entry) =>
    entry.event === "runtime_v2_provider_action_rejected" &&
    entry.data.reason === "validation_command_not_finite"
  ));

  assert.equal(
    providerSurfaceRejection.rejectRuntimeV2InvalidValidationCommand({
      ...input,
      result: {
        ...input.result,
        toolCalls: [{
          id: "provider-test",
          name: "run_command",
          arguments: { command: "npm test" },
        }],
      },
    }),
    null,
    "a real finite validation remains executable",
  );
});

test("a rejected validation wrapper locks the next native command to its finite validator", () => {
  const live = executionTypes.createRuntimeV2LiveExecutionState();
  const logs = [];
  let id = 0;
  const ports = {
    live,
    now: () => 1,
    lifecycleDeadlineAt: 200_000,
    nextId: () => `validation-wrapper-${++id}`,
    logStoreEvent: (event, data) => logs.push({ event, data }),
  };
  const validationCommand = {
    ...command("validating"),
    payload: {
      ...command("validating").payload,
      mode: "validate",
    },
  };
  const rejected = providerSurfaceRejection
    .rejectRuntimeV2InvalidValidationCommand({
      ports,
      command: validationCommand,
      tools: [definition("run_command"), definition("browser_evaluate")],
      result: {
        visibleText: "",
        toolCalls: [{
          id: "provider-wrapped-build",
          name: "run_command",
          arguments: {
            command:
              "cd /workspace && npm run build 2>&1; echo EXIT_CODE=$?",
          },
        }],
        diagnostics: [],
      },
    });

  assert.deepEqual(rejected.toolCalls, []);
  assert.equal(live.correctiveValidationCommand, "npm run build");
  assert.match(live.messages.at(-1).content, /exactly "npm run build"/);
  assert.ok(logs.some((entry) =>
    entry.event === "runtime_v2_provider_action_rejected" &&
    entry.data.correctiveCommand === "npm run build"
  ));

  const selected = providerTools.selectRuntimeV2ProviderToolDefinitions({
    ports,
    command: validationCommand,
    available: [
      definition("run_command"),
      definition("browser_evaluate"),
      definition("read_file"),
    ],
    actionWindow: "closed_recovery",
    correctiveValidationCommand: live.correctiveValidationCommand,
  });
  const runCommand = selected.find((tool) =>
    tool.function.name === "run_command"
  );
  assert.deepEqual(
    runCommand.function.parameters.properties.command.enum,
    ["npm run build"],
  );
  assert.match(runCommand.function.description, /no redirection/i);
});

test("corrective action pressure reuses materialized target source without a freshness ritual", () => {
  const commandWithPressure = {
    payload: {
      mode: "execute",
      effectPressure: {
        reason: "source_only_frontier",
      },
      recoveryPressure: null,
    },
  };
  const effects = {
    correctiveMutationFailureToolCallIds: new Set(["failed-edit"]),
    correctiveReplayTargetsByToolCallId: new Map([
      ["failed-edit", ["src/components/toolbar.js"]],
    ]),
  };
  assert.equal(
    authorization.runtimeV2ProviderActionWindowFor({
      command: commandWithPressure,
      effects,
      sourceCoverage: [],
    }),
    "corrective_source",
    "a missing exact target opens only the target-locked source recovery window",
  );
  assert.equal(
    authorization.runtimeV2ProviderActionWindowFor({
      command: commandWithPressure,
      effects,
      sourceCoverage: [{
        target: "src/components/toolbar.js",
        version: "sha-toolbar",
        totalLines: 213,
        windows: [{ startLine: 1, endLine: 213, content: "source" }],
        complete: true,
      }],
    }),
    "corrective_mutation",
    "a rejected mutation changed no files, so already-materialized current source remains valid authority",
  );
});

test("a failed optional editor hands a completed contract to validation instead of trapping correction", () => {
  const commandWithPressure = {
    payload: {
      mode: "validate",
      recoveryPressure: null,
    },
  };
  const effects = {
    correctiveMutationFailureToolCallIds: new Set(["failed-extra-edit"]),
    correctiveReplayTargetsByToolCallId: new Map([
      ["failed-extra-edit", ["src/main.js"]],
    ]),
  };
  assert.equal(
    authorization.runtimeV2ProviderActionWindowFor({
      command: commandWithPressure,
      effects,
      sourceCoverage: [],
      completedContractAwaitingValidation: true,
    }),
    "validation_handoff",
  );
  assert.equal(
    authorization.runtimeV2ProviderActionWindowFor({
      command: commandWithPressure,
      effects,
      sourceCoverage: [],
      completedContractAwaitingValidation: false,
    }),
    "corrective_source",
    "a failed required edit or post-validation correction still gets exact source recovery",
  );

  const selected = providerTools.selectRuntimeV2ProviderToolDefinitions({
    ports: {
      now: () => 1,
      lifecycleDeadlineAt: undefined,
      get: () => null,
      context: { runWorkspace: "/workspace" },
    },
    command: commandWithPressure,
    available: [
      "read_file",
      "replace_in_file",
      "run_command",
      "browser_evaluate",
    ].map(definition),
    actionWindow: "validation_handoff",
    correctiveValidationCommand: "npm run build",
  });
  assert.deepEqual(
    selected.map((tool) => tool.function.name),
    ["run_command"],
  );
  assert.deepEqual(
    selected[0].function.parameters.properties.command.enum,
    ["npm run build"],
  );
});

test("a newer failed validation supersedes only older rejected-editor recovery", () => {
  const effects = {
    correctiveMutationFailureToolCallIds: new Set(["failed-edit"]),
    correctiveReplayTargetsByToolCallId: new Map([
      ["failed-edit", ["src/main.js"]],
    ]),
    correctiveMutationRequirementsByToolCallId: new Map([
      ["failed-edit", {
        sequence: 20,
        toolName: "replace_in_file",
        arguments: { path: "src/main.js" },
        target: "src/main.js",
        reasonCode: "mutation_target_lease_mismatch",
      }],
    ]),
  };
  const base = {
    command: {
      payload: { mode: "validate", recoveryPressure: null },
    },
    effects,
    sourceCoverage: [],
  };
  assert.equal(
    authorization.runtimeV2ProviderActionWindowFor({
      ...base,
      newerValidationFailureSequence: 30,
    }),
    null,
    "the failed validation owns its full exact diagnostic batch even when an older editor was rejected",
  );
  assert.equal(
    authorization.runtimeV2ProviderActionWindowFor({
      ...base,
      newerValidationFailureSequence: 10,
    }),
    "corrective_source",
    "an editor rejected after the validation still owns target-locked recovery",
  );
});

test("corrective source recovery closes on fresh target source while the new editor keeps exact lease checks", () => {
  const commandWithPressure = {
    payload: {
      mode: "execute",
      effectPressure: { reason: "source_only_frontier" },
      recoveryPressure: null,
    },
  };
  const patch = [
    "*** Begin Patch",
    "*** Update File: src/main.js",
    "@@",
    "-function switchToTab(index) {",
    "-  activeTab = index;",
    "+function switchToTab(index) {",
    "+  activeTab = Number(index);",
    "*** End Patch",
  ].join("\n");
  const effects = {
    correctiveMutationFailureToolCallIds: new Set(["failed-range-edit"]),
    correctiveReplayTargetsByToolCallId: new Map([
      ["failed-range-edit", ["src/main.js"]],
    ]),
    correctiveMutationRequirementsByToolCallId: new Map([
      ["failed-range-edit", {
        toolName: "apply_patch",
        arguments: { patch },
        target: "",
        reasonCode: "mutation_target_lease_mismatch",
      }],
    ]),
  };
  const prefixOnly = [{
    target: "src/main.js",
    version: "sha-main",
    totalLines: 1200,
    windows: [{
      startLine: 1,
      endLine: 100,
      content: "const prefixOnly = true;\n",
    }],
    complete: false,
  }];
  assert.equal(
    authorization.runtimeV2ProviderActionWindowFor({
      command: commandWithPressure,
      effects,
      sourceCoverage: prefixOnly,
      workspace: "/workspace",
    }),
    "corrective_mutation",
    "fresh target source closes recovery reading without reconstructing the rejected patch",
  );
  const coveredHunk = [{
    target: "src/main.js",
    version: "sha-main",
    totalLines: 1200,
    windows: [{
      startLine: 300,
      endLine: 303,
      content: [
        "function switchToTab(index) {",
        "  activeTab = index;",
        "}",
      ].join("\n"),
    }],
    complete: false,
  }];
  assert.equal(
    authorization.runtimeV2ProviderActionWindowFor({
      command: commandWithPressure,
      effects,
      sourceCoverage: coveredHunk,
      workspace: "/workspace",
    }),
    "corrective_mutation",
    "a focused hunk also closes the target-level recovery window",
  );
  assert.equal(
    correctiveMutationPolicy.runtimeV2MaterializedSourceCoversMutation({
      toolName: "apply_patch",
      args: { patch },
      sourceCoverage: prefixOnly,
      workspace: "/workspace",
    }),
    false,
    "the independently authorized new editor still cannot reuse an unseen rejected hunk",
  );
});

test("three uncommitted corrective mutation failures close the recovery cycle", () => {
  assert.equal(
    providerActionWindow.runtimeV2CorrectiveMutationFailureLimitReached({
      correctiveMutationFailureToolCallIds: new Set(["one", "two"]),
    }),
    false,
  );
  assert.equal(
    providerActionWindow.runtimeV2CorrectiveMutationFailureLimitReached({
      correctiveMutationFailureToolCallIds: new Set([
        "one",
        "two",
        "three",
      ]),
    }),
    true,
  );
});

test("the first proven repeated action enters recovery mutation decoding", () => {
  assert.equal(
    authorization.runtimeV2ProviderActionWindowFor({
      command: {
        payload: {
          effectPressure: { reason: "source_only_frontier" },
          recoveryPressure: {
            reason: "repeated_action_rejected",
            occurrence: 1,
          },
        },
      },
      effects: {},
      sourceCoverage: [{
        target: "src/main.js",
        version: "sha-main",
        totalLines: 12,
        windows: [{ startLine: 1, endLine: 12, content: "source" }],
        complete: true,
      }],
    }),
    "closed_recovery",
  );
});

test("a repeated semantic observation enters recovery mutation decoding immediately", () => {
  assert.equal(
    authorization.runtimeV2ProviderActionWindowFor({
      command: {
        payload: {
          effectPressure: { reason: "source_only_frontier" },
          recoveryPressure: null,
        },
      },
      effects: {
        repeatedObservationToolNames: new Set(["grep_search"]),
      },
      sourceCoverage: [{
        target: "src/main.js",
        version: "sha-main",
        totalLines: 12,
        windows: [{ startLine: 1, endLine: 12, content: "source" }],
        complete: true,
      }],
    }),
    "closed_recovery",
  );
  assert.equal(
    authorization.runtimeV2ProviderActionWindowFor({
      command: {
        payload: {
          effectPressure: { reason: "source_only_frontier" },
          recoveryPressure: null,
        },
      },
      effects: {
        repeatedObservationToolNames: new Set(["grep_search"]),
      },
      sourceCoverage: [],
    }),
    null,
    "the guard must not revoke inspection before exact editable source is visible",
  );
});

test("the first cache re-materialization restores source then closes inspection", () => {
  const input = {
    command: {
      payload: {
        effectPressure: { reason: "source_only_frontier" },
        recoveryPressure: null,
      },
    },
    effects: {
      repeatedObservationToolNames: new Set(),
      replayedSourceReceiptCountSinceMutation: 1,
    },
    sourceCoverage: [{
      target: "src/main.js",
      version: "sha-main",
      totalLines: 12,
      windows: [{ startLine: 1, endLine: 12, content: "source" }],
      complete: true,
    }],
  };
  assert.equal(
    authorization.runtimeV2ProviderActionWindowFor(input),
    "closed_recovery",
    "the replay has already restored exact source, so the next decision must act instead of reading again",
  );
  assert.equal(
    authorization.runtimeV2ProviderActionWindowFor({
      ...input,
      effects: {
        ...input.effects,
        replayedSourceReceiptCountSinceMutation: 0,
      },
    }),
    null,
    "inspection remains open until a legitimate cache restore actually happens",
  );
});

test("global attachment analysis exposes only bounded attachment readers", () => {
  const available = [
    "read_file",
    "read_document",
    "analyze_tabular_document",
    "query_tabular_document",
    "list_directory",
    "grep_search",
    "write_file",
    "run_command",
    "browser_evaluate",
    "spawn_subagent",
  ].map(definition);
  const selected = providerTools.selectRuntimeV2ProviderToolDefinitions({
    ports: {
      context: {
        runWorkspace: "",
        turnInputContextSignals: {
          attachedFilePaths: ["/tmp/example.csv"],
        },
      },
      now: () => 1,
      lifecycleDeadlineAt: 100_000,
    },
    command: {
      ...command("observing"),
      payload: {
        ...command("observing").payload,
        mode: "analyze",
        collaborationAllowed: true,
        remainingSubagentCapacity: 2,
      },
    },
    available,
  });

  assert.deepEqual(
    selected.map((tool) => tool.function.name),
    [
      "read_file",
      "read_document",
      "analyze_tabular_document",
      "query_tabular_document",
    ],
  );
});

test("direct Execute validators keep the canonical tool schema", () => {
  const selected = providerTools.selectRuntimeV2ProviderToolDefinitions({
    ports: {
      now: () => 1,
      lifecycleDeadlineAt: 100_000,
    },
    command: {
      ...command("validating"),
      payload: {
        ...command("validating").payload,
        mode: "validate",
      },
    },
    available: [definition("run_command")],
  })[0];

  assert.deepEqual(selected.function.parameters.required, []);
  assert.equal(
    Object.hasOwn(selected.function.parameters.properties, "criterion_ids"),
    false,
  );
  assert.equal(
    Object.hasOwn(selected.function.parameters.properties, "target_paths"),
    false,
  );
});

test("source-only pressure prioritizes mutation without revoking safe tools", () => {
  const available = [
    "read_file",
    "grep_search",
    "write_file",
    "apply_patch",
    "replace_in_file",
    "run_command",
    "browser_evaluate",
  ].map(definition);
  const pressuredCommand = {
    ...command("acting"),
    payload: {
      ...command("acting").payload,
      effectPressure: {
        schemaVersion: "runtime-v2-effect-pressure.v1",
        reason: "source_only_frontier",
        mutationBoundarySequence: 0,
        sourceBoundarySequence: 12,
        latestSourceEvidenceId: "source-main",
      },
    },
  };

  const withoutVisibleSource =
    providerTools.prioritizeRuntimeV2ProviderToolDefinitions({
      command: pressuredCommand,
      tools: available,
      hasMaterializedSourceEvidence: false,
    }).map((tool) => tool.function.name);
  assert.deepEqual(
    withoutVisibleSource,
    available.map((tool) => tool.function.name),
  );

  const withVisibleSource =
    providerTools.prioritizeRuntimeV2ProviderToolDefinitions({
      command: pressuredCommand,
      tools: available,
      hasMaterializedSourceEvidence: true,
    }).map((tool) => tool.function.name);
  assert.deepEqual(withVisibleSource, [
    "replace_in_file",
    "apply_patch",
    "write_file",
    "read_file",
    "grep_search",
    "run_command",
    "browser_evaluate",
  ]);
  assert.deepEqual(
    new Set(withVisibleSource),
    new Set(withoutVisibleSource),
    "ordering must never change the authorized tool set",
  );
});

test("a rejected action leaves one non-executable causal feedback anchor", () => {
  const live = executionTypes.createRuntimeV2LiveExecutionState();
  live.latestProviderAssistantReasoning = {
    field: "reasoning_content",
    content: "private rejected reasoning",
  };
  providerHistory.appendRuntimeV2ProviderFeedbackHistory(live, {
    code: "repeated_action_rejected",
    feedback: [
      "ACTION_NOT_EXECUTED: the latest replace_in_file matched an action already rejected at this mutation boundary.",
      "Choose materially different arguments, refresh the target source, or use another allowed action.",
    ].join("\n"),
  });
  const available = [
    "read_file",
    "grep_search",
    "apply_patch",
    "run_command",
  ].map(definition);
  const recoveryCommand = command("acting");
  const selected =
    providerTools.selectRuntimeV2ProviderToolDefinitions({
      ports: {
        live,
        now: () => 1,
        lifecycleDeadlineAt: 200_000,
      },
      command: recoveryCommand,
      available,
    }).map((tool) => tool.function.name);

  assert.deepEqual(selected, [
    "read_file",
    "grep_search",
    "apply_patch",
    "run_command",
  ]);
  assert.deepEqual(
    live.messages.map((message) => message.role),
    ["system"],
    "a rejected call is omitted as an executable template while its causal feedback remains visible",
  );
  assert.match(
    String(live.messages[0]?.content || ""),
    /ACTION_NOT_EXECUTED/,
  );
  assert.doesNotMatch(
    String(live.messages[0]?.content || ""),
    /search_text|replace_text|private rejected reasoning/,
  );
  assert.equal(
    live.latestProviderAssistantReasoning,
    null,
    "private reasoning from an omitted rejected template cannot leak into a later tool exchange",
  );
});

test("a repeated provider action is closed as one native tool exchange", () => {
  const live = executionTypes.createRuntimeV2LiveExecutionState();
  live.latestProviderAssistantReasoning = {
    field: "reasoning_content",
    content: "private rejected reasoning",
  };
  const call = {
    id: "rejected-read-1",
    name: "read_file",
    arguments: { path: "src/hooks/useCsvParser.ts" },
  };
  const feedback = [
    "ACTION_NOT_EXECUTED: the latest read_file action already completed.",
    "Reuse the committed result or choose a materially different action.",
  ].join("\n");

  providerHistory.appendRuntimeV2RejectedToolCallHistory(live, {
    call,
    actionIdentity: "read-file-identity",
    feedback,
  });
  providerHistory.appendRuntimeV2ProviderFeedbackHistory(live, {
    code: "repeated_action_rejected",
    feedback,
  });

  assert.deepEqual(
    live.messages.map((message) => message.role),
    ["assistant", "tool", "system"],
  );
  assert.equal(
    live.messages[0]?.tool_calls?.[0]?.function.name,
    "read_file",
  );
  assert.deepEqual(
    JSON.parse(live.messages[0]?.tool_calls?.[0]?.function.arguments || "{}"),
    { path: "src/hooks/useCsvParser.ts" },
  );
  assert.equal(live.messages[1]?.tool_call_id, "rejected-read-1");
  assert.match(String(live.messages[1]?.content || ""), /ACTION_NOT_EXECUTED/);
  assert.equal(live.latestProviderAssistantReasoning, null);

  providerHistory.appendRuntimeV2RejectedToolCallHistory(live, {
    call: { ...call, id: "rejected-read-2" },
    actionIdentity: "read-file-identity",
    feedback,
  });
  providerHistory.appendRuntimeV2ProviderFeedbackHistory(live, {
    code: "repeated_action_rejected",
    feedback,
  });
  assert.equal(
    live.messages.length,
    3,
    "the same rejected action must not grow the decision transcript",
  );
  assert.equal(
    live.messages[1]?.tool_call_id,
    "rejected-read-2",
    "the bounded rejection pair must move to the latest decision frontier",
  );

  const mutationLive = executionTypes.createRuntimeV2LiveExecutionState();
  providerHistory.appendRuntimeV2RejectedToolCallHistory(mutationLive, {
    call: {
      id: "rejected-mutation-1",
      name: "replace_in_file",
      arguments: {
        path: "src/secret.ts",
        search_text: "SENSITIVE_OLD_SOURCE",
        replace_text: "SENSITIVE_NEW_SOURCE",
      },
    },
    actionIdentity: "mutation-identity",
    feedback:
      "ACTION_NOT_EXECUTED: targets: [\"src/secret.ts\"]; effect: none.",
  });
  const mutationExchange = JSON.stringify(mutationLive.messages);
  assert.match(mutationExchange, /mutation-identity/);
  assert.doesNotMatch(
    mutationExchange,
    /SENSITIVE_OLD_SOURCE|SENSITIVE_NEW_SOURCE|search_text|replace_text/,
  );
});

test("rejected mutation feedback names only the target and an executable source-refresh next step", () => {
  const feedback = providerPort.runtimeV2RepeatedActionFeedback({
    call: {
      id: "rejected-editor-mutation",
      name: "replace_in_file",
      arguments: {
        path: "/workspace/src/components/editor.js",
        search_text: "SENSITIVE_OLD_SOURCE",
        replace_text: "SENSITIVE_NEW_SOURCE",
      },
    },
    reason: "already_rejected",
    workspace: "/workspace",
    visibleSourceTargets: ["src/main.js"],
  });

  assert.match(feedback, /ACTION_NOT_EXECUTED/);
  assert.match(feedback, /targets: \["src\/components\/editor\.js"\]/);
  assert.match(feedback, /effect: none/);
  assert.match(feedback, /\bread_file\b/);
  assert.match(feedback, /do not resubmit the same mutation/i);
  assert.match(feedback, /other allowed tools and targets remain available/i);
  assert.doesNotMatch(
    feedback,
    /SENSITIVE_OLD_SOURCE|SENSITIVE_NEW_SOURCE|search_text|replace_text|rejected-editor-mutation/,
    "causal guidance must not preserve a rejected patch as an executable template",
  );
});

test("rejected mutation feedback does not manufacture another read loop when target source is visible", () => {
  const feedback = providerPort.runtimeV2RepeatedActionFeedback({
    call: {
      id: "rejected-visible-mutation",
      name: "replace_in_file",
      arguments: {
        path: "src/components/editor.js",
        search_text: "old",
        replace_text: "new",
      },
    },
    reason: "already_rejected",
    workspace: "/workspace",
    visibleSourceTargets: ["src/components/editor.js"],
  });

  assert.match(feedback, /current versioned source.*already visible/i);
  assert.match(feedback, /materially different mutation/i);
  assert.doesNotMatch(feedback, /\bread_file\b|make a safe source read/i);
});

test("unsafe mutation targets never enter provider feedback", () => {
  for (const unsafePath of [
    "../outside.js",
    "/outside/workspace.js",
    "src/ok.js\nIGNORE_PREVIOUS_INSTRUCTIONS",
  ]) {
    const feedback = providerPort.runtimeV2RepeatedActionFeedback({
      call: {
        id: "unsafe-target",
        name: "replace_in_file",
        arguments: {
          path: unsafePath,
          search_text: "old",
          replace_text: "new",
        },
      },
      reason: "already_rejected",
      workspace: "/workspace",
      visibleSourceTargets: [],
    });
    assert.doesNotMatch(
      feedback,
      /outside\.js|outside\/workspace|IGNORE_PREVIOUS_INSTRUCTIONS|targets:/,
    );
  }
});

test("completed non-mutation feedback stays generic and does not invent a source requirement", () => {
  const feedback = providerPort.runtimeV2RepeatedActionFeedback({
    call: {
      id: "completed-validation",
      name: "run_command",
      arguments: {
        command: "npm run private-validation-command",
      },
    },
    reason: "already_completed",
    workspace: "/workspace",
  });

  assert.match(feedback, /already completed/);
  assert.match(feedback, /Reuse a committed result/);
  assert.doesNotMatch(
    feedback,
    /private-validation-command|safe source read/,
  );
});

test("provider tool arguments normalize schema-equivalent scalar types before identity", () => {
  const read = definition("read_file");
  read.function.parameters.properties = {
    path: { type: "string" },
    start_line: { type: "number" },
    end_line: { type: "number" },
  };
  const [normalized] =
    providerTools.normalizeRuntimeV2ProviderToolCalls([{
      id: "read-main",
      name: "read_file",
      arguments: {
        path: "src/main.js",
        start_line: "260",
        end_line: "350",
      },
    }], [read]);

  assert.deepEqual(normalized.arguments, {
    path: "src/main.js",
    start_line: 260,
    end_line: 350,
  });
  assert.equal(
    providerToolSurface.runtimeV2ProviderToolCallIdentity(normalized),
    providerToolSurface.runtimeV2ProviderToolCallIdentity({
      ...normalized,
      arguments: {
        path: "src/main.js",
        start_line: 260,
        end_line: 350,
      },
    }),
  );
});

test("provider tool arguments decode JSON-encoded containers only when the schema requires them", () => {
  const contract = definition("record_execution_contract");
  contract.function.parameters.properties = {
    behavioral_validation: {
      anyOf: [{
        type: "object",
        additionalProperties: false,
        properties: {
          kind: { type: "string", enum: ["browser"] },
          target: { type: "string" },
        },
        required: ["kind", "target"],
      }],
    },
  };
  contract.function.parameters.required = ["behavioral_validation"];

  const [normalized] = providerTools.normalizeRuntimeV2ProviderToolCalls([{
    id: "encoded-behavioral-validation",
    name: "record_execution_contract",
    arguments: {
      behavioral_validation:
        '{"kind":"browser","target":"opening a file does not open Save As"}',
    },
  }], [contract]);

  assert.deepEqual(normalized.arguments.behavioral_validation, {
    kind: "browser",
    target: "opening a file does not open Save As",
  });
  assert.equal(
    providerTools.runtimeV2ProviderToolArgumentViolation(
      [normalized],
      [contract],
    ),
    null,
  );

  const [malformed] = providerTools.normalizeRuntimeV2ProviderToolCalls([{
    id: "malformed-behavioral-validation",
    name: "record_execution_contract",
    arguments: { behavioral_validation: '{"kind":"browser"' },
  }], [contract]);
  assert.equal(
    malformed.arguments.behavioral_validation,
    '{"kind":"browser"',
  );
  assert.match(
    providerTools.runtimeV2ProviderToolArgumentViolation(
      [malformed],
      [contract],
    ).reason,
    /advertised shape/,
  );

  const textTool = definition("text_tool");
  textTool.function.parameters.properties = {
    payload: {
      anyOf: [
        { type: "string" },
        { type: "object", additionalProperties: true },
      ],
    },
  };
  const [ambiguous] = providerTools.normalizeRuntimeV2ProviderToolCalls([{
    id: "genuine-json-text",
    name: "text_tool",
    arguments: { payload: '{"keep":"as text"}' },
  }], [textTool]);
  assert.equal(ambiguous.arguments.payload, '{"keep":"as text"}');

  const nested = definition("nested_contract");
  nested.function.parameters.properties = {
    changes: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          expected_outcome: { type: "string" },
        },
        required: ["expected_outcome"],
      },
    },
  };
  nested.function.parameters.required = ["changes"];
  const [camelCaseTransport] =
    providerTools.normalizeRuntimeV2ProviderToolCalls([{
      id: "camel-case-nested-field",
      name: "nested_contract",
      arguments: {
        changes: [{ expectedOutcome: "observable result" }],
      },
    }], [nested]);
  assert.deepEqual(camelCaseTransport.arguments, {
    changes: [{ expected_outcome: "observable result" }],
  });
  assert.equal(
    providerTools.runtimeV2ProviderToolArgumentViolation(
      [camelCaseTransport],
      [nested],
    ),
    null,
  );
});

test("native provider arguments cannot bypass a dynamically enum-locked tool surface", () => {
  const read = definition("read_file");
  read.function.parameters.properties = {
    path: {
      type: "string",
      enum: ["src/components/editor.js"],
    },
    start_line: { type: "number" },
    end_line: { type: "number" },
  };
  read.function.parameters.required = ["path"];
  const [normalized] = providerTools.normalizeRuntimeV2ProviderToolCalls([{
    id: "wrong-review-target",
    name: "read_file",
    arguments: { path: "src/main.js" },
  }], [read]);
  const violation = providerTools.runtimeV2ProviderToolArgumentViolation(
    [normalized],
    [read],
  );
  assert.equal(violation.call.id, "wrong-review-target");
  assert.match(violation.reason, /src\/components\/editor\.js/);

  const live = executionTypes.createRuntimeV2LiveExecutionState();
  let id = 0;
  const rejected = providerSurfaceRejection
    .rejectRuntimeV2InvalidProviderToolArguments({
      ports: {
        live,
        nextId: () => `argument-rejection-${++id}`,
        logStoreEvent: () => {},
      },
      command: command("validating"),
      tools: [read],
      result: {
        visibleText: "I will inspect another target.",
        toolCalls: [normalized],
        diagnostics: [],
      },
    });
  assert.deepEqual(rejected.toolCalls, []);
  assert.equal(rejected.visibleText, "");
  assert.match(live.messages.at(-1).content, /TOOL_ARGUMENTS_REJECTED/);
});

test("provider tool identity drops arguments absent from the advertised schema", () => {
  const read = definition("read_file");
  read.function.parameters.properties = {
    path: { type: "string" },
    start_line: { type: "number", runtimeIdentityDefault: 1 },
  };
  const [withTransportNoise, canonical] =
    providerTools.normalizeRuntimeV2ProviderToolCalls([{
      id: "read-with-noise",
      name: "read_file",
      arguments: {
        path: "src/components/toolbar.js",
        start_line: "1",
        reason: "I am rereading the same source",
        __provider_nonce: "different on every request",
      },
    }, {
      id: "read-canonical",
      name: "read_file",
      arguments: { path: "src/components/toolbar.js" },
    }], [read]);

  assert.deepEqual(withTransportNoise.arguments, {
    path: "src/components/toolbar.js",
  });
  assert.equal(
    providerToolSurface.runtimeV2ProviderToolCallIdentity(
      withTransportNoise,
    ),
    providerToolSurface.runtimeV2ProviderToolCallIdentity(canonical),
  );
});

test("provider action identity omits schema-declared optional defaults", () => {
  const read = definition("read_file");
  read.function.parameters.properties = {
    path: { type: "string" },
    start_line: { type: "number", runtimeIdentityDefault: 1 },
  };
  const [explicitDefault, omittedDefault] =
    providerTools.normalizeRuntimeV2ProviderToolCalls([{
      id: "read-explicit-default",
      name: "read_file",
      arguments: {
        path: "src/main.js",
        start_line: "1",
      },
    }, {
      id: "read-omitted-default",
      name: "read_file",
      arguments: { path: "src/main.js" },
    }], [read]);

  assert.deepEqual(explicitDefault.arguments, { path: "src/main.js" });
  assert.deepEqual(omittedDefault.arguments, { path: "src/main.js" });
  assert.equal(
    providerToolSurface.runtimeV2ProviderToolCallIdentity(explicitDefault),
    providerToolSurface.runtimeV2ProviderToolCallIdentity(omittedDefault),
  );
});

test("provider mutation aliases are canonical before action identity", () => {
  const replace = definition("replace_in_file");
  replace.function.parameters.properties = {
    path: { type: "string" },
    search_text: { type: "string" },
    replace_text: { type: "string" },
  };
  replace.function.parameters.required = [
    "path",
    "search_text",
    "replace_text",
  ];
  const [normalized] =
    providerTools.normalizeRuntimeV2ProviderToolCalls([{
      id: "replace-main",
      name: "replace_in_file",
      arguments: {
        target: "/workspace/src/main.js",
        old_content: "const before = true;",
        new_content: "const after = true;",
      },
    }], [replace], "/workspace");

  assert.deepEqual(normalized.arguments, {
    path: "src/main.js",
    search_text: "const before = true;",
    replace_text: "const after = true;",
  });
  assert.equal(
    providerToolSurface.runtimeV2ProviderToolCallIdentity(normalized),
    providerToolSurface.runtimeV2ProviderToolCallIdentity({
      ...normalized,
      arguments: {
        path: "src/main.js",
        search_text: "const before = true;",
        replace_text: "const after = true;",
      },
    }),
  );
});

test("a cached source range never excludes later windows from read_file", () => {
  const live = executionTypes.createRuntimeV2LiveExecutionState();
  live.messages.push({
    role: "assistant",
    content: "",
    tool_calls: [{
      id: "read-replayed",
      type: "function",
      function: {
        name: "read_file",
        arguments: JSON.stringify({ path: "src/main.js" }),
      },
    }],
  }, {
    role: "tool",
    tool_call_id: "read-replayed",
    content: "source stays readable",
  });
  const available = [definition("read_file")];
  available[0].function.parameters.properties.path = {
    type: "string",
    description: "workspace path",
  };
  available[0].function.parameters.required = ["path"];
  const select = () =>
    providerTools.selectRuntimeV2ProviderToolDefinitions({
      ports: {
        live,
        now: () => 1,
        lifecycleDeadlineAt: 200_000,
      },
      command: command("acting"),
      available,
    })[0];

  const afterReplay = select();
  assert.equal(
    afterReplay.function.parameters.properties.path.not,
    undefined,
    "a cached range must not turn into a path-wide read prohibition",
  );
  assert.doesNotMatch(
    afterReplay.function.parameters.properties.path.description,
    /Must not equal|closed path|exclusion/i,
  );

  live.messages.push({
    role: "assistant",
    content: "",
    tool_calls: [{
      id: "patch-main",
      type: "function",
      function: {
        name: "apply_patch",
        arguments: "{}",
      },
    }],
  }, {
    role: "tool",
    tool_call_id: "patch-main",
    content: "PATCH_APPLIED",
  });
  assert.equal(select().function.parameters.properties.path.not, undefined);
});

test("direct Execute mutation authority includes every source in its current read batch", () => {
  const live = executionTypes.createRuntimeV2LiveExecutionState();
  const sourceResult = (path, version, source) => [
      "READ_FILE_RESULT",
      `path: ${path}`,
      `contentVersion: ${version}`,
      "truncated: false",
      "totalLines: 1",
      `totalChars: ${source.length}`,
      "returnedLines: 1-1",
      `returnedChars: ${source.length}`,
      "---CONTENT START---",
      source,
      "---CONTENT END---",
    ].join("\n");
  const messages = [{
    role: "assistant",
    content: "",
    tool_calls: [{
      id: "toolbar-read",
      type: "function",
      function: {
        name: "read_file",
        arguments: JSON.stringify({
          path: "src/components/toolbar.js",
        }),
      },
    }, {
      id: "statusbar-read",
      type: "function",
      function: {
        name: "read_file",
        arguments: JSON.stringify({
          path: "src/components/statusbar.js",
        }),
      },
    }],
  }, {
    role: "tool",
    tool_call_id: "toolbar-read",
    content: sourceResult(
      "src/components/toolbar.js",
      "sha-toolbar-v1",
      "const toolbar = 'before';",
    ),
  }, {
    role: "tool",
    tool_call_id: "statusbar-read",
    content: sourceResult(
      "src/components/statusbar.js",
      "sha-statusbar-v1",
      "const statusbar = 'before';",
    ),
  }];
  const decisionView = providerHistory.buildRuntimeV2DecisionView(messages);
  const coverage = providerHistory.materializedRuntimeV2SourceCoverage(
    decisionView,
    "/tmp/runtime-v2-multi-target",
  );
  live.mutationSourceCoverageByToolCallId.set("mutate-toolbar", coverage);
  live.mutationSourceCoverageByToolCallId.set("mutate-statusbar", coverage);
  const ports = {
    get: () => ({ runtimeV2Checkpoints: {} }),
    context: {
      runWorkspace: "/tmp/runtime-v2-multi-target",
    },
    live,
  };

  const toolbar = correctiveMutationPolicy.validateRuntimeV2MutationLease({
    ports,
    toolCallId: "mutate-toolbar",
    toolName: "replace_in_file",
    args: {
      path: "src/components/toolbar.js",
      search_text: "before",
      replace_text: "after",
    },
    target: "src/components/toolbar.js",
  });
  const statusbar = correctiveMutationPolicy.validateRuntimeV2MutationLease({
    ports,
    toolCallId: "mutate-statusbar",
    toolName: "replace_in_file",
    args: {
      path: "src/components/statusbar.js",
      search_text: "before",
      replace_text: "after",
    },
    target: "src/components/statusbar.js",
  });

  assert.equal(toolbar?.allowed, true);
  assert.deepEqual(toolbar?.unexpectedTargets, []);
  assert.equal(statusbar?.allowed, true);
  assert.deepEqual(coverage.map((entry) => entry.target), [
    "src/components/toolbar.js",
    "src/components/statusbar.js",
  ]);
});

test("a recovery action window cannot be escaped by creating an unrelated file", () => {
  const live = executionTypes.createRuntimeV2LiveExecutionState();
  live.mutationSourceCoverageByToolCallId.set("recovery-write", [{
    target: "src/main.js",
    version: "main-v1",
    totalLines: 20,
    complete: true,
    windows: [{
      startLine: 1,
      endLine: 20,
      content: "export function saveFile() {}",
    }],
  }]);
  const ports = {
    get: () => ({ runtimeV2Checkpoints: {} }),
    context: { runWorkspace: "/tmp/runtime-v2-recovery-creation" },
    live,
  };
  const proposal = {
    ports,
    toolCallId: "recovery-write",
    toolName: "write_file",
    args: {
      path: "src/code-review-report.js",
      content: "export const report = true;",
    },
    target: "src/code-review-report.js",
  };

  assert.equal(
    correctiveMutationPolicy.validateRuntimeV2MutationLease(proposal)
      ?.allowed,
    true,
    "ordinary execution still permits a genuinely requested new file",
  );
  live.latestProviderActionWindow = "closed_recovery";
  const closed =
    correctiveMutationPolicy.validateRuntimeV2MutationLease(proposal);
  assert.equal(closed?.allowed, false);
  assert.deepEqual(
    closed?.unexpectedTargets,
    ["src/code-review-report.js"],
  );
  assert.equal(
    closed?.reasonCode,
    "mutation_target_lease_mismatch",
    "the bounded recovery decision must mutate visible source instead of manufacturing a progress boundary",
  );
});

test("a new source batch evicts unrelated archived source from the decision view", () => {
  const sourceResult = (path, version, marker) => [
    "READ_FILE_RESULT",
    `path: ${path}`,
    `contentVersion: ${version}`,
    "truncated: false",
    "totalLines: 1",
    `totalChars: ${marker.length}`,
    "returnedLines: 1-1",
    `returnedChars: ${marker.length}`,
    "---CONTENT START---",
    marker,
    "---CONTENT END---",
  ].join("\n");
  const messages = [{
    role: "system",
    content: "[MAIN RUNTIME V2]",
  }, {
    role: "user",
    runtimeTurnId: "turn",
    content: "Trace the complete file lifecycle.",
  }, {
    role: "assistant",
    content: "",
    tool_calls: [{
      id: "read-main",
      type: "function",
      function: {
        name: "read_file",
        arguments: JSON.stringify({ path: "src/main.js" }),
      },
    }, {
      id: "read-editor",
      type: "function",
      function: {
        name: "read_file",
        arguments: JSON.stringify({ path: "src/components/editor.js" }),
      },
    }],
  }, {
    role: "tool",
    tool_call_id: "read-main",
    content: sourceResult("src/main.js", "main-v1", "ARCHIVED_MAIN"),
  }, {
    role: "tool",
    tool_call_id: "read-editor",
    content: sourceResult(
      "src/components/editor.js",
      "editor-v1",
      "ARCHIVED_EDITOR",
    ),
  }, {
    role: "assistant",
    content: "",
    tool_calls: [{
      id: "read-rust",
      type: "function",
      function: {
        name: "read_file",
        arguments: JSON.stringify({ path: "src-tauri/src/main.rs" }),
      },
    }, {
      id: "read-tauri-config",
      type: "function",
      function: {
        name: "read_file",
        arguments: JSON.stringify({ path: "src-tauri/tauri.conf.json" }),
      },
    }],
  }, {
    role: "tool",
    tool_call_id: "read-rust",
    content: sourceResult(
      "src-tauri/src/main.rs",
      "rust-v1",
      "ACTIVE_RUST",
    ),
  }, {
    role: "tool",
    tool_call_id: "read-tauri-config",
    content: sourceResult(
      "src-tauri/tauri.conf.json",
      "tauri-v1",
      "ACTIVE_CONFIG",
    ),
  }];

  const view = providerHistory.buildRuntimeV2DecisionView(messages);
  const visible = view.map((message) => String(message.content || ""))
    .join("\n");
  assert.doesNotMatch(visible, /ARCHIVED_MAIN|ARCHIVED_EDITOR/);
  assert.match(visible, /ACTIVE_RUST/);
  assert.match(visible, /ACTIVE_CONFIG/);
  assert.equal(
    messages.some((message) =>
      message.role === "tool" &&
      String(message.content).includes("ARCHIVED_MAIN")
    ),
    true,
    "canonical history keeps the exact receipt available for replay",
  );
});

test("cross-file symbols keep exact current source in one causal workset", () => {
  const sourceResult = (path, version, lines) => [
    "READ_FILE_RESULT",
    `path: ${path}`,
    `contentVersion: ${version}`,
    "truncated: false",
    `totalLines: ${lines.length}`,
    `totalChars: ${lines.join("\n").length}`,
    `returnedLines: 1-${lines.length}`,
    `returnedChars: ${lines.join("\n").length}`,
    "---CONTENT START---",
    ...lines,
    "---CONTENT END---",
  ].join("\n");
  const messages = [{
    role: "system",
    content: "[MAIN RUNTIME V2]",
  }, {
    role: "user",
    runtimeTurnId: "turn",
    content: "Repair the save path.",
  }, {
    role: "assistant",
    content: "",
    reasoning_content: "OLD_PRIVATE_REASONING ".repeat(2_000),
    tool_calls: [{
      id: "read-main",
      type: "function",
      function: {
        name: "read_file",
        arguments: JSON.stringify({ path: "src/main.js" }),
      },
    }],
  }, {
    role: "tool",
    tool_call_id: "read-main",
    content: sourceResult("src/main.js", "main-v1", [
      "async function handleSaveFile() {",
      "  await invoke('save_file_content', { file_path: file.path });",
      "}",
    ]),
  }, {
    role: "assistant",
    content: "",
    reasoning_content: "CURRENT_PRIVATE_REASONING",
    tool_calls: [{
      id: "read-rust",
      type: "function",
      function: {
        name: "read_file",
        arguments: JSON.stringify({ path: "src-tauri/src/main.rs" }),
      },
    }],
  }, {
    role: "tool",
    tool_call_id: "read-rust",
    content: sourceResult("src-tauri/src/main.rs", "rust-v1", [
      "fn save_file_content(content: String, file_path: Option<String>) {",
      "}",
    ]),
  }];

  const view = providerHistory.buildRuntimeV2DecisionView(messages);
  assert.equal(
    view.some((message) =>
      message.role === "tool" &&
      message.tool_call_id === "read-main"
    ),
    true,
    "the caller remains exact standard tool evidence while reading its callee",
  );
  assert.equal(
    view.some((message) =>
      message.role === "system" &&
      String(message.content).includes("source bridge")
    ),
    false,
    "source content must never be rewritten into a synthetic system message",
  );
  assert.deepEqual(
    providerHistory.materializedRuntimeV2SourceCoverage(
      view,
      "/tmp/runtime-v2-causal-workset",
    ).map((entry) => entry.target),
    ["src/main.js", "src-tauri/src/main.rs"],
    "only the original standard read receipts create source authority",
  );
  const mainAssistant = view.find((message) =>
    message.role === "assistant" &&
    message.tool_calls?.some((call) => call.id === "read-main")
  );
  const rustAssistant = view.find((message) =>
    message.role === "assistant" &&
    message.tool_calls?.some((call) => call.id === "read-rust")
  );
  assert.equal(
    mainAssistant?.reasoning_content,
    undefined,
    "older private reasoning must not grow with the exact source workset",
  );
  assert.equal(
    rustAssistant?.reasoning_content,
    "CURRENT_PRIVATE_REASONING",
    "only the immediate tool frontier may retain provider reasoning continuity",
  );
});

test("a transitive cross-file source chain stays in one causal workset", () => {
  const sourceResult = (path, version, content) => [
    "READ_FILE_RESULT",
    `path: ${path}`,
    `contentVersion: ${version}`,
    "truncated: false",
    "totalLines: 1",
    `totalChars: ${content.length}`,
    "returnedLines: 1-1",
    `returnedChars: ${content.length}`,
    "---CONTENT START---",
    content,
    "---CONTENT END---",
  ].join("\n");
  const messages = [{
    role: "system",
    content: "[MAIN RUNTIME V2]",
  }, {
    role: "user",
    runtimeTurnId: "turn",
    content: "Trace the complete behavior before editing.",
  }, {
    role: "assistant",
    content: "",
    tool_calls: [{
      id: "read-entry",
      type: "function",
      function: {
        name: "read_file",
        arguments: JSON.stringify({ path: "src/entry.js" }),
      },
    }],
  }, {
    role: "tool",
    tool_call_id: "read-entry",
    content: sourceResult(
      "src/entry.js",
      "entry-v1",
      "function handleSaveFile() { return currentDocumentPath; }",
    ),
  }, {
    role: "assistant",
    content: "",
    tool_calls: [{
      id: "read-controls",
      type: "function",
      function: {
        name: "read_file",
        arguments: JSON.stringify({ path: "src/controls.js" }),
      },
    }],
  }, {
    role: "tool",
    tool_call_id: "read-controls",
    content: sourceResult(
      "src/controls.js",
      "controls-v1",
      "export function wireControls(handleSaveFile) { return dirtyIndicator; }",
    ),
  }, {
    role: "assistant",
    content: "",
    tool_calls: [{
      id: "read-view",
      type: "function",
      function: {
        name: "read_file",
        arguments: JSON.stringify({ path: "src/view.js" }),
      },
    }],
  }, {
    role: "tool",
    tool_call_id: "read-view",
    content: sourceResult(
      "src/view.js",
      "view-v1",
      "export function updateView(dirtyIndicator) { return true; }",
    ),
  }];

  const view = providerHistory.buildRuntimeV2DecisionView(messages);
  const visibleReadIds = view
    .filter((message) => message.role === "tool")
    .map((message) => message.tool_call_id);
  assert.deepEqual(
    visibleReadIds,
    ["read-entry", "read-controls", "read-view"],
    "the newest read must not evict an earlier source that remains connected through the current workset",
  );
});

test("replace_in_file accepts an exact block from any visible source window", () => {
  const live = executionTypes.createRuntimeV2LiveExecutionState();
  live.mutationSourceCoverageByToolCallId.set("prefix-mutation", [{
    target: "src/main.js",
    version: "main-v2",
    totalLines: 1111,
    complete: false,
    windows: [{
      startLine: 1,
      endLine: 1000,
      content: [
        "const first = true;",
        "title: '未命名',",
      ].join("\n"),
    }],
  }]);
  live.mutationSourceCoverageByToolCallId.set("tail-mutation", [{
    target: "src/main.js",
    version: "main-v2",
    totalLines: 1111,
    complete: false,
    windows: [{
      startLine: 90,
      endLine: 130,
      content: "title: '未命名',",
    }],
  }]);
  const ports = {
    get: () => ({ runtimeV2Checkpoints: {} }),
    context: { runWorkspace: "/tmp/runtime-v2-prefix-lease" },
    live,
  };
  const args = {
    path: "src/main.js",
    search_text: "title: '未命名',",
    replace_text: "title: '未命名文档',",
  };
  assert.equal(
    correctiveMutationPolicy.validateRuntimeV2MutationLease({
      ports,
      toolCallId: "prefix-mutation",
      toolName: "replace_in_file",
      args,
      target: "src/main.js",
    })?.allowed,
    true,
  );
  assert.equal(
    correctiveMutationPolicy.validateRuntimeV2MutationLease({
      ports,
      toolCallId: "tail-mutation",
      toolName: "replace_in_file",
      args,
      target: "src/main.js",
    })?.allowed,
    true,
  );
  assert.equal(
    correctiveMutationPolicy.validateRuntimeV2MutationLease({
      ports,
      toolCallId: "prefix-mutation",
      toolName: "replace_in_file",
      args: {
        ...args,
        search_text: "unseen tail text",
      },
      target: "src/main.js",
    })?.allowed,
    false,
  );
  assert.match(
    authorization.runtimeV2MutationLeaseRejectionReason({
      toolName: "replace_in_file",
      unexpectedTargets: ["src/main.js"],
      leaseTargets: ["src/main.js"],
    }),
    /REPLACE_SEARCH_TEXT_NOT_VISIBLE/,
  );
  assert.doesNotMatch(
    authorization.runtimeV2MutationLeaseRejectionReason({
      toolName: "replace_in_file",
      unexpectedTargets: ["src/main.js"],
      leaseTargets: ["src/main.js"],
    }),
    /must first read|必须先精确读取/i,
    "an exact-text mismatch must not tell the model to repeat a fully covered read",
  );
  assert.match(
    authorization.runtimeV2MutationLeaseRejectionReason({
      toolName: "replace_in_file",
      unexpectedTargets: ["src/missing.js"],
      leaseTargets: ["src/main.js"],
    }),
    /MUTATION_SOURCE_NOT_VISIBLE/,
  );
});

test("replace_in_file mismatch returns exact nearby source instead of trapping recovery in a reread", () => {
  const live = executionTypes.createRuntimeV2LiveExecutionState();
  const currentSource = [
    "// 设置当前文件",
    "export function setCurrentFile(file) {",
    "  toolbarState.currentFile = file;",
    "  updateToolbar();",
    "}",
    "",
    "// 更新主题",
    "export function updateTheme(theme) {",
    "  toolbarState.theme = theme;",
    "  updateToolbar();",
    "}entFile(filePath) {",
    "  toolbarState.currentFile = filePath;",
    "  const filePathEl = document.getElementById('file-path');",
    "}",
    "",
    "// 渲染工具栏",
    "export function renderToolbar() {}",
  ].join("\n");
  live.mutationSourceCoverageByToolCallId.set("repair-toolbar", [{
    target: "src/components/toolbar.js",
    version: "sha-toolbar-broken",
    totalLines: 108,
    complete: false,
    windows: [{
      startLine: 92,
      endLine: 108,
      content: currentSource,
    }],
  }]);
  const ports = {
    get: () => ({ runtimeV2Checkpoints: {} }),
    context: { runWorkspace: "/tmp/runtime-v2-mismatch-recovery" },
    live,
  };
  const result = correctiveMutationPolicy.validateRuntimeV2MutationLease({
    ports,
    toolCallId: "repair-toolbar",
    toolName: "replace_in_file",
    args: {
      path: "src/components/toolbar.js",
      search_text: [
        "// 设置当前文件",
        "export function setCurrentFile(file) {",
        "  toolbarState.currentFile = file;",
        "  updateToolbar();",
        "}",
        "",
        "// 渲染工具栏",
        "export function renderToolbar() {}",
      ].join("\n"),
      replace_text: "provider-authored replacement must not be echoed",
    },
    target: "src/components/toolbar.js",
  });

  assert.equal(result?.allowed, false);
  assert.equal(result?.reasonCode, "mutation_source_text_mismatch");
  assert.equal(result?.recoveryExcerpt?.target, "src/components/toolbar.js");
  assert.equal(result?.recoveryExcerpt?.version, "sha-toolbar-broken");
  assert.match(result?.recoveryExcerpt?.content || "", /\}entFile\(filePath\)/);
  assert.ok((result?.recoveryExcerpt?.startLine || 0) <= 102);
  assert.ok((result?.recoveryExcerpt?.endLine || 0) >= 102);

  const feedback = authorization.runtimeV2MutationLeaseRejectionReason({
    toolName: "replace_in_file",
    unexpectedTargets: result?.unexpectedTargets || [],
    leaseTargets: result?.leases.map((lease) => lease.target) || [],
    recoveryExcerpt: result?.recoveryExcerpt || null,
  });
  assert.match(feedback, /CURRENT_VERSIONED_SOURCE/);
  assert.match(feedback, /\}entFile\(filePath\)/);
  assert.match(feedback, /smallest|最小/iu);
  assert.doesNotMatch(feedback, /provider-authored replacement/);
});

test("replace_in_file mismatch prefers the longer later source anchor over an ambiguous duplicate prefix", () => {
  const live = executionTypes.createRuntimeV2LiveExecutionState();
  const currentSource = [
    "// 更新主题",
    "export function updateTheme(theme) {",
    "  toolbarState.theme = theme;",
    "  updateToolbar();",
    "}entFile(filePath) {",
    "  toolbarState.currentFile = filePath;",
    "  const filePathEl = document.getElementById('file-path');",
    "  if (filePathEl) {",
    "    filePathEl.textContent = filePath ? filePath.split('/').pop() : '';",
    "    filePathEl.style.display = filePath ? 'inline-block' : 'none';",
    "  }",
    "}",
    "",
    "// unrelated rendering body",
    "export function renderToolbar() {}",
    "",
    "// 更新主题",
    "export function updateTheme(theme) {",
    "  toolbarState.theme = theme;",
    "  updateThemeButton();",
    "}",
  ].join("\n");
  live.mutationSourceCoverageByToolCallId.set("ambiguous-toolbar", [{
    target: "src/components/toolbar.js",
    version: "sha-toolbar-ambiguous",
    totalLines: 220,
    complete: false,
    windows: [{
      startLine: 110,
      endLine: 130,
      content: currentSource,
    }],
  }]);
  const ports = {
    get: () => ({ runtimeV2Checkpoints: {} }),
    context: { runWorkspace: "/tmp/runtime-v2-ambiguous-mismatch" },
    live,
  };
  const result = correctiveMutationPolicy.validateRuntimeV2MutationLease({
    ports,
    toolCallId: "ambiguous-toolbar",
    toolName: "replace_in_file",
    args: {
      path: "src/components/toolbar.js",
      search_text: [
        "// 更新主题",
        "export function updateTheme(theme) {",
        "  toolbarState.theme = theme;",
        "  updateThemeButton();",
        "}entFile(filePath) {",
        "  toolbarState.currentFile = filePath;",
        "  const filePathEl = document.getElementById('file-path');",
        "  if (filePathEl) {",
        "    filePathEl.textContent = filePath ? filePath.split('/').pop() : '';",
        "    filePathEl.style.display = filePath ? 'inline-block' : 'none';",
        "  }",
        "}",
      ].join("\n"),
      replace_text: "fixed source",
    },
    target: "src/components/toolbar.js",
  });

  assert.equal(result?.reasonCode, "mutation_source_text_mismatch");
  assert.match(result?.recoveryExcerpt?.content || "", /\}entFile\(filePath\)/);
  assert.ok(
    (result?.recoveryExcerpt?.startLine || Number.POSITIVE_INFINITY) <= 114,
    "the receipt must center the damaged later anchor, not the valid duplicate at EOF",
  );
  assert.ok((result?.recoveryExcerpt?.endLine || 0) >= 114);
});

test("a correctable failed mutation reopens one exact cached read for recovery", () => {
  const sourceResult = [
    "READ_FILE_RESULT",
    "path: src/components/toolbar.js",
    "contentVersion: sha-toolbar-broken",
    "truncated: false",
    "totalLines: 2",
    "totalChars: 36",
    "returnedLines: 1-2",
    "returnedChars: 36",
    "---CONTENT START---",
    "export function renderToolbar() {",
    "}entFile(filePath) {}",
    "---CONTENT END---",
  ].join("\n");
  const readCall = (id) => ({
    role: "assistant",
    content: "",
    tool_calls: [{
      id,
      type: "function",
      function: {
        name: "read_file",
        arguments: JSON.stringify({ path: "src/components/toolbar.js" }),
      },
    }],
  });
  const readResult = (id) => ({
    role: "tool",
    tool_call_id: id,
    content: sourceResult,
  });
  const messages = [
    readCall("read-original"),
    readResult("read-original"),
    readCall("read-replay-before-mismatch"),
    readResult("read-replay-before-mismatch"),
    {
      role: "assistant",
      content: "",
      tool_calls: [{
        id: "mutation-mismatch",
        type: "function",
        function: {
          name: "replace_in_file",
          arguments: JSON.stringify({
            path: "src/components/toolbar.js",
            search_text: "imagined source",
            replace_text: "fixed source",
          }),
        },
      }],
    },
    {
      role: "tool",
      tool_call_id: "mutation-mismatch",
      content: "TOOL_BLOCKED: REPLACE_SEARCH_TEXT_NOT_VISIBLE",
    },
  ];
  const candidate = {
    id: "candidate-read",
    name: "read_file",
    arguments: { path: "src/components/toolbar.js" },
  };
  const effects = {
    committedMutationTargetsByToolCallId: new Map(),
    replayedToolCallIds: new Set(["read-replay-before-mismatch"]),
    sourceReadVersionsByToolCallId: new Map([[
      "read-original",
      {
        target: "src/components/toolbar.js",
        version: "sha-toolbar-broken",
      },
    ]]),
    correctiveReplayTargetsByToolCallId: new Map([[
      "mutation-mismatch",
      ["src/components/toolbar.js"],
    ]]),
    rejectedActionIdentities: new Set(),
  };

  assert.equal(
    providerToolSurface.runtimeV2ProviderCoveredSourceReplayIsClosed(
      candidate,
      messages,
      effects,
    ),
    false,
    "the mismatch creates a concrete need to replay the exact source once",
  );

  messages.push(
    readCall("read-replay-after-mismatch"),
    readResult("read-replay-after-mismatch"),
  );
  effects.replayedToolCallIds.add("read-replay-after-mismatch");
  assert.equal(
    providerToolSurface.runtimeV2ProviderCoveredSourceReplayIsClosed(
      candidate,
      messages,
      effects,
    ),
    true,
    "the recovery replay closes again until another real mismatch or mutation boundary",
  );

  messages.push({
    role: "assistant",
    content: "",
    tool_calls: [{
      id: "mutation-preflight-rejected",
      type: "function",
      function: {
        name: "replace_in_file",
        arguments: JSON.stringify({
          path: "src/components/toolbar.js",
          search_text: "}entFile(filePath) {}",
          replace_text: "export function setCurrentFile(filePath) {}",
        }),
      },
    }],
  }, {
    role: "tool",
    tool_call_id: "mutation-preflight-rejected",
    content: "MUTATION_PREFLIGHT_BLOCKED: duplicate_export(setCurrentFile)",
  });
  effects.correctiveReplayTargetsByToolCallId.set(
    "mutation-preflight-rejected",
    ["src/components/toolbar.js"],
  );
  assert.equal(
    providerToolSurface.runtimeV2ProviderCoveredSourceReplayIsClosed(
      candidate,
      messages,
      effects,
    ),
    false,
    "a parser-confirmed mutation rejection also reopens one bounded replay",
  );
});

test("a correctable mutation diagnostic survives its recovery read until a mutation commits", () => {
  const messages = [{
    role: "assistant",
    content: "",
    tool_calls: [{
      id: "preflight-rejected",
      type: "function",
      function: {
        name: "replace_in_file",
        arguments: JSON.stringify({
          path: "src/components/toolbar.js",
          search_text: "an over-broad imagined block",
          replace_text: "a duplicate declaration proposal",
        }),
      },
    }],
  }, {
    role: "tool",
    tool_call_id: "preflight-rejected",
    content: [
      "MUTATION_PREFLIGHT_BLOCKED: duplicate_export(setCurrentFile), duplicate_export(updateTheme)",
      "Keep the existing valid declarations and remove only the damaged obsolete fragment.",
    ].join("\n"),
  }, {
    role: "assistant",
    content: "",
    tool_calls: [{
      id: "recovery-read",
      type: "function",
      function: {
        name: "read_file",
        arguments: JSON.stringify({ path: "src/components/toolbar.js" }),
      },
    }],
  }, {
    role: "tool",
    tool_call_id: "recovery-read",
    content: [
      "READ_FILE_RESULT",
      "path: src/components/toolbar.js",
      "contentVersion: toolbar-broken-v1",
      "truncated: false",
      "totalLines: 2",
      "totalChars: 68",
      "returnedLines: 1-2",
      "returnedChars: 68",
      "---CONTENT START---",
      "export function setCurrentFile(file) {}",
      "}entFile(filePath) {}",
      "---CONTENT END---",
    ].join("\n"),
  }];
  const effects = {
    committedMutationTargetsByToolCallId: new Map(),
    replayedToolCallIds: new Set(),
    sourceReadVersionsByToolCallId: new Map([[
      "recovery-read",
      {
        target: "src/components/toolbar.js",
        version: "toolbar-broken-v1",
      },
    ]]),
    correctiveReplayTargetsByToolCallId: new Map([[
      "preflight-rejected",
      ["src/components/toolbar.js"],
    ]]),
    correctiveMutationFailureToolCallIds: new Set([
      "preflight-rejected",
    ]),
    rejectedActionIdentities: new Set(),
  };

  const view = providerHistory.buildRuntimeV2DecisionView(messages, effects);
  const rendered = view.map((message) =>
    String(message.content || "")
  ).join("\n");
  assert.match(rendered, /MUTATION_PREFLIGHT_BLOCKED/);
  assert.match(rendered, /remove only the damaged obsolete fragment/);
  assert.match(rendered, /\}entFile\(filePath\)/);
  const correctiveCall = view.flatMap((message) =>
    message.tool_calls || []
  ).find((call) => call.id === "preflight-rejected");
  assert.ok(correctiveCall);
  const correctiveArguments = JSON.parse(
    correctiveCall.function.arguments,
  );
  assert.equal(
    correctiveArguments.path,
    "src/components/toolbar.js",
  );
  assert.equal(correctiveArguments.effect, "none");
  assert.equal("search_text" in correctiveArguments, false);
  assert.equal("replace_text" in correctiveArguments, false);

  const afterCommit = providerHistory.buildRuntimeV2DecisionView(messages, {
    ...effects,
    correctiveMutationFailureToolCallIds: new Set(),
  });
  assert.doesNotMatch(
    afterCommit.map((message) => String(message.content || "")).join("\n"),
    /MUTATION_PREFLIGHT_BLOCKED/,
  );
});

test("a missing-source rejection reuses unchanged materialized target source for the corrective action window", () => {
  const readPair = (id, target, version, source) => [{
    role: "assistant",
    content: "",
    tool_calls: [{
      id,
      type: "function",
      function: {
        name: "read_file",
        arguments: JSON.stringify({ path: target }),
      },
    }],
  }, {
    role: "tool",
    tool_call_id: id,
    content: [
      "READ_FILE_RESULT",
      `path: ${target}`,
      `contentVersion: ${version}`,
      "truncated: false",
      `totalLines: ${source.split("\\n").length}`,
      `totalChars: ${source.length}`,
      `returnedLines: 1-${source.split("\\n").length}`,
      `returnedChars: ${source.length}`,
      "---CONTENT START---",
      source,
      "---CONTENT END---",
    ].join("\n"),
  }];
  const messages = [
    ...readPair(
      "read-main-before-toolbar-edit",
      "src/main.js",
      "main-v1",
      "let saveDialog;\nsaveDialog = save;",
    ),
    ...readPair(
      "read-unrelated-frontier",
      "index.html",
      "index-v1",
      "<main>unrelated frontier</main>",
    ),
    {
      role: "assistant",
      content: "",
      tool_calls: [{
        id: "commit-toolbar",
        type: "function",
        function: {
          name: "replace_in_file",
          arguments: JSON.stringify({
            path: "src/components/toolbar.js",
            search_text: "broken toolbar",
            replace_text: "fixed toolbar",
          }),
        },
      }],
    }, {
      role: "tool",
      tool_call_id: "commit-toolbar",
      content: "REPLACE_IN_FILE_RESULT: changed",
    }, {
      role: "assistant",
      content: "",
      tool_calls: [{
        id: "missing-main-source",
        type: "function",
        function: {
          name: "replace_in_file",
          arguments: JSON.stringify({
            path: "src/main.js",
            search_text: "provider patch is redacted from recovery",
            replace_text: "provider replacement is redacted too",
          }),
        },
      }],
    }, {
      role: "tool",
      tool_call_id: "missing-main-source",
      content: "TOOL_BLOCKED: MUTATION_SOURCE_NOT_VISIBLE",
    },
  ];
  const effects = {
    committedMutationTargetsByToolCallId: new Map([[
      "commit-toolbar",
      ["src/components/toolbar.js"],
    ]]),
    replayedToolCallIds: new Set(),
    sourceReadVersionsByToolCallId: new Map([
      ["read-main-before-toolbar-edit", {
        target: "src/main.js",
        version: "main-v1",
      }],
      ["read-unrelated-frontier", {
        target: "index.html",
        version: "index-v1",
      }],
    ]),
    correctiveReplayTargetsByToolCallId: new Map([[
      "missing-main-source",
      ["src/main.js"],
    ]]),
    correctiveMutationFailureToolCallIds: new Set([
      "missing-main-source",
    ]),
    rejectedActionIdentities: new Set(),
  };

  const view = providerHistory.buildRuntimeV2DecisionView(messages, effects);
  const rendered = view.map((message) => String(message.content || ""))
    .join("\n");
  assert.match(rendered, /let saveDialog;/);
  const coverage = providerHistory.materializedRuntimeV2SourceCoverage(
    view,
    "/workspace",
    effects,
  );
  assert.ok(coverage.some((entry) => entry.target === "src/main.js"));
  assert.equal(
    authorization.runtimeV2ProviderActionWindowFor({
      command: {
        payload: {
          effectPressure: { reason: "source_only_frontier" },
        },
      },
      effects,
      sourceCoverage: coverage,
    }),
    "corrective_mutation",
    "because the rejected editor changed no files, a still-materialized exact source receipt remains current",
  );

  const invalidatedEffects = {
    ...effects,
    committedMutationTargetsByToolCallId: new Map([[
      "commit-toolbar",
      ["src/main.js"],
    ]]),
  };
  const invalidatedView = providerHistory.buildRuntimeV2DecisionView(
    messages,
    invalidatedEffects,
  );
  assert.doesNotMatch(
    invalidatedView.map((message) => String(message.content || ""))
      .join("\n"),
    /let saveDialog;/,
    "a committed mutation of the same target invalidates older source",
  );
});

test("enabled collaboration stays optional at every execution stage", () => {
  const prompt = providerRequest.providerModeInstruction({
    payload: {
      mode: "execute",
      collaborationPreferred: true,
      collaborationAction: "optional",
      maxActiveSubagents: 2,
    },
  }, "", {
    hasReadFile: true,
    hasMutation: true,
    hasSpawnSubagent: true,
    hasWaitSubagents: false,
  });

  assert.match(prompt, /decide adaptively/i);
  assert.match(prompt, /never mandatory/i);
  assert.match(prompt, /not a prerequisite for mutation or completion/i);
});

test("execution prompt stops asking for the same source after versioned evidence exists", () => {
  const surface = {
    hasReadFile: true,
    hasMutation: true,
    hasSpawnSubagent: false,
    hasWaitSubagents: false,
  };
  const missing = providerRequest.providerModeInstruction({
    payload: {
      mode: "execute",
      toolExpectation: "required",
      hasVersionedSourceEvidence: false,
    },
  }, "", surface);
  const present = providerRequest.providerModeInstruction({
    payload: {
      mode: "execute",
      toolExpectation: "required",
      hasVersionedSourceEvidence: true,
    },
  }, "", {
    ...surface,
    hasMaterializedSourceEvidence: true,
  });
  const cachedOnly = providerRequest.providerModeInstruction({
    payload: {
      mode: "execute",
      toolExpectation: "required",
      hasVersionedSourceEvidence: true,
    },
  }, "", surface);

  assert.match(missing, /Read the exact existing file before changing it/);
  assert.match(present, /Exact versioned source is visible/);
  assert.doesNotMatch(
    present,
    /Read the exact existing file before changing it/,
  );
  assert.match(cachedOnly, /runtime cache but is not visible/);
  assert.match(cachedOnly, /replay it without another disk read/);
});

test("source-only pressure asks for an effect while keeping concrete reads available", () => {
  const prompt = providerRequest.providerModeInstruction({
    payload: {
      mode: "execute",
      toolExpectation: "required",
      hasVersionedSourceEvidence: true,
    },
  }, "", {
    hasReadFile: true,
    hasMutation: true,
    hasSpawnSubagent: false,
    hasWaitSubagents: false,
    hasMaterializedSourceEvidence: true,
    sourceOnlyFrontier: true,
    materializedSourceCoverage: [{
      target: "src/main.js",
      version: "sha256-main-v1",
      totalLines: 1111,
      complete: true,
      windows: [{
        startLine: 1,
        endLine: 1000,
        content: "prefix",
      }, {
        startLine: 1001,
        endLine: 1111,
        content: "tail",
      }],
    }],
  });

  assert.match(prompt, /no committed workspace effect/i);
  assert.match(prompt, /submit the mutation now/i);
  assert.match(prompt, /missing path, range, or fact/i);
  assert.match(prompt, /Safe reads remain available/i);
  assert.match(prompt, /editable_source/i);
  assert.match(prompt, /src\/main\.js/);
  assert.match(prompt, /sha256-main-v1/);
  assert.match(prompt, /1-1111/);
  assert.match(prompt, /replace_in_file/);
  assert.match(prompt, /apply_patch/);
  assert.doesNotMatch(prompt, /write_file/);
  assert.doesNotMatch(prompt, /prefix|tail/);
  assert.doesNotMatch(prompt, /round|attempt|Gemma|Qwen/i);
});

test("corrective action window closes observation but not the Run", () => {
  const prompt = providerRequest.providerModeInstruction({
    payload: {
      mode: "execute",
      hasVersionedSourceEvidence: true,
    },
  }, "", {
    hasReadFile: false,
    hasMutation: true,
    hasSpawnSubagent: false,
    hasWaitSubagents: false,
    hasMaterializedSourceEvidence: true,
    sourceOnlyFrontier: true,
    actionWindow: "corrective_mutation",
    materializedSourceCoverage: [{
      target: "src/components/toolbar.js",
      version: "sha-toolbar",
      totalLines: 213,
      complete: true,
      windows: [{
        startLine: 1,
        endLine: 213,
        content: "source",
      }],
    }],
  });

  assert.match(prompt, /CORRECTIVE_ACTION_WINDOW/);
  assert.match(prompt, /previous workspace mutation changed no files/i);
  assert.match(prompt, /observation branch is closed/i);
  assert.match(prompt, /Inspection and validation reopen/i);
  assert.doesNotMatch(prompt, /Continue reading|Safe reads remain available/i);
  assert.equal(
    providerRequest.runtimeV2ExecutionReasoningRequest({
      configured: "auto",
      sourceOnlyFrontier: true,
      hasMutationTool: true,
      providerSupportsReasoningToggle: true,
      actionWindow: "corrective_mutation",
    }),
    "explicit",
  );
});

test("execution prompt keeps positive source authority without reprinting rejected executable shapes", () => {
  const prompt = providerRequest.providerModeInstruction({
    payload: {
      mode: "execute",
      toolExpectation: "required",
      hasVersionedSourceEvidence: true,
    },
  }, "", {
    hasReadFile: true,
    hasMutation: true,
    hasSpawnSubagent: false,
    hasWaitSubagents: false,
    hasMaterializedSourceEvidence: true,
    sourceOnlyFrontier: true,
    rejectedActions: [
      "read_file({\"path\":\"src/main.js\",\"start_line\":1001})",
    ],
    materializedSourceCoverage: [{
      target: "src/main.js",
      version: "sha256-main-v1",
      totalLines: 1110,
      complete: true,
      windows: [{
        startLine: 1,
        endLine: 1000,
        content: "prefix",
      }, {
        startLine: 1001,
        endLine: 1110,
        content: "tail",
      }],
    }],
  });

  assert.match(prompt, /editable_source_v1/);
  assert.match(prompt, /src\/main\.js/);
  assert.match(prompt, /1-1110/);
  assert.match(prompt, /replace_in_file/);
  assert.doesNotMatch(prompt, /start_line/);
  assert.doesNotMatch(prompt, /currently ineligible/i);
});

test("validation prompt asks for evidence instead of another mutation", () => {
  const prompt = providerRequest.providerModeInstruction({
    payload: {
      mode: "validate",
      toolExpectation: "required",
      hasVersionedSourceEvidence: true,
    },
  }, "", {
    hasReadFile: true,
    hasMutation: true,
    hasSpawnSubagent: false,
    hasWaitSubagents: false,
  });

  assert.match(prompt, /latest committed mutation/i);
  assert.match(prompt, /finite/i);
  assert.match(prompt, /validation/i);
  assert.doesNotMatch(prompt, /Make the smallest coherent change/);
});

test("a truncated reasoning or visible action draft gets one bounded action-mode retry", () => {
  assert.equal(
    providerRequest.RUNTIME_V2_EXECUTION_CONTRACT_REASONING_RECOVERY_CHAR_LIMIT,
    12_000,
    "a provider that ignores thinking-off gets one bounded contract runway instead of three identical 4k cancellations",
  );
  const base = {
    finishReason: "length",
    reasoningChars: 12_000,
    toolCallCount: 0,
    availableToolCount: 19,
    reasoningRequest: "auto",
    providerSupportsReasoningToggle: true,
  };
  assert.equal(
    providerRequest.shouldRetryRuntimeV2WithoutReasoning(base),
    true,
  );
  assert.equal(
    providerRequest.shouldRetryRuntimeV2WithoutReasoning({
      ...base,
      reasoningRequest: "off",
    }),
    true,
    "a provider that ignores the first action-only control still receives one bounded corrective retry",
  );
  assert.equal(
    providerRequest.shouldRetryRuntimeV2WithoutReasoning({
      ...base,
      finishReason: "tool_calls",
      toolCallCount: 1,
    }),
    false,
  );
  assert.equal(
    providerRequest.shouldRetryRuntimeV2WithoutReasoning({
      ...base,
      reasoningChars: 0,
    }),
    false,
  );
  assert.equal(
    providerRequest.shouldRetryRuntimeV2WithoutReasoning({
      ...base,
      reasoningChars: 0,
      actionChars: 1_200,
      structuredActionRequired: true,
      providerSupportsReasoningToggle: false,
    }),
    true,
    "visible prose in a required-action phase is corrected even when the provider has no reasoning toggle",
  );
  assert.equal(
    providerRequest.shouldRetryRuntimeV2WithoutReasoning({
      ...base,
      reasoningChars: 0,
      actionChars: 1_200,
      structuredActionRequired: false,
    }),
    false,
    "ordinary complete-answer prose does not enter action recovery",
  );
  assert.equal(
    providerRequest.shouldRetryRuntimeV2WithoutReasoning({
      ...base,
      providerSupportsReasoningToggle: false,
    }),
    false,
  );
  assert.equal(
    providerRequest.runtimeV2ProviderOutputWasTruncated({
      finishReason: "length",
      toolCallCount: 0,
      availableToolCount: 19,
    }),
    true,
    "a second action-mode length truncation is recoverable, not a final answer",
  );
  assert.equal(
    providerRequest.runtimeV2ProviderOutputWasTruncated({
      finishReason: "stop",
      toolCallCount: 0,
      availableToolCount: 19,
    }),
    false,
  );
  assert.equal(
    providerRequest.runtimeV2ProviderOutputWasTruncated({
      finishReason: "length",
      toolCallCount: 1,
      availableToolCount: 19,
    }),
    false,
  );
  assert.equal(
    providerRequest.RUNTIME_V2_EXECUTION_CONTRACT_ACTIONLESS_CHAR_LIMIT,
    1_200,
    "a required contract action is redirected before a long visible essay can consume the turn",
  );
});

test("child lifecycle uses only the parent lifecycle deadline", () => {
  assert.equal(
    subagentRunner.runtimeV2ChildDeadlineAt(600_000),
    600_000,
    "a slow local child must not receive an independent 90 second cutoff",
  );
  assert.equal(
    subagentRunner.runtimeV2ChildDeadlineAt(undefined),
    Number.POSITIVE_INFINITY,
    "ordinary Execute children inherit the absence of a whole-task deadline",
  );
  assert.equal(
    subagentRunner.runtimeV2ChildDeadlineExceeded({
      signal: new AbortController().signal,
      deadlineAt: Number.POSITIVE_INFINITY,
      now: 9_999_999,
    }),
    false,
    "an ordinary child failure must not be mislabeled as a lifecycle deadline",
  );
  assert.equal(
    subagentRunner.runtimeV2ChildDeadlineExceeded({
      signal: new AbortController().signal,
      deadlineAt: 10_000,
      now: 10_000,
    }),
    true,
  );
  assert.equal(
    subagentRunner.runtimeV2ChildOutputTokenLimit({ outputBudget: 32_768 }),
    8_192,
    "one child provider step must not monopolize the local lane with the full Run output budget",
  );
  assert.equal(
    subagentRunner.runtimeV2ChildOutputTokenLimit({ outputBudget: 2_048 }),
    2_048,
  );
  assert.equal(
    subagentRunner.runtimeV2ChildOutputTokenLimit(null),
    4_096,
  );
  assert.doesNotMatch(
    runtime.runtimeV2SubagentFailureSummary({
      canceled: false,
      deadlineExceeded: false,
      recoveryStalled: false,
      evidence: [],
    }),
    /显式生命周期截止/,
  );
  const source = fs.readFileSync(path.join(
    workspaceRoot,
    "src/store/runtimeV2/executionSubagentRunner.ts",
  ), "utf8");
  assert.doesNotMatch(
    source,
    /requiresTool|child_required_tool_missing|investigation window is closed/i,
  );
  assert.doesNotMatch(
    source,
    /deadlineExceeded:\s*!canceled/,
    "ordinary child failure cannot be inferred to mean an expired deadline",
  );
});

test("child recovery timing counts only consecutive no-progress steps", () => {
  let lease = runtime.advanceRuntimeV2ChildRecoveryStallLease({
    current: null,
    progressed: false,
    now: 1_000,
  });
  assert.deepEqual(lease, {
    startedAt: 1_000,
    occurrence: 1,
  });
  lease = runtime.advanceRuntimeV2ChildRecoveryStallLease({
    current: lease,
    progressed: false,
    now: 2_000,
  });
  assert.deepEqual(lease, {
    startedAt: 1_000,
    occurrence: 2,
  });
  assert.equal(
    runtime.runtimeV2ChildRecoveryStallExpired(
      lease,
      1_000 + runtime.RUNTIME_V2_PROVIDER_RECOVERY_STALL_MS,
    ),
    true,
  );
  assert.equal(
    runtime.advanceRuntimeV2ChildRecoveryStallLease({
      current: lease,
      progressed: true,
      now: 1_000 + runtime.RUNTIME_V2_PROVIDER_RECOVERY_STALL_MS,
    }),
    null,
    "new child evidence clears the stall clock regardless of total child duration",
  );
});

test("child preserves a provider-selected batch of independent reads", () => {
  const calls = [{
    id: "read-main",
    name: "read_file",
    arguments: { path: "src/main.js" },
  }, {
    id: "search-save",
    name: "grep_search",
    arguments: { query: "handleSaveFile", path: "src" },
  }, {
    id: "outline-toolbar",
    name: "get_file_outline",
    arguments: { path: "src/components/toolbar.js" },
  }];

  assert.deepEqual(
    subagentRunner.boundRuntimeV2ChildToolCalls(calls),
    calls,
  );
  assert.deepEqual(
    subagentRunner.boundRuntimeV2ChildToolCalls([
      calls[0],
      {
        id: "validate",
        name: "run_command",
        arguments: { command: "npm test" },
      },
    ]),
    [calls[0]],
    "a side effect remains fenced from a read batch",
  );
  assert.deepEqual(
    subagentRunner.boundRuntimeV2ChildToolCalls(
      [calls[0]],
      new Set([
        providerToolSurface.runtimeV2ProviderToolCallIdentity(
          calls[0],
        ),
      ]),
    ),
    [],
  );
});

test("a child degrades only when it repeats an already-rejected closed action", () => {
  const call = {
    id: "repeat-editor-window",
    name: "read_file",
    arguments: {
      path: "src/components/editor.js",
      start_line: 30,
    },
  };
  const identity =
    providerToolSurface.runtimeV2ProviderToolCallIdentity(call);

  assert.equal(
    subagentRunner.runtimeV2ChildClosedActionLoopDetected({
      calls: [call],
      acceptedCallIds: new Set(),
      previouslyRejectedIdentities: new Set(),
    }),
    false,
    "the first rejection must still give the child one real recovery decision",
  );
  assert.equal(
    subagentRunner.runtimeV2ChildClosedActionLoopDetected({
      calls: [call],
      acceptedCallIds: new Set(),
      previouslyRejectedIdentities: new Set([identity]),
    }),
    true,
    "repeating the same immutable closed action after explicit feedback cannot make progress",
  );
});

test("a child closes parameter churn after the same observation repeats past feedback", () => {
  const fingerprint =
    "subagent:src/components/toolbar.js:sha256-same-window";
  assert.equal(
    subagentRunner.runtimeV2ChildClosedObservationLoopDetected({
      fingerprint,
      isNewEvidence: false,
      previouslyRejectedFingerprints: new Set(),
    }),
    false,
    "the first semantic repeat must return corrective feedback",
  );
  assert.equal(
    subagentRunner.runtimeV2ChildClosedObservationLoopDetected({
      fingerprint,
      isNewEvidence: false,
      previouslyRejectedFingerprints: new Set([fingerprint]),
    }),
    true,
    "changing read arguments cannot keep a child alive when the tool observation is unchanged",
  );
  assert.equal(
    subagentRunner.runtimeV2ChildClosedObservationLoopDetected({
      fingerprint: `${fingerprint}:new-window`,
      isNewEvidence: true,
      previouslyRejectedFingerprints: new Set([fingerprint]),
    }),
    false,
    "a genuinely new source window remains progress regardless of child age",
  );
});

test("child retains the complete admitted read window", () => {
  const content = [
    "READ_FILE_RESULT",
    "path: src/main.js",
    "truncated: false",
    "---CONTENT START---",
    "x".repeat(48_000),
    "COMPLETE_CHILD_WINDOW_TAIL",
    "---CONTENT END---",
  ].join("\n");

  assert.equal(
    subagentRunner.runtimeV2ChildToolOutputContent(
      "read_file",
      content,
      { readWindowChars: 64_000 },
    ),
    content,
  );
});

test("rejected collaboration calls close their standard tool transcript", async () => {
  const turn = {
    workspaceKey: "/fixture",
    sessionKey: "session",
    sessionEpoch: "epoch",
    clientSubmissionId: "submission",
    turnId: "turn",
  };
  const run = {
    sessionKey: "session",
    sessionEpoch: "epoch",
    turnId: "turn",
    runId: "run",
    parentRunId: null,
    attemptId: "attempt",
  };
  let sequence = 0;
  const nextEvent = (type, fields) => ({
    schemaVersion: runtime.RUNTIME_V2_EVENT_SCHEMA_VERSION,
    sequence: sequence++,
    eventId: `event-${sequence}`,
    at: sequence,
    type,
    ...fields,
  });
  let aggregate = runtime.transition(null, nextEvent("turn.admitted", {
    turn,
    strategy: "execute",
    objective: "Repair the fixture",
    constraints: [],
    acceptanceCriteria: ["Repair the fixture"],
    acceptanceCriterionIds: ["criterion-user-objective"],
    acceptanceEvidenceRequirements: ["behavioral"],
  }));
  aggregate = runtime.transition(aggregate, nextEvent("run.started", {
    run,
    phase: "observing",
  }));
  const candidate = {
    scopeKey: "review-main",
    taskKind: "review",
    name: "Main reviewer",
    role: "reviewer",
    objective: "Review main",
    successCriteria: "Report the relevant finding",
    allowedPaths: ["src/main.js"],
  };
  const scheduled = runtime.scheduleReadOnlySubagents({
    parentRun: run,
    candidates: [candidate],
    maxActiveJobs: 2,
    requestedAt: sequence + 1,
    nextId: () => "child-existing",
  });
  aggregate = runtime.transition(aggregate, nextEvent(
    "subagents.scheduled",
    { run, maxActiveSubagents: 2, jobs: scheduled.jobs },
  ));
  const checkpoint = runtime.createRuntimeV2Checkpoint({
    revision: 1,
    aggregate,
    updatedAt: aggregate.updatedAt,
  });
  const live = executionTypes.createRuntimeV2LiveExecutionState();
  live.messages.push({
    role: "assistant",
    content: "",
    tool_calls: [{
      id: "spawn-call",
      type: "function",
      function: {
        name: "spawn_subagent",
        arguments: "{}",
      },
    }],
  });
  const port = schedulerPort.createRuntimeV2SchedulerPort({
    get: () => ({
      runtimeV2Checkpoints: { [turn.turnId]: checkpoint },
    }),
    context: { turnId: turn.turnId },
    live,
    nextId: () => "child-new",
    now: () => 100,
    lifecycleDeadlineAt: 10_000,
    logStoreEvent: () => undefined,
  });
  await assert.rejects(
    port.prepareSchedule({
      command: {
        idempotencyKey: "schedule-duplicate",
        kind: "schedule_subagents",
        phase: "observing",
        run,
        payload: {
          toolCallId: "spawn-call",
          arguments: {
            task_key: candidate.scopeKey,
            task_kind: candidate.taskKind,
            name: candidate.name,
            role: candidate.role,
            objective: candidate.objective,
            success_criteria: candidate.successCriteria,
            allowed_paths: candidate.allowedPaths.join(","),
          },
        },
      },
    }),
  );
  assert.equal(live.messages.at(-1)?.role, "tool");
  assert.equal(live.messages.at(-1)?.tool_call_id, "spawn-call");
  assert.match(String(live.messages.at(-1)?.content || ""), /rejected/i);
});

test("joined child evidence gets a delivery receipt only after entering the canonical parent transcript", async () => {
  const run = {
    sessionKey: "session",
    sessionEpoch: "epoch",
    turnId: "turn",
    runId: "run",
    parentRunId: null,
    attemptId: "attempt",
  };
  const job = {
    id: "child-review",
    run: {
      ...run,
      runId: "run:child:child-review",
      parentRunId: run.runId,
      attemptId: "attempt:child:child-review",
    },
    parentRunId: run.runId,
    sourceToolCallId: "spawn-review",
    scopeKey: "review-main",
    taskKind: "review",
    objective: "Review main",
    allowedPaths: ["src/main.js"],
    status: "running",
    requestedAt: 10,
    firstTokenAt: 20,
    closedAt: 30,
    summary: null,
    report: null,
  };
  const live = executionTypes.createRuntimeV2LiveExecutionState();
  live.messages.push({
    role: "assistant",
    content: "",
    tool_calls: [{
      id: "wait-review",
      type: "function",
      function: {
        name: "wait_subagents",
        arguments: "{}",
      },
    }],
  });
  live.childRuns.set(job.id, Promise.resolve({
    job,
    status: "degraded",
    summary: "The child found one evidence-backed owner for parent review.",
    report: null,
    inheritedEvidence: [],
    evidence: [{
      id: "child-main-owner",
      kind: "subagent",
      target: "src/main.js",
      version: "sha-main",
    }],
  }));
  live.childTelemetry.set(job.id, {
    firstTokenAt: 20,
    closedAt: 30,
  });
  const loggedEvents = [];
  const port = schedulerPort.createRuntimeV2SchedulerPort({
    get: () => ({ runtimeV2Checkpoints: {} }),
    context: { turnId: run.turnId },
    live,
    nextId: (scope) => `${scope}-1`,
    now: () => 40,
    lifecycleDeadlineAt: 10_000,
    logStoreEvent: (name, payload) => loggedEvents.push({ name, payload }),
  });
  const command = {
    idempotencyKey: "join-review",
    kind: "join_subagents",
    phase: "observing",
    run,
    payload: {
      toolCallId: "wait-review",
      jobIds: [job.id],
      automaticJoinReason:
        "parent_closed_action_while_children_active",
    },
  };
  const events = await port.execute({
    command,
    run,
    signal: new AbortController().signal,
    scheduledSubagents: [job],
  });
  const delivered = events.find((candidate) =>
    candidate.type === "subagent.handoff_delivered"
  );
  assert.deepEqual(delivered, {
    type: "subagent.handoff_delivered",
    run,
    jobId: job.id,
    contextEntryId: `child:${job.id}`,
    evidenceIds: ["child-main-owner"],
  });
  const context = live.messages.find((message) =>
    message.role === "system" &&
    String(message.content || "").startsWith(
      `[runtime-v2 context: child:${job.id}]`,
    )
  );
  assert.ok(context);
  assert.match(String(context.content), /Evidence ids: child-main-owner/);
  assert.match(
    String(context.content),
    /explicitly cite its exact evidence id/,
  );
  assert.match(
    String(live.messages.at(-1)?.content || ""),
    /uncited child result remains delivered but not adopted/,
  );
  assert.deepEqual(
    loggedEvents.find((entry) =>
      entry.name === "runtime_v2_subagent_auto_join"
    )?.payload,
    {
      turnId: run.turnId,
      runId: run.runId,
      jobIds: [job.id],
      reason: "parent_closed_action_while_children_active",
    },
  );
});

test("main execution carries the native assistant/tool pair into the next model request", () => {
  const live = executionTypes.createRuntimeV2LiveExecutionState();
  const ports = {
    get: () => ({
      config: { local: { contextLimit: 16_384 } },
      conversationTurns: [{
        id: "turn",
        userPrompt: "Repair the broken toolbar",
      }],
      agentMessages: [{
        role: "user",
        runtimeTurnId: "turn",
        content: "Repair the broken toolbar",
      }],
    }),
    context: {
      turnId: "turn",
      runWorkspace: "/tmp/runtime-v2-history",
      phaseLanguage: "en",
    },
    live,
    nextId: (scope) => `${scope}-1`,
  };
  providerHistory.providerHistory(live, ports);

  const sourceTail = "export function setCurrentFile(filePath) {";
  const source = `${"// retained source\n".repeat(420)}${sourceTail}`;
  live.latestProviderAssistantReasoning = {
    content: "The toolbar source is the next exact dependency.",
    field: "reasoning_content",
  };
  providerHistory.appendRuntimeV2AssistantToolCallHistory(live, {
    visibleText: "",
    content: "",
    toolCalls: [{
      id: "read-toolbar",
      name: "read_file",
      arguments: { path: "src/components/toolbar.js" },
    }],
    usage: {},
    diagnostics: [],
  });
  evidence.recordToolResultHistory({
    ports,
    command: {
      idempotencyKey: "execute-read-toolbar",
      kind: "execute_tool",
      phase: "acting",
      run: {
        sessionKey: "session",
        sessionEpoch: "epoch",
        turnId: "turn",
        runId: "run",
        parentRunId: null,
        attemptId: "attempt",
      },
      payload: {
        toolCallId: "read-toolbar",
        toolName: "read_file",
        arguments: { path: "src/components/toolbar.js" },
      },
    },
    toolName: "read_file",
    target: "src/components/toolbar.js",
    status: "succeeded",
    content: source,
  });

  const request = providerHistory.providerHistory(live, ports);
  const assistant = request.messages.find((message) =>
    message.role === "assistant" &&
    message.tool_calls?.some((call) => call.id === "read-toolbar")
  );
  const tool = request.messages.find((message) =>
    message.role === "tool" &&
    message.tool_call_id === "read-toolbar"
  );

  assert.ok(assistant);
  assert.ok(tool);
  assert.equal(
    assistant.reasoning_content,
    "The toolbar source is the next exact dependency.",
  );
  assert.equal(live.latestProviderAssistantReasoning, null);
  assert.match(String(tool.content), new RegExp(sourceTail.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("parent requests receive the exact live project-rule snapshot, not legacy memory", () => {
  const live = executionTypes.createRuntimeV2LiveExecutionState();
  const workspaceInstructionContext = [
    "## AGENTS.md",
    "Source: AGENTS.md",
    "Keep the toolbar public API stable.",
  ].join("\n");
  const ports = {
    get: () => ({
      config: {},
      conversationTurns: [{
        id: "turn",
        userPrompt: "repair",
      }],
      agentMessages: [{
        role: "user",
        runtimeTurnId: "turn",
        content: "repair",
      }],
    }),
    context: {
      turnId: "turn",
      runWorkspace: "/tmp/runtime-v2-history",
      phaseLanguage: "en",
      workspaceInstructionContext,
    },
    live,
  };

  const request = providerHistory.providerHistory(live, ports);
  const runtimeSystem = String(request.messages[0]?.content || "");

  assert.match(runtimeSystem, /LIVE WORKSPACE INSTRUCTIONS/);
  assert.match(runtimeSystem, /Keep the toolbar public API stable/);
  assert.doesNotMatch(runtimeSystem, /session_memory/i);
});

test("main execution bounds old tool pairs while retaining the latest complete pair", () => {
  const messages = [{
    role: "system",
    content: "runtime system",
  }, {
    role: "user",
    content: "repair the complete objective",
  }];
  for (let index = 1; index <= 12; index += 1) {
    const id = `read-${index}`;
    messages.push({
      role: "assistant",
      content: "",
      tool_calls: [{
        id,
        type: "function",
        function: {
          name: "read_file",
          arguments: JSON.stringify({
            path: "src/main.js",
            start_line: (index - 1) * 100 + 1,
          }),
        },
      }],
    }, {
      role: "tool",
      tool_call_id: id,
      content: `window-${index}\n${"x".repeat(7_000)}`,
    });
  }

  const bounded = providerHistory.boundRuntimeV2ProviderConversation(
    messages,
    {
      contextLimit: 16_384,
      reservedOutputTokens: 8_192,
    },
  );

  assert.ok(bounded.length < messages.length);
  assert.ok(bounded.some((message) =>
    message.role === "user" &&
    String(message.content).includes("repair the complete objective")
  ));
  assert.ok(bounded.some((message) =>
    message.role === "tool" &&
    message.tool_call_id === "read-12" &&
    String(message.content).includes("window-12")
  ));
  for (const message of bounded) {
    if (message.role !== "tool") continue;
    assert.ok(bounded.some((candidate) =>
      candidate.role === "assistant" &&
      candidate.tool_calls?.some((call) =>
        call.id === message.tool_call_id
      )
    ));
  }
});

test("a local focus replaces archived broad source in the current decision", () => {
  const focusedSource = [
    "READ_FILE_RESULT",
    "path: src/main.js",
    "contentVersion: main-v1",
    "truncated: true",
    "totalLines: 1110",
    "totalChars: 33519",
    "returnedLines: 350-500",
    "returnedChars: 4200",
    "nextStartLine: 501",
    "---CONTENT START---",
    "function openFiles() {",
    "  return currentFile;",
    "}",
    "---CONTENT END---",
  ].join("\n");
  const messages = [{
    role: "system",
    content: "[MAIN RUNTIME V2]",
  }, {
    role: "user",
    runtimeTurnId: "turn",
    content: "Fix the open and save lifecycle.",
  }, {
    role: "assistant",
    content: "",
    tool_calls: [{
      id: "read-broad",
      type: "function",
      function: {
        name: "read_file",
        arguments: JSON.stringify({ path: "src/main.js" }),
      },
    }],
  }, {
    role: "tool",
    tool_call_id: "read-broad",
    content: [
      "READ_FILE_RESULT",
      "path: src/main.js",
      "contentVersion: main-v1",
      "truncated: true",
      "totalLines: 1110",
      "totalChars: 33519",
      "returnedLines: 1-1000",
      "returnedChars: 30000",
      "nextStartLine: 1001",
      "---CONTENT START---",
      "function setCurrentFile() { return 'broad source'; }",
      "---CONTENT END---",
    ].join("\n"),
  }, {
    role: "assistant",
    content: "",
    tool_calls: [{
      id: "read-tail",
      type: "function",
      function: {
        name: "read_file",
        arguments: JSON.stringify({
          path: "src/main.js",
          start_line: 1001,
        }),
      },
    }],
  }, {
    role: "tool",
    tool_call_id: "read-tail",
    content: [
      "READ_FILE_RESULT",
      "path: src/main.js",
      "contentVersion: main-v1",
      "truncated: true",
      "totalLines: 1110",
      "totalChars: 33519",
      "returnedLines: 1001-1110",
      "returnedChars: 3519",
      "---CONTENT START---",
      "non-overlapping source tail",
      "---CONTENT END---",
    ].join("\n"),
  }, {
    role: "assistant",
    content: "",
    tool_calls: [{
      id: "read-toolbar-bridge",
      type: "function",
      function: {
        name: "read_file",
        arguments: JSON.stringify({
          path: "src/components/toolbar.js",
        }),
      },
    }],
  }, {
    role: "tool",
    tool_call_id: "read-toolbar-bridge",
    content: [
      "READ_FILE_RESULT",
      "path: src/components/toolbar.js",
      "contentVersion: toolbar-v1",
      "truncated: false",
      "totalLines: 2",
      "totalChars: 65",
      "returnedLines: 1-2",
      "returnedChars: 65",
      "---CONTENT START---",
      "export function setCurrentFile() {}",
      "export function openFiles() {}",
      "---CONTENT END---",
    ].join("\n"),
  }, {
    role: "assistant",
    content: "",
    tool_calls: [{
      id: "read-older-focus",
      type: "function",
      function: {
        name: "read_file",
        arguments: JSON.stringify({
          path: "src/main.js",
          start_line: 300,
          end_line: 340,
        }),
      },
    }],
  }, {
    role: "tool",
    tool_call_id: "read-older-focus",
    content: [
      "READ_FILE_RESULT",
      "path: src/main.js",
      "contentVersion: main-v1",
      "truncated: true",
      "totalLines: 1110",
      "totalChars: 33519",
      "returnedLines: 300-340",
      "returnedChars: 1200",
      "---CONTENT START---",
      "function openFiles() { return 'older local focus'; }",
      "---CONTENT END---",
    ].join("\n"),
  }, {
    role: "assistant",
    content: "",
    tool_calls: [{
      id: "read-focused-replay",
      type: "function",
      function: {
        name: "read_file",
        arguments: JSON.stringify({
          path: "src/main.js",
          start_line: 350,
          end_line: 500,
        }),
      },
    }],
  }, {
    role: "tool",
    tool_call_id: "read-focused-replay",
    content: focusedSource,
  }];

  const view = providerHistory.buildRuntimeV2DecisionView(messages);
  assert.equal(
    messages.some((message) =>
      message.role === "tool" &&
      message.tool_call_id === "read-broad"
    ),
    true,
    "canonical history retains the complete retrievable source receipt",
  );
  assert.equal(
    view.some((message) =>
      message.role === "tool" &&
      message.tool_call_id === "read-broad"
    ),
    false,
    "a deliberate local focus should not drag the archived full source forward",
  );
  assert.equal(
    view.some((message) =>
      message.role === "tool" &&
      message.tool_call_id === "read-focused-replay"
    ),
    true,
    "the latest focus remains active so the model sees its immediate tool result",
  );
  assert.equal(
    view.some((message) =>
      message.role === "tool" &&
      message.tool_call_id === "read-older-focus"
    ),
    false,
    "a redundant contained focus need not duplicate the complete source",
  );
  assert.equal(
    view.some((message) =>
      message.role === "tool" &&
      message.tool_call_id === "read-tail"
    ),
    false,
    "the earlier complete-file chain remains retrievable but is no longer the active focus",
  );
  assert.match(
    String(view.find((message) =>
      message.role === "tool" &&
      message.tool_call_id === "read-focused-replay"
    )?.content || ""),
    /function openFiles/,
  );
  assert.doesNotMatch(
    String(view.find((message) =>
      message.role === "tool" &&
      message.tool_call_id === "read-focused-replay"
    )?.content || ""),
    /SOURCE_ALREADY_MATERIALIZED/,
  );
});

test("decision view preserves every same-file focus selected in the latest read batch", () => {
  const sourceResult = (startLine, endLine, body) => [
    "READ_FILE_RESULT",
    "path: src/main.js",
    "contentVersion: main-v1",
    "truncated: true",
    "totalLines: 1110",
    "totalChars: 33519",
    `returnedLines: ${startLine}-${endLine}`,
    `returnedChars: ${body.length}`,
    "---CONTENT START---",
    body,
    "---CONTENT END---",
  ].join("\n");
  const messages = [{
    role: "system",
    content: "[MAIN RUNTIME V2]",
  }, {
    role: "user",
    runtimeTurnId: "turn",
    content: "Compare creation and switching before editing.",
  }, {
    role: "assistant",
    content: "",
    tool_calls: [{
      id: "read-broad",
      type: "function",
      function: {
        name: "read_file",
        arguments: JSON.stringify({ path: "src/main.js" }),
      },
    }],
  }, {
    role: "tool",
    tool_call_id: "read-broad",
    content: sourceResult(1, 1000, "broad source"),
  }, {
    role: "assistant",
    content: "",
    tool_calls: [{
      id: "read-create",
      type: "function",
      function: {
        name: "read_file",
        arguments: JSON.stringify({
          path: "src/main.js",
          start_line: 180,
          end_line: 220,
        }),
      },
    }, {
      id: "read-switch",
      type: "function",
      function: {
        name: "read_file",
        arguments: JSON.stringify({
          path: "src/main.js",
          start_line: 320,
          end_line: 380,
        }),
      },
    }],
  }, {
    role: "tool",
    tool_call_id: "read-create",
    content: sourceResult(180, 220, "CREATE_FOCUS"),
  }, {
    role: "tool",
    tool_call_id: "read-switch",
    content: sourceResult(320, 380, "SWITCH_FOCUS"),
  }];

  const view = providerHistory.buildRuntimeV2DecisionView(messages);
  const visible = view.map((message) =>
    String(message.content || "")
  ).join("\n");
  assert.match(visible, /CREATE_FOCUS/);
  assert.match(visible, /SWITCH_FOCUS/);
  assert.doesNotMatch(visible, /SOURCE_ALREADY_MATERIALIZED/);
});

test("decision view keeps continuously extending windows for complete large-file semantics", () => {
  const messages = [{
    role: "system",
    content: "[MAIN RUNTIME V2]",
  }, {
    role: "user",
    runtimeTurnId: "turn",
    content: "Understand the complete large source before editing.",
  }, {
    role: "assistant",
    content: "",
    tool_calls: [{
      id: "read-prefix",
      type: "function",
      function: {
        name: "read_file",
        arguments: JSON.stringify({ path: "src/main.js" }),
      },
    }],
  }, {
    role: "tool",
    tool_call_id: "read-prefix",
    content: [
      "READ_FILE_RESULT",
      "path: src/main.js",
      "contentVersion: main-v1",
      "truncated: true",
      "totalLines: 1110",
      "totalChars: 33519",
      "returnedLines: 1-1000",
      "returnedChars: 30000",
      "nextStartLine: 1001",
      "---CONTENT START---",
      "SOURCE_PREFIX",
      "---CONTENT END---",
    ].join("\n"),
  }, {
    role: "assistant",
    content: "",
    tool_calls: [{
      id: "read-continuation",
      type: "function",
      function: {
        name: "read_file",
        arguments: JSON.stringify({
          path: "src/main.js",
          start_line: 1000,
        }),
      },
    }],
  }, {
    role: "tool",
    tool_call_id: "read-continuation",
    content: [
      "READ_FILE_RESULT",
      "path: src/main.js",
      "contentVersion: main-v1",
      "truncated: true",
      "totalLines: 1110",
      "totalChars: 33519",
      "returnedLines: 1000-1110",
      "returnedChars: 3519",
      "---CONTENT START---",
      "SOURCE_TAIL",
      "---CONTENT END---",
    ].join("\n"),
  }];

  const effects = {
    committedMutationTargetsByToolCallId: new Map(),
    replayedToolCallIds: new Set(),
    sourceReadVersionsByToolCallId: new Map([
      ["read-prefix", {
        target: "src/main.js",
        version: "main-v1",
      }],
      ["read-continuation", {
        target: "src/main.js",
        version: "main-v1",
      }],
    ]),
  };
  const view = providerHistory.buildRuntimeV2DecisionView(
    messages,
    effects,
  );
  assert.equal(
    view.some((message) =>
      message.role === "tool" &&
      message.tool_call_id === "read-prefix"
    ),
    true,
  );
  assert.equal(
    view.some((message) =>
      message.role === "tool" &&
      message.tool_call_id === "read-continuation"
    ),
    true,
  );
  assert.deepEqual(
    providerHistory.materializedRuntimeV2SourceCoverage(
      view,
      "/tmp/runtime-v2-continuous-source",
      effects,
    ).map((entry) => ({
      target: entry.target,
      version: entry.version,
      complete: entry.complete,
      windows: entry.windows.map((window) => [
        window.startLine,
        window.endLine,
      ]),
    })),
    [{
      target: "src/main.js",
      version: "main-v1",
      complete: true,
      windows: [[1, 1000], [1000, 1110]],
    }],
  );
});

test("a cross-file semantic bridge preserves the complete source window set for its path", () => {
  const mainLines = [
    "const sharedController = createToolbar();",
    "function openFiles() { return sharedController; }",
    "function saveCurrentFile() { return sharedController; }",
    "export { saveCurrentFile };",
  ];
  const mainSource = mainLines.join("\n");
  const toolbarSource =
    "export function setCurrentFile(sharedController) { return sharedController; }";
  const sourceResult = ({
    path,
    version,
    totalLines,
    totalChars,
    startLine,
    endLine,
    content,
    truncated,
    nextStartLine,
  }) => [
    "READ_FILE_RESULT",
    `path: ${path}`,
    `contentVersion: ${version}`,
    `truncated: ${truncated ? "true" : "false"}`,
    `totalLines: ${totalLines}`,
    `totalChars: ${totalChars}`,
    `returnedLines: ${startLine}-${endLine}`,
    `returnedChars: ${content.length}`,
    nextStartLine ? `nextStartLine: ${nextStartLine}` : "",
    "---CONTENT START---",
    content,
    "---CONTENT END---",
  ].filter(Boolean).join("\n");
  const messages = [{
    role: "system",
    content: "[MAIN RUNTIME V2]",
  }, {
    role: "user",
    runtimeTurnId: "turn",
    content: "Repair the file lifecycle without losing current source.",
  }, {
    role: "assistant",
    content: "",
    tool_calls: [{
      id: "read-main-prefix",
      type: "function",
      function: {
        name: "read_file",
        arguments: JSON.stringify({
          path: "src/main.js",
          start_line: 1,
          end_line: 2,
        }),
      },
    }],
  }, {
    role: "tool",
    tool_call_id: "read-main-prefix",
    content: sourceResult({
      path: "src/main.js",
      version: "main-v1",
      totalLines: 4,
      totalChars: mainSource.length,
      startLine: 1,
      endLine: 2,
      content: mainLines.slice(0, 2).join("\n"),
      truncated: true,
      nextStartLine: 3,
    }),
  }, {
    role: "assistant",
    content: "",
    tool_calls: [{
      id: "read-main-tail",
      type: "function",
      function: {
        name: "read_file",
        arguments: JSON.stringify({
          path: "src/main.js",
          start_line: 3,
          end_line: 4,
        }),
      },
    }],
  }, {
    role: "tool",
    tool_call_id: "read-main-tail",
    content: sourceResult({
      path: "src/main.js",
      version: "main-v1",
      totalLines: 4,
      totalChars: mainSource.length,
      startLine: 3,
      endLine: 4,
      content: mainLines.slice(2).join("\n"),
      truncated: true,
    }),
  }, {
    role: "assistant",
    content: "",
    tool_calls: [{
      id: "read-toolbar",
      type: "function",
      function: {
        name: "read_file",
        arguments: JSON.stringify({
          path: "src/components/toolbar.js",
        }),
      },
    }],
  }, {
    role: "tool",
    tool_call_id: "read-toolbar",
    content: sourceResult({
      path: "src/components/toolbar.js",
      version: "toolbar-v1",
      totalLines: 1,
      totalChars: toolbarSource.length,
      startLine: 1,
      endLine: 1,
      content: toolbarSource,
      truncated: false,
    }),
  }];
  const effects = {
    committedMutationTargetsByToolCallId: new Map(),
    replayedToolCallIds: new Set(),
    sourceReadVersionsByToolCallId: new Map([
      ["read-main-prefix", {
        target: "src/main.js",
        version: "main-v1",
      }],
      ["read-main-tail", {
        target: "src/main.js",
        version: "main-v1",
      }],
      ["read-toolbar", {
        target: "src/components/toolbar.js",
        version: "toolbar-v1",
      }],
    ]),
  };

  const view = providerHistory.buildRuntimeV2DecisionView(
    messages,
    effects,
  );
  const materialized =
    providerHistory.materializedRuntimeV2SourceCoverage(
      view,
      "/tmp/runtime-v2-cross-file-complete-source",
      effects,
    );
  const mainCoverage = materialized.find((entry) =>
    entry.target === "src/main.js"
  );

  assert.equal(mainCoverage?.complete, true);
  assert.deepEqual(
    mainCoverage?.windows.map((window) => [
      window.startLine,
      window.endLine,
    ]),
    [[1, 2], [3, 4]],
  );
});

test("decision view keeps a minimum non-overlapping source cover for one version", () => {
  const sourceResult = (startLine, endLine, body) => [
    "READ_FILE_RESULT",
    "path: src/main.js",
    "contentVersion: main-v1",
    "truncated: true",
    "totalLines: 1111",
    "totalChars: 31756",
    `returnedLines: ${startLine}-${endLine}`,
    `returnedChars: ${body.length}`,
    "---CONTENT START---",
    body,
    "---CONTENT END---",
  ].join("\n");
  const readPair = (id, startLine, endLine, body) => [{
    role: "assistant",
    content: "",
    tool_calls: [{
      id,
      type: "function",
      function: {
        name: "read_file",
        arguments: JSON.stringify({
          path: "src/main.js",
          start_line: startLine,
          end_line: endLine,
        }),
      },
    }],
  }, {
    role: "tool",
    tool_call_id: id,
    content: sourceResult(startLine, endLine, body),
  }];
  const messages = [{
    role: "system",
    content: "[MAIN RUNTIME V2]",
  }, {
    role: "user",
    runtimeTurnId: "turn",
    content: "Repair the file after reading all required source.",
  },
  ...readPair("read-overlap", 151, 1111, "OVERLAPPING_SOURCE_COPY"),
  ...readPair("read-prefix", 1, 1000, "SOURCE_PREFIX"),
  ...readPair("read-tail", 1001, 1111, "SOURCE_TAIL")];

  const view = providerHistory.buildRuntimeV2DecisionView(messages);
  const visible = view
    .map((message) => String(message.content || ""))
    .join("\n");

  assert.match(visible, /SOURCE_PREFIX/);
  assert.match(visible, /SOURCE_TAIL/);
  assert.doesNotMatch(
    visible,
    /OVERLAPPING_SOURCE_COPY/,
    "a fully redundant overlapping window must not duplicate exact source",
  );
  assert.equal(
    providerHistory.materializedRuntimeV2SourceCoverage(
      view,
      "/workspace",
    )[0]?.complete,
    true,
    "the reduced workset must still preserve complete versioned coverage",
  );
});

test("a committed mutation may preserve non-overlapping context but never its write authority", () => {
  const sourceResult = (path, version, marker) => [
    "READ_FILE_RESULT",
    `path: ${path}`,
    `contentVersion: ${version}`,
    "truncated: false",
    "totalLines: 1",
    `totalChars: ${marker.length}`,
    "returnedLines: 1-1",
    `returnedChars: ${marker.length}`,
    "---CONTENT START---",
    marker,
    "---CONTENT END---",
  ].join("\n");
  const messages = [{
    role: "system",
    content: "[MAIN RUNTIME V2]",
  }, {
    role: "user",
    runtimeTurnId: "turn",
    content: "Repair both source targets.",
  }, {
    role: "assistant",
    content: "",
    tool_calls: [{
      id: "read-a",
      type: "function",
      function: {
        name: "read_file",
        arguments: JSON.stringify({ path: "src/a.js" }),
      },
    }, {
      id: "read-b",
      type: "function",
      function: {
        name: "read_file",
        arguments: JSON.stringify({ path: "src/b.js" }),
      },
    }],
  }, {
    role: "tool",
    tool_call_id: "read-a",
    content: sourceResult("src/a.js", "a-v1", "A_SOURCE"),
  }, {
    role: "tool",
    tool_call_id: "read-b",
    content: sourceResult("src/b.js", "b-v1", "B_SOURCE"),
  }, {
    role: "assistant",
    content: "",
    tool_calls: [{
      id: "mutate-a",
      type: "function",
      function: {
        name: "apply_patch",
        arguments: JSON.stringify({ path: "src/a.js" }),
      },
    }],
  }, {
    role: "tool",
    tool_call_id: "mutate-a",
    content: "MUTATION_COMMITTED src/a.js",
  }, {
    role: "assistant",
    content: "",
    tool_calls: [{
      id: "read-b-replay",
      type: "function",
      function: {
        name: "read_file",
        arguments: JSON.stringify({ path: "src/b.js" }),
      },
    }],
  }, {
    role: "tool",
    tool_call_id: "read-b-replay",
    content: sourceResult("src/b.js", "b-v1", "B_SOURCE"),
  }];
  const view = providerHistory.buildRuntimeV2DecisionView(messages, {
    committedMutationTargetsByToolCallId: new Map([
      ["mutate-a", ["src/a.js"]],
    ]),
    replayedToolCallIds: new Set(["read-b-replay"]),
    sourceReadVersionsByToolCallId: new Map([
      ["read-a", {
        target: "src/a.js",
        version: "a-v1",
      }],
      ["read-b", {
        target: "src/b.js",
        version: "b-v1",
      }],
    ]),
  });

  assert.equal(view.some((message) =>
    message.role === "tool" &&
    message.tool_call_id === "read-a"
  ), false);
  assert.equal(view.some((message) =>
    message.role === "tool" &&
    message.tool_call_id === "read-b"
  ), false);
  assert.equal(view.some((message) =>
    message.role === "tool" &&
    message.tool_call_id === "mutate-a"
  ), true);
  assert.equal(
    String(view.find((message) =>
      message.role === "tool" &&
      message.tool_call_id === "read-b-replay"
    )?.content || ""),
    sourceResult("src/b.js", "b-v1", "B_SOURCE"),
  );
  assert.deepEqual(
    providerHistory.materializedRuntimeV2SourceCoverage(
      view,
      "/tmp/runtime-v2-global-mutation-boundary",
      {
        committedMutationTargetsByToolCallId: new Map([
          ["mutate-a", ["src/a.js"]],
        ]),
        replayedToolCallIds: new Set(["read-b-replay"]),
        sourceReadVersionsByToolCallId: new Map([
          ["read-a", {
            target: "src/a.js",
            version: "a-v1",
          }],
          ["read-b", {
            target: "src/b.js",
            version: "b-v1",
          }],
        ]),
      },
    ),
    [],
    "source read before the latest global mutation and cache replay after it are context only",
  );
});

test("a replayed continuation cannot bridge across a mutation boundary", () => {
  const sourceResult = (startLine, endLine, marker) => [
    "READ_FILE_RESULT",
    "path: src/b.js",
    "contentVersion: b-v1",
    "truncated: true",
    "totalLines: 1000",
    "totalChars: 20000",
    `returnedLines: ${startLine}-${endLine}`,
    `returnedChars: ${marker.length}`,
    "---CONTENT START---",
    marker,
    "---CONTENT END---",
  ].join("\n");
  const messages = [{
    role: "system",
    content: "[MAIN RUNTIME V2]",
  }, {
    role: "user",
    runtimeTurnId: "turn",
    content: "Repair both source targets.",
  }, {
    role: "assistant",
    content: "",
    tool_calls: [{
      id: "read-b-prefix",
      type: "function",
      function: {
        name: "read_file",
        arguments: JSON.stringify({
          path: "src/b.js",
          start_line: 1,
          end_line: 500,
        }),
      },
    }],
  }, {
    role: "tool",
    tool_call_id: "read-b-prefix",
    content: sourceResult(1, 500, "B_PREFIX"),
  }, {
    role: "assistant",
    content: "",
    tool_calls: [{
      id: "mutate-a",
      type: "function",
      function: {
        name: "apply_patch",
        arguments: JSON.stringify({ path: "src/a.js" }),
      },
    }],
  }, {
    role: "tool",
    tool_call_id: "mutate-a",
    content: "MUTATION_COMMITTED src/a.js",
  }, {
    role: "assistant",
    content: "",
    tool_calls: [{
      id: "read-b-replayed-tail",
      type: "function",
      function: {
        name: "read_file",
        arguments: JSON.stringify({
          path: "src/b.js",
          start_line: 501,
          end_line: 1000,
        }),
      },
    }],
  }, {
    role: "tool",
    tool_call_id: "read-b-replayed-tail",
    content: sourceResult(501, 1000, "B_REPLAYED_TAIL"),
  }];
  const effects = {
    committedMutationTargetsByToolCallId: new Map([
      ["mutate-a", ["src/a.js"]],
    ]),
    replayedToolCallIds: new Set(["read-b-replayed-tail"]),
    sourceReadVersionsByToolCallId: new Map([
      ["read-b-prefix", {
        target: "src/b.js",
        version: "b-v1",
      }],
    ]),
  };

  const view = providerHistory.buildRuntimeV2DecisionView(
    messages,
    effects,
  );

  assert.equal(view.some((message) =>
    message.role === "tool" &&
    message.tool_call_id === "read-b-prefix"
  ), false);
  assert.deepEqual(
    providerHistory.materializedRuntimeV2SourceCoverage(
      view,
      "/tmp/runtime-v2-replayed-continuation-boundary",
      effects,
    ),
    [],
  );
});

test("decision view keeps only the current non-source frontier", () => {
  const messages = [{
    role: "system",
    content: "[MAIN RUNTIME V2]",
  }, {
    role: "user",
    runtimeTurnId: "turn",
    content: "Find and repair the save lifecycle.",
  }, {
    role: "assistant",
    content: "",
    tool_calls: [{
      id: "grep-old",
      type: "function",
      function: {
        name: "grep_search",
        arguments: JSON.stringify({
          path: "src",
          query: "setCurrentFile",
        }),
      },
    }],
  }, {
    role: "tool",
    tool_call_id: "grep-old",
    content: "OLD_SEARCH_FRONTIER",
  }, {
    role: "assistant",
    content: "",
    tool_calls: [{
      id: "skeleton",
      type: "function",
      function: {
        name: "get_project_skeleton",
        arguments: "{}",
      },
    }],
  }, {
    role: "tool",
    tool_call_id: "skeleton",
    content: "CURRENT_PROJECT_SHAPE",
  }, {
    role: "assistant",
    content: "",
    tool_calls: [{
      id: "grep-current",
      type: "function",
      function: {
        name: "grep_search",
        arguments: JSON.stringify({
          path: "src",
          query: "handleSaveFile",
        }),
      },
    }],
  }, {
    role: "tool",
    tool_call_id: "grep-current",
    content: "CURRENT_SEARCH_FRONTIER",
  }];

  const view = providerHistory.buildRuntimeV2DecisionView(messages);
  assert.equal(
    messages.some((message) =>
      message.role === "tool" &&
      message.tool_call_id === "grep-old"
    ),
    true,
    "canonical history retains every exact observation receipt",
  );
  assert.equal(
    view.some((message) =>
      message.role === "tool" &&
      message.tool_call_id === "grep-old"
    ),
    false,
    "old searches stay canonical but leave the active decision workset",
  );
  assert.equal(
    view.some((message) =>
      message.role === "tool" &&
      message.tool_call_id === "grep-current"
    ),
    true,
  );
  assert.equal(
    view.some((message) =>
      message.role === "tool" &&
      message.tool_call_id === "skeleton"
    ),
    false,
    "an older project observation must not grow every later request",
  );
});

test("distinct historical searches do not grow the decision workset", () => {
  const messages = [{
    role: "system",
    content: "[MAIN RUNTIME V2]",
  }, {
    role: "user",
    runtimeTurnId: "turn",
    content: "Find the current owner.",
  }];
  for (let index = 0; index < 100; index += 1) {
    messages.push({
      role: "assistant",
      content: "",
      tool_calls: [{
        id: `grep-${index}`,
        type: "function",
        function: {
          name: "grep_search",
          arguments: JSON.stringify({
            path: "src",
            query: `symbol-${index}`,
          }),
        },
      }],
    }, {
      role: "tool",
      tool_call_id: `grep-${index}`,
      content: `SEARCH_RESULT_${index}`,
    });
  }

  const view = providerHistory.buildRuntimeV2DecisionView(messages);
  const activeResults = view.filter((message) => message.role === "tool");
  assert.equal(activeResults.length, 1);
  assert.equal(activeResults[0]?.tool_call_id, "grep-99");
  assert.equal(
    messages.filter((message) => message.role === "tool").length,
    100,
    "canonical history remains lossless",
  );
});

test("a transitive cross-file source chain keeps only the current decision edge", () => {
  const messages = [{
    role: "system",
    content: "[MAIN RUNTIME V2]",
  }, {
    role: "user",
    runtimeTurnId: "turn",
    content: "Trace the lifecycle owner.",
  }];
  for (let index = 0; index < 100; index += 1) {
    const callId = `read-owner-${index}`;
    const source = `export const owner${index} = sharedLifecycleOwner;`;
    messages.push({
      role: "assistant",
      content: "",
      tool_calls: [{
        id: callId,
        type: "function",
        function: {
          name: "read_file",
          arguments: JSON.stringify({ path: `src/owner-${index}.ts` }),
        },
      }],
    }, {
      role: "tool",
      tool_call_id: callId,
      content: [
        "READ_FILE_RESULT",
        `path: src/owner-${index}.ts`,
        `contentVersion: owner-${index}-v1`,
        "truncated: false",
        "totalLines: 1",
        `totalChars: ${source.length}`,
        "returnedLines: 1-1",
        `returnedChars: ${source.length}`,
        "---CONTENT START---",
        source,
        "---CONTENT END---",
      ].join("\n"),
    });
  }

  const view = providerHistory.buildRuntimeV2DecisionView(messages);
  const activeReadIds = view
    .filter((message) => message.role === "tool")
    .map((message) => message.tool_call_id);
  assert.deepEqual(activeReadIds, [
    "read-owner-98",
    "read-owner-99",
  ]);
  assert.equal(
    messages.filter((message) => message.role === "tool").length,
    100,
    "the canonical transcript stays lossless while the decision edge is bounded",
  );
});

test("rejected actions retain one bounded causal anchor without executable templates", () => {
  const buildMessages = (repeatedNoProgressEvents) => {
    const messages = [{
      role: "system",
      content: [
        "[MAIN RUNTIME V2]",
        "[LIVE WORKSPACE INSTRUCTIONS]",
        "Keep the toolbar public API stable.",
      ].join("\n"),
    }, {
      role: "user",
      runtimeTurnId: "turn",
      content: "Repair save behavior and verify the visible result.",
    }, {
      role: "assistant",
      content: "",
      tool_calls: [{
        id: "source-superseded",
        type: "function",
        function: {
          name: "read_file",
          arguments: JSON.stringify({
            path: "src/main.js",
            start_line: 1,
            end_line: 80,
          }),
        },
      }],
    }, {
      role: "tool",
      tool_call_id: "source-superseded",
      content: [
        "READ_FILE_RESULT",
        "path: src/main.js",
        "contentVersion: main-v1",
        "truncated: false",
        "totalLines: 80",
        "totalChars: 32",
        "returnedLines: 1-80",
        "returnedChars: 32",
        "---CONTENT START---",
        "saveOld();",
        "SUPERSEDED_SOURCE_TAIL",
        "---CONTENT END---",
      ].join("\n"),
    }, {
      role: "assistant",
      content: "",
      tool_calls: [{
        id: "mutation-superseded",
        type: "function",
        function: {
          name: "replace_in_file",
          arguments: JSON.stringify({
            path: "src/main.js",
            old_text: "saveOriginal()",
            new_text: "saveOld()",
          }),
        },
      }],
    }, {
      role: "tool",
      tool_call_id: "mutation-superseded",
      content: "SUPERSEDED_MUTATION_COMMITTED src/main.js",
    }, {
      role: "assistant",
      content: "",
      tool_calls: [{
        id: "validation-superseded",
        type: "function",
        function: {
          name: "run_command",
          arguments: JSON.stringify({ command: "npm test" }),
        },
      }],
    }, {
      role: "tool",
      tool_call_id: "validation-superseded",
      content: "SUPERSEDED_VALIDATION_FAILED",
    }, {
      role: "assistant",
      content: "",
      tool_calls: [{
        id: "mutation-current",
        type: "function",
        function: {
          name: "replace_in_file",
          arguments: JSON.stringify({
            path: "src/main.js",
            old_text: "saveOld()",
            new_text: "saveCurrent()",
          }),
        },
      }],
    }, {
      role: "tool",
      tool_call_id: "mutation-current",
      content: "MUTATION_COMMITTED src/main.js",
    }, {
      role: "assistant",
      content: "",
      tool_calls: [{
        id: "source-current",
        type: "function",
        function: {
          name: "read_file",
          arguments: JSON.stringify({
            path: "src/main.js",
            start_line: 1,
            end_line: 80,
          }),
        },
      }],
    }, {
      role: "tool",
      tool_call_id: "source-current",
      content: [
        "READ_FILE_RESULT",
        "path: src/main.js",
        "contentVersion: main-v2",
        "truncated: false",
        "totalLines: 80",
        "totalChars: 31",
        "returnedLines: 1-80",
        "returnedChars: 31",
        "---CONTENT START---",
        "saveCurrent();",
        "CURRENT_SOURCE_TAIL",
        "---CONTENT END---",
      ].join("\n"),
    }, {
      role: "assistant",
      content: "",
      tool_calls: [{
        id: "validation-current",
        type: "function",
        function: {
          name: "run_command",
          arguments: JSON.stringify({ command: "npm test" }),
        },
      }],
    }, {
      role: "tool",
      tool_call_id: "validation-current",
      content: "VALIDATION_FAILED: save button assertion",
    }];
    const live = executionTypes.createRuntimeV2LiveExecutionState();
    live.messages.push(...messages);
    for (let index = 1; index <= repeatedNoProgressEvents; index += 1) {
      providerHistory.appendRuntimeV2ProviderFeedbackHistory(live, {
        code: "repeated_action_rejected",
        feedback: [
          "ACTION_NOT_EXECUTED: the latest read_file matched an action already rejected at this mutation boundary.",
          "Reuse committed source evidence or choose a materially different missing observation.",
        ].join("\n"),
      });
    }
    return live.messages;
  };
  const options = {
    contextLimit: 262_144,
    reservedOutputTokens: 4_096,
  };
  const effects = {
    committedMutationTargetsByToolCallId: new Map([
      ["mutation-superseded", ["src/main.js"]],
      ["mutation-current", ["src/main.js"]],
    ]),
    replayedToolCallIds: new Set(),
    sourceReadVersionsByToolCallId: new Map([
      ["source-superseded", {
        target: "src/main.js",
        version: "main-v1",
      }],
      ["source-current", {
        target: "src/main.js",
        version: "main-v2",
      }],
    ]),
    failedValidationToolCallIds: new Set(["validation-current"]),
  };
  const afterFifty =
    providerHistory.boundRuntimeV2ProviderConversation(
      buildMessages(50),
      options,
      effects,
    );
  const afterOneHundred =
    providerHistory.boundRuntimeV2ProviderConversation(
      buildMessages(100),
      options,
      effects,
    );
  const visibleText = (messages) =>
    messages.map((message) => String(message.content || "")).join("\n");

  assert.equal(
    afterOneHundred.length,
    afterFifty.length,
    "equivalent no-progress history must not enlarge the active decision view",
  );
  assert.match(
    visibleText(afterOneHundred),
    /Keep the toolbar public API stable/,
  );
  assert.match(
    visibleText(afterOneHundred),
    /Repair save behavior and verify the visible result/,
  );
  assert.match(visibleText(afterOneHundred), /MUTATION_COMMITTED/);
  assert.match(
    visibleText(afterOneHundred),
    /ACTION_NOT_EXECUTED/,
    "the next decision must receive the causal rejection fact",
  );
  assert.doesNotMatch(
    visibleText(afterOneHundred),
    /start_line|end_line|rejected-repeat/,
    "the rejection anchor must not reproduce executable arguments or request-local ids",
  );
  assert.match(
    visibleText(afterOneHundred),
    /CURRENT_SOURCE_TAIL/,
    "current exact source stays available across validation and recovery",
  );
  assert.match(
    visibleText(afterOneHundred),
    /VALIDATION_FAILED: save button assertion/,
  );
  assert.doesNotMatch(
    visibleText(afterOneHundred),
    /SUPERSEDED_SOURCE_TAIL/,
  );
  assert.doesNotMatch(
    visibleText(afterOneHundred),
    /SUPERSEDED_MUTATION_COMMITTED/,
  );
  assert.doesNotMatch(
    visibleText(afterOneHundred),
    /SUPERSEDED_VALIDATION_FAILED/,
  );
  for (const message of afterOneHundred) {
    if (message.role !== "tool") continue;
    assert.ok(afterOneHundred.some((candidate) =>
      candidate.role === "assistant" &&
      candidate.tool_calls?.some((call) =>
        call.id === message.tool_call_id
      )
    ));
  }
});

test("provider history uses canonical context anchors without a second digest", () => {
  const live = executionTypes.createRuntimeV2LiveExecutionState();
  const ports = {
    get: () => ({
      config: {},
      conversationTurns: [{
        id: "turn",
        userPrompt: "repair",
      }],
      agentMessages: [{
        role: "user",
        runtimeTurnId: "turn",
        content: "repair",
      }],
    }),
    context: {
      turnId: "turn",
      runWorkspace: "/tmp/runtime-v2-history",
      phaseLanguage: "en",
    },
    live,
  };
  providerHistory.providerHistory(live, ports);
  providerHistory.upsertRuntimeV2ContextAnchor(live, {
    key: "workspace-overview",
    content: "WORKSPACE_ANCHOR",
  });

  const request = providerHistory.providerHistory(live, ports);
  const rendered = request.messages
    .map((message) => String(message.content || ""))
    .join("\n");

  assert.match(rendered, /\[runtime-v2 context: workspace-overview\]/);
  assert.equal(
    request.messages.filter((message) =>
      String(message.content || "").includes("WORKSPACE_ANCHOR")
    ).length,
    1,
  );
  assert.doesNotMatch(rendered, /runtime-v2 structured evidence digest/);
});

test("provider history initializes the current user before a preloaded context anchor", () => {
  const live = executionTypes.createRuntimeV2LiveExecutionState();
  const ports = {
    get: () => ({
      config: {},
      conversationTurns: [{
        id: "turn",
        userPrompt: "repair the current workspace",
      }],
      agentMessages: [{
        role: "user",
        runtimeTurnId: "turn",
        content: "repair the current workspace",
      }],
    }),
    context: {
      turnId: "turn",
      runWorkspace: "/tmp/runtime-v2-preloaded-anchor",
      phaseLanguage: "en",
    },
    live,
  };
  providerHistory.upsertRuntimeV2ContextAnchor(live, {
    key: "workspace-overview",
    content: "PRELOADED_WORKSPACE_ANCHOR",
  });

  const request = providerHistory.providerHistory(live, ports);

  assert.deepEqual(
    request.messages.map((message) => message.role),
    ["system", "user", "system"],
  );
  assert.match(
    String(request.messages[0]?.content || ""),
    /\[MAIN RUNTIME V2\]/,
  );
  assert.equal(
    request.messages[1]?.content,
    "repair the current workspace",
  );
  assert.match(
    String(request.messages[2]?.content || ""),
    /PRELOADED_WORKSPACE_ANCHOR/,
  );
  const decisionView = providerHistory.buildRuntimeV2DecisionView(
    request.messages,
  );
  assert.equal(
    decisionView.find((message) => message.role === "user")?.content,
    "repair the current workspace",
    "the current user must survive the final provider decision projection",
  );
});

test("runtime state has one transcript and no parallel model-context recovery store", () => {
  const live = executionTypes.createRuntimeV2LiveExecutionState();
  assert.equal("modelContext" in live, false);
  assert.equal(providerContext.recordModelContext, undefined);
  assert.equal(
    providerContext.latestCorrectiveSourceRefreshWindow,
    undefined,
  );
});

test("a no-tool protocol response advances the next provider context", () => {
  const live = executionTypes.createRuntimeV2LiveExecutionState();
  const response = [
    "I inspected the available evidence but returned narration.",
    "The next request must not look identical to this one.",
  ].join("\n");
  providerHistory.appendRuntimeV2ProviderFeedbackHistory(live, {
    visibleText: response,
    code: "required_tool_missing",
    feedback:
      "The response did not advance the task. Submit one different allowed structured action.",
  });

  assert.equal(live.messages.at(-2)?.role, "assistant");
  assert.equal(live.messages.at(-2)?.content, response);
  assert.equal(live.messages.at(-1)?.role, "system");
  assert.match(
    String(live.messages.at(-1)?.content || ""),
    /required_tool_missing/,
  );
  assert.match(
    String(live.messages.at(-1)?.content || ""),
    /different allowed structured action/,
  );

  providerHistory.appendRuntimeV2ProviderFeedbackHistory(live, {
    visibleText: response,
    code: "required_tool_missing",
    feedback:
      "The response did not advance the task. Submit one different allowed structured action.",
  });
  assert.equal(live.messages.length, 2);
});

test("Execute does not promote an ordinary no-tool response into a required-tool protocol failure", () => {
  const source = fs.readFileSync(path.join(
    workspaceRoot,
    "src/store/runtimeV2/executionProviderPort.ts",
  ), "utf8");
  assert.doesNotMatch(source, /RUNTIME_V2_REQUIRED_TOOL_SURFACE_EMPTY/);
  assert.doesNotMatch(source, /code:\s*"required_tool_missing"/);
});

test("covered replay restores original source without remaining an executable frontier", () => {
  const completeSource = [
    "READ_FILE_RESULT",
    "path: src/main.js",
    "contentVersion: main-v1",
    "truncated: false",
    "totalLines: 1",
    "totalChars: 12027",
    "returnedLines: 1-1",
    "returnedChars: 12027",
    "---CONTENT START---",
    "A".repeat(12_000),
    "COMPLETE_SOURCE_WINDOW_TAIL",
    "---CONTENT END---",
  ].join("\n");
  const messages = [{
    role: "system",
    content: "runtime system",
  }, {
    role: "user",
    content: "repair the complete objective",
  }, {
    role: "assistant",
    content: "",
    tool_calls: [{
      id: "read-original",
      type: "function",
      function: {
        name: "read_file",
        arguments: JSON.stringify({ path: "src/main.js" }),
      },
    }],
  }, {
    role: "tool",
    tool_call_id: "read-original",
    content: completeSource,
  }, {
    role: "assistant",
    content: "",
    tool_calls: [{
      id: "read-replay",
      type: "function",
      function: {
        name: "read_file",
        arguments: JSON.stringify({ path: "src/main.js" }),
      },
    }],
  }, {
    role: "tool",
    tool_call_id: "read-replay",
    content: completeSource,
  }, {
    role: "assistant",
    content: "I will describe the same action instead of calling a tool.",
  }, {
    role: "system",
    content: "[runtime-v2 provider feedback: required_tool_missing]\nUse a tool.",
  }, {
    role: "system",
    content: "[runtime-v2 context: child:review]\nCHILD_HANDOFF_EVIDENCE",
  }];

  const canonicalLength = messages.length;
  const effects = {
    committedMutationTargetsByToolCallId: new Map(),
    replayedToolCallIds: new Set(["read-replay"]),
    sourceReadVersionsByToolCallId: new Map([
      ["read-original", {
        target: "src/main.js",
        version: "main-v1",
      }],
    ]),
  };
  const replayDecisionView =
    providerHistory.buildRuntimeV2DecisionView(
      messages.slice(0, 6),
      effects,
    );
  const decisionView =
    providerHistory.buildRuntimeV2DecisionView(messages, effects);

  assert.equal(messages.length, canonicalLength);
  assert.ok(messages.some((message) =>
    message.role === "tool" &&
    message.tool_call_id === "read-replay"
  ));
  assert.equal(replayDecisionView.some((message) =>
    message.role === "tool" &&
    message.tool_call_id === "read-replay"
  ), false,
    "a cache replay stays durable but must not remain as the next executable template once its real source is visible",
  );
  assert.ok(decisionView.some((message) =>
    message.role === "system" &&
    String(message.content).includes("CHILD_HANDOFF_EVIDENCE")
  ));
  assert.equal(
    replayDecisionView.some((message) =>
      message.role === "tool" &&
      message.tool_call_id === "read-original"
    ),
    true,
  );
  assert.equal(
    replayDecisionView
      .map((message) => String(message.content || ""))
      .join("\n")
      .split("COMPLETE_SOURCE_WINDOW_TAIL").length - 1,
    1,
  );
  const materialized =
    providerHistory.materializedRuntimeV2SourceCoverage(
      replayDecisionView,
      "/workspace",
      effects,
    );
  assert.equal(materialized.length, 1);
  assert.equal(materialized[0]?.target, "src/main.js");
  assert.equal(materialized[0]?.version, "main-v1");
  assert.equal(materialized[0]?.complete, true);
  assert.match(
    materialized[0]?.windows[0]?.content || "",
    /COMPLETE_SOURCE_WINDOW_TAIL/,
    "a cached replay must not replace the real read that grants mutation authority",
  );
  assert.match(
    decisionView.map((message) => String(message.content || "")).join("\n"),
    /runtime-v2 provider feedback/,
  );
});

test("a focused replay cannot evict the broader real source receipt it came from", () => {
  const canonicalSourceLines = Array.from(
    { length: 1000 },
    (_, index) => `source line ${index + 1}`,
  );
  canonicalSourceLines[0] = "ORIGINAL_COMPLETE_SOURCE";
  canonicalSourceLines[199] = "FOCUSED_REPLAY";
  const canonicalSource = canonicalSourceLines.join("\n");
  const sourceResult = (startLine, endLine, truncated) => {
    const body = canonicalSourceLines
      .slice(startLine - 1, endLine)
      .join("\n");
    return [
    "READ_FILE_RESULT",
    "path: src/main.js",
    "contentVersion: main-v1",
    `truncated: ${truncated}`,
    "totalLines: 1000",
    `totalChars: ${canonicalSource.length}`,
    `returnedLines: ${startLine}-${endLine}`,
    `returnedChars: ${body.length}`,
    "---CONTENT START---",
    body,
    "---CONTENT END---",
    ].join("\n");
  };
  const messages = [{
    role: "system",
    content: "[MAIN RUNTIME V2]",
  }, {
    role: "user",
    runtimeTurnId: "turn",
    content: "Repair the visible source.",
  }, {
    role: "assistant",
    content: "",
    tool_calls: [{
      id: "read-original",
      type: "function",
      function: {
        name: "read_file",
        arguments: JSON.stringify({ path: "src/main.js" }),
      },
    }],
  }, {
    role: "tool",
    tool_call_id: "read-original",
    content: sourceResult(1, 1000, false),
  }, {
    role: "assistant",
    content: "",
    tool_calls: [{
      id: "read-focused-replay",
      type: "function",
      function: {
        name: "read_file",
        arguments: JSON.stringify({
          path: "src/main.js",
          start_line: 200,
          end_line: 300,
        }),
      },
    }],
  }, {
    role: "tool",
    tool_call_id: "read-focused-replay",
    content: sourceResult(200, 300, true),
  }];
  const effects = {
    committedMutationTargetsByToolCallId: new Map(),
    replayedToolCallIds: new Set(["read-focused-replay"]),
    sourceReadVersionsByToolCallId: new Map([[
      "read-original",
      { target: "src/main.js", version: "main-v1" },
    ]]),
  };

  const view = providerHistory.buildRuntimeV2DecisionView(
    messages,
    effects,
  );
  const original = String(view.find((message) =>
    message.role === "tool" &&
    message.tool_call_id === "read-original"
  )?.content || "");
  const replay = String(view.find((message) =>
    message.role === "tool" &&
    message.tool_call_id === "read-focused-replay"
  )?.content || "");
  assert.match(original, /ORIGINAL_COMPLETE_SOURCE/);
  assert.equal(
    replay,
    "",
    "a focused replay must not remain as an executable frontier after restoring its underpinning real source",
  );
  assert.equal(
    providerHistory.materializedRuntimeV2SourceCoverage(
      view,
      "/workspace",
      effects,
    )[0]?.complete,
    true,
  );
});

test("a replay restores its same-boundary real source after workset eviction", () => {
  const sourceResult = (path, version, source) => [
    "READ_FILE_RESULT",
    `path: ${path}`,
    `contentVersion: ${version}`,
    "truncated: false",
    "totalLines: 1",
    `totalChars: ${source.length}`,
    "returnedLines: 1-1",
    `returnedChars: ${source.length}`,
    "---CONTENT START---",
    source,
    "---CONTENT END---",
  ].join("\n");
  const messages = [{
    role: "system",
    content: "[MAIN RUNTIME V2]",
  }, {
    role: "user",
    runtimeTurnId: "turn",
    content: "Repair the current source.",
  }, {
    role: "assistant",
    content: "",
    tool_calls: [{
      id: "read-main-original",
      type: "function",
      function: {
        name: "read_file",
        arguments: JSON.stringify({ path: "src/main.js" }),
      },
    }],
  }, {
    role: "tool",
    tool_call_id: "read-main-original",
    content: sourceResult(
      "src/main.js",
      "main-v1",
      "MAIN_UNIQUE_SOURCE",
    ),
  }, {
    role: "assistant",
    content: "",
    tool_calls: [{
      id: "read-unrelated",
      type: "function",
      function: {
        name: "read_file",
        arguments: JSON.stringify({ path: "src/unrelated.js" }),
      },
    }],
  }, {
    role: "tool",
    tool_call_id: "read-unrelated",
    content: sourceResult(
      "src/unrelated.js",
      "unrelated-v1",
      "UNRELATED_DISTINCT_SOURCE",
    ),
  }, {
    role: "assistant",
    content: "",
    tool_calls: [{
      id: "read-main-replay",
      type: "function",
      function: {
        name: "read_file",
        arguments: JSON.stringify({ path: "src/main.js" }),
      },
    }],
  }, {
    role: "tool",
    tool_call_id: "read-main-replay",
    content: sourceResult(
      "src/main.js",
      "main-v1",
      "MAIN_UNIQUE_SOURCE",
    ),
  }];
  const effects = {
    committedMutationTargetsByToolCallId: new Map(),
    replayedToolCallIds: new Set(["read-main-replay"]),
    sourceReadVersionsByToolCallId: new Map([
      ["read-main-original", {
        target: "src/main.js",
        version: "main-v1",
      }],
      ["read-unrelated", {
        target: "src/unrelated.js",
        version: "unrelated-v1",
      }],
    ]),
  };

  const view = providerHistory.buildRuntimeV2DecisionView(
    messages,
    effects,
  );

  assert.equal(view.some((message) =>
    message.role === "tool" &&
    message.tool_call_id === "read-main-original"
  ), true);
  assert.equal(
    view.some((message) =>
      message.role === "tool" &&
      message.tool_call_id === "read-main-replay"
    ),
    false,
    "the replay restores the real source but does not survive as an executable frontier",
  );
  assert.deepEqual(
    providerHistory.materializedRuntimeV2SourceCoverage(
      view,
      "/tmp/runtime-v2-replay-restores-real-source",
      effects,
    ).map((entry) => ({
      target: entry.target,
      version: entry.version,
      complete: entry.complete,
    })),
    [{
      target: "src/main.js",
      version: "main-v1",
      complete: true,
    }],
  );
});

test("alternating cached source recovery converges to one bounded multi-file workset", () => {
  const sourceResult = (path, version, source) => [
    "READ_FILE_RESULT",
    `path: ${path}`,
    `contentVersion: ${version}`,
    "truncated: false",
    "totalLines: 1",
    `totalChars: ${source.length}`,
    "returnedLines: 1-1",
    `returnedChars: ${source.length}`,
    "---CONTENT START---",
    source,
    "---CONTENT END---",
  ].join("\n");
  const readPair = (id, path, version, source) => [{
    role: "assistant",
    content: "",
    tool_calls: [{
      id,
      type: "function",
      function: {
        name: "read_file",
        arguments: JSON.stringify({ path }),
      },
    }],
  }, {
    role: "tool",
    tool_call_id: id,
    content: sourceResult(path, version, source),
  }];
  const messages = [{
    role: "system",
    content: "[MAIN RUNTIME V2]",
  }, {
    role: "user",
    runtimeTurnId: "turn",
    content: "Repair the editor and backend file lifecycle together.",
  },
  ...readPair(
    "read-editor-original",
    "src/components/editor.js",
    "editor-v1",
    "EDITOR_DISTINCT_SOURCE",
  ),
  ...readPair(
    "read-backend-original",
    "src-tauri/src/main.rs",
    "backend-v1",
    "BACKEND_DISTINCT_SOURCE",
  ),
  ...readPair(
    "read-editor-replay",
    "src/components/editor.js",
    "editor-v1",
    "EDITOR_DISTINCT_SOURCE",
  ),
  ...readPair(
    "read-backend-replay",
    "src-tauri/src/main.rs",
    "backend-v1",
    "BACKEND_DISTINCT_SOURCE",
  )];
  const effects = {
    committedMutationTargetsByToolCallId: new Map(),
    replayedToolCallIds: new Set([
      "read-editor-replay",
      "read-backend-replay",
    ]),
    sourceReadVersionsByToolCallId: new Map([
      ["read-editor-original", {
        target: "src/components/editor.js",
        version: "editor-v1",
      }],
      ["read-backend-original", {
        target: "src-tauri/src/main.rs",
        version: "backend-v1",
      }],
    ]),
  };

  const view = providerHistory.buildRuntimeV2DecisionView(
    messages,
    effects,
  );
  assert.deepEqual(
    providerHistory.materializedRuntimeV2SourceCoverage(
      view,
      "/tmp/runtime-v2-alternating-source-recovery",
      effects,
    ).map((entry) => entry.target).sort(),
    ["src-tauri/src/main.rs", "src/components/editor.js"].sort(),
    "replaying two evicted sources must converge instead of alternating which source is visible",
  );
  assert.equal(view.some((message) =>
    message.role === "tool" &&
    message.tool_call_id === "read-editor-replay"
  ), false);
  assert.equal(view.some((message) =>
    message.role === "tool" &&
    message.tool_call_id === "read-backend-replay"
  ), false);
});

test("a text-envelope fallback does not become sticky Turn capability state", () => {
  const live = executionTypes.createRuntimeV2LiveExecutionState();

  assert.equal("lastProviderTransport" in live, false);
  assert.equal(
    typeof providerContext.providerProfileForProvenToolTransport,
    "undefined",
  );
});

test("Gemini stays on the truthful envelope lane until native tools round-trip", () => {
  const cloudState = (protocol, toolProtocol = "auto") => ({
    config: {
      activeProfile: "cloud",
      cloudExperimentalLoginEnabled: false,
      cloud: {
        endpoint: "https://example.invalid",
        apiKey: "test",
        model: "test-model",
        provider: protocol,
        protocol,
        apiFormat: "chat_completions",
        toolProtocol,
      },
    },
  });
  const geminiAuto = providerContext.baseProviderProfile(
    cloudState("gemini"),
  );
  const geminiExplicitNative = providerContext.baseProviderProfile(
    cloudState("gemini", "native"),
  );
  const openAiAuto = providerContext.baseProviderProfile(
    cloudState("openai"),
  );
  const explicitXml = providerContext.baseProviderProfile(
    cloudState("openai", "xml"),
  );

  assert.equal(geminiAuto.nativeTools, false);
  assert.equal(geminiExplicitNative.nativeTools, false);
  assert.equal(openAiAuto.nativeTools, true);
  assert.equal(explicitXml.nativeTools, false);
  assert.equal(
    runtime.selectNextProviderTransportAttempt(geminiAuto, {
      actionKey: "gemini-required-action",
      attempted: [],
    })?.variant,
    "text_envelope",
  );
});

test("finite validation rejects observers and services but accepts a real test", () => {
  assert.equal(
    authorization.finiteValidationCommandRejection("npm test"),
    null,
  );
  assert.equal(
    authorization.finiteValidationCommandRejection("cat src/main.js")
      .reasonCode,
    "finite_validation_contract_required",
  );
  assert.equal(
    authorization.finiteValidationCommandRejection("npm run dev")
      .reasonCode,
    "finite_validation_contract_required",
  );
  assert.equal(
    authorization.correctiveFiniteValidationCommand(
      "cd /workspace && npx vite build 2>&1 | tail -20",
    ),
    "npx vite build",
  );
  assert.equal(
    authorization.correctiveFiniteValidationCommand(
      "cd /workspace && npm run build 2>&1; echo EXIT_CODE=$?",
    ),
    "npm run build",
  );
  assert.equal(
    authorization.correctiveFiniteValidationCommand(
      "grep -n handler src/main.js",
    ),
    null,
  );
});

test("child scope remains read-only and relative to its declared paths", () => {
  const job = { allowedPaths: ["src/components"] };
  assert.equal(
    subagentScopes.childScopeAllows(
      job,
      { path: "src/components/editor.js" },
    ),
    true,
  );
  assert.equal(
    subagentScopes.childScopeAllows(job, { path: "src/main.js" }),
    false,
  );
  assert.equal(
    subagentScopes.childScopeAllows(job, { path: "../secret" }),
    false,
  );
});

test("implementation children receive scoped readers and mutation tools but not final validators", () => {
  const tools = subagentPolicy.runtimeV2ChildTools({
    taskKind: "implement",
    accessMode: "write",
  }).map((definition) => definition.function.name);
  assert.ok(tools.includes("read_file"));
  assert.ok(tools.includes("replace_in_file"));
  assert.ok(tools.includes("write_file"));
  assert.ok(tools.includes("apply_patch"));
  assert.ok(tools.includes("delete_workspace_path"));
  assert.equal(tools.includes("run_command"), false);
  assert.equal(tools.includes("browser_evaluate"), false);
});

test("late child handoff includes current parent context without unrelated paths", () => {
  const messages = [{
    role: "assistant",
    content: "",
    tool_calls: [{
      id: "parent-main",
      type: "function",
      function: {
        name: "read_file",
        arguments: JSON.stringify({ path: "src/main.js" }),
      },
    }, {
      id: "unrelated",
      type: "function",
      function: {
        name: "read_file",
        arguments: JSON.stringify({ path: "docs/private.md" }),
      },
    }],
  }, {
    role: "tool",
    tool_call_id: "parent-main",
    content: "saveActiveFile(currentFile)",
  }, {
    role: "tool",
    tool_call_id: "unrelated",
    content: "unrelated content",
  }];
  const capsule = subagentContext.buildRuntimeV2SubagentContextCapsule({
    aggregate: {
      phase: "validating",
      objective: {
        text: "Repair save behavior",
        acceptanceCriteria: ["Opening stays clean"],
        acceptanceCriterionIds: ["criterion-save"],
      },
      workPlan: null,
      sealedWorkPlan: null,
      evidence: [{
        id: "E-source",
        kind: "source",
        target: "src/main.js",
        version: "main-v1",
      }, {
        id: "E-mutation",
        kind: "mutation",
        target: "src/main.js",
        version: "main-v2",
      }],
    },
    job: {
      taskKind: "review",
      allowedPaths: ["src"],
    },
    messages,
    effectFacts: {
      committedMutationTargetsByToolCallId: new Map(),
      replayedToolCallIds: new Set(),
      sourceReadVersionsByToolCallId: new Map([
        ["parent-main", {
          target: "src/main.js",
          version: "main-v1",
        }],
        ["unrelated", {
          target: "docs/private.md",
          version: "docs-v1",
        }],
      ]),
      failedValidationToolCallIds: new Set(),
      rejectedActionIdentities: new Set(),
    },
  });
  assert.match(capsule, /Repair save behavior/);
  assert.match(capsule, /saveActiveFile/);
  assert.match(capsule, /E-mutation/);
  assert.doesNotMatch(capsule, /unrelated content/);
});

test("child handoff keeps complete canonical source windows when the run budget allows", () => {
  const completeContent = `${"A".repeat(9_000)}COMPLETE_PARENT_WINDOW_TAIL`;
  const completeWindow = [
    "READ_FILE_RESULT",
    "path: src/main.js",
    "contentVersion: main-v1",
    "truncated: false",
    "totalLines: 1",
    `totalChars: ${completeContent.length}`,
    "returnedLines: 1-1",
    `returnedChars: ${completeContent.length}`,
    "---CONTENT START---",
    completeContent,
    "---CONTENT END---",
  ].join("\n");
  const messages = [{
    role: "assistant",
    content: "",
    tool_calls: [{
      id: "parent-complete-main",
      type: "function",
      function: {
        name: "read_file",
        arguments: JSON.stringify({ path: "src/main.js" }),
      },
    }],
  }, {
    role: "tool",
    tool_call_id: "parent-complete-main",
    content: completeWindow,
  }];
  const capsule = subagentContext.buildRuntimeV2SubagentContextCapsule({
    aggregate: {
      phase: "acting",
      objective: {
        text: "Repair save behavior",
        acceptanceCriteria: ["Opening stays clean"],
        acceptanceCriterionIds: ["criterion-save"],
      },
      workPlan: null,
      sealedWorkPlan: null,
      evidence: [],
    },
    job: {
      taskKind: "review",
      allowedPaths: ["src"],
    },
    messages,
    effectFacts: {
      committedMutationTargetsByToolCallId: new Map(),
      replayedToolCallIds: new Set(),
      sourceReadVersionsByToolCallId: new Map([[
        "parent-complete-main",
        { target: "src/main.js", version: "main-v1" },
      ]]),
      failedValidationToolCallIds: new Set(),
      rejectedActionIdentities: new Set(),
    },
    contextBudget: {
      inputBudget: 100_000,
    },
  });

  assert.match(capsule, /source:src\/main\.js:main-v1/);
  assert.match(capsule, /COMPLETE_PARENT_WINDOW_TAIL/);
  assert.doesNotMatch(capsule, /parent-context-truncated/);
});

test("browser validation requires passed assertions and no page errors", () => {
  const passed = {
    success: true,
    actions: [{
      id: "open",
      kind: "click",
      target: "#open",
      ok: true,
    }],
    assertions: [{
      kind: "visible",
      target: "#editor",
      passed: true,
      afterActionId: "open",
      causallyLinked: true,
    }],
    pageErrors: [],
    consoleErrors: [],
  };
  assert.equal(
    evidence.isRuntimeV2ValidationPassed(
      "browser_evaluate",
      JSON.stringify(passed),
    ),
    true,
  );
  assert.equal(
    evidence.isRuntimeV2ValidationPassed(
      "browser_evaluate",
      JSON.stringify({
        ...passed,
        pageErrors: ["ReferenceError"],
      }),
    ),
    false,
  );
});

test("one-Turn consent reaches browser execution without advertising unavailable desktop control", async () => {
  assert.equal(
    executionToolDefinitions.runtimeV2ToolDefinitions()
      .some((definition) => definition.function.name === "computer_use"),
    false,
    "a tool that cannot pass the current Runtime approval path must not be advertised",
  );
  const state = {
    config: {},
    currentTurnExecutionConsent: {
      turnId: "turn",
      granted: true,
    },
    approvedLocalFileReadPaths: [],
    webSearchEnabled: false,
  };
  const ports = {
    get: () => state,
    context: {
      turnId: "turn",
      runWorkspace: "/tmp/runtime-v2-browser-authorization",
    },
    live: {
      authorization: authorization.createRuntimeV2ExecutionAuthorization(
        state,
      ),
    },
  };

  const browser = await authorization.authorizeToolForCurrentTurn(
    ports,
    "browser_evaluate",
    { url: "http://127.0.0.1:5173" },
  );
  assert.equal(browser.allowed, true);

  const desktop = await authorization.authorizeToolForCurrentTurn(
    ports,
    "computer_use",
    { app_name: "MAIN" },
  );
  assert.equal(desktop.allowed, false);
  assert.match(desktop.reason || "", /未暴露|not exposed/i);
});

test("external local read approval preserves the execution boundary flag", async () => {
  const externalPath = "/tmp/runtime-v2-outside/main-debug.log";
  const workspace = "/tmp/runtime-v2-workspace";
  const state = {
    config: {},
    currentTurnExecutionConsent: null,
    approvedLocalFileReadPaths: [],
    webSearchEnabled: false,
  };
  const ports = {
    get: () => state,
    context: {
      turnId: "turn",
      runWorkspace: workspace,
    },
    live: {
      authorization: authorization.createRuntimeV2ExecutionAuthorization(
        state,
      ),
    },
  };

  const pending = await authorization.authorizeToolForCurrentTurn(
    ports,
    "read_file",
    { path: externalPath },
  );
  assert.equal(pending.allowed, false);
  assert.equal(pending.approvalRequired, true);
  assert.equal(pending.risk, "local_file_read");
  assert.equal(pending.localFileReadPath, externalPath);
  assert.equal(pending.allowExternalLocalRead, false);

  state.approvedLocalFileReadPaths = [externalPath];
  const approved = await authorization.authorizeToolForCurrentTurn(
    ports,
    "read_file",
    { path: externalPath },
  );
  assert.equal(approved.allowed, true);
  assert.equal(approved.allowExternalLocalRead, true);
});

test("a structured child report can cite inherited or new real evidence only", () => {
  const inheritedEvidence = [{
    id: "E-parent",
    kind: "source",
    target: "src/main.js",
    version: "v1",
  }];
  const report = runtime.compileRuntimeV2SubagentReport({
    evidence: [],
    inheritedEvidence,
    draft: {
      summary: "The save path is preserved.",
      findings: [{
        statement: "The save path is preserved.",
        evidence_ids: ["E-parent"],
      }],
      unresolved: [],
    },
  });
  assert.equal(
    runtime.validateRuntimeV2SubagentReport({
      report,
      evidence: [],
      inheritedEvidence,
    }),
    true,
  );
  assert.throws(() => runtime.compileRuntimeV2SubagentReport({
    evidence: [],
    inheritedEvidence,
    draft: {
      summary: "Invented finding.",
      findings: [{
        statement: "Invented finding.",
        evidence_ids: ["E-invented"],
      }],
      unresolved: [],
    },
  }), /evidence_unknown/);
});

test("ordinary child text must explicitly cite evidence before Runtime compiles a completed report", () => {
  const evidence = [{
    id: "child:review-1:E1",
    kind: "subagent",
    target: "src/main.js",
    version: "v2",
  }];
  assert.throws(() => runtime.compileRuntimeV2SubagentTextReport({
    summary: "The save path looks correct.",
    evidence,
  }), /finding_incomplete/);

  const report = runtime.compileRuntimeV2SubagentTextReport({
    summary:
      "The save path is correct according to child:review-1:E1.",
    evidence,
  });
  assert.deepEqual(
    report.findings[0].evidenceIds,
    ["child:review-1:E1"],
  );
});
