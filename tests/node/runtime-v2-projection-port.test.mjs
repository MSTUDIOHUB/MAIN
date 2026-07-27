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

const {
  createRuntimeV2ProjectionPort,
} = loadTs(path.join(workspaceRoot, "src/store/runtimeV2/projectionPort.ts"));
const {
  buildLiveTurnProcessTimelineModel,
} = loadTs(path.join(workspaceRoot, "src/lib/turnProcessArchive.ts"));
const {
  projectSubagentRuns,
} = loadTs(path.join(workspaceRoot, "src/lib/subagents.ts"));

const runIdentity = {
  sessionKey: "session-a",
  sessionEpoch: "epoch-a",
  turnId: "turn-a",
  runId: "run-a",
  parentRunId: null,
  attemptId: "attempt-a",
};

function command(overrides = {}) {
  return {
    idempotencyKey: "run-a:acting:execute_tool:attempt-1",
    kind: "execute_tool",
    run: runIdentity,
    phase: "acting",
    payload: {
      toolName: "replace_in_file",
      arguments: { path: "src/components/editor.js" },
    },
    ...overrides,
  };
}

function aggregate(overrides = {}) {
  return {
    schemaVersion: "turn-aggregate.v1",
    turn: {
      workspaceKey: "/fixture",
      sessionKey: "session-a",
      sessionEpoch: "epoch-a",
      clientSubmissionId: "submission-a",
      turnId: "turn-a",
    },
    strategy: "execute",
    objective: {
      text: "Fix the fixture",
      constraints: [],
      acceptanceCriteria: [],
    },
    run: {
      identity: runIdentity,
      status: "running",
      phase: "acting",
      terminalOutcome: null,
    },
    phase: "acting",
    events: [],
    evidence: [],
    workPlan: null,
    scheduledCommands: [],
    completedCommands: [],
    pendingToolCalls: [],
    subagents: [],
    recovery: { epoch: 0, receipts: [], exhausted: null },
    terminalOutcome: null,
    finalProjectionId: null,
    nextSequence: 0,
    updatedAt: 1,
    ...overrides,
  };
}

function projection(kind, markdown, dedupeKey, id = `${kind}-1`) {
  return {
    id,
    audience: kind === "timeline"
      ? "timeline"
      : kind === "milestone"
        ? "chat_milestone"
        : "capsule_live",
    markdown,
    kind,
    dedupeKey,
  };
}

function createHarness(language = "zh") {
  let nextId = 1;
  const logs = [];
  let state = {
    harnessRunMarker: {
      sessionKey: "session-a",
      turnId: "turn-a",
      runId: "run-a",
      status: "running",
    },
    runtimeEvents: [],
    taskFlow: [{ id: 1, turnId: "turn-a", type: "user", content: "Fix it" }],
    conversationTurns: [{ id: "turn-a", blockIds: [1] }],
  };
  const port = createRuntimeV2ProjectionPort({
    get: () => state,
    set: (updater) => {
      const patch = typeof updater === "function" ? updater(state) : updater;
      state = { ...state, ...patch };
    },
    nextTaskId: () => ++nextId,
    language,
    logStoreEvent(event, data) {
      logs.push({ event, data });
    },
  });
  return { port, getState: () => state, logs };
}

test("V2 timeline projects scheduled commands into visible process blocks and settles from receipts", async () => {
  const harness = createHarness();
  const edit = command();
  const scheduled = aggregate({ scheduledCommands: [edit] });
  await harness.port.publish({
    aggregate: scheduled,
    audience: "timeline",
    projection: projection(
      "timeline",
      "正在修改 `src/components/editor.js`，落实已经确认的修复方案。",
      "turn-a:command:edit-1",
    ),
  });

  let state = harness.getState();
  let timelineBlocks = state.taskFlow.filter((block) =>
    block.type === "progress" && String(block.dedupeKey || "").startsWith("runtime-v2-timeline:")
  );
  assert.equal(timelineBlocks.length, 1);
  assert.equal(timelineBlocks[0].status, "running");
  assert.equal(timelineBlocks[0].target, "src/components/editor.js");
  assert.equal(timelineBlocks[0].source, "runtime");
  assert.match(timelineBlocks[0].title, /editor\.js/);
  assert.ok(state.conversationTurns[0].blockIds.includes(timelineBlocks[0].id));
  assert.equal(
    state.runtimeEvents.filter((event) => event.type === "item.completed").length,
    0,
    "scheduling a command must not invent a completed timeline event",
  );
  const liveModel = buildLiveTurnProcessTimelineModel({
    blocks: state.taskFlow,
    language: "zh",
    includeThoughts: false,
  });
  assert.equal(liveModel.stepCount, 1);
  assert.match(liveModel.steps[0].intent, /editor\.js/);

  await harness.port.publish({
    aggregate: aggregate({
      completedCommands: [{
        idempotencyKey: edit.idempotencyKey,
        kind: edit.kind,
        actionFingerprint: "edit",
        status: "succeeded",
        completedAt: 2,
      }],
    }),
    audience: "capsule_live",
    projection: projection("live_action", "正在等待下一项结构化动作。", "turn-a:phase:acting"),
  });

  state = harness.getState();
  timelineBlocks = state.taskFlow.filter((block) =>
    block.type === "progress" && String(block.dedupeKey || "").startsWith("runtime-v2-timeline:")
  );
  assert.equal(timelineBlocks.length, 1);
  assert.equal(timelineBlocks[0].status, "done");
});

test("V2 timeline records an unmet acceptance check without presenting the task as paused", async () => {
  const harness = createHarness();
  const validation = command({
    idempotencyKey: "run-a:validating:execute_validation:build",
    kind: "execute_validation",
    phase: "validating",
    payload: {
      toolName: "run_command",
      arguments: { command: "npm run build" },
    },
  });
  await harness.port.publish({
    aggregate: aggregate({
      phase: "validating",
      scheduledCommands: [validation],
    }),
    audience: "timeline",
    projection: projection(
      "timeline",
      "正在运行有限验证，检查本轮修改和验收条件。",
      "turn-a:command:validation-1",
    ),
  });
  await harness.port.publish({
    aggregate: aggregate({
      phase: "validating",
      events: [{
        type: "validation.completed",
        idempotencyKey: validation.idempotencyKey,
        passed: false,
      }],
      completedCommands: [{
        idempotencyKey: validation.idempotencyKey,
        kind: validation.kind,
        actionFingerprint: "validation",
        status: "succeeded",
        completedAt: 2,
      }],
    }),
    audience: "capsule_live",
    projection: projection(
      "live_action",
      "正在根据验证结果准备下一项修复。",
      "turn-a:phase:acting",
    ),
  });

  const state = harness.getState();
  const block = state.taskFlow.find((item) =>
    item.type === "progress" &&
    item.toolCallId === validation.idempotencyKey
  );
  assert.equal(block.status, "failed");
  assert.match(block.evidence, /验证未通过/);
  const timeline = buildLiveTurnProcessTimelineModel({
    blocks: state.taskFlow,
    language: "zh",
    includeThoughts: false,
  });
  assert.equal(timeline.steps[0].kind, "verify");
  assert.equal(timeline.steps[0].activity.label, "验证未通过");
});

test("V2 timeline retains each concrete command as an ordered record", async () => {
  const harness = createHarness();
  const first = command({
    idempotencyKey: "run-a:acting:execute_tool:read-editor",
    payload: {
      toolName: "read_file",
      arguments: { path: "src/components/editor.js" },
    },
  });
  const second = command({
    idempotencyKey: "run-a:acting:execute_tool:read-toolbar",
    payload: {
      toolName: "read_file",
      arguments: { path: "src/components/toolbar.js" },
    },
  });
  for (const [index, item] of [first, second].entries()) {
    await harness.port.publish({
      aggregate: aggregate({ scheduledCommands: [item] }),
      audience: "timeline",
      projection: projection(
        "timeline",
        `正在读取 \`${item.payload.arguments.path}\`。`,
        `turn-a:command:read-${index + 1}`,
        `timeline-${index + 1}`,
      ),
    });
  }

  const model = buildLiveTurnProcessTimelineModel({
    blocks: harness.getState().taskFlow,
    language: "zh",
    includeThoughts: false,
  });
  assert.equal(model.stepCount, 2);
  assert.match(model.steps[0].intent, /editor\.js/);
  assert.match(model.steps[1].intent, /toolbar\.js/);
  assert.ok(model.steps[0].sourceIndex < model.steps[1].sourceIndex);
});

test("V2 timeline keeps validation targets complete, omits raw output, and removes canceled provisional rows", async () => {
  const harness = createHarness();
  const validation = command({
    idempotencyKey: "run-a:validating:execute_validation:attempt-1",
    kind: "execute_validation",
    phase: "validating",
    payload: {
      toolName: "run_command",
      arguments: { command: "npm run build -- --mode validation" },
    },
  });
  await harness.port.publish({
    aggregate: aggregate({
      phase: "validating",
      run: { identity: runIdentity, status: "running", phase: "validating", terminalOutcome: null },
      scheduledCommands: [validation],
    }),
    audience: "timeline",
    projection: projection(
      "timeline",
      "正在运行 `npm run build -- --mode validation`，验证最新修改是否符合预期。",
      "turn-a:command:validation-1",
    ),
  });

  let state = harness.getState();
  const validationBlock = state.taskFlow.find((block) => block.toolCallId === validation.idempotencyKey);
  assert.ok(validationBlock);
  assert.equal(validationBlock.phase, "verifying");
  assert.equal(validationBlock.target, "npm run build -- --mode validation");
  assert.doesNotMatch(JSON.stringify(validationBlock), /SECRET_TOOL_OUTPUT/);

  await harness.port.publish({
    aggregate: aggregate({
      phase: "validating",
      completedCommands: [{
        idempotencyKey: validation.idempotencyKey,
        kind: validation.kind,
        actionFingerprint: "validation",
        status: "canceled",
        completedAt: 2,
      }],
    }),
    audience: "capsule_live",
    projection: projection("live_action", "正在整理结论。", "turn-a:phase:finalizing"),
  });
  state = harness.getState();
  assert.equal(
    state.taskFlow.filter((block) => block.toolCallId === validation.idempotencyKey).length,
    0,
  );
});

test("V2 Chat milestones remain durable assistant updates rather than timeline narration", async () => {
  const harness = createHarness();
  await harness.port.publish({
    aggregate: aggregate(),
    audience: "chat_milestone",
    projection: projection(
      "milestone",
      "### 已启动并行只读调查\n\n- 前端和后端范围已经分别分配。",
      "turn-a:subagents:frontend:backend",
    ),
  });

  const state = harness.getState();
  const milestone = state.taskFlow.find((block) => block.type === "agent");
  assert.ok(milestone);
  assert.equal(milestone.visibility, "assistant_update");
  assert.equal(milestone.hiddenProcess, false);
  assert.equal(
    state.taskFlow.filter((block) =>
      block.type === "progress" && String(block.dedupeKey || "").startsWith("runtime-v2-timeline:")
    ).length,
    0,
  );
});

test("V2 child ledger reconciles into ChatArea and Subagents panel lifecycle records", async () => {
  const harness = createHarness();
  const childRun = (suffix) => ({
    ...runIdentity,
    runId: `child-${suffix}`,
    parentRunId: runIdentity.runId,
    attemptId: `child-${suffix}`,
  });
  const jobs = ["frontend", "backend"].map((scope, index) => ({
    id: `job-${scope}`,
    run: childRun(scope),
    parentRunId: runIdentity.runId,
    scopeKey: scope,
    objective: `Inspect ${scope}`,
    allowedPaths: [index === 0 ? "src" : "src-tauri"],
    status: "completed",
    requestedAt: 10 + index,
    firstTokenAt: 20 + index,
    closedAt: 30 + index,
    summary: `${scope} evidence`,
  }));
  const events = [
    {
      type: "subagents.scheduled",
      eventId: "event-scheduled",
      at: 10,
      run: runIdentity,
      jobs: jobs.map((job) => ({
        ...job,
        status: "queued",
        firstTokenAt: null,
        closedAt: null,
        summary: null,
      })),
    },
    ...jobs.flatMap((job, index) => [
      {
        type: "subagent.telemetry",
        eventId: `event-open-${job.id}`,
        at: 12 + index,
        run: runIdentity,
        telemetry: {
          jobId: job.id,
          phase: "request_opened",
          at: 12 + index,
        },
      },
      {
        type: "subagent.telemetry",
        eventId: `event-token-${job.id}`,
        at: 20 + index,
        run: runIdentity,
        telemetry: {
          jobId: job.id,
          phase: "first_token",
          at: 20 + index,
        },
      },
      {
        type: "subagent.completed",
        eventId: `event-complete-${job.id}`,
        at: 30 + index,
        run: runIdentity,
        jobId: job.id,
        status: "completed",
        summary: job.summary,
        evidence: [{
          id: `evidence-${job.id}`,
          kind: "subagent",
          target: job.allowedPaths[0],
          version: null,
        }],
      },
    ]),
  ];
  const childAggregate = aggregate({
    events,
    subagents: jobs,
  });

  await harness.port.publish({
    aggregate: childAggregate,
    audience: "capsule_live",
    projection: projection(
      "live_action",
      "正在汇合子智能体证据。",
      "turn-a:children:joined",
    ),
  });
  await harness.port.publish({
    aggregate: childAggregate,
    audience: "capsule_live",
    projection: projection(
      "live_action",
      "正在汇合子智能体证据。",
      "turn-a:children:joined",
      "live-action-repeat",
    ),
  });

  const state = harness.getState();
  const runs = projectSubagentRuns(state.runtimeEvents);
  assert.equal(runs.length, 2);
  assert.deepEqual(runs.map((run) => run.status), ["completed", "completed"]);
  assert.ok(runs.every((run) => run.closedAt));
  assert.ok(runs.every((run) => run.closureAudit?.state === "satisfied"));
  assert.equal(
    state.runtimeEvents.filter((event) => event.type === "subagent.created").length,
    2,
  );
  assert.equal(
    state.runtimeEvents.filter((event) => event.type === "subagent.completed").length,
    2,
  );
  assert.equal(
    state.runtimeEvents.filter((event) => event.type === "subagent.closed").length,
    2,
  );
  assert.equal(harness.logs.at(-1)?.data?.subagentRecordCount, 2);
});

test("V2 keeps runtime-owned Plan artifact writes out of the user timeline", async () => {
  const harness = createHarness();
  const artifactWrite = command({
    idempotencyKey: "run-a:planning:plan-artifact:attempt-1",
    payload: {
      toolName: "write_file",
      target: ".MAIN/plans/plan.md",
      runtimeOwnedPlanArtifact: true,
    },
  });
  await harness.port.publish({
    aggregate: aggregate({
      phase: "planning",
      run: { identity: runIdentity, status: "running", phase: "planning", terminalOutcome: null },
      scheduledCommands: [artifactWrite],
    }),
    audience: "timeline",
    projection: projection(
      "timeline",
      "正在写入 `.MAIN/plans/plan.md`。",
      "turn-a:command:plan-artifact",
    ),
  });

  assert.equal(
    harness.getState().taskFlow.filter((block) =>
      block.type === "progress" && block.toolCallId === artifactWrite.idempotencyKey
    ).length,
    0,
  );
  assert.equal(
    harness.logs.at(-1)?.data?.storeDisposition,
    "suppressed_internal",
  );
});

test("V2 keeps provider and plan control-plane commands out of the user timeline", async () => {
  const harness = createHarness();
  const internalCommands = [
    command({
      idempotencyKey: "run-a:planning:request-model:attempt-1",
      kind: "request_model",
      phase: "planning",
      payload: { mode: "plan" },
    }),
    command({
      idempotencyKey: "run-a:planning:submit-plan:attempt-1",
      phase: "planning",
      payload: {
        toolName: "submit_runtime_v2_work_plan",
        runtimeControlPlane: true,
      },
    }),
  ];

  for (const internalCommand of internalCommands) {
    await harness.port.publish({
      aggregate: aggregate({
        phase: "planning",
        run: {
          identity: runIdentity,
          status: "running",
          phase: "planning",
          terminalOutcome: null,
        },
        scheduledCommands: [internalCommand],
      }),
      audience: "timeline",
      projection: projection(
        "timeline",
        "内部协议动作不应成为用户步骤。",
        internalCommand.idempotencyKey,
      ),
    });
  }

  assert.equal(
    harness.getState().taskFlow.filter((block) =>
      block.type === "progress" &&
      String(block.dedupeKey || "").startsWith("runtime-v2-timeline:")
    ).length,
    0,
  );
  assert.ok(harness.logs.every((entry) =>
    entry.data?.storeDisposition === "suppressed_internal"
  ));
});

test("V2 projection logs distinguish a stale Store owner from publication", async () => {
  const harness = createHarness();
  const staleAggregate = aggregate({
    run: {
      identity: { ...runIdentity, runId: "run-stale" },
      status: "running",
      phase: "acting",
      terminalOutcome: null,
    },
  });
  await harness.port.publish({
    aggregate: staleAggregate,
    audience: "chat_milestone",
    projection: projection(
      "milestone",
      "### 不应进入当前会话",
      "turn-a:stale",
    ),
  });

  assert.equal(harness.getState().taskFlow.length, 1);
  assert.equal(harness.logs.at(-1)?.event, "runtime_v2_projection_skipped");
  assert.equal(harness.logs.at(-1)?.data?.storeDisposition, "owner_mismatch");
});

test("V2 canceled final projection preserves the canonical abort-complete-turn order", async () => {
  const harness = createHarness();
  await harness.port.publish({
    aggregate: aggregate({
      phase: "completed",
      run: {
        identity: runIdentity,
        status: "completed",
        phase: "completed",
        terminalOutcome: {
          resultKind: "canceled",
          reason: "user_canceled",
          completedAt: 2,
          finalProjectionId: "final-canceled",
        },
      },
      terminalOutcome: {
        resultKind: "canceled",
        reason: "user_canceled",
        completedAt: 2,
        finalProjectionId: "final-canceled",
      },
      finalProjectionId: "final-canceled",
    }),
    audience: "final",
    projection: {
      id: "final-canceled",
      audience: "final",
      markdown: "### 已取消\n\n本轮已按用户请求停止。",
      kind: "final",
      dedupeKey: "turn-a:final:canceled:user_canceled",
    },
  });

  const state = harness.getState();
  assert.deepEqual(
    state.runtimeEvents
      .filter((event) =>
        event.type === "run.aborted" ||
        event.type === "run.completed" ||
        event.type === "turn.completed"
      )
      .map((event) => event.type),
    ["run.aborted", "run.completed", "turn.completed"],
  );
  assert.equal(
    state.runtimeEvents.find((event) => event.type === "run.completed")?.resultKind,
    "canceled",
  );
  assert.equal(
    state.runtimeEvents.find((event) => event.type === "turn.completed")?.resultKind,
    "canceled",
  );
});
