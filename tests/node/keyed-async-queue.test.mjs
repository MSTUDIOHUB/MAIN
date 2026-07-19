import test from "node:test";
import assert from "node:assert/strict";
import fsSync from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";

function loadTranspiledModuleSync(sourcePath) {
  const normalizedPath = path.resolve(sourcePath);
  const source = fsSync.readFileSync(normalizedPath, "utf8");
  const localRequire = createRequire(normalizedPath);
  const transpiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    fileName: normalizedPath,
  }).outputText;
  const module = { exports: {} };
  new Function("exports", "module", "require", transpiled)(module.exports, module, localRequire);
  return module.exports;
}

const { createKeyedAsyncQueue } = loadTranspiledModuleSync(
  path.join(process.cwd(), "src/lib/keyedAsyncQueue.ts"),
);

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test("mutations for one durable owner cannot complete out of invocation order", async () => {
  const queue = createKeyedAsyncQueue();
  const firstGate = deferred();
  const calls = [];
  const first = queue.run("workspace:7", async () => {
    calls.push("first:start");
    await firstGate.promise;
    calls.push("first:end");
    return "first";
  });
  const second = queue.run("workspace:7", async () => {
    calls.push("second:start");
    return "second";
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ["first:start"]);
  assert.equal(queue.pendingKeyCount(), 1);
  firstGate.resolve();
  assert.deepEqual(await Promise.all([first, second]), ["first", "second"]);
  assert.deepEqual(calls, ["first:start", "first:end", "second:start"]);
  assert.equal(queue.pendingKeyCount(), 0);
});

test("different durable owners remain concurrent", async () => {
  const queue = createKeyedAsyncQueue();
  const firstGate = deferred();
  const calls = [];
  const first = queue.run("workspace:7", async () => {
    calls.push("first");
    await firstGate.promise;
  });
  const second = queue.run("workspace:8", async () => {
    calls.push("second");
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ["first", "second"]);
  assert.equal(queue.pendingKeyCount(), 1);
  firstGate.resolve();
  await Promise.all([first, second]);
  assert.equal(queue.pendingKeyCount(), 0);
});

test("a rejected mutation releases the next mutation for the same owner", async () => {
  const queue = createKeyedAsyncQueue();
  const calls = [];
  const first = queue.run("workspace:7", async () => {
    calls.push("first");
    throw new Error("disk unavailable");
  });
  const second = queue.run("workspace:7", async () => {
    calls.push("second");
    return "saved";
  });

  await assert.rejects(first, /disk unavailable/);
  assert.equal(await second, "saved");
  assert.deepEqual(calls, ["first", "second"]);
  assert.equal(queue.pendingKeyCount(), 0);
});
