import { Project, SyntaxKind, FunctionDeclaration } from "ts-morph";
import path from "path";

const project = new Project({
  tsConfigFilePath: path.join(process.cwd(), "tsconfig.json"),
});

const file = project.getSourceFileOrThrow("src/lib/orchestrator.ts");
const executeAgentLoop = file.getFunction("executeAgentLoop");

if (!executeAgentLoop) {
  throw new Error("Function not found");
}

const body = executeAgentLoop.getBodyOrThrow();
const statements = body.getStatements();

let whileLoopIndex = -1;
for (let i = 0; i < statements.length; i++) {
  if (statements[i].getKind() === SyntaxKind.WhileStatement) {
    whileLoopIndex = i;
    break;
  }
}

console.log(`While loop starts at statement index ${whileLoopIndex} out of ${statements.length}`);

// Find all variable declarations before the while loop
const initVars = new Set<string>();
for (let i = 0; i < whileLoopIndex; i++) {
  const stmt = statements[i];
  if (stmt.getKind() === SyntaxKind.VariableStatement) {
    const decls = stmt.asKind(SyntaxKind.VariableStatement)?.getDeclarations();
    decls?.forEach(d => {
      initVars.add(d.getName());
    });
  }
}

console.log(`Total initialized vars: ${initVars.size}`);

// Now find which of these are used inside the while loop
const whileLoop = statements[whileLoopIndex].asKindOrThrow(SyntaxKind.WhileStatement);
const usedVars = new Set<string>();

whileLoop.forEachDescendant((node) => {
  if (node.getKind() === SyntaxKind.Identifier) {
    const name = node.getText();
    if (initVars.has(name)) {
      usedVars.add(name);
    }
  }
});

console.log(`Variables used in loop: ${usedVars.size}`);
console.log([...usedVars].join(", "));
