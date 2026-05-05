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
  assert.ok(capability.permissions.includes("updater:default"));
  assert.ok(capability.permissions.includes("process:default"));
});

test("Tauri updater config points at public release manifest", () => {
  const config = JSON.parse(
    fs.readFileSync(path.join(workspaceRoot, "src-tauri/tauri.conf.json"), "utf8"),
  );

  assert.equal(config.bundle.createUpdaterArtifacts, true);
  assert.match(config.plugins.updater.pubkey, /^dW50cnVzdGVk/);
  assert.deepEqual(config.plugins.updater.endpoints, [
    "https://github.com/MSTUDIOHUB/MAIN-Releases/releases/latest/download/latest.json",
  ]);
});
