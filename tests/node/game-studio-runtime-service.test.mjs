import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";

import ts from "typescript";

const workspaceRoot = process.cwd();
const sourcePath = path.join(workspaceRoot, "src/lib/gameStudio/GameStudioRuntimeService.ts");

async function loadRuntimeService(packMock) {
  const source = await fs.readFile(sourcePath, "utf8");
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
    fileName: sourcePath,
  }).outputText;

  const module = { exports: {} };
  const localRequire = createRequire(sourcePath);
  const runtimeRequire = (specifier) => {
    if (specifier === "./pack") return packMock;
    if (specifier === "../runIntent") {
      return { looksLikePlanContinuationOrApprovalInput: () => false };
    }
    return localRequire(specifier);
  };
  const factory = new Function("exports", "module", "require", transpiled);
  factory(module.exports, module, runtimeRequire);
  return module.exports;
}

function createPackMock() {
  const calls = [];
  const config = {
    engine: "unity",
    engineLanguage: "C#",
    reviewMode: "lean",
    activeStudioAgent: "unity-specialist",
    packVersion: "test",
  };
  return {
    calls,
    config,
    ensureGameStudioWorkspaceInitialized: async (agent) => {
      calls.push(["ensure", agent]);
      return { ...config, activeStudioAgent: agent };
    },
    setGameStudioEngineConfig: async (params) => {
      calls.push(["engine", params]);
      return { ...config, ...params };
    },
    loadGameStudioConfig: async () => config,
    removeGameStudioWorkspaceAssets: async () => {
      calls.push(["remove"]);
    },
    buildGameStudioEnvelopeForTurn: (params) => {
      calls.push(["envelope", params]);
      return `[GAME_STUDIO_CONTEXT]\ncommand: ${params.command?.canonicalCommand || "none"}`;
    },
    resolveGameStudioHelpTarget: (requested) => ({
      ok: true,
      slug: requested || "help",
      requested: requested || "",
    }),
    hasBundledGameStudioLocalizedCommandMarkdown: () => true,
    formatGameStudioCommandDocForDisplay: (slug, language) => `${language}:${slug}`,
    formatGameStudioMissingCommandDoc: () => "missing",
  };
}

test("game studio runtime service owns initialization and engine configuration", async () => {
  const pack = createPackMock();
  const { GameStudioRuntimeService } = await loadRuntimeService(pack);
  const service = new GameStudioRuntimeService();

  const initialized = await service.ensureInitialized("producer");
  assert.equal(initialized.activeStudioAgent, "producer");

  const configured = await service.configureEngine({
    engine: "godot",
    version: "4.6",
    activeStudioAgent: "godot-specialist",
  });
  assert.equal(configured.engine, "godot");
  assert.deepEqual(pack.calls.slice(0, 2), [
    ["ensure", "producer"],
    ["engine", { engine: "godot", version: "4.6", activeStudioAgent: "godot-specialist" }],
  ]);
});

test("game studio runtime service resolves local slash commands and envelopes", async () => {
  const pack = createPackMock();
  const { GameStudioRuntimeService } = await loadRuntimeService(pack);
  const service = new GameStudioRuntimeService();

  assert.deepEqual(service.resolveSlashCommand({
    command: { type: "agent", slug: "producer", canonicalCommand: "/agent producer" },
    language: "en",
  }), { kind: "agent", slug: "producer" });
  assert.deepEqual(service.resolveSlashCommand({
    command: { type: "auto", canonicalCommand: "/auto" },
    language: "en",
  }), { kind: "auto" });
  assert.deepEqual(service.resolveSlashCommand({
    command: { type: "workflow", slug: "help", args: "setup-engine", canonicalCommand: "/help setup-engine" },
    language: "zh",
  }), {
    kind: "local_markdown",
    content: "zh:setup-engine",
    systemVariant: "game_studio_local_markdown",
  });

  const envelope = service.buildTurnEnvelope({
    originalText: "/start",
    nexusMode: "nexus_game_studio",
    activeStudioAgent: "producer",
    command: { type: "workflow", slug: "start", args: "", canonicalCommand: "/start" },
  });
  assert.match(envelope, /\[GAME_STUDIO_CONTEXT\]/);
  assert.match(envelope, /command: \/start/);
});

test("game studio runtime service returns explicit and ambiguous mode-switch decisions", async () => {
  const pack = createPackMock();
  const { GameStudioRuntimeService } = await loadRuntimeService(pack);
  const service = new GameStudioRuntimeService();

  const explicit = service.resolveModeSwitchDecision({
    input: "Implement this Unity controller",
    language: "en",
    signal: {
      shouldSuggest: true,
      engineStatus: "explicit",
      engine: "unity",
      projectEvidence: ["Assets + ProjectSettings"],
      semanticEvidence: ["Unity"],
    },
  });
  assert.equal(explicit.kind, "mode_switch");
  assert.equal(explicit.target, "unity");
  assert.equal(explicit.options[0].id, "switch_game_studio");

  const ambiguous = service.resolveModeSwitchDecision({
    input: "Design a combat system",
    language: "zh",
    signal: {
      shouldSuggest: true,
      engineStatus: "ambiguous",
      engine: null,
      projectEvidence: [],
      semanticEvidence: ["战斗系统"],
    },
  });
  assert.equal(ambiguous.target, "engine");
  assert.deepEqual(
    ambiguous.options.slice(0, 3).map((option) => option.id),
    ["switch_game_studio_unity", "switch_game_studio_godot", "switch_game_studio_unreal"],
  );
});
