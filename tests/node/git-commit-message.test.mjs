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
  sanitizeGitCommitMessage,
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

test("sanitizeGitCommitMessage preserves multiline structure and filters conversation/fences", () => {
  // Test XML-style <commit_message> tagging (fully enclosed)
  const xmlInput = `
Thinking:
1. Do this and that
<commit_message>
feat: add AI git generator

- Add generate button
- Use textarea instead of input
</commit_message>
Post-thinking notes.
  `.trim();
  const xmlExpected = "feat: add AI git generator\n\n- Add generate button\n- Use textarea instead of input";
  assert.equal(sanitizeGitCommitMessage(xmlInput), xmlExpected);

  // Test XML-style <commit_message> tagging (cut off / unclosed)
  const xmlCutoffInput = `
<commit_message>
feat: add AI git generator

- Add generate button
  `.trim();
  const xmlCutoffExpected = "feat: add AI git generator\n\n- Add generate button";
  assert.equal(sanitizeGitCommitMessage(xmlCutoffInput), xmlCutoffExpected);

  const input = `
\`\`\`git
feat: add AI git generator

- Add generate button
- Use textarea instead of input
\`\`\`
  `.trim();
  const expected = "feat: add AI git generator\n\n- Add generate button\n- Use textarea instead of input";
  assert.equal(sanitizeGitCommitMessage(input), expected);

  // Test with conversational prefix
  const conversationalInput = `
Here is your commit message:
"chore: update dependencies"
  `.trim();
  assert.equal(sanitizeGitCommitMessage(conversationalInput), "chore: update dependencies");

  // Test with thinking process block
  const thinkingInput = `
Here's a thinking process:
1. First, analyze the diff.
2. We see that Sidebar.tsx was modified.

feat: update sidebar UI

- Add AI generate button
  `.trim();
  assert.equal(sanitizeGitCommitMessage(thinkingInput), "feat: update sidebar UI\n\n- Add AI generate button");

  // Test with leading numbering and bold tags
  const numberedBoldInput = `
1. **feat(sidebar)**: support resizing of the git popup height and width

- Added resize listener to Sidebar
- Fixed layout clipping at bottom
  `.trim();
  assert.equal(
    sanitizeGitCommitMessage(numberedBoldInput),
    "feat(sidebar): support resizing of the git popup height and width\n\n- Added resize listener to Sidebar\n- Fixed layout clipping at bottom"
  );

  // Test numbered only
  assert.equal(
    sanitizeGitCommitMessage("1. fix: crash on launch"),
    "fix: crash on launch"
  );

  // Test bold only
  assert.equal(
    sanitizeGitCommitMessage("**style**: fix formatting"),
    "style: fix formatting"
  );

  // Test too short
  assert.equal(sanitizeGitCommitMessage("  "), null);
  assert.equal(
    sanitizeGitCommitMessage("feat: format output\n\n- Update `Sidebar.tsx` and **gitCommitMessage.ts**"),
    "feat: format output\n\n- Update Sidebar.tsx and gitCommitMessage.ts"
  );
});

test("buildFallbackGitCommitMessage covers status groups", () => {
  const zhMessage = buildFallbackGitCommitMessage([
      { path: "src/components/Sidebar.tsx", status: "M", old: "", new: "", existed: true, fullFile: true },
      { path: "src/lib/gitCommitMessage.ts", status: "M", old: "", new: "", existed: true, fullFile: true },
    ], "zh", baseStatus);
  assert.equal(zhMessage.split("\n")[0], "更新 Git 提交体验");
  assert.match(zhMessage, /提交信息生成/);
  assert.match(zhMessage, /Git 菜单/);
  assert.doesNotMatch(zhMessage, /覆盖 \d+ 个文件|src\/|`|新增\/调整|移除\/替换/);

  const addedMessage = buildFallbackGitCommitMessage(
    [{ path: "src/lib/gitDiff.ts", status: "A", old: "", new: "export const diff = true;", existed: false, fullFile: true }],
    "en",
    baseStatus,
  );
  assert.equal(addedMessage.split("\n")[0], "Add git diff preview");
  assert.match(addedMessage, /Update app logic/);
  assert.doesNotMatch(addedMessage, /export const|`|src\/lib\/gitDiff/);

  const deletedMessage = buildFallbackGitCommitMessage(
    [{ path: "src/old.ts", status: "D", old: "export const oldValue = true;", new: "", existed: true, fullFile: true }],
    "en",
    baseStatus,
  );
  assert.equal(deletedMessage.split("\n")[0], "Remove Old");
  assert.match(deletedMessage, /Update app logic/);
  assert.doesNotMatch(deletedMessage, /export const|removes\/replaces|`/);

  const untrackedMessage = buildFallbackGitCommitMessage(
    [{ path: "notes/todo.md", status: "U", old: "", new: "todo", existed: false, fullFile: true }],
    "zh",
    baseStatus,
  );
  assert.equal(untrackedMessage.split("\n")[0], "新增 notes");
  assert.match(untrackedMessage, /汇总项目文件的主要变更/);

  const mixedMessage = buildFallbackGitCommitMessage([
    { path: "docs/main-manual/overview.md", status: "M", old: "old manual", new: "new manual", existed: true, fullFile: true },
    { path: "docs/main-manual/assets/screenshots/main-workbench.png", status: "A", old: "", new: "", existed: false, fullFile: true, binary: true },
    { path: "src/components/Sidebar.tsx", status: "M", old: "old sidebar", new: "new sidebar", existed: true, fullFile: true },
    { path: "src/lib/gitCommitMessage.ts", status: "M", old: "old generator", new: "new generator", existed: true, fullFile: true },
    { path: "src/components/ThemeStyles.tsx", status: "M", old: "old theme", new: "new theme", existed: true, fullFile: true },
    { path: "tests/node/git-commit-message.test.mjs", status: "M", old: "old test", new: "new test", existed: true, fullFile: true },
  ], "zh", { changedFiles: 6, insertions: 120, deletions: 40 });
  assert.equal(mixedMessage.split("\n")[0], "更新 MAIN 手册与 Git 提交体验");
  assert.match(mixedMessage, /精简 MAIN 手册内容并补充截图资源/);
  assert.match(mixedMessage, /提交信息生成/);
  assert.match(mixedMessage, /Git 菜单/);
  assert.match(mixedMessage, /主题样式/);
  assert.doesNotMatch(mixedMessage, /覆盖 \d+ 个文件|行新增|行删除|docs\/main-manual|`|新增\/调整|移除\/替换/);
});

test("generateGitCommitMessage prefers detailed model output and rejects thin output", async () => {
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
  let requestBody = null;

  const generated = await generateGitCommitMessage({
    config,
    language: "en",
    workspace: "/tmp/repo",
    status: baseStatus,
    entries,
    requestJson: async (request) => {
      requestBody = request.body;
      return {
        choices: [{
          message: {
            content: [
              "<commit_message>",
              "feat(git): improve generated commit summaries",
              "",
              "- Improve Git menu commit input and post-commit state handling",
              "- Summarize generated commit messages with stronger quality checks",
              "</commit_message>",
            ].join("\n"),
          },
        }],
      };
    },
  });
  assert.deepEqual(generated, {
    message: [
      "feat(git): improve generated commit summaries",
      "",
      "- Improve Git menu commit input and post-commit state handling",
      "- Summarize generated commit messages with stronger quality checks",
    ].join("\n"),
    source: "model",
  });
  assert.match(JSON.stringify(requestBody), /Detailed diff of changes/);
  assert.match(JSON.stringify(requestBody), /File: src\/components\/Sidebar\.tsx/);

  const thinModel = await generateGitCommitMessage({
    config,
    language: "en",
    workspace: "/tmp/repo",
    status: baseStatus,
    entries,
    requestJson: async () => ({ choices: [{ message: { content: "Commit message: Update sidebar git menu" } }] }),
  });
  assert.equal(thinModel.source, "fallback");
  assert.equal(thinModel.message.split("\n")[0], "Update Git commit workflow");
  assert.match(thinModel.message, /generated commit messages|commit message generation/);
  assert.match(thinModel.message, /Git menu/);
  assert.doesNotMatch(thinModel.message, /src\/|`|adds\/updates|removes\/replaces/);

  const fallback = await generateGitCommitMessage({
    config,
    language: "zh",
    workspace: "/tmp/repo",
    status: baseStatus,
    entries,
    requestJson: async () => { throw new Error("offline"); },
  });
  assert.equal(fallback.source, "fallback");
  assert.equal(fallback.message.split("\n")[0], "更新 Git 提交体验");
  assert.match(fallback.message, /提交信息生成/);
  assert.match(fallback.message, /Git 菜单/);
  assert.doesNotMatch(fallback.message, /覆盖 \d+ 个文件|src\/|`|新增\/调整|移除\/替换/);
});
