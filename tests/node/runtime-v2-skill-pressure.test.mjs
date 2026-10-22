import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";

const workspaceRoot = process.cwd();
const cache = new Map();

function loadTs(sourcePath) {
  const normalized = path.resolve(sourcePath);
  if (cache.has(normalized)) return cache.get(normalized);
  const source = fs.readFileSync(normalized, "utf8");
  const localRequire = createRequire(normalized);
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
    fileName: normalized,
  }).outputText;
  const loaded = { exports: {} };
  cache.set(normalized, loaded.exports);
  const runtimeRequire = (specifier) => {
    if (specifier.startsWith(".")) {
      const base = path.resolve(path.dirname(normalized), specifier);
      for (const candidate of [base, `${base}.ts`, path.join(base, "index.ts")]) {
        if (fs.existsSync(candidate) && candidate.endsWith(".ts")) {
          return loadTs(candidate);
        }
      }
    }
    return localRequire(specifier);
  };
  new Function("exports", "module", "require", output)(
    loaded.exports,
    loaded,
    runtimeRequire,
  );
  cache.set(normalized, loaded.exports);
  return loaded.exports;
}

const decision = loadTs(path.join(workspaceRoot, "src/store/runtimeV2/executionProviderDecisionView.ts"));
const transcript = loadTs(path.join(workspaceRoot, "src/store/runtimeV2/executionProviderSkillTranscript.ts"));
const sourceTranscript = loadTs(path.join(workspaceRoot, "src/store/runtimeV2/executionProviderSourceTranscript.ts"));
const trim = loadTs(path.join(workspaceRoot, "src/lib/contextTrim.ts"));
const skills = loadTs(path.join(workspaceRoot, "src/lib/agentSkills.ts"));
const executor = loadTs(path.join(workspaceRoot, "src/lib/agentSkillExecutor.ts"));

function catalog(content, version = "cafe1234") {
  return { entries: [{ id: "panel:workflow", name: "workflow", description: "Generic build guidance", source: "panel",
    content, entryPath: null, basePath: null, version, allowImplicitInvocation: true, supportingFiles: [] }],
    explicitSkillIds: [], warnings: [], loadedAt: 1 };
}
function pair(id, name, args, content) {
  return [{ role: "assistant", content: "", tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }] },
    { role: "tool", tool_call_id: id, content }];
}
const anchors = () => [{ role: "system", content: "[MAIN RUNTIME V2] Follow permissions." },
  { role: "user", runtimeTurnId: "t1", content: "Implement and validate the requested artifact." }];
const ids = (messages) => messages.filter((m) => m.role === "tool").map((m) => m.tool_call_id);
async function readPair(id, admitted, args = {}) {
  const call = { skill_id: "panel:workflow", ...args };
  return pair(id, "load_skill", call, await executor.executeAgentSkillTool(admitted, call));
}
function assertProtocol(messages) {
  const calls = new Set(messages.flatMap((m) => m.tool_calls || []).map((c) => c.id));
  const receipts = new Set(messages.filter((m) => m.role === "tool").map((m) => m.tool_call_id));
  assert.deepEqual(calls, receipts, "every retained tool call has its own result, with no orphan receipts");
}

test("pressure preserves actually read Skill sections across unrelated command discovery", async () => {
  const body = "# Workflow\r\nPreface🙂\r\n## Build\r\nUse a project builder for bulk construction.\r\n## Verify\r\nExercise the actual interaction path.\r\n";
  const admitted = catalog(body);
  const overview = await readPair("overview", admitted, { max_chars: 85 });
  const metadata = JSON.parse(overview[1].content);
  const build = metadata.sections.find((s) => s.title === "Build") || skills.loadSkillContent(admitted, "panel:workflow").sections.find((s) => s.title === "Build");
  const section = await readPair("build", admitted, { section: build?.id || "L3" });
  const verify = await readPair("verify", admitted, { start_line: 5, max_lines: 2 });
  const messages = [...anchors(), ...overview, ...section, ...verify,
    ...pair("old-query", "run_command", { command: "tool discover" }, "OLD_QUERY".repeat(3000)),
    ...pair("current-query", "run_command", { command: "tool inspect" }, "current result")];
  const view = decision.buildRuntimeV2DecisionView(messages);
  assert.ok(ids(view).includes("build"));
  assert.ok(ids(view).includes("verify"));
  assert.ok(ids(view).includes("overview"), "the exact preface remains guidance even when its index is metadata");
  const bounded = decision.boundRuntimeV2ProviderConversation(messages, { contextLimit: 32000, reservedOutputTokens: 4096, inputBudget: 2000 });
  for (const id of ["overview", "build", "verify", "current-query"]) assert.ok(ids(bounded).includes(id), id);
  assertProtocol(bounded);
  assert.deepEqual(messages[3], overview[1], "the canonical transcript stays unchanged");
});

test("final pressure explicitly identifies evicted exact guidance windows without inventing visible text", async () => {
  const admitted = catalog("# Workflow\n## Bulk\n" + "actual-guidance🙂\n".repeat(900));
  const skill = await readPair("large-guidance", admitted);
  const messages = [...anchors(), ...skill, ...pair("current", "run_command", { command: "tool status" }, "ready")];
  const budget = 1000;
  const bounded = decision.boundRuntimeV2ProviderConversation(messages, { contextLimit: 32000, reservedOutputTokens: 4096, inputBudget: budget });
  assert.ok(!ids(bounded).includes("large-guidance"));
  const notice = bounded.find((m) => typeof m.content === "string" && m.content.startsWith("[runtime-v2 skill guidance visibility]"));
  assert.ok(notice, "a dropped Skill window needs an explicit exact reread pointer");
  assert.doesNotMatch(notice.content, /actual-guidance/);
  const info = JSON.parse(notice.content.split("\n").at(-1));
  const receipt = JSON.parse(skill[1].content);
  assert.deepEqual(info.documents[0].readTarget, receipt.readTarget);
  assert.deepEqual(info.documents[0].evictedRanges, [receipt.returnedRange]);
  assert.match(notice.content, /not visible/);
  assert.match(notice.content, /no additional permissions/);
  assert.ok(trim.estimateMessagesTokens(bounded) <= budget);
  assertProtocol(bounded);
  assert.throws(() => decision.boundRuntimeV2ProviderConversation(messages, { contextLimit: 32000, reservedOutputTokens: 4096, inputBudget: 3 }), /RUNTIME_CONTEXT_BUDGET_EXCEEDED/);
});


test("guidance cover deduplicates exact and contained windows while preserving disjoint UTF-16 chunks", async () => {
  const admitted = catalog("# Workflow\r\n" + "a🙂b".repeat(60) + "\r\n## End\r\nTAIL\r\n");
  const first = await readPair("first", admitted, { start_line: 2, max_chars: 31 });
  const firstBody = JSON.parse(first[1].content);
  const continuation = await readPair("next", admitted, { start_line: firstBody.nextStartLine, start_char: firstBody.nextStartChar, max_chars: 29 });
  const duplicate = await readPair("duplicate", admitted, { start_line: 2, max_chars: 31 });
  const tail = await readPair("tail", admitted, { start_line: 4 });
  const messages = [...anchors(), ...first, ...continuation, ...duplicate, ...tail,
    ...pair("frontier", "run_command", { command: "ready" }, "ok")];
  const active = transcript.activeRuntimeV2SkillGuidanceWindows(messages);
  assert.deepEqual(active.map((w) => w.callId), ["next", "duplicate", "tail"]);
  assert.equal(active[0].returnedRange.startChar, firstBody.returnedRange.endChar);
  assertProtocol(decision.buildRuntimeV2DecisionView(messages));
  const full = await readPair("full", admitted);
  const covered = transcript.activeRuntimeV2SkillGuidanceWindows([...messages, ...full]);
  assert.deepEqual(covered.map((w) => w.callId), ["full"]);
  assert.equal(covered[0].content, admitted.entries[0].content);
});

test("list, failed, malformed and index-only results are not read guidance or workspace source authority", async () => {
  const admitted = catalog("# Workflow\nPreface\n## One\nONE\n## Two\nTWO\n");
  const success = await readPair("success", admitted);
  const body = JSON.parse(success[1].content);
  const index = await readPair("index", admitted, { section_cursor: `${admitted.entries[0].version}:0` });
  assert.equal(JSON.parse(index[1].content).content, "");
  const invalid = [
    pair("list", "load_skill", { operation: "list" }, JSON.stringify({ type: "skill.catalog", entries: [body] })),
    pair("failed", "load_skill", { skill_id: "panel:workflow" }, "SKILL_VERSION_MISMATCH"),
    pair("bad-range", "load_skill", { skill_id: "panel:workflow" }, JSON.stringify({ ...body, returnedRange: { ...body.returnedRange, endChar: body.returnedRange.endChar + 1 } })),
    pair("bad-version", "load_skill", { skill_id: "panel:workflow" }, JSON.stringify({ ...body, readTarget: { ...body.readTarget, expected_version: "stale" } })),
    pair("not-skill", "run_command", { command: "echo" }, success[1].content),
    index,
  ].flat();
  assert.deepEqual(transcript.runtimeV2TranscriptSkillGuidanceWindows(invalid), []);
  const messages = [...anchors(), ...success, ...invalid, ...pair("frontier", "run_command", { command: "status" }, "ok")];
  assert.deepEqual(transcript.activeRuntimeV2SkillGuidanceWindows(messages).map((w) => w.callId), ["success"]);
  for (const group of sourceTranscript.collectTranscriptToolGroups(messages)) {
    for (const call of group.calls.filter((c) => c.function.name === "load_skill")) {
      assert.equal(sourceTranscript.transcriptSourceWindow(group, call), null);
    }
  }
  assertProtocol(decision.buildRuntimeV2DecisionView(messages));
});

test("newer document index or empty revision invalidates previous guidance without pinning metadata", async () => {
  const old = await readPair("old", catalog("# Workflow\n## One\nOLD\n", "cafe1234"));
  const nextIndex = await readPair("new-index", catalog("# Workflow\n## One\nNEW\n", "cafe5678"), { section_cursor: "cafe5678:0" });
  assert.deepEqual(transcript.runtimeV2TranscriptSkillDocumentReads(nextIndex).map((read) => read.callId), ["new-index"]);
  assert.deepEqual(transcript.runtimeV2TranscriptSkillGuidanceWindows(nextIndex), [], "a typed index identifies its revision without claiming instruction bytes");
  assert.deepEqual(transcript.activeRuntimeV2SkillGuidanceWindows([...old, ...nextIndex]), []);
  const empty = await readPair("empty", catalog("", "cafe5678"));
  assert.deepEqual(transcript.runtimeV2TranscriptSkillDocumentReads(empty).map((read) => read.callId), ["empty"]);
  assert.deepEqual(transcript.runtimeV2TranscriptSkillGuidanceWindows(empty), []);
  assert.deepEqual(transcript.activeRuntimeV2SkillGuidanceWindows([...old, ...empty]), []);
});

test("body and supporting resource keep independent revisions and exact executable eviction pointers", async () => {
  const ipc = loadTs(path.join(workspaceRoot, "src/lib/ipc.ts"));
  const original = ipc.readGlobalSkillPackageFile;
  const packageId = "a".repeat(64);
  const admitted = catalog("# Workflow\nBODY\n", "cafe1234");
  const entry = { ...admitted.entries[0], id: `global:${packageId}:skills/workflow/SKILL.md`, source: "package",
    entryPath: `main-skill://${packageId}/skills/workflow/SKILL.md`, basePath: `main-skill://${packageId}/skills/workflow`,
    globalPackageId: packageId, globalResourceBase: "skills/workflow", globalResourcePaths: ["skills/workflow/SKILL.md", "skills/workflow/references/check.md"] };
  admitted.entries = [entry];
  const resource = "# Resource\r\n" + "RESOURCE🙂\r\n".repeat(700);
  ipc.readGlobalSkillPackageFile = async () => resource;
  try {
    const body = await readPair("body", admitted, { skill_id: entry.id });
    const reference = await readPair("resource", admitted, { skill_id: entry.id, resource: "references/check.md", start_line: 2, max_lines: 600 });
    const duplicate = await readPair("resource-duplicate", admitted, { skill_id: entry.id, resource: "references/check.md", start_line: 2, max_lines: 600 });
    const messages = [...anchors(), ...body, ...reference, ...duplicate, ...pair("current", "run_command", { command: "status" }, "ready")];
    const active = transcript.activeRuntimeV2SkillGuidanceWindows(messages);
    assert.deepEqual(active.map((w) => w.callId), ["body", "resource-duplicate"]);
    assert.notEqual(active[0].version, active[1].version);
    const nextBody = await readPair("new-body", { ...admitted, entries: [{ ...entry, content: "# Workflow\nNEW BODY\n", version: "cafe5678" }] }, { skill_id: entry.id });
    assert.deepEqual(transcript.activeRuntimeV2SkillGuidanceWindows([...messages, ...nextBody]).map((w) => w.callId), ["resource-duplicate", "new-body"], "a new body revision cannot invalidate a different supporting document");
    const bounded = decision.boundRuntimeV2ProviderConversation(messages, { contextLimit: 32000, reservedOutputTokens: 4096, inputBudget: 1400 });
    const notice = bounded.find((m) => typeof m.content === "string" && m.content.startsWith("[runtime-v2 skill guidance visibility]"));
    const info = JSON.parse(notice.content.split("\n").at(-1));
    assert.ok(ids(bounded).includes("body") || info.documents.some((d) => d.readTarget.expected_version === "cafe1234" && d.readTarget.resource === undefined), "body is visible or has its own exact independent pointer");
    const pointer = info.documents.find((d) => d.readTarget.resource === "references/check.md");
    assert.ok(pointer);
    const range = pointer.evictedRanges[0];
    const reread = JSON.parse(await executor.executeAgentSkillTool(admitted, { ...pointer.readTarget, start_line: range.startLine, start_char: range.startChar, max_chars: range.endChar - range.startChar }));
    assert.deepEqual(reread.returnedRange, range);
    assert.equal(reread.content, JSON.parse(duplicate[1].content).content);
    assertProtocol(bounded);
  } finally { ipc.readGlobalSkillPackageFile = original; }
});

test("under-budget canonical history remains verbatim including lists and duplicate guidance", async () => {
  const admitted = catalog("# Workflow\nUse the relevant tool.\n");
  const messages = [...anchors(), ...await readPair("a", admitted), ...await readPair("b", admitted),
    ...pair("list", "load_skill", { operation: "list" }, await executor.executeAgentSkillTool(admitted, { operation: "list" })),
    ...pair("current", "run_command", { command: "status" }, "ready")];
  const copy = structuredClone(messages);
  const bounded = decision.boundRuntimeV2ProviderConversation(messages, { contextLimit: 32000, reservedOutputTokens: 4096, inputBudget: 20000 });
  assert.deepEqual(bounded, copy);
  assert.deepEqual(messages, copy);
});

test("pressure prunes mixed batches by owned pairs and preserves current authority and frontier", async () => {
  const admitted = catalog("# Workflow\nSMALL GUIDANCE\n");
  admitted.entries.push({ ...admitted.entries[0], id: "panel:other", name: "other", content: "# Other\n" + "LARGE_GUIDANCE\n".repeat(1500) });
  const old = await readPair("old-small", admitted, { start_line: 1, max_chars: 10 });
  const large = await readPair("large", admitted, { skill_id: "panel:other" });
  const ordinary = pair("ordinary", "run_command", { command: "discover" }, "old observation".repeat(2000));
  const mixed = [{ role: "assistant", content: "Read selected guidance and inspect one capability.",
    tool_calls: [old[0].tool_calls[0], large[0].tool_calls[0], ordinary[0].tool_calls[0]] }, old[1], large[1], ordinary[1]];
  const complete = await readPair("new-small", admitted);
  const messages = [...anchors(), ...mixed, ...complete,
    ...pair("current", "run_command", { command: "status" }, "CURRENT_FRONTIER"),
    { role: "system", content: "[runtime-v2 context: review-policy]\nPreserve manual review and path restrictions." }];
  const view = decision.buildRuntimeV2DecisionView(messages);
  assert.ok(!ids(view).includes("old-small"));
  assert.ok(!ids(view).includes("ordinary"));
  assert.ok(ids(view).includes("large"));
  assertProtocol(view);
  const bounded = decision.boundRuntimeV2ProviderConversation(messages, { contextLimit: 32000, reservedOutputTokens: 4096, inputBudget: 2500 });
  assert.ok(ids(bounded).includes("new-small"));
  assert.ok(!ids(bounded).includes("large"));
  assert.ok(ids(bounded).includes("current"));
  assert.deepEqual(bounded[0], messages[0]);
  assert.deepEqual(bounded.find((m) => m.role === "user"), messages[1]);
  assert.ok(bounded.includes(messages.at(-1)));
  assertProtocol(bounded);
  const ownerById = new Map();
  for (const message of bounded) {
    for (const call of message.tool_calls || []) {
      assert.ok(!ownerById.has(call.id), "retained calls have unique owners");
      ownerById.set(call.id, false);
    }
    if (message.role === "tool") {
      assert.equal(ownerById.get(message.tool_call_id), false, "a result follows exactly one earlier owner");
      ownerById.set(message.tool_call_id, true);
    }
  }
  assert.ok([...ownerById.values()].every(Boolean));
});
