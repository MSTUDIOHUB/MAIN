import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import ts from "typescript";

let catalogInput;
let snapshot = { entries: [] };
const source = ts.transpileModule(fs.readFileSync("src/lib/skillPicker.ts", "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const module = { exports: {} };
new Function("exports", "module", "require", source)(module.exports, module, (name) => {
  if (name === "./agentSkills") return {
    loadSkillCatalog: async (input) => { catalogInput = input; return snapshot; },
    skillReference: (_snapshot, id) => `s:${id.padEnd(8, "0")}`,
  };
  throw new Error(`Unexpected import ${name}`);
});
const picker = module.exports;
const candidate = { id: "review", name: "review", insertText: "$review" };
const entry = (id, name, rest = {}) => ({ id, name, description: "Inspect changes", source: "personal", platformSource: "codex", entryPath: `/skills/${id}/SKILL.md`, allowImplicitInvocation: true, ...rest });

test("dollar completion opens only at a valid token and cursor boundary", () => {
  for (const [value, expected] of [["$", { anchor: 0, query: "" }], ["Use $review", { anchor: 4, query: "review" }], ["第一行\n$场景-check", { anchor: 4, query: "场景-check" }]]) {
    assert.deepEqual(picker.getSkillPickerSession(value, value.length), expected);
  }
  for (const value of ["cost$100", "\\$review", "${HOME}", "$review done", "$review\n", "$$review", "Use $review,", "用$review"]) {
    assert.equal(picker.getSkillPickerSession(value, value.length), null, value);
  }
  for (const cursor of [-1, 100, 1.5]) assert.equal(picker.getSkillPickerSession("$", cursor), null);
});

test("completion preserves surrounding draft and replaces a token remainder at the cursor", () => {
  for (const [value, cursor, expected, nextCursor] of [
    ["Use $rev", 8, "Use $review ", 12],
    ["Use $rev then inspect", 8, "Use $review then inspect", 11],
    ["Use $review then inspect", 8, "Use $review then inspect", 11],
    ["$rev\nnext", 4, "$review\nnext", 7],
    ["$rev.", 4, "$review.", 7],
    ["$rev, next", 4, "$review, next", 7],
    ["$rev。下一步", 4, "$review。下一步", 7],
    ["Use $ab𠮷z then inspect", 7, "Use $review then inspect", 11],
  ]) {
    const session = picker.getSkillPickerSession(value, cursor);
    assert.deepEqual(picker.applySkillPickerSelection(value, cursor, session, candidate), { value: expected, cursor: nextCursor });
  }
  const stale = { anchor: 4, query: "rev" };
  assert.equal(picker.applySkillPickerSelection("Use $other", 10, stale, candidate), null);
  assert.equal(picker.applySkillPickerSelection("Before $rev", 11, stale, candidate), null);
});

test("picker includes admitted manual Skills and inserts unambiguous references for duplicate or unsafe names", () => {
  const entries = [entry("first", "review"), entry("second", "review"), entry("manual", "scene-check", { allowImplicitInvocation: false }),
    entry("punct", "scene.check"), entry("space", "Scene Check"), entry("namedref", "s:abcdef12")];
  const original = JSON.stringify(entries);
  const candidates = picker.buildSkillPickerCandidates({ entries });
  assert.deepEqual(candidates.slice(0, 2).map((item) => item.insertText), ["$s:first000", "$s:second00"]);
  assert.equal(candidates[2].insertText, "$scene-check");
  assert.equal(candidates[2].manualOnly, true);
  assert.ok(candidates.slice(3).every((item) => item.insertText.startsWith("$s:")));
  assert.equal(JSON.stringify(entries), original);
  assert.ok(picker.filterSkillPickerCandidates(candidates, "SCENE").some((item) => item.name === "scene-check"));
  assert.equal(picker.filterSkillPickerCandidates([
    { ...candidates[0], name: "Only description", description: "scene guidance" }, ...candidates,
  ], "scene").at(-1).name, "Only description", "name matches rank before description-only matches");
  assert.equal(picker.filterSkillPickerCandidates(candidates, "Codex").length, entries.length);
  assert.deepEqual(picker.filterSkillPickerCandidates(candidates, "not-found"), []);
});

test("fresh picker loading uses registered Skills and the same external admission inputs as a Run", async () => {
  snapshot = { entries: [entry("manual", "manual", { allowImplicitInvocation: false })] };
  const selections = [{ entryPath: "/skills/manual/SKILL.md", workspaceScope: "/project", mode: "manual" }];
  const sources = { codex: true, claude: false, gemini: false, custom: true };
  const items = await picker.loadSkillPickerCandidates({
    workspace: "/project", skills: [{ id: "panel" }], externalSkillSelections: selections,
    externalSkillSources: sources,
  });
  assert.deepEqual(catalogInput.skills.map((item) => item.id), ["panel"]);
  assert.equal(catalogInput.workspace, "/project");
  assert.deepEqual(catalogInput.externalSkillSelections, selections);
  assert.notEqual(catalogInput.externalSkillSelections[0], selections[0]);
  assert.deepEqual(catalogInput.externalSkillSources, sources);
  assert.notEqual(catalogInput.externalSkillSources, sources);
  assert.equal(items[0].manualOnly, true);
});

test("imported Skills retain their collection name and can be searched by it", () => {
  const items = picker.buildSkillPickerCandidates({ entries: [
    entry("bundle-entry", "scene-review", { source: "package", packageName: "Unity Skills" }),
    entry("native-entry", "native-review"),
  ] });
  assert.equal(items[0].sourceLabel, "技能包");
  assert.equal(items[0].packageName, "Unity Skills");
  assert.equal(items[1].packageName, undefined);
  assert.deepEqual(picker.filterSkillPickerCandidates(items, "Unity Skills").map((item) => item.id), ["bundle-entry"]);
});
