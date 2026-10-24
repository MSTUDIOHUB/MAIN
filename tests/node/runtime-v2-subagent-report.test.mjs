import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import ts from "typescript";

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

test("ambiguous, unversioned and inherited-only paths keep the exact id channel", () => {
  const first = { ...evidence[0], target: "src/main.js" };
  const second = { ...evidence[1], target: "src/main.js" };
  assert.throws(() => reportApi.compileRuntimeV2SubagentTextReport({
    summary: "Confirmed src/main.js.", evidence: [first, second], sourceEvidence: [first, second],
  }), /finding_incomplete/);
  const report = reportApi.compileRuntimeV2SubagentTextReport({
    summary: `Confirmed src/main.js (${first.id}).`, evidence: [first, second], sourceEvidence: [first, second],
  });
  assert.deepEqual(report.findings[0].evidenceIds, [first.id]);
  const unversioned = { ...first, version: null };
  assert.throws(() => reportApi.compileRuntimeV2SubagentTextReport({
    summary: "Confirmed src/main.js.", evidence: [unversioned], sourceEvidence: [unversioned],
  }), /finding_incomplete/);
  const inherited = { ...first, kind: "source" };
  assert.throws(() => reportApi.compileRuntimeV2SubagentTextReport({
    summary: "Confirmed src/main.js.", evidence: [], inheritedEvidence: [inherited],
  }), /finding_incomplete/, "kind=source alone does not establish read_file origin");
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
