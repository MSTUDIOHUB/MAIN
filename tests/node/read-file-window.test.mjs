import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";

import ts from "typescript";

const require = createRequire(import.meta.url);
const workspaceRoot = process.cwd();

async function loadReadFileWindowModule() {
  const sourcePath = path.join(workspaceRoot, "src/lib/readFileWindow.ts");
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
  buildReadFileWindowContinuationGuidance,
  extractReadFileWindowMetadata,
  formatReadFileWindowForModel,
} = await loadReadFileWindowModule();

function numberedLines(count, suffix = "") {
  return Array.from({ length: count }, (_, index) =>
    `line-${String(index + 1).padStart(3, "0")} ${suffix}`.trim(),
  ).join("\n");
}

test("large read_file results return a bounded first window with truncation metadata", () => {
  const content = numberedLines(500, "x".repeat(80));
  const result = formatReadFileWindowForModel("src/components/Sidebar.tsx", content);
  const metadata = extractReadFileWindowMetadata(result);

  assert.ok(metadata);
  assert.equal(metadata.path, "src/components/Sidebar.tsx");
  assert.equal(metadata.truncated, true);
  assert.equal(metadata.totalLines, 500);
  assert.equal(metadata.totalChars, content.length);
  assert.equal(metadata.returnedStartLine, 1);
  assert.ok(metadata.returnedEndLine < 500);
  assert.equal(metadata.nextStartLine, metadata.returnedEndLine + 1);
  assert.match(result, /nextRead: read_file\(\{"path":"src\/components\/Sidebar\.tsx","start_line":\d+,"max_lines":180\}\)/);
  assert.match(result, /do not use run_command merely to page file contents/i);
  assert.ok(result.length < 8000);
});

test("read_file explicit start_line and max_lines return the requested window", () => {
  const content = numberedLines(20);
  const result = formatReadFileWindowForModel("src/App.tsx", content, {
    start_line: 5,
    max_lines: 3,
  });
  const metadata = extractReadFileWindowMetadata(result);

  assert.ok(metadata);
  assert.equal(metadata.returnedStartLine, 5);
  assert.equal(metadata.returnedEndLine, 7);
  assert.match(result, /line-005/);
  assert.match(result, /line-007/);
  assert.doesNotMatch(result, /line-004/);
  assert.doesNotMatch(result, /line-008/);
});

test("duplicate truncated read guidance points to the next read_file window", () => {
  const content = numberedLines(300, "x".repeat(80));
  const result = formatReadFileWindowForModel("src/components/Sidebar.tsx", content);
  const metadata = extractReadFileWindowMetadata(result);
  const guidance = buildReadFileWindowContinuationGuidance(result);

  assert.ok(metadata?.nextStartLine);
  assert.match(guidance, new RegExp(`start_line=${metadata.nextStartLine}`));
  assert.match(guidance, /bounded window, not the whole file/);
  assert.match(guidance, /Do not use run_command/);
  assert.doesNotMatch(guidance, /full content already in context/i);
});
