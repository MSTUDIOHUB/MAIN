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

const {
  composePlanArtifactFromEvidence,
  composeReviewablePlanFromEvidence,
  isMaterializablePlanLikeText,
  materializePlanArtifactFromVisibleText,
  sanitizePlanEvidenceInput,
} = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/lib/planMaterialization.ts"),
);
const {
  validateActionablePlanArtifact,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/workflowModels.ts"));

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

test("materializes Codex-style proposed_plan blocks without requiring write tools", () => {
  const result = materializePlanArtifactFromVisibleText({
    visibleText: [
      "<proposed_plan>",
      "# Plan",
      "",
      "## Summary",
      "- User goal: refactor MAIN Plan mode so a reviewable plan can be produced from visible text.",
      "- Grounding evidence covers `src/lib/orchestrator.ts` and `src/lib/planMaterialization.ts`.",
      "",
      "## Key Changes",
      "- Update `src/lib/orchestrator.ts` so hidden-only reasoning length closes through deterministic materialization.",
      "- Update `src/lib/planMaterialization.ts` to accept visible proposed plan text.",
      "- Preserve `.MAIN/plans/plan.md` as the runtime materialized approval artifact.",
      "",
      "## Public APIs / Interfaces / Types",
      "- No public API, interface, or type changes; this only changes internal plan runtime behavior.",
      "",
      "## Test Plan",
      "- Run `node --test tests/node/plan-runtime-state.test.mjs tests/node/plan-materialization.test.mjs`.",
      "- Run `npm run build` after focused tests pass.",
      "",
      "## Assumptions / Defaults",
      "- Default to runtime materialization instead of asking the model to call write_file.",
      "- If evidence is insufficient, reopen only one targeted read-only pass before pausing.",
      "</proposed_plan>",
    ].join("\n"),
    userGoal: "Refactor MAIN Plan mode.",
  });

  assert.equal(result.ok, true);
  assert.equal(result.kind, "plan");
  assert.equal(result.path, ".MAIN/plans/plan.md");
  assert.doesNotMatch(result.content || "", /<\/?proposed_plan>/i);
});

test("canonicalizes OMLX proposed_plan with verification steps and assumptions", () => {
  const result = materializePlanArtifactFromVisibleText({
    visibleText: [
      "<proposed_plan>",
      "# Proposed Plan: 验证 OMLX 本地模型 Plan 请求落地",
      "",
      "## 摘要",
      "基于已确认的 `src/lib/planMaterialization.ts` 和 `src/lib/planRuntime.ts` 代码，以及 63 个通过的测试，Codex-style Plan flow refactor 已落地。本计划旨在通过构造真实 Plan 请求，验证 OMLX 本地模型能否正确触发 `<proposed_plan>` 解析并物化为 `.MAIN/plans/plan.md`。",
      "",
      "## 关键验证步骤",
      "1. **构造模拟请求**：生成包含 `<proposed_plan>` 标签的 Markdown 内容，模拟 OMLX 模型输出。",
      "2. **执行解析流程**：调用 `planMaterialization.ts` 中的核心解析函数，或运行集成测试模拟完整 Plan 流程。",
      "3. **验证物化结果**：检查 `.MAIN/plans/plan.md` 是否生成，内容是否包含预期的标题、摘要、关键实现改动等。",
      "4. **检查边界情况**：验证非 `<proposed_plan>` 格式是否按预期处理。",
      "",
      "## 测试方案",
      "- 运行 `node --test` 指定 Plan 解析 suite，确认现有单元测试覆盖 `<proposed_plan>` 解析逻辑。",
      "- 手动触发一次 Plan 流程，观察控制台日志和文件生成情况。",
      "",
      "## 公共 API/接口/类型变化",
      "无公共 API/接口/类型变化（仅验证现有逻辑）。",
      "",
      "## 假设与默认值",
      "- 假设 OMLX 本地模型输出格式符合 `<proposed_plan>` 规范。",
      "- 假设工作区权限允许写入 `.MAIN/plans/` 目录。",
      "</proposed_plan>",
    ].join("\n"),
    userGoal: "检查 Codex-style Plan flow refactor 是否完成落地，并用 OMLX 本地模型验证真实 Plan 请求是否能进入可审阅方案。",
    evidence: [
      "read_file src/lib/orchestrator.ts; excerpt=Plan runtime 会按 phase 收窄工具面",
      "read_file src/lib/planRuntime.ts; excerpt=reasoning-only 在证据 ready 时走 deterministic_materialization",
      "read_file src/lib/planMaterialization.ts; excerpt=支持 proposed_plan 物化到 plan.md",
      "cmd:node --test Plan suite passed",
      "cmd:npm run build passed",
    ],
    files: ["src/lib/orchestrator.ts", "src/lib/planRuntime.ts", "src/lib/planMaterialization.ts"],
    language: "zh",
  });

  assert.equal(result.ok, true);
  assert.equal(result.path, ".MAIN/plans/plan.md");
  assert.match(result.content || "", /## 关键改动/);
  assert.match(result.content || "", /## 假设与默认值/);
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
  assert.match(result.content || "", /## 摘要/);
  assert.match(result.content || "", /用户提供了 2 张图片/);
  assert.match(result.content || "", /## 关键改动/);
  assert.match(result.content || "", /## 公共 API \/ 接口 \/ 类型/);
  assert.match(result.content || "", /## 测试方案/);
  assert.match(result.content || "", /## 假设与默认值/);
  assert.match(result.content || "", /src\/components\/FileUploader\/DragUpload\.tsx/);
});

test("canonicalizes Chinese formal repair plan with likely root causes", () => {
  const result = materializePlanArtifactFromVisibleText({
    visibleText: [
      "正式计划：修复计划：数据不显示 + 深色模式",
      "",
      "根因分析",
      "问题 1：数据不显示",
      "可能根因：CSV 数据已经被 useChartData 解析，但 dashboardStore 聚合指标时没有把最新 dataset 同步到概览状态。",
      "",
      "修复方案",
      "- 修改 `src/store/dashboardStore.ts`，让导入后的 records 写入 dashboard 统计源，并保持空数据兜底。",
      "- 检查 `src/hooks/useChartData.ts` 到 store 的数据流，避免组件只读取旧缓存。",
      "",
      "问题 2：深色模式",
      "可能根因：`src/App.tsx` 只切换了基础 theme token，表格、卡片和图表区域仍使用浅色背景。",
      "",
      "修复方案",
      "- 更新 `src/App.tsx` 的 dark token 与页面容器 class，补齐卡片、表格、筛选控件和图表容器的深色变量。",
      "- 保持现有 ThemeType 和 localStorage key 不变。",
      "| 取舍点 | 选择 | 理由 |",
      "|--------|------|------|",
      "| 深色模式方案 | 使用 CSS 变量 + 主题切换 | 可维护性好，支持动态切换 |",
      "| 数据修复范围 | 先修复数据绑定，再优化 UI | 核心问题是数据不显示 |",
      "---",
      "",
      "影响文件",
      "- `src/store/dashboardStore.ts`",
      "- `src/hooks/useChartData.ts`",
      "- `src/App.tsx`",
      "",
      "验证方式",
      "- 运行 `npm run build`。",
      "- 导入示例 CSV，确认概览指标、图表和表格数据显示。",
      "- 切换 light/dark 模式，确认深色模式下文字、背景和边框对比正常。",
    ].join("\n"),
    userGoal: "修复数据不显示和深色模式问题。",
    evidence: [
      "read_file src/store/dashboardStore.ts; excerpt=dashboard store aggregates imported rows into overview metrics",
      "read_file src/hooks/useChartData.ts; excerpt=hook prepares chart data from imported records",
      "grep_search src/App.tsx; excerpt=type ThemeType = 'light' | 'dark'",
    ],
    files: ["src/store/dashboardStore.ts", "src/hooks/useChartData.ts", "src/App.tsx"],
    language: "zh",
  });

  assert.equal(result.ok, true);
  assert.equal(result.path, ".MAIN/plans/plan.md");
  assert.equal(result.source, "canonicalized_visible_plan");
  assert.match(result.content || "", /^# 计划/);
  assert.match(result.content || "", /## 假设与默认值/);
  assert.match(result.content || "", /可能根因/);
  assert.match(result.content || "", /src\/store\/dashboardStore\.ts/);
  assert.match(result.content || "", /\n\| 取舍点 \| 选择 \| 理由 \|/);
  assert.doesNotMatch(result.content || "", /- \| 取舍点/);
  assert.doesNotMatch(result.content || "", /- ---/);
  assert.doesNotMatch(result.content || "", /最小源码变更|最小可用闭环/);
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
  assert.match(result.content || "", /## Summary/);
  assert.match(result.content || "", /Read file: src\/lib\/planMaterialization\.ts/);
  assert.match(result.content || "", /## Key Changes/);
  assert.match(result.content || "", /## Public APIs \/ Interfaces \/ Types/);
  assert.match(result.content || "", /## Test Plan/);
  assert.match(result.content || "", /## Assumptions \/ Defaults/);
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
  assert.match(result.content || "", /## 假设与默认值/);
  assert.match(result.content || "", /自动保存历史版本：MVP 不做/);
  assert.match(result.content || "", /权限策略编辑 UI：后续增强/);
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

test("composes deterministic reviewable plan artifact after repeated quality rejects", () => {
  const content = composePlanArtifactFromEvidence({
    userGoal: "修复 CSV 导入后 Dashboard 指标没有正确更新的问题。",
    evidence: [
      "read_file src/store/dashboardStore.ts; excerpt=store 保存 dashboard 指标和导入状态",
      "read_file src/hooks/useCsvParser.ts; excerpt=解析 CSV 行并返回记录",
      "read_file src/hooks/useChartData.ts; excerpt=映射图表数据",
    ],
    files: [
      "src/store/dashboardStore.ts",
      "src/hooks/useCsvParser.ts",
      "src/hooks/useChartData.ts",
    ],
    constraints: ["批准前不修改源码。"],
    language: "zh",
  });

  assert.equal(validateActionablePlanArtifact(content).ok, true);
  assert.match(content, /## 摘要/);
  assert.match(content, /## 关键改动/);
  assert.match(content, /## 公共 API \/ 接口 \/ 类型/);
  assert.match(content, /## 测试方案/);
  assert.match(content, /## 假设与默认值/);
  assert.match(content, /dashboardStore\.ts/);
  assert.doesNotMatch(content, /MAIN TOOL FEEDBACK|ContextMemoryState|RecoveryDetails/);
});

test("composes deterministic plan artifact from real tool feedback without leaking envelopes", () => {
  const content = composePlanArtifactFromEvidence({
    userGoal: "修复 CSV 导入后 Dashboard 指标没有正确更新的问题。",
    evidence: [
      `[MAIN_TOOL_FEEDBACK_V1]{"version":1,"status":"completed","tool_call_id":"call_a","tool":"read_file","target":"src/store/dashboardStore.ts","summary":"status=observed hash=abc123 excerpt=store 保存 dashboard 指标和导入状态"}\nraw file body omitted`,
      "read_file; src/hooks/useCsvParser.ts; status=observed hash=def456 excerpt=解析 CSV 行并返回记录",
      "tool=read_file target=src/hooks/useChartData.ts status=observed hash=ghi789 excerpt=映射图表数据",
    ],
    files: [
      "src/store/dashboardStore.ts",
      "src/hooks/useCsvParser.ts",
      "src/hooks/useChartData.ts",
    ],
    constraints: ["批准前不修改源码。"],
    language: "zh",
  });

  assert.equal(validateActionablePlanArtifact(content).ok, true);
  assert.match(content, /已读取文件：src\/store\/dashboardStore\.ts/);
  assert.match(content, /无公共 API|公共 API/);
  assert.match(content, /useCsvParser\.ts/);
  assert.match(content, /useChartData\.ts/);
  assert.doesNotMatch(content, /MAIN_TOOL_FEEDBACK|tool_call_id|status=observed|hash=|excerpt=/);
});

test("sanitizes repeated quality-gate evidence before deterministic plan materialization", () => {
  const sanitized = sanitizePlanEvidenceInput({
    userGoal: "修复 ChatArea 有效进展和计划生成流程。",
    evidence: [
      "read_file src/App.tsx; status=observed; 6,604 chars; hash=yvpop5; summary=READ_FILE_RESULT path: src/App.tsx truncated: true totalLines: 292 returnedLines: 1-180",
      "write_file .MAIN/plans/plan.md; status=failed; 303 chars; hash=1lazvvo; summary=Error: PLAN NOT READY: .MAIN/plans/plan.md 没有写入。",
      "...[ContextMemory truncated to fit request budget]",
      "get_project_skeleton get_project_skeleton; status=failed; summary=Error: TASK_TARGETING_BLOCKED",
      "glob_search **/*.ts; status=observed; exit=439376; summary=[\"node_modules/@ant-design/colors/es/generate.d.ts\",\"src/App.ts\"]",
      `[MAIN_TOOL_FEEDBACK_V1]{"version":1,"status":"completed","tool_call_id":"call_a","tool":"read_file","target":"src/components/ChatArea.tsx","summary":"status=observed hash=abc123 excerpt=ChatArea renders progress blocks"}\nREAD_FILE_RESULT path: src/components/ChatArea.tsx`,
    ],
    files: [
      "src/App.tsx via read_file; hash=yvpop5; 6,604 chars",
      ".MAIN/plans/plan.md via write_file; hash=1lazvvo; 303 chars",
      "...[ContextMemory truncated to fit request budget]",
      "src/components/ChatArea.tsx",
    ],
    constraints: ["批准前不修改源码。", "ContextMemoryState v1: noisy"],
    language: "zh",
  });

  assert.deepEqual(sanitized.files.sort(), ["src/App.tsx", "src/components/ChatArea.tsx"].sort());
  assert.equal(sanitized.evidence.length, 2);
  assert.match(sanitized.evidence.join("\n"), /read_file src\/App\.tsx/);
  assert.match(sanitized.evidence.join("\n"), /read_file src\/components\/ChatArea\.tsx/);
  assert.doesNotMatch(sanitized.evidence.join("\n"), /PLAN NOT READY|ContextMemory|hash=|status=|READ_FILE_RESULT|TASK_TARGETING_BLOCKED|\*\*\/\*\.ts|node_modules/);
  assert.equal(sanitized.stats.dropReasons.plan_artifact_tool_log, 1);
  assert.ok(sanitized.stats.dropped >= 3);

  const content = composePlanArtifactFromEvidence({
    userGoal: sanitized.userGoal,
    evidence: sanitized.evidence,
    files: sanitized.files,
    constraints: sanitized.constraints,
    language: "zh",
  });

  assert.equal(validateActionablePlanArtifact(content).ok, true);
  assert.doesNotMatch(content, /PLAN NOT READY|ContextMemory|hash=|status=|READ_FILE_RESULT|TASK_TARGETING_BLOCKED/);
});

test("rejects generic ten-section fallback plan as non-Codex handoff", () => {
  const content = [
    "# 计划",
    "",
    "## 用户目标",
    "- 修复 ChatArea 有效进展和计划生成流程。",
    "",
    "## 截图/附件观察",
    "- 除非用户提供的上下文中已有明确细节，否则不信任额外截图或附件推断。",
    "",
    "## 已读证据",
    "- 已读取文件：src/App.tsx",
    "- 已读取文件：src/components/ChatArea.tsx",
    "",
    "## 已确认事实",
    "- 已确认存在相关计划证据：已读取文件：src/App.tsx",
    "",
    "## 未验证假设",
    "- 证据没有直接覆盖的实现细节，必须在源码修改前通过定向读取确认。",
    "",
    "## 影响文件",
    "- src/App.tsx",
    "- src/components/ChatArea.tsx",
    "",
    "## 执行步骤",
    "1. 基于已确认的证据先收窄实现目标，再修改源码。",
    "2. 实施满足用户目标的最小源码变更。",
    "3. 用聚焦测试、构建检查或浏览器/桌面验证确认行为达标。",
    "",
    "## 风险取舍",
    "- 重复缓存读取不能算作新证据。",
    "",
    "## 验证标准",
    "- 运行受影响子系统的聚焦验证命令。",
  ].join("\n");

  const validation = validateActionablePlanArtifact(content);
  assert.equal(validation.ok, false);
  assert.equal(validation.reason, "generic_fallback_plan");
});

test("deterministic materialization refuses insufficient evidence", () => {
  const content = composePlanArtifactFromEvidence({
    userGoal: "修复计划审批流程。",
    evidence: [],
    files: [],
    constraints: [],
    language: "zh",
  });
  const result = materializePlanArtifactFromVisibleText({
    visibleText: content,
    language: "zh",
  });

  assert.equal(result.ok, false);
  assert.match(result.reason || "", /quality_gate|insufficient|missing|too_short|not_structured/);
});

test("materializes explicit design text to design.md", () => {
  const result = materializePlanArtifactFromVisibleText({
    visibleText: [
      "# Design",
      "",
      "## 用户目标与约束",
      "- 目标：基于 orders.csv 设计课程销售分析自动化流程。",
      "- 约束：批准前只写 `.MAIN/plans/design.md`，不生成 tasks.md。",
      "",
      "## 当前发现",
      "- 已读取课程名称样例，确认 CSV 可通过表格工具查询。",
      "",
      "## 方案",
      "- 识别字段、校验金额和时间格式，再生成课程维度销售摘要。",
      "",
      "## 影响文件与接口",
      "- 计划文件：`.MAIN/plans/design.md`。",
      "",
      "## 执行顺序",
      "1. 明确字段映射。",
      "2. 设计聚合指标。",
      "3. 审批后再生成任务清单。",
      "",
      "## 数据流与验证",
      "- 数据流：CSV 输入 -> 表格查询 -> 指标汇总 -> 报表草稿。",
      "- 验证：抽样核对课程名称、订单数和金额聚合结果。",
    ].join("\n"),
    language: "zh",
  });

  assert.equal(result.ok, true);
  assert.equal(result.kind, "design");
  assert.equal(result.path, ".MAIN/plans/design.md");
});
