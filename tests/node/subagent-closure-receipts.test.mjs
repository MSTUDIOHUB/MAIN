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
  const localRequire = createRequire(normalizedPath);
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
    fileName: normalizedPath,
  }).outputText;
  const module = { exports: {} };
  moduleCache.set(normalizedPath, module.exports);
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

const receipts = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/lib/subagentClosureReceipts.ts"),
);
const preferredScopes = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/lib/preferredDelegationScopes.ts"),
);

const owner = Object.freeze({
  workspaceKey: "/workspace/project",
  sessionKey: "/workspace/project:7",
  sessionEpoch: "epoch-7",
  parentTurnId: "turn-7",
  parentRunId: "run-7",
});

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function exactContract(registrations = [
  {
    requiredScopeKey: "src",
    childScopeKey: "src",
    subagentId: "child-src",
    allowedPaths: ["src"],
    state: "consumed",
  },
  {
    requiredScopeKey: "src-tauri",
    childScopeKey: "src-tauri",
    subagentId: "child-rust",
    allowedPaths: ["src-tauri"],
    state: "consumed",
  },
]) {
  return {
    schemaVersion: preferredScopes.PREFERRED_DELEGATION_SCOPE_CONTRACT_VERSION,
    requiredScopes: [
      { scopeKey: "src", allowedPaths: ["src"] },
      { scopeKey: "src-tauri", allowedPaths: ["src-tauri"] },
    ],
    registrations,
    maxCreatedPerTurn: 2,
  };
}

function exactActivity({
  subagentId,
  target,
  callId,
  observationKey,
  fact,
  relation,
  activityOwner = owner,
}) {
  return {
    name: "read_file",
    target,
    status: "succeeded",
    detail: `Exact versioned read of ${target}`,
    facts: [fact],
    structuredFacts: [{
      authority: "runtime_observation",
      kind: "symbol_relation",
      relation,
      symbols: [fact],
    }],
    readFileObservation: {
      path: target,
      contentChars: 240,
      lineCount: 12,
      truncated: false,
    },
    delegatedObservation: {
      owner: {
        agentKind: "subagent",
        subagentId,
        parentTurnId: activityOwner.parentTurnId,
        runId: activityOwner.parentRunId,
      },
      sourceToolCallId: callId,
      sourceObservationKey: observationKey,
      sourceVersion: "120:2",
      sourceContentHash: `${subagentId}-content-hash`,
      sourceContentChars: 240,
      sourceRange: {
        startLine: 1,
        endLine: 12,
        totalLines: 12,
        truncated: false,
      },
      planningEvidenceState: "reusable",
      joinState: "consumed",
      closureState: "satisfied",
      parentContextState: "version_verified",
      requiresParentReread: false,
    },
  };
}

function issueExactLedger(overrides = {}) {
  const contract = overrides.contract || exactContract();
  const activities = overrides.activities || [
    exactActivity({
      subagentId: "child-src",
      target: "src/main.js",
      callId: "call-src-read",
      observationKey: "obs-src-read",
      fact: "scheduleAutoSave",
      relation: "listener_calls",
    }),
    exactActivity({
      subagentId: "child-rust",
      target: "src-tauri/src/main.rs",
      callId: "call-rust-read",
      observationKey: "obs-rust-read",
      fact: "save_file_content",
      relation: "command_handler",
    }),
  ];
  return receipts.issueSubagentClosureReceipts({
    ledger: overrides.ledger,
    owner: overrides.owner || owner,
    contract,
    activities,
    issuedAt: overrides.issuedAt ?? 1_000,
  });
}

test("issues and normalizes an exact canonical closure ledger", () => {
  const contract = exactContract();
  const issued = issueExactLedger();

  assert.equal(issued.ledger.revision, 2);
  assert.deepEqual(issued.missingConsumedScopeKeys, []);
  assert.equal(issued.receiptRefs.length, 2);
  assert.equal(new Set(issued.receiptRefs).size, 2);
  const normalized = receipts.normalizeSubagentClosureReceiptLedger(issued.ledger, {
    expectedOwner: owner,
  });
  assert.deepEqual(normalized, issued.ledger);
  for (const receiptRef of issued.receiptRefs) {
    const receipt = receipts.findSubagentClosureReceipt(normalized, receiptRef);
    assert.ok(receipt);
    assert.match(receipt.receiptId, /^subagent-closure:[a-f0-9]{64}$/);
    assert.match(receipt.digest, /^[a-f0-9]{64}$/);
    assert.equal(receipt.acceptedEvidence.length, 1);
  }
  const resolved = receipts.resolveSubagentClosureReceiptReferences({
    ledger: normalized,
    receiptRefs: issued.receiptRefs,
    expectedOwner: owner,
    contract,
  });
  assert.deepEqual(resolved.resolvedReceiptRefs, issued.receiptRefs);
  assert.deepEqual(resolved.rejectedReceiptRefs, []);
  assert.deepEqual(resolved.consumedScopeKeys, ["src", "src-tauri"]);
  assert.equal(resolved.acceptedEvidence.length, 2);
});

test("rejects a receipt when human-readable facts are tampered", () => {
  const issued = issueExactLedger();
  const tampered = clone(issued.ledger);
  tampered.receipts[0].acceptedEvidence[0].activity.facts[0] = "forged root cause";

  assert.equal(receipts.normalizeSubagentClosureReceiptLedger(tampered), null);
  assert.equal(
    receipts.findSubagentClosureReceipt(tampered, tampered.receipts[0].receiptId),
    null,
  );
});

test("rejects a receipt when typed structured facts are tampered", () => {
  const issued = issueExactLedger();
  const tampered = clone(issued.ledger);
  tampered.receipts[0].acceptedEvidence[0].activity.structuredFacts[0].relation =
    "forged_relation";

  assert.equal(receipts.normalizeSubagentClosureReceiptLedger(tampered), null);
  assert.equal(
    receipts.findSubagentClosureReceipt(tampered, tampered.receipts[0].receiptId),
    null,
  );
});

test("forged receipt digests and ids cannot be resolved as consumed authority", () => {
  const issued = issueExactLedger();
  const forgedDigest = clone(issued.ledger);
  forgedDigest.receipts[0].digest = "0".repeat(64);
  const forgedId = clone(issued.ledger);
  forgedId.receipts[0].receiptId = `subagent-closure:${"f".repeat(64)}`;

  assert.equal(receipts.normalizeSubagentClosureReceiptLedger(forgedDigest), null);
  assert.equal(receipts.normalizeSubagentClosureReceiptLedger(forgedId), null);
  assert.equal(
    receipts.findSubagentClosureReceipt(forgedDigest, issued.receiptRefs[0]),
    null,
  );
  assert.equal(
    receipts.findSubagentClosureReceipt(forgedId, forgedId.receipts[0].receiptId),
    null,
  );
  assert.deepEqual(receipts.resolveSubagentClosureReceiptReferences({
    ledger: forgedDigest,
    receiptRefs: issued.receiptRefs,
    expectedOwner: owner,
    contract: exactContract(),
  }), {
    receipts: [],
    acceptedEvidence: [],
    resolvedReceiptRefs: [],
    rejectedReceiptRefs: issued.receiptRefs,
    consumedScopeKeys: [],
  });
  assert.deepEqual(receipts.resolveSubagentClosureReceiptReferences({
    ledger: forgedId,
    receiptRefs: [forgedId.receipts[0].receiptId],
    expectedOwner: owner,
    contract: exactContract(),
  }).resolvedReceiptRefs, []);
});

test("ledger normalization enforces exact owner and durable size fences", () => {
  const issued = issueExactLedger();
  assert.equal(receipts.normalizeSubagentClosureReceiptLedger(issued.ledger, {
    expectedOwner: { ...owner, workspaceKey: "/workspace/replacement" },
  }), null);
  assert.equal(receipts.normalizeSubagentClosureReceiptLedger(issued.ledger, {
    expectedOwner: { ...owner, sessionKey: "/workspace/project:replacement" },
  }), null);
  assert.equal(receipts.normalizeSubagentClosureReceiptLedger(issued.ledger, {
    expectedOwner: { ...owner, sessionEpoch: "epoch-replacement" },
  }), null);

  const tooManyReceipts = {
    ...clone(issued.ledger),
    receipts: Array.from(
      { length: receipts.MAX_DURABLE_SUBAGENT_CLOSURE_RECEIPTS + 1 },
      () => clone(issued.ledger.receipts[0]),
    ),
  };
  assert.equal(receipts.normalizeSubagentClosureReceiptLedger(tooManyReceipts), null);

  const oversized = {
    ...clone(issued.ledger),
    ignoredPadding: "x".repeat(1_048_576),
  };
  assert.equal(receipts.normalizeSubagentClosureReceiptLedger(oversized), null);

  const cyclic = { ...issued.ledger };
  cyclic.self = cyclic;
  assert.equal(receipts.normalizeSubagentClosureReceiptLedger(cyclic), null);

  assert.throws(
    () => receipts.createSubagentClosureReceiptLedger({
      owner: {
        workspaceKey: "x".repeat(8_193),
        sessionKey: owner.sessionKey,
        sessionEpoch: owner.sessionEpoch,
      },
    }),
    /Invalid subagent closure receipt ledger owner/,
  );
});

test("an unreferenced canonical receipt cannot manufacture consumed authority", () => {
  const issued = issueExactLedger();
  const resolved = receipts.resolveSubagentClosureReceiptReferences({
    ledger: issued.ledger,
    receiptRefs: [],
    expectedOwner: owner,
    contract: exactContract(),
  });
  assert.deepEqual(resolved.resolvedReceiptRefs, []);
  assert.deepEqual(resolved.acceptedEvidence, []);
  assert.deepEqual(resolved.consumedScopeKeys, []);
});

test("resolution rejects self-consistent receipts for another parent Turn or Run", () => {
  const current = issueExactLedger();
  const otherOwner = {
    ...owner,
    parentTurnId: "turn-other",
    parentRunId: "run-other",
  };
  const otherActivities = [
    exactActivity({
      subagentId: "child-src",
      target: "src/main.js",
      callId: "call-other-src",
      observationKey: "obs-other-src",
      fact: "other src fact",
      relation: "defines",
      activityOwner: otherOwner,
    }),
    exactActivity({
      subagentId: "child-rust",
      target: "src-tauri/src/main.rs",
      callId: "call-other-rust",
      observationKey: "obs-other-rust",
      fact: "other rust fact",
      relation: "defines",
      activityOwner: otherOwner,
    }),
  ];
  const other = issueExactLedger({
    ledger: current.ledger,
    owner: otherOwner,
    activities: otherActivities,
    issuedAt: 1_001,
  });
  assert.ok(receipts.normalizeSubagentClosureReceiptLedger(other.ledger),
    "the shared Session ledger may validly contain receipts for both Turns");

  const resolved = receipts.resolveSubagentClosureReceiptReferences({
    ledger: other.ledger,
    receiptRefs: other.receiptRefs,
    expectedOwner: owner,
    contract: exactContract(),
  });
  assert.deepEqual(resolved.resolvedReceiptRefs, []);
  assert.deepEqual(resolved.rejectedReceiptRefs, other.receiptRefs);
  assert.deepEqual(resolved.consumedScopeKeys, []);

  const wrongRunOnly = receipts.resolveSubagentClosureReceiptReferences({
    ledger: current.ledger,
    receiptRefs: current.receiptRefs,
    expectedOwner: { ...owner, parentRunId: "run-replacement" },
    contract: exactContract(),
  });
  assert.deepEqual(wrongRunOnly.resolvedReceiptRefs, []);
  assert.deepEqual(wrongRunOnly.rejectedReceiptRefs, current.receiptRefs);
});

test("resolution rejects self-consistent receipts for another child or frozen scope", () => {
  const alternateContract = {
    schemaVersion: preferredScopes.PREFERRED_DELEGATION_SCOPE_CONTRACT_VERSION,
    requiredScopes: [
      { scopeKey: "frontend", allowedPaths: ["src"] },
      { scopeKey: "backend", allowedPaths: ["src-tauri"] },
    ],
    registrations: [
      {
        requiredScopeKey: "frontend",
        childScopeKey: "frontend",
        subagentId: "child-alt-src",
        allowedPaths: ["src"],
        state: "consumed",
      },
      {
        requiredScopeKey: "backend",
        childScopeKey: "backend",
        subagentId: "child-alt-rust",
        allowedPaths: ["src-tauri"],
        state: "consumed",
      },
    ],
    maxCreatedPerTurn: 2,
  };
  const alternateActivities = [
    exactActivity({
      subagentId: "child-alt-src",
      target: "src/main.js",
      callId: "call-alt-src",
      observationKey: "obs-alt-src",
      fact: "alternate src fact",
      relation: "defines",
    }),
    exactActivity({
      subagentId: "child-alt-rust",
      target: "src-tauri/src/main.rs",
      callId: "call-alt-rust",
      observationKey: "obs-alt-rust",
      fact: "alternate rust fact",
      relation: "defines",
    }),
  ];
  const alternate = issueExactLedger({
    contract: alternateContract,
    activities: alternateActivities,
  });
  assert.ok(receipts.normalizeSubagentClosureReceiptLedger(alternate.ledger));

  const resolved = receipts.resolveSubagentClosureReceiptReferences({
    ledger: alternate.ledger,
    receiptRefs: alternate.receiptRefs,
    expectedOwner: owner,
    contract: exactContract(),
  });
  assert.deepEqual(resolved.resolvedReceiptRefs, []);
  assert.deepEqual(resolved.rejectedReceiptRefs, alternate.receiptRefs);
  assert.deepEqual(resolved.acceptedEvidence, []);

  const driftedAllowedPaths = exactContract().registrations.map((registration) =>
    registration.requiredScopeKey === "src"
      ? { ...registration, allowedPaths: ["src/components"] }
      : registration
  );
  const pathDriftResolution = receipts.resolveSubagentClosureReceiptReferences({
    ledger: issueExactLedger().ledger,
    receiptRefs: issueExactLedger().receiptRefs,
    expectedOwner: owner,
    contract: exactContract(driftedAllowedPaths),
  });
  assert.equal(pathDriftResolution.consumedScopeKeys.includes("src"), false);
});
