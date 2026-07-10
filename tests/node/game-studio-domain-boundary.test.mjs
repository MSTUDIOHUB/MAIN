import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";

const workspaceRoot = process.cwd();

async function walkFiles(root) {
  const files = [];
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    const absolutePath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...await walkFiles(absolutePath));
    } else if (entry.isFile()) {
      files.push(absolutePath);
    }
  }
  return files;
}

test("game studio implementation lives behind canonical domain paths", async () => {
  const canonicalFiles = [
    "catalog.ts",
    "commandDocs.ts",
    "onboarding.ts",
    "pack.ts",
    "detection.ts",
    "GameStudioRuntimeService.ts",
  ];
  for (const file of canonicalFiles) {
    const stat = await fs.stat(path.join(workspaceRoot, "src/lib/gameStudio", file));
    assert.equal(stat.isFile(), true, `${file} should be owned by src/lib/gameStudio`);
  }

  const compatibilityShims = new Map([
    ["gameStudioCatalog.ts", 'export * from "./gameStudio/catalog";'],
    ["gameStudioCommandDocs.ts", 'export * from "./gameStudio/commandDocs";'],
    ["gameStudioOnboarding.ts", 'export * from "./gameStudio/onboarding";'],
    ["gameStudioPack.ts", 'export * from "./gameStudio/pack";'],
    ["gameDevelopmentIntent.ts", 'export * from "./gameStudio/detection";'],
  ]);
  for (const [file, expected] of compatibilityShims) {
    const content = await fs.readFile(path.join(workspaceRoot, "src/lib", file), "utf8");
    assert.equal(content.trim(), expected, `${file} should remain a thin compatibility shim`);
  }

  const sourceFiles = (await walkFiles(path.join(workspaceRoot, "src")))
    .filter((file) => /\.tsx?$/.test(file))
    .filter((file) => !compatibilityShims.has(path.basename(file)));
  const legacyImportPattern = /from\s+["'][^"']*(?:gameStudioCatalog|gameStudioCommandDocs|gameStudioOnboarding|gameStudioPack|gameDevelopmentIntent)["']/;
  for (const file of sourceFiles) {
    const content = await fs.readFile(file, "utf8");
    assert.doesNotMatch(content, legacyImportPattern, `${path.relative(workspaceRoot, file)} uses a legacy Game Studio import`);
  }

  const packSource = await fs.readFile(path.join(workspaceRoot, "src/lib/gameStudio/pack.ts"), "utf8");
  assert.match(packSource, /\.\.\/\.\.\/gameStudioPack\/workspace-files\/\*\*\/\*/);
  assert.match(packSource, /\.\.\/\.\.\/gameStudioPack\/localized\/zh\/commands\/\*\.md/);
  assert.doesNotMatch(packSource, /gameStudio\/pack\/workspace-files/);
});

test("installable game studio assets expose MAIN paths and tool semantics", async () => {
  const packRoot = path.join(workspaceRoot, "src/gameStudioPack/workspace-files");
  const localizedRoot = path.join(workspaceRoot, "src/gameStudioPack/localized");
  const files = [
    ...await walkFiles(packRoot),
    ...await walkFiles(localizedRoot),
  ].filter((file) => path.basename(file) !== "LICENSE");
  const unsupportedPattern = /\.claude(?:\/|\b)|CLAUDE\.md|AskUserQuestion|WebSearch|WebFetch|\bTask tool\b|\bTask calls?\b|subagents?|sub-agents?|^allowed-tools:/im;
  const unsupportedRuntimePattern = /user-input request|multi-tab|two-tab|<user_options>\(|\$ARGUMENTS|gate applys|director applys|apply before applying|batch up to .*questions|questions in one call|<user_options> with questions|\b(?:Opus|Sonnet|Haiku)\b/i;
  const unsupportedFrontmatterPattern = /^(?:model|tools|maxTurns|memory|disallowedTools|agent|context|isolation):/m;
  const fakeAgentExecutionPattern = /launch independent (?:agents|tasks)|spawn (?:all|`[a-z0-9-]+`)|parallel specialist reviews|specialist profiles? in parallel|agents? simultaneously/i;
  const corruptedGameDomainPattern = /apply timing|applying\/destroying actors|event-based applying|applied\/deapplyed objects|actor.*applied successfully/i;
  const fakeReviewWritePattern = /written by (?:separate )?specialist review|review passes? (?:write|writes|written)|orchestrator does not write files directly|all file writes.*(?:delegated|handled through)/i;

  for (const file of files) {
    const content = await fs.readFile(file, "utf8");
    if (path.basename(file) !== "skill-test.md") {
      assert.doesNotMatch(content, unsupportedPattern, `${path.relative(workspaceRoot, file)} exposes a legacy path or unsupported tool model`);
    }
    assert.doesNotMatch(content, unsupportedRuntimePattern, `${path.relative(workspaceRoot, file)} exposes unsupported MAIN runtime metadata`);
    assert.doesNotMatch(content, corruptedGameDomainPattern, `${path.relative(workspaceRoot, file)} corrupts game-domain spawn semantics`);
    assert.doesNotMatch(content, fakeReviewWritePattern, `${path.relative(workspaceRoot, file)} assigns writes to a non-process specialist profile`);
    const frontmatter = content.match(/^---\s*\n([\s\S]*?)\n---/)?.[1] || "";
    assert.doesNotMatch(frontmatter, unsupportedFrontmatterPattern, `${path.relative(workspaceRoot, file)} exposes unsupported MAIN frontmatter`);
    if (!file.endsWith("/SKILL.md")) {
      assert.doesNotMatch(content, fakeAgentExecutionPattern, `${path.relative(workspaceRoot, file)} claims unsupported multi-model agent execution`);
    }
  }

  const commandFiles = (await walkFiles(path.join(packRoot, "protocols/game-studio/commands")))
    .filter((file) => file.endsWith(".md"));
  for (const file of commandFiles) {
    const content = await fs.readFile(file, "utf8");
    assert.doesNotMatch(content, /\b(?:Glob|Grep|Bash)\b/, `${path.relative(workspaceRoot, file)} names an upstream tool instead of a MAIN tool`);
  }

  await assert.rejects(fs.stat(path.join(packRoot, "protocols/game-studio/UPSTREAM_README.md")));
  await assert.rejects(fs.stat(path.join(packRoot, "protocols/game-studio/docs/settings-local-template.md")));

  const quickStart = await fs.readFile(path.join(packRoot, "protocols/game-studio/docs/quick-start.md"), "utf8");
  assert.match(quickStart, /commands\/\s+-- 72 slash workflow command documents/);
  assert.match(quickStart, /agents\/\s+-- 49 specialist profile documents/);
  assert.doesNotMatch(quickStart, /settings-local-template|settings\.json|skills\/\s+--|hooks\/\s+-- 12/);
});

test("game studio command guard covers both MAIN command tool names", () => {
  const hookPath = path.join(
    workspaceRoot,
    "src/gameStudioPack/workspace-files/main/game-studio/hooks/pretool-command-guard.sh",
  );

  for (const toolName of ["run_command", "execute_command"]) {
    const result = spawnSync("sh", [hookPath], {
      cwd: workspaceRoot,
      encoding: "utf8",
      input: JSON.stringify({ toolName, command: "git reset --hard HEAD" }),
    });
    assert.equal(result.status, 0);
    assert.match(result.stdout, /"decision":"block"/);
  }

  const readResult = spawnSync("sh", [hookPath], {
    cwd: workspaceRoot,
    encoding: "utf8",
    input: JSON.stringify({ toolName: "read_file", path: "README.md" }),
  });
  assert.equal(readResult.status, 0);
  assert.equal(readResult.stdout, "");
});
