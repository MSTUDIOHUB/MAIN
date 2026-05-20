import test from "node:test";
import assert from "node:assert/strict";
import fsSync from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

import ts from "typescript";

const workspaceRoot = process.cwd();
const transpiledModuleCache = new Map();

function loadTranspiledModuleSync(sourcePath) {
  const normalizedPath = path.resolve(sourcePath);
  if (transpiledModuleCache.has(normalizedPath)) {
    return transpiledModuleCache.get(normalizedPath);
  }

  const source = fsSync.readFileSync(normalizedPath, "utf8");
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
    fileName: normalizedPath,
  }).outputText;

  const module = { exports: {} };
  transpiledModuleCache.set(normalizedPath, module.exports);
  const localRequire = createRequire(normalizedPath);
  const runtimeRequire = (specifier) => {
    if (specifier.startsWith(".")) {
      const basePath = path.resolve(path.dirname(normalizedPath), specifier);
      const candidates = [
        basePath,
        `${basePath}.ts`,
        `${basePath}.tsx`,
        path.join(basePath, "index.ts"),
      ];

      for (const candidate of candidates) {
        if (!fsSync.existsSync(candidate)) continue;
        if (candidate.endsWith(".ts") || candidate.endsWith(".tsx")) {
          return loadTranspiledModuleSync(candidate);
        }
      }
    }
    return localRequire(specifier);
  };

  const factory = new Function("exports", "module", "require", transpiled);
  factory(module.exports, module, runtimeRequire);
  transpiledModuleCache.set(normalizedPath, module.exports);
  return module.exports;
}

const { composeReviewableDesignFromEvidence, isMaterializablePlanLikeText, materializePlanArtifactFromVisibleText } = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/lib/planMaterialization.ts"),
);

test("materializes valid visible design text into design.md artifact", () => {
  const result = materializePlanArtifactFromVisibleText({
    visibleText: [
      "# Proposed Plan",
      "",
      "## 用户目标与约束",
      "- 修复 MAIN Plan 模式闭环，让复杂实现请求生成可审批计划文件。",
      "- 批准前不修改源码交付物，只允许写入 `.MAIN/plans/design.md`。",
      "",
      "## 当前状态发现",
      "- 现有流程能解析部分工具调用，但普通 Markdown 方案不会同步到 PlanPanel。",
      "- 本地模型偶尔返回伪工具或空响应，需要可恢复检查点。",
      "",
      "## 拟定方案",
      "- 在编排层增加 materialization guard，从可见 Markdown 中生成正式 design artifact。",
      "- 在工具执行前清理路径、数字参数和残缺 XML 标签。",
      "- 在 UI 层展示友好动作名，隐藏协议参数细节。",
      "",
      "## 影响文件和接口",
      "- `src/lib/orchestrator.ts` 接入自动落盘和空响应恢复。",
      "- `src/lib/textToolParser.ts` 与 `src/lib/sanitize.ts` 扩展本地模型兼容。",
      "- 新增 helper 不改变外部工具 schema。",
      "",
      "## 执行顺序",
      "1. 先完成只读探索和计划草稿生成。",
      "2. 再等待用户批准进入执行。",
      "3. 最后生成 tasks.md 并实施源码改动。",
      "",
      "## 数据流与控制流",
      "- LLM 输出先归一化，再判断工具调用；没有工具但存在有效方案时写入设计文件。",
      "- 写入成功后刷新 PlanPanel，并进入 pending_review。",
      "",
      "## 风险取舍",
      "- 低质量内容必须被质量门禁拦截，避免把闲聊误写成计划。",
      "- 只允许 design 自动物化，避免越权写源码。",
      "",
      "## 验证方式",
      "- 增加 Node 单测覆盖解析、清洗、提示词和计划物化。",
      "- 通过 E2E 复现空响应与伪工具链路。",
      "",
      "## 开放问题",
      "- 是否需要为更多本地模型格式继续扩展兼容。",
    ].join("\n"),
  });

  assert.equal(result.ok, true);
  assert.equal(result.kind, "design");
  assert.equal(result.path, ".MAIN/plans/design.md");
  assert.match(result.content || "", /^# Proposed Plan/);
});

test("materializes Gemma-style markdown fix plan without structured proposal tags", () => {
  const visibleText = [
    "## 修复方案",
    "",
    "### 目标与约束",
    "- 目标：修复 MAIN 计划审批链路，避免本地 Gemma4 输出普通方案后绕过 design.md。",
    "- 约束：未批准前只能写 `.MAIN/plans/design.md`，不能修改业务源码。",
    "",
    "### 当前发现",
    "- 日志显示 `hasStructuredProposal:false`，但系统合成了 approve_operation_once。",
    "- Quick Reply 随后进入普通 execute/edit，`planStage` 仍是 idle。",
    "",
    "### 实施步骤",
    "1. 修改 `src/lib/planMaterialization.ts`，支持普通 Markdown 方案自动物化。",
    "2. 修改 `src/lib/orchestrator.ts`，在暂停审批前先尝试写入 `.MAIN/plans/design.md`。",
    "3. 修改 `src/App.tsx`，让 Plan quick reply 走计划审批而不是普通执行。",
    "",
    "### 数据流与控制流",
    "- 模型可见方案先经过物化质量门禁，再写入 design.md，随后进入 Plan Review。",
    "- 用户批准后调用 approvePlan，生成 runtime 任务并进入 executing。",
    "",
    "### 风险与注意事项",
    "- 低质量闲聊不能落盘，避免污染计划面板。",
    "- 保留普通聊天的一次性操作审批，不影响轻量任务。",
    "",
    "### 验证方式",
    "- 增加 Node 单测覆盖 Gemma4 普通方案和 quick reply 路由。",
    "- 验证批准后仍可使用 Browser/Playwright 证据工具。",
  ].join("\n");

  const result = materializePlanArtifactFromVisibleText({ visibleText });

  assert.equal(result.ok, true);
  assert.equal(result.path, ".MAIN/plans/design.md");
  assert.equal(isMaterializablePlanLikeText(visibleText), true);
});

test("materializes Qwen-style plan and strips user option markup", () => {
  const result = materializePlanArtifactFromVisibleText({
    visibleText: [
      "### 目标",
      "- 修复 Qwen 在 Plan 模式下直接输出方案和选项时无法生成 design.md 的问题。",
      "",
      "### 方案",
      "- 在 `src/lib/replyOptions.ts` 标记 proposal_follow_up 选项。",
      "- 在 `src/lib/orchestrator.ts` 看到选项时先自动物化方案。",
      "- 在 `src/lib/planControl.ts` 区分 approve_existing_plan 和 materialize_then_approve。",
      "",
      "### 执行顺序",
      "1. 先补计划文本质量识别。",
      "2. 再接 quick reply 路由。",
      "3. 最后补测试和 Browser/Playwright 验证能力断言。",
      "",
      "### 数据流",
      "- ChatArea 方案文本 -> materializePlanArtifactFromVisibleText -> `.MAIN/plans/design.md` -> approvePlan。",
      "",
      "### 风险与边界",
      "- 不为 Qwen 或 Gemma4 写模型名分支，只按输出形态判断。",
      "- 普通讨论仍留在聊天区，不强制落盘。",
      "",
      "### 验证方式",
      "- 运行 `node --test tests/node/plan-materialization.test.mjs tests/node/reply-options.test.mjs`。",
      "",
      "<user_options>",
      "<option action=\"approve_operation_once\" value=\"我批准按上面的方案开始真实操作，请复用上一轮方案，不要重新规划，直接执行并验证\">批准执行本轮操作</option>",
      "<option action=\"adjust_plan\" value=\"继续调整上面的方案，暂不执行真实操作\">继续调整方案</option>",
      "</user_options>",
    ].join("\n"),
  });

  assert.equal(result.ok, true);
  assert.doesNotMatch(result.content || "", /user_options|approve_operation_once/);
});

test("rejects low quality visible text instead of materializing a plan", () => {
  const result = materializePlanArtifactFromVisibleText({
    visibleText: "好的，我会继续处理这个问题，稍后给出计划。",
  });

  assert.equal(result.ok, false);
  assert.match(result.reason || "", /too_short|not_structured|quality_gate/);
});

test("materializes MVP defaults without requiring open questions", () => {
  const result = materializePlanArtifactFromVisibleText({
    visibleText: [
      "# Design",
      "",
      "## 用户目标与约束",
      "- 用户目标：修复计划执行阶段的权限闭环，避免批准后陷入命令拦截循环。",
      "- 约束：批准 Plan 不绕过 shell 权限，执行前必须有 runtime 任务清单，长任务再持久化 tasks.md。",
      "",
      "## 当前状态发现",
      "- `src/lib/runtimeTools.ts` 负责计划工具门禁。",
      "- `src-tauri/src/harness/permissions.rs` 负责 shell 权限策略。",
      "",
      "## 拟定方案",
      "- 在 execute 阶段缺少 runtime 任务清单时阻止 shell 和源码写入。",
      "- 为 shell 权限增加 allow/ask/deny 结构化预检。",
      "",
      "## 影响文件和接口",
      "- `src/lib/runtimeTools.ts` 增加 missing_tasks_before_source gate。",
      "- `src-tauri/src/harness/permissions.rs` 返回 structured permission decision。",
      "",
      "## 执行顺序",
      "1. 先补计划执行门禁。",
      "2. 再接入 shell preflight 审批。",
      "3. 最后更新提示和测试。",
      "",
      "## 数据流与控制流",
      "- ActionCard 先读取 preflight 结果，再把批准 metadata 传给工具执行。",
      "- 后端再次校验命令未变且 deny 未命中。",
      "",
      "## 风险取舍",
      "- 保留 deny 优先，避免前端批准覆盖危险命令。",
      "- ask 命令不进入静默 allow，降低联网和项目改写风险。",
      "",
      "## 验证方式",
      "- Node 单测覆盖计划门禁。",
      "- Rust 单测覆盖 builtin_default、ask 和 deny。",
      "",
      "## 默认假设与后续增强",
      "- 自动保存历史版本：MVP 不做。",
      "- 权限策略编辑 UI：后续增强。",
    ].join("\n"),
  });

  assert.equal(result.ok, true);
  assert.equal(result.path, ".MAIN/plans/design.md");
  assert.match(result.content || "", /默认假设与后续增强/);
});

test("composes strict design closure prompt from evidence without tool logs", () => {
  const prompt = composeReviewableDesignFromEvidence({
    userGoal: "制作 Mac 轻量软件分析课程销售 CSV。",
    evidence: [
      "analyze_tabular_document orders.csv; status=observed; 7441 chars; hash=abc123; excerpt=课程名称 | 订单金额 | 购买时间",
      "[MAIN TOOL FEEDBACK V1]{\"tool\":\"list_directory\"}",
    ],
    files: ["orders.csv"],
    language: "zh",
  });

  assert.match(prompt, /生成可审阅、可执行的正式设计方案/);
  assert.match(prompt, /orders\.csv/);
  assert.match(prompt, /课程名称/);
  assert.doesNotMatch(prompt, /MAIN TOOL FEEDBACK/);
  assert.doesNotMatch(prompt, /ContextMemoryState v1/);
});
