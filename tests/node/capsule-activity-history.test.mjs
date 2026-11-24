import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";

const modules = new Map();
function loadTs(file) {
  file = path.resolve(file);
  if (modules.has(file)) return modules.get(file);
  const module = { exports: {} };
  modules.set(file, module.exports);
  const requireNative = createRequire(file);
  function requireSource(name) {
    if (name.startsWith(".")) {
      const base = path.resolve(path.dirname(file), name);
      for (const candidate of [base, `${base}.ts`, path.join(base, "index.ts")]) {
        if (candidate.endsWith(".ts") && fs.existsSync(candidate)) return loadTs(candidate);
      }
    }
    return requireNative(name);
  }
  const { outputText } = ts.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    fileName: file,
  });
  new Function("exports", "module", "require", outputText)(module.exports, module, requireSource);
  return module.exports;
}

const { buildCapsuleActivityHistory } = loadTs("src/lib/capsuleActivityHistory.ts");
const { describeCapsuleToolActivity } = loadTs("src/lib/capsuleToolActivity.ts");
const runtime = loadTs("src/lib/runtime-v2/index.ts");
const turn = {
  workspaceKey: "/fixture", sessionKey: "/fixture:1",
  sessionEpoch: "epoch", turnId: "turn", clientSubmissionId: "submission",
};
const run = {
  sessionKey: turn.sessionKey, sessionEpoch: turn.sessionEpoch, turnId: turn.turnId,
  runId: "run", parentRunId: null, attemptId: "attempt",
};
const owner = { ...turn, runId: run.runId, parentRunId: run.parentRunId, language: "zh" };

test("replayed Plan history shows tool results and user waits, not repeated status snapshots", () => {
  let state = null;
  const append = (type, fields) => {
    const sequence = state?.nextSequence || 0;
    const result = runtime.tryTransition(state, {
      type, schemaVersion: runtime.RUNTIME_V2_EVENT_SCHEMA_VERSION,
      sequence, eventId: `event-${sequence}`, at: 1_000 + sequence, ...fields,
    });
    assert.equal(result.disposition, "applied", result.reason);
    state = result.state;
  };
  const read = (id, receiptOrigin) => {
    append("command.scheduled", { run, command: {
      run, idempotencyKey: id, kind: "execute_tool", phase: "planning",
      payload: { toolName: "read_file", arguments: { path: "/fixture/Assets/SampleScene.unity" } },
    } });
    append("tool.completed", {
      run, idempotencyKey: id, status: "succeeded", receiptOrigin,
      evidence: [], modelContent: "private file bytes",
    });
  };
  append("turn.admitted", { turn, strategy: "plan", objective: "Design an app", constraints: [], acceptanceCriteria: [] });
  append("run.started", { run, phase: "planning" });
  for (const id of ["prepared-overview", "deferred-overview"]) {
    append("command.scheduled", { run, command: {
      run, idempotencyKey: id, kind: "collect_observation", phase: "planning", payload: {},
    } });
    append("command.completed", { run, idempotencyKey: id, status: "succeeded" });
    if (id === "prepared-overview") append("observation.recorded", {
      run, evidence: { id: "E1", kind: "source", target: "/fixture", version: null },
    });
  }
  for (let i = 0; i < 3; i++) {
    const projectionId = `snapshot-${i}`;
    append("projection.published", {
      run, projectionId, audience: "capsule_live",
      projection: {
        id: projectionId, audience: "capsule_live", kind: "activity",
        dedupeKey: projectionId, markdown: "正在形成计划",
      },
    });
  }
  read("initial-read", "executed");
  read("cache-replay", "replayed");
  append("run.paused", {
    run, blocker: {
      requestId: "question", reasonCode: "external_state_required",
      evidenceSequence: state.nextSequence - 1, message: "private answer instructions", options: ["recheck", "stop"],
    },
  });
  append("run.decision_recorded", { run, requestId: "question", choice: "recheck" });
  append("run.resumed", { run, requestId: "question" });
  const checkpoint = runtime.createRuntimeV2Checkpoint({
    aggregate: state, revision: state.nextSequence, updatedAt: state.updatedAt,
  });
  const saved = runtime.serializeRuntimeV2CheckpointMap({ [turn.turnId]: checkpoint })[turn.turnId];
  const restored = runtime.normalizeRuntimeV2Checkpoint(JSON.parse(JSON.stringify(saved)));
  assert.ok(restored);
  const rows = buildCapsuleActivityHistory({ ...owner, aggregate: restored.aggregate });
  assert.deepEqual(rows.map(({ key, title, target, outcome }) => [key, title, target, outcome]), [
    ["resume:question", "继续运行", undefined, "resumed"],
    ["wait:question", "暂停，等待处理", undefined, "waiting"],
    ["tool:initial-read", "读取文件", "Assets/SampleScene.unity", "succeeded"],
    ["tool:prepared-overview", "准备工作区概览", undefined, "succeeded"],
  ]);
  assert.deepEqual(buildCapsuleActivityHistory({ ...owner, runId: "next-run", aggregate: restored.aggregate }), []);
  assert.deepEqual(buildCapsuleActivityHistory({ ...owner, sessionEpoch: "stale", aggregate: restored.aggregate }), []);
});

test("history caps the result list and keeps failure, denied and skipped checks distinct", () => {
  const events = [];
  for (let i = 0; i < 7; i++) {
    const idempotencyKey = `check-${i}`;
    events.push({ type: "command.scheduled", run, command: {
      run, idempotencyKey, kind: "execute_validation", payload: { toolName: "run_command" },
    } });
    events.push({
      type: "validation.completed", run, idempotencyKey, at: i + 10,
      passed: i < 4,
      ...(i >= 4 ? { failureKind: ["assertion_failed", "not_authorized", "not_executed"][i - 4] } : {}),
      presentation: { toolName: "run_command", target: "command with secret", message: "raw output" },
    });
  }
  events.push({ ...events.at(-1), run: { ...run, attemptId: "earlier-attempt" }, at: 99, passed: true });
  const aggregate = { turn, run: { identity: run }, events };
  const rows = buildCapsuleActivityHistory({ ...owner, aggregate });
  assert.deepEqual(rows.map(row => row.outcome), ["not_executed", "blocked", "failed", "succeeded", "succeeded", "succeeded"]);
  assert.equal(rows[0].at, 16);
  assert.ok(rows.every(row => row.title === "运行检查" && row.target === undefined));
});

test("legacy history matches the session and Run and never turns progress snapshots into receipts", () => {
  const legacyBlocks = [
    { type: "tool", id: 1, turnId: run.turnId, runId: run.runId,
      toolCallId: "matched", toolName: "read_file", toolStatus: "executed", target: "Assets/SampleScene.unity" },
    { type: "tool", id: 2, turnId: run.turnId, runId: "other-run", parentRunId: null,
      toolCallId: "foreign", toolName: "read_file", toolStatus: "executed", target: "outside.unity" },
  ];
  const legacyEvents = [
    { type: "progress.updated", threadId: run.sessionKey, turnId: run.turnId, runId: run.runId,
      timestampMs: 111, progress: { title: "正在形成计划", status: "done" } },
    { type: "item.completed", threadId: run.sessionKey, turnId: run.turnId, timestampMs: 40,
      item: { details: { type: "tool_result", toolCallId: "matched", tool: "read_file",
        target: "Assets/SampleScene.unity", status: "completed", text: "raw content" } } },
    { type: "item.completed", threadId: run.sessionKey, turnId: run.turnId, runId: "other-run", timestampMs: 41,
      item: { details: { type: "tool_result", toolCallId: "matched", tool: "read_file",
        target: "foreign.unity", status: "completed", text: "foreign content" } } },
    { type: "approval.requested", threadId: "other-session", turnId: run.turnId,
      runId: run.runId, parentRunId: null, timestampMs: 120,
      actionKind: "tool_permission", requestId: "foreign-approval" },
  ];
  assert.deepEqual(buildCapsuleActivityHistory({ ...owner, legacyBlocks, legacyEvents }), [
    { key: "tool:matched", at: 40, title: "读取文件", target: "Assets/SampleScene.unity", outcome: "succeeded" },
  ]);
});

test("live and historic labels expose only approved display fields", () => {
  const describe = (toolName, target, options = {}) => describeCapsuleToolActivity({
    toolName, target, workspaceKey: "/fixture", language: "zh", ...options,
  });
  assert.deepEqual(describe("read_file", "/fixture/SampleScene.unity", { live: true }), {
    title: "正在读取", target: "SampleScene.unity",
  });
  assert.equal(describe("read_file", "/Users/someone/project/Assets/Scene.unity").target, "Scene.unity");
  assert.equal(describe("browser_evaluate", "https://user:secret@example.com/path?token=secret").target, "example.com");
  assert.equal(describe("run_command", "TOKEN=secret node script").target, undefined);
  assert.equal(describe("grep_search", "private input").target, undefined);
  assert.deepEqual(describe("__proto__", "raw tool payload", { language: "en" }), { title: "Run tool" });
});
