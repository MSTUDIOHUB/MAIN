import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";

const cache = new Map();
function load(file) {
  const resolved = path.resolve(file);
  if (cache.has(resolved)) return cache.get(resolved);
  const module = { exports: {} };
  cache.set(resolved, module.exports);
  const localRequire = createRequire(resolved);
  const requireModule = (name) => {
    if (name.startsWith(".")) {
      const base = path.resolve(path.dirname(resolved), name);
      for (const candidate of [`${base}.ts`, path.join(base, "index.ts")]) {
        if (fs.existsSync(candidate)) return load(candidate);
      }
    }
    return localRequire(name);
  };
  new Function("exports", "module", "require", ts.transpileModule(fs.readFileSync(resolved, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }, fileName: resolved,
  }).outputText)(module.exports, module, requireModule);
  cache.set(resolved, module.exports);
  return module.exports;
}

const { resolveAndApplySubmitIntentRouting } = load("src/store/submitIntentRouting.ts");
const { resolveTurnRunIntent, getIntentPolicy, buildEffectiveTurnContract } = load("src/lib/runIntent.ts");
const { resolveSubmitRuntimeDecision, resolveSubmitPreflightEffectAction } = load("src/lib/submit/turnSubmission.ts");

function route(text, autoApproveTools = false) {
  const effects = [];
  const input = {
    text, preferredLanguage: "en", options: {}, currentMainModeKey: "main_mode", hasWorkspace: true,
    isHidden: false, autoApproveTools, fallbackRunIntent: "respond", mainDebugShortcut: null,
    mainIntentShortcut: null, lockedComposerIntent: null, currentTurn: null, currentTurnIntent: "respond",
    hasPlanArtifacts: false, shouldContinuePlanIntent: false, shouldContinuePreviousTurnIntent: false,
    previousTurnContinuationTarget: null, previousTurnContinuationIntent: null, shouldReuseExistingTurnIntent: false,
    shouldExecuteOnceFromReplyOption: false, shouldRouteContinuationToPlanResume: false,
    planExecutionResumeContinuationTarget: null, planStage: "idle", isPlanApproved: false,
    currentTurnId: null, dismissedPendingDecisionInputKey: null, currentConfig: {}, sendOriginSessionKey: "/tmp/discussion:1",
    setState: () => {}, applyPreRunSessionPatch: () => {}, approvePlan: () => {}, startPlanExecutionResume: () => {},
    startBlockingPreflight: (effect) => effects.push(effect), logStoreEvent: () => {},
  };
  const result = resolveAndApplySubmitIntentRouting(input);
  if (!result.handled || effects.length === 0) return result;
  // A natural output-style hint may now receive a semantic check. A typed
  // read-only result must retain the same conversational authority afterward.
  assert.equal(effects.length, 1);
  const action = resolveSubmitPreflightEffectAction({
    effect: effects[0], preflight: { intent: effects[0].resolution.intent, confidence: 0.98 },
    latestInput: text, latestMainModeKey: "main_mode", isOriginSessionActive: true, isOriginOwnerCurrent: true,
  });
  assert.equal(action.kind, "resume");
  return resolveAndApplySubmitIntentRouting({ ...input, options: action.options });
}

const discussions = [
  ["original design discussion", "我打算用unity开发一款游戏，我有一些想法请帮我一起完善游戏设计的部分，请跟我一起讨论并给我提出一些建议并记录我的选择，最后我们会生成一份游戏开发文档。"],
  ["English design discussion", "I plan to develop a game in Unity. Help me refine its design, discuss my ideas, suggest options and record my choices. Later we will create a development document."],
  ["project scope design discussion", "请帮我完善项目设计，跟我讨论并记录我的选择，以后再生成一份开发文档。"],
  ["English project scope design discussion", "Improve the project design with me, discuss options and record my choices; later we will generate a development document."],
  ["workspace scope design discussion", "请帮我完善工作区设计，跟我讨论并记录我的选择，以后再生成一份开发文档。"],
  ["English repository scope design discussion", "Please update the repository design with me, discuss options and record my choices; later we will generate a development document."],
  ["future named artifact after Chinese discussion", "请帮我完善项目设计，跟我讨论并记录我的选择，以后再生成 README.md。"],
  ["future named artifact after English discussion", "Please improve the project design with me and discuss options; later we will write README.md."],
  ["future named artifact cannot authorize an earlier update", "Please update the project design with me and discuss options; later we will write README.md."],
  ["coordinated future named artifact", "Please update the project design with me and discuss options and later we will write docs/design.v1.md."],
  ["Chinese coordinated discussion before a future path", "请完善项目设计并讨论选项，以后再生成 docs/design.v1.md。"],
  ["other creative topic", "我想创作一部小说，请一起完善人物设计并讨论选项，记录我的选择，最后我们会生成一份创作说明文档。"],
  ["English other creative topic", "Help me develop a podcast concept, discuss the format and keep track of my choices. Later we will create a production document."],
  ["selection", "先确定 PC、单人和俯视角。节奏上暂时选每天必须完成送货指标，给玩家一点压力。战斗和收费方式先不确定。请记录我的选择，并帮我看看这些选择有什么取舍。"],
  ["changed selection", "我改主意了，取消每日必须达标，改成自由安排送货，不完成也没有惩罚。平台和视角保持之前的决定。这样核心循环应该怎么调整？请更新记录。"],
  ["English changed selection", "Please update our decisions: change the daily quota to free scheduling with no penalty. Keep the platform and camera choices. What does this mean for the core loop?"],
  ["recap", "先别写文档，请回顾我们已经确认的决定、改过的决定，以及还没有决定的部分。不要替我补齐空白。"],
  ["English recap", "Review the confirmed decisions, withdrawn decisions and open questions. Do not fill in choices I have not made."],
  ["chat document", "现在请根据刚才的讨论生成第一版游戏开发文档，直接在聊天中给出 Markdown 正文。明确区分已确认设计和待定问题，把修改后的决定作为当前版本。不要写代码或创建 Unity 工程。"],
  ["English chat document", "Now write the first development document directly in this chat as Markdown. Separate confirmed decisions from open questions and use our revised choices."],
];

for (const [name, text] of discussions) {
  test(`${name} admits a read-only answer with either approval setting`, () => {
    const natural = resolveTurnRunIntent(text, { language: "en", mainModeKey: "main_mode", hasWorkspace: true, hasPlanArtifacts: false, planStage: "idle", isPlanApproved: false });
    assert.equal(getIntentPolicy(natural.intent).toolPolicy, "read_only", "natural admission must preserve the current conversational action");
    const withoutApproval = route(text);
    const withApproval = route(text, true);
    assert.equal(withoutApproval.handled, false);
    assert.equal(withApproval.handled, false);
    assert.equal(getIntentPolicy(withoutApproval.effectiveRunIntent).toolPolicy, "read_only");
    assert.equal(withApproval.effectiveRunIntent, withoutApproval.effectiveRunIntent);
    assert.deepEqual(withApproval.effectiveCommandDirective, withoutApproval.effectiveCommandDirective);
    for (const routing of [withoutApproval, withApproval]) {
      const contract = buildEffectiveTurnContract({ conversationIntent: routing.effectiveRunIntent, commandDirective: routing.effectiveCommandDirective });
      assert.equal(contract.completionEvidenceRequired, "answer");
      assert.equal(contract.mutationExpected, false);
      assert.equal(contract.validationExpected, false);
      assert.equal(contract.operationApprovalState, "not_required");
    }
  });
}

for (const text of [
  "Write our confirmed decisions to docs/design.md in the workspace.",
  "把讨论结果写入项目的 docs/design.md 文件。",
  "Find the cause of the login bug in src/login.ts, fix it and run the tests.",
  "检查 src/login.ts 的错误并修复，运行测试验证。",
  "请完善 SnakeController 的输入处理，并运行测试。",
  "请添加设置按钮，并运行测试。",
  "Please update the LoginPanel component and run tests.",
  "Run C# in the Unity Editor to create a sphere in the current scene.",
  "在 Unity 编辑器中执行 C# 命令，创建一个球体。",
  "请直接修改 README.md，在文件末尾另起一行添加 Design validation complete.，保留原有内容。然后运行 node -e \"const fs = require('node:fs'); const assert = require('node:assert/strict'); assert.ok(fs.readFileSync('README.md', 'utf8').includes('Design validation complete.'))\" 验证结果。不要生成计划。完成后说明修改与验证结果。",
  "Please modify README.md by appending Design validation complete. Keep its existing content. Then run node -e to assert that README.md includes the added line and verify the result. Do not generate a plan. Report the change and validation.",
  "请修改 README.md 后给设计建议",
  "Please modify README.md, then report the changes.",
  "请修改 C:\\game\\src\\Main.cs 后给设计建议。",
  "请分析 src/login.ts 的问题后修复，并报告验证结果。",
  "Analyze the issue in src/login.ts, fix it and report the changes.",
  "请先讨论选项，然后修改 docs/design.v1.md。",
  "Discuss the options, then update docs/design.v1.md.",
  "请先分析问题，再修复 src/main.ts 并说明结果。",
  "再生成 docs/design.v1.md。",
  "Please add a black and white button to the component.",
  "请修改并行处理功能并运行测试。",
]) {
  test(`explicit operation retains Execute and approval independence: ${text}`, () => {
    for (const enabled of [false, true]) {
      const result = route(text, enabled);
      assert.equal(result.handled, false);
      assert.equal(result.effectiveRunIntent, "execute");
      const contract = buildEffectiveTurnContract({ conversationIntent: result.effectiveRunIntent, commandDirective: result.effectiveCommandDirective });
      assert.equal(contract.completionEvidenceRequired, "execution_evidence");
    }
  });
}

test("explicit Plan remains Plan independently of approval preferences", () => {
  for (const enabled of [false, true]) {
    assert.equal(route("Give me a plan first, then implement the new feature.", enabled).effectiveRunIntent, "plan");
  }
});

test("auto-approval only changes action consent after an intent is admitted", () => {
  const decide = (autoApproveTools) => resolveSubmitRuntimeDecision({
    effectiveRunIntent: "respond", currentMainModeKey: "main_mode", isPlanApproved: false,
    autoApproveTools, shouldExecuteOnceFromReplyOption: false, preservePlanState: false,
  });
  const manual = decide(false);
  const automatic = decide(true);
  assert.equal(manual.runtimeRunIntent, "respond");
  assert.equal(automatic.runtimeRunIntent, "respond");
  assert.equal(manual.shouldGrantExecutionConsentForTurn, false);
  assert.equal(automatic.shouldGrantExecutionConsentForTurn, true);
});

for (const text of [
  "检查 README.md，不要修改文件，不要写代码。",
  "Inspect README.md. Do not modify files or write code.",
  "检查 README.md，不要生成计划，也不要修改代码。",
  "Inspect README.md. Do not generate a plan or modify code.",
  "检查当前代码，不要创建 plan.md 文件。",
  "Inspect the current code. Do not create plan.md.",
]) {
  test(`scoped planning constraints retain actual write prohibitions: ${text}`, () => {
    const result = route(text);
    assert.equal(result.handled, false);
    assert.equal(getIntentPolicy(result.effectiveRunIntent).toolPolicy, "read_only");
    const contract = buildEffectiveTurnContract({ conversationIntent: result.effectiveRunIntent, commandDirective: result.effectiveCommandDirective });
    assert.equal(contract.mutationExpected, false);
    assert.equal(contract.completionEvidenceRequired, "answer");
  });
}
