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

const { trimMessagesToContextDetailed } = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/lib/contextTrim.ts"),
);

test("compact summary does not re-inject synthetic continuation constraints", () => {
  const messages = [
    { role: "system", content: "System prompt" },
    {
      role: "user",
      content: "请继续执行你的计划。注意以下规则：不要询问用户指示，你自己做决定并执行。",
    },
    {
      role: "assistant",
      content: "Please continue executing your plan. Do not ask the user what to do next.",
    },
    {
      role: "user",
      content: "请修复会话标题错乱，并且必须保留当前会话分页行为。",
    },
    {
      role: "tool",
      content: "ok",
    },
  ];

  const result = trimMessagesToContextDetailed(messages, 90, 24);
  assert.ok(result.removedCount > 0, "expected old messages to be compacted");
  const summary = [result.markerSummary || "", result.displaySummary || ""].join("\n");
  assert.equal(summary.includes("不要询问用户指示"), false);
  assert.equal(summary.includes("Do not ask the user what to do next"), false);
});

test("trimMessagesToContextDetailed always retains the latest user message under extreme budget pressure", () => {
  const messages = [
    { role: "system", content: "Very large system prompt ".repeat(500) }, // ~2500 tokens
    { role: "user", content: "First user query" },
    { role: "assistant", content: "First assistant response" },
    { role: "user", content: "Latest user query" },
  ];

  // Set the context limit to 1000 tokens (less than system message tokens)
  const result = trimMessagesToContextDetailed(messages, 1000, 200);

  // Even though remaining budget is <= 0 after system message, the system message and the latest user query MUST be retained!
  const roles = result.messages.map(m => m.role);
  assert.deepEqual(roles, ["system", "user"]);
  assert.equal(result.messages[0].content.startsWith("Very large system prompt"), true);
  assert.equal(result.messages[1].content, "Latest user query");
});
