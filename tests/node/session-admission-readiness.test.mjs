import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";

function loadModule(sourcePath) {
  const source = fs.readFileSync(sourcePath, "utf8");
  const transpiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    fileName: sourcePath,
  }).outputText;
  const module = { exports: {} };
  new Function("exports", "module", "require", transpiled)(
    module.exports,
    module,
    createRequire(sourcePath),
  );
  return module.exports;
}

const readiness = loadModule(
  path.join(process.cwd(), "src/store/sessionAdmissionReadiness.ts"),
);

test.afterEach(() => readiness.resetSessionAdmissionReadinessForTests());

test("admission waits for the exact Session restore lease", async () => {
  const lease = readiness.beginSessionAdmissionRestore({
    sessionKey: "/repo:7",
    sessionEpoch: "epoch-7",
  });
  let settled = false;
  const waiting = readiness.waitForSessionAdmissionReadiness({
    sessionKey: "/repo:7",
    sessionEpoch: "epoch-7",
  }).then((result) => {
    settled = true;
    return result;
  });
  await Promise.resolve();
  assert.equal(settled, false);
  assert.equal(readiness.settleSessionAdmissionRestore(lease), true);
  assert.equal(await waiting, "ready");
});

test("a replacement restore cannot be released by a stale lease", async () => {
  const stale = readiness.beginSessionAdmissionRestore({
    sessionKey: "/repo:8",
    sessionEpoch: "epoch-8",
  });
  const current = readiness.beginSessionAdmissionRestore({
    sessionKey: "/repo:8",
    sessionEpoch: "epoch-8",
  });
  assert.equal(readiness.settleSessionAdmissionRestore(stale), false);
  const waiting = readiness.waitForSessionAdmissionReadiness({
    sessionKey: "/repo:8",
    sessionEpoch: "epoch-8",
  });
  readiness.settleSessionAdmissionRestore(current);
  assert.equal(await waiting, "ready");
});

test("admission fails closed across a Session epoch change", async () => {
  readiness.beginSessionAdmissionRestore({
    sessionKey: "/repo:9",
    sessionEpoch: "new-epoch",
  });
  assert.equal(await readiness.waitForSessionAdmissionReadiness({
    sessionKey: "/repo:9",
    sessionEpoch: "old-epoch",
  }), "owner_changed");
});
