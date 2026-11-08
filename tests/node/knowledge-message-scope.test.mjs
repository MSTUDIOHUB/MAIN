import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import ts from "typescript";

function load(file, dependencies = {}) {
  const module = { exports: {} };
  const code = ts.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  new Function("exports", "module", "require", code)(module.exports, module, name => {
    if (dependencies[name]) return dependencies[name];
    throw new Error(`Unexpected runtime import: ${name}`);
  });
  return module.exports;
}
const refs = load("src/lib/knowledgeReferences.ts", { "./sha256": load("src/lib/sha256.ts") });
const picker = load("src/lib/knowledgePicker.ts");
const source = { kind: "source", kbId: "kb-1", sourceId: "source-1", sourceRevision: "rev-1", label: "项目约定" };
const { prepareKnowledgeContext } = load("src/store/prepareKnowledgeContext.ts", { "../lib/knowledgeReferences": refs });

test("message scope is explicit, versioned, copied and never falls back to enabled bases", () => {
  assert.deepEqual(refs.normalizeKnowledgeReferences(undefined), []);
  assert.deepEqual(refs.normalizeKnowledgeReferences([]), []);
  assert.equal(refs.normalizeKnowledgeReferences([{ kind: "base", kbId: "kb-1" }]), null);
  assert.equal(refs.normalizeKnowledgeReferences([{ ...source, sourceRevision: "" }]), null);
  const input = [source, { ...source }];
  const snapshot = refs.normalizeKnowledgeReferences(input);
  assert.equal(snapshot.length, 1);
  input[0] = { ...source, sourceRevision: "changed" };
  assert.equal(snapshot[0].sourceRevision, "rev-1");
  assert.ok(Object.isFrozen(snapshot));
});

test("a hit must match the selected source and index revision", () => {
  const citation = { kbId: "kb-1", sourceId: "source-1", chunkId: "c-1", sourceRevision: "rev-1", indexRevision: "index-1" };
  assert.equal(refs.knowledgeCitationInScope(citation, [source]), true);
  assert.equal(refs.knowledgeCitationInScope({ ...citation, sourceId: "other" }, [source]), false);
  assert.equal(refs.knowledgeCitationInScope({ ...citation, sourceRevision: "old" }, [source]), false);
  assert.equal(refs.knowledgeCitationInScope(citation, []), false);
});

test("reference anchors identify untrusted data and only supplied citations", () => {
  const anchor = refs.renderKnowledgeContextAnchor({ state: "no_hits", query: "问题", references: [source], hits: [], note: "没有命中" });
  assert.match(anchor, /REFERENCE DATA/);
  assert.match(anchor, /no_hits/);
  assert.match(anchor, /not instructions/);
  assert.equal(refs.renderKnowledgeContextAnchor(undefined), "");
});

test("hash completion does not interpret Markdown or ordinary text as selection", () => {
  assert.deepEqual(picker.getKnowledgePickerSession("依据 #资料", 6), { anchor: 3, query: "资料" });
  for (const value of ["# 标题", "## 标题", "word#ref", "\\#资料", "#资料 后文", "#资料\n"]) {
    assert.equal(picker.getKnowledgePickerSession(value, value.length), null, value);
  }
  const selected = picker.applyKnowledgePickerSelection("依据 #资料 后文", 6, { anchor: 3, query: "资料" });
  assert.deepEqual(selected, { value: "依据  后文", cursor: 3 });
  assert.equal(picker.applyKnowledgePickerSelection("依据 #其他", 6, { anchor: 3, query: "资料" }), null);
});

test("unselected messages make no knowledge request, stale selections never fall back", async () => {
  let calls = 0;
  const controller = new AbortController();
  const input = { references: [], query: "问题", budget: null, reservedInputTokens: 0, signal: controller.signal };
  const deps = { search: async () => { calls++; throw new Error("STALE_KNOWLEDGE_REFERENCE"); } };
  assert.equal(await prepareKnowledgeContext(input, deps), undefined);
  assert.equal(calls, 0);
  const stale = await prepareKnowledgeContext({ ...input, references: [source] }, deps);
  assert.equal(stale.state, "stale");
  assert.deepEqual(stale.hits, []);
  assert.equal(calls, 1);
});

test("budgeting evicts whole excerpts with citations and refuses foreign-source results", async () => {
  const hit = { text: "资料正文".repeat(260), citation: { kbId: "kb-1", sourceId: "source-1", sourceRevision: "rev-1", chunkId: "c-1" } };
  const input = { references: [source], query: "正文", budget: { inputBudget: 4096, readWindowChars: 4096 }, reservedInputTokens: 0, signal: new AbortController().signal };
  const packet = await prepareKnowledgeContext(input, { search: async () => ({ hits: [hit, hit, hit, hit] }) });
  assert.ok(packet.hits.length > 0 && packet.hits.length < 4);
  assert.equal(packet.hits.length + packet.omittedHits, 4);
  assert.ok(packet.hits.every(item => item.text === hit.text && item.citation.chunkId === "c-1"));
  const foreign = await prepareKnowledgeContext(input, { search: async () => ({ hits: [{ ...hit, citation: { ...hit.citation, sourceId: "foreign" } }] }) });
  assert.equal(foreign.state, "error");
  assert.deepEqual(foreign.hits, []);
});

test("a canceled retrieval cannot settle into the next owner's context", async () => {
  const controller = new AbortController();
  await assert.rejects(prepareKnowledgeContext({ references: [source], query: "正文", budget: null, reservedInputTokens: 0, signal: controller.signal }, {
    search: async () => { controller.abort(); return { hits: [] }; },
  }), error => error.name === "AbortError");
});

const receipt = load("src/store/runtimeV2/readOnlyToolReceipt.ts", {
  "../../lib/knowledgeReferences": refs,
  "./readOnlyPolicy": { isChatContext: input => input.context.runtimeIntent === "chat", isReadOnlyContext: () => true },
  "./executionText": { runtimeV2SourceToolContent: value => typeof value === "string" ? value : JSON.stringify(value), boundedRuntimeV2ToolContent: (_name, value) => JSON.stringify(value).slice(0, 12000) },
  "./executionEvidence": { toolResultContentForModel: value => value },
});

test("Chat receipt port admits only frozen selected knowledge tools", async () => {
  let calls = 0;
  const input = { context: { runtimeIntent: "chat", knowledgeContext: { state: "retrieved", references: [source] } }, live: { messages: [] } };
  const port = receipt.withRuntimeV2ModelReceipt(input, { execute: async () => { calls++; return { type: "tool.completed", status: "succeeded" }; } });
  const request = { command: { kind: "execute_tool", payload: { toolName: "knowledge_get_excerpt" } } };
  await port.execute(request);
  assert.equal(calls, 1);
  input.context.knowledgeContext = { state: "retrieved", references: [] };
  await assert.rejects(port.execute(request), /DENIED/);
  assert.equal(calls, 1);
});

test("knowledge tool receipts remain parseable and evict whole cited groups inside the shared window", () => {
  const hit = { text: "中文正文".repeat(500), citation: { kbId: "kb-1", sourceId: "source-1", sourceRevision: "rev-1", chunkId: "c-1" }, returnedCharRange: { start: 0, end: 2000 }, totalChars: 4000, complete: false, retrievalKind: "source_overview", sourceOverview: { totalChunks: 5, totalChars: 16000, nextChunkId: "c-2" } };
  const output = { query: "正文", hits: [hit, hit, hit, hit, hit, hit, hit] };
  const input = { context: { runtimeIntent: "chat", knowledgeContext: { state: "retrieved", references: [source] }, runtimeContextBudget: { readWindowChars: 8000 } } };
  const raw = receipt.runtimeV2ToolModelContent(input, "knowledge_search", output, { parallelReadCount: 2 });
  const decoded = JSON.parse(raw);
  assert.ok(raw.length <= 4000);
  assert.equal(decoded.hits.length, 1);
  assert.deepEqual(decoded.hits[0], hit);
  assert.equal(decoded.omittedHits, 6);
  assert.equal(output.hits.length, 7);
});

test("canonical source data is copied before freezing and late IPC mutation cannot change a Turn", async () => {
  const hit = { text: "原始资料", citation: { kbId: "kb-1", sourceId: "source-1", sourceRevision: "rev-1", chunkId: "c-1" }, returnedCharRange: { start: 0, end: 4 }, totalChars: 90, complete: false, retrievalKind: "source_overview", sourceOverview: { totalChunks: 2, totalChars: 90, nextChunkId: "c-2" } };
  const packet = await prepareKnowledgeContext({ references: [source], query: "概览", budget: null, reservedInputTokens: 0, signal: new AbortController().signal }, { search: async () => ({ hits: [hit] }) });
  hit.text = "late replacement";
  hit.citation.chunkId = "foreign";
  assert.equal(packet.hits[0].text, "原始资料");
  assert.equal(packet.hits[0].citation.chunkId, "c-1");
  assert.ok(Object.isFrozen(packet.hits[0].sourceOverview));
});

test("a bounded model anchor projects used references without deleting canonical selected authority", () => {
  const selected = Array.from({ length: 120 }, (_, index) => ({ ...source, sourceId: `s-${index}`, label: "中文资料".repeat(80) }));
  const packet = { state: "retrieved", query: "当前目标", references: selected, hits: [{ text: "实际可见证据", citation: { kbId: "kb-1", sourceId: "s-5", sourceRevision: "rev-1", chunkId: "c-5" } }], note: "", modelContextCharBudget: 4000 };
  const before = JSON.stringify(packet);
  const anchor = refs.renderKnowledgeContextAnchor(packet);
  assert.ok(anchor.length <= 4000);
  const projected = JSON.parse(anchor.split("\n").find(line => line.startsWith("{")));
  assert.equal(projected.selectedReferenceCount, 120);
  assert.equal(projected.omittedReferenceCount, 119);
  assert.equal(projected.hits[0].text, "实际可见证据");
  assert.equal(projected.query, "当前目标");
  assert.equal(JSON.stringify(packet), before);
});

test("no available source budget records omission without changing frozen source scope", async () => {
  const hit = { text: "不应塞入模型", citation: { kbId: "kb-1", sourceId: "source-1", sourceRevision: "rev-1", chunkId: "c-1" } };
  const packet = await prepareKnowledgeContext({ references: [source], query: "问题", budget: { inputBudget: 1000, readWindowChars: 1000 }, reservedInputTokens: 1000, signal: new AbortController().signal }, { search: async () => ({ hits: [hit] }) });
  assert.deepEqual(packet.references, [source]);
  assert.deepEqual(packet.hits, []);
  assert.equal(packet.omittedHits, 1);
  assert.match(packet.note, /no source evidence/);
  assert.equal(refs.renderKnowledgeContextAnchor(packet), "");
});

test("knowledge excerpt receipts keep navigation and cannot authorize a foreign chunk through truncation", () => {
  const hit = { text: "原文".repeat(4000), citation: { kbId: "kb-1", sourceId: "source-1", sourceRevision: "rev-1", chunkId: "c-1" }, sourceOverview: { totalChunks: 9, totalChars: 40000, nextChunkId: "c-2" } };
  const bounded = JSON.parse(refs.boundKnowledgeToolResult(hit, [source], 1000));
  assert.deepEqual(bounded.hits, []);
  assert.equal(bounded.omittedHits, 1);
  assert.equal(bounded.truncated, true);
  assert.throws(() => refs.boundKnowledgeToolResult({ ...hit, citation: { ...hit.citation, sourceId: "foreign" } }, [source], 1000), /SCOPE_MISMATCH/);
  assert.deepEqual(JSON.parse(refs.boundKnowledgeToolResult(hit, [source], 20000)), hit);
});

test("durable FIFO freezes selected versions through restore and rejects a same-submission scope replacement", () => {
  const schema = load("src/lib/workspaceInstruction.ts");
  const queue = load("src/store/workspaceTurnQueue.ts", { "../lib/networkRead": load("src/lib/networkRead.ts"), "../lib/knowledgeReferences": refs, "../lib/workspaceInstruction": schema });
  const owner = { sessionKey: "/fixture:1", sessionEpoch: "epoch-1" };
  const input = { ...source };
  const instruction = { schemaVersion: 1, kind: "workspace_instruction", ...owner, clientSubmissionId: "submit-1", source: "composer", submittedAt: 1, payload: { text: "依据资料", knowledgeReferences: [input] } };
  const receipt = { schemaVersion: 1, kind: "workspace_turn_receipt", ...owner, clientSubmissionId: "submit-1", receiptId: "receipt-1", turnId: "turn-1", userBlockId: 1, acceptedAt: 1 };
  const state = queue.createWorkspaceTurnQueueState(owner);
  const appended = queue.reduceWorkspaceTurnQueue(state, { type: "append", at: 1, expectedVersion: 0, instruction, receipt });
  assert.equal(appended.disposition, "applied");
  const identity = queue.buildWorkspaceTurnQueueEntryIdentity(appended.entry);
  input.sourceRevision = "new-live-version";
  assert.equal(appended.entry.instruction.payload.knowledgeReferences[0].sourceRevision, "rev-1");
  assert.equal(queue.reduceWorkspaceTurnQueue(appended.state, { type: "append", at: 2, expectedVersion: appended.state.version, instruction, receipt }).reason, "client_submission_conflict");
  const committed = queue.reduceWorkspaceTurnQueue(appended.state, { type: "commit", at: 2, expectedVersion: appended.state.version, ...owner, clientSubmissionId: "submit-1", receiptId: "receipt-1" });
  const restored = queue.reconcileWorkspaceTurnQueueOnRestore({ ...owner, snapshot: JSON.parse(JSON.stringify(committed.state)), at: 3 });
  assert.equal(restored.entries[0].instruction.payload.knowledgeReferences[0].sourceRevision, "rev-1");
  assert.equal(queue.buildWorkspaceTurnQueueEntryIdentity(restored.entries[0]), identity);
  assert.deepEqual(queue.reconcileWorkspaceTurnQueueOnRestore({ ...owner, sessionEpoch: "replacement", snapshot: JSON.parse(JSON.stringify(committed.state)), at: 3 }).entries, []);
});
