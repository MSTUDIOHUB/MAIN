import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

import ts from "typescript";

const workspaceRoot = process.cwd();
const require = createRequire(import.meta.url);

async function loadCommandDocsModule() {
  const sourcePath = path.join(workspaceRoot, "src/lib/gameStudio/commandDocs.ts");
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
  formatGameStudioCommandDocForDisplay,
  parseGameStudioCommandMarkdown,
  rewriteGameStudioCommandDocDisplayPaths,
} = await loadCommandDocsModule();

test("command markdown formatter hides frontmatter and rewrites upstream paths", async () => {
  const raw = await fs.readFile(
    path.join(workspaceRoot, "src/gameStudioPack/workspace-files/protocols/game-studio/commands/help.md"),
    "utf8",
  );
  const formatted = formatGameStudioCommandDocForDisplay({
    slug: "help",
    rawMarkdown: raw,
    language: "zh",
  });

  assert.match(formatted, /^# \/help/);
  assert.match(formatted, /- 命令：`\/help`/);
  assert.doesNotMatch(formatted, /^---/);
  assert.doesNotMatch(formatted, /fast path|不走模型|Active specialist|Workspace initialized/i);
  assert.match(formatted, /\.protocols\/game-studio\/docs\/workflow-catalog\.yaml/);
  assert.match(formatted, /\.protocols\/game-studio\/commands\/\*\.md/);
});

test("path display rewrite covers .claude docs, templates, agents, and skills", () => {
  const rewritten = rewriteGameStudioCommandDocDisplayPaths(
    [
      ".claude/docs/workflow-catalog.yaml",
      ".claude/docs/templates/story.md",
      ".claude/agents/producer.md",
      ".claude/skills/dev-story/SKILL.md",
    ].join("\n"),
  );

  assert.match(rewritten, /\.protocols\/game-studio\/docs\/workflow-catalog\.yaml/);
  assert.match(rewritten, /\.MAIN\/templates\/game-studio\/story\.md/);
  assert.match(rewritten, /\.protocols\/game-studio\/agents\/producer\.md/);
  assert.match(rewritten, /\.protocols\/game-studio\/commands\/dev-story\.md/);
});

test("all bundled command docs have zh static cache files", async () => {
  const sourceDir = path.join(workspaceRoot, "src/gameStudioPack/workspace-files/protocols/game-studio/commands");
  const zhDir = path.join(workspaceRoot, "src/gameStudioPack/localized/zh/commands");
  const sourceFiles = (await fs.readdir(sourceDir)).filter((entry) => entry.endsWith(".md")).sort();
  const zhFiles = (await fs.readdir(zhDir)).filter((entry) => entry.endsWith(".md")).sort();

  assert.equal(sourceFiles.length, 72);
  assert.deepEqual(zhFiles, sourceFiles);

  const helpZh = await fs.readFile(path.join(zhDir, "help.md"), "utf8");
  const parsed = parseGameStudioCommandMarkdown(helpZh);
  assert.match(parsed.frontmatter.description || "", /下一步/);
  assert.equal(fsSync.existsSync(path.join(zhDir, "dev-story.md")), true);
});
