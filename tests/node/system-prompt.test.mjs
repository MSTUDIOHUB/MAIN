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
  if (transpiledModuleCache.has(normalizedPath)) return transpiledModuleCache.get(normalizedPath);
  const source = fsSync.readFileSync(normalizedPath, "utf8");
  const localRequire = createRequire(normalizedPath);
  const transpiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    fileName: normalizedPath,
  }).outputText;
  const module = { exports: {} };
  transpiledModuleCache.set(normalizedPath, module.exports);
  const runtimeRequire = (specifier) => {
    if (specifier.startsWith(".")) {
      const basePath = path.resolve(path.dirname(normalizedPath), specifier);
      for (const candidate of [basePath, `${basePath}.ts`, `${basePath}.tsx`, path.join(basePath, "index.ts")]) {
        if (!fsSync.existsSync(candidate)) continue;
        if (candidate.endsWith(".ts") || candidate.endsWith(".tsx")) return loadTranspiledModuleSync(candidate);
      }
    }
    return localRequire(specifier);
  };
  new Function("exports", "module", "require", transpiled)(module.exports, module, runtimeRequire);
  transpiledModuleCache.set(normalizedPath, module.exports);
  return module.exports;
}

const {
  buildSystemPrompt,
  buildToolProtocolCard,
  detectInstructionLanguage,
  SYSTEM_PROMPT_TARGET_CHARS,
  SYSTEM_PROMPT_MAX_CHARS,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/systemPrompt.ts"));

const tools = [
  {
    type: "function",
    function: {
      name: "read_file",
      description: "READ_SCHEMA_SENTINEL",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path" },
          start_line: { type: "number", description: "First line" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "replace_in_file",
      description: "REPLACE_SCHEMA_SENTINEL",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          search_text: { type: "string" },
          replace_text: { type: "string" },
        },
        required: ["path", "search_text", "replace_text"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_command",
      description: "RUN_SCHEMA_SENTINEL",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string" },
          description: { type: "string" },
          cwd: { type: "string" },
        },
        required: ["command", "description"],
      },
    },
  },
];

function buildPrompt({
  intent = "execute",
  available = tools.map((tool) => tool.function.name),
  native = true,
  toolDefinitions = tools,
  instructions = null,
  mainMode = "main_mode",
  gameStudio,
  priority,
  goal,
  model = "qwen3.6",
} = {}) {
  return buildSystemPrompt(
    [],
    "/tmp/workspace",
    mainMode,
    "[D] src\n[F] package.json",
    [],
    [],
    intent === "plan" ? "plan" : intent === "execute" || intent === "goal" ? "edit" : "chat",
    "zh",
    instructions,
    gameStudio,
    intent,
    "english_core_localized_output",
    available,
    null,
    priority,
    { displayLanguage: "zh", resolvedResponseLanguage: "zh" },
    {
      activeProfile: "local",
      provider: "OMLX",
      model,
      toolProtocol: native ? "native" : "xml",
      nativeToolsEnabled: native,
      toolDefinitions,
    },
    undefined,
    goal,
  );
}

test("generated core prompt is compact and states the actual completion contract", () => {
  const prompt = buildPrompt();
  assert.ok(prompt.length < SYSTEM_PROMPT_TARGET_CHARS, `prompt length ${prompt.length}`);
  assert.match(prompt, /\[ROLE\]/);
  assert.match(prompt, /\[TURN CONTRACT\]/);
  assert.match(prompt, /\[ENVIRONMENT\]/);
  assert.match(prompt, /\[AUTONOMY AND SAFETY\]/);
  assert.match(prompt, /\[COMPLETION\]/);
  assert.match(prompt, /A successful write proves only that exact mutation/);
  assert.match(prompt, /each requested outcome has corresponding artifact\/diff evidence/);
  assert.match(prompt, /reopen the mutation phase for distinct remaining outcomes while each cycle yields new evidence or a materially changed validation result/);
  assert.doesNotMatch(prompt, /reopen mutation once/);
  assert.doesNotMatch(prompt, /Available (?:mutation|validation) tools:/);
});

test("native mode treats provider schemas as the sole tool truth and does not duplicate descriptions", () => {
  const card = buildToolProtocolCard({
    activeProfile: "local",
    provider: "OMLX",
    toolProtocol: "native",
    nativeToolsEnabled: true,
    availableToolNames: tools.map((tool) => tool.function.name),
    toolDefinitions: tools,
    language: "en",
  });
  assert.match(card, /native schemas are the sole source of truth/i);
  assert.doesNotMatch(card, /READ_SCHEMA_SENTINEL|REPLACE_SCHEMA_SENTINEL|RUN_SCHEMA_SENTINEL/);
  assert.doesNotMatch(card, /search_text: string/);
  assert.doesNotMatch(card, /<tool_use>/);
});

test("XML fallback derives exact argument names, optionality, descriptions, and example from schemas", () => {
  const card = buildToolProtocolCard({
    activeProfile: "local",
    provider: "OMLX",
    toolProtocol: "xml",
    nativeToolsEnabled: false,
    availableToolNames: tools.map((tool) => tool.function.name),
    toolDefinitions: tools,
    language: "en",
  });
  assert.match(card, /read_file\(path: string, start_line\?: number\)/);
  assert.match(card, /replace_in_file\(path: string, search_text: string, replace_text: string\)/);
  assert.match(card, /run_command\(command: string, description: string, cwd\?: string\)/);
  assert.match(card, /REPLACE_SCHEMA_SENTINEL/);
  assert.match(card, /<parameter name="path">src\/example\.ts<\/parameter>/);
  assert.doesNotMatch(card, /replace_in_file\(path, search, replace\)/);
});

test("XML fallback uses only the filtered active definitions", () => {
  const card = buildToolProtocolCard({
    activeProfile: "local",
    provider: "OMLX",
    toolProtocol: "xml",
    nativeToolsEnabled: false,
    availableToolNames: ["run_command"],
    toolDefinitions: tools,
    language: "en",
  });
  assert.match(card, /run_command\(/);
  assert.doesNotMatch(card, /read_file\(|replace_in_file\(/);
});

test("auto protocol selection depends on the active capability surface, not provider profile", () => {
  const base = {
    provider: "provider-is-metadata-only",
    toolProtocol: "auto",
    nativeToolsEnabled: false,
    availableToolNames: ["read_file"],
    toolDefinitions: [tools[0]],
    language: "en",
  };
  const local = buildToolProtocolCard({ ...base, activeProfile: "local" });
  const cloud = buildToolProtocolCard({ ...base, activeProfile: "cloud" });

  assert.equal(local, cloud);
  assert.match(local, /protocol=xml-text/);
  assert.match(local, /read_file\(path: string, start_line\?: number\)/);
  assert.doesNotMatch(local, /provider-is-metadata-only|profile=/);
});

test("no-tool turns contain no executable XML example or fake capability", () => {
  const prompt = buildPrompt({ intent: "plan", available: [], native: false, toolDefinitions: [] });
  assert.match(prompt, /available=none/);
  assert.equal(prompt.match(/available=none/g)?.length, 1);
  assert.doesNotMatch(prompt, /<tool_use>/);
  assert.match(prompt, /Do not edit source files or write plan artifacts before approval/);
});

test("plan, web, tabular, game studio, and goal modules are conditional", () => {
  const base = buildPrompt({ intent: "respond", available: ["read_file"], toolDefinitions: [tools[0]] });
  assert.doesNotMatch(base, /\[PLAN\]|\[WEB RESEARCH\]|\[TABULAR\]|\[MAIN GAME STUDIO\]|\[GOAL RUNTIME CONTRACT\]/);

  const plan = buildPrompt({ intent: "plan", available: ["read_file"], toolDefinitions: [tools[0]] });
  assert.match(plan, /\[PLAN\]/);
  assert.match(plan, /versioned PLAN AUTHORING CONTRACT/);
  assert.match(plan, /quality gate checks the criteria disclosed before drafting/i);
  assert.match(plan, /through the transport declared by the latest injected \[PLAN AUTHORING CONTRACT\]/);
  assert.doesNotMatch(plan, /emit exactly one complete `<plan_candidate>`|call `submit_plan_candidate` exactly once/i);

  const webTool = {
    type: "function",
    function: { name: "web_search", description: "Search", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
  };
  assert.match(buildPrompt({ intent: "respond", available: ["web_search"], toolDefinitions: [webTool] }), /\[WEB RESEARCH\]/);

  const tableTool = {
    type: "function",
    function: { name: "query_tabular_document", description: "Query", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
  };
  assert.match(buildPrompt({ intent: "analyze", available: ["query_tabular_document"], toolDefinitions: [tableTool] }), /\[TABULAR\]/);

  const game = buildPrompt({
    intent: "respond",
    mainMode: "game_studio",
    gameStudio: { initialized: true, activeStudioAgentKey: "godot-specialist", studioConfig: { engine: "godot" } },
    priority: { gameStudioMcpFirst: true, engine: "godot", connectedServerNames: ["Godot MCP"] },
  });
  assert.match(game, /\[MAIN GAME STUDIO\]/);
  assert.match(game, /activeStudioAgent: godot-specialist/);
  assert.match(game, /connectedMcpServers: Godot MCP/);

  const goal = buildPrompt({ intent: "goal", goal: { context: "GOAL_CONTRACT_SENTINEL" } });
  assert.match(goal, /\[GOAL \(AUTONOMOUS EXECUTION\)\]/);
  assert.match(goal, /GOAL_CONTRACT_SENTINEL/);
});

test("workspace rules remain injectable without restoring the old global prompt", () => {
  const instructions = {
    layers: [{
      id: "rule:one",
      title: "project.md",
      content: "WORKSPACE_RULE_SENTINEL",
      order: 0,
      source: { id: "s", name: "project", kind: "scoped_rule", path: ".MAIN/project.md", enabled: true, order: 0 },
    }],
    templates: [], sources: [], matchedRules: [], associatedPaths: [], loadedAt: Date.now(), debugSummary: "test",
  };
  const prompt = buildPrompt({ instructions });
  assert.match(prompt, /\[WORKSPACE INSTRUCTIONS\]/);
  assert.match(prompt, /WORKSPACE_RULE_SENTINEL/);
});

test("hard prompt budget truncates oversized external instructions", () => {
  const instructions = {
    layers: [{
      id: "rule:huge",
      title: "huge.md",
      content: "RULE ".repeat(20_000),
      order: 0,
      source: { id: "s", name: "huge", kind: "scoped_rule", path: ".MAIN/huge.md", enabled: true, order: 0 },
    }],
    templates: [], sources: [], matchedRules: [], associatedPaths: [], loadedAt: Date.now(), debugSummary: "test",
  };
  const prompt = buildPrompt({ instructions });
  assert.ok(prompt.length <= SYSTEM_PROMPT_MAX_CHARS);
  assert.match(prompt, /TRUNCATED BY SYSTEM PROMPT BUDGET/);
});

test("response language is independent from English control instructions", () => {
  assert.equal(detectInstructionLanguage("qwen3.6", "zh", "english_core_localized_output", "OMLX"), "en");
  const prompt = buildPrompt();
  assert.match(prompt, /resolvedResponseLanguage=zh/);
  assert.match(prompt, /Write all user-visible prose.*简体中文/);
});

test("local model identity does not alter the guidance contract", () => {
  assert.equal(detectInstructionLanguage("qwen3.6", "en", "model_aware", "OMLX"), "en");
  assert.equal(detectInstructionLanguage("gemma-4", "en", "model_aware", "OMLX"), "en");
  assert.equal(detectInstructionLanguage("qwen3.6", "zh", "model_aware", "OMLX"), "zh");
  assert.equal(detectInstructionLanguage("gemma-4", "zh", "model_aware", "OMLX"), "zh");
  assert.equal(buildPrompt({ model: "qwen3.6" }), buildPrompt({ model: "gemma-4" }));
});

test("systemPrompt no longer contains a second hardcoded tool-description catalog", () => {
  const source = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/systemPrompt.ts"), "utf8");
  assert.doesNotMatch(source, /addToolDescription|TOOL_REQUIRED_ARGUMENTS/);
  assert.doesNotMatch(source, /replace_in_file:.*search, replace/);
});
