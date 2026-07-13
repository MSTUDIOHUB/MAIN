import test from "node:test";
import assert from "node:assert/strict";
import fsSync from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

import ts from "typescript";

const workspaceRoot = process.cwd();
const sourcePath = path.join(workspaceRoot, "src/lib/goalChoiceContinuation.ts");
const source = fsSync.readFileSync(sourcePath, "utf8");
const transpiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2020,
  },
  fileName: sourcePath,
}).outputText;
const module = { exports: {} };
new Function("exports", "module", "require", transpiled)(
  module.exports,
  module,
  createRequire(sourcePath),
);

const { shouldContinueGoalFromUserChoice } = module.exports;

function buildInput(overrides = {}) {
  const activeActionRequest = {
    schemaVersion: 1,
    requestId: "choice-1",
    kind: "user_choice",
    sessionKey: "/workspace:7",
    turnId: "turn-goal",
    runId: "run-goal:slice:1",
    title: "Choose startup behavior",
    status: "pending",
    createdAt: 1,
    optionValues: ["keep empty editor", "show welcome page"],
    allowCustomReply: true,
  };
  return {
    sourceIntent: "goal",
    sourceTurnId: "turn-goal",
    activeGoal: { id: "goal-1", ownerTurnId: "turn-goal" },
    goalStatus: "awaiting_input",
    activeActionRequest,
    choiceRequest: {
      sessionKey: activeActionRequest.sessionKey,
      turnId: activeActionRequest.turnId,
      runId: activeActionRequest.runId,
      requestId: activeActionRequest.requestId,
      parentRunId: null,
      optionValues: [...activeActionRequest.optionValues],
      allowCustomReply: true,
      status: "pending",
    },
    ...overrides,
  };
}

test("a matching Goal user choice continues the same logical Goal", () => {
  assert.equal(shouldContinueGoalFromUserChoice(buildInput()), true);
  assert.equal(
    shouldContinueGoalFromUserChoice(buildInput({ goalStatus: "paused" })),
    true,
  );
});

test("Goal continuation rejects stale request and owner identities", () => {
  const staleChoice = buildInput();
  staleChoice.choiceRequest = { ...staleChoice.choiceRequest, requestId: "stale" };
  assert.equal(shouldContinueGoalFromUserChoice(staleChoice), false);

  assert.equal(shouldContinueGoalFromUserChoice(buildInput({
    activeGoal: { id: "goal-1", ownerTurnId: "another-turn" },
  })), false);
  assert.equal(shouldContinueGoalFromUserChoice(buildInput({
    sourceIntent: "execute",
  })), false);
});
