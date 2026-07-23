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

function getSaveCommandPayloads(source: string): string[] {
  const payloads: string[] = [];
  const pattern = /invoke\(\s*["']save_file_content["']\s*,\s*\{([\s\S]*?)\}\s*\)/g;
  for (const match of source.matchAll(pattern)) {
    payloads.push(String(match[1] || ""));
  }
  return payloads;
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
  const toolbarRendersDuplicateFilename =
    /\bid\s*=\s*["']file-path["']/.test(sources.toolbar);
  if (toolbarRendersDuplicateFilename) {
    gaps.push("src/components/toolbar.js still renders the redundant #file-path filename label");
  }

  const callerSetEditorValue = extractBracedBody(
    sources.caller,
    /\bfunction\s+setEditorValue\s*\([^)]*\)\s*/,
  );
  const patchedSetValue = extractBracedBody(
    sources.editor,
    /\beditor\.setValue\s*=\s*function\s*\([^)]*\)\s*/,
  );
  const callerUsesPatchedSetValue = /\.setValue\s*\(/.test(callerSetEditorValue);
  const patchedSetValueDispatchesInput =
    /dispatchEvent\s*\(\s*new\s+Event\s*\(\s*["']input["']/.test(patchedSetValue);
  if (callerUsesPatchedSetValue && patchedSetValueDispatchesInput) {
    gaps.push("src/main.js and src/components/editor.js still route programmatic file loading through synthetic input and can schedule autosave");
  }

  const savePayloads = getSaveCommandPayloads(sources.caller);
  const handleSaveBody = extractBracedBody(
    sources.caller,
    /\basync\s+function\s+handleSaveFile\s*\([^)]*\)\s*/,
  );
  const saveAsBody = extractBracedBody(
    sources.caller,
    /\basync\s+function\s+saveAsFile\s*\([^)]*\)\s*/,
  );
  if (savePayloads.length === 0) {
    gaps.push("src/main.js save_file_content caller payloads are missing");
  } else if (savePayloads.some((payload) =>
    /\bfile_path\s*:/.test(payload) ||
    !/\bfilePath\s*(?::|,|$)/m.test(payload)
  )) {
    gaps.push("src/main.js save_file_content caller payloads must use Tauri's external filePath key");
  }
  const activePathAlias = /\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*[^;]*\bfile\.path\b/.exec(
    handleSaveBody,
  )?.[1] || null;
  const existingFileSaveUsesActivePath =
    /\bfilePath\s*:\s*file\.path\b/.test(handleSaveBody) ||
    Boolean(
      activePathAlias &&
      new RegExp(
        `\\bfilePath\\s*(?::\\s*${activePathAlias}\\b|,)`,
      ).test(handleSaveBody),
    );
  if (!existingFileSaveUsesActivePath) {
    gaps.push("src/main.js existing-file save must pass the active file.path as filePath");
  }
  if (
    !/\b(?:const|let)\s+filePath\s*=\s*await\s+save\s*\(/.test(saveAsBody) ||
    !/\bfilePath\s*(?::\s*filePath)?\s*,/m.test(saveAsBody) ||
    !/\bactiveFiles\s*\[\s*activeTab\s*\]\.path\s*=\s*filePath\b/.test(saveAsBody) ||
    /\bfilePath\s*:\s*content\b/.test(saveAsBody)
  ) {
    gaps.push("src/main.js Save As must keep the selected dialog path, pass it as filePath, and persist that same path");
  }

  const handleOpenBody = extractBracedBody(
    sources.caller,
    /\basync\s+function\s+handleOpenFile\s*\([^)]*\)\s*/,
  );
  if (
    !/\bopenDialog\s*\(/.test(handleOpenBody) ||
    /invoke\s*\(\s*["']open_file_dialog["']/.test(handleOpenBody)
  ) {
    gaps.push("src/main.js toolbar Open must keep the plugin-dialog boundary instead of invoking the event-emitting backend dialog command");
  }

  if (
    !/\bfn\s+save_file_content\s*\([^)]*\bfile_path\s*:/s.test(sources.handler)
  ) {
    gaps.push("src-tauri/src/main.rs Rust save_file_content handler contract is missing");
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
  const toolbarEvidence = evidenceRefsForTarget(candidate, OWNER_PATHS.toolbar);
  const editorEvidence = evidenceRefsForTarget(candidate, OWNER_PATHS.editor);
  const callerEvidence = evidenceRefsForTarget(candidate, OWNER_PATHS.caller);
  const handlerEvidence = evidenceRefsForTarget(candidate, OWNER_PATHS.handler);
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
    ["toolbar", toolbarEvidence],
    ["editor", editorEvidence],
    ["caller", callerEvidence],
    ["handler", handlerEvidence],
  ] as const) {
    if (refs.size === 0) gaps.push(`${label} owner evidence missing`);
  }
  if (callerCommandEvidence.size === 0) gaps.push("caller command-contract evidence missing");
  if (handlerCommandEvidence.size === 0) gaps.push("handler command-contract evidence missing");

  const toolbarDiagnoses = candidate.diagnoses.filter((diagnosis) =>
    diagnosisIsBoundToOwner({ diagnosis, ownerEvidenceRefs: toolbarEvidence })
  );
  const toolbarDiagnosisIds = new Set(toolbarDiagnoses.map((diagnosis) => diagnosis.id));
  if (toolbarDiagnoses.length === 0) gaps.push("toolbar diagnosis is not evidence-bound");
  const toolbarChange = candidate.changes.find((change) => {
    const text = combinedChangeText(change);
    return pathsMatch(change.targetRef, OWNER_PATHS.toolbar) &&
      change.operation !== "preserve" &&
      intersects(change.evidenceRefs, toolbarEvidence) &&
      intersects(change.diagnosisRefs, toolbarDiagnosisIds) &&
      /(?:file\s*name|filename|document\s+name|file[-_ ]?path|文件名|文档名|文件路径)/i.test(text) &&
      /(?:remove|delete|hide|stop\s+(?:displaying|rendering)|no\s+longer|single|sole|移除|删除|隐藏|停止(?:显示|渲染)|不再|唯一)/i.test(text);
  });
  if (!toolbarChange) gaps.push("toolbar duplicate-name change is not bound to its diagnosis and evidence");

  const tabsRemainCanonical = candidate.decisions.some((decision) =>
    decision.disposition === "preserve" &&
    intersects(decision.evidenceRefs, new Set([...callerEvidence, ...toolbarEvidence])) &&
    intersects(decision.goalRefs, new Set(toolbarDiagnoses.flatMap((diagnosis) => diagnosis.goalRefs))) &&
    /(?:\btabs?\b|tab[-_ ]?title|标签页|页签|选项卡)/i.test(decision.text) &&
    /(?:filename|file\s+name|document\s+name|title|文件名|文档名|标题|命名)/i.test(decision.text) &&
    /(?:keep|retain|remain|canonical|sole|single|only|保留|继续|仍|唯一|仅|只)/i.test(decision.text)
  );
  if (!tabsRemainCanonical) gaps.push("tab filename ownership preserve decision missing");

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
