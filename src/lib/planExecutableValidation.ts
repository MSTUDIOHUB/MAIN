import { getReviewablePlanArtifacts } from "./planApprovalIdentity";
import {
  extractShellCommandsFromText,
  hasConcreteAutomatedPlanValidationAssertion,
  isFinitePlanValidationCommand,
  normalizeRuntimePlanSectionHeadings,
  projectPlanTaskValidationPrimitives,
  type PlanArtifact,
  type PlanTask,
} from "./workflowModels";
import { isAcceptanceCapableValidationSpec } from "./validationContract";

export const EXECUTABLE_PLAN_VALIDATION_MISSING_REASON =
  "executable_validation_task_missing" as const;

const PLAN_VALIDATION_SECTION_RE =
  /^(?:(?:目标\s*与\s*)?(?:测试方案|测试计划|测试场景|验证方案|验证标准|验证方式|验收标准|验收)|(?:Goals?\s+and\s+)?(?:Test Plan|Testing|Tests?|Validation|Acceptance(?: Criteria)?))(?:\s*(?:[（(].*[）)]|[:：—-]|与).*)?$/i;
function stripPlanListSyntax(line: string): string {
  return String(line || "")
    .replace(/^\s*(?:[-*]\s+(?:\[[ xX]\]\s+)?|\d+[.)、:：-]\s+)/, "")
    .replace(/^\s*\|/, "")
    .replace(/\|\s*$/, "")
    .replace(/\*\*/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function collectValidationSectionLines(content: string): string[] {
  const lines: string[] = [];
  let inSection = false;
  let sectionLevel = 0;
  for (const rawLine of normalizeRuntimePlanSectionHeadings(content).split(/\r?\n/)) {
    const heading = rawLine.trim().match(/^(#{1,6})\s+(.+?)\s*$/);
    if (heading) {
      const level = heading[1]?.length || 0;
      const headingText = (heading[2] || "")
        .replace(/\*\*/g, "")
        .replace(/^\d+[.)、]\s*/, "")
        .trim();
      if (inSection && level > sectionLevel) {
        lines.push(headingText);
        continue;
      }
      if (inSection && level <= sectionLevel) inSection = false;
      if (!inSection && level > 1 && PLAN_VALIDATION_SECTION_RE.test(headingText)) {
        inSection = true;
        sectionLevel = level;
      }
      continue;
    }
    if (!inSection) continue;
    const normalized = stripPlanListSyntax(rawLine);
    if (normalized) lines.push(normalized);
  }
  return lines;
}

export function findPlanValidationSectionHeadingLineIndex(content: string): number {
  const lines = String(content || "").split(/\r?\n/);
  return lines.findIndex((line) => {
    const heading = line.trim().match(/^(#{2,6})\s+(.+?)\s*$/);
    if (!heading) return false;
    const headingText = (heading[2] || "")
      .replace(/\*\*/g, "")
      .replace(/^\d+[.)、]\s*/, "")
      .trim();
    return PLAN_VALIDATION_SECTION_RE.test(headingText);
  });
}

export function planArtifactRequiresExecutableValidation(artifact: PlanArtifact): boolean {
  const validationLines = collectValidationSectionLines(artifact.content);
  if (validationLines.length === 0) return false;

  // An execution Plan promises a runnable implementation transaction, so any
  // validation section in plan.md must project to an executable task. Earlier
  // design/requirements artifacts describe architecture and acceptance intent;
  // prose such as sample-data checks is reviewable before the concrete command
  // surface exists. Preserve explicit commands when the author already supplied
  // them, but do not make every design.md unreviewable merely for naming a
  // validation strategy.
  if (artifact.kind === "plan") return true;
  return extractShellCommandsFromText(validationLines.join("\n")).some((command) =>
    isFinitePlanValidationCommand(command)
  ) || hasConcreteAutomatedPlanValidationAssertion(validationLines.join("\n"));
}

export function isExecutablePlanValidationTask(task: PlanTask): boolean {
  return projectPlanTaskValidationPrimitives(task).some(
    isAcceptanceCapableValidationSpec,
  );
}

export interface PlanExecutableValidationAssessment {
  requiresExecutableValidation: boolean;
  executableValidationTaskCount: number;
  missing: boolean;
  reason: typeof EXECUTABLE_PLAN_VALIDATION_MISSING_REASON | null;
}

export function assessPlanExecutableValidation(input: {
  planArtifacts: PlanArtifact[];
  executionPlanTasks: PlanTask[];
}): PlanExecutableValidationAssessment {
  const reviewableArtifacts = getReviewablePlanArtifacts(input.planArtifacts);
  const requiresExecutableValidation = reviewableArtifacts.some(
    planArtifactRequiresExecutableValidation,
  );
  const executableValidationTaskCount = input.executionPlanTasks.filter(
    isExecutablePlanValidationTask,
  ).length;
  const missing = requiresExecutableValidation && executableValidationTaskCount === 0;
  return {
    requiresExecutableValidation,
    executableValidationTaskCount,
    missing,
    reason: missing ? EXECUTABLE_PLAN_VALIDATION_MISSING_REASON : null,
  };
}
