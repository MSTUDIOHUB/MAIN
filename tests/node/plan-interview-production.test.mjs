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
    const module = { exports: {} }; cache.set(file, module.exports);
    const native = createRequire(file);
    const requireModule = name => {
      if (mocks.has(name)) return mocks.get(name);
      if (name.startsWith(".")) {
        const base = path.resolve(path.dirname(file), name);
        for (const candidate of [base, `${base}.ts`, path.join(base, "index.ts")]) if (candidate.endsWith(".ts") && fs.existsSync(candidate)) return load(candidate);
      }
      return native(name);
    };
    new Function("exports", "module", "require", ts.transpileModule(fs.readFileSync(file, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }, fileName: file,
    }).outputText)(module.exports, module, requireModule);
    return module.exports;
  };
}
const runtime = loader()("src/lib/runtime-v2/index.ts");
const { formatReadFileWindowPayloadForModel } = loader()("src/lib/readFileWindow.ts");
const sha = value => createHash("sha256").update(value).digest("hex");
const questionCall = () => ({ content: "", toolCalls: [{ id: "ask", name: "ask_plan_questions", arguments: JSON.stringify({ title: "Choose a method", questions: [{ id: "method", prompt: "Which tradeoff should guide the design?", selectionMode: "multiple", required: true, options: [{ id: "simple", label: "Simple" }, { id: "offline", label: "Offline" }] }] }) }], protocolViolation: null });
const acceptanceQuestion = { id: "acceptance", prompt: "Which deployment environment should this cover?", selectionMode: "text", required: true, options: [] };
const followupQuestionCall = (prompt = acceptanceQuestion.prompt) => ({ content: "", toolCalls: [{ id: "ask-late", name: "ask_plan_questions",
  arguments: JSON.stringify({ title: "Confirm the acceptance target", questions: [{ ...acceptanceQuestion, prompt }] }) }], protocolViolation: null });
const documentCall = () => ({ content: "", toolCalls: [{ id: "save", name: "submit_plan_document", arguments: JSON.stringify({ title: "Confirmed design", markdown: "# Plan\n\nUse the confirmed simple offline design.\n" }) }], protocolViolation: null });

function harness({ workspace = "", purpose = "plan", responses = [questionCall(), documentCall()], legacyDraftFixture = false, versionedReads = false, toolResults = {} } = {}) {
  const sessionKey = workspace ? `${workspace}:1` : "__MAIN_GLOBAL_CHAT__:1";
  const context = { turnId: "turn-interview", uiDisplayTurnId: "turn-interview", runWorkspace: workspace, runScopeKey: workspace || "__MAIN_GLOBAL_CHAT__", runSessionKey: sessionKey, runSessionId: 1, runSessionEpoch: "epoch-1", harnessRunId: "run-interview", phaseLanguage: "en", planPurpose: purpose,
    abortCtrl: new AbortController(), timerInterval: undefined, turnInputContextSignals: { subagentPreference: "forbidden", subagentRequirement: "optional", attachedFilePaths: [] },
    runtimeContextBudget: { contextLimit: 32768, outputBudget: 4096, inputBudget: 28672, readWindowChars: 16000 } };
  let state = { currentTurnId: context.turnId, currentSessionId: 1, conversationTurns: [{ id: context.turnId, clientSubmissionId: "submission-1", userPrompt: "Develop a design after investigating its important tradeoffs." }],
    config: {}, planLifecycle: { sessionKey, sessionEpoch: "epoch-1" }, runtimeV2Checkpoints: {}, taskFlow: [],
    harnessRunMarker: { sessionKey, turnId: context.turnId, runId: context.harnessRunId, status: "running", startedAt: 1, instanceId: "instance-1" }, _nextTaskId: () => state.taskFlow.length + 1 };
  const projections = [], calls = [], saves = [], reads = [], effects = [], inspections = [], stored = new Map(), logs = [];
  let saveFault = null;
  const get = () => state;
  const set = patch => { state = { ...state, ...(typeof patch === "function" ? patch(state) : patch) }; };
  const mocks = new Map([
    ["../../lib/providerLaneSettings", { deriveBudgetedStreamSettings: () => ({ provider: "fixture", toolProtocol: "auto" }), deriveProviderAdapterCapabilities: () => ({ nativeToolRoundTrip: true, reasoningToggle: false }) }],
    ["../../lib/modelLaneCoordinator", { acquireModelLane: async () => ({ release() {}, markFirstToken() {}, reportFailure() {}, setPressureHandler() {} }) }],
    ["../../lib/streaming", { isStreamOutputLimited: () => false, streamChatCompletion: async (...args) => { calls.push(args); if (!responses.length) { context.abortCtrl.abort("fixture exhausted without convergence"); assert.fail("fixture must not silently loop"); } return responses.shift(); } }],
    ["../../lib/subagents", { resolveSubagentCapacityPolicy: () => ({ maxActiveRequests: 0, modelRequestMode: "serialized" }) }],
    ["../../lib/ipc", { inspectProjectInitTarget: async () => { inspections.push(workspace); return { canonicalWorkspace: workspace, targetPath: `${workspace}/AGENTS.md`, exists: true, content: "# Existing rules\n", contentVersion: "base-version" }; },
      savePlanDocument: async input => { saves.push(input); if (saveFault) throw new Error(saveFault); const key = `${input.owner.sessionKey}:${input.documentId}`;
        if (stored.has(key)) { assert.deepEqual(stored.get(key).input, input, "lost-ack recovery must use exact immutable save input"); return stored.get(key).reference; }
        const reference = { owner: input.owner, documentId: input.documentId, revision: 1, contentHash: sha(input.markdown), path: `stored/${input.documentId}/rev-1.md`, title: input.title, kind: input.kind }; stored.set(key, { input, reference }); return reference; },
      readPlanDocument: async reference => {
        reads.push(reference);
        const document = stored.get(`${reference.owner.sessionKey}:${reference.documentId}`);
        assert.ok(document);
        assert.deepEqual(reference, document.reference);
        return { ...document.reference, markdown: document.input.markdown };
      } }],
    ["../../lib/toolExecutor", { executeTool: async (name, args) => { effects.push(name); if (name === "read_file") {
      const content = "Observed project facts.";
      return versionedReads ? formatReadFileWindowPayloadForModel(args.path, {
        content, contentVersion: `sha256-${sha(content)}`, startLine: 1, endLine: 1, totalLines: 1, totalChars: content.length, truncated: false,
      }) : content;
    } if (name === "get_project_skeleton") return "src/main.js\npackage.json";
      if (Object.hasOwn(toolResults, name)) return toolResults[name];
      throw new Error(`unexpected effect ${name}`); } }],
    ["./checkpointPort", { getRuntimeV2Checkpoint: (_state, owner) => state.runtimeV2Checkpoints[owner.turnId] || null,
      createRuntimeV2CheckpointPort: () => ({ append: async input => {
        const result = runtime.appendRuntimeV2Checkpoint({ checkpoint: state.runtimeV2Checkpoints[input.owner.turnId] || null, owner: input.owner, expectedRevision: input.expectedRevision, event: input.event });
        assert.equal(result.disposition, "committed", result.reason);
        state = { ...state, runtimeV2Checkpoints: { ...state.runtimeV2Checkpoints, [input.owner.turnId]: result.checkpoint } }; return result;
      } }) }],
    ["./projectionPort", { createRuntimeV2ProjectionPort: () => ({ publish: async value => projections.push(value) }) }],
  ]);
  const load = loader(mocks);
  if (legacyDraftFixture) {
    const questions = load("src/store/runtimeV2/planQuestionTool.ts");
    const legacyTurnId = context.turnId;
    mocks.set("./planQuestionTool", { ...questions,
      // Create a historical terminal draft using the previous runner policy.
      hasExecutablePlanChoice: aggregate => aggregate.turn.turnId !== legacyTurnId && questions.hasExecutablePlanChoice(aggregate) });
  }
  const runner = load("src/store/runtimeV2/planRunner.ts");
  const controls = load("src/store/runtimeV2/executionBlocker.ts");
  const args = { get, set, context, getSessionRevisionToken: () => 1, sanitizeTaskBlocksForPersist: x => x, buildSessionRuntimeSnapshot: x => x, publishOwnerScopedRuntimeProjection: () => ({ published: true }), persistSessionRecord: async () => undefined, logStoreEvent(event, data) { logs.push({ event, data }); } };
  return { get, set, context, input: args, calls, saves, reads, effects, projections, inspections, stored, logs, load,
    setSaveFault(value) { saveFault = value; },
    async decide(choice = "recheck", identityOverride) {
      const request = state.activeActionRequest;
      state = { ...state, harnessRunMarker: { ...state.harnessRunMarker, status: "paused" } };
      const identity = identityOverride || load("src/lib/actionRequest.ts").toUserChoiceResolutionIdentity(request);
      let dispatched = 0, stopped = 0;
      const ok = await controls.resolveRuntimeV2ExecutionBlocker({ get, set, identity, choice, sessionEpoch: "epoch-1", persist: async () => ({}), dispatch: () => { dispatched++; }, stop() { stopped++; } });
      if (ok && choice !== "stop") state = { ...state, activeActionRequest: null, harnessRunMarker: { ...state.harnessRunMarker, status: "running" } };
      return { ok, dispatched, stopped };
    },
    run: () => runner.runSubmitRuntimeV2Plan(args),
    async answer(selectedMode = "document", identityOverride, supplement) {
      const request = state.activeActionRequest;
      state = { ...state, harnessRunMarker: { ...state.harnessRunMarker, status: "paused" } };
      const identity = identityOverride || load("src/lib/actionRequest.ts").toUserChoiceResolutionIdentity(request);
      const answer = { requestId: request.requestId, revision: request.questionnaire.revision, answers: request.questionnaire.questions.map(q => ({
        questionId: q.id, selectedValues: q.id === "result_kind" ? [selectedMode] : q.options.map(o => o.id),
        ...(supplement && q.selectionMode === "text" ? { text: supplement } : {}),
      })) };
      let dispatched = 0;
      const ok = await controls.resolveRuntimeV2StructuredUserChoice({ get, set, identity, answer, sessionEpoch: "epoch-1", persist: async () => ({}), dispatch: () => { dispatched++; }, stop() {} });
      if (ok) state = { ...state, activeActionRequest: null, harnessRunMarker: { ...state.harnessRunMarker, status: "running" } };
      return { ok, dispatched, answer };
    },
  };
}

test("a global Plan confirms real choices, resumes the same Run and saves a conceptual document without fake targets", async () => {
  const h = harness();
  assert.equal((await h.run()).outcome.status, "paused");
  assert.equal(h.saves.length, 0);
  assert.ok(h.calls[0][4].some(tool => tool.function.name === "ask_plan_questions"));
  assert.match(h.get().activeActionRequest.questionnaire.summary, /Develop a design/);
  const originalRun = h.get().runtimeV2Checkpoints[h.context.turnId].aggregate.run.identity;
  const answer = await h.answer(); assert.equal(answer.ok, true); assert.equal(answer.dispatched, 1);
  assert.deepEqual(answer.answer.answers.find(item => item.questionId === "method").selectedValues, ["simple", "offline"]);
  assert.equal((await h.run()).outcome.resultKind, "success");
  assert.equal(h.saves.length, 1); assert.equal(h.saves[0].owner.workspace, null);
  assert.match(h.saves[0].markdown, /## 用户选择 \/ Confirmed choices/);
  assert.match(h.saves[0].markdown, /> Simple\n> Offline/);
  assert.match(h.saves[0].markdown, /Confirmation:.*revision 1/);
  const aggregate = h.get().runtimeV2Checkpoints[h.context.turnId].aggregate;
  assert.deepEqual(aggregate.run.identity, originalRun);
  assert.equal(aggregate.sealedWorkPlan, null);
  assert.equal(aggregate.events.filter(e => e.type === "run.completed").length, 1);
  assert.equal(aggregate.events.filter(e => e.type === "turn.completed").length, 1);
  assert.equal(h.effects.length, 0);
  assert.equal(h.load("src/lib/planDocumentRecords.ts").resolvePlanDocumentFromAggregate(aggregate).markdown, h.saves[0].markdown);
});

test("an executable Plan retains a second question after resuming from persisted state", async () => {
  const followup = { content: "", toolCalls: [{ id: "ask-validation", name: "ask_plan_questions", arguments: JSON.stringify({
    title: "Choose the acceptance environment",
    questions: [{ id: "acceptance", prompt: "Which environment should the acceptance checks cover?", selectionMode: "single", required: true,
      options: [{ id: "desktop", label: "Desktop" }, { id: "web", label: "Browser" }] }],
  }) }] };
  const h = harness({ workspace: "/fixture", responses: [questionCall(), followup] });
  await h.run();
  assert.equal((await h.answer("executable")).ok, true);
  // The production checkpoint adapter can restore the aggregate from disk;
  // the incoming context and raw checkpoint do not carry that cache.
  h.context.planPurpose = undefined;
  h.input.get = () => {
    const state = h.get();
    return { ...state, runtimeV2Checkpoints: runtime.serializeRuntimeV2CheckpointMap(state.runtimeV2Checkpoints) };
  };
  assert.equal((await h.run()).outcome.status, "paused");
  assert.ok(h.calls[1][4].some(tool => tool.function.name === "ask_plan_questions"));
  const request = h.get().activeActionRequest;
  assert.equal(request.kind, "user_choice");
  assert.deepEqual(request.questionnaire.questions.map(question => question.id), ["acceptance"]);
  assert.equal(request.questionnaire.revision, 2);
  assert.equal(h.saves.length, 0);
});

test("schema-shaped synthesis asks only the unresolved decision and reuses its confirmed answer", async () => {
  const noAction = { content: "The retained evidence leaves a deployment decision.", toolCalls: [] };
  const synthesis = { content: JSON.stringify({
    planMarkdown: "Proposed implementation.", changes: [], validations: [],
    questions: ["Which deployment environment should this cover?", "Which deployment environment should this cover?"],
  }), toolCalls: [] };
  const read = { content: "", toolCalls: [readinessRead("initial-source", "src/main.js")] };
  const ready = { content: readinessSubmission("ready", executableReadinessCheck).toolCalls[0].arguments, toolCalls: [] };
  const h = harness({ workspace: "/fixture", versionedReads: true,
    responses: [questionCall(), read, noAction, noAction, synthesis, synthesis, ready] });
  await h.run();
  assert.equal((await h.answer("executable")).ok, true);
  assert.equal((await h.run()).outcome.status, "paused");
  assert.equal(h.calls.at(-1)[6].responseFormat.type, "json_schema");
  assert.equal(h.get().activeActionRequest.kind, "user_choice");
  assert.deepEqual(h.get().activeActionRequest.questionnaire.questions.map(question => [question.selectionMode, question.prompt]),
    [["text", "Which deployment environment should this cover?"]]);
  assert.equal(h.saves.length, 0);
  const aggregate = h.get().runtimeV2Checkpoints[h.context.turnId].aggregate;
  assert.equal(aggregate.sealedWorkPlan, null);
  assert.equal(aggregate.events.filter(event => event.type === "run.resumed").length, 1);
  assert.equal((await h.answer("executable", undefined, "Use the offline desktop build.")).ok, true);
  assert.equal((await h.run()).outcome.status, "paused");
  assert.equal(h.get().activeActionRequest.kind, "plan_review");
  const feedback = h.calls.at(-1)[0].find(message => message.role === "tool" && message.content.includes("PLAN_QUESTION_ALREADY_ANSWERED"));
  assert.match(feedback?.content || "", /Use the offline desktop build/);
});

test("an answered native question is reused even with a new ID, and a mixed questionnaire only asks what remains", async () => {
  const initial = questionCall();
  const [method] = JSON.parse(initial.toolCalls[0].arguments).questions;
  const repeat = (id, questions) => ({ content: "", toolCalls: [{ id, name: "ask_plan_questions",
    arguments: JSON.stringify({ title: "Continue the plan", questions }) }] });
  const renamed = { ...method, id: "method-again" };
  const h = harness({ workspace: "/fixture", responses: [initial, repeat("duplicate", [renamed]),
    repeat("mixed", [renamed, acceptanceQuestion]), { content: "", toolCalls: [readinessRead("source", "src/main.js")] },
    readinessSubmission("ready", executableReadinessCheck)] });
  assert.equal((await h.run()).outcome.status, "paused");
  assert.equal((await h.answer("executable")).ok, true);
  assert.equal((await h.run()).outcome.status, "paused");
  const request = h.get().activeActionRequest;
  assert.equal(request.kind, "user_choice");
  assert.deepEqual(request.questionnaire.questions.map(q => q.id), ["acceptance"]);
  assert.equal(request.questionnaire.revision, 2);
  const reply = h.calls.at(-1)[0].find(message => message.role === "tool" && message.tool_call_id === "duplicate");
  assert.deepEqual(JSON.parse(reply.content).answers[0].selectedLabels, ["Simple", "Offline"]);
  assert.equal((await h.answer("executable", undefined, "Offline desktop only.")).ok, true);
  assert.equal((await h.run()).outcome.status, "paused");
  assert.equal(h.get().activeActionRequest.kind, "plan_review");
  assert.match(JSON.stringify(h.calls.at(-1)[0]), /Offline desktop only/);
  const events = h.get().runtimeV2Checkpoints[h.context.turnId].aggregate.events;
  assert.equal(events.filter(event => event.type === "run.paused" && event.blocker.questionnaire).length, 2);
  assert.equal(events.filter(event => event.type === "work_plan.approved").length, 0);
});

test("confirmation cannot be skipped, stale identities fail and further interview rounds survive cold normalization", async () => {
  const h = harness({ responses: [documentCall(), questionCall(), followupQuestionCall(), documentCall()] });
  assert.equal((await h.run()).outcome.status, "paused");
  assert.equal(h.saves.length, 0, "premature submit cannot save");
  const oldIdentity = h.load("src/lib/actionRequest.ts").toUserChoiceResolutionIdentity(h.get().activeActionRequest);
  assert.equal((await h.answer()).ok, true);
  assert.equal((await h.run()).outcome.status, "paused");
  assert.equal((await h.answer("document", oldIdentity)).ok, false);
  const raw = runtime.serializeRuntimeV2CheckpointMap(h.get().runtimeV2Checkpoints)[h.context.turnId];
  const restored = runtime.normalizeRuntimeV2Checkpoint(JSON.parse(JSON.stringify(raw)));
  assert.ok(restored);
  h.set({ runtimeV2Checkpoints: { [h.context.turnId]: restored } });
  assert.equal((await h.answer("document", undefined, "Use the offline desktop build.")).ok, true);
  assert.equal((await h.run()).outcome.resultKind, "success");
  assert.equal(h.saves.length, 1);
});

test("rules drafts capture the original AGENTS version and do not publish it before editable CAS review", async () => {
  const h = harness({ workspace: "/fixture", purpose: "rules" });
  assert.equal((await h.run()).outcome.status, "paused");
  assert.equal((await h.answer()).ok, true);
  h.context.planPurpose = undefined;
  assert.equal((await h.run()).outcome.resultKind, "success");
  assert.equal(h.saves[0].kind, "rules_draft");
  assert.doesNotMatch(h.saves[0].markdown, /Confirmed choices|Confirmation:/, "AGENTS.md drafts contain rules, not an interview transcript");
  assert.equal(h.inspections.length, 1, "resume must reuse the captured original AGENTS version");
  assert.equal(h.get().rulesDraftReview.inspection.baseVersion, "base-version");
  assert.equal(h.effects.includes("write_file"), false);
});

test("an executable Plan requires the interview, saves a unique bound document, and still requires exact independent approval", async () => {
  const read = { content: "", toolCalls: [{ id: "source", name: "read_file", arguments: JSON.stringify({ path: "src/main.js" }) }], protocolViolation: null };
  const submit = { content: "", toolCalls: [{ id: "work-plan", name: "submit_runtime_v2_work_plan", arguments: JSON.stringify({
    planMarkdown: "Implement the confirmed method using the observed source contract.",
    changes: [{ operation: "modify", targets: ["src/main.js"], change: "Use the confirmed offline implementation.", basis: ["E1"] }],
    validations: [{ kind: "finite_command", command: "npm test", expectedOutcome: "The confirmed implementation passes its tests." }],
  }) }], protocolViolation: null };
  const h = harness({ workspace: "/fixture", responses: [questionCall(), read, followupQuestionCall(), submit] });
  assert.equal((await h.run()).outcome.status, "paused");
  assert.equal(h.saves.length, 0);
  assert.equal((await h.answer("executable")).ok, true);
  assert.equal((await h.run()).outcome.status, "paused");
  assert.equal(h.get().activeActionRequest.kind, "user_choice", "material decisions can open further interview rounds during executable planning");
  assert.equal((await h.answer("executable", undefined, "Use the offline desktop build.")).ok, true);
  h.context.planPurpose = undefined;
  assert.equal((await h.run()).outcome.status, "paused");
  const checkpoint = h.get().runtimeV2Checkpoints[h.context.turnId];
  assert.equal(checkpoint.aggregate.phase, "reviewing");
  assert.equal(checkpoint.aggregate.workPlan.status, "pending_review", "information confirmation grants no execution approval");
  assert.equal(checkpoint.aggregate.terminalOutcome, null);
  assert.deepEqual(h.effects, ["read_file", "read_file"], "no workspace mutation or validation executes while planning");
  assert.equal(h.saves.length, 1);
  const request = h.get().activeActionRequest;
  const ref = request.documentRef;
  assert.equal(ref.contentHash, sha(h.saves[0].markdown));
  assert.equal(ref.owner.turnId, h.context.turnId);
  assert.notEqual(ref.path, ".MAIN/plans/plan.md");
  const commit = checkpoint.aggregate.planReviewCommit;
  assert.match(checkpoint.aggregate.sealedWorkPlan.decisionJournal, /> Simple\n> Offline/);
  assert.ok(commit.artifact.content.endsWith(checkpoint.aggregate.sealedWorkPlan.decisionJournal));
  const adapter = h.load("src/store/runtimeV2/workPlanAdapter.ts");
  assert.equal(adapter.validateSealedWorkPlanV1Integrity({ ...checkpoint.aggregate.sealedWorkPlan, decisionJournal: "forged confirmation" }).ok, false);
  assert.equal(adapter.validateSealedWorkPlanV1Integrity({ ...checkpoint.aggregate.sealedWorkPlan, decisionJournal: undefined }).ok, false);
  assert.deepEqual(commit.artifact.documentRef, ref);
  assert.equal(h.load("src/lib/planDocumentRecords.ts").resolvePlanDocumentFromAggregate(checkpoint.aggregate).markdown, h.saves[0].markdown);
  const sealEvent = checkpoint.aggregate.events.find(event => event.type === "work_plan.sealed");
  const saveCommand = checkpoint.aggregate.events.find(event => event.type === "command.scheduled" && event.command.payload.toolName === "save_plan_document");
  const beforeSeal = runtime.replayRuntimeV2Events(checkpoint.aggregate.events.filter(event => event.sequence < sealEvent.sequence));
  const authorityGuard = h.load("src/lib/runtime-v2/reducerGuards.ts").hasMatchingRuntimeV2SealedPlanAuthority;
  assert.equal(authorityGuard({ event: sealEvent, state: { ...beforeSeal, events: beforeSeal.events.filter(event => event.type !== "run.decision_recorded") } }), false, "new admitted Plan cannot seal an executable artifact without actual information confirmation");
  assert.equal(authorityGuard({ event: sealEvent, state: { ...beforeSeal, planPurpose: "rules" } }), false, "rules drafting never seals executable WorkPlan authority");
  assert.equal(authorityGuard({ event: { ...sealEvent, sealedPlan: { ...sealEvent.sealedPlan, decisionJournal: "invented choices" } }, state: beforeSeal }), false, "only the canonical answer journal can be sealed");
  const beforeSave = runtime.replayRuntimeV2Events(checkpoint.aggregate.events.filter(event => event.sequence < saveCommand.sequence));
  assert.equal(runtime.tryTransition(beforeSave, { ...sealEvent, sequence: beforeSave.nextSequence }).disposition, "rejected", "a document reference without its actual saved receipt cannot seal a new Plan");
  const approval = h.load("src/store/runtimeV2/planApproval.ts");
  let appended = 0;
  const port = { append: async input => { appended++; return runtime.appendRuntimeV2Checkpoint({ checkpoint, ...input }); } };
  const args = { checkpoint, request, port, now: Date.now(), eventId: "explicit-plan-approval" };
  assert.equal((await approval.approveRuntimeV2PlanReviewCheckpoint({ ...args, request: { ...request, documentRef: undefined } })).ok, false);
  assert.equal((await approval.approveRuntimeV2PlanReviewCheckpoint({ ...args, request: { ...request, documentRef: { ...ref, revision: ref.revision + 1 } } })).ok, false);
  assert.equal(appended, 0);
  const result = await approval.approveRuntimeV2PlanReviewCheckpoint(args);
  assert.equal(result.ok, true);
  assert.equal(result.checkpoint.aggregate.workPlan.status, "approved");
  assert.equal(appended, 1);
  const binding = h.load("src/lib/runtime-v2/workPlan.ts").isWorkPlanArtifactProjectionBound;
  for (const change of [
    { contentHash: "0".repeat(64) }, { path: "another-document.md" }, { kind: "rules_draft" },
    { owner: { ...ref.owner, workspace: "/foreign" } }, { owner: { ...ref.owner, sessionEpoch: "old-epoch" } }, { owner: { ...ref.owner, turnId: "another-turn" } },
  ]) assert.equal(binding({ ...commit.artifact, documentRef: { ...ref, ...change } }, checkpoint.aggregate.sealedWorkPlan, checkpoint.owner), false);
});

for (const followup of [false, true]) test(`completing a saved executable Plan draft ${followup ? "resumes a new user decision before review" : "opens a separate review without repeating the interview"}`, async () => {
  const sourceRead = { content: "", toolCalls: [{ id: "legacy-source", name: "read_file",
    arguments: JSON.stringify({ path: "src/main.js" }) }], protocolViolation: null };
  const submit = (id, validation) => ({ content: "", toolCalls: [{ id, name: "submit_runtime_v2_work_plan", arguments: JSON.stringify({
    planMarkdown: "Create the collector using the confirmed offline method.",
    changes: [{ operation: "create", targets: ["src/collector.js"], change: "Implement the offline collector." }],
    validations: [validation],
  }) }], protocolViolation: null });
  const h = harness({ workspace: "/fixture", legacyDraftFixture: true, responses: [questionCall(), sourceRead,
    submit("manual-checks", { kind: "advisory", required: true, expectedOutcome: "Inspect the collector behavior manually." }),
    ...(followup ? [{ content: "", toolCalls: [{ id: "late-acceptance", name: "ask_plan_questions", arguments: JSON.stringify({
      title: "Confirm the acceptance target",
      questions: [{ id: "acceptance", prompt: "Which collector build must pass acceptance?", selectionMode: "single", required: true,
        options: [{ id: "offline", label: "Offline collector build" }] }],
    }) }] }] : []),
    submit("completed-checks", { kind: "finite_command", command: "npm test", expectedOutcome: "Offline collector tests pass." }),
  ] });
  h.context.executeAdmission = {
    objective: "Develop the offline collector.",
    constraints: ["Keep the collector available without network access."],
    acceptanceCriteria: [{ id: "collector-offline", text: "Collect records offline." }],
  };
  assert.equal((await h.run()).outcome.status, "paused");
  assert.equal((await h.answer("executable")).ok, true);
  assert.equal((await h.run()).outcome.resultKind, "partial");
  const originalTurnId = h.context.turnId;
  const original = h.get().runtimeV2Checkpoints[originalTurnId];
  const record = h.load("src/lib/planDocumentRecords.ts").resolvePlanDraftFromAggregate(original.aggregate);
  assert.ok(record);
  assert.equal(h.saves.length, 1);
  assert.equal(h.calls.length, 3, "the historical advisory submission stops after saving the draft");
  assert.equal(original.aggregate.sealedWorkPlan, null);
  const sourceKey = `${record.documentRef.owner.sessionKey}:${record.documentRef.documentId}`;
  const originalDocument = structuredClone(h.stored.get(sourceKey));
  const originalEffects = h.effects.slice();

  const nextTurnId = "turn-complete-draft";
  const nextRunId = "run-complete-draft";
  const userPrompt = `${original.aggregate.objective.text}\nSupplement: prioritize the local fixture.`;
  Object.assign(h.context, { turnId: nextTurnId, uiDisplayTurnId: nextTurnId, harnessRunId: nextRunId,
    sourcePlanDraft: record, executeAdmission: undefined, abortCtrl: new AbortController() });
  h.set(state => ({ currentTurnId: nextTurnId, activeActionRequest: null,
    conversationTurns: [...state.conversationTurns.map(turn => turn.id === originalTurnId ? { ...turn, summary: originalDocument.input.markdown } : turn), { id: nextTurnId, clientSubmissionId: "submission-complete-draft",
      userPrompt, sourcePlanDraft: record }],
    harnessRunMarker: { ...state.harnessRunMarker, turnId: nextTurnId, runId: nextRunId, status: "running" },
  }));

  assert.equal((await h.run()).outcome.status, "paused");
  assert.equal(h.calls.length, 4, "completion needs one WorkPlan response and no fresh interview");
  if (followup) {
    assert.equal(h.get().activeActionRequest.kind, "user_choice");
    assert.deepEqual(h.get().activeActionRequest.questionnaire.questions.map(question => question.id), ["acceptance"]);
    assert.equal(h.saves.length, 1, "an unresolved decision never creates a reviewable implementation plan");
    assert.equal((await h.run()).outcome.status, "paused");
    assert.equal(h.calls.length, 4, "an unanswered questionnaire stays paused");
    assert.equal((await h.answer()).ok, true);
    assert.equal((await h.run()).outcome.status, "paused");
    assert.equal(h.calls.length, 5);
    assert.ok(h.calls[4][0].some(message => message.role === "user" && message.content.includes('"selectedValues":["offline"]')));
  }
  assert.equal(h.calls[3][0].some(message => message.role === "assistant" && message.content === originalDocument.input.markdown), false,
    "the exact bound draft must not be repeated as historical assistant prose");
  assert.ok(h.calls[3][0].some(message => message.role === "user" && message.content === userPrompt));
  assert.ok(h.calls[3][0].some(message => message.role === "user" && message.content.includes("[draft-E1] src/main.js")));
  assert.equal(h.calls[3][0].some(message => typeof message.content === "string" && message.content.startsWith("[E1] workspace overview")), false);
  assert.deepEqual(h.effects, originalEffects, "historical completion uses prior workspace reads without performing a fresh overview or source read");
  assert.match(h.calls[3][0][0].content, /collector-offline: Collect records offline\./);
  assert.deepEqual(h.reads, [record.documentRef]);
  const next = h.get().runtimeV2Checkpoints[nextTurnId].aggregate;
  assert.deepEqual(next.objective, original.aggregate.objective);
  assert.equal(next.phase, "reviewing");
  assert.equal(next.workPlan.status, "pending_review");
  assert.equal(h.get().activeActionRequest.kind, "plan_review");
  assert.equal(next.events.filter(event => event.type === "run.paused" && event.blocker.questionnaire).length, followup ? 1 : 0);
  assert.equal(next.events.filter(event => event.type === "run.resumed").length, followup ? 1 : 0);
  assert.equal(next.events.some(event => event.type === "work_plan.approved"), false);
  const journal = h.load("src/lib/planDecisionJournal.ts").buildPlanDecisionJournal(original.aggregate);
  assert.match(journal, /> Simple\n> Offline/);
  if (followup) {
    assert.ok(next.sealedWorkPlan.decisionJournal.startsWith(journal));
    assert.match(next.sealedWorkPlan.decisionJournal, /Offline collector build/);
  } else assert.equal(next.sealedWorkPlan.decisionJournal, journal);
  const newReference = next.planReviewCommit.artifact.documentRef;
  assert.equal(newReference.owner.turnId, nextTurnId);
  assert.notEqual(newReference.documentId, record.documentRef.documentId);
  assert.equal(h.saves.length, 2);
  assert.deepEqual(h.stored.get(sourceKey), originalDocument);
  assert.equal(h.get().runtimeV2Checkpoints[originalTurnId], original);
  const save = next.events.find(event => event.type === "command.scheduled" && event.command.payload.runtimeOwnedPlanArtifact);
  const receipt = next.events.find(event => event.type === "tool.completed" && event.idempotencyKey === save.command.idempotencyKey);
  assert.deepEqual(save.command.payload.derivedFrom, record.documentRef);
  assert.deepEqual(JSON.parse(receipt.modelContent).derivedFrom, record.documentRef);
});


function readinessSubmission(id, validation) {
  return { content: "", toolCalls: [{ id, name: "submit_runtime_v2_work_plan", arguments: JSON.stringify({
    planMarkdown: "# Offline collector\n\nUse the existing collector state contract.",
    changes: [{ operation: "modify", targets: ["src/main.js"], change: "Use the offline collector.", basis: ["E1"] }],
    validations: [validation],
  }) }], protocolViolation: null };
}

const manualReadinessCheck = { kind: "assertion", required: true, expectedOutcome: "Inspect whether collection works offline." };
const executableReadinessCheck = { kind: "finite_command", command: "npm test", expectedOutcome: "The offline collector test passes." };

for (const corrected of [true, false]) test(`a repeated identical candidate gets one validation-only repair (${corrected ? "review" : "exhaustion"})`, async () => {
  const invalid = { kind: "finite_command", command: "unity command console get --level error", expectedOutcome: "The console is clear." };
  const h = harness({ workspace: "/fixture", responses: [questionCall(),
    readinessSubmission("invalid-1", invalid), readinessSubmission("invalid-2", invalid),
    { content: JSON.stringify({ planMarkdown: "Create the planned changes and verify the resulting behavior.",
      validations: [corrected ? executableReadinessCheck : invalid] }), toolCalls: [] },
    corrected ? readinessSubmission("unexpected", invalid) : readinessSubmission("must-not-retry", executableReadinessCheck),
  ] });
  await h.run();
  assert.equal((await h.answer("executable")).ok, true);
  const settlement = await h.run();
  assert.equal(h.calls.length, 4);
  assert.equal(h.calls[3][6].responseFormat?.json_schema?.name, "runtime_v2_work_plan_validation_repair");
  const repairPrompt = h.calls[3][0].map(message => String(message.content || "")).join("\n");
  assert.doesNotMatch(repairPrompt, /unity command console get/);
  assert.match(repairPrompt, /## 用户选择 \/ Confirmed choices/);
  const aggregate = h.get().runtimeV2Checkpoints[h.context.turnId].aggregate;
  if (corrected) {
    assert.equal(settlement.outcome.status, "paused");
    assert.equal(h.get().activeActionRequest.kind, "plan_review");
    assert.equal(aggregate.sealedWorkPlan.draft.validations[0].command, "npm test");
  } else {
    assert.equal(settlement.outcome.resultKind, "error");
    assert.equal(aggregate.sealedWorkPlan, null);
    assert.equal(aggregate.events.filter(event => event.type === "turn.completed").length, 1);
  }
});
const readinessRead = (id, file) => ({ id, name: "read_file", arguments: JSON.stringify({ path: file }) });

test("an implementation Plan keeps investigating after confirmation and a rejected tool request", async () => {
  const tool = (id, name, args) => ({ id, name, arguments: JSON.stringify(args) });
  const response = (...toolCalls) => ({ content: "", toolCalls, protocolViolation: null });
  const h = harness({ workspace: "/fixture", versionedReads: true, responses: [
    questionCall(),
    response(tool("find-checks", "tool_search", { query: "test runner" }),
      tool("find-tests", "glob_search", { pattern: "tests/**/*.js" }),
      tool("find-config", "glob_search", { pattern: "**/package.json" })),
    response(tool("load-test-guide", "load_skill", { skill_id: "test-guide" })),
    response(),
    response(tool("unsafe", "run_command", { command: "npm test" })),
    response(readinessRead("read-source", "src/main.js")),
    readinessSubmission("ready", executableReadinessCheck),
  ], toolResults: {
    tool_search: JSON.stringify({ matchedCount: 0 }),
    glob_search: "package.json\ntests/collector.test.js",
    load_skill: JSON.stringify({ version: "test-guide-v1", content: "Use the existing collector test." }),
  } });
  h.context.skillCatalog = { entries: [{ id: "panel:test-guide", name: "test-guide", description: "Find the project's test entry point.",
    content: "Use the existing collector test.", allowImplicitInvocation: true, source: "panel", version: "test-guide-v1", supportingFiles: [] }],
    explicitSkillIds: [], warnings: [], loadedAt: 1 };
  assert.equal((await h.run()).outcome.status, "paused");
  assert.equal((await h.answer("executable")).ok, true);
  assert.equal((await h.run()).outcome.status, "paused");
  assert.equal(h.get().activeActionRequest.kind, "plan_review");
  const aggregate = h.get().runtimeV2Checkpoints[h.context.turnId].aggregate;
  assert.equal(aggregate.events.filter(event => event.type === "run.paused" && event.blocker.questionnaire).length, 1);
  assert.equal(aggregate.events.filter(event => event.type === "work_plan.sealed").length, 1);
  assert.ok(aggregate.events.some(event => event.type === "provider.responded" &&
    event.result.diagnostics.some(diagnostic => diagnostic.code === "tool_surface_rejected")));
  assert.deepEqual(h.effects, ["tool_search", "glob_search", "glob_search", "load_skill", "read_file"]);
  for (const call of h.calls.slice(1)) {
    const names = call[4].map(tool => tool.function.name);
    for (const name of ["tool_search", "glob_search", "load_skill", "read_file", "ask_plan_questions", "submit_runtime_v2_work_plan"]) {
      assert.ok(names.includes(name), `${name} remains available during planning`);
    }
    assert.notEqual(typeof call[6].toolChoice, "object", "the provider may choose any admitted action");
  }
});

test("an executable Plan repairs advisory acceptance and opens review in the original Run", async () => {
  const h = harness({ workspace: "/fixture", versionedReads: true, responses: [
    questionCall(),
    { content: "", toolCalls: [readinessRead("existing-source", "src/main.js")], protocolViolation: null },
    readinessSubmission("incomplete-acceptance", manualReadinessCheck),
    readinessSubmission("ready", executableReadinessCheck),
  ] });
  assert.equal((await h.run()).outcome.status, "paused");
  assert.equal((await h.answer("executable")).ok, true);
  assert.equal((await h.run()).outcome.status, "paused");
  const aggregate = h.get().runtimeV2Checkpoints[h.context.turnId].aggregate;
  assert.equal(aggregate.phase, "reviewing");
  assert.equal(aggregate.run.identity.runId, h.context.harnessRunId);
  assert.equal(h.get().activeActionRequest.kind, "plan_review");
  assert.deepEqual(h.effects, ["read_file"]);
  assert.equal(h.saves.length, 1);
  const rejection = aggregate.events.find(event => event.type === "tool.completed" && event.failureReasonCode === "runtime_v2_plan_submission_validation_rejected");
  assert.match(rejection.modelContent, /plan_validation_not_required/);
  assert.equal(aggregate.events.filter(event => event.type === "run.paused" && event.blocker.questionnaire).length, 1);
  assert.equal(h.calls.length, 4);
  assert.match(JSON.stringify(h.calls.at(-1)[0]), /Use the existing collector state contract/);
  assert.match(JSON.stringify(h.calls.at(-1)[0]), /Observed project facts/);
});

test("live and cold Plan repair receive concrete candidate feedback and retain a new confirmed answer", async () => {
  const followup = followupQuestionCall();
  const responses = [
    questionCall(),
    { content: "", toolCalls: [readinessRead("existing-source", "src/main.js")], protocolViolation: null },
    readinessSubmission("incomplete-acceptance", manualReadinessCheck),
    readinessSubmission("non-accepting-probe", {
      kind: "finite_command",
      command: "unity command editor.playmode start && unity command script eval \"return GameManager.Instance.Score;\" && unity command editor.playmode stop",
      expectedOutcome: "The score increases when the ball hits a brick.",
    }),
    followup,
    readinessSubmission("ready", executableReadinessCheck),
  ];
  const h = harness({ workspace: "/fixture", versionedReads: true, responses });
  assert.equal((await h.run()).outcome.status, "paused");
  assert.equal((await h.answer("executable")).ok, true);
  assert.equal((await h.run()).outcome.status, "paused");
  const paused = h.get().runtimeV2Checkpoints[h.context.turnId].aggregate;
  const rejections = paused.events.filter(event => event.type === "tool.completed" && event.failureReasonCode === "runtime_v2_plan_submission_validation_rejected");
  assert.equal(rejections.length, 2);
  const [advisory, rejected] = rejections;
  assert.equal(h.saves.length, 0);
  assert.match(advisory.modelContent, /plan_validation_not_required/);
  const feedback = JSON.parse(rejected.modelContent.replace(/^WORK_PLAN_REJECTED: /, ""));
  assert.equal(feedback.diagnostics[0].fieldPath, "validations[0].command");
  assert.equal(feedback.diagnostics[0].commandRejectionReason, "unbounded_command_segment");
  assert.match(feedback.diagnostics[0].message, /test.*pass\/fail/i);
  assert.ok(h.calls.at(-1)[0].some(message => message.role === "tool" && message.content === rejected.modelContent));
  rewindTo(h, rejected);
  const beforeRestart = h.calls.length;
  responses.unshift(followup);
  assert.equal((await h.run()).outcome.status, "paused");
  assert.equal(h.calls.length, beforeRestart + 1);
  assert.equal(h.calls.at(-1)[0].filter(message => message.role === "tool" && message.content === rejected.modelContent).length, 1);
  const recoveredPause = h.get().activeActionRequest;
  assert.deepEqual(recoveredPause.questionnaire.questions.map(question => question.id), ["acceptance"]);
  const pending = h.get().runtimeV2Checkpoints[h.context.turnId].aggregate;
  assert.equal(pending.events.filter(event => event.type === "command.scheduled" && event.command.payload.toolCallId === "incomplete-acceptance").length, 1);
  rewindTo(h, pending.events.at(-1));
  assert.equal((await h.run()).outcome.status, "paused");
  assert.equal(h.get().activeActionRequest.requestId, recoveredPause.requestId);
  assert.equal(h.calls.length, beforeRestart + 1, "restoring an unanswered capsule does not call the model");
  const supplement = "Check the offline desktop build.";
  assert.equal((await h.answer("executable", undefined, supplement)).ok, true);
  assert.equal((await h.run()).outcome.status, "paused");
  assert.equal(h.get().activeActionRequest.kind, "plan_review");
  assert.equal(h.get().conversationTurns.length, 1);
  assert.deepEqual(h.effects, ["read_file"]);
  assert.equal(h.calls.length, beforeRestart + 2);
  assert.match(JSON.stringify(h.calls.at(-1)[0]), /Check the offline desktop build/);
  assert.equal(h.saves.length, 1);
  const reviewed = h.get().runtimeV2Checkpoints[h.context.turnId].aggregate;
  assert.equal(reviewed.run.identity.runId, paused.run.identity.runId);
  assert.equal(reviewed.events.filter(event => event.type === "run.started").length, 1);
  assert.equal(reviewed.events.filter(event => event.type === "work_plan.approved").length, 0);
});

test("Plan retains prior confirmed conversation across the interview and same-Run resume without importing tools or hidden turns", async () => {
  const h = harness();
  const current = h.get().conversationTurns[0];
  h.set({ conversationTurns: [{ id: "prior", userPrompt: "Use offline storage and preserve existing names.", summary: "Confirmed: offline storage, preserve names." },
    { id: "internal", uiVisibility: "internal", userPrompt: "INTERNAL_ONLY", summary: "PRIVATE_TOOL_PLAN" }, current] });
  await h.run();
  assert.equal((await h.answer()).ok, true);
  await h.run();
  for (const call of h.calls) {
    const messages = call[0];
    assert.equal(messages.filter(message => message.role === "user" && message.content === "Use offline storage and preserve existing names.").length, 1);
    assert.equal(messages.filter(message => message.role === "assistant" && message.content === "Confirmed: offline storage, preserve names.").length, 1);
    assert.doesNotMatch(JSON.stringify(messages), /INTERNAL_ONLY|PRIVATE_TOOL_PLAN/);
  }
});


for (const frozenRules of ["", "# Original rules\nOffline only."]) test(`Plan resumes with the canonical workspace rules including an explicitly empty admission (${frozenRules ? "present" : "empty"})`, async () => {
  const h = harness();
  h.context.workspaceInstructionContext = frozenRules;
  await h.run();
  assert.equal((await h.answer()).ok, true);
  const persisted = runtime.serializeRuntimeV2CheckpointMap(h.get().runtimeV2Checkpoints)[h.context.turnId];
  const checkpoint = runtime.normalizeRuntimeV2Checkpoint(JSON.parse(JSON.stringify(persisted)));
  assert.ok(checkpoint);
  h.set({ runtimeV2Checkpoints: { [h.context.turnId]: checkpoint } });
  h.context.workspaceInstructionContext = "NEW_RULES_MUST_NOT_REPLACE_ADMISSION";
  await h.run();
  const replay = h.calls.at(-1)[0].map(message => String(message.content)).join("\n");
  assert.doesNotMatch(replay, /NEW_RULES_MUST_NOT_REPLACE_ADMISSION/);
  assert.equal(checkpoint.aggregate.workspaceInstructionContext, frozenRules);
});


for (const prefixLength of [1, 2]) test(`a crash after rules admission (${prefixLength} events) before source inspection recovers the same Run and captures a review base before asking`, async () => {
  const h = harness({ workspace: "/fixture", purpose: "rules", responses: [questionCall(), questionCall(), documentCall()] });
  await h.run();
  const events = h.get().runtimeV2Checkpoints[h.context.turnId].aggregate.events.slice(0, prefixLength);
  const aggregate = runtime.replayRuntimeV2Events(events);
  const prefix = runtime.createRuntimeV2Checkpoint({ revision: events.length, aggregate, updatedAt: events.at(-1).at });
  const persisted = runtime.serializeRuntimeV2CheckpointMap({ [h.context.turnId]: prefix })[h.context.turnId];
  const restored = runtime.normalizeRuntimeV2Checkpoint(JSON.parse(JSON.stringify(persisted)));
  assert.ok(restored);
  h.set({ runtimeV2Checkpoints: { [h.context.turnId]: restored }, activeActionRequest: null, taskFlow: [] });
  h.context.planPurpose = undefined;
  assert.equal((await h.run()).outcome.status, "paused");
  assert.equal(h.get().activeActionRequest.questionnaire.purpose, "rules_interview");
  assert.equal((await h.answer()).ok, true);
  assert.equal((await h.run()).outcome.resultKind, "success");
  assert.equal(h.inspections.length, 2, "the interrupted prefix had no captured version; one new inspection supplies it");
  assert.equal(h.get().rulesDraftReview.inspection.baseVersion, "base-version");
  assert.equal(h.get().runtimeV2Checkpoints[h.context.turnId].aggregate.events.filter(event => event.type === "run.started").length, 1);
});


function rewindTo(h, boundary, mapEvent = event => event) {
  const original = h.get().runtimeV2Checkpoints[h.context.turnId];
  const events = original.aggregate.events.filter(event => event.sequence <= boundary.sequence).map(mapEvent);
  const aggregate = runtime.replayRuntimeV2Events(events);
  const checkpoint = runtime.createRuntimeV2Checkpoint({ revision: events.length, aggregate, updatedAt: events.at(-1).at });
  const disk = runtime.serializeRuntimeV2CheckpointMap({ [h.context.turnId]: checkpoint })[h.context.turnId];
  const restored = runtime.normalizeRuntimeV2Checkpoint(JSON.parse(JSON.stringify(disk)));
  assert.ok(restored);
  h.set({ runtimeV2Checkpoints: { [h.context.turnId]: restored }, activeActionRequest: null, taskFlow: [] });
}

for (const boundaryKind of ["provider.responded", "command.scheduled", "tool.completed"]) {
  test(`cold Plan replays the unsettled reads at ${boundaryKind}`, async () => {
    const responses = [
      questionCall(),
      readinessSubmission("incomplete", manualReadinessCheck),
      { content: "", toolCalls: [
        readinessRead("cold-entry", "package.json"),
        readinessRead("cold-config", "tests/config.json"),
        readinessRead("cold-guide", "README.md"),
      ], protocolViolation: null },
      readinessSubmission("ready", executableReadinessCheck),
    ];
    const h = harness({ workspace: "/fixture", versionedReads: true, responses });
    assert.equal((await h.run()).outcome.status, "paused");
    assert.equal((await h.answer("executable")).ok, true);
    assert.equal((await h.run()).outcome.status, "paused");
    assert.equal(h.get().activeActionRequest.kind, "plan_review");
    const events = h.get().runtimeV2Checkpoints[h.context.turnId].aggregate.events;
    const response = events.find(event => event.type === "provider.responded" &&
      event.result.toolCalls.some(call => call.id === "cold-entry"));
    const scheduledRead = events.find(event => event.type === "command.scheduled" && event.command.payload.toolCallId === "cold-entry");
    const receipt = events.find(event => event.type === "tool.completed" && event.idempotencyKey === scheduledRead.command.idempotencyKey);
    const boundary = boundaryKind === "provider.responded" ? response : boundaryKind === "command.scheduled" ? scheduledRead : receipt;
    rewindTo(h, boundary, event => boundaryKind === "command.scheduled" && event.type === "command.scheduled" &&
      event.command.idempotencyKey === response.idempotencyKey
      ? { ...event, command: { ...event.command, payload: { ...event.command.payload, readinessRepair: "investigate" } } }
      : event);
    h.stored.clear();
    h.saves.length = 0;
    h.effects.length = 0;
    const modelCalls = h.calls.length;
    responses.push(readinessSubmission("ready-after-restart", executableReadinessCheck));

    assert.equal((await h.run()).outcome.status, "paused");
    assert.equal(h.get().activeActionRequest.kind, "plan_review");
    assert.equal(h.calls.length, modelCalls + 1, "resume asks only for the final candidate");
    assert.equal(h.effects.length, boundaryKind === "tool.completed" ? 2 : 3);
    const aggregate = h.get().runtimeV2Checkpoints[h.context.turnId].aggregate;
    assert.equal(aggregate.events.filter(event => event.type === "command.scheduled" && event.command.payload.toolCallId === "cold-entry").length, 1);
    assert.equal(aggregate.events.filter(event => event.type === "run.started").length, 1);
    const messages = h.calls.at(-1)[0];
    for (const id of ["cold-entry", "cold-config", "cold-guide"]) {
      const results = messages.filter(message => message.role === "tool" && message.tool_call_id === id);
      assert.equal(results.length, 1);
      assert.match(results[0].content, /Observed project facts/);
    }
  });
}

for (const boundaryKind of ["provider.responded", "tool.completed"]) test(`cold Plan recovers an unanswered question at ${boundaryKind} without another model request`, async () => {
  const h = harness();
  await h.run();
  const events = h.get().runtimeV2Checkpoints[h.context.turnId].aggregate.events;
  rewindTo(h, events.find(event => event.type === boundaryKind));
  assert.equal((await h.run()).outcome.status, "paused");
  assert.equal(h.calls.length, 1);
  assert.equal(h.get().activeActionRequest.questionnaire.revision, 1);
  assert.equal((await h.answer()).ok, true);
  assert.equal((await h.run()).outcome.resultKind, "success");
});

for (const boundaryKind of ["provider.responded", "command.scheduled", "tool.completed"]) test(`cold executable Plan recovers a new question at ${boundaryKind} without another model request`, async () => {
  const initial = questionCall();
  const late = followupQuestionCall();
  const h = harness({ workspace: "/fixture", responses: [initial, late] });
  await h.run();
  assert.equal((await h.answer("executable")).ok, true);
  assert.equal((await h.run()).outcome.status, "paused");
  const events = h.get().runtimeV2Checkpoints[h.context.turnId].aggregate.events;
  const provider = events.find(event => event.type === "provider.responded" && event.result.toolCalls.some(call => call.id === "ask-late"));
  const boundary = boundaryKind === "provider.responded" ? provider : events.find(event => event.sequence > provider.sequence && event.type === boundaryKind);
  assert.ok(boundary);
  rewindTo(h, boundary);
  assert.equal((await h.run()).outcome.status, "paused");
  assert.equal(h.calls.length, 2);
  assert.equal(h.get().activeActionRequest.questionnaire.revision, 2);
  const recovered = h.get().runtimeV2Checkpoints[h.context.turnId].aggregate;
  assert.equal(recovered.pendingToolCalls.length, 0);
  assert.equal(recovered.events.filter(event => event.type === "tool.completed" && event.status === "succeeded" && event.sequence > provider.sequence).length, 1);
});

test("cold executable Plan returns one repair receipt for a malformed late question", async () => {
  const initial = questionCall();
  const args = JSON.parse(initial.toolCalls[0].arguments);
  args.questions.push({ ...args.questions[0] });
  const malformed = { ...initial, toolCalls: [{ ...initial.toolCalls[0], id: "late-malformed", arguments: JSON.stringify(args) }] };
  const corrected = followupQuestionCall();
  const h = harness({ workspace: "/fixture", responses: [initial, malformed, corrected, corrected] });
  await h.run();
  assert.equal((await h.answer("executable")).ok, true);
  assert.equal((await h.run()).outcome.status, "paused");
  const events = h.get().runtimeV2Checkpoints[h.context.turnId].aggregate.events;
  const provider = events.find(event => event.type === "provider.responded" && event.result.toolCalls.some(call => call.id === "late-malformed"));
  assert.ok(provider);
  rewindTo(h, provider);
  assert.equal((await h.run()).outcome.status, "paused");
  const repair = h.calls.at(-1)[0].filter(message => message.role === "tool" && message.tool_call_id === "late-malformed");
  assert.equal(repair.length, 1);
  assert.doesNotMatch(repair[0].content, /historicalContentUnavailable/);
  assert.equal(h.get().activeActionRequest.questionnaire.revision, 2);
});

for (const boundaryKind of ["provider.responded", "command.scheduled", "tool.completed"]) test(`cold Plan closes the document save window at ${boundaryKind} with one physical document and no regeneration`, async () => {
  const h = harness();
  await h.run(); await h.answer(); await h.run();
  const events = h.get().runtimeV2Checkpoints[h.context.turnId].aggregate.events;
  const provider = events.find(event => event.type === "provider.responded" && event.result.toolCalls.some(call => call.name === "submit_plan_document"));
  const boundary = boundaryKind === "provider.responded" ? provider : events.find(event => event.sequence > provider.sequence && event.type === boundaryKind);
  assert.ok(boundary);
  rewindTo(h, boundary);
  assert.equal((await h.run()).outcome.resultKind, "success");
  assert.equal(h.calls.length, 2, "the complete saved body is already canonical; never ask a model to regenerate it");
  assert.equal(h.stored.size, 1, "the native exact-content lost-ack retry is physically idempotent");
  const aggregate = h.get().runtimeV2Checkpoints[h.context.turnId].aggregate;
  assert.equal(aggregate.events.filter(event => event.type === "run.completed").length, 1);
  assert.equal(aggregate.events.filter(event => event.type === "turn.completed").length, 1);
});

test("cold Plan settles an interrupted provider command before retrying the same interview", async () => {
  const h = harness({ responses: [questionCall(), questionCall(), documentCall()] });
  await h.run();
  const command = h.get().runtimeV2Checkpoints[h.context.turnId].aggregate.events.find(event => event.type === "command.scheduled" && event.command.kind === "request_model");
  rewindTo(h, command);
  assert.equal((await h.run()).outcome.status, "paused");
  const aggregate = h.get().runtimeV2Checkpoints[h.context.turnId].aggregate;
  assert.equal(aggregate.scheduledCommands.length, 0);
  assert.equal(aggregate.pendingToolCalls.length, 0);
  assert.ok(aggregate.events.some(event => event.type === "command.completed" && event.idempotencyKey === command.command.idempotencyKey && event.status === "failed"));
  assert.equal((await h.answer()).ok, true);
  assert.equal((await h.run()).outcome.resultKind, "success");
});

test("time spent answering a structured interview is new user information, not a provider semantic stall", async () => {
  const h = harness();
  await h.run();
  const originalNow = Date.now;
  const afterUserWait = Date.now() + 11 * 60_000;
  try {
    Date.now = () => afterUserWait;
    assert.equal((await h.answer()).ok, true);
    assert.equal((await h.run()).outcome.resultKind, "success");
    assert.equal(h.saves.length, 1);
    const aggregate = h.get().runtimeV2Checkpoints[h.context.turnId].aggregate;
    assert.equal(aggregate.workPlan, null, "information progress is not execution authority");
  } finally { Date.now = originalNow; }
});


test("structured answers cannot renew an explicit canonical caller deadline", async () => {
  const h = harness();
  h.input.lifecycleDeadlineAt = Date.now() + 5 * 60_000;
  await h.run();
  const originalNow = Date.now;
  const afterUserWait = Date.now() + 11 * 60_000;
  try {
    Date.now = () => afterUserWait;
    assert.equal((await h.answer()).ok, true);
    h.input.lifecycleDeadlineAt = undefined;
    assert.equal((await h.run()).outcome.resultKind, "error");
    assert.equal(h.calls.length, 1, "an expired explicit deadline admits no model request after restart");
    assert.equal(h.saves.length, 0);
  } finally { Date.now = originalNow; }
});


test("the decision journal retains complete free text and per-question traceability without truncating it into assumptions", () => {
  const text = "A user-owned constraint.\n\n".repeat(800) + "JOURNAL_TAIL_974";
  const questionnaire = { revision: 3, purpose: "plan_interview", title: "Detailed choices", questions: [{ id: "details", prompt: "Which constraints matter?", selectionMode: "text", required: true }] };
  const requestId = "traceable-question-3";
  const aggregate = { events: [
    { type: "run.paused", blocker: { requestId, questionnaire } },
    { type: "run.decision_recorded", requestId, choice: "recheck", answer: { requestId, revision: 3, answers: [{ questionId: "details", selectedValues: [], text }] } },
  ] };
  const { buildPlanDecisionJournal } = loader()("src/lib/planDecisionJournal.ts");
  const journal = buildPlanDecisionJournal(aggregate);
  assert.ok(journal.includes(text.trim().replace(/\n/g, "\n> ")));
  assert.match(journal, /traceable-question-3.*revision 3/);
  assert.match(journal, /JOURNAL_TAIL_974/);
  assert.doesNotMatch(journal, /## 假设|truncated|omitted/);
});


test("question requests remain unique across same-clock resumed rounds, with revision bound in their durable identity", async () => {
  const originalNow = Date.now;
  const at = Date.now();
  try {
    Date.now = () => at;
    const h = harness({ responses: [questionCall(), followupQuestionCall(),
      followupQuestionCall("How long should we retain local records?"), documentCall()] });
    const requests = [];
    for (let index = 0; index < 3; index++) {
      assert.equal((await h.run()).outcome.status, "paused");
      requests.push(h.get().activeActionRequest.requestId);
      assert.equal((await h.answer("document", undefined, index === 1 ? "Desktop" : "Seven days")).ok, true);
    }
    assert.equal(new Set(requests).size, 3);
    assert.equal((await h.run()).outcome.resultKind, "success");
  } finally { Date.now = originalNow; }
});


for (const { cold, purpose, workspace } of [{ cold: false, purpose: "plan", workspace: "" }, { cold: true, purpose: "plan", workspace: "" }, { cold: true, purpose: "rules", workspace: "/fixture" }]) test(`document I/O failure pauses without model resynthesis, then recheck saves the exact original ${purpose} body${cold ? " after JSON restore" : ""}`, async () => {
  const h = harness({ purpose, workspace });
  await h.run(); await h.answer();
  h.setSaveFault("EACCES: fixture plan storage is unavailable");
  assert.equal((await h.run()).outcome.status, "paused");
  assert.equal(h.calls.length, 2, "save errors must never trigger another model request");
  assert.equal(h.saves.length, 1);
  const originalSave = structuredClone(h.saves[0]);
  let checkpoint = h.get().runtimeV2Checkpoints[h.context.turnId];
  assert.equal(checkpoint.aggregate.run.blocker.reasonCode, "document_save_failed");
  assert.equal(checkpoint.aggregate.terminalOutcome, null);
  assert.equal(checkpoint.aggregate.workPlan, null);
  assert.equal(h.stored.size, 0);
  assert.deepEqual(h.get().activeActionRequest.optionValues, ["recheck", "stop"]);
  assert.match(h.get().activeActionRequest.title, /save|保存/i);
  const restoredControl = h.load("src/lib/actionRequestRestore.ts").restorePendingActionRequest({
    request: h.get().activeActionRequest, runOwner: { ...h.get().harnessRunMarker, status: "paused" }, taskFlow: h.get().taskFlow,
    unapprovedPlanTurnIds: [h.context.turnId], planIdentity: { revision: 4, artifactHash: "older-reviewed-plan", artifactPaths: [".MAIN/plans/plan.md"] },
  });
  assert.ok(restoredControl, "a canonical I/O blocker cannot be folded into an unrelated prior Plan artifact by prose heuristics");
  assert.match(checkpoint.aggregate.run.blocker.message, /EACCES/);
  const failed = checkpoint.aggregate.events.find(event => event.type === "tool.completed" && event.failureReasonCode === "plan_document_save_failed");
  assert.equal(failed.status, "failed");
  assert.deepEqual(failed.evidence, []);
  if (cold) {
    const disk = runtime.serializeRuntimeV2CheckpointMap(h.get().runtimeV2Checkpoints)[h.context.turnId];
    checkpoint = runtime.normalizeRuntimeV2Checkpoint(JSON.parse(JSON.stringify(disk)));
    assert.ok(checkpoint);
    h.set({ runtimeV2Checkpoints: { [h.context.turnId]: checkpoint }, activeActionRequest: null, taskFlow: [] });
    assert.equal((await h.run()).outcome.status, "paused");
  }
  h.setSaveFault(null);
  assert.equal((await h.run()).outcome.status, "paused", "a recovered environment alone does not consume the user's retry choice");
  assert.equal(h.saves.length, 1);
  assert.equal((await h.decide()).ok, true);
  assert.equal((await h.run()).outcome.resultKind, "success");
  assert.equal(h.calls.length, 2);
  assert.equal(h.saves.length, 2);
  assert.deepEqual(h.saves[1], originalSave);
  assert.equal(h.stored.size, 1);
  assert.equal(h.effects.length, 0, "document retry does not acquire workspace write authority");
  checkpoint = h.get().runtimeV2Checkpoints[h.context.turnId];
  assert.equal(checkpoint.aggregate.events.filter(event => event.type === "run.started").length, 1);
  assert.equal(checkpoint.aggregate.events.filter(event => event.type === "turn.completed").length, 1);
});

test("a failed save receipt interrupted before pause restores only the I/O blocker, and Stop never writes or approves", async () => {
  const h = harness();
  await h.run(); await h.answer(); h.setSaveFault("ENOSPC: no plan storage space");
  await h.run();
  const failed = h.get().runtimeV2Checkpoints[h.context.turnId].aggregate.events.find(event => event.type === "tool.completed" && event.failureReasonCode === "plan_document_save_failed");
  rewindTo(h, failed);
  h.setSaveFault(null);
  assert.equal((await h.run()).outcome.status, "paused");
  assert.equal(h.calls.length, 2);
  assert.equal(h.saves.length, 1, "missing pause is not implicit user retry permission");
  const stopped = await h.decide("stop");
  assert.equal(stopped.ok, true); assert.equal(stopped.stopped, 1); assert.equal(stopped.dispatched, 0);
  assert.equal((await h.run()).outcome.status, "paused", "the shared Stop callback owns cancellation; the stopped producer performs no work");
  assert.equal(h.saves.length, 1);
  assert.equal(h.get().runtimeV2Checkpoints[h.context.turnId].aggregate.workPlan, null);
});

test("a second actual I/O failure creates a new exact retry request without asking a model again", async () => {
  const h = harness();
  await h.run(); await h.answer(); h.setSaveFault("EROFS: plan storage is read-only");
  await h.run();
  const oldIdentity = h.load("src/lib/actionRequest.ts").toUserChoiceResolutionIdentity(h.get().activeActionRequest);
  assert.equal((await h.decide()).ok, true);
  assert.equal((await h.run()).outcome.status, "paused");
  assert.equal(h.saves.length, 2);
  assert.deepEqual(h.saves[1], h.saves[0]);
  assert.equal(h.calls.length, 2);
  assert.notEqual(h.get().activeActionRequest.requestId, oldIdentity.requestId);
  assert.equal((await h.decide("recheck", oldIdentity)).ok, false);
  assert.equal(h.saves.length, 2);
  h.setSaveFault(null);
  assert.equal((await h.decide()).ok, true);
  assert.equal((await h.run()).outcome.resultKind, "success");
  assert.equal(h.calls.length, 2);
  assert.equal(h.stored.size, 1);
});

for (const boundaryKind of ["run.resumed", "command.scheduled"]) test(`a rechecked save recovers its original body at ${boundaryKind} without a new model response`, async () => {
  const h = harness();
  await h.run(); await h.answer(); h.setSaveFault("EACCES: no write access");
  await h.run(); await h.decide(); h.setSaveFault(null); await h.run();
  const aggregate = h.get().runtimeV2Checkpoints[h.context.turnId].aggregate;
  const retryCommand = aggregate.events.find(event => event.type === "command.scheduled" && event.command.payload.runtimeDocumentRetryOf);
  const boundary = boundaryKind === "command.scheduled" ? retryCommand : [...aggregate.events].reverse().find(event => event.type === "run.resumed");
  rewindTo(h, boundary);
  assert.equal((await h.run()).outcome.resultKind, "success");
  assert.equal(h.calls.length, 2);
  assert.equal(h.stored.size, 1);
  assert.ok(h.saves.every(input => JSON.stringify(input) === JSON.stringify(h.saves[0])));
});

test("the document producer projects each prose provider response exactly once in the next live request", async () => {
  const publicText = "One concrete technical constraint remains; I will use the available interview or save tools.";
  const h = harness({ workspace: "/fixture", purpose: "rules", responses: [questionCall(), { content: publicText, toolCalls: [], protocolViolation: null }, documentCall()] });
  await h.run(); await h.answer();
  assert.equal((await h.run()).outcome.resultKind, "success");
  const nextRequest = h.calls.at(-1)[0];
  assert.equal(nextRequest.filter(message => message.role === "assistant" && message.content === publicText).length, 1);
  assert.equal(h.get().runtimeV2Checkpoints[h.context.turnId].aggregate.events.filter(event => event.type === "provider.responded" && event.result.visibleText === publicText).length, 1);
});

test("the document producer retains exactly one native assistant/tool pair for a live discovery read", async () => {
  const read = { content: "Inspect the declared source contract.", toolCalls: [{ id: "source-discovery", name: "read_file", arguments: JSON.stringify({ path: "src/main.js" }) }], protocolViolation: null };
  const h = harness({ workspace: "/fixture", purpose: "rules", responses: [read, questionCall(), documentCall()] });
  const settlement = await h.run();
  assert.equal(settlement.outcome.status, "paused", JSON.stringify({ settlement, logs: h.logs }));
  const nextRequest = h.calls[1][0];
  assert.equal(nextRequest.filter(message => message.role === "assistant" && message.tool_calls?.some(call => call.id === "source-discovery")).length, 1);
  assert.equal(nextRequest.filter(message => message.role === "tool" && message.tool_call_id === "source-discovery").length, 1);
  const aggregate = h.get().runtimeV2Checkpoints[h.context.turnId].aggregate;
  assert.equal(aggregate.events.filter(event => event.type === "provider.responded" && event.result.toolCalls.some(call => call.id === "source-discovery")).length, 1);
});

for (const invalidQuestion of [
  { id: "rule_scope", prompt: "Which constraints should be hard rules?", selectionMode: "single" },
  { id: "rule_scope", prompt: "Which constraints should be hard rules?", selectionMode: "multiple", options: [] },
  { id: "rule_scope", prompt: "Which constraints should be hard rules?", selectionMode: "single", options: [{ id: "same", label: "First" }, { id: "same", label: "Second" }] },
]) test(`invalid model questions report the exact options field without inventing user choices (${invalidQuestion.options === undefined ? "missing" : !invalidQuestion.options.length ? "empty" : "duplicate"})`, async () => {
  const before = JSON.stringify(invalidQuestion);
  const bad = { content: "", toolCalls: [{ id: "bad-question", name: "ask_plan_questions", arguments: JSON.stringify({ title: "Scope confirmation", questions: [invalidQuestion] }) }], protocolViolation: null };
  const h = harness({ workspace: "/fixture", purpose: "rules", responses: [bad, questionCall(), documentCall()] });
  assert.equal((await h.run()).outcome.status, "paused");
  assert.equal(h.saves.length, 0);
  assert.equal(h.calls.length, 2, "only a corrected provider definition can create the actual user request");
  const feedback = h.calls[1][0].filter(message => message.role === "tool").map(message => String(message.content)).join("\n");
  assert.match(feedback, /questions\[0\]\.options/);
  if (invalidQuestion.options) assert.match(feedback, /rule_scope/);
  assert.deepEqual(h.get().activeActionRequest.questionnaire.questions[0].options.map(option => option.id), ["simple", "offline"]);
  assert.equal(h.get().runtimeV2Checkpoints[h.context.turnId].aggregate.events.filter(event => event.type === "run.paused").length, 1);
  assert.equal(JSON.stringify(invalidQuestion), before);
});

for (const purpose of ["plan", "rules"]) test(`${purpose} document producer formats only new multiline display title metadata`, async () => {
  const rawTitle = "Confirmed\n design\r\n and\tconstraints\u0000";
  const markdown = "# Confirmed design\n\nPreserve the exact body and final newline.\n";
  const submit = { content: "", toolCalls: [{ id: "multiline-title-submit", name: "submit_plan_document",
    arguments: JSON.stringify({ title: rawTitle, markdown }) }], protocolViolation: null };
  const h = harness({ workspace: purpose === "rules" ? "/fixture" : "", purpose, responses: [questionCall(), submit] });
  assert.equal((await h.run()).outcome.status, "paused");
  assert.equal((await h.answer()).ok, true);
  assert.equal((await h.run()).outcome.resultKind, "success");
  assert.equal(h.saves.length, 1);
  assert.equal(h.saves[0].title, "Confirmed design and constraints");
  const aggregate = h.get().runtimeV2Checkpoints[h.context.turnId].aggregate;
  const original = aggregate.events.find(event => event.type === "provider.responded" && event.result.toolCalls.some(call => call.id === "multiline-title-submit"));
  assert.equal(original.result.toolCalls[0].arguments.title, rawTitle, "canonical model arguments stay verbatim");
  const saved = h.load("src/lib/planDocumentRecords.ts").resolvePlanDocumentFromAggregate(aggregate);
  assert.equal(saved.documentRef.title, h.saves[0].title);
  assert.equal(saved.documentRef.contentHash, sha(h.saves[0].markdown));
  assert.equal(saved.markdown, h.saves[0].markdown);
  const canonicalBody = original.result.toolCalls[0].arguments.markdown;
  if (purpose === "rules") assert.equal(saved.markdown, canonicalBody);
  else assert.ok(saved.markdown.startsWith(canonicalBody));
  assert.equal(aggregate.events.some(event => event.type === "work_plan.approved"), false);
  assert.equal(h.effects.length, 0);
  const raw = runtime.serializeRuntimeV2CheckpointMap(h.get().runtimeV2Checkpoints)[h.context.turnId];
  const restored = runtime.normalizeRuntimeV2Checkpoint(JSON.parse(JSON.stringify(raw)));
  assert.deepEqual(h.load("src/lib/planDocumentRecords.ts").resolvePlanDocumentFromAggregate(restored.aggregate), saved);
});

test("a historical pending document save retains its exact original title for lost-ack CAS", async () => {
  const h = harness();
  await h.run(); await h.answer(); h.setSaveFault("EACCES: unavailable"); await h.run();
  const aggregate = h.get().runtimeV2Checkpoints[h.context.turnId].aggregate;
  const pending = aggregate.events.find(event => event.type === "command.scheduled" && event.command.payload.runtimeOwnedPlanDocumentSave === true);
  const legacyTitle = "Historical\n exact title";
  const events = aggregate.events.filter(event => event.sequence <= pending.sequence).map(event => {
    if (event !== pending) return event;
    return { ...event, command: { ...event.command, payload: { ...event.command.payload,
      planDocumentSaveInput: { ...event.command.payload.planDocumentSaveInput, title: legacyTitle } } } };
  });
  const replay = runtime.replayRuntimeV2Events(JSON.parse(JSON.stringify(events)));
  const recovery = h.load("src/store/runtimeV2/planDocumentSavePort.ts").resolvePlanDocumentSaveRecovery(replay);
  assert.equal(recovery.pending, true);
  assert.equal(recovery.saveInput.title, legacyTitle, "new metadata formatting must not rewrite persisted idempotency input");
  assert.equal(recovery.saveInput.markdown, h.saves[0].markdown);
  assert.deepEqual(recovery.saveInput.owner, h.saves[0].owner);
});
