import test from "node:test";
import assert from "node:assert/strict";
import { createTsModuleLoader } from "./tsModuleLoader.mjs";

const { formatPlanSubmissionDiagnostic, formatPlanSubmissionDiagnostics, formatSavedPlanDraftForDisplay } = createTsModuleLoader()("src/lib/planDrafts.ts");
const diagnostic = { code: "plan_validation_not_required", fieldPath: "validations[0]", criterionIds: ["criterion-user-objective"], message: "WORK_PLAN_REJECTED backend diagnostic content", rawKind: "advisory", compiledKind: "advisory" };

for (const language of ["zh", "en"]) test(`${language}: display diagnostics localize the structured state without exposing raw backend details`, () => {
  const text = formatPlanSubmissionDiagnostic(diagnostic, language);
  assert.match(text, language === "zh" ? /^验证 1：需要可执行的验收方式/ : /^Validation 1: Provide an executable acceptance check/);
  for (const raw of [diagnostic.message, diagnostic.code, diagnostic.fieldPath, diagnostic.criterionIds[0], "WORK_PLAN_REJECTED"]) assert.equal(text.includes(raw), false, raw);
});

test("command normalization has a specific actionable localized explanation", () => {
  const value = { ...diagnostic, fieldPath: "validations[1]", rawKind: "finite_command", normalizationReason: "non_finite_command_downgraded_to_advisory" };
  assert.match(formatPlanSubmissionDiagnostic(value, "zh"), /^验证 2：该命令无法作为有限结束的验收命令/);
  assert.match(formatPlanSubmissionDiagnostic(value, "en"), /^Validation 2: This command is not a finite acceptance check/);
});

test("the saved Inspector draft displays four checks with only one readiness explanation", () => {
  const diagnostics = Array.from({ length: 4 }, (_, index) => ({ ...diagnostic, fieldPath: `validations[${index}]` }));
  const body = "# 计划\n\n检查场景对象、初始分数、胜利和重置。";
  const appendix = "\n\n## 待补全的执行验证\n\n此文档为可审核草稿，尚未形成可批准执行的计划。\n\n";
  const oldBullets = diagnostics.map(item => `- ${formatPlanSubmissionDiagnostic(item, "zh")}`).join("\n");
  const oldDraft = `${body}${appendix}${oldBullets}\n`;
  const result = formatSavedPlanDraftForDisplay(oldDraft, { diagnostics });
  assert.deepEqual(formatPlanSubmissionDiagnostics(diagnostics, "zh").length, 1);
  assert.ok(result.startsWith(body));
  assert.equal((result.match(/需要可执行的验收方式/g) || []).length, 1);
  assert.equal(formatSavedPlanDraftForDisplay(`${oldDraft}\n用户附注`, { diagnostics }), `${oldDraft}\n用户附注`);
});

for (const [code, chinese, english] of [
  ["plan_validation_missing", "部分验收条件", "Some acceptance criteria"],
  ["plan_change_criterion_missing", "具体改动步骤", "Complete the changes"],
  ["plan_collaboration_incomplete", "完成所要求的协作", "Complete the required collaboration"],
  ["plan_structure_invalid", "计划结构仍需补全", "Complete the plan structure"],
  ["plan_submission_compile_invalid", "计划结构仍需补全", "Complete the plan structure"],
  ["future_diagnostic", "计划结构仍需补全", "Complete the plan structure"],
]) test(`localized formatting handles ${code} without falling back to the backend message`, () => {
  const value = { ...diagnostic, code, fieldPath: "steps[0].dependsOn" };
  assert.ok(formatPlanSubmissionDiagnostic(value, "zh").includes(chinese));
  assert.ok(formatPlanSubmissionDiagnostic(value, "en").includes(english));
  assert.equal(formatPlanSubmissionDiagnostic(value, "zh").includes(value.message), false);
});
