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

test("terminal status gate awaits the terminal projection before publishing idle", async () => {
  const gate = createTerminalStatusPublicationGate();
  const order = [];

  assert.deepEqual(gate.requestStatus("idle"), {
    publishNow: false,
    deferredIdleCount: 1,
  });
  assert.deepEqual(order, []);

  const commit = gate.commitTerminal({
    persistTerminalProjection: async () => {
      order.push("persist_terminal_projection_started");
      await Promise.resolve();
      order.push("persist_terminal_projection_finished");
    },
    publishTerminalStatus: () => order.push("publish_idle"),
  });

  assert.deepEqual(order, ["persist_terminal_projection_started"]);
  assert.equal(gate.requestStatus("idle").publishNow, false);
  await commit;
  assert.deepEqual(order, [
    "persist_terminal_projection_started",
    "persist_terminal_projection_finished",
    "publish_idle",
  ]);
  assert.equal(gate.requestStatus("idle").publishNow, true);
});

test("a resumed running phase starts a fresh idle publication transaction", async () => {
  const gate = createTerminalStatusPublicationGate();
  await gate.commitTerminal({
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

test("a failed durable write never publishes idle", async () => {
  const gate = createTerminalStatusPublicationGate();
  let published = false;

  await assert.rejects(
    gate.commitTerminal({
      persistTerminalProjection: async () => {
        throw new Error("disk unavailable");
      },
      publishTerminalStatus: () => {
        published = true;
      },
    }),
    /disk unavailable/,
  );

  assert.equal(published, false);
  assert.equal(gate.requestStatus("idle").publishNow, false);
});

test("lost run ownership cancels terminal publication without publishing idle", async () => {
  const gate = createTerminalStatusPublicationGate();
  let published = false;

  const committed = await gate.commitTerminal({
    persistTerminalProjection: async () => false,
    publishTerminalStatus: () => {
      published = true;
    },
  });

  assert.equal(committed, false);
  assert.equal(published, false);
  assert.equal(gate.requestStatus("idle").publishNow, false);
});
