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
