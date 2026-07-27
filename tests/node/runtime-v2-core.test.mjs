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

const runtime = loadTs(path.join(workspaceRoot, "src/lib/runtime-v2/index.ts"));
const sourceEvidenceVersion = loadTs(
  path.join(workspaceRoot, "src/store/runtimeV2/sourceEvidenceVersion.ts"),
);

const baseTurn = {
  workspaceKey: "/fixture",
  sessionKey: "session-a",
  sessionEpoch: "epoch-a",
  clientSubmissionId: "submission-a",
  turnId: "turn-a",
};

const baseRun = {
  sessionKey: "session-a",
  sessionEpoch: "epoch-a",
  turnId: "turn-a",
  runId: "run-a",
  parentRunId: null,
  attemptId: "attempt-a",
};

let eventCounter = 0;
function event(state, type, fields = {}) {
  return {
    schemaVersion: runtime.RUNTIME_V2_EVENT_SCHEMA_VERSION,
    sequence: state ? state.nextSequence : 0,
    eventId: `event-${++eventCounter}`,
    at: state ? state.updatedAt + 1 : 1,
    type,
    ...fields,
  };
}

function executeAggregate(initialPhase = "observing") {
  let state = runtime.transition(null, event(null, "turn.admitted", {
    turn: baseTurn,
    strategy: "execute",
    objective: "Repair the fixture",
    constraints: [],
    acceptanceCriteria: ["The fixture passes"],
  }));
  return runtime.transition(state, event(state, "run.started", {
    run: baseRun,
    phase: initialPhase,
  }));
}

test("Plan and Execute hash exact read_file bytes instead of formatted read windows", async () => {
  const exact = "line 1\nline 2\n";
  const formattedWindow = "1: line 1\n[truncated]";
  let exactReads = 0;
  const version = await sourceEvidenceVersion.resolveRuntimeV2SourceEvidenceVersion({
    toolName: "read_file",
    args: { path: "src/main.js", start_line: 1, max_lines: 1 },
    output: formattedWindow,
    readExactFile: async () => {
      exactReads += 1;
      return exact;
    },
  });
  assert.equal(version, runtime.runtimeV2EvidenceVersion(exact));
  assert.notEqual(version, runtime.runtimeV2EvidenceVersion(formattedWindow));
  assert.equal(exactReads, 1);

  const rawVersion = await sourceEvidenceVersion.resolveRuntimeV2SourceEvidenceVersion({
    toolName: "read_file",
    args: { path: "src/main.js", __raw: true },
    output: exact,
    readExactFile: async () => {
      throw new Error("an already exact read must not be repeated");
    },
  });
  assert.equal(rawVersion, version);
});

function commandFor(state, kind, idempotencyKey, payload = {}) {
  return {
    idempotencyKey,
    kind,
    run: baseRun,
    phase: state.phase,
    payload: {
      actionFingerprint: `${state.phase}:${kind}:${idempotencyKey}`,
      attempt: 1,
      ...payload,
    },
  };
}

function recordProviderResponse(state, idempotencyKey, toolCalls = []) {
  const command = commandFor(state, "request_model", idempotencyKey, { mode: "observe" });
  state = runtime.transition(state, event(state, "command.scheduled", {
    run: baseRun,
    command,
  }));
  return runtime.transition(state, event(state, "provider.responded", {
    run: baseRun,
    idempotencyKey,
    result: { toolCalls, diagnostics: [] },
  }));
}

test("workspace read-only strategy is structurally distinct from Chat", () => {
  let state = runtime.transition(null, event(null, "turn.admitted", {
    turn: baseTurn,
    strategy: "analyze",
    objective: "Explain the workspace implementation",
    constraints: [],
    acceptanceCriteria: [],
  }));
  state = runtime.transition(state, event(state, "run.started", {
    run: baseRun,
    phase: "observing",
  }));

  const [next] = runtime.decideNextCommands(state);
  assert.equal(next.kind, "request_model");
  assert.equal(next.payload.mode, "analyze");
  assert.notEqual(next.payload.mode, "chat");
});

test("Capsule keeps provider-visible commentary beside its exact structured action", () => {
  let state = executeAggregate("observing");
  const request = commandFor(state, "request_model", "model-commentary", {
    mode: "observe",
  });
  state = runtime.transition(state, event(state, "command.scheduled", {
    run: baseRun,
    command: request,
  }));
  state = runtime.transition(state, event(state, "provider.responded", {
    run: baseRun,
    idempotencyKey: request.idempotencyKey,
    result: {
      visibleText: "我已经收窄到编辑器的文件生命周期，先核对事件入口。",
      toolCalls: [{
        id: "read-editor",
        name: "read_file",
        arguments: {
          path: "src/features/editor/EditorInteractionCoordinator.ts",
        },
      }],
      diagnostics: [],
    },
  }));
  const [read] = runtime.decideNextCommands(state);
  assert.equal(read.kind, "execute_tool");
  state = runtime.transition(state, event(state, "command.scheduled", {
    run: baseRun,
    command: read,
  }));

  const capsule = runtime.buildRuntimeV2CapsuleProjection(state, "capsule-1");
  assert.match(capsule.markdown, /我已经收窄到编辑器的文件生命周期/);
  assert.match(capsule.markdown, /EditorInteractionCoordinator\.ts/);
  assert.doesNotMatch(capsule.markdown, /\.\.\./);
});

test("Capsule never exposes a text tool envelope as commentary", () => {
  let state = executeAggregate("observing");
  const request = commandFor(state, "request_model", "model-envelope", {
    mode: "observe",
  });
  state = runtime.transition(state, event(state, "command.scheduled", {
    run: baseRun,
    command: request,
  }));
  const envelope = '<runtime-v2-tools>{"toolCalls":[{"id":"read-main","name":"read_file","arguments":{"path":"src/main.js"}}]}</runtime-v2-tools>';
  state = runtime.transition(state, event(state, "provider.responded", {
    run: baseRun,
    idempotencyKey: request.idempotencyKey,
    result: {
      visibleText: envelope,
      toolCalls: [{
        id: "read-main",
        name: "read_file",
        arguments: { path: "src/main.js" },
      }],
      diagnostics: [],
    },
  }));
  const [read] = runtime.decideNextCommands(state);
  state = runtime.transition(state, event(state, "command.scheduled", {
    run: baseRun,
    command: read,
  }));

  const capsule = runtime.buildRuntimeV2CapsuleProjection(state, "capsule-2");
  assert.match(capsule.markdown, /正在读取/);
  assert.doesNotMatch(capsule.markdown, /runtime-v2-tools|toolCalls/);
});

test("Capsule clears provider commentary after its structured action settles", () => {
  let state = executeAggregate("observing");
  const request = commandFor(state, "request_model", "model-stale-commentary", {
    mode: "observe",
  });
  state = runtime.transition(state, event(state, "command.scheduled", {
    run: baseRun,
    command: request,
  }));
  state = runtime.transition(state, event(state, "provider.responded", {
    run: baseRun,
    idempotencyKey: request.idempotencyKey,
    result: {
      visibleText: "这条说明只属于接下来的读取动作。",
      toolCalls: [{
        id: "read-once",
        name: "read_file",
        arguments: { path: "src/main.js" },
      }],
      diagnostics: [],
    },
  }));
  const [read] = runtime.decideNextCommands(state);
  state = runtime.transition(state, event(state, "command.scheduled", {
    run: baseRun,
    command: read,
  }));
  state = runtime.transition(state, event(state, "tool.completed", {
    run: baseRun,
    idempotencyKey: read.idempotencyKey,
    status: "succeeded",
    evidence: [{
      id: "read-source",
      kind: "source",
      target: "src/main.js",
      version: "source-v1",
    }],
  }));

  const capsule = runtime.buildRuntimeV2CapsuleProjection(
    state,
    "capsule-settled",
  );
  assert.doesNotMatch(capsule.markdown, /只属于接下来的读取动作/);
  assert.match(capsule.markdown, /正在收集证据/);
});

test("Chat milestones omit individual observations and join child results once", () => {
  let state = executeAggregate("observing");
  const observation = event(state, "observation.recorded", {
    run: baseRun,
    evidence: {
      id: "source-1",
      kind: "source",
      target: "src/main.js",
      version: "source-v1",
    },
  });
  state = runtime.transition(state, observation);
  assert.equal(
    runtime.buildRuntimeV2MilestoneProjection(
      state,
      observation,
      "observation-milestone",
    ),
    null,
  );

  const childRun = (runId) => ({
    ...baseRun,
    runId,
    parentRunId: baseRun.runId,
    attemptId: runId,
  });
  const jobs = [
    {
      id: "child-frontend",
      run: childRun("child-run-frontend"),
      parentRunId: baseRun.runId,
      scopeKey: "frontend",
      objective: "Inspect frontend evidence",
      allowedPaths: ["src"],
      status: "queued",
      requestedAt: state.updatedAt + 1,
      firstTokenAt: null,
      closedAt: null,
      summary: null,
    },
    {
      id: "child-backend",
      run: childRun("child-run-backend"),
      parentRunId: baseRun.runId,
      scopeKey: "backend",
      objective: "Inspect backend evidence",
      allowedPaths: ["src-tauri"],
      status: "queued",
      requestedAt: state.updatedAt + 1,
      firstTokenAt: null,
      closedAt: null,
      summary: null,
    },
  ];
  state = runtime.transition(state, event(state, "subagents.scheduled", {
    run: baseRun,
    jobs,
  }));
  state = runtime.transition(state, event(state, "subagent.telemetry", {
    run: baseRun,
    telemetry: {
      jobId: jobs[0].id,
      phase: "request_opened",
      at: state.updatedAt + 1,
    },
  }));
  state = runtime.transition(state, event(state, "subagent.telemetry", {
    run: baseRun,
    telemetry: {
      jobId: jobs[0].id,
      phase: "closed",
      at: state.updatedAt + 1,
    },
  }));
  const firstChild = event(state, "subagent.completed", {
    run: baseRun,
    jobId: jobs[0].id,
    status: "completed",
    summary: "Frontend evidence collected.",
    evidence: [{
      id: "child-evidence-1",
      kind: "subagent",
      target: "src/main.js",
      version: null,
    }],
  });
  state = runtime.transition(state, firstChild);
  assert.equal(
    runtime.buildRuntimeV2MilestoneProjection(
      state,
      firstChild,
      "first-child-milestone",
    ),
    null,
  );

  state = runtime.transition(state, event(state, "subagent.telemetry", {
    run: baseRun,
    telemetry: {
      jobId: jobs[1].id,
      phase: "request_opened",
      at: state.updatedAt + 1,
    },
  }));
  state = runtime.transition(state, event(state, "subagent.telemetry", {
    run: baseRun,
    telemetry: {
      jobId: jobs[1].id,
      phase: "closed",
      at: state.updatedAt + 1,
    },
  }));
  const secondChild = event(state, "subagent.completed", {
    run: baseRun,
    jobId: jobs[1].id,
    status: "failed",
    summary: "Backend request ended without a report.",
    evidence: [],
  });
  state = runtime.transition(state, secondChild);
  const joined = runtime.buildRuntimeV2MilestoneProjection(
    state,
    secondChild,
    "joined-child-milestone",
  );
  assert.match(joined.markdown, /并行只读调查已汇合/);
  assert.match(joined.markdown, /1 个范围完成调查，1 个范围未能完整返回/);
  assert.match(joined.markdown, /1 条子智能体证据/);
});

test("Runtime v2 reducer records one ordered ledger and forbids success before finalizing", () => {
  let state = runtime.transition(null, event(null, "turn.admitted", {
    turn: baseTurn,
    strategy: "execute",
    objective: "Fix the fixture",
    constraints: [],
    acceptanceCriteria: ["The test passes"],
  }));
  state = runtime.transition(state, event(state, "run.started", { run: baseRun, phase: "preparing" }));
  const premature = runtime.tryTransition(state, event(state, "run.completed", {
    run: baseRun,
    outcome: { resultKind: "success", reason: "not validated", completedAt: 3, finalProjectionId: "final-a" },
  }));
  assert.equal(premature.disposition, "rejected");
  assert.equal(premature.reason, "success_requires_finalizing");

  state = runtime.transition(state, event(state, "phase.changed", {
    run: baseRun,
    phase: "finalizing",
    reason: "all required checks passed",
  }));
  state = runtime.transition(state, event(state, "run.completed", {
    run: baseRun,
    outcome: { resultKind: "success", reason: "validated", completedAt: 4, finalProjectionId: "final-a" },
  }));
  state = runtime.transition(state, event(state, "projection.published", {
    run: baseRun,
    audience: "final",
    projectionId: "final-a",
    projection: {
      id: "final-a",
      audience: "final",
      markdown: "### 已完成",
      kind: "final",
      dedupeKey: "final",
    },
  }));
  state = runtime.transition(state, event(state, "turn.completed", {
    turn: baseTurn,
    runId: baseRun.runId,
    outcome: { resultKind: "success", reason: "validated", completedAt: 4, finalProjectionId: "final-a" },
  }));
  assert.equal(state.phase, "completed");
  assert.equal(state.events.filter((item) => item.type === "turn.completed").length, 1);
});

test("provider transport is capability-based, bounded and does not infer calls from prose", () => {
  const profile = {
    schemaVersion: "provider-lane.v1",
    nativeTools: true,
    requiredToolChoice: true,
    streaming: true,
    textToolEnvelope: true,
    reasoning: true,
    imageInput: false,
    toolResultRole: "tool",
  };
  let epoch = runtime.createProviderActionEpoch("read-main");
  const variants = [];
  while (true) {
    const attempt = runtime.selectNextProviderTransportAttempt(profile, epoch);
    if (!attempt) break;
    variants.push(attempt.variant);
    epoch = runtime.recordProviderTransportAttempt(epoch, attempt);
  }
  assert.deepEqual(variants, ["native_required", "native_auto", "text_envelope"]);
  assert.equal(runtime.providerActionEpochExhausted(profile, epoch), true);
  assert.deepEqual(runtime.parseExplicitTextToolEnvelope("让我读取 src/main.js"), []);
  assert.deepEqual(runtime.parseExplicitTextToolEnvelope(
    '<runtime-v2-tools>{"toolCalls":[{"id":"a","name":"read_file","arguments":{"path":"src/main.js"}}]}</runtime-v2-tools>',
  ), [{ id: "a", name: "read_file", arguments: { path: "src/main.js" } }]);
});

test("WorkPlanV1 seals one source for Markdown and requires review for lossy V5 imports", () => {
  const draft = {
    schemaVersion: runtime.WORK_PLAN_V1_SCHEMA_VERSION,
    objective: "修复打开文件问题",
    summary: "统一文件打开路径并验证。",
    findings: [{ statement: "打开事件没有被前端消费。", basis: ["E1"] }],
    steps: [{
      title: "统一打开入口",
      operation: "modify",
      targets: ["src/main.js"],
      basis: ["E1"],
      change: "让前端消费统一事件。",
      expectedOutcome: "文件内容和标签同步更新。",
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
  };
  const plan = runtime.sealWorkPlanV1({
    draft,
    evidence: [{ id: "E1", target: "src/main.js", version: "v1", statement: "listener missing" }],
    createdAt: 10,
  });
  assert.match(plan.markdown, /统一打开入口/);
  assert.match(plan.markdown, /npm run build/);
  assert.match(plan.projectionHash, /^work-plan-projection-sha256-/);
  assert.match(
    runtime.validateWorkPlanDraftV1({
      ...draft,
      summary: "x".repeat(15_000),
    })[0]?.message || "",
    /14,000-character/,
  );
  assert.ok(runtime.validateWorkPlanDraftV1({
    ...draft,
    summary: "<tool_call><function=submit_runtime_v2_work_plan>",
  }).some((issue) =>
    issue.path === "summary" && /tool-protocol markup/.test(issue.message)
  ));
  assert.ok(runtime.validateWorkPlanDraftV1({
    ...draft,
    validations: [{
      stepIndexes: [0],
      kind: "finite_command",
      command: "npm run dev",
      expectedOutcome: "服务启动。",
      required: true,
    }],
  }).some((issue) =>
    issue.path === "validations[0].command" && /bounded fail-fast/.test(issue.message)
  ));
  assert.ok(runtime.validateWorkPlanDraftV1({
    ...draft,
    validations: [{
      stepIndexes: [0],
      kind: "assertion",
      expectedOutcome: "代码看起来正确。",
      required: true,
    }],
  }).some((issue) =>
    issue.path === "validations[0].required" && /cannot own required acceptance/.test(issue.message)
  ));
  assert.ok(runtime.validateWorkPlanDraftV1({
    ...draft,
    blockingQuestions: ["需要再读取源文件吗？"],
  }).some((issue) =>
    issue.path === "blockingQuestions" && /cannot be approved/.test(issue.message)
  ));

  const migration = runtime.migratePlanCandidateV5ToWorkPlanV1({
    schemaVersion: 5,
    state: "sealed",
    contractId: "legacy",
    authoringContractId: "legacy-author",
    bundleHash: "bundle",
    objective: "legacy",
    goals: [],
    diagnosisRequired: false,
    evidence: [],
    evidenceReceipt: {},
    summary: [],
    diagnoses: [],
    findings: [],
    changes: [],
    decisions: [],
    interfaces: [],
    tests: [],
    validations: [],
    assumptions: [],
    blockingChoices: [],
    projection: { format: "markdown", content: "# legacy", contentHash: "legacy" },
  });
  assert.equal(migration.disposition, "requires_review");
});

test("RuntimeV2Controller persists scheduled effects, publishes complete Capsule text, and concludes exactly once", async () => {
  let now = 100;
  let id = 0;
  let revision = 0;
  const published = [];
  const ports = {
    checkpoint: {
      async load() { return null; },
      async append({ event }) {
        revision += 1;
        return { disposition: "committed", checkpoint: { revision, event } };
      },
    },
    provider: {
      async request() {
        return { toolCalls: [{ id: "read-1", name: "read_file", arguments: { path: "src/main.js" } }], diagnostics: [] };
      },
    },
    tool: {
      async execute({ command }) {
        if (command.kind === "collect_observation") {
          return { type: "observation.recorded", run: command.run, evidence: { id: "E1", kind: "source", target: "src/main.js", version: "v1" } };
        }
        return { type: "tool.completed", run: command.run, idempotencyKey: command.idempotencyKey, status: "succeeded", evidence: [{ id: "E2", kind: "tool", target: "src/main.js", version: "v2" }] };
      },
    },
    scheduler: { async execute({ command }) { return { type: "command.completed", run: command.run, idempotencyKey: command.idempotencyKey, status: "succeeded" }; } },
    projection: { async publish({ projection }) { published.push(projection); } },
    clockId: {
      now: () => ++now,
      nextId: (scope) => `${scope}-${++id}`,
      nextIdempotencyKey: ({ run, kind }) => `${run.runId}:${kind}:${++id}`,
    },
  };
  const controller = new runtime.RuntimeV2Controller(ports);
  await controller.admit({ turn: baseTurn, run: baseRun, strategy: "execute", objective: "Fix it" });
  assert.equal(await controller.driveOnce(), true);
  await controller.changePhase("observing", "initial evidence collected");
  assert.equal(await controller.driveOnce(), true);
  assert.equal(await controller.driveOnce(), true);
  await controller.changePhase("finalizing", "validation complete");
  assert.equal(await controller.driveOnce({ resultKind: "success", resultReason: "validated" }), true);
  const snapshot = controller.snapshot();
  assert.equal(snapshot.aggregate.phase, "completed");
  assert.equal(snapshot.aggregate.events.filter((item) => item.type === "turn.completed").length, 1);
  assert.ok(published.some((item) => item.audience === "capsule_live" && /src\/main\.js/.test(item.markdown)));
  assert.equal(published.filter((item) => item.audience === "final").length, 1);
});

test("identical structural actions without a real mutation close as error instead of claiming partial work", async () => {
  let now = 100;
  let id = 0;
  let revision = 0;
  const published = [];
  const ports = {
    checkpoint: {
      async load() { return null; },
      async append({ event }) {
        revision += 1;
        return { disposition: "committed", checkpoint: { revision, event } };
      },
    },
    provider: {
      async request() { return { toolCalls: [], diagnostics: [], visibleText: "" }; },
    },
    tool: {
      async execute({ command }) {
        return { type: "observation.recorded", run: command.run, evidence: { id: "E1", kind: "source", target: "src/main.js", version: "v1" } };
      },
    },
    scheduler: { async execute({ command }) { return { type: "command.completed", run: command.run, idempotencyKey: command.idempotencyKey, status: "succeeded" }; } },
    projection: { async publish({ projection }) { published.push(projection); } },
    clockId: {
      now: () => ++now,
      nextId: (scope) => `${scope}-${++id}`,
      nextIdempotencyKey: ({ run, kind }) => `${run.runId}:${kind}:${++id}`,
    },
  };
  const controller = new runtime.RuntimeV2Controller(ports);
  await controller.admit({ turn: baseTurn, run: baseRun, strategy: "execute", objective: "Fix it" });
  await controller.changePhase("observing", "evidence is available");
  await controller.recordObservation({ id: "E1", kind: "source", target: "src/main.js", version: "v1" });
  await controller.driveOnce();
  await controller.driveOnce();
  await controller.driveOnce();
  const aggregate = controller.snapshot().aggregate;
  assert.equal(aggregate.phase, "completed");
  assert.equal(aggregate.terminalOutcome.resultKind, "error");
  assert.ok(aggregate.recovery.exhausted);
  assert.equal(aggregate.events.filter((event) => event.type === "turn.completed").length, 1);
  assert.equal(published.filter((item) => item.audience === "final").length, 1);
});

test("bounded provider transport failures close as error rather than partial", async () => {
  let now = 200;
  let id = 0;
  let revision = 0;
  const ports = {
    checkpoint: {
      async load() { return null; },
      async append({ event }) {
        revision += 1;
        return { disposition: "committed", checkpoint: { revision, event } };
      },
    },
    provider: {
      async request() {
        throw new Error("deterministic transport failure");
      },
    },
    tool: {
      async execute({ command }) {
        return {
          type: "observation.recorded",
          run: command.run,
          evidence: { id: "E1", kind: "source", target: "src/main.js", version: "v1" },
        };
      },
    },
    scheduler: {
      async execute({ command }) {
        return {
          type: "command.completed",
          run: command.run,
          idempotencyKey: command.idempotencyKey,
          status: "succeeded",
        };
      },
    },
    projection: { async publish() {} },
    clockId: {
      now: () => ++now,
      nextId: (scope) => `${scope}-${++id}`,
      nextIdempotencyKey: ({ run, kind }) => `${run.runId}:${kind}:${++id}`,
    },
  };
  const controller = new runtime.RuntimeV2Controller(ports);
  await controller.admit({ turn: baseTurn, run: baseRun, strategy: "execute", objective: "Fix it" });
  await controller.changePhase("observing", "evidence is available");
  await controller.recordObservation({
    id: "E1",
    kind: "source",
    target: "src/main.js",
    version: "v1",
  });
  await controller.driveOnce();
  await controller.driveOnce();
  await controller.driveOnce();
  const aggregate = controller.snapshot().aggregate;
  assert.equal(aggregate.phase, "completed");
  assert.equal(aggregate.terminalOutcome.resultKind, "error");
  assert.equal(aggregate.terminalOutcome.reason, "provider_transport_exhausted");
  assert.equal(aggregate.recovery.exhausted?.scope, "transport");
  assert.equal(aggregate.events.filter((event) => event.type === "turn.completed").length, 1);
});

test("v3 checkpoints replay events, reject a tampered aggregate, and CAS append once", () => {
  let state = runtime.transition(null, event(null, "turn.admitted", {
    turn: baseTurn,
    strategy: "execute",
    objective: "Fix the fixture",
    constraints: [],
    acceptanceCriteria: [],
  }));
  state = runtime.transition(state, event(state, "run.started", { run: baseRun, phase: "preparing" }));
  const checkpoint = runtime.createRuntimeV2Checkpoint({ revision: 2, aggregate: state, updatedAt: state.updatedAt });
  assert.equal(runtime.normalizeRuntimeV2Checkpoint(checkpoint)?.aggregate.nextSequence, state.nextSequence);
  const tampered = { ...checkpoint, aggregate: { ...checkpoint.aggregate, phase: "completed" } };
  assert.equal(runtime.normalizeRuntimeV2Checkpoint(tampered), null);
  const nextEvent = event(state, "phase.changed", { run: baseRun, phase: "observing", reason: "begin review" });
  const appended = runtime.appendRuntimeV2Checkpoint({
    checkpoint,
    owner: baseTurn,
    expectedRevision: checkpoint.revision,
    event: nextEvent,
  });
  assert.equal(appended.disposition, "committed");
  assert.equal(appended.checkpoint.aggregate.phase, "observing");
  const replayed = runtime.appendRuntimeV2Checkpoint({
    checkpoint: appended.checkpoint,
    owner: baseTurn,
    expectedRevision: checkpoint.revision,
    event: nextEvent,
  });
  assert.equal(replayed.disposition, "idempotent");
});

test("read-only child scheduler requires disjoint scopes and records real request overlap", () => {
  let child = 0;
  const schedule = runtime.scheduleReadOnlySubagents({
    parentRun: baseRun,
    requestedAt: 10,
    nextId: () => `child-${++child}`,
    candidates: [
      { scopeKey: "editor", objective: "Inspect editor event handlers", allowedPaths: ["src/components/editor"] },
      { scopeKey: "tauri", objective: "Inspect Tauri command wiring", allowedPaths: ["src-tauri/src"] },
      { scopeKey: "nested-editor", objective: "Overlaps editor", allowedPaths: ["src/components/editor/panels"] },
    ],
  });
  assert.equal(schedule.jobs.length, 2);
  assert.deepEqual(schedule.rejectedScopeKeys, ["nested-editor"]);
  let jobs = schedule.jobs.map((job) => runtime.applyRuntimeV2SubagentTelemetry(job, {
    jobId: job.id, phase: "request_opened", at: 11,
  }));
  jobs = jobs.map((job) => runtime.applyRuntimeV2SubagentTelemetry(job, {
    jobId: job.id, phase: "first_token", at: 12,
  }));
  jobs[0] = runtime.applyRuntimeV2SubagentTelemetry(jobs[0], { jobId: jobs[0].id, phase: "closed", at: 20 });
  jobs[1] = runtime.applyRuntimeV2SubagentTelemetry(jobs[1], { jobId: jobs[1].id, phase: "closed", at: 21 });
  const telemetry = runtime.deriveRuntimeV2SubagentConcurrency(jobs);
  assert.equal(telemetry.peakInFlight, 2);
  assert.equal(telemetry.hasRequestOverlap, true);
});

test("Execute phase policy advances completed observation into acting without requiring a pending mutation", () => {
  let state = executeAggregate("observing");
  state = runtime.transition(state, event(state, "observation.recorded", {
    run: baseRun,
    evidence: { id: "phase-E1", kind: "source", target: "src/main.js", version: "v1" },
  }));
  state = recordProviderResponse(state, "observe-complete");

  assert.deepEqual(runtime.decideRuntimeV2ExecutePhaseTransition(state, {
    isMutationToolName: (name) => name === "apply_patch",
  }), {
    from: "observing",
    to: "acting",
    reason: "observation_cycle_complete",
  });
});

test("initial observation completion is scoped to the current execution boundary", () => {
  let state = executeAggregate("preparing");
  const collect = commandFor(
    state,
    "collect_observation",
    "collect-current-overview",
    { objective: "Inspect the workspace" },
  );
  state = runtime.transition(state, event(state, "command.scheduled", {
    run: baseRun,
    command: collect,
  }));
  state = runtime.transition(state, event(state, "command.completed", {
    run: baseRun,
    idempotencyKey: collect.idempotencyKey,
    status: "succeeded",
  }));
  assert.equal(runtime.hasCompletedRuntimeV2InitialObservation(state), true);

  const approvalBoundary = {
    ...event(state, "work_plan.approved", { run: baseRun }),
    sequence: state.nextSequence,
  };
  const approvedState = {
    ...state,
    events: [...state.events, approvalBoundary],
    nextSequence: state.nextSequence + 1,
    updatedAt: approvalBoundary.at,
  };
  assert.equal(
    runtime.hasCompletedRuntimeV2InitialObservation(approvedState),
    false,
  );
});

test("Execute phase policy waits for every scheduled read-only child but accepts terminal child failures", () => {
  let state = executeAggregate("observing");
  state = runtime.transition(state, event(state, "observation.recorded", {
    run: baseRun,
    evidence: { id: "phase-E2", kind: "source", target: "src", version: "v1" },
  }));
  state = recordProviderResponse(state, "observe-with-children");
  const children = ["frontend", "backend"].map((scopeKey, index) => ({
    id: `phase-child-${index + 1}`,
    run: {
      ...baseRun,
      runId: `phase-child-run-${index + 1}`,
      parentRunId: baseRun.runId,
      attemptId: `phase-child-attempt-${index + 1}`,
    },
    parentRunId: baseRun.runId,
    scopeKey,
    objective: `Inspect ${scopeKey}`,
    allowedPaths: [index === 0 ? "src" : "src-tauri"],
    status: index === 0 ? "completed" : "running",
    requestedAt: 10,
    firstTokenAt: 11,
    closedAt: index === 0 ? 12 : null,
    summary: index === 0 ? "done" : null,
  }));
  const classifier = { isMutationToolName: (name) => name === "apply_patch" };

  assert.equal(runtime.decideRuntimeV2ExecutePhaseTransition({
    ...state,
    subagents: children,
  }, classifier), null);
  assert.deepEqual(runtime.decideRuntimeV2ExecutePhaseTransition({
    ...state,
    subagents: children.map((job, index) => ({
      ...job,
      status: index === 0 ? "completed" : "failed",
      closedAt: 12 + index,
      summary: index === 0 ? "done" : "failed with evidence retained",
    })),
  }, classifier), {
    from: "observing",
    to: "acting",
    reason: "observation_cycle_complete",
  });
});

test("Execute phase policy never leaves observing for a mutation while child requests are active", () => {
  let state = executeAggregate("observing");
  state = recordProviderResponse(state, "observe-premature-mutation", [{
    id: "premature-mutation-call",
    name: "apply_patch",
    arguments: { patch: "*** Begin Patch\n*** End Patch" },
  }]);
  state = {
    ...state,
    subagents: [{
      id: "active-child",
      run: {
        ...baseRun,
        runId: "active-child-run",
        parentRunId: baseRun.runId,
        attemptId: "active-child-attempt",
      },
      parentRunId: baseRun.runId,
      scopeKey: "frontend",
      objective: "Inspect frontend",
      allowedPaths: ["src"],
      status: "running",
      requestedAt: 10,
      firstTokenAt: 11,
      closedAt: null,
      summary: null,
    }],
  };
  assert.equal(runtime.decideRuntimeV2ExecutePhaseTransition(state, {
    isMutationToolName: (name) => name === "apply_patch",
  }), null);
});

test("Execute phase policy moves a pending mutation into acting immediately", () => {
  let state = executeAggregate("observing");
  state = recordProviderResponse(state, "observe-mutation", [{
    id: "mutation-call",
    name: "apply_patch",
    arguments: { path: "src/main.js", patch: "@@" },
  }]);

  assert.deepEqual(runtime.decideRuntimeV2ExecutePhaseTransition(state, {
    isMutationToolName: (name) => name === "apply_patch",
  }), {
    from: "observing",
    to: "acting",
    reason: "pending_mutation_call",
  });
});

test("Execute phase policy advances a committed mutation into validation", () => {
  let state = executeAggregate("acting");
  const mutation = commandFor(state, "execute_tool", "apply-mutation", {
    toolCallId: "mutation-call",
    toolName: "apply_patch",
    arguments: { path: "src/main.js", patch: "@@" },
  });
  state = runtime.transition(state, event(state, "command.scheduled", {
    run: baseRun,
    command: mutation,
  }));
  state = runtime.transition(state, event(state, "tool.completed", {
    run: baseRun,
    idempotencyKey: mutation.idempotencyKey,
    status: "succeeded",
    evidence: [{ id: "phase-E3", kind: "tool", target: "src/main.js", version: "v2" }],
  }));

  assert.deepEqual(runtime.decideRuntimeV2ExecutePhaseTransition(state, {
    isMutationToolName: (name) => name === "apply_patch",
  }), {
    from: "acting",
    to: "validating",
    reason: "mutation_committed",
  });
});

test("an approved Runtime v2 Plan uses the same mutation-to-validation phase policy", () => {
  const classifier = { isMutationToolName: (name) => name === "apply_patch" };
  let state = {
    ...executeAggregate("acting"),
    strategy: "plan",
    workPlan: {
      id: "work-plan-approved",
      revision: 1,
      digest: "digest-approved",
      projectionHash: "projection-approved",
      status: "approved",
    },
  };
  const mutation = commandFor(state, "execute_tool", "approved-plan-mutation", {
    toolCallId: "approved-plan-call",
    toolName: "apply_patch",
    arguments: { patch: "*** Begin Patch\n*** End Patch" },
  });
  state = runtime.transition(state, event(state, "command.scheduled", {
    run: baseRun,
    command: mutation,
  }));
  state = runtime.transition(state, event(state, "tool.completed", {
    run: baseRun,
    idempotencyKey: mutation.idempotencyKey,
    status: "succeeded",
    evidence: [{ id: "approved-M1", kind: "mutation", target: "src/main.js", version: "v2" }],
  }));
  assert.deepEqual(runtime.decideRuntimeV2ExecutePhaseTransition(state, classifier), {
    from: "acting",
    to: "validating",
    reason: "mutation_committed",
  });
});

function approvedTwoTargetPlanAggregate(initialPhase = "acting") {
  const sealed = runtime.sealWorkPlanV1({
    draft: {
      schemaVersion: runtime.WORK_PLAN_V1_SCHEMA_VERSION,
      objective: "Repair two related files",
      summary: "Apply the reviewed changes and run the reviewed build.",
      findings: [],
      steps: [
        {
          title: "Repair frontend",
          operation: "modify",
          targets: ["src/main.js"],
          basis: ["E-main"],
          change: "Unify the file lifecycle.",
          expectedOutcome: "Only the opened file is visible.",
          dependsOn: [],
        },
        {
          title: "Repair editor",
          operation: "modify",
          targets: ["src/components/editor.js"],
          basis: ["E-editor"],
          change: "Preserve the opened file path.",
          expectedOutcome: "Save does not open for an existing file.",
          dependsOn: [0],
        },
      ],
      validations: [{
        stepIndexes: [0, 1],
        kind: "finite_command",
        command: "npm run build",
        cwd: ".",
        expectedOutcome: "Build succeeds.",
        required: true,
      }],
      risks: [],
      assumptions: [],
      blockingQuestions: [],
    },
    evidence: [
      {
        id: "E-main",
        target: "src/main.js",
        version: "sha256-main-reviewed",
        statement: "Reviewed the current frontend source.",
      },
      {
        id: "E-editor",
        target: "src/components/editor.js",
        version: "sha256-editor-reviewed",
        statement: "Reviewed the current editor source.",
      },
    ],
    id: "WP-two-targets",
    revision: 1,
    createdAt: 20,
  });
  const state = executeAggregate(initialPhase);
  return {
    ...state,
    strategy: "plan",
    workPlan: {
      id: sealed.id,
      revision: sealed.revision,
      digest: sealed.digest,
      projectionHash: sealed.projectionHash,
      status: "approved",
    },
    sealedWorkPlan: sealed,
  };
}

function commitMutation(state, key, target) {
  const mutation = commandFor(state, "execute_tool", key, {
    toolCallId: `${key}-call`,
    toolName: "apply_patch",
    arguments: {
      patch: `*** Begin Patch\n*** Update File: ${target}\n@@\n-old\n+new\n*** End Patch`,
    },
  });
  state = runtime.transition(state, event(state, "command.scheduled", {
    run: baseRun,
    command: mutation,
  }));
  return runtime.transition(state, event(state, "tool.completed", {
    run: baseRun,
    idempotencyKey: mutation.idempotencyKey,
    status: "succeeded",
    evidence: [{
      id: `${key}-evidence`,
      kind: "mutation",
      target,
      version: "changed",
    }],
  }));
}

function commitSourceRead(state, key, target, version) {
  const read = commandFor(state, "execute_tool", key, {
    toolCallId: `${key}-call`,
    toolName: "read_file",
    arguments: { path: target },
  });
  state = runtime.transition(state, event(state, "command.scheduled", {
    run: baseRun,
    command: read,
  }));
  return runtime.transition(state, event(state, "tool.completed", {
    run: baseRun,
    idempotencyKey: read.idempotencyKey,
    status: "succeeded",
    evidence: [{
      id: `${key}-evidence`,
      kind: "source",
      target,
      version,
    }],
  }));
}

test("approved Plan requires fresh reviewed source versions before its first mutation", () => {
  let state = approvedTwoTargetPlanAggregate("acting");
  assert.deepEqual(
    runtime.deriveRuntimeV2PlanSourceFreshness(state).missingTargets,
    ["src/main.js", "src/components/editor.js"],
  );

  state = commitSourceRead(
    state,
    "read-main-current",
    "src/main.js",
    "sha256-main-reviewed",
  );
  assert.deepEqual(
    runtime.deriveRuntimeV2PlanSourceFreshness(state).missingTargets,
    ["src/components/editor.js"],
  );

  state = commitSourceRead(
    state,
    "read-editor-stale",
    "src/components/editor.js",
    "sha256-editor-changed",
  );
  const stale = runtime.deriveRuntimeV2PlanSourceFreshness(state);
  assert.equal(stale.allFresh, false);
  assert.deepEqual(stale.staleTargets, ["src/components/editor.js"]);

  state = commitSourceRead(
    state,
    "read-editor-current",
    "src/components/editor.js",
    "sha256-editor-reviewed",
  );
  assert.equal(runtime.deriveRuntimeV2PlanSourceFreshness(state).allFresh, true);
});

test("approved Plan remains in acting until every reviewed mutation target is committed", () => {
  const classifier = { isMutationToolName: (name) => name === "apply_patch" };
  let state = approvedTwoTargetPlanAggregate("acting");
  state = commitMutation(state, "mutate-main", "src/main.js");
  assert.equal(
    runtime.decideRuntimeV2ExecutePhaseTransition(state, classifier),
    null,
  );
  assert.deepEqual(
    runtime.deriveRuntimeV2PlanExecutionCoverage(state).missingMutationTargets,
    ["src/components/editor.js"],
  );

  state = commitMutation(state, "mutate-editor", "src/components/editor.js");
  assert.deepEqual(runtime.decideRuntimeV2ExecutePhaseTransition(state, classifier), {
    from: "acting",
    to: "validating",
    reason: "mutation_committed",
  });
});

test("approved Plan scope rejects unreviewed files and non-matching validation commands", () => {
  const state = approvedTwoTargetPlanAggregate();
  assert.equal(runtime.resolveRuntimeV2PlanMutationScope({
    plan: state.sealedWorkPlan,
    requestedTargets: ["src/main.js"],
  }).allowed, true);
  assert.deepEqual(runtime.resolveRuntimeV2PlanMutationScope({
    plan: state.sealedWorkPlan,
    requestedTargets: ["src/main.js", "src/extra.js"],
  }).unexpectedTargets, ["src/extra.js"]);
  assert.equal(runtime.resolveRuntimeV2PlanValidationScope({
    plan: state.sealedWorkPlan,
    toolName: "run_command",
    args: { command: "npm run build", cwd: "." },
  }).allowed, true);
  assert.equal(runtime.resolveRuntimeV2PlanValidationScope({
    plan: state.sealedWorkPlan,
    toolName: "run_command",
    args: { command: "npm test", cwd: "." },
  }).allowed, false);
});

test("approved Plan acceptance requires the reviewed validation after the latest mutation", () => {
  let state = approvedTwoTargetPlanAggregate("acting");
  state = commitMutation(state, "mutate-main-coverage", "src/main.js");
  state = commitMutation(state, "mutate-editor-coverage", "src/components/editor.js");
  state = runtime.transition(state, event(state, "phase.changed", {
    run: baseRun,
    phase: "validating",
    reason: "all reviewed targets changed",
  }));
  const wrongValidation = commandFor(state, "execute_validation", "wrong-validation", {
    toolCallId: "wrong-validation-call",
    toolName: "run_command",
    arguments: { command: "npm test", cwd: "." },
  });
  state = runtime.transition(state, event(state, "command.scheduled", {
    run: baseRun,
    command: wrongValidation,
  }));
  state = runtime.transition(state, event(state, "validation.completed", {
    run: baseRun,
    idempotencyKey: wrongValidation.idempotencyKey,
    passed: true,
    evidence: [{ id: "wrong-V", kind: "validation", target: "npm test", version: null }],
  }));
  assert.equal(
    runtime.deriveRuntimeV2PlanExecutionCoverage(state).allRequiredValidationsPassed,
    false,
  );

  const reviewedValidation = commandFor(state, "execute_validation", "reviewed-validation", {
    toolCallId: "reviewed-validation-call",
    toolName: "run_command",
    arguments: { command: "npm run build", cwd: "." },
  });
  state = runtime.transition(state, event(state, "command.scheduled", {
    run: baseRun,
    command: reviewedValidation,
  }));
  state = runtime.transition(state, event(state, "validation.completed", {
    run: baseRun,
    idempotencyKey: reviewedValidation.idempotencyKey,
    passed: true,
    evidence: [{ id: "reviewed-V", kind: "validation", target: "npm run build", version: null }],
  }));
  assert.equal(
    runtime.deriveRuntimeV2PlanExecutionCoverage(state).allRequiredValidationsPassed,
    true,
  );

  state = runtime.transition(state, event(state, "phase.changed", {
    run: baseRun,
    phase: "acting",
    reason: "a later correction is required",
  }));
  state = commitMutation(state, "later-correction", "src/main.js");
  assert.equal(
    runtime.deriveRuntimeV2PlanExecutionCoverage(state).allRequiredValidationsPassed,
    false,
  );
});

test("a rejected validation call stays in validating instead of forcing an unrelated source edit", () => {
  let state = executeAggregate("validating");
  const validation = commandFor(state, "execute_validation", "validation-scope-rejected", {
    toolCallId: "validation-scope-call",
    toolName: "run_command",
    arguments: { command: "npm test" },
  });
  state = runtime.transition(state, event(state, "command.scheduled", {
    run: baseRun,
    command: validation,
  }));
  state = runtime.transition(state, event(state, "validation.completed", {
    run: baseRun,
    idempotencyKey: validation.idempotencyKey,
    passed: false,
    failureKind: "not_authorized",
    evidence: [],
  }));
  assert.equal(runtime.decideRuntimeV2ExecutePhaseTransition(state, {
    isMutationToolName: (name) => name === "apply_patch",
  }), null);
});

test("Execute phase policy returns failed validation to acting without replaying stale failures", () => {
  const classifier = { isMutationToolName: (name) => name === "apply_patch" };
  let state = executeAggregate("validating");
  const validation = commandFor(state, "execute_validation", "validate-build", {
    toolCallId: "validation-call",
    toolName: "run_command",
    arguments: { command: "npm run build" },
  });
  state = runtime.transition(state, event(state, "command.scheduled", {
    run: baseRun,
    command: validation,
  }));
  state = runtime.transition(state, event(state, "validation.completed", {
    run: baseRun,
    idempotencyKey: validation.idempotencyKey,
    passed: false,
    evidence: [{ id: "phase-E4", kind: "validation", target: "npm run build", version: "failed" }],
  }));

  assert.deepEqual(runtime.decideRuntimeV2ExecutePhaseTransition(state, classifier), {
    from: "validating",
    to: "acting",
    reason: "validation_failed",
  });

  state = runtime.transition(state, event(state, "phase.changed", {
    run: baseRun,
    phase: "acting",
    reason: "repair the failed validation",
  }));
  state = runtime.transition(state, event(state, "phase.changed", {
    run: baseRun,
    phase: "validating",
    reason: "validate the correction",
  }));
  assert.equal(runtime.decideRuntimeV2ExecutePhaseTransition(state, classifier), null);

  let passing = executeAggregate("validating");
  const passingValidation = commandFor(passing, "execute_validation", "validate-pass", {
    toolCallId: "validation-pass-call",
    toolName: "run_command",
    arguments: { command: "npm run build" },
  });
  passing = runtime.transition(passing, event(passing, "command.scheduled", {
    run: baseRun,
    command: passingValidation,
  }));
  passing = runtime.transition(passing, event(passing, "validation.completed", {
    run: baseRun,
    idempotencyKey: passingValidation.idempotencyKey,
    passed: true,
    evidence: [{ id: "phase-E5", kind: "validation", target: "npm run build", version: "passed" }],
  }));
  assert.equal(runtime.decideRuntimeV2ExecutePhaseTransition(passing, classifier), null);
});

test("Execute completion facts are reconstructed from durable mutation and validation receipts", () => {
  const classifier = { isMutationToolName: (name) => name === "apply_patch" };
  let state = executeAggregate("acting");
  const mutation = commandFor(state, "execute_tool", "mutation-durable", {
    toolCallId: "mutation-call",
    toolName: "apply_patch",
    arguments: { patch: "*** Begin Patch\n*** End Patch" },
  });
  state = runtime.transition(state, event(state, "command.scheduled", {
    run: baseRun,
    command: mutation,
  }));
  state = runtime.transition(state, event(state, "tool.completed", {
    run: baseRun,
    idempotencyKey: mutation.idempotencyKey,
    status: "succeeded",
    evidence: [{ id: "M1", kind: "mutation", target: "src/main.js", version: "v2" }],
  }));
  state = runtime.transition(state, event(state, "phase.changed", {
    run: baseRun,
    phase: "validating",
    reason: "mutation_committed",
  }));
  const validation = commandFor(state, "execute_validation", "validation-durable", {
    toolCallId: "validation-call",
    toolName: "run_command",
    arguments: { command: "npm test" },
  });
  state = runtime.transition(state, event(state, "command.scheduled", {
    run: baseRun,
    command: validation,
  }));
  state = runtime.transition(state, event(state, "validation.completed", {
    run: baseRun,
    idempotencyKey: validation.idempotencyKey,
    passed: true,
    evidence: [{ id: "V1", kind: "validation", target: "npm test", version: null }],
  }));

  assert.deepEqual(runtime.summarizeRuntimeV2ExecuteEvidence(state, classifier), {
    mutationCount: 1,
    passedValidationCount: 1,
    failedOperationCount: 0,
  });
});

test("runtime-owned plan artifact writes are not counted as project mutations", () => {
  const classifier = { isMutationToolName: (name) => name === "write_file" };
  let state = executeAggregate("acting");
  const artifact = commandFor(state, "execute_tool", "runtime-plan-artifact", {
    toolName: "write_file",
    target: ".MAIN/plans/plan.md",
    runtimeOwnedPlanArtifact: true,
  });
  state = runtime.transition(state, event(state, "command.scheduled", {
    run: baseRun,
    command: artifact,
  }));
  state = runtime.transition(state, event(state, "tool.completed", {
    run: baseRun,
    idempotencyKey: artifact.idempotencyKey,
    status: "succeeded",
    evidence: [{
      id: "plan-artifact",
      kind: "tool",
      target: ".MAIN/plans/plan.md",
      version: "projection-v1",
    }],
  }));

  assert.deepEqual(runtime.summarizeRuntimeV2ExecuteEvidence(state, classifier), {
    mutationCount: 0,
    passedValidationCount: 0,
    failedOperationCount: 0,
  });
});

test("completion gate never treats an unexecuted provider analysis as a partial result", () => {
  let state = runtime.transition(null, event(null, "turn.admitted", {
    turn: baseTurn,
    strategy: "execute",
    objective: "Repair the fixture",
    constraints: [],
    acceptanceCriteria: [],
  }));
  state = runtime.transition(state, event(state, "run.started", { run: baseRun, phase: "observing" }));

  assert.equal(runtime.decideRuntimeV2TerminalOutcome(state, {
    canceled: false,
    mutationCount: 0,
    passedValidationCount: 0,
    hasProviderConclusion: true,
  }), null);

  assert.deepEqual(runtime.decideRuntimeV2TerminalOutcome(state, {
    canceled: false,
    mutationCount: 1,
    passedValidationCount: 1,
    hasProviderConclusion: true,
  }), {
    resultKind: "success",
    resultReason: "已完成修改，并通过结构化验证结果确认。",
  });
});

test("tool-call transport ids do not create unlimited recovery fingerprints", () => {
  const base = {
    kind: "execute_tool",
    phase: "acting",
    payload: {
      toolName: "apply_patch",
      arguments: { path: "src/main.js", patch: "@@" },
    },
  };
  assert.equal(
    runtime.runtimeV2ActionFingerprint({ ...base, payload: { ...base.payload, toolCallId: "provider-call-a" } }),
    runtime.runtimeV2ActionFingerprint({ ...base, payload: { ...base.payload, toolCallId: "provider-call-b" } }),
  );
});

test("controller commits child jobs before the scheduler can open either request", async () => {
  let now = 200;
  let id = 0;
  let revision = 0;
  const ledger = [];
  const jobs = ["frontend", "backend"].map((scopeKey, index) => ({
    id: `child-${index + 1}`,
    run: { ...baseRun, runId: `child-run-${index + 1}`, parentRunId: baseRun.runId, attemptId: `child-attempt-${index + 1}` },
    parentRunId: baseRun.runId,
    scopeKey,
    objective: `inspect ${scopeKey}`,
    allowedPaths: [index === 0 ? "src" : "src-tauri"],
    status: "queued",
    requestedAt: now,
    firstTokenAt: null,
    closedAt: null,
    summary: null,
  }));
  const ports = {
    checkpoint: {
      async load() { return null; },
      async append({ event }) {
        ledger.push(event);
        revision += 1;
        return { disposition: "committed", checkpoint: { revision, event } };
      },
    },
    provider: { async request() { throw new Error("provider should not run before child scheduling"); } },
    tool: { async execute() { throw new Error("tool should not run before child scheduling"); } },
    scheduler: {
      async prepareSchedule() {
        return { type: "subagents.scheduled", run: baseRun, jobs };
      },
      async execute({ command }) {
        assert.equal(command.kind, "schedule_subagents");
        assert.equal(ledger.filter((item) => item.type === "subagents.scheduled").length, 1);
        return jobs.map((job) => ({
          type: "subagent.telemetry",
          run: baseRun,
          telemetry: { jobId: job.id, phase: "request_opened", at: ++now },
        }));
      },
    },
    projection: { async publish() {} },
    clockId: {
      now: () => ++now,
      nextId: (scope) => `${scope}-${++id}`,
      nextIdempotencyKey: ({ run, kind }) => `${run.runId}:${kind}:${++id}`,
    },
  };
  const controller = new runtime.RuntimeV2Controller(ports);
  await controller.admit({ turn: baseTurn, run: baseRun, strategy: "execute", objective: "Repair the fixture" });
  await controller.changePhase("observing", "initial observation is complete");
  await controller.driveOnce({ allowReadOnlySubagents: true, hasReadOnlySubagentScopes: true });
  const aggregate = controller.snapshot().aggregate;
  assert.equal(aggregate.subagents.length, 2);
  assert.deepEqual(aggregate.subagents.map((job) => job.status), ["running", "running"]);
  assert.ok(ledger.findIndex((item) => item.type === "subagents.scheduled") < ledger.findIndex((item) => item.type === "subagent.telemetry"));
});

test("controller resumes an already committed child schedule without allocating duplicate jobs", async () => {
  let state = executeAggregate("observing");
  const schedule = commandFor(state, "schedule_subagents", "schedule-resume", {
    mode: "read_only",
    objective: "Repair the fixture",
  });
  const jobs = ["frontend", "backend"].map((scopeKey, index) => ({
    id: `resume-child-${index + 1}`,
    run: {
      ...baseRun,
      runId: `resume-child-run-${index + 1}`,
      parentRunId: baseRun.runId,
      attemptId: `resume-child-attempt-${index + 1}`,
    },
    parentRunId: baseRun.runId,
    scopeKey,
    objective: `inspect ${scopeKey}`,
    allowedPaths: [index === 0 ? "src" : "src-tauri"],
    status: "queued",
    requestedAt: state.updatedAt + 1,
    firstTokenAt: null,
    closedAt: null,
    summary: null,
  }));
  state = runtime.transition(state, event(state, "command.scheduled", {
    run: baseRun,
    command: schedule,
  }));
  state = runtime.transition(state, event(state, "subagents.scheduled", {
    run: baseRun,
    jobs,
  }));
  for (const job of jobs) {
    state = runtime.transition(state, event(state, "subagent.telemetry", {
      run: baseRun,
      telemetry: { jobId: job.id, phase: "request_opened", at: state.updatedAt + 1 },
    }));
  }

  let revision = state.events.length;
  let prepareCalls = 0;
  let executeCalls = 0;
  const controller = new runtime.RuntimeV2Controller({
    checkpoint: {
      async load() { return null; },
      async append({ event: appended }) {
        revision += 1;
        return { disposition: "committed", checkpoint: { revision, event: appended } };
      },
    },
    provider: { async request() { throw new Error("provider is not expected"); } },
    tool: { async execute() { throw new Error("tool is not expected"); } },
    scheduler: {
      async prepareSchedule() {
        prepareCalls += 1;
        throw new Error("resume must not allocate another child pair");
      },
      async execute({ command, scheduledSubagents }) {
        executeCalls += 1;
        assert.equal(command.kind, "schedule_subagents");
        assert.deepEqual(scheduledSubagents.map((job) => job.id), jobs.map((job) => job.id));
        assert.deepEqual(scheduledSubagents.map((job) => job.status), ["running", "running"]);
        return [];
      },
    },
    projection: { async publish() {} },
    clockId: {
      now: () => state.updatedAt + revision + 1,
      nextId: (scope) => `${scope}-resume-${revision}`,
      nextIdempotencyKey: ({ run, kind }) => `${run.runId}:${kind}:resume`,
    },
  }, { aggregate: state, revision });

  assert.equal(await controller.resumeScheduled(), true);
  const resumed = controller.snapshot().aggregate;
  assert.equal(prepareCalls, 0);
  assert.equal(executeCalls, 1);
  assert.equal(resumed.scheduledCommands.length, 0);
  assert.equal(resumed.completedCommands.at(-1).idempotencyKey, schedule.idempotencyKey);
  assert.equal(resumed.subagents.length, 2);
});

test("soft iteration pressure is durable but never terminal by itself", async () => {
  let now = 700;
  let revision = 0;
  const controller = new runtime.RuntimeV2Controller({
    checkpoint: {
      async load() { return null; },
      async append({ event: appended }) {
        revision += 1;
        return { disposition: "committed", checkpoint: { revision, event: appended } };
      },
    },
    provider: { async request() { throw new Error("provider is not expected"); } },
    tool: { async execute() { throw new Error("tool is not expected"); } },
    scheduler: { async execute() { throw new Error("scheduler is not expected"); } },
    projection: { async publish() {} },
    clockId: {
      now: () => ++now,
      nextId: (scope) => `${scope}-soft-${now}`,
      nextIdempotencyKey: ({ run, kind }) => `${run.runId}:${kind}:soft`,
    },
  });
  await controller.admit({
    turn: baseTurn,
    run: baseRun,
    strategy: "execute",
    objective: "Repair the fixture",
  });
  const before = controller.snapshot().aggregate;
  await controller.recordSoftSignal("iteration_limit");
  const after = controller.snapshot().aggregate;
  assert.equal(after.phase, before.phase);
  assert.equal(after.terminalOutcome, null);
  assert.equal(after.recovery.exhausted, null);
  assert.equal(
    after.events.filter((item) =>
      item.type === "soft_signal.observed" && item.signal === "iteration_limit"
    ).length,
    1,
  );
});

test("an aborted Turn settles the scheduled lifecycle as canceled without calling the provider", async () => {
  let now = 300;
  let id = 0;
  let revision = 0;
  let providerCalls = 0;
  const abort = new AbortController();
  const ports = {
    checkpoint: {
      async load() { return null; },
      async append({ event }) {
        revision += 1;
        return { disposition: "committed", checkpoint: { revision, event } };
      },
    },
    provider: { async request() { providerCalls += 1; return { toolCalls: [], diagnostics: [] }; } },
    tool: { async execute() { throw new Error("tool should not run after cancel"); } },
    scheduler: { async execute() { throw new Error("scheduler should not run after cancel"); } },
    projection: { async publish() {} },
    clockId: {
      now: () => ++now,
      nextId: (scope) => `${scope}-${++id}`,
      nextIdempotencyKey: ({ run, kind }) => `${run.runId}:${kind}:${++id}`,
    },
  };
  const controller = new runtime.RuntimeV2Controller(ports, undefined, { abortSignal: abort.signal });
  await controller.admit({ turn: baseTurn, run: baseRun, strategy: "execute", objective: "Repair the fixture" });
  abort.abort(new Error("user canceled"));
  assert.equal(await controller.driveOnce(), false);
  const aggregate = controller.snapshot().aggregate;
  assert.equal(providerCalls, 0);
  assert.equal(aggregate.terminalOutcome.resultKind, "canceled");
  assert.deepEqual(
    aggregate.events
      .filter((item) =>
        item.type === "run.aborted" ||
        item.type === "run.completed" ||
        item.type === "turn.completed"
      )
      .map((item) => item.type),
    ["run.aborted", "run.completed", "turn.completed"],
  );
  assert.equal(aggregate.events.filter((item) => item.type === "turn.completed").length, 1);
});

test("failed structured validation clears its pending call and consumes a bounded recovery receipt", async () => {
  let now = 400;
  let id = 0;
  let revision = 0;
  const ports = {
    checkpoint: {
      async load() { return null; },
      async append({ event }) {
        revision += 1;
        return { disposition: "committed", checkpoint: { revision, event } };
      },
    },
    provider: {
      async request() {
        return {
          toolCalls: [{ id: "validation-call-1", name: "run_command", arguments: { command: "npm run build" } }],
          diagnostics: [],
        };
      },
    },
    tool: {
      async execute({ command }) {
        assert.equal(command.kind, "execute_validation");
        return {
          type: "validation.completed",
          run: command.run,
          idempotencyKey: command.idempotencyKey,
          passed: false,
          evidence: [],
        };
      },
    },
    scheduler: { async execute() { throw new Error("scheduler is not expected"); } },
    projection: { async publish() {} },
    clockId: {
      now: () => ++now,
      nextId: (scope) => `${scope}-${++id}`,
      nextIdempotencyKey: ({ run, kind }) => `${run.runId}:${kind}:${++id}`,
    },
  };
  const controller = new runtime.RuntimeV2Controller(ports);
  await controller.admit({
    turn: baseTurn,
    run: baseRun,
    strategy: "execute",
    objective: "Repair the fixture",
    initialPhase: "validating",
  });
  await controller.driveOnce();
  await controller.driveOnce();
  const aggregate = controller.snapshot().aggregate;
  assert.equal(aggregate.pendingToolCalls.length, 0);
  assert.equal(aggregate.completedCommands.at(-1).kind, "execute_validation");
  assert.equal(aggregate.completedCommands.at(-1).status, "failed");
  assert.equal(aggregate.recovery.actionRepeats, 0);
  assert.equal(aggregate.recovery.diagnosticRepairs, 1);
});
