import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const workspaceRoot = process.cwd();

test("default Tauri capability allows dialog confirm", () => {
  const capability = JSON.parse(
    fs.readFileSync(path.join(workspaceRoot, "src-tauri/capabilities/default.json"), "utf8"),
  );

  assert.ok(capability.permissions.includes("dialog:default"));
  assert.ok(capability.permissions.includes("dialog:allow-confirm"));
});
