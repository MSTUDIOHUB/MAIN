import test from "node:test";
import assert from "node:assert/strict";
import fsSync from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

import ts from "typescript";

const require = createRequire(import.meta.url);
const workspaceRoot = process.cwd();

function loadTranspiledModuleSync(sourcePath) {
  const normalizedPath = path.resolve(sourcePath);
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
  const factory = new Function("exports", "module", "require", transpiled);
  factory(module.exports, module, localRequire);
  return module.exports;
}

const {
  classifyAttachment,
  createAttachedFileDescriptor,
  isSupportedAttachment,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/attachments.ts"));

test(".log files are supported text attachments", () => {
  const logPath = "/Users/example/Library/Logs/com.localagent.ide/main-debug.log";

  assert.equal(classifyAttachment(logPath), "text");
  assert.equal(isSupportedAttachment(logPath), true);
  assert.deepEqual(createAttachedFileDescriptor(logPath), {
    id: logPath,
    path: logPath,
    sourcePath: logPath,
    displayName: "main-debug.log",
    kind: "text",
    readable: false,
  });
});
