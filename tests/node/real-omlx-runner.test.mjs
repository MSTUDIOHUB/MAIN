import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const source = fs.readFileSync(
  path.join(process.cwd(), "scripts/run-real-omlx-plan-e2e.mjs"),
  "utf8",
);

test("real OMLX validation selects only a fully loaded model", () => {
  assert.match(source, /\/models\/status/);
  assert.match(source, /model\?\.loaded === true && model\?\.is_loading !== true/);
  assert.match(source, /refusing to trigger an implicit large-model load/);
  assert.match(source, /unloadedRequestedModels/);
  assert.match(source, /OMLX_MODELS: selectedModelIds\.join/);
});
