import { Project, SyntaxKind, FunctionDeclaration } from "ts-morph";
import path from "path";

const project = new Project({
  tsConfigFilePath: path.join(process.cwd(), "tsconfig.json"),
});

const file = project.getSourceFileOrThrow("src/lib/orchestrator.ts");

// Find all functions that are not executeAgentLoop and not using callbacks directly?
// Actually, let's just find all top-level functions that don't depend on unexported things,
// or we just move all of them except executeAgentLoop to orchestratorUtils.ts!

// Let's just list all top-level functions in orchestrator.ts
const funcs = file.getFunctions();
console.log(`Total functions: ${funcs.length}`);

// We want to see how many lines these functions occupy.
let totalFuncLines = 0;
for (const func of funcs) {
  if (func.getName() !== "executeAgentLoop") {
    totalFuncLines += func.getEndLineNumber() - func.getStartLineNumber();
  }
}

console.log(`Lines occupied by other functions: ${totalFuncLines}`);
