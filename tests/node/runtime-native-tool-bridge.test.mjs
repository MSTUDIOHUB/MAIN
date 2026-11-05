import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const enabled = process.env.MAIN_NATIVE_TOOL_BRIDGE_TEST === "1";
test("existing-project validation keeps independent test Sessions outside the project", { skip: !enabled }, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "main-native-external-store-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const workspace = path.join(directory, "existing-project");
  await fs.mkdir(workspace);
  const invoke = (round, cmd, args = {}) => JSON.parse(execFileSync("src-tauri/target/debug/examples/runtime_tool_bridge", [], {
    input: JSON.stringify({ workspace, sessionStorePath: path.join(directory, `round-${round}.sqlite3`), cmd, args }), encoding: "utf8",
  }));
  assert.deepEqual(invoke(1, "list_project_sessions").body, []);
  assert.equal(invoke(1, "save_project_session", { session: { id: 17, storageRevision: 0, runtimeSnapshot: {} } }).ok, true);
  assert.deepEqual(await fs.readdir(workspace), [], "test metadata must not pollute TestCli");
  assert.deepEqual(invoke(2, "list_project_sessions").body, [], "each round has a separate Session store");
  assert.equal(invoke(1, "list_project_sessions").body.length, 1);
});
test("native test host preserves structured storage errors without flattening their codes", { skip: !enabled }, async t => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "main-native-error-"));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  await fs.writeFile(path.join(workspace, ".MAIN-test-session.sqlite3"), "not a SQLite database");
  const result = JSON.parse(execFileSync("src-tauri/target/debug/examples/runtime_tool_bridge", [], {
    input: JSON.stringify({ workspace, cmd: "list_project_sessions", args: {} }), encoding: "utf8",
  }));
  assert.equal(result.ok, false);
  assert.equal(JSON.parse(result.error).code, "database");
});
test("headless Rust host preserves production approval, path boundaries, exit codes and Session CAS", { skip: !enabled }, async t => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "main-native-contract-"));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const invoke = (cmd, args) => JSON.parse(execFileSync("src-tauri/target/debug/examples/runtime_tool_bridge", [], {
    input: JSON.stringify({ workspace, cmd, args }), encoding: "utf8",
  }));
  const allowed = invoke("run_command", { command: "printf bridge-ok" });
  assert.equal(allowed.body.stdout, "bridge-ok"); assert.equal(allowed.body.exitCode, 0);
  const deniedCommand = "find / -name SKILL.md";
  assert.equal(invoke("shell_permission_preflight", { command: deniedCommand }).body.decision, "deny");
  const denied = invoke("run_command", { command: deniedCommand, permissionApproval: { command: deniedCommand, scope: "once", rules: [] } });
  assert.equal(denied.ok, false); assert.match(denied.error, /WorkspacePathEscape/);
  const needsApproval = "python3 -c 'import sys;sys.exit(7)'";
  assert.equal(invoke("run_command", { command: needsApproval }).ok, false);
  const failed = invoke("run_command", { command: needsApproval, permissionApproval: { command: needsApproval, scope: "once", rules: [] } });
  assert.equal(failed.body.exitCode, 7); assert.equal(failed.body.success, false);
  await fs.symlink(os.tmpdir(), path.join(workspace, "escape"));
  assert.equal(invoke("validate_workspace_path", { path: "escape/outside.txt" }).ok, false);
  const save = invoke("save_project_session", { session: { id: 17, storageRevision: 0, updatedAtMs: Date.now(), runtimeSnapshot: {} } });
  assert.equal(save.body.storageRevision, 1);
  assert.equal(invoke("save_project_session", { session: { id: 17, storageRevision: 0 } }).ok, false);
  assert.equal(invoke("load_project_session", { sessionId: 17 }).body.storageRevision, 1);
});
