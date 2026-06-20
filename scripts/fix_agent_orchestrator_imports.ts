import { Project, DiagnosticCategory } from "ts-morph";
import path from "path";

const project = new Project({
  tsConfigFilePath: path.join(process.cwd(), "tsconfig.json"),
});

const loopFile = project.getSourceFileOrThrow("src/lib/orchestrator/loop/AgentOrchestrator.ts");

// Fix ../ to ../../ for things that should be in src/lib
for (const imp of loopFile.getImportDeclarations()) {
  const spec = imp.getModuleSpecifierValue();
  if (spec.startsWith("../") && !spec.startsWith("../../") && spec !== "../types") {
    // Check if it exists in src/lib/orchestrator/
    const existsInOrchestrator = project.getSourceFile(`src/lib/orchestrator/${spec.slice(3)}.ts`);
    if (!existsInOrchestrator) {
      imp.setModuleSpecifier("../" + spec);
    }
  }
}

// Add types
const typesToImport = [
  "AgentMessage", "ToolExecutionResult", "FetchLLMStreamOptions", 
  "CachedReadOnlyToolResult", "ToolCallToExecute", "ToolCallInMessage", 
  "OrchestratorCallbacks", "PlanMaterializationResultForLoop", "ReviewDecision", "ContentPart"
];

const typesImport = loopFile.getImportDeclaration(d => d.getModuleSpecifierValue() === "../types");
if (typesImport) {
  for (const t of typesToImport) {
    if (!typesImport.getNamedImports().some(ni => ni.getName() === t)) {
      typesImport.addNamedImport(t);
    }
  }
} else {
  loopFile.addImportDeclaration({
    moduleSpecifier: "../types",
    namedImports: typesToImport
  });
}

// Fix missing constants from utils/orchestrator
const file = project.getSourceFileOrThrow("src/lib/orchestrator.ts");
const missingNames = ["isExecutionPlanArtifactWrite", "isTasksPlanWrite"];
const orchestratorImport = loopFile.getImportDeclaration(d => d.getModuleSpecifierValue() === "../../orchestrator");
if (orchestratorImport) {
  for (const m of missingNames) {
    const fn = file.getFunction(m);
    if (fn) fn.setIsExported(true);
    const vd = file.getVariableDeclaration(m);
    if (vd) vd.getVariableStatement()?.setIsExported(true);
    
    if (!orchestratorImport.getNamedImports().some(ni => ni.getName() === m)) {
      orchestratorImport.addNamedImport(m);
    }
  }
}

// Fix implicit any by copying type parameters from original signatures if needed, or we just let it be if it's fine. Wait, implicit any in catch blocks?
// Let's just suppress implicit any locally or fix them.
loopFile.fixUnusedIdentifiers();
project.saveSync();
console.log("Fixed AgentOrchestrator imports!");
