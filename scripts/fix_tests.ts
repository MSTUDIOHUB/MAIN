import fs from "fs";
import path from "path";

const testFiles = [
  "tests/node/execute-recovery.test.mjs",
  "tests/node/web-research-guard.test.mjs",
  "tests/node/plan-execution-recovery.test.mjs",
  "tests/node/harness-gating.test.mjs"
];

for (const file of testFiles) {
  let content = fs.readFileSync(file, "utf8");
  
  // Replace: fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator.ts"), "utf8");
  // With: fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator.ts"), "utf8") + "\n" + fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/AgentOrchestrator.ts"), "utf8");
  
  content = content.replace(
    /fsSync\.readFileSync\(path\.join\(workspaceRoot,\s*"src\/lib\/orchestrator\.ts"\),\s*"utf8"\)/g,
    'fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator.ts"), "utf8") + "\\n" + fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/AgentOrchestrator.ts"), "utf8")'
  );
  
  fs.writeFileSync(file, content);
}
console.log("Fixed tests");
