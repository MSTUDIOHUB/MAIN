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
  if (transpiledModuleCache.has(normalizedPath)) return transpiledModuleCache.get(normalizedPath);
  const source = fsSync.readFileSync(normalizedPath, "utf8");
  const localRequire = createRequire(normalizedPath);
  const transpiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    fileName: normalizedPath,
  }).outputText;
  const module = { exports: {} };
  transpiledModuleCache.set(normalizedPath, module.exports);
  const runtimeRequire = (specifier) => {
    if (specifier.startsWith(".")) {
      const basePath = path.resolve(path.dirname(normalizedPath), specifier);
      for (const candidate of [basePath, `${basePath}.ts`, `${basePath}.tsx`, path.join(basePath, "index.ts")]) {
        if (!fsSync.existsSync(candidate)) continue;
        if (candidate.endsWith(".ts") || candidate.endsWith(".tsx")) {
          return loadTranspiledModuleSync(candidate);
        }
      }
    }
    return localRequire(specifier);
  };
  new Function("exports", "module", "require", transpiled)(module.exports, module, runtimeRequire);
  transpiledModuleCache.set(normalizedPath, module.exports);
  return module.exports;
}

const {
  classifyPlanGateViolation,
  createPlanAuthoringContract,
  formatPlanAuthoringContractForModel,
  resolvePlanAuthoringStage,
} = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/lib/planAuthoringContract.ts"),
);

const contextSignals = {
  imageParts: 1,
  mentionedFilePaths: ["src/lib/planRuntime.ts"],
  attachedFilePaths: ["debug.log", "src/lib/planRuntime.ts"],
  subagentPreference: "preferred",
};

test("Plan authoring contract is deterministic and keeps canonical objective plus input anchors", () => {
  const first = createPlanAuthoringContract({
    objective: "修复 Plan 审核终态，并补齐真实 OMLX 回归。",
    contextSignals,
  });
  const second = createPlanAuthoringContract({
    objective: "修复 Plan 审核终态，并补齐真实 OMLX 回归。",
    contextSignals,
  });

  assert.deepEqual(first, second);
  assert.equal(first.version, 2);
  assert.match(first.contractId, /^plan-[0-9a-f]{8}$/);
  assert.deepEqual(first.contextTargets, ["src/lib/planRuntime.ts", "debug.log"]);
  assert.deepEqual(first.reusableEvidenceTargets, []);
  assert.equal(first.imageCount, 1);
  assert.deepEqual(first.criteria, [
    "objective_coverage",
    "grounded_evidence",
    "decision_complete",
    "implementation_boundary",
    "executable_validation",
    "internal_consistency",
    "review_handoff",
  ]);
});

test("Plan authoring contract freezes reusable delegated evidence without relaxing execution rereads", () => {
  const contract = createPlanAuthoringContract({
    objective: "Plan a cross-file data contract repair.",
    contextSignals,
    recentPlanToolActivity: [{
      name: "read_file",
      target: "src/hooks/useCsvParser.ts",
      status: "succeeded",
      delegatedObservation: {
        owner: { agentKind: "subagent", subagentId: "child-a" },
        planningEvidenceState: "reusable",
        parentContextState: "reference_only",
        requiresParentReread: true,
      },
    }, {
      name: "read_file",
      target: "src/hooks/unresolved.ts",
      status: "failed",
      delegatedObservation: {
        owner: { agentKind: "subagent", subagentId: "child-b" },
        planningEvidenceState: "unresolved",
        parentContextState: "reference_only",
        requiresParentReread: true,
      },
    }],
  });
  const card = formatPlanAuthoringContractForModel({
    contract,
    runtime: { phase: "drafting" },
    language: "en",
  });

  assert.deepEqual(contract.reusableEvidenceTargets, ["src/hooks/useCsvParser.ts"]);
  assert.match(card, /Accepted delegated evidence: src\/hooks\/useCsvParser\.ts/);
  assert.match(card, /do not make the parent reread/i);
});

test("Plan stage card discloses acceptance criteria before drafting", () => {
  const contract = createPlanAuthoringContract({
    objective: "Refactor the Plan lifecycle.",
    contextSignals,
  });
  const card = formatPlanAuthoringContractForModel({
    contract,
    runtime: { phase: "explore_structure" },
    language: "en",
  });

  assert.match(card, /stage=understand/);
  assert.match(card, /Canonical objective: Refactor the Plan lifecycle/);
  assert.match(card, /Acceptance criteria:/);
  assert.match(card, /objective_coverage/);
  assert.match(card, /executable_validation/);
  assert.match(card, /quality gate may check only the predeclared criteria/i);
  assert.match(card, /one bounded read-only evidence action/);
  assert.match(card, /Artifact shape contract:/);
  assert.match(card, /Confirmed Evidence, Key Changes, Public APIs\/Interfaces\/Types/);
  assert.match(card, /never emit an empty 'Change\/Implement\/Modify:' label/i);
  assert.match(card, /Preserve established downstream required fields and public contracts by default/i);
  assert.match(card, /Do not emit fenced code blocks/i);
});

test("Plan revision card names the exact contract violation and requires a complete visible replacement", () => {
  const contract = createPlanAuthoringContract({
    objective: "修复类型契约矛盾。",
    contextSignals,
  });
  const card = formatPlanAuthoringContractForModel({
    contract,
    runtime: {
      phase: "needs_rewrite",
      qualityGateReason: "conflicting_plan_acceptance_assertions",
      missingSections: ["validation"],
    },
    language: "zh",
  });

  assert.match(card, /stage=revise/);
  assert.match(card, /当前违约：internal_consistency/);
  assert.match(card, /缺失项：validation/);
  assert.match(card, /重新输出完整 `<proposed_plan>`/);
  assert.match(card, /不能把修订稿仅放在隐藏 reasoning 中/);
  assert.equal(classifyPlanGateViolation("executable_validation_task_missing"), "executable_validation");
  assert.equal(resolvePlanAuthoringStage("review_ready"), "review");
});
