import test from "node:test";
import assert from "node:assert/strict";
import fsSync from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

import ts from "typescript";

const require = createRequire(import.meta.url);
const workspaceRoot = process.cwd();
const transpiledModuleCache = new Map();

function loadWorkflowModelsModule() {
  return loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/workflowModels.ts"));
}

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
  deriveVisibleConversationTurnStatus,
  looksLikeReasoningLeakTitle,
  normalizeConversationDisplayTitle,
  resolveActiveConversationTurn,
  resolvePinnedConversationTurn,
} = loadWorkflowModelsModule();

test("normalizeConversationDisplayTitle strips speaker timestamps from transcript-style prompts", () => {
  const title = normalizeConversationDisplayTitle("Michael@: 04-23 17:57:52 这个它要建模 是啥意思", 40, "新的任务");
  assert.equal(title, "这个它要建模 是啥意思");
});

test("looksLikeReasoningLeakTitle detects leaked chain-of-thought style titles", () => {
  assert.equal(
    looksLikeReasoningLeakTitle("Here's a thinking process: 1. Analyze User Input: inspect the request"),
    true,
  );
});

test("resolveActiveConversationTurn prefers the latest turn while auto-following the bottom", () => {
  const turns = [
    {
      id: "turn-1",
      userPrompt: "第一轮",
      title: "第一轮",
      mode: "chat",
      status: "done",
      summary: "第一轮已完成",
      blockIds: [],
      collapsed: true,
      createdAt: 1,
    },
    {
      id: "turn-2",
      userPrompt: "第二轮",
      title: "第二轮",
      mode: "chat",
      status: "executing",
      summary: "",
      blockIds: [],
      collapsed: false,
      createdAt: 2,
    },
  ];

  const activeTurn = resolveActiveConversationTurn(turns, "turn-1", true);
  assert.equal(activeTurn?.id, "turn-2");
});

test("resolveActiveConversationTurn keeps following the visible turn when auto-follow is off", () => {
  const turns = [
    {
      id: "turn-1",
      userPrompt: "第一轮",
      title: "第一轮",
      mode: "chat",
      status: "done",
      summary: "第一轮已完成",
      blockIds: [],
      collapsed: true,
      createdAt: 1,
    },
    {
      id: "turn-2",
      userPrompt: "第二轮",
      title: "第二轮",
      mode: "chat",
      status: "executing",
      summary: "",
      blockIds: [],
      collapsed: false,
      createdAt: 2,
    },
  ];

  const activeTurn = resolveActiveConversationTurn(turns, "turn-1", false);
  assert.equal(activeTurn?.id, "turn-1");
});

test("resolvePinnedConversationTurn stays on the current executing turn while browsing older content", () => {
  const turns = [
    {
      id: "turn-1",
      userPrompt: "第一轮",
      title: "第一轮",
      mode: "chat",
      status: "done",
      summary: "第一轮已完成",
      blockIds: [],
      collapsed: true,
      createdAt: 1,
    },
    {
      id: "turn-2",
      userPrompt: "执行计划",
      title: "执行计划",
      mode: "plan",
      status: "executing",
      summary: "",
      blockIds: [],
      collapsed: false,
      createdAt: 2,
    },
  ];

  const pinnedTurn = resolvePinnedConversationTurn(turns, "turn-2");
  assert.equal(pinnedTurn?.id, "turn-2");
  assert.equal(pinnedTurn?.mode, "plan");
});

test("deriveVisibleConversationTurnStatus shows paused when approved plan execution is no longer actively running", () => {
  const visibleStatus = deriveVisibleConversationTurnStatus({
    baseStatus: "executing",
    workflowMode: "plan",
    isPinnedPlanTurnVisible: true,
    isPlanApproved: true,
    planStage: "executing",
    agentStatus: "idle",
    hasIncompletePlanTasks: true,
    hasTasksArtifact: true,
  });

  assert.equal(visibleStatus, "paused");
});

test("deriveVisibleConversationTurnStatus keeps awaiting approval visible before plan execution starts", () => {
  const visibleStatus = deriveVisibleConversationTurnStatus({
    baseStatus: "planning",
    workflowMode: "plan",
    isPinnedPlanTurnVisible: true,
    isPlanApproved: false,
    planStage: "ready_to_execute",
    agentStatus: "pending_review",
    hasIncompletePlanTasks: false,
    hasTasksArtifact: false,
  });

  assert.equal(visibleStatus, "awaiting_approval");
});

test("deriveVisibleConversationTurnStatus leaves non-pinned historical turns unchanged", () => {
  const visibleStatus = deriveVisibleConversationTurnStatus({
    baseStatus: "done",
    workflowMode: "plan",
    isPinnedPlanTurnVisible: false,
    isPlanApproved: true,
    planStage: "executing",
    agentStatus: "idle",
    hasIncompletePlanTasks: true,
    hasTasksArtifact: true,
  });

  assert.equal(visibleStatus, "done");
});
