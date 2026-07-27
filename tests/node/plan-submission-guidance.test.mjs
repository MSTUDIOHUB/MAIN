import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";

const workspaceRoot = process.cwd();

function loadTs(sourcePath) {
  const source = fs.readFileSync(sourcePath, "utf8");
  const transpiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    fileName: sourcePath,
  }).outputText;
  const module = { exports: {} };
  const localRequire = createRequire(sourcePath);
  new Function("exports", "module", "require", transpiled)(
    module.exports,
    module,
    localRequire,
  );
  return module.exports;
}

const { buildPlanSubmissionGuidance } = loadTs(path.join(
  workspaceRoot,
  "src/lib/planSubmissionGuidance.ts",
));

test("shared Plan recovery guidance delegates wire format to the latest authoring contract", () => {
  const en = buildPlanSubmissionGuidance("en");
  const zh = buildPlanSubmissionGuidance("zh");

  assert.match(en, /latest injected `\[PLAN AUTHORING CONTRACT\]`/);
  assert.match(en, /declared active submission transport/);
  assert.match(zh, /最新注入的 `\[PLAN AUTHORING CONTRACT\]`/);
  assert.match(zh, /声明的当前提交入口/);
  assert.doesNotMatch(`${en}\n${zh}`, /<plan_candidate>|native tool|XML/i);
});

test("shared Plan recovery modules do not independently hard-code the envelope transport", () => {
  const recoveryModules = [
    "src/lib/runtime-v2/controller.ts",
    "src/lib/runtime-v2/decision.ts",
    "src/lib/runtime-v2/recovery.ts",
    "src/lib/planRuntime.ts",
    "src/store/submitPromptContext.ts",
  ];

  for (const relativePath of recoveryModules) {
    const source = fs.readFileSync(path.join(workspaceRoot, relativePath), "utf8");
    assert.doesNotMatch(
      source,
      /<plan_candidate>/,
      `${relativePath} must follow the injected transport instead of selecting the envelope`,
    );
  }
  assert.equal(fs.existsSync(path.join(workspaceRoot, "src/lib/orchestrator.ts")), false);
  const legacyDirectory = path.join(workspaceRoot, "src/lib/orchestrator");
  assert.equal(
    fs.existsSync(legacyDirectory) && fs.readdirSync(legacyDirectory, {
        recursive: true,
        withFileTypes: true,
      }).some((entry) => entry.isFile()),
    false,
  );
});
