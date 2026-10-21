import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

function loadCollaboration(mocks) {
  const fileName = path.resolve(
    "src/store/runtimeV2/planCollaboration.ts",
  );
  const output = ts.transpileModule(fs.readFileSync(fileName, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
    fileName,
  }).outputText;
  const module = { exports: {} };
  new Function("exports", "module", "require", output)(
    module.exports,
    module,
    (specifier) => {
      assert.ok(mocks.has(specifier), `Unexpected dependency: ${specifier}`);
      return mocks.get(specifier);
    },
  );
  return module.exports;
}

function restoreCompletedChild() {
  const summary = `${"Summary context. ".repeat(450)}SUMMARY_TAIL`;
  const finding = `${"Source finding. ".repeat(450)}FINDING_TAIL`;
  const childEvidence = {
    id: "child:report-projection:E1",
    kind: "subagent",
    target: "src/owner.ts",
    version: "child-observation-version",
  };
  const events = [{
    type: "subagent.completed",
    status: "completed",
    jobId: "report-child",
    evidence: [childEvidence],
    report: {
      schemaVersion: "runtime-v2-subagent-report.v1",
      summary,
      findings: [{ statement: finding, evidenceIds: [childEvidence.id] }],
      unresolved: [],
    },
  }];
  const anchors = new Map();
  const { createRuntimeV2PlanCollaboration } = loadCollaboration(new Map([
    ["../../lib/runtime-v2", {}],
    ["../../lib/subagents", {}],
    ["./executionSchedulerPort", {
      createRuntimeV2SchedulerPort: () => ({}),
    }],
    ["./executionProviderHistory", {
      upsertRuntimeV2ContextAnchor: (_live, anchor) => {
        anchors.set(anchor.key, anchor.content);
      },
    }],
    ["./executionTypes", {
      createRuntimeV2LiveExecutionState: () => ({}),
    }],
  ]));
  const evidence = [];
  const evidenceContents = new Map();
  const collaboration = createRuntimeV2PlanCollaboration({
    runner: { get: () => ({}), set: () => {}, context: {} },
    ledger: {
      snapshot: () => ({
        events,
        subagents: [{
          id: "report-child",
          scopeKey: "source-owner",
          allowedPaths: ["src/owner.ts"],
        }],
      }),
    },
    run: { runId: "parent-run" },
    messages: [],
    evidence,
    evidenceContents,
    deadlineAt: Infinity,
    logStoreEvent: () => {},
  });
  return {
    summary, finding, childEvidence, anchors, evidence, evidenceContents,
    collaboration,
  };
}

test("Plan restores the complete child summary and finding into its context anchor", () => {
  const { summary, finding, anchors } = restoreCompletedChild();
  const context = anchors.get("child:report-child");
  assert.equal(context.includes(`Report: ${summary}\n`), true);
  assert.equal(context.includes(`Finding: ${finding} (evidence:`), true);
  assert.equal(context.includes("SUMMARY_TAIL"), true);
  assert.equal(context.includes("FINDING_TAIL"), true);
});

test("Plan preserves the complete child statement without granting parent source authority", () => {
  const { finding, childEvidence, evidence } = restoreCompletedChild();
  assert.equal(evidence[0]?.id, childEvidence.id);
  assert.equal(evidence[0]?.target, childEvidence.target);
  assert.equal(evidence[0]?.version, null);
  assert.equal(evidence[0]?.statement === finding, true);
});

test("Plan retains child evidence contents beyond the former projection window", () => {
  const {
    summary, finding, childEvidence, evidence, evidenceContents, collaboration,
  } = restoreCompletedChild();
  assert.equal(evidence[0]?.id, childEvidence.id);
  assert.equal(evidence[0]?.target, childEvidence.target);
  assert.equal(evidence[0]?.version, null);
  const expectedContents = `Child report: ${summary}\nFinding: ${finding}`;
  assert.ok(expectedContents.indexOf("FINDING_TAIL") > 10_000);
  assert.equal(evidenceContents.get(childEvidence.id) === expectedContents, true);

  collaboration.syncChildEvidence();
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0]?.version, null);
  assert.equal(evidenceContents.get(childEvidence.id) === expectedContents, true);
});
