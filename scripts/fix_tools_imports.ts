import { Project, SyntaxKind } from "ts-morph";
import path from "path";

const project = new Project({
  tsConfigFilePath: path.join(process.cwd(), "tsconfig.json"),
});

const file = project.getSourceFileOrThrow("src/lib/orchestrator.ts");
const toolExecutorsFile = project.getSourceFileOrThrow("src/lib/orchestrator/tools/toolExecutors.ts");

// Fix the import module specifier in orchestrator.ts
const imports = file.getImportDeclarations();
for (const imp of imports) {
  if (imp.getModuleSpecifierValue() === "./tools/toolExecutors") {
    imp.setModuleSpecifier("./orchestrator/tools/toolExecutors");
  }
}

// Export missing functions from orchestrator.ts
const moreSymbols = [
  "resolveStudioCompatToolArgs",
  "resolveProtocolPackageReadPath",
  "buildPlanArtifactMutationValidationError",
  "buildLoopDetectionValidationError",
  "buildReadBeforeModifyValidationError",
  "isUnityExecutionContext",
  "isUnityApplyTextPrecisePatchArgs",
  "buildUnityApplyTextPolicyBlockedMessage",
  "resolveMutationVerificationPath",
  "supportsToolDiffPreview",
  "isEphemeralPlanArtifactPath",
  "isEphemeralPlanArtifactMutation",
  "buildOptionalTasksMdMissingResult",
  "isMissingOptionalTasksMdReadError",
  "isOptionalTasksMdRead",
  "resolveShellAutoApproval",
  "buildToolDiffPreview",
  "preflightWorkspaceMutation"
];

const newExports: string[] = [];
for (const sym of moreSymbols) {
  const fn = file.getFunction(sym);
  if (fn) {
    fn.setIsExported(true);
    newExports.push(sym);
  }
}

// And what about generateId and withEventSchema? Let's check orchestrator.ts top imports
for (const imp of imports) {
  for (const named of imp.getNamedImports()) {
    if (named.getName() === "generateId" || named.getName() === "withEventSchema") {
      // Re-export them from orchestrator.ts
      file.addExportDeclaration({
        namedExports: [named.getName()]
      });
      newExports.push(named.getName());
    }
  }
}

// Update the import in toolExecutors.ts
const executorImports = toolExecutorsFile.getImportDeclarations();
for (const imp of executorImports) {
  if (imp.getModuleSpecifierValue() === "../../orchestrator") {
    for (const exp of newExports) {
      if (!imp.getNamedImports().some(ni => ni.getName() === exp)) {
        imp.addNamedImport(exp);
      }
    }
  }
}

// Also fix implicitly any params
const fns = toolExecutorsFile.getFunctions();
for (const fn of fns) {
  for (const p of fn.getParameters()) {
    if (p.getType().getText() === "any" && !p.getTypeNode()) {
      p.setType("any");
    }
  }
  
  // also check variables inside functions
  fn.forEachDescendant(node => {
    if (node.getKind() === SyntaxKind.Parameter) {
      const param = node.asKind(SyntaxKind.ParameterDeclaration);
      if (param && !param.getTypeNode()) {
        param.setType("any");
      }
    }
  });
}

project.saveSync();
console.log("Fixed imports and exports!");
