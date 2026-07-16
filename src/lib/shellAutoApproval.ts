import type { ShellPermissionApproval, ShellPermissionDecision } from "./ipc";
import { isPtyControlInput } from "./ptyCommandRuntime";
import { applyShellCwd, looksDangerousShellCommand } from "./toolExecutionContract";

type ShellPermissionPreflight = (
  command: string,
  workspace?: string,
) => Promise<ShellPermissionDecision>;

export interface ShellAutoApprovalResolution {
  command: string | null;
  decision?: ShellPermissionDecision;
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

export function getShellPermissionCommandForTool(
  toolName: string,
  args: Record<string, unknown>,
): string | null {
  if (toolName === "run_command" || toolName === "execute_command") {
    const command = asNonEmptyString(args.command);
    if (!command) return null;
    try {
      return applyShellCwd(command, args);
    } catch {
      return command;
    }
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
 * Auto Review may skip MAIN's generic tool card only after the shell policy
 * has explicitly allowed the concrete command.  An `ask` decision is a
 * permission boundary, not an invitation for the client to mint an approval.
 * Commands independently classified as destructive stay gated as
 * defense in depth if a stale or custom backend policy returns `allow`.
 */
export function canApplyShellAutoReview(
  resolution: ShellAutoApprovalResolution,
): boolean {
  if (!resolution.command) return true;
  return !resolution.error &&
    resolution.decision?.decision === "allow" &&
    resolution.requiresUserReview !== true;
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
    return {
      command,
      decision,
      requiresUserReview:
        decision.decision === "ask" || looksDangerousShellCommand(command),
    };
  } catch (error) {
    return {
      command,
      requiresUserReview: true,
      error: error instanceof Error ? error.message : String(error || "Unknown shell permission preflight error"),
    };
  }
}
