import type { TurnAggregateV1 } from "../../lib/runtime-v2/aggregate";
import { deriveUnityCompilation, deriveUnityShaderImport, unresolvedUnityCompilation, unityCompilationMessage } from "../../lib/runtime-v2/unityCompilation";
import { freshRuntimeV2PipelineConsoleSample, isRuntimeV2EditorDiagnosticRepair, runtimeV2EditorDiagnosticScope, runtimeV2EditorRepairInstruction } from "../../lib/runtime-v2/editorConsoleEvidence";
import { runtimeV2DirectExecuteReadyForConclusion } from "../../lib/runtime-v2/phaseTransition";
import { ENABLE_UNITY_OFFICIAL_MCP_TOOL, UNITY_CONSOLE_TOOL_NAMES } from "../../lib/runtime-v2/workspaceReadPolicy";
import { decodeRuntimeV2UnityAssemblyReport, runtimeV2UnityCompilerDecision, runtimeV2UnityRepairContext, type RuntimeV2UnityAssemblyReference, type RuntimeV2UnityAssemblyReport } from "../../lib/runtime-v2/unityRepairLoop";
import { unityPredefinedScriptReferenceIssues } from "../../lib/unityAssemblyReferences";

function packageAssemblyIdentity(definition: RuntimeV2UnityAssemblyReference["resolved"] | RuntimeV2UnityAssemblyReference["candidate"]) {
  if (!definition?.package || !definition.packageVersion || typeof definition.path !== "string" ||
      !definition.path.startsWith("Library/PackageCache/") ||
      !/^sha256-[a-f0-9]{64}$/.test(definition.version || "")) return;
  return JSON.stringify([definition.package, definition.packageVersion, definition.path, definition.version, definition.name]);
}

function namespaceGuide(assembly: string, namespace: string) {
  return `Preserve the verified C# namespace ${JSON.stringify(namespace)} in source imports. Use ${JSON.stringify(assembly)} only as the assembly reference.`;
}

function retainedNamespaceGuidance(aggregate: TurnAggregateV1, report: RuntimeV2UnityAssemblyReport, sequence: number) {
  // An earlier namespace observation still applies when the new inspection
  // independently resolves the same installed package and exact definition.
  const resolved = new Set(report.sources.flatMap(source => source.assembly?.references.flatMap(reference => {
    const identity = reference.status === "resolved" && packageAssemblyIdentity(reference.resolved);
    return identity ? [identity] : [];
  }) ?? []));
  if (!resolved.size) return [];
  const runId = aggregate.run?.identity.runId;
  const inspections = new Set(aggregate.events.flatMap(event => event.type === "command.scheduled" && event.run.runId === runId &&
    event.command.payload.runtimeOwnedUnityAssemblyDiagnosis === true ? [event.command.idempotencyKey] : []));
  const guidance = new Set<string>();
  for (const event of [...aggregate.events].reverse()) {
    if (event.sequence >= sequence || event.type !== "tool.completed" || event.run.runId !== runId || event.status !== "succeeded" ||
        event.receiptOrigin === "replayed" || !event.modelContent || !inspections.has(event.idempotencyKey)) continue;
    try {
      const earlier = decodeRuntimeV2UnityAssemblyReport(JSON.parse(event.modelContent));
      for (const source of earlier?.sources ?? []) {
        for (const { candidate } of source.assembly?.references ?? []) {
          const identity = packageAssemblyIdentity(candidate);
          if (identity && resolved.has(identity) && candidate?.namespace && candidate.namespace !== candidate.name) {
            guidance.add(namespaceGuide(candidate.name, candidate.namespace));
          }
        }
      }
    } catch { /* A malformed historical observation carries no namespace evidence. */ }
    if (guidance.size >= 4) break;
  }
  return [...guidance].slice(0, 4);
}

function assemblyRepairGuide(aggregate: TurnAggregateV1 | null) {
  const inspection = aggregate && runtimeV2UnityRepairContext(aggregate).assemblyReport;
  if (!aggregate || !inspection) return "";
  const predefinedEdges = unityPredefinedScriptReferenceIssues(inspection.report);
  const predefinedKeys = new Set(predefinedEdges.map(edge => JSON.stringify([edge.ownerPath, edge.reference])));
  const hints = new Set<string>();
  for (const { path, assembly } of inspection.report.sources) {
    if (!assembly?.path || assembly.predefined) continue;
    const owner = JSON.stringify(assembly.path);
    for (const reference of assembly.references) {
      if (reference.status === "resolved" || predefinedKeys.has(JSON.stringify([assembly.path, reference.reference]))) continue;
      const candidate = reference.candidate;
      const origin = candidate ? `The installed ${JSON.stringify(candidate.package)} ${JSON.stringify(candidate.packageVersion)} declares ${JSON.stringify(candidate.name)} in ${JSON.stringify(candidate.path)}.` : "";
      const namespace = candidate?.namespace && candidate.namespace !== candidate.name ? namespaceGuide(candidate.name, candidate.namespace) : "";
      hints.add([`${owner} has ${reference.status} reference ${JSON.stringify(reference.reference)}.`, origin, namespace].filter(Boolean).join(" "));
    }
    if (!assembly.references.length) hints.add(`${JSON.stringify(path)} belongs to ${owner}.`);
  }
  return [
    ...(predefinedEdges.length ? [
      "The current assembly inspection confirms an unsupported reference from a named assembly to a Unity predefined script assembly. A C# using directive does not supply that assembly reference.",
      ...predefinedEdges.slice(0, 8).map(edge => inspection.report.complete
        ? `${JSON.stringify(edge.sourcePath)} belongs to ${JSON.stringify(edge.ownerPath)} (${JSON.stringify(edge.ownerName)}), which references the predefined script assembly ${JSON.stringify(edge.reference)}.`
        : `${JSON.stringify(edge.ownerPath)} (${JSON.stringify(edge.ownerName)}) references ${JSON.stringify(edge.reference)}. Verify that ${JSON.stringify(edge.sourcePath)} belongs to this definition because the inspection was incomplete.`),
      "Locate the actual source declarations for the unresolved compiler symbols and inspect their owning .asmdef or .asmref. If the declarations already have a named owner, use its declared name or GUID. If they are in a predefined script assembly, identify the smallest coherent source folder that can own a named assembly, verify the affected scripts and their dependencies, and reference that assembly from the consuming definition. Read the exact files at their current versions and stay within the authorized change scope. MAIN will compile the committed version.",
    ] : []),
    ...retainedNamespaceGuidance(aggregate, inspection.report, inspection.sequence),
    ...(hints.size ? ["The current assembly inspection found:", ...[...hints].slice(0, 8),
      "For a verified replacement, read the named project .asmdef at its current version and change the exact references entry within the authorized scope. MAIN will compile the committed version and return the new verdict. Use additional reads only to resolve a concrete missing fact."] : []),
  ].join("\n");
}

export function runtimeV2ExecutionEditorGuidance(aggregate: TurnAggregateV1 | null, toolNames: ReadonlySet<string>) {
  const consoleTool = [...UNITY_CONSOLE_TOOL_NAMES].find(name => toolNames.has(name));
  const baseline = aggregate ? runtimeV2UnityRepairContext(aggregate).baseline?.result : undefined;
  const latestCompiler = deriveUnityCompilation(aggregate)?.receipt?.result;
  const compiler = (latestCompiler?.status === "passed" ? latestCompiler : unresolvedUnityCompilation(aggregate)?.result) ?? baseline;
  const compilerGuidance = !compiler || compiler.status === "not_unity_project" ? ""
    : compiler.status === "passed"
      ? compiler === baseline ? "The current Editor reported no compiler errors in the baseline check. Use current evidence for any remaining Console issue." : "The workspace Editor compiled the latest script changes. Run any remaining checks required for this task."
      : [
          compiler.status === "failed"
            ? "The bound Editor finished with a compilation failure. Inspect the reported source and assembly definitions using workspace tools, then make the smallest authorized edits. MAIN checks each committed script or asmdef version. The bound Console reader is a separate observation tool and cannot be registered as a finite shell command. Generated .csproj files and fixed waits cannot update the compile verdict. If a reviewed plan needs an additional exact file, propose it for review. PlayMode requires a passing compile."
            : "Compilation could not be verified. Use the structured Editor status for this exact project. A bounded status check is useful when the Editor reports that it is busy. Report any unavailable prerequisite accurately.",
          unityCompilationMessage(compiler),
        ].join("\n");
  const shaderBoundary = deriveUnityShaderImport(aggregate);
  const shaderImport = shaderBoundary?.receipt?.result;
  const editorRepair = isRuntimeV2EditorDiagnosticRepair(aggregate);
  const editorRepairComplete = editorRepair && !!aggregate && runtimeV2DirectExecuteReadyForConclusion(aggregate);
  const consoleScope = aggregate ? runtimeV2EditorDiagnosticScope(aggregate) : undefined;
  const compilerBaseline = !compiler && freshRuntimeV2PipelineConsoleSample(consoleScope?.pipeline?.live)?.compilationFailed;
  const retainedCompilerHint = consoleScope?.retainedDiagnostics?.find(item => item.kind === "csharp" && item.path);
  const shaderGuidance = !shaderImport || ["not_unity_project", "deferred_closed"].includes(shaderImport.status) ? ""
    : shaderImport.status === "passed"
      ? "The connected Editor imported the current Shader assets and returned diagnostics for them."
      : [
          shaderImport.status === "failed"
            ? "Shader import reported errors. Inspect the named Shader assets and resolve their diagnostics within the authorized scope."
            : `Shader import could not be verified for ${shaderBoundary?.targets.join(", ") || "the modified assets"}. Keep Shader verification pending.`,
          unityCompilationMessage(shaderImport),
        ].filter(Boolean).join("\n");
  const instruction = [
    assemblyRepairGuide(aggregate),
    compilerGuidance,
    runtimeV2UnityCompilerDecision(aggregate)?.repeated
      ? "The bound compiler reported the same findings after the latest edit. Change the hypothesis or inspect a specific missing fact about the failed dependency or declaration. Repeating the same source window, generated project output, or unchanged Console sample cannot test a new hypothesis." : "",
    shaderGuidance,
    toolNames.has(ENABLE_UNITY_OFFICIAL_MCP_TOOL) && !consoleTool ? "Unity 6 is confirmed for this workspace and no Editor Console connector is available. If the task needs the Editor, request approval with enable_unity_official_mcp." : "",
    editorRepairComplete ? "Verified Editor receipts cover the Console repair. Report the actual files changed and the completed checks."
      : compiler?.status === "failed" ? "Continue from the compile diagnostics above and inspect the exact affected code before editing."
      : compiler?.status === "passed" && consoleScope?.pipeline && consoleTool
        ? `Confirm the live error count with the bound ${consoleTool} reader. Use its fresh Editor sample to close the Console check and report any errors still present.`
      : compilerBaseline ? `The live Editor sample has already confirmed a compilation failure.${retainedCompilerHint ? ` The retained buffer points to ${JSON.stringify(retainedCompilerHint.path)}${retainedCompilerHint.line ? ` at line ${retainedCompilerHint.line}` : ""}. Confirm the candidate issue against current source and assembly definitions.` : " Inspect the current project source for the failing compilation boundary."} The next authorized source change will be checked by the Editor.`
      : runtimeV2EditorRepairInstruction(aggregate, [
        ...(compiler?.status === "passed" ? ["csharp" as const] : []),
        ...(shaderImport?.status === "passed" ? ["shader_import" as const] : []),
      ], consoleTool),
  ].filter(Boolean).join("\n");
  return { editorRepair, instruction };
}
