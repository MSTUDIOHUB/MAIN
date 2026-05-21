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

const { composeReviewablePlanFromEvidence, isMaterializablePlanLikeText, materializePlanArtifactFromVisibleText } = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/lib/planMaterialization.ts"),
);

test("materializes valid visible plan text into plan.md artifact", () => {
  const result = materializePlanArtifactFromVisibleText({
    visibleText: [
      "# Proposed Plan",
      "",
      "## 用户目标与约束",
      "- 修复 MAIN Plan 模式闭环，让复杂实现请求生成可审批计划文件。",
      "- 批准前不修改源码交付物，只允许写入 `.MAIN/plans/plan.md`。",
      "",
      "## 当前状态发现",
      "- 现有流程能解析部分工具调用，但普通 Markdown 方案不会同步到 PlanPanel。",
      "- 本地模型偶尔返回伪工具或空响应，需要可恢复检查点。",
      "",
      "## 截图/附件观察",
      "- 本轮没有提供截图或附件，计划只基于用户目标和已读代码证据。",
      "",
      "## 已读证据",
      "- `src/lib/planMaterialization.ts` 负责把可见 Markdown 方案物化为计划文件。",
      "- `src/lib/orchestrator.ts` 负责审批前后的计划状态流转。",
      "",
      "## 真实发现",
      "- 可见方案需要通过质量门禁后写入 `.MAIN/plans/plan.md`。",
      "",
      "## 未验证假设",
      "- 未验证：更多本地模型可能还有额外的伪工具格式，需要后续按日志补兼容。",
      "",
      "## 拟定方案",
      "- 在编排层增加 materialization guard，从可见 Markdown 中生成正式 plan artifact。",
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
      "- LLM 输出先归一化，再判断工具调用；没有工具但存在有效方案时写入 plan.md。",
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
  assert.equal(result.kind, "plan");
  assert.equal(result.path, ".MAIN/plans/plan.md");
  assert.match(result.content || "", /^# Proposed Plan/);
});

test("materializes Gemma-style markdown fix plan without structured proposal tags", () => {
  const visibleText = [
    "## 修复方案",
    "",
    "### 目标与约束",
    "- 目标：修复 MAIN 计划审批链路，避免本地 Gemma4 输出普通方案后绕过 plan.md。",
    "- 约束：未批准前只能写 `.MAIN/plans/plan.md`，不能修改业务源码。",
    "",
    "### 当前发现",
    "- 日志显示 `hasStructuredProposal:false`，但系统合成了 approve_operation_once。",
    "- Quick Reply 随后进入普通 execute/edit，`planStage` 仍是 idle。",
    "",
    "### 截图/附件观察",
    "- 本轮没有提供截图或附件；证据来自日志现象和计划链路文件。",
    "",
    "### 已读证据",
    "- `src/lib/planMaterialization.ts` 负责普通 Markdown 方案识别。",
    "- `src/lib/orchestrator.ts` 负责在暂停审批前写入计划文件。",
    "",
    "### 真实发现",
    "- 普通 Markdown 方案必须落到 `.MAIN/plans/plan.md` 才能进入 Plan Review。",
    "",
    "### 未验证假设",
    "- 未验证：Gemma4 的后续输出格式可能仍需补更多 fixture。",
    "",
    "### 实施步骤",
    "1. 修改 `src/lib/planMaterialization.ts`，支持普通 Markdown 方案自动物化。",
    "2. 修改 `src/lib/orchestrator.ts`，在暂停审批前先尝试写入 `.MAIN/plans/plan.md`。",
    "3. 修改 `src/App.tsx`，让 Plan quick reply 走计划审批而不是普通执行。",
    "",
    "### 影响文件和接口",
    "- `src/lib/planMaterialization.ts`",
    "- `src/lib/orchestrator.ts`",
    "- `src/App.tsx`",
    "",
    "### 数据流与控制流",
    "- 模型可见方案先经过物化质量门禁，再写入 plan.md，随后进入 Plan Review。",
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
  assert.equal(result.path, ".MAIN/plans/plan.md");
  assert.equal(isMaterializablePlanLikeText(visibleText), true);
});

test("materializes Qwen-style plan and strips user option markup", () => {
  const result = materializePlanArtifactFromVisibleText({
    visibleText: [
      "### 目标",
      "- 修复 Qwen 在 Plan 模式下直接输出方案和选项时无法生成 plan.md 的问题。",
      "",
      "### 截图/附件观察",
      "- 未提供截图或附件；依据为 Qwen 方案文本与 quick reply 行为。",
      "",
      "### 已读证据",
      "- `src/lib/replyOptions.ts` 解析 proposal follow-up 选项。",
      "- `src/lib/orchestrator.ts` 将可见方案物化到 `.MAIN/plans/plan.md`。",
      "",
      "### 真实发现",
      "- 带选项的普通 Markdown 计划需要去掉 `<user_options>` 后再通过质量门禁。",
      "",
      "### 未验证假设",
      "- 未验证：其它 Qwen 模板可能使用不同选项标签，需要后续按日志补充。",
      "",
      "### 方案",
      "- 在 `src/lib/replyOptions.ts` 标记 proposal_follow_up 选项。",
      "- 在 `src/lib/orchestrator.ts` 看到选项时先自动物化方案。",
      "- 在 `src/lib/planControl.ts` 区分 approve_existing_plan 和 materialize_then_approve。",
      "",
      "### 影响文件和接口",
      "- `src/lib/replyOptions.ts`",
      "- `src/lib/orchestrator.ts`",
      "- `src/lib/planControl.ts`",
      "",
      "### 执行顺序",
      "1. 先补计划文本质量识别。",
      "2. 再接 quick reply 路由。",
      "3. 最后补测试和 Browser/Playwright 验证能力断言。",
      "",
      "### 数据流",
      "- ChatArea 方案文本 -> materializePlanArtifactFromVisibleText -> `.MAIN/plans/plan.md` -> approvePlan。",
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

test("repairs visible plan text that has evidence but no explicit user goal section", () => {
  const visibleText = [
    "# 计划草稿",
    "",
    "## 截图/附件观察",
    "- 用户提供了当前界面截图；需要修复 CSV 导入后仪表盘指标没有同步展示的问题。",
    "",
    "## 已读证据",
    "- `src/store/dashboardStore.ts`：负责导入数据后的状态写入。",
    "- `src/hooks/useChartData.ts`：负责把 store 数据映射到图表。",
    "- `src/components/Dashboard/OverviewCards.tsx`：负责显示概览指标。",
    "",
    "## 真实发现",
    "- CSV 导入路径与 Dashboard 展示路径之间缺少一致的数据刷新契约。",
    "",
    "## 未验证假设",
    "- 未验证：OverviewCards 是否还依赖旧的缓存字段，需要在实施时通过测试确认。",
    "",
    "## 影响文件",
    "- `src/store/dashboardStore.ts`",
    "- `src/hooks/useChartData.ts`",
    "- `src/components/Dashboard/OverviewCards.tsx`",
    "",
    "## 执行步骤",
    "1. 统一 CSV 导入后的 store 更新入口。",
    "2. 调整图表数据 hook，确保读取最新状态。",
    "3. 更新概览指标组件并补充回归测试。",
    "",
    "## 验证标准",
    "- 运行相关 Node/Vitest 测试，手动导入 CSV 并确认 Dashboard 指标更新。",
  ].join("\n");

  const result = materializePlanArtifactFromVisibleText({
    visibleText,
    userGoal: "修复 CSV 导入后 Dashboard 指标没有正确更新的问题。",
  });

  assert.equal(result.ok, true);
  assert.match(result.content || "", /## 用户目标/);
  assert.match(result.content || "", /修复 CSV 导入后 Dashboard 指标没有正确更新/);
});

test("canonicalizes Gemma-like Proposed Plan with nonstandard section names", () => {
  const result = materializePlanArtifactFromVisibleText({
    visibleText: [
      "# Proposed Plan",
      "",
      "## Investigation Summary",
      "- CSV 导入入口已经定位到上传组件，Dashboard 指标更新依赖 store 数据流。",
      "- 需要避免把推测直接写成已执行事实。",
      "",
      "## Approach",
      "- 对齐上传组件到 store 的数据写入契约。",
      "- 让 Dashboard 指标读取导入后的最新状态。",
      "- 补一个导入后概览指标刷新的回归测试。",
      "",
      "## Files",
      "- `src/components/FileUploader/DragUpload.tsx`",
      "- `src/store/dashboardStore.ts`",
      "- `src/components/Dashboard/OverviewCards.tsx`",
      "",
      "## Validation",
      "- 运行相关 Node/Vitest 测试。",
      "- 手动导入 CSV，确认 Dashboard 指标刷新。",
    ].join("\n"),
    userGoal: "修复 CSV 导入后 Dashboard 指标没有正确更新的问题。",
    evidence: [
      "read_file src/components/FileUploader/DragUpload.tsx; excerpt=上传组件负责读取 CSV 文件并触发解析入口",
      "read_file src/store/dashboardStore.ts; excerpt=store 保存 dashboard 指标和导入状态",
    ],
    recentToolActivity: [
      {
        name: "read_file",
        target: "src/components/FileUploader/DragUpload.tsx",
        status: "succeeded",
        detail: "发现上传组件是 CSV 导入入口",
      },
    ],
    turnContext: { imageParts: 2 },
    language: "zh",
  });

  assert.equal(result.ok, true);
  assert.match(result.content || "", /^# 计划/);
  assert.match(result.content || "", /## 用户目标/);
  assert.match(result.content || "", /## 截图\/附件观察/);
  assert.match(result.content || "", /用户提供了 2 张图片/);
  assert.match(result.content || "", /## 已读证据/);
  assert.match(result.content || "", /## 已确认事实/);
  assert.match(result.content || "", /src\/components\/FileUploader\/DragUpload\.tsx/);
});

test("canonicalizes missing confirmed facts from the evidence ledger", () => {
  const result = materializePlanArtifactFromVisibleText({
    visibleText: [
      "# Proposed Plan",
      "",
      "## Goal",
      "- Fix the plan artifact loop when a local model writes a non-standard proposal.",
      "",
      "## Implementation Plan",
      "- Normalize the visible plan into MAIN's canonical plan sections.",
      "- Write the canonical content to `.MAIN/plans/plan.md` before prompting the model again.",
      "",
      "## Affected Files",
      "- `src/lib/planMaterialization.ts`",
      "- `src/lib/orchestrator.ts`",
      "",
      "## Validation",
      "- Run focused Node tests and the production build.",
    ].join("\n"),
    evidence: [
      "read_file src/lib/planMaterialization.ts; excerpt=visible markdown plans are materialized before review",
      "read_file src/lib/orchestrator.ts; excerpt=plan_text_materialization_rejected currently triggers recovery prompt",
    ],
    files: ["src/lib/planMaterialization.ts", "src/lib/orchestrator.ts"],
    language: "en",
  });

  assert.equal(result.ok, true);
  assert.match(result.content || "", /## Confirmed Facts/);
  assert.match(result.content || "", /Confirmed relevant evidence exists/);
  assert.match(result.content || "", /## Read Evidence/);
});

test("rejects tool-log noise instead of canonicalizing it", () => {
  const result = materializePlanArtifactFromVisibleText({
    visibleText: [
      "# Proposed Plan",
      "",
      "MAIN TOOL FEEDBACK V1 {\"tool\":\"read_file\",\"status\":\"ok\"}",
      "ContextMemoryState v1: lots of tool transcript data",
      "Repeated read-only tool call skipped because already called with identical arguments.",
      "",
      "<user_options>",
      "<option>批准执行</option>",
      "</user_options>",
    ].join("\n"),
    userGoal: "修复计划循环。",
    evidence: ["read_file src/lib/orchestrator.ts; excerpt=plan recovery prompt loop"],
  });

  assert.equal(result.ok, false);
  assert.match(result.reason || "", /tool_log_noise|not_structured|quality_gate|too_short/);
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
      "# Plan",
      "",
      "## 用户目标与约束",
      "- 用户目标：修复计划执行阶段的权限闭环，避免批准后陷入命令拦截循环。",
      "- 约束：批准 Plan 不绕过 shell 权限，执行前必须有 runtime 任务清单，长任务再持久化 tasks.md。",
      "",
      "## 当前状态发现",
      "- `src/lib/runtimeTools.ts` 负责计划工具门禁。",
      "- `src-tauri/src/harness/permissions.rs` 负责 shell 权限策略。",
      "",
      "## 截图/附件观察",
      "- 未提供截图或附件；本计划基于用户目标和上述源码证据。",
      "",
      "## 已读证据",
      "- `src/lib/runtimeTools.ts`：计划执行工具门禁。",
      "- `src-tauri/src/harness/permissions.rs`：shell 权限策略。",
      "",
      "## 真实发现",
      "- 执行阶段需要 runtime 任务清单和权限预检共同收束。",
      "",
      "## 未验证假设",
      "- 未验证：权限 UI 是否需要单独编辑入口，MVP 暂不实现。",
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
  assert.equal(result.path, ".MAIN/plans/plan.md");
  assert.match(result.content || "", /默认假设与后续增强/);
});

test("composes strict plan closure prompt from evidence without tool logs", () => {
  const prompt = composeReviewablePlanFromEvidence({
    userGoal: "制作 Mac 轻量软件分析课程销售 CSV。",
    evidence: [
      "analyze_tabular_document orders.csv; status=observed; 7441 chars; hash=abc123; excerpt=课程名称 | 订单金额 | 购买时间",
      "[MAIN TOOL FEEDBACK V1]{\"tool\":\"list_directory\"}",
    ],
    files: ["orders.csv"],
    language: "zh",
  });

  assert.match(prompt, /生成可审阅、可执行的正式计划/);
  assert.match(prompt, /orders\.csv/);
  assert.match(prompt, /课程名称/);
  assert.doesNotMatch(prompt, /MAIN TOOL FEEDBACK/);
  assert.doesNotMatch(prompt, /ContextMemoryState v1/);
});
