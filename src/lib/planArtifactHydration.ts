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

const PLAN_ARTIFACT_PATHS = [
  ".MAIN/plans/requirements.md",
  ".MAIN/plans/design.md",
  ".MAIN/plans/tasks.md",
  ".MAIN/plans/bugfix.md",
] as const;

function artifactSortOrder(kind: PlanArtifactKind): number {
  switch (kind) {
    case "requirements": return 0;
    case "design": return 1;
    case "tasks": return 2;
    case "bugfix": return 3;
    default: return 9;
  }
}

export async function hydratePlanArtifactsFromReader(
  readPlanFile: PlanArtifactReader,
  language: "zh" | "en" = "zh",
  now = Date.now(),
): Promise<HydratedPlanArtifacts> {
  const artifacts: PlanArtifact[] = [];

  for (const path of PLAN_ARTIFACT_PATHS) {
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
