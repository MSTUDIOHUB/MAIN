import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import ts from "typescript";

const source = await fs.readFile(path.join(process.cwd(), "src/lib/externalSkillSources.ts"), "utf8");
const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
const module = { exports: {} };
new Function("exports", "module", output)(module.exports, module);
const { normalizeExternalSkillSources: normalize, isExternalSkillSourceEnabled: enabled } = module.exports;
const all = { codex: true, claude: true, gemini: true, custom: true };

test("external sources default to all enabled while malformed values cannot change defaults", () => {
  for (const value of [undefined, null, 42, "codex", [], { codex: "false", claude: 0, gemini: null }]) {
    assert.deepEqual(normalize(value), all);
  }
  assert.deepEqual(normalize({ codex: false, unexpected: false }), { ...all, codex: false });
});

test("source switches normalize independently without mutating the saved record", () => {
  const input = Object.freeze({ codex: true, claude: false, gemini: false, custom: false, extra: "discard" });
  assert.deepEqual(normalize(input), { codex: true, claude: false, gemini: false, custom: false });
  assert.equal(enabled(input, "codex"), true);
  assert.equal(enabled(input, "claude"), false);
  assert.equal(enabled(input, "gemini"), false);
  assert.equal(enabled(input, "custom"), false);
  assert.equal(input.extra, "discard");
});

test("legacy and unknown origins use the Custom source switch", () => {
  for (const source of [undefined, null, "legacy", "antigravity", "CODEX"]) {
    assert.equal(enabled({ custom: false }, source), false);
    assert.equal(enabled({ custom: true }, source), true);
  }
});
