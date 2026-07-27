import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";

const moduleCache = new Map();

function loadTs(sourcePath) {
  const normalized = path.resolve(sourcePath);
  if (moduleCache.has(normalized)) return moduleCache.get(normalized);
  const source = fs.readFileSync(normalized, "utf8");
  const localRequire = createRequire(normalized);
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
    fileName: normalized,
  }).outputText;
  const loaded = { exports: {} };
  moduleCache.set(normalized, loaded.exports);
  const runtimeRequire = (specifier) => {
    if (specifier.startsWith(".")) {
      const base = path.resolve(path.dirname(normalized), specifier);
      for (const candidate of [base, `${base}.ts`, path.join(base, "index.ts")]) {
        if (fs.existsSync(candidate) && candidate.endsWith(".ts")) {
          return loadTs(candidate);
        }
      }
    }
    return localRequire(specifier);
  };
  new Function("exports", "module", "require", output)(
    loaded.exports,
    loaded,
    runtimeRequire,
  );
  moduleCache.set(normalized, loaded.exports);
  return loaded.exports;
}

const protocol = loadTs(
  path.join(process.cwd(), "src/store/runtimeV2/planModelProtocol.ts"),
);

const evidence = [{
  id: "E1",
  target: "src/main.js",
  version: "sha-main",
  statement: "The active-file owner is implemented here.",
}];

function singletonSubmission(overrides = {}) {
  return {
    planMarkdown: "Use the retained evidence to update the active-file owner.",
    changes: {
      title: "Update active-file ownership",
      operation: "modify",
      targets: ["src/main.js"],
      change: "Keep one active-file identity through open and save.",
      expectedOutcome: "Open and save use the same file identity.",
      basis: ["E1"],
    },
    validations: {
      kind: "finite_command",
      command: "npm run build",
      expectedOutcome: "The finite build exits successfully.",
      required: true,
    },
    ...overrides,
  };
}

test("plan protocol safely normalizes unambiguous singleton array fields", () => {
  const compiled = protocol.workPlanDraftFromSubmission(
    singletonSubmission(),
    evidence,
    "Repair active-file ownership.",
  );

  assert.equal(compiled.draft.steps.length, 1);
  assert.equal(compiled.draft.validations.length, 1);
  assert.equal(compiled.draft.steps[0].targets[0], "src/main.js");
  assert.equal(compiled.draft.validations[0].command, "npm run build");
  assert.equal(compiled.normalized, true);
  assert.deepEqual(compiled.normalizationReasons, [
    "changes:singleton_object_to_array",
    "validations:singleton_object_to_array",
  ]);
});

test("plan protocol normalizes singleton objects encoded as JSON strings", () => {
  const submission = singletonSubmission();
  const compiled = protocol.workPlanDraftFromSubmission({
    ...submission,
    changes: JSON.stringify(submission.changes),
    validations: `${JSON.stringify(submission.validations)}\nI have submitted the plan.`,
  }, evidence, "Repair active-file ownership.");

  assert.equal(compiled.draft.steps.length, 1);
  assert.equal(compiled.draft.validations.length, 1);
  assert.deepEqual(compiled.normalizationReasons, [
    "changes:singleton_object_json_to_array",
    "validations:singleton_object_json_to_array",
  ]);
});

test("plan protocol still rejects ambiguous scalar array fields", () => {
  assert.throws(
    () => protocol.workPlanDraftFromSubmission(
      singletonSubmission({ changes: 42 }),
      evidence,
      "Repair active-file ownership.",
    ),
    /changes must be an array or JSON array string/,
  );
});
