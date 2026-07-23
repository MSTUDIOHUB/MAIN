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
  planObjectiveRequiresDiagnosis,
  planObjectiveSuggestsDiagnosis,
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
  assert.equal(first.version, 11);
  assert.match(first.contractId, /^plan-[0-9a-f]{8}$/);
  assert.deepEqual(first.facets, [{
    id: "G1",
    index: 1,
    text: "修复 Plan 审核终态，并补齐真实 OMLX 回归。",
  }]);
  assert.deepEqual(first.contextTargets, ["src/lib/planRuntime.ts", "debug.log"]);
  assert.deepEqual(first.reusableEvidenceTargets, []);
  assert.equal(first.imageCount, 1);
  assert.equal(first.diagnosisRequired, false);
  assert.equal(first.diagnosisSuggested, false);
  assert.equal(first.diagnosisRequirementSource, "unspecified_default");
  assert.deepEqual(first.criteria, [
    "objective_coverage",
    "grounded_evidence",
    "epistemic_classification",
    "decision_complete",
    "implementation_boundary",
    "executable_validation",
    "internal_consistency",
    "review_handoff",
  ]);
});

test("Plan authoring contract freezes numbered outcomes before drafting", () => {
  const contract = createPlanAuthoringContract({
    objective: [
      "问题：",
      "1、编辑界面不要重复显示文件名。",
      "2、打开本地文件后不要误触发保存窗口。",
    ].join("\n"),
    contextSignals,
  });
  const card = formatPlanAuthoringContractForModel({
    contract,
    runtime: { phase: "drafting" },
    language: "zh",
  });

  assert.deepEqual(contract.facets, [
    { id: "G1", index: 1, text: "编辑界面不要重复显示文件名。" },
    { id: "G2", index: 2, text: "打开本地文件后不要误触发保存窗口。" },
  ]);
  assert.match(card, /冻结的独立目标分面：/);
  assert.match(card, /G1：编辑界面不要重复显示文件名/);
  assert.match(card, /G2：打开本地文件后不要误触发保存窗口/);
  assert.match(card, /诊断链要求：不强制 R/);
  assert.match(card, /诊断\/修复任务的每个分面必须用可解析引用形成 G -> E -> R -> C/);
  assert.match(card, /分面追踪行本身的目标复述不算证据/);
});

test("Plan authoring freezes an explicit diagnostic outcome before drafting", () => {
  const contract = createPlanAuthoringContract({
    objective: "找到打开文件后弹出保存窗口的根本原因并修复。",
    contextSignals: { ...contextSignals, diagnosisRequirement: "required" },
  });
  const card = formatPlanAuthoringContractForModel({
    contract,
    runtime: { phase: "drafting" },
    language: "zh",
  });

  assert.equal(contract.diagnosisRequired, true);
  assert.equal(contract.diagnosisRequirementSource, "explicit_runtime_intent");
  assert.equal(contract.diagnosisSuggested, true);
  assert.equal(planObjectiveRequiresDiagnosis("Identify why opening a file triggers save, then fix it."), true);
  assert.equal(planObjectiveSuggestsDiagnosis("Identify why opening a file triggers save, then fix it."), true);
  assert.equal(planObjectiveRequiresDiagnosis("Add an offline draft queue."), false);
  assert.match(card, /诊断链要求：必须为每个目标分面建立 E -> R -> C\/D 关系/);
  assert.match(card, /authority=explicit_runtime_intent/);
});

test("diagnosis quality authority is structured and language-isomorphic", () => {
  const objectives = [
    "Identify the root cause and repair the file-open flow.",
    "查明文件打开流程的根因并修复。",
    "Identifique la causa raíz y repare el flujo de apertura de archivos.",
  ];
  const contracts = objectives.map((objective) => createPlanAuthoringContract({
    objective,
    contextSignals: { ...contextSignals, diagnosisRequirement: "required" },
  }));
  assert.deepEqual(
    contracts.map(({ diagnosisRequired, diagnosisRequirementSource }) => ({
      diagnosisRequired,
      diagnosisRequirementSource,
    })),
    objectives.map(() => ({
      diagnosisRequired: true,
      diagnosisRequirementSource: "explicit_runtime_intent",
    })),
  );

  const suggestionsOnly = objectives.map((objective) => createPlanAuthoringContract({
    objective,
    contextSignals,
  }));
  assert.deepEqual(suggestionsOnly.map((contract) => contract.diagnosisRequired), [false, false, false]);
  assert.ok(suggestionsOnly.some((contract) => contract.diagnosisSuggested));
  assert.ok(suggestionsOnly.some((contract) => !contract.diagnosisSuggested));
});

test("Plan authoring contract exposes only parent-verified delegated evidence as reusable", () => {
  const withoutEvidence = createPlanAuthoringContract({
    objective: "Plan a cross-file data contract repair.",
    contextSignals,
  });
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
        joinState: "consumed",
        closureState: "satisfied",
        parentContextState: "reference_only",
        requiresParentReread: true,
      },
    }, {
      name: "read_file",
      target: "src/hooks/verifiedParser.ts",
      status: "succeeded",
      delegatedObservation: {
        owner: { agentKind: "subagent", subagentId: "child-verified" },
        planningEvidenceState: "reusable",
        joinState: "consumed",
        closureState: "satisfied",
        parentContextState: "full",
        requiresParentReread: false,
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

  assert.deepEqual(contract.reusableEvidenceTargets, ["src/hooks/verifiedParser.ts"]);
  assert.equal(contract.contractId, withoutEvidence.contractId);
  assert.match(card, /Accepted delegated evidence: src\/hooks\/verifiedParser\.ts/);
  assert.doesNotMatch(card, /Accepted delegated evidence:[^\n]*useCsvParser/);
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
  assert.match(card, /root cause must prove runtime reachability/i);
  assert.match(card, /When the issue crosses an interface.*compare both sides of that contract/i);
  assert.match(card, /definition-only or unreferenced alternate path is not a confirmed cause/i);
  assert.match(card, /Files that remain unchanged belong only in preserved-contract or validation evidence/i);
  assert.match(card, /Do not emit fenced code blocks/i);
  const draftCard = formatPlanAuthoringContractForModel({
    contract,
    runtime: { phase: "drafting" },
    language: "en",
  });
  assert.match(draftCard, /Minimum valid validation primitive shapes/);
  assert.match(draftCard, /finite_command \(required\)/);
  assert.match(draftCard, /service_observation \(advisory/);
  assert.match(draftCard, /browser_interaction \(required\)/);
  assert.match(draftCard, /desktop_interaction \(required\)/);
  assert.match(draftCard, /assertion \(advisory only.*matcher.*equals\|not_equals\|contains\|matches\|exists\|not_exists\|runtime_result/i);
  assert.match(draftCard, /producer.*runtime_evidence_ledger\|workspace_file_state\|artifact_store/i);
  assert.match(draftCard, /advisory \(advisory/);
  assert.match(draftCard, /<EVIDENCE_BACKED_CHANGE_TARGET>/);
  assert.match(draftCard, /<NEW_HARNESS_TARGET_IN_EVIDENCE_OWNER_MODULE>/);
  assert.doesNotMatch(draftCard, /tests\/harness\.test\.js|"targetOwnerRef":"package\.json"/);
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
    submissionTransport: "text_envelope",
  });

  assert.match(card, /stage=revise/);
  assert.match(card, /当前违约：internal_consistency/);
  assert.match(card, /缺失项：validation/);
  assert.match(card, /必须输出一个完整 `<plan_candidate>`/);
  assert.match(card, /不能把修订稿仅放在隐藏 reasoning 中/);
  assert.equal(classifyPlanGateViolation("executable_validation_task_missing"), "executable_validation");
  assert.equal(
    classifyPlanGateViolation("unverified_diagnostic_claim_as_confirmed"),
    "epistemic_classification",
  );
  assert.equal(resolvePlanAuthoringStage("review_ready"), "review");
});

test("native and text Plan submission transports give one non-contradictory instruction", () => {
  const contract = createPlanAuthoringContract({
    objective: "Repair the Plan rewrite handoff.",
    contextSignals,
  });
  const runtime = {
    phase: "needs_rewrite",
    qualityGateReason: "conflicting_plan_acceptance_assertions",
  };
  const nativeCard = formatPlanAuthoringContractForModel({
    contract,
    runtime,
    language: "en",
    submissionTransport: "native_tool",
  });
  const textCard = formatPlanAuthoringContractForModel({
    contract,
    runtime,
    language: "en",
    submissionTransport: "text_envelope",
  });

  assert.match(nativeCard, /Submission transport: native tool submit_plan_candidate/);
  assert.match(nativeCard, /call `submit_plan_candidate` exactly once with the complete typed graph/i);
  assert.match(nativeCard, /do not emit `<plan_candidate>` in prose or reasoning/i);
  assert.doesNotMatch(nativeCard, /emit (?:one|a) complete `<plan_candidate>`/i);
  assert.doesNotMatch(nativeCard, /<plan_candidate>\{"schemaVersion"/);

  assert.match(textCard, /Submission transport: text envelope <plan_candidate>/);
  assert.match(textCard, /emit exactly one complete `<plan_candidate>` and no surrounding prose/i);
  assert.match(textCard, /<plan_candidate>\{"schemaVersion"/);
  assert.doesNotMatch(textCard, /submit_plan_candidate/);
});
