import { Project, SyntaxKind, DiagnosticCategory } from "ts-morph";
import path from "path";

const project = new Project({
  tsConfigFilePath: path.join(process.cwd(), "tsconfig.json"),
});

const orchestratorFile = project.getSourceFileOrThrow("src/lib/orchestrator.ts");

// Ensure the target file exists or create it
let loopFile = project.getSourceFile("src/lib/orchestrator/loop/executeAgentLoop.ts");
if (!loopFile) {
  loopFile = project.createSourceFile("src/lib/orchestrator/loop/executeAgentLoop.ts", "", { overwrite: true });
}

// 1. Find executeAgentLoop in orchestrator
const executeAgentLoopFunc = orchestratorFile.getFunction("executeAgentLoop");
if (executeAgentLoopFunc) {
  // Move it
  const text = executeAgentLoopFunc.getText();
  executeAgentLoopFunc.remove();
  
  // Add some basic imports that we know are needed
  loopFile.addImportDeclaration({
    moduleSpecifier: "../../orchestrator",
    namedImports: ["OrchestratorCallbacks"]
  });

  loopFile.addStatements("export " + text);
}

// Save before diagnostics
project.saveSync();

// Auto-fix loop
let iteration = 0;
while (iteration < 20) {
  iteration++;
  console.log(`\n--- Auto-fix Iteration ${iteration} ---`);
  
  const diagnostics = project.getPreEmitDiagnostics();
  let errorsFixed = 0;
  
  const loopFileDiagnostics = diagnostics.filter(d => 
    d.getSourceFile()?.getFilePath() === loopFile!.getFilePath() && 
    d.getCategory() === DiagnosticCategory.Error
  );
  
  if (loopFileDiagnostics.length === 0) {
    console.log("No more errors in executeAgentLoop.ts!");
    break;
  }
  
  console.log(`Found ${loopFileDiagnostics.length} errors.`);
  
  const missingNames = new Set<string>();
  
  for (const diag of loopFileDiagnostics) {
    const msg = typeof diag.getMessageText() === "string" ? diag.getMessageText() as string : diag.getMessageText().getMessageText();
    // Cannot find name 'foo'.
    const match = msg.match(/Cannot find name '([^']+)'/);
    if (match) {
      missingNames.add(match[1]);
    }
  }
  
  if (missingNames.size === 0) {
    console.log("No missing names found. Other errors exist. Stopping auto-fix.");
    for (const diag of loopFileDiagnostics) {
      console.log(diag.getMessageText());
    }
    break;
  }
  
  console.log(`Missing names to import: ${[...missingNames].join(", ")}`);
  
  // Try to export them from orchestrator.ts
  const exportsToAdd: string[] = [];
  
  for (const name of missingNames) {
    // Is it a function?
    const fn = orchestratorFile.getFunction(name);
    if (fn) {
      fn.setIsExported(true);
      exportsToAdd.push(name);
      continue;
    }
    
    // Is it an interface?
    const intf = orchestratorFile.getInterface(name);
    if (intf) {
      intf.setIsExported(true);
      exportsToAdd.push(name);
      continue;
    }
    
    // Is it a type alias?
    const typeAlias = orchestratorFile.getTypeAlias(name);
    if (typeAlias) {
      typeAlias.setIsExported(true);
      exportsToAdd.push(name);
      continue;
    }
    
    // Is it a variable statement?
    const varDecl = orchestratorFile.getVariableDeclaration(name);
    if (varDecl) {
      varDecl.getVariableStatement()?.setIsExported(true);
      exportsToAdd.push(name);
      continue;
    }
    
    // Is it a class?
    const cls = orchestratorFile.getClass(name);
    if (cls) {
      cls.setIsExported(true);
      exportsToAdd.push(name);
      continue;
    }
  }
  
  if (exportsToAdd.length > 0) {
    console.log(`Exported ${exportsToAdd.length} items from orchestrator.ts`);
    // Add imports to loopFile
    const existingImports = loopFile!.getImportDeclaration(decl => decl.getModuleSpecifierValue() === "../../orchestrator");
    if (existingImports) {
      for (const exp of exportsToAdd) {
        if (!existingImports.getNamedImports().some(ni => ni.getName() === exp)) {
          existingImports.addNamedImport(exp);
        }
      }
    } else {
      loopFile!.addImportDeclaration({
        moduleSpecifier: "../../orchestrator",
        namedImports: exportsToAdd
      });
    }
    errorsFixed += exportsToAdd.length;
  } else {
    console.log("Could not find any of the missing names in orchestrator.ts. They might be from external modules.");
    break;
  }
  
  if (errorsFixed > 0) {
    project.saveSync();
  } else {
    break;
  }
}

console.log("Auto-fix script completed.");
