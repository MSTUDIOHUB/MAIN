import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";

const workspaceRoot = process.cwd();
const cache = new Map();

function loadTs(sourcePath) {
  const normalized = path.resolve(sourcePath);
  if (cache.has(normalized)) return cache.get(normalized);
  const source = fs.readFileSync(normalized, "utf8");
  const localRequire = createRequire(normalized);
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
    fileName: normalized,
  }).outputText;
  const loaded = { exports: {} };
  cache.set(normalized, loaded.exports);
  const runtimeRequire = (specifier) => {
    if (specifier.startsWith(".")) {
      const base = path.resolve(path.dirname(normalized), specifier);
      for (const candidate of [base, `${base}.ts`, path.join(base, "index.ts")]) {
        if (fs.existsSync(candidate) && candidate.endsWith(".ts")) {
          return loadTs(candidate);
        }
      }
    }
    return localRequire(specifier);
  };
  new Function("exports", "module", "require", output)(
    loaded.exports,
    loaded,
    runtimeRequire,
  );
  cache.set(normalized, loaded.exports);
  return loaded.exports;
}

const providerHistory = loadTs(path.join(
  workspaceRoot,
  "src/store/runtimeV2/executionProviderHistory.ts",
));
const authorization = loadTs(path.join(
  workspaceRoot,
  "src/store/runtimeV2/executionAuthorizationContext.ts",
));
const subagentPolicy = loadTs(path.join(
  workspaceRoot,
  "src/store/runtimeV2/executionSubagentPolicy.ts",
));

function skillCatalog() {
  return Object.freeze({
    entries: Object.freeze([Object.freeze({
      id: "panel:review",
      name: "review-workflow",
      description: "Use for structured code review.",
      source: "panel",
      content: "EXECUTE_SKILL_BODY_SENTINEL",
      entryPath: null,
      basePath: null,
      version: "cafe1234",
      allowImplicitInvocation: true,
      supportingFiles: Object.freeze([]),
    })]),
    explicitSkillIds: Object.freeze([]),
    warnings: Object.freeze([]),
    loadedAt: 1,
  });
}

test("Runtime v2 Execute provider receives Skill metadata but not the body before load_skill", () => {
  const live = { messages: [] };
  const history = providerHistory.providerHistory(live, {
    get: () => ({
      conversationTurns: [{
        id: "turn-skill",
        userPrompt: "Review this change.",
        uiVisibility: "visible",
      }],
    }),
    context: {
      turnId: "turn-skill",
      runWorkspace: "/repo",
      phaseLanguage: "en",
      runtimeRunIntent: "execute",
      turnInputContextSignals: {},
      skillCatalog: skillCatalog(),
      runtimeContextBudget: { contextLimit: 32_000 },
    },
  });

  const system = String(history.messages[0]?.content || "");
  assert.match(system, /\[AVAILABLE SKILLS\]/);
  assert.match(system, /review-workflow/);
  assert.match(system, /load_skill/);
  assert.doesNotMatch(system, /EXECUTE_SKILL_BODY_SENTINEL/);
});

test("Runtime v2 authorization freezes load_skill as a read-only built-in for the admitted ids", () => {
  const frozen = authorization.createRuntimeV2ExecutionAuthorization(
    {
      config: {},
      skills: [{
        id: "legacy-tool",
        name: "ghost_tool",
        desc: "No executor binding.",
        content: "workflow only",
        active: true,
        type: "tool",
        toolParameters: '{"type":"object"}',
      }],
    },
    skillCatalog(),
  );
  const definition = frozen.toolDefinitions.find(
    (tool) => tool.function.name === "load_skill",
  );
  assert.ok(definition);
  assert.deepEqual(
    definition.function.parameters.properties.skill_id.enum,
    ["panel:review"],
  );
  const resolution = frozen.toolCatalog.lookup("load_skill");
  assert.equal(resolution.status, "resolved");
  assert.equal(resolution.entry.source, "built_in");
  assert.equal(frozen.capabilityRegistry.tools.load_skill.risk, "read_only");
  assert.equal(
    frozen.toolDefinitions.some((tool) => tool.function.name === "ghost_tool"),
    false,
    "unbound legacy Tool Skills must not be advertised as executable tools",
  );
});

test("Runtime v2 children inherit the same frozen Skill ids", () => {
  const tools = subagentPolicy.runtimeV2ChildTools({
    taskKind: "explore",
    accessMode: "read",
  }, skillCatalog());
  const loadSkill = tools.find((tool) => tool.function.name === "load_skill");
  assert.ok(loadSkill);
  assert.deepEqual(
    loadSkill.function.parameters.properties.skill_id.enum,
    ["panel:review"],
  );
});
