import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

import ts from "typescript";

const workspaceRoot = process.cwd();
const moduleCache = new Map();

function loadTranspiledModuleSync(sourcePath) {
  const normalizedPath = path.resolve(sourcePath);
  if (moduleCache.has(normalizedPath)) return moduleCache.get(normalizedPath);

  // Vite expands the bundled Game Studio pack through import.meta.glob. The
  // restore tests do not use those assets, so replace only that build-time
  // expression while executing the store module in Node.
  const source = fs.readFileSync(normalizedPath, "utf8").replace(
    /import\.meta\.glob\([\s\S]*?\)\s+as Record<string, string>/g,
    "({}) as Record<string, string>",
  );
  const localRequire = createRequire(normalizedPath);
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      jsx: ts.JsxEmit.ReactJSX,
    },
    fileName: normalizedPath,
  }).outputText;

  const module = { exports: {} };
  moduleCache.set(normalizedPath, module.exports);
  const runtimeRequire = (specifier) => {
    if (specifier.startsWith("@tauri-apps/")) {
      return {
        invoke: async () => "",
        isTauri: () => false,
        listen: async () => () => {},
        open: async () => null,
        relaunch: async () => {},
        exit: async () => {},
        check: async () => null,
      };
    }
    if (specifier.startsWith(".")) {
      const basePath = path.resolve(path.dirname(normalizedPath), specifier);
      for (const candidate of [
        basePath,
        `${basePath}.ts`,
        `${basePath}.tsx`,
        path.join(basePath, "index.ts"),
        path.join(basePath, "index.tsx"),
      ]) {
        if (fs.existsSync(candidate) && /\.tsx?$/.test(candidate)) {
          return loadTranspiledModuleSync(candidate);
        }
      }
    }
    return localRequire(specifier);
  };

  new Function("exports", "module", "require", transpiled)(module.exports, module, runtimeRequire);
  moduleCache.set(normalizedPath, module.exports);
  return module.exports;
}

const {
  buildSessionRuntimeSnapshotFromStoreState,
  normalizeSessionRuntimeSnapshot,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/store/useAppStore.ts"));
const actionRequests = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/actionRequest.ts"));
const pendingToolReview = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/pendingToolReview.ts"));
const turnEvents = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/turnEvents.ts"));
const goalState = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/goalState.ts"));
const goalRuntime = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/goalRuntime.ts"));
const goalPersistence = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/goalPersistence.ts"));
const {
  extractPlanTasks,
  validatePlanArtifactContent,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/workflowModels.ts"));

function buildApprovedPlanContent() {
  return [
    "# Plan 恢复批准边界",
    "",
    "## 用户目标",
    "- 恢复时必须以完整的可审查 artifact 集合验证批准身份。",
    "",
    "## 摘要",
    "- 已读取恢复入口与批准 identity 构建逻辑。",
    "",
    "## 已读证据",
    "- `src/store/useAppStore.ts`：恢复后重新计算 artifact identity。",
    "",
    "## 关键改动",
    "- 当任一可审查 artifact 无效时使旧批准整体失效。",
    "",
    "## 公共 API / 接口 / 类型",
    "- 保持 PlanArtifact 和 PlanApprovalIdentity 类型不变。",
    "",
    "## 执行步骤",
    "1. 清理所有持久化 artifact。",
    "2. 比较清理前后的完整批准 identity。",
    "",
    "## 验证标准",
    "- 集合缺失任一可审查 artifact 时 isPlanApproved 为 false。",
    "",
    "## 测试方案",
    "- 运行 session runtime restore 定向测试。",
    "",
    "## 假设与默认值",
    "- design.md 与 plan.md 都属于用户批准绑定的内容。",
    "",
  ].join("\n");
}

test("subagent collaboration preference is session-scoped and backward compatible", () => {
  assert.equal(normalizeSessionRuntimeSnapshot({})?.preferSubagents, false);
  assert.equal(normalizeSessionRuntimeSnapshot({ preferSubagents: true })?.preferSubagents, true);
  assert.equal(
    buildSessionRuntimeSnapshotFromStoreState({ preferSubagents: true }).preferSubagents,
    true,
  );
});

test("queued Goal continuation guidance survives session normalization only with authorization", () => {
  const authorization = {
    kind: "goal_continuation_authorization",
    source: "goal_manual_resume",
    workspaceKey: "/repo",
    sessionKey: "/repo:7",
    goalId: "goal-1",
    goalRevision: 2,
    ownerTurnId: "turn-goal",
  };
  const restored = normalizeSessionRuntimeSnapshot({
    queuedUserMessage: {
      id: "queued-goal-guidance",
      sessionKey: "/repo:7",
      text: "queue display text",
      status: "queued",
      createdAt: 100,
      goalContinuationAuthorization: authorization,
      goalContinuationGuidance: "exact continuation guidance",
    },
  });
  assert.equal(
    restored.queuedUserMessage.goalContinuationGuidance,
    "exact continuation guidance",
  );

  const untrusted = normalizeSessionRuntimeSnapshot({
    queuedUserMessage: {
      id: "queued-untrusted-guidance",
      sessionKey: "/repo:7",
      text: "queue display text",
      status: "queued",
      createdAt: 100,
      goalContinuationGuidance: "must not survive alone",
    },
  });
  assert.equal(untrusted.queuedUserMessage.goalContinuationGuidance, undefined);
});

function planArtifact(content, overrides = {}) {
  return {
    kind: "plan",
    path: ".MAIN/plans/plan.md",
    title: "Plan",
    content,
    revision: 4,
    updatedAt: 100,
    ...overrides,
  };
}

function tasksArtifact(content, overrides = {}) {
  return {
    kind: "tasks",
    path: ".MAIN/plans/tasks.md",
    title: "Tasks",
    content,
    revision: 4,
    updatedAt: 101,
    ...overrides,
  };
}

function approvedTaskArtifact() {
  return tasksArtifact([
    "# Tasks",
    "",
    "- [ ] 修改 src/main.js 中的 handleOpenFile()，统一文件打开入口 — 证据: file:src/main.js",
    "- [ ] 修改 src/main.js 中的 closeTab()，保留正确的活动标签 — 证据: file:src/main.js",
    "- [ ] 运行恢复链路测试 — 证据: cmd:node --test tests/node/session-runtime-restore.test.mjs",
    "",
  ].join("\n"));
}

function planConversationTurn(overrides = {}) {
  return {
    id: "turn-plan",
    userPrompt: "执行已批准的恢复计划",
    title: "恢复计划",
    mode: "plan",
    intent: "plan",
    displayIntent: "execute",
    status: "executing",
    summary: "",
    blockIds: [],
    collapsed: false,
    createdAt: 100,
    ...overrides,
  };
}

function planHarnessMarker(overrides = {}) {
  return {
    schemaVersion: 1,
    instanceId: "test-instance",
    sessionKey: "plan-session",
    workspace: "/repo",
    sessionId: 1,
    turnId: "turn-plan",
    runId: "run-outer",
    activeRunId: "run-child",
    activeParentRunId: "run-outer",
    status: "running",
    workflowMode: "plan",
    runtimeIntent: "execute",
    planStage: "executing",
    isPlanApproved: true,
    iteration: 2,
    maxIterations: 50,
    messagesLen: 2,
    toolCount: 1,
    latestTool: "read_file",
    latestToolTarget: "src/main.js",
    activeStreamId: null,
    streamStatus: null,
    streamChunkCount: 0,
    streamByteCount: 0,
    streamElapsedMs: null,
    streamLifecycleStatus: null,
    lastStreamError: null,
    startedAt: 100,
    updatedAt: 200,
    closedAt: null,
    closeReason: null,
    ...overrides,
  };
}

function buildUnsupportedPlanContent() {
  return [
    "# MD Viewer 文件打开修复计划",
    "",
    "## 用户目标",
    "- 修复双击 Markdown 文件后窗口空白和工具栏打开按钮无效的问题。",
    "",
    "## 摘要",
    "- 已读取 `src-tauri/src/main.rs` 和 `src/main.js`，准备连接文件打开链路。",
    "",
    "## 关键改动",
    "- `src/main.js` 可能需要新增 `open-file` 事件监听器。",
    "",
    "## 公共 API / 接口 / 类型",
    "- 保持现有事件名称不变。",
    "",
    "## 执行步骤",
    "1. 先确认前端监听器，再决定修改方案。",
    "",
    "## 验证标准",
    "- 双击文件和点击打开按钮均可加载内容。",
    "",
    "## 测试方案",
    "- 运行 cargo check 并手动验证。",
    "",
    "## 假设与默认值",
    "- 默认前端尚未注册监听器。",
    "",
  ].join("\n");
}

test("restore invalidates approval when sanitization removes one reviewable artifact from a multi-artifact identity", () => {
  const plan = planArtifact(buildApprovedPlanContent());
  const invalidDesign = {
    kind: "design",
    path: ".MAIN/plans/design.md",
    title: "Design",
    content: "# Design\n\nTBD",
    revision: 4,
    updatedAt: 101,
  };
  assert.equal(validatePlanArtifactContent(plan.content, "plan").ok, true);
  assert.equal(validatePlanArtifactContent(invalidDesign.content, "design").ok, false);

  const restored = normalizeSessionRuntimeSnapshot({
    planArtifacts: [plan, invalidDesign],
    isPlanApproved: true,
    planStage: "executing",
    planApprovalChoice: "approve",
    planExecutionEvidenceLedger: [{ id: "legacy-evidence" }],
    planExecutionEvidenceCount: 1,
  });

  assert.equal(restored.isPlanApproved, false);
  assert.deepEqual(restored.planArtifacts.map((artifact) => artifact.path), [".MAIN/plans/plan.md"]);
  assert.equal(restored.planApprovalChoice, "");
  assert.deepEqual(restored.planExecutionEvidenceLedger, []);
  assert.equal(restored.planExecutionEvidenceCount, 0);
});

test("restore keeps an invalid approved Plan as audit history while revoking execution", () => {
  const invalidPlan = planArtifact(buildUnsupportedPlanContent(), { revision: 2 });
  const restored = normalizeSessionRuntimeSnapshot({
    planArtifacts: [invalidPlan],
    isPlanApproved: true,
    planStage: "executing",
    planApprovalChoice: "approve",
  });

  assert.equal(restored.isPlanApproved, false);
  assert.equal(restored.planStage, "plan");
  assert.equal(restored.planArtifacts.length, 1);
  assert.equal(restored.planArtifacts[0].content, invalidPlan.content.trim());
  assert.equal(restored.planApprovalChoice, "");
});

test("restore preserves currentTaskId and migrates legacy task text only when the approved graph is unique", () => {
  const plan = planArtifact(buildApprovedPlanContent());
  const tasks = approvedTaskArtifact();
  assert.equal(validatePlanArtifactContent(tasks.content, "tasks").ok, true);
  const planTasks = extractPlanTasks(tasks.content);
  const progress = {
    turnId: "turn-plan",
    phase: "running",
    currentTask: planTasks[0].text,
    currentTool: "read_file · src/main.js",
    latestEvidence: "read src/main.js",
    nextStep: "apply the reviewed mutation",
    iteration: 2,
    maxIterations: 50,
    autoResumeCount: 0,
    updatedAt: 100,
  };
  const migrated = normalizeSessionRuntimeSnapshot({
    currentTurnId: "turn-plan",
    conversationTurns: [planConversationTurn()],
    planArtifacts: [plan, tasks],
    planTasks,
    planExecutionProgressSnapshot: {
      ...progress,
      currentTaskId: planTasks[0].id,
      currentTask: "stale display text must not replace the stable id",
    },
    isPlanApproved: true,
    planStage: "executing",
    planApprovalChoice: "approve",
  });
  assert.equal(migrated.isPlanApproved, true);
  assert.equal(migrated.planExecutionProgressSnapshot.currentTaskId, planTasks[0].id);
  assert.equal(migrated.planTasks.length, 3);
  assert.equal(migrated.planTasks[0].text, planTasks[0].text);

  const legacy = normalizeSessionRuntimeSnapshot({
    currentTurnId: "turn-plan",
    conversationTurns: [planConversationTurn()],
    planArtifacts: [plan, tasks],
    planTasks,
    planExecutionProgressSnapshot: progress,
    isPlanApproved: true,
    planStage: "executing",
    planApprovalChoice: "approve",
  });
  assert.equal(legacy.isPlanApproved, true);
  assert.equal(legacy.planExecutionProgressSnapshot.currentTaskId, planTasks[0].id);

  const ambiguous = normalizeSessionRuntimeSnapshot({
    currentTurnId: "turn-plan",
    conversationTurns: [planConversationTurn()],
    planArtifacts: [plan, tasks],
    planTasks,
    planExecutionProgressSnapshot: { ...progress, currentTask: "读取 src/main.js" },
    isPlanApproved: true,
    planStage: "executing",
    planApprovalChoice: "approve",
  });
  assert.equal(ambiguous.isPlanApproved, false);
  assert.equal(ambiguous.planStage, "plan");
  assert.equal(ambiguous.planExecutionProgressSnapshot, null);
});

test("restore pauses and revokes approval when the Plan checkpoint turn or run owner is stale", () => {
  const plan = planArtifact(buildApprovedPlanContent());
  const tasks = approvedTaskArtifact();
  const planTasks = extractPlanTasks(tasks.content);
  const baseProgress = {
    turnId: "turn-plan",
    runId: "run-child",
    parentRunId: "run-outer",
    phase: "running",
    currentTaskId: planTasks[0].id,
    currentTask: planTasks[0].text,
    currentTool: "read_file · src/main.js",
    latestEvidence: "read src/main.js",
    nextStep: "apply the reviewed mutation",
    iteration: 2,
    maxIterations: 50,
    autoResumeCount: 0,
    updatedAt: 100,
  };

  const valid = normalizeSessionRuntimeSnapshot({
    currentTurnId: "turn-plan",
    conversationTurns: [planConversationTurn()],
    planArtifacts: [plan, tasks],
    planTasks,
    planExecutionProgressSnapshot: baseProgress,
    harnessRunMarker: planHarnessMarker(),
    isPlanApproved: true,
    planStage: "executing",
    planApprovalChoice: "approve",
  });
  assert.equal(valid.isPlanApproved, true);
  assert.equal(valid.planExecutionProgressSnapshot.currentTaskId, planTasks[0].id);
  assert.equal(valid.harnessRunMarker.status, "paused");
  assert.equal(valid.runtimeEvents.at(-1).type, "run.paused");

  for (const mismatch of ["turn", "run"]) {
    const restored = normalizeSessionRuntimeSnapshot({
      currentTurnId: "turn-plan",
      conversationTurns: [planConversationTurn()],
      planArtifacts: [plan, tasks],
      planTasks,
      planExecutionProgressSnapshot: {
        ...baseProgress,
        ...(mismatch === "turn" ? { turnId: "turn-stale" } : { runId: "run-stale" }),
      },
      harnessRunMarker: planHarnessMarker(),
      isPlanApproved: true,
      planStage: "executing",
      planApprovalChoice: "approve",
    });

    assert.equal(restored.isPlanApproved, false, mismatch);
    assert.equal(restored.planStage, "plan", mismatch);
    assert.equal(restored.planExecutionProgressSnapshot, null, mismatch);
    assert.equal(restored.harnessRunMarker.status, "paused", mismatch);
    assert.equal(restored.runtimeEvents.at(-1).type, "run.paused", mismatch);
    assert.equal(restored.conversationTurns[0].status, "paused", mismatch);
    assert.equal(restored.planArtifacts.some((artifact) => artifact.kind === "plan"), true, mismatch);
  }
});

test("restore rewrites the exact owner pause boundary when an internal Plan choice request is cleared", () => {
  const sessionKey = "md-viewer-session";
  const turnId = "turn-plan-draft";
  const runId = "run-plan-draft";
  const optionValues = [
    "我需要先查看 main.js 中是否有 open-file 事件监听器，再决定方案",
    "先修复 main.rs 中的 handle_open_url，再处理前端部分",
    "我需要了解 Tauri 2 dialog 插件的正确导入方式后再执行",
  ];
  const request = actionRequests.buildUserChoiceActionRequest({
    sessionKey,
    turnId,
    runId,
    title: "选择下一步",
    optionValues,
    allowCustomReply: true,
    now: 200,
  });
  const choiceRequest = actionRequests.toUserChoiceResolutionIdentity(request);
  const blockContent = [
    "# 问题根因确认（8 条要点）",
    "",
    "已读取后端 URL 回调、前端事件监听和工具栏异步文件选择链路。",
  ].join("\n");

  const restored = normalizeSessionRuntimeSnapshot({
    planArtifacts: [planArtifact(buildUnsupportedPlanContent(), { revision: 1 })],
    isPlanApproved: false,
    planStage: "plan",
    activeActionRequest: request,
    harnessRunMarker: {
      schemaVersion: 1,
      instanceId: "test-instance",
      sessionKey,
      turnId,
      runId,
      status: "paused",
      workflowMode: "plan",
      runtimeIntent: "plan",
      planStage: "plan",
      isPlanApproved: false,
      startedAt: 100,
      updatedAt: 200,
      closedAt: 200,
      closeReason: "awaiting_user_choice",
    },
    taskFlow: [{
      id: 101,
      type: "agent",
      turnId,
      content: blockContent,
      options: optionValues.map((value) => ({ label: value, value })),
      choiceRequest,
    }],
    conversationTurns: [{
      id: turnId,
      userPrompt: "使用 Plan 模式分析并修复 MD Viewer 文件打开问题",
      title: "修复 MD Viewer",
      mode: "plan",
      intent: "plan",
      displayIntent: "plan",
      status: "awaiting_input",
      summary: "等待选择下一步",
      blockIds: [101],
      collapsed: false,
      createdAt: 100,
    }],
    runtimeEvents: [
      {
        schemaVersion: 2,
        type: "run.started",
        threadId: sessionKey,
        turnId,
        runId,
        parentRunId: null,
        timestampMs: 100,
      },
      {
        schemaVersion: 2,
        type: "approval.requested",
        threadId: sessionKey,
        turnId,
        runId,
        parentRunId: null,
        requestId: request.requestId,
        actionKind: "user_choice",
        title: request.title,
        reason: "awaiting_user_choice",
        timestampMs: 190,
      },
      {
        schemaVersion: 2,
        type: "run.paused",
        threadId: sessionKey,
        turnId,
        runId,
        parentRunId: null,
        reason: "awaiting_user_choice",
        message: "Waiting for a user choice.",
        timestampMs: 200,
      },
    ],
  });

  assert.equal(restored.activeActionRequest, null);
  assert.equal(restored.harnessRunMarker.closeReason, "invalid_plan_user_choice_cleared");
  assert.equal(restored.conversationTurns[0].status, "paused");
  assert.equal(restored.taskFlow[0].choiceRequest, undefined);
  assert.deepEqual(restored.taskFlow[0].options, []);

  const ownedRunEvents = restored.runtimeEvents.filter((event) =>
    event.threadId === sessionKey &&
    event.turnId === turnId &&
    event.runId === runId
  );
  assert.deepEqual(ownedRunEvents.map((event) => event.type), ["run.started", "run.paused"]);
  const pause = ownedRunEvents.find((event) => event.type === "run.paused");
  assert.equal(pause.reason, "invalid_plan_user_choice_cleared");
  assert.match(pause.message, /Plan|计划/i);
});

test("restore removes a genuine but stale choice whose run owner no longer matches", () => {
  const sessionKey = "md-viewer-session";
  const turnId = "turn-startup-choice";
  const optionValues = [
    "启动时默认显示空白页，由用户手动选择文件",
    "启动时自动恢复上次打开的 Markdown 文件",
  ];
  const request = actionRequests.buildUserChoiceActionRequest({
    sessionKey,
    turnId,
    runId: "run-old",
    title: "选择启动体验",
    optionValues,
    allowCustomReply: false,
    now: 300,
  });
  const restored = normalizeSessionRuntimeSnapshot({
    activeActionRequest: request,
    harnessRunMarker: {
      schemaVersion: 1,
      instanceId: "test-instance",
      sessionKey,
      turnId,
      runId: "run-outer",
      activeRunId: "run-new",
      status: "paused",
      workflowMode: "plan",
      runtimeIntent: "plan",
      planStage: "plan",
      isPlanApproved: false,
      startedAt: 100,
      updatedAt: 300,
      closedAt: 300,
      closeReason: "awaiting_user_choice",
    },
    taskFlow: [{
      id: 301,
      type: "agent",
      turnId,
      content: "请选择启动时的默认用户体验：显示空白页，还是恢复上次文件？",
      options: optionValues.map((value) => ({ label: value, value })),
      choiceRequest: actionRequests.toUserChoiceResolutionIdentity(request),
    }],
    conversationTurns: [{
      id: turnId,
      userPrompt: "规划 MD Viewer 的默认启动体验",
      title: "默认启动体验",
      mode: "plan",
      intent: "plan",
      displayIntent: "plan",
      status: "awaiting_input",
      summary: "等待选择",
      blockIds: [301],
      collapsed: false,
      createdAt: 100,
    }],
    runtimeEvents: [{
      schemaVersion: 2,
      type: "run.paused",
      threadId: sessionKey,
      turnId,
      runId: "run-old",
      parentRunId: null,
      reason: "awaiting_user_choice",
      message: "Waiting",
      timestampMs: 300,
    }],
  });

  assert.equal(restored.activeActionRequest, null);
  assert.equal(restored.conversationTurns[0].status, "paused");
  assert.deepEqual(restored.taskFlow[0].options, []);
  assert.equal(restored.taskFlow[0].choiceRequest, undefined);
  const staleOwnerPause = restored.runtimeEvents.find((event) =>
    event.type === "run.paused" && event.runId === "run-old"
  );
  const projectedRunPause = restored.runtimeEvents.find((event) =>
    event.type === "run.paused" && event.runId === "run-new"
  );
  assert.equal(staleOwnerPause?.reason, "stale_user_choice_cleared");
  assert.equal(projectedRunPause?.reason, "restored_inconsistent_checkpoint");
  assert.equal(restored.harnessRunMarker.closeReason, "awaiting_user_choice");
});

test("restore projects terminal markers instead of inventing a resumable pause", () => {
  for (const status of ["completed", "error"]) {
    const sessionKey = `terminal-${status}-session`;
    const turnId = `turn-${status}`;
    const runId = `run-${status}`;
    const request = actionRequests.buildUserChoiceActionRequest({
      sessionKey,
      turnId,
      runId,
      title: "Stale terminal choice",
      optionValues: ["A", "B"],
      allowCustomReply: false,
      now: 500,
    });
    const restored = normalizeSessionRuntimeSnapshot({
      activeActionRequest: request,
      harnessRunMarker: {
        schemaVersion: 1,
        instanceId: "test-instance",
        sessionKey,
        turnId,
        runId,
        activeRunId: runId,
        status,
        workflowMode: "plan",
        runtimeIntent: "plan",
        planStage: "plan",
        isPlanApproved: false,
        startedAt: 100,
        updatedAt: 500,
        closedAt: 500,
        closeReason: status === "completed" ? "completed" : "agent_loop_crashed",
        lastStreamError: status === "error" ? "terminal failure" : null,
      },
      taskFlow: [{
        id: 501,
        type: "agent",
        turnId,
        content: "Choose A or B",
        options: ["A", "B"].map((value) => ({ label: value, value })),
        choiceRequest: actionRequests.toUserChoiceResolutionIdentity(request),
      }],
      conversationTurns: [{
        id: turnId,
        userPrompt: "Finish the terminal run",
        title: "Terminal restore",
        mode: "plan",
        intent: "plan",
        displayIntent: "plan",
        status: "awaiting_input",
        summary: "Waiting",
        blockIds: [501],
        collapsed: false,
        createdAt: 100,
      }],
      runtimeEvents: [],
    });

    assert.equal(restored.activeActionRequest, null);
    assert.equal(restored.conversationTurns[0].status, "done");
    assert.equal(restored.conversationTurns[0].runtimeOutcome?.status, "completed");
    assert.equal(
      restored.conversationTurns[0].runtimeOutcome?.resultKind,
      status === "completed" ? "success" : "error",
    );
    const runEvents = restored.runtimeEvents.filter((event) => event.runId === runId);
    assert.deepEqual(runEvents.map((event) => event.type), ["run.completed"]);
    assert.equal(runEvents[0]?.resultKind, status === "completed" ? "success" : "error");
    assert.equal(runEvents.some((event) => event.type === "run.paused"), false);
    const turnTerminal = restored.runtimeEvents.find((event) =>
      event.type === "turn.completed" && event.turnId === turnId
    );
    assert.equal(turnTerminal?.resultKind, status === "completed" ? "success" : "error");
  }
});

test("restore preserves an aborted run over its cleanly completed harness lease", () => {
  const sessionKey = "terminal-aborted-session";
  const turnId = "turn-aborted";
  const runId = "run-aborted";
  const request = actionRequests.buildUserChoiceActionRequest({
    sessionKey,
    turnId,
    runId,
    title: "Stale choice after cancellation",
    optionValues: ["Continue", "Stop"],
    allowCustomReply: false,
    now: 500,
  });
  const restored = normalizeSessionRuntimeSnapshot({
    activeActionRequest: request,
    harnessRunMarker: {
      schemaVersion: 1,
      instanceId: "test-instance",
      sessionKey,
      turnId,
      runId,
      activeRunId: runId,
      status: "completed",
      workflowMode: "edit",
      runtimeIntent: "execute",
      planStage: "idle",
      isPlanApproved: false,
      startedAt: 100,
      updatedAt: 500,
      closedAt: 500,
      closeReason: "user_cancelled",
      lastStreamError: null,
    },
    taskFlow: [{
      id: 601,
      type: "agent",
      turnId,
      content: "Continue or stop?",
      options: ["Continue", "Stop"].map((value) => ({ label: value, value })),
      choiceRequest: actionRequests.toUserChoiceResolutionIdentity(request),
    }],
    conversationTurns: [{
      id: turnId,
      userPrompt: "Cancel this work",
      title: "Canceled turn",
      mode: "edit",
      intent: "execute",
      displayIntent: "execute",
      status: "awaiting_input",
      summary: "Waiting",
      blockIds: [601],
      collapsed: false,
      createdAt: 100,
    }],
    runtimeEvents: [
      turnEvents.withEventSchema({
        type: "run.aborted",
        threadId: sessionKey,
        turnId,
        runId,
        parentRunId: null,
        timestampMs: 500,
        reason: "user_cancelled",
        message: "The user canceled this run.",
      }),
      turnEvents.withEventSchema({
        type: "turn.completed",
        threadId: sessionKey,
        turnId,
        timestampMs: 500,
        resultKind: "canceled",
      }),
    ],
  });

  assert.equal(restored.activeActionRequest, null);
  assert.equal(restored.conversationTurns[0].status, "done");
  assert.equal(restored.conversationTurns[0].runtimeOutcome?.status, "aborted");
  assert.equal(restored.conversationTurns[0].runtimeOutcome?.resultKind, "canceled");
  assert.equal(restored.conversationTurns[0].runtimeOutcome?.reason, "user_cancelled");
  const runEvents = restored.runtimeEvents.filter((event) => event.runId === runId);
  assert.deepEqual(runEvents.map((event) => event.type), ["run.aborted"]);
  const turnTerminals = restored.runtimeEvents.filter((event) =>
    event.turnId === turnId && (event.type === "turn.completed" || event.type === "turn.failed")
  );
  assert.deepEqual(turnTerminals.map((event) => [event.type, event.resultKind]), [
    ["turn.completed", "canceled"],
  ]);
  assert.equal(restored.runtimeEvents.some((event) => event.type === "run.paused"), false);
  assert.equal(restored.runtimeEvents.some((event) => event.type === "run.failed"), false);
});

test("restore clears non-resumable tool permission state and preserves a paused event", () => {
  const sessionKey = "tool-session";
  const turnId = "turn-tool";
  const runId = "run-tool";
  const request = pendingToolReview.buildToolPermissionActionRequest({
    sessionKey,
    turnId,
    runId,
    title: "修改源码",
    taskId: 401,
    toolCall: { name: "write_file", arguments: { path: "src/app.ts" } },
    now: 400,
  });
  const restored = normalizeSessionRuntimeSnapshot({
    activeActionRequest: request,
    harnessRunMarker: {
      schemaVersion: 1,
      instanceId: "test-instance",
      sessionKey,
      turnId,
      runId,
      status: "paused",
      workflowMode: "edit",
      runtimeIntent: "execute",
      planStage: "idle",
      isPlanApproved: false,
      startedAt: 100,
      updatedAt: 400,
      closedAt: 400,
      closeReason: "tool_permission",
    },
    taskFlow: [{
      id: 401,
      type: "tool",
      turnId,
      toolName: "write_file",
      target: "src/app.ts",
      status: "pending_review",
      toolStatus: "pending",
    }],
    conversationTurns: [{
      id: turnId,
      userPrompt: "修改 src/app.ts",
      title: "修改源码",
      mode: "edit",
      intent: "execute",
      displayIntent: "execute",
      status: "awaiting_approval",
      summary: "等待批准",
      blockIds: [401],
      collapsed: false,
      createdAt: 100,
    }],
    runtimeEvents: [],
  });

  assert.equal(restored.activeActionRequest, null);
  assert.equal(restored.conversationTurns[0].status, "paused");
  assert.equal(restored.taskFlow[0].toolStatus, "failed");
  assert.equal(restored.harnessRunMarker.closeReason, "non_resumable_tool_permission_cleared");
  assert.equal(restored.runtimeEvents.at(-1).type, "run.paused");
  assert.equal(restored.runtimeEvents.at(-1).reason, "non_resumable_tool_permission_cleared");
});

test("restore emits run.paused when a running marker was interrupted by restart", () => {
  const restored = normalizeSessionRuntimeSnapshot({
    harnessRunMarker: {
      schemaVersion: 1,
      instanceId: "test-instance",
      sessionKey: "restart-session",
      turnId: "turn-restart",
      runId: "run-restart",
      status: "running",
      workflowMode: "edit",
      runtimeIntent: "execute",
      planStage: "idle",
      isPlanApproved: false,
      startedAt: 100,
      updatedAt: 500,
      closedAt: null,
      closeReason: null,
    },
    conversationTurns: [{
      id: "turn-restart",
      userPrompt: "继续修复",
      title: "继续修复",
      mode: "edit",
      intent: "execute",
      displayIntent: "execute",
      status: "executing",
      summary: "",
      blockIds: [],
      collapsed: false,
      createdAt: 100,
    }],
    runtimeEvents: [{
      schemaVersion: 2,
      type: "run.started",
      threadId: "restart-session",
      turnId: "turn-restart",
      runId: "run-restart",
      parentRunId: null,
      timestampMs: 100,
    }],
  });

  assert.equal(restored.harnessRunMarker.status, "paused");
  assert.deepEqual(restored.runtimeEvents.map((event) => event.type), ["run.started", "run.paused"]);
  assert.equal(restored.runtimeEvents[1].reason, "application_restarted");
});

test("a loaded durable Goal deletion fence prevents an old session snapshot from resurrecting", () => {
  const workspace = "/tmp/deleted-goal-restore";
  const sessionKey = `${workspace}:71`;
  const turnId = "turn-deleted-goal";
  const runId = "run-deleted-goal";
  const goal = goalState.createGoalDefinition({
    objective: "修复按钮并验证交互",
    sessionKey,
    ownerTurnId: turnId,
  });
  const progress = goalState.createGoalProgress(goal.id, "progress.md");
  const runtime = goalRuntime.buildGoalRuntimeSnapshot({
    goal,
    progress,
    phase: "execute",
  });
  const request = actionRequests.buildUserChoiceActionRequest({
    sessionKey,
    turnId,
    runId,
    title: "Goal choice",
    optionValues: ["继续"],
    allowCustomReply: true,
    now: 200,
  });

  goalPersistence.markGoalRuntimeDeleted(workspace, goal.id);
  try {
    const restored = normalizeSessionRuntimeSnapshot({
      activeGoal: goal,
      goalProgress: progress,
      goalStatus: "awaiting_input",
      goalRuntime: { ...runtime, status: "awaiting_input" },
      queuedUserMessage: {
        id: "queued-deleted-goal",
        sessionKey,
        text: "继续",
        status: "queued",
        createdAt: 210,
        runtimeIntentOverride: "goal",
        goalContinuationAuthorization: {
          kind: "goal_continuation_authorization",
          source: "goal_user_choice",
          workspaceKey: workspace,
          sessionKey,
          goalId: goal.id,
          goalRevision: goal.revision || 1,
          ownerTurnId: turnId,
          requestId: request.requestId,
        },
        goalContinuationGuidance: "继续",
      },
      activeActionRequest: request,
      harnessRunMarker: {
        schemaVersion: 1,
        instanceId: "deleted-goal-instance",
        sessionKey,
        workspace,
        sessionId: 71,
        turnId,
        runId,
        status: "paused",
        workflowMode: "edit",
        runtimeIntent: "goal",
        planStage: "idle",
        isPlanApproved: false,
        iteration: 1,
        maxIterations: 6,
        messagesLen: 2,
        toolCount: 0,
        latestTool: null,
        latestToolTarget: null,
        activeStreamId: null,
        streamStatus: "closed",
        streamChunkCount: 0,
        streamByteCount: 0,
        streamElapsedMs: 0,
        streamLifecycleStatus: "completed",
        lastStreamError: null,
        startedAt: 100,
        updatedAt: 200,
        closedAt: 200,
        closeReason: "awaiting_user_choice",
      },
      taskFlow: [{
        id: 501,
        type: "agent",
        turnId,
        content: "请选择",
        options: [{ label: "继续", value: "继续" }],
        choiceRequest: request,
      }],
      conversationTurns: [{
        id: turnId,
        userPrompt: "修复按钮",
        title: "Goal",
        mode: "edit",
        intent: "goal",
        displayIntent: "goal",
        status: "awaiting_input",
        summary: "等待选择",
        blockIds: [501],
        collapsed: false,
        createdAt: 100,
      }],
    }, {
      restoreInterruptedGoal: true,
      workspacePath: workspace,
    });

    assert.equal(restored.activeGoal, null);
    assert.equal(restored.goalRuntime, null);
    assert.equal(restored.goalProgress, null);
    assert.equal(restored.goalStatus, "paused");
    assert.equal(restored.queuedUserMessage, null);
    assert.equal(restored.activeActionRequest, null);
    assert.equal(restored.harnessRunMarker, null);
    assert.deepEqual(restored.taskFlow[0].options, []);
    assert.equal(restored.conversationTurns[0].status, "paused");
  } finally {
    goalPersistence.unmarkGoalRuntimeDeleted(workspace, goal.id);
  }
});

test("a Goal deletion fence preserves an unrelated pending request in the same session", () => {
  const workspace = "/tmp/deleted-goal-with-new-run";
  const sessionKey = `${workspace}:72`;
  const goalTurnId = "turn-old-goal";
  const requestTurnId = "turn-current-run";
  const requestRunId = "run-current-run";
  const goal = goalState.createGoalDefinition({
    objective: "旧 Goal",
    sessionKey,
    ownerTurnId: goalTurnId,
  });
  const progress = goalState.createGoalProgress(goal.id, "progress.md");
  const runtime = goalRuntime.buildGoalRuntimeSnapshot({ goal, progress, phase: "execute" });
  const request = actionRequests.buildUserChoiceActionRequest({
    sessionKey,
    turnId: requestTurnId,
    runId: requestRunId,
    title: "Current non-Goal choice",
    optionValues: ["保留这个选择"],
    allowCustomReply: true,
    now: 300,
  });

  goalPersistence.markGoalRuntimeDeleted(workspace, goal.id);
  try {
    const restored = normalizeSessionRuntimeSnapshot({
      activeGoal: goal,
      goalProgress: progress,
      goalStatus: "active",
      goalRuntime: runtime,
      activeActionRequest: request,
      harnessRunMarker: {
        schemaVersion: 1,
        instanceId: "current-run-instance",
        sessionKey,
        workspace,
        sessionId: 72,
        turnId: requestTurnId,
        runId: requestRunId,
        status: "paused",
        workflowMode: "edit",
        runtimeIntent: "execute",
        planStage: "idle",
        isPlanApproved: false,
        iteration: 1,
        maxIterations: 6,
        messagesLen: 2,
        toolCount: 0,
        latestTool: null,
        latestToolTarget: null,
        activeStreamId: null,
        streamStatus: "closed",
        streamChunkCount: 0,
        streamByteCount: 0,
        streamElapsedMs: 0,
        streamLifecycleStatus: "completed",
        lastStreamError: null,
        startedAt: 200,
        updatedAt: 300,
        closedAt: 300,
        closeReason: "awaiting_user_choice",
      },
      taskFlow: [{
        id: 601,
        type: "agent",
        turnId: requestTurnId,
        content: "请选择当前请求",
        options: [{ label: "保留这个选择", value: "保留这个选择" }],
        choiceRequest: request,
      }],
      conversationTurns: [{
        id: requestTurnId,
        userPrompt: "当前非 Goal 请求",
        title: "Current request",
        mode: "edit",
        intent: "execute",
        displayIntent: "execute",
        status: "awaiting_input",
        summary: "等待选择",
        blockIds: [601],
        collapsed: false,
        createdAt: 200,
      }],
    }, {
      restoreInterruptedGoal: true,
      workspacePath: workspace,
    });

    assert.equal(restored.activeGoal, null);
    assert.equal(restored.goalRuntime, null);
    assert.equal(restored.activeActionRequest?.requestId, request.requestId);
    assert.equal(restored.harnessRunMarker?.runId, requestRunId);
    assert.equal(restored.taskFlow[0].options.length, 1);
    assert.equal(restored.conversationTurns[0].status, "awaiting_input");
  } finally {
    goalPersistence.unmarkGoalRuntimeDeleted(workspace, goal.id);
  }
});
