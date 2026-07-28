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
const runtime = loadTs(path.join(
  workspaceRoot,
  "src/lib/runtime-v2/index.ts",
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
const providerTools = loadTs(path.join(
  workspaceRoot,
  "src/store/runtimeV2/executionProviderTools.ts",
));
const subagentContext = loadTs(path.join(
  workspaceRoot,
  "src/store/runtimeV2/executionSubagentContext.ts",
));

function entry(id, source, target, content, status = "succeeded", label = source) {
  return { id, source, label, target, status, content };
}

test("late child handoff carries parent facts without converting them into child evidence", () => {
  const capsule = subagentContext.buildRuntimeV2SubagentContextCapsule({
    aggregate: {
      phase: "validating",
      objective: {
        text: "修复打开文件后误触发保存弹窗",
        acceptanceCriteria: ["打开文件保持 clean，保存使用活动路径"],
        acceptanceCriterionIds: ["criterion-save"],
      },
      executionContract: {
        status: "active",
        id: "contract-save",
        revision: 2,
        criteria: [{
          id: "criterion-save",
          evidenceRequirement: "behavioral",
        }],
        changes: [{
          operation: "modify",
          target: "src/main.js",
          basisEvidenceIds: ["E1"],
        }],
        validations: [{
          id: "validation-save",
          criterionIds: ["criterion-save"],
          targetPaths: ["src/main.js"],
          kind: "browser",
          primitive: { kind: "browser_interaction" },
        }],
      },
      evidence: [
        {
          id: "E1",
          kind: "source",
          target: "src/main.js",
          version: "main-v1",
        },
        {
          id: "E2",
          kind: "mutation",
          target: "src/main.js",
          version: null,
        },
      ],
    },
    job: {
      allowedPaths: ["src"],
    },
    modelContext: [
      entry(
        "parent-main",
        "tool",
        "src/main.js",
        "invoke('save_file_content', { filePath: active.path })",
        "succeeded",
        "read_file",
      ),
      entry(
        "unrelated",
        "tool",
        "docs/notes.md",
        "unrelated secret survey",
        "succeeded",
        "read_file",
      ),
    ],
  });
  assert.match(capsule, /修复打开文件后误触发保存弹窗/);
  assert.match(capsule, /contract-save/);
  assert.match(capsule, /save_file_content/);
  assert.match(capsule, /committedMutationTargets/);
  assert.doesNotMatch(capsule, /unrelated secret survey/);
  assert.doesNotMatch(capsule, /CHILD_EVIDENCE_ID/);
});

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

test("a rejected repeated read keeps the successful source window in model context", () => {
  const live = {
    messages: [],
    modelContext: [],
    workspaceOverview: "",
  };
  context.recordModelContext(
    live,
    entry(
      "source-window",
      "tool",
      "src/main.js",
      "SOURCE_WINDOW_TOKEN",
      "succeeded",
      "read_file",
    ),
  );
  context.recordModelContext(
    live,
    entry(
      "repeat-feedback",
      "tool",
      "src/main.js",
      "UNCHANGED_SOURCE_REPEAT_REJECTED",
      "failed",
      "read_file",
    ),
  );

  assert.equal(live.modelContext.length, 2);
  assert.equal(
    live.modelContext.some((item) =>
      item.status === "succeeded" &&
      item.content === "SOURCE_WINDOW_TOKEN"
    ),
    true,
  );
  assert.equal(
    live.modelContext.some((item) =>
      item.status === "failed" &&
      item.content === "UNCHANGED_SOURCE_REPEAT_REJECTED"
    ),
    true,
  );
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
  const definitionNames = definitions.map(
    (definition) => definition.function.name,
  );
  assert.ok(definitionNames.includes("read_file"));
  assert.ok(definitionNames.includes("replace_in_file"));
  assert.ok(definitionNames.includes("apply_patch"));
  assert.equal(definitionNames.includes("run_command"), false);
  assert.equal(definitionNames.includes("write_file"), false);
  const replaceDefinition = definitions.find(
    (definition) => definition.function.name === "replace_in_file",
  );
  const patchDefinition = definitions.find(
    (definition) => definition.function.name === "apply_patch",
  );
  assert.deepEqual(
    replaceDefinition.function.parameters.properties.path.enum,
    ["src/components/editor.js"],
  );
  assert.match(
    patchDefinition.function.description,
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
  const constrainedNames = constrained.map(
    (definition) => definition.function.name,
  );
  assert.ok(constrainedNames.includes("read_file"));
  assert.ok(constrainedNames.includes("grep_search"));
  assert.ok(constrainedNames.includes("replace_in_file"));
  assert.ok(constrainedNames.includes("apply_patch"));
  assert.equal(constrainedNames.includes("run_command"), false);
  assert.deepEqual(
    constrained.find((definition) =>
      definition.function.name === "replace_in_file"
    ).function.parameters.properties.path.enum,
    ["src/main.js"],
  );
});

test("Acting source exploration closes only after every contract target has versioned coverage", () => {
  const aggregate = {
    phase: "acting",
    executionContract: {
      changes: [
        { operation: "modify", target: "src/main.js" },
        { operation: "modify", target: "src/components/editor.js" },
      ],
    },
    events: [
      { type: "phase.changed", phase: "acting" },
      {
        type: "tool.completed",
        status: "succeeded",
        evidence: [{
          id: "main-source",
          kind: "source",
          target: "src/main.js",
          version: "main-v1",
        }],
      },
    ],
  };
  assert.equal(
    providerTools.hasRuntimeV2ContractSourceCoverage(aggregate),
    false,
  );
  assert.equal(
    providerTools.hasRuntimeV2ContractSourceCoverage({
      ...aggregate,
      events: [
        ...aggregate.events,
        {
          type: "tool.completed",
          status: "succeeded",
          evidence: [{
            id: "editor-source",
            kind: "source",
            target: "src/components/editor.js",
            version: "editor-v1",
          }],
        },
      ],
    }),
    true,
  );
});

test("a repeated read forces a named mutation with a singleton envelope fallback", () => {
  const definition = (name) => ({
    type: "function",
    function: {
      name,
      description: name,
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
    },
  });
  const command = {
    kind: "request_model",
    phase: "acting",
    payload: {
      mode: "execute",
      executePolicy: "mutation_required",
      toolExpectation: "required",
      mutationProgressionRequired: true,
      activeSubagents: [],
    },
  };
  const available = [
    definition("read_file"),
    definition("replace_in_file"),
    definition("apply_patch"),
    definition("submit_execution_contract"),
  ];
  assert.equal(
    providerTools.forcedRuntimeV2MutationToolName(
      command,
      available.map((item) => item.function.name),
    ),
    "replace_in_file",
  );
  assert.deepEqual(
    providerTools.runtimeV2ProviderAttemptTools(
      available,
      "replace_in_file",
    ).map((item) => item.function.name),
    ["replace_in_file"],
  );
  assert.deepEqual(
    providerTools.runtimeV2ProviderAttemptTools(
      available,
      null,
    ).map((item) => item.function.name),
    available.map((item) => item.function.name),
  );
});

test("a failed forced editor rotates to another mutation primitive and resets after success", () => {
  const command = {
    kind: "request_model",
    phase: "acting",
    payload: {
      mode: "execute",
      executePolicy: "mutation_required",
      toolExpectation: "required",
      mutationProgressionRequired: true,
    },
  };
  const names = ["read_file", "replace_in_file", "apply_patch"];
  const failedReplace = {
    events: [{
      type: "tool.completed",
      status: "failed",
      evidence: [],
      presentation: {
        toolName: "replace_in_file",
        target: "src/main.js",
      },
    }],
  };
  assert.equal(
    providerTools.forcedRuntimeV2MutationToolName(
      command,
      names,
      failedReplace,
    ),
    "apply_patch",
  );
  assert.equal(
    providerTools.forcedRuntimeV2MutationToolName(
      command,
      names,
      {
        events: [
          ...failedReplace.events,
          {
            type: "tool.completed",
            status: "failed",
            evidence: [],
            presentation: {
              toolName: "apply_patch",
              target: "src/main.js",
            },
          },
        ],
      },
    ),
    "replace_in_file",
  );
  assert.equal(
    providerTools.forcedRuntimeV2MutationToolName(
      command,
      names,
      {
        events: [
          ...failedReplace.events,
          {
            type: "tool.completed",
            status: "succeeded",
            evidence: [{
              id: "mutation-main",
              kind: "mutation",
              target: "src/main.js",
              version: null,
            }],
            presentation: {
              toolName: "apply_patch",
              target: "src/main.js",
            },
          },
        ],
      },
    ),
    "replace_in_file",
  );
});

test("an uncovered contract target narrows source acquisition to one exact read", () => {
  const definition = (name) => ({
    type: "function",
    function: {
      name,
      description: name,
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          query: { type: "string" },
        },
        required: [],
      },
    },
  });
  const required = providerTools.runtimeV2RequiredSourceToolDefinitions(
    [
      definition("read_file"),
      definition("grep_search"),
      definition("replace_in_file"),
      definition("spawn_subagent"),
    ],
    "src/main.js",
  );
  assert.deepEqual(
    required.map((item) => item.function.name),
    ["read_file"],
  );
  assert.deepEqual(
    required[0].function.parameters.properties.path.enum,
    ["src/main.js"],
  );
});

test("investigation is read-only and direct mutation is leased to the latest exact parent read", () => {
  assert.equal(
    correctivePolicy.runtimeV2ContractAllowsMutationTarget(
      {
        executionContract: {
          changes: [
            { operation: "modify", target: "src/main.js" },
          ],
        },
      },
      "/fixture/src/components/statusbar.js",
    ),
    false,
  );
  assert.equal(
    correctivePolicy.runtimeV2ContractAllowsMutationTarget(
      {
        executionContract: {
          changes: [
            { operation: "modify", target: "src/main.js" },
          ],
        },
      },
      "/fixture/src/main.js",
    ),
    true,
  );
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
  const mutationNames = mutationDefinitions.map(
    (definition) => definition.function.name,
  );
  assert.ok(mutationNames.includes("read_file"));
  assert.ok(mutationNames.includes("grep_search"));
  assert.ok(mutationNames.includes("replace_in_file"));
  assert.ok(mutationNames.includes("apply_patch"));
  assert.deepEqual(
    mutationDefinitions.find((definition) =>
      definition.function.name === "replace_in_file"
    ).function.parameters.properties.path.enum,
    ["src/main.js"],
  );
});

test("preferred collaboration remains optional and keeps parent reads available", () => {
  const ports = {
    get: () => ({}),
    context: { turnId: "turn-a", runWorkspace: "/fixture" },
    live: { modelContext: [] },
  };
  const optionalCollaboration =
    authorization.providerToolDefinitionsForCommand(ports, {
      kind: "request_model",
      phase: "observing",
      payload: {
        mode: "observe",
        collaborationAllowed: true,
        remainingSubagentCapacity: 2,
      },
    });
  const preferredNames = optionalCollaboration.map(
    (definition) => definition.function.name,
  );
  assert.ok(preferredNames.includes("spawn_subagent"));
  assert.ok(preferredNames.includes("read_file"));
  assert.deepEqual(
    optionalCollaboration.find((definition) =>
      definition.function.name === "spawn_subagent"
    ).function.parameters.required,
    [
      "task_key",
      "task_kind",
      "name",
      "role",
      "objective",
      "success_criteria",
    ],
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

  for (const [phase, mode] of [
    ["observing", "observe"],
    ["acting", "execute"],
    ["validating", "validate"],
    ["validating", "conclude"],
  ]) {
    const names = authorization.providerToolDefinitionsForCommand(
      ports,
      {
        kind: "request_model",
        phase,
        payload: {
          mode,
          collaborationAllowed: true,
          collaborationAction: "optional",
          remainingSubagentCapacity: 2,
          activeSubagents: [],
        },
      },
    ).map((definition) => definition.function.name);
    assert.ok(
      names.includes("spawn_subagent"),
      `${mode} must allow on-demand child delegation`,
    );
    if (mode === "validate") {
      assert.equal(names.includes("read_file"), false);
      assert.equal(names.includes("replace_in_file"), false);
    }
  }

  const takeoverNames = authorization.providerToolDefinitionsForCommand(
    ports,
    {
      kind: "request_model",
      phase: "validating",
      payload: {
        mode: "validate",
        validationParentTakeoverReadRequired: true,
        collaborationAllowed: true,
        collaborationAction: "parent_takeover_required",
        remainingSubagentCapacity: 0,
        activeSubagents: [],
      },
    },
  ).map((definition) => definition.function.name);
  assert.ok(
    takeoverNames.includes("read_file"),
    "a failed validation child must leave the parent one focused safe-read handoff",
  );
  assert.equal(takeoverNames.includes("replace_in_file"), false);
  assert.equal(
    takeoverNames.includes("spawn_subagent"),
    false,
    "the parent must make direct phase progress before delegation reopens",
  );
});

test("new delegation disappears when the shared lifecycle cannot leave parent takeover runway", () => {
  const now = 1_000_000;
  assert.equal(
    providerTools.runtimeV2SubagentStartHasRunway({
      now,
      lifecycleDeadlineAt:
        now + runtime.RUNTIME_V2_SUBAGENT_MIN_START_REMAINING_MS,
    }),
    true,
  );
  assert.equal(
    providerTools.runtimeV2SubagentStartHasRunway({
      now,
      lifecycleDeadlineAt:
        now + runtime.RUNTIME_V2_SUBAGENT_MIN_START_REMAINING_MS - 1,
    }),
    false,
  );

  const definitions =
    authorization.providerToolDefinitionsForCommand({
      get: () => ({}),
      context: { turnId: "turn-a", runWorkspace: "/fixture" },
      live: { modelContext: [] },
      now: () => now,
      lifecycleDeadlineAt:
        now + runtime.RUNTIME_V2_SUBAGENT_MIN_START_REMAINING_MS - 1,
    }, {
      kind: "request_model",
      phase: "acting",
      payload: {
        mode: "execute",
        collaborationAllowed: true,
        remainingSubagentCapacity: 2,
      },
    });
  assert.equal(
    definitions.some((definition) =>
      definition.function.name === "spawn_subagent"
    ),
    false,
  );
  assert.ok(
    definitions.some((definition) =>
      definition.function.name === "read_file"
    ),
    "near the lifecycle boundary the parent keeps direct safe tools",
  );
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
      modelContext: [],
      childRuns: new Map(),
      childAbortControllers: new Map(),
      childTelemetry: new Map(),
      childReportRequests: new Set(),
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
          task_kind: "review",
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

test("waiting for a child requests report closure and preserves a failed evidence handoff", async () => {
  let resolveChild;
  const childResult = new Promise((resolve) => {
    resolveChild = resolve;
  });
  const job = {
    id: "runtime-v2-child:ms47dtia:82",
    run: {
      sessionKey: "session-a",
      sessionEpoch: "epoch-a",
      turnId: "turn-a",
      runId: "run-a:child:runtime-v2-child:ms47dtia:82",
      parentRunId: "run-a",
      attemptId: "attempt-a:child:runtime-v2-child:ms47dtia:82",
    },
    parentRunId: "run-a",
    scopeKey: "analyze_file_open_flow",
    taskKind: "explore",
    objective: "Trace the file-open handoff.",
    allowedPaths: ["."],
    status: "running",
    requestedAt: 10,
    firstTokenAt: 11,
    closedAt: null,
    summary: null,
  };
  const live = {
    modelContext: [],
    childRuns: new Map([[job.id, childResult]]),
    childAbortControllers: new Map(),
    childTelemetry: new Map([[
      job.id,
      { firstTokenAt: 11, closedAt: null },
    ]]),
    childReportRequests: new Set(),
  };
  let now = 20;
  const port = schedulerPort.createRuntimeV2SchedulerPort({
    get: () => ({}),
    context: {
      turnId: "turn-a",
      runWorkspace: "/fixture",
      phaseLanguage: "zh",
    },
    live,
    nextId: () => "unused",
    now: () => ++now,
    logStoreEvent() {},
  });
  const joining = port.execute({
    command: {
      idempotencyKey: "join-open-flow",
      kind: "join_subagents",
      phase: "observing",
      run: {
        sessionKey: "session-a",
        sessionEpoch: "epoch-a",
        turnId: "turn-a",
        runId: "run-a",
        parentRunId: null,
        attemptId: "attempt-a",
      },
      payload: {
        requestedJobIds: ["analyze_file_open_flow"],
        jobIds: [job.id],
      },
    },
    signal: new AbortController().signal,
    scheduledSubagents: [job],
  });

  await Promise.resolve();
  assert.equal(live.childReportRequests.has(job.id), true);
  resolveChild({
    job,
    status: "failed",
    summary:
      "No structured report; retained one evidence item for parent takeover.",
    report: null,
    evidence: [{
      id: `child:${job.id}:E1`,
      kind: "subagent",
      target: "src/main.js",
      version: "v1",
    }],
    validationReceipts: [],
  });
  const events = await joining;
  const completion = events.find((event) =>
    event.type === "subagent.completed"
  );
  assert.equal(completion.status, "failed");
  assert.equal(completion.evidence[0].target, "src/main.js");
  assert.equal(live.childReportRequests.has(job.id), false);
  assert.equal(live.childRuns.has(job.id), false);
  assert.match(
    live.modelContext.at(-1).content,
    /Status: failed/,
  );
  assert.match(
    live.modelContext.at(-1).content,
    /child:runtime-v2-child:ms47dtia:82:E1/,
  );
});

test("failed mutation calls do not remove an editor class from the parent tool surface", () => {
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
      entry(
        "replace-failed",
        "tool",
        "src/main.js",
        "old text not found",
        "failed",
        "replace_in_file",
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

  let availableNames = names();
  assert.ok(availableNames.includes("read_file"));
  assert.ok(availableNames.includes("replace_in_file"));
  assert.ok(availableNames.includes("apply_patch"));
  live.modelContext.push(entry(
    "main-read-new",
    "tool",
    "src/main.js",
    "const ready = false;",
    "succeeded",
    "read_file",
  ));
  availableNames = names();
  assert.ok(availableNames.includes("read_file"));
  assert.ok(availableNames.includes("replace_in_file"));
  assert.ok(availableNames.includes("apply_patch"));
});

test("a target-less failed editor is correlated to its lease without gaining write authority", () => {
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
    ],
  };
  const ports = {
    get: () => ({}),
    context: { turnId: "turn-a", runWorkspace: "/fixture" },
    live,
  };
  const failureTarget =
    correctivePolicy.runtimeV2MutationFailureContextTarget({
      ports,
      toolName: "replace_in_file",
      requestedTarget: "",
    });
  assert.equal(failureTarget, "src/main.js");

  live.modelContext.push(entry(
    "empty-replace-failed",
    "tool",
    failureTarget,
    "TOOL_BLOCKED: mutation arguments did not resolve a target",
    "blocked",
    "replace_in_file",
  ));
  const names = authorization.providerToolDefinitionsForCommand(ports, {
    kind: "request_model",
    phase: "acting",
    payload: {
      mode: "execute",
      executePolicy: "mutation_required",
    },
  }).map((definition) => definition.function.name);
  assert.ok(names.includes("replace_in_file"));
  assert.ok(names.includes("apply_patch"));

  const authorizationResult =
    authorization.validateToolAgainstPhaseAndPlan({
      ports,
      command: {
        kind: "execute_tool",
        phase: "acting",
      },
      toolName: "replace_in_file",
      args: {},
      target: "",
    });
  assert.equal(authorizationResult.allowed, false);
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

test("Runtime v2 validation guidance never invents acceptance from workspace manifests", () => {
  const input = {
    get: () => ({}),
    context: { turnId: "turn-a" },
    live: { workspaceOverview: "package.json\npnpm-lock.yaml" },
  };
  assert.equal(
    context.preferredFiniteValidationCommand(input),
    "",
  );
  assert.equal(
    context.preferredFiniteValidationCommand({
      ...input,
      live: {
        workspaceOverview:
          "package.json\npackage-lock.json\nsrc-tauri/Cargo.toml",
      },
    }),
    "",
  );
});

test("browser validation passes only when its structured primitive has matching causal evidence", () => {
  const primitive = {
    id: "validation-open-clean",
    kind: "browser_interaction",
    acceptance: "required",
    description: "Opening a file must not show a save dialog.",
    actions: [{
      id: "open-file",
      kind: "click",
      target: "#open-file",
    }],
    assertions: [{
      kind: "dialog",
      target: "save-dialog",
      afterActionId: "open-file",
      expected: "hidden",
    }],
    requireCausalAssertion: true,
  };
  const matching = JSON.stringify({
    success: true,
    actions: [{
      id: "open-file",
      kind: "click",
      target: "#open-file",
      success: true,
    }],
    assertions: [{
      kind: "dialog",
      target: "save-dialog",
      afterActionId: "open-file",
      actual: "hidden",
      passed: true,
      beforePassed: false,
      changedAfterAction: true,
      causallyLinked: true,
    }],
    pageErrors: [],
    consoleErrors: [],
  });
  assert.equal(
    evidence.isRuntimeV2ValidationPassed(
      "browser_evaluate",
      matching,
      primitive,
    ),
    true,
  );
  assert.equal(
    evidence.isRuntimeV2ValidationPassed(
      "browser_evaluate",
      JSON.stringify({
        success: true,
        actions: [{
          id: "open-file",
          kind: "click",
          target: "#different-control",
          success: true,
        }],
        assertions: [{
          kind: "dialog",
          target: "save-dialog",
          afterActionId: "open-file",
          actual: "hidden",
          passed: true,
          causallyLinked: true,
        }],
      }),
      primitive,
    ),
    false,
  );
  assert.equal(
    evidence.isRuntimeV2ValidationPassed(
      "browser_evaluate",
      JSON.stringify({ success: true }),
    ),
    false,
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

test("Runtime v2 owns only the evidence-refresh action, not acceptance selection", () => {
  const run = {
    sessionKey: "session-a",
    sessionEpoch: "epoch-a",
    turnId: "turn-a",
    runId: "run-a",
    parentRunId: null,
    attemptId: "attempt-a",
  };
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

test("Runtime v2 directly acquires a required contract source without another model choice", () => {
  const run = {
    sessionKey: "session-a",
    sessionEpoch: "epoch-a",
    turnId: "turn-a",
    runId: "run-a",
    parentRunId: null,
    attemptId: "attempt-a",
  };
  const required = deterministicActions.selectRuntimeOwnedRequiredSourceAction({
    command: {
      idempotencyKey: "required-source-a",
      kind: "request_model",
      run,
      phase: "observing",
      payload: {
        mode: "observe",
        requiredExecutionContractSourceTarget: "src/main.js",
      },
    },
    allowedToolNames: ["read_file"],
    target: "src/main.js",
  });
  assert.deepEqual(required.toolCalls, [{
    id: "runtime-required-source:required-source-a",
    name: "read_file",
    arguments: { path: "src/main.js" },
  }]);
  assert.equal(
    required.diagnostics[0].code,
    "runtime_owned_required_source",
  );
});
