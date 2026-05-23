import { sanitizePlanArtifactContent } from "./sanitize";
import {
  detectPlanArtifactKind,
  extractPlanTasks,
  getPlanArtifactTitle,
  validatePlanArtifactContent,
  type PlanArtifact,
  type PlanArtifactKind,
  type PlanTask,
} from "./workflowModels";

export interface HydratedPlanArtifacts {
  artifacts: PlanArtifact[];
  tasks: PlanTask[];
  hasTasksArtifact: boolean;
}

export type PlanArtifactReader = (path: string) => Promise<string>;

export const PLAN_ARTIFACT_PATHS = [
  ".MAIN/plans/plan.md",
  ".MAIN/plans/requirements.md",
  ".MAIN/plans/design.md",
  ".MAIN/plans/tasks.md",
  ".MAIN/plans/bugfix.md",
] as const;

function artifactSortOrder(kind: PlanArtifactKind): number {
  switch (kind) {
    case "plan": return 0;
    case "requirements": return 1;
    case "design": return 2;
    case "tasks": return 3;
    case "bugfix": return 4;
    default: return 9;
  }
}

export async function hydratePlanArtifactsFromReader(
  readPlanFile: PlanArtifactReader,
  language: "zh" | "en" = "zh",
  now = Date.now(),
  options?: { availablePaths?: readonly string[] | null },
): Promise<HydratedPlanArtifacts> {
  const artifacts: PlanArtifact[] = [];
  const availablePaths = options?.availablePaths
    ? new Set(options.availablePaths.map((path) => path.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase()))
    : null;
  const candidatePaths = availablePaths
    ? PLAN_ARTIFACT_PATHS.filter((path) => {
        const normalized = path.replace(/^\.\//, "").toLowerCase();
        const fileName = normalized.split("/").pop() || normalized;
        return availablePaths.has(normalized) || availablePaths.has(fileName);
      })
    : PLAN_ARTIFACT_PATHS;

  for (const path of candidatePaths) {
    const kind = detectPlanArtifactKind(path);
    if (!kind) continue;

    let raw = "";
    try {
      raw = await readPlanFile(path);
    } catch {
      continue;
    }

    const content = sanitizePlanArtifactContent(raw);
    if (!content.trim()) continue;

    const validation = validatePlanArtifactContent(content, kind);
    if (!validation.ok) continue;

    artifacts.push({
      kind,
      path,
      title: getPlanArtifactTitle(kind, language),
      content,
      updatedAt: now + artifactSortOrder(kind),
    });
  }

  const taskArtifact = artifacts.find((artifact) => artifact.kind === "tasks" || artifact.kind === "bugfix");
  const tasks = taskArtifact ? extractPlanTasks(taskArtifact.content) : [];

  return {
    artifacts: artifacts.sort((a, b) => artifactSortOrder(a.kind) - artifactSortOrder(b.kind)),
    tasks,
    hasTasksArtifact: artifacts.some((artifact) => artifact.kind === "tasks" || artifact.kind === "bugfix"),
  };
}
