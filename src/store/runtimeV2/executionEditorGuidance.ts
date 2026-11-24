import type { TurnAggregateV1 } from "../../lib/runtime-v2/aggregate";
import { deriveUnityCompilation, deriveUnityShaderImport, unresolvedUnityCompilation, unityCompilationMessage } from "../../lib/runtime-v2/unityCompilation";
import { isRuntimeV2EditorDiagnosticRepair, runtimeV2EditorRepairInstruction } from "../../lib/runtime-v2/editorConsoleEvidence";
import { runtimeV2DirectExecuteReadyForConclusion } from "../../lib/runtime-v2/phaseTransition";

export function runtimeV2ExecutionEditorGuidance(aggregate: TurnAggregateV1 | null) {
  const latestCompiler = deriveUnityCompilation(aggregate)?.receipt?.result;
  const compiler = latestCompiler?.status === "passed" ? latestCompiler : unresolvedUnityCompilation(aggregate)?.result;
  const compilerGuidance = !compiler || compiler.status === "not_unity_project" ? ""
    : compiler.status === "passed"
      ? "The workspace Editor compiled the latest script changes. Run any remaining checks required for this task."
      : [
          compiler.status === "failed"
            ? "Compilation failed. Inspect the reported source, fix it within the authorized scope, or complete a pending dependency that supplies it. If the repair needs another exact file (such as a test assembly definition), propose that file operation so MAIN can request a plan revision. PlayMode must wait for successful compilation."
            : "Compilation could not be verified. Use an authorized, finite check of this exact project's Editor when possible. Report any unavailable prerequisite accurately.",
          unityCompilationMessage(compiler),
        ].join("\n");
  const shaderBoundary = deriveUnityShaderImport(aggregate);
  const shaderImport = shaderBoundary?.receipt?.result;
  const editorRepair = isRuntimeV2EditorDiagnosticRepair(aggregate);
  const editorRepairComplete = editorRepair && !!aggregate && runtimeV2DirectExecuteReadyForConclusion(aggregate);
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
    compilerGuidance,
    shaderGuidance,
    editorRepairComplete ? "Verified Editor receipts cover the Console repair. Report the actual files changed and the completed checks."
      : runtimeV2EditorRepairInstruction(aggregate, [
        ...(compiler?.status === "passed" ? ["csharp" as const] : []),
        ...(shaderImport?.status === "passed" ? ["shader_import" as const] : []),
      ]),
  ].filter(Boolean).join("\n");
  return { editorRepair, instruction };
}
