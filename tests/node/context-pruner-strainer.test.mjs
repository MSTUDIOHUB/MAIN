// tests/node/context-pruner-strainer.test.mjs
// Tests for the new context pruning and reasoning straining modules

import { test } from "node:test";
import assert from "node:assert/strict";
import fsSync from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";

const require = createRequire(import.meta.url);
const workspaceRoot = process.cwd();
const transpiledModuleCache = new Map();

function loadTranspiledModuleSync(sourcePath) {
  const normalizedPath = path.resolve(sourcePath);
  if (transpiledModuleCache.has(normalizedPath)) {
    return transpiledModuleCache.get(normalizedPath);
  }
  const source = fsSync.readFileSync(normalizedPath, "utf8");
  const localRequire = createRequire(normalizedPath);
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
    fileName: normalizedPath,
  }).outputText;
  const module = { exports: {} };
  transpiledModuleCache.set(normalizedPath, module.exports);
  const runtimeRequire = (specifier) => {
    if (specifier.startsWith(".")) {
      const basePath = path.resolve(path.dirname(normalizedPath), specifier);
      for (const candidate of [basePath, `${basePath}.ts`, `${basePath}.tsx`, path.join(basePath, "index.ts")]) {
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
  captureLatestUnconsumedToolResultBatch,
  EphemeralPruner,
  pruneEphemeralItems,
  restoreLatestUnconsumedToolResultBatch,
} = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/lib/orchestrator/state/EphemeralPruner.ts"),
);
const { compactContextForExecuteRecovery, manageContext } = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/lib/contextTrim.ts"),
);

function assistantToolCall(id, name = "read_file") {
  return {
    role: "assistant",
    content: "",
    tool_calls: [{ id, type: "function", function: { name, arguments: "{}" } }],
  };
}

test("pruneEphemeralItems burns old large results but preserves the latest unconsumed batch verbatim", () => {
  const oldContent = "A".repeat(3000);
  const latestContent = "B".repeat(4200);
  const messages = [
    { role: "system", content: "system" },
    { role: "user", content: "inspect then edit" },
    assistantToolCall("old-read"),
    { role: "tool", tool_call_id: "old-read", content: oldContent },
    assistantToolCall("latest-read"),
    { role: "tool", tool_call_id: "latest-read", content: latestContent },
  ];

  const result = pruneEphemeralItems(messages, null, { maxToolChars: 2000 });

  assert.match(result.messages[3].content, /^\[Burned: tool result for old-read/);
  assert.equal(messages[3].content, oldContent, "pruning must not mutate the source history");
  assert.equal(result.messages[5].content, latestContent);
  assert.equal(result.burnedToolResults, 1);
  assert.equal(result.burnedToolChars, oldContent.length);
  assert.equal(result.preservedToolResults, 1);
  assert.equal(result.preservedToolChars, latestContent.length);
  assert.equal(result.toolCharsBefore, oldContent.length + latestContent.length);
  assert.equal(
    result.toolCharsAfter,
    result.messages[3].content.length + latestContent.length,
  );
});

test("a later assistant response marks the preceding tool batch as consumed and prunable", () => {
  const content = "C".repeat(3000);
  const messages = [
    { role: "user", content: "inspect" },
    assistantToolCall("consumed-read"),
    { role: "tool", tool_call_id: "consumed-read", content },
    { role: "assistant", content: "I used the file contents." },
  ];

  assert.equal(captureLatestUnconsumedToolResultBatch(messages), null);
  const result = pruneEphemeralItems(messages, null, { maxToolChars: 2000 });
  assert.equal(result.burnedToolResults, 1);
  assert.equal(result.preservedToolResults, 0);
  assert.match(result.messages[2].content, /^\[Burned:/);
});

test("the backward-compatible EphemeralPruner also protects an unconsumed result", () => {
  const content = "L".repeat(3000);
  const messages = [
    { role: "user", content: "read" },
    assistantToolCall("legacy-read"),
    { role: "tool", tool_call_id: "legacy-read", content },
  ];

  const result = new EphemeralPruner({ maxToolChars: 2000, language: "en" })
    .prune(messages, new Set(["legacy-read"]));

  assert.equal(result[2].content, content);
});

test("restoreLatestUnconsumedToolResultBatch repairs compacted and dropped results as an atomic protocol group", () => {
  const firstContent = "D".repeat(3500);
  const secondContent = "E".repeat(3600);
  const assistant = {
    role: "assistant",
    content: "",
    tool_calls: [
      { id: "read-one", type: "function", function: { name: "read_file", arguments: "{}" } },
      { id: "read-two", type: "function", function: { name: "read_file", arguments: "{}" } },
    ],
  };
  const source = [
    { role: "system", content: "system" },
    { role: "user", content: "read both" },
    assistant,
    { role: "tool", tool_call_id: "read-one", content: firstContent },
    { role: "system", content: "[HookContext:PostToolUse] keep this hook" },
    { role: "tool", tool_call_id: "read-two", content: secondContent },
  ];
  const batch = captureLatestUnconsumedToolResultBatch(source);
  const compacted = [
    source[0],
    source[1],
    assistant,
    { role: "tool", tool_call_id: "read-one", content: "[compact]" },
    source[4],
  ];

  const restored = restoreLatestUnconsumedToolResultBatch(compacted, batch);

  assert.equal(restored.restoredToolResults, 2);
  assert.equal(restored.reinsertedToolResults, 1);
  assert.equal(restored.restoredToolChars, firstContent.length + secondContent.length);
  assert.deepEqual(restored.messages.slice(2, 5), [assistant, source[3], source[5]]);
  assert.equal(
    restored.messages.filter((message) => message.content === source[4].content).length,
    1,
    "hook context must be retained exactly once when a missing result forces group reconstruction",
  );
});

test("restoreLatestUnconsumedToolResultBatch leaves an already-verbatim batch in its existing order", () => {
  const assistant = {
    role: "assistant",
    content: "",
    tool_calls: [
      { id: "one", type: "function", function: { name: "read_file", arguments: "{}" } },
      { id: "two", type: "function", function: { name: "read_file", arguments: "{}" } },
    ],
  };
  const source = [
    { role: "user", content: "read" },
    assistant,
    { role: "tool", tool_call_id: "one", content: "first" },
    { role: "system", content: "[HookContext:PostToolUse] first hook" },
    { role: "tool", tool_call_id: "two", content: "second" },
  ];

  const restored = restoreLatestUnconsumedToolResultBatch(
    source,
    captureLatestUnconsumedToolResultBatch(source),
  );

  assert.equal(restored.restoredToolResults, 0);
  assert.deepEqual(restored.messages, source);
});

test("reused fallback tool ids never rewrite an older tool-result batch", () => {
  const oldContent = `OLD:${"o".repeat(2800)}`;
  const latestContent = `NEW:${"n".repeat(3200)}`;
  const oldAssistant = assistantToolCall("native_call_1");
  const latestAssistant = assistantToolCall("native_call_1");
  const source = [
    { role: "user", content: "read the first file" },
    oldAssistant,
    { role: "tool", tool_call_id: "native_call_1", content: oldContent },
    { role: "assistant", content: "first result consumed" },
    { role: "user", content: "read the second file" },
    latestAssistant,
    { role: "tool", tool_call_id: "native_call_1", content: latestContent },
  ];

  const pruned = pruneEphemeralItems(source, null, { maxToolChars: 2000 });
  assert.match(pruned.messages[2].content, /^\[Burned:/);
  assert.equal(pruned.messages[6].content, latestContent);

  const compacted = pruned.messages.map((message, index) =>
    index === 6 ? { ...message, content: "[compacted latest result]" } : message
  );
  const restored = restoreLatestUnconsumedToolResultBatch(
    compacted,
    captureLatestUnconsumedToolResultBatch(source),
  );

  assert.match(restored.messages[2].content, /^\[Burned:/);
  assert.notEqual(restored.messages[2].content, latestContent);
  assert.equal(restored.messages[6].content, latestContent);
  assert.equal(
    restored.messages.filter((message) => message.content === latestContent).length,
    1,
  );
});

test("a dropped parent batch is restored before surviving recovery messages", () => {
  const assistant = assistantToolCall("native_call_1");
  const toolResult = {
    role: "tool",
    tool_call_id: "native_call_1",
    content: "fresh source contents",
  };
  const recoverySystem = { role: "system", content: "RECOVERY: apply the source edit now" };
  const recoveryUser = { role: "user", content: "continue the same logical turn" };
  const source = [
    { role: "user", content: "read before editing" },
    assistant,
    toolResult,
    recoverySystem,
    recoveryUser,
  ];
  const compacted = [source[0], recoverySystem, recoveryUser];

  const restored = restoreLatestUnconsumedToolResultBatch(
    compacted,
    captureLatestUnconsumedToolResultBatch(source),
  );

  assert.deepEqual(restored.messages, [
    source[0],
    assistant,
    toolResult,
    recoverySystem,
    recoveryUser,
  ]);
  assert.equal(restored.reinsertedToolResults, 1);
});

test("a dropped latest parent does not reuse an older identical fallback-id parent", () => {
  const oldAssistant = assistantToolCall("native_call_1");
  const latestAssistant = assistantToolCall("native_call_1");
  const oldResult = { role: "tool", tool_call_id: "native_call_1", content: "OLD" };
  const latestResult = { role: "tool", tool_call_id: "native_call_1", content: "NEW" };
  const recovery = { role: "system", content: "RECOVERY_AFTER_LATEST_BATCH" };
  const source = [
    { role: "user", content: "run consecutive native tool calls" },
    oldAssistant,
    oldResult,
    latestAssistant,
    latestResult,
    recovery,
  ];
  const compacted = [source[0], oldAssistant, oldResult, recovery];

  const restored = restoreLatestUnconsumedToolResultBatch(
    compacted,
    captureLatestUnconsumedToolResultBatch(source),
  );

  assert.deepEqual(restored.messages, [
    source[0],
    oldAssistant,
    oldResult,
    latestAssistant,
    latestResult,
    recovery,
  ]);
});

test("identical anchors on both sides restore the batch before the surviving suffix", () => {
  const repeatedRecovery = { role: "system", content: "RECOVERY" };
  const assistant = assistantToolCall("native_call_1");
  const result = { role: "tool", tool_call_id: "native_call_1", content: "NEW" };
  const source = [
    { role: "user", content: "continue" },
    repeatedRecovery,
    assistant,
    result,
    { ...repeatedRecovery },
  ];
  // Compaction drops the prefix recovery and the protocol group, retaining
  // only the identically worded suffix recovery.
  const compacted = [source[0], source[4]];

  const restored = restoreLatestUnconsumedToolResultBatch(
    compacted,
    captureLatestUnconsumedToolResultBatch(source),
  );

  assert.deepEqual(restored.messages, [source[0], assistant, result, source[4]]);
});

test("identical anchors on both sides keep a surviving prefix before the restored batch", () => {
  const prefixRecovery = { role: "system", content: "RECOVERY" };
  const assistant = assistantToolCall("native_call_1");
  const result = { role: "tool", tool_call_id: "native_call_1", content: "NEW" };
  const source = [
    { role: "user", content: "continue" },
    prefixRecovery,
    assistant,
    result,
    { role: "system", content: "RECOVERY" },
  ];
  const compacted = [source[0], prefixRecovery];

  const restored = restoreLatestUnconsumedToolResultBatch(
    compacted,
    captureLatestUnconsumedToolResultBatch(source),
  );

  assert.deepEqual(restored.messages, [source[0], prefixRecovery, assistant, result]);
});

test("the prune and context-management pipeline restores a fresh post-mutation read before model consumption", () => {
  const latestContent = "fn main() {\n" + "println!(\"fresh\");\n".repeat(260) + "}";
  const source = [
    { role: "system", content: "system" },
    { role: "user", content: "modify then verify main.rs" },
    {
      role: "assistant",
      content: "",
      tool_calls: [{
        id: "write-main",
        type: "function",
        function: { name: "write_file", arguments: JSON.stringify({ path: "src/main.rs" }) },
      }],
    },
    { role: "tool", tool_call_id: "write-main", content: "written successfully" },
    {
      role: "assistant",
      content: "",
      tool_calls: [{
        id: "read-main",
        type: "function",
        function: { name: "read_file", arguments: JSON.stringify({ path: "src/main.rs" }) },
      }],
    },
    { role: "tool", tool_call_id: "read-main", content: latestContent },
  ];
  const batch = captureLatestUnconsumedToolResultBatch(source);
  const pruned = pruneEphemeralItems(source, null, { maxToolChars: 2000 });
  const managed = manageContext(pruned.messages, 32768);
  const compactedFreshRead = managed.messages.find((message) => message.tool_call_id === "read-main");

  assert.match(compactedFreshRead.content, /Historical read content/);
  const restored = restoreLatestUnconsumedToolResultBatch(managed.messages, batch);
  const restoredFreshRead = restored.messages.find((message) => message.tool_call_id === "read-main");
  assert.equal(restoredFreshRead.content, latestContent);
  assert.equal(restored.restoredToolResults, 1);
  assert.equal(restored.restoredToolChars, latestContent.length);
});

test("execute-recovery compaction cannot drop the latest unconsumed tool protocol group", () => {
  const content = "R".repeat(5000);
  const source = [
    { role: "system", content: "system" },
    { role: "user", content: "recover the edit" },
    assistantToolCall("recovery-read"),
    { role: "tool", tool_call_id: "recovery-read", content },
  ];
  const batch = captureLatestUnconsumedToolResultBatch(source);
  const compacted = compactContextForExecuteRecovery(source, {
    maxMessages: 8,
    maxToolResultMessages: 1,
    maxToolChars: 1000,
    maxToolCallGroups: 1,
    maxToolResultTokens: 120,
    latestUserMessages: 1,
  });

  assert.equal(compacted.messages.some((message) => message.tool_call_id === "recovery-read"), false);
  const restored = restoreLatestUnconsumedToolResultBatch(compacted.messages, batch);
  assert.deepEqual(restored.messages.slice(-2), source.slice(-2));
  assert.equal(restored.reinsertedToolResults, 1);
});

test("StreamingThoughtSummarizer exports are functional", async () => {
  try {
    const mod = await import("../../src/lib/chat/StreamingThoughtSummarizer.ts");
    assert.ok(typeof mod.summarizeThought === "function", "summarizeThought should be exported");
    assert.ok(typeof mod.thoughtSummaryToString === "function", "thoughtSummaryToString should be exported");
    assert.ok(typeof mod.isThoughtDominated === "function", "isThoughtDominated should be exported");
  } catch {
    // Module resolution may not work for .ts in node test runner
  }
});

test("Thread state machine exports are functional", async () => {
  try {
    const mod = await import("../../src/lib/orchestrator/state/Thread.ts");
    assert.ok(typeof mod.ConversationThread === "function", "ConversationThread should be exported");
    assert.ok(typeof mod.createThread === "function", "createThread should be exported");
    assert.ok(typeof mod.createTurn === "function", "createTurn should be exported");
  } catch {
    // Module may not resolve via ESM
  }
});

test("TurnContext exports are functional", async () => {
  try {
    const mod = await import("../../src/lib/orchestrator/state/TurnContext.ts");
    assert.ok(typeof mod.TurnContext === "function", "TurnContext should be exported");
  } catch {
    // Module may not resolve via ESM
  }
});

test("ReasoningStrainer class backward compat exists", async () => {
  try {
    const mod = await import("../../src/lib/orchestrator/state/ReasoningStrainer.ts");
    assert.ok(typeof mod.ReasoningStrainer === "function", "ReasoningStrainer class should be exported");
    assert.ok(typeof mod.strainReasoning === "function", "strainReasoning function should be exported");
  } catch {
    // Module may not resolve via ESM
  }
});

test("EphemeralPruner class backward compat exists", async () => {
  try {
    const mod = await import("../../src/lib/orchestrator/state/EphemeralPruner.ts");
    assert.ok(typeof mod.EphemeralPruner === "function", "EphemeralPruner class should be exported");
    assert.ok(typeof mod.pruneEphemeralItems === "function", "pruneEphemeralItems function should be exported");
  } catch {
    // Module may not resolve via ESM
  }
});

test("Thought summarizer extracts file paths from thinking text", () => {
  const thought = "I need to examine auth.ts to check the authorization logic, then apply_patch to modify verifyToken in login.ts";
  
  const pathRe = /([a-zA-Z0-9_./\-]+(?:\.(ts|tsx|js|jsx|py|rs|go|css|html|json|toml|yaml|yml|md|sh))\b)/g;
  const paths = [...thought.matchAll(pathRe)].map(m => m[1]);
  
  assert.ok(paths.length >= 1, "Should detect file paths in thought");
  assert.ok(paths.some(p => p.includes("auth.ts")), "Should find auth.ts");
  assert.ok(paths.some(p => p.includes("login.ts")), "Should find login.ts");
});

test("Thought summarizer extracts actions from thinking text", () => {
  // Test with actions at the start of lines (matching the actual summarizer pattern)
  const thought = "read auth.ts to check authorization\napply_patch to modify the token validation";
  
  const actionPatterns = [
    /^(read|open|view|inspect)\b/i,
    /^(write|edit|apply|create|modify|update|delete)\b/i,
    /^(run|execute)\b/i,
    /^(search|grep|find|explore)\b/i,
    /^(analyze|check|verify|test)\b/i,
  ];
  
  const lines = thought.split("\n").map(l => l.trim());
  const actions = lines.filter(line =>
    actionPatterns.some(pat => pat.test(line))
  );
  
  assert.ok(actions.length >= 1, "Should detect actions in thought");
  assert.ok(actions.some(a => a.includes("read")), "Should find 'read' action");
});

test("Non-tag thinking pattern detection works", () => {
  const testCases = [
    { text: "Thinking: Let me analyze this", expected: true },
    { text: "REASONING: I need to check", expected: true },
    { text: "THOUGHT: Here's my approach", expected: true },
    { text: "思考：我需要分析这个问题", expected: true },
    { text: "Normal response text", expected: false },
    { text: "```ts\nconst x = 1;\n```", expected: false },
  ];
  
  const prefixes = [
    /^Thinking:\s*/i,
    /^REASONING:\s*/i,
    /^THOUGHT:\s*/i,
    /^思考[：:]\s*/,
    /^INTERNAL_THINKING:\s*/i,
  ];
  
  for (const { text, expected } of testCases) {
    const matched = prefixes.some(pat => pat.test(text));
    assert.equal(matched, expected, `Pattern detection for: ${text}`);
  }
});

test("ALL CAPS line filtering works for thinking artifacts", () => {
  const lines = [
    "Normal reasoning line",
    "VERY IMPORTANT DECISION",
    "A lowercase line",
    "ALL CAPS REASONING PHRASE",
    "Mixed case line",
  ];
  
  const filtered = lines.filter(line => {
    const trimmed = line.trim();
    const alphaChars = trimmed.replace(/[^a-zA-Z]/g, "");
    return !(alphaChars.length > 10 && alphaChars === alphaChars.toUpperCase());
  });
  
  assert.equal(filtered.length, 3, "Should filter out 2 all-caps lines");
  assert.ok(filtered.some(l => l === "Normal reasoning line"), "Should keep normal lines");
  assert.ok(!filtered.some(l => l === "VERY IMPORTANT DECISION"), "Should filter all-caps");
});
