import { Project } from "ts-morph";
import path from "path";

const project = new Project({
  tsConfigFilePath: path.join(process.cwd(), "tsconfig.json"),
});

const loopFile = project.getSourceFileOrThrow("src/lib/orchestrator/loop/AgentOrchestrator.ts");

// Export class and function
const cls = loopFile.getClass("AgentOrchestrator");
if (cls) cls.setIsExported(true);

const func = loopFile.getFunction("executeAgentLoop");
if (func) func.setIsExported(true);

// Fix store import path
for (const imp of loopFile.getImportDeclarations()) {
  const spec = imp.getModuleSpecifierValue();
  if (spec === "../../store/useAppStore") {
    imp.setModuleSpecifier("../../../store/useAppStore");
  }
}

// Clean orchestrator.ts
const file = project.getSourceFileOrThrow("src/lib/orchestrator.ts");
file.fixUnusedIdentifiers();

project.saveSync();
console.log("Fixed final exports and imports.");
