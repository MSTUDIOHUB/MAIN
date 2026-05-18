import test from "node:test";
import assert from "node:assert/strict";
import fsSync from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

import ts from "typescript";

const workspaceRoot = process.cwd();
const transpiledModuleCache = new Map();

function loadTranspiledModuleSync(sourcePath) {
  const normalizedPath = path.resolve(sourcePath);
  if (transpiledModuleCache.has(normalizedPath)) {
    return transpiledModuleCache.get(normalizedPath);
  }

  const source = fsSync.readFileSync(normalizedPath, "utf8");
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
    fileName: normalizedPath,
  }).outputText;

  const module = { exports: {} };
  transpiledModuleCache.set(normalizedPath, module.exports);
  const localRequire = createRequire(normalizedPath);
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
  buildToolResultPresentation,
  formatToolResultPresentationAsText,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/toolResultPresentation.ts"));

test("terminal presentation unwraps execute_command JSON output", () => {
  const raw = JSON.stringify({
    command: "npm run dev",
    output: "npm run dev\r\n\u001b[1m\u001b[31mzsh: command not found: npm\u001b[0m\r\n",
    startOffset: 0,
    endOffset: 64,
    truncated: false,
  });

  const presentation = buildToolResultPresentation({
    toolName: "execute_command",
    message: raw,
    language: "zh",
  });
  const text = formatToolResultPresentationAsText(presentation);

  assert.equal(presentation.command, "npm run dev");
  assert.match(text, /\$ npm run dev/);
  assert.match(text, /zsh: command not found: npm/);
  assert.doesNotMatch(text, /\\u001b|\u001b|\{"command"/);
});

test("terminal presentation decodes truncated JSON string values", () => {
  const raw = "{\"command\":\"which node\",\"output\":\"which node\\r\\n\\u001b[31mnode not found\\u001b[0m\\r\\n...";

  const presentation = buildToolResultPresentation({
    toolName: "execute_command",
    message: raw,
    language: "zh",
  });
  const text = formatToolResultPresentationAsText(presentation);

  assert.equal(presentation.command, "which node");
  assert.match(text, /node not found/);
  assert.doesNotMatch(text, /\\r\\n|\\u001b|\u001b|\{"command"/);
});

test("run_command presentation separates stdout, stderr, and status", () => {
  const raw = JSON.stringify({
    command: "npm test",
    stdout: "one passed\n",
    stderr: "warning\n",
    exitCode: 1,
    timedOut: false,
    durationMs: 1250,
    success: false,
    stdoutTruncated: false,
    stderrTruncated: false,
  });

  const presentation = buildToolResultPresentation({
    toolName: "run_command",
    message: raw,
    language: "en",
  });
  const text = formatToolResultPresentationAsText(presentation);

  assert.equal(presentation.command, "npm test");
  assert.deepEqual(
    presentation.sections.map((section) => section.label),
    ["stdout", "stderr"],
  );
  assert.ok(presentation.meta.includes("exit 1"));
  assert.ok(presentation.meta.includes("1.3s"));
  assert.match(text, /stdout\none passed/);
  assert.match(text, /stderr\nwarning/);
});

