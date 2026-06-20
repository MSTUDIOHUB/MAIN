import { Project } from "ts-morph";
import path from "path";

const project = new Project({
  tsConfigFilePath: path.join(process.cwd(), "tsconfig.json"),
});

const typesFile = project.getSourceFileOrThrow("src/lib/orchestrator/types.ts");
const orchestratorFile = project.getSourceFileOrThrow("src/lib/orchestrator.ts");

// Fix imports in types.ts that point to ../store
for (const imp of typesFile.getImportDeclarations()) {
  const specifier = imp.getModuleSpecifierValue();
  if (specifier === "../store/useAppStore") {
    imp.setModuleSpecifier("../../store/useAppStore");
  }
}

// Automatically fix unused imports in orchestrator.ts
orchestratorFile.fixUnusedIdentifiers();

project.saveSync();
console.log("Fixed deep imports in types.ts and unused imports in orchestrator.ts");
