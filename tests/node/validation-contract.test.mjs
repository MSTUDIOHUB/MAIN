import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";

const workspaceRoot = process.cwd();
const moduleCache = new Map();

function loadTranspiledModuleSync(sourcePath) {
  const normalizedPath = path.resolve(sourcePath);
  if (moduleCache.has(normalizedPath)) return moduleCache.get(normalizedPath);
  const source = fs.readFileSync(normalizedPath, "utf8");
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
    fileName: normalizedPath,
  }).outputText;
  const module = { exports: {} };
  moduleCache.set(normalizedPath, module.exports);
  const localRequire = createRequire(normalizedPath);
  const runtimeRequire = (specifier) => {
    if (specifier.startsWith(".")) {
      const basePath = path.resolve(path.dirname(normalizedPath), specifier);
      for (const candidate of [basePath, `${basePath}.ts`, `${basePath}.tsx`, path.join(basePath, "index.ts")]) {
        if (!fs.existsSync(candidate)) continue;
        if (candidate.endsWith(".ts") || candidate.endsWith(".tsx")) {
          return loadTranspiledModuleSync(candidate);
        }
      }
    }
    return localRequire(specifier);
  };
  const factory = new Function("exports", "module", "require", transpiled);
  factory(module.exports, module, runtimeRequire);
  moduleCache.set(normalizedPath, module.exports);
  return module.exports;
}

const {
  analyzeValidationCommand,
  createValidationCommandSpec,
  evaluateValidationSpec,
  isAcceptanceCapableValidationSpec,
  validationPrimitiveClass,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/validationContract.ts"));

test("finite command analysis proves every fail-fast shell segment", () => {
  const analysis = analyzeValidationCommand("cd frontend && CI=1 npm test && npm run build");
  assert.equal(analysis.rejectionReason, null);
  assert.equal(analysis.spec?.kind, "finite_command");
  assert.deepEqual(analysis.segments.map((segment) => segment.role), [
    "prelude",
    "validator",
    "validator",
  ]);
  assert.equal(isAcceptanceCapableValidationSpec(analysis.spec), true);

  const mixed = analyzeValidationCommand("npm test && node server.js");
  assert.equal(mixed.spec, null);
  assert.equal(mixed.rejectionReason, "mixed_service_and_acceptance");

  for (const command of [
    "npm test || true",
    "npm test; npm run build",
    "npm test | tee test.log",
    "npm test &",
  ]) {
    assert.equal(analyzeValidationCommand(command).spec, null, command);
  }
});

test("inline commands require decidable failure semantics and reject resident runtimes", () => {
  for (const command of [
    "node -e \"const value = 1; if (value !== 1) process.exit(1)\"",
    "python3 -c \"assert 1 == 1\"",
    "npx ts-node --eval \"if (1 !== 1) throw new Error('mismatch')\"",
  ]) {
    assert.equal(createValidationCommandSpec(command)?.kind, "finite_command", command);
  }

  for (const command of [
    "node -e \"console.log('looks good')\"",
    "node -e \"throw new Error('unconditional failure')\"",
    "node -e \"setInterval(() => {}, 1000)\"",
    "node -e \"require('node:http').createServer(() => {}).listen(3000)\"",
    "python3 -c \"while True: pass\"",
  ]) {
    assert.notEqual(createValidationCommandSpec(command)?.kind, "finite_command", command);
  }
});

test("service observation records readiness but cannot satisfy acceptance", () => {
  const spec = createValidationCommandSpec("npm run tauri dev", {
    cwd: ".",
    ownerKey: "terminal:tauri",
  });
  assert.equal(spec?.kind, "service_observation");
  assert.equal(validationPrimitiveClass(spec), "service_observation");
  assert.equal(isAcceptanceCapableValidationSpec(spec), false);

  const evaluation = evaluateValidationSpec(spec, [{
    kind: "service_observation_result",
    evidenceId: "pty-2",
    ownerKey: "terminal:tauri",
    status: "ready",
  }]);
  assert.equal(evaluation.status, "observed");
  assert.equal(evaluation.acceptanceSatisfied, false);
  assert.equal(evaluation.canSatisfyAcceptance, false);
});

test("browser and desktop validation consume structured action/assertion results", () => {
  const spec = {
    kind: "browser_interaction",
    acceptance: "required",
    actions: [{ id: "open", kind: "click", target: "#open-button" }],
    assertions: [{ kind: "visibility", target: "#save-dialog", afterActionId: "open" }],
    requireCausalAssertion: true,
  };
  assert.equal(validationPrimitiveClass(spec), "interaction");
  assert.equal(isAcceptanceCapableValidationSpec(spec), true);

  const nonCausal = evaluateValidationSpec(spec, [{
    kind: "browser_interaction_result",
    evidenceId: "browser-1",
    actions: [{ id: "open", kind: "click", target: "#open-button", succeeded: true }],
    assertions: [{
      kind: "visibility",
      target: "#save-dialog",
      afterActionId: "open",
      passed: true,
      causallyLinked: false,
    }],
  }]);
  assert.equal(nonCausal.acceptanceSatisfied, false);

  const causal = evaluateValidationSpec(spec, [{
    kind: "browser_interaction_result",
    evidenceId: "browser-2",
    actions: [{ id: "open", kind: "click", target: "#open-button", succeeded: true }],
    assertions: [{
      kind: "visibility",
      target: "#save-dialog",
      afterActionId: "open",
      passed: true,
      beforePassed: false,
      changedAfterAction: true,
      causallyLinked: true,
    }],
  }]);
  assert.equal(causal.status, "satisfied");
  assert.equal(causal.acceptanceSatisfied, true);
});

test("unknown interaction verbs and producer-free assertions cannot claim acceptance", () => {
  assert.equal(isAcceptanceCapableValidationSpec({
    kind: "browser_interaction",
    acceptance: "required",
    actions: [{ id: "magic", kind: "do_anything", target: "#save" }],
    assertions: [{ kind: "visibility", target: "#done", afterActionId: "magic" }],
    requireCausalAssertion: true,
  }), false);
  assert.equal(isAcceptanceCapableValidationSpec({
    kind: "browser_interaction",
    acceptance: "required",
    actions: [{ id: "save", kind: "click", target: "#save" }],
    assertions: [{ kind: "made_up_assertion", target: "#done", afterActionId: "save" }],
    requireCausalAssertion: true,
  }), false);
  const unboundAssertion = {
    kind: "assertion",
    acceptance: "required",
    target: "anything the model says",
    matcher: "runtime_result",
  };
  assert.equal(isAcceptanceCapableValidationSpec(unboundAssertion), false);
  assert.equal(evaluateValidationSpec(unboundAssertion, []).status, "invalid");
});

test("standalone assertions remain advisory even when matching evidence exists", () => {
  const assertion = {
    kind: "assertion",
    acceptance: "advisory",
    target: "artifact:dist/app.js",
    matcher: "exists",
    producer: "artifact_store",
  };
  const accepted = evaluateValidationSpec(assertion, [{
    kind: "assertion_result",
    evidenceId: "artifact-1",
    target: "artifact:dist/app.js",
    producer: "artifact_store",
    passed: true,
  }]);
  assert.equal(isAcceptanceCapableValidationSpec(assertion), false);
  assert.equal(accepted.status, "advisory");
  assert.equal(accepted.acceptanceSatisfied, false);
  assert.equal(accepted.canSatisfyAcceptance, false);

  const advisory = {
    kind: "advisory",
    acceptance: "advisory",
    note: "user reviews final visual polish",
    owner: "user",
  };
  assert.equal(validationPrimitiveClass(advisory), "assertion");
  assert.equal(isAcceptanceCapableValidationSpec(advisory), false);
  assert.equal(evaluateValidationSpec(advisory, []).status, "advisory");
});

test("an advisory diagnostic assertion stays non-accepting even when its text was observed", () => {
  const diagnosticObservation = {
    kind: "assertion",
    acceptance: "advisory",
    target: "runtime:debug.save-path-transition",
    matcher: "runtime_result",
    producer: "runtime_evidence_ledger",
  };
  const evaluation = evaluateValidationSpec(diagnosticObservation, [{
    kind: "assertion_result",
    evidenceId: "diagnostic-log-1",
    target: diagnosticObservation.target,
    producer: "runtime_evidence_ledger",
    passed: true,
  }]);

  assert.equal(isAcceptanceCapableValidationSpec(diagnosticObservation), false);
  assert.equal(evaluation.status, "advisory");
  assert.equal(evaluation.acceptanceSatisfied, false);
  assert.equal(evaluation.canSatisfyAcceptance, false);
});
