import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import ts from "typescript";
function loader(mocks = new Map()) {
  const cache = new Map();
  return function load(file) {
    file = path.resolve(file); if (cache.has(file)) return cache.get(file);
    const module = { exports: {} }; cache.set(file, module.exports); const native = createRequire(file);
    const requireModule = name => {
      if (mocks.has(name)) return mocks.get(name);
      if (name.startsWith(".")) {
        const base = path.resolve(path.dirname(file), name);
        for (const candidate of [base, `${base}.ts`, path.join(base, "index.ts")]) if (candidate.endsWith(".ts") && fs.existsSync(candidate)) return load(candidate);
      }
      return native(name);
    };
    new Function("exports", "module", "require", ts.transpileModule(fs.readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }, fileName: file }).outputText)(module.exports, module, requireModule);
    return module.exports;
  };
}
const markdown = "# Collector game\n\nUse the confirmed Input System.\n";
const hash = createHash("sha256").update(markdown).digest("hex");
const reference = { owner: { workspace: "/fixture", sessionKey: "/fixture:1", sessionEpoch: "epoch-1", turnId: "source-turn" }, documentId: "draft-1", revision: 1, contentHash: hash, path: "/app-data/plan-1.md", title: "Collector plan", kind: "plan" };
const draft = { schemaVersion: 1, documentRef: reference, source: { turnId: "source-turn", runId: "source-run", providerSequence: 4, toolCallId: "submit-1", candidateHash: "a".repeat(64) }, diagnostics: [{ code: "missing_required_validation", fieldPath: "validations", criterionIds: ["criterion-user-objective"], message: "Missing required validation" }] };
function harness() {
  const admissions = [];
  let state = { currentWorkspace: "/fixture", currentSessionId: 1, currentTurnId: "source-turn", isGenerating: false, agentStatus: "idle", config: { language: "zh" }, activeActionRequest: null,
    sessionsByWorkspace: { "/fixture": [{ id: 1, planLifecycleEpoch: "epoch-1" }] },
    conversationTurns: [{ id: "source-turn", userPrompt: "Build the Collector game", planDraft: draft }],
    runtimeV2Checkpoints: { "source-turn": { aggregate: { turn: { workspaceKey: "/fixture", sessionKey: "/fixture:1", sessionEpoch: "epoch-1", turnId: "source-turn" }, strategy: "plan", terminalOutcome: { resultKind: "partial" }, fixtureDraft: draft } } },
    acceptWorkspaceInstruction: async input => { admissions.push(input); return { accepted: true, receipt: { turnId: "new-turn" } }; },
  };
  const load = loader(new Map([
    ["../lib/ipc", { readPlanDocument: async () => ({ ...reference, markdown }) }],
    ["../lib/runtime-v2", { normalizeRuntimeV2Checkpoint: (checkpoint, owner) => {
      if (!checkpoint || Object.entries(owner || {}).some(([key, value]) => value !== checkpoint.aggregate.turn[key])) return null;
      return checkpoint;
    } }],
    ["../lib/planDocumentRecords", { resolvePlanDraftFromAggregate: aggregate => aggregate?.fixtureDraft || null }],
  ]));
  return { module: load("src/store/planDraftContinuation.ts"), get: () => state, set: patch => { state = { ...state, ...patch }; }, admissions };
}
test("draft completion binds a new Plan Turn to the exact saved draft without approval authority", async () => {
  const h = harness(); const result = await h.module.continuePlanDraft({ get: h.get, record: draft });
  assert.equal(result.accepted, true); assert.equal(h.admissions.length, 1);
  assert.equal(h.admissions[0].text, "Build the Collector game");
  assert.deepEqual(h.admissions[0].dispatchHints.sourcePlanDraft, draft);
  assert.equal(h.admissions[0].dispatchHints.explicitIntent, "plan");
  assert.equal(h.admissions[0].dispatchHints.skipIntentResolution, true);
  assert.equal(h.admissions[0].dispatchHints.executionConsentGranted, undefined);
  assert.equal(h.admissions[0].source, "plan_adjustment");
});
test("draft completion sends the user's supplement with the exact source binding", async () => {
  const h = harness();
  const result = await h.module.continuePlanDraft({ get: h.get, record: draft, supplement: "  保留 Inspector 检查，可以新增 PlayMode 测试。  " });
  assert.equal(result.accepted, true);
  assert.equal(h.admissions[0].text, "Build the Collector game\n\n本轮补充要求\n保留 Inspector 检查，可以新增 PlayMode 测试。");
  assert.deepEqual(h.admissions[0].dispatchHints.sourcePlanDraft, draft);
});
for (const [label, patch] of [
  ["session switch", { currentSessionId: 2 }], ["epoch replacement", { sessionsByWorkspace: { "/fixture": [{ id: 1, planLifecycleEpoch: "epoch-2" }] } }],
  ["another workspace", { currentWorkspace: "/other" }], ["busy runtime", { isGenerating: true }],
  ["missing ledger", { runtimeV2Checkpoints: {} }],
]) test(`draft completion rejects ${label} without admission`, async () => {
  const h = harness(); h.set(patch);
  const result = await h.module.continuePlanDraft({ get: h.get, record: draft }); assert.equal(result.accepted, false); assert.equal(h.admissions.length, 0);
});
test("draft completion rejects forged projection metadata without a matching canonical receipt", async () => {
  const h = harness(); const changed = { ...draft, documentRef: { ...reference, revision: 2 } };
  assert.equal((await h.module.continuePlanDraft({ get: h.get, record: changed })).accepted, false);
  assert.equal(h.admissions.length, 0);
});
test("late document read cannot submit into a replacement Turn or Session", async () => {
  const h = harness(); let settle;
  const pending = h.module.continuePlanDraft({ get: h.get, record: draft, readDocument: () => new Promise(resolve => { settle = resolve; }) });
  h.set({ currentTurnId: "replacement-turn" }); settle({ ...reference, markdown });
  assert.equal((await pending).accepted, false); assert.equal(h.admissions.length, 0);
});
for (const label of ["missing", "changed bytes", "wrong revision"]) test(`draft completion rejects ${label} document`, async () => {
  const h = harness();
  const readDocument = async () => {
    if (label === "missing") throw new Error("missing file");
    return { ...reference, ...(label === "wrong revision" ? { revision: 2 } : {}), markdown: label === "changed bytes" ? markdown + "changed" : markdown };
  };
  assert.equal((await h.module.continuePlanDraft({ get: h.get, record: draft, readDocument })).accepted, false); assert.equal(h.admissions.length, 0);
});

for (const globalWorkspace of ["", "__MAIN_GLOBAL_CHAT__"]) test(`global draft completion uses the existing new-Turn path (${globalWorkspace || "empty workspace"})`, async () => {
  const h = harness();
  const globalRecord = structuredClone(draft);
  globalRecord.documentRef.owner = { ...reference.owner, workspace: null, sessionKey: "__MAIN_GLOBAL_CHAT__:1" };
  const globalTurn = { workspaceKey: "__MAIN_GLOBAL_CHAT__", sessionKey: "__MAIN_GLOBAL_CHAT__:1", sessionEpoch: "epoch-1", turnId: "source-turn" };
  const globalCalls = [];
  h.set({ currentWorkspace: globalWorkspace, sessionsByWorkspace: { __MAIN_GLOBAL_CHAT__: [{ id: 1, planLifecycleEpoch: "epoch-1" }] },
    runtimeV2Checkpoints: { "source-turn": { aggregate: { turn: globalTurn, strategy: "plan", terminalOutcome: { resultKind: "partial" }, fixtureDraft: globalRecord } } },
    sendMessage: (...args) => { globalCalls.push(args); return true; },
  });
  const result = await h.module.continuePlanDraft({ get: h.get, record: globalRecord, readDocument: async () => ({ ...globalRecord.documentRef, markdown }) });
  assert.equal(result.accepted, true); assert.equal(h.admissions.length, 0);
  assert.equal(globalCalls.length, 1); assert.equal(globalCalls[0][0], "Build the Collector game");
  assert.deepEqual(globalCalls[0][2].sourcePlanDraft, globalRecord);
  assert.equal(globalCalls[0][2].reuseCurrentTurn, false);
  assert.equal(globalCalls[0][2].explicitIntent, "plan");
  assert.equal(globalCalls[0][2].executionConsentGranted, undefined);
});
