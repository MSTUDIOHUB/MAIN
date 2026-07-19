import type { GoalEvidenceKind, GoalEvidenceStatus } from "./goalState";
import { isReadOnlyShellInspectionToolCall } from "./repetitionGuard";
import { classifyKnownBuiltInTool, classifyMcpToolName } from "./toolCapabilities";

export interface GoalToolCapabilityInput {
  name: string;
  target?: string;
  arguments?: Record<string, unknown>;
}

export interface GoalToolCapability {
  kind: GoalEvidenceKind;
  known: boolean;
  completionEligible: boolean;
  meaningfulProgress: boolean;
}

const TEST_COMMAND_RE = /\b(?:npm\s+(?:run\s+)?test|pnpm\s+(?:run\s+)?test|yarn\s+test|bun\s+test|pytest|python\s+-m\s+pytest|cargo\s+test|go\s+test|jest|vitest|playwright\s+test)\b/i;
const BUILD_COMMAND_RE = /\b(?:npm\s+run\s+(?:build|lint|typecheck)|pnpm\s+(?:run\s+)?(?:build|lint|typecheck)|yarn\s+(?:build|lint|typecheck)|tsc\b|cargo\s+(?:build|check)|go\s+build)\b/i;
const MCP_READ_INTENT_RE = /(?:^|[_-])(?:read|get|list|search|query|inspect|find|fetch|show|describe|explain|console)(?:[_-]|$)/i;
const MCP_WRITE_INTENT_RE = /(?:^|[_-])(?:apply|edit|write|create|update|set|delete|remove|rename|move|patch|insert|replace)(?:[_-]|$)/i;
const MCP_WORKSPACE_MUTATION_RE = /(?:script|file|asset|scene|prefab|project|source|text).*(?:apply|edit|write|create|update|delete|patch|replace)|(?:apply|edit|write|patch|replace).*(?:script|file|asset|scene|prefab|source|text)/i;
const FILE_TARGET_RE = /(?:^|[/\\])[^/\\]+\.[a-z0-9]{1,10}(?::\d+)?$/i;

function capability(
  kind: GoalEvidenceKind,
  options: { known?: boolean; completionEligible?: boolean; meaningfulProgress?: boolean } = {},
): GoalToolCapability {
  return {
    kind,
    known: options.known !== false,
    completionEligible: options.completionEligible !== false,
    meaningfulProgress: options.meaningfulProgress === true,
  };
}

export function classifyGoalToolCapability(input: GoalToolCapabilityInput): GoalToolCapability {
  const name = String(input.name || "").trim();
  const target = String(input.target || "").trim();
  const risk = classifyKnownBuiltInTool(name);
  if (risk === "workspace_write" || risk === "destructive") {
    return capability("file_change", { meaningfulProgress: true });
  }
  if (risk === "read_only" || risk === "external_read" || risk === "local_file_read") {
    return capability("read", { meaningfulProgress: false });
  }
  if (risk === "shell") {
    if (TEST_COMMAND_RE.test(target)) return capability("test", { meaningfulProgress: true });
    if (BUILD_COMMAND_RE.test(target)) return capability("build", { meaningfulProgress: true });
    if (isReadOnlyShellInspectionToolCall(
      name,
      input.arguments || (target ? { command: target } : {}),
    )) {
      return capability("read", { meaningfulProgress: false });
    }
    return capability("command", { meaningfulProgress: true });
  }
  if (risk === "browser_control") {
    return capability("browser", { meaningfulProgress: true });
  }
  if (risk === "desktop_control") {
    return capability("desktop", { meaningfulProgress: true });
  }
  if (name.startsWith("mcp_") || name.includes("__")) {
    if (!MCP_READ_INTENT_RE.test(name) && !MCP_WRITE_INTENT_RE.test(name)) {
      return capability("unknown", { known: false, completionEligible: false, meaningfulProgress: false });
    }
    const mcpRisk = classifyMcpToolName(name);
    if (mcpRisk === "external_read") return capability("read", { meaningfulProgress: false });
    if (mcpRisk === "browser_control") return capability("browser", { meaningfulProgress: true });
    if (mcpRisk === "desktop_control") return capability("desktop", { meaningfulProgress: true });
    if (
      (mcpRisk === "external_write" || mcpRisk === "destructive") &&
      (MCP_WORKSPACE_MUTATION_RE.test(name) || FILE_TARGET_RE.test(target))
    ) {
      return capability("file_change", { meaningfulProgress: true });
    }
    return capability("mcp", { meaningfulProgress: mcpRisk === "external_write" || mcpRisk === "destructive" });
  }
  return capability("unknown", {
    known: false,
    completionEligible: false,
    meaningfulProgress: false,
  });
}

export function isGoalEvidenceCompletionEligible(input: {
  kind: GoalEvidenceKind;
  status: GoalEvidenceStatus;
}): boolean {
  return input.status !== "failed" && input.kind !== "blocker" && input.kind !== "unknown";
}

export function isGoalEvidenceMeaningfulProgress(input: {
  kind: GoalEvidenceKind;
  status: GoalEvidenceStatus;
}): boolean {
  if (input.status === "failed") return false;
  return input.kind !== "blocker" && input.kind !== "read" && input.kind !== "unknown";
}

export function isGoalFileMutationTool(name: string): boolean {
  const risk = classifyKnownBuiltInTool(String(name || "").trim());
  return risk === "workspace_write" || risk === "destructive";
}

export function isGoalTestCommand(target: string): boolean {
  return TEST_COMMAND_RE.test(String(target || ""));
}
