import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";

const workspaceRoot = process.cwd();
const cache = new Map();

function loadTs(sourcePath) {
  const normalizedPath = path.resolve(sourcePath);
  if (cache.has(normalizedPath)) return cache.get(normalizedPath);
  const source = fs.readFileSync(normalizedPath, "utf8");
  const transpiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    fileName: normalizedPath,
  }).outputText;
  const module = { exports: {} };
  cache.set(normalizedPath, module.exports);
  const localRequire = createRequire(normalizedPath);
  const runtimeRequire = (specifier) => {
    if (specifier.startsWith(".")) {
      const basePath = path.resolve(path.dirname(normalizedPath), specifier);
      for (const candidate of [basePath, `${basePath}.ts`, path.join(basePath, "index.ts")]) {
        if (fs.existsSync(candidate) && candidate.endsWith(".ts")) return loadTs(candidate);
      }
    }
    return localRequire(specifier);
  };
  new Function("exports", "module", "require", transpiled)(module.exports, module, runtimeRequire);
  cache.set(normalizedPath, module.exports);
  return module.exports;
}

const {
  createDraftPlanCandidate,
  derivePlanTasksFromCandidate,
  hashPlanCandidate,
  renderPlanCandidateMarkdown,
  sealPlanCandidate,
  validateSealedPlanCandidate,
} = loadTs(path.join(workspaceRoot, "src/lib/planContract.ts"));
const { buildPlanApprovalIdentity } = loadTs(
  path.join(workspaceRoot, "src/lib/planApprovalIdentity.ts"),
);
const { preparePlanArtifactCommit, reducePlanArtifactCommit } = loadTs(
  path.join(workspaceRoot, "src/lib/planArtifactCommit.ts"),
);
const { sanitizeRestoredPlanArtifacts } = loadTs(
  path.join(workspaceRoot, "src/lib/planArtifactRestore.ts"),
);
const { sha256Hex } = loadTs(path.join(workspaceRoot, "src/lib/sha256.ts"));
const { validatePlanCoverageClosure } = loadTs(
  path.join(workspaceRoot, "src/lib/planCoverageContract.ts"),
);

const content = [
  "# Proposed Plan",
  "",
  "## Goal traceability",
  "- G1 -> E1 -> R1 -> C1 -> V1",
  "- G2 -> E2 -> R2 -> C2 -> V2",
  "",
  "## Diagnosis",
  "- [R1] The toolbar owns the duplicate filename surface, supported by E1.",
  "- [R2] The load-time input event schedules save, supported by E2.",
  "",
  "## Changes",
  "- [C1] Modify `src/toolbar.js` so the tab remains the sole filename owner.",
  "- [C2] Modify `src/main.js` so programmatic load does not schedule save.",
  "",
  "## Validation",
  "- [V1] Run `npm test -- toolbar` and require exit 0.",
  "- [V2] Run `npm test -- open-file` and require exit 0.",
].join("\n");

function commitPlanArtifact(input) {
  const prepared = preparePlanArtifactCommit(input.artifact);
  if (!prepared.accepted) return prepared;
  return reducePlanArtifactCommit({ state: input.state, commit: prepared.commit });
}

function candidateFixture() {
  const authoringContract = {
    version: 7,
    contractId: "plan-objective-1",
    objective: "1. Remove duplicate filename.\n2. Prevent save dialog after open.",
    facets: [
      { id: "G1", index: 1, text: "Remove duplicate filename." },
      { id: "G2", index: 2, text: "Prevent save dialog after open." },
    ],
    contextTargets: [],
    reusableEvidenceTargets: [],
    imageCount: 0,
    diagnosisRequired: true,
    criteria: [],
  };
  const bundle = {
    bundleId: "bundle-1",
    hash: "bundle-hash-1",
    turnId: "turn-1",
    objective: authoringContract.objective,
    constraints: [],
    facts: [
      { id: "E1", tool: "read_file", target: "src/toolbar.js", summary: "toolbar writes filename", hash: "e1" },
      { id: "E2", tool: "read_file", target: "src/main.js", summary: "input listener schedules save", hash: "e2" },
    ],
    changeTargets: ["src/toolbar.js", "src/main.js"],
    verificationTargets: [],
  };
  const draft = createDraftPlanCandidate({
    content,
    bundle,
    authoringContract,
    summary: ["Repair both MD Viewer outcomes."],
    findings: ["Two independent owners are involved."],
    diagnoses: [
      {
        text: "[R1] The toolbar owns the duplicate filename surface, supported by E1.",
        certainty: "inferred",
        evidenceRefs: ["E1"],
        chainRefs: ["E1"],
      },
      {
        text: "[R2] The load-time input event schedules save, supported by E2.",
        certainty: "inferred",
        evidenceRefs: ["E2"],
        chainRefs: ["E2"],
      },
    ],
    changes: [
      { text: "[C1] Modify src/toolbar.js", targetRef: "src/toolbar.js", evidenceRefs: ["E1"] },
      { text: "[C2] Modify src/main.js", targetRef: "src/main.js", evidenceRefs: ["E2"] },
    ],
    interfaces: [],
    tests: ["V1", "V2"],
    assumptions: [],
    blockingChoices: [],
  });
  return sealPlanCandidate({
    candidate: draft,
    content,
    runtimeTasks: [
      {
        id: "validation-1",
        text: "[V1] Run toolbar regression",
        status: "pending",
        executionKind: "validation",
        requirementRef: "G1",
        validation: [{
          kind: "finite_command",
          acceptance: "required",
          command: "npm test -- toolbar",
          capability: "test",
          segments: [{ command: "npm test -- toolbar", connector: "start", role: "validator", capability: "test" }],
        }],
      },
      {
        id: "validation-2",
        text: "[V2] Run open-file regression",
        status: "pending",
        executionKind: "validation",
        requirementRef: "G2",
        validation: [{
          kind: "finite_command",
          acceptance: "required",
          command: "npm test -- open-file",
          capability: "test",
          segments: [{ command: "npm test -- open-file", connector: "start", role: "validator", capability: "test" }],
        }],
      },
    ],
  });
}

test("sealed Plan candidate is the typed source for goals, tasks, and validation", () => {
  const candidate = candidateFixture();
  assert.deepEqual(validateSealedPlanCandidate({ candidate, expectedContent: content }), []);
  assert.equal(renderPlanCandidateMarkdown(candidate), content);
  assert.deepEqual(candidate.changes.map((change) => change.goalRefs), [["G1"], ["G2"]]);
  assert.equal(candidate.schemaVersion, 5);
  assert.deepEqual(candidate.diagnoses.map((diagnosis) => diagnosis.evidenceRefs), [["E1"], ["E2"]]);
  assert.deepEqual(candidate.changes.map((change) => change.diagnosisRefs), [["R1"], ["R2"]]);
  assert.deepEqual(candidate.validations.map((validation) => validation.goalRefs), [["G1"], ["G2"]]);

  const tasks = derivePlanTasksFromCandidate(candidate);
  assert.equal(tasks.filter((task) => task.executionKind === "mutation").length, 2);
  assert.deepEqual(
    tasks.filter((task) => task.executionKind === "validation").flatMap((task) => task.commands || []),
    ["npm test -- toolbar", "npm test -- open-file"],
  );
});

test("a decision-only non-diagnostic graph remains a valid actionable baseline", () => {
  const candidate = candidateFixture();
  candidate.diagnosisRequired = false;
  candidate.evidence = [];
  candidate.diagnoses = [];
  candidate.changes = [];
  candidate.decisions = [
    { id: "D1", text: "Preserve the first reviewed behavior.", disposition: "preserve", evidenceRefs: [], diagnosisRefs: [], goalRefs: ["G1"] },
    { id: "D2", text: "Preserve the second reviewed behavior.", disposition: "preserve", evidenceRefs: [], diagnosisRefs: [], goalRefs: ["G2"] },
  ];
  candidate.validations = candidate.validations.map((validation) => ({
    ...validation,
    changeRefs: [],
  }));

  assert.deepEqual(validateSealedPlanCandidate({ candidate, expectedContent: content }), []);
});

test("a confirmed-change rationale cannot be closed by preserve-only dispositions", () => {
  const failures = validatePlanCoverageClosure({
    diagnosisRequired: false,
    evidence: [{ id: "E1", target: "src/main.ts" }],
    diagnoses: [],
    changes: [],
    decisions: [{
      id: "D1",
      disposition: "preserve",
      evidenceRefs: ["E1"],
      diagnosisRefs: [],
      goalRefs: ["G1"],
    }],
    validations: [],
    coverageObligations: [{
      id: "Q1",
      kind: "confirmed_change_rationale",
      relationKey: "runtime-confirmed-change",
      evidenceRefs: ["E1"],
      targetRefs: ["src/main.ts"],
    }],
  });
  assert.ok(failures.includes("candidate_coverage_change_missing:Q1"), failures.join(","));
});

test("sealed Plan total graph validation rejects duplicate or malformed E/R/C/D/V ids", () => {
  const duplicate = candidateFixture();
  duplicate.evidence = [...duplicate.evidence, { ...duplicate.evidence[0] }];
  duplicate.diagnoses = [...duplicate.diagnoses, { ...duplicate.diagnoses[0] }];
  duplicate.changes = [...duplicate.changes, { ...duplicate.changes[0] }];
  duplicate.decisions = [
    { id: "D1", text: "Preserve the reviewed API.", disposition: "preserve", evidenceRefs: [], goalRefs: ["G1"] },
    { id: "D1", text: "Preserve the reviewed API.", disposition: "preserve", evidenceRefs: [], goalRefs: ["G1"] },
  ];
  duplicate.validations = [...duplicate.validations, { ...duplicate.validations[0] }];
  const duplicateFailures = validateSealedPlanCandidate({ candidate: duplicate, expectedContent: content });
  for (const failure of [
    "candidate_evidence_id_duplicate:E1",
    "candidate_diagnosis_id_duplicate:R1",
    "candidate_change_id_duplicate:C1",
    "candidate_decision_id_duplicate:D1",
    "candidate_validation_id_duplicate:V1",
  ]) assert.ok(duplicateFailures.includes(failure), `${failure}: ${duplicateFailures.join(",")}`);

  const malformed = candidateFixture();
  malformed.evidence[0] = { ...malformed.evidence[0], id: "e1" };
  malformed.diagnoses[0] = { ...malformed.diagnoses[0], id: "" };
  malformed.changes[0] = { ...malformed.changes[0], id: "change-1" };
  malformed.decisions = [
    { id: "", text: "Preserve the reviewed API.", disposition: "preserve", evidenceRefs: [], diagnosisRefs: [], goalRefs: ["G1"] },
  ];
  malformed.validations[0] = { ...malformed.validations[0], id: "validation-1" };
  const malformedFailures = validateSealedPlanCandidate({ candidate: malformed, expectedContent: content });
  for (const prefix of [
    "candidate_evidence_id_invalid:",
    "candidate_diagnosis_id_invalid:",
    "candidate_change_id_invalid:",
    "candidate_decision_id_invalid:",
    "candidate_validation_id_invalid:",
  ]) assert.ok(malformedFailures.some((failure) => failure.startsWith(prefix)), malformedFailures.join(","));
});

test("sealed Plan total graph validation rejects every dangling reference edge", () => {
  const candidate = candidateFixture();
  candidate.diagnoses[0] = {
    ...candidate.diagnoses[0],
    evidenceRefs: ["E404"],
    chainRefs: ["E404"],
    goalRefs: ["G404"],
  };
  candidate.changes[0] = {
    ...candidate.changes[0],
    evidenceRefs: ["E404"],
    diagnosisRefs: ["R404"],
    goalRefs: ["G404"],
  };
  candidate.decisions = [{
    id: "D1",
    text: "Preserve an unrelated boundary.",
    disposition: "preserve",
    evidenceRefs: ["E404"],
    diagnosisRefs: ["R404"],
    goalRefs: ["G404"],
  }];
  candidate.validations[0] = {
    ...candidate.validations[0],
    goalRefs: ["G404"],
    changeRefs: ["C404"],
  };

  const failures = validateSealedPlanCandidate({ candidate, expectedContent: content });
  for (const failure of [
    "candidate_diagnosis_evidence_invalid:R1",
    "candidate_diagnosis_chain_invalid:R1",
    "candidate_diagnosis_goal_invalid:R1",
    "candidate_change_evidence_invalid:C1",
    "candidate_change_diagnosis_invalid:C1",
    "candidate_change_goal_invalid:C1",
    "candidate_decision_evidence_invalid:D1",
    "candidate_decision_goal_invalid:D1",
    "candidate_validation_goal_invalid:V1",
    "candidate_validation_change_invalid:V1",
  ]) assert.ok(failures.includes(failure), `${failure}: ${failures.join(",")}`);
});

test("validation-only coverage cannot masquerade as a Plan action", () => {
  const candidate = candidateFixture();
  candidate.changes = [];
  candidate.decisions = [];
  candidate.validations = candidate.validations.map((validation) => ({
    ...validation,
    changeRefs: [],
  }));

  const failures = validateSealedPlanCandidate({ candidate, expectedContent: content });
  assert.ok(failures.includes("candidate_action_missing"), failures.join(","));
  assert.ok(failures.includes("candidate_goal_action_missing:G1"), failures.join(","));
  assert.ok(failures.includes("candidate_goal_action_missing:G2"), failures.join(","));
  assert.equal(failures.includes("candidate_goal_validation_missing:G1"), false);
  assert.equal(failures.includes("candidate_goal_validation_missing:G2"), false);
});

test("diagnosis-required goals need an evidence-backed non-hypothesis chain", () => {
  const candidate = candidateFixture();
  candidate.diagnoses[0] = {
    ...candidate.diagnoses[0],
    chainRefs: [],
  };
  candidate.diagnoses[1] = {
    ...candidate.diagnoses[1],
    certainty: "hypothesis",
  };

  const failures = validateSealedPlanCandidate({ candidate, expectedContent: content });
  assert.ok(failures.includes("candidate_diagnosis_chain_missing:R1"), failures.join(","));
  assert.ok(failures.includes("candidate_goal_diagnosis_missing:G1"), failures.join(","));
  assert.ok(failures.includes("candidate_goal_diagnosis_missing:G2"), failures.join(","));
});

test("sealed Plan identity is bound exactly to authoring contract and evidence bundle", () => {
  const candidate = candidateFixture();
  candidate.contractId = `${candidate.authoringContractId}:another-bundle`;

  assert.ok(
    validateSealedPlanCandidate({ candidate, expectedContent: content })
      .includes("candidate_contract_binding_mismatch"),
  );
});

test("validation primitive shape is rechecked by the structured runtime validator", () => {
  const candidate = candidateFixture();
  candidate.validations[0] = {
    ...candidate.validations[0],
    primitive: {
      ...candidate.validations[0].primitive,
      capability: "build",
    },
  };

  const failures = validateSealedPlanCandidate({ candidate, expectedContent: content });
  assert.ok(failures.includes("candidate_validation_primitive_invalid:V1"), failures.join(","));
  assert.ok(failures.includes("candidate_validation_blocking_mismatch:V1"), failures.join(","));
  assert.ok(failures.includes("candidate_goal_validation_missing:G1"), failures.join(","));
});

test("hash-complete forged graph fails closed on commit and restore", () => {
  const candidate = candidateFixture();
  candidate.validations[0] = {
    ...candidate.validations[0],
    changeRefs: ["C404"],
  };
  const artifact = {
    kind: "plan",
    path: ".MAIN/plans/plan.md",
    title: "Plan",
    content,
    candidate,
    candidateHash: hashPlanCandidate(candidate),
    authoringContractId: candidate.authoringContractId,
    revision: 1,
    updatedAt: 1,
  };
  const committed = commitPlanArtifact({
    state: {
      artifacts: [],
      tasks: [],
      evidenceLedger: [],
      isApproved: false,
      stage: "idle",
    },
    artifact,
  });
  assert.equal(committed.accepted, false);
  assert.equal(committed.gate, "typed_contract");
  assert.equal(committed.candidateHashMismatch, false);
  assert.ok(committed.failures.includes("candidate_validation_change_invalid:V1"));

  const restored = sanitizeRestoredPlanArtifacts({ artifacts: [artifact], isPlanApproved: false });
  assert.deepEqual(restored.artifacts, []);
  assert.equal(restored.rejected[0]?.reason, "candidate_validation_change_invalid:V1");
  assert.deepEqual(restored.candidateIntegrityRejectedPaths, [".MAIN/plans/plan.md"]);
});

test("schema-5 commit and restore require the runtime evidence receipt", () => {
  const candidate = candidateFixture();
  delete candidate.evidenceReceipt;
  const artifact = {
    kind: "plan",
    path: ".MAIN/plans/plan.md",
    title: "Plan",
    content,
    candidate,
    // Recomputing the outer hash cannot mint the missing runtime receipt.
    candidateHash: hashPlanCandidate(candidate),
    authoringContractId: candidate.authoringContractId,
    revision: 1,
    updatedAt: 1,
  };
  const committed = commitPlanArtifact({
    state: {
      artifacts: [],
      tasks: [],
      evidenceLedger: [],
      isApproved: false,
      stage: "idle",
    },
    artifact,
  });
  assert.equal(committed.accepted, false);
  assert.ok(committed.failures.includes("evidence_receipt_missing"), committed.failures.join(","));

  const restored = sanitizeRestoredPlanArtifacts({ artifacts: [artifact], isPlanApproved: false });
  assert.deepEqual(restored.artifacts, []);
  assert.equal(restored.rejected[0]?.reason, "evidence_receipt_missing");
});

test("candidate evidence cannot drift from its runtime receipt", () => {
  const candidate = candidateFixture();
  candidate.evidence[0] = {
    ...candidate.evidence[0],
    statement: `${candidate.evidence[0].statement} forged by candidate`,
  };
  const failures = validateSealedPlanCandidate({ candidate, expectedContent: content });
  assert.ok(
    failures.includes("candidate_evidence_receipt_fact_mismatch:E1"),
    failures.join(","),
  );
});

test("Plan candidate identities use the shared standards-compliant SHA-256 primitive", () => {
  assert.equal(
    sha256Hex("abc"),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
  assert.match(hashPlanCandidate(candidateFixture()), /^plan-candidate-sha256-[a-f0-9]{64}$/);
});

test("projection drift and missing goal validation fail closed", () => {
  const candidate = candidateFixture();
  assert.deepEqual(
    validateSealedPlanCandidate({ candidate, expectedContent: `${content}\nexternal edit` }),
    ["candidate_projection_content_mismatch"],
  );
  const withoutSecondValidation = {
    ...candidate,
    validations: candidate.validations.filter((validation) => !validation.goalRefs.includes("G2")),
  };
  assert.deepEqual(
    validateSealedPlanCandidate({ candidate: withoutSecondValidation, expectedContent: content }),
    ["candidate_goal_validation_missing:G2"],
  );
});

test("sealed Plan candidates reject a forged blocking flag on advisory validation", () => {
  const candidate = candidateFixture();
  const forged = {
    ...candidate,
    validations: candidate.validations.map((validation, index) => index === 0
      ? {
          ...validation,
          primitive: {
            kind: "assertion",
            acceptance: "advisory",
            target: "runtime:debug.save-dialog-error-absent",
            matcher: "runtime_result",
            producer: "runtime_evidence_ledger",
          },
          blocking: true,
        }
      : validation),
  };
  const failures = validateSealedPlanCandidate({ candidate: forged, expectedContent: content });

  assert.ok(failures.includes("candidate_validation_blocking_mismatch:V1"), failures.join(","));
  assert.ok(failures.includes("candidate_goal_validation_missing:G1"), failures.join(","));
});

test("sealed Plan candidates reject standalone assertions marked required", () => {
  const candidate = candidateFixture();
  const forged = {
    ...candidate,
    validations: candidate.validations.map((validation, index) => index === 0
      ? {
          ...validation,
          primitive: {
            kind: "assertion",
            acceptance: "required",
            target: "artifact:dist/app.js",
            matcher: "exists",
            producer: "artifact_store",
          },
          blocking: true,
        }
      : validation),
  };
  const failures = validateSealedPlanCandidate({ candidate: forged, expectedContent: content });

  assert.ok(failures.includes("candidate_validation_primitive_invalid:V1"), failures.join(","));
  assert.ok(failures.includes("candidate_goal_validation_missing:G1"), failures.join(","));
});

test("approval identity binds the typed candidate as well as Markdown", () => {
  const candidate = candidateFixture();
  const artifact = {
    kind: "plan",
    path: ".MAIN/plans/plan.md",
    title: "Plan",
    content,
    candidate,
    candidateHash: hashPlanCandidate(candidate),
    authoringContractId: candidate.authoringContractId,
    revision: 1,
    updatedAt: 1,
  };
  const first = buildPlanApprovalIdentity([artifact]);
  const changedCandidate = {
    ...candidate,
    assumptions: ["A newly reviewed assumption"],
  };
  const second = buildPlanApprovalIdentity([{
    ...artifact,
    candidate: changedCandidate,
    candidateHash: hashPlanCandidate(changedCandidate),
  }]);
  assert.notEqual(first.artifactHash, second.artifactHash);
});

test("shared Plan artifact commit advances revision for typed identity and derives typed tasks", () => {
  const candidate = candidateFixture();
  const first = commitPlanArtifact({
    state: {
      artifacts: [],
      tasks: [],
      evidenceLedger: [],
      isApproved: false,
      stage: "idle",
    },
    artifact: {
      kind: "plan",
      path: ".MAIN/plans/plan.md",
      title: "Plan",
      content,
      candidate,
      candidateHash: hashPlanCandidate(candidate),
      authoringContractId: candidate.authoringContractId,
      updatedAt: 1,
    },
  });
  assert.equal(first.accepted, true);
  assert.equal(first.artifact.revision, 1);
  assert.equal(first.artifact.candidateHash, hashPlanCandidate(candidate));
  assert.equal(first.artifact.authoringContractId, candidate.authoringContractId);
  assert.equal(first.tasks.filter((task) => task.executionKind === "mutation").length, 2);
  assert.equal(first.tasks.filter((task) => task.executionKind === "validation").length, 2);

  const revisedCandidate = {
    ...candidate,
    assumptions: ["A newly reviewed typed assumption"],
  };
  const second = commitPlanArtifact({
    state: {
      artifacts: first.artifacts,
      tasks: first.tasks,
      evidenceLedger: [],
      isApproved: false,
      stage: "plan",
    },
    artifact: {
      ...first.artifact,
      candidate: revisedCandidate,
      candidateHash: hashPlanCandidate(revisedCandidate),
      authoringContractId: revisedCandidate.authoringContractId,
      updatedAt: 2,
    },
  });
  assert.equal(second.accepted, true);
  assert.equal(second.revisionAdvanced, true);
  assert.equal(second.artifact.revision, 2);
  assert.equal(second.artifact.candidateHash, hashPlanCandidate(revisedCandidate));
  assert.notEqual(second.artifactIdentity.artifactHash, first.artifactIdentity.artifactHash);
  assert.notEqual(second.reviewIdentity.artifactHash, first.reviewIdentity.artifactHash);

  const reauthoredCandidate = {
    ...revisedCandidate,
    contractId: "plan-objective-2:bundle-hash-1",
    authoringContractId: "plan-objective-2",
  };
  const third = commitPlanArtifact({
    state: {
      artifacts: second.artifacts,
      tasks: second.tasks,
      evidenceLedger: [],
      isApproved: false,
      stage: "plan",
    },
    artifact: {
      ...second.artifact,
      candidate: reauthoredCandidate,
      candidateHash: hashPlanCandidate(reauthoredCandidate),
      authoringContractId: reauthoredCandidate.authoringContractId,
      updatedAt: 3,
    },
  });
  assert.equal(third.accepted, true);
  assert.equal(third.revisionAdvanced, true);
  assert.equal(third.artifact.revision, 3);
  assert.equal(third.artifact.authoringContractId, "plan-objective-2");

  const unchanged = commitPlanArtifact({
    state: {
      artifacts: third.artifacts,
      tasks: third.tasks,
      evidenceLedger: [],
      isApproved: false,
      stage: "plan",
    },
    artifact: {
      ...third.artifact,
      updatedAt: 4,
    },
  });
  assert.equal(unchanged.accepted, true);
  assert.equal(unchanged.revisionAdvanced, false);
  assert.equal(unchanged.artifact.revision, 3);
});

test("shared Plan artifact commit fails closed on typed hash or authoring identity drift", () => {
  const candidate = candidateFixture();
  const baseArtifact = {
    kind: "plan",
    path: ".MAIN/plans/plan.md",
    title: "Plan",
    content,
    candidate,
    candidateHash: hashPlanCandidate(candidate),
    authoringContractId: candidate.authoringContractId,
    updatedAt: 1,
  };
  const state = {
    artifacts: [],
    tasks: [],
    evidenceLedger: [],
    isApproved: false,
    stage: "idle",
  };
  const badHash = commitPlanArtifact({
    state,
    artifact: { ...baseArtifact, candidateHash: "plan-candidate-stale" },
  });
  assert.equal(badHash.accepted, false);
  assert.equal(badHash.gate, "typed_contract");
  assert.equal(badHash.candidateHashMismatch, true);

  const badAuthoringIdentity = commitPlanArtifact({
    state,
    artifact: { ...baseArtifact, authoringContractId: "stale-authoring-contract" },
  });
  assert.equal(badAuthoringIdentity.accepted, false);
  assert.equal(badAuthoringIdentity.gate, "typed_contract");
  assert.equal(badAuthoringIdentity.authoringContractMismatch, true);
});

test("Plan artifact commit requires explicit typed or legacy authority and forbids cross-kind smuggling", () => {
  const state = {
    artifacts: [],
    tasks: [],
    evidenceLedger: [],
    isApproved: false,
    stage: "idle",
  };
  const implicitLegacy = commitPlanArtifact({
    state,
    artifact: {
      kind: "plan",
      path: ".MAIN/plans/plan.md",
      title: "Plan",
      content,
      updatedAt: 1,
    },
  });
  assert.equal(implicitLegacy.accepted, false);
  assert.equal(implicitLegacy.gate, "authority");
  assert.equal(implicitLegacy.reason, "implicit_legacy_plan_forbidden");

  const explicitLegacy = commitPlanArtifact({
    state,
    artifact: {
      kind: "plan",
      path: ".MAIN/plans/plan.md",
      title: "Plan",
      content,
      legacyTaskProjection: [],
      updatedAt: 1,
    },
  });
  assert.equal(explicitLegacy.accepted, true);

  const partialTyped = commitPlanArtifact({
    state,
    artifact: {
      kind: "plan",
      path: ".MAIN/plans/plan.md",
      title: "Plan",
      content,
      candidateHash: "plan-candidate-sha256-orphaned",
      updatedAt: 1,
    },
  });
  assert.equal(partialTyped.accepted, false);
  assert.equal(partialTyped.gate, "typed_contract");
  assert.deepEqual(partialTyped.failures, ["candidate_payload_missing"]);

  const candidate = candidateFixture();
  const candidateOnTasks = commitPlanArtifact({
    state,
    artifact: {
      kind: "tasks",
      path: ".MAIN/plans/tasks.md",
      title: "Tasks",
      content: "# Tasks\n\n- [ ] Run the test — evidence: cmd:npm test",
      candidate,
      candidateHash: hashPlanCandidate(candidate),
      authoringContractId: candidate.authoringContractId,
      updatedAt: 1,
    },
  });
  assert.equal(candidateOnTasks.accepted, false);
  assert.equal(candidateOnTasks.gate, "authority");
  assert.equal(candidateOnTasks.reason, "typed_candidate_forbidden_for_kind");
});

test("malformed typed candidate is rejected as data instead of throwing", () => {
  const malformed = { ...candidateFixture(), goals: null };
  const result = commitPlanArtifact({
    state: {
      artifacts: [],
      tasks: [],
      evidenceLedger: [],
      isApproved: false,
      stage: "idle",
    },
    artifact: {
      kind: "plan",
      path: ".MAIN/plans/plan.md",
      title: "Plan",
      content,
      candidate: malformed,
      candidateHash: hashPlanCandidate(malformed),
      authoringContractId: malformed.authoringContractId,
      updatedAt: 1,
    },
  });
  assert.equal(result.accepted, false);
  assert.equal(result.gate, "typed_contract");
  assert.deepEqual(result.failures, ["candidate_payload_malformed"]);

  const cyclic = candidateFixture();
  cyclic.assumptions = [];
  cyclic.assumptions.push(cyclic.assumptions);
  const cyclicResult = commitPlanArtifact({
    state: {
      artifacts: [],
      tasks: [],
      evidenceLedger: [],
      isApproved: false,
      stage: "idle",
    },
    artifact: {
      kind: "plan",
      path: ".MAIN/plans/plan.md",
      title: "Plan",
      content,
      candidate: cyclic,
      candidateHash: "plan-candidate-sha256-cyclic",
      authoringContractId: cyclic.authoringContractId,
      updatedAt: 1,
    },
  });
  assert.equal(cyclicResult.accepted, false);
  assert.equal(cyclicResult.gate, "typed_contract");
  assert.deepEqual(cyclicResult.failures, ["candidate_payload_malformed"]);
});

test("an explicit empty diagnosis role does not relabel compatibility findings as inferred causes", () => {
  const authoringContract = {
    version: 7,
    contractId: "plan-observation-only",
    objective: "Document a read-backed current state without inventing a cause.",
    facets: [{ id: "G1", index: 1, text: "Document the current state." }],
    contextTargets: [],
    reusableEvidenceTargets: [],
    imageCount: 0,
    diagnosisRequired: false,
    criteria: [],
  };
  const bundle = {
    bundleId: "bundle-observation-only",
    hash: "bundle-observation-only-hash",
    turnId: "turn-observation-only",
    objective: authoringContract.objective,
    constraints: [],
    facts: [{
      id: "E1",
      tool: "read_file",
      target: "src/current.ts",
      summary: "the current value is rendered once",
      hash: "e-current",
    }],
    changeTargets: ["src/current.ts"],
    verificationTargets: [],
  };
  const candidate = createDraftPlanCandidate({
    content: "# Plan\n\n## Confirmed Evidence\n- [E1] Current value is rendered once.",
    bundle,
    authoringContract,
    summary: [],
    findings: ["[E1] Current value is rendered once."],
    diagnoses: [],
    changes: [],
    interfaces: [],
    tests: [],
    assumptions: [],
    blockingChoices: [],
  });

  assert.deepEqual(candidate.findings, ["[E1] Current value is rendered once."]);
  assert.deepEqual(candidate.diagnoses, []);
});
