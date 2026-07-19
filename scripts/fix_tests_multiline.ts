import fs from "fs";

const testFiles = [
  "tests/node/execute-recovery.test.mjs",
  "tests/node/web-research-guard.test.mjs",
  "tests/node/plan-execution-recovery.test.mjs",
  "tests/node/harness-gating.test.mjs",
  "tests/node/plan-artifact-hydration.test.mjs",
  "tests/node/normalized-turn.test.mjs",
  "tests/node/plan-materialization.test.mjs",
  "tests/node/workflow-models.test.mjs",
  "tests/node/orchestrator-language-mismatch.test.mjs",
  "tests/node/unity-mcp-fallback.test.mjs",
  "tests/node/tool-lifecycle.test.mjs",
  "tests/node/turn-process-archive.test.mjs",
  "tests/node/plan-quality-recovery.test.mjs",
  "tests/node/cloud-protocol.test.mjs"
];

for (const file of testFiles) {
  if (!fs.existsSync(file)) continue;
  let content = fs.readFileSync(file, "utf8");
  
  // Replace fsSync.readFileSync for orchestrator.ts regardless of formatting
  content = content.replace(/fsSync\.readFileSync\([\s\S]*?\"src\/lib\/orchestrator\.ts\"[\s\S]*?\)/g, (match) => {
    return `(fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator.ts"), "utf8") + "\\n" + fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/AgentOrchestrator.ts"), "utf8"))`;
  });
  
  fs.writeFileSync(file, content);
}

console.log("Fixed multiline readFileSync references");
