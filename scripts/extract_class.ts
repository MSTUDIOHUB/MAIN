import { Project, DiagnosticCategory } from "ts-morph";
import path from "path";
import fs from "fs";

const project = new Project({
  tsConfigFilePath: path.join(process.cwd(), "tsconfig.json"),
});

const file = project.getSourceFileOrThrow("src/lib/orchestrator.ts");

let loopFile = project.getSourceFile("src/lib/orchestrator/loop/AgentOrchestrator.ts");
if (!loopFile) {
  loopFile = project.createSourceFile("src/lib/orchestrator/loop/AgentOrchestrator.ts", "", { overwrite: true });
}

// Copy ALL imports from orchestrator.ts
for (const imp of file.getImportDeclarations()) {
  const structure = imp.getStructure();
  if (typeof structure.moduleSpecifier === "string") {
    if (structure.moduleSpecifier.startsWith("./") && !structure.moduleSpecifier.startsWith("../")) {
      structure.moduleSpecifier = "../" + structure.moduleSpecifier.slice(2);
    }
  }
  loopFile.addImportDeclaration(structure);
}

// Add type import
const typeImports = loopFile.getImportDeclaration(decl => decl.getModuleSpecifierValue() === "../orchestrator/types");
if (typeImports) {
  typeImports.setModuleSpecifier("../types");
} else {
  loopFile.addImportDeclaration({
    moduleSpecifier: "../types",
    namespaceImport: "types"
  });
}

// Move AgentOrchestrator and executeAgentLoop
const cls = file.getClass("AgentOrchestrator");
if (cls) {
  loopFile.addClass(cls.getStructure());
  cls.remove();
}

const func = file.getFunction("executeAgentLoop");
if (func) {
  loopFile.addFunction(func.getStructure() as any);
  func.remove();
}

// Export from loop to orchestrator
file.addExportDeclaration({
  moduleSpecifier: "./orchestrator/loop/AgentOrchestrator",
  namedExports: ["executeAgentLoop", "AgentOrchestrator"]
});

// Auto-fix loop
project.saveSync();

let iteration = 0;
while (iteration < 20) {
  iteration++;
  console.log(`\n--- Iteration ${iteration} ---`);
  
  const diagnostics = project.getPreEmitDiagnostics();
  const loopDiags = diagnostics.filter(d => 
    d.getSourceFile()?.getFilePath() === loopFile!.getFilePath() && 
    d.getCategory() === DiagnosticCategory.Error
  );
  
  if (loopDiags.length === 0) {
    console.log("No errors in AgentOrchestrator.ts!");
    break;
  }
  
  const missingNames = new Set<string>();
  for (const diag of loopDiags) {
    const msg = typeof diag.getMessageText() === "string" ? diag.getMessageText() as string : diag.getMessageText().getMessageText();
    const match = msg.match(/Cannot find name '([^']+)'/);
    if (match) missingNames.add(match[1]);
  }
  
  if (missingNames.size === 0) {
    console.log("Other errors found, stopping auto-fix.");
    break;
  }
  
  const exportsToAdd: string[] = [];
  for (const name of missingNames) {
    const fn = file.getFunction(name);
    if (fn) { fn.setIsExported(true); exportsToAdd.push(name); continue; }
    const varDecl = file.getVariableDeclaration(name);
    if (varDecl) { varDecl.getVariableStatement()?.setIsExported(true); exportsToAdd.push(name); continue; }
    // Enums, etc
    const enm = file.getEnum(name);
    if (enm) { enm.setIsExported(true); exportsToAdd.push(name); continue; }
  }
  
  if (exportsToAdd.length > 0) {
    console.log(`Exported ${exportsToAdd.length} items from orchestrator.ts`);
    const existingImport = loopFile!.getImportDeclaration(d => d.getModuleSpecifierValue() === "../../orchestrator");
    if (existingImport) {
      for (const exp of exportsToAdd) {
        if (!existingImport.getNamedImports().some(ni => ni.getName() === exp)) {
          existingImport.addNamedImport(exp);
        }
      }
    } else {
      loopFile!.addImportDeclaration({
        moduleSpecifier: "../../orchestrator",
        namedImports: exportsToAdd
      });
    }
    project.saveSync();
  } else {
    console.log("Could not find any of the missing names in orchestrator.ts.");
    break;
  }
}

// Clean unused imports
loopFile!.fixUnusedIdentifiers();
project.saveSync();
console.log("Extraction complete.");
