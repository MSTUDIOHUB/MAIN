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
  planReadFileWindowCoverage,
  replayReadFileWindowFromResult,
  resolveReadFileResultAfterLargeFileSummary,
} = await loadReadFileWindowModule();

function numberedLines(count, suffix = "") {
  return Array.from({ length: count }, (_, index) =>
    `line-${String(index + 1).padStart(3, "0")} ${suffix}`.trim(),
  ).join("\n");
}

test("large read_file results return a 32K-bounded first window with truncation metadata", () => {
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
  assert.ok(metadata.returnedChars <= 32_000);
  assert.doesNotMatch(result, /nextRead:/);
  assert.match(result, /continue from nextStartLine/i);
  assert.match(result, /full-file semantics/i);
  assert.match(result, /do not use run_command merely to page file contents/i);
  assert.ok(result.length < 33_000);
});

test("an ordinary 894-line source file around 27KB stays in one observation", () => {
  const content = numberedLines(894, "x".repeat(20));

  assert.ok(content.length > 26_000);
  assert.ok(content.length < 32_000);

  const result = formatReadFileWindowForModel("src/main.js", content);

  assert.equal(result, content);
  assert.equal(extractReadFileWindowMetadata(result), null);
  assert.match(result, /line-894/);
});

test("the default read window remains bounded to 1000 lines", () => {
  const content = numberedLines(1001);
  const result = formatReadFileWindowForModel("src/generated.ts", content);
  const metadata = extractReadFileWindowMetadata(result);

  assert.ok(metadata);
  assert.equal(metadata.truncated, true);
  assert.equal(metadata.returnedStartLine, 1);
  assert.equal(metadata.returnedEndLine, 1000);
  assert.equal(metadata.nextStartLine, 1001);
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

test("read_file max_chars metadata describes the source bytes actually returned", () => {
  const content = numberedLines(500, "x".repeat(80));
  const result = formatReadFileWindowForModel(
    "src/components/toolbar.js",
    content,
    { max_chars: 10_000 },
  );
  const metadata = extractReadFileWindowMetadata(result);

  assert.ok(metadata);
  assert.equal(metadata.truncated, true);
  assert.ok(metadata.returnedChars <= 10_000);
  assert.equal(metadata.nextStartLine, metadata.returnedEndLine + 1);
  assert.doesNotMatch(result, /line-500/);
});

test("truncated read guidance exposes a version-consistent continuation for full-file semantics", () => {
  const content = numberedLines(500, "x".repeat(80));
  const result = formatReadFileWindowForModel("src/components/Sidebar.tsx", content);
  const metadata = extractReadFileWindowMetadata(result);
  const guidance = buildReadFileWindowContinuationGuidance(result);

  assert.ok(metadata?.nextStartLine);
  assert.match(guidance, new RegExp(`line ${metadata.nextStartLine}`));
  assert.match(guidance, /bounded window, not the whole file/);
  assert.match(guidance, /full-file semantics/i);
  assert.match(guidance, /continue sequentially/i);
  assert.match(guidance, /otherwise continue to mutation or validation/i);
  assert.match(guidance, /Do not use run_command/);
  assert.match(result, /continue from nextStartLine/i);
  assert.doesNotMatch(guidance, /nextRead:/);
  assert.doesNotMatch(guidance, /full content already in context/i);
});

test("an unnecessary large-file summary preserves the bounded paging envelope", () => {
  const content = numberedLines(500, "x".repeat(80));
  const original = formatReadFileWindowForModel("src/main.js", content);
  const metadata = extractReadFileWindowMetadata(original);

  const preserved = resolveReadFileResultAfterLargeFileSummary(original, {
    content,
    summarized: false,
  });
  const summarized = resolveReadFileResultAfterLargeFileSummary(original, {
    content: "[FILE MAP-REDUCE SUMMARY]\nmain.js application flow",
    summarized: true,
  });

  assert.equal(preserved, original);
  assert.ok(metadata?.nextStartLine);
  assert.match(preserved, new RegExp(`nextStartLine: ${metadata.nextStartLine}`));
  assert.equal(summarized, "[FILE MAP-REDUCE SUMMARY]\nmain.js application flow");
});

test("read_file coverage planner narrows overlapping windows to missing lines", () => {
  const plan = planReadFileWindowCoverage(
    { path: "src/App.tsx", start_line: 1, max_lines: 130 },
    282,
    [{ startLine: 100, endLine: 199 }],
  );

  assert.equal(plan.overlapped, true);
  assert.equal(plan.fullyCovered, false);
  assert.equal(plan.suggestedRange.startLine, 1);
  assert.equal(plan.suggestedRange.endLine, 99);
  assert.equal(plan.suggestedArgs.start_line, 1);
  assert.equal(plan.suggestedArgs.end_line, 99);
});

test("read_file coverage planner detects fully covered requests", () => {
  const plan = planReadFileWindowCoverage(
    { path: "src/App.tsx", start_line: 120, max_lines: 20 },
    282,
    [{ startLine: 100, endLine: 199 }],
  );

  assert.equal(plan.overlapped, true);
  assert.equal(plan.fullyCovered, true);
  assert.equal(plan.suggestedArgs, undefined);
});

test("a covered source range is replayed from its cached versioned window", () => {
  const original = formatReadFileWindowForModel(
    "src/main.js",
    numberedLines(1_100),
  ).replace(
    "path: src/main.js",
    "path: src/main.js\ncontentVersion: sha-main-v1",
  );
  const replay = replayReadFileWindowFromResult(original, {
    path: "src/main.js",
    start_line: 400,
    end_line: 402,
  });
  const metadata = extractReadFileWindowMetadata(replay);

  assert.ok(metadata);
  assert.equal(metadata.contentVersion, "sha-main-v1");
  assert.equal(metadata.returnedStartLine, 400);
  assert.equal(metadata.returnedEndLine, 402);
  assert.match(replay, /line-400/);
  assert.match(replay, /line-402/);
  assert.doesNotMatch(replay, /line-399/);
  assert.doesNotMatch(replay, /line-403/);
});
