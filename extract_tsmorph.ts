import { Project } from "ts-morph";
import * as fs from "fs";
import * as path from "path";

const project = new Project();
const sourceFile = project.addSourceFileAtPath("src/lib/orchestrator.ts");

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

let extractedCode = "";

for (const name of functionsToExtract) {
  const func = sourceFile.getFunction(name);
  if (func) {
    // Add export keyword if missing
    if (!func.isExported()) {
      func.setIsExported(true);
    }
    extractedCode += func.getText() + "\n\n";
    func.remove();
  } else {
    console.error("Function not found:", name);
  }
}

// Add import to orchestrator.ts
sourceFile.addImportDeclaration({
  namedImports: functionsToExtract,
  moduleSpecifier: "./orchestrator/prompts/planPrompts"
});

// Save orchestrator.ts
sourceFile.saveSync();

// Generate planPrompts.ts
const planPromptsPath = path.join(process.cwd(), "src/lib/orchestrator/prompts/planPrompts.ts");
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
fs.writeFileSync(planPromptsPath, imports + "\\n" + extractedCode);

console.log("Successfully extracted via ts-morph!");
