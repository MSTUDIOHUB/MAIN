import { Project, SyntaxKind } from "ts-morph";
import path from "path";
import fs from "fs";

const project = new Project({
  tsConfigFilePath: path.join(process.cwd(), "tsconfig.json"),
});

const orchestratorFile = project.getSourceFileOrThrow("src/lib/orchestrator.ts");

const funcsToExtract = [
  "executeToolCallWithLifecycle",
  "executeLocalFileReadToolWithReview",
  "executeWriteToolWithReview",
  "executeReadOnlyToolsConcurrently"
];

// Find all dependencies
// For simplicity, we just extract the text and put it in a new file, and export them from orchestrator.ts?
// Wait, if we move them to a new file, we must import their dependencies from orchestrator.ts.

const toolExecutorsFile = project.createSourceFile(
  "src/lib/orchestrator/tools/toolExecutors.ts",
  "",
  { overwrite: true }
);

// We will just copy the text of these functions to toolExecutors.ts,
// remove them from orchestrator.ts, and then we will manually fix imports using tsc errors.

let content = "";
for (const funcName of funcsToExtract) {
  const func = orchestratorFile.getFunction(funcName);
  if (func) {
    // Add export keyword if not present
    func.setIsExported(true);
    content += func.getText() + "\n\n";
    func.remove();
  }
}

toolExecutorsFile.replaceWithText(content);

toolExecutorsFile.saveSync();
orchestratorFile.saveSync();
console.log("Extraction done.");
