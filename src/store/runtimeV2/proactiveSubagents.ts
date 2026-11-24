import type { ProjectBaselineContext } from "../../lib/projectBaseline";
import { sha256Hex } from "../../lib/sha256";
import { isProjectBaselineForWorkspace } from "../../lib/workspaceAdmission";
import { runtimeV2EditorDiagnosticScope, type RuntimeV2ConsoleDiagnostic } from "../../lib/runtime-v2/editorConsoleEvidence";
import { runtimeV2DirectExecuteMutationTargets } from "../../lib/runtime-v2/validationReceipt";
import { extractExactReadFileWindow } from "../../lib/readFileWindow";
import { normalizeValidationWorkspaceCwd } from "../../lib/validationContract";
import {
  areRuntimeV2SubagentWriteScopesDisjoint as scopesDisjoint,
  deriveRuntimeV2PlanExecutionCoverage,
  deriveRuntimeV2PlanExecutionFrontier,
  runtimeV2SubagentStartHasRunway,
  type RuntimeV2DecisionInput,
  type RuntimeV2SubagentScopeCandidate,
  type TurnAggregateV1,
} from "../../lib/runtime-v2";
import { deriveRuntimeV2ExecutionContract } from "./executionContract";
import { resolveApprovedRuntimeV2WorkPlanFromAggregate } from "./workPlanAdapter";

type Decision = NonNullable<RuntimeV2DecisionInput["proactiveCollaboration"]>;

/** Distinct compiler/Shader targets can be investigated in parallel. Group
 * files that share an include or explicitly reference each other's types. */
function independentDiagnosticBranches(state: TurnAggregateV1) {
  const diagnostics = runtimeV2EditorDiagnosticScope(state)?.diagnostics || [];
  const files = new Map<string, RuntimeV2ConsoleDiagnostic>();
  for (const item of diagnostics) if (item.path && item.kind !== "runtime" && !files.has(item.path)) files.set(item.path, item);
  const windows = new Map<string, { version: string; text: string; includes: Set<string>; types: readonly string[] }>();
  for (const event of state.events) {
    if (event.type !== "tool.completed" || event.status !== "succeeded" || !event.modelContent) continue;
    const window = extractExactReadFileWindow(event.modelContent);
    const path = window && normalizeValidationWorkspaceCwd(window.metadata.path, state.turn.workspaceKey);
    const version = window?.metadata.contentVersion;
    if (!window || !version || !path || !files.has(path) || !event.evidence.some(item => item.kind === "source" && item.version === version)) continue;
    const known = windows.get(path);
    const previous = known?.version === version ? known : undefined;
    const text = window.content;
    const includes = new Set([...(previous?.includes ?? []), ...Array.from(text.matchAll(/^\s*#\s*include\s+["<]([^">]+)[">]/gm), match => match[1]!)]);
    const types = [...new Set([...(previous?.types ?? []), ...Array.from(text.matchAll(/\b(?:class|struct|interface|enum)\s+([a-zA-Z_]\w*)\b/g), match => match[1]!)])];
    windows.set(path, { version, text: `${previous?.text || ""}\n${text}`, includes, types });
  }
  const related = (left: string, right: string) => {
    if (files.get(left)?.kind !== files.get(right)?.kind) return false;
    const a = windows.get(left), b = windows.get(right);
    if (!a || !b) return true;
    return [...a.includes].some(include => b.includes.has(include)) ||
      a.types.some(type => new RegExp(`\\b${type}\\b`).test(b.text)) || b.types.some(type => new RegExp(`\\b${type}\\b`).test(a.text));
  };
  const groups: string[][] = [];
  for (const path of files.keys()) {
    const joined = groups.filter(group => group.some(other => related(path, other)));
    if (!joined.length) groups.push([path]);
    else {
      joined[0]!.push(path);
      for (const group of joined.slice(1)) {
        joined[0]!.push(...group);
        groups.splice(groups.indexOf(group), 1);
      }
    }
  }
  const committed = runtimeV2DirectExecuteMutationTargets(state);
  return groups.filter(group => !committed.length || group.some(path => scopesDisjoint([path], committed)))
    .map(group => ({ group, kind: files.get(group[0]!)?.kind, versioned: group.filter(path => windows.has(path)) }));
}

export function deriveProactiveCollaboration(input: {
  readonly state: TurnAggregateV1;
  readonly preference: RuntimeV2DecisionInput["subagentPreference"];
  readonly capacity: number;
  readonly requestMode: "parallel" | "serialized";
  readonly baseline?: ProjectBaselineContext | null;
  readonly workspace?: string | null;
  readonly lifecycleDeadlineAt?: number;
  readonly planningHasExecutableChoice?: boolean;
  /** Exact workspace targets from the verified approved Plan revision source. */
  readonly revisionTargetPaths?: readonly string[];
  readonly language?: "zh" | "en";
  readonly now: number;
}): Decision | undefined {
  const { state } = input;
  if (
    input.preference !== "preferred" || state.subagentRequirement === "required" ||
    state.run?.status !== "running" || state.planPurpose === "rules"
  ) return;
  if (
    state.objective.capabilityRestrictions?.includes("workspace_read") ||
    state.objective.approvalRequiredCapabilities?.includes("workspace_read")
  ) return { reason: "workspace_read_restricted" };
  if (input.requestMode === "serialized" || input.capacity <= 0) return { reason: "no_parallel_capacity" };
  if (!runtimeV2SubagentStartHasRunway(input)) return { reason: "insufficient_runway" };

  const runId = state.run.identity.runId;
  const jobs = state.subagents.filter(job => job.parentRunId === runId);
  const activeJobs = jobs.filter(job => job.status === "queued" || job.status === "running");
  if (activeJobs.length >= input.capacity) return { reason: "slots_in_use" };
  const attempts = new Set(state.events.flatMap(event => event.type === "command.scheduled" &&
    event.run.runId === runId && typeof event.command.payload.proactiveKey === "string"
    ? [event.command.payload.proactiveKey] : []));
  const approved = resolveApprovedRuntimeV2WorkPlanFromAggregate(state);
  const frontier = approved ? deriveRuntimeV2PlanExecutionFrontier(state) : null;
  const contract = state.strategy === "execute" ? deriveRuntimeV2ExecutionContract(state) : null;
  const ready = frontier?.steps.filter(step => step.status === "ready" && step.operation !== "preserve") || [];
  const writes = approved?.plan.draft.steps.filter(step => step.operation !== "preserve").flatMap(step => step.targets) ||
    contract?.changes.filter(change => change.operation !== "preserve").flatMap(change => change.targets) || [];
  const sourceVersions = new Map(state.evidence.flatMap(evidence => {
    const path = evidence.kind === "source" && evidence.version && normalizeValidationWorkspaceCwd(evidence.target, input.workspace || undefined);
    return path ? [[path, evidence.version] as const] : [];
  }));
  const exactReads = new Set(sourceVersions.keys());
  const hasValidation = approved?.plan.draft.validations.some(check => check.required && check.kind !== "advisory") ||
    !!contract?.validations.length;
  const validationInFlight = state.phase === "validating" &&
    Boolean(approved && deriveRuntimeV2PlanExecutionCoverage(state)?.missingRequiredValidationIndexes.length);
  const planning = state.strategy === "plan" && state.phase === "planning" && !approved;
  const candidates: RuntimeV2SubagentScopeCandidate[] = [];
  const add = (
    taskKind: "explore" | "review" | "validate",
    name: string,
    paths: readonly string[],
    objective: string,
  ) => {
    const allowedPaths = [...new Set(paths)].sort();
    if (!allowedPaths.length || allowedPaths.length > 24) return;
    const scopeVersion = allowedPaths.map(path => [path.toLowerCase(), sourceVersions.get(path) ?? input.baseline?.anchors.find(anchor => anchor.path === path)?.contentHash ?? null]);
    const scopeKey = `proactive:${taskKind}:${sha256Hex(JSON.stringify(scopeVersion))}`;
    const proactiveKey = sha256Hex(JSON.stringify([runId, approved?.plan.digest || contract?.revision || null, scopeKey]));
    if (attempts.has(proactiveKey) || jobs.some(job => job.scopeKey === scopeKey) ||
      [...activeJobs, ...jobs.filter(job => !job.proactiveKey && job.taskKind === taskKind)].some(job => !scopesDisjoint(job.allowedPaths, allowedPaths))) return;
    candidates.push({
      scopeKey, proactiveKey, taskKind, accessMode: "read", name, allowedPaths, objective,
      successCriteria: "Return only actionable findings tied to exact file evidence, with any uncertainty stated.",
    });
  };

  if (planning && input.workspace && input.revisionTargetPaths?.length) {
    add("review", input.language === "zh" ? "变更文件审查" : "Review changed plan targets",
      input.revisionTargetPaths.filter(path => exactReads.has(path)),
      "Inspect the current assigned files. Report concrete findings for the plan revision, including what to preserve and which planned checks the findings affect. The parent prepares the remaining plan independently.");
  }
  const directExecute = state.strategy === "execute" && !approved && !contract &&
    (state.phase === "observing" || state.phase === "acting" || state.phase === "validating");
  if (directExecute) {
    const [parent, ...branches] = independentDiagnosticBranches(state);
    for (const branch of branches) {
      if (!parent || branch.versioned.length !== branch.group.length || !scopesDisjoint(parent.group, branch.group)) continue;
      const shader = branch.kind === "shader_import";
      const name = shader ? input.language === "zh" ? "Shader 报错调查" : "Investigate Shader diagnostics"
        : input.language === "zh" ? "C# 报错调查" : "Investigate C# diagnostics";
      add("review", name, branch.group,
        `Trace the reported ${shader ? "Shader import" : "C# compiler"} errors in ${branch.group.join(", ")}. Identify the exact cause and minimal compatible fix supported by the admitted source and project version. Return paths, symbols or includes, and the Editor check that should confirm the fix. The parent handles ${parent.group.join(", ")}.`);
    }
  }
  const baseline = input.baseline;
  if (isProjectBaselineForWorkspace(baseline, input.workspace || "")) {
    const metadata = baseline.anchors.filter(anchor => (anchor.kind === "manifest" || anchor.kind === "config") && exactReads.has(anchor.path));
    const configPaths = metadata.map(anchor => anchor.path);
    if (planning && (input.planningHasExecutableChoice || state.objective.acceptanceEvidenceRequirements?.some(Boolean)) &&
      [...exactReads].some(path => scopesDisjoint([path], configPaths))) {
      add("explore", input.language === "zh" ? "验收前置条件调查" : "Explore verification prerequisites", configPaths,
        "Identify the project version, test framework and verification prerequisites supported by these files while the parent designs the changes.");
    } else if (hasValidation && (ready.length > 0 || (!approved && writes.length > 0 && state.phase !== "validating"))) {
      add("validate", input.language === "zh" ? "验收准备" : "Verification preparation", configPaths.filter(path => scopesDisjoint([path], writes)),
        "Check test prerequisites and existing configuration for the declared validation. Return concrete requirements for the parent; do not run the validation.");
    } else if (directExecute) {
      // Admission already versioned these sources. A child can re-read them
      // while the parent works from independent source evidence.
      const { runtimes, packages, packageManagers, scripts } = baseline.facts;
      const factHashes = new Map([...runtimes, ...(packages || []), ...packageManagers, ...scripts].map(({ provenance }) =>
        [provenance.path, provenance.contentHash] as const));
      const assignedPaths = baseline.anchors.filter(anchor =>
        configPaths.includes(anchor.path) || (anchor.kind !== "rule" && anchor.contentHash &&
          factHashes.get(anchor.path) === anchor.contentHash)).map(anchor => anchor.path);
      if ([...exactReads].some(path => !baseline.anchors.some(anchor => anchor.path === path) && scopesDisjoint([path], assignedPaths))) {
        add("explore", input.language === "zh" ? "版本与依赖调查" : "Inspect versions and dependencies", assignedPaths,
          "Read the assigned project configuration to confirm current runtime and dependency versions and verification prerequisites. Return concrete facts with sources while the parent continues independent source work.");
      }
    }
  }
  if (approved && frontier && (ready.length > 0 || validationInFlight)) {
    const otherWrites = frontier.steps.filter(step => step.status !== "completed" && step.operation !== "preserve").flatMap(step => step.targets);
    for (const step of frontier.steps) {
      if (step.status !== "completed" || step.operation === "preserve" || step.operation === "delete") continue;
      if (otherWrites.length > 0 && !scopesDisjoint(step.targets, otherWrites)) continue;
      add("review", input.language === "zh" ? "已提交改动审查" : "Review committed changes", step.targets,
        `Review the committed step against its intended outcome: ${approved.plan.draft.steps[step.stepIndex].expectedOutcome}. Identify concrete defects while the parent continues independent work.`);
    }
  }
  return candidates[0] ? { candidate: candidates[0] } : { reason: "no_independent_scope" };
}
