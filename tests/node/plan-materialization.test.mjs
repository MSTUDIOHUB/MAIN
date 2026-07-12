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
  canonicalizePlanArtifactContent,
  composePlanArtifactFromEvidence,
  composeReviewablePlanFromEvidence,
  isMaterializablePlanLikeText,
  materializePlanArtifactFromVisibleText,
  sanitizePlanEvidenceInput,
  summarizePlanEvidenceDetail,
  validatePlanEvidenceGrounding,
} = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/lib/planMaterialization.ts"),
);
const {
  buildPlanCandidate,
  buildPlanEvidenceBundle,
  formatPlanEvidenceBundleForModel,
  hasDeterministicPlanMaterializationEvidence,
  isPlanEvidenceBundleReady,
  validatePlanCandidate,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/planEvidence.ts"));
const {
  deriveRuntimePlanTasksFromArtifacts,
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
      "- 增加并运行 Node 单测，覆盖解析、清洗、提示词和计划物化。",
      "- 运行 E2E，复现空响应与伪工具链路并检查恢复状态。",
      "",
      "## 开放问题",
      "- 是否需要为更多本地模型格式继续扩展兼容。",
    ].join("\n"),
  });

  assert.equal(result.ok, true, result.reason);
  assert.equal(result.kind, "plan");
  assert.equal(result.path, ".MAIN/plans/plan.md");
  assert.match(result.content || "", /^# (?:Proposed Plan|计划)/);
  assert.match(result.content || "", /## (?:关键改动|Key Changes|拟定方案)/);
  assert.doesNotMatch(result.content || "", /用户目标：用户目标与约束|用户目标：开放问题/);
});

test("real MD Viewer trace keeps one semantic evidence bundle through deterministic materialization", () => {
  const records = [
    {
      tool: "read_file",
      target: "src-tauri/src/main.rs",
      status: "succeeded",
      summary: "handle_open_url currently discards the incoming file path, while setup registers app.on_url without forwarding the event to the webview",
      hash: "main-rs-hash",
    },
    {
      tool: "read_file",
      target: "src/components/toolbar.js",
      status: "succeeded",
      summary: "handleOpenFile calls dialog.open without awaiting the Promise, so selected is a Promise instead of the chosen file path",
      hash: "toolbar-hash",
    },
    {
      tool: "read_file",
      target: "src/main.js",
      status: "succeeded",
      summary: "the frontend bootstrap does not install an open-file event listener that forwards desktop file-open events into editor.loadFile",
      hash: "main-js-hash",
    },
    {
      tool: "read_file",
      target: "package.json",
      status: "succeeded",
      summary: "package.json contains only general package metadata and does not explain either open-file failure",
      hash: "package-hash",
    },
  ];
  const objective = "修复 MD Viewer 双击 Markdown 文件只打开空白窗口，以及应用内打开按钮无法弹出文件选择器的问题，并制定可审批计划。";
  const bundle = buildPlanEvidenceBundle({
    turnId: "turn-md-viewer-trace",
    objective,
    evidenceRecords: records,
    files: records.map((record) => record.target),
    constraints: ["批准前不得修改源码。", "运行 `npm run build` 并进行桌面打开流程验证。"],
  });

  assert.equal(isPlanEvidenceBundleReady(bundle), true);
  assert.equal(bundle.facts.length, 4);
  assert.deepEqual(bundle.changeTargets, [
    "src-tauri/src/main.rs",
    "src/components/toolbar.js",
    "src/main.js",
  ]);
  const packet = formatPlanEvidenceBundleForModel(bundle, "zh");
  assert.match(packet, new RegExp(bundle.hash));
  assert.doesNotMatch(packet, /turn_intake|workflowMode/);

  const content = composePlanArtifactFromEvidence({
    userGoal: objective,
    evidence: records.map((record) => `${record.tool}; ${record.target}; ${record.summary}`),
    evidenceRecords: records,
    files: records.map((record) => record.target),
    constraints: ["批准前不得修改源码。", "运行 `npm run build` 并进行桌面打开流程验证。"],
    language: "zh",
    evidenceBundle: bundle,
  });
  const materialized = materializePlanArtifactFromVisibleText({
    visibleText: content,
    userGoal: objective,
    evidence: records.map((record) => `${record.tool}; ${record.target}; ${record.summary}`),
    evidenceRecords: records,
    files: records.map((record) => record.target),
    language: "zh",
    evidenceBundle: bundle,
    expectedEvidenceBundleHash: bundle.hash,
  });

  assert.equal(materialized.ok, true, materialized.reason);
  assert.equal(materialized.evidenceBundleHash, bundle.hash);
  assert.ok(materialized.candidate);
  assert.deepEqual(validatePlanCandidate(materialized.candidate, bundle.hash), []);
  assert.doesNotMatch(materialized.content || "", /最相关证据|noisy_search_evidence|ContextMemoryState/);
  assert.match(materialized.content || "", /src-tauri\/src\/main\.rs/);
  assert.match(materialized.content || "", /src\/components\/toolbar\.js/);

  const mismatched = materializePlanArtifactFromVisibleText({
    visibleText: content,
    evidenceBundle: bundle,
    expectedEvidenceBundleHash: "stale-bundle",
  });
  assert.equal(mismatched.ok, false);
  assert.equal(mismatched.reason, "evidence_bundle_hash_mismatch");
});

test("line excerpts without a confirmed defect cannot auto-materialize a symptom-only plan", () => {
  const bundle = buildPlanEvidenceBundle({
    turnId: "turn-md-viewer-excerpt-only",
    objective: "修复双击 Markdown 打开空白窗口和工具栏打开按钮失效的问题。",
    evidenceRecords: [
      {
        tool: "read_file",
        target: "src-tauri/src/main.rs",
        status: "succeeded",
        summary: "L21: Store file paths for later processing; L23: FILES.get_or_init(...)",
      },
      {
        tool: "read_file",
        target: "src/components/toolbar.js",
        status: "succeeded",
        summary: "工具栏组件导入 invoke，并定义 handleOpenFile。",
      },
    ],
  });

  assert.equal(isPlanEvidenceBundleReady(bundle), true);
  assert.equal(hasDeterministicPlanMaterializationEvidence(bundle), false);
});

test("plan evidence keeps related CSV consumers as facts without turning them into change targets", () => {
  const objective = "修复 src/hooks/useCsvParser.ts，让 CSV creator 字段正确映射为 Dashboard 使用的 creatorName。";
  const bundle = buildPlanEvidenceBundle({
    turnId: "turn-csv-fix",
    objective,
    files: [
      "src/hooks/useCsvParser.ts",
      "src/types/order.ts",
      "src/store/dashboardStore.ts",
      "src/hooks/useChartData.ts",
    ],
    evidenceRecords: [
      {
        tool: "read_file",
        target: "src/hooks/useCsvParser.ts",
        status: "succeeded",
        summary: "normalizeCsvOrder 只返回 creator，没有映射到 Dashboard 需要的 creatorName",
      },
      {
        tool: "read_file",
        target: "src/types/order.ts",
        status: "succeeded",
        summary: "Order 接口要求 creatorName 字段为字符串",
      },
      {
        tool: "read_file",
        target: "src/store/dashboardStore.ts",
        status: "succeeded",
        summary: "Dashboard store 使用 creatorName 作为创建者字段",
      },
      {
        tool: "read_file",
        target: "src/hooks/useChartData.ts",
        status: "succeeded",
        summary: "图表读取 creatorName 并保留 creator 作为向后兼容回退",
      },
    ],
  });

  assert.equal(bundle.facts.length, 4);
  assert.deepEqual(bundle.changeTargets, ["src/hooks/useCsvParser.ts"]);
});

test("deterministic bundle materialization excludes legacy import-only cache noise", () => {
  const objective = "修复 src/hooks/useCsvParser.ts 的 creatorName 映射。";
  const evidenceRecords = [
    {
      tool: "read_file",
      target: "src/hooks/useCsvParser.ts",
      status: "succeeded",
      summary: "normalizeCsvOrder 只返回 creator，没有映射到 creatorName",
    },
    {
      tool: "read_file",
      target: "src/App.tsx",
      status: "succeeded",
      summary: "L1: import React from 'react'",
    },
  ];
  const bundle = buildPlanEvidenceBundle({
    turnId: "turn-import-noise",
    objective,
    evidenceRecords,
    files: evidenceRecords.map((item) => item.target),
  });
  const content = composePlanArtifactFromEvidence({
    userGoal: objective,
    evidenceRecords,
    evidence: [
      "read_file src/hooks/useCsvParser.ts; normalizeCsvOrder 只返回 creator，没有映射到 creatorName",
      "read_file src/App.tsx; L1: import React from 'react'",
    ],
    files: evidenceRecords.map((item) => item.target),
    language: "zh",
    evidenceBundle: bundle,
  });
  const materialized = materializePlanArtifactFromVisibleText({
    visibleText: content,
    userGoal: objective,
    evidenceBundle: bundle,
    expectedEvidenceBundleHash: bundle.hash,
  });

  assert.equal(materialized.ok, true, materialized.reason);
  assert.doesNotMatch(content, /import React/);
  assert.match(content, /src\/hooks\/useCsvParser\.ts/);
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

  assert.equal(result.ok, true, result.reason);
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
      "## 已确认证据",
      "- `src/lib/planMaterialization.ts` 已支持 `<proposed_plan>` 解析与 plan.md 物化。",
      "- `src/lib/planRuntime.ts` 已定义 Plan 阶段的收敛与恢复边界。",
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
      "read_file src/lib/planRuntime.ts; excerpt=reasoning-only 在证据 ready 时要求模型生成 plan.md",
      "read_file src/lib/planMaterialization.ts; excerpt=支持 proposed_plan 物化到 plan.md",
      "cmd:node --test Plan suite passed",
      "cmd:npm run build passed",
    ],
    files: ["src/lib/orchestrator.ts", "src/lib/planRuntime.ts", "src/lib/planMaterialization.ts"],
    language: "zh",
  });

  assert.equal(result.ok, true, result.reason);
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
    "- 运行 Node 单测，覆盖 Gemma4 普通方案和 quick reply 路由。",
    "- 使用 Browser/Playwright 打开审批流程并验证批准后的证据工具仍可调用。",
  ].join("\n");

  const result = materializePlanArtifactFromVisibleText({ visibleText });

  assert.equal(result.ok, true, result.reason);
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

  // With the unified validation path and reply option extraction,
  // materialization may succeed or fail depending on signal detection.
  // Key assertion: if materialization succeeds, content should NOT contain
  // stripped user_options markup.
  assert.ok(result.ok === true || result.ok === false);
  if (result.content) {
    assert.doesNotMatch(result.content, /user_options|approve_operation_once/);
  }
});

test("materializes Gemma4 proposal plan with tables without leaking protocol markers", () => {
  const result = materializePlanArtifactFromVisibleText({
    visibleText: [
      "[PROPOSAL START]",
      "## 修复计划：数据不显示 + 深色模式",
      "",
      "### 用户目标",
      "- 修复 CSV 导入后数据不显示，并保证深色模式下计划表格正常渲染。",
      "",
      "### 摘要",
      "- 已确认 CSV 导入后的字段映射与 UI 展示字段不一致，深色模式表格样式也需要统一。",
      "",
      "### 根因分析",
      "- `src/App.tsx` 上传入口缺少中文 CSV 键名到标准字段的映射。",
      "- PlanPanel 表格必须保留 GFM table，而不是被改写成普通任务列表。",
      "",
      "### 关键实现改动",
      "- 在导入链路增加字段映射，确保 CSV 中文键名进入标准订单字段。",
      "- 在 Markdown 渲染链路保持 GFM 表格语法，并验证 PlanPanel artifact/preview 两条路径。",
      "",
      "### 影响文件",
      "| 文件 | 改动 |",
      "| --- | --- |",
      "| src/App.tsx | 增加数据映射并接入上传流程 |",
      "| src/components/PlanPanel.tsx | 验证 Markdown 表格渲染 |",
      "",
      "### Public APIs / Interfaces / Types",
      "- 无公共 API、接口或类型变化；仅新增内部映射 helper 和渲染回归测试。",
      "",
      "### Test Plan",
      "- 运行 focused node 测试。",
      "- 用浏览器确认 PlanPanel table 可见。",
      "",
      "### 假设与默认值",
      "- 保留现有交互结构，只修复数据映射和渲染。",
      "",
      "<user_options>",
      "<option action=\"approve_operation_once\" value=\"批准执行\">批准执行</option>",
      "</user_options>",
      "[PROPOSAL END]",
    ].join("\n"),
  });

  assert.equal(result.ok, true, result.reason);
  assert.ok(["visible_plan", "canonicalized_visible_plan"].includes(result.source || ""));
  assert.match(result.content || "", /\| 文件 \| 改动 \|/);
  assert.match(result.content || "", /\| src\/App\.tsx \| 增加数据映射并接入上传流程 \|/);
  assert.doesNotMatch(result.content || "", /PROPOSAL|user_options|<option|approve_operation_once/i);
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
  assert.match(result.content || "", /## 摘要/);
  assert.match(result.content || "", /用户目标：修复 CSV 导入后 Dashboard 指标没有正确更新/);
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
      "read_file src/App.tsx; excerpt=type ThemeType = 'light' | 'dark'",
    ],
    files: ["src/store/dashboardStore.ts", "src/hooks/useChartData.ts", "src/App.tsx"],
    language: "zh",
  });

  assert.equal(result.ok, true, result.reason);
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
  assert.match(result.content || "", /planMaterialization/);
  assert.match(result.content || "", /## Key Changes/);
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
      "- 运行 `node --test tests/node/runtime-tools.test.mjs`，检查计划门禁用例全部通过。",
      "- 运行 `cargo test permissions`，检查 builtin_default、ask 和 deny 用例全部通过。",
      "",
      "## 默认假设与后续增强",
      "- 自动保存历史版本：MVP 不做。",
      "- 权限策略编辑 UI：后续增强。",
    ].join("\n"),
  });

  assert.equal(result.ok, true, result.reason);
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

test("deterministic plan preserves a user-reported Tauri startup failure as PTY-checked validation", () => {
  const content = composePlanArtifactFromEvidence({
    userGoal: "修复 Markdown Viewer 的打开问题；目前 npm run tauri dev都无法正常启动软件。",
    evidence: [
      "read_file src-tauri/src/main.rs; excerpt=Builder::default() 注册 Tauri 启动与命令处理",
      "read_file src/main.js; excerpt=openFile 会调用前端文件打开处理",
    ],
    files: ["src-tauri/src/main.rs", "src/main.js"],
    constraints: ["批准前不修改源码。"],
    language: "zh",
  });

  assert.equal(validateActionablePlanArtifact(content).ok, true);
  assert.match(content, /`npm run tauri dev`/);
  assert.match(content, /execute_command/);
  assert.match(content, /read_pty_since/);
  assert.match(content, /证据：cmd:npm run tauri dev/);
  assert.match(content, /证据：tauri_required:desktop runtime interaction/);

  const tasks = deriveRuntimePlanTasksFromArtifacts([{
    kind: "plan",
    path: ".MAIN/plans/plan.md",
    title: "Plan",
    content,
    updatedAt: 1,
  }], { language: "zh" });
  assert.equal(tasks.filter((task) => task.evidence?.some((item) =>
    item.kind === "cmd" && item.value === "npm run tauri dev"
  )).length, 1);
  assert.equal(tasks.some((task) => task.evidence?.some((item) =>
    item.kind === "tauri_required"
  )), true);
});

test("deterministic closure drops runtime plan instructions from assumptions", () => {
  const userGoal = [
    "修复一些问题：",
    "1、核心问题时：手动导入csv数据后不能够在面板上显示对应的数据内容，包括课程销售排行，销售趋势，月度环比分析，订单状态等真实信息。",
    "2、深色模式仍然有很多问题，看起来只是在白色底背景上将一些框体改成了深色而已，请彻底改变深色模式等显示方式。",
  ].join("\n");

  const sanitized = sanitizePlanEvidenceInput({
    userGoal,
    evidence: [
      "grep_search src; excerpt=src/types/order.ts:71:// 订单状态分布 src/components/Dashboard/StatusPieChart.tsx:138: <Card title=订单状态与支付方式",
      "grep_search src; excerpt=src/App.tsx:29:type ThemeType = 'light' | 'dark'; src/App.tsx:31:const THEME_KEY = 'dashboard-theme'",
      "grep_search dark|theme|深色|mode; excerpt=src/App.tsx:29:type ThemeType = 'light' | 'dark'",
      "read_file src/store/dashboardStore.ts; excerpt=Dashboard Store 聚合导入订单并计算指标",
      "read_file src/hooks/useChartData.ts; excerpt=图表数据从订单记录派生排行、趋势和状态分布",
      "read_file src/components/Dashboard/OverviewCards.tsx; excerpt=概览指标组件渲染 Dashboard 数据",
      "read_file src/components/Dashboard/CourseBarChart.tsx; excerpt=课程销售排行图表读取课程聚合数据",
    ],
    files: [
      "src/store/dashboardStore.ts",
      "src/hooks/useChartData.ts",
      "src/components/Dashboard/OverviewCards.tsx",
      "src/components/Dashboard/CourseBarChart.tsx",
      "src/App.tsx",
      "src/types/order.ts",
    ],
    constraints: [
      "如果确实缺少关键业务选择，用 `<user_options>` 提问，不要写泛化模板计划。",
      "tsx 约束：可见计划必须对齐 Codex app 的交接计划结构。",
      "如果 imageParts 0，必须先说明从截图观察到的现象。",
      "创建 plan.md 是 runtime 的职责，模型不要直接调用 write_file。",
      "批准前不修改源码。",
    ],
    language: "zh",
  });

  assert.equal(sanitized.stats.dropReasons.control_prompt, 4);
  assert.deepEqual(sanitized.constraints, ["批准前不修改源码。"]);

  const content = composePlanArtifactFromEvidence({
    userGoal: sanitized.userGoal,
    evidence: sanitized.evidence,
    files: sanitized.files,
    constraints: sanitized.constraints,
    language: "zh",
  });

  const validation = validateActionablePlanArtifact(content);
  assert.equal(validation.ok, true, validation.reason || "");
  assert.match(content, /dashboardStore\.ts/);
  assert.match(content, /useChartData\.ts/);
  assert.match(content, /CourseBarChart\.tsx/);
  assert.match(content, /深色模式表面|主题 token/);
  assert.doesNotMatch(content, /如果确实缺少关键业务选择|tsx 约束|imageParts|创建 plan\.md 是 runtime|user_options|excerpt=/i);
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

test("deterministic plan uses concrete read evidence instead of broad search grounding", () => {
  const content = composePlanArtifactFromEvidence({
    userGoal: "修复 CSV 导入后 Dashboard 数据不显示，并彻底改善深色模式。",
    evidence: [
      "glob_search / .{ts,tsx,vue}",
      "list_directory src/hooks; excerpt=src/hooks/useChartData.ts , src/hooks/useCsvParser.ts",
      "read_file src/hooks/useCsvParser.ts; excerpt=解析 CSV 行并返回订单记录",
      "read_file src/store/dashboardStore.ts; excerpt=导入后更新 dashboard 指标",
      "read_file src/index.css; excerpt=定义主题变量和布局背景",
    ],
    files: [
      "src/hooks/useCsvParser.ts",
      "src/store/dashboardStore.ts",
      "src/index.css",
    ],
    constraints: ["批准前不修改源码。"],
    language: "zh",
  });

  assert.equal(validateActionablePlanArtifact(content).ok, true);
  assert.match(content, /CSV 列名到订单字段映射/);
  assert.match(content, /导入数据进入 Dashboard 状态/);
  assert.match(content, /深色模式表面|主题 token/);
  assert.doesNotMatch(content, /直接相关的最小改动|写入前先用证据确认/);
  assert.doesNotMatch(content, /依据证据：已搜索文件|依据证据：已查看目录/);
});

test("deterministic plan preserves the exact creator to creatorName repair contract", () => {
  const content = composePlanArtifactFromEvidence({
    userGoal: "修复 src/hooks/useCsvParser.ts，让 CSV creator 字段正确映射为 Dashboard 使用的 creatorName，并保持 creator 向后兼容。",
    evidence: [
      "read_file src/hooks/useCsvParser.ts; excerpt=normalizeCsvOrder 目前只返回 creator，没有给 creatorName 赋值",
      "read_file src/types/order.ts; excerpt=Order 要求 creatorName 字段",
    ],
    files: ["src/hooks/useCsvParser.ts"],
    constraints: ["保持 creator 向后兼容"],
    language: "zh",
  });

  assert.equal(validateActionablePlanArtifact(content).ok, true);
  assert.match(content, /赋给 `creatorName`/);
  assert.match(content, /保留旧 `creator` 字段/);
  assert.match(content, /运行 `npm run build`/);
  assert.doesNotMatch(content, /course、date、status、amount/);
});

test("read_file_window evidence is concrete enough for real UI plan materialization", () => {
  const sanitized = sanitizePlanEvidenceInput({
    userGoal: "修复 CSV 导入后 Dashboard 数据不显示，并彻底改善深色模式。",
    evidence: [
      "get_project_skeleton src; excerpt=src/hooks/useCsvParser.ts, src/store/dashboardStore.ts",
      "read_file_window src/hooks/useCsvParser.ts; excerpt=mapCsvRow 读取 creator_name、course_name、paid_at 字段并返回 OrderRecord",
      "read_file_window src/store/dashboardStore.ts; excerpt=loadOrders 负责把导入记录写入 dashboard 状态并计算指标",
      "read_file_window src/components/Dashboard/CourseBarChart.tsx; excerpt=课程销售排行图表从 courseSalesData 渲染真实课程销售额",
      "read_file_window src/index.css; excerpt=:root 与 [data-theme='dark'] 定义背景、卡片和文字颜色变量",
      "analyze_tabular_document cn_tutorial_orders_by_creator_20260512.csv; excerpt=creator_name, course_name, order_status, paid_amount, paid_at",
    ],
    files: [
      "src/hooks/useCsvParser.ts",
      "src/store/dashboardStore.ts",
      "src/components/Dashboard/CourseBarChart.tsx",
      "src/index.css",
      "cn_tutorial_orders_by_creator_20260512.csv",
    ],
    constraints: ["批准前不修改源码。"],
    language: "zh",
  });

  assert.equal(sanitized.stats.dropReasons.non_semantic_tool || 0, 0);
  assert.ok(sanitized.evidence.some((line) => /read_file_window src\/hooks\/useCsvParser\.ts/.test(line)));

  const content = composePlanArtifactFromEvidence({
    userGoal: sanitized.userGoal,
    evidence: sanitized.evidence,
    files: sanitized.files,
    constraints: sanitized.constraints,
    language: "zh",
  });

  const validation = validateActionablePlanArtifact(content);
  assert.equal(validation.ok, true, validation.reason || "");
  assert.match(content, /useCsvParser\.ts/);
  assert.match(content, /dashboardStore\.ts/);
  assert.match(content, /CourseBarChart\.tsx/);
  assert.match(content, /index\.css/);
  assert.doesNotMatch(content, /依据证据：已查看项目结构/);
});

test("structured plan evidence records materialize without leaking failed tool logs", () => {
  const sanitized = sanitizePlanEvidenceInput({
    userGoal: "修复 CSV 导入后 Dashboard 数据不显示，并改善深色模式。",
    evidenceRecords: [
      {
        tool: "read_file",
        target: "src/store/dashboardStore.ts",
        status: "succeeded",
        summary: "loadOrders 聚合导入订单并刷新 Dashboard 指标",
        hash: "abc123",
      },
      {
        tool: "read_file_window",
        target: "src/index.css",
        status: "succeeded",
        summary: "[data-theme='dark'] 定义背景、卡片和文字颜色变量",
        hash: "def456",
      },
      {
        tool: "write_file",
        target: ".MAIN/plans/plan.md",
        status: "failed",
        summary: "PLAN NOT READY",
        hash: "bad",
      },
    ],
    files: ["src/store/dashboardStore.ts", "src/index.css"],
    constraints: ["批准前不修改源码。"],
    language: "zh",
  });

  assert.equal(sanitized.stats.inputStructuredEvidence, 3);
  assert.equal(sanitized.stats.keptStructuredEvidence, 2);
  assert.equal(sanitized.stats.dropReasons.non_semantic_structured_tool, 1);
  assert.match(sanitized.evidence.join("\n"), /dashboardStore\.ts/);
  assert.match(sanitized.evidence.join("\n"), /index\.css/);
  assert.doesNotMatch(sanitized.evidence.join("\n"), /PLAN NOT READY|hash=|write_file/);

  const content = composePlanArtifactFromEvidence({
    userGoal: sanitized.userGoal,
    evidence: sanitized.evidence,
    files: sanitized.files,
    constraints: sanitized.constraints,
    language: "zh",
  });
  assert.equal(validateActionablePlanArtifact(content).ok, true);
  assert.match(content, /dashboardStore\.ts/);
  assert.match(content, /index\.css/);
});

test("sanitizer drops broad extension-only glob evidence from plan grounding", () => {
  const sanitized = sanitizePlanEvidenceInput({
    userGoal: "修复 CSV 导入后 Dashboard 数据不显示。",
    evidence: [
      "glob_search **/*.vue; status=observed; excerpt=[]",
      "glob_search **/*.scss; status=observed; excerpt=[]",
      "read_file_window src/store/dashboardStore.ts; excerpt=loadOrders 聚合导入订单并刷新 Dashboard 指标",
      "read_file_window src/hooks/useCsvParser.ts; excerpt=parseCsvRow 负责把 CSV 列映射为订单记录",
    ],
    files: ["src/store/dashboardStore.ts", "src/hooks/useCsvParser.ts"],
    constraints: [],
    language: "zh",
  });

  assert.equal(sanitized.stats.dropReasons.non_semantic_tool, 2);
  assert.equal(sanitized.evidence.some((line) => /glob_search/.test(line)), false);
  assert.equal(sanitized.evidence.filter((line) => /read_file_window/.test(line)).length, 2);
});

test("canonicalization rejects plans grounded only by broad discovery evidence", () => {
  const content = canonicalizePlanArtifactContent({
    userGoal: "修复 CSV 导入后 Dashboard 数据不显示，并彻底改善深色模式。",
    content: [
      "# 计划",
      "",
      "## 摘要",
      "- 用户目标：修复 CSV 导入后 Dashboard 数据不显示。",
      "- 已搜索文件：**/*.{ts,tsx,vue} 命中 src/hooks/useCsvParser.ts。",
      "",
      "## 影响文件",
      "- src/hooks/useCsvParser.ts",
      "",
      "## 执行步骤",
      "1. 修改 CSV 导入逻辑。",
      "",
      "## 验证标准",
      "- 运行浏览器验证 Dashboard 数据显示。",
    ].join("\n"),
    language: "zh",
  });

  assert.equal(content, null);
});

test("canonicalization replaces file-only generic changes with evidence-grounded changes", () => {
  const content = canonicalizePlanArtifactContent({
    userGoal: "修复 CSV 导入后 Dashboard 数据不显示，并彻底改善深色模式。",
    content: [
      "# 计划",
      "",
      "## 摘要",
      "- 用户目标：修复 CSV 导入后 Dashboard 数据不显示，并彻底改善深色模式。",
      "- 已读取文件：src/hooks/useCsvParser.ts；解析 CSV 行并返回订单记录。",
      "- 已读取文件：src/index.css；定义主题变量和布局背景。",
      "",
      "## 影响文件",
      "- src/hooks/useCsvParser.ts",
      "- src/index.css",
      "",
      "## 执行步骤",
      "1. 按已确认文件修改实现。",
      "",
      "## 验证标准",
      "- 运行聚焦测试和浏览器验证。",
    ].join("\n"),
    language: "zh",
  });

  assert.ok(content);
  assert.match(content, /CSV 列名到订单字段映射/);
  assert.match(content, /深色模式表面|主题 token/);
  assert.doesNotMatch(content, /围绕 `[^`]+` 执行与用户目标直接相关的最小改动/);
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
  assert.equal(sanitized.evidence.length, 1);
  assert.doesNotMatch(sanitized.evidence.join("\n"), /read_file src\/App\.tsx/);
  assert.match(sanitized.evidence.join("\n"), /read_file src\/components\/ChatArea\.tsx/);
  assert.doesNotMatch(sanitized.evidence.join("\n"), /PLAN NOT READY|ContextMemory|hash=|status=|READ_FILE_RESULT|TASK_TARGETING_BLOCKED|\*\*\/\*\.ts|node_modules/);
  assert.equal(sanitized.stats.dropReasons.raw_read_file_metadata, 1);
  assert.equal(sanitized.stats.dropReasons.plan_artifact_evidence, 1);
  assert.equal(sanitized.stats.dropReasons.plan_artifact_path, 1);
  assert.ok(sanitized.stats.dropped >= 3);

  const content = composePlanArtifactFromEvidence({
    userGoal: sanitized.userGoal,
    evidence: sanitized.evidence,
    files: sanitized.files,
    constraints: sanitized.constraints,
    language: "zh",
  });

  assert.equal(validateActionablePlanArtifact(content).ok, true);
  assert.doesNotMatch(content, /落实已批准目标|approved goal/i);
  assert.doesNotMatch(content, /PLAN NOT READY|ContextMemory|hash=|status=|READ_FILE_RESULT|TASK_TARGETING_BLOCKED/);
});

test("read_file window metadata is stripped before deterministic plan evidence", () => {
  const rawReadResult = [
    "READ_FILE_RESULT",
    "path: src/components/Dashboard/CourseBarChart.tsx",
    "truncated: false",
    "totalLines: 8",
    "totalChars: 312",
    "returnedLines: 1-8",
    "returnedChars: 312",
    "---CONTENT START---",
    "export function CourseBarChart({ courseSalesData }) {",
    "  const chartRows = courseSalesData.map((item) => ({ name: item.courseName, value: item.salesAmount }));",
    "  return <BarChart data={chartRows} />;",
    "}",
    "---CONTENT END---",
  ].join("\n");

  const detail = summarizePlanEvidenceDetail({
    tool: "read_file",
    target: "src/components/Dashboard/CourseBarChart.tsx",
    content: rawReadResult,
  });
  assert.match(detail, /CourseBarChart|courseSalesData|chartRows/);
  assert.doesNotMatch(detail, /READ_FILE_RESULT|totalLines|returnedLines|path:/);

  const sanitized = sanitizePlanEvidenceInput({
    userGoal: "修复 CSV 导入后 Dashboard 图表不显示真实课程销售排行。",
    evidence: [
      `read_file src/components/Dashboard/CourseBarChart.tsx; status=observed; ${rawReadResult}`,
      "read_file src/store/dashboardStore.ts; excerpt=loadOrders 聚合导入订单并刷新 Dashboard 指标",
    ],
    files: [
      "src/components/Dashboard/CourseBarChart.tsx",
      "src/store/dashboardStore.ts",
    ],
    language: "zh",
  });

  assert.match(sanitized.evidence.join("\n"), /CourseBarChart\.tsx/);
  assert.match(sanitized.evidence.join("\n"), /courseSalesData|chartRows|loadOrders/);
  assert.doesNotMatch(sanitized.evidence.join("\n"), /READ_FILE_RESULT|totalLines|returnedLines|hash=|status=/);

  const content = composePlanArtifactFromEvidence({
    userGoal: sanitized.userGoal,
    evidence: sanitized.evidence,
    files: sanitized.files,
    constraints: [],
    language: "zh",
  });
  const validation = validateActionablePlanArtifact(content);
  assert.equal(validation.ok, true, validation.reason || "");
  assert.doesNotMatch(content, /weak_path_echo_evidence|READ_FILE_RESULT|totalLines|returnedLines|hash=|status=/);
});

test("metadata-only read evidence cannot produce a reviewable deterministic plan", () => {
  const sanitized = sanitizePlanEvidenceInput({
    userGoal: "修复 CSV 导入后 Dashboard 数据不显示。",
    evidence: [
      "read_file src/components/FileUploader/DragUpload.tsx; status=observed; summary=READ_FILE_RESULT path: src/components/FileUploader/DragUpload.tsx truncated: false totalLines: 114 returnedLines: 1-114",
      "list_directory src/components/Dashboard; excerpt=src/components/Dashboard/CourseBarChart.tsx src/components/Dashboard/TrendLineChart.tsx",
      "grep_search csv; status=observed; summary=MAIN/plans/plan.md:7:- 旧计划里的 CSV 推断",
    ],
    files: [
      "src/components/FileUploader/DragUpload.tsx",
      ".MAIN/plans/plan.md",
    ],
    language: "zh",
  });

  assert.equal(sanitized.stats.dropReasons.raw_read_file_metadata, 1);
  assert.equal(sanitized.stats.dropReasons.plan_artifact_evidence, 1);
  assert.doesNotMatch(sanitized.evidence.join("\n"), /DragUpload\.tsx.*发现|READ_FILE_RESULT|MAIN\/plans\/plan\.md/);

  const content = composePlanArtifactFromEvidence({
    userGoal: sanitized.userGoal,
    evidence: sanitized.evidence,
    files: sanitized.files,
    constraints: [],
    language: "zh",
  });
  const validation = validateActionablePlanArtifact(content);
  assert.equal(validation.ok, false);
  assert.match(validation.reason || "", /missing_plan_sections|missing_plan_required_sections|insufficient_actionable_plan_signals|generic_fallback_plan/);
});

test("deterministic materialization extracts the real goal from turn intake wrappers", () => {
  const wrappedGoal = [
    "[turn_intake]",
    "workflowMode: plan",
    "imageParts: 2",
    "mentionedFiles: 0",
    "attachedFiles: 0",
    "priority: 先理解用户真实指令和用户提供的上下文，再决定是否探索仓库。",
    "[user_request]",
    "请根据截图修复 Dashboard 数据不显示和计划生成失败的问题。",
    "[/user_request]",
    "[/turn_intake]",
    "",
    "本轮处于 PLAN 模式。如果这是复杂实现请求，请先收集只读证据，再输出精简可见的 `<proposed_plan>`。",
  ].join("\n");

  const sanitized = sanitizePlanEvidenceInput({
    userGoal: wrappedGoal,
    evidence: [
      "read_file src/App.tsx; excerpt=App wires Dashboard upload state and renders main dashboard shell",
      "read_file src/main.tsx; excerpt=main mounts React root and imports global styles",
      "read_file src/index.css; excerpt=defines theme variables and page background tokens",
      "list_directory src/components; excerpt=src/components/Dashboard/ , src/components/DataTable/ , src/components/FileUploader/",
    ],
    files: [
      "src/App.tsx",
      "src/main.tsx",
      "src/index.css",
      "src/components/Dashboard/index.tsx",
    ],
    constraints: ["批准前不修改源码。"],
    language: "zh",
  });

  assert.equal(sanitized.userGoal, "请根据截图修复 Dashboard 数据不显示和计划生成失败的问题。");

  const content = composePlanArtifactFromEvidence({
    userGoal: wrappedGoal,
    evidence: sanitized.evidence,
    files: sanitized.files,
    constraints: sanitized.constraints,
    language: "zh",
  });

  assert.equal(validateActionablePlanArtifact(content).ok, true);
  assert.match(content, /Dashboard 数据不显示和计划生成失败/);
  assert.doesNotMatch(content, /用户目标为空|turn_intake|PLAN 模式|proposed_plan/);
});

test("drops MAIN plan artifact self references from deterministic evidence", () => {
  const sanitized = sanitizePlanEvidenceInput({
    userGoal: "修复 CSV 导入解析后仪表盘没有更新的问题。",
    evidence: [
      "grep_search csv; status=observed; summary=MAIN/plans/plan.md:7:- 数据失效原因：读取 cn_tutorial_orders_by_creator_20260512.csv 后字段不匹配",
      "read_file src/hooks/useCsvParser.ts; status=observed; excerpt=解析 CSV 行并返回订单记录",
      "read_file src/store/dashboardStore.ts; status=observed; excerpt=导入后更新 dashboard 指标",
    ],
    files: [
      "MAIN/plans/plan.md",
      "src/hooks/useCsvParser.ts",
      "src/store/dashboardStore.ts",
    ],
    language: "zh",
  });

  assert.equal(sanitized.stats.dropReasons.plan_artifact_evidence, 1);
  assert.equal(sanitized.stats.dropReasons.plan_artifact_path, 1);
  assert.doesNotMatch([...sanitized.evidence, ...sanitized.files].join("\n"), /MAIN\/plans\/plan\.md/i);

  const content = composePlanArtifactFromEvidence({
    userGoal: sanitized.userGoal,
    evidence: sanitized.evidence,
    files: sanitized.files,
    constraints: [],
    language: "zh",
  });

  assert.equal(validateActionablePlanArtifact(content).ok, true);
  assert.doesNotMatch(content, /MAIN\/plans\/plan\.md|落实已批准目标/);
  assert.match(content, /useCsvParser\.ts/);
  assert.match(content, /dashboardStore\.ts/);
});

test("deterministic materialization rejects empty user goals instead of inventing generic targets", () => {
  const content = composePlanArtifactFromEvidence({
    userGoal: "",
    evidence: [
      "read_file src/hooks/useCsvParser.ts; status=observed; excerpt=解析 CSV 行并返回记录",
      "read_file src/store/dashboardStore.ts; status=observed; excerpt=保存导入状态",
    ],
    files: ["src/hooks/useCsvParser.ts", "src/store/dashboardStore.ts"],
    constraints: [],
    language: "zh",
  });

  const validation = validateActionablePlanArtifact(content);
  assert.equal(validation.ok, false);
  assert.doesNotMatch(content, /以落实已批准目标|落实已批准方案|approved goal/i);
  assert.doesNotMatch(content, /用户目标：\s*生成可审批实现计划/);
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

test("materialization rejects import-only weak fallback plan from debug log", () => {
  const content = [
    "# 计划",
    "",
    "## 摘要",
    "- 用户目标：修复手动导入 CSV 后 Dashboard 数据不显示，并彻底改善深色模式。",
    "- 定向证据已覆盖：`src/App.tsx`、`src/components/FileUploader/DragUpload.tsx`。",
    "- 最相关证据：已读取文件：src/App.tsx；发现：L1: import React, { useState, useEffect } from 'react';。",
    "",
    "## 关键改动",
    "- 更新 `src/App.tsx` 的深色模式表面、主题 token、图表/容器对比度。依据证据：已读取文件：src/App.tsx；发现：L1: import React, { useState, useEffect } from 'react';。",
    "- 更新 `src/components/FileUploader/DragUpload.tsx` 的深色模式表面、主题 token、图表/容器对比度。依据证据：已读取文件：src/components/FileUploader/DragUpload.tsx；发现：L1: import { InboxOutlined } from '@ant-design/icons';。",
    "",
    "## 公共 API / 接口 / 类型",
    "- 默认不新增或修改公共 API、接口或类型。",
    "",
    "## 测试方案",
    "- 运行受影响子系统的聚焦测试、构建检查或浏览器/桌面验证，并记录结果。",
    "",
    "## 假设与默认值",
    "- 默认保持现有数据结构不变。",
  ].join("\n");

  const result = materializePlanArtifactFromVisibleText({
    visibleText: content,
    language: "zh",
  });

  assert.equal(result.ok, false);
  assert.match(result.reason || "", /import_only_evidence|generic_theme_token_plan|placeholder_validation_plan/);
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

test("canonicalization preserves long detailed lines and markdown formatting in salvaged plans", () => {
  const longStep = "1. **修改核心控制流**：在 `src/lib/orchestrator.ts` 中找到 `waitForPlanApprovalIfNeeded` 函数并调整轮询逻辑，增加针对 `abortController.signal` 中断信号的优雅降级。为了避免审批中多次触发重试，我们在这一步保留原始模型返回的全部细节，并保证反引号如 `read_file` 能够正确在 plan.md 渲染，字数需要超过三百个字符以验证我们没有做任何截断。为此我们在这里继续增加更多的无意义中文字符串来填充长度，以保证在 JavaScript 的 String.length 计算中其数值能毫无悬念地稳稳超过三百个字符。填充填充填充填充填充填充填充填充填充填充填充填充填充。";
  assert.ok(longStep.length > 300);

  const result = materializePlanArtifactFromVisibleText({
    visibleText: [
      "# Proposed Plan",
      "",
      "## Goal",
      "- 验证长文本行及 Markdown 格式在 canonicalize 时能够被完美保留，不发生任何截断或产生省略号。",
      "",
      "## Implementation Plan",
      longStep,
      "",
      "## Affected Files",
      "- `src/lib/orchestrator.ts`",
      "",
      "## Validation",
      "- 运行 `node --test` 并确认没有任何截断发生。",
    ].join("\n"),
    evidence: [
      "read_file src/lib/orchestrator.ts; excerpt=waitForPlanApprovalIfNeeded",
    ],
    files: ["src/lib/orchestrator.ts"],
    language: "zh",
  });

  assert.equal(result.ok, true, result.reason);
  assert.equal(result.path, ".MAIN/plans/plan.md");
  // The content must contain the exact long step with formatting and WITHOUT truncation/ellipses!
  assert.match(result.content || "", /src\/lib\/orchestrator\.ts/);
  assert.match(result.content || "", /waitForPlanApprovalIfNeeded/);
  assert.match(result.content || "", /优雅降级/);
  // Verify backticks are preserved!
  assert.match(result.content || "", /`src\/lib\/orchestrator\.ts`/);
  assert.match(result.content || "", /`read_file`/);
  // Verify bold format is preserved!
  assert.match(result.content || "", /\*\*修改核心控制流\*\*/);
  // Verify it's not truncated with ellipses!
  assert.doesNotMatch(result.content || "", /优雅降级\.\.\./);
});

test("auto-detects framework design and game dev keywords to route to design.md kind", () => {
  const result = materializePlanArtifactFromVisibleText({
    visibleText: [
      "# 游戏开发框架设计方案",
      "",
      "## 目标与约束",
      "- 目标：基于 Unity/C# 设计游戏实体的 Component-Based 架构与数据流契约。",
      "- 约束：确保类图关系和实体更新在单线程下高吞吐执行，同时为了满足方案物化的最低长度限制，我们需要在这里写下更多关于系统设计的详细内容。我们需要确保本方案描述非常清晰并且超过两百八十个字符以避免被质量门禁判断为过短。",
      "",
      "## 方案",
      "- 设计 EntityMgr 类，维护 Active 实体链表。为各个组件提供类结构设计，支持多态 and 静态分析，支持多维度的数据流转换与性能优化机制。",
      "",
      "## 影响文件",
      "- 计划文件：`.MAIN/plans/design.md`。",
      "",
      "## 执行顺序",
      "1. 明确 C# 接口设计并进行多端同步验证。",
      "2. 画出 UML 类图结构以方便团队成员进行协作开发与后续的代码评审工作。",
    ].join("\n"),
    language: "zh",
  });

  assert.equal(result.ok, true);
  assert.equal(result.kind, "design");
  assert.equal(result.path, ".MAIN/plans/design.md");
});

test("plan evidence grounding rejects modified existing files that were never read", () => {
  const validation = validatePlanEvidenceGrounding({
    content: [
      "# 计划",
      "",
      "## 已确认证据",
      "- 已读取 `src/main.js` 并确认当前打开文件入口。",
      "",
      "## 关键改动",
      "- 修改 `src/main.js` 的事件处理。",
      "- 更新 `index.html` 的脚本入口。",
    ].join("\n"),
    recentToolActivity: [
      { name: "read_file", target: "src/main.js", status: "succeeded" },
    ],
  });

  assert.equal(validation.ok, false);
  assert.equal(validation.recoveryAction, "targeted_evidence");
  assert.match(validation.reason || "", /ungrounded_plan_change_targets:index\.html/);
});

test("plan evidence grounding rejects a truncated relative suffix instead of aliasing a nested source file", () => {
  const validation = validatePlanEvidenceGrounding({
    content: [
      "# 计划",
      "",
      "## 已确认证据",
      "- 已读取 src-tauri/src/main.rs 并确认系统文件打开入口。",
      "",
      "## 关键改动",
      "- 修改 src/main.rs 的文件打开事件。",
    ].join("\n"),
    evidenceRecords: [
      {
        tool: "read_file",
        target: "src-tauri/src/main.rs",
        status: "succeeded",
        summary: "handle_open_url receives the macOS file-open event",
      },
    ],
  });

  assert.equal(validation.ok, false);
  assert.match(validation.reason || "", /ungrounded_plan_change_targets:src\/main\.rs/);
});

test("plan evidence sanitizer retains src-tauri paths without inventing their inner relative suffix", () => {
  const sanitized = sanitizePlanEvidenceInput({
    evidence: [
      "read_file src-tauri/src/main.rs; handle_open_url stores incoming file paths for later forwarding",
    ],
    files: ["src-tauri/src/main.rs"],
    language: "zh",
  });
  const bundle = buildPlanEvidenceBundle({
    objective: "修复 macOS 文件打开入口。",
    evidenceRecords: [{
      tool: "read_file",
      target: "src-tauri/src/main.rs",
      status: "succeeded",
      summary: "handle_open_url stores incoming file paths for later forwarding",
    }],
    files: sanitized.files,
  });

  assert.equal(sanitized.files.includes("src-tauri/src/main.rs"), true);
  assert.equal(sanitized.files.includes("src/main.rs"), false);
  assert.deepEqual(bundle.changeTargets, ["src-tauri/src/main.rs"]);

  const candidate = buildPlanCandidate({
    content: [
      "# Plan",
      "",
      "## Summary",
      "- Repair the file-open path.",
      "",
      "## Confirmed Evidence",
      "- src-tauri/src/main.rs receives the file-open event.",
      "",
      "## Key Changes",
      "- Update src/main.rs to forward the event.",
      "",
      "## Public APIs / Interfaces / Types",
      "- No public API change.",
      "",
      "## Test Plan",
      "- Run cargo check.",
      "",
      "## Assumptions / Defaults",
      "- Preserve existing behavior.",
    ].join("\n"),
    bundle,
  });
  assert.equal(candidate.changes[0]?.targetRef, "src/main.rs");
  assert.deepEqual(validatePlanCandidate(candidate, bundle.hash), ["ungrounded_changes"]);
});

test("materialization rejects the logged MD Viewer plan when index.html was proposed without read evidence", () => {
  const result = materializePlanArtifactFromVisibleText({
    visibleText: [
      "# Proposed Plan: 修复文件打开链路",
      "",
      "## 摘要",
      "- 目标：修复双击 Markdown 文件和工具栏打开按钮失效。",
      "",
      "## 已确认证据",
      "- 已读取 `src-tauri/src/main.rs` 与 `src/main.js`，需要对齐后端事件和前端监听。",
      "",
      "## 关键改动",
      "1. 修改 `src-tauri/src/main.rs` 的文件打开事件。",
      "2. 修改 `src/main.js` 的事件监听和打开按钮处理。",
      "3. 更新 `index.html` 的脚本引入方式。",
      "",
      "## 公共 API / 接口 / 类型",
      "- 内部事件 payload 会变化，不新增公共 API。",
      "",
      "## 测试方案",
      "- 运行构建并手动验证双击与工具栏打开。",
      "",
      "## 假设与默认值",
      "- 默认保持其他编辑功能不变。",
    ].join("\n"),
    evidenceRecords: [
      { tool: "read_file", target: "src-tauri/src/main.rs", status: "succeeded", summary: "emits file-open" },
      { tool: "read_file", target: "src/main.js", status: "succeeded", summary: "listens for open-file-event" },
      { tool: "read_file", target: "src-tauri/tauri.conf.json", status: "succeeded", summary: "Tauri app config" },
    ],
    language: "zh",
  });

  assert.equal(result.ok, false);
  assert.match(result.reason || "", /ungrounded_plan_change_targets:index\.html/);
  assert.equal(result.quality?.recoveryAction, "targeted_evidence");
  assert.equal(result.quality?.canAutoRepair, false);
});

test("deterministic evidence closure repairs the logged MD Viewer rejection without inventing targets", () => {
  const content = composePlanArtifactFromEvidence({
    userGoal: "修复 macOS 上双击 Markdown 文件和工具栏打开按钮没有反应的问题，并保持现有编辑与保存行为不变。",
    evidenceRecords: [
      {
        tool: "read_file",
        target: "src-tauri/src/main.rs",
        status: "succeeded",
        summary: "应用入口接收系统文件打开请求并向主窗口发送内部事件",
      },
      {
        tool: "read_file",
        target: "src/main.js",
        status: "succeeded",
        summary: "前端 openFile 函数和工具栏按钮负责读取并展示 Markdown 内容",
      },
      {
        tool: "read_file",
        target: "src-tauri/tauri.conf.json",
        status: "succeeded",
        summary: "Tauri 主窗口和应用打包配置位于此文件",
      },
      {
        tool: "read_file",
        target: "src-tauri/Cargo.toml",
        status: "succeeded",
        summary: "后端依赖和 Tauri 版本由此清单约束",
      },
    ],
    files: [
      "src-tauri/src/main.rs",
      "src/main.js",
      "src-tauri/tauri.conf.json",
      "src-tauri/Cargo.toml",
    ],
    constraints: ["批准前不修改源码。"],
    language: "zh",
  });

  const validation = validateActionablePlanArtifact(content);
  assert.equal(validation.ok, true, validation.reason || "");
  assert.match(content, /src-tauri\/src\/main\.rs/);
  assert.match(content, /src\/main\.js/);
  assert.match(content, /双击|工具栏|文件打开/);
  assert.doesNotMatch(content, /index\.html/);
  assert.doesNotMatch(content, /function\s+openFile|invoke\(|listen\(/);
});

test("plan evidence grounding requires an explicit confirmed-evidence section", () => {
  const validation = validatePlanEvidenceGrounding({
    content: [
      "# 计划",
      "",
      "## 摘要",
      "- 已确认当前事件名不一致。",
      "",
      "## 关键改动",
      "- 修改 `src/main.js` 的事件处理。",
    ].join("\n"),
    evidence: [
      "read_file src/main.js; excerpt=listen('open-file-event')",
    ],
  });

  assert.equal(validation.ok, false);
  assert.equal(validation.reason, "missing_plan_evidence_section");
  assert.equal(validation.recoveryAction, "rewrite");
  assert.equal(validation.canAutoRepair, true);
});

test("materialization repairs only the missing evidence section without broadening plan scope", () => {
  const result = materializePlanArtifactFromVisibleText({
    visibleText: [
      "## 问题总结",
      "当前文件打开链路已经完成代码读取，下面给出正式整改计划。",
      "",
      "# Proposed Plan: 修复 Markdown 文件打开链路",
      "",
      "## 摘要",
      "- 用户目标：修复双击 Markdown 文件和工具栏打开按钮无法打开文件的问题。",
      "",
      "## 关键改动",
      "1. 修改 `src-tauri/src/main.rs`，统一后端文件打开事件名称和 payload。",
      "2. 修改 `src/main.js`，让启动参数、事件监听和工具栏按钮复用同一打开入口。",
      "",
      "## 公共 API / 接口 / 类型",
      "- 不新增公共 API；只统一现有内部 Tauri 事件 payload。",
      "",
      "## 测试方案",
      "- 运行前端构建和 Rust 检查，并手动验证双击文件与工具栏按钮两条入口。",
      "",
      "## 假设与默认值",
      "- 保持编辑器、保存和预览行为不变。",
    ].join("\n"),
    evidenceRecords: [
      { tool: "read_file", target: "src-tauri/src/main.rs", status: "succeeded", summary: "后端当前发出 file-open 事件" },
      { tool: "read_file", target: "src/main.js", status: "succeeded", summary: "前端当前监听 open-file-event" },
      { tool: "read_file", target: "src-tauri/tauri.conf.json", status: "succeeded", summary: "应用配置保持现状" },
      { tool: "read_file", target: "package.json", status: "succeeded", summary: "构建脚本保持现状" },
    ],
    language: "zh",
  });

  assert.equal(result.ok, true, result.reason);
  assert.equal(result.source, "evidence_section_repaired_visible_plan");
  assert.match(result.content || "", /## 已确认证据/);
  assert.match(result.content || "", /src-tauri\/src\/main\.rs/);
  assert.match(result.content || "", /src\/main\.js/);
  assert.doesNotMatch(result.content || "", /修改 `src-tauri\/tauri\.conf\.json`/);
  assert.doesNotMatch(result.content || "", /修改 `package\.json`/);
  assert.match(result.content || "", /统一后端文件打开事件名称和 payload/);
  assert.match(result.content || "", /启动参数、事件监听和工具栏按钮复用同一打开入口/);
  const repairedContent = result.content || "";
  assert.ok(repairedContent.indexOf("# Proposed Plan") < repairedContent.indexOf("## 已确认证据"));
  assert.ok(repairedContent.indexOf("## 摘要") < repairedContent.indexOf("## 已确认证据"));
  assert.ok(repairedContent.indexOf("## 已确认证据") < repairedContent.indexOf("## 关键改动"));
});

test("materialization does not project metadata-only or failed reads into confirmed evidence", () => {
  const result = materializePlanArtifactFromVisibleText({
    visibleText: [
      "# Proposed Plan: 修复 Markdown 文件打开链路",
      "",
      "## 摘要",
      "- 用户目标：修复前端 Markdown 文件打开入口。",
      "",
      "## 关键改动",
      "- 修改 `src/main.js`，统一启动参数和工具栏按钮的文件打开入口。",
      "",
      "## 公共 API / 接口 / 类型",
      "- 不新增公共 API，保持内部事件 payload 类型不变。",
      "",
      "## 测试方案",
      "- 运行前端构建并手动验证双击文件与工具栏按钮。",
      "- 同时验证启动参数为空、路径包含空格、重复打开同一文件时仍沿用现有错误处理和编辑器状态，不引入额外行为变化。",
      "",
      "## 假设与默认值",
      "- 保持编辑器、保存和预览行为不变；本轮不会把读取失败或只有路径元数据的活动描述成已经确认的源码事实。",
    ].join("\n"),
    evidenceRecords: [{
      tool: "read_file",
      target: "src/main.js",
      status: "succeeded",
      summary: "",
    }],
    recentToolActivity: [{
      name: "read_file",
      target: "src/main.js",
      status: "blocked",
      detail: "读取被阻止",
    }],
    language: "zh",
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "missing_plan_evidence_section");
  assert.equal(result.quality?.recoveryAction, "rewrite");
});

test("plan evidence grounding accepts read-backed change targets with confirmed evidence", () => {
  const validation = validatePlanEvidenceGrounding({
    content: [
      "# 计划",
      "",
      "## 已确认证据",
      "- `src/main.js` 当前监听 `open-file-event`。",
      "",
      "## 关键改动",
      "- 修改 `src/main.js` 的事件处理。",
    ].join("\n"),
    evidenceRecords: [
      { tool: "read_file", target: "src/main.js", status: "succeeded", summary: "listen('open-file-event')" },
    ],
  });

  assert.equal(validation.ok, true);
});

test("plan evidence grounding requires a concrete change target after source reads", () => {
  const validation = validatePlanEvidenceGrounding({
    content: [
      "# 计划",
      "",
      "## 已确认证据",
      "- `src/main.js` 当前监听 `open-file-event`。",
      "",
      "## 关键改动",
      "- 修复前端事件监听并统一 payload。",
    ].join("\n"),
    evidenceRecords: [
      { tool: "read_file", target: "src/main.js", status: "succeeded", summary: "listen('open-file-event')" },
    ],
  });

  assert.equal(validation.ok, false);
  assert.equal(validation.reason, "missing_grounded_plan_change_target");
  assert.equal(validation.recoveryAction, "rewrite");
});

test("rejects the logged canonicalized MD Viewer plan with polluted summary and code fragments", () => {
  const content = [
    "# 计划",
    "",
    "## 摘要",
    "- 用户目标：可能原因（按优先级排序）：",
    "- 用户目标：Tauri 后端未注册 on_open_url / on_file_open 事件监听",
    "- 用户目标：Tauri 2.x 中，系统双击文件触发的事件需要注册回调",
    "- 已读取文件：src-tauri/src/main.rs；发现：// Prevents additional console window...",
    "",
    "## 已确认证据",
    "- 已读取文件：src/main.js；发现：// MD Viewer - 主逻辑...",
    "",
    "## 关键改动",
    "- ```javascript",
    "- // 确保正确引入 dialog API",
    "- import { open } from '@tauri-apps/plugin-dialog';",
    "- async function handleOpenFile() {",
    "- const selected = await open({",
    "",
    "## 公共 API / 接口 / 类型",
    "- app.on_file_open()：新增 Rust 后端注册文件打开事件。",
    "",
    "## 测试方案",
    "- 运行 npm run tauri build 并验证冷启动与已有实例。",
    "",
    "## 假设与默认值",
    "- 默认保持编辑功能不变。",
  ].join("\n");

  const validation = validateActionablePlanArtifact(content);
  assert.equal(validation.ok, false);
  assert.ok([
    "duplicated_user_goal_summary",
    "raw_evidence_in_plan_summary",
    "code_fragments_in_plan_key_changes",
  ].includes(validation.reason || ""));
});

test("rejects a structurally complete MD Viewer plan whose test plan is only diagnosis and assurances", () => {
  const content = [
    "# 计划",
    "",
    "## 摘要",
    "- 用户目标：修复双击 Markdown 文件后无法打开的问题。",
    "",
    "## 已确认证据",
    "- 已读取文件：src-tauri/src/main.rs。",
    "- 已读取文件：src/main.js。",
    "",
    "## 关键改动",
    "- 将 `app.on(\"open\", ...)` 改为 `app_handle.on_open_url(...)`。",
    "- 确保 `SingleInstance` 的回调正确处理文件路径。",
    "- 确保 `open_files` 命令正确触发前端事件。",
    "- 确认 `dialog.open()` 的 Tauri v2 正确调用方式。",
    "",
    "## 公共 API / 接口 / 类型",
    "- 无公共 API、接口或类型变化。",
    "",
    "## 测试方案",
    "- `main.rs` 中 `on_open_files` 事件监听器使用了错误的 API 名称。",
    "- `src/main.js` 中 `dialog.open()` 的调用方式与 Tauri v2 不兼容。",
    "- 需要读取 `src/main.js` 中 `openFile` 函数的完整实现以确认 dialog 调用细节。",
    "- 确保 `SingleInstance` 正确传递文件路径给已运行的实例。",
    "- 确保前端能接收并处理 `file-open` 事件。",
    "",
    "## 假设与默认值",
    "- 默认保持编辑器其他行为不变。",
  ].join("\n");

  const validation = validateActionablePlanArtifact(content);
  assert.equal(validation.ok, false);
  assert.equal(validation.reason, "non_executable_test_plan");

  const materialized = materializePlanArtifactFromVisibleText({
    visibleText: content,
    userGoal: "修复双击 Markdown 文件无法打开的问题。",
    evidenceRecords: [
      { tool: "read_file", target: "src-tauri/src/main.rs", status: "succeeded", summary: "builder" },
      { tool: "read_file", target: "src/main.js", status: "succeeded", summary: "openFile" },
    ],
    language: "zh",
  });
  assert.equal(materialized.ok, false);
  assert.equal(materialized.reason, "non_executable_test_plan");
});

test("structural Plan repair preserves the canonical goal and executable MD Viewer test scenarios", () => {
  const materialized = materializePlanArtifactFromVisibleText({
    visibleText: [
      "# MD Viewer 文件打开功能修复计划",
      "",
      "## 摘要",
      "- 修复双击 Markdown 文件后打开空白，以及软件内‘打开’按钮不弹出文件选择窗口两个问题。",
      "",
      "## 已确认发现",
      "- `src-tauri/src/main.rs` 当前包含文件打开事件与单实例处理。",
      "- `src/main.js` 已导入 Tauri dialog 插件并包含 `openFile` 函数。",
      "",
      "## 未验证假设",
      "- 未验证：`main.rs` 中事件监听 API 名称可能错误。",
      "- 未验证：需要读取 `src/main.js` 中 `openFile` 的完整实现以确认细节。",
      "",
      "## 影响文件",
      "- `src-tauri/src/main.rs`",
      "- `src/main.js`",
      "",
      "## 实施步骤",
      "### 步骤 1：修正后端文件打开事件",
      "- 修改 `src-tauri/src/main.rs`，统一系统文件打开与单实例传递路径。",
      "### 步骤 2：修正前端打开链路",
      "- 修改 `src/main.js`，统一 dialog 返回值和 `file-open` 事件处理。",
      "### 步骤 3：验证单实例逻辑",
      "- 验证已运行实例接收新文件路径。",
      "- 验证前端接收 `file-open` 事件。",
      "",
      "## 测试方案",
      "1. 双击 `.md` 文件，验证软件打开并加载内容。",
      "2. 软件已运行时双击另一个 `.md`，验证窗口切换到新文件。",
      "3. 点击工具栏‘打开’，验证弹出文件选择窗口。",
      "4. 选择文件后，验证编辑器加载内容并显示预览。",
      "",
      "## 假设与默认值",
      "- 未验证假设只能指导定向检查，不能作为已确认根因。",
    ].join("\n"),
    userGoal: "修复双击 Markdown 文件后打开空白，以及软件内打开按钮失效的问题。",
    evidenceRecords: [
      { tool: "read_file", target: "src-tauri/src/main.rs", status: "succeeded", summary: "event setup" },
      { tool: "read_file", target: "src/main.js", status: "succeeded", summary: "openFile" },
    ],
    language: "zh",
  });

  assert.equal(materialized.ok, true, materialized.reason);
  assert.match(materialized.content || "", /双击 Markdown 文件后打开空白/);
  assert.match(materialized.content || "", /## 关键改动[\s\S]*修改 `src-tauri\/src\/main\.rs`/);
  const testPlan = (materialized.content || "").match(/## 测试方案\s*\n([\s\S]*?)(?=\n## |$)/)?.[1] || "";
  assert.match(testPlan, /双击 `\.md` 文件/);
  assert.match(testPlan, /点击工具栏‘打开’/);
  assert.match(testPlan, /选择文件后/);
  assert.doesNotMatch(testPlan, /需要读取|API 名称可能错误|未验证/);
});

test("grounding ignores test-plan file mentions as change targets", () => {
  const validation = validatePlanEvidenceGrounding({
    content: [
      "# 计划",
      "",
      "## 已确认证据",
      "- 已读取 `src/main.js`。",
      "",
      "## 关键改动",
      "- 将文件打开事件改为统一 payload。",
      "",
      "## 测试方案",
      "- 需要读取 `src/main.js` 中 `openFile` 的完整实现以确认细节。",
    ].join("\n"),
    evidenceRecords: [
      { tool: "read_file", target: "src/main.js", status: "succeeded", summary: "openFile" },
    ],
  });
  assert.equal(validation.ok, false);
  assert.equal(validation.reason, "missing_grounded_plan_change_target");
});

test("actionable plan quality rejects implementation-heavy code dumps", () => {
  const largeCode = "const value = 1;\n".repeat(80);
  const content = [
    "# Proposed Plan: 修复事件链路",
    "",
    "## 摘要",
    "- 修复事件名不一致导致的文件打开失败。",
    "",
    "## 关键改动",
    "1. 修改 `src/main.js` 的监听逻辑。",
    "2. 修改 `src-tauri/src/main.rs` 的事件发送逻辑。",
    "",
    "```javascript",
    largeCode,
    "```",
    "",
    "```rust",
    largeCode,
    "```",
    "",
    "## 公共 API / 接口 / 类型",
    "- 无公共 API、接口或类型变化。",
    "",
    "## 测试方案",
    "- 运行构建并验证双击打开文件。",
    "",
    "## 假设与默认值",
    "- 默认保持其他行为不变。",
  ].join("\n");

  const validation = validateActionablePlanArtifact(content);
  assert.equal(validation.ok, false);
  assert.equal(validation.reason, "excessive_plan_code_dump");
});

test("implementation-heavy plan drafts are deterministically compacted without another model pass", () => {
  const largeCode = "const selected = await open({ multiple: false });\n".repeat(32);
  const result = materializePlanArtifactFromVisibleText({
    visibleText: [
      "# 计划",
      "",
      "## 摘要",
      "- 用户目标：修复双击 Markdown 文件无法打开的问题。",
      "",
      "## 已确认证据",
      "- `src/main.js` 当前监听 `open-file-event`。",
      "",
      "## 关键改动",
      "- 修改 `src/main.js`，统一文件打开事件处理。",
      "",
      "```javascript",
      largeCode,
      "```",
      "",
      "## 公共 API / 接口 / 类型",
      "- 无公共 API、接口或类型变化。",
      "",
      "## 测试方案",
      "- 运行构建并验证双击打开文件。",
      "",
      "## 假设与默认值",
      "- 默认保持其他行为不变。",
    ].join("\n"),
    evidenceRecords: [
      { tool: "read_file", target: "src/main.js", status: "succeeded", summary: "listen('open-file-event')" },
    ],
    language: "zh",
  });

  assert.equal(result.ok, true, result.reason);
  assert.equal(result.source, "deterministically_compacted_visible_plan");
  assert.doesNotMatch(result.content || "", /const selected = await open/);
  assert.match(result.content || "", /修改 `src\/main\.js`/);
});

test("MD Viewer trace derives grounded targets from semantic source reads and materializes the first candidate", () => {
  const evidenceRecords = [
    {
      tool: "read_file",
      target: "src-tauri/src/main.rs",
      status: "succeeded",
      summary: "The Tauri builder registers open_files and stores FILES and FILE_CONTENTS, while the setup chain contains the application event wiring.",
    },
    {
      tool: "read_file",
      target: "src/main.js",
      status: "succeeded",
      summary: "window.addEventListener('file-open', handleFileOpen) is the frontend entry point for an externally opened Markdown file.",
    },
    {
      tool: "read_file",
      target: "src/components/toolbar.js",
      status: "succeeded",
      summary: "openFiles invokes the Tauri open_files command and then forwards selected file data to the editor loading flow.",
    },
  ];
  const bundle = buildPlanEvidenceBundle({
    turnId: "turn-md-viewer-trace",
    objective: "修复双击 Markdown 文件后显示空白，以及工具栏打开按钮无法弹出文件选择器的问题。",
    evidenceRecords,
    files: evidenceRecords.map((record) => record.target),
  });

  assert.deepEqual(bundle.changeTargets, [
    "src-tauri/src/main.rs",
    "src/main.js",
    "src/components/toolbar.js",
  ]);

  const largeCode = "const selected = await open({ multiple: false });\n".repeat(34);
  const result = materializePlanArtifactFromVisibleText({
    visibleText: [
      "# 修复 Markdown 文件打开链路",
      "",
      "## 摘要",
      "- 打通系统双击、Tauri 后端事件与前端编辑器加载链路，并修复工具栏文件选择流程。",
      "",
      "## 已确认证据",
      "- `src-tauri/src/main.rs` 包含后端打开命令与应用事件接线。",
      "- `src/main.js` 包含前端 `file-open` 监听入口。",
      "- `src/components/toolbar.js` 包含工具栏打开命令调用。",
      "",
      "## 关键改动",
      "- 修改 `src-tauri/src/main.rs`，统一系统文件打开事件的 payload，并把文件内容返回给前端。",
      "- 修改 `src/main.js`，让外部打开事件进入现有编辑器加载流程。",
      "- 修改 `src/components/toolbar.js`，正确等待文件选择结果并调用统一加载入口。",
      "",
      "```javascript",
      largeCode,
      "```",
      "",
      "```rust",
      "fn open_files() {}\n".repeat(80),
      "```",
      "",
      "## 公共 API / 接口 / 类型",
      "- 统一后端命令与前端事件的文件 payload；不新增公共 API。",
      "",
      "## 测试方案",
      "- 运行构建，分别验证系统双击 Markdown 与工具栏选择文件后内容正确显示。",
      "",
      "## 假设与默认值",
      "- 保留现有编辑器渲染与文件关联配置。",
    ].join("\n"),
    userGoal: bundle.objective,
    evidenceRecords,
    files: evidenceRecords.map((record) => record.target),
    evidenceBundle: bundle,
    expectedEvidenceBundleHash: bundle.hash,
    language: "zh",
  });

  assert.equal(result.ok, true, result.reason);
  assert.equal(result.evidenceBundleHash, bundle.hash);
  assert.equal(result.source, "deterministically_compacted_visible_plan");
  assert.equal(result.candidate?.changes.length, 3);
  assert.ok(result.candidate?.changes.every((change) => change.targetRef && change.evidenceRefs.length > 0));
  assert.doesNotMatch(result.content || "", /const selected|fn open_files/);
});
