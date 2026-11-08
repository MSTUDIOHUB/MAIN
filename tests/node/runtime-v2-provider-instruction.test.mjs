import test from "node:test";
import assert from "node:assert/strict";
import { createTsModuleLoader } from "./tsModuleLoader.mjs";

const { providerModeInstruction } = createTsModuleLoader()("src/store/runtimeV2/executionProviderInstruction.ts");
const surface = { hasReadFile: true, hasMutation: true, hasSpawnSubagent: false, hasWaitSubagents: false };
const command = (mode, reason) => ({ kind: "request_model", payload: { mode,
  recoveryPressure: { reason, occurrence: 3, stage: "alternative" } } });

test("pending validation does not describe a rejected duplicate as a failed patch", () => {
  const instruction = providerModeInstruction(command("validate", "repeated_action_rejected"), "", surface);
  assert.match(instruction, /Verify the latest committed mutation/);
  assert.match(instruction, /finite validation tool/);
  assert.match(instruction, /read_file or prose alone does not satisfy validation/);
  assert.doesNotMatch(instruction, /Previous action made no progress|latest tool error or file snippet|smaller edit/);
});

test("an actual failed Execute action retains its recovery instruction", () => {
  const instruction = providerModeInstruction(command("execute", "tool_execution_failed"), "", surface);
  assert.match(instruction, /Previous action made no progress/);
  assert.match(instruction, /latest tool error or file snippet/);
  assert.match(instruction, /smaller edit/);
});

test("an actual failed validation retains diagnostics and correction guidance", () => {
  const instruction = providerModeInstruction(command("validate", "tool_execution_failed"), "", { ...surface, validationCorrectionActive: true });
  assert.match(instruction, /Previous action made no progress/);
  assert.match(instruction, /\[VALIDATION_CORRECTION\]/);
  assert.match(instruction, /actual failed validation diagnostics/);
  assert.match(instruction, /Re-verify after the correction/);
});
