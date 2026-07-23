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
  createTaskTargetingRuntime,
  resolveAgentLoopTurnInputContext,
  runAgentLoopStartHooks,
} = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/lib/orchestrator/loop/turnPreparation.ts"),
);

function baseRuntimeState(overrides = {}) {
  return {
    config: {
      hooksEnabled: false,
    },
    skills: [],
    workspace: workspaceRoot,
    turnIntent: "execute",
    workflowMode: "edit",
    ...overrides,
  };
}

test("turn preparation task targeting runtime builds scoped intake profile", () => {
  const callbacks = {
    getSessionKey: () => "turn-prep-test",
    getPlanTasks: () => [{ text: "Fix src/App.tsx render bug" }],
    getIsPlanApproved: () => false,
  };
  const runtime = createTaskTargetingRuntime({
    callbacks,
    runtimeState: baseRuntimeState(),
    turnInputContext: {
      latestUserPromptText: "Fix src/App.tsx render bug",
      turnInputContextSignals: {
        imageParts: 1,
        mentionedFilePaths: ["src/App.tsx"],
        attachedFilePaths: [],
      },
    },
    associatedPaths: ["src/App.tsx"],
  });

  const profile = runtime.buildCurrentTaskTargetingProfile();
  assert.ok(runtime.taskTargetingEvidence instanceof Set);
  assert.ok(profile.explicitPaths.includes("src/App.tsx"));
  assert.ok(profile.mentionedFilePaths.includes("src/App.tsx"));
  assert.equal(profile.imageParts, 1);
  assert.equal(profile.hasUserProvidedContext, true);
});

test("Goal turn intake uses the canonical objective instead of an internal continuation prompt", () => {
  const debugEvents = [];
  const objective = "修复白屏并验证，可以开启多个 subagent 协同工作";
  const result = resolveAgentLoopTurnInputContext(baseRuntimeState({
    // Goal slices retain the outer execute intent in the agent loop.
    turnIntent: "execute",
    workflowMode: "edit",
    initialMessages: [{
      role: "user",
      content: "本轮 Execute 已进行 8/8 轮工具循环，接近安全边界。",
    }],
  }), {
    getSessionKey: () => "goal-turn-intake",
    getGoalTurnContract: () => ({ objective }),
    getMainModeKey: () => "agent",
    onDebugEvent: (name, payload) => debugEvents.push({ name, payload }),
  });

  assert.equal(result.latestUserPromptText, objective);
  assert.equal(debugEvents[0].payload.source, "goal_contract_objective");
  assert.equal(debugEvents[0].payload.goalObjectiveChars, objective.length);
});

test("same-Turn child Run inherits admitted payload signals instead of synthetic continuation zeros", () => {
  const debugEvents = [];
  const admittedSignals = {
    imageParts: 1,
    mentionedFilePaths: ["src/ChatArea.tsx"],
    attachedFilePaths: ["notes/incident.md"],
    subagentPreference: "preferred",
    diagnosisRequirement: "required",
  };
  const result = resolveAgentLoopTurnInputContext(baseRuntimeState({
    initialMessages: [
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: "data:image/png;base64,first-only" } },
          {
            type: "text",
            text: "[turn_intake]\nimageParts: 1\n@file: src/ChatArea.tsx\nattachment: notes/incident.md\n[user_request]\n修复截图中的计划流程\n[/user_request]\n[/turn_intake]",
          },
        ],
      },
      {
        role: "user",
        content: "请在新的恢复上下文中继续执行已批准计划。这是 MAIN 的自动恢复。",
      },
    ],
  }), {
    getSessionKey: () => "workspace:7",
    getCurrentTurnId: () => "turn-image-plan",
    getMainModeKey: () => "agent",
    getTurnRuntimeCheckpoint: () => ({
      revision: 4,
      owner: { sessionKey: "workspace:7", turnId: "turn-image-plan" },
      input: {
        admittedUserContext: admittedSignals,
        visualContext: {
          status: "delivered",
          expectedImageParts: 1,
          deliveredImageParts: 1,
          omittedImageParts: 0,
          recognition: "observed",
          observationSummary: "截图显示计划卡片在修正版后消失。",
          observationId: "visual-1",
        },
      },
    }),
    onDebugEvent: (name, payload) => debugEvents.push({ name, payload }),
  });

  assert.equal(result.latestUserPromptText, "修复截图中的计划流程");
  assert.deepEqual(result.turnInputContextSignals, admittedSignals);
  assert.equal(
    debugEvents.find((event) => event.name === "agent.turn_input_context_resolved")?.payload.source,
    "durable_turn_admission",
  );
});

test("a checkpoint owned by another Turn cannot leak image or file signals", () => {
  const result = resolveAgentLoopTurnInputContext(baseRuntimeState({
    initialMessages: [{
      role: "user",
      content: "[turn_intake]\nimageParts: 0\n[user_request]\n开始新的纯文本任务\n[/user_request]\n[/turn_intake]",
    }],
  }), {
    getSessionKey: () => "workspace:7",
    getCurrentTurnId: () => "turn-new",
    getMainModeKey: () => "agent",
    getTurnRuntimeCheckpoint: () => ({
      revision: 9,
      owner: { sessionKey: "workspace:7", turnId: "turn-old" },
      input: {
        admittedUserContext: {
          imageParts: 2,
          mentionedFilePaths: ["old.ts"],
          attachedFilePaths: ["old.md"],
          subagentPreference: "preferred",
        },
      },
    }),
  });

  assert.equal(result.latestUserPromptText, "开始新的纯文本任务");
  assert.equal(result.turnInputContextSignals.imageParts, 0);
  assert.deepEqual(result.turnInputContextSignals.mentionedFilePaths, []);
  assert.deepEqual(result.turnInputContextSignals.attachedFilePaths, []);
  assert.equal(result.turnInputContextSignals.subagentPreference, "unspecified");
});

test("chat repair recovery requires formal mutation intent instead of lexical repair wording", () => {
  const baseCallbacks = {
    getSessionKey: () => "chat-repair-authorization",
    getMainModeKey: () => "agent",
  };
  const denied = resolveAgentLoopTurnInputContext(baseRuntimeState({
    turnIntent: "respond",
    workflowMode: "chat",
    initialMessages: [{
      role: "user",
      content: "请分析这个问题，但不要修改或修复任何文件。",
    }],
  }), baseCallbacks);
  const authorized = resolveAgentLoopTurnInputContext(baseRuntimeState({
    turnIntent: "execute",
    workflowMode: "chat",
    initialMessages: [{
      role: "user",
      content: "请找到这个问题并修复相关文件。",
    }],
  }), baseCallbacks);

  assert.equal(denied.repairExecutionRequestInChat, false);
  assert.equal(authorized.repairExecutionRequestInChat, true);
});

test("turn preparation start hooks are a no-op when hooks are disabled", async () => {
  const events = [];
  const callbacks = {
    getSessionKey: () => "hooks-disabled-test",
    hasSessionHookInitialized: () => false,
    getPreferredLanguage: () => "en",
    appendMessage: (message) => events.push({ type: "append", message }),
    markSessionHookInitialized: () => events.push({ type: "mark" }),
    onStatusChange: (status) => events.push({ type: "status", status }),
    getMessages: () => [{ role: "user", content: "Hello" }],
  };

  const result = await runAgentLoopStartHooks({
    callbacks,
    runtimeState: baseRuntimeState(),
    hooksConfig: {
      path: null,
      hooks: {
        SessionStart: [],
        UserPromptSubmit: [],
        PreToolUse: [],
        PostToolUse: [],
      },
      loadedAt: 1,
    },
    associatedPaths: [],
  });

  assert.equal(result, "continue");
  assert.deepEqual(events, []);
});

test("blocked start hooks defer idle publication to the orchestrator terminal boundary", () => {
  const hookFunctionSource = runAgentLoopStartHooks.toString();
  const orchestratorSource = fsSync.readFileSync(
    path.join(workspaceRoot, "src/lib/orchestrator/loop/AgentOrchestrator.ts"),
    "utf8",
  );

  assert.doesNotMatch(hookFunctionSource, /onStatusChange\("idle"\)/);
  assert.match(
    orchestratorSource,
    /if \(startHooksResult === "blocked"\) \{[\s\S]*?emitRunPausedEvent\([\s\S]*?"start_hook_blocked"[\s\S]*?callbacks\.onStatusChange\("idle"\)/,
  );
});
