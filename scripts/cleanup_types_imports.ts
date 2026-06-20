import { Project } from "ts-morph";
import path from "path";

const project = new Project({
  tsConfigFilePath: path.join(process.cwd(), "tsconfig.json"),
});

const typesFile = project.getSourceFileOrThrow("src/lib/orchestrator/types.ts");

// Fix TS2440: remove self-imports
for (const imp of typesFile.getImportDeclarations()) {
  const specifier = imp.getModuleSpecifierValue();
  if (specifier === "../orchestrator/types" || specifier === "./orchestrator/types") {
    imp.remove();
    continue;
  }
}

// Automatically remove unused imports
typesFile.fixUnusedIdentifiers();

project.saveSync();
console.log("Cleaned up unused imports in types.ts");
