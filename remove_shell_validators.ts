import { Project, SyntaxKind } from "ts-morph";
import path from "path";

const project = new Project({
  tsConfigFilePath: path.join(process.cwd(), "tsconfig.json"),
});

const orchestratorFile = project.getSourceFileOrThrow("src/lib/orchestrator.ts");

const funcsToRemove = [
  "normalizeShellReadSegment",
  "isDirectoryOnlyShellSegment",
  "shellSegmentWords",
  "catHeadTailSegmentHasFileOperand",
  "sedSegmentHasFileOperand",
  "isShellFileReadSegment",
  "isShellFileReadCommand",
  "buildShellReadValidationError",
];

for (const name of funcsToRemove) {
  const func = orchestratorFile.getFunction(name);
  if (func) {
    console.log("Removing function: " + name);
    func.remove();
  }
}

// Add import
orchestratorFile.addImportDeclaration({
  namedImports: ["buildShellReadValidationError"],
  moduleSpecifier: "./orchestrator/tools/shellValidators",
});

orchestratorFile.saveSync();
console.log("Done.");
