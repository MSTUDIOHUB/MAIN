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
      for (const candidate of [
        basePath,
        `${basePath}.ts`,
        `${basePath}.tsx`,
        path.join(basePath, "index.ts"),
      ]) {
        if (fs.existsSync(candidate) && /\.tsx?$/.test(candidate)) {
          return loadTranspiledModuleSync(candidate);
        }
      }
    }
    return localRequire(specifier);
  };
  new Function("exports", "module", "require", transpiled)(
    module.exports,
    module,
    runtimeRequire,
  );
  moduleCache.set(normalizedPath, module.exports);
  return module.exports;
}

const {
  createDraftPlanCandidate,
  derivePlanTasksFromCandidate,
  hashPlanCandidate,
  sealPlanCandidate,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/planContract.ts"));
const {
  preparePlanArtifactCommit,
  reducePlanArtifactCommit,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/planArtifactCommit.ts"));
const {
  sanitizeRestoredPlanArtifacts,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/planArtifactRestore.ts"));
const {
  ensureApprovedPlanRuntimeTasksForState,
  evaluateApprovedPlanExecutionReadiness,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/store/submitApprovedPlanExecution.ts"));
const {
  validateActionablePlanArtifact,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/workflowModels.ts"));

const diagnosticProjection = [
  "# Typed diagnostic-log repair plan",
  "",
  "## User goal",
  "- Keep recovered runs bound to their current runtime owner.",
  "",
  "## Confirmed Evidence",
  "- [E1] Diagnostic logs indicate `src/runtime.ts` may route a recovered run through the stale owner branch.",
  "",
  "## Key Changes",
  "- [C1] Modify `src/runtime.ts` to bind recovered runs to the current owner identity.",
  "",
  "## Public APIs / Interfaces / Types",
  "- Keep the public runtime API unchanged.",
  "",
  "## Test Plan",
  "- [V1] Run `node --test tests/node/typed-plan-authority.test.mjs` and require exit status 0.",
  "",
  "## Assumptions",
  "- Preserve unrelated recovery behavior.",
].join("\n");

function buildTypedArtifact() {
  const authoringContract = {
    version: 7,
    contractId: "typed-diagnostic-authority",
    objective: "Keep recovered runs bound to their current runtime owner.",
    facets: [{
      id: "G1",
      index: 1,
      text: "Keep recovered runs bound to their current runtime owner.",
    }],
    contextTargets: [],
    reusableEvidenceTargets: [],
    imageCount: 0,
    diagnosisRequired: false,
    criteria: [],
  };
  const bundle = {
    bundleId: "typed-diagnostic-bundle",
    hash: "typed-diagnostic-bundle-hash",
    turnId: "typed-diagnostic-turn",
    objective: authoringContract.objective,
    constraints: [],
    facts: [{
      id: "E1",
      tool: "debug_log",
      target: "src/runtime.ts",
      summary: "The diagnostic observation records the stale owner branch.",
      hash: "typed-diagnostic-e1",
    }],
    changeTargets: ["src/runtime.ts"],
    verificationTargets: [],
  };
  const draft = createDraftPlanCandidate({
    content: diagnosticProjection,
    bundle,
    authoringContract,
    summary: ["Bind recovery to the typed runtime owner."],
    findings: [],
    diagnoses: [],
    changes: [{
      text: "[C1] Modify src/runtime.ts to bind recovered runs to the current owner identity.",
      targetRef: "src/runtime.ts",
      evidenceRefs: ["E1"],
    }],
    interfaces: [],
    tests: ["V1"],
    assumptions: ["Preserve unrelated recovery behavior."],
    blockingChoices: [],
  });
  const candidate = sealPlanCandidate({
    candidate: draft,
    content: diagnosticProjection,
    runtimeTasks: [{
      id: "typed-diagnostic-validation",
      text: "[V1] Run the focused typed authority regression test and require exit status 0.",
      status: "pending",
      executionKind: "validation",
      requirementRef: "G1",
      validation: [{
        kind: "finite_command",
        acceptance: "required",
        command: "node --test tests/node/typed-plan-authority.test.mjs",
        capability: "test",
        segments: [{
          command: "node --test tests/node/typed-plan-authority.test.mjs",
          connector: "start",
          role: "validator",
          capability: "test",
        }],
      }],
    }],
  });
  return {
    kind: "plan",
    path: ".MAIN/plans/plan.md",
    title: "Plan",
    content: diagnosticProjection,
    candidate,
    candidateHash: hashPlanCandidate(candidate),
    authoringContractId: candidate.authoringContractId,
    revision: 1,
    updatedAt: 1,
  };
}

function commitArtifact(artifact) {
  const prepared = preparePlanArtifactCommit(artifact);
  if (!prepared.accepted) return prepared;
  return reducePlanArtifactCommit({
    state: {
      artifacts: [],
      tasks: [],
      evidenceLedger: [],
      isApproved: false,
      stage: "idle",
    },
    commit: prepared.commit,
  });
}

test("typed Plan authority survives a diagnostic-log projection across commit, restore, and approval", () => {
  const artifact = buildTypedArtifact();
  const legacyMarkdownVerdict = validateActionablePlanArtifact(artifact.content);
  assert.equal(legacyMarkdownVerdict.ok, false, "fixture must exercise the obsolete second gate");
  assert.equal(legacyMarkdownVerdict.reason, "unverified_diagnostic_claim_as_confirmed");

  const committed = commitArtifact(artifact);
  assert.equal(committed.accepted, true, JSON.stringify(committed));
  assert.equal(committed.tasks.length, 2);

  const restored = sanitizeRestoredPlanArtifacts({
    artifacts: [artifact],
    isPlanApproved: false,
  });
  assert.deepEqual(restored.rejected, []);
  assert.equal(restored.artifacts.length, 1);

  const executionPlanTasks = ensureApprovedPlanRuntimeTasksForState({
    planArtifacts: [artifact],
    planTasks: [],
    planExecutionEvidenceLedger: [],
    isPlanApproved: false,
    currentTurnId: "typed-diagnostic-turn",
    conversationTurns: [{
      id: "typed-diagnostic-turn",
      userPrompt: "Keep recovered runs bound to their current runtime owner.",
    }],
  }, "en");
  assert.deepEqual(
    executionPlanTasks.map((task) => task.id),
    derivePlanTasksFromCandidate(artifact.candidate).map((task) => task.id),
  );
  const readiness = evaluateApprovedPlanExecutionReadiness({
    planArtifacts: [artifact],
    executionPlanTasks,
  });
  assert.equal(readiness.ok, true, JSON.stringify({ readiness, executionPlanTasks }));
  assert.equal(readiness.mutationOriented, true);
  assert.equal(readiness.concreteMutationTaskCount, 1);
  assert.equal(readiness.executableValidationTaskCount, 1);
});

test("typed Plan integrity drift still fails closed at every authority boundary", () => {
  const artifact = buildTypedArtifact();
  const drifted = {
    ...artifact,
    content: `${artifact.content}\n\nExternally edited projection.`,
  };

  const committed = commitArtifact(drifted);
  assert.equal(committed.accepted, false);
  assert.equal(committed.gate, "typed_contract");
  assert.deepEqual(committed.failures, ["candidate_projection_content_mismatch"]);

  const restored = sanitizeRestoredPlanArtifacts({
    artifacts: [drifted],
    isPlanApproved: false,
  });
  assert.deepEqual(restored.artifacts, []);
  assert.equal(restored.rejected[0]?.reason, "candidate_projection_content_mismatch");

  const readiness = evaluateApprovedPlanExecutionReadiness({
    planArtifacts: [drifted],
    executionPlanTasks: derivePlanTasksFromCandidate(artifact.candidate),
  });
  assert.equal(readiness.ok, false);
  assert.equal(readiness.reason, "plan_artifact_quality_rejected");
  assert.equal(readiness.qualityReason, "candidate_projection_content_mismatch");
});

test("legacy Plan imports retain the actionable Markdown protection", () => {
  const typedArtifact = buildTypedArtifact();
  const legacyArtifact = {
    kind: typedArtifact.kind,
    path: typedArtifact.path,
    title: typedArtifact.title,
    content: typedArtifact.content,
    legacyTaskProjection: derivePlanTasksFromCandidate(typedArtifact.candidate),
    revision: typedArtifact.revision,
    updatedAt: typedArtifact.updatedAt,
  };

  const committed = commitArtifact(legacyArtifact);
  assert.equal(committed.accepted, false);
  assert.equal(committed.gate, "quality");
  assert.equal(committed.reason, "unverified_diagnostic_claim_as_confirmed");

  const restored = sanitizeRestoredPlanArtifacts({
    artifacts: [legacyArtifact],
    isPlanApproved: false,
  });
  assert.deepEqual(restored.artifacts, []);
  assert.equal(restored.rejected[0]?.reason, "unverified_diagnostic_claim_as_confirmed");

  const readiness = evaluateApprovedPlanExecutionReadiness({
    planArtifacts: [legacyArtifact],
    executionPlanTasks: legacyArtifact.legacyTaskProjection,
  });
  assert.equal(readiness.ok, false);
  assert.equal(readiness.reason, "plan_artifact_quality_rejected");
  assert.equal(readiness.qualityReason, "unverified_diagnostic_claim_as_confirmed");
});

test("new, restored, and refreshed Plan reviews share one typed identity boundary", () => {
  const planRunnerSource = fs.readFileSync(
    path.join(workspaceRoot, "src/store/runtimeV2/planRunner.ts"),
    "utf8",
  );
  const workPlanAdapterSource = fs.readFileSync(
    path.join(workspaceRoot, "src/store/runtimeV2/workPlanAdapter.ts"),
    "utf8",
  );
  assert.match(planRunnerSource, /createRuntimeV2PlanReviewCommit/);
  assert.match(planRunnerSource, /reviewCommit/);
  assert.match(workPlanAdapterSource, /validateRuntimeV2PlanReviewCommitIntegrity/);
  assert.match(workPlanAdapterSource, /digest/);
  assert.match(workPlanAdapterSource, /projectionHash/);

  const storeSource = fs.readFileSync(
    path.join(workspaceRoot, "src/store/useAppStore.ts"),
    "utf8",
  );
  assert.match(
    storeSource,
    /restoredPlanReviewIdentity = buildTypedPlanApprovalIdentity[\s\S]*planReviewIdentity: restoredPlanReviewIdentity/,
  );
  assert.match(
    storeSource,
    /approvePlan:[\s\S]*approvalIdentity = buildTypedPlanApprovalIdentity\(state\.planArtifacts\)/,
  );
  const revertSection = storeSource.slice(
    storeSource.indexOf("function buildPlanArtifactRevertTransition"),
    storeSource.indexOf("function buildPlanApprovalHandoffDedupLogPayload", storeSource.indexOf("function buildPlanArtifactRevertTransition")),
  );
  assert.match(revertSection, /nextArtifactIdentity = buildPlanApprovalIdentity/);
  assert.match(revertSection, /nextReviewIdentity = buildTypedPlanApprovalIdentity/);
  assert.match(revertSection, /shouldRefreshPlanReviewRequest[\s\S]*nextReviewIdentity/);

  const globalCommitSection = storeSource.slice(
    storeSource.indexOf("upsertPlanArtifact: (artifact) =>"),
    storeSource.indexOf("clearPlanArtifacts:", storeSource.indexOf("upsertPlanArtifact: (artifact) =>")),
  );
  assert.match(globalCommitSection, /reviewIdentity: nextReviewIdentity/);
  assert.match(globalCommitSection, /shouldRefreshPlanReviewRequest[\s\S]*nextReviewIdentity/);

  const commitSource = fs.readFileSync(
    path.join(workspaceRoot, "src/lib/planArtifactCommit.ts"),
    "utf8",
  );
  assert.match(commitSource, /artifactIdentity: buildPlanApprovalIdentity\(sortedArtifacts\)/);
  assert.match(commitSource, /reviewIdentity: buildTypedPlanApprovalIdentity\(sortedArtifacts\)/);
});
