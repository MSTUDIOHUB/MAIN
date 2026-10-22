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
const skillExecutor = loadTs(path.join(workspaceRoot, "src/lib/toolExecutor.ts"));
const toolTargets = loadTs(path.join(workspaceRoot, "src/lib/toolTarget.ts"));
const skillTelemetry = loadTs(path.join(workspaceRoot, "src/store/runtimeV2/executionToolDefinitions.ts"));
const planSkillTools = loadTs(path.join(workspaceRoot, "src/store/runtimeV2/planEvidencePort.ts"));

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

function longSkillCatalog() {
  const base = skillCatalog();
  return Object.freeze({
    ...base,
    entries: Object.freeze([Object.freeze({
      ...base.entries[0],
      content: "# Review workflow\nRead only the task-relevant reference sections.\n\n## Inspect\nInspect the actual result before claiming completion.\n\n## Reference\n" +
        "UNRELATED_REFERENCE_BODY ".repeat(3_000),
    })]),
    explicitSkillIds: Object.freeze([base.entries[0].id]),
  });
}

test("explicit long Skills enter Execute as transparent disclosure rather than an eager reference manual", () => {
  const history = providerHistory.providerHistory({ messages: [] }, {
    get: () => ({ conversationTurns: [{ id: "turn-skill", userPrompt: "Use $review-workflow to inspect the result.", uiVisibility: "visible" }] }),
    context: {
      turnId: "turn-skill", runWorkspace: "/repo", phaseLanguage: "en",
      runtimeRunIntent: "execute", turnInputContextSignals: {},
      skillCatalog: longSkillCatalog(),
      runtimeContextBudget: { contextLimit: 32_000, inputBudget: 24_000, readWindowChars: 8_000 },
    },
  });
  const system = String(history.messages[0]?.content || "");
  assert.ok(system.length < 16_000, "a selected reference manual must not dominate the first decision");
  assert.match(system, /review-workflow/);
  assert.match(system, /Inspect/);
  assert.match(system, /partial|not.fully.loaded|overview/i);
  assert.doesNotMatch(system, /UNRELATED_REFERENCE_BODY/);
});

test("production load_skill returns bounded, versioned disclosure and loads an exact requested section", async () => {
  const catalog = longSkillCatalog();
  const raw = await skillExecutor.executeTool("load_skill", {
    skill_id: catalog.entries[0].id, max_chars: 2_000,
  }, "/repo", "session", { skillCatalog: catalog });
  const overview = JSON.parse(raw);
  assert.equal(overview.disclosure, "overview");
  assert.equal(overview.complete, false);
  assert.equal(overview.version, "cafe1234");
  assert.ok(overview.sections.some((section) => section.title === "Inspect"));
  assert.doesNotMatch(overview.content, /UNRELATED_REFERENCE_BODY/);
  const section = overview.sections.find((entry) => entry.title === "Inspect");
  const loaded = JSON.parse(await skillExecutor.executeTool("load_skill", {
    skill_id: catalog.entries[0].id, section: section.id,
    max_chars: 2_000, expected_version: overview.version,
  }, "/repo", "session", { skillCatalog: catalog }));
  assert.match(loaded.content, /Inspect the actual result before claiming completion/);
  assert.doesNotMatch(loaded.content, /UNRELATED_REFERENCE_BODY/);
  await assert.rejects(() => skillExecutor.executeTool("load_skill", {
    skill_id: catalog.entries[0].id, start_line: 1,
    max_chars: 2_000, expected_version: "stale",
  }, "/repo", "session", { skillCatalog: catalog }), /VERSION/);
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
  assert.equal(definition.function.parameters.properties.skill_id.type, "string");
  assert.equal(definition.function.parameters.properties.skill_id.enum, undefined,
    "the frozen catalog is enforced at execution, without duplicating every long id in the schema");
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
  assert.equal(loadSkill.function.parameters.properties.skill_id.type, "string");
  assert.equal(loadSkill.function.parameters.properties.skill_id.enum, undefined);
});

test("the production Skill executor can browse every metadata page and load a later Skill", async () => {
  const base = skillCatalog();
  const catalog = Object.freeze({
    ...base,
    entries: Object.freeze([
      ...Array.from({ length: 34 }, (_, index) => Object.freeze({
        ...base.entries[0],
        id: `package:unity:skills/workflow-${index}/SKILL.md`,
        name: `workflow-${index}`,
        content: `EXACT_SKILL_${index}`,
      })),
      Object.freeze({ ...base.entries[0], id: "panel:hidden", name: "hidden", allowImplicitInvocation: false }),
    ]),
  });
  const ids = [];
  let cursor;
  do {
    const raw = await skillExecutor.executeTool("load_skill", { operation: "list", limit: "6", cursor }, "/repo", "session", { skillCatalog: catalog });
    const page = JSON.parse(raw);
    assert.equal(page.type, "skill.catalog");
    assert.equal(page.total, 34);
    assert.ok(page.entries.every((entry) => !("content" in entry)), "listing must not load or execute bodies");
    ids.push(...page.entries.map((entry) => entry.id));
    cursor = page.nextCursor;
  } while (cursor);
  assert.equal(new Set(ids).size, 34);
  const loaded = JSON.parse(await skillExecutor.executeTool("load_skill", { skill_id: ids.at(-1) }, "/repo", "session", { skillCatalog: catalog }));
  assert.equal(loaded.content, "EXACT_SKILL_33");
  await assert.rejects(() => skillExecutor.executeTool("load_skill", { skill_id: "panel:hidden" }, "/repo", "session", { skillCatalog: catalog }), /SKILL_NOT_AUTHORIZED/);
  await assert.rejects(() => skillExecutor.executeTool("load_skill", { operation: "list" }, "/repo"), /SKILL_CATALOG_UNAVAILABLE/);
  await assert.rejects(() => skillExecutor.executeTool("load_skill", { operation: "execute", skill_id: ids[0] }, "/repo", "session", { skillCatalog: catalog }), /SKILL_OPERATION_INVALID/);
});

test("metadata discovery has its own display target and never logs a Skill body activation", () => {
  assert.match(toolTargets.getToolTarget("load_skill", { operation: "list", query: "tilemap" }), /tilemap/);
  const events = [];
  skillTelemetry.logRuntimeV2SkillLoad({ toolName: "load_skill", succeeded: true, rawOutput: JSON.stringify({ type: "skill.catalog", total: 34, entries: [] }), skillId: "", turnId: "turn", runId: "run", logStoreEvent: (type, payload) => events.push({ type, payload }) });
  assert.equal(events.some((entry) => entry.type === "runtime_v2_skill_loaded"), false);
  assert.equal(events[0]?.type, "runtime_v2_skill_catalog_listed");
});

test("partial Skill windows retain their canonical identity without claiming a complete activation", () => {
  const events = [];
  skillTelemetry.logRuntimeV2SkillLoad({
    toolName: "load_skill", succeeded: true,
    rawOutput: JSON.stringify({ type: "skill.loaded", id: "package:canonical", version: "12345678", complete: false, disclosure: "window", returnedRange: { startLine: 20, endLine: 30 } }),
    skillId: "s:short", turnId: "turn", runId: "run",
    logStoreEvent: (type, payload) => events.push({ type, payload }),
  });
  assert.equal(events[0].type, "runtime_v2_skill_disclosed");
  assert.equal(events[0].payload.skillId, "package:canonical");
  assert.equal(events[0].payload.complete, false);
  assert.equal(events[0].payload.returnedRange.startLine, 20);
});

test("Plan discovery records Skill metadata as tool guidance without claiming a body was loaded", async () => {
  const settled = [];
  const evidence = [];
  const messages = [];
  await planSkillTools.executeReadOnlyPlanTool({
    context: { skillCatalog: skillCatalog(), runWorkspace: "/repo", runSessionKey: "session" },
    ledger: {
      snapshot: () => null,
      schedule: async () => ({ idempotencyKey: "skill-page" }),
      settleCommand: async (receipt) => settled.push(receipt),
      recordSoftSignal: async () => {},
    },
    run: { runId: "run", turnId: "turn" },
    call: { id: "list-page", name: "load_skill", arguments: { operation: "list" } },
    messages, evidence, evidenceContents: new Map(), parallelReadCount: 1, logStoreEvent: () => {},
  });
  assert.equal(settled[0].status, "succeeded");
  assert.equal(settled[0].evidence[0].kind, "tool");
  assert.match(evidence[0].statement, /目录/);
  assert.doesNotMatch(evidence[0].statement, /已加载 Skill/);
  assert.equal(messages.length, 1);
  assert.doesNotMatch(messages[0].content, /EXECUTE_SKILL_BODY_SENTINEL/);
});
