import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";

import ts from "typescript";

const require = createRequire(import.meta.url);
const workspaceRoot = process.cwd();

async function loadContextTrimModule() {
  const sourcePath = path.join(workspaceRoot, "src/lib/contextTrim.ts");
  const source = await fs.readFile(sourcePath, "utf8");
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
    fileName: sourcePath,
  }).outputText;

  const module = { exports: {} };
  const factory = new Function("exports", "module", "require", transpiled);
  factory(module.exports, module, require);
  return module.exports;
}

const {
  computeContextBudgets,
  manageContext,
} = await loadContextTrimModule();

test("computeContextBudgets reserves a smaller, capped output budget for long contexts", () => {
  const budgets16k = computeContextBudgets(16384);
  const budgets128k = computeContextBudgets(131072);

  assert.equal(budgets16k.outputBudget, 3276);
  assert.equal(budgets16k.inputBudget, 13108);
  assert.equal(budgets128k.outputBudget, 4096);
  assert.equal(budgets128k.inputBudget, 126976);
});

test("manageContext leaves long tool output untouched while under the proactive trigger", () => {
  const messages = [
    { role: "system", content: "system prompt" },
    { role: "tool", content: "A".repeat(12000) },
  ];

  const result = manageContext(messages, 32768, undefined, 100, 2000);

  assert.equal(result.droppedCount, 0);
  assert.equal(result.changed, false);
  assert.equal(result.tokenReduction, 0);
  assert.equal(result.messages.length, messages.length);
  assert.equal(result.messages[1].content, messages[1].content);
});

test("manageContext can persist token savings once the proactive trigger is crossed", () => {
  const messages = [
    { role: "system", content: "system prompt" },
    { role: "tool", content: "A".repeat(80000) },
  ];

  const result = manageContext(messages, 32768, undefined, 100, 2000);

  assert.equal(result.droppedCount, 0);
  assert.equal(result.changed, true);
  assert.ok(result.tokenReduction > 0);
  assert.equal(result.messages.length, messages.length);
  assert.notEqual(result.messages[1].content, messages[1].content);
});

test("manageContext trims down to a lower hysteresis target once the trigger is crossed", () => {
  const messages = [
    { role: "system", content: "system prompt" },
    ...Array.from({ length: 12 }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      content: `message-${index}-` + "B".repeat(900),
    })),
  ];

  const result = manageContext(messages, 4096, undefined, 4000, 4000);

  assert.equal(result.changed, true);
  assert.ok(result.droppedCount > 0);
  assert.ok(result.tokenReduction > 0);
  assert.ok(result.tokenCountAfter <= result.budgets.proactiveTargetBudget);
});

test("manageContext force mode trims even after microcompaction leaves context over provider window", () => {
  const messages = [
    { role: "system", content: "system prompt" },
    ...Array.from({ length: 24 }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      content: `message-${index}-` + "C".repeat(3200),
    })),
  ];

  const result = manageContext(messages, 32768, 2048, 4000, 4000, true);

  assert.equal(result.changed, true);
  assert.ok(result.droppedCount > 0);
  assert.ok(result.tokenCountAfter <= result.budgets.proactiveTargetBudget);
});
