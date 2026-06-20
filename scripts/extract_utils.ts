import { Project, FunctionDeclaration } from "ts-morph";
import path from "path";

const project = new Project({
  tsConfigFilePath: path.join(process.cwd(), "tsconfig.json"),
});

const file = project.getSourceFileOrThrow("src/lib/orchestrator.ts");

let utilsFile = project.getSourceFile("src/lib/orchestrator/utils.ts");
if (!utilsFile) {
  utilsFile = project.createSourceFile("src/lib/orchestrator/utils.ts", "", { overwrite: true });
}

// Copy ALL imports from orchestrator.ts first
for (const imp of file.getImportDeclarations()) {
  const structure = imp.getStructure();
  if (typeof structure.moduleSpecifier === "string") {
    if (structure.moduleSpecifier.startsWith("./") && !structure.moduleSpecifier.startsWith("../")) {
      structure.moduleSpecifier = "../" + structure.moduleSpecifier.slice(2);
    }
  }
  utilsFile.addImportDeclaration(structure);
}

// Ensure types are imported from types.ts
const typeImports = utilsFile.getImportDeclaration(decl => decl.getModuleSpecifierValue() === "./types");
if (typeImports) {
  typeImports.setModuleSpecifier("./types");
} else {
  utilsFile.addImportDeclaration({
    moduleSpecifier: "./types",
    namespaceImport: "types" // Just in case, actually we can just rely on the existing import
  });
}

// Extract pure functions
const funcsToMove: FunctionDeclaration[] = [];
for (const func of file.getFunctions()) {
  const name = func.getName();
  if (!name || name === "executeAgentLoop") continue;
  if (/^(build|format|is|should|extract|normalize|truncate|summarize|looksLike)[A-Z]/.test(name)) {
    funcsToMove.push(func);
  }
}

let utilsContent = "";
const movedNames = new Set<string>();

for (const func of funcsToMove) {
  const name = func.getName()!;
  movedNames.add(name);
  func.setIsExported(true);
  utilsContent += func.getText() + "\n\n";
  func.remove();
}

utilsFile.addStatements(utilsContent);

// Add import back to orchestrator.ts
file.addImportDeclaration({
  moduleSpecifier: "./orchestrator/utils",
  namedImports: [...movedNames]
});

// Clean up unused imports
utilsFile.fixUnusedIdentifiers();
file.fixUnusedIdentifiers();

// Fix the types.ts self import if there
for (const imp of utilsFile.getImportDeclarations()) {
  if (imp.getModuleSpecifierValue() === "../orchestrator/types") {
    imp.setModuleSpecifier("./types");
  }
}

project.saveSync();
console.log(`Moved ${movedNames.size} utility functions to utils.ts`);
