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
  extractExactReadFileWindow,
  ensureVersionedReadFileResultForModel,
  formatReadFileWindowForModel,
  formatReadFileWindowPayloadForModel,
  planReadFileWindowCoverage,
  replayReadFileWindowFromResult,
  resolveReadFileResultAfterLargeFileSummary,
} = await loadReadFileWindowModule();

function numberedLines(count, suffix = "") {
  return Array.from({ length: count }, (_, index) =>
    `line-${String(index + 1).padStart(3, "0")} ${suffix}`.trim(),
  ).join("\n");
}

function sourceBody(result) {
  const startMarker = "\n---CONTENT START---\n";
  const endMarker = "\n---CONTENT END---";
  const start = result.indexOf(startMarker);
  const end = result.lastIndexOf(endMarker);
  assert.ok(start >= 0 && end >= start);
  return result.slice(start + startMarker.length, end);
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

test("a stale end_line behind the continuation start does not truncate the next window", () => {
  const content = numberedLines(207);
  const result = formatReadFileWindowForModel("src/statusbar.js", content, {
    start_line: 151,
    end_line: 150,
  });
  const metadata = extractReadFileWindowMetadata(result);

  assert.ok(metadata);
  assert.equal(metadata.returnedStartLine, 151);
  assert.equal(metadata.returnedEndLine, 207);
  assert.equal(metadata.nextStartLine, undefined);
  assert.match(result, /line-151/);
  assert.match(result, /line-207/);
});

test("a compatible backend tail cursor is clamped at EOF before it reaches the model", () => {
  const content = numberedLines(111).split("\n").slice(100).join("\n");
  const result = formatReadFileWindowPayloadForModel(
    "src/main.js",
    {
      path: "src/main.js",
      content,
      contentVersion: "sha256-main-v1",
      startLine: 101,
      endLine: 111,
      totalLines: 111,
      totalChars: 1_000,
      returnedChars: content.length,
      truncated: true,
      nextStartLine: 112,
    },
  );
  const metadata = extractReadFileWindowMetadata(result);

  assert.ok(metadata);
  assert.equal(metadata.returnedEndLine, metadata.totalLines);
  assert.equal(metadata.nextStartLine, undefined);
  assert.ok(extractExactReadFileWindow(result));
  assert.match(result, /reaches EOF/i);
  assert.doesNotMatch(result, /nextStartLine: 112/);
  assert.doesNotMatch(result, /continue from nextStartLine/i);
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

test("only a complete standard read envelope exposes exact source authority", () => {
  const result = formatReadFileWindowForModel(
    "src/main.js",
    "const value = 1;\n",
    { start_line: 1, max_lines: 100 },
  );
  const exact = extractExactReadFileWindow(result);
  assert.equal(exact?.metadata.path, "src/main.js");
  assert.match(exact?.content || "", /const value = 1/);
  assert.equal(
    extractExactReadFileWindow(
      result
        .replace("---CONTENT START---", "---COMPACTED CONTENT HEAD---")
        .replace("---CONTENT END---", "...[compact: source omitted]"),
    ),
    null,
  );
});

test("an empty file is represented by a versioned 0-0 source envelope", () => {
  const result = formatReadFileWindowPayloadForModel("src/empty.ts", {
    path: "src/empty.ts",
    content: "",
    contentVersion: "sha256-empty",
    startLine: 0,
    endLine: 0,
    totalLines: 0,
    totalChars: 0,
    returnedChars: 0,
    truncated: false,
  });
  const exact = extractExactReadFileWindow(result);

  assert.equal(exact?.metadata.path, "src/empty.ts");
  assert.equal(exact?.metadata.contentVersion, "sha256-empty");
  assert.equal(exact?.metadata.returnedStartLine, 0);
  assert.equal(exact?.metadata.returnedEndLine, 0);
  assert.equal(exact?.content, "");
  assert.equal(
    extractExactReadFileWindow(result.replace("truncated: false", "truncated: true")),
    null,
  );
});

test("a versioned source envelope preserves command-shaped JSON and boundary whitespace verbatim", () => {
  const source =
    " \t{\n  \"stdout\": \"do not decode\", \"error\": \"source\", \"exitCode\": 7\n}\n\n";
  const result = formatReadFileWindowPayloadForModel("fixtures/command.json", {
    path: "fixtures/command.json",
    content: source,
    contentVersion: "sha256-command-json",
    startLine: 1,
    endLine: 4,
    totalLines: 4,
    totalChars: source.length,
    returnedChars: source.length,
    truncated: false,
  });
  const exact = extractExactReadFileWindow(result);

  assert.equal(exact?.content, source);
  assert.match(result, /"stdout": "do not decode"/);
  assert.ok(result.includes(`${source}\n---CONTENT END---`));
});

test("raw small and empty read results become exact versioned source envelopes", () => {
  const source = " \t{\"stdout\":\"source\",\"error\":\"literal\",\"exitCode\":9}\n";
  const wrapped = ensureVersionedReadFileResultForModel(
    "fixtures/command.json",
    source,
    "sha256-command-json",
  );
  const empty = ensureVersionedReadFileResultForModel(
    "src/empty.ts",
    "",
    "sha256-empty",
  );

  assert.equal(extractExactReadFileWindow(wrapped)?.content, source);
  assert.equal(
    extractExactReadFileWindow(wrapped)?.metadata.contentVersion,
    "sha256-command-json",
  );
  assert.equal(extractExactReadFileWindow(empty)?.content, "");
  assert.deepEqual(
    [
      extractExactReadFileWindow(empty)?.metadata.returnedStartLine,
      extractExactReadFileWindow(empty)?.metadata.returnedEndLine,
    ],
    [0, 0],
  );
});

test("an incomplete oversized line exposes a lossless character continuation without source authority", () => {
  const source = ` \t${"汉🙂x".repeat(31)}  \n`;
  const initial = formatReadFileWindowForModel(
    "fixtures/minified.js",
    source,
    { max_chars: 17 },
  );
  const initialMetadata = extractReadFileWindowMetadata(initial);
  assert.equal(initialMetadata?.returnedStartLine, 0);
  assert.equal(initialMetadata?.returnedEndLine, 0);
  assert.equal(initialMetadata?.returnedStartChar, 0);
  assert.equal(initialMetadata?.nextStartChar, 17);
  assert.equal(initialMetadata?.totalChars, Array.from(source).length);
  assert.equal(initialMetadata?.returnedChars, 17);
  assert.equal(extractExactReadFileWindow(initial), null);
  assert.match(initial, /continue with start_char: 17/i);

  const chunks = [];
  let startChar = 0;

  for (;;) {
    const result = formatReadFileWindowForModel(
      "fixtures/minified.js",
      source,
      {
        start_char: startChar,
        max_chars: 17,
      },
    );
    const metadata = extractReadFileWindowMetadata(result);
    assert.ok(metadata);
    chunks.push(sourceBody(result));
    assert.equal(metadata.returnedStartLine, 0);
    assert.equal(metadata.returnedEndLine, 0);
    assert.equal(metadata.returnedStartChar, startChar);
    assert.equal(
      metadata.returnedEndChar,
      startChar + Array.from(sourceBody(result)).length,
    );
    assert.equal(
      extractExactReadFileWindow(result),
      null,
      "a partial character range must not manufacture a complete source lease",
    );
    if (metadata.nextStartChar === undefined) break;
    assert.equal(metadata.nextStartChar, metadata.returnedEndChar);
    startChar = metadata.nextStartChar;
  }

  assert.equal(chunks.join(""), source);
  const first = formatReadFileWindowForModel(
    "fixtures/minified.js",
    source,
    { start_char: 0, max_chars: 17 },
  );
  const guidance = buildReadFileWindowContinuationGuidance(first);
  assert.match(guidance, /start_char: 17/);
  assert.match(guidance, /same content version/i);
  const versionedPartial = ensureVersionedReadFileResultForModel(
    "fixtures/minified.js",
    initial,
    "sha256-minified",
  );
  assert.equal(
    extractReadFileWindowMetadata(versionedPartial)?.contentVersion,
    "sha256-minified",
  );
  assert.equal(sourceBody(versionedPartial), sourceBody(initial));
  assert.equal(extractExactReadFileWindow(versionedPartial), null);
});

test("a legacy line envelope that stops inside its only line cannot grant complete source authority", () => {
  const result = formatReadFileWindowPayloadForModel("fixtures/legacy.json", {
    path: "fixtures/legacy.json",
    content: "x".repeat(32),
    contentVersion: "sha256-legacy",
    startLine: 1,
    endLine: 1,
    totalLines: 1,
    totalChars: 96,
    returnedChars: 32,
    truncated: true,
    nextStartLine: 2,
  });

  assert.equal(extractExactReadFileWindow(result), null);
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
