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
  hasOnlyReadOnlyPermissionReplyOptions,
  inferReplyOptionActionFromText,
  serializeAssistantReplyForHistory,
  shouldAutoContinueReadOnlyPermission,
  shouldPauseForReplyOptions,
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

设计方案（design.md）

1. 架构：单文件包含HTML/CSS/JS，Canvas渲染
2. 游戏循环：\`setInterval\` 每150ms更新
3. 渲染：网格背景、绿色渐变蛇身、红色圆形食物
4. 碰撞检测：墙壁边界 + 自身重叠 + 食物重合
  `);

  assert.equal(result.replyOptions.length, 0);
});

test("extractReplyOptions filters internal plan artifact creation pseudo choices", () => {
  const explicitPathResult = extractReplyOptions(`
选择下一步：

<user_options>
<option>创建 \`.MAIN/plans/requirements.md\` - 精简的需求规格</option>
<option>创建 \`.MAIN/plans/design.md\` - 精简的设计方案</option>
</user_options>
  `);

  assert.equal(explicitPathResult.replyOptions.length, 0);

  const bareFileResult = extractReplyOptions(`
选择下一步：

<user_options>
<option>基于方案C更新计划文档（requirements.md + design.md）</option>
<option>创建 requirements.md</option>
<option>更新 design.md</option>
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
1. 基于方案C更新计划文档（requirements.md + design.md）
2. 创建 requirements.md
3. 更新 design.md
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

test("extractReplyOptions synthesizes operation approval for executable proposals", () => {
  const result = extractReplyOptions(`
## 修复方案

我建议修改 \`src/lib/runIntent.ts\`，让普通请求先自然回复，并在需要真实操作时询问用户是否开始执行。

是否开始执行这个修复方案？
  `);

  assert.equal(result.replyOptions.length, 3);
  assert.equal(result.replyOptions[0].label, "批准执行本轮操作");
  assert.equal(result.replyOptions[0].action, "approve_operation_once");
  assert.equal(result.replyOptions[0].source, "proposal_follow_up");
  assert.equal(result.replyOptions[1].action, "adjust_plan");
  assert.equal(result.replyOptions[2].action, "cancel_operation");
});

test("shouldPauseForReplyOptions pauses for proposal follow-up even on length-safe paths", () => {
  assert.equal(
    shouldPauseForReplyOptions({
      replyOptions: [
        { label: "批准执行本轮操作", value: "我批准执行。", action: "approve_operation_once", source: "proposal_follow_up" },
        { label: "继续调整方案", value: "请继续调整方案。", action: "adjust_plan", source: "proposal_follow_up" },
      ],
      toolCallCount: 0,
      workflowMode: "chat",
      finishReason: "stop",
    }),
    true,
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
