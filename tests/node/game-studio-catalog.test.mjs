import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";

import ts from "typescript";

const require = createRequire(import.meta.url);
const workspaceRoot = process.cwd();

async function loadCatalogModule() {
  const sourcePath = path.join(workspaceRoot, "src/lib/gameStudio/catalog.ts");
  const source = await fs.readFile(sourcePath, "utf8");
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
    fileName: sourcePath,
  }).outputText;

  const module = { exports: {} };
  const factory = new Function("exports", "module", "require", transpiled);
  factory(module.exports, module, require);
  return module.exports;
}

const {
  resolveLegacyNexusModeKey,
  parseGameStudioSlashCommand,
  parseSetupEngineArgs,
  buildGameStudioUserEnvelope,
  buildWorkflowCommandCatalog,
  buildAgentCatalog,
  getGameStudioSlashCommandSpec,
} = await loadCatalogModule();

test("legacy persona keys migrate into nexus modes", () => {
  assert.equal(resolveLegacyNexusModeKey("role_architect"), "nexus_build");
  assert.equal(resolveLegacyNexusModeKey("role_debugger"), "nexus_build");
  assert.equal(resolveLegacyNexusModeKey("role_uidesigner"), "nexus_create");
  assert.equal(resolveLegacyNexusModeKey("role_dataanalyst"), "nexus_research");
  assert.equal(resolveLegacyNexusModeKey("unknown"), "nexus_general");
});

test("slash parsing normalizes workflow aliases and specialist commands", () => {
  assert.deepEqual(parseGameStudioSlashCommand("/stage"), {
    type: "workflow",
    slug: "project-stage-detect",
    args: "",
    canonicalCommand: "/project-stage-detect",
  });

  assert.deepEqual(parseGameStudioSlashCommand("/start vertical slice"), {
    type: "workflow",
    slug: "start",
    args: "vertical slice",
    canonicalCommand: "/start vertical slice",
  });

  assert.deepEqual(parseGameStudioSlashCommand("/agent creative-director"), {
    type: "agent",
    slug: "creative-director",
    canonicalCommand: "/agent creative-director",
  });

  assert.deepEqual(parseGameStudioSlashCommand("/auto"), {
    type: "auto",
    canonicalCommand: "/auto",
  });
});

test("slash command specs expose local fast mode only for help workflow command", () => {
  const helpSpec = getGameStudioSlashCommandSpec(parseGameStudioSlashCommand("/help"));
  assert.equal(helpSpec?.executionMode, "local_fast");

  const sprintSpec = getGameStudioSlashCommandSpec(parseGameStudioSlashCommand("/sprint-status"));
  assert.equal(sprintSpec?.executionMode, "model_workflow");

  const readinessSpec = getGameStudioSlashCommandSpec(parseGameStudioSlashCommand("/story-readiness"));
  assert.equal(readinessSpec?.executionMode, "model_workflow");

  const scopeSpec = getGameStudioSlashCommandSpec(parseGameStudioSlashCommand("/scope-check"));
  assert.equal(scopeSpec?.executionMode, "model_workflow");

  const modelSpec = getGameStudioSlashCommandSpec(parseGameStudioSlashCommand("/dev-story"));
  assert.equal(modelSpec?.executionMode, "model_workflow");

  const agentSpec = getGameStudioSlashCommandSpec(parseGameStudioSlashCommand("/agent creative-director"));
  assert.equal(agentSpec?.executionMode, "local_fast");

  const autoSpec = getGameStudioSlashCommandSpec(parseGameStudioSlashCommand("/auto"));
  assert.equal(autoSpec?.executionMode, "local_fast");
});

test("setup-engine args parse explicit Unity metadata", () => {
  assert.deepEqual(parseSetupEngineArgs("unity 6.0"), {
    mode: "configure",
    engine: "unity",
    version: "6.0",
    raw: "unity 6.0",
  });
  assert.deepEqual(parseSetupEngineArgs(""), {
    mode: "guided",
    engine: null,
    raw: "",
  });
});

test("game studio user envelope includes protocol entry and selected agent", () => {
  const envelope = buildGameStudioUserEnvelope({
    originalText: "Help me define the first milestone.",
    activeStudioAgent: "creative-director",
    command: {
      type: "workflow",
      slug: "start",
      args: "",
      canonicalCommand: "/start",
    },
    commandPath: ".protocols/game-studio/commands/start.md",
    agentPath: ".protocols/game-studio/agents/creative-director.md",
  });

  assert.match(envelope, /\[GAME_STUDIO_CONTEXT\]/);
  assert.match(envelope, /activeStudioAgent: creative-director/);
  assert.match(envelope, /commandPath: \.protocols\/game-studio\/commands\/start\.md/);
  assert.match(envelope, /agentPath: \.protocols\/game-studio\/agents\/creative-director\.md/);
  assert.match(envelope, /languageInstruction: Reply to the user in 简体中文\. This is a hard output constraint\./);
  assert.match(envelope, /User request:\nHelp me define the first milestone\./);
});

test("game studio user envelope includes Unity engine execution metadata", () => {
  const envelope = buildGameStudioUserEnvelope({
    originalText: "Implement the player controller.",
    activeStudioAgent: "unity-specialist",
    command: null,
    studioConfig: {
      engine: "unity",
      engineLanguage: "C#",
      engineVersion: "6",
      reviewMode: "lean",
      activeStudioAgent: "unity-specialist",
      packVersion: "test",
    },
  });

  assert.match(envelope, /engine: unity/);
  assert.match(envelope, /engineLanguage: C#/);
  assert.match(envelope, /unityExecutionContract:/);
});

test("workflow catalog localizes workflow descriptions and groups by UI language", () => {
  const englishCatalog = buildWorkflowCommandCatalog(
    { start: "First-time onboarding — guides you to the right workflow." },
    "en",
  );
  const chineseCatalog = buildWorkflowCommandCatalog(
    { start: "First-time onboarding — guides you to the right workflow." },
    "zh",
  );

  assert.equal(englishCatalog.find((item) => item.canonicalCommand === "/start")?.group, "Onboarding");
  assert.equal(chineseCatalog.find((item) => item.canonicalCommand === "/start")?.group, "入门引导");
  assert.equal(
    englishCatalog.find((item) => item.canonicalCommand === "/start")?.description,
    "First-time onboarding — guides you to the right workflow.",
  );
  assert.equal(
    chineseCatalog.find((item) => item.canonicalCommand === "/start")?.description,
    "首次引导。先了解你当前所处阶段，再把你带到合适的 Studio 工作流，不预设前提。",
  );
});

test("agent catalog localizes group headings in Chinese UI", () => {
  const chineseAgents = buildAgentCatalog({}, "zh");
  assert.equal(
    chineseAgents.find((item) => item.canonicalCommand === "/agent creative-director")?.group,
    "总监层",
  );
});
