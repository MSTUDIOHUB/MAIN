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
const executionTypes = loadTs(path.join(
  workspaceRoot,
  "src/store/runtimeV2/executionTypes.ts",
));
const providerEffectFacts = loadTs(path.join(
  workspaceRoot,
  "src/store/runtimeV2/executionProviderEffectFacts.ts",
));
const executionToolPort = loadTs(path.join(
  workspaceRoot,
  "src/store/runtimeV2/executionToolPort.ts",
));
const executionText = loadTs(path.join(
  workspaceRoot,
  "src/store/runtimeV2/executionText.ts",
));
const executionToolDefinitions = loadTs(path.join(
  workspaceRoot,
  "src/store/runtimeV2/executionToolDefinitions.ts",
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
const schedulerPort = loadTs(path.join(
  workspaceRoot,
  "src/store/runtimeV2/executionSchedulerPort.ts",
));
const subagentCandidate = loadTs(path.join(
  workspaceRoot,
  "src/store/runtimeV2/executionSubagentCandidate.ts",
));
const runtime = loadTs(path.join(
  workspaceRoot,
  "src/lib/runtime-v2/index.ts",
));

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
    facts.failedValidationToolCallIds.has("validate-current"),
    true,
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

test("Runtime v2 collaboration schema matches its read-only execution contract", () => {
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
    ["explore", "review", "validate"],
  );
  assert.deepEqual(
    selected.function.parameters.properties.access_mode.enum,
    ["read"],
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

test("every task kind advertised by the Runtime v2 child schema is executable", () => {
  const spawn = executionToolDefinitions.runtimeV2ToolDefinitions()
    .find((definition) =>
      definition.function.name === "spawn_subagent"
    );
  assert.ok(spawn);
  const taskKinds =
    spawn.function.parameters.properties.task_kind.enum;
  assert.deepEqual(taskKinds, ["explore", "review", "validate"]);
  assert.deepEqual(
    spawn.function.parameters.properties.access_mode.enum,
    ["read"],
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
            access_mode: "read",
          },
        },
      });
    assert.equal(candidate.taskKind, taskKind);
  }
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

test("provider mutation aliases are canonical before action identity", () => {
  const replace = definition("replace_in_file");
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

test("only a reasoning-only length truncation negotiates adapter action mode", () => {
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
});

test("child lifecycle uses only the parent lifecycle deadline", () => {
  assert.equal(
    subagentRunner.runtimeV2ChildDeadlineAt(600_000),
    600_000,
    "a slow local child must not receive an independent 90 second cutoff",
  );
  const source = fs.readFileSync(path.join(
    workspaceRoot,
    "src/store/runtimeV2/executionSubagentRunner.ts",
  ), "utf8");
  assert.doesNotMatch(
    source,
    /requiresTool|child_required_tool_missing|investigation window is closed/i,
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
  const port = schedulerPort.createRuntimeV2SchedulerPort({
    get: () => ({ runtimeV2Checkpoints: {} }),
    context: { turnId: run.turnId },
    live,
    nextId: (scope) => `${scope}-1`,
    now: () => 40,
    lifecycleDeadlineAt: 10_000,
    logStoreEvent: () => undefined,
  });
  const command = {
    idempotencyKey: "join-review",
    kind: "join_subagents",
    phase: "observing",
    run,
    payload: {
      toolCallId: "wait-review",
      jobIds: [job.id],
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
