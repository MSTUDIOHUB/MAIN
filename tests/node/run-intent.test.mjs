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
  getMainIntentShortcuts,
  getIntentPolicy,
  inferCommandDirective,
  looksLikePreviousTurnContinuationInput,
  looksLikeExistingPlanExecutionRequest,
  mapResolvedRunIntentToWorkflowMode,
  parseMainDebugShortcut,
  parseMainIntentShortcut,
  resolveComposerIntentSuggestion,
  resolveTurnRunIntent,
  shouldContinuePreviousTurnFromInput,
  shouldUseBlockingIntentPreflight,
} = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/lib/runIntent.ts"),
);

const {
  MAIN_MODE_KEYS,
  mapLegacyNexusModeToMainMode,
} = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/lib/mainModes.ts"),
);

function createContext(overrides = {}) {
  return {
    language: "zh",
    mainModeKey: "main_mode",
    parsedStudioCommand: null,
    hasPlanArtifacts: false,
    planStage: "idle",
    isPlanApproved: false,
    ...overrides,
  };
}

test("MAIN mode keys exclude legacy Task Center and migrate old value", () => {
  assert.deepEqual([...MAIN_MODE_KEYS], ["main_mode", "game_studio"]);
  assert.equal(mapLegacyNexusModeToMainMode("task_center"), "main_mode");
});

test("explicit Chinese planning request resolves to plan", () => {
  const result = resolveTurnRunIntent("先给我一个方案再实现", createContext());
  assert.equal(result.intent, "plan");
  assert.equal(result.needsDecision, undefined);
});

test("explicit English implementation request resolves to execute", () => {
  const result = resolveTurnRunIntent("Please implement it directly and fix the bug", createContext());
  assert.equal(result.intent, "execute");
  assert.equal(result.needsDecision, undefined);
});

test("Chinese design based implementation request resolves to execute", () => {
  const result = resolveTurnRunIntent("请根据设计方案 design.md 来完成修改", createContext());
  assert.equal(result.intent, "execute");
  assert.equal(result.needsDecision, undefined);
});

test("Git commit and push requests resolve to execute", () => {
  for (const input of [
    "提交并推送",
    "帮我提交 git 并推送",
    "commit and push my changes",
  ]) {
    const result = resolveTurnRunIntent(input, createContext());
    assert.equal(result.intent, "execute", input);
    assert.equal(result.commandDirective.kind, "git", input);
    assert.equal(result.commandDirective.action, "commit_push", input);
    assert.equal(result.requiresApproval, true, input);
    assert.equal(result.needsDecision, undefined, input);
  }
});

test("Git status inspection resolves to execute for shell access", () => {
  const result = resolveTurnRunIntent("先帮我查看 Git 状态和变更内容", createContext());
  assert.equal(result.intent, "execute");
  assert.equal(result.commandDirective.kind, "git");
  assert.equal(result.commandDirective.action, "diff");
  assert.equal(result.needsDecision, undefined);
});

test("deployment and server sync requests resolve to execute", () => {
  for (const input of [
    "将本地网站同步到服务器里",
    "直接执行部署脚本 deploy.sh",
    "run deployment script",
  ]) {
    const result = resolveTurnRunIntent(input, createContext());
    assert.equal(result.intent, "execute", input);
    assert.equal(result.commandDirective.kind, "shell", input);
    assert.equal(result.commandDirective.requiresApproval, true, input);
    assert.equal(result.needsDecision, undefined, input);
  }
});

test("existing .MAIN/plans execution request resolves to approved plan resume", () => {
  const input = "根据.MAIN/plans文件夹的内容，完成执行方案和任务的内容。";
  const result = resolveTurnRunIntent(input, createContext());

  assert.equal(looksLikeExistingPlanExecutionRequest(input), true);
  assert.equal(result.intent, "plan");
  assert.equal(result.controlAction, "resume_plan_execution");
  assert.equal(result.commandDirective.kind, "plan_resume");
  assert.equal(result.needsDecision, undefined);
});

test("design based implementation request approves an existing plan", () => {
  const result = resolveTurnRunIntent(
    "请根据设计方案 design.md 来完成修改",
    createContext({
      hasPlanArtifacts: true,
      planStage: "ready_to_execute",
      isPlanApproved: false,
    }),
  );
  assert.equal(result.intent, "plan");
  assert.equal(result.controlAction, "approve_plan");
  assert.equal(result.commandDirective.kind, "plan_approval");
  assert.equal(result.commandDirective.requiresApproval, false);
  assert.equal(result.needsDecision, undefined);
});

test("approved plan resume keeps the conversation intent as plan", () => {
  const result = resolveTurnRunIntent(
    "继续执行剩余任务",
    createContext({
      hasPlanArtifacts: true,
      planStage: "executing",
      isPlanApproved: true,
    }),
  );

  assert.equal(result.intent, "plan");
  assert.equal(result.controlAction, "resume_plan_execution");
  assert.equal(result.commandDirective.kind, "plan_resume");
});

test("command directive inference keeps Unity, reports, and file changes as second-level metadata", () => {
  assert.deepEqual(
    {
      unity: inferCommandDirective("把 Unity 的 YAML/引用搜索做成 MCP 工具", "plan").kind,
      unityConsoleAction: inferCommandDirective("检查一下Unity console的报错", "analyze").action,
      report: inferCommandDirective("请整理成分析报告", "report").kind,
      file: inferCommandDirective("直接修改标题同步逻辑", "execute").kind,
    },
    {
      unity: "unity",
      unityConsoleAction: "console_diagnostics",
      report: "report",
      file: "file_modify",
    },
  );
});

test("complex multi-file generation routes to plan before execution", () => {
  const result = resolveTurnRunIntent(
    "生成一套游戏框架代码包括文件夹，实现《歧路旅人》CTB回合制战斗逻辑。",
    createContext(),
  );
  assert.equal(result.intent, "plan");
  assert.equal(result.needsDecision, undefined);
  assert.equal(result.riskLevel, "high");
});

test("explicit analysis requests resolve to analyze", () => {
  const result = resolveTurnRunIntent("请仔细检查验证这段指令通信链路", createContext());
  assert.equal(result.intent, "analyze");
  assert.equal(result.needsDecision, undefined);
});

test("analysis report requests still resolve to report", () => {
  const result = resolveTurnRunIntent("请整理成分析报告", createContext());
  assert.equal(result.intent, "report");
});

test("mixed summarize and execute signals request an explicit intent decision", () => {
  const result = resolveTurnRunIntent("请先总结一下当前改动，然后 commit 并 push 到远程", createContext());
  assert.equal(result.intent, "discuss");
  assert.equal(result.needsDecision, true);
  assert.equal(result.suggestedIntent, "execute");
  assert.deepEqual(result.decisionOptions, ["execute", "summarize", "discuss"]);
  assert.notEqual(result.intent, "summarize");
});

test("pure summarize request still resolves directly to summarize", () => {
  const result = resolveTurnRunIntent("请总结一下这次排查结论", createContext());
  assert.equal(result.intent, "summarize");
  assert.equal(result.needsDecision, undefined);
});

test("output-style intents stay inside the chat workflow", () => {
  for (const intent of ["analyze", "summarize", "report"]) {
    const policy = getIntentPolicy(intent);
    assert.equal(policy.workflowMode, "chat");
    assert.equal(policy.uiCategory, "output_style");
    assert.equal(policy.toolPolicy, "read_only");
    assert.equal(mapResolvedRunIntentToWorkflowMode(intent), "chat");
  }
});

test("analyze intent exposes a localized badge label", () => {
  const policy = getIntentPolicy("analyze");
  assert.equal(policy.label.zh, "分析");
  assert.equal(policy.label.en, "Analyze");
});

test("plan and execute remain real workflow modes", () => {
  assert.equal(getIntentPolicy("plan").uiCategory, "workflow_mode");
  assert.equal(getIntentPolicy("plan").workflowMode, "plan");
  assert.equal(getIntentPolicy("plan").requiresPlanApproval, true);
  assert.equal(getIntentPolicy("execute").uiCategory, "workflow_mode");
  assert.equal(getIntentPolicy("execute").workflowMode, "edit");
  assert.equal(getIntentPolicy("execute").requiresPlanApproval, false);
});

test("weak plan keyword triggers a decision instead of forcing plan", () => {
  const result = resolveTurnRunIntent("maybe we need a plan for this", createContext());
  assert.equal(result.intent, "discuss");
  assert.equal(result.needsDecision, true);
  assert.equal(result.suggestedIntent, "plan");
});

test("Chinese weak plan phrasing does not force plan mode", () => {
  const result = resolveTurnRunIntent("这个方案怎么样？", createContext());
  assert.equal(result.intent, "discuss");
  assert.equal(result.needsDecision, true);
  assert.equal(result.suggestedIntent, "plan");
});

test("ordinary analysis question defaults to discuss", () => {
  const result = resolveTurnRunIntent("帮我解释一下这个模块现在在做什么", createContext());
  assert.equal(result.intent, "discuss");
  assert.equal(result.needsDecision, undefined);
});

test("MAIN intent shortcuts parse slash command and remaining prompt", () => {
  assert.deepEqual(parseMainIntentShortcut("/计划 帮我设计功能"), {
    intent: "plan",
    command: "/计划",
    rest: "帮我设计功能",
  });
  assert.deepEqual(parseMainIntentShortcut("/分析 check this flow"), {
    intent: "analyze",
    command: "/分析",
    rest: "check this flow",
  });
  assert.equal(parseMainIntentShortcut("/setup-engine unity"), null);
});

test("MAIN intent shortcuts no longer parse /执行 or /execute", () => {
  const visibleZh = getMainIntentShortcuts("zh");
  const visibleEn = getMainIntentShortcuts("en");
  const allZh = getMainIntentShortcuts("zh", { includeHidden: true });

  assert.equal(visibleZh.some((item) => item.intent === "execute"), false);
  assert.equal(visibleEn.some((item) => item.intent === "execute"), false);
  assert.equal(allZh.some((item) => item.intent === "execute"), false);
  assert.equal(parseMainIntentShortcut("/执行 直接修复这个问题"), null);
  assert.equal(parseMainIntentShortcut("/execute fix this issue"), null);
});

test("hidden MDEBUG shortcut parses without entering visible intent shortcuts", () => {
  assert.deepEqual(parseMainDebugShortcut("/MDEBUG 反馈内容"), {
    command: "/MDEBUG",
    rest: "反馈内容",
  });
  assert.deepEqual(parseMainDebugShortcut("   /mdebug\n# MAIN 用户反馈修复请求"), {
    command: "/MDEBUG",
    rest: "# MAIN 用户反馈修复请求",
  });
  assert.deepEqual(parseMainDebugShortcut("/MDEBUG"), {
    command: "/MDEBUG",
    rest: "",
  });
  assert.equal(parseMainIntentShortcut("/MDEBUG 反馈内容"), null);
  assert.equal(parseMainDebugShortcut("/计划 帮我设计功能"), null);
  assert.equal(parseMainDebugShortcut("/MDEBUGGER 反馈内容"), null);
});

test("composer suggestion keeps explicit slash intent as the default", () => {
  const suggestion = resolveComposerIntentSuggestion({
    input: "/计划 帮我总结这段内容",
    language: "zh",
    mainModeKey: "main_mode",
    lockedComposerIntent: null,
    dismissedSuggestedIntentKey: null,
    hasPlanArtifacts: false,
    planStage: "idle",
    isPlanApproved: false,
  });

  assert.equal(parseMainIntentShortcut("/计划 帮我总结这段内容").intent, "plan");
  assert.equal(suggestion.kind, "explicit_conflict");
  assert.equal(suggestion.explicitIntent, "plan");
  assert.equal(suggestion.intent, "summarize");
});

test("composer suggestion ignore and locked intent do not override explicit user choice", () => {
  assert.equal(
    resolveComposerIntentSuggestion({
      input: "/计划 帮我总结这段内容",
      language: "zh",
      mainModeKey: "main_mode",
      lockedComposerIntent: null,
      dismissedSuggestedIntentKey: "/计划 帮我总结这段内容",
      hasPlanArtifacts: false,
      planStage: "idle",
      isPlanApproved: false,
    }),
    null,
  );

  assert.equal(
    resolveComposerIntentSuggestion({
      input: "/计划 帮我总结这段内容",
      language: "zh",
      mainModeKey: "main_mode",
      lockedComposerIntent: "summarize",
      dismissedSuggestedIntentKey: null,
      hasPlanArtifacts: false,
      planStage: "idle",
      isPlanApproved: false,
    }),
    null,
  );
});

test("ordinary low-risk discuss requests should not block on preflight", () => {
  const result = resolveTurnRunIntent("帮我解释一下这个模块现在在做什么", createContext());
  assert.equal(shouldUseBlockingIntentPreflight(result, "main_mode"), false);
});

test("low-confidence non-discuss requests can still opt into blocking preflight", () => {
  assert.equal(
    shouldUseBlockingIntentPreflight(
      {
        intent: "execute",
        reason: "synthetic",
        confidence: 0.78,
        bypassMainRouter: false,
        riskLevel: "medium",
      },
      "main_mode",
    ),
    true,
  );
});

test("output-style intents do not block on preflight", () => {
  assert.equal(
    shouldUseBlockingIntentPreflight(
      {
        intent: "report",
        reason: "synthetic",
        confidence: 0.78,
        bypassMainRouter: false,
        riskLevel: "medium",
      },
      "main_mode",
    ),
    false,
  );
});

test("high-risk multi-step implementation suggests planning first", () => {
  const result = resolveTurnRunIntent(
    "帮我从零搭建整个项目，包含前端后端、数据库 API、安装依赖和部署 pipeline",
    createContext(),
  );
  assert.equal(result.intent, "execute");
  assert.equal(result.needsDecision, true);
  assert.equal(result.suggestedIntent, "plan");
  assert.equal(result.riskLevel, "high");
});

test("game studio workflow slash bypasses MAIN plan interception", () => {
  const result = resolveTurnRunIntent(
    "/setup-engine unity",
    createContext({
      mainModeKey: "game_studio",
      parsedStudioCommand: {
        type: "workflow",
        slug: "setup-engine",
        args: "unity",
        canonicalCommand: "/setup-engine",
      },
    }),
  );
  assert.equal(result.intent, "studio_workflow");
  assert.equal(result.bypassMainRouter, true);
});

test("game studio explicit implementation text enters studio workflow", () => {
  for (const input of [
    "立即开始重构并完善",
    "继续实现 SnakeController",
    "开始重构 SnakeController 移动逻辑",
    "完善 SnakeController",
  ]) {
    const result = resolveTurnRunIntent(
      input,
      createContext({
        mainModeKey: "game_studio",
      }),
    );
    assert.equal(result.intent, "studio_workflow", input);
    assert.equal(result.bypassMainRouter, true, input);
  }
});

test("game studio ordinary explanatory text still defaults to discuss", () => {
  const result = resolveTurnRunIntent(
    "帮我解释一下当前玩法思路",
    createContext({
      mainModeKey: "game_studio",
    }),
  );
  assert.equal(result.intent, "discuss");
});

test("natural Chinese approval phrases advance an existing plan into execution", () => {
  const result = resolveTurnRunIntent(
    "可以开始执行设计方案了",
    createContext({
      hasPlanArtifacts: true,
      planStage: "design",
      isPlanApproved: false,
    }),
  );

  assert.equal(result.intent, "plan");
  assert.equal(result.controlAction, "approve_plan");
});

test("approval phrasing does not trigger plan approval without plan artifacts", () => {
  const result = resolveTurnRunIntent(
    "可以开始执行设计方案了",
    createContext({
      hasPlanArtifacts: false,
      planStage: "idle",
      isPlanApproved: false,
    }),
  );

  assert.notEqual(result.controlAction, "approve_plan");
});

test("ordinary direct execution without plan artifacts still resolves to execute", () => {
  const result = resolveTurnRunIntent(
    "现在就直接实现这个功能",
    createContext({
      hasPlanArtifacts: false,
      planStage: "idle",
      isPlanApproved: false,
    }),
  );

  assert.equal(result.intent, "execute");
});

test("generic continuation phrases are recognized as previous-turn continuation", () => {
  assert.equal(looksLikePreviousTurnContinuationInput("继续"), true);
  assert.equal(looksLikePreviousTurnContinuationInput("把没完成的做完"), true);
  assert.equal(looksLikePreviousTurnContinuationInput("continue previous task"), true);
});

test("continuation resumes an unfinished execute turn", () => {
  assert.equal(
    shouldContinuePreviousTurnFromInput("继续", {
      currentTurnIntent: "execute",
      currentTurnStatus: "stopped_no_action",
      hasCurrentTurn: true,
      hasTurnActivity: true,
    }),
    true,
  );
});

test("continuation does not hijack completed or missing turns", () => {
  assert.equal(
    shouldContinuePreviousTurnFromInput("继续", {
      currentTurnIntent: "execute",
      currentTurnStatus: "completed_with_changes",
      hasCurrentTurn: true,
      hasTurnActivity: true,
    }),
    false,
  );
  assert.equal(
    shouldContinuePreviousTurnFromInput("继续", {
      currentTurnIntent: "execute",
      currentTurnStatus: "stopped_no_action",
      hasCurrentTurn: false,
      hasTurnActivity: false,
    }),
    false,
  );
});

test("non-continuation text still follows normal intent recognition", () => {
  assert.equal(
    shouldContinuePreviousTurnFromInput("请解释一下这段代码", {
      currentTurnIntent: "execute",
      currentTurnStatus: "stopped_no_action",
      hasCurrentTurn: true,
      hasTurnActivity: true,
    }),
    false,
  );
});
