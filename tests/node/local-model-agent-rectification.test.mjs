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
      esModuleInterop: true,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
    fileName: normalizedPath,
  }).outputText;

  const module = { exports: {} };
  transpiledModuleCache.set(normalizedPath, module.exports);
  const localRequire = createRequire(normalizedPath);
  const runtimeRequire = (specifier) => {
    if (specifier === "./ipc" || specifier.endsWith("/ipc")) {
      const ipcStub = {
        listWorkspaceSkills: async () => [],
        listInstalledSkillPackages: async () => [],
        discoverPersonalAgentSkills: async () => [
          {
            entryPath: "/Users/test/.agents/skills/unity-2d-physics/SKILL.md",
            basePath: "/Users/test/.agents/skills/unity-2d-physics",
            content: [
              "---",
              "name: Unity 2D Physics",
              "description: Configures 2D physics components",
              "triggers:",
              "  - rigidbody2d",
              "  - boxcollider2d",
              "---",
              "# Unity 2D Physics Guide",
              "Use Rigidbody2D for 2D sprites.",
            ].join("\n"),
            supportingFiles: [],
          },
        ],
        globSearch: async () => "[]",
        inspectGlobalSkillPackage: async () => ({
          packageId: "pkg",
          name: "Pkg",
          entryPoint: "SKILL.md",
          entryPoints: ["SKILL.md"],
          files: ["SKILL.md"],
          payloadDir: "/tmp/skills/pkg/payload",
        }),
        readGlobalSkillPackageFile: async () => "",
        readFile: async () => "",
      };
      return { ...ipcStub, ipc: ipcStub };
    }
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
  CORE_DEFAULT_TOOL_NAMES,
  clearUnlockedToolsForSession,
  executeToolSearch,
  filterToCoreAndUnlockedTools,
  getUnlockedToolsForSession,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/toolSearch.ts"));
const { buildToolDefinitions } = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/toolSchemas.ts"));
const { prioritizeRuntimeV2ProviderToolDefinitions } = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/store/runtimeV2/executionProviderTools.ts"),
);
const {
  listWorkspaceCheckpoints,
  recordWorkspaceFileCheckpoint,
  rewindWorkspaceCheckpoints,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/workspaceCheckpoints.ts"));
const { preflightWorkspaceMutation } = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/lib/workspaceMutationPreflight.ts"),
);
const { loadSkillCatalog, loadSkillContent, resolveSkillId } = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/lib/agentSkills.ts"),
);
const { runtimeV2ContextBoundToolArguments } = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/store/runtimeV2/executionText.ts"),
);
const { parseExplicitTextToolEnvelope } = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/lib/runtime-v2/providerLane.ts"),
);
const { parseToolUseBlock } = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/lib/textToolParser.ts"),
);
const { resolveAndApplySubmitIntentRouting } = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/store/submitIntentRouting.ts"),
);
const { resolveRuntimeV2VisibleRunnerKind } = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/lib/runtimeEngineSelection.ts"),
);

test("Phase 1: filterToCoreAndUnlockedTools exposes only the core tools by default and unlocks extended tools via executeToolSearch", () => {
  const sessionKey = "test-session-phase-1";
  clearUnlockedToolsForSession(sessionKey);

  const allDefs = buildToolDefinitions([]);
  const defaultTools = filterToCoreAndUnlockedTools(allDefs, { sessionKey });
  for (const tool of defaultTools) {
    assert.equal(CORE_DEFAULT_TOOL_NAMES.has(tool.function.name), true);
  }
  assert.equal(defaultTools.some((t) => t.function.name === "tool_search"), true);
  assert.equal(defaultTools.some((t) => t.function.name === "git_status"), false);

  const searchJson = executeToolSearch(
    { query: "git status diff" },
    {
      sessionKey,
      toolCatalog: {
        toolDefinitions: allDefs,
        lookup: () => ({ status: "unresolved" }),
      },
    },
  );
  const parsed = JSON.parse(searchJson);
  assert.equal(parsed.matchedCount > 0, true);
  assert.equal(getUnlockedToolsForSession(sessionKey).has("git_status"), true);

  const unlockedTools = filterToCoreAndUnlockedTools(allDefs, { sessionKey });
  assert.equal(unlockedTools.some((tool) => tool.function.name === "git_status"), true);
  clearUnlockedToolsForSession(sessionKey);
});

test("Phase 1: prioritizeRuntimeV2ProviderToolDefinitions preserves static tool ordering for local LLM KV-cache stability", () => {
  const sampleTools = buildToolDefinitions([]).slice(0, 6);
  const firstOrder = prioritizeRuntimeV2ProviderToolDefinitions({
    command: {},
    tools: sampleTools,
    hasMaterializedSourceEvidence: false,
  }).map((t) => t.function.name);
  const secondOrder = prioritizeRuntimeV2ProviderToolDefinitions({
    command: {},
    tools: sampleTools,
    hasMaterializedSourceEvidence: true,
  }).map((t) => t.function.name);
  assert.deepEqual(firstOrder, secondOrder);
});

test("Phase 3: workspaceCheckpoints records pre-mutation snapshots and rewinds to initial baseline cleanly", async () => {
  const sessionKey = "test-session-checkpoints";

  const disk = new Map([
    ["src/a.ts", "export const a = 1;\n"],
  ]);

  recordWorkspaceFileCheckpoint({
    sessionKey,
    workspace: "/repo",
    path: "src/a.ts",
    existedBefore: true,
    previousContent: disk.get("src/a.ts"),
    toolName: "replace_in_file",
  });
  disk.set("src/a.ts", "export const a = 2;\n");

  // Second mutation on the same file
  recordWorkspaceFileCheckpoint({
    sessionKey,
    workspace: "/repo",
    path: "src/a.ts",
    existedBefore: true,
    previousContent: disk.get("src/a.ts"),
    toolName: "replace_in_file",
  });
  disk.set("src/a.ts", "export const a = 3;\n");

  const checkpoints = listWorkspaceCheckpoints(sessionKey);
  assert.equal(checkpoints.length, 2);
  assert.equal(checkpoints[0].previousContent, "export const a = 1;\n");

  const rewound = await rewindWorkspaceCheckpoints(sessionKey, {
    writeFile: async (p, content) => {
      disk.set(p, content);
    },
    deletePath: async (p) => {
      disk.delete(p);
    },
  });
  assert.deepEqual(rewound.restoredPaths, ["src/a.ts"]);
  assert.equal(disk.get("src/a.ts"), "export const a = 1;\n");
  assert.equal(listWorkspaceCheckpoints(sessionKey).length, 0);
});

test("Phase 3: preflightWorkspaceMutation attaches nearby actual file snippet on search_text_mismatch", async () => {
  const fileContent = [
    "export function calculateScore(base: number) {",
    "  const bonus = base * 2;",
    "  return bonus + 10;",
    "}",
  ].join("\n");

  const result = await preflightWorkspaceMutation({
    toolName: "replace_in_file",
    args: {
      path: "src/score.ts",
      search_text: "export function calculateScore(base: number) {\n  const bonus = base * 999;\n}",
      replace_text: "export function calculateScore(base: number) {\n  return base;\n}",
    },
    language: "zh",
    readFile: async () => fileContent,
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "search_text_mismatch");
  assert.match(result.message, /请直接复制下方当前文件中的真实代码片段修正 search_text 后重试/);
  assert.match(result.message, /const bonus = base \* 2;/);
});

test("Phase 4: parseExplicitTextToolEnvelope parses both <tool_call> JSON and legacy <tool_use> XML parameters", () => {
  const jsonCalls = parseExplicitTextToolEnvelope(
    `<tool_call>\n{"name":"read_file","arguments":{"path":"src/App.tsx"}}\n</tool_call>`,
  );
  assert.equal(jsonCalls.length, 1);
  assert.equal(jsonCalls[0].name, "read_file");
  assert.equal(jsonCalls[0].arguments.path, "src/App.tsx");

  const xmlCalls = parseExplicitTextToolEnvelope(
    `<tool_use>\n<tool>read_file</tool>\n<parameter name="path">src/main.ts</parameter>\n</tool_use>`,
  );
  assert.equal(xmlCalls.length, 1);
  assert.equal(xmlCalls[0].name, "read_file");
  assert.equal(xmlCalls[0].arguments.path, "src/main.ts");
});

test("Phase 2 regression (main-debug.log): workspace summary and Q&A with fallbackRunIntent='execute' route to workspace_read instead of execute recovery loop", () => {
  const baseRoutingInput = {
    images: undefined,
    preferredLanguage: "zh",
    options: {},
    currentMainModeKey: "main_mode",
    hasWorkspace: true,
    isHidden: false,
    autoApproveTools: false,
    fallbackRunIntent: "execute",
    mainDebugShortcut: null,
    mainIntentShortcut: null,
    lockedComposerIntent: null,
    goalCreationAuthorization: null,
    goalContinuationAuthorization: null,
    currentTurn: null,
    currentTurnIntent: "respond",
    hasPlanArtifacts: false,
    shouldContinuePlanIntent: false,
    shouldContinuePreviousTurnIntent: false,
    previousTurnContinuationTarget: null,
    previousTurnContinuationIntent: null,
    shouldReuseExistingTurnIntent: false,
    shouldExecuteOnceFromReplyOption: false,
    shouldRouteContinuationToPlanResume: false,
    planExecutionResumeContinuationTarget: null,
    planStage: "idle",
    isPlanApproved: false,
    currentTurnId: null,
    dismissedPendingDecisionInputKey: null,
    currentConfig: { workflowMode: "edit" },
    sendOriginSessionKey: "/Users/michael/Documents/Unity/ProjectM::1",
    setState: () => {},
    applyPreRunSessionPatch: () => {},
    approvePlan: () => {},
    startPlanExecutionResume: () => {},
    startBlockingPreflight: () => {},
    logStoreEvent: () => {},
  };

  const summaryTurn = resolveAndApplySubmitIntentRouting({
    ...baseRoutingInput,
    text: "查看项目里的说明文档，用简短的一段话总结一下 Castle Triad 的核心玩法",
  });
  assert.equal(summaryTurn.handled, false);
  assert.equal(summaryTurn.effectiveRunIntent, "summarize");
  assert.equal(
    resolveRuntimeV2VisibleRunnerKind({
      effectiveIntent: summaryTurn.effectiveRunIntent,
      runtimeIntent: summaryTurn.effectiveRunIntent,
      runWorkspace: "/Users/michael/Documents/Unity/ProjectM",
    }),
    "workspace_read",
  );

  const qaTurn = resolveAndApplySubmitIntentRouting({
    ...baseRoutingInput,
    text: "Castle Triad 的卡牌翻面规则是怎么样的？",
  });
  assert.equal(qaTurn.handled, false);
  assert.equal(qaTurn.effectiveRunIntent, "respond");
  assert.equal(
    resolveRuntimeV2VisibleRunnerKind({
      effectiveIntent: qaTurn.effectiveRunIntent,
      runtimeIntent: qaTurn.effectiveRunIntent,
      runWorkspace: "/Users/michael/Documents/Unity/ProjectM",
    }),
    "workspace_read",
  );

  const editTurn = resolveAndApplySubmitIntentRouting({
    ...baseRoutingInput,
    text: "请修改 README.md，补充一段玩法说明并运行测试。",
  });
  assert.equal(editTurn.handled, false);
  assert.equal(editTurn.effectiveRunIntent, "execute");
  assert.equal(
    resolveRuntimeV2VisibleRunnerKind({
      effectiveIntent: editTurn.effectiveRunIntent,
      runtimeIntent: editTurn.effectiveRunIntent,
      runWorkspace: "/Users/michael/Documents/Unity/ProjectM",
    }),
    "execute",
  );
});

test("Phase 5: resolveSkillId resolves human-readable name/slug without hash and load_skill defaults to full-body budget", async () => {
  const catalog = await loadSkillCatalog({
    workspace: "",
    skills: [],
  });

  assert.equal(catalog.entries.length, 1);
  assert.deepEqual(catalog.entries[0].triggers, ["rigidbody2d", "boxcollider2d"]);

  // Resolve by human-readable name, slug, or short ref
  const canonicalId = catalog.entries[0].id;
  assert.equal(resolveSkillId(catalog, "Unity 2D Physics"), canonicalId);
  assert.equal(resolveSkillId(catalog, "unity-2d-physics"), canonicalId);

  // Full body returned in one call via human-readable name
  const loaded = loadSkillContent(catalog, "unity-2d-physics");
  assert.equal(loaded.complete, true);
  assert.match(loaded.content, /Use Rigidbody2D for 2D sprites\./);

  const boundArgs = runtimeV2ContextBoundToolArguments(
    "load_skill",
    { skill_id: "unity-2d-physics" },
    { contextLimit: 8192 },
  );
  assert.equal(Number(boundArgs.max_chars) >= 32000, true);
});
