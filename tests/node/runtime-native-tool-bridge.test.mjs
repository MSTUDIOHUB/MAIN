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
test("headless attachment adapter copies admitted fixture bytes with stable Session isolation", { skip: !enabled }, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "main-native-attachments-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const workspace = path.join(directory, "workspace");
  await fs.mkdir(workspace);
  const source = path.join(workspace, "brief.txt");
  const bytes = Buffer.from("SOURCE_SENTINEL\r\n中文附件正文\n", "utf8");
  await fs.writeFile(source, bytes);
  const invoke = (cmd, args, host = {}) => JSON.parse(execFileSync("src-tauri/target/debug/examples/runtime_tool_bridge", [], {
    input: JSON.stringify({ workspace, cmd, args, ...host }), encoding: "utf8",
  }));
  const args = { sessionKey: "fixture/session:one", sourcePath: source };
  const result = invoke("ingest_attachment_file", args);
  assert.equal(result.ok, true);
  assert.equal(result.body.displayName, "brief.txt");
  assert.equal(result.body.originalPath, await fs.realpath(source));
  assert.equal(result.body.workspace, await fs.realpath(workspace));
  assert.equal(result.body.sizeBytes, bytes.length);
  assert.match(result.body.path, /^\.MAIN-chat-attachments\/[a-f0-9]+\/[a-f0-9]+-brief\.txt$/);
  assert.deepEqual(await fs.readFile(path.join(result.body.workspace, result.body.path)), bytes);
  assert.equal(invoke("get_chat_temp_root", { sessionKey: args.sessionKey }).body, result.body.workspace);
  assert.equal(invoke("ingest_attachment_file", args).body.path, result.body.path);
  const other = invoke("ingest_attachment_file", { ...args, sessionKey: "fixture/session:two" });
  assert.notEqual(other.body.path, result.body.path);
  assert.deepEqual(await fs.readFile(source), bytes, "ingestion must preserve the admitted source");
  const next = Buffer.from("UPDATED_ATTACHMENT\n");
  await fs.writeFile(source, next);
  assert.equal(invoke("ingest_attachment_file", args).body.sizeBytes, next.length);
  assert.deepEqual(await fs.readFile(path.join(result.body.workspace, result.body.path)), next);
});
test("headless attachment adapter rejects fixture escapes and never takes store authority from model args", { skip: !enabled }, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "main-native-attachment-boundaries-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const workspace = path.join(directory, "workspace");
  const outside = path.join(directory, "outside");
  await fs.mkdir(workspace); await fs.mkdir(outside);
  await fs.writeFile(path.join(workspace, "brief.txt"), "ADMITTED\n");
  await fs.writeFile(path.join(outside, "private.txt"), "OUTSIDE_FIXTURE\n");
  await fs.writeFile(path.join(workspace, "program.exe"), "UNSUPPORTED");
  const invoke = (args, host = {}) => JSON.parse(execFileSync("src-tauri/target/debug/examples/runtime_tool_bridge", [], {
    input: JSON.stringify({ workspace, cmd: "ingest_attachment_file", args, ...host }), encoding: "utf8",
  }));
  const args = { sessionKey: "fixture-session", sourcePath: path.join(workspace, "brief.txt") };
  assert.equal(invoke({ ...args, sourcePath: path.join(outside, "private.txt") }).ok, false);
  await fs.symlink(path.join(outside, "private.txt"), path.join(workspace, "escape.txt"));
  assert.equal(invoke({ ...args, sourcePath: path.join(workspace, "escape.txt") }).ok, false);
  assert.equal(invoke({ ...args, sourcePath: workspace }).ok, false);
  assert.equal(invoke({ ...args, sourcePath: path.join(workspace, "program.exe") }).ok, false);
  assert.equal(invoke({ ...args, attachmentStorePath: outside }).body.workspace, await fs.realpath(workspace));
  await fs.rm(path.join(workspace, ".MAIN-chat-attachments"), { recursive: true });
  await fs.symlink(outside, path.join(workspace, ".MAIN-chat-attachments"));
  assert.equal(invoke(args).ok, false);
  assert.deepEqual(await fs.readdir(outside), ["private.txt"]);
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
