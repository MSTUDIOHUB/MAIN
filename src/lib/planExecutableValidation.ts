import { getReviewablePlanArtifacts } from "./planApprovalIdentity";
import {
  isFinitePlanValidationCommand,
  normalizeRuntimePlanSectionHeadings,
  requiresPtyObservationForPlanCommand,
  type PlanArtifact,
  type PlanTask,
} from "./workflowModels";

export const EXECUTABLE_PLAN_VALIDATION_MISSING_REASON =
  "executable_validation_task_missing" as const;

const PLAN_VALIDATION_SECTION_RE =
  /^(?:(?:目标\s*与\s*)?(?:测试方案|测试计划|测试场景|验证方案|验证标准|验证方式|验收标准|验收)|(?:Goals?\s+and\s+)?(?:Test Plan|Testing|Tests?|Validation|Acceptance(?: Criteria)?))(?:\s*(?:[（(].*[）)]|[:：—-]|与).*)?$/i;
const VALIDATION_TASK_TEXT_RE =
  /(?:验证|测试|验收|检查|确认|构建|编译|lint|类型检查|回归|verify|validate|test|acceptance|check|build|compile|typecheck|type-check|regression)/i;
const VALIDATION_COMMAND_RE =
  /(?:\b(?:test|tests|testing|lint|typecheck|type-check|check|build|compile|clippy|pytest|vitest|jest|playwright|cypress)\b|tsc(?:\s|$)|cargo\s+(?:test|check|build|clippy)\b|go\s+test\b|swift\s+test\b|dotnet\s+test\b|mvn\s+test\b|gradle\w*\s+\S+)/i;

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
  return collectValidationSectionLines(artifact.content).length > 0;
}

export function isExecutablePlanValidationTask(task: PlanTask): boolean {
  const evidence = task.evidence || [];
  if (evidence.some((item) =>
    item.kind === "browser_dom" ||
    item.kind === "browser_screenshot" ||
    item.kind === "dev_server_url"
  )) {
    return true;
  }
  const commands = [
    ...(task.commands || []),
    ...evidence.filter((item) => item.kind === "cmd").map((item) => item.value),
  ].filter((value) => {
    const command = String(value || "").trim();
    return command && (
      isFinitePlanValidationCommand(command) ||
      requiresPtyObservationForPlanCommand(command)
    );
  });
  return commands.length > 0 && (
    VALIDATION_TASK_TEXT_RE.test(task.text) ||
    commands.some((command) => VALIDATION_COMMAND_RE.test(command))
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
