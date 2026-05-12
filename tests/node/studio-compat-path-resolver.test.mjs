import test from "node:test";
import assert from "node:assert/strict";
import fsSync from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

import ts from "typescript";

const workspaceRoot = process.cwd();
const transpiledModuleCache = new Map();

function loadTranspiledModuleSync(sourcePath) {
  const normalizedPath = path.resolve(sourcePath);
  if (transpiledModuleCache.has(normalizedPath)) {
    return transpiledModuleCache.get(normalizedPath);
  }

  const source = fsSync.readFileSync(normalizedPath, "utf8");
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
    fileName: normalizedPath,
  }).outputText;

  const module = { exports: {} };
  transpiledModuleCache.set(normalizedPath, module.exports);
  const localRequire = createRequire(normalizedPath);
  const runtimeRequire = (specifier) => {
    if (specifier.startsWith(".")) {
      const basePath = path.resolve(path.dirname(normalizedPath), specifier);
      const candidates = [
        basePath,
        `${basePath}.ts`,
        `${basePath}.tsx`,
        path.join(basePath, "index.ts"),
      ];

      for (const candidate of candidates) {
        if (!fsSync.existsSync(candidate)) continue;
        if (candidate.endsWith(".ts") || candidate.endsWith(".tsx")) {
          return loadTranspiledModuleSync(candidate);
        }
      }
    }
    return localRequire(specifier);
  };

  const factory = new Function("exports", "module", "require", transpiled);
  factory(module.exports, module, runtimeRequire);
  transpiledModuleCache.set(normalizedPath, module.exports);
  return module.exports;
}

const resolver = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/studioCompatPathResolver.ts"));
const { resolveStudioCompatToolArgs } = resolver;

test("resolver maps .claude docs and skills paths for read-style tools", () => {
  const docs = resolveStudioCompatToolArgs("read_file", { path: ".claude/docs/workflow-catalog.yaml" });
  assert.equal(docs.args.path, ".protocols/game-studio/docs/workflow-catalog.yaml");
  assert.equal(docs.hits.length, 1);
  assert.equal(docs.hits[0].rule, "docs");

  const skill = resolveStudioCompatToolArgs("read_file", { path: ".claude/skills/dev-story/SKILL.md" });
  assert.equal(skill.args.path, ".protocols/game-studio/commands/dev-story.md");
  assert.equal(skill.hits.length, 1);
  assert.equal(skill.hits[0].rule, "skill_command");
});

test("resolver maps grep/glob and write tools while preserving unrelated paths", () => {
  const grep = resolveStudioCompatToolArgs("grep_search", {
    query: "TODO",
    path: ".claude/agents",
  });
  assert.equal(grep.args.path, ".protocols/game-studio/agents");
  assert.equal(grep.hits[0].field, "path");

  const glob = resolveStudioCompatToolArgs("glob_search", {
    pattern: ".claude/docs/templates/*.md",
  });
  assert.equal(glob.args.pattern, ".MAIN/templates/game-studio/*.md");
  assert.equal(glob.hits[0].rule, "templates");

  const write = resolveStudioCompatToolArgs("write_file", {
    path: "./.claude/docs/example.md",
    content: "x",
  });
  assert.equal(write.args.path, "./.protocols/game-studio/docs/example.md");

  const passthrough = resolveStudioCompatToolArgs("read_file", { path: ".protocols/game-studio/docs/x.md" });
  assert.equal(passthrough.args.path, ".protocols/game-studio/docs/x.md");
  assert.equal(passthrough.hits.length, 0);
});
