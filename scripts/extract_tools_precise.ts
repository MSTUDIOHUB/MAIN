import { Project, SyntaxKind } from "ts-morph";
import path from "path";

const project = new Project({
  tsConfigFilePath: path.join(process.cwd(), "tsconfig.json"),
});

const file = project.getSourceFileOrThrow("src/lib/orchestrator.ts");

// Export necessary internal types and functions for toolExecutors
const symbolsToExport = [
  "loadHooksConfig",
  "ExecuteToolLifecycleOptions",
  "normalizeToolCallForExecution",
  "buildShellReadValidationError",
  "validateToolExecutionContract",
  "runLifecycleHooks",
  "syncPlanArtifactAfterToolSuccess",
  "rememberReadBeforeModifyEvidence",
  "PlanArtifactRecoveryAction",
  "detectPlanArtifactKind",
  "PLAN_ARTIFACT_MUTATION_TOOLS",
  "validateActionablePlanArtifact",
  "validatePlanArtifactContent",
  "PlanArtifactQualityResult",
  "logAgentEvent",
  "buildMutationDiffPreviewFromSnapshots",
  "isOptionalTasksMdRead",
  "isMissingOptionalTasksMdReadError",
  "buildOptionalTasksMdMissingResult",
  "getToolTarget",
  "preflightWorkspaceMutation",
  "resolveShellAutoApproval",
  "shellPermissionPreflight",
  "isLocalFileReadApproved",
  "ReviewDecision",
  "executeTool",
  "buildToolDiffPreview",
  "readFileMetadataIfAvailable",
  "readMutationDiffSnapshot",
  "isNoEffectMutationResult",
  "buildNoEffectMutationMessage",
  "getToolResultBudgets",
  "truncateToolContent"
];

for (const sym of symbolsToExport) {
  const fn = file.getFunction(sym);
  if (fn) fn.setIsExported(true);
  
  const intf = file.getInterface(sym);
  if (intf) intf.setIsExported(true);
  
  const typeAlias = file.getTypeAlias(sym);
  if (typeAlias) typeAlias.setIsExported(true);
  
  const varDecl = file.getVariableDeclaration(sym);
  if (varDecl) varDecl.getVariableStatement()?.setIsExported(true);
}

// Now extract the executors
const funcsToExtract = [
  "executeToolCallWithLifecycle",
  "executeLocalFileReadToolWithReview",
  "executeWriteToolWithReview",
  "executeReadOnlyToolsConcurrently"
];

let toolExecutorsFile = project.getSourceFile("src/lib/orchestrator/tools/toolExecutors.ts");
if (!toolExecutorsFile) {
  toolExecutorsFile = project.createSourceFile("src/lib/orchestrator/tools/toolExecutors.ts", "", { overwrite: true });
}

let content = "";
const movedFuncs = new Set<string>();

for (const funcName of funcsToExtract) {
  const func = file.getFunction(funcName);
  if (func) {
    func.setIsExported(true);
    content += func.getText() + "\n\n";
    movedFuncs.add(funcName);
    func.remove();
  }
}

// Add imports to toolExecutorsFile
toolExecutorsFile.addImportDeclaration({
  moduleSpecifier: "../../orchestrator",
  namedImports: [
    "ToolCallToExecute",
    "ToolExecutionResult",
    "OrchestratorCallbacks",
    "ToolDefinition",
    ...symbolsToExport
  ]
});

toolExecutorsFile.addStatements(content);

// Add import back to orchestrator.ts
file.addImportDeclaration({
  moduleSpecifier: "./tools/toolExecutors",
  namedImports: [...movedFuncs]
});

project.saveSync();
console.log("Successfully exported dependencies and extracted toolExecutors.ts");
