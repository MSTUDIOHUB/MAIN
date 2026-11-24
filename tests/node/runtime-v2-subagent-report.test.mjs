import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";

const workspaceRoot = process.cwd();
const moduleCache = new Map();
const ipcStub = {
  shellPermissionPreflight: async () => {
    throw new Error("Unexpected preflight");
  },
};

function loadWorkspaceTs(sourcePath) {
  const normalizedPath = path.resolve(sourcePath);
  if (normalizedPath === path.join(workspaceRoot, "src/lib/ipc.ts")) {
    return ipcStub;
  }
  if (moduleCache.has(normalizedPath)) return moduleCache.get(normalizedPath);
  const module = { exports: {} };
  moduleCache.set(normalizedPath, module.exports);
  const output = ts.transpileModule(fs.readFileSync(normalizedPath, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
    fileName: normalizedPath,
  }).outputText;
  const localRequire = createRequire(normalizedPath);
  new Function("exports", "module", "require", output)(
    module.exports,
    module,
    (specifier) => {
      if (specifier.startsWith(".")) {
        const basePath = path.resolve(path.dirname(normalizedPath), specifier);
        for (const candidate of [
          basePath,
          `${basePath}.ts`,
          `${basePath}.tsx`,
          path.join(basePath, "index.ts"),
        ]) {
          if (/\.tsx?$/.test(candidate) && fs.existsSync(candidate)) {
            return loadWorkspaceTs(candidate);
          }
        }
      }
      return localRequire(specifier);
    },
  );
  moduleCache.set(normalizedPath, module.exports);
  return module.exports;
}

function loadTs(relativePath, mocks = {}) {
  const source = fs.readFileSync(new URL(`../../${relativePath}`, import.meta.url), "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const module = { exports: {} };
  new Function("exports", "module", "require", output)(module.exports, module, (specifier) => {
    if (Object.hasOwn(mocks, specifier)) return mocks[specifier];
    throw new Error(`Unexpected runtime dependency: ${specifier}`);
  });
  return module.exports;
}

const reportApi = loadTs("src/lib/runtime-v2/subagentReport.ts");
const handoffApi = loadTs("src/lib/runtime-v2/subagentHandoff.ts", { "./subagentReport": reportApi });
const subagentApi = loadTs("src/lib/runtime-v2/subagents.ts");
const evidence = Array.from({ length: 35 }, (_, index) => ({
  id: `child:source:E${index + 1}`,
  kind: "subagent",
  target: `Documentation/source-${index + 1}.md`,
  version: `observed-${index + 1}`,
}));

test("ordinary child reports preserve the complete final and every cited receipt", () => {
  const summary = [
    "Project category one. ".repeat(220),
    ...evidence.map((item) => `${item.target}: confirmed (${item.id}).`),
    "TAIL: this is still a prototype, not a released product.",
  ].join("\n");
  const report = reportApi.compileRuntimeV2SubagentTextReport({ summary, evidence });
  assert.equal(report.summary, summary);
  assert.equal(report.findings[0].statement, summary);
  assert.deepEqual(report.findings[0].evidenceIds, evidence.map((item) => item.id));
  assert.equal(reportApi.validateRuntimeV2SubagentReport({ report, evidence }), true);
});

test("structured reports preserve long statements, all findings and unresolved items", () => {
  const draft = {
    summary: "summary ".repeat(650).trim(),
    findings: evidence.map((item) => ({
      statement: `${item.target}: ${"finding ".repeat(350)}`.trim(),
      evidence_ids: evidence.map((source) => source.id),
    })),
    unresolved: evidence.map((item) => `${item.target}: ${"uncertainty ".repeat(130)}`.trim()),
  };
  const report = reportApi.compileRuntimeV2SubagentReport({ draft, evidence });
  assert.equal(report.summary, draft.summary);
  assert.deepEqual(report.findings, draft.findings.map((finding) => ({
    statement: finding.statement, evidenceIds: finding.evidence_ids,
  })));
  assert.deepEqual(report.unresolved, draft.unresolved);
  assert.equal(reportApi.validateRuntimeV2SubagentReport({ report, evidence }), true);
});

test("report validation ignores persisted object key order while rejecting noncanonical content and extra fields", () => {
  const report = reportApi.compileRuntimeV2SubagentTextReport({
    summary: `Confirmed (${evidence[0].id}).`, evidence,
  });
  const sorted = JSON.parse(JSON.stringify(report), (_key, value) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left < right ? -1 : 1))
      : value
  );
  assert.deepEqual(Object.keys(sorted), ["findings", "schemaVersion", "summary", "unresolved"]);
  assert.deepEqual(Object.keys(sorted.findings[0]), ["evidenceIds", "statement"]);
  assert.equal(reportApi.validateRuntimeV2SubagentReport({ report: sorted, evidence }), true);
  for (const invalid of [
    { ...sorted, unexpected: true },
    { ...sorted, unexpected: undefined },
    { ...sorted, findings: [{ ...sorted.findings[0], unexpected: true }] },
    { ...sorted, findings: [{ ...sorted.findings[0], evidenceIds: ["invented-id"] }] },
    { ...sorted, findings: [{ ...sorted.findings[0], evidenceIds: [evidence[0].id, evidence[0].id] }] },
    { ...sorted, unresolved: new Array(1) },
    { ...sorted, summary: ` ${sorted.summary}` },
  ]) assert.equal(reportApi.validateRuntimeV2SubagentReport({ report: invalid, evidence }), false);
});

test("invalid evidence and findings beyond the former array cutoffs are rejected", () => {
  assert.throws(() => reportApi.compileRuntimeV2SubagentReport({
    evidence,
    draft: {
      summary: "No unknown citation may disappear during compilation.",
      findings: [{ statement: "finding", evidence_ids: [
        ...evidence.slice(0, 24).map((item) => item.id), "invented-id",
      ] }],
      unresolved: [],
    },
  }), /evidence_unknown/);
  assert.throws(() => reportApi.compileRuntimeV2SubagentReport({
    evidence,
    draft: {
      summary: "No invalid finding may disappear during compilation.",
      findings: [
        ...evidence.slice(0, 32).map((item) => ({ statement: "finding", evidence_ids: [item.id] })),
        { statement: "invalid tail", evidence_ids: ["invented-id"] },
      ],
      unresolved: [],
    },
  }), /evidence_unknown/);
});

test("ordinary final paths bind only to exact, unambiguous observed source receipts", () => {
  const sources = [
    { ...evidence[0], target: "ArtSource/无主之誓/素材说明.md" },
    { ...evidence[1], target: "Documentation/design notes.md" },
    ...evidence.slice(2, 5),
  ];
  const summary = sources.map((item) => `Confirmed from \`${item.target}\`.`).join("\n");
  const report = reportApi.compileRuntimeV2SubagentTextReport({
    summary, evidence: sources, sourceEvidence: sources,
  });
  assert.deepEqual(report.findings[0].evidenceIds, sources.map((item) => item.id));
  assert.equal(report.summary, summary);
  assert.equal(reportApi.validateRuntimeV2SubagentReport({ report, evidence: sources }), true);
});

test("path citations do not match basenames, larger paths, extensions or unobserved sources", () => {
  const source = { ...evidence[0], target: "src/main.js" };
  for (const summary of [
    "Confirmed main.js.",
    "Confirmed archive/src/main.js.",
    "Confirmed $src/main.js.",
    "Confirmed 🚀src/main.js.",
    "Confirmed src/main.js$.",
    "Confirmed src/main.js🚀.",
    "Confirmed 中文src/main.js.",
    "Confirmed src/main.js.map.",
    "Confirmed src/main.js/child.",
    "Confirmed src.",
    "Confirmed src/unread.js.",
  ]) {
    assert.throws(() => reportApi.compileRuntimeV2SubagentTextReport({
      summary, evidence: [source], sourceEvidence: [source],
    }), /finding_incomplete/, summary);
  }
  assert.throws(() => reportApi.compileRuntimeV2SubagentTextReport({
    summary: "Confirmed src/main.js.", evidence: [source],
  }), /finding_incomplete/, "a generic observation is not proof of source origin");
  assert.throws(() => reportApi.compileRuntimeV2SubagentTextReport({
    summary: "Confirmed src/unread.js.", evidence: [source],
    sourceEvidence: [{ ...source, target: "src/unread.js" }],
  }), /finding_incomplete/, "a caller cannot change the target of an existing id");
});

test("path citations use explicit text and Markdown delimiters while preserving terminal punctuation", () => {
  const source = { ...evidence[0], target: "src/main.js" };
  for (const summary of [
    "Confirmed src/main.js.",
    "Confirmed src/main.js, with the relevant observation.",
    "Confirmed src/main.js。",
    "Confirmed src/main.js!",
    "Confirmed `src/main.js`.",
    "Confirmed \"src/main.js\".",
    "Confirmed “src/main.js”。",
    "Confirmed (src/main.js).",
    "Confirmed 【src/main.js】。",
    "Confirmed [source](src/main.js).",
    "Confirmed <src/main.js>.",
    "来源：src/main.js。",
    "来源：src/main.js，结论仍由父代理核对。",
  ]) {
    const report = reportApi.compileRuntimeV2SubagentTextReport({
      summary, evidence: [source], sourceEvidence: [source],
    });
    assert.deepEqual(report.findings[0].evidenceIds, [source.id], summary);
  }
});

test("unversioned, mixed-unversioned and inherited-only paths keep the exact id channel", () => {
  const first = { ...evidence[0], target: "src/main.js" };
  const unversioned = { ...evidence[1], target: "src/main.js", version: null };
  assert.throws(() => reportApi.compileRuntimeV2SubagentTextReport({
    summary: "Confirmed src/main.js.", evidence: [first, unversioned], sourceEvidence: [first, unversioned],
  }), /RUNTIME_V2_SUBAGENT_REPORT_INVALID:finding_incomplete:0/);
  const report = reportApi.compileRuntimeV2SubagentTextReport({
    summary: `Confirmed src/main.js (${first.id}).`, evidence: [first, unversioned], sourceEvidence: [first, unversioned],
  });
  assert.deepEqual(report.findings[0].evidenceIds, [first.id]);
  assert.throws(() => reportApi.compileRuntimeV2SubagentTextReport({
    summary: "Confirmed src/main.js.", evidence: [unversioned], sourceEvidence: [unversioned],
  }), /RUNTIME_V2_SUBAGENT_REPORT_INVALID:finding_incomplete:0/);
  const inherited = { ...first, kind: "source" };
  assert.throws(() => reportApi.compileRuntimeV2SubagentTextReport({
    summary: "Confirmed src/main.js.", evidence: [], inheritedEvidence: [inherited],
  }), /RUNTIME_V2_SUBAGENT_REPORT_INVALID:finding_incomplete:0/, "kind=source alone does not establish read_file origin");
  const inheritedReport = reportApi.compileRuntimeV2SubagentTextReport({
    summary: `Confirmed (${inherited.id}).`, evidence: [], inheritedEvidence: [inherited],
  });
  assert.deepEqual(inheritedReport.findings[0].evidenceIds, [inherited.id]);
});

test("path compilation delivers real ids but parent adoption still requires explicit use", () => {
  const source = evidence[0];
  const report = reportApi.compileRuntimeV2SubagentTextReport({
    summary: `Confirmed from ${source.target}.`, evidence: [source], sourceEvidence: [source],
  });
  const providerEvent = (visibleText) => ({
    type: "provider.responded",
    result: { visibleText, commentary: [], toolCalls: [] },
  });
  assert.deepEqual(handoffApi.referencedRuntimeV2SubagentEvidenceIds({
    sourceEvent: providerEvent(report.summary), evidenceIds: [source.id],
  }), []);
  assert.deepEqual(handoffApi.referencedRuntimeV2SubagentEvidenceIds({
    sourceEvent: providerEvent(`I rely on (${source.id}).`), evidenceIds: [source.id],
  }), [source.id]);
});

test("child takeover wording describes evidence and ownership without report protocol details", () => {
  for (const sourceEvidence of [[], evidence.slice(0, 1)]) {
    const summary = subagentApi.runtimeV2SubagentFailureSummary({
      canceled: false, deadlineExceeded: false, evidence: sourceEvidence,
    });
    assert.doesNotMatch(summary, /结构化报告/);
    assert.match(summary, /带来源的可核验结论/);
    if (sourceEvidence.length) assert.match(summary, /主体接管/);
    else assert.match(summary, /没有形成可交接的证据/);
  }
});

test("parent adoption accepts sentence punctuation but never an extended evidence id", () => {
  const id = "child:source:E1";
  const referenced = (visibleText) => handoffApi.referencedRuntimeV2SubagentEvidenceIds({
    sourceEvent: {
      type: "provider.responded", result: { visibleText, commentary: [], toolCalls: [] },
    },
    evidenceIds: [id],
  });
  assert.deepEqual(referenced(`I rely on ${id}.`), [id]);
  assert.deepEqual(referenced(`I rely on “${id}”.`), [id]);
  for (const longer of [`${id}0`, `${id}.other`, `${id}/other`, `${id}-other`]) {
    assert.deepEqual(referenced(`I rely on ${longer}.`), [], longer);
  }
});

test("handoff delivers every real receipt beyond sixty-four without permitting invented ids", () => {
  const ids = Array.from({ length: 70 }, (_, index) => `child:many:E${index + 1}`);
  const completion = {
    type: "subagent.completed", jobId: "child-many",
    evidence: ids.map((id) => ({ id, kind: "subagent", target: "src/main.js", version: "v1" })),
  };
  const state = { subagents: [{ id: "child-many" }], events: [completion] };
  const delivery = {
    type: "subagent.handoff_delivered", jobId: "child-many",
    contextEntryId: "child:child-many", evidenceIds: ids,
  };
  assert.equal(handoffApi.isValidRuntimeV2SubagentHandoffDelivery({ state, event: delivery }), true);
  assert.equal(handoffApi.isValidRuntimeV2SubagentHandoffDelivery({
    state, event: { ...delivery, evidenceIds: [...ids, "invented-id"] },
  }), false);
});

test("handoff applies all explicitly used receipts beyond sixty-four and rejects ungrounded use", () => {
  const ids = Array.from({ length: 70 }, (_, index) => `child:many:E${index + 1}`);
  const run = { sessionKey: "session", sessionEpoch: "epoch", turnId: "turn", runId: "run", parentRunId: null, attemptId: "attempt" };
  const delivery = { type: "subagent.handoff_delivered", jobId: "child-many", evidenceIds: ids, sequence: 1 };
  const source = {
    type: "provider.responded", eventId: "parent-use", sequence: 2, run,
    result: { visibleText: ids.map((id) => `(${id})`).join(" "), commentary: [], toolCalls: [] },
  };
  const state = { run: { identity: run }, events: [delivery, source] };
  const drafts = handoffApi.runtimeV2SubagentHandoffApplicationDrafts({ state, sourceEvent: source });
  assert.equal(drafts.length, 1);
  assert.deepEqual(drafts[0].evidenceIds, ids);
  assert.equal(handoffApi.isValidRuntimeV2SubagentHandoffApplication({ state, event: drafts[0] }), true);
  assert.equal(handoffApi.isValidRuntimeV2SubagentHandoffApplication({
    state, event: { ...drafts[0], evidenceIds: [...ids, "invented-id"] },
  }), false);
  const unreferenced = { ...source, result: { ...source.result, visibleText: "Delivered sources alone do not prove use." } };
  assert.deepEqual(handoffApi.runtimeV2SubagentHandoffApplicationDrafts({ state, sourceEvent: unreferenced }), []);
});

test("multi-chunk read_file receipts attach all chunk evidence ids across line anchors and Markdown delimiters", () => {
  const chunks = [
    { id: "child:chunk:E1", kind: "subagent", target: "src/main.js", version: "chunk-hash-1" },
    { id: "child:chunk:E2", kind: "subagent", target: "src/main.js", version: "chunk-hash-2" },
    { id: "child:chunk:E3", kind: "subagent", target: "src/main.js", version: "chunk-hash-3" },
  ];
  const expectedIds = chunks.map((item) => item.id);
  for (const summary of [
    "Confirmed behavior in src/main.js.",
    "Confirmed behavior at src/main.js:42.",
    "See src/main.js:42",
    "Confirmed in src/main.js:10-20, which parses the payload.",
    "Confirmed in src/main.js#L15.",
    "Confirmed in src/main.js#L12-L34.",
    "Confirmed in **src/main.js**.",
    "Confirmed in **src/main.js:42**.",
    "| File | Status |\n| --- | --- |\n|src/main.js|verified|",
    "| File | Range |\n| --- | --- |\n| src/main.js:10-20 | ok |",
    "| File |\n| --- |\n|**src/main.js#L15**|",
  ]) {
    const report = reportApi.compileRuntimeV2SubagentTextReport({
      summary,
      evidence: chunks,
      sourceEvidence: chunks,
    });
    assert.deepEqual(report.findings[0].evidenceIds, expectedIds, summary);
    assert.equal(reportApi.validateRuntimeV2SubagentReport({ report, evidence: chunks }), true, summary);
  }

  for (const invalidSummary of [
    "Uncited summary without path or evidence id.",
    "Invalid suffix src/main.js:42foo.",
    "Invalid extension src/main.js:42.map.",
    "Incomplete range src/main.js:42-.",
    "Incomplete fragment src/main.js#L.",
    "Unknown fragment src/main.js#section.",
  ]) {
    assert.throws(() => reportApi.compileRuntimeV2SubagentTextReport({
      summary: invalidSummary,
      evidence: chunks,
      sourceEvidence: chunks,
    }), /RUNTIME_V2_SUBAGENT_REPORT_INVALID:finding_incomplete:0/, invalidSummary);
  }

  assert.throws(() => reportApi.compileRuntimeV2SubagentTextReport({
    summary: "Confirmed behavior at src/main.js:42.",
    evidence: chunks,
  }), /RUNTIME_V2_SUBAGENT_REPORT_INVALID:finding_incomplete:0/, "multi-chunk non-read_file observations cannot resolve by path");
});

function createRunnerFixture({
  taskKind = "explore",
  allowedPaths = ["src/main.js"],
  inheritedEvents = null,
} = {}) {
  const childProvider = loadWorkspaceTs(path.join(workspaceRoot, "src/store/runtimeV2/executionSubagentProvider.ts"));
  const executor = loadWorkspaceTs(path.join(workspaceRoot, "src/lib/toolExecutor.ts"));
  const { startRuntimeV2Child } = loadWorkspaceTs(path.join(workspaceRoot, "src/store/runtimeV2/executionSubagentRunner.ts"));
  const { createRuntimeV2LiveExecutionState } = loadWorkspaceTs(path.join(workspaceRoot, "src/store/runtimeV2/executionTypes.ts"));

  let idCounter = 0;
  const events = [];
  const state = {
    config: {},
    currentTurnExecutionConsent: { turnId: "turn-1", granted: true },
    autoApproveTools: false,
    autoApproveToolScopes: [],
    approvedShellPermissionRules: [],
    approvedLocalFileReadPaths: [],
    taskFlow: [],
    runtimeEvents: [],
    ...(inheritedEvents ? { runtimeV2Checkpoints: { "turn-1": inheritedEvents } } : {}),
  };
  const ports = {
    get: () => state,
    set: (value) => Object.assign(state, typeof value === "function" ? value(state) : value),
    live: createRuntimeV2LiveExecutionState(),
    context: {
      turnId: "turn-1",
      runWorkspace: "/fixture",
      runSessionKey: "/fixture:1",
      runtimeRunIntent: taskKind === "review" ? "review" : "explore",
      phaseLanguage: "en",
      approvalRequiredCapabilities: [],
      capabilityRestrictions: [],
    },
    now: () => 1_000,
    nextId: (prefix) => `${prefix}-${++idCounter}`,
    logStoreEvent: (type, payload) => {
      events.push({ type, payload });
    },
  };
  const job = {
    id: "job-repair",
    parentRunId: "run-parent",
    scopeKey: "scope-main",
    taskKind,
    accessMode: "read",
    allowedPaths,
    objective: "Inspect src/main.js and report findings.",
    run: {
      sessionKey: "/fixture:1",
      sessionEpoch: "epoch-1",
      turnId: "turn-1",
      runId: "child-run-1",
      parentRunId: "run-parent",
      attemptId: "attempt-1",
    },
  };
  return { childProvider, executor, startRuntimeV2Child, ports, job, events };
}

test("executionSubagentRunner performs 1-shot report repair after multi-chunk read_file and completes", async () => {
  const f = createRunnerFixture();
  const { runtimeV2ChildEvidenceId } = loadWorkspaceTs(path.join(workspaceRoot, "src/lib/runtime-v2/index.ts"));
  const expectedE1 = runtimeV2ChildEvidenceId(f.job, 1);
  const expectedE2 = runtimeV2ChildEvidenceId(f.job, 2);
  const originalRequest = f.childProvider.requestRuntimeV2ChildStep;
  const originalExecute = f.executor.executeTool;
  const requests = [];
  let readChunk = 0;
  f.executor.executeTool = async (name) => {
    assert.equal(name, "read_file");
    readChunk += 1;
    return `chunk-${readChunk}: function handleSaveFile() {}`;
  };
  f.childProvider.requestRuntimeV2ChildStep = async (input) => {
    requests.push(structuredClone(input.messages));
    if (requests.length === 1) {
      return {
        toolCalls: [
          { id: "call-1", name: "read_file", arguments: { path: "src/main.js", start_line: 1, end_line: 20 } },
          { id: "call-2", name: "read_file", arguments: { path: "src/main.js", start_line: 21, end_line: 40 } },
        ],
        diagnostics: [],
        visibleText: "",
      };
    }
    if (requests.length === 2) {
      return {
        toolCalls: [],
        diagnostics: [],
        visibleText: "Found save handler bug in handleSaveFile.",
      };
    }
    return {
      toolCalls: [],
      diagnostics: [],
      visibleText: "Found save handler bug in **src/main.js:10-20**.",
    };
  };

  try {
    const result = await f.startRuntimeV2Child(f.ports, f.job, new AbortController().signal);
    assert.equal(result.status, "completed");
    assert.equal(result.summary, "Found save handler bug in **src/main.js:10-20**.");
    assert.deepEqual(result.report?.findings[0]?.evidenceIds, [
      expectedE1,
      expectedE2,
    ]);
    assert.equal(requests.length, 3);
    const repairMessages = requests[2].slice(-2);
    assert.deepEqual(repairMessages[0], {
      role: "assistant",
      content: "Found save handler bug in handleSaveFile.",
    });
    assert.equal(repairMessages[1].role, "user");
    assert.match(repairMessages[1].content, /without calling new tools/i);
    assert.match(repairMessages[1].content, /src\/main\.js/);
    assert.ok(repairMessages[1].content.includes(expectedE1));
    assert.ok(repairMessages[1].content.includes(expectedE2));

    const repairEvent = f.events.find((item) => item.type === "runtime_v2_subagent_report_repair_requested");
    assert.deepEqual(repairEvent?.payload, {
      turnId: "turn-1",
      runId: "child-run-1",
      jobId: "job-repair",
      evidenceCount: 2,
      reason: "RUNTIME_V2_SUBAGENT_REPORT_INVALID:finding_incomplete:0",
    });
    assert.equal(
      f.events.some((item) => item.type === "runtime_v2_subagent_report_rejected"),
      false,
    );
  } finally {
    f.childProvider.requestRuntimeV2ChildStep = originalRequest;
    f.executor.executeTool = originalExecute;
  }
});

test("executionSubagentRunner bounds report repair to a single retry and degrades if still uncited", async () => {
  const f = createRunnerFixture();
  const originalRequest = f.childProvider.requestRuntimeV2ChildStep;
  const originalExecute = f.executor.executeTool;
  const requests = [];
  f.executor.executeTool = async () => "line 1: const ok = true;";
  f.childProvider.requestRuntimeV2ChildStep = async (input) => {
    requests.push(structuredClone(input.messages));
    if (requests.length === 1) {
      return {
        toolCalls: [{ id: "call-1", name: "read_file", arguments: { path: "src/main.js" } }],
        diagnostics: [],
        visibleText: "",
      };
    }
    return {
      toolCalls: [],
      diagnostics: [],
      visibleText: `Still uncited response #${requests.length}`,
    };
  };

  try {
    const result = await f.startRuntimeV2Child(f.ports, f.job, new AbortController().signal);
    assert.equal(result.status, "degraded");
    assert.equal(result.report, null);
    assert.equal(requests.length, 3);
    assert.equal(
      f.events.filter((item) => item.type === "runtime_v2_subagent_report_repair_requested").length,
      1,
    );
    assert.equal(
      f.events.filter((item) => item.type === "runtime_v2_subagent_report_rejected").length,
      1,
    );
  } finally {
    f.childProvider.requestRuntimeV2ChildStep = originalRequest;
    f.executor.executeTool = originalExecute;
  }
});

test("executionSubagentRunner skips empty assistant message on summary_missing and caps listed sources at 20", async () => {
  const f = createRunnerFixture({ allowedPaths: ["src"] });
  const { runtimeV2ChildEvidenceId } = loadWorkspaceTs(path.join(workspaceRoot, "src/lib/runtime-v2/index.ts"));
  const expectedE1 = runtimeV2ChildEvidenceId(f.job, 1);
  const expectedE20 = runtimeV2ChildEvidenceId(f.job, 20);
  const expectedE21 = runtimeV2ChildEvidenceId(f.job, 21);
  const expectedE22 = runtimeV2ChildEvidenceId(f.job, 22);
  const originalRequest = f.childProvider.requestRuntimeV2ChildStep;
  const originalExecute = f.executor.executeTool;
  const requests = [];
  let seq = 0;
  f.executor.executeTool = async (_name, args) => `content for ${args.path} (${++seq})`;
  f.childProvider.requestRuntimeV2ChildStep = async (input) => {
    requests.push(structuredClone(input.messages));
    if (requests.length === 1) {
      return {
        toolCalls: Array.from({ length: 22 }, (_, index) => ({
          id: `call-${index + 1}`,
          name: "read_file",
          arguments: { path: `src/file-${index + 1}.ts` },
        })),
        diagnostics: [],
        visibleText: "",
      };
    }
    if (requests.length === 2) {
      return { toolCalls: [], diagnostics: [], visibleText: "" };
    }
    return {
      toolCalls: [],
      diagnostics: [],
      visibleText: `Checked src/file-1.ts and (${expectedE22}).`,
    };
  };

  try {
    const result = await f.startRuntimeV2Child(f.ports, f.job, new AbortController().signal);
    assert.equal(result.status, "completed");
    assert.deepEqual(result.report?.findings[0]?.evidenceIds, [expectedE1, expectedE22]);
    assert.equal(requests.length, 3);
    assert.equal(
      requests[2].some((message) => message.role === "assistant" && !message.tool_calls),
      false,
      "summary_missing must not push an empty assistant text message",
    );
    assert.equal(requests[2].at(-2)?.role, "tool");
    const repairUserMessage = requests[2].at(-1);
    assert.equal(repairUserMessage.role, "user");
    assert.match(repairUserMessage.content, /Available read source paths: /);
    assert.match(repairUserMessage.content, /src\/file-20\.ts/);
    assert.doesNotMatch(repairUserMessage.content, /src\/file-21\.ts/);
    assert.ok(repairUserMessage.content.includes(expectedE20));
    assert.equal(repairUserMessage.content.includes(expectedE21), false);
  } finally {
    f.childProvider.requestRuntimeV2ChildStep = originalRequest;
    f.executor.executeTool = originalExecute;
  }
});

test("executionSubagentRunner omits read source paths on non-read_file evidence and recovers via evidence ID", async () => {
  const f = createRunnerFixture({ allowedPaths: ["src"] });
  const { runtimeV2ChildEvidenceId } = loadWorkspaceTs(path.join(workspaceRoot, "src/lib/runtime-v2/index.ts"));
  const expectedE1 = runtimeV2ChildEvidenceId(f.job, 1);
  const originalRequest = f.childProvider.requestRuntimeV2ChildStep;
  const originalExecute = f.executor.executeTool;
  const requests = [];
  f.executor.executeTool = async (name) => {
    assert.equal(name, "grep_search");
    return "src/main.js:42:handleSaveFile";
  };
  f.childProvider.requestRuntimeV2ChildStep = async (input) => {
    requests.push(structuredClone(input.messages));
    if (requests.length === 1) {
      return {
        toolCalls: [{ id: "call-grep", name: "grep_search", arguments: { query: "handleSaveFile", path: "src" } }],
        diagnostics: [],
        visibleText: "",
      };
    }
    if (requests.length === 2) {
      return {
        toolCalls: [],
        diagnostics: [],
        visibleText: "Found handleSaveFile in src/main.js.",
      };
    }
    return {
      toolCalls: [],
      diagnostics: [],
      visibleText: `Found handleSaveFile in src/main.js (${expectedE1}).`,
    };
  };

  try {
    const result = await f.startRuntimeV2Child(f.ports, f.job, new AbortController().signal);
    assert.equal(result.status, "completed");
    assert.deepEqual(result.report?.findings[0]?.evidenceIds, [expectedE1]);
    assert.equal(requests.length, 3);
    const repairUserMessage = requests[2].at(-1);
    assert.equal(repairUserMessage.role, "user");
    assert.doesNotMatch(repairUserMessage.content, /Available read source paths:/);
    assert.match(repairUserMessage.content, /Available evidence IDs:/);
    assert.ok(repairUserMessage.content.includes(expectedE1));
  } finally {
    f.childProvider.requestRuntimeV2ChildStep = originalRequest;
    f.executor.executeTool = originalExecute;
  }
});

test("executionSubagentRunner does not trigger repair retry when child has zero evidence", async () => {
  const f = createRunnerFixture();
  const originalRequest = f.childProvider.requestRuntimeV2ChildStep;
  const requests = [];
  f.childProvider.requestRuntimeV2ChildStep = async (input) => {
    requests.push(structuredClone(input.messages));
    return {
      toolCalls: [],
      diagnostics: [],
      visibleText: "Unsupported claim without reading anything.",
    };
  };

  try {
    const result = await f.startRuntimeV2Child(f.ports, f.job, new AbortController().signal);
    assert.equal(result.status, "failed");
    assert.equal(result.report, null);
    assert.equal(requests.length, 1);
    assert.equal(
      f.events.some((item) => item.type === "runtime_v2_subagent_report_repair_requested"),
      false,
    );
    assert.equal(
      f.events.some((item) => item.type === "runtime_v2_subagent_report_rejected"),
      true,
    );
  } finally {
    f.childProvider.requestRuntimeV2ChildStep = originalRequest;
  }
});

test("executionSubagentRunner handles omitted ModelLaneResourceInterruption in test mocks", async () => {
  const f = createRunnerFixture();
  const runnerPath = path.join(workspaceRoot, "src/store/runtimeV2/executionSubagentRunner.ts");
  const isolatedCache = new Map();
  const loadIsolated = (sourcePath) => {
    const normalizedPath = path.resolve(sourcePath);
    if (normalizedPath === path.join(workspaceRoot, "src/lib/ipc.ts")) return ipcStub;
    if (normalizedPath === path.join(workspaceRoot, "src/lib/modelLaneCoordinator.ts")) return {};
    if (normalizedPath === path.join(workspaceRoot, "src/store/runtimeV2/executionSubagentProvider.ts")) {
      return {
        requestRuntimeV2ChildStep: async () => {
          throw new Error("provider transport failed");
        },
      };
    }
    if (isolatedCache.has(normalizedPath)) return isolatedCache.get(normalizedPath);
    const module = { exports: {} };
    isolatedCache.set(normalizedPath, module.exports);
    const output = ts.transpileModule(fs.readFileSync(normalizedPath, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
      fileName: normalizedPath,
    }).outputText;
    const localRequire = createRequire(normalizedPath);
    new Function("exports", "module", "require", output)(
      module.exports,
      module,
      (specifier) => {
        if (specifier.startsWith(".")) {
          const basePath = path.resolve(path.dirname(normalizedPath), specifier);
          for (const candidate of [basePath, `${basePath}.ts`, `${basePath}.tsx`, path.join(basePath, "index.ts")]) {
            if (/\.tsx?$/.test(candidate) && fs.existsSync(candidate)) return loadIsolated(candidate);
          }
        }
        return localRequire(specifier);
      },
    );
    isolatedCache.set(normalizedPath, module.exports);
    return module.exports;
  };
  const { startRuntimeV2Child } = loadIsolated(runnerPath);
  const result = await startRuntimeV2Child(f.ports, f.job, new AbortController().signal);
  assert.equal(result.status, "failed");
  assert.equal(result.report, null);
});
