import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";
import { createHash } from "node:crypto";

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

const { isStreamOutputLimited } = loadTs(path.join(workspaceRoot, "src/lib/streaming.ts"));
const runtime = loadTs(path.join(workspaceRoot, "src/lib/runtime-v2/index.ts"));
const adapter = loadTs(path.join(workspaceRoot, "src/store/runtimeV2/workPlanAdapter.ts"));
const approval = loadTs(path.join(workspaceRoot, "src/store/runtimeV2/planApproval.ts"));
const handoff = loadTs(path.join(workspaceRoot, "src/store/runtimeV2/planHandoff.ts"));
const engineSelection = loadTs(path.join(workspaceRoot, "src/lib/runtimeEngineSelection.ts"));
const runIntent = loadTs(path.join(workspaceRoot, "src/lib/runIntent.ts"));
const planProtocol = loadTs(path.join(workspaceRoot, "src/store/runtimeV2/planModelProtocol.ts"));
const planSubmissionPolicy = loadTs(path.join(workspaceRoot, "src/store/runtimeV2/planSubmissionPolicy.ts"));
const { hashPlanDraftCandidate } = loadTs(path.join(workspaceRoot, "src/lib/planDrafts.ts"));
const EXPLICIT_PLAN_TEST_BUDGET_MS = 8 * 60_000;
const PLAN_RECOVERY_STALL_MS = 10 * 60_000;

test("Plan Skill paging sends only unseen ranges, including when a covering receipt was evicted", async () => {
  const { boundReadOnlyHistory } = loadTs(path.join(workspaceRoot, "src/store/runtimeV2/readOnlyHistory.ts"));
  const parts = ["a".repeat(1000), "b".repeat(1000), "c".repeat(1000)];
  const document = parts.join("");
  const read = (id, startChar, endChar, resource, version = "v1") => {
    const readTarget = { skill_id: "s:fixture", expected_version: version, ...(resource ? { resource } : {}) };
    const call = { id, type: "function", function: { name: "load_skill", arguments: JSON.stringify({ ...readTarget, start_char: startChar }) } };
    return [
      { role: "assistant", content: "", tool_calls: [call] },
      { role: "tool", tool_call_id: id, content: `[E7] s:fixture\n${JSON.stringify({
        type: resource ? "skill.resource" : "skill.loaded", id: "fixture", ref: "s:fixture", readTarget, version,
        ...(resource ? { resource } : {}), disclosure: "window", totalChars: document.length, totalLines: 1,
        returnedRange: { startLine: 1, endLine: 1, startChar, endChar }, content: document.slice(startChar, endChar),
        effect: resource ? "resource_guidance_no_additional_permissions" : "instructions_partially_read_no_additional_permissions",
      })}` },
    ];
  };
  const user = { role: "user", content: "Plan with the relevant Unity guidance." };
  const messages = [
    user, ...read("first", 0, 2000), ...read("overlap", 1000, 3000), ...read("covered", 1900, 2100),
    ...read("resource", 1100, 1300, "references/test.md"),
    ...read("new-version", 1100, 1300, undefined, "v2"),
  ];
  const project = (input, contextLimit) => boundReadOnlyHistory(input, {
    contextLimit, reservedOutputTokens: 0, preserveUserMessages: true, compactSkillGuidance: true,
  });
  const receipt = (input, id) => JSON.parse(input.find(message => message.tool_call_id === id).content.split("\n", 2)[1]);
  const wire = project(messages, 32_768);
  assert.deepEqual(receipt(wire, "overlap").newWindows, [{ startChar: 2000, endChar: 3000, content: parts[2] }]);
  assert.deepEqual(receipt(wire, "covered").newWindows, []);
  assert.deepEqual(receipt(wire, "covered").receiptReplayOf, ["first", "overlap"]);
  assert.equal(receipt(wire, "resource").content, document.slice(1100, 1300));
  assert.equal(receipt(wire, "new-version").content, document.slice(1100, 1300));
  assert.equal(receipt(messages, "overlap").content, parts[1] + parts[2], "durable source body is unchanged");
  const pressured = project([user, ...read("wide", 0, 3000), ...read("reread", 1100, 1300)], 420);
  assert.equal(pressured.some(message => message.tool_call_id === "wide"), false, "drop the old call/result group");
  assert.equal(receipt(pressured, "reread").content, document.slice(1100, 1300), "an evicted source cannot justify a replay pointer");

  const { restorePlanHistory } = loadTs(path.join(workspaceRoot, "src/store/runtimeV2/planHistory.ts"));
  const calls = ["first", "overlap", "covered"].map(id => {
    const tool = messages.find(message => message.tool_calls?.[0].id === id).tool_calls[0];
    return { id, name: tool.function.name, arguments: JSON.parse(tool.function.arguments) };
  });
  const skillReads = new Map(calls.map(call => [call.arguments.start_char, JSON.stringify(receipt(messages, call.id))]));
  const { executeReadOnlyPlanTool } = loadTsWithMocks(path.join(workspaceRoot, "src/store/runtimeV2/planEvidencePort.ts"), new Map([
    ["../../lib/toolExecutor", { executeTool: async (_name, args) => skillReads.get(args.start_char) }],
  ]));
  const run = { runId: "skill-plan", turnId: "skill-turn" };
  const events = [];
  const push = event => events.push({ ...event, run, sequence: events.length + 1 });
  const logs = [];
  const live = { messages: [user], evidence: [], evidenceContents: new Map() };
  const ledger = {
    snapshot: () => ({ objective: {} }),
    schedule: async (run, kind, payload) => {
      const command = { run, kind, idempotencyKey: payload.toolCallId, payload };
      push({ type: "command.scheduled", command });
      return command;
    },
    settleCommand: async event => push(event),
  };
  for (const call of calls) {
    push({ type: "provider.responded", result: { toolCalls: [call], diagnostics: [] } });
    live.messages.push(messages.find(message => message.tool_calls?.[0].id === call.id));
    await executeReadOnlyPlanTool({ ...live, context: {}, ledger, run, call, parallelReadCount: 1,
      logStoreEvent: (event, data) => logs.push({ event, ...data }) });
  }
  const completed = events.filter(event => event.type === "tool.completed");
  assert.deepEqual(completed.map(event => event.status), ["succeeded", "succeeded", "succeeded"]);
  assert.deepEqual(completed.map(event => event.evidence.length), [1, 1, 0]);
  assert.deepEqual(logs.map(({ retainedChars, newSkillChars }) => [retainedChars, newSkillChars]), [[2000, 2000], [3000, 1000], [3000, 0]]);
  assert.equal(live.evidence.length, 1);
  assert.equal(live.evidenceContents.size, 0, "Skill bytes have one owner in the receipt transcript");
  const restored = { messages: [user], evidence: [], evidenceContents: new Map() };
  restorePlanHistory({ ...restored, aggregate: { events: structuredClone(events) }, run });
  assert.equal(restored.evidenceContents.size, 0);
  assert.deepEqual(project(restored.messages, 32_768), project(live.messages, 32_768));
});

test("Plan executes admitted web reads with frozen provider and no workspace source authority", async () => {
  const policy = { enabled: true, provider: "bing" };
  const output = JSON.stringify({ url: "https://example.com/source", finalUrl: "https://example.com/source", content: "fact ".repeat(3000), truncated: false });
  const calls = [];
  const planEvidence = loadTsWithMocks(path.join(workspaceRoot, "src/store/runtimeV2/planEvidencePort.ts"), new Map([
    ["../../lib/toolExecutor", { executeTool: async (...args) => { calls.push(args); return output; } }],
  ]));
  const messages = []; const evidence = []; const settlements = [];
  await planEvidence.executeReadOnlyPlanTool({
    context: { runWorkspace: "/fixture", runSessionKey: "session", networkRead: { enabled: false, provider: "baidu" } },
    ledger: {
      snapshot: () => ({ networkRead: policy, objective: {} }),
      schedule: async () => ({ idempotencyKey: "plan-web-read" }),
      settleCommand: async (event) => settlements.push(event), recordSoftSignal: async () => undefined,
    }, run: { runId: "web-plan", turnId: "web-turn" },
    call: { id: "web-read", name: "web_fetch", arguments: { url: "https://example.com/source" } },
    messages, evidence, evidenceContents: new Map(), parallelReadCount: 1, logStoreEvent() {},
  });
  assert.equal(calls.length, 1, "an advertised admitted web read must reach its executor");
  assert.deepEqual(calls[0][4].networkRead, policy);
  assert.equal(settlements[0].status, "succeeded");
  assert.equal(settlements[0].evidence[0].kind, "tool");
  assert.ok(messages[0].content.endsWith(output), "keep the complete already-bounded network JSON receipt");
  assert.equal(evidence.length, 1);
});

test("Plan tool_search discovers only admitted read-only candidates and unlocks web tools", async () => {
  const discovery = loadTs(path.join(workspaceRoot, "src/lib/toolSearch.ts"));
  const context = { runSessionKey: "plan-web-discovery", networkRead: { enabled: true, provider: "bing" } };
  const messages = []; const settlements = [];
  const planEvidence = loadTsWithMocks(path.join(workspaceRoot, "src/store/runtimeV2/planEvidencePort.ts"), new Map([
    ["../../lib/toolSearch", discovery],
    ["../../lib/toolExecutor", { executeTool: async (name, args, _workspace, sessionKey, options) => {
      assert.equal(name, "tool_search");
      const candidates = options.toolCatalog?.toolDefinitions.map((tool) => tool.function.name) || [];
      assert.ok(candidates.includes("web_search"), "discovery must receive the admitted Plan catalog");
      assert.equal(candidates.includes("write_file"), false);
      assert.equal(candidates.includes("submit_runtime_v2_work_plan"), false);
      return discovery.executeToolSearch(args, { sessionKey, toolCatalog: options.toolCatalog });
    } }],
  ]));
  await planEvidence.executeReadOnlyPlanTool({ context,
    ledger: { snapshot: () => ({ networkRead: context.networkRead, objective: {} }), schedule: async () => ({ idempotencyKey: "plan-tool-discovery" }), settleCommand: async (event) => settlements.push(event), recordSoftSignal: async () => undefined },
    run: { runId: "web-plan", turnId: "web-turn" }, call: { id: "web-discovery", name: "tool_search", arguments: { query: "web" } },
    messages, evidence: [], evidenceContents: new Map(), parallelReadCount: 1, logStoreEvent() {},
  });
  assert.equal(settlements[0].status, "succeeded");
  assert.equal(settlements[0].evidence[0].kind, "tool");
  assert.ok(discovery.getUnlockedToolsForSession(context.runSessionKey).has("web_search"));
});

for (const [label, aggregate] of [
  ["historical missing snapshot", { objective: {} }],
  ["disabled snapshot", { networkRead: { enabled: false, provider: "bing" }, objective: {} }],
  ["restricted network", { networkRead: { enabled: true, provider: "bing" }, objective: { capabilityRestrictions: ["network"] } }],
  ["network needs review", { networkRead: { enabled: true, provider: "bing" }, objective: { approvalRequiredCapabilities: ["network"] } }],
]) test(`Plan web reads remain blocked for ${label}`, async () => {
  let executed = 0; const settlements = [];
  const planEvidence = loadTsWithMocks(path.join(workspaceRoot, "src/store/runtimeV2/planEvidencePort.ts"), new Map([
    ["../../lib/toolExecutor", { executeTool: async () => { executed++; return "must not run"; } }],
  ]));
  await planEvidence.executeReadOnlyPlanTool({
    context: { networkRead: { enabled: true, provider: "baidu" } },
    ledger: { snapshot: () => aggregate, schedule: async () => ({ idempotencyKey: label }), settleCommand: async (event) => settlements.push(event), recordSoftSignal: async () => undefined },
    run: { runId: "web-plan", turnId: "web-turn" }, call: { id: "denied-web", name: "web_search", arguments: { query: "fixture" } },
    messages: [], evidence: [], evidenceContents: new Map(), parallelReadCount: 1, logStoreEvent() {},
  });
  assert.equal(executed, 0);
  assert.equal(settlements[0].status, "blocked");
  assert.deepEqual(settlements[0].evidence, []);
});

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

test("Plan preserves an admitted read_file window without a second truncation", async () => {
  const sourceWindow = `${"x".repeat(12_500)}\nTAIL_MARKER`;
  const planEvidence = loadTsWithMocks(
    path.join(workspaceRoot, "src/store/runtimeV2/planEvidencePort.ts"),
    new Map([
      ["../../lib/toolExecutor", {
        executeTool: async () => sourceWindow,
      }],
      ["../../lib/toolTarget", {
        getToolTarget: () => "src/large.ts",
      }],
      ["../../lib/workspacePaths", {
        workspacePathsReferToSameFile: (left, right) => left === right,
      }],
      ["./sourceEvidenceVersion", {
        resolveRuntimeV2SourceEvidenceVersion: async () => "sha256-large",
      }],
    ]),
  );
  const messages = [];
  const evidence = [];
  const evidenceContents = new Map();
  const settlements = [];
  await planEvidence.executeReadOnlyPlanTool({
    context: {
      runWorkspace: "/fixture",
      runSessionKey: "session",
      runtimeContextBudget: {
        contextLimit: 65_536,
        outputBudget: 8_192,
        inputBudget: 57_344,
        readWindowChars: 32_000,
      },
    },
    ledger: {
      snapshot: () => null,
      schedule: async () => ({ idempotencyKey: "plan-read-large" }),
      settleCommand: async (event) => settlements.push(event),
      recordSoftSignal: async () => undefined,
    },
    run,
    call: {
      id: "read-large",
      name: "read_file",
      arguments: { path: "src/large.ts" },
    },
    messages,
    evidence,
    evidenceContents,
    parallelReadCount: 1,
    logStoreEvent: () => undefined,
  });

  assert.equal(settlements[0]?.status, "succeeded");
  assert.equal(evidenceContents.get("E1"), sourceWindow);
  assert.match(messages[0]?.content || "", /TAIL_MARKER$/);
  assert.equal(messages[0]?.content.includes(sourceWindow), true);
});

test("Plan actual read execution honors durable capability restrictions despite permissive context", async () => {
  let executed = 0;
  const planEvidence = loadTsWithMocks(path.join(workspaceRoot, "src/store/runtimeV2/planEvidencePort.ts"), new Map([
    ["../../lib/toolExecutor", { executeTool: async () => { executed++; return "must not execute"; } }],
  ]));
  const messages = [];
  const settlements = [];
  await planEvidence.executeReadOnlyPlanTool({
    context: { runWorkspace: "/fixture", runSessionKey: "session", capabilityRestrictions: [] },
    ledger: {
      snapshot: () => ({ objective: { capabilityRestrictions: ["workspace_read"] } }),
      schedule: async () => ({ idempotencyKey: "restricted-plan-read" }),
      settleCommand: async (event) => settlements.push(event),
      recordSoftSignal: async () => undefined,
    }, run, call: { id: "restricted-read", name: "read_file", arguments: { path: "private.txt" } },
    messages, evidence: [], evidenceContents: new Map(), parallelReadCount: 1, logStoreEvent() {},
  });
  assert.equal(executed, 0);
  assert.equal(settlements[0].status, "blocked");
  assert.deepEqual(settlements[0].evidence, []);
  assert.match(messages[0].content, /TURN_CAPABILITY_RESTRICTED: workspace_read/);
});

test("Plan direct reads cannot bypass durable individual review requirements", async () => {
  let executed = 0;
  const planEvidence = loadTsWithMocks(path.join(workspaceRoot, "src/store/runtimeV2/planEvidencePort.ts"), new Map([
    ["../../lib/toolExecutor", { executeTool: async () => { executed++; return "must not execute"; } }],
  ]));
  const messages = []; const settlements = [];
  await planEvidence.executeReadOnlyPlanTool({
    context: { runWorkspace: "/fixture", runSessionKey: "session", approvalRequiredCapabilities: [] },
    ledger: {
      snapshot: () => ({ objective: { approvalRequiredCapabilities: ["workspace_read"] } }),
      schedule: async () => ({ idempotencyKey: "manual-plan-read" }),
      settleCommand: async (event) => settlements.push(event), recordSoftSignal: async () => undefined,
    }, run, call: { id: "manual-read", name: "read_file", arguments: { path: "private.txt" } },
    messages, evidence: [], evidenceContents: new Map(), parallelReadCount: 1, logStoreEvent() {},
  });
  assert.equal(executed, 0);
  assert.equal(settlements[0].status, "blocked");
  assert.deepEqual(settlements[0].evidence, []);
  assert.match(messages[0].content, /TURN_TOOL_REVIEW_REQUIRED: workspace_read/);
});

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
        criterionIds: ["criterion-user-objective"],
      }],
      validations: [{
        stepIndexes: [0],
        kind: "finite_command",
        command: "npm run build",
        expectedOutcome: "构建通过。",
        required: true,
        criterionIds: ["criterion-user-objective"],
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

function reviewCheckpoint(owner = turn, ownerRun = run) {
  const sealed = plan();
  const commit = adapter.createRuntimeV2PlanReviewCommit({
    plan: sealed,
    turn: owner,
    run: ownerRun,
    requestId: "review-request-a",
    createdAt: 20,
  });
  let checkpoint = null;
  const append = (value) => {
    const result = runtime.appendRuntimeV2Checkpoint({
      checkpoint,
      owner,
      expectedRevision: checkpoint?.revision || 0,
      event: value,
    });
    assert.equal(result.disposition, "committed");
    checkpoint = result.checkpoint;
  };
  append(event(0, 10, {
    type: "turn.admitted",
    turn: owner,
    strategy: "plan",
    objective: sealed.draft.objective,
    constraints: [],
    acceptanceCriteria: [],
  }));
  append(event(1, 11, { type: "run.started", run: ownerRun, phase: "planning" }));
  append(event(2, 20, {
    type: "work_plan.sealed",
    run: ownerRun,
    workPlan: adapter.toRuntimeV2WorkPlanReference(sealed),
    sealedPlan: sealed,
    reviewCommit: commit,
  }));
  return { checkpoint, sealed, commit };
}

function planningCheckpointWithCompletedChild() {
  const startedAt = Date.now();
  const evidenceId = "child:0123456789abcdef0123456789abcdef:E1";
  const evidence = {
    id: evidenceId,
    kind: "subagent",
    target: "src/main.js",
    version: "sha-cold-child",
  };
  const report = runtime.compileRuntimeV2SubagentReport({
    draft: {
      summary: `Cold-restored child report cites ${evidenceId}.`,
      findings: [{
        statement: "The restored child found the existing owner in src/main.js.",
        evidence_ids: [evidenceId],
      }],
      unresolved: [],
    },
    evidence: [evidence],
  });
  const scheduled = runtime.scheduleReadOnlySubagents({
    parentRun: run,
    candidates: [{
      scopeKey: "cold-owner-review",
      taskKind: "review",
      name: "Cold owner reviewer",
      role: "reviewer",
      objective: "Review the existing source owner before planning.",
      successCriteria: "Return one cited finding.",
      allowedPaths: ["src/main.js"],
    }],
    maxActiveJobs: 1,
    requestedAt: startedAt + 2,
    nextId: () => "cold-plan-child",
  });
  const child = scheduled.jobs[0];
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
  append(event(0, startedAt - 1, {
    type: "turn.admitted",
    turn,
    strategy: "plan",
    subagentRequirement: "required",
    objective: "修复文件打开与标签显示",
    constraints: [],
    acceptanceCriteria: ["修复文件打开与标签显示"],
    acceptanceCriterionIds: ["criterion-user-objective"],
    acceptanceEvidenceRequirements: ["behavioral"],
  }));
  append(event(1, startedAt, { type: "run.started", run, phase: "planning",  }));
  append(event(2, startedAt + 2, {
    type: "subagents.scheduled",
    run,
    maxActiveSubagents: 1,
    jobs: scheduled.jobs,
  }));
  append(event(3, startedAt + 3, {
    type: "subagent.telemetry",
    run,
    telemetry: { jobId: child.id, phase: "request_opened", at: startedAt + 3 },
  }));
  append(event(4, startedAt + 4, {
    type: "subagent.telemetry",
    run,
    telemetry: { jobId: child.id, phase: "first_token", at: startedAt + 4 },
  }));
  append(event(5, startedAt + 5, {
    type: "subagent.telemetry",
    run,
    telemetry: { jobId: child.id, phase: "closed", at: startedAt + 5 },
  }));
  append(event(6, startedAt + 6, {
    type: "subagent.completed",
    run,
    jobId: child.id,
    status: "completed",
    summary: report.summary,
    evidence: [evidence],
    report,
  }));
  append(event(7, startedAt + 7, {
    type: "subagent.handoff_delivered",
    run,
    jobId: child.id,
    contextEntryId: `child:${child.id}`,
    evidenceIds: [evidenceId],
  }));
  return { checkpoint, child, evidence, evidenceId, report };
}

function reviewingCheckpointWithUnreconciledChildHandoff() {
  const restored = planningCheckpointWithCompletedChild();
  const sealed = runtime.sealWorkPlanV1({
    draft: {
      schemaVersion: runtime.WORK_PLAN_V1_SCHEMA_VERSION,
      objective: "修复文件打开与标签显示",
      summary: "Adopt the completed cold-restored child finding.",
      findings: [],
      steps: [{
        title: "Create the child-grounded owner",
        operation: "create",
        targets: ["src/cold-child-owner.js"],
        basis: [restored.evidenceId],
        change: "Create the bounded owner justified by the child finding.",
        expectedOutcome: "The child-grounded owner exists.",
        dependsOn: [],
        criterionIds: ["criterion-user-objective"],
      }],
      validations: [{
        stepIndexes: [0],
        kind: "finite_command",
        command: "npm run build",
        cwd: "/fixture",
        expectedOutcome: "Build succeeds.",
        required: true,
        criterionIds: ["criterion-user-objective"],
      }],
      risks: [],
      assumptions: [],
      blockingQuestions: [],
    },
    evidence: [{
      id: restored.evidence.id,
      target: restored.evidence.target,
      version: null,
      statement: "The restored child found the existing source owner.",
    }],
    id: "WP-cold-child-unreconciled",
    revision: 1,
    createdAt: restored.checkpoint.aggregate.updatedAt + 1,
  });
  const commit = adapter.createRuntimeV2PlanReviewCommit({
    plan: sealed,
    turn,
    run,
    requestId: "review-cold-child-unreconciled",
    createdAt: restored.checkpoint.aggregate.updatedAt + 1,
  });
  const appended = runtime.appendRuntimeV2Checkpoint({
    checkpoint: restored.checkpoint,
    owner: turn,
    expectedRevision: restored.checkpoint.revision,
    event: event(
      restored.checkpoint.aggregate.nextSequence,
      restored.checkpoint.aggregate.updatedAt + 1,
      {
      type: "work_plan.sealed",
      run,
      workPlan: adapter.toRuntimeV2WorkPlanReference(sealed),
      sealedPlan: sealed,
      reviewCommit: commit,
      },
    ),
  });
  assert.equal(appended.disposition, "committed");
  assert.ok(appended.checkpoint);
  assert.equal(
    appended.checkpoint.aggregate.events.some((entry) =>
      entry.type === "subagent.handoff_applied"
    ),
    false,
  );
  return {
    checkpoint: appended.checkpoint,
    child: restored.child,
    evidenceId: restored.evidenceId,
    sealed,
  };
}

function planningCheckpointWithRequirement(subagentRequirement, explicitBudget = false) {
  const startedAt = Date.now();
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
  append(event(0, startedAt - 1, {
    type: "turn.admitted",
    turn,
    strategy: "plan",
    subagentRequirement,
    objective: "修复文件打开与标签显示",
    constraints: [],
    acceptanceCriteria: ["修复文件打开与标签显示"],
    acceptanceCriterionIds: ["criterion-user-objective"],
    acceptanceEvidenceRequirements: ["behavioral"],
  }));
  append(event(1, startedAt, { type: "run.started", run, phase: "planning", ...(explicitBudget ? { lifecycleDeadlineAt: startedAt + EXPLICIT_PLAN_TEST_BUDGET_MS } : {}) }));
  return checkpoint;
}

function planningCheckpointWithRequiredSpawnTimeouts(timeoutCount) {
  let checkpoint = planningCheckpointWithRequirement("required");
  const append = (value) => {
    const result = runtime.appendRuntimeV2Checkpoint({
      checkpoint,
      owner: turn,
      expectedRevision: checkpoint.revision,
      event: event(
        checkpoint.aggregate.nextSequence,
        checkpoint.aggregate.updatedAt + 1,
        value,
      ),
    });
    assert.equal(result.disposition, "committed");
    checkpoint = result.checkpoint;
  };
  for (let index = 0; index < timeoutCount; index += 1) {
    const idempotencyKey = `cold-required-spawn-timeout-${index + 1}`;
    append({
      type: "command.scheduled",
      run,
      command: {
        idempotencyKey,
        kind: "request_model",
        run,
        phase: "planning",
        payload: {
          mode: "plan",
          stage: "discovery",
          toolExpectation: "required",
          objective: "修复文件打开与标签显示",
          evidenceIds: [],
          transport: "native_tool",
          requiredSpawn: true,
          submissionRepairPending: false,
          collaborationAllowed: true,
          collaborationRequired: true,
          collaborationRequirementMet: false,
          remainingSubagentCapacity: 1,
          activeSubagents: [],
        },
      },
    });
    append({
      type: "command.completed",
      run,
      idempotencyKey,
      status: "failed",
      failureReasonCode:
        "runtime_v2_plan_required_collaboration_provider_timeout",
    });
  }
  assert.equal(checkpoint.aggregate.sealedWorkPlan, null);
  assert.deepEqual(checkpoint.aggregate.subagents, []);
  assert.deepEqual(checkpoint.aggregate.scheduledCommands, []);
  return checkpoint;
}

function planningCheckpointWithTypedSubmissionRejection({ emptyBody = false } = {}) {
  const runStartedAt = 1_000_000;
  const rejectionAt = runStartedAt + EXPLICIT_PLAN_TEST_BUDGET_MS - 10;
  const toolCallId = "cold-rejected-work-plan";
  const idempotencyKey = "cold-rejected-work-plan-command";
  const candidate = {
    planMarkdown: emptyBody ? "" : "Create the cold-repair owner from the rejected typed candidate.",
    changes: [{
      title: "Create the cold-repair owner",
      operation: "create",
      targets: ["src/cold-repair-owner.js"],
      change: "Create the bounded owner behind the existing module boundary.",
      expectedOutcome: "The cold-repair owner exists.",
      dependsOn: [],
      criterionIds: ["criterion-user-objective"],
    }],
    validations: [{
      kind: "finite_command",
      command: "npm run build",
      cwd: "/fixture",
      expectedOutcome: "Build succeeds.",
      required: true,
      stepIndexes: [1],
      criterionIds: ["criterion-user-objective"],
    }],
  };
  let checkpoint = null;
  const append = (at, value) => {
    const result = runtime.appendRuntimeV2Checkpoint({
      checkpoint,
      owner: turn,
      expectedRevision: checkpoint?.revision || 0,
      event: event(checkpoint?.aggregate.nextSequence || 0, at, value),
    });
    assert.equal(result.disposition, "committed");
    checkpoint = result.checkpoint;
  };
  append(runStartedAt - 1, {
    type: "turn.admitted",
    turn,
    strategy: "plan",
    subagentRequirement: "optional",
    objective: "修复文件打开与标签显示",
    constraints: [],
    acceptanceCriteria: ["修复文件打开与标签显示"],
    acceptanceCriterionIds: ["criterion-user-objective"],
    acceptanceEvidenceRequirements: ["behavioral"],
  });
  append(runStartedAt, { type: "run.started", run, phase: "planning" });
  append(rejectionAt - 3, {
    type: "command.scheduled", run,
    command: { idempotencyKey: "cold-rejected-plan-provider", kind: "request_model", run, phase: "planning",
      payload: { mode: "plan", stage: "discovery", transport: "native_tool", submissionRepairPending: false } },
  });
  append(rejectionAt - 2, {
    type: "provider.responded", run, idempotencyKey: "cold-rejected-plan-provider",
    result: { visibleText: "", toolCalls: [{ id: toolCallId, name: "submit_runtime_v2_work_plan", arguments: candidate }], diagnostics: [], usage: {} },
  });
  append(rejectionAt - 1, {
    type: "command.scheduled",
    run,
    command: {
      idempotencyKey,
      kind: "execute_tool",
      run,
      phase: "planning",
      payload: {
        toolCallId,
        toolName: "submit_runtime_v2_work_plan",
        arguments: candidate,
        runtimeControlPlane: true,
      },
    },
  });
  append(rejectionAt, {
    type: "tool.completed",
    run,
    idempotencyKey,
    status: "failed",
    evidence: [],
    failureKind: "protocol_invalid",
    failureReasonCode: "runtime_v2_plan_submission_validation_rejected",
    presentation: {
      toolName: "submit_runtime_v2_work_plan",
      target: runtime.WORK_PLAN_V1_SCHEMA_VERSION,
      // Legacy checkpoints used the same typed rejection code for protocol and semantic gaps.
      message: emptyBody
        ? "WORK_PLAN_REJECTED: submit one JSON object with a non-empty planMarkdown body."
        : "WORK_PLAN_REJECTED: validations[0].stepIndexes references an unknown step.",
    },
  });
  assert.equal(checkpoint.aggregate.sealedWorkPlan, null);
  assert.deepEqual(checkpoint.aggregate.scheduledCommands, []);
  return { checkpoint, candidate, rejectionAt, runStartedAt, toolCallId };
}

function planningCheckpointWithRepeatedSubmitOnlyArgumentViolations() {
  const restored = planningCheckpointWithTypedSubmissionRejection({ emptyBody: true });
  let checkpoint = restored.checkpoint;
  const append = (at, value) => {
    const result = runtime.appendRuntimeV2Checkpoint({
      checkpoint,
      owner: turn,
      expectedRevision: checkpoint.revision,
      event: event(checkpoint.aggregate.nextSequence, at, value),
    });
    assert.equal(result.disposition, "committed");
    checkpoint = result.checkpoint;
  };
  for (let index = 0; index < 2; index += 1) {
    const idempotencyKey = `cold-submit-argument-rejection-${index + 1}`;
    append(restored.rejectionAt + (index * 2) + 1, {
      type: "command.scheduled",
      run,
      command: {
        idempotencyKey,
        kind: "request_model",
        run,
        phase: "planning",
        payload: {
          mode: "plan",
          stage: "synthesis",
          toolExpectation: "required",
          objective: "修复文件打开与标签显示",
          evidenceIds: [],
          transport: "native_tool",
          submissionRepairPending: true,
          compactRecovery: false,
          collaborationAllowed: false,
          collaborationRequired: false,
          collaborationRequirementMet: false,
          remainingSubagentCapacity: 0,
          activeSubagents: [],
          requiredSpawn: false,
        },
      },
    });
    append(restored.rejectionAt + (index * 2) + 2, {
      type: "provider.responded",
      run,
      idempotencyKey,
      result: {
        visibleText: "",
        toolCalls: [],
        usage: {},
        diagnostics: [{
          code: "tool_arguments_rejected",
          message:
            "submit_runtime_v2_work_plan did not satisfy its exact advertised Plan schema: arguments.changes[0].change is required.",
          retryable: true,
        }],
      },
    });
  }
  assert.deepEqual(checkpoint.aggregate.scheduledCommands, []);
  assert.equal(
    checkpoint.aggregate.events.filter((entry) =>
      entry.type === "provider.responded" &&
      entry.result.diagnostics.some((diagnostic) =>
        diagnostic.code === "tool_arguments_rejected"
      )
    ).length,
    2,
  );
  return {
    ...restored,
    checkpoint,
    restoredAt: restored.rejectionAt + 5,
    effectiveDeadlineAt:
      restored.rejectionAt +
      planProtocol.PLAN_SYNTHESIS_RECOVERY_REQUEST_TIMEOUT_MS,
  };
}

function planningCheckpointWithActiveChild(explicitBudget = false) {
  const startedAt = Date.now();
  const scheduled = runtime.scheduleReadOnlySubagents({
    parentRun: run,
    candidates: [{
      scopeKey: "cold-active-review",
      taskKind: "review",
      name: "Cold active reviewer",
      role: "reviewer",
      objective: "Review the existing owner before the Plan deadline.",
      successCriteria: "Return one bounded source finding.",
      allowedPaths: ["src/main.js"],
    }],
    maxActiveJobs: 2,
    requestedAt: startedAt + 2,
    nextId: () => "cold-active-child",
  });
  const child = scheduled.jobs[0];
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
  append(event(0, startedAt - 1, {
    type: "turn.admitted",
    turn,
    strategy: "plan",
    subagentRequirement: "optional",
    objective: "修复文件打开与标签显示",
    constraints: [],
    acceptanceCriteria: ["修复文件打开与标签显示"],
    acceptanceCriterionIds: ["criterion-user-objective"],
    acceptanceEvidenceRequirements: ["behavioral"],
  }));
  append(event(1, startedAt, { type: "run.started", run, phase: "planning", ...(explicitBudget ? { lifecycleDeadlineAt: startedAt + EXPLICIT_PLAN_TEST_BUDGET_MS } : {}) }));
  append(event(2, startedAt + 2, {
    type: "subagents.scheduled",
    run,
    maxActiveSubagents: 2,
    jobs: scheduled.jobs,
  }));
  append(event(3, startedAt + 3, {
    type: "subagent.telemetry",
    run,
    telemetry: { jobId: child.id, phase: "request_opened", at: startedAt + 3 },
  }));
  return { checkpoint, child };
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
    ...(commit.artifact.documentRef ? { documentRef: commit.artifact.documentRef } : {}),
    ...overrides,
  };
}

async function runProductionPlanScenario(
  streamCompletion,
  toolExecution,
  options = {},
) {
  let taskId = 0;
  const logs = [];
  const savedDocuments = [];
  const runSessionKey = options.runSessionKey || turn.sessionKey;
  const revision = options.revision;
  let state = {
    ...(revision ? { currentWorkspace: turn.workspaceKey, currentSessionId: 1 } : {}),
    conversationTurns: [...(revision?.turns || []), {
      id: turn.turnId,
      clientSubmissionId: turn.clientSubmissionId,
      userPrompt: options.userPrompt ?? "修复文件打开与标签显示",
      status: "running",
      blockIds: [],
      ...(revision ? { approvedPlanContinuation: { ...revision.source, revise: true } } : {}),
    }],
    config: options.config || { language: "zh" },
    planLifecycle: {
      sessionKey: runSessionKey,
      sessionEpoch: turn.sessionEpoch,
    },
    runtimeV2Checkpoints: {
      ...revision?.checkpoints,
      ...(options.initialCheckpoint ? { [turn.turnId]: options.initialCheckpoint } : {}),
    },
    runtimeEvents: [],
    taskFlow: [],
    harnessRunMarker: {
      sessionKey: runSessionKey,
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
            options.onCheckpoint?.(result.checkpoint);
          }
          return result;
        },
      };
    },
  };
  let mockProviderCalls = 0;
  const mocks = new Map([
    ["../../lib/providerLaneSettings", {
      deriveStreamSettings: () => ({
        provider: "OMLX",
        apiProtocol: "openai",
        toolProtocol: "auto",
      }),
      deriveBudgetedStreamSettings: (_config, budget) => ({
        contextLimit: budget?.contextLimit,
        provider: "OMLX",
        apiProtocol: "openai",
        toolProtocol: "auto",
      }),
      deriveProviderAdapterCapabilities: () => ({
        nativeToolRoundTrip: options.nativeToolRoundTrip ?? true,
        reasoningToggle: options.reasoningToggle ?? false,
      }),
    }],
    ["../../lib/toolTarget", {
      getToolTarget: (_name, args) => String(args.path || args.query || ""),
    }],
    ["../../lib/streaming", { isStreamOutputLimited, streamChatCompletion: (...args) => {
      if (++mockProviderCalls > 50) { abortCtrl.abort("test mock did not converge"); throw new Error("test mock did not converge"); }
      return streamCompletion(...args);
    } }],
    ["../../lib/modelLaneCoordinator", {
      acquireModelLane: options.acquireModelLane || (async () => ({
        markFirstToken() {},
        reportFailure() {},
        release() {},
        setPressureHandler() {},
      })),
    }],
    ["../../lib/subagents", {
      resolveSubagentCapacityPolicy: () =>
        options.subagentCapacityPolicy || {
          maxActiveRequests: 0,
          modelRequestMode: "serialized",
        },
    }],
    ["../../lib/toolExecutor", { executeTool: toolExecution }],
    ["../../lib/ipc", { ...revision?.ipc, savePlanDocument: async input => {
      savedDocuments.push(input);
      if (options.saveDocument) return options.saveDocument(input, savedDocuments.length);
      return { owner: input.owner, documentId: input.documentId, revision: 1,
        contentHash: createHash("sha256").update(input.markdown).digest("hex"),
        path: `${input.owner.workspace || "/session-data"}/.MAIN/plans/${input.documentId}/rev-1.md`, title: input.title, kind: input.kind };
    } }],
    ["../../lib/toolSchemas", {
      READ_ONLY_SUBAGENT_ACCESS_MODES: ["read"],
      READ_ONLY_SUBAGENT_TASK_KINDS: ["explore", "review", "validate"],
      RUNTIME_V2_SUBAGENT_ACCESS_MODES: ["read", "write"],
      RUNTIME_V2_SUBAGENT_TASK_KINDS: ["explore", "review", "validate", "implement"],
      RUNTIME_V2_SUBAGENT_IMPLEMENTATION_OPERATIONS: ["create", "modify", "delete"],
      TOOL_DEFINITIONS: [{
        type: "function",
        function: {
          name: "read_file",
          description: "Read one source window.",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string" },
              start_line: {
                type: "number",
                runtimeIdentityDefault: 1,
              },
              end_line: { type: "number" },
              max_lines: { type: "number" },
              start_char: { type: "number" },
              max_chars: { type: "number" },
            },
            required: ["path"],
          },
        },
      }, {
        type: "function",
        function: {
          name: "spawn_subagent",
          description: "Spawn one child.",
          parameters: {
            type: "object",
            properties: {
              task_key: { type: "string" },
              task_kind: { type: "string", enum: ["explore", "review", "validate", "implement"] },
              access_mode: { type: "string", enum: ["read", "write"] },
              objective: { type: "string" },
              success_criteria: { type: "string" },
              required_paths: { type: "string" },
              allowed_paths: { type: "string" },
              implementation_operation: { type: "string" },
              implementation_plan: { type: "string" },
            },
            required: ["objective", "required_paths"],
          },
        },
      }, {
        type: "function",
        function: {
          name: "wait_subagents",
          description: "Join children.",
          parameters: {
            type: "object",
            properties: {
              subagent_ids: { type: "string" },
              collaboration_task_ids: { type: "string" },
            },
            required: [],
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
  options.onAbortCtrl?.(abortCtrl);
  const runnerInput = {
    lifecycleDeadlineAt: options.lifecycleDeadlineAt,
    get,
    set,
    context: {
      turnId: turn.turnId,
      runSessionKey,
      harnessRunId: run.runId,
      runWorkspace: options.runWorkspace ?? turn.workspaceKey,
      runScopeKey: options.runScopeKey ?? turn.workspaceKey,
      runSessionId: 1,
      phaseLanguage: "zh",
      abortCtrl,
      timerInterval: undefined,
      runtimeContextBudget: options.runtimeContextBudget || {
        contextLimit: 32_768,
        outputBudget: 4_096,
        inputBudget: 28_672,
        readWindowChars: 18_000,
        source: "configured",
        providerContextLimit: null,
        availableMemoryBytes: null,
      },
      networkRead: options.networkRead,
      projectBaselineContext: options.projectBaselineContext,
      capabilityRestrictions: options.capabilityRestrictions,
      approvalRequiredCapabilities: options.approvalRequiredCapabilities,
      turnInputContextSignals: options.turnInputContextSignals || {
        subagentPreference: "unspecified",
      },
    },
    getSessionRevisionToken: () => 1,
    sanitizeTaskBlocksForPersist: (blocks) => blocks,
    buildSessionRuntimeSnapshot: (state) => state,
    publishOwnerScopedRuntimeProjection: () => ({
      published: true,
      disposition: "published",
    }),
    persistSessionRecord: async () => undefined,
    logStoreEvent: (eventName, data) => logs.push({ eventName, data }),
  };
  // These cases target the existing WorkPlan protocol/child/recovery seam.
  // Seed its genuine pre-interview legacy checkpoint through the production
  // bootstrap (including actual source overview), rather than bypassing the
  // mandatory interview in runSubmitRuntimeV2Plan. New-admission interview,
  // typed-answer, cold resume and executable-review coverage lives in
  // plan-interview-production.test.mjs.
  if (!options.initialCheckpoint) {
    const bootstrap = loadTsWithMocks(path.join(workspaceRoot, "src/store/runtimeV2/planBootstrap.ts"), mocks);
    await bootstrap.bootstrapRuntimeV2Plan(runnerInput);
  }
  const settlement = await planRunner.runSubmitRuntimeV2Plan(runnerInput);
  return {
    savedDocuments,
    settlement,
    state,
    checkpoint: state.runtimeV2Checkpoints[turn.turnId],
    logs,
  };
}

function testModelLaneLease() {
  return {
    markFirstToken() {},
    reportFailure() {},
    release() {},
    setPressureHandler() {},
  };
}

test("production Plan queues three independent native spawns on an unknown lane before proving overlap", async () => {
  const lanes = loadTs(path.join(workspaceRoot, "src/lib/modelLaneCoordinator.ts"));
  lanes.resetModelLaneCoordinatorForTests();
  lanes.setModelLaneMemoryReaderForTests(async () => ({
    total_gb: 64, available_gb: 24,
    total_bytes: 64 * 1024 ** 3, available_bytes: 24 * 1024 ** 3,
  }));
  const config = { activeProfile: "local", local: { provider: "OMLX", endpoint: "http://fixture.invalid/v1", model: "fixture-model" }, cloud: {}, cloudServers: [] };
  const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
  const threeQueued = deferred();
  const secondStarted = deferred();
  const allowSecondChunk = deferred();
  const thirdStarted = deferred();
  let controller;
  let timeout;
  let parentRequests = 0;
  let childRequests = 0;
  let queuedCheckpoint;
  const initial = lanes.getModelLaneCapacityObservation(config);
  assert.equal(initial.maxActiveSubagents, 1);
  try {
    const result = await runProductionPlanScenario(async (messages, _settings, callbacks, signal) => {
      const transcript = messages.map((message) => String(message.content || "")).join("\n");
      if (/read-only child of the current MAIN turn/i.test(transcript)) {
        const ordinal = ++childRequests;
        const aborted = new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
        if (ordinal === 1) {
          await Promise.race([threeQueued.promise, aborted]);
          if (!signal.aborted) {
            assert.equal(childRequests, 1, "queued jobs cannot bypass cold first-chunk admission");
            callbacks.onLifecycle?.({ phase: "model_progress" });
            await Promise.race([secondStarted.promise, aborted]);
            await new Promise((resolve) => setImmediate(resolve));
            assert.equal(childRequests, 2, "third HTTP request waits for actual overlap evidence");
            assert.equal(lanes.getModelLaneCapacityObservation(config).maxActiveRequests, 2);
            allowSecondChunk.resolve();
            await Promise.race([thirdStarted.promise, aborted]);
          }
        } else if (ordinal === 2) {
          secondStarted.resolve();
          await Promise.race([allowSecondChunk.promise, aborted]);
          callbacks.onLifecycle?.({ phase: "model_progress" });
          await Promise.race([thirdStarted.promise, aborted]);
        } else {
          assert.equal(ordinal, 3);
          assert.equal(lanes.getModelLaneCapacityObservation(config).maxActiveRequests, 3);
          thirdStarted.resolve();
          callbacks.onLifecycle?.({ phase: "model_progress" });
        }
        return { content: "No source finding is claimed by this scheduling fixture.", toolCalls: [], usage: {}, protocolViolation: null };
      }
      if (++parentRequests === 1) return { content: "", usage: {}, protocolViolation: null, toolCalls: ["parser", "consumer", "contract"].map((scope, index) => ({
        id: `queued-native-${scope}`, name: "spawn_subagent", arguments: JSON.stringify({
          task_key: scope, task_kind: "review", access_mode: "read",
          objective: `Review the independent ${scope} boundary.`, success_criteria: "Return a source-backed observation.",
          required_paths: `src/${scope}.js`, allowed_paths: `src/${scope}.js`,
        }),
      })) };
      controller.abort("three queued requests observed through the actual lane");
      return { content: "", toolCalls: [], usage: {}, protocolViolation: null };
    }, async (name) => {
      if (name === "get_project_skeleton") return "src/parser.js\nsrc/consumer.js\nsrc/contract.js";
      throw new Error(`unexpected tool ${name}`);
    }, {
      config, acquireModelLane: lanes.acquireModelLane,
      subagentCapacityPolicy: { maxActiveRequests: initial.maxActiveSubagents, modelRequestMode: "parallel" },
      turnInputContextSignals: { subagentPreference: "preferred" },
      capabilityRestrictions: [], approvalRequiredCapabilities: [],
      onAbortCtrl(value) {
        controller = value;
        // Deferred gates prove ordering. The watchdog only bounds a stuck fixture.
        timeout = setTimeout(() => value.abort("scheduling fixture did not admit all native tasks"), 10_000);
      },
      onCheckpoint(checkpoint) {
        if (checkpoint.aggregate.subagents.length === 3 && !queuedCheckpoint) {
          queuedCheckpoint = structuredClone(checkpoint);
          threeQueued.resolve();
        }
      },
    });
    assert.equal(result.checkpoint.aggregate.subagents.length, 3, "lane concurrency is not a total child-task quota");
    assert.equal(childRequests, 3);
    assert.ok(queuedCheckpoint.aggregate.subagents.every((job) => job.status === "queued" || job.status === "running"));
    const persisted = runtime.serializeRuntimeV2CheckpointMap({ [turn.turnId]: queuedCheckpoint })[turn.turnId];
    const restored = runtime.normalizeRuntimeV2Checkpoint(JSON.parse(JSON.stringify(persisted)), queuedCheckpoint.owner);
    assert.ok(restored, "queued task ledger replays through the cold checkpoint boundary");
    assert.equal(restored.aggregate.subagents.length, 3, "cold replay preserves every admitted queued task");
    assert.equal(result.logs.some((entry) => entry.data?.reason === "turn_child_budget_exhausted"), false);
    assert.ok(result.checkpoint.aggregate.subagents.every((job) => !["queued", "running"].includes(job.status)), "parent cancellation drains all admitted children");
  } finally {
    clearTimeout(timeout);
    controller?.abort("scheduling fixture cleanup");
    lanes.resetModelLaneCoordinatorForTests();
    lanes.setModelLaneMemoryReaderForTests();
  }
});

test("Plan accepts new evidence and a valid submission after more than ten minutes", async () => {
  const originalNow = Date.now;
  let now = 3_000_000;
  let requests = 0;
  Date.now = () => now;
  try {
    const result = await runProductionPlanScenario(async () => {
      requests += 1;
      now += 11 * 60_000;
      return { content: "", toolCalls: requests === 1 ? [{
        id: "slow-read", name: "read_file", arguments: JSON.stringify({ path: "src/main.js" }),
      }] : [{
        id: "slow-submit", name: "submit_runtime_v2_work_plan", arguments: JSON.stringify({
          planMarkdown: "Use the observed source to repair file opening.",
          changes: [{ operation: "modify", targets: ["src/main.js"], change: "Unify file opening.", dependsOn: [], criterionIds: ["criterion-user-objective"] }],
          validations: [{ kind: "finite_command", command: "npm run build", expectedOutcome: "Build passes.", required: true, stepIndexes: [0], criterionIds: ["criterion-user-objective"] }],
        }),
      }], usage: {}, protocolViolation: null };
    }, async (name) => {
      if (name === "get_project_skeleton") return "src/main.js";
      if (name === "read_file") return "export const openFile = () => null;";
      if (name === "write_file") return "written";
      throw new Error(`unexpected tool ${name}`);
    });
    assert.equal(requests, 2);
    assert.equal(result.checkpoint.aggregate.phase, "reviewing");
    assert.equal(result.checkpoint.aggregate.terminalOutcome, null);
    assert.equal(result.checkpoint.aggregate.events.filter((entry) => entry.type === "work_plan.sealed").length, 1);
  } finally { Date.now = originalNow; }
});

async function withFakePlanClock(startAt, task) {
  const originalNow = Date.now;
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  let now = startAt;
  let nextTimerId = 0;
  const timers = new Map();
  const timerArms = [];
  const runDueTimers = () => {
    for (let pass = 0; pass < 20; pass += 1) {
      const due = [...timers.entries()].filter(([, timer]) =>
        timer.dueAt <= now
      );
      if (due.length === 0) return;
      for (const [handle, timer] of due) {
        timers.delete(handle);
        timer.callback(...timer.args);
      }
    }
    throw new Error("fake Plan timers did not converge");
  };
  Date.now = () => now;
  globalThis.setTimeout = (callback, delay = 0, ...args) => {
    const delayMs = Math.max(0, Number(delay) || 0);
    const handle = { fakePlanTimerId: ++nextTimerId };
    timerArms.push({ armedAt: now, delayMs });
    timers.set(handle, { callback, args, dueAt: now + delayMs });
    return handle;
  };
  globalThis.clearTimeout = (handle) => {
    timers.delete(handle);
  };
  try {
    return await task({
      get now() {
        return now;
      },
      timerArms,
      async advanceBy(ms) {
        now += ms;
        runDueTimers();
        await Promise.resolve();
      },
    });
  } finally {
    Date.now = originalNow;
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
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
  assert.equal(engineSelection.selectRuntimeEngineVersionForNewTurn("goal"), "legacy", "retired Goal values never admit a runnable Goal route");
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
    runWorkspace: undefined,
    hasAttachedFiles: true,
  }), "workspace_read");
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
  }), null);
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
  assert.doesNotMatch(runner, /runSubmitRuntimeV2Goal/, "retired Goal has no submission runner");
  assert.match(runner, /runSubmitRuntimeV2WorkspaceRead/);
  assert.match(runner, /runtimeV2RunnerKind === "workspace_read"/);
  assert.doesNotMatch(runner, /\bnew WorkflowEngine\b|orchestrator\/workflowEngine/);

  const planRunner = fs.readFileSync(
    path.join(workspaceRoot, "src/store/runtimeV2/planRunner.ts"),
    "utf8",
  );
  const planCompletion = fs.readFileSync(
    path.join(workspaceRoot, "src/store/runtimeV2/planCompletion.ts"),
    "utf8",
  );
  const planReviewProjection = fs.readFileSync(
    path.join(workspaceRoot, "src/store/runtimeV2/planReviewProjection.ts"),
    "utf8",
  );
  const planImplementation = `${planRunner}\n${planCompletion}\n${planReviewProjection}`;
  assert.doesNotMatch(planImplementation, /\bPlanArtifact\b|planMaterialization|extractPlan|parsePlan/);
  assert.match(planCompletion, /createRuntimeV2PlanReviewCommit/);
  assert.match(planReviewProjection, /markdown: input\.plan\.markdown/);
  assert.match(planReviewProjection, /savePlanDocument/);
  assert.doesNotMatch(planReviewProjection, /executeTool/);
  assert.match(planCompletion, /reviewCommit: commit/);
  assert.match(planReviewProjection, /markdown: input\.commit\.chat\.markdown/);
  assert.doesNotMatch(planRunner, /plan:soft-round-limit|PLAN_MODEL_ROUND_LIMIT/);
  assert.doesNotMatch(planRunner, /runtime_v2_plan_soft_round_signal|messages\.splice\(3/);
  assert.match(planRunner, /terminal:\s*false/);
  assert.doesNotMatch(planRunner, /PLAN_MODEL_DEADLINE_MS/);
});

test("optional preferred Plan advertises collaboration without the hard spawn gate", async () => {
  const requests = [];
  let round = 0;
  const result = await runProductionPlanScenario(
    async (
      messages,
      _settings,
      _callbacks,
      _signal,
      tools,
      _maxOutputTokens,
      requestOptions,
    ) => {
      round += 1;
      requests.push({ messages, tools, requestOptions });
      if (round === 1) {
        return {
          content: "",
          toolCalls: [{
            id: "read-before-plan",
            name: "read_file",
            arguments: JSON.stringify({ path: "src/main.js" }),
          }],
          usage: {},
          protocolViolation: null,
        };
      }
      return {
        content: "",
        toolCalls: [{
          id: "submit-plan",
          name: "submit_runtime_v2_work_plan",
          arguments: JSON.stringify({
            planMarkdown: "Use the reviewed source and keep the existing owner boundary.",
            changes: [{
              title: "Update the source owner",
              operation: "modify",
              targets: ["src/main.js"],
              change: "Update the reviewed owner without widening scope.",
              expectedOutcome: "The owner remains coherent.",
              dependsOn: [],
              criterionIds: ["criterion-user-objective"],
            }],
            validations: [{
              kind: "finite_command",
              command: "npm run build",
              cwd: "/fixture",
              expectedOutcome: "Build succeeds.",
              required: true,
              stepIndexes: [0],
              criterionIds: ["criterion-user-objective"],
            }],
          }),
        }],
        usage: {},
        protocolViolation: null,
      };
    },
    async (name) => {
      if (name === "get_project_skeleton") return "src/main.js";
      if (name === "read_file") return "const owner = true;";
      if (name === "write_file") return "written";
      throw new Error(`unexpected tool ${name}`);
    },
    {
      turnInputContextSignals: {
        subagentPreference: "preferred",
        subagentRequirement: "optional",
      },
      subagentCapacityPolicy: {
        maxActiveRequests: 1,
        modelRequestMode: "parallel",
      },
    },
  );

  assert.equal(result.settlement.outcome.status, "paused");
  const firstToolNames = requests[0].tools.map((tool) => tool.function.name);
  assert.deepEqual(firstToolNames, [
    "read_file",
    "spawn_subagent",
    "submit_runtime_v2_work_plan",
  ]);
  assert.equal(requests[0].requestOptions.toolChoice, "required");
  const opened = result.logs.find((entry) =>
    entry.eventName === "runtime_v2_plan_provider_request_opened"
  );
  assert.deepEqual(opened.data.offeredToolNames, firstToolNames);
  const firstRequestCommand = result.checkpoint.aggregate.events.find((entry) =>
    entry.type === "command.scheduled" &&
    entry.command.kind === "request_model"
  )?.command;
  assert.equal(firstRequestCommand.payload.collaborationAllowed, true);
  assert.equal(firstRequestCommand.payload.collaborationPreferred, true);
  assert.equal(firstRequestCommand.payload.collaborationRequired, false);
  assert.equal(firstRequestCommand.payload.collaborationRequirementMet, false);
  assert.equal(firstRequestCommand.payload.maxActiveSubagents, 1);
  assert.equal(firstRequestCommand.payload.remainingSubagentCapacity, 1);
  const admitted = result.checkpoint.aggregate.events.find((entry) =>
    entry.type === "turn.admitted"
  );
  assert.deepEqual(admitted.acceptanceCriterionIds, [
    "criterion-user-objective",
  ]);
  assert.deepEqual(admitted.acceptanceCriteria, [
    "修复文件打开与标签显示",
  ]);
  assert.match(
    requests[0].messages.map((message) => String(message.content || "")).join("\n"),
    /criterion-user-objective: 修复文件打开与标签显示/,
  );
});

test("production Plan hard-admits one required child before restoring discovery", async () => {
  const parentRequests = [];
  let parentRound = 0;
  let abortCtrl = null;
  let diagnosticAbort = null;
  const result = await runProductionPlanScenario(
    async (
      messages,
      _settings,
      _callbacks,
      _signal,
      tools,
      _maxOutputTokens,
      requestOptions,
    ) => {
      const transcript = messages
        .map((message) => String(message.content || ""))
        .join("\n");
      if (/read-only child of the current MAIN turn/i.test(transcript)) {
        await new Promise((resolve) => setTimeout(resolve, 80));
        return {
          content: "No child evidence was produced before cancellation.",
          toolCalls: [],
          usage: {},
          protocolViolation: null,
        };
      }

      parentRound += 1;
      parentRequests.push({ tools, requestOptions });
      if (parentRound === 1) {
        return {
          content: "",
          toolCalls: [{
            id: "required-plan-child",
            name: "spawn_subagent",
            arguments: JSON.stringify({
              task_key: "required-plan-child",
              task_kind: "review",
              access_mode: "read",
              objective: "Review the current source owner independently.",
              success_criteria: "Return one evidence-backed finding.",
              required_paths: "src/main.js",
              allowed_paths: "src/main.js",
            }),
          }],
          usage: {},
          protocolViolation: null,
        };
      }

      abortCtrl.abort("required-plan-surface-captured");
      return {
        content: "",
        toolCalls: [],
        usage: {},
        protocolViolation: null,
      };
    },
    async (name) => {
      if (name === "get_project_skeleton") return "src/main.js";
      if (name === "read_file") return "const owner = true;";
      throw new Error(`unexpected tool ${name}`);
    },
    {
      turnInputContextSignals: {
        subagentPreference: "unspecified",
        subagentRequirement: "required",
      },
      subagentCapacityPolicy: {
        maxActiveRequests: 1,
        modelRequestMode: "parallel",
      },
      onAbortCtrl: (controller) => {
        abortCtrl = controller;
        diagnosticAbort = setTimeout(
          () => controller.abort("required-plan-test-timeout"),
          2_000,
        );
      },
    },
  );
  if (diagnosticAbort) clearTimeout(diagnosticAbort);

  assert.equal(parentRequests.length, 2);
  assert.deepEqual(
    parentRequests[0].tools.map((tool) => tool.function.name),
    ["spawn_subagent"],
  );
  assert.deepEqual(parentRequests[0].requestOptions.toolChoice, {
    type: "function",
    function: { name: "spawn_subagent" },
  });
  assert.deepEqual(
    parentRequests[1].tools.map((tool) => tool.function.name),
    ["read_file", "spawn_subagent", "wait_subagents", "submit_runtime_v2_work_plan"],
  );

  const requestCommands = result.checkpoint.aggregate.events.filter((entry) =>
    entry.type === "command.scheduled" &&
    entry.command.kind === "request_model"
  );
  assert.equal(requestCommands[0].command.payload.collaborationRequired, true);
  assert.equal(
    requestCommands[0].command.payload.collaborationRequirementMet,
    false,
  );
  assert.equal(requestCommands[1].command.payload.collaborationRequired, true);
  assert.equal(
    requestCommands[1].command.payload.collaborationRequirementMet,
    true,
  );
});

test("required Plan normalizes an in-workspace absolute child scope before restoring discovery", async () => {
  const absoluteScope = `${turn.workspaceKey}/src/main.js`;
  const spawnCallId = "required-plan-absolute-scope";
  const parentRequests = [];
  let abortCtrl = null;
  let diagnosticAbort = null;
  let childRequestStarted = false;
  const result = await runProductionPlanScenario(
    async (
      messages,
      _settings,
      _callbacks,
      _signal,
      tools,
      _maxOutputTokens,
      requestOptions,
    ) => {
      const transcript = messages
        .map((message) => String(message.content || ""))
        .join("\n");
      if (/read-only child of the current MAIN turn/i.test(transcript)) {
        childRequestStarted = true;
        await new Promise((resolve) => setTimeout(resolve, 80));
        return {
          content: "No child evidence was produced before cancellation.",
          toolCalls: [],
          usage: {},
          protocolViolation: null,
        };
      }

      parentRequests.push({ messages, tools, requestOptions });
      if (parentRequests.length === 1) {
        return {
          content: "",
          toolCalls: [{
            id: spawnCallId,
            name: "spawn_subagent",
            arguments: JSON.stringify({
              task_key: "required-plan-absolute-scope",
              task_kind: "review",
              access_mode: "read",
              objective: "Review the current source owner independently.",
              success_criteria: "Return one evidence-backed finding.",
              required_paths: absoluteScope,
              allowed_paths: absoluteScope,
            }),
          }],
          usage: {},
          protocolViolation: null,
        };
      }

      abortCtrl.abort("required-plan-absolute-scope-captured");
      return {
        content: "",
        toolCalls: [],
        usage: {},
        protocolViolation: null,
      };
    },
    async (name) => {
      if (name === "get_project_skeleton") return "src/main.js";
      if (name === "read_file") return "const owner = true;";
      throw new Error(`unexpected tool ${name}`);
    },
    {
      turnInputContextSignals: {
        subagentPreference: "unspecified",
        subagentRequirement: "required",
      },
      subagentCapacityPolicy: {
        maxActiveRequests: 1,
        modelRequestMode: "parallel",
      },
      onAbortCtrl: (controller) => {
        abortCtrl = controller;
        diagnosticAbort = setTimeout(
          () => controller.abort("required-plan-absolute-scope-timeout"),
          2_000,
        );
      },
    },
  );
  if (diagnosticAbort) clearTimeout(diagnosticAbort);

  assert.equal(parentRequests.length, 2);
  assert.deepEqual(
    parentRequests[0].tools.map((tool) => tool.function.name),
    ["spawn_subagent"],
  );
  assert.deepEqual(parentRequests[0].requestOptions.toolChoice, {
    type: "function",
    function: { name: "spawn_subagent" },
  });
  assert.deepEqual(
    parentRequests[1].tools.map((tool) => tool.function.name),
    ["read_file", "spawn_subagent", "wait_subagents", "submit_runtime_v2_work_plan"],
  );
  assert.equal(parentRequests[1].requestOptions.toolChoice, "required");

  const aggregate = result.checkpoint.aggregate;
  const admittedSpawn = aggregate.events.find((entry) =>
    entry.type === "provider.responded" &&
    entry.result.toolCalls.some((call) => call.id === spawnCallId)
  )?.result.toolCalls.find((call) => call.id === spawnCallId);
  assert.deepEqual(admittedSpawn?.arguments, {
    task_key: "required-plan-absolute-scope",
    task_kind: "review",
    access_mode: "read",
    objective: "Review the current source owner independently.",
    success_criteria: "Return one evidence-backed finding.",
    required_paths: "src/main.js",
    allowed_paths: "src/main.js",
  });
  const scheduled = aggregate.events.filter((entry) =>
    entry.type === "subagents.scheduled" &&
    entry.jobs.some((job) => job.sourceToolCallId === spawnCallId)
  );
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].jobs.length, 1);
  assert.deepEqual(scheduled[0].jobs[0].allowedPaths, ["src/main.js"]);
  assert.equal(childRequestStarted, true);

  const requestCommands = aggregate.events.filter((entry) =>
    entry.type === "command.scheduled" &&
    entry.command.kind === "request_model"
  );
  assert.equal(
    requestCommands[0].command.payload.collaborationRequirementMet,
    false,
  );
  assert.equal(
    requestCommands[1].command.payload.collaborationRequirementMet,
    true,
  );
});

test("required Plan rejects an unadvertised submission and keeps the spawn gate", async () => {
  const parentRequests = [];
  let abortCtrl = null;
  let diagnosticAbort = null;
  const prematureSubmission = {
    planMarkdown: "Create the bounded fixture and verify it.",
    changes: [{
      title: "Create the fixture",
      operation: "create",
      targets: ["required-fixture.js"],
      change: "Create one bounded fixture without changing existing source.",
      expectedOutcome: "The fixture exists.",
      dependsOn: [],
      criterionIds: ["criterion-user-objective"],
    }],
    validations: [{
      kind: "finite_command",
      command: "npm run build",
      cwd: "/fixture",
      expectedOutcome: "Build succeeds.",
      required: true,
      stepIndexes: [0],
      criterionIds: ["criterion-user-objective"],
    }],
  };
  const result = await runProductionPlanScenario(
    async (
      _messages,
      _settings,
      _callbacks,
      _signal,
      tools,
      _maxOutputTokens,
      requestOptions,
    ) => {
      parentRequests.push({ tools, requestOptions });
      if (parentRequests.length === 1) {
        return {
          content: "",
          toolCalls: [{
            id: "premature-required-plan",
            name: "submit_runtime_v2_work_plan",
            arguments: JSON.stringify(prematureSubmission),
          }],
          usage: {},
          protocolViolation: null,
        };
      }

      abortCtrl.abort("required-plan-rejection-surface-captured");
      return {
        content: "",
        toolCalls: [],
        usage: {},
        protocolViolation: null,
      };
    },
    async (name) => {
      if (name === "get_project_skeleton") return "src/main.js";
      throw new Error(`unexpected tool ${name}`);
    },
    {
      turnInputContextSignals: {
        subagentPreference: "unspecified",
        subagentRequirement: "required",
      },
      subagentCapacityPolicy: {
        maxActiveRequests: 1,
        modelRequestMode: "parallel",
      },
      onAbortCtrl: (controller) => {
        abortCtrl = controller;
        diagnosticAbort = setTimeout(
          () => controller.abort("required-plan-rejection-test-timeout"),
          2_000,
        );
      },
    },
  );
  if (diagnosticAbort) clearTimeout(diagnosticAbort);

  assert.equal(parentRequests.length, 2);
  for (const request of parentRequests) {
    assert.deepEqual(
      request.tools.map((tool) => tool.function.name),
      ["spawn_subagent"],
    );
    assert.deepEqual(request.requestOptions.toolChoice, {
      type: "function",
      function: { name: "spawn_subagent" },
    });
  }
  assert.equal(
    result.checkpoint.aggregate.events.some((entry) =>
      entry.type === "work_plan.sealed"
    ),
    false,
  );
  assert.equal(result.checkpoint.aggregate.sealedWorkPlan, null);
  assert.ok(result.logs.some((entry) =>
    entry.eventName === "runtime_v2_plan_submission_rejected" &&
    /required planning collaboration/i.test(String(entry.data?.detail || ""))
  ), JSON.stringify(result.logs.filter((entry) =>
    /plan_submission|provider_request/.test(entry.eventName)
  )));
});

test("required Plan rejects an unadvertised read batch before admitting a legal spawn", async () => {
  const unadvertisedCallIds = [
    "required-gate-read-main",
    "required-gate-read-helper",
  ];
  const unadvertisedTargets = [
    "src/required-gate-main.js",
    "src/required-gate-helper.js",
  ];
  const parentRequests = [];
  const readExecutions = [];
  let abortCtrl = null;
  let diagnosticAbort = null;
  let childRequestStarted = false;
  const result = await runProductionPlanScenario(
    async (
      messages,
      _settings,
      _callbacks,
      _signal,
      tools,
      _maxOutputTokens,
      requestOptions,
    ) => {
      const transcript = messages
        .map((message) => String(message.content || ""))
        .join("\n");
      if (/read-only child of the current MAIN turn/i.test(transcript)) {
        childRequestStarted = true;
        await new Promise((resolve) => setTimeout(resolve, 80));
        return {
          content: "No child evidence was produced before cancellation.",
          toolCalls: [],
          usage: {},
          protocolViolation: null,
        };
      }

      parentRequests.push({ messages, tools, requestOptions });
      if (parentRequests.length === 1) {
        return {
          content: "",
          toolCalls: unadvertisedCallIds.map((id, index) => ({
            id,
            name: "read_file",
            arguments: JSON.stringify({ path: unadvertisedTargets[index] }),
          })),
          usage: {},
          protocolViolation: null,
        };
      }
      if (parentRequests.length === 2) {
        return {
          content: "",
          toolCalls: [{
            id: "required-gate-legal-spawn",
            name: "spawn_subagent",
            arguments: JSON.stringify({
              task_key: "required-gate-legal-spawn",
              task_kind: "review",
              access_mode: "read",
              objective: "Review the current source owner independently.",
              success_criteria: "Return one evidence-backed finding.",
              required_paths: "src/main.js",
              allowed_paths: "src/main.js",
            }),
          }],
          usage: {},
          protocolViolation: null,
        };
      }

      abortCtrl.abort("required-plan-read-rejection-surface-captured");
      return {
        content: "",
        toolCalls: [],
        usage: {},
        protocolViolation: null,
      };
    },
    async (name, args) => {
      if (name === "get_project_skeleton") return "src/main.js";
      if (name === "read_file") {
        readExecutions.push(String(args.path || ""));
        return "export const shouldNeverBeObserved = true;";
      }
      throw new Error(`unexpected tool ${name}`);
    },
    {
      turnInputContextSignals: {
        subagentPreference: "unspecified",
        subagentRequirement: "required",
      },
      subagentCapacityPolicy: {
        maxActiveRequests: 1,
        modelRequestMode: "parallel",
      },
      onAbortCtrl: (controller) => {
        abortCtrl = controller;
        diagnosticAbort = setTimeout(
          () => controller.abort("required-plan-read-rejection-test-timeout"),
          2_000,
        );
      },
    },
  );
  if (diagnosticAbort) clearTimeout(diagnosticAbort);

  assert.equal(parentRequests.length, 3);
  for (const request of parentRequests.slice(0, 2)) {
    assert.deepEqual(
      request.tools.map((tool) => tool.function.name),
      ["spawn_subagent"],
    );
    assert.deepEqual(request.requestOptions.toolChoice, {
      type: "function",
      function: { name: "spawn_subagent" },
    });
  }
  assert.deepEqual(
    parentRequests[2].tools.map((tool) => tool.function.name),
    ["read_file", "spawn_subagent", "wait_subagents", "submit_runtime_v2_work_plan"],
  );
  assert.deepEqual(readExecutions, []);

  const rejectionMessages = parentRequests[1].messages.filter((message) =>
    message.role === "tool" &&
    unadvertisedCallIds.includes(message.tool_call_id)
  );
  assert.deepEqual(
    rejectionMessages.map((message) => message.tool_call_id).sort(),
    [...unadvertisedCallIds].sort(),
  );
  for (const message of rejectionMessages) {
    assert.match(
      String(message.content || ""),
      /^PLAN_TOOL_NOT_ADVERTISED:/,
    );
  }

  const aggregate = result.checkpoint.aggregate;
  assert.equal(
    aggregate.evidence.some((entry) =>
      unadvertisedTargets.includes(entry.target)
    ),
    false,
  );
  const unadvertisedCommands = aggregate.events.filter((entry) =>
    entry.type === "command.scheduled" &&
    entry.command.kind === "execute_tool" &&
    unadvertisedCallIds.includes(entry.command.payload.toolCallId)
  );
  assert.deepEqual(unadvertisedCommands, []);
  assert.equal(
    aggregate.events.some((entry) => entry.type === "tool.completed"),
    false,
  );
  const quarantinedProviderResponse = aggregate.events.find((entry) =>
    entry.type === "provider.responded" &&
    entry.result.diagnostics.some((diagnostic) =>
      diagnostic.code === "tool_surface_rejected"
    )
  );
  assert.ok(quarantinedProviderResponse);
  assert.deepEqual(quarantinedProviderResponse.result.toolCalls, []);
  assert.equal(
    result.logs.some((entry) =>
      entry.eventName === "runtime_v2_plan_read_completed" &&
      unadvertisedTargets.includes(entry.data?.target)
    ),
    false,
  );
  assert.equal(childRequestStarted, true);
  assert.ok(aggregate.events.some((entry) =>
    entry.type === "subagents.scheduled" &&
    entry.jobs.some((job) => job.sourceToolCallId === "required-gate-legal-spawn")
  ));
});

test("required Plan with zero child capacity blocks before calling the provider", async () => {
  let providerCalls = 0;
  const result = await runProductionPlanScenario(
    async () => {
      providerCalls += 1;
      throw new Error("the provider must not be called without required child capacity");
    },
    async (name) => {
      if (name === "get_project_skeleton") return "src/main.js";
      throw new Error(`unexpected tool ${name}`);
    },
    {
      turnInputContextSignals: {
        subagentPreference: "unspecified",
        subagentRequirement: "required",
      },
      subagentCapacityPolicy: {
        maxActiveRequests: 0,
        modelRequestMode: "serialized",
      },
    },
  );

  assert.equal(providerCalls, 0);
  assert.equal(result.settlement.outcome.status, "completed");
  assert.equal(result.settlement.outcome.resultKind, "blocked");
  const aggregate = result.checkpoint.aggregate;
  assert.equal(aggregate.terminalOutcome?.resultKind, "blocked");
  assert.equal(aggregate.sealedWorkPlan, null);
  assert.equal(
    aggregate.events.some((entry) => entry.type === "work_plan.sealed"),
    false,
  );
  assert.deepEqual(aggregate.scheduledCommands, []);
  assert.equal(
    aggregate.events.some((entry) =>
      entry.type === "command.scheduled" &&
      entry.command.kind === "request_model"
    ),
    false,
  );
  assert.equal(
    result.logs.some((entry) =>
      entry.eventName === "runtime_v2_plan_provider_request_opened"
    ),
    false,
  );
  const terminalLog = result.logs.find((entry) =>
    entry.eventName === "runtime_v2_plan_terminal"
  );
  assert.equal(terminalLog?.data?.resultKind, "blocked");
  assert.equal(
    terminalLog?.data?.detailCode,
    "runtime_v2_plan_required_collaboration_unavailable",
  );
});

test("required Plan retries one timed-out native spawn surface before bounded blocked closure", async () => {
  const requests = [];
  let abortCtrl = null;
  let diagnosticAbort = null;
  const result = await runProductionPlanScenario(
    async (
      messages,
      settings,
      _callbacks,
      _signal,
      tools,
      _maxOutputTokens,
      requestOptions,
    ) => {
      requests.push({
        transcript: messages
          .map((message) => String(message.content || ""))
          .join("\n"),
        settings,
        toolNames: tools.map((tool) => tool.function.name),
        requestOptions,
      });
      if (requests.length <= 2) {
        throw new Error(
          "STREAM_NO_VISIBLE_PROGRESS_TIMEOUT: required spawn request produced no semantic action",
        );
      }
      abortCtrl.abort("unexpected third required spawn request");
      throw new Error("required spawn recovery exceeded one retry");
    },
    async (name) => {
      if (name === "get_project_skeleton") return "src/main.js";
      throw new Error(`unexpected tool ${name}`);
    },
    {
      turnInputContextSignals: {
        subagentPreference: "unspecified",
        subagentRequirement: "required",
      },
      subagentCapacityPolicy: {
        maxActiveRequests: 1,
        modelRequestMode: "parallel",
      },
      onAbortCtrl: (controller) => {
        abortCtrl = controller;
        diagnosticAbort = setTimeout(
          () => controller.abort("required spawn timeout recovery test timeout"),
          2_000,
        );
      },
    },
  );
  if (diagnosticAbort) clearTimeout(diagnosticAbort);

  const falseSynthesisSwitch = result.logs.some((entry) =>
    entry.eventName === "runtime_v2_plan_provider_failed" &&
    entry.data?.action === "switch_to_synthesis"
  );
  assert.deepEqual(
    {
      providerCalls: requests.length,
      falseSynthesisSwitch,
    },
    {
      providerCalls: 2,
      falseSynthesisSwitch: false,
    },
    "required spawn timeout recovery is single-use and remains real discovery",
  );
  for (const request of requests) {
    assert.deepEqual(request.toolNames, ["spawn_subagent"]);
    assert.deepEqual(request.requestOptions.toolChoice, {
      type: "function",
      function: { name: "spawn_subagent" },
    });
    assert.equal(request.requestOptions.timeoutMs,
      planProtocol.PLAN_MODEL_REQUEST_TIMEOUT_MS);
    assert.equal(request.requestOptions.responseFormat, undefined);
  }

  const opened = result.logs.filter((entry) =>
    entry.eventName === "runtime_v2_plan_provider_request_opened"
  );
  assert.equal(opened.length, 2);
  for (const entry of opened) {
    assert.equal(entry.data?.stage, "discovery");
    assert.equal(entry.data?.requestedTransport, "native_tool");
    assert.equal(entry.data?.transport, "native_tool");
    assert.equal(entry.data?.requiredSpawn, true);
    assert.deepEqual(entry.data?.offeredToolNames, ["spawn_subagent"]);
    assert.equal(entry.data?.timeoutMs, planProtocol.PLAN_MODEL_REQUEST_TIMEOUT_MS);
  }
  const closed = result.logs.filter((entry) =>
    entry.eventName === "runtime_v2_plan_provider_request_closed"
  );
  assert.equal(closed.length, 2);
  for (const entry of closed) {
    assert.equal(entry.data?.stage, "discovery");
    assert.equal(entry.data?.transport, "native_tool");
    assert.equal(entry.data?.timeoutMs, planProtocol.PLAN_MODEL_REQUEST_TIMEOUT_MS);
    assert.equal(entry.data?.timedOut, true);
  }
  assert.equal(falseSynthesisSwitch, false);
  assert.equal(
    result.logs.some((entry) =>
      entry.eventName === "runtime_v2_plan_synthesis_timeout" ||
      entry.eventName === "runtime_v2_plan_provider_transport_fallback"
    ),
    false,
  );

  assert.equal(result.settlement.outcome.status, "completed");
  assert.equal(result.settlement.outcome.resultKind, "blocked");
  const aggregate = result.checkpoint.aggregate;
  assert.equal(aggregate.terminalOutcome?.resultKind, "blocked");
  assert.equal(aggregate.sealedWorkPlan, null);
  assert.equal(
    aggregate.events.some((entry) => entry.type === "work_plan.sealed"),
    false,
  );
  assert.deepEqual(aggregate.subagents, []);
  assert.deepEqual(aggregate.scheduledCommands, []);
  assert.equal(
    aggregate.events.filter((entry) =>
      entry.type === "command.scheduled" &&
      entry.command.kind === "request_model"
    ).length,
    2,
  );
  assert.equal(
    aggregate.events.some((entry) =>
      entry.type === "subagents.scheduled" ||
      (
        entry.type === "command.scheduled" &&
        entry.command.kind === "schedule_subagents"
      )
    ),
    false,
  );
  const terminal = result.logs.find((entry) =>
    entry.eventName === "runtime_v2_plan_terminal"
  );
  assert.equal(terminal?.data?.resultKind, "blocked");
  assert.match(String(terminal?.data?.detailCode || ""), /required_collaboration/);
  assert.notEqual(terminal?.data?.detailCode, "runtime_v2_plan_deadline_reached");
});

test("cold-restored required spawn timeout receipts never renew the single retry", async () => {
  const oneTimeoutCheckpoint = planningCheckpointWithRequiredSpawnTimeouts(1);
  const retryRequests = [];
  let retryAbortCtrl = null;
  let retryDiagnosticAbort = null;
  const retried = await runProductionPlanScenario(
    async (
      messages,
      _settings,
      _callbacks,
      _signal,
      tools,
      _maxOutputTokens,
      requestOptions,
    ) => {
      retryRequests.push({
        transcript: messages
          .map((message) => String(message.content || ""))
          .join("\n"),
        toolNames: tools.map((tool) => tool.function.name),
        requestOptions,
      });
      if (retryRequests.length > 1) {
        retryAbortCtrl.abort("cold required spawn retry was renewed");
        throw new Error("cold required spawn retry exceeded its durable budget");
      }
      throw new Error(
        "STREAM_NO_VISIBLE_PROGRESS_TIMEOUT: restored required spawn retry produced no semantic action",
      );
    },
    async (name) => {
      if (name === "get_project_skeleton") return "src/main.js";
      throw new Error(`unexpected tool ${name}`);
    },
    {
      initialCheckpoint: oneTimeoutCheckpoint,
      turnInputContextSignals: {
        subagentPreference: "unspecified",
        subagentRequirement: "required",
      },
      subagentCapacityPolicy: {
        maxActiveRequests: 1,
        modelRequestMode: "parallel",
      },
      onAbortCtrl: (controller) => {
        retryAbortCtrl = controller;
        retryDiagnosticAbort = setTimeout(
          () => controller.abort("cold required spawn retry test timeout"),
          2_000,
        );
      },
    },
  );
  if (retryDiagnosticAbort) clearTimeout(retryDiagnosticAbort);

  assert.equal(retryRequests.length, 1);
  assert.deepEqual(retryRequests[0].toolNames, ["spawn_subagent"]);
  assert.deepEqual(retryRequests[0].requestOptions.toolChoice, {
    type: "function",
    function: { name: "spawn_subagent" },
  });
  assert.equal(
    retryRequests[0].requestOptions.timeoutMs,
    planProtocol.PLAN_MODEL_REQUEST_TIMEOUT_MS,
  );
  assert.equal(retryRequests[0].requestOptions.responseFormat, undefined);
  const retryOpened = retried.logs.filter((entry) =>
    entry.eventName === "runtime_v2_plan_provider_request_opened"
  );
  assert.equal(retryOpened.length, 1);
  assert.equal(retryOpened[0].data?.stage, "discovery");
  assert.equal(retryOpened[0].data?.requestedTransport, "native_tool");
  assert.equal(retryOpened[0].data?.transport, "native_tool");
  assert.equal(retryOpened[0].data?.requiredSpawn, true);
  assert.deepEqual(retryOpened[0].data?.offeredToolNames, ["spawn_subagent"]);
  const retryTimeout = retried.logs.find((entry) =>
    entry.eventName ===
      "runtime_v2_plan_required_collaboration_provider_timeout"
  );
  assert.equal(retryTimeout?.data?.attempt, 2);
  assert.equal(retryTimeout?.data?.maxAttempts, 2);
  assert.equal(retryTimeout?.data?.stage, "discovery");
  assert.equal(retryTimeout?.data?.transport, "native_tool");
  assert.equal(retryTimeout?.data?.terminal, true);
  assert.equal(retryTimeout?.data?.action, "block");
  assert.equal(
    retried.logs.some((entry) =>
      entry.eventName === "runtime_v2_plan_provider_failed" &&
      entry.data?.action === "switch_to_synthesis"
    ),
    false,
  );
  assert.equal(retried.settlement.outcome.status, "completed");
  assert.equal(retried.settlement.outcome.resultKind, "blocked");
  assert.equal(retried.checkpoint.aggregate.terminalOutcome?.resultKind, "blocked");
  assert.equal(retried.checkpoint.aggregate.sealedWorkPlan, null);
  assert.deepEqual(retried.checkpoint.aggregate.subagents, []);
  assert.deepEqual(retried.checkpoint.aggregate.scheduledCommands, []);
  const durableRetryTimeouts = retried.checkpoint.aggregate.events.filter((entry) =>
    entry.type === "command.completed" &&
    entry.status === "failed" &&
    entry.failureReasonCode ===
      "runtime_v2_plan_required_collaboration_provider_timeout"
  );
  assert.equal(durableRetryTimeouts.length, 2);
  assert.equal(
    retried.checkpoint.aggregate.events.filter((entry) =>
      entry.type === "command.scheduled" &&
      entry.command.kind === "request_model" &&
      entry.command.payload.requiredSpawn === true
    ).length,
    2,
  );

  const twoTimeoutCheckpoint = planningCheckpointWithRequiredSpawnTimeouts(2);
  let exhaustedProviderCalls = 0;
  const exhausted = await runProductionPlanScenario(
    async () => {
      exhaustedProviderCalls += 1;
      throw new Error("a fully consumed cold spawn retry must not call the provider");
    },
    async (name) => {
      if (name === "get_project_skeleton") return "src/main.js";
      throw new Error(`unexpected tool ${name}`);
    },
    {
      initialCheckpoint: twoTimeoutCheckpoint,
      turnInputContextSignals: {
        subagentPreference: "unspecified",
        subagentRequirement: "required",
      },
      subagentCapacityPolicy: {
        maxActiveRequests: 1,
        modelRequestMode: "parallel",
      },
    },
  );

  assert.equal(exhaustedProviderCalls, 0);
  assert.equal(
    exhausted.logs.some((entry) =>
      entry.eventName === "runtime_v2_plan_provider_request_opened"
    ),
    false,
  );
  assert.equal(exhausted.settlement.outcome.status, "completed");
  assert.equal(exhausted.settlement.outcome.resultKind, "blocked");
  assert.equal(exhausted.checkpoint.aggregate.terminalOutcome?.resultKind, "blocked");
  assert.equal(exhausted.checkpoint.aggregate.sealedWorkPlan, null);
  assert.deepEqual(exhausted.checkpoint.aggregate.subagents, []);
  assert.deepEqual(exhausted.checkpoint.aggregate.scheduledCommands, []);
  assert.equal(
    exhausted.checkpoint.aggregate.events.filter((entry) =>
      entry.type === "command.scheduled" &&
      entry.command.kind === "request_model" &&
      entry.command.payload.requiredSpawn === true
    ).length,
    2,
  );
  const exhaustedTerminal = exhausted.logs.find((entry) =>
    entry.eventName === "runtime_v2_plan_terminal"
  );
  assert.equal(exhaustedTerminal?.data?.resultKind, "blocked");
  assert.equal(
    exhaustedTerminal?.data?.detailCode,
    "runtime_v2_plan_required_collaboration_provider_timeout",
  );
});

test("cold-restored required Plan rehydrates completed child evidence before its first provider request", async () => {
  const restored = planningCheckpointWithCompletedChild();
  let providerCalls = 0;
  let firstTranscript = "";
  let firstToolNames = [];
  let firstToolChoice = null;
  const result = await runProductionPlanScenario(
    async (
      messages,
      _settings,
      _callbacks,
      _signal,
      tools,
      _maxOutputTokens,
      requestOptions,
    ) => {
      providerCalls += 1;
      firstTranscript = messages
        .map((message) => String(message.content || ""))
        .join("\n");
      firstToolNames = tools.map((tool) => tool.function.name);
      firstToolChoice = requestOptions.toolChoice;
      return {
        content: "",
        toolCalls: [{
          id: "submit-from-restored-child",
          name: "submit_runtime_v2_work_plan",
          arguments: JSON.stringify({
            planMarkdown: `Adopt the restored child finding ${restored.evidenceId}.`,
            changes: [{
              title: "Create the bounded repaired owner",
              operation: "create",
              targets: ["src/restored-owner.js"],
              basis: [restored.evidenceId],
              change: "Create the repaired owner described by the restored child finding.",
              expectedOutcome: "The repaired owner exists without modifying the reviewed source.",
              dependsOn: [],
              criterionIds: ["criterion-user-objective"],
            }],
            validations: [{
              kind: "finite_command",
              command: "npm run build",
              cwd: "/fixture",
              expectedOutcome: "Build succeeds.",
              required: true,
              stepIndexes: [0],
              criterionIds: ["criterion-user-objective"],
            }],
          }),
        }],
        usage: {},
        protocolViolation: null,
      };
    },
    async (name) => {
      if (name === "get_project_skeleton") return "src/main.js";
      if (name === "write_file") return "written";
      throw new Error(`unexpected tool ${name}`);
    },
    {
      initialCheckpoint: restored.checkpoint,
      turnInputContextSignals: {
        subagentPreference: "unspecified",
        subagentRequirement: "required",
      },
      subagentCapacityPolicy: {
        maxActiveRequests: 1,
        modelRequestMode: "parallel",
      },
    },
  );

  assert.equal(providerCalls, 1);
  assert.match(firstTranscript, new RegExp(
    restored.evidenceId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
  ));
  assert.match(firstTranscript, /Cold-restored child report cites/);
  assert.match(
    firstTranscript,
    /The restored child found the existing owner in src\/main\.js/,
  );
  assert.equal(firstToolNames.includes("spawn_subagent"), true, "a completed child does not consume a total task quota");
  assert.equal(firstToolNames.includes("submit_runtime_v2_work_plan"), true);
  assert.equal(firstToolChoice, "required");
  assert.equal(result.settlement.outcome.status, "paused");
  assert.equal(result.checkpoint.aggregate.phase, "reviewing");
  assert.ok(
    result.checkpoint.aggregate.sealedWorkPlan.draft.steps[0].basis.includes(
      restored.evidenceId,
    ),
  );
  assert.equal(
    result.checkpoint.aggregate.events.filter((entry) =>
      entry.type === "subagents.scheduled"
    ).length,
    1,
  );
  assert.equal(
    result.checkpoint.aggregate.events.some((entry) =>
      entry.type === "command.scheduled" &&
      entry.command.kind === "schedule_subagents"
    ),
    false,
  );
  assert.equal(
    result.logs.some((entry) =>
      entry.eventName === "runtime_v2_plan_submission_rejected"
    ),
    false,
  );
  const firstRequest = result.checkpoint.aggregate.events.find((entry) =>
    entry.type === "command.scheduled" &&
    entry.command.kind === "request_model"
  );
  assert.equal(firstRequest.command.payload.collaborationRequired, true);
  assert.equal(firstRequest.command.payload.collaborationRequirementMet, true);
});

test("cold-restored reviewing Plan reconciles one missing sealed child handoff exactly once", async () => {
  const restored = reviewingCheckpointWithUnreconciledChildHandoff();
  let providerCalls = 0;
  const runRestoredReview = (initialCheckpoint) => runProductionPlanScenario(
    async () => {
      providerCalls += 1;
      throw new Error("a reviewing cold restore must not call the provider");
    },
    async (name) => {
      throw new Error(`a reviewing cold restore must not execute ${name}`);
    },
    { initialCheckpoint },
  );

  const first = await runRestoredReview(restored.checkpoint);
  assert.equal(providerCalls, 0);
  assert.equal(first.settlement.outcome.status, "paused");
  const sealed = first.checkpoint.aggregate.events.find((entry) =>
    entry.type === "work_plan.sealed"
  );
  assert.ok(sealed);
  const firstApplied = first.checkpoint.aggregate.events.filter((entry) =>
    entry.type === "subagent.handoff_applied"
  );
  assert.equal(firstApplied.length, 1);
  assert.equal(firstApplied[0].jobId, restored.child.id);
  assert.deepEqual(firstApplied[0].evidenceIds, [restored.evidenceId]);
  assert.equal(firstApplied[0].source, "work_plan");
  assert.equal(firstApplied[0].sourceEventId, sealed.eventId);
  assert.ok(firstApplied[0].sequence > sealed.sequence);
  const reconciledRevision = first.checkpoint.revision;

  const second = await runRestoredReview(first.checkpoint);
  assert.equal(providerCalls, 0);
  assert.equal(second.settlement.outcome.status, "paused");
  assert.equal(second.checkpoint.revision, reconciledRevision);
  const secondApplied = second.checkpoint.aggregate.events.filter((entry) =>
    entry.type === "subagent.handoff_applied"
  );
  assert.equal(secondApplied.length, 1);
  assert.equal(secondApplied[0].eventId, firstApplied[0].eventId);
});

test("cold-restored Plan preserves an explicit caller deadline", async () => {
  const checkpoint = planningCheckpointWithRequirement("optional", true);
  const durableRunStarted = checkpoint.aggregate.events.find((entry) =>
    entry.type === "run.started"
  );
  assert.ok(durableRunStarted);
  const originalNow = Date.now;
  let providerCalls = 0;
  let result;

  Date.now = () =>
    durableRunStarted.at + EXPLICIT_PLAN_TEST_BUDGET_MS + 1;
  try {
    result = await runProductionPlanScenario(
      async () => {
        providerCalls += 1;
        return {
          content: "",
          toolCalls: [{
            id: "submit-after-expired-cold-restore",
            name: "submit_runtime_v2_work_plan",
            arguments: JSON.stringify({
              planMarkdown: "Create and validate the bounded restored fixture.",
              changes: [{
                title: "Create the restored fixture",
                operation: "create",
                targets: ["src/restored-deadline.js"],
                change: "Create the bounded fixture after review.",
                expectedOutcome: "The restored fixture exists.",
                dependsOn: [],
                criterionIds: ["criterion-user-objective"],
              }],
              validations: [{
                kind: "finite_command",
                command: "npm run build",
                cwd: "/fixture",
                expectedOutcome: "Build succeeds.",
                required: true,
                stepIndexes: [0],
                criterionIds: ["criterion-user-objective"],
              }],
            }),
          }],
          usage: {},
          protocolViolation: null,
        };
      },
      async (name) => {
        if (name === "get_project_skeleton") return "src/main.js";
        if (name === "write_file") return "written";
        throw new Error(`unexpected tool ${name}`);
      },
      { initialCheckpoint: checkpoint },
    );
  } finally {
    Date.now = originalNow;
  }

  assert.equal(
    providerCalls,
    0,
    "cold recovery must not renew an explicit caller deadline",
  );
  assert.equal(result.settlement.outcome.status, "completed");
  assert.equal(result.checkpoint.aggregate.sealedWorkPlan, null);
  assert.equal(
    result.checkpoint.aggregate.events.some((entry) =>
      entry.type === "command.scheduled" &&
      entry.command.kind === "request_model"
    ),
    false,
  );
  const terminal = result.logs.find((entry) =>
    entry.eventName === "runtime_v2_plan_terminal"
  );
  assert.equal(terminal?.data?.detailCode, "runtime_v2_plan_deadline_reached");
});

test("Plan applies child handoff only from a sealed WorkPlan basis, not a rejected truncated result", async () => {
  const restored = planningCheckpointWithCompletedChild();
  let providerRound = 0;
  const result = await runProductionPlanScenario(
    async () => {
      providerRound += 1;
      if (providerRound === 1) {
        return {
          content: `I inspected ${restored.evidenceId}, but this WorkPlan response was truncated.`,
          toolCalls: [{
            id: "truncated-child-plan",
            name: "submit_runtime_v2_work_plan",
            arguments: JSON.stringify({
              planMarkdown: "", // The truncated response has no complete reviewable body.
              changes: [],
            }),
          }],
          finishReason: "length",
          usage: {},
          protocolViolation: "tool_call_truncated",
        };
      }
      return {
        content: "",
        toolCalls: [{
          id: "submit-sealed-child-plan",
          name: "submit_runtime_v2_work_plan",
          arguments: JSON.stringify({
            planMarkdown: `Adopt the completed child finding ${restored.evidenceId}.`,
            changes: [{
              title: "Create the child-grounded owner",
              operation: "create",
              targets: ["src/child-grounded-owner.js"],
              basis: [restored.evidenceId],
              change: "Create the bounded owner justified by the completed child finding.",
              expectedOutcome: "The child-grounded owner exists.",
              dependsOn: [],
              criterionIds: ["criterion-user-objective"],
            }],
            validations: [{
              kind: "finite_command",
              command: "npm run build",
              cwd: "/fixture",
              expectedOutcome: "Build succeeds.",
              required: true,
              stepIndexes: [0],
              criterionIds: ["criterion-user-objective"],
            }],
          }),
        }],
        usage: {},
        protocolViolation: null,
      };
    },
    async (name) => {
      if (name === "get_project_skeleton") return "src/main.js";
      if (name === "write_file") return "written";
      throw new Error(`unexpected tool ${name}`);
    },
    {
      initialCheckpoint: restored.checkpoint,
      turnInputContextSignals: {
        subagentPreference: "unspecified",
        subagentRequirement: "required",
      },
      subagentCapacityPolicy: {
        maxActiveRequests: 1,
        modelRequestMode: "parallel",
      },
    },
  );

  assert.equal(providerRound, 2);
  assert.equal(result.settlement.outcome.status, "paused");
  const events = result.checkpoint.aggregate.events;
  const rejectedProviderResult = events.find((entry) =>
    entry.type === "provider.responded" &&
    entry.result.diagnostics.some((diagnostic) =>
      diagnostic.code === "tool_arguments_rejected"
    )
  );
  assert.ok(rejectedProviderResult);
  assert.deepEqual(rejectedProviderResult.result.toolCalls, []);
  assert.match(
    rejectedProviderResult.result.visibleText || "",
    new RegExp(restored.evidenceId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
  );
  assert.ok(result.logs.some((entry) =>
    entry.eventName === "runtime_v2_plan_provider_response_shape" &&
    entry.data?.finishReason === "length" &&
    entry.data?.admittedToolCallCount === 0
  ));
  const sealed = events.find((entry) => entry.type === "work_plan.sealed");
  assert.ok(sealed);
  assert.ok(sealed.sealedPlan.draft.steps[0].basis.includes(restored.evidenceId));
  const applied = events.filter((entry) =>
    entry.type === "subagent.handoff_applied"
  );
  assert.equal(applied.length, 1);
  assert.deepEqual(applied[0].evidenceIds, [restored.evidenceId]);
  assert.equal(
    applied[0].sourceEventId,
    sealed.eventId,
    "only the successfully sealed structured basis may adopt child evidence",
  );
  assert.equal(applied[0].source, "work_plan");
  assert.ok(applied[0].sequence > sealed.sequence);
  assert.notEqual(applied[0].sourceEventId, rejectedProviderResult.eventId);
});

test("Plan withholds new spawn below the shared child runway while preserving active wait", async () => {
  const originalNow = Date.now;
  const firstRestored = planningCheckpointWithActiveChild(true);
  const runStartedAt = firstRestored.checkpoint.aggregate.events.find((entry) =>
    entry.type === "run.started"
  )?.at;
  assert.equal(typeof runStartedAt, "number");
  const now = runStartedAt +
    EXPLICIT_PLAN_TEST_BUDGET_MS -
    runtime.RUNTIME_V2_SUBAGENT_MIN_START_REMAINING_MS +
    1;
  const waitRequests = [];
  let waitAbortCtrl = null;
  let waitDiagnosticAbort = null;
  let waitResult;

  Date.now = () => now;
  try {
    waitResult = await runProductionPlanScenario(
      async (
        _messages,
        _settings,
        _callbacks,
        _signal,
        tools,
        _maxOutputTokens,
        requestOptions,
      ) => {
        waitRequests.push({
          toolNames: tools.map((tool) => tool.function.name),
          requestOptions,
        });
        if (waitRequests.length === 1) {
          return {
            content: "",
            toolCalls: [{
              id: "wait-near-plan-deadline",
              name: "wait_subagents",
              arguments: JSON.stringify({
                collaboration_task_ids: firstRestored.child.scopeKey,
              }),
            }],
            usage: {},
            protocolViolation: null,
          };
        }
        waitAbortCtrl.abort("near-deadline wait contract captured");
        return {
          content: "",
          toolCalls: [],
          usage: {},
          protocolViolation: null,
        };
      },
      async (name) => {
        if (name === "get_project_skeleton") return "src/main.js";
        throw new Error(`unexpected tool ${name}`);
      },
      {
        initialCheckpoint: firstRestored.checkpoint,
        turnInputContextSignals: {
          subagentPreference: "preferred",
          subagentRequirement: "optional",
        },
        subagentCapacityPolicy: {
          maxActiveRequests: 2,
          modelRequestMode: "parallel",
        },
        onAbortCtrl: (controller) => {
          waitAbortCtrl = controller;
          waitDiagnosticAbort = setTimeout(
            () => controller.abort("near-deadline wait test timeout"),
            2_000,
          );
        },
      },
    );
  } finally {
    Date.now = originalNow;
    if (waitDiagnosticAbort) clearTimeout(waitDiagnosticAbort);
  }

  assert.ok(waitRequests.length >= 1);
  assert.equal(waitRequests[0].toolNames.includes("spawn_subagent"), false);
  assert.equal(waitRequests[0].toolNames.includes("wait_subagents"), true);
  assert.equal(waitRequests[0].requestOptions.toolChoice, "required");
  assert.ok(waitResult.checkpoint.aggregate.events.some((entry) =>
    entry.type === "command.scheduled" &&
    entry.command.kind === "join_subagents"
  ));
  assert.ok(waitResult.checkpoint.aggregate.events.some((entry) =>
    entry.type === "subagent.completed" &&
    entry.jobId === firstRestored.child.id
  ));

  const secondRestored = planningCheckpointWithActiveChild(true);
  const secondRunStartedAt = secondRestored.checkpoint.aggregate.events.find(
    (entry) => entry.type === "run.started",
  )?.at;
  assert.equal(typeof secondRunStartedAt, "number");
  const secondNow = secondRunStartedAt +
    EXPLICIT_PLAN_TEST_BUDGET_MS -
    runtime.RUNTIME_V2_SUBAGENT_MIN_START_REMAINING_MS +
    1;
  const spawnRequests = [];
  let spawnAbortCtrl = null;
  let spawnDiagnosticAbort = null;
  let spawnResult;
  Date.now = () => secondNow;
  try {
    spawnResult = await runProductionPlanScenario(
      async (
        _messages,
        settings,
        _callbacks,
        _signal,
        tools,
        _maxOutputTokens,
        requestOptions,
      ) => {
        spawnRequests.push({
          toolNames: tools.map((tool) => tool.function.name),
          requestOptions,
        });
        if (spawnRequests.length > 1) spawnAbortCtrl.abort("near-deadline spawn admission captured");
        return {
          content: "",
          toolCalls: [{
            id: "late-duplicate-spawn",
            name: "spawn_subagent",
            arguments: JSON.stringify({
              task_key: secondRestored.child.scopeKey,
              task_kind: "review",
              access_mode: "read",
              objective: "Start another review despite insufficient lifecycle runway.",
              success_criteria: "Return one bounded source finding.",
              required_paths: "src/main.js",
              allowed_paths: "src/main.js",
            }),
          }],
          usage: {},
          protocolViolation: null,
        };
      },
      async (name) => {
        if (name === "get_project_skeleton") return "src/main.js";
        throw new Error(`unexpected tool ${name}`);
      },
      {
        initialCheckpoint: secondRestored.checkpoint,
        turnInputContextSignals: {
          subagentPreference: "preferred",
          subagentRequirement: "optional",
        },
        subagentCapacityPolicy: {
          maxActiveRequests: 2,
          modelRequestMode: "parallel",
        },
        onAbortCtrl: (controller) => {
          spawnAbortCtrl = controller;
          spawnDiagnosticAbort = setTimeout(
            () => controller.abort("near-deadline spawn test timeout"),
            2_000,
          );
        },
      },
    );
  } finally {
    Date.now = originalNow;
    if (spawnDiagnosticAbort) clearTimeout(spawnDiagnosticAbort);
  }

  assert.equal(spawnRequests.length, 2);
  assert.equal(spawnRequests[0].toolNames.includes("spawn_subagent"), false);
  assert.equal(spawnRequests[0].toolNames.includes("wait_subagents"), true);
  const quarantined = spawnResult.checkpoint.aggregate.events.find((entry) =>
    entry.type === "provider.responded" &&
    entry.result.diagnostics.some((diagnostic) =>
      diagnostic.code === "tool_surface_rejected"
    )
  );
  assert.ok(quarantined);
  assert.deepEqual(quarantined.result.toolCalls, []);
  assert.equal(
    spawnResult.checkpoint.aggregate.events.filter((entry) =>
      entry.type === "subagents.scheduled"
    ).length,
    1,
    "the original active child must remain the only admitted child",
  );
  assert.equal(
    spawnResult.checkpoint.aggregate.events.some((entry) =>
      entry.type === "command.scheduled" &&
      entry.command.kind === "schedule_subagents"
    ),
    false,
  );
});

test("cold-restored aggregate required Plan cannot be downgraded by optional context", async () => {
  const requests = [];
  let abortCtrl = null;
  let diagnosticAbort = null;
  const prematureSubmission = {
    planMarkdown: "Attempt to submit without the required restored collaboration.",
    changes: [{
      title: "Create the bounded fixture",
      operation: "create",
      targets: ["src/restored-required.js"],
      change: "Create the bounded fixture after planning approval.",
      expectedOutcome: "The fixture exists.",
      dependsOn: [],
      criterionIds: ["criterion-user-objective"],
    }],
    validations: [{
      kind: "finite_command",
      command: "npm run build",
      cwd: "/fixture",
      expectedOutcome: "Build succeeds.",
      required: true,
      stepIndexes: [0],
      criterionIds: ["criterion-user-objective"],
    }],
  };
  const result = await runProductionPlanScenario(
    async (
      messages,
      _settings,
      _callbacks,
      _signal,
      tools,
      _maxOutputTokens,
      requestOptions,
    ) => {
      requests.push({ messages, tools, requestOptions });
      if (requests.length === 1) {
        return {
          content: "",
          toolCalls: [{
            id: "restored-required-premature-submit",
            name: "submit_runtime_v2_work_plan",
            arguments: JSON.stringify(prematureSubmission),
          }],
          usage: {},
          protocolViolation: null,
        };
      }
      abortCtrl.abort("restored-required-gate-captured");
      return {
        content: "",
        toolCalls: [],
        usage: {},
        protocolViolation: null,
      };
    },
    async (name) => {
      if (name === "get_project_skeleton") return "src/main.js";
      throw new Error(`unexpected tool ${name}`);
    },
    {
      initialCheckpoint: planningCheckpointWithRequirement("required"),
      turnInputContextSignals: {
        subagentPreference: "unspecified",
        subagentRequirement: "optional",
      },
      subagentCapacityPolicy: {
        maxActiveRequests: 1,
        modelRequestMode: "parallel",
      },
      onAbortCtrl: (controller) => {
        abortCtrl = controller;
        diagnosticAbort = setTimeout(
          () => controller.abort("restored-required-test-timeout"),
          2_000,
        );
      },
    },
  );
  if (diagnosticAbort) clearTimeout(diagnosticAbort);

  assert.equal(requests.length, 2);
  for (const request of requests) {
    assert.deepEqual(
      request.tools.map((tool) => tool.function.name),
      ["spawn_subagent"],
    );
    assert.deepEqual(request.requestOptions.toolChoice, {
      type: "function",
      function: { name: "spawn_subagent" },
    });
  }
  assert.match(
    requests[0].messages.map((message) => message.content || "").join("\n"),
    /\[REQUIRED COLLABORATION\]/,
  );
  assert.equal(result.checkpoint.aggregate.sealedWorkPlan, null);
  assert.equal(
    result.checkpoint.aggregate.events.some((entry) =>
      entry.type === "work_plan.sealed"
    ),
    false,
  );
  assert.equal(result.checkpoint.aggregate.subagents.length, 0);
  const requestCommands = result.checkpoint.aggregate.events.filter((entry) =>
    entry.type === "command.scheduled" &&
    entry.command.kind === "request_model"
  );
  assert.equal(requestCommands.length, 2);
  assert.equal(requestCommands[0].command.payload.collaborationRequired, true);
  assert.equal(requestCommands[1].command.payload.collaborationRequired, true);
  assert.ok(result.logs.some((entry) =>
    entry.eventName === "runtime_v2_plan_submission_rejected" &&
    /required planning collaboration/i.test(String(entry.data?.detail || ""))
  ));
});

test("cold-restored aggregate optional Plan cannot be upgraded by required context", async () => {
  let providerCalls = 0;
  let firstTranscript = "";
  let firstToolNames = [];
  let firstToolChoice = null;
  const result = await runProductionPlanScenario(
    async (
      messages,
      _settings,
      _callbacks,
      _signal,
      tools,
      _maxOutputTokens,
      requestOptions,
    ) => {
      providerCalls += 1;
      firstTranscript = messages
        .map((message) => String(message.content || ""))
        .join("\n");
      firstToolNames = tools.map((tool) => tool.function.name);
      firstToolChoice = requestOptions.toolChoice;
      return {
        content: "",
        toolCalls: [{
          id: "submit-restored-optional-plan",
          name: "submit_runtime_v2_work_plan",
          arguments: JSON.stringify({
            planMarkdown: "Create and validate the bounded optional fixture.",
            changes: [{
              title: "Create the optional fixture",
              operation: "create",
              targets: ["src/restored-optional.js"],
              change: "Create the bounded fixture after approval.",
              expectedOutcome: "The optional fixture exists.",
              dependsOn: [],
              criterionIds: ["criterion-user-objective"],
            }],
            validations: [{
              kind: "finite_command",
              command: "npm run build",
              cwd: "/fixture",
              expectedOutcome: "Build succeeds.",
              required: true,
              stepIndexes: [0],
              criterionIds: ["criterion-user-objective"],
            }],
          }),
        }],
        usage: {},
        protocolViolation: null,
      };
    },
    async (name) => {
      if (name === "get_project_skeleton") return "src/main.js";
      if (name === "write_file") return "written";
      throw new Error(`unexpected tool ${name}`);
    },
    {
      initialCheckpoint: planningCheckpointWithRequirement("optional"),
      turnInputContextSignals: {
        subagentPreference: "unspecified",
        subagentRequirement: "required",
      },
      subagentCapacityPolicy: {
        maxActiveRequests: 1,
        modelRequestMode: "parallel",
      },
    },
  );

  assert.equal(providerCalls, 1);
  assert.equal(firstTranscript.includes("[REQUIRED COLLABORATION]"), false);
  assert.deepEqual(firstToolNames, [
    "read_file",
    "submit_runtime_v2_work_plan",
  ]);
  assert.equal(firstToolChoice, "required");
  assert.equal(result.settlement.outcome.status, "paused");
  assert.equal(result.checkpoint.aggregate.phase, "reviewing");
  assert.ok(result.checkpoint.aggregate.sealedWorkPlan);
  assert.equal(
    result.checkpoint.aggregate.events.some((entry) =>
      entry.type === "subagents.scheduled" ||
      (
        entry.type === "command.scheduled" &&
        entry.command.kind === "schedule_subagents"
      )
    ),
    false,
  );
  assert.equal(
    result.logs.some((entry) =>
      entry.eventName === "runtime_v2_plan_submission_rejected"
    ),
    false,
  );
  const firstRequest = result.checkpoint.aggregate.events.find((entry) =>
    entry.type === "command.scheduled" &&
    entry.command.kind === "request_model"
  );
  assert.equal(firstRequest.command.payload.collaborationRequired, false);
  assert.equal(firstRequest.command.payload.collaborationRequirementMet, false);
});

test("production Plan preserves a non-empty graph with a missing required change as a diagnostic draft", async () => {
  let round = 0;
  const validSubmission = {
    planMarkdown: "Create the implementation before its deterministic tests.",
    changes: [{
      title: "Create implementation",
      operation: "create",
      targets: ["snake.py"],
      change: "Create the game implementation.",
      expectedOutcome: "The implementation exists.",
      dependsOn: [],
      criterionIds: ["criterion-user-objective"],
    }, {
      title: "Create tests",
      operation: "create",
      targets: ["test_snake.py"],
      change: "Create deterministic logic tests.",
      expectedOutcome: "The implementation has automated coverage.",
      dependsOn: [0],
      criterionIds: ["criterion-user-objective"],
    }],
    validations: [{
      kind: "finite_command",
      command: "python3 -m unittest -v",
      expectedOutcome: "The tests pass.",
      required: true,
      stepIndexes: [0, 1],
      criterionIds: ["criterion-user-objective"],
    }],
  };
  const result = await runProductionPlanScenario(
    async () => {
      round += 1;
      const invalidSubmission = structuredClone(validSubmission);
      delete invalidSubmission.changes[1].change;
      return planProviderReply("submit-incomplete-graph", "submit_runtime_v2_work_plan", invalidSubmission);
    },
    async (name) => {
      if (name === "get_project_skeleton") return "empty fixture";
      if (name === "write_file") return "written";
      throw new Error(`unexpected tool ${name}`);
    },
  );

  assert.equal(round, 1, "an existing reviewable document is not regenerated for a structure gap");
  assert.equal(result.settlement.outcome.resultKind, "partial");
  assert.equal(result.savedDocuments.length, 1);
  assert.match(result.savedDocuments[0].markdown, /Create the implementation before its deterministic tests/);
  assert.equal(result.checkpoint.aggregate.sealedWorkPlan, null,
    "a title fallback must not conceal the missing required change specification");
  assert.equal(result.checkpoint.aggregate.events.some(event => event.type === "work_plan.sealed" || event.type === "work_plan.approved"), false);
  const draft = loadTs(path.join(workspaceRoot, "src/lib/planDocumentRecords.ts")).resolvePlanDraftFromAggregate(result.checkpoint.aggregate);
  assert.ok(draft);
  assert.ok(draft.diagnostics.some(diagnostic => diagnostic.fieldPath.endsWith("changes[1].change")),
    "the retained draft identifies the exact missing authored field");
});

test("production Plan runs, joins, and adopts one read-only child before review", async () => {
  let parentRound = 0;
  let childRound = 0;
  let parentReadWhileChildActive = false;
  let childInFlight = false;
  const requestTools = [];
  let diagnosticAbort = null;
  const result = await runProductionPlanScenario(
    async (messages, _settings, callbacks, _signal, tools) => {
      const requestTranscript = messages
        .map((message) => [String(message.content || ""), ...(message.tool_calls || []).map((call) => call.function.arguments)].join("\n"))
        .join("\n");
      if (/read-only child of the current MAIN turn/i.test(requestTranscript)) {
        childRound += 1;
        childInFlight = true;
        callbacks.onLifecycle?.({ phase: "first_chunk" });
        if (childRound === 1) {
          await new Promise((resolve) => setTimeout(resolve, 60));
          childInFlight = false;
          return {
            content: "",
            toolCalls: [{
              id: "child-read-main",
              name: "read_file",
              arguments: JSON.stringify({ path: "src/main.js" }),
            }],
            usage: {},
            protocolViolation: null,
          };
        }
        const transcript = messages
          .map((message) => [String(message.content || ""), ...(message.tool_calls || []).map((call) => call.function.arguments)].join("\n"))
          .join("\n");
        const evidenceId = transcript.match(/child:[^\s,]+:E1/)?.[0];
        assert.ok(evidenceId, "the child must cite its real tool evidence");
        assert.match(
          evidenceId,
          /^child:[0-9a-f]{32}:E1$/,
          "provider-facing child evidence ids must stay compact and stable",
        );
        assert.equal(childRound, 2);
        assert.ok(tools.some((tool) => tool.function.name === "read_file"), "ordinary final and safe reads share one child surface");
        assert.equal(tools.some((tool) => tool.function.name === "submit_runtime_v2_subagent_report"), false);
        childInFlight = false;
        const childSummary =
          `The reviewed owner is in src/main.js (${evidenceId}).`;
        return {
          content: childSummary,
          semanticContent: childSummary,
          actionableContent: childSummary,
          toolCalls: [],
          usage: {},
          protocolViolation: null,
        };
      }

      parentRound += 1;
      await new Promise((resolve) => setTimeout(resolve, 1));
      const names = tools.map((tool) => tool.function.name);
      requestTools.push(names);
      if (parentRound === 1) {
        assert.equal(names.includes("spawn_subagent"), true);
        return {
          content: "",
          toolCalls: [{
            id: "spawn-owner-review",
            name: "spawn_subagent",
            arguments: JSON.stringify({
              task_key: "owner-review",
              task_kind: "review",
              access_mode: "read",
              objective: "Independently review the current source owner.",
              success_criteria: "Return one cited source finding.",
              required_paths: "src/main.js",
              allowed_paths: "src/main.js",
            }),
          }],
          usage: {},
          protocolViolation: null,
        };
      }
      if (parentRound === 2) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        parentReadWhileChildActive = childInFlight;
        assert.equal(names.includes("wait_subagents"), true);
        assert.equal(names.includes("spawn_subagent"), true, "a queued child waits at transport admission without closing independent tasks");
        return {
          content: "",
          toolCalls: [{
            id: "parent-read-main",
            name: "read_file",
            arguments: JSON.stringify({ path: "src/main.js" }),
          }],
          usage: {},
          protocolViolation: null,
        };
      }
      if (parentRound === 3) {
        assert.equal(names.includes("wait_subagents"), true);
        return {
          content: "",
          toolCalls: [{
            id: "wait-owner-review",
            name: "wait_subagents",
            arguments: JSON.stringify({
              collaboration_task_ids: "owner-review",
            }),
          }],
          usage: {},
          protocolViolation: null,
        };
      }
      const transcript = messages
        .map((message) => [String(message.content || ""), ...(message.tool_calls || []).map((call) => call.function.arguments)].join("\n"))
        .join("\n");
      const childEvidenceId = transcript.match(/child:[^\s,]+:E1/)?.[0];
      assert.ok(childEvidenceId, "joined child evidence must reach the parent");
      assert.match(transcript, /SUBAGENT_RESULTS/);
      assert.ok(names.includes("read_file"), "joined child evidence does not close safe source reads");
      assert.ok(names.includes("submit_runtime_v2_work_plan"));
      assert.equal(names.includes("write_file"), false);
      assert.match(transcript, /Report: The reviewed owner is in src\/main\.js/);
      assert.match(transcript, /Finding: The reviewed owner is in src\/main\.js/);
      return {
        content: "",
        toolCalls: [{
          id: "submit-after-child",
          name: "submit_runtime_v2_work_plan",
          arguments: JSON.stringify({
            planMarkdown: `Use parent source E2 and adopted child finding ${childEvidenceId}.`,
            changes: [{
              title: "Update the reviewed owner",
              operation: "modify",
              targets: ["src/main.js"],
              basis: ["E2", childEvidenceId],
              change: "Update the reviewed owner while preserving its public boundary.",
              expectedOutcome: "The owner remains coherent.",
              dependsOn: [],
              criterionIds: ["criterion-user-objective"],
            }],
            validations: [{
              kind: "finite_command",
              command: "npm run build",
              cwd: "/fixture",
              expectedOutcome: "Build succeeds.",
              required: true,
              stepIndexes: [0],
              criterionIds: ["criterion-user-objective"],
            }],
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
          ? "export const owner = 'reviewed';"
          : "export const owner = 'reviewed';";
      }
      if (name === "write_file") return "written";
      throw new Error(`unexpected tool ${name}`);
    },
    {
      turnInputContextSignals: { subagentPreference: "preferred" },
      subagentCapacityPolicy: {
        maxActiveRequests: 1,
        modelRequestMode: "parallel",
      },
      onAbortCtrl: (controller) => {
        diagnosticAbort = setTimeout(
          () => controller.abort("plan-collaboration-test-timeout"),
          2_000,
        );
      },
    },
  );

  if (diagnosticAbort) clearTimeout(diagnosticAbort);
  assert.equal(
    result.settlement.outcome.status,
    "paused",
    JSON.stringify({
      parentRound,
      childRound,
      events: result.checkpoint.aggregate.events.map((entry) =>
        entry.type === "command.scheduled"
          ? `${entry.type}:${entry.command.kind}`
          : entry.type
      ),
      logs: result.logs.slice(-8),
      collaborationFailures: result.logs.filter((entry) =>
        /collaboration/.test(entry.eventName)
      ),
      subagentLogs: result.logs.filter((entry) =>
        /subagent/.test(entry.eventName)
      ),
    }),
  );
  assert.equal(parentReadWhileChildActive, true);
  assert.equal(parentRound, 4);
  assert.equal(childRound, 2);
  const aggregate = result.checkpoint.aggregate;
  const events = aggregate.events;
  const sequenceOf = (type) => events.find((entry) => entry.type === type)?.sequence;
  assert.ok(events.some((entry) =>
    entry.type === "command.scheduled" &&
    entry.command.kind === "schedule_subagents"
  ));
  assert.ok(events.some((entry) => entry.type === "subagents.scheduled"));
  assert.ok(events.some((entry) =>
    entry.type === "command.scheduled" &&
    entry.command.kind === "join_subagents"
  ));
  const childCompletion = events.find((entry) =>
    entry.type === "subagent.completed"
  );
  assert.equal(childCompletion?.status, "completed");
  assert.ok(childCompletion?.report);
  assert.ok(events.some((entry) => entry.type === "subagent.handoff_delivered"));
  assert.ok(events.some((entry) => entry.type === "subagent.handoff_applied"));
  assert.ok(sequenceOf("subagent.completed") < sequenceOf("work_plan.sealed"));
  assert.ok(sequenceOf("work_plan.sealed") < sequenceOf("subagent.handoff_applied"));
  assert.equal(
    aggregate.subagents.some((job) =>
      job.status === "queued" || job.status === "running"
    ),
    false,
  );
  assert.equal(aggregate.subagents[0]?.status, "completed");
  assert.ok(aggregate.subagents[0]?.report);
  const childEvidence = aggregate.sealedWorkPlan.evidence.find((entry) =>
    entry.id.startsWith("child:")
  );
  assert.ok(childEvidence, JSON.stringify({
    sealedEvidence: aggregate.sealedWorkPlan.evidence,
    stepBasis: aggregate.sealedWorkPlan.draft.steps[0].basis,
    completed: events.filter((entry) =>
      entry.type === "subagent.completed"
    ),
  }));
  assert.equal(childEvidence.version, null);
  assert.ok(
    aggregate.sealedWorkPlan.draft.steps[0].basis.includes(childEvidence.id),
  );
  assert.ok(requestTools[1].includes("wait_subagents"));
  assert.deepEqual(requestTools[3], ["read_file", "spawn_subagent", "submit_runtime_v2_work_plan"]);
  assert.equal(result.logs.some(entry => entry.eventName === "runtime_v2_plan_submission_rejected"), false,
    "the first complete plan adopts the actual child finding instead of depending on semantic regeneration");
  assert.equal(result.savedDocuments.length, 1);

});

test("a complete Plan that omits joined child adoption saves a draft without granting acceptance", async () => {
  const inherited = planningCheckpointWithCompletedChild();
  const candidate = simplePlanSubmission("src/child-grounded-owner.js");
  let requests = 0;
  const result = await runProductionPlanScenario(async () => {
    assert.equal(++requests, 1, "missing child adoption preserves the original complete candidate");
    return planProviderReply("unadopted-child-plan", "submit_runtime_v2_work_plan", candidate);
  }, planFixtureTool, { initialCheckpoint: inherited.checkpoint });
  assert.equal(result.settlement.outcome.resultKind, "partial");
  assert.equal(result.savedDocuments.length, 1);
  assert.equal(result.checkpoint.aggregate.sealedWorkPlan, null);
  assert.equal(result.checkpoint.aggregate.events.some(event => event.type === "subagent.handoff_applied"), false);
  const draft = loadTs(path.join(workspaceRoot, "src/lib/planDocumentRecords.ts")).resolvePlanDraftFromAggregate(result.checkpoint.aggregate);
  assert.ok(draft.diagnostics.some(diagnostic => diagnostic.code === "plan_collaboration_incomplete"));
  assert.equal(result.state.activeActionRequest?.kind === "plan_review", false);
});

test("production Plan quarantines implement/write spawn arguments outside the advertised discovery schema", async () => {
  const parentRequests = [];
  let abortCtrl = null;
  let diagnosticAbort = null;
  const result = await runProductionPlanScenario(
    async (messages, _settings, _callbacks, _signal, tools) => {
      parentRequests.push({
        messages,
        toolNames: tools.map((tool) => tool.function.name),
      });
      if (parentRequests.length === 1) {
        assert.ok(tools.some((tool) =>
          tool.function.name === "spawn_subagent"
        ));
        return {
          content: "",
          toolCalls: [{
            id: "malformed-plan-writer",
            name: "spawn_subagent",
            arguments: JSON.stringify({
              task_key: "plan-writer",
              task_kind: "implement",
              access_mode: "write",
              objective: "Write before approval.",
              success_criteria: "Create src/new.js.",
              required_paths: "src/new.js",
              allowed_paths: "src/new.js",
              implementation_operation: "create",
              implementation_plan: "Create the file immediately.",
            }),
          }],
          usage: {},
          protocolViolation: null,
        };
      }

      abortCtrl.abort("plan-argument-rejection-surface-captured");
      return {
        content: "",
        toolCalls: [],
        usage: {},
        protocolViolation: null,
      };
    },
    async (name) => {
      if (name === "get_project_skeleton") return "src/main.js";
      if (name === "write_file") return "written";
      throw new Error(`unexpected tool ${name}`);
    },
    {
      turnInputContextSignals: { subagentPreference: "preferred" },
      subagentCapacityPolicy: {
        maxActiveRequests: 1,
        modelRequestMode: "parallel",
      },
      onAbortCtrl: (controller) => {
        abortCtrl = controller;
        diagnosticAbort = setTimeout(
          () => controller.abort("plan-argument-rejection-test-timeout"),
          2_000,
        );
      },
    },
  );
  if (diagnosticAbort) clearTimeout(diagnosticAbort);

  assert.equal(parentRequests.length, 2);
  assert.deepEqual(
    parentRequests[1].toolNames,
    parentRequests[0].toolNames,
    "an argument rejection must preserve the ordinary discovery surface",
  );
  assert.ok(parentRequests[1].toolNames.includes(
    "submit_runtime_v2_work_plan",
  ));
  assert.equal(result.checkpoint.aggregate.subagents.length, 0);
  const events = result.checkpoint.aggregate.events;
  assert.equal(
    events.some((entry) =>
      entry.type === "subagents.scheduled"
    ),
    false,
  );
  assert.equal(
    events.some((entry) =>
      entry.type === "command.scheduled" &&
      (entry.command.kind === "schedule_subagents" ||
        entry.command.kind === "execute_tool")
    ),
    false,
  );
  const quarantined = events.find((entry) =>
    entry.type === "provider.responded" &&
    entry.result.diagnostics.some((diagnostic) =>
      diagnostic.code === "tool_arguments_rejected"
    )
  );
  assert.ok(quarantined);
  assert.deepEqual(quarantined.result.toolCalls, []);
  assert.equal(
    result.logs.some((entry) =>
      entry.eventName === "runtime_v2_plan_collaboration_failed"
    ),
    false,
  );
});

test("production Plan quarantines the entire read batch when one call is missing its required path", async () => {
  const invalidCallId = "plan-read-without-required-path";
  const validCallId = "plan-read-valid-sibling";
  const parentRequests = [];
  const readExecutions = [];
  let abortCtrl = null;
  let diagnosticAbort = null;
  const result = await runProductionPlanScenario(
    async (messages, _settings, _callbacks, _signal, tools) => {
      parentRequests.push({
        messages,
        toolNames: tools.map((tool) => tool.function.name),
      });
      if (parentRequests.length === 1) {
        return {
          content: "",
          toolCalls: [
            { id: validCallId, name: "read_file", arguments: JSON.stringify({ path: "src/main.js" }) },
            { id: invalidCallId, name: "read_file", arguments: "{}" },
          ],
          usage: {},
          protocolViolation: null,
        };
      }

      abortCtrl.abort("plan-read-argument-rejection-surface-captured");
      return {
        content: "",
        toolCalls: [],
        usage: {},
        protocolViolation: null,
      };
    },
    async (name, args) => {
      if (name === "get_project_skeleton") return "src/main.js";
      if (name === "read_file") {
        readExecutions.push({ ...args });
        return "export const shouldNeverBeObserved = true;";
      }
      throw new Error(`unexpected tool ${name}`);
    },
    {
      onAbortCtrl: (controller) => {
        abortCtrl = controller;
        diagnosticAbort = setTimeout(
          () => controller.abort("plan-read-argument-rejection-test-timeout"),
          2_000,
        );
      },
    },
  );
  if (diagnosticAbort) clearTimeout(diagnosticAbort);

  assert.equal(parentRequests.length, 2);
  assert.ok(parentRequests[0].toolNames.includes("read_file"));
  assert.deepEqual(
    parentRequests[1].toolNames,
    parentRequests[0].toolNames,
    "a malformed advertised read must not advance discovery to synthesis",
  );
  assert.deepEqual(readExecutions, []);
  const events = result.checkpoint.aggregate.events;
  const quarantined = events.find((entry) =>
    entry.type === "provider.responded" &&
    entry.result.diagnostics.some((diagnostic) =>
      diagnostic.code === "tool_arguments_rejected"
    )
  );
  assert.ok(quarantined);
  assert.deepEqual(quarantined.result.toolCalls, []);
  assert.match(quarantined.result.diagnostics.find(item => item.code === "tool_arguments_rejected").message,
    /arguments\.path is required.*entire provider-selected batch was rejected/i);
  const retryMessages = parentRequests[1].messages;
  const rejectedGroupIndex = retryMessages.findIndex(message =>
    message.role === "assistant" && message.tool_calls?.some(call => call.id === invalidCallId));
  assert.notEqual(rejectedGroupIndex, -1);
  assert.deepEqual(retryMessages[rejectedGroupIndex].tool_calls.map(call => call.id), [validCallId, invalidCallId]);
  const replies = retryMessages.slice(rejectedGroupIndex + 1, rejectedGroupIndex + 3);
  assert.deepEqual(replies.map(message => [message.role, message.tool_call_id]),
    [["tool", validCallId], ["tool", invalidCallId]]);
  const feedback = replies.map(message => JSON.parse(message.content.replace(/^PLAN_TOOL_ARGUMENTS_REJECTED: /, "")));
  assert.deepEqual(feedback.map(item => [item.code, item.effect, item.responseDisposition]), [
    ["PLAN_TOOL_BATCH_REJECTED", "none", "rejected_before_dispatch"],
    ["PLAN_TOOL_ARGUMENTS_REJECTED", "none", "rejected_before_dispatch"],
  ]);
  assert.ok(feedback.every(item => item.rejectedTool === "read_file" && item.reason === "arguments.path is required"));
  assert.equal(
    events.some((entry) =>
      entry.type === "command.scheduled" &&
      entry.command.kind === "execute_tool" &&
      [validCallId, invalidCallId].includes(entry.command.payload.toolCallId)
    ),
    false,
  );
  assert.equal(
    events.some((entry) =>
      entry.type === "tool.completed"
    ),
    false,
  );
});

test("production Plan rejects a questionnaire missing title before a corrected call pauses", async () => {
  const now = Date.now();
  const admission = runtime.appendRuntimeV2Checkpoint({
    checkpoint: null, owner: turn, expectedRevision: 0,
    event: event(0, now, { type: "turn.admitted", turn, strategy: "plan", planPurpose: "plan",
      objective: "修复文件打开与标签显示", constraints: [],
      acceptanceCriteria: ["保留现有标签行为"], acceptanceCriterionIds: ["criterion-user-objective"] }),
  });
  assert.equal(admission.disposition, "committed");
  const invalidCallId = "plan-question-without-title";
  const correctedCallId = "plan-question-corrected-title";
  const title = "确认标签处理";
  const questions = [{ id: "label_behavior", prompt: "重新打开文件时，应复用当前标签还是新建标签？",
    selectionMode: "single", required: true, options: [{ id: "reuse", label: "复用当前标签" }, { id: "new", label: "新建标签" }] }];
  const requests = [];
  const result = await runProductionPlanScenario(
    async (messages, _settings, _callbacks, _signal, tools) => {
      const questionTool = tools.find(tool => tool.function.name === "ask_plan_questions");
      requests.push({ messages, required: questionTool?.function.parameters.required });
      return requests.length === 1
        ? planProviderReply(invalidCallId, "ask_plan_questions", { questions })
        : planProviderReply(correctedCallId, "ask_plan_questions", { title, questions });
    },
    planFixtureTool,
    { initialCheckpoint: admission.checkpoint },
  );
  assert.equal(requests.length, 2);
  assert.deepEqual(requests.map(request => request.required), [["title", "questions"], ["title", "questions"]]);
  const reply = requests[1].messages.find(message => message.role === "tool" && message.tool_call_id === invalidCallId);
  assert.ok(reply);
  const feedback = JSON.parse(reply.content.replace(/^PLAN_TOOL_ARGUMENTS_REJECTED: /, ""));
  assert.deepEqual([feedback.code, feedback.effect, feedback.reason],
    ["PLAN_TOOL_ARGUMENTS_REJECTED", "none", "arguments.title is required"]);
  const events = result.checkpoint.aggregate.events;
  const quarantined = events.find(entry => entry.type === "provider.responded" &&
    entry.result.diagnostics.some(item => item.code === "tool_arguments_rejected"));
  assert.deepEqual(quarantined?.result.toolCalls, []);
  const executions = events.filter(entry => entry.type === "command.scheduled" &&
    entry.command.kind === "execute_tool" && entry.command.payload.toolName === "ask_plan_questions");
  assert.deepEqual(executions.map(entry => entry.command.payload.toolCallId), [correctedCallId]);
  const pauses = events.filter(entry => entry.type === "run.paused");
  assert.equal(result.settlement.outcome.status, "paused");
  assert.equal(pauses.length, 1);
  assert.equal(pauses[0].blocker.questionnaire.title, title);
  assert.equal(pauses[0].blocker.questionnaire.questions[0].id, questions[0].id);
  assert.ok(pauses[0].sequence > executions[0].sequence);
  assert.equal(result.savedDocuments.length, 0);
  assert.equal(events.some(entry => entry.type === "work_plan.approved"), false);
});

test("production Plan runner seals the first valid evidence-grounded plan and pauses for review", async () => {
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
  let acceptedSubmissionRequest = null;
  const observedReadArgs = [];
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
      acceptedSubmissionRequest = messages;
      return {
        content: "",
        toolCalls: [{
          id: "submit-plan",
          name: "submit_runtime_v2_work_plan",
          arguments: JSON.stringify({
            planMarkdown: reviewedDraft.summary,
            changes: reviewedDraft.steps,
            validations: reviewedDraft.validations,
            questions: reviewedDraft.blockingQuestions,
          }),
        }],
        usage: {},
        protocolViolation: null,
      };
    },
    async (name, args) => {
      if (name === "get_project_skeleton") return "src/main.js";
      if (name === "read_file") {
        observedReadArgs.push({ ...args });
        return "const openFile = true;";
      }
      if (name === "write_file") {
        writtenPlan = String(args.content || "");
        return "written";
      }
      throw new Error(`unexpected tool ${name}`);
    },
  );
  assert.equal(providerRound, 2);
  assert.ok(observedReadArgs.some((args) =>
    args.__raw !== true &&
    args.max_chars === 18_000
  ));
  assert.ok(observedReadArgs.some((args) =>
    args.__raw === true &&
    args.max_chars === undefined
  ));
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
  writtenPlan = result.savedDocuments[0]?.markdown;
  assert.equal(writtenPlan, resolved.plan.markdown);
  assert.equal(resolved.commit.artifact.content, writtenPlan);
  assert.equal(resolved.commit.artifact.documentRef.contentHash, createHash("sha256").update(writtenPlan).digest("hex"));
  assert.equal(resolved.commit.artifact.path, result.state.activeActionRequest.documentRef.path);
  assert.ok(result.checkpoint.aggregate.events.some((event) =>
    event.type === "projection.published" &&
    event.audience === "capsule_live"
  ));
  const acceptedSubmissionText = acceptedSubmissionRequest
    .map((message) => String(message.content || ""))
    .join("\n");
  assert.doesNotMatch(acceptedSubmissionText, /WORK_PLAN_REJECTED/);
  assert.equal(result.logs.some(entry => entry.eventName === "runtime_v2_plan_submission_rejected"), false);
  assert.doesNotMatch(acceptedSubmissionText, /mandatory evidence audit/);
});

test("Plan discovery keeps read and submit tools available until the model submits", async () => {
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
      stepIndexes: [0],
    })),
  };
  let providerRound = 0;
  let synthesisRequest = null;
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
      synthesisRequest ||= { messages, tools, options };
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
              dependsOn: step.dependsOn,
              criterionIds: step.criterionIds,
            }))),
            validations: JSON.stringify(reviewedDraft.validations.map((validation) => ({
              kind: validation.kind,
              command: validation.command,
              cwd: validation.cwd,
              expectedOutcome: validation.expectedOutcome,
              required: validation.required,
              stepIndexes: validation.stepIndexes,
              criterionIds: validation.criterionIds,
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

  assert.equal(providerRound, 9);
  assert.equal(result.checkpoint.aggregate.phase, "reviewing");
  assert.deepEqual(
    synthesisRequest.tools.map((definition) => definition.function.name),
    ["read_file", "submit_runtime_v2_work_plan"],
  );
  const submitTool = synthesisRequest.tools.find((definition) =>
    definition.function.name === "submit_runtime_v2_work_plan"
  );
  assert.ok(submitTool);
  assert.deepEqual(
    submitTool.function.parameters.required,
    ["planMarkdown", "changes", "validations"],
  );
  assert.equal(
    submitTool.function.parameters.properties.findingsJson,
    undefined,
  );
  assert.equal(synthesisRequest.options.toolChoice, "required");
  assert.doesNotMatch(
    synthesisRequest.messages.map((message) => String(message.content || "")).join("\n"),
    /read-only discovery window is closed/,
  );
  assert.match(String(synthesisRequest.messages[0]?.content || ""), /MAIN RUNTIME V2 PLAN/);
  assert.equal(
    result.checkpoint.aggregate.evidence.filter((entry) =>
      entry.kind === "source" && entry.target === "src/main.js"
    ).length,
    1,
  );
  const synthesisText = synthesisRequest.messages
    .map((message) => String(message.content || ""))
    .join("\n");
  assert.doesNotMatch(
    synthesisText,
    /E2 · (?:\.\/|\/fixture\/)?src\/main\.js · sha256-/,
    "continued discovery must keep the canonical tool transcript instead of adding a synthesis evidence copy",
  );
  assert.match(
    synthesisText,
    /window-8/,
    "later windows of the same source version must remain available to synthesis",
  );
});

test("Plan synthesis falls back once from ignored native tools to a schema-bound response", async () => {
  let providerRound = 0;
  const synthesisRequests = [];
  const submission = {
    planMarkdown: "根因位于文件打开状态的所有权；修改保持现有工具边界。",
    changes: [{
      title: "统一标签生命周期",
      operation: "modify",
      targets: ["src/main.js"],
      change: "打开文件时替换仍为空白且未修改的初始标签。",
      expectedOutcome: "只显示当前文件标签。",
      dependsOn: [],
      criterionIds: ["criterion-user-objective"],
    }],
    validations: [{
      kind: "finite_command",
      command: "npm run build",
      cwd: "/fixture",
        expectedOutcome: "构建通过。",
        required: true,
        stepIndexes: [0],
        criterionIds: ["criterion-user-objective"],
      }],
  };
  const result = await runProductionPlanScenario(
    async (messages, _settings, _callbacks, _signal, tools, maxTokens, options) => {
      providerRound += 1;
      if (providerRound <= 8) {
        return {
          content: "",
          toolCalls: [{
            id: `read-before-fallback-${providerRound}`,
            name: "read_file",
            arguments: JSON.stringify({ path: "src/main.js" }),
          }],
          usage: {},
          protocolViolation: null,
        };
      }
      synthesisRequests.push({ messages, tools, maxTokens, options });
      if (providerRound === 9) {
        return {
          content: "I need to call submit_runtime_v2_work_plan, but I am still describing its parameters.",
          toolCalls: [],
          finishReason: "length",
          usage: {},
          protocolViolation: null,
        };
      }
      return {
        content: JSON.stringify(submission),
        toolCalls: [],
        finishReason: "stop",
        usage: {},
        protocolViolation: null,
      };
    },
    async (name) => {
      if (name === "get_project_skeleton") return "src/main.js";
      if (name === "read_file") return "const openFile = true;";
      if (name === "write_file") return "written";
      throw new Error(`unexpected tool ${name}`);
    },
  );

  assert.equal(providerRound, 11);
  assert.equal(result.settlement.outcome.status, "paused");
  assert.equal(result.checkpoint.aggregate.phase, "reviewing");
  assert.deepEqual(
    synthesisRequests[0].tools.map((tool) => tool.function.name),
    ["read_file", "submit_runtime_v2_work_plan"],
  );
  assert.equal(synthesisRequests[0].options.toolChoice, "required");
  assert.equal(synthesisRequests[1].maxTokens, 4_096);
  assert.deepEqual(
    synthesisRequests[1].tools.map((tool) => tool.function.name),
    ["read_file", "submit_runtime_v2_work_plan"],
  );
  assert.equal(synthesisRequests[1].options.toolChoice, "required");
  assert.equal(synthesisRequests[2].maxTokens, 4_096);
  assert.deepEqual(synthesisRequests[2].tools, []);
  assert.equal(synthesisRequests[2].options.toolChoice, undefined);
  assert.equal(synthesisRequests[2].options.responseFormat.type, "json_schema");
  assert.match(
    synthesisRequests[2].messages
      .map((message) => String(message.content || ""))
      .join("\n"),
    /Return exactly one JSON object/,
  );
  assert.equal(result.checkpoint.aggregate.recovery.transportAttempts, 0);
  assert.ok(result.checkpoint.aggregate.events.some((event) =>
    event.type === "soft_signal.observed" &&
    event.signal === "protocol_drift"
  ));
  assert.ok(result.checkpoint.aggregate.events.some((event) =>
    event.type === "provider.responded" &&
    event.result.diagnostics.some((diagnostic) =>
      diagnostic.code === "structured_response_adapted"
    )
  ));
});

test("Plan synthesis preserves an admitted output budget above 4096 tokens", async () => {
  const requests = [];
  const admittedOutputBudget = 8_192;
  const result = await runProductionPlanScenario(
    async (
      messages,
      _settings,
      _callbacks,
      _signal,
      tools,
      maxOutputTokens,
      requestOptions,
    ) => {
      requests.push({
        messages,
        toolNames: tools.map((tool) => tool.function.name),
        maxOutputTokens,
        requestOptions,
      });
      if (requests.length === 1) {
        return {
          content: "I have enough context and will now submit the structured WorkPlan.",
          toolCalls: [],
          usage: {},
          protocolViolation: null,
        };
      }
      return {
        content: "",
        toolCalls: [{
          id: "submit-with-admitted-output-budget",
          name: "submit_runtime_v2_work_plan",
          arguments: JSON.stringify({
            planMarkdown: "Create the bounded owner and validate the repository build.",
            changes: [{
              title: "Create the bounded owner",
              operation: "create",
              targets: ["src/output-budget-owner.js"],
              change: "Create the bounded owner behind the existing module boundary.",
              expectedOutcome: "The bounded owner exists.",
              dependsOn: [],
              criterionIds: ["criterion-user-objective"],
            }],
            validations: [{
              kind: "finite_command",
              command: "npm run build",
              cwd: "/fixture",
              expectedOutcome: "Build succeeds.",
              required: true,
              stepIndexes: [0],
              criterionIds: ["criterion-user-objective"],
            }],
          }),
        }],
        usage: {},
        protocolViolation: null,
      };
    },
    async (name) => {
      if (name === "get_project_skeleton") return "src/main.js";
      if (name === "write_file") return "written";
      throw new Error(`unexpected tool ${name}`);
    },
    {
      runtimeContextBudget: {
        contextLimit: 65_536,
        outputBudget: admittedOutputBudget,
        inputBudget: 57_344,
        readWindowChars: 32_000,
        source: "configured",
        providerContextLimit: 65_536,
        availableMemoryBytes: null,
      },
    },
  );

  assert.equal(requests.length, 2);
  assert.equal(result.settlement.outcome.status, "paused");
  assert.deepEqual(requests[1].toolNames, ["read_file", "submit_runtime_v2_work_plan"]);
  assert.equal(requests[1].requestOptions.toolChoice, "required");
  assert.equal(
    requests[1].maxOutputTokens,
    admittedOutputBudget,
    "synthesis must not replace the shared Run output budget with a fixed 4096-token cap",
  );
  const synthesisOpened = result.logs.find((entry) =>
    entry.eventName === "runtime_v2_plan_provider_request_opened" &&
    entry.data?.stage === "synthesis"
  );
  assert.equal(synthesisOpened?.data?.maxOutputTokens, admittedOutputBudget);
});

test("Plan uses the text envelope first when the adapter lacks native tool round-trip", async () => {
  const requests = [];
  const readArguments = [];
  const submission = {
    planMarkdown: "Use the evidence-backed owner and preserve the existing boundary.",
    changes: [{
      title: "Repair the owner",
      operation: "modify",
      targets: ["src/main.js"],
      change: "Update the reviewed lifecycle owner.",
      expectedOutcome: "The visible lifecycle remains coherent.",
      dependsOn: [],
      criterionIds: ["criterion-user-objective"],
    }],
    validations: [{
      kind: "finite_command",
      command: "npm run build",
      cwd: "/fixture",
      expectedOutcome: "Build succeeds.",
      required: true,
      stepIndexes: [0],
      criterionIds: ["criterion-user-objective"],
    }],
  };
  const envelope = (toolCalls) => toolCalls
    .map((call) => `<tool_call>${JSON.stringify(call)}</tool_call>`)
    .join("\n");
  let round = 0;
  const result = await runProductionPlanScenario(
    async (messages, _settings, _callbacks, _signal, tools, _maxTokens, requestOptions) => {
      round += 1;
      requests.push({ messages, tools, requestOptions });
      return round === 1
        ? {
            content: envelope([{
              id: "read-main",
              name: "read_file",
              arguments: { path: "src/main.js" },
            }, {
              id: "read-editor",
              name: "read_file",
              arguments: { path: "src/editor.js" },
            }, {
              id: "read-toolbar",
              name: "read_file",
              arguments: { path: "src/toolbar.js" },
            }]),
            toolCalls: [],
            finishReason: "stop",
            usage: {},
            protocolViolation: null,
          }
        : {
            content: envelope([{
              id: "submit-plan",
              name: "submit_runtime_v2_work_plan",
              arguments: submission,
            }]),
            toolCalls: [],
            finishReason: "stop",
            usage: {},
            protocolViolation: null,
          };
    },
    async (name, args) => {
      if (name === "get_project_skeleton") return "src/main.js";
      if (name === "read_file") {
        if (args.__raw !== true) readArguments.push(args);
        return "const owner = true;";
      }
      if (name === "write_file") return "written";
      throw new Error(`unexpected tool ${name}`);
    },
    { nativeToolRoundTrip: false },
  );

  assert.equal(result.settlement.outcome.status, "paused");
  assert.equal(requests.length, 2);
  for (const request of requests) {
    assert.deepEqual(request.tools, []);
    assert.equal(request.requestOptions.toolChoice, undefined);
    const prompt = request.messages
      .map((message) => String(message.content || ""))
      .join("\n");
    assert.match(prompt, /<tool_call>/);
    assert.match(prompt, /\[runtime-v2 allowed tool catalog\]/);
  }
  assert.match(
    requests[0].messages
      .map((message) => String(message.content || ""))
      .join("\n"),
    /read_file/,
  );
  assert.deepEqual(
    readArguments.map((args) => args.max_chars),
    [6_000, 6_000, 6_000],
    "one provider-selected read batch shares the Run window instead of multiplying it",
  );
});

test("schema-bound Plan response ingress never searches surrounding prose for JSON", () => {
  const submission = {
    planMarkdown: "Plan",
    changes: [{
      targets: ["src/main.js"],
      change: "Change it.",
      dependsOn: [],
    }],
    validations: [{
      kind: "assertion",
      expectedOutcome: "Works.",
      stepIndexes: [0],
    }],
  };
  assert.deepEqual(
    planProtocol.decodeExactStructuredPlanResponse(JSON.stringify(submission)),
    submission,
  );
  assert.deepEqual(
    planProtocol.decodeExactStructuredPlanResponse(
      `\`\`\`json\n${JSON.stringify(submission)}\n\`\`\``,
    ),
    submission,
  );
  assert.equal(
    planProtocol.decodeExactStructuredPlanResponse(
      `Here is the plan:\n${JSON.stringify(submission)}`,
    ),
    null,
  );
});

test("WorkPlan compilation downgrades non-finite commands without granting executable validation coverage", () => {
  const evidence = [{
    id: "E1",
    target: "src/main.js",
    version: "sha256-reviewed",
    statement: "Reviewed source.",
  }];
  const candidate = {
    planMarkdown: "Make the reviewed change and verify the observable behavior.",
    changes: [{
      operation: "modify",
      targets: ["src/main.js"],
      change: "Update the reviewed behavior.",
      expectedOutcome: "The behavior is corrected.",
      dependsOn: [],
    }],
    validations: [{
      kind: "finite_command",
      command: "npm run dev",
      expectedOutcome: "The development server starts.",
      required: true,
      stepIndexes: [0],
    }, {
      kind: "browser",
      expectedOutcome: "The corrected behavior is visible in the application.",
      required: true,
      stepIndexes: [0],
    }],
  };
  const compiled = planProtocol.workPlanDraftFromSubmission(
    candidate,
    evidence,
    "Repair the reviewed behavior.",
    ["criterion-user-objective"],
  );
  assert.deepEqual(
    compiled.draft.validations.map((validation) => validation.kind),
    ["advisory", "browser"],
  );
  assert.equal(compiled.draft.validations[0].required, false);
  assert.equal(compiled.draft.validations[0].command, undefined);
  assert.ok(compiled.normalizationReasons.includes(
    "validations[0]:non_finite_command_downgraded_to_advisory",
  ));
  assert.doesNotThrow(() => planSubmissionPolicy.assertAdmittedPlanCriteriaMapped({
    draft: compiled.draft, criterionIds: ["criterion-user-objective"],
  }));
  assert.doesNotThrow(() => runtime.sealWorkPlanV1({
    draft: compiled.draft,
    evidence,
    createdAt: 1,
  }));

  const withoutFallback = planProtocol.workPlanDraftFromSubmission(
    { ...candidate, validations: candidate.validations.slice(0, 1) },
    evidence,
    "Repair the reviewed behavior.",
    ["criterion-user-objective"],
  );
  // Core WorkPlan drafts can contain advisory-only recommendations. Production
  // admission separately requires executable validation for admitted criteria.
  assert.throws(
    () => planSubmissionPolicy.assertAdmittedPlanCriteriaMapped({
      draft: withoutFallback.draft,
      criterionIds: ["criterion-user-objective"],
    }),
    /advisory.*cannot provide required validation coverage/,
  );
});

test("cold-restored non-empty typed rejection saves its exact original candidate without another model request", async () => {
  const restored = planningCheckpointWithTypedSubmissionRejection();
  let requests = 0;
  const result = await withFakePlanClock(restored.rejectionAt + PLAN_RECOVERY_STALL_MS + 1, async () => runProductionPlanScenario(async () => {
    requests++;
    throw new Error("the complete rejected candidate is already durable and must not be regenerated");
  }, planFixtureTool, { initialCheckpoint: restored.checkpoint }));
  assert.equal(requests, 0);
  assert.equal(result.settlement.outcome.resultKind, "partial");
  assert.equal(result.savedDocuments.length, 1);
  assert.match(result.savedDocuments[0].markdown, /Create the cold-repair owner from the rejected typed candidate/);
  const record = loadTs(path.join(workspaceRoot, "src/lib/planDocumentRecords.ts")).resolvePlanDraftFromAggregate(result.checkpoint.aggregate);
  assert.ok(record);
  assert.equal(record.source.toolCallId, restored.toolCallId);
  assert.equal(record.source.candidateHash, hashPlanDraftCandidate(restored.candidate));
  assert.equal(result.checkpoint.aggregate.events.filter(event => event.type === "run.completed").length, 1);
  assert.equal(result.checkpoint.aggregate.events.filter(event => event.type === "turn.completed").length, 1);
  assert.equal(result.checkpoint.aggregate.sealedWorkPlan, null);
});

test("cold-restored legacy empty-body rejection retains safe reads beyond the soft stall window", async () => {
  const restored = planningCheckpointWithTypedSubmissionRejection({ emptyBody: true });
  const corrected = structuredClone(restored.candidate);
  corrected.planMarkdown = "Create the bounded owner using the retained source contract, then verify the build.";
  corrected.validations[0].stepIndexes = [0];
  for (const elapsed of [1_000, PLAN_RECOVERY_STALL_MS + 1]) {
    const requests = [];
    const result = await withFakePlanClock(restored.rejectionAt + elapsed, async () => runProductionPlanScenario(
      async (messages, _settings, _callbacks, _signal, tools, _maxTokens, requestOptions) => {
        requests.push({ messages, toolNames: tools.map(tool => tool.function.name), requestOptions });
        return planProviderReply("cold-corrected-work-plan", "submit_runtime_v2_work_plan", corrected);
      }, planFixtureTool, { initialCheckpoint: restored.checkpoint }));
    assert.equal(requests.length, 1, "elapsed soft recovery time does not close a safe legacy repair");
    assert.deepEqual(requests[0].toolNames, ["read_file", "submit_runtime_v2_work_plan"]);
    assert.equal(requests[0].requestOptions.toolChoice, "required");
    assert.match(requests[0].messages.map(message => String(message.content || "")).join("\n"), /WORK_PLAN_REJECTED:/);
    assert.match(requests[0].messages.map(message => String(message.content || "")).join("\n"), /non-empty planMarkdown body/);
    assert.equal(result.settlement.outcome.status, "paused");
    assert.equal(result.checkpoint.aggregate.phase, "reviewing");
    assert.deepEqual(result.checkpoint.aggregate.sealedWorkPlan.draft.validations[0].stepIndexes, [0]);
    assert.equal(result.checkpoint.aggregate.events.filter(event => event.type === "run.started").length, 1);
    assert.equal(result.checkpoint.aggregate.events.some(event => event.type === "run.completed"), false);
    assert.equal(result.logs.some(entry => entry.data?.detailCode === "runtime_v2_plan_recovery_stall_exhausted"), false);
  }
});

test("the first non-empty Plan with an invalid validation step saves partial without requesting semantic repair", async () => {
  const candidate = simplePlanSubmission("src/bounded-owner.js");
  candidate.validations[0].stepIndexes = [1];
  let requests = 0;
  const result = await runProductionPlanScenario(async () => {
    assert.equal(++requests, 1, "structural readiness gaps preserve the candidate instead of regenerating it");
    return planProviderReply("invalid-validation-step", "submit_runtime_v2_work_plan", candidate);
  }, planFixtureTool, { reasoningToggle: true });
  assert.equal(requests, 1);
  assert.equal(result.settlement.outcome.resultKind, "partial");
  assert.equal(result.savedDocuments.length, 1);
  assert.equal(result.checkpoint.aggregate.sealedWorkPlan, null);
  const draft = loadTs(path.join(workspaceRoot, "src/lib/planDocumentRecords.ts")).resolvePlanDraftFromAggregate(result.checkpoint.aggregate);
  assert.ok(draft);
  assert.equal(draft.source.candidateHash, hashPlanDraftCandidate(candidate));
  assert.equal(draft.source.toolCallId, "invalid-validation-step");
  assert.ok(draft.diagnostics.some(diagnostic => diagnostic.fieldPath.includes("validations")));
  assert.equal(result.checkpoint.aggregate.events.filter(event => event.type === "run.completed").length, 1);
  assert.equal(result.checkpoint.aggregate.events.filter(event => event.type === "turn.completed").length, 1);
  assert.equal(result.checkpoint.aggregate.events.some(event => event.type === "work_plan.sealed" || event.type === "work_plan.approved"), false);
});

test("repeated Plan repair argument violations retain safe tools and accept exact JSON", async () => {
  const requests = [];
  const validSubmission = {
    planMarkdown: "Create the bounded repair owner and verify the repository build.",
    changes: [{
      title: "Create the bounded repair owner",
      operation: "create",
      targets: ["src/repeated-repair-owner.js"],
      change: "Create the bounded owner behind the existing module boundary.",
      expectedOutcome: "The bounded repair owner exists.",
      dependsOn: [],
      criterionIds: ["criterion-user-objective"],
    }],
    validations: [{
      kind: "finite_command",
      command: "npm run build",
      cwd: "/fixture",
      expectedOutcome: "The repository build succeeds.",
      required: true,
      stepIndexes: [0],
      criterionIds: ["criterion-user-objective"],
    }],
  };
  const typedRejectedSubmission = structuredClone(validSubmission);
  typedRejectedSubmission.planMarkdown = "";
  const argumentRejectedSubmission = structuredClone(validSubmission);
  argumentRejectedSubmission.planMarkdown = ""; // No complete document exists: strict protocol/schema repair still applies.
  delete argumentRejectedSubmission.changes[0].change;

  const result = await runProductionPlanScenario(
    async (
      messages,
      settings,
      _callbacks,
      _signal,
      tools,
      maxOutputTokens,
      requestOptions,
    ) => {
      requests.push({
        transcript: messages
          .map((message) => String(message.content || ""))
          .join("\n"),
        settings,
        toolNames: tools.map((tool) => tool.function.name),
        maxOutputTokens,
        requestOptions,
      });
      if (requests.length === 1) {
        return {
          content: "",
          toolCalls: [{
            id: "typed-rejected-before-repeated-arguments",
            name: "submit_runtime_v2_work_plan",
            arguments: JSON.stringify(typedRejectedSubmission),
          }],
          usage: {},
          protocolViolation: null,
        };
      }
      if (requests.length === 2 || requests.length === 3) {
        return {
          content: "",
          toolCalls: [{
            id: `repeat-invalid-submit-arguments-${requests.length - 1}`,
            name: "submit_runtime_v2_work_plan",
            arguments: JSON.stringify(argumentRejectedSubmission),
          }],
          usage: {},
          protocolViolation: null,
        };
      }
      return {
        content: JSON.stringify(validSubmission),
        toolCalls: [],
        usage: {},
        protocolViolation: null,
      };
    },
    async (name) => {
      if (name === "get_project_skeleton") return "src/main.js";
      if (name === "write_file") return "written";
      throw new Error(`unexpected tool ${name}`);
    },
    { reasoningToggle: true },
  );

  assert.deepEqual(requests[1].toolNames, [
    "read_file",
    "submit_runtime_v2_work_plan",
  ]);
  assert.deepEqual(requests[2].toolNames, [
    "read_file",
    "submit_runtime_v2_work_plan",
  ]);
  assert.equal(requests[1].requestOptions.toolChoice, "required");
  assert.match(requests[2].transcript, /PLAN_TOOL_ARGUMENTS_REJECTED/);

  const compactRecovery = requests[3];
  assert.ok(compactRecovery, "the repeated violation must open one recovery request");
  assert.deepEqual(
    compactRecovery.toolNames,
    ["read_file", "submit_runtime_v2_work_plan"],
    "typed repair keeps reads available even after repeated argument errors",
  );
  assert.equal(compactRecovery.requestOptions.toolChoice, "required");
  assert.equal(
    compactRecovery.requestOptions.responseFormat,
    undefined,
  );
  assert.equal(
    compactRecovery.maxOutputTokens,
    planProtocol.PLAN_SYNTHESIS_RECOVERY_MAX_TOKENS,
  );
  assert.equal(compactRecovery.settings.reasoningRequest, "off");
  assert.equal(compactRecovery.settings.preserveAssistantReasoning, false);
  assert.match(compactRecovery.transcript, /WORK_PLAN_REJECTED/);
  assert.match(compactRecovery.transcript, /PLAN_TOOL_ARGUMENTS_REJECTED/);
  assert.equal(
    requests.length,
    4,
    "exact JSON remains compatible without closing the safe tool surface",
  );
  assert.equal(result.settlement.outcome.status, "paused");
  assert.equal(result.checkpoint.aggregate.phase, "reviewing");

  const argumentRejections = result.checkpoint.aggregate.events.filter(
    (event) =>
      event.type === "provider.responded" &&
      event.result.diagnostics.some((diagnostic) =>
        diagnostic.code === "tool_arguments_rejected"
      ),
  );
  assert.equal(argumentRejections.length, 2);
  const compactOpened = result.logs.find((entry) =>
    entry.eventName === "runtime_v2_plan_provider_request_opened" &&
    entry.data?.compactRecovery === true
  );
  assert.ok(compactOpened);
  assert.equal(compactOpened.data?.submissionRepairPending, true);
  assert.equal(compactOpened.data?.transport, "native_tool");
  assert.equal(compactOpened.data?.repairReasoningDisabled, true);
});

test("cold Plan restore preserves repeated repair violations without closing safe tools", async () => {
  const restored = planningCheckpointWithRepeatedSubmitOnlyArgumentViolations();
  const correctedSubmission = structuredClone(restored.candidate);
  correctedSubmission.planMarkdown = "Create the bounded owner using the retained source contract, then verify the build.";
  correctedSubmission.validations[0].stepIndexes = [0];
  const originalNow = Date.now;
  const requests = [];
  let result;

  Date.now = () => restored.restoredAt;
  try {
    result = await runProductionPlanScenario(
      async (
        messages,
        settings,
        _callbacks,
        _signal,
        tools,
        maxOutputTokens,
        requestOptions,
      ) => {
        requests.push({
          transcript: messages
            .map((message) => String(message.content || ""))
            .join("\n"),
          settings,
          toolNames: tools.map((tool) => tool.function.name),
          maxOutputTokens,
          requestOptions,
        });
        if (requestOptions.responseFormat?.type === "json_schema") {
          return {
            content: JSON.stringify(correctedSubmission),
            toolCalls: [],
            usage: {},
            protocolViolation: null,
          };
        }
        return {
          content: "",
          toolCalls: [{
            id: "cold-native-retry-must-not-be-granted",
            name: "submit_runtime_v2_work_plan",
            arguments: JSON.stringify(correctedSubmission),
          }],
          usage: {},
          protocolViolation: null,
        };
      },
      async (name) => {
        if (name === "get_project_skeleton") return "src/main.js";
        if (name === "write_file") return "written";
        throw new Error(`unexpected tool ${name}`);
      },
      {
        initialCheckpoint: restored.checkpoint,
        reasoningToggle: true,
      },
    );
  } finally {
    Date.now = originalNow;
  }

  assert.equal(requests.length, 1);
  assert.deepEqual(
    requests[0].toolNames,
    ["read_file", "submit_runtime_v2_work_plan"],
    "old submit-only recovery state cannot revoke safe reads after restore",
  );
  assert.equal(requests[0].requestOptions.toolChoice, "required");
  assert.equal(requests[0].requestOptions.responseFormat, undefined);
  assert.equal(
    requests[0].maxOutputTokens,
    planProtocol.PLAN_SYNTHESIS_RECOVERY_MAX_TOKENS,
  );
  assert.equal(requests[0].settings.reasoningRequest, "off");
  assert.equal(requests[0].settings.preserveAssistantReasoning, false);
  assert.match(requests[0].transcript, /WORK_PLAN_REJECTED/);
  assert.equal(result.settlement.outcome.status, "paused");
  assert.equal(result.checkpoint.aggregate.phase, "reviewing");
  const opened = result.logs.find((entry) =>
    entry.eventName === "runtime_v2_plan_provider_request_opened"
  );
  assert.equal(opened?.data?.stage, "synthesis");
  assert.equal(opened?.data?.submissionRepairPending, true);
  assert.equal(opened?.data?.compactRecovery, true);
  assert.equal(opened?.data?.transport, "native_tool");
});

function withExplicitPlanDeadline(checkpoint, deadlineAt) {
  let replayed = null;
  for (const value of checkpoint.events) {
    const entry = value.type === "run.started" ? { ...value, lifecycleDeadlineAt: deadlineAt } : value;
    const result = runtime.appendRuntimeV2Checkpoint({ checkpoint: replayed, owner: turn, expectedRevision: replayed?.revision || 0, event: entry });
    assert.equal(result.disposition, "committed");
    replayed = result.checkpoint;
  }
  return replayed;
}

test("invalid Plan repair JSON remains recoverable past soft stall and ends only at an explicit caller deadline", async () => {
  const restored = planningCheckpointWithRepeatedSubmitOnlyArgumentViolations();
  const deadlineAt = restored.rejectionAt + PLAN_RECOVERY_STALL_MS + 5_000;
  const boundedCheckpoint = withExplicitPlanDeadline(restored.checkpoint, deadlineAt);
  const originalNow = Date.now;
  let now = restored.restoredAt;
  const requests = [];
  let result;

  Date.now = () => now;
  try {
    result = await runProductionPlanScenario(
      async (
        messages,
        settings,
        _callbacks,
        _signal,
        tools,
        maxOutputTokens,
        requestOptions,
      ) => {
        requests.push({
          transcript: messages
            .map((message) => String(message.content || ""))
            .join("\n"),
          settings,
          toolNames: tools.map((tool) => tool.function.name),
          maxOutputTokens,
          requestOptions,
        });
        if (requests.length === 2) now = restored.rejectionAt + PLAN_RECOVERY_STALL_MS + 1;
        if (requests.length === 3) now = deadlineAt + 1;
        assert.ok(requests.length <= 3, "only the explicit caller deadline may close this protocol recovery");
        return {
          content: "{}",
          toolCalls: [],
          usage: {},
          protocolViolation: null,
        };
      },
      async (name) => {
        if (name === "get_project_skeleton") return "src/main.js";
        throw new Error(`unexpected tool ${name}`);
      },
      {
        initialCheckpoint: boundedCheckpoint,
        reasoningToggle: true,
      },
    );
  } finally {
    Date.now = originalNow;
  }

  assert.deepEqual(
    requests[0]?.toolNames,
    ["read_file", "submit_runtime_v2_work_plan"],
    "typed repair remains open to source evidence while malformed JSON recovers",
  );
  assert.equal(requests[0]?.requestOptions.responseFormat, undefined);
  assert.equal(requests[0]?.settings.reasoningRequest, "off");
  assert.equal(
    requests.length,
    3,
    "invalid output still permits recovery after soft stall until the explicit caller deadline",
  );
  assert.equal(result.settlement.outcome.status, "completed");
  assert.equal(result.settlement.outcome.resultKind, "error");
  assert.equal(result.checkpoint.aggregate.terminalOutcome?.resultKind, "error");
  assert.equal(result.checkpoint.aggregate.sealedWorkPlan, null);
  assert.equal(result.savedDocuments.length, 0, "malformed protocol output never creates an empty draft");
  assert.deepEqual(result.checkpoint.aggregate.scheduledCommands, []);
  assert.equal(
    result.checkpoint.aggregate.events.filter((entry) =>
      entry.type === "command.scheduled" &&
      entry.command.kind === "request_model"
    ).length,
    6,
    "the original request, two historical repair requests and three new attempts are all retained",
  );
  const terminal = result.logs.find((entry) =>
    entry.eventName === "runtime_v2_plan_terminal"
  );
  assert.equal(
    terminal?.data?.detailCode,
    "runtime_v2_plan_deadline_reached",
  );
});

test("active Plan streams outlive ten minutes while explicit caller deadlines remain binding", async () => {
  const originalNow = Date.now;
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  let now = 2_000_000;
  let nextTimerId = 0;
  const timers = new Map();
  const scheduledTimeouts = [];
  const runDueTimers = () => {
    for (let pass = 0; pass < 10; pass += 1) {
      const due = [...timers.entries()].filter(([, timer]) =>
        timer.dueAt <= now
      );
      if (due.length === 0) return;
      for (const [handle, timer] of due) {
        timers.delete(handle);
        timer.callback(...timer.args);
      }
    }
    throw new Error("fake Plan timers did not converge");
  };
  let abortCtrl = null;
  const diagnosticAborts = [];
  let providerCalls = 0;
  let signalAbortedAfterActiveDeadline = null;
  let requestWallClockMs = 0;
  let activeResult;
  let durableResult;
  let durableProviderCalls = 0;
  let durableSignalAborted = null;

  Date.now = () => now;
  globalThis.setTimeout = (callback, delay = 0, ...args) => {
    const handle = { fakePlanTimerId: ++nextTimerId };
    scheduledTimeouts.push(Number(delay));
    timers.set(handle, {
      callback,
      args,
      dueAt: now + Math.max(0, Number(delay) || 0),
    });
    return handle;
  };
  globalThis.clearTimeout = (handle) => {
    timers.delete(handle);
  };
  try {
    activeResult = await runProductionPlanScenario(
      async (
        _messages,
        _settings,
        callbacks,
        signal,
        _tools,
        _maxOutputTokens,
        _requestOptions,
      ) => {
        providerCalls += 1;
        if (providerCalls > 1) {
          abortCtrl.abort("active Plan stream was killed by the fixed request watchdog");
          return {
            content: "",
            toolCalls: [],
            usage: {},
            protocolViolation: null,
          };
        }
        const requestStartedAt = now;
        for (const [elapsedMs, phase, token] of Array.from({ length: 11 }, (_, i) => [(i + 1) * 60_000, i === 0 ? "first_chunk" : "chunk_progress", "ongoing model output"])) {
          now = requestStartedAt + elapsedMs;
          runDueTimers();
          callbacks.onLifecycle?.({ phase });
          callbacks.onToken?.(token);
        }
        now = requestStartedAt + 11 * 60_000 + 1;
        runDueTimers();
        await Promise.resolve();
        requestWallClockMs = now - requestStartedAt;
        signalAbortedAfterActiveDeadline = signal.aborted;
        return {
          content: "",
          toolCalls: [{
            id: "submit-after-active-stream-progress",
            name: "submit_runtime_v2_work_plan",
            arguments: JSON.stringify({
              planMarkdown: "Create the active-stream fixture and verify the build.",
              changes: [{
                title: "Create the active-stream fixture",
                operation: "create",
                targets: ["src/active-stream-fixture.js"],
                change: "Create the bounded fixture behind the existing module boundary.",
                expectedOutcome: "The active-stream fixture exists.",
                dependsOn: [],
                criterionIds: ["criterion-user-objective"],
              }],
              validations: [{
                kind: "finite_command",
                command: "npm run build",
                cwd: "/fixture",
                expectedOutcome: "Build succeeds.",
                required: true,
                stepIndexes: [0],
                criterionIds: ["criterion-user-objective"],
              }],
            }),
          }],
          usage: {},
          protocolViolation: null,
        };
      },
      async (name) => {
        if (name === "get_project_skeleton") return "src/main.js";
        if (name === "write_file") return "written";
        throw new Error(`unexpected tool ${name}`);
      },
      {
        onAbortCtrl: (controller) => {
          abortCtrl = controller;
          diagnosticAborts.push(originalSetTimeout(
            () => controller.abort("active Plan stream test timeout"),
            2_000,
          ));
        },
      },
    );

    const explicitDeadline = now + EXPLICIT_PLAN_TEST_BUDGET_MS;
    durableResult = await runProductionPlanScenario(
      async (
        _messages,
        _settings,
        callbacks,
        signal,
      ) => {
        durableProviderCalls += 1;
        const requestStartedAt = now;
        for (let elapsedMs = 60_000; elapsedMs < EXPLICIT_PLAN_TEST_BUDGET_MS;
          elapsedMs += 60_000) {
          now = requestStartedAt + elapsedMs;
          runDueTimers();
          callbacks.onLifecycle?.({
            phase: elapsedMs === 60_000 ? "first_chunk" : "chunk_progress",
          });
          callbacks.onToken?.("still producing a bounded Plan response");
        }
        now = requestStartedAt + EXPLICIT_PLAN_TEST_BUDGET_MS + 1;
        runDueTimers();
        await Promise.resolve();
        durableSignalAborted = signal.aborted;
        return {
          content: "",
          toolCalls: [],
          usage: {},
          protocolViolation: null,
        };
      },
      async (name) => {
        if (name === "get_project_skeleton") return "src/main.js";
        throw new Error(`unexpected tool ${name}`);
      },
      {
        lifecycleDeadlineAt: explicitDeadline,
        onAbortCtrl: (controller) => {
          diagnosticAborts.push(originalSetTimeout(
            () => controller.abort("durable Plan deadline test timeout"),
            2_000,
          ));
        },
      },
    );
  } finally {
    Date.now = originalNow;
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
    for (const handle of diagnosticAborts) originalClearTimeout(handle);
  }

  assert.ok(requestWallClockMs > 3 * planProtocol.PLAN_MODEL_REQUEST_TIMEOUT_MS);
  assert.ok(scheduledTimeouts.includes(planProtocol.PLAN_MODEL_REQUEST_TIMEOUT_MS));
  assert.deepEqual(
    {
      providerCalls,
      signalAbortedAfterActiveDeadline,
      outcomeStatus: activeResult.settlement.outcome.status,
      phase: activeResult.checkpoint.aggregate.phase,
    },
    {
      providerCalls: 1,
      signalAbortedAfterActiveDeadline: false,
      outcomeStatus: "paused",
      phase: "reviewing",
    },
    "recent stream lifecycle/token progress must renew the request watchdog",
  );
  assert.equal(
    activeResult.logs.some((entry) =>
      entry.eventName === "runtime_v2_plan_provider_request_closed" &&
      entry.data?.timedOut === true
    ),
    false,
  );
  assert.equal(
    activeResult.checkpoint.aggregate.events.filter((entry) =>
      entry.type === "work_plan.sealed"
    ).length,
    1,
  );

  assert.equal(durableProviderCalls, 1);
  assert.equal(durableSignalAborted, true);
  assert.equal(durableResult.settlement.outcome.status, "completed");
  assert.equal(durableResult.checkpoint.aggregate.sealedWorkPlan, null);
  assert.equal(
    durableResult.logs.some((entry) =>
      entry.eventName === "runtime_v2_plan_provider_request_closed" &&
      entry.data?.timedOut === false && entry.data?.lifecycleTimedOut === true
    ),
    true,
  );
  const durableTerminal = durableResult.logs.find((entry) =>
    entry.eventName === "runtime_v2_plan_terminal"
  );
  assert.equal(
    durableTerminal?.data?.detailCode,
    "runtime_v2_plan_deadline_reached",
  );
});

test("Plan lane queue has no default timer and honors only explicit caller deadlines", async () => {
  const submission = {
    planMarkdown: "Create the queued-lane fixture and verify the repository build.",
    changes: [{
      title: "Create the queued-lane fixture",
      operation: "create",
      targets: ["src/queued-lane-fixture.js"],
      change: "Create one bounded fixture behind the existing module boundary.",
      expectedOutcome: "The queued-lane fixture exists.",
      dependsOn: [],
      criterionIds: ["criterion-user-objective"],
    }],
    validations: [{
      kind: "finite_command",
      command: "npm run build",
      cwd: "/fixture",
      expectedOutcome: "Build succeeds.",
      required: true,
      stepIndexes: [0],
      criterionIds: ["criterion-user-objective"],
    }],
  };

  const queued = await withFakePlanClock(3_000_000, async (clock) => {
    let laneRequestedAt = null;
    let laneAdmittedAt = null;
    let streamStartedAt = null;
    let streamSignalAborted = null;
    let providerCalls = 0;
    const result = await runProductionPlanScenario(
      async (
        _messages,
        _settings,
        _callbacks,
        signal,
      ) => {
        providerCalls += 1;
        streamStartedAt = clock.now;
        streamSignalAborted = signal.aborted;
        return {
          content: "",
          toolCalls: [{
            id: "submit-after-queued-lane",
            name: "submit_runtime_v2_work_plan",
            arguments: JSON.stringify(submission),
          }],
          usage: {},
          protocolViolation: null,
        };
      },
      async (name) => {
        if (name === "get_project_skeleton") return "src/main.js";
        if (name === "write_file") return "written";
        throw new Error(`unexpected tool ${name}`);
      },
      {
        acquireModelLane: async ({ signal }) => {
          laneRequestedAt = clock.now;
          assert.equal(
            clock.timerArms.some((entry) =>
              entry.delayMs === planProtocol.PLAN_MODEL_REQUEST_TIMEOUT_MS
            ),
            false,
            "the provider inactivity lease must not start while the model lane is queued",
          );
          await clock.advanceBy(
            planProtocol.PLAN_MODEL_REQUEST_TIMEOUT_MS + 30_000,
          );
          assert.equal(signal.aborted, false);
          laneAdmittedAt = clock.now;
          return testModelLaneLease();
        },
      },
    );
    return {
      result,
      providerCalls,
      laneRequestedAt,
      laneAdmittedAt,
      streamStartedAt,
      streamSignalAborted,
      timerArms: [...clock.timerArms],
    };
  });

  assert.ok(
    queued.laneAdmittedAt - queued.laneRequestedAt >
      planProtocol.PLAN_MODEL_REQUEST_TIMEOUT_MS,
  );
  assert.equal(queued.streamStartedAt, queued.laneAdmittedAt);
  assert.equal(queued.streamSignalAborted, false);
  assert.equal(queued.providerCalls, 1);
  assert.equal(queued.result.settlement.outcome.status, "paused");
  assert.equal(queued.result.checkpoint.aggregate.phase, "reviewing");
  assert.equal(
    queued.result.logs.some((entry) =>
      entry.eventName === "runtime_v2_plan_provider_request_closed" &&
      entry.data?.timedOut === true
    ),
    false,
  );
  const queuedInactivityArm = queued.timerArms.find((entry) =>
    entry.delayMs === planProtocol.PLAN_MODEL_REQUEST_TIMEOUT_MS
  );
  assert.equal(
    queuedInactivityArm?.armedAt,
    queued.laneAdmittedAt,
    "the 90s inactivity lease starts only after lane admission",
  );
  assert.equal(
    queued.timerArms.some((entry) =>
      entry.armedAt === queued.laneRequestedAt &&
      entry.delayMs > planProtocol.PLAN_MODEL_REQUEST_TIMEOUT_MS
    ),
    false,
    "ordinary Plan queue time has no default total-duration timer",
  );

  const deadlineBound = await withFakePlanClock(4_000_000, async (clock) => {
    let streamCalls = 0;
    let queuedSignalAborted = null;
    const result = await runProductionPlanScenario(
      async () => {
        streamCalls += 1;
        throw new Error("stream must not open after the durable Plan deadline");
      },
      async (name) => {
        if (name === "get_project_skeleton") return "src/main.js";
        throw new Error(`unexpected tool ${name}`);
      },
      {
        lifecycleDeadlineAt: clock.now + EXPLICIT_PLAN_TEST_BUDGET_MS,
        acquireModelLane: async ({ signal }) => {
          await clock.advanceBy(EXPLICIT_PLAN_TEST_BUDGET_MS + 1);
          queuedSignalAborted = signal.aborted;
          return testModelLaneLease();
        },
      },
    );
    return {
      result,
      streamCalls,
      queuedSignalAborted,
      timerArms: [...clock.timerArms],
    };
  });
  assert.equal(deadlineBound.streamCalls, 0);
  assert.equal(deadlineBound.queuedSignalAborted, true);
  assert.equal(
    deadlineBound.timerArms.some((entry) =>
      entry.delayMs === planProtocol.PLAN_MODEL_REQUEST_TIMEOUT_MS
    ),
    false,
    "lane wait must not arm a provider inactivity timer even when lifecycle expires",
  );
  assert.equal(deadlineBound.result.settlement.outcome.status, "completed");
  assert.equal(deadlineBound.result.checkpoint.aggregate.sealedWorkPlan, null);
  assert.equal(
    deadlineBound.result.logs.find((entry) =>
      entry.eventName === "runtime_v2_plan_terminal"
    )?.data?.detailCode,
    "runtime_v2_plan_deadline_reached",
  );
});

test("Plan provider inactivity lease still times out 90s without a chunk after lane admission", async () => {
  const submission = {
    planMarkdown: "Recover from the stalled stream with a bounded structured Plan.",
    changes: [{
      title: "Create the post-stall fixture",
      operation: "create",
      targets: ["src/post-stall-fixture.js"],
      change: "Create one bounded fixture behind the existing module boundary.",
      expectedOutcome: "The post-stall fixture exists.",
      dependsOn: [],
      criterionIds: ["criterion-user-objective"],
    }],
    validations: [{
      kind: "finite_command",
      command: "npm run build",
      cwd: "/fixture",
      expectedOutcome: "Build succeeds.",
      required: true,
      stepIndexes: [0],
      criterionIds: ["criterion-user-objective"],
    }],
  };
  const observed = await withFakePlanClock(5_000_000, async (clock) => {
    let providerCalls = 0;
    let firstLaneAdmittedAt = null;
    let firstStreamStartedAt = null;
    let firstSignalAborted = null;
    const result = await runProductionPlanScenario(
      async (
        _messages,
        _settings,
        _callbacks,
        signal,
      ) => {
        providerCalls += 1;
        if (providerCalls === 1) {
          firstStreamStartedAt = clock.now;
          await clock.advanceBy(
            planProtocol.PLAN_MODEL_REQUEST_TIMEOUT_MS + 1,
          );
          firstSignalAborted = signal.aborted;
          return {
            content: "",
            toolCalls: [],
            usage: {},
            protocolViolation: null,
          };
        }
        return {
          content: JSON.stringify(submission),
          toolCalls: [],
          usage: {},
          protocolViolation: null,
        };
      },
      async (name) => {
        if (name === "get_project_skeleton") return "src/main.js";
        if (name === "write_file") return "written";
        throw new Error(`unexpected tool ${name}`);
      },
      {
        acquireModelLane: async () => {
          if (firstLaneAdmittedAt === null) firstLaneAdmittedAt = clock.now;
          return testModelLaneLease();
        },
      },
    );
    return {
      result,
      providerCalls,
      firstLaneAdmittedAt,
      firstStreamStartedAt,
      firstSignalAborted,
      timerArms: [...clock.timerArms],
    };
  });

  assert.equal(observed.firstStreamStartedAt, observed.firstLaneAdmittedAt);
  assert.equal(observed.firstSignalAborted, true);
  assert.equal(observed.providerCalls, 2);
  const firstInactivityArm = observed.timerArms.find((entry) =>
    entry.delayMs === planProtocol.PLAN_MODEL_REQUEST_TIMEOUT_MS
  );
  assert.equal(firstInactivityArm?.armedAt, observed.firstLaneAdmittedAt);
  const timedOutRequest = observed.result.logs.find((entry) =>
    entry.eventName === "runtime_v2_plan_provider_request_closed" &&
    entry.data?.timedOut === true
  );
  assert.ok(timedOutRequest);
  assert.equal(timedOutRequest.data?.stage, "discovery");
  assert.equal(
    timedOutRequest.data?.timeoutMs,
    planProtocol.PLAN_MODEL_REQUEST_TIMEOUT_MS,
  );
  assert.equal(observed.result.settlement.outcome.status, "paused");
  assert.equal(observed.result.checkpoint.aggregate.phase, "reviewing");
  assert.equal(
    observed.result.checkpoint.aggregate.events.filter((entry) =>
      entry.type === "work_plan.sealed"
    ).length,
    1,
  );
});

test("compact Plan synthesis recovery couples its 90s deadline to bounded output and reasoning off", async () => {
  const requests = [];
  const runtimeOutputBudget = 32_768;
  const submission = {
    planMarkdown: "Create the bounded recovery fixture and verify the repository build.",
    changes: [{
      title: "Create the recovery fixture",
      operation: "create",
      targets: ["src/compact-recovery-fixture.js"],
      change: "Create one bounded fixture behind the existing module boundary.",
      expectedOutcome: "The recovery fixture exists.",
      dependsOn: [],
      criterionIds: ["criterion-user-objective"],
    }],
    validations: [{
      kind: "finite_command",
      command: "npm run build",
      cwd: "/fixture",
      expectedOutcome: "Build succeeds.",
      required: true,
      stepIndexes: [0],
      criterionIds: ["criterion-user-objective"],
    }],
  };
  const result = await runProductionPlanScenario(
    async (
      messages,
      settings,
      _callbacks,
      _signal,
      tools,
      maxOutputTokens,
      requestOptions,
    ) => {
      requests.push({
        messages,
        settings,
        toolNames: tools.map((tool) => tool.function.name),
        maxOutputTokens,
        requestOptions,
      });
      if (requests.length === 1) {
        throw new Error("ECONNRESET: discovery transport closed before an action");
      }
      return {
        content: JSON.stringify(submission),
        toolCalls: [],
        usage: {},
        protocolViolation: null,
      };
    },
    async (name) => {
      if (name === "get_project_skeleton") return "src/main.js";
      if (name === "write_file") return "written";
      throw new Error(`unexpected tool ${name}`);
    },
    {
      reasoningToggle: true,
      runtimeContextBudget: {
        contextLimit: 65_536,
        outputBudget: runtimeOutputBudget,
        inputBudget: 32_768,
        readWindowChars: 32_000,
        source: "configured",
        providerContextLimit: 65_536,
        availableMemoryBytes: null,
      },
    },
  );

  assert.equal(requests.length, 2);
  assert.equal(result.settlement.outcome.status, "paused");
  assert.equal(result.checkpoint.aggregate.phase, "reviewing");
  const recovery = requests[1];
  assert.deepEqual(recovery.toolNames, []);
  assert.equal(recovery.requestOptions.toolChoice, undefined);
  assert.equal(recovery.requestOptions.responseFormat?.type, "json_schema");
  assert.deepEqual(
    {
      maxOutputTokens: recovery.maxOutputTokens,
      reasoningRequest: recovery.settings.reasoningRequest ?? null,
      preserveAssistantReasoning:
        recovery.settings.preserveAssistantReasoning ?? null,
      timeoutMs: recovery.requestOptions.timeoutMs,
    },
    {
      maxOutputTokens: planProtocol.PLAN_SYNTHESIS_RECOVERY_MAX_TOKENS,
      reasoningRequest: "off",
      preserveAssistantReasoning: false,
      timeoutMs: planProtocol.PLAN_SYNTHESIS_RECOVERY_REQUEST_TIMEOUT_MS,
    },
    "a fixed 90s recovery request cannot retain both the 32768-token budget and provider reasoning",
  );
  const opened = result.logs.find((entry) =>
    entry.eventName === "runtime_v2_plan_provider_request_opened" &&
    entry.data?.compactRecovery === true
  );
  assert.ok(opened);
  assert.equal(opened.data?.stage, "synthesis");
  assert.equal(opened.data?.requestedTransport, "structured_response");
  assert.equal(opened.data?.transport, "structured_response");
  assert.equal(opened.data?.maxOutputTokens,
    planProtocol.PLAN_SYNTHESIS_RECOVERY_MAX_TOKENS);
  assert.equal(opened.data?.timeoutMs,
    planProtocol.PLAN_SYNTHESIS_RECOVERY_REQUEST_TIMEOUT_MS);
  assert.equal(opened.data?.repairReasoningDisabled, true);
});

test("synthesis recovery preserves affordable evidence without overlapping requests", async () => {
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
      dependsOn: [],
      criterionIds: ["criterion-user-objective"],
    }],
    validations: [{
      kind: "finite_command",
      command: "npm run build",
      cwd: "/fixture",
      expectedOutcome: "构建通过。",
      required: true,
      stepIndexes: [0],
      criterionIds: ["criterion-user-objective"],
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
        synthesisRequests.push({ messages, maxTokens, options });
        if (providerRound === 9) {
          throw new Error(
            "STREAM_NO_VISIBLE_PROGRESS_TIMEOUT: model stream produced keepalive chunks without a semantic action",
          );
        }
        return {
          content: submission,
          toolCalls: [],
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

  assert.equal(providerRound, 10);
  assert.equal(maxActiveRequests, 1);
  assert.equal(result.settlement.outcome.status, "paused");
  assert.equal(result.checkpoint.aggregate.phase, "reviewing");
  assert.equal(result.checkpoint.aggregate.scheduledCommands.length, 0);
  assert.equal(synthesisRequests.length, 2);
  assert.equal(synthesisRequests[0].maxTokens, 4_096);
  assert.equal(synthesisRequests[1].maxTokens, 4_096);
  assert.ok(
    synthesisRequests[1].messages.reduce(
      (total, message) => total + String(message.content || "").length,
      0,
    ) >=
    synthesisRequests[0].messages.reduce(
      (total, message) => total + String(message.content || "").length,
      0,
    ),
  );
  assert.match(
    synthesisRequests[1].messages
      .map((message) => String(message.content || ""))
      .join("\n"),
    /Synthesize the retained source receipts/,
  );
  assert.ok(synthesisRequests[1].options.responseFormat);
  assert.equal(result.checkpoint.aggregate.recovery.transportAttempts, 0);
  assert.equal(
    result.checkpoint.aggregate.events.filter((event) =>
      event.type === "soft_signal.observed" &&
      event.signal === "protocol_drift"
    ).length,
    1,
  );
});

test("repeated synthesis timeouts stay soft and a later submission can succeed", async () => {
  let providerRound = 0;
  let activeRequests = 0;
  let maxActiveRequests = 0;
  const submission = JSON.stringify({
    planMarkdown: "根据已读取源码修复文件标签生命周期并验证构建。",
    changes: [{
      title: "统一标签生命周期",
      operation: "modify",
      targets: ["src/main.js"],
      change: "打开文件时替换仍为空白且未修改的初始标签。",
      expectedOutcome: "只显示当前文件标签。",
      dependsOn: [],
      criterionIds: ["criterion-user-objective"],
    }],
    validations: [{
      kind: "finite_command",
      command: "npm run build",
      cwd: "/fixture",
      expectedOutcome: "构建通过。",
      required: true,
      stepIndexes: [0],
      criterionIds: ["criterion-user-objective"],
    }],
  });
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
        if (providerRound <= 11) {
          throw new Error(
            "STREAM_NO_VISIBLE_PROGRESS_TIMEOUT: model stream produced keepalive chunks without a semantic action",
          );
        }
        return {
          content: submission,
          toolCalls: [],
          usage: {},
          protocolViolation: null,
        };
      } finally {
        activeRequests -= 1;
      }
    },
    async (name) => {
      if (name === "get_project_skeleton") return "src/main.js";
      if (name === "read_file") return "const openFile = true;";
      if (name === "write_file") return "written";
      throw new Error(`unexpected tool ${name}`);
    },
  );

  assert.equal(providerRound, 12);
  assert.equal(maxActiveRequests, 1);
  assert.equal(result.settlement.outcome.status, "paused");
  assert.equal(result.checkpoint.aggregate.phase, "reviewing");
  assert.equal(result.checkpoint.aggregate.scheduledCommands.length, 0);
  assert.equal(result.checkpoint.aggregate.terminalOutcome, null);
  assert.equal(result.checkpoint.aggregate.recovery.exhausted, null);
  assert.equal(
    result.checkpoint.aggregate.events.filter((event) =>
      event.type === "run.completed"
    ).length,
    0,
  );
  assert.equal(
    result.checkpoint.aggregate.events.filter((event) =>
      event.type === "recovery.exhausted"
    ).length,
    0,
  );
  assert.equal(
    result.checkpoint.aggregate.events.filter((event) =>
      event.type === "soft_signal.observed" &&
      event.signal === "protocol_drift"
    ).length,
    1,
  );
});

test("Plan no-action remains bounded and can recover after both synthesis transports", async () => {
  let providerRound = 0;
  const submission = JSON.stringify({
    planMarkdown: "根据已读取源码修复文件标签生命周期并验证构建。",
    changes: [{
      title: "统一标签生命周期",
      operation: "modify",
      targets: ["src/main.js"],
      change: "打开文件时替换仍为空白且未修改的初始标签。",
      expectedOutcome: "只显示当前文件标签。",
      dependsOn: [],
      criterionIds: ["criterion-user-objective"],
    }],
    validations: [{
      kind: "finite_command",
      command: "npm run build",
      cwd: "/fixture",
      expectedOutcome: "构建通过。",
      required: true,
      stepIndexes: [0],
      criterionIds: ["criterion-user-objective"],
    }],
  });
  const result = await runProductionPlanScenario(
    async () => {
      providerRound += 1;
      if (providerRound === 1) {
        return {
          content: "",
          toolCalls: [{
            id: "read-before-no-action",
            name: "read_file",
            arguments: JSON.stringify({ path: "src/main.js" }),
          }],
          usage: {},
          protocolViolation: null,
        };
      }
      if (providerRound <= 5) {
        return {
          content: "仍在分析",
          toolCalls: [],
          usage: {},
          protocolViolation: null,
        };
      }
      return {
        content: submission,
        toolCalls: [],
        usage: {},
        protocolViolation: null,
      };
    },
    async (name) => {
      if (name === "get_project_skeleton") return "src/main.js";
      if (name === "read_file") return "const openFile = true;";
      if (name === "write_file") return "written";
      throw new Error(`unexpected tool ${name}`);
    },
  );
  const aggregate = result.checkpoint.aggregate;
  assert.equal(providerRound, 6);
  assert.equal(result.settlement.outcome.status, "paused");
  assert.equal(aggregate.phase, "reviewing");
  assert.equal(aggregate.scheduledCommands.length, 0);
  assert.ok(aggregate.workPlan);
  assert.equal(aggregate.recovery.exhausted, null);
  assert.equal(
    aggregate.events.filter((event) =>
      event.type === "soft_signal.observed" &&
      event.signal === "no_tool_call"
    ).length,
    1,
  );
  assert.equal(
    aggregate.events.filter((event) => event.type === "run.completed").length,
    0,
  );
  assert.equal(
    aggregate.events.filter((event) => event.type === "turn.completed").length,
    0,
  );
  assert.equal(
    aggregate.events.filter((event) =>
      event.type === "projection.published" && event.audience === "final"
    ).length,
    0,
  );
});

test("only structured provider transport unavailability closes Plan recovery", async () => {
  let providerRound = 0;
  const result = await runProductionPlanScenario(
    async () => {
      providerRound += 1;
      if (providerRound === 1) {
        return {
          content: "",
          toolCalls: [{
            id: "read-before-provider-unavailable",
            name: "read_file",
            arguments: JSON.stringify({ path: "src/main.js" }),
          }],
          usage: {},
          protocolViolation: null,
        };
      }
      throw new runtime.RuntimeV2ProviderTransportsUnavailableError();
    },
    async (name) => {
      if (name === "get_project_skeleton") return "src/main.js";
      if (name === "read_file") return "const openFile = true;";
      throw new Error(`unexpected tool ${name}`);
    },
  );
  const aggregate = result.checkpoint.aggregate;
  assert.equal(providerRound, 2);
  assert.equal(result.settlement.outcome.status, "completed");
  assert.equal(result.settlement.outcome.resultKind, "error");
  assert.equal(aggregate.phase, "completed");
  assert.equal(aggregate.terminalOutcome?.resultKind, "error");
  assert.equal(aggregate.recovery.exhausted, null);
  assert.equal(
    aggregate.events.filter((event) =>
      event.type === "soft_signal.observed" &&
      event.signal === "protocol_drift"
    ).length,
    0,
  );
});

test("one sealed WorkPlan and ReviewCommit survive checkpoint cold recovery", () => {
  const { checkpoint, sealed, commit } = reviewCheckpoint();
  const persisted = runtime.serializeRuntimeV2CheckpointMap({
    [turn.turnId]: checkpoint,
  })[turn.turnId];
  assert.equal(
    Object.prototype.hasOwnProperty.call(persisted, "aggregate"),
    false,
    "the durable checkpoint must contain only the canonical event ledger",
  );
  const restored = runtime.normalizeRuntimeV2Checkpoint(
    JSON.parse(JSON.stringify(persisted)),
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
  assert.equal(result.checkpoint.aggregate.phase, "preparing");
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
  assert.equal(current.aggregate.phase, "preparing");
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

function simplePlanSubmission(target = "src/new-fixture.js") {
  return { planMarkdown: "Create one scoped fixture and verify the build.",
    changes: [{ operation: "create", targets: [target], change: "Create the scoped fixture.", dependsOn: [], criterionIds: ["criterion-user-objective"] }],
    validations: [{ kind: "finite_command", command: "npm run build", expectedOutcome: "Build passes.", required: true, stepIndexes: [0], criterionIds: ["criterion-user-objective"] }],
  };
}

test("production Plan actively starts a scoped child and keeps the parent moving without a spawn call", async () => {
  let parentRound = 0;
  let childStarted = false;
  let releaseChild;
  const parentContinued = new Promise(resolve => { releaseChild = resolve; });
  const result = await runProductionPlanScenario(async (messages, _settings, callbacks) => {
    if (messages.some(message => String(message.content).includes("You are a read-only child"))) {
      childStarted = true;
      callbacks.onLifecycle?.({ phase: "model_progress", chunkCount: 1, byteCount: 10 });
      await parentContinued;
      return { content: "The scoped project manifest identifies the verification entry point.", toolCalls: [], usage: {} };
    }
    parentRound++;
    if (parentRound === 1) return {
      content: "", toolCalls: ["src/main.js", "package.json"].map((path, index) => ({
        id: `source-${index}`, name: "read_file", arguments: JSON.stringify({ path }),
      })), usage: {},
    };
    if (parentRound === 2) {
      assert.equal(childStarted, true);
      releaseChild();
      return planProviderReply("parent-continues", "read_file", { path: "src/other.js" });
    }
    return planProviderReply("plan", "submit_runtime_v2_work_plan", simplePlanSubmission());
  }, (name, args) => planFixtureTool(name, args), {
    initialCheckpoint: planningCheckpointWithRequirement("optional"),
    turnInputContextSignals: { subagentPreference: "preferred" },
    subagentCapacityPolicy: { maxActiveRequests: 1, modelRequestMode: "parallel" },
    projectBaselineContext: { kind: "project_baseline_context", workspace: { canonicalPath: turn.workspaceKey },
      fingerprints: { overall: "fixture" }, anchors: [{ path: "package.json", kind: "manifest" }],
      facts: { languages: [], packageManagers: [], runtimes: [], scripts: [] }, topology: [], truncated: {}, omissions: [], diagnostics: [] },
  });
  assert.equal(result.settlement.outcome.status, "paused");
  const { events, subagents } = result.checkpoint.aggregate;
  assert.equal(subagents.length, 1);
  assert.ok(subagents[0].proactiveKey);
  assert.equal(subagents[0].sourceToolCallId, undefined);
  assert.ok(events.some(event => event.type === "subagent.telemetry" && event.telemetry.phase === "first_token"));
  assert.ok(events.some(event => event.type === "tool.completed" && event.evidence.some(item => item.target === "src/other.js")));
});

test("approved Plan revision opens a child on the exact changed target before the parent provider", async () => {
  const sessionKey = `${turn.workspaceKey}:1`;
  const sourceTurn = { ...turn, sessionKey, turnId: "reviewed-plan", clientSubmissionId: "reviewed-plan-receipt" };
  const sourceRun = { ...run, sessionKey, turnId: sourceTurn.turnId, runId: "reviewed-run", attemptId: "reviewed-run" };
  const { checkpoint: review, commit } = reviewCheckpoint(sourceTurn, sourceRun);
  const append = (state, fields) => runtime.transition(state, event(state?.nextSequence || 0, (state?.updatedAt || 20) + 1, fields));
  const checkpoint = aggregate => runtime.createRuntimeV2Checkpoint({ aggregate, revision: aggregate.nextSequence, updatedAt: aggregate.updatedAt });
  const close = (aggregate, owner, active, resultKind) => {
    const finalProjection = runtime.buildRuntimeV2FinalProjection(aggregate, `final-${owner.turnId}`, resultKind, resultKind);
    const outcome = { resultKind, reason: resultKind, completedAt: aggregate.updatedAt + 2, finalProjectionId: finalProjection.id };
    if (resultKind === "canceled") aggregate = append(aggregate, { type: "run.aborted", run: active, reason: outcome.reason });
    aggregate = append(aggregate, { type: "run.completed", run: active, outcome, finalProjection });
    aggregate = append(aggregate, { type: "projection.published", run: active, audience: "final", projectionId: finalProjection.id, projection: finalProjection });
    return append(aggregate, { type: "turn.completed", turn: owner, runId: active.runId, outcome });
  };
  const approved = append(review.aggregate, { type: "work_plan.approved", run: sourceRun,
    workPlan: { ...review.aggregate.workPlan, status: "approved" } });
  const source = { turn: sourceTurn, approvalEventId: approved.events.at(-1).eventId, authority: commit.authority };
  const driftTurn = { ...turn, sessionKey, turnId: "blocked-resume", clientSubmissionId: "blocked-resume-receipt" };
  const driftRun = { ...run, sessionKey, turnId: driftTurn.turnId, runId: "blocked-run", attemptId: "blocked-run" };
  const target = "src/main.js";
  let drift = append(null, { type: "turn.admitted", turn: driftTurn, strategy: "plan", objective: "Continue the approved plan",
    constraints: [], acceptanceCriteria: [] });
  drift = append(drift, { type: "run.started", run: driftRun, phase: "planning" });
  drift = append(drift, { type: "observation.recorded", run: driftRun, evidence: { id: "approved-plan-drift:0", kind: "tool", target } });
  const currentSource = "export const changed = true;\n";
  const observed = [];
  const dispatches = [];
  let abort;
  let releaseChild;
  const parentEntered = new Promise(resolve => { releaseChild = resolve; });
  const result = await runProductionPlanScenario(async (messages, _settings, callbacks) => {
    const transcript = messages.map(message => String(message.content)).join("\n");
    if (transcript.includes("You are a read-only child")) {
      dispatches.push("child");
      callbacks.onLifecycle?.({ phase: "model_progress", chunkCount: 1, byteCount: 10 });
      await parentEntered;
      return { content: "The exact source is available for review.", toolCalls: [], usage: {} };
    }
    dispatches.push("parent");
    releaseChild();
    assert.match(transcript, /CURRENT REVISION PATH CHECKS/);
    assert.match(transcript, /export const changed = true/);
    abort.abort("fixture verified overlapping provider requests");
    return { content: "", toolCalls: [], usage: {} };
  }, async name => { throw new Error(`unexpected workspace tool ${name}`); }, {
    runSessionKey: sessionKey,
    revision: {
      source,
      turns: [{ id: sourceTurn.turnId, clientSubmissionId: sourceTurn.clientSubmissionId, userPrompt: "Prepare the plan" },
        { id: driftTurn.turnId, approvedPlanContinuation: source }],
      checkpoints: { [sourceTurn.turnId]: checkpoint(close(approved, sourceTurn, sourceRun, "canceled")),
        [driftTurn.turnId]: checkpoint(close(drift, driftTurn, driftRun, "blocked")) },
      ipc: {
        getFileMetadata: async path => ({ path }),
        readFileWindow: async path => {
          observed.push(path);
          return { path, content: currentSource, contentVersion: `sha256-${createHash("sha256").update(currentSource).digest("hex")}`,
            totalLines: 1, totalChars: currentSource.length, returnedStartLine: 1, returnedEndLine: 1,
            returnedStartChar: 0, returnedEndChar: currentSource.length, complete: true };
        },
      },
    },
    onAbortCtrl: value => { abort = value; },
    turnInputContextSignals: { subagentPreference: "preferred" },
    subagentCapacityPolicy: { maxActiveRequests: 1, modelRequestMode: "parallel" },
  });
  assert.deepEqual(observed, [target]);
  assert.deepEqual(dispatches, ["child", "parent"]);
  const { events, subagents } = result.checkpoint.aggregate;
  assert.equal(subagents.length, 1);
  assert.deepEqual(subagents[0].allowedPaths, [target]);
  assert.equal(subagents[0].accessMode, "read");
  assert.equal(subagents[0].taskKind, "review");
  const childOpened = events.findIndex(event => event.type === "subagent.telemetry" && event.telemetry.phase === "request_opened");
  const parentScheduled = events.findIndex(event => event.type === "command.scheduled" && event.command.kind === "request_model");
  assert.ok(childOpened >= 0 && childOpened < parentScheduled);
  assert.ok(!events.some(event => event.type === "work_plan.approved"));
});

const planProviderReply = (id, name, args) => ({ content: "", toolCalls: [{ id, name, arguments: JSON.stringify(args) }], usage: {}, protocolViolation: null });
const planFixtureTool = async (name, args) => {
  if (name === "get_project_skeleton") return "src/main.js";
  if (name === "read_file") return `export const source = ${JSON.stringify(args.path)};`;
  if (name === "write_file") return "written";
  throw new Error(`unexpected tool ${name}`);
};

function ordinarySynthesisCheckpoint(restrictions = []) {
  let checkpoint = planningCheckpointWithRequirement("optional");
  if (restrictions.length) {
    let restricted = null;
    for (const value of checkpoint.events) {
      const entry = value.type === "turn.admitted" ? { ...value, capabilityRestrictions: restrictions } : value;
      restricted = runtime.appendRuntimeV2Checkpoint({ checkpoint: restricted, owner: turn, expectedRevision: restricted?.revision || 0, event: entry }).checkpoint;
    }
    checkpoint = restricted;
  }
  const append = (value) => {
    const result = runtime.appendRuntimeV2Checkpoint({ checkpoint, owner: turn, expectedRevision: checkpoint.revision,
      event: event(checkpoint.aggregate.nextSequence, checkpoint.aggregate.updatedAt + 1, value) });
    assert.equal(result.disposition, "committed");
    checkpoint = result.checkpoint;
  };
  const idempotencyKey = "ordinary-synthesis-before-cold-restore";
  append({ type: "command.scheduled", run, command: { idempotencyKey, kind: "request_model", run, phase: "planning",
    payload: { mode: "plan", stage: "synthesis", transport: "native_tool", submissionRepairPending: false, compactRecovery: false } } });
  append({ type: "provider.responded", run, idempotencyKey, result: { visibleText: "I need one specific source fact before submitting the plan.", toolCalls: [], diagnostics: [] } });
  return checkpoint;
}

for (const scenario of ["prose", "text_envelope", "transport", "cold"]) test(`ordinary Plan synthesis keeps safe missing-fact reads after ${scenario} recovery`, async () => {
  const requests = [];
  const reads = [];
  const candidate = simplePlanSubmission();
  candidate.planMarkdown = "Use ORDINARY_SYNTHESIS_FACT_27 to create the bounded fixture, then verify the build.";
  const result = await runProductionPlanScenario(async (messages, _settings, _callbacks, _signal, tools, _maxTokens, options) => {
    requests.push({ messages, names: tools.map((tool) => tool.function.name), options });
    if (scenario === "transport" && requests.length <= 2) throw new Error("ECONNRESET: ordinary synthesis transport interruption");
    if (scenario !== "cold" && scenario !== "transport" && requests.length === 1) return { content: "I need the exact source contract before completing this plan.", toolCalls: [], usage: {}, protocolViolation: null };
    const readRound = scenario === "transport" ? 3 : scenario === "cold" ? 1 : 2;
    if (requests.length === readRound) return planProviderReply("ordinary-missing-fact", "read_file", { path: "src/ordinary-fact.ts" });
    return planProviderReply("ordinary-source-grounded-plan", "submit_runtime_v2_work_plan", candidate);
  }, async (name, args) => {
    if (name === "read_file") { if (!args.__raw) reads.push(args.path); return "export const ORDINARY_SYNTHESIS_FACT_27 = true;"; }
    return planFixtureTool(name, args);
  }, { initialCheckpoint: scenario === "cold" ? ordinarySynthesisCheckpoint() : undefined, nativeToolRoundTrip: scenario !== "text_envelope" });
  const recovered = requests[scenario === "transport" ? 2 : scenario === "cold" ? 0 : 1];
  if (scenario === "text_envelope") {
    assert.deepEqual(recovered.names, []);
    assert.equal(recovered.options.toolChoice, undefined);
    assert.match(recovered.messages.map((message) => String(message.content || "")).join("\n"), /read_file/);
  } else {
    assert.ok(recovered.names.includes("read_file"), "a soft no-action or transport boundary cannot withdraw authorized source reads");
    assert.ok(recovered.names.includes("submit_runtime_v2_work_plan"));
    assert.equal(recovered.options.toolChoice, "required", "ordinary synthesis can choose a missing-fact read or submission");
  }
  assert.match(recovered.messages.map((message) => String(message.content || "")).join("\n"), /Read only a specific missing fact, or call submit_runtime_v2_work_plan/);
  assert.equal(recovered.options.responseFormat, undefined);
  assert.deepEqual(reads, ["src/ordinary-fact.ts"]);
  assert.match(requests.at(-1).messages.map((message) => String(message.content || "")).join("\n"), /export const ORDINARY_SYNTHESIS_FACT_27 = true/);
  assert.equal(result.checkpoint.aggregate.phase, "reviewing");
  assert.equal(result.checkpoint.aggregate.run.identity.runId, run.runId);
  assert.equal(result.checkpoint.aggregate.events.filter((entry) => entry.type === "run.started").length, 1);
  assert.ok(result.checkpoint.aggregate.evidence.some((entry) => entry.kind === "source" && entry.target === "src/ordinary-fact.ts"));
  assert.equal(result.checkpoint.aggregate.evidence.some((entry) => entry.kind === "mutation"), false);
  if (scenario === "transport") {
    assert.deepEqual(requests[1].names, [], "explicit structured-response compatibility stays schema-only on the wire");
    assert.equal(requests[1].options.responseFormat?.type, "json_schema");
  }
});

test("ordinary cold synthesis retains durable workspace and network restrictions", async () => {
  const requests = [];
  let reads = 0;
  const result = await runProductionPlanScenario(async (_messages, _settings, _callbacks, _signal, tools, _maxTokens, options) => {
    requests.push({ names: tools.map((tool) => tool.function.name), options });
    return requests.length === 1 ? planProviderReply("ordinary-restricted-read", "read_file", { path: "src/ordinary-fact.ts" })
      : planProviderReply("ordinary-restricted-plan", "submit_runtime_v2_work_plan", simplePlanSubmission());
  }, async (name, args) => {
    if (name === "read_file" || name === "web_fetch") { reads++; throw new Error("restricted tools cannot execute"); }
    return planFixtureTool(name, args);
  }, { initialCheckpoint: ordinarySynthesisCheckpoint(["workspace_read", "network"]) });
  assert.equal(reads, 0);
  assert.ok(requests.every((request) => !request.names.includes("read_file") && !request.names.includes("web_fetch") && !request.names.includes("write_file")));
  assert.equal(result.checkpoint.aggregate.phase, "reviewing");
  assert.deepEqual(result.checkpoint.aggregate.objective.capabilityRestrictions, ["workspace_read", "network"]);
});

test("advisory Plan validation reports its unsupported required coverage instead of missing mapped IDs", () => {
  const candidate = simplePlanSubmission();
  candidate.validations = [{ kind: "assertion", required: true, expectedOutcome: "The recovered source fact is represented in the result." }];
  const compiled = planProtocol.workPlanDraftFromSubmission(candidate, [], "Create the fixture", ["criterion-user-objective"]);
  assert.deepEqual(compiled.draft.validations[0].criterionIds, ["criterion-user-objective"]);
  assert.equal(compiled.draft.validations[0].required, false);
  assert.throws(() => planSubmissionPolicy.assertAdmittedPlanCriteriaMapped({ draft: compiled.draft, criterionIds: ["criterion-user-objective"] }), error => {
    assert.match(error.message, /validations\[0\].*assertion/);
    assert.match(error.message, /cannot provide required validation coverage/);
    assert.doesNotMatch(error.message, /missing from required validations\[\]\.criterionIds/);
    return true;
  });
});

test("incident advisory-only Plan saves a reviewable draft once and concludes partial without regeneration", async () => {
  const candidate = simplePlanSubmission();
  candidate.planMarkdown = "# Collector game plan\n\nUse Player, Coin_1/Coin_2/Coin_3 and CollectorGame with read-only Score/Won.\n";
  candidate.validations = ["Move with WASD", "Collect coins", "Show score", "Show victory", "Reset with R"].map(expectedOutcome => ({ kind: "advisory", required: true, expectedOutcome }));
  let requests = 0;
  const result = await runProductionPlanScenario(async () => {
    requests++;
    if (requests > 1) throw new Error("semantic validation gaps must preserve the draft instead of requesting another whole plan");
    return planProviderReply("incident-advisory-plan", "submit_runtime_v2_work_plan", candidate);
  }, planFixtureTool);
  assert.equal(requests, 1);
  assert.equal(result.settlement.outcome.resultKind, "partial");
  assert.equal(result.savedDocuments.length, 1);
  assert.match(result.savedDocuments[0].markdown, /Collector game plan/);
  assert.equal(result.checkpoint.aggregate.sealedWorkPlan, null);
  assert.equal(result.state.activeActionRequest?.kind === "plan_review", false);
  const record = loadTs(path.join(workspaceRoot, "src/lib/planDocumentRecords.ts")).resolvePlanDraftFromAggregate(result.checkpoint.aggregate);
  assert.ok(record);
  assert.ok(record.diagnostics.some(item => item.criterionIds.includes("criterion-user-objective")));
  assert.equal(record.source.toolCallId, "incident-advisory-plan");
  assert.equal(result.checkpoint.aggregate.events.filter(entry => entry.type === "run.completed").length, 1);
  assert.equal(result.checkpoint.aggregate.events.filter(entry => entry.type === "turn.completed").length, 1);
});

for (const firstStop of ["length", "reasoning_only_timeout"]) test(`Plan responds to first pre-action ${firstStop} with bounded recovery and safe reads`, async () => {
  const candidate = simplePlanSubmission();
  candidate.validations = [{ kind: "advisory", expectedOutcome: "Inspect the result in the editor." }];
  const requests = [];
  const options = { reasoningToggle: true, runtimeContextBudget: { contextLimit: 32768, inputBudget: 24576, outputBudget: 8192, readWindowChars: 16000 } };
  const completed = await runProductionPlanScenario(async (_messages, settings, _callbacks, _signal, tools, maxTokens, options) => {
    requests.push({ settings, names: tools.map(tool => tool.function.name), maxTokens, options });
    return requests.length === 1 ? {
      content: firstStop === "length" ? "" : "Hidden reasoning mirrored into the raw body.",
      semanticContent: "",
      reasoningContent: "No action before the output limit.",
      finishReason: firstStop === "length" ? "length" : null,
      ...(firstStop === "reasoning_only_timeout" ? { clientStopReason: firstStop } : {}),
      toolCalls: [], usage: {},
    }
      : planProviderReply("bounded-recovery-draft", "submit_runtime_v2_work_plan", candidate);
  }, planFixtureTool, options);
  assert.equal(completed.settlement.outcome.resultKind, "partial");
  assert.equal(requests[0].maxTokens, 8192);
  assert.equal(requests[0].options.reasoningOnlyTimeoutMs, 60_000);
  assert.equal(requests[1].maxTokens, 4096);
  assert.equal(requests[1].settings.reasoningRequest, "off");
  assert.ok(requests[1].names.includes("read_file"));
  assert.ok(requests[1].names.includes("submit_runtime_v2_work_plan"));
  const truncated = completed.checkpoint.aggregate.events.find(event => event.type === "provider.responded" && event.result.diagnostics.some(item => item.code === "output_truncated"));
  const restored = await runProductionPlanScenario(async (_messages, settings, _callbacks, _signal, tools, maxTokens) => {
    assert.equal(maxTokens, 4096);
    assert.equal(settings.reasoningRequest, "off");
    assert.ok(tools.some(tool => tool.function.name === "read_file"));
    return planProviderReply("bounded-recovery-restored-draft", "submit_runtime_v2_work_plan", candidate);
  }, planFixtureTool, { ...options, initialCheckpoint: checkpointThrough(completed.checkpoint, truncated.sequence) });
  assert.equal(restored.settlement.outcome.resultKind, "partial");
});

test("a sealed Plan with a downgraded advisory check survives the Session JSON boundary", async () => {
  const candidate = simplePlanSubmission();
  candidate.validations.push({ kind: "finite_command", command: "npm run dev", expectedOutcome: "Observe the local service." });
  const result = await runProductionPlanScenario(async () => planProviderReply("review-with-advisory-downgrade", "submit_runtime_v2_work_plan", candidate), planFixtureTool);
  assert.equal(result.checkpoint.aggregate.phase, "reviewing");
  const advisory = result.checkpoint.aggregate.sealedWorkPlan.draft.validations[1];
  assert.equal(advisory.kind, "advisory");
  assert.equal(Object.hasOwn(advisory, "command"), false, "a downgraded check has no command property to lose on disk");
  const raw = runtime.serializeRuntimeV2CheckpointMap({ [turn.turnId]: result.checkpoint })[turn.turnId];
  const restored = runtime.normalizeRuntimeV2Checkpoint(JSON.parse(JSON.stringify(raw)), turn);
  assert.equal(restored?.aggregate.phase, "reviewing");
  assert.equal(restored.aggregate.planReviewCommit.artifact.documentRef.contentHash, result.checkpoint.aggregate.planReviewCommit.artifact.documentRef.contentHash);
});

for (const cold of [false, true]) test(`Plan protocol repair can read a missing fact and resubmit within the same Run${cold ? " after legacy typed rejection restore" : ""}`, async () => {
  const restored = planningCheckpointWithTypedSubmissionRejection({ emptyBody: true });
  const invalid = simplePlanSubmission();
  invalid.planMarkdown = ""; // No reviewable body exists yet; protocol recovery remains safe and necessary.
  const corrected = simplePlanSubmission();
  corrected.planMarkdown = "Create the fixture using the recovered RECOVERY_FACT_864 contract, then verify it.";
  const requests = [];
  const reads = [];
  const result = await withFakePlanClock(restored.rejectionAt + 1_000, async () => runProductionPlanScenario(async (messages, _settings, _callbacks, _signal, tools, _maxTokens, requestOptions) => {
    requests.push({ messages, names: tools.map(tool => tool.function.name), requestOptions });
    const index = requests.length - (cold ? 0 : 1);
    if (index === 0) return planProviderReply("invalid-validation", "submit_runtime_v2_work_plan", invalid);
    if (index === 1) return planProviderReply("missing-repair-fact", "read_file", { path: "src/recovery-fact.ts" });
    return cold ? { content: JSON.stringify(corrected), toolCalls: [], usage: {}, protocolViolation: null }
      : planProviderReply("repaired-plan", "submit_runtime_v2_work_plan", corrected);
  }, async (name, args) => {
    if (name === "read_file") { reads.push(args.path); return "export const RECOVERY_FACT_864 = true;"; }
    return planFixtureTool(name, args);
  }, { initialCheckpoint: cold ? restored.checkpoint : undefined }));
  const repairRequest = requests[cold ? 0 : 1];
  assert.ok(repairRequest.names.includes("read_file"), "a rejected WorkPlan does not close authorized safe reads");
  assert.ok(repairRequest.names.includes("submit_runtime_v2_work_plan"));
  assert.equal(repairRequest.requestOptions.toolChoice, "required", "Plan may choose a safe read or submission");
  assert.doesNotMatch(repairRequest.messages.map(message => String(message.content || "")).join("\n"), /only the effect-free submission ingress|do not investigate again/);
  assert.ok(reads.includes("src/recovery-fact.ts"));
  assert.match(requests.at(-1).messages.map(message => String(message.content || "")).join("\n"), /export const RECOVERY_FACT_864 = true/);
  assert.equal(result.checkpoint.aggregate.phase, "reviewing");
  assert.equal(result.checkpoint.aggregate.run.identity.runId, run.runId);
  assert.equal(result.checkpoint.aggregate.events.filter(entry => entry.type === "run.started").length, 1);
  assert.ok(result.checkpoint.aggregate.evidence.some(entry => entry.kind === "source" && entry.target === "src/recovery-fact.ts"));
  assert.equal(result.checkpoint.aggregate.evidence.some(entry => entry.kind === "mutation"), false);
});

test("cold Plan repair preserves durable workspace and network restrictions", async () => {
  const restored = planningCheckpointWithTypedSubmissionRejection({ emptyBody: true });
  let restricted = null;
  for (const value of restored.checkpoint.aggregate.events) {
    const entry = value.type === "turn.admitted" ? { ...value, capabilityRestrictions: ["workspace_read", "network"], networkRead: { enabled: true, provider: "bing" } } : value;
    restricted = runtime.appendRuntimeV2Checkpoint({ checkpoint: restricted, owner: turn, expectedRevision: restricted?.revision || 0, event: entry }).checkpoint;
  }
  const requests = [];
  let reads = 0;
  const corrected = structuredClone(restored.candidate);
  corrected.planMarkdown = "Create the bounded owner using the retained source contract, then verify the build.";
  corrected.validations[0].stepIndexes = [0];
  const result = await withFakePlanClock(restored.rejectionAt + 1_000, async () => runProductionPlanScenario(async (_messages, _settings, _callbacks, _signal, tools) => {
    requests.push(tools.map(tool => tool.function.name));
    return requests.length === 1 ? planProviderReply("restricted-repair-read", "read_file", { path: "src/recovery-fact.ts" })
      : planProviderReply("restricted-corrected-plan", "submit_runtime_v2_work_plan", corrected);
  }, async (name, args) => {
    if (name === "read_file" || name === "web_fetch") { reads++; throw new Error("restricted tools must not execute"); }
    return planFixtureTool(name, args);
  }, { initialCheckpoint: restricted }));
  assert.equal(reads, 0);
  assert.ok(requests.every(names => !names.includes("read_file") && !names.includes("web_fetch") && !names.includes("write_file")));
  assert.equal(result.checkpoint.aggregate.phase, "reviewing");
  assert.deepEqual(result.checkpoint.aggregate.objective.capabilityRestrictions, ["workspace_read", "network"]);
});

test("global Plan checkpoints retain the canonical admitted Session scope", async () => {
  const { GLOBAL_CHAT_KEY } = loadTs(path.join(workspaceRoot, "src/lib/sessionTypes.ts"));
  const result = await runProductionPlanScenario(async () =>
    planProviderReply("global-plan-submit", "submit_runtime_v2_work_plan", simplePlanSubmission()),
  planFixtureTool, { runWorkspace: "", runScopeKey: GLOBAL_CHAT_KEY, runSessionKey: `${GLOBAL_CHAT_KEY}:1` });
  assert.equal(result.checkpoint.owner.workspaceKey, GLOBAL_CHAT_KEY);
  assert.equal(result.checkpoint.owner.sessionKey, `${GLOBAL_CHAT_KEY}:1`);
  assert.equal(result.checkpoint.aggregate.turn.workspaceKey, GLOBAL_CHAT_KEY);
  assert.equal(result.checkpoint.aggregate.phase, "reviewing");
});

function checkpointThrough(checkpoint, sequence) {
  let result = null;
  for (const event of checkpoint.aggregate.events.filter((event) => event.sequence <= sequence)) {
    result = runtime.appendRuntimeV2Checkpoint({ checkpoint: result, owner: turn, expectedRevision: result?.revision || 0, event }).checkpoint;
  }
  return result;
}

test("Plan persists its captured network policy and keeps it through cold restore", async () => {
  const policy = { enabled: true, provider: "bing" };
  const first = await runProductionPlanScenario(async () =>
    planProviderReply("network-policy-submit", "submit_runtime_v2_work_plan", simplePlanSubmission()),
  planFixtureTool, { networkRead: policy });
  assert.equal(first.checkpoint.aggregate.phase, "reviewing");
  assert.deepEqual(first.checkpoint.aggregate.networkRead, policy);
  const start = first.checkpoint.aggregate.events.find((entry) => entry.type === "run.started");
  const prefix = checkpointThrough(first.checkpoint, start.sequence);
  const restored = await runProductionPlanScenario(async () =>
    planProviderReply("restored-network-submit", "submit_runtime_v2_work_plan", simplePlanSubmission()),
  planFixtureTool, { initialCheckpoint: prefix, networkRead: { enabled: false, provider: "baidu" } });
  assert.equal(restored.checkpoint.aggregate.phase, "reviewing");
  assert.deepEqual(restored.checkpoint.aggregate.networkRead, policy);
});

test("Plan unverified reader output stays visible without creating source evidence", async () => {
  const output = JSON.stringify({ url: "https://example.com/source", content: "Proxy error content", retrieval: { usable: false } });
  const planEvidence = loadTsWithMocks(path.join(workspaceRoot, "src/store/runtimeV2/planEvidencePort.ts"), new Map([
    ["../../lib/toolExecutor", { executeTool: async () => output }],
  ]));
  const messages = []; const evidence = []; const settlements = [];
  await planEvidence.executeReadOnlyPlanTool({
    context: {}, ledger: {
      snapshot: () => ({ networkRead: { enabled: true, provider: "bing" }, objective: {} }),
      schedule: async () => ({ idempotencyKey: "unverified-reader" }), settleCommand: async (event) => settlements.push(event), recordSoftSignal: async () => undefined,
    }, run, call: { id: "reader", name: "web_fetch", arguments: { url: "https://example.com/source" } },
    messages, evidence, evidenceContents: new Map(), parallelReadCount: 1, logStoreEvent() {},
  });
  assert.deepEqual(settlements[0].evidence, []);
  assert.deepEqual(evidence, []);
  assert.equal(messages[0].content, output);
});

test("Plan repeated receipts retain soft pressure while a live or cold correction can still submit", async () => {
  const originalNow = Date.now;
  let now = 9_000_000;
  let requests = 0;
  Date.now = () => now;
  try {
    const result = await runProductionPlanScenario(async (messages, _settings, _callbacks, _signal, tools) => {
      requests += 1;
      if (requests <= 3) {
        now += requests === 3 ? PLAN_RECOVERY_STALL_MS + 1 : 1000;
        return planProviderReply("provider-reuses-this-id", "read_file", { path: "src/main.js" });
      }
      assert.equal(requests, 4);
      assert.ok(tools.some(tool => tool.function.name === "read_file"));
      assert.match(messages.map(message => String(message.content || "")).join("\n"), /Cached or unchanged results are not progress/);
      return planProviderReply("live-correction-after-soft-stall", "submit_runtime_v2_work_plan", simplePlanSubmission());
    }, planFixtureTool);
    assert.equal(requests, 4);
    assert.equal(result.checkpoint.aggregate.phase, "reviewing");
    assert.equal(result.checkpoint.aggregate.terminalOutcome, null);
    const events = result.checkpoint.aggregate.events;
    const readCommands = new Set(events.filter(event => event.type === "command.scheduled" && event.command.payload.toolName === "read_file").map(event => event.command.idempotencyKey));
    const lastRead = events.filter(event => event.type === "tool.completed" && readCommands.has(event.idempotencyKey)).at(-1);
    const resume = checkpointThrough(result.checkpoint, lastRead.sequence);
    const recovery = loadTs(path.join(workspaceRoot, "src/lib/runtime-v2/readOnlyProgress.ts")).deriveReadOnlyRecoveryWindow(resume.aggregate, { finalTextIsProgress: false });
    assert.ok(recovery?.pressure.occurrence >= 2, "same-version reads did not renew progress");
    assert.ok(now - recovery.startedAt > PLAN_RECOVERY_STALL_MS);
    let restoredRequests = 0;
    const restored = await runProductionPlanScenario(async (_messages, _settings, _callbacks, _signal, tools) => {
      restoredRequests++;
      assert.ok(tools.some(tool => tool.function.name === "read_file"));
      return planProviderReply("cold-correction-after-soft-stall", "submit_runtime_v2_work_plan", simplePlanSubmission());
    }, async () => { throw new Error("retained evidence needs no disk reread"); }, { initialCheckpoint: resume });
    assert.equal(restoredRequests, 1);
    assert.equal(restored.checkpoint.aggregate.phase, "reviewing");
    assert.equal(restored.checkpoint.aggregate.events.filter(event => event.type === "provider.responded").length, 4);
  } finally { Date.now = originalNow; }
});

test("Plan new source progress clears recovery and cold restore retains the exact transcript", async () => {
  const originalNow = Date.now;
  let now = 11_000_000;
  let requests = 0;
  Date.now = () => now;
  try {
    const completed = await runProductionPlanScenario(async () => {
      requests += 1;
      now += requests === 3 ? PLAN_RECOVERY_STALL_MS + 1 : 1000;
      return requests <= 3 ? planProviderReply("same-provider-id", "read_file", { path: requests === 3 ? "src/fresh.js" : "src/main.js" })
        : planProviderReply("submit", "submit_runtime_v2_work_plan", simplePlanSubmission());
    }, planFixtureTool);
    assert.equal(completed.checkpoint.aggregate.phase, "reviewing");
    const fresh = completed.checkpoint.aggregate.events.find((event) => event.type === "tool.completed" && event.evidence.some((item) => item.target === "src/fresh.js"));
    const prefix = checkpointThrough(completed.checkpoint, fresh.sequence);
    now += 30 * 60_000;
    let restoredRequests = 0;
    const restored = await runProductionPlanScenario(async (messages) => {
      restoredRequests += 1;
      assert.equal(messages.filter((message) => message.role === "tool").length, 3);
      assert.ok(messages.some((message) => String(message.content).includes('export const source = "src/main.js";')));
      assert.ok(messages.some((message) => String(message.content).includes('export const source = "src/fresh.js";')));
      return planProviderReply("restored-submit", "submit_runtime_v2_work_plan", simplePlanSubmission());
    }, async (name) => { assert.equal(name, "write_file", "cold restore cannot repeat bootstrap or source I/O"); return "written"; }, { initialCheckpoint: prefix });
    assert.equal(restoredRequests, 1);
    assert.equal(restored.checkpoint.aggregate.phase, "reviewing");
    assert.deepEqual(restored.checkpoint.aggregate.evidence.filter((item) => /^E/.test(item.id)).map((item) => item.id), ["E1", "E2", "E3"]);
  } finally { Date.now = originalNow; }
});

test("Plan retains affordable evidence after more than ten discovery requests", async () => {
  let requests = 0;
  const result = await runProductionPlanScenario(async (messages) => {
    requests += 1;
    if (requests <= 12) return planProviderReply(`read-${requests}`, "read_file", { path: `src/marker-${requests}.js` });
    assert.equal(messages.filter((message) => message.role === "tool").length, 12);
    assert.ok(messages.some((message) => String(message.content).includes('export const source = "src/marker-1.js";')));
    return planProviderReply("submit", "submit_runtime_v2_work_plan", simplePlanSubmission());
  }, planFixtureTool);
  assert.equal(requests, 13);
  assert.equal(result.checkpoint.aggregate.phase, "reviewing");
  assert.equal(result.checkpoint.aggregate.events.some((event) => event.type === "soft_signal.observed" && event.signal === "iteration_limit"), false);
});

test("Plan terminal recovery closes every durable interruption boundary exactly once", async () => {
  const closed = await runProductionPlanScenario(async () => { throw new Error("explicit deadline already expired"); }, planFixtureTool, { lifecycleDeadlineAt: Date.now() - 1 });
  assert.equal(closed.settlement.outcome.resultKind, "error");
  const boundaries = closed.checkpoint.aggregate.events.filter((event) =>
    (event.type === "command.scheduled" && event.command.kind === "finalize_turn") ||
    (event.type === "phase.changed" && event.phase === "finalizing") ||
    event.type === "run.completed" || (event.type === "projection.published" && event.projection.kind === "final"));
  assert.equal(boundaries.length, 4);
  for (const boundary of boundaries) {
    const resumed = await runProductionPlanScenario(async () => { throw new Error("terminal restore must not call provider"); }, async () => { throw new Error("terminal restore must not execute tools"); }, { initialCheckpoint: checkpointThrough(closed.checkpoint, boundary.sequence) });
    const events = resumed.checkpoint.aggregate.events.filter((event) => event.type === "run.completed" || event.type === "turn.completed" || (event.type === "projection.published" && event.projection.kind === "final"));
    assert.deepEqual(events.map((event) => event.type), ["run.completed", "projection.published", "turn.completed"]);
    assert.equal(resumed.settlement.outcome.resultKind, "error");
    const again = await runProductionPlanScenario(async () => { throw new Error("already closed"); }, async () => { throw new Error("already closed"); }, { initialCheckpoint: resumed.checkpoint });
    assert.equal(again.checkpoint.revision, resumed.checkpoint.revision);
  }
});

test("Plan discards a late valid provider submission after user cancellation", async () => {
  let stop;
  const effects = [];
  const result = await runProductionPlanScenario(async () => {
    stop.abort("user stopped");
    return planProviderReply("late-submit", "submit_runtime_v2_work_plan", simplePlanSubmission());
  }, async (name, args) => { effects.push(name); return planFixtureTool(name, args); }, { onAbortCtrl: (controller) => { stop = controller; } });
  assert.equal(result.settlement.outcome.status, "aborted");
  assert.equal(result.checkpoint.aggregate.terminalOutcome.resultKind, "canceled");
  assert.equal(result.checkpoint.aggregate.sealedWorkPlan, null);
  assert.equal(effects.includes("write_file"), false);
});

test("Plan context pressure preserves the objective and complete tool groups", () => {
  const { boundReadOnlyHistory } = loadTs(path.join(workspaceRoot, "src/store/runtimeV2/readOnlyHistory.ts"));
  const toolCall = (id) => ({ id, type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: id }) } });
  const messages = [
    { role: "system", content: "Plan remains read-only." },
    { role: "user", content: "Preserve this exact user objective." },
    { role: "assistant", content: "", tool_calls: [toolCall("old-a"), toolCall("old-b")] },
    { role: "tool", tool_call_id: "old-a", content: "old alpha source\n".repeat(2000) },
    { role: "tool", tool_call_id: "old-b", content: "old beta source\n".repeat(2000) },
    { role: "assistant", content: "", tool_calls: [toolCall("latest")] },
    { role: "tool", tool_call_id: "latest", content: "Latest receipt and exact validation feedback." },
    { role: "system", content: "Submit one complete WorkPlan with the admitted criterion IDs." },
  ];
  const bounded = boundReadOnlyHistory(messages, { contextLimit: 4096, reservedOutputTokens: 1024, preserveUserMessages: true });
  assert.equal(bounded.find((message) => message.role === "user").content, messages[1].content);
  assert.equal(bounded[0].content, messages[0].content);
  assert.equal(bounded.at(-1).content, messages.at(-1).content);
  assert.deepEqual(bounded.filter((message) => message.role === "tool").map((message) => message.tool_call_id), ["latest"]);
  assert.deepEqual(bounded.filter((message) => message.tool_calls).flatMap((message) => message.tool_calls.map((call) => call.id)), ["latest"]);
  assert.equal(messages.length, 8, "context projection must not mutate the canonical transcript");
});

test("Plan compact recovery alternates the actual wire contract and restores that choice", async () => {
  const attempts = [];
  const result = await runProductionPlanScenario(async (_messages, _settings, _callbacks, _signal, tools, _budget, options) => {
    attempts.push({ tools: tools.map((tool) => tool.function.name), responseFormat: options.responseFormat });
    if (attempts.length <= 2) throw new Error("ECONNRESET: fixture transport interrupted");
    assert.deepEqual(attempts[2].tools, ["read_file", "submit_runtime_v2_work_plan"]);
    assert.equal(attempts[2].responseFormat, undefined);
    return planProviderReply("native-recovery", "submit_runtime_v2_work_plan", simplePlanSubmission());
  }, planFixtureTool);
  assert.equal(attempts.length, 3);
  assert.deepEqual(attempts[1].tools, []);
  assert.equal(attempts[1].responseFormat?.type, "json_schema");
  assert.equal(result.checkpoint.aggregate.phase, "reviewing");
  const fallback = result.logs.find((entry) => entry.eventName === "runtime_v2_plan_provider_transport_fallback");
  assert.equal(fallback.data.from, "structured_response");
  assert.equal(fallback.data.to, "native_tool");
  const failures = result.checkpoint.aggregate.events.filter((event) => event.type === "command.completed" && event.status === "failed");
  const prefix = checkpointThrough(result.checkpoint, failures.at(-1).sequence);
  let resumedRequests = 0;
  const restored = await runProductionPlanScenario(async (_messages, _settings, _callbacks, _signal, tools, budget, options) => {
    resumedRequests += 1;
    assert.deepEqual(tools.map((tool) => tool.function.name), ["read_file", "submit_runtime_v2_work_plan"]);
    assert.equal(options.responseFormat, undefined);
    assert.equal(budget, planProtocol.PLAN_SYNTHESIS_RECOVERY_MAX_TOKENS);
    return planProviderReply("restored-native-recovery", "submit_runtime_v2_work_plan", simplePlanSubmission());
  }, planFixtureTool, { initialCheckpoint: prefix });
  assert.equal(resumedRequests, 1);
  assert.equal(restored.checkpoint.aggregate.phase, "reviewing");
});

for (const fallback of ["valid_plan", "repetition", "no_action"]) test(`typed Plan repair sends the repetition fallback on the wire and handles ${fallback}`, async () => {
  const initial = planningCheckpointWithTypedSubmissionRejection({ emptyBody: true });
  const attempts = [];
  const exhausted = fallback !== "valid_plan";
  const repeated = () => Object.assign(new Error("STREAM_VISIBLE_TEXT_REPETITION: repeated output"), { code: "STREAM_VISIBLE_TEXT_REPETITION" });
  const result = await runProductionPlanScenario(async (_messages, _settings, _callbacks, _signal, tools, _tokens, options) => {
    attempts.push({ tools: tools.map((tool) => tool.function.name), format: options.responseFormat });
    if (attempts.length > 2) throw new runtime.RuntimeV2ProviderTransportsUnavailableError();
    if (attempts.length === 1 || fallback === "repetition") throw repeated();
    return { content: exhausted ? "No valid action." : JSON.stringify(simplePlanSubmission()), toolCalls: [], usage: {} };
  }, planFixtureTool, { initialCheckpoint: initial.checkpoint });
  assert.equal(attempts.length, 2);
  assert.ok(attempts[0].tools.includes("read_file"));
  assert.deepEqual(attempts[1].tools, []);
  assert.equal(attempts[1].format?.type, "json_schema");
  const events = result.checkpoint.aggregate.events;
  const failures = events.filter((event) => event.type === "command.completed" &&
    event.failureReasonCode === "STREAM_VISIBLE_TEXT_REPETITION");
  assert.equal(failures.length, fallback === "repetition" ? 2 : 1);
  assert.equal(result.checkpoint.aggregate.phase, exhausted ? "completed" : "reviewing");
  if (exhausted) {
    assert.equal(result.settlement.outcome.resultKind, "error");
    assert.equal(events.filter((event) => event.type === "run.completed").length, 1);
    assert.equal(events.filter((event) => event.type === "turn.completed").length, 1);
    assert.equal(events.filter((event) => event.type === "projection.published" && event.audience === "final").length, 1);
    assert.equal(result.savedDocuments.length, 0);
  }
  let restoredRequests = 0;
  const restored = await runProductionPlanScenario(async (_messages, _settings, _callbacks, _signal, tools, _tokens, options) => {
    restoredRequests++;
    assert.deepEqual(tools, []);
    assert.equal(options.responseFormat?.type, "json_schema");
    return { content: JSON.stringify(simplePlanSubmission()), toolCalls: [], usage: {} };
  }, planFixtureTool, { initialCheckpoint: checkpointThrough(result.checkpoint,
    fallback === "no_action" ? events.findLast(event => event.type === "provider.responded").sequence : failures.at(-1).sequence) });
  assert.equal(restoredRequests, exhausted ? 0 : 1);
  assert.equal(restored.checkpoint.aggregate.phase, exhausted ? "completed" : "reviewing");
  if (!exhausted) {
    const scheduled = events.find(event => event.type === "command.scheduled" && event.command.payload.planRepetitionFallback);
    const interrupted = await runProductionPlanScenario(async (_messages, _settings, _callbacks, _signal, tools, _tokens, options) => {
      assert.deepEqual(tools, []);
      assert.equal(options.responseFormat?.type, "json_schema");
      return { content: JSON.stringify(simplePlanSubmission()), toolCalls: [], usage: {} };
    }, planFixtureTool, { initialCheckpoint: checkpointThrough(result.checkpoint, scheduled.sequence) });
    assert.equal(interrupted.checkpoint.aggregate.phase, "reviewing");
    assert.equal(interrupted.checkpoint.aggregate.events.filter(event => event.type === "work_plan.sealed").length, 1);
  }
});

test("Plan cold history never attaches a future receipt to an interrupted reused call ID", () => {
  const { restorePlanHistory } = loadTs(path.join(workspaceRoot, "src/store/runtimeV2/planHistory.ts"));
  const reply = (path) => ({ visibleText: "", toolCalls: [{ id: "reused", name: "read_file", arguments: { path } }], diagnostics: [], usage: {} });
  const messages = [];
  restorePlanHistory({ run, messages, evidence: [], evidenceContents: new Map(), aggregate: { events: [
    event(0, 100, { type: "provider.responded", run, idempotencyKey: "interrupted-request", result: reply("src/interrupted.js") }),
    event(1, 101, { type: "provider.responded", run, idempotencyKey: "resumed-request", result: reply("src/resumed.js") }),
    event(2, 102, { type: "command.scheduled", run, command: { kind: "execute_tool", idempotencyKey: "resumed-tool", payload: { toolCallId: "reused" } } }),
    event(3, 103, { type: "tool.completed", run, idempotencyKey: "resumed-tool", status: "succeeded", evidence: [], modelContent: "The resumed file's actual source." }),
  ] } });
  const tools = messages.filter((message) => message.role === "tool");
  assert.equal(tools.length, 2);
  assert.equal(JSON.parse(tools[0].content).historicalContentUnavailable, true);
  assert.equal(tools[1].content, "The resumed file's actual source.");
});


test("a focused approved-Plan revision advertises exact reads and synthesis without workspace discovery", async () => {
  const requests = [];
  const logs = [];
  const port = loadTsWithMocks(path.join(workspaceRoot, "src/store/runtimeV2/planProviderPort.ts"), new Map([
    ["../../lib/streaming", {
      isStreamOutputLimited,
      streamChatCompletion: async (...args) => {
        requests.push(args[4].map(tool => tool.function.name));
        return { content: "", toolCalls: [], usage: {}, finishReason: "stop" };
      },
    }],
    ["../../lib/modelLaneCoordinator", { acquireModelLane: async () => ({ markFirstToken() {}, reportFailure() {}, release() {}, setPressureHandler() {} }) }],
    ["../../lib/providerLaneSettings", {
      deriveBudgetedStreamSettings: () => ({}),
      deriveProviderAdapterCapabilities: () => ({ nativeToolRoundTrip: true, reasoningToggle: false }),
    }],
  ]));
  for (const focusedRevision of [true, false]) await port.requestPlanModel({
    get: () => ({ config: {} }),
    context: { abortCtrl: new AbortController(), phaseLanguage: "en", runWorkspace: "/fixture", runSessionKey: run.sessionKey },
    ledger: {
      snapshot: () => ({ objective: { text: "Revise the reviewed plan" }, evidence: [] }),
      schedule: async () => ({ idempotencyKey: "revision-request" }),
      settleCommand: async () => {},
    },
    run, messages: [{ role: "user", content: "Review the changed source." }],
    deadlineAt: Date.now() + 30_000, stage: "synthesis", evidence: [], evidenceContents: new Map(),
    collaboration: { collaborationAllowed: true, remainingSubagentCapacity: 1 },
    submissionRepairPending: false, focusedRevision,
    logStoreEvent: (name, data) => logs.push({ name, data }),
  });
  assert.deepEqual(requests[0], ["read_file", "spawn_subagent", "submit_runtime_v2_work_plan"]);
  assert.ok(requests[1].includes("glob_search") && requests[1].includes("grep_search"));
  assert.equal(logs.find(item => item.name === "runtime_v2_plan_provider_request_opened").data.reasoningOnlyTimeoutMs, 60_000);
});

test("Plan distinguishes client output guards from real provider length without accepting an incomplete response", async () => {
  for (const cause of ["reasoning_char_limit", "action_char_limit", "provider_length", "stop"]) {
    const logs = [];
    const settlements = [];
    const readTool = {
      type: "function",
      function: { name: "read_file", description: "Read source", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
    };
    const isClientStop = cause.endsWith("char_limit");
    const port = loadTsWithMocks(path.join(workspaceRoot, "src/store/runtimeV2/planProviderPort.ts"), new Map([
      ["../../lib/streaming", {
        isStreamOutputLimited,
        streamChatCompletion: async () => ({
          content: "An unfinished planning draft.", semanticContent: "An unfinished planning draft.",
          toolCalls: [], usage: {}, protocolViolation: null,
          finishReason: isClientStop ? null : cause === "provider_length" ? "length" : "stop",
          ...(isClientStop ? { clientStopReason: cause } : {}),
        }),
      }],
      ["../../lib/modelLaneCoordinator", { acquireModelLane: async () => ({ markFirstToken() {}, reportFailure() {}, release() {}, setPressureHandler() {} }) }],
      ["../../lib/providerLaneSettings", {
        deriveBudgetedStreamSettings: () => ({}),
        deriveProviderAdapterCapabilities: () => ({ nativeToolRoundTrip: true, reasoningToggle: false }),
      }],
      ["./planModelProtocol", { ...planProtocol, planModelTools: () => [readTool], selectPlanModelTools: () => [readTool] }],
    ]));
    const result = await port.requestPlanModel({
      get: () => ({ config: {} }),
      context: { abortCtrl: new AbortController(), phaseLanguage: "en", runWorkspace: "/fixture" },
      ledger: {
        snapshot: () => ({ objective: { text: "Inspect before planning" }, evidence: [] }),
        schedule: async () => ({ idempotencyKey: "plan-limited" }),
        settleCommand: async (event) => { settlements.push(event); },
      },
      run, messages: [{ role: "user", content: "Inspect source before planning." }],
      deadlineAt: Date.now() + 30_000, stage: "discovery", evidence: [], evidenceContents: new Map(), collaboration: {}, submissionRepairPending: false,
      logStoreEvent: (eventName, data) => logs.push({ eventName, data }),
    });
    const diagnostic = result.diagnostics.find((item) => item.code === "output_truncated");
    assert.equal(!!diagnostic, cause !== "stop", cause);
    assert.deepEqual(result.toolCalls, []);
    assert.deepEqual(settlements.at(-1).result.diagnostics, result.diagnostics);
    const shape = logs.find((entry) => entry.eventName === "runtime_v2_plan_provider_response_shape").data;
    assert.equal(shape.finishReason, isClientStop ? null : cause === "provider_length" ? "length" : "stop");
    assert.equal(shape.clientStopReason, isClientStop ? cause : null);
    assert.equal(shape.stopSource, isClientStop ? "client_guard" : cause === "provider_length" ? "provider" : null);
    if (isClientStop) assert.match(diagnostic.message, new RegExp(cause));
  }
});

test("Plan knowledge reads use only canonical selected versions, retain bounded JSON and create no workspace source lease", async () => {
  const reference = { kind: "source", kbId: "kb-plan", sourceId: "design", sourceRevision: "rev-original" };
  const hit = { text: "A confirmed external design constraint.", citation: { kbId: "kb-plan", sourceId: "design", sourceRevision: "rev-original", chunkId: "constraint" } };
  const output = JSON.stringify({ hits: [hit] });
  const calls = [], settlements = [], messages = [];
  const port = loadTsWithMocks(path.join(workspaceRoot, "src/store/runtimeV2/planEvidencePort.ts"), new Map([
    ["../../lib/toolExecutor", { executeTool: async (...args) => { calls.push(args); return output; } }],
  ]));
  const context = { runWorkspace: "/fixture", runSessionKey: "plan-knowledge", runtimeContextBudget: { readWindowChars: 2000 }, knowledgeContext: { state: "retrieved", references: [{ ...reference, sourceRevision: "live-changed" }] } };
  const canonical = { knowledgeContext: { state: "retrieved", references: [reference] }, objective: {} };
  const input = { context, ledger: { snapshot: () => canonical, schedule: async () => ({ idempotencyKey: "knowledge-read" }), settleCommand: async event => settlements.push(event), recordSoftSignal: async () => {} },
    run, call: { id: "knowledge", name: "knowledge_search", arguments: { query: "constraint" } }, messages, evidence: [], evidenceContents: new Map(), parallelReadCount: 1, logStoreEvent() {} };
  await port.executeReadOnlyPlanTool(input);
  assert.deepEqual(calls[0][4].knowledgeReferences, [reference]);
  assert.equal(settlements[0].status, "succeeded");
  assert.ok(settlements[0].evidence.every(item => item.kind === "tool"));
  assert.deepEqual(JSON.parse(messages[0].content.slice(messages[0].content.indexOf("\n") + 1)), { hits: [hit] });
  for (const packet of [undefined, { state: "no_hits", references: [] }, { state: "stale", references: [reference] }]) {
    calls.length = 0; settlements.length = 0;
    canonical.knowledgeContext = packet;
    await port.executeReadOnlyPlanTool(input);
    assert.equal(calls.length, 0);
    assert.equal(settlements[0].status, "blocked");
  }
});


test("production Plan preserves a multiline objective while saving a valid single-line document title", async () => {
  const objective = [
    "请为 CSV creatorName 数据链路生成可审批的整改计划，保持原始目标和用户限定范围。",
    "主体负责整合已确认的调查事实，并保留独立审批后才允许实际修改的边界。",
    "1. 检查 CSV 字段映射，保留现有中文字段及消费契约。",
    "2. 明确图表消费端和订单类型需要的 creatorName，不扩大写入范围。",
    "3. 仅修复 src/main.js，所有已采用的证据必须使用真实 evidence ID。",
    "4. 验收使用原有 npm run build，不提前执行命令或修改业务源码。",
    "输出必须保留上述每行约束，不能为了文档标题而缩减原始 objective。",
  ].join("\n");
  let round = 0;
  const toolCalls = [];
  const result = await runProductionPlanScenario(async () => {
    round += 1;
    return { content: "", toolCalls: [{ id: `multiline-objective-${round}`,
      name: round === 1 ? "read_file" : "submit_runtime_v2_work_plan",
      arguments: JSON.stringify(round === 1 ? { path: "src/main.js" } : {
        planMarkdown: "修复已调查的字段映射，保留中文字段和消费契约，并在独立批准后验证。",
        changes: [{ title: "修复字段映射", operation: "modify", targets: ["src/main.js"], basis: ["E2"],
          change: "最小修复 creatorName 映射，保留原有输入与消费契约。", expectedOutcome: "字段映射符合现有消费契约。", dependsOn: [], criterionIds: ["criterion-user-objective"] }],
        validations: [{ kind: "finite_command", command: "npm run build", expectedOutcome: "构建通过。", required: true, stepIndexes: [0], criterionIds: ["criterion-user-objective"] }],
      }) }], usage: {}, protocolViolation: null };
  }, async (name) => {
    toolCalls.push(name);
    if (name === "get_project_skeleton") return "src/main.js";
    if (name === "read_file") return "export const creatorName = row.creator || row['创建者'] || '';\n";
    throw new Error(`unexpected tool ${name}`);
  }, { userPrompt: objective });
  assert.equal(round, 2);
  assert.equal(result.checkpoint.aggregate.phase, "reviewing");
  assert.equal(result.settlement.outcome.status, "paused");
  const resolved = adapter.resolveRuntimeV2PlanReviewFromAggregate(result.checkpoint.aggregate);
  assert.equal(resolved?.pending, true);
  const saved = result.savedDocuments[0];
  const ref = resolved.commit.artifact.documentRef;
  assert.equal(saved.title, objective.replace(/\s+/g, " ").trim());
  assert.doesNotMatch(saved.title, /[\u0000\r\n]/);
  assert.equal(resolved.plan.draft.objective, objective);
  assert.ok(resolved.plan.markdown.includes("修复已调查的字段映射，保留中文字段和消费契约，并在独立批准后验证。"));
  assert.equal(saved.markdown, resolved.plan.markdown);
  assert.equal(ref.contentHash, createHash("sha256").update(saved.markdown).digest("hex"));
  assert.deepEqual(ref.owner, { workspace: turn.workspaceKey, sessionKey: turn.sessionKey, sessionEpoch: turn.sessionEpoch, turnId: turn.turnId });
  assert.deepEqual(result.state.activeActionRequest.documentRef, ref);
  assert.equal(adapter.validateSealedWorkPlanV1Integrity(resolved.plan).ok, true);
  const { normalizePlanDocumentRef } = loadTs(path.join(workspaceRoot, "src/lib/planDocuments.ts"));
  assert.deepEqual(normalizePlanDocumentRef(ref), ref);
  assert.equal(normalizePlanDocumentRef({ ...ref, title: objective }), null, "the strict ref reader still rejects multiline titles");
  assert.equal(result.checkpoint.aggregate.events.some(event => event.type === "work_plan.approved"), false);
  assert.equal(toolCalls.some(name => ["write_file", "replace_in_file", "run_command"].includes(name)), false);
  const persisted = runtime.serializeRuntimeV2CheckpointMap({ [turn.turnId]: result.checkpoint })[turn.turnId];
  const restored = runtime.normalizeRuntimeV2Checkpoint(JSON.parse(JSON.stringify(persisted)), turn);
  assert.deepEqual(restored.aggregate.sealedWorkPlan, resolved.plan);
  assert.deepEqual(restored.aggregate.planReviewCommit.artifact.documentRef, ref);
});
