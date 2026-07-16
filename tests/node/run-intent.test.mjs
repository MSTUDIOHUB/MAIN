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
  buildEffectiveTurnContract,
  getIntentPolicy,
  hasExplicitUnityConsoleDiagnosticCue,
  inferCommandDirective,
  looksLikeAmbiguousChatExecutionInput,
  looksLikePreviousTurnContinuationInput,
  looksLikeExistingPlanExecutionRequest,
  mapResolvedRunIntentToWorkflowMode,
  parseMainDebugShortcut,
  parseMainIntentShortcut,
  parseMainIntentShortcutForMode,
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
  assert.deepEqual([...MAIN_MODE_KEYS], ["main_mode", "game_studio", "image_studio"]);
  assert.equal(mapLegacyNexusModeToMainMode("task_center"), "main_mode");
  assert.equal(mapLegacyNexusModeToMainMode("image_studio"), "image_studio");
});

test("plain Chinese planning wording stays natural without slash lock", () => {
  const result = resolveTurnRunIntent("先给我一个方案再实现", createContext());
  assert.equal(result.intent, "respond");
  assert.equal(result.needsDecision, undefined);
});

test("plain English implementation request enters execute workflow", () => {
  const result = resolveTurnRunIntent("Please implement it directly and fix the bug", createContext());
  assert.equal(result.intent, "execute");
  assert.equal(result.commandDirective.kind, "file_modify");
  assert.equal(result.commandDirective.requiresApproval, true);
  assert.equal(result.needsDecision, undefined);
});

test("fix requests with analysis-domain nouns enter execute workflow", () => {
  for (const input of [
    "修复数据分析展示问题",
    "执行修复",
    "请修复当前数据分析页面显示问题",
    "找到问题进行修复",
    "请仔细查看调试日志，找到问题的根本原因并解决",
  ]) {
    const result = resolveTurnRunIntent(input, createContext());
    assert.equal(result.intent, "execute", input);
    assert.equal(result.commandDirective.kind, "file_modify", input);
    assert.equal(result.commandDirective.requiresApproval, true, input);
    assert.equal(result.needsDecision, undefined, input);
  }
});

test("Chinese find-and-fix requests build an execution evidence contract", () => {
  const result = resolveTurnRunIntent("请查看两个回合的调试日志，找到问题并解决", createContext());
  assert.equal(result.intent, "execute");
  assert.equal(result.commandDirective.kind, "file_modify");
  assert.equal(result.commandDirective.requiresApproval, true);

  const contract = buildEffectiveTurnContract({
    conversationIntent: result.intent,
    runtimeIntent: result.intent,
    commandDirective: result.commandDirective,
    executionConsentGranted: false,
  });

  assert.equal(contract.runtimeIntent, "execute");
  assert.equal(contract.approvalState, "needs_approval");
  assert.equal(contract.operationApprovalState, "needs_approval");
  assert.equal(contract.planReviewState, "not_ready");
  assert.equal(contract.allowedToolRisks, "write");
  assert.equal(contract.mutationExpected, true);
  assert.equal(contract.validationExpected, true);
  assert.equal(contract.completionEvidenceRequired, "execution_evidence");
});

test("approved plan conversation becomes execute runtime for completion evidence", () => {
  const contract = buildEffectiveTurnContract({
    conversationIntent: "plan",
    runtimeIntent: "execute",
    commandDirective: {
      kind: "plan_resume",
      source: "natural_language",
      requiresApproval: true,
    },
    planApproved: true,
    executionConsentGranted: true,
  });

  assert.equal(contract.conversationIntent, "plan");
  assert.equal(contract.runtimeIntent, "execute");
  assert.equal(contract.approvalState, "approved");
  assert.equal(contract.operationApprovalState, "approved");
  assert.equal(contract.planReviewState, "approved");
  assert.equal(contract.allowedToolRisks, "write");
  assert.equal(contract.mutationExpected, true);
  assert.equal(contract.validationExpected, true);
  assert.equal(contract.completionEvidenceRequired, "execution_evidence");
});

test("shell and git execution require command evidence without inventing a file mutation", () => {
  for (const kind of ["shell", "git"]) {
    const contract = buildEffectiveTurnContract({
      conversationIntent: "execute",
      runtimeIntent: "execute",
      commandDirective: {
        kind,
        source: "natural_language",
        requiresApproval: true,
      },
      executionConsentGranted: true,
    });
    assert.equal(contract.mutationExpected, false, kind);
    assert.equal(contract.validationExpected, true, kind);
    assert.equal(contract.completionEvidenceRequired, "execution_evidence", kind);
  }
});

test("approved command-only Plans require validation without inventing a workspace mutation", () => {
  const contract = buildEffectiveTurnContract({
    conversationIntent: "plan",
    runtimeIntent: "execute",
    commandDirective: {
      kind: "plan_resume",
      source: "natural_language",
      requiresApproval: true,
    },
    planApproved: true,
    executionConsentGranted: true,
    workspaceMutationExpected: false,
  });
  assert.equal(contract.mutationExpected, false);
  assert.equal(contract.validationExpected, true);
  assert.equal(contract.completionEvidenceRequired, "execution_evidence");
});

test("approved Plan execution retains a pending validation contract after intent normalization", () => {
  const contract = buildEffectiveTurnContract({
    conversationIntent: "execute",
    runtimeIntent: "execute",
    commandDirective: {
      kind: "none",
      source: "natural_language",
      requiresApproval: false,
    },
    planApproved: true,
    executionConsentGranted: true,
    workspaceMutationExpected: false,
    workspaceValidationExpected: true,
  });

  assert.equal(contract.mutationExpected, false);
  assert.equal(contract.validationExpected, true);
  assert.equal(contract.completionEvidenceRequired, "execution_evidence");
});

test("approved Plan execution does not turn advisory-only review into an automatic validation gate", () => {
  const contract = buildEffectiveTurnContract({
    conversationIntent: "execute",
    runtimeIntent: "execute",
    commandDirective: {
      kind: "none",
      source: "natural_language",
      requiresApproval: false,
    },
    planApproved: true,
    executionConsentGranted: true,
    workspaceMutationExpected: false,
    workspaceValidationExpected: false,
  });

  assert.equal(contract.mutationExpected, false);
  assert.equal(contract.validationExpected, false);
  assert.equal(contract.completionEvidenceRequired, "none");
});

test("a new unapproved Plan turn never inherits operation consent from another run", () => {
  const contract = buildEffectiveTurnContract({
    conversationIntent: "plan",
    runtimeIntent: "plan",
    commandDirective: {
      kind: "none",
      source: "natural_language",
      requiresApproval: false,
    },
    planApproved: false,
    planReviewReady: false,
    executionConsentGranted: true,
  });

  assert.equal(contract.operationApprovalState, "not_required");
  assert.equal(contract.approvalState, "not_required");
  assert.equal(contract.planReviewState, "not_ready");
  assert.equal(contract.mutationExpected, false);
  assert.equal(contract.completionEvidenceRequired, "plan_artifact");
});

test("Chinese feature addition requests enter execute workflow", () => {
  for (const input of [
    "目前已经有了“打开”和“保存”功能了，请增加一个新建功能，点击新建后可以创建新的文档。",
    "请新增一个导出按钮",
    "帮我添加设置入口",
  ]) {
    const result = resolveTurnRunIntent(input, createContext());
    assert.equal(result.intent, "execute", input);
    assert.equal(result.commandDirective.kind, "file_modify", input);
    assert.equal(result.commandDirective.requiresApproval, true, input);
    assert.equal(result.needsDecision, undefined, input);
  }
});

test("Chinese design based implementation request enters execute workflow", () => {
  const result = resolveTurnRunIntent("请根据设计方案 design.md 来完成修改", createContext());
  assert.equal(result.intent, "execute");
  assert.equal(result.commandDirective.kind, "file_modify");
  assert.equal(result.commandDirective.requiresApproval, true);
  assert.equal(result.needsDecision, undefined);
});

test("Git commit and push requests ask for operation approval", () => {
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

test("Git status inspection enters execute workflow with git approval metadata", () => {
  const result = resolveTurnRunIntent("先帮我查看 Git 状态和变更内容", createContext());
  assert.equal(result.intent, "execute");
  assert.equal(result.commandDirective.kind, "git");
  assert.equal(result.commandDirective.action, "diff");
  assert.equal(result.commandDirective.requiresApproval, true);
  assert.equal(result.needsDecision, undefined);
});

test("deployment and server sync requests ask for operation approval", () => {
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

test("natural plan continuation wording resolves to approved plan resume", () => {
  for (const input of [
    "继续完成计划方案",
    "继续完成计划",
    "继续执行计划",
    "把方案继续做完",
  ]) {
    const result = resolveTurnRunIntent(input, createContext());
    assert.equal(looksLikeExistingPlanExecutionRequest(input), true, input);
    assert.equal(result.intent, "plan", input);
    assert.equal(result.controlAction, "resume_plan_execution", input);
    assert.equal(result.commandDirective.kind, "plan_resume", input);
  }
});

test("plan discussion wording stays natural response", () => {
  for (const input of [
    "这个方案怎么样？",
    "解释一下这个方案",
    "分析这个方案",
  ]) {
    const result = resolveTurnRunIntent(input, createContext());
    assert.equal(looksLikeExistingPlanExecutionRequest(input), false, input);
    assert.equal(result.intent, "respond", input);
    assert.equal(result.controlAction, undefined, input);
  }
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

test("unity console diagnostic cue ignores explicit no-error phrasing", () => {
  assert.equal(hasExplicitUnityConsoleDiagnosticCue("检查一下Unity console的报错"), true);
  assert.equal(hasExplicitUnityConsoleDiagnosticCue("Unity 里没有报错，但蛇没有移动"), false);
  assert.equal(hasExplicitUnityConsoleDiagnosticCue("no compile error, only runtime behavior issue"), false);
  assert.equal(inferCommandDirective("Unity 里没有报错，但蛇没有移动", "analyze").action, "unity_workflow");
});

test("complex multi-file generation asks for user choice before planning or execution", () => {
  const result = resolveTurnRunIntent(
    "生成一套游戏框架代码包括文件夹，实现《歧路旅人》CTB回合制战斗逻辑。",
    createContext(),
  );
  assert.equal(result.intent, "respond");
  assert.equal(result.needsDecision, true);
  assert.equal(result.suggestedIntent, "plan");
  assert.equal(result.riskLevel, "high");
});

test("plain analysis requests stay natural unless slash locked", () => {
  const result = resolveTurnRunIntent("请仔细检查验证这段指令通信链路", createContext());
  assert.equal(result.intent, "respond");
  assert.equal(result.needsDecision, undefined);
});

test("analysis report wording stays natural unless slash locked", () => {
  const result = resolveTurnRunIntent("请整理成分析报告", createContext());
  assert.equal(result.intent, "respond");
});

test("mixed summarize and execute signals request an explicit intent decision", () => {
  const result = resolveTurnRunIntent("请先总结一下当前改动，然后 commit 并 push 到远程", createContext());
  assert.equal(result.intent, "respond");
  assert.equal(result.needsDecision, true);
  assert.equal(result.suggestedIntent, "execute");
  assert.deepEqual(result.decisionOptions, ["execute", "respond", "summarize"]);
  assert.notEqual(result.intent, "summarize");
});

test("pure summarize wording stays natural unless slash locked", () => {
  const result = resolveTurnRunIntent("请总结一下这次排查结论", createContext());
  assert.equal(result.intent, "respond");
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

test("weak plan keyword stays natural instead of forcing plan", () => {
  const result = resolveTurnRunIntent("maybe we need a plan for this", createContext());
  assert.equal(result.intent, "respond");
  assert.equal(result.needsDecision, undefined);
});

test("Chinese weak plan phrasing does not force plan mode", () => {
  const result = resolveTurnRunIntent("这个方案怎么样？", createContext());
  assert.equal(result.intent, "respond");
  assert.equal(result.needsDecision, undefined);
});

test("ordinary analysis question defaults to respond", () => {
  const result = resolveTurnRunIntent("帮我解释一下这个模块现在在做什么", createContext());
  assert.equal(result.intent, "respond");
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

test("game studio only exposes plan shortcut from MAIN shortcut set", () => {
  const studioShortcutsZh = getMainIntentShortcuts("zh", { mainModeKey: "game_studio" });
  const studioShortcutsEn = getMainIntentShortcuts("en", { mainModeKey: "game_studio" });

  assert.deepEqual(studioShortcutsZh.map((item) => item.intent), ["plan"]);
  assert.deepEqual(studioShortcutsEn.map((item) => item.intent), ["plan"]);
});

test("mode-aware shortcut parsing keeps only /plan in game studio", () => {
  assert.equal(parseMainIntentShortcutForMode("/报告 输出报告", "game_studio"), null);
  assert.equal(parseMainIntentShortcutForMode("/report output report", "game_studio"), null);
  assert.deepEqual(parseMainIntentShortcutForMode("/计划 先出方案", "game_studio"), {
    intent: "plan",
    command: "/计划",
    rest: "先出方案",
  });
  assert.deepEqual(parseMainIntentShortcutForMode("/plan write a plan first", "game_studio"), {
    intent: "plan",
    command: "/计划",
    rest: "write a plan first",
  });
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

test("composer suggestion keeps explicit slash intent without semantic output-style override", () => {
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
  assert.equal(suggestion, null);
});

test("game studio suggestion never upgrades /plan to non-plan output styles", () => {
  const suggestion = resolveComposerIntentSuggestion({
    input: "/计划 帮我总结这段内容",
    language: "zh",
    mainModeKey: "game_studio",
    lockedComposerIntent: null,
    dismissedSuggestedIntentKey: null,
    hasPlanArtifacts: false,
    planStage: "idle",
    isPlanApproved: false,
  });

  assert.equal(suggestion, null);
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

test("ordinary low-risk respond requests should not block on preflight", () => {
  const result = resolveTurnRunIntent("帮我解释一下这个模块现在在做什么", createContext());
  assert.equal(shouldUseBlockingIntentPreflight(result, "main_mode"), false);
});

test("ambiguous chat-versus-execute requests use blocking preflight", () => {
  const input = "能不能支持一个导出按钮？";
  const result = resolveTurnRunIntent(input, createContext());

  assert.equal(result.intent, "respond");
  assert.equal(looksLikeAmbiguousChatExecutionInput(input), true);
  assert.equal(shouldUseBlockingIntentPreflight(result, "main_mode", input), true);
});

test("low-confidence non-respond requests can still opt into blocking preflight", () => {
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
  assert.equal(result.intent, "respond");
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

test("game studio explicit implementation text enters execute workflow", () => {
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
    assert.equal(result.intent, "execute", input);
    assert.equal(result.needsDecision, undefined, input);
  }
});

test("game studio ordinary explanatory text still defaults to respond", () => {
  const result = resolveTurnRunIntent(
    "帮我解释一下当前玩法思路",
    createContext({
      mainModeKey: "game_studio",
    }),
  );
  assert.equal(result.intent, "respond");
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

test("ordinary direct execution without plan artifacts enters execute workflow", () => {
  for (const input of [
    "现在就直接实现这个功能",
    "首先执行P0的重构，如果有任何不确定的方向请向我提问。",
  ]) {
    const result = resolveTurnRunIntent(
      input,
      createContext({
        hasPlanArtifacts: false,
        planStage: "idle",
        isPlanApproved: false,
      }),
    );

    assert.equal(result.intent, "execute", input);
    assert.equal(result.commandDirective.kind, "file_modify", input);
    assert.equal(result.commandDirective.requiresApproval, true, input);
    assert.equal(result.needsDecision, undefined, input);
  }
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

test("store marks aborted idle turns as resumable before deriving completed_with_changes", () => {
  const source = fsSync.readFileSync(path.join(workspaceRoot, "src/store/useAppStore.ts"), "utf8");

  assert.match(source, /const statusOverride =\s*status === "idle" && abortCtrl\.signal\.aborted\s*\?\s*"stopped_no_action"/);
  assert.match(source, /override: statusOverride/);
});

test("workflow engine marks non-actionable stops as resumable turn status", () => {
  const source = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/workflowEngine.ts"), "utf8");

  assert.match(source, /const stoppedStatus = reason === "no_output"[\s\S]*\? "stopped_no_output"[\s\S]*: reason === "incomplete_plan"[\s\S]*\? "paused"[\s\S]*: "stopped_no_action"/);
  assert.match(source, /turn\.id === turnId && turn\.status !== "awaiting_approval"[\s\S]*status: stoppedStatus/);
});

test("store asks before executing when preflight upgrades natural chat to operations", () => {
  const source = fsSync.readFileSync(path.join(workspaceRoot, "src/store/useAppStore.ts"), "utf8");
  const submitIntentRoutingSource = fsSync.readFileSync(path.join(workspaceRoot, "src/store/submitIntentRouting.ts"), "utf8");
  const turnSubmissionSource = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/submit/turnSubmission.ts"), "utf8");
  const preflightExecutorSource = fsSync.readFileSync(path.join(workspaceRoot, "src/store/submitPreflightExecutor.ts"), "utf8");

  assert.match(source, /startBlockingPreflight: \(blockingPreflightEffect\) =>/);
  assert.match(submitIntentRoutingSource, /const blockingPreflightEffect = buildSubmitBlockingPreflightEffect/);
  assert.match(source, /void startSubmitBlockingPreflightEffect\(\{/);
  assert.match(preflightExecutorSource, /return executeSubmitBlockingPreflight\(\{/);
  assert.match(preflightExecutorSource, /const action = resolveSubmitPreflightEffectAction/);
  assert.match(preflightExecutorSource, /action\.kind === "set_pending_decision"/);
  assert.match(turnSubmissionSource, /const preflightDecision = resolveSubmitPreflightResultDecision/);
  assert.match(turnSubmissionSource, /preflightDecision\.kind === "ask_execution_confirmation"/);
  assert.match(turnSubmissionSource, /pendingRunDecision: preflightDecision\.pendingRunDecision!/);
  assert.match(turnSubmissionSource, /const shouldAskForPreflightExecutionDecision =/);
  assert.match(turnSubmissionSource, /localWasNatural[\s\S]*preflightSuggestsOperation[\s\S]*pendingRunDecision/);
  assert.match(turnSubmissionSource, /decisionOptions: \["execute", "respond", "plan"\]/);
});

test("store forces auto-approved visible turns into execution semantics", () => {
  const source = fsSync.readFileSync(path.join(workspaceRoot, "src/store/useAppStore.ts"), "utf8");
  const submitIntentRoutingSource = fsSync.readFileSync(path.join(workspaceRoot, "src/store/submitIntentRouting.ts"), "utf8");
  const turnSubmissionSource = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/submit/turnSubmission.ts"), "utf8");

  assert.match(source, /const intentRouting = resolveAndApplySubmitIntentRouting/);
  assert.match(submitIntentRoutingSource, /const initialIntentDecision = resolveSubmitEffectiveIntentDecision/);
  assert.match(source, /autoApproveTools: state\.autoApproveTools/);
  assert.match(submitIntentRoutingSource, /const shouldForceExecuteForAutoApprove =\s*initialIntentDecision\.shouldForceExecuteForAutoApprove/);
  assert.match(turnSubmissionSource, /const shouldForceExecuteForAutoApprove =/);
  assert.match(turnSubmissionSource, /autoApproveTools === true/);
  assert.match(turnSubmissionSource, /effectiveRunIntent = currentMainModeKey === "game_studio" \? "studio_workflow" : "execute"/);
  assert.match(submitIntentRoutingSource, /!shouldForceExecuteForAutoApprove &&\s*!input\.options\?\.skipIntentResolution/);
  assert.match(source, /const runtimeDecision = resolveSubmitRuntimeDecision/);
  assert.match(source, /shouldExecuteOnceFromReplyOption,\s*preservePlanState,/);
  assert.match(source, /autoApproveTools: state\.autoApproveTools/);
  assert.match(source, /const shouldGrantExecutionConsentForTurn = runtimeDecision\.shouldGrantExecutionConsentForTurn/);
  assert.match(turnSubmissionSource, /params\.shouldExecuteOnceFromReplyOption \|\|\s*params\.autoApproveTools === true/);
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
