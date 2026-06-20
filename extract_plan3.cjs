const fs = require('fs');
const path = require('path');

const orchestratorPath = path.join(__dirname, 'src/lib/orchestrator.ts');
let content = fs.readFileSync(orchestratorPath, 'utf-8');

const functionsToExtract = [
  "buildApprovedPlanNoProgressStrategySwitchPrompt",
  "buildApprovedPlanSourceEditFirstPrompt",
  "formatPlanAuditRemainingTasks",
  "formatApprovedPlanNoToolAvailableTools",
  "buildApprovedPlanNoToolPauseMessage",
  "formatPendingValidationTasks",
  "buildApprovedPlanValidationPendingMessage",
  "buildBrowserValidationContinuationPrompt",
  "resolveApprovedPlanValidationBoundary",
  "stripControlPromptForPlanFallback",
  "isPlanRuntimeInstructionMemory",
  "isPlanControlUserPrompt",
  "detectRequestedRootMarkdownDeliverables"
];

let extractedContent = "";
let newOrchestratorContent = content;

for (const func of functionsToExtract) {
  // Find the function start
  const startRegex = new RegExp(`function ${func}\\(`);
  const match = startRegex.exec(newOrchestratorContent);
  if (!match) {
    console.error(`Could not find function ${func}`);
    continue;
  }
  const startIndex = match.index;
  // Find the end of the function (a closing brace that matches the indentation, usually just '}')
  // Since functions might be nested, we can just use a simple brace counter
  let braceCount = 0;
  let hasStarted = false;
  let endIndex = -1;
  for (let i = startIndex; i < newOrchestratorContent.length; i++) {
    if (newOrchestratorContent[i] === '{') {
      braceCount++;
      hasStarted = true;
    } else if (newOrchestratorContent[i] === '}') {
      braceCount--;
    }
    if (hasStarted && braceCount === 0) {
      endIndex = i + 1;
      break;
    }
  }

  if (endIndex === -1) {
    console.error(`Could not find end of function ${func}`);
    continue;
  }

  let chunk = newOrchestratorContent.substring(startIndex, endIndex);
  chunk = chunk.replace(`function ${func}(`, `export function ${func}(`);
  extractedContent += chunk + "\n\n";

  // Remove from orchestrator
  newOrchestratorContent = newOrchestratorContent.substring(0, startIndex) + newOrchestratorContent.substring(endIndex);
}

// Generate the new file content
const imports = `
import type { PlanToolActivitySummary } from "../../approvedPlanRecoveryTools";
import {
  type PlanTaskEvidenceAudit,
  type PlanTask,
  describePlanValidationDecision,
  isPlanTaskAwaitingBrowserValidation,
  isPlanTaskAwaitingExternalValidation,
  hasBrowserValidationCapability
} from "../../workflowModels";
`;

const planPromptsPath = path.join(__dirname, 'src/lib/orchestrator/prompts/planPrompts.ts');
fs.writeFileSync(planPromptsPath, imports + extractedContent);

// Add the import statement
const importStatement = `import {\n  ${functionsToExtract.join(',\n  ')}\n} from "./orchestrator/prompts/planPrompts";\n`;
const topImportIndex = newOrchestratorContent.indexOf('import {');
const finalOrchestrator = newOrchestratorContent.substring(0, topImportIndex) + importStatement + newOrchestratorContent.substring(topImportIndex);

fs.writeFileSync(orchestratorPath, finalOrchestrator);
console.log("Successfully extracted 13 functions!");
