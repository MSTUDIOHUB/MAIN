import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";

const moduleCache = new Map();

function loadTs(sourcePath) {
  const normalized = path.resolve(sourcePath);
  if (moduleCache.has(normalized)) return moduleCache.get(normalized);
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
  moduleCache.set(normalized, loaded.exports);
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
  moduleCache.set(normalized, loaded.exports);
  return loaded.exports;
}

test("Plan repair preserves full receipts and decisions before the shared budget is applied", () => {
  const { synthesisPlanTranscript } = loadTs("src/store/runtimeV2/planModelProtocol.ts");
  const full = "Skill reference\n" + "source text ".repeat(3_000);
  const messages = [
    { role: "assistant", content: "", tool_calls: [{ id: "skill", type: "function", function: { name: "load_skill", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "skill", content: full },
    { role: "user", content: "Use a Play Mode check." },
  ];
  const request = synthesisPlanTranscript({ messages, evidence: [], evidenceContents: new Map(),
    submissionRepairPending: true, compactRecovery: false, transport: "native_tool", canAskPlanQuestions: true });
  assert.equal(messages[1].content, full);
  assert.equal(request[1].tool_call_id, "skill");
  assert.equal(request[1].content, full);
  assert.deepEqual(request[2], messages[2]);
  assert.match(request.at(-1).content, /Authorized read-only tools remain available/);
});

const protocol = loadTs(
  path.join(process.cwd(), "src/store/runtimeV2/planModelProtocol.ts"),
);
const workPlan = loadTs(
  path.join(process.cwd(), "src/lib/runtime-v2/workPlan.ts"),
);

const evidence = [{
  id: "E1",
  target: "src/main.js",
  version: "sha-main",
  statement: "The active-file owner is implemented here.",
}];

test("plan intent analysis receives the collaboration method before decomposition", () => {
  const messages = protocol.providerPlanMessages({
    turn: { userPrompt: "Repair the multi-file open flow." },
    context: {
      phaseLanguage: "en",
      runWorkspace: "/tmp/project",
      turnInputContextSignals: { subagentPreference: "preferred" },
    },
    overview: "src/components/editor.js\nsrc/components/toolbar.js",
  });
  const system = String(messages[0]?.content || "");
  assert.equal(messages[0]?.role, "system",
    "the initial planning request receives the method before the user's decomposition begins");
  assert.match(system, /\[COLLABORATION METHOD\]/);
  assert.match(system, /requested deliverable and depth/);
  assert.match(system, /independent result only when it benefits.*justify coordination/);
  assert.match(system, /Delegation remains optional/);
  assert.doesNotMatch(system, /as many.*children|prioritize.*spawn_subagent/);
  assert.equal(messages[1]?.content, "Repair the multi-file open flow.",
    "collaboration guidance must preserve the original requested outcome");
  assert.match(system, /evidence-backed solution/);
  assert.match(system, /every exact non-overlapping file target/);
  assert.match(system, /Do not grant a directory/);
  assert.match(system, /waits only when a child result becomes a dependency/);
});

test("required Plan collaboration does not render optional guidance", () => {
  const messages = protocol.providerPlanMessages({
    turn: { userPrompt: "Use a planning child before submitting." },
    context: {
      phaseLanguage: "en",
      runWorkspace: "/tmp/project",
      turnInputContextSignals: {
        subagentPreference: "preferred",
        subagentRequirement: "required",
      },
    },
    overview: "src/main.py",
  });
  const system = String(messages[0]?.content || "");
  assert.match(system, /\[REQUIRED COLLABORATION\]/);
  assert.match(system, /hard admission condition/);
  assert.doesNotMatch(system, /not a mandatory lifecycle stage/);
  assert.doesNotMatch(system, /For a simple or linear task, proceed directly/);
});

test("Plan discovers Skill metadata without preloading the body and offers load_skill", () => {
  const skillCatalog = {
    entries: [{
      id: "panel:review",
      name: "review-workflow",
      description: "Use for structured change review.",
      source: "panel",
      content: "PLAN_SKILL_BODY_SENTINEL",
      entryPath: null,
      basePath: null,
      version: "1234abcd",
      allowImplicitInvocation: true,
      supportingFiles: [],
    }],
    explicitSkillIds: [],
    warnings: [],
    loadedAt: 1,
  };
  const messages = protocol.providerPlanMessages({
    turn: { userPrompt: "Review the current change." },
    context: {
      phaseLanguage: "en",
      runWorkspace: "/tmp/project",
      turnInputContextSignals: {},
      skillCatalog,
    },
    overview: "src/main.ts",
  });
  const system = String(messages[0]?.content || "");
  assert.match(system, /review-workflow/);
  assert.doesNotMatch(system, /PLAN_SKILL_BODY_SENTINEL/);

  const loadSkill = protocol.planModelTools({ skillCatalog }).find(
    (tool) => tool.function.name === "load_skill",
  );
  assert.ok(loadSkill);
  assert.equal(loadSkill.function.parameters.properties.skill_id.type, "string");
  assert.equal(loadSkill.function.parameters.properties.skill_id.enum, undefined,
    "Plan shares compact references and validates the admitted identity at execution");
});

test("Plan web tools follow captured network authority rather than a later live toggle", () => {
  const context = { runSessionKey: "plan-network", networkRead: { enabled: true, provider: "bing" } };
  const discovery = loadTs(path.join(process.cwd(), "src/lib/toolSearch.ts"));
  discovery.unlockToolsForSession(context.runSessionKey, ["web_search", "web_fetch"]);
  const names = (value) => value.map((tool) => tool.function.name);
  assert.ok(names(protocol.planModelTools(context, { webSearchEnabled: false })).includes("web_search"));
  assert.ok(names(protocol.planModelTools(context, { webSearchEnabled: false })).includes("web_fetch"));
  assert.equal(names(protocol.planModelTools({ ...context, networkRead: undefined }, { webSearchEnabled: true })).includes("web_search"), false);
});

test("Plan exposes only bounded read-only collaboration tools from live capacity", () => {
  const withoutCollaboration = protocol.selectPlanModelTools({
    submissionStage: false,
    collaborationAllowed: false,
    remainingSubagentCapacity: 1,
    activeSubagentCount: 0,
  });
  assert.equal(
    withoutCollaboration.some((tool) =>
      tool.function.name === "spawn_subagent" ||
      tool.function.name === "wait_subagents"
    ),
    false,
  );

  const withCapacity = protocol.selectPlanModelTools({
    submissionStage: false,
    collaborationAllowed: true,
    remainingSubagentCapacity: 1,
    activeSubagentCount: 0,
  });
  const spawn = withCapacity.find((tool) =>
    tool.function.name === "spawn_subagent"
  );
  assert.ok(spawn);
  assert.deepEqual(
    spawn.function.parameters.properties.task_kind.enum,
    ["explore", "review", "validate"],
  );
  assert.deepEqual(
    spawn.function.parameters.properties.access_mode.enum,
    ["read"],
  );
  assert.equal(
    spawn.function.parameters.properties.implementation_operation,
    undefined,
  );
  assert.equal(
    spawn.function.parameters.properties.implementation_plan,
    undefined,
  );
  assert.equal(
    withCapacity.some((tool) => tool.function.name === "wait_subagents"),
    false,
  );

  const withActiveChild = protocol.selectPlanModelTools({
    submissionStage: false,
    collaborationAllowed: true,
    remainingSubagentCapacity: 0,
    activeSubagentCount: 1,
  });
  assert.equal(
    withActiveChild.some((tool) => tool.function.name === "spawn_subagent"),
    false,
  );
  assert.equal(
    withActiveChild.some((tool) => tool.function.name === "wait_subagents"),
    true,
  );

  assert.deepEqual(
    protocol.selectPlanModelTools({
      submissionStage: true,
      collaborationAllowed: true,
      remainingSubagentCapacity: 1,
      activeSubagentCount: 0,
    }).map((tool) => tool.function.name),
    withCapacity.map((tool) => tool.function.name),
  );
  const repairTools = protocol.selectPlanModelTools({
    submissionStage: true,
    submissionRepairPending: true,
    collaborationAllowed: false,
    remainingSubagentCapacity: 0,
    activeSubagentCount: 0,
  }).map(tool => tool.function.name);
  assert.ok(repairTools.includes("read_file"), "a rejected submission must retain authorized safe reads");
  assert.ok(repairTools.includes("submit_runtime_v2_work_plan"));
  assert.equal(repairTools.includes("write_file"), false);
});

test("typed required collaboration hard-admits spawn until the Plan requirement is met", () => {
  const readFile = protocol.PLAN_MODEL_TOOLS.find((tool) =>
    tool.function.name === "read_file"
  );
  assert.ok(readFile);
  const baseTools = [readFile, protocol.SUBMIT_WORK_PLAN_TOOL];
  const names = (tools) => tools.map((tool) => tool.function.name);

  for (const submissionStage of [false, true]) assert.deepEqual(
    names(protocol.selectPlanModelTools({
      submissionStage,
      collaborationAllowed: true,
      collaborationRequired: true,
      collaborationRequirementMet: false,
      remainingSubagentCapacity: 1,
      activeSubagentCount: 0,
      baseTools,
    })),
    ["spawn_subagent"],
  );

  assert.deepEqual(
    names(protocol.selectPlanModelTools({
      submissionStage: false,
      collaborationAllowed: true,
      collaborationRequired: true,
      collaborationRequirementMet: true,
      remainingSubagentCapacity: 0,
      activeSubagentCount: 1,
      baseTools,
    })),
    ["read_file", "wait_subagents", "submit_runtime_v2_work_plan"],
  );

  assert.deepEqual(
    names(protocol.selectPlanModelTools({
      submissionStage: false,
      collaborationAllowed: true,
      collaborationRequired: false,
      collaborationRequirementMet: false,
      remainingSubagentCapacity: 1,
      activeSubagentCount: 0,
      baseTools,
    })),
    ["read_file", "spawn_subagent", "submit_runtime_v2_work_plan"],
    "preferred/optional collaboration must not impersonate the typed required gate",
  );
});

test("Plan submission schema offers optional typed dependency and validation coverage edges", () => {
  const properties = protocol.SUBMIT_WORK_PLAN_TOOL.function.parameters.properties;
  const change = properties.changes.items;
  const validation = properties.validations.items;
  assert.deepEqual(change.required, ["targets", "change"]);
  assert.deepEqual(
    change.properties.dependsOn.items,
    { type: "integer" },
  );
  assert.deepEqual(validation.required, ["expectedOutcome"]);
  assert.deepEqual(
    validation.properties.stepIndexes.items,
    { type: "integer" },
  );

  const messages = protocol.providerPlanMessages({
    turn: {
      userPrompt:
        "Implement snake.py, then test_snake.py; run compileall and unittest.",
    },
    context: {
      phaseLanguage: "en",
      runWorkspace: "/tmp/project",
      turnInputContextSignals: {},
    },
    overview: "snake.py\nREADME.md",
  });
  const system = String(messages[0]?.content || "");
  assert.match(system, /submit_runtime_v2_work_plan/i);
});

test("Plan submission schema requires the validation list consumed by the admitted criteria gate", () => {
  const tool = protocol.SUBMIT_WORK_PLAN_TOOL.function;
  const schema = tool.parameters;
  assert.ok(schema.required.includes("validations"));
  assert.equal(schema.properties.validations.minItems, 1);
  assert.doesNotMatch(tool.description, /可选的验证方式/);
  const validation = schema.properties.validations.items;
  assert.ok(validation.properties.kind.enum.includes("assertion"), "a Plan need not authorize future shell execution");
  assert.equal(validation.required.includes("command"), false);
  assert.equal(validation.required.includes("required"), false, "the compiler owns the existing default");
  assert.equal(validation.required.includes("criterionIds"), false, "omitted criteria already map to admitted IDs");
});

function singletonSubmission(overrides = {}) {
  return {
    planMarkdown: "Use the retained evidence to update the active-file owner.",
    changes: {
      title: "Update active-file ownership",
      operation: "modify",
      targets: ["src/main.js"],
      change: "Keep one active-file identity through open and save.",
      expectedOutcome: "Open and save use the same file identity.",
      basis: ["E1"],
      dependsOn: [],
    },
    validations: {
      kind: "finite_command",
      command: "npm run build",
      expectedOutcome: "The finite build exits successfully.",
      required: true,
      stepIndexes: [0],
    },
    ...overrides,
  };
}

test("plan protocol safely normalizes unambiguous singleton array fields", () => {
  const compiled = protocol.workPlanDraftFromSubmission(
    singletonSubmission(),
    evidence,
    "Repair active-file ownership.",
  );

  assert.equal(compiled.draft.steps.length, 1);
  assert.equal(compiled.draft.validations.length, 1);
  assert.equal(compiled.draft.steps[0].targets[0], "src/main.js");
  assert.equal(compiled.draft.validations[0].command, "npm run build");
  assert.equal(compiled.normalized, true);
  assert.deepEqual(compiled.normalizationReasons, [
    "changes:singleton_object_to_array",
    "validations:singleton_object_to_array",
  ]);
});

test("plan protocol normalizes singleton objects encoded as JSON strings", () => {
  const submission = singletonSubmission();
  const compiled = protocol.workPlanDraftFromSubmission({
    ...submission,
    changes: JSON.stringify(submission.changes),
    validations: `${JSON.stringify(submission.validations)}\nI have submitted the plan.`,
  }, evidence, "Repair active-file ownership.");

  assert.equal(compiled.draft.steps.length, 1);
  assert.equal(compiled.draft.validations.length, 1);
  assert.deepEqual(compiled.normalizationReasons, [
    "changes:singleton_object_json_to_array",
    "validations:singleton_object_json_to_array",
  ]);
});

test("plan protocol still rejects ambiguous scalar array fields", () => {
  assert.throws(
    () => protocol.workPlanDraftFromSubmission(
      singletonSubmission({ changes: 42 }),
      evidence,
      "Repair active-file ownership.",
    ),
    /changes must be an array or JSON array string/,
  );
});

function graphSubmission(overrides = {}) {
  return {
    planMarkdown: "Create the implementation, then its tests, and validate both.",
    changes: [{
      title: "Create implementation",
      operation: "create",
      targets: ["snake.py"],
      change: "Create the game implementation.",
      expectedOutcome: "The implementation exists.",
      dependsOn: [],
    }, {
      title: "Create tests",
      operation: "create",
      targets: ["test_snake.py"],
      change: "Create deterministic logic tests.",
      expectedOutcome: "The implementation has automated coverage.",
      dependsOn: [0],
    }],
    validations: [{
      kind: "finite_command",
      command: "python3 -m unittest -v",
      expectedOutcome: "The tests pass.",
      required: true,
      stepIndexes: [0, 1],
    }],
    ...overrides,
  };
}

test("typed Plan ingress defaults omitted dependency and validation coverage edges", () => {
  const missingDependency = graphSubmission();
  delete missingDependency.changes[1].dependsOn;
  const autoDependency = protocol.workPlanDraftFromSubmission(
    missingDependency,
    [],
    "Create a tested Snake game.",
  );
  assert.deepEqual(autoDependency.draft.steps[1].dependsOn, []);

  const missingCoverage = graphSubmission();
  delete missingCoverage.validations[0].stepIndexes;
  const autoCoverage = protocol.workPlanDraftFromSubmission(
    missingCoverage,
    [],
    "Create a tested Snake game.",
  );
  assert.deepEqual(autoCoverage.draft.validations[0].stepIndexes, [0, 1]);
});

test("typed Plan ingress preserves invalid zero-based indexes for the core validator", () => {
  const candidate = graphSubmission();
  candidate.changes[1].dependsOn = [1];
  candidate.validations[0].stepIndexes = [0, 2];
  const compiled = protocol.workPlanDraftFromSubmission(
    candidate,
    [],
    "Create a tested Snake game.",
  );

  assert.deepEqual(compiled.draft.steps[1].dependsOn, [1]);
  assert.deepEqual(compiled.draft.validations[0].stepIndexes, [0, 2]);
  assert.throws(() => workPlan.sealWorkPlanV1({
    draft: compiled.draft, evidence: [], createdAt: 1,
  }), /Dependencies must refer to earlier steps|Validation references an unknown step/);
});

test("typed Plan ingress does not invent validation coverage", () => {
  const candidate = graphSubmission();
  candidate.validations[0].stepIndexes = [];
  const compiled = protocol.workPlanDraftFromSubmission(
    candidate,
    [],
    "Create a tested Snake game.",
  );

  assert.deepEqual(compiled.draft.validations[0].stepIndexes, []);
});

test("typed Plan ingress requires exact admitted criterion mappings", () => {
  const evidence = [];
  const candidate = {
    planMarkdown: "Create the bounded fixture and verify it.",
    changes: [{
      operation: "create",
      targets: ["fixture.py"],
      change: "Create the fixture.",
      expectedOutcome: "The fixture exists.",
      dependsOn: [],
    }],
    validations: [{
      kind: "finite_command",
      command: "python3 -m compileall -q .",
      expectedOutcome: "The fixture compiles.",
      required: true,
      stepIndexes: [0],
    }],
  };
  const autoMapped = protocol.workPlanDraftFromSubmission(
    candidate,
    evidence,
    "Create the fixture.",
    ["criterion-user-objective"],
  );
  assert.deepEqual(autoMapped.draft.steps[0].criterionIds, ["criterion-user-objective"]);
  assert.deepEqual(autoMapped.draft.validations[0].criterionIds, ["criterion-user-objective"]);
  candidate.changes[0].criterionIds = ["invented-criterion"];
  candidate.validations[0].criterionIds = ["criterion-user-objective"];
  const fallbackMapped = protocol.workPlanDraftFromSubmission(
    candidate,
    evidence,
    "Create the fixture.",
    ["criterion-user-objective"],
  );
  assert.deepEqual(fallbackMapped.draft.steps[0].criterionIds, ["criterion-user-objective"]);
  candidate.changes[0].criterionIds = ["criterion-user-objective"];
  const compiled = protocol.workPlanDraftFromSubmission(
    candidate,
    evidence,
    "Create the fixture.",
    ["criterion-user-objective"],
  );
  assert.deepEqual(compiled.draft.steps[0].criterionIds, [
    "criterion-user-objective",
  ]);
  assert.deepEqual(compiled.draft.validations[0].criterionIds, [
    "criterion-user-objective",
  ]);
});
