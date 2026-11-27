import type { ProjectBaselineContext } from "../../lib/projectBaseline";
import { sha256Hex } from "../../lib/sha256";
import { isProjectBaselineForWorkspace } from "../../lib/workspaceAdmission";
import { isRuntimeV2EditorDiagnosticRepair, runtimeV2EditorDiagnosticScope, type RuntimeV2ConsoleDiagnostic } from "../../lib/runtime-v2/editorConsoleEvidence";
import { isRuntimeV2FileVersion, runtimeV2DirectExecuteMutationTargets, runtimeV2WorkspaceChangeReceipts } from "../../lib/runtime-v2/validationReceipt";
import { referencedShaderInclude, unityCompilationTarget } from "../../lib/runtime-v2/unityCompilation";
import { runtimeV2UnityRepairContext } from "../../lib/runtime-v2/unityRepairLoop";
import { extractExactReadFileWindow, type ExactReadFileWindow } from "../../lib/readFileWindow";
import { normalizeValidationWorkspaceCwd } from "../../lib/validationContract";
import {
  areRuntimeV2SubagentWriteScopesDisjoint as scopesDisjoint,
  deriveRuntimeV2PlanExecutionCoverage,
  deriveRuntimeV2PlanExecutionFrontier,
  runtimeV2DelegationRequiresProposal,
  runtimeV2SubagentStartHasRunway,
  type RuntimeV2DecisionInput,
  type RuntimeV2OptionalDelegationScope,
  type TurnAggregateV1,
} from "../../lib/runtime-v2";
import { deriveRuntimeV2ExecutionContract } from "./executionContract";
import { RUNTIME_V2_SUBAGENT_MAX_SCOPE_PATHS } from "./executionSubagentCandidate";
import { PLAN_REVISION_PATH_OBSERVATION } from "./planRevisionEvidence";
import { resolveApprovedRuntimeV2WorkPlanFromAggregate } from "./workPlanAdapter";

type Decision = NonNullable<RuntimeV2DecisionInput["proactiveCollaboration"]>;

type SourceUnit = {
  path: string;
  declarations: Set<string>;
  identifiers: Set<string>;
  references: Set<string>;
};

type FileSnapshot = { readonly version: string; readonly evidenceId: string; readonly fullRead?: ExactReadFileWindow };

/** Discovery tool receipts can point to a file, but only an actual read or a
 * committed write can supply the byte version used in a delegation identity. */
function currentFileSnapshots(state: TurnAggregateV1, workspace: string, revisionTargets: readonly string[], beforeSequence = Infinity) {
  const runId = state.run?.identity.runId;
  const writes = new Set(runtimeV2WorkspaceChangeReceipts(state));
  const readPaths = new Map<string, string>();
  const files = new Map<string, FileSnapshot>();
  for (const event of state.events) {
    if (event.sequence >= beforeSequence) break;
    if (!("run" in event) || event.run.runId !== runId) continue;
    if (event.type === "command.scheduled" && event.command.kind === "execute_tool" && event.command.payload.toolName === "read_file") {
      const args = event.command.payload.arguments as Record<string, unknown> | undefined;
      const path = normalizeValidationWorkspaceCwd(args?.path, workspace);
      if (path && path !== ".") readPaths.set(event.command.idempotencyKey, path);
    }
    if ((event.type === "tool.completed" || event.type === "subagent.completed") && writes.has(event)) {
      for (const evidence of event.evidence) {
        if (evidence.kind !== "mutation") continue;
        const path = normalizeValidationWorkspaceCwd(evidence.target, workspace);
        if (!path || path === ".") continue;
        if (!evidence.version || !isRuntimeV2FileVersion(evidence.version) || evidence.version.startsWith("deleted")) {
          files.delete(path);
        } else {
          const version = evidence.version.startsWith("sha256-") ? evidence.version : `sha256-${evidence.version}`;
          if (files.get(path)?.version !== version) files.set(path, { version, evidenceId: evidence.id });
        }
      }
    }
    const revisionRead = event.type === "observation.recorded" && event.modelContent?.startsWith(PLAN_REVISION_PATH_OBSERVATION) &&
      revisionTargets.includes(event.evidence.target);
    const providerRead = event.type === "tool.completed" && event.status === "succeeded" && event.receiptOrigin !== "replayed";
    if (!revisionRead && !providerRead || !event.modelContent) continue;
    const path = event.type === "observation.recorded" ? event.evidence.target : readPaths.get(event.idempotencyKey);
    if (!path) continue;
    const receipts = event.type === "observation.recorded" ? [event.evidence] : event.evidence;
    const receipt = receipts.find(evidence => evidence.kind === "source" &&
      normalizeValidationWorkspaceCwd(evidence.target, workspace) === path);
    const version = receipt?.version;
    if (!receipt || !version || !/^sha256-[a-f0-9]{64}$/.test(version)) continue;
    const heading = revisionRead ? PLAN_REVISION_PATH_OBSERVATION : `[${receipt.id}] ${receipt.target}\n`;
    const source = event.modelContent.startsWith(heading) ? event.modelContent.slice(heading.length) : event.modelContent;
    const window = extractExactReadFileWindow(source);
    if (!window || window.metadata.contentVersion !== version ||
        normalizeValidationWorkspaceCwd(window.metadata.path, workspace) !== path) continue;
    const { metadata } = window;
    const fullRead = !metadata.truncated && metadata.returnedChars === metadata.totalChars &&
      metadata.returnedEndLine === metadata.totalLines && metadata.returnedStartLine === (metadata.totalLines ? 1 : 0);
    if (fullRead) files.set(path, { version, evidenceId: receipt.id, fullRead: window });
    else if (files.get(path)?.version !== version) files.set(path, { version, evidenceId: receipt.id });
  }
  return files;
}

function connectedGroups<T>(items: Iterable<T>, related: (left: T, right: T) => boolean): T[][] {
  const groups: T[][] = [];
  for (const item of items) {
    const linked = groups.filter(group => group.some(other => related(item, other)));
    const first = linked[0];
    if (!first) {
      groups.push([item]);
      continue;
    }
    first.push(item);
    for (const group of linked.slice(1)) {
      first.push(...group);
      groups.splice(groups.indexOf(group), 1);
    }
  }
  return groups;
}

function sourceIdentifiers(text: string): Set<string> {
  // Dollar-prefixed and Unicode identifiers are valid in several supported
  // languages. Matching whole identifiers avoids path/symbol substrings.
  return new Set(text.match(/[$_\p{ID_Start}][$_\p{ID_Continue}]*/gu) || []);
}

function sourceReferences(text: string): Set<string> {
  return new Set(Array.from(text.matchAll(
    /(?:^\s*#\s*include\s*|\b(?:from|import|preload|require|extends)\s*\(?\s*)["'<]([^"'<>\n]+)["'>]/gm,
  ), match => match[1]!.replace(/^res:\/\//, "").replace(/^\.\//, "")));
}

function independentTaskSourceGroups(state: TurnAggregateV1, files: ReadonlyMap<string, FileSnapshot>, workspace: string) {
  const units = new Map<string, SourceUnit>();
  for (const [path, { fullRead: window }] of files) {
    if (!window) continue;
    const declarations = new Set(Array.from(window.content.matchAll(
      /\b(?:class(?:_name)?|interface|struct|enum|record(?:\s+(?:class|struct))?|trait|function|func)\s+(?:[A-Z][A-Z0-9_]*_API\s+)?([$_\p{ID_Start}][$_\p{ID_Continue}]*)/gu,
    ), match => match[1]!));
    if (!declarations.size) continue;
    units.set(path, { path, declarations, identifiers: sourceIdentifiers(window.content), references: sourceReferences(window.content) });
  }
  const objectiveText = [state.objective.text, ...state.objective.acceptanceCriteria].join("\n");
  const objectiveIdentifiers = sourceIdentifiers(objectiveText);
  const explicitlyRequestedPaths = new Set((objectiveText.match(/(?:\.{0,1}[\\/])?(?:[\w.@+-]+[\\/])*[\w.@+-]+\.[A-Za-z][\w]*/g) || [])
    .map(value => normalizeValidationWorkspaceCwd(value, workspace)));
  const targets = new Set(Array.from(units.values()).filter(unit =>
    explicitlyRequestedPaths.has(unit.path) ||
    [...unit.declarations].some(name => objectiveIdentifiers.has(name)),
  ).map(unit => unit.path));
  if (!targets.size && state.strategy !== "analyze") return [];
  const referencesUnit = (from: SourceUnit, to: SourceUnit) => {
    const withoutExtension = to.path.replace(/\.[^.\/]+$/, "");
    return [...to.declarations].some(name => from.identifiers.has(name)) ||
      [...from.references].some(reference => reference === to.path || to.path.endsWith(`/${reference}`) ||
        reference === withoutExtension || withoutExtension.endsWith(`/${reference}`) ||
        withoutExtension.endsWith(`/${reference}/index`));
  };
  const groups = connectedGroups(units.values(), (left, right) => referencesUnit(left, right) || referencesUnit(right, left));
  // A broad analysis can use independent units from its own versioned reads.
  // An explicit scope wins over those inferred targets. One connected branch
  // stays with the parent, including the observed dependencies of that branch.
  return groups.flatMap(group => {
    const primary = targets.size ? group.filter(unit => targets.has(unit.path)) : group.slice(0, 1);
    return primary.length ? [{ paths: group.map(unit => unit.path), primary: primary.map(unit => unit.path) }] : [];
  });
}

function csharpAssemblyDependencies(state: TurnAggregateV1, sources: ReadonlyMap<string, FileSnapshot>) {
  const inspection = runtimeV2UnityRepairContext(state).assemblyReport;
  const workspace = state.turn.workspaceKey;
  const proofs = new Map<string, { owner: string; dependencies: Map<string, string> }>();
  if (!inspection?.report.complete || runtimeV2WorkspaceChangeReceipts(state).some(event =>
    event.sequence > inspection.sequence && event.evidence.some(item => item.kind === "mutation" &&
      /(?:\.(?:asmdef|asmref|dll|rsp)(?:\.meta)?$|^Packages\/(?:manifest|packages-lock)\.json$|^ProjectSettings\/ProjectVersion\.txt$)/i.test(
        normalizeValidationWorkspaceCwd(item.target, workspace) ?? "")))) return proofs;

  for (const source of inspection.report.sources) {
    const snapshot = sources.get(source.path);
    const assembly = source.assembly;
    if (!snapshot?.fullRead || snapshot.version !== source.sourceVersion || !assembly?.path || assembly.predefined ||
        !Array.isArray(assembly.dependencyClosure) || !assembly.dependencyClosure.length || assembly.dependencyClosure.length > 48) continue;
    const dependencies = new Map<string, string>();
    for (const entry of assembly.dependencyClosure) {
      const path = normalizeValidationWorkspaceCwd(entry?.path, workspace);
      if (!path || path !== entry.path || !/^(?:Assets|Packages|Library\/PackageCache)\/.*\.asmdef$/i.test(path) ||
          !/^sha256-[a-f0-9]{64}$/.test(entry.version) || dependencies.has(path) ||
          (sources.has(path) && sources.get(path)?.version !== entry.version)) break;
      dependencies.set(path, entry.version);
    }
    if (dependencies.size === assembly.dependencyClosure.length && dependencies.get(assembly.path) === assembly.version) {
      proofs.set(source.path, { owner: assembly.path, dependencies });
    }
  }
  return proofs;
}

function currentDiagnosticBranches(state: TurnAggregateV1, sources: ReadonlyMap<string, FileSnapshot>) {
  const scope = runtimeV2EditorDiagnosticScope(state);
  const compiler = runtimeV2UnityRepairContext(state).diagnostic?.result;
  if (!scope && !compiler) return [];
  const compilerRows = compiler?.status === "failed" && Array.isArray(compiler.diagnostics) && compiler.errorCount === compiler.diagnostics.length
    ? compiler.diagnostics.flatMap(row => {
      const path = typeof row?.file === "string" && unityCompilationTarget(row.file, state.turn.workspaceKey);
      return path && /\.cs$/i.test(path) && typeof row.message === "string" && /^CS\d+$/i.test(row.code) ? [{ ...row, path }] : [];
    }) : [];
  const diagnostics = scope?.complete ? scope.diagnostics.filter(item => !compiler || item.kind !== "csharp") : [];
  const files = new Map<string, RuntimeV2ConsoleDiagnostic>();
  const compilerKeys = new Map<string, Set<string>>();
  for (const { path, ...row } of compilerRows.length === compiler?.errorCount ? compilerRows : []) {
    if (!files.has(path)) files.set(path, { kind: "csharp", path, code: row.code, line: row.line });
    const keys = compilerKeys.get(path) ?? new Set<string>();
    keys.add(JSON.stringify([row.code.toUpperCase(), row.message.replace(/\s+/g, " ").trim()]));
    compilerKeys.set(path, keys);
  }
  for (const item of diagnostics) if (item.path && item.kind !== "runtime" && !files.has(item.path)) files.set(item.path, item);
  const csharp = csharpAssemblyDependencies(state, sources);
  const includes = new Map<string, Set<string>>();
  for (const path of files.keys()) {
    if (files.get(path)?.kind === "csharp") continue;
    const window = sources.get(path)?.fullRead;
    if (!window) continue;
    const references = new Set<string>();
    for (const match of window.content.matchAll(/^\s*#\s*include(?:_with_pragmas)?\s+["<]([^">]+)[">]/gm)) {
      const include = match[1]!.replace(/\\/g, "/").replace(/^\.\//, "");
      references.add(include);
      const fullPath = referencedShaderInclude(path, include);
      if (fullPath) references.add(fullPath);
    }
    includes.set(path, references);
  }
  const related = (left: string, right: string) => {
    if (files.get(left)?.kind !== files.get(right)?.kind) return false;
    if (files.get(left)?.kind === "csharp") {
      const a = csharp.get(left), b = csharp.get(right);
      const leftKeys = compilerKeys.get(left), rightKeys = compilerKeys.get(right);
      return !a || !b || !leftKeys || !rightKeys || [...a.dependencies.keys()].some(path => b.dependencies.has(path)) ||
        [...leftKeys].some(key => rightKeys.has(key));
    }
    const a = includes.get(left), b = includes.get(right);
    if (!a || !b) return true;
    return [...a].some(include => b.has(include) || right === include || right.endsWith(`/${include}`)) ||
      [...b].some(include => left === include || left.endsWith(`/${include}`));
  };
  const groups = connectedGroups(files.keys(), related);
  const committed = runtimeV2DirectExecuteMutationTargets(state);
  return groups.filter(group => !committed.length || group.some(path => scopesDisjoint([path], committed)))
    .map(group => ({
      group,
      kind: files.get(group[0]!)?.kind,
      hasFullReads: group.every(path => sources.get(path)?.fullRead),
      codes: [...new Set([...diagnostics, ...compilerRows].filter(item => item.path && group.includes(item.path)).map(item => item.code).filter(Boolean))].sort(),
      assemblyPaths: [...new Set(group.flatMap(path => csharp.get(path)?.owner ?? []))],
    }));
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
    !runtimeV2DelegationRequiresProposal(input.preference, state.subagentRequirement) ||
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
  const attempts = new Map(state.events.flatMap(event => event.type === "command.scheduled" &&
    event.command.kind === "schedule_subagents" && event.run.runId === runId && typeof event.command.payload.proactiveKey === "string"
    ? [[event.command.payload.proactiveKey, event.sequence] as const] : []));
  const approved = resolveApprovedRuntimeV2WorkPlanFromAggregate(state);
  const frontier = approved ? deriveRuntimeV2PlanExecutionFrontier(state) : null;
  const contract = state.strategy === "execute" ? deriveRuntimeV2ExecutionContract(state) : null;
  const ready = frontier?.steps.filter(step => step.status === "ready" && step.operation !== "preserve") || [];
  const writes = approved?.plan.draft.steps.filter(step => step.operation !== "preserve").flatMap(step => step.targets) ||
    contract?.changes.filter(change => change.operation !== "preserve").flatMap(change => change.targets) || [];
  const workspace = input.workspace || state.turn.workspaceKey;
  const revisionTargets = input.revisionTargetPaths || [];
  const files = currentFileSnapshots(state, workspace, revisionTargets);
  const planValidations = approved?.plan.draft.validations.filter(check => check.required && check.kind !== "advisory") || [];
  const validations = planValidations.length ? planValidations : contract?.validations || [];
  const hasValidation = validations.length > 0;
  const validationInFlight = state.phase === "validating" &&
    Boolean(approved && deriveRuntimeV2PlanExecutionCoverage(state)?.missingRequiredValidationIndexes.length);
  const planning = state.strategy === "plan" && state.phase === "planning" && !approved;
  const candidates: RuntimeV2OptionalDelegationScope[] = [];
  const legacySnapshots = new Map<number, ReadonlyMap<string, FileSnapshot>>();
  const add = (
    taskKind: "explore" | "review" | "validate",
    name: string,
    paths: readonly string[],
    objective: string,
    purpose: readonly unknown[],
    primaryPaths = paths,
    parentPaths: readonly string[] = [],
  ) => {
    const allowedPaths = [...new Set(paths)].sort();
    if (!allowedPaths.length || allowedPaths.length > RUNTIME_V2_SUBAGENT_MAX_SCOPE_PATHS ||
        allowedPaths.some(path => /[,\r`'"]/.test(path))) return;
    const primary = [...new Set(primaryPaths)].sort();
    if (!primary.length || primary.some(path => !allowedPaths.includes(path) || !files.has(path))) return;
    const scopeVersion = primary.map(path => [path, files.get(path)?.version]);
    const scopeKey = `proactive-v2:${taskKind}:${sha256Hex(JSON.stringify([purpose, scopeVersion]))}`;
    const proactiveKey = sha256Hex(JSON.stringify([runId, scopeKey]));
    if (attempts.has(proactiveKey) || jobs.some(job => job.scopeKey === scopeKey) ||
      [...activeJobs, ...jobs.filter(job => !job.proactiveKey && job.taskKind === taskKind)].some(job => !scopesDisjoint(job.allowedPaths, allowedPaths))) return;
    // A restored job can predate the current key recipe. Keep its result for
    // the original targets unless a trusted version proves a real change.
    if (jobs.some(job => {
      if (!job.proactiveKey || job.taskKind !== taskKind || !job.scopeKey.startsWith("proactive:") ||
          !primary.every(path => job.allowedPaths.includes(path))) return false;
      const sequence = attempts.get(job.proactiveKey);
      if (sequence === undefined) return true;
      let original = legacySnapshots.get(sequence);
      if (!original) {
        original = currentFileSnapshots(state, workspace, revisionTargets, sequence);
        legacySnapshots.set(sequence, original);
      }
      return !primary.some(path => original.get(path) && original.get(path)?.version !== files.get(path)?.version);
    })) return;
    candidates.push({
      scopeKey, proactiveKey, taskKind, accessMode: "read", name, allowedPaths, objective,
      primaryEvidence: primary.map(path => ({ path, id: files.get(path)!.evidenceId })),
      parentPaths: [...new Set(parentPaths)].sort(),
      successCriteria: "Return only actionable findings tied to exact file evidence, with any uncertainty stated.",
    });
  };

  if (planning && input.workspace && input.revisionTargetPaths?.length) {
    add("review", input.language === "zh" ? "变更文件审查" : "Review changed plan targets",
      input.revisionTargetPaths.filter(path => files.has(path)),
      "Inspect the current assigned files. Report concrete findings for the plan revision, including what to preserve and which planned checks the findings affect. The parent prepares the remaining plan independently.",
      ["plan_revision_review"]);
  }
  const directExecute = state.strategy === "execute" && !approved && !contract &&
    (state.phase === "observing" || state.phase === "acting" || state.phase === "validating");
  if (directExecute) {
    const [parent, ...branches] = currentDiagnosticBranches(state, files);
    for (const branch of branches) {
      if (!parent || !branch.hasFullReads || !scopesDisjoint(parent.group, branch.group)) continue;
      const shader = branch.kind === "shader_import";
      const name = shader ? input.language === "zh" ? "Shader 报错调查" : "Investigate Shader diagnostics"
        : input.language === "zh" ? "C# 报错调查" : "Investigate C# diagnostics";
      add("review", name, [...branch.group, ...branch.assemblyPaths],
        `Trace the reported ${shader ? "Shader import" : "C# compiler"} errors in ${branch.group.join(", ")}. Identify the exact cause and minimal compatible fix supported by the admitted source and project version. Return paths, symbols or includes, and the Editor check that should confirm the fix. The parent handles ${parent.group.join(", ")}.`,
        ["editor_diagnostic", branch.kind, branch.codes], branch.group, [...parent.group, ...parent.assemblyPaths]);
    }
  }
  if (input.workspace &&
      (directExecute && !isRuntimeV2EditorDiagnosticRepair(state) || state.strategy === "analyze" && state.phase === "observing")) {
    const [parent, ...branches] = independentTaskSourceGroups(state, files, workspace);
    for (const branch of branches) {
      if (!parent || !scopesDisjoint(parent.paths, branch.paths)) continue;
      add("review", input.language === "zh" ? "独立源码审查" : "Review independent source",
        branch.paths,
        `Inspect the requested issue in ${branch.primary.join(", ")}. Report exact evidence and any connection to the parent scope. The parent continues independently on ${parent.paths.join(", ")}. User's objective: ${state.objective.text}`,
        ["source_review"], branch.primary, parent.paths);
    }
  }
  const baseline = input.baseline;
  if (isProjectBaselineForWorkspace(baseline, input.workspace || "")) {
    const metadata = baseline.anchors.filter(anchor => (anchor.kind === "manifest" || anchor.kind === "config") && files.has(anchor.path));
    const configPaths = metadata.map(anchor => anchor.path);
    const primaryConfig = (paths: readonly string[]) => {
      const entry = metadata.find(anchor => anchor.kind === "manifest" && paths.includes(anchor.path)) ||
        metadata.find(anchor => paths.includes(anchor.path));
      return entry ? [entry.path] : [];
    };
    if (planning && (input.planningHasExecutableChoice || state.objective.acceptanceEvidenceRequirements?.some(Boolean)) &&
      [...files.keys()].some(path => scopesDisjoint([path], configPaths))) {
      add("explore", input.language === "zh" ? "验收前置条件调查" : "Explore verification prerequisites", configPaths,
        "Find the verification entry point and any unmet prerequisites for the requested acceptance checks. Return concrete requirements with source evidence while the parent designs the changes.",
        ["plan_verification_prerequisites", state.objective.acceptanceEvidenceRequirements || []], primaryConfig(configPaths));
    } else if (hasValidation && (ready.length > 0 || (!approved && writes.length > 0 && state.phase !== "validating"))) {
      const available = configPaths.filter(path => scopesDisjoint([path], writes));
      add("validate", input.language === "zh" ? "验收准备" : "Verification preparation", available,
        "Check test prerequisites and existing configuration for the declared validation. Return concrete requirements for the parent; do not run the validation.",
        ["verification_preparation", validations.map(check => JSON.stringify([check.kind, check.command, "cwd" in check ? check.cwd : null])).sort()],
        primaryConfig(available), ready.length ? ready.flatMap(step => step.targets) : writes);
    }
  }
  if (approved && frontier && (ready.length > 0 || validationInFlight || !hasValidation)) {
    const otherWrites = frontier.steps
      .filter((step) => step.status !== "completed" && step.operation !== "preserve")
      .flatMap((step) => step.targets);
    const dependentsByStep = new Map<number, number[]>();
    approved.plan.draft.steps.forEach((planStep, stepIndex) => {
      for (const depIndex of planStep.dependsOn) {
        const list = dependentsByStep.get(depIndex) || [];
        list.push(stepIndex);
        dependentsByStep.set(depIndex, list);
      }
    });
    const manualVerificationMode = !hasValidation;
    for (const step of frontier.steps) {
      if (step.status !== "completed" || step.operation === "preserve" || step.operation === "delete") continue;
      if (otherWrites.length > 0 && !scopesDisjoint(step.targets, otherWrites)) continue;
      const planStep = approved.plan.draft.steps[step.stepIndex]!;
      const sharesContractEdge = planStep.dependsOn.length > 0 || (dependentsByStep.get(step.stepIndex)?.length || 0) > 0;
      const lacksRequiredValidation = manualVerificationMode || Boolean(
        planStep.criterionIds?.some((criterionId) =>
          !approved.plan.draft.validations.some((v) =>
            v.required && (!v.criterionIds?.length || v.criterionIds.includes(criterionId)),
          ),
        ),
      );
      if (!sharesContractEdge && !lacksRequiredValidation) continue;
      const prerequisitePaths = [...new Set(
        planStep.dependsOn.flatMap((depIndex) => {
          const depStep = approved.plan.draft.steps[depIndex];
          if (!depStep || depStep.operation === "delete") return [];
          return depStep.targets.filter((target) => otherWrites.length === 0 || scopesDisjoint([target], otherWrites));
        }),
      )];
      const auditTargets = [...new Set([...step.targets, ...prerequisitePaths])].slice(0, RUNTIME_V2_SUBAGENT_MAX_SCOPE_PATHS);
      const contractQuestion = prerequisitePaths.length > 0
        ? `Check interface compatibility, type conformance, inheritance contracts, and acceptance compliance against prerequisite files (${prerequisitePaths.join(", ")}).`
        : "Check type safety, interface conformance, and acceptance compliance.";
      add(
        "review",
        input.language === "zh" ? "高风险改动合同审查" : "Risk review of committed changes",
        auditTargets,
        `Review ${step.targets.join(", ")} against step outcome (${planStep.expectedOutcome}). ${contractQuestion} Prefix any concrete compile, type, inheritance, or contract-breaking defect with [BLOCKING] (naming exact file path and symbol); prefix clean confirmations or minor notes with [ADVISORY].`,
        ["committed_change_review", step.operation, [...planStep.criterionIds || []].sort()],
        step.targets,
      );
    }
  }
  const [candidate, ...alternatives] = candidates;
  return candidate ? { candidate, alternatives } : { reason: "no_independent_scope" };
}
