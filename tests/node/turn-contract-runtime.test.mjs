import test from "node:test";
import assert from "node:assert/strict";
import fsSync from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";

const workspaceRoot = process.cwd();
const transpiledModuleCache = new Map();

function loadTranspiledModuleSync(sourcePath) {
  const normalizedPath = path.resolve(sourcePath);
  if (transpiledModuleCache.has(normalizedPath)) {
    return transpiledModuleCache.get(normalizedPath);
  }
  const source = fsSync.readFileSync(normalizedPath, "utf8");
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
    fileName: normalizedPath,
  }).outputText;
  const module = { exports: {} };
  transpiledModuleCache.set(normalizedPath, module.exports);
  const localRequire = createRequire(normalizedPath);
  const runtimeRequire = (specifier) => {
    if (specifier.startsWith(".")) {
      const basePath = path.resolve(path.dirname(normalizedPath), specifier);
      for (const candidate of [basePath, `${basePath}.ts`, path.join(basePath, "index.ts")]) {
        if (!fsSync.existsSync(candidate)) continue;
        if (candidate.endsWith(".ts")) return loadTranspiledModuleSync(candidate);
      }
    }
    return localRequire(specifier);
  };
  const factory = new Function("exports", "module", "require", transpiled);
  factory(module.exports, module, runtimeRequire);
  transpiledModuleCache.set(normalizedPath, module.exports);
  return module.exports;
}

const { resolveApprovedPlanTurnExpectations } = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/lib/orchestrator/loop/turnContractRuntime.ts"),
);

test("approved Plan projects a pending automatic validation into the turn contract", () => {
  const result = resolveApprovedPlanTurnExpectations({
    planApproved: true,
    tasks: [{
      id: "build",
      text: "Run the focused build",
      status: "pending",
      executionKind: "validation",
      evidenceStatus: "missing",
      evidence: [{ kind: "cmd", value: "npm run build" }],
    }],
    evidenceLedger: [],
  });

  assert.deepEqual(result, {
    workspaceMutationExpected: false,
    workspaceValidationExpected: true,
  });
});

test("approved Plan keeps manual user review advisory", () => {
  const result = resolveApprovedPlanTurnExpectations({
    planApproved: true,
    tasks: [{
      id: "native-dialog",
      text: "Confirm the native file dialog manually",
      status: "pending",
      executionKind: "validation",
      evidenceStatus: "requires_user_confirmation",
      validationCapability: "manual_user_validation",
      evidence: [{ kind: "manual_user_validation", value: "Open native dialog" }],
    }],
    evidenceLedger: [],
  });

  assert.deepEqual(result, {
    workspaceMutationExpected: false,
    workspaceValidationExpected: false,
  });
});

test("approved Plan does not misclassify a pending deliverable as validation", () => {
  const result = resolveApprovedPlanTurnExpectations({
    planApproved: true,
    tasks: [{
      id: "report",
      text: "Create the requested report",
      status: "pending",
      executionKind: "deliverable",
      evidenceStatus: "missing",
      evidence: [{ kind: "deliverable", value: "report.md" }],
    }],
    evidenceLedger: [],
  });

  assert.deepEqual(result, {
    workspaceMutationExpected: false,
    workspaceValidationExpected: false,
  });
});

test("approved Plan with temporarily unavailable tasks conservatively retains evidence validation", () => {
  assert.deepEqual(resolveApprovedPlanTurnExpectations({
    planApproved: true,
    tasks: [],
    evidenceLedger: [],
  }), {
    workspaceMutationExpected: false,
    workspaceValidationExpected: true,
  });
});

test("unapproved Plans do not project execution expectations", () => {
  assert.deepEqual(resolveApprovedPlanTurnExpectations({
    planApproved: false,
    tasks: [{
      id: "build",
      text: "Run build",
      status: "pending",
      executionKind: "validation",
      evidence: [{ kind: "cmd", value: "npm run build" }],
    }],
    evidenceLedger: [],
  }), {});
});
