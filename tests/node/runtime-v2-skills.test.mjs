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
const agentSkillTool = loadTs(path.join(workspaceRoot, "src/lib/agentSkillExecutor.ts"));
const agentSkills = loadTs(path.join(workspaceRoot, "src/lib/agentSkills.ts"));
const toolTargets = loadTs(path.join(workspaceRoot, "src/lib/toolTarget.ts"));
const skillTelemetry = loadTs(path.join(workspaceRoot, "src/store/runtimeV2/executionToolDefinitions.ts"));
const planSkillTools = loadTs(path.join(workspaceRoot, "src/store/runtimeV2/planEvidencePort.ts"));

function globalSkillCatalog() {
  const packageId = "a".repeat(64);
  const entry = { ...skillCatalog().entries[0], id: `global:${packageId}:skills/review/SKILL.md`, source: "package",
    entryPath: `main-skill://${packageId}/skills/review/SKILL.md`, basePath: `main-skill://${packageId}/skills/review`,
    globalPackageId: packageId, globalResourceBase: "skills/review", globalResourcePaths: Object.freeze(["skills/review/SKILL.md", "skills/review/references/check.md"]),
  };
  return Object.freeze({ ...skillCatalog(), entries: Object.freeze([Object.freeze(entry)]) });
}

async function withReadTargetDocuments(action) {
  const ipc = loadTs(path.join(workspaceRoot, "src/lib/ipc.ts"));
  const original = ipc.readGlobalSkillPackageFile;
  const body = `# Body\r\nPreface\r\n## Middle\r\n${"body🙂".repeat(70)}\r\n## Last\r\nBODY END\r\n`;
  let resource = `# Reference\r\nIntro\r\n## Middle\r\n${"reference🙂".repeat(70)}\r\n## Last\r\nREFERENCE END\r\n`;
  const base = globalSkillCatalog();
  const entry = Object.freeze({ ...base.entries[0], content: body });
  // A non-first entry catches references accidentally rebound in a one-entry resource snapshot.
  const catalog = Object.freeze({ ...base, entries: Object.freeze([skillCatalog().entries[0], entry]) });
  const nativeReads = [];
  ipc.readGlobalSkillPackageFile = async (...args) => { nativeReads.push(args); return resource; };
  const read = async (args) => JSON.parse(await agentSkillTool.executeAgentSkillTool(catalog, args));
  try { await action({ body, entry, catalog, read, nativeReads, resource: () => resource, setResource: (text) => { resource = text; } }); }
  finally { ipc.readGlobalSkillPackageFile = original; }
}

test("load_skill receipts expose a reusable document-local readTarget for body and resource", async () => {
  await withReadTargetDocuments(async ({ body, entry, catalog, read, resource }) => {
    const loadedBody = await read({ skill_id: entry.id });
    const loadedResource = await read({ skill_id: loadedBody.ref, resource: "references/check.md" });
    assert.deepEqual(loadedBody.readTarget, { skill_id: loadedBody.ref, expected_version: loadedBody.version });
    assert.equal(Object.hasOwn(loadedBody.readTarget, "resource"), false);
    assert.deepEqual(loadedResource.readTarget, {
      skill_id: loadedBody.ref, expected_version: loadedResource.version, resource: "references/check.md",
    });
    assert.notEqual(loadedResource.version, loadedBody.version);
    assert.equal((await read(loadedBody.readTarget)).content, body);
    assert.equal((await read(loadedResource.readTarget)).content, resource());
    assert.match(loadedResource.effect, /resource_guidance_no_additional_permissions/);
    assert.match(loadedBody.hostGuidance, /readTarget/);
    assert.ok(Object.isFrozen(agentSkills.loadSkillContent(catalog, entry.id).readTarget));
    assert.ok(Object.isFrozen((await agentSkills.loadSkillResourceContent(catalog, entry.id, "references/check.md")).readTarget));
  });
});

test("readTarget plus independently selected line, character and index coordinates stays lossless", async () => {
  await withReadTargetDocuments(async ({ body, entry, read, resource }) => {
    for (const target of [{ skill_id: entry.id }, { skill_id: entry.id, resource: "references/check.md" }]) {
      let page = await read({ ...target, start_line: 1, max_chars: 37 });
      let reconstructed = page.content;
      let pages = 1;
      while (page.nextStartLine !== null) {
        page = await read({ ...page.readTarget, start_line: page.nextStartLine, start_char: page.nextStartChar, max_chars: 37 });
        reconstructed += page.content;
        assert.ok(++pages < 50, "the exact document continuation must make progress");
      }
      assert.equal(reconstructed, target.resource ? resource() : body);
      let index = await read({ ...page.readTarget, max_chars: 140 });
      const sections = [...index.sections];
      while (index.nextSectionCursor) {
        index = await read({ ...index.readTarget, section_cursor: index.nextSectionCursor, max_chars: 140 });
        assert.equal(index.content, "");
        sections.push(...index.sections);
      }
      const last = sections.find((section) => section.startLine === 5);
      assert.ok(last);
      const selected = await read({ ...index.readTarget, section: last.id, max_chars: 140 });
      assert.equal(selected.content, target.resource ? "## Last\r\nREFERENCE END\r\n" : "## Last\r\nBODY END\r\n");
    }
  });
});

test("cross-document versions remain rejected and identify the actual body or resource address", async () => {
  await withReadTargetDocuments(async ({ entry, read, setResource }) => {
    const body = await read({ skill_id: entry.id });
    const reference = await read({ skill_id: body.ref, resource: "references/check.md" });
    await assert.rejects(() => read({ skill_id: body.ref, expected_version: reference.version }), (error) => {
      assert.match(error.message, /SKILL_VERSION_MISMATCH/);
      assert.match(error.message, /Skill body/);
      assert.ok(error.message.includes(entry.entryPath));
      return true;
    });
    await assert.rejects(() => read({ skill_id: reference.ref, resource: "references/check.md", expected_version: body.version }), (error) => {
      assert.match(error.message, /SKILL_VERSION_MISMATCH/);
      assert.match(error.message, /Skill resource/);
      assert.ok(error.message.includes("references/check.md"));
      assert.ok(error.message.includes(reference.entryPath));
      return true;
    });
    assert.equal((await read(body.readTarget)).version, body.version, "a mistaken resource target does not change the captured body revision");
    setResource("CHANGED REFERENCE");
    await assert.rejects(() => read(reference.readTarget), /SKILL_VERSION_MISMATCH/);
  });
});

test("load_skill schema distinguishes first resource reads from exact-document continuations", () => {
  const definition = agentSkills.buildLoadSkillToolDefinition(globalSkillCatalog());
  const properties = definition.function.parameters.properties;
  assert.match(properties.expected_version.description, /first resource read.*omit/i);
  assert.match(properties.expected_version.description, /readTarget/);
  assert.match(properties.resource.description, /every continuation/i);
  assert.match(definition.function.description, /readTarget/);
});

test("resource readTarget keeps empty documents exact and cannot bypass admitted ids or paths", async () => {
  await withReadTargetDocuments(async ({ entry, catalog, read, nativeReads, setResource }) => {
    setResource("");
    const empty = await read({ skill_id: entry.id, resource: "references/check.md" });
    assert.deepEqual(empty.readTarget, { skill_id: empty.ref, expected_version: empty.version, resource: "references/check.md" });
    assert.equal((await read(empty.readTarget)).content, "");
    assert.equal(empty.complete, true);
    assert.deepEqual(empty.returnedRange, { startLine: 0, endLine: 0, startChar: 0, endChar: 0 });
    const readsBeforeRejection = nativeReads.length;
    for (const path of ["", "../other", "/outside", "main-skill://other/ref", "references//check.md", "missing.md"]) {
      await assert.rejects(() => read({ ...empty.readTarget, resource: path }), /SKILL_RESOURCE/);
    }
    await assert.rejects(() => read({ ...empty.readTarget, skill_id: "unknown" }), /SKILL_NOT_AUTHORIZED/);
    const replaced = Object.freeze({ ...catalog, entries: Object.freeze([Object.freeze({ ...entry, id: entry.id.replace("a".repeat(64), "b".repeat(64)) })]) });
    await assert.rejects(() => agentSkillTool.executeAgentSkillTool(replaced, empty.readTarget), /SKILL_NOT_AUTHORIZED/);
    assert.equal(nativeReads.length, readsBeforeRejection, "a returned target is a locator, not fresh authority");
  });
});

test("production load_skill reads global resource guidance without invoking project IO or executing content", async () => {
  const ipc = loadTs(path.join(workspaceRoot, "src/lib/ipc.ts"));
  const original = ipc.readGlobalSkillPackageFile;
  const reads = [];
  ipc.readGlobalSkillPackageFile = async (...args) => { reads.push(args); return "REFERENCE\r\nDo not execute this text.\r\n"; };
  const catalog = globalSkillCatalog();
  const id = catalog.entries[0].id;
  try {
    const raw = await skillExecutor.executeTool("load_skill", { skill_id: id, resource: "references/check.md", max_chars: 400 }, "/actual-project", "session", { skillCatalog: catalog });
    const result = JSON.parse(raw);
    assert.equal(result.type, "skill.resource");
    assert.equal(result.id, id);
    assert.equal(result.resource, "references/check.md");
    assert.equal(result.content, "REFERENCE\r\nDo not execute this text.\r\n");
    assert.match(result.effect, /guidance.*no_additional_permissions/);
    assert.deepEqual(reads, [["a".repeat(64), "skills/review/references/check.md"]]);
    assert.notEqual(toolTargets.getToolTarget("load_skill", { skill_id: id, resource: "references/check.md" }), toolTargets.getToolTarget("load_skill", { skill_id: id }));
    const logs = [];
    skillTelemetry.logRuntimeV2SkillLoad({ toolName: "load_skill", succeeded: true, rawOutput: raw, skillId: id, turnId: "turn", runId: "run", logStoreEvent: (type, payload) => logs.push({ type, payload }) });
    assert.equal(logs[0].type, "runtime_v2_skill_resource_read");
    assert.equal(logs[0].payload.resource, "references/check.md");
    await assert.rejects(() => skillExecutor.executeTool("load_skill", { skill_id: id, resource: "../secret" }, "/actual-project", "session", { skillCatalog: catalog }), /RESOURCE/);
    await assert.rejects(() => skillExecutor.executeTool("load_skill", { skill_id: id, resource: "references/check.md", expected_version: "stale" }, "/actual-project", "session", { skillCatalog: catalog }), /VERSION/);
  } finally { ipc.readGlobalSkillPackageFile = original; }
});

test("Plan global reference receipt remains guidance and cannot stand for loading the full Skill or source", async () => {
  const ipc = loadTs(path.join(workspaceRoot, "src/lib/ipc.ts"));
  const original = ipc.readGlobalSkillPackageFile;
  ipc.readGlobalSkillPackageFile = async () => "REFERENCE";
  const settled = [], evidence = [], messages = [];
  try {
    await planSkillTools.executeReadOnlyPlanTool({
      context: { skillCatalog: globalSkillCatalog(), runWorkspace: "/repo", runSessionKey: "session" },
      ledger: { snapshot: () => null, schedule: async () => ({ idempotencyKey: "resource" }), settleCommand: async (event) => settled.push(event), recordSoftSignal: async () => {} },
      run: { runId: "run", turnId: "turn" },
      call: { id: "resource", name: "load_skill", arguments: { skill_id: globalSkillCatalog().entries[0].id, resource: "references/check.md" } },
      messages, evidence, evidenceContents: new Map(), parallelReadCount: 1, logStoreEvent() {},
    });
    assert.equal(settled[0].status, "succeeded");
    assert.equal(settled[0].evidence[0].kind, "tool");
    assert.match(evidence[0].statement, /参考/);
    assert.doesNotMatch(evidence[0].statement, /已加载 Skill/);
  } finally { ipc.readGlobalSkillPackageFile = original; }
});

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
