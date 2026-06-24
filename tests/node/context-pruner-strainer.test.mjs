// tests/node/context-pruner-strainer.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { EphemeralPruner } from "../../src/lib/orchestrator/state/EphemeralPruner.ts";
import { ReasoningStrainer } from "../../src/lib/orchestrator/state/ReasoningStrainer.ts";
import { StreamingThoughtSummarizer } from "../../src/lib/chat/StreamingThoughtSummarizer.ts";

test("StreamingThoughtSummarizer.thoughtToSummary", () => {
  const thought1 = "I need to read auth.ts to check authorization logic.";
  const summary1 = StreamingThoughtSummarizer.thoughtToSummary(thought1, 100, "en");
  assert.equal(summary1, "Planning to read auth.ts");

  const thought2 = "Let me modify index.css to change background color.";
  const summary2 = StreamingThoughtSummarizer.thoughtToSummary(thought2, 100, "zh");
  assert.equal(summary2, "计划修改文件 index.css");

  const thought3 = "Running tests to verify build: npm run test";
  const summary3 = StreamingThoughtSummarizer.thoughtToSummary(thought3, 100, "en");
  assert.equal(summary3, "Preparing to execute shell command");
});

test("EphemeralPruner.prune", () => {
  const pruner = new EphemeralPruner({ maxToolChars: 20, maxReasoningChars: 20 });
  const messages = [
    { role: "system", content: "System prompt" },
    { role: "tool", tool_call_id: "read_file_1", content: "Very long file output content exceeding limit" },
    { role: "assistant", reasoning: "Long historical reasoning content", content: "Hello" },
    { role: "assistant", reasoning: "Current turn reasoning content", content: "Latest response" } // last message
  ];

  const ephemeralIds = new Set(["read_file_1"]);
  const pruned = pruner.prune(messages, ephemeralIds, "Prior context memo");

  // Tool content should be pruned
  assert.match(pruned[2].content, /Truncated|已剪枝/);
  // Reasoning on older assistant message should be pruned
  assert.match(pruned[3].reasoning, /pruned|修剪/);
  // Reasoning on latest assistant message remains untouched
  assert.equal(pruned[4].reasoning, "Current turn reasoning content");
  // Context memory message is injected
  assert.ok(pruned.some(m => m.role === "system" && m.content.includes("Prior context memo")));
});

test("ReasoningStrainer.purgeReasoning", () => {
  const strainer = new ReasoningStrainer();
  const messages = [
    { role: "assistant", reasoning: "Historical thought process", content: "Before content <thinking>Internal detail</thinking> test" },
    { role: "assistant", reasoning: "Latest thought process", content: "Latest content" }
  ];

  const purged = strainer.purgeReasoning(messages);
  // Historical reasoning fields should be deleted
  assert.equal(purged[0].reasoning, undefined);
  // Historical content inline tags should be purged/replaced
  assert.match(purged[0].content, /Internal monologue purged|内部思考过程已净化/);
  // Latest reasoning fields kept intact
  assert.equal(purged[1].reasoning, "Latest thought process");
});
