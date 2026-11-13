import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "./tsModuleLoader.mjs";

const load = createTsModuleLoader();
const { planDocumentMessages, planDocumentTools } = load("src/store/runtimeV2/planDocumentProtocol.ts");
const { providerPlanMessages, selectPlanModelTools } = load("src/store/runtimeV2/planModelProtocol.ts");

test("the Plan interview tells the model how to use preferred read-only collaboration", () => {
  const context = {
    runWorkspace: "/fixture",
    runSessionKey: "/fixture:1",
    phaseLanguage: "en",
    planPurpose: "plan",
    turnInputContextSignals: { subagentPreference: "preferred", subagentRequirement: "optional" },
  };
  const [system] = planDocumentMessages(context, "Investigate the behavior and plan a fix.");
  assert.match(system.content, /explicitly prefers collaboration/);
  assert.match(system.content, /bounded read-only/);
  assert.match(system.content, /independent.+overlap/);
  assert.doesNotMatch(system.content, /implementation child|stages one transaction|explicitly requires delegation/);

  const names = selectPlanModelTools({
    submissionStage: false,
    collaborationAllowed: true,
    remainingSubagentCapacity: 1,
    activeSubagentCount: 0,
    baseTools: planDocumentTools(context),
  }).map(tool => tool.function.name);
  assert.ok(names.includes("spawn_subagent"));
  assert.ok(names.includes("read_file"));
  assert.ok(names.includes("ask_plan_questions"));
});

test("Plan exposes relevant Skill metadata and exact explicit selections before and after choosing implementation", () => {
  const entry = (name, description, content, allowImplicitInvocation = true) => ({
    id: `panel:${name}`, name, description, content, allowImplicitInvocation,
    source: "panel", version: "1234abcd", entryPath: null, basePath: null, supportingFiles: [],
  });
  const entries = [
    entry("spreadsheet-format", "Format a workbook.", "UNRELATED_SKILL_BODY"),
    entry("unity-cli", "Control Unity and run PlayMode tests.", "IMPLICIT_SKILL_BODY"),
    entry("explicit-review", "Verify review output.", "EXPLICIT_SKILL_BODY", false),
    entry("unselected-internal", "Internal workflow.", "PRIVATE_SKILL_BODY", false),
  ];
  const context = {
    runWorkspace: "/fixture", phaseLanguage: "zh", planPurpose: "plan",
    skillCatalog: { entries, explicitSkillIds: ["panel:explicit-review"], warnings: [], loadedAt: 1 },
  };
  const objective = "请用Unity的 PlayMode 测试核实游戏行为。";
  const systems = [
    planDocumentMessages(context, objective)[0].content,
    providerPlanMessages({ turn: { userPrompt: objective }, context })[0].content,
  ];
  for (const system of systems) {
    assert.match(system, /\[AVAILABLE SKILLS\]/);
    assert.match(system, /unity-cli[\s\S]*spreadsheet-format/, "relevant metadata precedes unrelated entries");
    assert.match(system, /load_skill.*relative to the Skill/);
    assert.match(system, /\[EXPLICITLY ACTIVATED SKILL[^\n]+\][\s\S]*EXPLICIT_SKILL_BODY/);
    assert.doesNotMatch(system, /IMPLICIT_SKILL_BODY|UNRELATED_SKILL_BODY|unselected-internal|PRIVATE_SKILL_BODY/);
  }
  const tools = planDocumentTools(context);
  assert.ok(tools.some(tool => tool.function.name === "load_skill"));
  assert.ok(!tools.some(tool => ["run_command", "execute_command", "write_file"].includes(tool.function.name)));
});
