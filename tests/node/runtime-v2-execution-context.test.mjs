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
const executionTypes = loadTs(path.join(
  workspaceRoot,
  "src/store/runtimeV2/executionTypes.ts",
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
const runtime = loadTs(path.join(
  workspaceRoot,
  "src/lib/runtime-v2/index.ts",
));

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

test("direct Execute mutation authority includes every freshly parent-read target", () => {
  const live = executionTypes.createRuntimeV2LiveExecutionState();
  live.modelContext.push({
    id: "toolbar-read",
    source: "tool",
    label: "read_file",
    target: "src/components/toolbar.js",
    status: "succeeded",
    content: [
      "READ_FILE_RESULT",
      "path: src/components/toolbar.js",
      "contentVersion: sha-toolbar-v1",
      "truncated: false",
      "totalLines: 10",
      "totalChars: 100",
      "returnedLines: 1-10",
      "returnedChars: 100",
      "---CONTENT START---",
      "source",
      "---CONTENT END---",
    ].join("\n"),
  }, {
    id: "statusbar-read",
    source: "tool",
    label: "read_file",
    target: "src/components/statusbar.js",
    status: "succeeded",
    content: [
      "READ_FILE_RESULT",
      "path: src/components/statusbar.js",
      "contentVersion: sha-statusbar-v1",
      "truncated: false",
      "totalLines: 10",
      "totalChars: 100",
      "returnedLines: 1-10",
      "returnedChars: 100",
      "---CONTENT START---",
      "source",
      "---CONTENT END---",
    ].join("\n"),
  });
  const ports = {
    get: () => ({ runtimeV2Checkpoints: {} }),
    context: {
      runWorkspace: "/tmp/runtime-v2-multi-target",
    },
    live,
  };

  const toolbar = correctiveMutationPolicy.validateRuntimeV2MutationLease({
    ports,
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
    toolName: "replace_in_file",
    args: {
      path: "src/components/statusbar.js",
      search_text: "before",
      replace_text: "after",
    },
    target: "src/components/statusbar.js",
  });

  assert.equal(toolbar?.allowed, true);
  assert.equal(statusbar?.allowed, true);

  live.modelContext.push({
    id: "toolbar-mutation",
    source: "tool",
    label: "replace_in_file",
    target: "src/components/toolbar.js",
    status: "succeeded",
    content: "File updated.",
  });
  assert.deepEqual(
    correctiveMutationPolicy.runtimeV2MutationLeases(ports),
    [],
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
  }, "", surface);

  assert.match(missing, /Read the exact existing file before changing it/);
  assert.match(present, /Versioned source evidence is already committed/);
  assert.doesNotMatch(
    present,
    /Read the exact existing file before changing it/,
  );
});

test("execution prompt exposes exact runtime-rejected actions as current constraints", () => {
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
    rejectedActions: [
      "read_file({\"path\":\"src/main.js\",\"start_line\":1001})",
    ],
  });

  assert.match(prompt, /currently ineligible/i);
  assert.match(prompt, /read_file/);
  assert.match(prompt, /start_line/);
  assert.match(prompt, /different allowed action/i);
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

test("child lifecycle reserves time for synthesis without a read-round limit", () => {
  assert.equal(subagentRunner.runtimeV2ChildStepPhase({
    now: 1_000,
    deadlineAt: 91_000,
    evidenceCount: 0,
  }), "investigate");
  assert.equal(subagentRunner.runtimeV2ChildStepPhase({
    now: 60_999,
    deadlineAt: 91_000,
    evidenceCount: 4,
  }), "investigate");
  assert.equal(subagentRunner.runtimeV2ChildStepPhase({
    now: 61_000,
    deadlineAt: 91_000,
    evidenceCount: 4,
  }), "synthesize");
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
    requestedAt: sequence + 1,
    nextId: () => "child-existing",
  });
  aggregate = runtime.transition(aggregate, nextEvent(
    "subagents.scheduled",
    { run, jobs: scheduled.jobs },
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
  evidence.recordToolModelContext({
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
  assert.match(String(tool.content), new RegExp(sourceTail.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
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

test("main execution does not apply a fixed message cap while the model input budget is healthy", () => {
  const messages = [{
    role: "system",
    content: "runtime system",
  }, {
    role: "user",
    content: "repair the complete objective",
  }];
  for (let index = 1; index <= 12; index += 1) {
    const id = `wide-read-${index}`;
    messages.push({
      role: "assistant",
      content: "",
      tool_calls: [{
        id,
        type: "function",
        function: {
          name: "read_file",
          arguments: JSON.stringify({ path: "src/main.js" }),
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
      contextLimit: 131_072,
      reservedOutputTokens: 8_192,
    },
  );

  assert.equal(
    bounded.filter((message) => message.role === "tool").length,
    12,
  );
  assert.ok(bounded.some((message) =>
    message.role === "tool" &&
    message.tool_call_id === "wide-read-1" &&
    String(message.content).includes("window-1")
  ));
});

test("standard tool history is not duplicated in the normal evidence digest", () => {
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
  providerContext.recordModelContext(live, {
    id: "workspace",
    source: "workspace",
    label: "overview",
    target: "/tmp/runtime-v2-history",
    status: "succeeded",
    content: "WORKSPACE_ANCHOR",
  });
  providerContext.recordModelContext(live, {
    id: "tool-result",
    source: "tool",
    label: "read_file",
    target: "src/main.js",
    status: "succeeded",
    content: "DUPLICATE_TOOL_BYTES",
  });

  const request = providerHistory.providerHistory(live, ports);
  const digest = String(request.messages.at(-1)?.content || "");

  assert.match(digest, /WORKSPACE_ANCHOR/);
  assert.doesNotMatch(digest, /DUPLICATE_TOOL_BYTES/);
});

test("a no-tool protocol response advances the next provider context", () => {
  const live = executionTypes.createRuntimeV2LiveExecutionState();
  const response = [
    "I inspected the available evidence but returned narration.",
    "The next request must not look identical to this one.",
  ].join("\n");
  providerHistory.appendRuntimeV2ProtocolDriftHistory(live, {
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

  providerHistory.appendRuntimeV2ProtocolDriftHistory(live, {
    visibleText: response,
    code: "required_tool_missing",
    feedback:
      "The response did not advance the task. Submit one different allowed structured action.",
  });
  assert.equal(live.messages.length, 2);
});

test("a text-envelope fallback does not become sticky Turn capability state", () => {
  const live = executionTypes.createRuntimeV2LiveExecutionState();

  assert.equal("lastProviderTransport" in live, false);
  assert.equal(
    typeof providerContext.providerProfileForProvenToolTransport,
    "undefined",
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
  const capsule = subagentContext.buildRuntimeV2SubagentContextCapsule({
    aggregate: {
      phase: "validating",
      objective: {
        text: "Repair save behavior",
        acceptanceCriteria: ["Opening stays clean"],
        acceptanceCriterionIds: ["criterion-save"],
      },
      executionContract: null,
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
    modelContext: [{
      id: "parent-main",
      source: "tool",
      label: "read_file",
      target: "src/main.js",
      status: "succeeded",
      content: "saveActiveFile(currentFile)",
    }, {
      id: "unrelated",
      source: "tool",
      label: "read_file",
      target: "docs/private.md",
      status: "succeeded",
      content: "unrelated content",
    }],
  });
  assert.match(capsule, /Repair save behavior/);
  assert.match(capsule, /saveActiveFile/);
  assert.match(capsule, /E-mutation/);
  assert.doesNotMatch(capsule, /unrelated content/);
});

test("child handoff keeps complete scoped parent windows when the run budget allows", () => {
  const completeWindow = [
    "READ_FILE_RESULT",
    "path: src/main.js",
    "contentVersion: main-v1",
    "---CONTENT START---",
    "A".repeat(9_000),
    "COMPLETE_PARENT_WINDOW_TAIL",
    "---CONTENT END---",
  ].join("\n");
  const modelContext = [{
    id: "parent-complete-main",
    source: "tool",
    label: "read_file",
    target: "src/main.js",
    status: "succeeded",
    content: completeWindow,
  }, ...Array.from({ length: 7 }, (_, index) => ({
    id: `parent-support-${index + 1}`,
    source: "tool",
    label: "grep_search",
    target: `src/support-${index + 1}.js`,
    status: "succeeded",
    content: `support-${index + 1}`,
  }))];
  const capsule = subagentContext.buildRuntimeV2SubagentContextCapsule({
    aggregate: {
      phase: "acting",
      objective: {
        text: "Repair save behavior",
        acceptanceCriteria: ["Opening stays clean"],
        acceptanceCriterionIds: ["criterion-save"],
      },
      executionContract: null,
      workPlan: null,
      sealedWorkPlan: null,
      evidence: [],
    },
    job: {
      taskKind: "review",
      allowedPaths: ["src"],
    },
    modelContext,
    contextBudget: {
      inputBudget: 100_000,
    },
  });

  assert.match(capsule, /parent-complete-main/);
  assert.match(capsule, /COMPLETE_PARENT_WINDOW_TAIL/);
  assert.match(capsule, /parent-support-7/);
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

test("one-Turn consent reaches browser execution but not per-call desktop control", async () => {
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
  assert.match(desktop.reason || "", /单次|per-call/i);
});

test("a structured child report can cite inherited or new real evidence only", () => {
  const realEvidence = [{
    id: "E-parent",
    kind: "source",
    target: "src/main.js",
    version: "v1",
  }];
  const report = runtime.compileRuntimeV2SubagentReport({
    evidence: realEvidence,
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
      evidence: realEvidence,
    }),
    true,
  );
  assert.throws(() => runtime.compileRuntimeV2SubagentReport({
    evidence: realEvidence,
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
