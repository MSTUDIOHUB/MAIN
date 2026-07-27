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
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    fileName: normalized,
  }).outputText;
  const module = { exports: {} };
  cache.set(normalized, module.exports);
  const runtimeRequire = (specifier) => {
    if (specifier.startsWith(".")) {
      const base = path.resolve(path.dirname(normalized), specifier);
      for (const candidate of [base, `${base}.ts`, path.join(base, "index.ts")]) {
        if (fs.existsSync(candidate) && candidate.endsWith(".ts")) return loadTs(candidate);
      }
    }
    return localRequire(specifier);
  };
  new Function("exports", "module", "require", output)(module.exports, module, runtimeRequire);
  cache.set(normalized, module.exports);
  return module.exports;
}

function loadTsWithMocks(sourcePath, mocks, scopedCache = new Map()) {
  const normalized = path.resolve(sourcePath);
  if (scopedCache.has(normalized)) return scopedCache.get(normalized);
  const source = fs.readFileSync(normalized, "utf8");
  const localRequire = createRequire(normalized);
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    fileName: normalized,
  }).outputText;
  const module = { exports: {} };
  scopedCache.set(normalized, module.exports);
  const runtimeRequire = (specifier) => {
    if (mocks.has(specifier)) return mocks.get(specifier);
    if (specifier.startsWith(".")) {
      const base = path.resolve(path.dirname(normalized), specifier);
      for (const candidate of [base, `${base}.ts`, path.join(base, "index.ts")]) {
        if (fs.existsSync(candidate) && candidate.endsWith(".ts")) {
          return loadTsWithMocks(candidate, mocks, scopedCache);
        }
      }
    }
    return localRequire(specifier);
  };
  new Function("exports", "module", "require", output)(module.exports, module, runtimeRequire);
  scopedCache.set(normalized, module.exports);
  return module.exports;
}

const runtime = loadTs(path.join(workspaceRoot, "src/lib/runtime-v2/index.ts"));
const adapter = loadTs(path.join(workspaceRoot, "src/store/runtimeV2/workPlanAdapter.ts"));
const approval = loadTs(path.join(workspaceRoot, "src/store/runtimeV2/planApproval.ts"));
const handoff = loadTs(path.join(workspaceRoot, "src/store/runtimeV2/planHandoff.ts"));
const engineSelection = loadTs(path.join(workspaceRoot, "src/lib/runtimeEngineSelection.ts"));
const runIntent = loadTs(path.join(workspaceRoot, "src/lib/runIntent.ts"));

const turn = {
  workspaceKey: "/fixture",
  sessionKey: "session-a",
  sessionEpoch: "epoch-a",
  clientSubmissionId: "submission-a",
  turnId: "turn-a",
};
const run = {
  sessionKey: "session-a",
  sessionEpoch: "epoch-a",
  turnId: "turn-a",
  runId: "review-run-a",
  parentRunId: null,
  attemptId: "review-run-a",
};

function plan() {
  return runtime.sealWorkPlanV1({
    draft: {
      schemaVersion: runtime.WORK_PLAN_V1_SCHEMA_VERSION,
      objective: "修复文件打开与标签显示",
      summary: "统一文件打开入口和保存路径判断。",
      findings: [{ statement: "已确认两个入口竞争创建标签。", basis: ["E1"] }],
      steps: [{
        title: "统一标签生命周期",
        operation: "modify",
        targets: ["src/main.js"],
        basis: ["E1"],
        change: "打开文件时替换空白初始标签。",
        expectedOutcome: "只显示当前文件标签。",
        dependsOn: [],
      }],
      validations: [{
        stepIndexes: [0],
        kind: "finite_command",
        command: "npm run build",
        expectedOutcome: "构建通过。",
        required: true,
      }],
      risks: [],
      assumptions: [],
      blockingQuestions: [],
    },
    evidence: [{
      id: "E1",
      target: "src/main.js",
      version: "sha-source",
      statement: "两个入口创建标签。",
    }],
    id: "WP-production",
    revision: 2,
    createdAt: 10,
  });
}

function event(sequence, at, value) {
  return {
    schemaVersion: runtime.RUNTIME_V2_EVENT_SCHEMA_VERSION,
    sequence,
    eventId: `event-${sequence}`,
    at,
    ...value,
  };
}

function reviewCheckpoint() {
  const sealed = plan();
  const commit = adapter.createRuntimeV2PlanReviewCommit({
    plan: sealed,
    turn,
    run,
    requestId: "review-request-a",
    createdAt: 20,
  });
  let checkpoint = null;
  const append = (value) => {
    const result = runtime.appendRuntimeV2Checkpoint({
      checkpoint,
      owner: turn,
      expectedRevision: checkpoint?.revision || 0,
      event: value,
    });
    assert.equal(result.disposition, "committed");
    checkpoint = result.checkpoint;
  };
  append(event(0, 10, {
    type: "turn.admitted",
    turn,
    strategy: "plan",
    objective: sealed.draft.objective,
    constraints: [],
    acceptanceCriteria: [],
  }));
  append(event(1, 11, { type: "run.started", run, phase: "planning" }));
  append(event(2, 20, {
    type: "work_plan.sealed",
    run,
    workPlan: adapter.toRuntimeV2WorkPlanReference(sealed),
    sealedPlan: sealed,
    reviewCommit: commit,
  }));
  return { checkpoint, sealed, commit };
}

function actionRequest(commit, overrides = {}) {
  return {
    schemaVersion: 1,
    requestId: commit.review.requestId,
    kind: "plan_review",
    sessionKey: commit.review.sessionKey,
    sessionEpoch: commit.review.sessionEpoch,
    turnId: commit.review.turnId,
    runId: commit.review.runId,
    parentRunId: commit.review.parentRunId,
    title: "Review",
    status: "pending",
    createdAt: commit.review.createdAt,
    planRevision: commit.authority.revision,
    artifactHash: commit.authority.projectionHash,
    artifactPaths: [commit.artifact.path],
    ...overrides,
  };
}

async function runProductionPlanScenario(streamCompletion, toolExecution) {
  let taskId = 0;
  let state = {
    conversationTurns: [{
      id: turn.turnId,
      clientSubmissionId: turn.clientSubmissionId,
      userPrompt: "修复文件打开与标签显示",
      status: "running",
      blockIds: [],
    }],
    config: { language: "zh" },
    planLifecycle: {
      sessionKey: turn.sessionKey,
      sessionEpoch: turn.sessionEpoch,
    },
    runtimeV2Checkpoints: {},
    runtimeEvents: [],
    taskFlow: [],
    harnessRunMarker: {
      sessionKey: turn.sessionKey,
      turnId: turn.turnId,
      runId: run.runId,
      status: "running",
    },
    _nextTaskId() {
      taskId += 1;
      return taskId;
    },
  };
  const get = () => state;
  const set = (patchOrUpdater) => {
    const patch = typeof patchOrUpdater === "function"
      ? patchOrUpdater(state)
      : patchOrUpdater;
    state = { ...state, ...(patch || {}) };
  };
  const checkpointPort = {
    getRuntimeV2Checkpoint(current, owner) {
      return current.runtimeV2Checkpoints?.[owner.turnId] || null;
    },
    createRuntimeV2CheckpointPort() {
      return {
        async load({ owner }) {
          return state.runtimeV2Checkpoints?.[owner.turnId] || null;
        },
        async append(input) {
          const current = state.runtimeV2Checkpoints?.[input.owner.turnId] || null;
          const result = runtime.appendRuntimeV2Checkpoint({
            checkpoint: current,
            owner: input.owner,
            expectedRevision: input.expectedRevision,
            event: input.event,
          });
          if (result.checkpoint) {
            state = {
              ...state,
              runtimeV2Checkpoints: {
                ...state.runtimeV2Checkpoints,
                [input.owner.turnId]: result.checkpoint,
              },
            };
          }
          return result;
        },
      };
    },
  };
  const mocks = new Map([
    ["../../lib/providerLaneSettings", { deriveStreamSettings: () => ({}) }],
    ["../../lib/toolTarget", {
      getToolTarget: (_name, args) => String(args.path || args.query || ""),
    }],
    ["../../lib/streaming", { streamChatCompletion: streamCompletion }],
    ["../../lib/toolExecutor", { executeTool: toolExecution }],
    ["../../lib/toolSchemas", {
      TOOL_DEFINITIONS: [{
        type: "function",
        function: {
          name: "read_file",
          description: "Read one source window.",
          parameters: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
          },
        },
      }],
    }],
    ["../../lib/runtime-v2", runtime],
    ["./checkpointPort", checkpointPort],
    ["./projectionPort", {
      createRuntimeV2ProjectionPort: () => ({ async publish() {} }),
    }],
    ["./workPlanAdapter", adapter],
  ]);
  const planRunner = loadTsWithMocks(
    path.join(workspaceRoot, "src/store/runtimeV2/planRunner.ts"),
    mocks,
  );
  const abortCtrl = new AbortController();
  const settlement = await planRunner.runSubmitRuntimeV2Plan({
    get,
    set,
    context: {
      turnId: turn.turnId,
      runSessionKey: turn.sessionKey,
      harnessRunId: run.runId,
      runWorkspace: turn.workspaceKey,
      runScopeKey: turn.workspaceKey,
      runSessionId: 1,
      phaseLanguage: "zh",
      abortCtrl,
      timerInterval: undefined,
    },
    getSessionRevisionToken: () => 1,
    sanitizeTaskBlocksForPersist: (blocks) => blocks,
    normalizeSessionRuntimeSnapshot: (snapshot) => snapshot,
    publishOwnerScopedRuntimeProjection: () => ({
      published: true,
      disposition: "published",
    }),
    persistSessionRecord: async () => undefined,
    logStoreEvent: () => undefined,
  });
  return {
    settlement,
    state,
    checkpoint: state.runtimeV2Checkpoints[turn.turnId],
  };
}

test("Plan admission selects Runtime v2 and the production runner owns the Plan route", () => {
  assert.equal(engineSelection.selectRuntimeEngineVersionForNewTurn("plan"), "v2");
  assert.equal(engineSelection.selectRuntimeEngineVersionForNewTurn("execute"), "v2");
  for (const intent of ["respond", "discuss", "analyze", "summarize", "report"]) {
    assert.equal(engineSelection.selectRuntimeEngineVersionForNewTurn(intent), "v2");
    assert.equal(engineSelection.isRuntimeV2GlobalChatTurn(intent, undefined), true);
    assert.equal(engineSelection.isRuntimeV2GlobalChatTurn(intent, "/workspace"), false);
    assert.equal(engineSelection.isRuntimeV2WorkspaceReadTurn(intent, "/workspace"), true);
  }
  assert.equal(engineSelection.selectRuntimeEngineVersionForNewTurn("goal"), "v2");
  assert.equal(engineSelection.selectRuntimeEngineVersionForNewTurn("studio_workflow"), "v2");
  assert.equal(runIntent.resolveWorkspaceAwareWorkflowMode("chat", false), "chat");
  assert.equal(runIntent.resolveWorkspaceAwareWorkflowMode("chat", true), "edit");
  assert.equal(runIntent.resolveWorkspaceAwareWorkflowMode("plan", true), "plan");
  assert.equal(engineSelection.resolveRuntimeV2VisibleRunnerKind({
    effectiveIntent: "respond",
    runtimeIntent: "respond",
    runWorkspace: undefined,
  }), "chat");
  assert.equal(engineSelection.resolveRuntimeV2VisibleRunnerKind({
    effectiveIntent: "respond",
    runtimeIntent: "respond",
    runWorkspace: "/workspace",
  }), "workspace_read");
  assert.equal(engineSelection.resolveRuntimeV2VisibleRunnerKind({
    effectiveIntent: "execute",
    runtimeIntent: "execute",
    runWorkspace: "/workspace",
  }), "execute");
  assert.equal(engineSelection.resolveRuntimeV2VisibleRunnerKind({
    effectiveIntent: "respond",
    runtimeIntent: "execute",
    runWorkspace: "/workspace",
  }), "execute");
  assert.equal(engineSelection.resolveRuntimeV2VisibleRunnerKind({
    effectiveIntent: "execute",
    runtimeIntent: "goal",
    runWorkspace: "/workspace",
  }), "goal");
  assert.equal(engineSelection.resolveRuntimeV2VisibleRunnerKind({
    effectiveIntent: "studio_workflow",
    runtimeIntent: "studio_workflow",
    runWorkspace: "/workspace",
  }), "studio");

  const app = fs.readFileSync(
    path.join(workspaceRoot, "src/App.tsx"),
    "utf8",
  );
  assert.match(app, /setWorkflowMode\(isGlobalChat \? "chat" : "edit"\)/);
  assert.match(
    app,
    /activeScopeKey === GLOBAL_CHAT_KEY[\s\S]{0,160}resolveWorkspaceAwareWorkflowMode\(state\.config\.workflowMode, true\)/,
  );
  assert.match(
    app,
    /setCurrentWorkspace\(stablePath\);[\s\S]{0,160}resetToEmptyChatView\(\);[\s\S]{0,160}hydrateWorkspacePlanForEmptySession\("workspace_open_empty"\)/,
  );
  const store = fs.readFileSync(
    path.join(workspaceRoot, "src/store/useAppStore.ts"),
    "utf8",
  );
  assert.match(
    store,
    /setCurrentWorkspace:[\s\S]*?workflowMode:\s*"chat"[\s\S]*?workflowMode:\s*resolveWorkspaceAwareWorkflowMode\([\s\S]*?s\.config\.workflowMode,[\s\S]*?true/,
  );
  assert.match(
    store,
    /setWorkflowMode:\s*\(mode\)\s*=>[\s\S]*?resolveWorkspaceAwareWorkflowMode\([\s\S]*?mode,[\s\S]*?s\.currentWorkspace/,
  );
  const configSlice = fs.readFileSync(
    path.join(workspaceRoot, "src/store/slices/configSlice.ts"),
    "utf8",
  );
  assert.match(
    configSlice,
    /workflowMode:\s*resolveWorkspaceAwareWorkflowMode\([\s\S]*?nextConfig\.workflowMode,[\s\S]*?s\.currentWorkspace/,
  );

  const runner = fs.readFileSync(
    path.join(workspaceRoot, "src/store/submitRuntimeRunner.ts"),
    "utf8",
  );
  assert.match(runner, /resolveRuntimeV2VisibleRunnerKind/);
  assert.doesNotMatch(runner, /canRunRuntimeV2Plan/);
  assert.match(runner, /runSubmitRuntimeV2Plan/);
  assert.match(runner, /runSubmitRuntimeV2Goal/);
  assert.match(runner, /runSubmitRuntimeV2WorkspaceRead/);
  assert.match(runner, /runtimeV2RunnerKind === "workspace_read"/);
  assert.doesNotMatch(runner, /\bnew WorkflowEngine\b|orchestrator\/workflowEngine/);

  const planRunner = fs.readFileSync(
    path.join(workspaceRoot, "src/store/runtimeV2/planRunner.ts"),
    "utf8",
  );
  assert.doesNotMatch(planRunner, /\bPlanArtifact\b|planMaterialization|extractPlan|parsePlan/);
  assert.match(planRunner, /createRuntimeV2PlanReviewCommit/);
  assert.match(planRunner, /content: input\.plan\.markdown/);
  assert.match(planRunner, /reviewCommit: commit/);
  assert.match(planRunner, /markdown: input\.commit\.chat\.markdown/);
  assert.doesNotMatch(planRunner, /plan:soft-round-limit|PLAN_MODEL_ROUND_LIMIT/);
  assert.match(planRunner, /runtime_v2_plan_soft_round_signal/);
  assert.match(planRunner, /terminal:\s*false/);
  assert.match(planRunner, /PLAN_MODEL_DEADLINE_MS/);
});

test("production Plan runner seals one plan, writes its exact projection and pauses for review", async () => {
  const draft = plan().draft;
  const reviewedDraft = {
    ...draft,
    findings: draft.findings.map((finding) => ({
      ...finding,
      basis: ["E2"],
    })),
    steps: draft.steps.map((step) => ({
      ...step,
      basis: ["E2"],
    })),
  };
  let writtenPlan = null;
  let providerRound = 0;
  let finalAuditRequest = null;
  const result = await runProductionPlanScenario(
    async (messages, _settings, _callbacks, _signal, tools) => {
      providerRound += 1;
      const offeredNames = tools.map((definition) => definition.function.name);
      if (
        providerRound === 1 ||
        (offeredNames.length === 1 && offeredNames[0] === "read_file")
      ) {
        return {
          content: "",
          toolCalls: [{
            id: `read-source-${providerRound}`,
            name: "read_file",
            arguments: JSON.stringify({ path: "src/main.js" }),
          }],
          usage: {},
          protocolViolation: null,
        };
      }
      if (providerRound === 2) {
        return {
          content: "",
          toolCalls: [{
            id: "reject-protocol-markup",
            name: "submit_runtime_v2_work_plan",
            arguments: JSON.stringify({
              planMarkdown: "让我用 <tool_call>read_file</tool_call> 后再计划。",
              changes: reviewedDraft.steps,
              validations: reviewedDraft.validations,
            }),
          }],
          usage: {},
          protocolViolation: null,
        };
      }
      if (offeredNames.length === 1 && offeredNames[0] === "submit_runtime_v2_work_plan") {
        finalAuditRequest = messages;
      }
      return {
        content: "",
        toolCalls: [{
          id: "submit-plan",
          name: "submit_runtime_v2_work_plan",
          arguments: JSON.stringify({
            schemaVersion: reviewedDraft.schemaVersion,
            objective: reviewedDraft.objective,
            summary: reviewedDraft.summary,
            findingsJson: JSON.stringify(reviewedDraft.findings),
            stepsJson: JSON.stringify(reviewedDraft.steps),
            validationsJson: JSON.stringify(reviewedDraft.validations),
            risksJson: JSON.stringify(reviewedDraft.risks),
            assumptionsJson: JSON.stringify(reviewedDraft.assumptions),
            blockingQuestionsJson: JSON.stringify(reviewedDraft.blockingQuestions),
          }),
        }],
        usage: {},
        protocolViolation: null,
      };
    },
    async (name, args) => {
      if (name === "get_project_skeleton") return "src/main.js";
      if (name === "read_file") return "const openFile = true;";
      if (name === "write_file") {
        writtenPlan = String(args.content || "");
        return "written";
      }
      throw new Error(`unexpected tool ${name}`);
    },
  );
  assert.equal(providerRound, 7);
  assert.equal(result.settlement.outcome.status, "paused");
  assert.equal(result.checkpoint.aggregate.phase, "reviewing");
  assert.equal(
    result.checkpoint.aggregate.events.filter((event) =>
      event.type === "work_plan.sealed"
    ).length,
    1,
  );
  const resolved = adapter.resolveRuntimeV2PlanReviewFromAggregate(
    result.checkpoint.aggregate,
  );
  assert.ok(resolved?.pending);
  assert.equal(writtenPlan, resolved.plan.markdown);
  assert.equal(resolved.commit.artifact.content, writtenPlan);
  assert.ok(result.checkpoint.aggregate.events.some((event) =>
    event.type === "projection.published" &&
    event.audience === "capsule_live"
  ));
  const finalAuditText = finalAuditRequest
    .map((message) => String(message.content || ""))
    .join("\n");
  assert.match(finalAuditText, /mandatory evidence audit/);
  assert.doesNotMatch(
    finalAuditText,
    /Correct the rejected WorkPlan structure/,
    "an older rejected submission must not replace the current draft audit",
  );
  assert.doesNotMatch(
    finalAuditText,
    /统一文件打开路径并验证/,
    "the final audit must reconstruct from evidence instead of anchoring on the first draft",
  );
});

test("Plan discovery has a bounded action window and then exposes only the minimal plan submission", async () => {
  const reviewedDraft = {
    ...plan().draft,
    findings: plan().draft.findings.map((finding) => ({
      ...finding,
      basis: ["unknown-model-evidence"],
    })),
    steps: plan().draft.steps.map((step) => ({
      ...step,
      basis: [],
    })),
    validations: plan().draft.validations.map((validation) => ({
      ...validation,
      stepIndexes: [1],
    })),
  };
  let providerRound = 0;
  let synthesisRequest = null;
  let finalAuditRequest = null;
  let auditRequest = null;
  const result = await runProductionPlanScenario(
    async (messages, _settings, _callbacks, _signal, tools, _metadata, options) => {
      providerRound += 1;
      if (providerRound <= 8) {
        const sourcePath = [
          "src/main.js",
          "./src/main.js",
          "/fixture/src/main.js",
        ][providerRound % 3];
        return {
          content: "",
          toolCalls: [{
            id: `repeat-read-${providerRound}`,
            name: "read_file",
            arguments: JSON.stringify({
              path: sourcePath,
              start_line: providerRound,
              max_lines: 1,
            }),
          }],
          usage: {},
          protocolViolation: null,
        };
      }
      const offeredNames = tools.map((definition) => definition.function.name);
      if (offeredNames.length === 1 && offeredNames[0] === "read_file") {
        auditRequest ||= { messages, tools, options };
        return {
          content: "",
          toolCalls: [{
            id: `audit-read-${providerRound}`,
            name: "read_file",
            arguments: JSON.stringify({
              path: "src/main.js",
              start_line: providerRound,
              max_lines: 1,
            }),
          }],
          usage: {},
          protocolViolation: null,
        };
      }
      synthesisRequest ||= { messages, tools, options };
      finalAuditRequest = { messages, tools, options };
      return {
        content: "",
        toolCalls: [{
          id: "submit-after-discovery-boundary",
          name: "submit_runtime_v2_work_plan",
          arguments: JSON.stringify({
            planMarkdown: [
              "根因位于文件打开状态的所有权。",
              "",
              "保持现有 UI 边界，只修复状态切换。",
            ].join("\n"),
            changes: JSON.stringify(reviewedDraft.steps.map((step) => ({
              title: step.title,
              operation: step.operation,
              targets: step.targets,
              change: step.change,
              expectedOutcome: step.expectedOutcome,
            }))),
            validations: JSON.stringify(reviewedDraft.validations.map((validation) => ({
              kind: validation.kind,
              command: validation.command,
              cwd: validation.cwd,
              expectedOutcome: validation.expectedOutcome,
              required: validation.required,
            }))),
          }),
        }],
        usage: {},
        protocolViolation: null,
      };
    },
    async (name, args) => {
      if (name === "get_project_skeleton") return "src/main.js";
      if (name === "read_file") {
        return args.__raw
          ? "const openFile = true;\nconst saveFile = true;"
          : `window-${args.start_line}`;
      }
      if (name === "write_file") return "written";
      throw new Error(`unexpected tool ${name}`);
    },
  );

  assert.equal(providerRound, 13);
  assert.equal(result.checkpoint.aggregate.phase, "reviewing");
  assert.deepEqual(
    auditRequest.tools.map((definition) => definition.function.name),
    ["read_file"],
  );
  assert.equal(auditRequest.options.toolChoice, "required");
  assert.match(
    auditRequest.messages.map((message) => String(message.content || "")).join("\n"),
    /bounded audit-discovery pass/,
  );
  assert.deepEqual(
    synthesisRequest.tools.map((definition) => definition.function.name),
    ["submit_runtime_v2_work_plan"],
  );
  assert.deepEqual(
    synthesisRequest.tools[0].function.parameters.required,
    ["planMarkdown", "changes", "validations"],
  );
  assert.equal(
    synthesisRequest.tools[0].function.parameters.properties.findingsJson,
    undefined,
  );
  assert.deepEqual(synthesisRequest.options.toolChoice, {
    type: "function",
    function: { name: "submit_runtime_v2_work_plan" },
  });
  assert.match(
    synthesisRequest.messages.map((message) => String(message.content || "")).join("\n"),
    /read-only discovery window is closed/,
  );
  assert.match(
    finalAuditRequest.messages.map((message) => String(message.content || "")).join("\n"),
    /mandatory evidence audit/,
  );
  assert.doesNotMatch(
    finalAuditRequest.messages.map((message) => String(message.content || "")).join("\n"),
    /根因位于文件打开状态的所有权/,
  );
  assert.match(String(synthesisRequest.messages[0]?.content || ""), /MAIN RUNTIME V2 PLAN/);
  assert.equal(
    result.checkpoint.aggregate.evidence.filter((entry) =>
      entry.kind === "source" && entry.target === "src/main.js"
    ).length,
    1,
  );
  const synthesisText = finalAuditRequest.messages
    .map((message) => String(message.content || ""))
    .join("\n");
  assert.equal(
    (synthesisText.match(/E2 · (?:\.\/|\/fixture\/)?src\/main\.js · sha256-/g) || []).length,
    1,
    "path aliases for one unchanged file must not duplicate the synthesis evidence index",
  );
  assert.match(
    synthesisText,
    /window-8/,
    "later windows of the same source version must remain available to synthesis",
  );
});

test("a closed synthesis request gets one compact sequential recovery without overlap", async () => {
  let providerRound = 0;
  let activeRequests = 0;
  let maxActiveRequests = 0;
  const synthesisRequests = [];
  const submission = JSON.stringify({
    planMarkdown: "根因位于文件打开状态的所有权；修改保持现有工具边界。",
    changes: [{
      title: "统一标签生命周期",
      operation: "modify",
      targets: ["src/main.js"],
      change: "打开文件时替换仍为空白且未修改的初始标签。",
      expectedOutcome: "只显示当前文件标签。",
    }],
    validations: [{
      kind: "finite_command",
      command: "npm run build",
      cwd: "/fixture",
      expectedOutcome: "构建通过。",
      required: true,
    }],
  });
  const result = await runProductionPlanScenario(
    async (messages, _settings, _callbacks, _signal, tools, maxTokens, options) => {
      activeRequests += 1;
      maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
      try {
        providerRound += 1;
        if (providerRound <= 8) {
          const sourcePath = providerRound === 1
            ? "src/main.js"
            : `src/helper-${providerRound}.js`;
          return {
            content: "",
            toolCalls: [{
              id: `read-before-timeout-${providerRound}`,
              name: "read_file",
              arguments: JSON.stringify({ path: sourcePath }),
            }],
            usage: {},
            protocolViolation: null,
          };
        }
        const offeredNames = tools.map((definition) => definition.function.name);
        if (offeredNames.length === 1 && offeredNames[0] === "read_file") {
          return {
            content: "",
            toolCalls: [{
              id: `audit-read-after-recovery-${providerRound}`,
              name: "read_file",
              arguments: JSON.stringify({
                path: "src/main.js",
                start_line: providerRound,
                max_lines: 1,
              }),
            }],
            usage: {},
            protocolViolation: null,
          };
        }
        synthesisRequests.push({ messages, maxTokens, options });
        if (providerRound === 9) {
          throw new Error(
            "STREAM_NO_VISIBLE_PROGRESS_TIMEOUT: model stream produced keepalive chunks without a semantic action",
          );
        }
        return {
          content: "",
          toolCalls: [{
            id: `submit-after-recovery-${providerRound}`,
            name: "submit_runtime_v2_work_plan",
            arguments: submission,
          }],
          usage: {},
          protocolViolation: null,
        };
      } finally {
        activeRequests -= 1;
      }
    },
    async (name, args) => {
      if (name === "get_project_skeleton") return "src/main.js";
      if (name === "read_file") {
        return args.__raw
          ? `const source = ${JSON.stringify(String(args.path || ""))};\n${"x".repeat(5_000)}`
          : `${String(args.path || "")}:${String(args.start_line || 1)}\n${"x".repeat(5_000)}`;
      }
      if (name === "write_file") return "written";
      throw new Error(`unexpected tool ${name}`);
    },
  );

  assert.equal(providerRound, 14);
  assert.equal(maxActiveRequests, 1);
  assert.equal(result.settlement.outcome.status, "paused");
  assert.equal(result.checkpoint.aggregate.phase, "reviewing");
  assert.equal(result.checkpoint.aggregate.scheduledCommands.length, 0);
  assert.equal(synthesisRequests.length, 3);
  assert.equal(synthesisRequests[0].maxTokens, undefined);
  assert.equal(synthesisRequests[1].maxTokens, 4_096);
  assert.equal(synthesisRequests[2].maxTokens, undefined);
  assert.ok(
    synthesisRequests[1].messages.reduce(
      (total, message) => total + String(message.content || "").length,
      0,
    ) <
    synthesisRequests[0].messages.reduce(
      (total, message) => total + String(message.content || "").length,
      0,
    ),
  );
  assert.match(
    synthesisRequests[1].messages
      .map((message) => String(message.content || ""))
      .join("\n"),
    /single bounded recovery request/,
  );
  assert.equal(result.checkpoint.aggregate.recovery.transportAttempts, 1);
});

test("two synthesis timeouts close exactly once after the bounded sequential recovery", async () => {
  let providerRound = 0;
  let activeRequests = 0;
  let maxActiveRequests = 0;
  const result = await runProductionPlanScenario(
    async () => {
      activeRequests += 1;
      maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
      try {
        providerRound += 1;
        if (providerRound <= 8) {
          return {
            content: "",
            toolCalls: [{
              id: `read-before-double-timeout-${providerRound}`,
              name: "read_file",
              arguments: JSON.stringify({ path: "src/main.js" }),
            }],
            usage: {},
            protocolViolation: null,
          };
        }
        throw new Error(
          "STREAM_NO_VISIBLE_PROGRESS_TIMEOUT: model stream produced keepalive chunks without a semantic action",
        );
      } finally {
        activeRequests -= 1;
      }
    },
    async (name) => {
      if (name === "get_project_skeleton") return "src/main.js";
      if (name === "read_file") return "const openFile = true;";
      throw new Error(`unexpected tool ${name}`);
    },
  );

  assert.equal(providerRound, 10);
  assert.equal(maxActiveRequests, 1);
  assert.equal(result.settlement.outcome.status, "completed");
  assert.equal(result.settlement.outcome.resultKind, "partial");
  assert.equal(result.checkpoint.aggregate.phase, "completed");
  assert.equal(result.checkpoint.aggregate.scheduledCommands.length, 0);
  assert.equal(result.checkpoint.aggregate.terminalOutcome?.resultKind, "partial");
  assert.equal(
    result.checkpoint.aggregate.events.filter((event) =>
      event.type === "run.completed"
    ).length,
    1,
  );
});

test("production Plan runner closes repeated no-action responses exactly once", async () => {
  const result = await runProductionPlanScenario(
    async () => ({
      content: "仍在分析",
      toolCalls: [],
      usage: {},
      protocolViolation: null,
    }),
    async (name) => {
      if (name === "get_project_skeleton") return "src/main.js";
      throw new Error(`unexpected tool ${name}`);
    },
  );
  const aggregate = result.checkpoint.aggregate;
  assert.equal(result.settlement.outcome.status, "completed");
  assert.equal(result.settlement.outcome.resultKind, "partial");
  assert.equal(aggregate.phase, "completed");
  assert.equal(aggregate.scheduledCommands.length, 0);
  assert.equal(aggregate.workPlan, null);
  assert.ok(aggregate.recovery.exhausted);
  assert.equal(
    aggregate.events.filter((event) => event.type === "run.completed").length,
    1,
  );
  assert.equal(
    aggregate.events.filter((event) => event.type === "turn.completed").length,
    1,
  );
  assert.equal(
    aggregate.events.filter((event) =>
      event.type === "projection.published" && event.audience === "final"
    ).length,
    1,
  );
});

test("one sealed WorkPlan and ReviewCommit survive checkpoint cold recovery", () => {
  const { checkpoint, sealed, commit } = reviewCheckpoint();
  const restored = runtime.normalizeRuntimeV2Checkpoint(
    JSON.parse(JSON.stringify(checkpoint)),
    turn,
  );
  assert.ok(restored);
  assert.deepEqual(restored.aggregate.sealedWorkPlan, sealed);
  assert.deepEqual(restored.aggregate.planReviewCommit, commit);
  const resolved = adapter.resolveRuntimeV2PlanReviewFromAggregate(restored.aggregate);
  assert.equal(resolved?.pending, true);
  assert.equal(resolved?.commit.artifact.content, sealed.markdown);
  assert.equal(resolved?.commit.panel.markdown, sealed.markdown);
});

test("approval appends to the same v2 checkpoint only for the exact owner, request and authority", async () => {
  const { checkpoint, commit } = reviewCheckpoint();
  let current = checkpoint;
  let appendCount = 0;
  const port = {
    async load() {
      return current;
    },
    async append(input) {
      appendCount += 1;
      const result = runtime.appendRuntimeV2Checkpoint({
        checkpoint: current,
        owner: input.owner,
        expectedRevision: input.expectedRevision,
        event: input.event,
      });
      if (result.checkpoint) current = result.checkpoint;
      return result;
    },
  };
  const request = actionRequest(commit);
  const result = await approval.approveRuntimeV2PlanReviewCheckpoint({
    checkpoint,
    port,
    request,
    expected: request,
    now: 30,
    eventId: "approved-event",
  });
  assert.equal(result.ok, true);
  assert.equal(appendCount, 1);
  assert.equal(result.checkpoint.aggregate.phase, "acting");
  assert.equal(result.checkpoint.aggregate.workPlan.status, "approved");
  const approved = adapter.resolveApprovedRuntimeV2WorkPlanFromAggregate(
    result.checkpoint.aggregate,
  );
  assert.equal(approved?.plan.id, commit.authority.id);
  assert.deepEqual(approved?.commit, commit);

  for (const altered of [
    actionRequest(commit, { requestId: "stale-request" }),
    actionRequest(commit, { sessionKey: "session-b" }),
    actionRequest(commit, { sessionEpoch: "epoch-b" }),
    actionRequest(commit, { runId: "review-run-b" }),
    actionRequest(commit, { parentRunId: "wrong-parent" }),
    actionRequest(commit, { planRevision: commit.authority.revision + 1 }),
    actionRequest(commit, { artifactHash: "wrong-projection" }),
    actionRequest(commit, { artifactPaths: [".MAIN/plans/other.md"] }),
  ]) {
    let called = false;
    const rejected = await approval.approveRuntimeV2PlanReviewCheckpoint({
      checkpoint,
      port: {
        async load() { return checkpoint; },
        async append() {
          called = true;
          throw new Error("must not append");
        },
      },
      request: altered,
      expected: altered,
      now: 30,
      eventId: "must-not-append",
    });
    assert.equal(rejected.ok, false);
    assert.equal(called, false);
  }

  let ownerAppendCalled = false;
  const wrongOwner = await approval.approveRuntimeV2PlanReviewCheckpoint({
    checkpoint: {
      ...checkpoint,
      owner: { ...checkpoint.owner, sessionEpoch: "epoch-b" },
    },
    port: {
      async load() { return checkpoint; },
      async append() {
        ownerAppendCalled = true;
        throw new Error("must not append");
      },
    },
    request,
    expected: request,
    now: 30,
    eventId: "wrong-owner-must-not-append",
  });
  assert.equal(wrongOwner.ok, false);
  assert.equal(ownerAppendCalled, false);
});

test("tampered persisted projections fail closed instead of becoming review authority", () => {
  const { checkpoint } = reviewCheckpoint();
  const tamperedAggregate = {
    ...checkpoint.aggregate,
    planReviewCommit: {
      ...checkpoint.aggregate.planReviewCommit,
      panel: {
        ...checkpoint.aggregate.planReviewCommit.panel,
        markdown: "# tampered",
      },
    },
  };
  assert.equal(adapter.resolveRuntimeV2PlanReviewFromAggregate(tamperedAggregate), null);
});

test("approval is exactly once under competing callbacks and only one callback may dispatch", async () => {
  const { checkpoint, commit } = reviewCheckpoint();
  let current = checkpoint;
  let committedCount = 0;
  const request = actionRequest(commit);
  const port = {
    async load() {
      return current;
    },
    async append(input) {
      await Promise.resolve();
      const result = runtime.appendRuntimeV2Checkpoint({
        checkpoint: current,
        owner: input.owner,
        expectedRevision: input.expectedRevision,
        event: input.event,
      });
      if (result.disposition === "committed") {
        current = result.checkpoint;
        committedCount += 1;
      }
      return result;
    },
  };
  const inputs = ["approval-race", "approval-race"].map((eventId) =>
    approval.approveRuntimeV2PlanReviewCheckpoint({
      checkpoint,
      port,
      request,
      expected: request,
      now: 30,
      eventId,
    })
  );
  const results = await Promise.all(inputs);
  assert.equal(results.filter((result) => result.ok).length, 1);
  assert.equal(
    results.filter((result) =>
      !result.ok && result.reason === "runtime_v2_plan_already_approved"
    ).length,
    1,
  );
  assert.equal(committedCount, 1);
  assert.equal(current.aggregate.phase, "acting");
});

test("approved execution authority rejects owner, reference and projection tampering", async () => {
  const { checkpoint, commit } = reviewCheckpoint();
  let current = checkpoint;
  const result = await approval.approveRuntimeV2PlanReviewCheckpoint({
    checkpoint,
    port: {
      async load() { return current; },
      async append(input) {
        const appended = runtime.appendRuntimeV2Checkpoint({
          checkpoint: current,
          owner: input.owner,
          expectedRevision: input.expectedRevision,
          event: input.event,
        });
        if (appended.checkpoint) current = appended.checkpoint;
        return appended;
      },
    },
    request: actionRequest(commit),
    expected: actionRequest(commit),
    now: 30,
    eventId: "approved-for-integrity-test",
  });
  assert.equal(result.ok, true);
  const aggregate = result.checkpoint.aggregate;
  assert.ok(adapter.resolveApprovedRuntimeV2WorkPlanFromAggregate(aggregate));
  for (const phase of ["validating", "finalizing"]) {
    const executing = {
      ...aggregate,
      phase,
      run: { ...aggregate.run, phase },
    };
    assert.ok(
      adapter.resolveApprovedRuntimeV2WorkPlanFromAggregate(executing),
      `approved authority must remain available during ${phase}`,
    );
  }
  for (const altered of [
    { ...aggregate, phase: "reviewing" },
    { ...aggregate, workPlan: { ...aggregate.workPlan, status: "pending_review" } },
    {
      ...aggregate,
      workPlan: { ...aggregate.workPlan, digest: "tampered-digest" },
    },
    {
      ...aggregate,
      planReviewCommit: {
        ...aggregate.planReviewCommit,
        review: {
          ...aggregate.planReviewCommit.review,
          sessionEpoch: "epoch-b",
        },
      },
    },
    {
      ...aggregate,
      planReviewCommit: {
        ...aggregate.planReviewCommit,
        chat: {
          ...aggregate.planReviewCommit.chat,
          markdown: "tampered projection",
        },
      },
    },
  ]) {
    assert.equal(adapter.resolveApprovedRuntimeV2WorkPlanFromAggregate(altered), null);
  }
});

test("approval handoff resumes the review Run through v2 Execute without a legacy lease", () => {
  const store = fs.readFileSync(
    path.join(workspaceRoot, "src/store/useAppStore.ts"),
    "utf8",
  );
  const approvalBranch = store.slice(
    store.indexOf("runtimeV2Review?.pending"),
    store.indexOf("if (state.isPlanApproved", store.indexOf("runtimeV2Review?.pending")),
  );
  assert.match(
    approvalBranch,
    /approveAndDispatchRuntimeV2Plan/,
  );
  assert.match(approvalBranch, /runIdOverride:\s*runId/);
  assert.match(approvalBranch, /runtimeIntentOverride:\s*"execute"/);
  assert.match(approvalBranch, /executionConsentGranted:\s*true/);
  assert.doesNotMatch(approvalBranch, /planExecution\s*:/);
  assert.doesNotMatch(approvalBranch, /startPlanApprovalExecution|pendingPlanApprovalHandoff/);
  assert.doesNotMatch(approvalBranch, /execution dispatch did not start|执行调度未能启动/);
});

test("a rejected approved-Plan dispatch writes one final error instead of pausing", async () => {
  const { checkpoint, commit } = reviewCheckpoint();
  let current = checkpoint;
  const port = {
    async load() { return current; },
    async append(input) {
      const result = runtime.appendRuntimeV2Checkpoint({
        checkpoint: current,
        owner: input.owner,
        expectedRevision: input.expectedRevision,
        event: input.event,
      });
      if (result.checkpoint) current = result.checkpoint;
      return result;
    },
  };
  const approved = await approval.approveRuntimeV2PlanReviewCheckpoint({
    checkpoint,
    port,
    request: actionRequest(commit),
    expected: actionRequest(commit),
    now: 30,
    eventId: "approve-before-handoff-failure",
  });
  assert.equal(approved.ok, true);
  const closed = await handoff.finishRuntimeV2PlanHandoffFailure({
    checkpoint: approved.checkpoint,
    checkpointPort: port,
    projectionPort: { async publish() {} },
    now: 40,
    eventIdBase: "handoff-failure",
    reason: "Execution ownership was not acquired.",
  });
  assert.equal(closed.ok, true);
  assert.equal(current.aggregate.phase, "completed");
  assert.equal(current.aggregate.terminalOutcome.resultKind, "error");
  assert.equal(current.aggregate.scheduledCommands.length, 0);
  assert.equal(
    current.aggregate.events.filter((event) => event.type === "run.completed").length,
    1,
  );
  assert.equal(
    current.aggregate.events.filter((event) => event.type === "turn.completed").length,
    1,
  );
  assert.equal(
    current.aggregate.events.filter((event) =>
      event.type === "projection.published" && event.audience === "final"
    ).length,
    1,
  );
  const repeated = await handoff.finishRuntimeV2PlanHandoffFailure({
    checkpoint: current,
    checkpointPort: port,
    projectionPort: { async publish() {} },
    now: 50,
    eventIdBase: "handoff-failure-repeat",
    reason: "Execution ownership was not acquired.",
  });
  assert.equal(repeated.ok, true);
  assert.equal(
    current.aggregate.events.filter((event) => event.type === "run.completed").length,
    1,
  );
});
