import type { ShellPermissionApproval, ShellPermissionDecision } from "./ipc";
import { isPtyControlInput } from "./ptyCommandRuntime";
import { looksDangerousShellCommand } from "./toolExecutionContract";

type ShellPermissionPreflight = (
  command: string,
  workspace?: string,
) => Promise<ShellPermissionDecision>;

export interface ShellAutoApprovalResolution {
  command: string | null;
  decision?: ShellPermissionDecision;
  /** Exact approval passed to the shell guard when Auto Review accepts a safe `ask`. */
  approval?: ShellPermissionApproval;
  /** True when this shell call must pass through the human review gate. */
  requiresUserReview?: boolean;
  error?: string;
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function usesAppendNewline(args: Record<string, unknown>): boolean {
  return args.append_newline === true ||
    args.append_newline === "true" ||
    args.appendNewline === true ||
    args.appendNewline === "true";
}

function shellDecisionIsCritical(decision: ShellPermissionDecision): boolean {
  return decision.riskLevel === "critical" ||
    decision.segmentDecisions.some((segment) => segment.riskLevel === "critical");
}

export function getShellPermissionCommandForTool(
  toolName: string,
  args: Record<string, unknown>,
): string | null {
  if (toolName === "run_command" || toolName === "execute_command") {
    const command = asNonEmptyString(args.command);
    return command;
  }

  if (toolName === "send_pty_input") {
    const input = asNonEmptyString(args.input);
    const control = asNonEmptyString(args.control);
    if (isPtyControlInput(input || "", control || undefined)) return null;
    if (!input) return null;
    if (usesAppendNewline(args) || /[\r\n]/.test(input)) {
      return input.trim();
    }
  }

  return null;
}

export function suggestedShellPermissionRules(
  decision: ShellPermissionDecision | null | undefined,
): string[] {
  if (!decision) return [];
  const seen = new Set<string>();
  const rules: string[] = [];
  const addRule = (rule: unknown) => {
    const cleanRule = typeof rule === "string" ? rule.trim() : "";
    if (!cleanRule || seen.has(cleanRule)) return;
    seen.add(cleanRule);
    rules.push(cleanRule);
  };

  for (const rule of decision.suggestedRules || []) {
    addRule(rule);
  }
  for (const segment of decision.segmentDecisions || []) {
    if (segment.decision !== "ask") continue;
    addRule(segment.suggestedRule || segment.matchedRule);
  }
  addRule(decision.suggestedRule);

  return rules;
}

export function buildShellPermissionApproval(
  decision: ShellPermissionDecision,
  scope: "once" | "session",
): ShellPermissionApproval {
  return {
    command: decision.command,
    approvedAtMs: Date.now(),
    scope,
    rules: suggestedShellPermissionRules(decision),
    riskLevel: decision.riskLevel || null,
  };
}

/**
 * Auto Review is the user's session-level approval for non-destructive tool
 * calls. A safe shell `ask` still needs an exact approval packet for the Rust
 * permission guard, while deny decisions, preflight errors, and independently
 * dangerous command shapes remain gated.
 */
export function canApplyShellAutoReview(
  resolution: ShellAutoApprovalResolution,
): boolean {
  if (!resolution.command) return true;
  if (resolution.error || resolution.requiresUserReview === true) return false;
  if (resolution.decision?.decision === "allow") return true;
  return resolution.decision?.decision === "ask" && !!resolution.approval;
}

export async function resolveShellAutoApproval(input: {
  toolName: string;
  args: Record<string, unknown>;
  workspace: string;
  preflight: ShellPermissionPreflight;
}): Promise<ShellAutoApprovalResolution> {
  const command = getShellPermissionCommandForTool(input.toolName, input.args);
  if (!command) return { command: null };

  try {
    const decision = await input.preflight(command, input.workspace);
    const requiresExplicitReview = looksDangerousShellCommand(command) ||
      shellDecisionIsCritical(decision);
    const approval = decision.decision === "ask" && !requiresExplicitReview
      ? buildShellPermissionApproval(decision, "session")
      : undefined;
    return {
      command,
      decision,
      ...(approval ? { approval } : {}),
      requiresUserReview:
        requiresExplicitReview || (decision.decision === "ask" && !approval),
    };
  } catch (error) {
    return {
      command,
      requiresUserReview: true,
      error: error instanceof Error ? error.message : String(error || "Unknown shell permission preflight error"),
    };
  }
}
