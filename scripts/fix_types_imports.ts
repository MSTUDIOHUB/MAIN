import { Project } from "ts-morph";
import path from "path";

const project = new Project({
  tsConfigFilePath: path.join(process.cwd(), "tsconfig.json"),
});

const typesFile = project.getSourceFileOrThrow("src/lib/orchestrator/types.ts");
const orchestratorFile = project.getSourceFileOrThrow("src/lib/orchestrator.ts");

// Fix module specifiers in types.ts
for (const imp of typesFile.getImportDeclarations()) {
  const specifier = imp.getModuleSpecifierValue();
  if (specifier.startsWith("./") && !specifier.startsWith("../")) {
    imp.setModuleSpecifier("../" + specifier.slice(2));
  }
}

// Add export * to orchestrator.ts so that external files like workflowEngine.ts and useAppStore.ts don't break
orchestratorFile.addExportDeclaration({
  moduleSpecifier: "./orchestrator/types"
});

project.saveSync();
console.log("Fixed types.ts imports and re-exported from orchestrator.ts");
