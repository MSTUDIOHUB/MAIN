import test from "node:test";
import assert from "node:assert/strict";
import fsSync from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

import ts from "typescript";

const workspaceRoot = process.cwd();

function loadTranspiledModuleSync(sourcePath) {
  const normalizedPath = path.resolve(sourcePath);
  const source = fsSync.readFileSync(normalizedPath, "utf8");
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
    fileName: normalizedPath,
  }).outputText;

  const module = { exports: {} };
  const localRequire = createRequire(normalizedPath);
  const factory = new Function("exports", "module", "require", transpiled);
  factory(module.exports, module, localRequire);
  return module.exports;
}

const {
  buildRequiredWebResearchQuery,
  buildWebResearchDateContext,
  formatWebResearchLocalDate,
  shouldRequireWebResearchForPrompt,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/webResearchGuard.ts"));

test("requires web research for fresh external version claims", () => {
  assert.equal(
    shouldRequireWebResearchForPrompt("我看到最新的 Unreal Engine 版本已经是 5.7.x 了吧"),
    true,
  );
  assert.equal(
    shouldRequireWebResearchForPrompt("今天沈阳天气怎么样"),
    true,
  );
});

test("does not require web research for local workflow commands without web targets", () => {
  assert.equal(
    shouldRequireWebResearchForPrompt("现在修复版本显示问题"),
    false,
  );
  assert.equal(
    shouldRequireWebResearchForPrompt("请检查工作区里的网络搜索按钮样式"),
    false,
  );
});

test("builds a targeted official Unreal Engine query", () => {
  assert.match(
    buildRequiredWebResearchQuery("UE 已经更新到 5.7.x 了吗", new Date("2026-06-01T08:00:00")),
    /Unreal Engine latest official release version release notes/i,
  );
  assert.match(
    buildRequiredWebResearchQuery("UE 已经更新到 5.7.x 了吗", new Date("2026-06-01T08:00:00")),
    /as of 2026-06-01/i,
  );
});

test("anchors latest Unity searches to the current local date", () => {
  const fixedDate = new Date("2026-06-01T08:00:00");
  assert.equal(formatWebResearchLocalDate(fixedDate), "2026-06-01");
  assert.match(
    buildRequiredWebResearchQuery("搜索最新的 Unity 版本", fixedDate),
    /as of 2026-06-01 Unity latest official release version release notes/i,
  );
  assert.match(
    buildWebResearchDateContext("zh", fixedDate),
    /当前本地日期为 2026-06-01/,
  );
});

test("orchestrator gates forced research behind the web search switch", () => {
  const phaseSource = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/assistantDisplayActionPhase.ts"), "utf8");
  const actionRoutingSource = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/assistantActionRouting.ts"), "utf8");
  const turnPreparationSource = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/turnPreparation.ts"), "utf8");

  assert.match(phaseSource, /resolveAssistantActionRouting\(\{/);
  assert.match(actionRoutingSource, /const shouldInjectRequiredWebResearchCall =\s*\n\s*input\.webSearchEnabled &&/);
  assert.match(actionRoutingSource, /input\.availableToolNames\.has\("web_search"\)/);
  assert.match(actionRoutingSource, /shouldRequireWebResearchForPrompt\(input\.latestUserPromptText\)/);
  assert.match(actionRoutingSource, /WEB_RESEARCH_TOOL_NAMES\.has\(activity\.name \|\| ""\)/);
  assert.match(turnPreparationSource, /formatWebResearchLocalDate\(\)/);
});
