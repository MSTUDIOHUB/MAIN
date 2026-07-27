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
const adapter = loadTs(path.join(workspaceRoot, "src/store/runtimeV2/workPlanAdapter.ts"));

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
  runId: "run-a",
  parentRunId: null,
  attemptId: "attempt-a",
};

function createPlan(overrides = {}) {
  return runtime.sealWorkPlanV1({
    draft: {
      schemaVersion: runtime.WORK_PLAN_V1_SCHEMA_VERSION,
      objective: "修复文件打开与标签显示",
      summary: "统一打开事件与标签生命周期，避免把未命名文档和已打开文件同时显示。",
      findings: [
        { statement: "初始未命名标签与文件标签来自两个入口。", basis: ["E1"] },
      ],
      steps: [
        {
          title: "统一文件打开入口",
          operation: "modify",
          targets: ["src/main.js"],
          basis: ["E1"],
          change: "只由一个入口创建或替换标签。",
          expectedOutcome: "打开文件时只显示对应文件标签。",
          dependsOn: [],
        },
        {
          title: "修正保存路径判定",
          operation: "modify",
          targets: ["src/components/editor.js"],
          basis: ["E2"],
          change: "已打开文件保留真实路径，只有无路径文档进入另存为。",
          expectedOutcome: "打开文件后不会误弹保存窗口。",
          dependsOn: [0],
        },
      ],
      validations: [
        {
          stepIndexes: [0, 1],
          kind: "finite_command",
          command: "npm run build",
          expectedOutcome: "构建通过。",
          required: true,
        },
      ],
      risks: [],
      assumptions: [],
      blockingQuestions: [],
    },
    evidence: [
      { id: "E1", target: "src/main.js", version: "sha-a", statement: "存在两个标签创建入口。" },
      { id: "E2", target: "src/components/editor.js", version: "sha-b", statement: "保存分支依赖 path。" },
    ],
    id: "WP-fixture",
    revision: 3,
    createdAt: 100,
    ...overrides,
  });
}

test("one SealedWorkPlanV1 projects exact plan.md bytes, PlanPanel data, and a distinct Chat summary", () => {
  const plan = createPlan();
  const commit = adapter.createRuntimeV2PlanReviewCommit({
    plan,
    turn,
    run,
    requestId: "review-a",
    createdAt: 120,
  });

  assert.equal(commit.artifact.path, ".MAIN/plans/plan.md");
  assert.equal(commit.artifact.content, plan.markdown);
  assert.equal(commit.panel.markdown, plan.markdown);
  assert.equal(commit.panel.steps[0].title, plan.draft.steps[0].title);
  assert.match(commit.chat.markdown, /统一文件打开入口/);
  assert.match(commit.chat.markdown, /批准前不会修改项目/);
  assert.notEqual(commit.chat.markdown, plan.markdown);

  for (const projection of [commit.artifact, commit.panel, commit.chat, commit.review]) {
    assert.equal(projection.authority?.revision ?? commit.authority.revision, plan.revision);
    assert.equal(projection.authority?.digest ?? commit.authority.digest, plan.digest);
    assert.equal(
      projection.authority?.projectionHash ?? projection.projectionHash,
      plan.projectionHash,
    );
  }
});

test("approval binding requires exact revision, digest, projection hash, request owner, and surface projections", () => {
  const plan = createPlan();
  const commit = adapter.createRuntimeV2PlanReviewCommit({
    plan,
    turn,
    run,
    requestId: "review-a",
    createdAt: 120,
  });
  assert.deepEqual(
    adapter.validateRuntimeV2PlanReviewBinding({
      commit,
      currentPlan: plan,
      turn,
      run,
      requestId: "review-a",
    }),
    { ok: true, authority: commit.authority },
  );

  const nextRevision = createPlan({ revision: 4 });
  assert.equal(
    adapter.validateRuntimeV2PlanReviewBinding({
      commit,
      currentPlan: nextRevision,
      turn,
      run,
      requestId: "review-a",
    }).reason,
    "plan_review_identity_mismatch",
  );

  const staleOwner = { ...run, runId: "run-b" };
  assert.equal(
    adapter.validateRuntimeV2PlanReviewBinding({
      commit,
      currentPlan: plan,
      turn,
      run: staleOwner,
      requestId: "review-a",
    }).reason,
    "plan_review_owner_mismatch",
  );

  const alteredPanel = {
    ...commit,
    panel: { ...commit.panel, markdown: "# 来自另一份计划的内容" },
  };
  assert.equal(
    adapter.validateRuntimeV2PlanReviewBinding({
      commit: alteredPanel,
      currentPlan: plan,
      turn,
      run,
      requestId: "review-a",
    }).reason,
    "plan_panel_projection_mismatch",
  );

  assert.equal(
    adapter.validateRuntimeV2PlanReviewBinding({
      commit,
      currentPlan: plan,
      turn,
      run,
      requestId: "review-b",
    }).reason,
    "plan_review_request_mismatch",
  );
});

test("tampered sealed authority cannot be projected or approved", () => {
  const plan = createPlan();
  const tamperedMarkdown = { ...plan, markdown: `${plan.markdown}\n\n模型追加的第二份计划` };
  assert.deepEqual(
    adapter.validateSealedWorkPlanV1Integrity(tamperedMarkdown),
    { ok: false, reason: "work_plan_markdown_mismatch" },
  );
  assert.throws(
    () => adapter.createRuntimeV2PlanReviewCommit({
      plan: tamperedMarkdown,
      turn,
      run,
      requestId: "review-a",
      createdAt: 120,
    }),
    /work_plan_markdown_mismatch/,
  );

  const tamperedDigest = { ...plan, digest: "work-plan-sha256-stale" };
  assert.deepEqual(
    adapter.validateSealedWorkPlanV1Integrity(tamperedDigest),
    { ok: false, reason: "work_plan_digest_mismatch" },
  );

  const invalidDraft = {
    ...plan,
    draft: { ...plan.draft, steps: [] },
  };
  assert.deepEqual(
    adapter.validateSealedWorkPlanV1Integrity(invalidDraft),
    { ok: false, reason: "work_plan_invalid" },
  );
});

test("the v2 Plan adapter has no Markdown reverse-parser or legacy Plan authority dependency", () => {
  const source = fs.readFileSync(
    path.join(workspaceRoot, "src/store/runtimeV2/workPlanAdapter.ts"),
    "utf8",
  );
  for (const forbidden of [
    "planMaterialization",
    "planArtifactCommit",
    "planApprovalIdentity",
    "workflowModels",
    "extractPlan",
    "parsePlan",
  ]) {
    assert.equal(source.includes(forbidden), false, `unexpected legacy/reverse dependency: ${forbidden}`);
  }
});
