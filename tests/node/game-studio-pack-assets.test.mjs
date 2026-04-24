import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

const workspaceRoot = process.cwd();

async function countFiles(relativeDir) {
  const root = path.join(workspaceRoot, relativeDir);
  const entries = await fs.readdir(root, { withFileTypes: true });
  return entries.filter((entry) => entry.isFile()).length;
}

test("bundled game studio pack contains mapped upstream assets", async () => {
  assert.equal(
    await countFiles("src/gameStudioPack/workspace-files/protocols/game-studio/agents"),
    49,
  );
  assert.equal(
    await countFiles("src/gameStudioPack/workspace-files/protocols/game-studio/commands"),
    72,
  );
  assert.equal(
    await countFiles("src/gameStudioPack/workspace-files/main/rules/game-studio"),
    11,
  );

  const criticalFiles = [
    "src/gameStudioPack/workspace-files/protocols/game-studio/SKILL.md",
    "src/gameStudioPack/workspace-files/protocols/game-studio/README.md",
    "src/gameStudioPack/workspace-files/protocols/game-studio/commands/start.md",
    "src/gameStudioPack/workspace-files/protocols/game-studio/agents/creative-director.md",
    "src/gameStudioPack/workspace-files/main/game-studio/README.md",
    "src/gameStudioPack/workspace-files/main/game-studio/hooks/session-start.sh",
  ];

  await Promise.all(
    criticalFiles.map(async (relativePath) => {
      const absolutePath = path.join(workspaceRoot, relativePath);
      const stat = await fs.stat(absolutePath);
      assert.equal(stat.isFile(), true, `${relativePath} should exist`);
    }),
  );
});
