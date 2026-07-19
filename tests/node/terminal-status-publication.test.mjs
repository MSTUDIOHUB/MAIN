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

test("a new run key starts a fresh idle publication transaction", async () => {
  const gate = createTerminalStatusPublicationGate();
  await gate.commitTerminal({
    runKey: "run-old",
    persistTerminalProjection: () => {},
    publishTerminalStatus: () => {},
  });
  assert.equal(gate.requestStatus("idle", "run-old").publishNow, true);
  assert.equal(gate.requestStatus("running", "run-new").publishNow, true);
  assert.deepEqual(gate.requestStatus("idle", "run-new"), {
    publishNow: false,
    deferredIdleCount: 1,
  });
});

test("late running callbacks cannot reopen a committed run key", async () => {
  const gate = createTerminalStatusPublicationGate();
  await gate.commitTerminal({
    runKey: "run-closed",
    persistTerminalProjection: () => true,
    publishTerminalStatus: () => {},
  });

  assert.deepEqual(gate.requestStatus("running", "run-closed"), {
    publishNow: false,
    deferredIdleCount: 0,
  });
  assert.equal(gate.requestStatus("idle", "run-closed").publishNow, true);
});

test("running callbacks cannot replace an in-flight terminal transaction", async () => {
  const gate = createTerminalStatusPublicationGate();
  let releasePersistence;
  const barrier = new Promise((resolve) => {
    releasePersistence = resolve;
  });
  let publishes = 0;
  const terminal = gate.commitTerminal({
    runKey: "run-in-flight",
    persistTerminalProjection: async () => {
      await barrier;
      return true;
    },
    publishTerminalStatus: () => {
      publishes += 1;
    },
  });

  assert.equal(gate.requestStatus("running", "run-in-flight").publishNow, false);
  releasePersistence();
  assert.equal(await terminal, true);
  assert.equal(publishes, 1);
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

  const retried = await gate.commitTerminal({
    persistTerminalProjection: () => true,
    publishTerminalStatus: () => {
      published = true;
    },
  });
  assert.equal(retried, true);
  assert.equal(published, true);
  assert.equal(gate.requestStatus("idle").publishNow, true);
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

  assert.equal(await gate.commitTerminal({
    persistTerminalProjection: () => true,
    publishTerminalStatus: () => {
      published = true;
    },
  }), true);
  assert.equal(published, true);
});

test("terminal publication is isolated and idempotent by run key", async () => {
  const gate = createTerminalStatusPublicationGate();
  const calls = [];

  gate.requestStatus("running", "run-a");
  assert.equal(gate.requestStatus("idle", "run-a").publishNow, false);
  gate.requestStatus("running", "run-b");
  assert.equal(gate.requestStatus("idle", "run-b").publishNow, false);

  assert.equal(await gate.commitTerminal({
    runKey: "run-a",
    persistTerminalProjection: () => {
      calls.push("persist-a");
      return true;
    },
    publishTerminalStatus: () => calls.push("publish-a"),
  }), true);
  assert.equal(gate.requestStatus("idle", "run-a").publishNow, true);
  assert.equal(gate.requestStatus("idle", "run-b").publishNow, false);

  assert.equal(await gate.commitTerminal({
    runKey: "run-a",
    persistTerminalProjection: () => {
      calls.push("unexpected-persist-a-replay");
      return true;
    },
    publishTerminalStatus: () => calls.push("unexpected-publish-a-replay"),
  }), true);
  assert.deepEqual(calls, ["persist-a", "publish-a"]);
});

test("concurrent terminal commits for one run share one durable transaction", async () => {
  const gate = createTerminalStatusPublicationGate();
  let releasePersistence;
  const persistenceBarrier = new Promise((resolve) => {
    releasePersistence = resolve;
  });
  let persistCount = 0;
  let publishCount = 0;

  const first = gate.commitTerminal({
    runKey: "run-concurrent",
    persistTerminalProjection: async () => {
      persistCount += 1;
      await persistenceBarrier;
      return true;
    },
    publishTerminalStatus: () => {
      publishCount += 1;
    },
  });
  const second = gate.commitTerminal({
    runKey: "run-concurrent",
    persistTerminalProjection: () => {
      persistCount += 100;
      return true;
    },
    publishTerminalStatus: () => {
      publishCount += 100;
    },
  });

  assert.equal(first, second);
  await Promise.resolve();
  assert.equal(persistCount, 1);
  releasePersistence();
  assert.deepEqual(await Promise.all([first, second]), [true, true]);
  assert.equal(persistCount, 1);
  assert.equal(publishCount, 1);
});
