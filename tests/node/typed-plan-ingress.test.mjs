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
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    fileName: normalizedPath,
  }).outputText;
  const module = { exports: {} };
  moduleCache.set(normalizedPath, module.exports);
  const localRequire = createRequire(normalizedPath);
  const runtimeRequire = (specifier) => {
    if (specifier.startsWith(".")) {
      const basePath = path.resolve(path.dirname(normalizedPath), specifier);
      for (const candidate of [basePath, `${basePath}.ts`, `${basePath}.tsx`, path.join(basePath, "index.ts")]) {
        if (fs.existsSync(candidate) && /\.tsx?$/.test(candidate)) return loadTranspiledModuleSync(candidate);
      }
    }
    return localRequire(specifier);
  };
  new Function("exports", "module", "require", transpiled)(module.exports, module, runtimeRequire);
  moduleCache.set(normalizedPath, module.exports);
  return module.exports;
}

const {
  createRuntimeSynthesizedPlanCandidate,
  createTypedRuntimePlanCandidate,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/planDraftIngress.ts"));
const {
  createPlanAuthoringContract,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/planAuthoringContract.ts"));
const {
  materializePlanArtifactFromVisibleText,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/planMaterialization.ts"));
const {
  buildPlanEvidenceBundle,
  formatPlanEvidenceBundleForModel,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/planEvidence.ts"));
const {
  assessPlanEvidenceComponentCapacity,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/planEvidenceComponents.ts"));
const {
  createRuntimePlanStructuredEvidenceFacts,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/planStructuredEvidence.ts"));
const {
  extractRuntimePlanSourceObservations,
  normalizePlanSourceObservations,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/planSourceObservation.ts"));
const {
  sealPlanCandidate,
  validateSealedPlanCandidate,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/planContract.ts"));
const {
  extractExplicitPlanProtocolFromReasoning,
  extractTieredPlanProposal,
  hasExplicitPlanProposal,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/planProposal.ts"));
const {
  sanitizeAssistantDisplayContent,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/sanitize.ts"));
const {
  consumeNativePlanCandidateSubmission,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/requiredToolProtocol.ts"));
const {
  classifyPlanArtifactQualityResult,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/workflowModels.ts"));

const objective = "Update src/runtime.ts so the runtime uses the current owner.";
const contract = createPlanAuthoringContract({
  objective,
  contextSignals: {
    imageParts: 0,
    mentionedFilePaths: ["src/runtime.ts"],
    attachedFilePaths: [],
    subagentPreference: "unspecified",
  },
});
const bundle = {
  bundleId: "typed-ingress-bundle",
  hash: "typed-ingress-bundle-hash",
  turnId: "typed-ingress-turn",
  objective,
  goalFacets: [{ id: "G1", index: 1, text: objective }],
  constraints: [],
  facts: [{
    id: "E1",
    tool: "read_file",
    target: "src/runtime.ts",
    summary: "The current owner identity is available at the runtime boundary.",
    hash: "typed-ingress-e1",
  }],
  observedTargets: ["src/runtime.ts"],
  changeTargets: ["src/runtime.ts"],
  verificationTargets: ["tests/node/typed-plan-ingress.test.mjs"],
  coverageObligations: [{
    id: "Q1",
    kind: "confirmed_change_rationale",
    relationKey: "change_target:src/runtime.ts",
    evidenceRefs: ["E1"],
    targetRefs: ["src/runtime.ts"],
  }],
  evidenceComponents: [{
    id: "B1",
    evidenceRefs: ["E1"],
    ownerRefs: ["src/runtime.ts"],
    relationRefs: ["Q1"],
    supportsDiagnosis: false,
    requiredForClosure: true,
  }],
};

function runtimeSourceRecord({ target, summary, source, facts, version = "fixture-v1" }) {
  const lineCount = source.split("\n").length;
  const sourceObservations = extractRuntimePlanSourceObservations({
    target,
    content: source,
    readFileObservation: {
      path: target,
      requestSignature: `read_file:${target}:1-${lineCount}`,
      versionToken: `${version}:${target}`,
      window: { startLine: 1, endLine: lineCount },
    },
  });
  return {
    tool: "read_file",
    target,
    status: "succeeded",
    summary,
    structuredFacts: createRuntimePlanStructuredEvidenceFacts(facts, {
      sourceObservationRefs: sourceObservations.map((item) => item.observationRef),
    }),
    sourceObservations,
  };
}

function goalEvidenceBasesFor(sourceBundle, diagnosisRefs = []) {
  const components = sourceBundle.evidenceComponents || [];
  const selected = components.filter((component) => component.requiredForClosure);
  const effective = selected.length > 0 ? selected : components.slice(0, 1);
  return effective.map((component) => ({
    goalRef: "G1",
    componentRef: component.id,
    evidenceRefs: [...component.evidenceRefs],
    ownerRefs: [...component.ownerRefs],
    relationRefs: [...component.relationRefs],
    diagnosisRefs: [...diagnosisRefs],
  }));
}

function draftWithText(text, sourceBundle = bundle) {
  return {
    schemaVersion: 2,
    evidenceRefs: ["E1"],
    goalEvidenceBases: goalEvidenceBasesFor(sourceBundle),
    summary: [],
    diagnoses: [],
    changes: [{
      id: "C1",
      text,
      targetRef: "src/runtime.ts",
      operation: "modify",
      evidenceRefs: ["E1"],
      diagnosisRefs: [],
      goalRefs: ["G1"],
      expectedOutcome: text,
      relationships: [],
    }],
    decisions: [],
    interfaces: [],
    validations: [{
      id: "V1",
      goalRefs: ["G1"],
      changeRefs: ["C1"],
      primitive: {
        kind: "finite_command",
        command: "node --test tests/node/typed-plan-ingress.test.mjs",
      },
      expectedOutcome: "The focused test exits with status 0.",
    }],
    assumptions: [],
    blockingChoices: [],
  };
}

function envelope(draft) {
  return `<plan_candidate>${JSON.stringify(draft)}</plan_candidate>`;
}

test("typed Plan topology is explicit and independent of prose language", () => {
  const outputs = [
    "Bind the recovered run to the current owner.",
    "把恢复后的运行绑定到当前 owner。",
    "Vincular la ejecución recuperada al propietario actual.",
  ].map((text) => createTypedRuntimePlanCandidate({
    draft: draftWithText(text),
    bundle,
    authoringContract: contract,
    language: "en",
  }));

  for (const output of outputs) assert.equal(output.ok, true, JSON.stringify(output));
  const topology = (candidate) => ({
    goals: candidate.goals.map((item) => item.id),
    evidence: candidate.evidence.map((item) => item.id),
    changes: candidate.changes.map((item) => ({
      id: item.id,
      targetRef: item.targetRef,
      operation: item.operation,
      evidenceRefs: item.evidenceRefs,
      goalRefs: item.goalRefs,
    })),
    validations: candidate.validations.map((item) => ({
      id: item.id,
      kind: item.primitive.kind,
      goalRefs: item.goalRefs,
      changeRefs: item.changeRefs,
    })),
  });
  assert.deepEqual(topology(outputs[0].candidate), topology(outputs[1].candidate));
  assert.deepEqual(topology(outputs[0].candidate), topology(outputs[2].candidate));
});

test("typed Plan closes every runtime-owned contract and causal owner before review", () => {
  const incidentObjective = "Diagnose the root cause and fix the unexpected save flow after opening a local document.";
  const incidentContract = createPlanAuthoringContract({
    objective: incidentObjective,
    diagnosisRequirement: "required",
    contextSignals: {
      imageParts: 0,
      mentionedFilePaths: [],
      attachedFilePaths: [],
      subagentPreference: "unspecified",
    },
  });
  assert.equal(incidentContract.diagnosisRequired, true);
  const incidentBundle = buildPlanEvidenceBundle({
    objective: incidentObjective,
    evidenceRecords: [runtimeSourceRecord({
      target: "src/editor.ts",
      summary: "The editor dispatches the document-change event after a programmatic value update.",
      source: "editor.dispatchEvent(new Event('document-change'));",
      facts: [
        "event_dom_dispatch_contract(document-change)",
      ],
    }), runtimeSourceRecord({
      target: "src/runtime.ts",
      summary: "The runtime listener marks state and schedules persistence before invoking the native command.",
      source: "window.addEventListener('document-change', () => { markState(); schedulePersistence(); invoke('persist_document', { document_path, content }); });",
      facts: [
        "event_dom_listener_contract(document-change)",
        "listener_calls(markState,schedulePersistence)",
        "command_transport_contract(tauri,persist_document)",
        "command_invoke_argument_contract(persist_document,document_path,content)",
        "execution_surface_contract(desktop)",
        {
          kind: "validation_capability",
          surface: "desktop",
          producer: "native_harness",
          ownerRef: "src/runtime.ts",
          command: "node --test tests/node/typed-plan-ingress.test.mjs",
        },
      ],
    }), runtimeSourceRecord({
      target: "native/src/commands.rs",
      summary: "The native handler exposes the persistence command boundary.",
      source: "fn persist_document(content: String, documentPath: String) {}",
      facts: [
        "command_handler_argument_contract(persist_document,content,documentPath)",
      ],
    })],
  });
  const obligations = incidentBundle.coverageObligations || [];
  assert.ok(obligations.some((item) => item.kind === "contract_mismatch"));
  assert.ok(obligations.some((item) => item.kind === "causal_relation"));

  const draft = {
    schemaVersion: 2,
    evidenceRefs: ["E1", "E2", "E3"],
    goalEvidenceBases: [{
      goalRef: "G1",
      componentRef: "B1",
      evidenceRefs: ["E1", "E2"],
      ownerRefs: ["src/editor.ts", "src/runtime.ts"],
      relationRefs: ["Q1", "Q2"],
      diagnosisRefs: ["R2"],
    }, {
      goalRef: "G1",
      componentRef: "B2",
      evidenceRefs: ["E2", "E3"],
      ownerRefs: ["native/src/commands.rs", "src/runtime.ts"],
      relationRefs: ["Q3"],
      diagnosisRefs: ["R1"],
    }],
    summary: ["Repair the evidence-backed save chain."],
    diagnoses: [{
      id: "R1",
      text: "The command argument boundary is inconsistent.",
      certainty: "inferred",
      evidenceRefs: ["E2", "E3"],
      chainRefs: ["E2", "E3"],
      goalRefs: ["G1"],
    }, {
      id: "R2",
      text: "The programmatic event reaches the persistence side effect.",
      certainty: "inferred",
      evidenceRefs: ["E1", "E2"],
      chainRefs: ["E1", "E2"],
      goalRefs: ["G1"],
    }],
    changes: [{
      id: "C1",
      text: "Repair the persistence trigger and command argument at the runtime owner.",
      targetRef: "src/runtime.ts",
      operation: "modify",
      evidenceRefs: ["E2"],
      diagnosisRefs: ["R1", "R2"],
      goalRefs: ["G1"],
      expectedOutcome: "Opening a document does not schedule persistence and explicit persistence uses the native contract.",
      relationships: [],
    }],
    decisions: [],
    interfaces: [],
    validations: [{
      id: "V1",
      goalRefs: ["G1"],
      changeRefs: ["C1"],
      primitive: { kind: "finite_command", command: "node --test tests/node/typed-plan-ingress.test.mjs" },
      expectedOutcome: "The focused regression exits with status 0.",
    }],
    assumptions: [],
    blockingChoices: [],
  };
  const incomplete = createTypedRuntimePlanCandidate({
    draft,
    bundle: incidentBundle,
    authoringContract: incidentContract,
    language: "en",
  });
  assert.equal(incomplete.ok, false);
  assert.ok(incomplete.failures.some((failure) =>
    /candidate_coverage_disposition_missing:Q\d+:E1/.test(failure)
  ), JSON.stringify(incomplete));
  assert.ok(incomplete.failures.some((failure) =>
    /candidate_coverage_disposition_missing:Q\d+:E3/.test(failure)
  ), JSON.stringify(incomplete));

  draft.decisions = [{
    id: "D1",
    text: "Preserve the editor event contract.",
    disposition: "preserve",
    evidenceRefs: ["E1"],
    diagnosisRefs: ["R2"],
    goalRefs: ["G1"],
  }, {
    id: "D2",
    text: "Preserve the native handler signature.",
    disposition: "preserve",
    evidenceRefs: ["E3"],
    diagnosisRefs: ["R1"],
    goalRefs: ["G1"],
  }];
  const closed = createTypedRuntimePlanCandidate({
    draft,
    bundle: incidentBundle,
    authoringContract: incidentContract,
    language: "en",
  });
  assert.equal(closed.ok, true, JSON.stringify(closed));
  assert.match(closed.candidate.projection.content, /Evidence Closure/);
  assert.match(closed.candidate.projection.content, /documentPath/);
  assert.doesNotMatch(closed.candidate.projection.content, /listener_calls|source_observation\(/);
  assert.ok(closed.candidate.evidenceReceipt.facts.some((fact) =>
    fact.structuredFactBindings.some((binding) => /schedulePersistence/.test(binding.signature))
  ));

  const allPreserved = structuredClone(draft);
  allPreserved.changes = [];
  allPreserved.decisions = [
    {
      id: "D1",
      text: "Preserve the editor event contract.",
      disposition: "preserve",
      evidenceRefs: ["E1"],
      diagnosisRefs: ["R2"],
      goalRefs: ["G1"],
    },
    {
      id: "D2",
      text: "Preserve the runtime command caller.",
      disposition: "preserve",
      evidenceRefs: ["E2"],
      diagnosisRefs: ["R1", "R2"],
      goalRefs: ["G1"],
    },
    {
      id: "D3",
      text: "Preserve the native handler signature.",
      disposition: "preserve",
      evidenceRefs: ["E3"],
      diagnosisRefs: ["R1"],
      goalRefs: ["G1"],
    },
  ];
  allPreserved.validations[0].changeRefs = [];
  const unresolved = createTypedRuntimePlanCandidate({
    draft: allPreserved,
    bundle: incidentBundle,
    authoringContract: incidentContract,
    language: "en",
  });
  assert.equal(unresolved.ok, false);
  assert.match(unresolved.failures.join(","), /candidate_coverage_change_missing:Q\d+/);

  const unlinkedDecision = structuredClone(draft);
  unlinkedDecision.decisions[0].diagnosisRefs = [];
  const unlinked = createTypedRuntimePlanCandidate({
    draft: unlinkedDecision,
    bundle: incidentBundle,
    authoringContract: incidentContract,
    language: "en",
  });
  assert.equal(unlinked.ok, false);
  assert.match(unlinked.failures.join(","), /candidate_coverage_disposition_missing:Q\d+:E1/);

  const nonDiagnosticContract = createPlanAuthoringContract({
    objective: incidentObjective,
    contextSignals: {
      imageParts: 0,
      mentionedFilePaths: [],
      attachedFilePaths: [],
      subagentPreference: "unspecified",
    },
  });
  assert.equal(nonDiagnosticContract.diagnosisRequired, false);
  const missingRelationshipDiagnosis = structuredClone(draft);
  missingRelationshipDiagnosis.diagnoses = [];
  missingRelationshipDiagnosis.changes[0].diagnosisRefs = [];
  missingRelationshipDiagnosis.decisions.forEach((decision) => {
    decision.diagnosisRefs = [];
  });
  const relationshipRejected = createTypedRuntimePlanCandidate({
    draft: missingRelationshipDiagnosis,
    bundle: incidentBundle,
    authoringContract: nonDiagnosticContract,
    language: "en",
  });
  assert.equal(relationshipRejected.ok, false);
  assert.match(
    relationshipRejected.failures.join(","),
    /(?:candidate_coverage_diagnosis_missing:Q\d+|typed_goal_evidence_diagnosis_missing:B\d+)/,
  );

  const synthesized = createRuntimeSynthesizedPlanCandidate({
    bundle: incidentBundle,
    authoringContract: nonDiagnosticContract,
    language: "en",
    validationCommands: ["node --test tests/node/typed-plan-ingress.test.mjs"],
  });
  assert.equal(synthesized.ok, true, JSON.stringify(synthesized));
  assert.ok(synthesized.candidate.diagnoses.length > 0);
});

test("typed browser validation rejects guessed DOM targets and desktop-only substitution", () => {
  const surfaceBundle = buildPlanEvidenceBundle({
    objective: "Update src/runtime.ts so the existing Save control uses the current owner.",
    evidenceRecords: [runtimeSourceRecord({
      target: "src/runtime.ts",
      summary: "The exact source binds the Save control to a desktop command transport.",
      source: "const save = document.querySelector('#save-real'); import { invoke } from '@tauri-apps/api/core';",
      facts: [
        "interaction_target_contract(browser,#save-real)",
        "execution_surface_contract(desktop)",
      ],
    })],
  });
  const surfaceContract = createPlanAuthoringContract({
    objective: surfaceBundle.objective,
    contextSignals: {
      imageParts: 0,
      mentionedFilePaths: ["src/runtime.ts"],
      attachedFilePaths: [],
      subagentPreference: "unspecified",
    },
  });
  const draft = draftWithText("Update the existing Save control.", surfaceBundle);
  draft.validations[0] = {
    id: "V1",
    goalRefs: ["G1"],
    changeRefs: ["C1"],
    primitive: {
      kind: "browser_interaction",
      actions: [{ id: "A1", kind: "click", target: "#save-guessed" }],
      assertions: [{ kind: "visibility", target: "#done-guessed", afterActionId: "A1" }],
    },
    expectedOutcome: "The save outcome is visible.",
  };
  const guessed = createTypedRuntimePlanCandidate({
    draft,
    bundle: surfaceBundle,
    authoringContract: surfaceContract,
    language: "en",
  });
  assert.equal(guessed.ok, false);
  assert.ok(guessed.failures.some((failure) =>
    failure.includes("typed_validation_interaction_target_ungrounded:V1:#save-guessed")
  ), JSON.stringify(guessed));

  draft.validations[0].primitive.actions[0] = {
    id: "A1",
    kind: "direct_action",
    target: "save-with-guessed-runtime-target",
  };
  draft.validations[0].primitive.assertions[0] = {
    kind: "visibility",
    target: "save-complete-guessed",
    afterActionId: "A1",
  };
  const guessedDirectAction = createTypedRuntimePlanCandidate({
    draft,
    bundle: surfaceBundle,
    authoringContract: surfaceContract,
    language: "en",
  });
  assert.equal(guessedDirectAction.ok, false);
  assert.ok(guessedDirectAction.failures.includes(
    "typed_validation_interaction_target_ungrounded:V1:save-with-guessed-runtime-target",
  ), JSON.stringify(guessedDirectAction));
  assert.ok(guessedDirectAction.failures.includes(
    "typed_validation_interaction_target_ungrounded:V1:save-complete-guessed",
  ), JSON.stringify(guessedDirectAction));

  draft.validations[0].primitive.actions[0].kind = "click";
  draft.validations[0].primitive.actions[0].target = "#save-real";
  draft.validations[0].primitive.assertions[0].target = "#save-real";
  const wrongSurface = createTypedRuntimePlanCandidate({
    draft,
    bundle: surfaceBundle,
    authoringContract: surfaceContract,
    language: "en",
  });
  assert.equal(wrongSurface.ok, false);
  assert.ok(wrongSurface.failures.includes(
    "typed_change_validation_surface_ungrounded:C1:desktop",
  ), JSON.stringify(wrongSurface));

  draft.validations[0].primitive = {
    kind: "finite_command",
    command: "node --test tests/node/typed-plan-ingress.test.mjs",
  };
  const finite = createTypedRuntimePlanCandidate({
    draft,
    bundle: surfaceBundle,
    authoringContract: surfaceContract,
    language: "en",
  });
  assert.equal(finite.ok, false);
  assert.ok(finite.failures.includes(
    "typed_change_validation_surface_ungrounded:C1:desktop",
  ), JSON.stringify(finite));

  const harnessBundle = buildPlanEvidenceBundle({
    objective: surfaceBundle.objective,
    evidenceRecords: [runtimeSourceRecord({
      target: "src/runtime.ts",
      summary: "The exact source binds the Save control and native desktop harness to the runtime owner.",
      source: "const save = document.querySelector('#save-real'); const nativeHarness = 'typed-plan-ingress';",
      facts: [
        "interaction_target_contract(browser,#save-real)",
        "execution_surface_contract(desktop)",
        {
          kind: "validation_capability",
          surface: "desktop",
          producer: "native_harness",
          ownerRef: "src/runtime.ts",
          command: "node --test tests/node/typed-plan-ingress.test.mjs",
        },
      ],
    })],
  });
  const harnessBacked = createTypedRuntimePlanCandidate({
    draft,
    bundle: harnessBundle,
    authoringContract: surfaceContract,
    language: "en",
  });
  assert.equal(harnessBacked.ok, true, JSON.stringify(harnessBacked));
});

test("toolbar, editor, main, and Rust source owners stay independent until the typed Plan maps them to goals", () => {
  const productionObjective = [
    "1. Stop the local-document open flow from creating an unexpected window.",
    "2. Keep editor state and the native save command contract consistent.",
  ].join("\n");
  const productionBundle = buildPlanEvidenceBundle({
    objective: productionObjective,
    evidenceRecords: [runtimeSourceRecord({
      target: "src/toolbar.ts",
      summary: "The toolbar owns the local-document control.",
      source: "openButton.addEventListener('click', openLocalDocument);",
      facts: ["interaction_target_contract(browser,Open local document)"],
    }), runtimeSourceRecord({
      target: "src/editor.ts",
      summary: "Programmatic editor updates dispatch the input event.",
      source: "textarea.value = content; textarea.dispatchEvent(new Event('input'));",
      facts: ["event_dom_dispatch_contract(input)"],
    }), runtimeSourceRecord({
      target: "src/main.ts",
      summary: "The input listener schedules persistence and invokes the native save command.",
      source: [
        "textarea.addEventListener('input', () => scheduleAutoSave());",
        "invoke('save_file_content', { file_path, content });",
      ].join("\n"),
      facts: [
        "event_dom_listener_contract(input)",
        "listener_calls(scheduleAutoSave)",
        "command_invoke_argument_contract(save_file_content,file_path,content)",
      ],
    }), runtimeSourceRecord({
      target: "src-tauri/src/commands.rs",
      summary: "The Rust handler owns the native save argument boundary.",
      source: "fn save_file_content(content: String, filePath: String) {}",
      facts: ["command_handler_argument_contract(save_file_content,content,filePath)"],
    })],
  });
  const productionContract = createPlanAuthoringContract({
    objective: productionObjective,
    diagnosisRequirement: "required",
    contextSignals: {
      imageParts: 0,
      mentionedFilePaths: [],
      attachedFilePaths: [],
      subagentPreference: "unspecified",
    },
  });
  assert.deepEqual(productionContract.facets.map((goal) => goal.id), ["G1", "G2"]);
  const componentCapacity = assessPlanEvidenceComponentCapacity({
    facets: productionContract.facets,
    components: productionBundle.evidenceComponents || [],
    diagnosisRequired: true,
  });
  assert.equal(componentCapacity.ready, true, JSON.stringify(componentCapacity));

  const obligationById = new Map((productionBundle.coverageObligations || [])
    .map((obligation) => [obligation.id, obligation]));
  const componentWithRelationKind = (kind) => (productionBundle.evidenceComponents || [])
    .find((component) => component.relationRefs.some((reference) =>
      obligationById.get(reference)?.kind === kind
    ));
  const causalComponent = componentWithRelationKind("causal_relation");
  const mismatchComponent = componentWithRelationKind("contract_mismatch");
  const toolbarComponent = (productionBundle.evidenceComponents || []).find((component) =>
    component.requiredForClosure === false &&
    component.ownerRefs.length === 1 &&
    component.ownerRefs[0] === "src/toolbar.ts"
  );
  assert.ok(causalComponent, JSON.stringify(productionBundle));
  assert.ok(mismatchComponent, JSON.stringify(productionBundle));
  assert.ok(toolbarComponent, JSON.stringify(productionBundle));
  assert.equal(toolbarComponent.supportsDiagnosis, false);

  const factRef = (target) => productionBundle.facts.find((fact) => fact.target === target)?.id;
  const toolbarRef = factRef("src/toolbar.ts");
  const editorRef = factRef("src/editor.ts");
  const mainRef = factRef("src/main.ts");
  const rustRef = factRef("src-tauri/src/commands.rs");
  assert.ok(toolbarRef && editorRef && mainRef && rustRef);
  const basis = (goalRef, component, diagnosisRef) => ({
    goalRef,
    componentRef: component.id,
    evidenceRefs: [...component.evidenceRefs],
    ownerRefs: [...component.ownerRefs],
    relationRefs: [...component.relationRefs],
    diagnosisRefs: [diagnosisRef],
  });
  const diagnosis = (id, goalRef, component, text) => ({
    id,
    text,
    certainty: "inferred",
    evidenceRefs: [...component.evidenceRefs],
    chainRefs: [...component.evidenceRefs],
    goalRefs: [goalRef],
  });
  const productionDraft = {
    schemaVersion: 2,
    evidenceRefs: [toolbarRef, editorRef, mainRef, rustRef],
    goalEvidenceBases: [
      basis("G1", causalComponent, "R1"),
      basis("G2", mismatchComponent, "R2"),
      basis("G1", toolbarComponent, "R3"),
    ],
    summary: ["Repair the complete local-document and native save chain."],
    diagnoses: [
      diagnosis("R1", "G1", causalComponent, "A programmatic editor event reaches the persistence listener."),
      diagnosis("R2", "G2", mismatchComponent, "The frontend and Rust save argument identities differ."),
      diagnosis("R3", "G1", toolbarComponent, "The exact toolbar owner supplies the local-document entry point."),
    ],
    changes: [{
      id: "C1",
      text: "Keep local-document orchestration at the toolbar owner.",
      targetRef: "src/toolbar.ts",
      operation: "modify",
      evidenceRefs: [toolbarRef],
      diagnosisRefs: ["R3"],
      goalRefs: ["G1"],
      expectedOutcome: "The toolbar starts one local-document flow.",
      relationships: [],
    }, {
      id: "C2",
      text: "Separate programmatic editor hydration from user input persistence.",
      targetRef: "src/editor.ts",
      operation: "modify",
      evidenceRefs: [editorRef],
      diagnosisRefs: ["R1"],
      goalRefs: ["G1"],
      expectedOutcome: "Hydration does not masquerade as user input.",
      relationships: [],
    }, {
      id: "C3",
      text: "Align listener behavior and the native save payload.",
      targetRef: "src/main.ts",
      operation: "modify",
      evidenceRefs: [mainRef],
      diagnosisRefs: ["R1", "R2"],
      goalRefs: ["G1", "G2"],
      expectedOutcome: "Only user edits schedule persistence and the payload uses the native identity.",
      relationships: [],
    }, {
      id: "C4",
      text: "Keep the Rust handler aligned with the typed frontend payload.",
      targetRef: "src-tauri/src/commands.rs",
      operation: "modify",
      evidenceRefs: [rustRef],
      diagnosisRefs: ["R2"],
      goalRefs: ["G2"],
      expectedOutcome: "The command boundary has one argument identity.",
      relationships: [],
    }],
    decisions: [],
    interfaces: [],
    validations: [{
      id: "V1",
      goalRefs: ["G1", "G2"],
      changeRefs: ["C1", "C2", "C3", "C4"],
      primitive: { kind: "finite_command", command: "node --test tests/node/typed-plan-ingress.test.mjs" },
      expectedOutcome: "The four-owner regression exits with status 0.",
    }],
    assumptions: [],
    blockingChoices: [],
  };
  const accepted = createTypedRuntimePlanCandidate({
    draft: productionDraft,
    bundle: productionBundle,
    authoringContract: productionContract,
    language: "en",
  });
  assert.equal(accepted.ok, true, JSON.stringify(accepted));
  assert.deepEqual(
    accepted.candidate.goalEvidenceBases.map((item) => [item.goalRef, item.componentRef]),
    productionDraft.goalEvidenceBases.map((item) => [item.goalRef, item.componentRef]),
  );

  const reused = structuredClone(productionDraft);
  reused.goalEvidenceBases.push(basis("G2", causalComponent, "R2"));
  const rejected = createTypedRuntimePlanCandidate({
    draft: reused,
    bundle: productionBundle,
    authoringContract: productionContract,
    language: "en",
  });
  assert.ok(rejected.failures.some((failure) =>
    failure.startsWith(`typed_goal_evidence_component_reused:${causalComponent.id}:`)
  ), JSON.stringify(rejected));
});

test("a planned desktop harness must be an exact create-or-modify change bound to its finite validator", () => {
  const harnessObjective = "Update src/App.tsx and add a finite desktop acceptance harness.";
  const harnessBundle = buildPlanEvidenceBundle({
    objective: harnessObjective,
    evidenceRecords: [runtimeSourceRecord({
      target: "src/App.tsx",
      summary: "The application owner runs on the desktop surface.",
      source: "export function App() { return <main>Desktop</main>; }",
      facts: ["execution_surface_contract(desktop)"],
    }), runtimeSourceRecord({
      target: "package.json",
      summary: "The workspace manifest owns finite test scripts.",
      source: JSON.stringify({ scripts: { test: "node --test" } }, null, 2),
      facts: [],
    })],
  });
  const harnessContract = createPlanAuthoringContract({
    objective: harnessObjective,
    contextSignals: {
      imageParts: 0,
      mentionedFilePaths: ["src/App.tsx"],
      attachedFilePaths: [],
      subagentPreference: "unspecified",
    },
  });
  const appRef = harnessBundle.facts.find((fact) => fact.target === "src/App.tsx")?.id;
  const manifestRef = harnessBundle.facts.find((fact) => fact.target === "package.json")?.id;
  assert.ok(appRef && manifestRef);
  const requiredComponent = (harnessBundle.evidenceComponents || [])
    .find((component) => component.requiredForClosure);
  assert.ok(requiredComponent, JSON.stringify(harnessBundle));
  const baseDraft = {
    schemaVersion: 2,
    evidenceRefs: [appRef, manifestRef],
    goalEvidenceBases: [{
      goalRef: "G1",
      componentRef: requiredComponent.id,
      evidenceRefs: [...requiredComponent.evidenceRefs],
      ownerRefs: [...requiredComponent.ownerRefs],
      relationRefs: [...requiredComponent.relationRefs],
      diagnosisRefs: [],
    }],
    summary: ["Change the product and add its finite desktop verifier in one reviewed graph."],
    diagnoses: [],
    changes: [{
      id: "C1",
      text: "Update the desktop application behavior.",
      targetRef: "src/App.tsx",
      operation: "modify",
      evidenceRefs: [appRef],
      diagnosisRefs: [],
      goalRefs: ["G1"],
      expectedOutcome: "The desktop application exposes the updated behavior.",
      relationships: [],
    }, {
      id: "C2",
      text: "Create a finite desktop acceptance harness.",
      targetRef: "tests/native-ui.test.mjs",
      targetOwnerRef: "package.json",
      operation: "create",
      evidenceRefs: [manifestRef],
      diagnosisRefs: [],
      goalRefs: ["G1"],
      expectedOutcome: "The new harness exercises the desktop behavior.",
      relationships: [],
      plannedValidationHarness: {
        surface: "desktop",
        ownerRef: "package.json",
        binding: { kind: "direct_target", targetRef: "tests/native-ui.test.mjs" },
      },
    }],
    decisions: [],
    interfaces: [],
    validations: [{
      id: "V1",
      goalRefs: ["G1"],
      changeRefs: ["C1", "C2"],
      harnessChangeRef: "C2",
      primitive: { kind: "finite_command", command: "node --test tests/native-ui.test.mjs" },
      expectedOutcome: "The planned desktop harness exits with status 0.",
    }],
    assumptions: [],
    blockingChoices: [],
  };
  const directTarget = createTypedRuntimePlanCandidate({
    draft: baseDraft,
    bundle: harnessBundle,
    authoringContract: harnessContract,
    language: "en",
  });
  assert.equal(directTarget.ok, true, JSON.stringify(directTarget));

  const unbound = structuredClone(baseDraft);
  unbound.validations[0].primitive.command = "node --test tests/some-other.test.mjs";
  const unboundResult = createTypedRuntimePlanCandidate({
    draft: unbound,
    bundle: harnessBundle,
    authoringContract: harnessContract,
    language: "en",
  });
  assert.ok(unboundResult.failures.includes(
    "typed_validation_harness_command_unbound:V1:C2",
  ), JSON.stringify(unboundResult));

  const manifestScript = structuredClone(baseDraft);
  manifestScript.changes[1] = {
    ...manifestScript.changes[1],
    text: "Register the finite desktop acceptance script.",
    targetRef: "package.json",
    operation: "modify",
    plannedValidationHarness: {
      surface: "desktop",
      ownerRef: "package.json",
      binding: { kind: "manifest_script", manifestRef: "package.json", scriptName: "test:desktop" },
    },
  };
  delete manifestScript.changes[1].targetOwnerRef;
  manifestScript.validations[0].primitive = {
    kind: "finite_command",
    command: "npm run test:desktop",
    cwd: ".",
  };
  const manifestResult = createTypedRuntimePlanCandidate({
    draft: manifestScript,
    bundle: harnessBundle,
    authoringContract: harnessContract,
    language: "en",
  });
  assert.equal(manifestResult.ok, true, JSON.stringify(manifestResult));

  const wrongHarnessRef = structuredClone(manifestScript);
  wrongHarnessRef.validations[0].harnessChangeRef = "C1";
  const wrongHarnessResult = createTypedRuntimePlanCandidate({
    draft: wrongHarnessRef,
    bundle: harnessBundle,
    authoringContract: harnessContract,
    language: "en",
  });
  assert.ok(wrongHarnessResult.failures.includes(
    "typed_validation_harness_change_invalid:V1",
  ), JSON.stringify(wrongHarnessResult));
});

test("exact source observations remain immutable from runtime read through sealed candidate", () => {
  const exactExcerpt = [
    "  patchEditorAPI.setValue = (value) => {  ",
    "    textarea.value = value;",
    "    textarea.dispatchEvent(new Event('input'));",
    "  };",
    "",
  ].join("\n");
  const readResult = [
    "READ_FILE_RESULT",
    "path: src/runtime.ts",
    "truncated: false",
    "totalLines: 44",
    "returnedLines: 20-24",
    "---CONTENT START---",
    exactExcerpt,
    "---CONTENT END---",
  ].join("\n");
  assert.deepEqual(extractRuntimePlanSourceObservations({
    target: "src/runtime.ts",
    content: readResult,
  }), []);
  assert.deepEqual(extractRuntimePlanSourceObservations({
    target: "src/another-owner.ts",
    content: readResult,
    readFileObservation: {
      path: "src/runtime.ts",
      requestSignature: "read_file:src/runtime.ts:20-24",
      versionToken: "sha256-runtime-v1",
      window: { startLine: 20, endLine: 24 },
    },
  }), []);
  const sourceObservations = extractRuntimePlanSourceObservations({
    target: "src/runtime.ts",
    content: readResult,
    readFileObservation: {
      path: "src/runtime.ts",
      requestSignature: "read_file:src/runtime.ts:20-24",
      versionToken: "sha256-runtime-v1",
      window: { startLine: 20, endLine: 24 },
    },
  });
  assert.equal(sourceObservations.length, 1);
  assert.equal(sourceObservations[0].excerpt, exactExcerpt);
  assert.equal(sourceObservations[0].startLine, 20);
  assert.equal(sourceObservations[0].endLine, 24);

  const sourceBundle = buildPlanEvidenceBundle({
    objective,
    evidenceRecords: [{
      tool: "read_file",
      target: "src/runtime.ts",
      status: "succeeded",
      summary: "The programmatic value update dispatches input to the persistence listener.",
      structuredFacts: createRuntimePlanStructuredEvidenceFacts([
        "event_dom_dispatch_contract(input)",
        "listener_calls(scheduleAutoSave)",
      ], { sourceObservationRefs: sourceObservations.map((item) => item.observationRef) }),
      sourceObservations,
    }],
  });
  const prompt = formatPlanEvidenceBundleForModel(sourceBundle, "en");
  assert.equal(
    sourceBundle.facts[0].summary,
    "The programmatic value update dispatches input to the persistence listener.",
  );
  assert.match(prompt, /source_observation id=E1\.O1/);
  assert.match(prompt, /dispatchEvent/);
  assert.match(prompt, /scheduleAutoSave/);
  assert.match(prompt, /source-sha256-/);
  assert.ok(
    prompt.indexOf("The programmatic value update dispatches input") <
      prompt.indexOf("event_dom_dispatch_contract"),
  );

  const result = createTypedRuntimePlanCandidate({
    draft: draftWithText("Prevent the programmatic input event from scheduling persistence.", sourceBundle),
    bundle: sourceBundle,
    authoringContract: contract,
    language: "en",
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.candidate.evidence[0].sourceObservations, sourceObservations);
  assert.match(
    result.candidate.projection.content,
    /The programmatic value update dispatches input to the persistence listener\./,
  );
  assert.doesNotMatch(
    result.candidate.projection.content,
    /source_observation\(|version=|event_dom_dispatch_contract|listener_calls/,
  );

  const sealed = sealPlanCandidate({
    candidate: result.candidate,
    content: result.candidate.projection.content,
    runtimeTasks: [],
  });
  assert.deepEqual(validateSealedPlanCandidate({
    candidate: sealed,
    expectedContent: sealed.projection.content,
    expectedBundleHash: sourceBundle.hash,
  }), []);

  const tampered = structuredClone(sealed);
  tampered.evidence[0].sourceObservations[0].excerpt += "// altered";
  assert.match(
    validateSealedPlanCandidate({ candidate: tampered }).join(","),
    /candidate_evidence_source_observation_invalid:E1/,
  );
  assert.deepEqual(normalizePlanSourceObservations(
    tampered.evidence[0].sourceObservations,
  ), []);
});

test("runtime typed ingress renders Markdown only after graph validation", () => {
  const raw = `This text is not authority.\n${envelope(draftWithText("Bind runtime ownership."))}\nNor is this.`;
  const result = materializePlanArtifactFromVisibleText({
    visibleText: raw,
    ingressMode: "typed_runtime",
    userGoal: objective,
    evidenceBundle: bundle,
    language: "en",
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.source, "typed_runtime_plan");
  assert.equal(result.candidate.ingress, "typed_runtime");
  assert.match(result.content, /# Plan/);
  assert.doesNotMatch(result.content, /This text is not authority|Nor is this|plan_candidate|schemaVersion/);
  assert.equal(result.content, result.candidate.projection.content);
});

test("native submit tool arguments enter the same validate and render ingress", () => {
  const draft = draftWithText("Bind runtime ownership through native submission.");
  const submission = consumeNativePlanCandidateSubmission({
    enabled: true,
    result: {
      content: "free-form progress is not Plan authority",
      toolCalls: [{
        index: 0,
        id: "call-submit-plan",
        name: "submit_plan_candidate",
        arguments: JSON.stringify(draft),
      }],
      finishReason: "tool_calls",
    },
  });
  assert.equal(submission.consumed, true);
  const result = materializePlanArtifactFromVisibleText({
    visibleText: submission.result.content,
    ingressMode: "typed_runtime",
    userGoal: objective,
    evidenceBundle: bundle,
    language: "en",
  });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.source, "typed_runtime_plan");
  assert.equal(result.candidate.ingress, "typed_runtime");
  assert.match(result.content, /Bind runtime ownership through native submission/);
  assert.doesNotMatch(result.content, /free-form progress|plan_candidate|schemaVersion/);
});

test("typed ingress tolerates a JSON fence but rejects multiple candidates as ambiguous", () => {
  const draft = draftWithText("Bind runtime ownership.");
  const fenced = materializePlanArtifactFromVisibleText({
    visibleText: `<plan_candidate>\n\`\`\`json\n${JSON.stringify(draft)}\n\`\`\`\n</plan_candidate>`,
    ingressMode: "typed_runtime",
    userGoal: objective,
    evidenceBundle: bundle,
    language: "en",
  });
  assert.equal(fenced.ok, true, JSON.stringify(fenced));

  const ambiguous = materializePlanArtifactFromVisibleText({
    visibleText: `${envelope(draft)}\n${envelope(draft)}`,
    ingressMode: "typed_runtime",
    userGoal: objective,
    evidenceBundle: bundle,
    language: "en",
  });
  assert.equal(ambiguous.ok, false);
  assert.match(ambiguous.reason, /typed_plan_(?:draft|repair)_ambiguous_multiple/);
});

test("typed interaction validation requires recognized causal action identities", () => {
  const draft = draftWithText("Bind runtime ownership.");
  draft.validations[0].primitive = {
    kind: "browser_interaction",
    actions: [{ kind: "click", target: "#save" }],
    assertions: [{ kind: "visibility", target: "#done" }],
  };
  const result = materializePlanArtifactFromVisibleText({
    visibleText: envelope(draft),
    ingressMode: "typed_runtime",
    userGoal: objective,
    evidenceBundle: bundle,
    language: "en",
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /browser_interaction_causal_contract_invalid/);
});

test("typed interaction ingress reports unsupported runtime verbs before generic invalidity", () => {
  const unsupportedAction = draftWithText("Bind runtime ownership.");
  unsupportedAction.validations[0].primitive = {
    kind: "browser_interaction",
    actions: [{ id: "save", kind: "open", target: "#save" }],
    assertions: [{ kind: "visibility", target: "#done", afterActionId: "save" }],
  };
  const actionResult = materializePlanArtifactFromVisibleText({
    visibleText: envelope(unsupportedAction),
    ingressMode: "typed_runtime",
    userGoal: objective,
    evidenceBundle: bundle,
    language: "en",
  });
  assert.equal(actionResult.ok, false);
  assert.match(actionResult.reason, /browser_interaction_action_kind_unsupported:open/);

  const unsupportedAssertion = draftWithText("Bind runtime ownership.");
  unsupportedAssertion.validations[0].primitive = {
    kind: "browser_interaction",
    actions: [{ id: "save", kind: "click", target: "#save" }],
    assertions: [{ kind: "popup_magic", target: "#done", afterActionId: "save" }],
  };
  const assertionResult = materializePlanArtifactFromVisibleText({
    visibleText: envelope(unsupportedAssertion),
    ingressMode: "typed_runtime",
    userGoal: objective,
    evidenceBundle: bundle,
    language: "en",
  });
  assert.equal(assertionResult.ok, false);
  assert.match(assertionResult.reason, /browser_interaction_assertion_kind_unsupported:popup_magic/);
});

test("typed validation ingress reports the exact invalid field", () => {
  const cases = [
    {
      primitive: { kind: "assertion", acceptance: "required", target: "runtime:plan.D1", matcher: "runtime_result", producer: "runtime_evidence_ledger" },
      failure: "assertion_acceptance_unsupported:required",
    },
    {
      primitive: { kind: "assertion", matcher: "exists", producer: "runtime_evidence_ledger" },
      failure: "assertion_target_missing",
    },
    {
      primitive: { kind: "assertion", target: "runtime:plan.D1", producer: "runtime_evidence_ledger" },
      failure: "assertion_matcher_missing",
    },
    {
      primitive: { kind: "assertion", target: "runtime:plan.D1", matcher: "approximately", producer: "runtime_evidence_ledger" },
      failure: "assertion_matcher_unsupported:approximately",
    },
    {
      primitive: { kind: "assertion", target: "runtime:plan.D1", matcher: "runtime_result" },
      failure: "assertion_producer_missing",
    },
    {
      primitive: { kind: "assertion", target: "runtime:plan.D1", matcher: "runtime_result", producer: "browser_dom" },
      failure: "assertion_producer_unsupported:browser_dom",
    },
    {
      primitive: { kind: "assertion", target: "workspace:src/runtime.ts", matcher: "contains", producer: "workspace_file_state", expected: { text: "owner" } },
      failure: "assertion_expected_type_invalid:object",
    },
    {
      primitive: { kind: "assertion", target: "workspace:src/runtime.ts", matcher: "contains", producer: "workspace_file_state" },
      failure: "assertion_expected_missing",
    },
    {
      primitive: { kind: "browser_interaction", actions: [{ id: "A1", kind: "click" }], assertions: [{ kind: "visibility", target: "#done", afterActionId: "A1" }] },
      failure: "browser_interaction_action_target_missing:1",
    },
    {
      primitive: { kind: "browser_interaction", actions: [], assertions: [{ kind: "visibility", target: "#done", expected: ["visible"] }] },
      failure: "browser_interaction_assertion_expected_type_invalid:1:array",
    },
    {
      primitive: { kind: "service_observation", launchCommand: "npm run dev", readiness: { kind: "eventually", expected: true } },
      failure: "service_observation_readiness_kind_unsupported:eventually",
    },
  ];

  for (const { primitive, failure } of cases) {
    const draft = draftWithText(`Reject ${failure}.`);
    draft.validations[0].primitive = primitive;
    const result = createTypedRuntimePlanCandidate({
      draft,
      bundle,
      authoringContract: contract,
      language: "en",
    });
    assert.equal(result.ok, false, failure);
    assert.match(result.failures.join(","), new RegExp(failure.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("real evidence builder, injected IDs, and typed ingress share one identity", () => {
  const runtimeBundle = buildPlanEvidenceBundle({
    turnId: "real-builder-turn",
    objective,
    evidenceRecords: [{
      tool: "read_file",
      target: "src/runtime.ts",
      status: "succeeded",
      summary: "The current runtime owner is read at this boundary and the update must preserve it.",
    }],
    files: ["src/runtime.ts"],
  });
  assert.equal(runtimeBundle.facts[0]?.id, "E1");
  assert.match(formatPlanEvidenceBundleForModel(runtimeBundle, "en"), /\[E1\].*src\/runtime\.ts/);
  const result = materializePlanArtifactFromVisibleText({
    visibleText: envelope(draftWithText("Use the exact injected evidence identity.")),
    ingressMode: "typed_runtime",
    userGoal: objective,
    evidenceBundle: runtimeBundle,
    language: "en",
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.candidate.evidence.map((item) => item.id), ["E1"]);
});

test("deterministic fallback constructs runtime_synthesized authority without Markdown parsing", () => {
  const result = createRuntimeSynthesizedPlanCandidate({
    bundle,
    authoringContract: contract,
    language: "en",
    validationCommands: ["node --test tests/node/typed-plan-ingress.test.mjs"],
    diagnosisText: "The frozen runtime evidence establishes the owner boundary.",
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.candidate.ingress, "runtime_synthesized");
  assert.deepEqual(result.candidate.changes.map((item) => item.targetRef), ["src/runtime.ts"]);
  assert.equal(result.candidate.validations[0].primitive.kind, "finite_command");
  assert.equal(result.candidate.projection.content.includes("schemaVersion"), false);

  const missingPrimitive = createRuntimeSynthesizedPlanCandidate({
    bundle,
    authoringContract: contract,
    language: "en",
    validationCommands: ["npm run dev"],
  });
  assert.equal(missingPrimitive.ok, false);
  assert.deepEqual(missingPrimitive.failures, ["typed_plan_executable_validation_missing"]);
});

test("production Plan prompts and materialization calls cannot regress to legacy Markdown authority", () => {
  const promptFiles = [
    path.join(workspaceRoot, "src/lib/systemPrompt.ts"),
    path.join(workspaceRoot, "src/lib/planRuntime.ts"),
    path.join(workspaceRoot, "src/lib/planAuthoringContract.ts"),
    path.join(workspaceRoot, "src/store/submitPromptContext.ts"),
    path.join(workspaceRoot, "src/store/runtimeV2/planRunner.ts"),
    path.join(workspaceRoot, "src/store/runtimeV2/workPlanAdapter.ts"),
  ];
  const promptSource = promptFiles.map((file) => fs.readFileSync(file, "utf8")).join("\n");
  assert.doesNotMatch(promptSource, /<proposed_plan>/i);
  assert.match(promptSource, /<plan_candidate>/i);
  assert.equal(fs.existsSync(path.join(workspaceRoot, "src/lib/orchestrator.ts")), false);
  assert.equal(
    fs.readdirSync(path.join(workspaceRoot, "src/lib/orchestrator"), {
      recursive: true,
      withFileTypes: true,
    }).some((entry) => entry.isFile()),
    false,
  );

  const runtimeToolsSource = fs.readFileSync(path.join(workspaceRoot, "src/lib/runtimeTools.ts"), "utf8");
  assert.doesNotMatch(
    runtimeToolsSource,
    /!input\.isPlanApproved\s*&&\s*input\.isPreApprovalPlanDraftWrite[\s\S]{0,240}?action:\s*"spec_file_auto_approved"/,
  );
  assert.match(runtimeToolsSource, /reason:\s*"pre_approval_plan_artifact_write"/);
});

test("legacy Markdown is isolated from runtime typed ingress", () => {
  const legacy = [
    "<proposed_plan>",
    "# Legacy plan",
    "## Changes",
    "- Modify `src/runtime.ts` using the confirmed runtime evidence.",
    "## Test Plan",
    "- Run `node --test tests/node/typed-plan-ingress.test.mjs` and require exit status 0.",
    "</proposed_plan>",
  ].join("\n");
  const runtime = materializePlanArtifactFromVisibleText({
    visibleText: legacy,
    ingressMode: "typed_runtime",
    userGoal: objective,
    evidenceBundle: bundle,
    language: "en",
  });
  assert.equal(runtime.ok, false);
  assert.equal(runtime.reason, "typed_plan_draft_missing");
  assert.equal(extractExplicitPlanProtocolFromReasoning(legacy), null);
  assert.deepEqual(classifyPlanArtifactQualityResult({ ok: false, reason: runtime.reason }), {
    ok: false,
    reason: "typed_plan_draft_missing",
    missingSections: [],
    recoveryAction: "rewrite",
    canAutoRepair: false,
  });
});

test("complete typed protocol in reasoning remains non-authoritative", () => {
  const protocol = envelope(draftWithText("Use the revised owner binding."));
  const reasoning = `private prefix\n${protocol}\nprivate suffix`;
  assert.equal(extractExplicitPlanProtocolFromReasoning(reasoning), null);
  assert.equal(hasExplicitPlanProposal(protocol), true);
  const extracted = extractTieredPlanProposal(protocol);
  assert.equal(extracted.kind, "typed_plan_candidate");
  assert.equal(extracted.protocol, protocol);
  assert.equal(sanitizeAssistantDisplayContent(reasoning), "private prefix\n\nprivate suffix");
  assert.equal(sanitizeAssistantDisplayContent(`<plan_candidate>{\"schemaVersion\":1`), "");
});

test("create actions require a structured evidence-backed owner boundary", () => {
  const createContract = createPlanAuthoringContract({
    objective: "Add src/feature/new.ts within the existing feature module.",
    contextSignals: {
      imageParts: 0,
      mentionedFilePaths: ["src/feature/index.ts"],
      attachedFilePaths: [],
      subagentPreference: "unspecified",
    },
  });
  const createBundle = {
    ...bundle,
    objective: createContract.objective,
    facts: [{ ...bundle.facts[0], target: "src/feature/index.ts" }],
    observedTargets: ["src/feature/index.ts"],
    changeTargets: ["src/feature/new.ts"],
    coverageObligations: [],
  };
  createBundle.evidenceComponents = [{
    ...bundle.evidenceComponents[0],
    ownerRefs: ["src/feature/index.ts"],
    relationRefs: [],
    requiredForClosure: false,
  }];
  const base = draftWithText("Add the new module file.", createBundle);
  base.changes[0] = {
    ...base.changes[0],
    targetRef: "src/feature/new.ts",
    targetOwnerRef: "src/feature/index.ts",
    operation: "create",
  };
  const accepted = createTypedRuntimePlanCandidate({
    draft: base,
    bundle: createBundle,
    authoringContract: createContract,
    language: "en",
  });
  assert.equal(accepted.ok, true, JSON.stringify(accepted));

  const missingOwner = structuredClone(base);
  delete missingOwner.changes[0].targetOwnerRef;
  const rejected = createTypedRuntimePlanCandidate({
    draft: missingOwner,
    bundle: createBundle,
    authoringContract: createContract,
    language: "en",
  });
  assert.equal(rejected.ok, false);
  assert.match(rejected.failures.join(","), /typed_change_owner_missing:C1/);
});

test("decision-only Plans retain advisory assertions but require executable acceptance", () => {
  const decisionContract = createPlanAuthoringContract({
    objective: "Decide whether to preserve the current runtime ownership contract.",
    contextSignals: {
      imageParts: 0,
      mentionedFilePaths: ["src/runtime.ts"],
      attachedFilePaths: [],
      subagentPreference: "unspecified",
    },
  });
  const decisionBundle = {
    ...bundle,
    objective: decisionContract.objective,
    changeTargets: [],
    verificationTargets: [],
    coverageObligations: [],
    evidenceComponents: [{
      id: "B1",
      evidenceRefs: ["E1"],
      ownerRefs: ["src/runtime.ts"],
      relationRefs: [],
      supportsDiagnosis: false,
      requiredForClosure: false,
    }],
  };
  const draft = {
    schemaVersion: 2,
    evidenceRefs: ["E1"],
    goalEvidenceBases: goalEvidenceBasesFor(decisionBundle),
    summary: [],
    diagnoses: [],
    changes: [],
    decisions: [{
      id: "D1",
      text: "Preserve the ownership boundary.",
      disposition: "preserve",
      evidenceRefs: ["E1"],
      diagnosisRefs: [],
      goalRefs: ["G1"],
    }],
    interfaces: [],
    validations: [{
      id: "V1",
      goalRefs: ["G1"],
      changeRefs: [],
      primitive: { kind: "assertion", acceptance: "advisory", target: "runtime:sealed_plan.decision.D1", matcher: "runtime_result", producer: "runtime_evidence_ledger" },
      expectedOutcome: "The decision is recorded in the sealed graph.",
    }],
    assumptions: [],
    blockingChoices: [],
  };
  const advisoryOnly = createTypedRuntimePlanCandidate({
    draft,
    bundle: decisionBundle,
    authoringContract: decisionContract,
    language: "en",
  });
  assert.equal(advisoryOnly.ok, false);
  assert.match(advisoryOnly.failures.join(","), /typed_goal_validation_missing:G1/);

  draft.validations.push({
    id: "V2",
    goalRefs: ["G1"],
    changeRefs: [],
    primitive: {
      kind: "finite_command",
      command: "node -e \"const value = 1; if (value !== 1) process.exit(1)\"",
    },
    expectedOutcome: "The sealed decision graph passes its finite contract check.",
  });
  const result = createTypedRuntimePlanCandidate({
    draft,
    bundle: decisionBundle,
    authoringContract: decisionContract,
    language: "en",
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.candidate.changes.length, 0);
  assert.equal(result.candidate.decisions.length, 1);
  assert.equal(result.candidate.validations[0].primitive.kind, "assertion");
  assert.equal(result.candidate.validations[0].blocking, false);
  assert.equal(result.candidate.validations[1].blocking, true);

  const materialized = materializePlanArtifactFromVisibleText({
    visibleText: envelope(draft),
    ingressMode: "typed_runtime",
    userGoal: decisionContract.objective,
    evidenceBundle: decisionBundle,
    language: "en",
  });
  assert.equal(materialized.ok, true, JSON.stringify(materialized));
  assert.equal(materialized.candidate.decisions.length, 1);
});

test("empty-workspace create materializes from a structured root owner without inferred changeTargets", () => {
  const createObjective = "Create src/index.ts in the inspected empty workspace.";
  const emptyBundle = {
    bundleId: "empty-workspace-bundle",
    hash: "empty-workspace-hash",
    turnId: "empty-workspace-turn",
    objective: createObjective,
    constraints: [],
    facts: [{
      id: "E1",
      tool: "get_project_skeleton",
      target: ".",
      summary: "The workspace root exists and contains no source files.",
      hash: "empty-workspace-root",
    }],
    observedTargets: [],
    changeTargets: [],
    verificationTargets: [],
    coverageObligations: [],
    evidenceComponents: [{
      id: "B1",
      evidenceRefs: ["E1"],
      ownerRefs: ["."],
      relationRefs: [],
      supportsDiagnosis: false,
      requiredForClosure: false,
    }],
  };
  const createDraft = draftWithText("Create the initial source entry point.", emptyBundle);
  createDraft.changes[0] = {
    ...createDraft.changes[0],
    targetRef: "src/index.ts",
    targetOwnerRef: ".",
    operation: "create",
  };
  const result = materializePlanArtifactFromVisibleText({
    visibleText: envelope(createDraft),
    ingressMode: "typed_runtime",
    userGoal: createObjective,
    evidenceBundle: emptyBundle,
    language: "en",
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.candidate.changes[0].operation, "create");
  assert.equal(result.candidate.changes[0].targetOwnerRef, ".");
});
