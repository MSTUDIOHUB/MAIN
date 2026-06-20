import { Project, SyntaxKind } from "ts-morph";
import path from "path";

const project = new Project({ tsConfigFilePath: path.join(process.cwd(), "tsconfig.json") });
const file = project.getSourceFileOrThrow("src/lib/orchestrator.ts");

let typeLines = 0;
file.getInterfaces().forEach(i => typeLines += i.getEndLineNumber() - i.getStartLineNumber());
file.getTypeAliases().forEach(t => typeLines += t.getEndLineNumber() - t.getStartLineNumber());

let classLines = 0;
file.getClasses().forEach(c => classLines += c.getEndLineNumber() - c.getStartLineNumber());

let funcLines = 0;
file.getFunctions().forEach(f => funcLines += f.getEndLineNumber() - f.getStartLineNumber());

console.log(`Total lines: ${file.getEndLineNumber()}`);
console.log(`Type lines: ${typeLines}`);
console.log(`Class lines (AgentOrchestrator): ${classLines}`);
console.log(`Function lines: ${funcLines}`);
