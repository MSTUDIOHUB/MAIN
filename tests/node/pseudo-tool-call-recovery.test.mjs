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
  buildExecuteXmlTextActionRecoveryPrompt,
  buildPseudoToolCallRecoveryPrompt,
  extractPseudoToolCallName,
  looksLikeNonStandardToolCallFormat,
  looksLikePseudoToolCallPlaceholder,
  recoverPseudoToolCallFromContext,
  shouldRecoverExecuteXmlTextWithoutAction,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/orchestrator.ts"));
const { TOOL_DEFINITIONS } = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/lib/toolSchemas.ts"),
);

test("detects bracketed pseudo tool call placeholders", () => {
  assert.equal(looksLikePseudoToolCallPlaceholder("[Tool call: read_file]"), true);
  assert.equal(looksLikePseudoToolCallPlaceholder("Tool call: read_file"), true);
  assert.equal(looksLikePseudoToolCallPlaceholder("工具调用: read_file"), true);
  assert.equal(extractPseudoToolCallName("[Tool call: read_file]"), "read_file");
});

test("does not treat real XML tool calls as pseudo placeholders", () => {
  assert.equal(
    looksLikePseudoToolCallPlaceholder("<tool_use><tool>read_file</tool><parameter name=\"path\">README.md</parameter></tool_use>"),
    false,
  );
});

test("detects non-standard tool_code wrapper as protocol mismatch", () => {
  assert.equal(
    looksLikeNonStandardToolCallFormat("<tool_code>list_directory(\"src\")</tool_code>"),
    true,
  );
  assert.equal(
    looksLikeNonStandardToolCallFormat("<tool_use><tool>read_file</tool></tool_use>"),
    false,
  );
});

test("XML pseudo tool recovery prompt requires tool_use with parameters", () => {
  const prompt = buildPseudoToolCallRecoveryPrompt("zh", "chat", true);

  assert.match(prompt, /不是可执行工具调用/);
  assert.match(prompt, /<tool_code>/);
  assert.match(prompt, /<tool_use>/);
  assert.match(prompt, /<parameter name="path">/);
  assert.match(prompt, /不要再输出 `\[Tool call: \.\.\.\]`、`<tool_code>/);
});

test("native pseudo tool recovery prompt uses schemas without XML", () => {
  const prompt = buildPseudoToolCallRecoveryPrompt("en", "chat", false);

  assert.match(prompt, /formal native tool call/i);
  assert.match(prompt, /active schema/i);
  assert.doesNotMatch(prompt, /XML|<tool_use>|<tool>|<parameter/i);
});

test("XML execute text recovery catches no-evidence plain text stops", () => {
  assert.equal(shouldRecoverExecuteXmlTextWithoutAction({
    workflowMode: "edit",
    turnIntent: "execute",
    runtimeIntent: "execute",
    forceXmlTools: true,
    availableToolCount: 8,
    toolCallCount: 0,
    replyOptionCount: 0,
    sawExecuteOperationEvidence: false,
    visibleText: "我会先检查配置文件，然后继续修复。",
  }), true);

  assert.equal(shouldRecoverExecuteXmlTextWithoutAction({
    workflowMode: "edit",
    turnIntent: "execute",
    runtimeIntent: "execute",
    forceXmlTools: true,
    availableToolCount: 8,
    toolCallCount: 0,
    replyOptionCount: 0,
    sawExecuteOperationEvidence: true,
    visibleText: "验证命令已经通过，修改完成。",
  }), false);

  assert.equal(shouldRecoverExecuteXmlTextWithoutAction({
    workflowMode: "edit",
    turnIntent: "execute",
    runtimeIntent: "execute",
    forceXmlTools: false,
    availableToolCount: 8,
    toolCallCount: 0,
    replyOptionCount: 0,
    sawExecuteOperationEvidence: false,
    visibleText: "我会先检查配置文件。",
  }), false);
});

test("XML execute text recovery prompt forces a canonical tool or user choice", () => {
  const prompt = buildExecuteXmlTextActionRecoveryPrompt({
    language: "zh",
    retryCount: 1,
    availableTools: ["read_file", "replace_in_file", "run_command"],
  });

  assert.match(prompt, /XML 工具协议/);
  assert.match(prompt, /read_file, replace_in_file, run_command/);
  assert.match(prompt, /<tool_use>/);
  assert.match(prompt, /<user_options>/);
  assert.match(prompt, /不要包裹解释或总结/);
});

test("XML execute text recovery example follows the active validation surface", () => {
  const prompt = buildExecuteXmlTextActionRecoveryPrompt({
    language: "en",
    retryCount: 1,
    availableTools: ["run_command"],
  });

  assert.match(prompt, /<tool>run_command<\/tool>/);
  assert.match(prompt, /<parameter name="command">/);
  assert.match(prompt, /<parameter name="description">/);
  assert.doesNotMatch(prompt, /<parameter name="cwd">/);
  assert.doesNotMatch(prompt, /<tool>read_file<\/tool>/);
});

test("XML execute text recovery examples follow each built-in required schema", () => {
  for (const tool of [
    "replace_in_file",
    "write_file",
    "apply_patch",
    "execute_command",
    "browser_evaluate",
    "computer_use",
    "read_pty_since",
    "git_status",
  ]) {
    const prompt = buildExecuteXmlTextActionRecoveryPrompt({
      language: "en",
      retryCount: 1,
      availableTools: [tool],
    });
    const definition = TOOL_DEFINITIONS.find(
      (candidate) => candidate.function.name === tool,
    );
    assert.ok(definition, `missing fixture schema for ${tool}`);
    const required = definition.function.parameters.required || [];
    for (const parameter of required) {
      assert.match(
        prompt,
        new RegExp(`<parameter name="${parameter}">`),
        `${tool} recovery example must include required ${parameter}`,
      );
    }
    assert.deepEqual(
      Array.from(
        prompt.matchAll(/<parameter name="([^"]+)">/g),
        (match) => match[1],
      ),
      required,
      `${tool} recovery example must contain exactly its required schema keys`,
    );
  }
});

test("recovers pseudo read_file into tabular analysis for a unique @ CSV", () => {
  const recovered = recoverPseudoToolCallFromContext({
    text: "[Tool call: read_file]",
    availableToolNames: ["read_file", "analyze_tabular_document"],
    mentionedPaths: ["/Users/michael/Desktop/DataFiles/orders.csv"],
    workflowMode: "plan",
    turnIntent: "plan",
  });

  assert.equal(recovered.call?.name, "analyze_tabular_document");
  assert.deepEqual(JSON.parse(recovered.call?.arguments || "{}"), {
    path: "/Users/michael/Desktop/DataFiles/orders.csv",
  });
  assert.equal(recovered.reason, "unique_tabular_mention");
});

test("does not recover pseudo tools when required parameters are ambiguous", () => {
  const recovered = recoverPseudoToolCallFromContext({
    text: "[Tool call: query_tabular_document]",
    availableToolNames: ["query_tabular_document"],
    mentionedPaths: ["/tmp/a.csv", "/tmp/b.csv"],
    workflowMode: "plan",
    turnIntent: "plan",
  });

  assert.equal(recovered.call, null);
  assert.equal(recovered.reason, "ambiguous_mentioned_paths");
});
