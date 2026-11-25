import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createTsModuleLoader } from "./tsModuleLoader.mjs";

function makeWorkspace(t) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "main-subagent-staging-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  return workspace;
}

test("implement child stages multiple write_file targets and apply_patch Add File without read_file, rejecting existing or mismatched-op targets", async (t) => {
  const workspace = makeWorkspace(t);
  const { sha256Hex } = createTsModuleLoader()("src/lib/sha256.ts");
  fs.mkdirSync(path.join(workspace, "Assets/Pool"), { recursive: true });
  fs.writeFileSync(path.join(workspace, "Assets/Pool/AlreadyHere.cs"), "// existing\n");

  const load = createTsModuleLoader({
    "../../lib/ipc": {
      getFileMetadata: async (target) => {
        const full = path.join(workspace, target);
        if (!fs.existsSync(full)) throw new Error(`FILE_METADATA_NOT_FOUND: ${target}`);
        return { path: target, sizeBytes: fs.statSync(full).size };
      },
      checkSourceSyntax: async () => ({ ok: true, diagnostics: [] }),
      findSymbolReferences: async () => ({ references: [] }),
    },
    "../../lib/toolExecutor": {
      executeTool: async (name, args) => {
        if (name === "read_file") return fs.readFileSync(path.join(workspace, args.path), "utf8");
        if (name === "write_file") {
          const full = path.join(workspace, args.path);
          fs.mkdirSync(path.dirname(full), { recursive: true });
          fs.writeFileSync(full, args.content);
          return JSON.stringify({ success: true });
        }
        return JSON.stringify({ success: true });
      },
    },
    "./executionAuthorization": {
      authorizationFor: () => ({ toolCatalog: {} }),
      authorizeToolForCurrentTurn: async () => ({ allowed: true, reason: null, approvalRequired: false }),
    },
  });

  const { stageRuntimeV2ChildMutation, commitRuntimeV2StagedChildBatch } = load("src/store/runtimeV2/executionSubagentMutation.ts");
  const { upsertStagedChildMutation, allAllowedTargetsStaged } = load("src/store/runtimeV2/executionSubagentStaging.ts");

  const run = { sessionKey: `${workspace}:1`, sessionEpoch: "e1", turnId: "t1", runId: "r1", parentRunId: null, attemptId: "a1" };
  const job = {
    id: "child-multi",
    run: { ...run, runId: "child-run", parentRunId: "r1" },
    parentRunId: "r1",
    scopeKey: "pool-multi",
    taskKind: "implement",
    accessMode: "write",
    implementationOperation: "create",
    implementationPlan: "Create A.cs and B.cs",
    objective: "Create A.cs and B.cs",
    successCriteria: "Both files created",
    allowedPaths: ["Assets/Pool/A.cs", "Assets/Pool/B.cs", "Assets/Pool/AlreadyHere.cs"],
    status: "running",
    requestedAt: 1,
    firstTokenAt: null,
    closedAt: null,
    summary: null,
  };
  const ports = {
    context: { runWorkspace: workspace, runSessionKey: run.sessionKey, phaseLanguage: "en" },
    live: {
      childWriteScopes: new Map(),
      mutationSourceCoverageByToolCallId: new Map(),
      latestProviderRequestSourceCoverage: [],
      hasExecutedMutationEffect: false,
    },
    get: () => ({ currentTurnId: "t1", conversationTurns: [], runtimeV2Checkpoints: {} }),
    logStoreEvent() {},
  };

  const stagedList = [];
  const stageA = await stageRuntimeV2ChildMutation({
    ports,
    job,
    call: { id: "c1", name: "write_file", arguments: { path: "Assets/Pool/A.cs", content: "public class A {}\n" } },
    observedTargets: new Set(),
    evidenceId: "ev-a",
  });
  assert.equal(stageA.allowed, true);
  assert.equal(upsertStagedChildMutation(stagedList, stageA.staged).ok, true);
  assert.equal(allAllowedTargetsStaged(["Assets/Pool/A.cs", "Assets/Pool/B.cs"], stagedList), false);

  // Add File via apply_patch requires NO read_file when absent on disk
  const patchB = [
    "*** Begin Patch",
    "*** Add File: Assets/Pool/B.cs",
    "+public class B {}",
    "*** End Patch",
  ].join("\n");
  const stageB = await stageRuntimeV2ChildMutation({
    ports,
    job,
    call: { id: "c2", name: "apply_patch", arguments: { patch: patchB } },
    observedTargets: new Set(),
    evidenceId: "ev-b",
  });
  assert.equal(stageB.allowed, true);
  assert.equal(upsertStagedChildMutation(stagedList, stageB.staged).ok, true);
  assert.equal(allAllowedTargetsStaged(["Assets/Pool/A.cs", "Assets/Pool/B.cs"], stagedList), true);

  // Staging Add File against existing file on disk must fail
  const stageExisting = await stageRuntimeV2ChildMutation({
    ports,
    job,
    call: {
      id: "c3",
      name: "apply_patch",
      arguments: { patch: "*** Begin Patch\n*** Add File: Assets/Pool/AlreadyHere.cs\n+oops\n*** End Patch" },
    },
    observedTargets: new Set(),
    evidenceId: "ev-dup",
  });
  assert.equal(stageExisting.allowed, false);
  assert.match(stageExisting.message, /already exists on disk/i);

  // Mixed operations in apply_patch must fail per-target check
  const stageMixed = await stageRuntimeV2ChildMutation({
    ports,
    job,
    call: {
      id: "c4",
      name: "apply_patch",
      arguments: {
        patch: "*** Begin Patch\n*** Add File: Assets/Pool/C.cs\n+class C {}\n*** Update File: Assets/Pool/AlreadyHere.cs\n@@\n-// existing\n+// changed\n*** End Patch",
      },
    },
    observedTargets: new Set(),
    evidenceId: "ev-mixed",
  });
  assert.equal(stageMixed.allowed, false);
  assert.match(stageMixed.message, /per-target operation "modify"/i);

  // During staging disk remains untouched
  assert.equal(fs.existsSync(path.join(workspace, "Assets/Pool/A.cs")), false);
  assert.equal(fs.existsSync(path.join(workspace, "Assets/Pool/B.cs")), false);
});

test("two-phase atomic join commit preserves externally created/modified files and aborts whole batch without partial writes", async (t) => {
  const workspace = makeWorkspace(t);
  const { sha256Hex } = createTsModuleLoader()("src/lib/sha256.ts");
  fs.mkdirSync(path.join(workspace, "Assets/Core"), { recursive: true });
  const written = [];

  const load = createTsModuleLoader({
    "../../lib/ipc": {
      getFileMetadata: async (target) => {
        const full = path.join(workspace, target);
        if (!fs.existsSync(full)) throw new Error(`FILE_METADATA_NOT_FOUND: ${target}`);
        return { path: target, sizeBytes: fs.statSync(full).size };
      },
      checkSourceSyntax: async () => ({ ok: true, diagnostics: [] }),
      findSymbolReferences: async () => ({ references: [] }),
    },
    "../../lib/toolExecutor": {
      executeTool: async (name, args) => {
        if (name === "read_file") return fs.readFileSync(path.join(workspace, args.path), "utf8");
        if (name === "write_file") {
          const full = path.join(workspace, args.path);
          fs.mkdirSync(path.dirname(full), { recursive: true });
          fs.writeFileSync(full, args.content);
          written.push(args.path);
          return JSON.stringify({ success: true });
        }
        return JSON.stringify({ success: true });
      },
    },
    "./executionAuthorization": {
      authorizationFor: () => ({ toolCatalog: {} }),
      authorizeToolForCurrentTurn: async () => ({ allowed: true, reason: null, approvalRequired: false }),
    },
  });

  const kernel = load("src/lib/runtime-v2/index.ts");
  const review = load("src/store/runtimeV2/workPlanAdapter.ts");
  const { stageRuntimeV2ChildMutation, commitRuntimeV2StagedChildBatch } = load("src/store/runtimeV2/executionSubagentMutation.ts");
  const turn = { workspaceKey: workspace, sessionKey: `${workspace}:1`, sessionEpoch: "e1", clientSubmissionId: "s1", turnId: "t1" };
  const run = { sessionKey: turn.sessionKey, sessionEpoch: turn.sessionEpoch, turnId: turn.turnId, runId: "r1", parentRunId: null, attemptId: "a1" };
  const plan = kernel.sealWorkPlanV1({
    createdAt: 1,
    evidence: [],
    draft: {
      schemaVersion: kernel.WORK_PLAN_V1_SCHEMA_VERSION,
      objective: "Create One.cs and Two.cs, plus modify M1.cs and M2.cs",
      summary: "Atomic batch test",
      findings: [],
      risks: [],
      assumptions: [],
      blockingQuestions: [],
      sameTurnDefectCorrection: "authorized",
      steps: [
        { title: "One & Two", operation: "create", targets: ["Assets/Core/One.cs", "Assets/Core/Two.cs"], basis: [], change: "Create both", expectedOutcome: "Both created", dependsOn: [] },
        { title: "M1 & M2", operation: "modify", targets: ["Assets/Core/M1.cs", "Assets/Core/M2.cs"], basis: [], change: "Modify both", expectedOutcome: "Both modified", dependsOn: [0] },
      ],
      validations: [{ kind: "advisory", stepIndexes: [0, 1], expectedOutcome: "Manual check", required: false }],
    },
  });
  const commitMeta = review.createRuntimeV2PlanReviewCommit({ plan, turn, run, requestId: "req-atomic", createdAt: 1 });
  const mkEv = (st, type, fields = {}) => kernel.transition(st, {
    schemaVersion: kernel.RUNTIME_V2_EVENT_SCHEMA_VERSION,
    sequence: st ? st.nextSequence : 0,
    eventId: `atomic-ev-${(st?.nextSequence ?? 0) + 1}`,
    at: (st?.updatedAt ?? 0) + 1,
    type,
    ...fields,
  });
  let state = mkEv(null, "turn.admitted", { turn, strategy: "plan", objective: plan.draft.objective, constraints: [], acceptanceCriteria: [] });
  state = mkEv(state, "run.started", { run, phase: "planning" });
  state = mkEv(state, "work_plan.sealed", { run, workPlan: review.toRuntimeV2WorkPlanReference(plan), sealedPlan: plan, reviewCommit: commitMeta });
  state = mkEv(state, "work_plan.approved", { run, workPlan: review.toRuntimeV2WorkPlanReference(plan, "approved") });
  state = mkEv(state, "phase.changed", { run, phase: "acting", reason: "Ready" });

  const job = {
    id: "child-atomic",
    run: { ...run, runId: "child-run", parentRunId: "r1" },
    parentRunId: "r1",
    scopeKey: "atomic-batch",
    taskKind: "implement",
    accessMode: "write",
    implementationOperation: "create",
    implementationPlan: "Create One.cs and Two.cs",
    objective: "Create One.cs and Two.cs",
    successCriteria: "Both created cleanly",
    allowedPaths: ["Assets/Core/One.cs", "Assets/Core/Two.cs"],
    status: "running",
    requestedAt: 1,
    firstTokenAt: null,
    closedAt: null,
    summary: null,
  };
  const ports = {
    context: { turnId: "t1", runWorkspace: workspace, runSessionKey: turn.sessionKey, phaseLanguage: "en" },
    live: { childWriteScopes: new Map(), mutationSourceCoverageByToolCallId: new Map(), latestProviderRequestSourceCoverage: [], hasExecutedMutationEffect: false },
    get: () => ({
      currentTurnId: "t1",
      conversationTurns: [{ id: "t1", status: "executing" }],
      runtimeV2Checkpoints: {
        t1: kernel.createRuntimeV2Checkpoint({ aggregate: state, revision: state.nextSequence, updatedAt: state.updatedAt }),
      },
    }),
    logStoreEvent() {},
  };

  const s1 = await stageRuntimeV2ChildMutation({
    ports, job,
    call: { id: "c1", name: "write_file", arguments: { path: "Assets/Core/One.cs", content: "class One {}\n" } },
    observedTargets: new Set(), evidenceId: "ev-1",
  });
  const s2 = await stageRuntimeV2ChildMutation({
    ports, job,
    call: { id: "c2", name: "write_file", arguments: { path: "Assets/Core/Two.cs", content: "class Two {}\n" } },
    observedTargets: new Set(), evidenceId: "ev-2",
  });
  assert.equal(s1.allowed && s2.allowed, true);

  // External file created before join commit!
  fs.writeFileSync(path.join(workspace, "Assets/Core/Two.cs"), "// user external version\n");

  const commit = await commitRuntimeV2StagedChildBatch({
    ports,
    parentCommand: { idempotencyKey: "join-1", kind: "join_subagents", run, phase: "acting", payload: {} },
    job,
    stagedList: [s1.staged, s2.staged],
  });
  assert.equal(commit.committed, false);
  assert.match(commit.message, /created externally before child join/i);
  assert.deepEqual(written, [], "One.cs was NOT written because Phase 1 rejected before Phase 2");
  assert.equal(fs.existsSync(path.join(workspace, "Assets/Core/One.cs")), false);
  assert.equal(fs.readFileSync(path.join(workspace, "Assets/Core/Two.cs"), "utf8"), "// user external version\n");

  // Also test external modification on an approved `modify` batch [M1.cs, M2.cs]
  fs.writeFileSync(path.join(workspace, "Assets/Core/M1.cs"), "class M1 {}\n");
  fs.writeFileSync(path.join(workspace, "Assets/Core/M2.cs"), "class M2 {}\n");
  state = mkEv(state, "command.scheduled", {
    run, command: { idempotencyKey: "seed-create-1", kind: "execute_tool", run, phase: "acting", payload: { toolName: "write_file", arguments: { path: "Assets/Core/One.cs" } } },
  });
  state = mkEv(state, "tool.completed", {
    run, idempotencyKey: "seed-create-1", status: "succeeded", effectKind: "workspace_change",
    mutationRequests: [{ target: "Assets/Core/One.cs", operation: "create" }],
    evidence: [{ id: "mc1", kind: "mutation", target: "Assets/Core/One.cs", version: "sha256-" + "1".repeat(64) }],
  });
  state = mkEv(state, "command.scheduled", {
    run, command: { idempotencyKey: "seed-create-2", kind: "execute_tool", run, phase: "acting", payload: { toolName: "write_file", arguments: { path: "Assets/Core/Two.cs" } } },
  });
  state = mkEv(state, "tool.completed", {
    run, idempotencyKey: "seed-create-2", status: "succeeded", effectKind: "workspace_change",
    mutationRequests: [{ target: "Assets/Core/Two.cs", operation: "create" }],
    evidence: [{ id: "mc2", kind: "mutation", target: "Assets/Core/Two.cs", version: "sha256-" + "2".repeat(64) }],
  });
  state = mkEv(state, "observation.recorded", {
    run, evidence: { id: "src-m1", kind: "source", target: "Assets/Core/M1.cs", version: sha256Hex("class M1 {}\n") },
  });
  state = mkEv(state, "observation.recorded", {
    run, evidence: { id: "src-m2", kind: "source", target: "Assets/Core/M2.cs", version: sha256Hex("class M2 {}\n") },
  });
  const modJob = {
    ...job,
    id: "child-mod-atomic",
    implementationOperation: "modify",
    allowedPaths: ["Assets/Core/M1.cs", "Assets/Core/M2.cs"],
  };
  const m1Stage = await stageRuntimeV2ChildMutation({
    ports, job: modJob,
    call: { id: "m1", name: "replace_in_file", arguments: { path: "Assets/Core/M1.cs", diff: "<<<<<<< SEARCH\nclass M1 {}\n=======\nclass M1 { int v = 1; }\n>>>>>>> REPLACE" } },
    observedTargets: new Set(["Assets/Core/M1.cs", "Assets/Core/M2.cs"]),
    evidenceId: "ev-m1",
  });
  const m2Stage = await stageRuntimeV2ChildMutation({
    ports, job: modJob,
    call: { id: "m2", name: "replace_in_file", arguments: { path: "Assets/Core/M2.cs", diff: "<<<<<<< SEARCH\nclass M2 {}\n=======\nclass M2 { int v = 2; }\n>>>>>>> REPLACE" } },
    observedTargets: new Set(["Assets/Core/M1.cs", "Assets/Core/M2.cs"]),
    evidenceId: "ev-m2",
  });
  assert.equal(m1Stage.allowed && m2Stage.allowed, true);
  // External edit alters M2.cs before join
  fs.writeFileSync(path.join(workspace, "Assets/Core/M2.cs"), "// external edit to M2\n");
  const modCommit = await commitRuntimeV2StagedChildBatch({
    ports,
    parentCommand: { idempotencyKey: "join-2", kind: "join_subagents", run, phase: "acting", payload: {} },
    job: modJob,
    stagedList: [m1Stage.staged, m2Stage.staged],
  });
  assert.equal(modCommit.committed, false);
  assert.match(modCommit.message, /changed externally before child join/i);
  assert.equal(fs.readFileSync(path.join(workspace, "Assets/Core/M1.cs"), "utf8"), "class M1 {}\n");
  assert.equal(fs.readFileSync(path.join(workspace, "Assets/Core/M2.cs"), "utf8"), "// external edit to M2\n");
});
