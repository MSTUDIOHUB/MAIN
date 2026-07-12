import test from "node:test";
import assert from "node:assert/strict";
import fsSync from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

import ts from "typescript";

const require = createRequire(import.meta.url);
const workspaceRoot = process.cwd();
const transpiledModuleCache = new Map();

function loadTranspiledModuleSync(sourcePath) {
  const normalizedPath = path.resolve(sourcePath);
  if (transpiledModuleCache.has(normalizedPath)) {
    return transpiledModuleCache.get(normalizedPath);
  }

  const source = fsSync.readFileSync(normalizedPath, "utf8");
  const localRequire = createRequire(normalizedPath);
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
    fileName: normalizedPath,
  }).outputText;

  const module = { exports: {} };
  transpiledModuleCache.set(normalizedPath, module.exports);

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
  buildReadOnlyPermissionContinuationPrompt,
  extractReplyOptions,
  hasExecutableProposalReplyOptions,
  hasOnlyInferredReplyOptions,
  hasOnlyNonBlockingPlanReplyOptions,
  hasOnlyPlanContinuationReplyOptions,
  hasOnlyReadOnlyPermissionReplyOptions,
  inferReplyOptionActionFromText,
  resolveCustomReplyOptionAction,
  simplifyOperationProposalReplyOptions,
  serializeAssistantReplyForHistory,
  shouldAutoContinueReadOnlyPermission,
  shouldPauseForReplyOptions,
  shouldRouteUnapprovedPlanReplyOptionsToArtifact,
  shouldSuppressApprovedPlanExecutionReplyOptions,
  stripReadOnlyPermissionPrompt,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/replyOptions.ts"));

test("shouldPauseForReplyOptions pauses when the model asks the user to choose", () => {
  const shouldPause = shouldPauseForReplyOptions({
    replyOptions: [
      { label: "先做数据分析", value: "先做数据分析" },
      { label: "直接开始开发", value: "直接开始开发" },
    ],
    toolCallCount: 0,
    workflowMode: "plan",
    hasStructuredProposal: false,
    hasReadyPlanArtifacts: false,
    isPlanApproved: false,
  });

  assert.equal(shouldPause, true);
});

test("shouldPauseForReplyOptions respects forcePause while keeping legacy edit/runtime guard", () => {
  assert.equal(
    shouldPauseForReplyOptions({
      replyOptions: [{ label: "方案 A", value: "方案 A" }],
      toolCallCount: 1,
      workflowMode: "edit",
    }),
    false,
  );

  assert.equal(
    shouldPauseForReplyOptions({
      replyOptions: [{ label: "方案 A", value: "方案 A" }],
      toolCallCount: 1,
      workflowMode: "edit",
      forcePause: true,
    }),
    true,
  );

  assert.equal(
    shouldPauseForReplyOptions({
      replyOptions: [{ label: "批准执行", value: "批准执行" }],
      toolCallCount: 0,
      workflowMode: "plan",
      hasStructuredProposal: true,
      hasReadyPlanArtifacts: true,
      isPlanApproved: false,
    }),
    false,
  );
});

test("shouldPauseForReplyOptions does not hold chat runs for inferred numbered answers", () => {
  assert.equal(
    shouldPauseForReplyOptions({
      replyOptions: [
        { label: "先了解市场趋势", value: "先了解市场趋势", source: "inferred_enumerated" },
        { label: "再制定交易纪律", value: "再制定交易纪律", source: "inferred_enumerated" },
      ],
      toolCallCount: 0,
      workflowMode: "chat",
      finishReason: "stop",
    }),
    false,
  );

  assert.equal(
    shouldPauseForReplyOptions({
      replyOptions: [
        { label: "继续分析日志", value: "继续分析日志", source: "explicit_user_options" },
        { label: "先到这里", value: "先到这里", source: "explicit_user_options" },
      ],
      toolCallCount: 0,
      workflowMode: "chat",
      finishReason: "stop",
    }),
    true,
  );
});

test("screenshot-like diagnostic and self-directed numbered text never becomes a user choice", () => {
  const extracted = extractReplyOptions([
    "请选择下一步：",
    "1. 引用了 `save_file_content` 命令但未在 Rust 端实现",
    "2. 我来确认是否在 tauri.conf.json 中配置",
  ].join("\n"));

  assert.equal(extracted.hasExplicitUserOptionsTag, false);
  assert.deepEqual(extracted.replyOptions, []);

  // Protect resumed/older turns as well: if a previous inference path already
  // produced these two entries, their coexistence with tool calls must not
  // create a pause that discards the calls.
  const legacyInferredDiagnostics = [
    {
      label: "引用了 save_file_content 命令但未在 Rust 端实现",
      value: "引用了 save_file_content 命令但未在 Rust 端实现",
      action: "execute_once",
      source: "inferred_enumerated",
    },
    {
      label: "我来确认是否在 tauri.conf.json 中配置",
      value: "我来确认是否在 tauri.conf.json 中配置",
      source: "inferred_enumerated",
    },
  ];

  assert.equal(hasOnlyInferredReplyOptions(legacyInferredDiagnostics), true);
  assert.equal(
    shouldPauseForReplyOptions({
      replyOptions: legacyInferredDiagnostics,
      toolCallCount: 2,
      workflowMode: "plan",
      isPlanApproved: true,
      forcePause: true,
      finishReason: "tool_calls",
    }),
    false,
  );
  assert.equal(
    shouldSuppressApprovedPlanExecutionReplyOptions({
      replyOptions: legacyInferredDiagnostics,
      toolCallCount: 2,
      workflowMode: "plan",
      isPlanApproved: true,
      planStage: "executing",
    }),
    true,
  );
});

test("explicit blocking choices remain available without tool calls, including ordinary chat XML", () => {
  const explicitBlocking = extractReplyOptions([
    "需要你决定默认打开行为：",
    "<user_options>",
    "<option>启动时显示空白页</option>",
    "<option>启动时自动恢复上次文件</option>",
    "</user_options>",
  ].join("\n"));

  assert.deepEqual(
    explicitBlocking.replyOptions.map((option) => option.source),
    ["explicit_user_options", "explicit_user_options"],
  );
  assert.equal(
    shouldSuppressApprovedPlanExecutionReplyOptions({
      replyOptions: explicitBlocking.replyOptions,
      toolCallCount: 0,
      workflowMode: "plan",
      isPlanApproved: true,
      planStage: "executing",
    }),
    false,
  );
  assert.equal(
    shouldPauseForReplyOptions({
      replyOptions: explicitBlocking.replyOptions,
      toolCallCount: 0,
      workflowMode: "plan",
      isPlanApproved: true,
      finishReason: "stop",
    }),
    true,
  );

  const ordinaryChatXml = extractReplyOptions([
    "<user_options>",
    "<option>继续执行现有修复</option>",
    "<option>先停止并汇报当前结果</option>",
    "</user_options>",
  ].join("\n"));
  assert.equal(ordinaryChatXml.hasExplicitUserOptionsTag, true);
  assert.equal(
    shouldPauseForReplyOptions({
      replyOptions: ordinaryChatXml.replyOptions,
      toolCallCount: 2,
      workflowMode: "chat",
      finishReason: "tool_calls",
    }),
    true,
  );
});

test("approved plan execution ignores explicit but non-blocking workflow choices", () => {
  const nonBlocking = extractReplyOptions([
    "<user_options>",
    "<option>继续按默认实现</option>",
    "<option>先汇报当前状态</option>",
    "</user_options>",
  ].join("\n"));

  assert.equal(
    shouldPauseForReplyOptions({
      replyOptions: nonBlocking.replyOptions,
      toolCallCount: 0,
      workflowMode: "plan",
      isPlanApproved: true,
      finishReason: "stop",
    }),
    false,
  );
  assert.equal(
    shouldSuppressApprovedPlanExecutionReplyOptions({
      replyOptions: nonBlocking.replyOptions,
      toolCallCount: 0,
      workflowMode: "plan",
      isPlanApproved: true,
      planStage: "executing",
    }),
    true,
  );
});

test("serializeAssistantReplyForHistory keeps the visible question and options together", () => {
  const historyText = serializeAssistantReplyForHistory("请确认下一步方向。", [
    { label: "先做数据分析", value: "先做数据分析" },
    { label: "直接进入软件开发", value: "直接进入软件开发" },
  ]);

  assert.match(historyText, /请确认下一步方向/);
  assert.match(historyText, /User choices:/);
  assert.match(historyText, /1\. 先做数据分析/);
  assert.match(historyText, /2\. 直接进入软件开发/);
});

test("extractReplyOptions infers enumerated markdown choices after a decision cue", () => {
  const result = extractReplyOptions(`
请从下面几种继续方式里选一个：

1. 先做数据清洗
2. 先搭建聚类特征
3. 先只输出分析方案
  `);

  assert.equal(result.replyOptions.length, 3);
  assert.deepEqual(
    result.replyOptions.map((option) => option.value),
    ["先做数据清洗", "先搭建聚类特征", "先只输出分析方案"],
  );
});

test("extractReplyOptions does not infer buttons from analysis comparison lists", () => {
  const result = extractReplyOptions(`
HTML 版本和 Pygame 版本的差异选项如下：

1. High score loaded from \`highscore.json\` file
2. Game over overlay drawn on canvas with text prompt
3. No restart button - uses keyboard input
4. Particle effects rendered on canvas

总结：这些是界面差异，不是需要用户拍板的下一步。
  `);

  assert.equal(result.replyOptions.length, 0);
  assert.match(result.cleanText, /High score loaded/);
});

test("extractReplyOptions rejects diagnostic statements from truncated reasoning as choices", () => {
  const result = extractReplyOptions(`
请选择：

1. 那问题可能出在 Vite 的构建过程中
2. \`App.css\` 被自动引入了
  `);

  assert.equal(result.replyOptions.length, 0);
});

test("shouldPauseForReplyOptions rejects inferred options on length truncation", () => {
  assert.equal(
    shouldPauseForReplyOptions({
      replyOptions: [
        { label: "先做数据分析", value: "先做数据分析", source: "inferred_enumerated" },
        { label: "直接进入软件开发", value: "直接进入软件开发", source: "inferred_enumerated" },
      ],
      toolCallCount: 0,
      workflowMode: "chat",
      finishReason: "length",
    }),
    false,
  );

  assert.equal(
    shouldPauseForReplyOptions({
      replyOptions: [
        { label: "批准进入执行", value: "批准进入执行", source: "explicit_user_options" },
      ],
      toolCallCount: 0,
      workflowMode: "plan",
      finishReason: "length",
    }),
    true,
  );

  assert.equal(
    shouldPauseForReplyOptions({
      replyOptions: [
        { label: "继续读取 useDashboardStore", value: "继续读取 useDashboardStore", action: "continue_readonly_once", source: "readonly_permission" },
        { label: "当前会话只读步骤全部批准", value: "本会话只读读取、搜索和分析步骤全部允许", action: "allow_readonly_session", source: "readonly_permission" },
      ],
      toolCallCount: 0,
      workflowMode: "plan",
      finishReason: "length",
    }),
    false,
  );

  assert.equal(
    shouldPauseForReplyOptions({
      replyOptions: [
        { label: "确认数据是否成功存入 Store", value: "请确认数据是否成功存入 Store", source: "explicit_user_options" },
        { label: "确认数据是否能从 Store 正确读取并完成计算", value: "请确认数据是否能从 Store 正确读取并完成计算", source: "explicit_user_options" },
        { label: "直接尝试分析现有的 CSV 文件格式，看是否与代码中的解析逻辑冲突", value: "直接尝试分析现有的 CSV 文件格式，看是否与代码中的解析逻辑冲突", source: "explicit_user_options" },
      ],
      toolCallCount: 0,
      workflowMode: "plan",
      forcePause: true,
      finishReason: "stop",
    }),
    false,
  );
});

test("extractReplyOptions ignores plan summary bullets after proposal headings", () => {
  const result = extractReplyOptions(`
计划文档已创建完成。

方案总结

需求规格（requirements.md）

- **技术栈**：单文件 HTML + CSS + JavaScript，Canvas 2D 渲染
- **核心玩法**：方向键控制蛇移动，吃食物变长，撞墙/自身则游戏结束
- **交互控制**：方向键移动，空格暂停，回车/按钮重新开始
- **交付物**：\`snake.html\` 单文件

执行计划（plan.md）

1. 架构：单文件包含HTML/CSS/JS，Canvas渲染
2. 游戏循环：\`setInterval\` 每150ms更新
3. 渲染：网格背景、绿色渐变蛇身、红色圆形食物
4. 碰撞检测：墙壁边界 + 自身重叠 + 食物重合
  `);

  assert.equal(result.replyOptions.length, 0);
});

test("extractReplyOptions does not turn plan execution order or risk notes into choices", () => {
  const result = extractReplyOptions(`
# Design

## 执行顺序
1. 固化数据字段和指标口径。
2. 设计查询和聚合步骤。
3. 明确报表输出结构和人工复核点。

## 风险与后续确认
- 风险：列名变化会导致查询条件失效，需要执行阶段增加列名兼容检查。
- 后续确认：执行前由用户选择输出格式；默认先生成 Markdown 报告草稿。
  `);

  assert.equal(result.replyOptions.length, 0);
});

test("extractReplyOptions does not infer choices from review report bullet lists", () => {
  const result = extractReplyOptions(`
请选择你想先查看的审查重点：

1. **碰撞检测在 TargetController 中**：目标控制器已经负责命中判断，当前问题不是缺少按钮选择。
2. **武器粘住后跟随旋转**：这是一条调试发现，不是用户可执行分支。
3. **武器之间无碰撞**：物理层配置看起来已经存在，需要继续验证。
4. **番茄被击中后**：状态更新链路可能仍需要代码审查。
  `);

  assert.equal(result.replyOptions.length, 0);
  assert.match(result.cleanText, /碰撞检测在 TargetController 中/);
});

test("extractReplyOptions filters internal plan artifact creation pseudo choices", () => {
  const explicitPathResult = extractReplyOptions(`
选择下一步：

<user_options>
<option>创建 \`.MAIN/plans/requirements.md\` - 精简的需求规格</option>
<option>创建 \`.MAIN/plans/plan.md\` - 精简的执行计划</option>
</user_options>
  `);

  assert.equal(explicitPathResult.replyOptions.length, 0);

  const bareFileResult = extractReplyOptions(`
选择下一步：

<user_options>
<option>基于方案C更新计划文档（requirements.md + plan.md）</option>
<option>创建 requirements.md</option>
<option>更新 plan.md</option>
<option>生成计划文档</option>
</user_options>
  `);

  assert.equal(bareFileResult.replyOptions.length, 0);

  const explicitSummaryResult = extractReplyOptions(`
选择下一步：

<user_options>
<option>**技术栈**：单文件 HTML + CSS + JavaScript，Canvas 2D 渲染</option>
<option>**核心玩法**：方向键控制蛇移动，吃食物变长</option>
</user_options>
  `);

  assert.equal(explicitSummaryResult.replyOptions.length, 0);

  const inferredMarkdownResult = extractReplyOptions(`
下一步可以：
1. 基于方案C更新计划文档（requirements.md + plan.md）
2. 创建 requirements.md
3. 更新 plan.md
  `);

  assert.equal(inferredMarkdownResult.replyOptions.length, 0);
});

test("extractReplyOptions keeps real plan choices and execution approval", () => {
  const routeResult = extractReplyOptions(`
请选择方案：

<user_options>
<option>方案A：完整框架优先，先搭好全部模块边界</option>
<option>方案B：战斗系统优先，先验证 CTB 核心循环</option>
<option>方案C：最小可运行版本，验证后再扩展</option>
</user_options>
  `);

  assert.deepEqual(
    routeResult.replyOptions.map((option) => option.value),
    [
      "方案A：完整框架优先，先搭好全部模块边界",
      "方案B：战斗系统优先，先验证 CTB 核心循环",
      "方案C：最小可运行版本，验证后再扩展",
    ],
  );

  const approvalResult = extractReplyOptions(`
计划已准备好，请选择下一步：

<user_options>
<option>批准进入执行</option>
<option>继续讨论范围</option>
</user_options>
  `);

  assert.deepEqual(
    approvalResult.replyOptions.map((option) => option.value),
    ["批准进入执行", "继续讨论范围"],
  );
});

test("extractReplyOptions infers binary choices from plain-language clarification prompts", () => {
  const result = extractReplyOptions(`
请您确认以下关键点，以便我能进入下一步的执行阶段：

1. 统一标识符：我们是否可以确定所有四份数据中存在一个可唯一映射的、跨文件的用户ID？
2. RFM 模型构建：我们是否需要基于购买数据来定义 T、F 和 M？

一旦这些基础映射和特征定义敲定，我就可以开始执行数据清洗和特征向量化。请告诉我您对数据ID映射和特征集定义的看法，或者您是否希望我根据我的经验，先假设一个映射关系并开始构建一个初步的特征集进行验证？
  `);

  assert.equal(result.replyOptions.length, 2);
  assert.equal(result.replyOptions[0].value, "我来确认数据ID映射和特征集定义");
  assert.match(result.replyOptions[1].value, /^请根据你的经验/);
});

test("extractReplyOptions avoids malformed buttons from numbered binary question lists", () => {
  const result = extractReplyOptions(`
需要用户拍板的选项：

1. 是否使用现有的事件系统架构，还是改用更简洁的委托方式？
2. 是否需要在UI层使用MVVM模式，还是直接使用事件驱动？
3. 是否需要支持多人联机战斗，还是仅本地单人战斗？
  `);

  assert.equal(result.replyOptions.length, 0);
  assert.match(result.cleanText, /是否使用现有的事件系统架构/);
});

test("extractReplyOptions normalizes single binary choices to user-clickable actions", () => {
  const result = extractReplyOptions(`
你想让我使用现有事件系统，还是改用更简洁的委托方式？
  `);

  assert.deepEqual(
    result.replyOptions.map((option) => option.value),
    ["使用现有事件系统", "改用更简洁的委托方式"],
  );
});

test("extractReplyOptions converts Gemma-style read-only permission prompts into action options", () => {
  const result = extractReplyOptions(`
下一步我建议读取 BaseCombatCommand.cs 来确认命令实现。

请问您是否同意我读取 \`BaseCombatCommand.cs\` 的内容？
  `);

  assert.equal(result.replyOptions.length, 2);
  assert.equal(result.replyOptions[0].action, "continue_readonly_once");
  assert.equal(result.replyOptions[1].action, "allow_readonly_session");
  assert.match(result.replyOptions[0].label, /继续读取 BaseCombatCommand\.cs/);
  assert.match(result.replyOptions[1].value, /本会话只读读取、搜索和分析步骤全部允许/);
});

test("extractReplyOptions marks explicit execution choices for runtime execute", () => {
  const inferred = extractReplyOptions(`
请选择下一步：

1. 直接执行部署脚本 deploy.sh
2. 我来确认无误再执行
  `);

  assert.equal(inferred.replyOptions[0].value, "直接执行部署脚本 deploy.sh");
  assert.equal(inferred.replyOptions[0].action, "execute_once");
  assert.equal(inferred.replyOptions[1].action, undefined);

  const gameStudio = extractReplyOptions(`
我需要确认是否进入执行能力继续。

<user_options>
<option>立即开始重构并完善</option>
<option>先继续讨论方案</option>
</user_options>
  `);

  assert.equal(gameStudio.replyOptions[0].value, "立即开始重构并完善");
  assert.equal(gameStudio.replyOptions[0].action, "execute_once");
  assert.equal(gameStudio.replyOptions[1].action, undefined);

  const explicit = extractReplyOptions(`
请选择下一步：

<user_options>
<option action="execute_once" value="直接执行部署脚本 deploy.sh">直接执行部署脚本 deploy.sh</option>
<option value="我来确认无误再执行">我来确认无误再执行</option>
</user_options>
  `);

  assert.equal(explicit.replyOptions[0].action, "execute_once");
  assert.equal(explicit.replyOptions[1].action, undefined);

  const fixChoice = extractReplyOptions(`
<user_options>
<option>帮我修复这个错误，将第128行改为显式转换</option>
<option>先不改，我想先讨论原因</option>
</user_options>
  `);
  assert.equal(fixChoice.replyOptions[0].action, "execute_once");
  assert.equal(fixChoice.replyOptions[1].action, undefined);
});

test("extractReplyOptions rewrites model-self diagnostic options into user instructions", () => {
  const result = extractReplyOptions(`
我需要确认下一步排查方向。

<user_options>
<option>我来确认数据是否成功存入 Store</option>
<option>我来确认数据是否能从 Store 正确读取并完成计算</option>
<option>直接尝试分析现有的 CSV 文件格式，看是否与代码中的解析逻辑冲突</option>
</user_options>
  `);

  assert.deepEqual(
    result.replyOptions.map((option) => option.label),
    [
      "确认数据是否成功存入 Store",
      "确认数据是否能从 Store 正确读取并完成计算",
      "直接尝试分析现有的 CSV 文件格式，看是否与代码中的解析逻辑冲突",
    ],
  );
  assert.deepEqual(
    result.replyOptions.map((option) => option.value),
    [
      "请确认数据是否成功存入 Store",
      "请确认数据是否能从 Store 正确读取并完成计算",
      "直接尝试分析现有的 CSV 文件格式，看是否与代码中的解析逻辑冲突",
    ],
  );
  assert.equal(hasOnlyPlanContinuationReplyOptions(result.replyOptions), true);

  const deferral = extractReplyOptions(`
<user_options>
<option value="我来确认无误再执行">我来确认无误再执行</option>
</user_options>
  `);

  assert.equal(deferral.replyOptions[0].label, "我来确认无误再执行");
  assert.equal(deferral.replyOptions[0].value, "我来确认无误再执行");
  assert.equal(hasOnlyPlanContinuationReplyOptions(deferral.replyOptions), false);
});

test("extractReplyOptions synthesizes one operation approval for executable proposals", () => {
  const result = extractReplyOptions(`
## 修复方案

我建议修改 \`src/lib/runIntent.ts\`，让普通请求先自然回复，并在需要真实操作时询问用户是否开始执行。

是否开始执行这个修复方案？
  `);

  assert.equal(result.replyOptions.length, 1);
  assert.equal(result.replyOptions[0].label, "批准执行本轮操作");
  assert.equal(result.replyOptions[0].action, "approve_operation_once");
  assert.equal(result.replyOptions[0].source, "proposal_follow_up");
});

test("operation proposal UI options remove generic adjust and cancel controls", () => {
  const simplified = simplifyOperationProposalReplyOptions([
    { label: "批准执行本轮操作", value: "我批准执行。", action: "approve_operation_once", source: "proposal_follow_up" },
    { label: "继续调整方案", value: "继续调整上面的方案，暂不执行真实操作。", action: "adjust_plan", source: "explicit_user_options" },
    { label: "取消操作", value: "取消上面的执行操作，本轮到此为止。", action: "cancel_operation", source: "explicit_user_options" },
    { label: "先生成正式 Plan", value: "先生成可审阅 Plan，再决定是否执行。", action: "adjust_plan", source: "explicit_user_options" },
    { label: "继续调整方案，不进入执行", value: "继续调整方案，不进入执行", source: "explicit_user_options" },
  ]);

  assert.deepEqual(simplified.map((option) => option.label), ["批准执行本轮操作", "先生成正式 Plan"]);
});

test("operation proposal custom feedback routes to adjustment without overriding explicit approval", () => {
  const proposalOptions = [
    { label: "批准执行本轮操作", value: "我批准执行。", action: "approve_operation_once", source: "proposal_follow_up" },
  ];

  assert.equal(resolveCustomReplyOptionAction("请把验证步骤拆得更具体", proposalOptions), "adjust_plan");
  assert.equal(resolveCustomReplyOptionAction("我批准执行本轮操作", proposalOptions), "approve_operation_once");
  assert.equal(resolveCustomReplyOptionAction("补充一个想法", []), undefined);
});

test("ExecutionCapsule keeps execute_once branch labels distinct instead of flattening them", () => {
  const source = fsSync.readFileSync(path.join(workspaceRoot, "src/components/ExecutionCapsule.tsx"), "utf8");
  assert.match(source, /option\.action === "approve_operation_once"/);
  assert.match(source, /option\.action === "execute_once"/);
  assert.match(source, /return option\.label \|\| option\.value \|\|/);
});

test("shouldPauseForReplyOptions pauses for proposal follow-up even on length-safe paths", () => {
  const replyOptions = [
    { label: "批准执行本轮操作", value: "我批准执行。", action: "approve_operation_once", source: "proposal_follow_up" },
    { label: "继续调整方案", value: "请继续调整方案。", action: "adjust_plan", source: "proposal_follow_up" },
  ];

  assert.equal(hasExecutableProposalReplyOptions(replyOptions), true);
  assert.equal(
    shouldPauseForReplyOptions({
      replyOptions,
      toolCallCount: 0,
      workflowMode: "chat",
      finishReason: "stop",
    }),
    true,
  );
  assert.equal(
    shouldPauseForReplyOptions({
      replyOptions,
      toolCallCount: 0,
      workflowMode: "plan",
      hasStructuredProposal: false,
      hasReadyPlanArtifacts: false,
      isPlanApproved: false,
      finishReason: "stop",
    }),
    false,
  );
});

test("shouldRouteUnapprovedPlanReplyOptionsToArtifact suppresses premature implementation branches", () => {
  const visibleText = [
    "我已完成对现有代码库的初步调查。通过分析截图、数据流向及核心逻辑，我发现了导致数据无法显示以及深色模式不彻底的根本原因。",
    "",
    "### 核心问题诊断",
    "- 现象：CSV 已成功加载，但指标和图表为空白。",
    "- 根源分析：状态字段映射和深色模式变量覆盖需要基于证据继续收束。",
    "",
    "# Proposed Plan",
    "### 阶段 1：修复数据链路",
    "### 阶段 2：彻底重构深色模式",
  ].join("\n");
  const replyOptions = [
    { label: "方案 A：优先修复数据问题", value: "方案 A：优先修复数据问题", source: "explicit_user_options" },
    { label: "方案 B：同时进行数据和样式修复", value: "方案 B：同时进行数据和样式修复", source: "explicit_user_options" },
    { label: "方案 C：仅修复深色模式问题", value: "方案 C：仅修复深色模式问题", source: "explicit_user_options" },
  ];

  assert.equal(
    shouldRouteUnapprovedPlanReplyOptionsToArtifact({
      replyOptions,
      workflowMode: "plan",
      isPlanApproved: false,
      hasStructuredProposal: false,
      hasReadyPlanArtifacts: false,
      hasReviewablePlanArtifacts: false,
      sawPlanModeToolActivity: true,
      visibleText,
    }),
    true,
  );

  assert.equal(
    shouldRouteUnapprovedPlanReplyOptionsToArtifact({
      replyOptions,
      workflowMode: "plan",
      isPlanApproved: false,
      hasStructuredProposal: false,
      hasReadyPlanArtifacts: false,
      hasReviewablePlanArtifacts: false,
      sawPlanModeToolActivity: false,
      visibleText,
    }),
    true,
  );
});

test("shouldRouteUnapprovedPlanReplyOptionsToArtifact suppresses duplicate approval for a reviewable plan", () => {
  const replyOptions = [
    { label: "批准执行本轮操作", value: "批准执行", action: "approve_operation_once", source: "proposal_follow_up" },
    { label: "继续调整方案", value: "继续调整", action: "adjust_plan", source: "proposal_follow_up" },
    { label: "取消操作", value: "取消", action: "cancel_operation", source: "operation_approval" },
  ];

  assert.equal(
    shouldRouteUnapprovedPlanReplyOptionsToArtifact({
      replyOptions,
      workflowMode: "plan",
      isPlanApproved: false,
      hasStructuredProposal: true,
      hasReadyPlanArtifacts: false,
      hasReviewablePlanArtifacts: false,
      visibleText: "# Proposed Plan\n\n## Summary\nReviewable plan.",
    }),
    true,
  );
});

test("shouldRouteUnapprovedPlanReplyOptionsToArtifact folds the latest model-self Plan branches back into the artifact", () => {
  const extracted = extractReplyOptions([
    "问题根因确认（8 条要点）：",
    "修复范围明确：只需修改 3 个文件。",
    "请选择下一步：",
    "",
    "<user_options>",
    "<option>我需要先查看 main.js 中是否有 open-file 事件监听器，再决定方案</option>",
    "<option>先修复 main.rs 中的 handle_open_url，再处理前端部分</option>",
    "<option>我需要了解 Tauri 2 dialog 插件的正确导入方式后再执行</option>",
    "</user_options>",
  ].join("\n"));

  assert.deepEqual(
    extracted.replyOptions.map((option) => option.label),
    [
      "我需要先查看 main.js 中是否有 open-file 事件监听器，再决定方案",
      "先修复 main.rs 中的 handle_open_url，再处理前端部分",
      "我需要了解 Tauri 2 dialog 插件的正确导入方式后再执行",
    ],
  );
  assert.equal(
    shouldRouteUnapprovedPlanReplyOptionsToArtifact({
      replyOptions: extracted.replyOptions,
      workflowMode: "plan",
      isPlanApproved: false,
      hasStructuredProposal: true,
      hasReadyPlanArtifacts: false,
      hasReviewablePlanArtifacts: true,
      sawPlanModeToolActivity: true,
      visibleText: extracted.cleanText,
    }),
    true,
  );
});

test("shouldRouteUnapprovedPlanReplyOptionsToArtifact treats combined priority choices as plan content", () => {
  const visibleText = [
    "我已读取关键数据流和主题入口，下面给出实施方案预览。",
    "",
    "### 实施方案预览",
    "- 数据链路：修复 CSV 字段映射、Store 聚合和图表渲染。",
    "- 深色模式：统一主题 token、背景、卡片和图表颜色。",
    "",
    "请选择下一步：",
  ].join("\n");
  const replyOptions = [
    { label: "优先修复数据链路（从解析到 Store 再到组件渲染）", value: "优先修复数据链路（从解析到 Store 再到组件渲染）", source: "explicit_user_options" },
    { label: "优先重构深色模式（从全局样式到组件适配）", value: "优先重构深色模式（从全局样式到组件适配）", source: "explicit_user_options" },
    { label: "两个任务并行推进", value: "两个任务并行推进", source: "explicit_user_options" },
  ];

  assert.equal(
    shouldRouteUnapprovedPlanReplyOptionsToArtifact({
      replyOptions,
      workflowMode: "plan",
      isPlanApproved: false,
      hasStructuredProposal: false,
      hasReadyPlanArtifacts: false,
      hasReviewablePlanArtifacts: false,
      sawPlanModeToolActivity: true,
      visibleText,
    }),
    true,
  );
});

test("shouldRouteUnapprovedPlanReplyOptionsToArtifact keeps genuine blocking plan choices", () => {
  const replyOptions = [
    { label: "方案A：完整框架优先，先搭好全部模块边界", value: "方案A：完整框架优先，先搭好全部模块边界", source: "explicit_user_options" },
    { label: "方案B：战斗系统优先，先验证 CTB 核心循环", value: "方案B：战斗系统优先，先验证 CTB 核心循环", source: "explicit_user_options" },
    { label: "方案C：最小可运行版本，验证后再扩展", value: "方案C：最小可运行版本，验证后再扩展", source: "explicit_user_options" },
  ];

  assert.equal(
    shouldRouteUnapprovedPlanReplyOptionsToArtifact({
      replyOptions,
      workflowMode: "plan",
      isPlanApproved: false,
      sawPlanModeToolActivity: false,
      visibleText: "请选择方案：",
    }),
    false,
  );

  assert.equal(
    shouldRouteUnapprovedPlanReplyOptionsToArtifact({
      replyOptions: [
        { label: "启动时默认显示空白页，由用户手动选择文件", value: "启动时默认显示空白页，由用户手动选择文件", source: "explicit_user_options" },
        { label: "启动时自动恢复上次打开的 Markdown 文件", value: "启动时自动恢复上次打开的 Markdown 文件", source: "explicit_user_options" },
      ],
      workflowMode: "plan",
      isPlanApproved: false,
      hasStructuredProposal: true,
      hasReviewablePlanArtifacts: true,
      sawPlanModeToolActivity: true,
      visibleText: "# Plan\n\n请选择启动时的默认用户体验：显示空白页，还是恢复上次文件？",
    }),
    false,
  );

  assert.equal(
    shouldRouteUnapprovedPlanReplyOptionsToArtifact({
      replyOptions,
      workflowMode: "plan",
      isPlanApproved: false,
      sawPlanModeToolActivity: true,
      visibleText: "真正阻塞问题：必须由用户确认战斗系统范围后才能写 plan.md。请选择方案：",
    }),
    false,
  );

  assert.equal(
    shouldRouteUnapprovedPlanReplyOptionsToArtifact({
      replyOptions,
      workflowMode: "plan",
      isPlanApproved: false,
      hasStructuredProposal: true,
      hasReadyPlanArtifacts: false,
      hasReviewablePlanArtifacts: true,
      sawPlanModeToolActivity: true,
      visibleText: [
        "# Plan",
        "",
        "Blocking decision: the startup UX choice still blocks a decision-complete plan.",
        "The product direction changes user-visible behavior, so I need you to choose before I can finalize the plan.",
      ].join("\n"),
    }),
    false,
  );

  for (const decision of [
    {
      visibleText: "# Plan\n\n请选择默认启动行为：",
      options: ["开启", "关闭"],
    },
    {
      visibleText: "# Plan\n\n请选择技术栈：React 还是 Vue？",
      options: ["React", "Vue"],
    },
  ]) {
    assert.equal(
      shouldRouteUnapprovedPlanReplyOptionsToArtifact({
        replyOptions: decision.options.map((value) => ({ label: value, value, source: "explicit_user_options" })),
        workflowMode: "plan",
        isPlanApproved: false,
        hasStructuredProposal: true,
        hasReviewablePlanArtifacts: true,
        visibleText: decision.visibleText,
      }),
      false,
    );
  }
});

test("shouldPauseForReplyOptions lets unapproved plan tool calls run before proposal approval", () => {
  const replyOptions = [
    {
      label: "批准执行本轮操作",
      value: "我批准按上面的方案开始真实操作，请复用上一轮方案，不要重新规划，直接执行并验证。",
      action: "approve_operation_once",
      source: "proposal_follow_up",
    },
    {
      label: "继续调整方案",
      value: "请继续调整上面的方案，暂不执行真实操作。",
      action: "adjust_plan",
      source: "proposal_follow_up",
    },
    {
      label: "取消操作",
      value: "取消上面的执行操作，本轮到此为止。",
      action: "cancel_operation",
      source: "operation_approval",
    },
  ];

  assert.equal(
    shouldPauseForReplyOptions({
      replyOptions,
      toolCallCount: 1,
      workflowMode: "plan",
      hasStructuredProposal: false,
      hasReadyPlanArtifacts: false,
      isPlanApproved: false,
      finishReason: "tool_calls",
    }),
    false,
  );
});

test("approved plan execution suppresses stale approval options while tool calls continue", () => {
  const replyOptions = [
    {
      label: "批准执行本轮操作",
      value: "我批准按上面的方案开始真实操作，请复用上一轮方案，不要重新规划，直接执行并验证。",
      action: "approve_operation_once",
      source: "proposal_follow_up",
    },
    {
      label: "继续调整方案",
      value: "请继续调整上面的方案，暂不执行真实操作。",
      action: "adjust_plan",
      source: "proposal_follow_up",
    },
    {
      label: "取消操作",
      value: "取消上面的执行操作，本轮到此为止。",
      action: "cancel_operation",
      source: "operation_approval",
    },
  ];

  assert.equal(
    shouldSuppressApprovedPlanExecutionReplyOptions({
      replyOptions,
      workflowMode: "plan",
      isPlanApproved: true,
      planStage: "executing",
    }),
    true,
  );

  assert.equal(
    shouldPauseForReplyOptions({
      replyOptions: [],
      toolCallCount: 6,
      workflowMode: "plan",
      hasStructuredProposal: false,
      hasReadyPlanArtifacts: false,
      isPlanApproved: true,
      finishReason: "tool_calls",
    }),
    false,
  );
});

test("extractReplyOptions converts execution mode switch options into user-facing execution choices", () => {
  const result = extractReplyOptions(`
请选择下一步：

<user_options>
<option>切换到执行模式</option>
<option>我要调用工具 read_file</option>
<option>直接执行部署脚本 deploy.sh</option>
<option>停止执行，仅查看当前进度</option>
</user_options>
  `);

  assert.deepEqual(
    result.replyOptions.map((option) => option.value),
    ["开始执行", "直接执行部署脚本 deploy.sh", "停止执行，仅查看当前进度"],
  );
  assert.equal(result.replyOptions[0].action, "execute_once");
  assert.equal(result.replyOptions[1].action, "execute_once");
  assert.equal(result.replyOptions[2].action, undefined);
  assert.equal(inferReplyOptionActionFromText("执行修复"), "execute_once");
  assert.equal(inferReplyOptionActionFromText("停止执行，仅查看当前进度"), undefined);
});

test("non-blocking plan exploration choices do not pause Plan mode", () => {
  const result = extractReplyOptions(`
为了更高效地开始，我需要先确认您的项目技术栈或已知的关键模块。

<user_options>
<option>直接开始探索（我会先从搜索 CSV 导入逻辑开始）</option>
<option>提供一些关键文件路径/组件名（如果您已知的话）</option>
</user_options>
  `);

  assert.equal(hasOnlyNonBlockingPlanReplyOptions(result.replyOptions), true);
  assert.equal(
    shouldPauseForReplyOptions({
      replyOptions: result.replyOptions,
      toolCallCount: 0,
      workflowMode: "plan",
      hasStructuredProposal: false,
      hasReadyPlanArtifacts: false,
      isPlanApproved: false,
      forcePause: true,
      finishReason: "stop",
    }),
    false,
  );
});

test("read-only auto approval strips repeated permission prompts and builds continuation", () => {
  const result = extractReplyOptions("请问是否同意我下一步分析 `CombatUnit.cs` 的内容？");

  assert.equal(
    shouldAutoContinueReadOnlyPermission({
      replyOptions: result.replyOptions,
      readOnlyAutoApproveForSession: true,
    }),
    true,
  );
  assert.equal(
    shouldAutoContinueReadOnlyPermission({
      replyOptions: result.replyOptions,
      readOnlyAutoApproveForSession: false,
    }),
    false,
  );
  assert.equal(
    stripReadOnlyPermissionPrompt("我已经完成上一段分析。\n\n请问是否同意我下一步分析 `CombatUnit.cs` 的内容？"),
    "我已经完成上一段分析。",
  );
  assert.match(buildReadOnlyPermissionContinuationPrompt("zh"), /不要再询问是否同意/);
  assert.match(buildReadOnlyPermissionContinuationPrompt("zh"), /read_file/);
});

test("read-only permission option classifier only matches synthetic permission choices", () => {
  assert.equal(
    hasOnlyReadOnlyPermissionReplyOptions([
      { label: "继续分析 Dashboard", value: "请继续分析 Dashboard。", action: "continue_readonly_once" },
      { label: "当前会话只读步骤全部批准", value: "本会话只读读取、搜索和分析步骤全部允许。", action: "allow_readonly_session" },
    ]),
    true,
  );

  assert.equal(
    hasOnlyReadOnlyPermissionReplyOptions([
      { label: "继续分析 Dashboard", value: "请继续分析 Dashboard。", action: "continue_readonly_once" },
      { label: "改用更简洁方案", value: "改用更简洁方案" },
    ]),
    false,
  );
});

test("extractReplyOptions infers natural language questions from local models like Gemma 4 under a cue", () => {
  const result = extractReplyOptions(`
请问您希望图表上的“销售额”应该基于哪个字段的最终支付金额？是：

1. "支付金额(¥)" 字段（这是订单的最终支付金额）？
2. 还是需要基于（"价格(¥)" - "优惠价(¥)"）的差值来计算？
3. 对于状态为 "closed" 的订单，是否应该将其计入当期销售额？
  `);

  assert.equal(result.replyOptions.length, 3);
  assert.equal(result.replyOptions[0].value, '"支付金额(¥)" 字段（这是订单的最终支付金额）');
  assert.equal(result.replyOptions[1].value, '还是需要基于（"价格(¥)" - "优惠价(¥)"）的差值来计算');
  assert.equal(result.replyOptions[2].value, '对于状态为 "closed" 的订单，是否应该将其计入当期销售额');
});

test("extractReplyOptions rejects open-ended binary questions as choices", () => {
  const result1 = extractReplyOptions(`
您希望我们从哪个字段开始讨论噪音词语，还是您想进行下一步操作呢？
  `);
  assert.equal(result1.replyOptions.length, 0);

  const result2 = extractReplyOptions(`
请问我们需要我读取哪个目录，还是您有其他需要我做的工作？
  `);
  assert.equal(result2.replyOptions.length, 0);
});

test("convertAssistantClauseToUserChoice converts Gemma pronouns and preserves first person actions", () => {
  const result = extractReplyOptions(`
请选择下一步：

1. 我要分析销售额数据
2. 直接执行部署脚本 deploy.sh
  `);

  assert.equal(result.replyOptions.length, 2);
  assert.equal(result.replyOptions[0].value, "我要分析销售额数据");
  assert.equal(result.replyOptions[1].value, "直接执行部署脚本 deploy.sh");
});

test("shouldPauseForReplyOptions rejects inferred proposal options on length truncation", () => {
  const replyOptions = [
    { label: "批准执行本轮操作", value: "我批准执行。", action: "approve_operation_once", source: "proposal_follow_up" },
    { label: "继续调整方案", value: "请继续调整方案。", action: "adjust_plan", source: "proposal_follow_up" },
  ];
  assert.equal(
    shouldPauseForReplyOptions({
      replyOptions,
      toolCallCount: 0,
      workflowMode: "edit",
      finishReason: "length",
    }),
    false,
  );
});
