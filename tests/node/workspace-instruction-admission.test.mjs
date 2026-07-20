import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";

const cache = new Map();

function loadTypeScript(sourcePath) {
  const normalized = path.resolve(sourcePath);
  if (cache.has(normalized)) return cache.get(normalized);
  const source = fs.readFileSync(normalized, "utf8");
  const transpiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    fileName: normalized,
  }).outputText;
  const module = { exports: {} };
  cache.set(normalized, module.exports);
  const localRequire = createRequire(normalized);
  const runtimeRequire = (specifier) => {
    if (specifier.startsWith(".")) {
      const base = path.resolve(path.dirname(normalized), specifier);
      for (const candidate of [base, `${base}.ts`, path.join(base, "index.ts")]) {
        if (fs.existsSync(candidate) && candidate.endsWith(".ts")) {
          return loadTypeScript(candidate);
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
  cache.set(normalized, module.exports);
  return module.exports;
}

const { buildWorkspaceInstructionPayloadIdentity } = loadTypeScript(
  path.join(process.cwd(), "src/store/workspaceInstructionAdmission.ts"),
);
const { normalizeWorkspaceInstructionLedger } = loadTypeScript(
  path.join(process.cwd(), "src/store/workspaceTurnQueue.ts"),
);

function identity(overrides = {}) {
  return buildWorkspaceInstructionPayloadIdentity({
    text: "inspect runtime",
    images: [],
    contextMentions: ["src/App.tsx"],
    attachedFiles: [],
    source: "composer",
    dispatchHints: { resolvedIntent: "plan", skipIntentResolution: true },
    remoteContext: null,
    ...overrides,
  });
}

test("payload identity is stable across JSON object key order", () => {
  assert.equal(
    identity({
      dispatchHints: {
        skipIntentResolution: true,
        nested: { z: 1, a: 2 },
        resolvedIntent: "plan",
      },
    }),
    identity({
      dispatchHints: {
        resolvedIntent: "plan",
        nested: { a: 2, z: 1 },
        skipIntentResolution: true,
      },
    }),
  );
});

test("same submission id cannot silently change intent or remote ownership payload", () => {
  assert.notEqual(identity(), identity({
    dispatchHints: { resolvedIntent: "respond", skipIntentResolution: true },
  }));
  assert.notEqual(
    identity({ remoteContext: { adapter: "feishu", messageId: "message-1" } }),
    identity({ remoteContext: { adapter: "feishu", messageId: "message-2" } }),
  );
});

test("the durable receipt ledger survives paging but rejects foreign owners and duplicate ids", () => {
  const receipt = {
    schemaVersion: 1,
    kind: "workspace_turn_receipt",
    receiptId: "receipt-1",
    clientSubmissionId: "submission-1",
    sessionKey: "/workspace:7",
    sessionEpoch: "epoch-7",
    turnId: "turn-1",
    userBlockId: 41,
    acceptedAt: 10,
  };
  const normalized = normalizeWorkspaceInstructionLedger([
    { clientSubmissionId: "submission-1", payloadIdentity: "payload-1", receipt },
    {
      clientSubmissionId: "submission-1",
      payloadIdentity: "payload-duplicate",
      receipt: { ...receipt, receiptId: "receipt-duplicate" },
    },
    {
      clientSubmissionId: "foreign",
      payloadIdentity: "payload-foreign",
      receipt: {
        ...receipt,
        clientSubmissionId: "foreign",
        receiptId: "receipt-foreign",
        sessionEpoch: "epoch-foreign",
      },
    },
  ], "/workspace:7", "epoch-7");

  assert.equal(normalized.length, 1);
  assert.equal(normalized[0].receipt.turnId, "turn-1");
  assert.equal(Object.isFrozen(normalized), true);
  assert.equal(Object.isFrozen(normalized[0]), true);
  assert.equal(Object.isFrozen(normalized[0].receipt), true);
});
