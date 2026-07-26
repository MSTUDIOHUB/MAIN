import type { PlanCandidateV3 } from "../../src/lib/planContract";

type MdViewerCandidate = Pick<
  PlanCandidateV3,
  "evidence" | "diagnoses" | "changes" | "decisions" | "validations"
>;

const OWNER_PATHS = {
  toolbar: "src/components/toolbar.js",
  editor: "src/components/editor.js",
  caller: "src/main.js",
  handler: "src-tauri/src/main.rs",
} as const;

const FORBIDDEN_REQUIRED_VALIDATION_TARGETS = new Set([
  "#open-file-btn",
  "#current-file-display",
]);

export interface MdViewerExecutionSources {
  caller: string;
  editor: string;
  handler: string;
  toolbar: string;
}

function sourceLine(source: string, pattern: RegExp): number {
  const index = String(source || "").search(pattern);
  if (index < 0) return 1;
  return source.slice(0, index).split(/\r?\n/).length;
}

function sourceLineAtIndex(source: string, index: number): number {
  if (!Number.isFinite(index) || index < 0) return 1;
  return source.slice(0, index).split(/\r?\n/).length;
}

function sourceGap(input: {
  path: string;
  source: string;
  pattern: RegExp;
  message: string;
}): string {
  return `${input.path}:${sourceLine(input.source, input.pattern)}:1 - ${input.message}`;
}

function sourceGapAtIndex(input: {
  path: string;
  source: string;
  index: number;
  message: string;
}): string {
  return `${input.path}:${sourceLineAtIndex(input.source, input.index)}:1 - ${input.message}`;
}

function extractBracedBody(source: string, marker: RegExp): string {
  const match = marker.exec(source);
  if (!match) return "";
  const openingBrace = source.indexOf("{", match.index + match[0].length);
  if (openingBrace < 0) return "";
  let depth = 0;
  for (let index = openingBrace; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] !== "}") continue;
    depth -= 1;
    if (depth === 0) return source.slice(openingBrace + 1, index);
  }
  return "";
}

type CommandPayloadMatch = {
  index: number;
  payload: string;
};

function getCommandPayloadMatches(source: string, command: string): CommandPayloadMatch[] {
  const payloads: CommandPayloadMatch[] = [];
  const escapedCommand = command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    `invoke\\(\\s*["']${escapedCommand}["']\\s*,\\s*\\{([\\s\\S]*?)\\}\\s*\\)`,
    "g",
  );
  for (const match of source.matchAll(pattern)) {
    payloads.push({
      index: match.index ?? 0,
      payload: String(match[1] || ""),
    });
  }
  return payloads;
}

function payloadHasKey(payload: string, key: string): boolean {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|,)\\s*${escapedKey}\\s*(?::|,|$)`, "m").test(payload);
}

function payloadPassesVariableAsKey(
  payload: string,
  key: string,
  variable: string,
): boolean {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const escapedVariable = variable.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `(?:^|,)\\s*${escapedKey}\\s*(?::\\s*${escapedVariable}\\b)?\\s*(?:,|$)`,
    "m",
  ).test(payload);
}

/**
 * Source-level acceptance oracle for the real MD Viewer Execute replay.
 * It validates the exact four-owner incident described by the user instead of
 * an unrelated implementation detail such as toolbar listener syntax.
 */
export function getMdViewerExecutionGaps(
  sources: MdViewerExecutionSources,
): string[] {
  const gaps: string[] = [];
  if (
    /\btoolbar\.setCurrentFile\s*\(/.test(sources.caller) &&
    !/\bexport\s+function\s+setCurrentFile\s*\(/.test(sources.toolbar)
  ) {
    gaps.push(sourceGap({
      path: OWNER_PATHS.toolbar,
      source: sources.toolbar,
      pattern: /\bexport\s+function\s+setCurrentFile\b/,
      message: "setCurrentFile must remain exported while src/main.js still calls that module boundary",
    }));
  }

  const callerSetEditorValue = extractBracedBody(
    sources.caller,
    /\bfunction\s+setEditorValue\s*\([^)]*\)\s*/,
  );
  const patchedSetValue = extractBracedBody(
    sources.editor,
    /\beditor\.setValue\s*=\s*function\s*\([^)]*\)\s*/,
  );
  const patchedSetValueKeepsSingleValueArgument =
    /\beditor\.setValue\s*=\s*function\s*\(\s*[A-Za-z_$][\w$]*\s*\)\s*/.test(
      sources.editor,
    );
  const callerUsesPatchedSetValue = /\.setValue\s*\(/.test(callerSetEditorValue);
  const patchedSetValueDispatchesInput =
    /dispatchEvent\s*\(\s*new\s+Event\s*\(\s*["']input["']/.test(patchedSetValue);
  if (callerUsesPatchedSetValue && patchedSetValueDispatchesInput) {
    gaps.push(sourceGap({
      path: OWNER_PATHS.editor,
      source: sources.editor,
      pattern: /\beditor\.setValue\s*=\s*function\b/,
      message: "programmatic setValue still dispatches input, marks a just-opened file dirty, and can schedule an unintended save",
    }));
  }
  if (callerUsesPatchedSetValue && !patchedSetValueKeepsSingleValueArgument) {
    gaps.push(sourceGap({
      path: OWNER_PATHS.editor,
      source: sources.editor,
      pattern: /\beditor\.setValue\s*=\s*function\b/,
      message: "setValue must keep its single-value API while removing only the synthetic input dispatch",
    }));
  }

  const openFilesBody = extractBracedBody(
    sources.caller,
    /\basync\s+function\s+openFiles\s*\([^)]*\)\s*/,
  );
  const bootstrapsPristineInitialTab =
    /\bactiveFiles\.push\s*\(\s*initialFile\s*\)/.test(sources.caller);
  const appendsOpenedFile = /\bactiveFiles\.push\s*\(\s*fileEntry\s*\)/.test(openFilesBody);
  const guardsPristineInitialTab =
    /\bactiveFiles\.length\s*===?\s*1\b/.test(openFilesBody) &&
    (
      /!\s*activeFiles\s*\[\s*0\s*\]\.path\b/.test(openFilesBody) ||
      /activeFiles\s*\[\s*0\s*\]\.path\s*===?\s*["']{2}/.test(openFilesBody)
    ) &&
    /activeFiles\s*\[\s*0\s*\]\.content\s*===?\s*["']{2}/.test(openFilesBody) &&
    (
      /activeFiles\s*\[\s*0\s*\]\.isDirty\s*===?\s*false\b/.test(openFilesBody) ||
      /!\s*activeFiles\s*\[\s*0\s*\]\.isDirty\b/.test(openFilesBody)
    );
  const replacesPristineInitialTab =
    /\bactiveFiles\s*\[\s*0\s*\]\s*=\s*fileEntry\b/.test(openFilesBody) ||
    /\bactiveFiles\.splice\s*\(\s*0\s*,\s*1\s*,\s*fileEntry\s*\)/.test(openFilesBody);
  const updatesReplacedInitialTabTitle =
    /\bupdateTabTitle\s*\(\s*(?:0|activeTab)\s*\)/.test(openFilesBody);
  if (
    bootstrapsPristineInitialTab &&
    appendsOpenedFile &&
    !(
      guardsPristineInitialTab &&
      replacesPristineInitialTab &&
      updatesReplacedInitialTabTitle
    )
  ) {
    gaps.push(sourceGap({
      path: OWNER_PATHS.caller,
      source: sources.caller,
      pattern: /\bactiveFiles\.push\s*\(\s*fileEntry\s*\)/,
      message: "openFiles must replace only one pristine initial tab with no path, empty content, and isDirty false, then update that existing tab title so the opened filename and an unsaved document label do not coexist",
    }));
  }
  if (
    /\.tab-item\b/.test(openFilesBody) &&
    !/\bclassName\s*=\s*["'][^"']*\btab-item\b/.test(sources.caller)
  ) {
    gaps.push(sourceGap({
      path: OWNER_PATHS.caller,
      source: sources.caller,
      pattern: /\.tab-item\b/,
      message: "openFiles queries .tab-item even though this project creates tab elements with the existing .tab/updateTabTitle API; remove the invented selector",
    }));
  }

  const savePayloadMatches = getCommandPayloadMatches(sources.caller, "save_file_content");
  const savePayloads = savePayloadMatches.map((match) => match.payload);
  const readPayloadMatches = getCommandPayloadMatches(sources.caller, "read_file_content");
  const handleSaveBody = extractBracedBody(
    sources.caller,
    /\basync\s+function\s+handleSaveFile\s*\([^)]*\)\s*/,
  );
  const saveAsBody = extractBracedBody(
    sources.caller,
    /\basync\s+function\s+saveAsFile\s*\([^)]*\)\s*/,
  );
  if (savePayloads.length === 0) {
    gaps.push(sourceGap({
      path: OWNER_PATHS.caller,
      source: sources.caller,
      pattern: /\basync\s+function\s+handleSaveFile\b/,
      message: "save_file_content caller payloads are missing",
    }));
  } else {
    const invalidSavePayload = savePayloadMatches.find(({ payload }) =>
      /\bfile_path\s*:/.test(payload) ||
      !payloadHasKey(payload, "filePath")
    );
    if (invalidSavePayload) {
      gaps.push(sourceGapAtIndex({
        path: OWNER_PATHS.caller,
        source: sources.caller,
        index: invalidSavePayload.index,
        message: "save_file_content caller payloads must use Tauri's external filePath key",
      }));
    }
  }
  const activePathAlias = /\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*[^;]*\bfile\.path\b/.exec(
    handleSaveBody,
  )?.[1] || null;
  const handleSavePayloadMatches = getCommandPayloadMatches(
    handleSaveBody,
    "save_file_content",
  );
  const existingFileSaveUsesActivePath = handleSavePayloadMatches.some(({ payload }) =>
    /\bfilePath\s*:\s*file\.path\b/.test(payload) ||
    Boolean(
      activePathAlias &&
      new RegExp(
        `\\bfilePath\\s*(?::\\s*${activePathAlias}\\b|,)`,
      ).test(payload),
    )
  );
  if (!existingFileSaveUsesActivePath) {
    gaps.push(sourceGap({
      path: OWNER_PATHS.caller,
      source: sources.caller,
      pattern: /\basync\s+function\s+handleSaveFile\b/,
      message: "existing-file save must invoke save_file_content with the active file.path as filePath instead of falling through an undefined or dialog-backed write path",
    }));
  }
  const invalidReadPayload = readPayloadMatches.find(({ payload }) =>
    payloadHasKey(payload, "filePath") ||
    !payloadHasKey(payload, "path")
  );
  if (invalidReadPayload) {
    gaps.push(sourceGapAtIndex({
      path: OWNER_PATHS.caller,
      source: sources.caller,
      index: invalidReadPayload.index,
      message: "read_file_content must preserve the Rust handler's external path key",
    }));
  }
  const saveAsPayloads = getCommandPayloadMatches(
    saveAsBody,
    "save_file_content",
  ).map((match) => match.payload);
  if (
    !/\b(?:const|let)\s+filePath\s*=\s*await\s+save\s*\(/.test(saveAsBody) ||
    !saveAsPayloads.some((payload) =>
      payloadPassesVariableAsKey(payload, "filePath", "filePath")
    ) ||
    !/\bactiveFiles\s*\[\s*activeTab\s*\]\.path\s*=\s*filePath\b/.test(saveAsBody) ||
    /\bfilePath\s*:\s*content\b/.test(saveAsBody)
  ) {
    gaps.push(sourceGap({
      path: OWNER_PATHS.caller,
      source: sources.caller,
      pattern: /\basync\s+function\s+saveAsFile\b/,
      message: "Save As must keep the selected dialog path, pass it as filePath, and persist that same path",
    }));
  }
  if (
    /\bresetSaveState\s*\(/.test(sources.caller) &&
    !(
      /\bfunction\s+resetSaveState\s*\(/.test(sources.caller) ||
      /\b(?:const|let|var)\s+resetSaveState\s*=/.test(sources.caller) ||
      /\bimport\s*\{[^}]*\bresetSaveState\b[^}]*\}/s.test(sources.caller)
    )
  ) {
    gaps.push(sourceGap({
      path: OWNER_PATHS.caller,
      source: sources.caller,
      pattern: /\bresetSaveState\s*\(/,
      message: "openFiles calls resetSaveState, but no such runtime function is declared or imported",
    }));
  }

  const handleOpenBody = extractBracedBody(
    sources.caller,
    /\basync\s+function\s+handleOpenFile\s*\([^)]*\)\s*/,
  );
  if (
    !/\bopenDialog\s*\(/.test(handleOpenBody) ||
    /invoke\s*\(\s*["']open_file_dialog["']/.test(handleOpenBody)
  ) {
    gaps.push(sourceGap({
      path: OWNER_PATHS.caller,
      source: sources.caller,
      pattern: /\basync\s+function\s+handleOpenFile\b/,
      message: "toolbar Open must keep the plugin-dialog boundary instead of invoking the event-emitting backend dialog command",
    }));
  }

  if (
    !/\bfn\s+save_file_content\s*\([^)]*\bfile_path\s*:/s.test(sources.handler)
  ) {
    gaps.push(sourceGap({
      path: OWNER_PATHS.handler,
      source: sources.handler,
      pattern: /\bfn\s+save_file_content\b/,
      message: "Rust save_file_content must keep its internal snake_case file_path parameter while Tauri exposes the JavaScript key as filePath",
    }));
  }
  return gaps;
}

/**
 * The source oracle proves the edit. This separate fixture-only oracle proves
 * that the final user-facing summary reports the same three verified outcomes
 * instead of re-guessing a different root cause after context compaction.
 */
export function getMdViewerFinalSummaryGaps(summary: string): string[] {
  const text = String(summary || "").trim();
  if (!text) return ["final summary missing"];
  const gaps: string[] = [];
  const describesInitialTab =
    /(?:initial|pristine|untouched|blank|empty|初始|空白|未命名)/i.test(text) &&
    /(?:replace|reuse|remove|替换|复用|移除)/i.test(text) &&
    /(?:open|load|打开|载入|文件)/i.test(text);
  if (!describesInitialTab) {
    gaps.push("final summary omits the pristine initial-tab replacement");
  }

  const describesProgrammaticLoadBoundary =
    /(?:setValue|programmatic|load|程序性|程序化|载入|加载)/i.test(text) &&
    /(?:\binput\b|isDirty|dirty|auto[-_ ]?save|脏|自动保存)/i.test(text) &&
    /(?:no longer|without|remove|avoid|clean|不再|移除|避免|保持.{0,6}(?:干净|未修改))/i.test(text);
  if (!describesProgrammaticLoadBoundary) {
    gaps.push("final summary omits the programmatic-load dirty/autosave boundary");
  }

  if (!/save_file_content/i.test(text) || !/\bfilePath\b/.test(text)) {
    gaps.push("final summary omits the active filePath save contract");
  }
  return gaps;
}

function normalizedPath(value: unknown): string {
  return String(value || "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .toLowerCase();
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((item) => String(item || "").trim()).filter(Boolean)
    : [];
}

function intersects(left: Iterable<string>, right: Set<string>): boolean {
  for (const value of left) {
    if (right.has(value)) return true;
  }
  return false;
}

function pathsMatch(left: unknown, right: string): boolean {
  return normalizedPath(left) === normalizedPath(right);
}

function combinedChangeText(change: MdViewerCandidate["changes"][number]): string {
  return [
    change.text,
    change.expectedOutcome,
    ...stringList(change.relationships),
  ].filter(Boolean).join("\n");
}

function combinedValidationText(validation: MdViewerCandidate["validations"][number]): string {
  return [
    validation.expectedOutcome,
    JSON.stringify(validation.primitive || {}),
  ].filter(Boolean).join("\n");
}

function evidenceRefsForTarget(candidate: MdViewerCandidate, target: string): Set<string> {
  return new Set(candidate.evidence
    .filter((entry) => pathsMatch(entry.target, target))
    .map((entry) => String(entry.id || "").trim())
    .filter(Boolean));
}

function evidenceRefsForTargetMatching(
  candidate: MdViewerCandidate,
  target: string,
  statementPattern: RegExp,
): Set<string> {
  return new Set(candidate.evidence
    .filter((entry) => pathsMatch(entry.target, target) && statementPattern.test(entry.statement))
    .map((entry) => String(entry.id || "").trim())
    .filter(Boolean));
}

function orderedChainIncludesTargets(input: {
  chainRefs: string[];
  first: Set<string>;
  second: Set<string>;
}): boolean {
  const firstIndex = input.chainRefs.findIndex((reference) => input.first.has(reference));
  if (firstIndex < 0) return false;
  return input.chainRefs.slice(firstIndex + 1).some((reference) => input.second.has(reference));
}

function diagnosisIsBoundToOwner(input: {
  diagnosis: MdViewerCandidate["diagnoses"][number];
  ownerEvidenceRefs: Set<string>;
}): boolean {
  if (input.diagnosis.certainty === "hypothesis") return false;
  if (!intersects(input.diagnosis.evidenceRefs, input.ownerEvidenceRefs)) return false;
  return input.diagnosis.certainty !== "inferred" ||
    intersects(input.diagnosis.chainRefs, input.ownerEvidenceRefs);
}

function decisionPreservesOwner(input: {
  decision: MdViewerCandidate["decisions"][number];
  ownerEvidenceRefs: Set<string>;
  diagnosisGoalRefs: Set<string>;
  ownerTextPattern?: RegExp;
}): boolean {
  return input.decision.disposition === "preserve" &&
    intersects(input.decision.evidenceRefs, input.ownerEvidenceRefs) &&
    intersects(input.decision.goalRefs, input.diagnosisGoalRefs) &&
    (!input.ownerTextPattern || input.ownerTextPattern.test(input.decision.text));
}

function isRequiredValidation(validation: MdViewerCandidate["validations"][number]): boolean {
  const primitive = validation.primitive as { acceptance?: unknown } | null;
  return validation.blocking === true || primitive?.acceptance === "required";
}

function validationInteractionTargets(validation: MdViewerCandidate["validations"][number]): string[] {
  const primitive = validation.primitive as {
    actions?: Array<{ target?: unknown }>;
    assertions?: Array<{ target?: unknown }>;
  } | null;
  return [
    ...(Array.isArray(primitive?.actions) ? primitive.actions : []),
    ...(Array.isArray(primitive?.assertions) ? primitive.assertions : []),
  ].map((entry) => String(entry?.target || "").trim()).filter(Boolean);
}

function browserUsesExecutableNativeMock(validation: MdViewerCandidate["validations"][number]): boolean {
  const primitive = validation.primitive as {
    actions?: Array<{ kind?: unknown; target?: unknown }>;
  } | null;
  const actions = Array.isArray(primitive?.actions) ? primitive.actions : [];
  return actions.some((action) => {
    const actionText = `${String(action?.kind || "")} ${String(action?.target || "")}`;
    return /(?:mock|stub|intercept|spy|harness|fixture|__tauri__|__tauri_internal|模拟|桩|拦截|测试桥)/i.test(actionText) &&
      /(?:tauri|invoke|save_file_content|dialog|file.?picker|原生|保存命令|文件对话框)/i.test(actionText);
  });
}

function finiteCommandUsesNativeHarness(validation: MdViewerCandidate["validations"][number]): boolean {
  const primitive = validation.primitive as { kind?: unknown; command?: unknown } | null;
  if (primitive?.kind !== "finite_command") return false;
  const text = combinedValidationText(validation);
  return /(?:test|spec|mock|stub|harness|fixture|测试|模拟|桩)/i.test(text) &&
    /(?:tauri|invoke|save_file_content|dialog|file.?picker|原生|保存命令|文件对话框)/i.test(text);
}

function validationUsesExecutableNativeSurface(
  validation: MdViewerCandidate["validations"][number],
): boolean {
  const primitive = validation.primitive as { kind?: unknown } | null;
  if (primitive?.kind === "desktop_interaction") return true;
  if (primitive?.kind === "browser_interaction") return browserUsesExecutableNativeMock(validation);
  return finiteCommandUsesNativeHarness(validation);
}

function validationExercisesOpenWithoutEditBoundary(
  validation: MdViewerCandidate["validations"][number],
): boolean {
  const text = combinedValidationText(validation);
  return /(?:\bopen\b|load|打开|载入)/i.test(text) &&
    /(?:without\s+(?:an?\s+)?edit|no\s+edit|programmatic|setValue|auto[-_ ]?save|scheduleAutoSave|timer|wait|5\s*(?:s|sec|second)|未编辑|不编辑|程序性|自动保存|等待)/i.test(text) &&
    /(?:dialog|save_file_content|invoke|save\s+call|弹窗|对话框|保存调用|命令调用)/i.test(text);
}

/**
 * Fixture-specific semantic oracle for the MD Viewer incident. Runtime quality
 * policy belongs in production; this helper only states this fixture's known
 * source owners, causal boundary, command contract, and executable acceptance.
 */
export function getMdViewerTypedPlanGaps(candidate: MdViewerCandidate | null | undefined): string[] {
  if (!candidate) return ["typed candidate missing"];
  const gaps: string[] = [];
  const editorEvidence = evidenceRefsForTarget(candidate, OWNER_PATHS.editor);
  const callerEvidence = evidenceRefsForTarget(candidate, OWNER_PATHS.caller);
  const handlerEvidence = evidenceRefsForTarget(candidate, OWNER_PATHS.handler);
  const initialTabEvidence = evidenceRefsForTargetMatching(
    candidate,
    OWNER_PATHS.caller,
    /(?:initialFile|pristine|untouched|blank|empty|未命名|初始|空白)[\s\S]*(?:openFiles|activeFiles|append|push|追加|并存)|(?:openFiles|activeFiles|append|push|追加|并存)[\s\S]*(?:initialFile|pristine|untouched|blank|empty|未命名|初始|空白)/i,
  );
  const callerCommandEvidence = evidenceRefsForTargetMatching(
    candidate,
    OWNER_PATHS.caller,
    /save_file_content[\s\S]*file_path|file_path[\s\S]*save_file_content/i,
  );
  const handlerCommandEvidence = evidenceRefsForTargetMatching(
    candidate,
    OWNER_PATHS.handler,
    /save_file_content[\s\S]*filePath|filePath[\s\S]*save_file_content/,
  );

  for (const [label, refs] of [
    ["editor", editorEvidence],
    ["caller", callerEvidence],
    ["handler", handlerEvidence],
  ] as const) {
    if (refs.size === 0) gaps.push(`${label} owner evidence missing`);
  }
  if (callerCommandEvidence.size === 0) gaps.push("caller command-contract evidence missing");
  if (handlerCommandEvidence.size === 0) gaps.push("handler command-contract evidence missing");
  if (initialTabEvidence.size === 0) gaps.push("pristine initial-tab evidence missing");

  const initialTabDiagnoses = candidate.diagnoses.filter((diagnosis) =>
    diagnosisIsBoundToOwner({ diagnosis, ownerEvidenceRefs: initialTabEvidence }) &&
    /(?:initial|pristine|untouched|blank|empty|unsaved|初始|空白|未保存|未命名)/i.test(diagnosis.text) &&
    /(?:openFiles|append|push|replace|coexist|并存|追加|替换)/i.test(diagnosis.text)
  );
  const initialTabDiagnosisIds = new Set(initialTabDiagnoses.map((diagnosis) => diagnosis.id));
  if (initialTabDiagnoses.length === 0) gaps.push("initial-tab diagnosis is not evidence-bound");
  const initialTabChange = candidate.changes.find((change) => {
    const text = combinedChangeText(change);
    return pathsMatch(change.targetRef, OWNER_PATHS.caller) &&
      change.operation === "modify" &&
      intersects(change.evidenceRefs, initialTabEvidence) &&
      intersects(change.diagnosisRefs, initialTabDiagnosisIds) &&
      /(?:initial|pristine|untouched|blank|empty|unsaved|初始|空白|未保存|未命名)/i.test(text) &&
      /(?:openFiles|replace|instead\s+of\s+append|替换|不再追加)/i.test(text);
  });
  if (!initialTabChange) {
    gaps.push("pristine initial-tab replacement is not bound to its diagnosis and evidence");
  }

  const tabsRemainCanonical = candidate.decisions.some((decision) =>
    decision.disposition === "preserve" &&
    intersects(decision.evidenceRefs, initialTabEvidence) &&
    intersects(decision.goalRefs, new Set(initialTabDiagnoses.flatMap((diagnosis) => diagnosis.goalRefs))) &&
    /(?:\btabs?\b|tab[-_ ]?title|标签页|页签|选项卡)/i.test(decision.text) &&
    /(?:unsaved|edited|dirty|title|未保存|已编辑|脏|标题|命名)/i.test(decision.text) &&
    /(?:keep|retain|remain|canonical|sole|single|only|保留|继续|仍|唯一|仅|只)/i.test(decision.text)
  );
  if (!tabsRemainCanonical) gaps.push("edited unsaved-tab preserve decision missing");

  const causalDiagnosis = candidate.diagnoses.find((diagnosis) => {
    if (diagnosis.certainty !== "inferred") return false;
    if (!intersects(diagnosis.evidenceRefs, editorEvidence) ||
        !intersects(diagnosis.evidenceRefs, callerEvidence)) return false;
    if (!orderedChainIncludesTargets({
      chainRefs: diagnosis.chainRefs,
      first: editorEvidence,
      second: callerEvidence,
    })) return false;
    return /setValue/i.test(diagnosis.text) &&
      /(?:dispatchEvent|\binput\b)/i.test(diagnosis.text) &&
      /isDirty/i.test(diagnosis.text) &&
      /(?:scheduleAutoSave|auto[-_ ]?save|自动保存)/i.test(diagnosis.text);
  });
  if (!causalDiagnosis) {
    gaps.push("editor-to-main inferred autosave causal chain missing");
  } else {
    const causalGoalRefs = new Set(causalDiagnosis.goalRefs);
    const editorChange = candidate.changes.some((change) =>
      pathsMatch(change.targetRef, OWNER_PATHS.editor) &&
      intersects(change.evidenceRefs, editorEvidence) &&
      change.diagnosisRefs.includes(causalDiagnosis.id)
    );
    const editorPreserve = candidate.decisions.some((decision) =>
      decisionPreservesOwner({
        decision,
        ownerEvidenceRefs: editorEvidence,
        diagnosisGoalRefs: causalGoalRefs,
        ownerTextPattern: /(?:editor|setValue|input|程序性|编辑器)/i,
      })
    );
    if (!editorChange && !editorPreserve) {
      gaps.push("editor owner has no evidence-bound change or preserve decision");
    }
  }

  const mismatchDiagnosis = candidate.diagnoses.find((diagnosis) => {
    if (diagnosis.certainty !== "inferred") return false;
    if (!intersects(diagnosis.evidenceRefs, callerCommandEvidence) ||
        !intersects(diagnosis.evidenceRefs, handlerCommandEvidence)) return false;
    if (!orderedChainIncludesTargets({
      chainRefs: diagnosis.chainRefs,
      first: callerCommandEvidence,
      second: handlerCommandEvidence,
    })) return false;
    return /save_file_content/.test(diagnosis.text) &&
      /file_path/.test(diagnosis.text) &&
      /filePath/.test(diagnosis.text) &&
      /(?:mismatch|camel|argument|payload|key|不匹配|参数|载荷|键|命名)/i.test(diagnosis.text);
  });
  if (!mismatchDiagnosis) gaps.push("confirmed file_path-to-filePath mismatch diagnosis missing");

  const mismatchChange = mismatchDiagnosis
    ? candidate.changes.find((change) => {
        const text = combinedChangeText(change);
        return pathsMatch(change.targetRef, OWNER_PATHS.caller) &&
          change.operation === "modify" &&
          change.diagnosisRefs.includes(mismatchDiagnosis.id) &&
          intersects(change.evidenceRefs, callerCommandEvidence) &&
          intersects(change.evidenceRefs, handlerCommandEvidence) &&
          /file_path/.test(text) &&
          /filePath/.test(text);
      })
    : undefined;
  if (!mismatchChange) gaps.push("confirmed command mismatch is not assigned to the caller change");

  const handlerMutated = candidate.changes.some((change) =>
    pathsMatch(change.targetRef, OWNER_PATHS.handler) && change.operation !== "preserve"
  );
  if (handlerMutated) gaps.push("command handler is mutated instead of preserving its external contract");
  if (mismatchDiagnosis) {
    const handlerPreserved = candidate.decisions.some((decision) =>
      decisionPreservesOwner({
        decision,
        ownerEvidenceRefs: handlerEvidence,
        diagnosisGoalRefs: new Set(mismatchDiagnosis.goalRefs),
        ownerTextPattern: /(?:main\.rs|rust|backend|handler|command|interface|后端|处理器|命令|接口)/i,
      })
    );
    if (!handlerPreserved) gaps.push("command handler preserve decision is not evidence-bound");
  }

  const requiredValidations = candidate.validations.filter(isRequiredValidation);
  const requiredInteractionTargets = requiredValidations
    .flatMap(validationInteractionTargets)
    .map((target) => target.toLowerCase());
  const forbiddenSelectors = [...FORBIDDEN_REQUIRED_VALIDATION_TARGETS].filter((selector) =>
    requiredInteractionTargets.some((target) => target.includes(selector))
  );
  if (forbiddenSelectors.length > 0) {
    gaps.push(`required validation uses nonexistent selector: ${forbiddenSelectors.join(",")}`);
  }

  if (mismatchChange) {
    const mismatchValidations = requiredValidations.filter((validation) =>
      validation.changeRefs.includes(mismatchChange.id)
    );
    for (const validation of mismatchValidations) {
      const primitive = validation.primitive as { kind?: unknown } | null;
      if (primitive?.kind === "browser_interaction" && !browserUsesExecutableNativeMock(validation)) {
        gaps.push(`browser validation ${validation.id} lacks an executable native mock`);
      }
    }
    const executableNativeValidations = mismatchValidations.filter(validationUsesExecutableNativeSurface);
    if (executableNativeValidations.length === 0) {
      gaps.push("native save contract lacks desktop interaction or executable mock validation");
    } else if (!executableNativeValidations.some(validationExercisesOpenWithoutEditBoundary)) {
      gaps.push("native validation does not exercise open-without-edit autosave behavior");
    }
  }

  if (causalDiagnosis) {
    const causalChangeIds = new Set(candidate.changes
      .filter((change) => change.diagnosisRefs.includes(causalDiagnosis.id))
      .map((change) => change.id));
    if (causalChangeIds.size === 0 || !requiredValidations.some((validation) =>
      intersects(validation.changeRefs, causalChangeIds)
    )) {
      gaps.push("autosave causal change lacks a required validation edge");
    }
  }

  return Array.from(new Set(gaps));
}

function sectionContainsNode(
  markdown: string,
  heading: RegExp,
  nodePattern: RegExp,
): boolean {
  const lines = String(markdown || "").replace(/\r\n?/g, "\n").split("\n");
  const start = lines.findIndex((line) => heading.test(line));
  if (start < 0) return false;
  const section: string[] = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^##\s+/.test(lines[index] || "")) break;
    section.push(lines[index] || "");
  }
  return nodePattern.test(section.join("\n"));
}

/** Markdown is a review projection only; these checks intentionally cover
 * readability/structure and never infer source truth from Evidence prose. */
export function getMdViewerReadablePlanGaps(markdown: string): string[] {
  const plan = String(markdown || "").trim();
  const gaps: string[] = [];
  if (!/^#\s+(?:Plan|计划)\b/im.test(plan)) gaps.push("readable Plan title missing");
  if (!sectionContainsNode(plan, /^##\s+(?:诊断|Diagnosis|Root Cause)/i, /\[R\d+\b/i)) {
    gaps.push("readable diagnosis section missing");
  }
  if (!sectionContainsNode(plan, /^##\s+(?:关键改动|改动|Changes?|Key Changes?)/i, /\[C\d+\b/i)) {
    gaps.push("readable change section missing");
  }
  if (!sectionContainsNode(plan, /^##\s+(?:测试方案|验证|Validations?|Tests?)/i, /\[V\d+\b/i)) {
    gaps.push("readable validation section missing");
  }
  return gaps;
}
