import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import ts from "typescript";

const source = await fs.readFile(path.join(process.cwd(), "src/lib/externalSkillSelections.ts"), "utf8");
const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
const module = { exports: {} };
new Function("exports", "module", output)(module.exports, module);
const { normalizeExternalSkillSelections: normalize, resolveExternalSkillMode: resolve } = module.exports;
const entryPath = "/home/.codex/skills/review/SKILL.md";
const selection = (mode = "auto", workspaceScope = null, path = entryPath) => ({ entryPath: path, workspaceScope, mode });

test("external selections preserve references only and reject malformed persisted identities", () => {
  for (const value of [null, undefined, "auto", {}, 42]) assert.deepEqual(normalize(value), []);
  assert.deepEqual(normalize([
    null, false, selection("unknown"), selection("auto", "relative"),
    selection("auto", null, "relative/SKILL.md"), selection("auto", null, "~/skills/SKILL.md"),
    selection("auto", null, "/home/../secret/SKILL.md"), selection("auto", null, "/home/./review/SKILL.md"),
    selection("auto", null, "https://example.com/SKILL.md"), selection("auto", null, "/home/x\0/SKILL.md"),
    { entryPath, mode: "auto" },
  ]), []);
  const original = { ...selection(), content: "do not persist copied instructions", active: true };
  assert.deepEqual(normalize([original]), [selection()]);
  assert.equal(original.content, "do not persist copied instructions");
});

test("external selection upsert is last-wins per canonical entry and exact scope", () => {
  assert.deepEqual(normalize([
    selection("auto"), selection("manual", "/repo"), selection("disabled"), selection("auto", "/repo"),
  ]), [selection("disabled"), selection("auto", "/repo")]);
  assert.deepEqual(normalize([selection("auto", "/repo/"), selection("manual", "/repo")]), [selection("manual", "/repo")]);
});

test("project admission overrides global mode without spilling into neighboring workspaces", () => {
  const selections = [selection("disabled", "/repo/A"), selection("auto")];
  assert.equal(resolve(selections, entryPath, "/repo/A"), "disabled");
  assert.equal(resolve(selections, entryPath, "/repo/A/nested"), "auto");
  assert.equal(resolve(selections, entryPath, "/repo/AB"), "auto");
  assert.equal(resolve(selections, entryPath, "/repo/B"), "auto");
  assert.equal(resolve(selections, entryPath, ""), "auto");
  assert.equal(resolve([selection("manual", "/repo/A")], entryPath, "/repo/B"), undefined);
  assert.equal(resolve([selection("manual", "/repo/A")], entryPath, ""), undefined);
});

test("discovery and explicit invocation never invent an absent entry selection", () => {
  assert.equal(resolve(undefined, entryPath, "/repo"), undefined);
  assert.equal(resolve([], entryPath, "/repo"), undefined);
  assert.equal(resolve([selection()], "/other/review/SKILL.md", "/repo"), undefined);
  assert.equal(resolve([selection()], "review/SKILL.md", "/repo"), undefined);
  assert.equal(resolve([selection()], entryPath.toUpperCase(), "/repo"), undefined);
});

test("Windows absolute identities normalize separators without treating relative drive paths as absolute", () => {
  const record = selection("manual", "C:\\Projects\\Game\\", "C:\\Users\\test\\skills\\review\\SKILL.md");
  const normalized = normalize([record]);
  assert.deepEqual(normalized, [{ entryPath: "C:/Users/test/skills/review/SKILL.md", workspaceScope: "C:/Projects/Game", mode: "manual" }]);
  assert.equal(resolve(normalized, record.entryPath, "C:/Projects/Game"), "manual");
  assert.deepEqual(normalize([selection("auto", null, "C:relative/SKILL.md")]), []);
  assert.equal(resolve(normalize([selection("auto", null, "\\\\server\\share\\skills\\review\\SKILL.md")]), "//server/share/skills/review/SKILL.md", ""), "auto");
});
