import test from "node:test";
import assert from "node:assert/strict";
import fsSync from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";

const workspaceRoot = process.cwd();
const cache = new Map();

function loadTs(sourcePath) {
  const normalizedPath = path.resolve(sourcePath);
  if (cache.has(normalizedPath)) return cache.get(normalizedPath);
  const source = fsSync.readFileSync(normalizedPath, "utf8");
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
      for (const candidate of [basePath, `${basePath}.ts`, `${basePath}.tsx`, path.join(basePath, "index.ts")]) {
        if (fsSync.existsSync(candidate) && /\.tsx?$/.test(candidate)) return loadTs(candidate);
      }
    }
    return localRequire(specifier);
  };
  new Function("exports", "module", "require", transpiled)(module.exports, module, runtimeRequire);
  cache.set(normalizedPath, module.exports);
  return module.exports;
}

const obligations = loadTs(path.join(workspaceRoot, "src/lib/planEvidenceObligations.ts"));
const tracking = loadTs(path.join(workspaceRoot, "src/lib/orchestrator/loop/toolActivityTracking.ts"));
const convergence = loadTs(path.join(workspaceRoot, "src/lib/planReadOnlyConvergence.ts"));
const orchestration = loadTs(path.join(workspaceRoot, "src/lib/orchestrator/planOrchestration.ts"));

test("runtime discovery parsers preserve exact topology and reject model prose", () => {
  assert.deepEqual(obligations.extractProjectSkeletonTargetRefs([
    "src/",
    "  main.js",
    "  components/",
    "    editor.js",
    "src-tauri/",
    "  src/",
    "    main.rs",
  ].join("\n")), ["src/main.js", "src/components/editor.js", "src-tauri/src/main.rs"]);

  assert.deepEqual(obligations.extractSymbolReferenceTargetRefs(JSON.stringify({
    occurrences: [
      { path: "src/main.js", line: 8 },
      { path: "src-tauri/src/main.rs", line: 21 },
    ],
  })), ["src/main.js", "src-tauri/src/main.rs"]);
  assert.deepEqual(
    obligations.extractSymbolReferenceTargetRefs("Please confirm src/guessed-owner.js next"),
    [],
  );
});

test("workspace target identity is language- and extension-agnostic", () => {
  const expected = [
    "lib/worker.rb",
    "public/index.php",
    "scripts/check.sh",
    "db/schema.sql",
    "Makefile",
    "CMakeLists.txt",
    "bin/project-tool",
  ];
  assert.deepEqual(obligations.extractProjectSkeletonTargetRefs([
    "lib/",
    "  worker.rb",
    "public/",
    "  index.php",
    "scripts/",
    "  check.sh",
    "db/",
    "  schema.sql",
    "Makefile",
    "CMakeLists.txt",
    "bin/",
    "  project-tool",
  ].join("\n")), expected);

  assert.deepEqual(obligations.extractSymbolReferenceTargetRefs({
    occurrences: expected.map((target, index) => ({ path: target, line: index + 1 })),
  }), expected);
  assert.deepEqual(obligations.extractSymbolReferenceTargetRefs({
    occurrences: [
      { path: "/tmp/example/lib/worker.rb", line: 1 },
      { path: "tools/build helper", line: 2 },
    ],
  }), ["/tmp/example/lib/worker.rb", "tools/build helper"]);

  const derived = obligations.derivePlanEvidenceObligations({
    objective: "Inspect lib/worker.rb, public/index.php, scripts/check.sh, db/schema.sql, Makefile, and CMakeLists.txt.",
    activities: [{
      name: "get_project_skeleton",
      target: ".",
      status: "succeeded",
      discoveryObservation: { kind: "project_structure", targetRefs: expected },
    }],
  }).map(obligations.formatPlanEvidenceObligation);
  assert.deepEqual(derived, [
    "read_file:lib/worker.rb",
    "read_file:public/index.php",
    "read_file:scripts/check.sh",
    "read_file:db/schema.sql",
    "read_file:Makefile",
    "read_file:CMakeLists.txt",
  ]);
});

test("an observed workspace identity wins over objective spelling", () => {
  assert.deepEqual(obligations.derivePlanEvidenceObligations({
    objective: "Inspect scripts/check.sh before planning.",
    activities: [{
      name: "read_file",
      target: "./scripts/check.sh",
      status: "succeeded",
    }],
  }), []);
});

test("call-chain discoveries become exact reads and close only after those owners are read", () => {
  const runtime = (fact) => ({ authority: "runtime_observation", ...fact });
  const initial = [
    {
      name: "get_project_skeleton",
      target: "get_project_skeleton",
      status: "succeeded",
      discoveryObservation: {
        kind: "project_structure",
        targetRefs: ["src/main.js", "src/components/editor.js", "src/components/toolbar.js", "src-tauri/src/main.rs"],
      },
    },
    {
      name: "read_file",
      target: "src/components/editor.js",
      status: "succeeded",
      structuredFacts: [runtime({ kind: "symbol_relation", relation: "listener_calls", symbols: ["scheduleAutoSave"] })],
    },
    {
      name: "read_file",
      target: "src/components/toolbar.js",
      status: "succeeded",
      structuredFacts: [runtime({ kind: "command_contract", relation: "invoke", command: "save_file_content" })],
    },
  ];
  assert.deepEqual(
    obligations.derivePlanEvidenceObligations({ objective: "Repair scheduleAutoSave in the application workflow", activities: initial })
      .map(obligations.formatPlanEvidenceObligation),
    ["find_symbol_references:scheduleAutoSave", "find_symbol_references:save_file_content"],
  );

  const discovered = [
    ...initial,
    {
      name: "find_symbol_references",
      target: "scheduleAutoSave",
      status: "succeeded",
      discoveryObservation: { kind: "symbol_references", queryRef: "scheduleAutoSave", targetRefs: ["src/components/editor.js", "src/main.js"] },
    },
    {
      name: "find_symbol_references",
      target: "save_file_content",
      status: "succeeded",
      discoveryObservation: { kind: "symbol_references", queryRef: "save_file_content", targetRefs: ["src/components/toolbar.js", "src-tauri/src/main.rs"] },
    },
  ];
  assert.deepEqual(
    obligations.derivePlanEvidenceObligations({ objective: "Repair scheduleAutoSave in the application workflow", activities: discovered })
      .map(obligations.formatPlanEvidenceObligation),
    ["read_file:src/main.js", "read_file:src-tauri/src/main.rs"],
  );
  assert.deepEqual(obligations.derivePlanEvidenceObligations({
    objective: "Repair scheduleAutoSave in the application workflow",
    activities: [
      ...discovered,
      { name: "read_file", target: "src/main.js", status: "succeeded" },
      { name: "read_file", target: "src-tauri/src/main.rs", status: "succeeded" },
    ],
  }), []);
});

test("only joined and fully satisfied exact child reads close parent obligations", () => {
  const base = {
    name: "read_file",
    target: "src/main.js",
    status: "succeeded",
    delegatedObservation: {
      planningEvidenceState: "reusable",
      joinState: "consumed",
      closureState: "satisfied",
    },
  };
  assert.deepEqual(obligations.derivePlanEvidenceObligations({
    objective: "Repair src/main.js",
    activities: [base],
  }), []);
  for (const delegatedObservation of [
    { ...base.delegatedObservation, requiresParentReread: true },
    { ...base.delegatedObservation, closureState: "partial" },
    { ...base.delegatedObservation, joinState: undefined },
    { planningEvidenceState: "reusable" },
  ]) {
    assert.deepEqual(
      obligations.derivePlanEvidenceObligations({
        objective: "Repair src/main.js",
        activities: [{ ...base, delegatedObservation }],
      }).map(obligations.formatPlanEvidenceObligation),
      ["read_file:src/main.js"],
    );
  }
});

test("runtime canonicalizes the decisive argument without trusting model narrowing", () => {
  const obligation = {
    kind: "find_symbol_references",
    source: "contract_counterpart",
    symbol: "save_file_content",
  };
  assert.deepEqual(obligations.canonicalizePlanEvidenceObligationArgs(obligation, {
    symbol: "wrong_symbol",
    path: "src/main.js",
    max_results: 12,
  }), {
    symbol: "save_file_content",
    max_results: 12,
  });
  assert.match(
    obligations.buildPlanEvidenceObligationContractCard(obligation),
    /availableTools=find_symbol_references[\s\S]*"symbol":"save_file_content"/,
  );
});

test("target-related root evidence still creates the exact contract-counterpart obligation", () => {
  const activities = [{
    name: "read_file",
    target: "src/components/toolbar.js",
    status: "succeeded",
    structuredFacts: [{
      authority: "runtime_observation",
      kind: "command_contract",
      relation: "invoke",
      command: "save_file_content",
    }],
  }];
  assert.deepEqual(
    obligations.derivePlanEvidenceObligations({
      objective: "Repair save behavior in src/components/toolbar.js",
      activities,
    }).map(obligations.formatPlanEvidenceObligation),
    ["find_symbol_references:save_file_content"],
  );
});

test("broad parent and subagent reads do not promote ordinary calls into hard obligations", () => {
  const runtimeCalls = (symbols) => ({
    authority: "runtime_observation",
    kind: "symbol_relation",
    relation: "listener_calls",
    symbols,
  });
  const activities = [
    {
      name: "read_file",
      target: "src/main.js",
      status: "succeeded",
      structuredFacts: [runtimeCalls(["parseInt", "unlisten"])],
    },
    {
      name: "read_file",
      target: "src/components/editor.js",
      status: "succeeded",
      structuredFacts: [runtimeCalls(["requestAnimationFrame", "scrollTo"])],
      delegatedObservation: {
        planningEvidenceState: "reusable",
        joinState: "consumed",
        closureState: "satisfied",
      },
    },
  ];
  assert.deepEqual(obligations.derivePlanEvidenceObligations({
    objective: "Repair the editor workflow",
    activities,
  }), []);
});

test("an exact closure read cannot turn unrelated calls into recursive obligations", () => {
  const closingActivities = [];
  const closingObligation = {
    kind: "read_target",
    source: "symbol_reference",
    targetRef: "src/main.js",
  };
  tracking.rememberToolActivity(closingActivities, {
    toolCallId: "close-owner-read",
    name: "read_file",
    target: "src/main.js",
    content: "listener_calls(parseInt,unlisten)",
    runtimeEvidenceContent: "listener_calls(parseInt,unlisten)",
    isError: false,
    lifecycleState: "completed",
  }, {
    evidenceLedger: true,
    args: { path: "src/main.js" },
    closingEvidenceObligation: closingObligation,
  });
  assert.equal(closingActivities[0].obligationClosure.role, "obligation_closure");
  assert.deepEqual(closingActivities[0].obligationClosure.obligation, closingObligation);

  const activities = [
    {
      name: "find_symbol_references",
      target: "syncLineNumbersScroll",
      status: "succeeded",
      discoveryObservation: {
        kind: "symbol_references",
        queryRef: "syncLineNumbersScroll",
        targetRefs: ["src/main.js"],
      },
    },
    {
      name: "read_file",
      target: "src/components/toolbar.js",
      status: "succeeded",
      structuredFacts: [{
        authority: "runtime_observation",
        kind: "command_contract",
        relation: "invoke",
        command: "save_file_content",
      }],
    },
    ...closingActivities,
  ];
  assert.deepEqual(
    obligations.derivePlanEvidenceObligations({
      objective: "Repair editor save and line-number behavior",
      activities,
    }).map(obligations.formatPlanEvidenceObligation),
    ["find_symbol_references:save_file_content"],
  );
});

test("bounded symbol-owner closure reaches ready_for_plan without call-chain recursion", () => {
  const exactLookup = {
    kind: "find_symbol_references",
    source: "call_chain",
    symbol: "syncLineNumbersScroll",
  };
  const rootEvidence = {
    name: "read_file",
    target: "src/components/editor.js",
    status: "succeeded",
    detail: "syncLineNumbersScroll currently maps scrollTop but never assigns lineNumberOffset consumed by the line-number gutter",
    structuredFacts: [{
      authority: "runtime_observation",
      kind: "symbol_relation",
      relation: "listener_calls",
      symbols: ["syncLineNumbersScroll"],
    }],
  };
  const lookupActivities = [];
  tracking.rememberToolActivity(lookupActivities, {
    toolCallId: "close-symbol-lookup",
    name: "find_symbol_references",
    target: "syncLineNumbersScroll",
    content: JSON.stringify({ occurrences: [{ path: "src/main.js", line: 42 }] }),
    isError: false,
    lifecycleState: "completed",
  }, {
    evidenceLedger: true,
    args: { symbol: "syncLineNumbersScroll" },
    closingEvidenceObligation: exactLookup,
  });
  const [ownerObligation] = obligations.derivePlanEvidenceObligations({
    objective: "Repair syncLineNumbersScroll line-number scrolling",
    activities: [rootEvidence, ...lookupActivities],
  });
  assert.equal(
    obligations.formatPlanEvidenceObligation(ownerObligation),
    "read_file:src/main.js@L42",
  );

  const ownerReadActivities = [];
  tracking.rememberToolActivity(ownerReadActivities, {
    toolCallId: "close-symbol-owner",
    name: "read_file",
    target: "src/main.js",
    content: "listener_calls(parseInt,unlisten)",
    runtimeEvidenceContent: "listener_calls(parseInt,unlisten)",
    isError: false,
    lifecycleState: "completed",
    readFileObservation: {
      key: "src/main.js::30-78::version=v1",
      path: "src/main.js",
      requestSignature: "src/main.js::30-78",
      versionToken: "v1",
      source: "fresh",
      window: { startLine: 30, endLine: 78, totalLines: 100, truncated: true },
    },
  }, {
    evidenceLedger: true,
    args: { path: "src/main.js", start_line: 30, end_line: 78 },
    closingEvidenceObligation: ownerObligation,
  });
  const closedActivities = [rootEvidence, ...lookupActivities, ...ownerReadActivities];
  assert.deepEqual(obligations.derivePlanEvidenceObligations({
    objective: "Repair syncLineNumbersScroll line-number scrolling",
    activities: closedActivities,
  }), []);
  const readiness = convergence.assessPlanEvidenceReadiness({
    userGoal: "Repair syncLineNumbersScroll line-number scrolling",
    recentToolActivity: closedActivities,
  });
  assert.equal(readiness.status, "ready_for_plan", readiness.reason);
});

test("contract counterpart closure preserves the real owner argument mismatch", () => {
  const frontendActivities = [];
  tracking.rememberToolActivity(frontendActivities, {
    toolCallId: "read-frontend-command-owner",
    name: "read_file",
    target: "src/components/toolbar.js",
    content: [
      'import { invoke } from "@tauri-apps/api/core";',
      "export async function saveDocument() {",
      '  await invoke("save_file_content", { file_path: "document" });',
      "}",
    ].join("\n"),
    isError: false,
    lifecycleState: "completed",
    readFileObservation: {
      key: "src/components/toolbar.js::1-4::version=frontend-v1",
      path: "src/components/toolbar.js",
      requestSignature: "src/components/toolbar.js::1-4",
      versionToken: "frontend-v1",
      source: "fresh",
      window: { startLine: 1, endLine: 4, totalLines: 4, truncated: false },
    },
  }, {
    evidenceLedger: true,
    args: { path: "src/components/toolbar.js", start_line: 1, end_line: 4 },
  });
  const frontend = frontendActivities[0];
  const lookup = {
    name: "find_symbol_references",
    target: "save_file_content",
    status: "succeeded",
    discoveryObservation: {
      kind: "symbol_references",
      queryRef: "save_file_content",
      targetRefs: ["src-tauri/src/main.rs"],
    },
    obligationClosure: {
      role: "obligation_closure",
      obligation: {
        kind: "find_symbol_references",
        source: "contract_counterpart",
        symbol: "save_file_content",
      },
    },
  };
  assert.deepEqual(
    obligations.derivePlanEvidenceObligations({
      objective: "Repair save_file_content",
      activities: [frontend, lookup],
    }).map(obligations.formatPlanEvidenceObligation),
    ["read_file:src-tauri/src/main.rs"],
  );

  const backendActivities = [];
  tracking.rememberToolActivity(backendActivities, {
    toolCallId: "read-backend-command-owner",
    name: "read_file",
    target: "src-tauri/src/main.rs",
    content: [
      "#[tauri::command]",
      "fn save_file_content(filePath: String) {",
      "  drop(filePath);",
      "}",
    ].join("\n"),
    isError: false,
    lifecycleState: "completed",
    readFileObservation: {
      key: "src-tauri/src/main.rs::1-4::version=backend-v1",
      path: "src-tauri/src/main.rs",
      requestSignature: "src-tauri/src/main.rs::1-4",
      versionToken: "backend-v1",
      source: "fresh",
      window: { startLine: 1, endLine: 4, totalLines: 4, truncated: false },
    },
  }, {
    evidenceLedger: true,
    args: { path: "src-tauri/src/main.rs", start_line: 1, end_line: 4 },
    closingEvidenceObligation: {
      kind: "read_target",
      source: "symbol_reference",
      targetRef: "src-tauri/src/main.rs",
    },
  });
  const backend = backendActivities[0];
  const activities = [frontend, lookup, backend];
  assert.deepEqual(obligations.derivePlanEvidenceObligations({
    objective: "Repair save_file_content",
    activities,
  }), []);
  const readiness = convergence.assessPlanEvidenceReadiness({
    userGoal: "Repair save_file_content",
    recentToolActivity: activities,
  });
  assert.equal(readiness.status, "ready_for_plan", readiness.reason);
});

test("symbol occurrence discovery selects the handler definition before its registration", () => {
  const payload = JSON.stringify({
    occurrences: [
      {
        path: "src-tauri/src/main.rs",
        role: "call",
        syntaxKind: "identifier",
        line: 85,
      },
      {
        path: "src-tauri/src/main.rs",
        role: "definition",
        syntaxKind: "identifier",
        line: 12,
      },
    ],
  });
  const discovery = obligations.extractRuntimePlanEvidenceDiscovery({
    tool: "find_symbol_references",
    content: payload,
    args: { symbol: "save_file_content" },
  });
  assert.deepEqual(discovery.occurrences.map((item) => ({
    targetRef: item.targetRef,
    role: item.role,
    anchorLine: item.anchorLine,
  })), [
    { targetRef: "src-tauri/src/main.rs", role: "definition", anchorLine: 12 },
    { targetRef: "src-tauri/src/main.rs", role: "call", anchorLine: 85 },
  ]);

  const lookup = {
    name: "find_symbol_references",
    target: "save_file_content",
    status: "succeeded",
    discoveryObservation: discovery,
    obligationClosure: {
      role: "obligation_closure",
      obligation: {
        kind: "find_symbol_references",
        source: "contract_counterpart",
        symbol: "save_file_content",
      },
    },
  };
  const [owner] = obligations.derivePlanEvidenceObligations({
    objective: "Repair save_file_content",
    activities: [lookup],
  });
  assert.equal(owner.targetRef, "src-tauri/src/main.rs");
  assert.equal(owner.symbol, "save_file_content");
  assert.equal(owner.occurrence.role, "definition");
  assert.equal(owner.occurrence.anchorLine, 12);
  assert.equal(obligations.formatPlanEvidenceObligation(owner), "read_file:src-tauri/src/main.rs@L12");
});

test("runtime forces the finite occurrence range over model-authored read bounds", () => {
  const owner = {
    kind: "read_target",
    source: "symbol_reference",
    targetRef: "src-tauri/src/main.rs",
    symbol: "save_file_content",
    occurrence: {
      anchorLine: 12,
      startLine: 12,
      endLine: 12,
      role: "definition",
    },
  };
  assert.deepEqual(obligations.canonicalizePlanEvidenceObligationArgs(owner, {
    path: "src-tauri/src/main.rs",
    start_line: 80,
    end_line: 200,
    max_lines: 121,
    max_chars: 10,
  }), {
    path: "src-tauri/src/main.rs",
    start_line: 1,
    end_line: 48,
    max_lines: 48,
    max_chars: 30000,
  });
});

test("an occurrence obligation rejects wrong same-file and partial windows", () => {
  const obligation = {
    kind: "read_target",
    source: "symbol_reference",
    targetRef: "src-tauri/src/main.rs",
    symbol: "save_file_content",
    occurrence: {
      anchorLine: 12,
      startLine: 11,
      endLine: 14,
      role: "definition",
    },
  };
  const activity = (window, overrides = {}) => ({
    name: "read_file",
    target: "src-tauri/src/main.rs",
    status: "succeeded",
    readFileObservation: {
      key: "read_file::main.rs::window::version=100:200",
      path: "src-tauri/src/main.rs",
      requestSignature: "read_file::main.rs::window",
      versionToken: "100:200",
      source: "fresh",
      window: { ...window, totalLines: 240, truncated: true },
      ...overrides,
    },
    obligationClosure: { role: "obligation_closure", obligation },
  });

  assert.equal(obligations.planEvidenceActivityClosesObligation(
    activity({ startLine: 80, endLine: 200 }),
  ), false);
  assert.equal(obligations.planEvidenceActivityClosesObligation(
    activity({ startLine: 12, endLine: 13 }),
  ), false, "partial occurrence coverage must not close the range");
  assert.equal(obligations.planEvidenceActivityClosesObligation(
    activity({ startLine: 1, endLine: 48 }, { versionToken: "" }),
  ), false, "coverage without a version identity is not authoritative");
});

test("exact occurrence range plus version identity closes its read obligation", () => {
  const obligation = {
    kind: "read_target",
    source: "symbol_reference",
    targetRef: "src-tauri/src/main.rs",
    occurrence: {
      anchorLine: 12,
      startLine: 11,
      endLine: 14,
      role: "definition",
    },
  };
  assert.equal(obligations.planEvidenceActivityClosesObligation(
    {
      name: "read_file",
      target: "src-tauri/src/main.rs",
      status: "succeeded",
      readFileObservation: {
        key: "read_file::main.rs::1-48::version=100:200",
        path: "src-tauri/src/main.rs",
        requestSignature: "read_file::main.rs::1-48",
        versionToken: "100:200",
        source: "fresh",
        window: { startLine: 1, endLine: 48, totalLines: 240, truncated: true },
      },
      obligationClosure: { role: "obligation_closure", obligation },
    },
  ), true);
});

test("large-file occurrence windows stay local, finite, and deterministic", () => {
  const occurrences = obligations.extractSymbolReferenceOccurrences(JSON.stringify({
    occurrences: [
      { path: "src/z.ts", role: "reference", line: 3 },
      { path: "src/00-large.ts", role: "definition", line: 120000 },
      { path: "src/a.ts", role: "definition", line: 90000 },
      { path: "src/b.ts", role: "definition", line: 80000 },
      { path: "src/c.ts", role: "definition", line: 70000 },
      { path: "src/d.ts", role: "definition", line: 60000 },
      { path: "src/e.ts", role: "definition", line: 50000 },
    ],
  }));
  const discovery = {
    kind: "symbol_references",
    queryRef: "owner",
    targetRefs: [...new Set(occurrences.map((item) => item.targetRef))],
    occurrences,
  };
  const derived = obligations.derivePlanEvidenceObligations({
    objective: "Repair owner",
    activities: [{
      name: "find_symbol_references",
      target: "owner",
      status: "succeeded",
      discoveryObservation: discovery,
    }],
  });
  assert.equal(derived.length, 4, "owner fan-out is bounded");
  assert.ok(derived.every((item) => item.occurrence.role === "definition"));
  const largeOwner = derived.find((item) => item.targetRef === "src/00-large.ts");
  assert.ok(largeOwner);
  const forced = obligations.canonicalizePlanEvidenceObligationArgs(largeOwner, {
    start_line: 1,
    end_line: 2000,
  });
  assert.deepEqual(forced, {
    path: "src/00-large.ts",
    start_line: 119988,
    end_line: 120036,
    max_lines: 49,
    max_chars: 30000,
  });
});

test("an exact owner closure promotes command arguments but cannot restart listener call discovery", () => {
  const occurrence = {
    anchorLine: 12,
    startLine: 12,
    endLine: 12,
    role: "definition",
  };
  const activities = [
    {
      name: "read_file",
      target: "src/caller.ts",
      status: "succeeded",
      structuredFacts: [{
        authority: "runtime_observation",
        kind: "command_contract",
        relation: "invoke",
        command: "save_file_content",
        arguments: ["file_path"],
      }],
    },
    {
      name: "read_file",
      target: "src-tauri/src/main.rs",
      status: "succeeded",
      readFileObservation: {
        key: "owner-read::version=1:2",
        path: "src-tauri/src/main.rs",
        requestSignature: "owner-read",
        versionToken: "1:2",
        source: "fresh",
        window: { startLine: 1, endLine: 48, totalLines: 100, truncated: true },
      },
      structuredFacts: [
        {
          authority: "runtime_observation",
          kind: "command_contract",
          relation: "handler",
          command: "save_file_content",
          arguments: ["filePath"],
        },
        {
          authority: "runtime_observation",
          kind: "symbol_relation",
          relation: "listener_calls",
          symbols: ["parseInt"],
        },
      ],
      obligationClosure: {
        role: "obligation_closure",
        obligation: {
          kind: "read_target",
          source: "symbol_reference",
          targetRef: "src-tauri/src/main.rs",
          symbol: "save_file_content",
          occurrence,
        },
      },
    },
  ];
  assert.deepEqual(obligations.derivePlanEvidenceObligations({
    objective: "Repair save_file_content without following parseInt",
    activities,
  }), []);
});

test("child prose cannot create parent rereads; closureAudit exact paths can", () => {
  const result = {
    name: "wait_subagents",
    target: "child-1",
    isError: false,
    content: JSON.stringify({
      results: [{
        subagentId: "child-1",
        scopeKey: "src/runtime-owner.js",
        status: "blocked",
        summary: "Please inspect src/invented-from-summary.js",
        evidence: [],
        closureAudit: {
          schemaVersion: 1,
          owner: {
            agentKind: "subagent",
            threadId: "thread-1",
            parentTurnId: "turn-1",
            subagentId: "child-1",
            runId: "run-child-1",
            parentRunId: "run-parent-1",
          },
          scopeKey: "src/runtime-owner.js",
          status: "blocked",
          state: "blocked",
          remainingWork: "Read src/runtime-owner.js",
          observationCount: 0,
          substantiveEvidenceCount: 0,
          requiredPaths: ["src/runtime-owner.js"],
          coveredPaths: [],
          failedPaths: ["src/runtime-owner.js"],
          uncoveredPaths: ["src/runtime-owner.js"],
          acceptedEvidenceToolCallIds: [],
          reasonCode: "incomplete_required_path_coverage",
          reason: "The exact required path remains unread.",
        },
      }],
    }),
  };
  const activities = tracking.extractSubagentParentRereadObligations(result, { evidenceLedger: true });
  assert.equal(activities.length, 1);
  assert.equal(activities[0].target, "src/runtime-owner.js");
  assert.equal(activities[0].evidenceObligation.source, "subagent_unresolved");
  assert.doesNotMatch(JSON.stringify(activities), /invented-from-summary/);
  assert.deepEqual(
    obligations.derivePlanEvidenceObligations({ objective: "Repair runtime", activities })
      .map(obligations.formatPlanEvidenceObligation),
    ["read_file:src/runtime-owner.js"],
  );
});

test("open structured obligations keep Plan read-only and are rendered as exact recovery actions", () => {
  const activities = [
    {
      name: "read_file",
      target: "src/caller.js",
      status: "succeeded",
      detail: "caller invokes a runtime command",
      structuredFacts: [{ authority: "runtime_observation", kind: "command_contract", relation: "invoke", command: "persist_document" }],
    },
  ];
  const readiness = convergence.assessPlanEvidenceReadiness({
    userGoal: "Repair document persistence",
    recentToolActivity: activities,
  });
  assert.equal(readiness.status, "needs_targeted_read");
  assert.equal(readiness.reason, "structured_evidence_obligations_open");

  const exact = obligations.derivePlanEvidenceObligations({ objective: "Repair document persistence", activities });
  const prompt = orchestration.buildPlanClosureEvidenceRecoveryPrompt(
    "en",
    readiness.reason,
    "Repair document persistence",
    { evidenceObligations: exact },
  );
  assert.match(prompt, /find_symbol_references:persist_document/);
  assert.match(prompt, /MAIN will reassess the ledger/);
  assert.doesNotMatch(prompt, /After that single tool result, stop exploring and submit/);
});
