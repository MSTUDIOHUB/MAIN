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
const { resolveSubmitPreflightResultDecision, buildSubmitPreflightResumeOptions } = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/lib/submit/turnSubmission.ts"),
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

test("Phase 1: source-only pressure softly prioritizes mutation without revoking tools or changing ordinary ordering", () => {
  const wanted = ["read_file", "grep_search", "write_file", "replace_in_file", "apply_patch", "run_command"];
  const allTools = buildToolDefinitions([]);
  const sampleTools = wanted.map(name => allTools.find(tool => tool.function.name === name));
  assert.ok(sampleTools.every(Boolean), "the fixture uses real advertised tool definitions");
  /** @type {import('../../src/lib/runtime-v2/contracts.ts').RuntimeV2Command} */
  const command = {
    kind: "request_model", idempotencyKey: "rectification-model", phase: "acting",
    run: { sessionKey: "session", sessionEpoch: "epoch", turnId: "turn", runId: "run", parentRunId: null, attemptId: "attempt" },
    payload: { mode: "execute" },
  };
  const names = (tools) => tools.map(tool => tool.function.name);
  for (const hasMaterializedSourceEvidence of [false, true]) {
    assert.deepEqual(names(prioritizeRuntimeV2ProviderToolDefinitions({ command, tools: sampleTools, hasMaterializedSourceEvidence })), wanted,
      "source visibility alone must not reorder an ordinary request");
  }
  const pressured = { ...command, payload: { ...command.payload, effectPressure: {
    schemaVersion: "runtime-v2-effect-pressure.v1", reason: "source_only_frontier", mutationBoundarySequence: 0, sourceBoundarySequence: 12,
  } } };
  assert.deepEqual(names(prioritizeRuntimeV2ProviderToolDefinitions({ command: pressured, tools: sampleTools, hasMaterializedSourceEvidence: false })), wanted,
    "pressure without visible source must not favor an unleased mutation");
  const ordered = names(prioritizeRuntimeV2ProviderToolDefinitions({ command: pressured, tools: sampleTools, hasMaterializedSourceEvidence: true }));
  assert.deepEqual(new Set(ordered.slice(0, 3)), new Set(["write_file", "replace_in_file", "apply_patch"]));
  assert.deepEqual(ordered.slice(3), ["read_file", "grep_search", "run_command"]);
  assert.deepEqual(new Set(ordered), new Set(wanted), "soft ordering cannot withdraw safe reads, commands, or an alternative editor");
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

test("Phase 2 regression (main-debug.log): natural workspace requests use semantic preflight once and admitted read-only intents cannot inherit execute authority", () => {
  const preflights = [];
  const preRunPatches = [];
  const logs = [];
  let approvals = 0;
  let planResumes = 0;
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
    applyPreRunSessionPatch: patch => preRunPatches.push(patch),
    approvePlan: () => { approvals += 1; },
    startPlanExecutionResume: () => { planResumes += 1; },
    startBlockingPreflight: effect => preflights.push(effect),
    logStoreEvent: (event, data) => logs.push({ event, data }),
  };

  for (const [text, semanticIntent, runner] of [
    ["查看项目里的说明文档，用简短的一段话总结一下 Castle Triad 的核心玩法", "summarize", "workspace_read"],
    ["Castle Triad 的卡牌翻面规则是怎么样的？", "respond", "workspace_read"],
    ["请修改 README.md，补充一段玩法说明并运行测试。", "execute", "execute"],
  ]) {
    const previousCount = preflights.length;
    const pending = resolveAndApplySubmitIntentRouting({ ...baseRoutingInput, text });
    assert.deepEqual(pending, { handled: true, returnValue: true }, "natural-language hints must not choose a capability surface before semantic admission");
    assert.equal(preflights.length, previousCount + 1);
    const effect = preflights.at(-1);
    assert.equal(effect.request.input, text, "semantic admission receives the exact submitted text");
    assert.equal(effect.originalText, text);
    assert.equal(effect.request.hasWorkspace, true);
    assert.equal(effect.request.explicitIntent, undefined, "a fallback execute intent is not user authorization");
    assert.equal(logs.at(-1).event, "turn_intent_semantic_requested");
    assert.equal(logs.at(-1).data.heuristicHint, effect.resolution.intent, "lexical resolution is diagnostic context only");

    const decision = resolveSubmitPreflightResultDecision({ text, preferredLanguage: "zh", resolution: effect.resolution,
      preflight: { intent: semanticIntent, summary: "Fixture semantic result", commandDirective: { kind: "none", source: "preflight", requiresApproval: false } },
    });
    assert.equal(decision.kind, "resume_with_preflight");
    const admitted = resolveAndApplySubmitIntentRouting({ ...baseRoutingInput, text,
      options: buildSubmitPreflightResumeOptions({ options: effect.originalOptions, decision }),
    });
    assert.equal(admitted.handled, false);
    assert.equal(admitted.effectiveRunIntent, semanticIntent);
    assert.equal(preflights.length, previousCount + 1, "consuming one semantic result must not request a second preflight");
    assert.equal(resolveRuntimeV2VisibleRunnerKind({ effectiveIntent: "execute", runtimeIntent: admitted.effectiveRunIntent, runWorkspace: "/Users/michael/Documents/Unity/ProjectM" }), runner,
      "immutable admitted intent owns the runner even if a later projection says execute");
    assert.equal(Object.hasOwn(admitted, "goalCreationAuthorization"), false);
  }
  assert.deepEqual(preRunPatches, [], "heuristic hints and semantic classification cannot approve tools or plans");
  assert.equal(approvals, 0);
  assert.equal(planResumes, 0);
});

test("Phase 5: resolveSkillId resolves human-readable name/slug without hash and load_skill defaults to full-body budget", async () => {
  const catalog = await loadSkillCatalog({
    workspace: "",
    skills: [],
    externalSkillSelections: [{
      entryPath: "/Users/test/.agents/skills/unity-2d-physics/SKILL.md", workspaceScope: null, mode: "auto",
    }],
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
