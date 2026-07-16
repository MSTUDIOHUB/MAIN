import test from "node:test";
import assert from "node:assert/strict";
import fsSync from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";

const sourcePath = path.join(process.cwd(), "src/lib/terminalStatusPublication.ts");
const source = fsSync.readFileSync(sourcePath, "utf8");
const transpiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  fileName: sourcePath,
}).outputText;
const localRequire = createRequire(sourcePath);
const module = { exports: {} };
new Function("exports", "module", "require", transpiled)(module.exports, module, localRequire);
const { createTerminalStatusPublicationGate } = module.exports;

test("terminal status gate persists the terminal projection before publishing idle", () => {
  const gate = createTerminalStatusPublicationGate();
  const order = [];

  assert.deepEqual(gate.requestStatus("idle"), {
    publishNow: false,
    deferredIdleCount: 1,
  });
  assert.deepEqual(order, []);

  gate.commitTerminal({
    persistTerminalProjection: () => order.push("persist_terminal_projection"),
    publishTerminalStatus: () => order.push("publish_idle"),
  });

  assert.deepEqual(order, ["persist_terminal_projection", "publish_idle"]);
  assert.equal(gate.requestStatus("idle").publishNow, true);
});

test("a resumed running phase starts a fresh idle publication transaction", () => {
  const gate = createTerminalStatusPublicationGate();
  gate.commitTerminal({
    persistTerminalProjection: () => {},
    publishTerminalStatus: () => {},
  });
  assert.equal(gate.requestStatus("idle").publishNow, true);
  assert.equal(gate.requestStatus("running").publishNow, true);
  assert.deepEqual(gate.requestStatus("idle"), {
    publishNow: false,
    deferredIdleCount: 1,
  });
});
