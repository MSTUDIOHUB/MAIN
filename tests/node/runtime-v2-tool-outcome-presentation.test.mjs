import test from "node:test";
import assert from "node:assert/strict";
import { createTsModuleLoader } from "./tsModuleLoader.mjs";
const load = createTsModuleLoader();
const { reconcileRuntimeV2TimelineBlocks: reconcile } = load("src/store/runtimeV2/projectionTimeline.ts");
const { buildLiveTurnProcessTimelineModel: live, buildTurnProcessArchiveModel: archive } = load("src/lib/turnProcessArchive.ts");
const { buildToolResultPresentation: display } = load("src/lib/toolResultPresentation.ts");
const { formatReadFileWindowForModel: formatRead } = load("src/lib/readFileWindow.ts");
const run = { turnId: "turn", runId: "run" };
const raw = "TOOL_NOT_EXECUTED: provider_batch_predecessor_failed; provider-call-17";

function fixture(status, failureReasonCode, settled = false, toolName = "load_skill") {
  const completion = { type: "tool.completed", idempotencyKey: "command", run, status,
    failureKind: status === "blocked" ? "not_authorized" : "execution_failed", failureReasonCode,
    modelContent: raw, presentation: { toolName, target: "Unity CLI", message: raw, observationSummary: raw } };
  const aggregate = { run: { identity: run }, completedCommands: [{ idempotencyKey: "command", status: "succeeded" }], events: [completion] };
  const blocks = [{ id: 1, type: "tool", ...run, toolCallId: "command", toolName, target: "Unity CLI",
    status: settled ? "error" : "running", toolStatus: settled ? "failed" : "running", message: settled ? raw : "" }];
  return { aggregate, blocks, completion };
}

for (const settled of [false, true]) {
  test(`unexecuted rows use canonical outcomes without protocol codes (${settled ? "restored" : "live"})`, () => {
    const { aggregate, blocks, completion } = fixture("blocked", "provider_batch_predecessor_failed", settled);
    const before = JSON.stringify(aggregate);
    const projected = reconcile(blocks, aggregate, 3, "zh");
    assert.equal(projected[0].toolOutcome, "not_executed");
    assert.match(projected[0].message, /未执行/);
    assert.doesNotMatch(projected[0].message + projected[0].observationSummary, /TOOL_|provider[-_]/);
    assert.match(projected[0].diagnosticDetails, /provider-call-17/);
    for (const build of [live, archive]) {
      const view = build({ blocks: projected, language: "zh", includeThoughts: false });
      assert.equal(view.steps[0].status, "not_executed");
      assert.match(view.steps[0].activity.title, /未执行/);
      assert.equal(view.counts.failed, 0);
      assert.equal(view.steps[0].activity.metrics.failed, 0);
      assert.doesNotMatch(view.steps[0].activity.latestEvidence, /TOOL_|provider[-_]/);
    }
    assert.equal(JSON.stringify(aggregate), before, "presentation cannot alter the model receipt or ledger");
    assert.equal(completion.modelContent, raw);
  });
}

test("policy denial, failed attempt and successful output remain distinct", () => {
  for (const [status, reason, outcome, label, failures, commands] of [
    ["blocked", "scope_denied", "blocked", /被阻止/, 0, 0],
    ["failed", "command_exit_nonzero", "failed", /执行失败/, 1, 1],
    ["succeeded", undefined, "succeeded", null, 0, 1],
  ]) {
    const { blocks, aggregate } = fixture(status, reason, false, "run_command");
    const projected = reconcile(blocks, aggregate, 3, "en");
    assert.equal(projected[0].toolOutcome, outcome);
    const zh = reconcile(blocks, aggregate, 3, "zh");
    if (label) assert.match(zh[0].message, label);
    else assert.equal(zh[0].message, raw, "successful source output must not be scrubbed as a protocol error");
    const view = live({ blocks: zh, language: "zh", includeThoughts: false });
    assert.equal(view.steps[0].activity.metrics.failed, failures);
    assert.equal(view.steps[0].activity.metrics.commandsRun, commands);
  }
});

test("an unexecuted file read never contributes an observed read count", () => {
  const { blocks, aggregate } = fixture("blocked", "provider_batch_predecessor_unsettled", false, "read_file");
  const view = live({ blocks: reconcile(blocks, aggregate, 3, "zh"), language: "zh", includeThoughts: false });
  assert.equal(view.steps[0].activity.metrics.filesRead, 0);
  assert.doesNotMatch(view.steps[0].activity.summary, /1 个文件/);
});

test("truncated display receipts use intact canonical Skill content after restore", () => {
  const content = '# Unity CLI\n' + 'Use the documented command schema.\n'.repeat(160) + 'Literal TOOL_ERROR in Skill source stays intact.\n';
  const receipt = JSON.stringify({ type: "skill.loaded", id: "global:private-skill-version", name: "Unity CLI", content });
  const truncated = receipt.slice(0, 3962) + "\n[Tool output truncated by Runtime v2.]";
  assert.throws(() => JSON.parse(truncated), "matches the actual long Skill display receipt");
  const { aggregate, blocks, completion } = fixture("succeeded", undefined, true);
  completion.modelContent = receipt;
  completion.presentation = { toolName: "load_skill", target: "s:internal-ref", message: truncated, observationSummary: truncated };
  const before = JSON.stringify(aggregate);
  const projected = reconcile(blocks, aggregate, 3, "zh");
  assert.equal(projected[0].target, "Unity CLI");
  assert.equal(display({ toolName: "load_skill", message: projected[0].message, language: "zh" }).text, content);
  assert.match(projected[0].observationSummary, /已读取技能/);
  assert.doesNotMatch(projected[0].observationSummary, /skill\.loaded|global:|truncated/);
  assert.match(projected[0].diagnosticDetails, /global:private-skill-version/);
  for (const build of [live, archive]) {
    const view = build({ blocks: projected, language: "zh", includeThoughts: false });
    assert.doesNotMatch(view.steps[0].activity.latestEvidence, /skill\.loaded|global:|truncated/);
  }
  assert.equal(JSON.stringify(aggregate), before, "formatting must preserve canonical and model receipts");
});

test("unexecuted context reads never merge with a subsequent successful read", () => {
  const skipped = fixture("blocked", "provider_batch_predecessor_failed");
  const succeeded = fixture("succeeded", undefined);
  succeeded.blocks[0].id = 2;
  succeeded.blocks[0].toolCallId = "read-again";
  succeeded.completion.idempotencyKey = "read-again";
  const aggregate = { run: { identity: run }, completedCommands: [
    { idempotencyKey: "command", status: "succeeded" }, { idempotencyKey: "read-again", status: "succeeded" },
  ], events: [skipped.completion, succeeded.completion] };
  const projected = reconcile([...skipped.blocks, ...succeeded.blocks], aggregate, 3, "zh");
  for (const build of [live, archive]) {
    const view = build({ blocks: projected, language: "zh", includeThoughts: false });
    assert.deepEqual(view.steps.map(step => step.status), ["not_executed", "done"]);
  }
});

test("a literal complete read protocol in user source is formatted exactly once", () => {
  const literal = formatRead("literal.txt", "literal source text\n", { start_line: 1, end_line: 1 });
  const receipt = formatRead("protocol-example.txt", literal, { start_line: 1, end_line: literal.split("\n").length });
  const { aggregate, blocks, completion } = fixture("succeeded", undefined, true, "read_file");
  completion.modelContent = receipt;
  completion.presentation = { toolName: "read_file", target: "protocol-example.txt", message: receipt, observationSummary: receipt };
  const before = JSON.stringify(aggregate);
  const projected = reconcile(blocks, aggregate, 3, "zh");
  const shown = display({ toolName: "read_file", message: projected[0].message, language: "zh" });
  assert.equal(shown.text, literal, "the user document's protocol example is source content, not another host receipt");
  assert.equal(JSON.stringify(aggregate), before);
});
