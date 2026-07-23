import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";

const workspaceRoot = process.cwd();

function loadTranspiledModuleSync(sourcePath) {
  const normalizedPath = path.resolve(sourcePath);
  const source = fs.readFileSync(normalizedPath, "utf8");
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      esModuleInterop: true,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: normalizedPath,
  }).outputText;
  const module = { exports: {} };
  const localRequire = createRequire(normalizedPath);
  new Function("exports", "module", "require", transpiled)(module.exports, module, localRequire);
  return module.exports;
}

const {
  getMdViewerExecutionGaps,
  getMdViewerReadablePlanGaps,
  getMdViewerTypedPlanGaps,
} = loadTranspiledModuleSync(
  path.join(workspaceRoot, "tests/e2e/realOmlxMdViewerPlanOracle.ts"),
);

function goodCandidate() {
  return {
    evidence: [
      {
        id: "E1",
        target: "src/components/editor.js",
        statement: "setValue assigns value and dispatches an input event.",
      },
      {
        id: "E2",
        target: "src/components/toolbar.js",
        statement: "The toolbar owns the redundant #file-path filename surface.",
      },
      {
        id: "E3",
        target: "src/main.js",
        statement: "input marks isDirty, schedules autosave, and invokes save_file_content with file_path.",
      },
      {
        id: "E4",
        target: "src-tauri/src/main.rs",
        statement: "The save_file_content handler exposes file_path as external filePath.",
      },
    ],
    diagnoses: [
      {
        id: "R1",
        certainty: "inferred",
        text: "The toolbar renders a duplicate filename surface while tabs already own document naming.",
        evidenceRefs: ["E2"],
        chainRefs: ["E2"],
        goalRefs: ["G1"],
      },
      {
        id: "R2",
        certainty: "inferred",
        text: "editor setValue dispatchEvent(input), then main marks isDirty and scheduleAutoSave runs after a programmatic open.",
        evidenceRefs: ["E1", "E3"],
        chainRefs: ["E1", "E3"],
        goalRefs: ["G2"],
      },
      {
        id: "R3",
        certainty: "inferred",
        text: "save_file_content has a caller payload key mismatch: main sends file_path while the Tauri handler expects external filePath.",
        evidenceRefs: ["E3", "E4"],
        chainRefs: ["E3", "E4"],
        goalRefs: ["G2"],
      },
    ],
    changes: [
      {
        id: "C1",
        text: "Remove the redundant toolbar filename display so it no longer renders document naming.",
        expectedOutcome: "The tab remains the sole filename surface.",
        targetRef: "src/components/toolbar.js",
        operation: "modify",
        evidenceRefs: ["E2"],
        diagnosisRefs: ["R1"],
        goalRefs: ["G1"],
        relationships: ["R1 -> C1"],
      },
      {
        id: "C2",
        text: "Separate editor setValue programmatic loads from user input edit events.",
        expectedOutcome: "Opening a file leaves isDirty false and does not scheduleAutoSave.",
        targetRef: "src/components/editor.js",
        operation: "modify",
        evidenceRefs: ["E1", "E3"],
        diagnosisRefs: ["R2"],
        goalRefs: ["G2"],
        relationships: ["R2 -> C2"],
      },
      {
        id: "C3",
        text: "Change both save_file_content caller payloads from file_path to filePath.",
        expectedOutcome: "src/main.js sends filePath while Rust keeps its internal file_path parameter.",
        targetRef: "src/main.js",
        operation: "modify",
        evidenceRefs: ["E3", "E4"],
        diagnosisRefs: ["R3"],
        goalRefs: ["G2"],
        relationships: ["R3 -> C3"],
      },
    ],
    decisions: [
      {
        id: "D1",
        text: "Keep tabs as the sole canonical filename title owner.",
        disposition: "preserve",
        evidenceRefs: ["E3"],
        goalRefs: ["G1"],
      },
      {
        id: "D2",
        text: "Preserve the Rust main.rs command handler interface unchanged.",
        disposition: "preserve",
        evidenceRefs: ["E4"],
        goalRefs: ["G2"],
      },
    ],
    validations: [
      {
        id: "V1",
        goalRefs: ["G2"],
        changeRefs: ["C2", "C3"],
        expectedOutcome: "Open a local file without editing, wait 6 seconds, and observe no native dialog or save_file_content invoke.",
        blocking: true,
        primitive: {
          kind: "desktop_interaction",
          acceptance: "required",
          actions: [
            { id: "open", kind: "click", target: "#open-btn" },
            { id: "settle", kind: "wait", target: "6000ms without edit" },
          ],
          assertions: [
            { kind: "not_exists", target: "native save dialog", afterActionId: "settle" },
            { kind: "invoke_count", target: "save_file_content", afterActionId: "settle", expected: 0 },
          ],
        },
      },
      {
        id: "V2",
        goalRefs: ["G1"],
        changeRefs: ["C1"],
        expectedOutcome: "The active tab remains the only filename surface.",
        blocking: true,
        primitive: {
          kind: "browser_interaction",
          acceptance: "required",
          actions: [{ id: "inspect", kind: "click", target: ".tab-title" }],
          assertions: [{ kind: "count", target: ".tab-title", afterActionId: "inspect", expected: 1 }],
        },
      },
    ],
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function executionSources() {
  return {
    caller: `
      function setEditorValue(value) { editor.setValue(value); }
      async function handleOpenFile() {
        const selected = await openDialog({ multiple: true });
        if (selected) openFiles(selected);
      }
      async function handleSaveFile() {
        const file = activeFiles[activeTab];
        const content = getEditorValue();
        await invoke('save_file_content', { filePath: file.path, content });
      }
      async function saveAsFile() {
        const filePath = await save({ title: 'Save As' });
        if (!filePath) return false;
        const content = getEditorValue();
        await invoke("save_file_content", { filePath, content });
        activeFiles[activeTab].path = filePath;
        return true;
      }
    `,
    editor: `
      editor.setValue = function(value) {
        this.value = value;
      };
    `,
    handler: `
      #[tauri::command]
      fn save_file_content(content: String, file_path: Option<String>) -> Result<(), String> {
        Ok(())
      }
    `,
    toolbar: `
      export function renderToolbar() {
        toolbar.innerHTML = '<button id="open-btn">Open</button>';
      }
    `,
  };
}

test("MD Viewer execution oracle accepts the exact four-owner incident closure", () => {
  assert.deepEqual(getMdViewerExecutionGaps(executionSources()), []);
});

test("MD Viewer execution oracle rejects the original filename, autosave, and Tauri payload defects", () => {
  const sources = executionSources();
  sources.toolbar = `<span id="file-path"></span>`;
  sources.editor = `
    editor.setValue = function(value) {
      this.value = value;
      this.dispatchEvent(new Event('input'));
    };
  `;
  sources.caller = `
    function setEditorValue(value) { editor.setValue(value); }
    async function handleOpenFile() {
      await openDialog({ multiple: true });
    }
    async function handleSaveFile() {
      const file = activeFiles[activeTab];
      const content = getEditorValue();
      await invoke('save_file_content', { file_path: file.path, content });
    }
    async function saveAsFile() {
      const filePath = await save({ title: 'Save As' });
      const content = getEditorValue();
      await invoke('save_file_content', { filePath, content });
      activeFiles[activeTab].path = filePath;
    }
  `;
  assert.deepEqual(getMdViewerExecutionGaps(sources), [
    "src/components/toolbar.js still renders the redundant #file-path filename label",
    "src/main.js and src/components/editor.js still route programmatic file loading through synthetic input and can schedule autosave",
    "src/main.js save_file_content caller payloads must use Tauri's external filePath key",
    "src/main.js existing-file save must pass the active file.path as filePath",
  ]);
});

test("MD Viewer execution oracle permits bypassing a legacy synthetic setValue shim", () => {
  const sources = executionSources();
  sources.editor = `
    editor.setValue = function(value) {
      this.value = value;
      this.dispatchEvent(new Event('input'));
    };
  `;
  sources.caller = `
    function setEditorValue(value) { editor.value = value; }
    async function handleOpenFile() {
      await openDialog({ multiple: true });
    }
    async function handleSaveFile() {
      const file = activeFiles[activeTab];
      const content = getEditorValue();
      await invoke('save_file_content', { filePath: file.path, content });
    }
    async function saveAsFile() {
      const filePath = await save({ title: 'Save As' });
      const content = getEditorValue();
      await invoke('save_file_content', { filePath, content });
      activeFiles[activeTab].path = filePath;
    }
  `;
  assert.deepEqual(getMdViewerExecutionGaps(sources), []);
});

test("MD Viewer execution oracle accepts an existing-file path alias derived from file.path", () => {
  const sources = executionSources();
  sources.caller = sources.caller.replace(
    "await invoke('save_file_content', { filePath: file.path, content });",
    [
      "const activePath = typeof file.path === 'string' ? file.path : '';",
      "        await invoke('save_file_content', { filePath: activePath, content });",
    ].join("\n"),
  );

  assert.deepEqual(getMdViewerExecutionGaps(sources), []);
});

test("MD Viewer execution oracle rejects a Save As repair that uses content as the path", () => {
  const sources = executionSources();
  sources.caller = sources.caller
    .replace("const filePath = await save({ title: 'Save As' });", "const content = getEditorValue();")
    .replace("const content = getEditorValue();\n        await invoke(\"save_file_content\", { filePath, content });", "await invoke(\"save_file_content\", { filePath: content, content });")
    .replace("activeFiles[activeTab].path = filePath;", "activeFiles[activeTab].path = '';");

  assert.ok(
    getMdViewerExecutionGaps(sources).includes(
      "src/main.js Save As must keep the selected dialog path, pass it as filePath, and persist that same path",
    ),
  );
});

test("MD Viewer execution oracle rejects replacing the plugin Open dialog with the event-emitting backend command", () => {
  const sources = executionSources();
  sources.caller = sources.caller.replace(
    "const selected = await openDialog({ multiple: true });",
    "const selected = await invoke('open_file_dialog');",
  );

  assert.ok(
    getMdViewerExecutionGaps(sources).includes(
      "src/main.js toolbar Open must keep the plugin-dialog boundary instead of invoking the event-emitting backend dialog command",
    ),
  );
});

test("MD Viewer typed oracle accepts an evidence-bound caller fix and executable desktop validation", () => {
  assert.deepEqual(getMdViewerTypedPlanGaps(goodCandidate()), []);
});

test("Markdown/Evidence keyword stuffing cannot replace typed graph ownership", () => {
  const candidate = goodCandidate();
  candidate.evidence[0].statement += " filePath file_path toolbar tabs save_file_content scheduleAutoSave";
  candidate.changes[2].targetRef = "src-tauri/src/main.rs";
  assert.ok(
    getMdViewerTypedPlanGaps(candidate).includes(
      "confirmed command mismatch is not assigned to the caller change",
    ),
  );
});

test("MD Viewer typed oracle requires the editor-to-main ordered inferred chain", () => {
  const candidate = goodCandidate();
  candidate.diagnoses[1].chainRefs = ["E3", "E1"];
  assert.ok(
    getMdViewerTypedPlanGaps(candidate).includes(
      "editor-to-main inferred autosave causal chain missing",
    ),
  );
});

test("MD Viewer typed oracle rejects owner changes without corresponding evidence and diagnosis refs", () => {
  const candidate = goodCandidate();
  candidate.changes[0].evidenceRefs = [];
  candidate.changes[0].diagnosisRefs = [];
  assert.ok(
    getMdViewerTypedPlanGaps(candidate).includes(
      "toolbar duplicate-name change is not bound to its diagnosis and evidence",
    ),
  );
});

test("required validations reject nonexistent fixture selectors", () => {
  const candidate = goodCandidate();
  candidate.validations[0].primitive.actions[0].target = "#open-file-btn";
  candidate.validations[0].primitive.assertions[0].target = "#current-file-display";
  const gaps = getMdViewerTypedPlanGaps(candidate);
  assert.ok(gaps.some((gap) => gap.includes("#open-file-btn")));
  assert.ok(gaps.some((gap) => gap.includes("#current-file-display")));
});

test("browser validation cannot claim native invoke/dialog coverage without an executable mock", () => {
  const candidate = goodCandidate();
  candidate.validations[0].primitive.kind = "browser_interaction";
  const gaps = getMdViewerTypedPlanGaps(candidate);
  assert.ok(gaps.includes("browser validation V1 lacks an executable native mock"));
  assert.ok(gaps.includes("native save contract lacks desktop interaction or executable mock validation"));
});

test("browser validation may cover native behavior through an explicit executable Tauri mock", () => {
  const candidate = goodCandidate();
  candidate.validations[0].primitive.kind = "browser_interaction";
  candidate.validations[0].primitive.actions.unshift({
    id: "mock-invoke",
    kind: "install_mock",
    target: "Tauri invoke mock harness for save_file_content",
  });
  assert.deepEqual(getMdViewerTypedPlanGaps(candidate), []);
});

test("Markdown oracle checks readable typed-node sections without semantic keyword inference", () => {
  const readable = [
    "# Plan",
    "## Diagnosis",
    "- [R1] concise diagnosis",
    "## Changes",
    "- [C1] concise change",
    "## Validation",
    "- [V1] executable validation",
  ].join("\n");
  assert.deepEqual(getMdViewerReadablePlanGaps(readable), []);

  const evidenceOnly = [
    "# Plan",
    "## Evidence",
    "- toolbar editor main.rs setValue filePath file_path [R1] [C1] [V1]",
  ].join("\n");
  assert.deepEqual(getMdViewerReadablePlanGaps(evidenceOnly), [
    "readable diagnosis section missing",
    "readable change section missing",
    "readable validation section missing",
  ]);
});

test("command handler preservation must be an evidence-bound decision", () => {
  const candidate = clone(goodCandidate());
  candidate.decisions[1].evidenceRefs = ["E3"];
  assert.ok(
    getMdViewerTypedPlanGaps(candidate).includes(
      "command handler preserve decision is not evidence-bound",
    ),
  );
});
