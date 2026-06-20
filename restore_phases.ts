import { Project } from "ts-morph";
import * as path from "path";

const project = new Project();
const sourceFile = project.addSourceFileAtPath("src/lib/orchestrator.ts");

const functionsToRemove = {
  "executePrompts": [
    "buildExecuteConvergencePrompt",
    "buildExecuteCompletionEvidencePrompt",
    "buildExecuteReplanningEvidencePrompt",
    "buildHiddenThoughtOnlyContinuationPrompt",
    "buildReadOnlyPermissionHardRecoveryPrompt",
    "looksLikeExecutionReplanningText",
    "looksLikeOperationCompletionClaim",
    "looksLikePlanCompletionClaim"
  ],
  "validationPrompts": [
    "buildNonActionableStopMessage",
    "buildProseCodeDumpNotice"
  ],
  "toolValidators": [
    "validateToolArgs",
    "validateToolExecutionContract"
  ]
};

for (const [moduleName, funcs] of Object.entries(functionsToRemove)) {
  for (const name of funcs) {
    const func = sourceFile.getFunction(name);
    if (func) func.remove();
  }
  
  let importPath = "";
  if (moduleName === "toolValidators") importPath = "./orchestrator/tools/toolValidators";
  else importPath = `./orchestrator/prompts/${moduleName}`;

  sourceFile.addImportDeclaration({
    namedImports: funcs,
    moduleSpecifier: importPath
  });
}

sourceFile.saveSync();
console.log("Restored Phase 1 & 2 extractions using ts-morph!");
