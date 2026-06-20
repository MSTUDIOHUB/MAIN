const fs = require('fs');
const path = require('path');

const orchestratorPath = path.join(__dirname, 'src/lib/orchestrator.ts');
let content = fs.readFileSync(orchestratorPath, 'utf-8');

const startTag = 'function buildApprovedPlanNoProgressStrategySwitchPrompt';
const endTag = 'function shouldTreatCloudGatewayErrorAsCompatibility';

const startIndex = content.indexOf(startTag);
const endIndex = content.indexOf(endTag);

const chunk = content.substring(startIndex, endIndex);

// Replace `function foo(` with `export function foo(`
const exportedChunk = chunk.replace(/^function ([a-zA-Z0-9_]+)\s*\(/gm, 'export function $1(');

// Extract the names of all the functions being exported
const functionNames = [];
const regex = /^export function ([a-zA-Z0-9_]+)\s*\(/gm;
let match;
while ((match = regex.exec(exportedChunk)) !== null) {
  functionNames.push(match[1]);
}

// Generate the new file content
const imports = `
import type { OrchestratorCallbacks, AgentMessage } from "../../../types";
import type { PlanToolActivitySummary } from "../../approvedPlanRecoveryTools";
import {
  PlanTaskEvidenceAudit,
  PlanTask,
  describePlanValidationDecision,
  isPlanTaskAwaitingBrowserValidation,
  isPlanTaskAwaitingExternalValidation,
  getPendingPlanTaskCommandFocus,
  PlanEvidenceRecord
} from "../../workflowModels";
import { HookEvent } from "../../hookEvents";
import { extractPrimaryUserRequestText } from "../../turnIntake";
import { extractCompatibilityTextContent } from "../../chatParsers";
import { stableProgressHash } from "../../planRuntime";
import { sanitizePlanEvidenceInput } from "../../planRuntimeContext";
import { hasBrowserValidationCapability } from "../../workflowModels";
import { buildPlanApprovalChoiceHint } from "../../planDrafting";
import { getToolTarget } from "../../toolTarget";

`;

const planPromptsPath = path.join(__dirname, 'src/lib/orchestrator/prompts/planPrompts.ts');
fs.writeFileSync(planPromptsPath, imports + exportedChunk);

// Remove the chunk from orchestrator.ts
const newOrchestratorContent = content.substring(0, startIndex) + content.substring(endIndex);

// Add the import statement
const importStatement = `import {\n  ${functionNames.join(',\n  ')}\n} from "./orchestrator/prompts/planPrompts";\n`;
const topImportIndex = newOrchestratorContent.indexOf('import {');
const finalOrchestrator = newOrchestratorContent.substring(0, topImportIndex) + importStatement + newOrchestratorContent.substring(topImportIndex);

fs.writeFileSync(orchestratorPath, finalOrchestrator);
console.log("Extracted functions:", functionNames.join(', '));
