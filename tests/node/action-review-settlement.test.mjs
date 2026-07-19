import test from "node:test";
import assert from "node:assert/strict";
import fsSync from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";

const sourcePath = path.join(process.cwd(), "src/lib/actionReviewSettlement.ts");
const source = fsSync.readFileSync(sourcePath, "utf8");
const transpiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  fileName: sourcePath,
}).outputText;
const localRequire = createRequire(sourcePath);
const module = { exports: {} };
new Function("exports", "module", "require", transpiled)(module.exports, module, localRequire);
const { createAbortableReviewSettlement } = module.exports;

test("abort releases the review wait exactly once without starting a continuation", () => {
  const controller = new AbortController();
  const events = [];
  const settlement = createAbortableReviewSettlement({
    signal: controller.signal,
    abortedDecision: { action: "reject" },
    onContinue: () => events.push("continue"),
    onAbort: () => events.push("abort_cleanup"),
    onDecision: (decision) => events.push(`decision:${decision.action}`),
  });
  settlement.arm();
  controller.abort();

  assert.deepEqual(events, ["abort_cleanup", "decision:reject"]);
  assert.equal(settlement.isSettled(), true);
  assert.equal(settlement.resolve({ action: "accept" }), false);
  assert.deepEqual(events, ["abort_cleanup", "decision:reject"]);
});

test("an explicit decision starts one continuation while the lease is live", () => {
  const controller = new AbortController();
  const events = [];
  const settlement = createAbortableReviewSettlement({
    signal: controller.signal,
    abortedDecision: { action: "reject" },
    onContinue: () => events.push("continue"),
    onAbort: () => events.push("abort_cleanup"),
    onDecision: (decision) => events.push(`decision:${decision.action}`),
  });
  settlement.arm();

  assert.equal(settlement.resolve({ action: "accept" }), true);
  controller.abort();
  assert.deepEqual(events, ["continue", "decision:accept"]);
});

test("arming an already-aborted lease settles immediately", () => {
  const controller = new AbortController();
  controller.abort();
  const events = [];
  const settlement = createAbortableReviewSettlement({
    signal: controller.signal,
    abortedDecision: { action: "reject" },
    onContinue: () => events.push("continue"),
    onAbort: () => events.push("abort_cleanup"),
    onDecision: (decision) => events.push(`decision:${decision.action}`),
  });

  settlement.arm();
  assert.deepEqual(events, ["abort_cleanup", "decision:reject"]);
});
