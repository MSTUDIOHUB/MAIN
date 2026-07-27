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
  getMdViewerFinalSummaryGaps,
  getMdViewerReadablePlanGaps,
  getMdViewerTypedPlanGaps,
  getMdViewerWorkPlanGaps,
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
        target: "src/main.js",
        statement: "DOMContentLoaded pushes one pristine initialFile, while openFiles appends fileEntry beside it.",
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
        text: "openFiles appends beside the pristine initial tab, so the opened filename and unsaved document title coexist.",
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
        text: "Replace the untouched pristine initial tab when the first local file opens instead of appending beside it.",
        expectedOutcome: "The opened filename replaces the initial unsaved document title while edited unsaved tabs remain safe.",
        targetRef: "src/main.js",
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
        text: "Keep edited unsaved tabs and normal tab title ownership unchanged.",
        disposition: "preserve",
        evidenceRefs: ["E2"],
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

function goodWorkPlan() {
  return {
    evidence: [
      { id: "E-editor", target: "src/components/editor.js" },
      { id: "E-main", target: "src/main.js" },
      { id: "E-rust", target: "src-tauri/src/main.rs" },
    ],
    draft: {
      summary: [
        "DOMContentLoaded creates a pristine blank initialFile, then openFiles appends beside it so both titles coexist.",
        "editor setValue dispatchEvent(input), then main marks isDirty and calls scheduleAutoSave.",
        "main calls save_file_content with file_path while the Tauri handler exposes external filePath.",
      ].join("\n"),
      findings: [
        {
          statement:
            "DOMContentLoaded creates a pristine blank initialFile, then openFiles appends beside it so both titles coexist.",
          basis: ["E-main"],
        },
        {
          statement:
            "editor setValue dispatchEvent(input), then main marks isDirty and calls scheduleAutoSave.",
          basis: ["E-editor", "E-main"],
        },
        {
          statement:
            "main calls save_file_content with file_path while the Tauri handler exposes external filePath.",
          basis: ["E-main", "E-rust"],
        },
      ],
      steps: [
        {
          operation: "modify",
          targets: ["src/main.js"],
          basis: ["E-main"],
          change:
            "In openFiles replace the pristine initial blank tab instead of appending beside it.",
          expectedOutcome: "Only the opened filename remains visible.",
        },
        {
          operation: "modify",
          targets: ["src/components/editor.js"],
          basis: ["E-editor"],
          change:
            "Remove dispatchEvent(input) from setValue so programmatic loads do not synthesize edits.",
          expectedOutcome: "Opening a file leaves it clean and does not schedule autosave.",
        },
        {
          operation: "modify",
          targets: ["src/main.js"],
          basis: ["E-main", "E-rust"],
          change:
            "Change each save_file_content caller payload from file_path to filePath.",
          expectedOutcome: "The existing Tauri handler receives the active file path.",
        },
      ],
      validations: [
        {
          stepIndexes: [0, 1, 2],
          kind: "finite_command",
          command: "npm run build",
          expectedOutcome: "The project build succeeds.",
          required: true,
        },
        {
          stepIndexes: [0, 1, 2],
          kind: "desktop",
          expectedOutcome:
            "Open a local md file without editing; programmatic setValue must not invoke save_file_content or show a save dialog.",
          required: true,
        },
      ],
    },
  };
}

function executionSources() {
  return {
    caller: `
      const initialFile = { path: '', content: '', isDirty: false };
      activeFiles.push(initialFile);
      function setEditorValue(value) { editor.setValue(value); }
      async function handleOpenFile() {
        const selected = await openDialog({ multiple: true });
        if (selected) openFiles(selected);
      }
      async function openFiles(filePath) {
        await invoke('read_file_content', { path: filePath });
        const fileEntry = { path: filePath, content: '', isDirty: false };
        if (
          activeFiles.length === 1 &&
          !activeFiles[0].path &&
          activeFiles[0].content === '' &&
          activeFiles[0].isDirty === false
        ) {
          activeFiles[0] = fileEntry;
          updateTabTitle(0);
        } else {
          activeFiles.push(fileEntry);
        }
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

test("MD Viewer execution oracle rejects the original blank-tab, autosave, and Tauri payload defects", () => {
  const sources = executionSources();
  sources.editor = `
    editor.setValue = function(value) {
      this.value = value;
      this.dispatchEvent(new Event('input'));
    };
  `;
  sources.caller = `
    const initialFile = { path: '', content: '', isDirty: false };
    activeFiles.push(initialFile);
    function setEditorValue(value) { editor.setValue(value); }
    async function handleOpenFile() {
      await openDialog({ multiple: true });
    }
    async function openFiles(filePath) {
      const fileEntry = { path: filePath, content: '', isDirty: false };
      activeFiles.push(fileEntry);
      await invoke('read_file_content', { path: filePath });
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
  const gaps = getMdViewerExecutionGaps(sources);
  assert.equal(gaps.length, 4);
  assert.ok(gaps.some((gap) => gap.includes(
    "openFiles must replace only one pristine initial tab",
  )));
  assert.ok(gaps.some((gap) => gap.includes(
    "programmatic setValue still dispatches input",
  )));
  assert.ok(gaps.some((gap) => gap.includes(
    "save_file_content caller payloads must use Tauri's external filePath key",
  )));
  assert.ok(gaps.some((gap) => gap.includes(
    "existing-file save must invoke save_file_content with the active file.path as filePath",
  )));
  assert.ok(gaps.every((gap) => /^src\/.+:\d+:1 - /.test(gap)));
});

test("MD Viewer execution oracle rejects post-fix API drift", () => {
  const sources = executionSources();
  sources.caller = sources.caller
    .replace(
      "invoke('read_file_content', { path: filePath })",
      "invoke('read_file_content', { filePath: filePath })",
    );
  sources.editor = sources.editor.replace(
    "function(value)",
    "function(value, silent)",
  );

  const gaps = getMdViewerExecutionGaps(sources);
  assert.ok(gaps.some((gap) => gap.includes(
    "setValue must keep its single-value API while removing only the synthetic input dispatch",
  )));
  assert.ok(gaps.some((gap) => gap.includes(
    "read_file_content must preserve the Rust handler's external path key",
  )));
});

test("MD Viewer execution oracle points a bad later save payload at the offending invoke", () => {
  const sources = executionSources();
  sources.caller = sources.caller.replace(
    'await invoke("save_file_content", { filePath, content });',
    'await invoke("save_file_content", { file_path: filePath, content });',
  );

  const expectedLine = sources.caller
    .slice(0, sources.caller.indexOf('invoke("save_file_content", { file_path'))
    .split(/\r?\n/).length;
  const gap = getMdViewerExecutionGaps(sources).find((entry) =>
    entry.includes("save_file_content caller payloads must use Tauri's external filePath key")
  );
  assert.ok(gap);
  assert.match(gap, new RegExp(`^src/main\\.js:${expectedLine}:1 - `));
});

test("MD Viewer execution oracle does not mistake a payload value for the filePath key", () => {
  const sources = executionSources();
  sources.caller = sources.caller.replace(
    'await invoke("save_file_content", { filePath, content });',
    'await invoke("save_file_content", { file_path: filePath, content });',
  );

  const gaps = getMdViewerExecutionGaps(sources);
  assert.ok(gaps.some((gap) => gap.includes(
    "Save As must keep the selected dialog path, pass it as filePath, and persist that same path",
  )));
});

test("MD Viewer execution oracle replaces only a truly pristine initial tab", () => {
  const sources = executionSources();
  sources.caller = sources.caller.replace(
    "          activeFiles[0].content === '' &&\n          activeFiles[0].isDirty === false",
    "          activeFiles[0].content === ''",
  );

  assert.ok(
    getMdViewerExecutionGaps(sources).some((gap) => gap.includes(
      "openFiles must replace only one pristine initial tab",
    )),
  );
});

test("MD Viewer execution oracle rejects an invented resetSaveState runtime call", () => {
  const sources = executionSources();
  sources.caller = sources.caller.replace(
    "          activeFiles[0] = fileEntry;",
    "          activeFiles[0] = fileEntry;\n          resetSaveState();",
  );

  assert.ok(
    getMdViewerExecutionGaps(sources).some((gap) => gap.includes(
      "no such runtime function is declared or imported",
    )),
  );
  sources.caller += "\nfunction resetSaveState() {}";
  assert.equal(
    getMdViewerExecutionGaps(sources).some((gap) => gap.includes(
      "no such runtime function is declared or imported",
    )),
    false,
  );
});

test("MD Viewer execution oracle preserves a toolbar API that still has callers", () => {
  const sources = executionSources();
  sources.caller += "\ntoolbar.setCurrentFile('');";
  assert.ok(
    getMdViewerExecutionGaps(sources).some((gap) => gap.includes(
      "setCurrentFile must remain exported while src/main.js still calls that module boundary",
    )),
  );
  sources.toolbar += "\nexport function setCurrentFile(filePath) { void filePath; }";
  assert.equal(
    getMdViewerExecutionGaps(sources).some((gap) => gap.includes(
      "setCurrentFile must remain exported while src/main.js still calls that module boundary",
    )),
    false,
  );
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

test("MD Viewer execution oracle rejects a direct undefined save command call", () => {
  const sources = executionSources();
  sources.caller = sources.caller.replace(
    "await invoke('save_file_content', { filePath: file.path, content });",
    "await save_file_content({ filePath: file.path, content });",
  );

  assert.ok(
    getMdViewerExecutionGaps(sources).some((gap) => gap.includes(
      "existing-file save must invoke save_file_content",
    )),
  );
});

test("MD Viewer execution oracle requires the replaced tab to use the existing title API", () => {
  const sources = executionSources();
  sources.caller = sources.caller.replace(
    "          updateTabTitle(0);",
    [
      "          const tab = document.querySelector('.tab-item');",
      "          if (tab) tab.querySelector('.tab-title').textContent = fileEntry.title;",
    ].join("\n"),
  );

  const gaps = getMdViewerExecutionGaps(sources);
  assert.ok(gaps.some((gap) => gap.includes(
    "then update that existing tab title",
  )));
  assert.ok(gaps.some((gap) => gap.includes(
    "remove the invented selector",
  )));
});

test("MD Viewer execution oracle rejects a Save As repair that uses content as the path", () => {
  const sources = executionSources();
  sources.caller = sources.caller
    .replace("const filePath = await save({ title: 'Save As' });", "const content = getEditorValue();")
    .replace("const content = getEditorValue();\n        await invoke(\"save_file_content\", { filePath, content });", "await invoke(\"save_file_content\", { filePath: content, content });")
    .replace("activeFiles[activeTab].path = filePath;", "activeFiles[activeTab].path = '';");

  assert.ok(
    getMdViewerExecutionGaps(sources).some((gap) => gap.includes(
      "Save As must keep the selected dialog path, pass it as filePath, and persist that same path",
    )),
  );
});

test("MD Viewer execution oracle rejects replacing the plugin Open dialog with the event-emitting backend command", () => {
  const sources = executionSources();
  sources.caller = sources.caller.replace(
    "const selected = await openDialog({ multiple: true });",
    "const selected = await invoke('open_file_dialog');",
  );

  assert.ok(
    getMdViewerExecutionGaps(sources).some((gap) => gap.includes(
      "toolbar Open must keep the plugin-dialog boundary instead of invoking the event-emitting backend dialog command",
    )),
  );
});

test("MD Viewer typed oracle accepts an evidence-bound caller fix and executable desktop validation", () => {
  assert.deepEqual(getMdViewerTypedPlanGaps(goodCandidate()), []);
});

test("MD Viewer Runtime v2 WorkPlan oracle accepts the evidence-bound repair graph", () => {
  assert.deepEqual(getMdViewerWorkPlanGaps(goodWorkPlan()), []);
});

test("MD Viewer Runtime v2 WorkPlan oracle rejects missing owner and validation edges", () => {
  const plan = goodWorkPlan();
  plan.evidence = plan.evidence.filter((entry) => entry.id !== "E-rust");
  plan.draft.validations[0].stepIndexes = [];
  plan.draft.validations[1].stepIndexes = [];
  plan.draft.steps[2].targets = ["src-tauri/src/main.rs"];

  const gaps = getMdViewerWorkPlanGaps(plan);
  assert.ok(gaps.includes("handler owner evidence missing"));
  assert.ok(gaps.includes("save command filePath repair step missing"));
  assert.ok(gaps.includes("initial-tab step lacks a required validation edge"));
  assert.ok(gaps.includes("editor autosave step lacks a required validation edge"));
  assert.ok(gaps.some((gap) => gap.includes("non-owner mutation targets proposed")));
});

test("MD Viewer final-summary oracle requires all verified user-visible outcomes", () => {
  const accurateSummary = [
    "打开本地文件时会替换未修改的初始空白标签页，不再让文件名与未命名文档并存。",
    "程序化 setValue 载入不再派发 input，因此不会把文件标为 dirty 或触发自动保存。",
    "现有文件通过 save_file_content 使用活动文件的 filePath。",
  ].join("\n");
  assert.deepEqual(getMdViewerFinalSummaryGaps(accurateSummary), []);

  const inaccurateSummary =
    "已修复 handleSaveFile，因此文件名和未保存文档不会同时显示。测试通过。";
  assert.deepEqual(getMdViewerFinalSummaryGaps(inaccurateSummary), [
    "final summary omits the pristine initial-tab replacement",
    "final summary omits the programmatic-load dirty/autosave boundary",
    "final summary omits the active filePath save contract",
  ]);
});

test("Markdown/Evidence keyword stuffing cannot replace typed graph ownership", () => {
  const candidate = goodCandidate();
  candidate.evidence[0].statement += " filePath file_path initialFile tabs save_file_content scheduleAutoSave";
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
      "pristine initial-tab replacement is not bound to its diagnosis and evidence",
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

test("Markdown oracle permits a free narrative and requires only change and validation review sections", () => {
  const readable = [
    "# Repair the editor lifecycle",
    "The diagnosis can use whatever structure best explains this task.",
    "## Changes",
    "### S1 · concise change",
    "## Validation",
    "### V1 · executable validation",
  ].join("\n");
  assert.deepEqual(getMdViewerReadablePlanGaps(readable), []);

  const evidenceOnly = [
    "# Plan",
    "## Evidence",
    "- toolbar editor main.rs setValue filePath file_path [R1] [C1] [V1]",
  ].join("\n");
  assert.deepEqual(getMdViewerReadablePlanGaps(evidenceOnly), [
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
