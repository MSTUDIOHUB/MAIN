import test from "node:test";
import assert from "node:assert/strict";
import { unityEditorStatusArgs, unityEditorReady } from "../../scripts/unity-editor-readiness.mjs";

test("readiness metadata belongs to Pipeline command and requires the isolated project plus actual ready facts", () => {
  const project = "/tmp/isolated-project";
  assert.deepEqual(unityEditorStatusArgs(project).slice(0, 5), ["command", "editor", "status", "--project-path", project]);
  const ready = { status: "ready", compiling: false, domainReloadInProgress: false, projectPath: project };
  assert.equal(unityEditorReady(ready, project), true);
  assert.equal(unityEditorReady({ ...ready, compiling: true }, project), false);
  assert.equal(unityEditorReady({ ...ready, projectPath: "/tmp/original" }, project), false);
  assert.equal(unityEditorReady({ status: "ready" }, project), false);
});
