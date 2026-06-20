const fs = require('fs');
const path = require('path');

const orchestratorPath = path.join(__dirname, 'src/lib/orchestrator.ts');
let content = fs.readFileSync(orchestratorPath, 'utf-8');

const startTag = 'function buildApprovedPlanNoProgressStrategySwitchPrompt';
const endTag = 'function shouldTreatCloudGatewayErrorAsCompatibility'; // The next function after the block

const startIndex = content.indexOf(startTag);
const endIndex = content.indexOf(endTag);

if (startIndex === -1 || endIndex === -1) {
  console.error("Tags not found");
  process.exit(1);
}

// Extract the chunk
const chunk = content.substring(startIndex, endIndex);

// Parse exported functions from chunk
const functionRegex = /function ([a-zA-Z0-9_]+)\s*\(/g;
let match;
const exportedNames = [];
while ((match = functionRegex.exec(chunk)) !== null) {
  exportedNames.push(match[1]);
}

// Prepend `export ` to all functions in chunk
const exportedChunk = chunk.replace(/^function /gm, 'export function ');

// Write to planPrompts.ts
const targetDir = path.join(__dirname, 'src/lib/orchestrator/prompts');
if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
fs.writeFileSync(path.join(targetDir, 'planPrompts.ts'), `import type { OrchestratorCallbacks, AgentMessage } from "../../types";\nimport type { PlanToolActivitySummary } from "./../approvedPlanRecoveryTools";\n\n` + exportedChunk);

// Remove chunk from orchestrator.ts
let newContent = content.substring(0, startIndex) + content.substring(endIndex);

// Add import statement at the top of orchestrator.ts (after the first import block)
const importStatement = `import {\n  ${exportedNames.join(',\n  ')}\n} from "./orchestrator/prompts/planPrompts";\n`;

const topImportIndex = newContent.indexOf('import {');
newContent = newContent.substring(0, topImportIndex) + importStatement + newContent.substring(topImportIndex);

fs.writeFileSync(orchestratorPath, newContent);
console.log("Successfully extracted plan prompts:", exportedNames.length, "functions");
