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

const {
  buildFallbackGitCommitMessage,
  generateGitCommitMessage,
  sanitizeGitCommitSubject,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/gitCommitMessage.ts"));

const baseStatus = {
  changedFiles: 2,
  insertions: 10,
  deletions: 2,
};

test("sanitizeGitCommitSubject extracts one clean subject and enforces length", () => {
  assert.equal(sanitizeGitCommitSubject("Commit message: Update sidebar git menu\n\nDetails"), "Update sidebar git menu");
  assert.equal(sanitizeGitCommitSubject("\"更新 Git 菜单\""), "更新 Git 菜单");
  assert.equal(sanitizeGitCommitSubject("x"), null);
  assert.equal(sanitizeGitCommitSubject("a".repeat(90))?.length, 72);
});

test("buildFallbackGitCommitMessage covers status groups", () => {
  assert.equal(
    buildFallbackGitCommitMessage([
      { path: "src/components/Sidebar.tsx", status: "M", old: "", new: "", existed: true, fullFile: true },
      { path: "src/lib/gitCommitMessage.ts", status: "M", old: "", new: "", existed: true, fullFile: true },
    ], "zh", baseStatus),
    "更新 Git 菜单",
  );
  assert.equal(
    buildFallbackGitCommitMessage([{ path: "src/lib/gitDiff.ts", status: "A", old: "", new: "", existed: false, fullFile: true }], "en", baseStatus),
    "Add git diff preview",
  );
  assert.equal(
    buildFallbackGitCommitMessage([{ path: "src/old.ts", status: "D", old: "old", new: "", existed: true, fullFile: true }], "en", baseStatus),
    "Remove Old",
  );
  assert.equal(
    buildFallbackGitCommitMessage([{ path: "notes/todo.md", status: "U", old: "", new: "todo", existed: false, fullFile: true }], "zh", baseStatus),
    "新增 notes",
  );
});

test("generateGitCommitMessage prefers model output and falls back on failure", async () => {
  const config = {
    activeProfile: "cloud",
    cloud: {
      protocol: "openai",
      apiFormat: "chat_completions",
      provider: "OpenAI",
      endpoint: "https://api.openai.test/v1",
      model: "commit-model",
      apiKey: "test",
      customHeaders: "",
      disableResponseStorage: true,
    },
  };
  const entries = [
    { path: "src/components/Sidebar.tsx", status: "M", old: "old", new: "new", existed: true, fullFile: true },
    { path: "src/lib/gitCommitMessage.ts", status: "M", old: "old", new: "new", existed: true, fullFile: true },
  ];

  const generated = await generateGitCommitMessage({
    config,
    language: "en",
    workspace: "/tmp/repo",
    status: baseStatus,
    entries,
    requestJson: async () => ({ choices: [{ message: { content: "Commit message: Update sidebar git menu" } }] }),
  });
  assert.deepEqual(generated, { message: "Update sidebar git menu", source: "model" });

  const fallback = await generateGitCommitMessage({
    config,
    language: "zh",
    workspace: "/tmp/repo",
    status: baseStatus,
    entries,
    requestJson: async () => { throw new Error("offline"); },
  });
  assert.deepEqual(fallback, { message: "更新 Git 菜单", source: "fallback" });
});
