import test from "node:test";
import assert from "node:assert/strict";
import { createTsModuleLoader } from "./tsModuleLoader.mjs";
const load = createTsModuleLoader();
const { formatReadFileWindowForModel: format } = load("src/lib/readFileWindow.ts");
const { buildToolResultPresentation: display } = load("src/lib/toolResultPresentation.ts");
const { buildLiveTurnProcessTimelineModel: archive } = load("src/lib/turnProcessArchive.ts");
const { reconcileRuntimeV2TimelineBlocks: reconcile } = load("src/store/runtimeV2/projectionTimeline.ts");
const content = 'const marker = "TOOL_ERROR";\nconst label = "READ_FILE_RESULT";\n';
const message = format("src/fixture.cs", content, { start_line: 1, end_line: 2 });

test("file paging protocol becomes readable UI without altering literal source", () => {
  const result = display({ toolName: "read_file", message, language: "zh" });
  assert.equal(result.parsed, true);
  assert.equal(result.text, content);
  assert.doesNotMatch(result.meta[0], /READ_FILE_RESULT|returnedLines|TOOL_ERROR/);
  assert.match(result.meta[0], /1.*2.*行/);
});

test("canonical and older archived read rows keep protocol markers out of their summaries", () => {
  const block = { id: 1, type: "tool", turnId: "t", runId: "r", toolCallId: "c", toolName: "read_file", target: "src/fixture.cs", toolStatus: "executed", status: "done", message, observationSummary: message };
  const aggregate = { run: { identity: { turnId: "t", runId: "r" } }, completedCommands: [{ idempotencyKey: "c", status: "succeeded" }],
    events: [{ type: "tool.completed", idempotencyKey: "c", status: "succeeded", modelContent: message, presentation: { toolName: "read_file", target: block.target, message, observationSummary: message } }] };
  const before = JSON.stringify(aggregate);
  for (const blocks of [[block], reconcile([block], aggregate, 2, "zh")]) {
    const view = archive({ blocks, language: "zh", includeThoughts: false });
    assert.doesNotMatch(view.steps[0].activity.latestEvidence, /READ_FILE_RESULT|returnedLines|TOOL_ERROR/);
    assert.equal(view.steps[0].status, "done");
  }
  assert.equal(JSON.stringify(aggregate), before);
});

test("Skill read UI uses its name and bounded content rather than internal resource identifiers", () => {
  const result = display({ toolName: "load_skill", message: JSON.stringify({ type: "skill.loaded", name: "unity-cli", id: "internal-id", ref: "s:internal",
    content: "## Workflow\nUse the supported tools.", returnedRange: { startLine: 2, endLine: 4 }, partial: true }), language: "zh" });
  assert.equal(result.parsed, true);
  assert.equal(result.displayTarget, "unity-cli");
  assert.equal(result.text, "## Workflow\nUse the supported tools.");
  assert.match(result.meta[0], /unity-cli/);
  assert.doesNotMatch(result.meta.join(" ") + result.text, /internal-id|s:internal/);
});

test("empty search receipts localize only the owned placeholder and preserve user literals", () => {
  const placeholder = "TOOL_RESULT_EMPTY: the tool completed successfully and returned no content or matches.";
  const result = display({ toolName: "grep_search", message: placeholder, language: "zh" });
  assert.equal(result.parsed, true);
  assert.doesNotMatch(result.text, /TOOL_RESULT_EMPTY/);
  for (const text of [placeholder, "READ_FILE_RESULT\nThis is literal user text, not a complete paging envelope."]) {
    assert.equal(display({ toolName: "read_file", message: text, language: "zh" }).text, text);
  }
});
