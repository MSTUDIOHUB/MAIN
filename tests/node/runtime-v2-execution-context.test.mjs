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
      for (const candidate of [base, `${base}.ts`, path.join(base, "index.ts")]) {
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

const context = {
  ...loadTs(path.join(
    workspaceRoot,
    "src/store/runtimeV2/executionProviderContext.ts",
  )),
  ...loadTs(path.join(
    workspaceRoot,
    "src/store/runtimeV2/executionProviderHistory.ts",
  )),
};
const authorization = loadTs(path.join(
  workspaceRoot,
  "src/store/runtimeV2/executionAuthorization.ts",
));
const evidence = loadTs(path.join(
  workspaceRoot,
  "src/store/runtimeV2/executionEvidence.ts",
));
const executionText = loadTs(path.join(
  workspaceRoot,
  "src/store/runtimeV2/executionText.ts",
));
const deterministicActions = loadTs(path.join(
  workspaceRoot,
  "src/store/runtimeV2/executionDeterministicActions.ts",
));
const hardDeadline = loadTs(path.join(
  workspaceRoot,
  "src/store/runtimeV2/hardDeadline.ts",
));
const toolDeadline = loadTs(path.join(
  workspaceRoot,
  "src/store/runtimeV2/executionToolDeadline.ts",
));
const correctivePolicy = loadTs(path.join(
  workspaceRoot,
  "src/store/runtimeV2/correctiveMutationPolicy.ts",
));
const schedulerPort = loadTs(path.join(
  workspaceRoot,
  "src/store/runtimeV2/executionSchedulerPort.ts",
));

function entry(id, source, target, content, status = "succeeded", label = source) {
  return { id, source, label, target, status, content };
}

test("Runtime v2 Execute carries prior Turn conclusions and the admitted current prompt into provider history", () => {
  const live = {
    messages: [],
    modelContext: [],
    workspaceOverview: "",
  };
  const state = {
    conversationTurns: [
      {
        id: "turn-prior",
        userPrompt: "修复编辑器无法保存的问题",
        status: "error",
        summary: "第一次修复未完成；已定位保存事件丢失。",
        durableContext: {
          schemaVersion: 1,
          turnId: "turn-prior",
          visibleUserMessages: ["修复编辑器无法保存的问题"],
          finalAssistantAnswer: "第一次修复未完成；已定位保存事件丢失。",
          execution: {
            decisions: ["优先修复保存事件链"],
            modifiedFiles: ["src/editor.ts"],
            validations: [],
            failures: ["run_command: npm run build"],
            unfinished: ["继续修复保存事件消费端"],
            advisories: [],
            artifacts: [],
          },
          committedAt: 1,
        },
        blockIds: [],
      },
      {
        id: "turn-current",
        userPrompt: "继续修复",
        status: "executing",
        summary: "",
        blockIds: [],
      },
    ],
    agentMessages: [
      {
        role: "user",
        runtimeTurnId: "turn-current",
        content: [
          "[turn_intake]",
          "subagentPreference: preferred",
          "用户请求：继续修复",
        ].join("\n"),
      },
    ],
  };

  const history = context.providerHistory(live, {
    get: () => state,
    context: {
      turnId: "turn-current",
      runWorkspace: "/fixture",
      phaseLanguage: "zh",
    },
    live,
  });

  assert.equal(history.priorTurns, 1);
  assert.equal(history.historyMessages, 5);
  assert.equal(history.messages[1].role, "user");
  assert.match(history.messages[1].content, /修复编辑器无法保存/);
  assert.equal(history.messages[2].role, "assistant");
  assert.match(history.messages[2].content, /第一次修复未完成/);
  assert.equal(history.messages[3].role, "system");
  assert.match(history.messages[3].content, /src\/editor\.ts/);
  assert.match(history.messages[3].content, /继续修复保存事件消费端/);
  assert.equal(history.messages[4].role, "user");
  assert.match(history.messages[4].content, /subagentPreference: preferred/);
  assert.match(history.messages[4].content, /继续修复/);
});

test("Runtime v2 context retention cannot evict workspace, child, or latest failure anchors", () => {
  const live = {
    messages: [{ role: "system", content: "runtime" }],
    modelContext: [],
    workspaceOverview: "package.json\nsrc/main.js",
  };
  context.recordModelContext(
    live,
    entry("workspace", "workspace", "/fixture", "workspace-root-token"),
  );
  context.recordModelContext(
    live,
    entry("frontend", "subagent", "src", "frontend-child-token", "succeeded", "frontend"),
  );
  context.recordModelContext(
    live,
    entry("backend", "subagent", "src-tauri", "backend-child-token", "succeeded", "backend"),
  );
  for (let index = 0; index < 24; index += 1) {
    context.recordModelContext(
      live,
      entry(`tool-${index}`, "tool", `src/file-${index}.js`, `tool-token-${index}`, "succeeded", "read_file"),
    );
  }
  context.recordModelContext(
    live,
    entry(
      "validation-failure",
      "tool",
      "npm run build",
      "FRESH_ACCEPTANCE_FAILURE_TOKEN",
      "failed",
      "run_command",
    ),
  );

  assert.equal(live.modelContext.length, 16);
  assert.equal(live.modelContext.some((item) => item.id === "workspace"), true);
  assert.equal(live.modelContext.some((item) => item.id === "frontend"), true);
  assert.equal(live.modelContext.some((item) => item.id === "backend"), true);
  assert.equal(
    live.modelContext.some((item) => item.id === "validation-failure"),
    true,
  );

  const history = context.providerHistory(live, {
    get: () => ({}),
    context: { turnId: "turn-a" },
    live,
  });
  const digest = history.messages.at(-1).content;
  assert.match(digest, /workspace-root-token/);
  assert.match(digest, /frontend-child-token/);
  assert.match(digest, /backend-child-token/);
  assert.match(digest, /FRESH_ACCEPTANCE_FAILURE_TOKEN/);
  assert.equal(history.retainedSources.workspace, 1);
  assert.equal(history.retainedSources.subagent, 2);
});

test("corrective mutation history isolates the validator and exact source snapshot", () => {
  const live = {
    messages: [
      { role: "system", content: "runtime" },
      { role: "user", content: "repair the workspace" },
    ],
    modelContext: [
      entry("workspace", "workspace", "/fixture", "OLD_WORKSPACE_SURVEY"),
      entry("child", "subagent", "src", "OLD_CHILD_HYPOTHESIS"),
      entry(
        "rejected-patch",
        "tool",
        "src/other.js",
        "OLD_REJECTED_MUTATION",
        "failed",
        "replace_in_file",
      ),
      entry(
        "plan",
        "plan",
        ".MAIN/plans/plan.md",
        "SEALED_PLAN_AUTHORITY",
      ),
      entry(
        "acceptance-failure",
        "tool",
        "npm run build",
        "src/main.js:405:1 - CURRENT_ACCEPTANCE_GAP",
        "failed",
        "run_command",
      ),
      entry(
        "unrelated-source",
        "tool",
        "src/other.js",
        "UNRELATED_SOURCE_BYTES",
        "succeeded",
        "read_file",
      ),
      entry(
        "current-source",
        "tool",
        "/fixture/src/main.js",
        "CURRENT_EXACT_SOURCE_BYTES",
        "succeeded",
        "read_file",
      ),
      entry(
        "provider-guess",
        "provider",
        "current-turn",
        "OLD_PROVIDER_GUESS",
      ),
      entry(
        "provider-protocol-failure",
        "provider",
        "acting:execute",
        "CURRENT_PROTOCOL_REPAIR: call exactly one allowed structured tool",
        "failed",
        "required_tool_missing",
      ),
    ],
    workspaceOverview: "",
  };
  const history = context.providerHistory(
    live,
    {
      get: () => ({}),
      context: { turnId: "turn-a", runWorkspace: "/fixture" },
      live,
    },
    {
      kind: "corrective_mutation",
      target: "src/main.js",
      evidenceId: "acceptance-failure",
    },
  );
  const digest = history.messages.at(-1).content;
  assert.match(digest, /runtime-v2 corrective evidence packet/);
  assert.match(digest, /CURRENT_ACCEPTANCE_GAP/);
  assert.match(digest, /CURRENT_EXACT_SOURCE_BYTES/);
  assert.match(digest, /SEALED_PLAN_AUTHORITY/);
  assert.doesNotMatch(digest, /OLD_WORKSPACE_SURVEY/);
  assert.doesNotMatch(digest, /OLD_CHILD_HYPOTHESIS/);
  assert.doesNotMatch(digest, /OLD_REJECTED_MUTATION/);
  assert.doesNotMatch(digest, /UNRELATED_SOURCE_BYTES/);
  assert.doesNotMatch(digest, /OLD_PROVIDER_GUESS/);
  assert.match(digest, /CURRENT_PROTOCOL_REPAIR/);
  assert.equal(history.retained, 4);
  assert.equal(history.retainedSources.provider, 1);
  assert.deepEqual(history.focus, {
    kind: "corrective_mutation",
    target: "src/main.js",
    evidenceId: "acceptance-failure",
  });
});

test("required tool phases prefer a proven transport without losing one bounded protocol fallback", () => {
  const profile = {
    schemaVersion: "provider-lane.v1",
    nativeTools: true,
    requiredToolChoice: true,
    streaming: true,
    textToolEnvelope: true,
    reasoning: false,
    imageInput: false,
    toolResultRole: "tool",
  };
  assert.deepEqual(
    context.providerProfileForProvenToolTransport(
      profile,
      "native",
      true,
    ),
    profile,
  );
  assert.deepEqual(
    context.providerProfileForProvenToolTransport(
      profile,
      "text_envelope",
      true,
    ),
    { ...profile, nativeTools: false },
  );
  assert.equal(
    context.providerProfileForProvenToolTransport(
      profile,
      "native",
      false,
    ),
    profile,
  );
});

test("Runtime v2 derives a focused reread window from the latest failed validation", () => {
  const live = {
    modelContext: [
      entry(
        "failed-build",
        "tool",
        "npm run build",
        [
          "FRESH_FIXTURE_ACCEPTANCE_FAILED:",
          "src/main.js:405:1 - openFiles still violates acceptance",
          "src/components/editor.js:184:1 - setValue dispatches input",
        ].join("\n"),
        "failed",
        "run_command",
      ),
    ],
  };
  assert.deepEqual(
    context.latestFailureReadWindow(
      live,
      "/fixture/src/main.js",
      "/fixture",
    ),
    {
      startLine: 341,
      endLine: 445,
      failureLine: 405,
      evidenceId: "failed-build",
    },
  );
  assert.equal(
    context.latestFailureReadWindow(live, "src/other.js", "/fixture"),
    null,
  );
});

test("failed validation output remains failed model context evidence", () => {
  assert.equal(
    evidence.modelContextStatusForCompletion({
      type: "validation.completed",
      passed: false,
      evidence: [],
    }),
    "failed",
  );
  assert.equal(
    evidence.modelContextStatusForCompletion({
      type: "validation.completed",
      passed: true,
      evidence: [],
    }),
    "succeeded",
  );
  assert.equal(
    evidence.modelContextStatusForCompletion({
      type: "tool.completed",
      status: "blocked",
      evidence: [],
    }),
    "blocked",
  );
});

test("tool completion retains a bounded real result and mutation diff for UI projection", () => {
  const live = { evidenceCounter: 0 };
  const command = {
    kind: "execute_tool",
    run: { turnId: "turn-a", runId: "run-a" },
    idempotencyKey: "edit-command-a",
    payload: { toolCallId: "edit-call-a" },
  };
  const completion = evidence.toolCompletionFor(
    { live },
    command,
    "replace_in_file",
    {
      path: "src/editor.ts",
      search_text: "const saved = false;",
      replace_text: "const saved = true;",
    },
    "src/editor.ts",
    JSON.stringify({ message: "Updated src/editor.ts" }),
    "succeeded",
    undefined,
    undefined,
    {
      old: "const saved = false;\n",
      new: "const saved = true;\n",
      path: "src/editor.ts",
      existed: true,
      fullFile: true,
    },
  );

  assert.equal(completion.type, "tool.completed");
  assert.equal(completion.presentation.toolName, "replace_in_file");
  assert.equal(completion.presentation.target, "src/editor.ts");
  assert.match(completion.presentation.message, /Updated src\/editor\.ts/);
  assert.deepEqual(completion.presentation.diff, {
    old: "const saved = false;\n",
    new: "const saved = true;\n",
    path: "src/editor.ts",
    existed: true,
    fullFile: true,
  });
});

test("structured command stderr is decoded for primary failure source recovery", () => {
  const decoded = evidence.modelContextContentForToolOutput(JSON.stringify({
    exitCode: 1,
    stdout: "",
    stderr: [
      "src/components/toolbar.js:103:1 - duplicate declaration",
      "src/main.js:405:1 - acceptance gap",
    ].join("\n"),
  }));
  assert.match(decoded, /exitCode: 1/);
  assert.match(decoded, /src\/components\/toolbar\.js:103:1/);
  assert.doesNotMatch(decoded, /\\n/);

  const live = {
    modelContext: [
      entry(
        "failed-build",
        "tool",
        "npm run build",
        decoded,
        "failed",
        "run_command",
      ),
    ],
  };
  assert.deepEqual(
    context.latestFailureSourceWindow(live, "/fixture"),
    {
      path: "src/components/toolbar.js",
      startLine: 39,
      endLine: 143,
      failureLine: 103,
      evidenceId: "failed-build",
    },
  );
});

test("failed acceptance keeps authority unless a same-file mismatch overlaps its source window", () => {
  const live = {
    modelContext: [
      entry(
        "failed-build",
        "tool",
        "npm run build",
        "src/main.js:472:1 - openFiles acceptance gap",
        "failed",
        "run_command",
      ),
      entry(
        "failed-patch",
        "tool",
        "src/main.js",
        "src/main.js:450:1 - replace search text mismatch",
        "failed",
        "replace_in_file",
      ),
    ],
  };
  assert.deepEqual(
    context.latestFailureSourceWindow(live, "/fixture"),
    {
      path: "src/main.js",
      startLine: 408,
      endLine: 512,
      failureLine: 472,
      evidenceId: "failed-build",
    },
  );
  assert.deepEqual(
    context.latestAcceptanceFailureSourceWindow(live, "/fixture"),
    context.latestFailureSourceWindow(live, "/fixture"),
  );
  assert.deepEqual(
    context.latestCorrectiveSourceRefreshWindow(live, "/fixture"),
    {
      path: "src/main.js",
      startLine: 386,
      endLine: 490,
      failureLine: 450,
      evidenceId: "failed-patch",
    },
  );
  const unrelatedSameFilePatch = {
    modelContext: [
      live.modelContext[0],
      entry(
        "unrelated-same-file-patch",
        "tool",
        "src/main.js",
        "src/main.js:98:1 - replace search text mismatch",
        "failed",
        "replace_in_file",
      ),
    ],
  };
  assert.deepEqual(
    context.latestCorrectiveSourceRefreshWindow(
      unrelatedSameFilePatch,
      "/fixture",
    ),
    context.latestAcceptanceFailureSourceWindow(
      unrelatedSameFilePatch,
      "/fixture",
    ),
  );
  const unlocatedPatch = {
    modelContext: [
      live.modelContext[0],
      entry(
        "unlocated-patch",
        "tool",
        "src/main.js",
        "MUTATION_PREFLIGHT_BLOCKED: apply_patch context does not match current source.",
        "failed",
        "apply_patch",
      ),
    ],
  };
  assert.deepEqual(
    context.latestCorrectiveSourceRefreshWindow(
      unlocatedPatch,
      "/fixture",
    ),
    context.latestAcceptanceFailureSourceWindow(
      unlocatedPatch,
      "/fixture",
    ),
  );
  live.modelContext.push(entry(
    "wrong-file-patch",
    "tool",
    "src/other.js",
    "src/other.js:25:1 - replace search text mismatch",
    "failed",
    "replace_in_file",
  ));
  assert.deepEqual(
    context.latestCorrectiveSourceRefreshWindow(live, "/fixture"),
    context.latestAcceptanceFailureSourceWindow(live, "/fixture"),
  );
});

test("diagnostic file labels and file URIs normalize to workspace-relative paths", () => {
  assert.equal(
    context.normalizeRuntimeV2WorkspacePath(
      "file: /fixture/My%20Project/src/main.js",
      "/fixture/My Project",
    ),
    "src/main.js",
  );
  assert.equal(
    context.normalizeRuntimeV2WorkspacePath(
      "file:///fixture/My%20Project/src/main.js",
      "/fixture/My Project",
    ),
    "src/main.js",
  );
  const live = {
    modelContext: [
      entry(
        "failed-build-file-label",
        "tool",
        "npm run build",
        "file: /fixture/My Project/src/main.js:487:1 - acceptance failed",
        "failed",
        "run_command",
      ),
    ],
  };
  assert.deepEqual(
    context.latestAcceptanceFailureSourceWindow(
      live,
      "/fixture/My Project",
    ),
    {
      path: "src/main.js",
      startLine: 423,
      endLine: 527,
      failureLine: 487,
      evidenceId: "failed-build-file-label",
    },
  );
});

test("corrective mutation is leased to the validator-reported source file", () => {
  const live = {
    modelContext: [
      entry(
        "failed-build",
        "tool",
        "npm run build",
        "src/components/editor.js:184:1 - acceptance failed",
        "failed",
        "run_command",
      ),
    ],
  };
  const ports = {
    get: () => ({}),
    context: {
      turnId: "turn-a",
      runWorkspace: "/fixture",
    },
    live,
  };
  const providerCommand = {
    kind: "request_model",
    phase: "acting",
    payload: {
      mode: "execute",
      executePolicy: "mutation_required",
    },
  };
  const definitions = authorization.providerToolDefinitionsForCommand(
    ports,
    providerCommand,
  );
  assert.deepEqual(
    definitions.map((definition) => definition.function.name),
    ["replace_in_file", "apply_patch"],
  );
  assert.deepEqual(
    definitions[0].function.parameters.properties.path.enum,
    ["src/components/editor.js"],
  );
  assert.match(
    definitions[1].function.description,
    /src\/components\/editor\.js/,
  );
  const reorientationDefinitions =
    authorization.providerToolDefinitionsForCommand(ports, {
      ...providerCommand,
      payload: {
        mode: "execute",
        executePolicy: "source_reorientation_required",
      },
    });
  const reorientationNames = reorientationDefinitions.map(
    (definition) => definition.function.name,
  );
  assert.ok(reorientationNames.includes("read_file"));
  assert.ok(reorientationNames.includes("list_directory"));
  assert.equal(reorientationNames.includes("replace_in_file"), false);
  assert.equal(reorientationNames.includes("apply_patch"), false);

  const toolCommand = {
    kind: "execute_tool",
    phase: "acting",
  };
  const rejected = authorization.validateToolAgainstPhaseAndPlan({
    ports,
    command: toolCommand,
    toolName: "replace_in_file",
    args: {
      path: "src/main.js",
      search_text: "old",
      replace_text: "new",
    },
    target: "src/main.js",
  });
  assert.equal(rejected.allowed, false);
  assert.equal(
    rejected.reasonCode,
    "mutation_target_lease_mismatch",
  );
  const accepted = authorization.validateToolAgainstPhaseAndPlan({
    ports,
    command: toolCommand,
    toolName: "replace_in_file",
    args: {
      path: "/fixture/src/components/editor.js",
      search_text: "old",
      replace_text: "new",
    },
    target: "/fixture/src/components/editor.js",
  });
  assert.equal(accepted.allowed, true);
});

test("corrective phase allows one durable clarifying read before closing reads", () => {
  const sourceEvent = (sequence) => ({
    type: "tool.completed",
    sequence,
    status: "succeeded",
    evidence: [{
      id: `source-${sequence}`,
      kind: "source",
      target: "src/main.js",
      version: `v${sequence}`,
    }],
  });
  const aggregate = {
    phase: "acting",
    events: [
      { type: "phase.changed", phase: "acting", sequence: 1 },
      sourceEvent(2),
    ],
  };
  assert.equal(
    correctivePolicy.allowsRuntimeV2CorrectiveClarifyingRead(aggregate),
    true,
  );
  assert.equal(
    correctivePolicy.allowsRuntimeV2CorrectiveClarifyingRead({
      ...aggregate,
      events: [...aggregate.events, sourceEvent(3)],
    }),
    false,
  );

  const definitions = authorization
    .createRuntimeV2ExecutionAuthorization({})
    .toolDefinitions;
  const constrained =
    correctivePolicy.constrainRuntimeV2MutationTools(
      definitions,
      {
        target: "src/main.js",
        authority: "acceptance_failure",
        evidenceId: "failed-build",
      },
      true,
    );
  assert.deepEqual(
    constrained.map((definition) => definition.function.name),
    ["read_file", "replace_in_file", "apply_patch"],
  );
  assert.deepEqual(
    constrained[0].function.parameters.properties.path.enum,
    ["src/main.js"],
  );
});

test("investigation is read-only and direct mutation is leased to the latest exact parent read", () => {
  const live = {
    modelContext: [
      entry(
        "main-read",
        "tool",
        "/fixture/src/main.js",
        "const ready = true;",
        "succeeded",
        "read_file",
      ),
    ],
  };
  const ports = {
    get: () => ({}),
    context: {
      turnId: "turn-a",
      runWorkspace: "/fixture",
    },
    live,
  };
  const command = (mode, executePolicy = undefined) => ({
    kind: "request_model",
    phase: mode === "observe" ? "observing" : "acting",
    payload: {
      mode,
      ...(executePolicy ? { executePolicy } : {}),
    },
  });
  const names = (value) =>
    authorization.providerToolDefinitionsForCommand(ports, value)
      .map((definition) => definition.function.name);

  const observeNames = names(command("observe"));
  assert.ok(observeNames.includes("read_file"));
  assert.equal(observeNames.includes("replace_in_file"), false);
  assert.equal(observeNames.includes("apply_patch"), false);

  const sourceGapNames = names(command("execute", "source_gap_allowed"));
  assert.ok(sourceGapNames.includes("read_file"));
  assert.equal(sourceGapNames.includes("replace_in_file"), false);
  assert.equal(sourceGapNames.includes("apply_patch"), false);

  const mutationDefinitions = authorization.providerToolDefinitionsForCommand(
    ports,
    command("execute", "mutation_required"),
  );
  assert.deepEqual(
    mutationDefinitions.map((definition) => definition.function.name),
    ["replace_in_file", "apply_patch"],
  );
  assert.deepEqual(
    mutationDefinitions[0].function.parameters.properties.path.enum,
    ["src/main.js"],
  );
});

test("Runtime v2 collaboration tool surface requires the model to choose child identity and work", () => {
  const ports = {
    get: () => ({}),
    context: { turnId: "turn-a", runWorkspace: "/fixture" },
    live: { modelContext: [] },
  };
  const spawnRequired =
    authorization.providerToolDefinitionsForCommand(ports, {
      kind: "request_model",
      phase: "observing",
      payload: {
        mode: "observe",
        collaborationAllowed: true,
        collaborationAction: "spawn_required",
        remainingSubagentCapacity: 2,
      },
    });
  assert.deepEqual(
    spawnRequired.map((definition) => definition.function.name),
    ["spawn_subagent"],
  );
  assert.deepEqual(
    spawnRequired[0].function.parameters.required,
    ["task_key", "name", "role", "objective", "success_criteria"],
  );

  const active =
    authorization.providerToolDefinitionsForCommand(ports, {
      kind: "request_model",
      phase: "observing",
      payload: {
        mode: "observe",
        collaborationAllowed: true,
        collaborationAction: "children_active",
        remainingSubagentCapacity: 1,
        activeSubagents: [{
          id: "child-kepler",
          name: "Kepler",
          objective: "Audit the save event handoff.",
        }],
      },
    });
  const activeNames = active.map((definition) => definition.function.name);
  assert.ok(activeNames.includes("read_file"));
  assert.ok(activeNames.includes("spawn_subagent"));
  assert.ok(activeNames.includes("wait_subagents"));
  assert.equal(activeNames.includes("replace_in_file"), false);
});

test("Runtime v2 scheduler materializes the provider's child arguments verbatim", async () => {
  let childOrdinal = 0;
  const port = schedulerPort.createRuntimeV2SchedulerPort({
    get: () => ({}),
    context: {
      turnId: "turn-a",
      runWorkspace: "/fixture",
      phaseLanguage: "zh",
    },
    live: {
      childRuns: new Map(),
      childAbortControllers: new Map(),
      childTelemetry: new Map(),
    },
    nextId: () => `child-${++childOrdinal}`,
    now: () => 10,
    logStoreEvent() {},
  });
  const scheduled = await port.prepareSchedule({
    command: {
      kind: "schedule_subagents",
      run: {
        sessionKey: "session-a",
        sessionEpoch: "epoch-a",
        turnId: "turn-a",
        runId: "run-a",
        parentRunId: null,
        attemptId: "attempt-a",
      },
      payload: {
        toolCallId: "spawn-kepler",
        arguments: {
          task_key: "save-event-consumer-audit",
          name: "Kepler",
          role: "event-flow reviewer",
          objective: "Trace the save event consumer handoff.",
          success_criteria: "Return exact paths and the first unsupported transition.",
          expected_output: "A sourced handoff report.",
          allowed_paths: "src/editor, src/events",
          access_mode: "read",
        },
      },
    },
  });

  assert.equal(scheduled.type, "subagents.scheduled");
  assert.equal(scheduled.jobs.length, 1);
  assert.equal(scheduled.jobs[0].sourceToolCallId, "spawn-kepler");
  assert.equal(scheduled.jobs[0].name, "Kepler");
  assert.equal(scheduled.jobs[0].role, "event-flow reviewer");
  assert.equal(
    scheduled.jobs[0].objective,
    "Trace the save event consumer handoff.",
  );
  assert.deepEqual(
    scheduled.jobs[0].allowedPaths,
    ["src/editor", "src/events"],
  );
});

test("a failed mutation editor yields to its equivalent until a newer exact read arrives", () => {
  const live = {
    modelContext: [
      entry(
        "main-read",
        "tool",
        "src/main.js",
        "const ready = true;",
        "succeeded",
        "read_file",
      ),
      entry(
        "patch-failed",
        "tool",
        "src/main.js",
        "source mismatch",
        "failed",
        "apply_patch",
      ),
    ],
  };
  const ports = {
    get: () => ({}),
    context: { turnId: "turn-a", runWorkspace: "/fixture" },
    live,
  };
  const providerCommand = {
    kind: "request_model",
    phase: "acting",
    payload: {
      mode: "execute",
      executePolicy: "mutation_required",
    },
  };
  const names = () =>
    authorization.providerToolDefinitionsForCommand(ports, providerCommand)
      .map((definition) => definition.function.name);

  assert.deepEqual(names(), ["replace_in_file"]);
  live.modelContext.push(entry(
    "main-read-new",
    "tool",
    "src/main.js",
    "const ready = false;",
    "succeeded",
    "read_file",
  ));
  assert.deepEqual(names(), ["replace_in_file", "apply_patch"]);
});

test("provider deadline settles even when the transport ignores cancellation", async () => {
  let canceled = false;
  const startedAt = Date.now();
  await assert.rejects(
    hardDeadline.withRuntimeV2HardDeadline({
      timeoutMs: 15,
      onTimeout: () => { canceled = true; },
      timeoutError: "EXPECTED_HARD_TIMEOUT",
      task: () => new Promise(() => undefined),
    }),
    /EXPECTED_HARD_TIMEOUT/,
  );
  assert.equal(canceled, true);
  assert.ok(Date.now() - startedAt < 1_000);
  assert.equal(
    await hardDeadline.withRuntimeV2HardDeadline({
      timeoutMs: 1_000,
      task: async () => "settled",
    }),
    "settled",
  );
});

test("workspace source and validation tools cannot hold the Runtime loop indefinitely", async () => {
  assert.equal(toolDeadline.runtimeV2ToolDeadlineMs("read_file"), 45_000);
  assert.equal(toolDeadline.runtimeV2ToolDeadlineMs("replace_in_file"), null);
  assert.equal(toolDeadline.runtimeV2ToolDeadlineMs("run_command"), 120_000);
  assert.equal(
    await toolDeadline.executeRuntimeV2ToolWithDeadline({
      toolName: "read_file",
      task: async () => "source",
    }),
    "source",
  );
  const startedAt = Date.now();
  await assert.rejects(
    toolDeadline.executeRuntimeV2ToolWithDeadline({
      toolName: "run_command",
      lifecycleDeadlineAt: Date.now() + 15,
      task: () => new Promise(() => undefined),
    }),
    /RUNTIME_V2_TOOL_TIMEOUT:run_command/,
  );
  assert.ok(Date.now() - startedAt < 1_000);
});

test("failed command diagnostics survive a large stdout preamble", () => {
  const decoded = evidence.modelContextContentForToolOutput(JSON.stringify({
    exitCode: 1,
    success: false,
    stdout: "build output\n".repeat(2_000),
    stderr: "src/components/editor.js:184:1 - acceptance failed",
  }));
  const bounded = executionText.boundedToolContent(decoded, 5_000);
  assert.match(bounded, /src\/components\/editor\.js:184:1/);
  assert.ok(
    decoded.indexOf("src/components/editor.js:184:1") <
      decoded.indexOf("build output"),
  );
});

test("Runtime v2 validation guidance uses a bounded project-family command", () => {
  const input = {
    get: () => ({}),
    context: { turnId: "turn-a" },
    live: { workspaceOverview: "package.json\npnpm-lock.yaml" },
  };
  assert.equal(
    context.preferredFiniteValidationCommand(input),
    "pnpm run build",
  );
  assert.equal(
    context.preferredFiniteValidationCommand({
      ...input,
      live: {
        workspaceOverview:
          "package.json\npackage-lock.json\nsrc-tauri/Cargo.toml",
      },
    }),
    "npm run build",
  );
});

test("Runtime v2 rejects text inspection commands as validation", () => {
  const ports = {
    get: () => ({}),
    context: { turnId: "turn-a" },
  };
  const command = {
    kind: "execute_validation",
    phase: "validating",
  };
  const rejection = authorization.finiteValidationCommandRejection(
    "cat src/main.js | head -100",
  );
  assert.equal(
    rejection?.reasonCode,
    "finite_validation_contract_required",
  );
  assert.equal(
    authorization.finiteValidationCommandRejection("npm run build"),
    null,
  );
  const rejected = authorization.validateToolAgainstPhaseAndPlan({
    ports,
    command,
    toolName: "run_command",
    args: { command: "cat src/main.js | head -100" },
    target: "cat src/main.js | head -100",
  });
  assert.equal(rejected.allowed, false);
  assert.equal(rejected.failureKind, "protocol_invalid");
  assert.equal(rejected.reasonCode, "finite_validation_contract_required");

  const accepted = authorization.validateToolAgainstPhaseAndPlan({
    ports,
    command,
    toolName: "run_command",
    args: { command: "npm run build" },
    target: "npm run build",
  });
  assert.equal(accepted.allowed, true);
});

test("Runtime v2 owns known validation and corrective reread actions", () => {
  const run = {
    sessionKey: "session-a",
    sessionEpoch: "epoch-a",
    turnId: "turn-a",
    runId: "run-a",
    parentRunId: null,
    attemptId: "attempt-a",
  };
  const validation = deterministicActions.selectRuntimeOwnedValidationAction({
    command: {
      idempotencyKey: "validation-a",
      kind: "request_model",
      run,
      phase: "validating",
      payload: { mode: "validate" },
    },
    allowedToolNames: ["run_command"],
    preferredCommand: "npm run build",
  });
  assert.equal(validation.toolCalls[0].name, "run_command");
  assert.equal(
    validation.toolCalls[0].arguments.command,
    "npm run build",
  );
  assert.equal(
    deterministicActions.selectRuntimeOwnedValidationAction({
      command: {
        idempotencyKey: "validation-b",
        kind: "request_model",
        run,
        phase: "validating",
        payload: { mode: "validate" },
      },
      allowedToolNames: ["run_command"],
      preferredCommand: "cat src/main.js",
    }),
    null,
  );

  const refresh = deterministicActions.selectRuntimeOwnedSourceRefreshAction({
    command: {
      idempotencyKey: "refresh-a",
      kind: "request_model",
      run,
      phase: "acting",
      payload: {
        mode: "execute",
        executePolicy: "source_refresh_required",
      },
    },
    allowedToolNames: ["read_file"],
    sourceWindow: {
      path: "src/main.js",
      startLine: 341,
      endLine: 445,
    },
  });
  assert.deepEqual(refresh.toolCalls[0].arguments, {
    path: "src/main.js",
    start_line: 341,
    end_line: 445,
    max_lines: 105,
  });
});
