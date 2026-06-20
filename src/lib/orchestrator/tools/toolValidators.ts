import type { ToolDefinition } from "../../toolSchemas";
import { validateShellToolContract } from "../../toolExecutionContract";

/**
 * Validate that all required parameters for a tool are present.
 * Returns an error message string if any are missing, or null if valid.
 */
export function validateToolArgs(name: string, args: Record<string, unknown>, allTools: ToolDefinition[]): string | null {
  const def = allTools.find(d => d.function.name === name);
  if (!def) return null; // Unknown tool — let it through and fail downstream
  const required = def.function.parameters.required || [];
  const missing = required.filter(k => args[k] === undefined || args[k] === null || args[k] === "");
  if (missing.length === 0) return null;
  const missingRequiredMessage = `Tool '${name}' is missing required parameter(s): ${missing.join(", ")}. ` +
    `Required: ${required.join(", ")}. Please retry with the correct arguments.`;
  return missingRequiredMessage;
}

export function validateToolExecutionContract(name: string, args: Record<string, unknown>, allTools: ToolDefinition[]): string | null {
  const requiredError = validateToolArgs(name, args, allTools);
  if (requiredError) return requiredError;
  return validateShellToolContract(name, args);
}
