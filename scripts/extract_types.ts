import { Project, SyntaxKind } from "ts-morph";
import path from "path";
import fs from "fs";

const project = new Project({
  tsConfigFilePath: path.join(process.cwd(), "tsconfig.json"),
});

const file = project.getSourceFileOrThrow("src/lib/orchestrator.ts");

let typesFile = project.getSourceFile("src/lib/orchestrator/types.ts");
if (!typesFile) {
  typesFile = project.createSourceFile("src/lib/orchestrator/types.ts", "", { overwrite: true });
}

const interfaces = file.getInterfaces();
const typeAliases = file.getTypeAliases();

console.log(`Found ${interfaces.length} interfaces and ${typeAliases.length} type aliases.`);

let typesContent = "";
const movedNames = new Set<string>();

for (const intf of interfaces) {
  const name = intf.getName();
  movedNames.add(name);
  intf.setIsExported(true);
  typesContent += intf.getText() + "\n\n";
  intf.remove();
}

for (const ta of typeAliases) {
  const name = ta.getName();
  movedNames.add(name);
  ta.setIsExported(true);
  typesContent += ta.getText() + "\n\n";
  ta.remove();
}

typesFile.addStatements(typesContent);

// Add import back to orchestrator.ts
file.addImportDeclaration({
  moduleSpecifier: "./orchestrator/types",
  namedImports: [...movedNames]
});

// Since types may rely on imported types in orchestrator.ts, we'll just copy ALL imports from orchestrator.ts to types.ts for safety, then we can clean them up or let TS complain if missing.
const imports = file.getImportDeclarations();
for (const imp of imports) {
  typesFile.addImportDeclaration(imp.getStructure());
}

project.saveSync();
console.log(`Moved ${movedNames.size} types to types.ts`);
