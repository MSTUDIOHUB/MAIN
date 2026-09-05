import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";

const workspaceRoot = process.cwd();

function loadTs(sourcePath) {
  const normalized = path.resolve(sourcePath);
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
  new Function("exports", "module", "require", output)(
    module.exports,
    module,
    localRequire,
  );
  return module.exports;
}

const overlap = loadTs(
  path.join(
    workspaceRoot,
    "src/store/runtimeV2/executionSubagentOverlap.ts",
  ),
);
const structural = loadTs(
  path.join(
    workspaceRoot,
    "tests/e2e/runtimeV2StructuralAssertions.ts",
  ),
);

const run = {
  sessionKey: "session-a",
  sessionEpoch: "epoch-a",
  turnId: "turn-a",
  runId: "run-a",
  parentRunId: null,
  attemptId: "attempt-a",
};

function commandEvent(sequence, at, idempotencyKey, kind) {
  return {
    type: "command.scheduled",
    sequence,
    at,
    command: {
      idempotencyKey,
      kind,
      run,
      phase: "planning",
      payload: {},
    },
  };
}

function job() {
  return {
    id: "child-a",
    run: { ...run, runId: "run-a:child:child-a", parentRunId: "run-a" },
    parentRunId: "run-a",
    scopeKey: "review-a",
    objective: "Review the source.",
    allowedPaths: ["snake.py"],
    status: "completed",
    requestedAt: 100,
    firstTokenAt: 110,
    closedAt: 300,
    summary: "Reviewed.",
  };
}

function aggregate(events) {
  return { events };
}

test("wait-only parent requests are lifecycle overlap, not evidence progress", () => {
  const events = [
    {
      type: "subagent.telemetry",
      sequence: 1,
      at: 100,
      telemetry: { jobId: "child-a", phase: "request_opened", at: 100 },
    },
    commandEvent(2, 120, "parent-request", "request_model"),
    {
      type: "provider.responded",
      sequence: 3,
      at: 180,
      idempotencyKey: "parent-request",
      result: {
        visibleText: "",
        toolCalls: [{ id: "wait", name: "wait_subagents", arguments: {} }],
      },
    },
  ];

  assert.equal(
    overlap.runtimeV2ParentCommandLifecycleOverlapMs({
      aggregate: aggregate(events),
      jobs: [job()],
      measuredAt: 300,
    }),
    60,
  );
  assert.equal(
    overlap.runtimeV2ParentEvidenceProgressOverlapMs({
      aggregate: aggregate(events),
      jobs: [job()],
      measuredAt: 300,
    }),
    0,
  );
});

test("successful novel parent evidence reports only its child-overlapped interval", () => {
  const events = [
    {
      type: "subagent.telemetry",
      sequence: 1,
      at: 100,
      telemetry: { jobId: "child-a", phase: "request_opened", at: 100 },
    },
    commandEvent(2, 120, "parent-request", "request_model"),
    {
      type: "provider.responded",
      sequence: 3,
      at: 180,
      idempotencyKey: "parent-request",
      result: { visibleText: "", toolCalls: [] },
    },
    commandEvent(4, 190, "parent-read", "execute_tool"),
    {
      type: "tool.completed",
      sequence: 5,
      at: 230,
      idempotencyKey: "parent-read",
      status: "succeeded",
      evidence: [{
        id: "parent-evidence-a",
        kind: "source",
        target: "snake.py",
        version: "sha256-a",
      }],
    },
  ];

  assert.equal(
    overlap.runtimeV2ParentEvidenceProgressOverlapMs({
      aggregate: aggregate(events),
      jobs: [job()],
      measuredAt: 300,
    }),
    40,
  );
});

test("replayed parent evidence is not new progress", () => {
  const events = [
    {
      type: "subagent.telemetry",
      sequence: 1,
      at: 100,
      telemetry: { jobId: "child-a", phase: "request_opened", at: 100 },
    },
    commandEvent(2, 120, "parent-replay", "execute_tool"),
    {
      type: "tool.completed",
      sequence: 3,
      at: 160,
      idempotencyKey: "parent-replay",
      status: "succeeded",
      receiptOrigin: "replayed",
      evidence: [{
        id: "parent-evidence-replayed",
        kind: "source",
        target: "snake.py",
        version: "sha256-a",
      }],
    },
  ];

  assert.equal(
    overlap.runtimeV2ParentEvidenceProgressOverlapMs({
      aggregate: aggregate(events),
      jobs: [job()],
      measuredAt: 300,
    }),
    0,
  );
});

test("E2E collaboration diagnostics separate lane overlap from evidence progress", () => {
  const runtime = {
    turnId: "turn-a",
    runId: "run-a",
    subagents: [{
      id: "child-a",
      requestOpenedAt: 100,
      closedAt: 300,
    }],
    commands: [{
      idempotencyKey: "parent-request",
      kind: "request_model",
      at: 120,
      completedAt: 180,
      status: "succeeded",
    }],
    events: [],
    debug: [{
      source: "store.model_lane_admission",
      data: {
        turnId: "turn-a",
        runId: "run-a",
        overlapping: true,
        liveRequests: [
          { agentKind: "subagent" },
          { agentKind: "parent" },
        ],
      },
    }],
  };

  assert.deepEqual(
    structural.runtimeV2CollaborationDiagnostics(runtime),
    {
      modelLaneOverlapObserved: true,
      parentEvidenceProgressOverlapMs: 0,
    },
  );
});
