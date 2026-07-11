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

  const source = fs.readFileSync(normalizedPath, "utf8");
  const localRequire = createRequire(normalizedPath);
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
    fileName: normalizedPath,
  }).outputText;

  const module = { exports: {} };
  moduleCache.set(normalizedPath, module.exports);
  const runtimeRequire = (specifier) => {
    if (specifier.startsWith(".")) {
      const basePath = path.resolve(path.dirname(normalizedPath), specifier);
      for (const candidate of [basePath, `${basePath}.ts`, `${basePath}.tsx`, path.join(basePath, "index.ts")]) {
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

const actionRequests = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/actionRequest.ts"));
const {
  restorePendingActionRequest,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/actionRequestRestore.ts"));
const {
  buildPlanApprovalIdentity,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/planApprovalIdentity.ts"));
const {
  sanitizeRestoredPlanArtifacts,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/planArtifactRestore.ts"));

const owner = {
  status: "paused",
  sessionKey: "md-viewer-session",
  turnId: "turn-plan-draft",
  runId: "run-plan-draft",
};

function choiceBlock(request, content) {
  return {
    id: 101,
    type: "agent",
    turnId: request.turnId,
    content,
    options: request.optionValues.map((value) => ({ label: value, value })),
    choiceRequest: actionRequests.toUserChoiceResolutionIdentity(request),
  };
}

function structurallyValidUnsupportedPlanArtifact() {
  return {
    kind: "plan",
    path: ".MAIN/plans/plan.md",
    title: "MD Viewer 文件打开修复计划",
    revision: 1,
    updatedAt: 100,
    content: [
      "# MD Viewer 文件打开修复计划",
      "",
      "## 用户目标",
      "- 修复双击 Markdown 文件后窗口空白和工具栏打开按钮无效的问题。",
      "",
      "## 摘要",
      "- 已读取 `src-tauri/src/main.rs`、`src/main.js` 和 `src/components/toolbar.js`，准备连接文件打开链路。",
      "",
      "## 关键改动",
      "- 在 `src-tauri/src/main.rs` 中将解析后的文件路径发送给前端。",
      "- `src/main.js` 可能需要新增 `open-file` 事件监听器后再调用现有加载入口。",
      "",
      "## 公共 API / 接口 / 类型",
      "- 保持现有 `open-file` 事件名称和路径载荷不变。",
      "",
      "## 执行步骤",
      "1. 补齐后端事件发送。",
      "2. 连接前端事件监听。",
      "",
      "## 验证标准",
      "- 双击文件和点击打开按钮均可加载内容。",
      "",
      "## 测试方案",
      "- 运行 `cargo check` 并手动验证两种入口。",
      "",
      "## 假设与默认值",
      "- 默认前端尚未注册 `open-file` 监听器。",
      "",
    ].join("\n"),
  };
}

test("restore clears the MD Viewer internal continuation options from an unapproved Plan turn", () => {
  const optionValues = [
    "我需要先查看 main.js 中是否有 open-file 事件监听器，再决定方案",
    "先修复 main.rs 中的 handle_open_url，再处理前端部分",
    "我需要了解 Tauri 2 dialog 插件的正确导入方式后再执行",
  ];
  const request = actionRequests.buildUserChoiceActionRequest({
    sessionKey: owner.sessionKey,
    turnId: owner.turnId,
    runId: owner.runId,
    title: "选择下一步",
    optionValues,
    allowCustomReply: true,
    now: 200,
  });
  const block = choiceBlock(request, [
    "# 问题根因确认（8 条要点）",
    "",
    "## 已读证据",
    "- `src-tauri/src/main.rs` 的 `handle_open_url` 目前未发送路径。",
    "- `src/components/toolbar.js` 没有等待 dialog Promise。",
    "",
    "## 关键改动",
    "- 连接后端 URL 回调、前端事件监听和工具栏异步文件选择链路。",
  ].join("\n"));

  const restored = restorePendingActionRequest({
    request,
    runOwner: owner,
    taskFlow: [block],
    unapprovedPlanTurnIds: [owner.turnId],
  });

  assert.equal(restored, null);
});

test("restore retains an exact genuine user-visible blocking choice", () => {
  const optionValues = [
    "启动时默认显示空白页，由用户手动选择文件",
    "启动时自动恢复上次打开的 Markdown 文件",
  ];
  const request = actionRequests.buildUserChoiceActionRequest({
    sessionKey: owner.sessionKey,
    turnId: owner.turnId,
    runId: owner.runId,
    title: "选择启动体验",
    optionValues,
    allowCustomReply: false,
    now: 201,
  });
  const block = choiceBlock(request, [
    "# MD Viewer 启动体验决策",
    "",
    "这是用户可见的启动行为，真正阻塞计划，需要用户确认后才能确定持久化范围。",
    "请选择默认显示空白页，还是自动恢复上次打开的文件。",
  ].join("\n"));

  const restored = restorePendingActionRequest({
    request,
    runOwner: owner,
    taskFlow: [block],
    unapprovedPlanTurnIds: [owner.turnId],
  });

  assert.equal(restored?.requestId, request.requestId);
  assert.deepEqual(restored?.optionValues, optionValues);
});

test("restore clears plan_review requests when the hash or artifact is invalid", () => {
  const validIdentity = {
    revision: 2,
    artifactHash: "plan-current",
    artifactPaths: [".MAIN/plans/plan.md"],
    artifactCount: 1,
  };
  const staleHashRequest = actionRequests.buildPlanReviewActionRequest({
    sessionKey: owner.sessionKey,
    turnId: owner.turnId,
    runId: owner.runId,
    title: "审查计划",
    planRevision: validIdentity.revision,
    artifactHash: "plan-stale",
    artifactPaths: validIdentity.artifactPaths,
    now: 202,
  });

  assert.equal(restorePendingActionRequest({
    request: staleHashRequest,
    runOwner: owner,
    planIdentity: validIdentity,
  }), null);

  const sanitized = sanitizeRestoredPlanArtifacts({
    artifacts: [structurallyValidUnsupportedPlanArtifact()],
    isPlanApproved: false,
  });
  const invalidArtifactIdentity = buildPlanApprovalIdentity(sanitized.artifacts);
  const invalidArtifactRequest = actionRequests.buildPlanReviewActionRequest({
    sessionKey: owner.sessionKey,
    turnId: owner.turnId,
    runId: owner.runId,
    title: "审查计划",
    planRevision: 1,
    artifactHash: "plan-persisted-invalid",
    artifactPaths: [".MAIN/plans/plan.md"],
    now: 203,
  });

  assert.deepEqual(sanitized.artifacts, []);
  assert.equal(invalidArtifactIdentity, null);
  assert.equal(restorePendingActionRequest({
    request: invalidArtifactRequest,
    runOwner: owner,
    planIdentity: invalidArtifactIdentity,
  }), null);
});
