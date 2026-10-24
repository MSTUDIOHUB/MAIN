import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { snapshotUnityProject, snapshotHashes, restoreUnityProjectSnapshot, writeUnitySnapshot, readUnitySnapshot } from "../../scripts/unity-project-snapshot.mjs";

test("same-project rounds restore a saved baseline and retain unrelated files", async t => {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), "main-unity-snapshot-"));
  t.after(() => fs.rm(project, { recursive: true, force: true }));
  await fs.mkdir(path.join(project, "Assets"));
  await fs.mkdir(path.join(project, "Assets/KeepEmpty"));
  await fs.writeFile(path.join(project, "Assets/User.cs"), "saved user source");
  await fs.writeFile(path.join(project, "user-notes.txt"), "outside test scope");
  const baseline = await snapshotUnityProject(project, ["Assets"]);
  const archive = path.join(project, "evidence.json.gz");
  await writeUnitySnapshot(archive, baseline);
  await fs.writeFile(path.join(project, "Assets/User.cs"), "test edit");
  await fs.mkdir(path.join(project, "Assets/Test"));
  await fs.writeFile(path.join(project, "Assets/Test/New.cs"), "new test source");
  await fs.writeFile(path.join(project, "Assets/KeepEmpty/Added.cs"), "test source in an existing empty directory");
  const after = snapshotHashes(await snapshotUnityProject(project, ["Assets"]));
  const restored = await restoreUnityProjectSnapshot(project, await readUnitySnapshot(archive), after);
  assert.deepEqual(restored.hashes, snapshotHashes(baseline));
  assert.equal(await fs.readFile(path.join(project, "user-notes.txt"), "utf8"), "outside test scope");
  assert.equal(await fs.stat(path.join(project, "Assets/Test")).catch(() => null), null);
  assert.equal((await fs.stat(path.join(project, "Assets/KeepEmpty"))).isDirectory(), true);
});

test("a concurrent user edit prevents every baseline restoration write", async t => {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), "main-unity-snapshot-race-"));
  t.after(() => fs.rm(project, { recursive: true, force: true }));
  await fs.mkdir(path.join(project, "Assets"));
  const file = path.join(project, "Assets/User.cs");
  await fs.writeFile(file, "original");
  const baseline = await snapshotUnityProject(project, ["Assets"]);
  await fs.writeFile(file, "test edit");
  const after = snapshotHashes(await snapshotUnityProject(project, ["Assets"]));
  await fs.writeFile(file, "user edit after test");
  await assert.rejects(restoreUnityProjectSnapshot(project, baseline, after), /restore refused/);
  assert.equal(await fs.readFile(file, "utf8"), "user edit after test");
});
