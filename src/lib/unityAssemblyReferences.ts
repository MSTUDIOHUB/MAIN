import type { ProjectBaselineContext } from "./projectBaseline";
import type { RuntimeV2UnityAssemblyReport } from "./runtime-v2/unityRepairLoop";
import { isProjectBaselineForWorkspace } from "./workspaceAdmission";

/** Unity reserves these four names for its predefined script compilation phases. */
const predefinedScriptAssemblies = new Set([
  "Assembly-CSharp",
  "Assembly-CSharp-Editor",
  "Assembly-CSharp-firstpass",
  "Assembly-CSharp-Editor-firstpass",
]);

export function isUnityPredefinedScriptAssembly(value: unknown): value is string {
  return typeof value === "string" && predefinedScriptAssemblies.has(value);
}

interface UnityPredefinedScriptReferenceIssue {
  readonly sourcePath: string;
  readonly ownerPath: string;
  readonly ownerName: string;
  readonly reference: string;
}

export function unityPredefinedScriptReferenceIssues(report: RuntimeV2UnityAssemblyReport): readonly UnityPredefinedScriptReferenceIssue[] {
  const issues = new Map<string, UnityPredefinedScriptReferenceIssue>();
  for (const { path, assembly } of report.sources) {
    if (assembly?.predefined !== false || typeof assembly.path !== "string" || !/\.asmdef$/i.test(assembly.path)) continue;
    for (const { reference, status } of assembly.references) {
      if (status !== "predefined" || !isUnityPredefinedScriptAssembly(reference)) continue;
      const key = JSON.stringify([assembly.path, reference]);
      if (!issues.has(key)) issues.set(key, { sourcePath: path, ownerPath: assembly.path, ownerName: assembly.name, reference });
    }
  }
  return [...issues.values()];
}

export function isWorkspaceUnityProject(baseline: ProjectBaselineContext | null | undefined, workspace: string): boolean {
  return isProjectBaselineForWorkspace(baseline, workspace) && baseline.facts.runtimes.some(fact =>
    (fact.name === "unity" || fact.name === "tuanjie") && fact.version &&
    fact.provenance.path === "ProjectSettings/ProjectVersion.txt");
}

function readAssemblyReferences(content: string): readonly unknown[] | null {
  try {
    const definition: { name?: unknown; references?: unknown } | null = JSON.parse(content.replace(/^\uFEFF/, ""));
    if (typeof definition?.name !== "string" || !definition.name.trim()) return null;
    if (definition.references == null) return [];
    return Array.isArray(definition.references) ? definition.references : null;
  } catch {
    return null;
  }
}

export function introducedUnityPredefinedReferences(previous: string | undefined, proposed: string): readonly string[] {
  const before = previous === undefined ? [] : readAssemblyReferences(previous);
  const after = readAssemblyReferences(proposed);
  if (!before || !after) return [];
  const existing = new Set(before);
  return [...new Set(after.filter(isUnityPredefinedScriptAssembly))].filter(reference => !existing.has(reference));
}
