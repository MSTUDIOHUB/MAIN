import test from "node:test";
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
  countRecentReadOnlyActivityForChat,
  resolveAssistantNoToolRecoveryRoute,
} = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/lib/orchestrator/loop/assistantNoToolRecoveryRouting.ts"),
);

function route(overrides = {}) {
  return resolveAssistantNoToolRecoveryRoute({
    workflowMode: "edit",
    runtimeIntent: "execute",
    finishReason: "stop",
    effectiveToolCallCount: 0,
    finalReplyOptionCount: 0,
    userVisibleText: "I will continue.",
    normalizedHiddenThought: "",
    compactedProseCodeDump: false,
    chatFinalSynthesisActive: false,
    recentReadOnlyActivityCountForChat: 0,
    consecutiveNoToolCount: 0,
    isCloudProfile: false,
    iterationToolCount: 0,
    pseudoToolCallPlaceholder: false,
    pseudoToolNameCandidate: null,
    usedToolUnavailableRecoveryPrompt: false,
    usedPseudoToolCallRecoveryPrompt: false,
    ...overrides,
  });
}

test("assistant no-tool recovery activates chat final synthesis before other routes", () => {
  const decision = route({
    workflowMode: "chat",
    runtimeIntent: "respond",
    finishReason: "length",
    userVisibleText: "Here is the answer so far.",
    normalizedHiddenThought: "hidden",
    isCloudProfile: true,
    iterationToolCount: 2,
  });

  assert.equal(decision.action, "activate_chat_final_synthesis");
  assert.equal(decision.reason, "length_no_tool_chat");
  assert.equal(decision.logContext.finishReason, "length");
  assert.equal(decision.logContext.hiddenThoughtChars, "hidden".length);
});

test("assistant no-tool recovery reprompts cloud tool-unavailable claims once", () => {
  const decision = route({
    isCloudProfile: true,
    iterationToolCount: 3,
    userVisibleText: "I cannot access local workspace files or tools.",
  });

  assert.equal(decision.action, "reprompt_tool_unavailable");
});

test("assistant no-tool recovery passes after tool-unavailable reprompt is already used", () => {
  const decision = route({
    isCloudProfile: true,
    iterationToolCount: 3,
    usedToolUnavailableRecoveryPrompt: true,
    userVisibleText: "I cannot access local workspace files or tools.",
  });

  assert.deepEqual(decision, { action: "pass" });
});

test("assistant no-tool recovery requests pseudo-tool repair before stopping", () => {
  const decision = route({
    pseudoToolCallPlaceholder: true,
    pseudoToolNameCandidate: "read_file",
  });

  assert.equal(decision.action, "reprompt_pseudo_tool");
  assert.equal(decision.requestedToolName, "read_file");
});

test("assistant no-tool recovery stops a repeated pseudo-tool repair loop", () => {
  const decision = route({
    pseudoToolCallPlaceholder: true,
    pseudoToolNameCandidate: null,
    usedPseudoToolCallRecoveryPrompt: true,
  });

  assert.equal(decision.action, "stop_pseudo_tool_doom_loop");
  assert.equal(decision.requestedToolName, "unknown");
  assert.equal(decision.messageToolName, null);
});

test("assistant no-tool recovery counts only succeeded read-only chat activity", () => {
  const count = countRecentReadOnlyActivityForChat({
    recentToolActivity: [
      { name: "read_file", status: "succeeded" },
      { name: "read_file", status: "failed" },
      { name: "list_files", status: "succeeded" },
      { name: "shell_exec", status: "succeeded" },
      { name: null, status: "succeeded" },
    ],
    readOnlyToolNames: new Set(["read_file", "list_files"]),
  });

  assert.equal(count, 2);
});
